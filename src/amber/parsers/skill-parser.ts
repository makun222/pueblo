// ============================================================================
// skill-parser.ts — SKILL.md 解析器
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedSkill } from '../amber-types.js';

// ---------------------------------------------------------------------------
// Skill 名称提取
// ---------------------------------------------------------------------------

/**
 * 从 SKILL.md 的标题行提取 Skill 名称。
 * 约定：第一行 `# <SkillName>` 或 `# <SkillName> — <描述>`。
 */
function extractSkillName(content: string): string {
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? '';

    // em-dash / en-dash 作为分隔符（如 "# skill — 描述"）
    let match = firstLine.match(/^#\s+(.+?)(?:\s*[—–]\s*.+)?$/);
    if (match) return match[1].trim();

    // 空格-空格 作为显式分隔符（避免匹配名称中的连字符，如 "context-discipline"）
    match = firstLine.match(/^#\s+(.+?)(?:\s+-\s+.+)?$/);
    if (match) return match[1].trim();

    // 无分隔符，整行即为名称
    match = firstLine.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();

    return 'UnnamedSkill';
}

/**
 * 提取技能提示正文（prompt）。
 * 去除 YAML front matter 和首行标题后的全部内容。
 */
function extractSkillPrompt(content: string): string {
    const frontStripped = content.replace(/^---[\s\S]*?---\s*/g, '');
    const afterTitle = frontStripped.replace(/^#\s+.+\n+/, '');
    return afterTitle.trim();
}

/**
 * 从 SKILL.md 提取描述（第一段非标题文本）。
 */
function extractSkillDescription(content: string): string {
    const lines = content.split(/\r?\n/);
    let inContent = false;
    for (const line of lines) {
        // 跳过标题和元信息
        if (line.startsWith('#')) {
            continue;
        }
        if (line.trim() === '') {
            if (inContent) break;
            continue;
        }
        inContent = true;
        return line.trim();
    }
    return '';
}

/**
 * 提取 Skill 摘要（压缩全文）。
 */
function extractSkillSummary(content: string): string {
    // 去除标题行，取前 500 字作为摘要
    const lines = content.split(/\r?\n/);
    const bodyLines = lines.filter((l) => !l.startsWith('#') && l.trim() !== '');
    const body = bodyLines.join(' ');
    return body.length > 500 ? body.slice(0, 500) + '...' : body;
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 解析 SKILL.md 内容，返回 ParsedSkill。
 */
export function parseSkillMd(content: string, skillPath: string): ParsedSkill & { prompt: string } {
    const name = extractSkillName(content);
    const description = extractSkillDescription(content);
    const summary = extractSkillSummary(content);
    const prompt = extractSkillPrompt(content);

    return { name, path: skillPath, description, summary, prompt };
}

/**
 * 从文件路径读取并解析 SKILL.md。
 */
export function parseSkillMdFile(filePath: string): ParsedSkill & { prompt: string } {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return parseSkillMd(content, absolutePath);
}
