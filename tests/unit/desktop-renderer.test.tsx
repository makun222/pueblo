import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;

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
});