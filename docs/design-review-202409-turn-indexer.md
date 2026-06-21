# Design Review 2024-09: Three Design Flaws

## Overview

This document records a design review of three related issues found in the Pueblo codebase. All three involve **responsibility misplacement** — code in the wrong layer, validation barring legitimate data, or silent data loss.

---

## Issue 1: TurnIndexer 职责外溢

### 症状

CLI 重启后，已存在 session 的 turn 编号从 2 重新开始计数，导致 `turnId` 与上一轮运行的 `turn-2` ~ `turn-N` 碰撞。`selectRecentContextMessages` 按唯一 turnId 分组取最后 3 组，因此始终显示旧的 (N, N-1, N-2)。

### 根因

`TurnIndexer`（`src/agent/turn-indexer.ts`）的职责是"知道当前 session 的 turn 应从哪个数字开始"。但它把**从 session 持久化数据恢复起始号**的职责推给了调用方：

- CLI（`src/cli/index.ts` line 555-565）：手动调用 `extractMaxTurnNumberFromSession` 提取最大 turn 号再传入
- Agent（`src/agent/agent-runner.ts`或类似）：同样需要自己算

```typescript
// CLI 中的 hack（src/cli/index.ts line 120-131）
function extractMaxTurnNumberFromSession(session: Session): number {
  let maxTurn = 0;
  for (const msg of session.messageHistory ?? []) {
    if (!msg.turnId) continue;
    const match = msg.turnId.match(/-turn-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxTurn) maxTurn = num;
    }
  }
  return maxTurn;
}
```

### 设计方案

**TurnIndexer 自身应接收已有消息并计算起始号：**

```typescript
// src/agent/turn-indexer.ts
constructor(
    private readonly sessionId: string,
    existingMessages?: SessionMessage[],
) {
    this.nextTurnNumber = this.computeStartingTurn(existingMessages);
}

private computeStartingTurn(messages?: SessionMessage[]): number {
    if (!messages || messages.length === 0) return 1;
    // 从已有消息的 turnId 中提取最大编号
    let maxTurn = 0;
    for (const msg of messages) {
        if (!msg.turnId) continue;
        const match = msg.turnId.match(/-turn-(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxTurn) maxTurn = num;
        }
    }
    return maxTurn + 1;
}
```

**移除各调用方的重复/临时逻辑**，如 CLI 中的 `extractMaxTurnNumberFromSession`。

### 影响范围

- `src/agent/turn-indexer.ts` — 修改构造函数
- `src/cli/index.ts` — 移除 `extractMaxTurnNumberFromSession`、修改创建 TurnIndexer 的调用点
- 任何调用 `new TurnIndexer(sessionId, startingTurnNumber)` 的代码

---

## Issue 2: `deserializeMessageHistory` 校验 fallback 丢弃整个单个消息

### 症状

当 `sessionMessageSchema.safeParse(entry)` 失败（如因字段名不匹配、格式错误），`deserializeMessageHistory` 的 fallback 逻辑对非字符串 entry 返回 `[]`，**导致该消息被静默丢弃**（因使用 `flatMap` 调用该函数，`[]` 被展平消失）。

### 根因

`src/sessions/session-repository.ts` line 349-376 `deserializeMessageHistory` 函数：

```typescript
export function deserializeMessageHistory(
  id: string,
  messageJson: string,
  updatedAt: string,
): SessionMessage[] {
  const parsed = fromJson<unknown[]>(serializedHistory);
  // 先尝试整体校验
  if (!Array.isArray(parsed)) return [];
  const result = messageArraySchema.safeParse(parsed);
  if (result.success) return result.data;
  // ❌ fallback: 逐项处理，对非 string 类型丢弃
  return parsed.flatMap((entry: unknown, entryIndex) => {
    if (typeof entry !== 'string') {
      console.warn(`[SessionRepository] ... ignoring`);
      return []; // ← 静默丢弃
    }
    // ... 遗留 string 格式的解析
  });
}
```

### 正确处理方式

fallback 路径应当**跳过单个坏 entry** 而非丢弃整个历史。但更根本的问题是：不应先整体校验再 fallback。正确的设计是：

1. 逐项 safeParse，成功保留、失败 warn+跳过
2. 支持遗留格式兼容（如 `timestamp` → `createdAt` 映射）

### 影响范围

- `src/sessions/session-repository.ts` — 重写 `deserializeMessageHistory`
- 任何依赖该函数返回完整历史的地方（如 session 恢复）

---

## Issue 3: 存储字段名差异 — `timestamp`（遗留数据） vs `createdAt`（当前 schema）

### 症状

旧版代码可能在 `SessionMessage` 中使用了 `timestamp` 字段名。当前 schema（`src/shared/schema.ts` line 44-53）要求 `createdAt`：

```typescript
export const sessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: z.string().datetime(),  // ← 当前 schema
  taskId: z.string().nullable(),
  toolName: z.string().nullable(),
});
```

当前 `session-service.ts` appendMessage（line 129）正确写入 `createdAt`。但数据库中可能遗留使用 `timestamp` 字段的旧数据。当 `deserializeMessageHistory` 用 `sessionMessageSchema.safeParse` 校验这些旧消息时，因字段名不匹配而失败 → fallback 到 per-item 逻辑 → 非 string entry 被 `return []` 丢弃。

### 根因

- **写路径**：当前已正确（`session-service.ts` 写 `createdAt`）
- **读路径**：`sessionMessageSchema` 不兼容 `timestamp` 旧字段
- **无迁移/兼容层**：没有处理遗留数据字段名映射

### 设计方案

在 `deserializeMessageHistory` 中增加旧字段兼容：

```typescript
// 在 per-item fallback 中处理对象类型 entry
if (typeof entry === 'object' && entry !== null) {
  // 兼容旧数据：将 timestamp 映射到 createdAt
  if ('timestamp' in entry && !('createdAt' in entry)) {
    entry.createdAt = entry.timestamp;
  }
  const result = sessionMessageSchema.safeParse(entry);
  if (result.success) return [result.data];
  console.warn(`... skipping invalid entry`);
  return [];
}
```

或者更干净的方案：**准备一个兼容 schema**。

### 影响范围

- `src/sessions/session-repository.ts` — `deserializeMessageHistory` fallback 逻辑

---

## 问题之间的关联

```
TurnIndexer 设计缺陷
    ↓ 调用方（CLI）被迫实现修复逻辑（extractMaxTurnNumberFromSession）
    ↓ 但 TurnIndexer 本身本应处理

deserializeMessageHistory fallback 丢弃消息
    ↓ 让 session 恢复不完整
    ↓ 间接导致 TurnIndexer 计算起始号不准

timestamp vs createdAt 不匹配
    ↓ 触发校验失败
    ↓ deserializeMessageHistory fallback 丢弃消息
    ↓ session 历史不完整
```

三者的共同根源：**职责没有放在正确的位置** + **校验失败时缺乏安全的降级策略**。

---

## 推荐的修复顺序

1. **TurnIndexer** — 职责内聚到自身，对所有调用方透明
2. **timestamp → createdAt 兼容** — 防止旧数据被丢弃
3. **deserializeMessageHistory fallback** — 跳过坏 entry 而非返回 `[]`

修复完成后，还需验证：
- [ ] CLI 重启后 turn 编号正确延续
- [ ] 含旧 `timestamp` 字段的 legacy session 数据能被正常加载
- [ ] 单条消息格式异常不影响其他历史消息
