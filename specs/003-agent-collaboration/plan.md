# Implementation Plan: Agent Collaboration Scheduling

**Branch**: `master` | **Date**: 2026-05-19 | **Spec**: `specs/003-agent-collaboration/spec.md`
**Input**: Feature specification from `specs/003-agent-collaboration/spec.md`

## Summary

为 Pueblo 增加 Agent 协作调度能力，允许用户在界面上定义有向无环图（DAG）拓扑，将多个 Agent（如 Code Master + Debugger）编排为协作流水线。每个 Agent 节点保留独立的 provider/model/prompt 配置；系统按拓扑顺序执行、管理回合，并通过明确的完成条件判断协作终止。

本次迭代的 P0 交付：Schema 类型定义（shared/schema.ts）、AgentCollaborationService 核心编排器（src/agent/agent-collaboration.ts）、IPC 通道（desktop/main/ipc.ts）。

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS
**Primary Dependencies**: 现有 zod、better-sqlite3、electron、react、provider adapters
**Storage**: SQLite 持久化协作实例；运行态 plan 文件位于 .plans/
**Testing**: vitest unit/integration 测试
**Target Platform**: CLI + desktop 共享运行时
**Constraints**: 复用现有 task-runner、agent-instance-service、Pepe supervisor；不修改 workflow 层
**Scale/Scope**: P0 只交付双 Agent 顺序管道（A → B）；拓扑 DSL 和 DAG 引擎留到 P1。

## Constitution Check

- [x] 新增模块边界清晰：AgentCollaborationService 在 task-runner 之上编排，不替代 task-runner。
- [x] CLI 与 desktop 共享核心逻辑。
- [x] 不修改现有 workflow 层。

## Phase Plan

### Phase 1: Schema & Core Types (本轮)

- `CollaborationGraphSchema`：节点列表 + 边列表
- `CollaborationNodeSchema`：agentProfileId、providerId、modelId、role
- `CollaborationEdgeSchema`：source node → target node（方向边）
- `CollaborationInstanceSchema`：运行实例，含 graph snapshot、status、rounds、completionCriteria
- `CollaborationRoundSchema`：单轮执行记录

### Phase 2: AgentCollaborationService (本轮)

- `startCollaboration(graph, goal, completionCriteria)` → instance
- `executeNextRound(instanceId)` → round result
- 双 Agent 顺序管道：先跑 Code Master，将其 output 注入 Debugger 的 prompt context，再跑 Debugger，收集其反馈，判断是否达到完成条件。
- `getStatus(instanceId)` → status snapshot

### Phase 3: IPC 通道 (本轮)

- `collaboration:start` — 启动协作
- `collaboration:progress` — 每轮进度推送
- `collaboration:complete` — 协作完成
- `collaboration:error` — 异常

### Phase 4: Frontend UI (下轮 P1)

- 协作模式切换按钮
- 双 Agent 配对面板（通过下拉选择 Agent profile、provider、model）
- 目标输入框 + 完成条件配置
- 实时进度展示

## Validation Strategy

### Unit Tests

- Schema 校验：valid/invalid graph topology
- AgentCollaborationService 的 start/executeRound/status 正确性
- 完成条件判断逻辑（maxRounds、approvalBy、fixedOutput）

### Integration Tests

- 双 Agent 顺序管道端到端
- Code Master 输出正确注入 Debugger 的 prompt
- 完成条件触发后停止调度
