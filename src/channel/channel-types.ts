// ---------------------------------------------------------------------------
// Channel Types — Type definitions for external channel integration
// ---------------------------------------------------------------------------

// ─── Channel Configuration ────────────────────────────────────────────────

/** Supported external channel kinds */
export type ChannelKind = 'feishu';

/** Transport mechanism used to receive inbound events */
export type ChannelTransport = 'long-connection' | 'webhook';

/** Describes a single channel entry (stored in channels.json) */
export interface ChannelConfig {
  /** Unique identifier for this channel (e.g. "feishu-default") */
  id: string;
  /** Channel kind, determines which adapter to instantiate */
  kind: ChannelKind;
  /** Human-readable label shown in UI */
  name: string;
  /** Whether this channel is enabled */
  enabled: boolean;
  /** Transport used to receive inbound events */
  transport: ChannelTransport;
  /** Kind-specific options (feishu: appId / verificationToken / endpoint overrides) */
  options: Record<string, unknown>;
  /** Credential lookup key, e.g. "pueblo:feishu:<id>" */
  credentialTarget?: string;
  /** Discovery source tag for UI grouping */
  source?: 'manual' | 'builtin';
}

/** Full persisted configuration shape */
export interface ChannelsConfig {
  channels: ChannelConfig[];
}

// ─── Connection State ────────────────────────────────────────────────────

/** Runtime status of a single channel connection */
export type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Snapshot of a channel connection's runtime state */
export interface ChannelConnectionState {
  channelId: string;
  kind: ChannelKind;
  status: ChannelConnectionStatus;
  lastError: string | null;
  connectedAt: number | null;
}

// ─── Unified Message Model ────────────────────────────────────────────────

/** Inbound message from an external platform user */
export interface InboundMessage {
  channelId: string;
  /** External conversation id (feishu chat_id) */
  externalConversationId: string;
  externalMessageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  /** Raw event payload for adapter-specific debugging */
  raw: unknown;
  receivedAt: number;
}

/** Outbound reply to send to an external platform conversation */
export interface OutboundMessage {
  externalConversationId: string;
  text?: string;
  /** Channel-specific card payload (feishu interactive card) */
  card?: unknown;
  /** External message id to reply to (threaded reply) */
  replyToMessageId?: string;
}

/** Result of an outbound send attempt */
export interface ChannelSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
}

/** Result of a connection test (no real message sent) */
export interface ChannelTestResult {
  ok: boolean;
  error?: string;
}

// ─── Channel Adapter Interface ────────────────────────────────────────────

/** Capability flags describing what an adapter supports */
export interface ChannelCapabilities {
  inboundEvents: boolean;
  outboundReply: boolean;
  card: boolean;
  longConnection: boolean;
}

/** Callbacks the adapter invokes to push inbound events / status to the service */
export interface ChannelEventHandler {
  onMessage(message: InboundMessage): void;
  onError(error: Error): void;
  onStatusChange(state: ChannelConnectionState): void;
}

/** Adapter contract for a specific external channel implementation */
export interface ChannelAdapter {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  readonly state: ChannelConnectionState;
  connect(config: ChannelConfig, handler: ChannelEventHandler): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<ChannelSendResult>;
  testConnection(config: ChannelConfig): Promise<ChannelTestResult>;
  dispose(): void;
}

/** Factory that builds an adapter instance for a given channel config */
export type ChannelAdapterFactory = (config: ChannelConfig) => ChannelAdapter;

// ─── Session Mapping ──────────────────────────────────────────────────────

/**
 * Mapping from an external conversation to a pueblo session id, plus the
 * channel-side selection state (which agent / session the conversation is on).
 */
export interface ChannelSessionMapping {
  /** "<channelId>::<externalConversationId>" */
  key: string;
  channelId: string;
  externalConversationId: string;
  /** Session created for / first used by this conversation */
  sessionId: string;
  /** Agent instance the conversation is currently bound to (null = runtime default) */
  agentInstanceId?: string | null;
  /** Session the conversation is currently talking to (falls back to sessionId) */
  selectedSessionId?: string | null;
  createdAt: number;
  updatedAt?: number;
}

// ─── Channel Control Surface ──────────────────────────────────────────────
// Channels are a "window" onto the CLI runtime: selecting an agent/session
// from a channel mutates the same runtime selection the CLI uses.

export interface ChannelAgentOption {
  /** Agent instance id */
  id: string;
  profileId: string;
  /** Display name (instance/profile name) */
  name: string;
  isActive?: boolean;
}

/** Result of selecting an agent: the instance plus the session it landed on */
export interface ChannelAgentSelection {
  agent: ChannelAgentOption;
  session: ChannelSessionOption | null;
}

export interface ChannelSessionOption {
  id: string;
  title: string;
  agentInstanceId: string | null;
  status: 'active' | 'archived' | 'deleted';
  updatedAt: string;
}

export interface ChannelSessionStatus {
  sessionId: string;
  title?: string | null;
  agentInstanceId?: string | null;
  sessionStatus?: 'active' | 'archived' | 'deleted' | null;
  /** Latest AgentTask status for the session, null when no task ran yet */
  taskStatus: 'pending' | 'running' | 'completed' | 'failed' | null;
  goal?: string | null;
  outputSummary?: string | null;
  updatedAt?: string | null;
}

// ─── Tool Approval Surface ────────────────────────────────────────────────
// While a turn is running the host may pause on a tool-approval batch. The
// batch is surfaced to every terminal bound to the session (desktop UI + all
// Feishu conversations), and either side may answer it (first answer wins).

/** One pending tool-approval request as seen by a channel command. */
export interface ChannelApprovalRequest {
  /** Request/toolCall id used to answer this specific request. */
  id: string;
  toolName: string;
  /** Coarse category, mirrors the desktop UI badge (command/file-edit/other). */
  kind: string;
  title: string;
  summary: string;
}

/** Snapshot of the active tool-approval batch, if any. */
export interface ChannelApprovalPrompt {
  batchId: string;
  /** Session the batch belongs to (the channel window's active session). */
  sessionId: string | null;
  requests: ChannelApprovalRequest[];
}

export type ChannelApprovalDecision = 'allow' | 'allow-all' | 'deny';

export interface ChannelApprovalResult {
  ok: boolean;
  decision: ChannelApprovalDecision;
  /** Request ids this decision applied to. */
  affectedIds: string[];
  /** Human-readable confirmation for the channel reply. */
  message: string;
}

/**
 * Host-provided control surface. Implemented by the CLI/Desktop host so a
 * channel command actually operates the underlying (CLI) runtime.
 */
export interface ChannelControl {
  /**
   * Optional hook to refresh any host-side snapshot before a control call reads
   * it. Desktop keeps an async memory snapshot; calling this keeps `/agents`,
   * `/sessions` and `/status` consistent without making the sync readers async.
   */
  refresh?(): Promise<void>;
  /**
   * True while the host runtime is busy with a CLI-originated turn.
   * Channel input must NOT preempt it (dropped for now, queued later).
   */
  isRuntimeBusy?(): boolean;
  listAgents(): ChannelAgentOption[];
  /** Resolve a reference (number/id/profile name) to an agent instance, creating it when absent. */
  selectAgent(ref: string): Promise<ChannelAgentSelection>;
  listSessions(agentInstanceId?: string | null): ChannelSessionOption[];
  createSession(title: string, agentInstanceId: string | null): Promise<ChannelSessionOption>;
  selectSession(sessionId: string): Promise<ChannelSessionOption>;
  /** Read-only snapshot; must not disturb any in-flight task. */
  getSessionStatus(sessionId: string): ChannelSessionStatus;
  /** Clear channel binding for the conversation and fall back to defaults. */
  reset?(): Promise<void>;

  /**
   * Current tool-approval batch awaiting a decision, or null. Synchronous so
   * the command router can render `/pending` without extra async plumbing.
   */
  pendingApproval?(): ChannelApprovalPrompt | null;
  /**
   * Answer the active tool-approval batch. `requestId` selects a single request
   * (decision 'allow'); omit it to answer the whole batch ('allow-all'/'deny').
   */
  respondApproval?(
    decision: ChannelApprovalDecision,
    requestId?: string,
  ): Promise<ChannelApprovalResult>;
}

/** Persisted session mapping file shape */
export interface ChannelSessionsStore {
  sessions: ChannelSessionMapping[];
}

// ─── IPC Types ────────────────────────────────────────────────────────────

export interface ChannelIpcListRequest {
  type: 'channel:list';
}
export interface ChannelIpcListResponse {
  channels: ChannelConfig[];
}
export interface ChannelIpcSaveRequest {
  type: 'channel:save';
  config: ChannelConfig;
}
export interface ChannelIpcSaveResponse {
  success: boolean;
  error?: string;
}
export interface ChannelIpcDeleteRequest {
  type: 'channel:delete';
  channelId: string;
}
export interface ChannelIpcDeleteResponse {
  success: boolean;
  error?: string;
}
export interface ChannelIpcTestRequest {
  type: 'channel:test';
  config: ChannelConfig;
}
export interface ChannelIpcTestResponse {
  ok: boolean;
  error?: string;
}
export interface ChannelIpcStartRequest {
  type: 'channel:start';
  channelId: string;
}
export interface ChannelIpcStartResponse {
  success: boolean;
  error?: string;
}
export interface ChannelIpcStopRequest {
  type: 'channel:stop';
  channelId: string;
}
export interface ChannelIpcStopResponse {
  success: boolean;
  error?: string;
}
export interface ChannelIpcStatusRequest {
  type: 'channel:status';
}
export interface ChannelIpcStatusResponse {
  states: ChannelConnectionState[];
}

export type ChannelIpcRequest =
  | ChannelIpcListRequest
  | ChannelIpcSaveRequest
  | ChannelIpcDeleteRequest
  | ChannelIpcTestRequest
  | ChannelIpcStartRequest
  | ChannelIpcStopRequest
  | ChannelIpcStatusRequest;

export type ChannelIpcResponse =
  | ChannelIpcListResponse
  | ChannelIpcSaveResponse
  | ChannelIpcDeleteResponse
  | ChannelIpcTestResponse
  | ChannelIpcStartResponse
  | ChannelIpcStopResponse
  | ChannelIpcStatusResponse;
