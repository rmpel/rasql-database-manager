# Build RaSQL from source and install it for the current user on Windows, without an installer.
# The zip package is extracted into %LOCALAPPDATA%\Programs\RaSQL; the script registers the
# rasql://, mysql://, mariadb:// and sqlite:// URL schemes, the database file types, a Start Menu
# shortcut and an uninstall entry, all in the current user's registry hive. No administrator
# rights are needed. (The NSIS installer is not used because on ARM64 its extractor loses the
# .exe and .dll files; see docs/DECISIONS.md D-30.)
# Usage: pnpm install:windows     (or: powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 [-NoLaunch])
param(
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$AppDir = Join-Path $Root 'packages\app'
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\RaSQL'
$Exe = Join-Path $Dest 'RaSQL.exe'

Write-Host '==> Building the LocalWP add-on'
pnpm --filter @rasql/localwp-addon build | Out-Null

Write-Host '==> Building the app'
Push-Location $AppDir
try {
  npx electron-vite build | Out-Null
  $Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $ArchFlag = if ($Arch -eq 'ARM64') { '--arm64' } else { '--x64' }
  Write-Host "==> Packaging a zip for $ArchFlag (unsigned; see docs/DECISIONS.md D-12)"
  if (Test-Path release) { Remove-Item release -Recurse -Force }
  pnpm exec electron-builder --win zip $ArchFlag --publish never 2>&1 | Select-String -Pattern 'building  |error'
} finally {
  Pop-Location
}

$Zip = Get-ChildItem (Join-Path $AppDir 'release') -Filter 'RaSQL-*.zip' -File | Select-Object -First 1
if (-not $Zip) { throw 'No zip produced in packages\app\release' }

# --- stop a running copy and remove any previous installation (NSIS-based or this script's) ---
$Running = Get-Process -Name 'RaSQL' -ErrorAction SilentlyContinue
if ($Running) {
  Write-Host '==> Quitting the running RaSQL'
  $Running | Stop-Process -Force
  Start-Sleep -Seconds 1
}
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$Previous = Get-ItemProperty "$UninstallKey\*" -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'RaSQL*' -and $_.UninstallString -like '*Uninstall RaSQL.exe*' } | Select-Object -First 1
if ($Previous) {
  Write-Host "==> Removing the previous installer-based installation ($($Previous.DisplayName))"
  $parts = [regex]::Match($Previous.UninstallString, '^"?([^"]+?\.exe)"?\s*(.*)$')
  $uninst = $parts.Groups[1].Value
  if (Test-Path $uninst) {
    $uargs = @('/S') + ($parts.Groups[2].Value -split ' ' | Where-Object { $_ })
    Start-Process -FilePath $uninst -ArgumentList $uargs -Wait | Out-Null
  }
  foreach ($attempt in 1..30) { if (-not (Test-Path $Dest)) { break }; Start-Sleep -Seconds 1 }
}
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }

# --- install: extract the zip ---
Write-Host "==> Installing to $Dest"
New-Item -ItemType Directory -Force $Dest | Out-Null
Expand-Archive -Path $Zip.FullName -DestinationPath $Dest -Force
if (-not (Test-Path $Exe)) { throw "Extraction finished but $Exe is missing" }
$Version = (Get-Item $Exe).VersionInfo.ProductVersion

# --- register URL schemes, file types, shortcut and uninstall entry (current user only) ---
$Classes = 'HKCU:\Software\Classes'
$OpenCommand = "`"$Exe`" `"%1`""

function Set-Key($Path, $Default, $Values = @{}) {
  New-Item -Path $Path -Force | Out-Null
  if ($null -ne $Default) { Set-ItemProperty -Path $Path -Name '(default)' -Value $Default }
  foreach ($k in $Values.Keys) { Set-ItemProperty -Path $Path -Name $k -Value $Values[$k] }
}

foreach ($scheme in 'rasql', 'mysql', 'mariadb', 'sqlite') {
  Set-Key "$Classes\$scheme" "URL:$scheme connection (RaSQL)" @{ 'URL Protocol' = '' }
  Set-Key "$Classes\$scheme\DefaultIcon" "$Exe,0"
  Set-Key "$Classes\$scheme\shell\open\command" $OpenCommand
}

$ProgIds = @{
  'RaSQL.Database'   = @{ Name = 'SQLite database';       Extensions = @('.sqlite', '.sqlite3', '.db', '.db3', '.s3db', '.sl3') }
  'RaSQL.Connection' = @{ Name = 'RaSQL connection';      Extensions = @('.rasql') }
  'RaSQL.SequelPro'  = @{ Name = 'Sequel Pro favorite';   Extensions = @('.spf') }
}
foreach ($progId in $ProgIds.Keys) {
  Set-Key "$Classes\$progId" $ProgIds[$progId].Name
  Set-Key "$Classes\$progId\DefaultIcon" "$Exe,0"
  Set-Key "$Classes\$progId\shell\open\command" $OpenCommand
  foreach ($ext in $ProgIds[$progId].Extensions) {
    Set-Key "$Classes\$ext" $progId
    Set-Key "$Classes\$ext\OpenWithProgids" $null @{ $progId = '' }
  }
}

$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\RaSQL.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($StartMenu)
$lnk.TargetPath = $Exe
$lnk.WorkingDirectory = $Dest
$lnk.IconLocation = "$Exe,0"
$lnk.Description = 'RaSQL database manager'
$lnk.Save()

# An uninstaller the Settings app can run.
$UninstallScript = Join-Path $Dest 'uninstall.ps1'
@"
# Removes RaSQL for the current user: files, registry entries and the Start Menu shortcut.
Get-Process -Name 'RaSQL' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
foreach (`$scheme in 'rasql', 'mysql', 'mariadb', 'sqlite') { Remove-Item "HKCU:\Software\Classes\`$scheme" -Recurse -Force -ErrorAction SilentlyContinue }
foreach (`$id in 'RaSQL.Database', 'RaSQL.Connection', 'RaSQL.SequelPro') { Remove-Item "HKCU:\Software\Classes\`$id" -Recurse -Force -ErrorAction SilentlyContinue }
foreach (`$ext in '.sqlite', '.sqlite3', '.db', '.db3', '.s3db', '.sl3', '.rasql', '.spf') {
  `$key = "HKCU:\Software\Classes\`$ext"
  if ((Get-ItemProperty `$key -ErrorAction SilentlyContinue).'(default)' -like 'RaSQL.*') { Remove-Item `$key -Recurse -Force -ErrorAction SilentlyContinue }
}
Remove-Item '$StartMenu' -Force -ErrorAction SilentlyContinue
Remove-Item '$UninstallKey\RaSQL' -Recurse -Force -ErrorAction SilentlyContinue
Start-Process powershell -ArgumentList '-NoProfile', '-Command', "Start-Sleep -Seconds 2; Remove-Item '$Dest' -Recurse -Force" -WindowStyle Hidden
"@ | Set-Content -Path $UninstallScript -Encoding UTF8

Set-Key "$UninstallKey\RaSQL" $null @{
  DisplayName     = 'RaSQL'
  DisplayVersion  = $Version
  DisplayIcon     = $Exe
  Publisher       = 'Remon Pel'
  InstallLocation = $Dest
  UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UninstallScript`""
  NoModify        = 1
  NoRepair        = 1
  EstimatedSize   = [int]((Get-ChildItem $Dest -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)
}

Write-Host "==> Installed RaSQL $Version at $Exe"
if (-not $NoLaunch) { Start-Process -FilePath $Exe }
