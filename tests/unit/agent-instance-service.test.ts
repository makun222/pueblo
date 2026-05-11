import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryAgentInstanceRepository } from '../../src/agent/agent-instance-repository';
import { AgentInstanceService } from '../../src/agent/agent-instance-service';
import { AgentTemplateLoader } from '../../src/agent/agent-template-loader';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('agent instance service', () => {
  it('reuses the default instance for the same profile', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-instance-service-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(tempDir, 'puebl-profile', 'code-master'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'puebl-profile', 'code-master', 'agent.md'),
      [
        '# Profile',
        '- id: code-master',
        '- name: Code Master',
        '- description: Focused on shipping correct code changes.',
        '',
        '# Role',
        '- Write correct code.',
      ].join('\n'),
    );

    const service = new AgentInstanceService(
      new InMemoryAgentInstanceRepository(),
      new AgentTemplateLoader(tempDir),
    );

    const first = service.getOrCreateDefaultAgentInstance('code-master', 'd:/workspace/one');
    const second = service.getOrCreateDefaultAgentInstance('code-master', 'd:/workspace/two');

    expect(second.id).toBe(first.id);
    expect(second.isDefaultForProfile).toBe(true);
    expect(second.workspaceRoot).toBe('d:/workspace/one');
  });

  it('promotes the latest legacy instance to default when no explicit default exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-instance-legacy-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(tempDir, 'puebl-profile', 'code-master'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'puebl-profile', 'code-master', 'agent.md'),
      [
        '# Profile',
        '- id: code-master',
        '- name: Code Master',
        '- description: Focused on shipping correct code changes.',
        '',
        '# Role',
        '- Write correct code.',
      ].join('\n'),
    );

    const repository = new InMemoryAgentInstanceRepository();
    const service = new AgentInstanceService(repository, new AgentTemplateLoader(tempDir));

    const first = service.createAgentInstance('code-master', 'd:/workspace/one');
    const second = service.createAgentInstance('code-master', 'd:/workspace/two');
    repository.save({
      ...first,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    repository.save({
      ...second,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    const promoted = service.getOrCreateDefaultAgentInstance('code-master', 'd:/workspace/three');

    expect(promoted.id).toBe(second.id);
    expect(promoted.isDefaultForProfile).toBe(true);
    expect(repository.getById(first.id)?.isDefaultForProfile).toBe(false);
  });
});