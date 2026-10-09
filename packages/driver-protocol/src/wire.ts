/**
 * Messages between the RaSQL core (the host) and a driver process. One driver process
 * serves one driver and may hold several sessions. Every request carries an id; the
 * reply, or the stream of events, carries the same id.
 */
import type { DriverManifest } from './manifest.js';
import type { QueryEvent, QueryOptions, ResolvedEndpoint } from './connection.js';
import type { ServerInfo } from './schema.js';
import type { SerializedError } from './errors.js';
import type { DialectRpcMethod, SessionRpcMethod } from './driver.js';

export type RequestId = number;
export type SessionId = string;

export type HostMessage =
  | { kind: 'hello'; protocolVersion: number }
  | { kind: 'manifest'; id: RequestId }
  | { kind: 'connect'; id: RequestId; endpoint: ResolvedEndpoint }
  | { kind: 'call'; id: RequestId; sessionId: SessionId; method: SessionRpcMethod; args: unknown[] }
  | {
      kind: 'dialect';
      id: RequestId;
      sessionId: SessionId;
      method: DialectRpcMethod;
      args: unknown[];
    }
  | {
      kind: 'query';
      id: RequestId;
      sessionId: SessionId;
      sql: string;
      options?: Omit<QueryOptions, 'signal'>;
    }
  /** Cancel the request with this id. Applies to 'connect' and 'query'. */
  | { kind: 'cancel'; id: RequestId }
  | { kind: 'shutdown' };

export type DriverMessage =
  | { kind: 'hello'; protocolVersion: number; manifest: DriverManifest }
  | { kind: 'result'; id: RequestId; value: unknown }
  | { kind: 'connected'; id: RequestId; sessionId: SessionId; info: ServerInfo }
  | { kind: 'event'; id: RequestId; event: QueryEvent }
  | { kind: 'error'; id: RequestId; error: SerializedError }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export function isHostMessage(m: unknown): m is HostMessage {
  return typeof m === 'object' && m !== null && typeof (m as { kind?: unknown }).kind === 'string';
}

export function isDriverMessage(m: unknown): m is DriverMessage {
  return typeof m === 'object' && m !== null && typeof (m as { kind?: unknown }).kind === 'string';
}
