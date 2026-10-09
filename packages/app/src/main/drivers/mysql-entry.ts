// Runs inside an Electron utility process. One process per open connection.
import { electronParentPortTransport, serveDriver } from '@rasql/driver-sdk';
import driver from '@rasql/driver-mysql';

serveDriver(driver, electronParentPortTransport(process.parentPort));
