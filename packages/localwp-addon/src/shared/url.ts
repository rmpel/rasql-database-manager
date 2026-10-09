/** The subset of a Local site record this add-on reads. Mirrors sites.json and the Site type. */
export interface LocalSiteLike {
  id: string;
  name: string;
  mysql?: { database?: string; user?: string; password?: string };
  services?: { mysql?: { ports?: { MYSQL?: number[] } } };
}

export interface ConnectionTarget {
  /** Unix socket path, used on macOS and Linux when it exists. */
  socketPath?: string;
  /** Local's per-site TCP port, the only option on Windows and a fallback elsewhere. */
  port?: number;
}

export const IPC_OPEN = 'rasql:open-site';
export const IPC_STATUS = 'rasql:status';
export const IPC_OPEN_RELEASES = 'rasql:open-releases';
export const RASQL_RELEASES_URL = 'https://github.com/rmpel/rasql-database-manager/releases';

/** Build the rasql://connect URL for a Local site. Socket wins when present. */
export function buildConnectUrl(site: LocalSiteLike, target: ConnectionTarget): string {
  const url = new URL('rasql://connect');
  const q = url.searchParams;
  q.set('driver', 'mysql');
  q.set('name', site.name);
  q.set('env', 'local');
  q.set('user', site.mysql?.user ?? 'root');
  q.set('password', site.mysql?.password ?? 'root');
  q.set('database', site.mysql?.database ?? 'local');
  if (target.socketPath) {
    q.set('socket', target.socketPath);
  } else if (target.port !== undefined) {
    q.set('host', '127.0.0.1');
    q.set('port', String(target.port));
  } else {
    throw new Error(`Site ${site.name} has neither a socket path nor a MySQL port`);
  }
  return url.toString();
}

export function mysqlPort(site: LocalSiteLike): number | undefined {
  return site.services?.mysql?.ports?.MYSQL?.[0];
}
