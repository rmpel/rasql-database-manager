import type { DriverManifest } from '@rasql/driver-protocol';
import { manifest as sqliteManifest } from '@rasql/driver-sqlite';
import { manifest as mysqlManifest } from '@rasql/driver-mysql';
import sqliteEntry from './sqlite-entry?modulePath';
import mysqlEntry from './mysql-entry?modulePath';

export interface BuiltinDriver {
  manifest: DriverManifest;
  /** Absolute path of the utility-process entry built by electron-vite. */
  entry: string;
}

const builtins: BuiltinDriver[] = [
  { manifest: sqliteManifest, entry: sqliteEntry },
  { manifest: mysqlManifest, entry: mysqlEntry },
];

export function listDrivers(): DriverManifest[] {
  return builtins.map((d) => d.manifest);
}

export function findDriver(id: string): BuiltinDriver {
  const d = builtins.find((b) => b.manifest.id === id);
  if (!d) throw new Error(`No driver with id "${id}"`);
  return d;
}
