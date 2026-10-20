import { PROTOCOL_VERSION, type DriverManifest } from '@rasql/driver-protocol';

/** The manifest alone, so the app's main process can list drivers without loading them. */
export const manifest: DriverManifest = {
  id: 'postgres',
  name: 'PostgreSQL',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  description: 'PostgreSQL 12 and later, and services built on it, over the PostgreSQL protocol.',
  license: 'GPL-3.0-or-later',
  engines: [{ id: 'postgres', name: 'PostgreSQL', detect: 'version-string' }],
  transports: ['tcp', 'socket'],
  defaultPort: 5432,
  urlSchemes: ['postgres', 'postgresql'],
  capabilities: {
    multipleSchemas: true,
    transactions: true,
    explain: true,
    cancel: true,
    readOnlySession: true,
    objects: ['table', 'view', 'routine', 'trigger', 'sequence'],
    alterTable: false,
    users: false,
  },
  connectionForm: {
    fields: [
      {
        key: 'connectTimeoutMs',
        label: 'Connect timeout (ms)',
        kind: 'number',
        default: 10000,
      },
      {
        key: 'initSql',
        label: 'Statements to run after connecting',
        kind: 'text',
        placeholder: 'SET search_path = app, public',
      },
    ],
  },
};
