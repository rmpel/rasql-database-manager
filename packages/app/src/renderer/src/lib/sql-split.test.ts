import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt } from './sql-split';

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
