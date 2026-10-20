import { PROTOCOL_VERSION, type DriverManifest } from '@rasql/driver-protocol';

/** The manifest alone, so the app's main process can list drivers without loading them. */
export const manifest: DriverManifest = {
  id: 'mysql',
  name: 'MySQL and MariaDB',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  description:
    'MySQL, MariaDB, Percona Server, Amazon Aurora MySQL, TiDB and Vitess over the MySQL wire protocol.',
  license: 'GPL-3.0-or-later',
  engines: [
    { id: 'mysql', name: 'MySQL', detect: 'version-string' },
    { id: 'mariadb', name: 'MariaDB', detect: 'version-string' },
    { id: 'percona', name: 'Percona Server', detect: 'version-string' },
    { id: 'aurora-mysql', name: 'Amazon Aurora MySQL', detect: 'query' },
    { id: 'tidb', name: 'TiDB', detect: 'version-string' },
    { id: 'vitess', name: 'Vitess', detect: 'version-string' },
  ],
  transports: ['tcp', 'socket'],
  defaultPort: 3306,
  urlSchemes: ['mysql', 'mariadb'],
  capabilities: {
    multipleSchemas: true,
    transactions: true,
    explain: true,
    cancel: true,
    readOnlySession: true,
    objects: ['table', 'view', 'routine', 'trigger', 'event'],
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
        key: 'compress',
        label: 'Compress the connection',
        kind: 'checkbox',
        default: false,
        help: 'Helps over slow links; costs CPU on both ends.',
      },
      {
        key: 'initSql',
        label: 'Statements to run after connecting',
        kind: 'text',
        placeholder: 'SET SESSION sql_mode = ...',
      },
    ],
  },
};
