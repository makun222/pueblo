import React, { useState, useEffect } from 'react';
import type { RendererOutputBlock } from '../../shared/schema';
import type { DesktopRuntimeStatus, DesktopSubmitResponse } from '../shared/ipc-contract';
import './styles.css';

interface UserTranscriptEntry {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly createdAt: string;
}

type TranscriptEntry = UserTranscriptEntry | RendererOutputBlock;

const EMPTY_RUNTIME_STATUS: DesktopRuntimeStatus = {
  providerId: null,
  providerName: null,
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
      onOutput: (callback: (event: unknown, data: RendererOutputBlock) => void) => void;
      removeAllListeners: (event: string) => void;
    };
  }
}

export function App() {
  const [input, setInput] = useState('');
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus>(EMPTY_RUNTIME_STATUS);

  useEffect(() => {
    void window.electronAPI.getRuntimeStatus().then(setRuntimeStatus).catch(() => {
      setRuntimeStatus(EMPTY_RUNTIME_STATUS);
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

    if (!trimmedInput) {
      return;
    }

    try {
      const createdAt = new Date().toISOString();

      setTranscriptEntries((previous) => [
        ...previous,
        {
          id: `${createdAt}-${Math.random().toString(16).slice(2)}`,
          role: 'user',
          content: trimmedInput,
          createdAt,
        },
      ]);

      const response = await window.electronAPI.submitInput(trimmedInput);
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
          sourceRefs: [],
          createdAt,
        },
      ]);
    }
  };

  return (
    <div className="app">
      <section className="output-pane" aria-label="output-region">
        {transcriptEntries.length === 0 ? (
          <div className="output-empty">No output yet.</div>
        ) : transcriptEntries.map((entry) => renderTranscriptEntry(entry))}
      </section>
      <section className="status-strip" aria-label="runtime-status">
        <span className="status-chip">
          <span className="status-chip-label">Provider</span>
          <span className="status-chip-value">{runtimeStatus.providerName ?? runtimeStatus.providerId ?? 'unselected'}</span>
        </span>
        <span className="status-chip">
          <span className="status-chip-label">Model</span>
          <span className="status-chip-value">{runtimeStatus.modelName ?? runtimeStatus.modelId ?? 'unselected'}</span>
        </span>
      </section>
      <form className="input-pane" aria-label="input-region" onSubmit={handleSubmit}>
        <label className="input-label" htmlFor="pueblo-input">pueblo&gt;</label>
        <input
          id="pueblo-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter command or task..."
          autoFocus
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

function renderTranscriptEntry(entry: TranscriptEntry) {
  if ('role' in entry) {
    return (
      <article key={entry.id} className="chat-entry chat-entry-user">
        <header className="chat-entry-label">You</header>
        <p className="chat-entry-body">{entry.content}</p>
      </article>
    );
  }

  if (entry.collapsed) {
    return (
      <details key={entry.id} className={`output-block output-block-${entry.type}`}>
        <summary>{entry.title}</summary>
        <pre>{entry.content}</pre>
      </details>
    );
  }

  const isAnswerBlock = entry.type === 'task-result' || entry.type === 'command-result' || entry.type === 'error';

  if (isAnswerBlock) {
    return (
      <article key={entry.id} className={`chat-entry chat-entry-answer chat-entry-answer-${entry.type}`}>
        <header className="chat-entry-label">Pueblo</header>
        <p className="chat-entry-body">{entry.content}</p>
      </article>
    );
  }

  return (
    <article key={entry.id} className={`output-block output-block-${entry.type}`}>
      <header className="output-block-title">{entry.title}</header>
      <pre className="output-block-content">{entry.content}</pre>
    </article>
  );
}