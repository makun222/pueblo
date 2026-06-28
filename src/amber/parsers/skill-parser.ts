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
    const match = firstLine.match(/^#\s+(.+?)(?:\s*[—–-]\s*.+)?$/);
    if (match) {
        return match[1].trim();
    }
    return 'UnnamedSkill';
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
export function parseSkillMd(content: string, skillPath: string): ParsedSkill {
    const name = extractSkillName(content);
    const description = extractSkillDescription(content);
    const summary = extractSkillSummary(content);

    return { name, path: skillPath, description, summary };
}

/**
 * 从文件路径读取并解析 SKILL.md。
 */
export function parseSkillMdFile(filePath: string): ParsedSkill {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return parseSkillMd(content, absolutePath);
}
