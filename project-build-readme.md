## 构建项目

```bash
npm run build
```
需提前安装typescript：
npm install typescript
npx tsc
如果事先误装了tsc，要先执行：
npm uninstal tsc
再重新安装typescript并编译

构建产物输出到 `dist/`。

## 发布 Windows 可执行文件

当前仓库内置了一个 Windows 发布脚本，会产出一个便携版目录，目录中包含可直接启动的 `Pueblo.exe`。

完整发布流程：

```powershell
npm run release:win
```

如果你已经执行过 `npm run build`，只想基于当前构建产物重新组装可执行目录：

```powershell
npm run package:win
```

发布输出目录：

- `release/Pueblo-win32-x64/Pueblo.exe`

说明：

- 这是一种便携版发布方式，不是安装器。
- 发布脚本会先构建主进程和 renderer，再重建 `better-sqlite3` 的 Electron 原生依赖，然后组装 Electron runtime。
- 发布目录同级会保留 `package.json` 和 `puebl-profile/`，以兼容当前桌面端基于相对路径的模板与配置查找逻辑。

如果你只是本地开发桌面版本，而不是发布，也建议在启动桌面前先执行一次：

```bash
npm run rebuild:electron-native
```

如果在新机器上执行 `npm run build` 时看到 `tsc` 不是内部或外部命令，通常不是脚本错误，而是 `typescript` 这个本地开发依赖没有安装成功。当前构建脚本会执行 `package.json` 中的 `build:main = tsc -p tsconfig.json`，因此需要确保 `node_modules/.bin/tsc` 存在。

常见原因：

- 只下载了源码，但还没有执行 `npm install`
- 使用了 `npm install --omit=dev` 或 `npm ci --omit=dev`
- 环境变量 `NODE_ENV=production` 导致 devDependencies 被跳过
- npm 配置把 `dev` 依赖默认省略了

推荐排查顺序：

```bash
npm install
npx tsc -v
npm run build
```

如果仍然失败，再检查 npm 是否跳过了开发依赖：

```bash
npm config get omit
npm config get production
```

在 PowerShell 中还可以检查：

```powershell
echo $env:NODE_ENV
```

如果之前做过精简安装，最稳妥的恢复方式是删除依赖后重新安装：

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
npm install
npm run build
```

## 运行测试

```bash
npm test
```

## 启动方式

默认桌面对话框启动：

```bash
node dist/cli/index.js
```

启动后当前终端流程会移交给新的桌面对话框窗口。新窗口包含独立输出区和输入区，输入区沿用 `pueblo>` 标签，输出区用于展示 `outputSummary`、工具调用结果以及折叠后的 `Model Output` 元数据。

如果你需要执行一次性命令：

```bash
node dist/cli/index.js "/help"


桌面对话框中可直接输入：

- `/new my-session`
- `/auth-login`
- `/help`
- `/model github-copilot copilot-chat`
- `/task-run inspect workflow`
- 普通文本任务，例如 `inspect workflow`

或者先构建后通过 bin 入口运行：

```bash
npm run build
node dist/src/cli/index.js "/ping"
```

说明：`package.json` 中的 `dev` 脚本当前实际运行的是构建产物；最稳妥的方式仍然是先执行 `npm run build`，再运行 `dist/cli/index.js`。

说明：稳定 CLI 入口是 `dist/cli/index.js`。它会转发到实际实现 `dist/src/cli/index.js`，因此两者现在都可运行，但优先使用前者。

说明：如果 `desktopWindow.enabled` 设为 `false`，无参数启动会退回到终端交互模式。终端模式同样支持 `/help`、`/auth-login`、slash command 和普通文本任务，并可通过 `/exit` 或 `/quit` 退出。
