import { describe, expect, it } from 'vitest';
import { V, type TableDefinition } from '@rasql/driver-protocol';
import { PostgresDialect, shortTypeName } from './dialect.js';
import { parseDefault } from './defaults.js';
import { splitPostgres } from './split.js';
import { parseBits, toValue, valueTypeOf } from './values.js';
import { triggerType } from './session.js';

const d = new PostgresDialect();

describe('postgres dialect', () => {
  it('quotes names and literals for standard_conforming_strings', () => {
    expect(d.quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(d.quoteLiteral(V.text("it's C:\\"))).toBe("'it''s C:\\'");
    expect(d.quoteLiteral(V.bytes(new Uint8Array([0, 255])))).toBe("'\\x00ff'::bytea");
    expect(d.quoteLiteral(V.bool(true))).toBe('TRUE');
    expect(d.quoteLiteral(V.float(NaN))).toBe("'NaN'::float8");
    expect(d.quoteLiteral(V.bit(new Uint8Array([5]), 3))).toBe("B'101'");
    expect(() => d.quoteLiteral(V.text('a\0b'))).toThrow(/NUL/);
  });

  it('pages with LIMIT ALL when only an offset is given', () => {
    expect(d.buildSelect({ schema: 'public', name: 't' }, { offset: 10 })).toBe(
      'SELECT * FROM "public"."t" LIMIT ALL OFFSET 10',
    );
  });

  it('filters with ILIKE on the column as text, and with ~* for regexp', () => {
    const sql = d.buildCount(
      { name: 't' },
      {
        where: [
          { column: 'n', op: 'starts with', value: V.text('5_%') },
          { column: 'v', op: 'not regexp', value: V.text('^a') },
        ],
      },
    );
    expect(sql).toBe(
      `SELECT COUNT(*) FROM "t" WHERE "n"::text ILIKE '5!_!%%' ESCAPE '!' AND "v"::text !~* '^a'`,
    );
    expect(d.describe().filterOperators).toContain('regexp');
  });

  it('builds ALTER statements in an order that keeps names valid', () => {
    const table: TableDefinition = {
      schema: 'public',
      name: 't',
      kind: 'table',
      columns: [
        {
          name: 'id',
          ordinal: 1,
          nativeType: 'integer',
          valueType: 'int',
          nullable: false,
          autoIncrement: false,
        },
        {
          name: 'a',
          ordinal: 2,
          nativeType: 'text',
          valueType: 'text',
          nullable: true,
          autoIncrement: false,
        },
      ],
      indexes: [
        {
          name: 't_pkey',
          unique: true,
          primary: true,
          constraint: true,
          columns: [{ name: 'id' }],
        },
        { name: 'ix_a', unique: false, primary: false, columns: [{ name: 'a' }] },
      ],
      foreignKeys: [],
      options: {},
    };
    expect(
      d.buildAlter(table, [
        { kind: 'dropIndex', name: 'ix_a' },
        { kind: 'dropIndex', name: 't_pkey' },
        {
          kind: 'modifyColumn',
          name: 'a',
          column: {
            ...table.columns[1]!,
            name: 'b',
            nativeType: 'VARCHAR(10)',
            nullable: false,
            default: V.text('x'),
          },
        },
        {
          kind: 'addIndex',
          index: {
            name: 'ix_b',
            unique: true,
            primary: false,
            columns: [{ name: 'b', order: 'desc' }],
          },
        },
        { kind: 'setComment', comment: '' },
      ]),
    ).toEqual([
      'DROP INDEX "public"."ix_a"',
      'ALTER TABLE "public"."t" RENAME COLUMN "a" TO "b"',
      'ALTER TABLE "public"."t"\n  DROP CONSTRAINT "t_pkey",\n  ALTER COLUMN "b" TYPE VARCHAR(10) USING "b"::VARCHAR(10),\n  ALTER COLUMN "b" SET NOT NULL,\n  ALTER COLUMN "b" SET DEFAULT \'x\'',
      'CREATE UNIQUE INDEX "ix_b" ON "public"."t" ("b" DESC)',
      'COMMENT ON TABLE "public"."t" IS NULL',
    ]);
    expect(() =>
      d.buildAlter(table, [{ kind: 'addColumn', column: table.columns[1]!, after: null }]),
    ).toThrow(/cannot move/);
  });

  it('shortens format_type names', () => {
    expect(shortTypeName('character varying(255)')).toBe('varchar(255)');
    expect(shortTypeName('timestamp(3) with time zone')).toBe('timestamptz(3)');
    expect(shortTypeName('timestamp without time zone')).toBe('timestamp');
    expect(shortTypeName('time with time zone')).toBe('timetz');
    expect(shortTypeName('character varying[]')).toBe('varchar[]');
    expect(shortTypeName('double precision')).toBe('double precision');
  });
});

describe('postgres values and defaults', () => {
  it('types cells from the text the server printed', () => {
    expect(toValue('t', 'bool')).toEqual(V.bool(true));
    expect(toValue('9223372036854775807', 'int')).toEqual(V.int('9223372036854775807'));
    expect(toValue('\\x00ff', 'bytes')).toEqual(V.bytes(new Uint8Array([0, 255])));
    expect(toValue('-Infinity', 'float')).toEqual(V.float(-Infinity));
    expect(parseBits('1010101')).toEqual(V.bit(new Uint8Array([0x55]), 7));
    expect(toValue(null, 'text')).toEqual(V.null());
    // A domain over integer is an integer; an unknown type is text.
    const types = new Map([
      [90001, { oid: 90001, name: 'positive_int', type: 'd', category: 'N', base: 23 }],
    ]);
    expect(valueTypeOf(90001, types)).toBe('int');
    expect(valueTypeOf(424242, types)).toBe('text');
  });

  it('reads defaults back into values where they are values', () => {
    expect(parseDefault("'it''s'::character varying", 'text')).toEqual(V.text("it's"));
    expect(parseDefault("'-1'::integer", 'int')).toEqual(V.int('-1'));
    expect(parseDefault('42', 'int')).toEqual(V.int('42'));
    expect(parseDefault('true', 'bool')).toEqual(V.bool(true));
    expect(parseDefault('NULL::text', 'text')).toEqual(V.null());
    expect(parseDefault("'2024-01-01'::date", 'date')).toEqual(V.date('2024-01-01'));
    expect(parseDefault('now()', 'datetime')).toEqual({ t: 'expression', sql: 'now()' });
    expect(parseDefault("nextval('t_id_seq'::regclass)", 'int')).toEqual({
      t: 'expression',
      sql: "nextval('t_id_seq'::regclass)",
    });
  });

  it('decodes trigger types', () => {
    expect(triggerType(7)).toEqual({ timing: 'BEFORE', events: 'INSERT', level: 'row' });
    expect(triggerType(4 + 16 + 8)).toEqual({
      timing: 'AFTER',
      events: 'INSERT OR UPDATE OR DELETE',
      level: 'statement',
    });
    expect(triggerType(64 + 1 + 4).timing).toBe('INSTEAD OF');
  });
});

describe('splitPostgres', () => {
  it('splits a script with its offsets, honouring every quoting style', () => {
    const text =
      "SELECT 'a;b';\n-- c;\nDO $x$ BEGIN PERFORM 1; END $x$;\nSELECT E'\\';', \"q;\" ;  ";
    const parts = splitPostgres(text);
    expect(parts.map((p) => p.sql)).toEqual([
      "SELECT 'a;b'",
      '-- c;\nDO $x$ BEGIN PERFORM 1; END $x$',
      "SELECT E'\\';', \"q;\"",
    ]);
    for (const p of parts) expect(text.slice(p.offset, p.offset + p.sql.length)).toBe(p.sql);
    expect(splitPostgres('  -- only a comment\n')).toEqual([]);
    expect(splitPostgres('SELECT $1, a$b FROM t').map((p) => p.sql)).toEqual([
      'SELECT $1, a$b FROM t',
    ]);
  });
});
