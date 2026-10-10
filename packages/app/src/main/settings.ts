import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Small persisted preferences: window bounds, one-time prompts. Never secrets. */
const file = (): string => join(app.getPath('userData'), 'settings.json');

export function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeSettings(patch: Record<string, unknown>): void {
  const next = { ...readSettings(), ...patch };
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
}
