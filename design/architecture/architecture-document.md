# Pueblo 架构文档：Memory & Context 系统

> 版本: v0.2 | 最后更新: 2025-01（四项建议可行性分析完成，第 9 章新增，第 8 章修正）

---

## 目录

1. [项目总览](#1-项目总览)
2. [Memory 系统](#2-memory-系统)
3. [Context 系统](#3-context-系统)
4. [数据流全景](#4-数据流全景)
5. [核心接口与契约](#5-核心接口与契约)
6. [设计权衡与决策记录](#6-设计权衡与决策记录)
7. [限制与未来方向](#7-限制与未来方向)

---

## 1. 项目总览

Pueblo 是一个**基于文件系统的 Agentic AI 运行时**，管理 LLM 驱动的任务执行。它不依赖外部向量数据库，而是用**本地 JSON 文件**存储 Memory，通过 `pueblo.md` 配置文件注入系统行为指令。整个架构围绕两个核心问题展开：

- **记住什么（Memory）**：跨会话的持久化知识管理
- **告诉 LLM 什么（Context）**：每轮交互中注入到 prompt 的信息选择

### 1.1 技术栈

| 层        | 技术选型                                    |
| --------- | ------------------------------------------- |
| 语言      | TypeScript 5.x                              |
| 运行时    | Node.js (package.json `"type": "module"`)   |
| 配置      | `pueblo.md` (Markdown 配置文件)             |
| 存储      | 文件系统 (JSON 文件)                        |
| 验证      | Zod (schema.ts)                             |
| 构建      | esbuild (package.json scripts)              |

### 1.2 模块分层概览

```
src/
├── memory/                  # Memory 持久化与管理
│   ├── memory-model.ts      # Memory 数据模型
│   ├── memory-repository.ts # JSON 文件读写层
│   ├── memory-queries.ts    # 查询 DSL (类 SQL)
│   ├── memory-service.ts    # 核心服务(CRUD+搜索+摘要)
│   └── workflow-memory.ts   # Workflow 专用 Memory 管理
├── agent/                   # Context 构建与 Agent 编排
│   ├── context-resolver.ts  # Context 拼装引擎(核心)
│   ├── task-context.ts      # 任务级 Context 构建
│   ├── skill-context.ts     # Skill 级 Context 构建
│   ├── task-message-builder.ts # LLM Message 组装器
│   └── pueblo-profile.ts    # 系统配置(profile) 加载
├── shared/                  # 跨模块共享
│   ├── schema.ts            # Zod Schema 定义
│   └── result.ts            # 结果与追踪类型
└── main.ts                  # 入口(未显示)
```

---

## 2. Memory 系统

### 2.1 设计哲学

Memory 系统遵循**"文件即数据库"**的极简哲学：

- 每个 Memory 条目是一个独立的 JSON 文件
- 文件按会话(session)组织在目录树下
- 通过 LLM 摘要(summarize)来压缩和检索信息
- 不依赖向量数据库，用相似度(similarity)浮点值排序

### 2.2 数据模型 (`memory-model.ts`)

```typescript
interface Memory {
  id: string;              // 唯一标识 (UUID)
  sessionId: string;       // 所属会话 ID
  summary: string;         // 自然语言摘要
  tags: string[];          // 标签，用于筛选
  contextCutoff: boolean;  // 是否因 context 超限被截断
  turnRange: [number, number] | null; // 源对话轮次范围
  selectedPromptIds: string[];        // 关联的 prompt IDs
  similarity: number;      // 检索相似度分数 [0,1]
  usageCount: number;      // 被引用/使用次数
  lastUsedAt: string | null; // 最后使用时间 (ISO)
  createdAt: string;       // 创建时间 (ISO)
}
```

**关键设计意图**：
- `summary` 由 LLM 生成，是自然语言知识条目的核心载体
- `similarity` 不由向量点积计算，而是由 **PEPE(Pepe Entity Processing Engine)** 设置
- `selectedPromptIds` 和 `tags` 提供结构化筛选入口
- `contextCutoff` 标记因上下文窗口限制而截断的历史

### 2.3 存储层 (`memory-repository.ts`)

**文件布局**：
```
<workspace>/
└── .pueblo/
    └── memory/
        ├── sessions/
        │   └── <sessionId>/
        │       └── memory-<id>.json    # 每个 Memory 一个文件
        └── index/
            └── memory-index.json       # 索引(可选/待确认)
```

**核心方法**：
```typescript
class MemoryRepository {
  save(sessionId, memory): Promise<void>
  findById(sessionId, memoryId): Promise<Memory | null>
  findBySession(sessionId): Promise<Memory[]>
  delete(sessionId, memoryId): Promise<void>
  deleteBySession(sessionId): Promise<void>
}
```

**设计权衡**：
- ✅ **优势**：每个文件独立，方便审计、调试、手动编辑
- ✅ **优势**：无外部数据库依赖，零配置启动
- ❌ **代价**：大量 Memory 时文件系统 IO 成为瓶颈
- ❌ **代价**：无事务保障，并发写入有风险

### 2.4 查询层 (`memory-queries.ts`)

```typescript
class MemoryQueries {
  // 按 session + 条件过滤
  queryBySession(sessionId, filters?: QueryFilters): Promise<Memory[]>
  
  // 按标签精确匹配
  filterByTags(memories, tags, mode: 'and' | 'or'): Memory[]
  
  // 按 similarity 排序截取 Top-K
  topK(memories, k): Memory[]
}
```

**查询 DSL**：
- 按 `tags` 过滤（AND/OR 模式）
- 按 `similarity` 排序取 Top-K
- 按 `lastUsedAt` 排序（LRU 淘汰策略）
- 按 `contextCutoff` 过滤

### 2.5 核心服务 (`memory-service.ts`)

`MemoryService` 是 Memory 系统的门面(facade)，封装了增删改查、搜索、摘要和淘汰逻辑。

```typescript
class MemoryService {
  // CRUD 委托
  create(sessionId, input): Promise<Memory>
  read(sessionId, memoryId): Promise<Memory>
  update(sessionId, memoryId, patch): Promise<Memory>
  delete(sessionId, memoryId): Promise<void>
  
  // 搜索与选择
  search(sessionId, query, options?): Promise<Memory[]>
  select(sessionId, k): Promise<Memory[]>
  
  // 摘要与压缩
  summarize(sessionId, options?): Promise<SummarizeResult>
  
  // 生命周期管理
  prune(sessionId, strategy): Promise<PruneResult>
  pruneAll(strategy): Promise<PruneResult>
}
```

**核心流程 - 摘要(summarize)**：
1. 读取会话中所有 `turnRange` 未关闭的 Memory
2. 调用 LLM 将这些 Memory 聚合成新的摘要
3. 将旧的 Memory 标记为 `contextCutoff: true`
4. 保存新的摘要 Memory

**核心流程 - 搜索(search)**：
1. 通过 PEPE 引擎计算查询与每个 Memory 的 `similarity`
2. 按 `similarity` 排序
3. 应用 Top-K 截断

### 2.6 Workflow Memory (`workflow-memory.ts`)

为 Workflow(多步骤任务流)场景设计的专用 Memory 管理：

```typescript
class WorkflowMemory {
  // 跨步骤传递上下文
  getStepContext(workflowId, stepId): Promise<ContextBlock[]>
  setStepResult(workflowId, stepId, result): Promise<void>
  
  // Workflow 级别的 Memory 生命周期
  finalize(workflowId): Promise<void>
}
```

**设计意图**：
- 每个 Workflow Step 可以读取前序步骤的 Memory
- Workflow 完成后，Memory 合并到所属 Session 中
- 支持 Workflow 级别的上下文裁剪

### 2.7 生命周期管理

```
创建 → 活跃(Active) → 摘要压缩(Summarized)
                        ↓
                    截断(Cutoff) → 淘汰(Pruned)
```

- **摘要策略**：当 Memory 数量超过阈值或 Context 窗口不足时触发
- **淘汰策略**：基于 `usageCount` + `lastUsedAt` 的 LRU 变体
- **持久性**：淘汰的 Memory 文件默认保留，仅在明确调用 `prune` 时才物理删除

---

## 3. Context 系统

### 3.1 设计哲学

Context 系统解决**"LLM 上下文窗口有限"**这一核心约束。它通过三层 Pipeline 构建发送给 LLM 的 prompt：

```
原始数据 → Context Resolver (筛选/排序/裁剪) → Message Builder (格式化)
```

### 3.2 Context Resolver (`context-resolver.ts`) — 核心引擎

这是整个系统中**最复杂的模块**(~532行)，负责从多个来源拼装 final context。

```typescript
class ContextResolver {
  resolve(params: ResolveParams): Promise<ResolvedContext>
}
```

**输入 (`ResolveParams`)**：
```typescript
interface ResolveParams {
  sessionId: string;
  userInput: string;
  systemPrompt: string;
  task?: Task;
  skills?: Skill[];
  memory?: { include: boolean; maxMemories: number };
}
```

**输出 (`ResolvedContext`)**：
```typescript
interface ResolvedContext {
  systemPrompt: string;         // 系统级指令
  memories: Memory[];           // 选中的记忆条目
  contextBlocks: ContextBlock[]; // 结构化的上下文块
  tokenCount: ContextCount;     // Token 估算
  truncationLog: TruncationEntry[]; // 裁剪日志
}
```

**解析 Pipeline**：
```
Step 1: 加载 Profile & 配置
  ├─ 读取 pueblo.md → ProfileConfig
  ├─ 读取 provider 配置 → ProviderConfig
  └─ 初始化 Capacity (context window 限制)

Step 2: 收集 Context Sources
  ├─ System Prompt (来自 profile)
  ├─ Task Context (如果有关联任务)
  ├─ Skill Context (如果有关联技能)
  ├─ Memory (从 MemoryService 搜索)
  └─ User Input (本次输入)

Step 3: Token 估算 & 裁剪
  ├─ 按优先级排序 Context Blocks
  ├─ 按 token 预算逐步裁剪
  └─ 记录 Truncation Log

Step 4: 组装最终 Context
  └─ 返回 ResolvedContext
```

**优先级排序策略**：
```
优先级:  System Prompt > User Input > Task Context > Skill Context > Memory
裁剪:    从最低优先级开始丢弃
```

### 3.3 Task Context (`task-context.ts`)

构建任务级别的上下文块：

```typescript
class TaskContext {
  build(task: Task): Promise<ContextBlock[]> {
    // 1. 任务定义与目标
    // 2. 任务相关的 Memory
    // 3. 任务状态与进度
    // 4. 已完成步骤摘要
  }
}
```

**ContextBlock 结构**：
```typescript
interface ContextBlock {
  id: string;
  type: 'task-definition' | 'task-progress' | 'task-memory' | 'skill-definition' | 'system-directive';
  content: string;
  priority: number;     // 越大越优先保留
  tokenEstimate: number;
  source?: string;      // 来源标识，用于审计
}
```

### 3.4 Skill Context (`skill-context.ts`)

构建 Skill(LLM 可执行技能)的上下文块：

```typescript
class SkillContext {
  build(skills: Skill[]): Promise<ContextBlock[]> {
    // 1. 加载每个 Skill 的 SKILL.md
    // 2. 按 relevance 排序
    // 3. 构建 LLM 可执行的技能描述
    // 4. 裁剪不相关的技能
  }
}
```

**Skill 注入机制**：
- 每个 Skill 是一个 `SKILL.md` 文件
- 包含：目的、使用时机、输入、步骤、验证、限制
- Context Resolver 自动注入当前任务匹配的 Skill

### 3.5 Message Builder (`task-message-builder.ts`)

将 ResolvedContext 转换为 LLM API 所需的 message 格式：

```typescript
class TaskMessageBuilder {
  build(params: BuildParams): Promise<Message[]> {
    // 1. system prompt
    // 2. context blocks (formatted)
    // 3. memories (formatted)
    // 4. conversation history
    // 5. user input
  }
}
```

**消息格式**：
```
System: <system prompt + context blocks>
User:   <user input + selected memories>
Assistant: <model response>
Tool:   <tool results>
```

### 3.6 Profile 系统 (`pueblo-profile.ts`)

加载并解析 `pueblo.md` 配置文件，是整个系统的配置源头：

```typescript
class PuebloProfile {
  load(): Promise<Profile>;
  // 返回:
  // - systemPrompt: 系统级行为指令
  // - contextSettings: 上下文窗口, token 预算等
  // - memorySettings: 记忆数量, 摘要策略
  // - skillSettings: 技能选择策略
  // - providerSettings: LLM 提供者配置
}
```

---

## 4. 数据流全景

### 4.1 单轮交互流程

```
用户输入
    │
    ▼
┌─────────────────┐
│ 1. PuebloProfile │── 加载 pueblo.md 配置
└────────┬────────┘
         ▼
┌─────────────────┐
│ 2. ContextResolver │── 解析 Context
│                   │
│  ├─ TaskContext   │── 构建任务上下文
│  ├─ SkillContext  │── 构建技能上下文
│  └─ MemoryService │── 搜索相关记忆
└────────┬────────┘
         ▼
┌─────────────────┐
│ 3. Token Budget  │── 估算 & 裁剪
│    Manager       │
└────────┬────────┘
         ▼
┌──────────────────┐
│ 4. MessageBuilder│── 组装 LLM Messages
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 5. LLM Provider  │── 调用 LLM
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 6. MemoryService │── 将交互结果写入 Memory
│    .summarize()  │    (摘要 & 更新)
└──────────────────┘
```

### 4.2 Memory 写入时机

| 时机 | 写入内容 | 触发者 |
|------|---------|--------|
| 每轮交互结束 | `{ summary, tags, turnRange }` | Agent Runner |
| Context 超限 | `{ contextCutoff: true }` | MemoryService.prune() |
| 手动 / 定时摘要 | 压缩后的 `{ summary }` | MemoryService.summarize() |
| Workflow 步骤完成 | `{ workflowId, stepResult }` | WorkflowMemory |
| 用户明确要求"记住" | `{ summary, tags }` | Agent Runner |

### 4.3 Memory 读取时机

| 时机 | 读取策略 | 触发者 |
|------|---------|--------|
| 每轮 Context 构建 | `search(userInput)` Top-K | ContextResolver |
| Task 初始化 | `findBySession(taskSessionId)` | TaskContext |
| Skill 选择 | `filterByTags(['skill:'...])` | SkillContext |
| Workflow Step | `getStepContext(workflowId, step)` | WorkflowMemory |

---

## 5. 核心接口与契约

### 5.1 MemoryService 接口契约

| 方法 | 前置条件 | 后置条件 | 失败模式 |
|------|---------|---------|---------|
| `create` | sessionId 存在 | Memory 文件写入磁盘 | IO 错误 |
| `search` | 查询字符串非空 | 返回 Top-K Memory (按 similarity) | PEPE 不可用 |
| `summarize` | 至少 2 条未 cutoff Memory | 旧 Memory 标记 cutoff, 新 Memory 创建 | LLM 调用失败 |
| `prune` | 无 | 物理删除 Memory 文件 | IO 错误 |

### 5.2 ContextResolver 接口契约

| 输入 | 约束 | 输出保证 |
|------|------|---------|
| `userInput` | 必填, string | 总 token ≤ contextWindowLimit |
| `systemPrompt` | 必填, string | 始终包含在最终 Context 中 |
| `task` | 可选 | 存在时包含 task-definition block |
| `skills` | 可选 | 按 relevance 排序后注入 |
| `memory` | 可选, 含 `{include, maxMemories}` | 最多注入 maxMemories 条 |

### 5.3 裁剪契约

```typescript
interface TruncationEntry {
  blockId: string;
  type: string;
  reason: 'token-overflow' | 'priority-low' | 'redundant';
  originalTokens: number;
  keptTokens: number;
}
```

所有裁剪操作必须记录 `TruncationEntry`，确保可审计性。

---

## 6. 设计权衡与决策记录

### ADR-001: 文件存储 vs 外部数据库

**决策**：使用文件系统 + JSON，不依赖外部数据库。

**理由**：
- 零外部依赖，clone 即用
- 文件即数据库，方便人工审计和调试
- 个人工具场景下数据量可控

**代价**：
- 无 ACID 事务保障
- 大量 Memory 时 IO 成为瓶颈
- 无内置索引（仅在目录级别用 sessionId 分区）

### ADR-002: LLM 摘要 vs 向量嵌入检索

**决策**：用 LLM 生成自然语言摘要，搭配 PEPE 计算相似度。

**理由**：
- 避免引入向量数据库 (如 Chroma, Pinecone)
- 摘要自然语言可读，方便审计
- 相似度计算由 PEPE 引擎完成（不依赖嵌入模型）

**代价**：
- 搜索质量依赖 LLM 摘要质量
- 每次搜索需要扫全量 Memory（除非 tag 预过滤）
- LLM 调用成本更高

### ADR-003: Context 裁剪策略

**决策**：纯位置/长度截断 + Token 预算硬裁剪。

**实际实现**（而非设计意图）：
- `selectRecentMessagesForPrompt()`: 保留最后 `RECENT_CONTEXT_MESSAGE_LIMIT = 6` 条消息（纯位置，注意：这里是**步(step)**而非**回合(turn)**，实际仅覆盖约 1-2 回合）
- `compactRecentMessageForPrompt()`: head(300) + tail(140) 字符截断（纯长度）
- 紧凑模式 (`utilizationRatio > 0.65`): 进一步压缩为 head(400) + tail(100)
- `retentionHints` / `truncationHints`: 注入到 LLM system prompt 的自然语言指令，**无程序化强制**

**代价（实际观察到的）**：
- 位置截断不区分语义重要性：tool-result 列表与关键约定同等对待
- 12 次工具调用即可耗尽 25 条消息限制
- head+tail 压缩丢弃中间内容，"将讨论成果更新到 X 文档"这类约定容易丢失
- Hints 依赖 LLM 自愿遵循，不可靠

**待改进**：见第 8 章诊断分析。

### ADR-004: Profile vs 代码配置

**决策**：通过 `pueblo.md` 文件进行系统配置。

**理由**：
- 用户无需修改代码即可调整行为
- Markdown 格式对 LLM 友好
- 与项目文档自然共存

**代价**：
- 配置变更需要重新加载
- 没有配置校验（pueblo.md 为自由格式）

### ADR-005: Memory-Session 回链缺失

**决策**：当前实现中，Memory 创建与 Session 关联是分离的。

**实际状态**：
- `MemoryService.createConversationTurnMemory()` 创建 memory 记录（孤儿）
- 创建的 memory ID 从不回写到 `session.selectedMemoryIds` 或 `session.workingMemoryIds`
- 新 Session 初始化时 `selectedMemoryIds` 始终为 `[]`
- `resolveMemorySelection` 是纯 ID 查找，不在 `selectedMemoryIds` 为空时 fallback 到语义搜索

**代价**：
- 跨 Session 记忆完全失效
- `background-summary` session（Schema 已定义）未在 TS 源码中实现
- `reconcileWorkingMemoryIds` 的衰减机制设计合理但无数据源填充

**待改进**：见第 8.4 节 P0 级建议。
- 无版本管理

### ADR-005: Memory 分散存储 vs 集中存储

**决策**：每个 Memory 独立文件，按 sessionId 目录分区。

**理由**：
- 文件级别独立：方便删除、修改单个条目
- 目录级别分区：按 session 自然隔离
- 适合 Git 追踪单文件变更

**代价**：
- 大量文件时文件系统压力大 (inode 耗尽风险)
- 跨 session 搜索需要遍历多个目录

---

## 7. 限制与未来方向

### 已知限制

1. **扩展性瓶颈**：文件系统 IO 在 10K+ Memory 量级时可能出现性能衰减
2. **搜索能力有限**：依赖 tag 预过滤的精确匹配，不支持语义查询
3. **无一致性保障**：并发写入同一 session 可能导致数据丢失
4. **LLM 强依赖**：摘要、搜索、相似度都依赖 LLM，Provider 故障时系统不可用
5. **Context 裁剪过于简单**：固定优先级策略可能丢弃有价值的上下文

### 未来方向

1. **分层存储**：热数据 (最近 N 条) 内存缓存，冷数据文件系统
2. **增量索引**：引入内存 inverted index 加速 tag 搜索
3. **混合搜索**：tag 精确过滤 + LLM 重排序的两阶段搜索
4. **写入队列**：异步写入 + 批量 flush，缓解 IO 压力
5. **自适应裁剪**：基于历史利用率动态调整各类型 Context Block 的 Token 预算
6. **Memory 版本化**：跟踪 Memory 变更历史，支持回滚

---

## 8. Memory 问题诊断与根因分析

> **诊断日期**: 2025-07-17
> **诊断方法**: 静态代码追踪 + 数据流分析，覆盖 `context-resolver.ts`、`task-message-builder.ts`、`memory-service.ts`、`pepe-result-service.ts`、`session-service.ts` 的完整调用链。

### 8.1 问题一：会话内遗忘（Within-Session Amnesia）

**现象**: 几轮对话后，LLM 忘记目标、重要文档、刚达成的约定（如"将讨论成果更新到某个文档"）。

**根因链路**（自上而下追踪）：

```
用户输入 → ContextResolver.resolve()
  ├─ ① selectRecentContextMessages(session.messageHistory)
  │     → formatSessionMessageForContext()  对每条消息做 head(500) 截断
  │
  ├─ ② selectRecentMessagesForPrompt()
  │     → 只保留最后 RECENT_CONTEXT_MESSAGE_LIMIT = 6 条消息（**步级而非回合级**）
  │
  ├─ ③ isCompactContextModeEnabled() 
  │     → 当 utilizationRatio > COMPACT_CONTEXT_UTILIZATION_THRESHOLD(0.65) 时触发
  │     → compactRecentMessageForPrompt() 进一步压缩为 head(400) + tail(100)
  │
  └─ ④ summarizeTaskStepTrace(latestTaskPayload?.stepTrace)
        → 生成 "Active turn step context" 块（已压缩的 tool-result 列表）
```

**根因分析**：

| 层级 | 机制 | 问题 |
|------|------|------|
| **消息选择** | `RECENT_CONTEXT_MESSAGE_LIMIT = 6`，纯位置截断（步级） | 第 7 条消息直接丢弃，不论其重要性。一轮对话中 tool-call + tool-result 各算一条，3-4 次工具调用就耗尽 6 条限制（约 1-2 回合）。**关键歧义**：变量名称为 MESSAGE，设计意图应为 25 **回合(turn)**，但实现以**步(step，即单条消息)** 为单位计数 |
| **消息压缩** | `compactRecentMessageForPrompt()`: head(300) + tail(140) | 纯位置压缩，中间内容被丢弃。重要信息如果不在头尾 440 字符内就丢失 |
| **紧凑模式** | `utilizationRatio > 0.65` 时触发 | 进一步压缩为 head(400) + tail(100)，信息损失更大 |
| **tool-result 挤占** | `summarizeTaskStepTrace` 将每步 tool-result 压缩后仍占位在上下文中 | "低价值 tool-result 列表" 与 "高价值目标/约定" 在消息队列中地位相同，一起参与 25 条截断 |

**核心矛盾**: **截断策略是纯位置/长度的，不区分信息的语义重要性**。当 LLM 调用工具查看文件、搜索代码时，这些 tool-result 与"记住要将讨论成果更新到 architecture-document.md"这样的关键约定，在消息队列中被同等对待。

**retentionHints 的局限性**: `pueblo-profile` 中的 `memoryPolicy.retentionHints` 和 `contextPolicy.priorityHints` 是**自然语言提示注入到 LLM system prompt** 的，依赖 LLM **自愿遵循**。没有任何程序化机制来强制保留标记为重要的消息。

### 8.2 问题二：跨会话遗忘（Cross-Session Amnesia）

**现象**: 重启 session 后，之前的讨论上下文、约定、分析成果全部丢失。

**根因链路**：

```
新 Session 创建
  ├─ sessionService.createSession()
  │     → selectedMemoryIds: []    ← 始终为空数组
  │     → pinnedMemoryIds: []      ← 始终为空数组
  │     → workingMemoryIds: []     ← 始终为空数组
  │
  └─ ContextResolver.resolve()
        └─ pepeResultService.resolve(input.selectedMemoryIds)
              └─ memoryService.resolveMemorySelection([])
                    → 返回 []   ← 无 Memory 被加载
```

**关键发现**：

1. **Memory 文档被创建但从未被关联回 Session**：
   - `MemoryService.createConversationTurnMemory()` 会在每轮对话创建 memory 记录（含 `sourceSessionId`）
   - 但创建的 memory ID **从不写入** `session.selectedMemoryIds` 或 `session.workingMemoryIds`
   - 这些 memory 成为**孤儿记录**——存在文件系统中，但没有任何 session 引用它们

2. **`resolveMemorySelection` 是纯 ID 查找，不是语义搜索**：
   ```typescript
   // memory-service.ts 逻辑等价
   resolveMemorySelection(memoryIds: string[]): MemoryRecord[] {
     return memoryIds.flatMap((memoryId) => {
       try { return [this.selectMemory(memoryId)]; }
       catch { return []; }
     });
   }
   ```
   它只是 `getById()` 的批量版本。当 `memoryIds` 为空时，返回空。不会做语义检索。

3. **`workingMemoryIds` 有衰减但无填充**：
   - `reconcileWorkingMemoryIds()` 实现了权重衰减和过期机制
   - 但 `workingMemoryIds` 的初始值始终为 `[]`
   - 没有任何代码路径将 `createConversationTurnMemory` 的结果加入 `workingMemoryIds`

4. **`background-summary` 机制未在 TS 源码中实现**：
   - Schema 定义了 `sessionKind: 'background-summary'` 和 `triggerReason: 'context-threshold' | 'manual-summary'`
   - 这些值出现在 SQLite 数据中，但 TypeScript 源码中没有任何创建 background-summary session 的逻辑
   - 该功能可能是**计划中但未完成**的，或仅存在于编译后的 JS 代码中

### 8.3 数据流断裂全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                      当前实现的数据流                              │
│                                                                   │
│  [Session.messageHistory]                                        │
│       │                                                          │
│       ▼                                                          │
│  selectRecentMessagesForPrompt() ─── 纯位置截断(最后6条步级消息)   │
│       │                                                          │
│       ▼                                                          │
│  compactRecentMessageForPrompt() ─── 纯长度压缩(head+tail)        │
│       │                                                          │
│       ▼                                                          │
│  [LLM Context] ← retentionHints (自然语言，无强制力)              │
│                                                                   │
│  ═════════════ 断裂点 ═════════════                               │
│                                                                   │
│  [MemoryService.createConversationTurnMemory()]                   │
│       │                                                          │
│       ▼                                                          │
│  [Memory Store] ← 孤儿记录，无 Session 回链                       │
│                                                                   │
│  [Session.selectedMemoryIds] ← 始终为 []                          │
│  [Session.workingMemoryIds] ← 始终为 []                           │
│                                                                   │
│  ═════════════ 断裂点 ═════════════                               │
│                                                                   │
│  新 Session → selectedMemoryIds: [] → resolveMemorySelection([])  │
│       → 返回 [] → LLM 无任何跨会话记忆                             │
└─────────────────────────────────────────────────────────────────┘
```

### 8.4 改进建议

#### 针对问题一（会话内遗忘）

| 优先级 | 改进 | 说明 |
|--------|------|------|
| **P0** | **语义化消息分层** | 为消息引入 `priority` 标签（`critical`/`normal`/`low-value`），`selectRecentMessagesForPrompt` 改为优先保留 `critical` 消息，而非纯位置截断 |
| **P0** | **程序化 retention 执行** | 将 `retentionHints` 从"LLM 自愿遵循"改为"程序化强制"——当消息被标记为 `critical` 时，在截断算法中优先保留 |
| **P1** | **滚动上下文摘要** | 每 N 轮自动生成一段"当前目标与约定摘要"，注入到每条 LLM prompt 的固定位置，不参与步级消息截断（见第 9 章分析） |
| **P1** | **tool-result 降权** | 将 tool-result 消息的默认 priority 设为 `low-value`，在截断时优先丢弃 |

#### 针对问题二（跨会话遗忘）

| 优先级 | 改进 | 说明 |
|--------|------|------|
| **P0** | **Memory 回链机制** | `createConversationTurnMemory` 创建后，将 memory ID 自动追加到 `session.workingMemoryIds` 和 `session.selectedMemoryIds` |
| **P0** | **Session 初始化时自动加载** | 新 session 创建时，从最近的 archived session 继承 `selectedMemoryIds`（排除已过期的） |
| **P1** | **实现 background-summary → Memory** | 当触发 background-summary 时，不仅创建 summary session，还要将摘要写入 `MemoryRecord`（`kind: 'summary'`），并回链到原 session |
| **P1** | **语义 Memory 召回** | `resolveMemorySelection` 在 `selectedMemoryIds` 为空时，fallback 到语义搜索（调用 `searchMemories(query)`），而非返回空 |
| **P2** | **关键事实自动提取** | Session 关闭/归档时，自动扫描 `messageHistory` 提取目标声明、文档引用、约定，生成 `kind: 'state'` 的 Memory 文档 |

### 8.5 设计原则总结

当前架构的**正确设计**：
- ✅ Memory 数据模型（`MemoryRecord`）设计良好：`memoryKind`、`weight`、`tags`、`scope` 分层清晰
- ✅ `reconcileWorkingMemoryIds` 的衰减机制设计合理
- ✅ `background-summary` session 的概念正确（将摘要与会话分离）
- ✅ `retentionHints` / `priorityHints` 的方向正确（让 LLM 知道什么重要）

当前架构的**缺失连接**：
- ❌ Memory 创建 → Session 回链：创建了 memory 但不告诉 session
- ❌ Session 归档 → Memory 继承：新 session 不继承旧 session 的 memory
- ❌ 截断算法：纯位置/长度，不区分语义重要性
- ❌ Hints：只有自然语言建议，没有程序化强制执行
- ❌ `background-summary`：Schema 已定义但 TS 源码中无实现

---

## 附录：模块文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/memory/memory-model.ts` | 43 | Memory 数据模型定义 |
| `src/memory/memory-repository.ts` | 162 | JSON 文件读写与持久化 |
| `src/memory/memory-queries.ts` | 15 | 查询 DSL 与过滤 |
| `src/memory/memory-service.ts` | 467 | Memory 核心业务逻辑 |
| `src/memory/workflow-memory.ts` | 51 | Workflow 专用 Memory |
| `src/agent/context-resolver.ts` | 532 | Context 解析引擎 |
| `src/agent/task-context.ts` | 117 | 任务级上下文构建 |
| `src/agent/skill-context.ts` | 131 | 技能级上下文构建 |
| `src/agent/task-message-builder.ts` | 376 | LLM Message 组装 |
| `src/agent/pueblo-profile.ts` | 180 | 系统配置加载 |
| `src/shared/schema.ts` | 701 | Zod Schema 定义 |
| `src/shared/result.ts` | 765 | 结果类型定义 |

---

> 本文档将在每次架构讨论后更新。最新版本请查看 workspace 对应目录。

---

## 9. 用户建议可行性分析（Turn / Step / Memory Tiers / Priority+Weight / Active Recall）

> 本章分析用户基于第 8 章诊断结果提出的四项改进建议，验证可行性并给出具体设计方向。

---

### 9.1 建议一：「RECENT_CONTEXT_MESSAGE_LIMIT = 25 的本意是保留 25 回合(turn)对话记忆，但程序实现局限在 25 步(step)记忆」

#### 9.1.1 现状核实

| 维度 | 用户理解 | 实际值 | 偏差 |
|------|---------|--------|------|
| 常量值 | 25 | **6** | 实际值比意图小 4 倍 |
| 单位 | 回合(turn) | **步/消息(step/message)** | 根本性概念歧义 |
| 覆盖范围(意图) | ~25 轮交互 | ~1-2 轮交互 | 相差约 20 倍 |

代码证据 (`src/agent/task-message-builder.ts:5`)：

```typescript
export const RECENT_CONTEXT_MESSAGE_LIMIT = 6;
```

调用链 (`context-resolver.ts` → `task-message-builder.ts`)：

```typescript
// context-resolver.ts:512 - 对 messageHistory 切片
const recentMessages = sessionMessages.slice(-6);
// 不做语义分组、不识别回合边界，纯按数组位置截断
```

#### 9.1.2 根因：系统中没有「回合(Turn)」概念

当前 `SessionMessage` 的 Schema (`src/shared/schema.ts`)：

```typescript
export const sessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  // ... 无 turnId, turnIndex, isTurnBoundary 等字段
});
```

`messageHistory` 是一个 **扁平的消息序列数组**，每个 tool-call、tool-result、assistant 回复、user 输入各自是一条独立记录。一条典型的「用户提问 → LLM 思考+工具调用 → 工具结果 → LLM 回复」这一完整回合会拆成 4-8 条消息。

因此 `RECENT_CONTEXT_MESSAGE_LIMIT = 6` 实际只覆盖 ~1-2 个回合（取决于每回合工具调用密度）。

#### 9.1.3 分析结论：**可行，需要引入回合概念**

| 改进项 | 方案 | 复杂度 |
|--------|------|--------|
| **回合定义** | 以「user 角色的消息」为回合边界，同一回合内的后续 assistant/tool 消息属于同回合 | 低 |
| **回合 ID** | 给 `SessionMessage` 增加可选字段 `turnId?: string`，回合边界消息标记 `isTurnBoundary?: boolean` | 低 |
| **回合选择** | 新增 `RECENT_CONTEXT_TURN_LIMIT = 25`，替换 `MESSAGE_LIMIT`：取最后 N 个回合（而非 N 条消息） | 中 |
| **回合内压缩** | 已完成的回合（非当前回合）可压缩为「回合摘要」而非保留全部原始消息（见 9.2 短-中-长期分层设计） | 中 |
| **向后兼容** | `turnId` 为可选字段，旧 session 数据无需迁移即可正常工作（无 turnId 时回退到消息计数） | 低 |

**推荐实现路径**：

1. **Phase 1**：给 `SessionMessage` 增加 `turnId` + `turnIndex` 可选字段
2. **Phase 2**：会话服务在 `addMessage` 时自动检测回合边界（role='user' 或上一个 agent 任务完成），分配新 turnId
3. **Phase 3**：`selectRecentContextMessages` 改为 `selectRecentTurnContext`——按 turnId 分组后取最后 N 个回合，同回合消息全部保留
4. **Phase 4**：非活跃回合自动生成摘要，原始消息存 messageHistory 但不进 prompt（节省 token 同时保留审计能力）

---

### 9.2 建议二：「记忆设定分短中长期三层」

#### 9.2.1 用户分层模型 vs 当前系统映射

```
用户分层模型                      当前系统状态
──────────────────────────────────────────────────
短期 (Short-term)                 ✅ messageHistory（扁平，无回合边界）
  一个回合内的 step 记忆          ❌ 无回合摘要机制
  → 回合结束时总结即可            ❌ 全量原始消息保留，无压缩

中期 (Medium-term)                ⚠️  workingMemoryIds（字段存在但内容空）
  确保具体目标 & 约束不丢失       ❌ 无目标/约束的显式存储
                                 ❌ Memory-Session 无回链（ADR-005）

长期 (Long-term)                  ⚠️  MemoryRecord（存在但有缺陷）
  宽泛知识，跨会话复用           ❌ memory-backlinks.ts 未实现
                                 ❌ 新 session 不继承旧 session 记忆
```

#### 9.2.2 三层架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: 短期 (Turn Memory)                                     │
│  ─────────────────────────                                      │
│  生命周期: 单个回合内                                             │
│  存储: messageHistory (带 turnId)                                │
│  上下文策略:                                                     │
│    • 当前回合: 完整保留所有 step                                  │
│    • 已完成的 N-1 个回合: 仅保留「回合摘要」进 prompt             │
│    • 最近 1-2 回合: 保留完整消息（为上下文连贯）                  │
│  摘要生成: 回合结束时由系统自动触发 summarizeTurn()               │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: 中期 (Goal/Constraint Memory)                          │
│  ─────────────────────────────────────                           │
│  生命周期: 当前任务的持续时间内（可跨回合、跨 session）           │
│  存储: workingMemoryIds[] (MemoryRecord 引用)                    │
│  内容:                                                           │
│    • 当前任务目标 (goal)                                          │
│    • 硬性约束 (constraints)                                       │
│    • 重要约定/文档路径 (pinned documents)                        │
│    • 当前进度状态 (progress state)                               │
│  上下文注入: 每条 LLM prompt 固定位置注入（不参与截断）          │
│  更新方式: 系统自动 + LLM 主动声明 (via tool)                    │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: 长期 (Knowledge Memory)                                │
│  ─────────────────────────────                                   │
│  生命周期: 跨 session / 跨项目                                    │
│  存储: MemoryRecord (JSON 文件，PePe 索引)                       │
│  内容:                                                           │
│    • 项目架构知识                                                 │
│    • 历史决策与 ADR                                               │
│    • 通用工作模式/偏好                                            │
│  检索方式:                                                        │
│    • Push: PePe 相似度推荐 (当前已有)                             │
│    • Pull: LLM 主动搜索 (见 9.4)                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 9.2.3 实现优先级

| 优先 | 组件 | 理由 |
|------|------|------|
| **P0** | 回合摘要 (Turn Summary) | 直接解决「会话内遗忘」根因，将 N 条消息压缩为 1 条摘要 |
| **P0** | 中期工作记忆 (Working Memory 内容化) | 确保目标/约束不因截断而丢失 |
| **P1** | 回合边界检测与 turnId | 支撑回合摘要和回合级上下文选择 |
| **P2** | 长期记忆跨会话继承 | 解决「重启 session 后遗忘」问题 |

---

### 9.3 建议三：「priority 标签能否与 weight 结合」

#### 9.3.1 当前状态：Weight 已部分实现（~70%），但未用于上下文注入

**关键发现：Weight 系统已在代码中实现**，但仅服务于记忆生命周期管理（衰减→合并→淘汰），**尚未**用于控制哪些记忆注入上下文。以下为完整审计：

---

##### 9.3.1.1 已实现层：Weight 配置 (`src/shared/config.ts`)

五种记忆类型各有**独立的 WeightPolicy**：

| 记忆类型 | initialWeight | decayPerTurn | mergeThreshold | 语义 |
|----------|:---:|:---:|:---:|------|
| `sessionSummary` | 0.95 | 0.01 | 0.85 | 会话摘要，衰减最慢，最持久 |
| `derivedSummary` | 0.90 | 0.04 | 0.80 | 派生摘要（PePe 搜索结果） |
| `knowledge` | 0.90 | 0.02 | 0.75 | 长期知识，衰减慢，不易淘汰 |
| `workflow` | 0.85 | 0.03 | 0.70 | 工作流/流程记忆 |
| `turn` | 0.80 | 0.08 | 0.65 | 单回合记忆，衰减最快 |

所有策略的 `minWeight=0, maxWeight=1`，权重域为 `[0, 1]`。

##### 9.3.1.2 已实现层：Weight 字段与持久化 (`src/shared/schema.ts:248`)

`MemoryRecord` 已有 `weight: number` 字段，所有记忆创建时从对应 policy 获取 `initialWeight` 赋值。

##### 9.3.1.3 已实现层：Weight 生命周期管理 (`src/memory/memory-service.ts`)

核心函数链：

```
resolveWeightPolicy(memoryKind, tags)  →  获取对应 policy
resolveWeightBounds(memoryKind, tags)  →  获取 min/max 边界
clampWeight(weight, min, max)          →  钳制到合法范围
maybeDecayMemory(memory, turnsPassed)  →  weight = currentWeight - decayPerTurn × turns
adjustWeight(...)                      →  事件驱动的权重调整（delta 或半衰期）
```

**每回合执行**：`applyDecay()` 遍历所有记忆，调用 `maybeDecayMemory()`。当 weight 低于 `mergeThreshold` 时标记为可合并（"cold"记忆），低于 `decayElimination` 阈值时标记为可淘汰。

##### 9.3.1.4 **关键缺口**：Weight 未用于上下文注入 (`src/agent/context-resolver.ts`)

`context-resolver.ts` 中的记忆查询使用 **`lastUpdatedAt`（最近更新时间）** 排序，完全不考虑 weight：

```
当前排序：ORDER BY lastUpdatedAt DESC  （纯时间排序）
应有排序：ORDER BY weight DESC          （权重排序）
最低要求：WHERE weight > injectionThreshold  （权重过滤）
```

**结论**：Weight 流水线从「创建 → 衰减 → 合并/淘汰」已完整实现，但在「哪些记忆注入 LLM 上下文」这个最关键消费环节**断链**。Weight 控制记忆「何时死」，但不控制记忆「何时被看见」。

##### 9.3.1.5 PePe 独立权重系统 (`src/agent/pepe-result-ranking.ts`)

存在另一个独立的 `stickyWeight` 机制，用于 PePe 工具返回结果的排名——这与 MemoryRecord 的 weight 是**两个独立系统**，互不联通。

---

#### 9.3.2 分析结论：Weight 已有基础设施，需补「上下文注入」消费端

Weight 系统已经回答了三个问题中的两个：

| 问题 | 实现状态 |
|------|---------|
| ① 每种记忆类型有不同的权重初值和衰减速率？ | ✅ 已实现（5 种 policy） |
| ② 权重随时间衰减，低至阈值触发合并/淘汰？ | ✅ 已实现（每回合 decay） |
| ③ 权重影响记忆是否注入上下文？ | ❌ **未实现**（按 recency 排序） |

因此建议三的定位从「从零构建 Weight」**修正为**「打通现有 Weight 到上下文注入的最后环节」。这是四项建议中**实施成本最低**的一项——基础设施已就绪，只需在 `context-resolver.ts` 的查询中增加 weight 排序和阈值过滤。

Priority 标签作为叠加层仍然有价值：

| 维度 | Priority（优先级） | Weight（权重） |
|------|-------------------|---------------|
| 来源 | LLM 或系统显式标注 | 系统自动计算 |
| 语义 | "这条信息有多重要" | "这条信息在当前场景下的综合得分" |
| 类型 | 离散标签 (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) | 连续数值 `0.0 ~ 1.0` |
| 更新方式 | 事件驱动（LLM 声明） | 每回合自动衰减 + 事件调整 |
| **当前状态** | ❌ 未实现 | ✅ **已实现（但缺消费端）** |

**组合公式**（Priority 作为 weight 的调控因子叠加到现有体系）：

```
adjustedWeight = baseWeight × priorityMultiplier

其中:
  baseWeight        = MemoryRecord.weight（已有，每回合自动衰减）
  priorityMultiplier = map(Priority) → {CRITICAL:1.5, HIGH:1.2, MEDIUM:1.0, LOW:0.7}
  
  CRITICAL 记忆的 weight 被抬高 → 更慢触达 merge/elimination 阈值 → 更持久
  LOW 记忆的 weight 被压低 → 更快淘汰
```

#### 9.3.3 实现设计

**阶段一（打通现有 Weight，1 行改动 + 配置）**：

在 `context-resolver.ts` 的记忆查询中，将排序从 `ORDER BY lastUpdatedAt DESC` 改为 `ORDER BY weight DESC`，并增加可配置的 `injectionWeightThreshold`（低于此阈值的记忆不注入上下文）。

```typescript
// context-resolver.ts 改动要点
// 当前:
//   resolveMemories() → ORDER BY lastUpdatedAt DESC → 取前 N 条
// 改为:
//   resolveMemories() → WHERE weight >= injectionWeightThreshold
//                     → ORDER BY weight DESC
//                     → 取前 N 条
```

**阶段二（Priority 叠加）**：

```typescript
// memory-model.ts 扩展
interface MemoryRecord {
  // ... 现有字段（包括已有的 weight: number）
  priority?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';  // 新增
}

// memory-service.ts 现有 adjustWeight 函数可直接复用
function applyPriorityBoost(record: MemoryRecord): number {
  const multiplier = { CRITICAL: 1.5, HIGH: 1.2, MEDIUM: 1.0, LOW: 0.7 };
  return clampWeight(
    record.weight * (multiplier[record.priority ?? 'MEDIUM']),
    resolveWeightBounds(record.kind, record.tags)
  );
}
```

**核心价值**：阶段一几乎零成本打通现有 Weight 到上下文注入，立即改善「重要记忆被新记忆淹没」的问题。阶段二通过 Priority 让 LLM 可以显式标注关键记忆，实现「重要性底分 + 时间衰减 + 上下文注入」三者闭环。

---

### 9.4 建议四：「增加 tool 或 skill，给 LLM 主动召回记忆的能力」

#### 9.4.1 当前模式：纯 Push

现在整个记忆系统是**被动推送**模式：

```
MemoryService → resolveMemories() → 自动注入 prompt → LLM 只能被动接收
```

LLM 无法：
- 主动查询「我们之前讨论过什么」
- 回顾「当前任务的目标和约束是什么」
- 搜索「类似的问题之前怎么解决的」

#### 9.4.2 目标模式：Push + Pull 双通道

```
                    ┌──────────────────────────┐
                    │      LLM Model            │
                    └──────┬──────────┬─────────┘
                           │          │
                   Push (系统自动)    Pull (LLM 主动)
                           │          │
              ┌────────────┘          └──────────────┐
              ▼                                     ▼
    ┌─────────────────┐                  ┌──────────────────┐
    │ 自动注入层       │                  │ Memory Tools      │
    │ (现有 logic)     │                  │ (新增 Skill/Tool) │
    │                 │                  │                  │
    │ • 滚动摘要      │                  │ • recall_memory   │
    │ • 中期工作记忆  │                  │ • summarize_turn  │
    │ • PePe 推荐     │                  │ • list_working    │
    │ • Recent msgs   │                  │   _memory         │
    └─────────────────┘                  └──────────────────┘
```

#### 9.4.3 具体 Tool/Skill 设计

**Tool 1: `recall_memory`**

```
用途: LLM 主动搜索记忆库
参数:
  - query: 自然语言搜索词
  - kind: 记忆类型过滤 (optional: "goal"|"constraint"|"document"|"decision")
  - limit: 返回条数 (default 5)
返回:
  - matches: [{title, content, similarity, priority, created_at, ...}]
实现:
  调用 MemoryService.searchSemantically(query, kind, limit)
  结果以工具结果形式注入上下文
```

**Tool 2: `check_working_context`**

```
用途: LLM 主动查看当前工作记忆状态
参数: 无
返回:
  - goals: 当前活跃目标列表
  - constraints: 当前约束列表
  - pinned_documents: 已锚定的文档列表
  - recent_summaries: 最近回合摘要
  - session_stats: 消息数、回合数、token 估算
实现:
  汇总 session.workingMemoryIds 对应的 MemoryRecord 内容
```

**Tool 3: `summarize_session_so_far`**

```
用途: LLM 主动请求生成会话进度摘要（当感到迷失时）
参数: 无
返回:
  - summary: 当前会话的进度摘要
  - goals_achieved: 已完成的目标
  - goals_pending: 待完成的目标
  - important_decisions: 已作出的重要决策
实现:
  遍历最近 N 个回合的 turnSummary，生成综合摘要
```

#### 9.4.4 实现方案对比

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| **A: 原生 Tool** (集成到 agent tool system) | 与现有 tool-call 基础设施完全兼容；LLM 现有 tool-call 能力直接可用 | 增加 tool 数量（context 预算竞争） | ⭐⭐⭐⭐⭐ |
| **B: 独立 Skill** (作为 skill-context 的一部分) | 模块化；可单独迭代 | 调用方式不如 tool 统一 | ⭐⭐⭐ |
| **C: Prompt Hint** (在 system prompt 中提示可用命令) | 零基础设施成本 | 不可靠，依赖 LLM 文本遵循能力 | ⭐⭐ |

**推荐**：方案 A（原生 Tool），理由：
- Pueblo 已有成熟的工具调用基础设施（`tool-call` / `tool-result`）
- LLM 模型原生支持 tool-use，无需额外适配
- 可以纳入步数预算管理，避免无限递归搜索
- 成本可控：每次 `recall_memory` 调用 ≈ 0.5-1K tokens（结果注入上下文）

#### 9.4.5 调用预算控制

为防止 LLM 陷入搜索循环：

```typescript
const ACTIVE_RECALL_BUDGET = {
  maxCallsPerTurn: 3,       // 每回合最多调用 3 次 recall 类工具
  maxResultsPerCall: 5,     // 每次最多返回 5 条结果
  maxContextExpenditure: 2000, // 每次调用注入上下文不超过 2000 tokens
};
```

#### 9.4.6 分析结论：**高度可行，且是架构突破**

| 维度 | 评估 |
|------|------|
| **技术可行性** | 高 — 现有 tool system + MemoryService.searchSemantically 即可支撑 |
| **价值** | **极高** — 将记忆从被动推送升级为主动召回，根本性改变架构范式 |
| **风险** | 中 — 需要预算控制避免搜索循环；需要 LLM 学习何时调用 |
| **与 9.1-9.3 的关系** | 互补 — 层次化记忆(9.2)让 recall 有清晰的目标，weight(9.3)让 recall 结果更精准 |
| **推荐优先级** | P0 — 与回合摘要同步推进，形成 Push + Pull 闭环 |

---

### 9.5 四项建议综合评估

```
建议                      可行性  复杂度  价值    依赖关系
──────────────────────────────────────────────────────────
① Turn vs Step 修正       ✅ 高   低      高      无
② 短中长期记忆分层        ✅ 高   中      极高    依赖 ①(回合概念)
③ Priority + Weight       ✅ 高   中      高      依赖 ②(中期记忆需 priority)
④ LLM 主动召回            ✅ 高   中      极高    依赖 ②③(分层的记忆才值得搜索)
```

**推荐实施顺序**：

```
Phase A ──→ Phase B ──→ Phase C ──→ Phase D
  │             │            │            │
  ① Turn/Step  ② 记忆分层  ③ Priority   ④ Active
    修正          + 摘要      + Weight     Recall
```

> 四项建议均可行，且相互增强而非冲突。核心突破口在 **① 引入回合概念** 和 **④ LLM 主动召回** — 前者解决结构性缺陷，后者开辟新的交互范式。

---

# 第10章 快照与自动保存架构（Snapshot & Auto-Save）

## 10.1 架构定位

自动保存（Auto-Save）是编辑工具（`edit-tool`）的一个可选加速路径，位于【编辑工具→文件系统】与【编辑工具→内存系统】之间，提供**冲突可恢复的直接写入**能力。

```
用户请求 → [Auto-Save 开关] → 开 → 直接写文件系统 + 记录快照
                             → 关 → 标准路径（内存写 → flush）
```

## 10.2 核心实体

### 10.2.1 Snapshot（快照）

- **定义**：文件在某次 auto-save 写入前的完整内容快照。
- **存储位置**：`agent workspace / snapshots / <agent-id> / <filename>.<timestamp>.snapshot`
- **生命周期**：保留最近 N 个快照（默认 5），超量自动裁剪。
- **用途**：当后续操作需要回退或冲突检测时，从快照恢复。

### 10.2.2 AutoSaveState（会话开关）

- **定义**：每个 agent 会话的自动保存启用状态，默认开启。
- **存储**：`MemoryService.setContextItem <key=autoSaveEnabled>`，持久化到 `memory.json`。
- **切换命令**：`/autosave on|off` 或通过系统提示词控制。
- **查询接口**：`isAutoSaveEnabled(): boolean`

## 10.3 流程设计

### 10.3.1 写入流程

```
编辑工具收到 file write 请求
    │
    ├── isAutoSaveEnabled() == false
    │     └→ 标准路径：内存写入 → flush（无快照）
    │
    └── isAutoSaveEnabled() == true
          ├── 1. 创建快照：读取文件当前内容 → 写入 .snapshot 文件
          ├── 2. 直接写入：将新内容写入目标文件
          └── 3. 记录元数据：
                - file path
                - snapshot path
                - timestamp
                - content hash（可选）
```

### 10.3.2 冲突检测与恢复

```
[恢复请求] → 检查快照是否存在
    │
    ├── 快照不存在
    │     └→ 无法恢复，返回错误
    │
    └── 快照存在
          ├── 1. 读取快照内容
          ├── 2. 检测当前文件是否被外部修改（对比 hash）
          ├── 3a. 无冲突 → 覆盖式恢复
          └── 3b. 有冲突 → 报告冲突，由用户决定
```

## 10.4 代码实现状态

| 组件 | 文件 | 状态 |
|------|------|------|
| 快照引擎（创建/读取/裁剪） | `src/shared/snapshot-engine.ts` | ✅ 已实现 |
| 会话状态开关 | `src/shared/auto-save-state.ts` | ✅ 已实现 |
| 编辑工具集成（auto-save 分支） | `src/tools/edit-tool.ts` | ✅ 已实现 |
| 命令行切换（`/autosave on\|off`） | `src/shared/chat-commands.ts` | ✅ 已实现 |
| 冲突检测与恢复 | `src/shared/snapshot-recovery.ts` | ✅ 已实现 |
| 完整设计文档 | `agent-15a2e5cb-6df3-400c-bd1f-72c2d412b431/auto-edit-save-design.md` | ✅ 已归档 |

## 10.5 设计决策与权衡

| 决策 | 选择 | 理由 |
|------|------|------|
| 快照文件格式 | `.snapshot` 独立文件 | 不侵入源文件，清理简单 |
| 快照保留数量 | 5 个 | 平衡存储与回退深度 |
| 默认状态 | 开启 | 多数场景下自动保存更有价值 |
| 恢复策略 | 主动式（用户发起） | 避免自动恢复造成数据丢失 |
| 冲突检测 | 通过 content hash | 轻量，无需 diff 引擎 |

## 10.6 与架构文档其他章节的关系

- **第8章 工具响应压缩**：auto-save 在写入阶段减少内存占用的 flush 频率，间接降低工具响应体积。
- **第4章 上下文管理**：auto-save 的快照机制为上下文截断提供了安全的回退点。
- **第5章 记忆系统**：auto-save 状态存储在 MemoryService 中，与记忆系统共享持久化层。

---

> **上一章**：[第9章 架构优化建议](#9-架构优化建议)
