# Agent Solo Mode

## Goal

定义一种新的 agent 使用模式：

- 每个 agent 类型只保留一个默认实例。
- 以 `code-master` 为例，这个长期实例称为 `A`。
- 用户每次打开 Pueblo 并选择 `code-master` 时，默认都使用 `A`。
- 用户在 `A` 下可以连续进行多个 session。
- 默认情况下，当前 session 会继承上一次 session 作为背景继续工作。
- 当用户执行 `/new` 时，只创建一个新的空 session，但仍然使用同一个 `A`。
- 每个 session 中的聊天记录、工具结果和任务输出都会继续保存为 memory。

这个模式的核心是：

`session` 与 `agent instance` 解耦，不再把“新 session”误解为“新 agent instance”。

## Current Design Assessment

当前设计已经部分接近目标，但还没有真正实现“每个 profile 一个长期实例”。

### 已经符合目标的部分

1. `session` 已经有 `agentInstanceId` 字段。

   见 `src/shared/schema.ts` 和 `src/sessions/session-model.ts`。

   这意味着当前数据模型已经允许“多个 session 绑定到同一个 agent instance”。

2. `/new` 当前就会把“当前活动 agent instance”挂到新 session 上。

   见 `src/commands/session-list-command.ts` 中的 `createNewSessionCommand(...)`。

   这点和目标是一致的：新 session 不必强制创建新 agent。

3. 上下文恢复已经主要以 `session` 为中心。

   `ContextResolver` 会从当前 `session` 读取 `messageHistory`、selected prompt、selected memory，并结合 Pepe 结果构造本轮上下文。

   这意味着“默认继承上一次 session 作为背景”当前已经成立，前提是程序继续使用当前 session。

### 与目标冲突的部分

当前系统在“切换到某种 agent 类型”时，会创建一个新的 agent instance，而不是复用该类型的唯一实例。

关键位置在 `src/cli/index.ts`：

- `startAgentSession(profileId)`
  - 当前实现：总是 `createAgentInstance(profileId, process.cwd())`
- `ensureAgentInstance()`
  - 当前实现：如果当前没有活动实例，就再创建一个新的实例

这会导致：

- 同一个 profile 可能出现多个 instance。
- `code-master` 今天一次、明天一次、切换一次，就可能生成多份逻辑上重复的实例。
- session 虽然可以复用旧实例，但“选择 agent profile”这个动作本身仍然会制造新的实例。

所以，当前设计不是“每种 profile 一个固定实例”，而是“按需要创建新的实例，并让 session 绑定其中一个”。

## Requirement Fit

你的需求可以落在当前架构之上，而且不需要推翻 session / memory / Pepe 这条主链。

需要真正改变的不是 task、memory 或 prompt，而是：

- agent instance 的生命周期定义
- profile 选择时的实例获取策略
- 默认 session 恢复和 `/new` 的语义边界

更准确地说，系统要从：

- “active agent instance 是一个临时执行体”

切换到：

- “active agent instance 是 profile 的持久代表”

## Proposed Model

### 1. One Default Instance Per Profile

对于每个 profile，只维护一个默认实例。

例如：

- `code-master` -> `A`
- `architect` -> `B`
- `debugger` -> `C`

这些实例是长期存在的，除非用户显式删除或系统迁移重建。

`A`、`B`、`C` 不再随着 `/new` 或应用重启重复生成。

### 2. Session Is the Conversation Container

session 继续作为会话与上下文容器：

- 保存 chat history
- 保存 selected prompts / memories
- 驱动 Pepe 结果选择
- 作为默认背景恢复点

agent instance 只负责：

- 表示“当前使用哪种 agent profile”
- 为 Pepe、task、memory lineage 提供稳定的 `agentInstanceId`

### 3. Profile Selection Means Reuse, Not Recreate

当用户在桌面端选择某个 agent profile，例如 `code-master`：

- 系统先查找该 profile 的默认实例是否存在
- 若存在，则直接激活这个实例 `A`
- 若不存在，则首次创建 `A`

也就是说：

- 第一次选 `code-master` -> 创建 `A`
- 以后再选 `code-master` -> 一直复用 `A`

### 4. App Launch Behavior

用户每次打开 Pueblo 并选择某个 agent 类型时：

- 默认将该 profile 的长期实例设为当前 agent
- 默认继续使用上一次 active session 作为背景

如果这个 active session 本身就绑定到该实例，那么无需创建新 session。

### 5. `/new` Behavior

`/new` 的行为应保持为：

- 创建新的空 session
- 不复制上一个 session 的 `messageHistory`
- 不自动继承上个 session 的 prompt / memory selection，除非将来显式设计这个能力
- 仍然绑定当前 agent instance `A`

也就是说：

- “新任务组” = 新 session
- “新 agent” = 不是 `/new` 的含义

## Recommended Implementation

### Phase 1: Introduce Profile-Scoped Default Instance Resolution

在 `AgentInstanceService` 中新增一个面向 profile 的获取接口，例如：

- `getDefaultInstanceForProfile(profileId)`
- `getOrCreateDefaultInstanceForProfile(profileId, workspaceRoot)`

实现思路：

- repository 层增加按 `profileId` 查询实例的能力
- 先返回当前 profile 下未终止的默认实例
- 如果没有，再创建一个新的实例

### Phase 2: Stop Creating New Instance On Profile Switch

修改 `src/cli/index.ts` 中：

- `startAgentSession(profileId)`
- `ensureAgentInstance()`

把当前逻辑：

- 每次都 `createAgentInstance(...)`

改成：

- `getOrCreateDefaultInstanceForProfile(...)`

这样 profile 切换时就不会再制造重复实例。

### Phase 3: Keep `/new` Session-Only

当前 `/new` 已经接近目标，不需要推翻。

只需要确认并固化其语义：

- `/new` 只创建新 session
- session 绑定当前活动 instance
- 不创建新的 agent instance

这可以通过补测试和文档来稳定约束。

### Phase 4: Clarify “Current Agent” Resolution On Startup

当前桌面启动时会恢复 current session，并从 session 推导 active agent instance。

在 solo 模式下，建议明确顺序：

1. 恢复当前 session
2. 如果 session 已绑定 `agentInstanceId`，直接使用它
3. 如果没有绑定，但当前 profile 已知，则取该 profile 的默认实例
4. 如果 profile 默认实例也不存在，则首次创建

这样能同时兼容：

- 旧数据
- 新数据
- 没有 session 的首次启动

### Phase 5: Preserve Existing Memory Model

当前 memory 模型不必大改。

因为现在已经有：

- session memory / turn memory
- Pepe result set with `agentInstanceId`
- session -> selected memories

solo 模式下，最大的收益其实是：

- 同一个 profile 的长期 agent instance 会让 Pepe 和后续分析更容易形成稳定 lineage

## Suggested Data Changes

### Minimal Change Option

不修改 schema，只改 service 行为。

做法：

- 继续使用现有 `agent_instances` 表
- 按 `profileId + status != terminated` 选出默认实例
- 约定“同 profile 的第一活跃实例即默认实例”

优点：

- 改动最小
- 不需要 migration

缺点：

- 默认实例是隐式规则，不够明确

### Preferred Option

为 `agent_instances` 增加显式标识，例如：

- `isDefaultForProfile`

或者直接在 profile 级索引里记录：

- `profileId -> defaultAgentInstanceId`

优点：

- 语义清晰
- 易于调试和迁移
- 后续如果支持“重置 A / 重建 A”也更容易

建议优先采用这个方案。

## Backward Compatibility

历史数据中可能已经有多个 `code-master` instance。

迁移建议：

1. 对每个 `profileId` 找出一个保留实例，优先选择：
   - 当前 active session 正在引用的实例
   - 否则最近更新的实例
2. 将其标为默认实例
3. 其他旧实例保留，但不再自动选用
4. 新逻辑只复用默认实例，不再继续扩增重复实例

这样历史 session 不会丢，旧 session 仍能引用旧实例。

## Risks

### 1. “Current Session” 与 “Current Agent” 的优先级

如果当前 session 绑定的是旧实例，但用户又切换 profile，必须定义清楚：

- 是优先沿用 session 绑定实例
- 还是优先切换到 profile 默认实例并新建/切换 session

建议：

- 用户显式切换 profile 时，以 profile 默认实例为准。
- 普通启动恢复时，以当前 session 为准。

### 2. Pepe Working Directory Pattern

当前 Pepe 配置包含：

- `workingDirectoryPattern: agent-{agentInstanceId}`

solo 模式会让这个目录更稳定，这是优点。
但也意味着：

- 同 profile 的多轮 session 都会复用同一 agent 工作目录语义

需要确认这是否正是预期。

### 3. UI 文案仍然叫 “Start Agent Session”

当前桌面 IPC 和 renderer 中的命名，例如：

- `startAgentSession(profileId)`

在 solo 模式下其实更准确的含义是：

- “activate profile default agent and enter its current session context”

实现初期可以先不改接口名，但文档上应说明这个语义已经变化。

## Recommended Delivery Order

1. 为 `AgentInstanceService` 增加按 profile 获取默认实例的能力。
2. 将 `startAgentSession()` 与 `ensureAgentInstance()` 改为复用默认实例。
3. 补测试，确认 `/new` 不再创建新 instance。
4. 增加迁移/兼容逻辑，处理历史上已存在的多个重复实例。
5. 最后再决定是否增加显式 schema 字段标记默认实例。

## Summary

这项需求和当前架构是兼容的，且改造点相对集中。

当前系统最大的问题不是 session 模型，而是：

- profile 选择时仍然在反复创建 agent instance。

只要把这一点改成“每个 profile 复用唯一默认实例”，你想要的行为就基本成立：

- `code-master` 永远对应长期实例 `A`
- 每次打开 app 默认继续上次 session
- `/new` 只开新 session，不新建 agent
- 所有 chat 继续沉淀为 memory

所以结论是：

- 需求合理
- 当前架构可以承接
- 建议按“profile 默认实例化 + session 继续为上下文容器”的方向实施