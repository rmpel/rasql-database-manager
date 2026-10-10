import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC, type PickedFile } from '../shared/api';

const MAX_PICK_BYTES = 256 * 1024 * 1024;

/**
 * Files the renderer may read back: ones it saved, picked, or that we wrote for an external
 * editor. Anything else is refused, so a compromised renderer cannot read arbitrary files.
 */
export class CellFileRegistry {
  private readonly allowed = new Set<string>();
  private readonly temps = new Set<string>();

  constructor(private readonly tempDir: string) {}

  allow(path: string): void {
    this.allowed.add(path);
  }

  isAllowed(path: string): boolean {
    return this.allowed.has(path) || this.temps.has(path);
  }

  /** Write bytes to a fresh temp file with the given extension and remember it for cleanup. */
  writeTemp(bytes: Uint8Array, extension: string): string {
    mkdirSync(this.tempDir, { recursive: true });
    const ext = extension.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'bin';
    const path = join(this.tempDir, `rasql-${randomBytes(6).toString('hex')}.${ext}`);
    writeFileSync(path, bytes);
    this.temps.add(path);
    return path;
  }

  read(path: string): Uint8Array {
    if (!this.isAllowed(path))
      throw new Error('RaSQL may only read files it saved, opened or picked in this session');
    const data = readFileSync(path);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  cleanup(): void {
    for (const p of this.temps) rmSync(p, { force: true });
    this.temps.clear();
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  get tempCount(): number {
    return this.temps.size;
  }
}

export function pickedFileFromPath(path: string): PickedFile {
  const size = statSync(path).size;
  if (size > MAX_PICK_BYTES) {
    throw new Error(
      `That file is ${Math.round(size / 1024 / 1024)} MB; the limit for a cell is 256 MB`,
    );
  }
  const data = readFileSync(path);
  const file: PickedFile = {
    name: path.split(/[\\/]/).pop() ?? path,
    bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
  return file;
}

export function registerCellIpc(): CellFileRegistry {
  const registry = new CellFileRegistry(join(app.getPath('temp'), 'rasql-cells'));
  app.on('will-quit', () => registry.cleanup());

  const windowOf = (e: IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) throw new Error('No window for this request');
    return win;
  };

  ipcMain.handle(IPC.cellsPickFile, async (e, opts: { title?: string } = {}) => {
    const result = await dialog.showOpenDialog(windowOf(e), {
      title: opts.title ?? 'Choose a file for this cell',
      properties: ['openFile'],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    registry.allow(path);
    return pickedFileFromPath(path);
  });

  ipcMain.handle(IPC.cellsSaveFile, async (e, bytes: Uint8Array, suggestedName: string) => {
    const result = await dialog.showSaveDialog(windowOf(e), {
      title: 'Save cell contents',
      defaultPath: suggestedName,
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, bytes);
    registry.allow(result.filePath);
    return result.filePath;
  });

  ipcMain.handle(IPC.cellsOpenExternally, async (_e, bytes: Uint8Array, extension: string) => {
    const path = registry.writeTemp(bytes, extension);
    const error = await shell.openPath(path);
    if (error) throw new Error(`Could not open ${path}: ${error}`);
    return { path };
  });

  ipcMain.handle(IPC.cellsReadFile, (_e, path: string) => registry.read(path));

  return registry;
}
