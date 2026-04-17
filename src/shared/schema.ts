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

export const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: sessionStatusSchema,
  currentModelId: z.string().min(1).nullable(),
  messageHistory: z.array(z.string()),
  selectedPromptIds: z.array(z.string()),
  selectedMemoryIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export const memoryTypeSchema = z.enum(['short-term', 'long-term']);
export const memoryScopeSchema = z.enum(['session', 'project', 'global']);
export const memoryStatusSchema = z.enum(['active', 'expired', 'deleted']);

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  type: memoryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  scope: memoryScopeSchema,
  status: memoryStatusSchema,
  tags: z.array(z.string()),
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

export const toolNameSchema = z.enum(['grep', 'glob', 'exec']);
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

export const rendererOutputBlockSchema = z.object({
  id: z.string().min(1),
  type: rendererOutputBlockTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  collapsed: z.boolean().default(false),
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
export type Session = z.infer<typeof sessionSchema>;
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
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
export type RendererOutputBlock = z.infer<typeof rendererOutputBlockSchema>;
export type DesktopWindowSession = z.infer<typeof desktopWindowSessionSchema>;
export type IpcInputEnvelope = z.infer<typeof ipcInputEnvelopeSchema>;
