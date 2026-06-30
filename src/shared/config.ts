import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_GITHUB_COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions';
const DEFAULT_GITHUB_COPILOT_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const DEFAULT_GITHUB_OAUTH_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const providerSettingSchema = z.object({
  providerId: z.string().min(1),
  defaultModelId: z.string().min(1),
  enabled: z.boolean().default(true),
  credentialSource: z.enum(['env', 'config-file', 'external-login', 'windows-credential-manager']).default('env'),
});

const desktopWindowSchema = z.object({
  enabled: z.boolean().default(true),
  title: z.string().min(1).default('Pueblo'),
  width: z.number().int().positive().default(1200),
  height: z.number().int().positive().default(820),
});

const githubCopilotSchema = z.object({
  token: z.string().trim().min(1).optional(),
  tokenType: z.enum(['copilot-access-token', 'github-auth-token', 'github-pat']).optional(),
  credentialTarget: z.string().trim().min(1).optional(),
  oauthClientId: z.string().trim().min(1).optional(),
  apiUrl: z.string().url().default(DEFAULT_GITHUB_COPILOT_API_URL),
  exchangeUrl: z.string().url().default(DEFAULT_GITHUB_COPILOT_EXCHANGE_URL),
  deviceCodeUrl: z.string().url().default(DEFAULT_GITHUB_DEVICE_CODE_URL),
  oauthAccessTokenUrl: z.string().url().default(DEFAULT_GITHUB_OAUTH_ACCESS_TOKEN_URL),
  scopes: z.array(z.string().min(1)).default([]),
  userAgent: z.string().min(1).default('Pueblo/0.1.0'),
  editorVersion: z.string().min(1).default('vscode/1.99.0'),
  editorPluginVersion: z.string().min(1).default('copilot-chat/0.43.0'),
  integrationId: z.string().min(1).default('vscode-chat'),
});

const deepseekSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  credentialTarget: z.string().trim().min(1).optional(),
  baseUrl: z.string().url().default('https://api.deepseek.com'),
});

export const DEFAULT_PEPE_RANKING_CONFIG = {
  recentStickyWindow: 6,
  stickyMemoryBonus: 0.08,
  stepSummaryMemoryBonus: 0.03,
  stickyRetentionDelta: 0.2,
  minRetentionSimilarity: 0.35,
  stickyDecayFactor: 0.6,
  relatedMemoryWeightFactor: 0.75,
} as const;

const pepeRankingSchema = z.object({
  recentStickyWindow: z.number().int().positive().default(DEFAULT_PEPE_RANKING_CONFIG.recentStickyWindow),
  stickyMemoryBonus: z.number().min(0).default(DEFAULT_PEPE_RANKING_CONFIG.stickyMemoryBonus),
  stepSummaryMemoryBonus: z.number().min(0).default(DEFAULT_PEPE_RANKING_CONFIG.stepSummaryMemoryBonus),
  stickyRetentionDelta: z.number().min(0).default(DEFAULT_PEPE_RANKING_CONFIG.stickyRetentionDelta),
  minRetentionSimilarity: z.number().min(0).max(1).default(DEFAULT_PEPE_RANKING_CONFIG.minRetentionSimilarity),
  stickyDecayFactor: z.number().min(0).max(1).default(DEFAULT_PEPE_RANKING_CONFIG.stickyDecayFactor),
  relatedMemoryWeightFactor: z.number().min(0).max(1).default(DEFAULT_PEPE_RANKING_CONFIG.relatedMemoryWeightFactor),
});

const pepeSchema = z.object({
  enabled: z.boolean().default(true),
  enableBudgetAwareResultTruncation: z.boolean().default(false),
  enableDeterministicRecall: z.boolean().default(false),
  deterministicRecallMaxResults: z.number().int().positive().default(4),
  deterministicRecallMinWeight: z.number().min(0).max(1).default(0.35),
  deterministicRecallLookbackTurns: z.number().int().positive().default(6),
  providerId: z.string().trim().min(1).nullable().default(null),
  modelId: z.string().trim().min(1).nullable().default(null),
  embeddingProviderId: z.string().trim().min(1).nullable().default(null),
  embeddingModelId: z.string().trim().min(1).nullable().default(null),
  embeddingBackend: z.enum(['sentence-transformers', 'local-hash']).default('sentence-transformers'),
  localEmbeddingModel: z.string().trim().min(1).default('all-MiniLM-L6-v2'),
  pythonCommand: z.string().trim().min(1).default('python'),
  flushIntervalMs: z.number().int().positive().default(2_000),
  summaryIntervalMs: z.number().int().positive().default(5_000),
  resultTopK: z.number().int().positive().default(8),
  similarityThreshold: z.number().min(0).max(1).default(0.2),
  ranking: pepeRankingSchema.default(DEFAULT_PEPE_RANKING_CONFIG),
  workingDirectoryPattern: z.string().min(1).default('agent-{agentInstanceId}'),
  skillDirectoryName: z.string().trim().min(1).default('skills'),
  memoryBasePath: z.string().min(1).default(path.join('.pueblo','memory')),
});

const workflowSchema = z.object({
  enabled: z.boolean().default(true),
  defaultWorkflowType: z.string().min(1).default('pueblo-plan'),
  runtimeDirectory: z.string().min(1).default('.plans'),
  deliverableFilePattern: z.string().min(1).default('{slug}.plan.md'),
  maxDirectTaskSteps: z.number().int().positive().default(30),
  routeKeywords: z.array(z.string().min(1)).default(['plan.md', '.plan.md', 'workflow']),
});

export const DEFAULT_MEMORY_WEIGHT_POLICY = {
  initialWeight: 0.8,
  minWeight: 0,
  maxWeight: 1,
  decayPerTurn: 0.1,
  mergeThreshold: 0.3,
  defaultAdjustmentDelta: 0.1,
} as const;

const memoryWeightPolicySchema = z.object({
  initialWeight: z.number().min(0).default(DEFAULT_MEMORY_WEIGHT_POLICY.initialWeight),
  minWeight: z.number().min(0).default(DEFAULT_MEMORY_WEIGHT_POLICY.minWeight),
  maxWeight: z.number().positive().default(DEFAULT_MEMORY_WEIGHT_POLICY.maxWeight),
  decayPerTurn: z.number().min(0).default(DEFAULT_MEMORY_WEIGHT_POLICY.decayPerTurn),
  mergeThreshold: z.number().min(0).default(DEFAULT_MEMORY_WEIGHT_POLICY.mergeThreshold),
  defaultAdjustmentDelta: z.number().min(0).default(DEFAULT_MEMORY_WEIGHT_POLICY.defaultAdjustmentDelta),
}).superRefine((policy, ctx) => {
  if (policy.minWeight > policy.maxWeight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minWeight'],
      message: 'minWeight must be less than or equal to maxWeight',
    });
  }

  if (policy.initialWeight < policy.minWeight || policy.initialWeight > policy.maxWeight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialWeight'],
      message: 'initialWeight must be within the minWeight and maxWeight range',
    });
  }

  if (policy.mergeThreshold < policy.minWeight || policy.mergeThreshold > policy.maxWeight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mergeThreshold'],
      message: 'mergeThreshold must be within the minWeight and maxWeight range',
    });
  }
});

export const DEFAULT_MEMORY_CONFIG = {
  turn: DEFAULT_MEMORY_WEIGHT_POLICY,
  derivedSummary: {
    initialWeight: 0.65,
    minWeight: 0,
    maxWeight: 1,
    decayPerTurn: 0.08,
    mergeThreshold: 0.25,
    defaultAdjustmentDelta: 0.08,
  },
  sessionSummary: {
    initialWeight: 0.9,
    minWeight: 0.2,
    maxWeight: 1,
    decayPerTurn: 0.05,
    mergeThreshold: 0.35,
    defaultAdjustmentDelta: 0.05,
  },
  knowledge: {
    initialWeight: 1,
    minWeight: 0.4,
    maxWeight: 1,
    decayPerTurn: 0.02,
    mergeThreshold: 0.4,
    defaultAdjustmentDelta: 0.05,
  },
  workflow: {
    initialWeight: 1,
    minWeight: 0.4,
    maxWeight: 1,
    decayPerTurn: 0.02,
    mergeThreshold: 0.4,
    defaultAdjustmentDelta: 0.05,
  },
} as const;

const memorySchema = z.object({
  turn: memoryWeightPolicySchema.default(DEFAULT_MEMORY_CONFIG.turn),
  derivedSummary: memoryWeightPolicySchema.default(DEFAULT_MEMORY_CONFIG.derivedSummary),
  sessionSummary: memoryWeightPolicySchema.default(DEFAULT_MEMORY_CONFIG.sessionSummary),
  knowledge: memoryWeightPolicySchema.default(DEFAULT_MEMORY_CONFIG.knowledge),
  workflow: memoryWeightPolicySchema.default(DEFAULT_MEMORY_CONFIG.workflow),
});

const appConfigSchema = z.object({
  databasePath: z.string().min(1).default(path.join('.pueblo', 'pueblo.db')),
  defaultProviderId: z.string().min(1).nullable().default(null),
  defaultAgentProfileId: z.string().min(1).nullable().default('code-master'),
  defaultSessionId: z.string().min(1).nullable().default(null),
  providers: z.array(providerSettingSchema).default([]),
  desktopWindow: desktopWindowSchema.default({
    enabled: true,
    title: 'Pueblo',
    width: 1200,
    height: 820,
  }),
  deepseek: deepseekSchema.default({
    baseUrl: 'https://api.deepseek.com',
  }),
  pepe: pepeSchema.default({
    enabled: true,
    enableBudgetAwareResultTruncation: false,
    enableDeterministicRecall: false,
    deterministicRecallMaxResults: 4,
    deterministicRecallMinWeight: 0.35,
    deterministicRecallLookbackTurns: 6,
    providerId: null,
    modelId: null,
    embeddingProviderId: null,
    embeddingModelId: null,
    embeddingBackend: 'sentence-transformers',
    localEmbeddingModel: 'all-MiniLM-L6-v2',
    pythonCommand: 'python',
    flushIntervalMs: 2_000,
    summaryIntervalMs: 5_000,
    resultTopK: 50,
    similarityThreshold: 0.8,
    ranking: DEFAULT_PEPE_RANKING_CONFIG,
    workingDirectoryPattern: 'agent-{agentInstanceId}',
    skillDirectoryName: 'skills',
    memoryBasePath: '.pueblo/memory',
  }),
  memory: memorySchema.default(DEFAULT_MEMORY_CONFIG),
  workflow: workflowSchema.default({
    enabled: true,
    defaultWorkflowType: 'pueblo-plan',
    runtimeDirectory: '.plans',
    deliverableFilePattern: '{slug}.plan.md',
    maxDirectTaskSteps: 30,
    routeKeywords: ['plan.md', '.plan.md', 'workflow'],
  }),
  githubCopilot: githubCopilotSchema.default({
    apiUrl: DEFAULT_GITHUB_COPILOT_API_URL,
    exchangeUrl: DEFAULT_GITHUB_COPILOT_EXCHANGE_URL,
    deviceCodeUrl: DEFAULT_GITHUB_DEVICE_CODE_URL,
    oauthAccessTokenUrl: DEFAULT_GITHUB_OAUTH_ACCESS_TOKEN_URL,
    scopes: [],
    userAgent: 'Pueblo/0.1.0',
    editorVersion: 'vscode/1.99.0',
    editorPluginVersion: 'copilot-chat/0.43.0',
    integrationId: 'vscode-chat',
  }),
});

export type ProviderSetting = z.infer<typeof providerSettingSchema>;
export type DesktopWindowConfig = z.infer<typeof desktopWindowSchema>;
export type DeepSeekConfig = z.infer<typeof deepseekSchema>;
export type PepeRankingConfig = z.infer<typeof pepeRankingSchema>;
export type PepeConfig = z.infer<typeof pepeSchema>;
export type MemoryWeightPolicyConfig = z.infer<typeof memoryWeightPolicySchema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
export type WorkflowConfig = z.infer<typeof workflowSchema>;
export type GitHubCopilotConfig = z.infer<typeof githubCopilotSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

export interface ConfigLoadOptions {
  readonly cwd?: string;
  readonly configPath?: string;
}

export function resolveConfigPath(options: ConfigLoadOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();

  if (options.configPath) {
    return path.resolve(cwd, options.configPath);
  }

  return path.resolve(cwd, '.pueblo', 'config.json');
}

export function loadAppConfig(options: ConfigLoadOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(options);

  if (!fs.existsSync(configPath)) {
    return appConfigSchema.parse({});
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const config = appConfigSchema.parse(parsed);

  return {
    ...config,
    databasePath: path.resolve(cwd, config.databasePath),
    pepe: {
      ...config.pepe,
      memoryBasePath: path.resolve(cwd, config.pepe.memoryBasePath),
    },
    workflow: {
      ...config.workflow,
      runtimeDirectory: path.resolve(cwd, config.workflow.runtimeDirectory),
    },
  };
}

/**
 * Reads .pueblo/config.json (given an optional puebloPath, defaults to cwd)
 * and returns the default provider/model identifier as { provider, name }.
 * Falls back to { provider: 'openai', name: 'gpt-4o' } if config is missing or incomplete.
 */
export function getDefaultModelIdentifier(puebloPath?: string): { provider: string; name: string } {
  const fallback = { provider: 'openai', name: 'gpt-4o' };
  try {
    const configDir = path.join(puebloPath || process.cwd(), '.pueblo');
    const configPath = path.join(configDir, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config: {
      defaultProviderId?: string;
      providers?: Array<{ id: string; defaultModelId?: string }>;
    } = JSON.parse(raw);
    const providerId = config.defaultProviderId;
    if (!providerId) return fallback;
    const provider = config.providers?.find(p => p.id === providerId);
    const modelId = provider?.defaultModelId;
    if (!modelId) return fallback;
    return { provider: providerId, name: modelId };
  } catch {
    return fallback;
  }
}
