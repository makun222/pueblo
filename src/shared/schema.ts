import { z } from 'zod';

export const providerStatusSchema = z.enum(['active', 'unavailable', 'disabled']);
export const providerAuthStateSchema = z.enum(['configured', 'missing', 'invalid']);

export const providerCapabilitySchema = z.object({
  codeExecution: z.boolean(),
  toolUse: z.boolean(),
  streaming: z.boolean(),
});

export const providerModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  supportsTools: z.boolean().default(false),
});

export const providerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: providerStatusSchema,
  authState: providerAuthStateSchema.default('missing'),
  defaultModelId: z.string().min(1),
  models: z.array(providerModelSchema).min(1),
  capabilities: providerCapabilitySchema,
}).superRefine((profile, ctx) => {
  const hasDefaultModel = profile.models.some((model) => model.id === profile.defaultModelId);

  if (!hasDefaultModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'defaultModelId must match one of the provider models',
      path: ['defaultModelId'],
    });
  }
});

export const sessionStatusSchema = z.enum(['active', 'archived', 'deleted']);
export const sessionKindSchema = z.enum(['user', 'background-summary']);
export const sessionTriggerReasonSchema = z.enum(['context-threshold', 'manual-summary']);
export const sessionMessageRoleSchema = z.enum(['user', 'assistant', 'tool', 'system']);

export const sessionMessageSchema = z.object({
  id: z.string().min(1),
  role: sessionMessageRoleSchema,
  content: z.string().min(1),
  createdAt: z.string().datetime(),
  taskId: z.string().min(1).nullable(),
  toolName: z.string().min(1).nullable(),
  /** 所属回合 ID，格式为 "<sessionId>-turn-<number>"；未分配时省略 */
  turnId: z.string().min(1).nullable().optional(),
});

export const contextCountBreakdownSchema = z.object({
  systemPromptTokens: z.number().int().nonnegative(),
  userInputTokens: z.number().int().nonnegative(),
  toolResultTokens: z.number().int().nonnegative(),
});

export const contextCountSchema = z.object({
  estimatedTokens: z.number().int().nonnegative(),
  contextWindowLimit: z.number().int().positive().nullable(),
  utilizationRatio: z.number().min(0).nullable(),
  messageCount: z.number().int().nonnegative(),
  selectedPromptCount: z.number().int().nonnegative(),
  selectedMemoryCount: z.number().int().nonnegative(),
  derivedMemoryCount: z.number().int().nonnegative(),
  breakdown: contextCountBreakdownSchema.optional(),
});

export const backgroundSummaryStateSchema = z.enum(['idle', 'running', 'failed', 'cooldown']);

export const backgroundSummaryStatusSchema = z.object({
  state: backgroundSummaryStateSchema,
  activeSummarySessionId: z.string().min(1).nullable(),
  lastSummaryAt: z.string().datetime().nullable(),
  lastSummaryMemoryId: z.string().min(1).nullable(),
});

export const providerUsageStatsSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  promptCacheHitTokens: z.number().int().nonnegative().default(0),
  promptCacheMissTokens: z.number().int().nonnegative().default(0),
  cachedPromptTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  promptTokensSent: z.number().int().nonnegative().default(0),
  cacheHitRatio: z.number().min(0).max(1).nullable().default(null),
});

export const pepeResultItemSchema = z.object({
  memoryId: z.string().min(1),
  summary: z.string().min(1),
  similarity: z.number().min(0).max(1),
  sourceSessionId: z.string().min(1).nullable(),
  vectorVersion: z.string().min(1),
});

export const pepeResultSetSchema = z.object({
  sessionId: z.string().min(1),
  agentInstanceId: z.string().min(1).nullable(),
  inputFingerprint: z.string().min(1),
  items: z.array(pepeResultItemSchema),
  generatedAt: z.string().datetime(),
});

export const puebloSummaryPolicySchema = z.object({
  autoSummarize: z.boolean(),
  thresholdHint: z.number().int().positive().nullable(),
  lineageHint: z.string().min(1).nullable(),
});

export const puebloProfileSchema = z.object({
  roleDirectives: z.array(z.string()),
  goalDirectives: z.array(z.string()),
  constraintDirectives: z.array(z.string()),
  styleDirectives: z.array(z.string()),
  memoryPolicy: z.object({
    retentionHints: z.array(z.string()),
    summaryHints: z.array(z.string()),
  }),
  contextPolicy: z.object({
    priorityHints: z.array(z.string()),
    truncationHints: z.array(z.string()),
    activeTurnStepWindow: z.number().int().positive().default(3)
      .describe('Number of recent steps to include in active turn context (sliding window)'),
    // Task A: Weight thresholds for section-level injection filtering (Q2)
    injectionWeightThreshold: z.object({
      sessionSummary: z.number().min(0).max(1).default(0.2)
        .describe('Weight threshold for session summary injection'),
      recentConversation: z.number().min(0).max(1).default(0.3)
        .describe('Weight threshold for recent conversation injection'),
      relevantResultItems: z.number().min(0).max(1).default(0.4)
        .describe('Weight threshold for result items injection'),
    }).default({
      sessionSummary: 0.2,
      recentConversation: 0.3,
      relevantResultItems: 0.4,
    }),
    // Task B: Reserved budget for ABCD classification guarantee (Q4)
    reservedBudget: z.object({
      recentConversation: z.number().min(0).max(1).default(0.3)
        .describe('Reserved budget percentage (0-1) for B-level (recent conversation)'),
    }).default({
      recentConversation: 0.3,
    }),
  }),
  summaryPolicy: puebloSummaryPolicySchema,
  loadedFromPath: z.string().min(1).nullable(),
  loadedAt: z.string().datetime(),
});

export const agentProfileTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  roleDirectives: z.array(z.string()),
  goalDirectives: z.array(z.string()),
  constraintDirectives: z.array(z.string()),
  styleDirectives: z.array(z.string()),
  memoryPolicy: z.object({
    retentionHints: z.array(z.string()),
    summaryHints: z.array(z.string()),
  }),
  contextPolicy: z.object({
    priorityHints: z.array(z.string()),
    truncationHints: z.array(z.string()),
    activeTurnStepWindow: z.number().int().positive().default(3)
      .describe('Number of recent steps to include in active turn context (overridable in profile)'),
    injectionWeightThreshold: z.object({
      sessionSummary: z.number().min(0).max(1).default(0.2)
        .describe('Weight threshold for session summary injection'),
      recentConversation: z.number().min(0).max(1).default(0.3)
        .describe('Weight threshold for recent conversation injection'),
      relevantResultItems: z.number().min(0).max(1).default(0.4)
        .describe('Weight threshold for result items injection'),
    }).default({
      sessionSummary: 0.2,
      recentConversation: 0.3,
      relevantResultItems: 0.4,
    }),
    reservedBudget: z.object({
      recentConversation: z.number().min(0).max(1).default(0.3)
        .describe('Reserved budget percentage (0-1) for B-level (recent conversation)'),
    }).default({
      recentConversation: 0.3,
    }),
  }),
  summaryPolicy: puebloSummaryPolicySchema,
});

export const agentInstanceStatusSchema = z.enum(['ready', 'active', 'idle', 'terminated']);

export const agentInstanceSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  profileName: z.string().min(1),
  status: agentInstanceStatusSchema,
  isDefaultForProfile: z.boolean().default(false),
  workspaceRoot: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  terminatedAt: z.string().datetime().nullable(),
});

export const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: sessionStatusSchema,
  sessionKind: sessionKindSchema.default('user'),
  agentInstanceId: z.string().min(1).nullable().optional().transform((value) => value ?? null),
  currentModelId: z.string().min(1).nullable(),
  messageHistory: z.array(sessionMessageSchema),
  selectedPromptIds: z.array(z.string()),
  pinnedMemoryIds: z.array(z.string()).optional(),
  workingMemoryIds: z.array(z.string()).optional(),
  selectedMemoryIds: z.array(z.string()).default([]),
  providerUsageStats: providerUsageStatsSchema.default({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    promptTokensSent: 0,
    cacheHitRatio: null,
  }),
  originSessionId: z.string().min(1).nullable(),
  triggerReason: sessionTriggerReasonSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
}).transform((session) => {
  const pinnedMemoryIds = uniqueStringValues(session.pinnedMemoryIds ?? session.selectedMemoryIds);
  const workingMemoryIds = uniqueStringValues(session.workingMemoryIds ?? []);
  const selectedMemoryIds = uniqueStringValues([
    ...session.selectedMemoryIds,
    ...pinnedMemoryIds,
    ...workingMemoryIds,
  ]);

  return {
    ...session,
    pinnedMemoryIds,
    workingMemoryIds,
    selectedMemoryIds,
  };
});

export const agentSessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: sessionStatusSchema,
  sessionKind: sessionKindSchema.default('user'),
  agentInstanceId: z.string().min(1).nullable().optional().transform((value) => value ?? null),
  currentModelId: z.string().min(1).nullable(),
  messageCount: z.number().int().nonnegative(),
  selectedMemoryCount: z.number().int().nonnegative(),
  preview: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
});

export const memoryTypeSchema = z.enum(['short-term', 'long-term']);
export const memoryScopeSchema = z.enum(['session', 'project', 'global']);
export const memoryStatusSchema = z.enum(['active', 'expired', 'deleted']);
export const memoryDerivationTypeSchema = z.enum(['manual', 'summary', 'imported']);
export const memoryKindSchema = z.enum(['generic', 'turn', 'summary', 'workflow', 'knowledge', 'workspace-setting']);

export const memoryQuerySchema = z.object({
  text: z.string().trim().min(1).optional(),
  sessionId: z.string().min(1).nullable().optional(),
  memoryKinds: z.array(memoryKindSchema).min(1).optional(),
  minWeight: z.number().min(0).max(1).optional(),
  lookbackTurns: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().optional(),
});

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  type: memoryTypeSchema,
  memoryKind: memoryKindSchema.default('generic'),
  title: z.string().min(1),
  content: z.string().min(1),
  contentHash: z.string().optional(),
  scope: memoryScopeSchema,
  status: memoryStatusSchema,
  tags: z.array(z.string()),
  parentId: z.string().min(1).nullable(),
  derivationType: memoryDerivationTypeSchema.default('manual'),
  summaryDepth: z.number().int().nonnegative().default(0),
  weight: z.number().min(0).default(0),
  lastAccessedAt: z.string().datetime().nullable().default(null),
  sourceSessionId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const promptStatusSchema = z.enum(['active', 'deleted']);

export const promptAssetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  content: z.string().min(1),
  status: promptStatusSchema,
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const agentTaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

export const agentTaskSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  status: agentTaskStatusSchema,
  sessionId: z.string().min(1).nullable(),
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  inputContextSummary: z.string().min(1),
  outputSummary: z.string().nullable(),
  toolInvocationIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).superRefine((task, ctx) => {
  if (task.status === 'running' && (!task.sessionId || !task.modelId || !task.providerId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'running task must include sessionId, providerId, and modelId',
      path: ['status'],
    });
  }

  if ((task.status === 'completed' || task.status === 'failed') && !task.outputSummary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'completed or failed task must include outputSummary',
      path: ['outputSummary'],
    });
  }
});

export const workflowTypeSchema = z.enum(['pueblo-plan']);
export const workflowStatusSchema = z.enum([
  'idle',
  'assessing',
  'planning',
  'round-active',
  'round-review',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

export const runtimePlanMetadataSchema = z.object({
  runtimePlanPath: z.string().min(1),
  deliverablePlanPath: z.string().min(1).nullable(),
  updatedAt: z.string().datetime(),
});

export const workflowContextSchema = z.object({
  workflowId: z.string().min(1),
  workflowType: workflowTypeSchema,
  status: workflowStatusSchema,
  planSummary: z.string().min(1).nullable(),
  todoSummary: z.string().min(1).nullable(),
  planMemoryId: z.string().min(1).nullable(),
  todoMemoryId: z.string().min(1).nullable(),
  runtimePlanPath: z.string().min(1),
  deliverablePlanPath: z.string().min(1).nullable(),
  activeRoundNumber: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().datetime(),
});

export const workflowInstanceSchema = z.object({
  id: z.string().min(1),
  type: workflowTypeSchema,
  status: workflowStatusSchema,
  sessionId: z.string().min(1).nullable(),
  agentInstanceId: z.string().min(1).nullable(),
  goal: z.string().min(1),
  targetDirectory: z.string().min(1).nullable(),
  runtimePlanPath: z.string().min(1),
  deliverablePlanPath: z.string().min(1).nullable(),
  activePlanMemoryId: z.string().min(1).nullable(),
  activeTodoMemoryId: z.string().min(1).nullable(),
  activeRoundNumber: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
});

function uniqueStringValues(values: string[]): string[] {
  return [...new Set(values)];
}

// ── Agent Collaboration ──────────────────────────────────────────

export const collaborationNodeSchema = z.object({
  nodeId: z.string().min(1),
  agentProfileId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  role: z.string().min(1),
});

export const collaborationEdgeSchema = z.object({
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
});

export const collaborationGraphSchema = z.object({
  nodes: z.array(collaborationNodeSchema).min(1),
  edges: z.array(collaborationEdgeSchema),
});

export const collaborationCompletionTypeSchema = z.enum([
  'maxRounds',
  'agentApproval',
  'noChanges',
  'fixedOutput',
]);

export const collaborationCompletionCriteriaSchema = z.object({
  type: collaborationCompletionTypeSchema,
  maxRounds: z.number().int().positive().optional(),
  approvalNodeId: z.string().min(1).optional(),
  noChangesRounds: z.number().int().positive().optional(),
  fixedOutputPath: z.string().min(1).optional(),
});

export const nodeRoundResultStatusSchema = z.enum(['running', 'succeeded', 'failed']);

export const nodeRoundResultSchema = z.object({
  nodeId: z.string().min(1),
  agentProfileId: z.string().min(1),
  status: nodeRoundResultStatusSchema,
  outputSummary: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export const collaborationRoundStatusSchema = z.enum(['in-progress', 'completed', 'failed']);

export const collaborationRoundSchema = z.object({
  roundNumber: z.number().int().positive(),
  nodeResults: z.array(nodeRoundResultSchema),
  status: collaborationRoundStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export const collaborationStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const collaborationInstanceSchema = z.object({
  id: z.string().min(1),
  graph: collaborationGraphSchema,
  goal: z.string().min(1),
  completionCriteria: collaborationCompletionCriteriaSchema,
  status: collaborationStatusSchema,
  rounds: z.array(collaborationRoundSchema),
  currentNodeId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
});

export const commandTargetTypeSchema = z.enum(['session', 'model', 'prompt', 'memory', 'system']);
export const commandResultStatusSchema = z.enum(['succeeded', 'failed', 'no-op']);

export const commandActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().startsWith('/'),
  targetType: commandTargetTypeSchema,
  arguments: z.record(z.string(), z.unknown()),
  resultStatus: commandResultStatusSchema,
  resultMessage: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
});

export const toolNameSchema = z.enum(['grep', 'glob', 'exec', 'shell_exec', 'read', 'edit', 'write', 'undo_edit', 'memo_recall']);
export const toolResultStatusSchema = z.enum(['succeeded', 'failed', 'empty']);

export const toolInvocationSchema = z.object({
  id: z.string().min(1),
  toolName: toolNameSchema,
  taskId: z.string().min(1),
  inputSummary: z.string().min(1),
  resultStatus: toolResultStatusSchema,
  resultSummary: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const desktopWindowStatusSchema = z.enum(['starting', 'ready', 'busy', 'closing', 'closed']);
export const rendererOutputBlockTypeSchema = z.enum(['command-result', 'task-result', 'tool-result', 'error', 'system', 'loop-launch']);

export const rendererMessageTraceMessageSchema = z.object({
  role: z.string().min(1),
  content: z.string(),
  toolName: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  toolArgs: z.unknown().optional(),
  charCount: z.number().int().nonnegative(),
});

export const rendererMessageTraceStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  messageCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
  messages: z.array(rendererMessageTraceMessageSchema),
});

export const rendererFileChangeTypeSchema = z.enum(['created', 'modified', 'deleted']);

export const rendererFileChangeSchema = z.object({
  path: z.string().min(1),
  absolutePath: z.string().min(1),
  changeType: rendererFileChangeTypeSchema,
  previousContent: z.string(),
  currentContent: z.string(),
});

export const rendererExecCommandSchema = z.object({
  rawCommand: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  result: z.string(),
});

export const attachmentKindSchema = z.enum(['document', 'spreadsheet']);

export const attachmentSourceSchema = z.object({
  fileName: z.string().min(1),
  originalPath: z.string().min(1),
  extension: z.string().min(1),
  mimeType: z.string().min(1),
});

export const attachmentAssetSchema = z.object({
  jsonPath: z.string().min(1),
  createdAt: z.string().datetime(),
  sizeBytes: z.number().int().nonnegative(),
  editable: z.boolean().default(true),
  schemaVersion: z.number().int().positive().default(1),
});

export const documentAttachmentChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  heading: z.string().min(1).nullable().default(null),
});

export const documentAttachmentContentSchema = z.object({
  chunks: z.array(documentAttachmentChunkSchema),
});

export const spreadsheetAttachmentCellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const spreadsheetAttachmentCellSchema = z.object({
  column: z.string().min(1),
  address: z.string().min(1),
  value: spreadsheetAttachmentCellValueSchema,
});

export const spreadsheetAttachmentRowSchema = z.object({
  rowIndex: z.number().int().positive(),
  cells: z.array(spreadsheetAttachmentCellSchema),
});

export const spreadsheetAttachmentSheetSchema = z.object({
  name: z.string().min(1),
  rows: z.array(spreadsheetAttachmentRowSchema),
});

export const spreadsheetAttachmentContentSchema = z.object({
  sheets: z.array(spreadsheetAttachmentSheetSchema),
});

export const attachmentManifestSummarySchema = z.object({
  isLarge: z.boolean(),
  chunkCount: z.number().int().nonnegative().nullable().default(null),
  sheetCount: z.number().int().nonnegative().nullable().default(null),
  rowCount: z.number().int().nonnegative().nullable().default(null),
  cellCount: z.number().int().nonnegative().nullable().default(null),
  previewText: z.string().nullable().default(null),
});

export const inputAttachmentManifestSchema = z.object({
  attachmentId: z.string().min(1),
  kind: attachmentKindSchema,
  source: attachmentSourceSchema,
  asset: attachmentAssetSchema,
  summary: attachmentManifestSummarySchema,
  inlineJsonExcerpt: z.string().nullable().default(null),
});

export const documentAttachmentAssetSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.literal('document'),
  source: attachmentSourceSchema,
  asset: attachmentAssetSchema,
  summary: attachmentManifestSummarySchema,
  content: documentAttachmentContentSchema,
});

export const spreadsheetAttachmentAssetSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.literal('spreadsheet'),
  source: attachmentSourceSchema,
  asset: attachmentAssetSchema,
  summary: attachmentManifestSummarySchema,
  content: spreadsheetAttachmentContentSchema,
});

export const rendererOutputBlockSchema = z.object({
  id: z.string().min(1),
  type: rendererOutputBlockTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  collapsed: z.boolean().default(false),
  messageTrace: z.array(rendererMessageTraceStepSchema).default([]),
  fileChanges: z.array(rendererFileChangeSchema).default([]),
  execCommand: rendererExecCommandSchema.optional(),
  sourceRefs: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});

export const desktopWindowSessionSchema = z.object({
  windowId: z.string().min(1),
  status: desktopWindowStatusSchema,
  activeSessionId: z.string().min(1).nullable(),
  inputDraft: z.string(),
  outputBlocks: z.array(rendererOutputBlockSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

export const ipcInputEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  windowId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  skillId: z.string().min(1).nullable().optional(),
  inputText: z.string().min(1),
  attachments: z.array(inputAttachmentManifestSchema).default([]),
  submittedAt: z.string().datetime(),
});

export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type ProviderAuthState = z.infer<typeof providerAuthStateSchema>;
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionKind = z.infer<typeof sessionKindSchema>;
export type SessionTriggerReason = z.infer<typeof sessionTriggerReasonSchema>;
export type SessionMessageRole = z.infer<typeof sessionMessageRoleSchema>;
export type SessionMessage = z.infer<typeof sessionMessageSchema>;
export type ContextCountBreakdown = z.infer<typeof contextCountBreakdownSchema>;
export type ContextCount = z.infer<typeof contextCountSchema>;
export type BackgroundSummaryState = z.infer<typeof backgroundSummaryStateSchema>;
export type BackgroundSummaryStatus = z.infer<typeof backgroundSummaryStatusSchema>;
export type ProviderUsageStats = z.infer<typeof providerUsageStatsSchema>;
export type PepeResultItem = z.infer<typeof pepeResultItemSchema>;
export type PepeResultSet = z.infer<typeof pepeResultSetSchema>;
export type PuebloProfile = z.infer<typeof puebloProfileSchema>;
export type AgentProfileTemplate = z.infer<typeof agentProfileTemplateSchema>;
export type AgentInstanceStatus = z.infer<typeof agentInstanceStatusSchema>;
export type AgentInstance = z.infer<typeof agentInstanceSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryDerivationType = z.infer<typeof memoryDerivationTypeSchema>;
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type PromptStatus = z.infer<typeof promptStatusSchema>;
export type PromptAsset = z.infer<typeof promptAssetSchema>;
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;
export type AgentTask = z.infer<typeof agentTaskSchema>;
export type WorkflowType = z.infer<typeof workflowTypeSchema>;
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type RuntimePlanMetadata = z.infer<typeof runtimePlanMetadataSchema>;
export type WorkflowContext = z.infer<typeof workflowContextSchema>;
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;
export type CollaborationNode = z.infer<typeof collaborationNodeSchema>;
export type CollaborationEdge = z.infer<typeof collaborationEdgeSchema>;
export type CollaborationGraph = z.infer<typeof collaborationGraphSchema>;
export type CollaborationCompletionType = z.infer<typeof collaborationCompletionTypeSchema>;
export type CollaborationCompletionCriteria = z.infer<typeof collaborationCompletionCriteriaSchema>;
export type NodeRoundResultStatus = z.infer<typeof nodeRoundResultStatusSchema>;
export type NodeRoundResult = z.infer<typeof nodeRoundResultSchema>;
export type CollaborationRoundStatus = z.infer<typeof collaborationRoundStatusSchema>;
export type CollaborationRound = z.infer<typeof collaborationRoundSchema>;
export type CollaborationStatus = z.infer<typeof collaborationStatusSchema>;
export type CollaborationInstance = z.infer<typeof collaborationInstanceSchema>;
export type CommandTargetType = z.infer<typeof commandTargetTypeSchema>;
export type CommandResultStatus = z.infer<typeof commandResultStatusSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type ToolName = z.infer<typeof toolNameSchema>;
export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type DesktopWindowStatus = z.infer<typeof desktopWindowStatusSchema>;
export type RendererOutputBlockType = z.infer<typeof rendererOutputBlockTypeSchema>;
export type RendererMessageTraceMessage = z.infer<typeof rendererMessageTraceMessageSchema>;
export type RendererMessageTraceStep = z.infer<typeof rendererMessageTraceStepSchema>;
export type RendererFileChangeType = z.infer<typeof rendererFileChangeTypeSchema>;
export type RendererFileChange = z.infer<typeof rendererFileChangeSchema>;
export type RendererExecCommand = z.infer<typeof rendererExecCommandSchema>;
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;
export type AttachmentSource = z.infer<typeof attachmentSourceSchema>;
export type AttachmentAsset = z.infer<typeof attachmentAssetSchema>;
export type DocumentAttachmentChunk = z.infer<typeof documentAttachmentChunkSchema>;
export type DocumentAttachmentContent = z.infer<typeof documentAttachmentContentSchema>;
export type SpreadsheetAttachmentCellValue = z.infer<typeof spreadsheetAttachmentCellValueSchema>;
export type SpreadsheetAttachmentCell = z.infer<typeof spreadsheetAttachmentCellSchema>;
export type SpreadsheetAttachmentRow = z.infer<typeof spreadsheetAttachmentRowSchema>;
export type SpreadsheetAttachmentSheet = z.infer<typeof spreadsheetAttachmentSheetSchema>;
export type SpreadsheetAttachmentContent = z.infer<typeof spreadsheetAttachmentContentSchema>;
export type AttachmentManifestSummary = z.infer<typeof attachmentManifestSummarySchema>;
export type InputAttachmentManifest = z.infer<typeof inputAttachmentManifestSchema>;
export type DocumentAttachmentAsset = z.infer<typeof documentAttachmentAssetSchema>;
export type SpreadsheetAttachmentAsset = z.infer<typeof spreadsheetAttachmentAssetSchema>;
export type RendererOutputBlock = z.infer<typeof rendererOutputBlockSchema>;
export type DesktopWindowSession = z.infer<typeof desktopWindowSessionSchema>;
export type IpcInputEnvelope = z.infer<typeof ipcInputEnvelopeSchema>;
