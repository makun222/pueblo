import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  persistGitHubCopilotDeviceAuth,
  pollGitHubDeviceAccessToken,
  requestGitHubDeviceCode,
  type GitHubDeviceCodePayload,
} from '../../src/providers/github-copilot-device-flow';
import { createTestAppConfig } from '../helpers/test-config';

function createInMemoryCredentialStore() {
  const secrets = new Map<string, string>();

  return {
    store: {
      kind: 'windows-credential-manager' as const,
      isSupported: () => true,
      readSecret: (target: string) => secrets.get(target) ?? null,
      writeSecret: (target: string, secret: string) => {
        secrets.set(target, secret);
      },
    },
    secrets,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('github copilot device flow', () => {
  it('requests a device code from GitHub OAuth device flow', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        device_code: 'device-code',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const config = createTestAppConfig({
      githubCopilot: {
        oauthClientId: 'client-id',
        deviceCodeUrl: 'https://github.com/login/device/code',
      },
    });

    const result = await requestGitHubDeviceCode(config, { fetchImpl });

    expect(result.user_code).toBe('WDJB-MJHT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code');
  });

  it('polls until GitHub returns an access token', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          access_token: 'gho_access_token',
          token_type: 'bearer',
          scope: 'read:user',
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
    const waits: number[] = [];
    const config = createTestAppConfig({
      githubCopilot: {
        oauthClientId: 'client-id',
        oauthAccessTokenUrl: 'https://github.com/login/oauth/access_token',
      },
    });
    const deviceCode: GitHubDeviceCodePayload = {
      device_code: 'device-code',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1,
    };

    const result = await pollGitHubDeviceAccessToken(config, deviceCode, {
      fetchImpl,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result.accessToken).toBe('gho_access_token');
    expect(result.tokenType).toBe('github-auth-token');
    expect(waits).toEqual([1000, 1000]);
  });

  it('persists the GitHub auth token into Windows credential storage and keeps only a reference in config.json', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-device-flow-'));
    tempDirs.push(tempDir);
    const { store, secrets } = createInMemoryCredentialStore();
    const config = createTestAppConfig({
      databasePath: '.pueblo/pueblo.db',
      defaultProviderId: 'github-copilot',
      providers: [
        {
          providerId: 'github-copilot',
          defaultModelId: 'copilot-chat',
          enabled: true,
          credentialSource: 'config-file',
        },
      ],
      githubCopilot: {
        oauthClientId: 'client-id',
      },
    });

    persistGitHubCopilotDeviceAuth(config, 'gho_access_token', { cwd: tempDir, credentialStore: store });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, '.pueblo', 'config.json'), 'utf8')) as {
      providers: Array<{ credentialSource: string }>;
      githubCopilot: { credentialTarget?: string; token?: string; tokenType: string };
    };

    expect(stored.githubCopilot.token).toBeUndefined();
    expect(stored.githubCopilot.credentialTarget).toMatch(/^Pueblo:GitHubCopilot:/);
    expect(stored.githubCopilot.tokenType).toBe('github-auth-token');
    expect(stored.providers[0]?.credentialSource).toBe('windows-credential-manager');
    expect(secrets.get(stored.githubCopilot.credentialTarget ?? '')).toBe('gho_access_token');
  });
});