# MCP

**Status: not available yet.** RaSQL does not ship an MCP (Model Context Protocol) server in
version 0.1.1. AI agents such as Claude Code or Claude Desktop cannot connect to RaSQL today. The
server is planned for Phase 2 (see [docs/GOAL.md](docs/GOAL.md)).

Checked on 2026-10-12 against `master` at version 0.1.1.

## What exists today

The design is complete, and some of the pieces the server will rely on are already built.

| Piece                                   | State   | Where                                                                      |
| --------------------------------------- | ------- | -------------------------------------------------------------------------- |
| Design and permission model             | Written | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 8, [D-08][d08]        |
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

[d08]: docs/DECISIONS.md

## What is planned

RaSQL will be an MCP server, not an MCP client. It will have no built-in chat.

### Transports

- **stdio.** `rasql mcp` relays MCP messages to the running app over its local IPC socket. This is
  the form Claude Code, Claude Desktop and most editors expect.
- **Streamable HTTP.** Bound to `127.0.0.1` and protected by a per-install token from the app's
  settings, for clients that cannot start a process.

### Permissions

- An agent sees no connections until the user grants one in the app.
- A grant is per client and per connection, with a level of `read` or `write` and a lifetime.
- Grants are made in the app only. The `request_access` tool creates a request that a person
  approves.
- Production and read-only connections can never be granted `write`.
- Reads are enforced twice: by a read-only session and by classifying every statement.
- Writes are never executed directly. They become proposals that a person approves in the app.
- Every action goes to an audit log, and credentials are never returned by any tool.

### Tools

| Tool               | Level needed |
| ------------------ | ------------ |
| `list_connections` | none         |
| `request_access`   | none         |
| `connect`          | read         |
| `list_schemas`     | read         |
| `list_tables`      | read         |
| `describe_table`   | read         |
| `sample_rows`      | read         |
| `query`            | read         |
| `explain`          | read         |
| `search_schema`    | read         |
| `propose_write`    | write        |

Each granted connection will also expose its schema as an MCP resource.

## Configuring a client, once it ships

The intended Claude Code setup is a single command. It will not work until the server exists.

```sh
claude mcp add rasql -- rasql mcp
```

This file will be updated with real setup steps when the server is released.
