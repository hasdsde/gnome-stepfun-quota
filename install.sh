#!/bin/bash
# Install StepFun Quota GNOME extension
# Usage: ./install.sh

UUID="stepfun-quota@example.org"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing StepFun Quota to $EXT_DIR"

mkdir -p "$EXT_DIR"
cp "$SRC_DIR"/metadata.json "$EXT_DIR/"
cp "$SRC_DIR"/extension.js "$EXT_DIR/"
cp "$SRC_DIR"/stylesheet.css "$EXT_DIR/"

echo "==> Done. Restart GNOME Shell to enable."
echo "    (Alt+F2 → r → Enter, or logout/login)"
echo ""
echo "==> Enable with:"
echo "    gnome-extensions enable $UUID"
echo "    or: gnome-extensions-app"
