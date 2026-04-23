import { describe, expect, it } from 'vitest';
import { buildProviderMessages } from '../../src/agent/task-message-builder';
import { createTaskContext } from '../../src/agent/task-context';
import { createEmptyPuebloProfile } from '../../src/agent/pueblo-profile';
import { createTestAppConfig } from '../helpers/test-config';

describe('task message builder', () => {
  it('builds provider messages from task context sources without flattening session roles', () => {
    const context = createTaskContext({
      config: createTestAppConfig(),
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
      memories: [
        {
          id: 'memory-1',
          type: 'long-term',
          title: 'Repo fact',
          content: 'Repository uses sqlite.',
          scope: 'project',
          status: 'active',
          tags: [],
          parentId: null,
          derivationType: 'manual',
          summaryDepth: 0,
          sourceSessionId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      sessionMessages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Previous user turn',
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

    expect(messages.map((message) => message.role)).toEqual(['system', 'system', 'user', 'assistant', 'user']);
    expect(messages[0]?.content).toContain('Selected prompts');
    expect(messages[1]?.content).toContain('Relevant memory records');
    expect(messages[2]?.content).toBe('Previous user turn');
    expect(messages[3]?.content).toBe('Previous assistant turn');
    expect(messages[4]?.content).toBe('Inspect the current failure');
  });
});