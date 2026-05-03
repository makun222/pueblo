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
});

export const contextCountSchema = z.object({
  estimatedTokens: z.number().int().nonnegative(),
  contextWindowLimit: z.number().int().positive().nullable(),
  utilizationRatio: z.number().min(0).nullable(),
  messageCount: z.number().int().nonnegative(),
  selectedPromptCount: z.number().int().nonnegative(),
  selectedMemoryCount: z.number().int().nonnegative(),
  derivedMemoryCount: z.number().int().nonnegative(),
});

export const backgroundSummaryStateSchema = z.enum(['idle', 'running', 'failed', 'cooldown']);

export const backgroundSummaryStatusSchema = z.object({
  state: backgroundSummaryStateSchema,
  activeSummarySessionId: z.string().min(1).nullable(),
  lastSummaryAt: z.string().datetime().nullable(),
  lastSummaryMemoryId: z.string().min(1).nullable(),
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
  }),
  summaryPolicy: puebloSummaryPolicySchema,
});

export const agentInstanceStatusSchema = z.enum(['ready', 'active', 'idle', 'terminated']);

export const agentInstanceSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  profileName: z.string().min(1),
  status: agentInstanceStatusSchema,
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
  selectedMemoryIds: z.array(z.string()),
  originSessionId: z.string().min(1).nullable(),
  triggerReason: sessionTriggerReasonSchema.nullable(),
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

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  type: memoryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  scope: memoryScopeSchema,
  status: memoryStatusSchema,
  tags: z.array(z.string()),
  parentId: z.string().min(1).nullable(),
  derivationType: memoryDerivationTypeSchema.default('manual'),
  summaryDepth: z.number().int().nonnegative().default(0),
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

export const toolNameSchema = z.enum(['grep', 'glob', 'exec', 'read', 'edit']);
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
export const rendererOutputBlockTypeSchema = z.enum(['command-result', 'task-result', 'tool-result', 'error', 'system']);

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

export const rendererOutputBlockSchema = z.object({
  id: z.string().min(1),
  type: rendererOutputBlockTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  collapsed: z.boolean().default(false),
  messageTrace: z.array(rendererMessageTraceStepSchema).default([]),
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
  inputText: z.string().min(1),
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
export type ContextCount = z.infer<typeof contextCountSchema>;
export type BackgroundSummaryState = z.infer<typeof backgroundSummaryStateSchema>;
export type BackgroundSummaryStatus = z.infer<typeof backgroundSummaryStatusSchema>;
export type PepeResultItem = z.infer<typeof pepeResultItemSchema>;
export type PepeResultSet = z.infer<typeof pepeResultSetSchema>;
export type PuebloProfile = z.infer<typeof puebloProfileSchema>;
export type AgentProfileTemplate = z.infer<typeof agentProfileTemplateSchema>;
export type AgentInstanceStatus = z.infer<typeof agentInstanceStatusSchema>;
export type AgentInstance = z.infer<typeof agentInstanceSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryDerivationType = z.infer<typeof memoryDerivationTypeSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type PromptStatus = z.infer<typeof promptStatusSchema>;
export type PromptAsset = z.infer<typeof promptAssetSchema>;
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;
export type AgentTask = z.infer<typeof agentTaskSchema>;
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
export type RendererOutputBlock = z.infer<typeof rendererOutputBlockSchema>;
export type DesktopWindowSession = z.infer<typeof desktopWindowSessionSchema>;
export type IpcInputEnvelope = z.infer<typeof ipcInputEnvelopeSchema>;
