import type { ProviderMessage } from '../providers/provider-adapter';
import { buildSkillSystemMessage } from './skill-context';
import type { TaskContext } from './task-context';

export const RECENT_CONTEXT_MESSAGE_LIMIT = 3;
export const RECENT_CONTEXT_MESSAGE_CHAR_LIMIT = 480;
const SYSTEM_CONTEXT_TOTAL_CHAR_BUDGET = 24_000;
const PUEBLO_SYSTEM_MESSAGE_CHAR_LIMIT = 6_000;
const TARGET_DIRECTORY_MESSAGE_CHAR_LIMIT = 600;
const SKILL_CONTEXT_MESSAGE_CHAR_LIMIT = 4_000;
const SELECTED_PROMPTS_LIMIT = 4;
const SELECTED_PROMPT_CHAR_LIMIT = 1_200;
const SELECTED_PROMPTS_MESSAGE_CHAR_LIMIT = 6_000;
const WORKFLOW_SUMMARY_CHAR_LIMIT = 2_000;
const WORKFLOW_CONTEXT_MESSAGE_CHAR_LIMIT = 5_000;
const ATTACHMENT_CONTEXT_LIMIT = 4;
const ATTACHMENT_PREVIEW_CHAR_LIMIT = 400;
const ATTACHMENT_INLINE_JSON_CHAR_LIMIT = 1_600;
const ATTACHMENT_CONTEXT_MESSAGE_CHAR_LIMIT = 6_000;
const ACTIVE_TURN_STEP_CONTEXT_CHAR_LIMIT = 3_000;
const SESSION_SUMMARY_ITEM_LIMIT = 2;
const SESSION_SUMMARY_ITEM_CHAR_LIMIT = 1_200;
const SESSION_SUMMARY_MESSAGE_CHAR_LIMIT = 4_000;
const RESULT_ITEMS_LIMIT = 6;
const RESULT_ITEM_SUMMARY_CHAR_LIMIT = 1_600;
const RESULT_ITEMS_MESSAGE_CHAR_LIMIT = 8_000;
const RECENT_CONVERSATION_MESSAGE_CHAR_LIMIT = 4_000;
export const COMPACT_CONTEXT_UTILIZATION_THRESHOLD = 0.7;
const COMPACT_RESULT_ITEMS_LIMIT = 3;
const COMPACT_RESULT_ITEM_SUMMARY_CHAR_LIMIT = 600;
const COMPACT_RECENT_CONVERSATION_MESSAGE_LIMIT = 3;
const COMPACT_RECENT_CONVERSATION_MESSAGE_CHAR_LIMIT = 1_800;

/**
 * Section priority order for Provider message assembly.
 *
 * Sections consume the character budget in ascending priority order:
 * lower-numbered sections are pushed first and are less likely to be
 * truncated when the budget is tight.  This keeps fixed system prompts
 * intact and pushes expendable memory content toward the tail.
 */
const SECTION_ORDER = {
  system: 0,
  targetDirectory: 1,
  skills: 2,
  search: 3,
  activeTurn: 10,
  recent: 20,
  session: 30,
  workflow: 40,
  attachment: 50,
  resultItems: 60,
  goal: 100,
} as const;

type SectionName = keyof typeof SECTION_ORDER;

interface MessageSection {
  name: SectionName;
  content: string | null;
  maxChars: number;
}

export function buildProviderMessages(taskContext: TaskContext, goal: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const budget = { remainingChars: SYSTEM_CONTEXT_TOTAL_CHAR_BUDGET };
  const compactContext = isCompactContextModeEnabled(taskContext.contextCount);
  const puebloMessage = buildPuebloSystemMessage(taskContext);
  const targetDirectoryMessage = buildTargetDirectoryMessage(taskContext.targetDirectory);
  const skillContextMessage = buildSkillSystemMessage(taskContext.skillContext);
  const attachmentContextMessage = buildAttachmentContextMessage(taskContext);
  const sessionSummaryMessage = buildSessionSummaryMessage(taskContext);
  const recentConversationMessage = buildRecentConversationMessage(
    taskContext.recentMessages,
    compactContext ? COMPACT_RECENT_CONVERSATION_MESSAGE_LIMIT : RECENT_CONTEXT_MESSAGE_LIMIT,
  );
  const workflowContextMessage = buildWorkflowContextMessage(taskContext);

  // Assemble all context sections with their SECTION_ORDER priority tags,
  // then sort and push.  Fixed prompts (system / target / skills) always
  // precede memory content (active turn, recent, session, result items).
  const sections: MessageSection[] = [
    { name: 'system', content: puebloMessage, maxChars: PUEBLO_SYSTEM_MESSAGE_CHAR_LIMIT },
    { name: 'targetDirectory', content: targetDirectoryMessage, maxChars: TARGET_DIRECTORY_MESSAGE_CHAR_LIMIT },
    { name: 'skills', content: skillContextMessage, maxChars: SKILL_CONTEXT_MESSAGE_CHAR_LIMIT },
    ...(taskContext.prompts.length > 0
      ? [
          {
            name: 'search' as const,
            content: [
              'Selected prompts:',
              ...taskContext.prompts
                .slice(0, SELECTED_PROMPTS_LIMIT)
                .map((prompt, index) => `${index + 1}. ${prompt.title}: ${truncatePromptText(prompt.content, SELECTED_PROMPT_CHAR_LIMIT)}`),
            ].join('\n'),
            maxChars: SELECTED_PROMPTS_MESSAGE_CHAR_LIMIT,
          },
        ]
      : []),
    { name: 'activeTurn', content: taskContext.activeTurnStepContext ?? null, maxChars: ACTIVE_TURN_STEP_CONTEXT_CHAR_LIMIT },
    { name: 'recent', content: recentConversationMessage, maxChars: compactContext ? COMPACT_RECENT_CONVERSATION_MESSAGE_CHAR_LIMIT : RECENT_CONVERSATION_MESSAGE_CHAR_LIMIT },
    { name: 'session', content: sessionSummaryMessage, maxChars: SESSION_SUMMARY_MESSAGE_CHAR_LIMIT },
    ...(workflowContextMessage
      ? [{ name: 'workflow' as const, content: workflowContextMessage, maxChars: WORKFLOW_CONTEXT_MESSAGE_CHAR_LIMIT }]
      : []),
    ...(attachmentContextMessage
      ? [{ name: 'attachment' as const, content: attachmentContextMessage, maxChars: ATTACHMENT_CONTEXT_MESSAGE_CHAR_LIMIT }]
      : []),
    ...(taskContext.resultItems.length > 0
      ? [
          {
            name: 'resultItems' as const,
            content: [
              'Relevant result items:',
              ...taskContext.resultItems
                .slice(0, compactContext ? COMPACT_RESULT_ITEMS_LIMIT : RESULT_ITEMS_LIMIT)
                .map(
                  (item, index) =>
                    `${index + 1}. [similarity=${item.similarity}] ${truncatePromptText(item.summary, compactContext ? COMPACT_RESULT_ITEM_SUMMARY_CHAR_LIMIT : RESULT_ITEM_SUMMARY_CHAR_LIMIT)}`,
                ),
            ].join('\n'),
            maxChars: RESULT_ITEMS_MESSAGE_CHAR_LIMIT,
          },
        ]
      : []),
  ];

  for (const section of sections
    .filter((s) => s.content !== null)
    .sort((a, b) => SECTION_ORDER[a.name] - SECTION_ORDER[b.name])) {
    pushSystemMessage(messages, budget, section.content!, section.maxChars);
  }

  messages.push({ role: 'user', content: goal });
  return dedupeSafeSystemBlocks(messages);
}

function buildSessionSummaryMessage(taskContext: TaskContext): string | null {
  const sessionSummaryMemories = taskContext.sessionSummaryMemories ?? [];

  if (sessionSummaryMemories.length === 0) {
    return null;
  }

  const lines = ['Relevant session summaries:'];
  for (const [index, memory] of sessionSummaryMemories.slice(0, SESSION_SUMMARY_ITEM_LIMIT).entries()) {
    const label = memory.sourceSessionId === taskContext.sessionId
      ? 'Current session summary'
      : `Related session summary (${memory.sourceSessionId ?? 'unknown-session'})`;

    lines.push(`${index + 1}. ${label}`);
    lines.push(
      ...truncatePromptText(memory.content, SESSION_SUMMARY_ITEM_CHAR_LIMIT)
        .split(/\r?\n/)
        .map((line) => `   ${line}`),
    );
  }

  return lines.join('\n');
}

function buildAttachmentContextMessage(taskContext: TaskContext): string | null {
  if (taskContext.uploadedAttachments.length === 0) {
    return null;
  }

  const lines = [
    '关于上传的附件:',
    '将附件转换为规范的 JSON 资产。',
    '当你使用编辑工具编辑规范的附件 JSON 资产时，Pueblo 会自动从该 JSON 重写原始的 docx 或电子表格文件。',
    '如果附件被标记为大文件，使用tool:read读取JSON 路径文件内容，而不要将整个文件纳入上下文。',
  ];

  for (const [index, attachment] of taskContext.uploadedAttachments.slice(0, ATTACHMENT_CONTEXT_LIMIT).entries()) {
    lines.push(`${index + 1}. ${attachment.source.fileName}`);
    lines.push(`   - kind: ${attachment.kind}`);
    lines.push(`   - jsonPath: ${attachment.asset.jsonPath}`);
    lines.push(`   - large: ${attachment.summary.isLarge ? 'yes' : 'no'}`);

    if (attachment.summary.chunkCount !== null) {
      lines.push(`   - chunks: ${attachment.summary.chunkCount}`);
    }
    if (attachment.summary.sheetCount !== null) {
      lines.push(`   - sheets: ${attachment.summary.sheetCount}`);
    }
    if (attachment.summary.rowCount !== null) {
      lines.push(`   - rows: ${attachment.summary.rowCount}`);
    }
    if (attachment.summary.cellCount !== null) {
      lines.push(`   - cells: ${attachment.summary.cellCount}`);
    }
    if (attachment.summary.previewText) {
      lines.push(`   - preview: ${truncatePromptText(attachment.summary.previewText, ATTACHMENT_PREVIEW_CHAR_LIMIT)}`);
    }
    if (attachment.inlineJsonExcerpt) {
      lines.push('   - inline JSON excerpt:');
      lines.push(
        ...truncatePromptText(attachment.inlineJsonExcerpt, ATTACHMENT_INLINE_JSON_CHAR_LIMIT)
          .split(/\r?\n/)
          .map((line) => `     ${line}`),
      );
    }
  }

  return lines.join('\n');
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

  // Inject workflow-aware hints when an active plan is being tracked
  const wf = taskContext.workflowContext;
  if (wf && wf.planSummary) {
    const roundNote = wf.activeRoundNumber ? ` Current round: ${wf.activeRoundNumber}.` : '';
    sections.push(
      'Workflow-aware hints:',
      `- Active plan: ${wf.planSummary}.${roundNote}`,
      `- Priority: focus on the active round's todo items and reject unrelated changes.`,
      `- Retention: retain implementation decisions relevant to the current plan phase.`,
      `- Truncation: drop content unrelated to the active plan round when summarizing.`,
    );
  }

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
    lines.push(...truncatePromptText(workflowContext.planSummary, WORKFLOW_SUMMARY_CHAR_LIMIT).split(/\r?\n/).map((line) => `- ${line}`));
  }

  if (workflowContext.todoSummary) {
    lines.push('Current todo:');
    lines.push(...truncatePromptText(workflowContext.todoSummary, WORKFLOW_SUMMARY_CHAR_LIMIT).split(/\r?\n/).map((line) => `- ${line}`));
  }

  return lines.join('\n');
}

function buildTargetDirectoryMessage(targetDirectory: string | null): string | null {
  if (!targetDirectory) {
    return null;
  }

  return [
    'Target repository context:',
    `- 使用 ${targetDirectory} 作为此任务的仓库根目录。`,
    '- 从该目录解析相对工具路径和全局模式。',
    '- 如果用户要求分析该目录的相关情况，请先使用工具检查再回答。',
  ].join('\n');
}

export function selectRecentMessagesForPrompt(recentMessages: readonly string[]): string[] {
  // Content-level reduction already happens in selectRecentContextMessages;
  // the hard limit is applied downstream in buildRecentConversationMessage.
  return recentMessages as string[];
}

function buildRecentConversationMessage(recentMessages: readonly string[], messageLimit = RECENT_CONTEXT_MESSAGE_LIMIT): string | null {
  const selectedMessages = recentMessages.slice(-messageLimit);

  if (selectedMessages.length === 0) {
    return null;
  }

  return [
    'Recent conversation context:',
    ...selectedMessages.map((message, index) => `${index + 1}. ${message}`),
  ].join('\n');
}

function pushSystemMessage(
  messages: ProviderMessage[],
  budget: { remainingChars: number },
  content: string | null,
  maxChars: number,
): void {
  if (!content || budget.remainingChars <= 0) {
    return;
  }

  const effectiveLimit = Math.min(maxChars, budget.remainingChars);
  const compactedContent = truncatePromptText(content, effectiveLimit);
  if (!compactedContent) {
    return;
  }

  messages.push({ role: 'system', content: compactedContent });
  budget.remainingChars -= compactedContent.length;
}

export function compactRecentMessageForPrompt(message: string): string {
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

export function isCompactContextModeEnabled(contextCount: TaskContext['contextCount']): boolean {
  const utilizationRatio = contextCount.utilizationRatio;
  return utilizationRatio !== null && utilizationRatio >= COMPACT_CONTEXT_UTILIZATION_THRESHOLD;
}

function appendSection(target: string[], title: string, values: string[]): void {
  const dedupedValues = dedupeTextValues(values);

  if (dedupedValues.length === 0) {
    return;
  }

  target.push(`${title}:\n${dedupedValues.map((value) => `- ${value}`).join('\n')}`);
}

function truncatePromptText(value: string, maxChars: number): string {
  const normalized = sanitizePromptText(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  if (maxChars <= 64) {
    return normalized.slice(0, Math.max(0, maxChars)).trimEnd();
  }

  const headLength = Math.max(32, Math.floor(maxChars * 0.72));
  const tailLength = Math.max(16, Math.min(160, maxChars - headLength - 32));
  const safeHeadLength = Math.max(0, Math.min(headLength, maxChars));
  const safeTailLength = Math.max(0, Math.min(tailLength, Math.max(0, maxChars - safeHeadLength - 32)));
  const omittedChars = Math.max(0, normalized.length - safeHeadLength - safeTailLength);
  const truncated = [
    normalized.slice(0, safeHeadLength).trimEnd(),
    `... [truncated ${omittedChars} chars] ...`,
    safeTailLength > 0 ? normalized.slice(-safeTailLength).trimStart() : '',
  ]
    .filter(Boolean)
    .join('\n');

  return truncated.length <= maxChars ? truncated : truncated.slice(0, maxChars).trimEnd();
}

function sanitizePromptText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

