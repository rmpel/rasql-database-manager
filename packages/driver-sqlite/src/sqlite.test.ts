import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, type QueryEvent, type ResolvedEndpoint, type Value } from '@rasql/driver-protocol';
import { formatConformanceReport, runConformanceChecks } from '@rasql/driver-sdk';
import { sqliteDriver } from './index.js';
import { declaredTypeToValueType, toValue } from './values.js';

let dir: string;
let file: string;
let endpoint: ResolvedEndpoint;

const FIXTURE = `
CREATE TABLE kinds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n INTEGER,
  big INTEGER,
  r REAL,
  t TEXT,
  b BLOB,
  d DATE,
  dt DATETIME,
  j JSON,
  flag BOOLEAN,
  nada TEXT
);
INSERT INTO kinds (n, big, r, t, b, d, dt, j, flag, nada)
VALUES (42, 9223372036854775807, 1.5, 'héllo ☃ 🦈', X'00FF01', '2024-02-29', '2024-02-29 13:14:15.123', '{"a":1}', 1, NULL);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  kind_id INTEGER NOT NULL REFERENCES kinds(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'x'
);
CREATE UNIQUE INDEX child_label ON child(label);
CREATE INDEX child_kind ON child(kind_id, label DESC);
CREATE VIEW kinds_view AS SELECT id, t FROM kinds;
CREATE TABLE many (i INTEGER PRIMARY KEY, v TEXT);
CREATE TRIGGER many_ai AFTER INSERT ON many BEGIN SELECT 1; END;
`;

async function collect(events: AsyncIterable<QueryEvent>): Promise<QueryEvent[]> {
  const out: QueryEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const rowsOf = (events: QueryEvent[]): Value[][] =>
  events
    .filter((e): e is Extract<QueryEvent, { kind: 'rows' }> => e.kind === 'rows')
    .flatMap((e) => e.rows);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rasql-sqlite-'));
  file = join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(file);
  db.exec(FIXTURE);
  const ins = db.prepare('INSERT INTO many (v) VALUES (?)');
  db.exec('BEGIN');
  for (let i = 0; i < 20_000; i++) ins.run(`row ${i}`);
  db.exec('COMMIT');
  db.close();
  endpoint = { transport: 'file', filePath: file, options: {} };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sqlite driver conformance', () => {
  it('passes every conformance check through the protocol', async () => {
    const report = await runConformanceChecks(sqliteDriver, endpoint);
    expect(report.failed, formatConformanceReport(report)).toBe(0);
    expect(report.engine).toBe('sqlite');
  });
});

describe('sqlite driver', () => {
  it('maps every column type to a typed value', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const events = await collect(s.query('SELECT * FROM kinds'));
      const cols = (events[0] as Extract<QueryEvent, { kind: 'columns' }>).columns.map(
        (c) => c.valueType,
      );
      expect(cols).toEqual([
        'int',
        'int',
        'int',
        'float',
        'text',
        'bytes',
        'date',
        'datetime',
        'json',
        'bool',
        'text',
      ]);
      const row = rowsOf(events)[0]!;
      expect(row).toEqual([
        V.int(1),
        V.int(42),
        V.int('9223372036854775807'),
        V.float(1.5),
        V.text('héllo ☃ 🦈'),
        V.bytes(new Uint8Array([0, 255, 1])),
        V.date('2024-02-29'),
        V.datetime('2024-02-29 13:14:15.123'),
        V.json('{"a":1}'),
        V.bool(true),
        V.null(),
      ]);
    } finally {
      await s.close();
    }
  });

  it('describes columns, primary key, indexes, foreign keys and ddl', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const kinds = await s.describeTable('main', 'kinds');
      expect(kinds.primaryKey).toEqual(['id']);
      expect(kinds.columns[0]).toMatchObject({
        name: 'id',
        valueType: 'int',
        autoIncrement: true,
        nullable: false,
      });
      expect(kinds.ddl).toMatch(/^CREATE TABLE kinds/);

      const child = await s.describeTable('main', 'child');
      expect(child.columns.find((c) => c.name === 'label')).toMatchObject({
        nullable: false,
        default: { t: 'expression', sql: "'x'" },
      });
      expect(child.foreignKeys).toEqual([
        {
          name: 'fk_child_0',
          columns: ['kind_id'],
          referencedTable: 'kinds',
          referencedColumns: ['id'],
          onUpdate: 'NO ACTION',
          onDelete: 'CASCADE',
        },
      ]);
      const byName = Object.fromEntries(child.indexes.map((i) => [i.name, i]));
      expect(byName['child_label']).toMatchObject({
        unique: true,
        primary: false,
        columns: [{ name: 'label', order: 'asc' }],
      });
      expect(byName['child_kind']).toMatchObject({
        unique: false,
        columns: [
          { name: 'kind_id', order: 'asc' },
          { name: 'label', order: 'desc' },
        ],
      });

      const view = await s.describeTable('main', 'kinds_view');
      expect(view.kind).toBe('view');
      expect(view.columns.map((c) => c.name)).toEqual(['id', 't']);
    } finally {
      await s.close();
    }
  });

  it('lists schemas and objects', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      expect((await s.listSchemas()).map((x) => x.name)).toEqual(['main']);
      const objects = await s.listObjects('main');
      expect(objects.map((o) => `${o.kind}:${o.name}`).sort()).toEqual(
        ['table:child', 'table:kinds', 'table:many', 'trigger:many_ai', 'view:kinds_view'].sort(),
      );
    } finally {
      await s.close();
    }
  });

  it('describes triggers and views, and refuses kinds SQLite does not have', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const trg = await s.describeObject?.('main', 'trigger', 'many_ai');
      expect(trg?.ddl).toBe('CREATE TRIGGER many_ai AFTER INSERT ON many BEGIN SELECT 1; END');
      expect(trg?.properties).toEqual([
        { label: 'Table', value: 'many' },
        { label: 'Fires', value: 'AFTER INSERT, for each row' },
      ]);
      expect((await s.describeObject?.('main', 'view', 'kinds_view'))?.ddl).toMatch(/^CREATE VIEW/);
      await expect(s.describeObject?.('main', 'routine', 'x')).rejects.toMatchObject({
        code: 'UNSUPPORTED',
      });
    } finally {
      await s.close();
    }
  });

  it('alters tables in place where SQLite can, and says so where it cannot', async () => {
    const s = await sqliteDriver.connect(endpoint);
    const run = async (sql: string): Promise<void> => {
      for await (const e of s.query(sql)) if (e.kind === 'error') throw new Error(e.message);
    };
    try {
      await run('CREATE TABLE probe (id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
      const before = await s.describeTable('main', 'probe');
      const a = before.columns.find((c) => c.name === 'a')!;
      const statements = s.dialect.buildAlter!(before, [
        { kind: 'modifyColumn', name: 'a', column: { ...a, name: 'title' } },
        { kind: 'dropColumn', name: 'b' },
        {
          kind: 'addColumn',
          column: {
            name: 'n',
            ordinal: 0,
            nativeType: 'INTEGER',
            valueType: 'int',
            nullable: false,
            autoIncrement: false,
            default: V.int('0'),
          },
        },
        {
          kind: 'addIndex',
          index: {
            name: 'probe_title',
            unique: true,
            primary: false,
            columns: [{ name: 'title' }],
          },
        },
      ]);
      expect(statements).toEqual([
        'ALTER TABLE "main"."probe" RENAME COLUMN "a" TO "title"',
        'ALTER TABLE "main"."probe" DROP COLUMN "b"',
        'ALTER TABLE "main"."probe" ADD COLUMN "n" INTEGER NOT NULL DEFAULT 0',
        'CREATE UNIQUE INDEX "main"."probe_title" ON "probe" ("title")',
      ]);
      for (const sql of statements) await run(sql);
      const after = await s.describeTable('main', 'probe');
      expect(after.columns.map((c) => c.name)).toEqual(['id', 'title', 'n']);
      expect(after.indexes.map((i) => i.name)).toContain('probe_title');
      expect(() =>
        s.dialect.buildAlter!(after, [
          { kind: 'modifyColumn', name: 'n', column: { ...after.columns[2]!, nativeType: 'TEXT' } },
        ]),
      ).toThrow(/rebuilding the table/);
      expect(s.dialect.describe().alter?.modifyColumn).toBe(false);
    } finally {
      await run('DROP TABLE IF EXISTS probe');
      await s.close();
    }
  });

  it('reports affected rows and insert id for statements without results', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      await s.begin();
      const events = await collect(s.query("INSERT INTO child (kind_id, label) VALUES (1, 'a')"));
      expect(events).toEqual([
        expect.objectContaining({ kind: 'done', affectedRows: 1, insertId: '1' }),
      ]);
      await s.rollback();
    } finally {
      await s.close();
    }
  });

  it('binds typed parameters', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const events = await collect(
        s.query('SELECT ? AS a, ? AS b, ? AS c, ? AS d', {
          params: [V.int('9007199254740993'), V.text('x'), V.bytes(new Uint8Array([7])), V.null()],
        }),
      );
      expect(rowsOf(events)[0]).toEqual([
        V.int('9007199254740993'),
        V.text('x'),
        V.bytes(new Uint8Array([7])),
        V.null(),
      ]);
    } finally {
      await s.close();
    }
  });

  it('keeps duplicate column names apart', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const events = await collect(s.query('SELECT 1 AS a, 2 AS a'));
      expect(rowsOf(events)[0]).toEqual([V.int(1), V.int(2)]);
    } finally {
      await s.close();
    }
  });

  it('streams in batches, honors maxRows and cancels between batches', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const limited = await collect(
        s.query('SELECT * FROM many', { maxRows: 300, rowBatchSize: 100 }),
      );
      expect(rowsOf(limited)).toHaveLength(300);
      expect(limited.filter((e) => e.kind === 'rows')).toHaveLength(3);
      expect(limited[limited.length - 1]).toMatchObject({
        kind: 'done',
        rowCount: 300,
        truncated: true,
      });

      const ac = new AbortController();
      let rows = 0;
      let last: QueryEvent | undefined;
      for await (const e of s.query('SELECT * FROM many', {
        rowBatchSize: 100,
        signal: ac.signal,
      })) {
        if (e.kind === 'rows') {
          rows += e.rows.length;
          if (rows >= 200) ac.abort();
        }
        last = e;
      }
      expect(rows).toBeLessThan(20_000);
      expect(last).toMatchObject({ kind: 'error', code: 'CANCELLED' });
    } finally {
      await s.close();
    }
  });

  it('turns a read-only session into refused writes', async () => {
    const s = await sqliteDriver.connect({ ...endpoint, readOnly: true });
    try {
      expect((await s.info()).readOnly).toBe(true);
      const events = await collect(s.query("INSERT INTO child (kind_id, label) VALUES (1, 'ro')"));
      expect(events[0]).toMatchObject({ kind: 'error' });
      await s.setReadOnly(false);
    } finally {
      await s.close();
    }
  });

  it('explains', async () => {
    const s = await sqliteDriver.connect(endpoint);
    try {
      const r = await s.explain('SELECT * FROM child WHERE label = ?');
      expect(r.format).toBe('table');
      expect(r.rows?.some((row) => row[3]?.t === 'text' && /child_label/.test(row[3].v))).toBe(
        true,
      );
    } finally {
      await s.close();
    }
  });

  it('refuses to invent a database file', async () => {
    await expect(
      sqliteDriver.connect({ transport: 'file', filePath: join(dir, 'nope.sqlite'), options: {} }),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    const s = await sqliteDriver.connect({
      transport: 'file',
      filePath: join(dir, 'new.sqlite'),
      options: { createIfMissing: true },
    });
    await s.close();
  });

  it('maps declared types the SQLite way', () => {
    expect(declaredTypeToValueType('VARCHAR(255)')).toBe('text');
    expect(declaredTypeToValueType('BIGINT UNSIGNED')).toBe('int');
    expect(declaredTypeToValueType('DOUBLE PRECISION')).toBe('float');
    expect(declaredTypeToValueType('')).toBe('unknown');
    expect(declaredTypeToValueType('something')).toBe('text');
    expect(toValue(2.0, 'REAL')).toEqual(V.int(2));
    expect(toValue(2.5, 'REAL')).toEqual(V.float(2.5));
    expect(toValue(1n, 'BOOLEAN')).toEqual(V.bool(true));
  });
});
