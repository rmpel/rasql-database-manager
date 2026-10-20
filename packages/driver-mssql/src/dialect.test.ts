import { describe, expect, it } from 'vitest';
import { V, type TableDefinition } from '@rasql/driver-protocol';
import { MssqlDialect } from './dialect.js';
import { parseDefault } from './defaults.js';
import { isReadOnlyBatch, splitBatches } from './split.js';
import { nativeTypeOf, toValue } from './values.js';

const d = new MssqlDialect();

describe('mssql dialect', () => {
  it('quotes names in brackets and text as N literals', () => {
    expect(d.quoteIdentifier('we]ird')).toBe('[we]]ird]');
    expect(d.quoteLiteral(V.text("it's ☃"))).toBe("N'it''s ☃'");
    expect(d.quoteLiteral(V.text('a\0b'))).toBe("(N'a' + NCHAR(0) + N'b')");
    expect(d.quoteLiteral(V.bytes(new Uint8Array([0, 255])))).toBe('0x00ff');
    expect(d.quoteLiteral(V.bool(false))).toBe('0');
    expect(d.quoteLiteral(V.datetime('2024-02-29 13:14:15.1234567'))).toBe(
      "'2024-02-29 13:14:15.1234567'",
    );
  });

  it('pages with TOP for the first page and OFFSET … FETCH after it', () => {
    expect(d.buildSelect({ schema: 'dbo', name: 't' }, { limit: 100 })).toBe(
      'SELECT TOP (100) * FROM [dbo].[t]',
    );
    expect(d.buildSelect({ name: 't' }, { limit: 100, offset: 200 })).toBe(
      'SELECT * FROM [t] ORDER BY (SELECT NULL) OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY',
    );
    expect(
      d.buildSelect(
        { name: 't' },
        { orderBy: [{ column: 'id', direction: 'desc' }], limit: 5, offset: 5 },
      ),
    ).toBe('SELECT * FROM [t] ORDER BY [id] DESC OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY');
  });

  it('escapes [ in LIKE patterns, which SQL Server reads as a character class', () => {
    expect(
      d.buildCount(
        { name: 't' },
        { where: [{ column: 'v', op: 'contains', value: V.text('[a]%') }] },
      ),
    ).toBe(`SELECT COUNT(*) FROM [t] WHERE [v] LIKE N'%![a]!%%' ESCAPE '!'`);
  });

  it('splits inserts of more than 1000 rows', () => {
    const rows = Array.from({ length: 2500 }, (_, i) => [V.int(i)]);
    expect(d.buildInsertMany({ name: 't' }, ['id'], rows).split(';\n')).toHaveLength(3);
  });

  it('classifies EXEC as unknown and PRINT as a read', () => {
    expect(d.classify('EXEC sp_who')).toBe('unknown');
    expect(d.classify('PRINT 1')).toBe('read');
    expect(d.classify('/* x */ SELECT 1')).toBe('read');
  });

  it('builds ALTER statements that clear default constraints first', () => {
    const table: TableDefinition = {
      schema: 'dbo',
      name: 't',
      kind: 'table',
      columns: [
        {
          name: 'a',
          ordinal: 1,
          nativeType: 'int',
          valueType: 'int',
          nullable: true,
          autoIncrement: false,
          default: V.int('0'),
        },
      ],
      indexes: [
        { name: 'UQ_t', unique: true, primary: false, constraint: true, columns: [{ name: 'a' }] },
      ],
      foreignKeys: [],
      options: {},
    };
    const out = d.buildAlter(table, [
      { kind: 'dropIndex', name: 'UQ_t' },
      { kind: 'modifyColumn', name: 'a', column: { ...table.columns[0]!, nativeType: 'BIGINT' } },
      {
        kind: 'addForeignKey',
        foreignKey: {
          name: 'fk',
          columns: ['a'],
          referencedTable: 'p',
          referencedColumns: ['id'],
          onDelete: 'RESTRICT',
        },
      },
      { kind: 'renameTable', to: 'u' },
    ]);
    expect(out[0]).toBe('ALTER TABLE [dbo].[t] DROP CONSTRAINT [UQ_t]');
    expect(out[1]).toMatch(
      /^DECLARE @df sysname = .*OBJECT_ID\(N'\[dbo\]\.\[t\]'\) AND c\.name = N'a'\);/,
    );
    expect(out[2]).toBe('ALTER TABLE [dbo].[t] ALTER COLUMN [a] BIGINT NULL');
    expect(out[3]).toBe('ALTER TABLE [dbo].[t] ADD CONSTRAINT [DF_t_a] DEFAULT 0 FOR [a]');
    expect(out[4]).toBe(
      'ALTER TABLE [dbo].[t] ADD CONSTRAINT [fk] FOREIGN KEY ([a]) REFERENCES [dbo].[p] ([id]) ON DELETE NO ACTION',
    );
    expect(out[5]).toBe("EXEC sp_rename N'[dbo].[t]', N'u'");
    expect(() =>
      d.buildAlter(table, [
        { kind: 'modifyColumn', name: 'a', column: { ...table.columns[0]!, autoIncrement: true } },
      ]),
    ).toThrow(/IDENTITY/);
  });
});

describe('mssql values and defaults', () => {
  const col = (name: string, extra: Record<string, unknown> = {}) => ({
    colName: 'c',
    type: { name },
    ...extra,
  });

  it('names result types with their sizes', () => {
    expect(nativeTypeOf(col('IntN', { dataLength: 1 }))).toBe('tinyint');
    expect(nativeTypeOf(col('NVarChar', { dataLength: 0xffff }))).toBe('nvarchar(max)');
    expect(nativeTypeOf(col('NVarChar', { dataLength: 200 }))).toBe('nvarchar(100)');
    expect(nativeTypeOf(col('DecimalN', { precision: 10, scale: 2 }))).toBe('decimal(10,2)');
    expect(nativeTypeOf(col('MoneyN', { dataLength: 8 }))).toBe('money');
  });

  it('keeps 100 ns digits and prints decimals at the column scale', () => {
    const dt = Object.assign(new Date(Date.UTC(2024, 1, 29, 13, 14, 15, 123)), {
      nanosecondsDelta: 0.0004567,
    });
    expect(toValue(dt, col('DateTime2', { scale: 7 }))).toEqual(
      V.datetime('2024-02-29 13:14:15.1234567'),
    );
    expect(toValue(dt, col('DateTime2', { scale: 3 }))).toEqual(
      V.datetime('2024-02-29 13:14:15.123'),
    );
    expect(toValue(dt, col('DateTimeOffset', { scale: 0 }))).toEqual(
      V.datetime('2024-02-29 13:14:15 +00:00'),
    );
    expect(toValue(dt, col('Date'))).toEqual(V.date('2024-02-29'));
    expect(toValue(12.5, col('DecimalN', { precision: 10, scale: 2 }))).toEqual(V.decimal('12.50'));
    expect(toValue(1, col('MoneyN', { dataLength: 8 }))).toEqual(V.decimal('1.0000'));
    expect(toValue('9223372036854775807', col('BigInt'))).toEqual(V.int('9223372036854775807'));
    expect(toValue(true, col('BitN'))).toEqual(V.bool(true));
  });

  it('reads defaults back into values where they are values', () => {
    expect(parseDefault('((0))', 'int')).toEqual(V.int('0'));
    expect(parseDefault('((-1.5))', 'decimal')).toEqual(V.decimal('-1.5'));
    expect(parseDefault("(N'it''s')", 'text')).toEqual(V.text("it's"));
    expect(parseDefault('(NULL)', 'text')).toEqual(V.null());
    expect(parseDefault('(getdate())', 'datetime')).toEqual({ t: 'expression', sql: 'getdate()' });
    expect(parseDefault("(('a')+('b'))", 'text')).toEqual({ t: 'expression', sql: "('a')+('b')" });
  });
});

describe('mssql batches', () => {
  it('splits on GO lines, with repeat counts, and keeps GO inside strings and comments', () => {
    const text = "SELECT 1\nGO\nPRINT 'GO'\n/*\nGO\n*/\nGO 3\n  go  \nSELECT 2 -- GO";
    expect(splitBatches(text)).toEqual([
      { sql: 'SELECT 1', offset: 0, repeat: 1 },
      { sql: "PRINT 'GO'\n/*\nGO\n*/", offset: 12, repeat: 3 },
      { sql: 'SELECT 2 -- GO', offset: text.indexOf('SELECT 2'), repeat: 1 },
    ]);
  });

  it('lets only reading batches through on a read-only connection', () => {
    expect(isReadOnlyBatch('SELECT * FROM t')).toBe(true);
    expect(
      isReadOnlyBatch("WITH x AS (SELECT 1 AS a) SELECT N'delete' AS [update] FROM x -- drop"),
    ).toBe(true);
    expect(isReadOnlyBatch('DECLARE @a int = 1; SELECT @a')).toBe(true);
    expect(isReadOnlyBatch('SELECT 1 DELETE FROM t')).toBe(false);
    expect(isReadOnlyBatch('SELECT * INTO t2 FROM t')).toBe(false);
    expect(isReadOnlyBatch('sp_who')).toBe(false);
    expect(isReadOnlyBatch('SELECT 1; EXEC p')).toBe(false);
  });
});
