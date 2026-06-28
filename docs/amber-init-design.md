# amber init — 需求到 Pipeline 自动生成

## 1. 概述

### 1.1 目标

`amber init` 是一个新的 CLI 子命令，将自然语言需求（一句话或文档）作为输入，自动生成 `pipeline.yaml` 并驱动 Amber 执行。

### 1.2 使用场景

```bash
# 一句话需求
npx amber init --requirement "设计一个即时贴功能，支持 save/list/edit"

# 说明文件
npx amber init --spec ./specs/sticky-note.md

# 指定输出目录
npx amber init --requirement "重构登录模块" --output-dir ./my-pipeline

# 生成并立即执行
npx amber init --requirement "修复暗色模式下的文字颜色" --run
```

## 2. 现有架构回顾

### 2.1 Amber 完整链路

```
pipeline.yaml → PipelineConfig → resolveAmberContext → 逐 Phase 驱动 Agent → 产物
```

| 组件 | 文件 | 职责 |
|------|------|------|
| 类型定义 | `amber-types.ts` | `PipelineConfig`、`PhaseConfig`、`AgentInput`、`ParsedSkill` 等 |
| Pipeline 解析 | `pipeline.ts` | `parsePipelineYaml()`：YAML 文本 → `PipelineConfig` |
| 上下文解析 | `amber-context.ts` | `resolveAmberContext()`：解析 Phase，收集 Skill/模板，构建 AgentInput |
| 模板解析器 | `template-resolver.ts` | `discoverSkills()`、`discoverArtifactTemplates()` |
| CLI | `cli.ts` | `amber run --pipeline` 入口 |
| 公开 API | `index.ts` | 导出 `resolveAmberContext`、`buildPhaseAgentInput`、`runPipeline` |

### 2.2 Pipeline YAML 格式

```yaml
version: "1.0"
workDir: "."
defaultSkillsDir: "./skills"
phases:
  - id: design
    goal: "设计数据模型与组件树"
    inputs:
      - "需求分析结果"
    skills:
      - "context-discipline"
      - "execution-discipline"
    artifactTemplates:
      - "task-stream-a"
  - id: implement
    goal: "按任务书逐步实现"
    inputs:
      - "design 阶段的产物"
```

### 2.3 关键类型

```typescript
interface PhaseConfig {
  id: string;
  goal: string;
  inputs?: string[];
  skills?: string[];
  artifactTemplates?: string[];
  inputPaths?: string[];  // 来自之前 Phase 的产物路径
}

interface PipelineConfig {
  version: string;
  workDir?: string;
  defaultSkillsDir?: string;
  phases: PhaseConfig[];
}
```

### 2.4 现有 CLI 结构

```typescript
// cli.ts 当前支持的子命令
case 'run':    // amber run --pipeline <path> ...
case 'list':   // amber list --skills-dir <path>
```

## 3. 设计方案

### 3.1 核心策略：Meta-Pipeline 自举

Amber 自身就是 Agent 驱动系统。`amber init` 的策略是**用 Amber 的 Agent 编排能力来生成 Pipeline**——即创建一个内置的 "meta-pipeline"，其 Phase goal 是"分析需求并生成 pipeline.yaml"。

```
用户需求
    │
    ▼
amber init CLI
    │
    ├── 解析参数（--requirement | --spec）
    ├── 组装 Meta-Pipeline（内置，不外露给用户）
    ├── 构建 AmberContext
    ├── 驱动 Agent 执行 Meta-Pipeline
    │       │
    │       ├── Phase 1: analyze — 分析需求、调研代码库
    │       └── Phase 2: generate — 生成 pipeline.yaml
    │
    └── 输出 pipeline.yaml 到目标目录
           │
           └── (可选) run — 调用 amber run 执行生成的 pipeline
```

### 3.2 新增文件

| 文件 | 职责 |
|------|------|
| `src/amber/pipeline-generator.ts` | `generatePipeline()`：组装 Meta-Pipeline → 驱动 Agent → 生成 pipeline.yaml |
| `src/amber/meta-pipeline.ts` | 内置 Meta-Pipeline 定义（无需外部 YAML 文件） |

### 3.3 修改文件

| 文件 | 变更 |
|------|------|
| `src/amber/cli.ts` | 新增 `init` 子命令处理 |
| `src/amber/index.ts` | 导出 `generatePipeline` |

### 3.4 不需要修改的文件

- `amber-types.ts` — 现有类型已足够
- `pipeline.ts` — 生成的是标准 YAML，解析路径不变
- `amber-context.ts` — Meta-Pipeline 复用现有 `resolveAmberContext`
- `template-resolver.ts` — 不需要变更

## 4. 详细设计

### 4.1 CLI 接口

```typescript
// cli.ts 新增
case 'init': {
  const initArgs = parseInitArgs(rawArgs);
  // initArgs: { requirement?: string; spec?: string; outputDir?: string; run: boolean; model?: string }
  const result = await runInitCommand(initArgs);
  console.log(`Pipeline generated: ${result.pipelinePath}`);
  if (initArgs.run) {
    await runPipeline(result.pipelinePath, { model: initArgs.model });
  }
}
```

### 4.2 参数解析

```typescript
interface InitArgs {
  requirement?: string;   // --requirement "..." 或位置参数
  spec?: string;          // --spec <path>
  outputDir?: string;     // --output-dir <path>，默认 generated-pipelines/<slug>
  run: boolean;           // --run
  model?: string;         // --model
  workDir?: string;       // --work-dir
}
```

互斥：`--requirement` 和 `--spec` 二选一，至少提供一个。

### 4.3 Meta-Pipeline 定义

内置在 `meta-pipeline.ts` 中：

```typescript
export const META_PIPELINE: PipelineConfig = {
  version: "1.0",
  phases: [
    {
      id: "analyze",
      goal: [
        "## 任务：分析需求并准备 Pipeline 生成计划",
        "",
        "你将收到一个用户需求。请完成以下步骤：",
        "",
        "### 第一步：理解需求",
        "- 阅读并理解用户需求的核心目标",
        "- 识别需求涉及的功能模块、文件范围",
        "- 判断需求类型：新增功能 / 修复缺陷 / 重构优化",
        "",
        "### 第二步：调研代码库",
        "- 使用 glob/grep 工具了解现有代码结构和可参考的模式",
        "- 识别与需求相关的现有文件和模块",
        "- 找出可以复用的代码模式",
        "",
        "### 第三步：制定 Phase 分解计划",
        "- 将需求拆解为 2-4 个有顺序依赖的 Phase",
        "- 每个 Phase 应产出明确、可验证的中间产物",
        "- Phase 之间通过 inputPaths 传递上下文",
        "",
        "### 输出格式",
        "输出一个 JSON 对象，包含：",
        "- type: 'new-feature' | 'bug-fix' | 'refactor'",
        "- summary: 需求的一句话总结",
        "- slug: 用于输出目录的短名（英文，kebab-case）",
        "- phases: 每个 Phase 的 { id, goal, skillHints, artifactTemplateHints }",
        "",
        "输出时用 ```json ... ``` 包裹。"
      ].join("\n"),
      skills: ["context-discipline", "execution-discipline"],
    },
    {
      id: "generate",
      goal: [
        "## 任务：生成 pipeline.yaml",
        "",
        "根据上一阶段的分析结果，生成一个符合 Amber 规范的 pipeline.yaml 文件。",
        "",
        "### 要求",
        "- 使用标准 YAML 格式（version, workDir, defaultSkillsDir, phases）",
        "- workDir 设为 '.'",
        "- defaultSkillsDir 设为 './skills'",
        "- 每个 Phase 必须包含：id, goal, skills, artifactTemplates",
        "- skills 必须包含 'context-discipline' 和 'execution-discipline'",
        "- 根据分析结果的 skillHints 添加额外 skills",
        "- 根据分析结果的 artifactTemplateHints 添加 artifactTemplates",
        "- 如果分析结果未指定 artifactTemplates，默认使用 'task-stream-a'",
        "- Phase 之间通过 inputs 字段引用前一 Phase 的 ID",
        "",
        "### 输出",
        "将 pipeline.yaml 写入输出目录。不要用代码块包裹——直接输出 YAML 到文件。"
      ].join("\n"),
      skills: ["context-discipline", "execution-discipline"],
      inputs: ["analyze 阶段的分析结果（JSON）"],
    },
  ],
};
```

### 4.4 PipelineGenerator 实现

```typescript
// src/amber/pipeline-generator.ts

import { resolveAmberContext, buildPhaseAgentInput } from './amber-context.js';
import { META_PIPELINE } from './meta-pipeline.js';
import type { PipelineConfig, AgentInput } from './amber-types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface GenerateOptions {
  requirement: string;           // 需求文本（一句话或文档内容）
  outputDir: string;             // 输出目录
  model?: string;
  skillsDir?: string;            // Skill 目录，默认为项目 skills/
  workDir?: string;
}

interface GenerateResult {
  pipelinePath: string;          // 生成的 pipeline.yaml 路径
  config: PipelineConfig;        // 解析后的配置
  outputDir: string;
}

export async function generatePipeline(
  options: GenerateOptions
): Promise<GenerateResult> {
  // 1. 确保输出目录存在
  fs.mkdirSync(options.outputDir, { recursive: true });

  // 2. 构建 Meta-Pipeline 的 Phase 上下文
  //    Phase 0 (analyze) 的 prompt 中包含用户需求
  const pipeline: PipelineConfig = {
    ...META_PIPELINE,
    workDir: options.workDir || '.',
    defaultSkillsDir: options.skillsDir || './skills',
  };

  // 3. 将用户需求作为额外上下文注入到第一个 Phase
  //    通过在 Phase goal 中嵌入需求文本
  const enrichedPipeline: PipelineConfig = {
    ...pipeline,
    phases: pipeline.phases.map((phase, idx) => {
      if (idx === 0) {
        return {
          ...phase,
          goal: `## 用户需求\n\n${options.requirement}\n\n---\n\n${phase.goal}`,
        };
      }
      return phase;
    }),
  };

  // 4. 运行 Meta-Pipeline
  const result = await resolveAmberContext(enrichedPipeline, {
    model: options.model,
  });

  // 5. 从产物中提取 pipeline.yaml
  //    Phase 'generate' 的产物应包含 pipeline.yaml
  const pipelinePath = path.join(options.outputDir, 'pipeline.yaml');

  // 查找生成的 pipeline.yaml 并移动到目标位置
  // （如果 Agent 直接写入目标路径则无需移动）
  const config = await parsePipelineYaml(
    fs.readFileSync(pipelinePath, 'utf-8')
  );

  return { pipelinePath, config, outputDir: options.outputDir };
}
```

### 4.5 与现有 `resolveAmberContext` 的交互

关键问题是：`resolveAmberContext` 当前期望 Agent 将产物写入文件系统。对于 Meta-Pipeline，Phase "generate" 的产物就是 `pipeline.yaml`。

`resolveAmberContext` 的 Phase 处理流程：
1. 为每个 Phase 构建 `AgentInput`
2. 调用 Agent（由 `agent-sdk` 驱动）
3. Agent 执行 goal，可能创建文件
4. 后续 Phase 可以通过 `inputPaths` 访问前序 Phase 的产物

对于 Meta-Pipeline，Phase "generate" 需要：
- 读取 Phase "analyze" 的分析结果
- 生成 pipeline.yaml 到输出目录

这完全符合现有的 Phase 编排模型。

## 5. 数据流

```
用户输入（--requirement / --spec）
    │
    ▼
cli.ts: parseInitArgs()
    │
    ▼
pipeline-generator.ts: generatePipeline()
    │
    ├── 1. 构建 enrichedPipeline（META_PIPELINE + 用户需求注入）
    │
    ├── 2. resolveAmberContext(enrichedPipeline, options)
    │       │
    │       ├── Phase "analyze":
    │       │   Agent → 分析需求 → 调研代码库 → 输出分析 JSON
    │       │
    │       └── Phase "generate":
    │           Agent → 读取分析结果 → 生成 pipeline.yaml
    │
    ├── 3. 验证：npx tsc --noEmit（可选，验证产物合法性）
    │
    └── 4. 返回 { pipelinePath, config }
              │
              ▼
        (可选) amber run --pipeline <path>
```

## 6. 输出目录约定

默认输出目录：`generated-pipelines/<slug>/`

```
generated-pipelines/
└── sticky-note/
    ├── pipeline.yaml          ← 主产物
    └── .amber/                ← Amber 运行日志/中间产物
```

`<slug>` 由分析阶段的 Agent 确定（基于需求的 kebab-case 短名），或退化为时间戳。

## 7. 错误处理

| 场景 | 处理 |
|------|------|
| 无 --requirement 且无 --spec | 显示 help，退出码 1 |
| --spec 文件不存在 | 报错 "Spec file not found: <path>" |
| Agent 执行失败 | 保留已生成的中间产物，输出错误信息 |
| pipeline.yaml 生成失败 | 报错 "Pipeline generation failed"，保留日志 |
| 输出目录已存在 | 询问覆盖或追加序号（如 `sticky-note-2`） |

## 8. 实现步骤

### Step 1: 创建 `meta-pipeline.ts`
- 定义 `META_PIPELINE` 常量
- 两个 Phase: analyze + generate

### Step 2: 创建 `pipeline-generator.ts`
- 实现 `generatePipeline()` 函数
- 参数校验 → Meta-Pipeline 构建 → Agent 驱动 → 产物收集

### Step 3: 修改 `cli.ts`
- 新增 `init` case
- 实现 `parseInitArgs()` 参数解析
- 调用 `generatePipeline()` + 可选 `runPipeline()`

### Step 4: 修改 `index.ts`
- 导出 `generatePipeline`

### Step 5: 验证
- `npx tsc --noEmit` 通过
- 端到端测试：一句话需求生成 pipeline 并执行

## 9. 风险评估

| 风险 | 缓解措施 |
|------|---------|
| Agent 生成的 pipeline 质量不稳定 | Meta-Pipeline 的 goal 说明详细、结构化要求明确 |
| 代码库调研可能不充分 | analyze Phase 明确要求使用 glob/grep 工具 |
| Phase 拆分不合理 | goal 中包含常见需求类型的 Phase 模板提示 |
| Agent 调用成本 | Meta-Pipeline 只有 2 个 Phase，成本可控 |

## 10. 未来扩展

- **交互式确认**：生成 pipeline 后展示计划，用户确认后再执行
- **模板库**：积累常见需求类型的 pipeline 模板（CRUD、重构、Bug 修复）
- **`--ref` 参数**：支持引用现有代码模式（如 `--ref clock-window.ts`）
- **增量迭代**：`amber init --resume` 基于已有 pipeline 继续迭代
