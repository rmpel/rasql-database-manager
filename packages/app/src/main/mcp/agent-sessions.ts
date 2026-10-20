import type { RemoteSession } from '@rasql/driver-sdk';
import type { AgentSession } from '@rasql/mcp';
import type { ConnectionDefinition } from '@shared/api';
import type { AgentTargets } from './targets';
import type { SessionManager } from '../sessions';

/** Agent sessions close after this long without a call. */
const IDLE_MS = 5 * 60_000;

interface Live {
  /** The parts of the definition the session was opened with; a change reopens it. */
  fingerprint: string;
  session: RemoteSession;
  close: () => Promise<void>;
  idle: NodeJS.Timeout | null;
}

/** Everything that decides where a session points and how it behaves. */
const fingerprint = (d: ConnectionDefinition): string =>
  JSON.stringify([
    d.driver,
    d.transport,
    d.host,
    d.port,
    d.socketPath,
    d.filePath,
    d.user,
    d.database,
    d.readOnly,
    d.ssh,
    d.options,
    d.credentials,
  ]);

/**
 * One session per connection for all agents, separate from the user's windows, opened on
 * first use with stored credentials. Calls per connection run one at a time, and the session
 * stays read-only except while the MCP server commits a change set.
 */
export class AgentSessions {
  private readonly live = new Map<string, Live>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly targets: AgentTargets,
    private readonly log: (line: string) => void,
  ) {}

  with<T>(connectionId: string, fn: (session: AgentSession) => Promise<T>): Promise<T> {
    const previous = this.queues.get(connectionId) ?? Promise.resolve();
    const run = previous.then(() => this.run(connectionId, fn));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(connectionId, tail);
    void tail.then(() => {
      if (this.queues.get(connectionId) === tail) this.queues.delete(connectionId);
    });
    return run;
  }

  private async run<T>(
    connectionId: string,
    fn: (session: AgentSession) => Promise<T>,
  ): Promise<T> {
    const target = this.targets.get(connectionId);
    if (!target) throw new Error('The connection no longer exists');
    const def = target.definition;
    if (target.site && !target.site.running)
      throw new Error(
        `The Local site ${target.site.name} is not running. Start it in Local, then try again.`,
      );
    let live = this.live.get(connectionId);
    if (live && live.fingerprint !== fingerprint(def)) {
      await this.close(connectionId);
      live = undefined;
    }
    if (!live) {
      if (def.credentials.password?.provider === 'prompt')
        throw new Error(
          `${def.name} asks for its password every time, so agents cannot open it. The user can store the password in RaSQL.`,
        );
      const opened = await this.sessions.openDetached(def, target.password);
      try {
        await opened.session.setReadOnly(true);
      } catch (err) {
        await opened.close();
        throw err;
      }
      live = {
        fingerprint: fingerprint(def),
        session: opened.session,
        close: opened.close,
        idle: null,
      };
      this.live.set(connectionId, live);
    }
    if (live.idle) clearTimeout(live.idle);
    live.idle = null;
    try {
      return await fn(live.session);
    } catch (err) {
      // A dead connection is reopened on the next call rather than failing forever.
      const code = (err as { code?: string }).code;
      if (code === 'NOT_CONNECTED' || code === 'CONNECTION_FAILED' || code === 'PROTOCOL_ERROR')
        await this.close(connectionId);
      throw err;
    } finally {
      const current = this.live.get(connectionId);
      if (current) {
        if (current.idle) clearTimeout(current.idle);
        current.idle = setTimeout(() => {
          this.log(`[mcp] agent session for ${def.name} idle, closing`);
          void this.close(connectionId);
        }, IDLE_MS);
      }
    }
  }

  async close(connectionId: string): Promise<void> {
    const live = this.live.get(connectionId);
    if (!live) return;
    this.live.delete(connectionId);
    if (live.idle) clearTimeout(live.idle);
    await live.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }
}
