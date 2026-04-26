import type { ProviderMessage } from '../providers/provider-adapter';
import type { TaskContext } from './task-context';

export function buildProviderMessages(taskContext: TaskContext, goal: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const puebloMessage = buildPuebloSystemMessage(taskContext);

  if (puebloMessage) {
    messages.push({ role: 'system', content: puebloMessage });
  }

  if (taskContext.prompts.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'Selected prompts:',
        ...taskContext.prompts.map((prompt, index) => `${index + 1}. ${prompt.title}: ${prompt.content}`),
      ].join('\n'),
    });
  }

  if (taskContext.memories.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'Relevant memory records:',
        ...taskContext.memories.map((memory, index) => `${index + 1}. ${memory.title}: ${memory.content}`),
      ].join('\n'),
    });
  }

  messages.push({ role: 'user', content: goal });
  return messages;
}

export function buildLegacyProviderMessages(goal: string, inputContextSummary: string): ProviderMessage[] {
  return [
    {
      role: 'system',
      content: inputContextSummary,
    },
    {
      role: 'user',
      content: goal,
    },
  ];
}

function buildPuebloSystemMessage(taskContext: TaskContext): string | null {
  const sections: string[] = [];

  appendSection(sections, 'Role directives', taskContext.puebloProfile.roleDirectives);
  appendSection(sections, 'Goal directives', taskContext.puebloProfile.goalDirectives);
  appendSection(sections, 'Constraint directives', taskContext.puebloProfile.constraintDirectives);
  appendSection(sections, 'Style directives', taskContext.puebloProfile.styleDirectives);
  appendSection(sections, 'Memory retention hints', taskContext.puebloProfile.memoryPolicy.retentionHints);
  appendSection(sections, 'Memory summary hints', taskContext.puebloProfile.memoryPolicy.summaryHints);
  appendSection(sections, 'Context priority hints', taskContext.puebloProfile.contextPolicy.priorityHints);
  appendSection(sections, 'Context truncation hints', taskContext.puebloProfile.contextPolicy.truncationHints);

  if (taskContext.puebloProfile.summaryPolicy.lineageHint) {
    sections.push(`Summary lineage hint:\n- ${taskContext.puebloProfile.summaryPolicy.lineageHint}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function appendSection(target: string[], title: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }

  target.push(`${title}:\n${values.map((value) => `- ${value}`).join('\n')}`);
}

