import { useEffect, useState } from 'react';
import type { SavedQuery } from '@shared/api';
import { rasql } from '../api';

interface Props {
  connectionKey: string;
  /** Bumped by the owner after a save so the list reloads. */
  version: number;
  /** The query bound to the current tab, highlighted in the list. */
  currentId: string | null;
  onLoad: (query: SavedQuery) => void;
  onRun: (query: SavedQuery) => void;
  onChanged: (query: SavedQuery | null, removedId?: string) => void;
  onClose: () => void;
  tabs: React.ReactNode;
}

const firstLine = (sql: string): string => {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

/** Named queries for this connection and the shared ones. Click loads, double-click runs. */
export function SavedQueriesPanel({
  connectionKey,
  version,
  currentId,
  onLoad,
  onRun,
  onChanged,
  onClose,
  tabs,
}: Props): React.JSX.Element {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    rasql.savedQueries
      .list(connectionKey)
      .then((list) => alive && setQueries(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connectionKey, version, reloads]);

  const remove = async (q: SavedQuery): Promise<void> => {
    const ok = await rasql.dialog.confirm({
      title: `Delete saved query “${q.name}”?`,
      message: q.connection === null ? 'It is shared, so it disappears from every connection.' : '',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await rasql.savedQueries.remove(q.id);
    onChanged(null, q.id);
    setReloads((n) => n + 1);
  };

  const rename = async (): Promise<void> => {
    if (!renaming) return;
    const q = queries.find((x) => x.id === renaming.id);
    setRenaming(null);
    if (!q || !renaming.name.trim() || renaming.name.trim() === q.name) return;
    const saved = await rasql.savedQueries.save({ ...q, name: renaming.name });
    onChanged(saved);
    setReloads((n) => n + 1);
  };

  const term = filter.trim().toLowerCase();
  const shown = term
    ? queries.filter(
        (q) => q.name.toLowerCase().includes(term) || q.sql.toLowerCase().includes(term),
      )
    : queries;

  return (
    <aside className="history-panel saved-panel">
      <header>
        {tabs}
        <span className="spacer" />
        <button onClick={onClose} title="Close (⌘⇧H)">
          ×
        </button>
      </header>
      <input
        placeholder="Filter saved queries"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul>
        {shown.map((q) => (
          <li key={q.id} className={q.id === currentId ? 'current' : ''}>
            {renaming?.id === q.id ? (
              <form
                className="saved-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename();
                }}
              >
                <input
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: q.id, name: e.target.value })}
                  onBlur={() => void rename()}
                  onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                />
              </form>
            ) : (
              <button
                className="history-entry"
                onClick={() => onLoad(q)}
                onDoubleClick={() => onRun(q)}
                title={`${q.sql}\n\nClick to open, double-click to run`}
              >
                <span className="saved-name">
                  {q.name}
                  {q.connection === null && <span className="saved-shared">all connections</span>}
                </span>
                <code>{firstLine(q.sql)}</code>
              </button>
            )}
            <span className="saved-actions">
              <button title="Rename" onClick={() => setRenaming({ id: q.id, name: q.name })}>
                ✎
              </button>
              <button title="Delete" onClick={() => void remove(q)}>
                ✕
              </button>
            </span>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="hint">
            {queries.length ? 'No matches' : 'No saved queries yet. Save one with ⌘S.'}
          </li>
        )}
      </ul>
    </aside>
  );
}
