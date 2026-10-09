# RaSQL

A fast, keyboard-first database manager for web developers. Free, open source, Mac first, built for every OS.

**Status: Phase 0, foundation.** The driver protocol, SDK, SQLite and MySQL/MariaDB drivers and an Electron shell that opens, browses and queries databases exist and are tested. It is a scaffold, not a daily driver yet. See `docs/GOAL.md` for the phases.

| Document                                     | What it answers                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| [docs/GOAL.md](docs/GOAL.md)                 | Why this exists, who it is for, what ships in which phase, what we will not build   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, driver protocol, value model, one-click open, MCP, security          |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | Every decision taken so far, with the reasoning, so nobody re-argues it by accident |

## In one paragraph

RaSQL connects to the database the way developers actually reach it: a socket on the laptop, TCP on localhost, an SSH tunnel to a server. It opens in under a second, is driven from the keyboard, and shows production connections in a different color than local ones. Database engines are plug-in drivers behind one protocol, so the project starts with MySQL and MariaDB plus SQLite and grows from there without touching the core. It can be opened with one click from other tools, starting with a LocalWP add-on, and it exposes its connections to AI agents over MCP, but only the connections the user explicitly grants.

## Developing

Node 24 and pnpm through corepack. Docker only for the MySQL and MariaDB engine matrix.

```bash
corepack enable pnpm
pnpm install
pnpm typecheck      # every package
pnpm test           # unit tests and driver conformance suites that need no server
pnpm dev            # Electron with hot reload
pnpm matrix:up      # MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.4, Percona 8.0 in Docker
pnpm test:matrix    # MySQL driver conformance against every engine that is up
pnpm --filter @rasql/app package:mac   # unsigned .dmg and .zip in packages/app/release
pnpm install:mac       # build, package, (re)install ~/Applications/RaSQL.app, launch
pnpm install:linux     # same for Linux: AppImage under ~/.local/bin plus a desktop entry (--deb for dpkg)
pnpm install:windows   # same for Windows: silent per-user NSIS install, from PowerShell
```

Layout: `packages/driver-protocol` and `packages/driver-sdk` are what a driver author needs (MIT), `packages/driver-sqlite` and `packages/driver-mysql` are the bundled drivers, `packages/app` is the Electron application. See `CONTRIBUTING.md`.

## License

GPL-3.0-or-later for the application. The driver SDK and protocol package are MIT so that third-party drivers may carry any license. See `docs/GOAL.md` for the reasoning.
