import { contextBridge, ipcRenderer } from 'electron';
import type { ExportProgress, PendingConnection, QueryEventMessage, RasqlApi } from '@shared/api';
import { IPC } from '@shared/api';

const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

const api: RasqlApi = {
  drivers: {
    list: () => ipcRenderer.invoke(IPC.driversList),
  },
  connections: {
    list: () => ipcRenderer.invoke(IPC.connectionsList),
    save: (def) => ipcRenderer.invoke(IPC.connectionsSave, def),
    remove: (id) => ipcRenderer.invoke(IPC.connectionsRemove, id),
    hasStoredPassword: (id) => ipcRenderer.invoke(IPC.connectionsHasPassword, id),
    setPassword: (id, password) => ipcRenderer.invoke(IPC.connectionsSetPassword, id, password),
    forgetPassword: (id) => ipcRenderer.invoke(IPC.connectionsForgetPassword, id),
    hasSecret: (id, kind) => ipcRenderer.invoke(IPC.connectionsHasSecret, id, kind),
    setSecret: (id, kind, secret) => ipcRenderer.invoke(IPC.connectionsSetSecret, id, kind, secret),
    forgetSecret: (id, kind) => ipcRenderer.invoke(IPC.connectionsForgetSecret, id, kind),
  },
  ssh: {
    aliases: () => ipcRenderer.invoke(IPC.sshAliases),
  },
  session: {
    open: (req) => ipcRenderer.invoke(IPC.sessionOpen, req),
    describe: (key) => ipcRenderer.invoke(IPC.sessionDescribe, key),
    close: (key) => ipcRenderer.invoke(IPC.sessionClose, key),
    listSchemas: (key) => ipcRenderer.invoke(IPC.sessionListSchemas, key),
    listObjects: (key, schema) => ipcRenderer.invoke(IPC.sessionListObjects, key, schema),
    describeTable: (key, schema, table) =>
      ipcRenderer.invoke(IPC.sessionDescribeTable, key, schema, table),
    dialect: (key, method, args) => ipcRenderer.invoke(IPC.sessionDialect, key, method, args),
    startQuery: (key, sql, opts) => ipcRenderer.invoke(IPC.sessionQueryStart, key, sql, opts),
    cancelQuery: (queryId) => ipcRenderer.invoke(IPC.sessionQueryCancel, queryId),
    onQueryEvent: (listener) => subscribe<QueryEventMessage>(IPC.sessionQueryEvent, listener),
    exec: (key, sql) => ipcRenderer.invoke(IPC.sessionExec, key, sql),
    explain: (key, sql) => ipcRenderer.invoke(IPC.sessionExplain, key, sql),
    transaction: (key, statements) => ipcRenderer.invoke(IPC.sessionTransaction, key, statements),
  },
  history: {
    list: (connection, limit) => ipcRenderer.invoke(IPC.historyList, connection, limit),
    add: (entry) => ipcRenderer.invoke(IPC.historyAdd, entry),
    clear: (connection) => ipcRenderer.invoke(IPC.historyClear, connection),
  },
  export: {
    start: (req) => ipcRenderer.invoke(IPC.exportStart, req),
    cancel: (exportId) => ipcRenderer.invoke(IPC.exportCancel, exportId),
    onProgress: (listener) => subscribe<ExportProgress>(IPC.exportProgress, listener),
  },
  localwp: {
    status: () => ipcRenderer.invoke(IPC.localwpStatus),
    installAddon: () => ipcRenderer.invoke(IPC.localwpInstall),
    uninstallAddon: () => ipcRenderer.invoke(IPC.localwpUninstall),
    sites: () => ipcRenderer.invoke(IPC.localwpSites),
    pendingFor: (site) => ipcRenderer.invoke(IPC.localwpPending, site),
  },
  menu: {
    tableContext: (ctx) => ipcRenderer.invoke(IPC.menuTableContext, ctx),
  },
  cells: {
    pickFile: (opts) => ipcRenderer.invoke(IPC.cellsPickFile, opts),
    saveFile: (bytes, suggestedName) => ipcRenderer.invoke(IPC.cellsSaveFile, bytes, suggestedName),
    openExternally: (bytes, extension) =>
      ipcRenderer.invoke(IPC.cellsOpenExternally, bytes, extension),
    readFile: (path) => ipcRenderer.invoke(IPC.cellsReadFile, path),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(IPC.clipboardWriteText, text),
  },
  dialog: {
    openFile: (opts) => ipcRenderer.invoke(IPC.dialogOpenFile, opts),
    confirm: (opts) => ipcRenderer.invoke(IPC.dialogConfirm, opts),
  },
  app: {
    platform: process.platform,
    version: __APP_VERSION__,
    showLauncher: () => ipcRenderer.invoke(IPC.appShowLauncher),
    closeWindow: () => ipcRenderer.invoke(IPC.appCloseWindow),
    onPendingConnection: (listener) =>
      subscribe<PendingConnection>(IPC.appPendingConnection, listener),
    takePendingConnection: () => ipcRenderer.invoke(IPC.appTakePending),
    onFocus: (listener) => subscribe<void>(IPC.appFocus, () => listener()),
    revealPath: (path) => ipcRenderer.invoke(IPC.appRevealPath, path),
  },
};

contextBridge.exposeInMainWorld('rasql', api);
