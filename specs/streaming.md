# Streaming Design

## Goal

为 Pueblo 增加真实的流式响应能力，使桌面端不再依赖前端假流式计时器，而是消费来自任务执行链路的增量事件。

目标效果：

- 用户提交任务后，桌面端立即进入思考态。
- 工具调用阶段展示结构化状态，而不是暴露半成品回答。
- 最终自然语言回答按增量事件持续输出到同一条 assistant 回复中。
- 任务结束后，仍然保留现有完整结果块、trace、持久化和调试信息。

## Current State

当前桌面端已经具备以下能力：

- 输入提交后立即清空输入框。
- 输出区先显示“让我想想该怎么做...”。
- 最终回答以 renderer 侧渐进渲染方式显示。

当前限制：

- provider adapter 仍然使用非流式请求，`stream: false`。
- runtime / IPC 只能发布完整输出块，不能发布增量响应事件。
- task runner 没有面向 UI 的流式进度 hook。
- 现在的“流式输出”只是桌面端对完整结果做渐进展示，不是真实 token streaming。

## Non-Goals

本方案首期不做以下内容：

- 不流式展示模型内部推理内容。
- 不在 tool-call step 中直接流式展示模型的临时文本。
- 不修改最终 task 输出摘要和持久化结构的基本职责。
- 不要求 CLI 首期同步支持完整流式体验，桌面端优先。

## Design Principle

将“实时显示”和“最终结果”拆成两条通道：

- 实时事件流：只负责 UI 的增量展示，轻量、可中断、不要求完整持久化。
- 最终结果块：继续走现有 `CommandResult -> createResultBlocks -> output block` 链路，负责完整输出、trace、source refs 和持久化。

这样可以避免把 append token、tool 状态、最终 trace、错误回滚全都塞进同一种对象里，降低复杂度。

## Proposed Architecture

### 1. Desktop Task Event Protocol

新增一套桌面增量事件协议，建议定义在 `src/desktop/shared/ipc-contract.ts`。

建议事件类型：

- `task-started`
- `task-status`
- `response-replace`
- `response-append`
- `response-complete`
- `tool-started`
- `tool-complete`
- `task-failed`

共同字段建议：

- `requestId`: 当前一次用户提交的唯一标识
- `taskId`: 已创建任务时可带上
- `blockId`: 对应桌面端正在更新的 assistant 回复块
- `createdAt`: 事件时间

各事件建议负载：

- `task-started`
  - `placeholderText`
- `task-status`
  - `message`
- `response-replace`
  - `content`
- `response-append`
  - `delta`
- `response-complete`
  - `content`
- `tool-started`
  - `toolName`
  - `summary`
- `tool-complete`
  - `toolName`
  - `status`
  - `summary`
- `task-failed`
  - `message`

### 2. Runtime Event Channel

扩展 `src/app/runtime.ts` 和 `src/desktop/main/ipc.ts`，使 runtime 能发布两类消息：

- 现有最终 `RendererOutputBlock`
- 新增 `DesktopTaskEvent`

建议不要复用当前 `output` channel 的 block 结构，单独增加一个事件 channel，例如：

- `output`: 最终结果块
- `task-event`: 增量流事件

这样 renderer 侧逻辑会更清晰，避免 block 和 event 的职责混淆。

### 3. Preload Bridge

扩展 `src/desktop/preload/index.ts`，新增：

- `onTaskEvent(listener)`

保留现有：

- `onOutput(listener)`

桌面端使用方式：

- `onTaskEvent` 负责更新一条正在进行的 assistant 回复
- `onOutput` 负责在任务结束后补上最终完整结果块、trace 和系统块

### 4. AgentTaskRunner Progress Hook

在 `src/agent/task-runner.ts` 增加一个窄接口，用于向上层报告进度事件，而不直接耦合桌面 UI。

建议接口形态：

```ts
interface AgentTaskProgressReporter {
  onTaskStarted?(event: ...): void;
  onStatus?(event: ...): void;
  onResponseReplace?(event: ...): void;
  onResponseAppend?(event: ...): void;
  onResponseComplete?(event: ...): void;
  onToolStarted?(event: ...): void;
  onToolComplete?(event: ...): void;
  onTaskFailed?(event: ...): void;
}
```

`AgentTaskRunner` 只负责触发这些事件，不关心它们最后是写到 desktop、CLI 还是测试 mock。

### 5. Provider Streaming Interface

在 `src/providers/provider-adapter.ts` 中增加可选的 streaming 能力，但不替换现有同步接口。

建议保留：

- `runStep(context): Promise<ProviderStepResult>`

新增可选接口：

- `runStepStream?(context, observer): Promise<ProviderStepResult>`

这样：

- 支持 streaming 的 provider 走新接口。
- 不支持 streaming 的 provider 仍可复用旧接口。
- task runner 可以按 capability 选择走流式或非流式路径。

### 6. Provider Streaming Boundary

首版真实流式只针对 final answer 生效，不在 tool-call step 中流式展示自然语言内容。

原因：

- 多步 tool agent 的中间文本常常只是临时产物。
- 如果某一步后续转成 tool call，提前展示给用户的半成品文本会产生误导。

因此建议策略：

- tool-call step:
  - 只发 `task-status`、`tool-started`、`tool-complete`
  - 不向用户流出自然语言 delta
- final step:
  - 才允许 `response-replace` / `response-append` / `response-complete`

### 7. Renderer Consumption Model

桌面端 renderer 不再自己用计时器模拟流式，而是消费真实增量事件。

建议行为：

- 收到 `task-started`
  - 插入一条 pending assistant entry
- 收到 `response-replace`
  - 用第一段真实内容替换占位文本
- 收到 `response-append`
  - 将 delta 追加到同一个 entry
- 收到 `tool-started` / `tool-complete`
  - 更新或追加轻量状态块
- 收到 `response-complete`
  - 将这条 assistant entry 标记为 complete
- 任务最终结束后收到 `output`
  - 用最终 block 补齐完整 metadata、messageTrace、sourceRefs 和调试块

## Recommended Rollout

### Phase 1: Event Channel Only

先不接真实 provider streaming，先打通事件协议：

- 定义 `DesktopTaskEvent`
- runtime / IPC / preload / renderer 全链路打通
- renderer 改为消费事件，而不是本地假流式计时器
- task runner 先只发：
  - `task-started`
  - `task-status`
  - `tool-started`
  - `tool-complete`
  - `task-failed`

这一阶段的目标是：把“真实增量事件通道”先建立起来。

### Phase 2: Runner Final-Response Streaming Hook

在 task runner 中加入 final response 的增量 hook，但先允许使用 mock / fake provider observer 做验证。

目标：

- 证明 runner 能区分工具阶段与最终回答阶段
- 证明 renderer 能稳定更新同一个 assistant entry

### Phase 3: First Provider Real Streaming

选择一个主用 provider 先落地，例如 DeepSeek 或 GitHub Copilot 中当前桌面主要使用的那个。

工作内容：

- 将 chat request 改成 `stream: true`
- 解析 SSE / chunked response
- 抽取 content delta
- 在 final answer 阶段触发 `response-replace` / `response-append`
- 结束时返回标准 `ProviderStepResult`

### Phase 4: Second Provider Streaming

在第一家 provider 跑稳后，再按同样 contract 接入第二家 provider。

## Suggested File Changes

预计会涉及这些文件：

- `src/desktop/shared/ipc-contract.ts`
- `src/desktop/preload/index.ts`
- `src/app/runtime.ts`
- `src/desktop/main/ipc.ts`
- `src/agent/task-runner.ts`
- `src/providers/provider-adapter.ts`
- `src/providers/deepseek-adapter.ts`
- `src/providers/github-copilot-adapter.ts`
- `src/desktop/renderer/App.tsx`

## Testing Strategy

### Adapter Tests

为每个流式 provider 增加：

- SSE / chunk 解析测试
- content delta 聚合测试
- tool-call 与 final answer 边界测试
- finish reason / error path 测试

### Runner Tests

验证：

- tool-call step 只发状态事件，不发自然语言 delta
- final step 发 `response-replace` / `response-append` / `response-complete`
- 失败时发 `task-failed`

### Renderer Tests

验证：

- 同一个 `blockId` 会被 replace / append / finalize，而不是重复插入
- 占位消息会被真实回答替换
- tool 状态块能正确展示

## Open Questions

以下问题留待正式实施时确认：

1. 首个接入 streaming 的 provider 是 DeepSeek 还是 GitHub Copilot。
2. tool 状态块是独立 block，还是挂在 assistant entry 下方。
3. CLI 是否同步消费同一套 progress hook，还是继续保持纯最终输出。
4. `response-replace` 是否需要只在首个 delta 出现时发送一次，后续全部使用 `response-append`。
5. tool-call 前产生的临时文本是否完全丢弃，还是仅用于日志和调试。

## Recommended Next Step

以后正式实施时，建议先做 Phase 1：

- 定义 desktop task event 协议
- 打通 runtime / preload / renderer 事件通道
- 移除 renderer 当前的假流式计时器逻辑

这样可以先把“流式架构骨架”搭好，再逐步把真实 provider streaming 接进来。