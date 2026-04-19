export const nodeSqliteAvailable = detectNodeSqliteAvailability();

function detectNodeSqliteAvailability(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (path: string) => { close: () => void };
    const database = new Database(':memory:');
    database.close();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('NODE_MODULE_VERSION')) {
      return false;
    }

    throw error;
  }
}