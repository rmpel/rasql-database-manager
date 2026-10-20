import { useCallback, useEffect, useState } from 'react';
import type {
  ConnectionDefinition,
  LocalSite,
  McpAccess,
  McpAuditRecord,
  McpLocalAccess,
  McpStatus,
} from '@shared/api';
import { MCP_ACCESS_OPTIONS, mcpAccessOf } from '@shared/api';
import { rasql } from '../api';

/** Quote one argument for a POSIX shell when it needs it. */
const sh = (arg: string): string =>
  /^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

function Copy({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void rasql.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

const when = (iso?: string): string => (iso ? new Date(iso).toLocaleString() : '—');

/** MCP setup, the clients the user decided on, and the audit log (MCP.md sections 7 and 8). */
export function McpWindow(): React.JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [connections, setConnections] = useState<ConnectionDefinition[]>([]);
  const [audit, setAudit] = useState<McpAuditRecord[]>([]);
  const [local, setLocal] = useState<McpLocalAccess | null>(null);
  const [localSites, setLocalSites] = useState<LocalSite[]>([]);
  const [presence, setPresence] = useState(false);
  const [filter, setFilter] = useState<{ client?: string; connectionId?: string }>({});
  const [token, setToken] = useState<string | null>(null);
  const [rowLimit, setRowLimit] = useState('');
  const [port, setPort] = useState('');

  const load = useCallback((): void => {
    void rasql.mcp.status().then((s) => {
      setStatus(s);
      setRowLimit(String(s.rowLimit));
      setPort(String(s.http.port));
    });
    void rasql.connections.list().then(setConnections);
    void rasql.mcp.localAccess().then(setLocal);
    void rasql.localwp
      .sites()
      .then(setLocalSites)
      .catch(() => setLocalSites([]));
    void rasql.mcp.presence().then((p) => setPresence(p.available));
    void rasql.mcp.audit({ ...filter, limit: 300 }).then(setAudit);
  }, [filter]);

  useEffect(() => {
    document.title = 'RaSQL — MCP';
    load();
    const offChanged = rasql.mcp.onChanged(load);
    const offFocus = rasql.app.onFocus(load);
    return () => {
      offChanged();
      offFocus();
    };
  }, [load]);

  if (!status) return <div className="hint centered">Loading…</div>;

  const claudeCommand = ['claude', 'mcp', 'add', 'rasql', '--', ...status.command]
    .map(sh)
    .join(' ');
  const jsonConfig = JSON.stringify(
    { mcpServers: { rasql: { command: status.command[0], args: status.command.slice(1) } } },
    null,
    2,
  );
  const visible = connections.filter((c) => mcpAccessOf(c) !== 'hidden');
  const localVisible = local
    ? localSites
        .map((s) => ({ site: s, access: local.sites[s.id] ?? local.defaultAccess }))
        .filter((x) => x.access !== 'hidden')
    : [];
  const clientNames = [
    ...new Set([...status.clients.map((c) => c.name), ...audit.map((a) => a.client)]),
  ];

  const revealToken = async (): Promise<void> => setToken(await rasql.mcp.httpToken());

  return (
    <div className="mcp-window">
      <header>
        <h1>MCP server</h1>
        <p className="hint">
          AI agents such as Claude Code reach your databases through RaSQL. They see only the
          connections you open up, each with the MCP setting in its connection form.
        </p>
      </header>

      <section>
        <h2>Connect a client</h2>
        <p>
          Claude Code <span className={`status-dot ${status.socketListening ? 'on' : 'off'}`} />
          {status.socketListening ? 'ready' : `not available: ${status.socketError ?? 'starting'}`}
        </p>
        <div className="mcp-code">
          <code>{claudeCommand}</code>
          <Copy text={claudeCommand} />
        </div>
        <p>Other clients (Claude Desktop, editors) take this in their MCP configuration:</p>
        <div className="mcp-code">
          <pre>{jsonConfig}</pre>
          <Copy text={jsonConfig} />
        </div>
        <p className="hint">
          The command relays to this running app over <code>{status.socketPath}</code> and starts
          RaSQL when it is not running. Each new client asks for your permission once.
        </p>
      </section>

      <section>
        <h2>HTTP</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={status.http.enabled}
            onChange={(e) =>
              void rasql.mcp.setOptions({ httpEnabled: e.target.checked }).then(setStatus)
            }
          />
          Accept clients over HTTP on 127.0.0.1, for clients that cannot start a command
        </label>
        <div className="form-row">
          <label className="narrow">
            Port
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onBlur={() => void rasql.mcp.setOptions({ httpPort: Number(port) }).then(setStatus)}
            />
          </label>
        </div>
        {status.http.enabled && (
          <>
            <p>
              <span className={`status-dot ${status.http.listening ? 'on' : 'off'}`} />
              {status.http.listening
                ? status.http.url
                : `not listening: ${status.http.error ?? 'starting'}`}
            </p>
            <div className="mcp-code">
              <code>
                {token ? `Authorization: Bearer ${token}` : 'Authorization: Bearer ••••••••'}
              </code>
              {token ? (
                <Copy text={token} />
              ) : (
                <button onClick={() => void revealToken()}>Show token</button>
              )}
              <button
                onClick={() =>
                  void rasql.dialog
                    .confirm({
                      title: 'New token',
                      message: 'Make a new token?',
                      detail: 'Clients that use the old one can no longer connect.',
                      confirmLabel: 'Make new token',
                    })
                    .then((ok) => (ok ? rasql.mcp.regenerateHttpToken().then(setToken) : undefined))
                }
              >
                New token
              </button>
            </div>
            {token && (
              <div className="mcp-code">
                <code>
                  {`claude mcp add --transport http rasql ${status.http.url} --header ${sh(`Authorization: Bearer ${token}`)}`}
                </code>
                <Copy
                  text={`claude mcp add --transport http rasql ${status.http.url} --header ${sh(`Authorization: Bearer ${token}`)}`}
                />
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <h2>Limits</h2>
        <div className="form-row">
          <label className="narrow">
            Rows per read
            <input
              type="number"
              min={1}
              value={rowLimit}
              onChange={(e) => setRowLimit(e.target.value)}
              onBlur={() =>
                void rasql.mcp.setOptions({ rowLimit: Number(rowLimit) }).then(setStatus)
              }
            />
          </label>
          <p className="hint grow">The most rows a query or sample returns to an agent.</p>
        </div>
      </section>

      <section>
        <h2>Connections agents see</h2>
        {visible.length === 0 && localVisible.length === 0 ? (
          <p className="hint">
            None. Set the MCP setting in a connection’s form, or with the ⚙ next to a LocalWP site,
            to open it up.
          </p>
        ) : (
          <table className="mcp-table">
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.database ?? <em>no database: agents see no data</em>}</td>
                  <td>{MCP_ACCESS_OPTIONS.find((o) => o.value === mcpAccessOf(c))?.label}</td>
                </tr>
              ))}
              {localVisible.map(({ site, access }) => (
                <tr key={`localwp:${site.id}`}>
                  <td>
                    {site.name} <span className="hint">LocalWP</span>
                  </td>
                  <td>{site.database}</td>
                  <td>{MCP_ACCESS_OPTIONS.find((o) => o.value === access)?.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {local && localSites.length > 0 && (
          <div className="form-row">
            <label>
              Default for LocalWP sites
              <select
                value={local.defaultAccess}
                onChange={(e) =>
                  void rasql.mcp.setLocalDefault(e.target.value as McpAccess).then(setLocal)
                }
              >
                {MCP_ACCESS_OPTIONS.map((o) => (
                  <option
                    key={o.value}
                    value={o.value}
                    disabled={o.value === 'secure' && !presence && local.defaultAccess !== 'secure'}
                  >
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint grow">
              Applies to every Local site without a setting of its own (⚙ next to the site in the
              connection manager). Local sites are always local development databases.
            </p>
          </div>
        )}
      </section>

      <section>
        <h2>
          Clients
          {status.clients.some((c) => c.status === 'allowed') && (
            <button
              className="danger"
              onClick={() =>
                void rasql.dialog
                  .confirm({
                    title: 'Revoke all',
                    message: 'Revoke access for every agent?',
                    detail:
                      'Connected agents are disconnected and must ask again. Open prompts are denied.',
                    confirmLabel: 'Revoke all',
                    danger: true,
                  })
                  .then((ok) => (ok ? rasql.mcp.revoke().then(setStatus) : undefined))
              }
            >
              Revoke all
            </button>
          )}
        </h2>
        {status.clients.length === 0 ? (
          <p className="hint">No client has asked yet.</p>
        ) : (
          <table className="mcp-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Access</th>
                <th>Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.clients.map((c) => (
                <tr key={c.name}>
                  <td>
                    <span
                      className={`status-dot ${c.connected ? 'on' : 'off'}`}
                      title={c.connected ? 'Connected' : 'Not connected'}
                    />
                    {c.title ?? c.name}
                    {c.version ? <span className="hint"> {c.version}</span> : null}
                  </td>
                  <td>{c.status === 'allowed' ? 'Allowed' : 'Denied'}</td>
                  <td>{when(c.lastSeen ?? c.decidedAt)}</td>
                  <td className="actions">
                    {c.status === 'allowed' ? (
                      <button onClick={() => void rasql.mcp.revoke(c.name).then(setStatus)}>
                        Revoke
                      </button>
                    ) : (
                      <>
                        <button onClick={() => void rasql.mcp.allowClient(c.name).then(setStatus)}>
                          Allow
                        </button>
                        <button
                          title="Ask again on its next contact"
                          onClick={() => void rasql.mcp.forgetClient(c.name).then(setStatus)}
                        >
                          Forget
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          Audit log
          <span className="spacer" />
          <select
            value={filter.client ?? ''}
            onChange={(e) =>
              setFilter((f) => ({
                ...withoutKey(f, 'client'),
                ...(e.target.value ? { client: e.target.value } : {}),
              }))
            }
          >
            <option value="">Every client</option>
            {clientNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select
            value={filter.connectionId ?? ''}
            onChange={(e) =>
              setFilter((f) => ({
                ...withoutKey(f, 'connectionId'),
                ...(e.target.value ? { connectionId: e.target.value } : {}),
              }))
            }
          >
            <option value="">Every connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              void rasql.dialog
                .confirm({
                  title: 'Clear log',
                  message: 'Clear the audit log?',
                  confirmLabel: 'Clear',
                  danger: true,
                })
                .then((ok) => (ok ? rasql.mcp.clearAudit().then(load) : undefined))
            }
          >
            Clear
          </button>
        </h2>
        {audit.length === 0 ? (
          <p className="hint">Nothing yet.</p>
        ) : (
          <table className="mcp-table mcp-audit">
            <thead>
              <tr>
                <th>When</th>
                <th>Client</th>
                <th>Connection</th>
                <th>Action</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className={`outcome-${a.outcome}`}>
                  <td>{when(a.at)}</td>
                  <td>{a.client}</td>
                  <td>{a.connectionName ?? ''}</td>
                  <td>
                    {a.tool}
                    {a.sql?.length ? (
                      <details>
                        <summary>
                          {a.sql.length === 1 ? 'SQL' : `${a.sql.length} statements`}
                        </summary>
                        <pre>{a.sql.join(';\n')}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td>
                    <span className={`chip ${a.outcome}`}>{a.outcome}</span> {a.detail ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function withoutKey<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _dropped, ...rest } = o;
  return rest;
}
