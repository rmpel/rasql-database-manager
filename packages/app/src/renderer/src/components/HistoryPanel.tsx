import { useEffect, useState } from 'react';
import type { HistoryEntry } from '@shared/api';
import { rasql } from '../api';

interface Props {
  connectionKey: string;
  /** Bumped by the owner after every recorded run so the list reloads. */
  version: number;
  onLoad: (sql: string) => void;
  onRun: (sql: string) => void;
  onClose: () => void;
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const firstLine = (sql: string): string => {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

/** The connection's query history. Click loads into the editor, double-click runs. */
export function HistoryPanel({
  connectionKey,
  version,
  onLoad,
  onRun,
  onClose,
}: Props): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let alive = true;
    rasql.history
      .list(connectionKey, 200)
      .then((list) => alive && setEntries(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connectionKey, version]);

  const clear = async (): Promise<void> => {
    await rasql.history.clear(connectionKey);
    setEntries([]);
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.sql.toLowerCase().includes(q)) : entries;

  return (
    <aside className="history-panel">
      <header>
        <strong>History</strong>
        <span className="spacer" />
        <button
          onClick={() => void clear()}
          disabled={entries.length === 0}
          title="Forget this connection's history"
        >
          Clear
        </button>
        <button onClick={onClose} title="Close (⌘⇧H)">
          ×
        </button>
      </header>
      <input
        placeholder="Filter history"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul>
        {shown.map((e) => (
          <li key={e.id}>
            <button
              className={`history-entry${e.error ? ' failed' : ''}`}
              onClick={() => onLoad(e.sql)}
              onDoubleClick={() => onRun(e.sql)}
              title={`${e.sql}\n\nClick to load, double-click to run`}
            >
              <code>{firstLine(e.sql)}</code>
              <span className="history-meta">
                {relative(e.startedAt)}
                {e.elapsedMs !== undefined ? ` · ${e.elapsedMs} ms` : ''}
                {e.error
                  ? ` · ${e.error}`
                  : e.rowCount !== undefined
                    ? ` · ${e.rowCount} rows`
                    : e.affectedRows !== undefined
                      ? ` · ${e.affectedRows} affected`
                      : ''}
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="hint">{entries.length ? 'No matches' : 'Nothing run yet'}</li>
        )}
      </ul>
    </aside>
  );
}
