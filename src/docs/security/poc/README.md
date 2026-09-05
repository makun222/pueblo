# Phase 4 — 动态 PoC 实证记录

- 基线 commit：`b84227d9971dfd77c57551590d651439408afe43` ｜ 日期：2026-08-29
- 环境：Windows + Node v24.13.0（`D:\Program Files\nodejs\node.exe`）
- 方法：对审计报告 F-01/F-03/F-06/F-07/F-08 的 4 个候选面做**可复现实验**；全部命令无害化（仅写 poc/ 目录 marker 或系统临时目录）

## PoC 清单与结论

| PoC | 脚本 | 对应发现 | 结果 |
|---|---|---|---|
| 01 | `poc-01-mcp-shell-injection.js` | F-06 / F-07 | **2 项确认 + 1 项修正**（见下） |
| 02 | `poc-02-write-path-traversal.js` | F-08 | **确认**：绝对路径与 `../` 相对穿越均可写出 workspaceRoot |
| 03 | `poc-03-split-command-fuzz.js` | F-03 | **3/26 用例偏差**：转义引号、相邻引号拼接、引号+裸词拼接 |
| 04 | `poc-04-ipc-fuzz-corpus.js` | F-01 | 语料生成 44 通道 × 23 类 = 1012 payload + handler 静态韧性审计 |
| 05 | `poc-05-shell-matrix.js` | F-06（A1 细化） | **shell:true cmd 元字符矩阵**：%VAR% 引号内展开生效、引号可破坏参数结构、含空格路径引用脆弱、DEP0190 官方警告 |

## PoC-01 关键实证（F-06/F-07）

1. **A3（VULN_CONFIRMED）**：`mcp:add-server` 无校验透传 → `command` 完全可控 → 任意命令执行（RCE）。即使 `shell:false` 也不受影响——**真正的攻击面是 command 可控，而非 shell 标志**。
2. **A1（实证修正，经 PoC-05 细化）**：Node v24 在 `shell:true` 下对 args 做双引号包裹，`&`/`|`/`^`/`>`/`<` 等在引号内**不被 cmd 解释**（未复现注入）；但 PoC-05 证实三点残留放大面：① `%VAR%` 变量展开在引号内**生效**（`%CD%` 实测展开为绝对路径）；② 引号闭合可破坏参数结构（探针 exit 0 异常 + JS SyntaxError）；③ 含空格命令路径未被正确引用，cmd 按空格拆分导致命令启动失败（可用性）。Node v24 同时输出 **DEP0190 弃用警告**：`shell:true` 下 args "not escaped, only concatenated"。审计报告"args 含 & 即可注入"需修正为：注入可行性取决于 Node 版本引号行为与路径形态，但 shell:true **仍是放大面**（%VAR% 展开/引号逃逸/版本差异），不应作为主要利用路径（主路径为 A3 command 可控）。
3. **B（VULN_CONFIRMED）**：env 全量继承 → 子进程可读父进程全部密钥类变量（演示注入 `PUEBLO_API_KEY_LEAK_DEMO` / `AWS_SECRET_ACCESS_KEY_LEAK_DEMO` 均被读取）。

## PoC-02 关键实证（F-08）

- 用例 1：绝对路径 `C:\Users\...\Temp\pueblo-poc02-*\escaped-abs.txt` → `succeeded`，文件存在。
- 用例 2：`../../...` 相对穿越 → `succeeded`，文件存在。
- 用例 3：深度穿越至 `D:\` 根因 EPERM 失败（权限限制，非路径校验）。
- **结论**：write-tool 无 workspaceRoot containment 校验，与 edit-tool `resolveEditPath` 形成不对称（实证确认）。

## PoC-03 关键实证（F-03）

- 3 个偏差：`"a\"b"` 转义引号错拆（`a\"b` vs `a"b`）、`"a""b"` 相邻引号拼接（`a""b` vs `ab`）、`"a"b` 引号+裸词拼接（`a"b` vs `ab`）。
- **实证修正**：审计报告称 `""` 空参数丢失——实测**保留**（`echo ""` → `["echo", ""]`）。
- 影响：参数边界混淆可导致命令/参数被错误拆分，但 `shell:false` 下无命令注入；风险定级维持 Low-Medium。

## PoC-04 产出

- `ipc-fuzz-corpus.json`：44 通道 × 23 类畸形 payload（null/类型错配/深嵌套/原型污染/超长串/控制字符/双向文本等）= 1012 条可用语料。
- 静态韧性审计：全部通道 handler 无 schema 校验（zod/parse/assert grep 为空）、无 senderFrame 校验 → 畸形 payload 不会被 handler 层拒绝。
- 端到端注入需 Electron 运行时（`webContents.executeJavaScript`），留待集成测试环境。

## 复现命令

```powershell
& 'D:\Program Files\nodejs\node.exe' docs\security\poc\poc-01-mcp-shell-injection.js
& 'D:\Program Files\nodejs\node.exe' docs\security\poc\poc-02-write-path-traversal.js
& 'D:\Program Files\nodejs\node.exe' docs\security\poc\poc-03-split-command-fuzz.js
& 'D:\Program Files\nodejs\node.exe' docs\security\poc\poc-04-ipc-fuzz-corpus.js
& 'D:\Program Files\nodejs\node.exe' docs\security\poc\poc-05-shell-matrix.js
```

## 移交 Phase 5

- PoC-01 A3 → F-06 定级维持 Critical（利用面从 shell 注入修正为 command 可控 RCE）
- PoC-01 B → F-07 定级维持 Medium
- PoC-02 → F-08 定级维持 High
- PoC-03 → F-03 定级维持 Medium（细节修正）
- PoC-04 → F-01 定级维持 High（语料就绪，待集成环境端到端）
- PoC-05 → F-06 A1 面细化：shell:true 维持放大面判定（%VAR% 展开 / 引号逃逸 / 路径引用脆弱 / DEP0190），P0 修复建议（移除 shell:true）不变
