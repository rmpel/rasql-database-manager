/** One statement of a script, with where it starts in the original text. */
export interface ScriptStatement {
  sql: string;
  offset: number;
}

/**
 * Split a script on semicolons the way PostgreSQL reads it: outside 'strings' (with ''),
 * E'strings' (with backslash escapes), "identifiers", $tag$ dollar quotes $tag$, -- comments
 * and nested /* block comments *\/. Statements that are only whitespace or comments are dropped.
 */
export function splitPostgres(text: string): ScriptStatement[] {
  const out: ScriptStatement[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  let meaningful = false;
  const push = (end: number): void => {
    if (meaningful) {
      const raw = text.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      out.push({ sql: raw.trim(), offset: start + lead });
    }
    start = end + 1;
    meaningful = false;
  };
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === ';') {
      push(i);
      i++;
      continue;
    }
    if (!/\s/.test(c)) meaningful = true;
    if (c === "'" || c === '"') {
      // E'...' (escape string syntax) honours backslashes; standard strings do not.
      const prev = text[i - 1];
      const escapes = c === "'" && (prev === 'E' || prev === 'e') && !/\w/.test(text[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      // $1 is a parameter, and a $ inside an identifier (a$b) is not a quote.
      if (tag && !/[\w$]/.test(text[i - 1] ?? '')) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    i++;
  }
  push(n);
  return out;
}
