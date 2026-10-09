# @rasql/driver-mysql

RaSQL driver for MySQL and everything that speaks its wire protocol: MariaDB, Percona Server,
Amazon Aurora MySQL, TiDB and Vitess/PlanetScale. Built on `mysql2`.

## How values stay typed

The driver asks the server for raw result bytes (`SET character_set_results = NULL`) and reads
every cell with `typeCast: false`, so each cell arrives exactly as stored, together with the
column's real charset in the metadata. It then converts bytes to protocol `Value`s itself:

- integers, decimals, dates, times and datetimes are kept as the exact text the server sent
  (`DATETIME(6)` keeps its microseconds, `TIME` keeps its sign and may exceed 24 hours);
- text is decoded in the **column's** charset, not the connection's. A `latin1` column that
  holds UTF-8 bytes shows up as mojibake text tagged `charset: 'latin1'`, which is the honest
  result and what lets the UI offer a reinterpretation;
- bytes that are not valid in their charset become `bytes` with a `charsetHint`;
- `BIT(n)` is `bit` with `bits: n`, `SET` is a string array, `GEOMETRY` is WKB plus SRID.

`TINYINT(1)` is an integer. MySQL has no boolean type and the driver does not invent one.

## Cancellation

A running statement is cancelled with `KILL QUERY <thread id>` over a second, short-lived
connection using the same endpoint. The interrupted query then reports `CANCELLED`.

## Testing against real engines

```bash
pnpm matrix:up                                   # every engine in test/matrix/docker-compose.yml
RASQL_TEST_MATRIX=1 pnpm vitest run --project driver-mysql
RASQL_MYSQL_DSN=mysql://user:pass@host:3306/db pnpm vitest run --project driver-mysql
```

Engines whose port does not answer are skipped and listed, not failed.
