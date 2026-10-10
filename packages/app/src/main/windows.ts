import { BrowserWindow, screen, shell, type Rectangle } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import type { PendingConnection } from '@shared/api';
import { IPC } from '@shared/api';
import { readSettings, writeSettings } from './settings';

type Kind = 'launcher' | 'connection';

const DEFAULTS: Record<
  Kind,
  { width: number; height: number; minWidth: number; minHeight: number }
> = {
  launcher: { width: 960, height: 640, minWidth: 720, minHeight: 480 },
  connection: { width: 1280, height: 820, minWidth: 720, minHeight: 480 },
};

/**
 * One long-lived connection manager window plus one window per open session
 * (docs/DECISIONS.md D-09, revised). Closing a connection window ends its session; closing the
 * manager leaves open connections alone. The renderer picks its role from the URL hash.
 */
export class WindowManager {
  private launcher: BrowserWindow | null = null;
  private orphanPending: PendingConnection | null = null;
  private readonly pendingByWindow = new Map<number, PendingConnection>();

  constructor(private readonly onClosed: (windowId: number) => void) {}

  /** Show the manager, creating it when needed. Optionally hands it a connection to open. */
  showLauncher(pending?: PendingConnection): BrowserWindow {
    if (this.launcher && !this.launcher.isDestroyed()) {
      if (pending) this.launcher.webContents.send(IPC.appPendingConnection, pending);
      if (this.launcher.isMinimized()) this.launcher.restore();
      this.launcher.focus();
      return this.launcher;
    }
    const win = this.build('launcher', 'launcher');
    win.setTitle('RaSQL — Connections');
    this.launcher = win;
    if (pending) this.pendingByWindow.set(win.id, pending);
    win.on('closed', () => {
      if (this.launcher === win) this.launcher = null;
    });
    return win;
  }

  /** A window for one open session. The renderer loads the session's details by key. */
  createConnection(sessionKey: string, title: string): BrowserWindow {
    const win = this.build('connection', `connection/${sessionKey}`);
    win.setTitle(`${title} — RaSQL`);
    return win;
  }

  /** Deliver a pending connection (deep link, file, CLI) to the manager. */
  deliver(pending: PendingConnection): void {
    this.showLauncher(pending);
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

  private build(kind: Kind, route: string): BrowserWindow {
    const bounds = this.restoreBounds(kind);
    const win = new BrowserWindow({
      ...DEFAULTS[kind],
      ...bounds,
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
    win.once('ready-to-show', () => win.show());
    win.on('focus', () => {
      if (!win.isDestroyed()) win.webContents.send(IPC.appFocus);
    });
    let saveTimer: NodeJS.Timeout | null = null;
    const remember = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) {
          writeSettings({ [`bounds.${kind}`]: win.getNormalBounds() });
        }
      }, 400);
    };
    win.on('resize', remember);
    win.on('move', remember);
    win.on('closed', () => {
      if (saveTimer) clearTimeout(saveTimer);
      this.pendingByWindow.delete(win.id);
      this.onClosed(win.id);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${route}`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route });
    }
    return win;
  }

  /** Last bounds for this kind of window, if they still fit a display; connection windows cascade. */
  private restoreBounds(kind: Kind): Partial<Rectangle> {
    const saved = readSettings()[`bounds.${kind}`] as Rectangle | undefined;
    let bounds: Partial<Rectangle> = {};
    if (saved && typeof saved.width === 'number') {
      const display = screen.getDisplayMatching(saved);
      const inside =
        saved.x >= display.workArea.x - 50 &&
        saved.y >= display.workArea.y - 50 &&
        saved.x < display.workArea.x + display.workArea.width - 100 &&
        saved.y < display.workArea.y + display.workArea.height - 100;
      bounds = inside ? saved : { width: saved.width, height: saved.height };
    }
    if (kind === 'connection') {
      const others = BrowserWindow.getAllWindows().filter(
        (w) => w !== this.launcher && !w.isDestroyed(),
      );
      const top = others[others.length - 1];
      if (top && bounds.x !== undefined && bounds.y !== undefined) {
        const t = top.getBounds();
        bounds = { ...bounds, x: t.x + 28, y: t.y + 28 };
      }
    }
    return bounds;
  }
}
