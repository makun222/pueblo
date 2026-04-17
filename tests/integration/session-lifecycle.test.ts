import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRepository } from '../../src/sessions/session-repository';
import { SessionService } from '../../src/sessions/session-service';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('session lifecycle integration', () => {
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
});
