import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { MemoryRecord, ProviderProfile, RendererOutputBlock, Session } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;
let submitInputMock: ReturnType<typeof vi.fn>;
let listAgentSessionsMock: ReturnType<typeof vi.fn>;
let listSessionMemoriesMock: ReturnType<typeof vi.fn>;
let selectSessionMock: ReturnType<typeof vi.fn>;
let getToolApprovalStateMock: ReturnType<typeof vi.fn>;
let respondToolApprovalMock: ReturnType<typeof vi.fn>;

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

const emptyProviderUsageStats = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  cachedPromptTokens: 0,
  reasoningTokens: 0,
  promptTokensSent: 0,
  cacheHitRatio: 0,
};

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
  listAgentSessionsMock = vi.fn().mockResolvedValue([]);
  listSessionMemoriesMock = vi.fn().mockResolvedValue([]);
  getToolApprovalStateMock = vi.fn().mockResolvedValue({ activeBatch: null });
  respondToolApprovalMock = vi.fn().mockResolvedValue({ activeBatch: null });
  selectSessionMock = vi.fn().mockResolvedValue({
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
      getToolApprovalState: getToolApprovalStateMock,
      respondToolApproval: respondToolApprovalMock,
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
      listAgentSessions: listAgentSessionsMock,
      listSessionMemories: listSessionMemoriesMock,
      selectSession: selectSessionMock,
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
  vi.useRealTimers();
  cleanup();
});

describe('Desktop Renderer', () => {
  it('toggles the session sidebar from the toolbar without affecting the other sidebars', async () => {
    render(createElement(App));

    expect(await screen.findByLabelText('workspace-tool-approval-sidebar')).toBeTruthy();
    expect(screen.getByLabelText('workspace-todo-sidebar')).toBeTruthy();
    expect(screen.queryByLabelText('workspace-session-sidebar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByLabelText('workspace-session-sidebar')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Hide session sidebar' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('workspace-session-sidebar')).toBeNull();
      expect(screen.getByLabelText('workspace-tool-approval-sidebar')).toBeTruthy();
      expect(screen.getByLabelText('workspace-todo-sidebar')).toBeTruthy();
    });
  });

  it('toggles the tool approval and todo sidebars independently', async () => {
    render(createElement(App));

    expect(await screen.findByLabelText('workspace-tool-approval-sidebar')).toBeTruthy();
    expect(screen.getByLabelText('workspace-todo-sidebar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Hide tool approval sidebar' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('workspace-tool-approval-sidebar')).toBeNull();
      expect(screen.getByLabelText('workspace-todo-sidebar')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Hide todo sidebar' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('workspace-todo-sidebar')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show tool approval sidebar' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Show todo sidebar' })).toBeTruthy();
    });
  });

  it('shows the latest todo memory in the lower sidebar section', async () => {
    const memories: MemoryRecord[] = [
      {
        id: 'memory-todo-older',
        type: 'short-term',
        title: 'Todo Round 1: Older list',
        content: 'workflowId: wf-1\nworkflowType: pueblo-plan\nroundNumber: 1\ntasks:\n- T0: Older task',
        scope: 'session',
        status: 'active',
        tags: ['workflow', 'todo'],
        parentId: null,
        derivationType: 'manual',
        summaryDepth: 0,
        sourceSessionId: 'session-1',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      {
        id: 'memory-todo-latest',
        type: 'short-term',
        title: 'Todo Round 2: Latest list',
        content: 'workflowId: wf-1\nworkflowType: pueblo-plan\nroundNumber: 2\ntasks:\n- T1: Newer task',
        scope: 'session',
        status: 'active',
        tags: ['workflow', 'todo'],
        parentId: null,
        derivationType: 'manual',
        summaryDepth: 0,
        sourceSessionId: 'session-1',
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
      },
    ];
    listSessionMemoriesMock.mockResolvedValue(memories);

    render(createElement(App));

    expect(await screen.findByLabelText('workspace-todo-sidebar')).toBeTruthy();
    expect(await screen.findByText('Todo Round 2: Latest list')).toBeTruthy();
    expect(screen.getByText('Newer task')).toBeTruthy();
    expect(screen.queryByText('Older task')).toBeNull();
  });

  it('should render distinct input and output regions with a pueblo prompt label', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    expect(screen.getByLabelText('input-region')).toBeTruthy();
    expect(screen.getByLabelText('output-region')).toBeTruthy();
    expect(screen.getByText('pueblo>')).toBeTruthy();
  });

  it('should hide system output blocks from the transcript', async () => {
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
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.queryByText('Model Output')).toBeNull();
    expect(screen.getByText('No output yet.')).toBeTruthy();
  });

  it('renders the sidebar approval queue and current todo list', async () => {
    const createdAt = new Date().toISOString();
    const todoMemory: MemoryRecord = {
      id: 'memory-todo-1',
      type: 'short-term',
      title: 'Todo Round 2: Refresh sidebar UX',
      content: [
        'workflowId: workflow-1',
        'workflowType: pueblo-plan',
        'roundNumber: 2',
        'tasks:',
        '- T1: Merge tool approvals into sidebar',
        '- T2: Show todo items below approval list',
      ].join('\n'),
      scope: 'session',
      status: 'active',
      tags: ['workflow', 'todo', 'workflow:pueblo-plan'],
      parentId: null,
      derivationType: 'manual',
      summaryDepth: 0,
      sourceSessionId: 'session-1',
      createdAt,
      updatedAt: createdAt,
    };

    listSessionMemoriesMock.mockResolvedValue([todoMemory]);
    getToolApprovalStateMock.mockResolvedValue({
      activeBatch: {
        id: 'batch-1',
        taskId: 'task-1',
        createdAt,
        requests: [
          {
            id: 'call-edit-1',
            toolCallId: 'call-edit-1',
            toolName: 'edit',
            title: 'Allow edit in src/desktop/renderer/App.tsx?',
            summary: 'Edit src/desktop/renderer/App.tsx',
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
    });

    render(createElement(App));

    expect(await screen.findByLabelText('workspace-tool-approval-sidebar')).toBeTruthy();
    expect(screen.getByLabelText('workspace-todo-sidebar')).toBeTruthy();
    expect(await screen.findByText('Pending Requests')).toBeTruthy();
    expect(screen.getByText('src/desktop/renderer/App.tsx')).toBeTruthy();
    expect(screen.getByText('Merge tool approvals into sidebar')).toBeTruthy();
    expect(screen.getByText('Show todo items below approval list')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Deselect npm test' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select npm test' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => {
      expect(respondToolApprovalMock).toHaveBeenCalledWith({
        batchId: 'batch-1',
        decision: 'allow',
        selectedRequestIds: ['call-edit-1'],
      });
    });
  });

  it('groups model process info behind nested collapsed sections', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, {
        id: 'trace-block',
        type: 'task-result',
        title: 'Trace Output',
        content: 'Completed with trace.',
        collapsed: false,
        messageTrace: [
          {
            stepNumber: 1,
            messageCount: 3,
            charCount: 142,
            messages: [
              {
                role: 'system',
                content: 'System prompt content',
                charCount: 21,
              },
              {
                role: 'user',
                content: 'Inspect this failure',
                charCount: 20,
              },
              {
                role: 'tool',
                content: 'Search results payload',
                toolName: 'search-files',
                toolCallId: 'call-1',
                toolArgs: { query: 'task-runner' },
                charCount: 101,
              },
            ],
          },
        ],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    const processInfo = screen.getByText('Process Info').closest('details');
    expect(processInfo).toBeTruthy();
    expect(processInfo?.hasAttribute('open')).toBe(false);
    expect(processInfo?.textContent).toContain('3 messages');
    expect(processInfo?.textContent).toContain('1 steps');
    expect(processInfo?.textContent).toContain('1 tool calls');

    fireEvent.click(screen.getByText('Process Info'));
    expect(processInfo?.hasAttribute('open')).toBe(true);

    const step = screen.getByText('Step 1').closest('details');
    expect(step).toBeTruthy();
    expect(step?.hasAttribute('open')).toBe(false);

    fireEvent.click(screen.getByText('Step 1'));
    expect(step?.hasAttribute('open')).toBe(true);

    const toolMessage = screen.getByText('tool').closest('details');
    expect(toolMessage).toBeTruthy();
    expect(toolMessage?.hasAttribute('open')).toBe(false);

    fireEvent.click(screen.getByText('tool'));
    expect(toolMessage?.hasAttribute('open')).toBe(true);
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
    expect(screen.getByText('Thinking through the next step...')).toBeTruthy();

    act(() => {
      outputListener?.({}, {
        id: 'task-result-1',
        type: 'task-result',
        title: 'Output Summary',
        content: 'First line of the answer. Second line of the answer.',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
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
            fileChanges: [],
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

  it('shows agent activity updates while the assistant response is still pending', async () => {
    let resolveSubmit: ((value: unknown) => void) | null = null;
    submitInputMock.mockImplementation(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));

    render(createElement(App));

    const input = await screen.findByPlaceholderText('Enter command or task...');
    const form = screen.getByLabelText('input-region');

    fireEvent.change(input, { target: { value: 'Investigate the current task' } });

    act(() => {
      fireEvent.submit(form);
    });

    act(() => {
      outputListener?.({}, {
        id: 'agent-progress-1',
        type: 'system',
        title: 'Agent Activity',
        content: 'Step 1: running read src/agent/task-runner.ts',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText(/Step 1: running read src\/agent\/task-runner.ts/)).toBeTruthy();
    expect(screen.queryByText('Agent Activity')).toBeNull();

    await act(async () => {
      resolveSubmit?.({
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
      await Promise.resolve();
    });
  });

  it('renders a changed-files panel below the final answer and opens a preview modal', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, {
        id: 'task-result-files',
        type: 'task-result',
        title: 'Output Summary',
        content: 'Updated the exporter and note layout.',
        collapsed: false,
        messageTrace: [],
        fileChanges: [
          {
            path: 'src/example.ts',
            absolutePath: 'd:/workspace/trends/pueblo/src/example.ts',
            changeType: 'modified',
            previousContent: 'alpha\nbeta\ngamma\n',
            currentContent: 'alpha\nbeta updated\ngamma\ndelta\n',
          },
        ],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    fireEvent.click(screen.getByText('Changed Files'));
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));

    expect(screen.getByLabelText('file-change-preview-dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'src/example.ts' })).toBeTruthy();
    expect(screen.getByText('beta updated')).toBeTruthy();
    expect(screen.getByText('delta')).toBeTruthy();
    expect(document.querySelector('.file-change-line-added')).toBeTruthy();
    expect(document.querySelector('.file-change-line-removed')).toBeTruthy();
  });

  it('renders multi-turn handoff output as a collapsed continue-task card', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, {
        id: 'task-result-handoff',
        type: 'task-result',
        title: 'Output Summary',
        content: [
          'Completed this round',
          '- 已定位 step-limit 触发链路',
          '- 已加入多轮预算提示并完成验证',
          '',
          'Remaining work',
          '- 让模型更早主动结束当前轮次',
          '- 为 handoff 输出补 UI 呈现',
          '- 增加复杂任务回归测试',
          '',
          'Recommended next request',
          '- 继续当前任务，只处理“让模型更早主动结束当前轮次”这一项，并完成验证。',
        ].join('\n'),
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    const handoffCard = screen.getByText('Continue This Task').closest('details');
    expect(handoffCard).toBeTruthy();
    expect(handoffCard?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('已完成 2 项')).toBeTruthy();
    expect(screen.getByText('剩余 3 项')).toBeTruthy();
    expect(screen.getByText(/建议继续：继续当前任务/)).toBeTruthy();

    fireEvent.click(screen.getByText('Continue This Task'));

    expect(handoffCard?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('本轮已完成')).toBeTruthy();
    expect(screen.getByText('已定位 step-limit 触发链路')).toBeTruthy();
    expect(screen.getByText('剩余工作')).toBeTruthy();
    expect(screen.getByText('为 handoff 输出补 UI 呈现')).toBeTruthy();
    expect(screen.getByText('建议下一轮')).toBeTruthy();
  });

  it('shows streamed assistant draft text before the final answer block arrives', async () => {
    let resolveSubmit: ((value: unknown) => void) | null = null;
    submitInputMock.mockImplementation(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));

    render(createElement(App));

    const input = await screen.findByPlaceholderText('Enter command or task...');
    const form = screen.getByLabelText('input-region');

    vi.useFakeTimers();

    fireEvent.change(input, { target: { value: 'Explain the current plan' } });

    act(() => {
      fireEvent.submit(form);
    });

    act(() => {
      outputListener?.({}, {
        id: 'assistant-draft-1',
        type: 'system',
        title: 'Assistant Draft',
        content: 'First line',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      outputListener?.({}, {
        id: 'assistant-draft-2',
        type: 'system',
        title: 'Assistant Draft',
        content: ' of the answer.',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
    });

    expect(screen.getByText('First line of the answer.')).toBeTruthy();

    act(() => {
      outputListener?.({}, {
        id: 'task-result-2',
        type: 'task-result',
        title: 'Output Summary',
        content: 'First line of the answer. Second line follows.',
        collapsed: false,
        messageTrace: [],
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      });
      vi.advanceTimersByTime(60);
    });

    expect(screen.getByText(/Second line follows/)).toBeTruthy();

    await act(async () => {
      resolveSubmit?.({
        result: undefined,
        blocks: [
          {
            id: 'task-result-2',
            type: 'task-result',
            title: 'Output Summary',
            content: 'First line of the answer. Second line follows.',
            collapsed: false,
            messageTrace: [],
            fileChanges: [],
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
      await Promise.resolve();
    });
  });

  it('shows agent sessions on the right and opens a memory dialog on double click', async () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        title: 'Current session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
      {
        id: 'session-2',
        title: 'Recovered session',
        status: 'archived',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Review the old plan',
            createdAt: new Date().toISOString(),
            taskId: null,
            toolName: null,
          },
          {
            id: 'message-2',
            role: 'assistant',
            content: 'Recovered session output',
            createdAt: new Date().toISOString(),
            taskId: null,
            toolName: null,
          },
        ],
        selectedPromptIds: [],
        selectedMemoryIds: ['memory-1'],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: new Date().toISOString(),
      },
    ];
    const memories: MemoryRecord[] = [
      {
        id: 'memory-1',
        type: 'short-term',
        title: 'Recovered memory',
        content: 'Captured decision from the recovered session.',
        scope: 'session',
        status: 'active',
        tags: ['conversation-turn'],
        parentId: null,
        derivationType: 'summary',
        summaryDepth: 0,
        sourceSessionId: 'session-2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    listAgentSessionsMock.mockResolvedValue(sessions);
    listSessionMemoriesMock.mockResolvedValue(memories);
    selectSessionMock.mockResolvedValue({
      runtimeStatus: {
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        agentProfileId: 'code-master',
        agentProfileName: 'Code Master',
        agentInstanceId: 'agent-1',
        modelId: 'copilot-chat',
        modelName: 'GPT-5.4',
        activeSessionId: 'session-2',
        contextCount: {
          estimatedTokens: 12,
          contextWindowLimit: 32000,
          utilizationRatio: 0.0004,
          messageCount: 2,
          selectedPromptCount: 0,
          selectedMemoryCount: 1,
          derivedMemoryCount: 0,
        },
        modelMessageCount: 0,
        modelMessageCharCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 1,
        availableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      },
      session: sessions[1],
    });

    render(createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByText('Recovered session')).toBeTruthy();
    });

    fireEvent.doubleClick(screen.getByText('Recovered session'));

    await waitFor(() => {
      expect(screen.getByLabelText('session-memory-dialog')).toBeTruthy();
      expect(screen.getByText('Recovered memory')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '选择' }));

    await waitFor(() => {
      expect(selectSessionMock).toHaveBeenCalledWith('session-2');
      expect(screen.getByText('Recovered session output')).toBeTruthy();
    });
  });

  it('lets the user close and reopen the session sidebar from the top toolbar', async () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        title: 'Current session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
    ];
    listAgentSessionsMock.mockResolvedValue(sessions);

    render(createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByText('Current session')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Hide session sidebar' }));

    await waitFor(() => {
      expect(screen.queryByText('Current session')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByText('Current session')).toBeTruthy();
    });
  });

  it('selects a session on single click and only opens details on double click', async () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        title: 'Current session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
      {
        id: 'session-2',
        title: 'Recovered session',
        status: 'archived',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: new Date().toISOString(),
      },
    ];
    listAgentSessionsMock.mockResolvedValue(sessions);

    render(createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByText('Recovered session')).toBeTruthy();
    });

    const recoveredCard = screen.getByText('Recovered session').closest('article');
    expect(recoveredCard?.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByText('Recovered session'));

    await waitFor(() => {
      expect(recoveredCard?.getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByLabelText('session-memory-dialog')).toBeNull();
      expect(recoveredCard?.textContent).toContain('No messages yet.');
    });
  });

  it('hydrates the new active session after /new switches sessions', async () => {
    const initialSessions: Session[] = [
      {
        id: 'session-1',
        title: 'Existing session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Old message',
            createdAt: new Date().toISOString(),
            taskId: null,
            toolName: null,
          },
        ],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
    ];
    const nextSessions: Session[] = [
      {
        id: 'session-2',
        title: 'Fresh session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
      initialSessions[0],
    ];
    listAgentSessionsMock
      .mockResolvedValueOnce(initialSessions)
      .mockResolvedValueOnce(nextSessions);
    submitInputMock.mockResolvedValue({
      result: { ok: true, code: 'SESSION_CREATED', message: 'Session created', data: null },
      blocks: [],
      runtimeStatus: {
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        agentProfileId: 'code-master',
        agentProfileName: 'Code Master',
        agentInstanceId: 'agent-1',
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
        availableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      },
    });

    render(createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByText('Old message')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText('Enter command or task...');
    const form = screen.getByLabelText('input-region');
    fireEvent.change(input, { target: { value: '/new fresh-session' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(submitInputMock).toHaveBeenCalledWith('/new fresh-session');
      expect(screen.queryByText('Old message')).toBeNull();
      expect(screen.getByText('No output yet.')).toBeTruthy();
    });
  });

  it('creates a new session directly from the sidebar', async () => {
    const initialSessions: Session[] = [
      {
        id: 'session-1',
        title: 'Existing session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
    ];
    const nextSessions: Session[] = [
      {
        id: 'session-2',
        title: 'Untitled session',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
      initialSessions[0],
    ];
    listAgentSessionsMock
      .mockResolvedValueOnce(initialSessions)
      .mockResolvedValueOnce(nextSessions);
    submitInputMock.mockResolvedValue({
      result: { ok: true, code: 'SESSION_CREATED', message: 'Session created', data: null },
      blocks: [],
      runtimeStatus: {
        providerId: 'github-copilot',
        providerName: 'GitHub Copilot',
        agentProfileId: 'code-master',
        agentProfileName: 'Code Master',
        agentInstanceId: 'agent-1',
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
        availableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      },
    });

    render(createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.change(screen.getByPlaceholderText('Enter a session title'), { target: { value: 'Release review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(submitInputMock).toHaveBeenCalledWith('/new Release review');
      expect(screen.getByText('Untitled session')).toBeTruthy();
    });
  });

  it('filters and sorts sessions from the sidebar controls', async () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        title: 'Bravo task',
        status: 'active',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [{ id: 'm1', role: 'assistant', content: 'Second newest', createdAt: '2026-05-04T00:00:02.000Z', taskId: null, toolName: null }],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: '2026-05-04T00:00:01.000Z',
        updatedAt: '2026-05-04T00:00:02.000Z',
        startedAt: '2026-05-04T00:00:01.000Z',
        completedAt: null,
        failedAt: null,
        archivedAt: null,
      },
      {
        id: 'session-2',
        title: 'Alpha review',
        status: 'archived',
        sessionKind: 'user',
        agentInstanceId: 'agent-1',
        currentModelId: 'copilot-chat',
        messageHistory: [{ id: 'm2', role: 'user', content: 'Find alpha details', createdAt: '2026-05-04T00:00:01.000Z', taskId: null, toolName: null }],
        selectedPromptIds: [],
        selectedMemoryIds: [],
        providerUsageStats: emptyProviderUsageStats,
        originSessionId: null,
        triggerReason: null,
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:01.000Z',
        startedAt: '2026-05-04T00:00:00.000Z',
        completedAt: null,
        failedAt: null,
        archivedAt: '2026-05-04T00:00:01.000Z',
      },
    ];
    listAgentSessionsMock.mockResolvedValue(sessions);

    render(createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Show session sidebar' }));

    await waitFor(() => {
      expect(screen.getByText('Bravo task')).toBeTruthy();
      expect(screen.getByText('Alpha review')).toBeTruthy();
    });

    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings.indexOf('Bravo task')).toBeLessThan(headings.indexOf('Alpha review'));

    fireEvent.change(screen.getByPlaceholderText('Search session titles or content'), { target: { value: 'alpha' } });

    await waitFor(() => {
      expect(screen.queryByText('Bravo task')).toBeNull();
      expect(screen.getByText('Alpha review')).toBeTruthy();
      expect(screen.getByText('You: Find alpha details')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('Search session titles or content'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('Most recent'), { target: { value: 'updated-asc' } });

    await waitFor(() => {
      const reorderedHeadings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
      expect(reorderedHeadings.indexOf('Alpha review')).toBeLessThan(reorderedHeadings.indexOf('Bravo task'));
    });
  });
});