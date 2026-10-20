import { app, BrowserWindow, nativeImage } from 'electron';
import { join } from 'node:path';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { ConnectionStore } from './connections';
import { HistoryStore } from './history';
import { SavedQueryStore } from './saved-queries';
import { createCredentialProvider } from './credentials';
import { parseLaunchArgument, redactUrl } from './deeplink';
import { registerCellIpc } from './cells';
import { registerExportIpc } from './export';
import { registerIpc } from './ipc';
import { installMenu } from './menu';
import { offerDesktopIntegration, integrateDesktop } from './desktop';
import { SessionManager } from './sessions';
import { createSshTunnelManager, registerSshIpc } from './ssh/ipc';
import { WindowManager } from './windows';
import { startMcp } from './mcp';
import { mcpSocketPath } from './mcp/paths';
import { runBridge } from '@rasql/mcp';
import { spawn } from 'node:child_process';

const log = (line: string): void => {
  console.log(`${new Date().toISOString()} ${line}`);
};

// In development the binary is Electron's own; give it our name and icon anyway.
app.setName('RaSQL');

// Tests and parallel installs point this at a scratch directory so they never touch real data.
if (process.env['RASQL_USER_DATA']) app.setPath('userData', process.env['RASQL_USER_DATA']);

const launchArgs = process.argv.slice(app.isPackaged ? 1 : 2);
if (launchArgs[0] === 'mcp') runMcpBridge();
else startApp();

/**
 * `rasql mcp`: relay MCP messages between stdio and the running app (MCP.md section 8).
 * Starts the app when it is not running. Writes nothing to stdout but the protocol.
 */
function runMcpBridge(): void {
  app.dock?.hide();
  const launchApp = (): void => {
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    // Unpackaged, Electron needs the app path it was started with, minus the `mcp` argument.
    const args = app.isPackaged ? [] : process.argv.slice(1, process.argv.indexOf('mcp'));
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }).unref();
  };
  void runBridge({ path: mcpSocketPath(), launchApp }).then((code) => app.exit(code));
}

function startApp(): void {
  const credentials = createCredentialProvider(log);
  // End-to-end tests reach the credential store through this hook to clean up what they created.
  if (process.env['RASQL_E2E_HOOKS'])
    (globalThis as Record<string, unknown>)['__rasql'] = { credentials };
  const store = new ConnectionStore();
  const history = new HistoryStore();
  const savedQueries = new SavedQueryStore();
  const tunnels = createSshTunnelManager(log);
  const sessions = new SessionManager(credentials, log, tunnels);
  const windows = new WindowManager((windowId) => void sessions.closeForWindow(windowId));
  let stopMcp: (() => Promise<void>) | null = null;
  sessions.attachWindows(windows);

  const handleArgument = (arg: string): boolean => {
    const pending = parseLaunchArgument(arg);
    if (!pending) return false;
    log(`open request: ${redactUrl(arg)}`);
    if (app.isReady()) windows.deliver(pending);
    else windows.stash(pending);
    return true;
  };

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      const handled = argv.slice(1).some(handleArgument);
      if (!handled) {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.focus();
        else windows.showLauncher();
      }
    });

    // macOS delivers URLs and files through these events, possibly before 'ready'.
    app.on('open-url', (e, url) => {
      e.preventDefault();
      handleArgument(url);
    });
    app.on('open-file', (e, path) => {
      e.preventDefault();
      handleArgument(path);
    });

    void app.whenReady().then(() => {
      electronApp.setAppUserModelId('nl.remonpel.rasql');
      if (is.dev && process.platform === 'darwin') {
        const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build/icon.png'));
        if (!icon.isEmpty()) app.dock?.setIcon(icon);
      }
      // postgres, postgresql, mssql and sqlserver are declared in electron-builder.yml so the user
      // can pick RaSQL for them, but not claimed here: other tools may already own them (D-39).
      if (app.isPackaged) {
        for (const scheme of ['rasql', 'mysql', 'mariadb', 'sqlite'])
          app.setAsDefaultProtocolClient(scheme);
      }
      app.on('browser-window-created', (_e, win) => optimizer.watchWindowShortcuts(win));

      registerIpc({ store, credentials, sessions, windows, history, savedQueries });
      stopMcp = startMcp({ store, credentials, sessions, windows, log });
      registerExportIpc({ sessions });
      registerCellIpc();
      registerSshIpc({ credentials });
      installMenu(
        () => windows.showLauncher(),
        () => void integrateDesktop(log),
        () => windows.showMcp(),
      );

      const launchedWith = process.argv
        .slice(app.isPackaged ? 1 : 2)
        .find((a) => !a.startsWith('-'));
      const pending = launchedWith ? parseLaunchArgument(launchedWith) : null;
      if (pending) windows.deliver(pending);
      else windows.showLauncher();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) windows.showLauncher();
      });

      void offerDesktopIntegration(log);
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', () => {
      void (stopMcp?.() ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => sessions.closeAll())
        .finally(() => tunnels.closeAll());
    });
  }
}
