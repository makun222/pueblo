import { describe, expect, it } from 'vitest';
import { createGlobTool } from '../../src/tools/glob-tool';
import { createGrepTool } from '../../src/tools/grep-tool';
import { createExecTool } from '../../src/tools/exec-tool';

describe('tool invocation contract', () => {
  it('returns normalized result objects from each tool adapter', async () => {
    const globTool = createGlobTool();
    const grepTool = createGrepTool();
    const execTool = createExecTool();

    const globResult = await globTool({ pattern: 'src/**/*.ts', cwd: process.cwd() });
    const grepResult = await grepTool({ pattern: 'createCliDependencies', cwd: process.cwd(), include: '*.ts' });
    const execResult = await execTool({ command: 'node -v', cwd: process.cwd() });

    expect(globResult.status).toMatch(/succeeded|empty/);
    expect(grepResult.status).toMatch(/succeeded|empty/);
    expect(execResult.status).toBe('succeeded');
  });
});
