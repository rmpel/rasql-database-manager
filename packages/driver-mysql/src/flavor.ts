export type MysqlEngine = 'mysql' | 'mariadb' | 'percona' | 'aurora-mysql' | 'tidb' | 'vitess';

export interface FlavorInput {
  /** `SELECT VERSION()` */
  version: string;
  /** `@@version_comment` */
  versionComment?: string | null;
  /** `@@aurora_version`, when the statement succeeds. */
  auroraVersion?: string | null;
}

export interface Flavor {
  engine: MysqlEngine;
  engineName: string;
  /** Normalized x.y.z of the engine itself (so MariaDB 10.6 is "10.6.x", not "5.5.5"). */
  version: string;
  /** The raw version string as the server reported it. */
  fullVersion: string;
}

const SEMVER = /(\d+)\.(\d+)(?:\.(\d+))?/;

function semver(s: string): string {
  const m = SEMVER.exec(s);
  if (!m) return s.trim();
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
}

export function detectFlavor(input: FlavorInput): Flavor {
  const version = input.version ?? '';
  const comment = input.versionComment ?? '';
  const haystack = `${version} ${comment}`;

  if (/tidb/i.test(version)) {
    // "8.0.11-TiDB-v7.5.0" or "5.7.25-TiDB-v6.1.0"
    const m = /TiDB-v?(\d+\.\d+\.\d+)/i.exec(version);
    return {
      engine: 'tidb',
      engineName: 'TiDB',
      version: m?.[1] ?? semver(version),
      fullVersion: version,
    };
  }

  if (/vitess/i.test(haystack)) {
    return {
      engine: 'vitess',
      engineName: 'Vitess',
      version: semver(version),
      fullVersion: version,
    };
  }

  if (/mariadb/i.test(version)) {
    // "11.4.2-MariaDB-ubu2404" or the replication-compatible "5.5.5-10.6.18-MariaDB-1:10.6.18+maria~ubu2004"
    const stripped = version.replace(/^5\.5\.5-/, '');
    return {
      engine: 'mariadb',
      engineName: 'MariaDB',
      version: semver(stripped),
      fullVersion: version,
    };
  }

  if (input.auroraVersion) {
    return {
      engine: 'aurora-mysql',
      engineName: 'Amazon Aurora MySQL',
      version: semver(version),
      fullVersion: `${version} (Aurora ${input.auroraVersion})`,
    };
  }

  if (/percona/i.test(comment)) {
    return {
      engine: 'percona',
      engineName: 'Percona Server',
      version: semver(version),
      fullVersion: version,
    };
  }

  return { engine: 'mysql', engineName: 'MySQL', version: semver(version), fullVersion: version };
}
