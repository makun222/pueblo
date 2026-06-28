// ============================================================================
// amber-context.ts — RunContext / AmberContext 定义与 CamelAgentInput 组装
// ============================================================================

import * as path from 'node:path';
import type { CamelAgentInput } from '../agent/camel/camel-types.js';
import type {
    AmberContext,
    PhaseResult,
    RunContext,
    PipelineDefinition,
    ParsedMd,
    ParsedSkill,
    ParsedArtifactTemplate,
    Phase,
} from './amber-types.js';
import { parseAgentMdFile } from './parsers/agent-template-parser.js';
import { parsePipelineYamlFile } from './pipeline.js';
import { discoverSkills, discoverArtifactTemplates } from './template-resolver.js';

// ---------------------------------------------------------------------------
// RunContext 工厂
// ---------------------------------------------------------------------------

interface CreateRunContextParams {
    runId: string;
    sessionId: string;
    repoPath: string;
    puebloPath: string;
    skillPath: string;
    agentTemplate: string;
    additionalPrompts?: string[];
    model?: { provider: string; name: string };
}

/**
 * 创建 RunContext 实例。
 */
export function createRunContext(params: CreateRunContextParams): RunContext {
    return {
        runId: params.runId,
        sessionId: params.sessionId,
        repoPath: params.repoPath,
        puebloPath: params.puebloPath,
        skillPath: params.skillPath,
        agentTemplate: params.agentTemplate,
        additionalPrompts: params.additionalPrompts ?? [],
        model: params.model ?? { provider: 'openai', name: 'gpt-4o' },
        completedPhases: new Map<string, PhaseResult>(),
    };
}

// ---------------------------------------------------------------------------
// Skill 辅助
// ---------------------------------------------------------------------------

/**
 * 根据 phase.skills 名称数组过滤全量 skill Map，返回 ParsedSkill[]。
 * 名称匹配使用技能 Map 的 key（skill 标识符）。
 */
function resolvePhaseSkills(
    skillNames: string[],
    allSkills: Map<string, ParsedSkill>,
): ParsedSkill[] {
    const result: ParsedSkill[] = [];
    for (const name of skillNames) {
        const skill = allSkills.get(name);
        if (skill) {
            result.push(skill);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// AmberContext 工厂
// ---------------------------------------------------------------------------

interface CreateAmberContextParams {
    runContext: RunContext;
    parsedAgent: ParsedMd;
    pipeline: PipelineDefinition;
    skills?: Map<string, ParsedSkill>;
    artifactTemplates?: Map<string, ParsedArtifactTemplate>;
}

/**
 * 创建 AmberContext 实例。
 * AmberContext 是顶层聚合上下文，持有 RunContext、agent 模板、
 * pipeline 以及所有已加载的 skill/artifact 模板。
 */
export function createAmberContext(params: CreateAmberContextParams): AmberContext {
    const skills = params.skills ?? new Map<string, ParsedSkill>();
    const artifactTemplates =
        params.artifactTemplates ?? new Map<string, ParsedArtifactTemplate>();

    const assembleAgentInput = (phaseId: string): CamelAgentInput => {
        return buildPhaseAgentInput(
            params.runContext,
            params.parsedAgent,
            params.pipeline,
            skills,
            phaseId,
            artifactTemplates,
        );
    };

    return {
        runContext: params.runContext,
        parsedAgent: params.parsedAgent,
        pipeline: params.pipeline,
        skills,
        artifactTemplates,
        assembleAgentInput,
    };
}

// ---------------------------------------------------------------------------
// CamelAgentInput 组装
// ---------------------------------------------------------------------------

/**
 * 将 RunContext + ParsedMd + Phase 组装为 CamelAgentInput。
 *
 * 映射规则：
 * - goal                  → phase.goal (回退至 parsedAgent 推断)
 * - sessionId             → runContext.sessionId
 * - providerId            → phase.model?.provider ?? parsedAgent.model.provider
 * - modelId               → phase.model?.name ?? parsedAgent.model.name
 * - roleDirectives        → parsedAgent.directives (flattened)
 *                           + ## Skills (skill 摘要)
 *                           + ## Artifact Templates (artifact 模板锚点)
 *                           + ## Upstream Artifacts (已完成阶段的产物路径)
 * - targetDirectory       → runContext.repoPath
 * - puebloPath            → runContext.puebloPath
 * - skillPath             → runContext.skillPath
 * - additionalPrompts     → 来自 CLI --extra-prompt 参数及 pipeline 配置
 * - callbacks / signal    → 由上层运行时注入
 * - maxSteps / budgetStrategy / budgetLimit → 默认值
 *
 * Gap 4: Phase 级别字段覆盖 (model/provider/goal/overrideTemplate/skills)
 * Gap 1: Skill 摘要从 additionalPrompts 移入 roleDirectives
 * Gap 3: Artifact 模板锚点注入 roleDirectives
 * Gap 5: 已完成 Phase 的产物路径注入 roleDirectives
 */
// ==========================================================================
// ResolvedAmberContext — filesystem-resolved amber context
// ==========================================================================

export interface ResolvedAmberContext {
    runContext: RunContext;
    agentTemplate: ParsedMd;
    pipeline: PipelineDefinition;
    skills: Map<string, ParsedSkill>;
    artifactTemplates: Map<string, ParsedArtifactTemplate>;
}

//---------------------------------------------------------------------------
// 3-arg convenience overload: build from a resolved context object
//---------------------------------------------------------------------------
export function buildPhaseAgentInput(
    phase: Phase,
    context: ResolvedAmberContext,
    phaseDir: string,
): CamelAgentInput;

//---------------------------------------------------------------------------
// 5-6 arg main signature: artifactTemplates is optional (defaults to empty)
//---------------------------------------------------------------------------
export function buildPhaseAgentInput(
    runContext: RunContext,
    parsedAgent: ParsedMd,
    pipeline: PipelineDefinition,
    skills: Map<string, ParsedSkill>,
    phaseId: string,
    artifactTemplates?: Map<string, ParsedArtifactTemplate>,
): CamelAgentInput;

//---------------------------------------------------------------------------
// Implementation
//---------------------------------------------------------------------------
export function buildPhaseAgentInput(
    arg1: RunContext | Phase,
    arg2: ParsedMd | ResolvedAmberContext,
    arg3: PipelineDefinition | string,
    arg4?: Map<string, ParsedSkill>,
    arg5?: string,
    arg6?: Map<string, ParsedArtifactTemplate>,
): CamelAgentInput {
    // 3-arg convenience form: (phase, context, phaseDir)
    // Discriminate by checking that arg1 has an `id` (Phase) and arg4 is undefined
    if ((arg1 as Phase).id !== undefined && arg4 === undefined) {
        const phase = arg1 as Phase;
        const ctx = arg2 as ResolvedAmberContext;
        const phaseDir = arg3 as string;
        return buildPhaseAgentInput(
            ctx.runContext,
            ctx.agentTemplate,
            ctx.pipeline,
            ctx.skills,
            phaseDir,
            ctx.artifactTemplates,
        );
    }

    // 5-6 arg form
    const runContext = arg1 as RunContext;
    const parsedAgent = arg2 as ParsedMd;
    const pipeline = arg3 as PipelineDefinition;
    const skills = arg4!;
    const phaseId = arg5!;
    const artifactTemplates = arg6 ?? new Map();
    const phase = pipeline.phases.find((p) => p.id === phaseId);
    if (!phase) {
        throw new Error(`Phase not found in pipeline: ${phaseId}`);
    }

    // Gap 4: overrideTemplate 处理 — 如果 phase 指定了覆盖模板，重新解析
    let directives = parsedAgent.directives;
    if (phase.overrideTemplate) {
        const overrideParsed = parseAgentMdFile(
            path.resolve(runContext.puebloPath, phase.overrideTemplate),
        );
        directives = overrideParsed.directives;
    }

    // Gap 4: phase.model 覆盖 providerId / modelId
    const providerId = phase.model?.provider ?? parsedAgent.model.provider;
    const modelId = phase.model?.name ?? parsedAgent.model.name;

    // Gap 4: goal 覆盖 — phase.goal 优先，否则回退到模板 directives.goal
    const goal = phase.goal ?? directives.goal.join('\n');

    // Gap 4: resolvePhaseSkills — 按 phase.skills 名称数组过滤全量 skill Map
    const resolvedSkills = resolvePhaseSkills(phase.skills, skills);

    // 构建 roleDirectives：基础指令 + 注入段
    const roleDirectives: string[] = [
        ...directives.role,
        ...directives.goal,
        ...directives.constraint,
        ...directives.style,
    ];

    // Gap 1: Skill 摘要移入 roleDirectives 的 ## Skills 段
    if (resolvedSkills.length > 0) {
        roleDirectives.push('## Skills');
        for (const skill of resolvedSkills) {
            roleDirectives.push(`- ${skill.name}: ${skill.summary}`);
        }
    }

    // Gap 3: Artifact 模板锚点注入 roleDirectives 的 ## Artifact Templates 段
    if (artifactTemplates.size > 0) {
        roleDirectives.push('## Artifact Templates');
        for (const [, template] of artifactTemplates) {
            for (const section of template.sections) {
                roleDirectives.push(
                    section.replace(/\{\{ANCHOR\}\}/g, `{{${template.anchor}}}`),
                );
            }
        }
    }

    // Gap 5: 阶段间 Artifact 路径传递 — 注入已完成阶段的产物路径
    const upstreamPaths: string[] = [];
    for (const depId of phase.dependsOn) {
        const result = runContext.completedPhases.get(depId);
        if (result) {
            upstreamPaths.push(
                ...result.artifacts.map((a) =>
                    path.relative(runContext.repoPath, a),
                ),
            );
        }
    }
    if (upstreamPaths.length > 0) {
        roleDirectives.push('## Upstream Artifacts');
        for (const p of upstreamPaths) {
            roleDirectives.push(`- ${p}`);
        }
    }

    // additionalPrompts 仅保留用户额外 prompts
    // (prompt:* 前缀块来自 agent 模板解析，暂存至此处供扩展)
    const additionalPrompts: string[] = [...runContext.additionalPrompts];

    return {
        goal,
        sessionId: runContext.sessionId,
        providerId,
        modelId,
        maxSteps: 48,
        budgetStrategy: 'fixed',
        budgetLimit: 48,
        roleDirectives,
        targetDirectory: runContext.repoPath,
        puebloPath: runContext.puebloPath,
        skillPath: runContext.skillPath,
        additionalPrompts,
    };
}

// ---------------------------------------------------------------------------
// Skill 路径解析
// ---------------------------------------------------------------------------

/**
 * 根据 skill 名称/路径查找 ParsedSkill。
 * 支持策略：
 * 1. 在 skills Map 中精确匹配
 * 2. 在 skillPath 目录下匹配 <name>/SKILL.md
 */
function resolveSkillPath(
    skillName: string,
    skills: Map<string, ParsedSkill>,
    skillPath: string,
): ParsedSkill | undefined {
    // 策略 1：Map 中精确匹配
    const direct = skills.get(skillName);
    if (direct) return direct;

    // 策略 2：遍历 Map 按名称匹配
    for (const [, skill] of skills) {
        if (skill.name === skillName) return skill;
    }

    return undefined;
}

// ==========================================================================
// resolveAmberContext — 从文件系统读取并解析完整的 Amber 上下文
// ==========================================================================

/**
 * 从文件系统读取 pipeline.yaml、agent 模板、skill 文件和 artifact 模板，
 * 组装为完整的 ResolvedAmberContext。
 *
 * 这是配置驱动流程的入口函数：一次读取，多次使用。
 */
export function resolveAmberContext(args: {
    pipelinePath: string;
    agentTemplatePath: string;
    skillsDir: string;
    artifactsDir: string;
    runContext: RunContext;
}): ResolvedAmberContext {
    const pipeline = parsePipelineYamlFile(args.pipelinePath);
    const agentTemplate = parseAgentMdFile(args.agentTemplatePath);
    const skills = discoverSkills(args.skillsDir);
    const artifactTemplates = discoverArtifactTemplates(args.artifactsDir);

    return {
        pipeline,
        agentTemplate,
        skills,
        artifactTemplates,
        runContext: args.runContext,
    };
}
