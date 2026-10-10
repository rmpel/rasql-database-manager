import { useEffect, useRef } from 'react';
import type { ColumnMeta, FilterOperator } from '@rasql/driver-protocol';
import {
  columnKind,
  defaultOperator,
  groupDrafts,
  inputShape,
  newDraft,
  operatorLabel,
  operatorsFor,
  type FilterDraft,
  type FilterState,
} from '../lib/filters';

interface Props {
  columns: ColumnMeta[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  onApply: () => void;
  onClear: () => void;
  /** Incremented by the owner to focus the bar, e.g. on Cmd+F. */
  focusToken: number;
  error: string | null;
  /** What the driver can build; limits the operator menus. */
  operators?: readonly FilterOperator[];
  /** ENUM and SET members per column name, for dropdowns. */
  members?: Record<string, string[]>;
}

/** The rule shown before the user adds any: it lives outside the state until it is edited. */
const GHOST_ID = 0;

export function FilterBar({
  columns,
  state,
  onChange,
  onApply,
  onClear,
  focusToken,
  error,
  operators,
  members = {},
}: Props): React.JSX.Element {
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusToken === 0) return;
    const el = bar.current?.querySelector<HTMLElement>('.filter-value, .filter-search');
    el?.focus();
  }, [focusToken]);

  const first = columns[0];
  const ghost: FilterDraft | null =
    state.drafts.length === 0 && first
      ? {
          id: GHOST_ID,
          column: first.name,
          op: defaultOperator(first, operators),
          text: '',
          text2: '',
          values: [],
        }
      : null;
  const drafts = ghost ? [ghost] : state.drafts;

  const setDrafts = (next: FilterDraft[]): void => onChange({ ...state, drafts: next });

  const update = (id: number, patch: Partial<FilterDraft>): void =>
    setDrafts(drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const changeColumn = (d: FilterDraft, column: string): void => {
    const meta = columns.find((c) => c.name === column);
    if (!meta) return;
    const allowed = operatorsFor(meta, operators);
    const before = columns.find((c) => c.name === d.column);
    // An operator the user never touched follows the column; a chosen one stays when it can.
    const untouched = !before || d.op === defaultOperator(before, operators);
    update(d.id, {
      column,
      op: !untouched && allowed.includes(d.op) ? d.op : defaultOperator(meta, operators),
      values: [],
    });
  };

  /** Add a rule for the same column right after this one: that is how groups are made. */
  const addAfter = (d: FilterDraft): void => {
    const meta = columns.find((c) => c.name === d.column);
    if (!meta) return;
    const i = drafts.findIndex((x) => x.id === d.id);
    const next = [...drafts];
    next.splice(i + 1, 0, { ...newDraft(meta, operators), op: d.op });
    setDrafts(next);
  };

  const addRule = (): void => {
    // Prefer a column without a rule yet; a second rule on a column is added with its own +.
    const used = new Set(drafts.map((d) => d.column));
    const meta = columns.find((c) => !used.has(c.name)) ?? first;
    if (!meta) return;
    setDrafts([...drafts, newDraft(meta, operators)]);
  };

  const remove = (id: number): void => setDrafts(drafts.filter((d) => d.id !== id));

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      onApply();
    }
  };

  return (
    <div className="filter-bar" ref={bar} onKeyDown={onKey}>
      <div className="filter-rules">
        {groupDrafts(drafts).map((g) => {
          const rows = g.drafts.map((d) => (
            <Rule
              key={d.id}
              draft={d}
              columns={columns}
              operators={operators}
              members={members[d.column]}
              onColumn={(c) => changeColumn(d, c)}
              onChange={(patch) => update(d.id, patch)}
              onAdd={() => addAfter(d)}
              onRemove={() => remove(d.id)}
              removable={!(ghost && d.id === GHOST_ID)}
            />
          ));
          if (g.drafts.length < 2) return rows;
          const match = state.groupMatch[g.column] ?? 'all';
          const setMatch = (m: 'all' | 'any'): void =>
            onChange({ ...state, groupMatch: { ...state.groupMatch, [g.column]: m } });
          return (
            <div className="filter-group" key={`group-${g.column}`}>
              <div className="filter-group-head">
                <span>{g.column}: match</span>
                <span className="segmented">
                  <button
                    className={match === 'all' ? 'active' : ''}
                    onClick={() => setMatch('all')}
                    title="Every rule on this column must hold (AND)"
                  >
                    all
                  </button>
                  <button
                    className={match === 'any' ? 'active' : ''}
                    onClick={() => setMatch('any')}
                    title="At least one rule on this column must hold (OR)"
                  >
                    any
                  </button>
                </span>
                <span>of these rules</span>
              </div>
              {rows}
            </div>
          );
        })}
      </div>
      <div className="filter-footer">
        <button onClick={addRule} disabled={columns.length === 0} title="Add a rule">
          + Rule
        </button>
        <input
          className="filter-search"
          type="search"
          value={state.search}
          placeholder="Search all columns"
          title="Matches rows where any column contains this text; numbers also match numeric columns exactly"
          onChange={(e) => onChange({ ...state, search: e.target.value })}
        />
        <input
          className="filter-where"
          value={state.whereSql}
          placeholder="WHERE … (raw SQL, combined with AND)"
          onChange={(e) => onChange({ ...state, whereSql: e.target.value })}
          spellCheck={false}
        />
        <button className="primary" onClick={onApply}>
          Apply
        </button>
        <button onClick={onClear}>Clear</button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}

interface RuleProps {
  draft: FilterDraft;
  columns: ColumnMeta[];
  operators: readonly FilterOperator[] | undefined;
  members: string[] | undefined;
  onColumn: (column: string) => void;
  onChange: (patch: Partial<FilterDraft>) => void;
  onAdd: () => void;
  onRemove: () => void;
  removable: boolean;
}

function Rule({
  draft: d,
  columns,
  operators,
  members,
  onColumn,
  onChange,
  onAdd,
  onRemove,
  removable,
}: RuleProps): React.JSX.Element {
  const meta = columns.find((c) => c.name === d.column);
  const kind = meta ? columnKind(meta) : 'text';
  const ops = meta ? operatorsFor(meta, operators) : [d.op];
  const shape = inputShape(d.op, kind, Boolean(members?.length));
  const dateInput = kind === 'date' && d.op !== 'starts with';
  const placeholder =
    d.op === 'like' || d.op === 'not like'
      ? '%pattern%'
      : d.op === 'regexp' || d.op === 'not regexp'
        ? 'regular expression'
        : kind === 'temporal'
          ? 'YYYY-MM-DD HH:MM:SS'
          : 'value';
  const field = (value: string, set: (v: string) => void, ph = placeholder): React.JSX.Element => (
    <input
      className="filter-value"
      type={dateInput ? 'date' : 'text'}
      inputMode={kind === 'number' ? 'decimal' : undefined}
      value={value}
      placeholder={ph}
      spellCheck={false}
      onChange={(e) => set(e.target.value)}
    />
  );

  return (
    <div className="filter-row">
      <select value={d.column} onChange={(e) => onColumn(e.target.value)} title="Column">
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        value={d.op}
        onChange={(e) => onChange({ op: e.target.value as FilterOperator })}
        title="Operator"
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {operatorLabel(op)}
          </option>
        ))}
      </select>
      {shape === 'one' && field(d.text, (text) => onChange({ text }))}
      {shape === 'list' && field(d.text, (text) => onChange({ text }), 'a, b, c')}
      {shape === 'two' && (
        <>
          {field(d.text, (text) => onChange({ text }), 'from')}
          <span className="filter-and">and</span>
          {field(d.text2, (text2) => onChange({ text2 }), 'to')}
        </>
      )}
      {shape === 'bool' && (
        <select
          className="filter-value"
          value={d.text}
          onChange={(e) => onChange({ text: e.target.value })}
        >
          <option value="">choose…</option>
          <option value="1">true</option>
          <option value="0">false</option>
        </select>
      )}
      {shape === 'member' && (
        <select
          className="filter-value"
          value={d.text}
          onChange={(e) => onChange({ text: e.target.value })}
        >
          <option value="">choose…</option>
          {members?.map((m) => (
            <option key={m} value={m}>
              {m === '' ? '(empty)' : m}
            </option>
          ))}
        </select>
      )}
      {shape === 'members' && (
        <details className="filter-members">
          <summary className="filter-value" tabIndex={0}>
            {d.values.length ? d.values.join(', ') : 'choose…'}
          </summary>
          <div className="filter-members-list">
            {members?.map((m) => (
              <label key={m}>
                <input
                  type="checkbox"
                  checked={d.values.includes(m)}
                  onChange={(e) =>
                    onChange({
                      values: e.target.checked ? [...d.values, m] : d.values.filter((x) => x !== m),
                    })
                  }
                />
                {m === '' ? '(empty)' : m}
              </label>
            ))}
          </div>
        </details>
      )}
      <button className="filter-add" title="Add a rule for this column" onClick={onAdd}>
        +
      </button>
      {removable && (
        <button className="filter-remove" title="Remove rule" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
