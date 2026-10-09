import { describe, expect, it } from 'vitest';
import { V } from '@rasql/driver-protocol';
import { MysqlDialect } from './dialect.js';

const d = new MysqlDialect();

describe('MysqlDialect', () => {
  it('quotes identifiers with backticks', () => {
    expect(d.quoteIdentifier('we`ird')).toBe('`we``ird`');
    expect(d.describe().identifierQuote).toBe('`');
  });

  it('writes literals the MySQL way', () => {
    expect(d.quoteLiteral(V.text("it's \\ a path"))).toBe(`'it''s \\\\ a path'`);
    expect(d.quoteLiteral(V.bool(true))).toBe('1');
    expect(d.quoteLiteral(V.bytes(new Uint8Array([0, 255])))).toBe(`X'00ff'`);
    expect(d.quoteLiteral(V.bit(new Uint8Array([0x55]), 7))).toBe(`b'1010101'`);
    expect(d.quoteLiteral(V.set(['a', 'c']))).toBe(`'a,c'`);
    expect(d.quoteLiteral(V.geometry(new Uint8Array([1, 2]), 4326))).toBe(
      `ST_GeomFromWKB(X'0102', 4326)`,
    );
  });

  it('builds grid statements', () => {
    expect(
      d.buildUpdate(
        { schema: 'rasql', name: 'kinds' },
        [{ column: 'vc', newValue: V.text('x') }],
        [{ column: 'id', value: V.int('18446744073709551615') }],
      ),
    ).toBe("UPDATE `rasql`.`kinds` SET `vc` = 'x' WHERE `id` = 18446744073709551615");
    expect(d.buildSelect({ name: 'many' }, { limit: 50, offset: 100 })).toBe(
      'SELECT * FROM `many` LIMIT 50 OFFSET 100',
    );
  });

  it('classifies statements', () => {
    expect(d.classify('SHOW TABLES')).toBe('read');
    expect(d.classify('REPLACE INTO t VALUES (1)')).toBe('write');
    expect(d.classify('SET SESSION TRANSACTION READ ONLY')).toBe('admin');
  });
});
