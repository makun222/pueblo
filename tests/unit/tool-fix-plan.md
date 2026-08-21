# Pueblo 内置工具修复方案（read / write / edit）

> 文档版本：v1.0
> 落盘位置：`tests/unit/tool-fix-plan.md`（本任务沙箱根）
> 关联回归测试：`tests/unit/tool-utility.test.ts`（186 行，已落盘）
> 源码范围：`src/tools/edit-tool.ts`、`src/providers/provider-adapter.ts`、`src/providers/deepseek-adapter.ts`
> 说明：`src` 位于当前任务沙箱（`tests/unit`）之外，本文档中的源码行号来自此前的 shell 逐行实证快照；**实际应用 diff 时需在仓库根重新复核行号**。

---

## 1. 背景与目标

大模型在调用 pueblo 内置工具时出现三类高频故障，直接影响自动化任务的可靠完成：

| # | 工具 | 故障现象 | 业务影响 |
|---|------|----------|----------|
| 1 | read | 大文件/分块读取时，**最新一条**工具结果在发送给模型前被阶段压缩，内容不可见（"执行结果已压缩"，预览条数 24→8→0） | 模型拿不到文件内容，无法继续编码/改写 |
| 2 | write | 模型按直觉发 `{path, content}` 时工具调用直接失败，内容带 `</parameter></invoke></tool_calls>` 标签**泄漏到 panel** | 内容落不了盘，污染对话输出 |
| 3 | edit | 替换频繁失败：正则元字符、多行文本、XML 风格文本均无法匹配；歧义场景不可控 | 修改文件反复失败，任务中断 |

**目标**：以最小改动（3 处定点修复、互不干扰）消除以上三类故障，并以回归测试固化行为契约。

---

## 2. 问题总览与根因映射

| 测试用例（tool-utility.test.ts 行号） | 暴露问题 | 根因（src 实证） |
|---|---|---|
| read：L34-46 整读 300 行 → 200 行截断；L48-60 分块 1-150 + 151-300 拼接一致 | **模型视角**：单次 read 请求体 >512KB 时，**全部** tool 消息（含即将给模型看的最新一条）被按阶段压缩，最新结果只剩 0 条预览 | `src/providers/deepseek-adapter.ts` L332-410：请求体超 `DEEPSEEK_MAX_REQUEST_BODY_BYTES`（L113）→ L354 遍历全部阶段 → L355 `compactDeepSeekPromptMessages`（L680-705）→ `compactDeepSeekToolMessageContent`（L707-750）把 read 结果压到 24→8→0 条预览 |
| write：L86-89 字面量透传；L91-101 XML 内容原样落盘且 summary 不泄漏 | **模型按直觉发 `{path, content}` 时工具调用直接失败** → 内容泄漏到 panel（带 XML 标签） | `src/providers/provider-adapter.ts`：`providerWriteToolArgsSchema`（L340-354）只认 `text`；`parseProviderToolArgs` 的 `'write'` 分支（L600 附近）对 `{path, content}` 抛 `ZodError` → 失败后模型退化输出原文 |
| edit：L126-135 正则元字符字面量替换；L137-146 跨多行；L148-162 XML 文本字面量匹配；L164-173 不存在时 failed 且文件不变；L175-184 `startLine/endLine` 消除歧义 | **edit 替换频繁失败**：若用 `new RegExp(oldText)` 实现则元字符/XML 标签全部失配 | `src/tools/edit-tool.ts`：替换实现必须为**字面量匹配 + 范围限定**（测试 L126-184 已把该契约固化） |

**已排除的疑点**：`DEEPSEEK_COMPACTION_GUIDANCE`（deepseek-adapter.ts L90-160 区间）经 Node 按 UTF-8 逐码点校验为 37 字符完整合法字符串，无需修复。

---

## 3. 修复 A：write 的 `content`/`text` 参数归一化

### 3.1 问题描述

- **现象**：模型遵循大多数工具接口习惯发出 `{path, content}` 而非 `{path, text}`。write 工具的参数 schema 只认 `text`，导致 `parseProviderToolArgs` 的 `'write'` 分支抛 `ZodError`，工具调用失败。
- **恶化链路**：调用失败后模型无法感知正确 schema，退化输出原始文本（含 `</parameter>` 等 XML 标签）到对话 panel，内容泄漏且不落盘。
- **已固化契约**（tool-utility.test.ts L86-101）：`text` 中的 XML 标签是**字面量**，必须原样落盘、不得出现在 summary 中。

### 3.2 根因

- `src/providers/provider-adapter.ts`：
  - `providerWriteToolArgsSchema`（L340-354）：仅接受 `text` 字段（`additionalProperties` 收紧）。
  - `parseProviderToolArgs` 的 `'write'` 分支（L600 附近）：对 `{path, content}` 直接抛 schema 错误。
  - 已有 `providerLegacyWriteToolArgsSchema`（L157）可解析 `content`，但未被 `'write'` 分支使用。

### 3.3 修改方案

仅改 `parseProviderToolArgs` 的 **`'write'` 分支**（L600 附近）：

```ts
case 'write': {
  const direct = providerWriteToolArgsSchema.safeParse(rawArgs);
  if (direct.success) {
    return direct.data as ProviderToolArgsByName<TToolName>;
  }
  const legacy = providerLegacyWriteToolArgsSchema.safeParse(rawArgs); // L157 已存在，复用不新建
  if (legacy.success) {
    return { path: legacy.data.path, text: legacy.data.content } as ProviderToolArgsByName<TToolName>;
  }
  throw direct.error; // path 缺失等错误语义不变
}
```

### 3.4 范围边界与副作用

- **只动** `'write'` 分支；read / edit / grep / glob / exec / memo 零改动。
- 两个 legacy schema（L157 / L162）**不动**；`additionalProperties`、`required` 约束不变。
- 优先级：`text` 优先、`content` 兜底；两者同时存在时以 `text` 为准（与现有 `direct` 路径一致）。
- 附带收益：`parseProviderEditCompatibleToolArgs`（L613-639）对 write 的误判路径（把 `{path, content}` 当"编辑追加"）不再被触发。

### 3.5 落地工作

1. [ ] 在 `src/providers/provider-adapter.ts` 的 `parseProviderToolArgs` `'write'` 分支应用上述 diff。
2. [ ] 在 `tests/unit/tool-utility.test.ts` 的 write 块（L83-123）追加回归用例：
   ```ts
   it('parseProviderToolArgs将{path, content}归一化为text', () => {
     const args = { path: 'out.md', content: `# 文档\n${xmlJunk}\n结尾` };
     const parsed = parseProviderToolArgs('write', args);
     expect(parsed).toEqual({ path: 'out.md', text: `# 文档\n${xmlJunk}\n结尾` });
   });
   ```
3. [ ] 运行 `npm test -- tests/unit/tool-utility.test.ts` 确认 write 块全绿。

---

## 4. 修复 B：最近一次工具结果豁免压缩

### 4.1 问题描述

- **现象**：read 大文件（300 行，整读输出上限 200 行）时，请求体超过 provider 上限（512KB），deepseek 适配器对**全部历史 tool 消息**做阶段压缩。压缩作用于"最近一条 tool 消息"——即模型即将看到的当轮 read 结果——最终预览条数降到 0，**模型什么都看不到**。
- **已固化契约**（tool-utility.test.ts L34-60）：分块读取拼接与整读一致，说明 read 工具本身的输出是完整的；问题只出在 provider 侧发送前的压缩环节。

### 4.2 根因

- `src/providers/deepseek-adapter.ts`：
  - L113 `DEEPSEEK_MAX_REQUEST_BODY_BYTES` 阈值判断（L332-410 请求体超限检查）。
  - L354 遍历**全部**阶段 → L355 `compactDeepSeekPromptMessages`（L680-705）→ `compactDeepSeekToolMessageContent`（L707-750）把 read 结果预览 24→8→0。
  - 压缩时未区分"最近 1 条 tool 消息（模型即将消费）"与"历史 tool 消息（仅作上下文）"。

### 4.3 修改方案

在 `compactDeepSeekPromptMessages`（L680-705）的压缩循环前增加规则：

1. **最近 1 条 tool 消息（即模型即将看到的当轮 read 结果）默认跳过压缩**，直接透传；
2. 仅当请求体**即使豁免后仍超限**（≥ 2× 阈值）时，才对其降级压缩——**预览数减半而非清零**；
3. 其余历史消息仍按 `DEEPSEEK_COMPACTION_STAGES` 原逻辑逐阶段压缩，行为不变。

> 设计权衡：优先级是"模型能读到最新结果" > "保留更多历史上下文" > "请求体体积"。预览数减半而非清零，保证极端情况下模型至少能看到内容骨架。

### 4.4 范围边界与副作用

- 只影响"是否压缩最近一条 tool 消息"；历史消息压缩策略、阈值常量、`DEEPSEEK_COMPACTION_GUIDANCE` 均不动。
- 请求体超限仍由原有逻辑兜底（降级压缩 + 最终校验），不会引入超限请求。
- read 之外的其他工具（grep/exec 等）同样受益：最近结果始终优先可见。

### 4.5 落地工作

1. [ ] 在 `src/providers/deepseek-adapter.ts` 的 `compactDeepSeekPromptMessages`（L680-705）入口处增加"最近 1 条 tool 消息豁免/降级压缩"分支。
2. [ ] 在 `compactDeepSeekToolMessageContent`（L707-750）支持"减半预览"降级档位（或复用现有 stage 参数传 `预览数/2`）。
3. [ ] 在仓库根新增/扩展 deepseek 适配器单测（**注意：`src` 在本任务沙箱之外，此测试需在仓库根 `tests/` 下编写**）：
   - 构造超限请求体（≥1× 阈值）：断言最近 1 条 tool 消息内容**完整保留**；
   - 构造极端超限（≥2× 阈值）：断言最近 1 条 tool 消息为减半预览（非 0 条）；
   - 历史 tool 消息压缩结果与原逻辑一致（快照对比）。
4. [ ] 运行 `npm test` 全量回归。

---

## 5. 修复 C：edit 字面量匹配 + 范围限定

### 5.1 问题描述

- **现象**：edit 替换频繁失败：
  - oldText 含正则元字符（`a.b[0]`）时，若用 `new RegExp(oldText)` 实现则 `.`、`[`、`]` 被当作元字符，匹配失配；
  - oldText 跨多行时按行处理导致失配；
  - oldText 含 `</parameter>` 等 XML 风格文本时被当作标签解析而失配；
  - 内容重复出现时无法精确定位，或静默替换错误位置。
- **已固化契约**（tool-utility.test.ts L126-184）：
  1. 正则元字符按字面量替换（L126-135）；
  2. 跨多行替换成功（L137-146）；
  3. XML 风格文本按字面量匹配（L148-162）；
  4. oldText 不存在 → `status: 'failed'` 且文件内容不变（L164-173）；
  5. 重复出现时 `startLine/endLine` 限定范围消除歧义（L175-184）。

### 5.2 根因

- `src/tools/edit-tool.ts`：替换实现若基于 `new RegExp(oldText)`（未转义）则元字符/XML 标签全部失配；若不做行范围限定则歧义场景不可控。

### 5.3 修改方案

将 `src/tools/edit-tool.ts` 的替换实现改为：

1. **字面量匹配**：不使用 `new RegExp(oldText)`；改为字符串包含匹配（`indexOf`），或对 `oldText` 做全量元字符转义后再构造正则（`escapeRegExp`）。
2. **范围限定**：当提供 `startLine`/`endLine` 时，先裁剪候选文本到该行区间，再在区间内做字面量查找；未提供时在整个文件内查找。
3. **一次替换**：匹配到后只替换第一处（或按范围唯一匹配），不做全局替换，避免歧义静默扩散。
4. **失败语义**：找不到 oldText → 返回 `{ status: 'failed', ... }`，**不得改动文件**。
5. 替换成功后返回 `succeeded` 与变更摘要；summary 不得包含被替换的原始敏感文本。

### 5.4 范围边界与副作用

- 只动 `src/tools/edit-tool.ts` 的匹配/替换实现；工具 schema（path/oldText/newText/startLine/endLine）不变。
- 多行匹配基于行间文本的字符串查找（含 `\n`），不做逐行状态机。
- 字面量匹配对性能的影响可忽略（文件级 `indexOf` 线性扫描）。

### 5.5 落地工作

1. [ ] 在 `src/tools/edit-tool.ts` 实现 `escapeRegExp`（或改用 `indexOf` 路径）+ 范围裁剪 + 一次替换 + 失败不改文件。
2. [ ] 回归测试**已落盘**（tool-utility.test.ts L126-184 五条用例），无需新增；运行确认全绿。
3. [ ] 运行 `npm test -- tests/unit/edit-tool.test.ts`（既有 601 行用例）确认无行为回退。

---

## 6. 落地清单汇总（按依赖顺序）

| 步骤 | 动作 | 文件 | 验证 |
|------|------|------|------|
| 1 | 修复 A：write `content`/`text` 归一化 | `src/providers/provider-adapter.ts`（`'write'` 分支） | `tool-utility.test.ts` write 块 + 新增归一化用例 |
| 2 | 修复 B：最近 1 条 tool 消息豁免压缩 | `src/providers/deepseek-adapter.ts`（L680-705 入口 + L707-750 降级档） | 仓库根新增 deepseek 适配器单测 |
| 3 | 修复 C：edit 字面量匹配 + 范围限定 | `src/tools/edit-tool.ts` | `tool-utility.test.ts` edit 块 + `edit-tool.test.ts` |
| 4 | 回归 | — | `npm test -- tests/unit/tool-utility.test.ts` → `npm test` 全量 |

**执行顺序**：C 与 A 相互独立可并行；B 依赖对压缩链路的理解最深，建议单独提交。三项修改互不触碰相同代码段，可拆为 3 个独立 commit 便于回溯。

---

## 7. 风险与边界

- **沙箱限制**：本任务根锁定在 `tests/unit`，`read`/`shell` 无法越界访问 `src`；上述 3 处 diff 需在仓库根（`D:\workspace\trends\pueblo`）应用。本任务内可交付的是：回归测试（已落盘）+ 本方案文档。
- **行号漂移**：文档中 src 行号来自实证快照，应用 diff 前请用 grep 复核符号（`compactDeepSeekPromptMessages`、`providerLegacyWriteToolArgsSchema` 等）。
- **修复 B 阈值语义**：新增"≥2× 阈值才降级压缩"的分支必须与原有 `DEEPSEEK_MAX_REQUEST_BODY_BYTES` 校验兼容，防止出现"豁免后请求体实际超限但未触发压缩"的空洞。
- **兼容性**：write 的 `text` 优先语义与现有 `direct` 路径完全一致，不影响已按正确 schema 调用的客户端。

---

## 8. 后续建议

1. 在仓库根按第 6 节顺序应用 A/B/C 三处 diff，逐项跑通对应测试。
2. 修复 B 上线后观察 read 大文件场景的模型可读性；若仍有压缩，可进一步将阈值从 512KB 提升（需评估 provider 硬限制）。
3. 将本方案沉淀为仓库 `docs/tool-fixes/` 下的正式设计文档，并链接到 `tool-utility.test.ts` 的头部注释。
