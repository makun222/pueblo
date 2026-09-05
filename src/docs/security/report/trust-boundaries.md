# Pueblo 信任边界与资产清单（Phase 1 资产盘点）

- 基线 commit：`b84227d9971dfd77c57551590d651439408afe43`
- 盘点日期：2026-08-29
- 关联：方案 §1.4（5 条信任边界）、§5.2（10 个重点模块）

## 信任边界 → 入口资产映射

### TB-1 不可信内容 → Agent 上下文（提示词注入）
| 资产 | 入口文件 |
| --- | --- |
| 文件读取工具 | `tools/read-tool.ts`、`tools/grep-tool.ts`、`tools/glob-tool.ts`、`tools/memo-recall-tool.ts` |
| 网页/远程内容 | `tools/attachment-asset-export.ts`、provider 返回流 `providers/server-sent-events.ts` |
| MCP 返回内容 | `mcp/mcp-context.ts`、`mcp/mcp-protocol.ts` |
| 记忆回放 | `persistence/memory/**`、`memory/**` |
| 会话回放 | `sessions/**` |

### TB-2 Renderer → Main（IPC 提权）
| 资产 | 入口文件 |
| --- | --- |
| IPC 注册 | `desktop/main/ipc.ts`（约 33 通道）、`mcp/mcp-ipc.ts`（8 通道） |
| preload 桥 | `desktop/preload/index.ts`、`desktop/renderer/monitor/monitor-preload.ts` |
| 窗口配置 | `desktop/main/window.ts`（webPreferences：sandbox/contextIsolation） |
| 危险 IPC 面 | `mcp:add-server` / `mcp:update-server` / `mcp:save-credential` / `respond-tool-approval` / `loop:start` / `select-input-files` |

### TB-3 外部 MCP 服务器 / 外部命令 → 本机执行
| 资产 | 入口文件 |
| --- | --- |
| MCP 服务器拉起 | `mcp/mcp-connection.ts`（`spawn`）、`mcp/mcp-client.ts`、`mcp/mcp-registry.ts`、`mcp/mcp-discovery.ts` |
| 凭据注入子进程 | `mcp/mcp-credentials.ts` |
| 命令执行工具 | `tools/exec-tool.ts`、`tools/shell-exec-tool.ts`（均 `execFile`，无 `shell:true`，待边界用例审计） |

### TB-4 Agent 工具 → 文件系统 / 进程 / 网络
| 资产 | 入口文件 |
| --- | --- |
| 文件读写 | `tools/write-tool.ts`、`tools/edit-tool.ts`、`tools/undo-edit-tool.ts`、`tools/read-tool.ts` |
| 路径护栏 | `tools/file-guard.ts`（只护读、待确认写路径） |
| 工具调度/审批 | `tools/tool-service.ts`、`tools/tool-invocation-repository.ts` |
| 网络出口 | `providers/*-adapter.ts`、`mcp/mcp-client.ts` |

### TB-5 持久化数据 → 敏感信息泄露
| 资产 | 入口文件 |
| --- | --- |
| 凭据存储 | `providers/credential-store.ts`（spawnSync → 平台凭据管理器）、`mcp/mcp-credentials.ts` |
| SQLite | `persistence/sqlite.ts`、`persistence/repository-base.ts`、`persistence/migrate.ts` |
| 会话/导出 | `sessions/**`、`tools/attachment-asset-export.ts`、`workflow/**` |
| 配置 | `shared/config.ts`、`providers/generic-provider-config.ts` |

## 命令执行点清单（child_process 全量）
| 文件 | 调用 | 备注 |
| --- | --- | --- |
| `mcp/mcp-connection.ts` | `spawn` | 外部 MCP 服务器，参数/环境需审计（重点） |
| `tools/exec-tool.ts` | `execFile` | 无 shell，参数数组，需边界用例验证 |
| `tools/shell-exec-tool.ts` | `execFile` | 无 shell，但命令字符串拆分为自研解析器 → 需引号/管道边界测试 |
| `providers/credential-store.ts` | `spawnSync` | 调用平台凭据管理器（wincred/secret-tool） |
| `agent/pepe-local-embedding-client.ts` | `spawn` | 本地 embedding 进程 |
| `cli/index.ts` | `spawn` | CLI 子进程 |

**全仓 `shell: true` 命中：0**（仅 `docs/security/rules/*.yml` 规则模板自身）✅

## 关键结论
1. **SYS-01（High，待定级）**：40 个 IPC 通道全部缺失 sender 校验 + schema 校验（grep 实证）。
2. TB-3 的 `mcp:add-server` 透传配置即执行 → 与 TB-2 叠加形成 **Renderer 沦陷 → 任意命令执行** 完整链。
3. 命令执行面整体使用 `execFile`/`spawn` 数组参数，未开启 shell——**基础姿势正确**，重点转向自研命令拆分器与 spawn 环境变量注入。
