import { BrowserWindow } from 'electron';
import {
  effectiveAccess,
  type AgentConnection,
  type AgentSession,
  type AuditEntry,
  type ChangeSetSummary,
  type ClientInfo,
  type CommitAnswer,
  type ConnectionPatch,
  type McpAccess,
  type McpHost,
  type NewConnection,
} from '@rasql/mcp';
import type { ConnectionDefinition, Environment, McpActivity } from '@shared/api';
import { IPC } from '@shared/api';
import type { ConnectionStore } from '../connections';
import { passwordAccount, type CredentialProvider } from '../credentials';
import { findDriver } from '../drivers/registry';
import type { AgentSessions } from './agent-sessions';
import type { AuditLog } from './audit';
import type { AgentTargets } from './targets';
import type { McpConfigStore } from './config';
import type { PromptManager } from './prompts';

const CLIENT_PROMPT_MS = 10 * 60_000;
const CONNECTION_PROMPT_MS = 10 * 60_000;
export const COMMIT_PROMPT_MS = 5 * 60_000;

const ENVIRONMENTS: Environment[] = ['local', 'development', 'staging', 'production', 'other'];

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

/** A stored connection or a Local site as agents see it. */
export function agentView(def: ConnectionDefinition, access?: McpAccess): AgentConnection {
  const out: AgentConnection = {
    id: def.id,
    name: def.name,
    driver: def.driver,
    environment: def.environment,
    readOnly: def.readOnly,
    access: access ?? effectiveAccess(def.mcp, def.readOnly),
  };
  if (def.group) out.group = def.group;
  if (def.favorite) out.favorite = true;
  if (def.color) out.color = def.color;
  if (def.database) out.database = def.database;
  return out;
}

/** The app's side of the MCP server: storage, keychain, prompts, sessions and the audit log. */
export class AppMcpHost implements McpHost {
  private readonly approving = new Map<string, Promise<boolean>>();
  private changedTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      store: ConnectionStore;
      targets: AgentTargets;
      credentials: CredentialProvider;
      agents: AgentSessions;
      prompts: PromptManager;
      config: McpConfigStore;
      auditLog: AuditLog;
      /** How the OS confirms the user, for Secure prompts. */
      presenceLabel: () => string;
    },
  ) {}

  /** Tell open windows that MCP state changed; coalesced so a busy agent does not flood them. */
  changed(): void {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      broadcast(IPC.mcpChanged);
    }, 250);
  }

  connections(): AgentConnection[] {
    return this.deps.targets.list().map((t) => agentView(t.definition, t.access));
  }

  withSession<T>(connectionId: string, fn: (session: AgentSession) => Promise<T>): Promise<T> {
    return this.deps.agents.with(connectionId, fn);
  }

  approveClient(client: ClientInfo): Promise<boolean> {
    const known = this.deps.config.client(client.name);
    if (known?.status === 'allowed') {
      this.deps.config.seen(client.name);
      return Promise.resolve(true);
    }
    if (known?.status === 'denied') return Promise.resolve(false);
    const asking = this.approving.get(client.name);
    if (asking) return asking;
    const p = this.deps.prompts
      .ask({ kind: 'client', client }, { timeoutMs: CLIENT_PROMPT_MS })
      .then((answer) => {
        if (answer?.decision === 'allow') this.deps.config.decide(client, 'allowed');
        else if (answer?.decision === 'deny') this.deps.config.decide(client, 'denied');
        this.deps.auditLog.append({
          client: client.title || client.name,
          tool: 'connect',
          outcome: answer?.decision === 'allow' ? 'ok' : answer ? 'denied' : 'expired',
          detail:
            answer?.decision === 'allow'
              ? 'allowed by the user'
              : answer
                ? 'refused by the user'
                : 'nobody answered',
        });
        this.changed();
        return answer?.decision === 'allow';
      })
      .finally(() => this.approving.delete(client.name));
    this.approving.set(client.name, p);
    return p;
  }

  async createConnection(
    client: ClientInfo,
    input: NewConnection,
  ): Promise<AgentConnection | null> {
    findDriver(input.driver); // throws for a driver RaSQL does not have
    const target =
      input.transport === 'file'
        ? (input.filePath ?? '')
        : input.transport === 'socket'
          ? (input.socketPath ?? '')
          : `${input.host ?? '127.0.0.1'}${input.port ? `:${input.port}` : ''}`;
    const environment = ENVIRONMENTS.includes(input.environment as Environment)
      ? (input.environment as Environment)
      : 'local';
    const readOnly = Boolean(input.readOnly);
    const shown: Extract<
      Parameters<PromptManager['ask']>[0],
      { kind: 'connection' }
    >['connection'] = {
      name: input.name,
      driver: input.driver,
      transport: input.transport,
      target,
      environment,
      readOnly,
      hasPassword: Boolean(input.password),
    };
    if (input.user) shown.user = input.user;
    if (input.database) shown.database = input.database;
    const answer = await this.deps.prompts.ask(
      { kind: 'connection', client, connection: shown },
      { timeoutMs: CONNECTION_PROMPT_MS },
    );
    if (answer?.decision !== 'allow') return null;

    let def: ConnectionDefinition = {
      id: '',
      name: input.name,
      environment,
      readOnly,
      // An agent's connection starts at Ask; a read-only one can only be read (MCP.md section 2).
      mcp: readOnly ? 'read' : 'ask',
      driver: input.driver,
      transport: input.transport,
      options: {},
      credentials: {},
      source: 'mcp',
      createdAt: '',
      updatedAt: '',
    };
    if (input.host !== undefined) def.host = input.host;
    if (input.port !== undefined) def.port = input.port;
    if (input.socketPath !== undefined) def.socketPath = input.socketPath;
    if (input.filePath !== undefined) def.filePath = input.filePath;
    if (input.user !== undefined) def.user = input.user;
    if (input.database !== undefined) def.database = input.database;
    if (input.group) def.group = input.group;
    if (input.favorite) def.favorite = true;
    if (input.color) def.color = input.color;
    if (input.transport === 'tcp' && def.host === undefined) def.host = '127.0.0.1';
    def = this.deps.store.save(def);
    if (input.password) {
      const account = passwordAccount(def.id);
      await this.deps.credentials.set(account, input.password);
      def = this.deps.store.save({
        ...def,
        credentials: { password: { provider: 'keychain', account } },
      });
    }
    this.changed();
    return agentView(def);
  }

  updateConnection(id: string, patch: ConnectionPatch): AgentConnection {
    if (id.startsWith('localwp:'))
      throw new Error('Local sites are named and set up in Local; RaSQL cannot change them');
    const def = this.deps.store.list().find((c) => c.id === id);
    if (!def || effectiveAccess(def.mcp, def.readOnly) === 'hidden')
      throw new Error('There is no such connection');
    const next: ConnectionDefinition = { ...def };
    if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
    if (patch.group !== undefined) {
      if (patch.group && patch.group.trim()) next.group = patch.group.trim();
      else delete next.group;
    }
    if (patch.favorite !== undefined) next.favorite = patch.favorite;
    if (patch.color !== undefined) {
      if (patch.color) next.color = patch.color;
      else delete next.color;
    }
    this.changed();
    return agentView(this.deps.store.save(next));
  }

  async promptCommit(summary: ChangeSetSummary): Promise<CommitAnswer> {
    const expiresAt = new Date(Date.now() + COMMIT_PROMPT_MS).toISOString();
    const secure = this.deps.targets.get(summary.connectionId)?.access === 'secure';
    const answer = await this.deps.prompts.ask(
      {
        kind: 'commit',
        client: summary.client,
        changeSet: summary,
        expiresAt,
        secure,
        confirmWith: this.deps.presenceLabel(),
      },
      { connectionId: summary.connectionId, timeoutMs: COMMIT_PROMPT_MS },
    );
    if (!answer) return { decision: 'expired' };
    if (answer.decision === 'deny')
      return answer.note ? { decision: 'deny', note: answer.note } : { decision: 'deny' };
    if (answer.decision === 'allow') return { decision: 'once' };
    return { decision: answer.decision };
  }

  allowAlways(connectionId: string): void {
    // Always never lifts a Secure connection to Read/Write (D-43).
    const target = this.deps.targets.get(connectionId);
    if (target?.access !== 'ask') return;
    if (target.site) this.deps.config.setLocalAccess(target.site.id, 'write');
    else this.deps.store.save({ ...target.definition, mcp: 'write' });
    this.changed();
  }

  audit(entry: AuditEntry): void {
    this.deps.auditLog.append(entry);
    this.changed();
  }

  activity(connectionId: string, client: ClientInfo, tool: string): void {
    this.deps.config.seen(client.name);
    const a: McpActivity = {
      connectionId,
      client: client.title || client.name,
      tool,
      at: new Date().toISOString(),
    };
    broadcast(IPC.mcpActivity, a);
  }

  rowLimit(): number {
    return this.deps.config.get().rowLimit;
  }

  changeSetUpdated(summary: ChangeSetSummary): void {
    this.deps.prompts.changeSetUpdated(summary);
  }
}
