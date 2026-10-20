import type {
  DbObject,
  DbObjectKind,
  ExplainResult,
  ObjectDefinition,
  QueryEvent,
  QueryOptions,
  SchemaInfo,
  SelectOptions,
  ServerInfo,
  StatementClass,
  TableDefinition,
  TableRef,
  Transport,
} from '@rasql/driver-protocol';
import type { McpAccess } from './access.js';
import type { StatementAnalysis } from './changes.js';

/** The database session the server works through; the app's RemoteSession fits it. */
export interface AgentSession {
  readonly serverInfo: ServerInfo;
  readonly dialect: {
    classify(sql: string): Promise<StatementClass>;
    buildSelect(table: TableRef, opts: SelectOptions): Promise<string>;
  };
  listSchemas(): Promise<SchemaInfo[]>;
  listObjects(schema: string): Promise<DbObject[]>;
  describeTable(schema: string, table: string): Promise<TableDefinition>;
  describeObject(schema: string, kind: DbObjectKind, name: string): Promise<ObjectDefinition>;
  query(sql: string, opts?: QueryOptions): AsyncIterable<QueryEvent>;
  explain(sql: string): Promise<ExplainResult>;
  setReadOnly(on: boolean): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** A stored connection as agents may see it: no host, no user, no secret. */
export interface AgentConnection {
  id: string;
  name: string;
  group?: string;
  favorite?: boolean;
  color?: string;
  driver: string;
  environment: string;
  readOnly: boolean;
  /** The effective MCP setting, already capped by the read-only flag. */
  access: McpAccess;
  /** The one database agents may use; absent means agents see no data. */
  database?: string;
}

export interface ClientInfo {
  /** The name the client announced in initialize, e.g. "claude-code". */
  name: string;
  version?: string;
  /** A display name, when the client sent one. */
  title?: string;
}

export const clientLabel = (c: ClientInfo): string => c.title || c.name;

export interface NewConnection {
  name: string;
  driver: string;
  transport: Transport;
  host?: string;
  port?: number;
  socketPath?: string;
  filePath?: string;
  user?: string;
  /** Goes to the keychain and can never be read back. */
  password?: string;
  database?: string;
  environment?: string;
  group?: string;
  favorite?: boolean;
  color?: string;
  readOnly?: boolean;
  options?: Record<string, unknown>;
}

/** What an agent may change on a stored connection: nothing that decides where it points. */
export interface ConnectionPatch {
  name?: string;
  group?: string | null;
  favorite?: boolean;
  color?: string | null;
}

export type CommitDecision = 'once' | 'session' | 'always';

export type CommitAnswer =
  { decision: CommitDecision } | { decision: 'deny'; note?: string } | { decision: 'expired' };

export interface TableSize {
  table: string;
  rows?: number;
}

/** A change set as the prompt and the review show it. Survives structured clone. */
export interface ChangeSetSummary {
  id: string;
  client: ClientInfo;
  connectionId: string;
  connectionName: string;
  database?: string;
  description?: string;
  statements: (Omit<StatementAnalysis, 'checks' | 'estimateSql'> & {
    checks: { description: string; offendingRows: number | null }[];
    estimatedRows?: number;
  })[];
  /** The worst statement decides: safe or destructive. */
  safety: 'safe' | 'destructive';
  /** Every statement can be rolled back together. */
  atomic: boolean;
  warnings: string[];
  tableSizes: TableSize[];
  estimatedRows?: number;
  status: ChangeSetStatus;
  note?: string;
  error?: string;
  results?: { sql: string; affectedRows?: number }[];
  createdAt: string;
  finishedAt?: string;
  /** Committed without a prompt, under Read/Write or This session. */
  unprompted?: boolean;
}

export type ChangeSetStatus =
  | 'analyzing'
  | 'awaiting-approval'
  | 'running'
  | 'committed'
  | 'denied'
  | 'expired'
  | 'failed'
  | 'refused';

export type AuditOutcome =
  'ok' | 'refused' | 'denied' | 'committed' | 'failed' | 'expired' | 'error';

export interface AuditEntry {
  client: string;
  tool: string;
  outcome: AuditOutcome;
  connectionId?: string;
  connectionName?: string;
  detail?: string;
  sql?: string[];
}

/** Everything the MCP server needs from the app. The app owns storage, prompts and sessions. */
export interface McpHost {
  /** Every stored connection, hidden ones included; the server filters. */
  connections(): AgentConnection[];
  /**
   * Run with the agents' session for a connection. Calls for one connection are serialized,
   * and the session is read-only whenever the server is not committing.
   */
  withSession<T>(connectionId: string, fn: (session: AgentSession) => Promise<T>): Promise<T>;
  /** Resolves true once the user approved this client; asks on first contact. */
  approveClient(client: ClientInfo): Promise<boolean>;
  /** Asks the user, then stores the connection at Ask. Resolves null when declined. */
  createConnection(client: ClientInfo, input: NewConnection): Promise<AgentConnection | null>;
  updateConnection(id: string, patch: ConnectionPatch): AgentConnection;
  /** Shows the commit prompt; resolves with the user's answer or 'expired'. */
  promptCommit(summary: ChangeSetSummary): Promise<CommitAnswer>;
  /** "Always" in the prompt: switch the connection from Ask to Read/Write. */
  allowAlways(connectionId: string): void;
  audit(entry: AuditEntry): void;
  /** An agent did something on this connection; drives the indicator in its window. */
  activity(connectionId: string, client: ClientInfo, tool: string): void;
  /** Rows a query or sample returns at most. */
  rowLimit(): number;
  /** A change set changed state; the app refreshes any open review. */
  changeSetUpdated?(summary: ChangeSetSummary): void;
}
