import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskContext } from '../../src/agent/task-context';
import { CommandDispatcher, registerCoreCommands } from '../../src/commands/dispatcher';
import { verifyPersistence } from '../../src/persistence/health-check';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { loadAppConfig } from '../../src/shared/config';
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

describe('foundation', () => {
  it('loads default config when config file is absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-config-'));
    tempDirs.push(tempDir);

    const config = loadAppConfig({ cwd: tempDir });

    expect(config.providers).toEqual([]);
    expect(config.databasePath).toContain(path.join('.pueblo', 'pueblo.db'));
  });

  it('bootstraps sqlite and applies foundational migrations', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-db-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });

    try {
      const status = verifyPersistence(database, dbPath);
      const tables = database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;

      expect(status.ok).toBe(true);
      expect(tables.map((table) => table.name)).toContain('sessions');
      expect(tables.map((table) => table.name)).toContain('schema_migrations');
    } finally {
      database.close();
    }
  });

  it('dispatches registered core commands', async () => {
    const dispatcher = new CommandDispatcher();
    registerCoreCommands(dispatcher);

    const result = await dispatcher.dispatch({ input: '/ping' });
    const helpResult = await dispatcher.dispatch({ input: '/help' });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('PING_OK');
    expect(helpResult.ok).toBe(true);
    expect(helpResult.code).toBe('HELP');
    expect(helpResult.data).toMatchObject({
      commands: ['/help', '/ping'],
    });
  });

  it('creates a task context from config defaults', () => {
    const context = createTaskContext({
      config: createTestAppConfig({
        databasePath: '/tmp/pueblo.db',
        defaultProviderId: 'provider-a',
        defaultSessionId: null,
        providers: [],
      }),
    });

    expect(context.sessionId).toBeNull();
    expect(context.selectedModelId).toBeNull();
    expect(context.selectedPromptIds).toEqual([]);
    expect(context.selectedMemoryIds).toEqual([]);
  });
});
