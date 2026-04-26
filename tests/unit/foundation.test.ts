import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskContext } from '../../src/agent/task-context';
import { createEmptyPuebloProfile } from '../../src/agent/pueblo-profile';
import { CommandDispatcher, registerCoreCommands } from '../../src/commands/dispatcher';
import { verifyPersistence } from '../../src/persistence/health-check';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { loadAppConfig } from '../../src/shared/config';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

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

  const itIfNodeSqlite = nodeSqliteAvailable ? it : it.skip;

  itIfNodeSqlite('bootstraps sqlite and applies foundational migrations', () => {
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
      expect(tables.map((table) => table.name)).toContain('agent_instances');
    } finally {
      database.close();
    }
  });

  itIfNodeSqlite('backfills agent_instances for databases that already applied older migrations', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-db-upgrade-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });

    try {
      database.connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      database.connection.exec(`
        INSERT INTO schema_migrations (id, applied_at) VALUES
          ('001_initial_foundation', '2026-04-01T00:00:00.000Z'),
          ('002_provider_desktop_updates', '2026-04-02T00:00:00.000Z'),
          ('003_context_memory_metadata', '2026-04-03T00:00:00.000Z');
      `);

      const status = verifyPersistence(database, dbPath);
      const tables = database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const appliedMigrations = database.connection
        .prepare('SELECT id FROM schema_migrations ORDER BY id')
        .all() as Array<{ id: string }>;

      expect(status.ok).toBe(true);
      expect(status.appliedMigrations).toContain('004_agent_instances');
      expect(status.appliedMigrations).toContain('005_session_context_backfill');
      expect(tables.map((table) => table.name)).toContain('agent_instances');
      expect(appliedMigrations.map((migration) => migration.id)).toContain('004_agent_instances');
      expect(appliedMigrations.map((migration) => migration.id)).toContain('005_session_context_backfill');
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
      puebloProfile: createEmptyPuebloProfile(null),
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
    });

    expect(context.sessionId).toBeNull();
    expect(context.selectedModelId).toBeNull();
    expect(context.selectedPromptIds).toEqual([]);
    expect(context.selectedMemoryIds).toEqual([]);
  });
});
