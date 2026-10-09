# Building RaSQL: macOS on Intel

For Macs with an Intel processor. The build is a native x64 app; the same steps work in a Rosetta-free terminal.

This guide assumes a machine with nothing on it. Each step says what to check first; skip the
steps whose check passes. Commands are meant to be pasted one block at a time.

## 1. Tools

### Command Line Tools (gives you Git)

Check: `git --version` prints a version. If it offers to install the tools instead, accept, or run:

```
xcode-select --install
```

### Homebrew (package manager)

Check: `brew --version`. If missing:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the two lines it prints at the end to add Homebrew to your shell, then open a new terminal.

### Node.js 24 with nvm

Check: `node -v` prints `v24.x`. If missing or a different major version:

```
brew install nvm
mkdir -p ~/.nvm
```

Add to `~/.zshrc` (Homebrew prints the exact lines; they look like this):

```
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix nvm)/nvm.sh" ] && . "$(brew --prefix nvm)/nvm.sh"
```

Open a new terminal, then:

```
nvm install 24
nvm alias default 24
node -v     # v24.x
```

### pnpm through corepack

Check: `pnpm -v` prints `12.x` and `which pnpm` points inside your nvm Node directory. If missing:

```
corepack enable pnpm
```

If `corepack` is not found, your Node is newer than 24 and no longer bundles it:
`npm install -g corepack` and run the line again.

### Docker Desktop (optional, engine matrix only)

`brew install --cask docker`, then start Docker from Applications once.

## 2. Get the source

```
mkdir -p ~/Development && cd ~/Development
git clone https://github.com/rmpel/rasql-database-manager.git
cd rasql-database-manager
nvm use      # picks Node 24 from .nvmrc
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
node -p "process.arch"             # x64
ls node_modules/.pnpm | grep rollup-darwin   # must list rollup-darwin-x64
```

## 4. Verify, run, build

```
pnpm typecheck    # every package compiles
pnpm test         # unit tests; no database server needed
pnpm dev          # starts RaSQL with hot reload; close the window when done
```

Build the installer and install it:

```
pnpm install:mac
# installs ~/Applications/RaSQL.app and launches it; --no-launch to skip the launch
```

The package also lands in `packages/app/release/` as a `.dmg` and a `.zip`.

## First launch: the unsigned-app warning

RaSQL is not notarized by Apple (there is no paid developer account behind a free app; see
`docs/DECISIONS.md` D-12). macOS therefore blocks the first launch of a downloaded copy:

- "RaSQL can't be opened because Apple cannot check it for malicious software", or
- "RaSQL is damaged and can't be opened".

Open **System Settings, Privacy & Security**, scroll to the Security section and click
**Open Anyway** next to the message about RaSQL. This is needed once per build. The install
script already clears the quarantine flag for the copy it installs, so you normally only see
this for copies you downloaded from GitHub.

## 5. Optional: the MySQL and MariaDB engine matrix

The MySQL driver's tests run against seven real engines in Docker. This is optional; the unit
tests and the UI tests above cover everything else.

```
pnpm matrix:up       # starts MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.4 and Percona 8.0
pnpm test:matrix     # conformance suite against every engine that is up
pnpm matrix:down     # removes the containers and their data
```

## Troubleshooting

- **`pnpm: command not found` after `corepack enable`**: you have more than one Node. Run
  `which node` and `which pnpm`; both must live under the same `~/.nvm/versions/node/v24…/bin`.
- **The app starts but says "Electron"**: you launched a stale build; run `pnpm install:mac` again.
- **"Cannot find module @rollup/rollup-darwin-…"**: your pnpm ran under a different architecture
  than your Node (Rosetta terminal, or an x64 Node on an Apple Silicon Mac). `arch` must agree
  with `node -p process.arch`. Since the workspace installs both CPU variants, `pnpm install --force`
  normally fixes it; otherwise reinstall Node for your CPU with nvm.
- **Keychain prompt on first connection**: expected once; RaSQL stores passwords as real Keychain
  items named `RaSQL`.
- **Unsigned-app warning**: see above.

## Updating later

```
git pull
pnpm install
pnpm install:mac
```
