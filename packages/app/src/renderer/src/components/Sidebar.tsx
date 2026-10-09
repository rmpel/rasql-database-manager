import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DbObject, SchemaInfo } from '@rasql/driver-protocol';
import { rasql } from '../api';

interface Props {
  sessionKey: string;
  engine: string;
  schema: string | null;
  onSchemaChange: (schema: string) => void;
  onOpenObject: (obj: DbObject, view: 'content' | 'structure') => void;
  onObjectDropped: (obj: DbObject) => void;
  onRefreshObject: (obj: DbObject) => void;
}

export function Sidebar({
  sessionKey,
  engine,
  schema,
  onSchemaChange,
  onOpenObject,
  onObjectDropped,
  onRefreshObject,
}: Props): React.JSX.Element {
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rasql.session
      .listSchemas(sessionKey)
      .then((list) => {
        setSchemas(list);
        if (!schema) {
          const current = list.find((s) => s.isCurrent) ?? list.find((s) => !s.isSystem) ?? list[0];
          if (current) onSchemaChange(current.name);
        }
      })
      .catch((e: unknown) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const reload = useCallback(() => {
    if (!schema) return;
    rasql.session
      .listObjects(sessionKey, schema)
      .then(setObjects)
      .catch((e: unknown) => setError(String(e)));
  }, [sessionKey, schema]);

  useEffect(reload, [reload]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? objects.filter((o) => o.name.toLowerCase().includes(q)) : objects;
    const order = { table: 0, view: 1, routine: 2, trigger: 3, event: 4, sequence: 5 };
    return [...list].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }, [objects, filter]);

  const quoted = async (o: DbObject): Promise<string> => {
    const q = (name: string): Promise<string> =>
      rasql.session.dialect(sessionKey, 'quoteIdentifier', [name]) as Promise<string>;
    return `${await q(o.schema)}.${await q(o.name)}`;
  };

  const fail = (err: unknown): void =>
    setError(
      err instanceof Error
        ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
        : String(err),
    );

  const contextMenu = async (e: React.MouseEvent, o: DbObject): Promise<void> => {
    e.preventDefault();
    if (o.kind !== 'table' && o.kind !== 'view') return;
    const action = await rasql.menu.tableContext({ schema: o.schema, table: o.name, kind: o.kind });
    if (!action) return;
    try {
      switch (action) {
        case 'open':
          onOpenObject(o, 'content');
          return;
        case 'structure':
          onOpenObject(o, 'structure');
          return;
        case 'refresh':
          reload();
          onRefreshObject(o);
          return;
        case 'copy-name':
          await rasql.clipboard.writeText(o.name);
          return;
        case 'copy-qualified':
          await rasql.clipboard.writeText(await quoted(o));
          return;
        case 'copy-select': {
          const sql = (await rasql.session.dialect(sessionKey, 'buildSelect', [
            { schema: o.schema, name: o.name },
            { limit: 100 },
          ])) as string;
          await rasql.clipboard.writeText(`${sql};`);
          return;
        }
        case 'copy-create': {
          const def = await rasql.session.describeTable(sessionKey, o.schema, o.name);
          await rasql.clipboard.writeText(def.ddl ? `${def.ddl};` : '');
          return;
        }
        case 'truncate': {
          const name = await quoted(o);
          const sql = engine === 'sqlite' ? `DELETE FROM ${name}` : `TRUNCATE TABLE ${name}`;
          const ok = await rasql.dialog.confirm({
            title: `Truncate ${o.name}?`,
            message: `Every row in ${o.name} will be deleted. This cannot be undone.`,
            detail: sql,
            confirmLabel: 'Truncate',
            danger: true,
          });
          if (!ok) return;
          await rasql.session.exec(sessionKey, sql);
          reload();
          onRefreshObject(o);
          return;
        }
        case 'drop': {
          const name = await quoted(o);
          const sql = `DROP ${o.kind === 'view' ? 'VIEW' : 'TABLE'} ${name}`;
          const ok = await rasql.dialog.confirm({
            title: `Drop ${o.kind} ${o.name}?`,
            message: `${o.name} and all its data will be gone. This cannot be undone.`,
            detail: sql,
            confirmLabel: 'Drop',
            danger: true,
          });
          if (!ok) return;
          await rasql.session.exec(sessionKey, sql);
          reload();
          onObjectDropped(o);
          return;
        }
      }
    } catch (err) {
      fail(err);
    }
  };

  return (
    <aside className="sidebar">
      <select
        className="schema-select"
        value={schema ?? ''}
        onChange={(e) => onSchemaChange(e.target.value)}
      >
        {schemas.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        className="sidebar-filter"
        placeholder="Filter objects"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {error && (
        <div className="form-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <ul className="object-list">
        {shown.map((o) => (
          <li key={`${o.kind}:${o.name}`}>
            <button
              className={`object object-${o.kind}`}
              onClick={() => onOpenObject(o, 'content')}
              onContextMenu={(e) => void contextMenu(e, o)}
              disabled={o.kind !== 'table' && o.kind !== 'view'}
              title={o.comment ?? o.kind}
            >
              <span className="object-kind">
                {o.kind === 'table' ? 'T' : o.kind === 'view' ? 'V' : o.kind[0]?.toUpperCase()}
              </span>
              <span className="object-name">{o.name}</span>
              {o.rowEstimate !== undefined && (
                <span className="object-rows">{o.rowEstimate.toLocaleString()}</span>
              )}
            </button>
          </li>
        ))}
        {schema && objects.length === 0 && !error && (
          <li className="hint">No objects in {schema}</li>
        )}
      </ul>
    </aside>
  );
}
