import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProfileTemplate, AgentSessionSummary, InputAttachmentManifest, IpcInputEnvelope, MemoryRecord, ProviderProfile, ProviderUsageStats, RendererExecCommand, RendererFileChange, RendererMessageTraceStep, RendererOutputBlock, Session, SessionMessage } from '../../shared/schema';
import type {
  DesktopFileReviewRequest,
  DesktopMenuAction,
  DesktopProviderStatus,
  DesktopRuntimeStatus,
  DesktopSessionSelectionResponse,
  DesktopSubmitResponse,
  DesktopTalkActiveConversation,
  DesktopTalkContinuationPrompt,
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
  DesktopToolApprovalBatch,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import { isTaskCancellationError } from '../../shared/task-cancellation.js';
import './styles.css';

const THINKING_PLACEHOLDER = 'Thinking through the next step...';
const STREAM_CHUNK_SIZE = 24;
const STREAM_TICK_MS = 18;
const VISIBLE_TRANSCRIPT_GROUP_LIMIT = 10;
const MESSAGE_TRACE_INITIAL_STEP_LIMIT = 100;
const MESSAGE_TRACE_STEP_PAGE_SIZE = 100;
const MESSAGE_TRACE_INITIAL_MESSAGE_LIMIT = 25;
const MESSAGE_TRACE_MESSAGE_PAGE_SIZE = 25;
const TOOL_APPROVAL_SIDEBAR_MIN_WIDTH = 280;
const TOOL_APPROVAL_SIDEBAR_DEFAULT_WIDTH = 336;
const TOOL_APPROVAL_SIDEBAR_MAX_WIDTH = 560;
const EMPTY_TOOL_APPROVAL_STATE: DesktopToolApprovalState = {
  activeBatch: null,
  activeFileReview: null,
};
const EMPTY_TALK_STATE: DesktopTalkState = {
  localPid: null,
  incomingRequest: null,
  activeConversation: null,
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
  readonly startedAtMs?: number;
  readonly completedAtMs?: number | null;
  readonly messageTrace: RendererMessageTraceStep[];
  readonly fileChanges: RendererFileChange[];
  readonly status: 'pending' | 'streaming' | 'complete' | 'cancelled';
  readonly blockType: 'task-result' | 'command-result' | 'error' | 'assistant';
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
  workspace: null,
  activeSessionId: null,
  contextCount: {
    estimatedTokens: 0,
    contextWindowLimit: null,
    utilizationRatio: null,
    messageCount: 0,
    selectedPromptCount: 0,
    selectedMemoryCount: 0,
    derivedMemoryCount: 0,
    breakdown: {
      systemPromptTokens: 0,
      userInputTokens: 0,
      toolResultTokens: 0,
    },
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
  providerRequestMetrics: null,
  selectedStepSummaryCount: 0,
  compactContextMode: false,
  selectedPromptCount: 0,
  selectedMemoryCount: 0,
  availableProviders: [],
  backgroundSummaryStatus: {
    state: 'idle',
    activeSummarySessionId: null,
    lastSummaryAt: null,
    lastSummaryMemoryId: null,
  },
  workflow: {
    hasActiveWorkflow: false,
    workflowId: null,
    workflowType: null,
    status: null,
    activeRoundNumber: null,
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
      submitInput: (input: IpcInputEnvelope) => Promise<DesktopSubmitResponse>;
      cancelActiveSubmit: () => Promise<void>;
      selectInputFiles: (sessionId: string | null) => Promise<InputAttachmentManifest[]>;
      getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
      getToolApprovalState: () => Promise<DesktopToolApprovalState>;
      getTalkState: () => Promise<DesktopTalkState>;
      respondToolApproval: (response: { batchId: string; decision: 'allow' | 'allow-all' | 'deny'; selectedRequestIds: string[] }) => Promise<DesktopToolApprovalState>;
      respondFileReview: (response: { reviewId: string; decision: 'keep' | 'discard' }) => Promise<DesktopToolApprovalState>;
      respondTalkRequest: (response: DesktopTalkRequestResponse) => Promise<DesktopTalkState>;
      respondTalkContinuation: (response: DesktopTalkContinuationResponse) => Promise<DesktopTalkState>;
      listAgentProfiles: () => Promise<AgentProfileTemplate[]>;
      startAgentSession: (profileId: string) => Promise<DesktopRuntimeStatus>;
      listAgentSessions: (agentInstanceId: string) => Promise<AgentSessionSummary[]>;
      getSession: (sessionId: string) => Promise<Session | null>;
      listSessionMemories: (sessionId: string) => Promise<MemoryRecord[]>;
      selectSession: (sessionId: string) => Promise<DesktopSessionSelectionResponse>;
      onMenuAction: (callback: (action: DesktopMenuAction) => void) => (() => void);
      onToolApprovalState: (callback: (state: DesktopToolApprovalState) => void) => (() => void);
      onTalkState: (callback: (state: DesktopTalkState) => void) => (() => void);
      onOutput: (callback: (event: unknown, data: RendererOutputBlock) => void) => void;
      removeAllListeners: (event: string) => void;
      focusMonitor: () => Promise<void>;
    };
  }
}

export function App() {
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<InputAttachmentManifest[]>([]);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [archivedTranscriptGroups, setArchivedTranscriptGroups] = useState<TranscriptGroup[]>([]);
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
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSessionDetails, setActiveSessionDetails] = useState<Session | null>(null);
  const [selectedSidebarSessionId, setSelectedSidebarSessionId] = useState<string | null>(null);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessionSortMode, setSessionSortMode] = useState<SessionSortMode>('updated-desc');
  const [isNewSessionComposerOpen, setIsNewSessionComposerOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [sessionPanelError, setSessionPanelError] = useState<string | null>(null);
  const [sessionInspectorSession, setSessionInspectorSession] = useState<AgentSessionSummary | null>(null);
  const [sessionInspectorMemories, setSessionInspectorMemories] = useState<MemoryRecord[]>([]);
  const [activeSessionMemories, setActiveSessionMemories] = useState<MemoryRecord[]>([]);
  const [toolApprovalState, setToolApprovalState] = useState<DesktopToolApprovalState>(EMPTY_TOOL_APPROVAL_STATE);
  const [talkState, setTalkState] = useState<DesktopTalkState>(EMPTY_TALK_STATE);
  const [selectedToolApprovalIds, setSelectedToolApprovalIds] = useState<string[]>([]);
  const [hasEditedToolApprovalSelection, setHasEditedToolApprovalSelection] = useState(false);
  const [isResolvingToolApproval, setIsResolvingToolApproval] = useState(false);
  const [isResolvingFileReview, setIsResolvingFileReview] = useState(false);
  const [isRespondingTalkRequest, setIsRespondingTalkRequest] = useState(false);
  const [isRespondingTalkContinuation, setIsRespondingTalkContinuation] = useState(false);
  const [sessionInspectorError, setSessionInspectorError] = useState<string | null>(null);
  const [isSessionInspectorLoading, setIsSessionInspectorLoading] = useState(false);
  const [isSessionSelecting, setIsSessionSelecting] = useState(false);
  const [selectedFileChange, setSelectedFileChange] = useState<RendererFileChange | null>(null);
  const [transcriptSearchInput, setTranscriptSearchInput] = useState('');
  const [transcriptSearchTerm, setTranscriptSearchTerm] = useState('');
  const [isTranscriptHistoryExpanded, setIsTranscriptHistoryExpanded] = useState(false);
  const [isContextBreakdownOpen, setIsContextBreakdownOpen] = useState(false);
  const [toolApprovalSidebarWidth, setToolApprovalSidebarWidth] = useState(TOOL_APPROVAL_SIDEBAR_DEFAULT_WIDTH);
  const [isResizingToolApprovalSidebar, setIsResizingToolApprovalSidebar] = useState(false);
  const [activeAnswerTimer, setActiveAnswerTimer] = useState<{ entryId: string; startedAtMs: number } | null>(null);
  const [answerTimerNowMs, setAnswerTimerNowMs] = useState(() => Date.now());
  const runtimeStatusRef = useRef(runtimeStatus);
  const selectedToolApprovalIdsRef = useRef<string[]>([]);
  const pendingAssistantEntryIdRef = useRef<string | null>(null);
  const pendingAssistantDraftRef = useRef('');
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRunIdRef = useRef(0);
  const outputPaneRef = useRef<HTMLElement | null>(null);
  const toolApprovalSidebarRef = useRef<HTMLElement | null>(null);
  const contextBreakdownRef = useRef<HTMLDivElement | null>(null);
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
    if (typeof window.electronAPI.getTalkState === 'function') {
      void window.electronAPI.getTalkState().then(setTalkState).catch(() => {
        setTalkState(EMPTY_TALK_STATE);
      });
    }
    void window.electronAPI.listAgentProfiles().then(setAgentProfiles).catch((error) => {
      setStartupError(error instanceof Error ? error.message : 'Failed to load agent profiles.');
    });
    const disposeToolApprovalListener = window.electronAPI.onToolApprovalState((state) => {
      setToolApprovalState(state);
    });
    const disposeTalkStateListener = typeof window.electronAPI.onTalkState === 'function'
      ? window.electronAPI.onTalkState((state) => {
        setTalkState(state);
      })
      : () => {};

    window.electronAPI.onOutput((event, data) => {
      if (data.type === 'system' && data.title === 'Assistant Draft') {
        appendPendingAssistantDraft(data.content);
        return;
      }

      if (data.type === 'system' && data.title === 'Agent Activity') {
        void window.electronAPI.getRuntimeStatus().then(setRuntimeStatus).catch(() => {});
        updatePendingAssistantProgress(data.content);
        return;
      }

      if (!shouldDisplayRendererBlock(data)) {
        return;
      }

      if (isAnswerBlock(data) && pendingAssistantEntryIdRef.current) {
        streamAssistantResponse(data);
        setIsSubmitting(false);
        return;
      }

      updateTranscriptEntries((previous) => upsertRendererBlock(previous, data));
    });

    return () => {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      disposeToolApprovalListener();
      disposeTalkStateListener();
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
    if (!toolApprovalState.activeFileReview) {
      setIsResolvingFileReview(false);
      return;
    }

    setIsToolApprovalSidebarOpen(true);
    setIsResolvingFileReview(false);
  }, [toolApprovalState.activeFileReview?.id]);

  useEffect(() => {
    if (!talkState.incomingRequest) {
      setIsRespondingTalkRequest(false);
    }
  }, [talkState.incomingRequest?.conversationId]);

  useEffect(() => {
    if (!talkState.activeConversation?.continuationPrompt) {
      setIsRespondingTalkContinuation(false);
    }
  }, [talkState.activeConversation?.conversationId, talkState.activeConversation?.continuationPrompt?.roundCount]);

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
  }, [runtimeStatus]);

  useEffect(() => {
    if (!activeAnswerTimer) {
      return;
    }

    setAnswerTimerNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setAnswerTimerNowMs(Date.now());
    }, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeAnswerTimer]);

  useEffect(() => {
    setTranscriptSearchInput('');
    setTranscriptSearchTerm('');
    setIsTranscriptHistoryExpanded(false);
    setIsContextBreakdownOpen(false);
    setPendingAttachments([]);
  }, [runtimeStatus.activeSessionId]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [transcriptEntries]);

  useEffect(() => {
    if (!isResizingToolApprovalSidebar) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const sidebarRect = toolApprovalSidebarRef.current?.getBoundingClientRect();
      if (!sidebarRect) {
        return;
      }

      setToolApprovalSidebarWidth(clampToolApprovalSidebarWidth(sidebarRect.right - event.clientX));
    };

    const stopResizing = () => {
      setIsResizingToolApprovalSidebar(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResizing);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [isResizingToolApprovalSidebar]);

  useEffect(() => {
    if (!isContextBreakdownOpen) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (!contextBreakdownRef.current?.contains(event.target as Node)) {
        setIsContextBreakdownOpen(false);
      }
    };

    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isContextBreakdownOpen]);

  useEffect(() => {
    const disposeMenuAction = window.electronAPI.onMenuAction((action) => {
      if (action === 'show-monitor') {
        window.electronAPI.focusMonitor();
        return;
      }

      const currentRuntimeStatus = runtimeStatusRef.current;

      if (action === 'configure-provider') {
        setProviderConfigError(null);
        setProviderConfigMode(currentRuntimeStatus.providerId === 'deepseek' ? 'deepseek' : 'github-copilot');
        setIsDeepSeekEditing((currentRuntimeStatus.providerId === 'deepseek'
          ? (currentRuntimeStatus.providerStatuses?.deepseek?.authState ?? 'missing') !== 'configured'
          : false));
        setIsProviderConfigOpen(true);
        setIsAgentPickerOpen(false);
        return;
      }

      if (action === 'new-conversation') {
        console.log('TODO: implement new conversation');
        return;
      }

      if (action === 'show-tool-approvals') {
        console.log('TODO: implement instrumentation panel');
        return;
      }

      if (action === 'open-mcp-manager') {
        console.log('TODO: implement MCP Manager');
        return;
      }
      if (action === 'open-cron-scheduler') {
        console.log('TODO: implement Cron Scheduler');
        return;
      }
      if (action === 'open-hooks') {
        console.log('TODO: implement Hooks');
        return;
      }


      // default: switch-agent
      setStartupError(null);
      setIsAgentPickerOpen(true);
      setIsProviderConfigOpen(false);
    });

    return () => {
      disposeMenuAction();
    };
  }, []);

  const appendErrorBlock = (title: string, message: string) => {
    updateTranscriptEntries((previous) => [
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

  const updateTranscriptEntries = (updater: (previous: TranscriptEntry[]) => TranscriptEntry[]) => {
    setTranscriptEntries((previous) => {
      const nextEntries = updater(previous);
      const nextPartition = partitionTranscriptEntries(nextEntries);

      if (nextPartition.archivedGroups.length > 0) {
        setArchivedTranscriptGroups((previousGroups) => [...previousGroups, ...nextPartition.archivedGroups]);
      }

      return nextPartition.visibleEntries;
    });
  };

  const hydrateSessionTranscript = (session: Session | null) => {
    setActiveSessionDetails(session);

    if (!session) {
      setArchivedTranscriptGroups([]);
      setTranscriptEntries([]);
      return;
    }

    const nextTranscript = partitionTranscriptEntries(createTranscriptEntriesFromSession(session));
    setArchivedTranscriptGroups(nextTranscript.archivedGroups);
    setTranscriptEntries(nextTranscript.visibleEntries);
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
        const activeSessionSummary = sessions.find((session) => session.id === nextRuntimeStatus.activeSessionId) ?? null;
        setSelectedSidebarSessionId(activeSessionSummary?.id ?? null);
        const activeSession = activeSessionSummary
          ? await window.electronAPI.getSession(activeSessionSummary.id)
          : null;
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
    const startedAtMs = Date.now();
    pendingAssistantEntryIdRef.current = assistantEntryId;
    pendingAssistantDraftRef.current = '';
    setActiveAnswerTimer({ entryId: assistantEntryId, startedAtMs });
    updateTranscriptEntries((previous) => [
      ...previous,
      {
        id: assistantEntryId,
        role: 'assistant',
        content: THINKING_PLACEHOLDER,
        createdAt,
        startedAtMs,
        completedAtMs: null,
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

    updateTranscriptEntries((previous) => previous.map((entry) => {
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

    updateTranscriptEntries((previous) => previous.map((entry) => {
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
      updateTranscriptEntries((previous) => upsertRendererBlock(previous, block));
      return;
    }

    if (!isAnswerBlock(block)) {
      updateTranscriptEntries((previous) => upsertRendererBlock(previous, block));
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

      updateTranscriptEntries((previous) => previous.map((entry) => {
        if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
          return entry;
        }

        return {
          ...entry,
          content: nextContent,
          messageTrace: block.messageTrace,
          fileChanges: block.fileChanges,
          status: nextCursor >= block.content.length ? 'complete' : 'streaming',
          completedAtMs: nextCursor >= block.content.length ? Date.now() : null,
          blockType: answerBlockType,
        };
      }));

      if (nextCursor >= block.content.length) {
        pendingAssistantEntryIdRef.current = null;
        pendingAssistantDraftRef.current = '';
        setActiveAnswerTimer(null);
        streamTimerRef.current = null;
        return;
      }

      streamTimerRef.current = setTimeout(() => {
        streamFrame(nextCursor);
      }, STREAM_TICK_MS);
    };

    if (initialCursor >= block.content.length) {
      updateTranscriptEntries((previous) => previous.map((entry) => {
        if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
          return entry;
        }

        return {
          ...entry,
          content: block.content,
          messageTrace: block.messageTrace,
          fileChanges: block.fileChanges,
          status: 'complete',
          completedAtMs: Date.now(),
          blockType: answerBlockType,
        };
      }));
      pendingAssistantEntryIdRef.current = null;
      pendingAssistantDraftRef.current = '';
      setActiveAnswerTimer(null);
      return;
    }

    streamFrame(initialCursor);
  };

  const executeInput = async (
    submittedInput: string,
    options: { recordUserEntry: boolean; attachments?: InputAttachmentManifest[] } = { recordUserEntry: true },
  ) => {
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
        updateTranscriptEntries((previous) => [
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
      const response = await window.electronAPI.submitInput(createRendererInputEnvelope({
        inputText: trimmedInput,
        sessionId: runtimeStatusRef.current.activeSessionId,
        attachments: options.attachments ?? [],
      }));

      if (assistantEntryId && !response.blocks.some((block) => isAnswerBlock(block))) {
        pendingAssistantEntryIdRef.current = null;
        pendingAssistantDraftRef.current = '';
        setActiveAnswerTimer(null);
        updateTranscriptEntries((previous) => previous.filter((entry) => !('role' in entry) || entry.id !== assistantEntryId));
      }

      const shouldHydrateCurrentSession = response.runtimeStatus.activeSessionId !== runtimeStatusRef.current.activeSessionId;
      setRuntimeStatus(response.runtimeStatus);
      if ((options.attachments ?? []).length > 0) {
        setPendingAttachments([]);
      }
      void refreshAgentSessions(response.runtimeStatus, { hydrateCurrentSession: shouldHydrateCurrentSession });
      void refreshActiveSessionMemories(response.runtimeStatus.activeSessionId);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (isTaskCancellationError(error)) {
        // User cancelled: preserve the assistant entry with whatever content has streamed.
        // Just clean up pending refs and timer; setIsSubmitting(false) happens in finally.
        if (assistantEntryId) {
          pendingAssistantEntryIdRef.current = null;
          pendingAssistantDraftRef.current = '';
          setActiveAnswerTimer(null);
          updateTranscriptEntries((previous) => previous.map((entry) => {
            if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
              return entry;
            }
            return {
              ...entry,
              status: 'cancelled',
              completedAtMs: Date.now(),
              blockType: 'assistant',
            };
          }));
        }
        return null;
      }

      if (assistantEntryId) {
        pendingAssistantEntryIdRef.current = null;
        pendingAssistantDraftRef.current = '';
        setActiveAnswerTimer(null);
        updateTranscriptEntries((previous) => previous.map((entry) => {
          if (!('role' in entry) || entry.role !== 'assistant' || entry.id !== assistantEntryId) {
            return entry;
          }

          return {
            ...entry,
            content: message,
            status: 'complete',
            completedAtMs: Date.now(),
            blockType: 'error',
          };
        }));
      }

      updateTranscriptEntries((previous) => [
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
    await executeInput(submittedInput, { recordUserEntry: true, attachments: pendingAttachments });
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

  const handleOpenSessionInspector = async (session: AgentSessionSummary) => {
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
  const activeFileReview = toolApprovalState.activeFileReview;
  const activeTalkConversation = talkState.activeConversation;
  const activeTalkContinuationPrompt = activeTalkConversation?.continuationPrompt ?? null;
  const hasActiveWorkflow = runtimeStatus.workflow?.hasActiveWorkflow ?? false;
  const todoMemory = selectSelectedTodoMemory(activeSessionMemories, activeSessionDetails?.selectedMemoryIds ?? [], hasActiveWorkflow);
  const todoItems = parseTodoMemoryItems(todoMemory);
  const staleTodoMemory = !hasActiveWorkflow ? selectLatestTodoMemory(activeSessionMemories) : null;
  const staleTodoItems = parseTodoMemoryItems(staleTodoMemory);
  const transcriptGroups = useMemo(() => createTranscriptGroups(transcriptEntries), [transcriptEntries]);
  const allTranscriptGroups = useMemo(() => [...archivedTranscriptGroups, ...transcriptGroups], [archivedTranscriptGroups, transcriptGroups]);
  const filteredTranscriptGroups = transcriptSearchTerm.trim().length > 0
    ? allTranscriptGroups.filter((group) => doesTranscriptGroupMatch(group, transcriptSearchTerm))
    : transcriptGroups;
  const hiddenTranscriptGroups = transcriptSearchTerm.trim().length > 0
    ? []
    : archivedTranscriptGroups;
  const visibleTranscriptGroups = transcriptSearchTerm.trim().length > 0
    ? filteredTranscriptGroups
    : transcriptGroups;
  const displayedProviderUsageStats = selectDisplayedProviderUsageStats(
    runtimeStatus.providerUsageStats,
    activeSessionDetails?.providerUsageStats,
  );
  const totalTokens = displayedProviderUsageStats.totalTokens;
  const cacheHitRatio = displayedProviderUsageStats.cacheHitRatio;
  const providerRequestMetrics = runtimeStatus.providerRequestMetrics ?? null;
  const selectedStepSummaryCount = runtimeStatus.selectedStepSummaryCount ?? 0;
  const compactContextMode = runtimeStatus.compactContextMode ?? false;
  const submittedContextTokens = providerRequestMetrics?.submittedTokens ?? runtimeStatus.contextCount.estimatedTokens;
  const contextWindowSummary = formatContextWindowSummary(
    submittedContextTokens,
    runtimeStatus.contextCount.contextWindowLimit,
  );
  const contextUtilizationRatio = resolveContextUtilizationRatio(
    submittedContextTokens,
    runtimeStatus.contextCount.contextWindowLimit,
    runtimeStatus.contextCount.utilizationRatio,
  );
  const contextBreakdownItems = createContextBreakdownItems(runtimeStatus.contextCount);
  const workspaceColumns = [
    'minmax(0, 1fr)',
    ...(isSessionSidebarOpen ? ['minmax(280px, 24vw)'] : []),
    ...(isToolApprovalSidebarOpen ? [`minmax(${TOOL_APPROVAL_SIDEBAR_MIN_WIDTH}px, ${toolApprovalSidebarWidth}px)`] : []),
    ...(isTodoSidebarOpen ? ['minmax(260px, 21vw)'] : []),
  ].join(' ');
  const effectiveSelectedToolApprovalIds = activeToolApprovalBatch && !hasEditedToolApprovalSelection
    ? activeToolApprovalBatch.requests.map((request) => request.id)
    : selectedToolApprovalIds;
  const desktopProcessId = runtimeStatus.desktopProcessId ?? talkState.localPid;
  const inputPlaceholder = needsAgentSelection
    ? 'Select an agent profile to begin...'
    : activeTalkConversation
      ? `Talking to pid ${activeTalkConversation.peerPid}. Only /talkto ${activeTalkConversation.peerPid} end is accepted.`
      : 'Enter command or task...';

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

  const handleResolveToolApproval = async (decision: 'allow' | 'allow-all' | 'deny') => {
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

  const handleResolveFileReview = async (decision: 'keep' | 'discard') => {
    if (!activeFileReview || isResolvingFileReview) {
      return;
    }

    setIsResolvingFileReview(true);

    try {
      const nextState = await window.electronAPI.respondFileReview({
        reviewId: activeFileReview.id,
        decision,
      });
      setToolApprovalState(nextState);
    } finally {
      setIsResolvingFileReview(false);
    }
  };

  const handleRespondTalkRequest = async (decision: 'accept' | 'reject') => {
    const incomingRequest = talkState.incomingRequest;
    if (!incomingRequest || isRespondingTalkRequest) {
      return;
    }

    setIsRespondingTalkRequest(true);

    try {
      if (typeof window.electronAPI.respondTalkRequest !== 'function') {
        return;
      }

      const nextState = await window.electronAPI.respondTalkRequest({
        conversationId: incomingRequest.conversationId,
        decision,
      });
      setTalkState(nextState);
    } finally {
      setIsRespondingTalkRequest(false);
    }
  };

  const handleRespondTalkContinuation = async (decision: 'continue' | 'end') => {
    const activeConversation = talkState.activeConversation;
    if (!activeConversation?.continuationPrompt || isRespondingTalkContinuation) {
      return;
    }

    setIsRespondingTalkContinuation(true);

    try {
      if (typeof window.electronAPI.respondTalkContinuation !== 'function') {
        return;
      }

      const nextState = await window.electronAPI.respondTalkContinuation({
        conversationId: activeConversation.conversationId,
        decision,
      });
      setTalkState(nextState);
    } finally {
      setIsRespondingTalkContinuation(false);
    }
  };

  const handleRequeueStaleTodo = async () => {
    if (!staleTodoMemory || isSubmitting) {
      return;
    }

    await executeInput(`/workflow ${buildWorkflowGoalFromTodo(staleTodoMemory, staleTodoItems)}`, { recordUserEntry: true });
  };

  const handleClearStaleTodo = async () => {
    if (!staleTodoMemory || isSubmitting) {
      return;
    }

    const workflowId = extractWorkflowIdFromMemory(staleTodoMemory);
    const command = workflowId
      ? `/workflow-clear-stale ${workflowId}`
      : '/workflow-clear-stale';

    await executeInput(command, { recordUserEntry: true });
  };

  const handleStartToolApprovalSidebarResize = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setIsResizingToolApprovalSidebar(true);
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

  const handleSelectInputFiles = async () => {
    try {
      const nextAttachments = await window.electronAPI.selectInputFiles(runtimeStatus.activeSessionId);
      if (nextAttachments.length === 0) {
        return;
      }

      setPendingAttachments((current) => {
        const seenIds = new Set(current.map((attachment) => attachment.attachmentId));
        const uniqueNext = nextAttachments.filter((attachment) => !seenIds.has(attachment.attachmentId));
        return [...current, ...uniqueNext];
      });
    } catch (error) {
      appendErrorBlock('Attachment Upload Error', error instanceof Error ? error.message : 'Failed to select files.');
    }
  };

  const handleRemovePendingAttachment = (attachmentId: string) => {
    setPendingAttachments((current) => current.filter((attachment) => attachment.attachmentId !== attachmentId));
  };

  return (
    <div className="app">
      <header className="app-toolbar" aria-label="window-toolbar">
        <div className="app-toolbar-copy">
          <span className="app-toolbar-title">Pueblo</span>
          <div className="app-toolbar-copy-meta">
            <span className="app-toolbar-subtitle">{runtimeStatus.agentProfileName ?? 'No agent selected'}</span>
            <span className="app-toolbar-pid">PID {desktopProcessId ?? 'n/a'}</span>
          </div>
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
          {activeTalkConversation ? renderTalkBanner({ conversation: activeTalkConversation }) : null}
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
                      answerTimerNowMs,
                    }) : null}
                    {visibleTranscriptGroups.map((group) => renderTranscriptGroup(group, {
                      onOpenFileChange: setSelectedFileChange,
                      answerTimerNowMs,
                    }))}
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
          <aside
            ref={toolApprovalSidebarRef}
            className={`workspace-sidebar workspace-sidebar-approval ${isResizingToolApprovalSidebar ? 'workspace-sidebar-approval-resizing' : ''}`}
            aria-label="workspace-tool-approval-sidebar"
          >
            <button
              type="button"
              className="workspace-sidebar-resize-handle"
              aria-label="Resize tool approval sidebar"
              onMouseDown={handleStartToolApprovalSidebarResize}
            />
            {renderToolApprovalSidebar({
              toolApprovalBatch: activeToolApprovalBatch,
              fileReviewRequest: activeFileReview,
              selectedRequestIds: effectiveSelectedToolApprovalIds,
              isResolvingToolApproval,
              isResolvingFileReview,
              onToggleRequest: handleToggleToolApprovalSelection,
              onOpenFileReviewPreview: setSelectedFileChange,
              onAllow: () => {
                void handleResolveToolApproval('allow');
              },
              onAllowAll: () => {
                void handleResolveToolApproval('allow-all');
              },
              onDeny: () => {
                void handleResolveToolApproval('deny');
              },
              onKeepFileReview: () => {
                void handleResolveFileReview('keep');
              },
              onDiscardFileReview: () => {
                void handleResolveFileReview('discard');
              },
            })}
          </aside>
        ) : null}
        {isTodoSidebarOpen ? (
          <aside className="workspace-sidebar workspace-sidebar-todo" aria-label="workspace-todo-sidebar">
            {renderTodoSidebar({
              todoMemory,
              todoItems,
              hasActiveWorkflow,
              staleTodoMemory,
              staleTodoItems,
              isSubmitting,
              onRequeueStaleTodo: () => {
                void handleRequeueStaleTodo();
              },
              onClearStaleTodo: () => {
                void handleClearStaleTodo();
              },
            })}
          </aside>
        ) : null}
      </div>
      <section className="status-strip" aria-label="runtime-status">
        <div className="status-strip-controls">
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
          <span className="status-chip" title={runtimeStatus.workspace ?? 'No workspace selected'}>
            <span className="status-chip-label">Workspace</span>
            <span className="status-chip-value">{formatWorkspaceLabel(runtimeStatus.workspace)}</span>
          </span>
        </div>
        <div className="status-strip-context">
          <div
            ref={contextBreakdownRef}
            className={`context-window-chip ${isContextBreakdownOpen ? 'context-window-chip-open' : ''}`}
          >
            <button
              type="button"
              className="context-window-button"
              aria-label="Show context window breakdown"
              aria-expanded={isContextBreakdownOpen}
              onClick={() => {
                setIsContextBreakdownOpen((current) => !current);
              }}
            >
              <span className="status-chip-label">Context Window</span>
              <span className="context-window-summary">
                <span className="context-window-value">{contextWindowSummary}</span>
                <span className="context-window-ratio">{formatRatioPercent(contextUtilizationRatio)}</span>
              </span>
              <span className="context-window-bar" aria-hidden="true">
                <span
                  className="context-window-bar-fill"
                  style={{ width: `${formatProgressPercent(contextUtilizationRatio)}%` }}
                />
              </span>
            </button>
            {isContextBreakdownOpen ? (
              <div className="context-breakdown-popover" role="dialog" aria-label="context-breakdown">
                <div className="context-breakdown-header">
                  <span className="status-chip-label">Current Step</span>
                  <span className="context-breakdown-total">{formatCompactInteger(submittedContextTokens)} tokens</span>
                </div>
                <div className="context-breakdown-header">
                  <span className="status-chip-label">Selected Context Mix</span>
                  <span className="context-breakdown-total">{formatCompactInteger(runtimeStatus.contextCount.estimatedTokens)} tokens</span>
                </div>
                <div className="context-breakdown-list">
                  {contextBreakdownItems.map((item) => (
                    <div key={item.key} className="context-breakdown-item">
                      <span className={`context-breakdown-swatch context-breakdown-swatch-${item.key}`} aria-hidden="true" />
                      <span className="context-breakdown-name">{item.label}</span>
                      <span className="context-breakdown-share">{formatPercentage(item.share)}</span>
                      <span className="context-breakdown-tokens">{formatCompactInteger(item.tokens)} tokens</span>
                      <span className="context-breakdown-bar" aria-hidden="true">
                        <span
                          className={`context-breakdown-bar-fill context-breakdown-bar-fill-${item.key}`}
                          style={{ width: `${item.share}%` }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
                <div className="context-breakdown-footer">
                  <div className="context-breakdown-header">
                    <span className="status-chip-label">Runtime Stats</span>
                  </div>
                  <div className="context-breakdown-stats">
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Message Length</span>
                      <span className="context-breakdown-total">{runtimeStatus.modelMessageCharCount} chars</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Selected Context</span>
                      <span className="context-breakdown-total">{formatCompactInteger(runtimeStatus.contextCount.estimatedTokens)} tokens</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Total Tokens</span>
                      <span className="context-breakdown-total">{formatCompactInteger(totalTokens)} tokens</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Cache Hit</span>
                      <span className="context-breakdown-total">{formatCacheHitRatio(cacheHitRatio)}</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Last Request</span>
                      <span className="context-breakdown-total">{formatRequestSize(providerRequestMetrics?.bodyBytes)}</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Request Compaction</span>
                      <span className="context-breakdown-total">{formatRequestCompaction(providerRequestMetrics)}</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Active Step Context</span>
                      <span className="context-breakdown-total">{formatStepSummaryHits(selectedStepSummaryCount)}</span>
                    </div>
                    <div className="context-breakdown-stat">
                      <span className="context-breakdown-name">Compact Context</span>
                      <span className="context-breakdown-total">{formatCompactContextMode(compactContextMode)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
      <form className="input-pane" aria-label="input-region" onSubmit={handleSubmit}>
        {pendingAttachments.length > 0 ? (
          <div className="input-attachments" aria-label="pending-attachments">
            {pendingAttachments.map((attachment) => (
              <div key={attachment.attachmentId} className="input-attachment-chip">
                <div className="input-attachment-chip-copy">
                  <span className="input-attachment-chip-name">{attachment.source.fileName}</span>
                  <span className="input-attachment-chip-meta">
                    {attachment.kind} · {attachment.summary.isLarge ? 'read via JSON' : 'inline JSON'}
                  </span>
                </div>
                <button
                  type="button"
                  className="input-attachment-chip-remove"
                  aria-label={`Remove ${attachment.source.fileName}`}
                  onClick={() => {
                    handleRemovePendingAttachment(attachment.attachmentId);
                  }}
                >
                  X
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <button type="button" className="input-label input-label-upload" onClick={() => { void handleSelectInputFiles(); }}>pueblo&gt;</button>
        <input
          id="pueblo-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={inputPlaceholder}
          disabled={needsAgentSelection || isSubmitting}
          autoFocus
        />
        {isSubmitting ? (
          <button
            type="button"
            className="cancel-submit-button"
            title="Cancel current request"
            onClick={() => { void window.electronAPI.cancelActiveSubmit(); }}
            aria-label="Cancel current request"
          >
            ✕
          </button>
        ) : (
          <button type="submit" disabled={needsAgentSelection}>Send</button>
        )}
      </form>
      {talkState.incomingRequest ? renderTalkRequestModal({
        request: talkState.incomingRequest,
        isPending: isRespondingTalkRequest,
        onAccept: () => {
          void handleRespondTalkRequest('accept');
        },
        onReject: () => {
          void handleRespondTalkRequest('reject');
        },
      }) : null}
      {activeTalkConversation && activeTalkContinuationPrompt ? renderTalkContinuationModal({
        conversation: activeTalkConversation,
        prompt: activeTalkContinuationPrompt,
        isPending: isRespondingTalkContinuation,
        onContinue: () => {
          void handleRespondTalkContinuation('continue');
        },
        onEnd: () => {
          void handleRespondTalkContinuation('end');
        },
      }) : null}
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

function resolveContextUtilizationRatio(
  estimatedTokens: number,
  contextWindowLimit: number | null,
  fallbackRatio: number | null,
): number | null {
  if (contextWindowLimit && contextWindowLimit > 0) {
    return Math.min(estimatedTokens / contextWindowLimit, 1);
  }

  if (fallbackRatio === null) {
    return null;
  }

  return Math.min(Math.max(fallbackRatio, 0), 1);
}

function formatContextWindowSummary(estimatedTokens: number, contextWindowLimit: number | null): string {
  if (!contextWindowLimit || contextWindowLimit <= 0) {
    return `${formatCompactInteger(estimatedTokens)} / n/a`;
  }

  return `${formatCompactInteger(estimatedTokens)} / ${formatCompactInteger(contextWindowLimit)}`;
}

function formatRatioPercent(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatProgressPercent(value: number | null): number {
  if (value === null) {
    return 0;
  }

  return Number((Math.min(Math.max(value, 0), 1) * 100).toFixed(1));
}

function formatPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

function createContextBreakdownItems(contextCount: DesktopRuntimeStatus['contextCount']): Array<{
  key: 'system' | 'user' | 'tool';
  label: string;
  tokens: number;
  share: number;
}> {
  const totalTokens = contextCount.estimatedTokens;
  const breakdown = contextCount.breakdown ?? {
    systemPromptTokens: 0,
    userInputTokens: 0,
    toolResultTokens: 0,
  };
  const createShare = (tokens: number) => (totalTokens > 0 ? Number(((tokens / totalTokens) * 100).toFixed(1)) : 0);

  return [
    {
      key: 'system',
      label: 'System Prompt',
      tokens: breakdown.systemPromptTokens,
      share: createShare(breakdown.systemPromptTokens),
    },
    {
      key: 'user',
      label: 'User Input',
      tokens: breakdown.userInputTokens,
      share: createShare(breakdown.userInputTokens),
    },
    {
      key: 'tool',
      label: 'Tool Result',
      tokens: breakdown.toolResultTokens,
      share: createShare(breakdown.toolResultTokens),
    },
  ];
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

function formatRequestSize(value: number | null | undefined): string {
  if (!value || value <= 0) {
    return 'n/a';
  }

  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  if (value >= 1024) {
    return `${Math.round(value / 102.4) / 10} KB`;
  }

  return `${value} B`;
}

function formatRequestCompaction(metrics: DesktopRuntimeStatus['providerRequestMetrics']): string {
  if (!metrics) {
    return 'n/a';
  }

  if (!metrics.compacted) {
    return 'none';
  }

  return `${metrics.compactionStage} · ${metrics.compactedToolMessages} tool`;
}

function formatStepSummaryHits(value: number): string {
  return `${value} step`;
}

function formatCompactContextMode(value: boolean): string {
  return value ? 'active' : 'inactive';
}

function formatWorkspaceLabel(value: string | null | undefined): string {
  if (!value) {
    return 'Not set';
  }

  return value.length <= 40 ? value : `...${value.slice(-37)}`;
}

function formatThinkingDuration(startedAtMs: number, endedAtMs: number): string {
  const elapsedMs = Math.max(endedAtMs - startedAtMs, 0);
  const elapsedSeconds = elapsedMs / 1000;

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.floor(elapsedSeconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}min${seconds}sec`;
}

function createRendererInputEnvelope(args: {
  inputText: string;
  sessionId: string | null;
  attachments: InputAttachmentManifest[];
}): IpcInputEnvelope {
  const submittedAt = new Date().toISOString();

  return {
    requestId: `${submittedAt}-${Math.random().toString(16).slice(2)}`,
    windowId: 'desktop-window',
    sessionId: args.sessionId,
    inputText: args.inputText,
    attachments: args.attachments,
    submittedAt,
  };
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
  answerTimerNowMs: number;
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
          {args.groups.map((group) => renderTranscriptGroup(group, {
            onOpenFileChange: args.onOpenFileChange,
            answerTimerNowMs: args.answerTimerNowMs,
          }))}
        </div>
      ) : null}
    </details>
  );
}

function renderTranscriptGroup(
  group: TranscriptGroup,
  actions: {
    readonly onOpenFileChange: (fileChange: RendererFileChange) => void;
    readonly answerTimerNowMs: number;
  },
) {
  return (
    <div key={group.id} className="transcript-group">
      {group.entries.map((entry) => renderTranscriptEntry(entry, actions))}
    </div>
  );
}

function renderToolApprovalSidebar(args: {
  toolApprovalBatch: DesktopToolApprovalBatch | null;
  fileReviewRequest: DesktopFileReviewRequest | null;
  selectedRequestIds: string[];
  isResolvingToolApproval: boolean;
  isResolvingFileReview: boolean;
  onToggleRequest: (requestId: string) => void;
  onOpenFileReviewPreview: (fileChange: RendererFileChange) => void;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
  onKeepFileReview: () => void;
  onDiscardFileReview: () => void;
}) {
  const groupedRequests = groupToolApprovalRequests(args.toolApprovalBatch?.requests ?? []);
  const hasQueuedApprovals = groupedRequests.command.length > 0 || groupedRequests.fileEdit.length > 0 || groupedRequests.other.length > 0;

  return (
    <section className="workflow-sidebar-panel">
      <header className="workflow-sidebar-header">
        <div className="workflow-sidebar-header-main">
          <p className="workflow-sidebar-eyebrow">Tool Approval</p>
          <h2>Queued Calls</h2>
        </div>
        {args.toolApprovalBatch ? <span className="workflow-sidebar-badge">{args.toolApprovalBatch.requests.length}</span> : null}
      </header>
      {args.fileReviewRequest ? (
        <>
          <div className="workflow-sidebar-section-header">
            <p className="workflow-sidebar-eyebrow">Staged Review</p>
            <h3>Edited Copy Ready</h3>
          </div>
          <p className="workflow-sidebar-copy">The file was edited in a shadow worktree copy. Keep applies it to the workspace; discard removes the staged copy.</p>
          <article className="file-review-card">
            <button
              type="button"
              className="file-review-path"
              onClick={() => {
                args.onOpenFileReviewPreview(args.fileReviewRequest!.fileChange);
              }}
            >
              {args.fileReviewRequest.fileChange.path}
            </button>
            <p className="workflow-sidebar-meta">{formatFileChangeType(args.fileReviewRequest.fileChange.changeType)} staged in shadow copy</p>
            <p className="workflow-sidebar-copy">{args.fileReviewRequest.summary}</p>
          </article>
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-approval-action-button tool-approval-allow-button"
              onClick={args.onKeepFileReview}
              disabled={args.isResolvingFileReview}
            >
              {args.isResolvingFileReview ? 'Applying...' : 'Keep'}
            </button>
            <button
              type="button"
              className="tool-approval-action-button tool-approval-deny-button"
              onClick={args.onDiscardFileReview}
              disabled={args.isResolvingFileReview}
            >
              Discard
            </button>
          </div>
        </>
      ) : null}
      {hasQueuedApprovals ? (
        <>
          <p className="workflow-sidebar-copy">Use the + button to keep or remove it from the current approval set.</p>
          {groupedRequests.command.length > 0 ? (
            <div className="tool-approval-group">
              <div className="workflow-sidebar-section-header">
                <p className="workflow-sidebar-eyebrow">Commands</p>
                <h3>{groupedRequests.command.length}</h3>
              </div>
              <div className="tool-approval-list" role="list" aria-label="tool-approval-command-list">
                {groupedRequests.command.map((request) => {
                  const isSelected = args.selectedRequestIds.includes(request.id);
                  return renderToolApprovalRow(request, isSelected, args.onToggleRequest, args.isResolvingToolApproval);
                })}
              </div>
            </div>
          ) : null}
          {groupedRequests.fileEdit.length > 0 ? (
            <div className="tool-approval-group">
              <div className="workflow-sidebar-section-header">
                <p className="workflow-sidebar-eyebrow">File Edits</p>
                <h3>{groupedRequests.fileEdit.length}</h3>
              </div>
              <div className="tool-approval-list" role="list" aria-label="tool-approval-file-list">
                {groupedRequests.fileEdit.map((request) => {
                  const isSelected = args.selectedRequestIds.includes(request.id);
                  return renderToolApprovalRow(request, isSelected, args.onToggleRequest, args.isResolvingToolApproval);
                })}
              </div>
            </div>
          ) : null}
          {groupedRequests.other.length > 0 ? (
            <div className="tool-approval-group">
              <div className="workflow-sidebar-section-header">
                <p className="workflow-sidebar-eyebrow">Other</p>
                <h3>{groupedRequests.other.length}</h3>
              </div>
              <div className="tool-approval-list" role="list" aria-label="tool-approval-other-list">
                {groupedRequests.other.map((request) => {
                  const isSelected = args.selectedRequestIds.includes(request.id);
                  return renderToolApprovalRow(request, isSelected, args.onToggleRequest, args.isResolvingToolApproval);
                })}
              </div>
            </div>
          ) : null}
          <div className="tool-approval-actions">
            <button
              type="button"
              className="tool-approval-action-button tool-approval-allow-button"
              onClick={args.onAllow}
              disabled={args.isResolvingToolApproval}
            >
              {args.isResolvingToolApproval ? 'Applying...' : 'Allow'}
            </button>
            <button
              type="button"
              className="tool-approval-action-button tool-approval-allow-all-button"
              onClick={args.onAllowAll}
              disabled={args.isResolvingToolApproval}
            >
              Allow All
            </button>
            <button
              type="button"
              className="tool-approval-action-button tool-approval-deny-button"
              onClick={args.onDeny}
              disabled={args.isResolvingToolApproval}
            >
              Deny
            </button>
          </div>
        </>
      ) : args.fileReviewRequest ? null : (
        <p className="session-panel-empty">No pending tool approvals.</p>
      )}
    </section>
  );
}

function renderToolApprovalRow(
  request: DesktopToolApprovalBatch['requests'][number],
  isSelected: boolean,
  onToggleRequest: (requestId: string) => void,
  isResolvingToolApproval: boolean,
) {
  const displayText = getToolApprovalPrimaryDisplayText(request);
  const actionLabel = truncateToolApprovalText(displayText || request.operationLabel || request.toolName, 80);

  return (
    <article
      key={request.id}
      className={`tool-approval-row ${isSelected ? 'tool-approval-row-selected' : 'tool-approval-row-muted'}`}
    >
      <div className="tool-approval-row-main">
        <div className="tool-approval-row-line">
          <span className="tool-approval-primary">{displayText}</span>
          <button
            type="button"
            className={`tool-approval-toggle ${isSelected ? 'tool-approval-toggle-selected' : ''}`}
            aria-pressed={isSelected}
            aria-label={isSelected ? `Deselect ${actionLabel}` : `Select ${actionLabel}`}
            onClick={() => onToggleRequest(request.id)}
            disabled={isResolvingToolApproval}
          >
            +
          </button>
        </div>
      </div>
    </article>
  );
}

function groupToolApprovalRequests(requests: DesktopToolApprovalBatch['requests']) {
  return {
    command: requests.filter((request) => request.kind === 'command'),
    fileEdit: requests.filter((request) => request.kind === 'file-edit'),
    other: requests.filter((request) => request.kind === 'other'),
  };
}

function getToolApprovalPrimaryDisplayText(request: DesktopToolApprovalBatch['requests'][number]): string {
  if (request.kind === 'file-edit') {
    return getToolApprovalDisplayLabel(request.primaryText);
  }

  const trimmed = request.primaryText.trim();
  return trimmed.length > 0 ? trimmed : request.targetLabel;
}

function renderTodoSidebar(args: {
  todoMemory: MemoryRecord | null;
  todoItems: WorkflowTodoItem[];
  hasActiveWorkflow: boolean;
  staleTodoMemory: MemoryRecord | null;
  staleTodoItems: WorkflowTodoItem[];
  isSubmitting: boolean;
  onRequeueStaleTodo: () => void;
  onClearStaleTodo: () => void;
}) {
  const visibleTodoCount = args.hasActiveWorkflow ? args.todoItems.length : args.staleTodoItems.length;

  return (
    <section className="workflow-sidebar-panel">
      <header className="workflow-sidebar-header">
        <div className="workflow-sidebar-header-main">
          <p className="workflow-sidebar-eyebrow">Todo</p>
          <h2>{args.hasActiveWorkflow ? 'Current Tasks' : 'Historical Tasks'}</h2>
        </div>
        {visibleTodoCount > 0 ? <span className="workflow-sidebar-badge">{visibleTodoCount}</span> : null}
      </header>
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
      ) : args.staleTodoMemory ? (
        <>
          <p className="workflow-sidebar-copy">
            No active workflow is running. These tasks come from a historical workflow todo memory and are not currently scheduled.
          </p>
          <p className="workflow-sidebar-copy">{args.staleTodoMemory.title}</p>
          <p className="workflow-sidebar-meta">Updated {formatTimestamp(args.staleTodoMemory.updatedAt)}</p>
          {args.staleTodoItems.length > 0 ? (
            <div className="todo-list" role="list" aria-label="stale-todo-list">
              {args.staleTodoItems.map((item) => (
                <article key={`${item.id}-${item.title}`} className="todo-item">
                  <span className="todo-item-id">{item.id}</span>
                  <p className="todo-item-title">{item.title}</p>
                </article>
              ))}
            </div>
          ) : null}
          <div className="todo-sidebar-actions">
            <button
              type="button"
              className="provider-config-primary"
              onClick={args.onRequeueStaleTodo}
              disabled={args.isSubmitting}
            >
              Re-dispatch Tasks
            </button>
            <button
              type="button"
              className="provider-config-secondary"
              onClick={args.onClearStaleTodo}
              disabled={args.isSubmitting}
            >
              Clear Stale Workflow
            </button>
          </div>
        </>
      ) : (
        <p className="session-panel-empty">No todo list is available for the current session.</p>
      )}
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

function renderTalkBanner(args: {
  conversation: DesktopTalkActiveConversation;
}) {
  const continuationPrompt = args.conversation.continuationPrompt;

  return (
    <section className="talk-banner" aria-label="talk-banner">
      <div className="talk-banner-copy">
        <p className="talk-banner-eyebrow">Agent Talk</p>
        <h2>
          {args.conversation.status === 'requesting'
            ? `Requesting pid ${args.conversation.peerPid}`
            : `Talking to pid ${args.conversation.peerPid}`}
        </h2>
        <p className="talk-banner-meta">
          Turns {args.conversation.turnCount}
          {' · '}
          Limit {args.conversation.turnLimit}
          {' · '}
          {args.conversation.initiatedBy === 'local' ? 'Started here' : 'Accepted here'}
        </p>
        <p className="talk-banner-copyline">
          {continuationPrompt
            ? `Waiting for both sides to continue after ${continuationPrompt.roundCount} turns.`
            : `Only /talkto ${args.conversation.peerPid} end is accepted while this talk session is active.`}
        </p>
      </div>
    </section>
  );
}

function renderTalkRequestModal(args: {
  request: DesktopTalkState['incomingRequest'];
  isPending: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  if (!args.request) {
    return null;
  }

  return (
    <div className="session-modal-overlay" role="dialog" aria-modal="true" aria-label="talk-request-dialog">
      <section className="session-modal talk-modal">
        <header className="session-modal-header">
          <div>
            <p className="session-panel-eyebrow">Agent Talk Request</p>
            <h2>来自 pid {args.request.fromPid} 的对话请求</h2>
            <p className="session-panel-copy">{args.request.fromAgentProfileName ?? 'Unknown agent'}</p>
          </div>
        </header>
        <div className="talk-modal-body">
          <p>{args.request.message}</p>
        </div>
        <footer className="session-modal-actions">
          <button type="button" className="provider-config-primary" onClick={args.onAccept} disabled={args.isPending}>
            {args.isPending ? '处理中...' : '接受'}
          </button>
          <button type="button" className="provider-config-secondary" onClick={args.onReject} disabled={args.isPending}>
            拒绝
          </button>
        </footer>
      </section>
    </div>
  );
}

function renderTalkContinuationModal(args: {
  conversation: DesktopTalkActiveConversation;
  prompt: DesktopTalkContinuationPrompt;
  isPending: boolean;
  onContinue: () => void;
  onEnd: () => void;
}) {
  const canDecide = args.prompt.localDecision === 'pending';

  return (
    <div className="session-modal-overlay" role="dialog" aria-modal="true" aria-label="talk-continuation-dialog">
      <section className="session-modal talk-modal">
        <header className="session-modal-header">
          <div>
            <p className="session-panel-eyebrow">Talk Turn Limit</p>
            <h2>继续与 pid {args.conversation.peerPid} 对话？</h2>
            <p className="session-panel-copy">已达到 {args.prompt.roundCount} 轮，对话需双方确认后继续。</p>
          </div>
        </header>
        <div className="talk-modal-body">
          <p>本地状态：{formatTalkDecision(args.prompt.localDecision)}</p>
          <p>对端状态：{formatTalkDecision(args.prompt.remoteDecision)}</p>
        </div>
        <footer className="session-modal-actions">
          <button type="button" className="provider-config-primary" onClick={args.onContinue} disabled={!canDecide || args.isPending}>
            {args.isPending ? '处理中...' : canDecide ? '继续' : '已确认，等待对端'}
          </button>
          <button type="button" className="provider-config-secondary" onClick={args.onEnd} disabled={!canDecide || args.isPending}>
            结束对话
          </button>
        </footer>
      </section>
    </div>
  );
}

function formatTalkDecision(value: DesktopTalkContinuationPrompt['localDecision']): string {
  switch (value) {
    case 'approved':
      return '已同意';
    case 'rejected':
      return '已拒绝';
    case 'pending':
    default:
      return '等待中';
  }
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

function clampToolApprovalSidebarWidth(value: number): number {
  return Math.min(TOOL_APPROVAL_SIDEBAR_MAX_WIDTH, Math.max(TOOL_APPROVAL_SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function getToolApprovalDisplayLabel(targetLabel: string): string {
  const trimmed = targetLabel.trim();
  if (!trimmed) {
    return 'workspace';
  }

  const normalized = trimmed.replace(/\\/g, '/');
  if (!normalized.includes('/')) {
    return trimmed;
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

function getToolApprovalDisplaySummary(summary: string, targetLabel: string, displayTargetLabel: string): string {
  if (isToolApprovalFileTarget(targetLabel)) {
    return '';
  }

  if (!summary.includes(targetLabel) || displayTargetLabel === targetLabel) {
    return summary;
  }

  return summary.replaceAll(targetLabel, displayTargetLabel);
}

function truncateToolApprovalText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 2)).trimEnd()}..`;
}

function isToolApprovalFileTarget(targetLabel: string): boolean {
  const trimmed = targetLabel.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return true;
  }

  return /\.[A-Za-z0-9_-]+$/.test(trimmed);
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
  sessions: AgentSessionSummary[];
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
  onSelectSession: (session: AgentSessionSummary) => void;
  onInspectSession: (session: AgentSessionSummary) => void;
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
      {args.isNewSessionComposerOpen ? (
        <div className="session-panel-actions">
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
        </div>
      ) : null}
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
              <p className="session-card-meta">{session.messageCount} messages · {session.selectedMemoryCount} selected memories</p>
              <p className="session-card-preview">{getSessionPreview(session)}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function renderSessionInspectorModal(args: {
  session: AgentSessionSummary;
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
            <p className="session-panel-copy">{formatSessionState(args.session.status)} · {args.session.messageCount} messages · Updated {formatTimestamp(args.session.updatedAt)}</p>
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
  actions: {
    readonly onOpenFileChange: (fileChange: RendererFileChange) => void;
    readonly answerTimerNowMs: number;
  },
) {
  if ('role' in entry) {
    if (entry.role === 'assistant') {
      const handoff = parseTaskHandoff(entry.content);
      const thinkingDuration = entry.startedAtMs === undefined
        ? null
        : formatThinkingDuration(entry.startedAtMs, entry.completedAtMs ?? actions.answerTimerNowMs);
      return (
        <article key={entry.id} className={`chat-entry chat-entry-answer chat-entry-answer-${entry.blockType} ${entry.status === 'pending' ? 'chat-entry-answer-pending' : ''}`}>
          <div className="chat-entry-header">
            <header className="chat-entry-label">Pueblo</header>
            {thinkingDuration ? <span className="chat-entry-thinking-duration">{thinkingDuration}</span> : null}
          </div>
          {renderAnswerContent(entry.content, handoff)}
          {renderFileChangeSummary(entry.fileChanges, actions.onOpenFileChange)}
          {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace, { scrollable: entry.blockType === 'task-result' })}
        </article>
      );
    }

    return (
      <article key={entry.id} className="chat-entry chat-entry-user">
        <header className="chat-entry-label">You</header>
        <p className="chat-entry-body">{entry.content}</p>
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace, { scrollable: false })}
      </article>
    );
  }

  if (entry.type === 'tool-result' && entry.execCommand) {
    return (
      <div key={entry.id} className="output-block-stack">
        <ExecCommandBlock entryId={entry.id} execCommand={entry.execCommand} content={entry.content} collapsed={entry.collapsed} />
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace, { scrollable: false })}
      </div>
    );
  }

  if (entry.collapsed) {
    return (
      <div key={entry.id} className="output-block-stack">
        <details className={`output-block output-block-${entry.type}`}>
          <summary>{entry.title}</summary>
          <pre>{entry.content}</pre>
        </details>
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace, { scrollable: false })}
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
        {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace, { scrollable: entry.type === 'task-result' })}
      </article>
    );
  }

  return (
    <div key={entry.id} className="output-block-stack">
      <article className={`output-block output-block-${entry.type}`}>
        <header className="output-block-title">{entry.title}</header>
        <pre className="output-block-content">{entry.content}</pre>
      </article>
      {renderMessageTrace(`${entry.id}-messages`, entry.messageTrace, { scrollable: false })}
    </div>
  );
}

const ExecCommandBlock = React.memo(function ExecCommandBlock(args: {
  readonly entryId: string;
  readonly execCommand: RendererExecCommand;
  readonly content: string;
  readonly collapsed: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(() => !args.collapsed);
  const [hasLoadedBody, setHasLoadedBody] = useState(() => !args.collapsed);
  const argsText = args.execCommand.args.length > 0 ? args.execCommand.args.join(' ') : '(no arguments)';

  useEffect(() => {
    if (!args.collapsed) {
      setIsExpanded(true);
      setHasLoadedBody(true);
    }
  }, [args.collapsed]);

  return (
    <section className="exec-output-block" aria-label={`Command execution ${args.execCommand.command}`}>
      <button
        type="button"
        className="exec-output-trigger"
        aria-expanded={isExpanded}
        aria-controls={`${args.entryId}-exec-output`}
        onClick={() => {
          setIsExpanded((previous) => {
            const next = !previous;
            if (next) {
              setHasLoadedBody(true);
            }
            return next;
          });
        }}
      >
        <span className="exec-output-trigger-text">{args.execCommand.command}</span>
      </button>
      {hasLoadedBody && isExpanded ? (
        <div className="exec-output-body" id={`${args.entryId}-exec-output`}>
          <div className="exec-output-meta">
            <p className="exec-output-meta-row">
              <span className="exec-output-meta-label">Command</span>
              <span className="exec-output-meta-value">{args.execCommand.rawCommand}</span>
            </p>
            <p className="exec-output-meta-row">
              <span className="exec-output-meta-label">Args</span>
              <span className="exec-output-meta-value">{argsText}</span>
            </p>
          </div>
          <pre className="exec-output-content">{args.content}</pre>
        </div>
      ) : null}
    </section>
  );
});

function createTranscriptEntriesFromSession(session: Session): TranscriptEntry[] {
  return session.messageHistory
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => mapSessionMessageToTranscriptEntry(message));
}

function partitionTranscriptEntries(entries: TranscriptEntry[]): {
  readonly archivedGroups: TranscriptGroup[];
  readonly visibleEntries: TranscriptEntry[];
} {
  const groups = createTranscriptGroups(entries);
  if (groups.length <= VISIBLE_TRANSCRIPT_GROUP_LIMIT) {
    return {
      archivedGroups: [],
      visibleEntries: entries,
    };
  }

  return {
    archivedGroups: groups.slice(0, groups.length - VISIBLE_TRANSCRIPT_GROUP_LIMIT),
    visibleEntries: groups.slice(-VISIBLE_TRANSCRIPT_GROUP_LIMIT).flatMap((group) => group.entries),
  };
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
      startedAtMs: undefined,
      completedAtMs: undefined,
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

function selectLatestTodoMemory(memories: MemoryRecord[]): MemoryRecord | null {
  const todoMemories = memories
    .filter((memory) => memory.tags.includes('todo'))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));

  return todoMemories[0] ?? null;
}

function selectSelectedTodoMemory(memories: MemoryRecord[], selectedMemoryIds: string[], hasActiveWorkflow: boolean): MemoryRecord | null {
  if (!hasActiveWorkflow) {
    return null;
  }

  const todoMemories = memories
    .filter((memory) => memory.tags.includes('todo'))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));

  if (selectedMemoryIds.length === 0) {
    return todoMemories[0] ?? null;
  }

  const selectedMemoryIdSet = new Set(selectedMemoryIds);

  return todoMemories.find((memory) => selectedMemoryIdSet.has(memory.id)) ?? todoMemories[0] ?? null;
}

function extractWorkflowIdFromMemory(memory: MemoryRecord | null): string | null {
  if (!memory) {
    return null;
  }

  const workflowIdLine = memory.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('workflowId:'));

  if (!workflowIdLine) {
    return null;
  }

  const workflowId = workflowIdLine.slice('workflowId:'.length).trim();
  return workflowId.length > 0 ? workflowId : null;
}

function buildWorkflowGoalFromTodo(memory: MemoryRecord, items: WorkflowTodoItem[]): string {
  const taskSummary = items
    .slice(0, 5)
    .map((item) => item.title)
    .join('; ');
  const goal = taskSummary.length > 0
    ? `Resume the pending workflow tasks from \"${memory.title}\": ${taskSummary}`
    : `Resume the pending workflow tasks from \"${memory.title}\".`;

  return goal.length <= 320 ? goal : `${goal.slice(0, 317)}...`;
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

function getSessionPreview(session: AgentSessionSummary): string {
  return session.preview;
}

function filterSessions(sessions: AgentSessionSummary[], query: string): AgentSessionSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return sessions;
  }

  return sessions.filter((session) => {
    const haystacks = [
      session.title,
      session.preview,
    ];

    return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

function sortSessions(sessions: AgentSessionSummary[], mode: SessionSortMode): AgentSessionSummary[] {
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
    || (block.type === 'tool-result' && Boolean(block.execCommand))
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

function summarizeRendererMessageTrace(messageTrace: RendererMessageTraceStep[]): {
  readonly messageCount: number;
  readonly charCount: number;
  readonly toolCallCount: number;
} {
  let messageCount = 0;
  let charCount = 0;
  let toolCallCount = 0;

  for (const step of messageTrace) {
    messageCount += step.messageCount;
    charCount += step.charCount;

    for (const message of step.messages) {
      if (message.toolName || message.toolCallId) {
        toolCallCount += 1;
      }
    }
  }

  return {
    messageCount,
    charCount,
    toolCallCount,
  };
}

const MessageTraceMessageDetails = React.memo(function MessageTraceMessageDetails(args: {
  readonly message: RendererMessageTraceStep['messages'][number];
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <details className="message-item" open={isOpen}>
      <summary
        className="message-item-header message-item-summary"
        onClick={(event) => {
          event.preventDefault();
          setIsOpen((previous) => !previous);
        }}
      >
        <span className="message-item-role">{args.message.role}</span>
        <span className="message-item-meta">{args.message.charCount} chars</span>
        {args.message.toolName ? <span className="message-item-meta">tool={args.message.toolName}</span> : null}
        {args.message.toolCallId ? <span className="message-item-meta">call={args.message.toolCallId}</span> : null}
      </summary>
      {isOpen ? (
        <div className="message-item-details">
          <pre className="message-item-content">{args.message.content}</pre>
          {args.message.toolArgs !== undefined ? (
            <pre className="message-item-args">{JSON.stringify(args.message.toolArgs, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </details>
  );
});

const MessageTraceStepDetails = React.memo(function MessageTraceStepDetails(args: {
  readonly id: string;
  readonly step: RendererMessageTraceStep;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(() => Math.min(args.step.messages.length, MESSAGE_TRACE_INITIAL_MESSAGE_LIMIT));
  const visibleMessages = useMemo(
    () => args.step.messages.slice(0, visibleMessageCount),
    [args.step.messages, visibleMessageCount],
  );
  const hiddenMessageCount = Math.max(0, args.step.messages.length - visibleMessageCount);

  useEffect(() => {
    setVisibleMessageCount(Math.min(args.step.messages.length, MESSAGE_TRACE_INITIAL_MESSAGE_LIMIT));
  }, [args.step.messages.length]);

  return (
    <details className="message-step" open={isOpen}>
      <summary
        className="message-step-header message-step-summary"
        onClick={(event) => {
          event.preventDefault();
          setIsOpen((previous) => !previous);
        }}
      >
        <span className="message-step-title">Step {args.step.stepNumber}</span>
        <span className="message-step-meta">{args.step.messageCount} messages</span>
        <span className="message-step-meta">{args.step.charCount} chars</span>
      </summary>
      {isOpen ? (
        <div className="message-step-list">
          {visibleMessages.map((message, index) => (
            <MessageTraceMessageDetails
              key={`${args.id}-step-${args.step.stepNumber}-message-${index + 1}`}
              message={message}
            />
          ))}
          {hiddenMessageCount > 0 ? (
            <button
              type="button"
              className="provider-config-secondary message-trace-load-more"
              onClick={() => {
                setVisibleMessageCount((previous) => Math.min(args.step.messages.length, previous + MESSAGE_TRACE_MESSAGE_PAGE_SIZE));
              }}
            >
              Show next {Math.min(MESSAGE_TRACE_MESSAGE_PAGE_SIZE, hiddenMessageCount)} messages ({hiddenMessageCount} left)
            </button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
});

const MessageTraceDetails = React.memo(function MessageTraceDetails(args: {
  readonly id: string;
  readonly messageTrace: RendererMessageTraceStep[];
  readonly scrollable: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [visibleStepCount, setVisibleStepCount] = useState(() => Math.min(args.messageTrace.length, MESSAGE_TRACE_INITIAL_STEP_LIMIT));
  const traceTotals = useMemo(() => summarizeRendererMessageTrace(args.messageTrace), [args.messageTrace]);
  const visibleSteps = useMemo(
    () => args.messageTrace.slice(0, visibleStepCount),
    [args.messageTrace, visibleStepCount],
  );
  const hiddenStepCount = Math.max(0, args.messageTrace.length - visibleStepCount);

  useEffect(() => {
    setVisibleStepCount(Math.min(args.messageTrace.length, MESSAGE_TRACE_INITIAL_STEP_LIMIT));
  }, [args.messageTrace.length]);

  return (
    <details key={args.id} className={`message-details ${args.scrollable ? 'message-details-scrollable' : ''}`} open={isOpen}>
      <summary
        className="message-details-summary"
        onClick={(event) => {
          event.preventDefault();
          setIsOpen((previous) => !previous);
        }}
      >
        <span className="message-details-title">Process Info</span>
        <span className="message-details-meta">{traceTotals.messageCount} messages</span>
        <span className="message-details-meta">{args.messageTrace.length} steps</span>
        {traceTotals.toolCallCount > 0 ? <span className="message-details-meta">{traceTotals.toolCallCount} tool calls</span> : null}
        <span className="message-details-meta">{traceTotals.charCount} chars</span>
      </summary>
      {isOpen ? (
        <div className="message-trace">
          {hiddenStepCount > 0 ? (
            <p className="message-trace-summary">
              Large process traces are rendered in batches to keep the desktop renderer stable.
            </p>
          ) : null}
          {visibleSteps.map((step) => (
            <MessageTraceStepDetails key={`${args.id}-step-${step.stepNumber}`} id={args.id} step={step} />
          ))}
          {hiddenStepCount > 0 ? (
            <button
              type="button"
              className="provider-config-secondary message-trace-load-more"
              onClick={() => {
                setVisibleStepCount((previous) => Math.min(args.messageTrace.length, previous + MESSAGE_TRACE_STEP_PAGE_SIZE));
              }}
            >
              Show next {Math.min(MESSAGE_TRACE_STEP_PAGE_SIZE, hiddenStepCount)} steps ({hiddenStepCount} left)
            </button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
});

function renderMessageTrace(
  id: string,
  messageTrace: RendererMessageTraceStep[] | null | undefined,
  options: { scrollable: boolean },
) {
  if (!messageTrace || messageTrace.length === 0) {
    return null;
  }

  return <MessageTraceDetails id={id} messageTrace={messageTrace} scrollable={options.scrollable} />;
}