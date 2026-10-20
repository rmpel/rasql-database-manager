import { useCallback, useEffect, useState } from 'react';
import type {
  LocalAddonStatus,
  LocalSite,
  McpAccess,
  McpLocalAccess,
  PendingConnection,
} from '@shared/api';
import { MCP_ACCESS_OPTIONS } from '@shared/api';
import { rasql } from '../api';

interface Props {
  onPending: (pending: PendingConnection) => void;
  busy?: boolean;
}

/** Local's sites, read from its registry, plus the offer to install the Database-tab button. */
export function LocalWpSection({ onPending, busy }: Props): React.JSX.Element | null {
  const [status, setStatus] = useState<LocalAddonStatus | null>(null);
  const [sites, setSites] = useState<LocalSite[]>([]);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  // What agents may do per site (MCP.md section 1): Local sites have no form, so a gear sets it.
  const [access, setAccess] = useState<McpLocalAccess>({ defaultAccess: 'hidden', sites: {} });
  const [editing, setEditing] = useState<string | null>(null);
  const [presence, setPresence] = useState(false);

  useEffect(() => {
    const load = (): void => void rasql.mcp.localAccess().then(setAccess);
    load();
    void rasql.mcp.presence().then((p) => setPresence(p.available));
    return rasql.mcp.onChanged(load);
  }, []);

  const refresh = useCallback(() => {
    rasql.localwp
      .status()
      .then((s) => {
        setStatus(s);
        return s.localPresent ? rasql.localwp.sites() : [];
      })
      .then(setSites)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    return rasql.app.onFocus(refresh);
  }, [refresh]);

  if (!status?.localPresent) return null;

  const act = async (fn: () => Promise<LocalAddonStatus>, done: string): Promise<void> => {
    setWorking(true);
    setNote(null);
    try {
      setStatus(await fn());
      setNote({ kind: 'info', text: done });
    } catch (err) {
      setNote({
        kind: 'error',
        text:
          err instanceof Error
            ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
            : String(err),
      });
    } finally {
      setWorking(false);
    }
  };

  const open = async (site: LocalSite): Promise<void> => {
    onPending(await rasql.localwp.pendingFor(site));
  };

  return (
    <section className="local-section">
      <h2>LocalWP sites</h2>
      {status.bundledAvailable && (
        <div className="addon-banner">
          {!status.installed && (
            <>
              <span>Add an “Open in RaSQL” button to Local’s Database tab.</span>
              <button
                onClick={() =>
                  void act(
                    () => rasql.localwp.installAddon(),
                    'Installed. Restart Local to load it.',
                  )
                }
                disabled={working}
              >
                Install add-on
              </button>
            </>
          )}
          {status.installed && status.needsUpdate && (
            <>
              <span>
                Local add-on {status.installedVersion} installed, {status.bundledVersion} available.
              </span>
              <button
                onClick={() =>
                  void act(() => rasql.localwp.installAddon(), 'Updated. Restart Local to load it.')
                }
                disabled={working}
              >
                Update add-on
              </button>
            </>
          )}
          {status.installed && !status.needsUpdate && (
            <>
              <span>
                Local add-on {status.installedVersion} installed
                {status.enabled ? '' : ', disabled in Local'}.
              </span>
              <button
                onClick={() =>
                  void act(
                    () => rasql.localwp.uninstallAddon(),
                    'Removed. Restart Local to unload it.',
                  )
                }
                disabled={working}
              >
                Remove
              </button>
            </>
          )}
          {note && <div className={`addon-note ${note.kind}`}>{note.text}</div>}
        </div>
      )}
      <ul className="local-sites">
        {sites.map((s) => {
          const own = access.sites[s.id];
          const effective = own ?? access.defaultAccess;
          const label = (a: McpAccess): string =>
            MCP_ACCESS_OPTIONS.find((o) => o.value === a)?.label ?? a;
          return (
            <li key={s.id} className="local-site-row">
              <button
                className="local-site"
                onClick={() => void open(s)}
                disabled={busy}
                title={
                  s.running ? 'Running, connects over the socket' : 'Stopped, tries the TCP port'
                }
              >
                <span className={`env-dot ${s.running ? 'running' : 'stopped'}`} />
                <span className="local-site-name">{s.name}</span>
                <span className="local-site-domain">
                  {s.domain ?? ''}
                  {effective !== 'hidden' && (
                    <span className="mcp-badge"> · agents: {label(effective)}</span>
                  )}
                </span>
              </button>
              <button
                className="local-site-mcp"
                title="What AI agents may do with this site (MCP)"
                aria-expanded={editing === s.id}
                onClick={() => setEditing((e) => (e === s.id ? null : s.id))}
              >
                ⚙
              </button>
              {editing === s.id && (
                <label className="local-site-access">
                  Agents (MCP)
                  <select
                    value={own ?? 'default'}
                    onChange={(e) =>
                      void rasql.mcp
                        .setLocalAccess(
                          s.id,
                          e.target.value === 'default' ? null : (e.target.value as McpAccess),
                        )
                        .then(setAccess)
                    }
                  >
                    <option value="default">
                      Default for Local sites ({label(access.defaultAccess)})
                    </option>
                    {MCP_ACCESS_OPTIONS.map((o) => (
                      <option
                        key={o.value}
                        value={o.value}
                        disabled={o.value === 'secure' && !presence && own !== 'secure'}
                      >
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    {MCP_ACCESS_OPTIONS.find((o) => o.value === effective)?.help}
                  </span>
                </label>
              )}
            </li>
          );
        })}
        {sites.length === 0 && <li className="hint">No sites in Local yet.</li>}
      </ul>
    </section>
  );
}
