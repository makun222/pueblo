import type Database from 'better-sqlite3';

const foundationalMigrations = [
  {
    id: '001_initial_foundation',
    statements: [
      `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS command_actions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_status TEXT NOT NULL,
        result_message TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        input_context_summary TEXT NOT NULL,
        output_summary TEXT,
        tool_invocation_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS tool_invocations (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        task_id TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        result_status TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES agent_tasks(id)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        current_model_id TEXT,
        message_history_json TEXT NOT NULL,
        selected_prompt_ids_json TEXT NOT NULL,
        selected_memory_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS prompt_assets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        default_model_id TEXT NOT NULL,
        models_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL
      )
      `,
      'CREATE INDEX IF NOT EXISTS idx_sessions_status_updated_at ON sessions(status, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_current_model_id ON sessions(current_model_id)',
      'CREATE INDEX IF NOT EXISTS idx_memory_scope_status ON memory_records(scope, status)',
      'CREATE INDEX IF NOT EXISTS idx_prompts_status_updated_at ON prompt_assets(status, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_agent_tasks_session_status ON agent_tasks(session_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_task_tool ON tool_invocations(task_id, tool_name)',
      'CREATE INDEX IF NOT EXISTS idx_command_actions_session_created_at ON command_actions(session_id, created_at DESC)',
    ],
  },
  {
    id: '002_provider_desktop_updates',
    statements: [
      `
      ALTER TABLE agent_tasks ADD COLUMN provider_id TEXT
      `,
      `
      ALTER TABLE provider_profiles ADD COLUMN auth_state TEXT NOT NULL DEFAULT 'missing'
      `,
      'CREATE INDEX IF NOT EXISTS idx_agent_tasks_provider_status ON agent_tasks(provider_id, status)',
    ],
  },
];

export interface MigrationResult {
  readonly appliedMigrations: string[];
}

export function runMigrations(connection: Database.Database): MigrationResult {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const selectApplied = connection.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM schema_migrations WHERE id = ?',
  );
  const insertApplied = connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  const appliedMigrations: string[] = [];

  const transaction = connection.transaction(() => {
    for (const migration of foundationalMigrations) {
      const alreadyApplied = selectApplied.get(migration.id);

      if (alreadyApplied) {
        continue;
      }

      for (const statement of migration.statements) {
        try {
          connection.exec(statement);
        } catch (error) {
          if (
            error instanceof Error
            && (
              error.message.includes('duplicate column name')
              || error.message.includes('already exists')
            )
          ) {
            continue;
          }

          throw error;
        }
      }

      insertApplied.run(migration.id, new Date().toISOString());
      appliedMigrations.push(migration.id);
    }
  });

  transaction();

  return { appliedMigrations };
}
