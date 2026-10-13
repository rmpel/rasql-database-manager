# Installing RaSQL

Pick the guide for your machine. Each one installs a pre-built package from GitHub; nothing needs
to be compiled. To build from source instead, see [BUILD.md](BUILD.md).

| Your machine                                                       | Guide                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Mac with Apple Silicon (M1 or later)                               | [docs/install/INSTALL-MACOS-APPLE-SILICON.md](docs/install/INSTALL-MACOS-APPLE-SILICON.md) |
| Mac with an Intel processor                                        | [docs/install/INSTALL-MACOS-INTEL.md](docs/install/INSTALL-MACOS-INTEL.md)                 |
| Windows on ARM (Snapdragon, Surface Pro X and similar)             | [docs/install/INSTALL-WINDOWS-ARM.md](docs/install/INSTALL-WINDOWS-ARM.md)                 |
| Windows on Intel or AMD (x64)                                      | [docs/install/INSTALL-WINDOWS-X64.md](docs/install/INSTALL-WINDOWS-X64.md)                 |
| Linux on ARM (Raspberry Pi 4 or 5, ARM servers, Apple Silicon VMs) | [docs/install/INSTALL-LINUX-ARM.md](docs/install/INSTALL-LINUX-ARM.md)                     |
| Linux on Intel or AMD (x64)                                        | [docs/install/INSTALL-LINUX-X64.md](docs/install/INSTALL-LINUX-X64.md)                     |

Not sure which CPU you have?

- macOS: Apple menu, About This Mac. "Apple M…" is Apple Silicon, "Intel" is Intel.
- Windows: Settings, System, About, "System type". It says "ARM-based processor" or "x64-based processor".
- Linux: run `uname -m`. `aarch64` is ARM, `x86_64` is Intel or AMD.

## Where the packages are

- **Releases**: https://github.com/rmpel/rasql-database-manager/releases/latest. One per version tag.
- **Nightly**: https://github.com/rmpel/rasql-database-manager/releases/tag/nightly. Rebuilt on
  every push to master that passes CI; newer, less tested.

File names follow `RaSQL-<version>-<os>-<arch>.<ext>`. The guides list the exact file per machine.

## Unsigned builds

RaSQL is free and not code-signed (`docs/DECISIONS.md` D-12). macOS asks you to allow the first
launch, and Windows shows a SmartScreen prompt. Linux shows no warning. Each guide says what to click.
