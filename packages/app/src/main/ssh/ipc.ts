import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC, type SecretKind } from '@shared/api';
import { secretAccount, type CredentialProvider } from '../credentials';
import { listAliases, loadUserSshConfig } from './config';
import { SshTunnelManager, type UnknownHostInfo } from './tunnel';

/** The tunnel manager as the app uses it: unknown host keys are confirmed in a native dialog. */
export function createSshTunnelManager(log: (line: string) => void): SshTunnelManager {
  const confirmUnknownHost = async (info: UnknownHostInfo): Promise<boolean> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Unknown SSH host',
      message: `The authenticity of ${info.host}${info.port === 22 ? '' : `:${info.port}`} cannot be established.`,
      detail: `${info.keyType} key fingerprint is\n${info.fingerprint}\n\nIf you accept, RaSQL records it in its own known_hosts and refuses the host if the key ever changes.`,
      buttons: ['Accept and connect', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result.response === 0;
  };
  return new SshTunnelManager({ userDataDir: app.getPath('userData'), confirmUnknownHost, log });
}

export function registerSshIpc(deps: { credentials: CredentialProvider }): void {
  const { credentials } = deps;
  ipcMain.handle(IPC.sshAliases, () => listAliases(loadUserSshConfig()));
  ipcMain.handle(
    IPC.connectionsHasSecret,
    async (_e, id: string, kind: SecretKind) =>
      (await credentials.get(secretAccount(id, kind))) !== null,
  );
  ipcMain.handle(IPC.connectionsSetSecret, (_e, id: string, kind: SecretKind, secret: string) =>
    credentials.set(secretAccount(id, kind), secret),
  );
  ipcMain.handle(IPC.connectionsForgetSecret, (_e, id: string, kind: SecretKind) =>
    credentials.delete(secretAccount(id, kind)),
  );
}
