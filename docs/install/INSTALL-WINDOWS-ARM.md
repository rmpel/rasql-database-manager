# Installing RaSQL: Windows on ARM

For Snapdragon laptops, Surface Pro X and other ARM64 Windows 11 machines. The download is
`RaSQL-<version>-win-arm64.zip`. There is no installer for ARM: the NSIS installer finishes on
ARM64 without actually copying the program files (`docs/DECISIONS.md` D-30).

## Install from the zip

1. Download `RaSQL-<version>-win-arm64.zip` from the
   [latest release](https://github.com/rmpel/rasql-database-manager/releases/latest).
2. Right-click the zip, **Properties**, tick **Unblock**, **OK**. Without this every file inside
   carries the download mark and SmartScreen asks again.
3. Extract it to `%LOCALAPPDATA%\Programs\RaSQL` (or anywhere you like).
4. Run `RaSQL.exe`. SmartScreen says "Windows protected your PC" because the build is not signed
   (`docs/DECISIONS.md` D-12): click **More info**, then **Run anyway**.

RaSQL registers the `rasql://`, `mysql://`, `mariadb://` and `sqlite://` links for your user on
its first launch. It does not create a Start Menu entry; right-click `RaSQL.exe`, **Pin to Start**.
To update, replace the folder's contents.

Want a Start Menu shortcut, file associations and an uninstall entry too? Build from source with
[BUILD-WINDOWS-ARM.md](../build/BUILD-WINDOWS-ARM.md); `pnpm install:windows` does all of that.

## Uninstall

Delete the folder. Your connections and settings stay in `%APPDATA%\RaSQL`. Saved passwords are in
Windows Credential Manager under `RaSQL`.

## Troubleshooting

- **The x64 installer or zip runs, but slowly**: Windows emulates x64 on ARM. Use the `win-arm64`
  zip.
- **SmartScreen offers no "Run anyway"**: your organisation blocks unsigned apps. Ask your IT
  department.
