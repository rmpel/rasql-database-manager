/**
 * Runs the driver against real PostgreSQL servers. Enabled by RASQL_TEST_MATRIX=1 (every
 * postgres service in test/matrix/docker-compose.yml whose port answers) or
 * RASQL_POSTGRES_DSN=postgres://u:p@h:port/db.
 */
import { connect as netConnect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  V,
  type QueryEvent,
  type ResolvedEndpoint,
  type Session,
  type TableDefinition,
  type Value,
} from '@rasql/driver-protocol';
import { formatConformanceReport, runConformanceChecks } from '@rasql/driver-sdk';
import { postgresDriver } from './index.js';

const MATRIX = [
  { name: 'postgres13', port: 35413 },
  { name: 'postgres16', port: 35416 },
  { name: 'postgres18', port: 35418 },
];

function reachable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ port, host });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(700, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function endpointFromDsn(dsn: string): ResolvedEndpoint {
  const u = new URL(dsn);
  const ep: ResolvedEndpoint = {
    transport: 'tcp',
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 5432,
    options: {},
  };
  if (u.username) ep.user = decodeURIComponent(u.username);
  if (u.password) ep.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) ep.database = db;
  return ep;
}

const targets: { name: string; endpoint: ResolvedEndpoint }[] = [];
const skipped: string[] = [];
if (process.env['RASQL_TEST_MATRIX']) {
  for (const m of MATRIX) {
    if (await reachable(m.port))
      targets.push({
        name: m.name,
        endpoint: {
          transport: 'tcp',
          host: '127.0.0.1',
          port: m.port,
          user: 'rasql',
          password: 'rasql',
          database: 'rasql',
          options: {},
        },
      });
    else skipped.push(m.name);
  }
} else if (process.env['RASQL_POSTGRES_DSN']) {
  targets.push({ name: 'dsn', endpoint: endpointFromDsn(process.env['RASQL_POSTGRES_DSN']) });
}
if (process.env['RASQL_TEST_MATRIX'] || process.env['RASQL_POSTGRES_DSN']) {
  console.log(
    `[driver-postgres matrix] running against: ${targets.map((t) => t.name).join(', ') || 'nothing'}` +
      (skipped.length ? ` | not reachable: ${skipped.join(', ')}` : ''),
  );
}

async function collect(events: AsyncIterable<QueryEvent>): Promise<QueryEvent[]> {
  const out: QueryEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const rowsOf = (events: QueryEvent[]): Value[][] =>
  events
    .filter((e): e is Extract<QueryEvent, { kind: 'rows' }> => e.kind === 'rows')
    .flatMap((e) => e.rows);
const columnsOf = (events: QueryEvent[]) =>
  (events.find((e) => e.kind === 'columns') as Extract<QueryEvent, { kind: 'columns' }>).columns;
const errorOf = (events: QueryEvent[]) =>
  events.find((e): e is Extract<QueryEvent, { kind: 'error' }> => e.kind === 'error');

async function rowByName(s: Session, sql: string): Promise<Record<string, Value>> {
  const events = await collect(s.query(sql));
  const err = errorOf(events);
  if (err) throw new Error(`query failed: ${JSON.stringify(err)}`);
  const cols = columnsOf(events);
  const row = rowsOf(events)[0];
  if (!row) throw new Error(`no row for ${sql}`);
  return Object.fromEntries(cols.map((c, i) => [c.name, row[i]!]));
}

if (targets.length === 0) {
  describe.skip('postgres driver engine matrix (set RASQL_TEST_MATRIX=1 with pnpm matrix:up, or RASQL_POSTGRES_DSN)', () => {
    it('is skipped', () => undefined);
  });
}

describe.each(targets)('postgres driver against $name', ({ name, endpoint }) => {
  let s: Session;

  beforeAll(async () => {
    s = await postgresDriver.connect(endpoint);
    // Leftovers of an interrupted run would show up in the object list.
    await collect(s.query('DROP TABLE IF EXISTS alter_me, altered_me'));
  }, 30_000);

  afterAll(async () => {
    await s?.close();
  });

  it('passes every conformance check through the protocol', async () => {
    const report = await runConformanceChecks(postgresDriver, endpoint);
    expect(report.failed, formatConformanceReport(report)).toBe(0);
    console.log(
      `[driver-postgres matrix] ${name}: ${report.engine} ${report.version}, ${report.passed} passed, ${report.skipped} skipped`,
    );
  }, 60_000);

  it('reports the engine, a clean version, user and schema', async () => {
    const info = await s.info();
    expect(info.engine).toBe('postgres');
    expect(info.version).toMatch(/^\d+\.\d+$/);
    expect(info.version.split('.')[0]).toBe(name.replace('postgres', ''));
    expect(info.user).toBe('rasql');
    expect(info.currentSchema).toBe('public');
    expect(info.charset).toBe('UTF8');
  });

  it('renders every type in kinds row 1 as a typed value', async () => {
    const r = await rowByName(s, 'SELECT * FROM kinds ORDER BY id LIMIT 1');
    expect(r['id']).toEqual(V.int('1'));
    expect(r['small']).toEqual(V.int('-32768'));
    expect(r['normal']).toEqual(V.int('2147483647'));
    expect(r['big']).toEqual(V.int('-9223372036854775807'));
    expect(r['decim']).toEqual(V.decimal('12345678901234.567891'));
    expect(r['f']).toEqual(V.float(1.5));
    expect(r['d']).toEqual(V.float(2.25));
    expect(r['flag']).toEqual(V.bool(true));
    expect(r['c']).toEqual(V.text('abc  '));
    expect(r['vc']).toEqual(V.text('héllo ☃ 🦈'));
    expect(r['t']).toEqual(V.text('text ☃'));
    expect(r['b']).toEqual(V.bytes(new Uint8Array([0, 255, 1, 2])));
    expect(r['dt']).toEqual(V.date('2024-02-29'));
    expect(r['tm']).toEqual(V.time('12:34:56.123456'));
    expect(r['tmz']).toEqual(V.time('12:00:00+02'));
    expect(r['ts']).toEqual(V.datetime('2024-02-29 13:14:15.123456'));
    expect(r['tsz']!.t).toBe('datetime');
    expect(r['iv']).toEqual(V.text('3 days 04:05:06'));
    expect(r['js']!.t).toBe('json');
    expect(JSON.parse((r['js'] as { v: string }).v)).toEqual({ a: 1, b: [1, 2, 3], s: 'héllo' });
    expect(r['jb']).toEqual(V.json('{"a": 1}'));
    expect(r['u']).toEqual(V.text('550e8400-e29b-41d4-a716-446655440000'));
    expect(r['bits']).toEqual(V.bit(new Uint8Array([0x55]), 7));
    expect(r['vbits']).toEqual(V.bit(new Uint8Array([5]), 3));
    expect(r['m']).toEqual(V.enum('happy'));
    expect(r['pos']).toEqual(V.int('7'));
    expect(r['arr']).toEqual(V.text('{1,2,3}'));
    expect(r['ip']).toEqual(V.text('192.168.0.1/24'));
    expect(r['pt']).toEqual(V.text('(1.5,2)'));
    expect(r['money_']!.t).toBe('text');
  });

  it('renders NULLs, infinities and NaN', async () => {
    const nulls = await rowByName(s, 'SELECT * FROM kinds ORDER BY id OFFSET 1 LIMIT 1');
    for (const key of ['small', 'decim', 'vc', 'b', 'js', 'dt', 'm', 'arr', 'bits'])
      expect(nulls[key]).toEqual(V.null());
    const odd = await rowByName(
      s,
      'SELECT d, decim, ts, dt FROM kinds ORDER BY id OFFSET 2 LIMIT 1',
    );
    expect(odd['d']).toEqual(V.float(Infinity));
    expect(odd['decim']).toEqual(V.decimal('NaN'));
    expect(odd['ts']).toEqual(V.datetime('infinity'));
    expect(odd['dt']).toEqual(V.date('-infinity'));
  });

  it('names result column types the way PostgreSQL does', async () => {
    const cols = columnsOf(
      await collect(s.query('SELECT id, vc, b, m, pos, arr FROM kinds LIMIT 1')),
    );
    expect(cols.map((c) => [c.name, c.nativeType, c.valueType])).toEqual([
      ['id', 'int8', 'int'],
      ['vc', 'varchar', 'text'],
      ['b', 'bytea', 'bytes'],
      ['m', 'mood', 'enum'],
      ['pos', 'int4', 'int'],
      ['arr', '_int4', 'text'],
    ]);
  });

  it('describes children: pk, identity, fk, indexes, generated column, comments, ddl', async () => {
    const def = await s.describeTable('public', 'children');
    expect(def.kind).toBe('table');
    expect(def.primaryKey).toEqual(['id']);
    const col = (n: string) => def.columns.find((c) => c.name === n)!;
    expect(col('id')).toMatchObject({
      autoIncrement: true,
      nullable: false,
      nativeType: 'integer',
    });
    expect(col('label')).toMatchObject({
      nativeType: 'varchar(50)',
      default: V.text('none'),
      comment: 'Shown in lists',
    });
    expect(col('position').default).toEqual(V.int('0'));
    expect(col('score')).toMatchObject({ nativeType: 'numeric(5,2)', default: V.decimal('-1.5') });
    expect(col('full_label').generated?.stored).toBe(true);
    expect(def.foreignKeys).toEqual([
      {
        name: 'fk_children_parent',
        columns: ['parent_id'],
        referencedSchema: 'public',
        referencedTable: 'parents',
        referencedColumns: ['id'],
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE',
      },
    ]);
    const byName = Object.fromEntries(def.indexes.map((i) => [i.name, i]));
    expect(byName['children_pkey']).toMatchObject({ primary: true, constraint: true });
    expect(byName['uq_parent_position']).toMatchObject({ unique: true, constraint: true });
    expect(byName['idx_parent_label']!.columns).toEqual([
      { name: 'parent_id', order: 'asc' },
      { name: 'label', order: 'desc' },
    ]);
    expect(byName['idx_lower_label']).toMatchObject({
      columns: [{ expression: 'lower(label::text)', order: 'asc' }],
      where: '"position" > 0',
    });
    expect(byName['idx_lower_label']!.constraint).toBeUndefined();
    expect(def.comment).toBe('Has a foreign key to parents');
    expect(def.ddl).toMatch(/^CREATE TABLE "public"\."children" \(/);
    expect(def.ddl).toMatch(/CONSTRAINT "fk_children_parent" FOREIGN KEY/);
    expect(def.ddl).toMatch(/CREATE INDEX idx_lower_label ON public\.children/);

    const parents = await s.describeTable('public', 'parents');
    expect(parents.columns[0]).toMatchObject({ name: 'id', autoIncrement: true });
    expect(parents.columns[0]!.default).toEqual({
      t: 'expression',
      sql: "nextval('parents_id_seq'::regclass)",
    });
    expect(parents.columns.find((c) => c.name === 'created_at')).toMatchObject({
      nativeType: 'timestamptz',
      default: { t: 'expression', sql: 'now()' },
    });
  });

  it('describes views and materialized views', async () => {
    const v = await s.describeTable('public', 'children_view');
    expect(v.kind).toBe('view');
    expect(v.columns.map((c) => c.name)).toEqual(['id', 'label', 'parent']);
    expect(v.ddl).toMatch(/^CREATE OR REPLACE VIEW "public"\."children_view" AS\n/);
    const m = await s.describeObject!('public', 'view', 'parent_counts');
    expect(m.ddl).toMatch(/^CREATE MATERIALIZED VIEW/);
  });

  it('lists schemas and every object kind, telling overloads apart', async () => {
    const schemas = await s.listSchemas();
    expect(schemas.find((x) => x.name === 'public')).toMatchObject({ isCurrent: true });
    expect(schemas.find((x) => x.name === 'pg_catalog')).toMatchObject({ isSystem: true });
    expect(schemas.map((x) => x.name)).toContain('sales');
    const objects = await s.listObjects('public');
    const names = (kind: string) =>
      objects
        .filter((o) => o.kind === kind)
        .map((o) => o.name)
        .sort();
    expect(names('table')).toEqual(['children', 'kinds', 'many', 'parents', 'wp_options']);
    expect(names('view')).toEqual(['children_view', 'parent_counts']);
    expect(names('sequence')).toContain('invoice_numbers');
    expect(names('routine')).toEqual([
      'add_one(x integer)',
      'add_one(x numeric)',
      'child_count',
      'fill_many',
      'trg_label_trim',
    ]);
    expect(objects.find((o) => o.name === 'trg_children_bi')).toMatchObject({
      kind: 'trigger',
      extra: { table: 'children', timing: 'BEFORE', event: 'INSERT' },
    });
    expect(objects.find((o) => o.name === 'many')!.rowEstimate).toBe(100000);
  });

  it('describes routines, triggers and sequences', async () => {
    const fn = await s.describeObject!('public', 'routine', 'child_count');
    expect(fn.ddl).toMatch(/CREATE OR REPLACE FUNCTION public\.child_count\(pid integer\)/);
    expect(fn.properties).toEqual(
      expect.arrayContaining([
        { label: 'Returns', value: 'integer' },
        { label: 'Volatility', value: 'stable' },
        { label: 'Language', value: 'sql' },
      ]),
    );
    const overload = await s.describeObject!('public', 'routine', 'add_one(x numeric)');
    expect(overload.ddl).toMatch(/add_one\(x numeric\)/);
    expect(overload.ddl).not.toMatch(/x integer/);
    const proc = await s.describeObject!('public', 'routine', 'fill_many');
    expect(proc.properties).toContainEqual({ label: 'Type', value: 'procedure' });
    const trg = await s.describeObject!('public', 'trigger', 'trg_children_bi');
    expect(trg.ddl).toMatch(/^CREATE TRIGGER trg_children_bi BEFORE INSERT ON (public\.)?children/);
    expect(trg.properties).toContainEqual({ label: 'Fires', value: 'BEFORE INSERT, for each row' });
    const seq = await s.describeObject!('public', 'sequence', 'invoice_numbers');
    expect(seq.ddl).toMatch(/START WITH 1000/);
    expect(seq.properties).toContainEqual({ label: 'Increment', value: '10' });
  });

  it('applies a structure change built by the dialect, in a transaction', async () => {
    const run = async (sql: string): Promise<void> => {
      const err = errorOf(await collect(s.query(sql)));
      if (err) throw new Error(`${err.message}\n${sql}`);
    };
    await run('DROP TABLE IF EXISTS alter_me');
    await run(
      "CREATE TABLE alter_me (id integer PRIMARY KEY, name varchar(20) NOT NULL DEFAULT 'x', old text, n integer)",
    );
    const before = await s.describeTable('public', 'alter_me');
    const col = (n: string) => before.columns.find((c) => c.name === n)!;
    const statements = s.dialect.buildAlter!(before, [
      { kind: 'dropColumn', name: 'old' },
      {
        kind: 'modifyColumn',
        name: 'name',
        column: {
          ...col('name'),
          name: 'title',
          nativeType: 'VARCHAR(80)',
          nullable: true,
          default: V.text("it's"),
        },
      },
      {
        kind: 'modifyColumn',
        name: 'n',
        column: { ...col('n'), nativeType: 'BIGINT', comment: 'count' },
      },
      {
        kind: 'addColumn',
        column: {
          name: 'seq',
          ordinal: 5,
          nativeType: 'INTEGER',
          valueType: 'int',
          nullable: false,
          autoIncrement: true,
        },
      },
      {
        kind: 'addIndex',
        index: { name: 'ix_title', unique: true, primary: false, columns: [{ name: 'title' }] },
      },
      { kind: 'setComment', comment: 'altered' },
      { kind: 'renameTable', to: 'altered_me' },
    ]);
    await s.begin();
    try {
      for (const sql of statements) await run(sql);
      await s.commit();
    } catch (err) {
      await s.rollback();
      throw err;
    }
    const after: TableDefinition = await s.describeTable('public', 'altered_me');
    expect(after.columns.map((c) => c.name)).toEqual(['id', 'title', 'n', 'seq']);
    expect(after.columns[1]).toMatchObject({
      nativeType: 'varchar(80)',
      nullable: true,
      default: V.text("it's"),
    });
    expect(after.columns[2]).toMatchObject({ nativeType: 'bigint', comment: 'count' });
    expect(after.columns[3]).toMatchObject({ autoIncrement: true, nullable: false });
    expect(after.indexes.find((i) => i.name === 'ix_title')).toMatchObject({ unique: true });
    expect(after.comment).toBe('altered');

    // Primary key out, and back on two columns.
    const drop = s.dialect.buildAlter!(after, [
      { kind: 'dropIndex', name: 'alter_me_pkey' },
      {
        kind: 'addIndex',
        index: {
          name: 'PRIMARY',
          unique: true,
          primary: true,
          columns: [{ name: 'id' }, { name: 'seq' }],
        },
      },
    ]);
    for (const sql of drop) await run(sql);
    expect((await s.describeTable('public', 'altered_me')).primaryKey).toEqual(['id', 'seq']);
    await run('DROP TABLE altered_me');
  });

  it('reads serialized WordPress data through a dialect-built select', async () => {
    const sql = s.dialect.buildSelect(
      { schema: 'public', name: 'wp_options' },
      {
        where: [{ column: 'option_name', op: 'contains', value: V.text('PLUGIN') }],
        limit: 10,
      },
    );
    const rows = rowsOf(await collect(s.query(sql)));
    expect(rows).toHaveLength(1);
    expect(rows[0]![2]).toEqual(
      V.text('a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:9:"hello.php";}'),
    );
  });

  it('filters numbers and dates with contains, and with regular expressions', async () => {
    const count = async (where: Parameters<Session['dialect']['buildCount']>[1]['where']) => {
      const r = rowsOf(
        await collect(s.query(s.dialect.buildCount({ name: 'many' }, { where: where! }))),
      );
      return r[0]![0];
    };
    expect(await count([{ column: 'n', op: 'starts with', value: V.text('99') }])).toEqual(
      V.int(String(11 * 100)),
    );
    expect(await count([{ column: 'v', op: 'regexp', value: V.text('^ROW 1000$') }])).toEqual(
      V.int('1'),
    );
    const sql = s.dialect.buildSelect(
      { name: 'kinds' },
      {
        where: [{ column: 'dt', op: 'contains', value: V.text('02-29') }],
      },
    );
    expect(rowsOf(await collect(s.query(sql)))).toHaveLength(1);
  });

  it('round-trips awkward literals through the dialect', async () => {
    const values: Value[] = [
      V.text("it's a \\ backslash ☃"),
      V.bytes(new Uint8Array([0, 1, 254, 255])),
      V.bool(false),
      V.bit(new Uint8Array([5]), 3),
      V.float(-Infinity),
    ];
    const sql = `SELECT ${values.map((v) => s.dialect.quoteLiteral(v)).join(', ')}`;
    const [row] = rowsOf(await collect(s.query(sql)));
    expect(row![0]).toEqual(V.text("it's a \\ backslash ☃"));
    expect(row![1]).toEqual(V.bytes(new Uint8Array([0, 1, 254, 255])));
    expect(row![2]).toEqual(V.bool(false));
    expect(row![3]).toEqual(V.bit(new Uint8Array([5]), 3));
    expect(row![4]).toEqual(V.float(-Infinity));
  });

  it('reports affected rows inside a rolled back transaction', async () => {
    await s.begin();
    const events = await collect(s.query("UPDATE many SET v = v || '!' WHERE n = 7"));
    await s.rollback();
    expect(events.at(-1)).toMatchObject({ kind: 'done', affectedRows: 100 });
  });

  it('runs a script of several statements, dollar quotes included', async () => {
    const events = await collect(
      s.query("SELECT 1 AS a; DO $$ BEGIN PERFORM 1; END $$; SELECT 'x;y' AS b, $q$;$q$ AS c"),
    );
    const dones = events.filter((e) => e.kind === 'done');
    expect(dones.map((d) => [d.resultIndex, d.more])).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
    expect(rowsOf(events)).toEqual([[V.int('1')], [V.text('x;y'), V.text(';')]]);
  });

  it('binds typed parameters', async () => {
    const r = rowsOf(
      await collect(
        s.query('SELECT $1::int + 1, $2::text, $3::bytea, $4::boolean', {
          params: [V.int('41'), V.text('héllo'), V.bytes(new Uint8Array([1, 2])), V.bool(true)],
        }),
      ),
    );
    expect(r[0]).toEqual([
      V.int('42'),
      V.text('héllo'),
      V.bytes(new Uint8Array([1, 2])),
      V.bool(true),
    ]);
  });

  it('streams in batches and stops at maxRows with truncated set', async () => {
    const events = await collect(
      s.query('SELECT * FROM many ORDER BY id', { rowBatchSize: 1000, maxRows: 2500 }),
    );
    const batches = events.filter((e) => e.kind === 'rows');
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(rowsOf(events)).toHaveLength(2500);
    expect(events.at(-1)).toMatchObject({ kind: 'done', rowCount: 2500, truncated: true });
    // The session is still usable afterwards.
    expect((await rowByName(s, 'SELECT 2 AS two'))['two']).toEqual(V.int('2'));
  });

  it('cancels a running statement within two seconds', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const events = await collect(s.query('SELECT pg_sleep(20)', { signal: ac.signal }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(errorOf(events)).toMatchObject({ code: 'CANCELLED' });
    expect((await rowByName(s, 'SELECT 3 AS three'))['three']).toEqual(V.int('3'));
  });

  it('reports syntax errors with sqlState and a position in the whole script', async () => {
    const sql = 'SELECT 1;\nSELEC 2';
    const err = errorOf(await collect(s.query(sql)));
    expect(err).toMatchObject({ code: 'QUERY_FAILED', sqlState: '42601', resultIndex: 1 });
    expect(err!.position).toBe(sql.indexOf('SELEC 2'));
  });

  it('refuses writes in a read-only session', async () => {
    const ro = await postgresDriver.connect({ ...endpoint, readOnly: true });
    try {
      const err = errorOf(await collect(ro.query("UPDATE parents SET name = 'x' WHERE id = 1")));
      expect(err).toMatchObject({ code: 'READ_ONLY_VIOLATION', sqlState: '25006' });
      expect((await ro.info()).readOnly).toBe(true);
    } finally {
      await ro.close();
    }
  });

  it('surfaces notices as warnings on the done event', async () => {
    const events = await collect(s.query('DROP TABLE IF EXISTS no_such_table_here'));
    const done = events.find((e) => e.kind === 'done') as Extract<QueryEvent, { kind: 'done' }>;
    expect(done.warnings[0]?.message).toMatch(/does not exist, skipping/);
  });

  it('explains a statement as text', async () => {
    const plan = await s.explain('SELECT * FROM many WHERE id = 5');
    expect(plan.format).toBe('text');
    expect(plan.text).toMatch(/Index Scan/);
  });

  it('queues calls that arrive together, as the app makes them', async () => {
    const [schemas, objects, info, rows, plan] = await Promise.all([
      s.listSchemas(),
      s.listObjects('public'),
      s.info(),
      collect(s.query('SELECT id FROM many ORDER BY id LIMIT 3')),
      s.explain('SELECT * FROM many WHERE id = 5'),
      s.describeTable('public', 'children'),
    ]);
    expect(schemas.length).toBeGreaterThan(1);
    expect(objects.length).toBeGreaterThan(5);
    expect(info.engine).toBe('postgres');
    expect(rowsOf(rows)).toHaveLength(3);
    expect(plan.text).toMatch(/Index Scan/);
  });

  it('rejects bad credentials with AUTH_FAILED', async () => {
    await expect(postgresDriver.connect({ ...endpoint, password: 'wrong' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
