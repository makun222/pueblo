# Loop 模块完善需求分析文档

---

## 概述

本文档针对 Pueblo 项目 Loop 模块的三个完善需求进行源码级分析，明确根因、影响范围与修改建议。

---

## 需求一：`validateGoal()` 未阻止模糊目标执行

### 问题陈述

LLM 已在 `validateGoal` / `guardVagueGoal` 阶段判断目标不明确，但 Loop 仍然继续执行，未中断。

### 根因分析

#### 1. `guardVagueGoal` 是占位实现，永不过滤

**文件**: `src/utils/guard-vague-goal.ts`

```typescript
export function guardVagueGoal(goal: string): Result<{ refinedGoal: string }> {
  // placeholder — always passes goal through unchanged
  return { ok: true, data: { refinedGoal: goal } };
}
```

- 该方法**始终返回 `ok: true`**，且 `refinedGoal` 与输入 `goal` 完全相同。
- 无论 LLM 如何判断，该函数都不会产生 `ok: false` 路径，因此 loop 无法得知"目标不明确"。

#### 2. `validateGoal` 在桌面端实现中仅直调 `guardVagueGoal`

**文件**: `src/desktop/main/loop-job-manager.ts` (partial)

```typescript
async validateGoal(goal: string): Promise<Result<{ refinedGoal: string }>> {
  // In a real implementation, this would call the LLM to refine
  return guardVagueGoal(goal);
}
```

- 同样为占位逻辑，无实际 LLM 调用，无驳回路径。

#### 3. 核心执行路径完全跳过 `validateGoal`

**文件**: `src/commands/loop-command.ts`

```typescript
// 用户传入 goal → 直接构造 LoopConfig → 调用 loopRunner.run()
// 全程无 validateGoal 调用
```

**文件**: `src/desktop/main/loop-job-manager.ts`

```typescript
startLoop(config: LoopConfig, ...): string {
  // 直接调用 this.launch(record)，record.config = config
  // launch() 调用 this.loopRunner.run(record.config, ...)
  // 同样无 validateGoal 调用
}
```

**结论**: validateGoal 在 CLI 和桌面端的主执行路径上**从未被调用**，即使 `guardVagueGoal` 被正确实现，也不会产生效果。

### 调用链断点

```
用户输入 goal
    ↓
loop-command.ts (CLI)  /  desktop loop-job-manager.ts (桌面)
    ↓
LoopRunner.run(config, ...)       ← 直接使用 config.goal，无校验
    ↓
loop-runner.ts: runRound 循环     ← 执行中 LLM 可能报目标模糊，但 runner 不处理
```

### 修改建议

1. **实现 `guardVagueGoal` 的 LLM 调用逻辑**：调用 LLM 判断目标是否明确，不明确时返回 `ok: false` 及原因。
2. **在 CLI 入口添加 `validateGoal` 调用**：`loop-command.ts` 在构造 `LoopConfig` 前调用验证。
3. **在桌面端添加 `validateGoal` 调用**：`desktop loop-job-manager.ts` 的 `startLoop()` 在 `launch()` 前调用验证。
4. **失败时的交互策略**：CLI 应输出错误并退出；桌面端应通过 IPC 回传错误给渲染进程并提示用户。

---

## 需求二：主屏幕置顶菜单增加唤出 Monitor Window 的子菜单

### 问题陈述

当前没有任何菜单入口可以打开 Monitor Window（监控所有 Loop Job 的窗口）。

### 现状分析

#### 已有基础设施

| 组件 | 文件路径 | 状态 |
|------|----------|------|
| Monitor Window 创建 | `src/desktop/main/monitor-window.ts` | ✅ 已实现 |
| Monitor 窗口 IPC 通道 | `src/desktop/shared/ipc-contract.ts` → `app:monitor:show` | ✅ 已实现 |
| Monitor 渲染进程 | `src/desktop/renderer/monitor/monitor-renderer.ts` | ✅ 已实现 |
| Monitor HTML | `src/desktop/renderer/monitor/monitor-window.html` | ✅ 已实现 |
| `appWindow.getOrCreateMonitor()` | `src/desktop/main/app-window.ts` | ✅ 已实现 |
| 主应用菜单 | `src/desktop/main/menu.ts` | ❌ **缺少 Monitor 入口** |

#### 当前菜单结构 (`src/desktop/main/menu.ts`)

```
File
  └─ ...
Edit
  └─ ...
View
  └─ ...
Help
  └─ ...
```

- **无**任何指向 monitor 的子菜单项。
- 当前 monitor window 只能通过其他方式（如 IPC 调用 `app:monitor:show`）间接打开，用户无直观入口。

#### IPC 通道分析

`src/desktop/shared/ipc-contract.ts`:

```typescript
'app:monitor:show': () => void;
```

`src/desktop/main/ipc.ts` 中已注册 handler:

```typescript
ipcMain.on('app:monitor:show', () => {
  appWindow.getOrCreateMonitor();
});
```

#### 桌面端 Loop Job Manager 的监控能力

`src/desktop/main/loop-job-manager.ts` 已实现：
- `getAllJobs()` → 返回所有 job 状态
- `getJob(jobId)` → 返回单个 job 详情
- IPC handler 已注册：`loop:list`, `loop:cancel`, `loop:pause`, `loop:resume`

### 修改建议

1. 在 `menu.ts` 中，添加如下菜单路径：

   ```
   View
     ├─ ...
     └─ Monitor                 ← 新增
          ├─ Show Monitor Window  ← 点击调用 app:monitor:show
          └─ (separator)
             └─ (可考虑列出当前运行中的 jobs)
   ```

2. 菜单点击处理：
   - `appWindow.getOrCreateMonitor()` 直接调起窗口。
   - 如果已打开则 `monitorWindow.focus()`。

3. 需要注意：`menu.ts` 运行在主进程，可以直接导入 `appWindow` 实例。

---

## 需求三：Job 进展内容应仅显示每轮 final content，而非全部 step 信息

### 问题陈述

当前 `LoopProgressEvent` 中包含 step 级别的详细中间信息，造成信息冗余。要求仅显示每轮对话的 **final content**（即 `output`）。

### 现状分析

#### 数据流

```
loop-runner.ts: LoopRunner.run()
    ↓ (每轮调用 onProgress)
agent/loop-job-manager.ts: launch() → onProgress callback
    ↓ (保存到 record.results)
    ↓ (通过 IPC: loop:progress 发送到渲染进程)
desktop/renderer/monitor/monitor-renderer.ts: 渲染展示
```

#### `LoopProgressEvent` 定义

**文件**: `src/shared/result.ts` (line 96-145)

```typescript
export interface LoopProgressEvent {
  jobId: string;
  round: number;
  /** Step index within this round (0..n-1). */
  step: number;
  /** Total steps in this round. */
  totalSteps: number;
  /** The raw text produced so far this round. */
  content: string;
  /** Cumulative token usage for this round. */
  tokenUsage: number;
  /** Whether this step is the final output of the round. */
  isFinal: boolean;
  /** Whether this step completes the round. */
  roundComplete: boolean;
}
```

#### 当前进度事件的触发逻辑

在 `loop-runner.ts` 的 `runRound` 执行过程中，每次 LLM 流式产出中间内容时，都会触发 `onProgress` 事件。这意味着：

- 一轮对话中可能触发多次 `onProgress`（step 0, step 1, ... step n），每个 step 携带部分 content。
- 只有 `isFinal === true` 且 `roundComplete === true` 的事件才代表该轮的最终输出。
- 目前 `agent/loop-job-manager.ts` 中的 `formatProgress` 会格式化所有 step 信息并留存到 `results` 数组。

#### 渲染侧展示

`src/desktop/renderer/monitor/monitor-renderer.ts` 当前直接遍历 `job.results[]` 渲染全部事件，未做 final-only 过滤。

### 修改建议

#### 方案 A：发送端过滤（推荐）

在 `agent/loop-job-manager.ts` 的 `onProgress` 回调中：

```typescript
const onProgress = (event: LoopProgressEvent): void => {
  // 仅保留 final round 完成事件
  if (event.roundComplete && event.isFinal) {
    record.results.push(event);
    record.round = event.round;
    if (record.externalOnProgress) {
      record.externalOnProgress(event);
    }
  }
};
```

- 优点：减少 IPC 数据传输量，渲染端无需过滤。
- 注意：这会丢失 step 粒度的进度信息。如果其他消费者（如 CLI 进度条）需要 step 信息，则需要区分对待。

#### 方案 B：渲染端过滤

在 `monitor-renderer.ts` 中，展示时只渲染 `results.filter(e => e.roundComplete && e.isFinal)`。

- 优点：不改变数据模型，保留完整历史。
- 缺点：内存中仍保留全部 step 数据。

#### 推荐：方案 A（发送端过滤）+ 保留 `content` 为 final content

修改 `loop-runner.ts` 中进度事件触发逻辑：

- 仅在 `roundComplete` 时调用一次 `onProgress`，传入该轮最终 `output`。
- 移除 step 粒度的中间进度事件。

同时，如果 CLI 或 UI 需要实时流式显示中间内容，可以考虑使用一个独立的 `onStream` 回调通道，与 `onProgress`（round 级别）分离。

---

## 影响范围汇总

| 需求 | 需修改文件 | 风险等级 | 备注 |
|------|-----------|---------|------|
| 需求一 | `src/utils/guard-vague-goal.ts` | 低 | 需补充 LLM 调用实现 |
| 需求一 | `src/commands/loop-command.ts` | 低 | 添加调用的入口 |
| 需求一 | `src/desktop/main/loop-job-manager.ts` | 低 | 桌面端入口添加调用 |
| 需求一 | `src/agent/loop-runner.ts` | 低 | 可考虑添加备选校验 |
| 需求二 | `src/desktop/main/menu.ts` | 低 | 新增菜单项，与已有 `appWindow` 联动 |
| 需求三 | `src/agent/loop-job-manager.ts` | 中 | 改动进度事件过滤逻辑 |
| 需求三 | `src/agent/loop-runner.ts` | 中 | 调整 onProgress 触发时机 |
| 需求三 | `src/desktop/renderer/monitor/monitor-renderer.ts` | 低 | 适配 final-only 数据展示 |

---

## 实现进度

### ✅ P0 - 需求一（validateGoal）— 已完成

LLM 目标校验已在所有入口集成：

| 文件 | 状态 | 备注 |
|------|------|------|
| `src/utils/guard-vague-goal.ts` | ✅ | 核心 LLM 校验函数完成，导出 `CallModelFn` 类型及 `guardVagueGoal` |
| `src/commands/loop-command.ts` | ✅ | `startLoop()` 中调用 `guardVagueGoal` 校验，失败则返回错误 |
| `src/cli/index.ts` | ✅ | CLI 入口在 `providerId`/`modelId` 确认后插入校验逻辑 |
| `src/desktop/main/loop-job-manager.ts` | ✅ | Desktop 端 `startJob()` 已集成 `validateGoal()` 方法 |
| `src/agent/loop-runner.ts` | - | P0 范围外；P1 中移除 `'running'` emit，保留 `'round-completed'` |

### 已完成事项

#### ✅ P2 - 需求二（Monitor 菜单入口）
在 Desktop 菜单栏新增 Monitor 入口项，与已有 `appWindow` 联动。
- 涉及文件：`src/desktop/main/menu.ts`、`src/desktop/shared/ipc-contract.ts`、`src/desktop/renderer/App.tsx`、`src/desktop/preload/index.ts`、`src/desktop/main/main.ts`
- **变更清单**：
  - `ipc-contract.ts`：`DesktopMenuAction` 新增 `'open-monitor'`；`ElectronAPI` 新增 `focusMonitor()` 声明
  - `menu.ts`：Settings 子菜单新增 「Monitor」条目，发射 `'open-monitor'` 动作
  - `App.tsx`：`onMenuAction` handler 新增 `'open-monitor'` case，调用 `electronAPI.focusMonitor()`
  - `preload/index.ts`：新增 `focusMonitor` 桥接方法
  - `main.ts`：新增 `'loop:focus-monitor'` IPC handler，调用 `focusMonitorWindow()`
- **编译验证**：`npx tsc --noEmit` 零错误

#### ✅ P1 - 需求三（progress 精简）
精简进度事件，只在每轮完成时触发一次 `onProgress`。
- 涉及文件：`src/agent/loop-runner.ts`
- **变更清单**：
  - `loop-runner.ts`：移除每轮开始时发射的 `'running'` progress event（`round` 周期内仅保留 `'round-completed'` 一次发射）
  - 监听方（`loop-job-manager.ts`、`monitor-renderer.ts`）无需改动，因为它们只消费事件
- **编译验证**：`src/` 和 `src/desktop/` 下 `npx tsc --noEmit` 均零错误

### 剩余工作

（无剩余工作 —— 所有需求已完成）

---

## 实现优先级建议（原始记录）

1. **P0 - 需求一（validateGoal）**：功能正确性缺陷，影响核心使用体验。——✅ 已完成
2. **P2 - 需求二（Monitor 菜单入口）**：导航便利性提升，不影响核心功能。——✅ 已完成
3. **P1 - 需求三（progress 精简）**：信息展示调整，影响用户阅读体验。——✅ 已完成

---

## 第二轮优化（2025年7月）

### 优化需求 A：每轮 userInput 使用 prevResult

#### 目标
- **Round 1**：使用 `goal`（或 LLM 改写后的 goal）作为 userInput
- **Round 2+**：使用上一轮 LLM 的 final 返回信息，并附带 `goal` 作为本轮 userInput

#### 现状分析

**ipc.ts（桌面版）— lines 383-402：**

```typescript
const runRound: RunRoundFn = async (config, prevResult, signal) => {
  const taskInput: RunAgentTaskInput = {
    goal: config.goal,          // ← 无论哪一轮都只用原始 goal
    // ...
  };
```

`prevResult` 参数已传入但**未被使用**。所有轮次均以 `config.goal` 作为 `taskInput.goal`，导致每轮用户输入完全一致，无法利用上一轮 LLM 的产出进行递进式对话。

**loop-command.ts（CLI 版）— lines 109-136：**

同样的问题：`prevResult` 未被使用，所有轮次均传递 `config.goal`。

#### `RunAgentTaskInput.goal` 的作用

在 `task-message-builder.ts` line 134 中：
```typescript
messages.push({ role: 'user', content: goal });
```
`goal` 被直接作为 user message 发给 LLM。因此控制 `goal` 字段即控制了每轮的用户输入。

#### 需要的改动

| 文件 | 改动内容 |
|------|----------|
| `src/desktop/main/ipc.ts` | `runRound` 内部判断 `prevResult`：null → 使用 `config.goal`；非 null → 组合 `prevResult.output` + `config.goal` |
| `src/commands/loop-command.ts` | 同上逻辑 |

**Round 1（prevResult === null）**
```
goal = config.goal
```

**Round 2+（prevResult !== null）**
```
goal = `Previous round result:\n${prevResult.output}\n\nOriginal goal: ${config.goal}`
```

#### 关联文件

| 文件 | 角色 | 是否需要改动？ |
|------|------|:----:|
| `src/desktop/main/ipc.ts` | 桌面版 loop 的 `runRound` 实现 | ✅ |
| `src/commands/loop-command.ts` | CLI 版 loop 的 `runRound` 实现 | ✅ |
| `src/agent/loop-runner.ts` | LoopRunner 类，负责传递 `prevResult` | ❌ 已自动传递 |
| `src/agent/task-message-builder.ts` | 消费 `goal` 字段作为 user message | ❌ 无需改动 |
| `src/agent/task-runner.ts` | 定义 `RunAgentTaskInput` | ❌ 无需改动 |

---

### 优化需求 B：简化 context 获取，跳过 `resolve()`

#### 目标
loop 不应使用 `contextResolver.resolve()`（包含大量不必要的 PEPE、memory、mindmap 等处理），只保留：
1. **pueblo-profile** — 用户配置文件
2. **目录信息** — target directory / user directories
3. **skill 信息** — 已加载的 skill

#### 现状分析

**ipc.ts（桌面版）— lines 384-387：**
```typescript
const resolved = await cli.getContextResolver().resolve({
  workspace: workspaceRoot,
  cwd: workspaceRoot,
});
```
然后从中提取 `taskContext` 供 loop 使用。

**loop-command.ts（CLI 版）— lines 109-111：**
```typescript
const resolved = await contextResolver.resolve({
  activeSessionId: session.id,
  cwd,
  workspace: cwd,
});
```
同样调用 `resolve()`。

#### `resolve()` 的完整流程

`ContextResolver.resolve()` 在 `src/agent/context-resolver.ts` 中执行了大量不必要工作：
- ✅ 读取 pueblo-profile（通过 `this.profileLoader.load()`）
- ✅ 解析目录信息（通过 `resolveTargetDirectory()`）
- ✅ 解析 skill 上下文（通过 `resolveSkillContext()`）
- ❌ PEPE 相关（PEPE histories, current state）
- ❌ mindmap/pin 相关
- ❌ 确定性 recall 配置
- ❌ PEPE session context
- ❌ 上下文预算计算
- ❌ 活跃状态检测

#### 需要的改动

用直接读取替代 `resolve()`：

| 数据 | 当前获取方式 | 替代方式 |
|------|-------------|---------|
| pueblo-profile | `resolve()` → profileLoader | 直接 `profileLoader.load(cwd)` |
| 目录信息 | `resolve()` → resolveTargetDirectory | 直接 `resolveTargetDirectory(cwd)` |
| skill 信息 | `resolve()` → resolveSkillContext | 直接 resolve skill context |
| 其他（PEPE, memory, etc.） | unwrap, context selection 等 | **跳过——loop 不需要** |

#### 关联文件

| 文件 | 角色 | 是否需要改动？ |
|------|------|:----:|
| `src/desktop/main/ipc.ts` | 桌面版，替换 `resolve()` 调用 | ✅ |
| `src/commands/loop-command.ts` | CLI 版，替换 `resolve()` 调用 | ✅ |
| `src/agent/context-resolver.ts` | 数据来源 | ❌ 无需改动，直接调用其子方法 |
| `src/utils/profile-loader.ts` | 提供 `load()` 方法 | ❌ 无需改动 |

---

*分析日期: 2025年7月*
*分析人: Pueblo Agent*
