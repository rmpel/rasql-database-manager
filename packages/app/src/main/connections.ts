import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionDefinition } from '@shared/api';

/** Saved connections, as JSON in the user data directory. Never contains a secret. */
export class ConnectionStore {
  private readonly file = join(app.getPath('userData'), 'connections.json');
  private cache: ConnectionDefinition[] | null = null;

  list(): ConnectionDefinition[] {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        connections?: ConnectionDefinition[];
      };
      this.cache = parsed.connections ?? [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  save(def: ConnectionDefinition): ConnectionDefinition {
    const all = this.list();
    const now = new Date().toISOString();
    const next: ConnectionDefinition = {
      ...def,
      id: def.id || randomUUID(),
      createdAt: def.createdAt || now,
      updatedAt: now,
    };
    const idx = all.findIndex((c) => c.id === next.id);
    if (idx === -1) all.push(next);
    else all[idx] = next;
    this.persist();
    return next;
  }

  remove(id: string): void {
    this.cache = this.list().filter((c) => c.id !== id);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, connections: this.list() }, null, 2));
    renameSync(tmp, this.file);
  }
}
