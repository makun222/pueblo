# Pueblo 日志系统规范

> 版本：v1.0 | 最后更新：2026-07-08

---

## 一、现状盘点

### 1.1 日志源文件（TypeScript）

| # | 源文件 | 导出函数 | 记录内容 | 调用方 |
|---|--------|----------|----------|--------|
| 1 | `src/utils/perf-logger.ts` | `perfLog(label, durationMs)` | 性能计时：标签 + 毫秒耗时 | `src/agent/task-runner.ts`、`src/amber/cli.ts` |
| 2 | `src/utils/perf-logger.ts` | `amberLog(level, msg)` | Amber pipeline 运行日志（`info` / `error`） | `src/amber/cli.ts` |
| 3 | `src/providers/llm-response-logger.ts` | `createLlmResponseLogger()` | LLM 请求/响应完整 JSON（prompt、response、token 用量、模型信息） | `src/providers/llm-client.ts` |
| 4 | `src/channel/channel-debug-log.ts` | `channelDebugLog(event, detail)` | Channel 连接生命周期、消息收发、错误 | `src/channel/channel-service.ts`、`src/channel/channels/feishu/feishu-adapter.ts` |

### 1.2 日志输出目录

#### `logs/`（约 328 MB — **严重臃肿**）

| 内容 | 数量 | 大小 | 来源 |
|------|------|------|------|
| `logs/llmRespons/` — LLM 请求/响应 JSON | 1,304 个 | ~328 MB | `llm-response-logger.ts` |
| `logs/task-*.json` — 任务执行 dump | ~584 个 | 含在上述 | 任务执行器 |
| `logs/latest-request-analysis.txt` | 1 个 | 3 B | 未知脚本（指针文件） |

#### `.logs/`（约 114 KB）

| 文件 | 大小 | 来源 | 滚动策略 |
|------|------|------|----------|
| `amber-2026-07-01.log` | 7.9 KB | `amberLog()` | 按日期 |
| `amber-2026-07-02.log` | 6.8 KB | `amberLog()` | 按日期 |
| `channel-debug-2026-07-06.log` | 56.8 KB | `channelDebugLog()` | 按日期 |
| `channel-debug-2026-07-07.log` | 43.5 KB | `channelDebugLog()` | 按日期 |
| `perf-2026-07-06T01-20-03.log` | 60 B | `perfLog()` | **每次运行一个文件** |
| `perf-2026-07-06T01-32-29.log` | 60 B | `perfLog()` | 同上 |
| `perf-2026-07-06T08-24-48.log` | 56 B | `perfLog()` | 同上 |
| `perf-2026-07-07T09-49-20.log` | 56 B | `perfLog()` | 同上 |
| `amber-verify-hex.txt` | 347 B | 验证脚本 | —（非日志） |
| `verify.cjs` / `verify2.cjs` | 346/424 B | 验证脚本 | —（非日志） |

### 1.3 `console.log` 散落情况（37 处，11 个文件）

| 文件 | 数量 | 严重程度 | 典型用途 |
|------|------|----------|----------|
| `src/amber/cli.ts` | 7 | ⚠️ 中 | CLI 交互输出 + `amberLog()` 双写 |
| `src/channel/channels/feishu/feishu-adapter.ts` | 6 | ⚠️ 高 | 连接生命周期 |
| `src/agent/task-runner.ts` | 5 | ⚠️ 高 | Context dump、工具审批 |
| `src/channel/channel-service.ts` | 4 | ⚠️ 高 | Channel 启动失败、消息错误 |
| `src/mcp/mcp-client.ts` | 4 | ⚠️ 中 | MCP 初始化错误 |
| `src/desktop/main/loop-job-manager.ts` | 3 | ⚠️ 高 | loop job 错误 |
| `src/desktop/main/main.ts` | 2 | ⚠️ 高 | MCP 启动失败 |
| `src/sessions/session-repository.ts` | 2 | ℹ️ 低 | 数据迁移告警 |
| `src/agent/turn-indexer.ts` | 2 | ℹ️ 低 | 索引安全边界 |
| `src/agent/loop-runner.ts` | 1 | ⚠️ 中 | 循环上下文溢出 |
| `src/desktop/main/ipc.ts` | 1 | ⚠️ 中 | IPC 未处理错误 |

### 1.4 现状问题总结

| 问题 | 严重程度 | 说明 |
|------|----------|------|
| `logs/` 目录 328 MB 无人清理 | 🔴 严重 | LLM 日志 1,304 个文件，无回收机制 |
| `perfLog()` 每次运行一个文件 | 🟡 中等 | 应合并为按日期滚动的单一文件 |
| `.logs/` 混入非日志文件 | 🟡 中等 | `verify.cjs`、`amber-verify-hex.txt` 等 |
| `console.log` 与结构化日志并存 | 🟡 中等 | 37 处直接 `console.log`，未走统一日志器 |
| `amberLog()` 与 `console.log` 双写 | 🟡 中等 | `cli.ts` L269-270 同时写两处 |
| 无统一的日志级别体系 | 🟡 中等 | `amberLog` 有 level 参数，其他无 |

---

## 二、日志规范

### 2.1 功能覆盖

日志系统必须覆盖以下功能域，确保所有重要过程信息被保留：

| 功能域 | 必须记录的内容 | 日志级别 | 实现方式 |
|--------|---------------|----------|----------|
| **LLM 调用** | 请求参数（model、messages、tools、temperature 等）、响应内容（completion、tool_calls）、token 用量（prompt_tokens / completion_tokens / total_tokens）、延迟 | `info` | `llm-response-logger.ts`（已有） |
| **Agent 任务执行** | 任务 ID、开始/结束时间、使用的工具及参数、工具返回结果摘要、错误堆栈、审批决策 | `info` / `error` | `task-runner.ts` → 迁移至统一 logger |
| **Channel 通信** | 连接建立/断开、消息收发（脱敏）、认证状态变更、重连尝试、错误 | `info` / `error` | `channel-debug-log.ts`（已有，需强化脱敏） |
| **Amber Pipeline** | Pipeline 阶段开始/结束、输入/输出摘要、错误、验证结果 | `info` / `error` | `amberLog()`（已有） |
| **桌面进程** | MCP 服务启动/停止、IPC 错误、loop job 状态变更、崩溃前状态 | `info` / `error` | `console.log` → 迁移至统一 logger |
| **性能指标** | 工具调用耗时、LLM 请求耗时、任务总耗时 | `info` | `perfLog()`（已有，需合并文件） |
| **会话/数据** | 数据迁移操作、会话创建/销毁 | `warn` / `info` | `session-repository.ts` → 迁移 |

### 2.2 路径、分层及命名

#### 2.2.1 目录结构（统一到 `.logs/`）

```
项目根目录/
└── .logs/                          # 所有日志统一根目录
    ├── app/                        # 应用层日志
    │   ├── app-{YYYY-MM-DD}.log    # 通用应用日志（info 及以上）
    │   └── app-error-{YYYY-MM-DD}.log  # 错误隔离（仅 error/warn）
    ├── llm/                        # LLM 调用日志
    │   └── llm-{YYYY-MM-DD}.jsonl  # NDJSON 格式，按日期滚动
    ├── channel/                    # Channel 通信日志
    │   └── channel-{YYYY-MM-DD}.log
    ├── amber/                      # Amber pipeline 日志
    │   └── amber-{YYYY-MM-DD}.log
    └── perf/                       # 性能日志
        └── perf-{YYYY-MM-DD}.log
```

#### 2.2.2 命名规范

| 规则 | 说明 |
|------|------|
| 根目录 | 统一使用 `.logs/`（隐藏目录，与源码同级） |
| 子目录 | 按功能域分层：`app/`、`llm/`、`channel/`、`amber/`、`perf/` |
| 文件名格式 | `{domain}-{YYYY-MM-DD}.{ext}`，扩展名 `.log`（文本）或 `.jsonl`（结构化） |
| 日期格式 | ISO 8601 日期，如 `2026-07-08` |
| 禁止混放 | 严禁将 `.cjs`、`.txt` 验证脚本等非日志文件放入 `.logs/` |

#### 2.2.3 `.gitignore`

```
.logs/
logs/
```

### 2.3 格式要求

#### 2.3.1 通用文本日志格式

每行一条记录，格式如下：

```
{ISO_TIMESTAMP} [{LEVEL}] [{DOMAIN}] {MESSAGE}
```

示例：
```
2026-07-08T14:32:01.123Z [INFO] [channel] 飞书连接已建立，tenant=xxx
2026-07-08T14:32:05.456Z [ERROR] [mcp] MCP 服务启动失败：端口 8080 被占用
2026-07-08T14:32:10.789Z [WARN] [session] 迁移旧会话数据 3 条
```

字段说明：

| 字段 | 格式 | 说明 |
|------|------|------|
| `ISO_TIMESTAMP` | `YYYY-MM-DDTHH:mm:ss.sssZ` | UTC 时间，毫秒精度 |
| `LEVEL` | `INFO` / `WARN` / `ERROR` / `DEBUG` | 统一大写 |
| `DOMAIN` | `app` / `llm` / `channel` / `amber` / `mcp` / `session` / `perf` | 功能域标签 |
| `MESSAGE` | 自由文本 | 关键信息优先，避免打印完整对象 |

#### 2.3.2 LLM 日志格式（NDJSON）

LLM 请求/响应使用 **JSON Lines（NDJSON）** 格式，每行一条完整 JSON 记录：

```jsonl
{"ts":"2026-07-08T14:32:01.123Z","model":"claude-sonnet-4-20250514","request":{"messages":[...],"tools":[...],"temperature":0.7},"response":{"id":"msg_xxx","content":[...],"stop_reason":"end_turn"},"usage":{"prompt_tokens":1234,"completion_tokens":567,"total_tokens":1801},"elapsedMs":2345}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | ISO 8601 | 请求时间戳 |
| `model` | string | 模型标识 |
| `request` | object | 精简后的请求体（prompt、tools、temperature） |
| `response` | object | 精简后的响应体（id、content、stop_reason） |
| `usage` | object | token 用量 |
| `elapsedMs` | number | 请求耗时（毫秒） |

> **设计理由**：NDJSON 比当前每个请求一个独立 JSON 文件更易于工具分析（`jq`、`grep`、Python 逐行解析），且可按日期单文件管理。

#### 2.3.3 日志级别定义

| 级别 | 含义 | 使用场景 |
|------|------|----------|
| `ERROR` | 影响功能的错误，需要人工介入 | MCP 崩溃、LLM 调用失败、数据损坏 |
| `WARN` | 潜在问题或降级行为 | 重连尝试、数据迁移、配额接近上限 |
| `INFO` | 正常业务流程关键节点 | 连接建立、任务完成、工具调用 |
| `DEBUG` | 详细调试信息，仅开发环境启用 | 完整请求/响应体、中间状态 |

#### 2.3.4 敏感信息处理

- **禁止记录**：API Key、用户 Token、个人身份信息（PII）
- **脱敏记录**：Tenant ID 保留前缀 4 位 + `***`（如 `feishu_abcd***`）
- **消息内容**：Channel 消息正文默认不记录，仅记录 metadata（消息 ID、类型、长度）

### 2.4 回收机制

#### 2.4.1 保留策略

| 日志类别 | 保留天数 | 说明 |
|----------|----------|------|
| `app/` 通用应用日志 | 30 天 | 常规排障需要 |
| `app-error/` 错误日志 | 90 天 | 错误追溯周期更长 |
| `llm/` LLM 调用日志 | 7 天（生产）/ 30 天（开发） | 体积大，生产环境快速过期 |
| `channel/` Channel 日志 | 14 天 | 通信问题排查 |
| `amber/` Amber 日志 | 30 天 | Pipeline 审计 |
| `perf/` 性能日志 | 7 天 | 短期性能分析 |

#### 2.4.2 回收实现

日志回收在**应用启动时**执行一次 cleanup 逻辑：

```
启动流程：
1. 扫描 .logs/ 下所有子目录
2. 对每个 .log / .jsonl 文件：
   - 从文件名解析日期
   - 若 当前日期 - 文件日期 > 该类别保留天数 → 删除
3. 若某子目录为空且非标准目录 → 删除该子目录
```

> **不引入第三方依赖**（如 `winston-daily-rotate-file`）。在 `src/utils/logger.ts` 中实现一个轻量版 `rotateAndClean()` 函数，约 40–60 行即可覆盖。

#### 2.4.3 大小限额（补充保护）

作为兜底保护，每个子目录在写入前检查**总大小**：

| 子目录 | 大小上限 |
|--------|----------|
| `llm/` | 512 MB |
| 其他目录 | 128 MB / 每目录 |

超过上限时，删除最旧的文件直至低于上限的 80%。

---

## 三、迁移路线图

### 阶段 1：统一 Logger 基础层（优先级：高）

- [ ] 新建 `src/utils/logger.ts`，提供统一接口：
  ```ts
  export const logger = {
    info(domain: string, message: string, meta?: object): void;
    warn(domain: string, message: string, meta?: object): void;
    error(domain: string, message: string, meta?: object): void;
    debug(domain: string, message: string, meta?: object): void;
  };
  ```
- [ ] 实现按 domain 路由到对应子目录
- [ ] 实现启动时 `rotateAndClean()` 回收逻辑
- [ ] 实现 `DEBUG` 级别仅在 `process.env.NODE_ENV !== 'production'` 时输出

### 阶段 2：迁移现有 Logger（优先级：高）

- [ ] `perfLog()` → 迁移到 `logger.info('perf', ...)` 并合并为按日期滚动
- [ ] `amberLog()` → 迁移到 `logger.info('amber', ...)` / `logger.error('amber', ...)`
- [ ] `channelDebugLog()` → 迁移到 `logger.info('channel', ...)`
- [ ] `createLlmResponseLogger()` → 迁移到 NDJSON 格式写入 `llm/`

### 阶段 3：消除 console.log（优先级：中）

- [ ] `src/channel/channels/feishu/feishu-adapter.ts`（6 处）→ `logger`
- [ ] `src/agent/task-runner.ts`（5 处）→ `logger`
- [ ] `src/channel/channel-service.ts`（4 处）→ `logger`
- [ ] `src/mcp/mcp-client.ts`（4 处）→ `logger`
- [ ] `src/desktop/main/`（3 处 + 2 处 + 1 处）→ `logger`
- [ ] `src/sessions/session-repository.ts`（2 处）→ `logger`
- [ ] `src/agent/turn-indexer.ts`（2 处）→ `logger`
- [ ] `src/agent/loop-runner.ts`（1 处）→ `logger`
- [ ] `src/amber/cli.ts`（7 处）— 保留 CLI 交互的 `console.log`，移除双写

### 阶段 4：清理历史日志（优先级：低）

- [ ] 执行一次性脚本清理现有 `logs/` 目录（328 MB）
- [ ] 删除 `.logs/` 中的非日志文件（`verify.cjs`、`amber-verify-hex.txt` 等）

---

## 四、附录

### A. 当前 `console.log` 完整列表

| # | 文件 | 行号 | 内容摘要 |
|---|------|------|----------|
| 1 | `src/amber/cli.ts` | 227 | 启动信息 |
| 2 | `src/amber/cli.ts` | 230 | 模型配置 |
| 3 | `src/amber/cli.ts` | 234 | Amber 目录 |
| 4 | `src/amber/cli.ts` | 237 | 工具数量 |
| 5 | `src/amber/cli.ts` | 269 | info 双写 |
| 6 | `src/amber/cli.ts` | 270 | error 双写 |
| 7 | `src/amber/cli.ts` | — | 其他 |
| 8 | `src/channel/channels/feishu/feishu-adapter.ts` | 104 | 消息事件 |
| 9 | `src/channel/channels/feishu/feishu-adapter.ts` | 132 | 消息事件 |
| 10-13 | `src/channel/channels/feishu/feishu-adapter.ts` | — | 连接日志 |
| 14-17 | `src/channel/channel-service.ts` | — | 启动/错误 |
| 18-22 | `src/agent/task-runner.ts` | 230,897,900,903 | Context dump / 审批 |
| 23-26 | `src/mcp/mcp-client.ts` | — | 初始化错误 |
| 27-29 | `src/desktop/main/loop-job-manager.ts` | — | loop job 错误 |
| 30-31 | `src/desktop/main/main.ts` | — | MCP 启动失败 |
| 32-33 | `src/sessions/session-repository.ts` | — | 迁移告警 |
| 34-35 | `src/agent/turn-indexer.ts` | 81,84 | 索引边界 |
| 36 | `src/agent/loop-runner.ts` | 206 | 循环溢出 |
| 37 | `src/desktop/main/ipc.ts` | — | 未处理错误 |
