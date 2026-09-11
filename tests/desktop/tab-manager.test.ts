import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAppConfig } from '../helpers/test-config';

const {
  createCliDependenciesMock,
  routeInputMock,
  cliStates,
  tabsChangedListener,
} = vi.hoisted(() => {
  interface MockCliState {
    readonly instanceId: string;
    profileId: string | null;
    profileName: string | null;
    agentInstanceId: string | null;
    providerId: string | null;
    providerName: string | null;
    modelId: string | null;
    modelName: string | null;
    workspace: string | null;
    activeSessionId: string | null;
    submitCalls: string[];
  }

  const availableProviders = [
    {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      status: 'active' as const,
      authState: 'configured' as const,
      defaultModelId: 'copilot-chat',
      models: [{ id: 'copilot-chat', name: 'GPT-5.4', supportsTools: true }],
      capabilities: { codeExecution: true, toolUse: true, streaming: true },
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      status: 'active' as const,
      authState: 'configured' as const,
      defaultModelId: 'deepseek-v4-pro',
      models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsTools: true }],
      capabilities: { codeExecution: true, toolUse: true, streaming: true },
    },
  ];

  const states: MockCliState[] = [];
  const createCliDependencies = vi.fn((_config, options?: { initialWorkspace?: string | null }) => {
    const instanceId = `cli-${states.length + 1}`;
    const state: MockCliState = {
      instanceId,
      profileId: null,
      profileName: null,
      agentInstanceId: null,
      providerId: 'github-copilot',
      providerName: 'GitHub Copilot',
      modelId: 'copilot-chat',
      modelName: 'GPT-5.4',
      workspace: options?.initialWorkspace ?? 'd:\\workspace\\default',
      activeSessionId: null,
      submitCalls: [],
    };
    states.push(state);

    const getRuntimeStatus = vi.fn(async () => ({
      providerId: state.providerId,
      providerName: state.providerName,
      agentProfileId: state.profileId,
      agentProfileName: state.profileName,
      agentInstanceId: state.agentInstanceId,
      modelId: state.modelId,
      modelName: state.modelName,
      workspace: state.workspace,
      activeSessionId: state.activeSessionId,
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
      backgroundSummaryStatus: {
        state: 'idle',
        activeSummarySessionId: null,
        lastSummaryAt: null,
        lastSummaryMemoryId: null,
      },
      availableProviders,
      providerStatuses: {
        githubCopilot: {
          providerId: 'github-copilot' as const,
          authState: 'configured' as const,
          credentialSource: 'env' as const,
          defaultModelId: 'copilot-chat',
          credentialTarget: null,
          oauthClientIdConfigured: false,
        },
        deepseek: {
          providerId: 'deepseek' as const,
          authState: 'configured' as const,
          credentialSource: 'env' as const,
          defaultModelId: 'deepseek-v4-pro',
          credentialTarget: null,
          baseUrl: 'https://api.deepseek.com',
        },
      },
      workflow: {
        hasActiveWorkflow: false,
        workflowId: null,
        workflowType: null,
        status: null,
        activeRoundNumber: null,
      },
    }));

    return {
      submitInput: vi.fn(async (input: { inputText: string }) => {
        state.submitCalls.push(input.inputText);
        return {
          ok: true,
          code: 'MOCK_SUBMIT',
          message: input.inputText,
          data: { outputSummary: input.inputText },
          suggestions: [],
        };
      }),
      getRuntimeStatus,
      listAgentProfiles: vi.fn(() => [
        { id: 'code-master', name: 'Code Master' },
        { id: 'architect', name: 'Architect' },
      ]),
      startAgentSession: vi.fn(async (profileId: string) => {
        state.profileId = profileId;
        state.profileName = profileId === 'architect' ? 'Architect' : 'Code Master';
        state.agentInstanceId = `${profileId}-instance`;
        state.activeSessionId = `${profileId}-session`;
        return {};
      }),
      setWorkspaceRoot: vi.fn(async (workspacePath: string) => {
        state.workspace = workspacePath;
        return {};
      }),
      setProviderSelection: vi.fn(async (providerId: string, modelId?: string | null) => {
        state.providerId = providerId;
        state.providerName = providerId === 'deepseek' ? 'DeepSeek' : 'GitHub Copilot';
        state.modelId = modelId ?? (providerId === 'deepseek' ? 'deepseek-v4-pro' : 'copilot-chat');
        state.modelName = state.modelId === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'GPT-5.4';
        return {};
      }),
      listAgentSessions: vi.fn(() => []),
      getSession: vi.fn(async () => null),
      listSessionMemories: vi.fn(() => []),
      selectSession: vi.fn(async (sessionId: string) => {
        state.activeSessionId = sessionId;
        return { runtimeStatus: await getRuntimeStatus(), session: null };
      }),
      listProviderConfigurations: vi.fn(() => []),
      saveGenericProviderConfiguration: vi.fn(),
      removeGenericProviderConfiguration: vi.fn(),
      setProgressReporter: vi.fn(),
      setToolApprovalHandler: vi.fn(),
      setToolApprovalBatchHandler: vi.fn(),
      setFileReviewHandler: vi.fn(),
      getTaskRunner: vi.fn(() => ({
        run: vi.fn(async () => ({
          ok: true,
          code: 'MOCK_TASK',
          message: 'ok',
          outputSummary: '{"valid": true, "reason": "ok"}',
          suggestions: [],
        })),
      })),
      getContextResolver: vi.fn(() => ({
        resolve: vi.fn(async () => ({
          taskContext: {
            providerId: state.providerId,
            selectedModelId: state.modelId,
            prompts: [],
          },
          runtimeStatus: await getRuntimeStatus(),
        })),
      })),
      channelService: {},
      createSessionForChannel: vi.fn(),
      databaseClose: vi.fn(),
    };
  });

  return {
    createCliDependenciesMock: createCliDependencies,
    routeInputMock: vi.fn(async ({ input, runtime }) => runtime.submitInput(input)),
    cliStates: states,
    tabsChangedListener: vi.fn(),
  };
});

vi.mock('../../src/cli/index', () => ({
  createCliDependencies: createCliDependenciesMock,
}));

vi.mock('../../src/commands/input-router', () => ({
  routeInput: routeInputMock,
}));

import { DesktopAgentTabManager } from '../../src/desktop/main/desktop-tab-manager';

describe('DesktopAgentTabManager', () => {
  beforeEach(() => {
    createCliDependenciesMock.mockClear();
    routeInputMock.mockClear();
    tabsChangedListener.mockClear();
    cliStates.splice(0, cliStates.length);
  });

  it('creates independent runtimes per tab and routes tab-scoped status and submit operations', async () => {
    const manager = new DesktopAgentTabManager({
      config: createTestAppConfig(),
      initialWorkspace: 'd:\\workspace\\alpha',
      onOutput: vi.fn(),
      onToolApprovalState: vi.fn(),
      onTabsChanged: tabsChangedListener,
    });

    await manager.ready();
    const [firstTab] = await manager.listTabs();
    expect(firstTab.runtimeStatus.agentProfileId).toBe('code-master');
    expect(firstTab.runtimeStatus.workspace).toBe('d:\\workspace\\alpha');

    const secondTab = await manager.createTab({
      profileId: 'architect',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      workspace: 'd:\\workspace\\beta',
    });

    expect(secondTab.runtimeStatus.agentProfileId).toBe('architect');
    expect(secondTab.runtimeStatus.providerId).toBe('deepseek');
    expect(secondTab.runtimeStatus.workspace).toBe('d:\\workspace\\beta');

    const secondStatus = await manager.getRuntimeStatus(secondTab.id);
    expect(secondStatus.agentProfileId).toBe('architect');

    const response = await manager.submitInput(secondTab.id, {
      requestId: 'req-1',
      windowId: secondTab.id,
      sessionId: secondStatus.activeSessionId,
      inputText: 'inspect second tab',
      attachments: [],
      submittedAt: new Date().toISOString(),
    });

    expect(response.tabId).toBe(secondTab.id);
    expect(cliStates[1]?.submitCalls).toEqual(['inspect second tab']);
    expect(cliStates[0]?.submitCalls).toEqual([]);
  });

  it('rejects duplicate profile assignment across tabs with an explicit error', async () => {
    const manager = new DesktopAgentTabManager({
      config: createTestAppConfig(),
      initialWorkspace: 'd:\\workspace\\alpha',
      onOutput: vi.fn(),
      onToolApprovalState: vi.fn(),
      onTabsChanged: vi.fn(),
    });

    await manager.ready();
    await manager.createTab({ profileId: 'architect', workspace: 'd:\\workspace\\beta' });

    await expect(manager.createTab({ profileId: 'architect', workspace: 'd:\\workspace\\gamma' }))
      .rejects
      .toThrow('Agent profile "architect" is already assigned');
  });
});
