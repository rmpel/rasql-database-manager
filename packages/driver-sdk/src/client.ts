import {
  DIALECT_RPC_METHODS,
  DriverError,
  PROTOCOL_VERSION,
  isDriverMessage,
  type DbObject,
  type DbObjectKind,
  type ObjectDefinition,
  type DialectRpcMethod,
  type DriverManifest,
  type DriverMessage,
  type ExplainResult,
  type HostMessage,
  type QueryEvent,
  type QueryOptions,
  type RemoteDialect,
  type RequestId,
  type ResolvedEndpoint,
  type SchemaInfo,
  type ServerInfo,
  type SessionId,
  type SessionRpcMethod,
  type TableDefinition,
} from '@rasql/driver-protocol';
import type { Transport } from './transport.js';

/** A session as the host sees it. Like `Session`, except the dialect is async. */
export interface RemoteSession {
  readonly id: SessionId;
  readonly serverInfo: ServerInfo;
  readonly dialect: RemoteDialect;
  info(): Promise<ServerInfo>;
  listSchemas(): Promise<SchemaInfo[]>;
  listObjects(schema: string): Promise<DbObject[]>;
  describeTable(schema: string, table: string): Promise<TableDefinition>;
  describeObject(schema: string, kind: DbObjectKind, name: string): Promise<ObjectDefinition>;
  query(sql: string, opts?: QueryOptions): AsyncIterable<QueryEvent>;
  explain(sql: string): Promise<ExplainResult>;
  setReadOnly(on: boolean): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: DriverError) => void;
}

interface StreamState {
  queue: QueryEvent[];
  waiting: ((done: boolean) => void) | null;
  finished: boolean;
  error: DriverError | null;
}

export interface DriverClientOptions {
  onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** How long to wait for the driver's hello. Default 15 s. */
  helloTimeoutMs?: number;
}

/** The host side of the protocol. One client per driver process. */
export class DriverClient {
  readonly ready: Promise<DriverManifest>;
  private nextId: RequestId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly streams = new Map<RequestId, StreamState>();
  private readonly unsubscribe: () => void;
  private manifestCache: DriverManifest | null = null;
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly opts: DriverClientOptions = {},
  ) {
    let resolveReady!: (m: DriverManifest) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<DriverManifest>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    const timer = setTimeout(() => {
      rejectReady(new DriverError('TIMEOUT', 'Driver did not say hello in time'));
    }, opts.helloTimeoutMs ?? 15_000);
    this.unsubscribe = transport.onMessage((raw) => {
      if (!isDriverMessage(raw)) return;
      if (raw.kind === 'hello') {
        clearTimeout(timer);
        if (raw.protocolVersion !== PROTOCOL_VERSION) {
          rejectReady(
            new DriverError(
              'PROTOCOL_ERROR',
              `Driver speaks protocol ${raw.protocolVersion}, host speaks ${PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        this.manifestCache = raw.manifest;
        resolveReady(raw.manifest);
        return;
      }
      this.dispatch(raw);
    });
    // In case the driver announced itself before we subscribed, ask explicitly.
    this.send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION });
  }

  async manifest(): Promise<DriverManifest> {
    if (this.manifestCache) return this.manifestCache;
    return this.ready;
  }

  async connect(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<RemoteSession> {
    await this.ready;
    const id = this.nextId++;
    const onAbort = (): void => this.send({ kind: 'cancel', id });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = (await this.request(id, { kind: 'connect', id, endpoint })) as {
        sessionId: SessionId;
        info: ServerInfo;
      };
      return this.makeSession(result.sessionId, result.info);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Ask the driver to close every session and stop. The transport is closed afterwards. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.send({ kind: 'shutdown' });
    } catch {
      /* transport may already be gone */
    }
    this.unsubscribe();
    const err = new DriverError('NOT_CONNECTED', 'Driver client shut down');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const s of this.streams.values()) this.finishStream(s, err);
    this.streams.clear();
    this.transport.close();
  }

  private send(m: HostMessage): void {
    this.transport.send(m);
  }

  private request(id: RequestId, m: HostMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(m);
    });
  }

  private dispatch(m: DriverMessage): void {
    switch (m.kind) {
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        p.resolve(m.value);
        return;
      }
      case 'connected': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        p.resolve({ sessionId: m.sessionId, info: m.info });
        return;
      }
      case 'error': {
        const err = DriverError.deserialize(m.error);
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.reject(err);
          return;
        }
        const s = this.streams.get(m.id);
        if (s) this.finishStream(s, err);
        return;
      }
      case 'event': {
        const s = this.streams.get(m.id);
        if (!s) return;
        s.queue.push(m.event);
        const terminal = m.event.kind === 'error' || (m.event.kind === 'done' && !m.event.more);
        if (terminal) s.finished = true;
        s.waiting?.(terminal);
        s.waiting = null;
        return;
      }
      case 'log':
        this.opts.onLog?.(m.level, m.message);
        return;
      case 'hello':
        return;
    }
  }

  private finishStream(s: StreamState, err: DriverError | null): void {
    s.finished = true;
    s.error = err;
    s.waiting?.(true);
    s.waiting = null;
  }

  private call(sessionId: SessionId, method: SessionRpcMethod, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return this.request(id, { kind: 'call', id, sessionId, method, args });
  }

  private dialectCall(
    sessionId: SessionId,
    method: DialectRpcMethod,
    args: unknown[],
  ): Promise<unknown> {
    const id = this.nextId++;
    return this.request(id, { kind: 'dialect', id, sessionId, method, args });
  }

  private query(
    sessionId: SessionId,
    sql: string,
    opts: QueryOptions = {},
  ): AsyncIterable<QueryEvent> {
    const { signal, ...options } = opts;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<QueryEvent> {
        const id = client.nextId++;
        const state: StreamState = { queue: [], waiting: null, finished: false, error: null };
        client.streams.set(id, state);
        let started = false;
        let cancelled = false;
        const cancel = (): void => {
          if (cancelled || state.finished) return;
          cancelled = true;
          client.send({ kind: 'cancel', id });
        };
        signal?.addEventListener('abort', cancel, { once: true });
        const cleanup = (): void => {
          client.streams.delete(id);
          signal?.removeEventListener('abort', cancel);
        };
        return {
          async next(): Promise<IteratorResult<QueryEvent>> {
            if (!started) {
              started = true;
              if (signal?.aborted) {
                cleanup();
                throw new DriverError('CANCELLED', 'Query cancelled before it started');
              }
              client.send({ kind: 'query', id, sessionId, sql, options });
            }
            while (state.queue.length === 0) {
              if (state.error) {
                cleanup();
                throw state.error;
              }
              if (state.finished) {
                cleanup();
                return { value: undefined, done: true };
              }
              await new Promise<boolean>((res) => {
                state.waiting = res;
              });
            }
            const event = state.queue.shift() as QueryEvent;
            return { value: event, done: false };
          },
          async return(): Promise<IteratorResult<QueryEvent>> {
            cancel();
            cleanup();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private makeSession(id: SessionId, info: ServerInfo): RemoteSession {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;
    const dialect = Object.fromEntries(
      DIALECT_RPC_METHODS.map((method) => [
        method,
        (...args: unknown[]) => client.dialectCall(id, method, args),
      ]),
    ) as unknown as RemoteDialect;
    return {
      id,
      serverInfo: info,
      dialect,
      info: () => client.call(id, 'info', []) as Promise<ServerInfo>,
      listSchemas: () => client.call(id, 'listSchemas', []) as Promise<SchemaInfo[]>,
      listObjects: (schema) => client.call(id, 'listObjects', [schema]) as Promise<DbObject[]>,
      describeTable: (schema, table) =>
        client.call(id, 'describeTable', [schema, table]) as Promise<TableDefinition>,
      describeObject: (schema, kind, name) =>
        client.call(id, 'describeObject', [schema, kind, name]) as Promise<ObjectDefinition>,
      query: (sql, opts) => client.query(id, sql, opts),
      explain: (sql) => client.call(id, 'explain', [sql]) as Promise<ExplainResult>,
      setReadOnly: (on) => client.call(id, 'setReadOnly', [on]) as Promise<void>,
      begin: () => client.call(id, 'begin', []) as Promise<void>,
      commit: () => client.call(id, 'commit', []) as Promise<void>,
      rollback: () => client.call(id, 'rollback', []) as Promise<void>,
      close: () => client.call(id, 'close', []) as Promise<void>,
    };
  }
}
