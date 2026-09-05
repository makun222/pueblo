# Pueblo 安全风险矩阵（Risk Matrix）

- 基线 commit：`b84227d9971dfd77c57551590d651439408afe43` ｜ 日期：2026-08-29
- 说明：CVSS v3.1 为环境无关基础评分（AV:N/AC:L 假设 Renderer 可达）；实际桌面应用攻击面受本地 IPC 限制，但 Renderer 沦陷（F-02 放大）可使其完全成立。

## 风险矩阵（按严重度降序）

| 发现 | 严重度 | 可利用性 | 影响 | CVSS | 置信度 | PoC | 修复优先级 |
|---|---|---|---|---|---|---|---|
| F-06 MCP RCE | Critical | 高（配置透传即达） | 任意代码执行 | 9.1 | 实证 | PoC-01 A3 ✅ | P0 |
| F-01 IPC 无校验 | High | 高（Renderer 可直达） | 全通道攻击面 | 8.1 | 静态+语料 | PoC-04 | P1 |
| F-02 缺 sandbox | High | 高（XSS 放大） | Renderer 逃逸 | 7.5 | 静态 | — | P1 |
| F-04 供应链 | High | 中（需依赖利用） | 远程代码/DNS 劫持 | 8.1 | 扫描 | — | P1 |
| F-08 写路径穿越 | High | 高（任意输入即达） | 任意文件写 | 8.3 | 实证 | PoC-02 ✅ | P0 |
| F-09 审批门绕过 | High | 中（需 Renderer 配合） | 工具免审批执行 | 8.1 | 静态 | — | P1 |
| F-11 审批伪造 | High | 中（需 Renderer 配合） | 授权他人任意操作 | 8.1 | 静态 | — | P0 |
| F-12 提示词注入 | Medium-High | 中（需不可信内容） | 指令劫持 | 6.5 | 静态 | — | P2 |
| F-07 env 泄露 | Medium | 中（需恶意 MCP） | 密钥泄露 | 5.9 | 实证 | PoC-01 B ✅ | P2 |
| F-13 子代理越权 | Medium | 中（需诱导 spawn） | 权限无降级 | 5.4 | 静态 | — | P2 |
| F-03 命令拆分偏差 | Medium | 低（shell:false 无注入） | 参数边界混淆 | 5.3 | 实证 | PoC-03 ✅ | P2 |
| F-10 附件导出越界 | Medium | 低（需白名单扩展名） | 目录穿越写 | 5.3 | 静态 | — | P2 |
| F-05 gitleaks 命中 | FP | — | — | — | 确认为假值 | — | 关闭 |

## 风险分布

```
Critical ██ 1  (F-06)
High     ███████████ 7  (F-01 F-02 F-04 F-08 F-09 F-11 + F-12 计半)
Medium   ██████ 4    (F-03 F-07 F-10 F-13)
FP       1           (F-05)
```

## 残余风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| PoC-01 A1 平台差异（已闭环） | Node 版本对 shell:true 引号/转义行为不同。**2026-08-29 PoC-05 已在本环境（win32 + Node v24）实证细化**：引号内 `&`/`|`/`^`/`>`/`<` 不被 cmd 解释，但 `%VAR%` 展开在引号内生效、引号闭合可破坏参数结构、含空格命令路径引用脆弱（cmd 按空格拆分）、Node v24 DEP0190 官方警告 args 仅拼接不转义 | 修复侧仍须升级 Node + 移除 shell:true（P0，F-06）；跨版本行为差异转交修复验证 |
| IPC 端到端未跑 | 需 Electron 运行时注入，本环境仅生成语料 | 集成测试接入 `webContents.executeJavaScript` |
| Registry semgrep 未跑（已闭环） | 本地自定义规则 11 条已覆盖核心面 | **2026-08-29 已补跑** p/owasp-top-ten + p/typescript + p/security-audit（`p/electron` 实测 404 不存在，以 security-audit 替代）；2 命中均属既有 F-03/F-06 交叉印证，无新增（`scan-logs/semgrep-registry-2026-08-29.json`） |

## 结论

- **必须修复（P0，3 项）**：F-06 / F-08 / F-11 —— 三者构成可串成链的 RCE + 任意写 + 审批绕过，且全部有 PoC 实证或源码级确定性证据。
- **尽快修复（P1，4 项）**：F-01 / F-02 / F-04 / F-09 —— 攻击面与供应链硬化。
- 正向基线：credential-store（CredMan 加密）、SQLite 全参数化、edit-tool shadow-review 流程、gitleaks 无真实密钥，均为可复用的安全姿势参照。
