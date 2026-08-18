# finance-news MCP — 通用金融资讯检索

将国外（Finnhub 个股新闻）与国内（新浪财经 / 东方财富快讯）金融资讯检索能力封装为
**MCP stdio 工具**，供任意指向本仓库的终端（Pueblo / Claude Code 等）调用。

## 目录结构

```
mcp/finance-news/
├── finance_news.py             # 核心检索脚本（Finnhub + 新浪 + 东财）
├── finance-news-bridge.mjs     # MCP stdio 桥接层（暴露 fetch_finance_news 工具）
├── smoke-test.mjs              # 冒烟测试（node smoke-test.mjs）
├── .env                        # Finnhub API Key（FINNHUB_API_KEY=...）
└── .env.example                # 模板 + 注册地址说明
```

## 注册位置

已注册于仓库级配置 `.pueblo/mcp-servers.json`（服务 id: `finance-news`）。
任何使用该仓库目录的终端都会自动加载此 MCP 服务，无需重复注册。

## 工具参数（fetch_finance_news）

| 参数 | 类型 | 说明 |
|---|---|---|
| `ticker` | string | 美股代码，仅国外源生效，默认 `AAPL` |
| `region` | string | `us`=国外 Finnhub；`cn`=国内新浪+东财；`all`=全部 |
| `query` | string | 关键词过滤，仅国内源生效（如：银行 / 新能源） |
| `num` | integer | 每个源输出条数，默认 10 |
| `days` | integer | 国外源回溯天数，默认 7 |

> 注意：国内关键词过滤作用于当前快照窗口，若某时刻滚动新闻中恰好无匹配词条，返回为空属正常现象，可换词或去掉 `query` 再试。

## 命令行直接使用

```
python mcp/finance-news/finance_news.py AAPL --num 10          # 国外个股新闻
python mcp/finance-news/finance_news.py --region cn --query 汽车   # 国内关键词
python mcp/finance-news/finance_news.py --region all --num 5      # 国内外一起
```

## 环境要求与排障

- Python 3.9+（需在 PATH 中；桥接层会自动尝试 `python` / `py` / `python3`）。
- Node.js（用于运行桥接层；`.pueblo/mcp-servers.json` 中 `command: "node"` 走 PATH 解析）。
- Finnhub 免费版限流 60 次/分钟；报 `401/403` 表示 Key 失效或限流，检查 `mcp/finance-news/.env`。
- 若 MCP 服务启动失败，多半是 Node 不在 PATH 中，把 `command` 改为 node 绝对路径（如
  `D:\\Program Files\\nodejs\\node.exe`）即可。
- 国内双源互为备份，一个挂了自动切另一个。

## 验证

```
node mcp/finance-news/smoke-test.mjs
```
