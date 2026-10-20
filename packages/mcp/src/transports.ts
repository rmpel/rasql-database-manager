import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import {
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpCore } from './core.js';

/** Newline-delimited JSON-RPC over a local socket: what `rasql mcp` relays from stdio. */
export class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  private closed = false;

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (err) {
          this.onerror?.(err as Error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.socket.on('error', (err) => this.onerror?.(err));
    this.socket.on('close', () => this.finish());
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed || this.socket.destroyed) return resolve();
      if (this.socket.write(serializeMessage(message))) resolve();
      else this.socket.once('drain', () => resolve());
    });
  }

  async close(): Promise<void> {
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}

/**
 * Listen on the local IPC socket (a Unix socket, or a named pipe on Windows). The socket
 * file is readable by the current user only.
 */
export async function listenOnSocket(
  core: McpCore,
  path: string,
  log: (line: string) => void,
): Promise<NetServer> {
  if (process.platform !== 'win32' && existsSync(path)) {
    // A socket left behind by a crash. The single-instance lock means nobody else owns it.
    try {
      unlinkSync(path);
    } catch {
      /* listen reports it */
    }
  }
  const server = createNetServer((socket) => {
    const mcp = core.createServer();
    void mcp.connect(new SocketTransport(socket)).catch((err: unknown) => {
      log(`[mcp] socket client failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  log(`[mcp] listening on ${path}`);
  return server;
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const given = Buffer.from((m[1] as string).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Streamable HTTP on 127.0.0.1 only, for clients that cannot start a process. Every request
 * carries the per-install token; Host and Origin are checked against DNS rebinding.
 */
export async function listenOnHttp(
  core: McpCore,
  opts: { port: number; token: () => string; log: (line: string) => void },
): Promise<HttpServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const hosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (!bearerMatches(req, opts.token())) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('A RaSQL MCP token is required');
        return;
      }
      const sessionId = req.headers['mcp-session-id'];
      let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!transport) {
        if (sessionId !== undefined) {
          res.writeHead(404).end('Unknown session');
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: hosts,
          allowedOrigins: [`http://${hosts[0]}`, `http://${hosts[1]}`],
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        created.onclose = () => {
          if (created.sessionId) sessions.delete(created.sessionId);
        };
        // The SDK's own class trips exactOptionalPropertyTypes against its Transport interface.
        await core.createServer().connect(created as unknown as Transport);
        transport = created;
      }
      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      opts.log(`[mcp] http request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('close', () => {
    for (const t of sessions.values()) void t.close();
    sessions.clear();
  });
  opts.log(`[mcp] http listening on 127.0.0.1:${opts.port}`);
  return server;
}

/**
 * `rasql mcp`: relay stdio to the running app's socket. Starts the app when it is not
 * running and waits for the socket to appear. Bytes pass through untouched.
 */
export async function runBridge(opts: {
  path: string;
  launchApp: () => void;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Milliseconds to wait for the app to come up. */
  timeoutMs?: number;
}): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const attempt = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = connect(opts.path);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(socket);
      });
      socket.once('error', reject);
    });
  let socket: Socket;
  try {
    socket = await attempt();
  } catch {
    opts.launchApp();
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        socket = await attempt();
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          process.stderr.write(
            `RaSQL did not start its MCP socket at ${opts.path}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return 1;
        }
      }
    }
  }
  return new Promise<number>((resolve) => {
    stdin.pipe(socket);
    socket.pipe(stdout as NodeJS.WritableStream, { end: false });
    stdin.on('end', () => socket.end());
    socket.on('close', () => resolve(0));
    socket.on('error', (err) => {
      process.stderr.write(`RaSQL MCP connection failed: ${err.message}\n`);
      resolve(1);
    });
  });
}
