# MCP Manager 升级方案 — 细化实施文档

> **文档版本**: v2.0 (细化版)  
> **最后更新**: 2026-06-18  
> **分支策略**: Phase 1 → Phase 2 → Phase 3

---

## 总览

本文档基于 MCP Manager 现状诊断的三个根本问题，对每个 Phase 给出精确的**文件位置、行号、修改内容和验证方法**。

---

## Phase 1：修复 MCP 上下文注入（功能核心）

### 问题根因

`ToolService` 构造函数接受 `mcpClientManager?: McpClientManager` 参数，但所有调用点均未传入。导致 `tool-service.ts` 中的 `buildToolDefinition()` (line 123-135) 和 `executeTool()` (line 334-356) 中 `mcpClientManager` 始终为 `undefined`，因此：
- MCP tools **从未**出现在 LLM 的 tool list 中
- LLM 调用 MCP tool 时抛出错误：`MCP client manager is not available`

### 调用链断裂图（已修正）

```
CLI 路径:
  cli/index.ts:359 → createCliDependencies(config, {...})             ❌ 无 mcpClientManager
      cli/index.ts:394-400 → new ToolService({...})                  ❌ 无 mcpClientManager
      cli/index.ts:417     → new AgentTaskRunner(..., toolService)   ← MCP 工具缺失

Desktop 路径:
  main.ts:51  → mcpClient = new McpClientManager()         ✅ 已创建(零参构造器)
  main.ts:74  → setupIpcHandlers(☐ mcpClient)              ❌ mcpClient 未传入
      ipc.ts:67  → createCliDependencies(☐)                 ❌ 无 mcpClientManager
          cli/index.ts:394-400 → new ToolService(☐)        ❌ 无 mcpClientManager
          cli/index.ts:417     → new AgentTaskRunner(...)   ← MCP 工具缺失
      ipc.ts:413 → cli.getTaskRunner()                       ← MCP 工具缺失

关键发现: 两条路径通过同一函数 createCliDependencies() 构建工具链 ← 唯一注入点
```

### 代码现状核查（2026-06-21）

**已确认的代码事实**：
- `McpClientManager` 构造器**零参数**（`src/mcp/mcp-client.ts:37-39`），通过 `initialize()` 加载配置
- `ToolService` **已支持** `mcpClientManager` 可选参数（`src/tools/tool-service.ts:47`）
- Desktop 已在 `main.ts:50-56` 创建 `McpClientManager` 并调用 `initialize()`，但**未向下传递**
- **两条路径通过同一函数 `createCliDependencies()` 构建工具链**——唯一注入点
- **不存在 `new AgentTaskRunner` 在 `loop-job-manager.ts`** — Desktop 通过 `cli.getTaskRunner()` 获取

### 修改方案（单点注入，3 文件，~10 行）

**策略**：在 `CreateCliDependenciesOptions` 中新增 `mcpClientManager` 字段，`createCliDependencies()` 内部将其传递给 `ToolService`。

#### 1.1 `src/cli/index.ts` — 核心注入点
**修改点 ①** — `CreateCliDependenciesOptions` 接口（line ~189），新增字段：
```diff
  export interface CreateCliDependenciesOptions {
      startNewSession?: boolean;
      deferAgentSelection?: boolean;
+     mcpClientManager?: McpClientManager;
  }
```

**修改点 ②** — `ToolService` 构造（lines 394-400），传入 `mcpClientManager`：
```diff
  const toolService = new ToolService({
      serializationService,
      workspaceDir: cwd ?? process.cwd(),
      toolCallbacks: resolveEditReviewHandler ? {
          onEditReview: resolveEditReviewHandler,
      } : undefined,
+     mcpClientManager: options.mcpClientManager,
  });
```

**无需修改** `AgentTaskRunner` 构造（line 417）— `toolService` 已自动含 MCP 工具。

#### 1.2 `src/desktop/main/ipc.ts` — Desktop 传递 mcpClientManager

**修改点 ③** — `setupIpcHandlers` 签名（line 60），新增第4参数：
```diff
- export function setupIpcHandlers(mainWindow: BrowserWindow, loopJobManager: DesktopLoopJobManager, appWindow?: AppWindow): () => void {
+ export function setupIpcHandlers(mainWindow: BrowserWindow, loopJobManager: DesktopLoopJobManager, appWindow?: AppWindow, mcpClientManager?: McpClientManager): () => void {
```

**修改点 ④** — `createCliDependencies` 调用（line 67），传入 `mcpClientManager`：
```diff
-     const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true });
+     const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true, mcpClientManager });
```

#### 1.3 `src/desktop/main/main.ts` — 传入已创建的 mcpClient

**修改点 ⑤** — `setupIpcHandlers` 调用（line 74），传入 `mcpClient`：
```diff
-     disposeDesktopRuntime = setupIpcHandlers(mainWindow, loopJobManager, appWindow);
+     disposeDesktopRuntime = setupIpcHandlers(mainWindow, loopJobManager, appWindow, mcpClient);
```

#### 1.4 验证检查清单

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | Desktop: `cli.getTaskRunner()` 使用的 `toolService` 含 `mcpClientManager` | 在 `ToolService.buildToolDefinition()` 加日志确认非空 |
| 2 | CLI: `createCliDependencies()` 传入 `mcpClientManager` 后 `ToolService.describeTools()` 返回 `mcp__*` 工具 | 启动 CLI 并添加 MCP server，运行 `/loop` 查看 tool list |
| 3 | 不加 MCP server 时，行为不变 | `mcpClientManager` 为 `undefined` 时 `ToolService` 行为与当前一致 |
| 4 | LLM 能发现并调用 MCP tools | 对话中 LLM 选择 `mcp__*` 工具并成功返回结果 |

### 涉及文件清单 (Phase 1)

| 文件 | 行号 | 变更 |
|------|------|------|
| `src/cli/index.ts` | ~189, 394-400 | 接口+1字段，构造+1参数 |
| `src/desktop/main/ipc.ts` | 60, 67 | 签名+1参数，调用+1参数 |
| `src/desktop/main/main.ts` | 74 | 调用+1参数 |

---

## Phase 2：最小化 UI 样式（视觉可用）

### 问题根因

- `mcp-manager/index.tsx` 使用了 `mcp-manager-overlay`、`mcp-manager-dialog`、`mcp-manager-server-list` 等大量类名
- `mcp-manager.html` 无任何 `<link>` 或 `<style>` 标签
- 整个项目无 `.mcp-manager` CSS 定义

### 实施步骤

#### 2.1 创建 `mcp-manager.css`

**新文件**: `src/desktop/renderer/mcp-manager/mcp-manager.css`

需要包含以下基础样式（使用项目中已有的 class 名）：

```css
/* ===== Overlay ===== */
.mcp-manager-overlay {
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
}

/* ===== Dialog ===== */
.mcp-manager-dialog {
    background: #1e1e2e;
    border: 1px solid #3b3b5c;
    border-radius: 12px;
    padding: 24px;
    max-width: 720px;
    width: 90%;
    max-height: 85vh;
    overflow-y: auto;
    color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}

/* ===== Header & Close ===== */
.mcp-manager-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 1px solid #313244;
}
.mcp-manager-header h2 {
    margin: 0;
    font-size: 1.25rem;
    color: #cdd6f4;
}
.mcp-manager-close {
    background: none;
    border: none;
    color: #6c7086;
    font-size: 1.3rem;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
}
.mcp-manager-close:hover {
    color: #cdd6f4;
    background: rgba(255,255,255,0.08);
}

/* ===== Body & Sections ===== */
.mcp-manager-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.mcp-manager-section {
    background: #181825;
    border: 1px solid #313244;
    border-radius: 8px;
    padding: 14px;
}
.mcp-manager-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 0.85rem;
    color: #a6adc8;
}

/* ===== Section Add Button ===== */
.mcp-manager-add-btn {
    padding: 4px 10px;
    font-size: 0.75rem;
    background: #45475a;
    color: #cdd6f4;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
}
.mcp-manager-add-btn:hover { background: #585b70; }

/* ===== Empty State ===== */
.mcp-manager-empty {
    padding: 20px;
    text-align: center;
    color: #6c7086;
    font-size: 0.85rem;
}

/* ===== Server List (Card Layout) ===== */
.mcp-manager-server-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 260px;
    overflow-y: auto;
}
.mcp-manager-server-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    background: #1e1e2e;
    border: 1px solid #313244;
    border-radius: 6px;
    transition: border-color 0.15s;
}
.mcp-manager-server-item:hover {
    border-color: #45475a;
}

/* Server Info (name + command) */
.mcp-manager-server-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
}
.mcp-manager-server-name {
    font-size: 0.9rem;
    font-weight: 500;
    color: #cdd6f4;
}
.mcp-manager-server-command {
    font-size: 0.75rem;
    color: #6c7086;
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Server Status */
.mcp-manager-server-status {
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 10px;
    margin: 0 12px;
    white-space: nowrap;
}
.mcp-manager-server-status.connected {
    background: rgba(166, 227, 161, 0.12);
    color: #a6e3a1;
}
.mcp-manager-server-status.disconnected {
    background: rgba(108, 112, 134, 0.12);
    color: #6c7086;
}

/* Server Actions (Edit/Delete/Test buttons) */
.mcp-manager-server-actions {
    display: flex;
    gap: 6px;
    align-items: center;
}

/* ===== Buttons (6 variants) ===== */
.mcp-manager-btn {
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    white-space: nowrap;
}
.mcp-manager-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

/* Primary (add/save) */
.mcp-manager-btn-save {
    background: #89b4fa;
    color: #1e1e2e;
}
.mcp-manager-btn-save:hover:not(:disabled) { background: #74c7ec; }

/* Test connection */
.mcp-manager-btn-test {
    background: #45475a;
    color: #cdd6f4;
}
.mcp-manager-btn-test:hover:not(:disabled) { background: #585b70; }

/* Edit */
.mcp-manager-btn-edit {
    background: #45475a;
    color: #cdd6f4;
}
.mcp-manager-btn-edit:hover:not(:disabled) { background: #585b70; }

/* Delete */
.mcp-manager-btn-delete {
    background: transparent;
    color: #f38ba8;
    border: 1px solid #f38ba8;
}
.mcp-manager-btn-delete:hover:not(:disabled) {
    background: rgba(243, 139, 168, 0.12);
}

/* Cancel */
.mcp-manager-btn-cancel {
    background: #313244;
    color: #cdd6f4;
}
.mcp-manager-btn-cancel:hover:not(:disabled) { background: #45475a; }

/* ===== Form ===== */
.mcp-manager-form-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.mcp-manager-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.mcp-manager-field label {
    font-size: 0.78rem;
    color: #a6adc8;
}
.mcp-manager-field input,
.mcp-manager-field select,
.mcp-manager-field textarea {
    width: 100%;
    padding: 8px 10px;
    background: #1e1e2e;
    border: 1px solid #313244;
    border-radius: 6px;
    color: #cdd6f4;
    font-size: 0.85rem;
    box-sizing: border-box;
    font-family: inherit;
}
.mcp-manager-field input:focus,
.mcp-manager-field select:focus,
.mcp-manager-field textarea:focus {
    border-color: #89b4fa;
    outline: none;
}

/* Input Error */
.mcp-manager-input-error {
    border-color: #f38ba8 !important;
}

/* ===== Error & Info Messages ===== */
.mcp-manager-error-msg {
    font-size: 0.78rem;
    color: #f38ba8;
    margin-top: 2px;
}
.mcp-manager-info-msg {
    font-size: 0.78rem;
    color: #a6adc8;
    margin-top: 2px;
}

/* ===== Test Result Panel ===== */
.mcp-manager-test-result {
    margin-top: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 0.83rem;
}
.mcp-manager-test-result.success {
    background: rgba(166, 227, 161, 0.1);
    border: 1px solid #a6e3a1;
    color: #a6e3a1;
}
.mcp-manager-test-result.error {
    background: rgba(243, 139, 168, 0.1);
    border: 1px solid #f38ba8;
    color: #f38ba8;
}

/* ===== Form Actions Row ===== */
.mcp-manager-form-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
}
.mcp-manager-form-actions.mcp-manager-btn-save { /* specificity bump */ }

/* ===== Example Section ===== */
.mcp-manager-example-section {
    margin-top: 6px;
}
.mcp-manager-example-toggle {
    background: none;
    border: none;
    color: #89b4fa;
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
}
.mcp-manager-example-toggle:hover {
    color: #74c7ec;
}
.mcp-manager-example-content {
    margin-top: 8px;
    padding: 10px;
    background: #11111b;
    border: 1px solid #313244;
    border-radius: 6px;
    font-size: 0.78rem;
    color: #a6adc8;
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    white-space: pre-wrap;
    max-height: 180px;
    overflow-y: auto;
}

/* ===== Loading Spinner ===== */
.mcp-loading-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #45475a;
    border-top-color: #89b4fa;
    border-radius: 50%;
    animation: mcp-spin 0.6s linear infinite;
    margin-right: 6px;
    vertical-align: middle;
}
@keyframes mcp-spin {
    to { transform: rotate(360deg); }
}
```

#### 2.2 引入 CSS

**修改文件**: `src/desktop/renderer/mcp-manager.html` (在 `</head>` 之前)

```html
<link rel="stylesheet" href="./mcp-manager/mcp-manager.css" />
```

### 涉及文件清单 (Phase 2)

| 文件 | 改动类型 |
|------|----------|
| `src/desktop/renderer/mcp-manager/mcp-manager.css` | **新建** ~120 行 |
| `src/desktop/renderer/mcp-manager.html` | 添加 1 行 `<link>` |

---

## Phase 3：系统性测试与 UX 改进

### 3.1 Test 按钮 loading 状态

**文件**: `src/desktop/renderer/mcp-manager/index.tsx`

**修改点 1**：添加 `connectingIndex` 状态

在 state 声明区域（约 line 30-50），添加：
```typescript
const [connectingIndex, setConnectingIndex] = useState<number | null>(null);
```

**修改点 2**：`handleTestConnection` 方法（约 line 150-180）

在函数起始设置 loading，finish 后清除：
```diff
  async function handleTestConnection(config: McpServerConfig, index: number) {
+     setConnectingIndex(index);
      setTestResult(null);
      try {
          const result = await window.electronAPI.mcpTestConnection(config);
          setTestResult(result);
+     } finally {
+         setConnectingIndex(null);
+     }
  }
```

**修改点 3**：Test 按钮渲染（约 line 280-300，server 行内按钮区域）

```tsx
<button
    className="mcp-manager-btn mcp-manager-btn-secondary"
    onClick={() => handleTestConnection(server, index)}
    disabled={connectingIndex !== null}
>
    {connectingIndex === index ? (
        <><span className="mcp-loading-spinner"></span> Testing...</>
    ) : 'Test'}
</button>
```

### 3.2 连接超时提示

**文件**: `src/desktop/renderer/mcp-manager/index.tsx`

在 `handleTestConnection` 中添加超时处理：
```typescript
const TIMEOUT_MS = 15000;
async function handleTestConnection(config: McpServerConfig, index: number) {
    setConnectingIndex(index);
    setTestResult(null);
    try {
        const result = await Promise.race([
            window.electronAPI.mcpTestConnection(config),
            new Promise<McpTestResult>((_, reject) =>
                setTimeout(() => reject(new Error('Connection timed out after 15s')), TIMEOUT_MS)
            ),
        ]);
        setTestResult(result);
    } catch (err: any) {
        setTestResult({ success: false, toolCount: 0, error: err.message });
    } finally {
        setConnectingIndex(null);
    }
}
```

### 3.3 Test 结果醒目化

**现状**: `testResult` 渲染在无样式的 div 中，不可见。

**修改**: 在 Index 组件的主渲染中（约 line 340-360，server 列表下方），替换简单 div：
```tsx
{testResult && (
    <div className={`mcp-test-result ${testResult.success ? 'success' : 'failure'}`}>
        {testResult.success
            ? `✅ Connection successful — ${testResult.toolCount} tool(s) discovered`
            : `❌ Connection failed — ${testResult.error || 'Unknown error'}`
        }
    </div>
)}
```

### 3.4 Server 列表刷新按钮

在 toolbar 区域添加刷新按钮（Add Server 按钮旁边，约 line 250-260）：
```tsx
<button
    className="mcp-manager-btn mcp-manager-btn-secondary"
    onClick={() => loadServers()}
>
    ↻ Refresh
</button>
```

（注意：`loadServers` 函数已存在，它从本地存储重新加载 server 列表）

### 涉及文件清单 (Phase 3)

| 文件 | 改动类型 |
|------|----------|
| `src/desktop/renderer/mcp-manager/index.tsx` | ~30 行增量修改 |

---

## 执行顺序与预算

| Phase | 优先级 | 预估改动量 | 预估步骤数 | 依赖 |
|-------|--------|-----------|-----------|------|
| **Phase 1** | 🔴 P0 | ~25 行 | 15-20 steps | 无 |
| **Phase 2** | 🟡 P1 | ~125 行 (新文件) | 5-8 steps | 无 |
| **Phase 3** | 🟢 P2 | ~30 行 | 8-12 steps | Phase 1 完成（有连接才能测试） |

**建议**: 本轮完成 Phase 1 + Phase 2（合计 ~150 行改动，约 25-30 步）。Phase 3 留待下一轮。

---

## 风险与回滚

| Phase | 风险项 | 回滚方式 |
|-------|--------|----------|
| Phase 1 | `McpClientManager` 构造失败影响主流程 | `mcpClientManager` 为可选参数，失败时抛异常可被 catch 吞掉，不影响基础 tool |
| Phase 1 | Desktop 路径 toolService 创建慢影响首次对话 | 懒加载 + 缓存 `_autoToolService` |
| Phase 2 | CSS 样式与现有 Dark 主题冲突 | 所有选择器以 `.mcp-manager-` 前缀隔离 |
| Phase 3 | loading 状态管理 bug | `connectingIndex` 为局部状态，不影响其他功能 |

---

## 附录：关键文件路径速查

```
src/
├── cli/
│   └── index.ts                    ← Phase 1 CLI 修改
├── agent/
│   ├── loop-job-manager.ts         ← Phase 1 Desktop 修改 (auto-create ToolService)
│   └── task-runner.ts              ← ToolService 消费方（无需修改）
├── tools/
│   └── tool-service.ts             ← MCP buildToolDefinition + executeTool
├── mcp/
│   ├── mcp-client.ts               ← McpClientManager 导出
│   ├── mcp-client-manager.ts       ← McpClientManager 类定义
│   └── mcp-connection.ts           ← 连接管理
├── desktop/
│   ├── main/
│   │   ├── main.ts                 ← McpClientManager 创建 + IPC 注册
│   │   └── loop-job-manager.ts     ← DesktopLoopJobManager
│   └── renderer/
│       ├── mcp-manager.html        ← Phase 2 添加 <link>
│       ├── mcp-manager-main.tsx    ← 入口（无需修改）
│       └── mcp-manager/
│           ├── index.tsx           ← Phase 3 修改
│           └── mcp-manager.css     ← Phase 2 新建
```


---

## MCP Manager 现状诊断

通过审查全部关联代码（11 个 MCP 模块 + 前端 + IPC 层 + ToolService + CLI/Desktop
启动路径），我发现三个根本问题：

---

### 问题 1：UI 无样式 — CSS 文件缺失

**证据：** `mcp-manager/index.tsx` 使用 `mcp-manager-overlay`、`mcp-manager-dialog`
等类名，但 `mcp-manager.html` 未引入任何 CSS 文件。整个项目搜索不到任何 `.mcp-manager` CSS
定义。UI 是完全裸露的 HTML 控件。

| 文件 | 问题 |
|---|---|
| `mcp-manager.html` | 仅有基础 meta + `<div id="root">`，无 `<link>` 或 `<style>` |
| `mcp-manager-main.tsx` | 仅 `createRoot` 渲染，无样式导入 |
| `index.tsx` | 使用了大量 class 名，但无 CSS |

---

### 问题 2：Test 按钮无反馈 — 非功能性 Bug，而是 UX 反馈缺失

**分析结果：Test 按钮实际上能工作**。IPC 链路完整：

```
前端 handleTestConnection → preload mcpTestConnection → 
IPC 'mcp:test-connection' → client.testConnection() → 
返回 {success, toolCount, error} → 前端 setTestResult()
```

但 **问题在于**：
1. `testResult` 状态渲染在一个**可能被 CSS 隐藏**的 `<div>` 中（无样式 = 文本淹没在混乱布局中）
2. 无 loading 状态指示器（用户点击后无即时光标反馈）
3. 异常处理没有耗时提示（MCP 连接失败可能需 5-10 秒超时，无进度条）

---

### 问题 3：MCP Server 未注入 LLM 上下文 — **根本性功能断裂**

这是最严重的问题。调用链分析：

| 层级 | 文件 | 状态 |
|---|---|---|
| MCP Server 管理 | `main.ts:51-73` | ✅ 创建 `McpClientManager`，注册 IPC，启动 servers |
| ToolService 实例化 | `cli/index.ts:394` | ❌ **`mcpClientManager` 未传入** |
| Desktop ToolService | `src/desktop/main/main.ts` | ❌ **从未创建 ToolService** |
| MCP 工具合并 | `tool-service.ts:123-135` | ❌ `mcpClientManager` 为 `undefined`，`buildToolDefinition()` 返回 `false` |
| MCP 工具执行 | `tool-service.ts:334-356` | ❌ `mcpClientManager` 为 `undefined`，走到 `else` 抛出错误 |

**结论：MCP tools 从未出现在 LLM 的 tool list 中，LLM 完全不知道有 MCP 工具存在。**这是为什么"目前还没成功一例"的原因。

---

## 优化方案

我建议按以下优先级执行：

### Phase 1：修复 MCP 上下文注入（功能核心）

**1.1 CLI 路径：** `src/cli/index.ts:394` — 传入 `mcpClientManager`

```typescript
// 需要从某处获取 mcpClientManager 实例，可能来自 mcp-client.ts 导出的单例
import { mcpClientManager } from '../mcp/mcp-client';
// ...
const toolService = new ToolService({
    serializationService,
    workspaceDir: workspaceRoot,
    toolCallbacks,
    mcpClientManager,  // ← 注入
});
```

**1.2 Desktop 路径：** `src/desktop/main/main.ts:51` — 将 `mcpClient` 实例传递给 agent
loop 的 ToolService 构造链。

**1.3 验证：** 确认 `mcpClientManager.loadServers(servers)` 被调用后 server 实际已连接
— 需要检查 `mcp-connection.ts` 的 transport 初始化是否 work。

---

### Phase 2：最小化 UI 样式（视觉可用）

**2.1 创建 `mcp-manager.css`** 包含基本的 overlay/dialog/form/table/button 样式：
- Modal overlay + dialog 居中布局
- Server 列表表格化
- 表单控件排列
- 测试结果面板可见化
- 连接状态颜色指示（绿=connected，红=disconnected，黄=error）

**2.2 在 `mcp-manager.html` 中引入 CSS。**

---

### Phase 3：系统性测试与 UX 改进

| # | 改进项 | 类型 |
|---|---|---|
| 3.1 | Test 按钮 loading 状态 | UX |
| 3.2 | 连接超时提示（当前 MCP 连接可能卡死无反馈） | 功能 |
| 3.3 | Test 结果显示更醒目（成功/失败视觉区分） | UX |
| 3.4 | Server 列表刷新按钮 | UX |
| 3.5 | 工具发现数量展示 | 信息 |

---

## 建议执行顺序

1. **先修 Phase 1**（MCP 注入）— 这是功能性前提，没有它 MCP 毫无意义
2. **再修 Phase 2**（CSS 最小化）— 让界面可用，便于调试和验证
3. **Phase 3** 作为增量优化

---

是否希望我立即开始执行 Phase 1？需要我先做更细致的 `mcpClientManager` 实例传递路径分析（确认
Desktop 端的 ToolService 构造位置）再动手。