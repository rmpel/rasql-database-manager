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

    // One rule is there from the start, as in Sequel Pro. Picking a text column offers contains.
    await pane.getByRole('button', { name: /^Filter/ }).click();
    const bar = pane.locator('.filter-bar');
    const rules = bar.locator('.filter-row');
    await expect(rules).toHaveCount(1);
    await rules.first().locator('select').first().selectOption('name');
    await expect(rules.first().locator('select').nth(1)).toHaveValue('contains');
    await rules.first().locator('select').nth(1).selectOption('starts with');
    await rules.first().locator('.filter-value').fill('Widget');
    await bar.getByRole('button', { name: 'Apply' }).click();
    await expect(status).toContainText('20 rows loaded (filtered)');
    await expect(grid.locator('tbody tr').filter({ hasText: 'Gadget' })).toHaveCount(0);

    // A second rule on the same column forms a group; "any" ORs them.
    await rules.first().locator('.filter-add').click();
    await expect(bar.locator('.filter-group')).toHaveCount(1);
    await rules.nth(1).locator('.filter-value').fill('Gadget 1');
    await bar.locator('.filter-group').getByRole('button', { name: 'any', exact: true }).click();
    await bar.getByRole('button', { name: 'Apply' }).click();
    await expect(status).toContainText('28 rows loaded (filtered)');

    // Between on a number shows two inputs and is ANDed with the group.
    await bar.getByRole('button', { name: '+ Rule' }).click();
    const range = rules.nth(2);
    await range.locator('select').first().selectOption('price');
    await range.locator('select').nth(1).selectOption('between');
    await expect(range.locator('.filter-value')).toHaveCount(2);
    await range.locator('.filter-value').first().fill('10');
    await range.locator('.filter-value').nth(1).fill('20');
    await bar.getByRole('button', { name: 'Apply' }).click();
    await expect(status).toContainText('5 rows loaded (filtered)');

    // The quick search narrows further across all columns.
    await bar.locator('.filter-search').fill('Widget');
    await bar.locator('.filter-search').press('Enter');
    await expect(status).toContainText('2 rows loaded (filtered)');
    await bar.locator('.filter-search').fill('');

    // Raw WHERE on top, combined with AND.
    await bar.locator('.filter-where').fill('id > 10');
    await bar.locator('.filter-where').press('Enter');
    await expect(status).toContainText('3 rows loaded (filtered)');
    await ws.screenshot({ path: join(SHOTS, '09-filter-rules.png') });
    const shown = await grid.locator('tbody tr .cell-text').allTextContents();
    expect(shown.length).toBe(3);

    // Count all matching rows on demand.
    await status.getByRole('button', { name: 'count all' }).click();
    await expect(status).toContainText(`${shown.length} total`);

    // Sorting by clicking the header: price descending puts the biggest first.
    const priceHeader = grid.locator('thead th', { hasText: 'price' });
    await priceHeader.click();
    await expect(priceHeader).toHaveClass(/sorted/);
    await priceHeader.click();
    await expect(priceHeader.locator('.grid-sort')).toHaveText('▼');
    // Gadget 13 is the most expensive match; the grid reloads asynchronously, so retry until it lands.
    await expect(grid.locator('tbody tr').first().locator('td').nth(3)).toHaveText('19.5');
    await priceHeader.click();
    await expect(priceHeader).not.toHaveClass(/sorted/);
    await ws.screenshot({ path: join(SHOTS, '10-filters-sorting.png') });

    // Clear brings everything back.
    await bar.getByRole('button', { name: 'Clear' }).click();
    await expect(status).toContainText('60 rows loaded');
    await expect(status).not.toContainText('(filtered)');

    // A filter that cannot be parsed is refused before anything runs.
    await expect(rules).toHaveCount(1);
    await rules.first().locator('select').first().selectOption('stock');
    await rules.first().locator('.filter-value').fill('lots');
    await bar.getByRole('button', { name: 'Apply' }).click();
    await expect(bar.locator('.error')).toContainText('Expected an integer');
  } finally {
    await app.close();
  }
});
