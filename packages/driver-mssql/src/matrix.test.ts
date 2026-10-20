/**
 * Runs the driver against real SQL Server instances. Enabled by RASQL_TEST_MATRIX=1 (every
 * mssql service in test/matrix/docker-compose.yml whose port answers) or
 * RASQL_MSSQL_DSN=mssql://u:p@h:port/db.
 */
import { connect as netConnect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  V,
  type QueryEvent,
  type ResolvedEndpoint,
  type Session,
  type Value,
} from '@rasql/driver-protocol';
import { formatConformanceReport, runConformanceChecks } from '@rasql/driver-sdk';
import { mssqlDriver } from './index.js';

const MATRIX = [
  { name: 'mssql2019', port: 16019 },
  { name: 'mssql2022', port: 16022 },
  { name: 'mssql2025', port: 16025 },
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
    port: u.port ? Number(u.port) : 1433,
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
} else if (process.env['RASQL_MSSQL_DSN']) {
  targets.push({ name: 'dsn', endpoint: endpointFromDsn(process.env['RASQL_MSSQL_DSN']) });
}
if (process.env['RASQL_TEST_MATRIX'] || process.env['RASQL_MSSQL_DSN']) {
  console.log(
    `[driver-mssql matrix] running against: ${targets.map((t) => t.name).join(', ') || 'nothing'}` +
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
const donesOf = (events: QueryEvent[]) =>
  events.filter((e): e is Extract<QueryEvent, { kind: 'done' }> => e.kind === 'done');

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
  describe.skip('mssql driver engine matrix (set RASQL_TEST_MATRIX=1 with pnpm matrix:up, or RASQL_MSSQL_DSN)', () => {
    it('is skipped', () => undefined);
  });
}

describe.each(targets)('mssql driver against $name', ({ name, endpoint }) => {
  let s: Session;

  beforeAll(async () => {
    s = await mssqlDriver.connect(endpoint);
    // Leftovers of an interrupted run would show up in the object list.
    await collect(s.query('DROP TABLE IF EXISTS dbo.alter_me, dbo.altered_me'));
  }, 30_000);

  afterAll(async () => {
    await s?.close();
  });

  it('passes every conformance check through the protocol', async () => {
    // SQL Server reads '…' in the database code page; Unicode text is written N'…'.
    const report = await runConformanceChecks(mssqlDriver, endpoint, {
      unicodeSelect: "SELECT N'héllo ☃ 🦈'",
    });
    expect(report.failed, formatConformanceReport(report)).toBe(0);
    console.log(
      `[driver-mssql matrix] ${name}: ${report.engine} ${report.version}, ${report.passed} passed, ${report.skipped} skipped`,
    );
  }, 60_000);

  it('reports the engine, version name, user, schema and collation', async () => {
    const info = await s.info();
    expect(info.engine).toBe('mssql');
    expect(info.engineName).toBe(`SQL Server 20${name.slice(-2)}`);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(info.user).toBe('rasql');
    expect(info.currentSchema).toBe('dbo');
    expect(info.collation).toBe('SQL_Latin1_General_CP1_CI_AS');
    expect(info.versionComment).toMatch(/Developer/);
  });

  it('renders every type in kinds row 1 as a typed value', async () => {
    const r = await rowByName(s, 'SELECT * FROM kinds WHERE id = 1');
    expect(r['id']).toEqual(V.int('1'));
    expect(r['tiny']).toEqual(V.int('255'));
    expect(r['small']).toEqual(V.int('-32768'));
    expect(r['normal']).toEqual(V.int('2147483647'));
    expect(r['big']).toEqual(V.int('-9223372036854775807'));
    expect(r['decim']).toEqual(V.decimal('12345678.567891'));
    expect(r['price']).toEqual(V.decimal('1234.5678'));
    expect(r['f']).toEqual(V.float(1.5));
    expect(r['d']).toEqual(V.float(2.25));
    expect(r['flag']).toEqual(V.bool(true));
    expect(r['c']).toEqual(V.text('abc  '));
    expect(r['vc']).toEqual(V.text('plain'));
    expect(r['nvc']).toEqual(V.text('héllo ☃ 🦈'));
    expect(r['nmax']).toEqual(V.text('text ☃'));
    expect(r['b']).toEqual(V.bytes(new Uint8Array([0, 255, 1, 2])));
    expect(r['bmax']).toEqual(V.bytes(new Uint8Array([0, 255])));
    expect(r['dt']).toEqual(V.date('2024-02-29'));
    expect(r['tm']).toEqual(V.time('12:34:56.1234567'));
    expect(r['dtt']).toEqual(V.datetime('2024-02-29 13:14:15.997'));
    expect(r['dt2']).toEqual(V.datetime('2024-02-29 13:14:15.1234567'));
    expect(r['dt3']).toEqual(V.datetime('2024-02-29 13:14:15.123'));
    expect(r['sdt']).toEqual(V.datetime('2024-02-29 13:14:00'));
    expect(r['dto']).toEqual(V.datetime('2024-02-29 11:14:15.1234567 +00:00'));
    expect(r['u']).toEqual(V.text('6F9619FF-8B86-D011-B42D-00C04FC964FF'));
    expect(r['x']).toEqual(V.text('<a b="1">x</a>'));
    expect(r['rv']!.t).toBe('bytes');
  });

  it('renders NULLs', async () => {
    const r = await rowByName(s, 'SELECT * FROM kinds WHERE id = 2');
    for (const key of ['tiny', 'decim', 'nvc', 'b', 'dt', 'dt2', 'dto', 'u', 'x'])
      expect(r[key]).toEqual(V.null());
  });

  it('names result column types the way SQL Server does', async () => {
    const cols = columnsOf(
      await collect(
        s.query('SELECT id, tiny, decim, price, nvc, nmax, vc, b, dt2, dto, flag FROM kinds'),
      ),
    );
    expect(cols.map((c) => [c.name, c.nativeType, c.valueType])).toEqual([
      ['id', 'bigint', 'int'],
      ['tiny', 'tinyint', 'int'],
      ['decim', 'decimal(20,6)', 'decimal'],
      ['price', 'money', 'decimal'],
      ['nvc', 'nvarchar(100)', 'text'],
      ['nmax', 'nvarchar(max)', 'text'],
      ['vc', 'varchar(100)', 'text'],
      ['b', 'varbinary(16)', 'bytes'],
      ['dt2', 'datetime2(7)', 'datetime'],
      ['dto', 'datetimeoffset(7)', 'datetime'],
      ['flag', 'bit', 'bool'],
    ]);
    expect(cols[0]!.nullable).toBe(false);
    expect(cols[1]!.nullable).toBe(true);
  });

  it('describes children: pk, identity, fk, defaults, computed column, indexes, comments, ddl', async () => {
    const def = await s.describeTable('dbo', 'children');
    expect(def.kind).toBe('table');
    expect(def.primaryKey).toEqual(['id']);
    const col = (n: string) => def.columns.find((c) => c.name === n)!;
    expect(col('id')).toMatchObject({ autoIncrement: true, nullable: false, nativeType: 'int' });
    expect(col('label')).toMatchObject({
      nativeType: 'nvarchar(50)',
      default: V.text('none'),
      comment: 'Shown in lists',
    });
    expect(col('position').default).toEqual(V.int('0'));
    expect(col('score')).toMatchObject({ nativeType: 'decimal(5,2)', default: V.decimal('-1.5') });
    expect(col('full_label').generated).toMatchObject({ stored: false });
    expect(col('full_label').generated!.expression).toMatch(/\[label\]\+N' #'/);
    expect(def.foreignKeys).toEqual([
      {
        name: 'fk_children_parent',
        columns: ['parent_id'],
        referencedSchema: 'dbo',
        referencedTable: 'parents',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ]);
    const byName = Object.fromEntries(def.indexes.map((i) => [i.name, i]));
    expect(byName['PK_children']).toMatchObject({
      primary: true,
      constraint: true,
      type: 'CLUSTERED',
    });
    expect(byName['uq_parent_position']).toMatchObject({ unique: true, constraint: true });
    expect(byName['idx_parent_label']!.columns).toEqual([
      { name: 'parent_id', order: 'asc' },
      { name: 'label', order: 'desc' },
    ]);
    expect(byName['idx_positive']).toMatchObject({ where: '[position]>(0)' });
    expect(byName['idx_positive']!.constraint).toBeUndefined();
    expect(def.comment).toBe('Has a foreign key to parents');
    expect(def.ddl).toMatch(/^CREATE TABLE \[dbo\]\.\[children\] \(/);
    expect(def.ddl).toMatch(
      /\[label\] nvarchar\(50\) NOT NULL CONSTRAINT \[DF_children_label\] DEFAULT N'none'/,
    );
    expect(def.ddl).toMatch(
      /CREATE INDEX \[idx_positive\] ON \[dbo\]\.\[children\] \(\[label\]\) WHERE \[position\]>\(0\)/,
    );
    const parents = await s.describeTable('dbo', 'parents');
    expect(parents.columns.find((c) => c.name === 'created_at')).toMatchObject({
      nativeType: 'datetime2(0)',
      default: { t: 'expression', sql: 'sysutcdatetime()' },
    });
  });

  it('describes a view', async () => {
    const v = await s.describeTable('dbo', 'children_view');
    expect(v.kind).toBe('view');
    expect(v.columns.map((c) => c.name)).toEqual(['id', 'label', 'parent']);
    expect(v.ddl).toMatch(/^CREATE VIEW children_view AS/m);
  });

  it('lists schemas and every object kind', async () => {
    const schemas = await s.listSchemas();
    expect(schemas.find((x) => x.name === 'dbo')).toMatchObject({
      isCurrent: true,
      isSystem: false,
    });
    expect(schemas.find((x) => x.name === 'sys')).toMatchObject({ isSystem: true });
    expect(schemas.map((x) => x.name)).toContain('sales');
    expect(schemas.map((x) => x.name)).not.toContain('db_owner');
    const objects = await s.listObjects('dbo');
    const names = (kind: string) =>
      objects
        .filter((o) => o.kind === kind)
        .map((o) => o.name)
        .sort();
    expect(names('table')).toEqual(['children', 'kinds', 'many', 'parents', 'wp_options']);
    expect(names('view')).toEqual(['children_view']);
    expect(names('routine')).toEqual(['child_count', 'children_of', 'fill_many']);
    expect(names('sequence')).toEqual(['invoice_numbers']);
    expect(objects.find((o) => o.name === 'trg_children_ai')).toMatchObject({
      kind: 'trigger',
      extra: { table: 'children', timing: 'AFTER', event: 'INSERT' },
    });
    expect(objects.find((o) => o.name === 'many')!.rowEstimate).toBe(100000);
    expect(objects.find((o) => o.name === 'children')!.comment).toBe(
      'Has a foreign key to parents',
    );
  });

  it('describes routines, triggers and sequences', async () => {
    const fn = await s.describeObject!('dbo', 'routine', 'child_count');
    // OBJECT_DEFINITION keeps the comments written above CREATE in the same batch.
    expect(fn.ddl).toMatch(/\nCREATE FUNCTION dbo\.child_count/);
    expect(fn.properties).toEqual(
      expect.arrayContaining([
        { label: 'Type', value: 'scalar function' },
        { label: 'Parameters', value: '@pid int' },
        { label: 'Returns', value: 'int' },
      ]),
    );
    const proc = await s.describeObject!('dbo', 'routine', 'fill_many');
    expect(proc.properties).toContainEqual({ label: 'Type', value: 'procedure' });
    const trg = await s.describeObject!('dbo', 'trigger', 'trg_children_ai');
    expect(trg.ddl).toMatch(/^CREATE TRIGGER trg_children_ai ON children AFTER INSERT/m);
    expect(trg.properties).toContainEqual({
      label: 'Fires',
      value: 'AFTER INSERT, for each statement',
    });
    const seq = await s.describeObject!('dbo', 'sequence', 'invoice_numbers');
    expect(seq.ddl).toMatch(/START WITH 1000 INCREMENT BY 10/);
  });

  it('applies a structure change built by the dialect, in a transaction', async () => {
    const run = async (sql: string): Promise<void> => {
      const err = errorOf(await collect(s.query(sql)));
      if (err) throw new Error(`${err.message}\n${sql}`);
    };
    await run("IF OBJECT_ID(N'dbo.altered_me') IS NOT NULL DROP TABLE dbo.altered_me");
    await run("IF OBJECT_ID(N'dbo.alter_me') IS NOT NULL DROP TABLE dbo.alter_me");
    await run(
      "CREATE TABLE alter_me (id int NOT NULL CONSTRAINT PK_alter_me PRIMARY KEY, name nvarchar(20) NOT NULL DEFAULT N'x', old nvarchar(10) DEFAULT N'gone', n int)",
    );
    const before = await s.describeTable('dbo', 'alter_me');
    const col = (n: string) => before.columns.find((c) => c.name === n)!;
    const statements = s.dialect.buildAlter!(before, [
      { kind: 'dropColumn', name: 'old' },
      {
        kind: 'modifyColumn',
        name: 'name',
        column: {
          ...col('name'),
          name: 'title',
          nativeType: 'NVARCHAR(80)',
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
          name: 'added',
          ordinal: 5,
          nativeType: 'DATETIME2(3)',
          valueType: 'datetime',
          nullable: true,
          autoIncrement: false,
          default: { t: 'expression', sql: 'sysutcdatetime()' },
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
    const after = await s.describeTable('dbo', 'altered_me');
    expect(after.columns.map((c) => c.name)).toEqual(['id', 'title', 'n', 'added']);
    expect(after.columns[1]).toMatchObject({
      nativeType: 'nvarchar(80)',
      nullable: true,
      default: V.text("it's"),
    });
    expect(after.columns[2]).toMatchObject({ nativeType: 'bigint', comment: 'count' });
    expect(after.columns[3]).toMatchObject({
      nativeType: 'datetime2(3)',
      default: { t: 'expression', sql: 'sysutcdatetime()' },
    });
    expect(after.indexes.find((i) => i.name === 'ix_title')).toMatchObject({ unique: true });
    expect(after.comment).toBe('altered');
    // The table comment can be changed and removed again.
    for (const sql of s.dialect.buildAlter!(after, [{ kind: 'setComment', comment: '' }]))
      await run(sql);
    expect((await s.describeTable('dbo', 'altered_me')).comment).toBeUndefined();
    const pk = s.dialect.buildAlter!(after, [
      { kind: 'dropIndex', name: 'PK_alter_me' },
      {
        kind: 'addIndex',
        index: {
          name: 'PRIMARY',
          unique: true,
          primary: true,
          columns: [{ name: 'id' }, { name: 'n' }],
        },
      },
    ]);
    await run('UPDATE altered_me SET n = 0 WHERE n IS NULL');
    await run('ALTER TABLE altered_me ALTER COLUMN n bigint NOT NULL');
    for (const sql of pk) await run(sql);
    expect((await s.describeTable('dbo', 'altered_me')).primaryKey).toEqual(['id', 'n']);
    await run('DROP TABLE altered_me');
  }, 30_000);

  it('pages with TOP and OFFSET … FETCH, and escapes [ in LIKE', async () => {
    const page = (offset: number) =>
      collect(
        s.query(s.dialect.buildSelect({ schema: 'dbo', name: 'many' }, { limit: 3, offset })),
      );
    expect(rowsOf(await page(0)).map((r) => r[0])).toEqual([V.int('1'), V.int('2'), V.int('3')]);
    const sorted = s.dialect.buildSelect(
      { name: 'many' },
      {
        orderBy: [{ column: 'id', direction: 'desc' }],
        limit: 2,
        offset: 1,
      },
    );
    expect(rowsOf(await collect(s.query(sorted))).map((r) => r[0])).toEqual([
      V.int('99999'),
      V.int('99998'),
    ]);
    const like = s.dialect.buildCount(
      { name: 'wp_options' },
      {
        where: [{ column: 'option_value', op: 'contains', value: V.text('[') }],
      },
    );
    expect(rowsOf(await collect(s.query(like)))[0]).toEqual([V.int('0')]);
    const plugins = s.dialect.buildSelect(
      { name: 'wp_options' },
      {
        where: [{ column: 'option_name', op: 'contains', value: V.text('PLUGIN') }],
      },
    );
    expect(rowsOf(await collect(s.query(plugins)))[0]![2]).toEqual(
      V.text('a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:9:"hello.php";}'),
    );
  });

  it('round-trips awkward literals through the dialect', async () => {
    const values: Value[] = [
      V.text("it's ☃ 🦈"),
      V.bytes(new Uint8Array([0, 1, 254, 255])),
      V.bool(true),
      V.text('a\0b'),
    ];
    const sql = `SELECT ${values.map((v) => s.dialect.quoteLiteral(v)).join(', ')}`;
    const [row] = rowsOf(await collect(s.query(sql)));
    expect(row![0]).toEqual(V.text("it's ☃ 🦈"));
    expect(row![1]).toEqual(V.bytes(new Uint8Array([0, 1, 254, 255])));
    expect(row![2]).toEqual(V.int('1'));
    expect(row![3]).toEqual(V.text('a\0b'));
  });

  it('reports affected rows inside a rolled back transaction', async () => {
    await s.begin();
    const events = await collect(s.query("UPDATE many SET v = v + N'!' WHERE n = 7"));
    await s.rollback();
    expect(donesOf(events)).toEqual([expect.objectContaining({ affectedRows: 100, more: false })]);
  });

  it('streams several result sets, across GO batches, with resultIndex and more flags', async () => {
    const events = await collect(
      s.query(
        "SELECT 1 AS a; SET NOCOUNT ON; SELECT N'x;y' AS b\nGO\nPRINT 'hello'\nGO 2\nSELECT 3 AS c",
      ),
    );
    expect(errorOf(events)).toBeUndefined();
    const dones = donesOf(events);
    expect(dones.at(-1)!.more).toBe(false);
    expect(dones.slice(0, -1).every((d) => d.more)).toBe(true);
    expect(rowsOf(events)).toEqual([[V.int('1')], [V.text('x;y')], [V.int('3')]]);
    const printed = dones.flatMap((d) => d.warnings).filter((w) => w.message === 'hello');
    expect(printed).toHaveLength(2);
  });

  it('binds typed parameters as @p1, @p2, …', async () => {
    const r = rowsOf(
      await collect(
        s.query('SELECT @p1 + 1, @p2, @p3, @p4', {
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
    expect(events.filter((e) => e.kind === 'rows').length).toBeGreaterThanOrEqual(3);
    expect(rowsOf(events)).toHaveLength(2500);
    expect(events.at(-1)).toMatchObject({ kind: 'done', rowCount: 2500, truncated: true });
    expect((await rowByName(s, 'SELECT 2 AS two'))['two']).toEqual(V.int('2'));
  });

  it('cancels a running statement within two seconds', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const events = await collect(s.query("WAITFOR DELAY '00:00:20'", { signal: ac.signal }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(errorOf(events)).toMatchObject({ code: 'CANCELLED' });
    expect((await rowByName(s, 'SELECT 3 AS three'))['three']).toEqual(V.int('3'));
  });

  it('reports errors with the line they are on, as a position in the whole script', async () => {
    const sql = 'SELECT 1\nGO\nSELECT 2\nSELECT * FROM no_such_table';
    const err = errorOf(await collect(s.query(sql)));
    expect(err).toMatchObject({ code: 'QUERY_FAILED' });
    expect(err!.message).toMatch(/Invalid object name 'no_such_table'/);
    expect(err!.position).toBe(sql.indexOf('SELECT * FROM'));
  });

  it('refuses writes in a read-only connection, before they reach the server', async () => {
    const ro = await mssqlDriver.connect({ ...endpoint, readOnly: true });
    try {
      for (const sql of [
        "UPDATE parents SET name = N'x' WHERE id = 1",
        'SELECT 1; DELETE FROM parents',
        'SELECT * INTO copy_of_parents FROM parents',
        'EXEC fill_many 1',
        'fill_many 1',
      ])
        expect(errorOf(await collect(ro.query(sql))), sql).toMatchObject({
          code: 'READ_ONLY_VIOLATION',
        });
      // Write keywords inside strings, comments and [names] do not count.
      const words = await collect(ro.query("SELECT N'update' AS [delete] -- insert"));
      expect(errorOf(words)).toBeUndefined();
      expect(rowsOf(await collect(ro.query('SELECT COUNT(*) FROM parents')))[0]).toEqual([
        V.int('2'),
      ]);
      expect((await ro.info()).readOnly).toBe(true);
    } finally {
      await ro.close();
    }
  });

  it('explains a statement as text', async () => {
    const plan = await s.explain('SELECT * FROM many WHERE id = 5');
    expect(plan.format).toBe('text');
    expect(plan.text).toMatch(/Clustered Index Seek/);
    // SHOWPLAN is off again afterwards.
    expect((await rowByName(s, 'SELECT 4 AS four'))['four']).toEqual(V.int('4'));
  });

  it('queues calls that arrive together, as the app makes them', async () => {
    const [schemas, objects, info, rows, plan] = await Promise.all([
      s.listSchemas(),
      s.listObjects('dbo'),
      s.info(),
      collect(s.query('SELECT TOP (3) id FROM many ORDER BY id')),
      s.explain('SELECT * FROM many WHERE id = 5'),
      s.describeTable('dbo', 'children'),
    ]);
    expect(schemas.length).toBeGreaterThan(1);
    expect(objects.length).toBeGreaterThan(5);
    expect(info.engine).toBe('mssql');
    expect(rowsOf(rows)).toHaveLength(3);
    expect(plan.text).toMatch(/Seek/);
  });

  it('rejects bad credentials with AUTH_FAILED', async () => {
    await expect(mssqlDriver.connect({ ...endpoint, password: 'wrong' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
