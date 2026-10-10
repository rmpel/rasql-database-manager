import {
  BASIC_FILTER_OPERATORS,
  DriverError,
  type AlterCapabilities,
  type ColumnDefinition,
  type StructureChange,
  type TableDefinition,
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
  { name: 'INTEGER', category: 'integer', description: 'Whole numbers, up to 8 bytes.' },
  { name: 'REAL', category: 'float', description: 'Approximate numbers, about 15 digits.' },
  { name: 'TEXT', category: 'text', description: 'Text of any length.' },
  { name: 'BLOB', category: 'binary', description: 'Raw bytes, stored as given.' },
  { name: 'NUMERIC', category: 'decimal', description: 'Numbers kept as exact as SQLite can.' },
  { name: 'BOOLEAN', category: 'boolean', description: 'Stored as 0 or 1.' },
  { name: 'DATE', category: 'date', description: 'Stored as text, YYYY-MM-DD.' },
  { name: 'DATETIME', category: 'datetime', description: 'Stored as text, YYYY-MM-DD HH:MM:SS.' },
  { name: 'JSON', category: 'json', description: 'Stored as text; SQLite has JSON functions.' },
];

/** SQLite alters in place only for these; a type change needs a table rebuild, not offered yet. */
const ALTER: AlterCapabilities = {
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  modifyColumn: false,
  moveColumn: false,
  indexes: true,
  primaryKey: false,
  foreignKeys: false,
  tableComment: false,
  columnComments: false,
  renameTable: true,
  collations: false,
};

export class SqliteDialect extends BaseDialect {
  describe(): DialectInfo {
    return {
      id: 'sqlite',
      identifierQuote: '"',
      keywords: KEYWORDS,
      types: TYPES,
      pingSql: 'SELECT 1',
      filterOperators: [...BASIC_FILTER_OPERATORS],
      alter: ALTER,
    };
  }

  /** One statement per change; the host runs them in a transaction, which SQLite honors for DDL. */
  override buildAlter(table: TableDefinition, changes: StructureChange[]): string[] {
    const q = this.quoteIdentifier.bind(this);
    const schema = table.schema ? `${q(table.schema)}.` : '';
    const name = `${schema}${q(table.name)}`;
    const unsupported = (what: string): never => {
      throw new DriverError('UNSUPPORTED', `SQLite cannot ${what} without rebuilding the table`);
    };
    return changes.map((c): string => {
      switch (c.kind) {
        case 'addColumn':
          if (c.after !== undefined) unsupported('place a column at a position');
          return `ALTER TABLE ${name} ADD COLUMN ${this.columnSql(c.column)}`;
        case 'dropColumn':
          return `ALTER TABLE ${name} DROP COLUMN ${q(c.name)}`;
        case 'renameColumn':
          return `ALTER TABLE ${name} RENAME COLUMN ${q(c.from)} TO ${q(c.to)}`;
        case 'modifyColumn': {
          const before = table.columns.find((x) => x.name === c.name);
          // Only a rename is possible in place.
          if (!before || c.after !== undefined || !sameExceptName(before, c.column))
            unsupported(`change column ${c.name}`);
          return `ALTER TABLE ${name} RENAME COLUMN ${q(c.name)} TO ${q(c.column.name)}`;
        }
        case 'addIndex': {
          if (c.index.primary) unsupported('add a primary key');
          const cols = c.index.columns
            .map(
              (x) =>
                `${x.expression ? `(${x.expression})` : q(x.name ?? '')}${x.order === 'desc' ? ' DESC' : ''}`,
            )
            .join(', ');
          return `CREATE ${c.index.unique ? 'UNIQUE ' : ''}INDEX ${schema}${q(c.index.name)} ON ${q(table.name)} (${cols})`;
        }
        case 'dropIndex':
          return `DROP INDEX ${schema}${q(c.name)}`;
        case 'renameTable':
          return `ALTER TABLE ${name} RENAME TO ${q(c.to)}`;
        default:
          throw new DriverError(
            'UNSUPPORTED',
            `SQLite cannot ${c.kind.replace(/([A-Z])/g, ' $1').toLowerCase()}`,
          );
      }
    });
  }

  columnSql(c: ColumnDefinition): string {
    let sql = `${this.quoteIdentifier(c.name)} ${c.nativeType}`.trimEnd();
    if (!c.nullable) sql += ' NOT NULL';
    if (c.default !== undefined)
      sql += ` DEFAULT ${c.default.t === 'expression' ? `(${c.default.sql})` : this.quoteLiteral(c.default)}`;
    return sql;
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

function sameExceptName(a: ColumnDefinition, b: ColumnDefinition): boolean {
  const strip = (c: ColumnDefinition): string =>
    JSON.stringify({ ...c, name: '', ordinal: 0 }, Object.keys(c).sort());
  return strip(a) === strip(b);
}
