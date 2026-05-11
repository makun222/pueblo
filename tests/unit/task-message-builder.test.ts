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

    expect(messages.map((message) => message.role)).toEqual(['system', 'system', 'system', 'system', 'user']);
    expect(messages[0]?.content).toContain('Target repository context:');
    expect(messages[0]?.content).toContain('D:/workspace/KnowledgeBase/knowledgeBase');
    expect(messages[1]?.content).toContain('Selected prompts');
    expect(messages[2]?.content).toContain('Relevant result items');
    expect(messages[3]?.content).toContain('Recent conversation context:');
    expect(messages[3]?.content).toContain('D:/workspace/external-repo');
    expect(messages[4]?.content).toBe('Inspect the current failure');
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

    expect(messages[0]?.content).toContain('Active workflow context:');
    expect(messages[0]?.content).toContain('Goal: implement workflow context');
    expect(messages[0]?.content).toContain('Round 1 tasks:');
    expect(messages[1]?.content).toContain('Relevant result items');
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