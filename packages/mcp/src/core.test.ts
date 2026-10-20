import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Session } from '@rasql/driver-protocol';
import { sqliteDriver } from '@rasql/driver-sqlite';
import { McpCore } from './core.js';
import type {
  AgentConnection,
  AgentSession,
  AuditEntry,
  ChangeSetSummary,
  CommitAnswer,
  McpHost,
} from './host.js';

/** The driver's in-process session, shaped like the app's remote one. */
function agentSession(s: Session, info: AgentSession['serverInfo']): AgentSession {
  return {
    serverInfo: info,
    dialect: {
      classify: async (sql) => s.dialect.classify(sql),
      buildSelect: async (t, o) => s.dialect.buildSelect(t, o),
    },
    listSchemas: () => s.listSchemas(),
    listObjects: (x) => s.listObjects(x),
    describeTable: (x, t) => s.describeTable(x, t),
    describeObject: (x, k, n) => s.describeObject!(x, k, n),
    query: (sql, o) => s.query(sql, o),
    explain: (sql) => s.explain(sql),
    setReadOnly: (on) => s.setReadOnly(on),
    begin: () => s.begin(),
    commit: () => s.commit(),
    rollback: () => s.rollback(),
  };
}

let dir: string;
let session: Session;
let host: McpHost & {
  answers: CommitAnswer[];
  prompts: ChangeSetSummary[];
  audits: AuditEntry[];
  conns: AgentConnection[];
};
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rasql-mcp-'));
  const file = join(dir, 'shop.db');
  const seed = new DatabaseSync(file);
  seed.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER); INSERT INTO users (name, age) VALUES ('ann', 30), ('bob', 40)",
  );
  seed.close();
  session = await sqliteDriver.connect({ transport: 'file', filePath: file, options: {} });
  await session.setReadOnly(true);
  const agent = agentSession(session, await session.info());
  let queue = Promise.resolve();
  host = {
    answers: [],
    prompts: [],
    audits: [],
    conns: [
      {
        id: 'c1',
        name: 'shop',
        driver: 'sqlite',
        environment: 'local',
        readOnly: false,
        access: 'ask',
      },
      {
        id: 'c2',
        name: 'secret',
        driver: 'sqlite',
        environment: 'production',
        readOnly: false,
        access: 'hidden',
      },
    ],
    connections() {
      return this.conns;
    },
    withSession<T>(_id: string, fn: (s: AgentSession) => Promise<T>): Promise<T> {
      const run = queue.then(() => fn(agent));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    approveClient: async () => true,
    createConnection: async () => null,
    updateConnection(id, patch) {
      const c = this.conns.find((x) => x.id === id)!;
      if (patch.name) c.name = patch.name;
      return c;
    },
    async promptCommit(summary) {
      this.prompts.push(summary);
      return this.answers.shift() ?? { decision: 'expired' };
    },
    allowAlways(id) {
      this.conns.find((x) => x.id === id)!.access = 'write';
    },
    audit(entry) {
      this.audits.push(entry);
    },
    activity: () => undefined,
    rowLimit: () => 100,
  };
  const core = new McpCore(host, { name: 'rasql', version: 'test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await core.createServer().connect(a);
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
  await session.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown> = {},
  // Tool results are free-form JSON; the tests index into them directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ error: boolean; data: any }> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const text = r.content[0]?.text ?? '';
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain message */
  }
  return { error: Boolean(r.isError), data };
}

describe('MCP server', () => {
  it('lists only connections that are not hidden', async () => {
    const r = await call('list_connections');
    expect(r.data.connections.map((c: { name: string }) => c.name)).toEqual(['shop']);
    expect((await call('list_tables', { connection: 'secret' })).error).toBe(true);
  });

  it('reads typed data and refuses writes in query', async () => {
    const r = await call('query', {
      connection: 'shop',
      sql: 'SELECT id, name FROM users ORDER BY id',
    });
    expect(r.data.rows).toEqual([
      [1, 'ann'],
      [2, 'bob'],
    ]);
    const w = await call('query', { connection: 'shop', sql: 'DELETE FROM users' });
    expect(w.error).toBe(true);
    expect(w.data).toMatch(/reads only/);
    expect(host.audits.at(-1)?.outcome).toBe('refused');
  });

  it('commits after the user allows it once, and asks again next time', async () => {
    host.answers.push({ decision: 'once' });
    const r = await call('commit_changes', {
      connection: 'shop',
      statements: ["INSERT INTO users (name, age) VALUES ('cy', 20)"],
    });
    expect(r.data.status).toBe('committed');
    expect(host.prompts).toHaveLength(1);
    const after = await call('query', { connection: 'shop', sql: 'SELECT COUNT(*) FROM users' });
    expect(after.data.rows[0][0]).toBe(3);
    // The session is back to read-only after the commit.
    expect((await call('query', { connection: 'shop', sql: 'SELECT 1' })).error).toBe(false);
    host.answers.push({ decision: 'deny', note: 'not today' });
    const d = await call('commit_changes', {
      connection: 'shop',
      statements: ['UPDATE users SET age = 1 WHERE id = 1'],
    });
    expect(d.data.status).toBe('denied');
    expect(d.data.note).toBe('not today');
  });

  it('runs safe changes without a prompt under This session, but still asks for destructive ones', async () => {
    host.answers.push({ decision: 'session' });
    await call('commit_changes', {
      connection: 'shop',
      statements: ['UPDATE users SET age = 31 WHERE id = 1'],
    });
    const second = await call('commit_changes', {
      connection: 'shop',
      statements: ['UPDATE users SET age = 41 WHERE id = 2'],
    });
    expect(second.data.status).toBe('committed');
    expect(host.prompts).toHaveLength(1);
    expect(host.audits.at(-1)?.detail).toBe('committed without a prompt');
    host.answers.push({ decision: 'deny' });
    const del = await call('commit_changes', {
      connection: 'shop',
      statements: ['DELETE FROM users WHERE id = 2'],
    });
    expect(del.data.status).toBe('denied');
    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]?.safety).toBe('destructive');
    expect(host.prompts[1]?.statements[0]?.estimatedRows).toBe(1);
  });

  it('switches to Read/Write on Always', async () => {
    host.answers.push({ decision: 'always' });
    await call('commit_changes', {
      connection: 'shop',
      statements: ['UPDATE users SET age = 1 WHERE id = 1'],
    });
    expect(host.conns[0]?.access).toBe('write');
  });

  it('rolls back the whole change set when a statement fails', async () => {
    host.conns[0]!.access = 'write';
    const r = await call('commit_changes', {
      connection: 'shop',
      statements: ["INSERT INTO users (name) VALUES ('dee')", 'INSERT INTO nope VALUES (1)'],
    });
    expect(r.data.status).toBe('failed');
    expect(r.data.error).toMatch(/Statement 2 of 2 failed/);
    const count = await call('query', { connection: 'shop', sql: 'SELECT COUNT(*) FROM users' });
    expect(count.data.rows[0][0]).toBe(2);
  });

  it('asks for every change on a Secure connection, whatever was answered before', async () => {
    host.conns[0]!.access = 'secure';
    host.answers.push({ decision: 'session' }, { decision: 'always' }, { decision: 'once' });
    for (const age of [1, 2, 3]) {
      const r = await call('commit_changes', {
        connection: 'shop',
        statements: [`UPDATE users SET age = ${age} WHERE id = 1`],
      });
      expect(r.data.status).toBe('committed');
    }
    // Safe changes, yet three prompts: This session and Always did not stick.
    expect(host.prompts).toHaveLength(3);
    expect(host.conns[0]?.access).toBe('secure');
  });

  it('refuses changes on a Read-only connection without asking', async () => {
    host.conns[0]!.access = 'read';
    const r = await call('commit_changes', {
      connection: 'shop',
      statements: ["INSERT INTO users (name) VALUES ('x')"],
    });
    expect(r.error).toBe(true);
    expect(host.prompts).toHaveLength(0);
  });

  it('refuses connection changes that would move it', async () => {
    expect((await call('update_connection', { connection: 'shop', host: 'evil' })).error).toBe(
      true,
    );
    expect((await call('update_connection', { connection: 'shop', name: 'shop2' })).error).toBe(
      false,
    );
  });
});
