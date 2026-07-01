// ============================================================================
// template-resolver.ts — 模板发现与解析系统
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedSkill, ParsedArtifactTemplate } from './amber-types.js';
import { parseSkillMd } from './parsers/skill-parser.js';
import { parseArtifactTemplate } from './parsers/artifact-template-parser.js';

// ---------------------------------------------------------------------------
// 模板发现
// ---------------------------------------------------------------------------

/**
 * 在指定目录下递归发现所有 SKILL.md 并解析。
 */
export function discoverSkills(skillDir: string): Map<string, ParsedSkill> {
    const skills = new Map<string, ParsedSkill>();

    if (!fs.existsSync(skillDir)) {
        return skills;
    }

    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(skillDir, entry.name);
        if (entry.isDirectory()) {
            const skillMdPath = path.join(fullPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
                try {
                    const content = fs.readFileSync(skillMdPath, 'utf-8');
                    const parsed = parseSkillMd(content, skillMdPath);
                    skills.set(parsed.path, parsed);
                } catch {
                    // 跳过无法解析的 skill
                }
            } else {
                // 递归子目录
                const subSkills = discoverSkills(fullPath);
                for (const [key, value] of subSkills) {
                    skills.set(key, value);
                }
            }
        }
    }

    return skills;
}

/**
 * 在指定目录下发现所有 *-template.md 模板并解析。
 */
export function discoverArtifactTemplates(
    templateDir: string,
): Map<string, ParsedArtifactTemplate> {
    const templates = new Map<string, ParsedArtifactTemplate>();

    if (!fs.existsSync(templateDir)) {
        return templates;
    }

    const entries = fs.readdirSync(templateDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(templateDir, entry.name);
        if (entry.isFile() && entry.name.endsWith('-template.md')) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const parsed = parseArtifactTemplate(content, fullPath);
                templates.set(parsed.name, parsed);
            } catch {
                // 跳过无法解析的模板
            }
        } else if (entry.isDirectory()) {
            const subTemplates = discoverArtifactTemplates(fullPath);
            for (const [key, value] of subTemplates) {
                templates.set(key, value);
            }
        }
    }

    return templates;
}

// ---------------------------------------------------------------------------
// 模板查找
// ---------------------------------------------------------------------------

/**
 * 按名称在 artifact 模板 Map 中查找。
 * 支持短名匹配："task-stream-a" ↔ "task-stream-a"
 */
export function resolveArtifactTemplate(
    templateName: string,
    templates: Map<string, ParsedArtifactTemplate>,
): ParsedArtifactTemplate | undefined {
    // 精确匹配
    const direct = templates.get(templateName);
    if (direct) return direct;

    // 遍历匹配
    for (const [, template] of templates) {
        if (template.name === templateName) return template;
    }

    return undefined;
}
