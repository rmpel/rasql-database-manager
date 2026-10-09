import { describe, expect, it } from 'vitest';
import { buildConnectUrl, mysqlPort } from './url';

const site = {
  id: 'abc',
  name: 'My Site',
  mysql: { database: 'local', user: 'root', password: 'root' },
  services: { mysql: { ports: { MYSQL: [10003] } } },
};

describe('buildConnectUrl', () => {
  it('prefers the socket and encodes everything', () => {
    const u = new URL(
      buildConnectUrl(site, {
        socketPath: '/Users/me/Library/Application Support/Local/run/abc/mysql/mysqld.sock',
        port: 10003,
      }),
    );
    expect(u.protocol).toBe('rasql:');
    expect(u.hostname).toBe('connect');
    expect(u.searchParams.get('socket')).toBe(
      '/Users/me/Library/Application Support/Local/run/abc/mysql/mysqld.sock',
    );
    expect(u.searchParams.get('host')).toBeNull();
    expect(u.searchParams.get('name')).toBe('My Site');
    expect(u.searchParams.get('env')).toBe('local');
    expect(u.searchParams.get('database')).toBe('local');
  });

  it('falls back to the TCP port, as on Windows', () => {
    const u = new URL(buildConnectUrl(site, { port: 10003 }));
    expect(u.searchParams.get('host')).toBe('127.0.0.1');
    expect(u.searchParams.get('port')).toBe('10003');
    expect(u.searchParams.get('socket')).toBeNull();
  });

  it('defaults credentials to root/root/local when the record has none', () => {
    const u = new URL(buildConnectUrl({ id: 'x', name: 'x' }, { port: 1 }));
    expect(u.searchParams.get('user')).toBe('root');
    expect(u.searchParams.get('password')).toBe('root');
  });

  it('refuses a site without any target', () => {
    expect(() => buildConnectUrl({ id: 'x', name: 'x' }, {})).toThrow(/neither/);
  });

  it('reads the MySQL port from the services block', () => {
    expect(mysqlPort(site)).toBe(10003);
    expect(mysqlPort({ id: 'x', name: 'x' })).toBeUndefined();
  });
});
