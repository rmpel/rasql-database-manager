import type { ColumnMeta } from './schema.js';
import type { Value } from './values.js';
import type { Transport } from './manifest.js';

export interface TlsOptions {
  mode: 'disabled' | 'preferred' | 'required' | 'verify-ca' | 'verify-identity';
  ca?: string;
  cert?: string;
  key?: string;
  servername?: string;
}

/**
 * What a driver receives. SSH has already been resolved by the core: if a tunnel is
 * involved, host and port point at its local end. Secrets are present here and only here.
 */
export interface ResolvedEndpoint {
  transport: Transport;
  host?: string;
  port?: number;
  socketPath?: string;
  filePath?: string;
  user?: string;
  password?: string;
  database?: string;
  tls?: TlsOptions;
  /** Ask the driver to open the session read-only if it can. */
  readOnly?: boolean;
  /** Driver specific, as collected by the manifest's connection form. */
  options: Record<string, unknown>;
}

export interface QueryOptions {
  params?: Value[];
  /** Rows per 'rows' event. Drivers may clamp. Default 256. */
  rowBatchSize?: number;
  /** Stop after this many rows and report truncated. */
  maxRows?: number;
  /** Schema to run in, where the engine supports switching. */
  schema?: string;
  signal?: AbortSignal;
}

export interface Warning {
  code?: string;
  message: string;
  level?: 'note' | 'warning';
}

export type QueryEvent =
  | { kind: 'columns'; resultIndex: number; columns: ColumnMeta[] }
  | { kind: 'rows'; resultIndex: number; rows: Value[][] }
  | {
      kind: 'done';
      resultIndex: number;
      /** True when more result sets follow (multi-statement). */
      more: boolean;
      affectedRows?: number;
      insertId?: string;
      rowCount?: number;
      truncated?: boolean;
      elapsedMs: number;
      warnings: Warning[];
    }
  | {
      kind: 'error';
      resultIndex: number;
      code: string;
      sqlState?: string;
      message: string;
      position?: number;
    };

export interface ExplainResult {
  format: 'table' | 'text' | 'json';
  columns?: ColumnMeta[];
  rows?: Value[][];
  text?: string;
}
