/**
 * The contract between the renderer and the main process. The preload exposes exactly this
 * as `window.rasql`. Everything here must survive structured clone.
 */
import type {
  DbObject,
  DbObjectKind,
  DialectRpcMethod,
  DriverManifest,
  ExplainResult,
  ObjectDefinition,
  QueryEvent,
  QueryOptions,
  SchemaInfo,
  ServerInfo,
  TableDefinition,
  Transport,
} from '@rasql/driver-protocol';

export type Environment = 'local' | 'development' | 'staging' | 'production' | 'other';

export type CredentialRef = { provider: 'keychain'; account: string } | { provider: 'prompt' };

export type SshAuthMethod = 'auto' | 'agent' | 'key' | 'password';

/** One SSH hop. Several in a row form a jump chain; the last one reaches the database host. */
export interface SshHop {
  /** Host name, IP, or a Host alias from ~/.ssh/config. */
  host: string;
  port?: number;
  user?: string;
  auth?: SshAuthMethod;
  /** Private key file. Explicit values win over ~/.ssh/config IdentityFile entries. */
  keyPath?: string;
}

export type SecretKind = 'password' | 'ssh-password' | 'ssh-passphrase';

export interface ConnectionDefinition {
  id: string;
  name: string;
  /** Shown as a section in the connection manager. */
  group?: string;
  /** Listed under Favorites at the top of the connection manager. */
  favorite?: boolean;
  /** Overrides the environment's color. */
  color?: string;
  environment: Environment;
  readOnly: boolean;
  driver: string;
  transport: Transport;
  host?: string;
  port?: number;
  socketPath?: string;
  filePath?: string;
  user?: string;
  database?: string;
  /** Driver specific values collected from the manifest's connection form. */
  options: Record<string, unknown>;
  credentials: {
    password?: CredentialRef;
    sshPassword?: CredentialRef;
    sshPassphrase?: CredentialRef;
  };
  /** Tunnel through these hops, in order, before reaching host/port or socketPath. */
  ssh?: SshHop[];
  source?: 'manual' | 'localwp' | 'project-folder' | 'deep-link' | 'import' | 'cli';
  createdAt: string;
  updatedAt: string;
}

/** A connection arriving from a URL, a file or the command line, not yet saved. */
export interface PendingConnection {
  definition: Partial<ConnectionDefinition> & Pick<ConnectionDefinition, 'driver' | 'transport'>;
  password?: string;
  autoConnect: boolean;
}

export interface OpenSessionRequest {
  definition: ConnectionDefinition;
  /** Supplied when the user typed it. Omitted to use the stored credential. */
  password?: string;
  /** Store the supplied password in the keychain for next time. */
  savePassword?: boolean;
  /** One-shot SSH secrets typed by the user; omitted to use stored credentials. */
  sshPassword?: string;
  sshPassphrase?: string;
}

export interface OpenSessionResult {
  sessionKey: string;
  info: ServerInfo;
  manifest: DriverManifest;
}

export type SerializableQueryOptions = Omit<QueryOptions, 'signal'>;

export interface ExecResult {
  affectedRows?: number;
  insertId?: string;
  rowCount?: number;
  elapsedMs: number;
}

export type TableMenuAction =
  | 'open'
  | 'structure'
  | 'refresh'
  | 'copy-name'
  | 'copy-qualified'
  | 'copy-select'
  | 'copy-create'
  | 'truncate'
  | 'drop';

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface LocalSite {
  id: string;
  name: string;
  domain?: string;
  path?: string;
  database: string;
  user: string;
  password: string;
  socketPath?: string;
  port?: number;
  /** True when the site's MySQL socket exists, which Local only keeps while the site runs. */
  running: boolean;
}

export interface LocalAddonStatus {
  localPresent: boolean;
  bundledAvailable: boolean;
  installed: boolean;
  enabled: boolean;
  installedVersion?: string;
  bundledVersion: string;
  needsUpdate: boolean;
  addonDir: string;
}

export interface HistoryEntry {
  id: string;
  /** Saved connection id, or the connection name for unsaved ones. */
  connection: string;
  sql: string;
  startedAt: string;
  elapsedMs?: number;
  rowCount?: number;
  affectedRows?: number;
  error?: string;
}

/** A named query. `connection` is the saved connection id, or null for every connection. */
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connection: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedQueryInput {
  /** Present to update an existing query. */
  id?: string;
  name: string;
  sql: string;
  connection: string | null;
}

export type ExportFormat = 'csv' | 'json' | 'sql';

export interface ExportRequest {
  sessionKey: string;
  /** The statement whose full result is exported; it is re-run and streamed, never the loaded page. */
  sql: string;
  format: ExportFormat;
  /** Suggested file name without extension. */
  suggestedName: string;
  /** Required for SQL format: the table the INSERT statements target. */
  table?: { schema?: string; name: string };
  options?: {
    delimiter?: ',' | ';' | '\t';
    header?: boolean;
    /** How NULL is written in CSV. Default empty. */
    nullAs?: string;
    /** JSON: one object per line instead of an array. */
    ndjson?: boolean;
    /** SQL: rows per INSERT statement. Default 500. */
    batchSize?: number;
  };
}

export interface ExportProgress {
  exportId: string;
  rows: number;
  bytes: number;
  done: boolean;
  error?: string;
  filePath?: string;
}

/** A file the user picked for a cell, read in the main process. */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  mime?: string;
}

export interface QueryEventMessage {
  queryId: string;
  event: QueryEvent;
}

export interface RasqlApi {
  drivers: {
    list(): Promise<DriverManifest[]>;
  };
  connections: {
    list(): Promise<ConnectionDefinition[]>;
    save(def: ConnectionDefinition): Promise<ConnectionDefinition>;
    remove(id: string): Promise<void>;
    hasStoredPassword(id: string): Promise<boolean>;
    setPassword(id: string, password: string): Promise<void>;
    forgetPassword(id: string): Promise<void>;
    hasSecret(id: string, kind: SecretKind): Promise<boolean>;
    setSecret(id: string, kind: SecretKind, secret: string): Promise<void>;
    forgetSecret(id: string, kind: SecretKind): Promise<void>;
  };
  ssh: {
    /** Host aliases from ~/.ssh/config, without wildcard patterns. */
    aliases(): Promise<string[]>;
  };
  session: {
    open(req: OpenSessionRequest): Promise<OpenSessionResult>;
    /** Everything a connection window needs; used by windows opened for an existing session. */
    describe(
      sessionKey: string,
    ): Promise<{ definition: ConnectionDefinition; info: ServerInfo; manifest: DriverManifest }>;
    close(sessionKey: string): Promise<void>;
    listSchemas(sessionKey: string): Promise<SchemaInfo[]>;
    listObjects(sessionKey: string, schema: string): Promise<DbObject[]>;
    describeTable(sessionKey: string, schema: string, table: string): Promise<TableDefinition>;
    /** A routine, trigger, event or view; rejects with UNSUPPORTED when the driver cannot. */
    describeObject(
      sessionKey: string,
      schema: string,
      kind: DbObjectKind,
      name: string,
    ): Promise<ObjectDefinition>;
    dialect(sessionKey: string, method: DialectRpcMethod, args: unknown[]): Promise<unknown>;
    startQuery(sessionKey: string, sql: string, opts?: SerializableQueryOptions): Promise<string>;
    cancelQuery(queryId: string): Promise<void>;
    onQueryEvent(listener: (message: QueryEventMessage) => void): () => void;
    /** Run one statement to completion. Rejects with the engine's error. */
    exec(sessionKey: string, sql: string): Promise<ExecResult>;
    explain(sessionKey: string, sql: string): Promise<ExplainResult>;
    /** Run statements inside one transaction; rolls back and rejects on the first failure. */
    transaction(sessionKey: string, statements: string[]): Promise<ExecResult[]>;
  };
  savedQueries: {
    /** This connection's queries plus the shared ones, sorted by name. */
    list(connection: string): Promise<SavedQuery[]>;
    save(query: SavedQueryInput): Promise<SavedQuery>;
    remove(id: string): Promise<void>;
  };
  history: {
    list(connection: string, limit?: number): Promise<HistoryEntry[]>;
    add(entry: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry>;
    clear(connection: string): Promise<void>;
  };
  export: {
    /** Asks for a destination, then streams. Resolves with the export id, or null when cancelled in the dialog. */
    start(req: ExportRequest): Promise<string | null>;
    cancel(exportId: string): Promise<void>;
    onProgress(listener: (p: ExportProgress) => void): () => void;
  };
  localwp: {
    status(): Promise<LocalAddonStatus>;
    installAddon(): Promise<LocalAddonStatus>;
    uninstallAddon(): Promise<LocalAddonStatus>;
    sites(): Promise<LocalSite[]>;
    pendingFor(site: LocalSite): Promise<PendingConnection>;
  };
  menu: {
    /** Native context menu for a table or view in the sidebar. Resolves with the chosen action. */
    tableContext(ctx: {
      schema: string;
      table: string;
      kind: 'table' | 'view';
    }): Promise<TableMenuAction | null>;
  };
  /** File operations for the cell inspector: replace from file, save, external editor round trip. */
  cells: {
    pickFile(opts?: { title?: string }): Promise<PickedFile | null>;
    saveFile(bytes: Uint8Array, suggestedName: string): Promise<string | null>;
    /** Writes a temp file and opens it with the default application; returns its path for reloading. */
    openExternally(bytes: Uint8Array, extension: string): Promise<{ path: string }>;
    /** Reads back a file this session saved, picked or opened externally; other paths are refused. */
    readFile(path: string): Promise<Uint8Array>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  dialog: {
    openFile(opts: { title?: string; extensions?: string[] }): Promise<string | null>;
    confirm(opts: ConfirmOptions): Promise<boolean>;
  };
  app: {
    platform: string;
    version: string;
    /** Short git commit the build came from, with +dirty for uncommitted changes. */
    commit: string;
    /** ISO timestamp of the build. */
    builtAt: string;
    /** Show the connection manager window, creating it if needed. */
    showLauncher(): Promise<void>;
    /** Close the calling window; for a connection window that ends the session. */
    closeWindow(): Promise<void>;
    onPendingConnection(listener: (pending: PendingConnection) => void): () => void;
    /** Ask main to replay a pending connection delivered before the renderer was listening. */
    takePendingConnection(): Promise<PendingConnection | null>;
    /** Show a file in Finder or Explorer. */
    revealPath(path: string): Promise<void>;
    /** Fires when this window regains focus. */
    onFocus(listener: () => void): () => void;
  };
}

export const IPC = {
  driversList: 'drivers:list',
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsRemove: 'connections:remove',
  connectionsHasPassword: 'connections:hasPassword',
  connectionsSetPassword: 'connections:setPassword',
  connectionsForgetPassword: 'connections:forgetPassword',
  connectionsHasSecret: 'connections:hasSecret',
  connectionsSetSecret: 'connections:setSecret',
  connectionsForgetSecret: 'connections:forgetSecret',
  sshAliases: 'ssh:aliases',
  sessionOpen: 'session:open',
  sessionClose: 'session:close',
  sessionListSchemas: 'session:listSchemas',
  sessionListObjects: 'session:listObjects',
  sessionDescribeTable: 'session:describeTable',
  sessionDescribeObject: 'session:describeObject',
  savedQueriesList: 'savedQueries:list',
  savedQueriesSave: 'savedQueries:save',
  savedQueriesRemove: 'savedQueries:remove',
  sessionDialect: 'session:dialect',
  sessionQueryStart: 'session:query:start',
  sessionQueryCancel: 'session:query:cancel',
  sessionQueryEvent: 'session:query:event',
  sessionExec: 'session:exec',
  sessionExplain: 'session:explain',
  sessionTransaction: 'session:transaction',
  menuTableContext: 'menu:tableContext',
  historyList: 'history:list',
  historyAdd: 'history:add',
  historyClear: 'history:clear',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportProgress: 'export:progress',
  localwpStatus: 'localwp:status',
  localwpInstall: 'localwp:install',
  localwpUninstall: 'localwp:uninstall',
  localwpSites: 'localwp:sites',
  localwpPending: 'localwp:pending',
  clipboardWriteText: 'clipboard:writeText',
  dialogConfirm: 'dialog:confirm',
  appFocus: 'app:focus',
  appRevealPath: 'app:revealPath',
  cellsPickFile: 'cells:pickFile',
  cellsSaveFile: 'cells:saveFile',
  cellsOpenExternally: 'cells:openExternally',
  cellsReadFile: 'cells:readFile',
  dialogOpenFile: 'dialog:openFile',
  appShowLauncher: 'app:showLauncher',
  appCloseWindow: 'app:closeWindow',
  sessionDescribe: 'session:describe',
  appPendingConnection: 'app:pendingConnection',
  appTakePending: 'app:takePending',
} as const;

export const ENVIRONMENT_COLORS: Record<Environment, string> = {
  local: '#3b9c5a',
  development: '#3a86c8',
  staging: '#d99a1f',
  production: '#d43f3f',
  other: '#7a7f8a',
};
