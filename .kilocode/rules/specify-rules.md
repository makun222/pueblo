# pueblo Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-15

## Active Technologies
- TypeScript 5.x on Node.js 22 LTS + `commander`、provider SDK/HTTP clients、`zod`、`better-sqlite3`、文件系统与进程执行库 (master)
- SQLite 本地数据库（session、memory、prompt、agent task、tool invocation、command action），文件系统用于配置和非结构化附件 (master)
- TypeScript 5.x on Node.js 22 LTS + `electron`, `react`, `react-dom`, `commander`, `zod`, `better-sqlite3`, `node:readline`, Electron IPC, 文件系统与进程执行库 (master)
- SQLite 本地数据库（session、memory、prompt、agent task、tool invocation、command action），文件系统用于配置、桌面壳资源与非结构化附件 (master)
- TypeScript 5.x on Node.js 22 LTS + `electron`, `react`, `react-dom`, `vite`, `commander`, `zod`, `better-sqlite3`, `node:readline`, fetch-based GitHub Copilot integration layer, Electron IPC (master)
- SQLite 本地数据库（session、memory、prompt、agent task、tool invocation、command action），文件系统用于本地配置、桌面壳资源和非结构化附件；敏感凭据默认来自本地配置或环境变量，不直接明文落入业务表 (master)

- TypeScript 5.x on Node.js 22 LTS + `commander` 或同类 CLI 框架、provider SDK/HTTP clients、`zod`、文件系统与进程执行库 (master)

## Project Structure

```text
src/
tests/
```

## Commands

npm test; npm run lint

## Code Style

TypeScript 5.x on Node.js 22 LTS: Follow standard conventions

## Recent Changes
- master: Added TypeScript 5.x on Node.js 22 LTS + `electron`, `react`, `react-dom`, `vite`, `commander`, `zod`, `better-sqlite3`, `node:readline`, fetch-based GitHub Copilot integration layer, Electron IPC
- master: Added TypeScript 5.x on Node.js 22 LTS + `electron`, `react`, `react-dom`, `commander`, `zod`, `better-sqlite3`, `node:readline`, Electron IPC, 文件系统与进程执行库
- master: Added TypeScript 5.x on Node.js 22 LTS + `commander`、provider SDK/HTTP clients、`zod`、`better-sqlite3`、文件系统与进程执行库


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
