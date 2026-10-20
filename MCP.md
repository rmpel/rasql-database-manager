# MCP

**Status: available since version 0.2.0.** RaSQL is an MCP (Model Context Protocol) server. AI
agents such as Claude Code and Claude Desktop reach the connections the user opens up for them. It
was planned for 0.3.0 and shipped early.

Tested on macOS. On Windows and Linux it is built but has not run yet; testers are wanted, see the
note under Secure in section 5 and report in
[GitHub issues](https://github.com/rmpel/rasql-database-manager/issues/new?title=MCP%20on%20Windows%2FLinux).

## Setting up a client

1. In RaSQL, open a connection's form and set **Agents (MCP)** to Read-only, Ask, Secure or Read/Write. Every
   connection starts Hidden, so agents see nothing until you do this. Fill in the database: agents
   see no data on a connection without one.
2. Add RaSQL to the client. **File › MCP Server…** in RaSQL shows the exact command for this
   install, with a Copy button. For Claude Code on macOS:

   ```sh
   claude mcp add rasql -- /Applications/RaSQL.app/Contents/MacOS/RaSQL mcp
   ```

   On Linux the command is `rasql mcp`, on Windows the path to `RaSQL.exe` followed by `mcp`.
   Clients that take a JSON configuration, such as Claude Desktop, get the same command as
   `command` and `args`; the MCP window shows that snippet too.

3. The first time the client connects, RaSQL asks whether to allow it. Allow it once; RaSQL
   remembers the decision until you revoke it.

`rasql mcp` starts RaSQL when it is not running, so the client can be started first.

**HTTP.** Clients that cannot start a command can use Streamable HTTP. Turn it on in the MCP window.
It listens on `http://127.0.0.1:47334/mcp` (the port can be changed) and every request needs the
token shown there, sent as `Authorization: Bearer <token>`. The token is kept in the keychain.

## What exists

| Piece                                   | Where                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Tools, permission rules, change sorting | `packages/mcp/` (`core.ts`, `changes.ts`, `scope.ts`, `types.ts`)           |
| `rasql mcp` stdio bridge                | `runBridge` in `packages/mcp/src/transports.ts`, started from the app entry |
| Local socket and HTTP transports        | `packages/mcp/src/transports.ts`                                            |
| Agent sessions, prompts, audit log      | `packages/app/src/main/mcp/`                                                |
| MCP setting in the connection form      | `packages/app/src/renderer/src/components/ConnectionForm.tsx`               |
| Prompts and the MCP window              | `McpPrompt.tsx` and `McpWindow.tsx` in the renderer                         |
| Tests                                   | `packages/mcp/src/*.test.ts`, `packages/app/e2e/mcp.spec.ts`                |

## Feature outline

RaSQL is an MCP server, not an MCP client. It has no built-in chat. This outline is the detailed
version of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 8 and decisions D-40 and D-42 in
[docs/DECISIONS.md](docs/DECISIONS.md).

### 1. Access, set by the user per connection

The user decides in RaSQL how much an agent may do. An agent can never change this setting.

**The connection's own setting comes first.** A connection marked read-only in the connection form
cannot write for anyone, so an agent on it can only read. Production databases would normally be set
up this way.

**Every connection has an MCP setting,** a dropdown in the connection form:

| MCP setting | What the agent can do                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Hidden      | Nothing. The connection does not exist for agents. This is the default.                        |
| Read-only   | Read. Write attempts are refused at once, and the user sees no prompt.                         |
| Ask         | Read, and write after the user allows it in a prompt. See section 5.                           |
| Secure      | Like Ask, but approving needs the OS to confirm the user (Touch ID, Windows Hello, password).  |
| Read/Write  | Read and write without a prompt, except for destructive changes, which always ask (section 6). |

How it combines with the connection's own read-only setting:

| Connection setting | MCP settings offered                       | What the agent can do at most |
| ------------------ | ------------------------------------------ | ----------------------------- |
| Read-only          | Hidden, Read-only                          | Read                          |
| Read-write         | Hidden, Read-only, Ask, Secure, Read/Write | Read and write                |

- **One setting per connection.** Every agent the user has approved shares it. A new agent must still
  be approved in RaSQL on first contact before it sees anything. An agent is known by the name its
  client announces, such as `claude-code`.
- **Hidden by default.** A connection the user creates starts Hidden, so agents see nothing until
  the user opts in. A connection created by an agent starts at Ask (section 2).
- **One database per connection.** An agent may only use the database named in the connection. A
  connection with an empty database field can reach every database the login allows, so agents see
  no data on it until a database is filled in. Statements that name another database, such as
  `other_db.users`, are refused. LocalWP gives each site its own server, so there the rule never gets
  in the way.

**LocalWP sites.** Local's sites are not stored connections: RaSQL reads them from Local's own
registry every time. Each site row in the connection manager has a ⚙ that sets its MCP setting,
with the same five choices, and the MCP window has one **Default for LocalWP sites**, Hidden unless
changed, that applies to every site without a setting of its own. RaSQL keeps only the site's id
and the setting; socket, port, database and the `root` login come fresh from Local, so a site
Local moves never goes stale. Agents see a site as `localwp:<site id>`, named as in Local. A
stopped site answers "start it in Local". Agents cannot rename a Local site.

### 2. Managing stored connections

The user can ask an agent to set up connections, for example "add a connection to this server with
these credentials". The agent never reads secrets back, and it can never raise its own access.

- **List connections.** Only connections that are not Hidden. Names, groups, favorites, driver,
  environment and settings. Never passwords or SSH secrets.
- **Create a connection.** The agent can supply everything, including a password. The password goes
  straight into the keychain and can never be read back over MCP. RaSQL asks the user with one
  click, for example "Claude Code wants to add the connection shop-staging". A connection created by
  an agent starts with the MCP setting Ask.
- **Change a connection's details.** Name, group, favorite and color.
- **Never over MCP.** Reading any password, deleting a connection, and changing the read-only or MCP
  setting. Changing where a connection points is refused too: its host, port, socket, user, SSH
  settings or database name. A new host would receive the stored password, and a new database would get around the one-database rule. The
  agent can create a new connection instead.

### 3. Exploring structure

Available from Read upward.

- List databases, tables and views, with row estimates and comments.
- Describe a table: columns, indexes, foreign keys and its `CREATE` statement.
- Search table and column names across a database.
- Read the definitions of views, routines, triggers and events.
- On PostgreSQL and SQL Server, every schema inside the connection's database is available.
- Each allowed database is also offered as an MCP resource, so an agent can load its schema without
  a tool call.

### 4. Reading data

Available from Read upward.

- Run a query that only reads, with a row limit the user sets.
- Sample the first rows of a table.
- Show the execution plan of a query.
- Values come back typed, the same way the data grid shows them, including NULL and binary data.

### 5. Changing data and structure

The agent prepares changes as a change set: one or more statements, sent together. With the MCP
setting Ask, nothing is committed until the user allows it. A prompt appears in front of the
connection's window:

> **Claude Code** is attempting to commit database changes to `shop_dev`.
> 3 statements, about 120 rows affected, on a table of 2.4 million rows.
>
> [Once] [This session] [Always] [Deny] [Review…]

What each choice does:

- **Once** commits this change set only. The next one asks again.
- **This session** commits it and allows further non-destructive changes on this connection until
  RaSQL quits. Destructive changes still ask (section 6).
- **Always** commits it and switches the connection's MCP setting from Ask to Read/Write, so the
  question is not asked again. The user can switch it back in the connection form.
- **Deny** rejects the change set. The user can add a short note that goes back to the agent, so it
  can try again.
- **Review…** opens the full change set before deciding. Each change shows its SQL, the execution
  plan and the estimated rows it affects. Row edits show before and after values in a grid.
  Structure changes use the structure editor's ALTER preview.

Further rules:

- **Large tables are visible.** The prompt shows the size of the tables a change touches, because
  even a safe change can lock a big table for minutes.
- **No answer means no.** A prompt that is not answered within 5 minutes expires as Deny. Closing
  the prompt window is a Deny too.
- **One transaction where possible.** A commit runs the whole change set in one transaction where
  the engine allows it. If a statement fails, the agent gets the error and nothing is kept. MySQL
  commits most structure changes immediately, so a change set that mixes data and structure changes
  cannot be undone as one. The prompt and the review say so when that applies.
- **The agent learns the outcome.** It gets the result when the commit runs, or the denial with the
  user's note. `commit_changes` waits up to two minutes for the answer; after that the agent asks
  `change_status`.
- **Statements agents never run.** Transaction control (the change set is the transaction), `USE`,
  `ATTACH`, statements that read or write files (`LOAD DATA`, `INTO OUTFILE`, `COPY`), and functions
  that sleep, read files or reach other sessions, such as `LOAD_FILE()` or `pg_sleep()`.

**Secure.** A prompt approved with a click can also be approved by any program that drives the
mouse, such as another agent using computer use. On a Secure connection every change set prompts,
safe or not, and the prompt offers only Deny, Review and **Approve with …**, naming how this
computer confirms you. RaSQL asks the operating system itself; the prompt window cannot answer on
its own. There is no This session or Always, because either would skip the check for later
changes.

| Platform | How RaSQL confirms you                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| macOS    | Touch ID or Apple Watch, with your account password as fallback (LocalAuthentication)    |
| Windows  | Windows Hello (PIN, face or fingerprint); your Windows password when Hello is not set up |
| Linux    | polkit through the desktop's agent (password, or fingerprint where fprintd is set up)    |

On Linux, RaSQL's polkit action asks you to confirm yourself every time. It needs the policy file
`packages/app/build/linux/nl.remonpel.rasql.policy` in `/usr/share/polkit-1/actions/`. Without it,
RaSQL uses `pkexec` instead, which asks for an administrator password. Where none of these exist,
Secure cannot be chosen, and a Secure connection's changes can only be denied.

> **Untested on Windows and Linux; testers wanted.** The macOS check is tested on real hardware.
> The Windows and Linux checks are built but have never run on those systems. If you can try
> them, set a test connection to Secure, let an agent submit a change, and report the result, good
> or bad, in a
> [GitHub issue](https://github.com/rmpel/rasql-database-manager/issues/new?title=MCP%20on%20Windows%2FLinux):
> your OS and version, whether Windows Hello or a fingerprint reader is set up, which dialog
> appeared, and whether approving and cancelling behaved as described above.

### 6. What counts as destructive

A change is destructive when it can lose data. RaSQL sorts every statement in a change set into one
of three groups, then treats the change set by its worst statement.

**Safe by its shape.** Nothing can be lost, whatever the data is.

- `INSERT`, `CREATE TABLE`, `CREATE INDEX`, `CREATE VIEW`, and adding a column that is nullable or
  has a default.
- Adding or dropping an index or a constraint, renaming, and changing a default or a comment.
- Widening a column: `INT` to `BIGINT`, `VARCHAR(50)` to `VARCHAR(255)`, `FLOAT` to `DOUBLE`,
  `TEXT` to `MEDIUMTEXT`, or `NOT NULL` to `NULL`.
- `UPDATE` with a `WHERE` clause. It overwrites values, but only the ones the agent targeted.

**Safe only if the data fits.** Narrowing a column, such as `INT` to `TINYINT`, `VARCHAR(255)` to
`VARCHAR(50)`, signed to unsigned, `NULL` to `NOT NULL`, or a change of character set. RaSQL checks
the actual data first with a read query:

- Numbers: the lowest and highest value must fit the new type.
- Text: the longest value must fit the new length.
- `NOT NULL`: no row may hold `NULL`.
- Character set: every value must convert without loss.

If the data fits, the change counts as safe. The ALTER then runs with MySQL's strict mode on, so the
server refuses it instead of cutting values if the data changed after the check.

**Destructive.** Always asks, even under This session or the Read/Write setting.

- `DROP` of a table, column, view or database, and `TRUNCATE`.
- `DELETE`, `REPLACE`, `MERGE`, and `UPDATE` without a `WHERE` clause.
- `CREATE OR REPLACE`, and adding a `NOT NULL` column without a default.
- A narrowing change whose data does not fit.
- Anything RaSQL cannot classify with confidence.

With this, "change all INT columns to BIGINT" runs under This session without asking. "Change this
INT column to TINYINT" runs only if every value lies between -128 and 127, and asks otherwise.

### 7. Visibility and control

- An indicator in each connection window shows when an agent is active on that connection.
- A notification appears when an agent asks for access or wants to commit, if RaSQL is in the
  background.
- An audit log lists every agent action per agent and per connection. It includes refused actions,
  and commits that ran without a prompt. It is in the MCP window.
- One click revokes all access for an agent, or for all agents. A revoked agent is disconnected and
  asked about again on its next contact.
- A row limit, 500 by default, caps what a read returns. It is set in the MCP window.

### 8. Transports

- **stdio.** `rasql mcp` relays MCP messages to the running app over its local IPC socket. This is
  the form Claude Code, Claude Desktop and most editors expect.
- **Streamable HTTP.** Bound to `127.0.0.1` and protected by a per-install token from the app's
  settings, for clients that cannot start a process.

### Tools

| Tool                | Level needed | Purpose                                              |
| ------------------- | ------------ | ---------------------------------------------------- |
| `list_connections`  | none         | Connections this agent may see, without secrets      |
| `create_connection` | none         | Add a connection; any password goes to the keychain  |
| `update_connection` | none         | Change name, group, favorite or color                |
| `list_databases`    | read         | Databases the agent may see on a connection          |
| `list_tables`       | read         | Tables and views with row estimates                  |
| `describe_table`    | read         | Columns, indexes, foreign keys and DDL               |
| `describe_object`   | read         | Definition of a view, routine, trigger or event      |
| `search_schema`     | read         | Find tables and columns by name                      |
| `sample_rows`       | read         | First rows of a table, with a hard cap               |
| `query`             | read         | Run a statement that only reads                      |
| `explain`           | read         | Execution plan of a statement                        |
| `commit_changes`    | write        | Submit a change set; it runs once the user allows it |
| `change_status`     | write        | Outcome of a change set, with the user's note        |

## Decisions

Recorded as D-40 in [docs/DECISIONS.md](docs/DECISIONS.md), which amends D-08. Choices made while
building it are D-42.

- **Access is one MCP setting per connection:** Hidden, Read-only, Ask, Secure or Read/Write. Hidden is the
  default. Always in the prompt switches Ask to Read/Write.
- **Production is protected by the connection's read-only setting,** not by a separate MCP rule.
- **Destructive changes always ask,** even under This session or Read/Write. Section 6 defines
  destructive.
- **An agent works in the connection's database only.**
- **Agents can create connections, including the password,** after a one-click confirmation.
  Passwords readable by an agent are almost always local development defaults, so no special
  handling is needed. Agents cannot change where an existing connection points.
- **Mixed change sets are flagged.** The prompt warns when data and structure changes cannot be
  undone together.

## Limits

- **SQLite.** SQLite barely enforces column types, and RaSQL cannot rebuild SQLite tables yet. The
  rules in section 6 are written for MySQL and MariaDB, and SQLite structure changes always ask.
- **PostgreSQL and SQL Server.** Column type changes use the same widening rules, mapped onto their
  type names. A PostgreSQL `ALTER COLUMN … USING` always asks.
- **Estimates.** Rows affected are counted for single-table `UPDATE` and `DELETE` and for `INSERT …
VALUES`. Other statements show no estimate.
- **Client identity.** RaSQL tells agents apart by the name their client announces. Any program
  running as the user could announce the same name; the socket is the user's own, and that is the
  boundary (D-42).
