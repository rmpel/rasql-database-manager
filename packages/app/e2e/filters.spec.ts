import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openNewConnectionForm, openConnectionWindow } from './helpers';

test('filters, raw WHERE, sorting and row counts on a table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-filter-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, stock INTEGER)',
  );
  const ins = db.prepare('INSERT INTO products (name, price, stock) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= 60; i++)
    ins.run(i % 3 === 0 ? `Widget ${i}` : `Gadget ${i}`, i * 1.5, i % 7 === 0 ? null : i);
  db.exec('COMMIT');
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Filters (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Filters (e2e)',
    );
    await ws.locator('.object-name', { hasText: 'products' }).click();

    const pane = ws.locator('.tab-pane:not([hidden])');
    const grid = pane.locator('.grid-table');
    const status = pane.locator('.toolbar-status');
    await expect(status).toContainText('60 rows loaded');

    // Column filter: name LIKE 'Widget%'.
    await pane.getByRole('button', { name: /^Filter/ }).click();
    const bar = pane.locator('.filter-bar');
    await bar.getByRole('button', { name: '+ Filter' }).click();
    await bar.locator('.filter-row select').first().selectOption('name');
    await bar.locator('.filter-row select').nth(1).selectOption('like');
    await bar.locator('.filter-value').fill('Widget%');
    await bar.getByRole('button', { name: 'Apply' }).click();
    await expect(status).toContainText('20 rows loaded (filtered)');
    await expect(grid.locator('tbody tr').filter({ hasText: 'Gadget' })).toHaveCount(0);

    // Raw WHERE on top, combined with AND, plus a null filter on stock.
    await bar.locator('.filter-where').fill('price > 40');
    await bar.getByRole('button', { name: '+ Filter' }).click();
    await bar.locator('.filter-row').nth(1).locator('select').first().selectOption('stock');
    await bar.locator('.filter-row').nth(1).locator('select').nth(1).selectOption('is not null');
    await bar.locator('.filter-where').press('Enter');
    await expect(status).toContainText(/\d+ rows loaded \(filtered\)/);
    const shown = await grid.locator('tbody tr .cell-text').allTextContents();
    expect(shown.every((t) => t.startsWith('Widget'))).toBe(true);
    expect(shown.length).toBeLessThan(20);

    // Count all matching rows on demand.
    await status.getByRole('button', { name: 'count all' }).click();
    await expect(status).toContainText(`${shown.length} total`);

    // Sorting by clicking the header: price descending puts the biggest first.
    const priceHeader = grid.locator('thead th', { hasText: 'price' });
    await priceHeader.click();
    await expect(priceHeader).toHaveClass(/sorted/);
    await priceHeader.click();
    await expect(priceHeader.locator('.grid-sort')).toHaveText('▼');
    // Widget 60 is the most expensive match; the grid reloads asynchronously, so retry until it lands.
    await expect(grid.locator('tbody tr').first().locator('td').nth(3)).toHaveText('90');
    await priceHeader.click();
    await expect(priceHeader).not.toHaveClass(/sorted/);
    await ws.screenshot({ path: join(SHOTS, '10-filters-sorting.png') });

    // Clear brings everything back.
    await bar.getByRole('button', { name: 'Clear' }).click();
    await expect(status).toContainText('60 rows loaded');
    await expect(status).not.toContainText('(filtered)');

    // A filter that cannot be parsed is refused before anything runs.
    await bar.getByRole('button', { name: '+ Filter' }).click();
    await bar.locator('.filter-row').last().locator('select').first().selectOption('stock');
    await bar.locator('.filter-row').last().locator('.filter-value').fill('lots');
    await bar.getByRole('button', { name: 'Apply' }).click();
    await expect(bar.locator('.error')).toContainText('Expected an integer');
  } finally {
    await app.close();
  }
});
