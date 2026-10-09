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
# /S = silent. The per-user install normally goes to %LOCALAPPDATA%\Programs\RaSQL and registers
# rasql:// and the file types; the registry says where it really went.
$proc = Start-Process -FilePath $Setup.FullName -ArgumentList '/S' -Wait -PassThru
Write-Host "    installer exit code: $($proc.ExitCode)"
if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)" }

function Find-InstalledRaSQL {
  $fromRegistry = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') |
    ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.DisplayName -like 'RaSQL*' -and $_.InstallLocation } |
    ForEach-Object { Join-Path $_.InstallLocation 'RaSQL.exe' }
  $candidates = @($fromRegistry) + @(
    (Join-Path $env:LOCALAPPDATA 'Programs\RaSQL\RaSQL.exe'),
    (Join-Path $env:ProgramFiles 'RaSQL\RaSQL.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'RaSQL\RaSQL.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$Exe = $null
foreach ($attempt in 1..10) {
  $Exe = Find-InstalledRaSQL
  if ($Exe) { break }
  Start-Sleep -Seconds 1
}
if (-not $Exe) {
  Write-Host 'Installed executable not found. Registry entries named RaSQL:'
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'RaSQL*' } | Format-List DisplayName, DisplayVersion, InstallLocation, UninstallString
  Write-Host "Contents of $env:LOCALAPPDATA\Programs:"
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
  throw "The installer finished but RaSQL.exe was not found; run the installer by hand once: $($Setup.FullName)"
}
$Version = (Get-Item $Exe).VersionInfo.ProductVersion
Write-Host "==> Installed RaSQL $Version at $Exe"
if (-not $NoLaunch) { Start-Process -FilePath $Exe }
