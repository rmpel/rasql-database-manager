import { ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { McpCore, listenOnHttp, listenOnSocket } from '@rasql/mcp';
import type {
  McpAccess,
  McpLocalAccess,
  McpOptions,
  McpPromptAnswer,
  McpStatus,
} from '@shared/api';
import { IPC, localAgentId } from '@shared/api';
import type { ConnectionStore } from '../connections';
import type { CredentialProvider } from '../credentials';
import type { SessionManager } from '../sessions';
import type { WindowManager } from '../windows';
import { AgentSessions } from './agent-sessions';
import { AgentTargets } from './targets';
import { AuditLog } from './audit';
import { McpConfigStore } from './config';
import { AppMcpHost, broadcast } from './host';
import { mcpCommand, mcpSocketPath } from './paths';
import { PromptManager } from './prompts';
import { cached, presenceForPlatform, type PresenceCheck } from './presence';

const TOKEN_ACCOUNT = 'rasql:mcp:http-token';

/**
 * Start the MCP server (MCP.md, D-40): the local socket `rasql mcp` relays to, and the
 * optional HTTP endpoint on 127.0.0.1. Returns a stop function for quitting.
 */
export function startMcp(deps: {
  store: ConnectionStore;
  credentials: CredentialProvider;
  sessions: SessionManager;
  windows: WindowManager;
  log: (line: string) => void;
}): () => Promise<void> {
  const { store, credentials, sessions, windows, log } = deps;
  const config = new McpConfigStore();
  const auditLog = new AuditLog();
  const targets = new AgentTargets(store, config);
  const agents = new AgentSessions(sessions, targets, log);
  const prompts = new PromptManager(windows, (id) => sessions.windowsFor(id));
  // The platform's way to confirm the user, for Secure connections. Swappable for tests.
  const presence: { check: PresenceCheck } = { check: cached(presenceForPlatform()) };
  if (process.env['RASQL_E2E_HOOKS']) {
    const g = globalThis as Record<string, unknown>;
    g['__rasql'] = { ...(g['__rasql'] as object | undefined), presence };
  }
  const host = new AppMcpHost({
    store,
    targets,
    credentials,
    agents,
    prompts,
    config,
    auditLog,
    presenceLabel: () => presence.check.label,
  });
  const core = new McpCore(host, { name: 'rasql', version: __APP_VERSION__ });

  const socketPath = mcpSocketPath();
  let socket: NetServer | null = null;
  let socketError: string | undefined;
  let http: HttpServer | null = null;
  let httpError: string | undefined;
  let token: string | null = null;

  const httpToken = async (): Promise<string> => {
    if (token) return token;
    token = await credentials.get(TOKEN_ACCOUNT);
    if (!token) {
      token = randomBytes(24).toString('base64url');
      await credentials.set(TOKEN_ACCOUNT, token);
    }
    return token;
  };

  const startSocket = async (): Promise<void> => {
    try {
      socket = await listenOnSocket(core, socketPath, log);
      socketError = undefined;
    } catch (err) {
      socketError = err instanceof Error ? err.message : String(err);
      log(`[mcp] socket failed: ${socketError}`);
    }
  };

  const restartHttp = async (): Promise<void> => {
    if (http) {
      const old = http;
      http = null;
      await new Promise<void>((r) => old.close(() => r()));
    }
    httpError = undefined;
    const cfg = config.get();
    if (!cfg.httpEnabled) return;
    try {
      const secret = await httpToken();
      http = await listenOnHttp(core, { port: cfg.httpPort, token: () => token ?? secret, log });
    } catch (err) {
      httpError = err instanceof Error ? err.message : String(err);
      log(`[mcp] http failed: ${httpError}`);
    }
  };

  void startSocket();
  void restartHttp();

  const status = (): McpStatus => {
    const cfg = config.get();
    const connected = new Set(core.connected().map((c) => c.name));
    const out: McpStatus = {
      socketPath,
      socketListening: socket !== null,
      command: mcpCommand(),
      http: {
        enabled: cfg.httpEnabled,
        port: cfg.httpPort,
        listening: http !== null,
        url: `http://127.0.0.1:${cfg.httpPort}/mcp`,
      },
      rowLimit: cfg.rowLimit,
      clients: cfg.clients.map((c) => ({ ...c, connected: connected.has(c.name) })),
    };
    if (socketError) out.socketError = socketError;
    if (httpError) out.http.error = httpError;
    return out;
  };

  ipcMain.handle(IPC.appShowMcp, () => {
    windows.showMcp();
  });
  ipcMain.handle(IPC.mcpStatus, () => status());
  ipcMain.handle(IPC.mcpSetOptions, async (_e, opts: McpOptions) => {
    const patch: Parameters<McpConfigStore['update']>[0] = {};
    if (opts.rowLimit !== undefined)
      patch.rowLimit = Math.min(Math.max(1, Math.floor(opts.rowLimit)), 100_000);
    if (opts.httpPort !== undefined)
      patch.httpPort = Math.min(Math.max(1024, Math.floor(opts.httpPort)), 65535);
    if (opts.httpEnabled !== undefined) patch.httpEnabled = opts.httpEnabled;
    const before = config.get();
    const restart =
      (patch.httpEnabled !== undefined && patch.httpEnabled !== before.httpEnabled) ||
      (patch.httpPort !== undefined && patch.httpPort !== before.httpPort);
    config.update(patch);
    if (restart) await restartHttp();
    host.changed();
    return status();
  });
  ipcMain.handle(IPC.mcpHttpToken, () => httpToken());
  ipcMain.handle(IPC.mcpRegenerateToken, async () => {
    token = randomBytes(24).toString('base64url');
    await credentials.set(TOKEN_ACCOUNT, token);
    // Sessions opened with the old token keep working until they disconnect; new ones need it.
    await restartHttp();
    return token;
  });
  ipcMain.handle(IPC.mcpAllowClient, (_e, name: string) => {
    const c = config.client(name);
    config.decide(c ?? { name }, 'allowed');
    host.changed();
    return status();
  });
  ipcMain.handle(IPC.mcpRevoke, async (_e, name?: string) => {
    // Revoking asks the client again on its next contact; "This session" answers end too.
    config.forget(name);
    core.revokeSessionGrants();
    if (name === undefined) prompts.denyAll();
    await core.disconnect(name);
    auditLog.append({
      client: name ?? 'all clients',
      tool: 'revoke',
      outcome: 'ok',
      detail: 'access revoked by the user',
    });
    host.changed();
    return status();
  });
  ipcMain.handle(IPC.mcpForgetClient, (_e, name: string) => {
    config.forget(name);
    host.changed();
    return status();
  });
  ipcMain.handle(
    IPC.mcpAudit,
    (_e, filter?: { client?: string; connectionId?: string; limit?: number }) =>
      auditLog.list(filter),
  );
  ipcMain.handle(IPC.mcpClearAudit, () => {
    auditLog.clear();
    host.changed();
  });
  ipcMain.handle(IPC.mcpPrompt, (_e, id: string) => prompts.get(id));
  const localAccess = (): McpLocalAccess => {
    const l = config.get().localwp;
    return { defaultAccess: l.defaultAccess, sites: { ...l.sites } };
  };
  ipcMain.handle(IPC.mcpLocalAccess, () => localAccess());
  ipcMain.handle(IPC.mcpSetLocalAccess, (_e, siteId: string, access: McpAccess | null) => {
    config.setLocalAccess(siteId, access);
    // A changed setting ends "This session" for that site, as for stored connections.
    core.revokeSessionGrants(localAgentId(siteId));
    host.changed();
    return localAccess();
  });
  ipcMain.handle(IPC.mcpSetLocalDefault, (_e, access: McpAccess) => {
    config.setLocalDefault(access);
    // Every site that follows the default changed; end "This session" for all Local sites.
    for (const t of targets.list()) if (t.site) core.revokeSessionGrants(t.id);
    host.changed();
    return localAccess();
  });
  ipcMain.handle(IPC.mcpPresence, async () => ({
    available: await presence.check.available(),
    label: presence.check.label,
  }));
  const verifying = new Set<string>();
  ipcMain.handle(IPC.mcpAnswer, async (_e, id: string, answer: McpPromptAnswer) => {
    const prompt = prompts.get(id);
    if (prompt?.kind !== 'commit' || !prompt.secure || answer.decision === 'deny') {
      prompts.answer(id, answer);
      return;
    }
    // Secure: a click is not enough. The main process asks the OS to confirm the user, so
    // nothing that can only click or type in the prompt window can approve the change (D-43).
    const check = presence.check;
    if (!(await check.available()))
      throw new Error(
        'This computer cannot confirm you (no Touch ID, Windows Hello or polkit), so this change cannot be approved. Deny it, or change the connection’s MCP setting.',
      );
    if (verifying.has(id)) return;
    verifying.add(id);
    let confirmed = false;
    try {
      const cs = prompt.changeSet;
      const n = cs.statements.length;
      confirmed = await check.verify(
        `approve ${n} database change${n === 1 ? '' : 's'} by ${prompt.client.title || prompt.client.name} to ${cs.database ?? cs.connectionName}`,
      );
    } catch {
      // A check that breaks counts as not confirmed.
    } finally {
      verifying.delete(id);
    }
    if (!confirmed) {
      // Worth a line in the log: a refused check is what someone reviewing access looks for.
      auditLog.append({
        client: prompt.client.title || prompt.client.name,
        tool: 'commit_changes',
        outcome: 'refused',
        connectionId: prompt.changeSet.connectionId,
        connectionName: prompt.changeSet.connectionName,
        detail: `${check.label} did not confirm the approval; the prompt stayed open`,
      });
      host.changed();
      throw new Error(`${check.label} did not confirm. Try again, or deny the change.`);
    }
    prompts.answer(id, { decision: 'once' });
  });
  ipcMain.handle(IPC.mcpReview, (_e, changeSetId: string) => core.review(changeSetId));

  // A changed MCP setting ends "This session" for that connection; a removed one closes its session.
  store.onChange((before, after) => {
    if (!before) return;
    if (!after) {
      core.revokeSessionGrants(before.id);
      void agents.close(before.id);
    } else if (before.mcp !== after.mcp || before.readOnly !== after.readOnly) {
      core.revokeSessionGrants(after.id);
    }
    host.changed();
  });

  return async () => {
    prompts.denyAll();
    await core.disconnect();
    await agents.closeAll();
    socket?.close();
    http?.close();
    broadcast(IPC.mcpChanged);
  };
}
