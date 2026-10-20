import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ColumnMeta, TableDefinition, Value } from '@rasql/driver-protocol';
import { canRead, canWrite, confirmsEveryChange } from './access.js';
import { analyzeStatement, qualified, type StatementAnalysis, type TableName } from './changes.js';
import type {
  AgentConnection,
  AgentSession,
  ChangeSetSummary,
  ClientInfo,
  ConnectionPatch,
  McpHost,
  NewConnection,
} from './host.js';
import { clientLabel } from './host.js';
import { Refusal, assertPlainRead, foreignDatabase, type ScopeContext } from './scope.js';
import { flavorOf, splitStatements, type Flavor, type Statement } from './sql.js';
import { TOOLS } from './tools.js';
import { resultToJson, valueToJson } from './values.js';

const INSTRUCTIONS = `RaSQL gives you access to the databases the user opened up for agents in the RaSQL app.
Start with list_connections. Each connection has an access setting the user controls: read-only connections only answer reads; on "ask" connections every change set waits for the user to allow it; on "secure" connections every change set waits for the user to confirm it with Touch ID; on "write" connections safe changes run at once, but anything that can lose data (DROP, DELETE, TRUNCATE, UPDATE without WHERE, narrowing a column whose data does not fit) still waits for the user.
Read with query, sample_rows and explain; change data or structure only with commit_changes, which takes all statements of one change as a list. Each connection is limited to the database it names.`;

/** Seconds commit_changes and change_status wait for an outcome before returning 'pending'. */
const DEFAULT_WAIT = 120;
const MAX_WAIT = 600;

interface ChangeSetState {
  summary: ChangeSetSummary;
  done: Promise<void>;
}

interface Scope extends ScopeContext {
  schemas: string[];
  defaultSchema: string;
}

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Statements as they arrive: a list, or one script. */
function statementsOf(args: Record<string, unknown>): string[] {
  const list = args['statements'];
  if (Array.isArray(list)) return list.map(String);
  if (typeof args['sql'] === 'string') return [args['sql']];
  if (typeof list === 'string') return [list];
  throw new Refusal('Pass the change as statements, a list of SQL statements');
}

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Refusal(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Refusal(`${key} must be a string`);
  return v;
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Refusal(`${key} must be a number`);
  return Math.floor(n);
}

/** Drain a query into the first result set, up to maxRows. */
async function collect(
  session: AgentSession,
  sql: string,
  maxRows: number,
  schema?: string,
): Promise<{ columns: ColumnMeta[]; rows: Value[][]; truncated: boolean; affectedRows?: number }> {
  let columns: ColumnMeta[] = [];
  const rows: Value[][] = [];
  let truncated = false;
  let affectedRows: number | undefined;
  const opts = schema === undefined ? { maxRows } : { maxRows, schema };
  for await (const event of session.query(sql, opts)) {
    if (event.kind === 'error') {
      const err = new Error(event.message) as Error & { code: string };
      err.code = event.code;
      throw err;
    }
    if (event.resultIndex !== 0) continue;
    if (event.kind === 'columns') columns = event.columns;
    else if (event.kind === 'rows') rows.push(...event.rows);
    else if (event.kind === 'done') {
      truncated = Boolean(event.truncated);
      if (event.affectedRows !== undefined) affectedRows = event.affectedRows;
    }
  }
  if (rows.length > maxRows) {
    rows.length = maxRows;
    truncated = true;
  }
  return affectedRows === undefined
    ? { columns, rows, truncated }
    : { columns, rows, truncated, affectedRows };
}

async function scalar(session: AgentSession, sql: string): Promise<Value | undefined> {
  const { rows } = await collect(session, sql, 1);
  return rows[0]?.[0];
}

function countOf(v: Value | undefined): number | null {
  if (!v) return null;
  if (v.t === 'int' || v.t === 'decimal' || v.t === 'text') return Number(v.v);
  if (v.t === 'float') return v.v;
  return null;
}

/**
 * The MCP server (MCP.md, D-40). One core per app; every client connection gets a Server of
 * its own from createServer, and they share connections, change sets and session grants.
 */
export class McpCore {
  private readonly changeSets = new Map<string, ChangeSetState>();
  /** Connections where the user answered "This session"; cleared when RaSQL quits. */
  private readonly sessionGrants = new Set<string>();
  /** Table definitions per connection, for search_schema; dropped after every commit. */
  private readonly definitionCache = new Map<string, Map<string, TableDefinition>>();
  /** Servers with a client attached, for the client list and for revoking. */
  private readonly live = new Set<Server>();

  constructor(
    private readonly host: McpHost,
    private readonly info: { name: string; version: string },
  ) {}

  /** Forget "This session" answers, for one connection or all. */
  revokeSessionGrants(connectionId?: string): void {
    if (connectionId) this.sessionGrants.delete(connectionId);
    else this.sessionGrants.clear();
  }

  /** Clients connected right now, one entry per connection. */
  connected(): ClientInfo[] {
    return [...this.live].flatMap((server) => {
      const v = server.getClientVersion();
      return v ? [{ name: v.name, ...(v.version ? { version: v.version } : {}) }] : [];
    });
  }

  /** Close the connections of one client, or of every client. */
  async disconnect(clientName?: string): Promise<void> {
    const servers = [...this.live].filter(
      (server) => clientName === undefined || server.getClientVersion()?.name === clientName,
    );
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  }

  changeSet(id: string): ChangeSetSummary | undefined {
    return this.changeSets.get(id)?.summary;
  }

  createServer(): Server {
    const server = new Server(this.info, {
      capabilities: { tools: {}, resources: {} },
      instructions: INSTRUCTIONS,
    });
    const client = (): ClientInfo => {
      const v = server.getClientVersion();
      const out: ClientInfo = { name: v?.name || 'unknown client' };
      if (v?.version) out.version = v.version;
      const title = (v as { title?: string } | undefined)?.title;
      if (title) out.title = title;
      return out;
    };
    // Ask the user as soon as an unknown client connects, not at its first tool call.
    server.oninitialized = () => void this.host.approveClient(client()).catch(() => false);

    this.live.add(server);
    server.onclose = () => this.live.delete(server);

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const who = client();
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      let connection: AgentConnection | undefined;
      try {
        if (!(await this.host.approveClient(who)))
          throw new Refusal(
            `The user has not allowed ${clientLabel(who)} to use RaSQL. RaSQL asked in the app; try again once the user allows it.`,
          );
        const resolve = (): AgentConnection => {
          connection = this.resolveConnection(str(args, 'connection', true));
          this.host.activity(connection.id, who, name);
          return connection;
        };
        const result = await this.call(name, args, who, resolve);
        if (name !== 'commit_changes' && name !== 'change_status')
          this.host.audit(this.entry(who, name, 'ok', connection, undefined, args));
        return result;
      } catch (err) {
        const refused = err instanceof Refusal;
        const message = err instanceof Error ? err.message : String(err);
        this.host.audit(
          this.entry(who, name, refused ? 'refused' : 'error', connection, message, args),
        );
        return failure(message);
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (!(await this.host.approveClient(client()))) return { resources: [] };
      return {
        resources: this.visible()
          .filter((c) => canRead(c.access) && (c.database || flavorOf(c.driver) === 'sqlite'))
          .map((c) => ({
            uri: `rasql://connections/${encodeURIComponent(c.id)}/schema`,
            name: `${c.name} schema`,
            description: `Tables and columns of ${c.database ?? c.name}`,
            mimeType: 'text/markdown',
          })),
      };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const who = client();
      if (!(await this.host.approveClient(who)))
        throw new Error('The user has not allowed this client');
      const m = /^rasql:\/\/connections\/([^/]+)\/schema$/.exec(req.params.uri);
      if (!m) throw new Error(`Unknown resource ${req.params.uri}`);
      const conn = this.resolveConnection(decodeURIComponent(m[1] as string));
      this.requireRead(conn);
      this.host.activity(conn.id, who, 'read schema');
      const markdown = await this.host.withSession(conn.id, (s) => this.schemaMarkdown(conn, s));
      this.host.audit(this.entry(who, 'resources/read', 'ok', conn, req.params.uri));
      return { contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text: markdown }] };
    });
    return server;
  }

  private entry(
    who: ClientInfo,
    tool: string,
    outcome: Parameters<McpHost['audit']>[0]['outcome'],
    conn: AgentConnection | undefined,
    detail?: string,
    args?: Record<string, unknown>,
  ): Parameters<McpHost['audit']>[0] {
    const e: Parameters<McpHost['audit']>[0] = { client: clientLabel(who), tool, outcome };
    if (conn) {
      e.connectionId = conn.id;
      e.connectionName = conn.name;
    }
    if (detail) e.detail = detail;
    const sql = args?.['sql'] ?? args?.['statements'];
    if (typeof sql === 'string') e.sql = [sql];
    else if (Array.isArray(sql)) e.sql = sql.map(String);
    return e;
  }

  private visible(): AgentConnection[] {
    return this.host.connections().filter((c) => c.access !== 'hidden');
  }

  /** By id, or by name when that is unambiguous. Hidden connections do not exist. */
  private resolveConnection(ref: string): AgentConnection {
    const all = this.visible();
    const byId = all.find((c) => c.id === ref);
    if (byId) return byId;
    const byName = all.filter((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0] as AgentConnection;
    if (byName.length > 1)
      throw new Refusal(`Several connections are named ${ref}; use the id from list_connections`);
    throw new Refusal(
      `There is no connection ${ref}. list_connections shows the ones you may use.`,
    );
  }

  private requireRead(conn: AgentConnection): void {
    if (!canRead(conn.access)) throw new Refusal(`There is no connection ${conn.name}.`);
    if (!conn.database && flavorOf(conn.driver) !== 'sqlite')
      throw new Refusal(
        `${conn.name} has no database set, so agents see no data on it. The user can fill in the database in RaSQL's connection form.`,
      );
  }

  private async scope(conn: AgentConnection, s: AgentSession): Promise<Scope> {
    const flavor = flavorOf(conn.driver);
    const listed = await s.listSchemas();
    const knownDatabases = listed.map((x) => x.name);
    if (flavor === 'mysql' || flavor === 'sqlite') {
      const database = flavor === 'sqlite' ? 'main' : (conn.database as string);
      const schema =
        flavor === 'sqlite' ? (listed.find((x) => x.name === 'main')?.name ?? 'main') : database;
      return { flavor, database, knownDatabases, schemas: [schema], defaultSchema: schema };
    }
    // PostgreSQL and SQL Server: schemas live inside the connected database (D-39).
    const schemas = listed.filter((x) => !x.isSystem).map((x) => x.name);
    const preferred = s.serverInfo.currentSchema;
    const defaultSchema =
      (preferred && schemas.includes(preferred) ? preferred : undefined) ??
      schemas.find((x) => x === 'public' || x === 'dbo') ??
      schemas[0] ??
      'public';
    return { flavor, database: conn.database as string, knownDatabases, schemas, defaultSchema };
  }

  private schemaArg(scope: Scope, args: Record<string, unknown>): string {
    const asked = str(args, 'schema');
    if (asked === undefined) return scope.defaultSchema;
    const match = scope.schemas.find((x) => x.toLowerCase() === asked.toLowerCase());
    if (!match)
      throw new Refusal(
        `${asked} is not available on this connection. Agents may use: ${scope.schemas.join(', ') || scope.defaultSchema}`,
      );
    return match;
  }

  private assertInScope(stmt: Statement, scope: Scope): void {
    const foreign = foreignDatabase(stmt, scope);
    if (foreign)
      throw new Refusal(
        `The statement reaches ${foreign}. This connection gives agents ${scope.database} only; the user can add another connection for another database.`,
      );
  }

  private single(sql: string, flavor: Flavor): Statement {
    const stmts = splitStatements(sql, flavor);
    if (stmts.length === 0) throw new Refusal('The statement is empty');
    if (stmts.length > 1) throw new Refusal('Send one statement at a time');
    return stmts[0] as Statement;
  }

  private rowCap(args: Record<string, unknown>, fallback?: number): number {
    const cap = Math.max(1, this.host.rowLimit());
    const asked = int(args, 'limit') ?? fallback ?? cap;
    return Math.min(Math.max(1, asked), cap);
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    who: ClientInfo,
    resolve: () => AgentConnection,
  ): Promise<CallToolResult> {
    switch (name) {
      case 'list_connections':
        return text({
          connections: this.visible().map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.group ? { group: c.group } : {}),
            ...(c.favorite ? { favorite: true } : {}),
            driver: c.driver,
            environment: c.environment,
            access: c.access,
            database: c.database ?? null,
            readOnly: c.readOnly,
          })),
        });
      case 'create_connection':
        return this.createConnection(who, args);
      case 'update_connection': {
        const conn = resolve();
        const patch: ConnectionPatch = {};
        for (const key of Object.keys(args)) {
          if (!['connection', 'name', 'group', 'favorite', 'color'].includes(key))
            throw new Refusal(
              `${key} cannot be changed over MCP. Agents may change name, group, favorite and color; create a new connection to point somewhere else.`,
            );
        }
        const newName = str(args, 'name');
        if (newName !== undefined) patch.name = newName;
        if ('group' in args) patch.group = args['group'] === null ? null : String(args['group']);
        if ('favorite' in args) patch.favorite = Boolean(args['favorite']);
        if ('color' in args) {
          const color = args['color'];
          if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(String(color)))
            throw new Refusal('color must look like #3a86c8');
          patch.color = color === null ? null : String(color);
        }
        const updated = this.host.updateConnection(conn.id, patch);
        return text({
          updated: {
            id: updated.id,
            name: updated.name,
            group: updated.group ?? null,
            favorite: Boolean(updated.favorite),
            color: updated.color ?? null,
          },
        });
      }
      case 'list_databases': {
        const conn = resolve();
        this.requireRead(conn);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          return text({
            database: scope.flavor === 'sqlite' ? 'main' : scope.database,
            schemas: scope.schemas,
            defaultSchema: scope.defaultSchema,
            note: 'Agents work in this database only.',
          });
        });
      }
      case 'list_tables': {
        const conn = resolve();
        this.requireRead(conn);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          const schema = this.schemaArg(scope, args);
          const objects = await s.listObjects(schema);
          return text({
            schema,
            tables: objects
              .filter((o) => o.kind === 'table' || o.kind === 'view')
              .map((o) => ({
                name: o.name,
                kind: o.kind,
                ...(o.rowEstimate !== undefined ? { rowEstimate: o.rowEstimate } : {}),
                ...(o.comment ? { comment: o.comment } : {}),
              })),
            other: objects
              .filter((o) => o.kind !== 'table' && o.kind !== 'view')
              .map((o) => ({ name: o.name, kind: o.kind })),
          });
        });
      }
      case 'describe_table': {
        const conn = resolve();
        this.requireRead(conn);
        const table = str(args, 'table', true);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          const def = await s.describeTable(this.schemaArg(scope, args), table);
          return text(describeJson(def));
        });
      }
      case 'describe_object': {
        const conn = resolve();
        this.requireRead(conn);
        const kind = str(args, 'kind', true);
        if (!['view', 'routine', 'trigger', 'event'].includes(kind))
          throw new Refusal('kind must be view, routine, trigger or event');
        const objectName = str(args, 'name', true);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          const def = await s.describeObject(
            this.schemaArg(scope, args),
            kind as 'view',
            objectName,
          );
          return text(def);
        });
      }
      case 'search_schema': {
        const conn = resolve();
        this.requireRead(conn);
        const pattern = str(args, 'pattern', true);
        return this.host.withSession(conn.id, (s) => this.searchSchema(conn, s, pattern, args));
      }
      case 'sample_rows': {
        const conn = resolve();
        this.requireRead(conn);
        const table = str(args, 'table', true);
        const limit = this.rowCap(args, 20);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          const schema = this.schemaArg(scope, args);
          const sql = await s.dialect.buildSelect({ schema, name: table }, { limit });
          const r = await collect(s, sql, limit, schema);
          return text(resultToJson(r.columns, r.rows, r.truncated));
        });
      }
      case 'query': {
        const conn = resolve();
        this.requireRead(conn);
        const sql = str(args, 'sql', true);
        const limit = this.rowCap(args);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          const stmt = this.single(sql, scope.flavor);
          const cls = await s.dialect.classify(stmt.sql);
          if (cls !== 'read')
            throw new Refusal(
              `query runs reads only, and this statement ${cls === 'unknown' ? 'could not be classified' : `is a ${cls} statement`}. Submit changes with commit_changes.`,
            );
          assertPlainRead(stmt);
          this.assertInScope(stmt, scope);
          const schema =
            str(args, 'schema') === undefined ? undefined : this.schemaArg(scope, args);
          const r = await collect(s, stmt.sql, limit, schema);
          return text(resultToJson(r.columns, r.rows, r.truncated));
        });
      }
      case 'explain': {
        const conn = resolve();
        this.requireRead(conn);
        const sql = str(args, 'sql', true);
        return this.host.withSession(conn.id, async (s) => {
          const scope = await this.scope(conn, s);
          const stmt = this.single(sql, scope.flavor);
          const cls = await s.dialect.classify(stmt.sql);
          if (cls !== 'read' && cls !== 'write')
            throw new Refusal('explain takes a SELECT, INSERT, UPDATE or DELETE statement');
          const head = stmt.tokens[0];
          if (head?.kind === 'word' && ['EXPLAIN', 'DESCRIBE', 'DESC'].includes(head.value))
            throw new Refusal('Pass the statement itself; explain adds EXPLAIN');
          if (cls === 'read') assertPlainRead(stmt);
          this.assertInScope(stmt, scope);
          const plan = await s.explain(stmt.sql);
          return text({
            format: plan.format,
            ...(plan.text !== undefined ? { text: plan.text } : {}),
            ...(plan.columns && plan.rows ? resultToJson(plan.columns, plan.rows, false) : {}),
          });
        });
      }
      case 'commit_changes':
        return this.commitChanges(who, resolve(), args);
      case 'change_status': {
        const id = str(args, 'id', true);
        const state = this.changeSets.get(id);
        if (!state || state.summary.client.name !== who.name)
          throw new Refusal(`There is no change set ${id}`);
        await this.wait(state, args);
        return text(this.outcome(state.summary));
      }
      default:
        throw new Refusal(`Unknown tool ${name}`);
    }
  }

  private async createConnection(
    who: ClientInfo,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const allowed = new Set([
      'name',
      'driver',
      'transport',
      'host',
      'port',
      'socket_path',
      'file_path',
      'user',
      'password',
      'database',
      'environment',
      'group',
      'favorite',
      'color',
      'read_only',
    ]);
    for (const key of Object.keys(args))
      if (!allowed.has(key)) throw new Refusal(`create_connection does not take ${key}`);
    const input: NewConnection = {
      name: str(args, 'name', true),
      driver: str(args, 'driver') ?? 'mysql',
      transport: (str(args, 'transport') ??
        (args['socket_path']
          ? 'socket'
          : args['file_path']
            ? 'file'
            : 'tcp')) as NewConnection['transport'],
    };
    if (!['tcp', 'socket', 'file'].includes(input.transport))
      throw new Refusal('transport must be tcp, socket or file');
    const map: [string, keyof NewConnection][] = [
      ['host', 'host'],
      ['socket_path', 'socketPath'],
      ['file_path', 'filePath'],
      ['user', 'user'],
      ['password', 'password'],
      ['database', 'database'],
      ['environment', 'environment'],
      ['group', 'group'],
      ['color', 'color'],
    ];
    for (const [from, to] of map) {
      const v = str(args, from);
      if (v !== undefined) (input as unknown as Record<string, unknown>)[to] = v;
    }
    const port = int(args, 'port');
    if (port !== undefined) input.port = port;
    if (args['favorite'] !== undefined) input.favorite = Boolean(args['favorite']);
    if (args['read_only'] !== undefined) input.readOnly = Boolean(args['read_only']);
    if (
      input.environment &&
      !['local', 'development', 'staging', 'production', 'other'].includes(input.environment)
    )
      throw new Refusal('environment must be local, development, staging, production or other');
    const created = await this.host.createConnection(who, input);
    if (!created) throw new Refusal(`The user declined to add the connection ${input.name}.`);
    return text({
      created: {
        id: created.id,
        name: created.name,
        access: created.access,
        database: created.database ?? null,
      },
      note: 'The password, if any, is in the keychain and cannot be read back. The connection starts at "ask": every change waits for the user.',
    });
  }

  private async searchSchema(
    conn: AgentConnection,
    s: AgentSession,
    pattern: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const scope = await this.scope(conn, s);
    const schemas =
      str(args, 'schema') === undefined ? scope.schemas : [this.schemaArg(scope, args)];
    // SQL-style % and _ wildcards, or a plain substring.
    const re = /[%_*]/.test(pattern)
      ? new RegExp(
          `^${pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/[%*]/g, '.*')
            .replace(/_/g, '.')}$`,
          'i',
        )
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let cache = this.definitionCache.get(conn.id);
    if (!cache) {
      cache = new Map();
      this.definitionCache.set(conn.id, cache);
    }
    const tables: { schema: string; name: string; kind: string }[] = [];
    const columns: { schema: string; table: string; column: string; type: string }[] = [];
    let scanned = 0;
    let skipped = 0;
    for (const schema of schemas) {
      for (const o of await s.listObjects(schema)) {
        if (o.kind !== 'table' && o.kind !== 'view') continue;
        if (re.test(o.name)) tables.push({ schema, name: o.name, kind: o.kind });
        if (scanned >= 500) {
          skipped++;
          continue;
        }
        scanned++;
        const key = `${schema}.${o.name}`;
        let def = cache.get(key);
        if (!def) {
          def = await s.describeTable(schema, o.name).catch(() => undefined);
          if (def) cache.set(key, def);
        }
        for (const c of def?.columns ?? [])
          if (re.test(c.name))
            columns.push({ schema, table: o.name, column: c.name, type: c.nativeType });
      }
    }
    return text({
      tables,
      columns,
      ...(skipped ? { note: `Columns of ${skipped} more tables were not searched` } : {}),
    });
  }

  private async schemaMarkdown(conn: AgentConnection, s: AgentSession): Promise<string> {
    const scope = await this.scope(conn, s);
    const lines = [
      `# ${conn.name}`,
      '',
      `Database: ${scope.database}. Driver: ${conn.driver}. Access: ${conn.access}.`,
      '',
    ];
    let count = 0;
    for (const schema of scope.schemas) {
      for (const o of await s.listObjects(schema)) {
        if (o.kind !== 'table' && o.kind !== 'view') continue;
        if (++count > 200) {
          lines.push('', 'More tables exist; use list_tables and describe_table.');
          return lines.join('\n');
        }
        const def = await s.describeTable(schema, o.name).catch(() => undefined);
        lines.push(
          `## ${scope.schemas.length > 1 ? `${schema}.` : ''}${o.name}${o.kind === 'view' ? ' (view)' : ''}${o.rowEstimate !== undefined ? `, about ${o.rowEstimate} rows` : ''}`,
        );
        if (o.comment) lines.push('', o.comment);
        if (def) {
          lines.push('', '| Column | Type | Null | Key |', '| --- | --- | --- | --- |');
          for (const c of def.columns)
            lines.push(
              `| ${c.name} | ${c.nativeType} | ${c.nullable ? 'yes' : 'no'} | ${def.primaryKey?.includes(c.name) ? 'PK' : ''} |`,
            );
          for (const fk of def.foreignKeys)
            lines.push(
              '',
              `Foreign key ${fk.columns.join(', ')} → ${fk.referencedTable}(${fk.referencedColumns.join(', ')})`,
            );
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  private outcome(summary: ChangeSetSummary): Record<string, unknown> {
    const out: Record<string, unknown> = { id: summary.id, status: summary.status };
    if (
      summary.status === 'awaiting-approval' ||
      summary.status === 'analyzing' ||
      summary.status === 'running'
    )
      out['next'] = 'Call change_status with this id to wait for the outcome.';
    if (summary.note) out['note'] = summary.note;
    if (summary.error) out['error'] = summary.error;
    if (summary.results) out['results'] = summary.results;
    if (summary.warnings.length) out['warnings'] = summary.warnings;
    out['safety'] = summary.safety;
    out['statements'] = summary.statements.map((st) => ({
      sql: st.sql,
      safety: st.safety,
      reasons: st.reasons,
    }));
    return out;
  }

  private async wait(state: ChangeSetState, args: Record<string, unknown>): Promise<void> {
    const seconds = Math.min(Math.max(0, int(args, 'wait_seconds') ?? DEFAULT_WAIT), MAX_WAIT);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      state.done,
      new Promise<void>((r) => {
        timer = setTimeout(r, seconds * 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private update(summary: ChangeSetSummary, patch: Partial<ChangeSetSummary>): void {
    Object.assign(summary, patch);
    this.host.changeSetUpdated?.(structuredClone(summary));
  }

  private async commitChanges(
    who: ClientInfo,
    conn: AgentConnection,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    this.requireRead(conn);
    if (!canWrite(conn.access)) {
      const why = conn.readOnly ? 'is read-only' : 'is set to Read-only for agents';
      throw new Refusal(
        `${conn.name} ${why}. Changes are refused; the user decides this in RaSQL.`,
      );
    }
    const raw = statementsOf(args);
    const flavor = flavorOf(conn.driver);
    const stmts = raw.flatMap((r) => splitStatements(r, flavor));
    if (!stmts.length) throw new Refusal('The change set is empty');
    if (stmts.length > 500) throw new Refusal('A change set holds 500 statements at most');

    const summary: ChangeSetSummary = {
      id: randomUUID(),
      client: who,
      connectionId: conn.id,
      connectionName: conn.name,
      statements: [],
      safety: 'safe',
      atomic: true,
      warnings: [],
      tableSizes: [],
      status: 'analyzing',
      createdAt: new Date().toISOString(),
    };
    if (conn.database) summary.database = conn.database;
    const description = str(args, 'description');
    if (description) summary.description = description;

    // Analysis and data checks; refusals here fail the call before anything is stored.
    const analyzed = await this.host.withSession(conn.id, async (s) => {
      const scope = await this.scope(conn, s);
      const out: {
        analysis: StatementAnalysis;
        offending: (number | null)[];
        estimate?: number;
      }[] = [];
      const describe = async (t: TableName): Promise<TableDefinition | null> =>
        s.describeTable(t.schema ?? scope.defaultSchema, t.name).catch(() => null);
      for (const stmt of stmts) {
        this.assertInScope(stmt, scope);
        const analysis = await analyzeStatement(stmt, { flavor, describe });
        const offending: (number | null)[] = [];
        for (const check of analysis.checks)
          offending.push(countOf(await scalar(s, check.sql).catch(() => undefined)));
        const entry: (typeof out)[number] = { analysis, offending };
        if (analysis.estimateSql) {
          const n = countOf(await scalar(s, analysis.estimateSql).catch(() => undefined));
          if (n !== null) entry.estimate = n;
        }
        out.push(entry);
      }
      // Table sizes, so the prompt shows when a change touches a big table.
      const sizes = new Map<string, number | undefined>();
      const bySchema = new Map<string, Map<string, number | undefined>>();
      for (const { analysis } of out)
        for (const t of analysis.tables) {
          const schema = t.schema ?? scope.defaultSchema;
          if (!bySchema.has(schema)) {
            const objects = await s.listObjects(schema).catch(() => []);
            bySchema.set(
              schema,
              new Map(objects.map((o) => [o.name.toLowerCase(), o.rowEstimate])),
            );
          }
          sizes.set(qualified(flavor, t), bySchema.get(schema)?.get(t.name.toLowerCase()));
        }
      summary.tableSizes = [...sizes].map(([table, rows]) =>
        rows === undefined ? { table } : { table, rows },
      );
      return out;
    });

    let estimated = 0;
    let anyEstimate = false;
    for (const { analysis, offending, estimate } of analyzed) {
      // A check with offending rows, or one that could not run, makes the change destructive.
      let safety = analysis.safety;
      if (safety === 'check') {
        const bad = offending.some((n) => n === null || n > 0);
        safety = bad ? 'destructive' : 'safe';
        analysis.reasons.push(
          bad ? 'the data does not fit, or RaSQL could not check it' : 'the data fits',
        );
      }
      const st: ChangeSetSummary['statements'][number] = {
        sql: analysis.sql,
        kind: analysis.kind,
        safety,
        reasons: analysis.reasons,
        tables: analysis.tables,
        checks: analysis.checks.map((c, i) => ({
          description: c.description,
          offendingRows: offending[i] ?? null,
        })),
      };
      if (analysis.insertRows !== undefined) st.insertRows = analysis.insertRows;
      const rows = estimate ?? analysis.insertRows;
      if (rows !== undefined) {
        st.estimatedRows = rows;
        estimated += rows;
        anyEstimate = true;
      }
      summary.statements.push(st);
      if (safety === 'destructive') summary.safety = 'destructive';
    }
    if (anyEstimate) summary.estimatedRows = estimated;
    const hasStructure = summary.statements.some(
      (st) => st.kind === 'structure' || st.kind === 'other',
    );
    if (flavor === 'mysql' && hasStructure && summary.statements.length > 1) {
      summary.atomic = false;
      summary.warnings.push(
        'MySQL commits structure changes at once, so this change set cannot be undone as one if a later statement fails.',
      );
    }
    const big = summary.tableSizes.filter((t) => (t.rows ?? 0) >= 1_000_000);
    if (big.length)
      summary.warnings.push(
        `Touches ${big.map((t) => `${t.table} (about ${t.rows} rows)`).join(', ')}; even a safe change can lock a big table for minutes.`,
      );

    let finish!: () => void;
    const state: ChangeSetState = { summary, done: new Promise<void>((r) => (finish = r)) };
    this.changeSets.set(summary.id, state);
    this.prune();
    void this.decideAndRun(state, conn, flavor).finally(finish);
    await this.wait(state, args);
    return text(this.outcome(summary));
  }

  private async decideAndRun(
    state: ChangeSetState,
    conn: AgentConnection,
    flavor: Flavor,
  ): Promise<void> {
    const { summary } = state;
    const who = summary.client;
    const sql = summary.statements.map((st) => st.sql);
    const safe = summary.safety === 'safe';
    // Secure: every change set prompts, whatever was answered before (D-43).
    const unprompted =
      !confirmsEveryChange(conn.access) &&
      safe &&
      (conn.access === 'write' || this.sessionGrants.has(conn.id));
    if (!unprompted) {
      this.update(summary, { status: 'awaiting-approval' });
      const answer = await this.host.promptCommit(structuredClone(summary));
      if (answer.decision === 'deny' || answer.decision === 'expired') {
        const patch: Partial<ChangeSetSummary> = {
          status: answer.decision === 'deny' ? 'denied' : 'expired',
          finishedAt: new Date().toISOString(),
        };
        if (answer.decision === 'deny' && answer.note) patch.note = answer.note;
        if (answer.decision === 'expired')
          patch.note = 'Nobody answered the prompt in time, so it counts as denied.';
        this.update(summary, patch);
        this.host.audit({
          client: clientLabel(who),
          tool: 'commit_changes',
          outcome: answer.decision === 'deny' ? 'denied' : 'expired',
          connectionId: conn.id,
          connectionName: conn.name,
          ...(patch.note ? { detail: patch.note } : {}),
          sql,
        });
        return;
      }
      // A Secure prompt offers neither; should an answer claim one anyway, it counts as Once.
      if (!confirmsEveryChange(conn.access)) {
        if (answer.decision === 'session') this.sessionGrants.add(conn.id);
        if (answer.decision === 'always') this.host.allowAlways(conn.id);
      }
    } else {
      summary.unprompted = true;
    }

    this.update(summary, { status: 'running' });
    try {
      const results = await this.host.withSession(conn.id, (s) => this.run(s, sql, flavor));
      this.update(summary, { status: 'committed', results, finishedAt: new Date().toISOString() });
      this.host.audit({
        client: clientLabel(who),
        tool: 'commit_changes',
        outcome: 'committed',
        connectionId: conn.id,
        connectionName: conn.name,
        detail: unprompted ? 'committed without a prompt' : 'allowed by the user',
        sql,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.update(summary, {
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      });
      this.host.audit({
        client: clientLabel(who),
        tool: 'commit_changes',
        outcome: 'failed',
        connectionId: conn.id,
        connectionName: conn.name,
        detail: message,
        sql,
      });
    } finally {
      this.definitionCache.delete(conn.id);
    }
  }

  /** Run a change set in one transaction; on MySQL under strict mode so nothing is cut short. */
  private async run(
    s: AgentSession,
    statements: string[],
    flavor: Flavor,
  ): Promise<{ sql: string; affectedRows?: number }[]> {
    const results: { sql: string; affectedRows?: number }[] = [];
    await s.setReadOnly(false);
    let sqlMode: string | undefined;
    try {
      if (flavor === 'mysql') {
        const mode = await scalar(s, 'SELECT @@SESSION.sql_mode');
        sqlMode = mode && mode.t === 'text' ? mode.v : '';
        await collect(
          s,
          "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')",
          1,
        );
      }
      await s.begin();
      try {
        for (const sql of statements) {
          const r = await collect(s, sql, 1);
          results.push(
            r.affectedRows === undefined ? { sql } : { sql, affectedRows: r.affectedRows },
          );
        }
        await s.commit();
      } catch (err) {
        await s.rollback().catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Statement ${results.length + 1} of ${statements.length} failed, and the transaction was rolled back${results.length && flavor === 'mysql' ? ' (structure changes MySQL already committed stay)' : ''}: ${message}`,
          { cause: err },
        );
      }
    } finally {
      if (sqlMode !== undefined)
        await collect(
          s,
          `SET SESSION sql_mode = '${sqlMode.replace(/[^A-Za-z0-9_,]/g, '')}'`,
          1,
        ).catch(() => undefined);
      await s.setReadOnly(true).catch(() => undefined);
    }
    return results;
  }

  /** Keep finished change sets for an hour so change_status can still report them. */
  private prune(): void {
    const cutoff = Date.now() - 3600_000;
    for (const [id, st] of this.changeSets)
      if (st.summary.finishedAt && Date.parse(st.summary.finishedAt) < cutoff)
        this.changeSets.delete(id);
  }

  /**
   * Details for the Review view: the plan and, for row changes, the rows as they are now.
   * Runs read-only through the agents' session.
   */
  async review(id: string): Promise<{ plans: (string | null)[]; before: (unknown | null)[] }> {
    const state = this.changeSets.get(id);
    if (!state) throw new Error('This change set is gone');
    const conn = this.host.connections().find((c) => c.id === state.summary.connectionId);
    if (!conn) throw new Error('The connection is gone');
    const flavor = flavorOf(conn.driver);
    return this.host.withSession(conn.id, async (s) => {
      const plans: (string | null)[] = [];
      const before: (unknown | null)[] = [];
      for (const st of state.summary.statements) {
        let plan: string | null = null;
        if (st.kind === 'data' || st.kind === 'read') {
          const p = await s.explain(st.sql).catch(() => null);
          if (p?.text) plan = p.text;
          else if (p?.columns && p.rows)
            plan = [
              p.columns.map((c) => c.name).join('\t'),
              ...p.rows.map((r) => r.map((v) => JSON.stringify(valueToJson(v))).join('\t')),
            ].join('\n');
        }
        plans.push(plan);
        let rows: unknown | null = null;
        const m = /^\s*(UPDATE|DELETE)\b/i.exec(st.sql);
        if (m) {
          const stmt = splitStatements(st.sql, flavor)[0];
          const analysis = stmt
            ? await analyzeStatement(stmt, { flavor, describe: async () => null }).catch(() => null)
            : null;
          if (analysis?.estimateSql) {
            const select = analysis.estimateSql.replace(/^SELECT COUNT\(\*\)/, 'SELECT *');
            const limited =
              flavor === 'mssql' ? select.replace(/^SELECT \*/, 'SELECT TOP 50 *') : select;
            const r = await collect(s, limited, 50).catch(() => null);
            if (r) rows = resultToJson(r.columns, r.rows, r.truncated);
          }
        }
        before.push(rows);
      }
      return { plans, before };
    });
  }
}

/** describeTable as compact JSON for an agent. */
function describeJson(def: TableDefinition): Record<string, unknown> {
  return {
    schema: def.schema,
    name: def.name,
    kind: def.kind,
    ...(def.comment ? { comment: def.comment } : {}),
    ...(def.rowEstimate !== undefined ? { rowEstimate: def.rowEstimate } : {}),
    columns: def.columns.map((c) => ({
      name: c.name,
      type: c.nativeType,
      nullable: c.nullable,
      ...(c.default !== undefined
        ? {
            default:
              'sql' in c.default && c.default.t === 'expression'
                ? { expression: c.default.sql }
                : valueToJson(c.default as Value),
          }
        : {}),
      ...(c.autoIncrement ? { autoIncrement: true } : {}),
      ...(c.charset ? { charset: c.charset } : {}),
      ...(c.collation ? { collation: c.collation } : {}),
      ...(c.comment ? { comment: c.comment } : {}),
      ...(c.extra ? { extra: c.extra } : {}),
      ...(c.generated ? { generated: c.generated } : {}),
    })),
    primaryKey: def.primaryKey ?? [],
    indexes: def.indexes.map((i) => ({
      name: i.name,
      unique: i.unique,
      primary: i.primary,
      columns: i.columns.map((c) => c.name ?? c.expression ?? ''),
      ...(i.type ? { type: i.type } : {}),
    })),
    foreignKeys: def.foreignKeys,
    ...(def.ddl ? { ddl: def.ddl } : {}),
  };
}
