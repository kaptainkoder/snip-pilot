#!/usr/bin/env bash
set -euo pipefail

SOURCE_APP_PATH="${1:-release/mac-arm64/Snip Pilot.app}"
VERSION="$(node -p "require('./package.json').version")"
SIGNED_ROOT="/private/tmp/snip-pilot-${VERSION}-signed"
APP_PATH="$SIGNED_ROOT/Snip Pilot.app"
SIGNED_COPY_PATH="release/signed-mac-arm64/Snip Pilot.app"
BUNDLE_ID="local.snippilot.app"

if [[ ! -d "$SOURCE_APP_PATH" ]]; then
  echo "App bundle not found: $SOURCE_APP_PATH" >&2
  exit 1
fi

rm -rf "$SIGNED_ROOT"
mkdir -p "$SIGNED_ROOT" release/signed-mac-arm64
ditto --norsrc --noextattr "$SOURCE_APP_PATH" "$APP_PATH"

xattr -rcs "$APP_PATH" || true
codesign --force --deep --sign - --identifier "$BUNDLE_ID" --timestamp=none "$APP_PATH"
codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep "Identifier=$BUNDLE_ID" >/dev/null
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

rm -rf "$SIGNED_COPY_PATH"
xattr -rcs "$APP_PATH" || true
ditto --norsrc --noextattr "$APP_PATH" "$SIGNED_COPY_PATH"
xattr -rcs "$SIGNED_COPY_PATH" || true
# The strict check above runs on the app used for DMG creation. A project
# folder in Documents can reattach FinderInfo/file-provider xattrs after copy.
codesign --verify --deep --verbose=2 "$SIGNED_COPY_PATH"
echo "Signed app: $APP_PATH"
