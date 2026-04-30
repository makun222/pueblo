## 方案：Pepe 记忆伺服进程与 Result 上下文集合

### 1. 修订目标

本次方案按以下三条原则重构：

1. `memory` 继续作为当前 session 的记忆链，不再被 Pepe 直接替换或删除。
2. `memory` 采用双持久化：一份写入 sqlite，一份周期性刷写到 `./agent-XX/.memory/` 目录。
3. `ContextResolver` 不再直接组装 `memory`，而是只消费 Pepe 维护的 `Result` 集合。

这里的 `agent-XX` 指当前 `agentInstanceId` 对应的工作目录，例如 `./agent-3f8c/.memory/`。每个 agent instance 维护自己的记忆镜像目录，避免跨 agent 污染。

---

### 2. 现有架构与缺口

| 模块 | 文件 | 当前职责 | 缺口 |
|------|------|----------|------|
| Agent 运行器 | `task-runner.ts` | 驱动单次 task 执行 | 无后台伺服进程入口 |
| 上下文解析 | `context-resolver.ts` | 从 session 取 prompt 和 memory 组装 `TaskContext` | 仍直接消费 `memory` |
| 记忆服务 | `memory-service.ts` | 创建与查询记忆 | 只有 sqlite 持久化，无目录镜像 |
| 会话服务 | `session-service.ts` | 管理消息历史与 `selectedMemoryIds` | 没有 Result 集合概念 |
| Provider 层 | `provider-adapter.ts` | 提供 LLM 调用能力 | 无 Pepe 独立长连接语义层 |
| Schema | `shared/schema.ts` | 已有 `backgroundSummaryStatus`、`summaryPolicy` | 缺少 Result/向量索引模型 |

当前数据流仍是：

`ContextResolver.resolve()` → `session.selectedMemoryIds` → `memoryService.resolveMemorySelection()` → `TaskContext.memories`

这与新目标不一致。新方案要求：

`ContextResolver.resolve()` → `PepeResultService.resolveResult()` → `TaskContext.resultSet`

---

### 3. 新架构概述

Pepe 被定义为 **伴随 agent instance 生命周期存在的伺服进程**。只要 agent 启动，Pepe 就立刻启动，并持续执行三类工作：

1. 监听 session 记忆链增长。
2. 对记忆链进行总结提炼与向量化。
3. 根据当前 input 计算近似记忆集合 `Result`，供 `ContextResolver` 使用。

新数据流：

```
user input
    -> session messages
    -> sqlite memory chain
    -> ./agent-XX/.memory/ mirror files
    -> Pepe summarize + vectorize
    -> Result set
    -> ContextResolver
    -> TaskContext
    -> provider messages
```

`memory` 是原始、完整、可追溯的 session 记忆链。

`Result` 是 Pepe 基于当前 input 从 memory 链中筛选出的“当前有效上下文集合”。

---

### 4. 核心对象定义

#### 4.1 Memory

`memory` 保持现有语义：它是 session 内按时间累积的记忆链，具备以下特性：

1. 持久化到 sqlite，作为系统权威数据源。
2. 周期性同步到 `./agent-XX/.memory/`，作为 agent 工作目录下的文件镜像。
3. 允许包含原始问答、归纳摘要、派生记忆，但不再承担“当前上下文集合”的职责。

建议目录结构：

```
./agent-XX/
    .memory/
        manifest.json
        turn-0001.json
        turn-0002.json
        summary-0002.json
        vector-index.json
```

其中：

1. `manifest.json` 记录 agentInstanceId、sessionId、最后同步时间、文件版本。
2. `turn-*.json` 保存原始问答型 memory 镜像。
3. `summary-*.json` 保存 Pepe 提炼后的摘要 memory 镜像。
4. `vector-index.json` 保存 memoryId 到向量元数据的映射，不要求存完整浮点向量时也可只存摘要 hash 和版本。

#### 4.2 Pepe

Pepe 是一个 **伺服进程**，不是 task 内部的工具步骤。它的职责边界如下：

1. 与主 agent 解耦运行。
2. 维护 Pepe 自己与 LLM 的调用链路。
3. 周期性处理 memory 链。
4. 维护当前 input 对应的 `Result` 集合。

Pepe 不负责替代 session，不负责直接修改原始消息历史。

#### 4.3 Result

`Result` 是新的上下文集合对象，用来替代 `TaskContext.memories` 的装配职责。

建议结构：

```ts
interface PepeResultItem {
    readonly memoryId: string;
    readonly summary: string;
    readonly similarity: number;
    readonly sourceSessionId: string | null;
    readonly vectorVersion: string;
}

interface PepeResultSet {
    readonly sessionId: string;
    readonly agentInstanceId: string;
    readonly inputFingerprint: string;
    readonly items: PepeResultItem[];
    readonly generatedAt: string;
}
```

`Result` 是可重建对象，不是权威历史。权威历史仍然是 `memory`。

---

### 5. 生命周期

```
CLI / Desktop runtime startup
    -> create agent runtime
    -> create / attach agentInstance
    -> start Pepe supervisor immediately
    -> Pepe bootstraps sqlite memory chain and ./.memory mirror

each conversation turn completed
    -> session message appended
    -> memory appended to sqlite
    -> memory mirror scheduled to flush
    -> Pepe summarizes and vectorizes new memory
    -> Pepe updates Result for current input window

ContextResolver.resolve()
    -> read Result set
    -> inject Result items into TaskContext

runtime shutdown
    -> Pepe flushes pending memory files
    -> Pepe stops supervisor loop
```

关键点：Pepe 的启动时机是 **agent 启动后立即启动**，而不是等到阈值超限后才启动。

---

### 6. Pepe 工作流

#### 6.1 Memory 双持久化

每次 session 生成新的 conversation turn memory 后：

1. 先写入 sqlite。
2. 将该 memory 标记为 `pendingFlush`。
3. Pepe 的 flush loop 定期将 pending memory 写入 `./agent-XX/.memory/`。

推荐规则：

1. 新 memory 产生后 1 到 3 秒内进行批量 flush。
2. 进程退出前强制 flush。
3. 文件写入使用原子替换策略，避免中途损坏。

#### 6.2 总结提炼

Pepe 对 memory 链中的 conversation-turn memory 做摘要，不改变原始 memory，只生成派生摘要：

```
for each unsummarized conversation-turn memory:
    summary = LLM.summarize(memory)
    create derived summary memory
    persist summary to sqlite
    mirror summary file to .memory
```

摘要目标：

1. 提炼问题意图。
2. 提炼回答结论。
3. 提炼关键决策或实体。
4. 让后续向量化对象更短、更稳定。

#### 6.3 向量化

Pepe 对每条摘要 memory 进行向量化。向量化结果可持久化到 sqlite 的单独表，也可镜像到 `vector-index.json`。

```
for each summarized memory without vector:
    vector = embed(summary)
    save vector metadata
```

这里要求 Pepe 维护自己与 LLM 的链接。若 provider 有 embedding 能力则优先调用；若没有，则使用本地 fallback 向量化算法，但从架构上仍由 Pepe 的语义层负责。

#### 6.4 Result 生成

Pepe 根据当前 input 生成 `Result`：

```
inputVector = embed(currentInput + recentTurns)
candidateMemories = summarized memories from current session chain
scored = candidateMemories.map(memory => similarity(inputVector, memory.vector))
Result = keep top-K memories above similarity threshold
```

`Result` 只包含与当前 input 近似的 memory，不包含整条 memory 链。

---

### 7. ContextResolver 修订

这是本次设计中最重要的接口变化。

#### 7.1 旧行为

旧行为：

```
ContextResolver
    -> session.selectedMemoryIds
    -> memoryService.resolveMemorySelection()
    -> taskContext.memories
```

#### 7.2 新行为

新行为：

```
ContextResolver
    -> pepeResultService.resolve(sessionId, currentInput)
    -> taskContext.resultSet
```

也就是说：

1. `ContextResolver` 不再直接依赖 `memoryService.resolveMemorySelection()` 作为上下文装配来源。
2. `memory` 退回到底层记忆链角色。
3. `Result` 成为唯一的上下文记忆集合对象。

建议 `TaskContext` 由：

```ts
readonly memories: MemoryRecord[];
```

改为：

```ts
readonly resultSet: PepeResultSet | null;
readonly resultItems: PepeResultItem[];
```

同时 `task-message-builder.ts` 不再输出“Selected memories”，改为输出“Relevant result items”。

---

### 8. 文件变更清单

#### 8.1 新增文件

**`src/agent/pepe-supervisor.ts`**

负责：

1. 启动与停止 Pepe 伺服循环。
2. 管理 flush、summary、vectorize、result 四类 job。
3. 维护 Pepe 与 agentInstance 的绑定。

**`src/agent/pepe-result-service.ts`**

负责：

1. 读取当前 input。
2. 计算近似度。
3. 产出 `PepeResultSet`。
4. 提供给 `ContextResolver` 查询。

**`src/agent/pepe-memory-mirror.ts`**

负责：

1. 创建 `./agent-XX/.memory/`。
2. 将 sqlite memory 周期性刷盘为 JSON 文件。
3. 维护 `manifest.json` 与 `vector-index.json`。

**`src/agent/pepe-semantic-client.ts`**

负责：

1. 维护 Pepe 的 LLM/embedding 调用链。
2. 提供 `summarize()` 与 `vectorize()` 接口。

**`src/agent/pepe-types.ts`**

扩展：

1. `PepeResultItem`
2. `PepeResultSet`
3. `PepeSupervisorStatus`
4. `PepeMirrorManifest`

#### 8.2 修改文件

**`src/memory/memory-service.ts`**

增加：

1. 标记 memory 待 flush 的接口。
2. 列出指定 session 或 agent 的 memory 链。
3. 区分原始 turn memory 与派生 summary memory。

**`src/agent/context-resolver.ts`**

调整为：

1. 不再直接组装 `memories`。
2. 注入 `pepeResultService`。
3. 将 `Result` 写入 `TaskContext`。

**`src/agent/task-context.ts`**

调整为：

1. 新增 `resultSet` 和 `resultItems` 字段。
2. 保留 `selectedMemoryIds` 仅作为 session 层元数据，不再作为上下文装配主输入。

**`src/agent/task-message-builder.ts`**

改为使用 `resultItems` 输出相关记忆摘要。

**`src/cli/index.ts`**

增加：

1. agent runtime 启动时创建 Pepe supervisor。
2. `startAgentSession()` 后立即为该 agent instance 启动 Pepe。
3. `databaseClose()` 前触发 Pepe flush 和 stop。

**`src/shared/schema.ts`**

新增 Result 相关 schema 与 Pepe 状态 schema。

**`src/shared/config.ts`**

新增 `pepeSchema`，配置以下参数：

1. `enabled`
2. `flushIntervalMs`
3. `summaryIntervalMs`
4. `resultTopK`
5. `similarityThreshold`
6. `workingDirectoryPattern`

---

### 9. 关键设计决策

| 决策 | 理由 |
|------|------|
| `memory` 保留为 session 记忆链 | 历史可追溯、可回放、可调试 |
| sqlite + `.memory` 双持久化 | sqlite 提供权威存储，目录镜像提供 agent 本地工作视图 |
| Pepe 常驻为伺服进程 | 避免在单次 task 执行期内频繁初始化语义链路 |
| `ContextResolver` 只消费 `Result` | 将“历史存储”与“当前上下文选择”彻底解耦 |
| 摘要与向量分离 | 原始 memory 不丢失，摘要可重建，向量可重算 |
| Result 可重建 | 避免将临时上下文选择误当作永久知识 |

---

### 10. 测试策略

1. `pepe-memory-mirror.test.ts`
     - 新 memory 能被刷写到 `./agent-XX/.memory/`
     - 重复 flush 不会生成脏文件
     - 退出前强制 flush 生效

2. `pepe-result-service.test.ts`
     - 当前 input 与相近 memory 能进入 Result
     - 不相近 memory 被过滤
     - top-K 限制正确生效

3. `context-resolver.test.ts`
     - `ContextResolver` 不再读取 raw memories 作为上下文集合
     - `TaskContext` 改为输出 `resultSet` 和 `resultItems`

4. `cli-runtime-pepe.test.ts`
     - agent 启动即启动 Pepe
     - session 切换时 Pepe 绑定的 agent instance 正确更新
     - runtime 关闭时 Pepe flush + stop 被调用

---

### 11. 实施顺序

1. 先补 `schema` 与 `config`，引入 Pepe 和 Result 的显式模型。
2. 实现 `pepe-memory-mirror.ts`，完成 `.memory` 双持久化。
3. 实现 `pepe-semantic-client.ts` 与 `pepe-result-service.ts`，跑通摘要、向量、筛选。
4. 改造 `ContextResolver`、`TaskContext`、`task-message-builder.ts`，让上下文改用 Result。
5. 最后在 CLI/Desktop runtime 中接入 Pepe supervisor 生命周期。
