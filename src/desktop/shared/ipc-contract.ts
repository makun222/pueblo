import type { CommandResult, LoopJobStatus, LoopProgressEvent } from '../../shared/result';
import type { ProviderRequestMetrics } from '../../providers/provider-adapter';
import type {
  AgentProfileTemplate,
  AgentSessionSummary,
  BackgroundSummaryStatus,
  ContextCount,
  DesktopWindowSession,
  InputAttachmentManifest,
  IpcInputEnvelope,
  MemoryRecord,
  ProviderUsageStats,
  ProviderProfile,
  RendererFileChange,
  RendererOutputBlock,
  Session,
  WorkflowInstance,
} from '../../shared/schema';
import type { McpConnectionState, McpServerConfig } from '../../mcp/mcp-types';
export type { McpConnectionState, McpServerConfig };

export interface DesktopSubmitResponse {
  readonly result: CommandResult<unknown>;
  readonly blocks: RendererOutputBlock[];
  readonly runtimeStatus: DesktopRuntimeStatus;
  readonly tabId?: string;
}

export interface DesktopToolApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly kind: 'command' | 'file-edit' | 'other';
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
  readonly primaryText: string;
  readonly targetLabel: string;
  readonly operationLabel: string;
}

export interface DesktopToolApprovalBatch {
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: string;
  readonly requests: DesktopToolApprovalRequest[];
}

export interface DesktopToolApprovalState {
  readonly activeBatch: DesktopToolApprovalBatch | null;
  readonly activeFileReview: DesktopFileReviewRequest | null;
}

export interface DesktopToolApprovalResponse {
  readonly tabId?: string | null;
  readonly batchId: string;
  readonly decision: 'allow' | 'allow-all' | 'deny';
  readonly selectedRequestIds: string[];
}

export interface DesktopFileReviewRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
  readonly fileChange: RendererFileChange;
  readonly shadowPath: string;
}

export interface DesktopFileReviewResponse {
  readonly tabId?: string | null;
  readonly reviewId: string;
  readonly decision: 'keep' | 'discard';
}

export type DesktopMenuAction =
  // File
  | 'new-conversation'
  | 'switch-agent'
  // View
  | 'show-monitor'
  | 'show-tool-approvals'
  // Tools
  | 'configure-provider'
  // Tools — future placeholders
  | 'open-mcp-manager'
  | 'open-cron-scheduler'
  | 'open-hooks';

export interface DesktopProviderStatus {
  readonly providerId: 'github-copilot' | 'deepseek';
  readonly authState: 'configured' | 'missing' | 'invalid';
  readonly credentialSource: 'env' | 'config-file' | 'external-login' | 'windows-credential-manager';
  readonly defaultModelId: string | null;
  readonly credentialTarget: string | null;
  readonly oauthClientIdConfigured?: boolean;
  readonly baseUrl?: string | null;
}

export interface DesktopProviderStatuses {
  readonly githubCopilot: DesktopProviderStatus;
  readonly deepseek: DesktopProviderStatus;
}

export interface DesktopGenericProviderConfiguration {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly modelIds: string[];
  readonly defaultModelId: string | null;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly apiKeyConfigured: boolean;
}

export interface DesktopSaveGenericProviderConfigurationInput {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly modelIds: string[];
  readonly defaultModelId: string;
  readonly enabled: boolean;
  readonly setAsDefault: boolean;
}

export interface DesktopProviderConfigurationList {
  readonly genericOpenAIProviders: DesktopGenericProviderConfiguration[];
}

export interface DesktopWorkflowStatus {
  readonly hasActiveWorkflow: boolean;
  readonly workflowId: string | null;
  readonly workflowType: string | null;
  readonly status: WorkflowInstance['status'] | null;
  readonly activeRoundNumber: number | null;
}

export interface DesktopTalkIncomingRequest {
  readonly conversationId: string;
  readonly fromPid: number;
  readonly fromAgentProfileName: string | null;
  readonly message: string;
  readonly createdAt: string;
}

export interface DesktopTalkContinuationPrompt {
  readonly roundCount: number;
  readonly turnLimit: number;
  readonly localDecision: 'pending' | 'approved' | 'rejected';
  readonly remoteDecision: 'pending' | 'approved' | 'rejected';
}

export interface DesktopTalkActiveConversation {
  readonly conversationId: string;
  readonly peerPid: number;
  readonly peerAgentProfileName: string | null;
  readonly initiatedBy: 'local' | 'remote';
  readonly status: 'requesting' | 'active';
  readonly turnCount: number;
  readonly turnLimit: number;
  readonly continuationPrompt: DesktopTalkContinuationPrompt | null;
}

export interface DesktopTalkState {
  readonly localPid: number | null;
  readonly incomingRequest: DesktopTalkIncomingRequest | null;
  readonly activeConversation: DesktopTalkActiveConversation | null;
}

export interface DesktopTalkRequestResponse {
  readonly tabId?: string | null;
  readonly conversationId: string;
  readonly decision: 'accept' | 'reject';
}

export interface DesktopTalkContinuationResponse {
  readonly tabId?: string | null;
  readonly conversationId: string;
  readonly decision: 'continue' | 'end';
}

export interface DesktopRuntimeStatus {
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly agentProfileId: string | null;
  readonly agentProfileName: string | null;
  readonly agentInstanceId: string | null;
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly desktopProcessId?: number | null;
  readonly workspace?: string | null;
  readonly activeSessionId: string | null;
  readonly contextCount: ContextCount;
  readonly selectedStepSummaryCount?: number;
  readonly compactContextMode?: boolean;
  readonly modelMessageCount: number;
  readonly modelMessageCharCount: number;
  readonly providerUsageStats?: ProviderUsageStats;
  readonly providerRequestMetrics?: ProviderRequestMetrics | null;
  readonly selectedPromptCount: number;
  readonly selectedMemoryCount: number;
  readonly backgroundSummaryStatus: BackgroundSummaryStatus;
  readonly availableProviders?: ProviderProfile[];
  readonly providerStatuses?: DesktopProviderStatuses;
  readonly workflow?: DesktopWorkflowStatus;
}

export interface DesktopSessionSelectionResponse {
  readonly runtimeStatus: DesktopRuntimeStatus;
  readonly session: Session | null;
  readonly tabId?: string;
}

export interface DesktopAgentTab {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runtimeStatus: DesktopRuntimeStatus;
  readonly isSubmitting: boolean;
  readonly hasPendingToolApproval: boolean;
  readonly hasPendingFileReview: boolean;
}

export interface DesktopCreateTabInput {
  readonly profileId?: string | null;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly workspace?: string | null;
}

export interface DesktopUpdateTabInput extends DesktopCreateTabInput {
  readonly tabId: string;
}

export interface DesktopCloseTabResult {
  readonly closedTabId: string;
  readonly fallbackTabId: string | null;
  readonly tabs: DesktopAgentTab[];
}

export interface DesktopTabSubmitRequest {
  readonly tabId?: string | null;
  readonly envelope: IpcInputEnvelope;
}

export interface DesktopTabAgentSessionRequest {
  readonly tabId?: string | null;
  readonly profileId: string;
}

export interface DesktopTabInputFilesRequest {
  readonly tabId?: string | null;
  readonly sessionId: string | null;
}

export interface DesktopTabEntityRequest {
  readonly tabId?: string | null;
  readonly sessionId: string;
}

export interface DesktopTabAgentSessionsRequest {
  readonly tabId?: string | null;
  readonly agentInstanceId: string;
}

export interface DesktopTabOutputEvent {
  readonly tabId: string;
  readonly block: RendererOutputBlock;
}

export interface DesktopTabToolApprovalStateEvent {
  readonly tabId: string;
  readonly state: DesktopToolApprovalState;
}

// ---------------------------------------------------------------------------
// Loop job IPC types (Phase 2+)
// ---------------------------------------------------------------------------

/** Progress event sent main→renderer after each loop round completes. */
export interface DesktopLoopJobProgress {
  readonly jobId: string;
  readonly event: LoopProgressEvent;
  readonly status: LoopJobStatus;
}

export interface DesktopBridge {
  listDesktopTabs(): Promise<DesktopAgentTab[]>;
  createDesktopTab(input?: DesktopCreateTabInput): Promise<DesktopAgentTab>;
  updateDesktopTab(input: DesktopUpdateTabInput): Promise<DesktopAgentTab>;
  closeDesktopTab(tabId: string): Promise<DesktopCloseTabResult>;
  onDesktopTabsChanged(listener: (tabs: DesktopAgentTab[]) => void): () => void;
  onTabOutput(listener: (event: DesktopTabOutputEvent) => void): () => void;
  onTabToolApprovalState(listener: (event: DesktopTabToolApprovalStateEvent) => void): () => void;
  listProviderConfigurations(): Promise<DesktopProviderConfigurationList>;
  saveGenericProviderConfiguration(input: DesktopSaveGenericProviderConfigurationInput): Promise<DesktopGenericProviderConfiguration>;
  removeGenericProviderConfiguration(providerId: string): Promise<void>;
  submitInput(envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse>;
  submitInput(request: DesktopTabSubmitRequest): Promise<DesktopSubmitResponse>;
  cancelActiveSubmit(): Promise<void>;
  cancelActiveSubmit(tabId: string): Promise<void>;
  selectInputFiles(sessionId: string | null): Promise<InputAttachmentManifest[]>;
  selectInputFiles(request: DesktopTabInputFilesRequest): Promise<InputAttachmentManifest[]>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  getRuntimeStatus(tabId: string): Promise<DesktopRuntimeStatus>;
  getToolApprovalState(): Promise<DesktopToolApprovalState>;
  getToolApprovalState(tabId: string): Promise<DesktopToolApprovalState>;
  getTalkState(): Promise<DesktopTalkState>;
  respondToolApproval(response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState>;
  respondFileReview(response: DesktopFileReviewResponse): Promise<DesktopToolApprovalState>;
  respondTalkRequest(response: DesktopTalkRequestResponse): Promise<DesktopTalkState>;
  respondTalkContinuation(response: DesktopTalkContinuationResponse): Promise<DesktopTalkState>;
  listAgentProfiles(): Promise<AgentProfileTemplate[]>;
  startAgentSession(profileId: string): Promise<DesktopRuntimeStatus>;
  startAgentSession(request: DesktopTabAgentSessionRequest): Promise<DesktopRuntimeStatus>;
  listAgentSessions(agentInstanceId: string): Promise<AgentSessionSummary[]>;
  listAgentSessions(request: DesktopTabAgentSessionsRequest): Promise<AgentSessionSummary[]>;
  getSession(sessionId: string): Promise<Session | null>;
  getSession(request: DesktopTabEntityRequest): Promise<Session | null>;
  listSessionMemories(sessionId: string): Promise<MemoryRecord[]>;
  listSessionMemories(request: DesktopTabEntityRequest): Promise<MemoryRecord[]>;
  selectSession(sessionId: string): Promise<DesktopSessionSelectionResponse>;
  selectSession(request: DesktopTabEntityRequest): Promise<DesktopSessionSelectionResponse>;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
  onToolApprovalState(listener: (state: DesktopToolApprovalState) => void): () => void;
  onTalkState(listener: (state: DesktopTalkState) => void): () => void;
  getSessionSnapshot(): Promise<DesktopWindowSession | null>;
  subscribeSession(listener: (session: DesktopWindowSession) => void): () => void;

  // -------------------------------------------------------------------------
  // Loop / progress (Phase 2+)
  // -------------------------------------------------------------------------

  /** Start a new loop job (renderer → main, returns jobId). */
  'loop:start'(config: {
    modelId: string;
    goal: string;
    inputContextSummary: string;
    totalRounds: number;
    userId?: string;
  }): Promise<{ jobId: string }>;

  /** Cancel a running loop job. */
  'loop:cancel'(jobId: string): Promise<{ ok: boolean }>;

  /** Pause a running loop job. */
  'loop:pause'(jobId: string): Promise<{ ok: boolean }>;
  /** Resume a paused loop job. */
  'loop:resume'(jobId: string): Promise<{ ok: boolean }>;

  /** Listen for per-round progress events (main → renderer). */
  'loop:job-progress'(listener: (progress: DesktopLoopJobProgress) => void): () => void;

  /** Focus / open the Monitor window. */
  focusMonitor(): Promise<void>;

  // ──────────────────────────────────────────────
  // MCP (Model Context Protocol) server management
  // ──────────────────────────────────────────────

  /** List all configured MCP servers. */
  mcpListServers(): Promise<McpServerConfig[]>;

  /** Add a new MCP server. */
  mcpAddServer(config: McpServerConfig): Promise<McpServerConfig>;

  /** Remove an MCP server by name. */
  mcpRemoveServer(serverName: string): Promise<void>;

  /** Update an existing MCP server. */
  mcpUpdateServer(config: McpServerConfig): Promise<McpServerConfig>;

  /** Restart an MCP server by name. */
  mcpRestartServer(serverName: string): Promise<void>;

  /** Test connection to an MCP server. */
  mcpTestConnection(config: McpServerConfig): Promise<{ success: boolean; toolCount: number; error?: string }>;

  /** Get connection states for all MCP servers. */
  mcpGetConnectionStates(): Promise<McpConnectionState[]>;

  /** List credential keys (server names that have stored API keys). */
  mcpListCredentials(): Promise<string[]>;

  /** Save a credential value. */
  mcpSaveCredential(key: string, value: string): Promise<void>;

  /** Delete a credential by key. */
  mcpDeleteCredential(key: string): Promise<void>;
}
