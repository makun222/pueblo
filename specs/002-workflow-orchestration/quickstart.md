# Quickstart: Workflow-Oriented Task Orchestration

## Purpose

本 quickstart 用于验证 Pueblo 的 workflow 编排闭环已经具备以下能力：

- 简单任务保持 pass-through，不被强制流程化。
- 复杂任务可以 handoff 到 `pueblo-plan` workflow。
- workflow 轮次可以生成、推进并回写 runtime `.plan.md`。
- 活跃 `plan/todo` 可以在 Pepe 开启时持续进入上下文。
- workflow 完成后可以导出最终 `.plan.md`，并能从 runtime plan 恢复。

## Preconditions

1. 安装依赖：`npm install`
2. 如果要运行依赖 SQLite 的 Node integration tests，先执行：`npm run rebuild:node-native`
3. 如果当前机器上的 `better-sqlite3` 是按 Electron ABI 编译的，SQLite integration tests 会被自动 skip；这不影响 unit validation。

## Quick Validation Commands

先运行聚焦 workflow 行为的 test matrix：

```bash
npm exec vitest -- run tests/unit/workflow-router.test.ts tests/unit/pueblo-plan-rounds.test.ts tests/unit/pueblo-plan-workflow.test.ts tests/unit/context-resolver.test.ts tests/unit/task-message-builder.test.ts tests/unit/task-runner-step-limit.test.ts tests/unit/workflow-exporter.test.ts tests/unit/workflow-service.test.ts tests/unit/result-blocks.test.ts tests/unit/pepe-supervisor.test.ts tests/integration/workflow-handoff.test.ts tests/integration/workflow-pass-through.test.ts tests/integration/workflow-rounds.test.ts tests/integration/context-injection.test.ts tests/integration/workflow-plan-export.test.ts tests/integration/workflow-recovery.test.ts
```

然后运行类型检查：

```bash
npm exec tsc -- --noEmit --pretty false
```

## Scenario Checklist

### 1. Simple task pass-through

- Primary evidence: `tests/unit/workflow-router.test.ts`
- Optional SQLite integration evidence: `tests/integration/workflow-pass-through.test.ts`
- Expected result: 简单任务保持普通 task 路径，不返回 `WORKFLOW_STARTED`。

### 2. Workflow handoff

- Primary evidence: `tests/unit/workflow-router.test.ts`
- Optional SQLite integration evidence: `tests/integration/workflow-handoff.test.ts`
- Expected result: 显式 `/workflow` 或命中复杂任务路由后，系统创建 `pueblo-plan` workflow、runtime `.plan.md`、以及 `plan` memory。

### 3. Round progression

- Primary evidence: `tests/unit/pueblo-plan-rounds.test.ts`, `tests/unit/pueblo-plan-workflow.test.ts`, `tests/unit/workflow-service.test.ts`
- Optional SQLite integration evidence: `tests/integration/workflow-rounds.test.ts`
- Expected result: 当前轮 `todo` 生成成功，每轮完成后 plan 状态被回写，并在有后续任务时激活下一轮。

### 4. Context injection with Pepe enabled

- Primary evidence: `tests/unit/context-resolver.test.ts`, `tests/unit/task-message-builder.test.ts`, `tests/unit/pepe-supervisor.test.ts`, `tests/unit/task-runner-step-limit.test.ts`
- Optional SQLite integration evidence: `tests/integration/context-injection.test.ts`
- Expected result: 活跃 `plan/todo` 通过 workflow context 固定注入；即使普通 Pepe result items 不包含 workflow memory，task metadata 仍保留 workflow memory IDs。

### 5. Final export and recovery

- Primary evidence: `tests/unit/workflow-exporter.test.ts`, `tests/unit/workflow-service.test.ts`, `tests/unit/result-blocks.test.ts`
- Optional SQLite integration evidence: `tests/integration/workflow-plan-export.test.ts`, `tests/integration/workflow-recovery.test.ts`
- Expected result: runtime `.plan.md` 与 deliverable path 分离；完成后导出成功；重启后可根据 runtime plan 恢复 workflow 状态。

## Observed Validation Status

2026-05-10 本仓库已执行以下验证：

- 聚焦 workflow unit suites 通过。
- `npm exec tsc -- --noEmit --pretty false` 通过。
- SQLite-gated integration suites 在当前环境被正确识别，但如果 `better-sqlite3` 未按当前 Node ABI 编译，则会自动 skip。

## Manual Operator Smoke Test

如果你希望在本地手动走一遍 CLI 路径，可以在完成构建后执行：

```bash
node dist/cli/index.js "/workflow build a staged migration plan"
node dist/cli/index.js "/task-run continue the active workflow"
```

手动检查点：

1. `.plans/` 下出现 workflow 目录和 runtime `.plan.md`
2. task 结果中出现 `Workflow` block
3. workflow 完成后，目标工程目录出现最终 `.plan.md`

## Notes

- `.plans/` 是运行态执行台本目录，不应作为最终交付物直接提交。
- 如果 final export 报告冲突，workflow 仍可保持完成态，但目标路径需要人工处理冲突文件。
- 当前版本只支持 `pueblo-plan`，不支持多 workflow 并发执行。