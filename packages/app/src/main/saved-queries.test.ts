import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
const { SavedQueryStore } = await import('./saved-queries');

describe('SavedQueryStore', () => {
  it('lists a connection with the shared queries, by name, and survives a reload', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rasql-saved-')), 'saved.json');
    const store = new SavedQueryStore(file);
    store.save({ name: 'zeta', sql: 'SELECT 2', connection: 'a' });
    const shared = store.save({ name: 'Alpha', sql: 'SELECT 1', connection: null });
    store.save({ name: 'other', sql: 'SELECT 3', connection: 'b' });
    expect(store.list('a').map((q) => q.name)).toEqual(['Alpha', 'zeta']);

    const updated = store.save({
      id: shared.id,
      name: ' Alpha ',
      sql: 'SELECT 10',
      connection: null,
    });
    expect(updated).toMatchObject({ id: shared.id, name: 'Alpha', sql: 'SELECT 10' });
    expect(updated.createdAt).toBe(shared.createdAt);

    const again = new SavedQueryStore(file);
    expect(again.list('b').map((q) => q.sql)).toEqual(['SELECT 10', 'SELECT 3']);
    again.remove(shared.id);
    expect(JSON.parse(readFileSync(file, 'utf8')).queries).toHaveLength(2);
    expect(() => again.save({ name: '  ', sql: 'x', connection: null })).toThrow();
  });
});
