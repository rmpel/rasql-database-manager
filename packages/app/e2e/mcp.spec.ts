import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RasqlApi } from '@shared/api';
import { SHOTS, launch, openConnectionWindow } from './helpers';

/** The client side of the app's MCP socket: what `rasql mcp` relays from stdio. */
class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  private socket: Socket | null = null;

  constructor(private readonly path: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = connect(this.path, () => resolve());
      s.once('error', reject);
      s.on('data', (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage())
          this.onmessage?.(m);
      });
      s.on('close', () => this.onclose?.());
      this.socket = s;
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket?.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.socket?.end();
  }
}

async function nextPrompt(app: ElectronApplication, trigger?: () => unknown): Promise<Page> {
  const waiting = app.waitForEvent('window', {
    predicate: (w) => w.url().includes('#prompt/'),
    timeout: 20_000,
  });
  void trigger?.();
  const prompt = await waiting;
  await prompt.waitForLoadState('domcontentloaded');
  await expect(prompt.locator('.mcp-prompt')).toBeVisible();
  // Prompts ignore input for their first second.
  await expect(prompt.locator('body')).toHaveAttribute('data-armed', 'true');
  return prompt;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };
const json = (r: unknown): Record<string, unknown> =>
  JSON.parse((r as ToolResult).content[0]?.text ?? '{}') as Record<string, unknown>;

test('an agent connects, reads, and commits only after the user allows it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-mcp-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
    INSERT INTO users (name, age) VALUES ('ann', 30), ('bob', 40), ('cy', 50);`);
  db.close();
  const userData = mkdtempSync(join(tmpdir(), 'rasql-e2e-'));
  const now = new Date().toISOString();
  const base = {
    environment: 'local',
    readOnly: false,
    driver: 'sqlite',
    transport: 'file',
    options: {},
    credentials: {},
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(
    join(userData, 'connections.json'),
    JSON.stringify({
      version: 1,
      connections: [
        { ...base, id: 'shop', name: 'Shop (e2e)', filePath: file, mcp: 'ask' },
        { ...base, id: 'secret', name: 'Secret (e2e)', filePath: file },
      ],
    }),
  );

  const { app, page } = await launch(userData);
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  try {
    const ws = await openConnectionWindow(
      app,
      () => page.locator('.connection-item', { hasText: 'Shop (e2e)' }).click(),
      'Shop (e2e)',
    );
    const status = await page.evaluate(() =>
      (globalThis as unknown as { rasql: RasqlApi }).rasql.mcp.status(),
    );
    expect(status.socketListening).toBe(true);

    // First contact: the user is asked before the agent sees anything.
    const first = await nextPrompt(app, () =>
      client.connect(new SocketClientTransport(status.socketPath)),
    );
    await expect(first.locator('h1')).toContainText('e2e-agent wants to use RaSQL');
    await first.screenshot({ path: join(SHOTS, 'mcp-client-prompt.png') });
    await first.getByRole('button', { name: 'Allow' }).click();

    const list = json(await client.callTool({ name: 'list_connections', arguments: {} }));
    expect((list['connections'] as { name: string }[]).map((c) => c.name)).toEqual(['Shop (e2e)']);
    const rows = json(
      await client.callTool({
        name: 'query',
        arguments: { connection: 'Shop (e2e)', sql: 'SELECT name FROM users ORDER BY id' },
      }),
    );
    expect(rows['rows']).toEqual([['ann'], ['bob'], ['cy']]);
    await expect(ws.locator('.agent-indicator')).toContainText('e2e-agent');
    await ws.screenshot({ path: join(SHOTS, 'mcp-agent-indicator.png') });

    // Ask: the change waits for the prompt; Review shows the rows it touches.
    const pending = client.callTool({
      name: 'commit_changes',
      arguments: {
        connection: 'Shop (e2e)',
        statements: ["UPDATE users SET age = age + 1 WHERE name = 'bob'"],
        description: 'Bob had a birthday',
        wait_seconds: 60,
      },
    });
    const commit = await nextPrompt(app);
    await expect(commit.locator('h1')).toContainText('is attempting to commit database changes');
    await expect(commit.locator('.mcp-prompt')).toContainText('1 statement, about 1 row affected');
    await commit.getByRole('button', { name: 'Review…' }).click();
    await expect(commit.locator('.mcp-grid')).toContainText('bob');
    await commit.screenshot({ path: join(SHOTS, 'mcp-commit-review.png') });
    await commit.getByRole('button', { name: 'Once' }).click();
    expect(json(await pending)['status']).toBe('committed');
    const age = json(
      await client.callTool({
        name: 'query',
        arguments: { connection: 'Shop (e2e)', sql: "SELECT age FROM users WHERE name = 'bob'" },
      }),
    );
    expect(age['rows']).toEqual([[41]]);

    // A DELETE can lose data: denied with a note that goes back to the agent.
    const del = client.callTool({
      name: 'commit_changes',
      arguments: {
        connection: 'Shop (e2e)',
        statements: ["DELETE FROM users WHERE name = 'cy'"],
        wait_seconds: 60,
      },
    });
    const destructive = await nextPrompt(app);
    await expect(destructive.locator('.mcp-warning.danger')).toContainText('This can lose data');
    await destructive.screenshot({ path: join(SHOTS, 'mcp-commit-destructive.png') });
    await destructive.getByRole('button', { name: 'Deny' }).click();
    await destructive.locator('.mcp-deny textarea').fill('Keep cy, archive instead');
    await destructive.locator('.mcp-deny').getByRole('button', { name: 'Deny' }).click();
    const denied = json(await del);
    expect(denied['status']).toBe('denied');
    expect(denied['note']).toBe('Keep cy, archive instead');

    // The MCP window lists the client and every action, the refused ones included.
    await client.callTool({ name: 'list_tables', arguments: { connection: 'Secret (e2e)' } });
    const [mcpWin] = await Promise.all([
      app.waitForEvent('window', { predicate: (w) => w.url().endsWith('#mcp') }),
      page.evaluate(() => (globalThis as unknown as { rasql: RasqlApi }).rasql.app.showMcp()),
    ]);
    await expect(mcpWin.locator('.mcp-audit')).toContainText('denied');
    await expect(mcpWin.locator('.mcp-audit')).toContainText('refused');
    await expect(mcpWin.locator('.mcp-audit')).toContainText('committed');
    await mcpWin.screenshot({ path: join(SHOTS, 'mcp-window.png'), fullPage: true });

    // Revoking disconnects the agent; it must ask again.
    await mcpWin.getByRole('button', { name: 'Revoke', exact: true }).click();
    const clients = mcpWin
      .locator('section')
      .filter({ has: mcpWin.locator('h2', { hasText: 'Clients' }) });
    await expect(clients).toContainText('No client has asked yet.');

    // The connection form offers the MCP setting, capped by the read-only flag.
    await page.locator('.connection-item', { hasText: 'Shop (e2e)' }).hover();
    await page
      .locator('li:has(> .connection-item:has-text("Shop (e2e)"))')
      .getByTitle('Edit')
      .click();
    const access = page.locator('label', { hasText: 'Agents (MCP)' }).locator('select');
    await expect(access).toHaveValue('ask');
    await page.locator('label', { hasText: 'Open read-only' }).locator('input').check();
    await expect(access).toHaveValue('read');
    await expect(access.locator('option')).toHaveCount(2);
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
  }
});

test('a Secure connection commits only after the OS confirms the user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rasql-e2e-mcp-secure-'));
  const file = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
    INSERT INTO users (name, age) VALUES ('ann', 30);`);
  db.close();
  const userData = mkdtempSync(join(tmpdir(), 'rasql-e2e-'));
  const now = new Date().toISOString();
  writeFileSync(
    join(userData, 'connections.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: 'shop',
          name: 'Secure shop (e2e)',
          environment: 'local',
          readOnly: false,
          mcp: 'secure',
          driver: 'sqlite',
          transport: 'file',
          filePath: file,
          options: {},
          credentials: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  // The client was allowed earlier, so the first prompt is the commit.
  writeFileSync(
    join(userData, 'mcp.json'),
    JSON.stringify({
      version: 1,
      clients: [{ name: 'e2e-agent', status: 'allowed', decidedAt: now }],
      httpEnabled: false,
      httpPort: 47334,
      rowLimit: 500,
    }),
  );

  const { app, page } = await launch(userData);
  // No real person in a test: the OS check is swapped for one whose first answer is no.
  await app.evaluate(() => {
    const hooks = (globalThis as unknown as Record<string, { presence: { check: unknown } }>)[
      '__rasql'
    ]!;
    const g = globalThis as unknown as { presenceCalls: number };
    g.presenceCalls = 0;
    hooks.presence.check = {
      id: 'e2e',
      label: 'Test ID',
      available: async () => true,
      verify: async () => ++g.presenceCalls > 1,
    };
  });
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  try {
    const status = await page.evaluate(() =>
      (globalThis as unknown as { rasql: RasqlApi }).rasql.mcp.status(),
    );
    await client.connect(new SocketClientTransport(status.socketPath));

    const pending = client.callTool({
      name: 'commit_changes',
      arguments: {
        connection: 'Secure shop (e2e)',
        statements: ['UPDATE users SET age = 31 WHERE id = 1'],
        wait_seconds: 60,
      },
    });
    // A safe change, and still a prompt: Secure confirms every change.
    const prompt = await nextPrompt(app);
    await expect(prompt.getByRole('button', { name: 'This session' })).toHaveCount(0);
    await expect(prompt.getByRole('button', { name: 'Always' })).toHaveCount(0);
    await expect(prompt.getByRole('button', { name: 'Once' })).toHaveCount(0);
    await prompt.screenshot({ path: join(SHOTS, 'mcp-commit-secure.png') });

    // The check fails: the prompt stays, says why, and nothing ran.
    await prompt.getByRole('button', { name: 'Approve with Test ID' }).click();
    await expect(prompt.locator('.form-error')).toContainText('Test ID did not confirm');
    // Red, as errors are everywhere else.
    expect(
      await prompt
        .locator('.form-error')
        .evaluate((e) => e.ownerDocument.defaultView!.getComputedStyle(e).color),
    ).not.toBe(
      await prompt
        .locator('.mcp-prompt h1')
        .evaluate((e) => e.ownerDocument.defaultView!.getComputedStyle(e).color),
    );
    // The check confirms: the change commits.
    await prompt.getByRole('button', { name: 'Approve with Test ID' }).click();
    expect(json(await pending)['status']).toBe('committed');
    // The failed check is in the audit log, next to the commit.
    const audit = await page.evaluate(() =>
      (globalThis as unknown as { rasql: RasqlApi }).rasql.mcp.audit(),
    );
    expect(audit.map((a) => `${a.tool} ${a.outcome}`).slice(0, 2)).toEqual([
      'commit_changes committed',
      'commit_changes refused',
    ]);
    expect(
      await app.evaluate(() => (globalThis as unknown as { presenceCalls: number }).presenceCalls),
    ).toBe(2);

    // The form offers Secure between Ask and Read/Write.
    await page.locator('.connection-item', { hasText: 'Secure shop (e2e)' }).hover();
    await page
      .locator('li:has(> .connection-item:has-text("Secure shop (e2e)"))')
      .getByTitle('Edit')
      .click();
    const access = page.locator('label', { hasText: 'Agents (MCP)' }).locator('select');
    await expect(access).toHaveValue('secure');
    await expect(access.locator('option')).toHaveText([
      'Hidden',
      'Read-only',
      'Ask',
      'Secure',
      'Read/Write',
    ]);
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
  }
});

test('a LocalWP site gets its MCP setting from the gear and is resolved live for agents', async () => {
  const socket = join(
    homedir(),
    'Library/Application Support/Local/run/EE0cNsiD3/mysql/mysqld.sock',
  );
  test.skip(
    process.platform !== 'darwin' || !existsSync(socket),
    'LocalWP site "wp" is not running',
  );
  const userData = mkdtempSync(join(tmpdir(), 'rasql-e2e-'));
  const now = new Date().toISOString();
  writeFileSync(
    join(userData, 'mcp.json'),
    JSON.stringify({
      version: 1,
      clients: [{ name: 'e2e-agent', status: 'allowed', decidedAt: now }],
      httpEnabled: false,
      httpPort: 47334,
      rowLimit: 500,
    }),
  );
  const { app, page } = await launch(userData);
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  try {
    // Read-only, so this test can never change the real site.
    const row = page.locator('.local-site-row').filter({
      has: page.locator('.local-site-name', { hasText: /^wp$/ }),
    });
    await row.locator('.local-site-mcp').click();
    await row.locator('.local-site-access select').selectOption('read');
    await expect(row.locator('.mcp-badge')).toContainText('agents: Read-only');
    await page.screenshot({ path: join(SHOTS, 'mcp-localwp-gear.png') });

    const status = await page.evaluate(() =>
      (globalThis as unknown as { rasql: RasqlApi }).rasql.mcp.status(),
    );
    await client.connect(new SocketClientTransport(status.socketPath));
    const list = json(await client.callTool({ name: 'list_connections', arguments: {} }));
    const wp = (list['connections'] as { id: string; name: string; access: string }[]).find(
      (c) => c.id === 'localwp:EE0cNsiD3',
    );
    expect(wp).toMatchObject({ name: 'wp', access: 'read' });
    const rows = json(
      await client.callTool({
        name: 'query',
        arguments: {
          connection: 'localwp:EE0cNsiD3',
          sql: "SELECT option_name FROM wp_options WHERE option_name = 'siteurl'",
        },
      }),
    );
    expect(rows['rows']).toEqual([['siteurl']]);
    const write = await client.callTool({
      name: 'commit_changes',
      arguments: {
        connection: 'localwp:EE0cNsiD3',
        statements: ["UPDATE wp_options SET option_value = option_value WHERE option_name = 'x'"],
      },
    });
    expect((write as { isError?: boolean }).isError).toBe(true);
    const rename = await client.callTool({
      name: 'update_connection',
      arguments: { connection: 'localwp:EE0cNsiD3', name: 'other' },
    });
    expect((rename as { isError?: boolean }).isError).toBe(true);

    // Back to the default (Hidden): the site is gone for agents at once.
    await row.locator('.local-site-access select').selectOption('default');
    const after = json(await client.callTool({ name: 'list_connections', arguments: {} }));
    expect((after['connections'] as { id: string }[]).map((c) => c.id)).not.toContain(
      'localwp:EE0cNsiD3',
    );
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
  }
});
