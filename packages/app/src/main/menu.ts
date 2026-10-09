import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

export function installMenu(onNewWindow: () => void, onIntegrateDesktop: () => void): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Connection Window', accelerator: 'CmdOrCtrl+N', click: onNewWindow },
        ...(process.platform === 'linux'
          ? [
              { type: 'separator' as const },
              { label: 'Integrate with Desktop…', click: onIntegrateDesktop },
            ]
          : []),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
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
