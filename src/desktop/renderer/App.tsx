import React, { useEffect, useRef, useState } from 'react';
import type { AgentProfileTemplate, ProviderProfile, RendererMessageTraceStep, RendererOutputBlock } from '../../shared/schema';
import type { DesktopMenuAction, DesktopProviderStatus, DesktopRuntimeStatus, DesktopSubmitResponse } from '../shared/ipc-contract';
import './styles.css';

interface UserTranscriptEntry {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly createdAt: string;
  readonly messageTrace: RendererMessageTraceStep[];
}

type TranscriptEntry = UserTranscriptEntry | RendererOutputBlock;
type ProviderConfigMode = 'github-copilot' | 'deepseek';

const EMPTY_RUNTIME_STATUS: DesktopRuntimeStatus = {
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
  providerStatuses: {
    githubCopilot: {
      providerId: 'github-copilot',
      authState: 'missing',
      credentialSource: 'env',
      defaultModelId: null,
      credentialTarget: null,
      oauthClientIdConfigured: false,
    },
    deepseek: {
      providerId: 'deepseek',
      authState: 'missing',
      credentialSource: 'env',
      defaultModelId: null,
      credentialTarget: null,
      baseUrl: 'https://api.deepseek.com',
    },
  },
};

declare global {
  interface Window {
    electronAPI: {
      submitInput: (input: string) => Promise<DesktopSubmitResponse>;
      getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
      listAgentProfiles: () => Promise<AgentProfileTemplate[]>;
      startAgentSession: (profileId: string) => Promise<DesktopRuntimeStatus>;
      onMenuAction: (callback: (action: DesktopMenuAction) => void) => (() => void);
      onOutput: (callback: (event: unknown, data: RendererOutputBlock) => void) => void;
      removeAllListeners: (event: string) => void;
    };
  }
}

export function App() {
  const [input, setInput] = useState('');
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus>(EMPTY_RUNTIME_STATUS);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileTemplate[]>([]);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startingProfileId, setStartingProfileId] = useState<string | null>(null);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isProviderConfigOpen, setIsProviderConfigOpen] = useState(false);
  const [providerConfigMode, setProviderConfigMode] = useState<ProviderConfigMode>('github-copilot');
  const [providerConfigError, setProviderConfigError] = useState<string | null>(null);
  const [providerConfigPending, setProviderConfigPending] = useState<string | null>(null);
  const [deepSeekApiKey, setDeepSeekApiKey] = useState('');
  const [deepSeekModelId, setDeepSeekModelId] = useState('deepseek-v4-flash');
  const [deepSeekBaseUrl, setDeepSeekBaseUrl] = useState('https://api.deepseek.com');
  const [isDeepSeekEditing, setIsDeepSeekEditing] = useState(false);
  const runtimeStatusRef = useRef(runtimeStatus);

  useEffect(() => {
    void window.electronAPI.getRuntimeStatus().then(setRuntimeStatus).catch(() => {
      setRuntimeStatus(EMPTY_RUNTIME_STATUS);
    });
    void window.electronAPI.listAgentProfiles().then(setAgentProfiles).catch((error) => {
      setStartupError(error instanceof Error ? error.message : 'Failed to load agent profiles.');
    });

    window.electronAPI.onOutput((event, data) => {
      setTranscriptEntries((previous) => [...previous, data]);
    });

    return () => {
      window.electronAPI.removeAllListeners('output');
    };
  }, []);

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
  }, [runtimeStatus]);

  useEffect(() => {
    const disposeMenuAction = window.electronAPI.onMenuAction((action) => {
      const currentRuntimeStatus = runtimeStatusRef.current;

      if (action === 'open-provider-config') {
        setProviderConfigError(null);
        setProviderConfigMode(currentRuntimeStatus.providerId === 'deepseek' ? 'deepseek' : 'github-copilot');
        setIsDeepSeekEditing((currentRuntimeStatus.providerId === 'deepseek'
          ? (currentRuntimeStatus.providerStatuses?.deepseek?.authState ?? 'missing') !== 'configured'
          : false));
        setIsProviderConfigOpen(true);
        setIsAgentPickerOpen(false);
        return;
      }

      setStartupError(null);
      setIsAgentPickerOpen(true);
      setIsProviderConfigOpen(false);
    });

    return () => {
      disposeMenuAction();
    };
  }, []);

  const appendErrorBlock = (title: string, message: string) => {
    setTranscriptEntries((previous) => [
      ...previous,
      {
        id: `${new Date().toISOString()}-${Math.random().toString(16).slice(2)}`,
        type: 'error',
        title,
        content: message,
        collapsed: false,
        messageTrace: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const executeInput = async (submittedInput: string, options: { recordUserEntry: boolean } = { recordUserEntry: true }) => {
    const trimmedInput = submittedInput.trim();

    if (!trimmedInput || !runtimeStatus.agentProfileId || !runtimeStatus.activeSessionId) {
      return null;
    }

    const createdAt = new Date().toISOString();
    const transcriptEntryId = `${createdAt}-${Math.random().toString(16).slice(2)}`;

    try {
      if (options.recordUserEntry) {
        setTranscriptEntries((previous) => [
          ...previous,
          {
            id: transcriptEntryId,
            role: 'user',
            content: trimmedInput,
            createdAt,
            messageTrace: [],
          },
        ]);
      }

      const response = await window.electronAPI.submitInput(trimmedInput);
      const messageTrace = response.blocks.find((block) => block.messageTrace.length > 0)?.messageTrace ?? [];

      if (options.recordUserEntry) {
        setTranscriptEntries((previous) => previous.map((entry) => {
          if ('role' in entry && entry.id === transcriptEntryId) {
            return {
              ...entry,
              messageTrace,
            };
          }

          return entry;
        }));
      }

      setRuntimeStatus(response.runtimeStatus);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      setTranscriptEntries((previous) => [
        ...previous,
        {
          id: `${createdAt}-${Math.random().toString(16).slice(2)}`,
          type: 'error',
          title: 'Submission Error',
          content: message,
          collapsed: false,
          messageTrace: [],
          sourceRefs: [],
          createdAt,
        },
      ]);

      return null;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const response = await executeInput(input, { recordUserEntry: true });

    if (response) {
      setInput('');
    }
  };

  const handleStartAgentSession = async (profileId: string) => {
    setStartingProfileId(profileId);
    setStartupError(null);

    try {
      const nextRuntimeStatus = await window.electronAPI.startAgentSession(profileId);
      setTranscriptEntries([]);
      setInput('');
      setRuntimeStatus(nextRuntimeStatus);
      setIsAgentPickerOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start agent session.';
      setStartupError(message);
      appendErrorBlock('Agent Switch Error', message);
    } finally {
      setStartingProfileId(null);
    }
  };

  const handleProviderSelection = async (providerId: string) => {
    if (!providerId || providerId === runtimeStatus.providerId) {
      return;
    }

    const response = await executeInput(`/model ${providerId}`, { recordUserEntry: false });

    if (!response || !response.result.ok) {
      const message = response?.result.message ?? 'Failed to switch provider.';
      setStartupError(message);
      appendErrorBlock('Provider Switch Error', message);
      return;
    }

    setStartupError(null);
  };

  const handleModelSelection = async (providerId: string, modelId: string) => {
    if (!providerId || !modelId || (providerId === runtimeStatus.providerId && modelId === runtimeStatus.modelId)) {
      return;
    }

    const response = await executeInput(`/model ${providerId} ${modelId}`, { recordUserEntry: false });

    if (!response || !response.result.ok) {
      const message = response?.result.message ?? 'Failed to switch model.';
      setStartupError(message);
      appendErrorBlock('Model Switch Error', message);
      return;
    }

    setStartupError(null);
  };

  const handleGitHubProviderLogin = async () => {
    setProviderConfigPending('github-copilot');
    setProviderConfigError(null);

    const response = await executeInput('/provider-config github-copilot login', { recordUserEntry: false });

    if (!response || !response.result.ok) {
      setProviderConfigError(response?.result.message ?? 'Failed to configure GitHub Copilot.');
      setProviderConfigPending(null);
      return;
    }

    setProviderConfigPending(null);
    setIsProviderConfigOpen(false);
  };

  const handleDeepSeekProviderSave = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!deepSeekApiKey.trim()) {
      setProviderConfigError('DeepSeek API key is required.');
      return;
    }

    setProviderConfigPending('deepseek');
    setProviderConfigError(null);

    const response = await executeInput(
      `/provider-config deepseek set-key ${deepSeekApiKey.trim()} ${deepSeekModelId} ${deepSeekBaseUrl.trim()}`,
      { recordUserEntry: false },
    );

    if (!response || !response.result.ok) {
      setProviderConfigError(response?.result.message ?? 'Failed to configure DeepSeek.');
      setProviderConfigPending(null);
      return;
    }

    setProviderConfigPending(null);
    setDeepSeekApiKey('');
    setIsDeepSeekEditing(false);
    setIsProviderConfigOpen(false);
  };

  const needsAgentSelection = !runtimeStatus.agentProfileId || !runtimeStatus.activeSessionId;
  const showAgentPicker = needsAgentSelection || isAgentPickerOpen;
  const showProviderConfig = !showAgentPicker && (isProviderConfigOpen || !runtimeStatus.providerId);
  const githubProviderStatus = runtimeStatus.providerStatuses?.githubCopilot ?? EMPTY_RUNTIME_STATUS.providerStatuses!.githubCopilot;
  const deepSeekProviderStatus = runtimeStatus.providerStatuses?.deepseek ?? EMPTY_RUNTIME_STATUS.providerStatuses!.deepseek;
  const availableProviders = runtimeStatus.availableProviders ?? EMPTY_RUNTIME_STATUS.availableProviders ?? [];
  const selectedProviderProfile = findProviderProfile(availableProviders, runtimeStatus.providerId);
  const availableModels = selectedProviderProfile?.models ?? [];

  return (
    <div className="app">
      <section className="output-pane" aria-label="output-region">
        {showAgentPicker ? renderAgentPicker(
          agentProfiles,
          startingProfileId,
          startupError,
          handleStartAgentSession,
          !needsAgentSelection ? () => {
            setIsAgentPickerOpen(false);
            setStartupError(null);
          } : null,
        ) : showProviderConfig ? renderProviderConfigPanel({
          providerConfigMode,
          providerConfigError,
          providerConfigPending,
          deepSeekApiKey,
          deepSeekModelId,
          deepSeekBaseUrl,
          githubProviderStatus,
          deepSeekProviderStatus,
          isDeepSeekEditing,
          onSelectMode: (mode) => {
            setProviderConfigMode(mode);
            setProviderConfigError(null);
            setIsDeepSeekEditing(mode === 'deepseek' ? deepSeekProviderStatus.authState !== 'configured' : false);
          },
          onClose: runtimeStatus.providerId ? () => {
            setIsProviderConfigOpen(false);
            setProviderConfigError(null);
            setIsDeepSeekEditing(false);
          } : null,
          onGitHubLogin: () => {
            void handleGitHubProviderLogin();
          },
          onStartDeepSeekEdit: () => {
            setProviderConfigError(null);
            setDeepSeekApiKey('');
            setDeepSeekModelId(deepSeekProviderStatus.defaultModelId ?? 'deepseek-v4-flash');
            setDeepSeekBaseUrl(deepSeekProviderStatus.baseUrl ?? 'https://api.deepseek.com');
            setIsDeepSeekEditing(true);
          },
          onCancelDeepSeekEdit: () => {
            setProviderConfigError(null);
            setDeepSeekApiKey('');
            setDeepSeekModelId(deepSeekProviderStatus.defaultModelId ?? 'deepseek-v4-flash');
            setDeepSeekBaseUrl(deepSeekProviderStatus.baseUrl ?? 'https://api.deepseek.com');
            setIsDeepSeekEditing(false);
          },
          onDeepSeekApiKeyChange: setDeepSeekApiKey,
          onDeepSeekModelChange: setDeepSeekModelId,
          onDeepSeekBaseUrlChange: setDeepSeekBaseUrl,
          onDeepSeekSubmit: (event) => {
            void handleDeepSeekProviderSave(event);
          },
        }) : transcriptEntries.length === 0 ? (
          <div className="output-empty">No output yet.</div>
        ) : transcriptEntries.map((entry) => renderTranscriptEntry(entry))}
      </section>
      <section className="status-strip" aria-label="runtime-status">
        <label className="status-chip status-chip-select">
          <span className="status-chip-label">Agent</span>
          <select
            className="status-chip-select-control"
            value={runtimeStatus.agentProfileId ?? ''}
            onChange={(event) => {
              void handleStartAgentSession(event.target.value);
            }}
            disabled={startingProfileId !== null || agentProfiles.length === 0}
          >
            {agentProfiles.length === 0 ? <option value="">No agents available</option> : null}
            {agentProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className="status-chip status-chip-select">
          <span className="status-chip-label">Provider</span>
          <select
            className="status-chip-select-control"
            value={runtimeStatus.providerId ?? ''}
            onChange={(event) => {
              void handleProviderSelection(event.target.value);
            }}
            disabled={availableProviders.length === 0}
          >
            {availableProviders.length === 0 ? <option value="">No providers available</option> : null}
            {availableProviders.map((provider) => (
              <option
                key={provider.id}
                value={provider.id}
                disabled={provider.status !== 'active' || provider.authState !== 'configured'}
              >
                {provider.name}{provider.authState !== 'configured' ? ' (not configured)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="status-chip status-chip-select">
          <span className="status-chip-label">Model</span>
          <select
            className="status-chip-select-control"
            value={runtimeStatus.modelId ?? ''}
            onChange={(event) => {
              if (runtimeStatus.providerId) {
                void handleModelSelection(runtimeStatus.providerId, event.target.value);
              }
            }}
            disabled={!runtimeStatus.providerId || availableModels.length === 0}
          >
            {availableModels.length === 0 ? <option value="">No models available</option> : null}
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <span className="status-chip">
          <span className="status-chip-label">Message Length</span>
          <span className="status-chip-value">{runtimeStatus.modelMessageCharCount} chars</span>
        </span>
      </section>
      <form className="input-pane" aria-label="input-region" onSubmit={handleSubmit}>
        <label className="input-label" htmlFor="pueblo-input">pueblo&gt;</label>
        <input
          id="pueblo-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={needsAgentSelection ? 'Select an agent profile to begin...' : 'Enter command or task...'}
          disabled={needsAgentSelection}
          autoFocus
        />
        <button type="submit" disabled={needsAgentSelection}>Send</button>
      </form>
    </div>
  );
}

function renderProviderConfigPanel(args: {
  providerConfigMode: ProviderConfigMode;
  providerConfigError: string | null;
  providerConfigPending: string | null;
  deepSeekApiKey: string;
  deepSeekModelId: string;
  deepSeekBaseUrl: string;
  githubProviderStatus: DesktopProviderStatus;
  deepSeekProviderStatus: DesktopProviderStatus;
  isDeepSeekEditing: boolean;
  onSelectMode: (mode: ProviderConfigMode) => void;
  onClose: (() => void) | null;
  onGitHubLogin: () => void;
  onStartDeepSeekEdit: () => void;
  onCancelDeepSeekEdit: () => void;
  onDeepSeekApiKeyChange: (value: string) => void;
  onDeepSeekModelChange: (value: string) => void;
  onDeepSeekBaseUrlChange: (value: string) => void;
  onDeepSeekSubmit: (event: React.FormEvent) => void;
}) {
  const deepSeekConfigured = args.deepSeekProviderStatus.authState === 'configured';

  return (
    <section className="provider-config" aria-label="provider-config-panel">
      <header className="provider-config-header">
        <div>
          <p className="provider-config-eyebrow">Provider Setup</p>
          <h1>Configure model access</h1>
          <p className="provider-config-copy">Desktop reuses the same provider configuration commands as the CLI, but keeps secrets out of the visible transcript.</p>
        </div>
        {args.onClose ? (
          <button type="button" className="provider-config-close" onClick={args.onClose}>
            Close
          </button>
        ) : null}
      </header>
      <div className="provider-config-tabs" role="tablist" aria-label="provider-config-modes">
        <button
          type="button"
          className={`provider-config-tab ${args.providerConfigMode === 'github-copilot' ? 'provider-config-tab-active' : ''}`}
          onClick={() => args.onSelectMode('github-copilot')}
        >
          GitHub Copilot
        </button>
        <button
          type="button"
          className={`provider-config-tab ${args.providerConfigMode === 'deepseek' ? 'provider-config-tab-active' : ''}`}
          onClick={() => args.onSelectMode('deepseek')}
        >
          DeepSeek
        </button>
      </div>
      {args.providerConfigError ? <p className="provider-config-error">{args.providerConfigError}</p> : null}
      {args.providerConfigMode === 'github-copilot' ? (
        <div className="provider-config-card">
          <div className="provider-config-status-list">
            <p className="provider-config-status-item"><strong>Status:</strong> {formatProviderAuthState(args.githubProviderStatus.authState)}</p>
            <p className="provider-config-status-item"><strong>Credential storage:</strong> {formatCredentialSource(args.githubProviderStatus.credentialSource)}</p>
            <p className="provider-config-status-item"><strong>Default model:</strong> {args.githubProviderStatus.defaultModelId ?? 'copilot-chat'}</p>
          </div>
          <p className="provider-config-copy">
            This action starts GitHub's device flow login. Pueblo opens the browser to GitHub, shows the one-time code in the output pane, then stores the resulting token in Windows Credential Manager.
          </p>
          {!args.githubProviderStatus.oauthClientIdConfigured ? (
            <p className="provider-config-error">GitHub OAuth client id is missing from .pueblo/config.json.</p>
          ) : null}
          <button
            type="button"
            className="provider-config-primary"
            onClick={args.onGitHubLogin}
            disabled={args.providerConfigPending !== null}
          >
            {args.providerConfigPending === 'github-copilot'
              ? 'Starting device login...'
              : args.githubProviderStatus.authState === 'configured'
                ? 'Run GitHub device login again'
                : 'Start GitHub device login'}
          </button>
        </div>
      ) : deepSeekConfigured && !args.isDeepSeekEditing ? (
        <div className="provider-config-card">
          <div className="provider-config-status-list">
            <p className="provider-config-status-item"><strong>Status:</strong> Configured</p>
            <p className="provider-config-status-item"><strong>Credential storage:</strong> {formatCredentialSource(args.deepSeekProviderStatus.credentialSource)}</p>
            <p className="provider-config-status-item"><strong>Default model:</strong> {args.deepSeekProviderStatus.defaultModelId ?? 'deepseek-v4-flash'}</p>
            <p className="provider-config-status-item"><strong>Base URL:</strong> {args.deepSeekProviderStatus.baseUrl ?? 'https://api.deepseek.com'}</p>
          </div>
          <p className="provider-config-copy">
            DeepSeek access is already configured. This screen stays available for rotating the API key or changing the default model/base URL, but you should not need to revisit it for normal use.
          </p>
          <button type="button" className="provider-config-secondary" onClick={args.onStartDeepSeekEdit}>
            Update DeepSeek configuration
          </button>
        </div>
      ) : (
        <form className="provider-config-card provider-config-form" onSubmit={args.onDeepSeekSubmit}>
          <p className="provider-config-copy">
            {deepSeekConfigured
              ? 'Update the saved DeepSeek configuration. Leave this alone unless you are rotating the API key or changing the default model/base URL.'
              : 'DeepSeek setup is usually a one-time action. The API key is stored outside the visible transcript.'}
          </p>
          <label className="provider-config-field">
            <span>API Key</span>
            <input
              type="password"
              value={args.deepSeekApiKey}
              onChange={(event) => args.onDeepSeekApiKeyChange(event.target.value)}
              placeholder="DeepSeek API key"
            />
          </label>
          <label className="provider-config-field">
            <span>Default Model</span>
            <select value={args.deepSeekModelId} onChange={(event) => args.onDeepSeekModelChange(event.target.value)}>
              <option value="deepseek-v4-flash">deepseek-v4-flash</option>
              <option value="deepseek-v4-pro">deepseek-v4-pro</option>
            </select>
          </label>
          <label className="provider-config-field">
            <span>Base URL</span>
            <input
              type="url"
              value={args.deepSeekBaseUrl}
              onChange={(event) => args.onDeepSeekBaseUrlChange(event.target.value)}
              placeholder="https://api.deepseek.com"
            />
          </label>
          <button type="submit" className="provider-config-primary" disabled={args.providerConfigPending !== null}>
            {args.providerConfigPending === 'deepseek' ? 'Saving...' : 'Save DeepSeek Configuration'}
          </button>
          {deepSeekConfigured ? (
            <button type="button" className="provider-config-secondary" onClick={args.onCancelDeepSeekEdit}>
              Cancel
            </button>
          ) : null}
        </form>
      )}
    </section>
  );
}

function formatProviderAuthState(value: DesktopProviderStatus['authState']): string {
  switch (value) {
    case 'configured':
      return 'Configured';
    case 'invalid':
      return 'Configured but invalid';
    case 'missing':
    default:
      return 'Not configured';
  }
}

function formatCredentialSource(value: DesktopProviderStatus['credentialSource']): string {
  switch (value) {
    case 'windows-credential-manager':
      return 'Windows Credential Manager';
    case 'config-file':
      return 'Config file';
    case 'external-login':
      return 'External login';
    case 'env':
    default:
      return 'Environment variable';
  }
}

function findProviderProfile(profiles: ProviderProfile[], providerId: string | null): ProviderProfile | null {
  if (!providerId) {
    return null;
  }

  return profiles.find((provider) => provider.id === providerId) ?? null;
}

function renderAgentPicker(
  agentProfiles: AgentProfileTemplate[],
  startingProfileId: string | null,
  startupError: string | null,
  onStart: (profileId: string) => void,
  onCancel: (() => void) | null,
) {
  return (
    <section className="agent-picker" aria-label="agent-profile-picker">
      <header className="agent-picker-header">
        <p className="agent-picker-eyebrow">Agent Bootstrap</p>
        <h1>Select an agent profile</h1>
        <p className="agent-picker-copy">Each desktop window becomes one agent instance. Choose the profile that should own this conversation.</p>
      </header>
      {onCancel ? (
        <div className="agent-picker-actions">
          <button type="button" className="agent-picker-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
      {startupError ? <p className="agent-picker-error">{startupError}</p> : null}
      <div className="agent-picker-grid">
        {agentProfiles.map((profile) => (
          <article key={profile.id} className="agent-card">
            <header className="agent-card-header">
              <h2>{profile.name}</h2>
              <span className="agent-card-id">{profile.id}</span>
            </header>
            <p className="agent-card-description">{profile.description}</p>
            <div className="agent-card-tags">
              <span>{profile.goalDirectives[0] ?? 'General purpose'}</span>
              <span>{profile.styleDirectives[0] ?? 'Default style'}</span>
            </div>
            <button
              type="button"
              className="agent-card-button"
              onClick={() => void onStart(profile.id)}
              disabled={startingProfileId !== null}
            >
              {startingProfileId === profile.id ? 'Starting...' : 'Start with this agent'}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function renderTranscriptEntry(entry: TranscriptEntry) {
  if ('role' in entry) {
    return (
      <article key={entry.id} className="chat-entry chat-entry-user">
        <header className="chat-entry-label">You</header>
        <p className="chat-entry-body">{entry.content}</p>
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace)}
      </article>
    );
  }

  if (entry.collapsed) {
    return (
      <div key={entry.id} className="output-block-stack">
        <details className={`output-block output-block-${entry.type}`}>
          <summary>{entry.title}</summary>
          <pre>{entry.content}</pre>
        </details>
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace)}
      </div>
    );
  }

  const isAnswerBlock = entry.type === 'task-result' || entry.type === 'command-result' || entry.type === 'error';

  if (isAnswerBlock) {
    return (
      <article key={entry.id} className={`chat-entry chat-entry-answer chat-entry-answer-${entry.type}`}>
        <header className="chat-entry-label">Pueblo</header>
        <p className="chat-entry-body">{entry.content}</p>
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace)}
      </article>
    );
  }

  return (
    <div key={entry.id} className="output-block-stack">
      <article className={`output-block output-block-${entry.type}`}>
        <header className="output-block-title">{entry.title}</header>
        <pre className="output-block-content">{entry.content}</pre>
      </article>
      {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace)}
    </div>
  );
}

function renderMessageTrace(id: string, messageTrace: RendererMessageTraceStep[] | null | undefined) {
  if (!messageTrace || messageTrace.length === 0) {
    return null;
  }

  return (
    <details key={id} className="message-details">
      <summary>Messages Sent To Model</summary>
      <div className="message-trace">
        {messageTrace.map((step) => (
          <section key={`${id}-step-${step.stepNumber}`} className="message-step">
            <header className="message-step-header">
              <span className="message-step-title">Step {step.stepNumber}</span>
              <span className="message-step-meta">{step.messageCount} messages</span>
              <span className="message-step-meta">{step.charCount} chars</span>
            </header>
            <div className="message-step-list">
              {step.messages.map((message, index) => (
                <article key={`${id}-step-${step.stepNumber}-message-${index + 1}`} className="message-item">
                  <header className="message-item-header">
                    <span className="message-item-role">{message.role}</span>
                    <span className="message-item-meta">{message.charCount} chars</span>
                    {message.toolName ? <span className="message-item-meta">tool={message.toolName}</span> : null}
                    {message.toolCallId ? <span className="message-item-meta">call={message.toolCallId}</span> : null}
                  </header>
                  <pre className="message-item-content">{message.content}</pre>
                  {message.toolArgs !== undefined ? (
                    <pre className="message-item-args">{JSON.stringify(message.toolArgs, null, 2)}</pre>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </details>
  );
}