#!/bin/bash
# Builds the "<Product> Marketing Engine" menu bar app (deploy/menubar/
# main.swift) into deploy/build/. Names derive from product/product.json
# (override with GROWTH_APP_NAME / GROWTH_MENUBAR_SYMBOL). Re-run after
# editing main.swift or switching products. Requires Xcode CLT.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$REPO/deploy/build"

# Works on a fresh clone too: with no product yet the app builds under a
# generic name and its menu leads into the dashboard's guided Setup page.
# Re-run after onboarding to rename it for your product.
PRODUCT_JSON="${PRODUCT_DIR:-$REPO/product}/product.json"
if [ -f "$PRODUCT_JSON" ]; then
  PRODUCT_NAME="$(node -p "JSON.parse(require('fs').readFileSync('$PRODUCT_JSON','utf8')).name")"
  PRODUCT_SLUG="$(node -p "JSON.parse(require('fs').readFileSync('$PRODUCT_JSON','utf8')).slug")"
  APP_NAME="${GROWTH_APP_NAME:-$PRODUCT_NAME Marketing Engine}"
else
  PRODUCT_SLUG="growth"
  APP_NAME="${GROWTH_APP_NAME:-Growth Engine}"
fi
BUNDLE_ID="growth.$PRODUCT_SLUG.menubar"
# Menu bar glyph: first letter of the slug in a circle (SF Symbols has a.circle…z.circle).
SYMBOL="${GROWTH_MENUBAR_SYMBOL:-$(printf %.1s "$PRODUCT_SLUG").circle}"

APP="$BUILD/$APP_NAME.app"
MACOS="$APP/Contents/MacOS"
TICK="$BUILD/$APP_NAME"

mkdir -p "$MACOS" "$BUILD"
chmod +x "$REPO/deploy/open-dashboard.sh"

# The tick launcher carries the app name as its filename so macOS process
# lists stay legible. Generated (deploy/build is gitignored).
cp "$REPO/deploy/tick-launcher.sh" "$TICK"
chmod +x "$TICK"

# Inject the repo path + names, compile.
SRC="$BUILD/main.generated.swift"
sed -e "s#__REPO__#$REPO#g" \
    -e "s#__APP_NAME__#$APP_NAME#g" \
    -e "s#__TICK_SCRIPT__#$TICK#g" \
    -e "s#__SYMBOL__#$SYMBOL#g" \
    "$REPO/deploy/menubar/main.swift" > "$SRC"
swiftc -O -o "$MACOS/$APP_NAME" "$SRC"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar only: no Dock icon, no app switcher entry. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP"

echo "[build] $APP"
echo "[build] launch:          open \"$APP\""
echo "[build] start at login:  System Settings → General → Login Items → + → select the app"
