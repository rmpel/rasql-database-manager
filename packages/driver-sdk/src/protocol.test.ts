import { describe, expect, it } from 'vitest';
import {
  DriverError,
  PROTOCOL_VERSION,
  V,
  type DialectInfo,
  type Driver,
  type QueryEvent,
  type QueryOptions,
  type ResolvedEndpoint,
  type Session,
  type Value,
} from '@rasql/driver-protocol';
import { BaseDialect, classifyStatement, formatLiteral, stripSqlComments } from './dialect.js';
import { createInProcessTransports } from './inprocess.js';
import { serveDriver } from './serve.js';
import { DriverClient } from './client.js';
import { runConformanceChecks } from './conformance.js';

class FakeDialect extends BaseDialect {
  describe(): DialectInfo {
    return {
      id: 'fake',
      identifierQuote: '"',
      keywords: ['SELECT'],
      types: [],
      pingSql: 'SELECT 1',
    };
  }
  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
  quoteLiteral(v: Value): string {
    return formatLiteral(v, { hex: 'x-quote', booleans: 'numeric', escapeBackslashes: false });
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new DriverError('CANCELLED', 'aborted'));
    });
  });

/** An in-memory driver with one table, used to exercise the protocol end to end. */
const fakeDriver: Driver = {
  manifest: () => ({
    id: 'fake',
    name: 'Fake',
    version: '0.0.0',
    protocolVersion: PROTOCOL_VERSION,
    engines: [{ id: 'fake', name: 'Fake Engine' }],
    transports: ['file'],
    capabilities: {
      multipleSchemas: false,
      transactions: false,
      explain: true,
      cancel: true,
      readOnlySession: false,
      objects: ['table'],
      alterTable: false,
      users: false,
    },
    connectionForm: { fields: [] },
  }),
  async connect(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<Session> {
    if (endpoint.options['failAuth']) throw new DriverError('AUTH_FAILED', 'bad credentials');
    if (endpoint.options['slowConnect']) await sleep(5_000, signal);
    const dialect = new FakeDialect();
    const session: Session = {
      dialect,
      info: async () => ({
        engine: 'fake',
        engineName: 'Fake Engine',
        version: '1.0',
        readOnly: false,
      }),
      listSchemas: async () => [{ name: 'main', isCurrent: true }],
      listObjects: async () => [{ kind: 'table', schema: 'main', name: 't' }],
      describeTable: async (schema, name) => ({
        schema,
        name,
        kind: 'table',
        columns: [
          {
            name: 'id',
            ordinal: 1,
            nativeType: 'INTEGER',
            valueType: 'int',
            nullable: false,
            autoIncrement: true,
          },
          {
            name: 'blob',
            ordinal: 2,
            nativeType: 'BLOB',
            valueType: 'bytes',
            nullable: true,
            autoIncrement: false,
          },
        ],
        indexes: [],
        foreignKeys: [],
        primaryKey: ['id'],
        options: {},
      }),
      async *query(sql: string, opts: QueryOptions = {}): AsyncIterable<QueryEvent> {
        const started = Date.now();
        if (/^SELEC\b/.test(sql)) {
          yield {
            kind: 'error',
            resultIndex: 0,
            code: 'QUERY_FAILED',
            message: 'syntax error',
            sqlState: '42000',
          };
          return;
        }
        if (sql === 'SLOW') {
          yield {
            kind: 'columns',
            resultIndex: 0,
            columns: [
              {
                name: 'n',
                nativeType: 'INT',
                valueType: 'int',
                nullable: false,
                isPrimaryKey: false,
              },
            ],
          };
          for (let i = 0; i < 1000; i++) {
            await sleep(5, opts.signal);
            yield { kind: 'rows', resultIndex: 0, rows: [[V.int(i)]] };
          }
          yield {
            kind: 'done',
            resultIndex: 0,
            more: false,
            elapsedMs: Date.now() - started,
            warnings: [],
          };
          return;
        }
        if (sql.startsWith("SELECT '")) {
          const text = sql.slice(8, -1);
          yield {
            kind: 'columns',
            resultIndex: 0,
            columns: [
              {
                name: 'c',
                nativeType: 'TEXT',
                valueType: 'text',
                nullable: false,
                isPrimaryKey: false,
              },
            ],
          };
          yield { kind: 'rows', resultIndex: 0, rows: [[V.text(text)]] };
          yield {
            kind: 'done',
            resultIndex: 0,
            more: false,
            elapsedMs: Date.now() - started,
            warnings: [],
          };
          return;
        }
        if (sql === 'BYTES') {
          yield {
            kind: 'columns',
            resultIndex: 0,
            columns: [
              {
                name: 'b',
                nativeType: 'BLOB',
                valueType: 'bytes',
                nullable: true,
                isPrimaryKey: false,
              },
            ],
          };
          yield {
            kind: 'rows',
            resultIndex: 0,
            rows: [[V.bytes(new Uint8Array([0, 255, 1]), 'latin1')], [V.null()]],
          };
          yield {
            kind: 'done',
            resultIndex: 0,
            more: false,
            elapsedMs: Date.now() - started,
            warnings: [],
          };
          return;
        }
        yield {
          kind: 'columns',
          resultIndex: 0,
          columns: [
            {
              name: '1',
              nativeType: 'INT',
              valueType: 'int',
              nullable: false,
              isPrimaryKey: false,
            },
          ],
        };
        yield { kind: 'rows', resultIndex: 0, rows: [[V.int(1)]] };
        yield {
          kind: 'done',
          resultIndex: 0,
          more: false,
          elapsedMs: Date.now() - started,
          warnings: [],
        };
      },
      explain: async () => ({ format: 'text', text: 'SCAN t' }),
      setReadOnly: async () => undefined,
      begin: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      close: async () => undefined,
    };
    return session;
  },
};

function connectFake(): { client: DriverClient; stop: () => void } {
  const { host, driver } = createInProcessTransports();
  const stop = serveDriver(fakeDriver, driver);
  const client = new DriverClient(host);
  return { client, stop };
}

const endpoint: ResolvedEndpoint = { transport: 'file', filePath: ':memory:', options: {} };

describe('protocol end to end', () => {
  it('passes the conformance checks with the fake driver', async () => {
    const report = await runConformanceChecks(fakeDriver, endpoint);
    const failures = report.checks.filter((c) => c.status === 'fail');
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(report.engine).toBe('fake');
  });

  it('carries bytes and nulls through structured clone intact', async () => {
    const { client, stop } = connectFake();
    try {
      const s = await client.connect(endpoint);
      const rows: Value[][] = [];
      for await (const e of s.query('BYTES')) if (e.kind === 'rows') rows.push(...e.rows);
      expect(rows[0]![0]).toEqual({
        t: 'bytes',
        v: new Uint8Array([0, 255, 1]),
        charsetHint: 'latin1',
      });
      expect(rows[0]![0]!.t === 'bytes' && rows[0]![0]!.v instanceof Uint8Array).toBe(true);
      expect(rows[1]![0]).toEqual({ t: 'null' });
    } finally {
      client.shutdown();
      stop();
    }
  });

  it('rejects connect with the driver error code', async () => {
    const { client, stop } = connectFake();
    try {
      await expect(
        client.connect({ ...endpoint, options: { failAuth: true } }),
      ).rejects.toMatchObject({
        code: 'AUTH_FAILED',
      });
    } finally {
      client.shutdown();
      stop();
    }
  });

  it('cancels a running query through an AbortSignal', async () => {
    const { client, stop } = connectFake();
    try {
      const s = await client.connect(endpoint);
      const ac = new AbortController();
      let rows = 0;
      let errorEvent: QueryEvent | undefined;
      for await (const e of s.query('SLOW', { signal: ac.signal })) {
        if (e.kind === 'rows') {
          rows += e.rows.length;
          if (rows === 3) ac.abort();
        }
        if (e.kind === 'error') errorEvent = e;
      }
      expect(rows).toBeLessThan(20);
      expect(errorEvent).toMatchObject({ kind: 'error', code: 'CANCELLED' });
    } finally {
      client.shutdown();
      stop();
    }
  });

  it('cancels a slow connect', async () => {
    const { client, stop } = connectFake();
    try {
      const ac = new AbortController();
      const p = client.connect({ ...endpoint, options: { slowConnect: true } }, ac.signal);
      setTimeout(() => ac.abort(), 20);
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      client.shutdown();
      stop();
    }
  });

  it('runs dialect methods remotely', async () => {
    const { client, stop } = connectFake();
    try {
      const s = await client.connect(endpoint);
      expect(await s.dialect.quoteIdentifier('a"b')).toBe('"a""b"');
      expect(
        await s.dialect.buildUpdate(
          { name: 't' },
          [{ column: 'x', newValue: V.text("it's") }],
          [{ column: 'id', value: V.int(7) }],
        ),
      ).toBe(`UPDATE "t" SET "x" = 'it''s' WHERE "id" = 7`);
      await expect(s.dialect.buildAlter({} as never, [])).rejects.toMatchObject({
        code: 'UNSUPPORTED',
      });
    } finally {
      client.shutdown();
      stop();
    }
  });

  it('fails pending requests when shut down', async () => {
    const { client, stop } = connectFake();
    const s = await client.connect(endpoint);
    const p = s.listSchemas();
    client.shutdown();
    stop();
    await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

describe('BaseDialect', () => {
  const d = new FakeDialect();
  it('builds a paginated select with filters', () => {
    expect(
      d.buildSelect(
        { schema: 's', name: 't' },
        {
          columns: ['a', 'b'],
          where: [
            { column: 'a', op: '>', value: V.int(5) },
            { column: 'b', op: 'is null' },
            { column: 'c', op: 'in', value: [V.text('x'), V.text('y')] },
          ],
          whereSql: 'd = 1',
          orderBy: [{ column: 'a', direction: 'desc' }],
          limit: 10,
          offset: 20,
        },
      ),
    ).toBe(
      `SELECT "a", "b" FROM "s"."t" WHERE "a" > 5 AND "b" IS NULL AND "c" IN ('x', 'y') AND (d = 1) ORDER BY "a" DESC LIMIT 10 OFFSET 20`,
    );
  });

  it('builds text matching with escaped patterns, between, emptiness and groups', () => {
    const where = (w: Parameters<FakeDialect['buildCount']>[1]['where']): string =>
      d.buildCount({ name: 't' }, { where: w ?? [] });
    expect(where([{ column: 'a', op: 'contains', value: V.text("50%_off!'") }])).toBe(
      `SELECT COUNT(*) FROM "t" WHERE "a" LIKE '%50!%!_off!!''%' ESCAPE '!'`,
    );
    expect(where([{ column: 'a', op: 'starts with', value: V.text('wp_') }])).toBe(
      `SELECT COUNT(*) FROM "t" WHERE "a" LIKE 'wp!_%' ESCAPE '!'`,
    );
    expect(where([{ column: 'a', op: 'ends with', value: V.int('7') }])).toBe(
      `SELECT COUNT(*) FROM "t" WHERE "a" LIKE '%7' ESCAPE '!'`,
    );
    expect(where([{ column: 'a', op: 'not contains', value: V.text('x') }])).toBe(
      `SELECT COUNT(*) FROM "t" WHERE "a" NOT LIKE '%x%' ESCAPE '!'`,
    );
    expect(where([{ column: 'n', op: 'not between', value: [V.int('3'), V.int('5')] }])).toBe(
      `SELECT COUNT(*) FROM "t" WHERE "n" NOT BETWEEN 3 AND 5`,
    );
    expect(
      where([
        { column: 'a', op: 'is empty' },
        { column: 'b', op: 'is not empty' },
      ]),
    ).toBe(`SELECT COUNT(*) FROM "t" WHERE "a" = '' AND "b" <> ''`);
    expect(
      where([
        {
          match: 'any',
          filters: [
            { column: 'n', op: '<', value: V.int('3') },
            { column: 'n', op: '>', value: V.int('5') },
          ],
        },
        { match: 'all', filters: [{ column: 'a', op: '=', value: V.text('x') }] },
        { match: 'any', filters: [] },
      ]),
    ).toBe(`SELECT COUNT(*) FROM "t" WHERE ("n" < 3 OR "n" > 5) AND "a" = 'x'`);
    expect(() => where([{ column: 'a', op: 'regexp', value: V.text('x') }])).toThrow(DriverError);
    expect(() => where([{ column: 'n', op: 'between', value: [V.int('1')] }])).toThrow(DriverError);
  });

  it('builds a multi-row insert', () => {
    expect(
      d.buildInsertMany(
        { name: 't' },
        ['a', 'b'],
        [
          [V.int(1), V.text('x')],
          [V.null(), V.bytes(new Uint8Array([255]))],
        ],
      ),
    ).toBe(`INSERT INTO "t" ("a", "b") VALUES\n(1, 'x'),\n(NULL, X'ff')`);
  });

  it('refuses to delete without a key', () => {
    expect(() => d.buildDelete({ name: 't' }, [])).toThrow(DriverError);
  });

  it('uses IS NULL for null key parts', () => {
    expect(d.buildDelete({ name: 't' }, [{ column: 'k', value: V.null() }])).toBe(
      `DELETE FROM "t" WHERE "k" IS NULL`,
    );
  });
});

describe('formatLiteral', () => {
  it('writes every value type', () => {
    const s = { hex: 'x-quote' as const, booleans: 'keyword' as const, escapeBackslashes: true };
    expect(formatLiteral(V.null(), s)).toBe('NULL');
    expect(formatLiteral(V.bool(true), s)).toBe('TRUE');
    expect(formatLiteral(V.int('18446744073709551615'), s)).toBe('18446744073709551615');
    expect(formatLiteral(V.decimal('1.50'), s)).toBe('1.50');
    expect(formatLiteral(V.float(1.5), s)).toBe('1.5');
    expect(formatLiteral(V.text("a'b\\c"), s)).toBe(`'a''b\\\\c'`);
    expect(formatLiteral(V.bytes(new Uint8Array([0, 171])), s)).toBe(`X'00ab'`);
    expect(formatLiteral(V.bit(new Uint8Array([5]), 3), s)).toBe(`b'101'`);
    expect(formatLiteral(V.set(['a', 'b']), s)).toBe(`'a,b'`);
    expect(formatLiteral(V.text('a\0b'), s)).toBe(`'a\\0b'`);
    const plain = {
      hex: 'x-quote' as const,
      booleans: 'numeric' as const,
      escapeBackslashes: false,
    };
    expect(formatLiteral(V.text("\0*\0x'"), plain)).toBe(
      `('' || char(0) || '*' || char(0) || 'x''')`,
    );
    expect(formatLiteral(V.text('no nul'), plain)).toBe(`'no nul'`);
    expect(() => formatLiteral(V.float(Number.NaN), s)).toThrow(DriverError);
  });
});

describe('classifyStatement', () => {
  it('classifies by leading keyword, ignoring comments', () => {
    expect(classifyStatement('-- hi\n  SELECT 1')).toBe('read');
    expect(classifyStatement('/* x */ insert into t values (1)')).toBe('write');
    expect(classifyStatement('WITH a AS (SELECT 1) SELECT * FROM a')).toBe('read');
    expect(
      classifyStatement('WITH a AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM a)'),
    ).toBe('write');
    expect(classifyStatement('ALTER TABLE t ADD c INT')).toBe('ddl');
    expect(classifyStatement('TRUNCATE t')).toBe('ddl');
    expect(classifyStatement('SET NAMES utf8mb4')).toBe('admin');
    expect(classifyStatement('PRAGMA table_info(t)')).toBe('admin');
    expect(classifyStatement('PRAGMA journal_mode')).toBe('read');
    expect(classifyStatement('BEGIN')).toBe('transaction');
    expect(classifyStatement('(SELECT 1)')).toBe('read');
    expect(classifyStatement('')).toBe('unknown');
  });

  it('does not treat quoted comment markers as comments', () => {
    expect(stripSqlComments(`SELECT '--not a comment' -- real`)).toBe(`SELECT '--not a comment' `);
  });
});
