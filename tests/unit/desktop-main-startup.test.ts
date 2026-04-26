import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, removeHandlerMock, handleMock, mockWindow } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

  return {
    handlers: registeredHandlers,
    removeHandlerMock: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
    handleMock: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
    mockWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn(),
        isLoading: vi.fn(() => false),
        once: vi.fn(),
      },
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock,
  },
  app: {
    whenReady: vi.fn(() => ({ then: vi.fn() })),
    on: vi.fn(),
    quit: vi.fn(),
  },
}));

import { publishDesktopStartupError } from '../../src/desktop/main/main';

beforeEach(() => {
  handlers.clear();
  removeHandlerMock.mockClear();
  handleMock.mockClear();
  mockWindow.isDestroyed.mockClear();
  mockWindow.webContents.send.mockClear();
  mockWindow.webContents.isLoading.mockClear();
  mockWindow.webContents.once.mockClear();
  mockWindow.isDestroyed.mockReturnValue(false);
  mockWindow.webContents.isLoading.mockReturnValue(false);
});

describe('desktop startup fallback IPC registration', () => {
  it('registers fallback handlers for renderer channels when startup fails', async () => {
    publishDesktopStartupError(mockWindow as never, new Error('boom'));

    expect(removeHandlerMock).toHaveBeenCalledWith('get-runtime-status');
    expect(removeHandlerMock).toHaveBeenCalledWith('list-agent-profiles');
    expect(removeHandlerMock).toHaveBeenCalledWith('start-agent-session');
    expect(removeHandlerMock).toHaveBeenCalledWith('submit-input');
    expect(handlers.has('get-runtime-status')).toBe(true);
    expect(handlers.has('list-agent-profiles')).toBe(true);
    expect(handlers.has('start-agent-session')).toBe(true);
    expect(handlers.has('submit-input')).toBe(true);

    await expect(handlers.get('get-runtime-status')?.()).resolves.toEqual(expect.objectContaining({
      agentProfileId: null,
      activeSessionId: null,
    }));
    await expect(handlers.get('list-agent-profiles')?.()).rejects.toThrow('boom');
    await expect(handlers.get('start-agent-session')?.()).rejects.toThrow('boom');
    await expect(handlers.get('submit-input')?.()).rejects.toThrow('boom');
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('output', expect.objectContaining({
      title: 'Desktop Startup Error',
    }));
  });
});