import { useCallback, useEffect, useState } from 'react';
import type { DbObjectKind, ObjectDefinition } from '@rasql/driver-protocol';
import { rasql } from '../api';
import { SqlEditor } from './SqlEditor';

interface Props {
  sessionKey: string;
  engine: string;
  schema: string;
  name: string;
  kind: DbObjectKind;
  /** From the object list: routine type, trigger table and so on. */
  extra?: Record<string, string>;
  onOpenTable: (table: string) => void;
  onOpenInQuery: (sql: string) => void;
}

const stripIpc = (err: unknown): string =>
  err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
    : String(err);

const prop = (def: ObjectDefinition | null, label: string): string | undefined =>
  def?.properties.find((p) => p.label === label)?.value;

export function kindLabel(kind: DbObjectKind, extra?: Record<string, string>): string {
  if (kind === 'routine') return extra?.['type'] === 'function' ? 'Function' : 'Procedure';
  return kind[0]?.toUpperCase() + kind.slice(1);
}

/** One sentence on what this kind of object does, for people who rarely meet one. */
function explain(
  kind: DbObjectKind,
  name: string,
  def: ObjectDefinition | null,
  extra?: Record<string, string>,
): string {
  switch (kind) {
    case 'routine':
      return (prop(def, 'Type') ?? extra?.['type']) === 'function'
        ? `A stored function: code kept in the database that returns one value. Use it inside a query, like SELECT ${name}(…).`
        : `A stored procedure: code kept in the database that runs when called with CALL ${name}(…). It can read and change data and return result sets.`;
    case 'trigger': {
      const fires = prop(def, 'Fires') ?? '';
      const table = prop(def, 'Table') ?? extra?.['table'] ?? 'its table';
      return `A trigger: code the database runs by itself${fires ? ` ${fires.split(',')[0]?.toLowerCase()}` : ''} on ${table}, once for every affected row. Nobody calls it; changing rows is enough.`;
    }
    case 'event':
      return 'A scheduled event: code the database server runs by itself on a schedule, like a cron job inside MySQL. It only runs while the event scheduler is on.';
    case 'view':
      return 'A view: a saved SELECT that can be queried like a table.';
    default:
      return '';
  }
}

/** Read-only definition of a routine, trigger or event: what it is, when it runs, and its code. */
export function ObjectTab({
  sessionKey,
  engine,
  schema,
  name,
  kind,
  extra,
  onOpenTable,
  onOpenInQuery,
}: Props): React.JSX.Element {
  const [def, setDef] = useState<ObjectDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    rasql.session
      .describeObject(sessionKey, schema, kind, name)
      .then((d) => {
        if (!alive) return;
        setDef(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(stripIpc(e)));
    return () => {
      alive = false;
    };
  }, [sessionKey, schema, kind, name, version]);

  const copy = useCallback(async () => {
    if (!def?.ddl) return;
    await rasql.clipboard.writeText(def.ddl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [def]);

  const table = prop(def, 'Table') ?? extra?.['table'];
  const schedulerOff =
    kind === 'event' && /^(off|disabled)$/.test(prop(def, 'Event scheduler') ?? '');

  return (
    <div className="tab-body object-tab">
      <div className="tab-toolbar">
        <span className="object-tab-kind">{kindLabel(kind, extra)}</span>
        <strong>{name}</strong>
        <span className="toolbar-sep" />
        <button onClick={() => setVersion((v) => v + 1)} title="Load the definition again">
          Refresh
        </button>
        <button onClick={() => void copy()} disabled={!def?.ddl}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          onClick={() => def?.ddl && onOpenInQuery(def.ddl)}
          disabled={!def?.ddl}
          title="Open the definition in a new query tab, to adapt it or run it elsewhere"
        >
          Open in query tab
        </button>
        {kind === 'trigger' && table && (
          <button onClick={() => onOpenTable(table)}>Open table {table}</button>
        )}
      </div>
      <div className="object-tab-body">
        <p className="object-explain">{explain(kind, name, def, extra)}</p>
        {error && <div className="form-error">{error}</div>}
        {schedulerOff && (
          <div className="object-warning">
            The event scheduler is off on this server, so this event does not run. It is turned on
            with SET GLOBAL event_scheduler = ON, or event_scheduler=ON in the server configuration.
          </div>
        )}
        {def && def.properties.length > 0 && (
          <dl className="object-props">
            {def.properties.map((p) => (
              <div key={p.label}>
                <dt>{p.label}</dt>
                <dd>{p.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {def && !def.ddl && (
          <div className="hint">
            The server did not return the code. Seeing it needs the routine&apos;s definer account,
            or a privilege such as SHOW_ROUTINE on MySQL 8.
          </div>
        )}
        {def?.ddl && (
          <div className="object-ddl">
            <SqlEditor
              key={def.ddl}
              engine={engine}
              initialDoc={def.ddl}
              completion={null}
              readOnly
            />
          </div>
        )}
        {!def && !error && <div className="hint">Loading definition…</div>}
      </div>
    </div>
  );
}
