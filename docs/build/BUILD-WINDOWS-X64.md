# Building RaSQL: Windows on Intel or AMD (x64)

For ordinary 64-bit Windows PCs. The build is a native x64 app.

This guide assumes a machine with nothing on it. Each step says what to check first; skip the
steps whose check passes. Commands are meant to be pasted one block at a time.

## 1. Tools

All commands below are for **PowerShell** (the blue one, or Windows Terminal). Not the Command
Prompt. No administrator rights are needed for anything in this guide.

### Allow scripts in PowerShell (once per user account)

Windows ships PowerShell with scripts disabled, and pnpm's launcher is a script. Allow locally
created and signed scripts for your own account, which needs no administrator:

```
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Check: `Get-ExecutionPolicy -Scope CurrentUser` prints `RemoteSigned`.

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

Check: `node -v` prints `v24.x` **and** `node -p process.arch` prints `x64`.
If either is wrong, install the right build:

Download the **x64** installer: on https://nodejs.org choose Node 24 LTS, Windows, x64 (.msi). Run it with the defaults. `winget install OpenJS.NodeJS.LTS` also works; check `node -p process.arch` afterwards, it must say `x64`.

Open a new PowerShell window afterwards.

### pnpm through corepack

Check: `pnpm -v` prints `12.x`, and `(Get-Command pnpm).Source` is one of these two places:

- `C:\Program Files\nodejs\pnpm.cmd` when Node 24 supplied corepack itself, or
- `%APPDATA%\npm\pnpm.cmd` (`C:\Users\<you>\AppData\Roaming\npm\`) when you installed corepack with npm.

Both are corepack shims that run pnpm on your own Node, which is what counts. It must **not** be
`C:\Users\<you>\AppData\Local\pnpm\pnpm.cmd`: that is the standalone pnpm, which bundles its
own Node; see the troubleshooting section for removing it.

If pnpm is missing, let corepack put its shim in npm's global folder, which your account may
write to and which is already on your PATH. Plain `corepack enable pnpm` tries to write into
`C:\Program Files\nodejs` and fails with `EPERM` unless PowerShell runs as administrator.

```
New-Item -ItemType Directory -Force "$env:APPDATA\npm" | Out-Null
corepack enable --install-directory "$env:APPDATA\npm" pnpm
```

If `corepack` is not recognised, your Node is newer than 24 and no longer bundles it:

```
npm install -g corepack
corepack enable --install-directory "$env:APPDATA\npm" pnpm
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
node -p "process.arch"                      # x64
Get-ChildItem node_modules\.pnpm | Select-String rollup-win32   # must list rollup-win32-x64-msvc
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
# builds a zip for this machine's CPU, extracts it to %LOCALAPPDATA%\Programs\RaSQL, registers the
# URL schemes, file types, Start Menu entry and an uninstall entry for your user, and launches RaSQL
```

The zip also lands in `packages\app\release\` as `RaSQL-<version>-x64.zip`.

## First launch

The script installs from the zip, so there is no installer and nothing for SmartScreen to warn
about; a build you made yourself has no mark-of-the-web. Everything lives under
`%LOCALAPPDATA%\Programs\RaSQL`, uninstall is in Settings, Apps, like any other app, and no
administrator rights are involved. Downloaded x64 installers from GitHub do get the SmartScreen
"Windows protected your PC" prompt once: click **More info**, then **Run anyway**.

## 5. Optional: the MySQL and MariaDB engine matrix

The MySQL driver's tests run against seven real engines in Docker. This is optional; the unit
tests and the UI tests above cover everything else.

```
pnpm matrix:up       # starts MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.4 and Percona 8.0
pnpm test:matrix     # conformance suite against every engine that is up
pnpm matrix:down     # removes the containers and their data
```

## Troubleshooting

- **`Cannot find module @rollup/rollup-win32-x64-msvc`**: the pnpm that ran `pnpm install` is not
  running on the same Node as the build, usually a standalone pnpm from `get.pnpm.io` next to a
  differently installed Node. `pnpm install --force` fixes the symptom; remove the standalone pnpm
  (`Remove-Item -Recurse -Force "$env:LOCALAPPDATA\pnpm"`, take it out of your user PATH, open a
  new window) and use `corepack enable pnpm` for the cure.
- **`corepack` is not recognised**: Node 25 and later do not bundle it; `npm install -g corepack`.
- **`running scripts is disabled on this system`**: set the per-user policy once,
  `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` (step 1). The install
  script itself passes `-ExecutionPolicy Bypass`, but pnpm's own launcher is a script too.
- **`corepack enable` fails with `EPERM … C:\Program Files\nodejs\pnpm`**: it tried to write next
  to `node.exe`. Use `corepack enable --install-directory "$env:APPDATA\npm" pnpm` as in step 1,
  or run that single command in a PowerShell started as administrator.
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
