import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRepository } from '../../src/sessions/session-repository';
import { SessionService } from '../../src/sessions/session-service';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';
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
});
