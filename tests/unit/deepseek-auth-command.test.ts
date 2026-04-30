import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];
const describeIfNodeSqlite = nodeSqliteAvailable ? describe.sequential : describe.skip;

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

describeIfNodeSqlite('deepseek auth command', () => {
  let previousCwd = process.cwd();

  beforeEach(() => {
    previousCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(previousCwd);

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();

      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('stores DeepSeek credentials, registers the provider, and exposes both supported models', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-deepseek-auth-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    const { store, secrets } = createInMemoryCredentialStore();

    const config = createTestAppConfig({
      databasePath: '.pueblo/pueblo.db',
      defaultProviderId: null,
      providers: [],
      deepseek: {
        apiKey: undefined,
      },
    });

    const cli = createCliDependencies(config, { credentialStore: store });

    try {
      const authResult = await cli.dispatcher.dispatch({ input: '/provider-config deepseek set-key deepseek-secret deepseek-v4-pro https://api.deepseek.com' });
      const modelResult = await cli.dispatcher.dispatch({ input: '/model deepseek deepseek-v4-pro' });
      const listResult = await cli.dispatcher.dispatch({ input: '/model' });
      const savedConfig = JSON.parse(fs.readFileSync(path.join(tempDir, '.pueblo', 'config.json'), 'utf8')) as {
        providers: Array<{ providerId: string; defaultModelId: string; credentialSource: string }>;
        deepseek: { credentialTarget?: string; apiKey?: string; baseUrl: string };
      };

      expect(authResult.ok).toBe(true);
      expect(authResult.code).toBe('DEEPSEEK_AUTH_COMPLETED');
      expect(modelResult.ok).toBe(true);
      expect(savedConfig.deepseek.apiKey).toBeUndefined();
      expect(savedConfig.deepseek.credentialTarget).toBeTruthy();
      expect(savedConfig.deepseek.baseUrl).toBe('https://api.deepseek.com');
      expect(savedConfig.providers.find((provider) => provider.providerId === 'deepseek')).toMatchObject({
        defaultModelId: 'deepseek-v4-pro',
        credentialSource: 'windows-credential-manager',
      });
      expect(secrets.get(savedConfig.deepseek.credentialTarget ?? '')).toBe('deepseek-secret');
      expect(listResult.ok).toBe(true);
      expect((listResult.data as { models: Array<{ providerId: string; id: string }> }).models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ providerId: 'deepseek', id: 'deepseek-v4-flash' }),
          expect.objectContaining({ providerId: 'deepseek', id: 'deepseek-v4-pro' }),
        ]),
      );
    } finally {
      cli.databaseClose();
    }
  });
});