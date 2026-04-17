import type Database from 'better-sqlite3';

export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParams = Record<string, SqlValue>;

export interface RepositoryContext {
  readonly connection: Database.Database;
}

export abstract class RepositoryBase {
  protected constructor(protected readonly context: RepositoryContext) {}

  protected prepare<TParams extends unknown[] | SqlParams, TResult>(sql: string): Database.Statement<TParams, TResult> {
    return this.context.connection.prepare<TParams, TResult>(sql);
  }

  protected run(sql: string, params?: unknown[] | SqlParams): Database.RunResult {
    const statement = this.context.connection.prepare(sql);

    if (Array.isArray(params)) {
      return statement.run(...params);
    }

    if (params) {
      return statement.run(params);
    }

    return statement.run();
  }

  protected get<TResult>(sql: string, params?: unknown[] | SqlParams): TResult | undefined {
    const statement = this.context.connection.prepare(sql);

    if (Array.isArray(params)) {
      return statement.get(...params) as TResult | undefined;
    }

    if (params) {
      return statement.get(params) as TResult | undefined;
    }

    return statement.get() as TResult | undefined;
  }

  protected all<TResult>(sql: string, params?: unknown[] | SqlParams): TResult[] {
    const statement = this.context.connection.prepare(sql);

    if (Array.isArray(params)) {
      return statement.all(...params) as TResult[];
    }

    if (params) {
      return statement.all(params) as TResult[];
    }

    return statement.all() as TResult[];
  }

  protected inTransaction<T>(handler: () => T): T {
    return this.context.connection.transaction(handler)();
  }
}

export function toJson<T>(value: T): string {
  return JSON.stringify(value);
}

export function fromJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function buildLikePattern(input: string): string {
  return `%${input.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}
