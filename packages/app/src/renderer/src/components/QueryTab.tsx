import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplainResult } from '@rasql/driver-protocol';
import type { SavedQuery } from '@shared/api';
import { rasql } from '../api';
import { useQuery } from '../hooks/useQuery';
import { useSchemaCompletion } from '../hooks/useSchemaCompletion';
import { DataGrid } from './DataGrid';
import { ExportButton } from './ExportButton';
import { ExplainView } from './ExplainView';
import { HistoryPanel } from './HistoryPanel';
import { SavedQueriesPanel } from './SavedQueriesPanel';
import { SqlEditor, type RunTarget, type SqlEditorHandle } from './SqlEditor';
import './query-editor.scss';

const MAX_ROWS = 10_000;

interface Props {
  sessionKey: string;
  connectionKey: string;
  engine: string;
  initialSql?: string;
  /** The saved query's name for the tab, or null when the tab is not bound to one. */
  onTitleChange?: (title: string | null) => void;
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

export function QueryTab({
  sessionKey,
  connectionKey,
  engine,
  initialSql,
  onTitleChange,
}: Props): React.JSX.Element {
  const editor = useRef<SqlEditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const { state, run, cancel } = useQuery(sessionKey);
  const { source: completion } = useSchemaCompletion(sessionKey);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [panel, setPanel] = useState<'saved' | 'history' | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [explain, setExplain] = useState<{
    sql: string;
    result: ExplainResult | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const [editorHeight, setEditorHeight] = useState(180);
  // The saved query this tab edits, if any. The ref mirrors it for the editor's change handler.
  const [saved, setSavedState] = useState<SavedQuery | null>(null);
  const savedRef = useRef<SavedQuery | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveForm, setSaveForm] = useState<{ name: string; shared: boolean } | null>(null);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const bind = useCallback((q: SavedQuery | null) => {
    savedRef.current = q;
    setSavedState(q);
  }, []);

  const onDocChange = useCallback((doc: string) => {
    const next = savedRef.current !== null && doc !== savedRef.current.sql;
    setDirty((d) => (d === next ? d : next));
  }, []);

  useEffect(() => {
    onTitleChange?.(saved ? `${saved.name}${dirty ? ' •' : ''}` : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, dirty]);

  const save = useCallback(async () => {
    const current = savedRef.current;
    if (!current) {
      setSaveForm({ name: '', shared: false });
      return;
    }
    try {
      const sql = editor.current?.getDoc() ?? current.sql;
      bind(await rasql.savedQueries.save({ ...current, sql }));
      setDirty(false);
      setSavedVersion((v) => v + 1);
    } catch (err) {
      setSaveError(stripIpc(err));
    }
  }, [bind]);

  const submitSaveForm = async (): Promise<void> => {
    if (!saveForm) return;
    const name = saveForm.name.trim();
    if (!name) {
      setSaveError('Give the query a name');
      return;
    }
    try {
      const stored = await rasql.savedQueries.save({
        name,
        sql: editor.current?.getDoc() ?? '',
        connection: saveForm.shared ? null : connectionKey,
      });
      bind(stored);
      setDirty(false);
      setSaveForm(null);
      setSaveError(null);
      setSavedVersion((v) => v + 1);
    } catch (err) {
      setSaveError(stripIpc(err));
    }
  };

  /** Open a saved query in this tab; asks first when the tab has unsaved changes to another. */
  const loadSaved = async (q: SavedQuery, thenRun = false): Promise<void> => {
    const current = savedRef.current;
    if (current && current.id !== q.id && dirty) {
      const ok = await rasql.dialog.confirm({
        title: `Discard changes to “${current.name}”?`,
        message: 'The editor has changes that are not saved.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    bind(q);
    editor.current?.setDoc(q.sql);
    setDirty(false);
    if (thenRun) execute(q.sql);
  };
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

  const toggleHistory = useCallback(
    () => setPanel((p) => (p === 'history' ? null : 'history')),
    [],
  );

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
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape' && state.status === 'running') {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [execute, doExplain, toggleHistory, cancel, save, state.status]);

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
  const panelTabs = (
    <span className="segmented panel-tabs">
      <button className={panel === 'saved' ? 'active' : ''} onClick={() => setPanel('saved')}>
        Saved
      </button>
      <button className={panel === 'history' ? 'active' : ''} onClick={() => setPanel('history')}>
        History
      </button>
    </span>
  );

  return (
    <div className="tab-body query-tab" ref={root}>
      <div className="query-split">
        <div className="query-main">
          <div style={{ height: editorHeight, minHeight: 80 }} className="sql-editor-host-wrap">
            <SqlEditor
              ref={editor}
              engine={engine}
              initialDoc={initialSql ?? 'SELECT 1'}
              completion={completion}
              onSave={() => void save()}
              onChange={onDocChange}
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
              onClick={() => void save()}
              title={saved ? `Save changes to “${saved.name}” (⌘S)` : 'Save this query (⌘S)'}
              disabled={Boolean(saved) && !dirty}
            >
              Save
            </button>
            {saved && (
              <button
                onClick={() =>
                  setSaveForm({ name: `${saved.name} copy`, shared: saved.connection === null })
                }
                title="Save as a new query"
              >
                Save as…
              </button>
            )}
            <button
              className={panel === 'saved' ? 'active' : ''}
              onClick={() => setPanel((p) => (p === 'saved' ? null : 'saved'))}
              title="Saved queries"
            >
              Saved
            </button>
            <button
              className={panel === 'history' ? 'active' : ''}
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
          {saveForm && (
            <form
              className="save-query-bar"
              onSubmit={(e) => {
                e.preventDefault();
                void submitSaveForm();
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder="Name for this query"
                value={saveForm.name}
                onChange={(e) => setSaveForm({ ...saveForm, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Escape' && setSaveForm(null)}
              />
              <label title="Offer this query on every connection, not only this one">
                <input
                  type="checkbox"
                  checked={saveForm.shared}
                  onChange={(e) => setSaveForm({ ...saveForm, shared: e.target.checked })}
                />
                All connections
              </label>
              <button type="submit" className="primary">
                Save
              </button>
              <button type="button" onClick={() => setSaveForm(null)}>
                Cancel
              </button>
              {saveError && <span className="error">{saveError}</span>}
            </form>
          )}
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
        {panel === 'saved' && (
          <SavedQueriesPanel
            connectionKey={connectionKey}
            version={savedVersion}
            currentId={saved?.id ?? null}
            onLoad={(q) => void loadSaved(q)}
            onRun={(q) => void loadSaved(q, true)}
            onChanged={(q, removedId) => {
              if (q && savedRef.current?.id === q.id) bind({ ...q, sql: savedRef.current.sql });
              if (removedId && savedRef.current?.id === removedId) {
                bind(null);
                setDirty(false);
              }
            }}
            onClose={() => setPanel(null)}
            tabs={panelTabs}
          />
        )}
        {panel === 'history' && (
          <HistoryPanel
            tabs={panelTabs}
            connectionKey={connectionKey}
            version={historyVersion}
            onLoad={(sql) => editor.current?.setDoc(sql)}
            onRun={(sql) => {
              editor.current?.setDoc(sql);
              execute(sql);
            }}
            onClose={() => setPanel(null)}
          />
        )}
      </div>
    </div>
  );
}
