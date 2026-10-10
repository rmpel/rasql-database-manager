import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DialectInfo,
  Filter,
  FilterOperator,
  SelectOptions,
  TableDefinition,
  Value,
} from '@rasql/driver-protocol';
import { rasql } from '../api';
import { useQuery } from '../hooks/useQuery';
import { keyColumnsFor, useStagedChanges, type RowRef } from '../hooks/useStagedChanges';
import { DataGrid, type SortState } from './DataGrid';
import { ExportButton } from './ExportButton';
import { CellInspector } from './CellInspector';
import { useResizable } from '../hooks/useResizable';
import { FilterBar } from './FilterBar';
import {
  activeFilterCount,
  compileFilters,
  draftsFromFilters,
  emptyFilters,
  parseMembers,
  type FilterState,
} from '../lib/filters';
import {
  filtersForSource,
  filtersForTarget,
  foreignKeyByColumn,
  referencingTables,
  type IncomingReference,
} from '../lib/related';

const PAGE = 500;

interface Props {
  sessionKey: string;
  schema: string;
  table: string;
  kind: 'table' | 'view';
  view: 'content' | 'structure';
  onViewChange: (view: 'content' | 'structure') => void;
  /** Only the visible tab reacts to keyboard shortcuts and focus refreshes. */
  active: boolean;
  /** Filters applied on first load, with the filter bar open and pre-filled. */
  initialFilters?: Filter[];
  /** Open another table with filters, for following foreign keys either way. */
  onOpenRelated?: (target: { schema: string; name: string }, filters: Filter[]) => void;
}

export function TableTab({
  sessionKey,
  schema,
  table,
  kind,
  view,
  onViewChange,
  active,
  initialFilters,
  onOpenRelated,
}: Props): React.JSX.Element {
  const { state, run } = useQuery(sessionKey);
  const count = useQuery(sessionKey);
  const staged = useStagedChanges();
  const [definition, setDefinition] = useState<TableDefinition | null>(null);
  const [selectedRow, setSelectedRow] = useState<RowRef | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [committing, setCommitting] = useState(false);
  const [showFilters, setShowFilters] = useState(Boolean(initialFilters?.length));
  const [filterDraft, setFilterDraft] = useState<FilterState>(() =>
    initialFilters?.length ? draftsFromFilters(initialFilters) : emptyFilters(),
  );
  const [applied, setApplied] = useState<Pick<SelectOptions, 'where' | 'whereSql'>>(() =>
    initialFilters?.length ? { where: initialFilters } : {},
  );
  const [filterError, setFilterError] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [sort, setSort] = useState<SortState | null>(null);
  const [exportSql, setExportSql] = useState<string | null>(null);
  const [references, setReferences] = useState<IncomingReference[] | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ ref: RowRef; col: number } | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  const inspectorSize = useResizable({
    storageKey: 'rasql.inspectorHeight',
    initial: 280,
    min: 120,
    containerRef: dock,
  });
  const [referencesOpen, setReferencesOpen] = useState(false);
  const referencesMenu = useRef<HTMLSpanElement>(null);

  const fkByColumn = useMemo(() => foreignKeyByColumn(definition), [definition]);
  const [operators, setOperators] = useState<FilterOperator[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    rasql.session
      .dialect(sessionKey, 'describe', [])
      .then((info) => alive && setOperators((info as DialectInfo).filterOperators))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionKey]);
  // ENUM and SET members, from the column types in the table definition.
  const members = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of definition?.columns ?? []) {
      const list = parseMembers(c.nativeType);
      if (list) out[c.name] = list;
    }
    return out;
  }, [definition]);
  const inspectedColumn = selectedCell ? state.columns[selectedCell.col] : undefined;
  const inspectedValue = useMemo(() => {
    if (!selectedCell) return undefined;
    const edit = staged.editAt(selectedCell.ref, selectedCell.col);
    if (edit) return edit;
    return selectedCell.ref.kind === 'row'
      ? state.rows[selectedCell.ref.index]?.[selectedCell.col]
      : undefined;
  }, [selectedCell, staged, state.rows]);
  const columnName = useCallback(
    (i: number) => state.columns[i]?.originalName ?? state.columns[i]?.name ?? '',
    [state.columns],
  );
  const foreignKeyColumns = useMemo(() => {
    const set = new Set<number>();
    state.columns.forEach((_, i) => {
      if (fkByColumn.has(columnName(i))) set.add(i);
    });
    return set;
  }, [state.columns, fkByColumn, columnName]);

  const rowValueOf = useCallback(
    (ref: RowRef) =>
      (column: string): Value | undefined => {
        if (ref.kind !== 'row') return undefined;
        const i = state.columns.findIndex((c) => (c.originalName ?? c.name) === column);
        return i === -1 ? undefined : state.rows[ref.index]?.[i];
      },
    [state.columns, state.rows],
  );

  const followForeignKey = useCallback(
    (ref: RowRef, col: number) => {
      const fk = fkByColumn.get(columnName(col));
      if (!fk || !onOpenRelated) return;
      onOpenRelated(
        { schema: fk.referencedSchema ?? schema, name: fk.referencedTable },
        filtersForTarget(fk, rowValueOf(ref)),
      );
    },
    [fkByColumn, columnName, onOpenRelated, schema, rowValueOf],
  );

  const openReferences = useCallback(async () => {
    setReferencesOpen((o) => !o);
    if (references === null)
      setReferences(await referencingTables(sessionKey, { schema, name: table }));
  }, [references, sessionKey, schema, table]);

  const followReference = useCallback(
    (r: IncomingReference) => {
      setReferencesOpen(false);
      if (!selectedRow || !onOpenRelated) return;
      onOpenRelated(r.table, filtersForSource(r.foreignKey, rowValueOf(selectedRow)));
    },
    [selectedRow, onOpenRelated, rowValueOf],
  );

  useEffect(() => {
    if (!referencesOpen) return;
    const close = (e: MouseEvent): void => {
      if (!referencesMenu.current?.contains(e.target as Node)) setReferencesOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [referencesOpen]);
  const offset = useRef(0);
  const exhausted = state.status === 'done' && (state.rowCount ?? 0) < PAGE;
  const editable = kind === 'table';
  const filtered = Boolean(applied.where?.length || applied.whereSql);

  const selectOptions = useCallback(
    (page: boolean): SelectOptions => {
      const opts: SelectOptions = { ...applied };
      if (sort) opts.orderBy = [{ column: sort.column, direction: sort.direction }];
      if (page) {
        opts.limit = PAGE;
        opts.offset = offset.current;
      }
      return opts;
    },
    [applied, sort],
  );

  const loadPage = useCallback(
    async (append: boolean) => {
      if (append && (exhausted || state.status === 'running')) return;
      if (!append) offset.current = 0;
      const sql = (await rasql.session.dialect(sessionKey, 'buildSelect', [
        { schema, name: table },
        selectOptions(true),
      ])) as string;
      offset.current += PAGE;
      await run(sql, { append, rowBatchSize: 250 });
    },
    [sessionKey, schema, table, run, state.status, exhausted, selectOptions],
  );

  // The export statement is the same selection without paging.
  useEffect(() => {
    let alive = true;
    rasql.session
      .dialect(sessionKey, 'buildSelect', [{ schema, name: table }, selectOptions(false)])
      .then((sql) => alive && setExportSql(sql as string))
      .catch(() => alive && setExportSql(null));
    return () => {
      alive = false;
    };
  }, [sessionKey, schema, table, selectOptions]);

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (staged.count === 0) return true;
    return rasql.dialog.confirm({
      title: 'Discard pending changes?',
      message: `This discards ${staged.count} uncommitted change${staged.count === 1 ? '' : 's'}.`,
      confirmLabel: 'Discard',
      danger: true,
    });
  }, [staged.count]);

  const reload = useCallback(async () => {
    staged.discard();
    setSelectedRow(null);
    setMessage(null);
    count.reset();
    await loadPage(false);
  }, [staged, count, loadPage]);

  const refresh = useCallback(async () => {
    if (await confirmDiscard()) await reload();
  }, [confirmDiscard, reload]);

  // Initial load, and reload whenever the applied filters or the sort change. Deferred by a tick so
  // the state resets inside reload() do not run synchronously within the effect.
  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, schema, table, applied, sort]);

  useEffect(() => {
    rasql.session
      .describeTable(sessionKey, schema, table)
      .then(setDefinition)
      .catch(() => setDefinition(null));
  }, [sessionKey, schema, table]);

  // Refresh a clean, visible content tab when the window comes back into focus, at most once
  // every few seconds: some window systems report focus on every click.
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    return rasql.app.onFocus(() => {
      const now = Date.now();
      if (now - lastFocusRefresh.current < 5000) return;
      if (active && view === 'content' && staged.count === 0 && state.status !== 'running') {
        lastFocusRefresh.current = now;
        void loadPage(false);
      }
    });
  }, [active, view, staged.count, state.status, loadPage]);

  const applyFilters = useCallback(async () => {
    const compiled = compileFilters(filterDraft, state.columns, members);
    if ('error' in compiled) {
      setFilterError(compiled.error);
      return;
    }
    if (!(await confirmDiscard())) return;
    setFilterError(null);
    const next: Pick<SelectOptions, 'where' | 'whereSql'> = {};
    if (compiled.where.length) next.where = compiled.where;
    if (compiled.whereSql) next.whereSql = compiled.whereSql;
    setApplied(next);
  }, [filterDraft, state.columns, members, confirmDiscard]);

  const clearFilters = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    setFilterDraft(emptyFilters());
    setFilterError(null);
    setApplied({});
  }, [confirmDiscard]);

  const toggleSort = useCallback(
    async (column: string) => {
      if (!(await confirmDiscard())) return;
      setSort((s) => {
        if (!s || s.column !== column) return { column, direction: 'asc' };
        if (s.direction === 'asc') return { column, direction: 'desc' };
        return null;
      });
    },
    [confirmDiscard],
  );

  const countRows = useCallback(async () => {
    const sql = (await rasql.session.dialect(sessionKey, 'buildCount', [
      { schema, name: table },
      applied,
    ])) as string;
    await count.run(sql);
  }, [sessionKey, schema, table, applied, count]);

  const commit = useCallback(async () => {
    if (staged.count === 0 || committing) return;
    setCommitting(true);
    setMessage(null);
    try {
      const statements = await staged.buildStatements({
        sessionKey,
        schema,
        table,
        columns: state.columns,
        rows: state.rows,
        definition,
      });
      const { reliable } = keyColumnsFor(state.columns, definition);
      const preview = statements.join(';\n');
      const ok = await rasql.dialog.confirm({
        title: `Commit ${statements.length} statement${statements.length === 1 ? '' : 's'} to ${table}?`,
        message: reliable
          ? 'The statements run in one transaction. Nothing is written if any of them fails.'
          : 'This table has no primary key. Rows are matched on every column, which can affect more rows than intended. The statements run in one transaction.',
        detail: preview.length > 4000 ? `${preview.slice(0, 4000)}\n…` : preview,
        confirmLabel: 'Commit',
        danger: !reliable,
      });
      if (!ok) return;
      const results = await rasql.session.transaction(sessionKey, statements);
      const affected = results.reduce((n, r) => n + (r.affectedRows ?? 0), 0);
      setMessage({
        kind: 'info',
        text: `Committed ${statements.length} statement${statements.length === 1 ? '' : 's'}, ${affected} row${affected === 1 ? '' : 's'} affected`,
      });
      staged.discard();
      setSelectedRow(null);
      await loadPage(false);
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof Error
            ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
            : String(err),
      });
    } finally {
      setCommitting(false);
    }
  }, [
    staged,
    committing,
    sessionKey,
    schema,
    table,
    state.columns,
    state.rows,
    definition,
    loadPage,
  ]);

  const deleteSelected = useCallback(() => {
    if (!selectedRow) return;
    if (selectedRow.kind === 'row') staged.toggleDelete(selectedRow.index);
    else {
      staged.removeInsert(selectedRow.id);
      setSelectedRow(null);
    }
  }, [selectedRow, staged]);

  const addRow = useCallback(() => {
    const id = staged.addRow(state.columns.length);
    setSelectedRow({ kind: 'insert', id });
  }, [staged, state.columns.length]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditor = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (mod && e.key === 'r') {
        e.preventDefault();
        void refresh();
      } else if (mod && e.key === 'f') {
        e.preventDefault();
        setShowFilters(true);
        setFocusToken((t) => t + 1);
      } else if (mod && e.key === 'i') {
        e.preventDefault();
        setShowInspector((v) => !v);
      } else if (mod && e.key === 's' && editable) {
        e.preventDefault();
        void commit();
      } else if (
        !inEditor &&
        editable &&
        selectedRow &&
        (e.key === 'Backspace' || e.key === 'Delete')
      ) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === 'Escape' && !inEditor) {
        setSelectedRow(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editable, refresh, commit, selectedRow, deleteSelected]);

  const pending = staged.count;
  const filterCount = activeFilterCount(filterDraft, state.columns, members);
  const total = count.state.status === 'done' ? count.state.rows[0]?.[0] : undefined;
  const totalText = total && total.t !== 'null' && 'v' in total ? String(total.v) : null;

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <button
          className={view === 'content' ? 'active' : ''}
          onClick={() => onViewChange('content')}
        >
          Content
        </button>
        <button
          className={view === 'structure' ? 'active' : ''}
          onClick={() => onViewChange('structure')}
        >
          Structure
        </button>
        <span className="toolbar-sep" />
        <button
          onClick={() => void refresh()}
          title="Refresh (⌘R)"
          disabled={state.status === 'running'}
        >
          Refresh
        </button>
        <button
          className={showFilters || filtered ? 'active' : ''}
          onClick={() => setShowFilters((s) => !s)}
          title="Filter (⌘F)"
        >
          Filter{filterCount ? ` (${filterCount})` : ''}
        </button>
        <button
          className={showInspector ? 'active' : ''}
          onClick={() => setShowInspector((v) => !v)}
          title="Inspect the selected cell (⌘I)"
        >
          Inspector
        </button>
        <ExportButton
          sessionKey={sessionKey}
          sql={exportSql}
          suggestedName={table}
          table={{ schema, name: table }}
        />
        {editable && (
          <span className="dropdown" ref={referencesMenu}>
            <button
              onClick={() => void openReferences()}
              disabled={!selectedRow || selectedRow.kind !== 'row'}
              title="Rows in other tables that point at the selected row"
            >
              References ▾
            </button>
            {referencesOpen && (
              <div className="dropdown-menu">
                {references === null && <span className="hint">Looking up foreign keys…</span>}
                {references?.length === 0 && (
                  <span className="hint">No table references this one.</span>
                )}
                {references?.map((r) => (
                  <button
                    key={`${r.table.schema}.${r.table.name}.${r.foreignKey.name}`}
                    onClick={() => followReference(r)}
                  >
                    {r.table.name}{' '}
                    <span className="dropdown-detail">({r.foreignKey.columns.join(', ')})</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        {editable && view === 'content' && (
          <>
            <span className="toolbar-sep" />
            <button onClick={addRow} title="Add a row" disabled={state.status !== 'done'}>
              + Row
            </button>
            <button
              onClick={deleteSelected}
              title="Delete the selected row (⌫)"
              disabled={!selectedRow}
            >
              {selectedRow?.kind === 'row' && staged.isDeleted(selectedRow.index)
                ? 'Undelete row'
                : 'Delete row'}
            </button>
            <span className="toolbar-sep" />
            <span className={`pending-badge${pending ? ' has-pending' : ''}`}>
              {pending} pending
            </span>
            <button
              className="primary"
              onClick={() => void commit()}
              disabled={pending === 0 || committing}
              title="Commit (⌘S)"
            >
              {committing ? 'Committing…' : 'Commit'}
            </button>
            <button onClick={staged.discard} disabled={pending === 0}>
              Discard
            </button>
          </>
        )}
        <span className="toolbar-status">
          {message ? (
            <span className={message.kind === 'error' ? 'error' : ''}>{message.text}</span>
          ) : (
            <>
              {state.status === 'running' && 'Loading…'}
              {state.status === 'error' && <span className="error">{state.error?.message}</span>}
              {state.status === 'done' && (
                <>
                  {state.rows.length.toLocaleString()} rows loaded{filtered ? ' (filtered)' : ''}
                  {exhausted ? '' : ' (scroll for more)'}
                  {' · '}
                  {totalText !== null ? (
                    <span>{Number(totalText).toLocaleString()} total</span>
                  ) : count.state.status === 'running' ? (
                    'counting…'
                  ) : (
                    <button className="link" onClick={() => void countRows()}>
                      count all
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </span>
      </div>
      {showFilters && view === 'content' && (
        <FilterBar
          columns={state.columns}
          state={filterDraft}
          onChange={setFilterDraft}
          onApply={() => void applyFilters()}
          onClear={() => void clearFilters()}
          focusToken={focusToken}
          error={filterError}
          {...(operators ? { operators } : {})}
          members={members}
        />
      )}
      {view === 'content' ? (
        <div className="grid-with-inspector" ref={dock}>
          <DataGrid
            columns={state.columns}
            rows={state.rows}
            onReachEnd={() => void loadPage(true)}
            sort={sort}
            onSort={(column) => void toggleSort(column)}
            foreignKeyColumns={foreignKeyColumns}
            onFollowForeignKey={followForeignKey}
            selectedCell={selectedCell}
            onSelectCell={setSelectedCell}
            {...(editable ? { staged, selectedRow, onSelectRow: setSelectedRow } : {})}
          />
          {showInspector && (
            <div
              className={`inspector-dock${inspectorSize.resizing ? ' resizing' : ''}`}
              style={{ height: inspectorSize.size }}
            >
              <div
                className="inspector-resizer"
                title="Drag to resize"
                onPointerDown={inspectorSize.onPointerDown}
              />
              {selectedCell && inspectedValue && inspectedColumn && (
                <CellInspector
                  cellKey={`${selectedCell.ref.kind === 'row' ? selectedCell.ref.index : `i${selectedCell.ref.id}`}:${selectedCell.col}`}
                  column={inspectedColumn}
                  value={inspectedValue}
                  editable={editable && selectedCell.ref.kind === 'row'}
                  onStage={(v) =>
                    staged.stageEdit(
                      selectedCell.ref,
                      selectedCell.col,
                      v,
                      state.rows[selectedCell.ref.kind === 'row' ? selectedCell.ref.index : -1]?.[
                        selectedCell.col
                      ],
                    )
                  }
                  onClose={() => setShowInspector(false)}
                />
              )}
              {!selectedCell && (
                <div className="inspector inspector-empty">Click a cell to inspect it.</div>
              )}
            </div>
          )}
        </div>
      ) : (
        <Structure definition={definition} />
      )}
    </div>
  );
}

function Structure({ definition }: { definition: TableDefinition | null }): React.JSX.Element {
  if (!definition) return <div className="hint">Loading structure…</div>;
  return (
    <div className="structure">
      <table className="plain">
        <thead>
          <tr>
            <th>#</th>
            <th>Column</th>
            <th>Type</th>
            <th>Null</th>
            <th>Default</th>
            <th>Extra</th>
          </tr>
        </thead>
        <tbody>
          {definition.columns.map((c) => (
            <tr key={c.name}>
              <td>{c.ordinal}</td>
              <td>
                {definition.primaryKey?.includes(c.name) && <span title="primary key">🔑 </span>}
                {c.name}
              </td>
              <td>
                <code>{c.nativeType}</code> <span className="grid-type">{c.valueType}</span>
              </td>
              <td>{c.nullable ? 'yes' : 'no'}</td>
              <td>
                {c.default ? (
                  c.default.t === 'expression' ? (
                    <code>{c.default.sql}</code>
                  ) : (
                    JSON.stringify(c.default)
                  )
                ) : (
                  ''
                )}
              </td>
              <td>
                {c.autoIncrement ? 'auto increment ' : ''}
                {c.generated ? `generated (${c.generated.stored ? 'stored' : 'virtual'}) ` : ''}
                {c.extra ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {definition.indexes.length > 0 && (
        <>
          <h3>Indexes</h3>
          <ul>
            {definition.indexes.map((i) => (
              <li key={i.name}>
                <strong>{i.name}</strong> {i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : ''} (
                {i.columns
                  .map(
                    (c) =>
                      `${c.name ?? c.expression ?? ''}${c.length ? `(${c.length})` : ''}${c.order === 'desc' ? ' DESC' : ''}`,
                  )
                  .join(', ')}
                )
              </li>
            ))}
          </ul>
        </>
      )}
      {definition.foreignKeys.length > 0 && (
        <>
          <h3>Foreign keys</h3>
          <ul>
            {definition.foreignKeys.map((f) => (
              <li key={f.name}>
                <strong>{f.name}</strong> ({f.columns.join(', ')}) → {f.referencedTable} (
                {f.referencedColumns.join(', ')}){f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}
                {f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {definition.ddl && (
        <>
          <h3>DDL</h3>
          <pre>{definition.ddl}</pre>
        </>
      )}
    </div>
  );
}
