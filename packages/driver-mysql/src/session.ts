import {
  createConnection,
  type Connection,
  type ConnectionOptions,
  type FieldPacket,
} from 'mysql2';
import {
  DriverError,
  V,
  type ColumnDefinition,
  type ColumnMeta,
  type DbObject,
  type DbObjectKind,
  type ObjectDefinition,
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
  type Warning,
} from '@rasql/driver-protocol';
import { MysqlDialect } from './dialect.js';
import { detectFlavor, type Flavor } from './flavor.js';
import { dataTypeToValueType, fieldValueType, toParam, toValue, FLAG } from './values.js';

const SERVER_MORE_RESULTS_EXISTS = 8;
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

interface MysqlNativeError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
  fatal?: boolean;
}

interface OkLike {
  affectedRows: number;
  insertId: number | bigint;
  serverStatus: number;
  warningStatus: number;
  info?: string;
}

type RawRow = Array<Buffer | null>;

function isOk(x: unknown): x is OkLike {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && 'affectedRows' in x;
}

export function wrapError(err: unknown, phase: 'connect' | 'query' = 'query'): DriverError {
  if (err instanceof DriverError) return err;
  const e = err as MysqlNativeError;
  const message = e.sqlMessage ?? e.message ?? String(err);
  const details: Record<string, unknown> = {};
  if (e.code) details['code'] = e.code;
  if (e.errno !== undefined) details['errno'] = e.errno;
  const extra = { details, cause: err, ...(e.sqlState ? { sqlState: e.sqlState } : {}) };
  switch (e.code) {
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR':
      return new DriverError('AUTH_FAILED', message, extra);
    case 'ER_QUERY_INTERRUPTED':
      return new DriverError('CANCELLED', message, extra);
    case 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION':
    case 'ER_OPTION_PREVENTS_STATEMENT':
      return new DriverError('READ_ONLY_VIOLATION', message, extra);
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
      return new DriverError('TIMEOUT', message, extra);
  }
  if (phase === 'connect') return new DriverError('CONNECTION_FAILED', message, extra);
  return new DriverError('QUERY_FAILED', message, extra);
}

/** MySQL only says `near 'xyz' at line n`; find that fragment to give the editor a position. */
export function errorPosition(sql: string, message: string): number | undefined {
  const m = /near '([\s\S]*?)' at line \d+/.exec(message);
  if (!m || !m[1]) return undefined;
  const idx = sql.lastIndexOf(m[1]);
  return idx === -1 ? undefined : idx;
}

export function connectionOptions(endpoint: ResolvedEndpoint): ConnectionOptions {
  const opts: ConnectionOptions = {
    charset: 'UTF8MB4_UNICODE_CI',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: true,
    typeCast: false,
    rowsAsArray: true,
    jsonStrings: true,
    decimalNumbers: false,
    connectTimeout:
      typeof endpoint.options['connectTimeoutMs'] === 'number'
        ? endpoint.options['connectTimeoutMs']
        : 10_000,
    compress: endpoint.options['compress'] === true,
  };
  if (endpoint.transport === 'socket') {
    if (endpoint.socketPath) opts.socketPath = endpoint.socketPath;
  } else {
    opts.host = endpoint.host ?? '127.0.0.1';
    opts.port = endpoint.port ?? 3306;
  }
  if (endpoint.user !== undefined) opts.user = endpoint.user;
  if (endpoint.password !== undefined) opts.password = endpoint.password;
  if (endpoint.database !== undefined) opts.database = endpoint.database;
  const tls = endpoint.tls;
  if (tls && tls.mode !== 'disabled') {
    const ssl: Record<string, unknown> = {};
    if (tls.ca) ssl['ca'] = tls.ca;
    if (tls.cert) ssl['cert'] = tls.cert;
    if (tls.key) ssl['key'] = tls.key;
    ssl['rejectUnauthorized'] = tls.mode === 'verify-ca' || tls.mode === 'verify-identity';
    if (tls.mode === 'verify-ca') ssl['checkServerIdentity'] = (): undefined => undefined;
    if (tls.mode === 'verify-identity' && tls.servername) ssl['servername'] = tls.servername;
    opts.ssl = ssl as NonNullable<ConnectionOptions['ssl']>;
  }
  return opts;
}

function connectRaw(opts: ConnectionOptions, signal?: AbortSignal): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(opts);
    const onAbort = (): void => {
      conn.destroy();
      reject(new DriverError('CANCELLED', 'Connect cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    conn.connect((err) => {
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        conn.destroy();
        reject(wrapError(err, 'connect'));
        return;
      }
      resolve(conn);
    });
  });
}

type Scalar = string | undefined;

/** Pull a plain string out of a Value for internal metadata queries. */
function s(v: Value | undefined): Scalar {
  if (!v || v.t === 'null') return undefined;
  switch (v.t) {
    case 'bytes':
    case 'geometry':
    case 'unknown':
    case 'bit':
      return Buffer.from(v.v).toString('utf8');
    case 'set':
      return v.v.join(',');
    case 'bool':
      return v.v ? '1' : '0';
    case 'float':
      return String(v.v);
    default:
      return v.v;
  }
}

function n(v: Value | undefined): number | undefined {
  const str = s(v);
  if (str === undefined) return undefined;
  const num = Number(str);
  return Number.isFinite(num) ? num : undefined;
}

export class MysqlSession implements Session {
  readonly dialect = new MysqlDialect();
  private readOnly: boolean;
  private flavor: Flavor | null = null;
  private statisticsHasExpression: boolean | null = null;
  private dead: DriverError | null = null;

  constructor(
    private readonly conn: Connection,
    private readonly endpoint: ResolvedEndpoint,
    readOnly: boolean,
  ) {
    this.readOnly = readOnly;
    conn.on('error', (err: unknown) => {
      this.dead = wrapError(err);
    });
  }

  static async open(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<MysqlSession> {
    const opts = connectionOptions(endpoint);
    let conn: Connection;
    try {
      conn = await connectRaw(opts, signal);
    } catch (err) {
      // 'preferred' means: try TLS, fall back to plain.
      if (endpoint.tls?.mode === 'preferred' && opts.ssl) {
        const plain = { ...opts };
        delete plain.ssl;
        conn = await connectRaw(plain, signal);
      } else {
        throw err;
      }
    }
    const session = new MysqlSession(conn, endpoint, endpoint.readOnly === true);
    try {
      // Raw bytes plus the column's real charset, so the driver decodes instead of the server.
      await session.exec('SET SESSION character_set_results = NULL');
      if (endpoint.readOnly) await session.exec('SET SESSION TRANSACTION READ ONLY');
      await session.exec('SET SESSION information_schema_stats_expiry = 0').catch(() => undefined);
      const init = endpoint.options['initSql'];
      if (typeof init === 'string' && init.trim()) await session.exec(init);
    } catch (err) {
      conn.destroy();
      throw wrapError(err, 'connect');
    }
    return session;
  }

  /** Run one statement, return raw rows and fields. Internal use only. */
  private raw(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: RawRow[]; fields: FieldPacket[]; ok?: OkLike }> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.conn.query(
        { sql, values, rowsAsArray: true, typeCast: false },
        (err, results, fields) => {
          if (err) {
            reject(wrapError(err));
            return;
          }
          if (isOk(results)) {
            resolve({ rows: [], fields: [], ok: results });
            return;
          }
          resolve({
            rows: results as unknown as RawRow[],
            fields: (fields ?? []) as FieldPacket[],
          });
        },
      );
    });
  }

  private async exec(sql: string): Promise<void> {
    await this.raw(sql);
  }

  /** Rows as name → Value maps, for metadata queries. */
  private async fetch(sql: string, values?: unknown[]): Promise<Record<string, Value>[]> {
    const { rows, fields } = await this.raw(sql, values);
    return rows.map((row) => {
      const out: Record<string, Value> = {};
      fields.forEach((f, i) => {
        out[f.name] = toValue(row[i], f);
      });
      return out;
    });
  }

  private async scalar(sql: string): Promise<Scalar> {
    const rows = await this.fetch(sql);
    const first = rows[0];
    if (!first) return undefined;
    return s(Object.values(first)[0]);
  }

  private async detect(): Promise<Flavor> {
    if (this.flavor) return this.flavor;
    const row = (await this.fetch('SELECT VERSION() AS v, @@version_comment AS c'))[0] ?? {};
    let auroraVersion: string | undefined;
    try {
      auroraVersion = await this.scalar('SELECT @@aurora_version');
    } catch {
      auroraVersion = undefined;
    }
    this.flavor = detectFlavor({
      version: s(row['v']) ?? '',
      versionComment: s(row['c']) ?? null,
      auroraVersion: auroraVersion ?? null,
    });
    return this.flavor;
  }

  async info(): Promise<ServerInfo> {
    const flavor = await this.detect();
    const row =
      (
        await this.fetch(
          'SELECT @@character_set_server AS cs, @@collation_server AS coll, @@time_zone AS tz, @@system_time_zone AS stz, CURRENT_USER() AS u, DATABASE() AS db',
        )
      )[0] ?? {};
    const info: ServerInfo = {
      engine: flavor.engine,
      engineName: flavor.engineName,
      version: flavor.version,
      readOnly: this.readOnly,
      extra: { fullVersion: flavor.fullVersion, threadId: String(this.conn.threadId) },
    };
    const cs = s(row['cs']);
    const coll = s(row['coll']);
    const tz = s(row['tz']);
    const stz = s(row['stz']);
    const user = s(row['u']);
    const db = s(row['db']);
    if (cs) info.charset = cs;
    if (coll) info.collation = coll;
    if (tz) info.timezone = tz === 'SYSTEM' && stz ? `SYSTEM (${stz})` : tz;
    if (user) info.user = user;
    if (db) info.currentSchema = db;
    return info;
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const current = await this.scalar('SELECT DATABASE()');
    const rows = await this.fetch(
      'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS coll FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    return rows.map((r) => {
      const name = s(r['name']) ?? '';
      const out: SchemaInfo = {
        name,
        isSystem: SYSTEM_SCHEMAS.has(name.toLowerCase()),
        isCurrent: name === current,
      };
      const cs = s(r['cs']);
      const coll = s(r['coll']);
      if (cs) out.charset = cs;
      if (coll) out.collation = coll;
      return out;
    });
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const out: DbObject[] = [];
    const tables = await this.fetch(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_, DATA_LENGTH AS dl, INDEX_LENGTH AS il, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [schema],
    );
    for (const r of tables) {
      const type = (s(r['type']) ?? '').toUpperCase();
      const o: DbObject = {
        kind: type.includes('VIEW') ? 'view' : 'table',
        schema,
        name: s(r['name']) ?? '',
      };
      const engine = s(r['engine']);
      const rows = n(r['rows_']);
      const dl = n(r['dl']);
      const il = n(r['il']);
      const comment = s(r['comment']);
      if (engine) o.engine = engine;
      if (rows !== undefined && o.kind === 'table') o.rowEstimate = rows;
      if (dl !== undefined) o.dataLength = dl;
      if (il !== undefined) o.indexLength = il;
      if (comment && comment !== 'VIEW') o.comment = comment;
      out.push(o);
    }
    const optional = async (
      sql: string,
      map: (r: Record<string, Value>) => DbObject,
    ): Promise<void> => {
      try {
        for (const r of await this.fetch(sql, [schema])) out.push(map(r));
      } catch {
        /* engine without this information_schema table (TiDB has no EVENTS, for one) */
      }
    };
    await optional(
      'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
      (r) => {
        const o: DbObject = {
          kind: 'routine',
          schema,
          name: s(r['name']) ?? '',
          extra: { type: (s(r['type']) ?? '').toLowerCase() },
        };
        const c = s(r['comment']);
        if (c) o.comment = c;
        return o;
      },
    );
    await optional(
      'SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS ev, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      (r) => ({
        kind: 'trigger',
        schema,
        name: s(r['name']) ?? '',
        extra: { table: s(r['tbl']) ?? '', timing: s(r['timing']) ?? '', event: s(r['ev']) ?? '' },
      }),
    );
    await optional(
      'SELECT EVENT_NAME AS name, EVENT_TYPE AS type, STATUS AS status, EVENT_COMMENT AS comment FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
      (r) => {
        const o: DbObject = {
          kind: 'event',
          schema,
          name: s(r['name']) ?? '',
          extra: { type: s(r['type']) ?? '', status: s(r['status']) ?? '' },
        };
        const c = s(r['comment']);
        if (c) o.comment = c;
        return o;
      },
    );
    return out;
  }

  private async hasStatisticsExpression(): Promise<boolean> {
    if (this.statisticsHasExpression !== null) return this.statisticsHasExpression;
    const count = await this.scalar(
      "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'STATISTICS' AND COLUMN_NAME = 'EXPRESSION'",
    );
    this.statisticsHasExpression = count !== undefined && Number(count) > 0;
    return this.statisticsHasExpression;
  }

  private columnDefault(
    r: Record<string, Value>,
    valueType: ColumnDefinition['valueType'],
    extra: string,
  ): ColumnDefinition['default'] {
    const dflt = r['dflt'];
    if (!dflt || dflt.t === 'null') return undefined;
    const text = s(dflt) ?? '';
    const isMaria = this.flavor?.engine === 'mariadb';
    if (/DEFAULT_GENERATED/i.test(extra)) return { t: 'expression', sql: text };
    if (/^CURRENT_TIMESTAMP(\(\d*\))?$/i.test(text) || /^current_timestamp(\(\d*\))?$/.test(text)) {
      return { t: 'expression', sql: text };
    }
    if (isMaria) {
      // MariaDB 10.2+ returns defaults as SQL: NULL, 'quoted string', or an expression.
      if (text === 'NULL') return V.null();
      const quoted = /^'([\s\S]*)'$/.exec(text);
      if (quoted) return V.text(quoted[1]!.replace(/''/g, "'").replace(/\\(.)/g, '$1'));
      if (/^-?\d+(\.\d+)?$/.test(text))
        return valueType === 'int'
          ? V.int(text)
          : valueType === 'decimal'
            ? V.decimal(text)
            : V.float(Number(text));
      return { t: 'expression', sql: text };
    }
    switch (valueType) {
      case 'int':
        return /^-?\d+$/.test(text) ? V.int(text) : { t: 'expression', sql: text };
      case 'decimal':
        return V.decimal(text);
      case 'float':
        return V.float(Number(text));
      case 'date':
        return V.date(text);
      case 'time':
        return V.time(text);
      case 'datetime':
        return V.datetime(text);
      case 'json':
        return V.json(text);
      case 'bit':
        return { t: 'expression', sql: text };
      case 'enum':
        return V.enum(text);
      case 'set':
        return V.set(text === '' ? [] : text.split(','));
      default:
        return V.text(text);
    }
  }

  async describeObject(
    schema: string,
    kind: DbObjectKind,
    name: string,
  ): Promise<ObjectDefinition> {
    const q = this.dialect.quoteIdentifier.bind(this.dialect);
    const props: ObjectDefinition['properties'] = [];
    const add = (label: string, value: Scalar): void => {
      if (value !== undefined && value !== '') props.push({ label, value: String(value) });
    };
    /** SHOW CREATE needs privileges a read-only user may lack; information_schema is the fallback. */
    const showCreate = async (sql: string, column: string): Promise<string | undefined> => {
      try {
        return s((await this.fetch(sql))[0]?.[column]);
      } catch {
        return undefined;
      }
    };
    let ddl: string | undefined;
    switch (kind) {
      case 'routine': {
        const r = (
          await this.fetch(
            'SELECT ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns_, ROUTINE_DEFINITION AS body, IS_DETERMINISTIC AS det, SQL_DATA_ACCESS AS access, SECURITY_TYPE AS sec, DEFINER AS definer, CREATED AS created, LAST_ALTERED AS altered, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?',
            [schema, name],
          )
        )[0];
        if (!r) throw new DriverError('QUERY_FAILED', `No routine named ${schema}.${name}`);
        const type = (s(r['type']) ?? 'PROCEDURE').toUpperCase();
        add('Type', type.toLowerCase());
        try {
          const params = await this.fetch(
            'SELECT PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS type FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ORDINAL_POSITION > 0 ORDER BY ORDINAL_POSITION',
            [schema, name],
          );
          add(
            'Parameters',
            params
              .map((p) => [s(p['mode']), s(p['name']), s(p['type'])].filter(Boolean).join(' '))
              .join(', ') || 'none',
          );
        } catch {
          /* PARAMETERS is missing on very old servers */
        }
        if (type === 'FUNCTION') add('Returns', s(r['returns_']));
        add('Deterministic', s(r['det'])?.toLowerCase());
        add('Data access', s(r['access'])?.toLowerCase().replace(/_/g, ' '));
        add('Security', s(r['sec'])?.toLowerCase());
        add('Definer', s(r['definer']));
        add('Created', s(r['created']));
        add('Last changed', s(r['altered']));
        add('Comment', s(r['comment']));
        ddl =
          (await showCreate(
            `SHOW CREATE ${type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE'} ${q(schema)}.${q(name)}`,
            type === 'FUNCTION' ? 'Create Function' : 'Create Procedure',
          )) ?? s(r['body']);
        break;
      }
      case 'trigger': {
        const r = (
          await this.fetch(
            'SELECT EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS ev, ACTION_ORIENTATION AS orient, ACTION_STATEMENT AS body, DEFINER AS definer, CREATED AS created FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?',
            [schema, name],
          )
        )[0];
        if (!r) throw new DriverError('QUERY_FAILED', `No trigger named ${schema}.${name}`);
        add('Table', s(r['tbl']));
        add(
          'Fires',
          `${s(r['timing']) ?? ''} ${s(r['ev']) ?? ''}, for each ${(s(r['orient']) ?? 'row').toLowerCase()}`.trim(),
        );
        add('Definer', s(r['definer']));
        add('Created', s(r['created']));
        ddl =
          (await showCreate(
            `SHOW CREATE TRIGGER ${q(schema)}.${q(name)}`,
            'SQL Original Statement',
          )) ?? s(r['body']);
        break;
      }
      case 'event': {
        const r = (
          await this.fetch(
            'SELECT EVENT_TYPE AS type, EXECUTE_AT AS at_, INTERVAL_VALUE AS iv, INTERVAL_FIELD AS iff, STARTS AS starts, ENDS AS ends, STATUS AS status, ON_COMPLETION AS oc, LAST_EXECUTED AS last_, EVENT_DEFINITION AS body, DEFINER AS definer, EVENT_COMMENT AS comment FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?',
            [schema, name],
          )
        )[0];
        if (!r) throw new DriverError('QUERY_FAILED', `No event named ${schema}.${name}`);
        const recurring = s(r['type']) === 'RECURRING';
        add(
          'Schedule',
          recurring
            ? `every ${s(r['iv']) ?? ''} ${(s(r['iff']) ?? '').toLowerCase().replace(/_/g, ' ')}`
            : `once, at ${s(r['at_']) ?? '?'}`,
        );
        if (recurring) {
          add('Starts', s(r['starts']));
          add('Ends', s(r['ends']));
        }
        add('Status', s(r['status'])?.toLowerCase().replace(/_/g, ' '));
        add('When finished', s(r['oc'])?.toLowerCase().replace(/_/g, ' '));
        add('Last run', s(r['last_']) ?? 'never');
        add('Definer', s(r['definer']));
        add('Comment', s(r['comment']));
        const scheduler = await this.scalar('SELECT @@event_scheduler').catch(() => undefined);
        add(
          'Event scheduler',
          scheduler === undefined ? undefined : String(scheduler).toLowerCase(),
        );
        ddl =
          (await showCreate(`SHOW CREATE EVENT ${q(schema)}.${q(name)}`, 'Create Event')) ??
          s(r['body']);
        break;
      }
      case 'view': {
        ddl = await showCreate(`SHOW CREATE VIEW ${q(schema)}.${q(name)}`, 'Create View');
        break;
      }
      default:
        throw new DriverError('UNSUPPORTED', `Cannot describe a ${kind}`);
    }
    return { schema, name, kind, ddl: ddl ?? '', properties: props };
  }

  async describeTable(schema: string, table: string): Promise<TableDefinition> {
    await this.detect();
    const tbl = (
      await this.fetch(
        'SELECT TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS rf, AUTO_INCREMENT AS ai, TABLE_COLLATION AS coll, CREATE_OPTIONS AS co, TABLE_COMMENT AS comment, TABLE_ROWS AS rows_ FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [schema, table],
      )
    )[0];
    if (!tbl) throw new DriverError('QUERY_FAILED', `No table or view named ${schema}.${table}`);
    const kind = (s(tbl['type']) ?? '').toUpperCase().includes('VIEW') ? 'view' : 'table';

    let colRows = await this.fetch(
      'SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS ord, COLUMN_TYPE AS ct, DATA_TYPE AS dt, IS_NULLABLE AS nul, COLUMN_DEFAULT AS dflt, EXTRA AS extra, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll, COLUMN_COMMENT AS comment, COLUMN_KEY AS ck, GENERATION_EXPRESSION AS gen FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [schema, table],
    );
    if (colRows.length === 0) {
      // MySQL 8 lists performance_schema tables in TABLES but hides their COLUMNS from unprivileged users.
      const q = this.dialect.quoteIdentifier.bind(this.dialect);
      colRows = (await this.fetch(`SHOW FULL COLUMNS FROM ${q(schema)}.${q(table)}`)).map(
        (r, i) => {
          const ct = s(r['Type']) ?? '';
          const coll = r['Collation'];
          const collName = s(coll);
          const out: Record<string, Value> = {
            name: r['Field'] ?? V.null(),
            ord: V.int(i + 1),
            ct: V.text(ct),
            dt: V.text(ct.replace(/[(\s].*$/, '')),
            nul: r['Null'] ?? V.text('YES'),
            dflt: r['Default'] ?? V.null(),
            extra: r['Extra'] ?? V.text(''),
            cs: collName ? V.text(collName.replace(/_.*$/, '')) : V.null(),
            coll: coll ?? V.null(),
            comment: r['Comment'] ?? V.null(),
            ck: r['Key'] ?? V.text(''),
            gen: V.null(),
          };
          return out;
        },
      );
    }
    if (colRows.length === 0) {
      // Still nothing: derive the columns from result metadata of an empty select.
      const q = this.dialect.quoteIdentifier.bind(this.dialect);
      const { fields } = await this.raw(`SELECT * FROM ${q(schema)}.${q(table)} LIMIT 0`);
      if (fields.length === 0) {
        throw new DriverError('QUERY_FAILED', `Cannot read the columns of ${schema}.${table}`);
      }
      colRows = fields.map((f, i) => {
        const flags = typeof f.flags === 'number' ? f.flags : 0;
        const native = nativeTypeName(f).toLowerCase();
        return {
          name: V.text(f.name),
          ord: V.int(i + 1),
          ct: V.text(native),
          dt: V.text(native.replace(/[(\s].*$/, '')),
          nul: V.text(flags & FLAG.NOT_NULL ? 'NO' : 'YES'),
          dflt: V.null(),
          extra: V.text(flags & FLAG.AUTO_INCREMENT ? 'auto_increment' : ''),
          cs:
            f.characterSet !== undefined && f.characterSet !== 63
              ? V.text(charsetNameOf(f))
              : V.null(),
          coll: V.null(),
          comment: V.null(),
          ck: V.text(flags & FLAG.PRI_KEY ? 'PRI' : ''),
          gen: V.null(),
        } as Record<string, Value>;
      });
    }
    const pk: string[] = [];
    const columns: ColumnDefinition[] = colRows.map((r) => {
      const name = s(r['name']) ?? '';
      const nativeType = s(r['ct']) ?? s(r['dt']) ?? '';
      const extra = s(r['extra']) ?? '';
      const valueType = dataTypeToValueType(s(r['dt']) ?? '', nativeType);
      if ((s(r['ck']) ?? '') === 'PRI') pk.push(name);
      const col: ColumnDefinition = {
        name,
        ordinal: n(r['ord']) ?? 0,
        nativeType,
        valueType,
        nullable: (s(r['nul']) ?? '').toUpperCase() === 'YES',
        autoIncrement: /auto_increment/i.test(extra),
      };
      const dflt = this.columnDefault(r, valueType, extra);
      if (dflt !== undefined) col.default = dflt;
      const cs = s(r['cs']);
      const coll = s(r['coll']);
      const comment = s(r['comment']);
      const gen = s(r['gen']);
      if (cs) col.charset = cs;
      if (coll) col.collation = coll;
      if (comment) col.comment = comment;
      const extraFlags = extra
        .replace(/auto_increment/i, '')
        .replace(/DEFAULT_GENERATED/i, '')
        .replace(/(VIRTUAL|STORED|PERSISTENT) GENERATED|VIRTUAL|PERSISTENT|STORED/i, '')
        .trim();
      if (extraFlags) col.extra = extraFlags;
      if (gen) col.generated = { expression: gen, stored: /STORED|PERSISTENT/i.test(extra) };
      return col;
    });

    const withExpr = await this.hasStatisticsExpression();
    const idxRows = await this.fetch(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nu, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, COLLATION AS coll, SUB_PART AS sub, INDEX_TYPE AS type, INDEX_COMMENT AS comment${withExpr ? ', EXPRESSION AS expr' : ''} FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, table],
    );
    const indexes = new Map<string, IndexDefinition>();
    for (const r of idxRows) {
      const name = s(r['name']) ?? '';
      let ix = indexes.get(name);
      if (!ix) {
        ix = {
          name,
          unique: (s(r['nu']) ?? '1') === '0',
          primary: name === 'PRIMARY',
          columns: [],
        };
        const type = s(r['type']);
        const comment = s(r['comment']);
        if (type) ix.type = type;
        if (comment) ix.comment = comment;
        indexes.set(name, ix);
      }
      const col: IndexDefinition['columns'][number] = {};
      const colName = s(r['col']);
      const expr = s(r['expr']);
      if (colName) col.name = colName;
      else if (expr) col.expression = expr;
      const coll = s(r['coll']);
      if (coll === 'A') col.order = 'asc';
      if (coll === 'D') col.order = 'desc';
      const sub = n(r['sub']);
      if (sub !== undefined) col.length = sub;
      ix.columns.push(col);
    }

    const fkRows = await this.fetch(
      'SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rs, k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc, r.UPDATE_RULE AS upd, r.DELETE_RULE AS del FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION',
      [schema, table],
    );
    const fks = new Map<string, ForeignKeyDefinition>();
    for (const r of fkRows) {
      const name = s(r['name']) ?? '';
      let fk = fks.get(name);
      if (!fk) {
        fk = { name, columns: [], referencedTable: s(r['rt']) ?? '', referencedColumns: [] };
        const rs = s(r['rs']);
        const upd = s(r['upd']);
        const del = s(r['del']);
        if (rs) fk.referencedSchema = rs;
        if (upd) fk.onUpdate = upd;
        if (del) fk.onDelete = del;
        fks.set(name, fk);
      }
      fk.columns.push(s(r['col']) ?? '');
      fk.referencedColumns.push(s(r['rc']) ?? '');
    }

    const options: Record<string, string> = {};
    for (const [key, field] of [
      ['engine', 'engine'],
      ['row_format', 'rf'],
      ['auto_increment', 'ai'],
      ['collation', 'coll'],
      ['create_options', 'co'],
    ] as const) {
      const v = s(tbl[field]);
      if (v) options[key] = v;
    }

    const def: TableDefinition = {
      schema,
      name: table,
      kind,
      columns,
      indexes: [...indexes.values()],
      foreignKeys: [...fks.values()],
      options,
    };
    if (pk.length) def.primaryKey = pk;
    const comment = s(tbl['comment']);
    if (comment && comment !== 'VIEW') def.comment = comment;
    const rows = n(tbl['rows_']);
    if (rows !== undefined && kind === 'table') def.rowEstimate = rows;
    try {
      const q = this.dialect.quoteIdentifier.bind(this.dialect);
      const create = await this.raw(
        `SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${q(schema)}.${q(table)}`,
      );
      const row = create.rows[0];
      const cell = row?.[1];
      if (cell) def.ddl = Buffer.from(cell).toString('utf8');
    } catch {
      /* no SHOW CREATE privilege; the definition is still useful */
    }
    return def;
  }

  private columnMeta(fields: FieldPacket[]): ColumnMeta[] {
    return fields.map((f) => {
      const flags = typeof f.flags === 'number' ? f.flags : 0;
      const meta: ColumnMeta = {
        name: f.name,
        nativeType: nativeTypeName(f),
        valueType: fieldValueType(f),
        nullable: (flags & FLAG.NOT_NULL) === 0,
        isPrimaryKey: (flags & FLAG.PRI_KEY) !== 0,
      };
      if (f.characterSet !== undefined && f.characterSet !== 63) meta.charset = charsetNameOf(f);
      const schema = f.schema ?? f.db;
      if (schema) meta.schema = schema;
      if (f.orgTable) meta.table = f.orgTable;
      else if (f.table) meta.table = f.table;
      if (f.orgName && f.orgName !== f.name) meta.originalName = f.orgName;
      return meta;
    });
  }

  private async killCurrentQuery(): Promise<void> {
    const threadId = this.conn.threadId;
    if (!threadId) return;
    const opts = { ...connectionOptions(this.endpoint), multipleStatements: false };
    try {
      const killer = await connectRaw(opts);
      await new Promise<void>((resolve) => {
        killer.query(`KILL QUERY ${threadId}`, () => {
          killer.end(() => resolve());
        });
      });
    } catch {
      /* best effort; the query will finish on its own */
    }
  }

  async *query(sql: string, opts: QueryOptions = {}): AsyncIterable<QueryEvent> {
    const started = Date.now();
    if (this.dead) {
      yield { kind: 'error', resultIndex: 0, code: this.dead.code, message: this.dead.message };
      return;
    }
    const signal = opts.signal;
    const batchSize = Math.min(Math.max(opts.rowBatchSize ?? 256, 1), 5000);
    const highWater = batchSize * 4;
    const lowWater = batchSize;
    const values = opts.params?.map(toParam);

    type Item =
      | { type: 'fields'; fields: FieldPacket[] | undefined; index: number }
      | { type: 'row'; row: RawRow; index: number }
      | { type: 'ok'; ok: OkLike; index: number }
      | { type: 'end' }
      | { type: 'error'; err: unknown };

    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    let paused = false;
    const push = (item: Item): void => {
      queue.push(item);
      if (queue.length > highWater && !paused) {
        paused = true;
        this.conn.pause();
      }
      wake?.();
      wake = null;
    };

    let killed = false;
    let killDone: Promise<void> | null = null;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      killDone = this.killCurrentQuery();
    };
    signal?.addEventListener('abort', kill, { once: true });

    // mysql2 emits 'fields' without an index and 'result' with one that lags for OK packets; count ourselves.
    let resultCounter = -1;
    const q = this.conn.query({ sql, values: values as never, rowsAsArray: true, typeCast: false });
    q.on('fields', (fields: FieldPacket[] | undefined) => {
      resultCounter++;
      push({ type: 'fields', fields, index: resultCounter });
    });
    q.on('result', (row: unknown) =>
      isOk(row)
        ? push({ type: 'ok', ok: row, index: resultCounter })
        : push({ type: 'row', row: row as RawRow, index: resultCounter }),
    );
    q.on('end', () => push({ type: 'end' }));
    q.on('error', (err: unknown) => push({ type: 'error', err }));

    let current: { index: number; fields: FieldPacket[]; batch: Value[][]; count: number } | null =
      null;
    let truncated = false;
    let draining = false;
    let wantWarnings = false;

    const finishCurrent = (more: boolean, warnings: Warning[] = []): QueryEvent[] => {
      if (!current) return [];
      const out: QueryEvent[] = [];
      if (current.batch.length)
        out.push({ kind: 'rows', resultIndex: current.index, rows: current.batch });
      out.push({
        kind: 'done',
        resultIndex: current.index,
        more,
        rowCount: current.count,
        truncated,
        elapsedMs: Date.now() - started,
        warnings,
      });
      current = null;
      return out;
    };

    try {
      for (;;) {
        while (queue.length === 0) {
          await new Promise<void>((res) => {
            wake = res;
          });
        }
        const item = queue.shift() as Item;
        if (paused && queue.length < lowWater) {
          paused = false;
          this.conn.resume();
        }
        switch (item.type) {
          case 'fields': {
            if (!item.fields) break; // an OK packet follows as 'result'
            for (const e of finishCurrent(true)) yield e;
            current = { index: item.index, fields: item.fields, batch: [], count: 0 };
            yield {
              kind: 'columns',
              resultIndex: item.index,
              columns: this.columnMeta(item.fields),
            };
            break;
          }
          case 'row': {
            if (draining || !current) break;
            current.batch.push(
              item.row.map((cell, i) => toValue(cell, current!.fields[i] as FieldPacket)),
            );
            current.count++;
            if (current.batch.length >= batchSize) {
              const rows = current.batch;
              current.batch = [];
              yield { kind: 'rows', resultIndex: current.index, rows };
            }
            if (opts.maxRows !== undefined && current.count >= opts.maxRows) {
              truncated = true;
              draining = true;
              kill();
            }
            break;
          }
          case 'ok': {
            for (const e of finishCurrent(true)) yield e;
            const more = (item.ok.serverStatus & SERVER_MORE_RESULTS_EXISTS) !== 0;
            if (item.ok.warningStatus > 0) wantWarnings = true;
            const done: QueryEvent = {
              kind: 'done',
              resultIndex: item.index,
              more,
              affectedRows: item.ok.affectedRows,
              insertId: String(item.ok.insertId),
              elapsedMs: Date.now() - started,
              warnings: [],
            };
            yield done;
            break;
          }
          case 'end': {
            if (killed && !truncated) {
              yield {
                kind: 'error',
                resultIndex: current?.index ?? 0,
                code: 'CANCELLED',
                message: 'Query cancelled',
              };
              return;
            }
            const warnings = wantWarnings ? await this.showWarnings() : [];
            const tail = finishCurrent(false, warnings);
            if (tail.length === 0 && warnings.length) {
              // Warnings belonged to an OK result we already reported; surface them on a trailing done.
              yield {
                kind: 'done',
                resultIndex: 0,
                more: false,
                elapsedMs: Date.now() - started,
                warnings,
              };
            }
            for (const e of tail) yield e;
            return;
          }
          case 'error': {
            const e = wrapError(item.err);
            if (truncated && draining) {
              for (const ev of finishCurrent(false)) yield ev;
              return;
            }
            if (killed || e.code === 'CANCELLED') {
              yield {
                kind: 'error',
                resultIndex: current?.index ?? 0,
                code: 'CANCELLED',
                message: 'Query cancelled',
              };
              return;
            }
            const ev: QueryEvent = {
              kind: 'error',
              resultIndex: current?.index ?? 0,
              code: e.code,
              message: e.message,
            };
            if (e.sqlState !== undefined) ev.sqlState = e.sqlState;
            const pos = errorPosition(sql, e.message);
            if (pos !== undefined) ev.position = pos;
            yield ev;
            return;
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', kill);
      if (paused) this.conn.resume();
      // Never let a KILL QUERY still in flight land on the caller's next statement.
      if (killDone) await killDone;
    }
  }

  private async showWarnings(): Promise<Warning[]> {
    try {
      const rows = await this.fetch('SHOW WARNINGS');
      return rows.map((r) => {
        const w: Warning = { message: s(r['Message']) ?? '' };
        const code = s(r['Code']);
        const level = (s(r['Level']) ?? '').toLowerCase();
        if (code) w.code = code;
        if (level === 'note' || level === 'warning') w.level = level;
        return w;
      });
    } catch {
      return [];
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const { rows, fields } = await this.raw(`EXPLAIN ${sql}`);
    return {
      format: 'table',
      columns: this.columnMeta(fields),
      rows: rows.map((row) => row.map((cell, i) => toValue(cell, fields[i] as FieldPacket))),
    };
  }

  async setReadOnly(on: boolean): Promise<void> {
    await this.exec(`SET SESSION TRANSACTION ${on ? 'READ ONLY' : 'READ WRITE'}`);
    this.readOnly = on;
  }

  async begin(): Promise<void> {
    await this.exec('START TRANSACTION');
  }

  async commit(): Promise<void> {
    await this.exec('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.exec('ROLLBACK');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.conn.end(() => resolve());
      setTimeout(() => {
        this.conn.destroy();
        resolve();
      }, 2000).unref();
    });
  }
}

const TYPE_NAMES: Record<number, string> = {
  0x00: 'DECIMAL',
  0x01: 'TINYINT',
  0x02: 'SMALLINT',
  0x03: 'INT',
  0x04: 'FLOAT',
  0x05: 'DOUBLE',
  0x06: 'NULL',
  0x07: 'TIMESTAMP',
  0x08: 'BIGINT',
  0x09: 'MEDIUMINT',
  0x0a: 'DATE',
  0x0b: 'TIME',
  0x0c: 'DATETIME',
  0x0d: 'YEAR',
  0x0e: 'DATE',
  0x0f: 'VARCHAR',
  0x10: 'BIT',
  0xf2: 'VECTOR',
  0xf5: 'JSON',
  0xf6: 'DECIMAL',
  0xf7: 'ENUM',
  0xf8: 'SET',
  0xf9: 'TINYBLOB',
  0xfa: 'MEDIUMBLOB',
  0xfb: 'LONGBLOB',
  0xfc: 'BLOB',
  0xfd: 'VARCHAR',
  0xfe: 'CHAR',
  0xff: 'GEOMETRY',
};

function nativeTypeName(f: FieldPacket): string {
  const type = f.columnType ?? f.type ?? 0xfd;
  const flags = typeof f.flags === 'number' ? f.flags : 0;
  if (f.extendedTypeName) return f.extendedTypeName.toUpperCase();
  if (flags & FLAG.ENUM) return 'ENUM';
  if (flags & FLAG.SET) return 'SET';
  let name = TYPE_NAMES[type] ?? `TYPE_${type}`;
  const binary = f.characterSet === 63;
  if (binary) {
    if (type === 0xfd) name = 'VARBINARY';
    else if (type === 0xfe) name = 'BINARY';
  } else if (type >= 0xf9 && type <= 0xfc) {
    name = name.replace('BLOB', 'TEXT');
  }
  if (flags & FLAG.UNSIGNED && type <= 0x09 && type !== 0x06) name += ' UNSIGNED';
  return name;
}

function charsetNameOf(f: FieldPacket): string {
  const nr = f.characterSet;
  if (nr === undefined) return f.encoding ?? 'unknown';
  if (nr === 45 || nr === 46 || (nr >= 224 && nr <= 247) || nr >= 255) return 'utf8mb4';
  if (nr === 33 || nr === 83 || (nr >= 192 && nr <= 215) || nr === 223) return 'utf8mb3';
  if ([5, 8, 15, 31, 47, 48, 49, 94].includes(nr)) return 'latin1';
  return f.encoding ?? `charset-${nr}`;
}
