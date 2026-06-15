import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentTemplateLoader,
  resolveAgentTemplateFilePath,
  resolveSeedAgentProfilesDir,
} from '../../src/agent/agent-template-loader';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('agent template loader', () => {
  it('syncs updated seed agent.md content into the runtime template store', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-templates-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    const seedProfilesDir = resolveSeedAgentProfilesDir(tempDir);
    const seedDir = path.join(seedProfilesDir, 'code-master');
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'agent.md'), [
      '# Profile',
      '- id: code-master',
      '- name: Code Master',
      '- description: Focused on shipping correct code changes with strong validation discipline.',
      '',
      '# Role',
      '- Act as a pragmatic senior software engineer.',
      '',
      '# Goals',
      '- Produce correct, testable code changes.',
      '',
      '# Constraints',
      '- Do not change unrelated behavior.',
      '',
      '# Style',
      '- Be concise, technical, and direct.',
      '',
      '# Memory Policy',
      '- Retain task-relevant implementation decisions as reusable memories.',
      '- Summary: Summarize completed code turns into compact reusable engineering notes.',
      '',
      '# Context Policy',
      '- Prioritize current code goal, selected memories, and active constraints.',
      '- Truncate: Drop stale conversational history before dropping explicit task memories.',
      '',
      '# Summary Policy',
      '- Auto summarize',
      '- Threshold: 12000',
      '- Lineage: Preserve engineering decisions as reusable session memories.',
      '',
    ].join('\n'));

    const loader = new AgentTemplateLoader(tempDir);
    const initialTemplates = loader.list();
    expect(initialTemplates.some((template) => template.id === 'code-master')).toBe(true);

    fs.writeFileSync(path.join(seedDir, 'agent.md'), [
      '# Profile',
      '- id: code-master',
      '- name: Code Master',
      '- description: Focused on shipping code changes and evolving its own runtime profile file.',
      '',
      '# Role',
      '- Act as a pragmatic senior software engineer.',
      '',
      '# Goals',
      '- Produce correct, testable code changes.',
      '',
      '# Constraints',
      '- Do not change unrelated behavior.',
      '',
      '# Style',
      '- Be concise, technical, and direct.',
      '',
      '# Memory Policy',
      '- Retain task-relevant implementation decisions as reusable memories.',
      '- Summary: Summarize completed code turns into compact reusable engineering notes.',
      '',
      '# Context Policy',
      '- Prioritize current code goal, selected memories, and active constraints.',
      '- Truncate: Drop stale conversational history before dropping explicit task memories.',
      '',
      '# Summary Policy',
      '- Auto summarize',
      '- Threshold: 12000',
      '- Lineage: Preserve engineering decisions as reusable session memories.',
      '',
    ].join('\n'));

    expect(loader.get('code-master')?.description).toBe('Focused on shipping code changes and evolving its own runtime profile file.');
  });

  it('preserves runtime template edits when the seed template changes later', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-templates-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    const seedDir = path.join(resolveSeedAgentProfilesDir(tempDir), 'code-master');
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'agent.md'), [
      '# Profile',
      '- id: code-master',
      '- name: Code Master',
      '- description: Focused on shipping correct code changes with strong validation discipline.',
      '',
      '# Role',
      '- Act as a pragmatic senior software engineer.',
      '',
      '# Goals',
      '- Produce correct, testable code changes.',
      '',
      '# Constraints',
      '- Do not change unrelated behavior.',
      '',
      '# Style',
      '- Be concise, technical, and direct.',
      '',
      '# Memory Policy',
      '- Retain task-relevant implementation decisions as reusable memories.',
      '- Summary: Summarize completed code turns into compact reusable engineering notes.',
      '',
      '# Context Policy',
      '- Prioritize current code goal, selected memories, and active constraints.',
      '- Truncate: Drop stale conversational history before dropping explicit task memories.',
      '',
      '# Summary Policy',
      '- Auto summarize',
      '- Threshold: 12000',
      '- Lineage: Preserve engineering decisions as reusable session memories.',
      '',
    ].join('\n'));

    const loader = new AgentTemplateLoader(tempDir);
    loader.list();

    const templatePath = resolveAgentTemplateFilePath(tempDir, 'code-master');
    const originalMarkdown = fs.readFileSync(templatePath, 'utf8');
    const updatedTemplate = loader.save(
      'code-master',
      originalMarkdown.replace(
        'Focused on shipping correct code changes with strong validation discipline.',
        'Focused on shipping code changes and evolving its own runtime profile file.',
      ),
    );

    expect(updatedTemplate.description).toBe('Focused on shipping code changes and evolving its own runtime profile file.');

    fs.writeFileSync(path.join(seedDir, 'agent.md'), originalMarkdown.replace(
      'Focused on shipping correct code changes with strong validation discipline.',
      'Focused on shipping code changes from the repository seed template.',
    ));

    expect(loader.get('code-master')?.description).toBe('Focused on shipping code changes and evolving its own runtime profile file.');
  });
});