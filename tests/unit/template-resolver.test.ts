// ============================================================================
// template-resolver.test.ts — 模板解析器单元测试
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveArtifactTemplate } from '../../src/amber/template-resolver.js';
import { parseArtifactTemplate } from '../../src/amber/parsers/artifact-template-parser.js';

// ---------------------------------------------------------------------------
// resolveArtifactTemplate — 按名称查找模板（Map 查找）
// ---------------------------------------------------------------------------

function buildTemplateMap(
    ...entries: Array<{ content: string; path: string }>
): Map<string, ReturnType<typeof parseArtifactTemplate>> {
    const m = new Map<string, ReturnType<typeof parseArtifactTemplate>>();
    for (const e of entries) {
        const parsed = parseArtifactTemplate(e.content, e.path);
        m.set(parsed.name, parsed);
    }
    return m;
}

describe('resolveArtifactTemplate', () => {
    const templates = buildTemplateMap(
        {
            content: '## Summary\n{{TASK_STREAM}}\n---\n## Details',
            path: '/templates/task-stream.artifact.md',
        },
        {
            content: '## Code\n{{CODE_DIFF}}\n---\n## Review',
            path: '/templates/code-review.artifact.md',
        },
        {
            content: '## Report\n{{REPORT_DATA}}',
            path: '/templates/analysis.artifact.md',
        },
    );

    it('按名称精确匹配返回模板', () => {
        const result = resolveArtifactTemplate('task-stream', templates);

        expect(result).toBeDefined();
        expect(result!.name).toBe('task-stream');
        expect(result!.anchor).toBe('TASK_STREAM');
    });

    it('查找列表中第二个模板', () => {
        const result = resolveArtifactTemplate('code-review', templates);

        expect(result).toBeDefined();
        expect(result!.name).toBe('code-review');
        expect(result!.anchor).toBe('CODE_DIFF');
    });

    it('无匹配模板时返回 undefined', () => {
        const result = resolveArtifactTemplate('non-existent', templates);

        expect(result).toBeUndefined();
    });

    it('空模板 Map 返回 undefined', () => {
        const empty = new Map();
        const result = resolveArtifactTemplate('task-stream', empty);

        expect(result).toBeUndefined();
    });

    it('区分 name（文件名）与 anchor（锚点名）', () => {
        const result = resolveArtifactTemplate('analysis', templates);

        expect(result!.name).toBe('analysis');
        expect(result!.anchor).toBe('REPORT_DATA');
        // name 来自文件名，anchor 来自内容中的 {{...}}
    });
});
