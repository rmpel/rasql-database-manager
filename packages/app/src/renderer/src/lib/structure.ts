/**
 * The structure editor's model. A column type is edited as parts (kind, type, length, unsigned,
 * values) instead of a string, and the drafts are compared with the table definition to produce
 * the protocol's StructureChange list. Pure, so it is unit-tested without the UI.
 */
import {
  V,
  type AlterCapabilities,
  type ColumnDefinition,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type StructureChange,
  type TableDefinition,
  type TypeCategory,
  type TypeDescriptor,
  type Value,
} from '@rasql/driver-protocol';

export interface TypeParts {
  /** Upper case type name, e.g. INT, VARCHAR; matches a TypeDescriptor when known. */
  base: string;
  length: string;
  precision: string;
  scale: string;
  unsigned: boolean;
  zerofill: boolean;
  values: string[];
}

export interface TypeKind {
  id: string;
  label: string;
  categories: TypeCategory[];
}

/** How types are grouped in the first dropdown, in plain words. */
export const TYPE_KINDS: TypeKind[] = [
  { id: 'integer', label: 'Whole number', categories: ['integer'] },
  { id: 'decimal', label: 'Exact decimal', categories: ['decimal'] },
  { id: 'float', label: 'Approximate number', categories: ['float'] },
  { id: 'text', label: 'Text', categories: ['text'] },
  { id: 'datetime', label: 'Date and time', categories: ['date', 'time', 'datetime'] },
  { id: 'choice', label: 'Choice from a list', categories: ['enum', 'set'] },
  { id: 'boolean', label: 'Yes or no', categories: ['boolean'] },
  { id: 'json', label: 'JSON', categories: ['json'] },
  { id: 'binary', label: 'Binary data', categories: ['binary'] },
  { id: 'bit', label: 'Bits', categories: ['bit'] },
  { id: 'spatial', label: 'Location or shape', categories: ['spatial'] },
];

/** The type picked when the kind changes, with sensible sizes. */
const KIND_DEFAULTS: Record<string, Partial<TypeParts> & { base: string }> = {
  integer: { base: 'INT' },
  decimal: { base: 'DECIMAL', precision: '10', scale: '2' },
  float: { base: 'DOUBLE' },
  text: { base: 'VARCHAR', length: '255' },
  datetime: { base: 'DATETIME' },
  choice: { base: 'ENUM', values: ['a', 'b'] },
  boolean: { base: 'BOOLEAN' },
  json: { base: 'JSON' },
  binary: { base: 'BLOB' },
  bit: { base: 'BIT', length: '1' },
  spatial: { base: 'POINT' },
};

export const emptyParts = (base: string): TypeParts => ({
  base,
  length: '',
  precision: '',
  scale: '',
  unsigned: false,
  zerofill: false,
  values: [],
});

export function descriptorFor(types: TypeDescriptor[], base: string): TypeDescriptor | undefined {
  return types.find((t) => t.name === base.toUpperCase());
}

export function kindOf(types: TypeDescriptor[], base: string): TypeKind | undefined {
  const d = descriptorFor(types, base);
  return d ? TYPE_KINDS.find((k) => k.categories.includes(d.category)) : undefined;
}

/** Type names to show first for each kind, when the driver has them. */
const NAMED_FIRST: Record<string, string[]> = {
  integer: ['INT', 'BIGINT', 'TINYINT', 'INTEGER'],
  decimal: ['DECIMAL', 'NUMERIC'],
  float: ['FLOAT', 'DOUBLE', 'REAL'],
  text: ['VARCHAR', 'CHAR', 'TEXT'],
  datetime: ['DATETIME', 'DATE', 'TIMESTAMP', 'TIME'],
  choice: ['ENUM', 'SET'],
  binary: ['BLOB', 'VARBINARY', 'BINARY'],
  spatial: ['GEOMETRY', 'POINT'],
};

/**
 * The kind as shown in the dropdown: plain words plus the engine's own type names, so
 * "Approximate number (FLOAT, DOUBLE)" is recognisable to anyone who knows the SQL names.
 */
export function kindLabel(kind: TypeKind, types: TypeDescriptor[]): string {
  const names = typesOfKind(types, kind.id).map((t) => t.name);
  const preferred = (NAMED_FIRST[kind.id] ?? []).filter((n) => names.includes(n));
  const ordered = [...preferred, ...names.filter((n) => !preferred.includes(n))];
  const shown = ordered.slice(0, 3);
  // A kind with one type named like the label needs no repetition: "JSON", not "JSON (JSON)".
  if (shown.length === 1 && shown[0]!.toLowerCase() === kind.label.toLowerCase()) return kind.label;
  return `${kind.label} (${shown.join(', ')}${ordered.length > 3 ? ', …' : ''})`;
}

/** The kinds this driver has types for. */
export function kindsFor(types: TypeDescriptor[]): TypeKind[] {
  return TYPE_KINDS.filter((k) => types.some((t) => k.categories.includes(t.category)));
}

export function typesOfKind(types: TypeDescriptor[], kindId: string): TypeDescriptor[] {
  const kind = TYPE_KINDS.find((k) => k.id === kindId);
  return kind ? types.filter((t) => kind.categories.includes(t.category)) : [];
}

/** Parts for a fresh column of a kind, using the driver's types. */
export function partsForKind(types: TypeDescriptor[], kindId: string): TypeParts {
  const preset = KIND_DEFAULTS[kindId];
  const available = typesOfKind(types, kindId);
  const base =
    preset && available.some((t) => t.name === preset.base) ? preset.base : available[0]?.name;
  if (!base) return emptyParts('TEXT');
  return { ...emptyParts(base), ...(preset && preset.base === base ? preset : {}), base };
}

/** Values of enum('a','b''c') or set(...), unescaped. */
function parseValues(args: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^'\\]|''|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null)
    out.push((m[1] as string).replace(/''/g, "'").replace(/\\(.)/g, '$1'));
  return out;
}

/** Split a native type such as "decimal(10,2) unsigned zerofill" into parts. */
export function parseNativeType(native: string, types: TypeDescriptor[]): TypeParts {
  const m =
    /^\s*([a-z][a-z0-9_ ]*?)\s*(?:\(([\s\S]*)\))?\s*((?:unsigned|signed|zerofill|\s)*)$/i.exec(
      native,
    );
  if (!m) return emptyParts(native.trim().toUpperCase());
  const base = (m[1] as string).trim().toUpperCase();
  const args = m[2] ?? '';
  const tail = (m[3] ?? '').toLowerCase();
  const parts = emptyParts(base);
  parts.unsigned = /\bunsigned\b/.test(tail);
  parts.zerofill = /\bzerofill\b/.test(tail);
  const d = descriptorFor(types, base);
  if (!args) return parts;
  if (d?.hasValues || /^(enum|set)$/i.test(base)) parts.values = parseValues(args);
  else if (d?.hasScale) {
    const [p, s] = args.split(',').map((x) => x.trim());
    parts.precision = p ?? '';
    parts.scale = s ?? '';
  } else if (d?.hasPrecision && !d.hasLength) parts.precision = args.trim();
  else parts.length = args.trim();
  return parts;
}

const quoteValue = (v: string): string => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/** Back to the native type string, in upper case as people write SQL. */
export function buildNativeType(parts: TypeParts, types: TypeDescriptor[]): string {
  const d = descriptorFor(types, parts.base);
  let sql = parts.base.toUpperCase();
  if (d?.hasValues) sql += `(${parts.values.map(quoteValue).join(',')})`;
  else if (d?.hasScale && parts.precision)
    sql += `(${parts.precision}${parts.scale ? `,${parts.scale}` : ''})`;
  else if (d?.hasPrecision && !d.hasLength && parts.precision) sql += `(${parts.precision})`;
  else if (parts.length) sql += `(${parts.length})`;
  if (parts.unsigned && d?.unsignedAllowed !== false) sql += ' UNSIGNED';
  if (parts.zerofill) sql += ' ZEROFILL';
  return sql;
}

/** Problems that would make the type invalid, in words. */
export function typeProblem(parts: TypeParts, types: TypeDescriptor[]): string | null {
  const d = descriptorFor(types, parts.base);
  const num = (s: string): boolean => s === '' || /^\d+$/.test(s);
  if (!num(parts.length) || !num(parts.precision) || !num(parts.scale))
    return 'Sizes are whole numbers';
  if (d?.hasValues && parts.values.length === 0) return 'List at least one value';
  if (parts.base === 'VARCHAR' && !parts.length) return 'VARCHAR needs a length';
  if (parts.base === 'VARBINARY' && !parts.length) return 'VARBINARY needs a length';
  return null;
}

export type DefaultMode = 'none' | 'null' | 'value' | 'expression';

export interface ColumnDraft {
  /** Stable React key. */
  key: string;
  /** The column as it is in the database; null for a new one. */
  original: ColumnDefinition | null;
  name: string;
  type: TypeParts;
  nullable: boolean;
  defaultMode: DefaultMode;
  defaultText: string;
  autoIncrement: boolean;
  /** ON UPDATE CURRENT_TIMESTAMP, for timestamps. */
  onUpdate: boolean;
  comment: string;
  dropped: boolean;
}

let keySeq = 0;
const nextKey = (): string => `k${++keySeq}`;

export function valueText(v: Value): string {
  switch (v.t) {
    case 'null':
      return '';
    case 'bool':
      return v.v ? '1' : '0';
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

/** A default as people read it: NULL, an empty string, a value, or an expression. */
export function formatDefault(d: ColumnDefinition['default']): string {
  if (d === undefined) return '';
  if (d.t === 'expression') return d.sql;
  if (d.t === 'null') return 'NULL';
  const text = valueText(d);
  return text === '' && (d.t === 'text' || d.t === 'enum' || d.t === 'set') ? "'' (empty)" : text;
}

export function draftFromColumn(c: ColumnDefinition, types: TypeDescriptor[]): ColumnDraft {
  const d = c.default;
  return {
    key: nextKey(),
    original: c,
    name: c.name,
    type: parseNativeType(c.nativeType, types),
    nullable: c.nullable,
    defaultMode:
      d === undefined
        ? 'none'
        : d.t === 'expression'
          ? 'expression'
          : d.t === 'null'
            ? 'null'
            : 'value',
    defaultText:
      d === undefined || d.t === 'null' ? '' : d.t === 'expression' ? d.sql : valueText(d),
    autoIncrement: c.autoIncrement,
    onUpdate: /on update current_timestamp/i.test(c.extra ?? ''),
    comment: c.comment ?? '',
    dropped: false,
  };
}

export function newColumnDraft(types: TypeDescriptor[], existing: string[]): ColumnDraft {
  let name = 'new_column';
  for (let i = 2; existing.includes(name); i++) name = `new_column_${i}`;
  return {
    key: nextKey(),
    original: null,
    name,
    type: partsForKind(types, 'text'),
    nullable: true,
    defaultMode: 'none',
    defaultText: '',
    autoIncrement: false,
    onUpdate: false,
    comment: '',
    dropped: false,
  };
}

function defaultValue(d: ColumnDraft, types: TypeDescriptor[]): ColumnDefinition['default'] {
  switch (d.defaultMode) {
    case 'none':
      return undefined;
    case 'null':
      return V.null();
    case 'expression':
      return { t: 'expression', sql: d.defaultText.trim() };
    case 'value': {
      const category = descriptorFor(types, d.type.base)?.category;
      const t = d.defaultText;
      if (category === 'integer' && /^-?\d+$/.test(t.trim())) return V.int(t.trim());
      if ((category === 'decimal' || category === 'float') && /^-?\d+(\.\d+)?$/.test(t.trim()))
        return V.decimal(t.trim());
      if (category === 'enum') return V.enum(t);
      return V.text(t);
    }
  }
}

const VALUE_TYPE: Partial<Record<TypeCategory, ColumnDefinition['valueType']>> = {
  integer: 'int',
  decimal: 'decimal',
  float: 'float',
  text: 'text',
  binary: 'bytes',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  json: 'json',
  enum: 'enum',
  set: 'set',
  boolean: 'bool',
  bit: 'bit',
  spatial: 'geometry',
};

/** The column a draft describes, keeping what the editor does not touch (collation, generation). */
export function columnFromDraft(
  d: ColumnDraft,
  types: TypeDescriptor[],
  ordinal: number,
): ColumnDefinition {
  const category = descriptorFor(types, d.type.base)?.category;
  const textual = category === 'text' || category === 'enum' || category === 'set';
  const col: ColumnDefinition = {
    name: d.name.trim(),
    ordinal,
    nativeType: buildNativeType(d.type, types),
    valueType: (category && VALUE_TYPE[category]) ?? d.original?.valueType ?? 'unknown',
    nullable: d.nullable,
    autoIncrement: d.autoIncrement,
  };
  const dflt = defaultValue(d, types);
  if (dflt !== undefined) col.default = dflt;
  if (d.comment) col.comment = d.comment;
  const o = d.original;
  if (o && textual && o.charset) col.charset = o.charset;
  if (o && textual && o.collation) col.collation = o.collation;
  if (o?.generated) col.generated = o.generated;
  // Keep other flags the engine reported; ON UPDATE follows the checkbox.
  const otherExtra = (o?.extra ?? '').replace(/on update current_timestamp(\(\d*\))?/i, '').trim();
  const extra = [otherExtra, d.onUpdate ? 'on update CURRENT_TIMESTAMP' : '']
    .filter(Boolean)
    .join(' ');
  if (extra) col.extra = extra;
  return col;
}

const sameParts = (a: TypeParts, b: TypeParts): boolean =>
  a.base === b.base &&
  a.length === b.length &&
  a.precision === b.precision &&
  a.scale === b.scale &&
  a.unsigned === b.unsigned &&
  a.zerofill === b.zerofill &&
  a.values.join('\u0000') === b.values.join('\u0000');

/** Whether a draft differs from its original, ignoring position. */
export function columnChanged(d: ColumnDraft, types: TypeDescriptor[]): boolean {
  if (!d.original) return true;
  const o = draftFromColumn(d.original, types);
  return (
    d.name.trim() !== o.name ||
    !sameParts(d.type, o.type) ||
    d.nullable !== o.nullable ||
    d.defaultMode !== o.defaultMode ||
    (d.defaultMode !== 'none' && d.defaultMode !== 'null' && d.defaultText !== o.defaultText) ||
    d.autoIncrement !== o.autoIncrement ||
    d.onUpdate !== o.onUpdate ||
    d.comment !== o.comment
  );
}

export type IndexKind = 'primary' | 'unique' | 'index' | 'fulltext';

export interface IndexDraft {
  key: string;
  original: IndexDefinition | null;
  name: string;
  kind: IndexKind;
  columns: { name: string; length: string }[];
  dropped: boolean;
}

export function indexKind(ix: IndexDefinition): IndexKind {
  if (ix.primary) return 'primary';
  if ((ix.type ?? '').toUpperCase() === 'FULLTEXT') return 'fulltext';
  return ix.unique ? 'unique' : 'index';
}

export function draftFromIndex(ix: IndexDefinition): IndexDraft {
  return {
    key: nextKey(),
    original: ix,
    name: ix.name,
    kind: indexKind(ix),
    columns: ix.columns.map((c) => ({
      name: c.name ?? (c.expression ? `(${c.expression})` : ''),
      length: c.length ? String(c.length) : '',
    })),
    dropped: false,
  };
}

export function indexFromDraft(d: IndexDraft): IndexDefinition {
  const ix: IndexDefinition = {
    name: d.kind === 'primary' ? 'PRIMARY' : d.name.trim(),
    unique: d.kind === 'primary' || d.kind === 'unique',
    primary: d.kind === 'primary',
    columns: d.columns
      .filter((c) => c.name)
      .map((c) => {
        const expr = /^\((.*)\)$/s.exec(c.name);
        const out: IndexDefinition['columns'][number] = expr
          ? { expression: expr[1] as string }
          : { name: c.name };
        if (/^\d+$/.test(c.length)) out.length = Number(c.length);
        return out;
      }),
  };
  if (d.kind === 'fulltext') ix.type = 'FULLTEXT';
  return ix;
}

function indexChanged(d: IndexDraft): boolean {
  if (!d.original) return true;
  const o = draftFromIndex(d.original);
  return (
    d.name !== o.name ||
    d.kind !== o.kind ||
    JSON.stringify(d.columns) !== JSON.stringify(o.columns)
  );
}

export interface ForeignKeyDraft {
  key: string;
  original: ForeignKeyDefinition | null;
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
  dropped: boolean;
}

export function draftFromForeignKey(fk: ForeignKeyDefinition): ForeignKeyDraft {
  return {
    key: nextKey(),
    original: fk,
    name: fk.name,
    columns: [...fk.columns],
    referencedTable: fk.referencedTable,
    referencedColumns: [...fk.referencedColumns],
    onDelete: fk.onDelete ?? 'RESTRICT',
    onUpdate: fk.onUpdate ?? 'RESTRICT',
    dropped: false,
  };
}

export function newForeignKeyDraft(): ForeignKeyDraft {
  return {
    key: nextKey(),
    original: null,
    name: '',
    columns: [''],
    referencedTable: '',
    referencedColumns: [''],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
    dropped: false,
  };
}

export interface StructureDraft {
  name: string;
  comment: string;
  columns: ColumnDraft[];
  indexes: IndexDraft[];
  foreignKeys: ForeignKeyDraft[];
}

export function draftFromDefinition(def: TableDefinition, types: TypeDescriptor[]): StructureDraft {
  return {
    name: def.name,
    comment: def.comment ?? '',
    columns: def.columns.map((c) => draftFromColumn(c, types)),
    indexes: def.indexes.map(draftFromIndex),
    foreignKeys: def.foreignKeys.map(draftFromForeignKey),
  };
}

/** The first problem that keeps the draft from being applied, in words. */
export function draftProblem(draft: StructureDraft, types: TypeDescriptor[]): string | null {
  const live = draft.columns.filter((c) => !c.dropped);
  if (!live.length) return 'A table needs at least one column';
  const names = new Set<string>();
  for (const c of live) {
    const name = c.name.trim();
    if (!name) return 'Every column needs a name';
    if (names.has(name.toLowerCase())) return `Two columns are called ${name}`;
    names.add(name.toLowerCase());
    const problem = typeProblem(c.type, types);
    if (problem) return `${name}: ${problem}`;
    if (c.defaultMode === 'null' && !c.nullable)
      return `${name}: a NOT NULL column cannot default to NULL`;
  }
  for (const ix of draft.indexes.filter((i) => !i.dropped)) {
    if (ix.kind !== 'primary' && !ix.name.trim()) return 'Every index needs a name';
    if (!ix.columns.some((c) => c.name)) return `Index ${ix.name || 'PRIMARY'} needs a column`;
  }
  for (const fk of draft.foreignKeys.filter((f) => !f.dropped && !f.original)) {
    if (!fk.referencedTable) return 'A foreign key needs a referenced table';
    if (fk.columns.some((c) => !c) || fk.referencedColumns.some((c) => !c))
      return 'A foreign key needs a column on both sides';
  }
  if (!draft.name.trim()) return 'The table needs a name';
  return null;
}

/**
 * The changes that turn the definition into the draft. Positions are only expressed when the
 * driver can move columns: a surviving column whose predecessor among the surviving columns
 * changed gets `after`; a new column goes after whatever precedes it in the draft.
 */
export function diffStructure(
  def: TableDefinition,
  draft: StructureDraft,
  types: TypeDescriptor[],
  caps: AlterCapabilities,
): StructureChange[] {
  const changes: StructureChange[] = [];
  const live = draft.columns.filter((c) => !c.dropped);
  const survivorsDraft = live.filter((d) => d.original).map((d) => d.original!.name);
  // Columns in the longest run that is already in the original order stay put; only the others
  // move. That turns "drag one column to the top" into one move instead of many.
  const originalIndex = new Map(def.columns.map((c, i) => [c.name, i]));
  const staying = longestOrderedRun(survivorsDraft.map((n) => originalIndex.get(n) ?? 0)).map(
    (i) => survivorsDraft[i] as string,
  );
  const predecessor = (list: string[], name: string): string | null => {
    const i = list.indexOf(name);
    return i > 0 ? (list[i - 1] as string) : null;
  };

  for (const d of draft.columns) {
    if (d.original && d.dropped) changes.push({ kind: 'dropColumn', name: d.original.name });
  }
  live.forEach((d, i) => {
    const column = columnFromDraft(d, types, i + 1);
    if (!d.original) {
      const prev = i > 0 ? (live[i - 1] as ColumnDraft).name.trim() : null;
      const isLast = i === live.length - 1;
      const change: StructureChange = { kind: 'addColumn', column };
      if (caps.moveColumn && !isLast) change.after = prev;
      changes.push(change);
      return;
    }
    const name = d.original.name;
    const moved = caps.moveColumn && !staying.includes(name);
    if (!columnChanged(d, types) && !moved) return;
    // Without in-place changes a pure rename is still possible; anything else is left to the
    // driver, whose error explains what it cannot do.
    const renameOnly = !columnChanged({ ...d, name }, types) && d.name.trim() !== name;
    if (!caps.modifyColumn && renameOnly && !moved) {
      changes.push({ kind: 'renameColumn', from: name, to: d.name.trim() });
      return;
    }
    const change: StructureChange = { kind: 'modifyColumn', name, column };
    if (moved) {
      // After whatever precedes it in the draft, new columns included: those are added later in
      // the same statement, so name the nearest surviving column instead.
      change.after = predecessor(survivorsDraft, name);
    }
    changes.push(change);
  });

  for (const ix of draft.indexes) {
    if (ix.original && (ix.dropped || indexChanged(ix)))
      changes.push({ kind: 'dropIndex', name: ix.original.name });
    if (!ix.dropped && (!ix.original || indexChanged(ix)))
      changes.push({ kind: 'addIndex', index: indexFromDraft(ix) });
  }
  for (const fk of draft.foreignKeys) {
    if (fk.original && fk.dropped) changes.push({ kind: 'dropForeignKey', name: fk.original.name });
    if (!fk.original && !fk.dropped) {
      const out: ForeignKeyDefinition = {
        name: fk.name.trim(),
        columns: fk.columns,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      };
      changes.push({ kind: 'addForeignKey', foreignKey: out });
    }
  }
  if (draft.comment !== (def.comment ?? ''))
    changes.push({ kind: 'setComment', comment: draft.comment });
  if (draft.name.trim() !== def.name) changes.push({ kind: 'renameTable', to: draft.name.trim() });
  return changes;
}

/** What applying could cost, in words: dropped data, narrowed types, stricter nullability. */
export function destructive(def: TableDefinition, changes: StructureChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind === 'dropColumn') out.push(`Column ${c.name} and all its data are removed.`);
    if (c.kind === 'dropForeignKey') out.push(`Foreign key ${c.name} stops being enforced.`);
    if (c.kind === 'modifyColumn') {
      const before = def.columns.find((x) => x.name === c.name);
      if (before && before.nativeType.toLowerCase() !== c.column.nativeType.toLowerCase())
        out.push(
          `Column ${c.name} changes from ${before.nativeType} to ${c.column.nativeType}; values that do not fit are cut off or rejected.`,
        );
      if (before?.nullable && !c.column.nullable)
        out.push(`Column ${c.name} becomes NOT NULL; this fails while rows hold NULL there.`);
    }
  }
  return out;
}

/** Indexes (into `seq`) of one longest strictly increasing subsequence. */
function longestOrderedRun(seq: number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] as number] as number) < (seq[i] as number)) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i] as number) out.unshift(i);
  return out;
}
