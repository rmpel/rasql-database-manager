import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SHOTS, launch, openConnectionWindow, openNewConnectionForm, portOpen } from './helpers';

const PORT = 33080;

test('MySQL routines, triggers and events open as definitions', async () => {
  test.skip(!(await portOpen(PORT)), 'mysql80 from test/matrix is not running');
  const { app, page } = await launch();
  try {
    await openNewConnectionForm(page, 'mysql');
    const form = page.locator('.connection-form');
    await form.locator('input').first().fill('Objects MySQL (e2e)');
    await form.getByLabel('Host').fill('127.0.0.1');
    await form.getByLabel('Port').fill(String(PORT));
    await form.getByLabel('User').fill('rasql');
    await form.getByLabel('Password', { exact: true }).fill('rasql');
    await form.getByLabel('Database').fill('rasql');
    const ws = await openConnectionWindow(
      app,
      () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
      'Objects MySQL (e2e)',
    );
    const sidebar = ws.locator('.object-list');
    await expect(sidebar.locator('.object-section')).toContainText([
      'Tables',
      'Views',
      'Routines',
      'Triggers',
      'Events',
    ]);

    await sidebar.locator('.object-name', { hasText: /^fill_many$/ }).click();
    const obj = ws.locator('.tab-pane:not([hidden]) .object-tab');
    await expect(obj.locator('.object-tab-kind')).toHaveText('Procedure');
    await expect(obj.locator('.object-explain')).toContainText('CALL fill_many');
    await expect(obj.locator('.object-props')).toContainText(/IN cnt int/i);

    await sidebar.locator('.object-name', { hasText: /^child_count$/ }).click();
    await expect(obj.locator('.object-tab-kind')).toHaveText('Function');
    await expect(obj.locator('.object-props')).toContainText(/Returns\s*int/i);

    await sidebar.locator('.object-name', { hasText: /^ev_touch_parents$/ }).click();
    await expect(obj.locator('.object-props')).toContainText('every 1 day');
    await expect(obj.locator('.object-ddl .cm-content')).toContainText('UPDATE parents');
    await ws.screenshot({ path: join(SHOTS, '17-event-definition.png') });

    await sidebar.locator('.object-name', { hasText: /^trg_children_bi$/ }).click();
    await expect(obj.locator('.object-props')).toContainText('BEFORE INSERT, for each row');
    await obj.getByRole('button', { name: 'Open table children' }).click();
    await expect(ws.locator('.tab.active')).toHaveText(/^children/);
  } finally {
    await app.close();
  }
});
