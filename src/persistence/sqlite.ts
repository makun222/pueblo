import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface SqliteOptions {
  readonly dbPath: string;
  readonly readonly?: boolean;
}

export interface SqliteDatabase {
  readonly connection: Database.Database;
  close(): void;
}

function ensureParentDirectory(dbPath: string): void {
  const parentDir = path.dirname(dbPath);

  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

export function createSqliteDatabase(options: SqliteOptions): SqliteDatabase {
  if (!options.dbPath) {
    throw new Error('SQLite database path is required');
  }

  if (options.readonly && !fs.existsSync(options.dbPath)) {
    throw new Error(`SQLite database does not exist: ${options.dbPath}`);
  }

  ensureParentDirectory(options.dbPath);

  const connection = new Database(options.dbPath, {
    fileMustExist: options.readonly ?? false,
    readonly: options.readonly ?? false,
  });

  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 3000');

  return {
    connection,
    close(): void {
      connection.close();
    },
  };
}
