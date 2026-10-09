import { useEffect, useState } from 'react';
import type { DbObject } from '@rasql/driver-protocol';
import type { ConnectionDefinition, OpenSessionResult } from '@shared/api';
import { ENVIRONMENT_COLORS } from '@shared/api';
import { rasql } from '../api';
import { Sidebar } from './Sidebar';
import { TableTab } from './TableTab';
import { QueryTab } from './QueryTab';

type Tab =
  | {
      id: string;
      kind: 'table';
      schema: string;
      table: string;
      objectKind: 'table' | 'view';
      view: 'content' | 'structure';
      generation: number;
    }
  | { id: string; kind: 'query'; title: string };

interface Props {
  definition: ConnectionDefinition;
  session: OpenSessionResult;
  onDisconnect: () => void;
}

const tableTabId = (o: { schema: string; name: string }): string => `t:${o.schema}.${o.name}`;

export function Workspace({ definition, session, onDisconnect }: Props): React.JSX.Element {
  const [schema, setSchema] = useState<string | null>(definition.database ?? null);
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'q1', kind: 'query', title: 'Query 1' }]);
  const [active, setActive] = useState('q1');
  const color = definition.color ?? ENVIRONMENT_COLORS[definition.environment];

  useEffect(() => {
    document.title = `${definition.name} — RaSQL`;
    return () => {
      document.title = 'RaSQL';
    };
  }, [definition.name]);

  const newQueryTab = (): void => {
    const n = tabs.filter((t) => t.kind === 'query').length + 1;
    const tab: Tab = { id: `q${Date.now()}`, kind: 'query', title: `Query ${n}` };
    setTabs((t) => [...t, tab]);
    setActive(tab.id);
  };

  const openObject = (obj: DbObject, view: 'content' | 'structure'): void => {
    const id = tableTabId(obj);
    setTabs((t) => {
      const existing = t.find((x) => x.id === id);
      if (existing) return t.map((x) => (x.id === id && x.kind === 'table' ? { ...x, view } : x));
      return [
        ...t,
        {
          id,
          kind: 'table',
          schema: obj.schema,
          table: obj.name,
          objectKind: obj.kind === 'view' ? 'view' : 'table',
          view,
          generation: 0,
        },
      ];
    });
    setActive(id);
  };

  const closeTab = (id: string): void => {
    setTabs((t) => {
      const next = t.filter((x) => x.id !== id);
      if (active === id && next.length) setActive(next[next.length - 1]!.id);
      return next;
    });
  };

  /** Remount the tab so it reloads from scratch, used after truncate or an external refresh request. */
  const bumpTab = (obj: DbObject): void => {
    const id = tableTabId(obj);
    setTabs((t) =>
      t.map((x) =>
        x.id === id && x.kind === 'table' ? { ...x, generation: x.generation + 1 } : x,
      ),
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault();
        newQueryTab();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'w' && tabs.length > 1) {
        e.preventDefault();
        closeTab(active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, active]);

  const disconnect = async (): Promise<void> => {
    await rasql.session.close(session.sessionKey);
    onDisconnect();
  };

  return (
    <div className="workspace" style={{ ['--env-color' as string]: color }}>
      <header className="titlebar">
        <span className="env-dot" style={{ background: color }} />
        <strong>{definition.name}</strong>
        <span className="titlebar-meta">
          {session.info.engineName} {session.info.version}
          {session.info.readOnly ? ' · read-only' : ''}
          {definition.environment === 'production' ? ' · PRODUCTION' : ''}
        </span>
        <span className="spacer" />
        <button onClick={newQueryTab} title="New query tab (⌘T)">
          + Query
        </button>
        <button onClick={() => void disconnect()}>Disconnect</button>
      </header>
      <div className="workspace-body">
        <Sidebar
          sessionKey={session.sessionKey}
          engine={session.info.engine}
          schema={schema}
          onSchemaChange={setSchema}
          onOpenObject={openObject}
          onObjectDropped={(obj) => closeTab(tableTabId(obj))}
          onRefreshObject={bumpTab}
        />
        <section className="tabs">
          <nav className="tab-strip">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`tab ${t.id === active ? 'active' : ''}`}
                onClick={() => setActive(t.id)}
              >
                {t.kind === 'table' ? t.table : t.title}
                {tabs.length > 1 && (
                  <span
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
          </nav>
          {tabs.map((t) => (
            <div key={t.id} className="tab-pane" hidden={t.id !== active}>
              {t.kind === 'table' ? (
                <TableTab
                  key={t.generation}
                  sessionKey={session.sessionKey}
                  schema={t.schema}
                  table={t.table}
                  kind={t.objectKind}
                  view={t.view}
                  onViewChange={(view) =>
                    setTabs((all) =>
                      all.map((x) => (x.id === t.id && x.kind === 'table' ? { ...x, view } : x)),
                    )
                  }
                  active={t.id === active}
                />
              ) : (
                <QueryTab
                  sessionKey={session.sessionKey}
                  connectionKey={definition.id || definition.name}
                  engine={session.info.engine}
                />
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
