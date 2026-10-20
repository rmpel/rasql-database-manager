import { app } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '@rasql/mcp';
import type { McpAuditRecord } from '@shared/api';

/** Entries kept; older ones are dropped when the log grows past this by a quarter. */
const KEEP = 20_000;

/**
 * Every MCP action, refused ones included, one JSON object per line in the user data
 * directory (MCP.md section 7). Statements are stored as sent; passwords never reach it,
 * because create_connection is audited without its arguments.
 */
export class AuditLog {
  private readonly file = join(app.getPath('userData'), 'mcp-audit.jsonl');
  private lines: number | null = null;

  append(entry: AuditEntry): McpAuditRecord {
    const record: McpAuditRecord = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.lines = (this.lines ?? this.read().length) + 1;
    if (this.lines > KEEP * 1.25) this.trim();
    return record;
  }

  /** Newest first. */
  list(filter: { client?: string; connectionId?: string; limit?: number } = {}): McpAuditRecord[] {
    const limit = filter.limit ?? 500;
    const out: McpAuditRecord[] = [];
    const all = this.read();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const r = all[i] as McpAuditRecord;
      if (filter.client && r.client !== filter.client) continue;
      if (filter.connectionId && r.connectionId !== filter.connectionId) continue;
      out.push(r);
    }
    return out;
  }

  clear(): void {
    writeFileSync(this.file, '', { mode: 0o600 });
    this.lines = 0;
  }

  private read(): McpAuditRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: McpAuditRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as McpAuditRecord);
      } catch {
        /* a torn line from a crash */
      }
    }
    return out;
  }

  private trim(): void {
    const keep = this.read().slice(-KEEP);
    writeFileSync(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    this.lines = keep.length;
  }
}
