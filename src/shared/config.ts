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

const pepeSchema = z.object({
  enabled: z.boolean().default(true),
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
  workingDirectoryPattern: z.string().min(1).default('agent-{agentInstanceId}'),
});

const workflowSchema = z.object({
  enabled: z.boolean().default(true),
  defaultWorkflowType: z.string().min(1).default('pueblo-plan'),
  runtimeDirectory: z.string().min(1).default('.plans'),
  deliverableFilePattern: z.string().min(1).default('{slug}.plan.md'),
  maxDirectTaskSteps: z.number().int().positive().default(30),
  routeKeywords: z.array(z.string().min(1)).default(['plan.md', '.plan.md', 'workflow']),
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
    workingDirectoryPattern: 'agent-{agentInstanceId}',
  }),
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
export type PepeConfig = z.infer<typeof pepeSchema>;
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
    workflow: {
      ...config.workflow,
      runtimeDirectory: path.resolve(cwd, config.workflow.runtimeDirectory),
    },
  };
}
