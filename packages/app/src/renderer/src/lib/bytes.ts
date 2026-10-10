/**
 * Byte helpers for the cell inspector. Renderer-safe: no Node Buffer, only web APIs, and the
 * base64 paths work in chunks so a 10 MB blob does not blow the call stack.
 */

export function toHex(bytes: Uint8Array, opts: { groupEvery?: number } = {}): string {
  const group = opts.groupEvery ?? 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (group > 0 && i > 0 && i % group === 0) out += ' ';
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

/** Parses hex text; tolerates whitespace, newlines and a 0x prefix. Throws on odd length or bad characters. */
export function fromHex(text: string): Uint8Array {
  let clean = text.replace(/\s+/g, '');
  if (clean.startsWith('0x') || clean.startsWith('0X')) clean = clean.slice(2);
  if (clean.length % 2 !== 0) throw new Error('Hex text has an odd number of digits');
  if (!/^[0-9a-fA-F]*$/.test(clean))
    throw new Error('Hex text contains characters other than 0-9 and a-f');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/** Decodes base64; tolerates whitespace and missing padding. Throws on invalid input. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('Not valid base64');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface HexDumpLine {
  offset: string;
  hex: string;
  ascii: string;
}

export interface HexDump {
  lines: HexDumpLine[];
  truncated: boolean;
  total: number;
}

export function hexDumpLines(
  bytes: Uint8Array,
  opts: { bytesPerLine?: number; maxBytes?: number } = {},
): HexDump {
  const perLine = opts.bytesPerLine ?? 16;
  const max = opts.maxBytes ?? 65536;
  const shown = bytes.length > max ? bytes.subarray(0, max) : bytes;
  const lines: HexDumpLine[] = [];
  const offsetWidth = Math.max(8, shown.length.toString(16).length);
  for (let start = 0; start < shown.length; start += perLine) {
    const chunk = shown.subarray(start, start + perLine);
    let hex = '';
    let ascii = '';
    for (let i = 0; i < perLine; i++) {
      if (i < chunk.length) {
        const b = chunk[i] as number;
        hex += b.toString(16).padStart(2, '0');
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        hex += '  ';
      }
      if (i < perLine - 1) hex += i % 8 === 7 ? '  ' : ' ';
    }
    lines.push({ offset: start.toString(16).padStart(offsetWidth, '0'), hex, ascii });
  }
  return { lines, truncated: bytes.length > max, total: bytes.length };
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
