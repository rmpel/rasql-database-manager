# RaSQL: Goal

Last revised 2026-10-08. This is the document everything else answers to. When a feature request or a technical choice comes up, the first question is whether it serves what is written here.

## 1. The one-sentence goal

RaSQL is a fast, keyboard-first database manager for web developers that connects to the database the way developers actually reach it: locally, over SSH, or from another tool with one click, with no setup ceremony.

## 2. Who it is for

The primary user is a web developer, typically working in PHP, WordPress, Laravel or Node, who opens a database tool many times a day to look at data, fix a row, check a schema, or run a query. They work against a local database most of the day and against staging and production some of the time. They use LocalWP, Docker, Homebrew MySQL or a remote server behind SSH.

Secondary users are AI coding agents acting on the developer's behalf, which reach the same databases through the Model Context Protocol, but only where the developer has granted access.

Not the target: database administrators managing clusters, replication and backups. Analysts who want charts and dashboards. Those people have DBeaver and DataGrip.

## 3. The gap we fill

Sequel Pro is unmaintained and Sequel Ace keeps it on life support. TablePlus is polished, closed and paid. DBeaver does everything and feels like it. phpMyAdmin and Adminer run server-side and look their age. Beekeeper Studio and DbGate are open source Electron tools that are generic by design.

Nobody owns "the tool a PHP or WordPress developer opens fifty times a day". Our differentiation is that focus:

- one-click open from the tools web developers already use, starting with LocalWP;
- credential discovery from project folders and local development tools;
- first-class handling of the data web developers actually store: JSON, PHP serialized blobs, mixed-charset text;
- an MCP server with a permission model the developer controls;
- a driver architecture that lets anyone add an engine.

## 4. Principles

These are commitments, not aspirations. A change that violates one needs a very good argument.

1. **Fast.** Opens in under a second on a cold start and restores where you were. A million-row table scrolls without stutter.
2. **Keyboard first.** Every action is reachable from the keyboard. A command palette lists all of them. The mouse is welcome but never required.
3. **Production looks different.** Connections carry a color and an environment label. Production connections can be flagged read-only. Destructive statements against a flagged connection require confirmation.
4. **Values are typed until the last moment.** The driver hands the UI typed values, never pre-rendered strings. Bytes stay bytes, charsets stay known, JSON stays JSON. This principle exists because its violation sank the previous attempt.
5. **Secrets live in the keychain.** Passwords are never written to a plain file, a log, or a crash report. The URL scheme accepts credentials for convenience, and they go straight to the credential store.
6. **The agent gets nothing by default.** MCP clients see no connections until the user grants one, per connection, with a level and a lifetime.
7. **No account, no telemetry, no cloud dependency.** The app works fully offline. Updates are checked against GitHub Releases and nothing else.
8. **Engines are plug-ins.** The core knows nothing about MySQL. If adding an engine means touching the core, the driver protocol is wrong and gets fixed first.
9. **Built for every OS, polished on Mac first.** Nothing in the code may assume macOS, but the macOS build is the one that gets tested by hand before a release.

## 5. Scope by phase

Phases are ordered by what makes the app usable daily as early as possible. A phase is done when its items work against the full test matrix (see ARCHITECTURE.md section 10), not when they work on the author's machine.

### Phase 0: foundation

The invisible work that every later phase depends on.

- Repository, licensing, contribution guide, code of conduct.
- Electron plus TypeScript plus React scaffold with hot reload and a reproducible build.
- The driver protocol and SDK as a separate package, with the typed value model.
- MySQL/MariaDB driver with flavor detection (MySQL, MariaDB, Percona, Aurora, TiDB, Vitess/PlanetScale).
- SQLite driver.
- Integration test matrix in Docker: MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.x.
- Credential store abstraction with OS keychain and "prompt every time" providers.
- SSH tunnel manager using a library, reading `~/.ssh/config`, supporting keys, agent, password and jump hosts.

### Phase 1: daily driver

The minimum that lets a developer replace their current tool.

- Connection manager: favorites, groups, color, environment label, read-only flag.
- Window per connection, tabs inside for tables, queries and panels.
- Schema browser: databases, tables, views, routines, triggers, events (read-only definitions).
- Data grid: virtualized, paging, column filters (typed rules, same-column any/all groups, quick search, raw WHERE), sorting, inline editing with pending-change review, explicit NULL handling, follow foreign keys, per-type renderers for text, numbers, dates, bytes and JSON.
- Query editor: tabs, syntax highlighting, autocomplete from the live schema, query history, saved queries, EXPLAIN, cancel a running query.
- Structure editor: columns (type picked by kind, size, unsigned, values, default, nullability, auto increment, comment, position), indexes, foreign keys, table name and comment, with the generated ALTER shown before it runs. SQLite gets what it can do in place.
- Export: SQL, CSV, JSON, for a table or a result set.
- Command palette.
- One-click open: `rasql://` URL scheme, `mysql://` URLs, `.rasql` and `.spf` files, CLI entry point, SQLite file association.
- LocalWP site discovery by reading Local's own sites registry, no add-on required.
- Unsigned macOS build published on GitHub Releases with a Homebrew cask in RaSQL's own tap (`brew install --cask rmpel/rasql/rasql`).

### Phase 2: the web developer edge

- Import connections from Sequel Pro/Ace `.spf` favorites and TablePlus (moved from Phase 1).
- SQLite table rebuilds, so column types and defaults can change there too (MySQL editing shipped in Phase 1).
- Import SQL dumps of any size without loading them into memory.
- Viewers and editors for JSON and PHP serialized data. WordPress option tables become readable.
- Charset tools: show raw bytes, reinterpret a column as another charset, detect the latin1-holding-utf8 problem.
- MCP server with the permission model described in ARCHITECTURE.md section 8.
- LocalWP add-on that adds an "Open in RaSQL" button, installable from inside RaSQL.
- Project folder discovery: wp-config.php, .env, Laravel config, docker-compose.
- 1Password credential provider.
- Global search across all tables of a database.
- Windows and Linux builds.
- More engines, each as a driver behind the same protocol: PostgreSQL (the obvious next relational
  engine), MSSQL (moved up from Phase 3), and MongoDB. MongoDB maps onto the protocol with
  collections as tables, documents as rows with an `_id` column and one JSON column, filters
  compiled to query documents instead of WHERE clauses, and a query tab that takes `find` and
  `aggregate` expressions; the dialect surface needs a design note before it starts.

### Phase 3: depth

- Schema diff between two connections, producing migration SQL.
- Users and privileges editor.
- Serialization-aware search and replace across a database.
- Out-of-process drivers in other languages, if demand exists.
- Further drivers by the community, on the MIT protocol and SDK.

## 6. Non-goals

Stated so they do not creep in.

- Entity relationship diagrams and visual schema design.
- NoSQL engines. The protocol is relational by design.
- Team features: shared connections, cloud sync, accounts.
- A server-side or hosted mode. RaSQL is a desktop application.
- Built-in AI chat. RaSQL is an MCP server, not an MCP client. A future "ask about this query" feature is possible but not a goal.
- Backup scheduling, replication management, cluster administration.

## 7. What success looks like

- A developer with LocalWP installed sees their sites as connections on first launch and is looking at a table within ten seconds of opening the app.
- A production table with a million rows opens, filters and scrolls without the UI stalling.
- An agent in Claude Code can inspect a local schema after a one-click grant, and cannot see the production connection at all unless granted.
- Someone outside the project writes a working driver for another engine using only the SDK package and its documentation.
- Opening a WordPress `wp_options` table shows readable serialized data instead of a wall of `a:3:{s:4:...`.

## 8. Licensing

**Decision:** the application is GPL-3.0-or-later. The driver SDK and protocol package are MIT.

**What the author wants:** anyone may copy, modify and redistribute with attribution. Nobody may sell it without consent or a kickback.

**What GPLv3 delivers and what it does not.** GPLv3 guarantees attribution and keeps every redistributed copy open. It does not forbid selling. Anyone may charge for a GPL build, but they must ship the source, which makes a paid fork hard to sustain. The closest legal tools that actually forbid commercial use (PolyForm Noncommercial, Commons Clause, Creative Commons NC) are not open source by the accepted definition, scare off contributors, and would exclude the project from Homebrew core and most distribution channels. GPLv3 is the pragmatic compromise.

**Keeping the kickback option open.** To ever license RaSQL commercially to a third party, the author must own the copyright on all contributions. That requires a Contributor License Agreement that assigns or broadly licenses contributions to the author. The alternative, a Developer Certificate of Origin, is lighter and friendlier but closes the door on dual licensing forever. This is an open choice; see DECISIONS.md D-07.

**Why the SDK is MIT.** Drivers run in a separate process and speak a protocol, but GPL boundaries around process separation are legally murky. Making the SDK MIT removes any doubt: a company may write a closed driver for their proprietary database and that is fine, because the driver is their work and the app stays GPL.

## 9. Distribution

- GitHub Releases is the source of truth. Homebrew cask for macOS, in the project's own tap: the main Homebrew cask repository only accepts apps that pass Gatekeeper. Winget and a `.deb`/AppImage when Windows and Linux builds arrive.
- Built-in update check against GitHub Releases, user-triggered or on launch, never silent.
- **Code signing.** There is no Apple Developer account and no intention to pay the yearly fee while the project is free. Consequence: macOS builds are ad-hoc signed and not notarized. On current macOS the first launch is blocked by Gatekeeper and the user must allow it in System Settings under Privacy and Security. Homebrew no longer offers a way around this (`--no-quarantine` is gone), so Homebrew users allow the app once too. The README and the download page must explain this honestly and in one screenshot. If the project gains traction, GitHub Sponsors or Open Collective can fund the fee; that decision is revisited at the first stable release.
- Windows builds will trigger a SmartScreen warning for the same reason. Linux has no equivalent problem.

## 10. Identity

- Name: RaSQL, pronounced "rascal". The repository folder is still called `SequelShark` after the working title; renaming it is a housekeeping task.
- Bundle identifier: `nl.remonpel.rasql`.
- URL scheme: `rasql://`. File extension: `.rasql`.
- GitHub: `rmpel/rasql`. The bare `rasql` account is an unrelated individual. A handful of small hobby and academic projects use the name for relational-algebra-to-SQL tools; none is a product or a client.
- npm: `rasql` and the `@rasql/*` scope are free at the time of writing and should be claimed early. PyPI `rasql` is free too.
- Domains: `rasql.app`, `rasql.com` and `rasql.nl` are free. `rasql.dev` and `rasql.io` are taken.
- Previous working title: SQLShark, dropped because the GitHub organization and the .com were held by others.

## 11. Open items

Things that still need an answer, none of which block Phase 0.

- CLA or DCO (section 8).
- Which virtualized grid library, or whether to write one on a canvas. Decided by a spike in Phase 0 against the million-row requirement.
- Whether `mysql://` URLs with an embedded password should be accepted silently or shown to the user before the credential is stored.
- Domain name, if any. `rasql.app` is the natural choice if one is wanted.
