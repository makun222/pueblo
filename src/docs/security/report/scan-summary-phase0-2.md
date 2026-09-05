# Phase 0–2 自动化扫描初筛汇总（scan-summary）

- 基线 commit：`b84227d9971dfd77c57551590d651439408afe43` ｜ 日期：2026-08-29
- 工具：semgrep 1.175.0 / npm 11.6.2 (node v24.13.0) / gitleaks 8.30.1（见 `scan-logs/tool-versions.txt`）
- 原始日志：`scan-logs/`（npm-audit-*.txt、gitleaks-*.json、semgrep-local-*.json）

## 1. 三工具结果总览

| 工具 | 结果 | 初筛后 |
| --- | --- | --- |
| npm audit | 11 漏洞（8 high / 3 moderate） | 全部有效，供应链风险（F-04） |
| gitleaks | 1 命中 | **误报**（示例面板假密钥，见 §3） |
| semgrep（自定义规则×11） | 70 命中 | 去重合并为 3 类待验证（F-01~F-03） |

## 2. npm audit — 11 漏洞（F-04，供应链）

| 包 | 严重度 | 摘要 | 修复 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk ≤1.25.1 | high | 默认无 DNS rebinding 防护；ReDoS | `npm audit fix` |
| axios 1.0.0–1.17.0（及 @larksuiteoapi/node-sdk 传递依赖） | high | NO_PROXY 绕过→SSRF、原型污染链（凭据窃取/响应劫持）、ReDoS、代理头泄露等 20+ 公告 | `npm audit fix` |
| brace-expansion ≤1.1.17/2.1.3 | high | DoS（指数展开 / OOM） | `npm audit fix` |
| nanoid 4.0.0–5.1.15（docx 传递） | high | 非安全生成器负尺寸死循环 | `npm audit fix` |
| tmp <0.2.6 | high | **前缀/后缀未消毒路径穿越** | `npm audit fix` |
| ws 8.0.0–8.20.1 | high | 微小分片内存耗尽 DoS | `npm audit fix` |
| xlsx * | high | SheetJS 原型污染 + ReDoS，**无修复** | 换库（exceljs 亦受 uuid 影响） |
| protobufjs 7.5.0–7.6.4 | moderate | .proto 解析无限循环 DoS | `npm audit fix` |
| uuid <11.1.1（exceljs 传递） | moderate | v3/v5/v6 缓冲区边界缺失 | `npm audit fix --force`（breaking） |

风险接受建议：xlsx 无修复且依赖树含 exceljs——若导出功能使用，登记 `risk-accepted` 或替换 SheetJS 发行版。

## 3. gitleaks — 1 命中 → 误报 ✅

- `src/desktop/renderer/mcp-manager/index.tsx:274` `API_KEY=sk-abc123xyz`
- 人工核实：位于 **Example Configuration 示例面板**（`<pre>` 模板文本），非真实密钥，熵 3.58 亦远低于真实密钥阈值。
- 结论：`false-positive`，可加 gitleaks allowlist。

## 4. semgrep — 70 命中 → 3 类待验证

### F-01（SYS-01）ipcMain handler 无 schema 校验 — 56 处
- `desktop/main/ipc.ts`×30、`desktop/main/main.ts`×17、`mcp/mcp-ipc.ts`×9
- 与 Phase 1 人工盘点一致：全通道无 senderFrame/schema 校验。规则为"提醒型"，需人工逐通道确认，不重复计数。

### F-02 electron webPreferences 缺 sandbox — 5 处（5 个窗口）
- `window.ts:11`、`instant-notes-window.ts:72`、`clock-window.ts:21`、`monitor-window.ts:35`、`mcp-manager-window.ts:18`
- 需 Phase 3 确认 contextIsolation/nodeIntegration 现状后定级（window.ts 已列入首批审计）。

### F-03 child_process 首参非常量 — 9 处
| 位置 | 调用 | 初判 |
| --- | --- | --- |
| `mcp/mcp-connection.ts:80` | spawn | **高优先**：外部服务器 command 来自配置，天然非常量 |
| `tools/exec-tool.ts:15,39` | execFile | 工具语义即执行任意命令——需审批门兜底 |
| `tools/shell-exec-tool.ts:17,53` | execFile | 同上 + 自研命令拆分器需边界测试 |
| `cli/index.ts:425,427,428` | spawn | CLI 子命令，低风险 |
| `agent/pepe-local-embedding-client.ts:119` | spawn | 本地 embedding 可执行文件路径，常量概率高，待确认 |

## 5. 合并后待验证发现清单（移交 Phase 3 人工审计）

| ID | 描述 | 来源 | 初始定级（待验证） |
| --- | --- | --- | --- |
| F-01 | IPC 全通道无 sender/schema 校验（40 通道） | 人工 grep + semgrep×56 | High |
| F-02 | 5 个 BrowserWindow 缺 sandbox | semgrep×5 | Medium（需验证 contextIsolation） |
| F-03 | spawn/execFile 首参非常量 9 处 | semgrep×9 | High→Low 视位置 |
| F-04 | 供应链 11 漏洞（含 xlsx 无修复） | npm audit | High |
| F-05 | gitleaks 命中为示例假值 | gitleaks×1 | 误报（FP） |

## 6. 遗留与口径
- semgrep registry 规则（p/owasp-top-ten、p/typescript、p/electron）本轮未联网运行；已用 11 条本地自定义规则覆盖核心面，后续轮次可补跑。
- 误报处理：F-05 标记 FP；semgrep F-01 属规则提醒，按通道逐条人工核验后最终计数。

## 7. Registry 补跑结果（2026-08-29 增强项，已闭环）
- 命令：`semgrep --config p/owasp-top-ten --config p/typescript --config p/security-audit --json --output scan-logs/semgrep-registry-2026-08-29.json .`
- 事实修正：`p/electron` 在 Semgrep Registry 返回 **HTTP 404（不存在该包）**，以 `p/security-audit`（JS/TS 审计包）替代。
- 运行规模：693 规则加载 / 324 条实际运行 / 301 文件（git tracked）→ **2 命中**，`scan-logs/semgrep-registry-2026-08-29.json`：
  1. `mcp/mcp-connection.ts:80` — `detect-child-process`：spawn 首参来自 `config` → **F-06 核心位置复核命中（P0，已知）**；
  2. `agent/pepe-local-embedding-client.ts:119` — `detect-child-process`：spawn 首参来自函数参数 `args` → 与 Phase 2 §4 待确认项一致（F-03 关联，Low，本地 embedding 路径常量概率高）。
- 结论：**无新增发现**，registry 规则对既有 F-03 / F-06 形成交叉印证；解析脚本见 `poc/parse-registry-scan.js`。
