#!/usr/bin/env bash
# 生成双击即用的「学习资产库.app」启动器（壳模式：指向本目录的 Electron 运行时）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$APP_ROOT"
DIST="$APP_ROOT/dist"
NAME="学习资产库"
APP="$DIST/$NAME.app"
VERSION="$(node -p "require('./package.json').version")"
ELEC="$APP_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELEC" ] || { echo "ERROR: Electron binary not found. Run npm install first."; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/LearningVault" <<EOF
#!/bin/bash
exec "$ELEC" "$APP_ROOT" "\$@"
EOF
chmod +x "$APP/Contents/MacOS/LearningVault"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.sijunting.learningvault</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>LearningVault</string>
  <key>CFBundleIconFile</key><string>appIcon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
EOF
cp "$APP_ROOT/assets/appIcon.icns" "$APP/Contents/Resources/appIcon.icns"
touch "$APP"
echo "APP_OK $APP"
