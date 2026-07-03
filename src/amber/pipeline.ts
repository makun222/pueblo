// ============================================================================
// pipeline.ts — pipeline.yaml 解析与 Phase 调度
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineDefinition, Phase } from './amber-types.js';
import { amberLog } from '../utils/perf-logger.js';

// ---------------------------------------------------------------------------
// pipeline.yaml 结构
// ---------------------------------------------------------------------------

/**
 * pipeline.yaml 顶层结构：
 * ```yaml
 * version: "1.0"
 * name: example-pipeline
 * phases:
 *   - id: phase-1
 *     name: "Phase One"
 *     goal: "Do the first thing"
 *     skills:
 *       - analysis
 *     artifactTemplates:
 *       - task-stream-a
 *     dependsOn: []
 *   - id: phase-2
 *     name: "Phase Two"
 *     goal: "Do the second thing"
 *     skills:
 *       - code-generation
 *     artifactTemplates:
 *       - task-stream-b
 *     dependsOn:
 *       - phase-1
 * ```
 */

// 简易 YAML 解析：逐行解析（不依赖外部库）
const YAML_LIST_ITEM = /^\s*-\s+(.+)$/;
const YAML_KV = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/;

interface YamlNode {
    [key: string]: unknown;
}

interface ListContext {
    key: string;
    container: YamlNode;
    indent: number;
}

function parseSimpleYaml(content: string): YamlNode {
    const lines = content.split(/\r?\n/);
    const root: YamlNode = {};
    const stack: YamlNode[] = [root];
    /** 每个 stack 节点对应的缩进级别（用于退出嵌套上下文） */
    const stackIndents: number[] = [0];
    /** 列表上下文栈，支持嵌套列表的自动恢复 */
    const listCtxStack: ListContext[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const rawLine = lines[lineIndex];
        const line = rawLine.trimEnd();
        if (line.trim() === '' || line.trim().startsWith('#')) {
            continue; // 跳过空行和注释
        }

        const indent = rawLine.length - rawLine.trimStart().length;
        const trimmed = line.trim();

        // 基于缩进回退 stack：缩进小于栈顶节点缩进 → 退出嵌套上下文
        while (stack.length > 1 && indent < stackIndents[stack.length - 1]) {
            stack.pop();
            stackIndents.pop();
        }

        // 同步清理列表上下文栈：缩进已回退，丢弃更深层的列表上下文
        while (listCtxStack.length > 0 && indent < listCtxStack[listCtxStack.length - 1].indent) {
            listCtxStack.pop();
        }

        // 列表项检测
        const listMatch = trimmed.match(YAML_LIST_ITEM);

        // 当前行是 KV（非列表项），但仍在某个列表上下文中
        // 若缩进 ≤ 当前列表上下文缩进 → 说明已离开该列表范围
        if (
            !listMatch &&
            listCtxStack.length > 0 &&
            indent <= listCtxStack[listCtxStack.length - 1].indent
        ) {
            // 弹出所有缩进 >= 当前缩进的列表上下文，并同步弹出栈上的嵌套节点
            while (listCtxStack.length > 0 && listCtxStack[listCtxStack.length - 1].indent >= indent) {
                const poppedCtx = listCtxStack.pop()!;
                // 若栈顶就是该列表上下文的容器节点，弹出它
                if (stack.length > 0 && stack[stack.length - 1] === poppedCtx.container) {
                    stack.pop();
                    stackIndents.pop();
                }
            }
        }

        // 活跃的列表上下文
        const currentListCtx = listCtxStack.length > 0 ? listCtxStack[listCtxStack.length - 1] : null;

        if (listMatch && currentListCtx) {
            const listValue = listMatch[1].trim();

            // 弹出前一个列表项的嵌套节点，回到列表容器
            while (
                stack.length > 0 &&
                stack[stack.length - 1] !== currentListCtx.container
            ) {
                stack.pop();
                stackIndents.pop();
            }

            // 确保列表容器上该 key 是数组（首次遇到时从 {} 转换为 []）
            if (!Array.isArray(currentListCtx.container[currentListCtx.key])) {
                currentListCtx.container[currentListCtx.key] = [];
            }
            const arr = currentListCtx.container[currentListCtx.key] as unknown[];

            // 检查是否为复杂列表项（嵌套 KV，如 "id: default"）
            const nestedKv = listValue.match(
                /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/,
            );
            if (nestedKv) {
                const newObj: YamlNode = {};
                newObj[nestedKv[1]] = nestedKv[2].replace(
                    /^["']|["']$/g,
                    '',
                );
                arr.push(newObj);
                stack.push(newObj);
                stackIndents.push(indent);
            } else {
                arr.push(
                    listValue.replace(/^["']|["']$/g, ''),
                );
            }
        } else {
            // 键值对
            const kvMatch = trimmed.match(YAML_KV);
            if (kvMatch) {
                const key = kvMatch[1];
                const value = kvMatch[2].trim();

                if (value === '') {
                    // 嵌套对象 / 列表父节点
                    const newNode: YamlNode = {};
                    stack[stack.length - 1][key] = newNode;
                    stack.push(newNode);
                    stackIndents.push(indent);
                    listCtxStack.push({ key, container: newNode, indent });
                } else if (value === '[]') {
                    stack[stack.length - 1][key] = [];
                    listCtxStack.push({
                        key,
                        container: stack[stack.length - 1],
                        indent,
                    });
                } else {
                    // 标量值（支持多行双引号字符串）
                    let finalVal = value;
                    if (finalVal.startsWith('"') && !finalVal.endsWith('"')) {
                        for (let j = lineIndex + 1; j < lines.length; j++) {
                            finalVal += '\n' + lines[j];
                            lineIndex = j;
                            // 只有当当前行末尾有奇数个未转义双引号时才视为真正的闭合行
                            const currentLine = lines[j];
                            const trimmed = currentLine.trimEnd();
                            if (trimmed.endsWith('"')) {
                                let quoteCount = 0;
                                for (let k = 0; k < trimmed.length; k++) {
                                    if (trimmed[k] === '"' && (k === 0 || trimmed[k - 1] !== '\\')) {
                                        quoteCount++;
                                    }
                                }
                                if (quoteCount % 2 === 1) {
                                    break;
                                }
                            }
                        }
                    }
                    stack[stack.length - 1][key] = finalVal.replace(/^["']|["']$/g, '');
                    // 不清除列表上下文 — 嵌套在列表中的 KV 行需要保持列表上下文
                }
            }
        }
    }

    return root;
}

// ---------------------------------------------------------------------------
// Pipeline 解析
// ---------------------------------------------------------------------------

/**
 * 将解析后的 YAML 节点转为 Phase 数组。
 */
function parsePhases(rawPhases: unknown): Phase[] {
    if (!rawPhases) {
        return [];
    }

    /**
     * 解包 YAML 解析器产生的冗余嵌套结构。
     * 简单 YAML 解析器对空值 key 后跟列表项会产生 { key: { key: [...] } } 而非 { key: [...] }。
     */
    function unwrapNested(raw: unknown, key: string): unknown[] | null {
        if (Array.isArray(raw)) return raw as unknown[];
        if (typeof raw === 'object' && raw !== null) {
            const obj = raw as Record<string, unknown>;
            if (Array.isArray(obj[key])) return obj[key] as unknown[];
        }
        return null;
    }

    // 解包受影响的字段 skill/artifactTemplates/dependsOn
    function unwrapStrings(raw: unknown, key: string): string[] {
        const arr = unwrapNested(raw, key);
        if (!arr) return [];
        return arr.map(s => (typeof s === 'string' ? s : String(s)));
    }

    // 先对 rawPhases 自身解包: { phases: [...] } → [...]
    const phasesArr = unwrapNested(rawPhases, 'phases');
    if (phasesArr) {
        rawPhases = phasesArr;
    }

    if (!Array.isArray(rawPhases)) {
        // 向后兼容：旧版 YAML 解析器可能产出 plain object（多个 phase 被合并）
        if (typeof rawPhases === 'object' && rawPhases !== null && !Array.isArray(rawPhases)) {
            amberLog('warn', 'parsePhases 收到 object 而非 array（可能是 YAML 解析格式兼容问题）');
            // 将单个 object 视为单个 phase
            const obj = rawPhases as Record<string, unknown>;
            const id = (obj['id'] as string) ?? 'phase-1';
            const name = (obj['name'] as string) ?? id;
            const goal = (obj['goal'] as string) ?? '';
            const skills = unwrapStrings(obj['skills'], 'skills');
            const artifactTemplates = unwrapStrings(obj['artifactTemplates'], 'artifactTemplates');
            const dependsOn = unwrapStrings(obj['dependsOn'], 'dependsOn');
            return [{ id, name, goal, skills, artifactTemplates, dependsOn }];
        }
        return [];
    }

    return (rawPhases as YamlNode[]).map((raw, index) => {
        const id = (raw['id'] as string) ?? `phase-${index + 1}`;
        const name = (raw['name'] as string) ?? id;
        const goal = (raw['goal'] as string) ?? '';
        const skills = unwrapStrings(raw['skills'], 'skills');

        // Parse model field (format: "provider/name")
        let model: { provider: string; name: string } | undefined;
        if (typeof raw['model'] === 'string') {
            const parts = (raw['model'] as string).split('/');
            if (parts.length === 2) {
                model = { provider: parts[0], name: parts[1] };
            }
        }

        const artifactTemplates = unwrapStrings(raw['artifactTemplates'], 'artifactTemplates');
        const dependsOn = unwrapStrings(raw['dependsOn'], 'dependsOn');

        const rawOutput = raw['output'] as Record<string, unknown> | undefined;
        const output = rawOutput &&
            typeof rawOutput.type === 'string' &&
            typeof rawOutput.path === 'string'
            ? { type: rawOutput.type as 'file' | 'variable', path: rawOutput.path }
            : undefined;

        return { id, name, goal, skills, model, artifactTemplates, dependsOn, ...(output ? { output } : {}) };
    });
}

/**
 * 解析 pipeline.yaml 内容字符串。
 */
export function parsePipelineYaml(content: string): PipelineDefinition {
    const parsed = parseSimpleYaml(content);

    // YAML may include a 'pipeline:' wrapper key — unwrap if present
    const root = (parsed['pipeline'] as Record<string, unknown>) ?? parsed;
    const version = (root['version'] as string) ?? '1.0';
    const name = (root['name'] as string) ?? 'unnamed-pipeline';
    const phases = parsePhases(root['phases']);

    return { version, name, phases };
}

/**
 * 从文件路径读取并解析 pipeline.yaml。
 */
export function parsePipelineYamlFile(filePath: string): PipelineDefinition {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return parsePipelineYaml(content);
}

// ---------------------------------------------------------------------------
// Phase 调度
// ---------------------------------------------------------------------------

/**
 * 按依赖关系对 Phase 拓扑排序，返回可执行顺序。
 * 若存在循环依赖则抛出。
 */
export function schedulePhases(phases: Phase[]): Phase[] {
    const phaseMap = new Map<string, Phase>();
    for (const p of phases) {
        phaseMap.set(p.id, p);
    }

    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const p of phases) {
        if (!inDegree.has(p.id)) {
            inDegree.set(p.id, 0);
        }
        if (!adjacency.has(p.id)) {
            adjacency.set(p.id, []);
        }
        for (const dep of p.dependsOn) {
            if (!adjacency.has(dep)) {
                adjacency.set(dep, []);
            }
            adjacency.get(dep)!.push(p.id);
            inDegree.set(p.id, (inDegree.get(p.id) ?? 0) + 1);
        }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
        if (degree === 0) {
            queue.push(id);
        }
    }

    const sorted: Phase[] = [];
    while (queue.length > 0) {
        const current = queue.shift()!;
        const phase = phaseMap.get(current);
        if (phase) {
            sorted.push(phase);
        }
        for (const neighbor of adjacency.get(current) ?? []) {
            const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
            inDegree.set(neighbor, newDegree);
            if (newDegree === 0) {
                queue.push(neighbor);
            }
        }
    }

    if (sorted.length !== phases.length) {
        throw new Error(
            `Pipeline: circular dependency detected in phases (sorted ${sorted.length}/${phases.length})`,
        );
    }

    return sorted;
}

/**
 * 为指定 Phase 聚合其所有前置 Phase 的 artifact 路径列表。
 */
export function collectUpstreamArtifacts(
    phaseId: string,
    orderedPhases: Phase[],
    phaseArtifacts: Map<string, string[]>,
): string[] {
    const artifacts: string[] = [];
    const phase = orderedPhases.find((p) => p.id === phaseId);
    if (!phase) return artifacts;

    const visited = new Set<string>();

    function collect(pId: string) {
        if (visited.has(pId)) return;
        visited.add(pId);
        const deps = orderedPhases.find((p) => p.id === pId)?.dependsOn ?? [];
        for (const depId of deps) {
            collect(depId);
            const depArtifacts = phaseArtifacts.get(depId);
            if (depArtifacts) {
                for (const a of depArtifacts) {
                    const prefixed = `@${depId}/${a}`;
                    if (!artifacts.includes(prefixed)) {
                        artifacts.push(prefixed);
                    }
                }
            }
        }
    }

    collect(phaseId);
    return artifacts;
}
