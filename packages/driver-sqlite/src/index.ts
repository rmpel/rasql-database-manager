import {
  PROTOCOL_VERSION,
  type Driver,
  type DriverManifest,
  type ResolvedEndpoint,
  type Session,
} from '@rasql/driver-protocol';
import { openSqlite } from './session.js';

export const SQLITE_FILE_EXTENSIONS = ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'];

export const manifest: DriverManifest = {
  id: 'sqlite',
  name: 'SQLite',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  description: 'SQLite databases, opened by file. Built on node:sqlite.',
  license: 'GPL-3.0-or-later',
  engines: [{ id: 'sqlite', name: 'SQLite', detect: 'version-string' }],
  transports: ['file'],
  fileExtensions: SQLITE_FILE_EXTENSIONS,
  urlSchemes: ['sqlite'],
  capabilities: {
    multipleSchemas: true,
    transactions: true,
    explain: true,
    cancel: true,
    readOnlySession: true,
    objects: ['table', 'view', 'trigger'],
    alterTable: false,
    users: false,
  },
  connectionForm: {
    fields: [
      {
        key: 'filePath',
        label: 'Database file',
        kind: 'file',
        required: true,
        extensions: SQLITE_FILE_EXTENSIONS,
        help: 'Use :memory: for a throwaway in-memory database.',
      },
      {
        key: 'createIfMissing',
        label: 'Create the file if it does not exist',
        kind: 'checkbox',
        default: false,
      },
    ],
  },
};

export const sqliteDriver: Driver = {
  manifest: () => manifest,
  async connect(endpoint: ResolvedEndpoint, _signal?: AbortSignal): Promise<Session> {
    return openSqlite(endpoint);
  },
};

export { SqliteDialect } from './dialect.js';
export { SqliteSession } from './session.js';
export { declaredTypeToValueType, toParam, toValue } from './values.js';
export default sqliteDriver;
