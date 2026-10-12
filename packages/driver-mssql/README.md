# @rasql/driver-mssql

RaSQL driver for Microsoft SQL Server 2016 and later, Azure SQL Database and Azure SQL Managed
Instance, built on `tedious`.

## Values

Dates are read in UTC, so wall-clock values come back unchanged; `datetime2` and `time` keep
their 100 ns digits. `datetimeoffset` is shown as the UTC moment with `+00:00`, because tedious
does not pass the original offset on. `DECIMAL` and `MONEY` arrive as JavaScript numbers (exact
up to 15 significant digits) and are printed at the column's scale. Text literals are always
written as `N'…'`.

## Batches, read-only and structure changes

GO lines split a script into batches, `GO 3` repeats one. tedious runs one request per
connection, so calls queue. SQL Server has no read-only session: a read-only connection refuses
every batch that is not a plain `SELECT` or `WITH … SELECT`. Dropping or retyping a column first
removes its default constraint, then puts the default back.

## Testing against real servers

```bash
pnpm matrix:up        # SQL Server 2019, 2022 and 2025; amd64 images, emulated on Apple Silicon
RASQL_TEST_MATRIX=1 pnpm vitest run --project driver-mssql
RASQL_MSSQL_DSN=mssql://user:pass@host:1433/db pnpm vitest run --project driver-mssql
```
