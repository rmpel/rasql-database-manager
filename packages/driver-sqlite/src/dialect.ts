import {
  BASIC_FILTER_OPERATORS,
  type DialectInfo,
  type TypeDescriptor,
  type Value,
} from '@rasql/driver-protocol';
import { BaseDialect, formatLiteral } from '@rasql/driver-sdk';

const KEYWORDS = (
  'ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY ' +
  'CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE ' +
  'CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP ' +
  'EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM ' +
  'FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD ' +
  'INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL ' +
  'NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE ' +
  'RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS ' +
  'SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE ' +
  'USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT'
).split(' ');

const TYPES: TypeDescriptor[] = [
  { name: 'INTEGER', category: 'integer' },
  { name: 'REAL', category: 'float' },
  { name: 'TEXT', category: 'text' },
  { name: 'BLOB', category: 'binary' },
  { name: 'NUMERIC', category: 'decimal' },
  { name: 'BOOLEAN', category: 'boolean' },
  { name: 'DATE', category: 'date' },
  { name: 'DATETIME', category: 'datetime' },
  { name: 'JSON', category: 'json' },
];

export class SqliteDialect extends BaseDialect {
  describe(): DialectInfo {
    return {
      id: 'sqlite',
      identifierQuote: '"',
      keywords: KEYWORDS,
      types: TYPES,
      pingSql: 'SELECT 1',
      filterOperators: [...BASIC_FILTER_OPERATORS],
    };
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteLiteral(v: Value): string {
    return formatLiteral(v, { hex: 'x-quote', booleans: 'numeric', escapeBackslashes: false });
  }

  protected override paginate(sql: string, limit?: number, offset?: number): string {
    if (limit === undefined && offset === undefined) return sql;
    const lim = limit === undefined ? -1 : Math.max(0, Math.trunc(limit));
    let out = `${sql} LIMIT ${lim}`;
    if (offset !== undefined && offset > 0) out += ` OFFSET ${Math.trunc(offset)}`;
    return out;
  }
}
