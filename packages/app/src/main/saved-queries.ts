import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedQuery, SavedQueryInput } from '@shared/api';

/**
 * Named queries, in the user data directory. A query belongs to one connection, or to every
 * connection when `connection` is null. Never contains results or secrets.
 */
export class SavedQueryStore {
  private readonly file: string;
  private cache: SavedQuery[] | null = null;

  constructor(file = join(app.getPath('userData'), 'saved-queries.json')) {
    this.file = file;
  }

  private load(): SavedQuery[] {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { queries?: SavedQuery[] };
      this.cache = parsed.queries ?? [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, queries: this.load() }, null, 2));
    renameSync(tmp, this.file);
  }

  /** This connection's queries and the shared ones, by name. */
  list(connection: string): SavedQuery[] {
    return this.load()
      .filter((q) => q.connection === null || q.connection === connection)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  save(input: SavedQueryInput): SavedQuery {
    const name = input.name.trim();
    if (!name) throw new Error('A saved query needs a name');
    const all = this.load();
    const now = new Date().toISOString();
    const existing = input.id ? all.find((q) => q.id === input.id) : undefined;
    const stored: SavedQuery = {
      id: existing?.id ?? randomUUID(),
      name,
      sql: input.sql,
      connection: input.connection,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.cache = existing ? all.map((q) => (q.id === stored.id ? stored : q)) : [...all, stored];
    this.persist();
    return stored;
  }

  remove(id: string): void {
    this.cache = this.load().filter((q) => q.id !== id);
    this.persist();
  }
}
