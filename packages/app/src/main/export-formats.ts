/**
 * Pure formatters for export. Each takes typed Values and returns text; nothing here touches a
 * file or a session, so every branch is unit-testable.
 */
import type { ColumnMeta, Value } from '@rasql/driver-protocol';

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvOptions {
  delimiter: CsvDelimiter;
  header: boolean;
  nullAs: string;
}

export const DEFAULT_CSV: CsvOptions = { delimiter: ',', header: true, nullAs: '' };

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}

export function bitsToBinary(b: Uint8Array, bits: number): string {
  const all = [...b].map((x) => x.toString(2).padStart(8, '0')).join('');
  return bits > 0 ? all.slice(-bits).padStart(bits, '0') : all;
}

/** The text a cell becomes in CSV, before quoting. */
export function csvCell(v: Value, nullAs: string): string {
  switch (v.t) {
    case 'null':
      return nullAs;
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'int':
    case 'decimal':
      return v.v;
    case 'float':
      return String(v.v);
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'json':
    case 'enum':
      return v.v;
    case 'set':
      return v.v.join(',');
    case 'bit':
      return bitsToBinary(v.v, v.bits);
    case 'bytes':
    case 'geometry':
    case 'unknown':
      return `0x${bytesToHex(v.v)}`;
  }
}

/** RFC 4180: quote when the field contains the delimiter, a quote, or a line break; double quotes inside. */
export function csvQuote(s: string, delimiter: string): string {
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvHeaderLine(columns: ColumnMeta[], opts: CsvOptions): string {
  return `${columns.map((c) => csvQuote(c.name, opts.delimiter)).join(opts.delimiter)}\n`;
}

export function csvRowLine(row: Value[], opts: CsvOptions): string {
  return `${row.map((v) => csvQuote(csvCell(v, opts.nullAs), opts.delimiter)).join(opts.delimiter)}\n`;
}

const SAFE_INT = /^-?\d+$/;

function safeInteger(s: string): number | null {
  if (!SAFE_INT.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** What a cell becomes in JSON. Lossless where JSON allows it, strings where it does not. */
export function jsonValue(v: Value): unknown {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v;
    case 'int': {
      const n = safeInteger(v.v);
      return n === null ? v.v : n;
    }
    case 'decimal':
      return v.v;
    case 'float':
      return v.v;
    case 'json':
      try {
        return JSON.parse(v.v) as unknown;
      } catch {
        return v.v;
      }
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'enum':
      return v.v;
    case 'set':
      return v.v.join(',');
    case 'bit':
      return bitsToBinary(v.v, v.bits);
    case 'bytes':
    case 'geometry':
    case 'unknown':
      return { $bytes: bytesToBase64(v.v) };
  }
}

export function jsonRow(columns: ColumnMeta[], row: Value[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    // Duplicate column names keep their position with a numeric suffix rather than overwrite.
    let key = c.name;
    let n = 2;
    while (key in out) key = `${c.name}_${n++}`;
    out[key] = jsonValue(row[i] ?? { t: 'null' });
  });
  return out;
}

export function sqlHeader(sql: string, now: Date, rowsHint?: number): string {
  const lines = [
    `-- RaSQL export, ${now.toISOString()}`,
    ...sql
      .trim()
      .split('\n')
      .map((l) => `-- ${l}`),
  ];
  if (rowsHint !== undefined) lines.push(`-- ${rowsHint} rows`);
  return `${lines.join('\n')}\n\n`;
}
