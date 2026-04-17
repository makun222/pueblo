import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;

beforeEach(() => {
  outputListener = null;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      submitInput: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn((callback: (event: unknown, data: RendererOutputBlock) => void) => {
        outputListener = callback;
      }),
      removeAllListeners: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('Desktop Output Summary Rendering', () => {
  it('should show outputSummary and tool results while keeping model output collapsed', () => {
    render(createElement(App));

    act(() => {
      outputListener?.({}, {
        id: 'summary',
        type: 'task-result',
        title: 'Output Summary',
        content: 'Short visible answer',
        collapsed: false,
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      outputListener?.({}, {
        id: 'model',
        type: 'system',
        title: 'Model Output',
        content: 'Verbose model trace',
        collapsed: true,
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      outputListener?.({}, {
        id: 'tool',
        type: 'tool-result',
        title: 'grep',
        content: 'grep: succeeded - found files',
        collapsed: false,
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Short visible answer')).toBeTruthy();
    expect(screen.getByText('grep: succeeded - found files')).toBeTruthy();
    const details = screen.getByText('Model Output').closest('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
  });
});