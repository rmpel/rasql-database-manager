import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  shell,
} from 'electron';
import type { RemoteSession } from '@rasql/driver-sdk';
import type { DialectRpcMethod } from '@rasql/driver-protocol';
import type {
  ConfirmOptions,
  ConnectionDefinition,
  ExecResult,
  OpenSessionRequest,
  SerializableQueryOptions,
  TableMenuAction,
} from '@shared/api';
import { IPC } from '@shared/api';
import { listDrivers } from './drivers/registry';
import {
  addonStatus,
  discoverSites,
  installAddon,
  pendingConnectionFor,
  uninstallAddon,
} from './integrations/localwp';
import type { LocalSite } from '@shared/api';
import type { ConnectionStore } from './connections';
import { passwordAccount, type CredentialProvider } from './credentials';
import type { SessionManager } from './sessions';
import type { HistoryStore } from './history';
import type { HistoryEntry } from '@shared/api';
import type { WindowManager } from './windows';

/** Drain one statement's events into a result, or throw the engine's error. */
async function exec(session: RemoteSession, sql: string): Promise<ExecResult> {
  let result: ExecResult | null = null;
  for await (const event of session.query(sql, { maxRows: 1 })) {
    if (event.kind === 'error') {
      const err = new Error(event.message) as Error & { code: string; sqlState?: string };
      err.code = event.code;
      if (event.sqlState !== undefined) err.sqlState = event.sqlState;
      throw err;
    }
    if (event.kind === 'done' && !event.more) {
      result = { elapsedMs: event.elapsedMs };
      if (event.affectedRows !== undefined) result.affectedRows = event.affectedRows;
      if (event.insertId !== undefined) result.insertId = event.insertId;
      if (event.rowCount !== undefined) result.rowCount = event.rowCount;
    }
  }
  return result ?? { elapsedMs: 0 };
}

const windowOf = (e: IpcMainInvokeEvent): BrowserWindow => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) throw new Error('No window for this request');
  return win;
};

export function registerIpc(deps: {
  store: ConnectionStore;
  credentials: CredentialProvider;
  sessions: SessionManager;
  windows: WindowManager;
  history: HistoryStore;
}): void {
  const { store, credentials, sessions, windows, history } = deps;

  ipcMain.handle(IPC.historyList, (_e, connection: string, limit?: number) =>
    history.list(connection, limit),
  );
  ipcMain.handle(IPC.historyAdd, (_e, entry: Omit<HistoryEntry, 'id'>) => history.add(entry));
  ipcMain.handle(IPC.historyClear, (_e, connection: string) => history.clear(connection));

  ipcMain.handle(IPC.driversList, () => listDrivers());

  ipcMain.handle(IPC.connectionsList, () => store.list());
  ipcMain.handle(IPC.connectionsSave, (_e, def: ConnectionDefinition) => store.save(def));
  ipcMain.handle(IPC.connectionsRemove, async (_e, id: string) => {
    store.remove(id);
    await credentials.delete(passwordAccount(id));
  });
  ipcMain.handle(
    IPC.connectionsHasPassword,
    async (_e, id: string) => (await credentials.get(passwordAccount(id))) !== null,
  );
  ipcMain.handle(IPC.connectionsSetPassword, (_e, id: string, password: string) =>
    credentials.set(passwordAccount(id), password),
  );
  ipcMain.handle(IPC.connectionsForgetPassword, (_e, id: string) =>
    credentials.delete(passwordAccount(id)),
  );

  ipcMain.handle(IPC.sessionOpen, (e, req: OpenSessionRequest) => sessions.open(windowOf(e), req));
  ipcMain.handle(IPC.sessionClose, (_e, key: string) => sessions.close(key));
  ipcMain.handle(IPC.sessionListSchemas, (_e, key: string) => sessions.get(key).listSchemas());
  ipcMain.handle(IPC.sessionListObjects, (_e, key: string, schema: string) =>
    sessions.get(key).listObjects(schema),
  );
  ipcMain.handle(IPC.sessionDescribeTable, (_e, key: string, schema: string, table: string) =>
    sessions.get(key).describeTable(schema, table),
  );
  ipcMain.handle(
    IPC.sessionDialect,
    (_e, key: string, method: DialectRpcMethod, args: unknown[]) => {
      const dialect = sessions.get(key).dialect as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      const fn = dialect[method];
      if (!fn) throw new Error(`Unknown dialect method ${method}`);
      return fn(...args);
    },
  );
  ipcMain.handle(
    IPC.sessionQueryStart,
    (e, key: string, sql: string, opts?: SerializableQueryOptions) =>
      sessions.startQuery(windowOf(e), key, sql, opts),
  );
  ipcMain.handle(IPC.sessionQueryCancel, (_e, queryId: string) => sessions.cancelQuery(queryId));
  ipcMain.handle(IPC.sessionExec, (_e, key: string, sql: string) => exec(sessions.get(key), sql));
  ipcMain.handle(IPC.sessionExplain, (_e, key: string, sql: string) =>
    sessions.get(key).explain(sql),
  );
  ipcMain.handle(IPC.sessionTransaction, async (_e, key: string, statements: string[]) => {
    const session = sessions.get(key);
    const results: ExecResult[] = [];
    await session.begin();
    try {
      for (const sql of statements) results.push(await exec(session, sql));
      await session.commit();
    } catch (err) {
      await session.rollback().catch(() => undefined);
      const e = err instanceof Error ? err : new Error(String(err));
      e.message = `Statement ${results.length + 1} of ${statements.length} failed, nothing was committed: ${e.message}`;
      throw e;
    }
    return results;
  });

  ipcMain.handle(
    IPC.menuTableContext,
    (e, ctx: { schema: string; table: string; kind: 'table' | 'view' }) =>
      new Promise<TableMenuAction | null>((resolve) => {
        let chosen: TableMenuAction | null = null;
        const item = (
          label: string,
          action: TableMenuAction,
          extra: Partial<MenuItemConstructorOptions> = {},
        ): MenuItemConstructorOptions => ({
          label,
          click: () => {
            chosen = action;
          },
          ...extra,
        });
        const template: MenuItemConstructorOptions[] = [
          item('Open', 'open'),
          item('Structure', 'structure'),
          item('Refresh', 'refresh'),
          { type: 'separator' },
          item('Copy Name', 'copy-name'),
          item('Copy Qualified Name', 'copy-qualified'),
          item('Copy SELECT Statement', 'copy-select'),
          item('Copy CREATE Statement', 'copy-create'),
          { type: 'separator' },
          item(`Truncate ${ctx.table}…`, 'truncate', { enabled: ctx.kind === 'table' }),
          item(`Drop ${ctx.kind === 'view' ? 'View' : 'Table'} ${ctx.table}…`, 'drop'),
        ];
        Menu.buildFromTemplate(template).popup({
          window: windowOf(e),
          callback: () => resolve(chosen),
        });
      }),
  );

  ipcMain.handle(IPC.clipboardWriteText, (_e, text: string) => clipboard.writeText(text));

  ipcMain.handle(IPC.localwpStatus, () => addonStatus());
  ipcMain.handle(IPC.localwpInstall, () => installAddon());
  ipcMain.handle(IPC.localwpUninstall, () => uninstallAddon());
  ipcMain.handle(IPC.localwpSites, () => discoverSites());
  ipcMain.handle(IPC.localwpPending, (_e, site: LocalSite) => pendingConnectionFor(site));

  ipcMain.handle(IPC.dialogConfirm, async (e, opts: ConfirmOptions) => {
    const confirmLabel = opts.confirmLabel ?? 'OK';
    const result = await dialog.showMessageBox(windowOf(e), {
      type: opts.danger ? 'warning' : 'question',
      title: opts.title,
      message: opts.message,
      detail: opts.detail ?? '',
      buttons: [confirmLabel, 'Cancel'],
      defaultId: opts.danger ? 1 : 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  });

  ipcMain.handle(IPC.dialogOpenFile, async (e, opts: { title?: string; extensions?: string[] }) => {
    const result = await dialog.showOpenDialog(windowOf(e), {
      title: opts.title ?? 'Open database',
      properties: ['openFile'],
      filters: opts.extensions?.length
        ? [
            { name: 'Database', extensions: opts.extensions },
            { name: 'All files', extensions: ['*'] },
          ]
        : [{ name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.appNewWindow, () => {
    windows.create();
  });
  ipcMain.handle(IPC.appTakePending, (e) => windows.takePending(windowOf(e).id));
  ipcMain.handle(IPC.appRevealPath, (_e, path: string) => shell.showItemInFolder(path));
}
