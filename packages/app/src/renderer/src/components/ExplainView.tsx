import type { ExplainResult } from '@rasql/driver-protocol';
import { DataGrid } from './DataGrid';

interface Props {
  sql: string;
  result: ExplainResult | null;
  error: string | null;
  loading: boolean;
  onClose: () => void;
}

/** EXPLAIN output for the statement under the cursor: a grid for table plans, text otherwise. */
export function ExplainView({ sql, result, error, loading, onClose }: Props): React.JSX.Element {
  return (
    <section className="explain-view">
      <header>
        <strong>EXPLAIN</strong>
        <code title={sql}>{sql.length > 120 ? `${sql.slice(0, 120)}…` : sql}</code>
        <span className="spacer" />
        <button onClick={onClose} title="Close">
          ×
        </button>
      </header>
      {loading && <div className="hint">Explaining…</div>}
      {error && <div className="form-error">{error}</div>}
      {result &&
        !loading &&
        !error &&
        (result.format === 'table' && result.columns ? (
          <DataGrid columns={result.columns} rows={result.rows ?? []} />
        ) : (
          <pre>{result.text ?? (result.rows ? JSON.stringify(result.rows, null, 2) : '')}</pre>
        ))}
    </section>
  );
}
