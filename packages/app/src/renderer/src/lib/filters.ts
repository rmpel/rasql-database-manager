/**
 * The filter bar's model: rules as the user typed them, which operators and inputs a column gets,
 * and compiling it all into protocol filters. Pure, so it is unit-tested without the UI.
 *
 * Rules on different columns are ANDed. Rules on the same column form a group with one
 * match-all or match-any switch. The quick search ORs a match over every searchable column.
 */
import {
  BASIC_FILTER_OPERATORS,
  V,
  type ColumnMeta,
  type Filter,
  type FilterNode,
  type FilterOperator,
  type Value,
} from '@rasql/driver-protocol';
import { parseEditText, valueToEditText } from './edit-values';

export interface FilterDraft {
  id: number;
  column: string;
  op: FilterOperator;
  /** The value; the lower bound for between. */
  text: string;
  /** The upper bound for between. */
  text2: string;
  /** Chosen members for 'in' and 'not in' on enum columns. */
  values: string[];
}

export interface FilterState {
  drafts: FilterDraft[];
  whereSql: string;
  /** Quick search across all columns. */
  search: string;
  /** Per column: how rules on the same column combine. Defaults to 'all'. */
  groupMatch: Record<string, 'all' | 'any'>;
}

export type ColumnKind =
  'text' | 'number' | 'temporal' | 'date' | 'enum' | 'set' | 'bool' | 'binary';

export const emptyFilters = (): FilterState => ({
  drafts: [],
  whereSql: '',
  search: '',
  groupMatch: {},
});

let draftSeq = 1;
export const newDraftId = (): number => draftSeq++;

export function columnKind(meta: ColumnMeta): ColumnKind {
  switch (meta.valueType) {
    case 'int':
    case 'decimal':
    case 'float':
    case 'bit':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
    case 'datetime':
      return 'temporal';
    case 'enum':
      return 'enum';
    case 'set':
      return 'set';
    case 'bool':
      return 'bool';
    case 'bytes':
    case 'geometry':
      return 'binary';
    default:
      return 'text';
  }
}

const COMPARE: FilterOperator[] = ['=', '!=', '<', '<=', '>', '>='];
const NULLS: FilterOperator[] = ['is null', 'is not null'];

const BY_KIND: Record<ColumnKind, FilterOperator[]> = {
  text: [
    'contains',
    'not contains',
    'starts with',
    'ends with',
    '=',
    '!=',
    'in',
    'not in',
    'like',
    'not like',
    'regexp',
    'not regexp',
    '<',
    '>',
    'is empty',
    'is not empty',
  ],
  number: [...COMPARE, 'between', 'not between', 'in', 'not in'],
  date: [...COMPARE, 'between', 'not between', 'starts with'],
  temporal: [...COMPARE, 'between', 'not between', 'starts with'],
  enum: ['=', '!=', 'in', 'not in'],
  set: ['has member', 'contains', '=', '!=', 'is empty', 'is not empty'],
  bool: ['=', '!='],
  binary: ['=', '!=', 'is empty', 'is not empty'],
};

/** The operators offered for a column, in menu order, limited to what the driver supports. */
export function operatorsFor(
  meta: ColumnMeta,
  supported: readonly FilterOperator[] = BASIC_FILTER_OPERATORS,
): FilterOperator[] {
  return [...BY_KIND[columnKind(meta)], ...NULLS].filter((op) => supported.includes(op));
}

export function defaultOperator(
  meta: ColumnMeta,
  supported?: readonly FilterOperator[],
): FilterOperator {
  return operatorsFor(meta, supported)[0] ?? '=';
}

const LABELS: Partial<Record<FilterOperator, string>> = {
  '!=': '≠',
  '<=': '≤',
  '>=': '≥',
  like: 'LIKE',
  'not like': 'NOT LIKE',
  in: 'is one of',
  'not in': 'is not one of',
  'is null': 'is NULL',
  'is not null': 'is not NULL',
  regexp: 'matches regexp',
  'not regexp': 'does not match regexp',
};

export const operatorLabel = (op: FilterOperator): string => LABELS[op] ?? op;

export type InputShape = 'none' | 'one' | 'two' | 'list' | 'members' | 'member' | 'bool';

/** Which input a rule shows: nothing, one field, two for between, a list, or a member picker. */
export function inputShape(op: FilterOperator, kind: ColumnKind, hasMembers: boolean): InputShape {
  if (op === 'is null' || op === 'is not null' || op === 'is empty' || op === 'is not empty')
    return 'none';
  if (op === 'between' || op === 'not between') return 'two';
  if (kind === 'bool') return 'bool';
  if (hasMembers && kind === 'enum' && (op === 'in' || op === 'not in')) return 'members';
  if (hasMembers && ((kind === 'enum' && (op === '=' || op === '!=')) || op === 'has member'))
    return 'member';
  if (op === 'in' || op === 'not in') return 'list';
  return 'one';
}

export function newDraft(meta: ColumnMeta, supported?: readonly FilterOperator[]): FilterDraft {
  return {
    id: newDraftId(),
    column: meta.name,
    op: defaultOperator(meta, supported),
    text: '',
    text2: '',
    values: [],
  };
}

/** Pre-filled drafts, used when a tab opens with filters already applied (following a foreign key). */
export function draftsFromFilters(filters: Filter[]): FilterState {
  return {
    ...emptyFilters(),
    drafts: filters.map((f) => {
      const list = Array.isArray(f.value) ? f.value.map(valueToEditText) : [];
      const isRange = f.op === 'between' || f.op === 'not between';
      return {
        id: newDraftId(),
        column: f.column,
        op: f.op,
        text: isRange
          ? (list[0] ?? '')
          : Array.isArray(f.value)
            ? list.join(', ')
            : f.value
              ? valueToEditText(f.value)
              : '',
        text2: isRange ? (list[1] ?? '') : '',
        values: isRange ? [] : list,
      };
    }),
  };
}

/** Operators whose value is a pattern or plain text whatever the column type. */
const TEXT_VALUE: FilterOperator[] = [
  'contains',
  'not contains',
  'starts with',
  'ends with',
  'like',
  'not like',
  'regexp',
  'not regexp',
  'has member',
];

type Compiled = { filter: Filter } | { error: string } | null;

function compileDraft(d: FilterDraft, meta: ColumnMeta, members: string[] | undefined): Compiled {
  const column = meta.originalName ?? meta.name;
  const kind = columnKind(meta);
  const shape = inputShape(d.op, kind, Boolean(members?.length));
  const parse = (text: string): { value: Value } | { error: string } => {
    if (TEXT_VALUE.includes(d.op)) return { value: V.text(text) };
    // A date column compared with starts with or a partial date is still compared as text.
    return parseEditText(text, meta);
  };
  const label = `${meta.name}: `;
  switch (shape) {
    case 'none':
      return { filter: { column, op: d.op } };
    case 'two': {
      const lo = d.text.trim();
      const hi = d.text2.trim();
      if (!lo && !hi) return null;
      // One bound only: an open range, which is what an empty field usually means.
      if (!lo || !hi) {
        const r = parse(lo || hi);
        if ('error' in r) return { error: label + r.error };
        const between = d.op === 'between';
        const op: FilterOperator = lo ? (between ? '>=' : '<') : between ? '<=' : '>';
        return { filter: { column, op, value: r.value } };
      }
      const a = parse(lo);
      if ('error' in a) return { error: label + a.error };
      const b = parse(hi);
      if ('error' in b) return { error: label + b.error };
      return { filter: { column, op: d.op, value: [a.value, b.value] } };
    }
    case 'members': {
      if (!d.values.length) return null;
      return { filter: { column, op: d.op, value: d.values.map((m) => V.enum(m)) } };
    }
    case 'list': {
      const parts = d.text
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!parts.length) return null;
      const values: Value[] = [];
      for (const part of parts) {
        const r = parse(part);
        if ('error' in r) return { error: label + r.error };
        values.push(r.value);
      }
      return { filter: { column, op: d.op, value: values } };
    }
    case 'bool': {
      if (d.text === '') return null;
      return { filter: { column, op: d.op, value: V.bool(d.text === '1') } };
    }
    case 'member':
    case 'one': {
      // An empty value is an unfinished rule, not "equals the empty string": that is 'is empty'.
      if (d.text === '') return null;
      if (shape === 'member' && d.op !== 'has member')
        return { filter: { column, op: d.op, value: V.enum(d.text) } };
      const r = parse(d.text);
      if ('error' in r) return { error: label + r.error };
      return { filter: { column, op: d.op, value: r.value } };
    }
  }
}

const SEARCHABLE: ColumnKind[] = ['text', 'enum', 'set', 'date', 'temporal'];

/** The quick search: contains on text-like columns, equality on numbers when the term is one. */
export function searchFilters(term: string, columns: ColumnMeta[]): Filter[] {
  const t = term.trim();
  if (!t) return [];
  const numeric = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t);
  const out: Filter[] = [];
  for (const meta of columns) {
    const column = meta.originalName ?? meta.name;
    const kind = columnKind(meta);
    if (SEARCHABLE.includes(kind)) out.push({ column, op: 'contains', value: V.text(t) });
    else if (kind === 'number' && numeric) {
      const r = parseEditText(t, meta);
      if (!('error' in r)) out.push({ column, op: '=', value: r.value });
    }
  }
  return out;
}

/** Turn the bar into filters. Returns the first problem instead of a partial list. */
export function compileFilters(
  state: FilterState,
  columns: ColumnMeta[],
  members: Record<string, string[]> = {},
): { where: FilterNode[]; whereSql: string } | { error: string } {
  const byColumn = new Map<string, Filter[]>();
  for (const d of state.drafts) {
    const meta = columns.find((c) => c.name === d.column);
    if (!meta) continue;
    const r = compileDraft(d, meta, members[d.column]);
    if (r === null) continue;
    if ('error' in r) return r;
    const list = byColumn.get(d.column) ?? [];
    list.push(r.filter);
    byColumn.set(d.column, list);
  }
  const where: FilterNode[] = [];
  for (const [column, filters] of byColumn) {
    if (filters.length === 1) where.push(filters[0] as Filter);
    else where.push({ match: state.groupMatch[column] ?? 'all', filters });
  }
  const search = searchFilters(state.search, columns);
  if (search.length === 1) where.push(search[0] as Filter);
  else if (search.length > 1) where.push({ match: 'any', filters: search });
  else if (state.search.trim() && columns.length)
    return { error: 'No column can be searched for that text' };
  return { where, whereSql: state.whereSql.trim() };
}

/** Rules that actually filter: finished rules, the search and the raw WHERE. */
export function activeFilterCount(
  state: FilterState,
  columns: ColumnMeta[],
  members: Record<string, string[]> = {},
): number {
  let n = 0;
  for (const d of state.drafts) {
    const meta = columns.find((c) => c.name === d.column);
    if (meta && compileDraft(d, meta, members[d.column]) !== null) n++;
  }
  if (state.search.trim()) n++;
  if (state.whereSql.trim()) n++;
  return n;
}

/** Members of ENUM and SET columns from their native type, e.g. enum('draft','publish'). */
export function parseMembers(nativeType: string): string[] | null {
  const m = /^\s*(enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(nativeType);
  if (!m) return null;
  const out: string[] = [];
  const re = /'((?:[^'\\]|''|\\.)*)'/g;
  let item: RegExpExecArray | null;
  while ((item = re.exec(m[2] as string)) !== null) {
    out.push((item[1] as string).replace(/''/g, "'").replace(/\\(.)/g, '$1'));
  }
  return out;
}

/** Display order: rules grouped by column, columns in order of their first rule. */
export function groupDrafts(drafts: FilterDraft[]): { column: string; drafts: FilterDraft[] }[] {
  const groups: { column: string; drafts: FilterDraft[] }[] = [];
  for (const d of drafts) {
    const g = groups.find((x) => x.column === d.column);
    if (g) g.drafts.push(d);
    else groups.push({ column: d.column, drafts: [d] });
  }
  return groups;
}
