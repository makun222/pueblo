# 即时贴（InstantNote）设计文档 —— 现状（As-Is）

> 状态：现状基线 v0.1。本文档**仅描述当前代码实现**（As-Is），不含目标设计（To-Be）。
> 目标设计在需求讨论定稿后以独立章节或新文档补充。
> 事实来源：全部条目来自本轮源码实读（`src/desktop/`），行号为实读时点。

---

## 1. 架构概览（现状）

```
┌──────────────────────────┐     ┌─────────────────────────────────────┐
│ notes.html (renderer)    │     │ main 进程                           │
│  - 列表/编辑器/队列按钮    │     │  main.ts: 全局快捷键注册             │
│  - 3s 轮询 runtimeStatus  │     │  instant-notes-window.ts: 窗口      │
└──────────┬───────────────┘     │  ipc.ts: handlers + 队列 + flush    │
           │ preload/index.ts    └──────────────┬──────────────────────┘
           │ 7 个 notes* 通道                     │
           ▼                                     ▼
   window.nativeApi.notesXxx ──────► ipcMain.handle ──► shared/instant-notes.ts
                                                      （数据模型 + JSON 持久化）
```

- 契约唯一真源：`src/desktop/shared/instant-notes.ts`（主/渲染进程共用）。
- 持久化介质：`.pueblo/instant-notes.json`（JSON 文件，非 DB）。
- 队列介质：**内存数组**（无持久化）。

---

## 2. 数据模型（现状）

来源：`src/desktop/shared/instant-notes.ts`（174 行）

### 2.1 类型

```ts
const MAX_INSTANT_NOTE_LENGTH = 2000;              // 内容上限

interface InstantNoteContext {                      // 会话上下文快照
  sessionId: string;
  sessionTitle: string;
  agentProfileId: string;
  agentProfileName: string;
  modelId: string;
  modelName: string;
  workspace: string;
  turnIds: string[];                                // 来源轮次（≤20，去重）
}

interface InstantNoteRecord extends InstantNoteContext {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

type InstantNoteDraft = Partial<InstantNoteContext> & {
  content: string;
  id?: string;                                      // 有 id=更新，无 id=新建
};
```

### 2.2 存储路径解析

- 默认：`<userData>/.pueblo/instant-notes.json`（`resolveInstantNotesStoragePath()`）。
- 可覆盖：环境变量 `PUEBLO_INSTANT_NOTES_DIR` 指向的目录。

### 2.3 关键函数语义（现状）

| 函数 | 行为 |
|------|------|
| `normalizeInstantNoteContent` | trim；空内容拒绝；超 2000 截断或拒绝 |
| `buildInstantNoteRecord` | 由 runtimeStatus + 当前 session 生成记录；`turnIds` 取 session.messageHistory 的 turnId 去重后**最近 20 个** |
| `readInstantNotes` | 读 JSON；文件缺失/解析失败容错为 `[]`；逐条 `normalizeStoredInstantNote`；按 `updatedAt` 降序 |
| `writeInstantNotes` | `mkdir recursive` + `writeFile` |
| `saveInstantNote` | `draft.id` 存在→合并更新（保留 `createdAt`）；否则新建插入数组头部 |
| `deleteInstantNote` | 按 id 过滤并写回 |

---

## 3. IPC 契约（现状）

来源：`src/desktop/main/ipc.ts`

### 3.1 已实现 handlers（L484-545）

| Channel | 入参 | 行为 | 备注 |
|---------|------|------|------|
| `notes:list` | — | 返回全部笔记（持久化读取） | 降序 |
| `notes:save` | `InstantNoteDraft` | 注入 runtimeStatus + session 上下文，`buildInstantNoteRecord` 后保存 | 新建 |
| `notes:update` | `{ id, content }` | 仅更新 content | **上下文字段不可更新** |
| `notes:delete` | `{ id }` | 删除并写回 | — |
| `notes:queue-next-turn` | note（含 sessionId/content） | push 入队；若 `activeSubmitControllers.size === 0` 立即 flush | 返回 `{ queued:true, message:'已加入下一轮对话队列' }` |
| `notes:queue-subagent` | — | **占位**：返回 `{ queued:false, message:'子agent入口已预留，暂未实现。' }` | 未实现 |
| `notes:queue-new-agent` | — | **占位**：返回 `{ queued:false, message:'新agent入口已预留，暂未实现。' }` | 未实现 |

### 3.2 Preload 暴露（`src/desktop/preload/index.ts`，117 行）

`notesList` / `notesSave` / `notesUpdate` / `notesDelete` / `notesQueueNextTurn` / `notesQueueSubagent` / `notesQueueNewAgent` + 通用 `getRuntimeStatus` 等。

---

## 4. 队列与投递（现状）

来源：`src/desktop/main/ipc.ts`

### 4.1 队列本体（L125）

```ts
const queuedNextTurnNotes: Array<{ sessionId?: string; content: string }> = [];
```

- **纯内存**，无持久化，重启即丢。
- 元素仅含 `sessionId` 与 `content`，**不记录来源 turn、不记录入队时间**。

### 4.2 flush 流程（L214-245 `flushQueuedNextTurnNotes`）

```
while (queuedNextTurnNotes.length > 0) {
  nextNote = shift()                          // FIFO
  session = nextNote.sessionId ? cli.getSession(nextNote.sessionId)
           : (activeSessionId ? cli.getSession(activeSessionId) : null)
  envelope = {
    sessionId: nextNote.sessionId ?? activeSessionId ?? null,
    requestId: session?.messageHistory 有 turnId
               ? `instant-note-${lastTurnId}-${rand}`   // 伪关联轮次
               : `instant-note-${rand}`,
    content: nextNote.content,
    ...其他 envelope 字段
  }
  cli.executeInput(envelope)
}
```

### 4.3 触发时机

1. `submit-input` 的 `finally`（L669-674）：`activeSubmitControllers.size === 0` 时调用 flush。
2. `notes:queue-next-turn` handler：当前无进行中提交时立即 flush。

### 4.4 现状缺口（As-Is 事实）

- 队列项携带的 session 已不存在时，`session` 解析为 null，但 envelope 仍带原 `sessionId`（可能无效）→ 执行落空/上下文错乱。
- `requestId` 的 `instant-note-` 前缀仅伪关联"最后轮次"，非队列项真实来源轮次。
- "仅入队"与"立即执行"无显式契约，行为由 `activeSubmitControllers.size` 隐式决定。

---

## 5. 窗口与唤起（现状）

来源：`src/desktop/main/instant-notes-window.ts`（152 行）、`src/desktop/main/main.ts`

### 5.1 窗口（L55-127）

| 项 | 现状值 |
|----|--------|
| 尺寸 | 460×560（min 360×420，可 resize） |
| frame / autoHideMenuBar | `frame:true`，`autoHideMenuBar:true` |
| 置顶 | `alwaysOnTop:true` |
| 任务栏 | `skipTaskbar:true` |
| 初始显示 | `show:false`（懒显示） |
| 背景色 | `#111827`（深色） |
| 标题 | '即时贴' |
| 加载 | devServer URL → `did-fail-load` 回退本地 HTML 产物 |

### 5.2 toggle（L129-140）

- 未创建→懒创建并显示；已创建可见→hide；不可见→show。
- `closed` 事件置空引用（下次重建）。

### 5.3 全局快捷键（`main.ts:262`）

- 注册：`CommandOrControl+Shift+U` → `toggleInstantNotesWindow()`。
- 清理：`before-quit`（L278-279）→ `globalShortcut.unregisterAll()`。
- 全仓库 `globalShortcut` 仅此一处（无分散注册）。

---

## 6. 渲染层（现状）

来源：`src/desktop/renderer/notes.html`（488 行）

### 6.1 结构

- 深色主题；全局深色滚动条（L130-150 `::-webkit-scrollbar` / `scrollbar-color`）。
- 编辑器区：textarea（maxlength 2000）+ 保存/新建按钮 + 状态区 + 当前会话 meta。
- 列表区：`note-item`，展示 `content`、`session-tag`（'Session ' + id 前 8 位）、`turn-tag`（'Turns ' + 前 3 个 turnId）。
- 每项操作按钮：
  - 「下一轮对话执行」→ `notesQueueNextTurn(note)`（**可用**）
  - 「启动子agent执行」→ disabled（title '预留接口，暂未实现'）
  - 「启动新agent执行」→ disabled（title '预留接口，暂未实现'）

### 6.2 交互逻辑

- 点击列表项→载入编辑器并高亮选中。
- 保存：有选中项 → `notesUpdate(id, { content })`；否则 → `notesSave({ content })`。
- 每 3s 轮询 `getRuntimeStatus` 刷新会话 meta。

---

## 7. 现状 → Story 覆盖矩阵

| Story | 覆盖状态 | 现状证据 / 缺口 |
|-------|----------|-----------------|
| S1 全局唤起 | ✅ 已实现 | `main.ts:262` 注册 Ctrl/Cmd+Shift+U |
| S2 快速记录 | ✅ 已实现 | notes.html 编辑器 + notes:save |
| S3 队列投递 | ⚠️ 部分 | 入队/flush 已通；**队列无持久化**（S5 交叉） |
| S4 会话归属 | ⚠️ 部分 | 笔记快照含 sessionId/turnIds；**队列项无 turn、无效 session 静默错乱** |
| S5 生命周期 | ⚠️ 部分 | 笔记 JSON 持久化 ✅；**队列内存态 ❌** |

---

## 8. 附注（As-Is 记录）

- `design/` 目录下未发现即时贴遗留文档（上一轮在 `design/instant-notes/README.md` 的写入未落盘），本特性文档自 `.spec/InstantNote/` 起正式登记。
- 本文档与 `REQUIREMENTS.md` 配套；`REQUIREMENTS.md` 承载 story/痛点/目标，本文档只承载现状事实。
