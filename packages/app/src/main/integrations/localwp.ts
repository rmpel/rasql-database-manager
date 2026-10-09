import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import type { LocalAddonStatus, LocalSite, PendingConnection } from '@shared/api';

export const ADDON_NAME = 'rasql-localwp';

/** Local keeps its data where Electron apps keep theirs, so the same lookup works on every OS. */
export function localDataDir(): string {
  return join(app.getPath('appData'), 'Local');
}

/**
 * Where the add-on folder ships inside RaSQL: extraResources when packaged, the workspace build in
 * development. The dev path is relative to the bundled main file (packages/app/out/main), because
 * app.getAppPath() points at that bundle directory when Electron is started on a script.
 */
export function bundledAddonDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'localwp-addon')
    : resolve(__dirname, '../../../localwp-addon/dist');
}

interface LocalService {
  name?: string;
  role?: string;
  ports?: Record<string, number[] | number>;
}

interface SitesJson {
  [id: string]: {
    id: string;
    name: string;
    domain?: string;
    path?: string;
    mysql?: { database?: string; user?: string; password?: string };
    /** Keyed by service name: mysql, mariadb, php, apache, nginx, mailpit… */
    services?: Record<string, LocalService | undefined>;
  };
}

/** The site's database service, whatever Local named it (mysql, mariadb, …). */
function dbService(
  services: Record<string, LocalService | undefined> | undefined,
): LocalService | undefined {
  const all = services ?? {};
  return (
    Object.values(all).find((s) => s?.role === 'db') ??
    all['mysql'] ??
    all['mariadb'] ??
    Object.values(all).find((s) => /mysql|maria/i.test(s?.name ?? ''))
  );
}

function dbPort(
  services: Record<string, LocalService | undefined> | undefined,
): number | undefined {
  const ports = dbService(services)?.ports ?? {};
  const first = (v: number[] | number | undefined): number | undefined =>
    Array.isArray(v) ? v[0] : typeof v === 'number' ? v : undefined;
  return (
    first(ports['MYSQL'] ?? ports['MARIADB'] ?? ports['DB']) ??
    Object.values(ports)
      .map(first)
      .find((n) => n !== undefined)
  );
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const versionOf = (dir: string): string | undefined =>
  readJson<{ version?: string }>(join(dir, 'package.json'), {}).version;

export function isLocalPresent(dataDir = localDataDir()): boolean {
  return existsSync(join(dataDir, 'sites.json'));
}

export function addonStatus(
  dataDir = localDataDir(),
  bundledDir = bundledAddonDir(),
): LocalAddonStatus {
  const addonDir = join(dataDir, 'addons', ADDON_NAME);
  const installedVersion = existsSync(addonDir) ? versionOf(addonDir) : undefined;
  const bundledVersion = versionOf(bundledDir) ?? '0.0.0';
  const enabled =
    readJson<Record<string, boolean>>(join(dataDir, 'enabled-addons.json'), {})[ADDON_NAME] ===
    true;
  const status: LocalAddonStatus = {
    localPresent: isLocalPresent(dataDir),
    bundledAvailable: existsSync(join(bundledDir, 'main.js')),
    installed: installedVersion !== undefined,
    enabled,
    bundledVersion,
    needsUpdate: installedVersion !== undefined && installedVersion !== bundledVersion,
    addonDir,
  };
  if (installedVersion !== undefined) status.installedVersion = installedVersion;
  return status;
}

function setEnabled(dataDir: string, enabled: boolean): void {
  const file = join(dataDir, 'enabled-addons.json');
  const flags = readJson<Record<string, boolean>>(file, {});
  if (enabled) flags[ADDON_NAME] = true;
  else delete flags[ADDON_NAME];
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(flags));
  renameSync(tmp, file);
}

/** Copy, never symlink: symlinks need elevated rights on Windows. Local loads it on its next start. */
export function installAddon(
  dataDir = localDataDir(),
  bundledDir = bundledAddonDir(),
): LocalAddonStatus {
  if (!isLocalPresent(dataDir))
    throw new Error('Local is not installed, or has never been started, on this machine');
  if (!existsSync(join(bundledDir, 'main.js')))
    throw new Error(`The bundled add-on is missing at ${bundledDir}`);
  const target = join(dataDir, 'addons', ADDON_NAME);
  mkdirSync(join(dataDir, 'addons'), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(bundledDir, target, { recursive: true });
  setEnabled(dataDir, true);
  return addonStatus(dataDir, bundledDir);
}

export function uninstallAddon(
  dataDir = localDataDir(),
  bundledDir = bundledAddonDir(),
): LocalAddonStatus {
  rmSync(join(dataDir, 'addons', ADDON_NAME), { recursive: true, force: true });
  if (existsSync(join(dataDir, 'enabled-addons.json'))) setEnabled(dataDir, false);
  return addonStatus(dataDir, bundledDir);
}

/** Every site Local knows about, with how to reach its database. No add-on needed for this. */
export function discoverSites(dataDir = localDataDir()): LocalSite[] {
  const sites = readJson<SitesJson>(join(dataDir, 'sites.json'), {});
  return Object.values(sites)
    .map((s): LocalSite => {
      // Local keeps the socket (macOS, Linux) or the service's run directory (Windows) only while
      // the site runs. The directory is named after the service: mysql, or mariadb for MariaDB sites.
      const svcDir = dbService(s.services)?.name;
      const dirs = [
        ...new Set(['mysql', 'mariadb', svcDir].filter((d): d is string => Boolean(d))),
      ];
      const socketPath =
        process.platform === 'win32'
          ? undefined
          : (dirs
              .map((d) => join(dataDir, 'run', s.id, d, 'mysqld.sock'))
              .find((p) => existsSync(p)) ??
            join(dataDir, 'run', s.id, dirs[0] as string, 'mysqld.sock'));
      const running =
        process.platform === 'win32'
          ? dirs.some((d) => existsSync(join(dataDir, 'run', s.id, d)))
          : socketPath !== undefined && existsSync(socketPath);
      const site: LocalSite = {
        id: s.id,
        name: s.name,
        database: s.mysql?.database ?? 'local',
        user: s.mysql?.user ?? 'root',
        password: s.mysql?.password ?? 'root',
        running,
      };
      if (s.domain) site.domain = s.domain;
      if (s.path) site.path = s.path;
      if (socketPath) site.socketPath = socketPath;
      const port = dbPort(s.services);
      if (port !== undefined) site.port = port;
      return site;
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

export function pendingConnectionFor(site: LocalSite): PendingConnection {
  const useSocket = site.running && site.socketPath !== undefined;
  const definition: PendingConnection['definition'] = {
    driver: 'mysql',
    transport: useSocket ? 'socket' : 'tcp',
    name: site.name,
    environment: 'local',
    user: site.user,
    database: site.database,
    source: 'localwp',
  };
  if (useSocket) definition.socketPath = site.socketPath as string;
  else {
    definition.host = '127.0.0.1';
    if (site.port !== undefined) definition.port = site.port;
  }
  return { definition, password: site.password, autoConnect: true };
}
