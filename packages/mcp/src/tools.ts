import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const connection = {
  type: 'string',
  description: 'Connection id or name, from list_connections',
} as const;
const schema = {
  type: 'string',
  description:
    'Schema inside the connection\'s database (PostgreSQL "public", SQL Server "dbo"). Omit for the default.',
} as const;
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** The tools of MCP.md, with the level each needs noted in its description. */
export const TOOLS: Tool[] = [
  {
    name: 'list_connections',
    description:
      'Connections the user opened up for agents, with their access setting: "read" (reads only), "ask" (each change waits for the user), "secure" (each change waits for the user to confirm with Touch ID) or "write" (safe changes run at once). Never includes hosts, users or passwords.',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly,
  },
  {
    name: 'create_connection',
    description:
      'Add a stored connection. The user confirms it in RaSQL first. A password goes straight to the keychain and can never be read back. The new connection starts at "ask".',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        driver: {
          type: 'string',
          enum: ['mysql', 'postgres', 'mssql', 'sqlite'],
          default: 'mysql',
        },
        transport: { type: 'string', enum: ['tcp', 'socket', 'file'] },
        host: { type: 'string' },
        port: { type: 'integer' },
        socket_path: { type: 'string' },
        file_path: { type: 'string', description: 'SQLite database file' },
        user: { type: 'string' },
        password: { type: 'string' },
        database: { type: 'string', description: 'The one database agents may use on it' },
        environment: {
          type: 'string',
          enum: ['local', 'development', 'staging', 'production', 'other'],
        },
        group: { type: 'string' },
        favorite: { type: 'boolean' },
        color: { type: 'string', description: 'Hex color such as #3a86c8' },
        read_only: { type: 'boolean', description: 'Nobody may write through this connection' },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'update_connection',
    description:
      'Rename a connection, or change its group, favorite flag or color. Nothing that decides where it points or what agents may do can be changed over MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        connection,
        name: { type: 'string' },
        group: { type: ['string', 'null'] },
        favorite: { type: 'boolean' },
        color: { type: ['string', 'null'] },
      },
      required: ['connection'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_databases',
    description:
      "The connection's database and the schemas inside it. Agents work in this database only.",
    inputSchema: { type: 'object', properties: { connection }, required: ['connection'] },
    annotations: readOnly,
  },
  {
    name: 'list_tables',
    description:
      'Tables and views with row estimates and comments, plus the names of routines, triggers and events.',
    inputSchema: { type: 'object', properties: { connection, schema }, required: ['connection'] },
    annotations: readOnly,
  },
  {
    name: 'describe_table',
    description: 'Columns, indexes, foreign keys and the CREATE statement of a table or view.',
    inputSchema: {
      type: 'object',
      properties: { connection, table: { type: 'string' }, schema },
      required: ['connection', 'table'],
    },
    annotations: readOnly,
  },
  {
    name: 'describe_object',
    description: 'The definition of a view, routine, trigger or event.',
    inputSchema: {
      type: 'object',
      properties: {
        connection,
        kind: { type: 'string', enum: ['view', 'routine', 'trigger', 'event'] },
        name: { type: 'string' },
        schema,
      },
      required: ['connection', 'kind', 'name'],
    },
    annotations: readOnly,
  },
  {
    name: 'search_schema',
    description:
      'Find tables and columns by name. A plain pattern matches anywhere in the name; % and _ work as in LIKE.',
    inputSchema: {
      type: 'object',
      properties: { connection, pattern: { type: 'string' }, schema },
      required: ['connection', 'pattern'],
    },
    annotations: readOnly,
  },
  {
    name: 'sample_rows',
    description:
      "The first rows of a table, typed. The row count is capped by the user's row limit.",
    inputSchema: {
      type: 'object',
      properties: {
        connection,
        table: { type: 'string' },
        schema,
        limit: { type: 'integer', minimum: 1, default: 20 },
      },
      required: ['connection', 'table'],
    },
    annotations: readOnly,
  },
  {
    name: 'query',
    description:
      'Run one statement that only reads (SELECT, SHOW, EXPLAIN …). Anything that writes is refused; use commit_changes. Values come back typed: NULL as null, big integers and decimals as exact strings, binary data as {"$type":"bytes"}.',
    inputSchema: {
      type: 'object',
      properties: {
        connection,
        sql: { type: 'string' },
        limit: {
          type: 'integer',
          minimum: 1,
          description: "Rows to return; capped by the user's row limit",
        },
        schema,
      },
      required: ['connection', 'sql'],
    },
    annotations: readOnly,
  },
  {
    name: 'explain',
    description: 'The execution plan of a SELECT, INSERT, UPDATE or DELETE, without running it.',
    inputSchema: {
      type: 'object',
      properties: { connection, sql: { type: 'string' } },
      required: ['connection', 'sql'],
    },
    annotations: readOnly,
  },
  {
    name: 'commit_changes',
    description:
      'Submit a change set: one or more statements that are committed together, in one transaction where the engine allows it. Depending on the connection, it runs at once or after the user allows it in RaSQL; anything that can lose data (DROP, TRUNCATE, DELETE, UPDATE without WHERE, narrowing a column whose data does not fit) always waits for the user. Waits up to wait_seconds for the outcome; if still pending, call change_status with the returned id.',
    inputSchema: {
      type: 'object',
      properties: {
        connection,
        statements: { type: 'array', items: { type: 'string' }, minItems: 1 },
        description: {
          type: 'string',
          description: 'One sentence for the user on what this change does and why',
        },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, default: 120 },
      },
      required: ['connection', 'statements'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'change_status',
    description:
      "The outcome of a change set: committed, denied with the user's note, expired, or failed with the error.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, default: 120 },
      },
      required: ['id'],
    },
    annotations: readOnly,
  },
];
