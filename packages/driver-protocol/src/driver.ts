import type { DriverManifest } from './manifest.js';
import type { ExplainResult, QueryEvent, QueryOptions, ResolvedEndpoint } from './connection.js';
import type { DbObject, SchemaInfo, ServerInfo, TableDefinition } from './schema.js';
import type { Dialect } from './dialect.js';

export interface Driver {
  manifest(): DriverManifest;
  connect(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<Session>;
}

export interface Session {
  info(): Promise<ServerInfo>;
  listSchemas(): Promise<SchemaInfo[]>;
  listObjects(schema: string): Promise<DbObject[]>;
  describeTable(schema: string, table: string): Promise<TableDefinition>;
  /** Streams. Never buffers a result set. Honors opts.signal where the engine can cancel. */
  query(sql: string, opts?: QueryOptions): AsyncIterable<QueryEvent>;
  explain(sql: string): Promise<ExplainResult>;
  setReadOnly(on: boolean): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  readonly dialect: Dialect;
  close(): Promise<void>;
}

/** The subset of Session methods that are plain request/response over the protocol. */
export const SESSION_RPC_METHODS = [
  'info',
  'listSchemas',
  'listObjects',
  'describeTable',
  'explain',
  'setReadOnly',
  'begin',
  'commit',
  'rollback',
  'close',
] as const;
export type SessionRpcMethod = (typeof SESSION_RPC_METHODS)[number];

export const DIALECT_RPC_METHODS = [
  'describe',
  'quoteIdentifier',
  'quoteLiteral',
  'buildSelect',
  'buildCount',
  'buildUpdate',
  'buildInsert',
  'buildInsertMany',
  'buildDelete',
  'buildAlter',
  'classify',
] as const;
export type DialectRpcMethod = (typeof DIALECT_RPC_METHODS)[number];
