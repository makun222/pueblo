# Debug 文档：next-step-buttons 编译错误修复

> 🗑️ 废弃 — 源位置: `docs/next-step-buttons-debug.md`
> 已完成修复的临时调试笔记，保留供历史参考。

## 错误总览

`npx tsc --noEmit` 报 9 个编译错误，集中在 3 个文件：
- `src/shared/schema.ts` — 1 个错误
- `src/shared/result.ts` — 8 个错误
- `src/desktop/main/ipc.ts` / `talk-service.ts` — 级联错误

---

## 根因分析

### 根因 1：`RendererAction` 重复定义

| 位置 | 定义 |
|---|---|
| Line 3-8 | `export interface RendererAction { id, label, prompt, description? }` — **手动定义** |
| Line 754 | `export type RendererAction = z.infer<typeof rendererActionSchema>` — **Zod 推断类型** |

修复：删除手动 interface。

### 根因 2：`'actions'` 被错误地加入 `OutputBlockInput.type` 联合类型

`actions` 是 block 上的一个**可选字段**（`RendererAction[]`），不是独立的 block 类型。

修复：从联合类型中移除 `'actions'`。

### 根因 3：`CommandResult.actions` 类型为 `ActionSuggestion[]`

此项已正确，无需修改。

### 根因 4：`createOutputBlock` 缺少 `actions` 字段

修复：添加 `actions: input.actions ?? []`。

### 根因 5：`createPhasedResultBlocks` 返回 `readonly` 修饰符

修复：移除 `readonly` 修饰符。

### 根因 6：`createResultBlocks` 创建 `type: 'actions'` 的非法 block

修复：删除创建 `type: 'actions'` block 的 else 分支。

---

## 修复步骤

| 步骤 | 文件 | 操作 |
|---|---|---|
| Fix 1 | `src/shared/schema.ts:3-8` | 删除手动 `RendererAction` interface |
| Fix 2 | `src/shared/result.ts:93` | 从 `OutputBlockInput.type` 联合类型移除 `| 'actions'` |
| Fix 3 | `src/shared/result.ts:311-325` | `createOutputBlock` 返回值添加 `actions` 字段 |
| Fix 4 | `src/shared/result.ts:471-473` | 返回类型移除 `readonly` |
| Fix 5 | `src/shared/result.ts:444-464` | 删除创建 `type:'actions'` block 的 else 分支 |
| 验证 | — | `npx tsc --noEmit` 全量通过 |
