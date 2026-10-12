# MCP

**Status: not available yet.** RaSQL does not ship an MCP (Model Context Protocol) server in
version 0.1.1. AI agents such as Claude Code or Claude Desktop cannot connect to RaSQL today. The
server is planned for version 0.3.0, part of Phase 2 (see [docs/GOAL.md](docs/GOAL.md)).

Checked on 2026-10-12 against `master` at version 0.1.1.

## What exists today

The design is complete, and some of the pieces the server will rely on are already built.

| Piece                                   | State   | Where                                                                      |
| --------------------------------------- | ------- | -------------------------------------------------------------------------- |
| Design and permission model             | Written | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 8, D-08               |
| Statement classification per dialect    | Built   | `classify()` in `packages/driver-protocol/src/dialect.ts`                  |
| Read-only sessions in both drivers      | Built   | `readOnlySession` in the MySQL and SQLite driver manifests                 |
| Environment flag, including production  | Built   | `environment` on a connection in `packages/app/src/shared/api.ts`          |
| Read-only flag per connection           | Built   | `readOnly` on a connection, honored in `packages/app/src/main/sessions.ts` |
| Credentials kept out of the renderer    | Built   | Keychain in `packages/app/src/main/credentials.ts`                         |
| MCP server package (`packages/mcp/`)    | Missing |                                                                            |
| `rasql mcp` stdio bridge and CLI        | Missing | No `packages/cli/` and no command-line `mcp` mode                          |
| Localhost HTTP transport                | Missing |                                                                            |
| Client identities, grants, approvals UI | Missing |                                                                            |
| Write proposals approved in the app     | Missing |                                                                            |
| Audit log                               | Missing |                                                                            |
| MCP SDK dependency                      | Missing | No `@modelcontextprotocol/*` package in any `package.json`                 |

## Feature outline

RaSQL will be an MCP server, not an MCP client. It will have no built-in chat. This outline is the detailed
version of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 8 and decision D-39 in
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
| Read/Write  | Read and write without a prompt, except for destructive changes, which always ask (section 6). |

How it combines with the connection's own read-only setting:

| Connection setting | MCP settings offered               | What the agent can do at most |
| ------------------ | ---------------------------------- | ----------------------------- |
| Read-only          | Hidden, Read-only                  | Read                          |
| Read-write         | Hidden, Read-only, Ask, Read/Write | Read and write                |

- **One setting per connection.** Every agent the user has approved shares it. A new agent must still
  be approved in RaSQL on first contact before it sees anything.
- **Hidden by default.** A connection the user creates starts Hidden, so agents see nothing until
  the user opts in. A connection created by an agent starts at Ask (section 2).
- **One database per connection.** An agent may only use the database named in the connection. A
  connection with an empty database field can reach every database the login allows, so agents see
  no data on it until a database is filled in. Statements that name another database, such as
  `other_db.users`, are refused. LocalWP gives each site its own server, so there the rule never gets
  in the way.

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
- **No answer means no.** A prompt that is not answered in time expires as Deny.
- **One transaction where possible.** A commit runs the whole change set in one transaction where
  the engine allows it. If a statement fails, the agent gets the error and nothing is kept. MySQL
  commits most structure changes immediately, so a change set that mixes data and structure changes
  cannot be undone as one. The prompt and the review say so when that applies.
- **The agent learns the outcome.** It gets the result when the commit runs, or the denial with the
  user's note.

### 6. What counts as destructive

A change is destructive when it can lose data. RaSQL sorts every statement in a change set into one
of three groups, then treats the change set by its worst statement.

**Safe by its shape.** Nothing can be lost, whatever the data is.

- `INSERT`, `CREATE TABLE`, `CREATE INDEX`, and adding a column that is nullable or has a default.
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
- `DELETE`, and `UPDATE` without a `WHERE` clause.
- A narrowing change whose data does not fit.
- Anything RaSQL cannot classify with confidence.

With this, "change all INT columns to BIGINT" runs under This session without asking. "Change this
INT column to TINYINT" runs only if every value lies between -128 and 127, and asks otherwise.

### 7. Visibility and control

- An indicator in each connection window shows when an agent is active on that connection.
- A notification appears when an agent asks for access or wants to commit, if RaSQL is in the
  background.
- An audit log lists every agent action per agent and per connection. It includes refused actions,
  and commits that ran without a prompt.
- One click revokes all access for an agent, or for all agents.

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
| `search_schema`     | read         | Find tables and columns by name                      |
| `sample_rows`       | read         | First rows of a table, with a hard cap               |
| `query`             | read         | Run a statement that only reads                      |
| `explain`           | read         | Execution plan of a statement                        |
| `commit_changes`    | write        | Submit a change set; it runs once the user allows it |
| `change_status`     | write        | Outcome of a change set, with the user's note        |

## Decisions

Recorded as D-39 in [docs/DECISIONS.md](docs/DECISIONS.md), which amends D-08.

- **Access is one MCP setting per connection:** Hidden, Read-only, Ask or Read/Write. Hidden is the
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

## Configuring a client, once it ships

The intended Claude Code setup is a single command. It will not work until the server exists.

```sh
claude mcp add rasql -- rasql mcp
```

This file will be updated with real setup steps when the server is released.
