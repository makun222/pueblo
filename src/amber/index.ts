// ============================================================================
// Amber — Multi-Phase Agent Pipeline Runner
// ============================================================================

// 核心类型
export type {
    ParsedMd,
    ParsedSkill,
    ParsedArtifactTemplate,
    PhaseResult,
    RunContext,
    Phase,
    PipelineDefinition,
    AmberContext,
    AmberRunArgs,
} from './amber-types.js';

// 上下文
export {
    createRunContext,
    createAmberContext,
    buildPhaseAgentInput,
    resolveAmberContext,
} from './amber-context.js';

// Pipeline
export {
    parsePipelineYaml,
    parsePipelineYamlFile,
    schedulePhases,
    collectUpstreamArtifacts,
} from './pipeline.js';

// 解析器
export { parseAgentMd, parseAgentMdFile } from './parsers/agent-template-parser.js';
export { parseSkillMd, parseSkillMdFile } from './parsers/skill-parser.js';
export {
    parseArtifactTemplate,
    parseArtifactTemplateFile,
} from './parsers/artifact-template-parser.js';

// 模板发现
export {
    discoverSkills,
    discoverArtifactTemplates,
    resolveArtifactTemplate,
} from './template-resolver.js';

// CLI
export { parseCliArgs, buildAmberRunContext, amberRun, amberInit } from './cli.js';
export { generatePipeline } from './pipeline-generator.js';
export type {
    GeneratePipelineOptions,
    GeneratePipelineResult,
} from './pipeline-generator.js';
