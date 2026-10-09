import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import type { PendingConnection } from '@shared/api';
import { IPC } from '@shared/api';

/**
 * Window per connection (docs/DECISIONS.md D-09). Every window starts as a launcher; the
 * renderer turns it into a connection window once a session is open.
 */
export class WindowManager {
  private pendingByWindow = new Map<number, PendingConnection>();
  private orphanPending: PendingConnection | null = null;

  constructor(private readonly onClosed: (windowId: number) => void) {}

  create(pending?: PendingConnection): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'RaSQL',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 14, y: 14 },
      backgroundColor: '#1b1d22',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    if (pending) this.pendingByWindow.set(win.id, pending);
    win.once('ready-to-show', () => win.show());
    win.on('focus', () => {
      if (!win.isDestroyed()) win.webContents.send(IPC.appFocus);
    });
    win.on('closed', () => {
      this.pendingByWindow.delete(win.id);
      this.onClosed(win.id);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }
    return win;
  }

  /** Deliver a pending connection to a fresh launcher window. */
  deliver(pending: PendingConnection): void {
    const win = this.create(pending);
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.appPendingConnection, pending);
    });
  }

  takePending(windowId: number): PendingConnection | null {
    const p = this.pendingByWindow.get(windowId) ?? this.orphanPending;
    this.pendingByWindow.delete(windowId);
    this.orphanPending = null;
    return p ?? null;
  }

  /** For URLs that arrive before the app is ready. */
  stash(pending: PendingConnection): void {
    this.orphanPending = pending;
  }
}
