// ============================================================================
// cli.ts — Amber CLI 入口（amber run 命令）
// ============================================================================

import * as path from 'node:path';
import { CamelAgent } from '../agent/camel/camel-agent.js';
import type { AmberRunArgs, PhaseResult } from './amber-types.js';
import { createRunContext, createAmberContext } from './amber-context.js';
import { parsePipelineYamlFile } from './pipeline.js';
import { parseAgentMdFile } from './parsers/agent-template-parser.js';
import { discoverSkills, discoverArtifactTemplates } from './template-resolver.js';
import type { ExecuteTurnFn } from '../agent/camel/camel-types.js';
import { generatePipeline } from './pipeline-generator.js';
import * as fs from 'node:fs';
import { amberLog } from '../utils/perf-logger.js';

const defaultExecuteTurn: ExecuteTurnFn = async () => {
    throw new Error('executeTurn not configured — no LLM provider wired');
};

// ---------------------------------------------------------------------------
// CLI 参数默认值
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_TEMPLATE = 'code-master';
const DEFAULT_PIPELINE_NAME = 'pipeline.yaml';

/**
 * 从命令行参数解析 AmberRunArgs。
 *
 * 用法示例：
 *   amber run --repo-path ./my-project --agent-template code-master --pipeline pipeline.yaml
 *
 * 支持的参数：
 *   --repo-path         目标仓库根目录（必填）
 *   --agent-template    agent 模板名称（默认 code-master）
 *   --pipeline-path     自定义 pipeline 文件路径
 *   --extra-prompt      额外提示词（可重复）
 */
export function parseCliArgs(rawArgs: string[]): AmberRunArgs {
    const args: AmberRunArgs = {
        repoPath: '',
        agentTemplate: DEFAULT_AGENT_TEMPLATE,
        pipelinePath: undefined,
        extraPrompts: [],
    };

    let i = 0;
    while (i < rawArgs.length) {
        const arg = rawArgs[i];
        switch (arg) {
            case '--repo-path':
                args.repoPath = rawArgs[++i] ?? '';
                break;
            case '--agent-template':
                args.agentTemplate = rawArgs[++i] ?? DEFAULT_AGENT_TEMPLATE;
                break;
            case '--pipeline-path':
            case '--pipeline':
                args.pipelinePath = rawArgs[++i];
                break;
            case '--extra-prompt':
                args.extraPrompts = args.extraPrompts ?? [];
                args.extraPrompts.push(rawArgs[++i] ?? '');
                break;
            default:
                // 跳过未知参数
                break;
        }
        i++;
    }

    return args;
}

// ---------------------------------------------------------------------------
// run 命令上下文构建
// ---------------------------------------------------------------------------

interface AmberRunOptions {
    /** 当前进程工作目录（通常为 Pueblo 根） */
    puebloPath: string;
    /** CLI 解析后的参数 */
    cliArgs: AmberRunArgs;
}

/**
 * 根据 CLI 参数和 Pueblo 路径构建完整的 AmberContext。
 *
 * 执行步骤：
 * 1. 解析 CLI 参数
 * 2. 解析 agent.md 模板
 * 3. 解析 pipeline.yaml
 * 4. 发现并加载 Skills
 * 5. 发现并加载 Artifact 模板
 * 6. 构建 RunContext
 * 7. 返回 AmberContext
 */
export function buildAmberRunContext(options: AmberRunOptions) {
    const { puebloPath, cliArgs } = options;

    const repoPath = path.resolve(puebloPath, cliArgs.repoPath);
    // 解析 agent 模板
    const agentTemplateDir = path.join(
        puebloPath,
        '.amber',
        'agent-template',
        cliArgs.agentTemplate ?? DEFAULT_AGENT_TEMPLATE,
    );
    const skillPath = puebloPath;
    const agentMdPath = path.join(agentTemplateDir, 'agent.md');
    const parsedAgent = parseAgentMdFile(agentMdPath);

    // 解析 pipeline
    const pipelinePath = cliArgs.pipelinePath
        ? path.resolve(puebloPath, cliArgs.pipelinePath)
        : path.join(puebloPath, DEFAULT_PIPELINE_NAME);
    const pipeline = parsePipelineYamlFile(pipelinePath);

    // 发现 Skills
    const skills = discoverSkills(skillPath);

    // 发现 Artifact 模板
    const artifactTemplateDir = path.join(
        puebloPath,
        '.amber',
        'artifacts',
    );
    const artifactTemplates = discoverArtifactTemplates(artifactTemplateDir);

    // 构建 RunContext
    const runId = `amber-${Date.now()}`;
    const runContext = createRunContext({
        runId,
        sessionId: runId,
        repoPath,
        puebloPath,
        skillPath,
        agentTemplate: cliArgs.agentTemplate ?? DEFAULT_AGENT_TEMPLATE,
        additionalPrompts: cliArgs.extraPrompts,
        model: parsedAgent.model,
    });

    // 构建 AmberContext
    const amberContext = createAmberContext({
        runContext,
        parsedAgent,
        pipeline,
        skills,
        artifactTemplates,
    });

    return amberContext;
}

/**
 * amber run 命令入口 —— 按拓扑顺序依次执行 Pipeline 中的每个 Phase。
 */
// ============================================================================
// amber init 子命令 — 从需求生成 pipeline.yaml
// ============================================================================

interface InitArgs {
    requirement?: string;
    spec?: string;
    output?: string;
    run: boolean;
}

function parseInitArgs(rawArgs: string[]): InitArgs {
    const args = rawArgs.slice(1); // skip 'init'
    const result: InitArgs = { run: false };

    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        switch (arg) {
            case '--requirement':
            case '-r':
                result.requirement = args[++i] ?? '';
                break;
            case '--spec':
            case '-s':
                result.spec = args[++i] ?? '';
                break;
            case '--output':
            case '-o':
                result.output = args[++i] ?? '';
                break;
            case '--run':
                result.run = true;
                break;
            default:
                break;
        }
        i++;
    }

    return result;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

export async function amberInit(rawArgs: string[], executeTurn?: ExecuteTurnFn): Promise<void> {
    const args = parseInitArgs(rawArgs);

    let requirement: string;
    if (args.requirement) {
        requirement = args.requirement;
    } else if (args.spec) {
        requirement = fs.readFileSync(args.spec, 'utf-8');
    } else {
        console.error('Error: --requirement or --spec is required');
        process.exit(1);
    }

    const outputDir =
        args.output ??
        path.join(process.cwd(), 'generated-pipelines', slugify(requirement));

    console.log(
        `Generating pipeline for: "${requirement.slice(0, 80)}${requirement.length > 80 ? '...' : ''}"`,
    );
    console.log(`Output: ${outputDir}`);

    const result = await generatePipeline({ requirement, outputDir });

    console.log(`✓ Pipeline generated: ${result.pipelinePath}`);

    if (args.run) {
        console.log('\nRunning generated pipeline...\n');
        // 运行 meta-pipeline（而不是骨架 pipeline.yaml），由 meta-pipeline 产出真正的 pipeline.yaml
        amberLog('info',`amberInit.runMetaPipeline,metaPipelinePath:${ result.metaPipelinePath }, pipelinePath:${ result.pipelinePath }`);
        await amberRun(['run', '--pipeline', result.metaPipelinePath], executeTurn);
    }
}

// ============================================================================
// amber run 子命令 — 执行现有 pipeline.yaml
// ============================================================================

export async function amberRun(rawArgs: string[], executeTurn?: ExecuteTurnFn): Promise<Record<string, PhaseResult>> {
    const cliArgs = parseCliArgs(rawArgs);

    if (!cliArgs.repoPath) {
        throw new Error('Missing required argument: --repo-path');
    }

    const runLog = (msg: string) => { console.log(msg); amberLog('info', msg); };
    const runLogErr = (msg: string) => { console.log(msg); amberLog('error', msg); };

    const puebloPath = process.cwd();
    const amberContext = buildAmberRunContext({ puebloPath, cliArgs });

    // 按依赖顺序调度 Phase
    const { schedulePhases } = await import('./pipeline.js');
    const orderedPhases = schedulePhases(amberContext.pipeline.phases);

    runLog(`[amber] Pipeline "${amberContext.pipeline.name}" loaded`);
    runLog(
        `[amber] Phases (order): ${orderedPhases.map((p) => p.id).join(' → ')}`,
    );
    runLog(`[amber] Agent template: ${amberContext.runContext.agentTemplate}`);
    runLog(`[amber] Repo path: ${amberContext.runContext.repoPath}`);
    runLog(`[amber] Skills loaded: ${amberContext.skills.size}`);
    runLog(`[amber] Artifact templates loaded: ${amberContext.artifactTemplates.size}`);

    const results: Record<string, PhaseResult> = {};
    const { runContext } = amberContext;

    for (const phase of orderedPhases) {
        runLog(`[amber:phase] Starting '${phase.id}' ...`);

        // 1. 组装阶段 Agent 输入（含上游产物路径、模型覆盖）
        const agentInput = amberContext.assembleAgentInput(phase.id);

        // 2. 创建 CamelAgent 并执行
        amberLog('info',`amberRun.camelCreate,phaseId:${ phase.id }, goal:${ phase.goal }, sessionId:${ agentInput.sessionId }`);
        const camel = new CamelAgent(agentInput, executeTurn ?? defaultExecuteTurn);
        const report = await camel.start();
        amberLog('info',`amberRun.camelReport,phaseId:${ phase.id }, status:${ report.status }, totalSteps:${ report.totalSteps }, resultLength:${ report.result?.length ?? 0 }, resultPreview:${ (report.result ?? '').substring(0, 200) }, error:${ report.error?.message }`);
     

        // 3. 记录阶段结果
        results[phase.id] = {
            phaseId: phase.id,
            status: report.status === 'completed' ? 'completed' : 'failed',
            artifacts: report.result ? [report.result] : [],
            summary: report.error?.message ?? report.result ?? '',
        };

        // 4. 更新 runContext，供下游阶段注入产物路径
        runContext.completedPhases.set(phase.id, results[phase.id]);

        if (report.status !== 'completed') {
            runLogErr(`[amber:error] Phase '${phase.id}' failed: ${report.error?.message}`);
            return results;
        }

        runLog(`[amber:phase] '${phase.id}' completed in ${report.totalSteps} steps.`);
    }

    runLog('[amber:info] All phases completed successfully.');
    return results;
}
