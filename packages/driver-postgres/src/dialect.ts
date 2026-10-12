import {
  BASIC_FILTER_OPERATORS,
  DriverError,
  type AlterCapabilities,
  type ColumnDefinition,
  type DialectInfo,
  type Filter,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type StructureChange,
  type TableDefinition,
  type TypeDescriptor,
  type Value,
} from '@rasql/driver-protocol';
import { BaseDialect, bytesToHex, escapeSingleQuotes } from '@rasql/driver-sdk';
import { bitsToString } from './values.js';

const KEYWORDS = (
  'ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC AUTHORIZATION BETWEEN BIGINT BINARY BOOLEAN BOTH ' +
  'BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMENT COMMIT CONCURRENTLY CONSTRAINT CONFLICT COPY CREATE ' +
  'CROSS CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_SCHEMA CURRENT_TIME CURRENT_TIMESTAMP ' +
  'CURRENT_USER DEFAULT DEFERRABLE DELETE DESC DISTINCT DO DROP ELSE END EXCEPT EXISTS EXPLAIN EXTENSION ' +
  'FALSE FETCH FILTER FOR FOREIGN FROM FULL FUNCTION GENERATED GRANT GROUP HAVING IDENTITY ILIKE IN INDEX ' +
  'INITIALLY INNER INSERT INTERSECT INTERVAL INTO IS ISNULL JOIN LANGUAGE LATERAL LEADING LEFT LIKE LIMIT ' +
  'LOCALTIME LOCALTIMESTAMP MATERIALIZED NATURAL NOT NOTHING NOTNULL NULL NULLS OFFSET ON ONLY OR ORDER ' +
  'OUTER OVER OVERLAPS PARTITION PLACING PRIMARY PROCEDURE REFERENCES REFRESH RETURNING RETURNS REVOKE ' +
  'RIGHT ROLLBACK ROW SCHEMA SELECT SEQUENCE SESSION_USER SET SIMILAR SOME SYMMETRIC TABLE TABLESAMPLE ' +
  'THEN TO TRAILING TRIGGER TRUE TRUNCATE UNION UNIQUE UPDATE USER USING VACUUM VALUES VARIADIC VERBOSE ' +
  'VIEW WHEN WHERE WINDOW WITH'
).split(' ');

const TYPES: TypeDescriptor[] = [
  { name: 'INTEGER', category: 'integer', description: 'Whole numbers up to about 2 billion.' },
  { name: 'BIGINT', category: 'integer', description: 'Whole numbers up to about 9 quintillion.' },
  { name: 'SMALLINT', category: 'integer', description: 'Whole numbers from -32768 to 32767.' },
  {
    name: 'NUMERIC',
    category: 'decimal',
    hasPrecision: true,
    hasScale: true,
    description: 'Exact numbers with a fixed number of decimals; use for money.',
  },
  {
    name: 'DOUBLE PRECISION',
    category: 'float',
    description: 'Approximate numbers, about 15 digits.',
  },
  { name: 'REAL', category: 'float', description: 'Approximate numbers, about 6 digits.' },
  {
    name: 'VARCHAR',
    category: 'text',
    hasLength: true,
    description: 'Text up to a length; without one, any length.',
  },
  { name: 'TEXT', category: 'text', description: 'Text of any length.' },
  {
    name: 'CHAR',
    category: 'text',
    hasLength: true,
    description: 'Text padded to a fixed length.',
  },
  { name: 'UUID', category: 'text', description: 'Unique identifiers such as 550e8400-e29b-…' },
  {
    name: 'TIMESTAMP',
    category: 'datetime',
    hasPrecision: true,
    description: 'Date and time, without a time zone.',
  },
  {
    name: 'TIMESTAMPTZ',
    category: 'datetime',
    hasPrecision: true,
    description: 'A moment in time; shown in the session time zone.',
  },
  { name: 'DATE', category: 'date', description: 'A calendar date.' },
  { name: 'TIME', category: 'time', hasPrecision: true, description: 'A time of day.' },
  {
    name: 'TIMETZ',
    category: 'time',
    hasPrecision: true,
    description: 'A time of day with a time zone offset.',
  },
  { name: 'INTERVAL', category: 'time', description: 'A duration, such as 3 days 04:00:00.' },
  { name: 'BOOLEAN', category: 'boolean', description: 'True or false.' },
  { name: 'JSONB', category: 'json', description: 'JSON, stored parsed; can be indexed.' },
  { name: 'JSON', category: 'json', description: 'JSON, stored as typed.' },
  { name: 'BYTEA', category: 'binary', description: 'Raw bytes.' },
  { name: 'BIT', category: 'bit', hasLength: true, description: 'A fixed number of bits.' },
  { name: 'VARBIT', category: 'bit', hasLength: true, description: 'Bits up to a length.' },
  { name: 'POINT', category: 'spatial', description: 'A point on a plane, (x,y).' },
  { name: 'POLYGON', category: 'spatial', description: 'A closed shape of points.' },
  { name: 'INET', category: 'other', description: 'An IPv4 or IPv6 address.' },
  { name: 'CIDR', category: 'other', description: 'An IPv4 or IPv6 network.' },
  { name: 'MACADDR', category: 'other', description: 'A MAC address.' },
];

const ALTER: AlterCapabilities = {
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  modifyColumn: true,
  moveColumn: false,
  indexes: true,
  primaryKey: true,
  foreignKeys: true,
  tableComment: true,
  columnComments: true,
  renameTable: true,
  collations: false,
};

/** format_type() spellings as the short names people type, with the size kept in place. */
export function shortTypeName(formatted: string): string {
  const m =
    /^(character varying|character|bit varying|timestamp|time)(\(\d+\))?( with(?:out)? time zone)?(\[\])*$/.exec(
      formatted,
    );
  if (!m) return formatted;
  const base = m[1] as string;
  const size = m[2] ?? '';
  const tz = m[3] === ' with time zone';
  const arrays = formatted.match(/(\[\])+$/)?.[0] ?? '';
  const short =
    base === 'character varying'
      ? 'varchar'
      : base === 'character'
        ? 'char'
        : base === 'bit varying'
          ? 'varbit'
          : `${base}${tz ? 'tz' : ''}`;
  return `${short}${size}${arrays}`;
}

const RULES: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};
export const fkRule = (code: string): string => RULES[code] ?? 'NO ACTION';

export class PostgresDialect extends BaseDialect {
  describe(): DialectInfo {
    return {
      id: 'postgres',
      identifierQuote: '"',
      keywords: KEYWORDS,
      types: TYPES,
      pingSql: 'SELECT now()',
      filterOperators: [...BASIC_FILTER_OPERATORS, 'regexp', 'not regexp'],
      alter: ALTER,
    };
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Literals for a session with standard_conforming_strings on, which the driver sets. */
  quoteLiteral(v: Value): string {
    const str = (s: string): string => {
      if (s.includes('\0'))
        throw new DriverError('UNSUPPORTED', 'PostgreSQL text cannot hold a NUL character');
      return `'${escapeSingleQuotes(s)}'`;
    };
    switch (v.t) {
      case 'null':
        return 'NULL';
      case 'bool':
        return v.v ? 'TRUE' : 'FALSE';
      case 'int':
      case 'decimal':
        return v.v;
      case 'float':
        return Number.isFinite(v.v)
          ? String(v.v)
          : `'${Number.isNaN(v.v) ? 'NaN' : v.v > 0 ? 'Infinity' : '-Infinity'}'::float8`;
      case 'set':
        return str(v.v.join(','));
      case 'bit':
        return `B'${bitsToString(v)}'`;
      case 'bytes':
      case 'geometry':
      case 'unknown':
        return `'\\x${bytesToHex(v.v)}'::bytea`;
      default:
        return str(v.v);
    }
  }

  protected override paginate(sql: string, limit?: number, offset?: number): string {
    if (limit === undefined && offset === undefined) return sql;
    let out = `${sql} LIMIT ${limit === undefined ? 'ALL' : Math.max(0, Math.trunc(limit))}`;
    if (offset !== undefined && offset > 0) out += ` OFFSET ${Math.trunc(offset)}`;
    return out;
  }

  /**
   * Contains, starts with and ends with use ILIKE on the column as text: case-insensitive like
   * MySQL's default collations, and usable on numbers and dates, which plain LIKE refuses.
   */
  protected override filterToSql(f: Filter): string {
    const col = `${this.quoteIdentifier(f.column)}::text`;
    switch (f.op) {
      case 'contains':
        return `${col} ILIKE ${this.likePattern(f, '%', '%')}`;
      case 'not contains':
        return `${col} NOT ILIKE ${this.likePattern(f, '%', '%')}`;
      case 'starts with':
        return `${col} ILIKE ${this.likePattern(f, '', '%')}`;
      case 'ends with':
        return `${col} ILIKE ${this.likePattern(f, '%', '')}`;
      case 'regexp':
      case 'not regexp': {
        if (f.value === undefined || Array.isArray(f.value))
          throw new DriverError('UNSUPPORTED', `Filter ${f.op} on ${f.column} needs one value`);
        return `${col} ${f.op === 'regexp' ? '~*' : '!~*'} ${this.quoteLiteral(f.value)}`;
      }
      default:
        return super.filterToSql(f);
    }
  }

  columnSql(c: ColumnDefinition): string {
    const q = this.quoteIdentifier.bind(this);
    let sql = `${q(c.name)} ${c.nativeType}`;
    if (c.collation) sql += ` COLLATE ${q(c.collation)}`;
    if (c.generated) sql += ` GENERATED ALWAYS AS (${c.generated.expression}) STORED`;
    else if (c.autoIncrement) sql += ' GENERATED BY DEFAULT AS IDENTITY';
    if (!c.nullable) sql += ' NOT NULL';
    if (c.default !== undefined && !c.generated && !c.autoIncrement)
      sql += ` DEFAULT ${this.defaultSql(c.default)}`;
    return sql;
  }

  private defaultSql(d: NonNullable<ColumnDefinition['default']>): string {
    return d.t === 'expression' ? d.sql : this.quoteLiteral(d);
  }

  private indexColumns(ix: IndexDefinition): string {
    return ix.columns
      .map((c) => {
        if (c.length !== undefined)
          throw new DriverError('UNSUPPORTED', 'PostgreSQL indexes have no prefix lengths');
        const target = c.expression ? `(${c.expression})` : this.quoteIdentifier(c.name ?? '');
        return `${target}${c.order === 'desc' ? ' DESC' : ''}`;
      })
      .join(', ');
  }

  private foreignKeySql(fk: ForeignKeyDefinition, schema: string): string {
    const q = this.quoteIdentifier.bind(this);
    const cols = (list: string[]): string => list.map(q).join(', ');
    let sql = `CONSTRAINT ${q(fk.name)} FOREIGN KEY (${cols(fk.columns)}) REFERENCES ${q(fk.referencedSchema ?? schema)}.${q(fk.referencedTable)} (${cols(fk.referencedColumns)})`;
    if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
    if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
    return sql;
  }

  /**
   * PostgreSQL alters inside a transaction, so the statements are free to come in the order
   * that keeps every name valid: renames first, then one ALTER TABLE with the drops before the
   * additions, then indexes, identities and comments, and the table rename last.
   */
  override buildAlter(table: TableDefinition, changes: StructureChange[]): string[] {
    const q = this.quoteIdentifier.bind(this);
    const schema = table.schema;
    const name = `${q(schema)}.${q(table.name)}`;
    const dropIndexes: string[] = [];
    const renames: string[] = [];
    const drops: string[] = [];
    const actions: string[] = [];
    const additions: string[] = [];
    const after: string[] = [];
    const comments: string[] = [];
    let renameTable: string | null = null;
    const comment = (target: string, text: string | undefined): string =>
      `COMMENT ON ${target} IS ${text ? this.quoteLiteral({ t: 'text', v: text }) : 'NULL'}`;
    const noMove = (after: string | null | undefined): void => {
      if (after !== undefined)
        throw new DriverError('UNSUPPORTED', 'PostgreSQL cannot move columns');
    };

    for (const c of changes) {
      switch (c.kind) {
        case 'addColumn':
          noMove(c.after);
          additions.push(`ADD COLUMN ${this.columnSql(c.column)}`);
          if (c.column.comment)
            comments.push(comment(`COLUMN ${name}.${q(c.column.name)}`, c.column.comment));
          break;
        case 'dropColumn':
          drops.push(`DROP COLUMN ${q(c.name)}`);
          break;
        case 'renameColumn':
          renames.push(`ALTER TABLE ${name} RENAME COLUMN ${q(c.from)} TO ${q(c.to)}`);
          break;
        case 'modifyColumn': {
          noMove(c.after);
          const before = table.columns.find((x) => x.name === c.name);
          if (!before) throw new DriverError('UNSUPPORTED', `No column named ${c.name}`);
          const col = c.column;
          const target = q(col.name);
          if (col.name !== c.name)
            renames.push(`ALTER TABLE ${name} RENAME COLUMN ${q(c.name)} TO ${target}`);
          if (col.nativeType.toLowerCase() !== before.nativeType.toLowerCase())
            actions.push(
              `ALTER COLUMN ${target} TYPE ${col.nativeType} USING ${target}::${col.nativeType}`,
            );
          if (col.nullable !== before.nullable)
            actions.push(`ALTER COLUMN ${target} ${col.nullable ? 'DROP' : 'SET'} NOT NULL`);
          const was = before.default === undefined ? null : this.defaultSql(before.default);
          const now =
            col.default === undefined || col.autoIncrement ? null : this.defaultSql(col.default);
          if (was !== now && !(before.autoIncrement && col.autoIncrement))
            actions.push(
              now === null
                ? `ALTER COLUMN ${target} DROP DEFAULT`
                : `ALTER COLUMN ${target} SET DEFAULT ${now}`,
            );
          if (col.autoIncrement && !before.autoIncrement)
            after.push(
              `ALTER TABLE ${name} ALTER COLUMN ${target} ADD GENERATED BY DEFAULT AS IDENTITY`,
            );
          if (!col.autoIncrement && before.autoIncrement)
            after.push(`ALTER TABLE ${name} ALTER COLUMN ${target} DROP IDENTITY IF EXISTS`);
          if ((col.comment ?? '') !== (before.comment ?? ''))
            comments.push(comment(`COLUMN ${name}.${target}`, col.comment));
          break;
        }
        case 'addIndex': {
          const ix = c.index;
          if ((ix.type ?? '').toUpperCase() === 'FULLTEXT')
            throw new DriverError(
              'UNSUPPORTED',
              'PostgreSQL has no FULLTEXT indexes; use a GIN index on to_tsvector(...)',
            );
          if (ix.primary) additions.push(`ADD PRIMARY KEY (${this.indexColumns(ix)})`);
          else
            after.push(
              `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${name} (${this.indexColumns(ix)})${ix.where ? ` WHERE ${ix.where}` : ''}`,
            );
          break;
        }
        case 'dropIndex': {
          const ix = table.indexes.find((x) => x.name === c.name);
          if (ix?.primary || ix?.constraint) drops.unshift(`DROP CONSTRAINT ${q(c.name)}`);
          else dropIndexes.push(`DROP INDEX ${q(schema)}.${q(c.name)}`);
          break;
        }
        case 'addForeignKey':
          additions.push(`ADD ${this.foreignKeySql(c.foreignKey, schema)}`);
          break;
        case 'dropForeignKey':
          drops.unshift(`DROP CONSTRAINT ${q(c.name)}`);
          break;
        case 'setComment':
          comments.push(comment(`TABLE ${name}`, c.comment));
          break;
        case 'renameTable':
          renameTable = `ALTER TABLE ${name} RENAME TO ${q(c.to)}`;
          break;
        case 'setOption':
          throw new DriverError('UNSUPPORTED', `PostgreSQL has no table option ${c.name}`);
      }
    }
    const out = [...dropIndexes, ...renames];
    const clauses = [...drops, ...actions, ...additions];
    if (clauses.length) out.push(`ALTER TABLE ${name}\n  ${clauses.join(',\n  ')}`);
    out.push(...after, ...comments);
    if (renameTable) out.push(renameTable);
    return out;
  }
}
