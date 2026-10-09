import { V, type Value, type ValueType } from '@rasql/driver-protocol';

/** SQLite type affinity rules, extended with the declared names web developers actually use. */
export function declaredTypeToValueType(declared: string | null | undefined): ValueType {
  if (!declared) return 'unknown';
  const t = declared.toUpperCase();
  if (t.includes('BOOL')) return 'bool';
  if (t.includes('INT')) return 'int';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (t.includes('BLOB')) return 'bytes';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'float';
  if (t.includes('JSON')) return 'json';
  if (t.includes('TIMESTAMP') || t.includes('DATETIME')) return 'datetime';
  if (t.includes('DATE')) return 'date';
  if (t.includes('TIME')) return 'time';
  if (t.includes('NUMERIC') || t.includes('DECIMAL')) return 'decimal';
  return 'text';
}

/**
 * Convert what node:sqlite hands us into a typed Value. Integers arrive as bigint because
 * statements run with setReadBigInts(true); numbers are therefore always REAL.
 */
export function toValue(raw: unknown, declared: string | null | undefined): Value {
  if (raw === null || raw === undefined) return V.null();
  const hint = declaredTypeToValueType(declared);
  switch (typeof raw) {
    case 'bigint':
      return hint === 'bool' ? V.bool(raw !== 0n) : V.int(raw);
    case 'number':
      if (Number.isInteger(raw)) return hint === 'bool' ? V.bool(raw !== 0) : V.int(raw);
      return V.float(raw);
    case 'string':
      switch (hint) {
        case 'date':
          return V.date(raw);
        case 'time':
          return V.time(raw);
        case 'datetime':
          return V.datetime(raw);
        case 'json':
          return V.json(raw);
        case 'decimal':
          return V.decimal(raw);
        default:
          return V.text(raw);
      }
    case 'boolean':
      return V.bool(raw);
    default:
      if (raw instanceof Uint8Array) return V.bytes(raw);
      return V.text(String(raw));
  }
}

/** Convert a Value into something node:sqlite accepts as a bound parameter. */
export function toParam(v: Value): null | number | bigint | string | Uint8Array {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v ? 1 : 0;
    case 'int':
      return BigInt(v.v);
    case 'decimal':
      return Number(v.v);
    case 'float':
      return v.v;
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'json':
    case 'enum':
      return v.v;
    case 'set':
      return v.v.join(',');
    case 'bytes':
    case 'bit':
    case 'geometry':
    case 'unknown':
      return v.v;
  }
}
