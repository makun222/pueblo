// ============================================================================
// amber-types.ts — Amber 核心类型定义
// ============================================================================

import type { CamelAgentInput, CamelStatus } from '../agent/camel/camel-types.js';

// ---------------------------------------------------------------------------
// 解析器输出类型
// ---------------------------------------------------------------------------

/** agent.md 解析结果 */
export interface ParsedMd {
    /** 指令集（角色/目标/约束/风格） */
    directives: {
        role: string[];
        goal: string[];
        constraint: string[];
        style: string[];
    };
    /** 完整的系统提示词（构建后的字符串） */
    systemPrompt: string;
    /** 模型配置 */
    model: {
        provider: string;
        name: string;
    };
}

/** SKILL.md 解析结果 */
export interface ParsedSkill {
    /** Skill 显示名称 */
    name: string;
    /** Skill 文件路径 */
    path: string;
    /** Skill 简短描述（首行） */
    description: string;
    /** Skill 摘要（完整内容） */
    summary: string;
}

/** artifact 模板解析结果 */
export interface ParsedArtifactTemplate {
    /** 模板名称 */
    name: string;
    /** 模板段落列表 */
    sections: string[];
    /** 模板锚点（用于替换的占位符） */
    anchor: string;
}

// ---------------------------------------------------------------------------
// Phase 执行类型
// ---------------------------------------------------------------------------

/** Phase 执行产出 */
export interface PhaseResult {
    /** Phase ID */
    phaseId: string;
    /** 执行状态 */
    status: CamelStatus;
    /** 本 Phase 产出的 artifact 列表（路径） */
    artifacts: string[];
    /** Phase 摘要 */
    summary: string;
}

/** Phase 运行时环境 */
export interface RunContext {
    /** 运行唯一标识 */
    runId: string;
    /** 会话标识 */
    sessionId: string;
    /** 目标仓库根目录 */
    repoPath: string;
    /** Pueblo 框架根目录 */
    puebloPath: string;
    /** Skill 工作空间路径 */
    skillPath: string;
    /** agent 模板名称 */
    agentTemplate: string;
    /** 额外提示词 */
    additionalPrompts: string[];
    /** 模型配置 */
    model: {
        provider: string;
        name: string;
    };
    /** 已完成 Phase 的结果映射 */
    completedPhases: Map<string, PhaseResult>;
}

// ---------------------------------------------------------------------------
// Pipeline 类型
// ---------------------------------------------------------------------------

/** pipeline.yaml 中的单个 Phase */
export interface Phase {
    /** Phase 唯一标识 */
    id: string;
    /** Phase 显示名称 */
    name: string;
    /** Phase 目标描述 */
    goal: string;
    /** 关联的 Skill 列表 */
    skills: string[];
    /** 关联的 artifact 模板列表 */
    artifactTemplates: string[];
    /** 前置 Phase ID 列表 */
    dependsOn: string[];
    /** 输出配置：file 写入文件系统，variable 为变量输出 */
    output?: {
        /** Type of the phase output */
        type?: 'file' | 'variable';
        /** Path to store the output file */
        path?: string;
        /** Name for variable-type outputs */
        name?: string;
    };
    /** Phase 级别模型覆盖：provider 覆盖模板/管线默认值 */
    model?: { provider?: string; name?: string };
    /** Phase 级别模板覆盖：指定其他 agent.md 文件路径（相对于 amberDir） */
    overrideTemplate?: string;
    /** Budget strategy: 'fixed', 'adaptive', or 'unlimited' */
    budgetStrategy?: 'fixed' | 'adaptive' | 'unlimited';
    /** Budget limit (max LLM calls for 'fixed' strategy) */
    budgetLimit?: number;
}

/** pipeline.yaml 定义 */
export interface PipelineDefinition {
    /** 版本号 */
    version: string;
    /** Pipeline 名称 */
    name: string;
    /** Phase 列表（按顺序） */
    phases: Phase[];
}

// ---------------------------------------------------------------------------
// Amber 上下文（顶层聚合）
// ---------------------------------------------------------------------------

/** AmberContext：聚合 RunContext 并组装 CamelAgentInput */
export interface AmberContext {
    /** 运行上下文 */
    runContext: RunContext;
    /** 解析后的 agent 模板 */
    parsedAgent: ParsedMd;
    /** Pipeline 定义 */
    pipeline: PipelineDefinition;
    /** 已加载的 Skill（key = skill path） */
    skills: Map<string, ParsedSkill>;
    /** 已加载的 artifact 模板（key = template name） */
    artifactTemplates: Map<string, ParsedArtifactTemplate>;

    /** 将当前 Phase 的上下文组装为 CamelAgentInput */
    assembleAgentInput(phaseId: string): CamelAgentInput;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PipelineConfig — 声明式 Manifest 类型（用于 amber init 的 meta-pipeline）
// ---------------------------------------------------------------------------

/** Pipeline manifest 配置（提示词驱动，区别于 PipelineDefinition） */
export interface PipelineConfig {
    pipeline: {
        name: string;
        version?: string;
        description?: string;
        agentTemplate?: string;
        outputDir?: string;
    };
    phases: Record<string, PhaseConfig>;
    dependencies?: Record<string, string[]>;
}

/** 单个 Phase 的 manifest 配置 */
export interface PhaseConfig {
    description?: string;
    agentTemplate?: string;
    skillTemplate?: string;
    input?: PhaseInputConfig;
    output?: PhaseOutputConfig;
    prompt?: string;
}

/** Phase 输入配置 */
export interface PhaseInputConfig {
    sources?: PhaseInputSource[];
    text?: string;
    files?: string[];
}

/** Phase 输入源（来自上游 phase 的产物） */
export interface PhaseInputSource {
    phase: string;
    type?: 'diagram' | 'code' | 'specification' | 'text';
}

/** Phase 输出配置 */
export interface PhaseOutputConfig {
    type?: 'file' | 'variable';
    path?: string;
    name?: string;
}

// ---------------------------------------------------------------------------
// CLI 参数类型
// ---------------------------------------------------------------------------

/** CLI amber run 命令参数 */
export interface AmberRunArgs {
    /** 目标仓库路径 */
    repoPath: string;
    /** agent 模板名称（默认 'code-master'） */
    agentTemplate?: string;
    /** pipeline.yaml 路径 */
    pipelinePath?: string;
    /** 额外提示词 */
    extraPrompts?: string[];
}
