import { app, dialog, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSettings, writeSettings } from './settings';
import {
  desktopIntegrationStatus,
  installDesktopIntegration,
  placeAppImage,
  type DesktopIntegrationStatus,
} from './integrations/linux-desktop';

const bundledIcon = (): string | null => {
  const p = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
  return existsSync(p) ? p : null;
};

const tilde = (path: string): string =>
  path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path;

/**
 * Move the AppImage into place when asked, then write the desktop entry for wherever it ends up.
 * After a move this process keeps running from its mount; APPIMAGE is updated so later status
 * checks in this session see the new path.
 */
async function integrate(
  status: DesktopIntegrationStatus,
  move: boolean,
): Promise<DesktopIntegrationStatus> {
  let executable = status.executable;
  if (move && executable) {
    executable = placeAppImage(executable);
    process.env['APPIMAGE'] = executable;
  }
  return installDesktopIntegration(bundledIcon(), executable ? { appImage: executable } : {});
}

const placementDetail = (status: DesktopIntegrationStatus): string =>
  [
    `RaSQL is running from ${tilde(dirname(status.executable ?? ''))}.`,
    `Moving it to ${tilde(status.target)} gives it a fixed place${existsSync(status.target) ? ' and replaces the copy that is there now' : ''}, so a newer download can replace it later without breaking the menu entry.`,
    'Either way, RaSQL is added to your applications menu and registered for rasql:// links and SQLite files, which is what the LocalWP add-on and other tools use to open databases here. No administrator rights are needed.',
  ].join('\n\n');

/** The File menu entry: install (or reinstall) the desktop entry and tell the user. */
export async function integrateDesktop(log: (line: string) => void): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const status = desktopIntegrationStatus();
  if (!status.applicable) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Desktop integration is for the Linux AppImage.',
      detail:
        'A .deb installation already has a system-wide menu entry, and macOS and Windows register RaSQL at install time.',
    });
    return;
  }
  let move = false;
  if (!status.placed) {
    const { response } = await dialog.showMessageBox(win as BrowserWindow, {
      type: 'question',
      message: `Move RaSQL to ${tilde(status.target)}?`,
      detail: placementDetail(status),
      buttons: ['Move and add to menu', 'Keep it here and add to menu', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return;
    move = response === 0;
  }
  try {
    const done = await integrate(status, move);
    log(`[desktop] integration installed for ${done.executable ?? '?'}`);
    await dialog.showMessageBox(win as BrowserWindow, {
      type: 'info',
      message: 'RaSQL is now in your applications menu and handles rasql:// links.',
      detail: `${move ? `RaSQL now lives at ${tilde(done.executable ?? status.target)}. ` : ''}The menu entry is ${tilde(done.desktopFile)}. Some desktops need a logout to show the icon.`,
    });
  } catch (err) {
    await dialog.showMessageBox(win as BrowserWindow, {
      type: 'error',
      message: 'Desktop integration failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * On launch of an AppImage that is not in place or not in the menu, offer to fix that; "Never"
 * is remembered. A newer download run from ~/Downloads is offered the move again, which replaces
 * the older copy in ~/Applications.
 */
export async function offerDesktopIntegration(log: (line: string) => void): Promise<void> {
  const status = desktopIntegrationStatus();
  if (!status.applicable || (status.installed && status.placed)) return;
  if (readSettings()['desktopIntegration'] === 'never') return;
  const { response } = status.placed
    ? await dialog
        .showMessageBox({
          type: 'question',
          message: 'Add RaSQL to your applications menu?',
          detail:
            'This writes a desktop entry for your user that registers RaSQL for rasql:// links and SQLite files, which is what the LocalWP add-on and other tools use to open databases here. No administrator rights are needed.',
          buttons: ['Add', 'Not now', 'Never ask again'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        // Same answers as the placement dialog below: 0 move (nothing to move here), 2 not now.
        .then(({ response }) => ({ response: [0, 2, 3][response] ?? 2 }))
    : await dialog.showMessageBox({
        type: 'question',
        message: `Install RaSQL in ${tilde(dirname(status.target))}?`,
        detail: placementDetail(status),
        buttons: [
          'Move and add to menu',
          'Keep it here and add to menu',
          'Not now',
          'Never ask again',
        ],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
  if (response === 3) {
    writeSettings({ desktopIntegration: 'never' });
    return;
  }
  if (response === 2) return;
  try {
    const done = await integrate(status, response === 0 && !status.placed);
    log(`[desktop] integration installed for ${done.executable ?? '?'}`);
  } catch (err) {
    log(`[desktop] integration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
