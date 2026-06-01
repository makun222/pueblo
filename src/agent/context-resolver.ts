import type { AppConfig } from '../shared/config';
import type { AgentInstanceService } from './agent-instance-service';
import { mergeAgentTemplateWithPuebloProfile } from './agent-profile-templates';
import { PepeResultService } from './pepe-result-service';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentTaskRepository } from './task-repository';
import type { MemoryService } from '../memory/memory-service';
import type { PromptService } from '../prompts/prompt-service';
import type { ProviderRegistry } from '../providers/provider-registry';
import type { SessionService } from '../sessions/session-service';
import type { WorkflowService } from '../workflow/workflow-service';
import {
  contextCountSchema,
  type BackgroundSummaryStatus,
  type ContextCount,
  type ContextCountBreakdown,
  type InputAttachmentManifest,
  type ProviderProfile,
  type Session,
  type SessionMessage,
} from '../shared/schema';
import { extractTaskOutputSummaryPayload, summarizeTaskStepTrace } from '../shared/result';
import { buildSkillSystemMessage, resolveSkillContext } from './skill-context';
import {
  compactRecentMessageForPrompt,
  isCompactContextModeEnabled,
  RECENT_CONTEXT_MESSAGE_LIMIT,
  selectRecentMessagesForPrompt,
} from './task-message-builder';
import { createTaskContext, formatSessionMessageForContext, type TaskContext } from './task-context';
import { PuebloProfileLoader } from './pueblo-profile';

export interface ResolveContextInput {
  readonly activeSessionId?: string | null;
  readonly explicitProviderId?: string | null;
  readonly explicitModelId?: string | null;
  readonly pendingUserInput?: string;
  readonly uploadedAttachments?: InputAttachmentManifest[];
  readonly puebloWorkingDirectory?: string | null;
  readonly cwd?: string;
  readonly workspace?: string | null;
}

export interface ResolvedContext {
  readonly taskContext: TaskContext;
  readonly runtimeStatus: {
    providerId: string | null;
    providerName: string | null;
    agentProfileId: string | null;
    agentProfileName: string | null;
    agentInstanceId: string | null;
    modelId: string | null;
    modelName: string | null;
    activeSessionId: string | null;
    contextCount: ContextCount;
    selectedStepSummaryCount: number;
    compactContextMode: boolean;
    selectedPromptCount: number;
    selectedMemoryCount: number;
    backgroundSummaryStatus: BackgroundSummaryStatus;
  };
}

export interface ContextResolverDependencies {
  readonly config: AppConfig;
  readonly sessionService: SessionService;
  readonly promptService: PromptService;
  readonly memoryService: MemoryService;
  readonly agentInstanceService: AgentInstanceService;
  readonly providerRegistry: ProviderRegistry;
  readonly pepeResultService?: PepeResultService;
  readonly taskRepository?: Pick<AgentTaskRepository, 'listBySession'>;
  readonly workflowService?: Pick<WorkflowService, 'getWorkflowContext'>;
  readonly resolveBackgroundSummaryStatus?: (sessionId: string | null) => BackgroundSummaryStatus;
  readonly puebloProfileLoader?: PuebloProfileLoader;
}

export class ContextBudgetService {
  compute(args: {
    readonly puebloTexts: string[];
    readonly promptTexts: string[];
    readonly memoryTexts: string[];
    readonly transientTexts: string[];
    readonly recentMessages: string[];
    readonly pendingUserInput?: string;
    readonly modelContextWindow: number | null;
    readonly derivedMemoryCount: number;
    readonly contextBreakdown?: ContextCountBreakdown;
  }): ContextCount {
    const nonEmptyMemoryTexts = args.memoryTexts.filter(Boolean);
    const textParts = [
      ...args.puebloTexts,
      ...args.promptTexts,
      ...nonEmptyMemoryTexts,
      ...args.transientTexts.filter(Boolean),
      ...args.recentMessages,
      args.pendingUserInput ?? '',
    ].filter(Boolean);
    const estimatedTokens = textParts.reduce((sum, part) => sum + estimateTokens(part), 0);
    const utilizationRatio = args.modelContextWindow && args.modelContextWindow > 0
      ? Number((estimatedTokens / args.modelContextWindow).toFixed(4))
      : null;

    return contextCountSchema.parse({
      estimatedTokens,
      contextWindowLimit: args.modelContextWindow,
      utilizationRatio,
      messageCount: args.recentMessages.length,
      selectedPromptCount: args.promptTexts.length,
      selectedMemoryCount: nonEmptyMemoryTexts.length,
      derivedMemoryCount: args.derivedMemoryCount,
      breakdown: args.contextBreakdown,
    });
  }
}

export class ContextResolver {
  private readonly profileLoader: PuebloProfileLoader;
  private readonly budgetService = new ContextBudgetService();
  private readonly pepeResultService: PepeResultService;

  constructor(private readonly dependencies: ContextResolverDependencies) {
    this.profileLoader = dependencies.puebloProfileLoader ?? new PuebloProfileLoader();
    this.pepeResultService = dependencies.pepeResultService ?? new PepeResultService(
      dependencies.memoryService,
      dependencies.config.pepe,
    );
  }

  resolve(input: ResolveContextInput = {}): ResolvedContext {
    const session = this.resolveSession(input.activeSessionId);
    const profiles = this.dependencies.providerRegistry.listProfiles();
    const selection = resolveProviderModelSelection({
      profiles,
      explicitProviderId: input.explicitProviderId,
      explicitModelId: input.explicitModelId,
      sessionModelId: session?.currentModelId ?? null,
      defaultProviderId: this.dependencies.config.defaultProviderId,
    });
    const prompts = this.dependencies.promptService.resolvePromptSelection(session?.selectedPromptIds ?? []);
    const agentInstance = this.dependencies.agentInstanceService.getAgentInstance(session?.agentInstanceId);
    const selectedTemplate = this.dependencies.agentInstanceService.getProfileTemplate(agentInstance?.profileId ?? this.dependencies.config.defaultAgentProfileId ?? '');
    const puebloProfile = mergeAgentTemplateWithPuebloProfile(
      selectedTemplate,
      this.profileLoader.load(input.cwd ?? process.cwd()),
    );
    const skillContext = resolveSkillContext({
      puebloWorkingDirectory: input.puebloWorkingDirectory ?? input.cwd ?? process.cwd(),
      agentInstanceId: agentInstance?.id ?? null,
      config: this.dependencies.config.pepe,
    });
    const skillContextText = buildSkillSystemMessage(skillContext);
    const sessionMessages = session?.messageHistory ?? [];
    const recentMessages = sessionMessages.map(formatSessionMessageForContext);
    const promptRecentMessages = selectRecentMessagesForPrompt(recentMessages);
    const targetDirectory = resolveTargetDirectory({
      pendingUserInput: input.pendingUserInput,
      sessionMessages,
      workspace: input.workspace ?? input.cwd ?? null,
    });
    const resolvedPepeResult = this.pepeResultService.resolve({
      sessionId: session?.id ?? input.activeSessionId ?? null,
      agentInstanceId: agentInstance?.id ?? null,
      selectedMemoryIds: session?.selectedMemoryIds ?? [],
      pendingUserInput: input.pendingUserInput,
    });
    const workflowContext = session?.id
      ? this.dependencies.workflowService?.getWorkflowContext(session.id) ?? null
      : null;
    const uploadedAttachments = input.uploadedAttachments ?? [];
    const attachmentContextTexts = uploadedAttachments.map((attachment) => summarizeAttachmentForContext(attachment));
    const latestTaskPayload = session?.id ? extractLatestTaskPayload(this.dependencies.taskRepository, session.id) : null;
    const activeTurnStepSummaries = summarizeTaskStepTrace(latestTaskPayload?.stepTrace);
    const activeTurnStepContext = activeTurnStepSummaries.length > 0
      ? ['Active turn step context:', ...activeTurnStepSummaries.map((entry) => entry.content)].join('\n')
      : null;
    const filteredResultItems = filterPinnedWorkflowResultItems(resolvedPepeResult.resultItems, workflowContext);
    const selectedMemories = this.dependencies.memoryService.resolveMemorySelection(session?.selectedMemoryIds ?? [])
      .filter((memory) => !memory.tags.includes('task-step-summary'));
    const sessionSummaryMemory = selectedMemories.find((memory) => memory.tags.includes('pepe-session-summary')) ?? null;
    const resultItemMemories = this.dependencies.memoryService.resolveMemorySelection(filteredResultItems.map((item) => item.memoryId));
    const legacyStepSummaryMemoryIds = new Set(
      resultItemMemories
        .filter((memory) => memory.tags.includes('task-step-summary'))
        .map((memory) => memory.id),
    );
    const filteredResultItemsWithoutLegacySteps = filteredResultItems.filter((item) => !legacyStepSummaryMemoryIds.has(item.memoryId));
    const nonLegacyResultItemMemories = resultItemMemories.filter((memory) => !legacyStepSummaryMemoryIds.has(memory.id));
    const overshadowedResultMemoryIds = sessionSummaryMemory
      ? new Set(
        nonLegacyResultItemMemories
          .filter((memory) => memory.tags.includes('pepe-summary'))
          .map((memory) => memory.id),
      )
      : new Set<string>();
    const prioritizedResultItems = filteredResultItemsWithoutLegacySteps.filter((item) => !overshadowedResultMemoryIds.has(item.memoryId));
    const filteredResultSet = resolvedPepeResult.resultSet
      ? {
        ...resolvedPepeResult.resultSet,
        items: prioritizedResultItems,
      }
      : null;
    const contextBreakdown = buildContextCountBreakdown({
      puebloTexts: [
        ...puebloProfile.roleDirectives,
        ...puebloProfile.goalDirectives,
        ...puebloProfile.constraintDirectives,
        ...puebloProfile.styleDirectives,
        ...puebloProfile.memoryPolicy.retentionHints,
        ...puebloProfile.memoryPolicy.summaryHints,
        ...puebloProfile.contextPolicy.priorityHints,
        ...puebloProfile.contextPolicy.truncationHints,
        puebloProfile.summaryPolicy.lineageHint ?? '',
        skillContextText ?? '',
      ],
      promptTexts: prompts.map((prompt) => prompt.content),
      memoryTexts: [
        sessionSummaryMemory?.content ?? '',
        ...prioritizedResultItems.map((item) => item.summary),
        workflowContext?.planSummary ?? '',
        workflowContext?.todoSummary ?? '',
        ...attachmentContextTexts,
      ],
      transientTexts: [activeTurnStepContext ?? ''],
      sessionMessages,
      pendingUserInput: input.pendingUserInput,
    });
    const contextCount = this.budgetService.compute({
      puebloTexts: [
        ...puebloProfile.roleDirectives,
        ...puebloProfile.goalDirectives,
        ...puebloProfile.constraintDirectives,
        ...puebloProfile.styleDirectives,
        ...puebloProfile.memoryPolicy.retentionHints,
        ...puebloProfile.memoryPolicy.summaryHints,
        ...puebloProfile.contextPolicy.priorityHints,
        ...puebloProfile.contextPolicy.truncationHints,
        puebloProfile.summaryPolicy.lineageHint ?? '',
        skillContextText ?? '',
      ],
      promptTexts: prompts.map((prompt) => prompt.content),
      memoryTexts: [
        sessionSummaryMemory?.content ?? '',
        ...prioritizedResultItems.map((item) => item.summary),
        workflowContext?.planSummary ?? '',
        workflowContext?.todoSummary ?? '',
        ...attachmentContextTexts,
      ],
      transientTexts: [activeTurnStepContext ?? ''],
      recentMessages: promptRecentMessages,
      pendingUserInput: input.pendingUserInput,
      modelContextWindow: selection.model?.contextWindow ?? null,
      derivedMemoryCount: resolvedPepeResult.sourceMemories.filter(
        (memory) => !memory.tags.includes('task-step-summary') && (memory.derivationType === 'summary' || memory.summaryDepth > 0),
      ).length,
      contextBreakdown,
    });
    const backgroundSummaryStatus = this.dependencies.resolveBackgroundSummaryStatus?.(session?.id ?? input.activeSessionId ?? null) ?? {
      state: 'idle',
      activeSummarySessionId: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    };
    const selectedStepSummaryCount = activeTurnStepSummaries.length;
    const compactContextMode = isCompactContextModeEnabled(contextCount);
    const taskContext = createTaskContext({
      config: this.dependencies.config,
      session,
      currentSessionId: session?.id ?? input.activeSessionId ?? null,
      targetDirectory,
      providerId: selection.provider?.id ?? null,
      providerName: selection.provider?.name ?? selection.provider?.id ?? null,
      selectedModelId: selection.model?.id ?? null,
      selectedModelName: selection.model?.name ?? selection.model?.id ?? null,
      prompts,
      resultSet: filteredResultSet,
      resultItems: prioritizedResultItems,
      workflowContext,
      skillContext,
      sessionMessages,
      recentMessages,
      activeTurnStepContext,
      puebloProfile,
      contextCount,
      uploadedAttachments,
      backgroundSummaryStatus,
    });

    return {
      taskContext,
      runtimeStatus: {
        providerId: taskContext.providerId,
        providerName: taskContext.providerName,
        agentProfileId: selectedTemplate?.id ?? null,
        agentProfileName: selectedTemplate?.name ?? null,
        agentInstanceId: agentInstance?.id ?? null,
        modelId: taskContext.selectedModelId,
        modelName: taskContext.selectedModelName,
        activeSessionId: taskContext.sessionId,
        contextCount,
        selectedStepSummaryCount,
        compactContextMode,
        selectedPromptCount: prompts.length,
        selectedMemoryCount: contextCount.selectedMemoryCount,
        backgroundSummaryStatus,
      },
    };
  }

  private resolveSession(activeSessionId?: string | null): Session | null {
    if (activeSessionId) {
      return this.dependencies.sessionService.getSession(activeSessionId);
    }

    return this.dependencies.sessionService.getCurrentSession();
  }
}

function resolveProviderModelSelection(args: {
  readonly profiles: ProviderProfile[];
  readonly explicitProviderId?: string | null;
  readonly explicitModelId?: string | null;
  readonly sessionModelId?: string | null;
  readonly defaultProviderId?: string | null;
}): { provider: ProviderProfile | null; model: ProviderProfile['models'][number] | null } {
  const provider = resolveProvider(args);
  if (!provider) {
    return { provider: null, model: null };
  }

  const requestedModelId = args.explicitModelId ?? args.sessionModelId ?? provider.defaultModelId;
  const model = provider.models.find((candidate) => candidate.id === requestedModelId) ?? provider.models[0] ?? null;
  return { provider, model };
}

function resolveProvider(args: {
  readonly profiles: ProviderProfile[];
  readonly explicitProviderId?: string | null;
  readonly explicitModelId?: string | null;
  readonly sessionModelId?: string | null;
  readonly defaultProviderId?: string | null;
}): ProviderProfile | null {
  if (args.explicitProviderId) {
    return args.profiles.find((profile) => profile.id === args.explicitProviderId) ?? null;
  }

  const modelId = args.explicitModelId ?? args.sessionModelId;
  if (modelId) {
    const matchingProvider = args.profiles.find((profile) => profile.models.some((model) => model.id === modelId));
    if (matchingProvider) {
      return matchingProvider;
    }
  }

  if (args.defaultProviderId) {
    return args.profiles.find((profile) => profile.id === args.defaultProviderId) ?? null;
  }

  return args.profiles[0] ?? null;
}

function estimateTokens(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function resolveTargetDirectory(args: {
  readonly pendingUserInput?: string;
  readonly sessionMessages: Session['messageHistory'];
  readonly workspace: string | null;
}): string | null {
  const candidateInputs = [
    args.pendingUserInput ?? '',
    ...[...args.sessionMessages]
      .reverse()
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
  ];

  for (const inputText of candidateInputs) {
    for (const candidatePath of extractAbsolutePaths(inputText)) {
      const resolvedDirectory = resolveDirectoryCandidate(candidatePath);
      if (resolvedDirectory) {
        return resolvedDirectory;
      }
    }
  }

  return args.workspace;
}

function extractAbsolutePaths(inputText: string): string[] {
  const matches = inputText.match(/[A-Za-z]:(?:\\|\/)[^\s"'<>|，。；;,!?)\]]+/g) ?? [];
  return matches.map((match) => match.replace(/[，。；;,.!?)\]]+$/u, ''));
}

function resolveDirectoryCandidate(candidatePath: string): string | null {
  try {
    const normalizedPath = path.normalize(candidatePath);
    if (!fs.existsSync(normalizedPath)) {
      return null;
    }

    const stat = fs.statSync(normalizedPath);
    if (stat.isDirectory()) {
      return normalizedPath;
    }

    if (stat.isFile()) {
      return path.dirname(normalizedPath);
    }

    return null;
  } catch {
    return null;
  }
}

function filterPinnedWorkflowResultItems(
  resultItems: TaskContext['resultItems'],
  workflowContext: TaskContext['workflowContext'],
) {
  const pinnedIds = new Set([
    workflowContext?.planMemoryId ?? null,
    workflowContext?.todoMemoryId ?? null,
  ].filter((id): id is string => Boolean(id)));

  if (pinnedIds.size === 0) {
    return [...resultItems];
  }

  return resultItems.filter((item) => !pinnedIds.has(item.memoryId));
}

function buildContextCountBreakdown(args: {
  readonly puebloTexts: readonly string[];
  readonly promptTexts: readonly string[];
  readonly memoryTexts: readonly string[];
  readonly transientTexts: readonly string[];
  readonly sessionMessages: readonly SessionMessage[];
  readonly pendingUserInput?: string;
}): ContextCountBreakdown {
  let systemPromptTokens = estimateTokens(args.puebloTexts.filter(Boolean).join('\n'))
    + estimateTokens(args.promptTexts.filter(Boolean).join('\n'))
    + estimateTokens(args.memoryTexts.filter(Boolean).join('\n'))
    + estimateTokens(args.transientTexts.filter(Boolean).join('\n'));
  let userInputTokens = estimateTokens(args.pendingUserInput ?? '');
  let toolResultTokens = 0;

  for (const message of args.sessionMessages.slice(-RECENT_CONTEXT_MESSAGE_LIMIT)) {
    const compactedMessage = compactRecentMessageForPrompt(formatSessionMessageForContext(message));
    const messageTokens = estimateTokens(compactedMessage);

    if (message.role === 'user') {
      userInputTokens += messageTokens;
      continue;
    }

    if (message.role === 'tool') {
      toolResultTokens += messageTokens;
      continue;
    }

    systemPromptTokens += messageTokens;
  }

  return {
    systemPromptTokens,
    userInputTokens,
    toolResultTokens,
  };
}

function summarizeAttachmentForContext(attachment: InputAttachmentManifest): string {
  const metrics = [
    attachment.summary.chunkCount !== null ? `${attachment.summary.chunkCount} chunks` : null,
    attachment.summary.sheetCount !== null ? `${attachment.summary.sheetCount} sheets` : null,
    attachment.summary.rowCount !== null ? `${attachment.summary.rowCount} rows` : null,
    attachment.summary.cellCount !== null ? `${attachment.summary.cellCount} cells` : null,
    attachment.summary.isLarge ? 'large asset' : 'inline asset',
  ].filter((value): value is string => Boolean(value));

  return [
    `Uploaded attachment: ${attachment.source.fileName}`,
    `kind=${attachment.kind}`,
    `jsonPath=${attachment.asset.jsonPath}`,
    metrics.length > 0 ? `metrics=${metrics.join(', ')}` : null,
    attachment.summary.previewText ? `preview=${attachment.summary.previewText}` : null,
  ].filter((value): value is string => Boolean(value)).join(' | ');
}

function extractLatestTaskPayload(
  taskRepository: Pick<AgentTaskRepository, 'listBySession'> | undefined,
  sessionId: string,
) {
  if (!taskRepository) {
    return null;
  }

  const latestTask = taskRepository.listBySession(sessionId).at(-1);
  return extractTaskOutputSummaryPayload(latestTask?.outputSummary ?? null);
}