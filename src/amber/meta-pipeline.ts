import type {
    Phase,
    PipelineConfig,
    PipelineDefinition,
} from './amber-types.js';

/**
 * 内置 Meta-Pipeline：2 个 Phase 自举生成新 pipeline。
 *
 * Phase 1 "analyze"  — Agent 理解需求 → 调研代码库 → 输出 analysis JSON
 * Phase 2 "generate" — Agent 读取分析结果 → 生成标准 pipeline.yaml
 */
export const META_PIPELINE: PipelineConfig = {
    pipeline: {
        name: 'amber-init-meta',
        version: '1.0.0',
        description: 'Meta-Pipeline 从用户需求生成 Amber 可执行的 pipeline.yaml',
        outputDir: '.amber/init',
    },
    phases: {
        analyze: {
            description: '分析用户需求和代码库，设计 pipeline 结构',
            prompt: [
                '你是 Amber Pipeline Designer。分析以下需求并输出 JSON：',
                '',
                '{',
                '  "taskType": "code-generation|refactoring|testing",',
                '  "phases": [',
                '    {',
                '      "id": "phase-1",',
                '      "name": "...",',
                '      "goal": "...",',
                '      "skills": ["..."]',
                '    }',
                '  ]',
                '}',
            ].join('\n'),
            input: {
                files: ['.amber/init/requirement.md'],
            },
            output: {
                type: 'file',
                path: '.amber/init/analysis.json',
            },
        },
        generate: {
            description: '从 analysis.json 生成标准 pipeline.yaml',
            prompt: [
                '你是 Amber Pipeline Generator。根据 analysis.json 生成 pipeline.yaml：',
                '',
                '```yaml',
                'version: "1.0"',
                'name: <pipeline-name>',
                'phases:',
                '  - id: <id>',
                '    name: <name>',
                '    goal: <goal>',
                '    skills:',
                '      - <skill>',
                '```',
            ].join('\n'),
            input: {
                files: ['.amber/init/analysis.json'],
            },
            output: {
                type: 'file',
                path: '.amber/init/pipeline.yaml',
            },
        },
    },
    dependencies: {
        generate: ['analyze'],
    },
};

/**
 * 将 PipelineConfig（清单格式）转换为 PipelineDefinition（YAML 序列化格式）。
 * PipelineDefinition 是 parsePipelineYaml 的输出类型，也是 runPipeline 的输入格式。
 */
export function toPipelineDefinition(
    config: PipelineConfig,
): PipelineDefinition {
    const phases: Phase[] = [];
    for (const [name, phase] of Object.entries(config.phases)) {
        const deps = config.dependencies?.[name] ?? [];
        phases.push({
            id: name,
            name,
            goal: phase.prompt ?? '',
            skills: [],
            dependsOn: deps,
            artifactTemplates: [],
            ...(phase.output ? { output: phase.output } : {}),
        });
    }
    return {
        version: config.pipeline.version ?? '1.0.0',
        name: config.pipeline.name,
        phases,
    };
}
