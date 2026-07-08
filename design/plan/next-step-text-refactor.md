# next_step_action 优化实施方案

> ✅ 已迁移 — 目标位置: `design/plan/next-step-text-refactor.md`

## 背景与根因

- `task.outputSummary` 是 task-runner 构造的 **enriched JSON 包装层**（`JSON.stringify(enrichedOutput)`），其中 `outputSummary` 字段才是 LLM 的自由文本回复。
- 旧设计要求 `next_step_actions` 出现在 enriched 包装层**顶层**，但 LLM 只能控制内层自由文本 `outputSummary`，无法向顶层注入字段；`JSON.parse(outputSummary)` 解析包装层永远成功 → 永远找不到 `next_step_actions` → markdown 兜底也永不触发 → **按钮出现次数为零**。
- 优化目标：让 LLM 只输出一段自由文本"下一步建议"，前后端从中解析按钮；解析失败即优雅退出（无按钮、不报错）；顺便把输入框做成可变高度。

## 已确认的设计取舍

- 段落标记：**`## 下一步建议`**（解析器同时容忍 `### 下一步建议`）。
- 按钮点击发送 **"具体信息"**（冒号后内容）；按钮 label = 冒号前的"动作"（≤30 字符）。
- 桌面端点击：**填入输入框 + 聚焦 + 光标置末 + "按 Enter 发送"提示**（沿用上一轮交互，不自动提交）。
- 输入框：**改用 `<textarea rows=1>` 自动增高**，超长自动换行，封顶后滚动。

## LLM 输出格式约定

LLM 在自由文本 `outputSummary` 末尾输出（无后续动作则整段省略）：

```
...正常总结正文...

## 下一步建议
- 修复解析器: src/shared/result.ts 收紧 action 解析逻辑
- 添加 CLI 菜单: src/cli/index.ts 添加编号下一步选择
```

每行规则：
- 以 `- ` / `* ` / `1. ` 开头（去前缀）。
- 含且仅以**第一个冒号**切分：前段 = label（动作），后段 = prompt（具体信息）。
- label ≤30 字符且非空；prompt 非空。
- 超过 4 条只取前 4；按 prompt 去重。

## 改动点（按文件）

### 1. `src/shared/result.ts` —— 解析逻辑重构（核心）

新增两个纯函数：

- `extractNextStepSuggestionsFromText(text: string): NextStepActionPayload[] | undefined`
  - 用正则定位 `^#{2,3}\\s+下一步建议\\s*$`（多行，容忍 CRLF/尾随空格）。
  - 从该标题下一行起，收集到下一个 `^#{1,6}\\s` 标题或 EOF 之间的非空行。
  - 每行去列表前缀 → 按首个冒号切 label/prompt → 复用现有 `normalizeNextStepAction` 校验 + `normalizeNextStepActions` 去重/限量。
  - 无标题或无可行项 → 返回 `undefined`。

- `stripNextStepSection(text: string): string`
  - 删除"## 下一步建议"标题及其后跟随的列表行（到下一标题或 EOF），去除末尾多余空行。
  - 用于显示/存储的正文，避免"正文里又出现一遍列表 + 下方又出现按钮"的重复。

修改 `parseTaskResultPayload`：
- JSON.parse 包装层成功后，**以 `parsed.outputSummary`（LLM 自由文本）为主解析源**：
  ```
  const llmText = parsed.outputSummary ?? '';
  const fromText = extractNextStepSuggestionsFromText(llmText);
  const next_step_actions = fromText ?? normalizeNextStepActions(parsed.next_step_actions);
  ```
  （保留 JSON 字段路径作降级兼容，但主路径改为自由文本。）
- 失败分支（JSON.parse 抛错，如纯文本 outputSummary）也调用 `extractNextStepSuggestionsFromText`。

修改 `extractTaskOutputSummaryText`：
- 在返回前对 LLM 文本调用 `stripNextStepSection`，使存入会话/渲染的正文不再重复显示建议列表。
- 注意：`extractNextStepSuggestionsFromText` 必须在 strip 之前对原始文本调用（顺序：先取建议 → 再 strip 正文）。

`formatCommandResult` / `createResultBlocks` / `ActionSuggestion` / `NextStepActionPayload`：字段不变（label/prompt/description?），无需改签名。删除已无用的 `extractNextStepActionsFromMarkdown` 旧 markdown 兜底（被新函数取代）。

### 2. `src/agent/task-message-builder.ts` —— 提示词精简

替换现有"Next-step action hints"整段（要求构造 JSON 数组）为：

```
Next-step suggestions:
- After your summary, if there are concrete follow-ups the user can run directly, add a section titled exactly \"## 下一步建议\".
- Under it, list up to 4 choices, one per line: \"- 动作: 具体信息\".
- 动作: short verb phrase (<=30 chars) shown as the button label.
- 具体信息: the exact text sent as the next user input when the button is clicked; must include concrete file paths / function names / line numbers.
- If no follow-up is needed, omit the section entirely. Do not output JSON.
```

收益：去掉 JSON 构造负担与 `id/label/prompt/description` 字段说明，显著降低 token 与出错概率。

### 3. `src/cli/index.ts` —— 前后台处理逻辑

- `runTask` 中 `outputPayload?.next_step_actions` 映射逻辑**无需改动**（字段仍是 label/prompt/description）。
- 交互循环的 `/1`、`/2` 编号选择逻辑**无需改动**（已基于 `CommandResult.actions`）。
- `formatCommandResult` 编号展示**无需改动**。
- 仅需确认：`SHOULD_LOG_TASK_OUTPUT_DEBUG` 调试日志保留现状（已是开关）。

### 4. `src/desktop/renderer/App.tsx` —— 桌面端

- 动作按钮渲染、`handleActionClick`（填框+聚焦+提示）、`activeActionPrompt` 选中态、`role="group"`/`aria-pressed`：**全部沿用上一轮成果，无需改动**。
- 唯一新增：可变高度输入框（见下节）。

### 5. `src/desktop/renderer/App.tsx` + `styles.css` —— 可变高度输入框

App.tsx：
- 将 `<input type="text">` 改为 `<textarea rows={1}>`，绑定 `inputRef`。
- 新增一个 effect（依赖 `input`）：`const el = inputRef.current; el.style.height='auto'; el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)+'px';`，`MAX_INPUT_HEIGHT` 约等于 6 行（如 `7.5rem`/`120px`，按字号定）。
- `onKeyDown`：Enter（无 Shift）时 `e.preventDefault()` 并触发 `handleSubmit`；Shift+Enter 保留换行。
- `onChange` 沿用（`setInput` + `setActionInputHint(null)`）；textarea 的值控制不变。
- 注意 `handleSubmit` 当前从闭包读 `input`，保持不变即可。

styles.css：
- 新增 `.input-pane textarea`：复用现有 `.input-pane input` 的边框/圆角/背景/聚焦样式（合并选择器或新增块）。
- `resize: none; overflow-y: auto; min-height` 等于单行高度；`max-height: 7.5rem;`（封顶后滚动）。
- `line-height` 与 padding 与原 input 一致，保证单行时视觉无差异。
- 移动端 `.input-pane { grid-template-columns: 1fr }` 分支无需改。

### 6. 测试更新

`tests/unit/result-blocks.test.ts`：
- 调整"normalizes next_step_actions…"用例：改为在 `outputSummary` 自由文本内放 `## 下一步建议` 段落，断言解析出按钮（去重/限量/过滤无效项）。
- 调整"ignores JSON-like markdown…"用例：无 `## 下一步建议` 标题时应返回 undefined。
- 新增"strips 下一步建议 section from displayed text"：`extractTaskOutputSummaryText` 返回值不再含该段。
- 新增"no section → no buttons"：纯总结正文 → `next_step_actions` undefined。
- 新增"label/prompt 切分"：冒号前后正确切分，label>30 或 prompt 空被丢弃。
- 保留"does not turn plain suggestions into desktop action buttons"。

`tests/unit/task-message-builder.test.ts`：
- 更新"describes next_step_actions without requiring ids" → 改为断言提示词含 `## 下一步建议`、`- 动作: 具体信息`、`Do not output JSON`，且不含旧 JSON 示例。

`tests/unit/cli-interactive.test.ts`：
- 现有 `/1` 用例直接喂 `successResult` actions，仍通过；新增一个端到端用例：`outputSummary` 自由文本含 `## 下一步建议` 段落 → 经 `extractTaskOutputSummaryPayload` 解析出 actions → CLI 展示 `/1` 菜单。

## 解析失败 = 优雅退出

- 无 `## 下一步建议` 标题 / 标题下无合法行 / 切分后 label 或 prompt 为空 → 一律返回 `undefined`。
- `createResultBlocks` 已在 actions 为空时不渲染按钮区；CLI `formatCommandResult` 已在无 actions 时不打印 Actions 段。
- 全程不抛异常、不影响正文展示（正文经 `stripNextStepSection` 后正常显示）。

## 验证

- `npx tsc --noEmit`
- `npx vitest run tests/unit/result-blocks.test.ts tests/unit/cli-interactive.test.ts tests/unit/task-message-builder.test.ts`
- 桌面端手测：长输入自动换行封顶滚动；任务回复末尾出现 `## 下一步建议` → 显示按钮；点击填入"具体信息"并聚焦；无建议段落时不显示按钮且正文不残留标题。

## 不在本次范围

- 全量 `npm test` 中既有的无关失败（amber-pipeline、context-resolver、guard-vague-goal、loop-runner、pepe-supervisor、desktop shutdown/ipc shutdown）不动。
- 不改 `CommandResult` / `ActionSuggestion` / `RendererAction` 类型契约。
- 不改 `createResultBlocks` / CLI 编号菜单的行为（仅数据来源从"永不命中"变为"自由文本解析"）。
