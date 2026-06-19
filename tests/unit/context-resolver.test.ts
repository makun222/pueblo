import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextResolver } from '../../src/agent/context-resolver';
import { InMemoryAgentInstanceRepository } from '../../src/agent/agent-instance-repository';
import { AgentInstanceService } from '../../src/agent/agent-instance-service';
import { AgentTemplateLoader } from '../../src/agent/agent-template-loader';
import { PepeResultService } from '../../src/agent/pepe-result-service';
import { MemoryService } from '../../src/memory/memory-service';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { PromptService } from '../../src/prompts/prompt-service';
import { InMemoryPromptRepository } from '../../src/prompts/prompt-repository';
import { InMemoryProviderAdapter } from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { InMemorySessionRepository } from '../../src/sessions/session-repository';
import { SessionService } from '../../src/sessions/session-service';
import { createTestAppConfig } from '../helpers/test-config';
import { WorkflowPlanStore } from '../../src/workflow/workflow-plan-store';
import { WorkflowExporter } from '../../src/workflow/workflow-exporter';
import { WorkflowRegistry } from '../../src/workflow/workflow-registry';
import { InMemoryWorkflowRepository } from '../../src/workflow/workflow-repository';
import { WorkflowService } from '../../src/workflow/workflow-service';
import { PUEBLO_PLAN_WORKFLOW_TYPE } from '../../src/workflow/pueblo-plan/pueblo-plan-workflow';
import { createWorkflowInstanceModel } from '../../src/workflow/workflow-model';
import { createInitialPuebloPlanOutline } from '../../src/workflow/pueblo-plan/pueblo-plan-planner';
import { applyTodoRound, selectNextTodoRound } from '../../src/workflow/pueblo-plan/pueblo-plan-rounds';
import { createInitialPuebloPlanDocument, renderPuebloPlanMarkdown } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';
import type { AgentTask } from '../../src/shared/schema';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('context resolver', () => {
  it('resolves pueblo profile, session-backed selections, and result-backed context counts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-resolver-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(tempDir, 'pueblo.md'), '# Role\n- focused agent\n# Summary Policy\n- Auto summarize near 75 percent\n');
    fs.mkdirSync(path.join(tempDir, 'puebl-profile', 'code-master'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'puebl-profile', 'code-master', 'agent.md'),
      [
        '# Profile',
        '- id: code-master',
        '- name: Code Master',
        '- description: Focused on shipping correct code changes with strong validation discipline.',
        '',
        '# Role',
        '- Act as a pragmatic senior software engineer.',
        '',
        '# Goals',
        '- Produce correct, testable code changes.',
        '',
        '# Constraints',
        '- Do not change unrelated behavior.',
        '',
        '# Style',
        '- Be concise, technical, and direct.',
        '',
        '# Memory Policy',
        '- Retain task-relevant implementation decisions as reusable memories.',
        '- Summary: Summarize completed code turns into compact reusable engineering notes.',
        '',
        '# Context Policy',
        '- Prioritize current code goal, selected memories, and active constraints.',
        '- Truncate: Drop stale conversational history before dropping explicit task memories.',
        '',
        '# Summary Policy',
        '- Auto summarize',
        '- Threshold: 12000',
        '- Lineage: Preserve engineering decisions as reusable session memories.',
        '',
      ].join('\n'),
    );

    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini');
    const prompt = promptService.createPrompt('Root cause', 'analysis', 'Always inspect the root cause first.');
    const memory = memoryService.createMemory('Repo fact', 'This repository uses sqlite persistence.', 'project');
    sessionService.addUserMessage(session.id, 'Inspect the failing workflow');
    sessionService.addAssistantMessage(session.id, 'I will inspect the failing workflow.');
    sessionService.addSelectedPrompt(session.id, prompt.id);
    sessionService.addSelectedMemory(session.id, memory.id);
    const pepeResultService = new PepeResultService(memoryService, createTestAppConfig({ defaultProviderId: 'openai' }).pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [memory.id],
      pendingUserInput: 'Inspect the failing workflow',
      resultItems: [
        {
          memoryId: memory.id,
          summary: 'Cached result: sqlite persistence is relevant.',
          similarity: 0.99,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
      ],
    });

    const resolver = new ContextResolver({
      config: createTestAppConfig({ defaultProviderId: 'openai' }),
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });
    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Inspect the failing workflow',
      cwd: tempDir,
    });

    expect(resolved.taskContext.puebloProfile.roleDirectives).toContain('focused agent');
    expect(resolved.taskContext.selectedPromptIds).toEqual([prompt.id]);
    expect(resolved.taskContext.selectedMemoryIds).toEqual([memory.id]);
    expect(resolved.taskContext.resultSet?.sessionId).toBe(session.id);
    expect(resolved.taskContext.targetDirectory).toBe(tempDir);
    expect(resolved.taskContext.resultItems).toHaveLength(1);
    expect(resolved.taskContext.resultItems[0]?.memoryId).toBe(memory.id);
    expect(resolved.taskContext.resultItems[0]?.summary).toContain('Cached result');
    expect(resolved.taskContext.sessionMessages).toHaveLength(2);
    expect(resolved.taskContext.recentMessages).toEqual([
      '__Unassigned__:\nUser: Inspect the failing workflow\nAssistant: I will inspect the failing workflow.',
    ]);
    expect(resolved.runtimeStatus.activeSessionId).toBe(session.id);
    expect(resolved.runtimeStatus.agentProfileId).toBe('code-master');
    expect(resolved.runtimeStatus.selectedPromptCount).toBe(1);
    expect(resolved.runtimeStatus.selectedMemoryCount).toBe(1);
    expect(resolved.runtimeStatus.selectedStepSummaryCount).toBe(0);
    expect(resolved.runtimeStatus.compactContextMode).toBe(false);
    expect(resolved.runtimeStatus.contextCount.messageCount).toBe(2);
    expect(resolved.runtimeStatus.contextCount.estimatedTokens).toBeGreaterThan(0);
    expect(resolved.runtimeStatus.contextCount.contextWindowLimit).toBe(16000);
  });

  it('surfaces active turn step context and compact mode in runtime status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-step-summary-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 80 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini');
    const pepeResultService = new PepeResultService(memoryService, createTestAppConfig({ defaultProviderId: 'openai' }).pepe);
    const taskRepository = {
      listBySession: () => [{
        id: 'task-1',
        goal: 'Inspect the failure',
        status: 'completed',
        sessionId: session.id,
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        inputContextSummary: '{}',
        outputSummary: JSON.stringify({
          outputSummary: 'Task completed',
          stepTrace: [{
            stepNumber: 1,
            type: 'tool-result',
            summary: `Read succeeded: ${'A'.repeat(60_000)}`,
            toolName: 'read',
            toolCallId: 'call-1',
          }],
        }),
        toolInvocationIds: [],
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }] satisfies AgentTask[],
    };

    const resolver = new ContextResolver({
      config: createTestAppConfig({ defaultProviderId: 'openai' }),
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
      taskRepository,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Inspect the failure',
      cwd: tempDir,
    });

    expect(resolved.runtimeStatus.selectedStepSummaryCount).toBe(1);
    expect(resolved.taskContext.activeTurnStepContext).toContain('Active turn step context:');
    expect(resolved.taskContext.activeTurnStepContext).toContain('tool-result / read / call-1');
    expect(resolved.runtimeStatus.compactContextMode).toBe(true);
  });

  it('prioritizes the selected session summary over per-turn Pepe summaries', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-session-summary-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({ defaultProviderId: 'openai' });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini');
    const turnMemory = memoryService.createConversationTurnMemory({
      sessionId: session.id,
      turnNumber: 1,
      userInput: 'Inspect sqlite persistence',
      assistantOutput: 'SQLite is the source of truth.',
    });
    const turnSummary = memoryService.createDerivedSummaryMemory({
      sessionId: session.id,
      parentMemory: turnMemory,
      summary: 'Turn summary: sqlite remains authoritative.',
    });
    const sessionSummary = memoryService.upsertSessionSummaryMemory({
      sessionId: session.id,
      summaries: [turnSummary],
    });
    sessionService.addSelectedMemory(session.id, turnMemory.id);
    sessionService.addSelectedMemory(session.id, sessionSummary!.id);

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [turnMemory.id, sessionSummary!.id],
      pendingUserInput: 'Inspect sqlite persistence',
      resultItems: [
        {
          memoryId: turnSummary.id,
          summary: 'Per-turn Pepe summary that should be superseded.',
          similarity: 0.99,
          sourceSessionId: session.id,
          vectorVersion: 'pepe-local-v1',
        },
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Inspect sqlite persistence',
      cwd: tempDir,
    });

    expect(resolved.taskContext.sessionSummaryMemories.map((memory) => memory.id)).toEqual([sessionSummary!.id]);
    expect(resolved.taskContext.resultItems).toHaveLength(0);
    expect(resolved.runtimeStatus.selectedMemoryCount).toBe(1);
    expect(resolved.runtimeStatus.contextCount.selectedMemoryCount).toBe(1);
  });

  it('injects at most one current-session summary and one related-session summary ahead of general memory results', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-cross-session-summary-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({ defaultProviderId: 'openai' });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const currentSession = sessionService.createSession('Current session', 'gpt-4.1-mini');
    const relatedSession = sessionService.createSession('Related session', 'gpt-4.1-mini');

    const currentTurn = memoryService.createConversationTurnMemory({
      sessionId: currentSession.id,
      turnNumber: 1,
      userInput: 'Track the current sqlite direction',
      assistantOutput: 'Keep sqlite as the source of truth.',
    });
    const currentTurnSummary = memoryService.createDerivedSummaryMemory({
      sessionId: currentSession.id,
      parentMemory: currentTurn,
      summary: 'Current turn summary that should be superseded by the session summary.',
    });
    const currentSessionSummary = memoryService.upsertSessionSummaryMemory({
      sessionId: currentSession.id,
      summaries: [currentTurnSummary],
    });

    const relatedTurn = memoryService.createConversationTurnMemory({
      sessionId: relatedSession.id,
      turnNumber: 1,
      userInput: 'Remember the earlier architecture decision',
      assistantOutput: 'Preserve sqlite persistence for local state.',
    });
    const relatedTurnSummary = memoryService.createDerivedSummaryMemory({
      sessionId: relatedSession.id,
      parentMemory: relatedTurn,
      summary: 'Related turn summary that should be superseded by the related session summary.',
    });
    const relatedSessionSummary = memoryService.upsertSessionSummaryMemory({
      sessionId: relatedSession.id,
      summaries: [relatedTurnSummary],
    });
    const genericMemory = memoryService.createMemory('Repo fact', 'General repo fact for recall ordering.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.55,
    });

    sessionService.addSelectedMemory(currentSession.id, currentSessionSummary!.id);

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: currentSession.id,
      agentInstanceId: null,
      selectedMemoryIds: [currentSessionSummary!.id],
      pendingUserInput: 'Recall the relevant summaries',
      resultItems: [
        {
          memoryId: relatedTurnSummary.id,
          summary: 'Related turn summary that should be dropped.',
          similarity: 0.99,
          sourceSessionId: relatedSession.id,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: relatedSessionSummary!.id,
          summary: 'Related session summary that should be promoted.',
          similarity: 0.98,
          sourceSessionId: relatedSession.id,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: genericMemory.id,
          summary: 'General repo fact remains available.',
          similarity: 0.5,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: currentSession.id,
      pendingUserInput: 'Recall the relevant summaries',
      cwd: tempDir,
    });

    expect(resolved.taskContext.sessionSummaryMemories.map((memory) => memory.id)).toEqual([
      currentSessionSummary!.id,
      relatedSessionSummary!.id,
    ]);
    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([genericMemory.id]);
    expect(resolved.runtimeStatus.contextCount.selectedMemoryCount).toBe(3);
  });

  it('sorts general result items by memory weight and then updatedAt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-weight-sort-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({ defaultProviderId: 'openai' });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Weight sort session', 'gpt-4.1-mini');
    const lowWeightNewer = memoryService.createMemory('Newer low weight', 'Lower weight but recently updated.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.2,
    });
    const highWeightOlder = memoryService.createMemory('Older high weight', 'Higher weight and should come first.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.9,
    });
    const sameWeightOlder = memoryService.createMemory('Same weight older', 'Same weight but older update.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.9,
    });
    const sameWeightNewer = memoryService.createMemory('Same weight newer', 'Same weight and newer update.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.9,
    });

    sessionService.addSelectedMemory(session.id, lowWeightNewer.id);
    sessionService.addSelectedMemory(session.id, highWeightOlder.id);
    sessionService.addSelectedMemory(session.id, sameWeightOlder.id);
    sessionService.addSelectedMemory(session.id, sameWeightNewer.id);

    memoryService.touchMemory(highWeightOlder.id, { updatedAt: '2026-01-01T00:00:00.000Z' });
    memoryService.touchMemory(sameWeightOlder.id, { updatedAt: '2026-01-15T00:00:00.000Z' });
    memoryService.touchMemory(sameWeightNewer.id, { updatedAt: '2026-02-01T00:00:00.000Z' });
    memoryService.touchMemory(lowWeightNewer.id, { updatedAt: '2026-03-01T00:00:00.000Z' });

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [lowWeightNewer.id, highWeightOlder.id, sameWeightOlder.id, sameWeightNewer.id],
      pendingUserInput: 'Sort memories for prompt injection',
      resultItems: [
        {
          memoryId: lowWeightNewer.id,
          summary: 'Low weight summary',
          similarity: 0.99,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: highWeightOlder.id,
          summary: 'High weight older summary',
          similarity: 0.5,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: sameWeightOlder.id,
          summary: 'High weight same timestamp older',
          similarity: 0.6,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: sameWeightNewer.id,
          summary: 'High weight same timestamp newer',
          similarity: 0.4,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Sort memories for prompt injection',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([
      sameWeightNewer.id,
      sameWeightOlder.id,
      highWeightOlder.id,
      lowWeightNewer.id,
    ]);
  });

  it('does not truncate result items when budget-aware truncation is disabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-budget-flag-off-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({ defaultProviderId: 'openai' });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 180 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Budget flag off session', 'gpt-4.1-mini');
    const memoryA = memoryService.createMemory('Memory A', 'Highest weight memory.', 'project', { memoryKind: 'knowledge', weight: 0.95 });
    const memoryB = memoryService.createMemory('Memory B', 'Mid weight memory.', 'project', { memoryKind: 'knowledge', weight: 0.55 });
    const memoryC = memoryService.createMemory('Memory C', 'Lowest weight memory.', 'project', { memoryKind: 'knowledge', weight: 0.2 });

    sessionService.addSelectedMemory(session.id, memoryA.id);
    sessionService.addSelectedMemory(session.id, memoryB.id);
    sessionService.addSelectedMemory(session.id, memoryC.id);

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [memoryA.id, memoryB.id, memoryC.id],
      pendingUserInput: 'Preserve all result items even when the window is small',
      resultItems: [
        createResultItem(memoryA.id, makeLongSummary('A', 180), 0.99),
        createResultItem(memoryB.id, makeLongSummary('B', 180), 0.8),
        createResultItem(memoryC.id, makeLongSummary('C', 180), 0.7),
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Preserve all result items even when the window is small',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([memoryA.id, memoryB.id, memoryC.id]);
  });

  it('drops low-weight result items first when budget-aware truncation is enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-budget-truncate-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      pepe: { enableBudgetAwareResultTruncation: true },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 200 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Budget truncate session', 'gpt-4.1-mini');
    const highWeight = memoryService.createMemory('High weight', 'Retain me first.', 'project', { memoryKind: 'knowledge', weight: 0.95 });
    const mediumWeight = memoryService.createMemory('Medium weight', 'Retain me after high weight.', 'project', { memoryKind: 'knowledge', weight: 0.7 });
    const lowWeight = memoryService.createMemory('Low weight', 'Drop me first.', 'project', { memoryKind: 'knowledge', weight: 0.2 });

    sessionService.addSelectedMemory(session.id, highWeight.id);
    sessionService.addSelectedMemory(session.id, mediumWeight.id);
    sessionService.addSelectedMemory(session.id, lowWeight.id);

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [highWeight.id, mediumWeight.id, lowWeight.id],
      pendingUserInput: 'Keep the most important result items only',
      resultItems: [
        createResultItem(highWeight.id, makeLongSummary('high', 180), 0.99),
        createResultItem(mediumWeight.id, makeLongSummary('medium', 180), 0.8),
        createResultItem(lowWeight.id, makeLongSummary('low', 180), 0.7),
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Keep the most important result items only',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([highWeight.id, mediumWeight.id]);
    expect(resolved.runtimeStatus.contextCount.selectedMemoryCount).toBe(2);
  });

  it('prefers priority-tagged memories during sorting and truncation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-priority-sort-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      pepe: { enableBudgetAwareResultTruncation: true },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 150 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Priority session', 'gpt-4.1-mini');
    const criticalLowWeight = memoryService.createMemory('Critical low weight', 'Manual critical priority should win.', 'project', {
      memoryKind: 'knowledge',
      tags: ['priority:critical'],
      weight: 0.1,
    });
    const highWeight = memoryService.createMemory('High weight', 'High weight but no explicit priority.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.95,
    });
    const mediumWeight = memoryService.createMemory('Medium weight', 'Medium weight and removable.', 'project', {
      memoryKind: 'knowledge',
      weight: 0.65,
    });

    sessionService.addSelectedMemory(session.id, criticalLowWeight.id);
    sessionService.addSelectedMemory(session.id, highWeight.id);
    sessionService.addSelectedMemory(session.id, mediumWeight.id);

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [criticalLowWeight.id, highWeight.id, mediumWeight.id],
      pendingUserInput: 'Keep the critical item and the strongest fallback',
      resultItems: [
        createResultItem(highWeight.id, makeLongSummary('high-priority-weight', 160), 0.99),
        createResultItem(criticalLowWeight.id, makeLongSummary('critical-priority', 160), 0.5),
        createResultItem(mediumWeight.id, makeLongSummary('medium-priority-weight', 160), 0.8),
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Keep the critical item and the strongest fallback',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([
      criticalLowWeight.id,
      highWeight.id,
    ]);
  });

  it('injects deterministic recall results when the feature flag is enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-deterministic-recall-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      pepe: { enableDeterministicRecall: true },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Deterministic recall session', 'gpt-4.1-mini');
    const knowledgeMemory = memoryService.createMemory('SQLite invariant', 'sqlite persistence is the source of truth for repository state', 'project', {
      type: 'long-term',
      memoryKind: 'knowledge',
      weight: 0.92,
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, config.pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Recall the sqlite persistence decision',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([knowledgeMemory.id]);
    expect(resolved.runtimeStatus.contextCount.selectedMemoryCount).toBe(1);
  });

  it('keeps deterministic recall disabled by default', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-deterministic-recall-off-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({ defaultProviderId: 'openai' });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Recall off session', 'gpt-4.1-mini');
    memoryService.createMemory('SQLite invariant', 'sqlite persistence is the source of truth for repository state', 'project', {
      type: 'long-term',
      memoryKind: 'knowledge',
      weight: 0.92,
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, config.pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Recall the sqlite persistence decision',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems).toHaveLength(0);
    expect(resolved.runtimeStatus.contextCount.selectedMemoryCount).toBe(0);
  });

  it('falls back safely when deterministic recall search fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-deterministic-recall-fail-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      pepe: { enableDeterministicRecall: true },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Recall failure session', 'gpt-4.1-mini');
    memoryService.searchMemories = (() => {
      throw new Error('simulated recall failure');
    }) as typeof memoryService.searchMemories;

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, config.pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Recall the sqlite persistence decision',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems).toHaveLength(0);
    expect(resolved.runtimeStatus.contextCount.selectedMemoryCount).toBe(0);
  });

  it('skips deterministic recall when the fixed context is already overloaded', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-deterministic-recall-overload-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      pepe: { enableDeterministicRecall: true },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository(), config.memory);
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 120 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Recall overload session', 'gpt-4.1-mini');
    for (let index = 0; index < 6; index += 1) {
      sessionService.addUserMessage(session.id, `Question ${index}: ${'x'.repeat(220)}`);
      sessionService.addAssistantMessage(session.id, `Answer ${index}: ${'y'.repeat(220)}`);
    }
    memoryService.createMemory('SQLite invariant', 'sqlite persistence is the source of truth for repository state', 'project', {
      type: 'long-term',
      memoryKind: 'knowledge',
      weight: 0.92,
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, config.pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Recall the sqlite persistence decision',
      cwd: tempDir,
    });

    expect(resolved.taskContext.resultItems).toHaveLength(0);
  });

  it('extracts the target directory from the latest user path when the new turn omits it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-target-dir-'));
    tempDirs.push(tempDir);
    const externalRepoDir = path.join(tempDir, 'external-repo');
    fs.mkdirSync(externalRepoDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini');
    sessionService.addUserMessage(session.id, `${externalRepoDir}，解析一下这个地址的项目。`);
    sessionService.addAssistantMessage(session.id, 'I will inspect that repository.');

    const resolver = new ContextResolver({
      config: createTestAppConfig({ defaultProviderId: 'openai' }),
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, createTestAppConfig({ defaultProviderId: 'openai' }).pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: '继续分析 source code',
      cwd: tempDir,
    });

    expect(resolved.taskContext.targetDirectory).toBe(externalRepoDir);
  });

  it('keeps only the recent context window from large session histories', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-recent-window-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', contextWindow: 16000, supportsTools: true }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Large resolver session', 'gpt-4.1-mini');
    for (let index = 1; index <= 12; index += 1) {
      sessionService.addUserMessage(session.id, `Question ${index}`);
      sessionService.addAssistantMessage(session.id, `Answer ${index}`);
    }

    const resolver = new ContextResolver({
      config: createTestAppConfig({ defaultProviderId: 'openai' }),
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, createTestAppConfig({ defaultProviderId: 'openai' }).pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Continue the latest investigation',
      cwd: tempDir,
    });

    expect(resolved.taskContext.sessionMessages).toHaveLength(6);
    expect(resolved.taskContext.sessionMessages.map((message) => message.content)).toEqual([
      'Question 10',
      'Answer 10',
      'Question 11',
      'Answer 11',
      'Question 12',
      'Answer 12',
    ]);
    expect(resolved.taskContext.recentMessages).toEqual([
      '__Unassigned__:\nUser: Question 10\nAssistant: Answer 10\nUser: Question 11\nAssistant: Answer 11\nUser: Question 12\nAssistant: Answer 12',
    ]);
    expect(resolved.runtimeStatus.contextCount.messageCount).toBe(6);
  });

  it('resolves the Pueblo skill directory from the agent working directory and lists installed skills', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-skills-'));
    const startupDir = path.join(tempDir, 'pueblo-home');
    const workspaceDir = path.join(tempDir, 'workspace');
    tempDirs.push(tempDir);
    fs.mkdirSync(startupDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(workspaceDir, 'puebl-profile', 'code-master'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'puebl-profile', 'code-master', 'agent.md'),
      [
        '# Profile',
        '- id: code-master',
        '- name: Code Master',
        '- description: Focused on shipping correct code changes with strong validation discipline.',
        '',
        '# Role',
        '- Act as a pragmatic senior software engineer.',
      ].join('\n'),
    );

    const config = createTestAppConfig({ defaultProviderId: 'openai' });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(workspaceDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const agentInstance = agentInstanceService.getOrCreateDefaultAgentInstance('code-master', workspaceDir);
    const skillFilePath = path.join(
      startupDir,
      `agent-${agentInstance.id}`,
      config.pepe.skillDirectoryName,
      'release-windows',
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(skillFilePath), { recursive: true });
    fs.writeFileSync(skillFilePath, '# Release Windows\nBuild and validate the Windows desktop release.\n');

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini', agentInstance.id);
    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, config.pepe),
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Inspect reusable release flow',
      puebloWorkingDirectory: startupDir,
      cwd: workspaceDir,
      workspace: workspaceDir,
    });

    expect(resolved.taskContext.skillContext?.puebloWorkingDirectory).toBe(startupDir);
    expect(resolved.taskContext.skillContext?.skillDirectory).toBe(path.join(startupDir, `agent-${agentInstance.id}`, 'skills'));
    expect(resolved.taskContext.skillContext?.skills).toEqual([
      {
        id: 'release-windows',
        instructionPath: `agent-${agentInstance.id}/skills/release-windows/SKILL.md`,
        description: 'Build and validate the Windows desktop release.',
      },
    ]);
  });

  it('projects active workflow plan and todo context into the resolved task context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-workflow-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const workflowService = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore: new WorkflowPlanStore(config),
      exporter: new WorkflowExporter(),
    });

    const session = sessionService.createSession('Workflow context session', 'gpt-4.1-mini');
    const workflow = createWorkflowInstanceModel({
      type: 'pueblo-plan',
      goal: 'Implement workflow context injection',
      status: 'round-active',
      sessionId: session.id,
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-1', 'context.plan.md'),
      deliverablePlanPath: null,
    });
    const outline = createInitialPuebloPlanOutline({ goal: workflow.goal });
    const plan = createInitialPuebloPlanDocument({
      workflow,
      routeReason: 'explicit',
      sessionId: session.id,
      outline,
    });
    const round = selectNextTodoRound(plan);
    const activePlan = round ? applyTodoRound(plan, round) : plan;
    workflowService.saveWorkflow({
      ...workflow,
      activeRoundNumber: activePlan.activeRoundNumber,
      updatedAt: new Date().toISOString(),
    });
    new WorkflowPlanStore(config).writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(activePlan));

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, config.pepe),
      workflowService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Continue the workflow execution.',
      cwd: tempDir,
    });

    expect(resolved.taskContext.workflowContext).not.toBeNull();
    expect(resolved.taskContext.workflowContext?.planSummary).toContain('Goal: Implement workflow context injection');
    expect(resolved.taskContext.workflowContext?.todoSummary).toContain('Round 1 tasks:');
  });

  it('filters pinned workflow memories out of general Pepe result items', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-workflow-filter-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const config = createTestAppConfig({
      defaultProviderId: 'openai',
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const workflowService = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore: new WorkflowPlanStore(config),
      exporter: new WorkflowExporter(),
    });

    const session = sessionService.createSession('Workflow dedupe session', 'gpt-4.1-mini');
    const planMemory = memoryService.createMemory('Workflow plan', 'Pinned plan memory', 'session', {
      tags: ['workflow', 'plan'],
      sourceSessionId: session.id,
    });
    const todoMemory = memoryService.createMemory('Workflow todo', 'Pinned todo memory', 'session', {
      tags: ['workflow', 'todo'],
      sourceSessionId: session.id,
    });
    const otherMemory = memoryService.createMemory('Other memory', 'Independent repository fact', 'session', {
      tags: ['repo-fact'],
      sourceSessionId: session.id,
    });
    sessionService.addSelectedMemory(session.id, planMemory.id);
    sessionService.addSelectedMemory(session.id, todoMemory.id);
    sessionService.addSelectedMemory(session.id, otherMemory.id);
    const workflow = createWorkflowInstanceModel({
      type: 'pueblo-plan',
      goal: 'Keep workflow context unique in prompt',
      status: 'round-active',
      sessionId: session.id,
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-2', 'dedupe.plan.md'),
      deliverablePlanPath: null,
      activePlanMemoryId: planMemory.id,
      activeTodoMemoryId: todoMemory.id,
      activeRoundNumber: 1,
    });
    const outline = createInitialPuebloPlanOutline({ goal: workflow.goal });
    const plan = createInitialPuebloPlanDocument({
      workflow,
      routeReason: 'explicit',
      sessionId: session.id,
      outline,
    });
    const round = selectNextTodoRound(plan);
    const activePlan = round ? applyTodoRound(plan, round) : plan;
    workflowService.saveWorkflow(workflow);
    new WorkflowPlanStore(config).writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(activePlan));

    const pepeResultService = new PepeResultService(memoryService, config.pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [planMemory.id, todoMemory.id, otherMemory.id],
      pendingUserInput: 'Continue workflow execution',
      resultItems: [
        {
          memoryId: planMemory.id,
          summary: 'Pinned plan memory should not be duplicated.',
          similarity: 0.99,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: todoMemory.id,
          summary: 'Pinned todo memory should not be duplicated.',
          similarity: 0.98,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
        {
          memoryId: otherMemory.id,
          summary: 'Independent repository fact remains available.',
          similarity: 0.95,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
      ],
    });

    const resolver = new ContextResolver({
      config,
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
      workflowService,
    });

    const resolved = await resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Continue workflow execution',
      cwd: tempDir,
    });

    expect(resolved.taskContext.workflowContext?.planMemoryId).toBe(planMemory.id);
    expect(resolved.taskContext.workflowContext?.todoMemoryId).toBe(todoMemory.id);
    expect(resolved.taskContext.resultItems.map((item) => item.memoryId)).toEqual([otherMemory.id]);
  });
});

function createResultItem(memoryId: string, summary: string, similarity: number) {
  return {
    memoryId,
    summary,
    similarity,
    sourceSessionId: null,
    vectorVersion: 'pepe-local-v1',
  };
}

function makeLongSummary(label: string, charCount: number) {
  return `${label}: ${'x'.repeat(charCount)}`;
}
