## 1. 背景与目的

即时贴是桌面端的一个轻量交互窗口。**核心定位：用户在等待 LLM 反馈期间的"并行意图捕获器"**——当前对话正在流式输出时，用户产生的新想法、新任务、小疑问，都可以随时记录并由即时贴按需分发执行，不打断、不阻塞当前会话。

本特性位于 `src/desktop/` 桌面端子系统。

---

## 2. 用户需求澄清（2026-08-18 用户提供）

用户在使用 pueblo 工作时，经常会在**等待 LLM 反馈**时产生新的交互需求，按执行形态可分为三类：

### 2.1 三种等待期交互场景

| 场景 | 用户表述 | 本质 | 期望执行形态 | 上下文需求 |
|------|----------|------|--------------|------------|
| **A. 新 Idea** | 一个新功能或新想法，与当前会话存在一定联系 | 独立探索任务 | **启动一个 agent 并行处理，不影响当前会话** | 与当前会话弱相关；不继承当前 session |
| **B. 并行工作** | 等待优化程序接口时，想写一个测试程序 | 基于当前背景的子任务 | **启动基于当前背景的 sub-agent 执行** | **只需要少量背景信息，不需要当前全部 session** |
| **C. 简单小事** | 对当前 LLM 流式反馈的新名词有些好奇，想检索名词解释 | 一次性轻问答 | **一个"一对一"的网页检索并反馈即可** | 无（不需要会话上下文） |

即时贴就是面向以上痛点或问题的。

### 2.2 投递模式矩阵（即时贴的完整投递目标）

将三场景与既有"下一轮对话"合流，即时贴存在**四种投递模式**，上下文需求从"全量"到"无"呈梯度：

| 模式 | 目标 | 上下文策略 | 执行时机 | 现状 |
|------|------|-----------|----------|------|
| **M1 下一轮对话** | 当前会话（接力） | 全量上下文（当前 session） | 当前对话结束后 | 已实现（`notes:queue-next-turn`，见 4.3） |
| **M2 并行新 agent** | 全新会话（场景 A） | 无/仅 idea 文本 + workspace 元信息 | 立即并行 | 占位（`notes:queue-new-agent`，见 4.4） |
| **M3 并行 sub-agent** | 派生会话（场景 B） | **少量背景摘要**（非全量 session） | 立即并行 | 占位（`notes:queue-subagent`，见 4.4） |
| **M4 轻量检索** | 一次性问答（场景 C） | 无 | 立即 | **无接口（缺口，见 4.8）** |

> 待讨论：M2 与 M3 的边界——"新 Idea"与当前会话"存在一定联系"，而 M3 明确"只需要少量背景信息"，二者差异与背景提取策略见 UC-03/UC-04 与第 8 节。

---

## 3. 用户故事（Story）

既定需求原始表述（对话历史确认）与本次澄清合并后：

| # | Story | 状态 |
|---|-------|------|
| S1 | 全局唤起：用户通过全局快捷键随时唤起即时贴窗口，不打断当前工作流。 | 部分实现（见 4.5） |
| S2 | 快速记录：用户可在此窗口中输入一条文本笔记。 | 已实现（见 4.2） |
| S3 | 队列投递：笔记可标记为"下一轮对话"，在当前对话完成后作为输入自动发送给助手。 | 部分实现（见 4.3） |
| S4 | 会话归属：笔记应能追溯其源自哪个会话（session）与轮次（turn），避免上下文错乱。 | 部分实现（见 4.2/4.3） |
| S5 | 生命周期：笔记应跨应用重启保留，不因进程退出而丢失。 | 笔记已满足；**队列未满足**（见 4.3） |
| **S6** | **并行投递：笔记可启动并行 agent/sub-agent 执行，不影响当前会话（场景 A/B）。** | **占位/缺口**（见 4.4） |
| **S7** | **轻量检索：笔记可触发"一对一"网页检索并直接反馈（场景 C）。** | **无接口**（见 4.8） |

---

## 4. 第一手需求（现状基线）

以下为源码级实读事实（接口类描述），是后续需求讨论与设计变更的对照基线，**不构成需求本身**。

### 4.1 数据模型 — `src/desktop/shared/instant-notes.ts`（174 行）

- `MAX_INSTANT_NOTE_LENGTH = 2000`：单条笔记内容上限。
- `InstantNoteContext`：会话上下文快照，含 `sessionId` / `sessionTitle` / `agentProfileId` / `agentProfileName` / `modelId` / `modelName` / `workspace` / `turnIds`。
- `InstantNoteRecord = InstantNoteContext & { id, content, createdAt, updatedAt }`：完整笔记记录。
- `InstantNoteDraft = Partial<InstantNoteContext> & { content, id? }`：保存/更新入参。
- 持久化：`resolveInstantNotesStoragePath()` 返回 `.pueblo/instant-notes.json`（可用环境变量 `PUEBLO_INSTANT_NOTES_DIR` 覆盖），`writeInstantNotes()` 为 `mkdir recursive + writeFile`。
- 语义函数：`normalizeInstantNoteContent()`（trim / 非空 / ≤2000）、`buildInstantNoteRecord()`（由 runtimeStatus + session 生成记录，`turnIds` 取自 session.messageHistory 的 turnId 去重后最近 20 个）、`readInstantNotes()`（文件缺失/解析失败容错为 `[]`，按 `updatedAt` 降序）、`saveInstantNote()`（`draft.id` 存在→合并更新保留 `createdAt`，否则新建插入头部）、`deleteInstantNote()`。

### 4.2 笔记 CRUD — IPC 层已注册

`src/desktop/main/ipc.ts:484-545` 已注册：

- `notes:list` → 读取全部笔记（持久化文件）。
- `notes:save` → 带 runtimeStatus 与 session 上下文生成记录并保存（新笔记）。
- `notes:update` → 仅接受 `{ id, content }` 做部分更新（**上下文字段不可更新**）。
- `notes:delete` → 删除指定记录。

### 4.3 队列投递（M1）— 现状与缺口

- 队列本体 `queuedNextTurnNotes`（`ipc.ts:125`）：**纯内存数组**，元素 `{ sessionId?, content }`，**无持久化**。违反 S5（重启即丢）。
- flush 函数 `flushQueuedNextTurnNotes()`（`ipc.ts:214-245`）：循环弹出队列项 → 包装为 envelope → `cli.executeInput()`。
- 触发时机：`submit-input` 的 `finally` 中 `activeSubmitControllers.size === 0` 时（`ipc.ts:669-674`）；`notes:queue-next-turn` handler 在无进行中提交时也会立即 flush。
- 语义缺口：
  - `notes:queue-next-turn` 入队后若会话正在执行则等待 flush；但**队列本身不区分"仅入队"与"立即执行"**，行为取决于提交状态，语义未显式契约化。
  - flush 时 `session` 解析：`nextNote.sessionId ?? activeSessionId ?? null`；若 note 携带的 session 已不存在，envelope 仍保留 note 的 `sessionId`（无效 id），执行可能落空或上下文错乱（S4 未完全闭合）。

### 4.4 占位接口（M2/M3）— 未实现真实契约

- `notes:queue-subagent`：返回 `{ queued:false, message:'子agent入口已预留，暂未实现。' }`。
- `notes:queue-new-agent`：返回 `{ queued:false, message:'新agent入口已预留，暂未实现。' }`。
- 渲染层对应按钮 `disabled + title:'预留接口，暂未实现'`（`notes.html:363-373`）。

### 4.5 全局唤起 — 已注册但需确认可用性

- `src/desktop/main/main.ts:262`：`globalShortcut.register('CommandOrControl+Shift+U', () => toggleInstantNotesWindow())`。
- `main.ts:278-279`：`before-quit` 时 `globalShortcut.unregisterAll()` 清理。
- 全仓库 `globalShortcut` 仅此一处集中注册。

### 4.6 窗口 — `src/desktop/main/instant-notes-window.ts`（152 行）

- `openInstantNotesWindow()`：懒创建 BrowserWindow，460×560（min 360×420），`frame:true`、`autoHideMenuBar:true`、`resizable:true`、`skipTaskbar:true`、`alwaysOnTop:true`、`show:false`、`backgroundColor:'#111827'`、`title:'即时贴'`。
- 加载：devServer URL → `did-fail-load` 回退到本地 HTML 产物。
- `toggleInstantNotesWindow()`：懒创建→显示；可见→hide；不可见→show。
- `closed` 事件置空窗口引用。

### 4.7 渲染层 — `src/desktop/renderer/notes.html`（488 行）

- 深色主题 + 全局深色滚动条（L130-150）。
- 结构：textarea 编辑器（maxlength 2000）+ 保存/新建按钮 + 状态区 + 当前会话 meta（3s 轮询 `getRuntimeStatus`）。
- 列表项：`content`、`session-tag`（'Session ' + id 前 8 位）、`turn-tag`（'Turns ' + 前 3 个 turnId）。
- 每项操作：**「下一轮对话执行」**（调用 `notesQueueNextTurn(note)`）、**「启动子agent执行」**（disabled）、**「启动新agent执行」**（disabled）。
- 交互：点击列表项载入编辑器（选中态）；保存时若有选中项走 `notesUpdate(id,{content})`，否则走 `notesSave({content})`。

### 4.8 Preload 契约与缺口 — `src/desktop/preload/index.ts`（117 行）

已暴露：`notesList` / `notesSave` / `notesUpdate` / `notesDelete` / `notesQueueNextTurn` / `notesQueueSubagent` / `notesQueueNewAgent`，另含 `getRuntimeStatus` 等通用桥接。

**缺口（场景 C / M4）**：全仓库无"轻量检索/一对一问答"相关 IPC 或 UI 入口；轻量检索需要新增主进程能力（检索桥接）与 preload 契约。

---

## 5. 需求用例分析

以下用例为**需求草案**，主流程描述"系统应当如何"，验收标准为建议项，随第 8 节讨论逐条确认。

### 5.1 用例总览

| 用例 | 名称 | 对应 Story / 模式 | 现状 |
|------|------|------------------|------|
| UC-01 | 随手记录 | S2 | 已实现 |
| UC-02 | 下一轮对话投递 | S3 / M1 | 部分实现 |
| UC-03 | 并行新 agent（新 Idea） | S6 / M2 | 占位 |
| UC-04 | 并行 sub-agent（并行工作） | S6 / M3 | 占位 |
| UC-05 | 轻量检索（简单小事） | S7 / M4 | **无接口** |
| UC-06 | 追溯与生命周期 | S4 × S5 | 部分实现 |

### 5.2 UC-01 随手记录

- **触发**：用户随时唤起即时贴，输入文本并保存。
- **前置**：应用运行中。
- **主流程**：
  1. 用户按全局快捷键唤起即时贴窗口（S1）。
  2. 输入文本（≤2000 字符）。
  3. 点击保存；系统注入当前会话上下文快照（session/turn/agent/model/workspace）。
  4. 记录持久化到 `.pueblo/instant-notes.json`，列表按 `updatedAt` 降序展示。
- **边界**：空内容拒绝（normalize 失败提示）；超长被 maxlength 截断。
- **验收（建议）**：重启应用后记录仍在；列表项展示来源 session/turn 标签。

### 5.3 UC-02 下一轮对话投递（M1）

- **触发**：当前 LLM 回复进行中或刚结束，用户产生补充意图，希望"当前对话结束后自动接着做"。
- **前置**：存在活动会话；笔记已保存或处于草稿。
- **主流程**：
  1. 用户输入补充内容，点击「下一轮对话执行」。
  2. 系统入队 `{ sessionId, content }`。
  3. 当前对话提交结束后（无进行中 submit）自动 flush，包装为 envelope 注入会话执行。
- **边界**：
  - 会话正在执行 → 等待 flush；无进行中提交 → 立即执行（现状隐式行为，需显式契约化，P4）。
  - 应用重启 → 队列丢失（P1）。
  - note 携带的会话已删除 → 无效 sessionId 静默执行（P2）。
- **验收（建议）**：投递后目标会话收到该内容；执行结果可追溯来源笔记。

### 5.4 UC-03 并行新 agent（新 Idea，M2）

- **触发**：等待 LLM 回复时，用户想到一个新功能/新想法（与当前会话**弱相关**，如"做一个统计代码行数的 CLI 工具"），希望**立即并行探索，不影响当前会话**。
- **前置**：无特殊前置（不依赖当前会话上下文）；有明确 idea 文本。
- **主流程**：
  1. 用户输入 idea 文本，点击「启动新 agent 执行」。
  2. 系统创建**全新 agent 会话**：不继承当前 session 上下文，仅携带 idea 文本 + workspace 等元信息。
  3. 新 agent 并行执行；当前会话 UI 与执行状态不受影响。
  4. 结果保存在新会话中，用户可随时查看。
- **边界**：
  - idea 文本为空/超长 → 拒绝或截断。
  - 并行 agent 数量上限（资源约束）。
  - **完成通知**：不打断当前会话的前提下如何告知用户"新 agent 已完成"（角标/托盘/通知？）。
  - 新会话的 agent 选择：默认 profile 还是允许用户选择。
- **验收（建议）**：新会话与当前会话互不干扰；idea 文本成为新会话首条输入；完成有通知、可追溯。

### 5.5 UC-04 并行 sub-agent（并行工作，M3）

- **触发**：等待"优化程序接口"类回复时，用户想"为这个接口写一个测试程序"——子任务与当前会话**强相关**，但 sub-agent **只需要少量背景信息**（如接口文件路径、函数签名），**不需要当前全部 session**。
- **前置**：存在当前会话；用户有明确子任务。
- **主流程**：
  1. 用户输入子任务文本（如"为 fetchNotes 写单元测试"），点击「启动子 agent 执行」。
  2. 系统从当前会话提取**少量背景摘要**（候选：会话标题、最近 N 轮消息、workspace/文件线索），而非全量 messageHistory。
  3. 启动 sub-agent，携带背景摘要 + 子任务文本，并行执行。
  4. 结果归属到可追溯的派生会话；当前会话不受影响。
- **边界**：
  - **背景提取策略**："少量"如何量化（最近几轮？当前工作文件列表？），需讨论（第 8 节）。
  - 结果去向：独立查看，还是允许合并回当前会话？
  - 资源/权限隔离（与当前会话并行读写同一 workspace 的冲突）。
- **验收（建议）**：sub-agent 在未携带全量 session 的前提下完成任务；背景信息恰好足够且不冗余。

### 5.6 UC-05 轻量检索（简单小事，M4）

- **触发**：用户对当前 LLM 流式反馈中的新名词好奇（如"什么是 RAG？"），想快速检索解释——不愿开完整 agent、不愿打断当前会话。
- **前置**：无（不需要当前会话上下文）。
- **主流程**：
  1. 用户输入检索问题（如"解释 RAG"），点击「轻量检索」（**当前无此入口，为缺口**）。
  2. 系统发起一次性网页检索（一对一问答）。
  3. 结果直接反馈给用户（即时贴内展示），**不创建会话**。
- **边界**：
  - 检索无结果/超时 → 明确反馈。
  - 用户想基于结果继续追问 → 是否升级为 UC-04 sub-agent？
- **验收（建议）**：一次交互一个答案；秒级响应；不污染当前会话。

### 5.7 UC-06 追溯与生命周期

- **触发**：用户回顾笔记/投递结果，需要知道"这条笔记来自哪个会话哪一轮、投递到了哪里"。
- **前置**：存在历史笔记/投递记录。
- **主流程**：列表项展示来源 session + turn 标签 → 点击查看/跳转来源会话。
- **边界**：来源会话已删除时的展示（占位 vs 失效标识）。
- **验收（建议）**：每条记录可追溯到来源会话/轮次；会话删除后有明确标识而非静默失效。

---

## 6. 痛点提炼

从"用户澄清 → 现状基线"对照，真正的痛点是：

- **P1 队列无持久化（S3×S5）**：`queuedNextTurnNotes` 是纯内存数组，跨应用重启即丢。用户记录一条重要接力笔记后重启应用，投递目标丢失——最严重的信任破坏。
- **P2 上下文追溯不闭合（S4）**：flush 时 note 携带的 session 已不存在时，envelope 仍携带无效 `sessionId` 静默执行，上下文错乱；队列项 `{sessionId?, content}` 不记录轮次（turn），"从哪一轮产生"不可追溯。
- **P3 并行投递悬空（S6）**：用户澄清的场景 A/B（并行 agent / sub-agent）在接口与 UI 上仅剩占位——**核心价值能力未落地**，按钮 disabled、handler 返回占位文本。
- **P4 投递语义隐式**：入队与立即执行不区分，行为由 `activeSubmitControllers.size` 隐式决定，缺少显式契约（用户无法感知"何时会被执行"）。
- **P5 上下文只读快照**：`notes:update` 仅更新 content，一旦记录生成，其 session/turn 上下文不可修正；会话已改名/删除后快照失真。
- **P6 轻量检索无落点（S7）**：用户澄清的场景 C（"一对一"网页检索）在现有接口与 UI 中**无任何对应入口**——即时贴目前只能"记下来以后做"或"投递到会话"，无法"立即查一下"。

---

## 7. 目标方向（待讨论细化）

以下为痛点驱动的目标草案，**具体需求在后续讨论中逐条确认后回填**：

- G1 队列持久化：队列与笔记同生命周期，跨重启保留（P1）。
- G2 投递契约显式化：区分"仅入队"与"立即执行"，并向用户反馈执行时机与结果（P4）。
- G3 上下文可追溯：队列项携带来源 session/turn；无效 session 有明确降级策略而非静默错乱（P2）。
- G4 并行投递落地：按用户澄清明确 M2/M3 语义——`queue-new-agent`=全新会话（仅 idea 文本）、`queue-subagent`=少量背景摘要的派生会话；实现真实契约，替代占位（P3）。
- G5 上下文快照可维护：允许修正/刷新记录上下文（P5）。
- G6 轻量检索通道：为场景 C 提供最小化"一对一网页检索 + 直接反馈"能力，不创建会话、不打断当前会话（P6）。

> 需求细化（功能/非功能/边界/验收标准）将在与用户的讨论中逐项确定后追加到本文档第 8 节。

---

## 8. 需求细化（讨论区）

_（预留：与用户讨论后逐条补充，含验收标准。当前已挂起的待决问题：）_

- M2 与 M3 的边界：新 Idea 是否需要当前会话少量背景（会话标题/主题）？
- UC-04 背景提取策略："少量背景信息"如何量化（最近 N 轮？当前文件列表？）？
- UC-03/04 完成通知机制：不打断当前会话的告知方式。
- UC-03/04 结果去向：独立派生会话查看 vs 可合并回当前会话。
- UC-05 轻量检索的能力来源：复用现有 agent 检索能力 vs 独立检索桥接。
- UC-05 追问升级：检索结果基础上的继续追问是否升级为 sub-agent。