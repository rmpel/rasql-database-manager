import pg from 'pg';
import Cursor from 'pg-cursor';
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
  type Warning,
} from '@rasql/driver-protocol';
import { PostgresDialect, fkRule, shortTypeName } from './dialect.js';
import { splitPostgres } from './split.js';
import { parseDefault } from './defaults.js';
import { toParam, toValue, typeNameOf, valueTypeOf, type PgType } from './values.js';

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

/** Every type parser is the identity: cells stay the text the server printed. */
const RAW_TYPES = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
/** Separates list items inside one text cell; never appears in identifiers people use. */
const SEP = '\u001f';

interface PgNativeError extends Error {
  code?: string;
  position?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  where?: string;
}

export function wrapError(err: unknown, phase: 'connect' | 'query' = 'query'): DriverError {
  if (err instanceof DriverError) return err;
  const e = err as PgNativeError;
  const message = [e.message ?? String(err), e.detail, e.hint ? `Hint: ${e.hint}` : undefined]
    .filter(Boolean)
    .join('\n');
  const details: Record<string, unknown> = {};
  if (e.severity) details['severity'] = e.severity;
  if (e.code) details['code'] = e.code;
  const sqlState = e.code && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
  const extra = { details, cause: err, ...(sqlState ? { sqlState } : {}) };
  switch (e.code) {
    case '28P01':
    case '28000':
      return new DriverError('AUTH_FAILED', message, extra);
    case '57014':
      return new DriverError('CANCELLED', message, extra);
    case '25006':
      return new DriverError('READ_ONLY_VIOLATION', message, extra);
    case 'ETIMEDOUT':
      return new DriverError('TIMEOUT', message, extra);
  }
  if (phase === 'connect' || (e.code && /^(08|3D|E[A-Z]+)/.test(e.code)))
    return new DriverError('CONNECTION_FAILED', message, extra);
  return new DriverError('QUERY_FAILED', message, extra);
}

export function clientConfig(endpoint: ResolvedEndpoint): pg.ClientConfig {
  const timeout = endpoint.options['connectTimeoutMs'];
  const config: pg.ClientConfig = {
    application_name: 'RaSQL',
    connectionTimeoutMillis: typeof timeout === 'number' ? timeout : 10_000,
    types: RAW_TYPES,
    database: endpoint.database || 'postgres',
  };
  if (endpoint.transport === 'socket' && endpoint.socketPath) {
    // libpq style: a directory holding .s.PGSQL.<port>; a full socket path is reduced to it.
    const m = /^(.*)\/\.s\.PGSQL\.(\d+)$/.exec(endpoint.socketPath);
    config.host = m ? (m[1] as string) : endpoint.socketPath;
    config.port = m ? Number(m[2]) : (endpoint.port ?? 5432);
  } else {
    config.host = endpoint.host ?? '127.0.0.1';
    config.port = endpoint.port ?? 5432;
  }
  if (endpoint.user !== undefined) config.user = endpoint.user;
  if (endpoint.password !== undefined) config.password = endpoint.password;
  const tls = endpoint.tls;
  if (tls && tls.mode !== 'disabled') {
    const ssl: Record<string, unknown> = {
      rejectUnauthorized: tls.mode === 'verify-ca' || tls.mode === 'verify-identity',
    };
    if (tls.ca) ssl['ca'] = tls.ca;
    if (tls.cert) ssl['cert'] = tls.cert;
    if (tls.key) ssl['key'] = tls.key;
    if (tls.mode === 'verify-ca') ssl['checkServerIdentity'] = (): undefined => undefined;
    if (tls.servername) ssl['servername'] = tls.servername;
    config.ssl = ssl as pg.ClientConfig['ssl'];
  }
  return config;
}

async function connectClient(config: pg.ClientConfig, signal?: AbortSignal): Promise<PgClient> {
  const client = new Client(config);
  const onAbort = (): void => void client.end().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
  } catch (err) {
    if (signal?.aborted) throw new DriverError('CANCELLED', 'Connect cancelled');
    throw wrapError(err, 'connect');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return client;
}

type Row = Record<string, string | null>;

const str = (v: string | null | undefined): string | undefined =>
  v === null || v === undefined ? undefined : v;
const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v: string | null | undefined): boolean => v === 't' || v === 'true';
const list = (v: string | null | undefined): string[] => (v ? v.split(SEP) : []);

export class PostgresSession implements Session {
  readonly dialect = new PostgresDialect();
  private readOnly: boolean;
  private types = new Map<number, PgType>();
  private typesStale = true;
  private dead: DriverError | null = null;
  private notices: Warning[] = [];

  private constructor(
    private readonly client: PgClient,
    private readonly config: pg.ClientConfig,
    readOnly: boolean,
  ) {
    this.readOnly = readOnly;
    client.on('error', (err: unknown) => {
      this.dead = wrapError(err, 'connect');
    });
    client.on('notice', (msg) => {
      const w: Warning = {
        message: msg.message ?? '',
        level: msg.severity === 'WARNING' ? 'warning' : 'note',
      };
      if (msg.code) w.code = msg.code;
      this.notices.push(w);
    });
  }

  static async open(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<PostgresSession> {
    const config = clientConfig(endpoint);
    let client: PgClient;
    try {
      client = await connectClient(config, signal);
    } catch (err) {
      // 'preferred' means: try TLS, fall back to plain.
      if (endpoint.tls?.mode === 'preferred' && config.ssl && !signal?.aborted) {
        const plain = { ...config };
        delete plain.ssl;
        client = await connectClient(plain, signal);
      } else throw err;
    }
    const session = new PostgresSession(client, config, endpoint.readOnly === true);
    try {
      // The literal and value formats the dialect and the value reader rely on.
      await session.exec(
        "SET standard_conforming_strings = on; SET bytea_output = 'hex'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres'",
      );
      if (endpoint.readOnly) await session.exec('SET default_transaction_read_only = on');
      const init = endpoint.options['initSql'];
      if (typeof init === 'string' && init.trim()) await session.exec(init);
      await session.loadTypes();
    } catch (err) {
      await client.end().catch(() => undefined);
      throw wrapError(err, 'connect');
    }
    return session;
  }

  private async exec(sql: string): Promise<void> {
    if (this.dead) throw this.dead;
    try {
      await this.client.query(sql);
    } catch (err) {
      throw wrapError(err);
    }
  }

  /** Rows as name → text maps, for catalog queries. */
  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    if (this.dead) throw this.dead;
    try {
      const r = await this.client.query({ text: sql, values: params, types: RAW_TYPES });
      return r.rows as Row[];
    } catch (err) {
      throw wrapError(err);
    }
  }

  private async one(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    return (await this.rows(sql, params))[0];
  }

  private async loadTypes(): Promise<void> {
    const rows = await this.rows(
      'SELECT oid, typname, typtype, typcategory, typbasetype FROM pg_catalog.pg_type',
    );
    this.types = new Map(
      rows.map((r) => [
        Number(r['oid']),
        {
          oid: Number(r['oid']),
          name: r['typname'] ?? '',
          type: r['typtype'] ?? 'b',
          category: r['typcategory'] ?? 'U',
          base: Number(r['typbasetype'] ?? 0),
        },
      ]),
    );
    this.typesStale = false;
  }

  async info(): Promise<ServerInfo> {
    const r =
      (await this.one(
        "SELECT current_setting('server_version') AS v, version() AS full_, current_setting('server_encoding') AS enc, current_setting('TimeZone') AS tz, current_user AS u, current_schema() AS s, current_database() AS db, d.datcollate AS coll, pg_backend_pid() AS pid FROM pg_database d WHERE d.datname = current_database()",
      )) ?? {};
    const full = r['full_'] ?? '';
    const info: ServerInfo = {
      engine: 'postgres',
      engineName: 'PostgreSQL',
      version: (r['v'] ?? '').split(' ')[0] ?? '',
      readOnly: this.readOnly,
      extra: { fullVersion: full, database: r['db'] ?? '', pid: r['pid'] ?? '' },
    };
    const cs = str(r['enc']);
    const coll = str(r['coll']);
    const tz = str(r['tz']);
    const user = str(r['u']);
    const schema = str(r['s']);
    if (cs) info.charset = cs;
    if (coll) info.collation = coll;
    if (tz) info.timezone = tz;
    if (user) info.user = user;
    if (schema) info.currentSchema = schema;
    if (/Supabase|Neon|CockroachDB|Redshift/i.test(full))
      info.versionComment = full.replace(/^PostgreSQL [^ ]+ /, '');
    return info;
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const rows = await this.rows(
      "SELECT n.nspname AS name, n.nspname = current_schema() AS cur FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%' ORDER BY n.nspname",
    );
    return rows.map((r) => {
      const name = r['name'] ?? '';
      return { name, isSystem: SYSTEM_SCHEMAS.has(name), isCurrent: bool(r['cur']) };
    });
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const out: DbObject[] = [];
    const rels = await this.rows(
      `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS est,
        CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_catalog.pg_relation_size(c.oid) END AS dl,
        CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_catalog.pg_indexes_size(c.oid) END AS il,
        pg_catalog.obj_description(c.oid, 'pg_class') AS comment, c.relispartition AS part
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       ORDER BY c.relname`,
      [schema],
    );
    for (const r of rels) {
      const k = r['kind'];
      const kind: DbObject['kind'] =
        k === 'v' || k === 'm' ? 'view' : k === 'S' ? 'sequence' : 'table';
      const o: DbObject = { kind, schema, name: r['name'] ?? '' };
      const est = num(r['est']);
      // -1 means never analysed.
      if (kind === 'table' && est !== undefined && est >= 0) o.rowEstimate = est;
      const dl = num(r['dl']);
      const il = num(r['il']);
      if (dl !== undefined) o.dataLength = dl;
      if (il !== undefined) o.indexLength = il;
      const comment = str(r['comment']);
      if (comment) o.comment = comment;
      const extra: Record<string, string> = {};
      if (k === 'm') extra['type'] = 'materialized view';
      if (k === 'p') extra['type'] = 'partitioned table';
      if (k === 'f') extra['type'] = 'foreign table';
      if (bool(r['part'])) extra['partition'] = 'true';
      if (Object.keys(extra).length) o.extra = extra;
      out.push(o);
    }
    const routines = await this.rows(
      `SELECT p.proname AS name, p.prokind AS kind, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
        count(*) OVER (PARTITION BY p.proname) AS overloads, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       ORDER BY p.proname, args`,
      [schema],
    );
    for (const r of routines) {
      const name = r['name'] ?? '';
      // Overloads share a name; the argument list tells them apart.
      const o: DbObject = {
        kind: 'routine',
        schema,
        name: Number(r['overloads']) > 1 ? `${name}(${r['args'] ?? ''})` : name,
        extra: {
          type: r['kind'] === 'p' ? 'procedure' : 'function',
          arguments: r['args'] ?? '',
        },
      };
      const comment = str(r['comment']);
      if (comment) o.comment = comment;
      out.push(o);
    }
    const triggers = await this.rows(
      `SELECT t.tgname AS name, c.relname AS tbl, t.tgtype AS type
       FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
      [schema],
    );
    for (const r of triggers) {
      const { timing, events } = triggerType(Number(r['type']));
      out.push({
        kind: 'trigger',
        schema,
        name: r['name'] ?? '',
        extra: { table: r['tbl'] ?? '', timing, event: events },
      });
    }
    return out;
  }

  private async relation(
    schema: string,
    name: string,
  ): Promise<{ oid: string; kind: string; comment?: string; est?: number; persistence?: string }> {
    const r = await this.one(
      `SELECT c.oid, c.relkind AS kind, pg_catalog.obj_description(c.oid, 'pg_class') AS comment, c.reltuples::bigint AS est, c.relpersistence AS pers
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    if (!r) throw new DriverError('QUERY_FAILED', `No table or view named ${schema}.${name}`);
    const out: { oid: string; kind: string; comment?: string; est?: number; persistence?: string } =
      { oid: r['oid'] ?? '', kind: r['kind'] ?? 'r' };
    const comment = str(r['comment']);
    const est = num(r['est']);
    if (comment) out.comment = comment;
    if (est !== undefined && est >= 0) out.est = est;
    if (r['pers']) out.persistence = r['pers'];
    return out;
  }

  async describeTable(schema: string, table: string): Promise<TableDefinition> {
    const rel = await this.relation(schema, table);
    if (!['r', 'p', 'v', 'm', 'f'].includes(rel.kind))
      throw new DriverError('QUERY_FAILED', `${schema}.${table} is not a table or view`);
    const kind = rel.kind === 'v' || rel.kind === 'm' ? 'view' : 'table';
    const q = this.dialect.quoteIdentifier.bind(this.dialect);

    const colRows = await this.rows(
      `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.atttypid AS typid,
        a.attnotnull AS notnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity AS ident,
        a.attgenerated AS gen, CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS coll,
        pg_catalog.col_description(a.attrelid, a.attnum) AS comment
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [rel.oid],
    );
    const columns: ColumnDefinition[] = colRows.map((r, i) => {
      const valueType = valueTypeOf(Number(r['typid']), this.types);
      const dflt = str(r['dflt']);
      const ident = r['ident'] ?? '';
      const gen = r['gen'] ?? '';
      const col: ColumnDefinition = {
        name: r['name'] ?? '',
        ordinal: i + 1,
        nativeType: shortTypeName(r['type'] ?? ''),
        valueType,
        nullable: !bool(r['notnull']),
        autoIncrement: ident !== '' || (dflt !== undefined && /^nextval\(/i.test(dflt)),
      };
      if (ident)
        col.extra =
          ident === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY';
      if (gen === 's' && dflt !== undefined) col.generated = { expression: dflt, stored: true };
      else if (dflt !== undefined) col.default = parseDefault(dflt, valueType);
      const coll = str(r['coll']);
      const comment = str(r['comment']);
      if (coll) col.collation = coll;
      if (comment) col.comment = comment;
      return col;
    });

    const idxRows = await this.rows(
      `SELECT i.relname AS name, x.indisunique AS uniq, x.indisprimary AS prim, am.amname AS method,
        x.indoption::text AS opts, x.indkey::text AS keys,
        (SELECT string_agg(pg_catalog.pg_get_indexdef(x.indexrelid, k, true), E'\\x1f' ORDER BY k) FROM generate_series(1, x.indnkeyatts) k) AS cols,
        EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = x.indexrelid AND c.conrelid = x.indrelid AND c.contype IN ('p', 'u', 'x')) AS con,
        pg_catalog.pg_get_expr(x.indpred, x.indrelid, true) AS pred, pg_catalog.obj_description(i.oid, 'pg_class') AS comment
       FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid JOIN pg_catalog.pg_am am ON am.oid = i.relam
       WHERE x.indrelid = $1 ORDER BY x.indisprimary DESC, i.relname`,
      [rel.oid],
    );
    const columnNames = new Set(columns.map((c) => c.name));
    const indexes: IndexDefinition[] = idxRows.map((r) => {
      const opts = (r['opts'] ?? '').split(' ').map(Number);
      const keys = (r['keys'] ?? '').split(' ').map(Number);
      const ix: IndexDefinition = {
        name: r['name'] ?? '',
        unique: bool(r['uniq']),
        primary: bool(r['prim']),
        type: r['method'] ?? 'btree',
        columns: list(r['cols']).map((def, k) => {
          const col: IndexDefinition['columns'][number] = {};
          const unquoted = /^"(.*)"$/.exec(def)?.[1]?.replace(/""/g, '"') ?? def;
          if (keys[k] !== 0 && columnNames.has(unquoted)) col.name = unquoted;
          else col.expression = def;
          col.order = ((opts[k] ?? 0) & 1) === 1 ? 'desc' : 'asc';
          return col;
        }),
      };
      if (bool(r['con'])) ix.constraint = true;
      const pred = str(r['pred']);
      const comment = str(r['comment']);
      if (pred) ix.where = pred;
      if (comment) ix.comment = comment;
      return ix;
    });
    const primary = indexes.find((i) => i.primary);

    const fkRows = await this.rows(
      `SELECT con.conname AS name, fn.nspname AS rs, fc.relname AS rt, con.confupdtype AS upd, con.confdeltype AS del,
        (SELECT string_agg(a.attname, E'\\x1f' ORDER BY k.o) FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
        (SELECT string_agg(a.attname, E'\\x1f' ORDER BY k.o) FROM unnest(con.confkey) WITH ORDINALITY k(n, o) JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS rcols
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
       WHERE con.conrelid = $1 AND con.contype = 'f' ORDER BY con.conname`,
      [rel.oid],
    );
    const foreignKeys: ForeignKeyDefinition[] = fkRows.map((r) => ({
      name: r['name'] ?? '',
      columns: list(r['cols']),
      referencedSchema: r['rs'] ?? schema,
      referencedTable: r['rt'] ?? '',
      referencedColumns: list(r['rcols']),
      onUpdate: fkRule(r['upd'] ?? 'a'),
      onDelete: fkRule(r['del'] ?? 'a'),
    }));

    const options: Record<string, string> = {};
    if (rel.kind === 'p') options['partitioned'] = 'true';
    if (rel.kind === 'm') options['materialized'] = 'true';
    if (rel.kind === 'f') options['foreign'] = 'true';
    if (rel.persistence === 'u') options['unlogged'] = 'true';

    const def: TableDefinition = {
      schema,
      name: table,
      kind,
      columns,
      indexes,
      foreignKeys,
      options,
    };
    if (primary) def.primaryKey = primary.columns.map((c) => c.name ?? '');
    if (rel.comment) def.comment = rel.comment;
    if (rel.est !== undefined && kind === 'table') def.rowEstimate = rel.est;
    def.ddl =
      kind === 'view'
        ? await this.viewDdl(rel.oid, `${q(schema)}.${q(table)}`, rel.kind === 'm')
        : await this.tableDdl(rel.oid, def);
    return def;
  }

  private async viewDdl(oid: string, name: string, materialized: boolean): Promise<string> {
    const r = await this.one('SELECT pg_catalog.pg_get_viewdef($1::oid, true) AS def', [oid]);
    const body = (r?.['def'] ?? '').trim().replace(/;$/, '');
    return `CREATE ${materialized ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} ${name} AS\n${body}`;
  }

  /** PostgreSQL prints no CREATE TABLE; build one from the catalog, as pg_dump would. */
  private async tableDdl(oid: string, def: TableDefinition): Promise<string> {
    const q = this.dialect.quoteIdentifier.bind(this.dialect);
    const name = `${q(def.schema)}.${q(def.name)}`;
    const lines = def.columns.map((c) => {
      let sql = `${q(c.name)} ${c.nativeType}`;
      if (c.collation) sql += ` COLLATE ${q(c.collation)}`;
      if (c.extra?.includes('IDENTITY')) sql += ` ${c.extra}`;
      if (c.generated) sql += ` GENERATED ALWAYS AS (${c.generated.expression}) STORED`;
      if (!c.nullable) sql += ' NOT NULL';
      if (c.default !== undefined) {
        const d = c.default;
        sql += ` DEFAULT ${d.t === 'expression' ? d.sql : this.dialect.quoteLiteral(d)}`;
      }
      return sql;
    });
    const cons = await this.rows(
      `SELECT conname AS name, pg_catalog.pg_get_constraintdef(oid, true) AS def FROM pg_catalog.pg_constraint
       WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, conname`,
      [oid],
    );
    for (const c of cons) lines.push(`CONSTRAINT ${q(c['name'] ?? '')} ${c['def'] ?? ''}`);
    let ddl = `CREATE ${def.options['unlogged'] ? 'UNLOGGED ' : ''}TABLE ${name} (\n  ${lines.join(',\n  ')}\n)`;
    const part = await this.one(
      'SELECT pg_catalog.pg_get_partkeydef($1::oid) AS pk, pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_catalog.pg_class c WHERE c.oid = $1',
      [oid],
    );
    if (part?.['pk']) ddl += ` PARTITION BY ${part['pk']}`;
    const extra: string[] = [];
    const idx = await this.rows(
      `SELECT pg_catalog.pg_get_indexdef(x.indexrelid) AS def FROM pg_catalog.pg_index x
       WHERE x.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = x.indexrelid AND c.conrelid = x.indrelid)
       ORDER BY 1`,
      [oid],
    );
    for (const r of idx) extra.push(r['def'] ?? '');
    const lit = (s: string): string => this.dialect.quoteLiteral({ t: 'text', v: s });
    if (def.comment) extra.push(`COMMENT ON TABLE ${name} IS ${lit(def.comment)}`);
    for (const c of def.columns)
      if (c.comment) extra.push(`COMMENT ON COLUMN ${name}.${q(c.name)} IS ${lit(c.comment)}`);
    return [ddl, ...extra].join(';\n');
  }

  async describeObject(
    schema: string,
    kind: DbObjectKind,
    name: string,
  ): Promise<ObjectDefinition> {
    const props: ObjectDefinition['properties'] = [];
    const add = (label: string, value: string | null | undefined): void => {
      if (value !== undefined && value !== null && value !== '') props.push({ label, value });
    };
    const q = this.dialect.quoteIdentifier.bind(this.dialect);
    let ddl: string;
    switch (kind) {
      case 'routine': {
        const rows = await this.rows(
          `SELECT p.oid, p.prokind AS kind, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
            pg_catalog.pg_get_function_result(p.oid) AS returns_, l.lanname AS lang, p.provolatile AS vol,
            p.prosecdef AS secdef, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
            pg_catalog.obj_description(p.oid, 'pg_proc') AS comment, pg_catalog.pg_get_functiondef(p.oid) AS def
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_catalog.pg_language l ON l.oid = p.prolang
           WHERE n.nspname = $1 AND (p.proname = $2 OR p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' = $2)
           ORDER BY args`,
          [schema, name],
        );
        const r = rows[0];
        if (!r) throw new DriverError('QUERY_FAILED', `No routine named ${schema}.${name}`);
        add('Type', r['kind'] === 'p' ? 'procedure' : 'function');
        add('Parameters', r['args'] || 'none');
        if (r['kind'] !== 'p') add('Returns', r['returns_']);
        add('Language', r['lang']);
        add(
          'Volatility',
          { i: 'immutable', s: 'stable', v: 'volatile' }[r['vol'] ?? 'v'] ?? undefined,
        );
        add('Security', bool(r['secdef']) ? 'definer' : 'invoker');
        add('Owner', r['owner']);
        add('Comment', r['comment']);
        if (rows.length > 1) add('Overloads', String(rows.length));
        ddl = rows.map((x) => (x['def'] ?? '').trim()).join(';\n\n');
        break;
      }
      case 'trigger': {
        const r = await this.one(
          `SELECT c.relname AS tbl, t.tgtype AS type, t.tgenabled AS enabled, p.proname AS fn, pg_catalog.pg_get_triggerdef(t.oid, true) AS def
           FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
           WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
          [schema, name],
        );
        if (!r) throw new DriverError('QUERY_FAILED', `No trigger named ${schema}.${name}`);
        const { timing, events, level } = triggerType(Number(r['type']));
        add('Table', r['tbl']);
        add('Fires', `${timing} ${events}, for each ${level}`);
        add('Function', r['fn']);
        add('Enabled', r['enabled'] === 'D' ? 'no' : 'yes');
        ddl = r['def'] ?? '';
        break;
      }
      case 'view': {
        const rel = await this.relation(schema, name);
        ddl = await this.viewDdl(rel.oid, `${q(schema)}.${q(name)}`, rel.kind === 'm');
        if (rel.kind === 'm') add('Type', 'materialized view');
        add('Comment', rel.comment);
        break;
      }
      case 'sequence': {
        const r = await this.one(
          `SELECT s.data_type AS type, s.start_value AS start, s.increment_by AS inc, s.min_value AS min, s.max_value AS max,
            s.cycle, s.cache_size AS cache, s.last_value AS last,
            (SELECT a.attrelid::regclass || '.' || a.attname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND d.deptype IN ('a', 'i') LIMIT 1) AS owned
           FROM pg_catalog.pg_sequences s WHERE s.schemaname = $1 AND s.sequencename = $2`,
          [schema, name],
        );
        if (!r) throw new DriverError('QUERY_FAILED', `No sequence named ${schema}.${name}`);
        add('Data type', r['type']);
        add('Last value', r['last'] ?? 'not used yet');
        add('Increment', r['inc']);
        add('Owned by', r['owned']);
        ddl =
          `CREATE SEQUENCE ${q(schema)}.${q(name)} AS ${r['type'] ?? 'bigint'}\n` +
          `  INCREMENT BY ${r['inc'] ?? '1'} MINVALUE ${r['min'] ?? '1'} MAXVALUE ${r['max'] ?? ''}\n` +
          `  START WITH ${r['start'] ?? '1'} CACHE ${r['cache'] ?? '1'}${bool(r['cycle']) ? ' CYCLE' : ' NO CYCLE'}`;
        break;
      }
      default:
        throw new DriverError('UNSUPPORTED', `PostgreSQL has no ${kind}s`);
    }
    return { schema, name, kind, ddl, properties: props };
  }

  private columnMeta(fields: pg.FieldDef[]): ColumnMeta[] {
    return fields.map((f) => ({
      name: f.name,
      nativeType: typeNameOf(f.dataTypeID, this.types),
      valueType: valueTypeOf(f.dataTypeID, this.types),
      nullable: true,
      isPrimaryKey: false,
    }));
  }

  /** Ask the server to stop this session's statement, from a second short-lived connection. */
  private async cancelBackend(): Promise<void> {
    const pid = (this.client as unknown as { processID: number | null }).processID;
    if (!pid) return;
    try {
      const killer = await connectClient({ ...this.config, connectionTimeoutMillis: 5000 });
      try {
        await killer.query('SELECT pg_catalog.pg_cancel_backend($1)', [pid]);
      } finally {
        await killer.end().catch(() => undefined);
      }
    } catch {
      /* best effort; the statement finishes on its own */
    }
  }

  async *query(sql: string, opts: QueryOptions = {}): AsyncIterable<QueryEvent> {
    const started = Date.now();
    if (this.dead) {
      yield { kind: 'error', resultIndex: 0, code: this.dead.code, message: this.dead.message };
      return;
    }
    if (this.typesStale) await this.loadTypes().catch(() => undefined);
    const signal = opts.signal;
    const batchSize = Math.min(Math.max(opts.rowBatchSize ?? 256, 1), 5000);
    const statements = splitPostgres(sql);
    if (statements.length === 0) {
      yield { kind: 'done', resultIndex: 0, more: false, elapsedMs: 0, warnings: [] };
      return;
    }
    const params = opts.params?.map(toParam);
    if (params?.length && statements.length > 1) {
      yield {
        kind: 'error',
        resultIndex: 0,
        code: 'UNSUPPORTED',
        message: 'Parameters need a single statement',
      };
      return;
    }

    let cancelled = false;
    let cancelling: Promise<void> | null = null;
    // A cancel that reaches an idle backend is kept and kills its next statement, so one is only
    // sent while the server is working on ours.
    let inFlight = false;
    const onAbort = (): void => {
      cancelled = true;
      if (inFlight && !cancelling) cancelling = this.cancelBackend();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cancelledEvent = (index: number): QueryEvent => ({
      kind: 'error',
      resultIndex: index,
      code: 'CANCELLED',
      message: 'Query cancelled',
    });

    try {
      for (let index = 0; index < statements.length; index++) {
        const st = statements[index] as (typeof statements)[number];
        const more = index < statements.length - 1;
        if (cancelled) {
          yield cancelledEvent(index);
          return;
        }
        this.notices = [];
        const cursor = this.client.query(
          new Cursor(st.sql, params, { rowMode: 'array', types: RAW_TYPES }),
        );
        let columns: ColumnMeta[] | null = null;
        let count = 0;
        let truncated = false;
        try {
          for (;;) {
            const want =
              opts.maxRows !== undefined
                ? Math.min(batchSize, opts.maxRows - count + 1)
                : batchSize;
            inFlight = true;
            const { rows, result } = await new Promise<{
              rows: (string | null)[][];
              result: pg.QueryResult;
            }>((resolve, reject) => {
              cursor.read(want, (err, rows, result) =>
                err ? reject(err) : resolve({ rows: rows as (string | null)[][], result }),
              );
            }).finally(() => {
              inFlight = false;
            });
            if (columns === null) {
              if (result.fields.length === 0) {
                // A command: no rows, only a count. CREATE TYPE and friends change pg_type.
                if (/^(CREATE|ALTER|DROP)\b/i.test(result.command ?? '')) this.typesStale = true;
                const done: QueryEvent = {
                  kind: 'done',
                  resultIndex: index,
                  more,
                  elapsedMs: Date.now() - started,
                  warnings: this.notices,
                };
                if (result.rowCount !== null && result.rowCount !== undefined)
                  done.affectedRows = result.rowCount;
                yield done;
                break;
              }
              columns = this.columnMeta(result.fields);
              yield { kind: 'columns', resultIndex: index, columns };
            }
            const types = columns.map((c) => c.valueType);
            let batch = rows;
            if (opts.maxRows !== undefined && count + batch.length > opts.maxRows) {
              batch = batch.slice(0, opts.maxRows - count);
              truncated = true;
            }
            count += batch.length;
            if (batch.length)
              yield {
                kind: 'rows',
                resultIndex: index,
                rows: batch.map((row) => row.map((cell, i) => toValue(cell, types[i] ?? 'text'))),
              };
            if (cancelled) {
              yield cancelledEvent(index);
              return;
            }
            if (truncated || rows.length < want) {
              yield {
                kind: 'done',
                resultIndex: index,
                more,
                rowCount: count,
                truncated,
                elapsedMs: Date.now() - started,
                warnings: this.notices,
              };
              break;
            }
          }
        } catch (err) {
          const e = wrapError(err);
          if (cancelled || e.code === 'CANCELLED') {
            yield cancelledEvent(index);
            return;
          }
          const ev: QueryEvent = {
            kind: 'error',
            resultIndex: index,
            code: e.code,
            message: e.message,
          };
          if (e.sqlState !== undefined) ev.sqlState = e.sqlState;
          const pos = Number((err as PgNativeError).position);
          if (Number.isFinite(pos) && pos > 0) ev.position = st.offset + pos - 1;
          yield ev;
          return;
        } finally {
          await cursor.close().catch(() => undefined);
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // Never let a cancel land on the caller's next statement: wait for it, then give a late
      // one a statement of our own to hit.
      if (cancelling) {
        await cancelling;
        await this.client.query('SELECT 1').catch(() => undefined);
      }
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const rows = await this.rows(`EXPLAIN ${sql}`);
    return { format: 'text', text: rows.map((r) => Object.values(r)[0] ?? '').join('\n') };
  }

  async setReadOnly(on: boolean): Promise<void> {
    await this.exec(`SET default_transaction_read_only = ${on ? 'on' : 'off'}`);
    this.readOnly = on;
  }

  async begin(): Promise<void> {
    await this.exec('BEGIN');
  }

  async commit(): Promise<void> {
    await this.exec('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.exec('ROLLBACK');
  }

  async close(): Promise<void> {
    await Promise.race([
      this.client.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2000).unref()),
    ]);
  }
}

/** pg_trigger.tgtype bits: when it fires, on what, and per row or per statement. */
export function triggerType(t: number): { timing: string; events: string; level: string } {
  const timing = t & 64 ? 'INSTEAD OF' : t & 2 ? 'BEFORE' : 'AFTER';
  const events = [
    t & 4 ? 'INSERT' : '',
    t & 16 ? 'UPDATE' : '',
    t & 8 ? 'DELETE' : '',
    t & 32 ? 'TRUNCATE' : '',
  ]
    .filter(Boolean)
    .join(' OR ');
  return { timing, events, level: t & 1 ? 'row' : 'statement' };
}
