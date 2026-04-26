import React, { useState, useEffect } from 'react';
import type { AgentProfileTemplate, RendererMessageTraceStep, RendererOutputBlock } from '../../shared/schema';
import type { DesktopRuntimeStatus, DesktopSubmitResponse } from '../shared/ipc-contract';
import './styles.css';

interface UserTranscriptEntry {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly createdAt: string;
  readonly messageTrace: RendererMessageTraceStep[];
}

type TranscriptEntry = UserTranscriptEntry | RendererOutputBlock;

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
  backgroundSummaryStatus: {
    state: 'idle',
    activeSummarySessionId: null,
    lastSummaryAt: null,
    lastSummaryMemoryId: null,
  },
};

declare global {
  interface Window {
    electronAPI: {
      submitInput: (input: string) => Promise<DesktopSubmitResponse>;
      getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
      listAgentProfiles: () => Promise<AgentProfileTemplate[]>;
      startAgentSession: (profileId: string) => Promise<DesktopRuntimeStatus>;
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = input.trim();

    if (!trimmedInput || !runtimeStatus.agentProfileId || !runtimeStatus.activeSessionId) {
      return;
    }

    try {
      const createdAt = new Date().toISOString();
      const transcriptEntryId = `${createdAt}-${Math.random().toString(16).slice(2)}`;

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

      const response = await window.electronAPI.submitInput(trimmedInput);
      const messageTrace = response.blocks.find((block) => block.messageTrace.length > 0)?.messageTrace ?? [];

      setTranscriptEntries((previous) => previous.map((entry) => {
        if ('role' in entry && entry.id === transcriptEntryId) {
          return {
            ...entry,
            messageTrace,
          };
        }

        return entry;
      }));
      setRuntimeStatus(response.runtimeStatus);
      setInput('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const createdAt = new Date().toISOString();

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
      setStartupError(error instanceof Error ? error.message : 'Failed to start agent session.');
    } finally {
      setStartingProfileId(null);
    }
  };

  const needsAgentSelection = !runtimeStatus.agentProfileId || !runtimeStatus.activeSessionId;
  const showAgentPicker = needsAgentSelection || isAgentPickerOpen;

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
        ) : transcriptEntries.length === 0 ? (
          <div className="output-empty">No output yet.</div>
        ) : transcriptEntries.map((entry) => renderTranscriptEntry(entry))}
      </section>
      <section className="status-strip" aria-label="runtime-status">
        <span className="status-chip">
          <span className="status-chip-label">Agent</span>
          <span className="status-chip-value">{runtimeStatus.agentProfileName ?? runtimeStatus.agentProfileId ?? 'unselected'}</span>
        </span>
        <span className="status-chip">
          <span className="status-chip-label">Provider</span>
          <span className="status-chip-value">{runtimeStatus.providerName ?? runtimeStatus.providerId ?? 'unselected'}</span>
        </span>
        <span className="status-chip">
          <span className="status-chip-label">Model</span>
          <span className="status-chip-value">{runtimeStatus.modelName ?? runtimeStatus.modelId ?? 'unselected'}</span>
        </span>
        <span className="status-chip">
          <span className="status-chip-label">Message Length</span>
          <span className="status-chip-value">{runtimeStatus.modelMessageCharCount} chars</span>
        </span>
        {!needsAgentSelection ? (
          <button
            type="button"
            className="status-action-button"
            onClick={() => {
              setStartupError(null);
              setIsAgentPickerOpen(true);
            }}
          >
            Switch Agent
          </button>
        ) : null}
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