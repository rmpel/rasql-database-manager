import { describe, expect, it } from 'vitest';
import { parseLaunchArgument, parseUrl, redactUrl } from './deeplink';

describe('deep links', () => {
  it('parses a rasql://connect url with a socket, as LocalWP would send it', () => {
    const p = parseUrl(
      'rasql://connect?driver=mysql&socket=%2FUsers%2Fme%2FLibrary%2Fmysqld.sock&user=root&password=root&database=local&name=My%20Site&env=local',
    );
    expect(p).toMatchObject({
      autoConnect: true,
      password: 'root',
      definition: {
        driver: 'mysql',
        transport: 'socket',
        socketPath: '/Users/me/Library/mysqld.sock',
        user: 'root',
        database: 'local',
        name: 'My Site',
        environment: 'local',
      },
    });
  });

  it('parses a generic mysql:// url like the TablePlus adapter emits', () => {
    const p = parseUrl('mysql://root:s3cret@127.0.0.1:3307/shop');
    expect(p?.definition).toMatchObject({
      driver: 'mysql',
      transport: 'tcp',
      host: '127.0.0.1',
      port: 3307,
      user: 'root',
      database: 'shop',
    });
    expect(p?.password).toBe('s3cret');
  });

  it('parses postgres://, postgresql://, mssql:// and sqlserver:// urls', () => {
    expect(parseLaunchArgument('postgres://app:s%40cret@db.test:6543/shop?name=Shop')).toEqual({
      definition: {
        driver: 'postgres',
        transport: 'tcp',
        host: 'db.test',
        port: 6543,
        user: 'app',
        database: 'shop',
        name: 'Shop',
        source: 'deep-link',
      },
      autoConnect: true,
      password: 's@cret',
    });
    expect(parseUrl('postgresql:///wp?host=/var/run/postgresql')?.definition).toMatchObject({
      driver: 'postgres',
      transport: 'socket',
      socketPath: '/var/run/postgresql',
    });
    for (const scheme of ['mssql', 'sqlserver'])
      expect(parseUrl(`${scheme}://sa@sql.test:1433/wordpress`)?.definition).toMatchObject({
        driver: 'mssql',
        host: 'sql.test',
        port: 1433,
        database: 'wordpress',
      });
  });

  it('turns a sqlite file path into a pending connection', () => {
    expect(parseLaunchArgument('/tmp/app.sqlite')?.definition).toMatchObject({
      driver: 'sqlite',
      transport: 'file',
      filePath: '/tmp/app.sqlite',
    });
    expect(parseLaunchArgument('/tmp/notes.txt')).toBeNull();
  });

  it('redacts passwords for logging', () => {
    expect(redactUrl('mysql://root:s3cret@h/db')).toBe('mysql://root:***@h/db');
    expect(redactUrl('rasql://connect?user=a&password=b')).toContain('password=***');
  });
});
