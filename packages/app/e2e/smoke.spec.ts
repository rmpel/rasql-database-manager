import { mkdtempSync, existsSync } from 'node:fs';
import { Entry } from '@napi-rs/keyring';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import {
  KEYCHAIN_SERVICE,
  SHOTS,
  launch,
  openNewConnectionForm,
  portOpen,
  runQuery,
  savedId,
  openConnectionWindow,
} from './helpers';

test('launcher shows, SQLite file opens, table browses, query runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-db-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, data BLOB, meta JSON);
    INSERT INTO products (name, price, data, meta) VALUES ('Widget ☃', 9.99, X'00FF', '{"color":"red"}'), ('Gadget', NULL, NULL, NULL);
  `);
  db.close();

  const { app, page } = await launch();
  try {
    await page.screenshot({ path: join(SHOTS, '01-launcher.png') });

    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Shop (e2e)');
    await page.screenshot({ path: join(SHOTS, '02-sqlite-form.png') });
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Shop (e2e)',
    );
    await expect(ws.locator('.titlebar-meta')).toContainText('SQLite');

    await ws.locator('.object-name', { hasText: 'products' }).click();
    const grid = ws.locator('.tab-pane:not([hidden]) .grid-table');
    await expect(grid.locator('tbody tr').filter({ hasText: 'Widget' })).toBeVisible();
    await expect(grid.locator('.cell-null').first()).toHaveText('NULL');
    await expect(grid.locator('.cell-bytes').first()).toContainText('0x00ff');
    await expect(grid.locator('.cell-json').first()).toContainText('"color"');
    await ws.screenshot({ path: join(SHOTS, '03-sqlite-table.png') });

    await ws.getByRole('button', { name: 'Structure' }).click();
    await expect(ws.locator('.structure')).toContainText('CREATE TABLE products');

    await ws.locator('.tab-strip .tab', { hasText: 'Query 1' }).click();
    const status = await runQuery(
      ws,
      'SELECT id, name, price * 2 AS doubled FROM products ORDER BY id',
    );
    expect(status).toMatch(/2 rows/);
    await expect(
      ws.locator('.tab-pane:not([hidden]) .grid-table th', { hasText: 'doubled' }),
    ).toBeVisible();
    await ws.screenshot({ path: join(SHOTS, '04-sqlite-query.png') });

    const err = await runQuery(ws, 'SELEC nonsense');
    expect(err).toMatch(/QUERY_FAILED/);

    // The manager is a window of its own: it is still there, and closing the connection window
    // ends only that connection.
    await expect(page.getByRole('heading', { name: 'RaSQL' })).toBeVisible();
    await ws.close();
    await expect(page.getByRole('heading', { name: 'RaSQL' })).toBeVisible();
    expect(app.windows().length).toBe(1);
  } finally {
    await app.close();
  }
});

test('staged edits commit in one transaction and refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-edit-'));
  const file = join(dir, 'edit.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, note TEXT);
    INSERT INTO people (name, age, note) VALUES ('Ann', 30, 'a'), ('Bob', 40, 'b'), ('Cid', 50, 'c');
  `);
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Edit (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Edit (e2e)',
    );
    await ws.locator('.object-name', { hasText: 'people' }).click();

    const pane = ws.locator('.tab-pane:not([hidden])');
    const grid = pane.locator('.grid-table');
    await expect(grid.locator('tbody tr').filter({ hasText: 'Ann' })).toBeVisible();

    // Edit Ann's age by double-clicking the cell, typing, and pressing Enter.
    const annAge = grid.locator('tbody tr').filter({ hasText: 'Ann' }).locator('td').nth(3);
    await annAge.dblclick();
    await pane.locator('.cell-editor input').fill('31');
    await pane.locator('.cell-editor input').press('Enter');
    await expect(annAge).toHaveClass(/edited/);

    // Set Bob's note to NULL through the null toggle.
    const bobNote = grid.locator('tbody tr').filter({ hasText: 'Bob' }).locator('td').nth(4);
    await bobNote.dblclick();
    await pane.locator('.cell-editor .null-toggle').click();
    await pane.locator('.cell-editor input').press('Enter');
    await expect(bobNote.locator('.cell-null')).toHaveText('NULL');

    // Mark Cid for deletion by selecting the row and pressing Backspace.
    await grid.locator('tbody tr').filter({ hasText: 'Cid' }).locator('.grid-rownum').click();
    await ws.keyboard.press('Backspace');
    await expect(grid.locator('tbody tr').filter({ hasText: 'Cid' })).toHaveClass(/deleted/);

    // Add a row and fill its name.
    await pane.getByRole('button', { name: '+ Row' }).click();
    const inserted = grid.locator('tbody tr.inserted');
    await inserted.locator('td').nth(2).dblclick();
    await pane.locator('.cell-editor input').fill('Dee');
    // Tab stages and moves to the next cell; Shift+Tab moves back; Enter stages the last one.
    await pane.locator('.cell-editor input').press('Tab');
    await expect(inserted.locator('td').nth(3)).toHaveClass(/editing/);
    await pane.locator('.cell-editor input').fill('22');
    await pane.locator('.cell-editor input').press('Tab');
    await expect(inserted.locator('td').nth(4)).toHaveClass(/editing/);
    await pane.locator('.cell-editor input').press('Shift+Tab');
    await expect(inserted.locator('td').nth(3)).toHaveClass(/editing/);
    await pane.locator('.cell-editor input').fill('23');
    await pane.locator('.cell-editor input').press('Enter');
    await expect(inserted.locator('td').nth(3)).toHaveText('23');

    await expect(pane.locator('.pending-badge')).toHaveText('4 pending');
    await ws.screenshot({ path: join(SHOTS, '07-staged-edits.png') });

    // Commit: the confirm dialog is native, so answer it from the main process.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });
    await pane.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(pane.locator('.toolbar-status')).toContainText('Committed 4 statements', {
      timeout: 15_000,
    });
    await expect(pane.locator('.pending-badge')).toHaveText('0 pending');
    await expect(grid.locator('tbody tr').filter({ hasText: 'Cid' })).toHaveCount(0);
    await expect(grid.locator('tbody tr').filter({ hasText: 'Dee' })).toBeVisible();
    await expect(
      grid.locator('tbody tr').filter({ hasText: 'Ann' }).locator('td').nth(3),
    ).toHaveText('31');
    await ws.screenshot({ path: join(SHOTS, '08-after-commit.png') });

    // The database agrees.
    const check = new DatabaseSync(file, { readOnly: true });
    const rows = check.prepare('SELECT name, age, note FROM people ORDER BY id').all() as {
      name: string;
      age: number | null;
      note: string | null;
    }[];
    check.close();
    expect(rows).toEqual([
      { name: 'Ann', age: 31, note: 'a' },
      { name: 'Bob', age: 40, note: null },
      { name: 'Dee', age: 23, note: null },
    ]);

    // Refresh still works and reports the rows.
    await pane.getByRole('button', { name: 'Refresh' }).click();
    await expect(pane.locator('.toolbar-status')).toContainText('3 rows loaded');
  } finally {
    await app.close();
  }
});

test('MySQL over TCP against the engine matrix', async () => {
  test.skip(!(await portOpen(33080)), 'mysql80 from test/matrix is not running');
  const { app, page, userData } = await launch();
  try {
    await openNewConnectionForm(page, 'mysql');
    const form = page.locator('.connection-form');
    await form.locator('input').first().fill('Matrix MySQL 8.0');
    await form.getByLabel('Host').fill('127.0.0.1');
    await form.getByLabel('Port').fill('33080');
    await form.getByLabel('User').fill('rasql');
    await form.getByLabel('Password', { exact: true }).fill('rasql');
    await form.getByLabel('Database').fill('rasql');
    // Leave "remember password" on: the saved connection must reopen without asking again.
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Matrix MySQL 8.0',
    );
    await expect(ws.locator('.titlebar-meta')).toContainText(/MySQL 8\.0/);
    await expect(ws.locator('.object-name').first()).toBeVisible({ timeout: 20_000 });
    const status = await runQuery(
      ws,
      'SELECT VERSION() AS v, 18446744073709551615 AS big, CAST(-1 AS SIGNED) AS neg',
    );
    expect(status).toMatch(/1 rows/);
    await expect(
      ws.locator('.tab-pane:not([hidden]) .grid-table td', { hasText: '18446744073709551615' }),
    ).toBeVisible();
    await ws.screenshot({ path: join(SHOTS, '05-mysql-tcp.png') });
  } finally {
    await app.close();
  }

  // A fresh process with the same user data must reopen the saved connection from the keychain, no prompt.
  const again = await launch(userData);
  try {
    await openConnectionWindow(
      again.app,
      () => again.page.locator('.connection-item', { hasText: 'Matrix MySQL 8.0' }).click(),
      'Matrix MySQL 8.0',
    );
    await expect(again.page.locator('.modal')).toHaveCount(0);
    expect(new Entry(KEYCHAIN_SERVICE, `rasql:${savedId(userData)}:password`).getPassword()).toBe(
      'rasql',
    );
  } finally {
    await again.app.close();
  }
});

test('LocalWP sites are discovered in the launcher and open over the socket', async () => {
  const socket = join(
    homedir(),
    'Library/Application Support/Local/run/EE0cNsiD3/mysql/mysqld.sock',
  );
  test.skip(
    process.platform !== 'darwin' || !existsSync(socket),
    'LocalWP site "wp" is not running',
  );
  const { app, page } = await launch();
  try {
    const section = page.locator('.local-section');
    await expect(section.locator('h2')).toHaveText('LocalWP sites');
    const wp = section
      .locator('.local-site')
      .filter({ has: page.locator('.local-site-name', { hasText: /^wp$/ }) });
    await expect(wp.locator('.env-dot')).toHaveClass(/running/);
    // Only discovery is exercised; the install button would modify the real Local installation.
    const ws = await openConnectionWindow(app, () => wp.click(), 'wp');
    await expect(ws.locator('.object-name', { hasText: /^wp_posts$/ })).toBeVisible({
      timeout: 20_000,
    });
    await ws.screenshot({ path: join(SHOTS, '09-localwp-discovery.png') });
  } finally {
    await app.close();
  }
});

test('MySQL over a LocalWP Unix socket', async () => {
  const socket = join(
    homedir(),
    'Library/Application Support/Local/run/EE0cNsiD3/mysql/mysqld.sock',
  );
  test.skip(
    process.platform !== 'darwin' || !existsSync(socket),
    'LocalWP site "wp" is not running',
  );
  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'mysql');
    const form = page.locator('.connection-form');
    await form.locator('input').first().fill('LocalWP wp');
    await form.getByLabel('Connect via').selectOption('socket');
    await form.getByLabel('Socket path').fill(socket);
    await form.getByLabel('User').fill('root');
    await form.getByLabel('Password', { exact: true }).fill('root');
    await form.getByLabel('Database').fill('local');
    await form.getByLabel('Remember password in the system keychain').uncheck();
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'LocalWP wp',
    );
    await ws.locator('.object-name', { hasText: /^wp_options$/ }).click();
    const grid = ws.locator('.tab-pane:not([hidden]) .grid-table');
    await expect(grid.locator('tbody tr').filter({ hasText: 'siteurl' })).toBeVisible({
      timeout: 20_000,
    });
    await ws.screenshot({ path: join(SHOTS, '06-localwp-socket.png') });
  } finally {
    await app.close();
  }
});
