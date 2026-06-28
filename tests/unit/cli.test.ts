// ============================================================================
// cli.test.ts — CLI 参数解析单元测试
// ============================================================================

import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../../src/amber/cli.js';

// ---------------------------------------------------------------------------
// parseCliArgs — 纯参数解析（无 FS / 无 LLM）
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
    it('解析必填 --repo-path', () => {
        const result = parseCliArgs(['--repo-path', '/home/user/project']);

        expect(result.repoPath).toBe('/home/user/project');
    });

    it('默认 agentTemplate 为 "code-master"', () => {
        const result = parseCliArgs(['--repo-path', '/tmp']);

        expect(result.agentTemplate).toBe('code-master');
    });

    it('显式指定 --agent-template', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--agent-template', 'architect',
        ]);

        expect(result.agentTemplate).toBe('architect');
    });

    it('--pipeline-path 指定自定义 pipeline', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--pipeline-path', '/custom/pipeline.yaml',
        ]);

        expect(result.pipelinePath).toBe('/custom/pipeline.yaml');
    });

    it('--pipeline 别名与 --pipeline-path 等效', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--pipeline', '/alt/pipeline.yaml',
        ]);

        expect(result.pipelinePath).toBe('/alt/pipeline.yaml');
    });

    it('--extra-prompt 单次追加', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--extra-prompt', 'Focus on security.',
        ]);

        expect(result.extraPrompts).toEqual(['Focus on security.']);
    });

    it('--extra-prompt 多次重复追加', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--extra-prompt', 'Priority: performance',
            '--extra-prompt', 'Style: functional',
        ]);

        expect(result.extraPrompts).toEqual([
            'Priority: performance',
            'Style: functional',
        ]);
    });

    it('未知参数被忽略不报错', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--unknown-flag', 'value',
            '--another',
        ]);

        // 未知参数不改变已知字段
        expect(result.repoPath).toBe('/tmp');
        expect(result.agentTemplate).toBe('code-master');
    });

    it('组合参数完整解析', () => {
        const result = parseCliArgs([
            '--repo-path', '/home/dev/main',
            '--agent-template', 'craft',
            '--pipeline-path', '/etc/pueblo/ops.yaml',
            '--extra-prompt', 'Use TDD.',
            '--extra-prompt', 'Keep functions small.',
        ]);

        expect(result).toEqual({
            repoPath: '/home/dev/main',
            agentTemplate: 'craft',
            pipelinePath: '/etc/pueblo/ops.yaml',
            extraPrompts: ['Use TDD.', 'Keep functions small.'],
        });
    });

    it('空参数列表返回默认值', () => {
        const result = parseCliArgs([]);

        expect(result.repoPath).toBe('');
        expect(result.agentTemplate).toBe('code-master');
        expect(result.pipelinePath).toBeUndefined();
        expect(result.extraPrompts).toEqual([]);
    });

    it('--repo-path 缺值时使用空字符串', () => {
        const result = parseCliArgs(['--repo-path']);

        expect(result.repoPath).toBe('');
    });

    it('--extra-prompt 缺值时追加空字符串', () => {
        const result = parseCliArgs([
            '--repo-path', '/tmp',
            '--extra-prompt',
        ]);

        expect(result.extraPrompts).toEqual(['']);
    });
});
