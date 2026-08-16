// probe-engines.mjs — 直接探测智谱 web_search REST 四种引擎的原始响应
import { randomUUID } from 'node:crypto';

const API_KEY = process.env.ZHIPU_API_KEY;
const URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const ENGINES = ['search_sogou', 'search_quark', 'search_pro', 'search_std'];
const QUERY = '人工智能最新进展';

for (const engine of ENGINES) {
  const t0 = Date.now();
  const payload = {
    search_query: QUERY,
    search_engine: engine,
    count: 3,
    search_domain_filter: '',
    search_recency_filter: 'noLimit',
    request_id: randomUUID(),
    user_id: 'probe-user-2026',
  };
  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(payload),
    });
    const body = await resp.text();
    console.log(`\n===== ${engine} → HTTP ${resp.status} (${Date.now() - t0}ms) =====`);
    console.log(body.slice(0, 800));
  } catch (e) {
    console.log(`\n===== ${engine} → 异常 =====`);
    console.log(e.message);
  }
}
