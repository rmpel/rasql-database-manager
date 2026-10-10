import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm, portOpen } from './helpers';

// mysql2 belongs to the MySQL driver package; borrow it to seed the table.
const require = createRequire(resolve('../driver-mysql/package.json'));
interface Seed {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
const mysql = require('mysql2/promise') as {
  createConnection(options: Record<string, unknown>): Promise<Seed>;
};

const PORT = 33080;
const CONN = { host: '127.0.0.1', port: PORT, user: 'rasql', password: 'rasql', database: 'rasql' };

test('MySQL filters: enum dropdowns, set members, regexp and literal wildcards', async () => {
  test.skip(!(await portOpen(PORT)), 'mysql80 from test/matrix is not running');
  const seed = await mysql.createConnection(CONN);
  await seed.query('DROP TABLE IF EXISTS filter_posts');
  await seed.query(
    "CREATE TABLE filter_posts (id INT PRIMARY KEY, title VARCHAR(50), status ENUM('draft','publish','private'), flags SET('sticky','hidden'), slug VARCHAR(50))",
  );
  await seed.query(
    `INSERT INTO filter_posts VALUES
      (1, 'Hello world', 'publish', 'sticky', 'hello-world'),
      (2, 'Draft one', 'draft', '', 'draft-1'),
      (3, 'Private', 'private', 'hidden', 'private-post'),
      (4, 'Post 42', 'publish', 'sticky,hidden', 'post-42'),
      (5, '100% done', 'publish', '', 'done')`,
  );

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'mysql');
    const form = page.locator('.connection-form');
    await form.locator('input').first().fill('Filters MySQL (e2e)');
    await form.getByLabel('Host').fill('127.0.0.1');
    await form.getByLabel('Port').fill(String(PORT));
    await form.getByLabel('User').fill('rasql');
    await form.getByLabel('Password', { exact: true }).fill('rasql');
    await form.getByLabel('Database').fill('rasql');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Filters MySQL (e2e)',
    );
    await ws.locator('.object-name', { hasText: /^filter_posts$/ }).click({ timeout: 20_000 });
    const pane = ws.locator('.tab-pane:not([hidden])');
    const status = pane.locator('.toolbar-status');
    await expect(status).toContainText('5 rows loaded');

    await pane.getByRole('button', { name: /^Filter/ }).click();
    const bar = pane.locator('.filter-bar');
    const rules = bar.locator('.filter-row');
    const apply = (): Promise<void> => bar.getByRole('button', { name: 'Apply' }).click();

    // An enum column gets a dropdown of its members.
    await rules.first().locator('select').first().selectOption('status');
    await rules.first().locator('select.filter-value').selectOption('publish');
    await apply();
    await expect(status).toContainText('3 rows loaded (filtered)');

    // A set column offers "has member" with its members.
    await bar.getByRole('button', { name: '+ Rule' }).click();
    await rules.nth(1).locator('select').first().selectOption('flags');
    await expect(rules.nth(1).locator('select').nth(1)).toHaveValue('has member');
    await rules.nth(1).locator('select.filter-value').selectOption('sticky');
    await apply();
    await expect(status).toContainText('2 rows loaded (filtered)');

    // Regular expressions are offered because the MySQL driver supports them.
    await bar.getByRole('button', { name: '+ Rule' }).click();
    await rules.nth(2).locator('select').first().selectOption('slug');
    await rules.nth(2).locator('select').nth(1).selectOption('regexp');
    await rules.nth(2).locator('.filter-value').fill('^post-[0-9]+$');
    await apply();
    await expect(status).toContainText('1 rows loaded (filtered)');
    await ws.screenshot({ path: join(SHOTS, '09-filter-mysql.png') });

    // "contains" matches % and _ literally.
    await bar.getByRole('button', { name: 'Clear' }).click();
    await expect(status).toContainText('5 rows loaded');
    await rules.first().locator('select').first().selectOption('title');
    await rules.first().locator('.filter-value').fill('_');
    await apply();
    await expect(status).toContainText('0 rows loaded (filtered)');
    await rules.first().locator('.filter-value').fill('100%');
    await apply();
    await expect(status).toContainText('1 rows loaded (filtered)');

    // "is one of" on an enum picks several members.
    await rules.first().locator('select').first().selectOption('status');
    await rules.first().locator('select').nth(1).selectOption('in');
    await rules.first().locator('.filter-members summary').click();
    await rules.first().getByLabel('draft').check();
    await rules.first().getByLabel('private').check();
    await apply();
    await expect(status).toContainText('2 rows loaded (filtered)');
  } finally {
    await app.close();
    await seed.query('DROP TABLE IF EXISTS filter_posts');
    await seed.end();
  }
});
