import { Connection, Request, TYPES, type ConnectionConfiguration } from 'tedious';
import {
  DriverError,
  type ColumnDefinition,
  type ColumnMeta,
  type DbObject,
  type DbObjectKind,
  type ExplainResult,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type ObjectDefinition,
  type QueryEvent,
  type QueryOptions,
  type ResolvedEndpoint,
  type SchemaInfo,
  type ServerInfo,
  type Session,
  type TableDefinition,
  type Value,
  type Warning,
} from '@rasql/driver-protocol';
import { MssqlDialect } from './dialect.js';
import { parseDefault } from './defaults.js';
import { isReadOnlyBatch, splitBatches } from './split.js';
import { nativeTypeOf, toValue, valueTypeOf, type ColumnInfo } from './values.js';

const SYSTEM_SCHEMAS = new Set(['sys', 'INFORMATION_SCHEMA', 'guest']);
/** Separates list items inside one text cell: a tab, which FOR XML accepts and names rarely hold. */
const SEP = '\t';

interface TediousError extends Error {
  code?: string;
  number?: number;
  state?: number;
  class?: number;
  lineNumber?: number;
  errors?: TediousError[];
}

const VERSION_NAMES: Record<string, string> = {
  '11': 'SQL Server 2012',
  '12': 'SQL Server 2014',
  '13': 'SQL Server 2016',
  '14': 'SQL Server 2017',
  '15': 'SQL Server 2019',
  '16': 'SQL Server 2022',
  '17': 'SQL Server 2025',
};

export function wrapError(err: unknown, phase: 'connect' | 'query' = 'query'): DriverError {
  if (err instanceof DriverError) return err;
  const e = (err as TediousError).errors?.[0] ?? (err as TediousError);
  const message = e.message ?? String(err);
  const details: Record<string, unknown> = {};
  if (e.code) details['code'] = e.code;
  if (e.number !== undefined) details['number'] = e.number;
  if (e.lineNumber !== undefined) details['line'] = e.lineNumber;
  const extra = { details, cause: err };
  if (e.code === 'ECANCEL') return new DriverError('CANCELLED', message, extra);
  if (e.code === 'ETIMEOUT') return new DriverError('TIMEOUT', message, extra);
  // 18456: login failed. 4060: cannot open the database the login asked for.
  if (e.number === 18456 || (e.code === 'ELOGIN' && /login failed/i.test(message)))
    return new DriverError('AUTH_FAILED', message, extra);
  if (e.number === 3906 || (/read-only/i.test(message) && e.number === 50000))
    return new DriverError('READ_ONLY_VIOLATION', message, extra);
  if (
    phase === 'connect' ||
    e.code === 'ESOCKET' ||
    e.code === 'ECONNCLOSED' ||
    e.code === 'ELOGIN'
  )
    return new DriverError('CONNECTION_FAILED', message, extra);
  return new DriverError('QUERY_FAILED', message, extra);
}

export function connectionConfig(
  endpoint: ResolvedEndpoint,
  plain = false,
): ConnectionConfiguration {
  const timeout = endpoint.options['connectTimeoutMs'];
  const instance = endpoint.options['instanceName'];
  const tls = endpoint.tls;
  const encrypt = !plain && tls !== undefined && tls.mode !== 'disabled';
  const options: NonNullable<ConnectionConfiguration['options']> = {
    appName: 'RaSQL',
    connectTimeout: typeof timeout === 'number' ? timeout : 10_000,
    requestTimeout: 0,
    cancelTimeout: 5000,
    useUTC: true,
    rowCollectionOnRequestCompletion: false,
    useColumnNames: false,
    encrypt,
    trustServerCertificate: !(tls?.mode === 'verify-ca' || tls?.mode === 'verify-identity'),
    // The behaviour SQL Server Management Studio sets, so results match what people see there.
    enableAnsiNull: true,
    enableAnsiPadding: true,
    enableAnsiWarnings: true,
    enableArithAbort: true,
    enableConcatNullYieldsNull: true,
    enableQuotedIdentifier: true,
    textsize: 2147483647,
    datefirst: 7,
  };
  if (typeof instance === 'string' && instance.trim()) options.instanceName = instance.trim();
  else options.port = endpoint.port ?? 1433;
  if (endpoint.database) options.database = endpoint.database;
  if (tls?.servername) options.serverName = tls.servername;
  if (tls?.ca) options.cryptoCredentialsDetails = { ca: tls.ca };
  return {
    server: endpoint.host ?? '127.0.0.1',
    authentication: {
      type: 'default',
      options: { userName: endpoint.user ?? '', password: endpoint.password ?? '' },
    },
    options,
  };
}

function connectRaw(config: ConnectionConfiguration, signal?: AbortSignal): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = new Connection(config);
    const onAbort = (): void => {
      conn.close();
      reject(new DriverError('CANCELLED', 'Connect cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    conn.connect((err) => {
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        conn.close();
        reject(wrapError(err, 'connect'));
        return;
      }
      resolve(conn);
    });
  });
}

type Row = Record<string, string | undefined>;

const text = (v: Value | undefined): string | undefined => {
  if (!v || v.t === 'null') return undefined;
  if (v.t === 'bool') return v.v ? '1' : '0';
  if (v.t === 'float') return String(v.v);
  if ('v' in v && typeof v.v === 'string') return v.v;
  return undefined;
};
const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const yes = (v: string | undefined): boolean => v === '1' || v === 'true';
const list = (v: string | undefined): string[] => (v ? v.split(SEP) : []);

/** sys.columns as a type name with its size: nvarchar(255), decimal(10,2), datetime2(3). */
const TYPE_SQL = `CASE
  WHEN t.name IN ('nvarchar', 'nchar') THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
  WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
  WHEN t.name IN ('decimal', 'numeric') THEN t.name + '(' + CAST(c.precision AS varchar(3)) + ',' + CAST(c.scale AS varchar(3)) + ')'
  WHEN t.name IN ('datetime2', 'time', 'datetimeoffset') THEN t.name + '(' + CAST(c.scale AS varchar(3)) + ')'
  ELSE t.name END`;

export class MssqlSession implements Session {
  readonly dialect = new MssqlDialect();
  private readOnly: boolean;
  private dead: DriverError | null = null;
  private messages: Warning[] = [];
  /** tedious runs one request per connection at a time; callers queue here. */
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly conn: Connection,
    readOnly: boolean,
  ) {
    this.readOnly = readOnly;
    conn.on('error', (err: unknown) => {
      this.dead = wrapError(err, 'connect');
    });
    conn.on('end', () => {
      this.dead ??= new DriverError('CONNECTION_FAILED', 'The connection was closed');
    });
    conn.on('infoMessage', (m) => {
      // Class 0 to 10 are messages: PRINT output, "Changed database context", warnings.
      if (m.number === 5701 || m.number === 5703) return;
      this.messages.push({
        code: String(m.number),
        message: m.message,
        level: m.class > 0 ? 'warning' : 'note',
      });
    });
  }

  static async open(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<MssqlSession> {
    let conn: Connection;
    try {
      conn = await connectRaw(connectionConfig(endpoint), signal);
    } catch (err) {
      // 'preferred' means: try TLS, fall back to plain.
      if (
        endpoint.tls?.mode === 'preferred' &&
        !signal?.aborted &&
        !(err instanceof DriverError && err.code === 'AUTH_FAILED')
      )
        conn = await connectRaw(connectionConfig(endpoint, true), signal);
      else throw err;
    }
    const session = new MssqlSession(conn, endpoint.readOnly === true);
    try {
      const init = endpoint.options['initSql'];
      if (typeof init === 'string' && init.trim()) await session.exec(init);
    } catch (err) {
      conn.close();
      throw wrapError(err, 'connect');
    }
    return session;
  }

  /** Wait for the connection to be free; call the returned function to free it again. */
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const before = this.tail;
    this.tail = before.then(() => mine);
    await before;
    return release;
  }

  /** Run a batch and collect its first result set as name → Value rows. Internal use only. */
  private async run(sql: string): Promise<Record<string, Value>[]> {
    const release = await this.acquire();
    try {
      return await this.runNow(sql);
    } finally {
      release();
    }
  }

  private runNow(sql: string): Promise<Record<string, Value>[]> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const out: Record<string, Value>[] = [];
      let columns: ColumnInfo[] | null = null;
      const request = new Request(sql, (err) => (err ? reject(wrapError(err)) : resolve(out)));
      request.on('columnMetadata', (cols) => {
        columns ??= (Array.isArray(cols) ? cols : Object.values(cols)) as unknown as ColumnInfo[];
      });
      request.on('row', (cells: { value: unknown; metadata: ColumnInfo }[]) => {
        const row: Record<string, Value> = {};
        cells.forEach((cell, i) => {
          const meta = columns?.[i] ?? cell.metadata;
          row[meta.colName] = toValue(cell.value, meta);
        });
        out.push(row);
      });
      this.conn.execSqlBatch(request);
    });
  }

  private async exec(sql: string): Promise<void> {
    await this.run(sql);
  }

  private lit(s: string): string {
    return this.dialect.quoteLiteral({ t: 'text', v: s });
  }

  /** Metadata rows as text, with the arguments inlined as N'…' literals. */
  private async rows(sql: string, args: string[] = []): Promise<Row[]> {
    const filled = sql.replace(/@(\d)\b/g, (_, i: string) => this.lit(args[Number(i) - 1] ?? ''));
    return (await this.run(filled)).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, text(v)])),
    );
  }

  async info(): Promise<ServerInfo> {
    const r =
      (
        await this.rows(
          "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition, CAST(SERVERPROPERTY('EngineEdition') AS int) AS ee, CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS coll, @@VERSION AS full_, SUSER_SNAME() AS u, SCHEMA_NAME() AS s, DB_NAME() AS db, @@SPID AS spid, CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS dbcoll",
        )
      )[0] ?? {};
    const version = r['v'] ?? '';
    const major = version.split('.')[0] ?? '';
    const ee = Number(r['ee']);
    const azure = ee === 5 || ee === 8;
    const info: ServerInfo = {
      engine: azure ? 'azure-sql' : 'mssql',
      engineName: azure
        ? ee === 5
          ? 'Azure SQL Database'
          : 'Azure SQL Managed Instance'
        : (VERSION_NAMES[major] ?? 'SQL Server'),
      version,
      readOnly: this.readOnly,
      extra: { fullVersion: r['full_'] ?? '', database: r['db'] ?? '', spid: r['spid'] ?? '' },
    };
    if (r['edition']) info.versionComment = r['edition'];
    const coll = r['dbcoll'] ?? r['coll'];
    if (coll) info.collation = coll;
    if (r['u']) info.user = r['u'];
    if (r['s']) info.currentSchema = r['s'];
    return info;
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    // Schemas 16384 to 16399 belong to the fixed database roles (db_owner, …) and hold nothing.
    const rows = await this.rows(
      'SELECT s.name, CASE WHEN s.name = SCHEMA_NAME() THEN 1 ELSE 0 END AS cur FROM sys.schemas s WHERE s.schema_id < 16384 ORDER BY s.name',
    );
    return rows.map((r) => {
      const name = r['name'] ?? '';
      return { name, isSystem: SYSTEM_SCHEMAS.has(name), isCurrent: yes(r['cur']) };
    });
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const rows = await this.rows(
      `SELECT o.name, RTRIM(o.type) AS type, p.parent, p.est,
        CAST(ep.value AS nvarchar(4000)) AS comment,
        CASE WHEN o.type = 'TR' THEN (SELECT STUFF((SELECT ' OR ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = o.object_id FOR XML PATH('')), 1, 4, '')) END AS events,
        CASE WHEN o.type = 'TR' THEN CASE WHEN OBJECTPROPERTY(o.object_id, 'ExecIsInsteadOfTrigger') = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END END AS timing
       FROM sys.objects o
       OUTER APPLY (SELECT OBJECT_NAME(o.parent_object_id) AS parent,
         (SELECT SUM(ps.rows) FROM sys.partitions ps WHERE ps.object_id = o.object_id AND ps.index_id IN (0, 1)) AS est) p
       LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
       WHERE o.schema_id = SCHEMA_ID(@1) AND o.is_ms_shipped = 0 AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR', 'SO')
       ORDER BY o.name`,
      [schema],
    );
    return rows.map((r) => {
      const type = r['type'] ?? '';
      const kind: DbObjectKind =
        type === 'U'
          ? 'table'
          : type === 'V'
            ? 'view'
            : type === 'TR'
              ? 'trigger'
              : type === 'SO'
                ? 'sequence'
                : 'routine';
      const o: DbObject = { kind, schema, name: r['name'] ?? '' };
      const est = num(r['est']);
      if (kind === 'table' && est !== undefined) o.rowEstimate = est;
      if (r['comment']) o.comment = r['comment'];
      if (kind === 'routine') o.extra = { type: type === 'P' ? 'procedure' : 'function' };
      if (kind === 'trigger')
        o.extra = { table: r['parent'] ?? '', timing: r['timing'] ?? '', event: r['events'] ?? '' };
      return o;
    });
  }

  async describeTable(schema: string, table: string): Promise<TableDefinition> {
    const q = this.dialect.quoteIdentifier.bind(this.dialect);
    const qualified = `${q(schema)}.${q(table)}`;
    const obj = (
      await this.rows(
        `SELECT o.object_id AS id, RTRIM(o.type) AS type, CAST(ep.value AS nvarchar(4000)) AS comment,
          (SELECT SUM(ps.rows) FROM sys.partitions ps WHERE ps.object_id = o.object_id AND ps.index_id IN (0, 1)) AS est
         FROM sys.objects o LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
         WHERE o.object_id = OBJECT_ID(@1) AND o.type IN ('U', 'V')`,
        [qualified],
      )
    )[0];
    if (!obj) throw new DriverError('QUERY_FAILED', `No table or view named ${schema}.${table}`);
    const id = obj['id'] ?? '0';
    const kind = obj['type'] === 'V' ? 'view' : 'table';

    const colRows = await this.rows(
      `SELECT c.name, ${TYPE_SQL} AS type, c.is_nullable AS nul, c.is_identity AS ident, dc.definition AS dflt,
        cc.definition AS gen, cc.is_persisted AS persisted,
        CASE WHEN c.collation_name <> CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS sysname) THEN c.collation_name END AS coll,
        CAST(ep.value AS nvarchar(4000)) AS comment
       FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
       LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
       WHERE c.object_id = ${Number(id)} ORDER BY c.column_id`,
    );
    const columns: ColumnDefinition[] = colRows.map((r, i) => {
      const nativeType = r['type'] ?? '';
      const valueType = valueTypeOf(nativeType);
      const col: ColumnDefinition = {
        name: r['name'] ?? '',
        ordinal: i + 1,
        nativeType,
        valueType,
        nullable: yes(r['nul']),
        autoIncrement: yes(r['ident']),
      };
      if (r['gen'])
        col.generated = {
          expression: r['gen'].replace(/^\((.*)\)$/s, '$1'),
          stored: yes(r['persisted']),
        };
      if (r['dflt'] !== undefined) col.default = parseDefault(r['dflt'], valueType);
      if (r['coll']) col.collation = r['coll'];
      if (r['comment']) col.comment = r['comment'];
      if (col.autoIncrement) col.extra = 'IDENTITY';
      return col;
    });

    const idxRows = await this.rows(
      `SELECT i.name, i.is_unique AS uniq, i.is_primary_key AS prim, i.is_unique_constraint AS ucon, i.type_desc AS type,
        i.filter_definition AS filter,
        (SELECT STUFF((SELECT NCHAR(9) + c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
          FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0 ORDER BY ic.key_ordinal
          FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')) AS cols
       FROM sys.indexes i WHERE i.object_id = ${Number(id)} AND i.type > 0 AND i.is_hypothetical = 0
       ORDER BY i.is_primary_key DESC, i.name`,
    );
    const indexes: IndexDefinition[] = idxRows.map((r) => {
      const ix: IndexDefinition = {
        name: r['name'] ?? '',
        unique: yes(r['uniq']),
        primary: yes(r['prim']),
        type: r['type'] ?? '',
        columns: list(r['cols']).map((c) => {
          const desc = c.endsWith(' DESC');
          return { name: desc ? c.slice(0, -5) : c, order: desc ? 'desc' : 'asc' };
        }),
      };
      if (yes(r['prim']) || yes(r['ucon'])) ix.constraint = true;
      if (r['filter']) ix.where = r['filter'].replace(/^\((.*)\)$/s, '$1');
      return ix;
    });
    const primary = indexes.find((i) => i.primary);

    const fkRows = await this.rows(
      `SELECT fk.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS rs, OBJECT_NAME(fk.referenced_object_id) AS rt,
        fk.update_referential_action_desc AS upd, fk.delete_referential_action_desc AS del,
        (SELECT STUFF((SELECT NCHAR(9) + COL_NAME(fc.parent_object_id, fc.parent_column_id) FROM sys.foreign_key_columns fc
          WHERE fc.constraint_object_id = fk.object_id ORDER BY fc.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')) AS cols,
        (SELECT STUFF((SELECT NCHAR(9) + COL_NAME(fc.referenced_object_id, fc.referenced_column_id) FROM sys.foreign_key_columns fc
          WHERE fc.constraint_object_id = fk.object_id ORDER BY fc.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')) AS rcols
       FROM sys.foreign_keys fk WHERE fk.parent_object_id = ${Number(id)} ORDER BY fk.name`,
    );
    const foreignKeys: ForeignKeyDefinition[] = fkRows.map((r) => ({
      name: r['name'] ?? '',
      columns: list(r['cols']),
      referencedSchema: r['rs'] ?? schema,
      referencedTable: r['rt'] ?? '',
      referencedColumns: list(r['rcols']),
      onUpdate: (r['upd'] ?? 'NO_ACTION').replace(/_/g, ' '),
      onDelete: (r['del'] ?? 'NO_ACTION').replace(/_/g, ' '),
    }));

    const def: TableDefinition = {
      schema,
      name: table,
      kind,
      columns,
      indexes,
      foreignKeys,
      options: {},
    };
    if (primary) def.primaryKey = primary.columns.map((c) => c.name ?? '');
    if (obj['comment']) def.comment = obj['comment'];
    const est = num(obj['est']);
    if (est !== undefined && kind === 'table') def.rowEstimate = est;
    if (kind === 'view') {
      const v = (await this.rows(`SELECT OBJECT_DEFINITION(${Number(id)}) AS def`))[0];
      if (v?.['def']) def.ddl = v['def'].trim();
    } else def.ddl = await this.tableDdl(Number(id), def);
    return def;
  }

  /** SQL Server prints no CREATE TABLE; build one from the catalog, as SSMS scripting would. */
  private async tableDdl(id: number, def: TableDefinition): Promise<string> {
    const q = this.dialect.quoteIdentifier.bind(this.dialect);
    const name = `${q(def.schema)}.${q(def.name)}`;
    const named = await this.rows(
      `SELECT c.name AS col, dc.name AS df FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = ${id}`,
    );
    const dfName = new Map(named.map((r) => [r['col'] ?? '', r['df'] ?? '']));
    const lines = def.columns.map((c) => {
      if (c.generated)
        return `${q(c.name)} AS (${c.generated.expression})${c.generated.stored ? ' PERSISTED' : ''}`;
      let sql = `${q(c.name)} ${c.nativeType}`;
      if (c.collation) sql += ` COLLATE ${c.collation}`;
      if (c.autoIncrement) sql += ' IDENTITY(1,1)';
      sql += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.default !== undefined) {
        const d = c.default;
        const df = dfName.get(c.name);
        sql += `${df ? ` CONSTRAINT ${q(df)}` : ''} DEFAULT ${d.t === 'expression' ? d.sql : this.dialect.quoteLiteral(d)}`;
      }
      return sql;
    });
    const cols = (ix: IndexDefinition): string =>
      ix.columns.map((c) => `${q(c.name ?? '')}${c.order === 'desc' ? ' DESC' : ''}`).join(', ');
    const after: string[] = [];
    for (const ix of def.indexes) {
      const clustered =
        ix.type === 'CLUSTERED' ? ' CLUSTERED' : ix.type === 'NONCLUSTERED' ? ' NONCLUSTERED' : '';
      if (ix.primary) lines.push(`CONSTRAINT ${q(ix.name)} PRIMARY KEY${clustered} (${cols(ix)})`);
      else if (ix.constraint)
        lines.push(`CONSTRAINT ${q(ix.name)} UNIQUE${clustered} (${cols(ix)})`);
      else
        after.push(
          `CREATE ${ix.unique ? 'UNIQUE ' : ''}${ix.type === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${q(ix.name)} ON ${name} (${cols(ix)})${ix.where ? ` WHERE ${ix.where}` : ''}`,
        );
    }
    for (const fk of def.foreignKeys)
      lines.push(
        `CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.referencedSchema ?? def.schema)}.${q(fk.referencedTable)} (${fk.referencedColumns.map(q).join(', ')})` +
          (fk.onDelete && fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : '') +
          (fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : ''),
      );
    const checks = await this.rows(
      `SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = ${id} ORDER BY name`,
    );
    for (const c of checks)
      lines.push(`CONSTRAINT ${q(c['name'] ?? '')} CHECK ${c['definition'] ?? ''}`);
    return [`CREATE TABLE ${name} (\n  ${lines.join(',\n  ')}\n)`, ...after].join(';\n');
  }

  async describeObject(
    schema: string,
    kind: DbObjectKind,
    name: string,
  ): Promise<ObjectDefinition> {
    const q = this.dialect.quoteIdentifier.bind(this.dialect);
    const qualified = `${q(schema)}.${q(name)}`;
    const props: ObjectDefinition['properties'] = [];
    const add = (label: string, value: string | undefined): void => {
      if (value !== undefined && value !== '') props.push({ label, value });
    };
    if (kind === 'sequence') {
      const r = (
        await this.rows(
          `SELECT TYPE_NAME(s.user_type_id) AS type, CAST(s.start_value AS nvarchar(64)) AS start, CAST(s.increment AS nvarchar(64)) AS inc,
            CAST(s.minimum_value AS nvarchar(64)) AS min, CAST(s.maximum_value AS nvarchar(64)) AS max, s.is_cycling AS cyc,
            CAST(s.current_value AS nvarchar(64)) AS cur
           FROM sys.sequences s WHERE s.object_id = OBJECT_ID(@1)`,
          [qualified],
        )
      )[0];
      if (!r) throw new DriverError('QUERY_FAILED', `No sequence named ${schema}.${name}`);
      add('Data type', r['type']);
      add('Current value', r['cur']);
      add('Increment', r['inc']);
      return {
        schema,
        name,
        kind,
        ddl: `CREATE SEQUENCE ${qualified} AS ${r['type'] ?? 'bigint'}\n  START WITH ${r['start'] ?? '1'} INCREMENT BY ${r['inc'] ?? '1'}\n  MINVALUE ${r['min'] ?? ''} MAXVALUE ${r['max'] ?? ''}${yes(r['cyc']) ? ' CYCLE' : ' NO CYCLE'}`,
        properties: props,
      };
    }
    const r = (
      await this.rows(
        `SELECT RTRIM(o.type) AS type, o.type_desc AS type_desc, OBJECT_DEFINITION(o.object_id) AS def, OBJECT_NAME(o.parent_object_id) AS parent,
          CONVERT(nvarchar(30), o.create_date, 120) AS created, CONVERT(nvarchar(30), o.modify_date, 120) AS modified,
          CAST(ep.value AS nvarchar(4000)) AS comment,
          OBJECTPROPERTY(o.object_id, 'ExecIsInsteadOfTrigger') AS instead, OBJECTPROPERTY(o.object_id, 'ExecIsTriggerDisabled') AS disabled,
          (SELECT STUFF((SELECT ' OR ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = o.object_id FOR XML PATH('')), 1, 4, '')) AS events,
          (SELECT STUFF((SELECT ', ' + p.name + ' ' + TYPE_NAME(p.user_type_id) + CASE WHEN p.is_output = 1 THEN ' OUTPUT' ELSE '' END
            FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id > 0 ORDER BY p.parameter_id FOR XML PATH('')), 1, 2, '')) AS params,
          (SELECT TYPE_NAME(p.user_type_id) FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id = 0) AS returns_
         FROM sys.objects o LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
         WHERE o.object_id = OBJECT_ID(@1)`,
        [qualified],
      )
    )[0];
    if (!r) throw new DriverError('QUERY_FAILED', `No ${kind} named ${schema}.${name}`);
    if (kind === 'routine') {
      const type = r['type'] ?? '';
      add(
        'Type',
        type === 'P' ? 'procedure' : type === 'FN' ? 'scalar function' : 'table-valued function',
      );
      add('Parameters', r['params'] || 'none');
      if (type === 'FN') add('Returns', r['returns_']);
    }
    if (kind === 'trigger') {
      add('Table', r['parent']);
      add(
        'Fires',
        `${yes(r['instead']) ? 'INSTEAD OF' : 'AFTER'} ${r['events'] ?? ''}, for each statement`,
      );
      add('Enabled', yes(r['disabled']) ? 'no' : 'yes');
    }
    add('Created', r['created']);
    add('Last changed', r['modified']);
    add('Comment', r['comment']);
    // OBJECT_DEFINITION is NULL for encrypted modules and without VIEW DEFINITION permission.
    return { schema, name, kind, ddl: (r['def'] ?? '').trim(), properties: props };
  }

  async *query(sql: string, opts: QueryOptions = {}): AsyncIterable<QueryEvent> {
    const started = Date.now();
    if (this.dead) {
      yield { kind: 'error', resultIndex: 0, code: this.dead.code, message: this.dead.message };
      return;
    }
    const batches = splitBatches(sql);
    if (this.readOnly) {
      const refused = batches.find((b) => !isReadOnlyBatch(b.sql));
      if (refused) {
        yield {
          kind: 'error',
          resultIndex: 0,
          code: 'READ_ONLY_VIOLATION',
          message:
            'This connection is read-only. SQL Server has no read-only session, so RaSQL refuses any batch that could write: only SELECT and WITH … SELECT run.',
        };
        return;
      }
    }
    if (opts.params?.length && batches.length > 1) {
      yield {
        kind: 'error',
        resultIndex: 0,
        code: 'UNSUPPORTED',
        message: 'Parameters need a single batch',
      };
      return;
    }
    let resultIndex = 0;
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b] as (typeof batches)[number];
      for (let n = 0; n < batch.repeat; n++) {
        const last = b === batches.length - 1 && n === batch.repeat - 1;
        let failed = false;
        for await (const e of this.runBatch(
          batch.sql,
          batch.offset,
          resultIndex,
          last,
          started,
          opts,
        )) {
          if (e.kind === 'error') failed = true;
          if (e.kind === 'done') resultIndex = e.resultIndex + 1;
          yield e;
        }
        if (failed || opts.signal?.aborted) return;
      }
    }
  }

  private async *runBatch(
    sql: string,
    offset: number,
    firstIndex: number,
    lastBatch: boolean,
    started: number,
    opts: QueryOptions,
  ): AsyncIterable<QueryEvent> {
    const release = await this.acquire();
    try {
      yield* this.runBatchNow(sql, offset, firstIndex, lastBatch, started, opts);
    } finally {
      release();
    }
  }

  private async *runBatchNow(
    sql: string,
    offset: number,
    firstIndex: number,
    lastBatch: boolean,
    started: number,
    opts: QueryOptions,
  ): AsyncIterable<QueryEvent> {
    if (this.dead) {
      yield {
        kind: 'error',
        resultIndex: firstIndex,
        code: this.dead.code,
        message: this.dead.message,
      };
      return;
    }
    const signal = opts.signal;
    const batchSize = Math.min(Math.max(opts.rowBatchSize ?? 256, 1), 5000);
    const highWater = batchSize * 4;

    type Item =
      | { type: 'columns'; columns: ColumnInfo[] }
      | { type: 'row'; cells: unknown[] }
      | { type: 'done'; rowCount: number | undefined }
      | { type: 'end'; err: TediousError | undefined };
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    let paused = false;
    let ended = false;
    const push = (item: Item): void => {
      queue.push(item);
      if (queue.length > highWater && !paused && !ended) {
        paused = true;
        request.pause();
      }
      wake?.();
      wake = null;
    };

    this.messages = [];
    const request = new Request(sql, (err) => {
      ended = true;
      push({ type: 'end', err: err as TediousError | undefined });
    });
    request.on('columnMetadata', (cols) =>
      push({
        type: 'columns',
        columns: (Array.isArray(cols) ? cols : Object.values(cols)) as unknown as ColumnInfo[],
      }),
    );
    request.on('row', (cells: { value: unknown }[]) =>
      push({ type: 'row', cells: cells.map((c) => c.value) }),
    );
    // A statement of the batch finished; rowCount is set for SELECT, INSERT, UPDATE and DELETE.
    request.on('doneInProc', (rowCount: number | undefined) => push({ type: 'done', rowCount }));
    request.on('done', (rowCount: number | undefined) => push({ type: 'done', rowCount }));

    let cancelled = false;
    let truncated = false;
    const cancel = (): void => {
      if (!cancelled && !ended) {
        cancelled = true;
        this.conn.cancel();
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });

    const params = opts.params ?? [];
    params.forEach((v, i) => {
      const name = `p${i + 1}`;
      switch (v.t) {
        case 'null':
          request.addParameter(name, TYPES.NVarChar, null);
          break;
        case 'bool':
          request.addParameter(name, TYPES.Bit, v.v);
          break;
        case 'int':
          request.addParameter(name, TYPES.BigInt, v.v);
          break;
        case 'float':
          request.addParameter(name, TYPES.Float, v.v);
          break;
        case 'bytes':
        case 'geometry':
        case 'unknown':
          request.addParameter(name, TYPES.VarBinary, Buffer.from(v.v));
          break;
        default:
          request.addParameter(name, TYPES.NVarChar, 'v' in v ? String(v.v) : null);
      }
    });
    if (params.length) this.conn.execSql(request);
    else this.conn.execSqlBatch(request);

    let index = firstIndex;
    let current: { columns: ColumnInfo[]; batch: Value[][]; count: number } | null = null;
    // A finished result waits here until it is known whether another one follows it.
    let pending: Extract<QueryEvent, { kind: 'done' }> | null = null;
    let reported = 0;
    const flush = (more: boolean): QueryEvent[] => {
      if (!pending) return [];
      const done = { ...pending, more };
      pending = null;
      reported++;
      return [done];
    };
    const finish = (rowCount: number | undefined): QueryEvent[] => {
      const out: QueryEvent[] = [];
      if (current) {
        out.push(...flush(true));
        if (current.batch.length)
          out.push({ kind: 'rows', resultIndex: index, rows: current.batch });
        pending = {
          kind: 'done',
          resultIndex: index,
          more: true,
          rowCount: current.count,
          truncated,
          elapsedMs: Date.now() - started,
          warnings: this.messages.splice(0),
        };
        current = null;
        index++;
      } else if (rowCount !== undefined) {
        out.push(...flush(true));
        pending = {
          kind: 'done',
          resultIndex: index,
          more: true,
          affectedRows: rowCount,
          elapsedMs: Date.now() - started,
          warnings: this.messages.splice(0),
        };
        index++;
      }
      return out;
    };

    try {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((res) => (wake = res));
        const item = queue.shift() as Item;
        if (paused && queue.length < batchSize) {
          paused = false;
          request.resume();
        }
        switch (item.type) {
          case 'columns': {
            for (const e of finish(undefined)) yield e;
            for (const e of flush(true)) yield e;
            current = { columns: item.columns, batch: [], count: 0 };
            const columns = item.columns.map((c): ColumnMeta => ({
              name: c.colName,
              nativeType: nativeTypeOf(c),
              valueType: valueTypeOf(nativeTypeOf(c)),
              nullable: ((c.flags ?? 1) & 1) === 1,
              isPrimaryKey: false,
            }));
            yield { kind: 'columns', resultIndex: index, columns };
            break;
          }
          case 'row': {
            if (!current || truncated) break;
            const cols = current.columns;
            current.batch.push(item.cells.map((cell, i) => toValue(cell, cols[i] as ColumnInfo)));
            current.count++;
            if (current.batch.length >= batchSize) {
              const rows = current.batch;
              current.batch = [];
              yield { kind: 'rows', resultIndex: index, rows };
            }
            if (opts.maxRows !== undefined && current.count >= opts.maxRows) {
              truncated = true;
              cancel();
            }
            break;
          }
          case 'done':
            // Statements without rows or counts (SET, DECLARE, PRINT) report nothing.
            if (!truncated) for (const e of finish(item.rowCount)) yield e;
            break;
          case 'end': {
            const err = item.err;
            if (err && !truncated) {
              const e = wrapError(err);
              if (cancelled || e.code === 'CANCELLED') {
                yield {
                  kind: 'error',
                  resultIndex: index,
                  code: 'CANCELLED',
                  message: 'Query cancelled',
                };
                return;
              }
              for (const ev of finish(undefined)) yield ev;
              for (const ev of flush(true)) yield ev;
              const ev: QueryEvent = {
                kind: 'error',
                resultIndex: index,
                code: e.code,
                message: e.message,
              };
              const line = (err.errors?.[0] ?? err).lineNumber;
              if (line && line > 0) {
                let pos = 0;
                for (let l = 1; l < line && pos >= 0; l++) {
                  const nl = sql.indexOf('\n', pos);
                  pos = nl === -1 ? -1 : nl + 1;
                }
                if (pos >= 0) ev.position = offset + pos;
              }
              yield ev;
              return;
            }
            for (const e of finish(undefined)) yield e;
            for (const e of flush(!lastBatch)) yield e;
            // A batch of SET or PRINT reports no count; still say it finished.
            if (reported === 0)
              yield {
                kind: 'done',
                resultIndex: index,
                more: !lastBatch,
                elapsedMs: Date.now() - started,
                warnings: this.messages.splice(0),
              };
            return;
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (paused && !ended) request.resume();
      // The consumer stopped early: stop the server, and wait until the connection is free again.
      if (!ended) {
        cancel();
        while (!ended) await new Promise<void>((res) => (wake = res));
      }
    }
  }

  /** SHOWPLAN_TEXT on, the statement, off again, all while holding the connection. */
  async explain(sql: string): Promise<ExplainResult> {
    const release = await this.acquire();
    try {
      await this.runNow('SET SHOWPLAN_TEXT ON');
      try {
        const rows: string[] = [];
        for await (const e of this.runBatchNow(sql, 0, 0, true, Date.now(), {}))
          if (e.kind === 'rows') for (const r of e.rows) rows.push(text(r[0]) ?? '');
          else if (e.kind === 'error') throw new DriverError(e.code, e.message);
        return { format: 'text', text: rows.join('\n') };
      } finally {
        await this.runNow('SET SHOWPLAN_TEXT OFF');
      }
    } finally {
      release();
    }
  }

  async setReadOnly(on: boolean): Promise<void> {
    this.readOnly = on;
  }

  async begin(): Promise<void> {
    await this.exec('BEGIN TRANSACTION');
  }

  async commit(): Promise<void> {
    await this.exec('COMMIT TRANSACTION');
  }

  async rollback(): Promise<void> {
    await this.exec('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.conn.once('end', () => resolve());
      this.conn.close();
      setTimeout(resolve, 2000).unref();
    });
  }
}
