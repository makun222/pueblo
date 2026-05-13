import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { ProviderProfile, RendererMessageTraceStep, RendererOutputBlock, Session } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;
let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

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

const providerUsageStats = {
  promptTokens: 1532,
  completionTokens: 24567,
  totalTokens: 1200345,
  promptCacheHitTokens: 15,
  promptCacheMissTokens: 20,
  cachedPromptTokens: 15,
  reasoningTokens: 18,
  promptTokensSent: 35,
  cacheHitRatio: 0.4286,
};

beforeEach(() => {
  outputListener = null;
  scrollIntoViewSpy = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoViewSpy,
  });
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
          providerUsageStats,
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
        providerUsageStats,
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
      getToolApprovalState: vi.fn().mockResolvedValue({ activeBatch: null }),
      respondToolApproval: vi.fn().mockResolvedValue({ activeBatch: null }),
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
      listAgentSessions: vi.fn().mockResolvedValue([]),
      listSessionMemories: vi.fn().mockResolvedValue([]),
      selectSession: vi.fn().mockResolvedValue({
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
        session: null,
      }),
      onMenuAction: vi.fn(() => () => {}),
      onToolApprovalState: vi.fn(() => () => {}),
      onOutput: vi.fn((callback: (event: unknown, data: RendererOutputBlock) => void) => {
        outputListener = callback;
      }),
      removeAllListeners: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Desktop Output Summary Rendering', () => {
  it('should show outputSummary while keeping model output collapsed and non-chat tool blocks hidden', async () => {
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
        fileChanges: [],
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
        fileChanges: [],
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
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Short visible answer')).toBeTruthy();
    expect(screen.queryByText('grep: succeeded - found files')).toBeNull();
    expect(screen.getAllByText('Process Info')).toHaveLength(1);
    expect(screen.getAllByText('Step 1')).toHaveLength(1);
    expect(screen.queryByText('Model Output')).toBeNull();
  });

  it('auto-scrolls to the latest transcript update', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByLabelText('Search transcript')).toBeTruthy();
    });

    scrollIntoViewSpy.mockClear();

    act(() => {
      outputListener?.({}, {
        id: 'latest',
        type: 'task-result',
        title: 'Latest Output',
        content: 'Newest transcript entry',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });
  });

  it('collapses transcript history before the latest ten interactions', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByLabelText('Search transcript')).toBeTruthy();
    });

    act(() => {
      for (let index = 1; index <= 12; index += 1) {
        outputListener?.({}, {
          id: `entry-${index}`,
          type: 'task-result',
          title: `Output ${index}`,
          content: `Transcript block ${index}`,
          collapsed: false,
          messageTrace: [],
          fileChanges: [],
          sourceRefs: [],
          createdAt: new Date(Date.now() + index * 1000).toISOString(),
        });
      }
    });

    expect(screen.getByText('Earlier interactions')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('Transcript block 1')).toBeNull();
    expect(screen.getByText('Transcript block 12')).toBeTruthy();

    fireEvent.click(screen.getByText('Earlier interactions'));

    await waitFor(() => {
      expect(screen.getByText('Transcript block 1')).toBeTruthy();
      expect(screen.getByText('Transcript block 2')).toBeTruthy();
    });
  });

  it('filters transcript records after pressing Enter in the transcript search bar', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByLabelText('Search transcript')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, {
        id: 'search-alpha',
        type: 'task-result',
        title: 'Alpha',
        content: 'Alpha deployment log',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      outputListener?.({}, {
        id: 'search-beta',
        type: 'task-result',
        title: 'Beta',
        content: 'Beta migration summary',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date(Date.now() + 1000).toISOString(),
      });
    });

    const searchInput = screen.getByLabelText('Search transcript');
    fireEvent.change(searchInput, { target: { value: 'beta' } });
    fireEvent.submit(searchInput.closest('form') as HTMLFormElement);

    expect(screen.queryByText('Alpha deployment log')).toBeNull();
    expect(screen.getByText('Beta migration summary')).toBeTruthy();
    expect(screen.queryByText(/matching interaction/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Find' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('renders prompt, completion, total token counts and cache hit ratio in the right-side status area', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByText('Prompt Tokens')).toBeTruthy();
    });

    expect(screen.getByText('1.5K tokens')).toBeTruthy();
    expect(screen.getByText('24.6K tokens')).toBeTruthy();
    expect(screen.getByText('1.2M tokens')).toBeTruthy();
    expect(screen.getByText('42.9%')).toBeTruthy();
  });

  it('falls back to active session usage stats when runtime status usage is empty', async () => {
    const sessionWithUsage: Session = {
      id: 'session-1',
      title: 'Usage session',
      status: 'active',
      sessionKind: 'user',
      agentInstanceId: 'agent-1',
      currentModelId: 'copilot-chat',
      messageHistory: [],
      selectedPromptIds: [],
      selectedMemoryIds: [],
      providerUsageStats,
      originSessionId: null,
      triggerReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      failedAt: null,
      archivedAt: null,
    };

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
            providerUsageStats: undefined,
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
          providerUsageStats: undefined,
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
        getToolApprovalState: vi.fn().mockResolvedValue({ activeBatch: null }),
        respondToolApproval: vi.fn().mockResolvedValue({ activeBatch: null }),
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
          providerUsageStats: undefined,
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
        listAgentSessions: vi.fn().mockResolvedValue([sessionWithUsage]),
        listSessionMemories: vi.fn().mockResolvedValue([]),
        selectSession: vi.fn().mockResolvedValue({
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
            providerUsageStats: undefined,
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
          session: sessionWithUsage,
        }),
        onMenuAction: vi.fn(() => () => {}),
        onToolApprovalState: vi.fn(() => () => {}),
        onOutput: vi.fn((callback: (event: unknown, data: RendererOutputBlock) => void) => {
          outputListener = callback;
        }),
        removeAllListeners: vi.fn(),
      },
    });

    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByText('1.5K tokens')).toBeTruthy();
    });

    expect(screen.getByText('24.6K tokens')).toBeTruthy();
    expect(screen.getByText('1.2M tokens')).toBeTruthy();
    expect(screen.getByText('42.9%')).toBeTruthy();
  });

  it('keeps file approval rows concise and preserves the highlighted allow button class', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ...window.electronAPI,
        getToolApprovalState: vi.fn().mockResolvedValue({
          activeBatch: {
            id: 'batch-1',
            taskId: 'task-1',
            createdAt: '2026-05-12T00:00:00.000Z',
            requests: [
              {
                id: 'call-edit-1',
                toolCallId: 'call-edit-1',
                toolName: 'edit',
                title: 'Allow edit in src/desktop/renderer/App.tsx?',
                summary: 'Edit src/desktop/renderer/App.tsx by replacing renderToolApprovalSidebar with a compact approval row.',
                detail: 'Edit approval detail',
                targetLabel: 'src/desktop/renderer/App.tsx',
                operationLabel: 'edit',
              },
              {
                id: 'call-exec-1',
                toolCallId: 'call-exec-1',
                toolName: 'exec',
                title: 'Allow command execution in the workspace?',
                summary: 'Command: npm test',
                detail: 'Exec approval detail',
                targetLabel: 'npm test',
                operationLabel: 'exec',
              },
            ],
          },
        }),
      },
    });

    render(createElement(App));

    expect(await screen.findByText('Queued Calls')).toBeTruthy();
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.queryByText(/compact approval row/i)).toBeNull();
    expect(screen.getByText('Command: npm test')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow' }).className).toContain('tool-approval-allow-button');
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
        getToolApprovalState: vi.fn().mockResolvedValue({ activeBatch: null }),
        respondToolApproval: vi.fn().mockResolvedValue({ activeBatch: null }),
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
        listAgentSessions: vi.fn().mockResolvedValue([]),
        listSessionMemories: vi.fn().mockResolvedValue([]),
        selectSession: vi.fn().mockResolvedValue({
          runtimeStatus: {
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
          },
          session: null,
        }),
        onMenuAction: vi.fn(() => () => {}),
        onToolApprovalState: vi.fn(() => () => {}),
        onOutput: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    });

    render(createElement(App));

    expect(await screen.findByLabelText('agent-profile-picker')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Architect' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start with this agent' }));

    await waitFor(() => {
      expect(screen.getByText('Configure model access')).toBeTruthy();
    });
  });
});