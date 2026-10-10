import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm } from './helpers';

// A WordPress-style option: an array holding an object with a protected property.
const STORED =
  'a:2:{s:5:"title";s:5:"Hello";s:6:"widget";O:6:"Widget":2:{s:4:"name";s:3:"box";s:7:"\0*\0size";i:3;}}';
// After editing: the multibyte title is 10 bytes, the class name 8; the protected marker survives.
const EXPECTED =
  'a:2:{s:5:"title";s:10:"Héllo ☃";s:6:"widget";O:8:"MyWidget":2:{s:4:"name";s:3:"box";s:7:"\0*\0size";i:3;}}';

test('edits PHP serialized data as a tree without losing types or lengths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-php-'));
  const file = join(dir, 'wp.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE options (id INTEGER PRIMARY KEY, name TEXT, value TEXT)');
  db.prepare('INSERT INTO options (name, value) VALUES (?, ?)').run('widget_opts', STORED);
  db.close();

  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'sqlite');
    await page.locator('.connection-form input[placeholder=":memory:"]').fill(file);
    await page.locator('.connection-form input').first().fill('PHP (e2e)');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'PHP (e2e)',
    );
    await ws.locator('.object-name', { hasText: /^options$/ }).click();
    const pane = ws.locator('.tab-pane:not([hidden])');
    const row = pane.locator('.grid-table tbody tr').first();
    await expect(row).toContainText('widget_opts');

    await row.locator('td').nth(3).click();
    await pane.getByRole('button', { name: 'Inspector' }).click();
    const inspector = pane.locator('.inspector');
    await expect(inspector).toContainText('PHP serialized array(2)');
    const tree = inspector.locator('.php-tree');
    await expect(tree).toBeVisible();
    await expect(tree.locator('.php-class')).toHaveValue('Widget');
    await expect(tree.locator('.php-key-type', { hasText: 'protected' }).first()).toBeVisible();

    // The JSON view keeps the class and marks the protected property.
    await inspector.getByRole('button', { name: 'JSON view' }).click();
    await expect(inspector.locator('.inspector-text')).toContainText('"__class": "Widget"');
    await expect(inspector.locator('.inspector-text')).toContainText('"#size": 3');
    await inspector.getByRole('button', { name: 'Serialized', exact: true }).click();

    await tree.locator('input.php-string').first().fill('Héllo ☃');
    await tree.locator('.php-class').fill('MyWidget');
    await ws.screenshot({ path: join(SHOTS, '14-inspector-php.png') });
    await inspector.getByRole('button', { name: 'Stage', exact: true }).click();
    await expect(pane.locator('.pending-badge')).toHaveText('1 pending');
    await pane.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(pane.locator('.toolbar-status')).toContainText('Committed 1 statement', {
      timeout: 15_000,
    });

    const check = new DatabaseSync(file, { readOnly: true });
    const stored = check.prepare('SELECT value FROM options WHERE id = 1').get() as {
      value: string;
    };
    check.close();
    expect(stored.value).toBe(EXPECTED);
  } finally {
    await app.close();
  }
});
