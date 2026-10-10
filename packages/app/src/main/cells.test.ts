import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', on: () => undefined },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {},
}));

const { CellFileRegistry, pickedFileFromPath } = await import('./cells');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rasql-cells-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CellFileRegistry', () => {
  it('only reads files it was told about', () => {
    const r = new CellFileRegistry(join(dir, 'temp'));
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'nope');
    expect(() => r.read(secret)).toThrow(/only read files/);
    r.allow(secret);
    expect(new TextDecoder().decode(r.read(secret))).toBe('nope');
  });

  it('writes temp files with a sanitised extension and removes them on cleanup', () => {
    const r = new CellFileRegistry(join(dir, 'temp'));
    const p = r.writeTemp(new Uint8Array([1, 2, 3]), '../p.n/g');
    expect(p.startsWith(join(dir, 'temp'))).toBe(true);
    expect(p.endsWith('.png')).toBe(true);
    expect(Array.from(r.read(p))).toEqual([1, 2, 3]);
    expect(r.tempCount).toBe(1);
    r.cleanup();
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(dir, 'temp'))).toBe(false);
    expect(r.tempCount).toBe(0);
  });

  it('defaults the extension when nothing usable is given', () => {
    const r = new CellFileRegistry(join(dir, 'temp'));
    expect(r.writeTemp(new Uint8Array(), '!!!').endsWith('.bin')).toBe(true);
    r.cleanup();
  });
});

describe('pickedFileFromPath', () => {
  it('returns the name and bytes', () => {
    const p = join(dir, 'photo.jpg');
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff]));
    const f = pickedFileFromPath(p);
    expect(f.name).toBe('photo.jpg');
    expect(Array.from(f.bytes)).toEqual([0xff, 0xd8, 0xff]);
    expect(readFileSync(p).length).toBe(3);
  });
});
