import { V, type ColumnDefault, type ValueType } from '@rasql/driver-protocol';
import { parseBits } from './values.js';

/**
 * A column default as pg_get_expr prints it, read back into a value where it is one:
 * 'text'::character varying, '2024-01-01'::date, 42, '-1'::integer, true, NULL::text.
 * Anything else (now(), nextval('…'::regclass), gen_random_uuid()) stays an expression.
 */
export function parseDefault(sql: string, valueType: ValueType): ColumnDefault {
  const text = sql.trim();
  if (/^NULL(::[\w\s."[\]()]+)?$/i.test(text)) return V.null();
  let literal: string | null = null;
  const quoted = /^'((?:[^']|'')*)'(?:::[\w\s."[\]()]+)?$/.exec(text);
  if (quoted) literal = (quoted[1] as string).replace(/''/g, "'");
  else if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text)) literal = text;
  else if (/^(true|false)$/i.test(text)) literal = text.toLowerCase();
  else if (/^B'[01]*'(::[\w\s()]+)?$/i.test(text)) literal = /'([01]*)'/.exec(text)?.[1] ?? '';
  if (literal === null) return { t: 'expression', sql: text };
  switch (valueType) {
    case 'int':
      return /^-?\d+$/.test(literal) ? V.int(literal) : { t: 'expression', sql: text };
    case 'decimal':
      return V.decimal(literal);
    case 'float':
      return Number.isFinite(Number(literal))
        ? V.float(Number(literal))
        : { t: 'expression', sql: text };
    case 'bool':
      return /^(t|true|1|yes|on)$/i.test(literal) ? V.bool(true) : V.bool(false);
    case 'date':
      return V.date(literal);
    case 'time':
      return V.time(literal);
    case 'datetime':
      return V.datetime(literal);
    case 'json':
      return V.json(literal);
    case 'enum':
      return V.enum(literal);
    case 'bit':
      return parseBits(literal);
    case 'bytes':
      return { t: 'expression', sql: text };
    default:
      return V.text(literal);
  }
}
