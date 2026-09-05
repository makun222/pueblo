# Pueblo 安全分析 — 执行清单（TODO，v5）

基线 commit：`b84227d9` ｜ 更新：2026-08-29（Phase 1–5 全部完成，v5 收官；增强项 1/2 闭环）｜ 关联方案：`docs/security/security-analysis-plan.md`

## Phase 0 — 隔离环境搭建 ✅
- [x] 冻结基线 commit → `report/baseline-commit.txt`
- [x] 创建产出物目录骨架：`rules/` `poc/` `report/scan-logs/`
- [x] 安装并固定扫描工具版本（`report/scan-logs/tool-versions.txt`，2026-08-29 重建：node v24.13.0 / npm 11.6.2 / semgrep 1.175.0 / gitleaks 8.30.1）
- [x] 编写自定义 Semgrep 规则（Electron 安全 / 子进程注入 / IPC 校验）；修复 3 处 YAML 语法（`{ shell: true }` 等未加引号）

## Phase 1 — 资产与数据流盘点 ✅
- [x] 盘点 IPC channel 清单（40 通道）→ `report/ipc-channels.md`（结论：全通道无 sender/schema 校验 = SYS-01）
- [x] 盘点 Agent 工具与信任边界入口 → `report/trust-boundaries.md`（TB-1~5 资产映射 + child_process 6 处调用点全量清单）

## Phase 2 — 自动化扫描 ✅
- [x] npm audit → 11 漏洞（8 high / 3 moderate），见 `scan-logs/npm-audit-2026-08-29.txt`
- [x] Gitleaks → 1 命中，判定误报（示例面板假密钥），见 `scan-logs/gitleaks-2026-08-29.json`
- [x] Semgrep（11 条本地自定义规则，116 文件）→ 70 命中，见 `scan-logs/semgrep-local-2026-08-29.json`
- [x] 扫描结果初筛 → `report/scan-summary-phase0-2.md`（F-01~F-05，含误报标记）
- [x]（增强项 1，已闭环）semgrep registry 规则补跑：`p/owasp-top-ten` + `p/typescript` + `p/security-audit`（`p/electron` 实测 404 不存在，已替代）；2 命中均属既有 F-03/F-06 交叉印证，无新增。日志 `report/scan-logs/semgrep-registry-2026-08-29.json`，汇总见 scan-summary §7

## Phase 3 — 人工审计 ✅（按方案 5.2 顺序，四批完成）
- [x] 第一批（命令执行/渲染层/凭据/文件护栏）→ `report/audit-modules-01.md`
     新增 F-06（MCP spawn Windows shell:true，High）、F-07（env 全量透传，Medium）、F-08（写路径无护栏，High）；
     确认 F-02（5 窗口缺 sandbox）、F-03（exec/shell_exec 边界用例）；credential-store 正向 ✅
- [x] 第二批：write-tool / edit-tool / attachment-asset-export 全文（F-08 实证）
      → `report/audit-modules-02.md`：F-08 实证（write-tool 无 root 校验，唯一无护栏写工具）；新增 F-10（attachment 导出 originalPath 任意，扩展名白名单缓解）；edit-tool 正向（shadow+review+restore）
- [x] 第三批：IPC 审批链路 `respond-tool-approval` / `respond-file-review` 令牌与来源校验（F-01 定级关键）
      → `report/audit-modules-03.md`：新增 F-11（High）审批门无 senderFrame 校验 + batchId 经 `get-tool-approval-state` 暴露给 Renderer → Renderer 沦陷可伪造审批（信任边界错误）；确认 F-01 升级为 High（完整利用链）
- [x] 第四批：`provider-config:save-generic` 加密落盘、`persistence/sqlite.ts` SQL 注入面、`agent/**` 提示词注入与子代理权限
      → `report/audit-modules-04.md`：provider-config 正向（CredMan 加密 + 白名单 + 协议校验）；SQLite 全参数化 ✅；新增 F-12（提示词注入无可信度隔离，Medium-High）、F-13（子代理 free 策略 + 权限与主代理一致，Medium）、F-09（MCP 工具策略矛盾：注册 approval-required vs 运行时 free，High）

## Phase 4 — 动态 PoC ✅
- [x] PoC-01 恶意 MCP 服务器（F-06/F-07）→ `poc/poc-01-mcp-shell-injection.js` + `poc-01-out.txt`：F-06 确认（利用面修正为 command 可控 RCE）、F-07 确认（env 泄露）
- [x] PoC-02 写路径穿越（F-08）→ `poc/poc-02-write-path-traversal.js`：绝对路径与 `../` 相对穿越均可写出 workspaceRoot，确认
- [x] PoC-03 命令拆分器 fuzz（F-03）→ `poc/poc-03-split-command-fuzz.js`：26 用例 3 偏差（转义引号/相邻引号拼接/引号+裸词拼接）
- [x] PoC-04 IPC fuzz（F-01）→ `poc/poc-04-ipc-fuzz-corpus.js` + `poc/ipc-fuzz-corpus.json`：44 通道 × 23 类 = 1012 payload 语料 + handler 静态韧性审计
- [x] 汇总与定级移交 → `poc/README.md`（含复现命令与结论）
- [x]（增强项 2，已闭环）PoC-05 `shell:true` cmd 元字符矩阵 → `poc/poc-05-shell-matrix.js` + `poc-05-out.txt`：%VAR% 展开生效（引号内）、引号闭合可破坏参数结构、含空格命令路径引用脆弱（cmd 按空格拆分）、Node v24 DEP0190 官方警告（args 仅拼接不转义）→ F-06 的 A1 面细化，P0 修复建议（移除 shell:true）不变

## Phase 5 — 正式报告 ✅
- [x] `report/findings-b84227d.md`：F-01~F-13 汇总表（等级/CWE/CVSS/位置/状态）+ 修复排期 P0~P2
- [x] `report/risk-matrix-b84227d.md`：按严重度降序矩阵 + 分布统计 + 残余风险 + 结论（P0 必修 3 项：F-06/F-08/F-11）
- [x] 收尾清理：删除旧路径重复文件 `report/tool-versions.txt`（canonical 见 `report/scan-logs/tool-versions.txt`）
