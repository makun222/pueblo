import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeRunCliStartupSetup } from '../../src/cli/index';
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

describe.sequential('cli startup auth setup', () => {
  let previousCwd = process.cwd();

  beforeEach(() => {
    previousCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();

      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('guides the user through GitHub device flow and persists the auth token', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-cli-auth-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    const { store, secrets } = createInMemoryCredentialStore();

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          device_code: 'device-code',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 0,
        }), {
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
          scope: '',
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchImpl);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

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

    const result = await maybeRunCliStartupSetup(config, { credentialStore: store });
    const savedConfig = JSON.parse(fs.readFileSync(path.join(tempDir, '.pueblo', 'config.json'), 'utf8')) as {
      githubCopilot: { credentialTarget?: string; token?: string };
      providers: Array<{ credentialSource: string }>;
    };

    expect(result.performed).toBe(true);
    expect(result.configured).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledWith('GitHub Copilot is not configured for CLI use. Starting device login flow...\n');
    expect(fs.existsSync(path.join(tempDir, '.pueblo', 'config.json'))).toBe(true);
    expect(savedConfig.githubCopilot.token).toBeUndefined();
    expect(savedConfig.githubCopilot.credentialTarget).toBeTruthy();
    expect(savedConfig.providers[0]?.credentialSource).toBe('windows-credential-manager');
    expect(secrets.get(savedConfig.githubCopilot.credentialTarget ?? '')).toBe('gho_access_token');
  });
});