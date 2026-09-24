import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ─── StepFun（阶跃星辰开放平台）额度指示 ──────────────────────────────────────
// 配置文件: ~/.config/gnome-stepfun-quota/stepfun.json
//   { "oasisToken": "<access JWT>", "refreshToken": "<refresh JWT>", "webid": "<设备指纹>" }
// 用同目录 stepfun-helper.py 的 export 子命令从已登录的 Chrome 生成：
//   python3 stepfun-helper.py export
//
// 鉴权: Cookie Oasis-Token(access) + oasis-webid 头; access token ~30 分钟过期,
// 每次拉取前先 RefreshToken(body 带 refreshToken, cookie 带旧 access) 换新的。
// ⚠ 与 gnome-kimi-quota 扩展的 StepFun 区块二选一安装：两者共用同一配置文件，
//   同时开会互相顶掉对方轮换后的 refreshToken。
// ⚠ oasis-webid（设备指纹）和 token 一样属于账号凭证，只从配置文件读，
//   不要硬编码进源码再分享出去。
const SF_CONFIG_PATH = GLib.get_home_dir()
    + '/.config/gnome-stepfun-quota/stepfun.json';
const SF_REFRESH_URL =
    'https://platform.stepfun.com/passport/proto.api.passport.v1.PassportService/RefreshToken';
const SF_RATE_LIMIT_URL =
    'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit';
// 刷新周期: access token 30 分钟过期, 25 分钟主动续一次
const SF_REFRESH_EVERY = 25 * 60; // seconds
const REFRESH_INTERVAL = 60;      // seconds, 失败重试兜底周期

// 读取 StepFun 配置；文件缺失 / 字段不全 → null（显示"未配置"提示）
function readStepFunConfig() {
    try {
        let file = Gio.File.new_for_path(SF_CONFIG_PATH);
        let [ok, contents] = file.load_contents(null);
        let text = new TextDecoder('utf-8').decode(contents);
        let data = JSON.parse(text);
        if (!data.oasisToken || !data.refreshToken)
            return null;
        // webid（设备指纹）也从配置取，缺失时返回 null —— 缺了它发不出合法请求
        if (!data.webid)
            return null;
        return {
            accessToken: data.oasisToken,
            refreshToken: data.refreshToken,
            webid: data.webid,
        };
    } catch (e) {
        return null; // 文件不存在是正常情况（还没 export），不打扰日志
    }
}

// 把刷新后的新 token 写回配置文件（refreshToken 会轮换，必须持久化）
// webid 三处来源优先：调用方内存配置 > 旧文件。丢了它 readStepFunConfig 会判"未配置"
function writeStepFunConfig(accessToken, refreshToken, webid) {
    try {
        let file = Gio.File.new_for_path(SF_CONFIG_PATH);
        if (!webid) {
            try {
                let [, contents] = file.load_contents(null);
                webid = JSON.parse(new TextDecoder('utf-8').decode(contents)).webid ?? null;
            } catch (e) { /* 文件不存在/损坏时写回后由 readStepFunConfig 提示 */ }
        }
        let json = JSON.stringify({ oasisToken: accessToken, refreshToken, webid }, null, 2);
        file.replace_contents(
            json, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        // token 文件必须 600（replace_contents 按 umask 默认 644/664）
        file.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o600,
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        log('[sf-quota] StepFun: failed to persist tokens: ' + e);
    }
}

// 解 JWT payload 取 mode 字段（access token mode=2 才是登录态；mode=1 会被 API 拒）
function sfTokenMode(tok) {
    try {
        let p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        p += '='.repeat((4 - p.length % 4) % 4);
        return JSON.parse(
            new TextDecoder('utf-8').decode(GLib.base64_decode(p))).mode ?? null;
    } catch (e) {
        return null;
    }
}

// ─── Panel button with popup menu ────────────────────────────────────────────

const QuotaIndicator = GObject.registerClass(
class QuotaIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'StepFun Quota');

        this._sfConfig = readStepFunConfig(); // null → 未配置

        this._box = new St.BoxLayout({ style_class: 'quota-box' });
        this._sfLabel = new St.Label({
            text: 'S ...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'sf-quota-label',
        });
        this._box.add_child(this._sfLabel);
        this.add_child(this._box);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('StepFun 阶跃星辰'));
        this._sfCreditItem = new PopupMenu.PopupMenuItem('Credit 剩余: --');
        this._sfResetItem = new PopupMenu.PopupMenuItem('重置时间: --');
        this._sfTodayItem = new PopupMenu.PopupMenuItem('额度池: --');
        this.menu.addMenuItem(this._sfCreditItem);
        this.menu.addMenuItem(this._sfResetItem);
        this.menu.addMenuItem(this._sfTodayItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let refreshItem = new PopupMenu.PopupMenuItem('↻ Refresh now');
        refreshItem.connect('activate', () => this._fetchStepFunQuota());
        this.menu.addMenuItem(refreshItem);

        if (!this._sfConfig) {
            this._sfLabel.set_text('S 未配置');
            this._sfCreditItem.label.set_text(
                '🔴 未找到有效配置 ~/.config/gnome-stepfun-quota/stepfun.json');
            this._sfResetItem.label.set_text(
                '浏览器登录 platform.stepfun.com 后运行:');
            this._sfTodayItem.label.set_text(
                'python3 stepfun-helper.py export');
            return; // 无配置 → 不起定时器，点了 Refresh 也是空转
        }

        // Set up Soup HTTP session（直连，不走代理）
        this._session = new Soup.Session();

        // Retry counter: 连续失败时按 2s → 5s → 15s → 30s 递增，之后回退 60s
        this._retryDelays = [2, 5, 15, 30]; // seconds, then fall back to REFRESH_INTERVAL
        this._sfRetryIdx = 0;

        this._fetchStepFunQuota();
    }

    // ── StepFun: 先 RefreshToken 换 access token, 再查额度 ──────────────────
    // access token ~30 分钟过期; refreshToken 会轮换, 每次都要写回配置文件。
    // 两个请求串行 (refresh → quota), 共用一次 Soup async 链。
    _fetchStepFunQuota() {
        if (this._fetchingSf || !this._sfConfig)
            return;
        this._fetchingSf = true;

        this._sfRefresh((newAccess, newRefresh) => {
            if (!newAccess) {
                // 刷新失败 — 多半是 access+refresh 都过期了, 提示重新 export
                this._fetchingSf = false;
                log('[sf-quota] StepFun: token refresh failed');
                this._sfLabel.set_text('S !!');
                this._sfLabel.style = '';
                this._sfCreditItem.label.set_text('🔴 token 过期，重新运行 stepfun-helper.py export');
                this._sfResetItem.label.set_text('');
                this._sfTodayItem.label.set_text('');
                this._scheduleSfRetry();
                return;
            }
            this._sfConfig.accessToken = newAccess;
            this._sfConfig.refreshToken = newRefresh;
            writeStepFunConfig(newAccess, newRefresh, this._sfConfig.webid);

            this._sfQuota(newAccess, (rateData) => {
                this._fetchingSf = false;
                if (!rateData) {
                    this._sfLabel.set_text('S err');
                    this._sfLabel.style = '';
                    this._scheduleSfRetry();
                    return;
                }
                this._updateSfDisplay(rateData);
                this._sfRetryIdx = 0;
                this._scheduleSf(SF_REFRESH_EVERY);
            });
        });
    }

    // POST RefreshToken; 回调 (newAccessToken, newRefreshToken) — 失败给 (null, null)
    _sfRefresh(callback) {
        let body = JSON.stringify({
            refreshToken: { raw: this._sfConfig.refreshToken },
        });
        let uri = GLib.Uri.parse(SF_REFRESH_URL, GLib.UriFlags.NONE);
        let msg = new Soup.Message({ method: 'POST', uri: uri });
        // Soup 3: POST body 必须显式设置 (set_request_body_from_bytes)
        let bytes = new GLib.Bytes(body);
        msg.set_request_body_from_bytes(
            'application/json', bytes);
        msg.get_request_headers().append('Content-Type', 'application/json');
        msg.get_request_headers().append('oasis-appid', '10300');
        msg.get_request_headers().append('oasis-webid', this._sfConfig.webid);
        msg.get_request_headers().append('oasis-platform', 'web');
        msg.get_request_headers().append('connect-protocol-version', '1');
        msg.get_request_headers().append('Referer',
            'https://platform.stepfun.com/account-overview');
        msg.get_request_headers().append('Cookie',
            `Oasis-Token=${this._sfConfig.accessToken}; Oasis-Webid=${this._sfConfig.webid}`);

        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    let bytes = session.send_and_read_finish(result);
                    if (msg.get_status() !== Soup.Status.OK) {
                        log(`[sf-quota] StepFun refresh HTTP ${msg.get_status()}`);
                        callback(null, null);
                        return;
                    }
                    let text = new TextDecoder('utf-8').decode(
                        bytes.get_data() ?? new Uint8Array());
                    let data = JSON.parse(text);
                    // 新 access token 在 Set-Cookie 里 (mode=2)。
                    // ⚠ body.accessToken.raw 是 mode=1 短命 token，API 必 401，不能用！
                    // 注意: libsoup3 get_list(name) 返回的是**逗号拼接的字符串**，
                    // 不是数组——for..of 会逐字符遍历导致正则永不命中。
                    // JWT 不含逗号，直接在拼接串上正则匹配是安全的。
                    let newAccess = null;
                    let hdrs = msg.get_response_headers();
                    let raw = hdrs.get_list('Set-Cookie') || '';
                    let m = /Oasis-Token=([^;]+)/.exec(raw);
                    if (m) newAccess = m[1];
                    let newRefresh = data?.refreshToken?.raw || this._sfConfig.refreshToken;
                    // 服务端对过期/无效的 access token 也回 200，但给 mode=1 token；
                    // 必须验 mode==2，否则坏 token 写回配置会污染整个滚动刷新链。
                    if (newAccess && sfTokenMode(newAccess) !== 2) {
                        log('[sf-quota] StepFun: refreshed token is mode=' +
                            sfTokenMode(newAccess) + ' (access token 已失效，需重新 export)');
                        callback(null, null);
                        return;
                    }
                    if (!newAccess) {
                        log('[sf-quota] StepFun: no access token in refresh response');
                        callback(null, null);
                        return;
                    }
                    callback(newAccess, newRefresh);
                } catch (e) {
                    log('[sf-quota] StepFun refresh error: ' + e);
                    callback(null, null);
                }
            });
    }

    // POST QueryStepPlanRateLimit; 回调 (data|null)
    _sfQuota(accessToken, callback) {
        let uri = GLib.Uri.parse(SF_RATE_LIMIT_URL, GLib.UriFlags.NONE);
        let msg = new Soup.Message({ method: 'POST', uri: uri });
        msg.get_request_headers().append('Content-Type', 'application/json');
        msg.get_request_headers().append('oasis-appid', '10300');
        msg.get_request_headers().append('oasis-webid', this._sfConfig.webid);
        msg.get_request_headers().append('oasis-platform', 'web');
        msg.get_request_headers().append('connect-protocol-version', '1');
        msg.get_request_headers().append('Referer',
            'https://platform.stepfun.com/account-overview');
        msg.get_request_headers().append('Cookie',
            `Oasis-Token=${accessToken}; Oasis-Webid=${this._sfConfig.webid}`);

        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    let bytes = session.send_and_read_finish(result);
                    if (msg.get_status() !== Soup.Status.OK) {
                        log(`[sf-quota] StepFun quota HTTP ${msg.get_status()}`);
                        callback(null);
                        return;
                    }
                    let text = new TextDecoder('utf-8').decode(
                        bytes.get_data() ?? new Uint8Array());
                    callback(JSON.parse(text));
                } catch (e) {
                    log('[sf-quota] StepFun quota error: ' + e);
                    callback(null);
                }
            });
    }

    // ── StepFun display: `S 99%`, 菜单显示剩余% / 重置时间 / 额度池 ─────────
    _updateSfDisplay(rateData) {
        let rl = rateData?.plan_credit_rate_limit;
        if (!rl) {
            this._sfLabel.set_text('S --');
            this._sfLabel.style = '';
            return;
        }
        // subscription_credit_left_rate 是 0~1 的小数 (页面显示"剩余 100%")
        let leftRate = Number(rl.subscription_credit_left_rate ?? 0);
        let leftPct = Math.max(0, Math.min(100, Math.round(leftRate * 100)));

        // 颜色: 剩余 <20% 黄, <10% 红
        let color = '';
        if (leftPct < 10) color = '#e74c3c';
        else if (leftPct < 20) color = '#f5c211';
        this._sfLabel.style = color ? `color: ${color};` : '';
        this._sfLabel.set_text(`S ${leftPct}%`);

        // 菜单: 重置时间 (subscription_credit_reset_time, unix 秒)
        let resetStr = '--';
        let resetSec = Number(rl.subscription_credit_reset_time ?? 0);
        let remain = resetSec > 0 ? resetSec - Math.floor(Date.now() / 1000) : 0;
        if (remain > 0)
            resetStr = this._fmtRemain(remain, 'dh');
        let icon = color === '#e74c3c' ? '🔴' : (color === '#f5c211' ? '🟡' : '🟢');
        this._sfCreditItem.label.set_text(`${icon} Credit 剩余: ${leftPct}%`);
        this._sfResetItem.label.set_text(`重置时间: ${resetStr}`);
        // credit_buckets 原始数值 (credit 单位)
        let buckets = rl.credit_buckets ?? [];
        let bucketStr = buckets.length
            ? buckets.map(b => {
                let total = Number(b.credit_total ?? 0);
                let residual = Number(b.credit_residual ?? 0);
                return `${this._fmtCredit(residual)} / ${this._fmtCredit(total)}`;
            }).join(', ')
            : '--';
        this._sfTodayItem.label.set_text(`额度池: ${bucketStr}`);
    }

    // credit 数格式化: 1587369462 → 1.59B
    _fmtCredit(n) {
        if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
        return String(n);
    }

    _scheduleSf(seconds) {
        if (this._sfTimeoutId)
            GLib.Source.remove(this._sfTimeoutId);
        this._sfTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, seconds,
            () => { this._fetchStepFunQuota(); this._sfTimeoutId = 0; return GLib.SOURCE_REMOVE; });
    }

    _scheduleSfRetry() {
        let delay = this._sfRetryIdx < this._retryDelays.length
            ? this._retryDelays[this._sfRetryIdx] : REFRESH_INTERVAL;
        this._sfRetryIdx++;
        log(`[sf-quota] StepFun retry in ${delay}s (attempt ${this._sfRetryIdx})`);
        this._scheduleSf(delay);
    }

    // mode: 'hm' → Xh Ym;  'dh' → Xd Yh (<24h fallback to hm)
    _fmtRemain(sec, mode) {
        if (sec <= 0) return '0m';

        let h = Math.floor(sec / 3600);
        let m = Math.floor((sec % 3600) / 60);

        if (mode === 'hm') {
            return `${h}h ${m}m`;
        }
        // 'dh' mode: days+hours, fallback to hm if <24h
        if (h >= 24) {
            let d = Math.floor(h / 24);
            h = h % 24;
            return `${d}d ${h}h`;
        }
        return `${h}h ${m}m`;
    }

    destroy() {
        if (this._sfTimeoutId) {
            GLib.Source.remove(this._sfTimeoutId);
            this._sfTimeoutId = 0;
        }
        super.destroy();
    }
});

// ─── Extension entry point ───────────────────────────────────────────────────

export default class StepFunQuotaExtension extends Extension {
    enable() {
        this._indicator = new QuotaIndicator();
        Main.panel.addToStatusArea('stepfun-quota', this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        log('[sf-quota] disabled');
    }
}
