# RaSQL: Architecture

Last revised 2026-10-08. This describes the shape of the system before any of it exists. Sketches in TypeScript are illustrations of intent, not final APIs. Where this document and GOAL.md disagree, GOAL.md wins.

## 1. Stack

| Concern                | Choice                                                                        | Why                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shell                  | Electron                                                                      | Identical rendering on every OS; one language for app, drivers, LocalWP add-on and MCP server; largest contributor pool |
| Language               | TypeScript, strict mode, everywhere                                           | See above                                                                                                               |
| UI                     | React                                                                         | House style; mature ecosystem for grids and editors                                                                     |
| Styling                | SCSS modules, system fonts, native light and dark mode                        | No design system dependency                                                                                             |
| Data grid              | Decided by a Phase 0 spike (canvas-based candidates first)                    | The grid is the single most important widget; it must handle a million rows                                             |
| Query editor           | CodeMirror 6                                                                  | Lighter than Monaco, better suited to custom SQL completion                                                             |
| MySQL driver           | mysql2                                                                        | Typed values, Buffers for binary, charset-aware, streaming, mature                                                      |
| SQLite driver          | better-sqlite3                                                                | Synchronous, fast, well maintained                                                                                      |
| MSSQL driver (Phase 3) | tedious                                                                       | The standard pure-JS option                                                                                             |
| SSH                    | ssh2                                                                          | Pure JS, agent, keys, jump hosts; no shelling out to the system binary                                                  |
| Secrets                | Electron safeStorage plus OS keychain via a native keyring binding            | Encrypted at rest, OS-managed                                                                                           |
| Packaging              | electron-builder                                                              | Produces dmg, zip, nsis, deb, AppImage from one config                                                                  |
| Tests                  | Vitest for units, Playwright for the UI, Docker Compose for the engine matrix |                                                                                                                         |

Tauri with Rust was the runner-up. It lost on webview inconsistency across OSes, on the smaller contributor pool, and because dynamic driver plugins are awkward in a compiled core.

## 2. Process model

```
┌────────────────────────── Electron main process ──────────────────────────┐
│  Connection registry   Credential providers   SSH tunnel manager          │
│  Driver host           Deep-link / CLI / file-open handler                │
│  MCP server (stdio bridge + local HTTP)        Update checker             │
└──────────┬──────────────────────┬──────────────────────┬──────────────────┘
           │ MessagePort          │ MessagePort          │ MessagePort
   ┌───────┴────────┐    ┌────────┴───────┐     ┌────────┴────────┐
   │ Driver process │    │ Driver process │     │ Renderer window │
   │ (mysql, conn A)│    │ (sqlite, file) │     │ (connection A)  │
   └────────────────┘    └────────────────┘     └─────────────────┘
```

- **One driver process per open connection**, implemented as an Electron utility process. A crashing driver takes down one connection, not the app. Drivers never touch the renderer directly.
- **One renderer window per connection.** Tabs inside the window hold tables, queries, structure views and panels. A connection is a self-contained unit, so a future single-window mode with a vertical connection sidebar is a layout change, not an architecture change.
- **The main process is the broker.** It owns connection definitions, resolves credentials, opens SSH tunnels, spawns drivers, and routes messages. It is the only process that ever holds a password in memory, and only for the duration of a connect.
- **Renderers are sandboxed.** No Node integration; everything goes through a typed IPC bridge exposed via contextBridge.
- **SSH lives in the core, not in drivers.** A driver only ever sees a TCP endpoint, a socket path or a file. The tunnel manager turns "host behind SSH" into "localhost:random-port" before the driver is involved.

## 3. The driver protocol

The core speaks to a driver over a message protocol with request/response and streaming. The protocol is defined in the `@rasql/driver-protocol` package as TypeScript types plus a JSON Schema export. The `@rasql/driver-sdk` package wraps it in a convenient base class for TypeScript drivers.

The protocol is the contract. The in-process convenience is incidental. An out-of-process driver in Go or Rust that speaks the same messages over stdio is a Phase 3 possibility that needs no redesign.

### 3.1 Manifest

```ts
interface DriverManifest {
  id: string; // "mysql", "sqlite", "mssql"
  name: string; // "MySQL and MariaDB"
  version: string; // semver of the driver package
  protocolVersion: 1;
  engines: EngineDescriptor[]; // flavors the driver can detect and adapt to
  transports: Array<'tcp' | 'socket' | 'file'>;
  defaultPort?: number;
  capabilities: Capabilities;
  connectionForm: FormSchema; // declarative: the core renders the connect dialog from this
}

interface EngineDescriptor {
  id: string; // "mysql", "mariadb", "percona", "aurora-mysql", "tidb", "vitess"
  name: string;
  detect: 'version-string' | 'query';
}

interface Capabilities {
  multipleSchemas: boolean; // databases/schemas per connection
  transactions: boolean;
  explain: boolean;
  cancel: boolean;
  readOnlySession: boolean; // can the session itself be made read-only
  objects: Array<'table' | 'view' | 'routine' | 'trigger' | 'event' | 'sequence'>;
  alterTable: boolean;
  users: boolean;
}
```

The declarative connection form is what lets the core render a connect dialog for a driver it has never seen. The core adds the SSH and color/environment sections itself; they are the same for every driver.

### 3.2 Session interface

```ts
interface Driver {
  manifest(): DriverManifest;
  connect(endpoint: ResolvedEndpoint, signal: AbortSignal): Promise<Session>;
}

interface ResolvedEndpoint {
  transport: 'tcp' | 'socket' | 'file';
  host?: string;
  port?: number; // already the tunnel's local end if SSH is involved
  socketPath?: string;
  filePath?: string;
  user?: string;
  password?: string;
  database?: string;
  tls?: TlsOptions;
  options: Record<string, unknown>; // driver-specific, from the connection form
}

interface Session {
  info(): Promise<ServerInfo>; // engine, version, charset, timezone, readOnly
  listSchemas(): Promise<SchemaInfo[]>;
  listObjects(schema: string): Promise<DbObject[]>;
  describeTable(schema: string, table: string): Promise<TableDefinition>; // columns, indexes, FKs, options, DDL
  query(sql: string, opts?: QueryOptions): AsyncIterable<QueryEvent>; // see 3.3
  explain(sql: string): Promise<ExplainResult>;
  setReadOnly(on: boolean): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  dialect: Dialect;
  close(): Promise<void>;
}
```

### 3.3 Streaming query events

A query never returns an array. It streams, so a hundred-million-row table does not need to fit in memory and a long query can be cancelled.

```ts
type QueryEvent =
  | { kind: 'columns'; columns: ColumnMeta[] }
  | { kind: 'rows'; rows: Value[][] } // batched, a few hundred per message
  | {
      kind: 'done';
      affectedRows?: number;
      insertId?: string;
      elapsedMs: number;
      warnings: Warning[];
    }
  | { kind: 'error'; code: string; message: string; position?: number };

interface ColumnMeta {
  name: string;
  nativeType: string; // "VARCHAR(255)", "BIGINT UNSIGNED", "JSON"
  valueType: Value['t']; // what the driver will put in cells
  nullable: boolean;
  charset?: string; // per column, because MySQL allows it
  table?: string;
  schema?: string;
  isPrimaryKey: boolean;
  foreignKey?: { schema: string; table: string; column: string };
}
```

### 3.4 Dialect

The core builds SQL for grid edits and structure changes, but the dialect object decides the words.

```ts
interface Dialect {
  quoteIdentifier(name: string): string;
  quoteLiteral(v: Value): string;
  paginate(sql: string, limit: number, offset: number): string;
  keywords: string[]; // for highlighting and completion
  types: TypeDescriptor[]; // for the structure editor
  buildUpdate(table: TableRef, set: CellChange[], where: KeyMatch): string;
  buildInsert(table: TableRef, row: CellChange[]): string;
  buildDelete(table: TableRef, where: KeyMatch): string;
  buildAlter?(table: TableDefinition, changes: StructureChange[]): string[];
  classify(sql: string): 'read' | 'write' | 'ddl' | 'admin' | 'unknown'; // used by the MCP permission layer
}
```

## 4. The value model

Principle 4 in GOAL.md made concrete. A cell is a tagged value and stays one until a renderer draws it.

```ts
type Value =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'int'; v: string } // string on the wire so 64-bit values survive
  | { t: 'decimal'; v: string }
  | { t: 'float'; v: number }
  | { t: 'text'; v: string; charset?: string }
  | { t: 'bytes'; v: Uint8Array; charsetHint?: string } // BLOB, BINARY, and text the driver could not decode
  | { t: 'date'; v: string } // ISO 8601 date
  | { t: 'time'; v: string } // HH:MM:SS[.ffffff], may be negative or over 24h in MySQL
  | { t: 'datetime'; v: string; zone?: string } // ISO 8601, fractional seconds preserved
  | { t: 'json'; v: string } // raw text, parsed lazily by the renderer
  | { t: 'bit'; v: Uint8Array; bits: number }
  | { t: 'enum'; v: string }
  | { t: 'set'; v: string[] }
  | { t: 'geometry'; v: Uint8Array; srid?: number }
  | { t: 'unknown'; v: Uint8Array; nativeType: string };
```

Rules that follow from this:

- The driver connects with `utf8mb4` and decodes text using the column charset reported by the server, not the connection charset. If decoding fails, the cell becomes `bytes` with a `charsetHint`, never a string with replacement characters.
- The grid has one renderer per `t`. Renderers are the only place a value becomes a string. The bytes renderer shows a hex preview, a length and an "interpret as" menu offering utf8, latin1, and the detected candidate.
- Numbers wider than 53 bits never pass through a JavaScript number. `int` and `decimal` are strings on the wire.
- Editing produces a `CellChange` with the old and new `Value`. The dialect serializes it. Nothing in the UI ever concatenates SQL.
- Values cross the MessagePort by structured clone. `Uint8Array` transfers without copying.

## 5. Connections and credentials

A connection definition is plain JSON stored in the app's data directory. It never contains a secret. Secrets are referenced by a credential locator.

```ts
interface ConnectionDefinition {
  id: string;
  name: string;
  group?: string;
  color?: string;
  environment: 'local' | 'development' | 'staging' | 'production' | 'other';
  readOnly: boolean;
  driver: string; // manifest id
  transport: 'tcp' | 'socket' | 'file';
  host?: string;
  port?: number;
  socketPath?: string;
  filePath?: string;
  user?: string;
  database?: string;
  tls?: TlsOptions;
  ssh?: SshHop[]; // ordered; more than one means jump hosts
  options: Record<string, unknown>;
  credentials: {
    password?: CredentialRef;
    sshPassword?: CredentialRef;
    sshKeyPassphrase?: CredentialRef;
  };
  source?: 'manual' | 'localwp' | 'project-folder' | 'deep-link' | 'import';
}

type CredentialRef =
  | { provider: 'keychain'; account: string }
  | { provider: 'prompt' } // ask every time, never store
  | { provider: '1password'; ref: string } // "op://vault/item/field", resolved through the op CLI
  | { provider: 'env'; name: string }; // for CI and scripted use
```

Credential providers are a small plug-in interface of their own: `get(ref)`, `set(ref, secret)`, `delete(ref)`, `available()`. Keychain and prompt ship in Phase 0, 1Password in Phase 2, Bitwarden if someone writes it.

The LocalWP case is handled explicitly: Local's MySQL is `root`/`root` on a socket, and the discovered connection stores that in the keychain like any other secret. Convenience does not get a special path around the rule.

## 6. SSH tunnels

- Implemented with the ssh2 library in the main process. No `/usr/bin/ssh`.
- Reads `~/.ssh/config` for Host aliases, IdentityFile, User, Port, ProxyJump. A connection may reference an alias and inherit everything.
- Authentication order: agent, explicit key with optional passphrase, password. The passphrase and password are credential refs.
- Host keys are verified against `~/.ssh/known_hosts`. An unknown host prompts the user with the fingerprint. A changed host key refuses to connect and explains why. There is no "disable checking" option.
- Each tunnel is a local listener on an ephemeral port. The driver receives `127.0.0.1:port` and does not know a tunnel exists.
- Tunnels are shared: two connections through the same hop reuse one SSH session.

## 7. One-click open

Every door at once, because every third-party tool picks a different one.

| Door               | Form                                                                                                                      | Notes                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL scheme         | `rasql://connect?driver=mysql&host=…&port=…&socket=…&user=…&database=…&name=…&env=local&color=…&ssh=alias`                | `socket` is required for LocalWP, which does not listen on TCP by default. A `password` parameter is accepted and goes straight to the keychain. |
| URL scheme, SQLite | `rasql://open?file=/path/to.db`                                                                                           |                                                                                                                                                  |
| Generic MySQL URL  | `mysql://user[:password]@host[:port]/database?socket=…`                                                                   | Lets LocalWP's existing TablePlus adapter and other tools work unchanged.                                                                        |
| Connection file    | `.rasql`, JSON matching `ConnectionDefinition` without the secret                                                         | Double-click opens it.                                                                                                                           |
| Sequel Pro file    | `.spf` (XML plist)                                                                                                        | Imported on open. This is the format LocalWP wrote for Sequel Pro.                                                                               |
| SQLite file        | `.sqlite`, `.sqlite3`, `.db`                                                                                              | Opens directly.                                                                                                                                  |
| CLI                | `rasql <url-or-file>` or `rasql --driver mysql --socket … --user … --database …`                                          | The CLI talks to a running instance over a local IPC socket, or starts one.                                                                      |
| Discovery          | LocalWP sites registry; project folders with `wp-config.php`, `.env`, Laravel `config/database.php`, `docker-compose.yml` | Produces suggested connections with `source` set; the user confirms before anything is stored.                                                   |

Behavior when a URL arrives without a password: the connection is created, a connect is attempted, and on authentication failure the user is prompted for the password with an offer to store it. Third parties may therefore integrate without ever handling the secret.

A password that arrives in a URL is never logged, never shown in the recent-documents list, and is removed from the URL before the URL is passed anywhere else.

### 7.1 LocalWP

Two layers, neither needs the other.

- **Discovery, no add-on required.** RaSQL reads Local's `sites.json` and `run/<site>/mysql/mysqld.sock` from Local's data directory (`app.getPath('appData')/Local` on every OS) and lists the sites in the launcher, running ones first. Clicking one connects over the socket on macOS and Linux, or Local's per-site TCP port on Windows and for stopped sites.
- **The button inside Local.** `packages/localwp-addon` adds "Open in RaSQL" to the Connect row of every site's Database tab, through Local's `SiteInfoDatabase_TableList_TableListRow[Connect]:Before` hook, and opens a `rasql://connect` URL built in Local's main process from the same data. RaSQL ships the built add-on as an extra resource and installs, updates or removes it from the launcher by copying the folder and merging the enable flag; Local is restarted by the user, never by RaSQL (D-28).

## 8. MCP server

RaSQL is an MCP server. It is not an MCP client and has no built-in chat.

### 8.1 Transports

- **stdio.** `rasql mcp` is a thin bridge: it connects to the running app over the local IPC socket and relays MCP messages. This is what Claude Code, Claude Desktop and most editors expect in their configuration.
- **Streamable HTTP on localhost.** For clients that cannot spawn a process. Bound to `127.0.0.1`, protected by a per-install token shown in the app's settings.

### 8.2 Permission model

Principle 6 in GOAL.md made concrete.

- Every MCP client authenticates with an identity: the name it announces plus a token the app issues on first contact. The user approves the first contact in the app.
- A client sees **no connections** until the user grants access. `list_connections` returns only connections granted to that client.
- A grant is per client, per connection, with a **level** and a **lifetime**:
  - level: `read` or `write`;
  - lifetime: this app session, a duration, or until revoked.
- Grants are made in the app, never over MCP. The `request_access` tool creates a pending request that appears in the app's UI; the human clicks.
- Connections flagged `production` or `readOnly` cannot be granted `write`. Grants on production connections are never "until revoked"; they expire with the session at most.
- `read` is enforced twice: the session is put in read-only mode where the engine supports it, and every statement is classified by the dialect and refused if it is not `read`.
- `write` still does not execute directly. `propose_write` returns a proposal id, the statement appears in the app with its EXPLAIN and affected-row estimate, and the human approves or rejects. The tool call blocks until then or times out.
- Every MCP action is written to an audit log visible in the app, per client, per connection.
- Credentials are never exposed over MCP under any circumstance. There is no tool that returns them.

### 8.3 Tools

| Tool               | Level needed | Returns                                                                                                            |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `list_connections` | none         | Names, drivers, environments and granted levels of connections this client may see. Never hosts, users or secrets. |
| `request_access`   | none         | Creates a pending request `{ connection, level, lifetime }`; returns the request id and status.                    |
| `connect`          | read         | Opens the session if not open; returns engine and version.                                                         |
| `list_schemas`     | read         |                                                                                                                    |
| `list_tables`      | read         | Tables and views with row estimates and comments.                                                                  |
| `describe_table`   | read         | Columns, indexes, foreign keys, DDL.                                                                               |
| `sample_rows`      | read         | First N rows, typed, with a hard cap.                                                                              |
| `query`            | read         | Runs a statement classified `read`; streams up to a configurable row cap; refuses anything else.                   |
| `explain`          | read         | Execution plan.                                                                                                    |
| `propose_write`    | write        | Submits a statement for human approval; returns the proposal id, then the outcome.                                 |
| `search_schema`    | read         | Finds tables and columns by name across the connection.                                                            |

Resources: each granted connection exposes its schema as an MCP resource so clients can pull it into context without a tool call.

## 9. Security model, summarized

- Renderers are sandboxed with no Node access; the IPC bridge is typed and allow-listed.
- Secrets exist in main-process memory only during connect, and in the keychain at rest.
- Drivers are isolated processes; a malicious or buggy driver cannot read another connection's data or the keychain.
- Third-party drivers are installed explicitly by the user from a file or a URL, with the manifest shown before installation. There is no automatic driver marketplace.
- Host keys are verified. TLS certificates are verified by default, with an explicit per-connection override that is shown in the connection's color bar.
- The MCP surface is deny-by-default, human-in-the-loop for writes, and audited.
- Crash reports, if ever added, are opt-in and scrub connection details.

## 10. Testing

- **Engine matrix** in Docker Compose: MySQL 5.7, 8.0, 8.4; MariaDB 10.6, 10.11, 11.x; a Percona image; SQLite is in-process. Each driver has a conformance suite that runs against every engine it claims to support. The suite includes a fixture database with every column type, NULLs, empty strings, zero dates, negative TIME values, 64-bit integers, emoji in utf8mb4, utf8 bytes in a latin1 column, a 20 MB BLOB, invalid UTF-8, JSON, and a table with a million rows.
- **Protocol conformance** is a test that any driver, in any language, can be pointed at. It is how an external developer proves their driver works.
- **UI** tests with Playwright against the SQLite driver so they need no containers.
- **Units** with Vitest for dialects, value rendering, URL parsing, `.spf` import, SSH config parsing.
- Nothing ships to a release branch with a red matrix.

## 11. Repository layout, intended

```
packages/
  driver-protocol/    types + JSON schema, MIT
  driver-sdk/         base classes, test harness, MIT
  driver-mysql/       MySQL and MariaDB driver, GPL
  driver-sqlite/      SQLite driver, GPL
  app/                Electron main, renderer, preload, GPL
  mcp/                MCP server and stdio bridge, GPL
  cli/                command-line entry point, GPL
  localwp-addon/      Local add-on, GPL
docs/
```

A single pnpm workspace. Drivers are ordinary workspace packages so a third-party driver is "the same thing, outside the repo".
