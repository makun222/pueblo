import fs from 'node:fs';
import path from 'node:path';
import { ProviderAuthError } from './provider-errors';
import { resolveConfigPath, type AppConfig } from '../shared/config';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface GitHubDeviceCodePayload {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

interface GitHubDeviceTokenPayload {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly interval?: number;
}

export interface GitHubCopilotDeviceFlowResult {
  readonly accessToken: string;
  readonly tokenType: 'github-auth-token';
  readonly scope: string;
}

export interface GitHubCopilotDeviceFlowDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export async function requestGitHubDeviceCode(
  config: AppConfig,
  dependencies: GitHubCopilotDeviceFlowDependencies = {},
): Promise<GitHubDeviceCodePayload> {
  const clientId = config.githubCopilot.oauthClientId?.trim();

  if (!clientId) {
    throw new ProviderAuthError('github-copilot', 'GitHub OAuth client id is missing. Set githubCopilot.oauthClientId in .pueblo/config.json.');
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: clientId,
  });

  if (config.githubCopilot.scopes.length > 0) {
    body.set('scope', config.githubCopilot.scopes.join(' '));
  }

  const response = await fetchImpl(config.githubCopilot.deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.githubCopilot.userAgent,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ProviderAuthError(
      'github-copilot',
      `GitHub device flow initialization failed (${response.status}): ${errorText || response.statusText}`,
    );
  }

  return await response.json() as GitHubDeviceCodePayload;
}

export async function pollGitHubDeviceAccessToken(
  config: AppConfig,
  deviceCode: GitHubDeviceCodePayload,
  dependencies: GitHubCopilotDeviceFlowDependencies = {},
): Promise<GitHubCopilotDeviceFlowResult> {
  const clientId = config.githubCopilot.oauthClientId?.trim();

  if (!clientId) {
    throw new ProviderAuthError('github-copilot', 'GitHub OAuth client id is missing. Set githubCopilot.oauthClientId in .pueblo/config.json.');
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const wait = dependencies.wait ?? defaultWait;
  const expiresAt = Date.now() + deviceCode.expires_in * 1000;
  let intervalSeconds = deviceCode.interval;

  while (Date.now() < expiresAt) {
    await wait(intervalSeconds * 1000);

    const response = await fetchImpl(config.githubCopilot.oauthAccessTokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': config.githubCopilot.userAgent,
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    });

    const payload = await response.json() as GitHubDeviceTokenPayload;

    if (payload.access_token?.trim()) {
      return {
        accessToken: payload.access_token.trim(),
        tokenType: 'github-auth-token',
        scope: payload.scope ?? '',
      };
    }

    if (payload.error === 'authorization_pending') {
      continue;
    }

    if (payload.error === 'slow_down') {
      intervalSeconds = payload.interval ?? intervalSeconds + 5;
      continue;
    }

    if (payload.error === 'expired_token') {
      throw new ProviderAuthError('github-copilot', 'Device code expired before authorization completed. Start login again.');
    }

    if (payload.error === 'access_denied') {
      throw new ProviderAuthError('github-copilot', 'GitHub device authorization was denied by the user.');
    }

    if (payload.error) {
      throw new ProviderAuthError(
        'github-copilot',
        payload.error_description || `GitHub device authorization failed: ${payload.error}`,
      );
    }

    if (!response.ok) {
      throw new ProviderAuthError('github-copilot', `GitHub device authorization failed (${response.status}).`);
    }
  }

  throw new ProviderAuthError('github-copilot', 'Device code expired before authorization completed. Start login again.');
}

export function persistGitHubCopilotDeviceAuth(
  config: AppConfig,
  accessToken: string,
  options: { cwd?: string; configPath?: string } = {},
): void {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath({ cwd, configPath: options.configPath });
  const configDir = path.dirname(configPath);
  const current = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    : {};

  const nextConfig = {
    ...current,
    databasePath: config.databasePath,
    defaultProviderId: config.defaultProviderId,
    defaultSessionId: config.defaultSessionId,
    providers: ensureGitHubProviderConfig(current.providers),
    desktopWindow: config.desktopWindow,
    githubCopilot: {
      ...(typeof current.githubCopilot === 'object' && current.githubCopilot !== null ? current.githubCopilot : {}),
      ...config.githubCopilot,
      token: accessToken,
      tokenType: 'github-auth-token',
    },
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
}

function ensureGitHubProviderConfig(currentProviders: unknown): Array<Record<string, unknown>> {
  const providers = Array.isArray(currentProviders) ? [...currentProviders] as Array<Record<string, unknown>> : [];
  const index = providers.findIndex((provider) => provider.providerId === 'github-copilot');
  const githubProvider = {
    providerId: 'github-copilot',
    defaultModelId: 'copilot-chat',
    enabled: true,
    credentialSource: 'config-file',
  };

  if (index === -1) {
    providers.push(githubProvider);
    return providers;
  }

  providers[index] = {
    ...providers[index],
    ...githubProvider,
  };
  return providers;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}