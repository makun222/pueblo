// ============================================================================
// artifact-template-parser.test.ts — artifact 模板解析器单元测试
// ============================================================================

import { describe, it, expect } from 'vitest';
import { parseArtifactTemplate } from '../../src/amber/parsers/artifact-template-parser.js';

// ---------------------------------------------------------------------------
// parseArtifactTemplate — 内联 fixture 数据，无 FS 依赖
// ---------------------------------------------------------------------------

describe('parseArtifactTemplate', () => {
    it('提取模板名称（从路径）', () => {
        const content = '{{ANCHOR}}';
        const result = parseArtifactTemplate(content, '/some/dir/task-stream-a.artifact.md');

        expect(result.name).toBe('task-stream-a');
    });

    it('提取锚点名（显式 {{TASK_STREAM}}）', () => {
        const content = 'Hello {{TASK_STREAM}} world';
        const result = parseArtifactTemplate(content, '/tmp/test.artifact.md');

        expect(result.anchor).toBe('TASK_STREAM');
    });

    it('缺省锚点名：无 {{}} 时回退为 ANCHOR', () => {
        const content = 'Just a plain template with no anchors.';
        const result = parseArtifactTemplate(content, '/tmp/test.artifact.md');

        expect(result.anchor).toBe('ANCHOR');
    });

    it('按 --- 分隔符拆分段落', () => {
        const content = [
            '第一段内容',
            '---',
            '第二段内容',
            '---',
            '第三段内容',
        ].join('\n');

        const result = parseArtifactTemplate(content, '/tmp/test.artifact.md');

        expect(result.sections).toEqual(['第一段内容', '第二段内容', '第三段内容']);
    });

    it('单段落模板：无 --- 时整个内容为一个段落', () => {
        const content = 'A single section with {{ANCHOR}} inside.';

        const result = parseArtifactTemplate(content, '/tmp/test.artifact.md');

        expect(result.sections).toEqual([content]);
    });

    it('忽略空段落（连续 --- 或首尾分隔符）', () => {
        const content = [
            '---',
            '唯一有效段落',
            '---',
            '',
            '---',
        ].join('\n');

        const result = parseArtifactTemplate(content, '/tmp/test.artifact.md');

        expect(result.sections).toEqual(['唯一有效段落']);
    });

    it('多锚点时返回第一个匹配', () => {
        const content = '{{FIRST}} then {{SECOND}}';
        const result = parseArtifactTemplate(content, '/tmp/test.artifact.md');

        expect(result.anchor).toBe('FIRST');
    });

    it('返回完整 ParsedArtifactTemplate 结构', () => {
        const content = '## Output\n{{DATA}}\n---\n## Notes';
        const result = parseArtifactTemplate(content, '/home/user/report.artifact.md');

        expect(result).toEqual({
            name: 'report',
            sections: ['## Output\n{{DATA}}', '## Notes'],
            anchor: 'DATA',
        });
    });
});
