/**
 * What is in a blob? Magic numbers for binary formats, then text heuristics. Pure and
 * renderer-safe. Detection is a hint for the inspector, never a verdict about the data.
 */
import { fromBase64 } from './bytes';

export type DetectionKind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'svg'
  | 'pdf'
  | 'gzip'
  | 'zip'
  | 'php-serialized'
  | 'json'
  | 'utf8-text'
  | 'utf16le-text'
  | 'empty'
  | 'binary';

export interface Detection {
  kind: DetectionKind;
  mime: string;
  extension: string;
  label: string;
  isImage: boolean;
  isText: boolean;
}

const KINDS: Record<DetectionKind, Omit<Detection, 'kind'>> = {
  png: { mime: 'image/png', extension: 'png', label: 'PNG image', isImage: true, isText: false },
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG image', isImage: true, isText: false },
  gif: { mime: 'image/gif', extension: 'gif', label: 'GIF image', isImage: true, isText: false },
  webp: {
    mime: 'image/webp',
    extension: 'webp',
    label: 'WebP image',
    isImage: true,
    isText: false,
  },
  bmp: { mime: 'image/bmp', extension: 'bmp', label: 'BMP image', isImage: true, isText: false },
  svg: { mime: 'image/svg+xml', extension: 'svg', label: 'SVG image', isImage: true, isText: true },
  pdf: {
    mime: 'application/pdf',
    extension: 'pdf',
    label: 'PDF document',
    isImage: false,
    isText: false,
  },
  gzip: {
    mime: 'application/gzip',
    extension: 'gz',
    label: 'gzip compressed data',
    isImage: false,
    isText: false,
  },
  zip: {
    mime: 'application/zip',
    extension: 'zip',
    label: 'zip archive',
    isImage: false,
    isText: false,
  },
  'php-serialized': {
    mime: 'text/plain',
    extension: 'txt',
    label: 'PHP serialized data',
    isImage: false,
    isText: true,
  },
  json: {
    mime: 'application/json',
    extension: 'json',
    label: 'JSON',
    isImage: false,
    isText: true,
  },
  'utf8-text': {
    mime: 'text/plain',
    extension: 'txt',
    label: 'UTF-8 text',
    isImage: false,
    isText: true,
  },
  'utf16le-text': {
    mime: 'text/plain',
    extension: 'txt',
    label: 'UTF-16 LE text',
    isImage: false,
    isText: true,
  },
  empty: {
    mime: 'application/octet-stream',
    extension: 'bin',
    label: 'empty',
    isImage: false,
    isText: false,
  },
  binary: {
    mime: 'application/octet-stream',
    extension: 'bin',
    label: 'binary data',
    isImage: false,
    isText: false,
  },
};

const make = (kind: DetectionKind): Detection => ({ kind, ...KINDS[kind] });

const startsWith = (b: Uint8Array, sig: number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

const ascii = (b: Uint8Array, start: number, end: number): string => {
  let s = '';
  for (let i = start; i < Math.min(end, b.length); i++) s += String.fromCharCode(b[i] as number);
  return s;
};

function decodeUtf8Strict(b: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

/** A structural look at PHP's serialize() output: a typed token at the start, matching ending. */
export function looksPhpSerialized(text: string): boolean {
  const t = text.trim();
  if (t === 'N;' || /^b:[01];$/.test(t) || /^i:-?\d+;$/.test(t) || /^d:-?[\d.Ee+-]+;$/.test(t))
    return true;
  if (/^s:\d+:"[\s\S]*";$/.test(t)) return true;
  if (/^a:\d+:\{[\s\S]*\}$/.test(t)) return true;
  if (/^O:\d+:"[^"]+":\d+:\{[\s\S]*\}$/.test(t)) return true;
  return false;
}

function looksUtf16Le(b: Uint8Array): boolean {
  if (startsWith(b, [0xff, 0xfe])) return true;
  if (b.length < 8) return false;
  const n = Math.min(64, b.length - (b.length % 2));
  let evenNonZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if ((b[i] as number) !== 0) evenNonZero++;
    if ((b[i + 1] as number) === 0) oddZero++;
  }
  const pairs = n / 2;
  return pairs >= 4 && oddZero / pairs > 0.9 && evenNonZero / pairs > 0.9;
}

export function detectBytes(bytes: Uint8Array): Detection {
  if (bytes.length === 0) return make('empty');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return make('png');
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return make('jpeg');
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return make('gif');
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return make('webp');
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length >= 14) return make('bmp');
  if (ascii(bytes, 0, 5) === '%PDF-') return make('pdf');
  if (startsWith(bytes, [0x1f, 0x8b])) return make('gzip');
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return make('zip');
  if (looksUtf16Le(bytes)) return make('utf16le-text');

  const text = decodeUtf8Strict(bytes);
  if (text === null) return make('binary');
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (/^<svg[\s>]/i.test(trimmed) || (/^<\?xml/i.test(trimmed) && /<svg[\s>]/i.test(trimmed)))
    return make('svg');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return make('json');
    } catch {
      /* not JSON */
    }
  }
  if (looksPhpSerialized(trimmed)) return make('php-serialized');
  return make('utf8-text');
}

const DATA_URL = /^data:([^;,]+)?(;[^,]*)?;base64,([\s\S]*)$/i;

/**
 * Is this text really base64-encoded bytes? Strict alphabet and padding, a minimum length, and
 * the decoded bytes must not just be the same text again (short words decode to garbage that
 * happens to be valid base64 of nothing interesting).
 */
export function detectBase64(text: string): { bytes: Uint8Array; detection: Detection } | null {
  let payload = text.trim();
  const data = DATA_URL.exec(payload);
  if (data) payload = data[3] as string;
  const clean = payload.replace(/\s+/g, '');
  // A bare string needs some length before it counts; a data URL has declared itself.
  if ((!data && clean.length < 16) || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(clean);
  } catch {
    return null;
  }
  const detection = detectBytes(bytes);
  if (detection.kind === 'empty' || detection.kind === 'binary') {
    // Random-looking bytes are not evidence of base64; a word like "testtesttesttest" decodes too.
    return data ? { bytes, detection } : null;
  }
  if (detection.kind === 'utf8-text') {
    const decoded = new TextDecoder().decode(bytes);
    if (decoded === clean) return null;
    // Decoded text must be mostly printable to count.
    const printable = decoded.replace(/[^\x20-\x7e\s\u00a0-\uffff]/g, '').length;
    if (printable / Math.max(1, decoded.length) < 0.95) return null;
  }
  return { bytes, detection };
}
