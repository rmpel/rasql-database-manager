import { describe, expect, it } from 'vitest';
import { flavorOf, splitStatements, statementAt } from './sql-split';

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(splitStatements('SELECT 1;\n  SELECT 2  ;SELECT 3').map((s) => s.sql)).toEqual([
      'SELECT 1',
      'SELECT 2',
      'SELECT 3',
    ]);
  });

  it('ignores semicolons in strings, quoted identifiers and comments', () => {
    const text = `SELECT 'a;b', "c;d", \`e;f\` -- x; y\n/* z; */ FROM t; SELECT 2 # tail;`;
    expect(splitStatements(text).map((s) => s.sql)).toEqual([
      `SELECT 'a;b', "c;d", \`e;f\` -- x; y\n/* z; */ FROM t`,
      'SELECT 2 # tail;',
    ]);
  });

  it('handles escaped quotes and unterminated input', () => {
    expect(splitStatements(`SELECT 'it\\'s; fine'; SELECT 'open`).map((s) => s.sql)).toEqual([
      `SELECT 'it\\'s; fine'`,
      `SELECT 'open`,
    ]);
  });

  it('reports ranges that index back into the text', () => {
    const text = '  SELECT 1;\n\nSELECT 2;';
    const [a, b] = splitStatements(text);
    expect(text.slice(a!.start, a!.end)).toBe('SELECT 1');
    expect(text.slice(b!.start, b!.end)).toBe('SELECT 2');
  });

  it('returns nothing for blank or comment-only text', () => {
    expect(splitStatements('   \n-- nothing\n')).toEqual([]);
  });
});

describe('statementAt', () => {
  const text = 'SELECT 1;\nSELECT 2;\n\nSELECT 3';
  it('finds the statement under the cursor', () => {
    expect(statementAt(text, 3)?.sql).toBe('SELECT 1');
    expect(statementAt(text, 12)?.sql).toBe('SELECT 2');
    expect(statementAt(text, text.length)?.sql).toBe('SELECT 3');
  });
  it('maps a gap to the preceding statement', () => {
    expect(statementAt(text, 20)?.sql).toBe('SELECT 2');
  });
  it('falls back to the first statement before any text', () => {
    expect(statementAt('\n\nSELECT 9', 0)?.sql).toBe('SELECT 9');
    expect(statementAt('', 0)).toBeNull();
  });
});

describe('splitStatements per engine', () => {
  const sqls = (text: string, flavor: Parameters<typeof splitStatements>[1]) =>
    splitStatements(text, flavor).map((s) => s.sql);

  it('keeps PostgreSQL dollar quotes, E-strings and operators whole', () => {
    const fn = `CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql`;
    expect(sqls(`${fn}; SELECT $$a;b$$; SELECT data #>> '{a}' FROM t`, 'postgres')).toEqual([
      fn,
      'SELECT $$a;b$$',
      "SELECT data #>> '{a}' FROM t",
    ]);
    // A backslash ends nothing in a standard string, but escapes in an E-string.
    expect(sqls(`SELECT 'C:\\'; SELECT E'it\\'s;'; SELECT 3`, 'postgres')).toEqual([
      `SELECT 'C:\\'`,
      `SELECT E'it\\'s;'`,
      'SELECT 3',
    ]);
    expect(sqls('SELECT 1 /* a /* nested; */ still; */; SELECT $1', 'postgres')).toEqual([
      'SELECT 1 /* a /* nested; */ still; */',
      'SELECT $1',
    ]);
  });

  it('splits SQL Server on GO lines and keeps BEGIN … END blocks together', () => {
    const proc = `CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  IF 1 = 1 BEGIN SELECT CASE WHEN 1 = 1 THEN 'a;' END; END;\nEND`;
    expect(
      sqls(`${proc}\nGO\nSELECT [a;b] FROM t; BEGIN TRAN; SELECT 2\ngo 3\nSELECT 'go'`, 'mssql'),
    ).toEqual([proc, 'SELECT [a;b] FROM t', 'BEGIN TRAN', 'SELECT 2', "SELECT 'go'"]);
    // GO inside a line, or as part of a word, is not a separator.
    expect(sqls('SELECT 1 AS go\nSELECT 2 AS gone', 'mssql')).toEqual([
      'SELECT 1 AS go\nSELECT 2 AS gone',
    ]);
  });

  it('reads # as an operator, not a comment, outside MySQL', () => {
    expect(sqls('SELECT 5 # 3; SELECT 2', 'sqlite')).toEqual(['SELECT 5 # 3', 'SELECT 2']);
    expect(sqls('SELECT 5 # 3; SELECT 2', 'mysql')).toEqual(['SELECT 5 # 3; SELECT 2']);
  });

  it('maps engines to flavors', () => {
    expect(['mysql', 'mariadb', 'postgres', 'mssql', 'azure-sql', 'sqlite'].map(flavorOf)).toEqual([
      'mysql',
      'mysql',
      'postgres',
      'mssql',
      'mssql',
      'sqlite',
    ]);
  });
});
