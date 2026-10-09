# Contributing to RaSQL

Thanks for considering it. RaSQL is in its design and foundation phase, so the most useful contributions right now are drivers, test fixtures with awkward data, and bug reports with reproductions.

## Before you start

- Read `docs/GOAL.md`. It is the authority on what RaSQL is and is not. A pull request that conflicts with a principle there needs the principle changed first, in a separate discussion.
- Read `docs/DECISIONS.md` before proposing a change to something already decided. Decisions can be reopened, but with a case, not by accident.
- Open an issue before starting anything larger than a bug fix, so nobody duplicates work.

## Development setup

```bash
# Node 24 (see .nvmrc) and pnpm via corepack
corepack enable pnpm
pnpm install
pnpm typecheck
pnpm test
pnpm dev          # starts the Electron app with hot reload
```

The MySQL and MariaDB engine matrix needs Docker:

```bash
pnpm matrix:up    # starts every engine in test/matrix/docker-compose.yml
pnpm test:matrix  # runs the MySQL driver conformance suite against all of them
pnpm matrix:down
```

## Repository layout

```
packages/driver-protocol   types and wire protocol every driver speaks   (MIT)
packages/driver-sdk        base classes, transports, conformance checks (MIT)
packages/driver-sqlite     SQLite driver on node:sqlite                 (GPL-3.0-or-later)
packages/driver-mysql      MySQL and MariaDB driver on mysql2           (GPL-3.0-or-later)
packages/app               the Electron application                    (GPL-3.0-or-later)
docs/                      goal, architecture, decisions
test/matrix/               Docker Compose engine matrix and fixtures
```

## Writing a driver

A driver is a package that exports a `Driver` from `@rasql/driver-protocol` and is served with `serveDriver` from `@rasql/driver-sdk`. Look at `packages/driver-sqlite` for the smallest complete example. Run `runConformanceChecks` from the SDK against your driver; a driver that passes it is a driver RaSQL can load.

Rules that are not negotiable, because they are principles in `docs/GOAL.md`:

- Hand the core typed `Value`s. Never pre-render a cell to a string. Text you cannot decode becomes `bytes` with a `charsetHint`.
- 64-bit integers travel as strings. Never through a JavaScript `number`.
- Stream query results. Never buffer a whole result set.
- Honor `AbortSignal` on `connect` and `query` if your engine can cancel at all.

## Code style

- TypeScript strict mode, everywhere. `pnpm lint` and `pnpm format:check` must pass.
- Prefer small modules with one job. Early returns over nesting.
- Tests next to the code as `*.test.ts`, run with Vitest.
- Commit messages: imperative mood, one line of summary, blank line, then the why.

## Licensing of contributions

The application and the bundled drivers are GPL-3.0-or-later. The protocol and SDK packages are MIT so third-party drivers may use any license. By contributing you agree your contribution is licensed under the license of the package you contribute to. A Contributor License Agreement or Developer Certificate of Origin requirement may be introduced before the first release; see `docs/DECISIONS.md` D-07.
