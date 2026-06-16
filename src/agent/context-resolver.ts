import type { AppConfig } from '../shared/config';
import type { AgentInstanceService } from './agent-instance-service';
import { mergeAgentTemplateWithPuebloProfile } from './agent-profile-templates';
import { PepeResultService } from './pepe-result-service';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentTaskRepository } from './task-repository';
import { resolveMemoryPriorityRank, type MemoryService } from '../memory/memory-service';
import type { PromptService } from '../prompts/prompt-service';
import type { ProviderRegistry } from '../providers/provider-registry';
import type { SessionService } from '../sessions/session-service';
import type { WorkflowService } from '../workflow/workflow-service';
import { perfEnd, perfStart } from '../utils/perf-logger';
import {
  contextCountSchema,
  type BackgroundSummaryStatus,
  type ContextCount,
  type InputAttachmentManifest,
  type MemoryRecord,
  type ProviderProfile,
  type Session,
  type SessionMessage,
} from '../shared/schema';
import { extractTaskOutputSummaryPayload, summarizeTaskTurnTrace } from '../shared/result';
import { buildSkillSystemMessage, resolveSkillContext } from './skill-context';
import {
  compactRecentMessageForPrompt,
  isCompactContextModeEnabled,
  RECENT_CONTEXT_MESSAGE_LIMIT,
  selectRecentMessagesForPrompt,
} from './task-message-builder';

const TARGET_DIRECTORY_USER_MESSAGE_SCAN_LIMIT = 32;
const BUDGET_TRUNCATION_START_RATIO = 0.75;
const BUDGET_TRUNCATION_TAIL_RATIO = 0.9;
const PROTECTED_PRIORITY_RANK = 2;
const DETERMINISTIC_RECALL_SKIP_RATIO = 0.9;
const DETERMINISTIC_RECALL_MEMORY_KINDS: MemoryRecord['memoryKind'][] = ['turn', 'summary', 'knowledge', 'workflow'];
import { createTaskContext, formatSessionMessageForContext, type TaskContext } from './task-context';
import { PuebloProfileLoader } from './pueblo-profile';

export interface ResolveContextInput {
  readonly activeSessionId?: string | null;
  readonly explicitProviderId?: string | null;
  readonly explicitModelId?: string | null;
  readonly pendingUserInput?: string;
  readonly uploadedAttachments?: InputAttachmentManifest[];
   readonly skillId?: string | null;
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
    readonly sessionMessages: readonly SessionMessage[];
    readonly pendingUserInput?: string;
    readonly modelContextWindow: number | null;
    readonly derivedMemoryCount: number;
    readonly fixedContextTokens?: number;
  }): ContextCount {
    const nonEmptyMemoryTexts = args.memoryTexts.filter(Boolean);
    // Reuse pre-computed fixed context tokens from budget truncation when available
    const fixedTokens = args.fixedContextTokens ?? estimateContextBucketTokens([
      ...args.puebloTexts,
      ...args.promptTexts,
      ...args.transientTexts.filter(Boolean),
      ...args.recentMessages,
      args.pendingUserInput ?? '',
    ]);
    const nonEmptyMemoryTokens = nonEmptyMemoryTexts.reduce((sum, part) => sum + estimateTokens(part), 0);
    const estimatedTokens = fixedTokens + nonEmptyMemoryTokens;
    const utilizationRatio = args.modelContextWindow && args.modelContextWindow > 0
      ? Number((estimatedTokens / args.modelContextWindow).toFixed(4))
      : null;

    // Context count breakdown
    let systemPromptTokens =
      estimateTokens(args.puebloTexts.filter(Boolean).join('\n')) +
      estimateTokens(args.promptTexts.filter(Boolean).join('\n')) +
      estimateTokens(args.memoryTexts.filter(Boolean).join('\n')) +
      estimateTokens(args.transientTexts.filter(Boolean).join('\n'));
    let userInputTokens = estimateTokens(args.pendingUserInput ?? '');
    let toolResultTokens = 0;

    for (const message of args.sessionMessages.slice(-RECENT_CONTEXT_MESSAGE_LIMIT)) {
      const compactedMessage = compactRecentMessageForPrompt(
        formatSessionMessageForContext(message),
      );
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

    return contextCountSchema.parse({
      estimatedTokens,
      contextWindowLimit: args.modelContextWindow,
      utilizationRatio,
      messageCount: args.recentMessages.length,
      selectedPromptCount: args.promptTexts.length,
      selectedMemoryCount: nonEmptyMemoryTexts.length,
      derivedMemoryCount: args.derivedMemoryCount,
      breakdown: {
        systemPromptTokens,
        userInputTokens,
        toolResultTokens,
      },
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

  async resolve(input: ResolveContextInput = {}): Promise<ResolvedContext> {
    const _resolveT0 = perfStart('  contextResolver.resolve.inner');
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
      skillId: input.skillId ?? null,
    });
    const skillContextText = buildSkillSystemMessage(skillContext);
    const sessionMessages = session?.messageHistory ?? [];
    const recentMessages = selectRecentContextMessages(sessionMessages);
    const promptRecentMessages = selectRecentMessagesForPrompt(recentMessages);
    const targetDirectory = resolveTargetDirectory({
      pendingUserInput: input.pendingUserInput,
      recentUserMessages: selectRecentUserMessagesForTargetDirectory(sessionMessages),
      workspace: input.workspace ?? input.cwd ?? null,
    });
    const selectedMemoryIds = session?.selectedMemoryIds ?? [];
    const workflowContext = session?.id
      ? this.dependencies.workflowService?.getWorkflowContext(session.id) ?? null
      : null;
    const uploadedAttachments = input.uploadedAttachments ?? [];
    const attachmentContextTexts = uploadedAttachments.map((attachment) => summarizeAttachmentForContext(attachment));
    const latestTaskPayload = session?.id ? extractLatestTaskPayload(this.dependencies.taskRepository, session.id) : null;
   /*
    const activeTurnStepSummaries = summarizeTaskTurnTrace(latestTaskPayload?.stepTrace, {
      subtaskGoal: puebloProfile.goalDirectives.join('\n'),
      constraints: puebloProfile.constraintDirectives,
    }, puebloProfile.contextPolicy.activeTurnStepWindow);
    const activeTurnStepContext = activeTurnStepSummaries.length > 0
      ? ['Active turn step context:', ...activeTurnStepSummaries.map((entry) => entry.content)].join('\n')
      : null;//0614-zero
      */
    const activeTurnStepContext = null; 
    const recallMemoryIds = resolveDeterministicRecallMemoryIds({
      enabled: this.dependencies.config.pepe.enableDeterministicRecall,
      memoryService: this.dependencies.memoryService,
      selectedMemoryIds,
      sessionId: session?.id ?? null,
      pendingUserInput: input.pendingUserInput,
      fixedContextTexts: [
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
        workflowContext?.planSummary ?? '',
        workflowContext?.todoSummary ?? '',
        ...attachmentContextTexts,
        activeTurnStepContext ?? '',
        ...promptRecentMessages,
        input.pendingUserInput ?? '',
      ],
      modelContextWindow: selection.model?.contextWindow ?? null,
      config: this.dependencies.config.pepe,
    });
    const effectiveSelectedMemoryIds = uniqueMemoryIds([...selectedMemoryIds, ...recallMemoryIds]);
    const resolvedPepeResult = this.pepeResultService.resolve({
      sessionId: session?.id ?? input.activeSessionId ?? null,
      agentInstanceId: agentInstance?.id ?? null,
      selectedMemoryIds: effectiveSelectedMemoryIds,
      pendingUserInput: input.pendingUserInput,
    });
    const filteredResultItems = filterPinnedWorkflowResultItems(resolvedPepeResult.resultItems, workflowContext);
    const selectedMemories = this.dependencies.memoryService.resolveMemorySelection(effectiveSelectedMemoryIds)
      .filter((memory) => !memory.tags.includes('task-step-summary'));
    const resultItemMemories = this.dependencies.memoryService.resolveMemorySelection(filteredResultItems.map((item) => item.memoryId));
    const legacyStepSummaryMemoryIds = new Set(
      resultItemMemories
        .filter((memory) => memory.tags.includes('task-step-summary'))
        .map((memory) => memory.id),
    );
    const filteredResultItemsWithoutLegacySteps = filteredResultItems.filter((item) => !legacyStepSummaryMemoryIds.has(item.memoryId));
    const nonLegacyResultItemMemories = resultItemMemories.filter((memory) => !legacyStepSummaryMemoryIds.has(memory.id));
    const sessionSummaryMemories = selectSessionSummariesForPrompt({
      currentSessionId: session?.id ?? null,
      selectedMemories,
      resultItemMemories: nonLegacyResultItemMemories,
    });
    const injectedSessionSummaryIds = new Set(sessionSummaryMemories.map((memory) => memory.id));
    const injectedSessionSummarySourceIds = new Set(
      sessionSummaryMemories
        .map((memory) => memory.sourceSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    const overshadowedResultMemoryIds = new Set(
      nonLegacyResultItemMemories
        .filter((memory) => {
          if (injectedSessionSummaryIds.has(memory.id)) {
            return true;
          }

          if (!memory.tags.includes('pepe-summary') || memory.tags.includes('pepe-session-summary')) {
            return false;
          }

          return memory.sourceSessionId !== null && injectedSessionSummarySourceIds.has(memory.sourceSessionId);
        })
        .map((memory) => memory.id),
    );
    // Use selectForContext for unified dedup + sort of non-legacy result items
    const _selectT0 = perfStart('    selectForContext');
    const contextSelection = await this.dependencies.memoryService.selectForContext({
      candidates: nonLegacyResultItemMemories,
      totalBudget: Number.MAX_SAFE_INTEGER, // Skip truncation — handled by applyBudgetAwareResultTruncation below
      policy: {
        injectionWeightThreshold: {},
        reservedBudget: { recentConversation: 0 },
      },
      category: 'relevantResultItems',
    });
    const selectedContextMemoryIds = new Set(contextSelection.selected.map((m) => m.id));
    const contextMemoryRank = new Map(contextSelection.selected.map((m, i) => [m.id, i]));
    const filteredNonOvershadowed = filteredResultItemsWithoutLegacySteps.filter(
      (item) => !overshadowedResultMemoryIds.has(item.memoryId) && selectedContextMemoryIds.has(item.memoryId),
    );
    perfEnd('    selectForContext', _selectT0);
    const prioritizedResultItems = filteredNonOvershadowed.sort(
      (a, b) => (contextMemoryRank.get(a.memoryId) ?? Infinity) - (contextMemoryRank.get(b.memoryId) ?? Infinity),
    );
    const puebloTexts = [
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
    ];
    const promptTexts = prompts.map((prompt) => prompt.content);
    const workflowTexts = [workflowContext?.planSummary ?? '', workflowContext?.todoSummary ?? ''];
    const transientTexts = [activeTurnStepContext ?? ''];

    const { resultItems: budgetedResultItems, fixedContextTokens } = applyBudgetAwareResultTruncation({
      enabled: this.dependencies.config.pepe.enableBudgetAwareResultTruncation,
      resultItems: prioritizedResultItems,
      resultItemMemories: nonLegacyResultItemMemories,
      modelContextWindow: selection.model?.contextWindow ?? null,
      memoryConfig: this.dependencies.config.memory,
      puebloTexts,
      promptTexts,
      sessionSummaryMemories,
      workflowTexts,
      attachmentContextTexts,
      transientTexts,
      recentMessages: promptRecentMessages,
      pendingUserInput: input.pendingUserInput,
    });
    const filteredResultSet = resolvedPepeResult.resultSet
      ? {
        ...resolvedPepeResult.resultSet,
        items: budgetedResultItems,
      }
      : null;
    const memoryTexts = [
      ...sessionSummaryMemories.map((memory) => memory.content),
      ...budgetedResultItems.map((item) => item.summary),
      ...workflowTexts,
      ...attachmentContextTexts,
    ];

    const contextCount = this.budgetService.compute({
      puebloTexts,
      promptTexts,
      memoryTexts,
      transientTexts,
      recentMessages: promptRecentMessages,
      sessionMessages,
      pendingUserInput: input.pendingUserInput,
      modelContextWindow: selection.model?.contextWindow ?? null,
      derivedMemoryCount: resolvedPepeResult.sourceMemories.filter(
        (memory) => !memory.tags.includes('task-step-summary') && (memory.derivationType === 'summary' || memory.summaryDepth > 0),
      ).length,
      fixedContextTokens,
    });
    const backgroundSummaryStatus = this.dependencies.resolveBackgroundSummaryStatus?.(session?.id ?? input.activeSessionId ?? null) ?? {
      state: 'idle',
      activeSummarySessionId: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    };
    //const selectedStepSummaryCount = activeTurnStepSummaries.length;//0614-zero
    const selectedStepSummaryCount = 0;
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
      sessionSummaryMemories,
      resultSet: filteredResultSet,
      resultItems: budgetedResultItems,
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

function uniqueMemoryIds(memoryIds: readonly string[]): string[] {
  return [...new Set(memoryIds.filter((memoryId) => memoryId.trim().length > 0))];
}

function resolveDeterministicRecallMemoryIds(args: {
  readonly enabled: boolean;
  readonly memoryService: Pick<MemoryService, 'searchMemories'>;
  readonly selectedMemoryIds: readonly string[];
  readonly sessionId: string | null;
  readonly pendingUserInput?: string;
  readonly fixedContextTexts: readonly string[];
  readonly modelContextWindow: number | null;
  readonly config: AppConfig['pepe'];
}): string[] {
  const text = args.pendingUserInput?.trim();
  if (!args.enabled || !text) {
    return [];
  }

  if (shouldSkipDeterministicRecall(args.fixedContextTexts, args.modelContextWindow)) {
    return [];
  }

  try {
    return args.memoryService.searchMemories({
      text,
      sessionId: args.sessionId,
      memoryKinds: DETERMINISTIC_RECALL_MEMORY_KINDS,
      minWeight: args.config.deterministicRecallMinWeight,
      lookbackTurns: args.config.deterministicRecallLookbackTurns,
      maxResults: args.config.deterministicRecallMaxResults,
    })
      .map((memory) => memory.id)
      .filter((memoryId) => !args.selectedMemoryIds.includes(memoryId));
  } catch {
    return [];
  }
}

function shouldSkipDeterministicRecall(fixedContextTexts: readonly string[], modelContextWindow: number | null): boolean {
  if (!modelContextWindow || modelContextWindow <= 0) {
    return false;
  }

  const estimatedTokens = fixedContextTexts.reduce((sum, text) => sum + estimateTokens(text), 0);
  return Number((estimatedTokens / modelContextWindow).toFixed(4)) >= DETERMINISTIC_RECALL_SKIP_RATIO;
}

function resolveTargetDirectory(args: {
  readonly pendingUserInput?: string;
  readonly recentUserMessages: readonly SessionMessage[];
  readonly workspace: string | null;
}): string | null {
  const candidateInputs = [
    args.pendingUserInput ?? '',
    ...args.recentUserMessages.map((message) => message.content),
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

function selectSessionSummariesForPrompt(args: {
  readonly currentSessionId: string | null;
  readonly selectedMemories: readonly MemoryRecord[];
  readonly resultItemMemories: readonly MemoryRecord[];
}): MemoryRecord[] {
  // Inline dedup + sort for session summary candidates
  const allSummaryCandidates = [...args.selectedMemories.filter(isSessionSummaryMemory), ...args.resultItemMemories.filter(isSessionSummaryMemory)];
  const dedupedById = new Map<string, MemoryRecord>();
  for (const m of allSummaryCandidates) {
    if (!dedupedById.has(m.id)) dedupedById.set(m.id, m);
  }
  const dedupedByHash = new Map<string, MemoryRecord>();
  for (const m of dedupedById.values()) {
    const key = m.contentHash ?? m.id;
    if (!dedupedByHash.has(key)) dedupedByHash.set(key, m);
  }
  const candidates = [...dedupedByHash.values()].sort(
    (a, b) => (resolveMemoryPriorityRank(b) - resolveMemoryPriorityRank(a)) || (b.weight - a.weight),
  );

  const selected: MemoryRecord[] = [];
  const currentSessionSummary = candidates.find((memory) => memory.sourceSessionId === args.currentSessionId) ?? null;
  if (currentSessionSummary) {
    selected.push(currentSessionSummary);
  }

  const relatedSessionSummary = candidates.find((memory) => {
    if (selected.some((candidate) => candidate.id === memory.id)) {
      return false;
    }

    if (!memory.sourceSessionId) {
      return args.currentSessionId === null;
    }

    return memory.sourceSessionId !== args.currentSessionId;
  }) ?? null;

  if (relatedSessionSummary) {
    selected.push(relatedSessionSummary);
  }

  return selected;
}

function sortResultItemsForPrompt(
  resultItems: TaskContext['resultItems'],
  memories: readonly MemoryRecord[],
): TaskContext['resultItems'] {
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  return resultItems
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftMemory = memoryById.get(left.item.memoryId);
      const rightMemory = memoryById.get(right.item.memoryId);
      return comparePromptMemories(leftMemory, rightMemory) || left.index - right.index;
    })
    .map(({ item }) => item);
}

function sortMemoriesForPrompt(memories: readonly MemoryRecord[]): MemoryRecord[] {
  return [...memories].sort(comparePromptMemories);
}

function comparePromptMemories(
  left: Pick<MemoryRecord, 'memoryKind' | 'tags' | 'weight' | 'updatedAt' | 'createdAt'> | undefined,
  right: Pick<MemoryRecord, 'memoryKind' | 'tags' | 'weight' | 'updatedAt' | 'createdAt'> | undefined,
): number {
  return resolveMemoryPriorityRank(right) - resolveMemoryPriorityRank(left)
    || resolvePromptMemoryWeight(right) - resolvePromptMemoryWeight(left)
    || compareDateDesc(right?.updatedAt, left?.updatedAt)
    || compareDateDesc(right?.createdAt, left?.createdAt);
}

function resolvePromptMemoryWeight(memory: Pick<MemoryRecord, 'weight'> | undefined): number {
  if (!memory || !Number.isFinite(memory.weight)) {
    return 0;
  }

  return memory.weight;
}

function compareDateDesc(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return left.localeCompare(right);
}

function isSessionSummaryMemory(memory: Pick<MemoryRecord, 'tags'>): boolean {
  return memory.tags.includes('pepe-session-summary');
}

function dedupeMemoriesById(memories: readonly MemoryRecord[]): MemoryRecord[] {
  const seenMemoryIds = new Set<string>();
  const deduped: MemoryRecord[] = [];

  for (const memory of memories) {
    if (seenMemoryIds.has(memory.id)) {
      continue;
    }

    seenMemoryIds.add(memory.id);
    deduped.push(memory);
  }

  return deduped;
}

function dedupeMemoriesByContentHash(memories: readonly MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const deduped: MemoryRecord[] = [];

  for (const memory of memories) {
    if (!memory.contentHash) {
      // keep memories without contentHash (backward compatibility)
      deduped.push(memory);
      continue;
    }
    if (!seen.has(memory.contentHash)) {
      seen.add(memory.contentHash);
      deduped.push(memory);
    }
  }

  return deduped;
}

function applyBudgetAwareResultTruncation(args: {
  readonly enabled: boolean;
  readonly resultItems: TaskContext['resultItems'];
  readonly resultItemMemories: readonly MemoryRecord[];
  readonly modelContextWindow: number | null;
  readonly memoryConfig: AppConfig['memory'];
  readonly puebloTexts: readonly string[];
  readonly promptTexts: readonly string[];
  readonly sessionSummaryMemories: readonly MemoryRecord[];
  readonly workflowTexts: readonly string[];
  readonly attachmentContextTexts: readonly string[];
  readonly transientTexts: readonly string[];
  readonly recentMessages: readonly string[];
  readonly pendingUserInput?: string;
}): { resultItems: TaskContext['resultItems']; fixedContextTokens: number } {
  // Compute fixed context token overhead once, reused by caller for budget diagnostics
  const fixedTokens = estimateContextBucketTokens([
    ...args.puebloTexts,
    ...args.promptTexts,
    ...args.sessionSummaryMemories.map((memory) => memory.content),
    ...args.workflowTexts,
    ...args.attachmentContextTexts,
    ...args.transientTexts,
    ...args.recentMessages,
    args.pendingUserInput ?? '',
  ]);

  if (!args.enabled || !args.modelContextWindow || args.modelContextWindow <= 0 || args.resultItems.length === 0) {
    return { resultItems: [...args.resultItems], fixedContextTokens: fixedTokens };
  }

  const memoryById = new Map(args.resultItemMemories.map((memory) => [memory.id, memory]));
  const utilizationRatio = estimateResultItemUtilization(args.resultItems, fixedTokens, args.modelContextWindow);

  if (utilizationRatio <= BUDGET_TRUNCATION_START_RATIO) {
    return { resultItems: [...args.resultItems], fixedContextTokens: fixedTokens };
  }

  let retainedItems = args.resultItems.filter((item) => {
    const memory = memoryById.get(item.memoryId);
    if (resolveMemoryPriorityRank(memory) >= PROTECTED_PRIORITY_RANK) {
      return true;
    }

    return resolvePromptMemoryWeight(memory) >= resolvePromptMergeThreshold(memory, args.memoryConfig);
  });

  if (retainedItems.length === 0) {
    return { resultItems: retainedItems, fixedContextTokens: fixedTokens };
  }

  // Pre-compute per-item token costs for single-pass budget truncation
  const itemTokenCosts = retainedItems.map((item) => estimateTokens(item.summary));
  let runningTokens = fixedTokens + itemTokenCosts.reduce((sum, t) => sum + t, 0);

  // If already within budget, return all retained items
  if (runningTokens / args.modelContextWindow <= BUDGET_TRUNCATION_TAIL_RATIO) {
    return { resultItems: retainedItems, fixedContextTokens: fixedTokens };
  }

  // Trim from the end (lowest priority), skipping protected items
  for (let i = retainedItems.length - 1; i >= 0; i--) {
    const item = retainedItems[i];
    const memory = memoryById.get(item.memoryId);
    if (resolveMemoryPriorityRank(memory) >= PROTECTED_PRIORITY_RANK) {
      continue;
    }

    runningTokens -= itemTokenCosts[i];

    if (runningTokens / args.modelContextWindow <= BUDGET_TRUNCATION_TAIL_RATIO) {
      return { resultItems: retainedItems.slice(0, i), fixedContextTokens: fixedTokens };
    }
  }

  // All non-protected items exhausted — keep only protected items
  return {
    resultItems: retainedItems.filter((item) => {
      const memory = memoryById.get(item.memoryId);
      return resolveMemoryPriorityRank(memory) >= PROTECTED_PRIORITY_RANK;
    }),
    fixedContextTokens: fixedTokens,
  };
}

function estimateContextBucketTokens(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + estimateTokens(text), 0);
}

function estimateResultItemUtilization(
  resultItems: readonly TaskContext['resultItems'][number][],
  fixedTokens: number,
  modelContextWindow: number,
): number {
  if (modelContextWindow <= 0) {
    return 0;
  }

  const resultTokens = resultItems.reduce((total, item) => total + estimateTokens(item.summary), 0);
  return Number(((fixedTokens + resultTokens) / modelContextWindow).toFixed(4));
}

function resolvePromptMergeThreshold(
  memory: Pick<MemoryRecord, 'memoryKind' | 'tags'> | undefined,
  memoryConfig: AppConfig['memory'],
): number {
  if (!memory) {
    return 0;
  }

  if (memory.tags.includes('pepe-session-summary')) {
    return memoryConfig.sessionSummary.mergeThreshold;
  }

  switch (memory.memoryKind) {
    case 'turn':
      return memoryConfig.turn.mergeThreshold;
    case 'summary':
      return memoryConfig.derivedSummary.mergeThreshold;
    case 'workflow':
      return memoryConfig.workflow.mergeThreshold;
    case 'knowledge':
      return memoryConfig.knowledge.mergeThreshold;
    default:
      return 0;
  }
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

/**
 * Select messages from the most recent N turns, grouped by turnId.
 *
 * Returns one compact summary string per turn, so that each turn contributes a
 * single entry to the recent-conversation context regardless of how many
 * messages it contains.  This prevents a single chatty turn from crowding
 * out context from neighbouring turns.
 */
function selectRecentContextMessages(
  sessionMessages: readonly SessionMessage[],
  turnLimit = RECENT_CONTEXT_MESSAGE_LIMIT,
): string[] {
  if (sessionMessages.length === 0) {
    return [];
  }

  // Group messages by turnId while preserving arrival order of the first
  // message for each turn.
  // Messages without a turnId (system context directives, tool results, etc.)
  // are grouped under "__unassigned__".  Individual message content is
  // truncated during formatting so the block stays bounded even for very
  // large tool-output runs.
  const turnMap = new Map<string, { messages: SessionMessage[]; firstSeenIndex: number }>();
  for (let i = 0; i < sessionMessages.length; i += 1) {
    const msg = sessionMessages[i]!;
    const key = msg.turnId ?? '__unassigned__';
    if (!turnMap.has(key)) {
      turnMap.set(key, { messages: [], firstSeenIndex: i });
    }
    turnMap.get(key)!.messages.push(msg);
  }

  // Pick the last `turnLimit` turns ordered by first appearance.
  const orderedTurns = [...turnMap.entries()]
    .sort((a, b) => b[1].firstSeenIndex - a[1].firstSeenIndex)
    .slice(0, turnLimit);

  return orderedTurns.flatMap(([turnId, { messages }]) => {
    const parts: string[] = [];
    const maxToolResults = 3;
    const maxContentLen = 500;
    let toolCount = 0;
    let skippedToolCount = 0;

    for (const m of messages) {
      switch (m.role) {
        case 'user':
          parts.push(`User: ${m.content}`);
          break;
        case 'assistant':
          parts.push(`Assistant: ${m.content}`);
          break;
        case 'tool': {
          toolCount++;
          if (toolCount <= maxToolResults) {
            const truncated = m.content && m.content.length > maxContentLen
              ? m.content.slice(0, maxContentLen) + '...'
              : m.content;
            const label = m.toolName || (m as any).name || 'tool';
            parts.push(`Tool result [${label}]: ${truncated}`);
          } else {
            skippedToolCount++;
          }
          break;
        }
      }
    }
    if (skippedToolCount > 0) {
      parts.push(`... and ${skippedToolCount} more tool result(s)`);
    }

    if (turnId === '__unassigned__') {
      return parts;
    }
    return [`Turn ${turnId}:\n${parts.join('\n')}`];
  });
}

function selectRecentUserMessagesForTargetDirectory(sessionMessages: readonly SessionMessage[]): SessionMessage[] {
  const recentUserMessages: SessionMessage[] = [];

  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index];
    if (message?.role !== 'user') {
      continue;
    }

    recentUserMessages.push(message);
    if (recentUserMessages.length >= TARGET_DIRECTORY_USER_MESSAGE_SCAN_LIMIT) {
      break;
    }
  }

  return recentUserMessages;
}
