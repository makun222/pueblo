// smoke-deepseek-text2img.mjs
// ---------------------------------------------------------------------------
// DeepSeek「文生图」链路冒烟程序（2026-09-05 调研版）
//
// 调研背景（已逐页核验官方文档，非记忆推断）：
//   https://api-docs.deepseek.com/zh-cn/news/news260821  —— V4-Flash-Vision-Exp
//   上线公告：该模型是“视觉理解”（图→token→文），文中的图片均来自 Agent
//   用代码产出（PPT/网页/前端 Demo），并非原生图输出端点。
//   全站 sitemap 71 页中图像相关仅有 /guides/vision（图像理解）；模型&价格页
//   仅列出 deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp
//   三个对话模型；API 端点目录不存在 images/generations 一类图生成端点。
//   结论：官方 API 文档当前无“原生文生图”端点，最接近的官方能力是——
//   prompt → chat/completions → 模型直接产出可渲染图片的 SVG 代码（即
//   news260821 三个示例的 Agent 创作方式）。
//
// 本程序做两件事：
//   1) 默认模式（官方现有 API）：调 chat/completions 让模型按提示词直接输出
//      一张完整 SVG，落盘为 .svg 图片文件 —— 冒烟“一句话 → 一张图”的链路。
//   2) --probe-native（可选，用你提供的真实 key 实测）：向
//      {base-url}/images/generations 打一个最小请求并如实报告 HTTP 状态与
//      响应片段，端到端实证官方是否存在原生文生图端点（不判失败，只记录）。
//
// API key 显式传入（不读凭据管理器）：
//   node mcp/smoke-deepseek-text2img.mjs --api-key <KEY> [选项]
//   或用环境变量 DEEPSEEK_API_KEY（脚本内仅作为兜底）。
//
// 选项：
//   --prompt <文本>   出图提示词（默认：大海红日）
//   --model <名称>    默认 deepseek-v4-flash-vision-exp（与 news260821 一致）
//   --base-url <URL>  默认 https://api.deepseek.com
//   --out-dir <目录>  默认 ./out-text2img（相对当前工作目录）
//   --probe-native    额外实测原生 images/generations 端点是否存在
//   --max-tokens <n>  默认 8192
// ---------------------------------------------------------------------------
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const USAGE = `用法:
  node mcp/smoke-deepseek-text2img.mjs --api-key <KEY> [--prompt <文本>] [--probe-native]

示例:
  node mcp/smoke-deepseek-text2img.mjs --api-key sk-xxx
  node mcp/smoke-deepseek-text2img.mjs --api-key sk-xxx --probe-native \\
    --prompt "日落时分的海面，金光粼粼，电影感构图"
`;

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash-vision-exp',
  maxTokens: 8192,
  outDir: 'out-text2img',
  prompt:
    '请直接输出一张图片' +
    '：壮阔的海上落日——红日低垂海面，' +
    '海面金光粼粼，天空由橙向紫渐变，电影感构图。',
};

// ─── 极简参数解析 ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--api-key': args.apiKey = next(); break;
      case '--prompt': args.prompt = next(); break;
      case '--model': args.model = next(); break;
      case '--base-url': args.baseUrl = next().replace(/\/+$/, ''); break;
      case '--out-dir': args.outDir = next(); break;
      case '--max-tokens': args.maxTokens = Number(next()); break;
      case '--probe-native': args.probeNative = true; break;
      case '-h': case '--help':
        console.log(USAGE); process.exit(0); break;
      default:
        console.error(`未知参数: ${a}\n${USAGE}`); process.exit(2);
    }
  }
  return args;
}

// ─── HTTP 小工具 ──────────────────────────────────────────────────────────
async function postJson(url, apiKey, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, ok: res.ok, json, raw: raw.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 主流程：chat/completions → SVG 落盘 ─────────────────────────────────
async function generateSvg(args, report) {
  const url = `${args.baseUrl}/chat/completions`;
  const t0 = Date.now();
  const res = await postJson(url, args.apiKey, {
    model: args.model,
    messages: [
      {
        role: 'system',
        content:
          '你是资深视觉创作者。用户要求图片时，你按照提示词生成图片。',
      },
      { role: 'user', content: args.prompt },
    ],
    temperature: 0.7,
    max_tokens: args.maxTokens,
  });
  report.chatCompletions = { httpStatus: res.status, ms: Date.now() - t0 };

  if (!res.ok) {
    report.step = 'chat-completions-failed';
    report.error = res.raw;
    return false;
  }

  const content = res.json?.choices?.[0]?.message?.content ?? '';
  // 剥离可能的 ```svg … ``` 围栏后提取首个完整 <svg> 文档
  const clean = content.replace(/```(?:svg|xml)?/gi, '').trim();
  const m = clean.match(/<svg[\s\S]*?<\/svg>/i);
  const svg = m ? m[0] : '';
  report.svg = {
    found: Boolean(svg),
    bytes: Buffer.byteLength(svg, 'utf8'),
    preview: svg.slice(0, 160).replace(/\s+/g, ' '),
  };

  const valid =
    svg.length > 100 && /<svg/i.test(svg) && /xmlns/i.test(svg) && /viewBox|width/i.test(svg);
  if (!valid) {
    report.step = 'svg-extract-failed';
    return false;
  }

  const outDir = resolve(args.outDir);
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `deepseek-text2img-${stamp}.svg`);
  await writeFile(file, svg, 'utf8');
  report.step = 'svg-saved';
  report.svg.file = file;
  return true;
}

// ─── 可选：原生 images/generations 端点实测 ──────────────────────────────
async function probeNative(args, report) {
  const url = `${args.baseUrl}/images/generations`;
  const t0 = Date.now();
  const res = await postJson(url, args.apiKey, {
    model: args.model,
    prompt: args.prompt,
    n: 1,
  });
  report.nativeProbe = {
    endpoint: url,
    httpStatus: res.status,
    ms: Date.now() - t0,
    // 2xx 说明官方确有（或新开放）该端点；否则如实报告，不代表冒烟失败
    nativeEndpointExists: res.ok,
    responsePreview: res.raw,
  };
}

// ─── 入口 ─────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const apiKey = args.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('[smoke] 错误：缺少 API key。请用 --api-key <KEY> 显式传入，或设置环境变量 DEEPSEEK_API_KEY。');
    console.error(USAGE);
    process.exit(2);
  }

  const report = { model: args.model, baseUrl: args.baseUrl, prompt: args.prompt.slice(0, 120) };
  try {
    const pass = await generateSvg(args, report);
    if (args.probeNative) await probeNative(args, report);
    report.overall = pass ? 'PASS' : 'FAIL';
  } catch (e) {
    report.step = 'exception';
    report.error = e.message;
    report.overall = 'FAIL';
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.overall === 'PASS' ? 0 : 1);
}

main();
