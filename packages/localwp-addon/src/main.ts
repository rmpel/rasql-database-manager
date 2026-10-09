import * as path from 'path';
import * as fs from 'fs';
import * as LocalMain from '@getflywheel/local/main';
import {
  buildConnectUrl,
  mysqlPort,
  IPC_OPEN,
  IPC_OPEN_RELEASES,
  IPC_STATUS,
  RASQL_RELEASES_URL,
  type LocalSiteLike,
  dbService,
} from './shared/url';

// Local's main process is Electron; the add-on borrows what it needs without a dependency.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require('electron') as {
  app: { getPath(name: 'userData'): string; getApplicationNameForProtocol(url: string): string };
  shell: { openExternal(url: string): Promise<void> };
};

export interface RasqlStatus {
  /** Name of the app registered for rasql:// URLs, empty when none. */
  handler: string;
  installed: boolean;
}

function socketPathFor(siteId: string, site: LocalSiteLike): string | undefined {
  if (process.platform === 'win32') return undefined;
  const run = path.join(electron.app.getPath('userData'), 'run', siteId);
  const dirs = ['mysql', 'mariadb', dbService(site)?.name ?? ''].filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(run, dir, 'mysqld.sock');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export default function (context: LocalMain.AddonMainContext): void {
  const { siteData, localLogger } = LocalMain.getServiceContainer().cradle as {
    siteData: { getSite(id: string): LocalSiteLike };
    localLogger: { info(msg: string): void; warn(msg: string): void };
  };
  void context;

  LocalMain.addIpcAsyncListener(IPC_STATUS, async (): Promise<RasqlStatus> => {
    const handler = electron.app.getApplicationNameForProtocol('rasql://');
    return { handler, installed: handler !== '' };
  });

  LocalMain.addIpcAsyncListener(IPC_OPEN_RELEASES, async (): Promise<void> => {
    await electron.shell.openExternal(RASQL_RELEASES_URL);
  });

  LocalMain.addIpcAsyncListener(IPC_OPEN, async (siteId: string): Promise<void> => {
    const site = siteData.getSite(siteId);
    const target = { socketPath: socketPathFor(site.id, site), port: mysqlPort(site) };
    if (!target.socketPath && target.port === undefined) {
      const seen = Object.entries(site.services ?? {})
        .map(
          ([k, v]) =>
            `${k}(${v?.name ?? '?'}/${v?.role ?? '?'}: ${JSON.stringify(v?.ports ?? {})})`,
        )
        .join(', ');
      throw new Error(
        `Site ${site.name} has neither a socket path nor a database port. Services seen: ${seen || 'none'}`,
      );
    }
    const url = buildConnectUrl(site, target);
    localLogger.info(
      `[rasql] opening ${site.name} in RaSQL via ${target.socketPath ? 'socket' : 'tcp'}`,
    );
    await electron.shell.openExternal(url);
  });
}
