import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DriverClient,
  createInProcessTransports,
  serveDriver,
  type RemoteSession,
} from '@rasql/driver-sdk';
import { sqliteDriver } from '@rasql/driver-sqlite';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  ipcMain: { handle: () => undefined },
}));

const { runExport, ExportCancelled } = await import('./export');

let dir: string;
let client: DriverClient;
let stop: () => void;
let session: RemoteSession;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rasql-export-'));
  const file = join(dir, 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL, data BLOB, note TEXT, meta JSON, big INTEGER);
    INSERT INTO items (name, price, data, note, meta, big) VALUES
      ('plain', 1.5, X'00FF', 'a "quoted", note', '{"k":[1,2]}', 9223372036854775807),
      ('two
lines', NULL, NULL, NULL, 'not json', 42);
    CREATE TABLE many (i INTEGER PRIMARY KEY, v TEXT);
  `);
  const ins = db.prepare('INSERT INTO many (v) VALUES (?)');
  db.exec('BEGIN');
  for (let i = 0; i < 30_000; i++) ins.run(`row ${i}`);
  db.exec('COMMIT');
  db.close();
  const t = createInProcessTransports();
  stop = serveDriver(sqliteDriver, t.driver);
  client = new DriverClient(t.host);
  session = await client.connect({ transport: 'file', filePath: file, options: {} });
});

afterAll(async () => {
  await session.close().catch(() => undefined);
  client.shutdown();
  stop();
  rmSync(dir, { recursive: true, force: true });
});

const run = (
  format: 'csv' | 'json' | 'sql',
  name: string,
  extra: Partial<Parameters<typeof runExport>[0]> = {},
  options?: NonNullable<Parameters<typeof runExport>[0]['req']['options']>,
) =>
  runExport({
    session,
    req: {
      sql: 'SELECT * FROM items ORDER BY id',
      format,
      suggestedName: 'items',
      table: { name: 'items' },
      ...(options ? { options } : {}),
    },
    filePath: join(dir, name),
    signal: new AbortController().signal,
    now: () => new Date('2026-10-09T10:00:00Z'),
    ...extra,
  });

describe('runExport', () => {
  it('writes CSV with header, quoting and typed cells', async () => {
    const summary = await run('csv', 'items.csv');
    expect(summary.rows).toBe(2);
    const text = readFileSync(join(dir, 'items.csv'), 'utf8');
    expect(text).toBe(
      'id,name,price,data,note,meta,big\n' +
        '1,plain,1.5,0x00ff,"a ""quoted"", note","{""k"":[1,2]}",9223372036854775807\n' +
        '2,"two\nlines",,,,not json,42\n',
    );
    expect(summary.bytes).toBe(Buffer.byteLength(text));
  });

  it('writes a JSON array with lossless values', async () => {
    await run('json', 'items.json');
    const parsed = JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8')) as Record<
      string,
      unknown
    >[];
    expect(parsed).toEqual([
      {
        id: 1,
        name: 'plain',
        price: 1.5,
        data: { $bytes: 'AP8=' },
        note: 'a "quoted", note',
        meta: { k: [1, 2] },
        big: '9223372036854775807',
      },
      { id: 2, name: 'two\nlines', price: null, data: null, note: null, meta: 'not json', big: 42 },
    ]);
  });

  it('writes NDJSON when asked', async () => {
    await run('json', 'items.ndjson', {}, { ndjson: true });
    const lines = readFileSync(join(dir, 'items.ndjson'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, big: 42 });
  });

  it('writes SQL inserts in batches that load back', async () => {
    await run('sql', 'items.sql', {}, { batchSize: 1 });
    const text = readFileSync(join(dir, 'items.sql'), 'utf8');
    expect(
      text.startsWith(
        '-- RaSQL export, 2026-10-09T10:00:00.000Z\n-- SELECT * FROM items ORDER BY id\n\n',
      ),
    ).toBe(true);
    expect(text.match(/INSERT INTO "items"/g)).toHaveLength(2);
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL, data BLOB, note TEXT, meta JSON, big INTEGER)',
    );
    db.exec(text);
    const rows = db
      .prepare('SELECT id, name, hex(data) AS h, CAST(big AS TEXT) AS big FROM items ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 1, name: 'plain', h: '00FF', big: '9223372036854775807' },
      { id: 2, name: 'two\nlines', h: '', big: '42' },
    ]);
    db.close();
  });

  it('refuses SQL without a table and leaves no file behind', async () => {
    await expect(
      runExport({
        session,
        req: { sql: 'SELECT 1', format: 'sql', suggestedName: 'x' },
        filePath: join(dir, 'none.sql'),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/target table/);
    expect(existsSync(join(dir, 'none.sql'))).toBe(false);
  });

  it('reports a statement error and removes the partial file', async () => {
    await expect(
      runExport({
        session,
        req: { sql: 'SELECT * FROM nope', format: 'csv', suggestedName: 'x' },
        filePath: join(dir, 'bad.csv'),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/nope/);
    expect(existsSync(join(dir, 'bad.csv'))).toBe(false);
  });

  it('reports progress and stops on cancel, removing the partial file', async () => {
    const ac = new AbortController();
    const seen: number[] = [];
    const p = runExport({
      session,
      req: { sql: 'SELECT * FROM many', format: 'csv', suggestedName: 'many' },
      filePath: join(dir, 'many.csv'),
      signal: ac.signal,
      progressEvery: 1000,
      onProgress: (rows) => {
        seen.push(rows);
        if (rows >= 2000) ac.abort();
      },
    });
    await expect(p).rejects.toBeInstanceOf(ExportCancelled);
    expect(seen[0]).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...seen)).toBeLessThan(30_000);
    expect(existsSync(join(dir, 'many.csv'))).toBe(false);
  });

  it('exports a large table completely', async () => {
    const summary = await runExport({
      session,
      req: { sql: 'SELECT * FROM many', format: 'csv', suggestedName: 'many' },
      filePath: join(dir, 'many-all.csv'),
      signal: new AbortController().signal,
    });
    expect(summary.rows).toBe(30_000);
    const lines = readFileSync(join(dir, 'many-all.csv'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(30_001);
    expect(lines[lines.length - 1]).toBe('30000,row 29999');
  });
});
