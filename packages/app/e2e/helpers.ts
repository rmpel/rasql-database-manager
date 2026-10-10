import { mkdtempSync, readFileSync } from 'node:fs';
import { Entry } from '@napi-rs/keyring';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export const SHOTS = resolve('screenshots');

export const KEYCHAIN_SERVICE = 'RaSQL (e2e)';
const userDataDirs: string[] = [];

/** Remove every keychain item a test run created, so the real keychain stays clean. */
test.afterAll(() => {
  for (const dir of userDataDirs) {
    try {
      const { connections } = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8')) as {
        connections: { id: string }[];
      };
      for (const c of connections) {
        for (const kind of ['password', 'ssh-password', 'ssh-passphrase']) {
          try {
            new Entry(KEYCHAIN_SERVICE, `rasql:${c.id}:${kind}`).deletePassword();
          } catch {
            /* not stored */
          }
        }
      }
    } catch {
      /* no connections saved by this test */
    }
  }
});

export async function launch(
  userData = mkdtempSync(join(tmpdir(), 'rasql-e2e-')),
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  userDataDirs.push(userData);
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      RASQL_USER_DATA: userData,
      RASQL_KEYCHAIN_SERVICE: KEYCHAIN_SERVICE,
      NODE_ENV: 'production',
    },
  });
  // No native dialog may reach the screen during a test: a person clicking it would decide the
  // outcome. Message boxes answer Cancel and file pickers cancel; a test that needs another answer
  // replaces these stubs itself.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as {
        buttons?: string[];
        cancelId?: number;
      };
      const response = opts.cancelId ?? Math.max(0, (opts.buttons?.length ?? 1) - 1);
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showOpenDialog = (async () => ({
      canceled: true,
      filePaths: [],
    })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({
      canceled: true,
      filePath: '',
    })) as typeof dialog.showSaveDialog;
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: 'RaSQL' })).toBeVisible();
  return { app, page, userData };
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ port, host });
    s.once('connect', () => {
      s.destroy();
      res(true);
    });
    s.once('error', () => res(false));
    s.setTimeout(1500, () => {
      s.destroy();
      res(false);
    });
  });
}

export async function openNewConnectionForm(page: Page, driverId: string): Promise<void> {
  await page.getByRole('button', { name: 'New connection' }).click();
  await page.locator('.connection-form').waitFor();
  await page.locator('.connection-form select').nth(1).selectOption(driverId);
}

/**
 * Trigger something in the manager window that opens a connection, and return the connection
 * window that appears for it, once its workspace shows the connection name.
 */
export async function openConnectionWindow(
  app: ElectronApplication,
  trigger: () => Promise<void>,
  name: string,
): Promise<Page> {
  const [ws] = await Promise.all([app.waitForEvent('window'), trigger()]);
  await ws.waitForLoadState('domcontentloaded');
  await expectWorkspace(ws, name);
  return ws;
}

export async function expectWorkspace(page: Page, name: string): Promise<void> {
  await expect(page.locator('.titlebar strong')).toHaveText(name, { timeout: 30_000 });
}

export async function runQuery(page: Page, sql: string): Promise<string> {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const editor = page.locator('.tab-pane:not([hidden]) .cm-content');
  await editor.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type(sql);
  await page.keyboard.press(`${mod}+Enter`);
  const status = page.locator('.tab-pane:not([hidden]) .toolbar-status');
  await expect(status).toContainText(/rows|affected|error|failed/i, { timeout: 20_000 });
  return (await status.textContent()) ?? '';
}

export function savedId(userData: string): string {
  const { connections } = JSON.parse(readFileSync(join(userData, 'connections.json'), 'utf8')) as {
    connections: { id: string }[];
  };
  return connections[0]!.id;
}
