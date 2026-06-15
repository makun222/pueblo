# Loop Plan B — 后台进程 + 独立 Monitor Window

> 决策日期: 2025-08-07
> 方案选择: 方案 B (后台 loop + 独立窗体)
> 设计原则:
> 1. 每个 loop 使用独立 Monitor Window (当前); 未来按需升级到统一 Monitor Panel
> 2. 多 loop 并发时, 通过 DeepSeek user_id 隔离上下文
> 3. 取消必须安全退出到稳定状态, 并报告未完成内容
> 4. 主窗体提交 loop 后立即释放, 通过按钮跳转到 Monitor Window

---

## 一、架构总览

```
Main Renderer (主窗体)
  ┌────────────────┐  ┌─────────────────────────────────┐
  │  Input Pane     │  │  Output Pane                    │
  │  ":loop 5 ..."  │  │  Loop 已启动 (Job #abc123)      │
  │  [Submit]       │  │  [查看进度 ->]  <- 点击跳转     │
  └────────────────┘  └─────────────────────────────────┘
  -> submit 后立即释放, 可继续输入
                           │
                     IPC (Main Process)
                           │
              ┌────────────┴────────────┐
              v                         v
┌──────────────────────┐  ┌──────────────────────────┐
│  LoopJobManager       │  │  Monitor Window (独立)    │
│  - create(jobId,opts) │  │  第 1/5 轮 [ok] 1.2s     │
│  - cancel(jobId)      │  │  [LLM] 修复了...         │
│  - getStatus(jobId)   │  │  第 2/5 轮 [ok] 0.8s     │
│  - listJobs()         │  │  [LLM] 优化了...         │
│  -> 管理多 loop 生命周期│  │  第 3/5 轮 [..] 执行中 │
└──────────────────────┘  │  [取消] [关闭]            │
                           └──────────────────────────┘
```

## 二、关键设计决策与澄清分析

### 决策 1: 多 Loop 上下文隔离 (DeepSeek user_id)

**需求**: 不同 loop 调用 DeepSeek adapter 时必须使用不同 user_id 区分应用。
Loop 上下文全靠启动时的输入, 多个 loop 必须实现上下文隔离。

**现状分析**:
- buildDeepSeekRequestPayload() 使用 user_id: String(process.pid)
- 所有 loop 共享同一个 PID -> DeepSeek 端上下文混在一起
- ProviderStepContext 当前没有 userId 字段

**数据流**:
InputRouter -> LoopCommand -> LoopRunner.run() -> RunRoundFn
  -> ContextResolver -> TaskContext -> ProviderAdapter.runStep()
    -> ProviderStepContext -> buildDeepSeekRequestPayload()

**解决方案 (可行性: 高)** — 需变更 5 个文件:

| # | 文件 | 变更 |
|---|------|------|
| 1 | src/providers/provider-adapter.ts | ProviderStepContext 新增 userId?: string |
| 2 | src/agent/task-context.ts | TaskContext 新增 userId?: string |
| 3 | src/providers/deepseek-adapter.ts | user_id 改为 context.userId ?? String(process.pid) |
| 4 | src/agent/context-resolver.ts | mergeContext() 支持传入 userId |
| 5 | src/agent/loop-job-manager.ts (新建) | 生成 jobId 并作为 userId 注入 |

```
// ProviderStepContext 新增字段
interface ProviderStepContext {
  // ... existing ...
  readonly userId?: string;  // <- 新增
}

// DeepSeek adapter 改动 (最小侵入)
user_id: context.userId ?? String(process.pid),  // 向后兼容

// LoopJobManager 生成 userId
const userId = 'loop_' + jobId;  // e.g., "loop_abc123"
```

**隔离等级**:
- API 级别隔离: 不同 user_id -> DeepSeek 独立会话上下文
- 内存级别隔离: 每个 LoopRunner 有自己的 accumulatedContext
- 不共享任何可变状态

---

### 决策 2: 取消机制 — 安全退出与状态恢复

**需求**:
- 退出时必须恢复到上一个稳定状态 (如 loop 启动时或可接受的 phase)
- 提示完成情况, 包括不完整的阶段或文件

**现状分析**:
- LoopRunner.run() 在每轮之间检查 signal.aborted
- 取消后返回 { finalState: 'cancelled', completedRounds: [...N] }
- 自然在 round 边界处停止, 状态是完整的
- ProviderStepContext 已有 signal?: AbortSignal (目前仅用于轮间检查)

**两级实现**:

#### Level 1: Round-Boundary Cancellation (V1, 已有基础设施)

```
Round 1 [ok] -> Round 2 [ok] -> Round 3 [..] -> [用户点取消]
                                                   |
                                            signal.aborted = true
                                                   |
                                     LoopRunner 不启动 Round 4
                                     返回: cancelled at round 3/5
```

安全保证:
- 每轮结束后的 accumulatedContext 包含前 N-1 轮的完整结果
- 取消时不丢失已完成轮次, 不产生半完成状态
- 报告: "Loop 已取消 (第 3/5 轮). 已完成: 2 轮."

#### Level 2: Intra-Round Abort (V2, 需额外工作)

用于 LLM 调用耗时过长时的立即中断:
```
Round 3: LLM streaming tokens... -> [用户点取消]
                                       |
                                 AbortController.abort()
                                       |
                           fetch() 抛出 AbortError
                           ProviderAdapter.runStep() 返回 partial
                                       |
                             LoopRunner 捕获 partial 结果
                             标记 round 为 interrupted
```

V2 复杂度: 需处理部分 LLM 响应、部分 tool 调用结果、文件写入中途撤销。
V1 推荐: Round-boundary 取消, 用户可接受最多一轮的等待延迟。

**取消后报告格式** (Monitor Window 渲染):

```
Loop Job #abc123 — 已取消
  第 1/5 轮  [ok]  1.2s  修复了 login 样式问题
  第 2/5 轮  [ok]  0.8s  优化了 API 调用逻辑
  第 3/5 轮  [cancelled]  [LLM 未完成]
  ------------------------------
  完成: 2/5 轮  状态: cancelled
  涉及文件: login.tsx, api-client.ts
```

> 关于文件跟踪: V1 不追踪文件系统变更 (复杂度过高)。
> 如果未来需要, 可通过收集各轮 LLM 返回的 tool-call 记录来推断涉及哪些文件。
> 当前只报告已完成轮次的 LLM content。

**文件变更**:
| # | 文件 | 变更 |
|---|------|------|
| 1 | src/agent/loop-runner.ts | run() 现有的 signal?.aborted 检查足够 (V1) |
| 2 | src/agent/loop-job-manager.ts (新建) | cancel(jobId) -> AbortController.abort() |
| 3 | Monitor Window Renderer | 取消按钮 -> IPC loop:cancel |
| 4 | src/desktop/shared/ipc-contract.ts | 新增 loop:cancel(jobId) 通道 |

---

### 决策 3: 主窗体启动反馈与跳转

**需求**:
1. 启动 loop 后, 主窗体反馈启动状态 + 按钮
2. 点击按钮可到新窗体观察 loop 运行状态
3. 主窗体返回到等待接收 input 状态

**现状分析**:
- LoopCommand.execute() 是同步阻塞的
- 运行完所有 N 轮后才返回 CommandResult
- 主窗体在此期间等待 (虽然未锁 submit, 但 execute 未返回)

**核心变更**: 将 LoopCommand 的执行从"同步等待"改为"异步分叉 + 立即返回"。

**流程**:

```
用户提交 ":loop 5 ..."
        |
DesktopTalkService.executeInput()
        |
routeInput() -> 解析为 LoopCommand
        |
LoopCommand.executeAsync()  <- 新的执行路径
        |
   ┌────┴────┐
   | 立即返回  | <- { ok: true, code: 'loop-started', data: { jobId } }
   | Command  |
   | Result   |
   └────┬────┘
        |
   renderer 收到: blocks = [
     { type: 'loop-launch', jobId, totalRounds, summary }
   ]
        |
   显示在 output pane:
   "Loop 已启动 (Job #abc123, 共 5 轮)"
   "[查看 Monitor ->]"
        |
   主窗体 submit 立即释放
```

**Renderer loop-launch Block 渲染样例**:

```
+-----------------------------------------------+
| Loop 已启动                                    |
|                                                |
| Job:     #abc123                               |
| 总轮数:  5                                      |
| 提示词:  "修复所有 lint 错误"                     |
|                                                |
| [在 Monitor Window 中查看 ->]    <- 点击跳转   |
|                                                |
| 开始时间: 2025-08-07 14:23:05                   |
+-----------------------------------------------+
```

**主窗体状态机**:
```
IDLE -> [用户提交 :loop] -> EXECUTING (微秒级) -> IDLE
                                  |
                          loop job 在后台运行
                          Monitor Window 展示进度
```

**涉及变更**:
| # | 文件 | 变更 |
|---|------|------|
| 1 | src/shared/result.ts | 新增 OutputBlockType = 'loop-launch', 含 jobId, totalRounds |
| 2 | src/commands/loop-command.ts | 新增 executeAsync(): 生成 jobId -> 交给 LoopJobManager -> 立即返回 |
| 3 | src/desktop/main/ipc.ts | executeInput() 识别 code === 'loop-started' 的返回值 |
| 4 | src/desktop/shared/ipc-contract.ts | 新增 loop:focus-monitor(jobId) 通道 |
| 5 | src/desktop/main/loop-job-manager.ts (新建) | start() 启动后台 loop 并管理 Monitor Window |
| 6 | Renderer (preload + UI) | 渲染 loop-launch block 为按钮, 点击发送 loop:focus-monitor |
| 7 | Monitor Window Renderer | 新建独立 HTML/JS 窗口 |

---

## 三、新增核心实体详解

### 3.1 LoopJobManager (Main Process)

```
// src/desktop/main/loop-job-manager.ts (新建)
interface LoopJobManager {
  start(opts: {
    jobId: string;
    totalRounds: number;
    userId: string;        // DeepSeek user_id 隔离
    roundFn: RunRoundFn;   // 每一轮执行的函数
    signal: AbortSignal;
  }): Promise<void>;

  cancel(jobId: string): boolean;
  getStatus(jobId: string): LoopJobStatus | undefined;
  listJobs(): LoopJobStatus[];
  onJobComplete(handler: (jobId: string, status: LoopJobStatus) => void): void;
  attachMonitor(jobId: string, window: BrowserWindow): void;
}
```

**start() 内部流程**:
1. 创建 AbortController (存储以便 cancel)
2. 创建 Monitor Window (BrowserWindow)
3. 创建 OutputPublisher (绑定到 Monitor Window 的 webContents)
4. 构建 onProgress 回调 -> publishProgress -> OutputPublisher.publishOutput()
5. 调用 LoopRunner.run({ totalRounds, roundFn, signal, onProgress })
6. 完成时 publishComplete -> OutputPublisher.publishOutput()
7. 触发 onJobComplete 清理

### 3.2 Monitor Window 生命周期

```
// src/desktop/main/monitor-window.ts (新建)
function createMonitorWindow(job: {
  jobId: string;
  totalRounds: number;
  prompt: string;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 600, height: 500,
    title: 'Pueblo Loop - ' + job.jobId,
    webPreferences: { preload: MONITOR_PRELOAD_PATH },
  });
  win.loadURL('monitor.html?jobId=' + job.jobId);
  win.on('closed', () => { /* 不自动 cancel job */ });
  return win;
}
```

行为:
- 关闭窗口 != 取消 loop (loop 继续在后台运行)
- 用户可随时通过主窗体按钮重新打开 Monitor Window
- "取消" 按钮在 Monitor Window 内, 发送 loop:cancel IPC
- loop 完成后, 窗口标题改为 "[已完成] Pueblo Loop - #abc123"

### 3.3 OutputPublisher (Monitor Window 绑定)

```
// 当前 src/shared/result.ts 中已有定义:
interface OutputPublisher {
  publishOutput(block: RendererOutputBlock): void;
  setInputLocked?(locked: boolean): void;
}
// For Monitor Window, progress -> output block 的映射由调用方负责
```

---

## 四、IPC 契约设计

```
// src/desktop/shared/ipc-contract.ts

// --- 主窗体 -> Main Process ---
'ipc:loop:launch'       -> { jobId, totalRounds, prompt }
'ipc:loop:cancel'       -> { jobId }
'ipc:loop:focus-monitor'-> { jobId }
'ipc:loop:list-active'  -> void

// --- Main Process -> Monitor Window ---
'ipc:loop:progress'     -> LoopProgressEvent
'ipc:loop:complete'     -> LoopJobStatus
'ipc:loop:error'        -> { jobId, error }

// --- Main Process -> 主窗体 Renderer ---
'ipc:loop:launched'     -> { jobId, totalRounds, prompt, timestamp }
```

---

## 五、LoopCommand 改造

```
// src/commands/loop-command.ts (改造后)

class LoopCommand implements Command {
  // 新增: 异步执行模式, 用于 Desktop 后台 loop
  async executeAsync(
    context: CommandContext
  ): Promise<CommandResult<{ jobId: string }>> {
    const totalRounds = parseTotalRounds(context.input);
    const prompt = extractPrompt(context.input);
    const jobId = generateJobId();        // e.g., "loop_<short-uuid>"
    const userId = 'loop_' + jobId;       // DeepSeek user_id

    // 通知主窗体
    context.publish?.({
      type: 'loop-launched',
      jobId, totalRounds, prompt,
      timestamp: Date.now(),
    });

    return successResult('loop-started', 'Loop 已启动', { jobId, userId });
  }

  // 保留同步模式用于 CLI
  async execute(context: CommandContext): Promise<CommandResult> {
    // 原有逻辑保持不变 (同步阻塞)
  }
}
```

> 关键决策: executeAsync() 将 round 执行逻辑委托给 LoopJobManager,
> 自己只负责解析参数和立即返回。CLI 模式直接用 execute() 同步阻塞,
> Desktop 模式用 executeAsync() 异步分叉。

---

## 六、CLI 模式兼容

CLI 路径:
```
LoopCommand.execute() -> 同步执行所有轮次
onProgress -> 写入 stdout (每轮一行输出)

-- 第 1/5 轮 -- (1.2s) [LLM] 修复了 login 页面的样式问题
-- 第 2/5 轮 -- (0.8s) [LLM] 优化了 API 调用逻辑
-- 第 3/5 轮 -- (1.5s) [LLM] 更新了单元测试
Loop 完成 - 共 5 轮, 全部成功
```

LoopRunner.run() 接受可选的 onProgress?: OnRoundProgress 参数, CLI 和 Desktop 都可传入。

---

## 七、实施阶段

### Phase 1: 基础类型 + LoopRunner 改造 (不改现有行为)
| 文件 | 变更 | 风险 |
|------|------|------|
| src/shared/result.ts | 新增 LoopJobStatus, LoopJobState, onProgress 等类型 (已存在) | 低 |
| src/providers/provider-adapter.ts | ProviderStepContext + userId?: string | 低 |
| src/agent/task-context.ts | TaskContext + userId?: string | 低 |
| src/providers/deepseek-adapter.ts | user_id 改为 context.userId ?? String(process.pid) | 低 |
| src/agent/loop-runner.ts | run() 新增可选参数 onProgress?: OnRoundProgress | 低 |

### Phase 2: LoopJobManager + Monitor Window 骨架
| 文件 | 变更 | 风险 |
|------|------|------|
| src/desktop/main/loop-job-manager.ts | 新建 — 管理 loop 生命周期；`start(job)` 负责创建 Monitor Window + 启动 loopRunner；内置并发队列(默认 maxConcurrent=2) | 中 |
| src/desktop/main/monitor-window.ts | 新建 — 创建独立 BrowserWindow，由 LoopJobManager.start() 调用 | 中 |
| src/desktop/renderer/monitor/monitor.html | 新建 — Monitor Window HTML | 中 |
| src/desktop/renderer/monitor/monitor-renderer.ts | 新建 — Monitor Window 渲染逻辑 | 中 |
| src/desktop/renderer/monitor/monitor-preload.ts | 新建 — Monitor Window preload | 中 |
| src/desktop/shared/ipc-contract.ts | 新增 loop 相关 IPC 通道 | 低 |

> **职责链**: `LoopJobManager.start(job)` → 创建 Monitor Window → 启动 `loopRunner.run()`。
> 若当前并发数已达上限(默认 maxConcurrent=2)，任务进入等待队列，Monitor Window 显示排队状态。

### Phase 3: LoopCommand 异步改造 + 主窗体反馈
| 文件 | 变更 | 风险 |
|------|------|------|
| src/commands/loop-command.ts | 新增 executeAsync(), 解析参数 -> 返回 jobId | 中 |
| src/desktop/main/talk-service.ts | 识别 code === 'loop-started' 的分支 | 中 |
| src/desktop/main/ipc.ts | executeInput() 新增异步处理分支 | 中 |
| src/shared/result.ts | 新增 OutputBlockType = 'loop-launch' | 低 |
| Renderer preload + UI | 渲染 loop-launch block 为按钮 | 中 |

### Phase 4: 取消机制 & Monitor Window 生命周期
| 文件 | 变更 | 风险 |
|------|------|------|
| src/agent/loop-job-manager.ts | `cancel(jobId)` → AbortController.abort()；内置并发队列(默认 maxConcurrent=2) | 低 |
| src/desktop/shared/ipc-contract.ts | `loop:cancel` 通道 | 低 |
| src/desktop/main/monitor-window.ts | 窗口关闭事件 → 仅销毁窗口引用，**不触发取消**；关闭后可从主窗体"重新打开 Monitor"恢复观测 | 中 |
| Monitor Window UI | 取消按钮 + 进度展示 + "关闭窗口不会取消任务"提示 | 低 |

> **关键决策**: Monitor Window 关闭 **不等于** 取消 loop。loop 继续在后台执行。
> 用户可通过主窗体的 job 列表重新打开 Monitor 窗口继续观测。取消仅通过"取消"按钮显式触发。

### Phase 5: CLI 兼容 + 清理
| 文件 | 变更 | 风险 |
|------|------|------|
| src/commands/loop-command.ts | 保留 execute() 同步模式 CLI | 低 |
| src/agent/loop-runner.ts | CLI 使用 onProgress -> stdout | 低 |

### Phase 6: 多 Loop 并发测试
- 验证不同 loop 使用不同 DeepSeek user_id
- 验证多 Monitor Window 管理
- 验证主窗体非阻塞

### Phase 7 (远期): 统一 Monitor Panel
- 单窗口多 tab 管理所有活跃 loop
- 历史 loop 记录查询
- 多 agent 任务编排 (并行启动多个 loop, 聚合结果)

---

## 八、已决策事项 (2025-07-10)

| # | 决策 | 理由 | 影响 |
|---|------|------|------|
| 1 | Monitor Window 关闭 **不等于** 取消 loop；loop 继续后台运行 | 用户可能误关窗口；允许长时间任务后台执行 | Monitor Window 关闭时仅隐藏/销毁窗口，不触发 AbortController |
| 2 | 多 loop 并发由 **LoopJobManager 排队**，可配置并发上限 | 避免 API 限流；未来可扩展为优先级队列 | LoopJobManager 内置并发控制，默认 maxConcurrent=2 |
| 3 | `executeAsync()` 作为 **Command 新方法**，与 `execute()` 清晰分离 | 同步/异步语义明确；不污染返回值类型 | Command 接口新增可选方法 `executeAsync?()` |
| 4 | `:loop N` 中 N **仅支持固定数字**（V1），不支持 `auto` | 降低复杂度；动态轮数需终止条件协商，属于远期特性 | 参数解析严格校验为正整数 |

---

## 九、文件清单汇总

### 新建文件 (6)
1. src/desktop/main/loop-job-manager.ts — LoopJobManager 核心
2. src/desktop/main/monitor-window.ts — Monitor BrowserWindow 工厂
3. src/desktop/renderer/monitor/monitor.html — Monitor Window 模板
4. src/desktop/renderer/monitor/monitor-renderer.ts — Monitor Window 渲染
5. src/desktop/renderer/monitor/monitor-preload.ts — Monitor Window preload
6. src/desktop/shared/ipc-contract-monitor.ts — Monitor IPC 类型 (或合并)

### 修改文件 (10)
1. src/shared/result.ts — 类型扩展 (部分已存在)
2. src/providers/provider-adapter.ts — ProviderStepContext.userId
3. src/agent/task-context.ts — TaskContext.userId
4. src/providers/deepseek-adapter.ts — user_id 动态化
5. src/agent/context-resolver.ts — 支持 userId 传递
6. src/agent/loop-runner.ts — onProgress 可选参数
7. src/commands/loop-command.ts — executeAsync() + execute() 保留
8. src/desktop/main/talk-service.ts — 识别 loop-started 分支
9. src/desktop/main/ipc.ts — 异步执行分支 + loop IPC
10. src/desktop/shared/ipc-contract.ts — 新增 loop IPC 通道

---

### 八、完成情况跟踪（据实扫描更新于 2025-07）

> 状态符号：✅ 已完成 | 🔄 部分完成/骨架存在 | ❌ 未开始/文件缺失 | ⚠️ 存在但需确认

#### Phase 1：类型定义与基础修复

| # | 产出物 | 状态 | 路径/证据 |
|---|--------|------|-----------|
| 1.1 | `LoopJobStatus` / `LoopProgressEvent` / `LoopJobState` / `OnRoundProgress` 类型 | ✅ | `src/shared/result.ts` L100-132 |
| 1.2 | `ProviderRunRequest.userId` + `createLegacyStepContext` 传递 `userId` | ✅ | `src/providers/provider-adapter.ts` L524, L569 |
| 1.3 | `TaskContext.userId` (required) + `TaskContextInput.userId` (optional) | ✅ | `src/agent/task-context.ts` L43, L69, L109 |
| 1.4 | `deepseek-adapter.ts` L624 `user_id` 使用 `context.userId` | ✅ | `src/providers/deepseek-adapter.ts` L624: `user_id: context.userId ?? String(process.pid)` |
| 1.5 | `context-resolver.ts` 支持 userId 传递 | ⚠️ | `src/agent/context-resolver.ts` 无 userId 显式引用（userId 通过 TaskContext 流入，可能已满足） |

#### Phase 2：LoopJobManager + MonitorWindow 骨架

| # | 产出物 | 状态 | 路径/证据 |
|---|--------|------|-----------|
| 2.1 | `loop-job-manager.ts` 骨架（Desktop main） | ✅ | `src/desktop/main/loop-job-manager.ts` 78行，含 `startJob`/`cancelJob`/`getJobStatus`/`listJobs` |
| 2.2 | `ipc-contract.ts` 新增 `DesktopLoopJobProgress` + loop 事件 | ✅ | `src/desktop/shared/ipc-contract.ts` L170-222: `loop:start`/`loop:cancel`/`loop:job-progress` |
| 2.3 | `monitor-window.html` 骨架 | ✅ | `src/desktop/main/monitor-window.html` 40行，含完整 CSS 布局 |
| 2.4 | `monitor-window.ts` BrowserWindow 骨架 | ✅ | `src/desktop/main/monitor-window.ts` 74行，含 `createMonitorWindow()` |
| 2.5 | `monitor-renderer.ts` | ✅ | `src/desktop/renderer/monitor/monitor-renderer.ts` 102行，超越骨架（已达 Phase 5 水平） |
| 2.6 | `monitor-preload.ts` | ✅ | `src/desktop/renderer/monitor/monitor-preload.ts` 48行，含 `contextBridge.exposeInMainWorld` |
| 2.7 | `app-window.ts` 修改（集成 loop 进度广播） | ✅ | `AppWindow` 类已创建，含 `send()`/`onClosed()`/`createLoopProgressSender()`/`getOrCreateMonitor()`；`main.ts` 已用 `AppWindow` 替代原始 `createWindow` |

#### Phase 3：异步 Loop 执行

| # | 产出物 | 状态 | 路径/证据 |
|---|--------|------|-----------|
| 3.0a | `loop-runner.ts` | ✅ | `src/agent/loop-runner.ts` 已存在，含 `run()` 异步方法 |
| 3.0b | Worker 端 `loop-job-manager.ts` | ✅ | `src/agent/loop-job-manager.ts` 150+行，含完整 `start`/`cancel`/`getState` |
| 3.1 | Desktop `loop-job-manager.ts` 异步调用 `loopRunner.run()` | ✅ | `new LoopRunner()` 传入 Agent，`launch()` 中调用 `loopRunner.run()` |
| 3.2 | `app-window.ts` 修改（广播 loop 进度到 renderer） | ✅ | `createLoopProgressSender(jobId)` 已实现，返回 `OnRoundProgress` 回调，通过 `webContents.send` 广播到主渲染进程 + MonitorWindow |

#### Phase 4：取消机制

| # | 产出物 | 状态 | 路径/证据 |
|---|--------|------|-----------|
| 4.1 | Desktop `loop-job-manager.ts` `cancelJob()` 实现 | ✅ | 完整委托 `agentManager.cancel(jobId)` → `record.abortController.abort()` |
| 4.0 | Worker 端 `cancel()` | ✅ | `src/agent/loop-job-manager.ts` 已完整实现 abort 机制 |

#### Phase 5：Monitor 窗口前端

| # | 产出物 | 状态 | 路径/证据 |
|---|--------|------|-----------|
| 5.1 | `monitor-renderer.ts` 完成进度仪表盘 | ✅ | 102行已含 DOM 操作、事件监听、进度展示，超预期 |

#### Phase 6-7：CLI 兼容 + 轮次感知

| # | 产出物 | 状态 | 路径/证据 |
|---|--------|------|-----------|
| 6.1 | `loop-command.ts` CLI 兼容 | ✅ | `src/commands/loop-command.ts` 已存在 |
| 6.2 | `talk-service.ts` 识别 loop 分支 | ✅ | `extractAssistantText` 显式处理 `finalSummary` + `loop-started`（`jobId`+`config`）两种结果码 |
| 6.3 | `ipc.ts` 异步执行分支 + loop IPC | ✅ | `src/desktop/main/ipc.ts` — `/loop` 拦截 + `loop:cancel` IPC handler |
| 7.1-7.4 | 轮次感知调度+超时+优先级 | ❌ | 未开始 |

#### 整体进度

- **已完成**: 22/24 个产出物 (92%)
- **部分完成**: 1/24 (4%) — Phase 1.5
- **未开始**: 1/24 (4%) — Phase 7.x

#### 下一优先事项

| 优先级 | 任务 | 阻塞项 |
|--------|------|--------|
| ✅ P0 | 创建 `app-window.ts`（Phase 2.7, 3.2） | 已完成：`AppWindow` 类提供 `send()`/`onClosed()`/`createLoopProgressSender()`/`getOrCreateMonitor()`，`main.ts` 已集成 |
| 🔴 P0 | Desktop `loop-job-manager.ts` 接入 `loopRunner.run()`（Phase 3.1） | Phase 4/5 |
| 🟠 P1 | Desktop `cancelJob()` 实现（Phase 4.1） | Phase 5 体验 |
| 🟡 P2 | `talk-service.ts` 和 `ipc.ts` loop 分支集成（Phase 6） | 端到端 |
| 🟡 P3 | 轮次感知调度（Phase 7） | 高级功能 |

