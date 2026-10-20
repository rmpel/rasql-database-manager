import { effectiveAccess, type McpAccess } from '@rasql/mcp';
import type { ConnectionDefinition, LocalSite } from '@shared/api';
import { localAgentId } from '@shared/api';
import type { ConnectionStore } from '../connections';
import { discoverSites, pendingConnectionFor } from '../integrations/localwp';
import type { McpConfigStore } from './config';

/** Something an agent can be given: a stored connection, or a LocalWP site. */
export interface AgentTarget {
  /** A stored connection's id, or localwp:<site id>. */
  id: string;
  definition: ConnectionDefinition;
  /** Local sites carry their password in Local's registry; stored ones use the keychain. */
  password?: string;
  access: McpAccess;
  site?: LocalSite;
}

/**
 * Stored connections plus LocalWP sites. A Local site is read fresh from Local's registry every
 * time, so a changed port or socket never goes stale; RaSQL keeps only its MCP setting.
 */
export class AgentTargets {
  constructor(
    private readonly store: ConnectionStore,
    private readonly config: McpConfigStore,
    private readonly sites: () => LocalSite[] = () => {
      try {
        return discoverSites();
      } catch {
        return [];
      }
    },
  ) {}

  list(): AgentTarget[] {
    const stored = this.store.list().map((def): AgentTarget => ({
      id: def.id,
      definition: def,
      access: effectiveAccess(def.mcp, def.readOnly),
    }));
    return [...stored, ...this.sites().map((site) => this.fromSite(site))];
  }

  get(id: string): AgentTarget | undefined {
    if (!id.startsWith('localwp:')) {
      const def = this.store.list().find((c) => c.id === id);
      return def && { id, definition: def, access: effectiveAccess(def.mcp, def.readOnly) };
    }
    const site = this.sites().find((s) => localAgentId(s.id) === id);
    return site && this.fromSite(site);
  }

  private fromSite(site: LocalSite): AgentTarget {
    const pending = pendingConnectionFor(site);
    const id = localAgentId(site.id);
    const definition: ConnectionDefinition = {
      environment: 'local',
      readOnly: false,
      options: {},
      credentials: {},
      createdAt: '',
      updatedAt: '',
      ...pending.definition,
      id,
      name: site.name,
      group: 'LocalWP',
    };
    const target: AgentTarget = {
      id,
      definition,
      access: effectiveAccess(this.config.localAccess(site.id), false),
      site,
    };
    if (pending.password !== undefined) target.password = pending.password;
    return target;
  }
}
