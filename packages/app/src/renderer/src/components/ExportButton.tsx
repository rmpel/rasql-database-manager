import { useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportProgress, ExportRequest } from '@shared/api';
import { rasql } from '../api';

interface Props {
  sessionKey: string;
  /** The statement to export in full; null disables the button. */
  sql: string | null;
  suggestedName: string;
  /** Needed for SQL INSERT export. Without it the SQL option is hidden. */
  table?: { schema?: string; name: string };
  disabled?: boolean;
}

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'csv', label: 'CSV…' },
  { format: 'json', label: 'JSON…' },
  { format: 'sql', label: 'SQL inserts…' },
];

/**
 * "Export" with a small menu of formats. Streams the statement's full result through the main
 * process to a file the user picks; shows progress and the final path. Shared by the table tab
 * and the query tab.
 */
export function ExportButton({
  sessionKey,
  sql,
  suggestedName,
  table,
  disabled,
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    return rasql.export.onProgress((p) => {
      if (p.exportId !== activeId.current) return;
      setProgress(p);
      if (p.done) activeId.current = null;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const start = async (format: ExportFormat): Promise<void> => {
    setOpen(false);
    if (!sql) return;
    const req: ExportRequest = { sessionKey, sql, format, suggestedName };
    if (table) req.table = table;
    const id = await rasql.export.start(req);
    if (!id) return;
    activeId.current = id;
    setProgress({ exportId: id, rows: 0, bytes: 0, done: false });
  };

  const cancel = (): void => {
    if (activeId.current) void rasql.export.cancel(activeId.current);
  };

  const running = progress !== null && !progress.done;

  return (
    <span className="export" ref={wrapper}>
      <button
        className="export-button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !sql || running}
        title="Export the full result to a file"
      >
        Export ▾
      </button>
      {open && (
        <div className="export-menu">
          {FORMATS.filter((f) => f.format !== 'sql' || table).map((f) => (
            <button key={f.format} data-format={f.format} onClick={() => void start(f.format)}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {progress && (
        <span className={`export-status${progress.error ? ' error' : ''}`}>
          {running && (
            <>
              Exporting… {progress.rows.toLocaleString()} rows{' '}
              <button className="link" onClick={cancel}>
                cancel
              </button>
            </>
          )}
          {progress.done && progress.error && `Export failed: ${progress.error}`}
          {progress.done && !progress.error && progress.filePath && (
            <>
              Saved {progress.rows.toLocaleString()} rows to{' '}
              <button
                className="link"
                onClick={() => void rasql.app.revealPath(progress.filePath as string)}
                title={progress.filePath}
              >
                {progress.filePath.split('/').pop()}
              </button>
            </>
          )}
          {progress.done && !progress.error && !progress.filePath && 'Export cancelled'}
        </span>
      )}
    </span>
  );
}
