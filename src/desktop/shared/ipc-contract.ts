import type { CommandResult } from '../../shared/result';
import type {
  AgentProfileTemplate,
  BackgroundSummaryStatus,
  ContextCount,
  DesktopWindowSession,
  IpcInputEnvelope,
  RendererOutputBlock,
} from '../../shared/schema';

export interface DesktopSubmitResponse {
  readonly result: CommandResult<unknown>;
  readonly blocks: RendererOutputBlock[];
  readonly runtimeStatus: DesktopRuntimeStatus;
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
}

export interface DesktopBridge {
  submitInput(envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  listAgentProfiles(): Promise<AgentProfileTemplate[]>;
  startAgentSession(profileId: string): Promise<DesktopRuntimeStatus>;
  getSessionSnapshot(): Promise<DesktopWindowSession | null>;
  subscribeSession(listener: (session: DesktopWindowSession) => void): () => void;
}
