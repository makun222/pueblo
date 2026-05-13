# Pepe 记忆监控与精简归纳系统 — 实现方案

## 1. 现有架构分析

| 模块 | 文件 | 关键能力 |
|------|------|----------|
| Agent 运行器 | task-runner.ts | AgentTaskRunner.run() 驱动 Agent 循环 |
| 上下文解析 | context-resolver.ts | ContextResolver.resolve() 组装 system prompt/memories |
| 消息构建 | task-message-builder.ts | buildProviderMessages() 将 memories 注入 system 消息 |
| 记忆服务 | memory-service.ts | createConversationTurnMemory() 将 Q&A 对落盘为记忆 |
| 会话服务 | session-service.ts | 管理消息历史、选中记忆 id 列表 |
| LLM 适配器 | provider-adapter.ts | ProviderAdapter.runStep() 可用于发起 LLM 调用 |
| Pepe 类型桩 | pepe-types.ts | 仅有 PepeConfig 接口，无实现 |

**关键数据流**：ContextResolver.resolve() → session.selectedMemoryIds → memoryService.resolveMemorySelection() → system prompt → LLM。

**问题**：当前记忆是全量选中、全量注入，无阈值检测、无归纳、无相关性过滤。

---

## 2. 方案概述

AgentTaskRunner.run() 期间启动 Pepe 监控线程。Pepe 持有独立 LLM 连接，周期检查上下文利用率。超过阈值时：

- 阶段1: 归纳 — LLM 对每个 conversation-turn 记忆生成精炼摘要
- 阶段2: 向量化 — 本地字符 3-gram 算法计算摘要向量
- 阶段3: 过滤 — 余弦相似度筛选相关记忆，写回 session.selectedMemoryIds

---

## 3. 文件变更清单

### 3.1 新增文件

- src/agent/pepe-embedding.ts — PepeEmbedder (字符 3-gram + FNV-1a hash, 256维, L2归一化)
- src/agent/pepe-summarizer.ts — PepeSummarizer (LLM驱动的归纳，复用ProviderAdapter)
- src/agent/pepe-service.ts — PepeService (start/stop/tick, 定时器监控)
- tests/unit/pepe-service.test.ts — 单元测试

### 3.2 修改文件

- src/agent/pepe-types.ts — 新增 PepeTickResult, PepeDependencies 接口
- src/agent/task-runner.ts — pepeService? 可选注入, start/stop 包裹 runAgentLoop
- src/agent/context-resolver.ts — runtimeStatus 增加 pepeResult 字段

---

## 4. 核心算法

### 4.1 阈值触发

- utilizationRatio > 0.85
- 冷却: cooldownMs = 30s
- 最小记忆数: >= 3

### 4.2 归纳

for each memory with type=short-term and tag=conversation-turn:
    summary = await summarizer.summarizeTurn(memory, currentGoal)

### 4.3 向量化

vectorize(text, dim=256):
  - 字符 3-gram 滑动窗口
  - FNV-1a hash 映射到 0..dim-1
  - L2 归一化

### 4.4 相关性过滤

currentVector = embedder.vectorize(currentGoal + recentMessages)
candidates = [id for id,summary in summaries if cosineSimilarity(currentVector, embedder.vectorize(summary)) >= 0.3]
candidates 按相似度排序，截断至 maxKeptMemories
写回 session.setSelectedMemoryIds(sessionId, candidates)

---

## 5. 生命周期

run()
  → buildExecutionMessages()   (首次全量加载)
  → pepeService.start(ctx)     (启动定时器)
  → runAgentLoop()
      [tick: 读selectedIds → computeUtilization → if > threshold: summarize → vectorize → filter → writeBack]
  → pepeService.stop()         (清理定时器)

---

## 6. 关键设计决策

| 决策 | 理由 |
|------|------|
| 本地向量化 | 无 embedding API 依赖，字符 n-gram 256维足够语义区分 |
| session.selectedMemoryIds | 不改写 ContextResolver，对消息构建透明 |
| pepeService 可选 | 渐进集成，不破坏现有测试 |
| 复用 ProviderAdapter | 单一 LLM 连接类型 |
| 冷却机制 | 防止 LLM 调用风暴 |
| 仅归纳 conversation-turn | 手动记忆完整保留 |

---

## 7. 测试策略

1. pepe-embedding.test.ts — 向量维度、归一化、相同文本、不同文本相似度
2. pepe-summarizer.test.ts — prompt 格式、结果解析
3. pepe-service.test.ts — 低于阈值不触发、超阈值触发、冷却期、最小记忆数、session 写回
