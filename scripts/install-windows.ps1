# Build RaSQL from source and install it for the current user on Windows.
# Runs the NSIS installer silently (per-user, no admin needed) and launches the app.
# Usage: pnpm install:windows     (or: powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 [-NoLaunch])
param(
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$AppDir = Join-Path $Root 'packages\app'

Write-Host '==> Building the LocalWP add-on'
pnpm --filter @rasql/localwp-addon build | Out-Null

Write-Host '==> Building the app'
Push-Location $AppDir
try {
  npx electron-vite build | Out-Null
  Write-Host '==> Packaging (unsigned; SmartScreen will warn once, see docs/DECISIONS.md D-12)'
  if (Test-Path release) { Remove-Item release -Recurse -Force }
  # Build for the machine's own architecture; electron-builder would otherwise default to x64.
  $Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $ArchFlag = if ($Arch -eq 'ARM64') { '--arm64' } else { '--x64' }
  Write-Host "    target architecture: $ArchFlag"
  pnpm exec electron-builder --win $ArchFlag --publish never 2>&1 | Select-String -Pattern 'building  |error'
} finally {
  Pop-Location
}

$Setup = Get-ChildItem (Join-Path $AppDir 'release') -Filter '*.exe' -File | Select-Object -First 1
if (-not $Setup) { throw 'No installer produced in packages\app\release' }

$Running = Get-Process -Name 'RaSQL' -ErrorAction SilentlyContinue
if ($Running) {
  Write-Host '==> Quitting the running RaSQL'
  $Running | Stop-Process -Force
  Start-Sleep -Seconds 1
}

Write-Host "==> Installing $($Setup.Name) silently"
# /S = silent; the per-user install goes to %LOCALAPPDATA%\Programs\RaSQL and registers rasql:// and the file types.
$proc = Start-Process -FilePath $Setup.FullName -ArgumentList '/S' -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)" }

$Exe = Join-Path $env:LOCALAPPDATA 'Programs\RaSQL\RaSQL.exe'
if (-not (Test-Path $Exe)) { throw "Installed executable not found at $Exe" }
$Version = (Get-Item $Exe).VersionInfo.ProductVersion
Write-Host "==> Installed RaSQL $Version"
if (-not $NoLaunch) { Start-Process -FilePath $Exe }
