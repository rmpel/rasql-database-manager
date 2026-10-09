# Building RaSQL

Pick the guide for your machine. Every guide is self-contained and starts from a computer with
nothing installed; if you already have Git, Node or pnpm, skip those steps. Each ends with RaSQL
built from source and installed, and explains the one-time warning you will see because the
builds are not code-signed (see `docs/DECISIONS.md` D-12).

| Your machine                                                       | Guide                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Mac with Apple Silicon (M1 or later)                               | [docs/build/BUILD-MACOS-APPLE-SILICON.md](docs/build/BUILD-MACOS-APPLE-SILICON.md) |
| Mac with an Intel processor                                        | [docs/build/BUILD-MACOS-INTEL.md](docs/build/BUILD-MACOS-INTEL.md)                 |
| Windows on ARM (Snapdragon, Surface Pro X and similar)             | [docs/build/BUILD-WINDOWS-ARM.md](docs/build/BUILD-WINDOWS-ARM.md)                 |
| Windows on Intel or AMD (x64)                                      | [docs/build/BUILD-WINDOWS-X64.md](docs/build/BUILD-WINDOWS-X64.md)                 |
| Linux on ARM (Raspberry Pi 4 or 5, ARM servers, Apple Silicon VMs) | [docs/build/BUILD-LINUX-ARM.md](docs/build/BUILD-LINUX-ARM.md)                     |
| Linux on Intel or AMD (x64)                                        | [docs/build/BUILD-LINUX-X64.md](docs/build/BUILD-LINUX-X64.md)                     |

Not sure which CPU you have?

- macOS: Apple menu, About This Mac. "Apple M…" is Apple Silicon, "Intel" is Intel.
- Windows: Settings, System, About, "System type". It says "ARM-based processor" or "x64-based processor".
- Linux: run `uname -m`. `aarch64` is ARM, `x86_64` is Intel or AMD.

## What every build needs

- **Git** to get the source.
- **Node.js 24 LTS**, the version in `.nvmrc`. Newer Node works too, but Node 25 and later no longer ship corepack, so you install it separately; the guides say how.
- **pnpm 12**, supplied by corepack from the `packageManager` field in `package.json`. Do not install pnpm any other way; a pnpm that runs on a different Node than your project's Node installs the wrong native binaries (the Windows on ARM guide has the story).
- No compiler, no Python, no Xcode, no Visual Studio. Every native piece ships prebuilt.
- **Docker** only if you want to run the MySQL and MariaDB engine matrix. Everything else, including the UI tests, runs without it.

## The commands, once the tools are there

```bash
git clone https://github.com/rmpel/rasql-database-manager.git
cd rasql-database-manager
pnpm install          # first time: about two minutes
pnpm typecheck        # optional sanity check
pnpm test             # unit tests, no server needed
pnpm dev              # run with hot reload
pnpm install:mac      # or install:linux, or install:windows: build, package and install
```

The install scripts live in `scripts/`. They build the LocalWP add-on, the app and the installer
for your OS, replace any previously installed copy and launch the result.

## Continuous integration

Every push builds and tests on macOS, Ubuntu and Windows, including the UI tests and a packaged
installer per OS, which is attached to the run as an artifact for fourteen days. If a guide below
fails for you and CI is green, the difference is on the machine; the troubleshooting section of
each guide lists the differences we have met so far.
