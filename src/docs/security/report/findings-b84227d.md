# Pueblo 安全审计正式发现报告（Findings）

- 基线 commit：`b84227d9971dfd77c57551590d651439408afe43`（b84227d tool-improve）
- 审计日期：2026-08-29 ｜ 方法：Phase 0-2 自动化扫描（semgrep/npm audit/gitleaks）+ Phase 3 四批人工审计 + Phase 4 四个 PoC（单元级/语料实证，IPC 端到端待验证）
- 关联产出：`scan-summary-phase0-2.md`、`ipc-channels.md`、`trust-boundaries.md`、`audit-modules-01~04.md`、`poc/README.md`

---

## 发现汇总（F-01 ~ F-13）

| ID | 等级 | CWE | CVSS v3.1 | 标题 | 位置 | 状态 |
|---|---|---|---|---|---|---|
| F-01 | High | CWE-345/CWE-20 | 8.1 | IPC 全通道无 senderFrame/schema 校验（40 通道） | `desktop/main/ipc.ts`、`mcp/mcp-ipc.ts` | 静态确认 + 语料就绪（PoC-04，IPC 端到端待验证） |
| F-02 | High | CWE-354/CWE-1021 | 7.5 | 5 个 BrowserWindow 缺 sandbox（contextIsolation 已验证启用） | `desktop/main/window.ts` | 确认 |
| F-03 | Medium | CWE-78 | 5.3 | splitCommand 自研解析器边界错拆（3/26 用例偏差） | `tools/exec-tool.ts:21-24` | 确认（PoC-03，细节修正） |
| F-04 | High | CWE-1357 | 8.1 | 供应链 11 漏洞（@modelcontextprotocol/sdk DNS rebinding、xlsx 无修复等） | `package-lock.json` | 确认 |
| F-05 | FP | — | — | gitleaks 命中为示例面板假密钥 | `mcp/manager` 示例 | 误报 |
| F-06 | Critical | CWE-78 | 9.1 | MCP 服务器 command/args 完全可控 → 任意命令执行（RCE） | `mcp/mcp-connection.ts:64-84`、`mcp/mcp-ipc.ts` | **PoC-01 A3 实证确认**；A1 面经 PoC-05 细化（%VAR% 展开生效、引号可破坏结构、含空格路径引用脆弱、DEP0190） |
| F-07 | Medium | CWE-522 | 5.9 | MCP 子进程继承父进程全部 env（密钥可被读取） | `mcp/mcp-connection.ts:64-72` | **PoC-01 B 实证确认** |
| F-08 | High | CWE-22 | 8.3 | write-tool 无 workspaceRoot 路径校验（绝对路径/`../` 穿越） | `tools/write-tool.ts:27-41` | **PoC-02 实证确认** |
| F-09 | High | CWE-749 | 8.1 | MCP 工具策略自相矛盾：运行时判定 `mcp__*` 为 free，绕过审批门（含内置 SQLite） | `providers/provider-adapter.ts:703-705`、`tools/tool-service.ts:235` | 确认 |
| F-10 | Medium | CWE-22 | 5.3 | attachment 导出 originalPath 来自 JSON 内容，无目录沙箱（仅扩展名白名单） | `tools/attachment-asset-export.ts` | 确认 |
| F-11 | High | CWE-290 | 8.1 | 审批门信任边界错误：respond-tool-approval 无 senderFrame 校验，batchId 可被 Renderer 读取伪造 allow-all | `desktop/main/ipc.ts:454-471`、`get-tool-approval-state` | 确认 |
| F-12 | Medium-High | CWE-94 | 6.5 | 提示词注入防护缺失：不可信内容与系统指令同处 system role | `agent/task-message-builder.ts`、`camel-prompt-builder.ts` | 确认 |
| F-13 | Medium | CWE-269 | 5.4 | 子代理 spawn 为 free 策略 + 执行链与主代理一致，无权限降级/沙箱 | `agent/subagent/subagent-tool.ts`、`cli/index.ts:555` | 确认 |

---

## 高价值利用链（综合 F-02/F-06/F-08/F-11/F-01）

```
1. 攻击者诱导用户打开恶意 MCP server 配置（或 Renderer 被攻陷）
2. mcp:add-server（无校验）→ spawn 任意 command（F-06，PoC-01 A3 实证 RCE）
   └ 或利用 F-01 任意 IPC 通道 → F-11 伪造审批（batchId 可读）
3. 审批通过后 → F-08 write-tool 任意路径写盘（PoC-02 实证）
4. F-06 直接 RCE（Windows 下可扩展为持久化/横向）
```

**最低成本路径**：Renderer 沦陷（F-02 无 sandbox 放大 XSS 影响）→ 读取 batchId（get-tool-approval-state）→ 伪造 respond-tool-approval allow-all（F-11）→ F-08 写盘 / F-09 MCP 工具免审批执行。

---

## PoC 实证修正记录（相对审计报告的偏差）

1. **F-03**：审计报告称 `""` 空参数丢失 → PoC-03 实测**保留**；确认的偏差为转义引号、相邻引号拼接、引号+裸词拼接（3 项）。
2. **F-06**：审计报告称 `shell:true` 下 args 含 `&` 即可注入 → PoC-01 A1 实测 Node v24 对 args 引用转义，`&` 注入未复现；**真实利用面修正为 command 完全可控（A3 RCE 实证）**。shell:true 仍为放大面（cmd.exe 二次解析存在平台差异），但定级依据以 A3 为准。

---

## 修复排期建议

### P0（阻断性，随下个版本）
- F-06：`mcp:add-server`/`update-server`/`test-connection` 增加 command 白名单/路径校验 + 配置签名；MCP 服务器进程降权运行。
- F-11：`respond-tool-approval` 增加 senderFrame 校验 + batchId 高熵化（不向 Renderer 完整暴露）；allow-all 需二次确认。
- F-08：write-tool 复用 edit-tool `resolveEditPath` 的 workspaceRoot containment 校验（参照实现已备）。

### P1（高优先，2-4 周内）
- F-02：全部 BrowserWindow 加 `sandbox: true`；dev 模式校验导航 origin。
- F-09：统一 tool policy 判定（tool-service 注册为准，删除 provider-adapter 的运行时覆盖）。
- F-01：IPC 通道引入入参 schema 校验（zod）逐通道落地；senderFrame 校验先行覆盖写通道。
- F-04：`npm audit fix` + 评估 xlsx 替代。

### P2（计划内）
- F-07：env 白名单注入（仅 config.env + 少量固定变量）。
- F-12：system role 中不可信内容加可信度标记/隔离区。
- F-13：子代理降权（最小工具集 + 只读默认）。
- F-03：splitCommand 替换为成熟解析器（如 shell-quote）或状态机实现。
- F-10：导出目标以调用方 assetPath 为准，JSON originalPath 仅作展示。
