/**
 * A small SQL tokenizer for the MCP permission layer. It does not parse SQL; it only knows
 * enough about strings, quoted identifiers and comments to find statement boundaries,
 * leading keywords and qualified names without being fooled by text inside literals.
 */

/** Which quoting rules apply. Third-party drivers fall back to 'generic'. */
export type Flavor = 'mysql' | 'postgres' | 'mssql' | 'sqlite' | 'generic';

export function flavorOf(driverId: string): Flavor {
  if (driverId === 'mysql' || driverId === 'mariadb') return 'mysql';
  if (driverId === 'postgres') return 'postgres';
  if (driverId === 'mssql') return 'mssql';
  if (driverId === 'sqlite') return 'sqlite';
  return 'generic';
}

export type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct' | 'variable';

export interface Token {
  kind: TokenKind;
  /** Source text, quotes included. */
  text: string;
  /** Upper-cased word, or the unquoted name for identifiers and words. */
  value: string;
  start: number;
  end: number;
}

const isWordStart = (c: string): boolean => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** Tokens without whitespace and comments. Unterminated quotes run to the end of the input. */
export function tokenize(sql: string, flavor: Flavor): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  const push = (kind: TokenKind, start: number, end: number, value: string): void => {
    out.push({ kind, text: sql.slice(start, end), value, start, end });
  };
  /** Read a quoted run ending in `close`, where a doubled close quote is an escaped one. */
  const quoted = (start: number, close: string, backslash: boolean): number => {
    let j = start + 1;
    while (j < n) {
      const c = sql[j] as string;
      if (backslash && c === '\\') {
        j += 2;
        continue;
      }
      if (c === close) {
        if (sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '#' && flavor === 'mysql') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      // PostgreSQL nests block comments; the others end at the first */.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (flavor === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      i = j;
      continue;
    }
    if (c === "'") {
      const end = quoted(i, "'", flavor === 'mysql');
      push('string', i, end, sql.slice(i + 1, end - 1));
      i = end;
      continue;
    }
    // Prefixed strings: N'..' (SQL Server, MySQL), E'..' (PostgreSQL), X'..', B'..'.
    if (/[NnEeXxBb]/.test(c) && next === "'") {
      const end = quoted(i + 1, "'", flavor === 'mysql' || /[Ee]/.test(c));
      push('string', i, end, sql.slice(i + 2, end - 1));
      i = end;
      continue;
    }
    if (c === '"') {
      const end = quoted(i, '"', flavor === 'mysql');
      // MySQL reads "..." as a string unless ANSI_QUOTES is on; the others as an identifier.
      push(
        flavor === 'mysql' ? 'string' : 'ident',
        i,
        end,
        sql.slice(i + 1, end - 1).replace(/""/g, '"'),
      );
      i = end;
      continue;
    }
    if (c === '`' && flavor !== 'postgres' && flavor !== 'mssql') {
      const end = quoted(i, '`', false);
      push('ident', i, end, sql.slice(i + 1, end - 1).replace(/``/g, '`'));
      i = end;
      continue;
    }
    if (c === '[' && (flavor === 'mssql' || flavor === 'sqlite')) {
      const end = quoted(i, ']', false);
      push('ident', i, end, sql.slice(i + 1, end - 1).replace(/]]/g, ']'));
      i = end;
      continue;
    }
    if (c === '$' && flavor === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        push('string', i, end, sql.slice(i + tag.length, close === -1 ? n : close));
        i = end;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j] as string)) {
        // A dot followed by a letter is a qualifier, not a decimal point: 1.e5 is rare enough.
        if (sql[j] === '.' && !/[0-9]/.test(sql[j + 1] ?? '')) break;
        j++;
      }
      push('number', i, j, sql.slice(i, j));
      i = j;
      continue;
    }
    if (
      c === '@' ||
      (c === ':' && next !== undefined && isWordStart(next) && flavor !== 'postgres')
    ) {
      let j = i + 1;
      if (sql[j] === '@') j++;
      if (sql[j] === '`' || sql[j] === "'" || sql[j] === '"')
        j = quoted(j, sql[j] as string, false);
      else while (j < n && isWordChar(sql[j] as string)) j++;
      push('variable', i, j, sql.slice(i, j));
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j] as string)) j++;
      const word = sql.slice(i, j);
      push('word', i, j, word.toUpperCase());
      i = j;
      continue;
    }
    // Multi-character operators matter only as boundaries; keep them as single tokens.
    const two = sql.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '::', '||', ':='].includes(two)) {
      push('punct', i, i + 2, two);
      i += 2;
      continue;
    }
    push('punct', i, i + 1, c);
    i++;
  }
  return out;
}

/** The name an identifier or word token stands for, as the engine would look it up. */
export const nameOf = (t: Token): string => (t.kind === 'ident' ? t.value : t.text);

export interface Statement {
  sql: string;
  tokens: Token[];
}

const ROUTINE =
  /^(CREATE|ALTER)\b(\s+OR\s+REPLACE)?(\s+DEFINER\s*=\s*\S+)?(\s+(AGGREGATE|DEFINITION))?\s+(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i;

/**
 * Split a script into statements at top-level semicolons. A routine, trigger or event
 * definition is kept whole, because its body contains semicolons of its own.
 */
export function splitStatements(sql: string, flavor: Flavor): Statement[] {
  const tokens = tokenize(sql, flavor);
  const out: Statement[] = [];
  let startTok = 0;
  const emit = (endTok: number): void => {
    const toks = tokens.slice(startTok, endTok);
    if (toks.length) {
      const first = toks[0] as Token;
      const last = toks[toks.length - 1] as Token;
      const text = sql.slice(first.start, last.end);
      // Re-tokenized so offsets are relative to the statement's own text.
      out.push({ sql: text, tokens: tokenize(text, flavor) });
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && t.value === ';') {
      const head = tokens[startTok];
      if (head && ROUTINE.test(sql.slice(head.start, t.start))) {
        // The whole rest belongs to the routine; nothing sensible can follow it.
        continue;
      }
      emit(i);
      startTok = i + 1;
    }
  }
  emit(tokens.length);
  return out;
}

/** Index of the first token at paren depth 0 matching the predicate, from `from`. */
export function findTopLevel(
  tokens: Token[],
  pred: (t: Token, i: number) => boolean,
  from = 0,
): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && pred(t, i)) return i;
  }
  return -1;
}

export const isWord = (t: Token | undefined, ...words: string[]): boolean =>
  t !== undefined && t.kind === 'word' && words.includes(t.value);

/** Split tokens at top-level commas. */
export function splitTopLevelCommas(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let depth = 0;
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.kind === 'punct' && t.value === '(') depth++;
    if (t.kind === 'punct' && t.value === ')') depth--;
    if (depth === 0 && t.kind === 'punct' && t.value === ',') {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length) parts.push(current);
  return parts;
}

export interface NameChain {
  parts: string[];
  /** The token in front of the chain, e.g. FROM, which tells a table from a column. */
  before?: Token;
}

/**
 * Dotted name chains such as db.table, schema.table.column or [db]..[table], in source order.
 * An empty part stands for SQL Server's `db..table` shorthand.
 */
export function nameChains(tokens: Token[]): NameChain[] {
  const chains: NameChain[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== 'word' && t.kind !== 'ident') continue;
    const prev = tokens[i - 1];
    if (prev && prev.kind === 'punct' && prev.value === '.') continue;
    const chain = [nameOf(t)];
    let j = i + 1;
    while (j < tokens.length) {
      const dot = tokens[j] as Token;
      if (dot.kind !== 'punct' || dot.value !== '.') break;
      const part = tokens[j + 1];
      if (part && part.kind === 'punct' && part.value === '.') {
        chain.push('');
        j += 1;
        continue;
      }
      if (!part || (part.kind !== 'word' && part.kind !== 'ident' && part.value !== '*')) break;
      chain.push(part.kind === 'punct' ? '*' : nameOf(part));
      j += 2;
    }
    if (chain.length > 1) chains.push(prev ? { parts: chain, before: prev } : { parts: chain });
    i = j - 1;
  }
  return chains;
}

/** A table reference: optional qualifier and the table's name, read from position `i`. */
export function readTableName(
  tokens: Token[],
  i: number,
): { schema?: string; name: string; next: number } | null {
  const first = tokens[i];
  if (!first || (first.kind !== 'word' && first.kind !== 'ident')) return null;
  const parts = [nameOf(first)];
  let j = i + 1;
  while (tokens[j]?.kind === 'punct' && tokens[j]?.value === '.') {
    const part = tokens[j + 1];
    if (!part || (part.kind !== 'word' && part.kind !== 'ident')) break;
    parts.push(nameOf(part));
    j += 2;
  }
  const name = parts[parts.length - 1] as string;
  const schema = parts.length > 1 ? (parts[parts.length - 2] as string) : undefined;
  return schema === undefined ? { name, next: j } : { schema, name, next: j };
}

/** Source text between two token indexes, inclusive of `from`, exclusive of `to`. */
export function textBetween(sql: string, tokens: Token[], from: number, to: number): string {
  const a = tokens[from];
  const b = tokens[to - 1];
  if (!a || !b || to <= from) return '';
  return sql.slice(a.start, b.end);
}
