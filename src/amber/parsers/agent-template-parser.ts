// ============================================================================
// agent-template-parser.ts — agent.md 模板解析器
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedMd } from '../amber-types.js';
import { getDefaultModelIdentifier } from '../../shared/config.js';

// ---------------------------------------------------------------------------
// 解析 agent.md 内部结构
// ---------------------------------------------------------------------------

/** agent.md 各指令段的解析器 */
const DIRECTIVE_SECTION_REGEX = /^##\s+(\w+)\s+Directives\s*$/im;
const DIRECTIVE_ITEM_REGEX = /^[-*]\s+(.+)$/;
const MODEL_PATTERN = /model\s*[:=]\s*([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)/i;

function parseDirectivesBlock(body: string): ParsedMd['directives'] {
    const directives: ParsedMd['directives'] = {
        role: [],
        goal: [],
        constraint: [],
        style: [],
    };

    const lines = body.split(/\r?\n/);
    let currentSection: keyof ParsedMd['directives'] | null = null;

    for (const line of lines) {
        const sectionMatch = line.match(/^##\s+(\w+)\s+Directives\s*$/i);
        if (sectionMatch) {
            const sectionName = sectionMatch[1].toLowerCase() as keyof ParsedMd['directives'];
            if (sectionName in directives) {
                currentSection = sectionName;
            } else {
                currentSection = null;
            }
            continue;
        }

        if (currentSection) {
            const itemMatch = line.match(DIRECTIVE_ITEM_REGEX);
            if (itemMatch) {
                directives[currentSection].push(itemMatch[1].trim());
            }
        }
    }

    return directives;
}

function findPuebloRoot(filePath: string): string | undefined {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.pueblo', 'config.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return undefined;
}

function extractModel(body: string, puebloPath?: string): ParsedMd['model'] {
    const match = body.match(MODEL_PATTERN);
    if (match) {
        return { provider: match[1], name: match[2] };
    }
    return getDefaultModelIdentifier(puebloPath);
}

/**
 * 将 ParsedMd.directives 组装为 systemPrompt。
 * 策略：按 Role → Goal → Constraints → Style 顺序拼接。
 */
function buildSystemPrompt(directives: ParsedMd['directives']): string {
    const parts: string[] = [];

    if (directives.role.length > 0) {
        parts.push('## Role');
        parts.push(...directives.role.map((d) => `- ${d}`));
        parts.push('');
    }
    if (directives.goal.length > 0) {
        parts.push('## Goals');
        parts.push(...directives.goal.map((d) => `- ${d}`));
        parts.push('');
    }
    if (directives.constraint.length > 0) {
        parts.push('## Constraints');
        parts.push(...directives.constraint.map((d) => `- ${d}`));
        parts.push('');
    }
    if (directives.style.length > 0) {
        parts.push('## Style');
        parts.push(...directives.style.map((d) => `- ${d}`));
        parts.push('');
    }

    return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 解析 agent.md 模板内容，返回 ParsedMd。
 *
 * agent.md 结构约定：
 * ```
 * ## Role Directives
 * - 你是一名高级软件工程师。
 *
 * ## Goal Directives
 * - 产出正确、可测试的代码变更。
 *
 * ## Constraint Directives
 * - 不改变与目标无关的内容。
 *
 * ## Style Directives
 * - 简明、技术性强、直接。
 * ```
 */
export function parseAgentMd(content: string, puebloPath?: string): ParsedMd {
    const directives = parseDirectivesBlock(content);
    const model = extractModel(content, puebloPath);
    const systemPrompt = buildSystemPrompt(directives);

    return { directives, systemPrompt, model };
}

/**
 * 从文件路径读取并解析 agent.md 模板。
 */
export function parseAgentMdFile(filePath: string): ParsedMd {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const puebloRoot = findPuebloRoot(absolutePath);
    return parseAgentMd(content, puebloRoot);
}
