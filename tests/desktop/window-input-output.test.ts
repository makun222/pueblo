import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;

function createBlock(overrides: Partial<RendererOutputBlock> = {}): RendererOutputBlock {
  return {
    id: overrides.id ?? Math.random().toString(16).slice(2),
    type: overrides.type ?? 'task-result',
    title: overrides.title ?? 'Output Summary',
    content: overrides.content ?? 'block content',
    collapsed: overrides.collapsed ?? false,
    sourceRefs: overrides.sourceRefs ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

beforeEach(() => {
  outputListener = null;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      submitInput: vi.fn().mockResolvedValue({
        result: undefined,
        blocks: [],
        runtimeStatus: {
          providerId: 'github-copilot',
          providerName: 'GitHub Copilot',
          modelId: 'copilot-chat',
          modelName: 'GPT-5.4',
          activeSessionId: 'session-1',
          contextCount: {
            estimatedTokens: 12,
            contextWindowLimit: 32000,
            utilizationRatio: 0.0004,
            messageCount: 0,
            selectedPromptCount: 0,
            selectedMemoryCount: 0,
            derivedMemoryCount: 0,
          },
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
        },
      }),
      getRuntimeStatus: vi.fn().mockResolvedValue({
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        modelId: 'copilot-chat',
        modelName: 'GPT-5.4',
        activeSessionId: 'session-1',
        contextCount: {
          estimatedTokens: 12,
          contextWindowLimit: 32000,
          utilizationRatio: 0.0004,
          messageCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          derivedMemoryCount: 0,
        },
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      }),
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

describe('Desktop Window Input/Output', () => {
  it('should render input and output panes', () => {
    render(createElement(App));

    expect(screen.getByLabelText('input-region')).toBeTruthy();
    expect(screen.getByLabelText('output-region')).toBeTruthy();
    expect(screen.getByLabelText('runtime-status')).toBeTruthy();
    expect(screen.getByText('pueblo>')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('should submit input on enter key', async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/ping{enter}');

    expect(window.electronAPI.submitInput).toHaveBeenCalledWith('/ping');
  });

  it('should submit input on send button click', async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/help');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(window.electronAPI.submitInput).toHaveBeenCalledWith('/help');
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('/help')).toBeTruthy();
  });

  it('should show an error block when submit fails', async () => {
    const user = userEvent.setup();
    window.electronAPI.submitInput = vi.fn().mockRejectedValue(new Error('submit failed'));
    render(createElement(App));

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/help');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('Pueblo')).toBeTruthy();
    expect(screen.getByText('submit failed')).toBeTruthy();
  });

  it('should display output blocks in sequence', () => {
    render(createElement(App));

    act(() => {
      outputListener?.({}, createBlock({ id: '1', content: 'first output' }));
      outputListener?.({}, createBlock({ id: '2', content: 'second output' }));
    });

    expect(screen.getByText('first output')).toBeTruthy();
    expect(screen.getByText('second output')).toBeTruthy();
  });

  it('should handle IPC input routing', () => {
    render(createElement(App));

    expect(window.electronAPI.onOutput).toHaveBeenCalledTimes(1);
  });

  it('should show provider and model badges', async () => {
    render(createElement(App));

    expect(await screen.findByText('GitHub Copilot')).toBeTruthy();
    expect(await screen.findByText('GPT-5.4')).toBeTruthy();
  });
});