import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  DriverError,
  type ColumnDefinition,
  type ColumnMeta,
  type DbObject,
  type ExplainResult,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type QueryEvent,
  type QueryOptions,
  type ResolvedEndpoint,
  type SchemaInfo,
  type ServerInfo,
  type Session,
  type TableDefinition,
  type Value,
} from '@rasql/driver-protocol';
import { SqliteDialect } from './dialect.js';
import { declaredTypeToValueType, toParam, toValue } from './values.js';

interface SqliteNativeError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

function wrap(err: unknown, fallback = 'QUERY_FAILED'): DriverError {
  if (err instanceof DriverError) return err;
  const e = err as SqliteNativeError;
  const details: Record<string, unknown> = {};
  if (e.errcode !== undefined) details['errcode'] = e.errcode;
  if (e.errstr !== undefined) details['errstr'] = e.errstr;
  return new DriverError(fallback, e.message ?? String(err), { details, cause: err });
}

const yieldToEventLoop = (): Promise<void> => new Promise((res) => setImmediate(res));

type Row = Record<string, unknown>;

export class SqliteSession implements Session {
  readonly dialect = new SqliteDialect();
  private readOnly: boolean;

  constructor(
    private readonly db: DatabaseSync,
    private readonly filePath: string,
    readOnly: boolean,
  ) {
    this.readOnly = readOnly;
  }

  private all(sql: string, ...params: Array<null | number | bigint | string | Uint8Array>): Row[] {
    try {
      const stmt = this.db.prepare(sql);
      return stmt.all(...params) as Row[];
    } catch (err) {
      throw wrap(err);
    }
  }

  private scalar<T>(sql: string): T {
    const row = this.all(sql)[0];
    if (!row) throw new DriverError('INTERNAL', `No row from ${sql}`);
    return Object.values(row)[0] as T;
  }

  async info(): Promise<ServerInfo> {
    return {
      engine: 'sqlite',
      engineName: 'SQLite',
      version: this.scalar<string>('SELECT sqlite_version()'),
      charset: this.scalar<string>('PRAGMA encoding'),
      readOnly: this.readOnly,
      currentSchema: 'main',
      extra: {
        file: this.filePath,
        journalMode: this.scalar<string>('PRAGMA journal_mode'),
        pageSize: String(this.scalar<number>('PRAGMA page_size')),
        foreignKeys: String(this.scalar<number>('PRAGMA foreign_keys')),
      },
    };
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    return this.all('PRAGMA database_list').map((r) => ({
      name: String(r['name']),
      isCurrent: r['name'] === 'main',
      isSystem: r['name'] === 'temp',
    }));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const master = `${this.dialect.quoteIdentifier(schema)}.sqlite_master`;
    const rows = this.all(
      `SELECT type, name, tbl_name FROM ${master} WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    );
    return rows.map((r) => {
      const type = String(r['type']);
      const kind = type === 'table' ? 'table' : type === 'view' ? 'view' : 'trigger';
      const o: DbObject = { kind, schema, name: String(r['name']) };
      if (kind === 'trigger') o.extra = { table: String(r['tbl_name']) };
      return o;
    });
  }

  async describeTable(schema: string, table: string): Promise<TableDefinition> {
    const master = `${this.dialect.quoteIdentifier(schema)}.sqlite_master`;
    const meta = this.all(
      `SELECT type, sql FROM ${master} WHERE name = ? AND type IN ('table', 'view')`,
      table,
    )[0];
    if (!meta) throw new DriverError('QUERY_FAILED', `No table or view named ${schema}.${table}`);
    const ddl = typeof meta['sql'] === 'string' ? meta['sql'] : undefined;
    const kind = meta['type'] === 'view' ? 'view' : 'table';

    const colRows = this.all('SELECT * FROM pragma_table_xinfo(?, ?)', table, schema);
    const pkColumns = colRows
      .filter((r) => Number(r['pk']) > 0)
      .sort((a, b) => Number(a['pk']) - Number(b['pk']))
      .map((r) => String(r['name']));
    const hasAutoincrement = ddl !== undefined && /\bAUTOINCREMENT\b/i.test(ddl);

    const columns: ColumnDefinition[] = colRows
      .filter((r) => Number(r['hidden']) !== 1) // 1 = hidden virtual-table column; 2/3 = generated, keep those
      .map((r) => {
        const name = String(r['name']);
        const nativeType = String(r['type'] ?? '');
        const isRowidAlias =
          pkColumns.length === 1 && pkColumns[0] === name && /^INTEGER$/i.test(nativeType);
        const col: ColumnDefinition = {
          name,
          ordinal: Number(r['cid']) + 1,
          nativeType,
          valueType: declaredTypeToValueType(nativeType),
          nullable: Number(r['notnull']) === 0 && !pkColumns.includes(name),
          autoIncrement: isRowidAlias && hasAutoincrement,
        };
        const dflt = r['dflt_value'];
        if (dflt !== null && dflt !== undefined)
          col.default = { t: 'expression', sql: String(dflt) };
        const hidden = Number(r['hidden']);
        if (hidden === 2 || hidden === 3) col.generated = { expression: '', stored: hidden === 3 };
        return col;
      });

    const indexes: IndexDefinition[] = this.all(
      'SELECT * FROM pragma_index_list(?, ?)',
      table,
      schema,
    ).map((ix) => {
      const name = String(ix['name']);
      const cols = this.all('SELECT * FROM pragma_index_xinfo(?, ?)', name, schema)
        .filter((c) => Number(c['key']) === 1)
        .sort((a, b) => Number(a['seqno']) - Number(b['seqno']))
        .map((c) => {
          const col: IndexDefinition['columns'][number] = {
            order: Number(c['desc']) === 1 ? 'desc' : 'asc',
          };
          if (c['name'] !== null && c['name'] !== undefined) col.name = String(c['name']);
          else col.expression = '<expression>';
          return col;
        });
      return {
        name,
        unique: Number(ix['unique']) === 1,
        primary: ix['origin'] === 'pk',
        type:
          ix['origin'] === 'c'
            ? 'index'
            : ix['origin'] === 'u'
              ? 'unique constraint'
              : 'primary key',
        columns: cols,
      };
    });

    const fkRows = this.all('SELECT * FROM pragma_foreign_key_list(?, ?)', table, schema);
    const fkById = new Map<number, ForeignKeyDefinition>();
    for (const r of fkRows.sort(
      (a, b) => Number(a['id']) - Number(b['id']) || Number(a['seq']) - Number(b['seq']),
    )) {
      const id = Number(r['id']);
      let fk = fkById.get(id);
      if (!fk) {
        fk = {
          name: `fk_${table}_${id}`,
          columns: [],
          referencedTable: String(r['table']),
          referencedColumns: [],
          onUpdate: String(r['on_update']),
          onDelete: String(r['on_delete']),
        };
        fkById.set(id, fk);
      }
      fk.columns.push(String(r['from']));
      fk.referencedColumns.push(r['to'] === null ? '<rowid>' : String(r['to']));
    }

    const def: TableDefinition = {
      schema,
      name: table,
      kind,
      columns,
      indexes,
      foreignKeys: [...fkById.values()],
      options: {},
    };
    if (pkColumns.length) def.primaryKey = pkColumns;
    if (ddl !== undefined) def.ddl = ddl;
    if (ddl !== undefined && /\bWITHOUT\s+ROWID\b/i.test(ddl))
      def.options['without_rowid'] = 'true';
    if (ddl !== undefined && /\bSTRICT\b\s*;?\s*$/i.test(ddl)) def.options['strict'] = 'true';
    return def;
  }

  private columnMeta(stmt: StatementSync): ColumnMeta[] {
    return stmt.columns().map((c) => {
      const meta: ColumnMeta = {
        name: c.name,
        nativeType: c.type ?? '',
        valueType: declaredTypeToValueType(c.type),
        nullable: true,
        isPrimaryKey: false,
      };
      if (c.table) meta.table = c.table;
      if (c.database) meta.schema = c.database;
      if (c.column && c.column !== c.name) meta.originalName = c.column;
      return meta;
    });
  }

  async *query(sql: string, opts: QueryOptions = {}): AsyncIterable<QueryEvent> {
    const started = Date.now();
    const signal = opts.signal;
    const batchSize = Math.min(Math.max(opts.rowBatchSize ?? 256, 1), 5000);
    const params = (opts.params ?? []).map(toParam);
    const errorEvent = (err: unknown): QueryEvent => {
      const e = wrap(err);
      return { kind: 'error', resultIndex: 0, code: e.code, message: e.message };
    };

    let stmt: StatementSync;
    try {
      stmt = this.db.prepare(sql);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
    } catch (err) {
      yield errorEvent(err);
      return;
    }

    const columns = this.columnMeta(stmt);
    if (columns.length === 0) {
      try {
        const r = stmt.run(...params);
        yield {
          kind: 'done',
          resultIndex: 0,
          more: false,
          affectedRows: Number(r.changes),
          insertId: String(r.lastInsertRowid),
          elapsedMs: Date.now() - started,
          warnings: [],
        };
      } catch (err) {
        yield errorEvent(err);
      }
      return;
    }

    yield { kind: 'columns', resultIndex: 0, columns };
    const declared = stmt.columns().map((c) => c.type);
    let rows: Value[][] = [];
    let count = 0;
    let truncated = false;
    try {
      for (const raw of stmt.iterate(...params) as Iterable<unknown[]>) {
        rows.push(raw.map((cell, i) => toValue(cell, declared[i])));
        count++;
        if (rows.length >= batchSize) {
          yield { kind: 'rows', resultIndex: 0, rows };
          rows = [];
          await yieldToEventLoop();
          if (signal?.aborted) {
            yield { kind: 'error', resultIndex: 0, code: 'CANCELLED', message: 'Query cancelled' };
            return;
          }
        }
        if (opts.maxRows !== undefined && count >= opts.maxRows) {
          truncated = true;
          break;
        }
      }
      if (rows.length) yield { kind: 'rows', resultIndex: 0, rows };
      yield {
        kind: 'done',
        resultIndex: 0,
        more: false,
        rowCount: count,
        truncated,
        elapsedMs: Date.now() - started,
        warnings: [],
      };
    } catch (err) {
      yield errorEvent(err);
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const columns: ColumnMeta[] = ['id', 'parent', 'notused', 'detail'].map((name) => ({
      name,
      nativeType: name === 'detail' ? 'TEXT' : 'INTEGER',
      valueType: name === 'detail' ? 'text' : 'int',
      nullable: false,
      isPrimaryKey: false,
    }));
    const rows = this.all(`EXPLAIN QUERY PLAN ${sql}`).map((r) => [
      toValue(r['id'], 'INTEGER'),
      toValue(r['parent'], 'INTEGER'),
      toValue(r['notused'], 'INTEGER'),
      toValue(r['detail'], 'TEXT'),
    ]);
    return { format: 'table', columns, rows };
  }

  async setReadOnly(on: boolean): Promise<void> {
    try {
      this.db.exec(`PRAGMA query_only = ${on ? 1 : 0}`);
    } catch (err) {
      throw wrap(err);
    }
    this.readOnly = on;
  }

  async begin(): Promise<void> {
    this.exec('BEGIN');
  }

  async commit(): Promise<void> {
    this.exec('COMMIT');
  }

  async rollback(): Promise<void> {
    this.exec('ROLLBACK');
  }

  private exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (err) {
      throw wrap(err);
    }
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}

export function openSqlite(endpoint: ResolvedEndpoint): SqliteSession {
  const filePath =
    endpoint.filePath ??
    (typeof endpoint.options['filePath'] === 'string' ? endpoint.options['filePath'] : undefined);
  if (!filePath) throw new DriverError('CONNECTION_FAILED', 'No database file given');
  const readOnly = endpoint.readOnly === true;
  const isMemory = filePath === ':memory:' || filePath.startsWith('file::memory:');
  const createIfMissing = endpoint.options['createIfMissing'] === true;
  let db: DatabaseSync;
  try {
    if (!isMemory && !createIfMissing && !readOnly) {
      // DatabaseSync creates files silently. A database manager should not invent databases.
      new DatabaseSync(filePath, { readOnly: true }).close();
    }
    db = new DatabaseSync(filePath, { readOnly, enableForeignKeyConstraints: true });
  } catch (err) {
    throw wrap(err, 'CONNECTION_FAILED');
  }
  try {
    if (readOnly) db.exec('PRAGMA query_only = 1');
  } catch (err) {
    db.close();
    throw wrap(err, 'CONNECTION_FAILED');
  }
  return new SqliteSession(db, filePath, readOnly);
}
