#!/usr/bin/env bash
# Build RaSQL from source and install it for the current user on Linux, no root needed.
# Installs the AppImage under ~/.local/bin and a desktop entry that registers the rasql://,
# mysql://, mariadb:// and sqlite:// URL schemes and the database file types.
# Usage: pnpm install:linux     (or: scripts/install-linux.sh [--no-launch] [--deb])
#   --deb   install the .deb with sudo dpkg instead of the per-user AppImage
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/packages/app"
LAUNCH=1
USE_DEB=0
for arg in "$@"; do
  case "$arg" in
    --no-launch) LAUNCH=0 ;;
    --deb) USE_DEB=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null 2>&1 || true
fi

echo "==> Building the LocalWP add-on"
pnpm --filter @rasql/localwp-addon build >/dev/null

echo "==> Building the app"
(cd "$APP_DIR" && npx electron-vite build >/dev/null)

echo "==> Packaging"
(cd "$APP_DIR" && rm -rf release && pnpm exec electron-builder --linux --publish never 2>&1 | grep -E "building  |error" || true)

VERSION=$(node -p "require('$APP_DIR/package.json').version")
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH_TAG=x86_64 ;;
  aarch64) ARCH_TAG=arm64 ;;
  *) ARCH_TAG=$ARCH ;;
esac

pkill -x rasql >/dev/null 2>&1 || pkill -f 'RaSQL.AppImage' >/dev/null 2>&1 || true

if [[ $USE_DEB -eq 1 ]]; then
  DEB=$(ls "$APP_DIR"/release/*.deb | head -1)
  [[ -f "$DEB" ]] || { echo "No .deb produced" >&2; exit 1; }
  echo "==> Installing $DEB (sudo)"
  sudo dpkg -i "$DEB"
  EXEC=/usr/bin/rasql
else
  APPIMAGE=$(ls "$APP_DIR"/release/*"$ARCH_TAG"*.AppImage 2>/dev/null | head -1)
  [[ -f "$APPIMAGE" ]] || APPIMAGE=$(ls "$APP_DIR"/release/*.AppImage | head -1)
  [[ -f "$APPIMAGE" ]] || { echo "No AppImage produced" >&2; exit 1; }
  BIN_DIR="$HOME/.local/bin"
  APPS_DIR="$HOME/.local/share/applications"
  ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
  mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"
  EXEC="$BIN_DIR/RaSQL.AppImage"
  echo "==> Installing to $EXEC"
  cp "$APPIMAGE" "$EXEC"
  chmod +x "$EXEC"
  cp "$APP_DIR/build/icon.png" "$ICON_DIR/rasql.png"
  cat > "$APPS_DIR/rasql.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=RaSQL
Comment=A fast, keyboard-first database manager for web developers
Exec=$EXEC %u
Icon=rasql
Terminal=false
Categories=Development;Database;
MimeType=x-scheme-handler/rasql;x-scheme-handler/mysql;x-scheme-handler/mariadb;x-scheme-handler/sqlite;application/vnd.sqlite3;application/x-sqlite3;
StartupWMClass=RaSQL
DESKTOP
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR" || true
  if command -v xdg-mime >/dev/null; then
    for scheme in rasql mysql mariadb sqlite; do
      xdg-mime default rasql.desktop "x-scheme-handler/$scheme" || true
    done
  fi
fi

echo "==> Installed RaSQL $VERSION"
if [[ $LAUNCH -eq 1 ]]; then
  nohup "$EXEC" >/dev/null 2>&1 &
fi
