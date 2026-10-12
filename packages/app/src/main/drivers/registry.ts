import type { DriverManifest } from '@rasql/driver-protocol';
// Manifests only: each driver's library loads in its own utility process, never in main.
import { manifest as sqliteManifest } from '@rasql/driver-sqlite';
import { manifest as mysqlManifest } from '@rasql/driver-mysql/manifest';
import { manifest as postgresManifest } from '@rasql/driver-postgres/manifest';
import { manifest as mssqlManifest } from '@rasql/driver-mssql/manifest';
import sqliteEntry from './sqlite-entry?modulePath';
import mysqlEntry from './mysql-entry?modulePath';
import postgresEntry from './postgres-entry?modulePath';
import mssqlEntry from './mssql-entry?modulePath';

export interface BuiltinDriver {
  manifest: DriverManifest;
  /** Absolute path of the utility-process entry built by electron-vite. */
  entry: string;
}

const builtins: BuiltinDriver[] = [
  { manifest: sqliteManifest, entry: sqliteEntry },
  { manifest: mysqlManifest, entry: mysqlEntry },
  { manifest: postgresManifest, entry: postgresEntry },
  { manifest: mssqlManifest, entry: mssqlEntry },
];

export function listDrivers(): DriverManifest[] {
  return builtins.map((d) => d.manifest);
}

export function findDriver(id: string): BuiltinDriver {
  const d = builtins.find((b) => b.manifest.id === id);
  if (!d) throw new Error(`No driver with id "${id}"`);
  return d;
}
