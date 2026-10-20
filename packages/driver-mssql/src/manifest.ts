import { PROTOCOL_VERSION, type DriverManifest } from '@rasql/driver-protocol';

/** The manifest alone, so the app's main process can list drivers without loading them. */
export const manifest: DriverManifest = {
  id: 'mssql',
  name: 'Microsoft SQL Server',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  description:
    'SQL Server 2016 and later, Azure SQL Database and Azure SQL Managed Instance, over TDS.',
  license: 'GPL-3.0-or-later',
  engines: [
    { id: 'mssql', name: 'SQL Server', detect: 'query' },
    { id: 'azure-sql', name: 'Azure SQL', detect: 'query' },
  ],
  transports: ['tcp'],
  defaultPort: 1433,
  urlSchemes: ['mssql', 'sqlserver'],
  capabilities: {
    multipleSchemas: true,
    transactions: true,
    explain: true,
    cancel: true,
    // Read-only connections are enforced by RaSQL refusing writes; the server has no such mode.
    readOnlySession: false,
    objects: ['table', 'view', 'routine', 'trigger', 'sequence'],
    alterTable: false,
    users: false,
  },
  connectionForm: {
    fields: [
      {
        key: 'instanceName',
        label: 'Instance name',
        kind: 'text',
        placeholder: 'SQLEXPRESS',
        help: 'For a named instance; the port is then found through SQL Server Browser.',
      },
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
        placeholder: 'SET LANGUAGE us_english',
      },
    ],
  },
};
