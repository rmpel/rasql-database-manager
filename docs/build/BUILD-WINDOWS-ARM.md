# Building RaSQL: Windows on ARM

For ARM64 Windows machines such as Snapdragon X laptops and Surface Pro X. The build is a native ARM64 app; x64 Node or pnpm running under emulation is the one thing that breaks this guide, so the checks insist on `arm64`.

This guide assumes a machine with nothing on it. Each step says what to check first; skip the
steps whose check passes. Commands are meant to be pasted one block at a time.

## 1. Tools

All commands below are for **PowerShell** (the blue one, or Windows Terminal). Not the Command
Prompt. No administrator rights are needed for anything in this guide.

### Git

Check: `git --version`. If missing:

```
winget install --id Git.Git -e
```

Open a new PowerShell window afterwards. Then, once, to avoid path-length problems in deep
`node_modules` trees:

```
git config --global core.longpaths true
```

### Node.js 24 LTS

Check: `node -v` prints `v24.x` **and** `node -p process.arch` prints `arm64`.
If either is wrong, install the right build:

Download the **ARM64** installer: on https://nodejs.org choose Node 24 LTS, Windows, ARM64 (.msi). Run it with the defaults. `winget install OpenJS.NodeJS.LTS` also works and picks the ARM64 build on an ARM machine; check `node -p process.arch` afterwards, it must say `arm64`.

Open a new PowerShell window afterwards.

### pnpm through corepack

Check: `pnpm -v` prints `12.x`, and `(Get-Command pnpm).Source` is one of these two places:

- `C:\Program Files\nodejs\pnpm.cmd` when Node 24 supplied corepack itself, or
- `%APPDATA%\npm\pnpm.cmd` (`C:\Users\<you>\AppData\Roaming\npm\`) when you installed corepack with npm.

Both are corepack shims that run pnpm on your own Node, which is what counts. It must **not** be
`C:\Users\<you>\AppData\Local\pnpm\pnpm.cmd`: that is the standalone pnpm, which bundles its
own Node; see the troubleshooting section for removing it.

If pnpm is missing:

```
corepack enable pnpm
```

If `corepack` is not recognised, your Node is newer than 24 and no longer bundles it:

```
npm install -g corepack
corepack enable pnpm
```

Then open a new PowerShell window and run the check again.

**Do not** install pnpm with `irm https://get.pnpm.io/ps1 | iex` or with `npm install -g pnpm`.

### Seeing where everything comes from

When in doubt, this shows every Node, npm and pnpm on your PATH:

```
Get-Command node, npm, npx, corepack, pnpm -All -ErrorAction SilentlyContinue | Select-Object Name, Source
```

Expected: exactly one `node.exe` (under `C:\Program Files\nodejs\`), `npm` and `npx` next to it,
and `pnpm` as described above. Anything under `AppData\Local\pnpm`, `AppData\Local\nvm`,
`scoop` or `chocolatey` is a second installation and the usual cause of mismatched binaries.

### Docker Desktop (optional, engine matrix only)

`winget install Docker.DockerDesktop`, then start it once and let it finish its setup.

## 2. Get the source

```
mkdir ~\Development -ErrorAction SilentlyContinue; cd ~\Development
git clone https://github.com/rmpel/rasql-database-manager.git
cd rasql-database-manager
```

## 3. Install the project's dependencies

```
pnpm install
```

The first run downloads Electron and the native pieces for your platform and takes a couple of
minutes. It needs no compiler: if you ever see `node-gyp` or "Visual Studio" or "python" in an
error here, something picked the wrong platform; see the troubleshooting section.

Check that it worked and that native binaries match your CPU:

```
node -p "process.arch"                      # arm64
Get-ChildItem node_modules\.pnpm | Select-String rollup-win32   # must list rollup-win32-arm64-msvc
```

## 4. Verify, run, build

```
pnpm typecheck    # every package compiles
pnpm test         # unit tests; no database server needed
pnpm dev          # starts RaSQL with hot reload; close the window when done
```

Build the installer and install it:

```
pnpm install:windows
# builds a native installer for this machine's CPU, installs it per user, launches RaSQL
```

The installer also lands in `packages\app\release\` as `RaSQL-<version>-arm64.exe`.

## First launch: the SmartScreen warning

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the
first time. Click **More info**, then **Run anyway**. This happens once per build. Everything
installs per user into `%LOCALAPPDATA%\Programs\RaSQL`; no administrator rights are needed.

## 5. Optional: the MySQL and MariaDB engine matrix

The MySQL driver's tests run against seven real engines in Docker. This is optional; the unit
tests and the UI tests above cover everything else.

```
pnpm matrix:up       # starts MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.4 and Percona 8.0
pnpm test:matrix     # conformance suite against every engine that is up
pnpm matrix:down     # removes the containers and their data
```

## Troubleshooting

- **`Cannot find module @rollup/rollup-win32-arm64-msvc`** (or `…-x64-msvc`): the pnpm that ran
  `pnpm install` is not running on the same Node as the build. The usual cause is the standalone
  pnpm from `get.pnpm.io`, which bundles an x64 Node and therefore installs x64 binaries, while
  your Node is ARM64. The workspace now installs both CPU variants, so `pnpm install --force`
  fixes the symptom; the cure is to remove the standalone pnpm and use corepack's:

  ```
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\pnpm"
  $p = [Environment]::GetEnvironmentVariable('Path', 'User')
  $p = ($p -split ';' | Where-Object { $_ -and $_ -notlike "*\AppData\Local\pnpm*" }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $p, 'User')
  [Environment]::SetEnvironmentVariable('PNPM_HOME', $null, 'User')
  ```

  Open a new PowerShell window, then `corepack enable pnpm` and check `(Get-Command pnpm).Source`.

- **`corepack` is not recognised**: Node 25 and later do not bundle it; `npm install -g corepack`.
- **`running scripts is disabled on this system`**: the install script is started with
  `-ExecutionPolicy Bypass` by `pnpm install:windows`; if you run the `.ps1` by hand, add that flag.
- **Errors mentioning `node-gyp`, Visual Studio or Python** during `pnpm install`: a native
  package tried to compile because no prebuilt binary matched. That should never happen on a
  supported platform; please report it with the package name from the error.
- **The build produced an x64 installer on an ARM machine**: update the repository; the install
  script picks the architecture from `PROCESSOR_ARCHITECTURE` since October 2026.
- **Credentials**: passwords are stored in Windows Credential Manager under `RaSQL`.
- **SmartScreen warning**: see above.

## Updating later

```
git pull
pnpm install
pnpm install:windows
```
