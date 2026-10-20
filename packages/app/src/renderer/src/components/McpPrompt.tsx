import { useEffect, useState } from 'react';
import type {
  ChangeSetSummary,
  ClientInfo,
  McpPrompt as Prompt,
  McpPromptAnswer,
  McpReview,
} from '@shared/api';
import { rasql } from '../api';

const who = (c: ClientInfo): string => c.title || c.name;

/** "2.4 million", "120". */
function rows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} million`;
  if (n >= 10_000) return `${Math.round(n / 1000)} thousand`;
  return String(n);
}

function useCountdown(until: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** One agent prompt in a window of its own: a first contact, a new connection or a change set. */
/** A prompt ignores clicks and keys this long after it appears, so input meant elsewhere cannot answer it. */
const ARMING_MS = 1000;

export function McpPrompt({ id }: { id: string }): React.JSX.Element {
  const [prompt, setPrompt] = useState<Prompt | null | undefined>(undefined);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setArmed(true);
      // Tests wait for this before clicking.
      document.body.dataset['armed'] = 'true';
    }, ARMING_MS);
    return () => clearTimeout(t);
  }, [id]);

  useEffect(() => {
    const load = (): void => void rasql.mcp.prompt(id).then(setPrompt);
    load();
    return rasql.mcp.onChanged(load);
  }, [id]);

  useEffect(() => {
    if (!prompt) return;
    document.title =
      prompt.kind === 'commit'
        ? `${who(prompt.client)} wants to commit changes`
        : prompt.kind === 'connection'
          ? `${who(prompt.client)} wants to add a connection`
          : `${who(prompt.client)} wants to use RaSQL`;
  }, [prompt]);

  if (prompt === undefined) return <div className="hint centered">Loading…</div>;
  if (prompt === null)
    return (
      <div className="hint centered">
        This request was answered or expired.{' '}
        <button onClick={() => void rasql.app.closeWindow()}>Close</button>
      </div>
    );

  /** Rejects with the reason when main refuses the answer, e.g. the OS did not confirm the user. */
  const answer = async (a: McpPromptAnswer): Promise<void> => {
    if (armed) await rasql.mcp.answer(id, a);
  };

  if (prompt.kind === 'client')
    return (
      <div className="mcp-prompt">
        <h1>
          <strong>{who(prompt.client)}</strong> wants to use RaSQL
        </h1>
        <p className="mcp-prompt-meta">
          MCP client “{prompt.client.name}”
          {prompt.client.version ? ` version ${prompt.client.version}` : ''}
        </p>
        <p>
          If you allow it, it sees only the connections you open up for agents, each with the MCP
          setting in its connection form. Every connection starts Hidden. You can revoke access at
          any time under File › MCP Server.
        </p>
        <div className="form-actions">
          <button onClick={() => void answer({ decision: 'deny' })}>Deny</button>
          <button className="primary" onClick={() => void answer({ decision: 'allow' })}>
            Allow
          </button>
        </div>
      </div>
    );

  if (prompt.kind === 'connection') {
    const c = prompt.connection;
    return (
      <div className="mcp-prompt">
        <h1>
          <strong>{who(prompt.client)}</strong> wants to add the connection <code>{c.name}</code>
        </h1>
        <table className="mcp-facts">
          <tbody>
            <tr>
              <th>Driver</th>
              <td>{c.driver}</td>
            </tr>
            <tr>
              <th>
                {c.transport === 'file' ? 'File' : c.transport === 'socket' ? 'Socket' : 'Server'}
              </th>
              <td>
                <code>{c.target}</code>
              </td>
            </tr>
            {c.user && (
              <tr>
                <th>User</th>
                <td>{c.user}</td>
              </tr>
            )}
            <tr>
              <th>Database</th>
              <td>{c.database ?? <em>none: agents see no data until you fill one in</em>}</td>
            </tr>
            <tr>
              <th>Environment</th>
              <td>
                {c.environment}
                {c.readOnly ? ', read-only' : ''}
              </td>
            </tr>
            <tr>
              <th>Password</th>
              <td>
                {c.hasPassword
                  ? 'Goes straight to the keychain; agents can never read it back'
                  : 'None'}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mcp-prompt-meta">
          The connection starts at {c.readOnly ? 'Read-only' : 'Ask'} for agents: every change waits
          for you.
        </p>
        <div className="form-actions">
          <button onClick={() => void answer({ decision: 'deny' })}>Don’t add</button>
          <button className="primary" onClick={() => void answer({ decision: 'allow' })}>
            Add connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <CommitPrompt
      id={id}
      client={prompt.client}
      changeSet={prompt.changeSet}
      expiresAt={prompt.expiresAt}
      secure={prompt.secure}
      confirmWith={prompt.confirmWith}
      answer={answer}
    />
  );
}

function CommitPrompt({
  client,
  changeSet: cs,
  expiresAt,
  secure,
  confirmWith,
  answer,
}: {
  id: string;
  client: ClientInfo;
  changeSet: ChangeSetSummary;
  expiresAt: string;
  secure: boolean;
  confirmWith: string;
  answer: (a: McpPromptAnswer) => Promise<void>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const approveConfirmed = (): void => {
    setConfirming(true);
    setApproveError(null);
    answer({ decision: 'once' })
      .catch((err: unknown) =>
        // Electron prefixes errors thrown in a main-process handler; show the reason only.
        setApproveError(
          (err instanceof Error ? err.message : String(err)).replace(/^.*?Error: /, ''),
        ),
      )
      .finally(() => setConfirming(false));
  };
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<McpReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const left = useCountdown(expiresAt);

  useEffect(() => {
    if (!reviewing || review) return;
    rasql.mcp
      .review(cs.id)
      .then(setReview)
      .catch((err: unknown) => setReviewError(err instanceof Error ? err.message : String(err)));
  }, [reviewing, review, cs.id]);

  const n = cs.statements.length;
  const biggest = cs.tableSizes.reduce<number | undefined>(
    (m, t) => (t.rows !== undefined && (m === undefined || t.rows > m) ? t.rows : m),
    undefined,
  );
  const parts = [`${n} statement${n === 1 ? '' : 's'}`];
  if (cs.estimatedRows !== undefined)
    parts.push(`about ${rows(cs.estimatedRows)} row${cs.estimatedRows === 1 ? '' : 's'} affected`);
  const line = `${parts.join(', ')}${biggest !== undefined ? `, on a table of ${rows(biggest)} rows` : ''}.`;
  const destructive = cs.safety === 'destructive';

  return (
    <div className={`mcp-prompt${destructive ? ' destructive' : ''}`}>
      <h1>
        <strong>{who(client)}</strong> is attempting to commit database changes to{' '}
        <code>{cs.database ?? cs.connectionName}</code>.
      </h1>
      <p>{line}</p>
      {cs.description && <blockquote>{cs.description}</blockquote>}
      {destructive && (
        <div className="mcp-warning danger">
          <strong>This can lose data.</strong>{' '}
          {cs.statements
            .filter((s) => s.safety === 'destructive')
            .flatMap((s) => s.reasons)
            .slice(0, 4)
            .join('; ')}
        </div>
      )}
      {cs.warnings.map((w) => (
        <div className="mcp-warning" key={w}>
          {w}
        </div>
      ))}
      {!reviewing && (
        <pre className="mcp-sql preview">
          {cs.statements
            .slice(0, 6)
            .map((s) => s.sql)
            .join(';\n')}
          {n > 6 ? `;\n… ${n - 6} more` : ''}
        </pre>
      )}
      {reviewing && (
        <div className="mcp-review">
          {reviewError && <div className="form-error">{reviewError}</div>}
          {cs.statements.map((s, i) => (
            <section key={i} className={`mcp-statement ${s.safety}`}>
              <header>
                <span className={`chip ${s.safety}`}>
                  {s.safety === 'safe' ? 'Safe' : 'Can lose data'}
                </span>
                {s.estimatedRows !== undefined && <span>about {rows(s.estimatedRows)} rows</span>}
                {s.tables.map((t) => {
                  const size = cs.tableSizes.find((x) =>
                    x.table.replace(/[`"[\]]/g, '').endsWith(t.name),
                  );
                  return (
                    <span key={t.name} className="mcp-table">
                      {t.name}
                      {size?.rows !== undefined ? ` (${rows(size.rows)} rows)` : ''}
                    </span>
                  );
                })}
              </header>
              <pre className="mcp-sql">{s.sql}</pre>
              <ul className="mcp-reasons">
                {s.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                {s.checks.map((c) => (
                  <li key={c.description}>
                    Checked: {c.description} —{' '}
                    {c.offendingRows === null
                      ? 'could not check'
                      : c.offendingRows === 0
                        ? 'every row fits'
                        : `${c.offendingRows} row${c.offendingRows === 1 ? '' : 's'} do not fit`}
                  </li>
                ))}
              </ul>
              {review?.plans[i] && (
                <details>
                  <summary>Execution plan</summary>
                  <pre className="mcp-sql">{review.plans[i]}</pre>
                </details>
              )}
              {review?.before[i] != null && <BeforeRows data={review.before[i]} />}
            </section>
          ))}
          {!review && !reviewError && <p className="hint">Loading plans and current rows…</p>}
        </div>
      )}
      {denying ? (
        <form
          className="mcp-deny"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(
              note.trim() ? { decision: 'deny', note: note.trim() } : { decision: 'deny' },
            );
          }}
        >
          <label>
            A note for the agent (optional)
            <textarea
              autoFocus
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Use a WHERE clause on status instead"
            />
          </label>
          <div className="form-actions">
            <button type="button" onClick={() => setDenying(false)}>
              Back
            </button>
            <button type="submit" className="danger">
              Deny
            </button>
          </div>
        </form>
      ) : (
        <div className="form-actions mcp-actions">
          {left && (
            <span className="mcp-countdown" title="Expires as Deny">
              {left}
            </span>
          )}
          <button onClick={() => setReviewing((r) => !r)}>
            {reviewing ? 'Hide review' : 'Review…'}
          </button>
          <span className="spacer" />
          <button onClick={() => setDenying(true)}>Deny</button>
          {secure ? (
            <button className="primary" disabled={confirming} onClick={approveConfirmed}>
              {confirming ? `Waiting for ${confirmWith}…` : `Approve with ${confirmWith}`}
            </button>
          ) : (
            <>
              <button
                title={
                  destructive
                    ? 'Allows non-destructive changes on this connection until RaSQL quits; this one still commits now'
                    : 'Allow further non-destructive changes on this connection until RaSQL quits'
                }
                onClick={() => void answer({ decision: 'session' })}
              >
                This session
              </button>
              <button
                title="Commit, and switch this connection's MCP setting to Read/Write. Changes that can lose data still ask."
                onClick={() => void answer({ decision: 'always' })}
              >
                Always
              </button>
              <button className="primary" onClick={() => void answer({ decision: 'once' })}>
                Once
              </button>
            </>
          )}
        </div>
      )}
      {secure && !denying && (
        <p className={approveError ? 'form-error' : 'mcp-prompt-meta'}>
          {approveError ??
            `This connection is Secure: every change needs ${confirmWith}, so only you can approve it.`}
        </p>
      )}
    </div>
  );
}

/** The rows an UPDATE or DELETE touches, as they are now. */
function BeforeRows({ data }: { data: unknown }): React.JSX.Element | null {
  const d = data as { columns: { name: string }[]; rows: unknown[][]; truncated: boolean };
  if (!d?.columns) return null;
  const cell = (v: unknown): string =>
    v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return (
    <details open>
      <summary>
        Rows as they are now ({d.rows.length}
        {d.truncated ? '+' : ''})
      </summary>
      <div className="mcp-grid">
        <table>
          <thead>
            <tr>
              {d.columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={v === null ? 'null' : undefined}>
                    {cell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
