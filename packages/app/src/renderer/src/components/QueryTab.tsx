import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplainResult } from '@rasql/driver-protocol';
import { rasql } from '../api';
import { useQuery } from '../hooks/useQuery';
import { useSchemaCompletion } from '../hooks/useSchemaCompletion';
import { DataGrid } from './DataGrid';
import { ExportButton } from './ExportButton';
import { ExplainView } from './ExplainView';
import { HistoryPanel } from './HistoryPanel';
import { SqlEditor, type RunTarget, type SqlEditorHandle } from './SqlEditor';
import './query-editor.scss';

const MAX_ROWS = 10_000;

interface Props {
  sessionKey: string;
  connectionKey: string;
  engine: string;
}

interface LastRun {
  target: RunTarget;
  startedAt: string;
  recorded: boolean;
}

const stripIpc = (err: unknown): string =>
  err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
    : String(err);

export function QueryTab({ sessionKey, connectionKey, engine }: Props): React.JSX.Element {
  const editor = useRef<SqlEditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const { state, run, cancel } = useQuery(sessionKey);
  const { source: completion } = useSchemaCompletion(sessionKey);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [explain, setExplain] = useState<{
    sql: string;
    result: ExplainResult | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const [editorHeight, setEditorHeight] = useState(180);

  const execute = useCallback(
    (sqlOverride?: string) => {
      const target: RunTarget | null = sqlOverride
        ? { sql: sqlOverride, source: { kind: 'all' } }
        : (editor.current?.runTarget() ?? null);
      if (!target) return;
      setLastRun({ target, startedAt: new Date().toISOString(), recorded: false });
      void run(target.sql, { maxRows: MAX_ROWS });
    },
    [run],
  );

  // Record a finished run in the history once, then let the panel reload.
  useEffect(() => {
    if (!lastRun || lastRun.recorded) return;
    if (state.status !== 'done' && state.status !== 'error') return;
    const entry: Parameters<typeof rasql.history.add>[0] = {
      connection: connectionKey,
      sql: lastRun.target.sql,
      startedAt: lastRun.startedAt,
    };
    if (state.elapsedMs !== undefined) entry.elapsedMs = state.elapsedMs;
    if (state.status === 'error' && state.error)
      entry.error = `${state.error.code}: ${state.error.message}`;
    else if (state.columns.length) entry.rowCount = state.rows.length;
    else if (state.affectedRows !== undefined) entry.affectedRows = state.affectedRows;
    const recorded = { ...lastRun, recorded: true };
    void rasql.history
      .add(entry)
      .catch(() => undefined)
      .finally(() => {
        setLastRun((cur) => (cur === lastRun ? recorded : cur));
        setHistoryVersion((v) => v + 1);
      });
  }, [
    state.status,
    state.elapsedMs,
    state.error,
    state.columns.length,
    state.rows.length,
    state.affectedRows,
    lastRun,
    connectionKey,
  ]);

  const doExplain = useCallback(async () => {
    const target = editor.current?.runTarget();
    if (!target) return;
    setExplain({ sql: target.sql, result: null, error: null, loading: true });
    try {
      const result = await rasql.session.explain(sessionKey, target.sql);
      setExplain({ sql: target.sql, result, error: null, loading: false });
    } catch (err) {
      setExplain({ sql: target.sql, result: null, error: stripIpc(err), loading: false });
    }
  }, [sessionKey]);

  const toggleHistory = useCallback(() => setHistoryOpen((o) => !o), []);

  const onEscape = useCallback(() => {
    if (state.status === 'running') cancel();
  }, [state.status, cancel]);

  // Shortcuts also work when focus is in the grid or toolbar, but only for the visible tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const pane = root.current?.closest('.tab-pane') as HTMLElement | null;
      if (pane?.hidden) return;
      if (
        root.current?.contains(document.activeElement) &&
        document.activeElement?.closest('.cm-editor')
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        execute();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void doExplain();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        toggleHistory();
      } else if (e.key === 'Escape' && state.status === 'running') {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [execute, doExplain, toggleHistory, cancel, state.status]);

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const move = (ev: MouseEvent): void =>
      setEditorHeight(Math.max(80, startH + (ev.clientY - startY)));
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const sourceNote = (t: RunTarget): string =>
    t.source.kind === 'selection'
      ? 'selection'
      : t.source.kind === 'statement'
        ? `statement ${t.source.index} of ${t.source.total}`
        : '';
  const lastSql = lastRun && state.status === 'done' ? lastRun.target.sql : null;

  return (
    <div className="tab-body query-tab" ref={root}>
      <div className="query-split">
        <div className="query-main">
          <div style={{ height: editorHeight, minHeight: 80 }} className="sql-editor-host-wrap">
            <SqlEditor
              ref={editor}
              engine={engine}
              initialDoc="SELECT 1"
              completion={completion}
              onRun={() => execute()}
              onExplain={() => void doExplain()}
              onToggleHistory={toggleHistory}
              onEscape={onEscape}
            />
          </div>
          <div
            className="editor-resize"
            onMouseDown={startResize}
            title="Drag to resize the editor"
          />
          <div className="tab-toolbar">
            <button
              className="primary"
              onClick={() => execute()}
              disabled={state.status === 'running'}
              title="Run the selection or the statement under the cursor (⌘↩)"
            >
              Run ⌘↩
            </button>
            <button onClick={cancel} disabled={state.status !== 'running'} title="Cancel (Esc)">
              Cancel
            </button>
            <button
              onClick={() => void doExplain()}
              disabled={state.status === 'running'}
              title="Explain the statement under the cursor (⌘⇧E)"
            >
              Explain
            </button>
            <button
              className={historyOpen ? 'active' : ''}
              onClick={toggleHistory}
              title="Query history (⌘⇧H)"
            >
              History
            </button>
            <ExportButton
              sessionKey={sessionKey}
              sql={lastSql}
              suggestedName="query"
              disabled={state.status === 'running'}
            />
            <span className="toolbar-status">
              {lastRun && sourceNote(lastRun.target) && (
                <span className="statement-note">Ran {sourceNote(lastRun.target)}:</span>
              )}
              {state.status === 'running' && 'Running…'}
              {state.status === 'error' && (
                <span className="error">
                  {state.error?.code}: {state.error?.message}
                </span>
              )}
              {state.status === 'done' &&
                (state.columns.length
                  ? `${state.rows.length.toLocaleString()} rows${state.truncated ? ` (showing the first ${MAX_ROWS.toLocaleString()}; export for all)` : ''} in ${state.elapsedMs} ms`
                  : `${state.affectedRows ?? 0} rows affected${state.insertId && state.insertId !== '0' ? `, insert id ${state.insertId}` : ''} in ${state.elapsedMs} ms`)}
              {state.warnings.map((w, i) => (
                <span key={i} className="warning">
                  {w.message}
                </span>
              ))}
            </span>
          </div>
          {explain && (
            <ExplainView
              sql={explain.sql}
              result={explain.result}
              error={explain.error}
              loading={explain.loading}
              onClose={() => setExplain(null)}
            />
          )}
          <div className="query-results">
            {state.columns.length > 0 && <DataGrid columns={state.columns} rows={state.rows} />}
          </div>
        </div>
        {historyOpen && (
          <HistoryPanel
            connectionKey={connectionKey}
            version={historyVersion}
            onLoad={(sql) => editor.current?.setDoc(sql)}
            onRun={(sql) => {
              editor.current?.setDoc(sql);
              execute(sql);
            }}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
