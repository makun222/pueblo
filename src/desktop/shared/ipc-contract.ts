import type { CommandResult } from '../../shared/result';
import type {
  AgentProfileTemplate,
  BackgroundSummaryStatus,
  ContextCount,
  DesktopWindowSession,
  IpcInputEnvelope,
  MemoryRecord,
  ProviderUsageStats,
  ProviderProfile,
  RendererOutputBlock,
  Session,
} from '../../shared/schema';

export interface DesktopSubmitResponse {
  readonly result: CommandResult<unknown>;
  readonly blocks: RendererOutputBlock[];
  readonly runtimeStatus: DesktopRuntimeStatus;
}

export interface DesktopToolApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
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
}

export interface DesktopToolApprovalResponse {
  readonly batchId: string;
  readonly decision: 'allow' | 'deny';
  readonly selectedRequestIds: string[];
}

export type DesktopMenuAction = 'open-provider-config' | 'open-agent-picker';

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

export interface DesktopRuntimeStatus {
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly agentProfileId: string | null;
  readonly agentProfileName: string | null;
  readonly agentInstanceId: string | null;
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly activeSessionId: string | null;
  readonly contextCount: ContextCount;
  readonly modelMessageCount: number;
  readonly modelMessageCharCount: number;
  readonly providerUsageStats?: ProviderUsageStats;
  readonly selectedPromptCount: number;
  readonly selectedMemoryCount: number;
  readonly backgroundSummaryStatus: BackgroundSummaryStatus;
  readonly availableProviders?: ProviderProfile[];
  readonly providerStatuses?: DesktopProviderStatuses;
}

export interface DesktopSessionSelectionResponse {
  readonly runtimeStatus: DesktopRuntimeStatus;
  readonly session: Session | null;
}

export interface DesktopBridge {
  submitInput(envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  getToolApprovalState(): Promise<DesktopToolApprovalState>;
  respondToolApproval(response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState>;
  listAgentProfiles(): Promise<AgentProfileTemplate[]>;
  startAgentSession(profileId: string): Promise<DesktopRuntimeStatus>;
  listAgentSessions(agentInstanceId: string): Promise<Session[]>;
  listSessionMemories(sessionId: string): Promise<MemoryRecord[]>;
  selectSession(sessionId: string): Promise<DesktopSessionSelectionResponse>;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
  onToolApprovalState(listener: (state: DesktopToolApprovalState) => void): () => void;
  getSessionSnapshot(): Promise<DesktopWindowSession | null>;
  subscribeSession(listener: (session: DesktopWindowSession) => void): () => void;
}
