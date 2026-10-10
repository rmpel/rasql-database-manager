/**
 * Runs the driver against real engines. Enabled by RASQL_TEST_MATRIX=1 (every service in
 * test/matrix/docker-compose.yml whose port answers) or RASQL_MYSQL_DSN=mysql://u:p@h:port/db.
 */
import { connect as netConnect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V, type QueryEvent, type ResolvedEndpoint, type Value } from '@rasql/driver-protocol';
import {
  formatConformanceReport,
  runConformanceChecks,
  type RemoteSession,
} from '@rasql/driver-sdk';
import { mysqlDriver } from './index.js';
import type { Session } from '@rasql/driver-protocol';

interface Target {
  name: string;
  endpoint: ResolvedEndpoint;
}

const MATRIX: Array<{ name: string; port: number }> = [
  { name: 'mysql57', port: 33057 },
  { name: 'mysql80', port: 33080 },
  { name: 'mysql84', port: 33084 },
  { name: 'mariadb106', port: 33106 },
  { name: 'mariadb1011', port: 33111 },
  { name: 'mariadb114', port: 33114 },
  { name: 'percona80', port: 33880 },
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
    transport: u.searchParams.get('socket') ? 'socket' : 'tcp',
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 3306,
    options: {},
  };
  const socket = u.searchParams.get('socket');
  if (socket) ep.socketPath = socket;
  if (u.username) ep.user = decodeURIComponent(u.username);
  if (u.password) ep.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) ep.database = db;
  return ep;
}

const targets: Target[] = [];
const skipped: string[] = [];
if (process.env['RASQL_TEST_MATRIX']) {
  for (const m of MATRIX) {
    if (await reachable(m.port)) {
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
    } else {
      skipped.push(m.name);
    }
  }
} else if (process.env['RASQL_MYSQL_DSN']) {
  targets.push({ name: 'dsn', endpoint: endpointFromDsn(process.env['RASQL_MYSQL_DSN']) });
}

if (process.env['RASQL_TEST_MATRIX'] || process.env['RASQL_MYSQL_DSN']) {
  console.log(
    `[driver-mysql matrix] running against: ${targets.map((t) => t.name).join(', ') || 'nothing'}` +
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

async function rowByName(s: Session | RemoteSession, sql: string): Promise<Record<string, Value>> {
  const events = await collect(s.query(sql));
  const err = events.find((e) => e.kind === 'error');
  if (err) throw new Error(`query failed: ${JSON.stringify(err)}`);
  const cols = columnsOf(events);
  const row = rowsOf(events)[0];
  if (!row) throw new Error(`no row for ${sql}`);
  return Object.fromEntries(cols.map((c, i) => [c.name, row[i]!]));
}

if (targets.length === 0) {
  describe.skip('mysql driver engine matrix (set RASQL_TEST_MATRIX=1 with pnpm matrix:up, or RASQL_MYSQL_DSN)', () => {
    it('is skipped', () => undefined);
  });
}

describe.each(targets)('mysql driver against $name', ({ name, endpoint }) => {
  let s: Session;
  let engine = '';

  beforeAll(async () => {
    s = await mysqlDriver.connect(endpoint);
    engine = (await s.info()).engine;
  }, 30_000);

  afterAll(async () => {
    await s?.close();
  });

  it('passes every conformance check through the protocol', async () => {
    const report = await runConformanceChecks(mysqlDriver, endpoint);
    expect(report.failed, formatConformanceReport(report)).toBe(0);
    console.log(
      `[driver-mysql matrix] ${name}: ${report.engine} ${report.version}, ${report.passed} passed, ${report.skipped} skipped`,
    );
  }, 60_000);

  it('reports an engine from the manifest and a clean version', async () => {
    const info = await s.info();
    expect(mysqlDriver.manifest().engines.map((e) => e.id)).toContain(info.engine);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (name.startsWith('mysql')) expect(info.engine).toBe('mysql');
    if (name.startsWith('mariadb')) expect(info.engine).toBe('mariadb');
    if (name.startsWith('percona')) expect(info.engine).toBe('percona');
    expect(info.currentSchema).toBe('rasql');
    expect(info.user).toMatch(/^rasql@/);
  });

  it('renders every awkward value in kinds row 1 as a typed value', async () => {
    const r = await rowByName(s, 'SELECT * FROM kinds WHERE id = 1');
    expect(r['ubig']).toEqual(V.int('18446744073709551615'));
    expect(r['big']).toEqual(V.int('-9223372036854775807'));
    expect(r['tiny']).toEqual(V.int('-128'));
    expect(r['flag']).toEqual(V.int('1'));
    expect(r['decim']).toEqual(V.decimal('12345678901234.567891'));
    expect(r['f']).toEqual(V.float(1.5));
    expect(r['d']).toEqual(V.float(2.25));
    expect(r['bits']).toEqual(V.bit(new Uint8Array([0x55]), 7));
    expect(r['c']).toEqual(V.text('abc', 'utf8mb4'));
    expect(r['vc']).toEqual(V.text('héllo ☃ 🦈', 'utf8mb4'));
    expect(r['latin']).toEqual(V.text('Ã©Ã¨', 'latin1'));
    expect(r['bin']).toEqual(V.bytes(new Uint8Array([0, 255, 1, 2])));
    expect(r['vbin']).toEqual(V.bytes(new Uint8Array([0xff, 0xfe, 0x41])));
    expect(r['b']).toEqual(V.bytes(new Uint8Array([0, 255])));
    expect(r['lb']).toEqual(V.bytes(new Uint8Array([0, 255])));
    expect(r['tt']).toEqual(V.text('tiny text', 'utf8mb4'));
    expect(r['t']).toEqual(V.text('text ☃', 'utf8mb4'));
    expect(r['en']).toEqual(V.enum('two'));
    expect(r['st']).toEqual(V.set(['a', 'c']));
    expect(r['dt']).toEqual(V.date('2024-02-29'));
    expect(r['tm']).toEqual(V.time('12:34:56'));
    expect(r['tm6']).toEqual(V.time('12:34:56.123456'));
    expect(r['dtt']).toEqual(V.datetime('2024-02-29 13:14:15'));
    expect(r['dtt6']).toEqual(V.datetime('2024-02-29 13:14:15.123456'));
    expect(r['ts6']).toEqual(V.datetime('2024-02-29 13:14:15.654321'));
    expect(r['yr']).toEqual(V.int('2024'));
    expect(r['note']).toEqual(V.text('x', 'utf8mb4'));

    const js = r['js']!;
    expect(['json', 'text']).toContain(js.t);
    if (engine === 'mysql' || engine === 'percona') expect(js.t).toBe('json');
    expect(JSON.parse((js as { v: string }).v)).toEqual({ a: 1, b: [1, 2, 3], s: 'héllo' });

    const pt = r['pt']!;
    expect(pt.t).toBe('geometry');
    if (pt.t === 'geometry') {
      expect(pt.srid).toBe(0);
      expect(Array.from(pt.v.subarray(0, 5))).toEqual([1, 1, 0, 0, 0]); // little-endian WKB point
    }
  });

  it('renders NULLs, zero dates, negative and long TIME values', async () => {
    const nulls = await rowByName(s, 'SELECT * FROM kinds WHERE id = 2');
    for (const key of ['small', 'decim', 'vc', 'b', 'js', 'dt', 'pt'])
      expect(nulls[key]).toEqual(V.null());

    const odd = await rowByName(s, 'SELECT * FROM kinds WHERE id = 3');
    expect(odd['dt']).toEqual(V.date('0000-00-00'));
    expect(odd['dtt']).toEqual(V.datetime('0000-00-00 00:00:00'));
    expect(odd['dtt6']).toEqual(V.datetime('0000-00-00 00:00:00.000000'));
    expect(odd['tm']).toEqual(V.time('-838:59:59'));
    expect(odd['tm6']).toEqual(V.time('100:00:00.500000'));
    expect(odd['st']).toEqual(V.set([]));
    expect(odd['yr']!.t).toBe('int');
  });

  it('describes result columns with charset, key and nullability', async () => {
    const cols = columnsOf(await collect(s.query('SELECT id, latin, vc, b FROM kinds LIMIT 1')));
    expect(cols[0]).toMatchObject({
      name: 'id',
      valueType: 'int',
      isPrimaryKey: true,
      nullable: false,
      table: 'kinds',
      schema: 'rasql',
    });
    expect(cols[0]!.nativeType).toBe('BIGINT UNSIGNED');
    expect(cols[1]).toMatchObject({ name: 'latin', valueType: 'text', charset: 'latin1' });
    expect(cols[2]).toMatchObject({ name: 'vc', charset: 'utf8mb4' });
    expect(cols[3]).toMatchObject({ name: 'b', valueType: 'bytes', nativeType: 'BLOB' });
    expect(cols[3]!.charset).toBeUndefined();
  });

  it('describes children: pk, auto increment, fk, composite prefix index, generated column, ddl', async () => {
    const def = await s.describeTable('rasql', 'children');
    expect(def.kind).toBe('table');
    expect(def.primaryKey).toEqual(['id']);
    expect(def.columns.find((c) => c.name === 'id')).toMatchObject({
      autoIncrement: true,
      nullable: false,
      valueType: 'int',
    });
    expect(def.columns.find((c) => c.name === 'position')).toMatchObject({ default: V.int('0') });
    const gen = def.columns.find((c) => c.name === 'full_label')!;
    expect(gen.generated?.stored).toBe(false);
    expect(gen.generated?.expression.toLowerCase()).toContain('concat');
    expect(def.foreignKeys).toEqual([
      {
        name: 'fk_children_parent',
        columns: ['parent_id'],
        referencedSchema: 'rasql',
        referencedTable: 'parents',
        referencedColumns: ['id'],
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE',
      },
    ]);
    const byName = Object.fromEntries(def.indexes.map((i) => [i.name, i]));
    expect(byName['PRIMARY']).toMatchObject({
      primary: true,
      unique: true,
      columns: [{ name: 'id' }],
    });
    expect(byName['uq_parent_position']).toMatchObject({ unique: true, primary: false });
    expect(byName['idx_parent_label']!.columns).toEqual([
      { name: 'parent_id', order: 'asc' },
      { name: 'label', order: 'asc', length: 5 },
    ]);
    expect(def.options['engine']).toBe('InnoDB');
    expect(def.comment).toBe('Has a foreign key to parents');
    expect(def.ddl).toMatch(/CREATE TABLE `children`/);
  });

  it('describes kinds column types and defaults', async () => {
    const def = await s.describeTable('rasql', 'kinds');
    const types = Object.fromEntries(def.columns.map((c) => [c.name, c.valueType]));
    expect(types).toMatchObject({
      ubig: 'int',
      decim: 'decimal',
      f: 'float',
      bits: 'bit',
      vc: 'text',
      b: 'bytes',
      vbin: 'bytes',
      en: 'enum',
      st: 'set',
      dt: 'date',
      tm: 'time',
      ts6: 'datetime',
      geo: 'geometry',
      pt: 'geometry',
    });
    expect(['json', 'text']).toContain(types['js']);
    expect(def.columns.find((c) => c.name === 'note')).toMatchObject({
      default: V.text('dflt'),
      comment: 'a column comment',
    });
    expect(def.columns.find((c) => c.name === 'latin')).toMatchObject({ charset: 'latin1' });
    // MySQL 8+ and Percona 8 dropped the display width; 5.7 and MariaDB still print it.
    expect(['bigint unsigned', 'bigint(20) unsigned']).toContain(
      def.columns.find((c) => c.name === 'ubig')!.nativeType.toLowerCase(),
    );
    expect(def.comment).toBe('Every column type RaSQL must render');
    expect(def.indexes.find((i) => i.name === 'idx_small_vc')!.columns[1]).toMatchObject({
      name: 'vc',
      length: 10,
    });
  });

  it('describes a view', async () => {
    const def = await s.describeTable('rasql', 'children_view');
    expect(def.kind).toBe('view');
    expect(def.columns.map((c) => c.name)).toEqual(['id', 'label', 'position', 'parent_name']);
    expect(def.ddl).toMatch(/CREATE .*VIEW/i);
  });

  it('lists schemas and every object kind', async () => {
    const schemas = await s.listSchemas();
    expect(schemas.find((x) => x.name === 'rasql')).toMatchObject({
      isCurrent: true,
      isSystem: false,
    });
    expect(schemas.find((x) => x.name === 'information_schema')).toMatchObject({ isSystem: true });

    const objects = await s.listObjects('rasql');
    const find = (kind: string, name: string) =>
      objects.find((o) => o.kind === kind && o.name === name);
    expect(find('table', 'kinds')).toMatchObject({
      engine: 'InnoDB',
      comment: 'Every column type RaSQL must render',
    });
    expect(find('table', 'many')?.rowEstimate).toBeGreaterThan(1000);
    expect(find('view', 'children_view')).toBeTruthy();
    expect(find('routine', 'fill_many')).toMatchObject({ extra: { type: 'procedure' } });
    expect(find('routine', 'child_count')).toMatchObject({ extra: { type: 'function' } });
    expect(find('trigger', 'trg_children_bi')).toMatchObject({
      extra: { table: 'children', timing: 'BEFORE', event: 'INSERT' },
    });
    expect(find('event', 'ev_touch_parents')).toBeTruthy();
  });

  it('describes routines, triggers and events', async () => {
    const describeObject = (kind: 'routine' | 'trigger' | 'event', name: string) => {
      if (!s.describeObject) throw new Error('describeObject is missing');
      return s.describeObject('rasql', kind, name);
    };
    const proc = await describeObject('routine', 'fill_many');
    expect(proc.properties).toContainEqual({ label: 'Type', value: 'procedure' });
    expect(proc.properties.find((p) => p.label === 'Parameters')?.value).toMatch(
      /^IN cnt int(\(11\))?$/i,
    );
    const fn = await describeObject('routine', 'child_count');
    expect(fn.properties.find((p) => p.label === 'Returns')?.value).toMatch(/^int/i);
    expect(fn.properties).toContainEqual({ label: 'Deterministic', value: 'yes' });
    const trg = await describeObject('trigger', 'trg_children_bi');
    expect(trg.properties).toContainEqual({ label: 'Table', value: 'children' });
    expect(trg.properties).toContainEqual({
      label: 'Fires',
      value: 'BEFORE INSERT, for each row',
    });
    expect(trg.ddl).toMatch(/TRIM\(NEW\.label\)/);
    const ev = await describeObject('event', 'ev_touch_parents');
    expect(ev.properties).toContainEqual({ label: 'Schedule', value: 'every 1 day' });
    expect(ev.ddl).toMatch(/UPDATE parents/);
    // Routine bodies need privileges the test user may lack; when shown, they are the real thing.
    if (proc.ddl) expect(proc.ddl).toMatch(/WHILE i < cnt DO/);
    await expect(describeObject('routine', 'nope')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    });
  });

  it('applies a structure change built by the dialect', async () => {
    const run = async (sql: string): Promise<void> => {
      for await (const e of s.query(sql)) if (e.kind === 'error') throw new Error(e.message);
    };
    await run('DROP TABLE IF EXISTS alter_probe');
    await run(
      "CREATE TABLE alter_probe (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, title VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, n INT) COMMENT 'probe'",
    );
    try {
      const before = await s.describeTable('rasql', 'alter_probe');
      const title = before.columns.find((c) => c.name === 'title')!;
      const n = before.columns.find((c) => c.name === 'n')!;
      const statements = (await s.dialect.buildAlter!(before, [
        {
          kind: 'modifyColumn',
          name: 'n',
          column: {
            ...n,
            name: 'amount',
            nativeType: 'bigint unsigned',
            nullable: false,
            default: V.int('0'),
          },
          after: 'id',
        },
        { kind: 'modifyColumn', name: 'title', column: { ...title, nativeType: 'varchar(120)' } },
        {
          kind: 'addColumn',
          column: {
            name: 'status',
            ordinal: 0,
            nativeType: "enum('draft','publish')",
            valueType: 'enum',
            nullable: false,
            autoIncrement: false,
            default: V.enum('draft'),
            comment: 'workflow',
          },
        },
        {
          kind: 'addIndex',
          index: {
            name: 'by_status',
            unique: false,
            primary: false,
            columns: [{ name: 'status' }],
          },
        },
        { kind: 'setComment', comment: 'changed' },
      ])) as string[];
      expect(statements).toHaveLength(1);
      for (const sql of statements) await run(sql);
      const after = await s.describeTable('rasql', 'alter_probe');
      expect(after.columns.map((c) => c.name)).toEqual(['id', 'amount', 'title', 'status']);
      const amount = after.columns.find((c) => c.name === 'amount')!;
      expect(amount.nativeType).toMatch(/^bigint(\(20\))? unsigned$/);
      expect(amount.nullable).toBe(false);
      expect(amount.default).toEqual(V.int('0'));
      // The column kept its own collation instead of falling back to the table's.
      expect(after.columns.find((c) => c.name === 'title')).toMatchObject({
        nativeType: 'varchar(120)',
        collation: 'utf8mb4_bin',
      });
      expect(after.columns.find((c) => c.name === 'status')).toMatchObject({
        default: V.enum('draft'),
        comment: 'workflow',
      });
      expect(after.indexes.map((i) => i.name)).toContain('by_status');
      expect(after.comment).toBe('changed');
    } finally {
      await run('DROP TABLE IF EXISTS alter_probe');
    }
  });

  it('reads serialized WordPress data through a dialect-built select', async () => {
    const sql = s.dialect.buildSelect(
      { schema: 'rasql', name: 'wp_options' },
      {
        columns: ['option_value'],
        where: [{ column: 'option_name', op: '=', value: V.text('widget_text') }],
      },
    );
    const r = await rowByName(s, sql);
    expect(r['option_value']!.t).toBe('text');
    expect((r['option_value'] as { v: string }).v).toContain('s:5:"héllo"');
  });

  it('reports affected rows and insert id, inside a rolled back transaction', async () => {
    await s.begin();
    try {
      const events = await collect(s.query("INSERT INTO parents (name) VALUES ('tmp')"));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'done', affectedRows: 1, more: false });
      expect((events[0] as Extract<QueryEvent, { kind: 'done' }>).insertId).toMatch(/^\d+$/);
    } finally {
      await s.rollback();
    }
  });

  it('streams several result sets with resultIndex and more flags', async () => {
    const events = await collect(s.query('SELECT 1 AS a; SELECT 2 AS b, 3 AS c'));
    expect(events.map((e) => `${e.kind}:${e.resultIndex}`)).toEqual([
      'columns:0',
      'rows:0',
      'done:0',
      'columns:1',
      'rows:1',
      'done:1',
    ]);
    expect(events[2]).toMatchObject({ kind: 'done', more: true });
    expect(events[5]).toMatchObject({ kind: 'done', more: false });
    expect(rowsOf(events)).toEqual([[V.int('1')], [V.int('2'), V.int('3')]]);
  });

  it('binds typed parameters', async () => {
    const events = await collect(
      s.query('SELECT ? AS a, ? AS b, ? AS c, ? AS d', {
        params: [
          V.int('18446744073709551615'),
          V.text('héllo'),
          V.bytes(new Uint8Array([0, 255])),
          V.null(),
        ],
      }),
    );
    const row = rowsOf(events)[0]!;
    expect(row[0]).toEqual(V.int('18446744073709551615'));
    expect(row[1]).toEqual(V.text('héllo', 'utf8mb4'));
    expect(row[2]).toEqual(V.bytes(new Uint8Array([0, 255])));
    expect(row[3]).toEqual(V.null());
  });

  it('streams in batches and stops at maxRows with truncated set', async () => {
    const events = await collect(
      s.query('SELECT * FROM many', { maxRows: 500, rowBatchSize: 100 }),
    );
    expect(rowsOf(events)).toHaveLength(500);
    expect(events[events.length - 1]).toMatchObject({
      kind: 'done',
      truncated: true,
      rowCount: 500,
    });
    const after = await collect(s.query('SELECT 1'));
    expect(after[after.length - 1]?.kind).toBe('done');
  }, 20_000);

  it('cancels a running statement within two seconds', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 200);
    const events = await collect(s.query('SELECT SLEEP(5)', { signal: ac.signal }));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(events[events.length - 1]).toMatchObject({ kind: 'error', code: 'CANCELLED' });
    const after = await collect(s.query('SELECT 1'));
    expect(after[after.length - 1]?.kind).toBe('done');
  }, 10_000);

  it('reports syntax errors with sqlState and a position', async () => {
    const events = await collect(s.query('SELECT 1 FROM kinds WHERE SELEC 1'));
    const err = events[events.length - 1] as Extract<QueryEvent, { kind: 'error' }>;
    expect(err.kind).toBe('error');
    expect(err.sqlState).toBe('42000');
    // The server quotes the rest of the statement from where it gave up; that is inside the broken clause.
    expect(err.position).toBeGreaterThanOrEqual('SELECT 1 FROM kinds WHERE '.length);
    expect(err.position).toBeLessThan('SELECT 1 FROM kinds WHERE SELEC 1'.length);
  });

  it('refuses writes in a read-only session', async () => {
    await s.setReadOnly(true);
    try {
      const events = await collect(s.query("INSERT INTO parents (name) VALUES ('ro')"));
      expect(events[events.length - 1]).toMatchObject({
        kind: 'error',
        code: 'READ_ONLY_VIOLATION',
      });
      expect((await s.info()).readOnly).toBe(true);
    } finally {
      await s.setReadOnly(false);
    }
  });

  it('surfaces server warnings on the done event', async () => {
    await collect(s.query("SET SESSION sql_mode = ''"));
    await s.begin();
    try {
      const events = await collect(s.query('INSERT INTO kinds (tiny, flag) VALUES (999, 1)'));
      const done = events.find((e) => e.kind === 'done') as
        Extract<QueryEvent, { kind: 'done' }> | undefined;
      expect(done).toBeTruthy();
      const all = events.flatMap((e) => (e.kind === 'done' ? e.warnings : []));
      expect(all.length).toBeGreaterThan(0);
      expect(all[0]!.message.toLowerCase()).toContain('out of range');
    } finally {
      await s.rollback();
      await collect(s.query('SET SESSION sql_mode = DEFAULT'));
    }
  });

  it('explains a statement as a table', async () => {
    const r = await s.explain('SELECT * FROM children WHERE parent_id = 1');
    expect(r.format).toBe('table');
    expect(r.columns?.map((c) => c.name)).toContain('table');
    expect(r.rows?.length).toBeGreaterThan(0);
  });

  it('rejects bad credentials with AUTH_FAILED', async () => {
    await expect(mysqlDriver.connect({ ...endpoint, password: 'wrong' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
