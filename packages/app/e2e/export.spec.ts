import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import {
  SHOTS,
  expectWorkspace,
  launch,
  openNewConnectionForm,
  openConnectionWindow,
} from './helpers';

test('exports the full table to CSV through the save dialog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-export-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, note TEXT)',
  );
  const ins = db.prepare('INSERT INTO products (name, price, note) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= 800; i++)
    ins.run(`Product ${i}`, i * 0.5, i % 7 === 0 ? 'has, comma' : null);
  db.exec('COMMIT');
  db.close();
  const target = join(dir, 'products-export.csv');

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Export (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Export (e2e)',
    );
    await ws.locator('.object-name', { hasText: 'products' }).click();
    const pane = ws.locator('.tab-pane:not([hidden])');
    await expect(
      pane.locator('.grid-table tbody tr').filter({ hasText: 'Product 1' }).first(),
    ).toBeVisible();

    // The save dialog is native; answer it from the main process.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as typeof dialog.showSaveDialog;
    }, target);

    await pane.locator('.export-button').click();
    await pane.locator('.export-menu button[data-format="csv"]').click();
    await expect(pane.locator('.export-status')).toContainText('Saved 800 rows', {
      timeout: 20_000,
    });
    await ws.screenshot({ path: join(SHOTS, '10-export-csv.png') });

    expect(existsSync(target)).toBe(true);
    const lines = readFileSync(target, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toBe('id,name,price,note');
    expect(lines).toHaveLength(801);
    expect(lines[7]).toBe('7,Product 7,3.5,"has, comma"');
    expect(lines[800]).toBe('800,Product 800,400,');
  } finally {
    await app.close();
  }
});
