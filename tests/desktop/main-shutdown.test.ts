import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appMock, browserWindowCtor, createWindowMock, installMenuMock, setupIpcHandlersMock, mockWindow, appEventHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    getAppPath: vi.fn(() => 'd:/workspace/trends/pueblo'),
    whenReady: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    quit: vi.fn(),
  };
  const window = {
    on: vi.fn(),
    once: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => false),
      once: vi.fn(),
    },
  };

  return {
    appMock: app,
    browserWindowCtor: {
      getAllWindows: vi.fn(() => []),
    },
    createWindowMock: vi.fn(() => window),
    installMenuMock: vi.fn(),
    setupIpcHandlersMock: vi.fn(() => vi.fn()),
    mockWindow: window,
    appEventHandlers: handlers,
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowCtor,
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('../../src/desktop/main/window', () => ({
  createWindow: createWindowMock,
}));

vi.mock('../../src/desktop/main/menu', () => ({
  installDesktopApplicationMenu: installMenuMock,
}));

vi.mock('../../src/desktop/main/ipc', () => ({
  setupIpcHandlers: setupIpcHandlersMock,
}));

describe('Desktop main shutdown', () => {
  beforeEach(() => {
    vi.resetModules();
    appMock.whenReady.mockClear();
    appMock.on.mockClear();
    appMock.quit.mockClear();
    createWindowMock.mockClear();
    installMenuMock.mockClear();
    setupIpcHandlersMock.mockClear();
    mockWindow.on.mockReset();
    mockWindow.once.mockReset();
    appEventHandlers.clear();
  });

  it('disposes desktop runtime on before-quit', async () => {
    const cleanup = vi.fn();
    setupIpcHandlersMock.mockReturnValueOnce(cleanup);

    await import('../../src/desktop/main/main');
    await Promise.resolve();

    const beforeQuit = appEventHandlers.get('before-quit');
    expect(beforeQuit).toBeTypeOf('function');

    beforeQuit?.();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
