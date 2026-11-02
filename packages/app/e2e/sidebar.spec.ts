import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { launch, openConnectionWindow, openNewConnectionForm } from './helpers';

test('object list filter clears and refresh picks up outside schema changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-sidebar-'));
  const file = join(dir, 'sidebar.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE orders (id INTEGER PRIMARY KEY); CREATE TABLE users (id INTEGER PRIMARY KEY);`,
  );

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Sidebar (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Sidebar (e2e)',
    );
    const names = ws.locator('.sidebar .object-name');
    await expect(names).toHaveText(['orders', 'users']);

    const filter = ws.getByRole('textbox', { name: 'Filter objects' });
    const clear = ws.getByRole('button', { name: 'Clear filter' });
    await expect(clear).toBeHidden();
    await filter.fill('ord');
    await expect(names).toHaveText(['orders']);
    await clear.click();
    await expect(filter).toHaveValue('');
    await expect(names).toHaveText(['orders', 'users']);

    await filter.fill('nothing');
    await expect(ws.locator('.sidebar .hint')).toHaveText('No objects match “nothing”');
    await filter.press('Escape');
    await expect(filter).toHaveValue('');

    // A table made outside the app shows up after a refresh.
    db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY); DROP TABLE users;');
    await ws.getByRole('button', { name: 'Refresh object list' }).click();
    await expect(names).toHaveText(['orders', 'products']);
  } finally {
    db.close();
    await app.close();
  }
});
