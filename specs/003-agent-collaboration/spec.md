# Feature Specification: Agent Collaboration Scheduling

**Feature Branch**: `003-agent-collaboration`
**Created**: 2026-05-19
**Status**: Draft
**Input**: User description: "实现agent之间通信，选定Agent A与Agent B，按照各自职责共同协作完成一项任务。用户定义图拓扑，在界面调度起两个Agent并开启它们之间的协作，包括明确任务目标、明确结束标志。"

## Summary

为 Pueblo 增加 Agent 协作调度能力，允许用户在界面上定义有向图拓扑，将多个 Agent 编排为协作流水线。每个 Agent 节点保留独立的 provider/model/prompt 配置；系统按拓扑顺序执行、管理回合，并通过明确的完成条件判断协作终止。

## User Scenarios & Testing

### User Story 1 - 双 Agent 顺序协作 (Priority: P0)

作为使用 Pueblo 的开发者，我希望在界面上选择两个 Agent（例如 Code Master + Debugger），指定一个编码目标（如"实现用户登录模块"），并定义结束条件（如"Debugger 确认无错误"），系统自动在两者之间轮转直到完成。

**Why this priority**: 这是 Agent 协作的最小可行闭环，直接解锁 A→B 检查模式。

**Acceptance Criteria**:
- 用户可通过 IPC 调用 `collaboration:start` 发起包含两个 Agent 节点的协作。
- Code Master 先执行编码任务，其输出被注入 Debugger 的上下文中。
- Debugger 分析输出后给出反馈；系统持续轮转直到完成条件满足。
- 用户可通过 `collaboration:progress` 实时查看每轮进度。

### User Story 2 - 用户定义图拓扑 (Priority: P1)

作为高级用户，我希望自定义多于两个 Agent 的协作拓扑（如 Code Master → Reviewer → Tester），并通过简单的节点/边描述定义数据流向。

**Why this priority**: 双 Agent 已验证后，泛化到多 Agent 是自然演进。

**Acceptance Criteria**:
- 用户可通过 JSON/YAML 定义任意 DAG 拓扑。
- 系统按拓扑顺序执行所有节点。
- 错误节点可触发后续节点的重试或跳过。

## Requirements

### Functional Requirements

- FR-001: 系统 MUST 接受包含 2+ Agent 节点的有向图拓扑定义。
- FR-002: 系统 MUST 按拓扑顺序串行执行 Agent 节点（P0 仅支持线性链 A → B）。
- FR-003: 系统 MUST 将上游节点的输出注入下游节点的 prompt 上下文。
- FR-004: 系统 MUST 支持明确的完成条件：最大轮数、指定 Agent 审批通过、固定输出产物。
- FR-005: 系统 MUST 通过 IPC 向前端推送实时进度。
- FR-006: 系统 MUST 持久化协作实例状态，支持中断恢复。

### Non-Functional Requirements

- 每次 Agent 调用复用现有 task-runner（包括工具审批流程）。
- 不修改 workflow 层。

## Completion Criteria Types

| Type | 说明 |
|------|------|
| `maxRounds` | 达到最大轮数后标记完成 |
| `agentApproval` | 指定 Agent 在输出中包含 `APPROVED` 标记 |
| `noChanges` | 连续 N 轮无实质性代码变更 |
| `fixedOutput` | 存在指定路径的输出产物 |

## Data Model (P0)

```
CollaborationGraph {
  nodes: CollaborationNode[]   // 2 nodes in P0
  edges: CollaborationEdge[]   // 1 edge: A → B
}

CollaborationNode {
  nodeId: string
  agentProfileId: string       // "code-master" | "debugger" | ...
  providerId: string
  modelId: string
  role: string                 // free-text role description
}

CollaborationInstance {
  id: string
  graph: CollaborationGraph
  goal: string
  completionCriteria: CompletionCriteria
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  rounds: CollaborationRound[]
  currentNodeId: string | null
  createdAt: string
  updatedAt: string
}

CollaborationRound {
  roundNumber: number
  nodeResults: NodeRoundResult[]   // ordered by topology
  status: 'in-progress' | 'completed' | 'failed'
}
```
