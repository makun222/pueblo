# next_step_action 用户交互改进 Review

> ✅ 已迁移 — 目标位置: `design/plan/next-step-ux-review.md`

> 范围：`next_step_actions` 从 LLM 输出 → 解析 → 渲染 → 用户点击的完整交互链路。
> 相关文件：
> - `src/agent/task-message-builder.ts:248-258`（LLM 提示词）
> - `src/shared/result.ts:83-90,226-231,672-753`（类型 + 解析）
> - `src/shared/result.ts:446-466`（`createResultBlocks` 把 actions 挂到 block）
> - `src/shared/result.ts:246-268`（`formatCommandResult`，CLI 文本渲染）
> - `src/cli/index.ts:616-664`（CLI 侧映射 + debug 日志）
> - `src/desktop/renderer/App.tsx:884-887,2940-2954`（桌面按钮渲染 + 点击处理）

---

## 当前交互行为概览

- LLM 按 system 提示词在 task-result JSON 中输出 `next_step_actions` 数组（`id/label/prompt/description?`）。
- `cli/index.ts` 把 `outputPayload.next_step_actions` 映射为 `ActionSuggestion[]`（丢弃 `id`），塞进 `successResult`。
- `createResultBlocks` 把 `actions` 附加到 `primaryBlock`；若没有 actions 但有 `suggestions`，则把 suggestions 字符串也转成按钮。
- 桌面端把按钮渲染在 assistant 消息底部；点击只把 `prompt` 填入输入框，**不自动提交**。
- CLI 端 `formatCommandResult` 把 actions 渲染成纯文本 `  [label] prompt`，不可点击。

---

## 改进建议（按优先级）

### P1 — 直接影响可用性 / 正确性

#### 1. CLI 用户完全无法触发建议（无编号菜单）
- 现象：`formatCommandResult`（result.ts:253-261）把 actions 渲染为 `  [label] prompt` 纯文本，CLI 交互模式下（cli/index.ts:257 `write(formatCommandResult(result))`）用户只能复制粘贴 prompt，没有点击入口。
- 建议：交互模式下渲染成编号列表 `  1) label`，并在下一轮读取用户输入时识别 `/1`、`1` 或 `>1` 之类的前缀，把对应 prompt 自动作为输入提交；非交互模式保持纯文本。
- 收益：CLI 用户也能一键采纳建议，与桌面体验对齐。

#### 2. `suggestions` 被静默转成按钮，与 actions 概念混淆
- 现象：`createResultBlocks`（result.ts:462-466）当 `result.actions` 为空但 `result.suggestions` 非空时，把每条 suggestion 字符串做成 `label = prompt = suggestion` 的按钮。同时 `formatCommandResult`（result.ts:263-268）又会把 suggestions 渲染成 "Suggestions:" 列表。CLI + 桌面两端展示语义不一致；且 suggestion 文本（如 "Try /help"）直接当 prompt 发送可能并不是用户意图。
- 建议：
  - 明确区分两类用途：`actions` = 可一键执行的下一步动作按钮；`suggestions` = 给人读的提示文案。
  - 在桌面端 **不要** 把 suggestions 转成 actions 按钮；CLI 端保留为纯文本提示即可。
  - 或反之：保留按钮化，但 `description` 写明这是提示而非可执行动作，并去掉 prompt 重复发送语义。

#### 3. 提示词中存在乱码字符
- 现象：`task-message-builder.ts:253` 行的 system 提示词里 `"label" (string, 鈮?0 chars)` 实为 `"≤30 chars"` 的编码损坏。这串文本会直接发给 LLM，可能误导其 label 长度约束。
- 建议：修正为 `"≤30 chars"`（或直接写 `"<=30 chars"` 以避免编码问题）。

#### 4. 解析启发式产出低质量按钮
- 现象：`extractNextStepActionsFromMarkdown`（result.ts:701-738）当 JSON 解析失败时：
  - Priority 2：把最后一个代码块里**任何含冒号的行**当作 `label: prompt`（如 `error: foo`、`"key": "value"` 都会被吞）。
  - Priority 3：把最后一个 `##` 标题当 label、整段代码块当 prompt —— 语义几乎一定不匹配。
- 结果：用户会看到莫名其妙、与任务无关的"下一步"按钮。
- 建议：
  - 收紧 Priority 2：要求 label ≤30 字符、prompt 非空且长度合理（如 ≤500），否则跳过；不要把 JSON 形如 `"x": "y"` 的行当 label:prompt。
  - Priority 3 仅在能确认整段代码块就是"下一步说明"时启用，否则返回 `undefined`（宁缺毋滥）。
  - 增加 `perfLog` 记录命中的策略，便于线上排查低质量按钮来源。

#### 5. 失败任务下 actions 被静默丢弃
- 现象：`createResultBlocks`（result.ts:450-466）只在 `phasedBlocks.primaryBlock` 存在时附加 actions；按 debug 文档 Fix 5，已经删除了"无 primaryBlock 时创建孤立 actions block"的分支。但失败路径 `primaryBlock` 类型为 `'error'`（result.ts:~496 附近），actions 是否会被附加需确认；若 LLM 在失败时仍给出修复建议，桌面端可能看不到按钮。
- 建议：显式让 `type: 'error'` 的 block 也承载 `actions`（修复建议在这里反而最有用），并在 CLI 端同步输出。

### P2 — 交互体验提升

#### 6. 点击按钮后无可见反馈
- 现象：`handleActionClick`（App.tsx:884-887）只 `setInput(prompt)`，按钮外观不变；用户不知道点击是否生效，也分不清哪些已用过。
- 建议：
  - 点击后把输入框滚动到可见 + 聚焦，给一个轻微高亮脉冲（"已为你填好，按 Enter 发送"）。
  - 给已点击的按钮加 `disabled` / "used" 样式（同会话内有效）。
  - 提供一个修饰键（如 Shift+点击）直接提交，省去手动按 Enter。

#### 7. `id` 字段要求与实际使用不一致
- 现象：LLM 被要求输出 `id`，`ParsedTaskOutputSummary.next_step_actions` 也带 `id`，但：
  - `cli/index.ts:617` 映射时丢弃 `id`；
  - `ActionSuggestion` 接口无 `id`；
  - `createResultBlocks` 用 `action-${i}` 重新生成 React key。
- 建议（任选其一）：
  - **简化契约**：从提示词和 `ParsedTaskOutputSummary` 中移除 `id`，省 token、避免 LLM 输出不一致的 id。
  - **善用 id**：把 LLM 提供的 id 透传为 React key，比位置索引更稳定（重渲染时不会因顺序变化误复用 DOM）。

#### 8. 数量上限未在代码侧强制
- 现象：提示词说 "at most 4"，但 `cli/index.ts` 的 `?.map(...)` 和 `createResultBlocks` 都没做 `slice(0, 4)`。LLM 偶尔超量时会渲染 5+ 个按钮，挤占视图。
- 建议：在解析/映射处统一 `slice(0, 4)`，并按 `prompt` 去重。

#### 9. 缺失字段时不校验，可能渲染空按钮
- 现象：`cli/index.ts:617` 直接 `map` 成 `{ label, prompt, description }`，若 LLM 漏了 label/prompt，会渲染出空标签按钮。
- 建议：映射时 `filter(a => a.label && a.prompt)`，丢弃非法项并 `perfLog` 一条警告。

### P3 — 锦上添花

#### 10. 无障碍 / 可访问性
- `action-buttons-bar`（App.tsx:2939）缺 `role="group"` 与 `aria-label="Suggested next steps"`；按钮 `title` 用 `description || label`，长文本走原生 `title` 体验差。
- 建议：加 `role="group" aria-label`；考虑自研 tooltip 而非依赖 `title`。

#### 11. 残留 DEBUG perf 日志
- `cli/index.ts:614-624, 660-663` 有多条 `perfLog('DEBUG-outputSummary-...', ...)`，会打印 `outputSummary` 前 3000 字符与完整 actions 内容，可能泄露文件路径、噪声大。
- 建议：用 `if (process.env.PUEBLO_DEBUG_TASK_OUTPUT)` 之类开关包起来，或降级到 verbose 级别。

#### 12. 空态提示
- 当 `next_step_actions` 为空或解析失败时，桌面端不显示任何"下一步"区域，用户无明显感知。
- 建议：可选地在 assistant 消息底部加一行轻量提示（如 "No suggested next steps — ask Pueblo anything"），与有按钮时的视觉占位保持一致。

---

## 落地优先级建议

1. 先做 P1 的 3、4、2（修编码、收紧解析、区分 suggestions/actions）——风险低、收益直接。
2. 再做 P1 的 1（CLI 编号菜单）——改善 CLI 用户体验的关键缺口。
3. P2 一并做（6、7、8、9 都集中在 result.ts / cli/index.ts / App.tsx 三处）。
4. P3 视排期安排。

## 已确认的设计取舍

- ✅ **suggestions 不再转按钮**：桌面端只有 `actions` 渲染成按钮；`suggestions` 仅作纯文本提示保留在 CLI/日志输出中。涉及 `createResultBlocks`（`result.ts:462-466`）的 else 分支删除。

## 待后续确认（先用推荐默认推进）

- CLI 编号采纳前缀：**默认 `/1`**（避免与正常数字输入冲突）。
- `id` 字段方向：**默认简化契约，移除 LLM id 要求**（提示词 + `ParsedTaskOutputSummary.next_step_actions` 去掉 `id`），React key 仍用位置索引。
- Shift+点击直接提交：**默认不做**，仅"填入框 + 聚焦 + 轻微高亮反馈"。
- 上述默认若需调整，实现阶段再提出。
