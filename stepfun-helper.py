#!/usr/bin/env python3
"""StepFun (阶跃星辰) 开放平台额度 —— token 抓取/刷新助手。

用法:
    python3 stepfun-helper.py export      # 从 Chrome 抓 token 写入配置（需浏览器已登录）
    python3 stepfun-helper.py refresh     # 刷新 access token 并打印额度
    python3 stepfun-helper.py usages      # 打印今日用量明细
    python3 stepfun-helper.py show        # 显示当前配置状态（不打印完整 token）

鉴权机制（2026-09-20 实测）:
    - API 请求: httpOnly Cookie `Oasis-Token`(JWT access token, mode=2, ~30 分钟有效)
    - 刷新配方: POST /passport/.../RefreshToken
        Cookie: Oasis-Token=<当前有效 access token>
        body:   {"refreshToken": {"raw": "<refreshToken>"}}
      响应: Set-Cookie: Oasis-Token=<新 access token, mode=2>
            body.refreshToken.raw = <新 refreshToken>（轮换，需持久化）
    - 纯 refreshToken 自举不可行（返回 mode=1 被拒），必须配一个有效 access token。
      所以 export 时把浏览器里的 access token 和 refreshToken 都存下来；
      之后每次刷新都用上一个 access token 辅助，access token 由响应滚动更新。
    - ⚠ RefreshToken 响应 body 里的 accessToken.raw 是 mode=1 短命 token，API 必 401；
      可用的新 access token 只在 Set-Cookie / oasis-token 响应头里（mode=2）。
      拿着过期 access token 去刷新，服务端也回 200 但全套都是 mode=1（链断），
      必须重新 export。
    - refreshToken 本身有效期约 30 天（payload.exp），过期后需重新 export（浏览器重新登录平台）。

GNOME 扩展每次都自己调一次 RefreshToken 再查额度（见 extension.js），
本脚本主要供 CLI 手动查询和初次 export。
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

# 设备指纹（oasis-webid）从配置文件读，不硬编码——源码要分享出去
WEBID = ""
CONFIG_PATH = os.path.expanduser("~/.config/gnome-stepfun-quota/stepfun.json")
BASE = "https://platform.stepfun.com"
HARNESS = os.path.expanduser("~/.local/bin/browser-harness")


# ─── HTTP ────────────────────────────────────────────────────────────────────
def post(url, cookie_tok, body, webid):
    if not webid:
        raise SystemExit(
            "FAIL: 配置缺少 webid（设备指纹）。重新运行: python3 stepfun-helper.py export"
        )
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    for k, v in [
        ("Content-Type", "application/json"),
        ("oasis-appid", "10300"),
        ("oasis-webid", webid),
        ("oasis-platform", "web"),
        ("connect-protocol-version", "1"),
        ("Referer", BASE + "/account-overview"),
        ("Origin", BASE),
    ]:
        req.add_header(k, v)
    if cookie_tok:
        req.add_header("Cookie", f"Oasis-Token={cookie_tok}; Oasis-Webid={webid}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=15) as resp:
            raws = resp.headers.get_all("Set-Cookie") or []
            return resp.status, resp.read().decode(), "".join(raws)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300], "".join(e.headers.get_all("Set-Cookie") or [])


def cookie_tok(setcookie):
    m = re.search(r"Oasis-Token=([^;]+)", setcookie)
    return m.group(1) if m else None


def jwt_payload(tok):
    part = tok.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def refresh(access_tok, refresh_tok, webid):
    """返回 (new_access, new_refresh)；失败返回 (None, None)。"""
    st, body, sc = post(
        f"{BASE}/passport/proto.api.passport.v1.PassportService/RefreshToken",
        access_tok,
        {"refreshToken": {"raw": refresh_tok}},
        webid,
    )
    if st != 200:
        return None, None
    new_at = cookie_tok(sc)
    try:
        new_rt = json.loads(body).get("refreshToken", {}).get("raw", refresh_tok)
    except Exception:
        new_rt = refresh_tok
    if not new_at:
        return None, None
    return new_at, new_rt


def api(endpoint, access_tok, body=None, webid=""):
    st, b, _ = post(
        f"{BASE}/api/step.openapi.devcenter.Dashboard/{endpoint}",
        access_tok,
        body or {},
        webid,
    )
    if st != 200:
        return {"_error": st, "_body": b}
    return json.loads(b)


def ensure_token(cfg):
    """刷新 access token，更新 cfg，返回是否成功。"""
    at, rt, webid = cfg.get("oasisToken"), cfg.get("refreshToken"), cfg.get("webid")
    if not rt:
        return None
    new_at, new_rt = refresh(at, rt, webid)
    if not new_at:
        return None
    cfg["oasisToken"], cfg["refreshToken"], cfg["savedAt"] = new_at, new_rt, time.time()
    save_config(cfg)
    return new_at


# ─── 配置 ────────────────────────────────────────────────────────────────────
def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)


# ─── 浏览器侧抓取 ────────────────────────────────────────────────────────────
def run_harness(code):
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    r = subprocess.run(
        [HARNESS], input=code, capture_output=True, text=True, timeout=180, env=env
    )
    return r.stdout


def grab_from_browser():
    """从 Chrome 抓 Oasis-Token(access) + RegisterDevice 响应里的 refreshToken。"""
    out = run_harness(
        "import json\n"
        "c = cdp('Network.getCookies', urls=['https://platform.stepfun.com'])\n"
        "out = {x['name']: x['value'] for x in c.get('cookies', [])}\n"
        "print('AT:' + out.get('Oasis-Token', ''))\n"
        "print('WEBID:' + out.get('Oasis-Webid', ''))\n"
    )
    at = webid = None
    for line in out.splitlines():
        if line.startswith("AT:") and len(line) > 3:
            at = line[3:]
        elif line.startswith("WEBID:") and len(line) > 6:
            webid = line[6:]
    if not at:
        return None, None, None
    # refreshToken：RegisterDevice 只在页面加载时发；reload 一次现抓
    out2 = run_harness(
        "import json, time\n"
        "cdp('Network.enable')\n"
        "drain_events()\n"
        "js(\"location.reload()\")\n"
        "time.sleep(10)\n"
        "evs = drain_events()\n"
        "for e in evs:\n"
        "    p = e.get('params', {})\n"
        "    if e.get('method')=='Network.responseReceived' and 'RegisterDevice' in p.get('response',{}).get('url',''):\n"
        "        try:\n"
        "            b = cdp('Network.getResponseBody', requestId=p.get('requestId'))\n"
        "            d = json.loads(b.get('body','{}'))\n"
        "            print('RT:' + d.get('refreshToken',{}).get('raw',''))\n"
        "        except Exception as ex:\n"
        "            print('RTERR:' + str(ex))\n"
        "        break\n"
        "else:\n"
        "    print('RTNONE')\n"
    )
    rt = None
    for line in out2.splitlines():
        if line.startswith("RT:") and len(line) > 3:
            rt = line[3:]
    return at, rt, webid


# ─── 子命令 ──────────────────────────────────────────────────────────────────
def cmd_export():
    print("从 Chrome 抓取 token（确保 platform.stepfun.com 已登录）…")
    at, rt, webid = grab_from_browser()
    if not at:
        print("FAIL: 没有读到 Oasis-Token（Chrome 没开 / 未登录 / 未授权调试）")
        return 1
    cfg = load_config()
    cfg["oasisToken"] = at
    if rt:
        cfg["refreshToken"] = rt
    if webid:
        cfg["webid"] = webid
    cfg["savedAt"] = time.time()
    save_config(cfg)
    print("OK →", CONFIG_PATH)
    print("  access token :", "已保存" if at else "无")
    print("  refreshToken :", "已保存" if rt else "⚠ 未抓到（reload 页面后重试 export）")
    print("  webid        :", "已保存" if webid else "⚠ 未抓到（刷新页面后重试 export）")
    if at:
        try:
            p = jwt_payload(at)
            print("  access 有效期至:", time.strftime("%Y-%m-%d %H:%M", time.localtime(p["exp"])))
        except Exception:
            pass
    return 0


def cmd_refresh():
    cfg = load_config()
    if not cfg.get("refreshToken"):
        print("FAIL: 无 refreshToken，先 export")
        return 1
    at = ensure_token(cfg)
    if not at:
        print("FAIL: 刷新失败（access token 也过期了 → 浏览器重新登录平台后再次 export）")
        return 1
    d = api("QueryStepPlanRateLimit", at, webid=cfg.get("webid"))
    print(json.dumps(d, ensure_ascii=False, indent=1))
    return 0


def cmd_usages():
    cfg = load_config()
    at = ensure_token(cfg) or cfg.get("oasisToken")
    if not at:
        print("FAIL: 无 token")
        return 1
    d = api("QueryStepPlanUsages", at, webid=cfg.get("webid"))
    print(json.dumps(d, ensure_ascii=False, indent=1))
    return 0


def cmd_show():
    cfg = load_config()
    if not cfg:
        print("(无配置)")
        return 1
    for k in ("oasisToken", "refreshToken"):
        v = cfg.get(k)
        if v:
            try:
                p = jwt_payload(v)
                left = (p["exp"] - time.time()) / 86400
                print(f"{k:13s}: {len(v)}B, 有效期至 {time.strftime('%Y-%m-%d %H:%M', time.localtime(p['exp']))} (剩 {left:.1f} 天)")
            except Exception:
                print(f"{k:13s}: {len(v)}B (解析失败)")
        else:
            print(f"{k:13s}: 无")
    webid = cfg.get("webid")
    print(f"{'webid':13s}: {'已配置 (' + str(len(webid)) + ' 字符)' if webid else '无（refresh/query 会失败，需重跑 export）'}")
    print(f"savedAt      : {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cfg.get('savedAt', 0)))}")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "refresh"
    sys.exit({
        "export": cmd_export,
        "refresh": cmd_refresh,
        "usages": cmd_usages,
        "show": cmd_show,
    }.get(cmd, cmd_refresh)())
