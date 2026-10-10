import { useEffect, useMemo, useState } from 'react';
import type { DriverManifest } from '@rasql/driver-protocol';
import type {
  ConnectionDefinition,
  OpenSessionRequest,
  OpenSessionResult,
  PendingConnection,
} from '@shared/api';
import { ENVIRONMENT_COLORS } from '@shared/api';
import { rasql } from '../api';
import { ConnectionForm, type ConnectionFormValue } from './ConnectionForm';
import { LocalWpSection } from './LocalWpSection';

interface Props {
  drivers: DriverManifest[];
  pending: PendingConnection | null;
  onPending: (pending: PendingConnection) => void;
  onOpened: (def: ConnectionDefinition, result: OpenSessionResult) => void;
}

export function Launcher({ drivers, pending, onPending, onOpened }: Props): React.JSX.Element {
  const [saved, setSaved] = useState<ConnectionDefinition[]>([]);
  const [editingState, setEditing] = useState<ConnectionDefinition | PendingConnection | null>(
    null,
  );
  const [showFormState, setShowForm] = useState(false);
  const editing = editingState ?? pending;
  const showForm = showFormState || pending !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askPassword, setAskPassword] = useState<ConnectionDefinition | null>(null);
  const [typedPassword, setTypedPassword] = useState('');

  const reload = (): void => void rasql.connections.list().then(setSaved);
  useEffect(reload, []);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const toggleSection = (key: string): void =>
    setCollapsed((c) => {
      const next = c.includes(key) ? c.filter((x) => x !== key) : [...c, key];
      writeCollapsed(next);
      return next;
    });
  const sections = useMemo(() => sectionsFor(saved, search), [saved, search]);
  const groupNames = useMemo(
    () =>
      [...new Set(saved.map((c) => c.group?.trim()).filter((g): g is string => Boolean(g)))].sort(),
    [saved],
  );

  const keychainRef = (id: string): ConnectionDefinition['credentials'] => ({
    password: { provider: 'keychain', account: `rasql:${id}:password` },
  });

  /** Persist the definition and, when asked, its password. Returns the stored definition. */
  const persist = async (value: ConnectionFormValue): Promise<ConnectionDefinition> => {
    let def = await rasql.connections.save(value.definition);
    if (value.savePassword && value.password && def.transport !== 'file') {
      await rasql.connections.setPassword(def.id, value.password);
      def = await rasql.connections.save({
        ...def,
        credentials: { ...def.credentials, ...keychainRef(def.id) },
      });
    }
    if (value.saveSshSecrets && def.ssh?.length) {
      const credentials = { ...def.credentials };
      if (value.sshPassword) {
        await rasql.connections.setSecret(def.id, 'ssh-password', value.sshPassword);
        credentials.sshPassword = { provider: 'keychain', account: `rasql:${def.id}:ssh-password` };
      }
      if (value.sshPassphrase) {
        await rasql.connections.setSecret(def.id, 'ssh-passphrase', value.sshPassphrase);
        credentials.sshPassphrase = {
          provider: 'keychain',
          account: `rasql:${def.id}:ssh-passphrase`,
        };
      }
      if (value.sshPassword || value.sshPassphrase)
        def = await rasql.connections.save({ ...def, credentials });
    }
    reload();
    return def;
  };

  const connect = async (value: ConnectionFormValue): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const def = value.savePassword ? await persist(value) : value.definition;
      const req: OpenSessionRequest = { definition: def, savePassword: false };
      if (value.password) req.password = value.password;
      if (value.sshPassword) req.sshPassword = value.sshPassword;
      if (value.sshPassphrase) req.sshPassphrase = value.sshPassphrase;
      const result = await rasql.session.open(req);
      // The session opened in its own window; the manager returns to its list.
      setShowForm(false);
      setEditing(null);
      onOpened(def, result);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
          : String(err),
      );
      setShowForm(true);
      setEditing(value.definition);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pending?.autoConnect || !pending.definition.name) return;
    const timer = setTimeout(() => {
      const value: ConnectionFormValue = {
        definition: { ...emptyBits(), ...pending.definition } as ConnectionDefinition,
        password: pending.password ?? '',
        savePassword: false,
      };
      void connect(value);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const save = async (value: ConnectionFormValue): Promise<void> => {
    await persist(value);
    setShowForm(false);
    setEditing(null);
  };

  const openSaved = async (def: ConnectionDefinition): Promise<void> => {
    if (def.transport !== 'file' && !(await rasql.connections.hasStoredPassword(def.id))) {
      setAskPassword(def);
      return;
    }
    await connect({ definition: def, password: '', savePassword: false });
  };

  const remove = async (def: ConnectionDefinition): Promise<void> => {
    const ok = await rasql.dialog.confirm({
      title: `Delete the connection “${def.name}”?`,
      message: 'Its saved password is removed from the keychain too. Databases are not touched.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await rasql.connections.remove(def.id);
    reload();
  };

  const toggleFavorite = async (def: ConnectionDefinition): Promise<void> => {
    await rasql.connections.save({ ...def, favorite: !def.favorite });
    reload();
  };

  return (
    <div className="launcher">
      <aside className="launcher-list">
        <h1>RaSQL</h1>
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setError(null);
            setShowForm(true);
          }}
        >
          New connection
        </button>
        {saved.length > 4 && (
          <input
            className="launcher-search"
            type="search"
            placeholder="Search connections"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <ul>
          {sections.map((section) => {
            // While searching every section is open; otherwise the user decides.
            const open = Boolean(search.trim()) || !collapsed.includes(section.key);
            return (
              <li key={section.key} className="connection-section">
                {section.title && (
                  <button
                    className="connection-section-head"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={open}
                  >
                    <span className="caret">{open ? '▾' : '▸'}</span>
                    {section.title}
                    <span className="count">{section.items.length}</span>
                  </button>
                )}
                {open && (
                  <ul>
                    {section.items.map((c) => (
                      <li key={c.id}>
                        <button
                          className="connection-item"
                          onClick={() => void openSaved(c)}
                          disabled={busy}
                        >
                          <span
                            className="env-dot"
                            style={{ background: c.color ?? ENVIRONMENT_COLORS[c.environment] }}
                          />
                          <span className="connection-name">{c.name}</span>
                          <span className="connection-meta">{describe(c)}</span>
                        </button>
                        <button
                          className={`connection-star${c.favorite ? ' on' : ''}`}
                          title={c.favorite ? 'Remove from favorites' : 'Add to favorites'}
                          aria-pressed={Boolean(c.favorite)}
                          onClick={() => void toggleFavorite(c)}
                        >
                          {c.favorite ? '★' : '☆'}
                        </button>
                        <span className="connection-actions">
                          <button
                            title="Edit"
                            onClick={() => {
                              setEditing(c);
                              setError(null);
                              setShowForm(true);
                            }}
                          >
                            ✎
                          </button>
                          <button title="Delete" onClick={() => void remove(c)}>
                            ✕
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {saved.length === 0 && <li className="hint">No saved connections yet.</li>}
          {saved.length > 0 && sections.length === 0 && <li className="hint">No matches.</li>}
        </ul>
        <LocalWpSection onPending={onPending} busy={busy} />
        <footer title={`Built ${rasql.app.builtAt} from commit ${rasql.app.commit}`}>
          v{rasql.app.version} · {rasql.app.commit} ·{' '}
          {rasql.app.builtAt.slice(0, 16).replace('T', ' ')} UTC
        </footer>
      </aside>
      <main className="launcher-main">
        {showForm ? (
          <ConnectionForm
            key={editing ? ('definition' in editing ? 'pending' : editing.id) : 'new'}
            drivers={drivers}
            initial={editing}
            onConnect={(v) => void connect(v)}
            onSave={(v) => void save(v)}
            busy={busy}
            error={error}
            groups={groupNames}
          />
        ) : (
          <div className="launcher-empty">
            <p>Pick a saved connection, create a new one, or drop a SQLite file on the window.</p>
          </div>
        )}
        {askPassword && (
          <div className="modal-backdrop">
            <form
              className="modal"
              onSubmit={(e) => {
                e.preventDefault();
                const def = askPassword;
                setAskPassword(null);
                void connect({ definition: def, password: typedPassword, savePassword: true });
                setTypedPassword('');
              }}
            >
              <h2>Password for {askPassword.name}</h2>
              <input
                autoFocus
                type="password"
                value={typedPassword}
                onChange={(e) => setTypedPassword(e.target.value)}
              />
              <div className="form-actions">
                <button type="button" onClick={() => setAskPassword(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary">
                  Connect and remember
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}

function describe(c: ConnectionDefinition): string {
  if (c.transport === 'file') return c.filePath ?? '';
  if (c.transport === 'socket') return `${c.user ?? ''}@${c.socketPath ?? ''}`;
  return `${c.user ?? ''}@${c.host ?? ''}${c.port ? `:${c.port}` : ''}${c.database ? `/${c.database}` : ''}`;
}

function emptyBits(): Partial<ConnectionDefinition> {
  return {
    id: '',
    name: '',
    environment: 'local',
    readOnly: false,
    options: {},
    credentials: {},
    createdAt: '',
    updatedAt: '',
  };
}

interface Section {
  key: string;
  /** Null when there is nothing to tell apart: one plain list without a heading. */
  title: string | null;
  items: ConnectionDefinition[];
}

const byName = (a: ConnectionDefinition, b: ConnectionDefinition): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Favorites first, then one section per group by name, then the connections without a group. */
export function sectionsFor(all: ConnectionDefinition[], search: string): Section[] {
  const term = search.trim().toLowerCase();
  const list = term
    ? all.filter((c) =>
        [c.name, c.group, c.host, c.database, c.socketPath, c.filePath, c.user]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term)),
      )
    : all;
  const favorites = list.filter((c) => c.favorite).sort(byName);
  const rest = list.filter((c) => !c.favorite);
  const groups = new Map<string, ConnectionDefinition[]>();
  const ungrouped: ConnectionDefinition[] = [];
  for (const c of rest) {
    const g = c.group?.trim();
    if (!g) ungrouped.push(c);
    else groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const sections: Section[] = [];
  if (favorites.length) sections.push({ key: 'favorites', title: 'Favorites', items: favorites });
  for (const g of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    sections.push({ key: `group:${g}`, title: g, items: (groups.get(g) ?? []).sort(byName) });
  }
  if (ungrouped.length) {
    sections.push({
      key: 'ungrouped',
      title: sections.length ? 'Other connections' : null,
      items: ungrouped.sort(byName),
    });
  }
  return sections;
}

const COLLAPSED_KEY = 'rasql.launcher.collapsed';

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeCollapsed(keys: string[]): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(keys));
  } catch {
    /* storage unavailable; collapsing still works for this session */
  }
}
