import type { AppConfig } from '../shared/config';
import type { AgentInstanceService } from './agent-instance-service';
import { mergeAgentTemplateWithPuebloProfile } from './agent-profile-templates';
import { PepeResultService } from './pepe-result-service';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryService } from '../memory/memory-service';
import type { PromptService } from '../prompts/prompt-service';
import type { ProviderRegistry } from '../providers/provider-registry';
import type { SessionService } from '../sessions/session-service';
import {
  contextCountSchema,
  type BackgroundSummaryStatus,
  type ContextCount,
  type ProviderProfile,
  type Session,
} from '../shared/schema';
import { selectRecentMessagesForPrompt } from './task-message-builder';
import { createTaskContext, formatSessionMessageForContext, type TaskContext } from './task-context';
import { PuebloProfileLoader } from './pueblo-profile';

export interface ResolveContextInput {
  readonly activeSessionId?: string | null;
  readonly explicitProviderId?: string | null;
  readonly explicitModelId?: string | null;
  readonly pendingUserInput?: string;
  readonly cwd?: string;
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
  readonly resolveBackgroundSummaryStatus?: (sessionId: string | null) => BackgroundSummaryStatus;
  readonly puebloProfileLoader?: PuebloProfileLoader;
}

export class ContextBudgetService {
  compute(args: {
    readonly puebloTexts: string[];
    readonly promptTexts: string[];
    readonly memoryTexts: string[];
    readonly recentMessages: string[];
    readonly pendingUserInput?: string;
    readonly modelContextWindow: number | null;
    readonly derivedMemoryCount: number;
  }): ContextCount {
    const textParts = [
      ...args.puebloTexts,
      ...args.promptTexts,
      ...args.memoryTexts,
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
      selectedMemoryCount: args.memoryTexts.length,
      derivedMemoryCount: args.derivedMemoryCount,
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
    const sessionMessages = session?.messageHistory ?? [];
    const recentMessages = sessionMessages.map(formatSessionMessageForContext);
    const promptRecentMessages = selectRecentMessagesForPrompt(recentMessages);
    const targetDirectory = resolveTargetDirectory({
      pendingUserInput: input.pendingUserInput,
      sessionMessages,
    });
    const resolvedPepeResult = this.pepeResultService.resolve({
      sessionId: session?.id ?? input.activeSessionId ?? null,
      agentInstanceId: agentInstance?.id ?? null,
      selectedMemoryIds: session?.selectedMemoryIds ?? [],
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
      ],
      promptTexts: prompts.map((prompt) => prompt.content),
      memoryTexts: resolvedPepeResult.resultItems.map((item) => item.summary),
      recentMessages: promptRecentMessages,
      pendingUserInput: input.pendingUserInput,
      modelContextWindow: selection.model?.contextWindow ?? null,
      derivedMemoryCount: resolvedPepeResult.sourceMemories.filter((memory) => memory.derivationType === 'summary' || memory.summaryDepth > 0).length,
    });
    const backgroundSummaryStatus = this.dependencies.resolveBackgroundSummaryStatus?.(session?.id ?? input.activeSessionId ?? null) ?? {
      state: 'idle',
      activeSummarySessionId: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    };
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
      resultSet: resolvedPepeResult.resultSet,
      resultItems: resolvedPepeResult.resultItems,
      sessionMessages,
      recentMessages,
      puebloProfile,
      contextCount,
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
        selectedPromptCount: prompts.length,
        selectedMemoryCount: resolvedPepeResult.resultItems.length,
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

  return null;
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