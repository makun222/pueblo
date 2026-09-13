import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];
let previousCwd = process.cwd();

afterEach(() => {
  process.chdir(previousCwd);

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

function createWorkspaceFixtures() {
  previousCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workspace-command-'));
  tempDirs.push(tempDir);
  const workspaceA = path.join(tempDir, 'workspace-a');
  const workspaceB = path.join(tempDir, 'workspace-b');
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  fs.writeFileSync(path.join(workspaceA, 'package.json'), '{"name":"workspace-a"}');
  fs.writeFileSync(path.join(workspaceB, 'package.json'), '{"name":"workspace-b"}');

  const config = createTestAppConfig({
    databasePath: path.join(tempDir, 'pueblo.db'),
    desktopWindow: { enabled: false },
  });

  return { workspaceA, workspaceB, config };
}

describeIfNodeSqlite('workspace command integration', () => {
  it('persists a tab workspace on its agent instance and restores it on restart', async () => {
    const { workspaceA, workspaceB, config } = createWorkspaceFixtures();
    process.chdir(workspaceA);

    const firstCli = createCliDependencies(config, { deferAgentSelection: true, initialWorkspace: workspaceA });

    try {
      await firstCli.startAgentSession('code-master');
      expect((await firstCli.getRuntimeStatus()).workspace).toBe(workspaceA);

      const result = await firstCli.submitInput(`/set workspace ${workspaceB}`);
      expect(result.ok).toBe(true);
      expect((await firstCli.getRuntimeStatus()).workspace).toBe(workspaceB);
    } finally {
      firstCli.databaseClose();
    }

    // 重启：新页签 runtime 不应继承全局 memory workspace，而应读取 agent 自有的持久化 workspace。
    process.chdir(workspaceA);
    const restartedCli = createCliDependencies(config, { deferAgentSelection: true });

    try {
      await restartedCli.startAgentSession('code-master');
      expect((await restartedCli.getRuntimeStatus()).workspace).toBe(workspaceB);
    } finally {
      restartedCli.databaseClose();
    }
  });

  it('keeps restoring the global memory workspace for a plain single-session CLI', async () => {
    const { workspaceA, workspaceB, config } = createWorkspaceFixtures();
    process.chdir(workspaceA);

    const firstCli = createCliDependencies(config);

    try {
      await firstCli.setWorkspaceRoot(workspaceB);
    } finally {
      firstCli.databaseClose();
    }

    process.chdir(workspaceA);
    const restartedCli = createCliDependencies(config);

    try {
      expect((await restartedCli.getRuntimeStatus()).workspace).toBe(workspaceB);
    } finally {
      restartedCli.databaseClose();
    }
  });
});