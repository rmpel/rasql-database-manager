#!/usr/bin/env bash
# Build RaSQL from source and install it into ~/Applications, replacing the previous copy.
# Usage: pnpm install:mac     (or: scripts/install-mac.sh [--no-launch])
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/packages/app"
TARGET="${RASQL_INSTALL_DIR:-$HOME/Applications}/RaSQL.app"
LAUNCH=1
[[ "${1:-}" == "--no-launch" ]] && LAUNCH=0

# Node 24 via nvm when the shell's default node is older.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi

echo "==> Building the LocalWP add-on"
pnpm --filter @rasql/localwp-addon build >/dev/null

echo "==> Building the app"
(cd "$APP_DIR" && npx electron-vite build >/dev/null)

echo "==> Packaging (unsigned, see docs/DECISIONS.md D-12)"
(cd "$APP_DIR" && rm -rf release && pnpm exec electron-builder --mac --publish never 2>&1 | grep -E "building  |error" || true)

BUILT="$APP_DIR/release/mac-arm64/RaSQL.app"
[[ -d "$BUILT" ]] || { echo "Package not found at $BUILT" >&2; exit 1; }

if pgrep -f "$TARGET/Contents/MacOS/RaSQL" >/dev/null; then
  echo "==> Quitting the running RaSQL"
  osascript -e 'tell application "RaSQL" to quit' >/dev/null 2>&1 || pkill -f "$TARGET/Contents/MacOS/RaSQL" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$TARGET/Contents/MacOS/RaSQL" >/dev/null || break; sleep 0.5; done
fi

echo "==> Installing to $TARGET"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
cp -R "$BUILT" "$TARGET"
# Clear the quarantine flag our own build never needed; Gatekeeper still applies to downloads.
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist")
echo "==> Installed RaSQL $VERSION"
if [[ $LAUNCH -eq 1 ]]; then
  open "$TARGET"
fi
