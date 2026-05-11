import type { ProviderMessage } from '../providers/provider-adapter';
import type { TaskContext } from './task-context';

const RECENT_CONTEXT_MESSAGE_LIMIT = 6;
const RECENT_CONTEXT_MESSAGE_CHAR_LIMIT = 480;

export function buildProviderMessages(taskContext: TaskContext, goal: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const puebloMessage = buildPuebloSystemMessage(taskContext);
  const targetDirectoryMessage = buildTargetDirectoryMessage(taskContext.targetDirectory);
  const recentConversationMessage = buildRecentConversationMessage(taskContext.recentMessages);

  if (puebloMessage) {
    messages.push({ role: 'system', content: puebloMessage });
  }

  if (targetDirectoryMessage) {
    messages.push({ role: 'system', content: targetDirectoryMessage });
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

  const workflowContextMessage = buildWorkflowContextMessage(taskContext);
  if (workflowContextMessage) {
    messages.push({ role: 'system', content: workflowContextMessage });
  }

  if (taskContext.resultItems.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'Relevant result items:',
        ...taskContext.resultItems.map((item, index) => `${index + 1}. [similarity=${item.similarity}] ${item.summary}`),
      ].join('\n'),
    });
  }

  if (recentConversationMessage) {
    messages.push({ role: 'system', content: recentConversationMessage });
  }

  messages.push({ role: 'user', content: goal });
  return dedupeSafeSystemBlocks(messages);
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

function buildWorkflowContextMessage(taskContext: TaskContext): string | null {
  const workflowContext = taskContext.workflowContext;
  if (!workflowContext) {
    return null;
  }

  const lines = [
    'Active workflow context:',
    `- Workflow type: ${workflowContext.workflowType}`,
    `- Workflow status: ${workflowContext.status}`,
    `- Runtime plan path: ${workflowContext.runtimePlanPath}`,
  ];

  if (workflowContext.activeRoundNumber !== null) {
    lines.push(`- Active round: ${workflowContext.activeRoundNumber}`);
  }

  if (workflowContext.planSummary) {
    lines.push('Plan summary:');
    lines.push(...workflowContext.planSummary.split(/\r?\n/).map((line) => `- ${line}`));
  }

  if (workflowContext.todoSummary) {
    lines.push('Current todo:');
    lines.push(...workflowContext.todoSummary.split(/\r?\n/).map((line) => `- ${line}`));
  }

  return lines.join('\n');
}

function buildTargetDirectoryMessage(targetDirectory: string | null): string | null {
  if (!targetDirectory) {
    return null;
  }

  return [
    'Target repository context:',
    `- Use ${targetDirectory} as the repository root for this task.`,
    '- Resolve relative tool paths and glob patterns from that directory.',
    '- If the user asks to analyze or describe that directory, inspect it with tools before answering.',
  ].join('\n');
}

export function selectRecentMessagesForPrompt(recentMessages: readonly string[]): string[] {
  return recentMessages
    .slice(-RECENT_CONTEXT_MESSAGE_LIMIT)
    .map(compactRecentMessageForPrompt);
}

function buildRecentConversationMessage(recentMessages: readonly string[]): string | null {
  const selectedMessages = selectRecentMessagesForPrompt(recentMessages);

  if (selectedMessages.length === 0) {
    return null;
  }

  return [
    'Recent conversation context:',
    ...selectedMessages.map((message, index) => `${index + 1}. ${message}`),
  ].join('\n');
}

function compactRecentMessageForPrompt(message: string): string {
  if (message.length <= RECENT_CONTEXT_MESSAGE_CHAR_LIMIT) {
    return message;
  }

  const headLength = 300;
  const tailLength = 140;
  const omittedChars = message.length - headLength - tailLength;
  return [
    message.slice(0, headLength),
    `... [truncated ${omittedChars} chars] ...`,
    message.slice(-tailLength),
  ].join('\n');
}

function appendSection(target: string[], title: string, values: string[]): void {
  const dedupedValues = dedupeTextValues(values);

  if (dedupedValues.length === 0) {
    return;
  }

  target.push(`${title}:\n${dedupedValues.map((value) => `- ${value}`).join('\n')}`);
}

export function dedupeSafeSystemBlocks(messages: readonly ProviderMessage[]): ProviderMessage[] {
  const seenSystemBlocks = new Set<string>();
  const dedupedMessages: ProviderMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'system' || isRecentConversationContextBlock(message.content)) {
      dedupedMessages.push(message);
      continue;
    }

    const fingerprint = normalizeBlockContent(message.content);
    if (!fingerprint || seenSystemBlocks.has(fingerprint)) {
      continue;
    }

    seenSystemBlocks.add(fingerprint);
    dedupedMessages.push(message);
  }

  return dedupedMessages;
}

function dedupeTextValues(values: readonly string[]): string[] {
  const seenValues = new Set<string>();
  const dedupedValues: string[] = [];

  for (const value of values) {
    const fingerprint = normalizeBlockContent(value);
    if (!fingerprint || seenValues.has(fingerprint)) {
      continue;
    }

    seenValues.add(fingerprint);
    dedupedValues.push(value.trim());
  }

  return dedupedValues;
}

function isRecentConversationContextBlock(content: string): boolean {
  return content.startsWith('Recent conversation context:\n');
}

function normalizeBlockContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

