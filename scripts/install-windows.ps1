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

# Remove a previous installation first and wait for it. Letting the installer do it silently can
# race its own file copy against the old uninstaller and leave an empty install folder.
$Previous = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'RaSQL*' -and $_.UninstallString } | Select-Object -First 1
if ($Previous) {
  Write-Host "==> Removing the previous installation ($($Previous.DisplayName))"
  $parts = [regex]::Match($Previous.UninstallString, '^"?([^"]+?\.exe)"?\s*(.*)$')
  $uninst = $parts.Groups[1].Value
  $args = @('/S') + ($parts.Groups[2].Value -split ' ' | Where-Object { $_ })
  if (Test-Path $uninst) {
    $u = Start-Process -FilePath $uninst -ArgumentList $args -Wait -PassThru
    Write-Host "    uninstaller exit code: $($u.ExitCode)"
  }
  $oldDir = Split-Path $uninst -Parent
  foreach ($attempt in 1..30) { if (-not (Test-Path $oldDir)) { break }; Start-Sleep -Seconds 1 }
  if (Test-Path $oldDir) { Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue }
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
  # Older builds named the executable after the package; accept any non-uninstaller exe in the install folder.
  foreach ($dir in ($candidates | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)) {
    if ($dir -and (Test-Path $dir)) {
      $exe = Get-ChildItem $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
      if ($exe) { return $exe.FullName }
    }
  }
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
