import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/desktop/renderer/App';
import type { ProviderProfile, RendererMessageTraceStep, RendererOutputBlock } from '../../src/shared/schema';

let outputListener: ((event: unknown, data: RendererOutputBlock) => void) | null = null;
let menuActionListener: ((action: 'open-provider-config' | 'open-agent-picker') => void) | null = null;

const defaultProviderStatuses = {
  githubCopilot: {
    providerId: 'github-copilot' as const,
    authState: 'configured' as const,
    credentialSource: 'windows-credential-manager' as const,
    defaultModelId: 'copilot-chat',
    credentialTarget: 'Pueblo:GitHubCopilot:test',
    oauthClientIdConfigured: true,
  },
  deepseek: {
    providerId: 'deepseek' as const,
    authState: 'configured' as const,
    credentialSource: 'windows-credential-manager' as const,
    defaultModelId: 'deepseek-v4-pro',
    credentialTarget: 'Pueblo:DeepSeek:test',
    baseUrl: 'https://api.deepseek.com',
  },
};

const defaultAvailableProviders: ProviderProfile[] = [
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    status: 'active',
    authState: 'configured',
    defaultModelId: 'copilot-chat',
    models: [{ id: 'copilot-chat', name: 'GPT-5.4', supportsTools: true }],
    capabilities: { codeExecution: true, toolUse: true, streaming: true },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    status: 'active',
    authState: 'configured',
    defaultModelId: 'deepseek-v4-pro',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsTools: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsTools: true },
    ],
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
  menuActionListener = null;
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
          availableProviders: defaultAvailableProviders,
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
          providerStatuses: defaultProviderStatuses,
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
        availableProviders: defaultAvailableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
        providerStatuses: defaultProviderStatuses,
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
        availableProviders: defaultAvailableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
        providerStatuses: defaultProviderStatuses,
      }),
      onMenuAction: vi.fn((callback: (action: 'open-provider-config' | 'open-agent-picker') => void) => {
        menuActionListener = callback;
        return () => {
          menuActionListener = null;
        };
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
    expect(window.electronAPI.onMenuAction).toHaveBeenCalledTimes(1);
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
      expect(screen.getByDisplayValue('Code Master')).toBeTruthy();
    });

    await user.type(screen.getByPlaceholderText('Enter command or task...'), '/help');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('/help')).toBeTruthy();

    await user.selectOptions(screen.getByDisplayValue('Code Master'), 'architect');

    await waitFor(() => {
      expect(window.electronAPI.startAgentSession).toHaveBeenCalledWith('architect');
      expect(screen.queryByText('/help')).toBeNull();
      expect(screen.getByText('Architect')).toBeTruthy();
    });
  });

  it('should configure DeepSeek from the desktop panel without echoing the api key into the transcript', async () => {
    const user = userEvent.setup();
    window.electronAPI.getRuntimeStatus = vi.fn().mockResolvedValue({
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
      availableProviders: defaultAvailableProviders,
      backgroundSummaryStatus: {
        state: 'idle',
        activeSummarySessionId: null,
        lastSummaryAt: null,
        lastSummaryMemoryId: null,
      },
      providerStatuses: {
        ...defaultProviderStatuses,
        deepseek: {
          ...defaultProviderStatuses.deepseek,
          authState: 'missing',
          defaultModelId: 'deepseek-v4-flash',
        },
      },
    });
    window.electronAPI.submitInput = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        code: 'DEEPSEEK_AUTH_COMPLETED',
        message: 'DeepSeek configuration saved',
        data: {
          providerId: 'deepseek',
          defaultModelId: 'deepseek-v4-pro',
          baseUrl: 'https://api.deepseek.com',
          credentialTarget: 'Pueblo:DeepSeek:test',
        },
        suggestions: [],
      },
      blocks: [],
      runtimeStatus: {
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        agentProfileId: 'code-master',
        agentProfileName: 'Code Master',
        agentInstanceId: 'agent-1',
        modelId: 'deepseek-v4-pro',
        modelName: 'DeepSeek V4 Pro',
        activeSessionId: 'session-1',
        contextCount: {
          estimatedTokens: 12,
          contextWindowLimit: 64000,
          utilizationRatio: 0.0002,
          messageCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          derivedMemoryCount: 0,
        },
        modelMessageCount: 0,
        modelMessageCharCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        availableProviders: defaultAvailableProviders,
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
        providerStatuses: {
          ...defaultProviderStatuses,
          deepseek: {
            ...defaultProviderStatuses.deepseek,
            authState: 'configured',
            defaultModelId: 'deepseek-v4-pro',
          },
        },
      },
    });
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByDisplayValue('GitHub Copilot')).toBeTruthy();
    });

    act(() => {
      menuActionListener?.('open-provider-config');
    });
    await user.click(screen.getByRole('button', { name: 'DeepSeek' }));
    await user.type(screen.getByPlaceholderText('DeepSeek API key'), 'deepseek-secret');
    await user.selectOptions(screen.getByDisplayValue('deepseek-v4-flash'), 'deepseek-v4-pro');
    await user.click(screen.getByRole('button', { name: 'Save DeepSeek Configuration' }));

    await waitFor(() => {
      expect(window.electronAPI.submitInput).toHaveBeenCalledWith(
        '/provider-config deepseek set-key deepseek-secret deepseek-v4-pro https://api.deepseek.com',
      );
      expect(screen.getByText('DeepSeek')).toBeTruthy();
      expect(screen.getByText('DeepSeek V4 Pro')).toBeTruthy();
    });

    expect(screen.queryByText('deepseek-secret')).toBeNull();
    expect(screen.queryByText('/provider-config deepseek set-key deepseek-secret deepseek-v4-pro https://api.deepseek.com')).toBeNull();
  });

  it('should explain that GitHub login starts device flow', async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByDisplayValue('GitHub Copilot')).toBeTruthy();
    });

    act(() => {
      menuActionListener?.('open-provider-config');
    });

    expect(screen.getByText("This action starts GitHub's device flow login. Pueblo opens the browser to GitHub, shows the one-time code in the output pane, then stores the resulting token in Windows Credential Manager.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run GitHub device login again' })).toBeTruthy();
  });

  it('should show a DeepSeek summary card after configuration and only reveal the form when updating', async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByDisplayValue('GitHub Copilot')).toBeTruthy();
    });

    act(() => {
      menuActionListener?.('open-provider-config');
    });
    await user.click(screen.getByRole('button', { name: 'DeepSeek' }));

    expect(screen.getByText('DeepSeek access is already configured. This screen stays available for rotating the API key or changing the default model/base URL, but you should not need to revisit it for normal use.')).toBeTruthy();
    expect(screen.queryByPlaceholderText('DeepSeek API key')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Update DeepSeek configuration' }));

    expect(screen.getByPlaceholderText('DeepSeek API key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('should render GitHub device login progress messages in the output pane', async () => {
    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter command or task...')).toBeTruthy();
    });

    act(() => {
      outputListener?.({}, createBlock({
        id: 'device-login-progress',
        type: 'system',
        title: 'GitHub Device Login',
        content: 'Open https://github.com/login/device and enter code: WDJB-MJHT',
      }));
    });

    expect(screen.getByText('Open https://github.com/login/device and enter code: WDJB-MJHT')).toBeTruthy();
  });

  it('should switch provider and model through the status dropdowns', async () => {
    const user = userEvent.setup();
    window.electronAPI.submitInput = vi
      .fn()
      .mockResolvedValueOnce({
        result: { ok: true, code: 'MODEL_SELECTED', message: 'Current model updated', data: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, suggestions: [] },
        blocks: [],
        runtimeStatus: {
          providerId: 'deepseek',
          providerName: 'DeepSeek',
          agentProfileId: 'code-master',
          agentProfileName: 'Code Master',
          agentInstanceId: 'agent-1',
          modelId: 'deepseek-v4-pro',
          modelName: 'DeepSeek V4 Pro',
          activeSessionId: 'session-1',
          contextCount: {
            estimatedTokens: 12,
            contextWindowLimit: 64000,
            utilizationRatio: 0.0002,
            messageCount: 0,
            selectedPromptCount: 0,
            selectedMemoryCount: 0,
            derivedMemoryCount: 0,
          },
          modelMessageCount: 0,
          modelMessageCharCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          availableProviders: defaultAvailableProviders,
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
          providerStatuses: defaultProviderStatuses,
        },
      })
      .mockResolvedValueOnce({
        result: { ok: true, code: 'MODEL_SELECTED', message: 'Current model updated', data: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }, suggestions: [] },
        blocks: [],
        runtimeStatus: {
          providerId: 'deepseek',
          providerName: 'DeepSeek',
          agentProfileId: 'code-master',
          agentProfileName: 'Code Master',
          agentInstanceId: 'agent-1',
          modelId: 'deepseek-v4-flash',
          modelName: 'DeepSeek V4 Flash',
          activeSessionId: 'session-1',
          contextCount: {
            estimatedTokens: 12,
            contextWindowLimit: 64000,
            utilizationRatio: 0.0002,
            messageCount: 0,
            selectedPromptCount: 0,
            selectedMemoryCount: 0,
            derivedMemoryCount: 0,
          },
          modelMessageCount: 0,
          modelMessageCharCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          availableProviders: defaultAvailableProviders,
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
          providerStatuses: defaultProviderStatuses,
        },
      });

    render(createElement(App));

    await waitFor(() => {
      expect(screen.getByDisplayValue('GitHub Copilot')).toBeTruthy();
    });

    await user.selectOptions(screen.getByDisplayValue('GitHub Copilot'), 'deepseek');

    await waitFor(() => {
      expect(window.electronAPI.submitInput).toHaveBeenNthCalledWith(1, '/model deepseek');
      expect(screen.getByDisplayValue('DeepSeek')).toBeTruthy();
      expect(screen.getByDisplayValue('DeepSeek V4 Pro')).toBeTruthy();
    });

    await user.selectOptions(screen.getByDisplayValue('DeepSeek V4 Pro'), 'deepseek-v4-flash');

    await waitFor(() => {
      expect(window.electronAPI.submitInput).toHaveBeenNthCalledWith(2, '/model deepseek deepseek-v4-flash');
      expect(screen.getByDisplayValue('DeepSeek V4 Flash')).toBeTruthy();
    });
  });
});