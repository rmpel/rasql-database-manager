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

  it('filters with REGEXP and set membership', () => {
    expect(d.describe().filterOperators).toContain('has member');
    expect(
      d.buildCount(
        { name: 'p' },
        {
          where: [
            { column: 'slug', op: 'regexp', value: V.text('^post-\\d+$') },
            { column: 'flags', op: 'has member', value: V.text('sticky') },
            { column: 'title', op: 'contains', value: V.text('100%') },
          ],
        },
      ),
    ).toBe(
      "SELECT COUNT(*) FROM `p` WHERE `slug` REGEXP '^post-\\\\d+$' AND FIND_IN_SET('sticky', `flags`) > 0 AND `title` LIKE '%100!%%' ESCAPE '!'",
    );
  });

  it('builds one ALTER TABLE with every change, in a safe order', () => {
    const table = {
      schema: 'shop',
      name: 'orders',
      kind: 'table' as const,
      columns: [
        {
          name: 'id',
          ordinal: 1,
          nativeType: 'int(10) unsigned',
          valueType: 'int' as const,
          nullable: false,
          autoIncrement: true,
        },
        {
          name: 'title',
          ordinal: 2,
          nativeType: 'varchar(100)',
          valueType: 'text' as const,
          nullable: true,
          autoIncrement: false,
          charset: 'utf8mb4',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
      indexes: [],
      foreignKeys: [],
      options: {},
    };
    const [sql] = d.buildAlter(table, [
      {
        kind: 'addIndex',
        index: {
          name: 'by_title',
          unique: false,
          primary: false,
          columns: [{ name: 'title', length: 20 }],
        },
      },
      {
        kind: 'modifyColumn',
        name: 'title',
        column: {
          ...table.columns[1]!,
          name: 'label',
          nativeType: 'varchar(200)',
          nullable: false,
          default: V.text("it's"),
        },
        after: null,
      },
      {
        kind: 'addColumn',
        column: {
          name: 'updated',
          ordinal: 3,
          nativeType: 'timestamp',
          valueType: 'datetime',
          nullable: false,
          autoIncrement: false,
          default: { t: 'expression', sql: 'CURRENT_TIMESTAMP' },
          extra: 'on update CURRENT_TIMESTAMP',
          comment: 'last change',
        },
        after: 'label',
      },
      {
        kind: 'addColumn',
        column: {
          name: 'token',
          ordinal: 4,
          nativeType: 'char(36)',
          valueType: 'text',
          nullable: true,
          autoIncrement: false,
          default: { t: 'expression', sql: 'uuid()' },
        },
      },
      { kind: 'dropForeignKey', name: 'fk_old' },
      { kind: 'setComment', comment: 'Orders' },
    ]);
    expect(sql).toBe(
      [
        'ALTER TABLE `shop`.`orders`',
        '  DROP FOREIGN KEY `fk_old`,',
        "  CHANGE COLUMN `title` `label` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'it''s' FIRST,",
        "  ADD COLUMN `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'last change' AFTER `label`,",
        '  ADD COLUMN `token` char(36) NULL DEFAULT (uuid()),',
        '  ADD INDEX `by_title` (`title`(20)),',
        "  COMMENT = 'Orders'",
      ].join('\n'),
    );
    expect(d.buildAlter(table, [{ kind: 'renameColumn', from: 'id', to: 'order_id' }])[0]).toBe(
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `id` `order_id` int(10) unsigned NOT NULL AUTO_INCREMENT',
    );
    expect(d.buildAlter(table, [])).toEqual([]);
  });

  it('classifies statements', () => {
    expect(d.classify('SHOW TABLES')).toBe('read');
    expect(d.classify('REPLACE INTO t VALUES (1)')).toBe('write');
    expect(d.classify('SET SESSION TRANSACTION READ ONLY')).toBe('admin');
  });
});
