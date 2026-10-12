/** One statement inside an editor document, with its character range. */
export interface Statement {
  start: number;
  end: number;
  sql: string;
}

/** How an engine writes strings, names and comments, as far as finding statements goes. */
export type SqlFlavor = 'mysql' | 'postgres' | 'mssql' | 'sqlite';

export function flavorOf(engine: string): SqlFlavor {
  if (engine === 'postgres') return 'postgres';
  if (engine === 'mssql' || engine === 'azure-sql') return 'mssql';
  if (engine === 'sqlite') return 'sqlite';
  return 'mysql';
}

/**
 * Split editor text into statements on semicolons that are outside string literals, quoted
 * identifiers and comments, the way the engine reads them:
 * - MySQL: backslash escapes, `backticks` and # comments;
 * - PostgreSQL: $tag$ dollar quotes $tag$, E'escapes' and nested block comments;
 * - SQL Server: [brackets], GO lines, and semicolons inside BEGIN … END or CASE … END belong
 *   to the block (a procedure body is one statement);
 * - SQLite: "names", `names` and [names], no backslash escapes.
 * Pure, and tolerant of unterminated input: whatever is left at the end is the last statement.
 */
export function splitStatements(text: string, flavor: SqlFlavor = 'mysql'): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  let depth = 0;
  const push = (end: number, next: number): void => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    if (sql.length && !isOnlyComments(sql, flavor)) {
      out.push({ start: start + lead, end: start + lead + sql.length, sql });
    }
    start = next;
    depth = 0;
  };
  const skipQuoted = (close: string, backslash: boolean): void => {
    i++;
    while (i < n) {
      if (backslash && text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === close) {
        // A doubled quote is the quote itself.
        if (text[i + 1] === close && !backslash) {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    i++;
  };
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "'") {
      const escapeString =
        flavor === 'postgres' && /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      skipQuoted("'", flavor === 'mysql' || escapeString);
      continue;
    }
    if (c === '"') {
      skipQuoted('"', flavor === 'mysql');
      continue;
    }
    if (c === '`' && (flavor === 'mysql' || flavor === 'sqlite')) {
      skipQuoted('`', false);
      continue;
    }
    if (c === '[' && (flavor === 'mssql' || flavor === 'sqlite')) {
      skipQuoted(']', false);
      continue;
    }
    if (c === '$' && flavor === 'postgres' && !/[\w$]/.test(text[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    if ((c === '-' && next === '-') || (c === '#' && flavor === 'mysql')) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      // PostgreSQL and SQL Server nest block comments; MySQL and SQLite end at the first */.
      const nests = flavor === 'postgres' || flavor === 'mssql';
      let level = 1;
      i += 2;
      while (i < n && level > 0) {
        if (nests && text[i] === '/' && text[i + 1] === '*') {
          level++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          level--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (flavor === 'mssql' && /[A-Za-z]/.test(c) && !/[\w@#$]/.test(text[i - 1] ?? '')) {
      const word = /^[A-Za-z_]+/.exec(text.slice(i, i + 32))?.[0] ?? c;
      const up = word.toUpperCase();
      if (up === 'GO' && isLineAlone(text, i, word.length)) {
        const nl = text.indexOf('\n', i);
        push(i, nl === -1 ? n : nl + 1);
        i = nl === -1 ? n : nl + 1;
        continue;
      }
      if (up === 'CASE') depth++;
      else if (up === 'END') depth = Math.max(0, depth - 1);
      else if (up === 'BEGIN') {
        const after = text.slice(i + word.length, i + word.length + 40);
        // BEGIN TRAN and a bare BEGIN; start transactions, not blocks.
        if (!/^\s*(TRAN|TRANSACTION|DISTRIBUTED|DIALOG|CONVERSATION)\b|^\s*(;|$)/i.test(after))
          depth++;
      }
      i += word.length;
      continue;
    }
    if (c === ';' && depth === 0) {
      push(i, i + 1);
      i++;
      continue;
    }
    i++;
  }
  push(n, n);
  return out;
}

/** GO is a batch separator only on a line of its own, optionally with a repeat count. */
function isLineAlone(text: string, at: number, length: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  if (text.slice(lineStart, at).trim() !== '') return false;
  const nl = text.indexOf('\n', at);
  const rest = text.slice(at + length, nl === -1 ? text.length : nl);
  return /^\s*(\d+)?\s*;?\s*$/.test(rest);
}

/** True when the text holds nothing but comments and whitespace. */
function isOnlyComments(sql: string, flavor: SqlFlavor): boolean {
  const line = flavor === 'mysql' ? /(^|\n)\s*(--|#)[^\n]*/g : /(^|\n)\s*--[^\n]*/g;
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(line, ' ')
      .trim().length === 0
  );
}

/** The statement containing the cursor, or the nearest one before it, or the last one. */
export function statementAt(
  text: string,
  cursor: number,
  flavor: SqlFlavor = 'mysql',
): Statement | null {
  const all = splitStatements(text, flavor);
  if (all.length === 0) return null;
  for (const s of all) if (cursor >= s.start && cursor <= s.end) return s;
  // Between statements: the gap belongs to the statement that precedes it, unless the cursor sits
  // on a separator line before the first.
  let best: Statement | null = null;
  for (const s of all) if (s.end < cursor) best = s;
  return best ?? all[0] ?? null;
}
