# Installing RaSQL: macOS on Intel

For Macs with an Intel processor. The download is `RaSQL-<version>-mac-x64.dmg`.

## Option 1: Homebrew (recommended)

```
brew install --cask rmpel/rasql/rasql
```

Updates come with `brew upgrade`. The cask lives in RaSQL's own tap (`docs/DECISIONS.md` D-38).
Homebrew picks the Intel build by itself.

## Option 2: the disk image

1. Download `RaSQL-<version>-mac-x64.dmg` from the
   [latest release](https://github.com/rmpel/rasql-database-manager/releases/latest).
2. Open it and drag RaSQL into Applications.
3. Eject the disk image.

The `mac-x64.zip` holds the same app, if you prefer to unzip it into Applications yourself.

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
- **"You can't open the application because this application is not supported on this Mac"**: you
  downloaded the Apple Silicon build (`mac-arm64`). Use `mac-x64`.
