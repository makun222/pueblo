import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { DesktopMenuAction } from '../shared/ipc-contract';

const MENU_ACTION_CHANNEL = 'desktop-menu-action';

export function installDesktopApplicationMenu(
  mainWindow: BrowserWindow,
  onOpenMcp?: () => void,
  onOpenClock?: () => void,
): void {
  const template = buildDesktopMenuTemplate(mainWindow, onOpenMcp, onOpenClock);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildDesktopMenuTemplate(
  mainWindow: BrowserWindow,
  onOpenMcp?: () => void,
  onOpenClock?: () => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }

  template.push(
    {
      label: 'File',
      submenu: [
        {
          label: 'New Conversation',
          click: () => emitMenuAction(mainWindow, 'new-conversation'),
        },
        {
          label: 'Switch Agent',
          click: () => emitMenuAction(mainWindow, 'switch-agent'),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Show Monitor',
          click: () => emitMenuAction(mainWindow, 'show-monitor'),
        },
        {
          label: 'Show Tool Approvals',
          click: () => emitMenuAction(mainWindow, 'show-tool-approvals'),
        },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Configure Provider',
          click: () => emitMenuAction(mainWindow, 'configure-provider'),
        },
        {
          label: 'Switch Agent',
          click: () => emitMenuAction(mainWindow, 'switch-agent'),
        },
        { type: 'separator' },
        {
          label: 'MCP Manager',
          enabled: true,
          click: () => {
            if (onOpenMcp) {
              onOpenMcp();
            }
          },
        },
        {
          label: 'DeskClock',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            if (onOpenClock) {
              onOpenClock();
            }
          },
        },
        {
          label: 'Cron Scheduler',
          enabled: false,
        },
        {
          label: 'Hooks',
          enabled: false,
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' as const }, { role: 'front' as const }, { type: 'separator' as const }, { role: 'window' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Pueblo Repository',
          click: async () => {
            await shell.openExternal('https://github.com');
          },
        },
      ],
    },
  );

  return template;
}

function emitMenuAction(mainWindow: BrowserWindow, action: DesktopMenuAction): void {
  const sendAction = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    }
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', sendAction);
    return;
  }

  sendAction();
}
