import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

export function installMenu(onShowLauncher: () => void, onIntegrateDesktop: () => void): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Connections…', accelerator: 'CmdOrCtrl+N', click: onShowLauncher },
        ...(process.platform === 'linux'
          ? [
              { type: 'separator' as const },
              { label: 'Integrate with Desktop…', click: onIntegrateDesktop },
            ]
          : []),
        { type: 'separator' },
        // Cmd+W belongs to the renderer: close tab, or the window when it is the last tab.
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
        ...(isMac ? [] : [{ role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'RaSQL on GitHub',
          click: () => void shell.openExternal('https://github.com/rmpel/rasql-database-manager'),
        },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
