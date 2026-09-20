import path from 'node:path';
import { createRuntimeCoordinator } from '../../app/runtime';
import type {
  RunAgentTaskInput,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../../agent/task-runner';
import type { RunRoundFn } from '../../agent/loop-runner';
import { createCliDependencies, type CliDependencies } from '../../cli/index';
import { routeInput } from '../../commands/input-router';
import type { AppConfig } from '../../shared/config';
import { createOutputBlock, createResultBlocks, extractTaskOutputSummaryText, successResult } from '../../shared/result';
import { ipcInputEnvelopeSchema, type IpcInputEnvelope, type RendererOutputBlock } from '../../shared/schema';
import { createTaskCancellationError, isTaskCancellationError } from '../../shared/task-cancellation';
import type { EditReviewRequest } from '../../tools/edit-tool';
import type { McpClientManager } from '../../mcp/mcp-client';
import type { AppWindow } from './app-window';
import type { DesktopLoopJobManager } from './loop-job-manager';
import type { LoopConfig } from '../../agent/loop-runner';
import type {
  DesktopAgentTab,
  DesktopCloseTabResult,
  DesktopCreateTabInput,
  DesktopFileReviewRequest,
  DesktopFileReviewResponse,
  DesktopGenericProviderConfiguration,
  DesktopProviderConfigurationList,
  DesktopRuntimeStatus,
  DesktopSaveGenericProviderConfigurationInput,
  DesktopSessionSelectionResponse,
  DesktopSubmitResponse,
  DesktopToolApprovalBatch,
  DesktopToolApprovalRequest,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
  DesktopUpdateTabInput,
} from '../shared/ipc-contract';

interface PendingToolApprovalBatch {
  readonly batch: DesktopToolApprovalBatch;
  readonly resolve: (decisions: readonly ToolApprovalDecision[]) => void;
  readonly reject: (error: Error) => void;
}

interface QueuedToolApproval {
  readonly requests: readonly ToolApprovalRequest[];
  readonly resolve: (decisions: readonly ToolApprovalDecision[]) => void;
  readonly reject: (error: Error) => void;
}

interface PendingFileReview {
  readonly request: DesktopFileReviewRequest;
  readonly resolve: (decision: 'keep' | 'discard') => void;
  readonly reject: (error: Error) => void;
}

interface CliProviderConfigurationEntry {
  readonly providerId?: unknown;
  readonly id?: unknown;
  readonly providerType?: unknown;
  readonly type?: unknown;
  readonly displayName?: unknown;
  readonly name?: unknown;
  readonly baseUrl?: unknown;
  readonly modelIds?: unknown;
  readonly models?: unknown;
  readonly defaultModelId?: unknown;
  readonly enabled?: unknown;
  readonly isDefault?: unknown;
  readonly default?: unknown;
  readonly hasApiKey?: unknown;
  readonly apiKeyConfigured?: unknown;
  readonly apiKey?: unknown;
}

interface DesktopTabRuntimeOptions {
  readonly tabId: string;
  readonly config: AppConfig;
  readonly initialWorkspace?: string | null;
  readonly loopJobManager?: DesktopLoopJobManager;
  readonly appWindow?: AppWindow;
  readonly mcpClientManager?: McpClientManager;
  readonly onOutput: (tabId: string, block: RendererOutputBlock) => void;
  readonly onToolApprovalState: (tabId: string, state: DesktopToolApprovalState) => void;
}

interface DesktopTabRuntimeInitialization {
  readonly profileId: string | null;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
}

class DesktopTabRuntime {
  private readonly cli: CliDependencies;
  private readonly runtime;
  private readonly createdAt = new Date().toISOString();
  private updatedAt = this.createdAt;
  private readonly activeSubmitControllers = new Set<AbortController>();
  private activeToolApprovalBatch: PendingToolApprovalBatch | null = null;
  private readonly toolApprovalQueue: QueuedToolApproval[] = [];
  private activeFileReview: PendingFileReview | null = null;
  private lastRuntimeStatus: DesktopRuntimeStatus | null = null;
  private readyPromise: Promise<void> = Promise.resolve();
  private hydrated = false;
  private cleanedUp = false;
  private readonly disposeRuntimeListener: () => void;

  constructor(private readonly options: DesktopTabRuntimeOptions) {
    this.cli = createCliDependencies(options.config, {
      deferAgentSelection: true,
      initialWorkspace: options.initialWorkspace ?? null,
      mcpClientManager: options.mcpClientManager,
    });
    this.runtime = createRuntimeCoordinator({
      config: options.config,
      submitInput: this.cli.submitInput,
    });

    this.cli.setToolApprovalBatchHandler(async (requests) => new Promise<readonly ToolApprovalDecision[]>((resolve, reject) => {
      if (this.activeToolApprovalBatch) {
        this.toolApprovalQueue.push({ requests, resolve, reject });
        return;
      }
      this.activateToolApprovalBatch(requests, resolve, reject);
    }));

    this.cli.setToolApprovalHandler(null);
    this.cli.setFileReviewHandler(async (request) => new Promise<'keep' | 'discard'>((resolve, reject) => {
      if (this.activeFileReview) {
        reject(new Error('A file review is already pending in the sidebar.'));
        return;
      }

      this.activeFileReview = {
        request: mapFileReviewRequest(request),
        resolve: (decision) => {
          this.activeFileReview = null;
          this.publishToolApprovalState();
          resolve(decision);
        },
        reject: (error) => {
          this.activeFileReview = null;
          this.publishToolApprovalState();
          reject(error);
        },
      };
      this.publishToolApprovalState();
    }));

    this.cli.setProgressReporter((update) => {
      this.options.onOutput(this.options.tabId, createOutputBlock({
        type: 'system',
        title: update.title,
        content: update.message,
        sourceRefs: [],
      }));
    });

    this.disposeRuntimeListener = this.runtime.onMessage((message) => {
      this.options.onOutput(this.options.tabId, message.block);
    });
  }

  hydrate(input: DesktopTabRuntimeInitialization): Promise<void> {
    if (this.hydrated) {
      return this.readyPromise;
    }

    this.hydrated = true;
    this.readyPromise = this.initialize(input);
    return this.readyPromise;
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  listAgentProfiles() {
    return this.cli.listAgentProfiles();
  }

  async listAgentInstances() {
    await this.ready();
    return this.cli.listAgentInstances();
  }

  async readSessionTaskStatus(sessionId: string) {
    await this.ready();
    return this.cli.readSessionTaskStatus(sessionId);
  }

  async createSession(title: string, agentInstanceId: string | null) {
    await this.ready();
    const session = this.cli.createSession(title, agentInstanceId);
    await this.refreshRuntimeStatus();
    return session;
  }

  async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    await this.ready();
    return this.refreshRuntimeStatus();
  }

  async getTabState(): Promise<DesktopAgentTab> {
    const runtimeStatus = await this.getRuntimeStatus();
    return {
      id: this.options.tabId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      runtimeStatus,
      isSubmitting: this.activeSubmitControllers.size > 0,
      hasPendingToolApproval: this.activeToolApprovalBatch !== null,
      hasPendingFileReview: this.activeFileReview !== null,
    };
  }

  getToolApprovalState(): DesktopToolApprovalState {
    return resolveToolApprovalState(this.activeToolApprovalBatch, this.activeFileReview);
  }

  /**
   * Last known active session, from the cached runtime status. Returns without
   * awaiting `ready()`/CLI resolution so callers that must not yield (the
   * channel approval fan-out) can read it synchronously.
   */
  getCachedActiveSessionId(): string | null {
    return this.lastRuntimeStatus?.activeSessionId ?? null;
  }

  async startAgentSession(profileId: string): Promise<DesktopRuntimeStatus> {
    await this.ready();
    await this.cli.startAgentSession(profileId);
    return this.refreshRuntimeStatus();
  }

  async setWorkspaceRoot(workspacePath: string): Promise<DesktopRuntimeStatus> {
    await this.ready();
    await this.cli.setWorkspaceRoot(workspacePath);
    return this.refreshRuntimeStatus();
  }

  async setProviderSelection(providerId: string, modelId?: string | null): Promise<DesktopRuntimeStatus> {
    await this.ready();
    await this.cli.setProviderSelection(providerId, modelId);
    return this.refreshRuntimeStatus();
  }

  async listProviderConfigurations(): Promise<DesktopProviderConfigurationList> {
    await this.ready();
    const entries = await this.cli.listProviderConfigurations();
    return {
      genericOpenAIProviders: sanitizeGenericProviderConfigurations(entries),
    };
  }

  async saveGenericProviderConfiguration(
    input: DesktopSaveGenericProviderConfigurationInput,
  ): Promise<DesktopProviderConfigurationList> {
    await this.ready();
    this.cli.saveGenericProviderConfiguration(normalizeGenericProviderInput(input));
    return this.listProviderConfigurations();
  }

  async removeGenericProviderConfiguration(providerId: string): Promise<void> {
    await this.ready();
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      throw new Error('Provider id is required.');
    }
    this.cli.removeGenericProviderConfiguration(normalizedProviderId);
  }

  async listAgentSessions(agentInstanceId: string) {
    await this.ready();
    return this.cli.listAgentSessions(agentInstanceId);
  }

  async getSession(sessionId: string) {
    await this.ready();
    return this.cli.getSession(sessionId);
  }

  async listSessionMemories(sessionId: string) {
    await this.ready();
    return this.cli.listSessionMemories(sessionId);
  }

  async selectSession(sessionId: string): Promise<DesktopSessionSelectionResponse> {
    await this.ready();
    const response = await this.cli.selectSession(sessionId);
    await this.refreshRuntimeStatus();
    return {
      ...response,
      tabId: this.options.tabId,
    };
  }

  async submitInput(envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse> {
    const submitController = new AbortController();
    this.activeSubmitControllers.add(submitController);

    try {
      await this.ready();
      const currentRuntimeStatus = await this.refreshRuntimeStatus();
      if (!currentRuntimeStatus.agentProfileId) {
        throw new Error(`Desktop tab "${this.options.tabId}" does not have an assigned agent profile.`);
      }
      const parsedEnvelope = ipcInputEnvelopeSchema.parse({
        ...envelope,
        attachments: envelope.attachments ?? [],
      });

      if (parsedEnvelope.inputText.trim().startsWith('/loop')) {
        return this.startLoopJobFromInput(parsedEnvelope);
      }

      const { result, blocks, runtimeStatus } = await this.executeInput(parsedEnvelope, submitController.signal);
      return {
        result,
        blocks,
        runtimeStatus,
        tabId: this.options.tabId,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) {
        throw error;
      }

      this.options.onOutput(this.options.tabId, createOutputBlock({
        type: 'error',
        title: 'Input Processing Error',
        content: error instanceof Error ? error.message : 'Unknown error',
        sourceRefs: [],
      }));
      throw error;
    } finally {
      this.activeSubmitControllers.delete(submitController);
    }
  }

  async respondToolApproval(response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState> {
    if (!this.activeToolApprovalBatch?.batch) {
      throw new Error('No tool approval batch is pending.');
    }

    const batch = this.activeToolApprovalBatch.batch;
    if (response.batchId !== batch.id) {
      throw new Error('Tool approval batch is stale.');
    }

    const decisions = response.decision === 'deny'
      ? batch.requests.map(() => 'deny' as const)
      : buildApprovalDecisions(batch, response.selectedRequestIds, response.decision);

    this.activeToolApprovalBatch.resolve(decisions);
    return this.getToolApprovalState();
  }

  async respondFileReview(response: DesktopFileReviewResponse): Promise<DesktopToolApprovalState> {
    if (!this.activeFileReview) {
      throw new Error('No file review is pending.');
    }

    if (response.reviewId !== this.activeFileReview.request.id) {
      throw new Error('File review request is stale.');
    }

    this.activeFileReview.resolve(response.decision);
    return this.getToolApprovalState();
  }

  cancelActiveSubmit(): void {
    for (const controller of this.activeSubmitControllers) {
      controller.abort(createTaskCancellationError('Task cancelled by user.'));
    }
    this.activeSubmitControllers.clear();
  }

  async callModel(modelId: string, prompt: string): Promise<string> {
    await this.ready();
    const taskRunner = this.cli.getTaskRunner();
    const taskInput: RunAgentTaskInput = {
      goal: prompt,
      sessionId: null,
      providerId: 'deepseek',
      modelId,
      inputContextSummary: 'pre-flight goal validation',
    };
    const result = await taskRunner.run(taskInput);
    return result.outputSummary ?? '';
  }

  dispose(): void {
    if (this.cleanedUp) {
      return;
    }

    this.cleanedUp = true;
    for (const controller of this.activeSubmitControllers) {
      controller.abort(createTaskCancellationError('Task cancelled because the desktop window closed.'));
    }
    this.activeSubmitControllers.clear();

    if (this.activeToolApprovalBatch) {
      const pendingBatch = this.activeToolApprovalBatch;
      this.activeToolApprovalBatch = null;
      pendingBatch.reject(createTaskCancellationError('Tool approval was cancelled because the desktop window closed.'));
    }

    if (this.activeFileReview) {
      const pendingReview = this.activeFileReview;
      this.activeFileReview = null;
      pendingReview.reject(createTaskCancellationError('File review was cancelled because the desktop window closed.'));
    }

    this.cli.setProgressReporter(null);
    this.cli.setToolApprovalBatchHandler(null);
    this.cli.setToolApprovalHandler(null);
    this.cli.setFileReviewHandler(null);
    this.disposeRuntimeListener();
    this.runtime.dispose();
    this.cli.databaseClose();
  }

  private async initialize(input: DesktopTabRuntimeInitialization): Promise<void> {
    if (input.providerId) {
      await this.cli.setProviderSelection(input.providerId, input.modelId ?? undefined);
    }
    if (input.profileId) {
      await this.cli.startAgentSession(input.profileId);
    }
    await this.refreshRuntimeStatus();
  }

  private async executeInput(
    envelope: IpcInputEnvelope,
    signal?: AbortSignal,
  ): Promise<DesktopSubmitResponse> {
    const result = await routeInput({ input: envelope, runtime: this.runtime, signal });
    const blocks = createResultBlocks(result);
    const primaryBlock = blocks[0];
    const supplementalBlocks = blocks.slice(1);

    if (primaryBlock) {
      this.runtime.publish({ block: primaryBlock });
    }

    if (supplementalBlocks.length > 0) {
      setImmediate(() => {
        for (const block of supplementalBlocks) {
          this.runtime.publish({ block });
        }
      });
    }

    const runtimeStatus = await this.refreshRuntimeStatus();
    return {
      result,
      blocks,
      runtimeStatus,
      tabId: this.options.tabId,
    };
  }

  private async startLoopJobFromInput(envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse> {
    if (!this.options.loopJobManager) {
      throw new Error('Loop job manager is unavailable.');
    }

    const runtimeStatus = await this.refreshRuntimeStatus();
    const workspaceRoot = runtimeStatus.workspace ?? process.cwd();
    const inputText = envelope.inputText.trim();
    const maxRoundsMatch = inputText.match(/--max-rounds[=](\d+)/);
    const maxRounds = maxRoundsMatch ? Number.parseInt(maxRoundsMatch[1], 10) : 5;
    const goal = inputText.replace(/--max-rounds[=]\d+/, '').slice('/loop'.length).trim() || 'loop execution';
    const config: LoopConfig = {
      goal,
      maxRounds,
      judge: 'llm',
    };

    const resolved = await this.cli.getContextResolver().resolve({
      workspace: workspaceRoot,
      cwd: workspaceRoot,
    });

    const runRound: RunRoundFn = async (nextConfig, prevResult, signal) => {
      const taskInput: RunAgentTaskInput = {
        goal: prevResult ? `${prevResult.output}\n\n${nextConfig.goal}` : nextConfig.goal,
        sessionId: null,
        providerId: resolved.taskContext.providerId ?? 'deepseek',
        modelId: resolved.taskContext.selectedModelId ?? 'deepseek-v4-pro',
        inputContextSummary: nextConfig.accumulatedContext?.length > 0 ? nextConfig.accumulatedContext : '...',
        taskContext: resolved.taskContext,
        prompts: resolved.taskContext.prompts,
        signal,
      };
      const taskRunner = this.cli.getTaskRunner();
      const task = await taskRunner.run(taskInput);
      const output = extractTaskOutputSummaryText(task.outputSummary) ?? '';
      return { output, tokenUsage: 0 };
    };
    this.options.loopJobManager.setRunRound(runRound);

    const jobId = `job-${Date.now()}`;
    if (this.options.appWindow) {
      const monitorWindow = this.options.appWindow.getOrCreateMonitor();
      monitorWindow.create();
    }
    const onProgress = this.options.appWindow ? this.options.appWindow.createLoopProgressSender(jobId) : undefined;
    const resolvedCtx = await this.cli.getContextResolver().resolve({
      workspace: workspaceRoot,
      cwd: workspaceRoot,
    });
    const modelId = resolvedCtx.taskContext.selectedModelId;
    await this.options.loopJobManager.startJob(config, onProgress, jobId, modelId ?? undefined);

    return {
      result: successResult('LOOP_JOB_STARTED', 'Loop job started.', {
        jobId,
        config,
        sessionId: envelope.sessionId ?? null,
      }),
      blocks: [],
      runtimeStatus: await this.refreshRuntimeStatus(),
      tabId: this.options.tabId,
    };
  }

  private activateToolApprovalBatch(
    requests: readonly ToolApprovalRequest[],
    resolve: (decisions: readonly ToolApprovalDecision[]) => void,
    reject: (error: Error) => void,
  ): void {
    const batch = createToolApprovalBatch(requests);
    this.activeToolApprovalBatch = {
      batch,
      resolve: (decisions) => {
        this.activeToolApprovalBatch = null;
        this.publishToolApprovalState();
        resolve(decisions);
        this.drainApprovalQueue();
      },
      reject: (error) => {
        this.activeToolApprovalBatch = null;
        this.publishToolApprovalState();
        reject(error);
        this.drainApprovalQueue();
      },
    };
    this.publishToolApprovalState();
  }

  private drainApprovalQueue(): void {
    if (this.activeToolApprovalBatch) {
      return;
    }

    const next = this.toolApprovalQueue.shift();
    if (!next) {
      return;
    }

    this.activateToolApprovalBatch(next.requests, next.resolve, next.reject);
  }

  private publishToolApprovalState(): void {
    this.options.onToolApprovalState(this.options.tabId, this.getToolApprovalState());
  }

  private async refreshRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    this.lastRuntimeStatus = {
      ...(await this.cli.getRuntimeStatus()),
      desktopProcessId: process.pid,
    };
    this.updatedAt = new Date().toISOString();
    return this.lastRuntimeStatus;
  }
}

export interface DesktopAgentTabManagerOptions {
  readonly config: AppConfig;
  readonly initialWorkspace?: string | null;
  readonly loopJobManager?: DesktopLoopJobManager;
  readonly appWindow?: AppWindow;
  readonly mcpClientManager?: McpClientManager;
  readonly reloadConfig?: () => AppConfig;
  readonly onOutput: (tabId: string, block: RendererOutputBlock) => void;
  readonly onToolApprovalState: (tabId: string, state: DesktopToolApprovalState) => void;
  readonly onTabsChanged: (tabs: DesktopAgentTab[]) => void;
}

export class DesktopAgentTabManager {
  private readonly tabs = new Map<string, DesktopTabRuntime>();
  private readonly reloadConfig: () => AppConfig;
  private readonly readyPromise: Promise<void>;
  private legacyTabId: string | null = null;
  private sequence = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private currentConfig: AppConfig;

  constructor(private readonly options: DesktopAgentTabManagerOptions) {
    this.reloadConfig = options.reloadConfig ?? (() => options.config);
    this.currentConfig = options.config;
    this.readyPromise = this.createInitialTab();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async listTabs(): Promise<DesktopAgentTab[]> {
    await this.ready();
    return this.listTabsUnsafe();
  }

  async createTab(input: DesktopCreateTabInput = {}): Promise<DesktopAgentTab> {
    return this.runMutation(async () => {
      await this.ready();
      const tab = await this.createManagedTab(input);
      this.options.onTabsChanged(await this.listTabsUnsafe());
      return tab;
    });
  }

  async closeTab(tabId: string): Promise<DesktopCloseTabResult> {
    return this.runMutation(async () => {
      await this.ready();
      const normalizedTabId = requireNonEmptyValue(tabId, 'Tab id is required.');
      const runtime = this.getRuntime(normalizedTabId);
      runtime.dispose();
      this.tabs.delete(normalizedTabId);

      if (this.legacyTabId === normalizedTabId) {
        this.legacyTabId = null;
      }

      let fallbackTabId = this.legacyTabId;
      if (this.tabs.size === 0) {
        const replacement = await this.createManagedTab({
          workspace: this.options.initialWorkspace ?? process.cwd(),
        });
        fallbackTabId = replacement.id;
      } else if (!fallbackTabId) {
        fallbackTabId = this.tabs.keys().next().value ?? null;
      }

      if (!this.legacyTabId) {
        this.legacyTabId = fallbackTabId;
      }

      const tabs = await this.listTabsUnsafe();
      this.options.onTabsChanged(tabs);
      return {
        closedTabId: normalizedTabId,
        fallbackTabId,
        tabs,
      };
    });
  }

  async updateTab(input: DesktopUpdateTabInput): Promise<DesktopAgentTab> {
    return this.runMutation(async () => {
      await this.ready();
      const tabId = requireNonEmptyValue(input.tabId, 'Tab id is required.');
      const runtime = this.getRuntime(tabId);
      await this.applyTabSelection(runtime, tabId, input);
      const tab = await runtime.getTabState();
      this.options.onTabsChanged(await this.listTabsUnsafe());
      return tab;
    });
  }

  async getRuntimeStatus(tabId?: string | null): Promise<DesktopRuntimeStatus> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).getRuntimeStatus();
  }

  async getToolApprovalState(tabId?: string | null): Promise<DesktopToolApprovalState> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).getToolApprovalState();
  }

  /**
   * Synchronous counterpart of `getRuntimeStatus(...).activeSessionId`. Never
   * throws for a missing tab and never yields — safe to call from a
   * fire-and-forget sync path (channel tool-approval fan-out).
   */
  getCachedActiveSessionId(tabId?: string | null): string | null {
    const resolved = tabId?.trim() || this.legacyTabId;
    if (!resolved) {
      return null;
    }
    return this.tabs.get(resolved)?.getCachedActiveSessionId() ?? null;
  }

  async listAgentProfiles(): Promise<ReturnType<CliDependencies['listAgentProfiles']>> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(null)).listAgentProfiles();
  }

  async startAgentSession(tabId: string | null | undefined, profileId: string): Promise<DesktopRuntimeStatus> {
    return this.runMutation(async () => {
      await this.ready();
      const normalizedTabId = this.resolveTabId(tabId);
      const normalizedProfileId = requireNonEmptyValue(profileId, 'Agent profile id is required.');
      await this.assertProfileAvailable(normalizedProfileId, normalizedTabId);
      const runtimeStatus = await this.getRuntime(normalizedTabId).startAgentSession(normalizedProfileId);
      this.options.onTabsChanged(await this.listTabsUnsafe());
      return runtimeStatus;
    });
  }

  async listAgentSessions(tabId: string | null | undefined, agentInstanceId: string) {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).listAgentSessions(agentInstanceId);
  }

  async listAgentInstances(tabId?: string | null | undefined) {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).listAgentInstances();
  }

  async readSessionTaskStatus(tabId: string | null | undefined, sessionId: string) {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).readSessionTaskStatus(sessionId);
  }

  async createChannelSession(tabId: string | null | undefined, title: string, agentInstanceId: string | null) {
    return this.runMutation(async () => {
      await this.ready();
      const session = await this.getRuntime(this.resolveTabId(tabId)).createSession(title, agentInstanceId);
      this.options.onTabsChanged(await this.listTabsUnsafe());
      return session;
    });
  }

  async getTabState(tabId?: string | null | undefined): Promise<DesktopAgentTab> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).getTabState();
  }

  async getSession(tabId: string | null | undefined, sessionId: string) {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).getSession(sessionId);
  }

  async listSessionMemories(tabId: string | null | undefined, sessionId: string) {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).listSessionMemories(sessionId);
  }

  async selectSession(tabId: string | null | undefined, sessionId: string): Promise<DesktopSessionSelectionResponse> {
    await this.ready();
    const response = await this.getRuntime(this.resolveTabId(tabId)).selectSession(sessionId);
    this.options.onTabsChanged(await this.listTabsUnsafe());
    return response;
  }

  async submitInput(tabId: string | null | undefined, envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse> {
    const normalizedTabId = this.resolveTabId(tabId);
    const runtime = this.getRuntime(normalizedTabId);
    const response = await runtime.submitInput(envelope);
    this.options.onTabsChanged(await this.listTabsUnsafe());
    return response;
  }

  async cancelActiveSubmit(tabId?: string | null): Promise<void> {
    await this.ready();
    this.getRuntime(this.resolveTabId(tabId)).cancelActiveSubmit();
  }

  async listProviderConfigurations(): Promise<DesktopProviderConfigurationList> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(null)).listProviderConfigurations();
  }

  async saveGenericProviderConfiguration(
    input: DesktopSaveGenericProviderConfigurationInput,
  ): Promise<DesktopGenericProviderConfiguration> {
    return this.runMutation(async () => {
      await this.ready();
      let providerList: DesktopProviderConfigurationList | null = null;
      for (const runtime of this.tabs.values()) {
        providerList = await runtime.saveGenericProviderConfiguration(input);
      }
      this.currentConfig = this.reloadConfig();
      const savedProvider = providerList?.genericOpenAIProviders.find((provider) => provider.id === input.id.trim()) ?? null;
      if (!savedProvider) {
        throw new Error(`Provider "${input.id.trim()}" was saved but could not be loaded afterwards.`);
      }
      this.options.onTabsChanged(await this.listTabsUnsafe());
      return savedProvider;
    });
  }

  async removeGenericProviderConfiguration(providerId: string): Promise<void> {
    await this.runMutation(async () => {
      await this.ready();
      for (const runtime of this.tabs.values()) {
        await runtime.removeGenericProviderConfiguration(providerId);
      }
      this.currentConfig = this.reloadConfig();
      this.options.onTabsChanged(await this.listTabsUnsafe());
    });
  }

  async respondToolApproval(response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(response.tabId ?? null)).respondToolApproval(response);
  }

  async respondFileReview(response: DesktopFileReviewResponse): Promise<DesktopToolApprovalState> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(response.tabId ?? null)).respondFileReview(response);
  }

  async callModel(modelId: string, prompt: string, tabId?: string | null): Promise<string> {
    await this.ready();
    return this.getRuntime(this.resolveTabId(tabId)).callModel(modelId, prompt);
  }

  async selectInputFilesWorkspace(tabId?: string | null): Promise<string> {
    const runtimeStatus = await this.getRuntimeStatus(tabId);
    return runtimeStatus.workspace ?? process.cwd();
  }

  dispose(): void {
    for (const runtime of this.tabs.values()) {
      runtime.dispose();
    }
  }

  private async createInitialTab(): Promise<void> {
    const tab = await this.createManagedTab({
      workspace: this.options.initialWorkspace ?? process.cwd(),
    });
    this.legacyTabId = tab.id;
    this.options.onTabsChanged(await this.listTabsUnsafe());
  }

  private async createManagedTab(input: DesktopCreateTabInput): Promise<DesktopAgentTab> {
    const tabId = this.getNextTabId();
    const runtime = new DesktopTabRuntime({
      tabId,
      config: this.currentConfig,
      initialWorkspace: input.workspace ?? null,
      loopJobManager: this.options.loopJobManager,
      appWindow: this.options.appWindow,
      mcpClientManager: this.options.mcpClientManager,
      onOutput: this.options.onOutput,
      onToolApprovalState: this.options.onToolApprovalState,
    });
    this.tabs.set(tabId, runtime);
    if (!this.legacyTabId) {
      this.legacyTabId = tabId;
    }

    try {
      const profileId = await this.resolveRequestedProfileId(runtime, input.profileId);
      const selection = await this.resolveProviderSelection(runtime, input.providerId ?? null, input.modelId ?? null);
      await runtime.hydrate({
        profileId,
        providerId: selection?.providerId ?? null,
        modelId: selection?.modelId ?? null,
      });
      return runtime.getTabState();
    } catch (error) {
      runtime.dispose();
      this.tabs.delete(tabId);
      if (this.legacyTabId === tabId) {
        this.legacyTabId = this.tabs.keys().next().value ?? null;
      }
      throw error;
    }
  }

  private async applyTabSelection(
    runtime: DesktopTabRuntime,
    tabId: string,
    input: DesktopUpdateTabInput,
  ): Promise<void> {
    if (typeof input.workspace === 'string' && input.workspace.trim().length > 0) {
      await runtime.setWorkspaceRoot(input.workspace);
    }

    const selection = await this.resolveProviderSelection(runtime, input.providerId ?? null, input.modelId ?? null);
    if (selection) {
      await runtime.setProviderSelection(selection.providerId, selection.modelId);
    }

    if (typeof input.profileId === 'string') {
      const profileId = requireNonEmptyValue(input.profileId, 'Agent profile id is required.');
      await this.assertProfileAvailable(profileId, tabId);
      await runtime.startAgentSession(profileId);
    } else if (input.profileId === null) {
      throw new Error('Clearing a tab agent profile is not supported. Close the tab instead.');
    }
  }

  private async resolveRequestedProfileId(
    runtime: DesktopTabRuntime,
    requestedProfileId: string | null | undefined,
  ): Promise<string | null> {
    if (requestedProfileId === null) {
      return null;
    }

    const availableProfiles = runtime.listAgentProfiles();
    if (typeof requestedProfileId === 'string') {
      const profileId = requireNonEmptyValue(requestedProfileId, 'Agent profile id is required.');
      if (!availableProfiles.some((profile) => profile.id === profileId)) {
        throw new Error(`Agent profile template not found: ${profileId}`);
      }
      await this.assertProfileAvailable(profileId, null);
      return profileId;
    }

    const assignedProfileIds = new Set(
      (await this.listTabsUnsafe())
        .map((tab) => tab.runtimeStatus.agentProfileId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    const defaultProfileId = this.currentConfig.defaultAgentProfileId ?? null;
    if (defaultProfileId && !assignedProfileIds.has(defaultProfileId) && availableProfiles.some((profile) => profile.id === defaultProfileId)) {
      return defaultProfileId;
    }
    const nextProfile = availableProfiles.find((profile) => !assignedProfileIds.has(profile.id));
    return nextProfile?.id ?? null;
  }

  private async resolveProviderSelection(
    runtime: DesktopTabRuntime,
    providerId: string | null,
    modelId: string | null,
  ): Promise<{ providerId: string; modelId: string | null } | null> {
    if (!providerId && !modelId) {
      return null;
    }

    const runtimeStatus = await runtime.getRuntimeStatus();
    if (providerId) {
      return {
        providerId: requireNonEmptyValue(providerId, 'Provider id is required.'),
        modelId,
      };
    }

    const matchingProviders = (runtimeStatus.availableProviders ?? [])
      .filter((provider) => provider.models.some((model) => model.id === modelId));

    if (matchingProviders.length === 1) {
      return {
        providerId: matchingProviders[0].id,
        modelId,
      };
    }

    if (matchingProviders.length === 0 && runtimeStatus.providerId) {
      return {
        providerId: runtimeStatus.providerId,
        modelId,
      };
    }

    throw new Error(`Model "${modelId}" matches multiple providers. Provide a provider id explicitly.`);
  }

  private async assertProfileAvailable(profileId: string, tabId: string | null): Promise<void> {
    for (const tab of await this.listTabsUnsafe()) {
      if (tab.runtimeStatus.agentProfileId !== profileId) {
        continue;
      }

      if (tabId && tab.id === tabId) {
        continue;
      }

      throw new Error(`Agent profile "${profileId}" is already assigned to desktop tab "${tab.id}".`);
    }
  }

  private async listTabsUnsafe(): Promise<DesktopAgentTab[]> {
    return Promise.all([...this.tabs.values()].map(async (runtime) => runtime.getTabState()));
  }

  private getRuntime(tabId: string): DesktopTabRuntime {
    const runtime = this.tabs.get(tabId);
    if (!runtime) {
      throw new Error(`Desktop tab not found: ${tabId}`);
    }
    return runtime;
  }

  private resolveTabId(tabId?: string | null): string {
    const normalizedTabId = tabId?.trim();
    if (normalizedTabId) {
      return normalizedTabId;
    }

    if (!this.legacyTabId) {
      throw new Error('No desktop tabs are available.');
    }

    return this.legacyTabId;
  }

  private getNextTabId(): string {
    this.sequence += 1;
    return `desktop-tab-${this.sequence}`;
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release: (() => void) | undefined;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      if (release) {
        release();
      }
    }
  }
}

function resolveToolApprovalState(
  activeToolApprovalBatch: PendingToolApprovalBatch | null,
  activeFileReview: PendingFileReview | null,
): DesktopToolApprovalState {
  return {
    activeBatch: activeToolApprovalBatch?.batch ?? null,
    activeFileReview: activeFileReview?.request ?? null,
  };
}

function sanitizeGenericProviderConfigurations(entries: readonly unknown[]): DesktopGenericProviderConfiguration[] {
  if (!Array.isArray(entries)) {
    throw new Error('Provider configuration response must be an array.');
  }

  const configurations: DesktopGenericProviderConfiguration[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const value = entry as CliProviderConfigurationEntry;
    const providerId = sanitizeNonEmptyString(value.providerId) ?? sanitizeNonEmptyString(value.id);
    if (!providerId || providerId === 'github-copilot' || providerId === 'deepseek') {
      continue;
    }

    const providerType = sanitizeNonEmptyString(value.providerType) ?? sanitizeNonEmptyString(value.type);
    const baseUrl = sanitizeNonEmptyString(value.baseUrl);
    const isLikelyGenericProvider = (providerType
      ? providerType.toLowerCase().includes('openai') || providerType.toLowerCase().includes('generic')
      : false) || Boolean(baseUrl);

    if (!isLikelyGenericProvider) {
      continue;
    }

    const modelIds = normalizeModelIds(value.modelIds ?? value.models);
    const defaultModelId = sanitizeNonEmptyString(value.defaultModelId) ?? modelIds[0] ?? null;
    const isDefault = toBoolean(value.isDefault, toBoolean(value.default, false));
    const apiKeyConfigured = toBoolean(
      value.apiKeyConfigured,
      toBoolean(value.hasApiKey, sanitizeNonEmptyString(value.apiKey) !== null),
    );

    configurations.push({
      id: providerId,
      displayName: sanitizeNonEmptyString(value.displayName) ?? sanitizeNonEmptyString(value.name) ?? providerId,
      baseUrl: baseUrl ?? 'https://api.openai.com/v1',
      modelIds,
      defaultModelId,
      enabled: toBoolean(value.enabled, true),
      isDefault,
      apiKeyConfigured,
    });
  }

  return configurations.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function normalizeGenericProviderInput(input: DesktopSaveGenericProviderConfigurationInput): DesktopSaveGenericProviderConfigurationInput {
  const id = input.id.trim();
  const displayName = input.displayName.trim();
  const baseUrl = input.baseUrl.trim();
  const modelIds = Array.from(new Set(input.modelIds.map((modelId) => modelId.trim()).filter((modelId) => modelId.length > 0)));
  const defaultModelId = input.defaultModelId.trim();
  const apiKey = input.apiKey?.trim() ?? null;

  if (!id) {
    throw new Error('Provider id is required.');
  }

  if (id === 'github-copilot' || id === 'deepseek') {
    throw new Error('Built-in provider ids are reserved.');
  }

  if (!displayName) {
    throw new Error('Display name is required.');
  }

  if (!baseUrl) {
    throw new Error('Base URL is required.');
  }

  if (modelIds.length === 0) {
    throw new Error('At least one model id is required.');
  }

  if (!defaultModelId) {
    throw new Error('Default model id is required.');
  }

  if (!modelIds.includes(defaultModelId)) {
    throw new Error('Default model id must match one of the configured model ids.');
  }

  return {
    id,
    displayName,
    baseUrl,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    modelIds,
    defaultModelId,
    enabled: input.enabled,
    setAsDefault: input.setAsDefault,
  };
}

function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value
      .map((model) => {
        if (typeof model === 'string') {
          return model.trim();
        }

        if (model && typeof model === 'object') {
          const modelRecord = model as { id?: unknown; modelId?: unknown; name?: unknown };
          return sanitizeNonEmptyString(modelRecord.id)
            ?? sanitizeNonEmptyString(modelRecord.modelId)
            ?? sanitizeNonEmptyString(modelRecord.name)
            ?? '';
        }

        return '';
      })
      .filter((modelId) => modelId.length > 0),
  ));
}

function sanitizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function createToolApprovalBatch(requests: readonly ToolApprovalRequest[]): DesktopToolApprovalBatch {
  const createdAt = new Date().toISOString();
  return {
    id: `${createdAt}-tool-approval-${Math.random().toString(16).slice(2)}`,
    taskId: requests[0]?.taskId ?? 'unknown-task',
    createdAt,
    requests: requests.map((request) => mapToolApprovalRequest(request)),
  };
}

function mapToolApprovalRequest(request: ToolApprovalRequest): DesktopToolApprovalRequest {
  if (request.toolName === 'edit') {
    const args = request.args as Extract<ToolApprovalRequest['args'], { path: string; oldText: string }>;
    const primaryText = normalizeApprovalTarget(args.path);
    return {
      id: request.toolCallId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      kind: 'file-edit',
      title: request.title,
      summary: request.summary,
      detail: request.detail,
      primaryText,
      targetLabel: primaryText,
      operationLabel: args.oldText.length === 0 ? 'create' : 'edit',
    };
  }

  if (request.toolName === 'exec' || request.toolName === 'shell_exec') {
    const args = request.args as Extract<ToolApprovalRequest['args'], { command: string }> & { mode?: string };
    const primaryText = args.command.trim() || 'workspace command';
    return {
      id: request.toolCallId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      kind: 'command',
      title: request.title,
      summary: request.summary,
      detail: request.detail,
      primaryText,
      targetLabel: normalizeApprovalTarget(args.command),
      operationLabel: request.toolName === 'shell_exec' ? args.mode ?? 'shell_exec' : 'exec',
    };
  }

  return {
    id: request.toolCallId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    kind: 'other',
    title: request.title,
    summary: request.summary,
    detail: request.detail,
    primaryText: request.summary,
    targetLabel: request.toolName,
    operationLabel: request.toolName,
  };
}

function mapFileReviewRequest(request: EditReviewRequest): DesktopFileReviewRequest {
  return {
    id: request.id,
    toolCallId: request.toolCallId,
    title: request.title,
    summary: request.summary,
    detail: request.detail,
    fileChange: request.fileChange,
    shadowPath: request.shadowPath,
  };
}

function normalizeApprovalTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'workspace';
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized);
  return baseName && baseName !== '.' && baseName !== '/' ? normalized : trimmed;
}

function buildApprovalDecisions(
  batch: DesktopToolApprovalBatch,
  selectedRequestIds: readonly string[],
  decision: 'allow' | 'allow-all' = 'allow',
): readonly ToolApprovalDecision[] {
  const selectedIds = new Set(selectedRequestIds);
  const allowDecision: ToolApprovalDecision = decision === 'allow-all' ? 'allow-all' : 'allow-once';
  return batch.requests.map((request) => (selectedIds.has(request.id) ? allowDecision : 'deny'));
}

function requireNonEmptyValue(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}
