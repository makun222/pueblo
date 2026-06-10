Now I have a complete picture. Let me provide my evaluation.

---

## 对三个措施的有效性和可行性评估

### 措施 1：提示词重排（固定提示词在前，记忆在后）

**结论：可行，但效果有限（边际改进）。**

当前 `buildTaskMessages` 中的顺序已经是：

```
1. systemMessage         ← 固定提示词（role/goal/constraints/style）
2. selectedPromptsMessage ← 检索到的上下文提示词
3. activeTurnStepContext  ← 本轮 step trace
4. recentConversationMessage / sessionSummaryMessage / workflow / attachments
5. resultItems
6. user message (goal)
```

固定提示词已经在最前面。你遇到"失忆"不是因为顺序问题，而是 `recentConversationMessage` 的**内容质量**太差——6条 raw tool-call 结果占据了那段空间，即使把它们挪到最后，它们依然是垃圾内容。**重排不解决根本问题。**

---

### 措施 2：用最近几个 turn 的总结替代 raw message —— **这是关键突破口**

**结论：极度有效且可行。这是三个措施中最重要、最值得做的。**

**当前问题根因：**

```typescript
// context-resolver.ts:870-901
const recentMessages = session?.messageHistory?.slice(-RECENT_CONTEXT_MESSAGE_LIMIT) ?? [];
```

这 6 条消息是 `messageHistory` 中**按时间顺序的最后 6 条**，没有任何 `turnId` 感知。如果最近一个 turn 有 30 个 step，最后 6 条大概率是：
- 3 条 tool-result（几 KB 的 JSON/file content）
- 2 条 assistant 的工具调用
- 1 条 system（可能是压缩摘要）

**实际效果：** 一个 30-step 的 LLM 密集型 turn 执行完后，除了那个 turn 的最后 6 步碎片，前面所有 turn 的上下文全部从 `recentConversationMessage` 中消失。这就是"会话内遗忘"的直接机制。

**你的方案利用了什么？**

`SessionMessage` 已经有 `turnId`（格式 `<sessionId>-turn-<number>`，见 `schema.ts:52`）。利用它按 turn 分组：

```
messageHistory (100条)
  → group by turnId
  → 最后 6 个 turn 各组：
      Turn 8: 30 steps → 1 条 summary（首次用户问题 + 关键产出）
      Turn 7: 5 steps  → 1 条 summary
      Turn 6: 15 steps → 1 条 summary
      ...
  → recentConversationMessage: 6 条 turn summary（每条约 1-3K chars）
```

**相比 current 的变化：**

| 维度 | 现状（raw message slice） | 方案 2（turn summary） |
|------|--------------------------|----------------------|
| 跨度 | 最后 6 条消息（可能 < 1 个 turn） | 最后 6 个 turn（可跨 30-50 步） |
| 内容 | tool-result JSON、工具调用 | 用户意图 + 完成结果摘要 |
| 噪声 | 极高（无意义的中间结果） | 极低（只保留关键决策点） |
| 30-step turn 后 | 只有该 turn 的后 6 步 | 该 turn 1 条 summary + 前 5 个 turn 的总结合计 |

**可行性细节：**

1. **分组依据**：`messageHistory[i].turnId` 已存在，可直接 `groupBy`。
2. **单 turn summary 生成**：需要从该 turn 的 messages 中提取关键信息。做法：
   - 保留该 turn 中所有 `role='user'` 的消息原文（特别是第一条，即触发该 turn 的用户问题）
   - 保留 `role='assistant'` 中非 tool-call 的文本输出
   - 跳过所有 `role='tool'` 的中间结果
   - 限制每 turn 约 1-2K chars
3. **代码改动范围**：仅 `selectRecentContextMessages`（~30 行），外加一个新的 `buildTurnSummary(msgs: SessionMessage[])` 工具函数。

**这是解决会话内遗忘的最小且最高杠杆的代码改动。强烈建议优先做这个。**

---

### 措施 3：Active turn step context 按类型区分

**结论：可行，效果中等。是对措施 2 的合理补充。**

**当前行为：**

`summarizeTaskStepTrace`（`result.ts:200+`）按 `stepNumber` 分组，把每个 step 中所有 message 的 content 拼接并 chunk，生成 `TaskStepTraceSummary[]`。类型信息（system/user/assistant/tool）被丢失，所有内容混在一起。

**你的方案：**

| 消息类型 | 处理方式 | 原因 |
|---------|---------|------|
| system | 去重后全文保留 | 角色/目标/约束指令，每步都相似但可能有差异 |
| user | 去重后全文保留 | 用户问题，核心驱动信息 |
| assistant | 去重后全文保留 | LLM 思考/决策文本 |
| tool | 只保留最新 1 步 | 中间 tool-result 对"理解本轮做了什么"无增量价值 |

**有效性分析：**

- **正效应**：tool-result 通常是最大的噪声源（上 KB 的文件内容、JSON）。过滤后 `activeTurnStepContext` 显著缩短，给跨 turn 记忆留出更多 token 预算。
- **风险**：如果某个 tool-result 包含了 LLM 需要引用的关键数据（比如代码分析结果中发现了某个 bug），仅保留最新 1 步可能丢失该信息。但这类信息应通过措施 2 的 turn summary 来传递，而非在 active step context 中逐 step 追踪。
- **可行性**：`TaskStepTrace` 中每条 entry 已有 type 信息，只需在 `summarizeTaskStepTrace` 或其调用处加类型过滤。

---

## 综合建议

这三个措施构成了一条清晰的分层修复路径：

```
措施 2（turn-level summary）     ← 第一优先级，直接杀死会话内遗忘
措施 3（type-filtered step）    ← 第二优先级，清除 step context 中的 tool 噪声
措施 1（prompt reordering）     ← 第三优先级，边际优化，如果前两个做完后仍有排序问题再做
```

**措施 2 单点改动即可让你从"30-step turn 后完全失忆"恢复到"最近 6 个 turn 均保留操作摘要"。** 这是当前代码中最值得修改的 30 行。