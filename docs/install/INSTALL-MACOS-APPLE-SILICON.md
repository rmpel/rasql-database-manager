# Installing RaSQL: macOS on Apple Silicon

For Macs with an M1, M2, M3 or M4 chip. The download is `RaSQL-<version>-mac-arm64.dmg`.

## Option 1: Homebrew (recommended)

```
brew install --cask rmpel/rasql/rasql
```

Updates come with `brew upgrade`. The cask lives in RaSQL's own tap (`docs/DECISIONS.md` D-38).
Homebrew picks the Apple Silicon build by itself.

## Option 2: the disk image

1. Download `RaSQL-<version>-mac-arm64.dmg` from the
   [latest release](https://github.com/rmpel/rasql-database-manager/releases/latest).
2. Open it and drag RaSQL into Applications.
3. Eject the disk image.

The `mac-arm64.zip` holds the same app, if you prefer to unzip it into Applications yourself.

## First launch: the unsigned-app warning

RaSQL is not notarized by Apple (`docs/DECISIONS.md` D-12), so macOS blocks the first launch with
"Apple cannot check it for malicious software". Open **System Settings, Privacy & Security**,
scroll to Security and click **Open Anyway** next to the message about RaSQL. This happens once per
version, for Homebrew installs too.

## Uninstall

`brew uninstall --cask rasql`, or drag RaSQL from Applications to the Bin. Your connections and
settings stay in `~/Library/Application Support/RaSQL`. Saved passwords are Keychain items named
`RaSQL`.

## Troubleshooting

- **"RaSQL is damaged and can't be opened"**: you have a nightly from before 2026-10-10, when the
  bundle was not yet signed as a whole (`docs/DECISIONS.md` D-38). Download the current release.
- **The app is slow and Activity Monitor shows "Intel" as its kind**: you installed the Intel build
  (`mac-x64`). It runs under Rosetta; replace it with `mac-arm64`.
