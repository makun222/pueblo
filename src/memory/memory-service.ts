import { memoryQuerySchema, type MemoryQuery, type MemoryRecord, type MemoryScope } from '../shared/schema';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, type MemoryWeightPolicyConfig } from '../shared/config';
import { MemoryQueries } from './memory-queries';
import type { MemoryStore } from './memory-repository';
import type { CreateMemoryModelOptions } from './memory-model';
import type { WorkflowInstance } from '../shared/schema';
import {
  buildWorkflowPlanMemoryContent,
  buildWorkflowPlanMemoryTags,
  buildWorkflowPlanMemoryTitle,
  buildWorkflowTodoMemoryContent,
  buildWorkflowTodoMemoryTags,
  buildWorkflowTodoMemoryTitle,
} from './workflow-memory';
import type { PuebloPlanRound, PuebloPlanTask } from '../workflow/pueblo-plan/pueblo-plan-markdown';

const WORKSPACE_MEMORY_TITLE = 'Workspace Root';
const WORKSPACE_MEMORY_TAG = 'workspace-setting';
const PEPE_SESSION_SUMMARY_TAG = 'pepe-session-summary';
const MANUAL_PRIORITY_TAG_PREFIX = 'priority:';
const AUTO_PRIORITY_TAG_PREFIX = 'priority:auto:';
const PRIORITY_LEVELS = ['critical', 'high', 'normal', 'low'] as const;

export type MemoryPriority = typeof PRIORITY_LEVELS[number];

type MemoryPolicyOverrides = {
  readonly turn?: Partial<MemoryConfig['turn']>;
  readonly derivedSummary?: Partial<MemoryConfig['derivedSummary']>;
  readonly sessionSummary?: Partial<MemoryConfig['sessionSummary']>;
  readonly knowledge?: Partial<MemoryConfig['knowledge']>;
  readonly workflow?: Partial<MemoryConfig['workflow']>;
};

export class MemoryService {
  private readonly queries: MemoryQueries;
  private readonly policy: MemoryConfig;

  constructor(private readonly repository: MemoryStore, policy: MemoryPolicyOverrides = {}) {
    this.queries = new MemoryQueries(repository);
    this.policy = {
      turn: { ...DEFAULT_MEMORY_CONFIG.turn, ...policy.turn },
      derivedSummary: { ...DEFAULT_MEMORY_CONFIG.derivedSummary, ...policy.derivedSummary },
      sessionSummary: { ...DEFAULT_MEMORY_CONFIG.sessionSummary, ...policy.sessionSummary },
      knowledge: { ...DEFAULT_MEMORY_CONFIG.knowledge, ...policy.knowledge },
      workflow: { ...DEFAULT_MEMORY_CONFIG.workflow, ...policy.workflow },
    };
  }

  createMemory(title: string, content: string, scope: MemoryScope, options: CreateMemoryModelOptions = {}): MemoryRecord {
    const normalizedTags = normalizeMemoryPriorityTags(options.memoryKind ?? 'generic', options.tags ?? []);
    return this.repository.create(title, content, scope, {
      ...options,
      tags: normalizedTags,
      weight: options.weight ?? clampWeight(options.weight ?? 0, resolveWeightBounds(this.policy, options.memoryKind ?? 'generic', normalizedTags)),
    });
  }

  setMemoryWeight(memoryId: string, nextWeight: number, updatedAt = new Date().toISOString()): MemoryRecord {
    const memory = this.selectMemory(memoryId);
    const boundedWeight = clampWeight(nextWeight, resolveWeightBounds(this.policy, memory.memoryKind, memory.tags));
    return this.repository.save({
      ...memory,
      weight: boundedWeight,
      lastAccessedAt: updatedAt,
      updatedAt,
    });
  }

  adjustMemoryWeight(memoryId: string, delta: number, updatedAt = new Date().toISOString()): MemoryRecord {
    const memory = this.selectMemory(memoryId);
    return this.setMemoryWeight(memoryId, memory.weight + delta, updatedAt);
  }

  touchMemory(memoryId: string, options: { updatedAt?: string; delta?: number; weight?: number } = {}): MemoryRecord {
    if (typeof options.weight === 'number') {
      return this.setMemoryWeight(memoryId, options.weight, options.updatedAt ?? new Date().toISOString());
    }

    if (typeof options.delta === 'number') {
      return this.adjustMemoryWeight(memoryId, options.delta, options.updatedAt ?? new Date().toISOString());
    }

    const memory = this.selectMemory(memoryId);
    const updatedAt = options.updatedAt ?? new Date().toISOString();
    return this.repository.save({
      ...memory,
      lastAccessedAt: updatedAt,
      updatedAt,
    });
  }

  expireMemories(memoryIds: string[]): MemoryRecord[] {
    const now = new Date().toISOString();
    const updated: MemoryRecord[] = [];

    for (const memoryId of memoryIds) {
      const memory = this.repository.getById(memoryId);

      if (!memory || memory.status !== 'active') {
        continue;
      }

      updated.push(this.repository.save({
        ...memory,
        status: 'expired',
        updatedAt: now,
      }));
    }

    return updated;
  }

  listMemories(): MemoryRecord[] {
    return this.queries.listMemories().filter((memory) => memory.status === 'active');
  }

  selectMemory(memoryId: string): MemoryRecord {
    const memory = this.repository.getById(memoryId);

    if (!memory || memory.status !== 'active') {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    return memory;
  }

  searchMemories(query: string | MemoryQuery): MemoryRecord[] {
    if (typeof query === 'string') {
      return this.queries.searchMemories(query).filter((memory) => memory.status === 'active');
    }

    const parsedQuery = memoryQuerySchema.parse(query);
    const structuredText = parsedQuery.text;
    let memories = structuredText
      ? this.listMemories().filter((memory) => matchesStructuredTextQuery(memory, structuredText))
      : this.listMemories();

    memories = memories.filter((memory) => memory.status === 'active');

    if (parsedQuery.sessionId) {
      memories = memories.filter((memory) => isMemoryVisibleToSession(memory, parsedQuery.sessionId ?? null));
    }

    if (parsedQuery.memoryKinds && parsedQuery.memoryKinds.length > 0) {
      const allowedKinds = new Set(parsedQuery.memoryKinds);
      memories = memories.filter((memory) => allowedKinds.has(memory.memoryKind));
    }

    const minWeight = parsedQuery.minWeight;
    if (typeof minWeight === 'number') {
      memories = memories.filter((memory) => memory.weight >= minWeight);
    }

    if (parsedQuery.lookbackTurns && parsedQuery.sessionId) {
      memories = filterMemoriesByLookbackTurns(memories, parsedQuery.sessionId, parsedQuery.lookbackTurns);
    }

    const sortedMemories = sortMemoriesForSearch(memories);
    if (!parsedQuery.maxResults) {
      return sortedMemories;
    }

    return sortedMemories.slice(0, parsedQuery.maxResults);
  }

  resolveMemorySelection(memoryIds: string[]): MemoryRecord[] {
    return memoryIds.flatMap((memoryId) => {
      try {
        return [this.selectMemory(memoryId)];
      } catch {
        return [];
      }
    });
  }

  reconcileWorkingMemoryIds(args: {
    readonly workingMemoryIds: string[];
    readonly incomingMemoryIds?: string[];
    readonly updatedAt?: string;
  }): string[] {
    const updatedAt = args.updatedAt ?? new Date().toISOString();
    const incomingMemoryIds = uniqueTags(args.incomingMemoryIds ?? []);
    const incomingMemoryIdSet = new Set(incomingMemoryIds);
    const retainedMemoryIds = this.resolveMemorySelection(args.workingMemoryIds)
      .flatMap((memory) => {
        if (memory.tags.includes('task-step-summary')) {
          return [];
        }

        if (incomingMemoryIdSet.has(memory.id)) {
          return [this.repository.save({
            ...memory,
            lastAccessedAt: updatedAt,
            updatedAt,
          }).id];
        }

        const policy = resolveWeightPolicy(this.policy, memory.memoryKind, memory.tags);
        const nextWeight = clampWeight(memory.weight - policy.decayPerTurn, policy);
        const updatedMemory = this.repository.save({
          ...memory,
          weight: nextWeight,
          lastAccessedAt: updatedAt,
          updatedAt,
        });

        if (nextWeight < policy.mergeThreshold) {
          return [];
        }

        return [updatedMemory.id];
      });

    return uniqueTags([...retainedMemoryIds, ...incomingMemoryIds]);
  }

  listSessionMemories(sessionId: string): MemoryRecord[] {
    return this.listMemories().filter((memory) => memory.sourceSessionId === sessionId);
  }

  getWorkspaceMemory(): MemoryRecord | null {
    return this.listMemories()
      .filter((memory) => memory.scope === 'global' && memory.tags.includes(WORKSPACE_MEMORY_TAG))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  getWorkspacePath(): string | null {
    const memory = this.getWorkspaceMemory();
    if (!memory) {
      return null;
    }

    const workspaceLine = memory.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('workspace:'));

    if (!workspaceLine) {
      return null;
    }

    const workspacePath = workspaceLine.slice('workspace:'.length).trim();
    return workspacePath.length > 0 ? workspacePath : null;
  }

  setWorkspacePath(workspacePath: string): MemoryRecord {
    const normalizedWorkspacePath = workspacePath.trim();
    if (!normalizedWorkspacePath) {
      throw new Error('Workspace path is required');
    }

    const now = new Date().toISOString();
    const existingWorkspaceMemories = this.listMemories()
      .filter((memory) => memory.scope === 'global' && memory.tags.includes(WORKSPACE_MEMORY_TAG))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
    const current = existingWorkspaceMemories[0] ?? null;

    for (const staleMemory of existingWorkspaceMemories.slice(1)) {
      this.repository.save({
        ...staleMemory,
        status: 'expired',
        updatedAt: now,
      });
    }

    if (current) {
      return this.repository.save({
        ...current,
        title: WORKSPACE_MEMORY_TITLE,
        content: `workspace: ${normalizedWorkspacePath}`,
        memoryKind: 'workspace-setting',
        scope: 'global',
        tags: uniqueTags([...current.tags, WORKSPACE_MEMORY_TAG, 'persistent-setting']),
        lastAccessedAt: now,
        updatedAt: now,
      });
    }

    return this.createMemory(
      WORKSPACE_MEMORY_TITLE,
      `workspace: ${normalizedWorkspacePath}`,
      'global',
      {
        type: 'long-term',
        memoryKind: 'workspace-setting',
        tags: [WORKSPACE_MEMORY_TAG, 'persistent-setting'],
        weight: this.policy.knowledge.initialWeight,
      },
    );
  }

  createConversationTurnMemory(args: {
    readonly sessionId: string;
    readonly turnNumber: number;
    readonly userInput: string;
    readonly assistantOutput: string;
    readonly turnId?: string;
  }): MemoryRecord {
    return this.createMemory(
      `Turn ${args.turnNumber}`,
      ['User:', args.userInput.trim(), '', 'Assistant:', args.assistantOutput.trim()].join('\n'),
      'session',
      {
        tags: args.turnId ? ['conversation-turn', 'auto-captured', `turn:${args.turnId}`] : ['conversation-turn', 'auto-captured'],
        memoryKind: 'turn',
        derivationType: 'manual',
        sourceSessionId: args.sessionId,
        weight: this.policy.turn.initialWeight,
      },
    );
  }

  createDerivedSummaryMemory(args: {
    readonly sessionId: string;
    readonly parentMemory: MemoryRecord;
    readonly summary: string;
  }): MemoryRecord {
    const now = new Date().toISOString();
    const existing = this.listSessionMemories(args.sessionId)
      .find((memory) => memory.parentId === args.parentMemory.id && memory.tags.includes('pepe-summary') && memory.status === 'active') ?? null;
    const title = `Summary: ${args.parentMemory.title}`;
    const content = args.summary.trim();

    if (existing) {
      return this.repository.save({
        ...existing,
        title,
        content,
        memoryKind: 'summary',
        type: args.parentMemory.type,
        tags: normalizeMemoryPriorityTags('summary', [...existing.tags, 'pepe-summary', 'semantic-summary']),
        weight: clampWeight(existing.weight > 0 ? existing.weight : this.policy.derivedSummary.initialWeight, resolveWeightBounds(this.policy, 'summary', existing.tags)),
        lastAccessedAt: now,
        updatedAt: now,
      });
    }

    return this.createMemory(
      title,
      content,
      args.parentMemory.scope,
      {
        type: args.parentMemory.type,
        memoryKind: 'summary',
        tags: uniqueTags(['pepe-summary', 'semantic-summary']),
        parentId: args.parentMemory.id,
        derivationType: 'summary',
        summaryDepth: args.parentMemory.summaryDepth + 1,
        sourceSessionId: args.sessionId,
        weight: this.policy.derivedSummary.initialWeight,
        lastAccessedAt: now,
      },
    );
  }

  getSessionSummaryMemory(sessionId: string): MemoryRecord | null {
    return this.listSessionMemories(sessionId)
      .filter((memory) => memory.tags.includes(PEPE_SESSION_SUMMARY_TAG))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  upsertSessionSummaryMemory(args: {
    readonly sessionId: string;
    readonly summaries: readonly MemoryRecord[];
  }): MemoryRecord | null {
    const sourceSummaries = args.summaries
      .filter((memory) => memory.tags.includes('pepe-summary') && !memory.tags.includes(PEPE_SESSION_SUMMARY_TAG))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title));

    if (sourceSummaries.length === 0) {
      return null;
    }

    const now = new Date().toISOString();
    const existing = this.getSessionSummaryMemory(args.sessionId);
    const nextContent = buildSessionSummaryContent(sourceSummaries);
    const tags = ['pepe-summary', PEPE_SESSION_SUMMARY_TAG, 'semantic-summary', 'auto-captured'];

    if (existing) {
      const normalizedTags = normalizeMemoryPriorityTags('summary', [...existing.tags, ...tags]);
      return this.repository.save({
        ...existing,
        title: 'Session Summary',
        content: nextContent,
        memoryKind: 'summary',
        tags: normalizedTags,
        weight: clampWeight(existing.weight > 0 ? existing.weight : this.policy.sessionSummary.initialWeight, resolveWeightBounds(this.policy, 'summary', normalizedTags)),
        lastAccessedAt: now,
        updatedAt: now,
      });
    }

    return this.createMemory(
      'Session Summary',
      nextContent,
      'session',
      {
        type: 'short-term',
        memoryKind: 'summary',
        tags,
        derivationType: 'summary',
        summaryDepth: 1,
        sourceSessionId: args.sessionId,
        weight: this.policy.sessionSummary.initialWeight,
        lastAccessedAt: now,
      },
    );
  }

  createWorkflowPlanMemory(args: {
    readonly workflow: WorkflowInstance;
    readonly sessionId: string;
  }): MemoryRecord {
    return this.upsertWorkflowMemory(
      buildWorkflowPlanMemoryTitle(args.workflow),
      buildWorkflowPlanMemoryContent(args.workflow),
      args.sessionId,
      buildWorkflowPlanMemoryTags(args.workflow.type),
    );
  }

  createWorkflowTodoMemory(args: {
    readonly workflow: WorkflowInstance;
    readonly sessionId: string;
    readonly round: PuebloPlanRound;
    readonly tasks: PuebloPlanTask[];
  }): MemoryRecord {
    return this.upsertWorkflowMemory(
      buildWorkflowTodoMemoryTitle({ workflow: args.workflow, round: args.round }),
      buildWorkflowTodoMemoryContent({ workflow: args.workflow, round: args.round, tasks: args.tasks }),
      args.sessionId,
      buildWorkflowTodoMemoryTags(args.workflow.type),
    );
  }

  private upsertWorkflowMemory(
    title: string,
    content: string,
    sessionId: string,
    tags: string[],
  ): MemoryRecord {
    const now = new Date().toISOString();
    const mergeKey = resolveWorkflowMergeKey(content, tags);
    const matches = mergeKey
      ? this.listMemories()
        .filter((memory) => memory.memoryKind === 'workflow' && memory.sourceSessionId === sessionId)
        .filter((memory) => resolveWorkflowMergeKey(memory.content, memory.tags) === mergeKey)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      : [];
    const current = matches[0] ?? null;

    for (const staleMemory of matches.slice(1)) {
      this.repository.save({
        ...staleMemory,
        status: 'expired',
        updatedAt: now,
      });
    }

    if (!current) {
      return this.createMemory(
        title,
        content,
        'session',
        {
          memoryKind: 'workflow',
          tags,
          sourceSessionId: sessionId,
          weight: this.policy.workflow.initialWeight,
        },
      );
    }

    const mergedTags = normalizeMemoryPriorityTags('workflow', [...current.tags, ...tags]);
    return this.repository.save({
      ...current,
      title,
      content,
      scope: 'session',
      memoryKind: 'workflow',
      tags: mergedTags,
      sourceSessionId: sessionId,
      weight: clampWeight(Math.max(current.weight, this.policy.workflow.initialWeight), resolveWeightBounds(this.policy, 'workflow', mergedTags)),
      lastAccessedAt: now,
      updatedAt: now,
    });
  }
}

export function resolveMemoryPriority(memory: Pick<MemoryRecord, 'memoryKind' | 'tags'> | undefined): MemoryPriority {
  const manualPriority = findPriorityTag(memory?.tags ?? [], MANUAL_PRIORITY_TAG_PREFIX);
  if (manualPriority) {
    return manualPriority;
  }

  const autoPriority = findPriorityTag(memory?.tags ?? [], AUTO_PRIORITY_TAG_PREFIX);
  if (autoPriority) {
    return autoPriority;
  }

  if (memory?.tags.includes(PEPE_SESSION_SUMMARY_TAG) || memory?.memoryKind === 'workflow' || memory?.tags.includes('workflow')) {
    return 'high';
  }

  return 'normal';
}

export function resolveMemoryPriorityRank(memory: Pick<MemoryRecord, 'memoryKind' | 'tags'> | undefined): number {
  return priorityRank(resolveMemoryPriority(memory));
}

function sortMemoriesForSearch(memories: readonly MemoryRecord[]): MemoryRecord[] {
  return [...memories].sort((left, right) => {
    return resolveMemoryPriorityRank(right) - resolveMemoryPriorityRank(left)
      || right.weight - left.weight
      || compareDateDesc(right.updatedAt, left.updatedAt)
      || compareDateDesc(right.createdAt, left.createdAt);
  });
}

function resolveWeightBounds(
  policy: MemoryConfig,
  memoryKind: MemoryRecord['memoryKind'],
  tags: readonly string[] = [],
): Pick<MemoryWeightPolicyConfig, 'minWeight' | 'maxWeight'> {
  return resolveWeightPolicy(policy, memoryKind, tags);
}

function resolveWeightPolicy(
  policy: MemoryConfig,
  memoryKind: MemoryRecord['memoryKind'],
  tags: readonly string[] = [],
): MemoryWeightPolicyConfig {
  if (tags.includes(PEPE_SESSION_SUMMARY_TAG)) {
    return policy.sessionSummary;
  }

  switch (memoryKind) {
    case 'turn':
      return policy.turn;
    case 'summary':
      return policy.derivedSummary;
    case 'workflow':
      return policy.workflow;
    case 'knowledge':
      return policy.knowledge;
    default:
      return {
        minWeight: 0,
        maxWeight: 1,
        initialWeight: 0,
        decayPerTurn: 0,
        mergeThreshold: 0,
        defaultAdjustmentDelta: 0,
      };
  }
}

function clampWeight(value: number, bounds: Pick<MemoryWeightPolicyConfig, 'minWeight' | 'maxWeight'>): number {
  return Number(Math.min(bounds.maxWeight, Math.max(bounds.minWeight, value)).toFixed(4));
}

function isMemoryVisibleToSession(memory: MemoryRecord, sessionId: string | null): boolean {
  if (memory.scope !== 'session') {
    return true;
  }

  return memory.sourceSessionId === sessionId;
}

function filterMemoriesByLookbackTurns(memories: readonly MemoryRecord[], sessionId: string, lookbackTurns: number): MemoryRecord[] {
  const turnNumbers = memories
    .filter((memory) => memory.sourceSessionId === sessionId)
    .map((memory) => extractMemoryTurnNumber(memory))
    .filter((turnNumber): turnNumber is number => turnNumber !== null);

  const latestTurnNumber = turnNumbers.length > 0 ? Math.max(...turnNumbers) : null;
  if (latestTurnNumber === null) {
    return [...memories];
  }

  const minimumTurnNumber = Math.max(1, latestTurnNumber - lookbackTurns + 1);
  return memories.filter((memory) => {
    if (memory.sourceSessionId !== sessionId) {
      return true;
    }

    if (memory.memoryKind !== 'turn' && memory.memoryKind !== 'summary') {
      return true;
    }

    const turnNumber = extractMemoryTurnNumber(memory);
    if (turnNumber === null) {
      return true;
    }

    return turnNumber >= minimumTurnNumber;
  });
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

function normalizeMemoryPriorityTags(memoryKind: MemoryRecord['memoryKind'], tags: readonly string[]): string[] {
  const baseTags = uniqueTags(tags.filter((tag) => !isPriorityTag(tag)));
  const manualPriority = findPriorityTag(tags, MANUAL_PRIORITY_TAG_PREFIX);
  const autoPriority = inferAutoPriority(memoryKind, baseTags);

  if (manualPriority && autoPriority) {
    return [...baseTags, `${MANUAL_PRIORITY_TAG_PREFIX}${manualPriority}`, `${AUTO_PRIORITY_TAG_PREFIX}${autoPriority}`];
  }

  if (manualPriority) {
    return [...baseTags, `${MANUAL_PRIORITY_TAG_PREFIX}${manualPriority}`];
  }

  if (autoPriority) {
    return [...baseTags, `${AUTO_PRIORITY_TAG_PREFIX}${autoPriority}`];
  }

  return baseTags;
}

function inferAutoPriority(memoryKind: MemoryRecord['memoryKind'], tags: readonly string[]): MemoryPriority | null {
  if (tags.includes(PEPE_SESSION_SUMMARY_TAG) || memoryKind === 'workflow' || tags.includes('workflow')) {
    return 'high';
  }

  return null;
}

function isPriorityTag(tag: string): boolean {
  return tag.startsWith(MANUAL_PRIORITY_TAG_PREFIX) || tag.startsWith(AUTO_PRIORITY_TAG_PREFIX);
}

function findPriorityTag(tags: readonly string[], prefix: string): MemoryPriority | null {
  for (const level of PRIORITY_LEVELS) {
    if (tags.includes(`${prefix}${level}`)) {
      return level;
    }
  }

  return null;
}

function priorityRank(priority: MemoryPriority): number {
  switch (priority) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'normal':
      return 1;
    case 'low':
      return 0;
  }
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

function extractMemoryTurnNumber(memory: Pick<MemoryRecord, 'title' | 'tags'>): number | null {
  const tagMatch = memory.tags
    .map((tag) => /^turn:(?:.+-)?(\d+)$/.exec(tag)?.[1] ?? null)
    .find((match): match is string => Boolean(match));
  if (tagMatch) {
    return Number(tagMatch);
  }

  const titleMatch = /Turn\s+(\d+)/i.exec(memory.title);
  if (!titleMatch) {
    return null;
  }

  return Number(titleMatch[1]);
}

function matchesStructuredTextQuery(memory: Pick<MemoryRecord, 'title' | 'content'>, text: string): boolean {
  const terms = text
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
  if (terms.length === 0) {
    return true;
  }

  const haystack = `${memory.title}\n${memory.content}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function resolveWorkflowMergeKey(content: string, tags: readonly string[]): string | null {
  const workflowId = extractWorkflowMetadataValue(content, 'workflowId');
  const slot = resolveWorkflowMemorySlot(tags);

  if (!workflowId || !slot) {
    return null;
  }

  return `${slot}:${workflowId}`;
}

function resolveWorkflowMemorySlot(tags: readonly string[]): 'plan' | 'todo' | null {
  if (tags.includes('plan')) {
    return 'plan';
  }

  if (tags.includes('todo')) {
    return 'todo';
  }

  return null;
}

function extractWorkflowMetadataValue(content: string, fieldName: string): string | null {
  const prefix = `${fieldName}:`;
  const line = content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));

  if (!line) {
    return null;
  }

  const value = line.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function buildSessionSummaryContent(summaries: readonly MemoryRecord[]): string {
  return [
    'Session Summary',
    ...summaries.map((summary) => `- ${stripSummaryLabel(summary.title)}: ${inlineSummary(summary.content)}`),
  ].join('\n');
}

function stripSummaryLabel(title: string): string {
  return title.startsWith('Summary: ') ? title.slice('Summary: '.length).trim() : title.trim();
}

function inlineSummary(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}
