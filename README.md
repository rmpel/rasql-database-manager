# RaSQL

## MCP has arrived

Since 0.2.0, AI agents such as Claude Code can work with your databases through RaSQL, and you stay
in charge of every connection:

- **One command to connect:** `claude mcp add rasql -- /Applications/RaSQL.app/Contents/MacOS/RaSQL mcp`
  (File › MCP Server… shows the exact command for your install).
- **Nothing is shared until you say so.** Each connection, and each LocalWP site, starts Hidden. Open
  it up as Read-only, Ask, Secure or Read/Write.
- **Changes that can lose data always ask**, even on Read/Write: DROP, DELETE, TRUNCATE, an UPDATE
  without WHERE, or narrowing a column whose data does not fit. RaSQL checks the data first.
- **Secure** has your operating system confirm every change: Touch ID or your password on macOS,
  Windows Hello or your password on Windows, polkit on Linux. No other program can approve it with
  a click.
- **Passwords never reach an agent**, each connection is limited to its own database, and every
  action, refused ones included, lands in an audit log you can read in the app.

The details are in [MCP.md](MCP.md).

> **Testers wanted on Windows and Linux.** MCP is tested on macOS only. The Windows and Linux
> versions are built but have never run on those systems: connecting a client with `rasql mcp`, the
> prompts, and Secure mode (Windows Hello with password fallback on Windows, polkit on Linux). If
> you use RaSQL there, please connect an agent, open up a test connection, try Ask and Secure, and
> tell us what happened, good or bad, in a
> [GitHub issue](https://github.com/rmpel/rasql-database-manager/issues/new?title=MCP%20on%20Windows%2FLinux).
> Mention your OS and version, your MCP client, and whether Windows Hello or a fingerprint reader
> is set up.

---

A fast database manager for web developers. Free, open source, Mac first, builds available for Windows, Mac and Linux, on AMD64/intel as well as ARM64.

## DISCLAIMER

This is Claude co-authored software, if you don't like AI generated software, then don't use it.

This is not copied software, not reverse engineered, not taken from any other project, this is coded from scratch (by Claude).

**Status: Phase 1, foundation.** The driver protocol, SDK, SQLite, MySQL/MariaDB, PostgreSQL and SQL Server drivers and an Electron shell that opens, browses and queries databases exist and are tested. It is a scaffold, not a daily driver yet. See `docs/GOAL.md` for the phases.

| Document                                     | What it answers                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| [docs/GOAL.md](docs/GOAL.md)                 | Why this exists, who it is for, what ships in which phase, what we will not build   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, driver protocol, value model, one-click open, MCP, security          |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | Every decision taken so far, with the reasoning, so nobody re-argues it by accident |
| [MCP.md](MCP.md)                             | What AI agents can do through MCP, and how the user stays in control                |

## In one paragraph

RaSQL connects to the database the way developers actually reach it: a socket on the laptop, TCP on localhost, an SSH tunnel to a server. It opens in under a second and shows production connections in a different color than local ones. Database engines are plug-in drivers behind one protocol, so the project starts with MySQL and MariaDB plus SQLite and grows from there without touching the core. It can be opened with one click from other tools, starting with a LocalWP add-on, and it exposes its connections to AI agents over MCP, but only the connections the user explicitly grants.

## Downloads

Versioned releases: https://github.com/rmpel/rasql-database-manager/releases/latest. See
[INSTALL.md](INSTALL.md) for step-by-step installation per OS and CPU.

Every push to `master` that passes CI replaces the rolling **nightly** pre-release:
https://github.com/rmpel/rasql-database-manager/releases/tag/nightly. It carries macOS (Apple
Silicon and Intel), Windows (x64 installer, ARM64 zip) and Linux (x64 and ARM64 AppImage and
.deb). The builds are unsigned; the release notes say how to get past the first-launch warning.

RaSQL opens `rasql://`, `mysql://`, `mariadb://` and `sqlite://` links. It can also open
`postgres://`, `postgresql://`, `mssql://` and `sqlserver://` links, but does not take them from
other apps. If no other app handles them, macOS will probably send them to RaSQL anyway. Otherwise,
macOS has no settings screen for this, so use [duti](https://github.com/moretension/duti)
(`brew install duti`): `duti -s nl.remonpel.rasql postgres all`, and the same for the other
schemes. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 7.

## Developing

Starting from a machine with nothing installed? See [BUILD.md](BUILD.md) for a from-scratch guide per OS and CPU, including Windows on ARM.

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
pnpm install:linux     # same for Linux: AppImage under ~/.local/bin plus a desktop entry (--deb for apt)
pnpm install:windows   # same for Windows: silent per-user NSIS install, from PowerShell
```

Layout: `packages/driver-protocol` and `packages/driver-sdk` are what a driver author needs (MIT), `packages/driver-sqlite`, `packages/driver-mysql`, `packages/driver-postgres` and `packages/driver-mssql` are the bundled drivers, `packages/app` is the Electron application. See `CONTRIBUTING.md`.

## License

GPL-3.0-or-later for the application. The driver SDK and protocol package are MIT so that third-party drivers may carry any license. See `docs/GOAL.md` for the reasoning.
