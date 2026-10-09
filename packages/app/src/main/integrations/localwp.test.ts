import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', isPackaged: false, getAppPath: () => '/nonexistent' },
}));

const {
  addonStatus,
  discoverSites,
  installAddon,
  pendingConnectionFor,
  uninstallAddon,
  ADDON_NAME,
} = await import('./localwp');

let local: string;
let bundled: string;

beforeEach(() => {
  local = mkdtempSync(join(tmpdir(), 'rasql-local-'));
  bundled = mkdtempSync(join(tmpdir(), 'rasql-addon-'));
  writeFileSync(
    join(bundled, 'package.json'),
    JSON.stringify({ name: ADDON_NAME, version: '1.2.0' }),
  );
  writeFileSync(join(bundled, 'main.js'), '// main');
  writeFileSync(join(bundled, 'renderer.js'), '// renderer');
  mkdirSync(join(local, 'run', 'abc', 'mysql'), { recursive: true });
  writeFileSync(join(local, 'run', 'abc', 'mysql', 'mysqld.sock'), '');
  writeFileSync(
    join(local, 'sites.json'),
    JSON.stringify({
      abc: {
        id: 'abc',
        name: 'Running Site',
        domain: 'running.test',
        mysql: { database: 'local', user: 'root', password: 'root' },
        services: { mysql: { ports: { MYSQL: [10003] } } },
      },
      def: { id: 'def', name: 'Stopped Site', services: { mysql: { ports: { MYSQL: [10013] } } } },
      ghi: {
        id: 'ghi',
        name: 'Maria Site',
        services: {
          php: { name: 'php', role: 'php' },
          mariadb: { name: 'mariadb', role: 'db', ports: { MYSQL: [10023] } },
        },
      },
    }),
  );
  writeFileSync(join(local, 'enabled-addons.json'), JSON.stringify({ 'other-addon': true }));
});

afterEach(() => {
  rmSync(local, { recursive: true, force: true });
  rmSync(bundled, { recursive: true, force: true });
});

describe('LocalWP integration', () => {
  it('reports status before and after install, keeping other add-on flags', () => {
    expect(addonStatus(local, bundled)).toMatchObject({
      localPresent: true,
      bundledAvailable: true,
      installed: false,
      enabled: false,
      bundledVersion: '1.2.0',
    });
    const after = installAddon(local, bundled);
    expect(after).toMatchObject({
      installed: true,
      enabled: true,
      installedVersion: '1.2.0',
      needsUpdate: false,
    });
    expect(existsSync(join(local, 'addons', ADDON_NAME, 'renderer.js'))).toBe(true);
    expect(JSON.parse(readFileSync(join(local, 'enabled-addons.json'), 'utf8'))).toEqual({
      'other-addon': true,
      [ADDON_NAME]: true,
    });
    const gone = uninstallAddon(local, bundled);
    expect(gone).toMatchObject({ installed: false, enabled: false });
    expect(JSON.parse(readFileSync(join(local, 'enabled-addons.json'), 'utf8'))).toEqual({
      'other-addon': true,
    });
  });

  it('flags an outdated installation', () => {
    installAddon(local, bundled);
    writeFileSync(
      join(local, 'addons', ADDON_NAME, 'package.json'),
      JSON.stringify({ name: ADDON_NAME, version: '1.0.0' }),
    );
    expect(addonStatus(local, bundled)).toMatchObject({
      installed: true,
      installedVersion: '1.0.0',
      needsUpdate: true,
    });
  });

  it('refuses to install without Local', () => {
    rmSync(join(local, 'sites.json'));
    expect(() => installAddon(local, bundled)).toThrow(/not installed/);
  });

  it('discovers sites, running first, and builds the right pending connection', () => {
    const sites = discoverSites(local);
    expect(sites.map((s) => [s.name, s.running])).toEqual([
      ['Running Site', true],
      ['Maria Site', false],
      ['Stopped Site', false],
    ]);
    expect(sites.find((s) => s.name === 'Maria Site')?.port).toBe(10023);
    const running = pendingConnectionFor(sites[0]!);
    if (process.platform === 'win32') {
      // No Unix sockets on Windows: a running site connects over its TCP port.
      expect(running).toMatchObject({
        autoConnect: true,
        password: 'root',
        definition: { transport: 'tcp', host: '127.0.0.1', port: 10003 },
      });
      return;
    }
    expect(running).toMatchObject({
      autoConnect: true,
      password: 'root',
      definition: {
        transport: 'socket',
        socketPath: join(local, 'run', 'abc', 'mysql', 'mysqld.sock'),
        database: 'local',
        source: 'localwp',
      },
    });
    const stopped = pendingConnectionFor(sites[2]!);
    expect(stopped.definition).toMatchObject({
      transport: 'tcp',
      host: '127.0.0.1',
      port: 10013,
      user: 'root',
    });
  });
});
