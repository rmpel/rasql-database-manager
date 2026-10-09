import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryEntry } from '@shared/api';

const MAX_PER_CONNECTION = 500;

/** Query history, per connection, newest first, in the user data directory. Never contains results. */
export class HistoryStore {
  private readonly file: string;
  private cache: Record<string, HistoryEntry[]> | null = null;

  constructor(file = join(app.getPath('userData'), 'history.json')) {
    this.file = file;
  }

  private load(): Record<string, HistoryEntry[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, HistoryEntry[]>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.load()));
    renameSync(tmp, this.file);
  }

  list(connection: string, limit = 100): HistoryEntry[] {
    return (this.load()[connection] ?? []).slice(0, limit);
  }

  add(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const all = this.load();
    const list = all[entry.connection] ?? [];
    // The same statement run again moves to the top instead of piling up.
    const deduped = list.filter((e) => e.sql !== entry.sql);
    const stored: HistoryEntry = { ...entry, id: randomUUID() };
    all[entry.connection] = [stored, ...deduped].slice(0, MAX_PER_CONNECTION);
    this.persist();
    return stored;
  }

  clear(connection: string): void {
    const all = this.load();
    delete all[connection];
    this.persist();
  }
}
