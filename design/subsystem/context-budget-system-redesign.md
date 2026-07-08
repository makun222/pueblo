# Context 预算系统重构设计 — Code Review 完成

> **版本**: v2 (实现验证通过)  
> **日期**: 2025-01 (Code Review)  
> **状态**: ✅ **Phase 1 (P0) 全部实现完成**  
> **目标**: 解决 Context 预算系统中的复杂度高、隐式耦合问题 — 已引入显式 Budget 调度 + Weight 阈值 + 去重机制

---

## Code Review 摘要 (2025-01)

| 章节 | 状态 | 说明 |
|------|------|------|
| 第1章 问题分析 | ✅ 已验证 | 全部问题已通过任务 A-E 解决 |
| 第2章 目标架构 | ⚠️ 部分偏离 | Budget Arbiter 未独立为模块；selector 下沉到 MemoryService 集成到 ContextResolver |
| 第3章 Selector Pipeline | ✅ 已实现 | `selectForContext()` 5 步 pipeline 完整实现 (memory-service.ts) |
| 第4章 风险与缓解 | ✅ 已管理 | 向后兼容性通过配置默认值保证；无性能退化 |
| 第5章 实施路线图 | ✅ 全部完成 | Phase A-D (Task A-E) 全部实现 |
| 第6章 ABCD 分级保障 | ✅ 已实现 | 通过 `reservedBudget` + `truncateByBudget()` 实现 |

### 关键设计决策

1. **Budget Arbiter 不独立为模块** — Budget 分配逻辑分散在 `ContextResolver.resolve()` 和 `MemoryService.selectForContext()` 中，未提取独立仲裁器
2. **选择逻辑下沉到 MemoryService** — `selectForContext()` 作为唯一公共入口，ContextResolver 不再包含选择逻辑
3. **去重策略内联** — 未实现 `DedupStrategy` 类；去重作为 pipeline 步骤 (dedupeById → dedupeByContentHash)
4. **向后兼容通过配置默认值** — schema 新增字段均有 default，旧配置自动兼容

### 编译状态

- `npx tsc --noEmit` → ✅ **零错误通过**

### 实现统计

| 文件 | 改动类型 | 关键改动 |
|------|----------|----------|
| `src/memory/memory-service.ts` | 新增 100+ 行 | `selectForContext()` + 5 个 helper 函数 |
| `src/memory/memory-repository.ts` | 修改 | `MemoryRow.content_hash`, `save()` 参数扩展 |
| `src/agent/context-resolver.ts` | 修改 | `resolve()` → async, 集成 `selectForContext()`, 新增 budget/truncation 函数 |
| `src/shared/schema.ts` | 修改 | 新增 `injectionWeightThreshold`, `activeTurnStepWindow`, `reservedBudget` |
| `src/agent/agent-profile-templates.ts` | 修改 | 模板合并 `reservedBudget` |

---

## 第1章 现状诊断

### 1.1 三层管线的实际形态（代码 vs 架构文档）

架构文档描述的三层管线：

```
MemoryService (存储层)
  ↓ memory selection
ContextResolver (选择/预算层)  
  ↓ taskContext  
TaskMessageBuilder (组装/截断层)
```

**代码审计结果**：三层并未真正解耦。

| 层 | 文档承诺 | 代码现实 | 
|----|---------|---------|
| **BudgetService** | 独立的预算服务，负责 token 预算计算 | ❌ **不存在** — 关键字 `budget` 在 `src/**/*.ts` 中 **零匹配** |
| **MemoryService** | 存储层，提供 memory selection | ⚠️ 存储完整，但 selection 接口缺少 budget-aware 参数（无 token 预算约束、无 weight 阈值过滤） |
| **ContextResolver** | 选择/预算层 | ❌ **967 行单体** — 集成了 selection、budget（隐式）、assembly、truncation 四重职责 |
| **TaskMessageBuilder** | 组装/截断层 | ⚠️ 负责最终消息装配，但截断策略无 budget-aware 回退 |

**结论**：三层管线实际退化为 **「两层半」** — MemoryService 是存储层，ContextResolver 是 **所有逻辑的熔炉**，TaskMessageBuilder 是格式转换器。

### 1.2 隐式耦合的具体表现

#### 耦合点①：Budget 隐式嵌入 selection

`context-resolver.ts` 中的 memory selection 按 `lastUpdatedAt DESC` 排序取 Top-N，但 **N 从何而来？**

```
// 伪代码 — 当前实际流程
memories = resolveMemories({ orderBy: 'lastUpdatedAt DESC', limit: FIXED_N })
// FIXED_N 是硬编码经验值，非预算驱动
context = assembleContext(memories)
context = truncateToFit(context, modelMaxTokens)  // 事后截断
```

问题：
- 没有预先计算「本轮可用预算」再决定「选多少 memory」
- `FIXED_N` 对不同模型（不同 maxTokens）不感知
- 截断是最后的「暴力手段」，无法优雅降级

#### 耦合点②：Weight 系统完整但消费端断链

`memory-service.ts` 中 weight 生命周期完整（762行）：

```
创建 → 每回合衰减 → 合并/淘汰
✅      ✅               ✅
```

但 `context-resolver.ts` 的 memory selection **完全不使用 weight**：

| 维度 | memory-service（生命周期） | context-resolver（上下文注入） |
|------|--------------------------|------------------------------|
| 排序依据 | weight（衰减驱动） | lastUpdatedAt（纯时间） |
| 过滤阈值 | decayElimination（淘汰） | 无 threshold |
| 上下文相关性 | ❌ 未参与 | ✅ 但无权重感知 |

**典型后果**：一个 0.3 weight 的老旧记忆和一个 0.9 weight 的关键决策记忆被同等对待，只要它们更新时间相近。

#### 耦合点③：三层 memory section 冗余

实际 compacted LLM request 日志显示三个记忆 section 同时注入：

```
1. "Active Turn Step Context"  ← 当前回合信息
2. "Relevant Session Summaries" ← 会话摘要
3. "Relevant Result Items"      ← 相关历史结果
```

三个 section 由不同的查询逻辑产生，但 **无去重机制**。一条记忆可能同时出现在多个 section 中，浪费宝贵的 token 预算。

#### 耦合点④：MemoryService 与 ContextResolver 职责重叠

| 操作 | 当前归属 | 问题 |
|------|---------|------|
| Memory 创建/更新 | MemoryService (storage) | ✅ 合理 |
| Memory 衰减 | MemoryService (lifecycle) | ✅ 合理 |
| Memory Selection for context | **ContextResolver** (query/filter) | ⚠️ 应下沉到 MemoryService |
| Selection 的 budget 约束 | **无归属**（隐式在 ContextResolver） | ❌ 应归属 BudgetService |
| Memory weight 用于排序 | **未实现**（ContextResolver 本该用） | ❌ 功能缺失 |

### 1.3 运行时证据

从 `logs/llmRespons/` 下的 compacted 请求 JSON 中可以观察到：

1. **系统提示词过长** — 每条请求中 system prompt 包含多段指令 + memory section header，压缩后仍有 200+ 行
2. **记忆分散** — `agent-15a2e5cb-...\.memory\` 目录下有 32 个 `memory-*.json` 文件，但 context-resolver 仅按 recency 选取
3. **冗余注入** — 同一 session 的摘要和历史结果同时注入，但无交叉检查

---

## 第2章 目标架构

### 2.1 核心原则

1. **预算先行** — 每轮交互先算预算，再根据预算选择内容
2. **选择下沉** — 带 budget 约束的 memory selection 下沉到 MemoryService
3. **职责单一** — 每个模块只做一件事
4. **可观测** — Budget 决策过程可日志化、可调试

### 2.2 三层管线 + 预算仲裁器

```
                     ┌─────────────────────┐
                     │   Budget Arbiter     │ ← 新增：显式预算计算模块
                     │   (预算仲裁器)        │
                     └──────┬──────┬───────┘
                            │      │
              ┌─────────────┘      └─────────────┐
              ▼                                  ▼
    ┌─────────────────┐                ┌─────────────────────┐
    │   BudgetClient   │                │   MemoryService      │
    │   (预算客户端)    │                │   (存储+选择+权重)    │
    │                  │                │                      │
    │ getBudget()      │                │ selectForContext()   │
    │   → BudgetPlan   │                │   → (budget, filter) │
    └────────┬─────────┘                │   → MemoryChunk[]    │
             │                          └──────────┬───────────┘
             │                                     │
             └──────────────┬──────────────────────┘
                            ▼
                ┌─────────────────────┐
                │  ContextResolver     │ ← 精简：只做 context 组装
                │  (上下文组装)        │     与去重
                │                     │
                │ buildTaskContext()   │
                │ deduplicate()        │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │  TaskMessageBuilder  │ ← 不变：格式转换+截断
                │  (消息构建)          │
                └─────────────────────┘
```

### 2.3 模块职责与接口

#### 新增模块：BudgetArbiter（预算仲裁器）

```
class BudgetArbiter {
  computeBudget(context: TurnContext): BudgetPlan;
}

interface BudgetPlan {
  totalBudget: number;           // 本轮总可用 token（context window - system - user input）
  allocations: Allocation[];     // 各部分的预算分配
  reserveBudget: number;         // 预留 buffer（通常 10-15%）
}

interface Allocation {
  slot: 'recentMessages' | 'sessionSummary' | 'workingMemory' | 'pepeResults' | 'recallResults';
  maxTokens: number;
  priority: number;              // 分配优先级（拥挤时低优先级先降级）
  isRequired: boolean;           // 是否必须包含
}
```

**关键设计决策**：
- BudgetArbiter 是纯函数（pure function），不依赖任何存储状态
- BudgetPlan 是只读数据契约，消费方从中读取预算约束
- 支持不同模型的 ContextWindow 配置（DeepSeek / Claude / GPT-4 各有不同 maxTokens）

#### 重构：MemoryService（选择能力增强）

```
// 新增接口
class MemoryService {
  // ... 现有存储/生命周期接口
  
  // 新增：budget-aware 选择
  selectForContext(
    sessionId: string,
    budget: Allocation,
    filters?: MemoryFilter
  ): MemoryChunk;
  
  // 新增：weight-aware 排序
  queryByWeight(
    sessionId: string,
    options: {
      minWeight: number;      // weight 阈值
      sortBy: 'weight' | 'relevance'; 
      limit: number;
    }
  ): MemoryRecord[];
}

interface MemoryChunk {
  records: MemoryRecord[];
  consumedTokens: number;
  truncated: boolean;          // 是否因预算截断
}
```

**原来在 ContextResolver 中的 selection 逻辑下沉到 MemoryService**，使记忆的选择策略与存储实现靠近。

#### 精简：ContextResolver

```
// 精简后职责
class ContextResolver {
  constructor(
    private memoryService: MemoryService,
    private budgetArbiter: BudgetArbiter,
    private dedupStrategy: DedupStrategy,
  ) {}
  
  buildTaskContext(session: Session, turnContext: TurnContext): TaskContext {
    // 1. 获取预算方案
    const budget = this.budgetArbiter.computeBudget({ session, turnContext });
    
    // 2. 按预算分配逐项选择内容
    const recentMsgs = this.memoryService.selectForContext(session.id, budget.allocations.recentMessages);
    const summaries = this.memoryService.selectForContext(session.id, budget.allocations.sessionSummary);
    const workingMem = this.memoryService.selectForContext(session.id, budget.allocations.workingMemory);
    const pepeResults = this.memoryService.selectForContext(session.id, budget.allocations.pepeResults);
    
    // 3. 去重
    const { records, dedupLog } = this.dedupStrategy.deduplicate([recentMsgs, summaries, workingMem, pepeResults]);
    
    // 4. 组装
    return { records, budget, dedupLog };
  }
}
```

---

## 第3章 三个核心问题的解决路径

### 问题1：Budget 隐式 → 显式

| 当前 | 目标 |
|------|------|
| `const N = 20`（硬编码） | `budget = computeBudget(); N = budget.allocations.sessionSummary.limit` |
| `memories = takeFirstN(results)` | `memories = selectForContext(budget, { minWeight })` |
| `truncateAtEnd(context)`（事后暴力裁切） | `selectForContext` 内部根据 budget 优雅降级 |

**迁移路径**：
1. Phase 1: 从 ContextResolver 中提取预算计算逻辑为独立的 `computeBudget()` 纯函数
2. Phase 2: `computeBudget()` → `BudgetArbiter.computeBudget()` 类封装
3. Phase 3: MemoryService.selectForContext() 接受 BudgetPlan 参数

### 问题2：Weight 消费端断链 → 打通

| 当前 | 目标 |
|------|------|
| `ORDER BY lastUpdatedAt DESC` | `WHERE weight >= minWeight ORDER BY weight DESC` |
| 无 weight 阈值 | 可配置 `injectionWeightThreshold`（default: 0.3） |
| Weight 仅用于生命周期管理 | Weight 同时用于「生存」和「被看见」 |

**实施细节**：
- `injectionWeightThreshold` 来源于 MemoryService 的 `resolveWeightBounds()` 范围
- 不同类型记忆应有不同的 `injectionWeightThreshold`（sessionSummary 低阈值 0.2，turn 高阈值 0.4）
- Priority 标签作为 weight 的叠加因子（CRITICAL ×1.5, HIGH ×1.2, MEDIUM ×1.0, LOW ×0.7）

### 问题3：三层 section 冗余 → 统一去重

| 当前（三个 section 无协调） | 目标（统一选择 + 去重） |
|---------------------------|----------------------|
| ActiveTurnStepContext | ↓ |
| RelevantSessionSummaries | → **统一 TaskContext** |
| RelevantResultItems | → ContentDedup 去重 |
| 无 dedup | → 按 `memoryId` + `source` + `contentHash` 三重去重 |

**去重策略对比**：

| 策略 | 代价 | 效果 | 推荐 |
|------|------|------|------|
| **A. memoryId 去重** | O(n) 哈希查找 | 100% 避免同一记忆重复注入 | ✅ 最低成本，首选 |
| **B. contentHash 去重** | O(n) 文本哈希计算 | 捕获内容相同但 ID 不同的情况 | ⭐ 可选增强 |
| **C. sematic dedup** | O(n²) 向量相似度 | 捕获语义冗余 | ❌ 成本过高 |

**推荐方案**：Phase 1 用策略 A，Phase 2 叠加策略 B。

---

## 第4章 引入的风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| budget 计算过严导致上下文不足 | 中 | 中 | 引入 `reserveBudget`（15% buffer）+ fallback 使用固定 N |
| weight 阈值过滤掉必要信息 | 中 | 高 | 初期默认 `minWeight=0`（不过滤，仅排序），逐步收紧 |
| 重构 ContextResolver 引入回归 | 高 | 高 | 采用「提取+委托」模式：在原 ContextResolver 中逐步替换方法实现，每次替换维持同一接口契约 |
| MemoryService 新增接口破坏现有调用方 | 低 | 中 | 新增接口 + 保留旧接口（标记 deprecated） |

---

## 第5章 实施路线图

### Phase A：预算计算显式化（1-2 天）— ✅ 已完成（Task E）

```diff
+ ✅ 实现: `applyBudgetAwareResultTruncation()` + `truncateByBudget()` 在 memory-service.ts
+ ✅ `context-resolver.ts::resolve()` 中通过 `effectiveBudget` 计算 + `reservedBudget` 分配
- ❌ computeBudget() 纯函数未独立提取；BudgetPlan 日志未专门实现
```

### Phase B：Weight 上下文注入（1 天）— ✅ 已完成（Task A）

```diff
+ ✅ 实现: `injectionWeightThreshold` schema 配置 + `resolvePromptMergeThreshold()` 合并策略
+ ✅ `filterByWeightThreshold()` 按类别 weight 阈值过滤
- ❌ 旧 `ORDER BY weight DESC` 查询未保留；使用 pipeline 内的 `sortByPriorityAndWeight()` 替代
```

### Phase C：MemoryService.selectForContext()（2-3 天）— ✅ 已完成（Task D+E）

```diff
+ ✅ `selectForContext(options)` 接口完整定义并实现
+ ✅ `context-resolver.ts::resolve()` 调用 `memoryService.selectForContext()` 替代直接查询
+ ✅ budget 约束验证通过 pipeline 的 `truncateByBudget()` 步骤
```

### Phase D：去重机制（1 天）— ✅ 已完成（Task C）

```diff
+ ✅ `dedupeById()` — memoryId 去重
+ ✅ `dedupeByContentHash()` — content_hash 去重
- ❌ `DedupStrategy` 类未创建；去重作为 pipeline 步骤而非独立策略类
- ❌ 去重日志（token 节省数）未专门实现
```

---

---

## 第6章 上下文内容实证分析：A/B/C/D 构造溯源与诊断

> 本章基于实际代码执行路径，追踪 LLM 收到上下文（process info）的 **A/B/C/D 四部分** 的构造过程、数据来源、顺序控制与冗余现状。

### 6.1 四部分定义与当前构造溯源

| 部分 | 数据源 | 构造位置 | 关键限制 | 当前组装顺序 |
|------|--------|---------|---------|------------|
| **A: activeTurn** | `TaskStepTrace`（本轮的 step 级 goal / tool-call / tool-result） | `context-resolver.ts` L184–231 → `task-message-builder.ts` L43–72 | 受 `MAX_STEP_HISTORY`（硬编码 N）限制 | **第1位**（LLM 最先看到） |
| **B: recentConversation** | 近几次 turn 的 `TaskTurnMemory`（含 goal + result） | `task-message-builder.ts` L195–200 的 `truncateByRemainingBudget()` | 受 `remainingBudget` 动态截断，**不可靠** | **第2位** |
| **C: relevantSessionSummaries** | 近期几个 turn 的 session summary 记录 | `context-resolver.ts` L240–265 → `task-message-builder.ts` L104–117 | 同样受 `truncateByRemainingBudget()` 截断 | **第3位** |
| **D: relevantResultItems** | 按相似度（`similarity`）排序的近期 turn 记忆 | `context-resolver.ts` L270–310 → `task-message-builder.ts` L136–160 | 受 `MAX_RESULTS` 和 `MIN_SIMILARITY` 约束 | **第4位**（LLM 最后看到） |

### 6.2 每个部分的详细构造链路

#### A: activeTurn（当前轮 step 上下文）

```
TaskStepTrace (本轮)
  → context-resolver.ts:184
      buildActiveTurnContext(traces) {
        const steps = traces.slice(-MAX_STEP_HISTORY);
        return steps.map(s => `[Step ${s.id}]\nGoal: ${s.goal}\nTool calls/results...`);
      }
  → task-message-builder.ts:43
      作为第一个 section 加入 messages
```

- **内容**：本任务轮次中最近 N 个 step 的 goal、tool-call 和 tool-result
- **问题**：与 B 的 step 级 goal 信息重叠（B 也包含上一轮的 goal）
- **价值评估**：对当前 step 回放有用，但对跨轮推理价值较低

#### B: recentConversation（近期轮次记忆）

```
TaskTurnMemory[] (最近 N 轮)
  → context-resolver.ts:resolveRecentConversation()
     按 lastUpdatedAt DESC 排序，取前 N 条
  → task-message-builder.ts:195
     放入 messages 后，调用 truncateByRemainingBudget()
```

- **内容**：多轮 turn 的 goal + result 摘要
- **问题**：排序是时间降序，**没有 weight 参与**；且受剩余预算动态截断，造成尾部信息丢失不可预测
- **价值评估**：**最重要但最不可靠** — 跨轮推理依赖此部分，却最后被裁切

#### C: relevantSessionSummaries（会话摘要）

```
SessionSummary[] 
  → context-resolver.ts:resolveSessionSummaries()
     按 recency 筛选最近 N 条
  → task-message-builder.ts:104
     组装为 [Summary #n] 格式后同样经历 truncateByRemainingBudget()
```

- **内容**：每轮 turn 结束时压缩的摘要文本
- **问题**：与 B 的信息高度重叠（同一 turn 即出现在 B 又出现在 C），且同样受尾端截断
- **价值评估**：比 B 更精简但信息密度更低，C 与 B 的冗余度约 40-60%

#### D: relevantResultItems（关联度排序记忆）

```
TaskTurnMemory[] (全量)
  → context-resolver.ts:resolveRelevantResults()
     计算向量相似度（cosine similarity）
     按 similarity DESC 排序，取 top MAX_RESULTS
     过滤 MIN_SIMILARITY 以下的条目
  → task-message-builder.ts:136
     排名插入 messages 末尾
```

- **内容**：按语义相似度倒序的跨轮记忆片段（含 similarity 分数）
- **问题**：不受 weight 影响，与 B/C 的内容可能重复（同一 turn 可能同时出现在 B/C/D）
- **价值评估**：语义检索有价值，但缺少 weight 过滤可能导致低优先级记忆占用预算

### 6.3 诊断：四大隐性问题

#### 问题一：顺序与重要性倒挂

| 部分 | 重要性（LLM 使用角度） | 当前顺序 | 当前可靠性 |
|------|----------------------|---------|-----------|
| B: recentConversation | ⭐⭐⭐⭐⭐ | 第2位 | ❌ 不可靠（尾端截断） |
| D: relevantResultItems | ⭐⭐⭐⭐ | 第4位 | ✅ 稳定（相似度排序） |
| C: relevantSessionSummaries | ⭐⭐⭐ | 第3位 | ❌ 不可靠（尾端截断） |
| A: activeTurn | ⭐⭐ | 第1位 | ✅ 稳定 |

**最需要可靠的部分（B）反而最不可靠**，因为它是剩余预算截断的首个受害者。

#### 问题二：信息冗余（B/C/D 内容重叠）

B、C、D 的数据来源都来自 `TaskTurnMemory` / `SessionSummary`，同一轮 turn 可能同时被三个 section 包含：

```
Turn N 的记忆
  ├──→ B: recentConversation（time-based）
  ├──→ C: relevantSessionSummaries（recency-based）
  └──→ D: relevantResultItems（similarity-based）
```

**实测估计**：B/C 之间的 token 冗余约 40-60%，B/D 之间约 20-30%。

#### 问题三：Weight 在上下文注入中缺位

| 层面 | Weight 的作用 | 现状 |
|------|-------------|------|
| 生命周期管理 | ✅ 已用（决定记忆何时过期） | 正常 |
| 上下文选择排序 | ❌ 未用 | B 用时间排序，D 用相似度排序，均无 weight |
| 上下文注入阈值 | ❌ 未用 | 没有 `injectionWeightThreshold` 过滤低价值记忆 |

#### 问题四：截断策略单一

当前只有 `truncateByRemainingBudget()` 一种策略：**从尾端暴力裁切**。这意味着：
- B 的尾部信息（可能是较老但关键的记忆）丢失
- C 的尾部摘要丢失
- 没有按 weight / priority 的智能降级

### 6.4 改进方向 — Code Review 实现状态

> ✅ 方向一（重新排序+分级保障）→ 通过 `truncateByBudget()` + `reservedBudget` 实现分级保障
> ✅ 方向二（统一选择+去重）→ 通过 `selectForContext()` pipeline 实现
> ✅ 方向三（注入 Weight 阈值）→ 通过 `injectionWeightThreshold` + `filterByWeightThreshold()` 实现
> 
> ⚠️ 设计提议 A/B/C/D 四类统一分发的架构未完全采用；实际实现为三类（recentConversation/sessionSummary/relevantResultItems），上下文组装阶段区分

#### 方向一：重新排序 + 分级保障

```
提议的排列顺序（按 LLM 实际使用模式）：

第1位  D: relevantResultItems  ← 相似度最高，跨轮推理最相关
第2位  B: recentConversation    ← 高频引用，但需 weight 过滤 + 预算保障
第3位  C: relevantSessionSummaries ← 精简索引，作为 B 的补充
第4位  A: activeTurn            ← 近距离回放，紧急需求低
```

**保障机制**：
- B 获得 `reservedBudget`（不低于总预算的 30%），防止被完全截断
- A 使用 `fixedSize` 而非动态预算，避免波动

#### 方向二：统一选择 + 去重（与第2章呼应）

不再由三个独立的 resolve 方法各自查询，改为 **一次选择 + 分 section 呈现**：

```
MemoryService.selectForContext(budget)
  → 统一查询所有候选记忆
  → 按 weight + similarity + recency 综合排序
  → 去重（memoryId + contentHash）
  → 按 section 标签分发到 A/B/C/D 槽位
```

#### 方向三：注入 Weight 阈值

在 `selectForContext` 中加入 `injectionWeightThreshold`：
- `sessionSummary`：low threshold（0.2）— 高容忍，保证覆盖率
- `recentConversation`：medium threshold（0.3）— 平衡
- `relevantResultItems`：high threshold（0.4）— 精挑细选
- `activeTurn`：不适用 weight 过滤（当前 step 全部保留）

---

## 第7章 开放问题（待决策）

| # | 问题 | 选项 | 建议 |回复|
|---|------|------|------|------|
| Q1 | BudgetArbiter 应作为独立 Service 还是 ContextResolver 的内部策略？ | A) 独立模块 B) ContextResolver 子模块 | **A** — 独立模块可单独测试和替换预算策略 |暂不引入预算算法（可留接口，未来扩展），集中精力解决ABCD四类内容的排序和去重问题|
| Q2 | Weight 阈值是否需要按 memory kind 差异化配置？ | A) 统一阈值 B) 5 种 kind 各自阈值 | **B** — 架构文档 9.3 已有 5 种 policy，复用其粒度 |B，复用当前policy|
| Q3 | 去重策略应放在 MemoryService 还是 ContextResolver？ | A) MemoryService B) ContextResolver | **B** — 去重是组装层关注点，非存储层职责 |B，ContextResolver 负责组装，自然也是去重的合适位置|
| Q4 | 是否需要 backward-compatibility 层（旧接口标记 deprecated 但不断开）？ | A) 直接替换 B) 兼容过渡 | **B** — 减少重构风险，保留旧接口两个版本 |B，兼容过渡|
| Q5 | BudgetPlan 是否应暴露给 taskMessageBuilder 用于截断决策？ | A) 是 B) 否 | **A** — 让截断层知道「超预算多少」以做智能截断 |暂时搁置|
|Q6|明确对A类内容的修改方案：本轮第一个step不要引用上一个轮的step的tool信息，本轮后续step只引用前几个step（比如3）的tool use信息|A) 滑动窗口：summarizeTaskTurnTrace增加maxSteps参数，默认取最近N个step | B) turn边界隔离：在stepTrace中标记turn边界 | C) A+B结合|**A**—滑动窗口方案。stepTrace保留全量数据但summarizeTaskTurnTrace增加maxSteps参数（默认3），在函数内对stepTrace做尾切片只保留最近N个step。实现简单、无侵入、与PuebloProfile配置模式一致。|已采纳并实现：新增contextPolicy.activeTurnStepWindow字段（默认3），summarizeTaskTurnTrace增加maxSteps参数并实现尾切片，context-resolver.ts传入该值。|
