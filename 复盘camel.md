现在已有完整信息。让我给出系统性的差距分析。

---

## 设计文档 vs. 代码 交叉印证报告

### 已匹配项（✅ — 代码符合设计）

| 设计章节 | 特性 | 代码位置 | 状态 |
|-----------|--------|-----------|--------|
| 3.2 BudgetStrategy | `fixed`/`adaptive`/`unlimited` | `camel-types.ts:15` → `BudgetLimitStrategy` | ✅ |
| 3.5 CamelTurnContext | sessionId, goal, lastSuggestion, turnCount, history, workBudget | `camel-types.ts:58-74` | ✅ |
| 3.6 CamelTurnRecord | suggestion + messages | `camel-types.ts:76-79` | ✅ |
| 3.7-3.9 Status/Report/CompletionReason | 全部定义 | `camel-types.ts:81-96` | ✅ |
| 4.2 start() 主循环 | while(hasBudget) → runTurn → checkTermination | `camel-agent.ts:94-133` | ✅ |
| 4.3 runTurn() | 设置 contextSummary → executeTurnFn → recordTurn | `camel-agent.ts:135-172` | ✅ |
| 4.4 recordTurn() + 滑动窗口 | `turns.slice(-3)` | `camel-agent.ts:213-231` | ✅ |
| 4.5 isComplete() | suggestion==='' \|\| '[DONE]' \|\| 错误 \|\| 预算耗尽 | `camel-agent.ts:233-250` | ✅ |
| Callback 系统 | onStatusChange/onTurnStart/onTurnComplete/onError/onComplete | `camel-agent.ts:252-275` | ✅ |
| CamelContext | snapshot / getFullHistory / get / set | `camel-context.ts:33-69` | ✅ |
| 3步滑动窗口 | `this.turns.slice(-3)` 截断 + `taskLog` 全量 | `camel-agent.ts:213-219` | ✅ |
| npx tsc --noEmit | **零错误** | 已验证 | ✅ |

### 差异分析（⚡— 有意简化，非遗漏）

| 设计内容 | 代码实现 | 原因 |
|-----------|-----------|--------|
| `CamelAgentInput` 包含 `goalFile`, `repoDir`, `agentTemplateName`, `skillDirs`, `tools`, `worktree?` | 代码使用 `{goal, sessionId, providerId, modelId, signal?, callbacks?, budgetLimit?, budgetStrategy?, maxSteps?}` | 设计文档记录的是 **完整 CamelAgent**，当前实现的是 **Mini-Agent**。goalFile/worktree 等依赖 AgentTemplate 基础设施，不属于 mini 范围 |
| `ExecuteTurnInput` 包含 `task: AgentTask` | 代码用 `context: CamelTurnContext` + `providerId/modelId` | `AgentTask` 是完整 Camel 的产物，mini-agent 不依赖该抽象 |
| `ExecuteTurnOutput` 设计为 `{responseText, toolCalls, toolResults, usage, message, done}` | 代码返回 `{suggestion, context, turn}` | 聚合程度不同，但信息量等价 |
| `CamelContextInput` 包含 `goalFile`, `repoDir` 等 | 代码仅 `{sessionId, goal, budget?}` | mini-agent 不进行文件系统初始化 |

### 实际遗漏（❌— 应修补）

#### 类型层

| # | 遗漏项 | 设计位置 | 现状 | 影响 |
|---|-----------|-----------|--------|--------|
| **1** | `CamelAgentState` 未 `extends CamelTurnContext` | 设计 3.3：「`CamelAgentState extends CamelTurnContext`」 | 代码仅包含 `sessionId` + `goal`，缺少 `lastSuggestion`, `turnCount`, `workBudget`, `history` | 状态消费者无法直接从 `CamelAgentState` 获取运行时上下文——必须从 `CamelContext` 单独获取 |
| **2** | `CamelAgentState.error` 类型为 `string\|null` | 设计 3.3：`error: Error \| null` | 代码：`error: string \| null`（`camel-types.ts:52`，存储时已格式化） | 丢掉原始 Error 对象（堆栈等），事后调试困难 |

#### 功能层

| # | 遗漏项 | 设计位置 | 现状 | 影响 |
|---|-----------|-----------|--------|--------|
| **3** | LLM API 调用失败重试 | 设计 §9（第 2 行）：「LLM API Call failed → retry max 2 times，再 failed + onComplete」 | `camel-agent.ts:116-129` 的 `catch` 直接置 `status='failed'` 然后调用 `emitComplete()`，无重试 | 瞬时网络抖动或限流将直接导致任务失败，无容错 |
| **4** | 显式 `cancel()` 方法 | 设计 §3.3 状态机：「`running ──[cancel()]▶ cancelled`」 | `camel-agent.ts` 中仅在 `start()` 循环内检查 `signal?.aborted`，没有 `cancel()` 公开方法 | 外部无法主动终止运行中的任务（但 AbortSignal 仍可工作的部分场景可行） |

#### 测试层

| # | 遗漏项 | 设计位置 | 现状 |
|---|-----------|-----------|--------|
| **5** | start() 基础流测试（至少 1 轮执行） | 设计 §10.2 | `camel-agent.test.ts` 有运行测试，但未验证「完整 start() → complete」流程 |
| **6** | 轮次间上下文传递测试 | 设计 §10.3：「lastSuggestion 正确注入」 | 测试 mock 直接设置 suggestion，未验证第二轮的 `contextSummary['goal']` 实际传递 |
| **7** | workBudget 终止测试 | 设计 §10.4 | 仅 `hasBudget()` 有单元验证，无集成场景验证「budget 耗尽 → completed」 |
| **8** | cancel() 终止测试 | 设计 §10.5 | `cancel()` 方法未实现（参见遗漏 #4），故无此测试 |

---

### 优先度建议

| 优先级 | 遗漏项 | 理由 |
|--------|-----------|--------|
| **P0** | #3 LLM API 重试 | 生产不可少——无容错 = 高频任务失败 |
| **P1** | #4 `cancel()` 方法 | 用户体验基础——长时间运行任务必须可控 |
| **P1** | #1 `CamelAgentState extends CamelTurnContext` | `CamelAgentState` 的消费者缺少完整上下文（`lastSuggestion`、`workBudget` 等） |
| **P2** | #2 `error: Error\|null` | 方便调试，但非阻塞 |
| **P3** | #5-#8 测试补充 | 提升可靠性，但可在功能就绪后再补 |

需要我从 P0 的 LLM API 重试逻辑开始修补吗？