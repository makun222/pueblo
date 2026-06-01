import type { MemoryRecord, MemoryScope } from '../shared/schema';
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
    return this.repository.create(title, content, scope, {
      ...options,
      weight: options.weight ?? clampWeight(options.weight ?? 0, resolveWeightBounds(this.policy, options.memoryKind ?? 'generic', options.tags ?? [])),
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

  searchMemories(query: string): MemoryRecord[] {
    return this.queries.searchMemories(query).filter((memory) => memory.status === 'active');
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
  }): MemoryRecord {
    return this.createMemory(
      `Turn ${args.turnNumber}`,
      ['User:', args.userInput.trim(), '', 'Assistant:', args.assistantOutput.trim()].join('\n'),
      'session',
      {
        tags: ['conversation-turn', 'auto-captured'],
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
        tags: uniqueTags([...existing.tags, 'pepe-summary', 'semantic-summary']),
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
      return this.repository.save({
        ...existing,
        title: 'Session Summary',
        content: nextContent,
        memoryKind: 'summary',
        tags: uniqueTags([...existing.tags, ...tags]),
        weight: clampWeight(existing.weight > 0 ? existing.weight : this.policy.sessionSummary.initialWeight, resolveWeightBounds(this.policy, 'summary', tags)),
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
    return this.createMemory(
      buildWorkflowPlanMemoryTitle(args.workflow),
      buildWorkflowPlanMemoryContent(args.workflow),
      'session',
      {
        memoryKind: 'workflow',
        tags: buildWorkflowPlanMemoryTags(args.workflow.type),
        sourceSessionId: args.sessionId,
        weight: this.policy.workflow.initialWeight,
      },
    );
  }

  createWorkflowTodoMemory(args: {
    readonly workflow: WorkflowInstance;
    readonly sessionId: string;
    readonly round: PuebloPlanRound;
    readonly tasks: PuebloPlanTask[];
  }): MemoryRecord {
    return this.createMemory(
      buildWorkflowTodoMemoryTitle({ workflow: args.workflow, round: args.round }),
      buildWorkflowTodoMemoryContent({ workflow: args.workflow, round: args.round, tasks: args.tasks }),
      'session',
      {
        memoryKind: 'workflow',
        tags: buildWorkflowTodoMemoryTags(args.workflow.type),
        sourceSessionId: args.sessionId,
        weight: this.policy.workflow.initialWeight,
      },
    );
  }
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

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
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
