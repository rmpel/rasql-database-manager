import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SHOTS, launch, openNewConnectionForm } from './helpers';

async function saveSqlite(page: Page, name: string, group: string): Promise<void> {
  await openNewConnectionForm(page, 'sqlite');
  const form = page.locator('.connection-form');
  await form.locator('input').first().fill(name);
  await form.getByLabel('Group').fill(group);
  await form.locator('input[placeholder=":memory:"]').fill(':memory:');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.connection-item', { hasText: name })).toBeVisible();
}

test('connection manager: groups, favorites, search and remembered collapsing', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'rasql-e2e-'));
  const first = await launch(userData);
  const page = first.page;
  try {
    await saveSqlite(page, 'Shop staging', 'Clients');
    await saveSqlite(page, 'Blog live', 'Clients');
    await saveSqlite(page, 'Scratch', '');
    await saveSqlite(page, 'Notes', '');
    await saveSqlite(page, 'Archive', 'Old');

    const heads = page.locator('.connection-section-head');
    await expect(heads).toHaveText([/^▾Clients2$/, /^▾Old1$/, /^▾Other connections2$/]);
    // Inside a group, connections are sorted by name.
    const clients = page.locator('.connection-section', { hasText: 'Clients' });
    await expect(clients.locator('.connection-name')).toHaveText(['Blog live', 'Shop staging']);

    // A star moves a connection to Favorites at the top.
    const scratch = page.locator('.connection-section > ul > li', {
      has: page.locator('.connection-name', { hasText: 'Scratch' }),
    });
    await scratch.hover();
    await scratch.locator('.connection-star').click();
    await expect(heads.first()).toHaveText(/Favorites1/);
    await expect(
      page.locator('.connection-section').first().locator('.connection-name'),
    ).toHaveText(['Scratch']);

    // Collapsing a group hides its connections.
    await page.locator('.connection-section-head', { hasText: 'Clients' }).click();
    await expect(page.locator('.connection-name', { hasText: 'Blog live' })).toHaveCount(0);

    // Search opens every section and matches name, group and location.
    await page.locator('.launcher-search').fill('blog');
    await expect(page.locator('.connection-name')).toHaveText(['Blog live']);
    await page.locator('.launcher-search').fill('old');
    await expect(page.locator('.connection-name')).toHaveText(['Archive']);
    await page.locator('.launcher-search').fill('');
    await page.screenshot({ path: join(SHOTS, '15-connection-groups.png') });
  } finally {
    await first.app.close();
  }

  // Favorites and the collapsed group survive a restart.
  const again = await launch(userData);
  try {
    await expect(again.page.locator('.connection-section-head').first()).toHaveText(/Favorites/);
    await expect(again.page.locator('.connection-name', { hasText: 'Blog live' })).toHaveCount(0);
    await expect(again.page.locator('.connection-name', { hasText: 'Archive' })).toBeVisible();
  } finally {
    await again.app.close();
  }
});
