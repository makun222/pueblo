"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const task_context_1 = require("../../src/agent/task-context");
const dispatcher_1 = require("../../src/commands/dispatcher");
const health_check_1 = require("../../src/persistence/health-check");
const sqlite_1 = require("../../src/persistence/sqlite");
const config_1 = require("../../src/shared/config");
const tempDirs = [];
(0, vitest_1.afterEach)(() => {
    while (tempDirs.length > 0) {
        const tempDir = tempDirs.pop();
        if (tempDir && node_fs_1.default.existsSync(tempDir)) {
            node_fs_1.default.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});
(0, vitest_1.describe)('foundation', () => {
    (0, vitest_1.it)('loads default config when config file is absent', () => {
        const tempDir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'pueblo-config-'));
        tempDirs.push(tempDir);
        const config = (0, config_1.loadAppConfig)({ cwd: tempDir });
        (0, vitest_1.expect)(config.providers).toEqual([]);
        (0, vitest_1.expect)(config.databasePath).toContain(node_path_1.default.join('.pueblo', 'pueblo.db'));
    });
    (0, vitest_1.it)('bootstraps sqlite and applies foundational migrations', () => {
        const tempDir = node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), 'pueblo-db-'));
        tempDirs.push(tempDir);
        const dbPath = node_path_1.default.join(tempDir, 'pueblo.db');
        const database = (0, sqlite_1.createSqliteDatabase)({ dbPath });
        try {
            const status = (0, health_check_1.verifyPersistence)(database, dbPath);
            const tables = database.connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .all();
            (0, vitest_1.expect)(status.ok).toBe(true);
            (0, vitest_1.expect)(tables.map((table) => table.name)).toContain('sessions');
            (0, vitest_1.expect)(tables.map((table) => table.name)).toContain('schema_migrations');
        }
        finally {
            database.close();
        }
    });
    (0, vitest_1.it)('dispatches registered core commands', async () => {
        const dispatcher = new dispatcher_1.CommandDispatcher();
        (0, dispatcher_1.registerCoreCommands)(dispatcher);
        const result = await dispatcher.dispatch({ input: '/ping' });
        (0, vitest_1.expect)(result.ok).toBe(true);
        (0, vitest_1.expect)(result.code).toBe('PING_OK');
    });
    (0, vitest_1.it)('creates a task context from config defaults', () => {
        const context = (0, task_context_1.createTaskContext)({
            config: {
                databasePath: '/tmp/pueblo.db',
                defaultProviderId: 'provider-a',
                defaultSessionId: null,
                providers: [],
            },
        });
        (0, vitest_1.expect)(context.sessionId).toBeNull();
        (0, vitest_1.expect)(context.selectedModelId).toBeNull();
        (0, vitest_1.expect)(context.selectedPromptIds).toEqual([]);
        (0, vitest_1.expect)(context.selectedMemoryIds).toEqual([]);
    });
});
