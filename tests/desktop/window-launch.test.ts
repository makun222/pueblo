import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { browserWindowCtor, mockWindow } = vi.hoisted(() => ({
  browserWindowCtor: vi.fn(),
  mockWindow: {
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: browserWindowCtor,
  app: {
    getAppPath: vi.fn(() => 'd:/workspace/trends/pueblo'),
    on: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createWindow } from '../../src/desktop/main/window';

beforeEach(() => {
  browserWindowCtor.mockReset();
  mockWindow.loadURL.mockReset();
  mockWindow.loadFile.mockReset();
  mockWindow.once.mockReset();
  mockWindow.show.mockReset();
  browserWindowCtor.mockImplementation(() => mockWindow);
  mockWindow.once.mockImplementation((event: string, callback: () => void) => {
    if (event === 'ready-to-show') {
      callback();
    }
  });
});

describe('Desktop Window Launch', () => {
  it('should create a browser window with correct options', () => {
    createWindow();

    expect(browserWindowCtor).toHaveBeenCalledWith(expect.objectContaining({
      width: 800,
      height: 600,
      webPreferences: expect.objectContaining({
        nodeIntegration: false,
        contextIsolation: true,
      }),
    }));
  });

  it('should load the renderer HTML', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      createWindow();
      expect(mockWindow.loadFile).toHaveBeenCalledTimes(1);
      expect(mockWindow.loadFile).toHaveBeenCalledWith(
        path.join('d:/workspace/trends/pueblo', 'dist', 'desktop', 'renderer', 'index.html'),
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('should show the window on ready-to-show', () => {
    createWindow();

    expect(mockWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    expect(mockWindow.show).toHaveBeenCalledTimes(1);
  });
});