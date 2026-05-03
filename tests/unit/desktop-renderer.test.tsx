import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { ProviderProfile, RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;
let submitInputMock: ReturnType<typeof vi.fn>;

const availableProviders: ProviderProfile[] = [
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    status: 'active',
    authState: 'configured',
    defaultModelId: 'copilot-chat',
    models: [{ id: 'copilot-chat', name: 'GPT-5.4', supportsTools: true }],
    capabilities: { codeExecution: true, toolUse: true, streaming: true },
  },
];

beforeEach(() => {
  vi.useRealTimers();
  outputListener = null;
  submitInputMock = vi.fn().mockResolvedValue({
    result: undefined,
    blocks: [],
    runtimeStatus: {
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      agentProfileId: 'code-master',
      agentProfileName: 'Code Master',
      agentInstanceId: 'agent-1',
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
      modelMessageCount: 0,
      modelMessageCharCount: 0,
      selectedPromptCount: 0,
      selectedMemoryCount: 0,
      availableProviders,
      backgroundSummaryStatus: {
        state: 'idle',
        activeSummarySessionId: null,
        lastSummaryAt: null,
        lastSummaryMemoryId: null,
      },
    },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      submitInput: submitInputMock,
      getRuntimeStatus: vi.fn().mockResolvedValue({
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        agentProfileId: 'code-master',
        agentProfileName: 'Code Master',
        agentInstanceId: 'agent-1',
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
        modelMessageCount: 0,
        modelMessageCharCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        availableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      }),
      listAgentProfiles: vi.fn().mockResolvedValue([]),
      startAgentSession: vi.fn().mockResolvedValue({
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        agentProfileId: 'code-master',
        agentProfileName: 'Code Master',
        agentInstanceId: 'agent-1',
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
        modelMessageCount: 0,
        modelMessageCharCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        availableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      }),
      onMenuAction: vi.fn(() => () => {}),
      onOutput: vi.fn((callback: (event: unknown, data: RendererOutputBlock) => void) => {
        outputListener = callback;
      }),
      removeAllListeners: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Desktop Renderer', () => {
  it('should render distinct input and output regions with a pueblo prompt label', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    expect(screen.getByLabelText('input-region')).toBeTruthy();
    expect(screen.getByLabelText('output-region')).toBeTruthy();
    expect(screen.getByText('pueblo>')).toBeTruthy();
  });

  it('should keep collapsed metadata closed by default', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, {
        id: 'collapsed',
        type: 'system',
        title: 'Model Output',
        content: 'hidden by default',
        collapsed: true,
        messageTrace: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    const details = screen.getByText('Model Output').closest('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('clears the input immediately, shows a thinking placeholder, and streams the final answer', async () => {
    let resolveSubmit: ((value: unknown) => void) | null = null;
    submitInputMock.mockImplementation(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));

    render(createElement(App));

    const input = await screen.findByPlaceholderText('Enter command or task...');
    const form = screen.getByLabelText('input-region');

    vi.useFakeTimers();

    fireEvent.change(input, { target: { value: 'Inspect the current failure' } });

    act(() => {
      fireEvent.submit(form);
    });

    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText('让我想想该怎么做...')).toBeTruthy();

    act(() => {
      outputListener?.({}, {
        id: 'task-result-1',
        type: 'task-result',
        title: 'Output Summary',
        content: 'First line of the answer. Second line of the answer.',
        collapsed: false,
        messageTrace: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    act(() => {
      vi.advanceTimersByTime(20);
    });

    expect(screen.getByText(/First line/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(200);
      resolveSubmit?.({
        result: undefined,
        blocks: [
          {
            id: 'task-result-1',
            type: 'task-result',
            title: 'Output Summary',
            content: 'First line of the answer. Second line of the answer.',
            collapsed: false,
            messageTrace: [],
            sourceRefs: [],
            createdAt: new Date().toISOString(),
          },
        ],
        runtimeStatus: {
          providerId: 'github-copilot',
          providerName: 'GitHub Copilot',
          agentProfileId: 'code-master',
          agentProfileName: 'Code Master',
          agentInstanceId: 'agent-1',
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
          modelMessageCount: 0,
          modelMessageCharCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          availableProviders,
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
      vi.runAllTimers();
    });

    expect(screen.getByText('First line of the answer. Second line of the answer.')).toBeTruthy();
  });
});