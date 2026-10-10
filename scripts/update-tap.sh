#!/usr/bin/env bash
# Write the Homebrew cask for a released version and push it to the tap (rmpel/homebrew-rasql).
#
#   scripts/update-tap.sh 0.1.0            # checksums from the GitHub release v0.1.0
#   scripts/update-tap.sh 0.1.0 dist/      # checksums from local zips (CI uses this)
#   DRY_RUN=1 scripts/update-tap.sh 0.1.0  # print the cask, push nothing
#
# The tap is cloned over SSH: TAP_REPO overrides git@github.com:rmpel/homebrew-rasql.git.
# Builds are unsigned and not notarized (docs/DECISIONS.md D-12, D-38): the cask says so instead
# of stripping the quarantine flag.
set -euo pipefail

VERSION="${1:?usage: update-tap.sh VERSION [DIR]}"
VERSION="${VERSION#v}"
SOURCE="${2:-}"
DRY_RUN="${DRY_RUN:-}"
TAP_REPO="${TAP_REPO:-git@github.com:rmpel/homebrew-rasql.git}"
RELEASE_URL="https://github.com/rmpel/rasql-database-manager/releases/download/v${VERSION}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

checksum() {
  local arch="$1"
  local file="RaSQL-${VERSION}-mac-${arch}.zip"
  if [[ -n "$SOURCE" ]]; then
    [[ -f "$SOURCE/$file" ]] || { echo "Missing $SOURCE/$file" >&2; exit 1; }
    shasum -a 256 "$SOURCE/$file" | cut -d' ' -f1
  else
    curl -fsSL -o "$work/$file" "$RELEASE_URL/$file" || {
      echo "Could not download $RELEASE_URL/$file; is v${VERSION} released?" >&2
      exit 1
    }
    shasum -a 256 "$work/$file" | cut -d' ' -f1
  fi
}

ARM_SHA="$(checksum arm64)"
INTEL_SHA="$(checksum x64)"

cask() {
  cat <<EOF
cask "rasql" do
  arch arm: "arm64", intel: "x64"

  version "${VERSION}"
  sha256 arm:   "${ARM_SHA}",
         intel: "${INTEL_SHA}"

  url "https://github.com/rmpel/rasql-database-manager/releases/download/v#{version}/RaSQL-#{version}-mac-#{arch}.zip"
  name "RaSQL"
  desc "Database manager for web developers: MySQL, MariaDB and SQLite"
  homepage "https://github.com/rmpel/rasql-database-manager"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "RaSQL.app"

  zap trash: [
    "~/Library/Application Support/RaSQL",
    "~/Library/Preferences/nl.remonpel.rasql.plist",
    "~/Library/Saved Application State/nl.remonpel.rasql.savedState",
  ]

  caveats <<~EOS
    RaSQL is free and open source, and not notarized by Apple.
    The first time you open it, macOS blocks it. To allow it:
      System Settings > Privacy & Security > "RaSQL was blocked" > Open Anyway
    This is needed once per installed version.
  EOS
end
EOF
}

if [[ -n "$DRY_RUN" ]]; then
  cask
  exit 0
fi

git clone --quiet "$TAP_REPO" "$work/tap"
mkdir -p "$work/tap/Casks"
cask > "$work/tap/Casks/rasql.rb"
if [[ ! -f "$work/tap/README.md" ]]; then
  cat > "$work/tap/README.md" <<'EOF'
# RaSQL for Homebrew

```sh
brew install --cask rmpel/rasql/rasql
```

Updates arrive with `brew upgrade`. RaSQL is not notarized by Apple, so macOS blocks the first
launch of each version: allow it in System Settings, Privacy & Security, Open Anyway.

The cask is written by the release workflow of
[rmpel/rasql-database-manager](https://github.com/rmpel/rasql-database-manager); edits here are
overwritten on the next release.
EOF
fi

cd "$work/tap"
git add -A
if git diff --cached --quiet; then
  echo "The tap already has RaSQL ${VERSION}; nothing to push."
  exit 0
fi
git commit --quiet -m "rasql ${VERSION}"
git push --quiet origin HEAD
echo "Pushed RaSQL ${VERSION} to ${TAP_REPO}"
