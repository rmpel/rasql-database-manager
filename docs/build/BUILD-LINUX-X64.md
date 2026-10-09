# Building RaSQL: Linux on Intel or AMD (x64)

For ordinary 64-bit Linux PCs and servers. The build is a native x64 AppImage and .deb.

This guide assumes a machine with nothing on it. Each step says what to check first; skip the
steps whose check passes. Commands are meant to be pasted one block at a time.

## 1. Tools

Commands are for Debian and Ubuntu (apt). Fedora users: replace `apt install` with `dnf install`
and the package names are close enough to find. Nothing here needs root except `apt`.

### Git, curl and the libraries Electron needs at runtime

```
sudo apt update
sudo apt install -y git curl ca-certificates \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0 libasound2t64 libfuse2t64
```

On Ubuntu 22.04 the last two are called `libasound2` and `libfuse2`. `libfuse2` is what lets an
AppImage run; `libsecret` is the keychain RaSQL stores passwords in (GNOME Keyring or KDE Wallet
must be running for that; otherwise RaSQL falls back to its own encrypted store).

### Node.js 24 with nvm

Check: `node -v` prints `v24.x` and `node -p process.arch` prints `x64`. If not:

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
```

Open a new terminal, then:

```
nvm install 24
nvm alias default 24
node -v
```

### pnpm through corepack

Check: `pnpm -v` prints `12.x` and `which pnpm` is inside `~/.nvm/versions/node/v24…/bin`. If not:

```
corepack enable pnpm
```

If `corepack` is missing, your Node is newer than 24: `npm install -g corepack` first.

### For the UI tests only: a virtual display

```
sudo apt install -y xvfb
```

### Docker (optional, engine matrix only)

Follow https://docs.docker.com/engine/install/ for your distribution and add yourself to the
`docker` group so `docker` works without sudo.

## 2. Get the source

```
mkdir -p ~/Development && cd ~/Development
git clone https://github.com/rmpel/rasql-database-manager.git
cd rasql-database-manager
nvm use
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
node -p "process.arch"                 # x64
ls node_modules/.pnpm | grep rollup-linux    # must list rollup-linux-x64-gnu
```

## 4. Verify, run, build

```
pnpm typecheck    # every package compiles
pnpm test         # unit tests; no database server needed
pnpm dev          # starts RaSQL with hot reload; close the window when done
```

Build the installer and install it:

```
pnpm install:linux
# builds an AppImage and a .deb for this CPU, installs the AppImage under ~/.local/bin with a
# desktop entry that registers rasql:// and the SQLite file types, and launches it.
# Add --deb to install the .deb with sudo dpkg instead, or --no-launch to skip the launch.
```

The packages also land in `packages/app/release/` as `RaSQL-<version>-x64.AppImage` and a `.deb`.

## First launch

There is no signing warning on Linux. The desktop entry and the `rasql://` handler become active after the install script runs `update-desktop-database`; some desktops need a logout to show the icon.

## 5. Optional: the MySQL and MariaDB engine matrix

The MySQL driver's tests run against seven real engines in Docker. This is optional; the unit
tests and the UI tests above cover everything else.

```
pnpm matrix:up       # starts MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.4 and Percona 8.0
pnpm test:matrix     # conformance suite against every engine that is up
pnpm matrix:down     # removes the containers and their data
```

## Troubleshooting

- **The AppImage does not start, "dlopen(): error loading libfuse.so.2"**: install `libfuse2`
  (`libfuse2t64` on Ubuntu 24.04), or use `pnpm install:linux --deb`.
- **"The SUID sandbox helper binary was found, but is not configured correctly"**: on some
  Ubuntu 24.04 setups Electron's sandbox needs user namespaces:
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Not needed on the GitHub runners.
- **`pnpm test:e2e` says it cannot open a display**: run it as `xvfb-run -a pnpm test:e2e`.
- **Passwords are not remembered**: no Secret Service was running (GNOME Keyring or KDE Wallet).
  RaSQL then uses its own encrypted store, which works but is not visible in a keyring app.
- **`Cannot find module @rollup/rollup-linux-…`**: pnpm and Node disagree on the CPU, for example a
  pnpm installed through a distribution package. Use corepack's pnpm, then `pnpm install --force`.
- **Icon or URL handler does not appear**: log out and in once, or run
  `update-desktop-database ~/.local/share/applications`.

## Updating later

```
git pull
pnpm install
pnpm install:linux
```
