import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { ProviderProfile, RendererMessageTraceStep, RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;

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
      },
    ],
  },
];

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
          availableProviders,
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
        availableProviders,
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
      ]),
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
  cleanup();
});

describe('Desktop Output Summary Rendering', () => {
  it('should show outputSummary and tool results while keeping model output collapsed', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, {
        id: 'summary',
        type: 'task-result',
        title: 'Output Summary',
        content: 'Short visible answer',
        collapsed: false,
        messageTrace: sampleMessageTrace,
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      outputListener?.({}, {
        id: 'model',
        type: 'system',
        title: 'Model Output',
        content: 'Verbose model trace',
        collapsed: true,
        messageTrace: sampleMessageTrace,
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      outputListener?.({}, {
        id: 'tool',
        type: 'tool-result',
        title: 'grep',
        content: 'grep: succeeded - found files',
        collapsed: false,
        messageTrace: sampleMessageTrace,
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Short visible answer')).toBeTruthy();
    expect(screen.getByText('grep: succeeded - found files')).toBeTruthy();
    expect(screen.getAllByText('Messages Sent To Model')).toHaveLength(3);
    expect(screen.getAllByText('Step 1')).toHaveLength(3);
    const details = screen.getByText('Model Output').closest('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('shows the agent picker before a session is started', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        submitInput: vi.fn(),
        getRuntimeStatus: vi.fn().mockResolvedValue({
          providerId: null,
          providerName: null,
          agentProfileId: null,
          agentProfileName: null,
          agentInstanceId: null,
          modelId: null,
          modelName: null,
          activeSessionId: null,
          contextCount: {
            estimatedTokens: 0,
            contextWindowLimit: null,
            utilizationRatio: null,
            messageCount: 0,
            selectedPromptCount: 0,
            selectedMemoryCount: 0,
            derivedMemoryCount: 0,
          },
          modelMessageCount: 0,
          modelMessageCharCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          availableProviders: [],
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
        }),
        listAgentProfiles: vi.fn().mockResolvedValue([
          {
            id: 'architect',
            name: 'Architect',
            description: 'Design-first agent profile.',
            roleDirectives: [],
            goalDirectives: ['Clarify module boundaries and system responsibilities.'],
            constraintDirectives: [],
            styleDirectives: ['Explain architecture decisions with clear reasoning.'],
            memoryPolicy: { retentionHints: [], summaryHints: [] },
            contextPolicy: { priorityHints: [], truncationHints: [] },
            summaryPolicy: { autoSummarize: true, thresholdHint: 14000, lineageHint: 'Preserve architecture rationale.' },
          },
        ]),
        startAgentSession: vi.fn().mockResolvedValue({
          providerId: null,
          providerName: null,
          agentProfileId: 'architect',
          agentProfileName: 'Architect',
          agentInstanceId: 'agent-2',
          modelId: null,
          modelName: null,
          activeSessionId: 'session-2',
          contextCount: {
            estimatedTokens: 0,
            contextWindowLimit: null,
            utilizationRatio: null,
            messageCount: 0,
            selectedPromptCount: 0,
            selectedMemoryCount: 0,
            derivedMemoryCount: 0,
          },
          modelMessageCount: 0,
          modelMessageCharCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          availableProviders: [],
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
        }),
        onMenuAction: vi.fn(() => () => {}),
        onOutput: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    });

    render(createElement(App));

    expect(await screen.findByLabelText('agent-profile-picker')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Architect' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start with this agent' }));

    await waitFor(() => {
      expect(screen.getByText('Architect')).toBeTruthy();
    });
  });
});