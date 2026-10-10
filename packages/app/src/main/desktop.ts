import { app, dialog, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSettings, writeSettings } from './settings';
import { desktopIntegrationStatus, installDesktopIntegration } from './integrations/linux-desktop';

const bundledIcon = (): string | null => {
  const p = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
  return existsSync(p) ? p : null;
};

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
  try {
    await installDesktopIntegration(bundledIcon());
    log('[desktop] integration installed');
    await dialog.showMessageBox(win as BrowserWindow, {
      type: 'info',
      message: 'RaSQL is now in your applications menu and handles rasql:// links.',
      detail: `Written to ${status.desktopFile}. Some desktops need a logout to show the icon.`,
    });
  } catch (err) {
    await dialog.showMessageBox(win as BrowserWindow, {
      type: 'error',
      message: 'Desktop integration failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** On first launch of an AppImage, offer the integration once; "Never" is remembered. */
export async function offerDesktopIntegration(log: (line: string) => void): Promise<void> {
  const status = desktopIntegrationStatus();
  if (!status.applicable || status.installed) return;
  if (readSettings()['desktopIntegration'] === 'never') return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Add RaSQL to your applications menu?',
    detail:
      'This writes a desktop entry for your user that registers RaSQL for rasql:// links and SQLite files, which is what the LocalWP add-on and other tools use to open databases here. No administrator rights are needed.',
    buttons: ['Add', 'Not now', 'Never ask again'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 2) {
    writeSettings({ desktopIntegration: 'never' });
    return;
  }
  if (response !== 0) return;
  try {
    await installDesktopIntegration(bundledIcon());
    log('[desktop] integration installed on first launch');
  } catch (err) {
    log(`[desktop] integration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
