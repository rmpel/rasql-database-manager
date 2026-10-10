import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm, portOpen } from './helpers';

async function answerConfirm(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
  });
}

const row = (page: Page, name: string) =>
  page.locator('.structure-columns tbody tr').filter({
    has: page.locator(`input.col-name[value="${name}"]`),
  });

test('SQLite structure: rename, add, drop and index, with the SQL shown first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-structure-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, legacy TEXT);
    INSERT INTO items (title, legacy) VALUES ('a', 'x'), ('b', 'y');`);
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('Structure (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Structure (e2e)',
    );
    await ws.locator('.object-name', { hasText: /^items$/ }).click();
    const pane = ws.locator('.tab-pane:not([hidden])');
    await pane.getByRole('button', { name: 'Structure' }).click();
    const editor = pane.locator('.structure-editor');

    await row(ws, 'title').locator('input.col-name').fill('name');
    await row(ws, 'legacy').getByTitle('Drop this column and its data').click();
    await expect(row(ws, 'legacy')).toHaveClass(/dropped/);
    await editor.getByRole('button', { name: '+ Column' }).click();
    const added = editor.locator('.structure-columns tbody tr.added');
    await added.locator('input.col-name').fill('stock');
    await added.locator('.type-picker select').first().selectOption('integer');
    await added.locator('td.center input[type="checkbox"]').uncheck();
    await added.locator('.default-picker select').selectOption('value');
    await added.locator('.default-picker input').fill('0');
    await editor.getByRole('button', { name: '+ Index' }).click();
    await editor.locator('.structure-indexes tr.added select').nth(1).selectOption('name');

    await expect(editor.locator('.structure-sql')).toContainText(
      'ALTER TABLE "main"."items" RENAME COLUMN "title" TO "name"',
    );
    await expect(editor.locator('.structure-sql')).toContainText(
      'ADD COLUMN "stock" INTEGER NOT NULL DEFAULT 0',
    );
    await ws.screenshot({ path: join(SHOTS, '18-structure-sqlite.png') });
    await answerConfirm(app);
    await editor.getByRole('button', { name: 'Review and apply' }).click();
    await expect(editor.locator('.pending-badge')).toHaveText('0 changes', { timeout: 15_000 });

    const check = new DatabaseSync(file, { readOnly: true });
    const cols = (check.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    const indexes = (check.prepare('PRAGMA index_list(items)').all() as { name: string }[]).map(
      (i) => i.name,
    );
    check.close();
    expect(cols).toEqual(['id', 'name', 'stock']);
    expect(indexes).toContain('items_idx1');

    // The grid follows: the new column is there with its default.
    await pane.getByRole('button', { name: 'Content' }).click();
    await expect(pane.locator('.grid-table thead')).toContainText('stock');
  } finally {
    await app.close();
  }
});

const PORT = 33080;
const require = createRequire(resolve('../driver-mysql/package.json'));
interface Seed {
  query(sql: string): Promise<[unknown[], unknown]>;
  end(): Promise<void>;
}
const mysql = require('mysql2/promise') as {
  createConnection(options: Record<string, unknown>): Promise<Seed>;
};

test('MySQL structure: type pickers, defaults, moving a column', async () => {
  test.skip(!(await portOpen(PORT)), 'mysql80 from test/matrix is not running');
  const seed = await mysql.createConnection({
    host: '127.0.0.1',
    port: PORT,
    user: 'rasql',
    password: 'rasql',
    database: 'rasql',
  });
  await seed.query('DROP TABLE IF EXISTS structure_posts');
  await seed.query(
    "CREATE TABLE structure_posts (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, title VARCHAR(100) NOT NULL DEFAULT '', views INT NOT NULL DEFAULT 0, status ENUM('draft','publish') NOT NULL DEFAULT 'draft')",
  );
  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'mysql');
    const form = page.locator('.connection-form');
    await form.locator('input').first().fill('Structure MySQL (e2e)');
    await form.getByLabel('Host').fill('127.0.0.1');
    await form.getByLabel('Port').fill(String(PORT));
    await form.getByLabel('User').fill('rasql');
    await form.getByLabel('Password', { exact: true }).fill('rasql');
    await form.getByLabel('Database').fill('rasql');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Structure MySQL (e2e)',
    );
    await ws.locator('.object-name', { hasText: /^structure_posts$/ }).click({ timeout: 20_000 });
    const pane = ws.locator('.tab-pane:not([hidden])');
    await pane.getByRole('button', { name: 'Structure' }).click();
    const editor = pane.locator('.structure-editor');

    // Defaults read as people expect, not as internal values.
    await row(ws, 'title').locator('.default-picker input').waitFor();
    await expect(row(ws, 'title').locator('.default-picker select')).toHaveValue('value');
    await expect(row(ws, 'title').locator('.default-picker input')).toHaveValue('');

    // views: Whole number, INT → BIGINT UNSIGNED, the description follows the choice.
    const views = row(ws, 'views');
    await expect(views.locator('.type-picker select').first()).toHaveValue('integer');
    // The kinds carry the engine's own type names next to the plain words.
    await expect(
      views.locator('.type-picker select').first().locator('option[value="float"]'),
    ).toHaveText('Approximate number (FLOAT, DOUBLE)');
    await expect(
      views.locator('.type-picker select').first().locator('option[value="integer"]'),
    ).toHaveText('Whole number (INT, BIGINT, TINYINT, …)');
    await views.locator('.type-picker select').nth(1).selectOption('BIGINT');
    await views.locator('.unsigned input').check();
    await expect(editor.locator('.type-hint')).toContainText('quintillion');

    // status: one more allowed value, and the default picked from the list.
    const status = row(ws, 'status');
    await status.locator('.type-picker .values').fill('draft, publish, private');
    await status.locator('.default-picker select').nth(1).selectOption('private');

    // Move views to the top.
    await views.getByTitle('Move up').click();
    await views.getByTitle('Move up').click();
    await expect(views.getByTitle('Move up')).toBeDisabled();

    const sql = editor.locator('.structure-sql');
    await expect(sql).toContainText(
      'MODIFY COLUMN `views` BIGINT UNSIGNED NOT NULL DEFAULT 0 FIRST',
    );
    // The column keeps its own charset and collation.
    await expect(sql).toContainText(
      /MODIFY COLUMN `status` ENUM\('draft','publish','private'\) CHARACTER SET \w+ COLLATE \w+ NOT NULL DEFAULT 'private'/,
    );
    await ws.screenshot({ path: join(SHOTS, '19-structure-mysql.png') });
    await answerConfirm(app);
    await editor.getByRole('button', { name: 'Review and apply' }).click();
    await expect(editor.locator('.pending-badge')).toHaveText('0 changes', { timeout: 15_000 });

    const [cols] = (await seed.query(
      "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'rasql' AND TABLE_NAME = 'structure_posts' ORDER BY ORDINAL_POSITION",
    )) as [{ name: string; type: string; dflt: string | null }[], unknown];
    expect(cols.map((c) => c.name)).toEqual(['views', 'id', 'title', 'status']);
    expect(cols[0]!.type).toMatch(/^bigint(\(20\))? unsigned$/);
    expect(cols[3]).toMatchObject({ type: "enum('draft','publish','private')", dflt: 'private' });
  } finally {
    await app.close();
    await seed.query('DROP TABLE IF EXISTS structure_posts');
    await seed.end();
  }
});
