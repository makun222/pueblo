# Implementation Plan: Workflow-Oriented Task Orchestration

**Branch**: `master` | **Date**: 2026-05-10 | **Spec**: `D:\workspace\trends\pueblo\specs\002-workflow-orchestration\spec.md`
**Input**: Feature specification from `D:\workspace\trends\pueblo\specs\002-workflow-orchestration\spec.md`

## Summary

本次迭代为 Pueblo 增加一个独立的 workflow 编排层，作为复杂任务的主控入口。首个 workflow `pueblo-plan` 用于判断复杂度、生成运行态 `.plan.md`、为每一轮生成 `todo` 批次、将活跃 `plan/todo` 固定注入上下文，并在完成后将最终 `.plan.md` 导出到 app 工程目录。目标不是让 Pepe 继续承担“计划保持器”，而是把 workflow 状态提升为显式、一等公民的运行时对象。

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS  
**Primary Dependencies**: 现有 `zod`, `better-sqlite3`, `electron`, `react`, provider adapters, file system APIs  
**Storage**: SQLite 持久化 workflow instance 状态；文件系统保存运行态 `.plan.md` 与最终导出 plan  
**Testing**: `vitest` unit/integration/contract tests，必要的 file-system based workflow tests  
**Target Platform**: CLI + desktop shared runtime  
**Project Type**: 单仓 TypeScript app  
**Constraints**: workflow 层必须复用现有 task runner、context resolver 和 session/memory 模块；不得把 plan/todo 上下文继续伪装成普通 Pepe 召回结果；运行态与最终交付 plan 路径必须分离  
**Scale/Scope**: 首先只交付 `pueblo-plan`，但架构要支持后续扩展其他 workflow 类型

## Constitution Check

- [x] 新增模块边界清晰：workflow 编排层不替代 session、memory、Pepe 或 task runner，而是在其上进行编排。
- [x] 保持 CLI 与 desktop 共享核心逻辑，不增加两套 workflow 实现。
- [x] 本次迭代范围完整：从接管判断、状态持久化、上下文注入到计划导出闭环交付。
- [x] 明确必要优先级：先实现 `pueblo-plan` 与 pinned workflow context，再考虑更多 workflow。
- [x] 已识别测试边界：路由、计划生成、上下文注入、轮次推进、导出同步。

## Project Structure

### Documentation

```text
specs/002-workflow-orchestration/
├── spec.md
├── plan.md
├── quickstart.md
└── tasks.md
```

### Source Code

```text
src/
├── workflow/
│   ├── workflow-model.ts
│   ├── workflow-repository.ts
│   ├── workflow-service.ts
│   ├── workflow-registry.ts
│   ├── workflow-router.ts
│   ├── workflow-context.ts
│   ├── workflow-plan-store.ts
│   ├── workflow-exporter.ts
│   └── pueblo-plan/
│       ├── pueblo-plan-workflow.ts
│       ├── pueblo-plan-planner.ts
│       ├── pueblo-plan-rounds.ts
│       ├── pueblo-plan-memory.ts
│       └── pueblo-plan-markdown.ts
├── agent/
│   ├── context-resolver.ts
│   ├── task-message-builder.ts
│   ├── task-runner.ts
│   └── pepe-worker-process.ts
├── memory/
├── sessions/
├── shared/
└── cli/ / desktop/

tests/
├── unit/
├── integration/
└── contract/
```

**Structure Decision**: 将 workflow 作为独立顶层模块，而不是继续塞入 `src/agent/`。`src/agent/` 仍负责模型执行、Pepe 和上下文基础设施；`src/workflow/` 负责复杂任务路由、workflow 状态、plan/todo 生成、固定上下文注入与导出。首个 `pueblo-plan` workflow 放在 `src/workflow/pueblo-plan/`，后续新增 workflow 可通过 registry 扩展。

## Architecture Decisions

### 1. 将 workflow 作为接管层，而不是提示词技巧

当前 [task-runner](D:/workspace/trends/pueblo/src/agent/task-runner.ts) 已有 step budget 提示，但它仍依赖模型“自觉分轮”。本方案把复杂任务判断提前到 workflow router，由系统决定是否接管。

**Decision**:

- 普通任务继续走现有 task runner。
- 复杂任务先走 workflow router。
- workflow router 输出两类结果：`pass-through` 或 `handoff-to-workflow`。

### 2. 将活跃 plan/todo 作为 pinned workflow context

当前 [context-resolver](D:/workspace/trends/pueblo/src/agent/context-resolver.ts) 只把 Pepe 的 `resultItems` 注入消息。此方案新增 workflow context block，由 workflow service 返回当前活跃 `plan` 与 `todo`，并由 task message builder 固定注入 system message。

**Decision**:

- `selectedMemoryIds` 保留为候选元数据。
- `workflowContext` 成为新的上下文字段。
- `plan/todo` 不参与是否进入 prompt 的最终决定。

### 3. 运行态 plan 与工程交付 plan 双路径

`.plan.md` 同时是内部执行台本和最终工程交付物，因此必须拆成两个路径：

- 运行态权威路径：`<workspaceRoot>/.plans/<workflowId>/<slug>.plan.md`
- 最终导出路径：默认 `<targetDirectory>/<slug>.plan.md`

**Decision**:

- workflow 进行中只更新运行态 plan。
- workflow 完成后由 exporter 一次性写入最终导出路径。
- 运行态 plan 记录最终导出路径，确保恢复时路径可追溯。

### 4. Plan memory 与 todo memory 采用轻索引/重轮次分离

**Decision**:

- `plan` memory 只记录路径、状态、当前轮次和 workflow id。
- `todo` memory 记录当前轮次的详细任务切片。
- 两者都保留 tag：`workflow`, `workflow:pueblo-plan`，并分别包含 `plan` 或 `todo`。

### 5. Pepe 不再负责 workflow 状态保持

当前 [pepe-worker-process](D:/workspace/trends/pueblo/src/agent/pepe-worker-process.ts) 只总结 `conversation-turn`，这对 workflow 是有利的。这里进一步明确：Pepe 不生成也不筛掉活跃 plan/todo。

**Decision**:

- `plan/todo` 不自动 summary。
- Pepe 仅处理普通 conversation memory。
- 如需在 UI 中显示，`selectedMemoryIds` 可继续保留 plan/todo id。

## Data Model Additions

### Workflow Instance

建议新增持久化模型：

- `id`
- `type`
- `status`
- `sessionId`
- `agentInstanceId`
- `goal`
- `targetDirectory`
- `runtimePlanPath`
- `deliverablePlanPath`
- `activePlanMemoryId`
- `activeTodoMemoryId`
- `activeRoundNumber`
- `createdAt`
- `updatedAt`
- `completedAt`
- `failedAt`

### Workflow Context

建议新增运行态上下文对象：

- `workflowId`
- `workflowType`
- `status`
- `planSummary`
- `planMemoryId`
- `todoSummary`
- `todoMemoryId`
- `runtimePlanPath`
- `deliverablePlanPath`
- `activeRoundNumber`

## Phase Plan

### Phase 1 - Workflow Skeleton

目标：建立可扩展 workflow 基础设施。

- 新增 `src/workflow/` 基础模型、repository、service、registry、router。
- 为 session 输入增加 workflow route 决策。
- 定义 workflow instance schema 与持久化表。

### Phase 2 - Pueblo Plan Workflow

目标：让复杂任务可以生成和维护运行态 `.plan.md`。

- 实现 `pueblo-plan` workflow definition。
- 实现复杂度判断与显式接管。
- 生成运行态 `.plan.md`。
- 创建 `plan` memory。

### Phase 3 - Todo Rounds + Pinned Context

目标：每轮生成 todo 并固定注入 plan/todo 上下文。

- 实现 `todo` 轮次选择器。
- 创建/更新 `todo` memory。
- 扩展 `TaskContext` 增加 `workflowContext`。
- 扩展 `context-resolver` 和 `task-message-builder` 固定注入 workflow context。
- 调整 Pepe，确保 plan/todo 不被 summary 或 ranking 控制。

### Phase 4 - Round Closure + Export

目标：完成回写、恢复和导出闭环。

- 每轮完成后更新运行态 `.plan.md`。
- 支持从 runtime plan 恢复 workflow。
- workflow 完成时导出最终 `.plan.md` 到 app 工程目录。
- 处理 blocked/failed/cancelled 状态。

## Validation Strategy

### Unit Tests

- workflow router 正确区分普通任务与复杂任务
- runtime plan path 与 deliverable path 解析正确
- `plan` memory 与 `todo` memory payload 正确
- workflow context 注入顺序正确且不依赖 Pepe 排名

### Integration Tests

- 复杂任务触发 `pueblo-plan` workflow 后生成 runtime `.plan.md`
- 某一轮执行结束后 plan 被正确回写
- workflow 完成后最终 `.plan.md` 被导出到目标工程目录
- 中断后可基于 workflow instance + runtime plan 恢复

### Operator Quickstart

- 在 `specs/002-workflow-orchestration/quickstart.md` 维护 workflow smoke test 和验证矩阵。
- quickstart 必须同时覆盖 pass-through、workflow handoff、round progression、context injection、final export/recovery。
- 如果当前环境无法加载 SQLite 原生模块，quickstart 需要明确哪些 integration cases 会 skip，以及对应的 unit fallback coverage。


### Regression Tests

- 简单任务仍走现有单轮 task runner
- Pepe 对普通 memory 的召回仍然有效
- `selectedMemoryIds` 现有行为不因 workflow 引入而退化

## Risks & Mitigations

| Risk | Impact | Mitigation |
| ------ | ------ | ------ |
| workflow router 误判复杂度 | 简单任务被过度流程化 | 提供显式跳过/强制接管入口，并先以保守阈值上线 |
| plan 文件与 workflow 实例状态不一致 | 恢复失败或状态错乱 | 以 runtime `.plan.md` 为权威，repository 状态只存索引与指针 |
| plan/todo 仍被普通上下文裁剪覆盖 | code master 忘记执行台本 | 在 `TaskContext` 增加独立 `workflowContext` 并固定注入 |
| 导出路径污染工程工作区 | 中间态文档影响提交物 | 完成前只写 `.plans/`，最终导出采用一次性同步 |
| Pepe 无意总结 plan/todo | 计划语义被压缩 | 显式过滤 `plan/todo` tags，不参与自动 summary |

## First Implementation Slice

第一批实现建议只覆盖最小闭环：

1. `src/workflow/` 基础设施 + `pueblo-plan` workflow definition
2. runtime `.plan.md` 生成
3. `plan/todo` memory 创建
4. `workflowContext` 注入到 `context-resolver` / `task-message-builder`

这个切片已经能解决当前最核心的问题：复杂任务被显式 workflow 接管，并且 plan/todo 不会再被 Pepe 从 prompt 中挤掉。导出同步和恢复可在第二批补上。
