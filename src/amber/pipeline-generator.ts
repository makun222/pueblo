import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineDefinition } from './amber-types.js';
import { META_PIPELINE, toPipelineDefinition } from './meta-pipeline.js';

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/** generatePipeline() 的入参 */
export interface GeneratePipelineOptions {
    /** 用户需求文本（一句话或说明全文） */
    requirement: string;
    /** 输出目录，默认 .amber/init */
    outputDir?: string;
    /** 生成后是否立即执行 amber run */
    run?: boolean;
}

/** generatePipeline() 的返回值 */
export interface GeneratePipelineResult {
    /** 生成的 pipeline.yaml 路径（meta-pipeline 运行后产物，当前尚不存在） */
    pipelinePath: string;
    /** meta-pipeline.yaml 路径（立即存在，需先执行它以生成 pipeline.yaml） */
    metaPipelinePath: string;
    /** analysis.json 路径（若 meta-pipeline 生成） */
    analysisPath?: string;
    /** 需求文件路径（用于调试/审计） */
    requirementPath: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 PipelineDefinition 序列化为简易 YAML 字符串。
 * 仅处理 PipelineDefinition 已知字段，不引入第三方 YAML 库。
 */
function toYaml(def: PipelineDefinition): string {
    const lines: string[] = [];
    lines.push(`version: "${def.version}"`);
    lines.push(`name: ${def.name}`);
    lines.push('phases:');
    if (def.phases && def.phases.length > 0) {
        for (const ph of def.phases) {
            lines.push(`  - id: ${ph.id}`);
            lines.push(`    name: "${ph.name}"`);
            lines.push(`    goal: "${ph.goal}"`);
            if (ph.skills && ph.skills.length > 0) {
                lines.push('    skills:');
                for (const sk of ph.skills) {
                    lines.push(`      - ${sk}`);
                }
            }
            if (ph.dependsOn && ph.dependsOn.length > 0) {
                lines.push('    dependsOn:');
                for (const dep of ph.dependsOn) {
                    lines.push(`      - ${dep}`);
                }
            }
        }
    }
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 核心函数
// ---------------------------------------------------------------------------

/**
 * 通过 Amber Meta-Pipeline 从用户需求生成 pipeline.yaml。
 *
 * 工作流：
 * 1. 写入需求文件到 outputDir/requirement.md
 * 2. 将 meta-pipeline 转换为 PipelineDefinition 并保存为 YAML
 * 3. 返回预期产物路径（实际 AI 执行由外部 Agent 驱动或 --run 触发）
 */
export async function generatePipeline(
    options: GeneratePipelineOptions,
): Promise<GeneratePipelineResult> {
    const outputDir = path.resolve(options.outputDir ?? '.amber/init');

    // 确保输出目录存在
    fs.mkdirSync(outputDir, { recursive: true });

    // 写入需求文件
    const requirementPath = path.join(outputDir, 'requirement.md');
    fs.writeFileSync(requirementPath, options.requirement, 'utf-8');

    // 保存 meta-pipeline 定义（转换为 PipelineDefinition，序列化为 YAML）
    const pipelineDef = toPipelineDefinition(META_PIPELINE);
    const metaPipelinePath = path.join(outputDir, 'meta-pipeline.yaml');
    fs.writeFileSync(metaPipelinePath, toYaml(pipelineDef), 'utf-8');

    // 生成骨架 pipeline.yaml —— meta-pipeline 成功时会覆盖它，失败时作为兜底
    const pipelinePath = path.join(outputDir, 'pipeline.yaml');
    const skeletonPipelineDef: PipelineDefinition = {
        name: 'Skeleton Pipeline',
        version: '1.0',
        phases: [
            {
                id: 'default',
                name: 'Default Pipeline',
                goal: 'Execute the default pipeline generated from the requirement',
                skills: [],
                artifactTemplates: [],
                dependsOn: [],
            },
        ],
    };
    fs.writeFileSync(pipelinePath, toYaml(skeletonPipelineDef), 'utf-8');

    const analysisPath = path.join(outputDir, 'analysis.json');

    // run 标志由调用方（CLI）处理，此处仅做记录
    return {
        pipelinePath,
        metaPipelinePath,
        analysisPath: fs.existsSync(analysisPath) ? analysisPath : undefined,
        requirementPath,
    };
}
