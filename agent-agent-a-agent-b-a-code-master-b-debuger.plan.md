# Plan: 实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。

## Workflow Metadata
- Workflow ID: 08b74c99-563c-4091-a6e8-09863d26558a
- Workflow Type: pueblo-plan
- Status: completed
- Session ID: a91b68b2-882d-44b6-8693-50abf63c207f
- Route Reason: explicit
- Runtime Plan Path: D:\workspace\trends\pueblo\.plans\08b74c99-563c-4091-a6e8-09863d26558a\agent-agent-a-agent-b-a-code-master-b-debuger.plan.md
- Deliverable Plan Path: D:\workspace\trends\pueblo\agent-agent-a-agent-b-a-code-master-b-debuger.plan.md

## Goal
实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。

## Constraints
- Keep changes scoped to the requested goal.
- Prefer verifiable progress at the end of each round.
- Do not export the final plan deliverable until the workflow is complete.

## Acceptance Criteria
- The requested goal is completed: 实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。.
- The implementation is validated with the narrowest available check.
- The runtime plan stays synchronized with execution status.

## Talk Implementation Checklist
- [x] Replace whitespace-only slash parsing so `/talkto <pid> -m "..."` preserves quoted messages.
- [x] Add desktop talk IPC contracts for talk state, incoming request decisions, and turn-limit continuation decisions.
- [x] Add a websocket-backed desktop talk service in `src/desktop/main/talk-service.ts`.
- [x] Register per-process discovery by pid and keep a local talk state machine in the desktop main process.
- [x] Intercept `/talkto <pid> -m "..."` and `/talkto <pid> end` inside desktop `submit-input` handling.
- [x] Reject all non-`/talkto <peerPid> end` user input while a talk session is active.
- [x] Keep agent/provider/workspace/session execution local to each process; only forward peer text over websocket.
- [x] Surface the current desktop process pid in the renderer toolbar.
- [x] Show incoming talk-request and turn-limit continuation dialogs in the renderer.
- [x] Pause the conversation every `talk_turns_limit` turns (default 50) until both sides choose to continue; otherwise end implicitly.
- [x] Validate the landed slices with focused tests.

## Focused Validation
- `npx vitest run tests/unit/dispatcher.test.ts`
- `npm test tests/unit/dispatcher.test.ts tests/unit/desktop-renderer.test.tsx tests/desktop/ipc-shutdown.test.ts tests/desktop/window-input-output.test.ts`

## Task Tree
- [x] Complete goal: 实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。 (task-root)
  - [x] Inspect the current implementation surface and confirm the controlling code path. (task-inspect)
  - [x] Refine the implementation approach for the next smallest executable slice. (task-plan)
  - [x] Implement the current highest-value slice with minimal related changes. (task-implement)
  - [x] Run focused validation for the current slice and capture results. (task-validate)
  - [x] Update runtime workflow state and prepare the next round or final export. (task-sync)

## Current Round
- Active Round: none
- Active Tasks: pending

## Execution Log
- 2026-05-13T07:34:35.977Z: Workflow created and runtime plan initialized.
- 2026-05-13T07:34:35.981Z: Activated round 1 with tasks task-inspect, task-plan, task-implement, task-validate, task-sync.
- 2026-05-13T07:44:59.124Z: Completed round 1.

```pueblo-plan-state
{
  "workflowId": "08b74c99-563c-4091-a6e8-09863d26558a",
  "workflowType": "pueblo-plan",
  "status": "completed",
  "routeReason": "explicit",
  "sessionId": "a91b68b2-882d-44b6-8693-50abf63c207f",
  "goal": "实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。",
  "runtimePlanPath": "D:\\workspace\\trends\\pueblo\\.plans\\08b74c99-563c-4091-a6e8-09863d26558a\\agent-agent-a-agent-b-a-code-master-b-debuger.plan.md",
  "deliverablePlanPath": "D:\\workspace\\trends\\pueblo\\agent-agent-a-agent-b-a-code-master-b-debuger.plan.md",
  "constraints": [
    "Keep changes scoped to the requested goal.",
    "Prefer verifiable progress at the end of each round.",
    "Do not export the final plan deliverable until the workflow is complete."
  ],
  "acceptanceCriteria": [
    "The requested goal is completed: 实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。.",
    "The implementation is validated with the narrowest available check.",
    "The runtime plan stays synchronized with execution status."
  ],
  "tasks": [
    {
      "id": "task-root",
      "title": "Complete goal: 实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。比如A（code master）与B（Debuger）协作完成代码测试。",
      "parentId": null,
      "status": "completed"
    },
    {
      "id": "task-inspect",
      "title": "Inspect the current implementation surface and confirm the controlling code path.",
      "parentId": "task-root",
      "status": "completed"
    },
    {
      "id": "task-plan",
      "title": "Refine the implementation approach for the next smallest executable slice.",
      "parentId": "task-root",
      "status": "completed"
    },
    {
      "id": "task-implement",
      "title": "Implement the current highest-value slice with minimal related changes.",
      "parentId": "task-root",
      "status": "completed"
    },
    {
      "id": "task-validate",
      "title": "Run focused validation for the current slice and capture results.",
      "parentId": "task-root",
      "status": "completed"
    },
    {
      "id": "task-sync",
      "title": "Update runtime workflow state and prepare the next round or final export.",
      "parentId": "task-root",
      "status": "completed"
    }
  ],
  "activeRoundNumber": null,
  "rounds": [
    {
      "roundNumber": 1,
      "taskIds": [
        "task-inspect",
        "task-plan",
        "task-implement",
        "task-validate",
        "task-sync"
      ],
      "status": "completed",
      "summary": "Now I have a complete picture. Let me present the implementation plan.\n\n---\n\n## 方案：Agent A (Code Master) 与 Agent B (Debugger) 协作通信\n\n### 1. 现状分析 (task-inspect 完成)\n\n**已有能力：**\n| 组件 | 路径 | 职责 |\n|------|------|------|\n| `AgentTaskRunner` | `src/agent/task-runner.ts` | 单 Agent 任务循环：构建消息 → 调用 LLM → 处理工具调用 → 输出 |\n| `AgentInstanceService` | `src/agent/agent-instance-service.ts` | 基于 profile 模板创建 Agent 实例 |\n| `AgentProfileTemplate` | `puebl-profile/*/agent.md` | 5 个预制 profile：code-master, debugger, architect, writer, philosopher |\n| `TaskContext` | `src/agent/task-context.ts` | 任务上下文（session, provider, prompts, memories） |\n\n**关键缺口：** 不存在 Agent 间的通信/协作机制。当前 `AgentTaskRunner` 只能运行单个 Agent 任务，无法将一个 Agent 的输出传递给另一个 Agent。\n\n---\n\n### 2. 方案设计 (task-plan)\n\n#### 核心思路：**Agent 协作编排器 (Agent Collaboration Orchestrator)**\n\n新增 `src/agent/agent-collaboration.ts`，实现一个轻量编排层，复用现有 `AgentTaskRunner`，按顺序调度 Agent A → Agent B，并在两者之间传递上下文。\n\n#### 架构图\n\n```\n┌────────────────────────────────────────────┐\n│        AgentCollaborationService           │\n│                                            │\n│  1. Agent A (Code Master) runs            │\n│     └─ goal + code-master directives      │\n│     └─ output: code changes / fix         │\n│                                            │\n│  2. Agent B (Debugger) runs               │\n│     └─ input: Code Master's output        │\n│     └─ goal + debugger directives         │\n│     └─ output: bugs found / validation    │\n│                                            │\n│  3. Feedback loop (optional)              │\n│     └─ if bugs found → loop back to A     │\n└────────────────────────────────────────────┘\n```\n\n#### 最小可执行切片 (Round 1)\n\n| 文件 | 变更 | 说明 |\n|------|------|------|\n| **`src/agent/agent-collaboration.ts`** | **新建** | `AgentCollaborationService` 类 |\n| **`src/agent/types.ts`** | **新建** (或扩展 schema) | `CollaborationRound`, `CollaborationResult` 类型 |\n| **`tests/agent-collaboration.test.ts`** | **新建** | 验证数据模型和流程的单元测试 |\n\n#### 核心接口设计\n\n```typescript\n// 协作输入\ninterface CollaborationInput {\n  goal: string;                    // 总体任务目标\n  agentSequence: string[];        // Agent profile 顺序，如 ['code-master', 'debugger']\n  maxRounds: number;              // 最大反馈轮次 (默认 2)\n  context: TaskContext;           // 复用现有任务上下文\n}\n\n// 单轮结果\ninterface CollaborationRoundResult {\n  agentId: string;\n  output: string;\n  toolCalls: ProviderToolCall[];\n}\n\n// 整体结果\ninterface CollaborationResult {\n  rounds: CollaborationRoundResult[];\n  finalOutput: string;\n  complete: boolean;\n}\n```\n\n#### 执行流程\n\n```\ncollaborate(input):\n  context = buildCodeMasterContext(input.goal)\n  \n  // Round 1: Code Master generates code\n  cmResult = runAgentTask('code-master', context, input.taskContext)\n  \n  // Round 2: Debugger reviews\n  dbgContext = buildDebuggerContext(input.goal, cmResult)\n  dbgResult = runAgentTask('debugger', dbgContext, input.taskContext)\n  \n  // If Debugger finds issues and maxRounds not reached:\n  //   context = buildCodeMasterContext(input.goal, dbgResult)\n  //   goto Round 1\n  \n  return aggregateResults(cmResult, dbgResult)\n```\n\n#### 上下文传递策略\n\nCode Master 的输出通过以下方式注入 Debugger 的上下文：\n\n1. **系统消息前缀** — 将上一轮 Agent 的输出摘要追加到下一轮 Agent 的系统消息中\n2. **记忆注入** — 将上一轮的关键发现作为临时记忆注入（复用现有 memory 机制）\n3. **工作流上下文** — 在 `TaskContext.workflowContext` 中携带协作状态\n\n---\n\n### 3. 实现步骤（Round 1 完成目标）\n\n| Step | 内容 | 预估行数 |\n|------|------|---------|\n| **S1** | 新建 `src/agent/agent-collaboration.ts`，实现 `AgentCollaborationService` 类和核心 `collaborate()` 方法 | ~80 行 |\n| **S2** | 在 `src/shared/schema.ts` 或新建 `src/agent/collaboration-types.ts` 定义协作类型 | ~30 行 |\n| **S3** | 新建 `tests/agent-collaboration.test.ts`，编写最小验证测试（验证类型、构造、调用路径） | ~50 行 |\n| **S4** | 运行 `npx vitest run` 验证通过 | - |\n| **S5** | 更新 plan 状态，准备下一轮 | - |\n\n---\n\n### 4. 验证方式\n\n```bash\nnpx vitest run tests/agent-collaboration.test.ts\n```\n\n验证点：\n- `AgentCollaborationService` 实例化成功\n- `CollaborationInput` 类型通过 Zod 校验\n- Mock `AgentTaskRunner` 调用链正确（Code Master → Debugger 顺序）\n\n---\n\n**下一步：** 如果方案认可，我将立即进入 `task-implement` 阶段，按照 S1-S5 逐步实现上述切片。是否继续？"
    }
  ],
  "executionLog": [
    "2026-05-13T07:34:35.977Z: Workflow created and runtime plan initialized.",
    "2026-05-13T07:34:35.981Z: Activated round 1 with tasks task-inspect, task-plan, task-implement, task-validate, task-sync.",
    "2026-05-13T07:44:59.124Z: Completed round 1."
  ],
  "createdAt": "2026-05-13T07:34:35.977Z",
  "updatedAt": "2026-05-13T07:44:59.124Z"
}
```
