# Loop 命令实时进度显示方案设计

> 版本: v1.0
> 日期: 2025-07
> 状态: 设计草案

---

## 1. 背景与目标

### 1.1 现状问题

当前 `command:loop` 的执行模型是"全同步"的：

```
用户输入 loop 10 → LoopRunner.run() → 静默执行 N 轮 → 返回 LoopResult
                                                                  └── 最终才展示所有轮次结果
```

- 用户在执行期间看不到任何中间进展
- 如果某轮卡住或耗时过长，用户无法判断当前状态
- 无中断机制（虽已传入 AbortSignal，但无 UI 层面的取消触发）

### 1.2 核心目标

1. **实时可见性**：每轮完成后，立即显示该轮的摘要信息（当前轮次、LLM 返回的最终 content）
2. **可控性**：允许用户在 loop 执行过程中取消
3. **可扩展性**：为未来多 agent 任务编排、并行 loop 等场景预留架构

---

## 2. 两种方案对比

| 维度 | 方案 A：当前面板实时更新（锁定 Submit） | 方案 B：后台进程 + 新面板展示 |
|------|----------------------------------------|-------------------------------|
| **交互模型** | 主面板 output area 实时追加进度块 | 弹出新面板/窗口显示进度 |
| **锁定行为** | 锁定 submit 按钮，禁止新输入 | 当前面板不锁定，继续可用 |
| **中断方式** | 面板内提供取消按钮 | 新面板提供取消/关闭按钮 |
| **实现复杂度** | ★★☆（中等） | ★★★★（高） |
| **用户体验** | 直观但阻塞主交互 | 灵活但注意力分散 |
| **多 agent 扩展** | 需额外改造 | 天然支持（每个 agent 一个面板） |
| **后端改动** | LoopRunner + 输出管道 | 需引入独立会话/工作流系统 |

### 2.1 推荐策略：以方案 A 为近期目标，方案 B 为远期架构

**原因**：
- 方案 A 改动范围可控，快速解决核心痛点
- LoopRunner 引入 callback/progress 机制后，方案 B 可复用同一接口
- 多 agent 任务编排需要更成熟的工作流引擎（当前已有 WorkflowService 基础）

---

## 3. 详细设计方案

### 3.1 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                    命令层（loop-command.ts）                    │
│  ┌──────────┐  创建  ┌──────────────┐   生产   ┌──────────┐ │
│  │  用户输入 │ ───→  │ LoopController │ ───→  │ OutputBlock│ │
│  └──────────┘        │ (进度订阅者)  │         │ (增量)   │ │
│                      └──────┬───────┘         └──────────┘ │
├─────────────────────────────┼────────────────────────────────┤
│                    业务逻辑层                                │
│  ┌──────────────────────────▼──────────────────────────┐    │
│  │               LoopRunner (增强)                      │    │
│  │  - run(llm, signal, onRoundComplete?)                │    │
│  │  - 每轮完成后调用 onRoundComplete(roundIndex, result) │    │
│  └──────────────────────────┬──────────────────────────┘    │
│                             │                                │
│  ┌──────────────────────────▼──────────────────────────┐    │
│  │               TaskRunner (不变)                      │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                    输出层                                    │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ CLI stdout   │    │ Desktop Renderer  │                   │
│  │ 增量写入     │    │ 增量追加 OutputBlock│                  │
│  └──────────────┘    └──────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 LoopRunner 改造（核心变更）

#### 3.2.1 新增进度回调类型

```typescript
// src/agent/loop-runner.ts

/** 单轮完成时的进度事件 */
export interface RoundProgressEvent {
  /** 轮次编号（从 0 开始） */
  readonly roundIndex: number;
  /** 总轮数 */
  readonly totalRounds: number;
  /** 该轮 LLM 返回的最终消息内容（summary） */
  readonly roundContent: string;
  /** 该轮耗时（毫秒） */
  readonly durationMs: number;
  /** 该轮是否成功 */
  readonly success: boolean;
  /** 该轮的任务步骤摘要（可选，用于预览） */
  readonly stepSummary?: string;
}

/** 进度回调类型 */
export type OnRoundProgress = (event: RoundProgressEvent) => void;
```

#### 3.2.2 run() 签名变更

```typescript
// src/agent/loop-runner.ts

// 现有签名
run(config: LoopConfig, runRound: RunRoundFn): Promise<LoopResult>;

// 变更后
run(
  config: LoopConfig,
  runRound: RunRoundFn,
  onProgress?: OnRoundProgress,  // ← 新增
): Promise<LoopResult>;
```

`RunRoundFn` 现有签名保持不变：
```typescript
type RunRoundFn = (
  round: number,
  totalRounds: number,
  goal: string,
  accumulatedContext: string,
) => Promise<{ output: string; tokenUsage: number }>;
```

`LoopResult` 中的 `rounds` 数组项已有 `output` 字段（即 LLM 返回内容摘要），可复用于进度事件。

#### 3.2.3 run() 中进度回调的实现模式

`LoopRunner` 是具体类（非抽象），`run()` 方法接收 `RunRoundFn` 回调。进度注入点在 `LoopRunner.run()` 方法内部——在每轮 `runRound()` 调用完成后：

```typescript
// src/agent/loop-runner.ts（修改后）

class LoopRunner {
  async run(
    config: LoopConfig,
    runRound: RunRoundFn,
    onProgress?: OnRoundProgress,   // ← 新增可选参数
  ): Promise<LoopResult> {
    const rounds: Array<{ output: string; tokenUsage: number }> = [];
    const totalRounds = config.maxRounds;

    for (let i = 0; i < totalRounds; i++) {
      // ... existing round execution ...
      
      const startTime = Date.now();
      const accumulatedContext = buildAccumulatedContext(rounds);
      const result = await runRound(i, totalRounds, config.goal, accumulatedContext);
      const durationMs = Date.now() - startTime;
      
      rounds.push(result);
      
      // 进度回调：每轮完成后立即通知
      if (onProgress) {
        onProgress({
          roundIndex: i,
          totalRounds,
          roundContent: result.output,       // RunRoundFn 返回值中的 output
          durationMs,
          success: true,
        });
      }
      
      // ... continue loop (check met-goal, etc.) ...
    }

    return { state: 'completed', rounds, ... };
  }
}
```

> **设计权衡**：`onProgress` 为可选参数，确保现有 `LoopRunner.run()` 调用方无需修改。`RunRoundFn` 纯函数语义不变，progress 是从外部注入的横切关注点。

### 3.3 命令层改造

#### 3.3.1 loop-command.ts 的 OutputBlock 增量写入

命令处理器负责将进度事件转换为 `RendererOutputBlock` 并推送到输出管道。

```typescript
// src/commands/loop-command.ts

async function handleLoopCommand(context: CommandContext): Promise<CommandResult<LoopResult>> {
  const runner = createLoopRunner();
  const outputBlocks: RendererOutputBlock[] = [];
  
  // 初始状态块
  outputBlocks.push(createOutputBlock({
    type: 'system',
    title: '🔄 Loop 开始',
    content: `计划执行 ${rounds} 轮`,
  }));
  
  const result = await runner.run(llm, signal, (progress) => {
    // 每轮完成时，生成一个结果块并推送
    const block = createOutputBlock({
      type: 'command-result',
      title: `第 ${progress.roundIndex + 1}/${progress.totalRounds} 轮`,
      content: formatRoundContent(progress),
      collapsed: false,
    });
    
    outputBlocks.push(block);
    
    // 【桌面端】实时推送到 renderer
    context.publishOutput?.(block);
    
    // 【CLI 端】实时写入 stdout
    context.writeLine?.(formatRoundContent(progress));
  });
  
  // 最终汇总块
  outputBlocks.push(createOutputBlock({
    type: 'command-result',
    title: '✅ Loop 完成',
    content: `共 ${rounds} 轮，成功 ${successCount} 轮`,
  }));
  
  return successResult(outputBlocks, result);
}
```

#### 3.3.2 输出管道抽象

```typescript
// src/shared/result.ts（新增类型）

/** 命令上下文中的实时输出接口 */
export interface OutputPublisher {
  /** 推送一个输出块（桌面端：IPC → Renderer） */
  publishOutput(block: RendererOutputBlock): void;
  /** 写入一行文本（CLI 端：stdout） */
  writeLine(text: string): void;
  /** 获取当前累计的输出块快照（用于最终汇总） */
  getSnapshot(): readonly RendererOutputBlock[];
}
```

#### 3.3.3 桌面端：submit 按钮锁定机制

```typescript
// src/desktop/main/talk-service.ts

/** 锁定/解锁输入框 */
async function setInputLocked(locked: boolean): void {
  // 通过 IPC 发送 LockStateChange 消息到 renderer
  await win.webContents.send('input-lock-change', { locked });
}

// loop 执行流程中的锁定时序
async function executeLoopCommand(...) {
  await setInputLocked(true);   // 锁定 submit
  try {
    const result = await loopRunner.run(llm, signal, onProgress);
    return result;
  } finally {
    await setInputLocked(false); // 解锁 submit
  }
}
```

### 3.4 CLI 端改造

```typescript
// src/cli/index.ts（loop 路径的改造）

if (result.outputBlocks) {
  // 传统方式：一次性输出全部
  // process.stdout.write(formatCommandResult(result));
  
  // 新方式：已通过 writeLine 增量输出，只需输出最终汇总
  process.stdout.write(formatFinalSummary(result));
}
```

CLI 端改造较轻：`context.writeLine` 直接写入 `process.stdout`，用户可实时看到每轮进展。

### 3.5 Renderer（Electron 前端）改造

```typescript
// Renderer IPC 监听

// 1. 接收增量 OutputBlock
window.electron.ipcOn('output-block', (block: RendererOutputBlock) => {
  appendToOutputPane(block);  // 追加到 output area
});

// 2. 接收输入锁定状态
window.electron.ipcOn('input-lock-change', ({ locked }) => {
  submitButton.disabled = locked;
  if (locked) {
    showCancelButton();       // 显示取消按钮
  } else {
    hideCancelButton();
  }
});

// 3. 取消逻辑
cancelButton.onclick = () => {
  window.electron.ipcSend('cancel-loop');
};
```

---

## 4. 交互流程示例

### 4.1 桌面端交互时序

```
用户: :loop 5

┌──────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐
│用户  │  │ Renderer │  │ 主进程   │  │ LoopRunner│  │ LLM   │
└──┬───┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └───┬────┘
   │  :loop 5   │             │              │            │
   │───────────→│   dispatch  │              │            │
   │            │────────────→│ 创建 Runner  │            │
   │            │             │─────────────→│            │
   │            │ 锁定输入    │              │            │
   │            │←─lock(true)─│              │            │
   │ 锁定Submit │             │              │            │
   │←───────────│             │              │            │
   │            │  系统块     │              │ 第 1 轮    │
   │            │←─"loop 开始"│             │───────────→│
   │            │             │              │←──response─│
   │            │             │              │            │
   │            │             │ onProgress() │            │
   │            │←─结果块 1──│ (第 1 轮完成) │            │
   │ 显示结果 1 │             │              │            │
   │            │             │              │ 第 2 轮    │
   │            │             │ onProgress() │───────────→│
   │            │←─结果块 2──│ (第 2 轮完成) │←──response─│
   │ 显示结果 2 │             │              │            │
   │    ...     │    ...      │     ...      │    ...     │
   │            │             │              │            │
   │            │ 解锁输入    │  Loop 完成   │            │
   │            │←─lock(false)│←────────────│            │
   │ 解锁Submit │             │              │            │
   │←───────────│             │              │            │
   │            │  汇总结果块 │              │            │
   │            │←─"loop 完成"│              │            │
```

### 4.2 CLI 交互示例

```
pueblo> :loop 3

🔄 Loop 开始 - 计划执行 3 轮

── 第 1/3 轮 ── (1.2s)
[LLM] 修复了 login 页面的样式问题，添加了 loading 状态。

── 第 2/3 轮 ── (0.8s)
[LLM] 优化了 API 调用逻辑，增加了错误处理。

── 第 3/3 轮 ── (1.5s)
[LLM] 更新了单元测试用例，覆盖率提升至 85%。

✅ Loop 完成 - 共 3 轮，全部成功
```

---

## 5. 涉及的文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/agent/loop-runner.ts` | 🔴 核心修改 | 新增 `RoundProgressEvent`、`OnRoundProgress` 类型；`run()` 新增 `onProgress` 参数；基类模板方法实现进度回调 |
| `src/commands/loop-command.ts` | 🔴 核心修改 | 创建 `OutputPublisher`；将进度事件转为 `RendererOutputBlock` 增量写入；管理锁定/解锁状态 |
| `src/shared/result.ts` | 🟡 新增类型 | 新增 `OutputPublisher` 接口、`RoundProgressEvent` 类型 |
| `src/shared/schema.ts` | 🟢 可选 | 新增 `'loop-progress'` OutputBlock 类型（如需要区分） |
| `src/desktop/main/talk-service.ts` | 🟡 中度修改 | 新增 `setInputLocked()` IPC 方法；增加 `publishOutput` 的订阅机制 |
| `src/desktop/shared/ipc-contract.ts` | 🟡 中度修改 | 新增 `'output-block'`、`'input-lock-change'`、`'cancel-loop'` IPC 通道定义 |
| `src/cli/index.ts` | 🟢 轻度修改 | 增量输出适配 |
| Renderer (preload) | 🟢 轻度修改 | 新增 IPC 监听和 UI 响应逻辑 |
| Renderer (UI) | 🟢 轻度修改 | Submit 按钮锁定/解锁；取消按钮显隐 |

---

## 6. 方案 A 的局限与方案 B 的展望

### 6.1 方案 A 的已知局限

1. **输入锁定**：loop 执行期间用户无法使用其他命令，体验较死板
2. **单面板**：无法同时查看多个 loop 的执行进度
3. **会话隔离**：loop 状态与当前会话耦合，关闭面板则丢失

### 6.2 方案 B 的架构设计（远期）

方案 B 基于现有 `WorkflowService` / `WorkflowInstance` 基础设施扩展：

```
┌─────────────────────────────────────────────────────┐
│                  Workflow Engine                      │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ LoopWorkflow │  │ Agent A  │  │ Agent B Workflow│ │
│  │   Runner     │  │ Workflow │  │   Runner       │ │
│  └──────┬──────┘  └────┬─────┘  └───────┬────────┘ │
│         │              │                │           │
│  ┌──────▼──────────────▼────────────────▼───────┐   │
│  │           Workflow Instance Store             │   │
│  │  (持久化进度，支持断点续传、多路并发)         │   │
│  └───────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│                    UI 层                              │
│  ┌────────────────┐  ┌────────────────────────┐     │
│  │  主面板（活跃） │  │  Loop 监控面板（新窗口） │     │
│  │  - 自由输入     │  │  - 实时进度条           │     │
│  │  - 状态通知     │  │  - 每轮结果展开/折叠    │     │
│  └────────────────┘  │  - 取消/暂停按钮         │     │
│                       │  - 多 tab 支持           │     │
│                       └────────────────────────┘     │
└─────────────────────────────────────────────────────┘
```

#### 6.2.1 方案 B 的关键组件

1. **WorkflowInstance 扩展**：增加 `progress: WorkflowProgress` 字段，存储当前执行状态
2. **LoopWorkflowRunner**：继承自 `WorkflowRunner`，将 `LoopRunner` 包装为可持久化的工作流
3. **WorkflowMonitorPanel**：新 UI 组件，支持多 tab 监控多个工作流/loop 的执行
4. **InterProcess Bus**：主进程与监控面板之间通过 IPC 推送进度事件

#### 6.2.2 迁移路径

```
v1 (方案 A)                    v2 (方案 B)
─────────                      ─────────
LoopRunner.onProgress()  ──→   WorkflowRunner.onProgress()
OutputPublisher          ──→   WorkflowInstance.progressStore
锁定 Submit               ──→   独立监控面板（不锁定主界面）
当前面板追加               ──→   监控面板多 tab 展示
```

---

## 7. 实现计划

### 阶段 1：方案 A MVP（2-3 天）

| 步骤 | 工作项 | 工时 |
|------|--------|------|
| 1.1 | 定义 `RoundProgressEvent` 和 `OnRoundProgress` 类型（`shared/result.ts`） | 1h |
| 1.2 | 改造 `LoopRunner.run()` 签名 + 基类模板方法 | 3h |
| 1.3 | 改造 `loop-command.ts` 接收进度回调并生成增量 OutputBlock | 3h |
| 1.4 | 新增 `OutputPublisher` 接口 + 桌面端实现（publishOutput） | 2h |
| 1.5 | Renderer IPC 通道：`output-block`、`input-lock-change`、`cancel-loop` | 2h |
| 1.6 | UI 层：锁定 submit、显示取消按钮、接收增量块并追加 | 3h |
| 1.7 | CLI 端适配：writeLine 增量输出 | 1h |
| 1.8 | 集成测试 + 边界情况处理（取消、异常、空 loop） | 3h |

### 阶段 2：方案 B 基础架构（视需求决定）

| 步骤 | 工作项 | 优先级 |
|------|--------|--------|
| 2.1 | WorkflowInstance 增加 `progress` 字段 | P1 |
| 2.2 | 实现 `LoopWorkflowRunner` 包装 LoopRunner | P1 |
| 2.3 | 新窗口 WorkflowMonitorPanel 组件 | P2 |
| 2.4 | 多工作流并发管理与 IPC 路由 | P2 |

---

## 8. 决策记录

| ADR | 决策 | 理由 |
|-----|------|------|
| ADR-1 | `onProgress` 回调设计为可选参数 | 向后兼容，现有子类无需修改 |
| ADR-2 | 新增 `OutputPublisher` 接口而非直接依赖 IPC | 抽象解耦，CLI/Desktop 可各自实现 |
| ADR-3 | 进度数据模型选用 event 结构而非流式 | event 模型更符合"轮次"粒度，LLM 流式 token 不跨轮累计 |
| ADR-4 | Submit 锁定通过 IPC 而非 renderer 自管理 | 锁定状态由主进程业务逻辑语义决定，避免 renderer 误判 |
| ADR-5 | CLI 端增量输出直接用 writeLine 而非 OutputBlock | CLI 是文本流，OutputBlock 结构化数据无意义 |
| ADR-6 | 不修改 `RunRoundFn` 签名，progress 回调从 `run()` 参数层注入 | `RunRoundFn` 是纯函数，progress 为跨层横切关注点，分离更干净 |
| ADR-7 | 暂不引入 `'loop-progress'` 新 OutputBlock 类型 | 用 `'command-result'` 类型已足够，减少 schema 变更 |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| LoopRunner 多个调用方各自传入 `runRound` 回调，progress 信号不一致 | 进度事件缺失 | `onProgress` 作为 `run()` 参数层可选注入，不影响 `RunRoundFn` 纯函数语义 |
| 大量轮次（如 100 轮）导致 UI 堆叠 | 性能下降 | 限制输出块数量（折叠旧轮次、轮次聚合） |
| 取消导致部分已完成的轮次状态不一致 | 用户困惑 | 在取消时输出已完成的轮次汇总，明确标注"已取消" |
| IPC 通道增加导致 preload 安全风险 | 安全隐患 | 严格使用 contextBridge 隔离，只暴露必要通道 |

---

## 10. 不纳入本次设计的需求

- ❌ **LLM 流式 token 实时输出**：本次只关注"轮次粒度"，不涉及单轮内 token 级流式展示
- ❌ **断点续跑**：方案 B 可支持，方案 A 仅支持从头重跑
- ❌ **多轮并行执行**：未来工作流引擎的能力范畴
- ❌ **循环中的动态 prompt 编辑**：交互复杂度高，暂不纳入
