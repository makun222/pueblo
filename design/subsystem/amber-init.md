# Amber Init Design — Pipeline Generator 设计方案

> 🔄 迁移中 — 源位置: `docs/amber-init-design.md`

## 1. 背景

`pipeline.yaml` 是 Amber 多步骤工作流的配置核心，但手动编写繁琐且门槛高。本方案设计一个 **Pipeline Generator**，用户只需提供一句话需求或需求文档，即可自动生成可执行的 `pipeline.yaml`。

---

## 2. 用户故事

**作为** Pueblo 用户
**我想** 用一句话描述一个多步骤任务（如"整理代码中的TODO注释"）
**以便** 自动生成 Amber pipeline 并立即执行，无需手动编写 YAML

**验收标准：**
1. `amber init --requirement "整理代码中的TODO注释"` → 生成可执行的 `pipeline.yaml`
2. `amber init --spec requirements.md` → 从文档生成 `pipeline.yaml`
3. 生成的 `pipeline.yaml` 可以直接被 `amber run --pipeline <path>` 执行
4. 未提供 `--requirement` 或 `--spec` 时显示使用帮助

---

## 3. 术语

| 术语 | 说明 |
|------|------|
| **Meta-Pipeline** | 用于生成 pipeline.yaml 的 Amber pipeline。由两个 Phase 组成：analyze + generate |
| **Pipeline Generator** | 驱动 Meta-Pipeline 运行的入口模块。负责注入用户需求、收集产物、返回生成的 pipeline.yaml |
| **Analyze Phase** | 分析用户需求，生成结构化的 JSON 分析结果（功能类型、概要、Slug、Phase 模板） |
| **Generate Phase** | 读取分析结果，生成符合 Amber 规范的 pipeline.yaml 并写入文件系统 |

---

## 4. 设计方案

### 4.1 新增 CLI 子命令

```
amber init [--requirement <text> | --spec <file>] [--output <dir>] [--model <name>]
```

- `--requirement, -r`：一句话需求文本
- `--spec, -s`：需求文档路径（支持 .md/.txt）
- `--output, -o`：输出目录，默认 `generated-pipelines/<slug>/`
- `--model`：指定 LLM 模型，默认由系统决定

### 4.2 CLI 解析入口

- `src/cli.ts` 主入口新增 `init` case
- 解析 `parseInitArgs()`：互斥检查 `--requirement` 与 `--spec`，校验 `--spec` 文件存在
- 调用 `PipelineGenerator.generatePipeline()`

### 4.3 Meta-Pipeline 定义

**Meta-Pipeline** 有两个 Phase：

```typescript
// src/amber/meta-pipeline.ts
export const META_PIPELINE: PipelineConfig = {
  // 与普通 pipeline.yaml 同构
  version: '1.0',
  workDir: '.',
  defaultSkillsDir: './skills',
  phases: [
    {
      id: 'analyze',
      goal: [
        "## 任务：分析用户需求并生成结构化的分析结果",
        "",
        "### 输入",
        "- 用户的需求描述（嵌入在 goal 中）",
        "",
        "### 要求",
        "- 分析需求的类型（功能/修复/重构）",
        "- 提炼一句话总结",
        "- 生成 kebab-case 英文短名（用于输出目录名）",
        "- 将需求分解为 2-5 个 Phase，每个 Phase 需要有清晰的 goal、skills、artifactTemplate",
        "",
        "### 输出",
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
