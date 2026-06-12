import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PepeWorkerRequest, PepeWorkerResponse } from '../../src/agent/pepe-worker-protocol';
import { createCliDependencies } from '../../src/cli/index';
import { MemoryRepository } from '../../src/memory/memory-repository';
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
    service.addPinnedMemory(created.id, 'memory-1');
    service.addWorkingMemory(created.id, 'memory-2');

    const restoredService = new SessionService(new SessionRepository({ connection: database.connection }));
    const restored = restoredService.getSession(created.id);

    expect(restored?.selectedPromptIds).toEqual(['prompt-1', 'prompt-2']);
    expect(restored?.pinnedMemoryIds).toEqual(['memory-1']);
    expect(restored?.workingMemoryIds).toEqual(['memory-2']);
    expect(restored?.selectedMemoryIds).toEqual(['memory-1', 'memory-2']);

    database.close();
  });

  it('redistributes legacy selected memories, retires step summaries, and normalizes misclassified turn memories', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-selection-migration-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });

    database.connection.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        session_kind TEXT NOT NULL DEFAULT 'user',
        agent_instance_id TEXT,
        current_model_id TEXT,
        message_history_json TEXT NOT NULL,
        selected_prompt_ids_json TEXT NOT NULL,
        selected_memory_ids_json TEXT NOT NULL,
        pinned_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        working_memory_ids_json TEXT NOT NULL DEFAULT '[]',
        provider_usage_stats_json TEXT NOT NULL DEFAULT '{}',
        origin_session_id TEXT,
        trigger_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        archived_at TEXT
      );
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        memory_kind TEXT NOT NULL DEFAULT 'generic',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        parent_id TEXT,
        derivation_type TEXT NOT NULL DEFAULT 'manual',
        summary_depth INTEGER NOT NULL DEFAULT 0,
        weight REAL NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const insertMigration = database.connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
    const appliedAt = new Date().toISOString();
    for (const id of [
      '001_initial_foundation',
      '002_provider_desktop_updates',
      '003_context_memory_metadata',
      '004_agent_instances',
      '005_session_context_backfill',
      '006_agent_instance_defaults',
      '007_workflow_instances',
      '008_session_provider_usage_stats',
      '009_memory_weight_policy',
      '010_session_memory_selection_layers',
    ]) {
      insertMigration.run(id, appliedAt);
    }

    const now = '2026-05-31T00:00:00.000Z';
    database.connection.prepare(`
      INSERT INTO sessions (
        id, title, status, session_kind, agent_instance_id, current_model_id, message_history_json,
        selected_prompt_ids_json, selected_memory_ids_json, pinned_memory_ids_json, working_memory_ids_json,
        provider_usage_stats_json, origin_session_id, trigger_reason, created_at, updated_at,
        started_at, completed_at, failed_at, archived_at
      ) VALUES (
        @id, @title, @status, @session_kind, @agent_instance_id, @current_model_id, @message_history_json,
        @selected_prompt_ids_json, @selected_memory_ids_json, @pinned_memory_ids_json, @working_memory_ids_json,
        @provider_usage_stats_json, @origin_session_id, @trigger_reason, @created_at, @updated_at,
        @started_at, @completed_at, @failed_at, @archived_at
      )
    `).run({
      id: 'session-1',
      title: 'Legacy session',
      status: 'active',
      session_kind: 'user',
      agent_instance_id: null,
      current_model_id: 'gpt-4.1-mini',
      message_history_json: '[]',
      selected_prompt_ids_json: '[]',
      selected_memory_ids_json: JSON.stringify([
        'memory-imported',
        'memory-turn',
        'memory-summary-older',
        'memory-workflow',
        'memory-step',
        'memory-summary-latest',
      ]),
      pinned_memory_ids_json: JSON.stringify([
        'memory-imported',
        'memory-turn',
        'memory-summary-older',
        'memory-workflow',
        'memory-step',
        'memory-summary-latest',
      ]),
      working_memory_ids_json: '[]',
      provider_usage_stats_json: '{}',
      origin_session_id: null,
      trigger_reason: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: null,
      failed_at: null,
      archived_at: null,
    });

    const insertMemory = database.connection.prepare(`
      INSERT INTO memory_records (
        id, type, memory_kind, title, content, scope, status, tags_json, parent_id,
        derivation_type, summary_depth, weight, last_accessed_at, source_session_id, created_at, updated_at
      ) VALUES (
        @id, @type, @memory_kind, @title, @content, @scope, @status, @tags_json, @parent_id,
        @derivation_type, @summary_depth, @weight, @last_accessed_at, @source_session_id, @created_at, @updated_at
      )
    `);
    for (const row of [
      {
        id: 'memory-imported',
        type: 'short-term',
        memory_kind: 'turn',
        title: 'Imported memory',
        content: 'Imported from another session.',
        scope: 'session',
        status: 'active',
        tags_json: JSON.stringify(['conversation-turn', 'auto-captured']),
        parent_id: null,
        derivation_type: 'manual',
        summary_depth: 0,
        weight: 0.8,
        last_accessed_at: now,
        source_session_id: 'session-source',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'memory-turn',
        type: 'short-term',
        memory_kind: 'turn',
        title: 'Turn 1',
        content: 'User: inspect\n\nAssistant: done',
        scope: 'session',
        status: 'active',
        tags_json: JSON.stringify(['conversation-turn', 'auto-captured']),
        parent_id: null,
        derivation_type: 'summary',
        summary_depth: 1,
        weight: 0.8,
        last_accessed_at: now,
        source_session_id: 'session-1',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'memory-workflow',
        type: 'short-term',
        memory_kind: 'workflow',
        title: 'Workflow todo',
        content: 'workflowId: wf-1',
        scope: 'session',
        status: 'active',
        tags_json: JSON.stringify(['workflow', 'todo']),
        parent_id: null,
        derivation_type: 'manual',
        summary_depth: 0,
        weight: 1,
        last_accessed_at: now,
        source_session_id: 'session-1',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'memory-step',
        type: 'short-term',
        memory_kind: 'summary',
        title: 'Step 1 Summary: Turn 1',
        content: 'Step 1\n- tool-result: ok',
        scope: 'session',
        status: 'active',
        tags_json: JSON.stringify(['task-step-summary', 'auto-captured']),
        parent_id: 'memory-turn',
        derivation_type: 'summary',
        summary_depth: 1,
        weight: 0,
        last_accessed_at: now,
        source_session_id: 'session-1',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'memory-summary-older',
        type: 'short-term',
        memory_kind: 'summary',
        title: 'Summary: Turn 1',
        content: 'Older summary',
        scope: 'session',
        status: 'active',
        tags_json: JSON.stringify(['pepe-summary', 'semantic-summary']),
        parent_id: 'memory-turn',
        derivation_type: 'summary',
        summary_depth: 1,
        weight: 0.65,
        last_accessed_at: '2026-05-30T00:00:00.000Z',
        source_session_id: 'session-1',
        created_at: '2026-05-30T00:00:00.000Z',
        updated_at: '2026-05-30T00:00:00.000Z',
      },
      {
        id: 'memory-summary-latest',
        type: 'short-term',
        memory_kind: 'summary',
        title: 'Summary: Turn 1',
        content: 'Latest summary',
        scope: 'session',
        status: 'active',
        tags_json: JSON.stringify(['pepe-summary', 'semantic-summary']),
        parent_id: 'memory-turn',
        derivation_type: 'summary',
        summary_depth: 1,
        weight: 0.65,
        last_accessed_at: now,
        source_session_id: 'session-1',
        created_at: now,
        updated_at: now,
      },
    ]) {
      insertMemory.run(row);
    }

    runMigrations(database.connection);

    const sessionRepository = new SessionRepository({ connection: database.connection });
    const memoryRepository = new MemoryRepository({ connection: database.connection });
    const migratedSession = sessionRepository.getById('session-1');
    const migratedTurn = memoryRepository.getById('memory-turn');
    const migratedStep = memoryRepository.getById('memory-step');
    const olderSummary = memoryRepository.getById('memory-summary-older');
    const latestSummary = memoryRepository.getById('memory-summary-latest');

    expect(migratedSession?.pinnedMemoryIds).toEqual(['memory-imported']);
    expect(migratedSession?.workingMemoryIds).toEqual([
      'memory-turn',
      'memory-workflow',
      'memory-summary-latest',
    ]);
    expect(migratedSession?.selectedMemoryIds).toEqual([
      'memory-imported',
      'memory-turn',
      'memory-workflow',
      'memory-summary-latest',
    ]);
    expect(migratedTurn?.derivationType).toBe('manual');
    expect(migratedTurn?.summaryDepth).toBe(0);
    expect(migratedStep?.status).toBe('expired');
    expect(olderSummary?.status).toBe('expired');
    expect(latestSummary?.status).toBe('active');

    database.close();
  });

  it('adds content_hash to legacy memory_records tables and persists hashed memories after migration', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-memory-content-hash-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });

    database.connection.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        memory_kind TEXT NOT NULL DEFAULT 'generic',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        parent_id TEXT,
        derivation_type TEXT NOT NULL DEFAULT 'manual',
        summary_depth INTEGER NOT NULL DEFAULT 0,
        weight REAL NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const insertMigration = database.connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
    const appliedAt = new Date().toISOString();
    for (const id of [
      '001_initial_foundation',
      '002_provider_desktop_updates',
      '003_context_memory_metadata',
      '004_agent_instances',
      '005_session_context_backfill',
      '006_agent_instance_defaults',
      '007_workflow_instances',
      '008_session_provider_usage_stats',
      '009_memory_weight_policy',
      '010_session_memory_selection_layers',
      '011_memory_selection_cleanup',
      '012_step_memory_retirement',
    ]) {
      insertMigration.run(id, appliedAt);
    }

    runMigrations(database.connection);

    const columns = database.connection
      .prepare("PRAGMA table_info('memory_records')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('content_hash');

    const memoryRepository = new MemoryRepository({ connection: database.connection });
    database.connection.prepare(`
      INSERT INTO memory_records (
        id, type, memory_kind, title, content, scope, status, tags_json, parent_id,
        derivation_type, summary_depth, weight, last_accessed_at, source_session_id, content_hash, created_at, updated_at
      ) VALUES (
        @id, @type, @memory_kind, @title, @content, @scope, @status, @tags_json, @parent_id,
        @derivation_type, @summary_depth, @weight, @last_accessed_at, @source_session_id, @content_hash, @created_at, @updated_at
      )
    `).run({
      id: 'legacy-memory-null-hash',
      type: 'short-term',
      memory_kind: 'generic',
      title: 'Legacy memory',
      content: 'Legacy rows may have null content hash.',
      scope: 'session',
      status: 'active',
      tags_json: '[]',
      parent_id: null,
      derivation_type: 'manual',
      summary_depth: 0,
      weight: 0,
      last_accessed_at: appliedAt,
      source_session_id: null,
      content_hash: null,
      created_at: appliedAt,
      updated_at: appliedAt,
    });

    const legacy = memoryRepository.getById('legacy-memory-null-hash');
    expect(legacy?.contentHash).toBeUndefined();

    const created = memoryRepository.create('Hashed memory', 'Persist this content hash.', 'session');
    const persisted = memoryRepository.getById(created.id);

    expect(persisted?.contentHash).toBe(created.contentHash);

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

  it('appends additional session messages in sqlite without losing earlier history', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-message-append-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const repository = new SessionRepository({ connection: database.connection });
    const service = new SessionService(repository);

    const created = service.createSession('Append session');
    service.addUserMessage(created.id, 'Question 1');
    service.addAssistantMessage(created.id, 'Answer 1');
    service.addToolMessage(created.id, 'read_file', 'Loaded context', 'task-1');
    service.addUserMessage(created.id, 'Question 2');

    const restoredService = new SessionService(new SessionRepository({ connection: database.connection }));
    const restored = restoredService.getSession(created.id);

    expect(restored?.messageHistory.map((message) => ({
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      taskId: message.taskId,
    }))).toEqual([
      { role: 'user', content: 'Question 1', toolName: null, taskId: null },
      { role: 'assistant', content: 'Answer 1', toolName: null, taskId: null },
      { role: 'tool', content: 'Loaded context', toolName: 'read_file', taskId: 'task-1' },
      { role: 'user', content: 'Question 2', toolName: null, taskId: null },
    ]);

    database.close();
  });

  it('lists session summaries from sqlite without hydrating full message history', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-summaries-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const repository = new SessionRepository({ connection: database.connection });
    const service = new SessionService(repository);

    const created = service.createSession('Summary session', null, 'agent-1');
    service.addUserMessage(created.id, 'Inspect the workflow');
    service.addAssistantMessage(created.id, 'Workflow inspection complete');
    service.addPinnedMemory(created.id, 'memory-1');
    service.addWorkingMemory(created.id, 'memory-2');

    const restoredService = new SessionService(new SessionRepository({ connection: database.connection }));
    const summaries = restoredService.listSessionSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: created.id,
      agentInstanceId: 'agent-1',
      messageCount: 2,
      selectedMemoryCount: 2,
      preview: 'Pueblo: Workflow inspection complete',
    });

    database.close();
  });

  it('persists aggregated provider usage stats in sqlite', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-session-provider-usage-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const repository = new SessionRepository({ connection: database.connection });
    const service = new SessionService(repository);

    const created = service.createSession('Usage session');
    service.addProviderUsage(created.id, {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      promptCacheHitTokens: 6,
      promptCacheMissTokens: 4,
      promptTokensDetails: {
        cachedTokens: 6,
      },
      completionTokensDetails: {
        reasoningTokens: 4,
      },
    });
    service.addProviderUsage(created.id, {
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      promptCacheHitTokens: 1,
      promptCacheMissTokens: 4,
      promptTokensDetails: {
        cachedTokens: 1,
      },
      completionTokensDetails: {
        reasoningTokens: 2,
      },
    });

    const restoredService = new SessionService(new SessionRepository({ connection: database.connection }));
    const restored = restoredService.getSession(created.id);

    expect(restored?.providerUsageStats).toEqual({
      promptTokens: 15,
      completionTokens: 6,
      totalTokens: 21,
      promptCacheHitTokens: 7,
      promptCacheMissTokens: 8,
      cachedPromptTokens: 7,
      reasoningTokens: 6,
      promptTokensSent: 15,
      cacheHitRatio: 0.4667,
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
      pepe: { enabled: false },
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
      expect((await cli.getRuntimeStatus()).activeSessionId).toBeTruthy();
    } finally {
      cli.databaseClose();
    }
  });

  it('reuses the same default agent instance across repeated profile selection and /new', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-solo-'));
    tempDirs.push(tempDir);
    const cli = createCliDependencies(createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      pepe: { enabled: false },
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    }), {
      deferAgentSelection: true,
    });

    try {
      const firstRuntime = await cli.startAgentSession('code-master');
      const firstSessionId = firstRuntime.activeSessionId;
      const firstInstanceId = firstRuntime.agentInstanceId;

      const secondRuntime = await cli.startAgentSession('code-master');

      expect(secondRuntime.agentInstanceId).toBe(firstInstanceId);
      expect(secondRuntime.activeSessionId).toBe(firstSessionId);

      const newSessionResult = await cli.dispatcher.dispatch({ input: '/new follow-up session' });
      const newSessionRuntime = await cli.getRuntimeStatus();

      expect(newSessionResult.ok).toBe(true);
      expect(newSessionRuntime.agentInstanceId).toBe(firstInstanceId);
      expect(newSessionRuntime.activeSessionId).not.toBe(secondRuntime.activeSessionId);
    } finally {
      cli.databaseClose();
    }
  });

  it('restores the most recent session when the same profile is selected again', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-session-restore-'));
    tempDirs.push(tempDir);
    const cli = createCliDependencies(createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      pepe: { enabled: false },
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    }), {
      deferAgentSelection: true,
    });

    try {
      const firstRuntime = await cli.startAgentSession('code-master');
      const firstSessionId = firstRuntime.activeSessionId;
      const firstInstanceId = firstRuntime.agentInstanceId;

      const newSessionResult = await cli.dispatcher.dispatch({ input: '/new isolate next task' });
      expect(newSessionResult.ok).toBe(true);
      const secondSessionId = (await cli.getRuntimeStatus()).activeSessionId;

      const restoredRuntime = await cli.startAgentSession('code-master');

      expect(restoredRuntime.agentInstanceId).toBe(firstInstanceId);
      expect(restoredRuntime.activeSessionId).toBe(secondSessionId);
      expect(restoredRuntime.activeSessionId).not.toBe(firstSessionId);
    } finally {
      cli.databaseClose();
    }
  });

  it('stops the previous Pepe monitor when the active session changes', async () => {
    vi.useFakeTimers();

    const processCounts = new Map<string, number>();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-pepe-session-switch-'));
    tempDirs.push(tempDir);
    const cli = createCliDependencies(createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      pepe: {
        enabled: true,
        embeddingBackend: 'local-hash',
        flushIntervalMs: 2_000,
      },
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    }), {
      deferAgentSelection: true,
      pepeWorkerFactory: () => createCountingPepeWorker(processCounts),
    });

    try {
      const firstRuntime = await cli.startAgentSession('code-master');
      const firstSessionId = firstRuntime.activeSessionId;

      expect(firstSessionId).toBeTruthy();
      expect(processCounts.get(firstSessionId!)).toBe(1);

      const newSessionResult = await cli.dispatcher.dispatch({ input: '/new isolate next task' });
      expect(newSessionResult.ok).toBe(true);

      const secondSessionId = (await cli.getRuntimeStatus()).activeSessionId;
      expect(secondSessionId).toBeTruthy();
      expect(secondSessionId).not.toBe(firstSessionId);

      const firstCountAfterSwitch = processCounts.get(firstSessionId!) ?? 0;
      const secondCountAfterSwitch = processCounts.get(secondSessionId!) ?? 0;

      await vi.advanceTimersByTimeAsync(6_000);

      expect(processCounts.get(firstSessionId!) ?? 0).toBe(firstCountAfterSwitch);
      expect(processCounts.get(secondSessionId!) ?? 0).toBeGreaterThan(secondCountAfterSwitch);
    } finally {
      cli.databaseClose();
      vi.useRealTimers();
    }
  });
});

function createCountingPepeWorker(processCounts: Map<string, number>) {
  let messageHandler: ((message: PepeWorkerResponse) => void) | null = null;

  return {
    postMessage(message: PepeWorkerRequest) {
      if (message.type === 'shutdown') {
        return;
      }

      processCounts.set(message.snapshot.sessionId, (processCounts.get(message.snapshot.sessionId) ?? 0) + 1);
      messageHandler?.({
        type: 'process-result',
        requestId: message.requestId,
        result: {
          sessionId: message.snapshot.sessionId,
          summaries: [],
          resultCandidates: [],
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
      });
    },
    on(event: 'message' | 'error', listener: ((message: PepeWorkerResponse) => void) | ((error: Error) => void)) {
      if (event === 'message') {
        messageHandler = listener as (message: PepeWorkerResponse) => void;
      }

      return this;
    },
    async terminate() {
      return 0;
    },
  };
}
