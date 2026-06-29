# Debug 文档：next-step-buttons 编译错误修复

## 错误总览

`npx tsc --noEmit` 报 9 个编译错误，集中在 3 个文件：
- `src/shared/schema.ts` — 1 个错误
- `src/shared/result.ts` — 8 个错误
- `src/desktop/main/ipc.ts` / `talk-service.ts` — 级联错误

---

## 根因分析

### 根因 1：`RendererAction` 重复定义 (`schema.ts:3` vs `schema.ts:754`)

| 位置 | 定义 |
|---|---|
| Line 3-8 | `export interface RendererAction { id, label, prompt, description? }` — **手动定义** |
| Line 754 | `export type RendererAction = z.infer<typeof rendererActionSchema>` — **Zod 推断类型** |

两者名称相同，TypeScript 报告重复标识符。Zod 推断类型是真实数据源，手动 interface 应删除。

---

### 根因 2：`'actions'` 被错误地加入 `OutputBlockInput.type` 联合类型 (`result.ts:93`)

```
当前: 'text' | 'code' | 'markdown' | 'list' | 'heading' | 'actions'
应为: 'text' | 'code' | 'markdown' | 'list' | 'heading'
```

`actions` 是 block 上的一个**可选字段**（`RendererAction[]`），不是独立的 block 类型。Zod schema 中 `rendererOutputBlockTypeSchema` 的枚举值为：
```
['command-result', 'task-result', 'tool-result', 'error', 'system', 'loop-launch']
```
**不含 `'actions'`**。任何以 `type: 'actions'` 创建的 block 都会在 Zod 校验 / IPC 序列化中失败。

---

### 根因 3：`CommandResult.actions` 类型为 `ActionSuggestion[]` (`result.ts:110`)

```
当前: readonly actions?: ActionSuggestion[]  ✅ 已是正确类型
```

此项目已正确——LLM 输出不含 `id`，使用 `ActionSuggestion`（label + prompt + description?）。转换在 `createResultBlocks` 中完成。**无需修改。**

---

### 根因 4：`createOutputBlock` 缺少 `actions` 字段 (`result.ts:311-325`)

当前返回对象不包含 `actions` 字段。需要添加 `actions: input.actions ?? []`。

---

### 根因 5：`createPhasedResultBlocks` 返回 `readonly` 修饰符 (`result.ts:471-473`)

```typescript
export function createPhasedResultBlocks(result: CommandResult<unknown>): {
  readonly primaryBlock: RendererOutputBlock | null;      // ← readonly 导致赋值失败
  readonly supplementalBlocks: RendererOutputBlock[];     // ← readonly 导致赋值失败
}
```

`createResultBlocks` 中对 `phasedBlocks.primaryBlock` 的赋值被 TS2540 拦截。应移除 `readonly` 修饰符。

---

### 根因 6：`createResultBlocks` 创建 `type: 'actions'` 的非法 block (`result.ts:444-464`)

当无 `primaryBlock` 但有 `actions` 时，代码进入 `else` 分支创建 `createOutputBlock({ type: 'actions', ... })`。这产生了一个枚举中不存在的 block 类型。应删除此 `else` 分支——若没有 primaryBlock，actions 无处可附，不应创建孤立的 actions block。

---

## 修复步骤

| 步骤 | 文件 | 操作 |
|---|---|---|
| **Fix 1** | `src/shared/schema.ts:3-8` | 删除手动 `RendererAction` interface |
| **Fix 2** | `src/shared/result.ts:93` | 从 `OutputBlockInput.type` 联合类型移除 `\| 'actions'` |
| **Fix 3** | `src/shared/result.ts:311-325` | `createOutputBlock` 返回值添加 `actions` 字段 |
| **Fix 4** | `src/shared/result.ts:471-473` | `createPhasedResultBlocks` 返回类型移除 `readonly` |
| **Fix 5** | `src/shared/result.ts:444-464` | 删除 `createResultBlocks` 中创建 `type:'actions'` block 的 else 分支 |
| **验证** | — | `npx tsc --noEmit` 全量通过 |

---

## 设计对照

设计文档 `next-step-buttons-design.md` 明确：

- **`ActionSuggestion`**(LLM 侧)：`{ label, prompt, description? }` — **无 `id`**
- **`RendererAction`**(渲染侧)：`{ id, label, prompt, description? }` — **有 `id`**
- **`CommandResult.actions`**：`ActionSuggestion[]` — LLM 返回的原始建议
- **`RendererTaskResultBlock.actions`**：`RendererAction[]` — 转换后的渲染数据（通过 `createResultBlocks` 添加 `id`）
- `actions` 是 **block 上的可选字段**，**不是独立的 block 类型**
