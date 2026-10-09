import { V, type ColumnMeta, type Value } from '@rasql/driver-protocol';

/** Types a user can retype in a text box. Binary-ish types need their own editor and stay read-only. */
export function isEditableType(meta: ColumnMeta): boolean {
  return !['bytes', 'bit', 'geometry'].includes(meta.valueType);
}

/** The text an editor starts with. Null is represented separately by the editor. */
export function valueToEditText(v: Value): string {
  switch (v.t) {
    case 'null':
      return '';
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'float':
      return String(v.v);
    case 'set':
      return v.v.join(',');
    case 'bytes':
    case 'geometry':
    case 'unknown':
    case 'bit':
      return '';
    default:
      return v.v;
  }
}

/** Parse what the user typed into a typed Value for the column, or return a message. */
export function parseEditText(
  text: string,
  meta: ColumnMeta,
): { value: Value } | { error: string } {
  const t = text;
  switch (meta.valueType) {
    case 'int':
      return /^[+-]?\d+$/.test(t.trim())
        ? { value: V.int(t.trim().replace(/^\+/, '')) }
        : { error: 'Expected an integer' };
    case 'decimal':
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t.trim())
        ? { value: V.decimal(t.trim().replace(/^\+/, '')) }
        : { error: 'Expected a decimal number' };
    case 'float': {
      const n = Number(t.trim());
      return t.trim() !== '' && Number.isFinite(n)
        ? { value: V.float(n) }
        : { error: 'Expected a number' };
    }
    case 'bool': {
      const s = t.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', 't', 'y'].includes(s)) return { value: V.bool(true) };
      if (['0', 'false', 'no', 'off', 'f', 'n'].includes(s)) return { value: V.bool(false) };
      return { error: 'Expected true or false' };
    }
    case 'date':
      return { value: V.date(t) };
    case 'time':
      return { value: V.time(t) };
    case 'datetime':
      return { value: V.datetime(t) };
    case 'json':
      return { value: V.json(t) };
    case 'enum':
      return { value: V.enum(t) };
    case 'set':
      return { value: V.set(t === '' ? [] : t.split(',').map((s) => s.trim())) };
    case 'bytes':
    case 'bit':
    case 'geometry':
      return { error: `${meta.valueType} cells cannot be edited as text yet` };
    default:
      return { value: V.text(t) };
  }
}
