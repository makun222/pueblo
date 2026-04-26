import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { RendererMessageTraceStep, RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;

const sampleMessageTrace: RendererMessageTraceStep[] = [
  {
    stepNumber: 1,
    messageCount: 2,
    charCount: 18,
    messages: [
      {
        role: 'system',
        content: 'system seed',
        charCount: 11,
      },
      {
        role: 'user',
        content: 'inspect',
        charCount: 7,
        toolName: 'grep',
        toolCallId: 'call-1',
        toolArgs: {
          pattern: 'inspect',
        },
      },
    ],
  },
];

function createBlock(overrides: Partial<RendererOutputBlock> = {}): RendererOutputBlock {
  return {
    id: overrides.id ?? Math.random().toString(16).slice(2),
    type: overrides.type ?? 'task-result',
    title: overrides.title ?? 'Output Summary',
    content: overrides.content ?? 'block content',
    collapsed: overrides.collapsed ?? false,
    messageTrace: overrides.messageTrace ?? [],
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
      listAgentProfiles: vi.fn().mockResolvedValue([
        {
          id: 'code-master',
          name: 'Code Master',
          description: 'Focused on code execution.',
          roleDirectives: ['Act as a pragmatic senior software engineer.'],
          goalDirectives: ['Produce correct, testable code changes.'],
          constraintDirectives: ['Do not change unrelated behavior.'],
          styleDirectives: ['Be concise, technical, and direct.'],
          memoryPolicy: { retentionHints: [], summaryHints: [] },
          contextPolicy: { priorityHints: [], truncationHints: [] },
          summaryPolicy: { autoSummarize: true, thresholdHint: 12000, lineageHint: 'Preserve engineering decisions.' },
        },
        {
          id: 'architect',
          name: 'Architect',
          description: 'Focused on structure and long-horizon design.',
          roleDirectives: ['Act as a software architect balancing delivery and maintainability.'],
          goalDirectives: ['Clarify module boundaries and system responsibilities.'],
          constraintDirectives: ['Prefer explicit tradeoffs and composable abstractions.'],
          styleDirectives: ['Explain architecture decisions with clear, high-level reasoning.'],
          memoryPolicy: { retentionHints: [], summaryHints: [] },
          contextPolicy: { priorityHints: [], truncationHints: [] },
          summaryPolicy: { autoSummarize: true, thresholdHint: 14000, lineageHint: 'Preserve architectural rationale.' },
        },
      ]),
      startAgentSession: vi.fn().mockResolvedValue({
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        agentProfileId: 'architect',
        agentProfileName: 'Architect',
        agentInstanceId: 'agent-2',
        modelId: 'copilot-chat',
        modelName: 'GPT-5.4',
        activeSessionId: 'session-2',
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

describe('Desktop Window Input/Output', () => {
  it('should render input and output panes', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

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

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/ping{enter}');

    expect(window.electronAPI.submitInput).toHaveBeenCalledWith('/ping');
  });

  it('should submit input on send button click', async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

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

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/help');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('Pueblo')).toBeTruthy();
    expect(screen.getByText('submit failed')).toBeTruthy();
  });

  it('should display output blocks in sequence', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, createBlock({ id: '1', content: 'first output' }));
      outputListener?.({}, createBlock({ id: '2', content: 'second output' }));
    });

    expect(screen.getByText('first output')).toBeTruthy();
    expect(screen.getByText('second output')).toBeTruthy();
  });

  it('should handle IPC input routing', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    expect(window.electronAPI.onOutput).toHaveBeenCalledTimes(1);
  });

  it('should show provider and model badges', async () => {
    render(createElement(App));

    expect(await screen.findByText('GitHub Copilot')).toBeTruthy();
    expect(await screen.findByText('GPT-5.4')).toBeTruthy();
    expect(await screen.findByText('0 chars')).toBeTruthy();
  });

  it('should render a collapsed message details block for output entries', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, createBlock({
        id: 'details',
        content: 'answer with trace',
        messageTrace: sampleMessageTrace,
      }));
    });

    const details = screen.getByText('Messages Sent To Model').closest('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('Step 1')).toBeTruthy();
    expect(screen.getByText('2 messages')).toBeTruthy();
    expect(screen.getByText('18 chars')).toBeTruthy();
    expect(screen.getByText('system')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('tool=grep')).toBeTruthy();
    expect(screen.getByText('call=call-1')).toBeTruthy();
    expect(screen.getByText((_content, element) => {
      return Boolean(element?.classList.contains('message-item-args') && (element.textContent?.includes('"pattern": "inspect"') ?? false));
    })).toBeTruthy();
  });

  it('should allow switching agent after startup and clear the current transcript', async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch Agent' })).toBeTruthy();
    });

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/help');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('/help')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Switch Agent' }));

    expect(screen.getByLabelText('agent-profile-picker')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Start with this agent' })[1]);

    await waitFor(() => {
      expect(window.electronAPI.startAgentSession).toHaveBeenCalledWith('architect');
      expect(screen.queryByText('/help')).toBeNull();
      expect(screen.getByText('Architect')).toBeTruthy();
      expect(screen.queryByLabelText('agent-profile-picker')).toBeNull();
    });
  });
});