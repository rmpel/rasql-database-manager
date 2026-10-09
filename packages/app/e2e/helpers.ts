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
