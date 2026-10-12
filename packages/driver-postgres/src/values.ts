import { V, type Value, type ValueType } from '@rasql/driver-protocol';

/** One row of pg_type, as much as the driver needs to type a cell. */
export interface PgType {
  oid: number;
  name: string;
  /** typtype: b base, c composite, d domain, e enum, p pseudo, r range, m multirange. */
  type: string;
  /** typcategory: A array, B boolean, D date/time, N numeric, S string, U user, V bit string, ... */
  category: string;
  /** For a domain, the type it is based on. */
  base: number;
}

/** Built-in types by oid; these never change, so the driver can type cells before pg_type loads. */
export const BUILTIN: Record<number, { name: string; valueType: ValueType }> = {
  16: { name: 'bool', valueType: 'bool' },
  17: { name: 'bytea', valueType: 'bytes' },
  18: { name: 'char', valueType: 'text' },
  19: { name: 'name', valueType: 'text' },
  20: { name: 'int8', valueType: 'int' },
  21: { name: 'int2', valueType: 'int' },
  23: { name: 'int4', valueType: 'int' },
  25: { name: 'text', valueType: 'text' },
  26: { name: 'oid', valueType: 'int' },
  114: { name: 'json', valueType: 'json' },
  142: { name: 'xml', valueType: 'text' },
  700: { name: 'float4', valueType: 'float' },
  701: { name: 'float8', valueType: 'float' },
  790: { name: 'money', valueType: 'text' },
  1042: { name: 'bpchar', valueType: 'text' },
  1043: { name: 'varchar', valueType: 'text' },
  1082: { name: 'date', valueType: 'date' },
  1083: { name: 'time', valueType: 'time' },
  1114: { name: 'timestamp', valueType: 'datetime' },
  1184: { name: 'timestamptz', valueType: 'datetime' },
  1186: { name: 'interval', valueType: 'text' },
  1266: { name: 'timetz', valueType: 'time' },
  1560: { name: 'bit', valueType: 'bit' },
  1562: { name: 'varbit', valueType: 'bit' },
  1700: { name: 'numeric', valueType: 'decimal' },
  2950: { name: 'uuid', valueType: 'text' },
  3802: { name: 'jsonb', valueType: 'json' },
};

/** The protocol type for a column type, following domains to their base type. */
export function valueTypeOf(oid: number, types: ReadonlyMap<number, PgType>): ValueType {
  for (let depth = 0; depth < 8; depth++) {
    const builtin = BUILTIN[oid];
    if (builtin) return builtin.valueType;
    const t = types.get(oid);
    if (!t) return 'text';
    if (t.type === 'd' && t.base) {
      oid = t.base;
      continue;
    }
    if (t.type === 'e') return 'enum';
    // Arrays, ranges, composites, network and geometric types read best as the text PostgreSQL prints.
    return 'text';
  }
  return 'text';
}

export function typeNameOf(oid: number, types: ReadonlyMap<number, PgType>): string {
  return types.get(oid)?.name ?? BUILTIN[oid]?.name ?? `oid ${oid}`;
}

/** bytea in hex output format: \x followed by two hex digits per byte. */
export function parseBytea(raw: string): Uint8Array {
  if (!raw.startsWith('\\x')) return new TextEncoder().encode(raw);
  return Uint8Array.from(Buffer.from(raw.slice(2), 'hex'));
}

/** A bit string such as 0101 as bytes, right-aligned like MySQL BIT, with its length. */
export function parseBits(raw: string): Value {
  const bits = raw.length;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  const padded = raw.padStart(bytes.length * 8, '0');
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return V.bit(bytes, bits);
}

export function bitsToString(v: Extract<Value, { t: 'bit' }>): string {
  return [...v.v]
    .map((b) => b.toString(2).padStart(8, '0'))
    .join('')
    .slice(-v.bits);
}

/**
 * One cell, from the text PostgreSQL sent. The connection runs with every type parser
 * replaced by the identity, so nothing was converted on the way: 64-bit integers, numerics
 * and microsecond timestamps arrive exactly as the server printed them.
 */
export function toValue(raw: string | null | undefined, valueType: ValueType): Value {
  if (raw === null || raw === undefined) return V.null();
  switch (valueType) {
    case 'bool':
      return V.bool(raw === 't' || raw === 'true');
    case 'int':
      return V.int(raw);
    case 'decimal':
      return V.decimal(raw);
    case 'float':
      return V.float(Number(raw));
    case 'bytes':
      return V.bytes(parseBytea(raw));
    case 'date':
      return V.date(raw);
    case 'time':
      return V.time(raw);
    case 'datetime':
      return V.datetime(raw);
    case 'json':
      return V.json(raw);
    case 'bit':
      return parseBits(raw);
    case 'enum':
      return V.enum(raw);
    default:
      return V.text(raw);
  }
}

/** A Value as a bound parameter for pg. */
export function toParam(v: Value): null | boolean | number | string | Buffer {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v;
    case 'float':
      return v.v;
    case 'int':
    case 'decimal':
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
      return bitsToString(v);
    case 'bytes':
    case 'geometry':
    case 'unknown':
      return Buffer.from(v.v);
  }
}
