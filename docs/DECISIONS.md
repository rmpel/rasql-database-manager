# RaSQL: Decisions

A log of every decision taken during the design phase, so nobody re-argues one by accident and newcomers can see why things are the way they are. Format: what was decided, why, what was rejected. "Owner" says who made the call: the author (Remon), or Claude with the author's blessing after delegating the choice.

All entries dated 2026-10-08 unless stated otherwise.

## D-01 A real desktop application, Mac first, built for every OS

**Decided:** RaSQL is a native-feeling desktop application. macOS is the first and best-tested platform. Nothing in the code may assume macOS; Windows and Linux builds arrive in Phase 2.
**Why:** The author is a Mac user and the target audience skews that way, but an open source project should not lock itself to one OS.
**Rejected:** A web-hosted or server-side mode like Adminer or phpMyAdmin. A local daemon with a browser UI.
**Owner:** Remon.

## D-02 Electron, TypeScript, React

**Decided:** The shell is Electron, the language is TypeScript everywhere, the UI is React with SCSS modules.
**Why:** Identical rendering on every OS; one language for the app, the drivers, the LocalWP add-on and the MCP server; the largest contributor pool for an open source project; mature typed database drivers in Node. The problems that sank the previous attempt (SwiftDB) were design problems, not language problems, and would have recurred in any language.
**Rejected:** Tauri with Rust, on webview inconsistency across OSes, smaller contributor pool and awkward dynamic plugins. Swift/SwiftUI, which was tried and abandoned. Go.
**Owner:** Claude, delegated by Remon ("your call").

## D-03 Engines are plug-in drivers behind one protocol

**Decided:** A driver is a package implementing one interface, running in its own Electron utility process, talking to the core over a typed message protocol. The core never imports a database library. For version one, drivers are TypeScript packages. Because the boundary is a protocol, out-of-process drivers in other languages are possible later without redesign.
**Why:** An external developer must be able to add an engine without touching the core. Process isolation means a crashing driver takes down one connection, not the app.
**Rejected:** Out-of-process drivers from day one, as unnecessary complexity for version one.
**Owner:** Remon set the requirement; Claude shaped the mechanism; Remon accepted.

## D-04 Engine order: MySQL and MariaDB first, SQLite with it, MSSQL later, PostgreSQL by the community

**Decided:** Phase 0 ships one MySQL/MariaDB driver with flavor detection (MySQL, MariaDB, Percona, Aurora, TiDB, Vitess/PlanetScale) and a SQLite driver. MSSQL is Phase 3. PostgreSQL is not on the core roadmap; it is a driver someone writes.
**Why:** The audience is web developers on the MySQL family. SQLite is cheap and makes UI tests container-free.
**Owner:** Remon.

## D-05 Transports: TCP, Unix socket, file, and SSH tunnelling in the core

**Decided:** Drivers see a TCP endpoint, a socket path or a file. SSH tunnelling is done by the core and is invisible to drivers. "HTTP" in the original brief meant plain TCP.
**Rejected:** An HTTP bridge script for shared hosts, in the style of Adminer. Not wanted.
**Owner:** Remon clarified; Claude placed SSH in the core.

## D-06 License: GPL-3.0-or-later for the app, MIT for the driver SDK and protocol

**Decided:** As stated.
**Why:** The author wants free copying, modification and redistribution with attribution, and does not want others selling it without consent. GPLv3 guarantees attribution and keeps forks open, which makes a paid fork hard to sustain, though it does not forbid selling. Licenses that forbid commercial use are not open source by the accepted definition and would scare off contributors and distribution channels. The SDK is MIT so third-party drivers may carry any license without GPL boundary questions.
**Rejected:** Creative Commons NC/SA (not for software), PolyForm Noncommercial, Commons Clause, MIT for the whole app, AGPL.
**Owner:** Remon chose GPLv3; Claude proposed the MIT SDK carve-out; accepted.

## D-07 Contributor agreement: open

**Status:** Undecided.
**The choice:** A Contributor License Agreement keeps the option to license RaSQL commercially later, which is the only way "consent or kickback" can ever be enforced. A Developer Certificate of Origin is lighter and friendlier but closes that door permanently.
**Recommendation:** Decide before the first external pull request. Default to DCO if no answer is given by then.

## D-08 MCP: deny by default, grants per connection, writes approved by a human

**Decided:** RaSQL is an MCP server. Clients see no connections until the user grants one in the app, per client, per connection, with a level (read or write) and a lifetime. Production and read-only connections cannot be granted write. Write statements are proposals that a human approves in the UI. Every action is audited. Credentials are never exposed over MCP.
**Why:** The author may have a production connection stored next to a local one. An agent must not be able to read production because it was allowed to read local.
**Rejected:** Read-only access to all connections by default. A per-connection "free write" switch.
**Owner:** Remon.

## D-09 Window per connection, tabs inside

**Decided:** Each connection opens its own window. Tables, queries, structure views and panels are tabs inside it. A connection is a self-contained unit so a single-window layout with a vertical connection sidebar can be added later as a layout option.
**Why:** It is the Sequel Pro and TablePlus model the audience knows.
**Rejected for now:** A single window with everything in tabs.
**Owner:** Remon.

## D-10 Deep links may carry a password; a missing password is prompted for and stored

**Decided:** `rasql://` and `mysql://` URLs may include a password. It goes straight to the credential store and is never logged or shown. When a URL arrives without one, the connect fails on authentication and the user is prompted, with an offer to store the password in the keychain. Third parties may therefore integrate without handling the secret.
**Why:** For LocalWP the credentials are always `root`/`root`, so convenience wins. Other integrators get a safe path.
**Rejected:** A mandatory one-time token handoff. Over-engineering for the actual threat.
**Owner:** Remon.

## D-11 Credential providers are pluggable; keychain and prompt first, 1Password in Phase 2

**Decided:** Connection definitions never contain secrets; they hold a reference to a provider. OS keychain and "prompt every time" ship in Phase 0. 1Password via the `op` CLI and `op://` references ships in Phase 2. Others, such as Bitwarden, if someone writes them.
**Owner:** Remon asked for 1Password; Claude shaped the provider interface.

## D-12 No Apple Developer account; unsigned builds, documented honestly

**Decided:** Builds are ad-hoc signed and not notarized. The first launch on macOS requires the user to allow the app in System Settings. Homebrew users may use `--no-quarantine`. The README explains this with one screenshot. Revisit at the first stable release, possibly funded through GitHub Sponsors or Open Collective.
**Why:** The project is free and the author will not pay the yearly fee for it.
**Owner:** Remon.

## D-13 Typed values from driver to grid

**Decided:** Cells are tagged values (null, int as string, decimal as string, float, text with charset, bytes, date, time, datetime, json, bit, enum, set, geometry, unknown) until a renderer draws them. Text that cannot be decoded in its column charset becomes bytes with a hint, never a string with replacement characters. Nothing in the UI concatenates SQL; the dialect serializes changes.
**Why:** SwiftDB flattened every value to an optional string at the driver boundary. That single choice caused its encoding bugs and its binary display bugs.
**Owner:** Claude, from reading the SwiftDB source; Remon accepted.

## D-14 SSH through a library with verified host keys

**Decided:** The ssh2 library in the main process, reading `~/.ssh/config`, supporting agent, keys with passphrase, password and jump hosts. Host keys are checked against `known_hosts`; unknown hosts prompt with a fingerprint; changed keys refuse. There is no option to disable checking.
**Why:** SwiftDB spawned the system ssh binary with host key checking disabled. Fragile and unsafe.
**Implemented 2026-10-09** in `packages/app/src/main/ssh/`, tested against an in-process ssh2 server. Known gaps: `Match` blocks in ssh config are ignored, and "remember" stores secrets for the last hop only, so jump hops need an agent or a key.
**Owner:** Claude; Remon accepted.

## D-15 Name: RaSQL

**Decided:** RaSQL, pronounced "rascal". Working title was SQLShark.
**Why SQLShark was dropped:** the `sqlshark` GitHub organization is held by an unrelated person and `sqlshark.com` is parked for sale.
**Also considered and rejected:** SQLSurfer and SequelSurfer (free, but did not land), SQuirreL (existing Java SQL client since 2001), Seaquel (an existing commercial SQL client), Remora, Querty, Thresher, DataBaas, Hammerhead, Squire, Duck SQL / DuckII (reads as a DuckDB tool and DuckDB Labs holds the brand), Threequel, Index Finger, Joinery, Alter Ego, Rowmance, Squint, Prequel (existing photo app), Squeegee (existing app), Mako and Rowboat (existing Homebrew packages).
**Availability at decision time:** npm `rasql` free, `@rasql/*` scope free, PyPI free, no Homebrew cask or formula, `rasql.app`, `rasql.com` and `rasql.nl` free. `rasql.dev` and `rasql.io` taken. A few small hobby and academic projects share the name for relational-algebra-to-SQL tools; none is a product.
**Owner:** Remon.

## D-16 Identifiers

**Decided:** Bundle id `nl.remonpel.rasql`. URL scheme `rasql://`. File extension `.rasql`. GitHub `rmpel/rasql`. npm scope `@rasql`. Repository folder may be renamed from `SequelShark` at the author's convenience.
**Owner:** Remon.

## D-17 Ownership

**Decided:** RaSQL is the author's personal project, not an Acato project. Copyright line and GitHub location follow from that.
**Owner:** Remon.

## D-18 One-click open through every door at once

**Decided:** `rasql://` scheme, generic `mysql://` URLs, `.rasql` files, Sequel Pro `.spf` import, SQLite file association, a CLI, and discovery from LocalWP's sites registry and from project folders. Plus a LocalWP add-on that adds an "Open in RaSQL" button, installable from inside RaSQL.
**Why:** Every third-party tool picks a different mechanism. Supporting all of them costs little and removes every excuse not to integrate.
**Owner:** Remon set the goal; Claude enumerated the doors; accepted.

## D-19 Non-goals

**Decided:** No entity relationship diagrams, no NoSQL engines, no team or cloud sync features, no hosted mode, no built-in AI chat, no cluster administration.
**Why:** Focus. Each would pull the project toward DBeaver or toward a SaaS, and away from "the tool a web developer opens fifty times a day".
**Owner:** Claude proposed; Remon accepted by not objecting. Any of these may be reopened with a case.

## D-20 Nothing ships with a red engine matrix

**Decided:** Every driver has a conformance suite that runs against every engine it claims to support, in Docker, on every change. The fixture database includes every awkward value we know of: NULLs, empty strings, zero dates, negative TIME, 64-bit integers, emoji, utf8 bytes in a latin1 column, large BLOBs, invalid UTF-8, JSON, a million-row table.
**Why:** SwiftDB had no tests and shipped with indexes and foreign keys disabled because the driver crashed. The matrix is how we know a driver works, and how an external developer proves theirs does.
**Owner:** Claude; Remon accepted.

## D-21 SQLite through `node:sqlite`, not a native module

**Decided:** The SQLite driver uses Node's built-in `node:sqlite`. Electron 44 embeds Node 24.21, which has it, and development runs on Node 24 too.
**Why:** `better-sqlite3` is a V8-API native module that must be rebuilt separately for the Node ABI (tests) and the Electron ABI (app). Two builds of one module is a permanent source of "works in tests, crashes in the app". `node:sqlite` has no such split, supports bigint reads and array rows, and is fast enough.
**Cost:** Cancellation is cooperative, between row batches; a single slow step cannot be interrupted. Loadable extensions are available but not yet exposed.
**Owner:** Claude; dated 2026-10-09.

## D-22 The app bundles its workspace packages; no node_modules ship

**Decided:** electron-vite bundles `@rasql/*` packages and their dependencies into `out/`. The packaged app contains no `node_modules`. pnpm stays in its default isolated layout.
**Why:** electron-builder and pnpm workspaces disagree about how to collect production dependencies, and bundling removes the question entirely. A dependency that cannot be bundled (a native module) would be added to the app's own `dependencies` and externalized explicitly, with a note here.
**Owner:** Claude; dated 2026-10-09.

## D-23 Toolchain pins at scaffold time

**Decided:** Node 24 (`.nvmrc`), pnpm 12 via corepack, Electron 44, electron-vite 5 on Vite 7 (electron-vite 5.0.0 does not accept Vite 8), `@vitejs/plugin-react` 5, TypeScript 5.9 (typescript-eslint does not yet accept TypeScript 6 or 7), Vitest 5, ESLint 10 with the React Compiler lint rules from `eslint-plugin-react-hooks` 7.
**Why:** Each pin is the newest version whose peers agree. Revisit when electron-vite accepts Vite 8 and typescript-eslint accepts TypeScript 7.
**Owner:** Claude; dated 2026-10-09.

## D-24 The driver boundary is a message protocol, and the dialect crosses it as RPC

**Decided:** `Dialect` methods are implemented synchronously inside the driver and exposed to the core as asynchronous RPC calls over the same protocol as queries. The core never loads a driver's dialect in-process.
**Why:** The core must not import driver code (D-03). Building SQL for grid edits is a handful of calls per user action, so a round trip to the driver process costs nothing noticeable, and an out-of-process driver in another language keeps working unchanged.
**Owner:** Claude; dated 2026-10-09.

## D-25 Credentials are real OS keychain items; Electron `safeStorage` is only a fallback

**Decided:** The default `keychain` provider stores each secret as a real keychain item through `@napi-rs/keyring`: service `RaSQL`, account `rasql:<connection id>:<kind>`. On macOS they are visible and manageable in Keychain Access. Electron `safeStorage` with ciphertext in the user data directory is the fallback when no keychain is available.
**Why:** The first version used `safeStorage` and lost every password across restarts in development. Its key lives in a keychain item that an unsigned development binary cannot reliably read back, so ciphertext written by one run failed to decrypt in the next. Real keychain items are owned by the app and survive restarts, and users can see what the app stored. Verified by an end-to-end test that saves a connection, quits, relaunches and reconnects without a prompt, and by the same round trip inside the packaged app.
**Cost:** The only native module in the app. It is N-API, so it needs no rebuild for Electron, but it cannot be bundled: it ships in `node_modules` inside the asar and is unpacked at install time (`asarUnpack`), the single exception to D-22. The platform packages are listed as `optionalDependencies` so pnpm links the right one.
**Owner:** Claude; Remon reported the bug; dated 2026-10-09.

## D-26 The MySQL driver decodes text itself, per column, from raw bytes

**Decided:** The MySQL driver sets `character_set_results = NULL` on its session and reads every cell as raw bytes, then decodes each cell in the charset the server reports for that column. It does not use the client library's type casting.
**Why:** mysql2's own casting makes the server transcode every result to the connection charset first. For the classic WordPress case of utf8 bytes stored in a latin1 column, that transcoding step is exactly where the data gets mangled beyond recovery. Decoding per column yields honest mojibake that the charset tools in Phase 2 can reinterpret, and bytes that cannot be decoded in the declared charset stay bytes with a hint.
**Verified:** against MySQL 5.7, 8.0, 8.4, MariaDB 10.6, 10.11, 11.4 and Percona 8.0 with a fixture that contains the latin1-holding-utf8 column and invalid UTF-8 in a VARBINARY.
**Owner:** the driver agent proposed it during implementation; Claude accepted; dated 2026-10-09.

## D-27 Grid edits are staged, shown, previewed, and committed in one transaction

**Decided:** Editing a cell, deleting a row or adding a row never touches the database. Changes are staged on top of the loaded rows and drawn distinctly (edited cells, struck-through deletes, green inserts, a pending counter). Commit builds the statements through the driver's dialect, shows them in a confirmation, and runs them in a single transaction; any failure rolls everything back and keeps the staged changes. Rows are matched on the primary key, else a unique index, else every column with a warning in the confirmation. Refreshing with pending changes asks first.
**Why:** Principle 3 in GOAL.md: destructive work is visible and confirmed. A transaction means a typo in the third change cannot leave the first two applied. Showing the SQL teaches and lets the user catch a bad WHERE before it runs.
**Navigation:** Tab stages the cell and moves to the next editable cell, wrapping to the next row; Shift+Tab goes back. Enter stages and closes, Escape cancels.
**Not yet:** binary and bit cells are read-only in the grid; multi-cell paste; editing query results rather than tables.
**Owner:** Remon asked for staged changes with a commit button; Claude shaped the mechanism; dated 2026-10-09.

## D-28 The LocalWP add-on ships inside RaSQL and is installed by a button

**Decided:** `packages/localwp-addon` is built into a plain folder and shipped as an extra resource of the app. When RaSQL finds Local's data directory, the launcher lists Local's sites directly from `sites.json` and offers to install, update or remove the add-on. Install copies the folder into Local's `addons/` directory and merges the enable flag into `enabled-addons.json`; it never symlinks, and it never relaunches Local. The user is told to restart Local.
**Why:** Local's Add-ons screen only lists its marketplace, so every third-party add-on is a folder copy anyway, and RaSQL can do that more reliably than instructions can. Local keeps its data where Electron keeps app data on each OS, so one lookup finds it on macOS, Windows and Linux. Site discovery works without the add-on; the add-on only adds the button inside Local's own UI, in the Connect row next to "Open AdminNeo" via the `SiteInfoDatabase_TableList_TableListRow[Connect]:Before` hook.
**Found along the way:** Local 10 has no Sequel Pro or TablePlus integration left, so there is nothing for RaSQL to impersonate; the `.spf` file association remains the useful inheritance.
**Owner:** Remon asked for a bundled add-on with a restart message; Claude shaped the mechanism; dated 2026-10-09.

## D-29 Query editor, filters and export, as built

**Query editor:** CodeMirror 6 with the SQL dialect matched to the engine, highlighting driven by the app's CSS variables so light and dark follow the OS, and a run that executes the selection or else the statement under the cursor. Autocomplete offers keywords, the current schema's tables and views, and columns after `table.`, loaded lazily and cached. History is per connection, deduplicated, capped at 500, and never stores results. EXPLAIN renders in a pane under the editor. Cmd+Shift+H toggles history because Cmd+H is macOS Hide.
**Filters and sorting:** typed column filters built through the dialect, so values are quoted by the driver and never concatenated in the renderer; a raw WHERE field is appended with AND and parenthesised. Sorting is a header click cycling ascending, descending, none. Row counts are on demand because COUNT(*) is a full scan on InnoDB.
**Export:** the statement is re-run and streamed from the driver to the file with backpressure, so the on-screen page and its row cap play no part. CSV follows RFC 4180, JSON writes safe integers as numbers and everything wider as strings, SQL uses the dialect's multi-row INSERT in batches of 500. A cancelled or failed export leaves no partial file.
**Owner:** Remon chose the three items; two agents and Claude built them; dated 2026-10-09.

## D-30 On Windows, RaSQL installs from the zip package, not from the NSIS installer

**Decided:** `scripts/install-windows.ps1` builds the zip target, extracts it into
`%LOCALAPPDATA%\Programs\RaSQL`, and registers the URL schemes, file types, a Start Menu shortcut
and an uninstall entry itself, all under the current user. The NSIS installer is still built by CI
for x64 downloads.
**Why:** On Windows on ARM the NSIS installer finishes "successfully" with every `.exe` and `.dll`
missing from the install folder, interactively and silently alike, while the unpacked build has
them all. electron-builder packs the application with 7-Zip's executable filter, which for arm64
is the ARM64 filter, and the installer's embedded extractor predates that filter; the affected
entries come out empty. A zip has no such filter, and a script that writes a handful of
`HKCU\Software\Classes` keys does everything the installer did for a per-user install.
**Verified:** on a Snapdragon Windows 11 machine, 2026-10-09.
**Owner:** Remon found it; Claude diagnosed and rerouted; dated 2026-10-09.

## D-31 A rolling nightly pre-release on every push to master

**Decided:** CI builds both CPU variants per OS and, once every check passes, recreates the
GitHub pre-release tagged `nightly` from those artifacts. Download links are stable; the tag moves
to the latest commit. Windows ARM64 ships as a zip only (D-30). Proper versioned releases remain
a separate, deliberate act.
**Why:** Remon asked for builds on every commit rather than nightly; GitHub Releases is the only
distribution channel (GOAL.md section 9), and a rolling pre-release gives testers on other machines
a build of exactly the commit they are looking at without anyone packaging by hand.
**Owner:** Remon asked; Claude shaped; dated 2026-10-09.
