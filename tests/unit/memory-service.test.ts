import { describe, expect, it } from 'vitest';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { MemoryService } from '../../src/memory/memory-service';
import { DEFAULT_MEMORY_CONFIG } from '../../src/shared/config';

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
      ...DEFAULT_MEMORY_CONFIG,
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

  it('updates a single session summary memory in place', () => {
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

  it('decays older working memories and prunes ones below threshold', () => {
    const service = new MemoryService(new InMemoryMemoryRepository(), {
      ...DEFAULT_MEMORY_CONFIG,
      turn: {
        ...DEFAULT_MEMORY_CONFIG.turn,
        decayPerTurn: 0.2,
        mergeThreshold: 0.5,
      },
      workflow: {
        ...DEFAULT_MEMORY_CONFIG.workflow,
        decayPerTurn: 0.05,
        mergeThreshold: 0.4,
      },
    });
    const turnMemory = service.createConversationTurnMemory({
      sessionId: 'session-1',
      turnNumber: 1,
      userInput: 'Inspect sqlite persistence',
      assistantOutput: 'SQLite is the source of truth.',
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
      workflow: {
        id: 'workflow-1',
        type: 'pueblo-plan',
        status: 'round-active',
        sessionId: 'session-1',
        agentInstanceId: null,
        goal: 'Ship the fix',
        targetDirectory: null,
        runtimePlanPath: '.plans/fix.plan.md',
        deliverablePlanPath: null,
        activePlanMemoryId: null,
        activeTodoMemoryId: null,
        activeRoundNumber: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
      },
      sessionId: 'session-1',
      round: {
        roundNumber: 1,
        taskIds: ['T1'],
        status: 'active',
        summary: null,
      },
      tasks: [{ id: 'T1', title: 'Fix memory growth', parentId: null, status: 'pending' }],
    });

    const reconciledIds = service.reconcileWorkingMemoryIds({
      workingMemoryIds: [turnMemory.id, stepMemory.id, workflowMemory.id],
      incomingMemoryIds: ['memory-new-turn'],
    });

    expect(reconciledIds).toContain('memory-new-turn');
    expect(reconciledIds).toContain(workflowMemory.id);
    expect(reconciledIds).toContain(turnMemory.id);
    expect(reconciledIds).not.toContain(stepMemory.id);
    expect(service.selectMemory(turnMemory.id).weight).toBe(0.6);
    expect(service.selectMemory(workflowMemory.id).weight).toBe(0.95);
  });
});
