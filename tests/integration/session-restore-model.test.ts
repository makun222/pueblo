import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('session restore with model continuity', () => {
  it('restores an archived session and keeps its selected model available', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-restore-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      const created = await cli.dispatcher.dispatch({ input: '/new repo work' });
      const sessionId = (created.data as { id: string }).id;
      await cli.dispatcher.dispatch({ input: '/model openai gpt-4.1-mini' });
      await cli.dispatcher.dispatch({ input: `/session-archive ${sessionId}` });
      const restored = await cli.dispatcher.dispatch({ input: `/session-restore ${sessionId}` });
      const listed = await cli.dispatcher.dispatch({ input: '/session-list' });

      expect(restored.ok).toBe(true);
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed.data)).toContain('gpt-4.1-mini');
    } finally {
      cli.databaseClose();
    }
  });
});
