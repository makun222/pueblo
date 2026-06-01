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
        session_kind TEXT NOT NULL DEFAULT 'user',
        agent_instance_id TEXT,
        current_model_id TEXT,
        message_history_json TEXT NOT NULL,
        selected_prompt_ids_json TEXT NOT NULL,
        selected_memory_ids_json TEXT NOT NULL,
        provider_usage_stats_json TEXT NOT NULL DEFAULT '{}',
        origin_session_id TEXT,
        trigger_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
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
        parent_id TEXT,
        derivation_type TEXT NOT NULL DEFAULT 'manual',
        summary_depth INTEGER NOT NULL DEFAULT 0,
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
      'CREATE INDEX IF NOT EXISTS idx_sessions_agent_instance_id ON sessions(agent_instance_id)',
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
  {
    id: '003_context_memory_metadata',
    statements: [
      `
      ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'user'
      `,
      `
      ALTER TABLE sessions ADD COLUMN agent_instance_id TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN origin_session_id TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN trigger_reason TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN started_at TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN completed_at TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN failed_at TEXT
      `,
      `
      ALTER TABLE memory_records ADD COLUMN parent_id TEXT
      `,
      `
      ALTER TABLE memory_records ADD COLUMN derivation_type TEXT NOT NULL DEFAULT 'manual'
      `,
      `
      ALTER TABLE memory_records ADD COLUMN summary_depth INTEGER NOT NULL DEFAULT 0
      `,
      'CREATE INDEX IF NOT EXISTS idx_sessions_kind_updated_at ON sessions(session_kind, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_memory_parent_updated_at ON memory_records(parent_id, updated_at DESC)',
    ],
  },
  {
    id: '004_agent_instances',
    statements: [
      `
      CREATE TABLE IF NOT EXISTS agent_instances (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminated_at TEXT
      )
      `,
      'CREATE INDEX IF NOT EXISTS idx_agent_instances_profile_status ON agent_instances(profile_id, status)',
    ],
  },
  {
    id: '005_session_context_backfill',
    statements: [
      `
      ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'user'
      `,
      `
      ALTER TABLE sessions ADD COLUMN agent_instance_id TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN origin_session_id TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN trigger_reason TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN started_at TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN completed_at TEXT
      `,
      `
      ALTER TABLE sessions ADD COLUMN failed_at TEXT
      `,
      `
      ALTER TABLE memory_records ADD COLUMN parent_id TEXT
      `,
      `
      ALTER TABLE memory_records ADD COLUMN derivation_type TEXT NOT NULL DEFAULT 'manual'
      `,
      `
      ALTER TABLE memory_records ADD COLUMN summary_depth INTEGER NOT NULL DEFAULT 0
      `,
      'CREATE INDEX IF NOT EXISTS idx_sessions_agent_instance_id ON sessions(agent_instance_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_kind_updated_at ON sessions(session_kind, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_memory_parent_updated_at ON memory_records(parent_id, updated_at DESC)',
    ],
  },
  {
    id: '006_agent_instance_defaults',
    statements: [
      `
      ALTER TABLE agent_instances ADD COLUMN is_default_for_profile INTEGER NOT NULL DEFAULT 0
      `,
      `
      UPDATE agent_instances
         SET is_default_for_profile = 0
      `,
      `
      UPDATE agent_instances
         SET is_default_for_profile = 1
       WHERE id IN (
         SELECT current.id
           FROM agent_instances AS current
          WHERE current.status != 'terminated'
            AND NOT EXISTS (
              SELECT 1
                FROM agent_instances AS newer
               WHERE newer.profile_id = current.profile_id
                 AND newer.status != 'terminated'
                 AND (
                   newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at AND newer.created_at > current.created_at)
                   OR (newer.updated_at = current.updated_at AND newer.created_at = current.created_at AND newer.id > current.id)
                 )
            )
       )
      `,
      'CREATE INDEX IF NOT EXISTS idx_agent_instances_profile_default ON agent_instances(profile_id, is_default_for_profile)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_instances_unique_default ON agent_instances(profile_id) WHERE is_default_for_profile = 1',
    ],
  },
  {
    id: '007_workflow_instances',
    statements: [
      `
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        agent_instance_id TEXT,
        goal TEXT NOT NULL,
        target_directory TEXT,
        runtime_plan_path TEXT NOT NULL,
        deliverable_plan_path TEXT,
        active_plan_memory_id TEXT,
        active_todo_memory_id TEXT,
        active_round_number INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        failed_at TEXT,
        cancelled_at TEXT
      )
      `,
      'CREATE INDEX IF NOT EXISTS idx_workflow_instances_session_status ON workflow_instances(session_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_instances_type_status ON workflow_instances(type, status)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_instances_agent_updated_at ON workflow_instances(agent_instance_id, updated_at DESC)',
    ],
  },
  {
    id: '008_session_provider_usage_stats',
    statements: [
      `
      ALTER TABLE sessions ADD COLUMN provider_usage_stats_json TEXT NOT NULL DEFAULT '{}'
      `,
    ],
  },
  {
    id: '009_memory_weight_policy',
    statements: [
      `
      ALTER TABLE memory_records ADD COLUMN memory_kind TEXT NOT NULL DEFAULT 'generic'
      `,
      `
      ALTER TABLE memory_records ADD COLUMN weight REAL NOT NULL DEFAULT 0
      `,
      `
      ALTER TABLE memory_records ADD COLUMN last_accessed_at TEXT
      `,
      `
      UPDATE memory_records
         SET memory_kind = CASE
           WHEN instr(tags_json, 'workflow') > 0 OR instr(tags_json, 'plan') > 0 OR instr(tags_json, 'todo') > 0 THEN 'workflow'
           WHEN instr(tags_json, 'workspace-setting') > 0 THEN 'workspace-setting'
           WHEN instr(tags_json, 'conversation-turn') > 0 AND parent_id IS NULL THEN 'turn'
           WHEN derivation_type = 'summary' OR summary_depth > 0 THEN 'summary'
           ELSE 'generic'
         END
      `,
      `
      UPDATE memory_records
         SET weight = CASE
           WHEN memory_kind = 'turn' THEN 0.8
           WHEN memory_kind = 'summary' THEN 0.65
           WHEN memory_kind = 'workflow' THEN 1.0
           ELSE 0
         END
      `,
      `
      UPDATE memory_records
         SET last_accessed_at = COALESCE(last_accessed_at, updated_at)
      `,
      'CREATE INDEX IF NOT EXISTS idx_memory_kind_status_updated_at ON memory_records(memory_kind, status, updated_at DESC)',
    ],
  },
  {
    id: '010_session_memory_selection_layers',
    statements: [
      `
      ALTER TABLE sessions ADD COLUMN pinned_memory_ids_json TEXT NOT NULL DEFAULT '[]'
      `,
      `
      ALTER TABLE sessions ADD COLUMN working_memory_ids_json TEXT NOT NULL DEFAULT '[]'
      `,
      `
      UPDATE sessions
         SET pinned_memory_ids_json = COALESCE(pinned_memory_ids_json, selected_memory_ids_json, '[]')
      `,
      `
      UPDATE sessions
         SET working_memory_ids_json = COALESCE(working_memory_ids_json, '[]')
      `,
    ],
  },
  {
    id: '011_memory_selection_cleanup',
    statements: [
      `
      UPDATE memory_records AS duplicate
         SET status = 'expired'
       WHERE duplicate.status = 'active'
         AND duplicate.parent_id IS NOT NULL
         AND instr(duplicate.tags_json, 'pepe-summary') > 0
         AND EXISTS (
           SELECT 1
             FROM memory_records AS newer
            WHERE newer.parent_id = duplicate.parent_id
              AND newer.status = 'active'
              AND instr(newer.tags_json, 'pepe-summary') > 0
              AND newer.id != duplicate.id
              AND (
                newer.updated_at > duplicate.updated_at
                OR (newer.updated_at = duplicate.updated_at AND newer.created_at > duplicate.created_at)
                OR (newer.updated_at = duplicate.updated_at AND newer.created_at = duplicate.created_at AND newer.id > duplicate.id)
              )
         )
      `,
      `
      UPDATE sessions AS session
         SET working_memory_ids_json = COALESCE((
           SELECT json_group_array(memory_id)
             FROM (
               SELECT selection.value AS memory_id
                 FROM json_each(session.selected_memory_ids_json) AS selection
                 JOIN memory_records AS memory ON memory.id = selection.value
                WHERE memory.status = 'active'
                  AND memory.source_session_id = session.id
                  AND (
                    instr(memory.tags_json, 'auto-captured') > 0
                    OR instr(memory.tags_json, 'workflow') > 0
                    OR instr(memory.tags_json, 'pepe-summary') > 0
                    OR instr(memory.tags_json, 'task-step-summary') > 0
                    OR instr(memory.tags_json, 'conversation-turn') > 0
                  )
                  AND NOT (
                    instr(memory.tags_json, 'pepe-summary') > 0
                    AND instr(memory.tags_json, 'pepe-session-summary') = 0
                    AND EXISTS (
                      SELECT 1
                        FROM json_each(session.selected_memory_ids_json) AS selected_summary
                        JOIN memory_records AS summary_memory ON summary_memory.id = selected_summary.value
                       WHERE summary_memory.status = 'active'
                         AND instr(summary_memory.tags_json, 'pepe-session-summary') > 0
                    )
                  )
                GROUP BY selection.value, selection.key
                ORDER BY CAST(selection.key AS INTEGER)
             )
         ), '[]')
      `,
      `
      UPDATE sessions AS session
         SET pinned_memory_ids_json = COALESCE((
           SELECT json_group_array(memory_id)
             FROM (
               SELECT selection.value AS memory_id
                 FROM json_each(session.selected_memory_ids_json) AS selection
                 JOIN memory_records AS memory ON memory.id = selection.value
                WHERE memory.status = 'active'
                  AND NOT (
                    memory.source_session_id = session.id
                    AND (
                      instr(memory.tags_json, 'auto-captured') > 0
                      OR instr(memory.tags_json, 'workflow') > 0
                      OR instr(memory.tags_json, 'pepe-summary') > 0
                      OR instr(memory.tags_json, 'task-step-summary') > 0
                      OR instr(memory.tags_json, 'conversation-turn') > 0
                    )
                    AND NOT (
                      instr(memory.tags_json, 'pepe-summary') > 0
                      AND instr(memory.tags_json, 'pepe-session-summary') = 0
                      AND EXISTS (
                        SELECT 1
                          FROM json_each(session.selected_memory_ids_json) AS selected_summary
                          JOIN memory_records AS summary_memory ON summary_memory.id = selected_summary.value
                         WHERE summary_memory.status = 'active'
                           AND instr(summary_memory.tags_json, 'pepe-session-summary') > 0
                      )
                    )
                  )
                GROUP BY selection.value, selection.key
                ORDER BY CAST(selection.key AS INTEGER)
             )
         ), '[]')
      `,
      `
      UPDATE sessions AS session
         SET selected_memory_ids_json = COALESCE((
           SELECT json_group_array(memory_id)
             FROM (
               SELECT memory_id
                 FROM (
                   SELECT value AS memory_id, MIN(ord) AS first_ord
                     FROM (
                       SELECT value, CAST(key AS INTEGER) AS ord
                         FROM json_each(session.pinned_memory_ids_json)
                       UNION ALL
                       SELECT value, 1000000 + CAST(key AS INTEGER) AS ord
                         FROM json_each(session.working_memory_ids_json)
                     )
                    GROUP BY value
                    ORDER BY first_ord
                 )
             )
         ), '[]')
      `,
    ],
  },
  {
    id: '012_step_memory_retirement',
    statements: [
      `
      UPDATE memory_records
         SET derivation_type = 'manual',
             summary_depth = 0
       WHERE status = 'active'
         AND parent_id IS NULL
         AND instr(tags_json, 'conversation-turn') > 0
         AND (derivation_type = 'summary' OR summary_depth > 0)
      `,
      `
      UPDATE memory_records
         SET status = 'expired'
       WHERE status = 'active'
         AND instr(tags_json, 'task-step-summary') > 0
      `,
      `
      UPDATE sessions AS session
         SET pinned_memory_ids_json = COALESCE((
           SELECT json_group_array(memory_id)
             FROM (
               SELECT selection.value AS memory_id
                 FROM json_each(session.pinned_memory_ids_json) AS selection
                 JOIN memory_records AS memory ON memory.id = selection.value
                WHERE memory.status = 'active'
                  AND instr(memory.tags_json, 'task-step-summary') = 0
                GROUP BY selection.value, selection.key
                ORDER BY CAST(selection.key AS INTEGER)
             )
         ), '[]')
      `,
      `
      UPDATE sessions AS session
         SET working_memory_ids_json = COALESCE((
           SELECT json_group_array(memory_id)
             FROM (
               SELECT selection.value AS memory_id
                 FROM json_each(session.working_memory_ids_json) AS selection
                 JOIN memory_records AS memory ON memory.id = selection.value
                WHERE memory.status = 'active'
                  AND instr(memory.tags_json, 'task-step-summary') = 0
                GROUP BY selection.value, selection.key
                ORDER BY CAST(selection.key AS INTEGER)
             )
         ), '[]')
      `,
      `
      UPDATE sessions AS session
         SET selected_memory_ids_json = COALESCE((
           SELECT json_group_array(memory_id)
             FROM (
               SELECT memory_id
                 FROM (
                   SELECT value AS memory_id, MIN(ord) AS first_ord
                     FROM (
                       SELECT value, CAST(key AS INTEGER) AS ord
                         FROM json_each(session.pinned_memory_ids_json)
                       UNION ALL
                       SELECT value, 1000000 + CAST(key AS INTEGER) AS ord
                         FROM json_each(session.working_memory_ids_json)
                     )
                    GROUP BY value
                    ORDER BY first_ord
                 )
             )
         ), '[]')
      `,
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
