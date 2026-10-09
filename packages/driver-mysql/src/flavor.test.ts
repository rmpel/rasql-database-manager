import { describe, expect, it } from 'vitest';
import { detectFlavor } from './flavor.js';

describe('detectFlavor', () => {
  it('recognises plain MySQL', () => {
    expect(
      detectFlavor({ version: '8.0.40', versionComment: 'MySQL Community Server - GPL' }),
    ).toMatchObject({
      engine: 'mysql',
      version: '8.0.40',
    });
    expect(
      detectFlavor({ version: '5.7.44-log', versionComment: 'MySQL Community Server (GPL)' }),
    ).toMatchObject({
      engine: 'mysql',
      version: '5.7.44',
    });
  });

  it('recognises MariaDB, including the 5.5.5- replication prefix', () => {
    expect(
      detectFlavor({
        version: '11.4.2-MariaDB-ubu2404',
        versionComment: 'mariadb.org binary distribution',
      }),
    ).toMatchObject({
      engine: 'mariadb',
      version: '11.4.2',
    });
    expect(
      detectFlavor({ version: '5.5.5-10.6.18-MariaDB-1:10.6.18+maria~ubu2004' }),
    ).toMatchObject({
      engine: 'mariadb',
      version: '10.6.18',
    });
  });

  it('recognises Percona by its version comment', () => {
    expect(
      detectFlavor({
        version: '8.0.36-28',
        versionComment: 'Percona Server (GPL), Release 28, Revision 47601f19',
      }),
    ).toMatchObject({ engine: 'percona', version: '8.0.36' });
  });

  it('recognises Aurora when @@aurora_version answers', () => {
    expect(
      detectFlavor({
        version: '8.0.32',
        versionComment: 'Source distribution',
        auroraVersion: '3.05.2',
      }),
    ).toMatchObject({
      engine: 'aurora-mysql',
      version: '8.0.32',
      fullVersion: '8.0.32 (Aurora 3.05.2)',
    });
  });

  it('recognises TiDB and reports the TiDB version, not the MySQL compatibility version', () => {
    expect(
      detectFlavor({
        version: '8.0.11-TiDB-v7.5.1',
        versionComment: 'TiDB Server (Apache License 2.0)',
      }),
    ).toMatchObject({
      engine: 'tidb',
      version: '7.5.1',
    });
  });

  it('recognises Vitess', () => {
    expect(
      detectFlavor({ version: '8.0.30-Vitess', versionComment: 'Version: 8.0.30-Vitess (Vitess)' }),
    ).toMatchObject({
      engine: 'vitess',
      version: '8.0.30',
    });
    expect(
      detectFlavor({ version: '8.0.34', versionComment: 'PlanetScale (Vitess)' }),
    ).toMatchObject({ engine: 'vitess' });
  });
});
