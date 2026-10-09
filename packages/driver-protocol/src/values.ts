/**
 * The typed cell model. A cell is one of these from the moment a driver reads it
 * until a renderer draws it. Nothing in this package turns a Value into a string.
 */
export type Value =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  /** Integer of any width. String on the wire so 64-bit values survive. */
  | { t: 'int'; v: string }
  /** Exact decimal, as the engine printed it. */
  | { t: 'decimal'; v: string }
  | { t: 'float'; v: number }
  | { t: 'text'; v: string; charset?: string }
  /** Binary data, or text the driver could not decode in its declared charset. */
  | { t: 'bytes'; v: Uint8Array; charsetHint?: string }
  /** ISO 8601 calendar date, YYYY-MM-DD. Zero dates such as 0000-00-00 are passed through. */
  | { t: 'date'; v: string }
  /** HH:MM:SS[.ffffff]. May be negative or exceed 24 hours; MySQL TIME is a duration. */
  | { t: 'time'; v: string }
  /** ISO 8601 date and time, fractional seconds preserved, no conversion applied. */
  | { t: 'datetime'; v: string; zone?: string }
  /** Raw JSON text. Parsed lazily by the renderer. */
  | { t: 'json'; v: string }
  | { t: 'bit'; v: Uint8Array; bits: number }
  | { t: 'enum'; v: string }
  | { t: 'set'; v: string[] }
  | { t: 'geometry'; v: Uint8Array; srid?: number }
  /** The driver did not recognise the type. Raw bytes plus the engine's type name. */
  | { t: 'unknown'; v: Uint8Array; nativeType: string };

export type ValueType = Value['t'];

export const VALUE_TYPES: readonly ValueType[] = [
  'null',
  'bool',
  'int',
  'decimal',
  'float',
  'text',
  'bytes',
  'date',
  'time',
  'datetime',
  'json',
  'bit',
  'enum',
  'set',
  'geometry',
  'unknown',
];

export function isValueType(t: unknown): t is ValueType {
  return typeof t === 'string' && (VALUE_TYPES as readonly string[]).includes(t);
}

const NULL_VALUE: Value = Object.freeze({ t: 'null' }) as Value;

/** Constructors. Prefer these over object literals so the shape stays consistent. */
export const V = {
  null: (): Value => NULL_VALUE,
  bool: (v: boolean): Value => ({ t: 'bool', v }),
  int: (v: bigint | number | string): Value => {
    if (typeof v === 'number' && !Number.isInteger(v)) {
      throw new TypeError(`V.int received a non-integer number: ${v}`);
    }
    return { t: 'int', v: typeof v === 'string' ? v : v.toString() };
  },
  decimal: (v: string): Value => ({ t: 'decimal', v }),
  float: (v: number): Value => ({ t: 'float', v }),
  text: (v: string, charset?: string): Value =>
    charset === undefined ? { t: 'text', v } : { t: 'text', v, charset },
  bytes: (v: Uint8Array, charsetHint?: string): Value =>
    charsetHint === undefined ? { t: 'bytes', v } : { t: 'bytes', v, charsetHint },
  date: (v: string): Value => ({ t: 'date', v }),
  time: (v: string): Value => ({ t: 'time', v }),
  datetime: (v: string, zone?: string): Value =>
    zone === undefined ? { t: 'datetime', v } : { t: 'datetime', v, zone },
  json: (v: string): Value => ({ t: 'json', v }),
  bit: (v: Uint8Array, bits: number): Value => ({ t: 'bit', v, bits }),
  enum: (v: string): Value => ({ t: 'enum', v }),
  set: (v: string[]): Value => ({ t: 'set', v }),
  geometry: (v: Uint8Array, srid?: number): Value =>
    srid === undefined ? { t: 'geometry', v } : { t: 'geometry', v, srid },
  unknown: (v: Uint8Array, nativeType: string): Value => ({ t: 'unknown', v, nativeType }),
} as const;

export function isNull(v: Value): v is { t: 'null' } {
  return v.t === 'null';
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Structural equality. Two values are equal when a database would consider them the same cell. */
export function valueEquals(a: Value, b: Value): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'null':
      return true;
    case 'bytes':
    case 'geometry':
    case 'unknown':
      return bytesEqual(a.v, (b as typeof a).v);
    case 'bit':
      return a.bits === (b as typeof a).bits && bytesEqual(a.v, (b as typeof a).v);
    case 'set': {
      const bv = (b as typeof a).v;
      return a.v.length === bv.length && a.v.every((x, i) => x === bv[i]);
    }
    default:
      return a.v === (b as typeof a).v;
  }
}

/**
 * Decode bytes as text in a charset, or return undefined when the bytes are not valid in it.
 * Drivers use this to decide between `text` and `bytes` with a hint. Only charsets the
 * platform TextDecoder knows are supported; anything else returns undefined.
 */
export function tryDecodeText(bytes: Uint8Array, charset: string): string | undefined {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
