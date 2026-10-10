import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm } from './helpers';

// A 1x1 red PNG, the smallest valid image that exercises detection and the preview.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

test('inspects bytes, JSON and base64 text, and replaces a blob from a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-inspect-'));
  const file = join(dir, 'media.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE media (id INTEGER PRIMARY KEY, name TEXT, data BLOB, meta JSON, thumb TEXT)',
  );
  db.prepare('INSERT INTO media (name, data, meta, thumb) VALUES (?, ?, ?, ?)').run(
    'red dot',
    PNG,
    '{"w":1,"h":1,"tags":["tiny","red"]}',
    `data:image/png;base64,${PNG.toString('base64')}`,
  );
  db.close();
  const replacement = join(dir, 'replacement.bin');
  writeFileSync(
    replacement,
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
  );

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Inspect (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Inspect (e2e)',
    );
    await ws.locator('.object-name', { hasText: /^media$/ }).click();
    const pane = ws.locator('.tab-pane:not([hidden])');
    const row = pane.locator('.grid-table tbody tr').first();
    await expect(row).toContainText('red dot');

    // Bytes: detection, image preview, hex dump.
    await row.locator('td').nth(3).click();
    await pane.getByRole('button', { name: 'Inspector' }).click();
    const inspector = pane.locator('.inspector');
    await expect(inspector).toContainText('PNG image');
    await expect(inspector.locator('.inspector-image')).toBeVisible();
    // Visible is not enough: a blocked blob: URL renders a broken-image placeholder. Require pixels.
    await expect
      .poll(() =>
        inspector
          .locator('.inspector-image')
          .evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
      )
      .toBe(1);
    await expect(inspector.locator('.inspector-hex')).toContainText('89 50 4e 47');
    await ws.screenshot({ path: join(SHOTS, '13-inspector-bytes.png') });

    // JSON: pretty printing.
    await row.locator('td').nth(4).click();
    await expect(inspector).toContainText('JSON');
    await expect(inspector.locator('.inspector-editor')).toHaveValue(/"tags": \[\n/);

    // Base64 text: detected, decoded preview.
    await row.locator('td').nth(5).click();
    await expect(inspector).toContainText('looks like base64-encoded PNG image');
    await inspector.getByRole('button', { name: 'Decoded' }).click();
    await expect
      .poll(() =>
        inspector
          .locator('.inspector-image')
          .evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
      )
      .toBe(1);

    // Replace the blob from a file: the native dialog is stubbed from the main process.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    }, replacement);
    await row.locator('td').nth(3).click();
    await inspector.getByRole('button', { name: 'Replace from file…' }).click();
    await expect(inspector).toContainText('Staged replacement.bin');
    await expect(pane.locator('.pending-badge')).toHaveText('1 pending');
    await expect(row.locator('td').nth(3)).toHaveClass(/edited/);
    await pane.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(pane.locator('.toolbar-status')).toContainText('Committed 1 statement', {
      timeout: 15_000,
    });

    const check = new DatabaseSync(file, { readOnly: true });
    const stored = check.prepare('SELECT data FROM media WHERE id = 1').get() as {
      data: Uint8Array;
    };
    check.close();
    expect(Buffer.from(stored.data)).toEqual(readFileSync(replacement));
  } finally {
    await app.close();
  }
});
