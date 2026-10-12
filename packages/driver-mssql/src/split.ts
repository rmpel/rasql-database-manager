/** One batch of a script: the text between GO lines, run `repeat` times (GO 5). */
export interface Batch {
  sql: string;
  offset: number;
  repeat: number;
}

/**
 * Walk T-SQL text, calling `code` for every stretch outside 'strings', [identifiers],
 * "identifiers", -- comments and nested /* comments *\/. Returns nothing; used by the
 * splitter and the read-only check so both agree on what is code.
 */
function scan(text: string, code: (from: number, to: number) => void): void {
  const n = text.length;
  let i = 0;
  let start = 0;
  const skipTo = (end: number): void => {
    if (i > start) code(start, i);
    i = end;
    start = end;
  };
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      skipTo(nl === -1 ? n : nl);
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      skipTo(j);
    } else if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === close) {
          if (text[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      skipTo(Math.min(j + 1, n));
    } else i++;
  }
  if (i > start) code(start, i);
}

/**
 * Split a script into batches on lines that hold only GO (and an optional repeat count), the
 * separator of sqlcmd and SQL Server Management Studio. GO inside strings or comments is text.
 */
export function splitBatches(text: string): Batch[] {
  const separators: { from: number; to: number; repeat: number }[] = [];
  scan(text, (from, to) => {
    const re = /^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*;?[ \t]*$/gim;
    const chunk = text.slice(from, to);
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk)) !== null) {
      const at = from + m.index;
      // The line must really start here, not inside a code stretch that began mid-line.
      if (at > 0 && text[at - 1] !== '\n') continue;
      separators.push({ from: at, to: at + m[0].length, repeat: m[1] ? Number(m[1]) : 1 });
    }
  });
  const out: Batch[] = [];
  let start = 0;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    const sql = raw.trim();
    if (sql && /\S/.test(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''))) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ sql, offset: start + lead, repeat: 1 });
    }
  };
  for (const sep of separators) {
    push(sep.from);
    // GO n repeats the batch before it.
    const last = out[out.length - 1];
    if (last && sep.repeat > 1 && last.offset >= start) last.repeat = sep.repeat;
    start = sep.to;
  }
  push(text.length);
  return out;
}

const WRITES =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|INTO|BULK|BACKUP|RESTORE|DBCC|KILL|SHUTDOWN|RECONFIGURE|WRITETEXT|UPDATETEXT|OPENROWSET|OPENQUERY|SP_\w+|XP_\w+)\b/i;

/**
 * True when a batch can only read: it starts with SELECT or WITH (or DECLARE, SET or PRINT for
 * scripts that read with variables) and names no statement or clause that writes, anywhere
 * outside strings and comments. Strict on purpose: a false refusal is better than a write.
 */
export function isReadOnlyBatch(sql: string): boolean {
  let code = '';
  scan(sql, (from, to) => {
    code += `${sql.slice(from, to)} `;
  });
  const first = /^\s*;?\s*([a-z]+)/i.exec(code)?.[1]?.toLowerCase();
  if (!first || !['select', 'with', 'declare', 'set', 'print'].includes(first)) return false;
  return !WRITES.test(code);
}
