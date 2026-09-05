# 人工审计第三批 — IPC 审批链路（respond-tool-approval / respond-file-review）

基线 commit：`b84227d9` ｜ 审计日期：2026-08-29 ｜ 审计人：pueblo-dev-flow ｜ 关联：`report/audit-modules-01.md`（F-01 起点）、`report/ipc-channels.md`（SYS-01）、`report/audit-modules-02.md`（F-08 串链）

## 审计范围

| 文件 | 位置 | 内容 |
|---|---|---|
| `desktop/main/ipc.ts` | 454-471 | `respond-tool-approval` handler |
| `desktop/main/ipc.ts` | 473-484 | `respond-file-review` handler |
| `desktop/main/ipc.ts` | 399 | `get-tool-approval-state`（批次/审查信息读取） |
| `desktop/main/ipc.ts` | 916-921 | `createToolApprovalBatch`（batchId 生成） |
| `desktop/shared/ipc-contract.ts` | 41-72 | 审批/审查请求与响应类型 |
| `agent/task-runner.ts` | 1020-1096 | 审批批的触发与决策应用 |

## 结论总览

| 编号 | 等级 | 标题 | 状态 |
|---|---|---|---|
| F-11 | High | 审批门信任边界错误：无 senderFrame 校验 + batchId 对 Renderer 可读可伪造 | 新增 |
| F-01 | High | IPC 全通道无 sender/schema 校验（**升级**：由 SYS-01 通用风险升级为完整利用链核心环节） | 确认升级 |

---

## F-11（High，新增）：审批门可被 Renderer 侧伪造，不能作为信任边界

### 证据链

**1. batchId 生成（`ipc.ts:916-921`）**：

```ts
function createToolApprovalBatch(requests: readonly ToolApprovalRequest[]): DesktopToolApprovalBatch {
  const createdAt = new Date().toISOString();
  return {
    id: `${createdAt}-tool-approval-${Math.random().toString(16).slice(2)}`,
    ...
  };
}
```

**2. batchId 对 Renderer 可见（`ipc.ts:399`）**：

```ts
ipcMain.handle('get-tool-approval-state', async () => resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
```

`resolveToolApprovalState` 返回 `{ activeBatch: activeToolApprovalBatch?.batch ?? null, activeFileReview }`（ipc.ts:750 附近）——**Renderer 为展示审批 UI 必然能读到当前 batchId 与全部请求**。这是设计使然，但意味着 batchId 不是秘密。

**3. 响应校验（`ipc.ts:454-471`）**：

```ts
ipcMain.handle('respond-tool-approval', async (_event, response: DesktopToolApprovalResponse) => {
  if (!activeToolApprovalBatch?.batch) throw new Error('No tool approval batch is pending.');
  const batch = activeToolApprovalBatch.batch;
  if (response.batchId !== batch.id) throw new Error('Tool approval batch is stale.');
  const decisions = response.decision === 'deny' ? ... : buildApprovalDecisions(batch, response.selectedRequestIds, response.decision);
  activeToolApprovalBatch.resolve(decisions);
  ...
});
```

- **无 `event.senderFrame` 校验**（与 SYS-01 一致：40 个通道全部无来源校验）；
- **无一次性挑战码**：`batchId` 只是"当前批次标识"，且必然暴露给 Renderer；
- **`decision` 与 `selectedRequestIds` 完全由调用方指定**，`buildApprovalDecisions` 只做集合映射，不验证"用户真实意图"。

### 攻击路径（与既有发现串成完整利用链）

```
dev 模式 localhost:5173 端口劫持（F-02）
  → 恶意页面在 Renderer 上下文执行（无 sandbox，F-02）
  → 调用 get-tool-approval-state 读取当前 batchId（F-11 暴露面）
  → 调用 respond-tool-approval { batchId, decision:'allow-all' }（F-11 无来源校验）
  → 审批门放行任意批内工具
  → write-tool 无路径校验写任意文件（F-08）
  → MCP spawn 在 Windows 下 shell:true + 配置可控命令 → RCE（F-06）
```

**定级**：High。审批门是本应用"用户授权"的唯一技术锚点，但它把"证明用户在场"退化为"证明调用者知道 batchId"，而 batchId 恰好是发给调用者（Renderer）的。**审批门只能防误点，不能防攻陷的 Renderer**；任何依赖审批门的缓解（F-08 的"有审批门兜底"）都在此失效。

### 重放与单次消费（部分缓解）

- `respond-file-review` 的 resolve 闭包（ipc.ts:215-219）会置 `activeFileReview = null`，`respond-tool-approval` 的 resolve 同样应在批闭包中清理 `activeToolApprovalBatch` → **同一批次只能消费一次**，重放被阻止 ✅（需在 Phase 4 IPC fuzz 中实证）。
- 但"伪造"不需要重放：攻击者在批 pending 期间读 id → 提交一次即可。

### 修复建议

1. **来源锚定**：`respond-tool-approval` 校验 `event.senderFrame.url` 必须属于应用自身的 `app://`/`file://` 页面（并配合 `contextIsolation` + `sandbox`，F-02 修复前置）；
2. **不可伪造的用户手势**：审批决策改为"渲染层按钮事件 + 主进程维护的一次性 nonce"，nonce 仅在**用户实际点击**时由 preload 从可信 UI 事件传递（仍需 senderFrame 校验兜底）；更彻底：审批走独立的系统级确认（如系统对话框/通知中心），完全不依赖 Renderer 上下文；
3. **最小化暴露**：`get-tool-approval-state` 仅返回"存在待审批批次 + 请求摘要"，不返回批次 id 的完整熵（改为 hash），即使伪造也需额外爆破；
4. **deny 默认**：`selectedRequestIds` 不匹配/超集时按 deny 处理（当前 `buildApprovalDecisions` 会把未选中请求置 deny，但 `allow-all` 会整批放行——建议 `allow-all` 也需要更强验证）。

---

## F-01 升级说明（SYS-01 → High 利用链）

- `report/ipc-channels.md` 已盘点 40 通道全无 senderFrame/schema 校验（SYS-01，此前定级 Medium-High）；
- 本批审计确认其中**审批通道（respond-tool-approval / respond-file-review）是敏感度最高的两个**：它们不读取任何文件、不执行任何命令，但**能授权他人执行**；
- 因此 F-01 从"通用 IPC 硬化建议"升级为"**Renderer 沦陷 → 任意工具执行授权** 的 High 级利用链核心环节"，与 F-02/F-06/F-08/F-11 同链。

## 与总报告的关系

- F-11 新增（High），并入 Phase 5 风险矩阵；
- F-01 定级确认（High），修复优先级升至 P0（与 F-02 的 sandbox 修复同批）。
