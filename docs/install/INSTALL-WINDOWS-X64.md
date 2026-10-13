# Installing RaSQL: Windows on Intel or AMD (x64)

For ordinary 64-bit Windows 10 and 11 PCs. The download is `RaSQL-<version>-win-x64.exe`.

## Option 1: the installer (recommended)

1. Download `RaSQL-<version>-win-x64.exe` from the
   [latest release](https://github.com/rmpel/rasql-database-manager/releases/latest).
2. Run it. SmartScreen says "Windows protected your PC" because the build is not signed
   (`docs/DECISIONS.md` D-12): click **More info**, then **Run anyway**.
3. Pick a folder or keep the default and finish. RaSQL gets a Start Menu entry, the `rasql://`,
   `mysql://`, `mariadb://` and `sqlite://` links, and an entry in Installed apps.

## Option 2: the zip, no installer

1. Download `RaSQL-<version>-win-x64.zip`.
2. Right-click the zip, **Properties**, tick **Unblock**, **OK**. Without this every file inside
   carries the download mark and SmartScreen asks again.
3. Extract it to `%LOCALAPPDATA%\Programs\RaSQL` (or anywhere you like) and run `RaSQL.exe`.

RaSQL registers its URL schemes for your user on its first launch. It does not create a Start Menu
entry; right-click `RaSQL.exe`, **Pin to Start**. To update, replace the folder's contents.

## Uninstall

Installer: Settings, Apps, Installed apps, RaSQL, **Uninstall**. Zip: delete the folder. Your
connections and settings stay in `%APPDATA%\RaSQL`. Saved passwords are in Windows Credential
Manager under `RaSQL`.

## Troubleshooting

- **SmartScreen offers no "Run anyway"**: your organisation blocks unsigned apps. Ask your IT
  department, or build from source ([BUILD-WINDOWS-X64.md](../build/BUILD-WINDOWS-X64.md)).
- **`rasql://` links from the LocalWP add-on do nothing**: start RaSQL once; it registers the
  links on launch.
