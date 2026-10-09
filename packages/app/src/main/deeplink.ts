import { extname } from 'node:path';
import type { PendingConnection } from '@shared/api';
import { SQLITE_FILE_EXTENSIONS } from '@rasql/driver-sqlite';

/**
 * Every door into the app (docs/ARCHITECTURE.md section 7) ends up here as a PendingConnection.
 * Passwords found in URLs are returned once and never logged.
 */
export function parseLaunchArgument(arg: string): PendingConnection | null {
  if (/^(rasql|mysql|mariadb|sqlite):\/\//i.test(arg)) return parseUrl(arg);
  const ext = extname(arg).replace(/^\./, '').toLowerCase();
  if (SQLITE_FILE_EXTENSIONS.includes(ext)) {
    return {
      definition: {
        driver: 'sqlite',
        transport: 'file',
        filePath: arg,
        name: arg.split('/').pop() ?? arg,
        source: 'cli',
      },
      autoConnect: true,
    };
  }
  return null;
}

export function parseUrl(raw: string): PendingConnection | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const q = url.searchParams;

  if (scheme === 'rasql') {
    const action = url.hostname || url.pathname.replace(/^\/+/, '');
    if (action === 'open') {
      const file = q.get('file');
      if (!file) return null;
      return {
        definition: {
          driver: 'sqlite',
          transport: 'file',
          filePath: file,
          name: q.get('name') ?? file,
          source: 'deep-link',
        },
        autoConnect: true,
      };
    }
    if (action !== 'connect') return null;
    const driver = q.get('driver') ?? 'mysql';
    const socket = q.get('socket');
    const def: PendingConnection['definition'] = {
      driver,
      transport: socket ? 'socket' : 'tcp',
      source: 'deep-link',
    };
    if (socket) def.socketPath = socket;
    if (q.get('host')) def.host = q.get('host') as string;
    if (q.get('port')) def.port = Number(q.get('port'));
    if (q.get('user')) def.user = q.get('user') as string;
    if (q.get('database')) def.database = q.get('database') as string;
    if (q.get('name')) def.name = q.get('name') as string;
    if (q.get('color')) def.color = q.get('color') as string;
    const env = q.get('env');
    if (env && ['local', 'development', 'staging', 'production', 'other'].includes(env)) {
      def.environment = env as NonNullable<typeof def.environment>;
    }
    if (q.get('readonly') === '1' || q.get('readonly') === 'true') def.readOnly = true;
    const pending: PendingConnection = { definition: def, autoConnect: q.get('connect') !== '0' };
    const password = q.get('password');
    if (password) pending.password = password;
    return pending;
  }

  if (scheme === 'mysql' || scheme === 'mariadb') {
    const def: PendingConnection['definition'] = {
      driver: 'mysql',
      transport: q.get('socket') ? 'socket' : 'tcp',
      host: url.hostname || 'localhost',
      source: 'deep-link',
    };
    if (q.get('socket')) def.socketPath = q.get('socket') as string;
    if (url.port) def.port = Number(url.port);
    if (url.username) def.user = decodeURIComponent(url.username);
    const database = url.pathname.replace(/^\/+/, '');
    if (database) def.database = decodeURIComponent(database);
    def.name = q.get('name') ?? `${def.user ?? ''}@${def.host}${database ? `/${database}` : ''}`;
    const pending: PendingConnection = { definition: def, autoConnect: true };
    if (url.password) pending.password = decodeURIComponent(url.password);
    return pending;
  }

  if (scheme === 'sqlite') {
    const file = decodeURIComponent(url.pathname) || q.get('file');
    if (!file) return null;
    return {
      definition: {
        driver: 'sqlite',
        transport: 'file',
        filePath: file,
        name: file.split('/').pop() ?? file,
        source: 'deep-link',
      },
      autoConnect: true,
    };
  }
  return null;
}

/** Strip anything secret before a URL is written to a log. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    if (u.searchParams.has('password')) u.searchParams.set('password', '***');
    return u.toString();
  } catch {
    return raw;
  }
}
