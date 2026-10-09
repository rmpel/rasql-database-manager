# @rasql/driver-protocol

The types and wire protocol that every RaSQL database driver speaks. MIT licensed so a driver may carry any license.

- `Value`: the typed cell model. Values stay typed from driver to grid; nothing here renders to a string.
- `Driver` and `Session`: what a driver implements.
- `Dialect`: how the core asks a driver to build SQL for edits and structure changes.
- `HostMessage` and `DriverMessage`: the messages exchanged between the RaSQL core and a driver process.

See `docs/ARCHITECTURE.md` in the RaSQL repository for the reasoning.
