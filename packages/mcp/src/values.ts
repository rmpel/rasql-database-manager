import type { ColumnMeta, Value } from '@rasql/driver-protocol';

/** Bytes longer than this are summarized instead of returned whole. */
const MAX_INLINE_BYTES = 4096;

function hex(bytes: Uint8Array, limit = MAX_INLINE_BYTES): string {
  let s = '';
  const n = Math.min(bytes.byteLength, limit);
  for (let i = 0; i < n; i++) s += (bytes[i] as number).toString(16).padStart(2, '0');
  return s;
}

function bytesValue(
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    $type: 'bytes',
    length: bytes.byteLength,
    hex: hex(bytes),
    ...extra,
  };
  if (bytes.byteLength > MAX_INLINE_BYTES) out['truncated'] = true;
  return out;
}

/**
 * A typed cell as JSON, the way the data grid shows it (MCP.md section 4): NULL is null,
 * integers that do not fit a double stay strings, decimals stay exact strings, and binary
 * data is marked as bytes with its length rather than passed off as text.
 */
export function valueToJson(v: Value): unknown {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v;
    case 'int': {
      const n = Number(v.v);
      return Number.isSafeInteger(n) ? n : v.v;
    }
    case 'float':
      return Number.isFinite(v.v) ? v.v : String(v.v);
    case 'decimal':
    case 'text':
    case 'date':
    case 'time':
    case 'enum':
      return v.v;
    case 'datetime':
      return v.zone ? `${v.v}${v.zone}` : v.v;
    case 'json':
      return { $type: 'json', text: v.v };
    case 'set':
      return v.v;
    case 'bytes':
      return bytesValue(v.v, v.charsetHint ? { charsetHint: v.charsetHint } : {});
    case 'bit': {
      let bits = '';
      for (const b of v.v) bits += b.toString(2).padStart(8, '0');
      return { $type: 'bit', bits: bits.slice(-v.bits) };
    }
    case 'geometry':
      return bytesValue(v.v, {
        $type: 'geometry',
        ...(v.srid !== undefined ? { srid: v.srid } : {}),
      });
    case 'unknown':
      return bytesValue(v.v, { $type: 'unknown', nativeType: v.nativeType });
  }
}

export interface JsonResult {
  columns: { name: string; type: string; nullable: boolean }[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export function resultToJson(
  columns: ColumnMeta[],
  rows: Value[][],
  truncated: boolean,
): JsonResult {
  return {
    columns: columns.map((c) => ({ name: c.name, type: c.nativeType, nullable: c.nullable })),
    rows: rows.map((r) => r.map(valueToJson)),
    rowCount: rows.length,
    truncated,
  };
}
