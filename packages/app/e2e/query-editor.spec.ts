import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openNewConnectionForm, openConnectionWindow } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('query editor: typing, running the statement under the cursor, history and explain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-editor-'));
  const file = join(dir, 'editor.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE fruit (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kg REAL);
    INSERT INTO fruit (name, kg) VALUES ('apple', 1.5), ('pear', 2.25), ('fig', NULL);
  `);
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Editor (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Editor (e2e)',
    );

    const pane = ws.locator('.tab-pane:not([hidden])');
    const editor = pane.locator('.cm-content');
    await expect(editor).toBeVisible();

    // Replace the default text with two statements and run the one under the cursor (the second).
    await editor.click({ position: { x: 8, y: 8 } });
    await ws.keyboard.press(`${mod}+a`);
    await ws.keyboard.type('SELECT 1 AS one;\nSELECT name, kg FROM fruit ORDER BY id');
    await ws.keyboard.press(`${mod}+Enter`);

    const status = pane.locator('.toolbar-status');
    await expect(status).toContainText('statement 2 of 2', { timeout: 15_000 });
    await expect(status).toContainText('3 rows');
    const grid = pane.locator('.query-results .grid-table');
    await expect(grid.locator('th', { hasText: 'kg' })).toBeVisible();
    await expect(grid.locator('tbody tr').filter({ hasText: 'pear' })).toBeVisible();
    await expect(grid.locator('.cell-null').first()).toHaveText('NULL');

    // Syntax highlighting is live: the keyword gets a token class.
    await expect(
      editor
        .locator('span')
        .filter({ hasText: /^SELECT$/ })
        .first(),
    ).toBeVisible();

    // History records the run and loads it back.
    await pane.getByRole('button', { name: 'History' }).click();
    const history = pane.locator('.history-panel');
    await expect(history.locator('.history-entry').first()).toContainText(
      'SELECT name, kg FROM fruit',
      { timeout: 10_000 },
    );
    await expect(history.locator('.history-entry').first()).toContainText('3 rows');

    // Explain the statement under the cursor.
    await pane.getByRole('button', { name: 'Explain' }).click();
    const explain = pane.locator('.explain-view');
    await expect(explain).toBeVisible();
    await expect(explain).toContainText(/fruit/i, { timeout: 10_000 });
    await ws.screenshot({ path: join(SHOTS, '10-query-editor.png') });

    // Export is enabled after a successful run (the engine itself is tested elsewhere).
    await expect(pane.locator('.export-button')).toBeEnabled();

    // An error ends up in the status line and the history. Escape first closes any completion popup.
    await ws.keyboard.press('Escape');
    await editor.click({ position: { x: 8, y: 8 } });
    await ws.keyboard.press(`${mod}+a`);
    await ws.keyboard.type('SELECT * FROM nope');
    await ws.keyboard.press(`${mod}+Enter`);
    await expect(status).toContainText('QUERY_FAILED', { timeout: 10_000 });
    await expect(history.locator('.history-entry.failed').first()).toContainText('nope', {
      timeout: 10_000,
    });

    // Autocomplete offers the table name.
    await ws.keyboard.press('Escape');
    await editor.click({ position: { x: 8, y: 8 } });
    await ws.keyboard.press(`${mod}+a`);
    await ws.keyboard.type('SELECT * FROM fr');
    await expect(ws.locator('.cm-tooltip-autocomplete li', { hasText: 'fruit' })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});
