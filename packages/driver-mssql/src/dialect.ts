import {
  BASIC_FILTER_OPERATORS,
  DriverError,
  V,
  type AlterCapabilities,
  type ColumnDefinition,
  type DialectInfo,
  type IndexDefinition,
  type SelectOptions,
  type StatementClass,
  type StructureChange,
  type TableDefinition,
  type TableRef,
  type TypeDescriptor,
  type Value,
} from '@rasql/driver-protocol';
import { BaseDialect, bytesToHex, classifyStatement, escapeSingleQuotes } from '@rasql/driver-sdk';

const KEYWORDS = (
  'ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE CASE ' +
  'CHECK CHECKPOINT CLOSE CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTINUE ' +
  'CONVERT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE ' +
  'DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISTINCT DROP ELSE END ERRLVL ESCAPE EXCEPT EXEC ' +
  'EXECUTE EXISTS EXIT FETCH FILE FOR FOREIGN FROM FULL FUNCTION GO GOTO GRANT GROUP HAVING HOLDLOCK ' +
  'IDENTITY IDENTITY_INSERT IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE MERGE ' +
  'NOCHECK NONCLUSTERED NOT NULL NULLIF OF OFF OFFSET ON OPEN OPTION OR ORDER OUTER OUTPUT OVER PERCENT ' +
  'PIVOT PRIMARY PRINT PROC PROCEDURE RAISERROR READ RECONFIGURE REFERENCES RETURN REVOKE RIGHT ROLLBACK ' +
  'ROWCOUNT ROWS SCHEMA SELECT SET SOME TABLE TOP TRAN TRANSACTION TRIGGER TRUNCATE TRY UNION UNIQUE ' +
  'UNPIVOT UPDATE USE VALUES VIEW WAITFOR WHEN WHERE WHILE WITH'
).split(' ');

const TYPES: TypeDescriptor[] = [
  { name: 'INT', category: 'integer', description: 'Whole numbers up to about 2 billion.' },
  { name: 'BIGINT', category: 'integer', description: 'Whole numbers up to about 9 quintillion.' },
  { name: 'SMALLINT', category: 'integer', description: 'Whole numbers from -32768 to 32767.' },
  { name: 'TINYINT', category: 'integer', description: 'Whole numbers from 0 to 255.' },
  {
    name: 'DECIMAL',
    category: 'decimal',
    hasPrecision: true,
    hasScale: true,
    description: 'Exact numbers with a fixed number of decimals; use for money.',
  },
  {
    name: 'NUMERIC',
    category: 'decimal',
    hasPrecision: true,
    hasScale: true,
    description: 'The same as DECIMAL.',
  },
  { name: 'MONEY', category: 'decimal', description: 'Amounts with 4 decimals.' },
  { name: 'FLOAT', category: 'float', description: 'Approximate numbers, about 15 digits.' },
  { name: 'REAL', category: 'float', description: 'Approximate numbers, about 7 digits.' },
  {
    name: 'NVARCHAR',
    category: 'text',
    hasLength: true,
    description: 'Unicode text up to a length (at most 4000), or MAX.',
  },
  {
    name: 'VARCHAR',
    category: 'text',
    hasLength: true,
    description: 'Text in the column collation’s code page, up to a length (at most 8000), or MAX.',
  },
  {
    name: 'NCHAR',
    category: 'text',
    hasLength: true,
    description: 'Unicode text padded to a fixed length.',
  },
  {
    name: 'CHAR',
    category: 'text',
    hasLength: true,
    description: 'Text padded to a fixed length.',
  },
  { name: 'UNIQUEIDENTIFIER', category: 'text', description: 'A GUID, such as 6F9619FF-8B86-…' },
  { name: 'XML', category: 'text', description: 'An XML document or fragment.' },
  {
    name: 'DATETIME2',
    category: 'datetime',
    hasPrecision: true,
    description: 'Date and time, to 100 nanoseconds.',
  },
  {
    name: 'DATETIME',
    category: 'datetime',
    description: 'Date and time, to about 3 milliseconds.',
  },
  {
    name: 'DATETIMEOFFSET',
    category: 'datetime',
    hasPrecision: true,
    description: 'Date and time with a time zone offset.',
  },
  { name: 'SMALLDATETIME', category: 'datetime', description: 'Date and time, to the minute.' },
  { name: 'DATE', category: 'date', description: 'A calendar date.' },
  { name: 'TIME', category: 'time', hasPrecision: true, description: 'A time of day.' },
  { name: 'BIT', category: 'boolean', description: '1 or 0; SQL Server’s yes or no.' },
  {
    name: 'VARBINARY',
    category: 'binary',
    hasLength: true,
    description: 'Bytes up to a length, or MAX.',
  },
  { name: 'BINARY', category: 'binary', hasLength: true, description: 'A fixed number of bytes.' },
  {
    name: 'GEOGRAPHY',
    category: 'spatial',
    description: 'Shapes on the earth, in latitude and longitude.',
  },
  { name: 'GEOMETRY', category: 'spatial', description: 'Shapes on a flat plane.' },
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

/** SQL Server allows at most 1000 rows in one VALUES list. */
const MAX_VALUES_ROWS = 1000;

/** RESTRICT is spelled NO ACTION here. */
const rule = (r: string | undefined): string | undefined => {
  if (!r) return undefined;
  const up = r.toUpperCase().replace(/_/g, ' ');
  return up === 'RESTRICT' ? 'NO ACTION' : up;
};

export class MssqlDialect extends BaseDialect {
  protected override likeSpecials = /[!%_[]/g;

  describe(): DialectInfo {
    return {
      id: 'mssql',
      identifierQuote: '[',
      keywords: KEYWORDS,
      types: TYPES,
      pingSql: 'SELECT SYSDATETIME()',
      filterOperators: [...BASIC_FILTER_OPERATORS],
      alter: ALTER,
    };
  }

  quoteIdentifier(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  /** Text is always N'…', so nothing outside the code page of the database is lost. */
  quoteLiteral(v: Value): string {
    const str = (s: string, unicode = true): string => {
      const parts = s.split('\0').map((p) => `${unicode ? 'N' : ''}'${escapeSingleQuotes(p)}'`);
      return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' + NCHAR(0) + ')})`;
    };
    switch (v.t) {
      case 'null':
        return 'NULL';
      case 'bool':
        return v.v ? '1' : '0';
      case 'int':
      case 'decimal':
        return v.v;
      case 'float':
        if (!Number.isFinite(v.v))
          throw new DriverError('UNSUPPORTED', `SQL Server has no ${v.v} for FLOAT`);
        return String(v.v);
      case 'date':
      case 'time':
      case 'datetime':
        return str(v.v, false);
      case 'set':
        return str(v.v.join(','));
      case 'bit': {
        let n = 0n;
        for (const b of v.v) n = (n << 8n) | BigInt(b);
        return String(n & ((1n << BigInt(v.bits)) - 1n));
      }
      case 'bytes':
      case 'geometry':
      case 'unknown':
        return `0x${bytesToHex(v.v)}`;
      default:
        return str(v.v);
    }
  }

  /**
   * TOP for a first page, OFFSET … FETCH for the others. OFFSET needs an ORDER BY; without
   * one, ORDER BY (SELECT NULL) keeps the engine's own order.
   */
  override buildSelect(table: TableRef, opts: SelectOptions): string {
    const cols = opts.columns?.length
      ? opts.columns.map((c) => this.quoteIdentifier(c)).join(', ')
      : '*';
    const limit = opts.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
    const offset = opts.offset ? Math.max(0, Math.trunc(opts.offset)) : 0;
    const top = limit !== undefined && offset === 0 ? `TOP (${limit}) ` : '';
    let sql = `SELECT ${top}${cols} FROM ${this.qualify(table)}${this.whereClause(opts.where, opts.whereSql)}`;
    const order = opts.orderBy?.length
      ? opts.orderBy
          .map((o) => `${this.quoteIdentifier(o.column)} ${o.direction.toUpperCase()}`)
          .join(', ')
      : null;
    if (order) sql += ` ORDER BY ${order}`;
    if (offset > 0) {
      if (!order) sql += ' ORDER BY (SELECT NULL)';
      sql += ` OFFSET ${offset} ROWS`;
      if (limit !== undefined) sql += ` FETCH NEXT ${limit} ROWS ONLY`;
    }
    return sql;
  }

  override buildInsertMany(table: TableRef, columns: string[], rows: Value[][]): string {
    if (rows.length <= MAX_VALUES_ROWS) return super.buildInsertMany(table, columns, rows);
    const out: string[] = [];
    for (let i = 0; i < rows.length; i += MAX_VALUES_ROWS)
      out.push(super.buildInsertMany(table, columns, rows.slice(i, i + MAX_VALUES_ROWS)));
    return out.join(';\n');
  }

  override classify(sql: string): StatementClass {
    const kw = /^\s*([a-z]+)/i.exec(sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, ''))?.[1];
    switch (kw?.toLowerCase()) {
      case 'exec':
      case 'execute':
      case 'declare':
        return 'unknown';
      case 'print':
        return 'read';
      case 'dbcc':
      case 'backup':
      case 'restore':
      case 'deny':
        return 'admin';
      default:
        return classifyStatement(sql);
    }
  }

  private literalOrExpression(d: NonNullable<ColumnDefinition['default']>): string {
    return d.t === 'expression' ? d.sql : this.quoteLiteral(d);
  }

  columnSql(c: ColumnDefinition, table: string): string {
    const q = this.quoteIdentifier.bind(this);
    if (c.generated)
      return `${q(c.name)} AS (${c.generated.expression})${c.generated.stored ? ' PERSISTED' : ''}`;
    let sql = `${q(c.name)} ${c.nativeType}`;
    if (c.collation) sql += ` COLLATE ${c.collation}`;
    if (c.autoIncrement) sql += ' IDENTITY(1,1)';
    sql += c.nullable ? ' NULL' : ' NOT NULL';
    if (c.default !== undefined && !c.autoIncrement)
      sql += ` CONSTRAINT ${q(defaultName(table, c.name))} DEFAULT ${this.literalOrExpression(c.default)}`;
    return sql;
  }

  private indexColumns(ix: IndexDefinition): string {
    return ix.columns
      .map((c) => {
        if (c.expression || c.length !== undefined)
          throw new DriverError(
            'UNSUPPORTED',
            'SQL Server indexes columns, not expressions or prefixes; index a computed column instead',
          );
        return `${this.quoteIdentifier(c.name ?? '')}${c.order === 'desc' ? ' DESC' : ''}`;
      })
      .join(', ');
  }

  /**
   * SQL Server names every default as a constraint, which must go before its column can be
   * dropped or retyped. The name is looked up when the statement runs.
   */
  private dropDefault(name: string, column: string): string {
    const lit = (s: string): string => this.quoteLiteral(V.text(s));
    return (
      `DECLARE @df sysname = (SELECT dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID(${lit(name)}) AND c.name = ${lit(column)});\n` +
      `IF @df IS NOT NULL BEGIN DECLARE @drop nvarchar(max) = N'ALTER TABLE ${name.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(@df); EXEC (@drop) END`
    );
  }

  /** MS_Description, the extended property SQL Server Management Studio shows as a comment. */
  private description(
    schema: string,
    table: string,
    column: string | null,
    text: string | undefined,
  ): string {
    const lit = (s: string): string => this.quoteLiteral(V.text(s));
    const target = `N'SCHEMA', ${lit(schema)}, N'TABLE', ${lit(table)}${column === null ? '' : `, N'COLUMN', ${lit(column)}`}`;
    const exists = `EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 1 AND name = N'MS_Description' AND major_id = OBJECT_ID(${lit(`${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`)}) AND minor_id = ${column === null ? '0' : `COLUMNPROPERTY(major_id, ${lit(column)}, 'ColumnId')`})`;
    if (!text) return `IF ${exists} EXEC sys.sp_dropextendedproperty N'MS_Description', ${target}`;
    return (
      `IF ${exists} EXEC sys.sp_updateextendedproperty N'MS_Description', ${lit(text)}, ${target}\n` +
      `ELSE EXEC sys.sp_addextendedproperty N'MS_Description', ${lit(text)}, ${target}`
    );
  }

  /**
   * One statement per change, in an order that keeps names valid: constraints and indexes go
   * first, then dropped columns, renames, changed columns, new columns, new keys and indexes,
   * comments, and the table rename last. The host runs them in one transaction.
   */
  override buildAlter(table: TableDefinition, changes: StructureChange[]): string[] {
    const q = this.quoteIdentifier.bind(this);
    const lit = (s: string): string => this.quoteLiteral(V.text(s));
    const schema = table.schema;
    const name = `${q(schema)}.${q(table.name)}`;
    const drops: string[] = [];
    const columnDrops: string[] = [];
    const renames: string[] = [];
    const modifies: string[] = [];
    const adds: string[] = [];
    const keys: string[] = [];
    const comments: string[] = [];
    let renameTable: string | null = null;
    const noMove = (after: string | null | undefined): void => {
      if (after !== undefined)
        throw new DriverError('UNSUPPORTED', 'SQL Server cannot move columns');
    };

    for (const c of changes) {
      switch (c.kind) {
        case 'addColumn':
          noMove(c.after);
          adds.push(`ALTER TABLE ${name} ADD ${this.columnSql(c.column, table.name)}`);
          if (c.column.comment)
            comments.push(this.description(schema, table.name, c.column.name, c.column.comment));
          break;
        case 'dropColumn':
          columnDrops.push(
            this.dropDefault(name, c.name),
            `ALTER TABLE ${name} DROP COLUMN ${q(c.name)}`,
          );
          break;
        case 'renameColumn':
          renames.push(`EXEC sp_rename ${lit(`${name}.${q(c.from)}`)}, ${lit(c.to)}, N'COLUMN'`);
          break;
        case 'modifyColumn': {
          noMove(c.after);
          const before = table.columns.find((x) => x.name === c.name);
          if (!before) throw new DriverError('UNSUPPORTED', `No column named ${c.name}`);
          const col = c.column;
          if (col.autoIncrement !== before.autoIncrement)
            throw new DriverError(
              'UNSUPPORTED',
              'SQL Server cannot add or remove IDENTITY on an existing column; add a new column instead',
            );
          if (col.name !== c.name)
            renames.push(
              `EXEC sp_rename ${lit(`${name}.${q(c.name)}`)}, ${lit(col.name)}, N'COLUMN'`,
            );
          const target = q(col.name);
          const typeChanged =
            col.nativeType.toLowerCase() !== before.nativeType.toLowerCase() ||
            col.nullable !== before.nullable;
          const was =
            before.default === undefined ? null : this.literalOrExpression(before.default);
          const now = col.default === undefined ? null : this.literalOrExpression(col.default);
          const defaultChanged = was !== now;
          // A default constraint blocks ALTER COLUMN; take it off and put it back afterwards.
          if (defaultChanged || (typeChanged && was !== null))
            modifies.push(this.dropDefault(name, col.name));
          if (typeChanged)
            modifies.push(
              `ALTER TABLE ${name} ALTER COLUMN ${target} ${col.nativeType}${col.collation ? ` COLLATE ${col.collation}` : ''} ${col.nullable ? 'NULL' : 'NOT NULL'}`,
            );
          if (now !== null && (defaultChanged || (typeChanged && was !== null)))
            modifies.push(
              `ALTER TABLE ${name} ADD CONSTRAINT ${q(defaultName(table.name, col.name))} DEFAULT ${now} FOR ${target}`,
            );
          if ((col.comment ?? '') !== (before.comment ?? ''))
            comments.push(this.description(schema, table.name, col.name, col.comment));
          break;
        }
        case 'addIndex': {
          const ix = c.index;
          if ((ix.type ?? '').toUpperCase() === 'FULLTEXT')
            throw new DriverError(
              'UNSUPPORTED',
              'Full-text indexes need a full-text catalog; create one with SQL',
            );
          if (ix.primary)
            keys.push(
              `ALTER TABLE ${name} ADD CONSTRAINT ${q(`PK_${table.name}`)} PRIMARY KEY (${this.indexColumns(ix)})`,
            );
          else
            keys.push(
              `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${name} (${this.indexColumns(ix)})${ix.where ? ` WHERE ${ix.where}` : ''}`,
            );
          break;
        }
        case 'dropIndex': {
          const ix = table.indexes.find((x) => x.name === c.name);
          drops.push(
            ix?.primary || ix?.constraint
              ? `ALTER TABLE ${name} DROP CONSTRAINT ${q(c.name)}`
              : `DROP INDEX ${q(c.name)} ON ${name}`,
          );
          break;
        }
        case 'addForeignKey': {
          const fk = c.foreignKey;
          const cols = (list: string[]): string => list.map(q).join(', ');
          let sql = `ALTER TABLE ${name} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${cols(fk.columns)}) REFERENCES ${q(fk.referencedSchema ?? schema)}.${q(fk.referencedTable)} (${cols(fk.referencedColumns)})`;
          const del = rule(fk.onDelete);
          const upd = rule(fk.onUpdate);
          if (del) sql += ` ON DELETE ${del}`;
          if (upd) sql += ` ON UPDATE ${upd}`;
          keys.push(sql);
          break;
        }
        case 'dropForeignKey':
          drops.unshift(`ALTER TABLE ${name} DROP CONSTRAINT ${q(c.name)}`);
          break;
        case 'setComment':
          comments.push(this.description(schema, table.name, null, c.comment));
          break;
        case 'renameTable':
          renameTable = `EXEC sp_rename ${lit(name)}, ${lit(c.to)}`;
          break;
        case 'setOption':
          throw new DriverError('UNSUPPORTED', `SQL Server has no table option ${c.name}`);
      }
    }
    const out = [...drops, ...columnDrops, ...renames, ...modifies, ...adds, ...keys, ...comments];
    if (renameTable) out.push(renameTable);
    return out;
  }
}

/** The name RaSQL gives a default constraint it creates. */
export const defaultName = (table: string, column: string): string => `DF_${table}_${column}`;
