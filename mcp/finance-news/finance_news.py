#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
finance_news.py — 通用金融信息检索工具
=========================================
国外源: Finnhub company-news API   (需要免费 Key, 填在仓库根目录 .env)
国内源: 新浪财经滚动新闻 + 东方财富快讯 (免费, 无需 Key)

用法示例
--------
  python finance_news.py AAPL                  # 国外: Finnhub 查 AAPL 新闻
  python finance_news.py --region cn           # 国内: 新浪+东财 滚动快讯
  python finance_news.py --region cn --query 央行   # 国内: 按关键词过滤
  python finance_news.py --region all          # 国内外一起
  python finance_news.py --sources sina        # 只用一个源
  python finance_news.py --region cn --save news.csv  # 存 CSV
  python finance_news.py --num 10 --region cn  # 控制条数

配置
----
  复制 .env.example 为 .env, 填入:
      FINNHUB_API_KEY=你的Finnhub免费Key
  脚本依次查找: 系统环境变量 -> 仓库根目录 .env -> 交互输入
"""
import argparse
import csv
import datetime as dt
import io
import os
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("缺少依赖: 请先运行  pip install requests")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(BASE_DIR, ".env")

# ---------------------------------------------------------------------------
# 1. 轻量 .env 加载器 (零依赖; 不覆盖已存在的系统环境变量)
# ---------------------------------------------------------------------------
def load_dotenv(path=ENV_FILE):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:  # 已有环境变量优先
                os.environ[key] = val

# ---------------------------------------------------------------------------
# 2. 数据源定义 (统一返回 {headline, summary, url, source, datetime})
# ---------------------------------------------------------------------------
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

def fetch_finnhub(ticker, days=7, limit=None):
    """国外源: Finnhub company-news (免费版 60 calls/min, 一次取当天+近N天)"""
    api_key = os.environ.get("FINNHUB_API_KEY", "").strip()
    if not api_key:
        return None, (
            "未找到 Finnhub API Key。\n"
            "  1) 在 mcp/finance-news/.env 文件中填写:  FINNHUB_API_KEY=你的Key\n"
            "      (参考同目录 .env.example, 注册: https://finnhub.io/register)\n"
            "  2) 或设置系统环境变量 FINNHUB_API_KEY 后重试"
        )
    to_date = dt.date.today()
    from_date = to_date - dt.timedelta(days=days)
    url = ("https://finnhub.io/api/v1/company-news"
           f"?symbol={ticker}&from={from_date:%Y-%m-%d}&to={to_date:%Y-%m-%d}&token={api_key}")
    r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    items = r.json()
    if not isinstance(items, list):
        return [], None
    rows = []
    for it in items:
        ts = it.get("datetime")
        dtime = (dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
                 if ts else "")
        rows.append({
            "headline": it.get("headline", ""),
            "summary": (it.get("summary") or "").strip(),
            "url": it.get("url", ""),
            "source": f"Finnhub/{ticker}",
            "datetime": dtime,
        })
    return rows[:limit] if limit else rows, None

def fetch_sina(num=50, limit=None):
    """国内源1: 新浪财经滚动新闻 (免费无Key, lid=2516 财经滚动)"""
    url = ("https://feed.mix.sina.com.cn/api/roll/get"
           f"?pageid=153&lid=2516&k=&num={min(num, 50)}&page=1")
    r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    data = r.json().get("result", {}).get("data") or []
    rows = []
    for it in data:
        ctime = it.get("ctime")
        dtime = (dt.datetime.fromtimestamp(int(ctime)).strftime("%Y-%m-%d %H:%M:%S")
                 if ctime else "")
        rows.append({
            "headline": it.get("title", ""),
            "summary": (it.get("intro") or "").strip(),
            "url": it.get("url", ""),
            "source": "新浪财经",
            "datetime": dtime,
        })
    return rows[:limit] if limit else rows, None

def fetch_eastmoney(num=50, limit=None):
    """国内源2: 东方财富全球快讯 (免费无Key, 老版接口含原文链接)"""
    n = min(num, 50)
    url = f"https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_{n}_1_.html"
    r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"  # 该接口编码探测
    text = r.text.strip()
    # 剥掉 JS 包裹: var ajaxResult={...};
    if text.startswith("var"):
        text = text[text.find("=") + 1:].strip().rstrip(";")
    data = json_loads(text)
    rows = []
    for it in (data or {}).get("LivesList") or []:
        rows.append({
            "headline": it.get("title", ""),
            "summary": (it.get("digest") or "").strip(),
            "url": it.get("url_w") or it.get("url", ""),
            "source": "东方财富",
            "datetime": it.get("showtime", ""),
        })
    return rows[:limit] if limit else rows, None

def json_loads(text):
    import json
    return json.loads(text)

# ---------------------------------------------------------------------------
# 3. 输出
# ---------------------------------------------------------------------------
def render(rows, query=None):
    if not rows:
        print("（无结果）")
        return
    for i, r in enumerate(rows, 1):
        tag = f" [{query}]" if query else ""
        print(f"#{i:<3} [{r['source']}] {r['datetime']}  {r['headline']}")
        if r["summary"]:
            print(f"      {r['summary'][:120]}")
        if r["url"]:
            print(f"      {r['url']}")
        print()

def save_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["source", "datetime", "headline", "summary", "url"])
        w.writeheader()
        w.writerows(rows)
    print(f"已保存 {len(rows)} 条 -> {path}")

# ---------------------------------------------------------------------------
# 4. 主流程
# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="通用金融信息检索: Finnhub(国外) + 新浪/东财(国内)")
    p.add_argument("ticker", nargs="?", default="AAPL", help="股票代码(仅国外源使用), 默认 AAPL")
    p.add_argument("--region", choices=["cn", "us", "all"], default="us",
                   help="us=国外Finnhub, cn=国内新浪+东财, all=全部")
    p.add_argument("--sources", nargs="+", choices=["finnhub", "sina", "eastmoney"], default=None,
                   help="指定数据源, 默认按 region 取全部")
    p.add_argument("--query", default=None, help="关键词过滤(国内源)")
    p.add_argument("--num", type=int, default=10, help="每个源输出条数, 默认10")
    p.add_argument("--days", type=int, default=7, help="国外源回溯天数, 默认7")
    p.add_argument("--save", default=None, help="保存结果到CSV文件")
    args = p.parse_args()

    load_dotenv()  # 读 .env

    sources = args.sources or (["finnhub"] if args.region == "us" else
                               (["sina", "eastmoney"] if args.region == "cn" else
                                ["finnhub", "sina", "eastmoney"]))
    if args.region in ("cn", "all"):
        sources = [s for s in sources if s != "finnhub"] + \
                  (["finnhub"] if "finnhub" in sources and args.region == "all" else [])

    all_rows, warnings = [], []
    for src in sources:
        try:
            if src == "finnhub":
                rows, warn = fetch_finnhub(args.ticker, args.days, args.num)
            elif src == "sina":
                rows, warn = fetch_sina(args.num, args.num)
            else:
                rows, warn = fetch_eastmoney(args.num, args.num)
            if warn:
                warnings.append(warn)
                continue
            if args.query:
                q = args.query.lower()
                rows = [r for r in rows if q in r["headline"].lower() or q in r["summary"].lower()]
            all_rows.extend(rows)
        except Exception as e:
            warnings.append(f"[{src}] 请求失败: {e}")

    if warnings:
        print("⚠ 提示:")
        for w in set(warnings):
            print("  " + w)
        print()

    if not all_rows:
        sys.exit("没有获取到任何新闻。")

    render(all_rows, args.query)
    if args.save:
        save_csv(all_rows, args.save)

if __name__ == "__main__":
    main()
