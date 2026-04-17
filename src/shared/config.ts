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
  credentialSource: z.enum(['env', 'config-file', 'external-login']).default('env'),
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

const appConfigSchema = z.object({
  databasePath: z.string().min(1).default(path.join('.pueblo', 'pueblo.db')),
  defaultProviderId: z.string().min(1).nullable().default(null),
  defaultSessionId: z.string().min(1).nullable().default(null),
  providers: z.array(providerSettingSchema).default([]),
  desktopWindow: desktopWindowSchema.default({
    enabled: true,
    title: 'Pueblo',
    width: 1200,
    height: 820,
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
  };
}
