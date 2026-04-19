import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentTaskRepository } from '../../src/agent/task-repository';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';
import { createInMemoryProviderRegistry, createProviderProfile } from '../../src/providers/provider-profile';
import { InMemoryProviderAdapter } from '../../src/providers/provider-adapter';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows may hold the SQLite WAL files briefly.
      }
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

describeIfNodeSqlite('agent task persistence integration', () => {
  it('runs a provider-backed task and persists task history to sqlite', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-task-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new InMemoryProviderAdapter(profile.id, 'done'));

    const repository = new AgentTaskRepository({ connection: database.connection });
    const runner = new AgentTaskRunner(registry, repository);

    const result = await runner.run({
      goal: 'Summarize the repository state',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const persisted = repository.listBySession('session-1');

    expect(result.status).toBe('completed');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.outputSummary).toContain('done');

    database.close();
  });
});
