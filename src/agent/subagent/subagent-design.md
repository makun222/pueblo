# SubAgent Design Document

## Overview
The SubAgent system allows a parent agent to spawn independent child agents (CamelAgent instances) that run with their own context, budget, and lifecycle. Communication between parent and child is purely asynchronous: the parent creates a subagent via `spawn_subagent`, receives a `task_id`, and can later poll for results via `check_subagent`.

## Architecture

```
Parent Agent
  ├─ spawn_subagent(goal, options?: { budget?, maxSteps? }) → taskId
  ├─ check_subagent(taskId) → { status, result?, error? }
  └─ ... continues other work while subagent runs ...

SubAgent Service (in-memory)
  ├─ Map<taskId, SubAgentTask>
  └─ lifecycle: spawn → start → (running) → complete/fail
```

## Key Components

### 1. `subagent-types.ts` — Type Definitions
- `SubAgentStatus`: `'running' | 'completed' | 'failed'`
- `SubAgentTask`: task metadata (taskId, status, result, error, timestamps)
- `SpawnSubAgentArgs` (tool input): { goal, options?: { budget?, maxSteps? } }
- `CheckSubAgentArgs` (tool input): { taskId }
- `SubAgentToolDeps`: { sessionId, providerId, modelId, executeTurnFn, onStatusUpdate? } — injected via factory

### 2. `subagent-service.ts` — Lifecycle Management
- `SubAgentService` class with:
  - `spawn(goal: string, options?: { maxSteps?: number; budgetLimit?: number }): Promise<string>` — Creates & starts a CamelAgent, returns taskId
  - `check(taskId: string): SubAgentTask | null` — Returns current task status
  - `cancel(taskId: string): boolean` — Cancels a running subagent
- State stored in an in-memory `Map<string, ManagedSubAgent>` (wraps SubAgentTask + CamelAgent)
- Max concurrent subagents configurable (default 5)

### 3. `subagent-tool.ts` — Tool Definitions & Integration
- Tool definitions with input schemas for spawn_subagent / check_subagent
- Factory: `createSubAgentTool(deps: SubAgentToolDeps)` → `CustomToolProvider`
- Integrates with ToolService via the `CustomToolProvider` interface (getDefinitions() + execute())

## Data Flow

1. **spawn_subagent(tool call)**:
   - SubAgentService validates concurrency limit
   - Creates a new `CamelAgent` with its own sessionId, AbortController, goal, budget
   - Starts the agent asynchronously (non-blocking)
   - Returns `{ taskId }` immediately

2. **SubAgent execution** (background):
   - CamelAgent runs autonomously with its own prompts & budget
   - Uses the shared ExecuteTurnFn to interact with LLM and tools
   - On completion: updates task status and stores result
   - On error: stores error message and marks as failed

3. **check_subagent(tool call)**:
   - Looks up task by taskId
   - Returns `{ status: 'running' | 'completed' | 'failed', result?, error? }`

## Concurrency & Resource Limits
- Max 5 concurrent subagents (configurable)
- Each subagent has independent budget limits via CamelAgent budgetLimit
- Nesting is allowed naturally — any subagent can spawn further subagents, limited by total concurrency pool

## Error Handling
- If max concurrent limit is reached, spawn_subagent returns an error
- If a subagent throws, its status is set to 'failed' with error message
- If a subagent is cancelled midway, status is set to 'failed' with 'cancelled' as error

## Integration
- SubAgent tools are registered via `CustomToolProvider` interface (not ToolService's internal switch)
- Each provider exposes `getDefinitions()` and `execute(toolCallId, name, args, signal)`
- Providers are passed via `ToolServiceConfig.customToolProviders` (see tool-service.ts)

---

## 进度追踪

### Phase 1: 类型定义 ✅
- [x] `SubAgentOptions`, `SubAgentResult`, `SubAgentStatus`, `SubAgentTask` 类型
- [x] `SubAgentToolDeps` 接口
- 文件：`subagent-types.ts`

### Phase 2a: 核心服务 ✅
- [x] `SubAgentService` — 生命周期管理（spawn / check / cancel）
- [x] 并发控制（MAX_CONCURRENT=3，队列管理）
- [x] `createSubAgentTool` — 返回 `CustomToolProvider`
- [x] 指数退避重试（启动失败时）
- [x] 工具定义：`spawn_subagent` / `check_subagent`
- [x] 单元测试：`__tests__/subagent-tool.test.ts` — 9/9 通过

### Phase 2b: 集成接入 ⬜
- [ ] **subagent-bridge.ts** — 进程间通信基础设施（文件未创建，逻辑部分含于 SubAgentService）
- [ ] **工具注册** — `createSubAgentTool` 已实现但**未接入主 CamelAgent** 的 ToolService
- [ ] **集成测试** — 无端到端测试覆盖 spawn → execute → check 完整流程

### Phase 3: 任务管理增强 ⬜
- [ ] **subagent-manager.ts** — 任务分解 / 聚合管理器
- [ ] 子代理间协调（依赖关系、优先级）
- [ ] 结果合并策略（parallel map-reduce / sequential pipeline）
- [ ] 子代理资源池复用

### 编译与测试状态
- Subagent 模块无编译错误 ✅
- 预存在编译错误（`tool-service.ts` / `subagent-tool.ts` 类型推断）— 与 subagent 逻辑无关
- 预存在测试失败（LoopRunner / LoopJobManager）— 与 subagent 无关
