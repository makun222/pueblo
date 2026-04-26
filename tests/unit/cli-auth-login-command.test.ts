import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

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

const describeIfNodeSqlite = nodeSqliteAvailable ? describe.sequential : describe.skip;

describeIfNodeSqlite('cli auth login command', () => {
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

  it('logs in on demand and refreshes the current cli provider state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-cli-login-'));
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
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

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

    const cli = createCliDependencies(config, { credentialStore: store });

    try {
      const loginResult = await cli.dispatcher.dispatch({ input: '/auth-login' });
      const modelResult = await cli.dispatcher.dispatch({ input: '/model github-copilot copilot-chat' });
      const savedConfig = JSON.parse(fs.readFileSync(path.join(tempDir, '.pueblo', 'config.json'), 'utf8')) as {
        githubCopilot: { credentialTarget?: string; token?: string };
      };

      expect(loginResult.ok).toBe(true);
      expect(loginResult.code).toBe('AUTH_LOGIN_COMPLETED');
      expect(modelResult.ok).toBe(true);
      expect(modelResult.code).toBe('MODEL_SELECTED');
      expect(savedConfig.githubCopilot.token).toBeUndefined();
      expect(savedConfig.githubCopilot.credentialTarget).toBeTruthy();
      expect(secrets.get(savedConfig.githubCopilot.credentialTarget ?? '')).toBe('gho_access_token');
    } finally {
      cli.databaseClose();
    }
  });
});