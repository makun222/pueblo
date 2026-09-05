# 人工审计第二批 — 文件写入面（write / edit / attachment 导出）

基线 commit：`b84227d9` ｜ 审计日期：2026-08-29 ｜ 审计人：pueblo-dev-flow（人工+工具辅助）｜ 关联：`report/scan-summary-phase0-2.md`（F-08）、`report/audit-modules-01.md`

## 审计范围

| 文件 | 行数 | 关键函数 |
|---|---|---|
| `tools/write-tool.ts` | 58 | `createWriteTool` |
| `tools/edit-tool.ts` | 758 | `resolveEditPath` / `prepareEditRequest` / `applyPendingEditOutcome` / `restorePendingEditTarget` |
| `tools/attachment-asset-export.ts` | 225 | `maybeExportAttachmentAssetFromContent` / `exportDocumentAsset` / `exportSpreadsheetAsset` |

## 结论总览

| 编号 | 等级 | 标题 | 状态 |
|---|---|---|---|
| F-08 | High | write-tool 无 workspace root 路径校验（**实证确认**） | 确认 |
| F-10 | Medium | attachment 导出的 `originalPath` 无路径沙箱（扩展名白名单缓解） | 新增 |
| — | 正向 | edit-tool 路径护栏 + shadow-review-restore 流程完备 | 确认无新问题 |

---

## F-08（High，实证确认）：write-tool 是唯一无路径护栏的写工具

**证据链（`tools/write-tool.ts:27-41`）**：

```ts
const absolutePath = isAbsolute(request.path)
  ? request.path                       // ← 绝对路径直接接受，不做任何 root 校验
  : resolve(request.cwd, request.path);
mkdirSync(dirname(absolutePath), { recursive: true });   // ← 递归创建任意父目录
...
writeFileSync(absolutePath, request.text, 'utf-8');
```

- 对比：`edit-tool.ts:257-263` 的 `resolveEditPath` 明确校验 `relativePath.startsWith('..')` 抛错；`read-tool.ts:185` 的 `resolveRequestedPath` 同样校验。**三个读写工具中只有 write 没有护栏**（`file-guard` 只护 read，见 audit-modules-01）。
- `resolvedWorkspaceRoot` 仅用于 `SnapshotEngine`（自动快照回滚），**不参与路径约束**。
- 写入点：`~/.ssh/authorized_keys`、`.npmrc`/`.pypirc`、启动项、`/etc` 下权限允许处、工作区外用户文档——只要 Agent 可驱动，均可写。
- 缓解因素（不消除风险）：
  1. `getToolExecutionPolicy('write') === 'approval-required'`（provider-adapter.ts:693）→ 正常流程需审批门放行；
  2. 审批门本身可被伪造（见 F-11，audit-modules-03）→ 缓解在 Renderer 沦陷场景下失效；
  3. 写入需 Agent 被诱导（提示词注入/恶意 MCP 工具返回），见 F-12/F-06 串链。
- **定级**：独立看 Medium（需先攻破 Agent 或审批门）；与 F-01/F-06/F-11 串链后为 **High**（Renderer 沦陷 → 伪造审批 → 任意写盘）。

**修复建议**：
1. `write-tool` 复用 `resolveEditPath` 同款校验（`path.relative(root, abs)` 必须落在 root 内）；拒绝绝对路径或强制 root 前缀；
2. 将路径护栏下沉到 `tool-service` 的统一执行层（所有文件类工具共享），避免单工具各自实现；
3. 对 `write` 增加"目标路径预览"进审批请求（类似 edit 的 preview），让用户看见写哪。

---

## F-10（Medium，新增）：attachment 导出路径来自 JSON 内容，无目录沙箱

**证据链（`tools/attachment-asset-export.ts:88-91, 157-160`）**：

```ts
async function exportDocumentAsset(asset: DocumentAttachmentAsset): Promise<void> {
  if (path.extname(asset.source.originalPath).toLowerCase() !== '.docx') {
    throw new Error(...);                    // ← 唯一校验：扩展名白名单
  }
  ...
  await fs.mkdir(path.dirname(asset.source.originalPath), { recursive: true });
  XLSX.writeFile(workbook, asset.source.originalPath, { bookType: ... });  // ← 路径来自 JSON
}
```

- `asset.source.originalPath` 来自被 `documentAttachmentAssetSchema` / `spreadsheetAttachmentAssetSchema` 解析的 attachment JSON 内容——**schema 只校验结构与类型，不校验路径归属**。
- 攻击场景：恶意 attachment JSON（来自导入文件 / MCP 工具返回 / 提示词诱导 Agent 编辑附件内容）可指定任意 `originalPath`，诱导导出流程在任意位置生成 `.docx/.xlsx/.xls` 文件（覆盖用户文档、填充磁盘、写入可被双击执行的宏文件目录等）。
- 缓解因素：
  1. 扩展名白名单（docx/xlsx/xls）→ 无法直接落地可执行文件；
  2. 内容经 schema 强校验 + `resolveSpreadsheetCellType` 类型化写入 → 常规 CSV/公式注入被削弱（sheet 名截断 31 字符）；
  3. 导出动作发生在 edit 流程的文件 review 之后，正常路径有人工可见性。
- **定级**：Medium（需要 attachment JSON 可控作为前置；落地能力受限）。

**修复建议**：
1. 导出前用与 F-08 相同的 root 校验（导出目标应限制在 workspace / 会话附件目录内）；
2. 将 `originalPath` 视为不可信字段：优先使用调用方传入的 `assetPath`（已有）作为导出目标，JSON 内路径仅作展示。

---

## 正向结论 — edit-tool 安全姿势良好

- `resolveEditPath`（257-269）：`..` 前缀与绝对相对路径双重校验，**路径必须在 workspace root 内** ✅
- `prepareEditRequest`（138 起）：编辑前生成审批/审查摘要（matchCount 精确匹配计数、scope 标注、diff 预览）→ 用户可见性 ✅
- shadow 机制（437-445）：`reviewId = Date.now()-edit-review-<random>`；先写 shadow 目录，`file-review` 批准后才落真实路径 ✅
- `restorePendingEditTarget`：异常/拒绝时回滚（删新文件或写回 previousContent）✅
- `isCreateFileEdit` 分支同样经过 `resolveEditPath`，创建文件路径受限 ✅

**结论**：edit-tool 无新增漏洞；其路径护栏与 shadow-review 流程应作为 write-tool 改造的参照实现。

---

## 与总报告的关系

- F-08 从"待 PoC 实证"升级为"实证确认"（本批已完成源码级证明；Phase 4 写路径穿越 PoC 仍可做端到端验证）。
- F-10 新增，并入 Phase 5 风险矩阵。
