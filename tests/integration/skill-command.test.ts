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

describeIfNodeSqlite('skill command integration', () => {
  it('lists and opens installed skills for the current agent from the Pueblo startup directory', async () => {
    previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-skill-command-'));
    const startupDir = path.join(tempDir, 'pueblo-home');
    const workspaceDir = path.join(tempDir, 'workspace');
    tempDirs.push(tempDir);
    fs.mkdirSync(startupDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"name":"workspace-a"}');
    process.chdir(workspaceDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      desktopWindow: { enabled: false },
      pepe: { enabled: false },
    });

    const cli = createCliDependencies(config, {
      deferAgentSelection: true,
      puebloWorkingDirectory: startupDir,
    });

    try {
      const runtimeStatus = cli.startAgentSession('code-master');
      const agentInstanceId = runtimeStatus.agentInstanceId;
      expect(agentInstanceId).toBeTruthy();

      const skillPath = path.join(
        startupDir,
        `agent-${agentInstanceId}`,
        'skills',
        'release-windows',
        'SKILL.md',
      );
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, '# Release Windows\nBuild and validate the Windows desktop release.\n', 'utf8');

      const listed = await cli.dispatcher.dispatch({ input: '/skill-list' });
      expect(listed.ok).toBe(true);
      expect(listed.code).toBe('SKILL_LIST');
      expect(listed.data).toEqual({
        puebloWorkingDirectory: startupDir,
        skillDirectory: path.join(startupDir, `agent-${agentInstanceId}`, 'skills'),
        skills: [
          {
            id: 'release-windows',
            instructionPath: 'agent-' + agentInstanceId + '/skills/release-windows/SKILL.md',
            description: 'Build and validate the Windows desktop release.',
          },
        ],
      });

      const opened = await cli.dispatcher.dispatch({ input: '/skill-open release-windows' });
      expect(opened.ok).toBe(true);
      expect(opened.code).toBe('SKILL_OPEN');
      expect(opened.data).toEqual({
        skill: {
          id: 'release-windows',
          instructionPath: 'agent-' + agentInstanceId + '/skills/release-windows/SKILL.md',
          description: 'Build and validate the Windows desktop release.',
        },
        path: skillPath,
        content: '# Release Windows\nBuild and validate the Windows desktop release.\n',
      });
    } finally {
      cli.databaseClose();
    }
  });
});