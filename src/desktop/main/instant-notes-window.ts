import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

let instantNotesWindow: BrowserWindow | null = null;
let instantNotesLoaded = false;

function resolvePreloadPath(): string {
  const candidatePaths = [
    path.resolve(app.getAppPath(), 'dist', 'src', 'desktop', 'preload', 'index.js'),
    path.resolve(app.getAppPath(), 'dist', 'desktop', 'preload', 'index.js'),
    path.resolve(__dirname, '..', 'preload', 'index.js'),
    path.resolve(__dirname, '..', '..', 'desktop', 'preload', 'index.js'),
  ];

  return candidatePaths.find((candidate) => existsSync(candidate)) ?? candidatePaths[0];
}

function resolveNotesHtmlPath(): string {
  const candidatePaths = [
    path.resolve(app.getAppPath(), 'dist', 'desktop', 'renderer', 'notes.html'),
    path.resolve(app.getAppPath(), 'dist', 'src', 'desktop', 'renderer', 'notes.html'),
    path.resolve(__dirname, '..', '..', 'desktop', 'renderer', 'notes.html'),
    path.resolve(__dirname, '..', 'renderer', 'notes.html'),
  ];

  return candidatePaths.find((candidate) => existsSync(candidate)) ?? candidatePaths[0];
}

function showInstantNotesWindow(): void {
  if (!instantNotesWindow || instantNotesWindow.isDestroyed()) {
    return;
  }
  if (instantNotesWindow.isMinimized()) {
    instantNotesWindow.restore();
  }
  instantNotesWindow.show();
  instantNotesWindow.focus();
}

export function openInstantNotesWindow(): void {
  if (instantNotesWindow && !instantNotesWindow.isDestroyed()) {
    if (instantNotesLoaded) {
      showInstantNotesWindow();
      return;
    }
    // 之前加载失败：销毁重建，而不是强行显示从未加载成功的空窗体
    instantNotesWindow.destroy();
    instantNotesWindow = null;
    instantNotesLoaded = false;
  }

  // dev 判定改为显式标志，避免环境残留 NODE_ENV=development 导致误判
  const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? process.env.INSTANT_NOTES_DEV_URL;
  const htmlPath = devServerUrl
    ? `${devServerUrl.replace(/\/+$/, '')}/notes.html`
    : resolveNotesHtmlPath();

  instantNotesWindow = new BrowserWindow({
    width: 460,
    height: 560,
    minWidth: 360,
    minHeight: 420,
    frame: true,
    autoHideMenuBar: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#111827',
    title: '即时贴',
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  instantNotesLoaded = false;

  instantNotesWindow.once('ready-to-show', () => {
    showInstantNotesWindow();
  });

  const load = devServerUrl
    ? instantNotesWindow.loadURL(htmlPath)
    : instantNotesWindow.loadFile(htmlPath);

  load
    .then(() => {
      instantNotesLoaded = true;
      showInstantNotesWindow();
    })
    .catch((err: unknown) => {
      console.error('[instant-notes] 页面加载失败:', htmlPath, err);
      // dev server 不可达时回退到本地产物
      if (devServerUrl) {
        const localHtmlPath = resolveNotesHtmlPath();
        if (existsSync(localHtmlPath)) {
          console.error('[instant-notes] 回退加载本地产物:', localHtmlPath);
          instantNotesWindow
            ?.loadFile(localHtmlPath)
            .then(() => {
              instantNotesLoaded = true;
              showInstantNotesWindow();
            })
            .catch((fallbackErr: unknown) => {
              console.error('[instant-notes] 回退加载失败:', fallbackErr);
            });
        }
      }
    });

  instantNotesWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[instant-notes] did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      );
    },
  );

  instantNotesWindow.on('closed', () => {
    instantNotesWindow = null;
    instantNotesLoaded = false;
  });
}

export function toggleInstantNotesWindow(): void {
  if (!instantNotesWindow || instantNotesWindow.isDestroyed() || !instantNotesLoaded) {
    openInstantNotesWindow();
    return;
  }

  if (instantNotesWindow.isVisible()) {
    instantNotesWindow.hide();
  } else {
    showInstantNotesWindow();
  }
}

export function closeInstantNotesWindow(): void {
  if (instantNotesWindow && !instantNotesWindow.isDestroyed()) {
    instantNotesWindow.close();
  }
  instantNotesWindow = null;
}

export function isInstantNotesWindowOpen(): boolean {
  return instantNotesWindow !== null && !instantNotesWindow.isDestroyed();
}
