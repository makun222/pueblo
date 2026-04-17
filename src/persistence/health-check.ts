import { runMigrations } from './migrate';
import type { SqliteDatabase } from './sqlite';
import type { AppConfig } from '../shared/config';

export interface PersistenceHealthStatus {
  readonly ok: boolean;
  readonly databasePath: string;
  readonly appliedMigrations: string[];
}

export interface StartupHealthStatus extends PersistenceHealthStatus {
  readonly desktopShellReady: boolean;
  readonly githubCopilotReady: boolean;
}

export function verifyPersistence(database: SqliteDatabase, databasePath: string): PersistenceHealthStatus {
  const migrationResult = runMigrations(database.connection);
  const integrity = database.connection.pragma('quick_check', { simple: true }) as string;

  if (integrity !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${integrity}`);
  }

  return {
    ok: true,
    databasePath,
    appliedMigrations: migrationResult.appliedMigrations,
  };
}

export function verifyStartupHealth(database: SqliteDatabase, databasePath: string, config: AppConfig): StartupHealthStatus {
  const persistenceStatus = verifyPersistence(database, databasePath);

  const desktopShellReady = config.desktopWindow.enabled;

  const githubCopilotReady = (config.githubCopilot.token?.trim() ?? process.env.GITHUB_COPILOT_TOKEN?.trim() ?? '') !== '';

  return {
    ...persistenceStatus,
    desktopShellReady,
    githubCopilotReady,
  };
}
