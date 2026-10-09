import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));
const { HistoryStore } = await import('./history');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rasql-history-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('HistoryStore', () => {
  it('keeps entries per connection, newest first, deduplicated, and survives a reload', () => {
    const file = join(dir, 'history.json');
    const store = new HistoryStore(file);
    store.add({ connection: 'a', sql: 'SELECT 1', startedAt: '2026-10-09T10:00:00Z', rowCount: 1 });
    store.add({ connection: 'a', sql: 'SELECT 2', startedAt: '2026-10-09T10:01:00Z', rowCount: 1 });
    store.add({ connection: 'b', sql: 'SELECT 3', startedAt: '2026-10-09T10:02:00Z' });
    store.add({
      connection: 'a',
      sql: 'SELECT 1',
      startedAt: '2026-10-09T10:03:00Z',
      error: 'boom',
    });
    expect(store.list('a').map((e) => [e.sql, e.error ?? null])).toEqual([
      ['SELECT 1', 'boom'],
      ['SELECT 2', null],
    ]);
    expect(new HistoryStore(file).list('b').map((e) => e.sql)).toEqual(['SELECT 3']);
    store.clear('a');
    expect(new HistoryStore(file).list('a')).toEqual([]);
    expect(new HistoryStore(file).list('b')).toHaveLength(1);
  });

  it('caps the list', () => {
    const store = new HistoryStore(join(dir, 'h.json'));
    for (let i = 0; i < 600; i++)
      store.add({ connection: 'a', sql: `SELECT ${i}`, startedAt: 'now' });
    expect(store.list('a', 1000)).toHaveLength(500);
    expect(store.list('a', 1)[0]?.sql).toBe('SELECT 599');
  });
});
