import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClientInfo, McpAccess } from '@rasql/mcp';

export interface ClientDecision {
  name: string;
  title?: string;
  version?: string;
  status: 'allowed' | 'denied';
  decidedAt: string;
  lastSeen?: string;
}

interface McpConfig {
  version: 1;
  clients: ClientDecision[];
  httpEnabled: boolean;
  httpPort: number;
  rowLimit: number;
  /** LocalWP sites: a default for all, and per-site settings that override it. */
  localwp: { defaultAccess: McpAccess; sites: Record<string, McpAccess> };
}

export const DEFAULT_HTTP_PORT = 47334;
export const DEFAULT_ROW_LIMIT = 500;

const DEFAULTS: McpConfig = {
  version: 1,
  clients: [],
  httpEnabled: false,
  httpPort: DEFAULT_HTTP_PORT,
  rowLimit: DEFAULT_ROW_LIMIT,
  localwp: { defaultAccess: 'hidden', sites: {} },
};

/** MCP preferences and the clients the user decided on, as JSON in the user data directory. */
export class McpConfigStore {
  private readonly file = join(app.getPath('userData'), 'mcp.json');
  private cache: McpConfig | null = null;

  get(): McpConfig {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<McpConfig>;
      // Fresh nested objects, so changing them never touches DEFAULTS.
      this.cache = {
        ...DEFAULTS,
        ...parsed,
        localwp: {
          defaultAccess: parsed.localwp?.defaultAccess ?? 'hidden',
          sites: { ...parsed.localwp?.sites },
        },
      };
    } catch {
      this.cache = { ...DEFAULTS, clients: [], localwp: { defaultAccess: 'hidden', sites: {} } };
    }
    return this.cache;
  }

  update(patch: Partial<Omit<McpConfig, 'version' | 'clients'>>): McpConfig {
    Object.assign(this.get(), patch);
    this.persist();
    return this.get();
  }

  client(name: string): ClientDecision | undefined {
    return this.get().clients.find((c) => c.name === name);
  }

  decide(client: ClientInfo, status: ClientDecision['status']): void {
    const all = this.get().clients;
    const existing = all.find((c) => c.name === client.name);
    const next: ClientDecision = {
      ...existing,
      name: client.name,
      status,
      decidedAt: new Date().toISOString(),
    };
    if (client.title) next.title = client.title;
    if (client.version) next.version = client.version;
    if (existing) Object.assign(existing, next);
    else all.push(next);
    this.persist();
  }

  /** The setting a Local site has: its own, or the default for Local sites. */
  localAccess(siteId: string): McpAccess {
    const l = this.get().localwp;
    return l.sites[siteId] ?? l.defaultAccess;
  }

  setLocalAccess(siteId: string, access: McpAccess | null): void {
    const l = this.get().localwp;
    if (access === null) delete l.sites[siteId];
    else l.sites[siteId] = access;
    this.persist();
  }

  setLocalDefault(access: McpAccess): void {
    this.get().localwp.defaultAccess = access;
    this.persist();
  }

  /** Remember when a client was last active; written at most once a minute per client. */
  seen(name: string): void {
    const c = this.client(name);
    if (!c) return;
    const now = new Date();
    if (c.lastSeen && now.getTime() - Date.parse(c.lastSeen) < 60_000) return;
    c.lastSeen = now.toISOString();
    this.persist();
  }

  /** Revoke: the client is asked again on its next contact. */
  forget(name?: string): void {
    const cfg = this.get();
    cfg.clients = name === undefined ? [] : cfg.clients.filter((c) => c.name !== name);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.get(), null, 2));
    renameSync(tmp, this.file);
  }
}
