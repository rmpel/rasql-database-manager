import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm } from './helpers';

test('follows a foreign key to the referenced row and back to the referencing rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-fk-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL);
    INSERT INTO customers (name) VALUES ('Ada'), ('Grace'), ('Linus');
    INSERT INTO orders (customer_id, total) VALUES (1, 10), (2, 20), (2, 25), (3, 30), (2, 27.5);
  `);
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('FK (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'FK (e2e)',
    );

    // Forward: the customer_id cell on an order links to the customer.
    await ws.locator('.object-name', { hasText: /^orders$/ }).click();
    const orders = ws.locator('.tab-pane:not([hidden]) .grid-table');
    const secondOrder = orders.locator('tbody tr').nth(1);
    await expect(secondOrder.locator('td').nth(2)).toContainText('2');
    await secondOrder.locator('td').nth(2).hover();
    await secondOrder.locator('.fk-link').click();

    await expect(ws.locator('.tab-strip .tab.active')).toHaveText(/customers/);
    const pane = ws.locator('.tab-pane:not([hidden])');
    await expect(pane.locator('.filter-bar .filter-value')).toHaveValue('2');
    await expect(pane.locator('.toolbar-status')).toContainText('1 rows loaded (filtered)');
    await expect(pane.locator('.grid-table tbody tr').first()).toContainText('Grace');
    await ws.screenshot({ path: join(SHOTS, '11-foreign-key-forward.png') });

    // Backward: select Grace and ask what references her.
    await pane.locator('.grid-table tbody tr').first().locator('.grid-rownum').click();
    await pane.getByRole('button', { name: 'References ▾' }).click();
    await pane.locator('.dropdown-menu button', { hasText: 'orders' }).click();

    await expect(ws.locator('.tab-strip .tab.active')).toHaveText(/orders/);
    const ordersPane = ws.locator('.tab-pane:not([hidden])');
    await expect(ordersPane.locator('.toolbar-status')).toContainText('3 rows loaded (filtered)');
    await expect(ordersPane.locator('.filter-bar .filter-row select').first()).toHaveValue(
      'customer_id',
    );
    await ws.screenshot({ path: join(SHOTS, '12-foreign-key-backward.png') });
  } finally {
    await app.close();
  }
});
