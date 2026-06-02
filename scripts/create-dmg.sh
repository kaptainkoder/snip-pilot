#!/usr/bin/env bash
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
APP_PATH="/private/tmp/snip-pilot-${VERSION}-signed/Snip Pilot.app"
RELEASE_DMG="release/Snip Pilot-${VERSION}-arm64.dmg"
DOWNLOAD_DMG="downloads/SnipPilot-${VERSION}-arm64.dmg"

if [[ ! -d "$APP_PATH" ]]; then
  scripts/sign-mac-app.sh
fi

mkdir -p release downloads
rm -f "$RELEASE_DMG" "$DOWNLOAD_DMG" "$DOWNLOAD_DMG.sha256"

hdiutil create \
  -volname "Snip Pilot" \
  -srcfolder "$APP_PATH" \
  -ov \
  -format UDZO \
  "$RELEASE_DMG"

cp "$RELEASE_DMG" "$DOWNLOAD_DMG"
(cd downloads && env LC_ALL=C LANG=C shasum -a 256 "SnipPilot-${VERSION}-arm64.dmg" > "SnipPilot-${VERSION}-arm64.dmg.sha256")
(cd downloads && env LC_ALL=C LANG=C shasum -a 256 -c "SnipPilot-${VERSION}-arm64.dmg.sha256")
