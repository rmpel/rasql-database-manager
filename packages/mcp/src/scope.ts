import {
  findTopLevel,
  isWord,
  nameChains,
  nameOf,
  type Flavor,
  type Statement,
  type Token,
} from './sql.js';

/** Why a statement is refused before it reaches the database. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

export interface ScopeContext {
  flavor: Flavor;
  /** The database named in the connection. For SQLite, the attached file's 'main'. */
  database: string;
  /** Databases the server reports, so db.table can be told apart from table.column. */
  knownDatabases: string[];
}

/** MySQL's own databases, which a user without privileges on them does not see listed. */
const MYSQL_SYSTEM = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

const ci = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The first database other than the connection's own that a statement names, or null.
 * An agent works in the connection's database only (MCP.md section 1).
 */
export function foreignDatabase(stmt: Statement, ctx: ScopeContext): string | null {
  const { tokens } = stmt;
  const { flavor, database } = ctx;
  const head = tokens[0];
  const other = (name: string): boolean =>
    flavor === 'mssql' || flavor === 'sqlite' ? !ci(name, database) : name !== database;

  if (isWord(head, 'USE')) {
    const t = tokens[1];
    return t ? nameOf(t) : 'another database';
  }
  if (isWord(head, 'ATTACH', 'DETACH')) return 'an attached database';

  if (flavor === 'mysql') {
    if (isWord(head, 'SHOW')) {
      if (isWord(tokens[1], 'DATABASES', 'SCHEMAS')) return 'every database';
      const at = tokens.findIndex((t) => isWord(t, 'FROM', 'IN'));
      const t = at === -1 ? undefined : tokens[at + 1];
      if (t && (t.kind === 'word' || t.kind === 'ident') && other(nameOf(t))) return nameOf(t);
    }
    // CREATE / DROP / ALTER DATABASE x
    if (isWord(head, 'CREATE', 'DROP', 'ALTER') && isWord(tokens[1], 'DATABASE', 'SCHEMA')) {
      let i = 2;
      while (isWord(tokens[i], 'IF', 'NOT', 'EXISTS')) i++;
      const t = tokens[i];
      if (t && (t.kind === 'word' || t.kind === 'ident') && other(nameOf(t))) return nameOf(t);
    }
  }
  if (flavor === 'mssql') {
    if (isWord(head, 'CREATE', 'DROP', 'ALTER') && isWord(tokens[1], 'DATABASE')) {
      const t = tokens[2];
      if (t && other(nameOf(t))) return nameOf(t);
    }
    const remote = tokens.find((t) => isWord(t, 'OPENROWSET', 'OPENDATASOURCE', 'OPENQUERY'));
    if (remote) return `a remote source through ${remote.value}`;
  }
  if (flavor === 'postgres') {
    const remote = tokens.find((t) => t.kind === 'word' && t.value.startsWith('DBLINK'));
    if (remote) return 'a remote database through dblink';
  }

  const known = new Set(ctx.knownDatabases.map((d) => d.toLowerCase()));
  for (const { parts: chain, before } of nameChains(tokens)) {
    const first = chain[0] as string;
    if (flavor === 'sqlite') {
      // schema.table.column; 'main' and 'temp' are the connection's own.
      if (chain.length >= 3 && !['main', 'temp'].includes(first.toLowerCase())) return first;
      continue;
    }
    if (flavor === 'mssql') {
      if (chain.length >= 4) return `a linked server ${first}`;
      if (chain.length === 3 && first !== '' && other(first)) return first;
      continue;
    }
    if (flavor === 'mysql') {
      if (chain.length >= 3 && other(first)) return first;
      // db.table or table.column: a known or system database, or a name where a table goes.
      const tablePosition = isWord(before, 'FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'TABLES');
      const database = known.has(first.toLowerCase()) || MYSQL_SYSTEM.has(first.toLowerCase());
      if (chain.length === 2 && other(first) && (database || tablePosition)) return first;
      continue;
    }
    // PostgreSQL and unknown engines: database.schema.table.
    if (chain.length >= 3 && other(first)) return first;
  }
  return null;
}

/** Functions that read files, sleep, signal other sessions or reach outside the database. */
const UNSAFE_FUNCTIONS = new Set([
  'LOAD_FILE',
  'SLEEP',
  'BENCHMARK',
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  'PG_SLEEP',
  'PG_SLEEP_FOR',
  'PG_SLEEP_UNTIL',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'PG_STAT_FILE',
  'LO_IMPORT',
  'LO_EXPORT',
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF',
  'SET_CONFIG',
  'PG_ADVISORY_LOCK',
  'XP_CMDSHELL',
  'XP_DIRTREE',
  'XP_FILEEXIST',
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
]);

/** Throws when a statement calls a function from the list above. */
export function assertNoUnsafeFunctions(stmt: Statement): void {
  const { tokens } = stmt;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i] as Token;
    const next = tokens[i + 1] as Token;
    if (
      t.kind === 'word' &&
      next.kind === 'punct' &&
      next.value === '(' &&
      UNSAFE_FUNCTIONS.has(t.value)
    )
      throw new Refusal(`${t.text}() is not available to agents`);
  }
}

/** Statements that read or write files on the server or the computer RaSQL runs on. */
export function assertNoFileAccess(stmt: Statement): void {
  const { tokens } = stmt;
  const head = tokens[0];
  if (isWord(head, 'LOAD', 'COPY', 'BULK', 'IMPORT', 'EXPORT'))
    throw new Refusal(`${head?.value} statements are not available to agents`);
  if (tokens.some((t) => isWord(t, 'OUTFILE', 'DUMPFILE', 'INFILE')))
    throw new Refusal('Reading or writing files is not available to agents');
}

const INNER_STATEMENT = [
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'MERGE',
  'VALUES',
  'TABLE',
];

/**
 * Checks for a statement the dialect already classified as a read. Classification looks at the
 * leading keyword only; these cover the reads that still change something.
 */
export function assertPlainRead(stmt: Statement): void {
  const { tokens } = stmt;
  const head = tokens[0];
  if (!head) throw new Refusal('The statement is empty');
  assertNoFileAccess(stmt);
  assertNoUnsafeFunctions(stmt);
  if (isWord(head, 'EXPLAIN', 'DESCRIBE', 'DESC')) {
    // EXPLAIN ANALYZE runs the statement it explains.
    const inner = tokens.findIndex((t, i) => i > 0 && isWord(t, ...INNER_STATEMENT));
    const options = inner === -1 ? tokens : tokens.slice(0, inner);
    if (options.some((t) => isWord(t, 'ANALYZE', 'ANALYSE')))
      throw new Refusal('EXPLAIN ANALYZE runs the statement; use the explain tool instead');
    if (inner !== -1 && !isWord(tokens[inner], 'SELECT', 'WITH', 'VALUES', 'TABLE'))
      throw new Refusal('Only reads can be explained here; use the explain tool');
    return;
  }
  if (isWord(head, 'SELECT', 'WITH')) {
    // SELECT ... INTO creates a table (PostgreSQL, SQL Server) or writes a file (MySQL).
    if (findTopLevel(tokens, (t) => isWord(t, 'INTO')) !== -1)
      throw new Refusal('SELECT … INTO writes; submit it with commit_changes instead');
  }
}
