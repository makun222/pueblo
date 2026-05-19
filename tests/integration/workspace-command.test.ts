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

describeIfNodeSqlite('workspace command integration', () => {
  it('persists the latest workspace selection in global memory and restores it on restart', async () => {
    previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workspace-command-'));
    tempDirs.push(tempDir);
    const workspaceA = path.join(tempDir, 'workspace-a');
    const workspaceB = path.join(tempDir, 'workspace-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
    fs.writeFileSync(path.join(workspaceA, 'package.json'), '{"name":"workspace-a"}');
    fs.writeFileSync(path.join(workspaceB, 'package.json'), '{"name":"workspace-b"}');
    process.chdir(workspaceA);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      desktopWindow: { enabled: false },
    });

    const firstCli = createCliDependencies(config, { deferAgentSelection: true });

    try {
      expect(firstCli.getRuntimeStatus().workspace).toBe(workspaceA);

      const result = await firstCli.submitInput(`/set workspace ${workspaceB}`);
      expect(result.ok).toBe(true);
      expect(firstCli.getRuntimeStatus().workspace).toBe(workspaceB);
    } finally {
      firstCli.databaseClose();
    }

    process.chdir(workspaceA);
    const secondCli = createCliDependencies(config, { deferAgentSelection: true });

    try {
      expect(secondCli.getRuntimeStatus().workspace).toBe(workspaceB);
    } finally {
      secondCli.databaseClose();
    }
  });
});