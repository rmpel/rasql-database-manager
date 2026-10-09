import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { ResolvedEndpoint } from '@rasql/driver-protocol';
import type { RemoteSession } from '@rasql/driver-sdk';
import type {
  ConnectionDefinition,
  OpenSessionRequest,
  OpenSessionResult,
  SerializableQueryOptions,
} from '@shared/api';
import { IPC } from '@shared/api';
import { DriverProcess } from './drivers/host';
import { findDriver } from './drivers/registry';
import { passwordAccount, type CredentialProvider } from './credentials';
import type { HopSecrets, SshTunnelManager, TunnelHandle, TunnelTarget } from './ssh/tunnel';

interface LiveSession {
  key: string;
  definition: ConnectionDefinition;
  process: DriverProcess;
  session: RemoteSession;
  windowId: number;
  tunnel?: TunnelHandle;
}

const WELL_KNOWN = new Set([
  'host',
  'port',
  'socketPath',
  'filePath',
  'user',
  'password',
  'database',
]);

export function toEndpoint(
  def: ConnectionDefinition,
  password: string | undefined,
): ResolvedEndpoint {
  const options: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def.options ?? {})) if (!WELL_KNOWN.has(k)) options[k] = v;
  const ep: ResolvedEndpoint = { transport: def.transport, options };
  if (def.host !== undefined) ep.host = def.host;
  if (def.port !== undefined) ep.port = def.port;
  if (def.socketPath !== undefined) ep.socketPath = def.socketPath;
  if (def.filePath !== undefined) ep.filePath = def.filePath;
  if (def.user !== undefined) ep.user = def.user;
  if (password !== undefined) ep.password = password;
  if (def.database !== undefined) ep.database = def.database;
  if (def.readOnly) ep.readOnly = true;
  return ep;
}

/** What the last SSH hop must reach: the database's own address, as the user typed it. */
export function tunnelTarget(
  def: ConnectionDefinition,
  defaultPort: number | undefined,
): TunnelTarget {
  if (def.transport === 'socket') {
    if (!def.socketPath)
      throw new Error('A socket path is required for a socket connection through SSH');
    return { socketPath: def.socketPath };
  }
  const port = def.port ?? defaultPort;
  if (port === undefined) throw new Error('A port is required for a TCP connection through SSH');
  return { host: def.host || '127.0.0.1', port };
}

/** Point the endpoint at the tunnel's local end; the driver never learns SSH was involved. */
export function throughTunnel(
  ep: ResolvedEndpoint,
  tunnel: TunnelHandle,
  originalHost: string | undefined,
): ResolvedEndpoint {
  const out: ResolvedEndpoint = { ...ep, transport: 'tcp', host: tunnel.host, port: tunnel.port };
  delete out.socketPath;
  if (out.tls && originalHost && out.tls.servername === undefined)
    out.tls = { ...out.tls, servername: originalHost };
  return out;
}

/** Owns every open connection: one driver process per session, tied to the window that opened it. */
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly queries = new Map<string, AbortController>();

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly log: (line: string) => void,
    private readonly tunnels: SshTunnelManager,
  ) {}

  private async storedSecret(
    ref: { provider: string; account?: string } | undefined,
  ): Promise<string | undefined> {
    if (ref?.provider !== 'keychain' || !ref.account) return undefined;
    return (await this.credentials.get(ref.account)) ?? undefined;
  }

  /** Open the SSH tunnel for a definition, or return null when it has no hops. */
  private async openTunnel(
    definition: ConnectionDefinition,
    req: OpenSessionRequest,
    defaultPort: number | undefined,
  ): Promise<TunnelHandle | null> {
    const hops = definition.ssh ?? [];
    if (!hops.length || definition.transport === 'file') return null;
    const last: HopSecrets = {};
    const password =
      req.sshPassword ?? (await this.storedSecret(definition.credentials.sshPassword));
    const passphrase =
      req.sshPassphrase ?? (await this.storedSecret(definition.credentials.sshPassphrase));
    if (password !== undefined) last.password = password;
    if (passphrase !== undefined) last.passphrase = passphrase;
    const secrets: HopSecrets[] = hops.map((_h, i) => (i === hops.length - 1 ? last : {}));
    return this.tunnels.open(hops, tunnelTarget(definition, defaultPort), secrets);
  }

  async open(win: BrowserWindow, req: OpenSessionRequest): Promise<OpenSessionResult> {
    const { definition } = req;
    const { manifest } = findDriver(definition.driver);
    let password = req.password;
    if (password === undefined && definition.credentials.password?.provider === 'keychain') {
      password = (await this.credentials.get(definition.credentials.password.account)) ?? undefined;
    }
    const tunnel = await this.openTunnel(definition, req, manifest.defaultPort);
    let endpoint = toEndpoint(definition, password);
    if (tunnel) endpoint = throughTunnel(endpoint, tunnel, definition.host);
    let proc: DriverProcess;
    let session: RemoteSession;
    try {
      proc = await DriverProcess.spawn(definition.driver, this.log);
    } catch (err) {
      tunnel?.release();
      throw err;
    }
    try {
      session = await proc.client.connect(endpoint);
    } catch (err) {
      proc.kill();
      tunnel?.release();
      throw err;
    }
    if (req.savePassword && req.password !== undefined && definition.id) {
      await this.credentials.set(passwordAccount(definition.id), req.password);
    }
    const key = randomUUID();
    const live: LiveSession = { key, definition, process: proc, session, windowId: win.id };
    if (tunnel) live.tunnel = tunnel;
    this.sessions.set(key, live);
    this.log(
      `[session ${key.slice(0, 8)}] opened ${definition.name} (${session.serverInfo.engine} ${session.serverInfo.version})`,
    );
    return { sessionKey: key, info: session.serverInfo, manifest };
  }

  get(key: string): RemoteSession {
    const live = this.sessions.get(key);
    if (!live) throw new Error('Session is not open');
    return live.session;
  }

  async close(key: string): Promise<void> {
    const live = this.sessions.get(key);
    if (!live) return;
    this.sessions.delete(key);
    await live.session.close().catch(() => undefined);
    live.process.kill();
    live.tunnel?.release();
    this.log(`[session ${key.slice(0, 8)}] closed`);
  }

  async closeForWindow(windowId: number): Promise<void> {
    const keys = [...this.sessions.values()]
      .filter((s) => s.windowId === windowId)
      .map((s) => s.key);
    await Promise.all(keys.map((k) => this.close(k)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((k) => this.close(k)));
  }

  /** Start a query and stream its events to the window. Returns immediately with the query id. */
  startQuery(
    win: BrowserWindow,
    key: string,
    sql: string,
    opts: SerializableQueryOptions = {},
  ): string {
    const session = this.get(key);
    const queryId = randomUUID();
    const ac = new AbortController();
    this.queries.set(queryId, ac);
    void (async () => {
      try {
        for await (const event of session.query(sql, { ...opts, signal: ac.signal })) {
          if (win.isDestroyed()) break;
          win.webContents.send(IPC.sessionQueryEvent, { queryId, event });
        }
      } catch (err) {
        if (!win.isDestroyed()) {
          const message = err instanceof Error ? err.message : String(err);
          const code = (err as { code?: string }).code ?? 'INTERNAL';
          win.webContents.send(IPC.sessionQueryEvent, {
            queryId,
            event: { kind: 'error', resultIndex: 0, code, message },
          });
        }
      } finally {
        this.queries.delete(queryId);
      }
    })();
    return queryId;
  }

  cancelQuery(queryId: string): void {
    this.queries.get(queryId)?.abort();
  }
}
