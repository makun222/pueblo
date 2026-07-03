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

/** Mapping from an external conversation to a pueblo session id */
export interface ChannelSessionMapping {
  /** "<channelId>::<externalConversationId>" */
  key: string;
  channelId: string;
  externalConversationId: string;
  sessionId: string;
  createdAt: number;
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
