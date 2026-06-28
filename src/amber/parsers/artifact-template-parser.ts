// ============================================================================
// artifact-template-parser.ts — artifact 模板解析器
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedArtifactTemplate } from '../amber-types.js';

// ---------------------------------------------------------------------------
// 模板结构解析
// ---------------------------------------------------------------------------

/**
 * artifact 模板命名约定：
 * - 文件名格式：`<name>.artifact.md`，如 `task-stream-a.artifact.md`
 * - 模板由多个 Markdown 段落组成，段落边界为 `---` 分隔符
 * - 包含至少一个 `{{ANCHOR}}` 占位符作为替换锚点
 */
const ARTIFACT_TEMPLATE_EXT = '.artifact.md';
const SECTION_SEPARATOR = /^---\s*$/m;
const ANCHOR_PATTERN = /\{\{([A-Z_]+)\}\}/g;

/**
 * 按 `---` 分隔符拆分模板段落。
 */
function splitSections(content: string): string[] {
    const rawSections = content.split(SECTION_SEPARATOR);
    return rawSections.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 从模板中提取锚点名。
 * 返回第一个匹配的锚点名称，若无则返回 'ANCHOR'。
 */
function extractAnchor(content: string): string {
    const matches = [...content.matchAll(ANCHOR_PATTERN)];
    if (matches.length > 0 && matches[0][1]) {
        return matches[0][1];
    }
    return 'ANCHOR';
}

/**
 * 从文件名提取模板名称。
 * e.g., "task-stream-a.artifact.md" → "task-stream-a"
 */
function extractTemplateName(filePath: string): string {
    const base = path.basename(filePath, ARTIFACT_TEMPLATE_EXT);
    return base;
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 解析 artifact 模板内容，返回 ParsedArtifactTemplate。
 */
export function parseArtifactTemplate(
    content: string,
    templatePath: string,
): ParsedArtifactTemplate {
    const name = extractTemplateName(templatePath);
    const sections = splitSections(content);
    const anchor = extractAnchor(content);

    return { name, sections, anchor };
}

/**
 * 从文件路径读取并解析 artifact 模板。
 */
export function parseArtifactTemplateFile(
    filePath: string,
): ParsedArtifactTemplate {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return parseArtifactTemplate(content, absolutePath);
}
