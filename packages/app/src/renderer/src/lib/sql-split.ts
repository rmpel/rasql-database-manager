/** One statement inside an editor document, with its character range. */
export interface Statement {
  start: number;
  end: number;
  sql: string;
}

/**
 * Split editor text into statements on semicolons that are outside string literals, quoted
 * identifiers and comments. Pure, and tolerant of unterminated input: whatever is left at the
 * end is the last statement.
 */
export function splitStatements(text: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    if (sql.length && !isOnlyComments(sql)) {
      out.push({ start: start + lead, end: start + lead + sql.length, sql });
    }
    start = end + 1;
  };
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\' && c !== '`') i++;
        i++;
      }
      i++;
      continue;
    }
    if ((c === '-' && next === '-') || c === '#') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === ';') {
      push(i);
      i++;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

/** True when the text holds nothing but comments and whitespace. */
function isOnlyComments(sql: string): boolean {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\n)\s*(--|#)[^\n]*/g, ' ')
      .trim().length === 0
  );
}

/** The statement containing the cursor, or the nearest one before it, or the last one. */
export function statementAt(text: string, cursor: number): Statement | null {
  const all = splitStatements(text);
  if (all.length === 0) return null;
  for (const s of all) if (cursor >= s.start && cursor <= s.end) return s;
  // Between statements: the gap belongs to the statement that precedes it, unless the cursor sits
  // on a separator line before the first.
  let best: Statement | null = null;
  for (const s of all) if (s.end < cursor) best = s;
  return best ?? all[0] ?? null;
}
