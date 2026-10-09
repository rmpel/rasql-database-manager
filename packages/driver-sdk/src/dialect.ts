import type {
  CellChange,
  Dialect,
  DialectInfo,
  Filter,
  KeyMatch,
  SelectOptions,
  StatementClass,
  StructureChange,
  TableDefinition,
  TableRef,
  Value,
} from '@rasql/driver-protocol';
import { DriverError, V } from '@rasql/driver-protocol';

/** Remove -- line comments, # line comments and /* block comments *\/ outside of string literals. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const READ = new Set([
  'select',
  'show',
  'describe',
  'desc',
  'explain',
  'values',
  'table',
  'pragma',
]);
const WRITE = new Set(['insert', 'update', 'delete', 'replace', 'merge', 'load', 'upsert']);
const DDL = new Set(['create', 'alter', 'drop', 'rename', 'truncate', 'comment']);
const ADMIN = new Set([
  'grant',
  'revoke',
  'set',
  'use',
  'flush',
  'kill',
  'analyze',
  'analyse',
  'optimize',
  'check',
  'repair',
  'vacuum',
  'attach',
  'detach',
  'reindex',
  'lock',
  'unlock',
  'reset',
  'purge',
  'install',
  'uninstall',
  'call',
  'do',
  'handler',
]);
const TRANSACTION = new Set([
  'begin',
  'start',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'end',
  'xa',
]);

/** Classify a single statement by its leading keyword, with care for WITH ... and PRAGMA x = y. */
export function classifyStatement(sql: string): StatementClass {
  const clean = stripSqlComments(sql).trim().replace(/^\(+/, '');
  const m = /^([a-z]+)/i.exec(clean);
  if (!m) return 'unknown';
  const kw = (m[1] as string).toLowerCase();
  if (kw === 'with') {
    return /\b(insert|update|delete|merge|replace)\b/i.test(clean) ? 'write' : 'read';
  }
  if (kw === 'pragma') return /=/.test(clean) || /\(/.test(clean) ? 'admin' : 'read';
  if (kw === 'explain') return 'read';
  if (READ.has(kw)) return 'read';
  if (WRITE.has(kw)) return 'write';
  if (DDL.has(kw)) return 'ddl';
  if (ADMIN.has(kw)) return 'admin';
  if (TRANSACTION.has(kw)) return 'transaction';
  return 'unknown';
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "''");
}

export interface LiteralStyle {
  /** How to write binary: X'..' (SQLite, MySQL) or 0x.. (MSSQL, MySQL). */
  hex: 'x-quote' | '0x';
  /** TRUE/FALSE or 1/0. */
  booleans: 'keyword' | 'numeric';
  /** Backslash escapes inside strings must be doubled (MySQL default mode). */
  escapeBackslashes: boolean;
}

/** A reasonable literal printer. Drivers wrap it or replace it. */
export function formatLiteral(v: Value, style: LiteralStyle): string {
  const str = (s: string): string => {
    let out = escapeSingleQuotes(s);
    if (style.escapeBackslashes) out = out.replace(/\\/g, '\\\\');
    return `'${out}'`;
  };
  const hex = (b: Uint8Array): string =>
    style.hex === '0x' ? `0x${bytesToHex(b)}` : `X'${bytesToHex(b)}'`;
  switch (v.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      return style.booleans === 'keyword' ? (v.v ? 'TRUE' : 'FALSE') : v.v ? '1' : '0';
    case 'int':
    case 'decimal':
      return v.v;
    case 'float':
      if (!Number.isFinite(v.v))
        throw new DriverError('UNSUPPORTED', `Cannot write ${v.v} as a SQL literal`);
      return String(v.v);
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'json':
    case 'enum':
      return str(v.v);
    case 'set':
      return str(v.v.join(','));
    case 'bytes':
    case 'geometry':
    case 'unknown':
      return hex(v.v);
    case 'bit':
      return `b'${[...v.v]
        .map((b) => b.toString(2).padStart(8, '0'))
        .join('')
        .slice(-v.bits)}'`;
  }
}

/**
 * The generic parts of a Dialect. A driver supplies describe(), quoteIdentifier() and
 * quoteLiteral(), and overrides paginate() when its engine does not use LIMIT/OFFSET.
 */
export abstract class BaseDialect implements Dialect {
  abstract describe(): DialectInfo;
  abstract quoteIdentifier(name: string): string;
  abstract quoteLiteral(v: Value): string;

  protected qualify(table: TableRef): string {
    return table.schema
      ? `${this.quoteIdentifier(table.schema)}.${this.quoteIdentifier(table.name)}`
      : this.quoteIdentifier(table.name);
  }

  protected paginate(sql: string, limit?: number, offset?: number): string {
    if (limit === undefined && offset === undefined) return sql;
    let out = sql;
    if (limit !== undefined) out += ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
    if (offset !== undefined && offset > 0) {
      if (limit === undefined) out += ' LIMIT 18446744073709551615';
      out += ` OFFSET ${Math.trunc(offset)}`;
    }
    return out;
  }

  protected filterToSql(f: Filter): string {
    const col = this.quoteIdentifier(f.column);
    const one = (): string => {
      if (f.value === undefined || Array.isArray(f.value)) {
        throw new DriverError('UNSUPPORTED', `Filter ${f.op} on ${f.column} needs one value`);
      }
      return this.quoteLiteral(f.value);
    };
    const many = (): string[] => {
      if (!Array.isArray(f.value))
        throw new DriverError('UNSUPPORTED', `Filter ${f.op} on ${f.column} needs a list`);
      return f.value.map((v) => this.quoteLiteral(v));
    };
    switch (f.op) {
      case 'is null':
        return `${col} IS NULL`;
      case 'is not null':
        return `${col} IS NOT NULL`;
      case 'in':
        return `${col} IN (${many().join(', ')})`;
      case 'not in':
        return `${col} NOT IN (${many().join(', ')})`;
      case 'between': {
        const [a, b] = many();
        return `${col} BETWEEN ${a} AND ${b}`;
      }
      case 'like':
        return `${col} LIKE ${one()}`;
      case 'not like':
        return `${col} NOT LIKE ${one()}`;
      default:
        return `${col} ${f.op} ${one()}`;
    }
  }

  protected whereClause(where?: Filter[], whereSql?: string): string {
    const parts = (where ?? []).map((f) => this.filterToSql(f));
    if (whereSql && whereSql.trim()) parts.push(`(${whereSql.trim()})`);
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  protected keyClause(where: KeyMatch): string {
    if (where.length === 0)
      throw new DriverError('UNSUPPORTED', 'Refusing to build a statement without a row key');
    return where
      .map(({ column, value }) =>
        value.t === 'null'
          ? `${this.quoteIdentifier(column)} IS NULL`
          : `${this.quoteIdentifier(column)} = ${this.quoteLiteral(value)}`,
      )
      .join(' AND ');
  }

  buildSelect(table: TableRef, opts: SelectOptions): string {
    const cols = opts.columns?.length
      ? opts.columns.map((c) => this.quoteIdentifier(c)).join(', ')
      : '*';
    let sql = `SELECT ${cols} FROM ${this.qualify(table)}${this.whereClause(opts.where, opts.whereSql)}`;
    if (opts.orderBy?.length) {
      sql += ` ORDER BY ${opts.orderBy
        .map((o) => `${this.quoteIdentifier(o.column)} ${o.direction.toUpperCase()}`)
        .join(', ')}`;
    }
    return this.paginate(sql, opts.limit, opts.offset);
  }

  buildCount(table: TableRef, opts: Pick<SelectOptions, 'where' | 'whereSql'>): string {
    return `SELECT COUNT(*) FROM ${this.qualify(table)}${this.whereClause(opts.where, opts.whereSql)}`;
  }

  buildUpdate(table: TableRef, set: CellChange[], where: KeyMatch): string {
    if (set.length === 0) throw new DriverError('UNSUPPORTED', 'Nothing to update');
    const assignments = set
      .map((c) => `${this.quoteIdentifier(c.column)} = ${this.quoteLiteral(c.newValue)}`)
      .join(', ');
    return `UPDATE ${this.qualify(table)} SET ${assignments} WHERE ${this.keyClause(where)}`;
  }

  buildInsert(table: TableRef, row: CellChange[]): string {
    if (row.length === 0) return `INSERT INTO ${this.qualify(table)} DEFAULT VALUES`;
    const cols = row.map((c) => this.quoteIdentifier(c.column)).join(', ');
    const vals = row.map((c) => this.quoteLiteral(c.newValue)).join(', ');
    return `INSERT INTO ${this.qualify(table)} (${cols}) VALUES (${vals})`;
  }

  buildInsertMany(table: TableRef, columns: string[], rows: Value[][]): string {
    if (columns.length === 0) throw new DriverError('UNSUPPORTED', 'Nothing to insert');
    if (rows.length === 0) throw new DriverError('UNSUPPORTED', 'No rows to insert');
    const cols = columns.map((c) => this.quoteIdentifier(c)).join(', ');
    const values = rows
      .map((row) => `(${columns.map((_, i) => this.quoteLiteral(row[i] ?? V.null())).join(', ')})`)
      .join(',\n');
    return `INSERT INTO ${this.qualify(table)} (${cols}) VALUES\n${values}`;
  }

  buildDelete(table: TableRef, where: KeyMatch): string {
    return `DELETE FROM ${this.qualify(table)} WHERE ${this.keyClause(where)}`;
  }

  buildAlter?(table: TableDefinition, changes: StructureChange[]): string[];

  classify(sql: string): StatementClass {
    return classifyStatement(sql);
  }
}
