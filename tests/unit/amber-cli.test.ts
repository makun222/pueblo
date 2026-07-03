import { describe, expect, test, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writePhaseArtifact } from '../../src/amber/cli.js';

describe('writePhaseArtifact', () => {
    const tempRoot = fs.mkdtempSync('amber-cli-test-');
    const repoPath = path.join(tempRoot, 'repo');
    const testArtifactsDir = path.join(repoPath, 'artifacts');

    afterEach(() => {
        // 清理 artifacts/ 下的文件，保留目录结构
        if (fs.existsSync(testArtifactsDir)) {
            const files = fs.readdirSync(testArtifactsDir);
            for (const f of files) {
                fs.rmSync(path.join(testArtifactsDir, f), { force: true });
            }
        }
    });

    test('写入单 phase 产物到 artifacts/<phaseId>.md', () => {
        const result = writePhaseArtifact(repoPath, 'phase-1', '# Phase 1 Report\n\nsome content');

        // 验证返回的绝对路径
        const expectedFile = path.join(repoPath, 'artifacts', 'phase-1.md');
        expect(result).toBe(expectedFile);

        // 验证文件存在，内容正确
        expect(fs.existsSync(expectedFile)).toBe(true);
        const content = fs.readFileSync(expectedFile, 'utf-8');
        expect(content).toBe('# Phase 1 Report\n\nsome content');
    });

    test('目录不存在时自动创建 artifacts/', () => {
        const deepRepo = path.join(tempRoot, 'new-repo');
        const deepArtifactsDir = path.join(deepRepo, 'artifacts');

        // 确保 deepRepo 存在但 artifacts/ 不存在
        fs.mkdirSync(deepRepo, { recursive: true });
        expect(fs.existsSync(deepArtifactsDir)).toBe(false);

        const filePath = writePhaseArtifact(deepRepo, 'phase-a', 'auto-created');

        // 验证 artifacts/ 被自动创建
        expect(fs.existsSync(deepArtifactsDir)).toBe(true);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('auto-created');
    });

    test('多 phase 写入各自独立文件', () => {
        writePhaseArtifact(repoPath, 'phase-1', 'content-1');
        writePhaseArtifact(repoPath, 'phase-2', 'content-2');
        writePhaseArtifact(repoPath, 'phase-a', 'content-a');

        const files = fs.readdirSync(testArtifactsDir).sort();
        expect(files).toEqual(['phase-1.md', 'phase-2.md', 'phase-a.md']);

        expect(fs.readFileSync(path.join(testArtifactsDir, 'phase-1.md'), 'utf-8')).toBe('content-1');
        expect(fs.readFileSync(path.join(testArtifactsDir, 'phase-2.md'), 'utf-8')).toBe('content-2');
        expect(fs.readFileSync(path.join(testArtifactsDir, 'phase-a.md'), 'utf-8')).toBe('content-a');
    });

    test('返回路径为预期格式', () => {
        const result = writePhaseArtifact(repoPath, 'page-1', 'data');

        // result 应为 <repoPath>\artifacts\page-1.md
        expect(result).toBe(path.join(repoPath, 'artifacts', 'page-1.md'));
    });

    test('写入多行/长内容', () => {
        const longContent = [
            '# Long Report',
            '',
            '## Section 1',
            'Line A',
            'Line B',
            '',
            '```js',
            'const x = 1;',
            '```',
        ].join('\n');

        const filePath = writePhaseArtifact(repoPath, 'long', longContent);
        const written = fs.readFileSync(filePath, 'utf-8');
        expect(written).toBe(longContent);
        expect(written.split('\n').length).toBe(9);
    });

    test('写入空字符串也能成功', () => {
        const filePath = writePhaseArtifact(repoPath, 'empty', '');
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
    });
});
