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
import { BaseDialect, formatLiteral } from '@rasql/driver-sdk';

const KEYWORDS = (
  'ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL ' +
  'CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS ' +
  'CUBE CUME_DIST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR ' +
  'DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT DELAYED DELETE DENSE_RANK DESC DESCRIBE ' +
  'DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE ELSEIF EMPTY ENCLOSED ESCAPED EXCEPT EXISTS ' +
  'EXIT EXPLAIN FALSE FETCH FIRST_VALUE FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED ' +
  'GET GRANT GROUP GROUPING GROUPS HAVING HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN ' +
  'INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INT1 INT2 INT3 INT4 INT8 INTEGER INTERSECT INTERVAL INTO ' +
  'IO_AFTER_GTIDS IO_BEFORE_GTIDS IS ITERATE JOIN JSON_TABLE KEY KEYS KILL LAG LAST_VALUE LATERAL LEAD LEADING ' +
  'LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP ' +
  'LOW_PRIORITY MASTER_BIND MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT ' +
  'MIDDLEINT MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE NULL ' +
  'NUMERIC OF ON OPTIMIZE OPTIMIZER_COSTS OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION ' +
  'PERCENT_RANK PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS READ_WRITE REAL RECURSIVE REFERENCES ' +
  'REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN REVOKE RIGHT RLIKE ROW ROWS ' +
  'ROW_NUMBER SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL SMALLINT SPATIAL ' +
  'SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL ' +
  'STARTING STORED STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO TRAILING TRIGGER ' +
  'TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES ' +
  'VARBINARY VARCHAR VARCHARACTER VARYING VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR YEAR_MONTH ZEROFILL'
).split(' ');

const INT = { category: 'integer', hasLength: true, unsignedAllowed: true } as const;
const TYPES: TypeDescriptor[] = [
  {
    name: 'TINYINT',
    ...INT,
    description: '−128 to 127, or 0 to 255 unsigned. Flags and tiny counts.',
  },
  { name: 'SMALLINT', ...INT, description: '−32,768 to 32,767, or 0 to 65,535 unsigned.' },
  { name: 'MEDIUMINT', ...INT, description: 'About ±8 million, or 0 to 16 million unsigned.' },
  {
    name: 'INT',
    ...INT,
    description: 'About ±2.1 billion, or 0 to 4.2 billion unsigned. The usual choice.',
  },
  {
    name: 'BIGINT',
    ...INT,
    description: 'About ±9.2 quintillion. WordPress uses BIGINT UNSIGNED for ids.',
  },
  {
    name: 'DECIMAL',
    category: 'decimal',
    hasPrecision: true,
    hasScale: true,
    unsignedAllowed: true,
    description: 'Exact numbers with a fixed number of decimals. Use it for money.',
  },
  {
    name: 'FLOAT',
    category: 'float',
    unsignedAllowed: true,
    description: 'Approximate, about 7 digits.',
  },
  {
    name: 'DOUBLE',
    category: 'float',
    unsignedAllowed: true,
    description: 'Approximate, about 15 digits.',
  },
  { name: 'BIT', category: 'bit', hasLength: true, description: 'A row of 1 to 64 bits.' },
  { name: 'BOOLEAN', category: 'boolean', description: 'True or false; stored as TINYINT(1).' },
  {
    name: 'CHAR',
    category: 'text',
    hasLength: true,
    description: 'Fixed length, padded. Codes like country or currency.',
  },
  {
    name: 'VARCHAR',
    category: 'text',
    hasLength: true,
    description: 'Up to the given length. Names, titles, slugs, emails.',
  },
  { name: 'TINYTEXT', category: 'text', description: 'Up to 255 bytes.' },
  { name: 'TEXT', category: 'text', description: 'Up to 64 KB.' },
  { name: 'MEDIUMTEXT', category: 'text', description: 'Up to 16 MB.' },
  {
    name: 'LONGTEXT',
    category: 'text',
    description: 'Up to 4 GB. WordPress post content and options.',
  },
  {
    name: 'BINARY',
    category: 'binary',
    hasLength: true,
    description: 'Fixed number of raw bytes, such as a hash.',
  },
  {
    name: 'VARBINARY',
    category: 'binary',
    hasLength: true,
    description: 'Up to the given number of raw bytes.',
  },
  { name: 'TINYBLOB', category: 'binary', description: 'Raw bytes, up to 255.' },
  { name: 'BLOB', category: 'binary', description: 'Raw bytes, up to 64 KB.' },
  { name: 'MEDIUMBLOB', category: 'binary', description: 'Raw bytes, up to 16 MB.' },
  { name: 'LONGBLOB', category: 'binary', description: 'Raw bytes, up to 4 GB.' },
  { name: 'DATE', category: 'date', description: 'A day: 2026-10-10.' },
  {
    name: 'TIME',
    category: 'time',
    hasPrecision: true,
    description: 'A time of day or a duration.',
  },
  {
    name: 'DATETIME',
    category: 'datetime',
    hasPrecision: true,
    description: 'Date and time as written, no time zone.',
  },
  {
    name: 'TIMESTAMP',
    category: 'datetime',
    hasPrecision: true,
    description: 'Date and time stored in UTC, 1970 to 2038.',
  },
  { name: 'YEAR', category: 'integer', description: 'A year, 1901 to 2155.' },
  {
    name: 'ENUM',
    category: 'enum',
    hasValues: true,
    description: 'Exactly one of a fixed list of values.',
  },
  {
    name: 'SET',
    category: 'set',
    hasValues: true,
    description: 'Any combination of a fixed list of values.',
  },
  { name: 'JSON', category: 'json', description: 'A JSON document, checked on write.' },
  { name: 'GEOMETRY', category: 'spatial', description: 'Any shape.' },
  { name: 'POINT', category: 'spatial', description: 'One location.' },
  { name: 'LINESTRING', category: 'spatial' },
  { name: 'POLYGON', category: 'spatial' },
  { name: 'MULTIPOINT', category: 'spatial' },
  { name: 'MULTILINESTRING', category: 'spatial' },
  { name: 'MULTIPOLYGON', category: 'spatial' },
  { name: 'GEOMETRYCOLLECTION', category: 'spatial' },
];

const ALTER: AlterCapabilities = {
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  modifyColumn: true,
  moveColumn: true,
  indexes: true,
  primaryKey: true,
  foreignKeys: true,
  tableComment: true,
  columnComments: true,
  renameTable: true,
  collations: true,
};

/** A charset or collation name: letters, digits and underscores only. */
function word(name: string): string {
  if (!/^\w+$/.test(name)) throw new DriverError('UNSUPPORTED', `Invalid name ${name}`);
  return name;
}

function rule(r: string): string {
  const up = r.toUpperCase().replace(/_/g, ' ').trim();
  if (!['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'].includes(up))
    throw new DriverError('UNSUPPORTED', `Unknown referential action ${r}`);
  return up;
}

export class MysqlDialect extends BaseDialect {
  describe(): DialectInfo {
    return {
      id: 'mysql',
      identifierQuote: '`',
      keywords: KEYWORDS,
      types: TYPES,
      pingSql: 'SELECT 1',
      filterOperators: [...BASIC_FILTER_OPERATORS, 'regexp', 'not regexp', 'has member'],
      alter: ALTER,
    };
  }

  /**
   * One ALTER TABLE with every change, so the server applies all or none of them. Clauses run in
   * a safe order: foreign keys and indexes go before the columns they use, and come back after.
   */
  override buildAlter(table: TableDefinition, changes: StructureChange[]): string[] {
    const q = this.quoteIdentifier.bind(this);
    const byName = new Map(table.columns.map((c) => [c.name, c]));
    const order: Record<StructureChange['kind'], number> = {
      dropForeignKey: 0,
      dropIndex: 1,
      dropColumn: 2,
      modifyColumn: 3,
      renameColumn: 3,
      addColumn: 4,
      addIndex: 5,
      addForeignKey: 6,
      setComment: 7,
      setOption: 8,
      renameTable: 9,
    };
    const sorted = changes
      .map((c, i) => ({ c, i }))
      .sort((a, b) => order[a.c.kind] - order[b.c.kind] || a.i - b.i)
      .map((x) => x.c);
    const position = (after: string | null | undefined): string =>
      after === undefined ? '' : after === null ? ' FIRST' : ` AFTER ${q(after)}`;
    const clauses = sorted.map((c): string => {
      switch (c.kind) {
        case 'addColumn':
          return `ADD COLUMN ${this.columnSql(c.column)}${position(c.after)}`;
        case 'dropColumn':
          return `DROP COLUMN ${q(c.name)}`;
        case 'modifyColumn':
          return c.column.name === c.name
            ? `MODIFY COLUMN ${this.columnSql(c.column)}${position(c.after)}`
            : `CHANGE COLUMN ${q(c.name)} ${this.columnSql(c.column)}${position(c.after)}`;
        case 'renameColumn': {
          // CHANGE works on every version; RENAME COLUMN needs MySQL 8 or MariaDB 10.5.
          const col = byName.get(c.from);
          if (!col) throw new DriverError('UNSUPPORTED', `No column named ${c.from}`);
          return `CHANGE COLUMN ${q(c.from)} ${this.columnSql({ ...col, name: c.to })}`;
        }
        case 'addIndex':
          return `ADD ${this.indexSql(c.index)}`;
        case 'dropIndex':
          return c.name === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(c.name)}`;
        case 'addForeignKey':
          return `ADD ${this.foreignKeySql(c.foreignKey, table.schema)}`;
        case 'dropForeignKey':
          return `DROP FOREIGN KEY ${q(c.name)}`;
        case 'setComment':
          return `COMMENT = ${this.quoteLiteral({ t: 'text', v: c.comment })}`;
        case 'setOption': {
          const name = c.name.toUpperCase().replace(/_/g, ' ');
          if (!/^(ENGINE|ROW FORMAT|AUTO INCREMENT|DEFAULT CHARSET|CHARSET|COLLATE)$/.test(name))
            throw new DriverError('UNSUPPORTED', `Unknown table option ${c.name}`);
          if (!/^[\w]+$/.test(c.value))
            throw new DriverError('UNSUPPORTED', `Invalid value for ${c.name}: ${c.value}`);
          return `${name.replace(/ /g, '_').replace('DEFAULT_CHARSET', 'DEFAULT CHARSET')} = ${c.value}`;
        }
        case 'renameTable':
          return `RENAME TO ${table.schema ? `${q(table.schema)}.` : ''}${q(c.to)}`;
      }
    });
    if (!clauses.length) return [];
    const name = `${table.schema ? `${q(table.schema)}.` : ''}${q(table.name)}`;
    return [`ALTER TABLE ${name}\n  ${clauses.join(',\n  ')}`];
  }

  /** The column as it appears in CREATE TABLE or ALTER TABLE: name, type and attributes. */
  columnSql(c: ColumnDefinition): string {
    let sql = `${this.quoteIdentifier(c.name)} ${c.nativeType}`;
    // Without them MODIFY falls back to the table's charset, which may not be the column's.
    if (c.collation && /char|text|enum|set/i.test(c.nativeType)) {
      if (c.charset) sql += ` CHARACTER SET ${word(c.charset)}`;
      sql += ` COLLATE ${word(c.collation)}`;
    }
    if (c.generated) {
      sql += ` GENERATED ALWAYS AS (${c.generated.expression}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
      if (!c.nullable) sql += ' NOT NULL';
    } else {
      sql += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.default !== undefined) sql += ` DEFAULT ${this.defaultSql(c.default)}`;
      if (c.autoIncrement) sql += ' AUTO_INCREMENT';
      const onUpdate = /on update (current_timestamp(\(\d*\))?)/i.exec(c.extra ?? '');
      if (onUpdate) sql += ` ON UPDATE ${(onUpdate[1] as string).toUpperCase()}`;
    }
    if (c.comment) sql += ` COMMENT ${this.quoteLiteral({ t: 'text', v: c.comment })}`;
    return sql;
  }

  private defaultSql(d: NonNullable<ColumnDefinition['default']>): string {
    if (d.t !== 'expression') return this.quoteLiteral(d);
    const sql = d.sql.trim();
    // Keywords and literals stand alone; anything else is an expression default (MySQL 8.0.13+,
    // MariaDB 10.2+), which needs parentheses.
    if (
      /^(current_timestamp|now|localtime|localtimestamp)(\(\d*\))?$/i.test(sql) ||
      /^(null|true|false|-?\d+(\.\d+)?|b'[01]*'|0x[0-9a-f]+|'(?:[^']|'')*')$/i.test(sql) ||
      /^\(.*\)$/s.test(sql)
    )
      return sql;
    return `(${sql})`;
  }

  private indexSql(ix: IndexDefinition): string {
    const q = this.quoteIdentifier.bind(this);
    const cols = ix.columns
      .map((c) => {
        const base = c.expression ? `(${c.expression})` : q(c.name ?? '');
        return `${base}${c.length ? `(${Math.trunc(c.length)})` : ''}${c.order === 'desc' ? ' DESC' : ''}`;
      })
      .join(', ');
    if (!ix.columns.length)
      throw new DriverError('UNSUPPORTED', 'An index needs at least one column');
    if (ix.primary) return `PRIMARY KEY (${cols})`;
    const type = (ix.type ?? '').toUpperCase();
    const kind =
      type === 'FULLTEXT'
        ? 'FULLTEXT INDEX'
        : type === 'SPATIAL'
          ? 'SPATIAL INDEX'
          : ix.unique
            ? 'UNIQUE INDEX'
            : 'INDEX';
    const comment = ix.comment ? ` COMMENT ${this.quoteLiteral({ t: 'text', v: ix.comment })}` : '';
    return `${kind}${ix.name ? ` ${q(ix.name)}` : ''} (${cols})${comment}`;
  }

  private foreignKeySql(fk: ForeignKeyDefinition, schema: string): string {
    const q = this.quoteIdentifier.bind(this);
    if (!fk.columns.length || fk.columns.length !== fk.referencedColumns.length)
      throw new DriverError('UNSUPPORTED', 'A foreign key needs matching column lists');
    const target = `${fk.referencedSchema && fk.referencedSchema !== schema ? `${q(fk.referencedSchema)}.` : ''}${q(fk.referencedTable)}`;
    let sql = `${fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''}FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${target} (${fk.referencedColumns.map(q).join(', ')})`;
    if (fk.onDelete) sql += ` ON DELETE ${rule(fk.onDelete)}`;
    if (fk.onUpdate) sql += ` ON UPDATE ${rule(fk.onUpdate)}`;
    return sql;
  }

  protected override filterToSql(f: Filter): string {
    if (f.op !== 'regexp' && f.op !== 'not regexp' && f.op !== 'has member')
      return super.filterToSql(f);
    if (f.value === undefined || Array.isArray(f.value))
      throw new DriverError('UNSUPPORTED', `Filter ${f.op} on ${f.column} needs one value`);
    const col = this.quoteIdentifier(f.column);
    const value = this.quoteLiteral(f.value);
    if (f.op === 'has member') return `FIND_IN_SET(${value}, ${col}) > 0`;
    return `${col} ${f.op === 'regexp' ? 'REGEXP' : 'NOT REGEXP'} ${value}`;
  }

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  quoteLiteral(v: Value): string {
    if (v.t === 'geometry') {
      const hex = Array.from(v.v, (x) => x.toString(16).padStart(2, '0')).join('');
      return `ST_GeomFromWKB(X'${hex}'${v.srid === undefined ? '' : `, ${v.srid}`})`;
    }
    return formatLiteral(v, { hex: 'x-quote', booleans: 'numeric', escapeBackslashes: true });
  }
}
