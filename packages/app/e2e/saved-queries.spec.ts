import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm, runQuery } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('saved queries and a trigger definition on SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-saved-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL, updated TEXT);
    CREATE TRIGGER orders_touch AFTER UPDATE ON orders BEGIN
      UPDATE orders SET updated = datetime('now') WHERE id = NEW.id;
    END;
    INSERT INTO orders (total) VALUES (10), (25.5);`);
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Saved (e2e)');
    // Save first: saved queries belong to a saved connection.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const ws = await openConnectionWindow(
      app,
      () => page.locator('.connection-item', { hasText: 'Saved (e2e)' }).click(),
      'Saved (e2e)',
    );

    // Write a query, save it with Cmd+S under a name; the tab takes that name.
    await runQuery(ws, 'SELECT COUNT(*) AS n FROM orders');
    await ws.keyboard.press(`${mod}+s`);
    const bar = ws.locator('.save-query-bar');
    await bar.locator('input[type="text"]').fill('Order count');
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    const tab = ws.locator('.tab.active');
    await expect(tab).toHaveText(/^Order count/);

    // Editing marks the tab; Cmd+S saves in place.
    await ws.locator('.tab-pane:not([hidden]) .cm-content').click();
    await ws.keyboard.press(`${mod}+End`);
    await ws.keyboard.type(' WHERE total > 20');
    await expect(tab).toHaveText(/^Order count •/);
    await ws.keyboard.press(`${mod}+s`);
    await expect(tab).toHaveText(/^Order count(?! •)/);

    // A new tab opens it from the Saved panel.
    await ws.getByRole('button', { name: '+ Query' }).click();
    const pane = ws.locator('.tab-pane:not([hidden])');
    await pane.getByRole('button', { name: 'Saved', exact: true }).click();
    const entry = pane.locator('.saved-panel .history-entry', { hasText: 'Order count' });
    await expect(entry).toContainText('WHERE total > 20');
    await entry.dblclick();
    await expect(pane.locator('.toolbar-status')).toContainText('1 rows');
    await expect(ws.locator('.tab.active')).toHaveText(/^Order count/);
    await ws.screenshot({ path: join(SHOTS, '16-saved-queries.png') });

    // The trigger opens as a definition with what it does and when.
    await ws.locator('.object-name', { hasText: 'orders_touch' }).click();
    const obj = ws.locator('.tab-pane:not([hidden]) .object-tab');
    await expect(obj.locator('.object-explain')).toContainText('after update on orders');
    await expect(obj.locator('.object-props')).toContainText('AFTER UPDATE, for each row');
    await expect(obj.locator('.object-ddl .cm-content')).toContainText("datetime('now')");
    await obj.getByRole('button', { name: 'Open in query tab' }).click();
    await expect(ws.locator('.tab-pane:not([hidden]) .cm-content')).toContainText(
      'CREATE TRIGGER orders_touch',
    );
  } finally {
    await app.close();
  }
});
