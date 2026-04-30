import type { CommandResult } from '../../shared/result';
import type {
  AgentProfileTemplate,
  BackgroundSummaryStatus,
  ContextCount,
  DesktopWindowSession,
  IpcInputEnvelope,
  ProviderProfile,
  RendererOutputBlock,
} from '../../shared/schema';

export interface DesktopSubmitResponse {
  readonly result: CommandResult<unknown>;
  readonly blocks: RendererOutputBlock[];
  readonly runtimeStatus: DesktopRuntimeStatus;
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
  readonly selectedPromptCount: number;
  readonly selectedMemoryCount: number;
  readonly backgroundSummaryStatus: BackgroundSummaryStatus;
  readonly availableProviders?: ProviderProfile[];
  readonly providerStatuses?: DesktopProviderStatuses;
}

export interface DesktopBridge {
  submitInput(envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  listAgentProfiles(): Promise<AgentProfileTemplate[]>;
  startAgentSession(profileId: string): Promise<DesktopRuntimeStatus>;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
  getSessionSnapshot(): Promise<DesktopWindowSession | null>;
  subscribeSession(listener: (session: DesktopWindowSession) => void): () => void;
}
