import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server, utils, type AuthContext, type Connection, type ParsedKey } from 'ssh2';
import { formatKnownHostLine } from './known-hosts';
import { SshError, SshTunnelManager, type UnknownHostInfo } from './tunnel';
import { CLIENT_KEY, HOST_KEYS, type TestKeyPair } from './test-keys';

let nextHostKey = 0;

interface TestSshServer {
  port: number;
  hostKey: Buffer;
  connections: number;
  closed: number;
  close(): Promise<void>;
}

function parse(text: string): ParsedKey {
  const k = utils.parseKey(text);
  if (k instanceof Error) throw k;
  return k;
}

/** An in-process sshd that forwards TCP and Unix-socket requests like OpenSSH would. */
function startSshServer(opts: {
  password?: string;
  allowKey?: ParsedKey;
  /** Fixed host key; servers without one rotate through the pool's middle keys. */
  hostKeyPair?: TestKeyPair;
}): Promise<TestSshServer> {
  // Key 0 is the real sshd's, key 3 the impostor's; the rest cycle through 1 and 2.
  const pair = opts.hostKeyPair ?? (HOST_KEYS[1 + (nextHostKey++ % 2)] as TestKeyPair);
  const hostKey = parse(pair.private).getPublicSSH();
  const state = { connections: 0, closed: 0 };
  const live = new Set<Connection>();
  const server = new Server({ hostKeys: [pair.private] }, (conn) => {
    state.connections++;
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    conn.on('error', () => undefined); // a client that rejects our host key disconnects mid-KEX
    conn.on('close', () => state.closed++);
    conn.on('authentication', (ctx: AuthContext) => {
      if (
        ctx.method === 'password' &&
        opts.password !== undefined &&
        ctx.password === opts.password
      )
        return ctx.accept();
      if (ctx.method === 'publickey' && opts.allowKey) {
        const allowed = opts.allowKey;
        if (ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH()))
          return ctx.reject();
        if (!ctx.signature || !ctx.blob) return ctx.accept();
        return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject();
    });
    conn.on('ready', () => {
      conn.on('tcpip', (accept, reject, info) => {
        const out = createConnection({ host: info.destIP, port: info.destPort });
        out.once('error', () => reject());
        out.once('connect', () => {
          const ch = accept();
          ch.pipe(out).pipe(ch);
        });
      });
      conn.on('openssh.streamlocal', (accept, reject, info) => {
        const out = createConnection({ path: info.socketPath });
        out.once('error', () => reject());
        out.once('connect', () => {
          const ch = accept();
          ch.pipe(out).pipe(ch);
        });
      });
    });
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      res({
        port,
        hostKey,
        get connections() {
          return state.connections;
        },
        get closed() {
          return state.closed;
        },
        close: () =>
          new Promise<void>((r) => {
            for (const c of live) c.end();
            server.close(() => r());
            setTimeout(r, 1000).unref();
          }),
      });
    });
  });
}

function echoServer(path?: string): Promise<{ port: number; server: NetServer }> {
  const server = createServer((s: Socket) => s.pipe(s));
  return new Promise((res) => {
    if (path) server.listen(path, () => res({ port: 0, server }));
    else
      server.listen(0, '127.0.0.1', () =>
        res({ port: (server.address() as AddressInfo).port, server }),
      );
  });
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((res, rej) => {
    const s = createConnection({ host: '127.0.0.1', port });
    let got = '';
    s.on('data', (d) => {
      got += d.toString();
      if (got.length >= payload.length) {
        s.end();
        res(got);
      }
    });
    s.on('error', rej);
    s.on('connect', () => s.write(payload));
    setTimeout(() => rej(new Error('round trip timed out')), 4000);
  });
}

let dir: string;
let home: string;
let userData: string;
let sshd: TestSshServer;
let jump: TestSshServer;
let echo: { port: number; server: NetServer };
let clientKey: { private: string; public: string };

const manager = (confirm?: (info: UnknownHostInfo) => Promise<boolean>): SshTunnelManager =>
  new SshTunnelManager({
    home,
    userDataDir: userData,
    confirmUnknownHost: confirm ?? (async () => false),
    env: {},
    config: [],
    readyTimeoutMs: 5000,
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rasql-ssh-'));
  home = join(dir, 'home');
  userData = join(dir, 'userData');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  clientKey = CLIENT_KEY;
  writeFileSync(join(home, '.ssh', 'id_ed25519'), clientKey.private, { mode: 0o600 });
  sshd = await startSshServer({
    password: 'secret',
    allowKey: parse(clientKey.private),
    hostKeyPair: HOST_KEYS[0] as TestKeyPair,
  });
  jump = await startSshServer({ password: 'secret' });
  echo = await echoServer();
  writeFileSync(
    join(home, '.ssh', 'known_hosts'),
    `${formatKnownHostLine('127.0.0.1', sshd.port, sshd.hostKey)}\n${formatKnownHostLine('127.0.0.1', jump.port, jump.hostKey)}\n`,
  );
});

afterAll(async () => {
  echo.server.close();
  await sshd.close();
  await jump.close();
  rmSync(dir, { recursive: true, force: true });
});

const hop = (
  port: number,
  extra: Record<string, unknown> = {},
): { host: string; port: number; user: string } & Record<string, unknown> => ({
  host: '127.0.0.1',
  port,
  user: 'tester',
  ...extra,
});

describe('SshTunnelManager', () => {
  it('forwards TCP through one hop with password auth', async () => {
    const m = manager();
    const t = await m.open(
      [hop(sshd.port, { auth: 'password' })],
      { host: '127.0.0.1', port: echo.port },
      [{ password: 'secret' }],
    );
    try {
      expect(await roundTrip(t.port, 'hello through ssh')).toBe('hello through ssh');
    } finally {
      t.release();
    }
  });

  it('authenticates with the default key file when no password is given', async () => {
    const m = manager();
    const t = await m.open([hop(sshd.port)], { host: '127.0.0.1', port: echo.port });
    try {
      expect(await roundTrip(t.port, 'key auth')).toBe('key auth');
    } finally {
      t.release();
    }
  });

  it('chains two hops through a jump host', async () => {
    const m = manager();
    const t = await m.open(
      [hop(jump.port, { auth: 'password' }), hop(sshd.port, { auth: 'password' })],
      { host: '127.0.0.1', port: echo.port },
      [{ password: 'secret' }, { password: 'secret' }],
    );
    try {
      expect(await roundTrip(t.port, 'via jump')).toBe('via jump');
    } finally {
      t.release();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'forwards to a Unix socket on the remote side',
    async () => {
      const sockPath = join(dir, 'echo.sock');
      const unix = await echoServer(sockPath);
      const m = manager();
      const t = await m.open([hop(sshd.port, { auth: 'password' })], { socketPath: sockPath }, [
        { password: 'secret' },
      ]);
      try {
        expect(await roundTrip(t.port, 'unix socket')).toBe('unix socket');
      } finally {
        t.release();
        unix.server.close();
      }
    },
  );

  it('asks about an unknown host once, then remembers it in its own known_hosts', async () => {
    const fresh = await startSshServer({ password: 'secret' });
    try {
      const confirm = vi.fn(async (info: UnknownHostInfo) => {
        expect(info.keyType).toBe('ssh-ed25519');
        expect(info.fingerprint).toMatch(/^SHA256:/);
        return true;
      });
      const m = manager(confirm);
      const t1 = await m.open(
        [hop(fresh.port, { auth: 'password' })],
        { host: '127.0.0.1', port: echo.port },
        [{ password: 'secret' }],
      );
      t1.release();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(userData, 'known_hosts'), 'utf8')).toContain(
        `[127.0.0.1]:${fresh.port} ssh-ed25519`,
      );
      const t2 = await manager(confirm).open(
        [hop(fresh.port, { auth: 'password' })],
        { host: '127.0.0.1', port: echo.port },
        [{ password: 'secret' }],
      );
      t2.release();
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      await fresh.close();
    }
  });

  it('refuses an unknown host when the user declines', async () => {
    const fresh = await startSshServer({ password: 'secret' });
    try {
      await expect(
        manager(async () => false).open(
          [hop(fresh.port, { auth: 'password' })],
          { host: '127.0.0.1', port: echo.port },
          [{ password: 'secret' }],
        ),
      ).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' });
    } finally {
      await fresh.close();
    }
  });

  it('refuses a changed host key without asking', async () => {
    const impostor = await startSshServer({
      password: 'secret',
      hostKeyPair: HOST_KEYS[3] as TestKeyPair,
    });
    try {
      const confirm = vi.fn(async () => true);
      // known_hosts claims this port belongs to sshd's key; the impostor presents another one.
      writeFileSync(
        join(home, '.ssh', 'known_hosts'),
        `${formatKnownHostLine('127.0.0.1', impostor.port, sshd.hostKey)}\n`,
      );
      const err = await manager(confirm)
        .open([hop(impostor.port, { auth: 'password' })], { host: '127.0.0.1', port: echo.port }, [
          { password: 'secret' },
        ])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SshError);
      expect((err as SshError).code).toBe('HOST_KEY_CHANGED');
      expect((err as SshError).message).toContain('known_hosts:1');
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      writeFileSync(
        join(home, '.ssh', 'known_hosts'),
        `${formatKnownHostLine('127.0.0.1', sshd.port, sshd.hostKey)}\n${formatKnownHostLine('127.0.0.1', jump.port, jump.hostKey)}\n`,
      );
      await impostor.close();
    }
  });

  it('reports a wrong password as AUTH_FAILED naming the hop', async () => {
    const err = await manager()
      .open([hop(sshd.port, { auth: 'password' })], { host: '127.0.0.1', port: echo.port }, [
        { password: 'nope' },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).code).toBe('AUTH_FAILED');
    expect((err as SshError).message).toContain('tester@127.0.0.1');
  });

  it('shares one SSH session per chain and closes it with the last release', async () => {
    // A server of its own, so closes from earlier tests cannot leak into the counts.
    const own = await startSshServer({ password: 'secret' });
    try {
      const m = manager(async () => true);
      const target = { host: '127.0.0.1', port: echo.port };
      const a = await m.open([hop(own.port, { auth: 'password' })], target, [
        { password: 'secret' },
      ]);
      const b = await m.open([hop(own.port, { auth: 'password' })], target, [
        { password: 'secret' },
      ]);
      expect(own.connections).toBe(1);
      expect(a.port).not.toBe(b.port);
      a.release();
      await new Promise((r) => setTimeout(r, 100));
      expect(own.closed).toBe(0);
      expect(await roundTrip(b.port, 'still up')).toBe('still up');
      b.release();
      await vi.waitFor(() => expect(own.closed).toBe(1), { timeout: 2000 });
    } finally {
      await own.close();
    }
  });

  it('refuses to reach the target when a jump cannot forward', async () => {
    const err = await manager()
      .open(
        [hop(jump.port, { auth: 'password' }), hop(1, { auth: 'password' })],
        { host: '127.0.0.1', port: echo.port },
        [{ password: 'secret' }, { password: 'secret' }],
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).code).toBe('FORWARD_FAILED');
  });
});
