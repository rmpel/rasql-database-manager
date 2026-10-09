import { useEffect, useRef, useState } from 'react';
import type { ColumnMeta, Filter, FilterOperator, Value } from '@rasql/driver-protocol';
import { V } from '@rasql/driver-protocol';
import { parseEditText } from '../lib/edit-values';

/** A filter as the user typed it; converted to a typed `Filter` when applied. */
export interface FilterDraft {
  id: number;
  column: string;
  op: FilterOperator;
  text: string;
}

export interface FilterState {
  drafts: FilterDraft[];
  whereSql: string;
}

const OPERATORS: { op: FilterOperator; label: string; needsValue: boolean }[] = [
  { op: '=', label: '=', needsValue: true },
  { op: '!=', label: '≠', needsValue: true },
  { op: '<', label: '<', needsValue: true },
  { op: '<=', label: '≤', needsValue: true },
  { op: '>', label: '>', needsValue: true },
  { op: '>=', label: '≥', needsValue: true },
  { op: 'like', label: 'LIKE', needsValue: true },
  { op: 'not like', label: 'NOT LIKE', needsValue: true },
  { op: 'in', label: 'IN (a, b, …)', needsValue: true },
  { op: 'not in', label: 'NOT IN', needsValue: true },
  { op: 'is null', label: 'IS NULL', needsValue: false },
  { op: 'is not null', label: 'IS NOT NULL', needsValue: false },
];

export const emptyFilters = (): FilterState => ({ drafts: [], whereSql: '' });

/** Turn drafts into typed filters. Returns the first problem instead of a partial list. */
export function compileFilters(
  state: FilterState,
  columns: ColumnMeta[],
): { where: Filter[]; whereSql: string } | { error: string } {
  const where: Filter[] = [];
  for (const d of state.drafts) {
    const meta = columns.find((c) => c.name === d.column);
    if (!meta) continue;
    const needsValue = OPERATORS.find((o) => o.op === d.op)?.needsValue ?? true;
    if (!needsValue) {
      where.push({ column: meta.originalName ?? meta.name, op: d.op });
      continue;
    }
    const parse = (text: string): { value: Value } | { error: string } => {
      // LIKE patterns are always text, whatever the column type.
      if (d.op === 'like' || d.op === 'not like') return { value: V.text(text) };
      return parseEditText(text, meta);
    };
    if (d.op === 'in' || d.op === 'not in') {
      const parts = d.text
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!parts.length) return { error: `${d.column}: list at least one value` };
      const values: Value[] = [];
      for (const part of parts) {
        const r = parse(part);
        if ('error' in r) return { error: `${d.column}: ${r.error}` };
        values.push(r.value);
      }
      where.push({ column: meta.originalName ?? meta.name, op: d.op, value: values });
      continue;
    }
    const r = parse(d.text);
    if ('error' in r) return { error: `${d.column}: ${r.error}` };
    where.push({ column: meta.originalName ?? meta.name, op: d.op, value: r.value });
  }
  return { where, whereSql: state.whereSql.trim() };
}

export const activeFilterCount = (s: FilterState): number =>
  s.drafts.length + (s.whereSql.trim() ? 1 : 0);

interface Props {
  columns: ColumnMeta[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  onApply: () => void;
  onClear: () => void;
  /** Incremented by the owner to focus the bar, e.g. on Cmd+F. */
  focusToken: number;
  error: string | null;
}

export function FilterBar({
  columns,
  state,
  onChange,
  onApply,
  onClear,
  focusToken,
  error,
}: Props): React.JSX.Element {
  const [nextId, setNextId] = useState(1);
  const firstInput = useRef<HTMLInputElement | HTMLSelectElement>(null);

  useEffect(() => {
    if (focusToken > 0) firstInput.current?.focus();
  }, [focusToken]);

  const update = (id: number, patch: Partial<FilterDraft>): void =>
    onChange({ ...state, drafts: state.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)) });

  const add = (): void => {
    const first = columns[0];
    if (!first) return;
    onChange({
      ...state,
      drafts: [...state.drafts, { id: nextId, column: first.name, op: '=', text: '' }],
    });
    setNextId(nextId + 1);
  };

  const remove = (id: number): void =>
    onChange({ ...state, drafts: state.drafts.filter((d) => d.id !== id) });

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onApply();
    }
  };

  return (
    <div className="filter-bar" onKeyDown={onKey}>
      {state.drafts.map((d, i) => {
        const needsValue = OPERATORS.find((o) => o.op === d.op)?.needsValue ?? true;
        return (
          <span className="filter-row" key={d.id}>
            <select
              ref={i === 0 ? (firstInput as React.RefObject<HTMLSelectElement>) : undefined}
              value={d.column}
              onChange={(e) => update(d.id, { column: e.target.value })}
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={d.op}
              onChange={(e) => update(d.id, { op: e.target.value as FilterOperator })}
            >
              {OPERATORS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {needsValue && (
              <input
                className="filter-value"
                value={d.text}
                placeholder={
                  d.op === 'like' || d.op === 'not like'
                    ? '%pattern%'
                    : d.op === 'in' || d.op === 'not in'
                      ? 'a, b, c'
                      : 'value'
                }
                onChange={(e) => update(d.id, { text: e.target.value })}
              />
            )}
            <button className="filter-remove" title="Remove filter" onClick={() => remove(d.id)}>
              ×
            </button>
          </span>
        );
      })}
      <input
        ref={
          state.drafts.length === 0 ? (firstInput as React.RefObject<HTMLInputElement>) : undefined
        }
        className="filter-where"
        value={state.whereSql}
        placeholder="WHERE … (raw SQL, combined with AND)"
        onChange={(e) => onChange({ ...state, whereSql: e.target.value })}
        spellCheck={false}
      />
      <button onClick={add} disabled={columns.length === 0} title="Add a column filter">
        + Filter
      </button>
      <button className="primary" onClick={onApply}>
        Apply
      </button>
      <button onClick={onClear} disabled={activeFilterCount(state) === 0}>
        Clear
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
