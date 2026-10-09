/**
 * SSH tunnels for RaSQL. One SSH session per distinct hop chain, shared by every connection
 * that uses it; a local listener per target; cooperative host-key verification; no way to
 * switch verification off. Electron-free so it is unit-testable; the dialog is injected.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  Client,
  utils,
  type AuthHandlerMiddleware,
  type AuthenticationType,
  type ConnectConfig,
} from 'ssh2';
import type { SshHop } from '@shared/api';
import {
  defaultIdentityFiles,
  expandHome,
  loadUserSshConfig,
  resolveSshHost,
  type SshConfigEntry,
} from './config';
import {
  fingerprint,
  formatKnownHostLine,
  keyTypeOf,
  parseKnownHosts,
  verifyKnownHost,
} from './known-hosts';

export type SshErrorCode =
  | 'AUTH_FAILED'
  | 'HOST_KEY_UNKNOWN'
  | 'HOST_KEY_CHANGED'
  | 'HOST_KEY_REVOKED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'FORWARD_FAILED';

export class SshError extends Error {
  constructor(
    readonly code: SshErrorCode,
    readonly hop: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`SSH ${hop}: ${message}`, options);
    this.name = 'SshError';
  }
}

export interface HopSecrets {
  password?: string;
  passphrase?: string;
}

export type TunnelTarget = { host: string; port: number } | { socketPath: string };

export interface TunnelHandle {
  host: '127.0.0.1';
  port: number;
  release(): void;
}

export interface UnknownHostInfo {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export interface TunnelManagerOptions {
  home?: string;
  /** Where RaSQL keeps its own known_hosts. */
  userDataDir: string;
  /** Asked when a host key is not in any known_hosts file. */
  confirmUnknownHost: (info: UnknownHostInfo) => Promise<boolean>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  /** Override for tests. Defaults to ~/.ssh/config. */
  config?: SshConfigEntry[];
}

interface ResolvedHop {
  label: string;
  host: string;
  port: number;
  user: string;
  auth: NonNullable<SshHop['auth']>;
  keyPaths: string[];
  secrets: HopSecrets;
}

interface Chain {
  key: string;
  clients: Client[];
  users: number;
  ready: Promise<Client>;
  dead: boolean;
}

const MAX_HOPS = 8;

export class SshTunnelManager {
  private readonly chains = new Map<string, Chain>();
  private readonly home: string;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: TunnelManagerOptions) {
    this.home = opts.home ?? homedir();
    this.log = opts.log ?? (() => undefined);
  }

  /** Open (or reuse) the chain, then listen locally and forward every socket to `target`. */
  async open(
    hops: SshHop[],
    target: TunnelTarget,
    secrets: HopSecrets[] = [],
  ): Promise<TunnelHandle> {
    if (!hops.length) throw new SshError('NETWORK', '?', 'No SSH hops given');
    const resolved = this.expand(hops, secrets);
    const key = JSON.stringify(resolved.map((h) => [h.host, h.port, h.user, h.auth, h.keyPaths]));
    let chain = this.chains.get(key);
    if (!chain || chain.dead) {
      chain = this.startChain(key, resolved);
      this.chains.set(key, chain);
    }
    chain.users++;
    let last: Client;
    try {
      last = await chain.ready;
    } catch (err) {
      this.releaseChain(chain);
      throw err;
    }

    const server = createServer((socket) =>
      this.forward(last, resolved[resolved.length - 1] as ResolvedHop, target, socket),
    );
    const port = await new Promise<number>((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return rej(new Error('No local port'));
        res(addr.port);
      });
    });
    const describe = 'socketPath' in target ? target.socketPath : `${target.host}:${target.port}`;
    this.log(
      `[ssh] tunnel 127.0.0.1:${port} -> ${describe} via ${resolved.map((h) => h.label).join(' -> ')}`,
    );

    let released = false;
    const chainRef = chain;
    return {
      host: '127.0.0.1',
      port,
      release: () => {
        if (released) return;
        released = true;
        server.close();
        this.releaseChain(chainRef);
      },
    };
  }

  /** Close everything, for shutdown. */
  closeAll(): void {
    for (const chain of this.chains.values()) {
      chain.dead = true;
      for (const c of chain.clients) c.end();
    }
    this.chains.clear();
  }

  private releaseChain(chain: Chain): void {
    chain.users--;
    if (chain.users > 0) return;
    chain.dead = true;
    this.chains.delete(chain.key);
    for (const c of chain.clients) c.end();
    this.log(`[ssh] closed session chain ${chain.key}`);
  }

  private forward(
    client: Client,
    lastHop: ResolvedHop,
    target: TunnelTarget,
    socket: Socket,
  ): void {
    const onStream = (err: Error | undefined, stream: Duplex): void => {
      if (err) {
        this.log(`[ssh] ${lastHop.label}: forward failed: ${err.message}`);
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      socket.on('error', () => stream.destroy());
      stream.on('error', () => socket.destroy());
      stream.on('close', () => socket.destroy());
      socket.on('close', () => stream.destroy());
    };
    if ('socketPath' in target) {
      client.openssh_forwardOutStreamLocal(target.socketPath, onStream);
    } else {
      client.forwardOut('127.0.0.1', socket.remotePort ?? 0, target.host, target.port, onStream);
    }
  }

  /** Apply ~/.ssh/config to each hop and expand ProxyJump into real hops. */
  private expand(hops: SshHop[], secrets: HopSecrets[]): ResolvedHop[] {
    const config = this.opts.config ?? loadUserSshConfig(this.home);
    const out: ResolvedHop[] = [];
    const visit = (hop: SshHop, hopSecrets: HopSecrets, depth: number): void => {
      if (out.length >= MAX_HOPS || depth > MAX_HOPS) {
        throw new SshError('NETWORK', hop.host, `Jump chain longer than ${MAX_HOPS} hops`);
      }
      const cfg = resolveSshHost(config, hop.host, this.home);
      for (const jump of cfg.proxyJump) {
        const j: SshHop = { host: jump.host };
        if (jump.user) j.user = jump.user;
        if (jump.port) j.port = jump.port;
        visit(j, {}, depth + 1);
      }
      const keyPaths = [
        ...(hop.keyPath ? [expandHome(hop.keyPath, this.home)] : []),
        ...cfg.identityFiles,
        ...(cfg.identitiesOnly ? [] : defaultIdentityFiles(this.home)),
      ];
      const user = hop.user || cfg.user || userInfo().username;
      const port = hop.port || cfg.port || 22;
      out.push({
        label: `${user}@${cfg.hostName}:${port}`,
        host: cfg.hostName,
        port,
        user,
        auth: hop.auth ?? 'auto',
        keyPaths: [...new Set(keyPaths)],
        secrets: hopSecrets,
      });
    };
    hops.forEach((hop, i) => visit(hop, secrets[i] ?? {}, 0));
    return out;
  }

  private startChain(key: string, hops: ResolvedHop[]): Chain {
    const chain: Chain = {
      key,
      clients: [],
      users: 0,
      ready: Promise.reject(new Error('unset')),
      dead: false,
    };
    chain.ready.catch(() => undefined);
    chain.ready = (async () => {
      let previous: Client | null = null;
      for (const hop of hops) {
        let sock: Duplex | undefined;
        if (previous) sock = await this.forwardFor(previous, hop);
        const client = await this.connectHop(hop, sock);
        client.on('close', () => {
          if (!chain.dead) {
            chain.dead = true;
            this.log(`[ssh] ${hop.label}: session closed`);
          }
        });
        chain.clients.push(client);
        previous = client;
      }
      return previous as Client;
    })();
    chain.ready.catch(() => {
      chain.dead = true;
      for (const c of chain.clients) c.end();
    });
    return chain;
  }

  private forwardFor(previous: Client, hop: ResolvedHop): Promise<Duplex> {
    return new Promise((res, rej) => {
      previous.forwardOut('127.0.0.1', 0, hop.host, hop.port, (err, stream) => {
        if (err)
          rej(
            new SshError(
              'FORWARD_FAILED',
              hop.label,
              `jump host could not reach it: ${err.message}`,
              { cause: err },
            ),
          );
        else res(stream);
      });
    });
  }

  private async connectHop(hop: ResolvedHop, sock: Duplex | undefined): Promise<Client> {
    const methods = await this.authMethods(hop);
    if (!methods.length) {
      throw new SshError(
        'AUTH_FAILED',
        hop.label,
        'no usable credentials: no agent, no readable key, no password',
      );
    }
    let tried = -1;
    const authHandler: AuthHandlerMiddleware = (_methodsLeft, _partial, cb) => {
      tried++;
      const next = methods[tried];
      if (!next) return (cb as unknown as (done: false) => void)(false);
      this.log(`[ssh] ${hop.label}: trying ${next.type}${next.detail ? ` (${next.detail})` : ''}`);
      return cb(next.method);
    };

    let hostKeyError: SshError | null = null;
    const client = new Client();
    const config: ConnectConfig = {
      username: hop.user,
      readyTimeout: this.opts.readyTimeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
      authHandler,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        void this.verifyHost(hop, key)
          .then((ok) => verify(ok))
          .catch((err: unknown) => {
            hostKeyError =
              err instanceof SshError
                ? err
                : new SshError('HOST_KEY_UNKNOWN', hop.label, String(err));
            verify(false);
          });
      },
    };
    if (sock) config.sock = sock;
    else {
      config.host = hop.host;
      config.port = hop.port;
    }

    return new Promise<Client>((res, rej) => {
      const fail = (err: SshError): void => {
        client.end();
        rej(err);
      };
      client.once('ready', () => {
        const used = methods[tried];
        this.log(
          `[ssh] ${hop.label}: authenticated with ${used?.type ?? 'unknown'}${used?.detail ? ` (${used.detail})` : ''}`,
        );
        res(client);
      });
      client.once('error', (err: Error & { level?: string }) => {
        if (hostKeyError) return fail(hostKeyError);
        if (/All configured authentication methods failed/i.test(err.message)) {
          return fail(
            new SshError(
              'AUTH_FAILED',
              hop.label,
              `authentication failed (tried ${methods.map((m) => m.type).join(', ')})`,
              { cause: err },
            ),
          );
        }
        if (/Timed out while waiting for handshake/i.test(err.message)) {
          return fail(
            new SshError('TIMEOUT', hop.label, 'no SSH handshake within the time limit', {
              cause: err,
            }),
          );
        }
        if (/Host key verification failed|verification failed/i.test(err.message)) {
          return fail(
            new SshError('HOST_KEY_UNKNOWN', hop.label, 'host key was not accepted', {
              cause: err,
            }),
          );
        }
        fail(new SshError('NETWORK', hop.label, err.message, { cause: err }));
      });
      client.connect(config);
    });
  }

  private async authMethods(
    hop: ResolvedHop,
  ): Promise<Array<{ type: AuthenticationType; detail?: string; method: AuthMethodObject }>> {
    const env = this.opts.env ?? process.env;
    const out: Array<{ type: AuthenticationType; detail?: string; method: AuthMethodObject }> = [];
    const wants = (m: NonNullable<SshHop['auth']>): boolean =>
      hop.auth === 'auto' || hop.auth === m;

    if (wants('agent') && env['SSH_AUTH_SOCK']) {
      out.push({
        type: 'agent',
        method: { type: 'agent', username: hop.user, agent: env['SSH_AUTH_SOCK'] },
      });
    }
    if (wants('key')) {
      for (const path of hop.keyPaths) {
        let raw: Buffer;
        try {
          raw = readFileSync(path);
        } catch {
          continue;
        }
        const parsed = utils.parseKey(raw, hop.secrets.passphrase);
        if (parsed instanceof Error) {
          this.log(`[ssh] ${hop.label}: skipping ${path}: ${parsed.message}`);
          continue;
        }
        const method: AuthMethodObject = { type: 'publickey', username: hop.user, key: raw };
        if (hop.secrets.passphrase !== undefined) method.passphrase = hop.secrets.passphrase;
        out.push({ type: 'publickey', detail: path, method });
      }
    }
    if (wants('password') && hop.secrets.password !== undefined) {
      out.push({
        type: 'password',
        method: { type: 'password', username: hop.user, password: hop.secrets.password },
      });
    }
    return out;
  }

  private knownHostsFiles(): string[] {
    return [join(this.home, '.ssh', 'known_hosts'), join(this.opts.userDataDir, 'known_hosts')];
  }

  private async verifyHost(hop: ResolvedHop, key: Buffer): Promise<boolean> {
    const entries = this.knownHostsFiles().flatMap((file) => {
      try {
        return parseKnownHosts(readFileSync(file, 'utf8'), file);
      } catch {
        return [];
      }
    });
    const verdict = verifyKnownHost(entries, hop.host, hop.port, key);
    switch (verdict.status) {
      case 'match':
        return true;
      case 'revoked':
        throw new SshError(
          'HOST_KEY_REVOKED',
          hop.label,
          `host key is marked @revoked in ${verdict.entry.file}:${verdict.entry.line}`,
        );
      case 'mismatch':
        throw new SshError(
          'HOST_KEY_CHANGED',
          hop.label,
          `host key ${fingerprint(key)} (${keyTypeOf(key)}) does not match ${verdict.entry.file}:${verdict.entry.line}. ` +
            'Someone could be intercepting the connection, or the server was reinstalled. Refusing to connect.',
        );
      case 'unknown': {
        const ok = await this.opts.confirmUnknownHost({
          host: hop.host,
          port: hop.port,
          keyType: keyTypeOf(key),
          fingerprint: fingerprint(key),
        });
        if (!ok)
          throw new SshError(
            'HOST_KEY_UNKNOWN',
            hop.label,
            `host key ${fingerprint(key)} was not accepted`,
          );
        const own = join(this.opts.userDataDir, 'known_hosts');
        mkdirSync(this.opts.userDataDir, { recursive: true });
        appendFileSync(own, `${formatKnownHostLine(hop.host, hop.port, key)}\n`, { mode: 0o600 });
        this.log(
          `[ssh] ${hop.label}: host key ${fingerprint(key)} accepted and recorded in ${own}`,
        );
        return true;
      }
    }
  }
}

/** The object form ssh2 accepts from an authHandler. */
type AuthMethodObject =
  | { type: 'agent'; username: string; agent: string }
  | { type: 'publickey'; username: string; key: Buffer; passphrase?: string }
  | { type: 'password'; username: string; password: string };
