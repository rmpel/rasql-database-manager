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
