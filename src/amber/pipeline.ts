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

function parseSimpleYaml(content: string): YamlNode {
    const lines = content.split(/\r?\n/);
    const root: YamlNode = {};
    const stack: YamlNode[] = [root];
    let currentListKey: string | null = null;
    let listContainer: YamlNode | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line.trim() === '' || line.trim().startsWith('#')) {
            continue; // 跳过空行和注释
        }

        const indent = rawLine.length - rawLine.trimStart().length;
        const trimmed = line.trim();

        // 列表项
        const listMatch = trimmed.match(YAML_LIST_ITEM);
        if (listMatch && currentListKey && listContainer) {
            const listValue = listMatch[1].trim();

            // 弹出前一个列表项的嵌套节点，回到列表容器
            while (
                stack.length > 0 &&
                stack[stack.length - 1] !== listContainer
            ) {
                stack.pop();
            }

            // 确保列表容器上该 key 是数组（首次遇到时从 {} 转换为 []）
            if (!Array.isArray(listContainer[currentListKey])) {
                listContainer[currentListKey] = [];
            }
            const arr = listContainer[currentListKey] as unknown[];

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
                    currentListKey = key;
                    listContainer = newNode;
                } else if (value === '[]') {
                    stack[stack.length - 1][key] = [];
                    currentListKey = key;
                } else {
                    // 标量值
                    stack[stack.length - 1][key] = value.replace(/^["']|["']$/g, '');
                    // 不清除 currentListKey — 嵌套在列表中的 KV 行需要保持列表上下文
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

    if (!Array.isArray(rawPhases)) {
        // 向后兼容：旧版 YAML 解析器可能产出 plain object（多个 phase 被合并）
        if (typeof rawPhases === 'object' && rawPhases !== null && !Array.isArray(rawPhases)) {
            amberLog('warn', 'parsePhases 收到 object 而非 array（可能是 YAML 解析格式兼容问题）');
            // 将单个 object 视为单个 phase
            const obj = rawPhases as Record<string, unknown>;
            const id = (obj['id'] as string) ?? 'phase-1';
            const name = (obj['name'] as string) ?? id;
            const goal = (obj['goal'] as string) ?? '';
            const skills: string[] = Array.isArray(obj['skills']) ? (obj['skills'] as string[]) : [];
            const artifactTemplates: string[] = Array.isArray(obj['artifactTemplates']) ? (obj['artifactTemplates'] as string[]) : [];
            const dependsOn: string[] = Array.isArray(obj['dependsOn']) ? (obj['dependsOn'] as string[]) : [];
            return [{ id, name, goal, skills, artifactTemplates, dependsOn }];
        }
        return [];
    }

    return (rawPhases as YamlNode[]).map((raw, index) => {
        const id = (raw['id'] as string) ?? `phase-${index + 1}`;
        const name = (raw['name'] as string) ?? id;
        const goal = (raw['goal'] as string) ?? '';
        const skills: string[] = Array.isArray(raw['skills'])
            ? (raw['skills'] as string[])
            : [];
        const artifactTemplates: string[] = Array.isArray(raw['artifactTemplates'])
            ? (raw['artifactTemplates'] as string[])
            : [];
        const dependsOn: string[] = Array.isArray(raw['dependsOn'])
            ? (raw['dependsOn'] as string[])
            : [];

        const rawOutput = raw['output'] as Record<string, unknown> | undefined;
        const output = rawOutput &&
            typeof rawOutput.type === 'string' &&
            typeof rawOutput.path === 'string'
            ? { type: rawOutput.type as 'file' | 'variable', path: rawOutput.path }
            : undefined;

        return { id, name, goal, skills, artifactTemplates, dependsOn, ...(output ? { output } : {}) };
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
                    if (!artifacts.includes(a)) {
                        artifacts.push(a);
                    }
                }
            }
        }
    }

    collect(phaseId);
    return artifacts;
}
