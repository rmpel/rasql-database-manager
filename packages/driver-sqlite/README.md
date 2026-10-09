# @rasql/driver-sqlite

RaSQL driver for SQLite, built on Node's built-in `node:sqlite`. No native module, no rebuild for Electron.

Cancellation is cooperative: a running statement is checked between row batches, so a single
slow step cannot be interrupted, but a large result set can be abandoned early.
