import { describe, expect, it } from 'vitest';
import type { TableDefinition } from '@rasql/driver-protocol';
import { allowedAccess, effectiveAccess } from './access.js';
import { analyzeStatement, type AnalysisContext } from './changes.js';
import { Refusal, assertPlainRead, foreignDatabase } from './scope.js';
import { splitStatements, tokenize, type Flavor } from './sql.js';
import { compareTypes, parseTypeText } from './types.js';

const one = (sql: string, flavor: Flavor = 'mysql') => {
  const s = splitStatements(sql, flavor);
  expect(s).toHaveLength(1);
  return s[0]!;
};

describe('access', () => {
  it('is hidden by default and capped by the read-only flag', () => {
    expect(effectiveAccess(undefined, false)).toBe('hidden');
    expect(effectiveAccess('write', true)).toBe('read');
    expect(effectiveAccess('ask', false)).toBe('ask');
    expect(allowedAccess(true)).toEqual(['hidden', 'read']);
    expect(allowedAccess(false)).toEqual(['hidden', 'read', 'ask', 'secure', 'write']);
    expect(effectiveAccess('secure', true)).toBe('read');
  });
});

describe('tokenizer', () => {
  it('ignores semicolons and keywords inside strings and comments', () => {
    const s = splitStatements(
      "SELECT ';' AS a; -- DROP TABLE x;\nSELECT `a;b` FROM t /* ; */",
      'mysql',
    );
    expect(s.map((x) => x.sql)).toEqual(["SELECT ';' AS a", 'SELECT `a;b` FROM t']);
  });
  it('keeps a routine body whole', () => {
    const s = splitStatements('CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'mysql');
    expect(s).toHaveLength(1);
  });
  it('reads PostgreSQL dollar quotes and SQL Server brackets', () => {
    expect(tokenize("SELECT $x$ it's; $x$", 'postgres').map((t) => t.kind)).toEqual([
      'word',
      'string',
    ]);
    expect(tokenize('SELECT [a;b]', 'mssql').map((t) => t.kind)).toEqual(['word', 'ident']);
  });
});

describe('database scope', () => {
  const ctx = {
    flavor: 'mysql' as const,
    database: 'shop',
    knownDatabases: ['shop', 'other', 'information_schema'],
  };
  it('refuses other databases on MySQL', () => {
    expect(foreignDatabase(one('SELECT * FROM other.users'), ctx)).toBe('other');
    expect(foreignDatabase(one('SELECT * FROM `other`.`users`'), ctx)).toBe('other');
    expect(foreignDatabase(one('SELECT * FROM information_schema.tables'), ctx)).toBe(
      'information_schema',
    );
    expect(foreignDatabase(one('USE other'), ctx)).toBe('other');
    expect(foreignDatabase(one('SHOW DATABASES'), ctx)).toBe('every database');
    expect(foreignDatabase(one('SHOW TABLES FROM other'), ctx)).toBe('other');
    // Not listed for this user, but a system database or in a table position all the same.
    expect(foreignDatabase(one('SELECT user FROM mysql.user'), ctx)).toBe('mysql');
    expect(foreignDatabase(one('SELECT * FROM unlisted.t'), ctx)).toBe('unlisted');
    expect(foreignDatabase(one('SELECT * FROM t JOIN unlisted.u ON t.id = u.id'), ctx)).toBe(
      'unlisted',
    );
    expect(foreignDatabase(one('INSERT INTO unlisted.t VALUES (1)'), ctx)).toBe('unlisted');
  });
  it('allows the own database and table.column', () => {
    expect(foreignDatabase(one('SELECT u.id, shop.users.name FROM shop.users u'), ctx)).toBeNull();
    expect(foreignDatabase(one("SELECT 'other.users' FROM users"), ctx)).toBeNull();
  });
  it('refuses three-part names and remote sources on SQL Server', () => {
    const ms = { flavor: 'mssql' as const, database: 'shop', knownDatabases: [] };
    expect(foreignDatabase(one('SELECT * FROM other.dbo.users', 'mssql'), ms)).toBe('other');
    expect(foreignDatabase(one('SELECT * FROM other..users', 'mssql'), ms)).toBe('other');
    expect(foreignDatabase(one('SELECT * FROM SHOP.dbo.users', 'mssql'), ms)).toBeNull();
    expect(foreignDatabase(one('SELECT * FROM srv.other.dbo.users', 'mssql'), ms)).toMatch(
      /linked server/,
    );
  });
});

describe('plain reads', () => {
  it('refuses reads that write or reach outside', () => {
    expect(() => assertPlainRead(one("SELECT * INTO OUTFILE '/tmp/x' FROM t"))).toThrow(Refusal);
    expect(() => assertPlainRead(one('SELECT * INTO copy FROM t', 'postgres'))).toThrow(Refusal);
    expect(() => assertPlainRead(one('EXPLAIN ANALYZE DELETE FROM t', 'postgres'))).toThrow(
      Refusal,
    );
    expect(() => assertPlainRead(one("SELECT LOAD_FILE('/etc/passwd')"))).toThrow(Refusal);
    expect(() => assertPlainRead(one('SELECT SLEEP(100)'))).toThrow(Refusal);
  });
  it('lets ordinary reads through', () => {
    expect(() =>
      assertPlainRead(one('SELECT id, sleep_hours FROM t WHERE x IN (SELECT 1)')),
    ).not.toThrow();
    expect(() => assertPlainRead(one('EXPLAIN SELECT 1'))).not.toThrow();
  });
});

describe('column types', () => {
  const t = (s: string, f: Flavor = 'mysql') => parseTypeText(s, f)!;
  it('treats widening as safe', () => {
    expect(compareTypes(t('int'), t('bigint'), 'mysql').safety).toBe('safe');
    expect(compareTypes(t('varchar(50)'), t('varchar(255)'), 'mysql').safety).toBe('safe');
    expect(compareTypes(t('float'), t('double'), 'mysql').safety).toBe('safe');
    expect(compareTypes(t('text'), t('mediumtext'), 'mysql').safety).toBe('safe');
    expect(compareTypes(t('int unsigned'), t('bigint'), 'mysql').safety).toBe('safe');
    expect(compareTypes(t('decimal(10,2)'), t('decimal(12,2)'), 'mysql').safety).toBe('safe');
    expect(
      compareTypes(t('character varying(20)', 'postgres'), t('text', 'postgres'), 'postgres')
        .safety,
    ).toBe('safe');
  });
  it('asks for a data check when narrowing', () => {
    const c = compareTypes(t('int'), t('tinyint'), 'mysql');
    expect(c.safety).toBe('check');
    if (c.safety === 'check') expect(c.condition('`n`')).toBe('`n` < -128 OR `n` > 127');
    expect(compareTypes(t('int'), t('int unsigned'), 'mysql').safety).toBe('check');
    expect(compareTypes(t('varchar(255)'), t('varchar(50)'), 'mysql').safety).toBe('check');
    expect(compareTypes(t("enum('a','b')"), t("enum('a')"), 'mysql').safety).toBe('check');
  });
  it('calls unknown conversions destructive', () => {
    expect(compareTypes(t('double'), t('float'), 'mysql').safety).toBe('destructive');
    expect(compareTypes(t('varchar(10)'), t('int'), 'mysql').safety).toBe('destructive');
  });
});

describe('change classification', () => {
  const users: TableDefinition = {
    schema: 'shop',
    name: 'users',
    kind: 'table',
    columns: [
      {
        name: 'id',
        ordinal: 1,
        nativeType: 'int',
        valueType: 'int',
        nullable: false,
        autoIncrement: true,
      },
      {
        name: 'age',
        ordinal: 2,
        nativeType: 'int',
        valueType: 'int',
        nullable: true,
        autoIncrement: false,
      },
      {
        name: 'name',
        ordinal: 3,
        nativeType: 'varchar(100)',
        valueType: 'text',
        nullable: true,
        autoIncrement: false,
        charset: 'utf8mb4',
      },
    ],
    indexes: [],
    foreignKeys: [],
    options: {},
  };
  const ctx: AnalysisContext = {
    flavor: 'mysql',
    describe: async (t) => (t.name === 'users' ? users : null),
  };
  const run = (sql: string, c: AnalysisContext = ctx) => analyzeStatement(one(sql, c.flavor), c);

  it('sorts data changes', async () => {
    expect((await run("INSERT INTO users (name) VALUES ('a'), ('b')")).safety).toBe('safe');
    expect((await run("INSERT INTO users (name) VALUES ('a'), ('b')")).insertRows).toBe(2);
    const upd = await run("UPDATE users SET name = 'x' WHERE id = 3");
    expect(upd.safety).toBe('safe');
    expect(upd.estimateSql).toBe('SELECT COUNT(*) FROM `users` WHERE id = 3');
    expect((await run("UPDATE users SET name = 'x'")).safety).toBe('destructive');
    expect((await run('DELETE FROM users WHERE id = 3')).safety).toBe('destructive');
    expect((await run("REPLACE INTO users VALUES (1, 2, 'a')")).safety).toBe('destructive');
  });

  it('sorts structure changes', async () => {
    expect((await run('CREATE TABLE t (id INT)')).safety).toBe('safe');
    expect((await run('CREATE INDEX i ON users (name)')).safety).toBe('safe');
    expect((await run('DROP TABLE users')).safety).toBe('destructive');
    expect((await run('TRUNCATE users')).safety).toBe('destructive');
    expect((await run('ALTER TABLE users ADD COLUMN x INT NULL, ADD INDEX (x)')).safety).toBe(
      'safe',
    );
    expect((await run('ALTER TABLE users ADD COLUMN x INT NOT NULL')).safety).toBe('destructive');
    expect((await run('ALTER TABLE users DROP COLUMN age')).safety).toBe('destructive');
    expect((await run('ALTER TABLE users MODIFY age BIGINT')).safety).toBe('safe');
    expect((await run('ALTER TABLE users MODIFY name VARCHAR(255)')).safety).toBe('safe');
  });

  it('checks the data before narrowing', async () => {
    const a = await run('ALTER TABLE users MODIFY age TINYINT');
    expect(a.safety).toBe('check');
    expect(a.checks[0]?.sql).toBe(
      'SELECT COUNT(*) FROM `users` WHERE `age` IS NOT NULL AND (`age` < -128 OR `age` > 127)',
    );
    const b = await run('ALTER TABLE users CHANGE name full_name VARCHAR(20) NOT NULL');
    expect(b.safety).toBe('check');
    expect(b.checks.map((c) => c.sql)).toEqual([
      'SELECT COUNT(*) FROM `users` WHERE `full_name` IS NOT NULL AND (CHAR_LENGTH(`full_name`) > 20)',
      'SELECT COUNT(*) FROM `users` WHERE `full_name` IS NULL',
    ]);
  });

  it('refuses transaction control and file access', async () => {
    await expect(run('COMMIT')).rejects.toThrow(Refusal);
    await expect(run("LOAD DATA LOCAL INFILE '/x' INTO TABLE users")).rejects.toThrow(Refusal);
  });

  it('always asks for SQLite structure changes', async () => {
    const lite: AnalysisContext = { flavor: 'sqlite', describe: async () => null };
    expect((await run('CREATE TABLE t (id INTEGER)', lite)).safety).toBe('destructive');
    expect((await run('INSERT INTO t VALUES (1)', lite)).safety).toBe('safe');
  });

  it('reads PostgreSQL and SQL Server column changes', async () => {
    const pg: AnalysisContext = {
      flavor: 'postgres',
      describe: async () => ({
        ...users,
        columns: [{ ...users.columns[1]!, nativeType: 'integer' }],
      }),
    };
    expect((await run('ALTER TABLE users ALTER COLUMN age TYPE bigint', pg)).safety).toBe('safe');
    expect((await run('ALTER TABLE users ALTER COLUMN age TYPE smallint', pg)).safety).toBe(
      'check',
    );
    expect(
      (await run('ALTER TABLE users ALTER COLUMN age TYPE text USING age::text', pg)).safety,
    ).toBe('destructive');
    const ms: AnalysisContext = { ...pg, flavor: 'mssql' };
    expect((await run('ALTER TABLE users ALTER COLUMN age bigint NULL', ms)).safety).toBe('safe');
  });
});
