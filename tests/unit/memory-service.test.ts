import { describe, expect, it } from 'vitest';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { MemoryService } from '../../src/memory/memory-service';
import { DEFAULT_MEMORY_CONFIG } from '../../src/shared/config';
import type { WorkflowInstance } from '../../src/shared/schema';
import type { PuebloPlanRound, PuebloPlanTask } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';

describe('memory service', () => {
  it('searches active memories by content', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    service.createMemory('SQLite note', 'remember sqlite session storage', 'project');

    const matches = service.searchMemories('sqlite');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.title).toBe('SQLite note');
  });

  it('assigns configurable turn weight and allows external weight updates', () => {
    const service = new MemoryService(new InMemoryMemoryRepository(), {
      turn: {
        ...DEFAULT_MEMORY_CONFIG.turn,
        initialWeight: 0.73,
      },
    });

    const turnMemory = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Inspect the failure',
      assistantOutput: 'I found the issue.',
    });

    expect(turnMemory.memoryKind).toBe('turn');
    expect(turnMemory.derivationType).toBe('manual');
    expect(turnMemory.weight).toBe(0.73);

    const raised = service.adjustMemoryWeight(turnMemory.id, 0.2);
    expect(raised.weight).toBe(0.93);

    const lowered = service.setMemoryWeight(turnMemory.id, -1);
    expect(lowered.weight).toBe(0);
  });

  it('tags conversation turn memory with turn:${turnId} when turnId is provided', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const turnMemory = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Test input',
      assistantOutput: 'Test output',
      turnId: 'turn-abc-123',
    });

    expect(turnMemory.tags).toContain('conversation-turn');
    expect(turnMemory.tags).toContain('auto-captured');
    expect(turnMemory.tags).toContain('turn:turn-abc-123');
  });

  it('does not add turn tag when turnId is not provided', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const turnMemory = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Test input',
      assistantOutput: 'Test output',
    });

    expect(turnMemory.tags).toContain('conversation-turn');
    expect(turnMemory.tags).toContain('auto-captured');
    expect(turnMemory.tags.some((tag) => tag.startsWith('turn:'))).toBe(false);
  });

  it('upserts the session summary memory from derived summaries', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const turnOne = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Inspect sqlite persistence',
      assistantOutput: 'SQLite is the source of truth.',
    });
    const turnTwo = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 2,
      userInput: 'Inspect memory growth',
      assistantOutput: 'Pepe summaries are bloating selection.',
    });
    const summaryOne = service.createDerivedSummaryMemory({
      sessionId: 'session-1',
      parentMemory: turnOne,
      summary: 'SQLite remains the authoritative persistence layer.',
    });
    const summaryTwo = service.createDerivedSummaryMemory({
      sessionId: 'session-1',
      parentMemory: turnTwo,
      summary: 'Session selection is growing too aggressively.',
    });

    const firstSessionSummary = service.upsertSessionSummaryMemory({
      sessionId: 'session-1',
      summaries: [summaryOne],
    });
    const secondSessionSummary = service.upsertSessionSummaryMemory({
      sessionId: 'session-1',
      summaries: [summaryOne, summaryTwo],
    });

    expect(firstSessionSummary).toBeTruthy();
    expect(secondSessionSummary).toBeTruthy();
    expect(secondSessionSummary?.id).toBe(firstSessionSummary?.id);
    expect(secondSessionSummary?.tags).toContain('pepe-session-summary');
    expect(secondSessionSummary?.content).toContain('Turn 1');
    expect(secondSessionSummary?.content).toContain('Turn 2');
  });

  it('applies lifecycle defaults across turn, derived summary, session summary, workflow, and knowledge memories', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const workflow = createWorkflowInstance({ id: 'workflow-1', sessionId: 'session-1' });
    const turnMemory = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Inspect sqlite persistence',
      assistantOutput: 'SQLite is the source of truth.',
    });
    const derivedSummary = service.createDerivedSummaryMemory({
      sessionId: 'session-1',
      parentMemory: turnMemory,
      summary: 'SQLite is still the primary persistence layer.',
    });
    const sessionSummary = service.upsertSessionSummaryMemory({
      sessionId: 'session-1',
      summaries: [derivedSummary],
    });
    const workflowMemory = service.createWorkflowPlanMemory({
      workflow,
      sessionId: 'session-1',
    });
    const knowledgeMemory = service.createMemory(
      'Architecture Decision',
      'Reusable architecture invariant for sqlite and sessions.',
      'project',
      {
        type: 'long-term',
        memoryKind: 'knowledge',
        tags: ['knowledge-base'],
        sourceSessionId: 'session-1',
        weight: DEFAULT_MEMORY_CONFIG.knowledge.initialWeight,
      },
    );

    expect(turnMemory.weight).toBe(DEFAULT_MEMORY_CONFIG.turn.initialWeight);
    expect(derivedSummary.weight).toBe(DEFAULT_MEMORY_CONFIG.derivedSummary.initialWeight);
    expect(sessionSummary?.weight).toBe(DEFAULT_MEMORY_CONFIG.sessionSummary.initialWeight);
    expect(workflowMemory.weight).toBe(DEFAULT_MEMORY_CONFIG.workflow.initialWeight);
    expect(knowledgeMemory.weight).toBe(DEFAULT_MEMORY_CONFIG.knowledge.initialWeight);
    expect(sessionSummary?.tags).toContain('pepe-session-summary');
    expect(workflowMemory.tags).toEqual(expect.arrayContaining(['workflow', 'plan', 'workflow:pueblo-plan']));

    const selectedIds = service.resolveMemorySelection([
      turnMemory.id,
      derivedSummary.id,
      sessionSummary?.id ?? '',
      workflowMemory.id,
      knowledgeMemory.id,
    ]).map((memory) => memory.id);
    expect(selectedIds).toEqual([
      turnMemory.id,
      derivedSummary.id,
      sessionSummary?.id,
      workflowMemory.id,
      knowledgeMemory.id,
    ]);

    const searchMatches = service.searchMemories('Reusable architecture invariant');
    expect(searchMatches.map((memory) => memory.id)).toContain(knowledgeMemory.id);
  });

  it('decays working memories with kind-specific policies and prunes task-step summaries', () => {
    const service = new MemoryService(new InMemoryMemoryRepository(), {
      turn: {
        ...DEFAULT_MEMORY_CONFIG.turn,
        decayPerTurn: 0.2,
        mergeThreshold: 0.5,
      },
      derivedSummary: {
        ...DEFAULT_MEMORY_CONFIG.derivedSummary,
        decayPerTurn: 0.08,
        mergeThreshold: 0.5,
      },
      sessionSummary: {
        ...DEFAULT_MEMORY_CONFIG.sessionSummary,
        decayPerTurn: 0.05,
        mergeThreshold: 0.8,
      },
      workflow: {
        ...DEFAULT_MEMORY_CONFIG.workflow,
        decayPerTurn: 0.05,
        mergeThreshold: 0.4,
      },
      knowledge: {
        ...DEFAULT_MEMORY_CONFIG.knowledge,
        decayPerTurn: 0.02,
        mergeThreshold: 0.4,
      },
    });
    const workflow = createWorkflowInstance({ id: 'workflow-1', sessionId: 'session-1' });
    const turnMemory = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Inspect sqlite persistence',
      assistantOutput: 'SQLite is the source of truth.',
    });
    const derivedSummary = service.createDerivedSummaryMemory({
      sessionId: 'session-1',
      parentMemory: turnMemory,
      summary: 'SQLite remains authoritative.',
    });
    const sessionSummary = service.upsertSessionSummaryMemory({
      sessionId: 'session-1',
      summaries: [derivedSummary],
    });
    const stepMemory = service.createMemory('Legacy step summary', 'Step 1\n- tool-result / read / call-1: Read succeeded', 'session', {
      type: 'short-term',
      memoryKind: 'summary',
      tags: ['task-step-summary', 'auto-captured'],
      parentId: turnMemory.id,
      derivationType: 'summary',
      summaryDepth: 1,
      sourceSessionId: 'session-1',
      weight: 0.65,
    });
    const workflowMemory = service.createWorkflowTodoMemory({
      workflow,
      sessionId: 'session-1',
      round: createRound(1),
      tasks: createTasks('T1', 'Fix memory growth'),
    });
    const knowledgeMemory = service.createMemory('Shared repo fact', 'Knowledge persists across sessions.', 'project', {
      type: 'long-term',
      memoryKind: 'knowledge',
      tags: ['knowledge-base'],
      sourceSessionId: 'session-1',
      weight: DEFAULT_MEMORY_CONFIG.knowledge.initialWeight,
    });

    const reconciledIds = service.reconcileWorkingMemoryIds({
      workingMemoryIds: [
        turnMemory.id,
        derivedSummary.id,
        sessionSummary?.id ?? '',
        stepMemory.id,
        workflowMemory.id,
        knowledgeMemory.id,
      ],
    });

    expect(reconciledIds).toContain(turnMemory.id);
    expect(reconciledIds).toContain(derivedSummary.id);
    expect(reconciledIds).toContain(sessionSummary?.id);
    expect(reconciledIds).toContain(workflowMemory.id);
    expect(reconciledIds).toContain(knowledgeMemory.id);
    expect(reconciledIds).not.toContain(stepMemory.id);
    expect(service.selectMemory(turnMemory.id).weight).toBe(0.6);
    expect(service.selectMemory(derivedSummary.id).weight).toBe(0.57);
    expect(service.selectMemory(sessionSummary?.id ?? '').weight).toBe(0.85);
    expect(service.selectMemory(workflowMemory.id).weight).toBe(0.95);
    expect(service.selectMemory(knowledgeMemory.id).weight).toBe(0.98);
  });

  it('upserts workflow memories by workflow identity within a session', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const initialWorkflow = createWorkflowInstance({ id: 'workflow-1', sessionId: 'session-1', status: 'round-active', activeRoundNumber: 1 });
    const updatedWorkflow = createWorkflowInstance({ id: 'workflow-1', sessionId: 'session-1', status: 'completed', activeRoundNumber: 2 });
    const otherSessionWorkflow = createWorkflowInstance({ id: 'workflow-1', sessionId: 'session-2', status: 'round-active', activeRoundNumber: 1 });

    const firstPlan = service.createWorkflowPlanMemory({ workflow: initialWorkflow, sessionId: 'session-1' });
    service.setMemoryWeight(firstPlan.id, 0.6, '2026-06-10T00:00:00.000Z');
    const secondPlan = service.createWorkflowPlanMemory({ workflow: updatedWorkflow, sessionId: 'session-1' });
    const firstTodo = service.createWorkflowTodoMemory({
      workflow: initialWorkflow,
      sessionId: 'session-1',
      round: createRound(1),
      tasks: createTasks('T1', 'Wire workflow memory'),
    });
    const secondTodo = service.createWorkflowTodoMemory({
      workflow: updatedWorkflow,
      sessionId: 'session-1',
      round: createRound(2),
      tasks: createTasks('T2', 'Validate workflow merge'),
    });
    const otherSessionPlan = service.createWorkflowPlanMemory({ workflow: otherSessionWorkflow, sessionId: 'session-2' });

    expect(secondPlan.id).toBe(firstPlan.id);
    expect(secondPlan.content).toContain('status: completed');
    expect(secondPlan.content).toContain('activeRoundNumber: 2');
    expect(secondPlan.weight).toBe(DEFAULT_MEMORY_CONFIG.workflow.initialWeight);
    expect(secondTodo.id).toBe(firstTodo.id);
    expect(secondTodo.content).toContain('roundNumber: 2');
    expect(secondTodo.content).toContain('- T2: Validate workflow merge');
    expect(otherSessionPlan.id).not.toBe(firstPlan.id);

    const sessionOneWorkflowMemories = service.listSessionMemories('session-1').filter((memory) => memory.memoryKind === 'workflow');
    const sessionTwoWorkflowMemories = service.listSessionMemories('session-2').filter((memory) => memory.memoryKind === 'workflow');

    expect(sessionOneWorkflowMemories.map((memory) => memory.id)).toEqual([secondPlan.id, secondTodo.id]);
    expect(sessionTwoWorkflowMemories.map((memory) => memory.id)).toEqual([otherSessionPlan.id]);
  });

  it('assigns auto priority tags and preserves manual priority overrides', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const workflow = createWorkflowInstance({ id: 'workflow-priority', sessionId: 'session-1' });
    const workflowMemory = service.createWorkflowPlanMemory({ workflow, sessionId: 'session-1' });
    const manualPriorityMemory = service.createMemory('Manual priority', 'Manual priority should persist.', 'project', {
      memoryKind: 'workflow',
      tags: ['workflow', 'plan', 'priority:low'],
      weight: 0.8,
    });

    expect(workflowMemory.tags).toContain('priority:auto:high');
    expect(manualPriorityMemory.tags).toContain('priority:low');
    expect(manualPriorityMemory.tags).toContain('priority:auto:high');
  });

  it('supports structured MemoryQuery filters with stable ordering', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const oldTurn = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Initial question',
      assistantOutput: 'Initial answer',
    });
    const recentTurn = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 5,
      userInput: 'Recent question',
      assistantOutput: 'Recent answer',
    });
    const recentSummary = service.createDerivedSummaryMemory({
      sessionId: 'session-1',
      parentMemory: recentTurn,
      summary: 'Recent summary should remain eligible.',
    });
    const knowledge = service.createMemory('Shared invariant', 'Shared architecture invariant.', 'project', {
      type: 'long-term',
      memoryKind: 'knowledge',
      weight: 0.92,
    });

    service.touchMemory(oldTurn.id, { updatedAt: '2026-06-01T00:00:00.000Z' });
    service.touchMemory(recentTurn.id, { updatedAt: '2026-06-05T00:00:00.000Z' });
    service.touchMemory(recentSummary.id, { updatedAt: '2026-06-06T00:00:00.000Z' });
    service.touchMemory(knowledge.id, { updatedAt: '2026-06-07T00:00:00.000Z' });

    const matches = service.searchMemories({
      text: 'answer invariant summary',
      sessionId: 'session-1',
      memoryKinds: ['summary', 'knowledge'],
      minWeight: 0.65,
      lookbackTurns: 2,
      maxResults: 2,
    });

    expect(matches.map((memory) => memory.id)).toEqual([knowledge.id, recentSummary.id]);
  });

  it('keeps string search backwards compatible after adding MemoryQuery support', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const memory = service.createMemory('SQLite note', 'remember sqlite session storage', 'project');

    const matches = service.searchMemories('sqlite');

    expect(matches.map((entry) => entry.id)).toEqual([memory.id]);
  });

  it('keeps session-local memories isolated while knowledge remains globally searchable', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    const workflow = createWorkflowInstance({ id: 'workflow-1', sessionId: 'session-a' });
    const turnA = service.createConversationTurnMemory({
      sessionId: 'session-a',
      turnNumber: 1,
      userInput: 'Inspect architecture',
      assistantOutput: 'Session A captured a design decision.',
    });
    const summaryA = service.createDerivedSummaryMemory({
      sessionId: 'session-a',
      parentMemory: turnA,
      summary: 'Session A summary should stay local.',
    });
    const sessionSummaryA = service.upsertSessionSummaryMemory({
      sessionId: 'session-a',
      summaries: [summaryA],
    });
    const workflowA = service.createWorkflowPlanMemory({ workflow, sessionId: 'session-a' });
    const knowledge = service.createMemory('Shared invariant', 'Reusable architecture invariant for session handoff.', 'project', {
      type: 'long-term',
      memoryKind: 'knowledge',
      tags: ['knowledge-base'],
      sourceSessionId: 'session-a',
      weight: DEFAULT_MEMORY_CONFIG.knowledge.initialWeight,
    });
    const turnB = service.createConversationTurnMemory({
      sessionId: 'session-b',
      turnNumber: 1,
      userInput: 'Continue work',
      assistantOutput: 'Session B should only see its own turn memory by session listing.',
    });

    const sessionBMemories = service.listSessionMemories('session-b');
    const globalKnowledgeMatches = service.searchMemories('Reusable architecture invariant');

    expect(sessionBMemories.map((memory) => memory.id)).toEqual([turnB.id]);
    expect(sessionBMemories.map((memory) => memory.id)).not.toContain(turnA.id);
    expect(sessionBMemories.map((memory) => memory.id)).not.toContain(summaryA.id);
    expect(sessionBMemories.map((memory) => memory.id)).not.toContain(sessionSummaryA?.id);
    expect(sessionBMemories.map((memory) => memory.id)).not.toContain(workflowA.id);
    expect(globalKnowledgeMatches.map((memory) => memory.id)).toContain(knowledge.id);
  });
});

function createWorkflowInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  const now = '2026-06-10T00:00:00.000Z';
  return {
    id: overrides.id ?? 'workflow-1',
    type: overrides.type ?? 'pueblo-plan',
    status: overrides.status ?? 'round-active',
    sessionId: overrides.sessionId ?? 'session-1',
    agentInstanceId: overrides.agentInstanceId ?? null,
    goal: overrides.goal ?? 'Ship the fix',
    targetDirectory: overrides.targetDirectory ?? null,
    runtimePlanPath: overrides.runtimePlanPath ?? '.plans/fix.plan.md',
    deliverablePlanPath: overrides.deliverablePlanPath ?? null,
    activePlanMemoryId: overrides.activePlanMemoryId ?? null,
    activeTodoMemoryId: overrides.activeTodoMemoryId ?? null,
    activeRoundNumber: overrides.activeRoundNumber ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? null,
    failedAt: overrides.failedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
  };
}

function createRound(roundNumber: number): PuebloPlanRound {
  return {
    roundNumber,
    taskIds: [`T${roundNumber}`],
    status: 'active',
    summary: null,
  };
}

function createTasks(id: string, title: string): PuebloPlanTask[] {
  return [{ id, title, parentId: null, status: 'pending' }];
}
