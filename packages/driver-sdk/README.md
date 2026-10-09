# @rasql/driver-sdk

Everything needed to write a RaSQL database driver. MIT licensed.

```ts
import { serveDriver, electronParentPortTransport } from '@rasql/driver-sdk';
import myDriver from './my-driver';

serveDriver(myDriver, electronParentPortTransport(process.parentPort));
```

- `serveDriver(driver, transport)` runs a `Driver` behind the protocol in any process.
- `DriverClient` is the host side: it turns a transport into sessions with streaming queries.
- `createInProcessTransports()` connects a client and a server inside one process, for tests.
- `BaseDialect` implements the generic parts of `Dialect`; a driver supplies quoting and types.
- `runConformanceChecks(driver, endpoint)` is how a driver proves it works.
