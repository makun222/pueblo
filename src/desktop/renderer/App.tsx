import React, { useEffect, useRef, useState } from 'react';
import type { AgentProfileTemplate, MemoryRecord, ProviderProfile, ProviderUsageStats, RendererFileChange, RendererMessageTraceStep, RendererOutputBlock, Session, SessionMessage } from '../../shared/schema';
import type {
  DesktopMenuAction,
  DesktopProviderStatus,
  DesktopRuntimeStatus,
  DesktopSessionSelectionResponse,
  DesktopSubmitResponse,
  DesktopToolApprovalBatch,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import './styles.css';

const THINKING_PLACEHOLDER = 'Thinking through the next step...';
const STREAM_CHUNK_SIZE = 24;
const STREAM_TICK_MS = 18;
const VISIBLE_TRANSCRIPT_GROUP_LIMIT = 10;
const EMPTY_TOOL_APPROVAL_STATE: DesktopToolApprovalState = {
  activeBatch: null,
};

interface WorkflowTodoItem {
  readonly id: string;
  readonly title: string;
}

interface UserTranscriptEntry {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly createdAt: string;
  readonly messageTrace: RendererMessageTraceStep[];
}

interface AssistantTranscriptEntry {
  readonly id: string;
  readonly role: 'assistant';
  readonly content: string;
  readonly createdAt: string;
  readonly messageTrace: RendererMessageTraceStep[];
  readonly fileChanges: RendererFileChange[];
  readonly status: 'pending' | 'streaming' | 'complete';
  readonly blockType: 'task-result' | 'command-result' | 'error';
}

type TranscriptEntry = UserTranscriptEntry | AssistantTranscriptEntry | RendererOutputBlock;
interface TranscriptGroup {
  readonly id: string;
  readonly entries: TranscriptEntry[];
  readonly createdAt: string;
  readonly searchText: string;
}

type ProviderConfigMode = 'github-copilot' | 'deepseek';
type SessionSortMode = 'updated-desc' | 'updated-asc';

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
  providerUsageStats: {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    promptTokensSent: 0,
    cacheHitRatio: null,
  },
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
      getToolApprovalState: () => Promise<DesktopToolApprovalState>;
      respondToolApproval: (response: { batchId: string; decision: 'allow' | 'deny'; selectedRequestIds: string[] }) => Promise<DesktopToolApprovalState>;
      listAgentProfiles: () => Promise<AgentProfileTemplate[]>;
      startAgentSession: (profileId: string) => Promise<DesktopRuntimeStatus>;
      listAgentSessions: (agentInstanceId: string) => Promise<Session[]>;
      listSessionMemories: (sessionId: string) => Promise<MemoryRecord[]>;
      selectSession: (sessionId: string) => Promise<DesktopSessionSelectionResponse>;
      onMenuAction: (callback: (action: DesktopMenuAction) => void) => (() => void);
      onToolApprovalState: (callback: (state: DesktopToolApprovalState) => void) => (() => void);
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
  const [isSessionSidebarOpen, setIsSessionSidebarOpen] = useState(false);
  const [isToolApprovalSidebarOpen, setIsToolApprovalSidebarOpen] = useState(true);
  const [isTodoSidebarOpen, setIsTodoSidebarOpen] = useState(true);
  const [providerConfigMode, setProviderConfigMode] = useState<ProviderConfigMode>('github-copilot');
  const [providerConfigError, setProviderConfigError] = useState<string | null>(null);
  const [providerConfigPending, setProviderConfigPending] = useState<string | null>(null);
  const [deepSeekApiKey, setDeepSeekApiKey] = useState('');
  const [deepSeekModelId, setDeepSeekModelId] = useState('deepseek-v4-flash');
  const [deepSeekBaseUrl, setDeepSeekBaseUrl] = useState('https://api.deepseek.com');
  const [isDeepSeekEditing, setIsDeepSeekEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentSessions, setAgentSessions] = useState<Session[]>([]);
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessionSortMode, setSessionSortMode] = useState<SessionSortMode>('updated-desc');
  const [isNewSessionComposerOpen, setIsNewSessionComposerOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [sessionPanelError, setSessionPanelError] = useState<string | null>(null);
  const [sessionInspectorSession, setSessionInspectorSession] = useState<Session | null>(null);
  const [sessionInspectorMemories, setSessionInspectorMemories] = useState<MemoryRecord[]>([]);
  const [activeSessionMemories, setActiveSessionMemories] = useState<MemoryRecord[]>([]);
  const [toolApprovalState, setToolApprovalState] = useState<DesktopToolApprovalState>(EMPTY_TOOL_APPROVAL_STATE);
  const [selectedToolApprovalIds, setSelectedToolApprovalIds] = useState<string[]>([]);
  const [hasEditedToolApprovalSelection, setHasEditedToolApprovalSelection] = useState(false);
  const [isResolvingToolApproval, setIsResolvingToolApproval] = useState(false);
  const [sessionInspectorError, setSessionInspectorError] = useState<string | null>(null);
  const [isSessionInspectorLoading, setIsSessionInspectorLoading] = useState(false);
  const [isSessionSelecting, setIsSessionSelecting] = useState(false);
  const [selectedFileChange, setSelectedFileChange] = useState<RendererFileChange | null>(null);
  const [transcriptSearchInput, setTranscriptSearchInput] = useState('');
  const [transcriptSearchTerm, setTranscriptSearchTerm] = useState('');
  const [isTranscriptHistoryExpanded, setIsTranscriptHistoryExpanded] = useState(false);
  const runtimeStatusRef = useRef(runtimeStatus);
  const selectedToolApprovalIdsRef = useRef<string[]>([]);
  const pendingAssistantEntryIdRef = useRef<string | null>(null);
  const pendingAssistantDraftRef = useRef('');
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRunIdRef = useRef(0);
  const outputPaneRef = useRef<HTMLElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const refreshActiveSessionMemories = async (sessionId: string | null) => {
    if (!sessionId) {
      setActiveSessionMemories([]);
      return;
    }

    try {
      const memories = await window.electronAPI.listSessionMemories(sessionId);
      setActiveSessionMemories(memories);
    } catch {
      setActiveSessionMemories([]);
    }
  };

  useEffect(() => {
    void window.electronAPI.getRuntimeStatus().then((status) => {
      setRuntimeStatus(status);
      void refreshAgentSessions(status, { hydrateCurrentSession: true });
      void refreshActiveSessionMemories(status.activeSessionId);
    }).catch(() => {
      setRuntimeStatus(EMPTY_RUNTIME_STATUS);
    });
    void window.electronAPI.getToolApprovalState().then(setToolApprovalState).catch(() => {
      setToolApprovalState(EMPTY_TOOL_APPROVAL_STATE);
    });
    void window.electronAPI.listAgentProfiles().then(setAgentProfiles).catch((error) => {
      setStartupError(error instanceof Error ? error.message : 'Failed to load agent profiles.');
    });
    const disposeToolApprovalListener = window.electronAPI.onToolApprovalState((state) => {
      setToolApprovalState(state);
    });

    window.electronAPI.onOutput((event, data) => {
      if (data.type === 'system' && data.title === 'Assistant Draft') {
        appendPendingAssistantDraft(data.content);
        return;
      }

      if (data.type === 'system' && data.title === 'Agent Activity') {
        updatePendingAssistantProgress(data.content);
        return;
      }

      if (!shouldDisplayRendererBlock(data)) {
        return;
      }

      if (isAnswerBlock(data) && pendingAssistantEntryIdRef.current) {
        streamAssistantResponse(data);
        return;
      }

      setTranscriptEntries((previous) => upsertRendererBlock(previous, data));
    });

    return () => {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      disposeToolApprovalListener();
      window.electronAPI.removeAllListeners('output');
    };
  }, []);

  useEffect(() => {
    const activeBatchId = toolApprovalState.activeBatch?.id ?? null;

    if (!activeBatchId) {
      setSelectedToolApprovalIds([]);
      selectedToolApprovalIdsRef.current = [];
      setHasEditedToolApprovalSelection(false);
      setIsResolvingToolApproval(false);
      return;
    }

    const nextSelectedIds = toolApprovalState.activeBatch?.requests.map((request) => request.id) ?? [];
    setSelectedToolApprovalIds(nextSelectedIds);
    selectedToolApprovalIdsRef.current = nextSelectedIds;
    setHasEditedToolApprovalSelection(false);
    setIsToolApprovalSidebarOpen(true);
    setIsResolvingToolApproval(false);
  }, [toolApprovalState.activeBatch?.id]);

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
  }, [runtimeStatus]);

  useEffect(() => {
    setTranscriptSearchInput('');
    setTranscriptSearchTerm('');
    setIsTranscriptHistoryExpanded(false);
  }, [runtimeStatus.activeSessionId]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' });
  }, [transcriptEntries]);

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
        fileChanges: [],
        sourceRefs: [],
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const hydrateSessionTranscript = (session: Session | null) => {
    if (!session) {
      setTranscriptEntries([]);
      return;
    }

    setTranscriptEntries(createTranscriptEntriesFromSession(session));
  };

  const refreshAgentSessions = async (
    nextRuntimeStatus: DesktopRuntimeStatus,
    options: { hydrateCurrentSession?: boolean } = {},
  ) => {
    const agentInstanceId = nextRuntimeStatus.agentInstanceId;

    if (!agentInstanceId) {
      setAgentSessions([]);
      setSelectedSidebarSessionId(null);
      setSessionPanelError(null);
      setActiveSessionMemories([]);
      if (options.hydrateCurrentSession) {
        hydrateSessionTranscript(null);
      }
      return;
    }

    try {
      const sessions = await window.electronAPI.listAgentSessions(agentInstanceId);
      setAgentSessions(sessions);
      setSessionPanelError(null);

      if (options.hydrateCurrentSession) {
        const activeSession = sessions.find((session) => session.id === nextRuntimeStatus.activeSessionId) ?? null;
        setSelectedSidebarSessionId(activeSession?.id ?? null);
        hydrateSessionTranscript(activeSession);
      } else if (!sessions.some((session) => session.id === selectedSidebarSessionId)) {
        setSelectedSidebarSessionId(nextRuntimeStatus.activeSessionId ?? sessions[0]?.id ?? null);
      }
    } catch (error) {
      setSessionPanelError(error instanceof Error ? error.message : 'Failed to load sessions.');
      setAgentSessions([]);
    }
  };

  const appendPendingAssistantEntry = (createdAt: string): string => {
    const assistantEntryId = `${createdAt}-assistant-${Math.random().toString(16).slice(2)}`;
    pendingAssistantEntryIdRef.current = assistantEntryId;
    pendingAssistantDraftRef.current = '';
    setTranscriptEntries((previous) => [
      ...previous,
      {
        id: assistantEntryId,
        role: 'assistant',
        content: THINKING_PLACEHOLDER,
        createdAt,
        messageTrace: [],
        fileChanges: [],
        status: 'pending',
        blockType: 'task-result',
      },
    ]);
    return assistantEntryId;
  };

  const appendPendingAssistantDraft = (delta: string) => {
    const assistantEntryId = pendingAssistantEntryIdRef.current;
    if (!assistantEntryId || !delta) {
      return;
    }

    pendingAssistantDraftRef.current += delta;

    setTranscriptEntries((previous) => previous.map((entry) => {
      if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
        return entry;
      }

      return {
        ...entry,
        content: pendingAssistantDraftRef.current,
        status: 'streaming',
      };
    }));
  };

  const updatePendingAssistantProgress = (message: string) => {
    const assistantEntryId = pendingAssistantEntryIdRef.current;
    if (!assistantEntryId) {
      return;
    }

    setTranscriptEntries((previous) => previous.map((entry) => {
      if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId || entry.status !== 'pending') {
        return entry;
      }

      return {
        ...entry,
        content: `${THINKING_PLACEHOLDER}\n\n${message}`,
      };
    }));
  };

  const streamAssistantResponse = (block: RendererOutputBlock) => {
    const assistantEntryId = pendingAssistantEntryIdRef.current;
    if (!assistantEntryId) {
      setTranscriptEntries((previous) => upsertRendererBlock(previous, block));
      return;
    }

    if (!isAnswerBlock(block)) {
      setTranscriptEntries((previous) => upsertRendererBlock(previous, block));
      return;
    }

    const answerBlockType = block.type;
    const initialCursor = pendingAssistantDraftRef.current && block.content.startsWith(pendingAssistantDraftRef.current)
      ? pendingAssistantDraftRef.current.length
      : 0;

    if (initialCursor === 0) {
      pendingAssistantDraftRef.current = '';
    }

    streamRunIdRef.current += 1;
    const currentRunId = streamRunIdRef.current;

    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }

    const streamFrame = (cursor: number) => {
      if (streamRunIdRef.current !== currentRunId) {
        return;
      }

      const nextCursor = Math.min(cursor + STREAM_CHUNK_SIZE, block.content.length);
      const nextContent = block.content.slice(0, nextCursor);
      pendingAssistantDraftRef.current = nextContent;

      setTranscriptEntries((previous) => previous.map((entry) => {
        if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
          return entry;
        }

        return {
          ...entry,
          content: nextContent,
          messageTrace: block.messageTrace,
          fileChanges: block.fileChanges,
          status: nextCursor >= block.content.length ? 'complete' : 'streaming',
          blockType: answerBlockType,
        };
      }));

      if (nextCursor >= block.content.length) {
        pendingAssistantEntryIdRef.current = null;
        pendingAssistantDraftRef.current = '';
        streamTimerRef.current = null;
        return;
      }

      streamTimerRef.current = setTimeout(() => {
        streamFrame(nextCursor);
      }, STREAM_TICK_MS);
    };

    if (initialCursor >= block.content.length) {
      setTranscriptEntries((previous) => previous.map((entry) => {
        if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
          return entry;
        }

        return {
          ...entry,
          content: block.content,
          messageTrace: block.messageTrace,
          fileChanges: block.fileChanges,
          status: 'complete',
          blockType: answerBlockType,
        };
      }));
      pendingAssistantEntryIdRef.current = null;
      pendingAssistantDraftRef.current = '';
      return;
    }

    streamFrame(initialCursor);
  };

  const executeInput = async (submittedInput: string, options: { recordUserEntry: boolean } = { recordUserEntry: true }) => {
    const trimmedInput = submittedInput.trim();

    if (!trimmedInput || !runtimeStatus.agentProfileId || !runtimeStatus.activeSessionId) {
      return null;
    }

    const createdAt = new Date().toISOString();
    const transcriptEntryId = `${createdAt}-${Math.random().toString(16).slice(2)}`;
    const shouldShowPendingAssistant = options.recordUserEntry && !trimmedInput.startsWith('/');
    let assistantEntryId: string | null = null;

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

        if (shouldShowPendingAssistant) {
          assistantEntryId = appendPendingAssistantEntry(createdAt);
        }
      }

      setIsSubmitting(true);
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

      if (assistantEntryId && !response.blocks.some((block) => isAnswerBlock(block))) {
        pendingAssistantEntryIdRef.current = null;
        pendingAssistantDraftRef.current = '';
        setTranscriptEntries((previous) => previous.filter((entry) => !('role' in entry) || entry.id !== assistantEntryId));
      }

      const shouldHydrateCurrentSession = response.runtimeStatus.activeSessionId !== runtimeStatusRef.current.activeSessionId;
      setRuntimeStatus(response.runtimeStatus);
      void refreshAgentSessions(response.runtimeStatus, { hydrateCurrentSession: shouldHydrateCurrentSession });
      void refreshActiveSessionMemories(response.runtimeStatus.activeSessionId);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (assistantEntryId) {
        pendingAssistantEntryIdRef.current = null;
        pendingAssistantDraftRef.current = '';
        setTranscriptEntries((previous) => previous.map((entry) => {
          if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
            return entry;
          }

          return {
            ...entry,
            content: message,
            status: 'complete',
            blockType: 'error',
          };
        }));
      }

      setTranscriptEntries((previous) => [
        ...previous,
        {
          id: `${createdAt}-${Math.random().toString(16).slice(2)}`,
          type: 'error',
          title: 'Submission Error',
          content: message,
          collapsed: false,
          messageTrace: [],
          fileChanges: [],
          sourceRefs: [],
          createdAt,
        },
      ]);

      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const submittedInput = input;
    const trimmedInput = submittedInput.trim();

    if (!trimmedInput || needsAgentSelection || isSubmitting) {
      return;
    }

    setInput('');
    await executeInput(submittedInput, { recordUserEntry: true });
  };

  const handleStartAgentSession = async (profileId: string) => {
    setStartingProfileId(profileId);
    setStartupError(null);

    try {
      const nextRuntimeStatus = await window.electronAPI.startAgentSession(profileId);
      setInput('');
      setRuntimeStatus(nextRuntimeStatus);
      await refreshAgentSessions(nextRuntimeStatus, { hydrateCurrentSession: true });
      await refreshActiveSessionMemories(nextRuntimeStatus.activeSessionId);
      setIsAgentPickerOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start agent session.';
      setStartupError(message);
      appendErrorBlock('Agent Switch Error', message);
    } finally {
      setStartingProfileId(null);
    }
  };

  const handleOpenSessionInspector = async (session: Session) => {
    setSessionInspectorSession(session);
    setSessionInspectorMemories([]);
    setSessionInspectorError(null);
    setIsSessionInspectorLoading(true);

    try {
      const memories = await window.electronAPI.listSessionMemories(session.id);
      setSessionInspectorMemories(memories);
    } catch (error) {
      setSessionInspectorError(error instanceof Error ? error.message : 'Failed to load session memories.');
    } finally {
      setIsSessionInspectorLoading(false);
    }
  };

  const handleCloseSessionInspector = () => {
    setSessionInspectorSession(null);
    setSessionInspectorMemories([]);
    setSessionInspectorError(null);
    setIsSessionInspectorLoading(false);
    setIsSessionSelecting(false);
  };

  const handleSelectInspectedSession = async () => {
    if (!sessionInspectorSession) {
      return;
    }

    setIsSessionSelecting(true);
    setSessionInspectorError(null);

    try {
      const response = await window.electronAPI.selectSession(sessionInspectorSession.id);
      setRuntimeStatus(response.runtimeStatus);
      setSelectedSidebarSessionId(response.session?.id ?? response.runtimeStatus.activeSessionId);
      hydrateSessionTranscript(response.session);
      await refreshAgentSessions(response.runtimeStatus);
      await refreshActiveSessionMemories(response.runtimeStatus.activeSessionId);
      handleCloseSessionInspector();
    } catch (error) {
      setSessionInspectorError(error instanceof Error ? error.message : 'Failed to switch session.');
    } finally {
      setIsSessionSelecting(false);
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

  const handleCreateSessionFromSidebar = async () => {
    if (isSubmitting || needsAgentSelection) {
      return;
    }

    const trimmedTitle = newSessionTitle.trim();
    if (!trimmedTitle) {
      return;
    }

    await executeInput(`/new ${trimmedTitle}`, { recordUserEntry: false });
    setNewSessionTitle('');
    setIsNewSessionComposerOpen(false);
  };

  const sortedAndFilteredSessions = sortSessions(
    filterSessions(agentSessions, sessionSearchQuery),
    sessionSortMode,
  );

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
  const activeToolApprovalBatch = toolApprovalState.activeBatch;
  const activeSession = agentSessions.find((session) => session.id === runtimeStatus.activeSessionId) ?? null;
  const todoMemory = selectSelectedTodoMemory(activeSessionMemories, activeSession?.selectedMemoryIds ?? []);
  const todoItems = parseTodoMemoryItems(todoMemory);
  const transcriptGroups = createTranscriptGroups(transcriptEntries);
  const filteredTranscriptGroups = transcriptSearchTerm.trim().length > 0
    ? transcriptGroups.filter((group) => doesTranscriptGroupMatch(group, transcriptSearchTerm))
    : transcriptGroups;
  const hiddenTranscriptGroups = transcriptSearchTerm.trim().length > 0
    ? []
    : filteredTranscriptGroups.slice(0, Math.max(0, filteredTranscriptGroups.length - VISIBLE_TRANSCRIPT_GROUP_LIMIT));
  const visibleTranscriptGroups = transcriptSearchTerm.trim().length > 0
    ? filteredTranscriptGroups
    : filteredTranscriptGroups.slice(-VISIBLE_TRANSCRIPT_GROUP_LIMIT);
  const displayedProviderUsageStats = selectDisplayedProviderUsageStats(
    runtimeStatus.providerUsageStats,
    activeSession?.providerUsageStats,
  );
  const promptTokens = displayedProviderUsageStats.promptTokens;
  const completionTokens = displayedProviderUsageStats.completionTokens;
  const totalTokens = displayedProviderUsageStats.totalTokens;
  const cacheHitRatio = displayedProviderUsageStats.cacheHitRatio;
  const workspaceColumns = [
    'minmax(0, 1fr)',
    ...(isSessionSidebarOpen ? ['minmax(280px, 24vw)'] : []),
    ...(isToolApprovalSidebarOpen ? ['minmax(260px, 21vw)'] : []),
    ...(isTodoSidebarOpen ? ['minmax(260px, 21vw)'] : []),
  ].join(' ');
  const effectiveSelectedToolApprovalIds = activeToolApprovalBatch && !hasEditedToolApprovalSelection
    ? activeToolApprovalBatch.requests.map((request) => request.id)
    : selectedToolApprovalIds;

  const handleToggleToolApprovalSelection = (requestId: string) => {
    const currentSelection = hasEditedToolApprovalSelection
      ? selectedToolApprovalIdsRef.current
      : activeToolApprovalBatch?.requests.map((request) => request.id) ?? selectedToolApprovalIdsRef.current;
    const nextSelection = currentSelection.includes(requestId)
      ? currentSelection.filter((id) => id !== requestId)
      : [...currentSelection, requestId];

    setHasEditedToolApprovalSelection(true);
    selectedToolApprovalIdsRef.current = nextSelection;
    setSelectedToolApprovalIds(nextSelection);
  };

  const handleResolveToolApproval = async (decision: 'allow' | 'deny') => {
    if (!activeToolApprovalBatch || isResolvingToolApproval) {
      return;
    }

    setIsResolvingToolApproval(true);

    try {
      const nextState = await window.electronAPI.respondToolApproval({
        batchId: activeToolApprovalBatch.id,
        decision,
        selectedRequestIds: selectedToolApprovalIdsRef.current,
      });
      setToolApprovalState(nextState);
    } finally {
      setIsResolvingToolApproval(false);
    }
  };

  const handleTranscriptSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setTranscriptSearchTerm(transcriptSearchInput.trim());
    setIsTranscriptHistoryExpanded(false);
  };

  const handleClearTranscriptSearch = () => {
    setTranscriptSearchInput('');
    setTranscriptSearchTerm('');
  };

  return (
    <div className="app">
      <header className="app-toolbar" aria-label="window-toolbar">
        <div className="app-toolbar-copy">
          <span className="app-toolbar-title">Pueblo</span>
          <span className="app-toolbar-subtitle">{runtimeStatus.agentProfileName ?? 'No agent selected'}</span>
        </div>
        <div className="app-toolbar-actions">
          <button
            type="button"
            className="app-toolbar-icon"
            aria-label={isSessionSidebarOpen ? 'Hide session sidebar' : 'Show session sidebar'}
            onClick={() => {
              setIsSessionSidebarOpen((current) => !current);
            }}
          >
            <svg className="app-toolbar-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6.75C4 5.78 4.78 5 5.75 5h12.5C19.22 5 20 5.78 20 6.75v2.5C20 10.22 19.22 11 18.25 11H5.75C4.78 11 4 10.22 4 9.25v-2.5Zm0 8C4 13.78 4.78 13 5.75 13h12.5c.97 0 1.75.78 1.75 1.75v2.5c0 .97-.78 1.75-1.75 1.75H5.75C4.78 19 4 18.22 4 17.25v-2.5Zm2 1.25v1.5h4V16h-4Zm0-8v1.5h7V8H6Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="app-toolbar-icon"
            aria-label={isToolApprovalSidebarOpen ? 'Hide tool approval sidebar' : 'Show tool approval sidebar'}
            onClick={() => {
              setIsToolApprovalSidebarOpen((current) => !current);
            }}
          >
            <svg className="app-toolbar-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 5.75A1.75 1.75 0 0 1 7.75 4h8.5A1.75 1.75 0 0 1 18 5.75v1.5A1.75 1.75 0 0 1 16.25 9h-8.5A1.75 1.75 0 0 1 6 7.25v-1.5Zm-2 7A1.75 1.75 0 0 1 5.75 11h12.5A1.75 1.75 0 0 1 20 12.75v5.5A1.75 1.75 0 0 1 18.25 20H5.75A1.75 1.75 0 0 1 4 18.25v-5.5Zm3 1.75v2.5h3v-2.5H7Zm5 0v2.5h5v-2.5h-5Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="app-toolbar-icon"
            aria-label={isTodoSidebarOpen ? 'Hide todo sidebar' : 'Show todo sidebar'}
            onClick={() => {
              setIsTodoSidebarOpen((current) => !current);
            }}
          >
            <svg className="app-toolbar-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.75 5A1.75 1.75 0 0 0 5 6.75v10.5C5 18.22 5.78 19 6.75 19h10.5c.97 0 1.75-.78 1.75-1.75V6.75C19 5.78 18.22 5 17.25 5H6.75Zm1.5 3.25h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5Zm0 3.5h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5Zm0 3.5h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5Z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>
      <div className="workspace-shell" style={{ ['--workspace-columns' as string]: workspaceColumns }}>
        <section ref={outputPaneRef} className="output-pane" aria-label="output-region">
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
          }) : (
            <>
              <div className="output-pane-toolbar">
                {renderTranscriptToolbar({
                  transcriptSearchInput,
                  transcriptSearchTerm,
                  onSearchInputChange: setTranscriptSearchInput,
                  onSubmit: handleTranscriptSearchSubmit,
                  onClear: handleClearTranscriptSearch,
                })}
              </div>
              <div className="output-pane-transcript">
                {transcriptEntries.length === 0 ? (
                  <div className="output-empty">No output yet.</div>
                ) : filteredTranscriptGroups.length === 0 ? (
                  <div className="output-empty">No chat records matched the current search.</div>
                ) : (
                  <>
                    {hiddenTranscriptGroups.length > 0 ? renderCollapsedTranscriptHistory({
                      groups: hiddenTranscriptGroups,
                      isOpen: isTranscriptHistoryExpanded,
                      onToggle: setIsTranscriptHistoryExpanded,
                      onOpenFileChange: setSelectedFileChange,
                    }) : null}
                    {visibleTranscriptGroups.map((group) => renderTranscriptGroup(group, { onOpenFileChange: setSelectedFileChange }))}
                  </>
                )}
                <div ref={transcriptEndRef} className="output-pane-end" aria-hidden="true" />
              </div>
            </>
          )}
        </section>
        {isSessionSidebarOpen ? (
          <aside className="workspace-sidebar workspace-sidebar-session" aria-label="workspace-session-sidebar">
            {renderSessionSidebar({
              sessions: sortedAndFilteredSessions,
              activeSessionId: runtimeStatus.activeSessionId,
              selectedSessionId: selectedSidebarSessionId,
              agentProfileName: runtimeStatus.agentProfileName,
              error: sessionPanelError,
              disabled: needsAgentSelection,
              isCreatingSession: isSubmitting,
              sessionSearchQuery,
              sessionSortMode,
              isNewSessionComposerOpen,
              newSessionTitle,
              onCreateSession: () => {
                void handleCreateSessionFromSidebar();
              },
              onOpenNewSessionComposer: () => {
                setIsNewSessionComposerOpen(true);
              },
              onCancelNewSessionComposer: () => {
                setIsNewSessionComposerOpen(false);
                setNewSessionTitle('');
              },
              onNewSessionTitleChange: setNewSessionTitle,
              onSessionSearchQueryChange: setSessionSearchQuery,
              onSessionSortModeChange: setSessionSortMode,
              onSelectSession: (session) => {
                setSelectedSidebarSessionId(session.id);
              },
              onInspectSession: (session) => {
                void handleOpenSessionInspector(session);
              },
            })}
          </aside>
        ) : null}
        {isToolApprovalSidebarOpen ? (
          <aside className="workspace-sidebar workspace-sidebar-approval" aria-label="workspace-tool-approval-sidebar">
            {renderToolApprovalSidebar({
              toolApprovalBatch: activeToolApprovalBatch,
              selectedRequestIds: effectiveSelectedToolApprovalIds,
              isResolvingToolApproval,
              onToggleRequest: handleToggleToolApprovalSelection,
              onAllow: () => {
                void handleResolveToolApproval('allow');
              },
              onDeny: () => {
                void handleResolveToolApproval('deny');
              },
            })}
          </aside>
        ) : null}
        {isTodoSidebarOpen ? (
          <aside className="workspace-sidebar workspace-sidebar-todo" aria-label="workspace-todo-sidebar">
            {renderTodoSidebar({
              todoMemory,
              todoItems,
            })}
          </aside>
        ) : null}
      </div>
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
        <div className="status-strip-spacer" />
        <div className="status-strip-metrics">
          <span className="status-chip">
            <span className="status-chip-label">Message Length</span>
            <span className="status-chip-value">{runtimeStatus.modelMessageCharCount} chars</span>
          </span>
          <span className="status-chip">
            <span className="status-chip-label">Prompt Tokens</span>
            <span className="status-chip-value">{formatCompactInteger(promptTokens)} tokens</span>
          </span>
          <span className="status-chip">
            <span className="status-chip-label">Completion Tokens</span>
            <span className="status-chip-value">{formatCompactInteger(completionTokens)} tokens</span>
          </span>
          <span className="status-chip">
            <span className="status-chip-label">Total Tokens</span>
            <span className="status-chip-value">{formatCompactInteger(totalTokens)} tokens</span>
          </span>
          <span className="status-chip">
            <span className="status-chip-label">Cache Hit</span>
            <span className="status-chip-value">{formatCacheHitRatio(cacheHitRatio)}</span>
          </span>
        </div>
      </section>
      <form className="input-pane" aria-label="input-region" onSubmit={handleSubmit}>
        <label className="input-label" htmlFor="pueblo-input">pueblo&gt;</label>
        <input
          id="pueblo-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={needsAgentSelection ? 'Select an agent profile to begin...' : 'Enter command or task...'}
          disabled={needsAgentSelection || isSubmitting}
          autoFocus
        />
        <button type="submit" disabled={needsAgentSelection || isSubmitting}>Send</button>
      </form>
      {sessionInspectorSession ? renderSessionInspectorModal({
        session: sessionInspectorSession,
        memories: sessionInspectorMemories,
        activeSessionId: runtimeStatus.activeSessionId,
        error: sessionInspectorError,
        isLoading: isSessionInspectorLoading,
        isSelecting: isSessionSelecting,
        onClose: handleCloseSessionInspector,
        onSelect: () => {
          void handleSelectInspectedSession();
        },
      }) : null}
      {selectedFileChange ? renderFileChangePreviewModal({
        fileChange: selectedFileChange,
        onClose: () => {
          setSelectedFileChange(null);
        },
      }) : null}
    </div>
  );
}

function formatCompactInteger(value: number): string {
  if (value >= 1_000_000) {
    return formatCompactUnit(value / 1_000_000, 'M');
  }

  if (value >= 1_000) {
    return formatCompactUnit(value / 1_000, 'K');
  }

  return new Intl.NumberFormat('en-US').format(value);
}

function formatCompactUnit(value: number, suffix: 'K' | 'M'): string {
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded.replace(/\.0$/, '')}${suffix}`;
}

function selectDisplayedProviderUsageStats(
  runtimeUsage: ProviderUsageStats | undefined,
  sessionUsage: ProviderUsageStats | undefined,
): ProviderUsageStats {
  if (hasMeaningfulProviderUsage(runtimeUsage)) {
    return runtimeUsage;
  }

  if (hasMeaningfulProviderUsage(sessionUsage)) {
    return sessionUsage;
  }

  return runtimeUsage ?? sessionUsage ?? EMPTY_RUNTIME_STATUS.providerUsageStats!;
}

function hasMeaningfulProviderUsage(stats: ProviderUsageStats | undefined): stats is ProviderUsageStats {
  if (!stats) {
    return false;
  }

  return stats.promptTokens > 0
    || stats.completionTokens > 0
    || stats.totalTokens > 0
    || stats.promptCacheHitTokens > 0
    || stats.promptCacheMissTokens > 0
    || stats.cachedPromptTokens > 0
    || stats.reasoningTokens > 0
    || stats.promptTokensSent > 0
    || stats.cacheHitRatio !== null;
}

function formatCacheHitRatio(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  const percentage = Number((value * 100).toFixed(1));
  return `${percentage}%`;
}

function renderTranscriptToolbar(args: {
  transcriptSearchInput: string;
  transcriptSearchTerm: string;
  onSearchInputChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClear: () => void;
}) {
  const canClear = args.transcriptSearchInput.trim().length > 0 || args.transcriptSearchTerm.trim().length > 0;

  return (
    <form className="transcript-toolbar" aria-label="transcript-search" onSubmit={args.onSubmit}>
      <div className="transcript-search-field">
        <input
          type="search"
          aria-label="Search transcript"
          value={args.transcriptSearchInput}
          onChange={(event) => args.onSearchInputChange(event.target.value)}
          placeholder="Search chat records and press Enter"
        />
      </div>
      <div className="transcript-toolbar-actions">
        <button type="submit" className="transcript-search-button">Find</button>
        <button type="button" className="transcript-search-clear" onClick={args.onClear} disabled={!canClear}>Clear</button>
      </div>
    </form>
  );
}

function renderCollapsedTranscriptHistory(args: {
  groups: TranscriptGroup[];
  isOpen: boolean;
  onToggle: (isOpen: boolean) => void;
  onOpenFileChange: (fileChange: RendererFileChange) => void;
}) {
  const firstGroup = args.groups[0];
  const lastGroup = args.groups[args.groups.length - 1];

  return (
    <details
      className="transcript-history"
      open={args.isOpen}
      onToggle={(event) => {
        args.onToggle(event.currentTarget.open);
      }}
    >
      <summary className="transcript-history-summary">
        <span className="transcript-history-title">Earlier interactions</span>
        <span className="transcript-history-count">{args.groups.length}</span>
        <span className="transcript-history-range">
          {formatTimestamp(firstGroup.createdAt)} to {formatTimestamp(lastGroup.createdAt)}
        </span>
      </summary>
      {args.isOpen ? (
        <div className="transcript-history-content">
          {args.groups.map((group) => renderTranscriptGroup(group, { onOpenFileChange: args.onOpenFileChange }))}
        </div>
      ) : null}
    </details>
  );
}

function renderTranscriptGroup(
  group: TranscriptGroup,
  actions: { readonly onOpenFileChange: (fileChange: RendererFileChange) => void },
) {
  return (
    <div key={group.id} className="transcript-group">
      {group.entries.map((entry) => renderTranscriptEntry(entry, actions))}
    </div>
  );
}

function renderToolApprovalSidebar(args: {
  toolApprovalBatch: DesktopToolApprovalBatch | null;
  selectedRequestIds: string[];
  isResolvingToolApproval: boolean;
  onToggleRequest: (requestId: string) => void;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <section className="workflow-sidebar-panel">
      <header className="workflow-sidebar-header">
        <div className="workflow-sidebar-header-main">
          <p className="workflow-sidebar-eyebrow">Tool Approval</p>
        
        </div>
      </header>
      <section className="workflow-sidebar-section workflow-sidebar-section-top">
        <div className="workflow-sidebar-section-header">
          <div>
            <p className="workflow-sidebar-eyebrow">Batch</p>
            <h3>Queued Calls</h3>
          </div>
          {args.toolApprovalBatch ? <span className="workflow-sidebar-badge">{args.toolApprovalBatch.requests.length}</span> : null}
        </div>
        {args.toolApprovalBatch ? (
          <>
            <p className="workflow-sidebar-copy">Predictable tool calls are grouped here. Use the X button on each row to keep or remove it from the current approval set.</p>
            <div className="tool-approval-list" role="list" aria-label="tool-approval-list">
              {args.toolApprovalBatch.requests.map((request) => {
                const isSelected = args.selectedRequestIds.includes(request.id);
                return (
                  <article
                    key={request.id}
                    className={`tool-approval-row ${isSelected ? 'tool-approval-row-selected' : 'tool-approval-row-muted'}`}
                    title={request.detail}
                  >
                    <div className="tool-approval-row-main">
                      <div className="tool-approval-row-line">
                        <span className="tool-approval-target">{request.targetLabel}</span>
                        <span className="tool-approval-operation">{request.operationLabel}</span>
                      </div>
                      <p className="tool-approval-summary">{request.summary}</p>
                    </div>
                    <button
                      type="button"
                      className={`tool-approval-toggle ${isSelected ? 'tool-approval-toggle-selected' : ''}`}
                      aria-pressed={isSelected}
                      aria-label={isSelected ? `Deselect ${request.targetLabel}` : `Select ${request.targetLabel}`}
                      onClick={() => args.onToggleRequest(request.id)}
                      disabled={args.isResolvingToolApproval}
                    >
                      X
                    </button>
                  </article>
                );
              })}
            </div>
            <div className="tool-approval-actions">
              <button
                type="button"
                className="provider-config-primary"
                onClick={args.onAllow}
                disabled={args.isResolvingToolApproval}
              >
                {args.isResolvingToolApproval ? 'Applying...' : 'Allow'}
              </button>
              <button
                type="button"
                className="provider-config-secondary"
                onClick={args.onDeny}
                disabled={args.isResolvingToolApproval}
              >
                Deny
              </button>
            </div>
          </>
        ) : (
          <p className="session-panel-empty">No pending tool approvals.</p>
        )}
      </section>
    </section>
  );
}

function renderTodoSidebar(args: {
  todoMemory: MemoryRecord | null;
  todoItems: WorkflowTodoItem[];
}) {
  return (
    <section className="workflow-sidebar-panel">
      <header className="workflow-sidebar-header">
        <div className="workflow-sidebar-header-main">
          <p className="workflow-sidebar-eyebrow">Todo</p>
        </div>
      </header>
      <section className="workflow-sidebar-section workflow-sidebar-section-bottom">
        <div className="workflow-sidebar-section-header">
          <div>
            <p className="workflow-sidebar-eyebrow">Active Round</p>
            <h3>Current Tasks</h3>
          </div>
          {args.todoItems.length > 0 ? <span className="workflow-sidebar-badge">{args.todoItems.length}</span> : null}
        </div>
        {args.todoMemory ? (
          <>
            <p className="workflow-sidebar-copy">{args.todoMemory.title}</p>
            <p className="workflow-sidebar-meta">Updated {formatTimestamp(args.todoMemory.updatedAt)}</p>
            {args.todoItems.length > 0 ? (
              <div className="todo-list" role="list" aria-label="todo-list">
                {args.todoItems.map((item) => (
                  <article key={`${item.id}-${item.title}`} className="todo-item">
                    <span className="todo-item-id">{item.id}</span>
                    <p className="todo-item-title">{item.title}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="session-panel-empty">Todo memory exists, but no task rows were parsed.</p>
            )}
          </>
        ) : (
          <p className="session-panel-empty">No todo list is available for the current session.</p>
        )}
      </section>
    </section>
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

function renderSessionSidebar(args: {
  sessions: Session[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  agentProfileName: string | null;
  error: string | null;
  disabled: boolean;
  isCreatingSession: boolean;
  sessionSearchQuery: string;
  sessionSortMode: SessionSortMode;
  isNewSessionComposerOpen: boolean;
  newSessionTitle: string;
  onCreateSession: () => void;
  onOpenNewSessionComposer: () => void;
  onCancelNewSessionComposer: () => void;
  onNewSessionTitleChange: (value: string) => void;
  onSessionSearchQueryChange: (value: string) => void;
  onSessionSortModeChange: (value: SessionSortMode) => void;
  onSelectSession: (session: Session) => void;
  onInspectSession: (session: Session) => void;
}) {
  return (
    <section className="session-panel">
      <header className="session-panel-header">
        <div className="session-panel-header-main">
          <p className="session-panel-eyebrow">Session Sidebar</p>
          <p className="session-panel-copy">{args.agentProfileName ?? 'No agent selected'}</p>
        </div>
        <div className="session-panel-header-actions">
          {!args.isNewSessionComposerOpen ? (
            <button
              type="button"
              className="session-panel-new"
              onClick={args.onOpenNewSessionComposer}
              disabled={args.disabled || args.isCreatingSession}
            >
              New
            </button>
          ) : null}
        </div>
      </header>
      <div className="session-panel-controls">
        <label className="session-panel-search">
          <input
            aria-label="Search sessions"
            type="text"
            value={args.sessionSearchQuery}
            onChange={(event) => args.onSessionSearchQueryChange(event.target.value)}
            placeholder="Search session titles or content"
            disabled={args.disabled}
          />
        </label>
        <label className="session-panel-sort">
          <select
            aria-label="Sort sessions"
            value={args.sessionSortMode}
            onChange={(event) => args.onSessionSortModeChange(event.target.value as SessionSortMode)}
            disabled={args.disabled}
          >
            <option value="updated-desc">Most recent</option>
            <option value="updated-asc">Oldest first</option>
          </select>
        </label>
      </div>
      <div className="session-panel-actions">
        {args.isNewSessionComposerOpen ? (
          <div className="session-panel-new-composer">
            <input
              type="text"
              value={args.newSessionTitle}
              onChange={(event) => args.onNewSessionTitleChange(event.target.value)}
              placeholder="Enter a session title"
              disabled={args.disabled || args.isCreatingSession}
            />
            <div className="session-panel-new-composer-actions">
              <button
                type="button"
                className="session-panel-new"
                onClick={args.onCreateSession}
                disabled={args.disabled || args.isCreatingSession || !args.newSessionTitle.trim()}
              >
                {args.isCreatingSession ? 'Creating...' : 'Create'}
              </button>
              <button
                type="button"
                className="session-panel-new-secondary"
                onClick={args.onCancelNewSessionComposer}
                disabled={args.isCreatingSession}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {args.error ? <p className="session-panel-error">{args.error}</p> : null}
      {args.disabled ? (
        <p className="session-panel-empty">Select an agent and provider setup first.</p>
      ) : args.sessions.length === 0 ? (
        <p className="session-panel-empty">No sessions matched the current filter.</p>
      ) : (
        <div className="session-list">
          {args.sessions.map((session) => (
            <article
              key={session.id}
              className={`session-card ${session.id === args.activeSessionId ? 'session-card-active' : ''} ${session.id === args.selectedSessionId ? 'session-card-selected' : ''}`}
              aria-selected={session.id === args.selectedSessionId}
              onClick={() => args.onSelectSession(session)}
              onDoubleClick={() => args.onInspectSession(session)}
            >
              <span className="session-card-accent" aria-hidden="true" />
              <header className="session-card-header">
                <h3>{session.title}</h3>
                {session.id === args.activeSessionId ? <span className="session-card-badge">Current</span> : null}
              </header>
              <p className="session-card-meta">{formatSessionState(session.status)} · {formatTimestamp(session.updatedAt)}</p>
              <p className="session-card-meta">{session.messageHistory.length} messages · {session.selectedMemoryIds.length} selected memories</p>
              <p className="session-card-preview">{getSessionPreview(session)}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function renderSessionInspectorModal(args: {
  session: Session;
  memories: MemoryRecord[];
  activeSessionId: string | null;
  error: string | null;
  isLoading: boolean;
  isSelecting: boolean;
  onClose: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="session-modal-overlay" role="dialog" aria-modal="true" aria-label="session-memory-dialog">
      <section className="session-modal">
        <header className="session-modal-header">
          <div>
            <p className="session-panel-eyebrow">Session Memories</p>
            <h2>{args.session.title}</h2>
            <p className="session-panel-copy">{formatSessionState(args.session.status)} · {args.session.messageHistory.length} messages · Updated {formatTimestamp(args.session.updatedAt)}</p>
          </div>
        </header>
        {args.error ? <p className="session-panel-error">{args.error}</p> : null}
        <div className="session-memory-strip">
          {args.isLoading ? (
            <p className="session-panel-empty">Loading session memories...</p>
          ) : args.memories.length === 0 ? (
            <p className="session-panel-empty">No memory records found for this session.</p>
          ) : (
            <div className="session-memory-grid">
              {args.memories.map((memory) => (
                <article key={memory.id} className="session-memory-card">
                  <header className="session-memory-card-header">
                    <h3>{memory.title}</h3>
                    <span>{memory.derivationType}</span>
                  </header>
                  <p className="session-memory-meta">{memory.scope} · depth {memory.summaryDepth} · {formatTimestamp(memory.updatedAt)}</p>
                  <p className="session-memory-content">{memory.content}</p>
                  <div className="session-memory-tags">
                    {memory.tags.map((tag) => (
                      <span key={`${memory.id}-${tag}`}>{tag}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        <footer className="session-modal-actions">
          <button
            type="button"
            className="provider-config-primary"
            onClick={args.onSelect}
            disabled={args.isSelecting || args.session.id === args.activeSessionId}
          >
            {args.session.id === args.activeSessionId ? '当前会话' : args.isSelecting ? '选择中...' : '选择'}
          </button>
          <button type="button" className="provider-config-secondary" onClick={args.onClose}>
            取消
          </button>
        </footer>
      </section>
    </div>
  );
}

function renderTranscriptEntry(
  entry: TranscriptEntry,
  actions: { readonly onOpenFileChange: (fileChange: RendererFileChange) => void },
) {
  if ('role' in entry) {
    if (entry.role === 'assistant') {
      const handoff = parseTaskHandoff(entry.content);
      return (
        <article key={entry.id} className={`chat-entry chat-entry-answer chat-entry-answer-${entry.blockType} ${entry.status === 'pending' ? 'chat-entry-answer-pending' : ''}`}>
          <header className="chat-entry-label">Pueblo</header>
          {renderAnswerContent(entry.content, handoff)}
          {renderFileChangeSummary(entry.fileChanges, actions.onOpenFileChange)}
          {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace)}
        </article>
      );
    }

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
    const handoff = parseTaskHandoff(entry.content);
    return (
      <article key={entry.id} className={`chat-entry chat-entry-answer chat-entry-answer-${entry.type}`}>
        <header className="chat-entry-label">Pueblo</header>
        {renderAnswerContent(entry.content, handoff)}
        {renderFileChangeSummary(entry.fileChanges, actions.onOpenFileChange)}
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

function createTranscriptEntriesFromSession(session: Session): TranscriptEntry[] {
  return session.messageHistory
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => mapSessionMessageToTranscriptEntry(message));
}

function createTranscriptGroups(entries: TranscriptEntry[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let currentGroup: TranscriptEntry[] = [];

  const pushCurrentGroup = () => {
    if (currentGroup.length === 0) {
      return;
    }

    const [firstEntry] = currentGroup;
    groups.push({
      id: `transcript-group-${firstEntry.id}`,
      entries: currentGroup,
      createdAt: firstEntry.createdAt,
      searchText: currentGroup.map((entry) => getTranscriptEntrySearchText(entry)).join('\n').toLowerCase(),
    });
    currentGroup = [];
  };

  for (const entry of entries) {
    if ('role' in entry && entry.role === 'user') {
      pushCurrentGroup();
      currentGroup = [entry];
      continue;
    }

    if (currentGroup.length === 0) {
      currentGroup = [entry];
      pushCurrentGroup();
      continue;
    }

    currentGroup = [...currentGroup, entry];
  }

  pushCurrentGroup();
  return groups;
}

function getTranscriptEntrySearchText(entry: TranscriptEntry): string {
  if ('role' in entry) {
    return `${entry.role} ${entry.content}`;
  }

  return `${entry.title} ${entry.content}`;
}

function doesTranscriptGroupMatch(group: TranscriptGroup, query: string): boolean {
  return group.searchText.includes(query.trim().toLowerCase());
}

function mapSessionMessageToTranscriptEntry(message: SessionMessage): TranscriptEntry {
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'user',
      content: message.content,
      createdAt: message.createdAt,
      messageTrace: [],
    };
  }

  if (message.role === 'assistant') {
    return {
      id: message.id,
      role: 'assistant',
      content: message.content,
      createdAt: message.createdAt,
      messageTrace: [],
      fileChanges: [],
      status: 'complete',
      blockType: 'task-result',
    };
  }

  return {
    id: message.id,
    type: message.role === 'tool' ? 'tool-result' : 'system',
    title: message.role === 'tool' ? `Tool: ${message.toolName ?? 'unknown'}` : 'System Message',
    content: message.content,
    collapsed: false,
    messageTrace: [],
    fileChanges: [],
    sourceRefs: [],
    createdAt: message.createdAt,
  };
}

function selectSelectedTodoMemory(memories: MemoryRecord[], selectedMemoryIds: string[]): MemoryRecord | null {
  if (selectedMemoryIds.length === 0) {
    return null;
  }

  const selectedMemoryIdSet = new Set(selectedMemoryIds);

  return memories
    .filter((memory) => selectedMemoryIdSet.has(memory.id) && memory.tags.includes('todo'))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function parseTodoMemoryItems(memory: MemoryRecord | null): WorkflowTodoItem[] {
  if (!memory) {
    return [];
  }

  return memory.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^-\s*/, ''))
    .map((line) => {
      const separatorIndex = line.indexOf(':');

      if (separatorIndex === -1) {
        return {
          id: 'todo',
          title: line,
        };
      }

      return {
        id: line.slice(0, separatorIndex).trim(),
        title: line.slice(separatorIndex + 1).trim(),
      };
    })
    .filter((item) => item.title.length > 0);
}

function formatSessionState(status: Session['status']): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'archived':
      return 'Archived';
    case 'deleted':
      return 'Deleted';
    default:
      return status;
  }
}

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function getSessionPreview(session: Session): string {
  const lastMessage = [...session.messageHistory]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (!lastMessage) {
    return 'No messages yet.';
  }

  const prefix = lastMessage.role === 'assistant'
    ? 'Pueblo'
    : lastMessage.role === 'user'
      ? 'You'
      : lastMessage.role;

  return `${prefix}: ${lastMessage.content}`;
}

function filterSessions(sessions: Session[], query: string): Session[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return sessions;
  }

  return sessions.filter((session) => {
    const haystacks = [
      session.title,
      ...session.messageHistory.map((message) => message.content),
    ];

    return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

function sortSessions(sessions: Session[], mode: SessionSortMode): Session[] {
  const nextSessions = [...sessions];
  nextSessions.sort((left, right) => {
    const comparison = left.updatedAt.localeCompare(right.updatedAt) || left.createdAt.localeCompare(right.createdAt);
    return mode === 'updated-desc' ? -comparison : comparison;
  });
  return nextSessions;
}

function isAnswerBlock(entry: RendererOutputBlock): entry is RendererOutputBlock & { type: 'task-result' | 'command-result' | 'error' } {
  return entry.type === 'task-result' || entry.type === 'command-result' || entry.type === 'error';
}

function upsertRendererBlock(previous: TranscriptEntry[], nextBlock: RendererOutputBlock): TranscriptEntry[] {
  if (!shouldDisplayRendererBlock(nextBlock)) {
    return previous;
  }

  const existingIndex = previous.findIndex((entry) => !('role' in entry) && entry.id === nextBlock.id);

  if (existingIndex === -1) {
    return [...previous, nextBlock];
  }

  const nextEntries = [...previous];
  nextEntries[existingIndex] = nextBlock;
  return nextEntries;
}

function shouldDisplayRendererBlock(block: RendererOutputBlock): boolean {
  if (block.type === 'system' && (block.title === 'Agent Activity' || block.title === 'Assistant Draft')) {
    return false;
  }

  return block.type === 'task-result'
    || block.type === 'command-result'
    || block.type === 'error'
    || (block.type === 'system' && !block.collapsed);
}

function renderFileChangeSummary(
  fileChanges: RendererFileChange[] | null | undefined,
  onOpenFileChange: (fileChange: RendererFileChange) => void,
) {
  if (!fileChanges || fileChanges.length === 0) {
    return null;
  }

  return (
    <details className="chat-entry-file-changes">
      <summary className="chat-entry-file-changes-summary">
        <span>Changed Files</span>
        <span className="chat-entry-file-changes-count">{fileChanges.length}</span>
      </summary>
      <ul className="chat-entry-file-changes-list">
        {fileChanges.map((fileChange) => (
          <li key={`${fileChange.absolutePath}-${fileChange.changeType}`} className="chat-entry-file-changes-item">
            <button
              type="button"
              className="chat-entry-file-link"
              onClick={() => {
                onOpenFileChange(fileChange);
              }}
            >
              {fileChange.path}
            </button>
            <span className={`chat-entry-file-change-badge chat-entry-file-change-badge-${fileChange.changeType}`}>
              {formatFileChangeType(fileChange.changeType)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function renderAnswerContent(content: string, handoff: TaskHandoffSummary | null) {
  if (!handoff) {
    return <p className="chat-entry-body">{content}</p>;
  }

  return (
    <>
      {handoff.leadingContent ? <p className="chat-entry-body">{handoff.leadingContent}</p> : null}
      <details className="task-handoff-card">
        <summary className="task-handoff-card-summary">
          <span className="task-handoff-card-title">Continue This Task</span>
          <span className="task-handoff-card-metrics">
            <span className="task-handoff-card-metric">已完成 {handoff.completedItems.length} 项</span>
            <span className="task-handoff-card-metric">剩余 {handoff.remainingItems.length} 项</span>
          </span>
          <span className="task-handoff-card-next">建议继续：{handoff.nextRequestSummary}</span>
        </summary>
        <div className="task-handoff-card-content">
          {renderTaskHandoffSection('本轮已完成', handoff.completedItems)}
          {renderTaskHandoffSection('剩余工作', handoff.remainingItems)}
          {renderTaskHandoffSection('建议下一轮', handoff.nextRequestItems)}
        </div>
      </details>
    </>
  );
}

function renderTaskHandoffSection(title: string, items: string[]) {
  return (
    <section className="task-handoff-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

interface TaskHandoffSummary {
  readonly leadingContent: string | null;
  readonly completedItems: string[];
  readonly remainingItems: string[];
  readonly nextRequestItems: string[];
  readonly nextRequestSummary: string;
}

function parseTaskHandoff(content: string): TaskHandoffSummary | null {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const completedHeadingIndex = normalizedContent.indexOf('Completed this round');
  const remainingHeadingIndex = normalizedContent.indexOf('\nRemaining work');
  const nextHeadingIndex = normalizedContent.indexOf('\nRecommended next request');

  if (completedHeadingIndex === -1 || remainingHeadingIndex === -1 || nextHeadingIndex === -1) {
    return null;
  }

  const leadingContent = normalizedContent.slice(0, completedHeadingIndex).trim() || null;
  const completedBody = normalizedContent
    .slice(completedHeadingIndex + 'Completed this round'.length, remainingHeadingIndex)
    .trim();
  const remainingBody = normalizedContent
    .slice(remainingHeadingIndex + '\nRemaining work'.length, nextHeadingIndex)
    .trim();
  const nextBody = normalizedContent
    .slice(nextHeadingIndex + '\nRecommended next request'.length)
    .trim();

  const completedItems = parseTaskHandoffItems(completedBody);
  const remainingItems = parseTaskHandoffItems(remainingBody);
  const nextRequestItems = parseTaskHandoffItems(nextBody);

  if (completedItems.length === 0 || remainingItems.length === 0 || nextRequestItems.length === 0) {
    return null;
  }

  return {
    leadingContent,
    completedItems,
    remainingItems,
    nextRequestItems,
    nextRequestSummary: nextRequestItems[0] ?? '',
  };
}

function parseTaskHandoffItems(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function renderFileChangePreviewModal(args: {
  readonly fileChange: RendererFileChange;
  readonly onClose: () => void;
}) {
  const diffLines = buildFileChangePreviewLines(args.fileChange);

  return (
    <div className="session-modal-overlay" role="dialog" aria-modal="true" aria-label="file-change-preview-dialog">
      <section className="session-modal file-change-modal">
        <header className="session-modal-header">
          <div>
            <p className="session-panel-eyebrow">File Change Preview</p>
            <h2>{args.fileChange.path}</h2>
            <p className="session-panel-copy">{formatFileChangeType(args.fileChange.changeType)} · {args.fileChange.absolutePath}</p>
          </div>
        </header>
        <div className="file-change-preview" aria-label="file-change-preview-content">
          {diffLines.length === 0 ? <p className="session-panel-empty">No file content to display.</p> : diffLines.map((line, index) => (
            <div key={`${line.type}-${index}-${line.text}`} className={`file-change-line file-change-line-${line.type}`}>
              <span className="file-change-line-number">{line.previousLineNumber ?? ''}</span>
              <span className="file-change-line-number">{line.currentLineNumber ?? ''}</span>
              <code className="file-change-line-text">{line.text || ' '}</code>
            </div>
          ))}
        </div>
        <footer className="session-modal-actions">
          <button type="button" className="provider-config-primary" onClick={args.onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

function buildFileChangePreviewLines(fileChange: RendererFileChange): Array<{
  readonly type: 'context' | 'added' | 'removed';
  readonly text: string;
  readonly previousLineNumber?: number;
  readonly currentLineNumber?: number;
}> {
  const previousLines = splitPreviewContent(fileChange.previousContent);
  const currentLines = splitPreviewContent(fileChange.currentContent);
  const lcs = Array.from({ length: previousLines.length + 1 }, () => Array<number>(currentLines.length + 1).fill(0));

  for (let previousIndex = previousLines.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let currentIndex = currentLines.length - 1; currentIndex >= 0; currentIndex -= 1) {
      lcs[previousIndex]![currentIndex] = previousLines[previousIndex] === currentLines[currentIndex]
        ? 1 + (lcs[previousIndex + 1]?.[currentIndex + 1] ?? 0)
        : Math.max(lcs[previousIndex + 1]?.[currentIndex] ?? 0, lcs[previousIndex]?.[currentIndex + 1] ?? 0);
    }
  }

  const result: Array<{
    readonly type: 'context' | 'added' | 'removed';
    readonly text: string;
    readonly previousLineNumber?: number;
    readonly currentLineNumber?: number;
  }> = [];

  let previousIndex = 0;
  let currentIndex = 0;

  while (previousIndex < previousLines.length && currentIndex < currentLines.length) {
    if (previousLines[previousIndex] === currentLines[currentIndex]) {
      result.push({
        type: 'context',
        text: currentLines[currentIndex] ?? '',
        previousLineNumber: previousIndex + 1,
        currentLineNumber: currentIndex + 1,
      });
      previousIndex += 1;
      currentIndex += 1;
      continue;
    }

    if ((lcs[previousIndex + 1]?.[currentIndex] ?? 0) >= (lcs[previousIndex]?.[currentIndex + 1] ?? 0)) {
      result.push({
        type: 'removed',
        text: previousLines[previousIndex] ?? '',
        previousLineNumber: previousIndex + 1,
      });
      previousIndex += 1;
      continue;
    }

    result.push({
      type: 'added',
      text: currentLines[currentIndex] ?? '',
      currentLineNumber: currentIndex + 1,
    });
    currentIndex += 1;
  }

  while (previousIndex < previousLines.length) {
    result.push({
      type: 'removed',
      text: previousLines[previousIndex] ?? '',
      previousLineNumber: previousIndex + 1,
    });
    previousIndex += 1;
  }

  while (currentIndex < currentLines.length) {
    result.push({
      type: 'added',
      text: currentLines[currentIndex] ?? '',
      currentLineNumber: currentIndex + 1,
    });
    currentIndex += 1;
  }

  return result;
}

function splitPreviewContent(content: string): string[] {
  if (!content) {
    return [];
  }

  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  return lines.length > 1 && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function formatFileChangeType(changeType: RendererFileChange['changeType']): string {
  switch (changeType) {
    case 'created':
      return 'Created';
    case 'modified':
      return 'Modified';
    case 'deleted':
      return 'Deleted';
  }
}

function renderMessageTrace(id: string, messageTrace: RendererMessageTraceStep[] | null | undefined) {
  if (!messageTrace || messageTrace.length === 0) {
    return null;
  }

  const totalMessages = messageTrace.reduce((sum, step) => sum + step.messageCount, 0);
  const totalChars = messageTrace.reduce((sum, step) => sum + step.charCount, 0);
  const totalToolCalls = messageTrace.reduce((sum, step) => sum + step.messages.filter((message) => message.toolName || message.toolCallId).length, 0);

  return (
    <details key={id} className="message-details">
      <summary className="message-details-summary">
        <span className="message-details-title">Process Info</span>
        <span className="message-details-meta">{totalMessages} messages</span>
        <span className="message-details-meta">{messageTrace.length} steps</span>
        {totalToolCalls > 0 ? <span className="message-details-meta">{totalToolCalls} tool calls</span> : null}
        <span className="message-details-meta">{totalChars} chars</span>
      </summary>
      <div className="message-trace">
        {messageTrace.map((step) => (
          <details key={`${id}-step-${step.stepNumber}`} className="message-step">
            <summary className="message-step-header message-step-summary">
              <span className="message-step-title">Step {step.stepNumber}</span>
              <span className="message-step-meta">{step.messageCount} messages</span>
              <span className="message-step-meta">{step.charCount} chars</span>
            </summary>
            <div className="message-step-list">
              {step.messages.map((message, index) => (
                <details key={`${id}-step-${step.stepNumber}-message-${index + 1}`} className="message-item">
                  <summary className="message-item-header message-item-summary">
                    <span className="message-item-role">{message.role}</span>
                    <span className="message-item-meta">{message.charCount} chars</span>
                    {message.toolName ? <span className="message-item-meta">tool={message.toolName}</span> : null}
                    {message.toolCallId ? <span className="message-item-meta">call={message.toolCallId}</span> : null}
                  </summary>
                  <div className="message-item-details">
                    <pre className="message-item-content">{message.content}</pre>
                    {message.toolArgs !== undefined ? (
                      <pre className="message-item-args">{JSON.stringify(message.toolArgs, null, 2)}</pre>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}