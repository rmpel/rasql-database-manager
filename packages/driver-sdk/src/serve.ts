import { randomUUID } from 'node:crypto';
import {
  DriverError,
  PROTOCOL_VERSION,
  isHostMessage,
  type Driver,
  type DriverMessage,
  type HostMessage,
  type QueryEvent,
  type QueryOptions,
  type RequestId,
  type Session,
  type SessionId,
} from '@rasql/driver-protocol';
import type { Transport } from './transport.js';

export interface ServeOptions {
  /** Called for driver-side diagnostics. Defaults to forwarding as 'log' messages. */
  onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Run a driver behind the protocol. Works in an Electron utility process, a Node child
 * process, or in-process for tests; the transport decides. Returns a function that stops serving.
 */
export function serveDriver(
  driver: Driver,
  transport: Transport,
  opts: ServeOptions = {},
): () => void {
  const sessions = new Map<SessionId, Session>();
  const inflight = new Map<RequestId, AbortController>();

  const send = (m: DriverMessage): void => transport.send(m);
  const log = opts.onLog ?? ((level, message) => send({ kind: 'log', level, message }));

  const fail = (id: RequestId, err: unknown): void => {
    send({ kind: 'error', id, error: DriverError.from(err).toJSON() });
  };

  const requireSession = (sessionId: SessionId): Session => {
    const s = sessions.get(sessionId);
    if (!s) throw new DriverError('NOT_CONNECTED', `Unknown session ${sessionId}`);
    return s;
  };

  const handleConnect = async (m: Extract<HostMessage, { kind: 'connect' }>): Promise<void> => {
    const ac = new AbortController();
    inflight.set(m.id, ac);
    try {
      const session = await driver.connect(m.endpoint, ac.signal);
      if (ac.signal.aborted) {
        await session.close().catch(() => undefined);
        throw new DriverError('CANCELLED', 'Connect cancelled');
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, session);
      const info = await session.info();
      send({ kind: 'connected', id: m.id, sessionId, info });
    } catch (err) {
      fail(m.id, err);
    } finally {
      inflight.delete(m.id);
    }
  };

  const handleCall = async (m: Extract<HostMessage, { kind: 'call' }>): Promise<void> => {
    try {
      const session = requireSession(m.sessionId);
      const fn = session[m.method] as (...args: unknown[]) => Promise<unknown>;
      const value = await fn.apply(session, m.args);
      if (m.method === 'close') sessions.delete(m.sessionId);
      send({ kind: 'result', id: m.id, value: value ?? null });
    } catch (err) {
      fail(m.id, err);
    }
  };

  const handleDialect = (m: Extract<HostMessage, { kind: 'dialect' }>): void => {
    try {
      const session = requireSession(m.sessionId);
      const dialect = session.dialect as unknown as Record<
        string,
        ((...args: unknown[]) => unknown) | undefined
      >;
      const fn = dialect[m.method];
      if (typeof fn !== 'function') {
        throw new DriverError('UNSUPPORTED', `Dialect does not implement ${m.method}`);
      }
      send({ kind: 'result', id: m.id, value: fn.apply(session.dialect, m.args) ?? null });
    } catch (err) {
      fail(m.id, err);
    }
  };

  const handleQuery = async (m: Extract<HostMessage, { kind: 'query' }>): Promise<void> => {
    const ac = new AbortController();
    inflight.set(m.id, ac);
    const started = Date.now();
    let terminal = false;
    const emit = (event: QueryEvent): void => {
      if (event.kind === 'error' || (event.kind === 'done' && !event.more)) terminal = true;
      send({ kind: 'event', id: m.id, event });
    };
    try {
      const session = requireSession(m.sessionId);
      const options: QueryOptions = { ...(m.options ?? {}), signal: ac.signal };
      for await (const event of session.query(m.sql, options)) {
        emit(event);
        if (terminal) break;
      }
      if (!terminal) {
        // A driver that ends its stream without a terminal event gets one on its behalf.
        emit({
          kind: 'done',
          resultIndex: 0,
          more: false,
          elapsedMs: Date.now() - started,
          warnings: [],
        });
      }
    } catch (err) {
      if (!terminal) {
        const e = DriverError.from(
          ac.signal.aborted ? new DriverError('CANCELLED', 'Query cancelled') : err,
        );
        const event: QueryEvent = {
          kind: 'error',
          resultIndex: 0,
          code: e.code,
          message: e.message,
        };
        if (e.sqlState !== undefined) event.sqlState = e.sqlState;
        emit(event);
      }
    } finally {
      inflight.delete(m.id);
    }
  };

  const shutdown = async (): Promise<void> => {
    for (const ac of inflight.values()) ac.abort();
    inflight.clear();
    await Promise.allSettled([...sessions.values()].map((s) => s.close()));
    sessions.clear();
  };

  const onMessage = (raw: unknown): void => {
    if (!isHostMessage(raw)) {
      log('warn', `Ignoring malformed host message: ${JSON.stringify(raw)}`);
      return;
    }
    const m = raw;
    switch (m.kind) {
      case 'hello':
        if (m.protocolVersion !== PROTOCOL_VERSION) {
          log(
            'error',
            `Host speaks protocol ${m.protocolVersion}, driver speaks ${PROTOCOL_VERSION}`,
          );
        }
        send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, manifest: driver.manifest() });
        return;
      case 'manifest':
        send({ kind: 'result', id: m.id, value: driver.manifest() });
        return;
      case 'connect':
        void handleConnect(m);
        return;
      case 'call':
        void handleCall(m);
        return;
      case 'dialect':
        handleDialect(m);
        return;
      case 'query':
        void handleQuery(m);
        return;
      case 'cancel':
        inflight.get(m.id)?.abort();
        return;
      case 'shutdown':
        void shutdown().finally(() => transport.close());
        return;
    }
  };

  const unsubscribe = transport.onMessage(onMessage);
  // Announce readiness so a host that started us does not have to poll.
  send({ kind: 'hello', protocolVersion: PROTOCOL_VERSION, manifest: driver.manifest() });

  return () => {
    unsubscribe();
    void shutdown();
  };
}
