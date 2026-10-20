import { describe, expect, it } from 'vitest';
import type { McpAccess } from '@rasql/mcp';
import type { ConnectionDefinition, LocalSite } from '@shared/api';
import type { ConnectionStore } from '../connections';
import type { McpConfigStore } from './config';
import { AgentTargets } from './targets';

const stored: ConnectionDefinition = {
  id: 'c1',
  name: 'Shop',
  environment: 'local',
  readOnly: true,
  mcp: 'write',
  driver: 'mysql',
  transport: 'tcp',
  host: '127.0.0.1',
  options: {},
  credentials: {},
  createdAt: '',
  updatedAt: '',
};

const site = (over: Partial<LocalSite> = {}): LocalSite => ({
  id: 'EE0cNsiD3',
  name: 'wp',
  database: 'local',
  user: 'root',
  password: 'root',
  socketPath: '/tmp/run/EE0cNsiD3/mysql/mysqld.sock',
  port: 10005,
  running: true,
  ...over,
});

function targets(
  local: { defaultAccess: McpAccess; sites: Record<string, McpAccess> },
  sites: LocalSite[],
): AgentTargets {
  const store = { list: () => [stored] } as unknown as ConnectionStore;
  const config = {
    localAccess: (id: string) => local.sites[id] ?? local.defaultAccess,
  } as unknown as McpConfigStore;
  return new AgentTargets(store, config, () => sites);
}

describe('agent targets', () => {
  it('lists stored connections and Local sites, each with its access', () => {
    const t = targets({ defaultAccess: 'ask', sites: {} }, [site()]);
    expect(t.list().map((x) => [x.id, x.access])).toEqual([
      // The read-only flag caps Read/Write at Read-only.
      ['c1', 'read'],
      ['localwp:EE0cNsiD3', 'ask'],
    ]);
  });

  it('lets a site setting override the default for Local sites', () => {
    const t = targets({ defaultAccess: 'ask', sites: { EE0cNsiD3: 'hidden' } }, [site()]);
    expect(t.get('localwp:EE0cNsiD3')?.access).toBe('hidden');
  });

  it('builds a Local site fresh from Local: socket while running, port when stopped', () => {
    const running = targets({ defaultAccess: 'read', sites: {} }, [site()]).get(
      'localwp:EE0cNsiD3',
    );
    expect(running?.definition).toMatchObject({
      id: 'localwp:EE0cNsiD3',
      name: 'wp',
      driver: 'mysql',
      transport: 'socket',
      socketPath: '/tmp/run/EE0cNsiD3/mysql/mysqld.sock',
      database: 'local',
      environment: 'local',
      localSiteId: 'EE0cNsiD3',
    });
    expect(running?.password).toBe('root');
    const stopped = targets({ defaultAccess: 'read', sites: {} }, [site({ running: false })]).get(
      'localwp:EE0cNsiD3',
    );
    expect(stopped?.definition).toMatchObject({ transport: 'tcp', host: '127.0.0.1', port: 10005 });
    expect(stopped?.site?.running).toBe(false);
  });

  it('forgets a site that is gone from Local', () => {
    expect(
      targets({ defaultAccess: 'ask', sites: {} }, []).get('localwp:EE0cNsiD3'),
    ).toBeUndefined();
  });
});
