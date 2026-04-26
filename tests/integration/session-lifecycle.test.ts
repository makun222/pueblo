import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { SessionRepository } from '../../src/sessions/session-repository';
import { SessionService } from '../../src/sessions/session-service';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';
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

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

describeIfNodeSqlite('session lifecycle integration', () => {
  it('persists create, archive, restore, and delete transitions in sqlite', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-lifecycle-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const repository = new SessionRepository({ connection: database.connection });
    const service = new SessionService(repository);

    const created = service.createSession('Lifecycle session');
    const archived = service.archiveSession(created.id);
    const restored = service.restoreSession(created.id);
    const deleted = service.deleteSession(created.id);
    const sessions = service.listSessions();

    expect(archived.status).toBe('archived');
    expect(restored.status).toBe('active');
    expect(deleted.status).toBe('deleted');
    expect(sessions.find((session) => session.id === created.id)?.status).toBe('deleted');

    database.close();
  });

  it('persists selected prompt and memory ids in sqlite', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-selection-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const repository = new SessionRepository({ connection: database.connection });
    const service = new SessionService(repository);

    const created = service.createSession('Selection session');
    service.addSelectedPrompt(created.id, 'prompt-1');
    service.addSelectedPrompt(created.id, 'prompt-2');
    service.addSelectedMemory(created.id, 'memory-1');

    const restoredService = new SessionService(new SessionRepository({ connection: database.connection }));
    const restored = restoredService.getSession(created.id);

    expect(restored?.selectedPromptIds).toEqual(['prompt-1', 'prompt-2']);
    expect(restored?.selectedMemoryIds).toEqual(['memory-1']);

    database.close();
  });

  it('persists structured session message history in sqlite', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-messages-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const repository = new SessionRepository({ connection: database.connection });
    const service = new SessionService(repository);

    const created = service.createSession('Message session');
    service.addUserMessage(created.id, 'Inspect the workflow');
    service.addAssistantMessage(created.id, 'Workflow inspection complete', 'task-1');

    const restoredService = new SessionService(new SessionRepository({ connection: database.connection }));
    const restored = restoredService.getSession(created.id);

    expect(restored?.messageHistory).toHaveLength(2);
    expect(restored?.messageHistory[0]).toMatchObject({
      role: 'user',
      content: 'Inspect the workflow',
    });
    expect(restored?.messageHistory[1]).toMatchObject({
      role: 'assistant',
      content: 'Workflow inspection complete',
      taskId: 'task-1',
    });

    database.close();
  });

  it('creates a fresh empty session when desktop mode requests a new session', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-desktop-session-'));
    tempDirs.push(tempDir);
    const cli = createCliDependencies(createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    }), {
      startNewSession: true,
    });

    try {
      const listed = await cli.dispatcher.dispatch({ input: '/session-list' });
      const sessions = (listed.data as { sessions: Array<{ selectedMemoryIds: string[]; messageHistory: unknown[] }> }).sessions;

      expect(listed.ok).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.selectedMemoryIds).toEqual([]);
      expect(sessions[0]?.messageHistory).toEqual([]);
      expect(cli.getRuntimeStatus().activeSessionId).toBeTruthy();
    } finally {
      cli.databaseClose();
    }
  });
});
