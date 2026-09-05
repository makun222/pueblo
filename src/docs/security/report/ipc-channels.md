# Pueblo IPC 通道清单（Phase 1 资产盘点）

- 基线 commit：`b84227d9971dfd77c57551590d651439408afe43`
- 盘点日期：2026-08-29
- 方法：对 `desktop/ mcp/ tools/ providers/ persistence/` 当前源码做 `ipcMain.handle/on` 正则提取（排除 `.pueblo/file-snapshots/` 历史快照与 `docs/security/` 规则文件）
- 结论先行：**共 40 个 IPC 通道；全部通道未发现 `event.senderFrame` / sender 校验，未发现入参 schema 校验（zod/parse/assert grep 为空）** → 系统性风险 SYS-01（见扫描汇总）。

## 通道清单（40）

### A. 会话 / 输入（`desktop/main/ipc.ts`）
| 通道 | 方向 | 备注 |
| --- | --- | --- |
| `submit-input` | R→M invoke | 提交用户输入进入 Agent 循环 |
| `cancel-active-submit` | R→M invoke | 取消进行中的提交 |
| `start-agent-session` / `select-session` / `get-session` | R→M | 会话生命周期 |
| `list-agent-sessions` / `list-agent-profiles` / `list-session-memories` | R→M | 查询 |
| `select-input-files` | R→M | 文件选择（可被用于诱导读取任意路径？待 Phase 3 验证） |

### B. Agent 循环控制（`desktop/main/ipc.ts`）
| 通道 | 备注 |
| --- | --- |
| `loop:start` / `loop:pause` / `loop:resume` / `loop:cancel` / `loop:list-active` / `loop:focus-monitor` | 控制 Agent 主循环；`loop:start` 无参数校验则存在启动面 |

### C. 审批 / 交互回调（`desktop/main/ipc.ts`）
| 通道 | 风险点 |
| --- | --- |
| `respond-tool-approval` | 危险工具审批应答——若可伪造/重放，可绕过审批门（信任边界 4/6 关键闸门） |
| `respond-file-review` | 文件审查应答 |
| `respond-talk-request` / `respond-talk-continuation` / `get-talk-state` | 语音/对话 |

### D. 笔记（`desktop/main/ipc.ts` 或 notes 模块）
`notes:list` `notes:save` `notes:update` `notes:delete` `notes:queue-new-agent` `notes:queue-next-turn` `notes:queue-subagent`

### E. Provider 配置（`desktop/main/ipc.ts`）
`provider-config:list` `provider-config:save-generic` `provider-config:remove-generic`（保存含 API Key 的配置——需确认是否经 credential-store 加密）

### F. MCP（`mcp/mcp-ipc.ts`，重点）
| 通道 | 当前实现 | 风险 |
| --- | --- | --- |
| `mcp:add-server` | `(_event, server: McpServerConfig) => client.addServer(server)`，无校验 | **任意 MCP 服务器配置 → spawn 任意命令（提权路径）** |
| `mcp:update-server` | 同上透传 | 同上 |
| `mcp:remove-server` / `mcp:restart-server` | 透传 serverName | 对象注入面 |
| `mcp:test-connection` | 透传 config 并 `spawn` 连接 | 临时执行面 |
| `mcp:list-servers` / `mcp:get-connection-states` | 查询 | 低 |
| `mcp:list-credentials` | 返回凭据键列表 | 信息泄露面（键名） |
| `mcp:save-credential` | `(_event, key, value) => setApiKey(key, value)` 无校验 | 任意键写凭据存储；值若明文落盘则泄露 |
| `mcp:delete-credential` | 透传 key | 低 |

### G. 运行时状态
`get-runtime-status` `get-tool-approval-state` `get-talk-state`

## preload 暴露面（`desktop/preload/index.ts`）
- `contextBridge.exposeInMainWorld('electronAPI', {...})`，共 117 行，暴露全部上述 invoke 封装 + `removeAllListeners`/`onOutput` 监听。
- 另 `desktop/renderer/monitor/monitor-preload.ts` 暴露 `monitorAPI`。
- 判定：preload 未做通道白名单之外的最小化——`removeAllListeners` 等管理 API 亦暴露给 renderer。

## 待 Phase 3 逐通道验证项
- [ ] `respond-tool-approval` / `respond-file-review` 是否校验审批批次/令牌与来源窗口
- [ ] `select-input-files` 返回路径是否经过 file-guard 再过滤
- [ ] `provider-config:save-generic` 是否加密落盘（对照 credential-store）
- [ ] `mcp:*` 六个写通道的 sender 来源（mcp 管理窗口 vs 主窗口）是否可被混淆
