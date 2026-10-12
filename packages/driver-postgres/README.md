# @rasql/driver-postgres

RaSQL driver for PostgreSQL 12 and later, built on `pg` and `pg-cursor`.

## How values stay typed

Every type parser of the connection is the identity, so each cell is the exact text the server
printed and the driver types it by OID: integers and `numeric` stay strings, `bytea` is bytes
(hex output is set on connect), timestamps keep their microseconds and offset, `Infinity`, `NaN`
and `infinity` survive, enums are enums, domains follow their base type. Arrays, ranges,
intervals, network and geometric types are shown as PostgreSQL prints them.

## Scripts, streaming and cancel

A script is split into statements by the driver (dollar quotes, `E''` strings, nested block
comments), and each statement streams through a cursor, so a huge result never sits in memory.
Errors carry the SQLSTATE and a position in the whole script. Cancel sends `pg_cancel_backend`
from a second connection, only while a statement is running.

## Testing against real servers

```bash
pnpm matrix:up
RASQL_TEST_MATRIX=1 pnpm vitest run --project driver-postgres
RASQL_POSTGRES_DSN=postgres://user:pass@host:5432/db pnpm vitest run --project driver-postgres
```
