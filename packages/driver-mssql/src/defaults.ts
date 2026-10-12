import { V, type ColumnDefault, type ValueType } from '@rasql/driver-protocol';

/**
 * A default as sys.default_constraints stores it, read back into a value where it is one:
 * ((0)), ((-1.5)), (N'text'), ('2024-01-01'), (NULL). Anything else (getdate(), newid(),
 * sysutcdatetime()) stays an expression, without the outer parentheses SQL Server adds.
 */
export function parseDefault(definition: string, valueType: ValueType): ColumnDefault {
  let text = definition.trim();
  while (/^\(([\s\S]*)\)$/.test(text) && balanced(text.slice(1, -1)))
    text = text.slice(1, -1).trim();
  if (/^NULL$/i.test(text)) return V.null();
  let literal: string | null = null;
  const quoted = /^N?'((?:[^']|'')*)'$/.exec(text);
  if (quoted) literal = (quoted[1] as string).replace(/''/g, "'");
  else if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text)) literal = text;
  if (literal === null) return { t: 'expression', sql: text };
  switch (valueType) {
    case 'int':
      return /^-?\d+$/.test(literal) ? V.int(literal) : { t: 'expression', sql: text };
    case 'decimal':
      return V.decimal(literal);
    case 'float':
      return V.float(Number(literal));
    case 'bool':
      return V.bool(literal !== '0');
    case 'date':
      return V.date(literal);
    case 'time':
      return V.time(literal);
    case 'datetime':
      return V.datetime(literal);
    case 'json':
      return V.json(literal);
    case 'bytes':
    case 'geometry':
      return { t: 'expression', sql: text };
    default:
      return V.text(literal);
  }
}

/** True when every parenthesis in the text closes, so stripping an outer pair is safe. */
function balanced(s: string): boolean {
  let depth = 0;
  let quote = false;
  for (const c of s) {
    if (c === "'") quote = !quote;
    if (quote) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
