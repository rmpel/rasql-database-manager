import { useEffect, useRef, useState } from 'react';
import { V, type ColumnMeta, type Value } from '@rasql/driver-protocol';
import { isEditableType, parseEditText, valueToEditText } from '../lib/edit-values';
import type { RowRef, StagedApi } from '../hooks/useStagedChanges';
import { ValueCell } from './ValueCell';

const ROW_HEIGHT = 26;
const OVERSCAN = 10;

export interface SortState {
  column: string;
  direction: 'asc' | 'desc';
}

interface Props {
  columns: ColumnMeta[];
  rows: Value[][];
  /** Current sort, drawn in the header; clicking a header calls onSort with the column name. */
  sort?: SortState | null;
  onSort?: (column: string) => void;
  /** Called when the user scrolls near the end; the owner may load the next page. */
  onReachEnd?: () => void;
  /** Present when the grid is editable: staged changes are drawn and edits are routed here. */
  staged?: StagedApi;
  selectedRow?: RowRef | null;
  onSelectRow?: (ref: RowRef | null) => void;
  /** Column indexes whose values point at another table; cells get a link to follow. */
  foreignKeyColumns?: ReadonlySet<number>;
  onFollowForeignKey?: (ref: RowRef, col: number) => void;
  /** Single-click selection of one cell, for the inspector. */
  selectedCell?: { ref: RowRef; col: number } | null;
  onSelectCell?: (cell: { ref: RowRef; col: number }) => void;
}

interface Editing {
  ref: RowRef;
  col: number;
  text: string;
  isNull: boolean;
  error?: string;
}

const sameRef = (a: RowRef | null | undefined, b: RowRef | null | undefined): boolean =>
  !!a &&
  !!b &&
  a.kind === b.kind &&
  (a.kind === 'row'
    ? a.index === (b as { index: number }).index
    : a.id === (b as { id: number }).id);

/**
 * A windowed grid: only the rows in view are in the DOM, so a hundred thousand rows cost the
 * same as thirty. Staged edits, deletes and inserts are drawn on top of the loaded rows and never
 * mutate them; the owner commits or discards them.
 *
 * Editing: double-click a cell, Enter stages, Escape cancels, Tab and Shift+Tab stage and move to
 * the next or previous editable cell, wrapping across rows. ⌘⇧N toggles NULL.
 */
export function DataGrid({
  columns,
  rows,
  onReachEnd,
  sort,
  onSort,
  staged,
  selectedRow,
  onSelectRow,
  foreignKeyColumns,
  onFollowForeignKey,
  selectedCell,
  onSelectCell,
}: Props): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [editing, setEditing] = useState<Editing | null>(null);
  // The editor's blur handler must know whether its cell is still the one being edited.
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const inserts = staged?.staged.inserts ?? [];
  const total = rows.length + inserts.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  const onScroll = (): void => {
    const el = viewport.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (onReachEnd && el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 20)
      onReachEnd();
  };

  const refAt = (i: number): RowRef =>
    i < rows.length
      ? { kind: 'row', index: i }
      : { kind: 'insert', id: inserts[i - rows.length]!.id };
  const positionOf = (ref: RowRef): number =>
    ref.kind === 'row' ? ref.index : rows.length + inserts.findIndex((i) => i.id === ref.id);

  const cellValue = (ref: RowRef, col: number): Value => {
    const edit = staged?.editAt(ref, col);
    if (edit) return edit;
    if (ref.kind === 'row') return rows[ref.index]?.[col] ?? V.null();
    return V.null();
  };

  const scrollRowIntoView = (position: number): void => {
    const el = viewport.current;
    if (!el) return;
    const top = position * ROW_HEIGHT + ROW_HEIGHT; // header row
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop + ROW_HEIGHT) el.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  };

  const startEdit = (ref: RowRef, col: number): void => {
    if (!staged) return;
    const meta = columns[col];
    if (!meta || !isEditableType(meta)) return;
    const current = cellValue(ref, col);
    scrollRowIntoView(positionOf(ref));
    setEditing({ ref, col, text: valueToEditText(current), isNull: current.t === 'null' });
  };

  /** Stage the current edit. Returns false when the text does not parse; the editor stays open. */
  const commitEdit = (ed: Editing): boolean => {
    if (!staged) return false;
    const meta = columns[ed.col];
    if (!meta) return false;
    const original = ed.ref.kind === 'row' ? rows[ed.ref.index]?.[ed.col] : undefined;
    if (ed.isNull) {
      staged.stageEdit(ed.ref, ed.col, V.null(), original);
      return true;
    }
    const parsed = parseEditText(ed.text, meta);
    if ('error' in parsed) {
      setEditing({ ...ed, error: parsed.error });
      return false;
    }
    staged.stageEdit(ed.ref, ed.col, parsed.value, original);
    return true;
  };

  /** The next editable cell in reading order, wrapping rows; null at either end. */
  const neighbour = (
    ref: RowRef,
    col: number,
    dir: 1 | -1,
  ): { ref: RowRef; col: number } | null => {
    let pos = positionOf(ref);
    let c = col + dir;
    for (;;) {
      while (c >= 0 && c < columns.length) {
        const meta = columns[c];
        if (meta && isEditableType(meta)) return { ref: refAt(pos), col: c };
        c += dir;
      }
      pos += dir;
      if (pos < 0 || pos >= total) return null;
      c = dir === 1 ? 0 : columns.length - 1;
    }
  };

  const onEditorKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!editing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commitEdit(editing)) setEditing(null);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!commitEdit(editing)) return;
      const next = neighbour(editing.ref, editing.col, e.shiftKey ? -1 : 1);
      if (next) startEdit(next.ref, next.col);
      else setEditing(null);
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      setEditing({ ...editing, isNull: !editing.isNull });
    }
  };

  const onEditorBlur = (ref: RowRef, col: number): void => {
    const current = editingRef.current;
    // Only the editor that is still active commits on blur; a Tab move already handled its cell.
    if (!current || !sameRef(current.ref, ref) || current.col !== col) return;
    if (commitEdit(current)) setEditing(null);
  };

  const rowClass = (ref: RowRef): string => {
    const parts = ['grid-row'];
    if (ref.kind === 'insert') parts.push('inserted');
    else if (staged?.isDeleted(ref.index)) parts.push('deleted');
    if (sameRef(selectedRow, ref)) parts.push('selected');
    return parts.join(' ');
  };

  const visible: number[] = [];
  for (let i = first; i < last; i++) visible.push(i);

  return (
    <div className="grid" ref={viewport} onScroll={onScroll}>
      <table className="grid-table" style={{ height: total * ROW_HEIGHT + ROW_HEIGHT }}>
        <thead>
          <tr>
            <th className="grid-rownum">#</th>
            {columns.map((c, i) => {
              const name = c.originalName ?? c.name;
              const sorted = sort && sort.column === name ? sort.direction : null;
              return (
                <th
                  key={i}
                  className={`${onSort ? 'sortable' : ''}${sorted ? ' sorted' : ''}`}
                  title={`${c.nativeType}${c.nullable ? ', nullable' : ''}${c.isPrimaryKey ? ', primary key' : ''}${onSort ? '. Click to sort' : ''}`}
                  onClick={onSort ? () => onSort(name) : undefined}
                >
                  {c.isPrimaryKey && <span className="grid-key">🔑</span>}
                  {c.name}
                  {sorted && <span className="grid-sort">{sorted === 'asc' ? '▲' : '▼'}</span>}
                  <span className="grid-type">{c.valueType}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {first > 0 && (
            <tr style={{ height: first * ROW_HEIGHT }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
          {visible.map((i) => {
            const ref = refAt(i);
            return (
              <tr
                key={ref.kind === 'row' ? `r${ref.index}` : `i${ref.id}`}
                className={rowClass(ref)}
                style={{ height: ROW_HEIGHT }}
              >
                <td
                  className="grid-rownum"
                  onClick={() => onSelectRow?.(sameRef(selectedRow, ref) ? null : ref)}
                >
                  {ref.kind === 'row' ? ref.index + 1 : '+'}
                </td>
                {columns.map((meta, col) => {
                  const isEditing = editing && sameRef(editing.ref, ref) && editing.col === col;
                  const edited = ref.kind === 'row' && staged?.editAt(ref, col) !== undefined;
                  const value = cellValue(ref, col);
                  const unset = ref.kind === 'insert' && staged?.editAt(ref, col) === null;
                  const isSelected =
                    selectedCell && sameRef(selectedCell.ref, ref) && selectedCell.col === col;
                  return (
                    <td
                      key={col}
                      className={`grid-cell grid-cell-${value.t}${edited ? ' edited' : ''}${isEditing ? ' editing' : ''}${isSelected ? ' selected-cell' : ''}`}
                      onClick={() => onSelectCell?.({ ref, col })}
                      onDoubleClick={() => startEdit(ref, col)}
                      title={isEditableType(meta) ? undefined : 'Not editable as text'}
                    >
                      {isEditing ? (
                        <span className="cell-editor">
                          <input
                            autoFocus
                            value={editing.isNull ? '' : editing.text}
                            placeholder={editing.isNull ? 'NULL' : ''}
                            className={editing.error ? 'invalid' : ''}
                            title={editing.error}
                            onChange={(e) =>
                              setEditing({ ...editing, text: e.target.value, isNull: false })
                            }
                            onKeyDown={onEditorKey}
                            onBlur={() => onEditorBlur(ref, col)}
                          />
                          <button
                            type="button"
                            className={`null-toggle${editing.isNull ? ' on' : ''}`}
                            title="Set NULL (⌘⇧N)"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setEditing({ ...editing, isNull: !editing.isNull })}
                          >
                            ∅
                          </button>
                        </span>
                      ) : unset ? (
                        <span className="cell cell-default">default</span>
                      ) : (
                        <>
                          <ValueCell value={value} />
                          {foreignKeyColumns?.has(col) &&
                            value.t !== 'null' &&
                            ref.kind === 'row' && (
                              <button
                                type="button"
                                className="fk-link"
                                title="Open the referenced row"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onFollowForeignKey?.(ref, col);
                                }}
                              >
                                →
                              </button>
                            )}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {last < total && (
            <tr style={{ height: (total - last) * ROW_HEIGHT }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
        </tbody>
      </table>
      {total === 0 && <div className="grid-empty">No rows</div>}
    </div>
  );
}
