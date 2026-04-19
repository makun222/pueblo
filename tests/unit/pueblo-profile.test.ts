import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PuebloProfileLoader, parsePuebloProfile } from '../../src/agent/pueblo-profile';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('pueblo profile parsing', () => {
  it('parses recognized sections and ignores unknown headings', () => {
    const profile = parsePuebloProfile(
      [
        '# Role',
        '- repository agent',
        '# Goals',
        '- fix root cause',
        '# Context Policy',
        '- selected prompts first',
        '- Truncate: prefer recent messages',
        '# Summary Policy',
        '- manual only',
        '- lineage: parent-memory',
        '# Unknown',
        '- ignored',
      ].join('\n'),
      'd:/workspace/trends/pueblo/pueblo.md',
    );

    expect(profile.roleDirectives).toEqual(['repository agent']);
    expect(profile.goalDirectives).toEqual(['fix root cause']);
    expect(profile.contextPolicy.priorityHints).toEqual(['selected prompts first']);
    expect(profile.contextPolicy.truncationHints).toEqual(['prefer recent messages']);
    expect(profile.summaryPolicy.autoSummarize).toBe(false);
    expect(profile.summaryPolicy.lineageHint).toBe('parent-memory');
  });

  it('loads pueblo.md from the workspace root', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-profile-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(tempDir, 'pueblo.md'), '# Role\n- rooted agent\n');

    const loader = new PuebloProfileLoader();
    const profile = loader.load(tempDir);

    expect(profile.loadedFromPath).toBe(path.join(tempDir, 'pueblo.md'));
    expect(profile.roleDirectives).toEqual(['rooted agent']);
  });
});