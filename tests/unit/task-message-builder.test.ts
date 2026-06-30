import { describe, expect, it } from 'vitest';
import { buildProviderMessages, dedupeSafeSystemBlocks } from '../../src/agent/task-message-builder';
import { createTaskContext } from '../../src/agent/task-context';
import { createEmptyPuebloProfile } from '../../src/agent/pueblo-profile';
import { createTestAppConfig } from '../helpers/test-config';

describe('task message builder', () => {
  it('builds provider messages from pueblo, prompt, and memory context before the current user input', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      targetDirectory: 'D:/workspace/KnowledgeBase/knowledgeBase',
      puebloProfile: createEmptyPuebloProfile(null),
      prompts: [
        {
          id: 'prompt-1',
          title: 'Root cause',
          category: 'analysis',
          content: 'Inspect root cause first.',
          status: 'active',
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'inspect-current-failure',
        generatedAt: new Date().toISOString(),
        items: [
          {
            memoryId: 'memory-1',
            summary: 'Repo fact: Repository uses sqlite.',
            similarity: 0.91,
            sourceSessionId: null,
            vectorVersion: 'pepe-local-v1',
          },
        ],
      },
      sessionMessages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Previous user turn with repo path D:/workspace/external-repo',
          createdAt: new Date().toISOString(),
          taskId: null,
          toolName: null,
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'Previous assistant turn',
          createdAt: new Date().toISOString(),
          taskId: null,
          toolName: null,
        },
      ],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const systemContents = messages.filter((message) => message.role === 'system').map((message) => message.content);

    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toBe('Inspect the current failure');
    expect(systemContents.some((content) => content.includes('Target repository context:') && content.includes('D:/workspace/KnowledgeBase/knowledgeBase'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Selected prompts'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Relevant result items'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Recent conversation context:') && content.includes('D:/workspace/external-repo'))).toBe(true);
  });

  it('injects active workflow context as a dedicated system block ahead of Pepe result items', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      workflowContext: {
        workflowId: 'workflow-1',
        workflowType: 'pueblo-plan',
        status: 'round-active',
        planSummary: 'Goal: implement workflow context\nAcceptance: prompt always includes active plan',
        todoSummary: 'Round 1 tasks:\n- wire workflow context\n- validate prompt injection',
        planMemoryId: 'memory-plan-1',
        todoMemoryId: 'memory-todo-1',
        runtimePlanPath: 'D:/workspace/.plans/workflow-1/context.plan.md',
        deliverablePlanPath: null,
        activeRoundNumber: 1,
        updatedAt: new Date().toISOString(),
      },
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'inspect-current-failure',
        generatedAt: new Date().toISOString(),
        items: [
          {
            memoryId: 'memory-1',
            summary: 'Repo fact: Repository uses sqlite.',
            similarity: 0.91,
            sourceSessionId: null,
            vectorVersion: 'pepe-local-v1',
          },
        ],
      },
      sessionMessages: [],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const systemContents = messages.filter((message) => message.role === 'system').map((message) => message.content);

    expect(systemContents.some((content) => content.includes('Goal: implement workflow context'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Round 1 tasks:'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Relevant result items'))).toBe(true);
  });

  it('injects active turn step context ahead of Pepe result items', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      activeTurnStepContext: 'Active turn step context:\nStep 1\n- tool-result / read / call-1: Read succeeded',
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'inspect-current-failure',
        generatedAt: new Date().toISOString(),
        items: [
          {
            memoryId: 'memory-1',
            summary: 'Repo fact: Repository uses sqlite.',
            similarity: 0.91,
            sourceSessionId: null,
            vectorVersion: 'pepe-local-v1',
          },
        ],
      },
      sessionMessages: [],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const systemContents = messages.filter((message) => message.role === 'system').map((message) => message.content);

    expect(systemContents.some((content) => content.includes('Active turn step context:'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Relevant result items'))).toBe(true);
  });

  it('injects session summaries after recent conversation and before workflow and general result items', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      sessionSummaryMemories: [
        {
          id: 'summary-current',
          type: 'short-term',
          memoryKind: 'summary',
          title: 'Session Summary',
          content: 'Session Summary\n- Current session: preserve sqlite decisions.',
          scope: 'session',
          status: 'active',
          tags: ['pepe-summary', 'pepe-session-summary'],
          parentId: null,
          derivationType: 'summary',
          summaryDepth: 1,
          weight: 0.95,
          lastAccessedAt: null,
          sourceSessionId: 'session-1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      workflowContext: {
        workflowId: 'workflow-1',
        workflowType: 'pueblo-plan',
        status: 'round-active',
        planSummary: 'Goal: implement workflow context',
        todoSummary: 'Round 1 tasks:\n- keep workflow after summaries',
        planMemoryId: 'memory-plan-1',
        todoMemoryId: 'memory-todo-1',
        runtimePlanPath: 'D:/workspace/.plans/workflow-1/context.plan.md',
        deliverablePlanPath: null,
        activeRoundNumber: 1,
        updatedAt: new Date().toISOString(),
      },
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'inspect-current-failure',
        generatedAt: new Date().toISOString(),
        items: [
          {
            memoryId: 'memory-1',
            summary: 'Repo fact: Repository uses sqlite.',
            similarity: 0.91,
            sourceSessionId: null,
            vectorVersion: 'pepe-local-v1',
          },
        ],
      },
      sessionMessages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Previous user turn',
          createdAt: new Date().toISOString(),
          taskId: null,
          toolName: null,
        },
      ],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 1,
        selectedPromptCount: 0,
        selectedMemoryCount: 2,
        derivedMemoryCount: 0,
      },
      currentSessionId: 'session-1',
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const systemBlocks = messages.filter((message) => message.role === 'system').map((message) => message.content);
    const recentConversationIndex = systemBlocks.findIndex((content) => content.startsWith('Recent conversation context:'));
    const sessionSummaryIndex = systemBlocks.findIndex((content) => content.startsWith('Relevant session summaries:'));
    const workflowIndex = systemBlocks.findIndex((content) => content.startsWith('Active workflow context:'));
    const resultItemsIndex = systemBlocks.findIndex((content) => content.startsWith('Relevant result items:'));

    expect(sessionSummaryIndex).toBeGreaterThan(recentConversationIndex);
    expect(workflowIndex).toBeGreaterThan(sessionSummaryIndex);
    expect(resultItemsIndex).toBeGreaterThan(workflowIndex);
    expect(systemBlocks[sessionSummaryIndex]).toContain('Current session summary');
    expect(systemBlocks[sessionSummaryIndex]).toContain('preserve sqlite decisions');
  });

  it('dedupes repeated pueblo directives while preserving section order', () => {
    const profile = createEmptyPuebloProfile(null);
    profile.roleDirectives.push('Inspect root cause first.', 'Inspect root cause first.  ');
    profile.constraintDirectives.push('Do not guess.', 'Do not guess.');

    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: profile,
      prompts: [],
      resultSet: null,
      sessionMessages: [],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Role directives:\n- Inspect root cause first.');
    expect(messages[0]?.content).toContain('Constraint directives:\n- Do not guess.');
    expect(messages[0]?.content.match(/Inspect root cause first\./g) ?? []).toHaveLength(1);
    expect(messages[0]?.content.match(/Do not guess\./g) ?? []).toHaveLength(1);
  });

  it('caps and sanitizes oversized non-tool context blocks', () => {
    const oversizedPrompt = `Prompt header\n${'A'.repeat(8_000)}`;
    const oversizedMemory = `Relevant memory\u0000record\n${'B'.repeat(12_000)}`;
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      prompts: [
        {
          id: 'prompt-1',
          title: 'Large prompt',
          category: 'analysis',
          content: oversizedPrompt,
          status: 'active',
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'oversized-context',
        generatedAt: new Date().toISOString(),
        items: Array.from({ length: 8 }, (_, index) => ({
          memoryId: `memory-${index + 1}`,
          summary: `${oversizedMemory}-${index + 1}`,
          similarity: 0.9 - index * 0.01,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        })),
      },
      sessionMessages: [],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const promptBlock = messages.find((message) => message.content.startsWith('Selected prompts:'));
    const resultItemsBlock = messages.find((message) => message.content.startsWith('Relevant result items:'));
    const totalSystemChars = messages
      .filter((message) => message.role === 'system')
      .reduce((sum, message) => sum + message.content.length, 0);

    expect(promptBlock?.content).toContain('[truncated');
    expect(resultItemsBlock?.content).toContain('[truncated');
    expect(resultItemsBlock?.content).not.toContain('\u0000');
    expect(totalSystemChars).toBeLessThanOrEqual(24_000);
  });

  it('tightens result-item and recent-conversation blocks when context utilization is already high', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'high-utilization-context',
        generatedAt: new Date().toISOString(),
        items: Array.from({ length: 5 }, (_, index) => ({
          memoryId: `memory-${index + 1}`,
          summary: `Relevant memory ${index + 1}: ${'A'.repeat(900)}`,
          similarity: 0.95 - index * 0.05,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        })),
      },
      sessionMessages: Array.from({ length: 5 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Conversation message ${index + 1}`,
        createdAt: new Date().toISOString(),
        taskId: null,
        toolName: null,
      })),
      contextCount: {
        estimatedTokens: 14_400,
        contextWindowLimit: 20_000,
        utilizationRatio: 0.72,
        messageCount: 5,
        selectedPromptCount: 0,
        selectedMemoryCount: 5,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const resultItemsBlock = messages.find((message) => message.content.startsWith('Relevant result items:'));
    const recentConversationBlock = messages.find((message) => message.content.startsWith('Recent conversation context:'));

    expect(resultItemsBlock?.content.match(/\[similarity=/g) ?? []).toHaveLength(3);
    expect(resultItemsBlock?.content).toContain('[truncated');
    expect(resultItemsBlock?.content).not.toContain('Relevant memory 4');
    expect(recentConversationBlock?.content).toContain('Conversation message 3');
    expect(recentConversationBlock?.content).toContain('Conversation message 5');
    expect(recentConversationBlock?.content).not.toContain('Conversation message 1');
  });

  it('adds a dedicated skill workspace block that guides skill creation and reuse', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      skillContext: {
        puebloWorkingDirectory: 'D:/workspace/pueblo',
        agentWorkingDirectory: 'D:/workspace/pueblo/agent-agent-1',
        skillDirectory: 'D:/workspace/pueblo/agent-agent-1/skills',
        skills: [
          {
            id: 'release-windows',
            instructionPath: 'agent-agent-1/skills/release-windows/SKILL.md',
            description: 'Build and validate the Windows desktop release.',
          },
        ],
      },
      sessionMessages: [],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Ship the release');
    const systemContents = messages.filter((message) => message.role === 'system').map((message) => message.content);

    expect(systemContents.some((content) => content.includes('Pueblo skill workspace:'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Pueblo启动目录: D:/workspace/pueblo'))).toBe(true);
    expect(systemContents.some((content) => content.includes('在创建、更新或覆盖Skill之前，需要用户的明确批准'))).toBe(true);
    expect(systemContents.some((content) => content.includes('Skill处理的数据和创建的文件一般存储在workspace目录'))).toBe(true);
    expect(systemContents.some((content) => content.includes('release-windows'))).toBe(true);
    expect(systemContents.some((content) => content.includes('agent-agent-1/skills/release-windows/SKILL.md'))).toBe(true);
  });

  it('describes next_step_actions without requiring ids', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
      puebloProfile: createEmptyPuebloProfile(null),
      resultSet: {
        sessionId: 'session-1',
        agentInstanceId: 'agent-1',
        inputFingerprint: 'inspect-next-steps',
        generatedAt: new Date().toISOString(),
        items: [],
      },
      sessionMessages: [],
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    const messages = buildProviderMessages(context, 'Inspect the current failure');
    const systemContent = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');

    expect(systemContent).toContain('"label" (string, <=30 chars)');
    expect(systemContent).toContain('"next_step_actions": [{"label":"Fix /amber init handler"');
    expect(systemContent).not.toContain('a unique identifier for this action suggestion');
  });

  it('dedupes identical system blocks but preserves recent conversation blocks', () => {
    const deduped = dedupeSafeSystemBlocks([
      { role: 'system', content: 'Selected prompts:\n1. Root cause: Inspect root cause first.' },
      { role: 'system', content: 'Selected prompts:\n1. Root cause:  Inspect root cause first.  ' },
      { role: 'system', content: 'Recent conversation context:\n1. User: repeat this' },
      { role: 'system', content: 'Recent conversation context:\n1. User: repeat this' },
      { role: 'user', content: 'Inspect the current failure' },
    ]);

    expect(deduped).toEqual([
      { role: 'system', content: 'Selected prompts:\n1. Root cause: Inspect root cause first.' },
      { role: 'system', content: 'Recent conversation context:\n1. User: repeat this' },
      { role: 'system', content: 'Recent conversation context:\n1. User: repeat this' },
      { role: 'user', content: 'Inspect the current failure' },
    ]);
  });
});
