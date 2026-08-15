#!/usr/bin/env node
// refresh-prices.js v2.2 — 多源价格自动刷新（token-usage-tracker 技能配套）
//
// 用户需求（2026-08-14）：
//   1) 已有模型每天刷新一次；新模型由 token-tracker.js 的 ensureNewModelPricing 立即补录；
//   2) 增加国内人民币价格源，且要有【备份】——国内源 2 个（llmabacus 主 + llm-prices-cn 备）；
//   3) 区分国内外模型：国内模型优先国内源人民币价，国外模型用国外 USD 源定价；
//   4) 所有源都拉取失败时，写 last_refresh_error，供 token-tracker.js 在 toast 提示「价⚠️」。
//
// 数据源（5 个，并行拉取，互不依赖）：
//   国内（人民币）：A. llmabacus.com/api/prices（主，每日自动核价，含 vendors country/currency）
//                  B. llm-prices-cn GitHub raw（备，llmabacus 的每日镜像）
//   国外（USD）：   C. OpenRouter（接近实时）
//                  D. LiteLLM model_prices_and_context_window.json（社区 PR，1-3 天滞后）
//                  E. Portkey configs.portkey.ai/pricing/<provider>.json（美分/token ×1e4）
//
// 更新规则（按模型 region 区分）：
//   - region=CN（国内模型，默认）：人民币主价 先 A 再 B；两者都无 → 保留本地价
//     （仅当本地原本是 USD 估算价 auto_converted=true 时，才用 USD 中位数×汇率换算兜底）；
//   - region=US（国外模型）：人民币主价 = 三 USD 源中位数 × usd_cny_rate（标 auto_converted）；
//   - USD 参考价（usd_input_price/usd_output_price）：三 USD 源中位数（所有模型都更新）；
//   - region 推断：模型无 region 字段时，用 A 的 vendors country 判断（US→US，其余→CN）；
//   - 峰谷保护：peak_multiplier>1（DeepSeek），源价当「空闲/基准价」，高峰倍率保留本地；
//     若源价与本地价差异 >60% 写入 last_refresh_note 提示人工核验；
//   - 全源失败：写 last_refresh_error（date 不变次日重试），token-tracker toast 提示；
//   - 至少一个源成功：更新 date、清空 last_refresh_error。
//
// 用法：
//   node refresh-prices.js            # 当天首次运行自动刷新（date 非今天才联网）
//   node refresh-prices.js --force    # 强制联网刷新（测试/人工手动更新用）
//   WB_ROOT 环境变量可覆盖 ~/.workbuddy（测试隔离）
//   WB_NO_NET=1 时跳过联网（模拟全源失败路径）

const fs = require('fs');
const path = require('path');
const os = require('os');

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const TIMEOUT_MS = 12000;
const DEFAULT_RATE = 7.2;
const FORCE = process.argv.includes('--force');
const NO_NET = process.env.WB_NO_NET === '1';

const SOURCES = {
  llma: { name: 'llmabacus(国内·人民币·主)', url: 'https://www.llmabacus.com/api/prices' },
  llc: { name: 'llm-prices-cn(国内·人民币·备)', url: 'https://raw.githubusercontent.com/szp2005/llm-prices-cn/main/prices.json' },
  or: { name: 'openrouter(USD)', url: 'https://openrouter.ai/api/v1/models' },
  litellm: { name: 'litellm(USD)', url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' },
  portkey: { name: 'portkey(USD)', url: 'https://configs.portkey.ai/pricing/deepseek.json' },
};

// 本地 pricing.json 的 key → llm-prices-cn / llmabacus 的 id（归一化匹配兜不住的特殊映射）
const SRC_ID_MAP = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v3-0324': 'deepseek-v3-2-legacy',
  'deepseek-v3-1': 'deepseek-v3-2-legacy',
  'deepseek-r1-0528': 'deepseek-r1',
  'glm-5.2': 'glm-5-2',
  'glm-5.1': 'glm-5-1',
  'glm-5': 'glm-5',
  'glm-4.7': 'glm-4-7',
  'kimi-k3': 'kimi-k3',
  'kimi-k3-1': 'kimi-k3',
  'kimi-k2.6': 'kimi-k2-6',
  'minimax-m3': 'minimax-m3',
  'minimax-m2.7': 'minimax-m2-7',
  'hy3': 'hunyuan-hy3',
  'hy3-preview': 'hunyuan-hy3',
};

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
} // v2.39：本地日期（与 token-tracker.js 一致，避免 UTC+8 凌晨错位）

function load() {
  try { return JSON.parse(fs.readFileSync(PRICING, 'utf-8')); }
  catch (e) { throw new Error(`pricing.json 读取失败: ${e.message}`); }
}

function save(p) {
  fs.mkdirSync(path.dirname(PRICING), { recursive: true });
  fs.writeFileSync(PRICING, JSON.stringify(p, null, 2) + '\n');
}

// 名称归一化：小写 + 去所有非字母数字（glm-5-2 → glm52；glm5.2 → glm52）
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'token-usage-tracker/2.2 (WorkBuddy skill)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function median(arr) {
  const v = arr.filter((x) => typeof x === 'number' && isFinite(x) && x >= 0);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ===== 源 A：llmabacus（国内主源，人民币；含 vendors country/currency） =====
function parseLlma(j) {
  const vendors = {};
  for (const v of (j.vendors || [])) vendors[v.id] = { country: v.country, currency: v.currency };
  const models = {};
  for (const m of (j.models || [])) {
    const inP = Number(m.inputPrice), outP = Number(m.outputPrice);
    if (!(inP >= 0 && outP >= 0)) continue;
    const cached = m.cachedInputPrice != null ? Number(m.cachedInputPrice) : null;
    models[m.id] = {
      in: inP, out: outP, cached,
      vendorId: m.vendorId,
      country: (vendors[m.vendorId] || {}).country || null,
      currency: (vendors[m.vendorId] || {}).currency || null,
    };
  }
  return models;
}

// ===== 源 B：llm-prices-cn（国内备份源，人民币） =====
function parseLlc(j) {
  const out = {};
  for (const m of (j.models || [])) {
    const inP = Number(m.input_price_cny_per_m);
    const outP = Number(m.output_price_cny_per_m);
    if (!(inP >= 0 && outP >= 0)) continue;
    const cached = m.cached_input_price_cny_per_m != null ? Number(m.cached_input_price_cny_per_m) : null;
    out[m.id] = { in: inP, out: outP, cached };
  }
  return out;
}

// ===== 源 C：OpenRouter（USD/token → USD/1M） =====
function parseOr(j) {
  const out = {};
  for (const m of (j.data || [])) {
    const pr = (m && m.pricing) || {};
    const pIn = Number(pr.prompt), pOut = Number(pr.completion);
    if (!(pIn >= 0 && pOut >= 0)) continue;
    out[m.id] = { usdIn: pIn * 1e6, usdOut: pOut * 1e6 };
  }
  return out;
}

// ===== 源 D：LiteLLM（USD/token → USD/1M） =====
function parseLitellm(j) {
  const out = {};
  for (const key of Object.keys(j)) {
    const m = j[key];
    if (!m || typeof m !== 'object') continue;
    const pIn = Number(m.input_cost_per_token);
    const pOut = Number(m.output_cost_per_token);
    if (!(pIn >= 0 && pOut >= 0)) continue;
    out[key] = { usdIn: pIn * 1e6, usdOut: pOut * 1e6 };
  }
  return out;
}

// ===== 源 E：Portkey（美分/token → ×1e4 = USD/1M） =====
function parsePortkey(j) {
  const out = {};
  for (const key of Object.keys(j)) {
    const m = j[key];
    if (!m || typeof m !== 'object') continue;
    const cfg = (m.pricing_config && m.pricing_config.pay_as_you_go) || {};
    const rIn = Number(cfg.request_token && cfg.request_token.price);
    const rOut = Number(cfg.response_token && cfg.response_token.price);
    if (!(rIn >= 0 && rOut >= 0)) continue;
    out[key] = { usdIn: rIn * 1e4, usdOut: rOut * 1e4 };
  }
  return out;
}

function usdFind(usdIndex, localKey, orId, localNorm) {
  if (!usdIndex) return null;
  if (usdIndex[localKey]) return usdIndex[localKey];
  if (orId && usdIndex[orId]) return usdIndex[orId];
  for (const k of Object.keys(usdIndex)) {
    const kn = norm(k);
    if (kn && (kn.includes(localNorm) || localNorm.includes(kn))) return usdIndex[k];
  }
  return null;
}

// 在人民币源索引里找模型：先 srcId（归一化），再精确，再包含
function cnFind(cnIndex, srcId, localNorm) {
  if (!cnIndex) return null;
  if (srcId && cnIndex[srcId]) return cnIndex[srcId];
  for (const id of Object.keys(cnIndex)) {
    const inorm = norm(id);
    if (inorm && (inorm === localNorm || inorm.includes(localNorm) || localNorm.includes(inorm))) return cnIndex[id];
  }
  return null;
}

async function main() {
  let pricing;
  try { pricing = load(); }
  catch (e) { process.stderr.write(`[refresh-prices] ${e.message}\n`); process.exit(1); }

  const today = todayStr();
  if (!FORCE && pricing.date === today) {
    console.log(`[refresh-prices] 今天(${today})已刷新过，跳过联网（--force 强制刷新）`);
    return;
  }

  // 并行拉 5 源
  const results = NO_NET
    ? Object.fromEntries(Object.keys(SOURCES).map((k) => [k, { ok: false, err: 'WB_NO_NET=1' }]))
    : await Promise.all(Object.entries(SOURCES).map(async ([k, s]) => {
        try { return { ok: true, data: await fetchJson(s.url) }; }
        catch (e) { return { ok: false, err: e.message }; }
      })).then((arr) => {
        const o = {};
        Object.keys(SOURCES).forEach((k, i) => { o[k] = arr[i]; });
        return o;
      });

  const okCount = Object.values(results).filter((r) => r.ok).length;
  const cnOk = (results.llma.ok || results.llc.ok);
  const usdOk = (results.or.ok || results.litellm.ok || results.portkey.ok);

  // 全源失败 → 写错误标记，date 不变（次日重试），token-tracker 会 toast 提示
  if (okCount === 0) {
    const errMsg = Object.entries(results).map(([k, r]) => `${SOURCES[k].name}: ${r.err || '?'}`).join('；');
    pricing.last_refresh_error = `所有价格源拉取失败（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）：${errMsg}`;
    pricing.last_refresh_error_at = new Date().toISOString();
    try { save(pricing); } catch (e) { process.stderr.write(`[refresh-prices] 写入失败: ${e.message}\n`); process.exit(1); }
    process.stderr.write(`[refresh-prices] 全部 ${Object.keys(SOURCES).length} 个价格源拉取失败，已写 last_refresh_error（费用按上次价格估算）\n`);
    process.exit(1);
  }

  // 解析各源
  const llma = results.llma.ok ? parseLlma(results.llma.data) : null;
  const llc = results.llc.ok ? parseLlc(results.llc.data) : null;
  const or = results.or.ok ? parseOr(results.or.data) : null;
  const litellm = results.litellm.ok ? parseLitellm(results.litellm.data) : null;
  const portkey = results.portkey.ok ? parsePortkey(results.portkey.data) : null;
  const usdSources = [or, litellm, portkey].filter(Boolean);

  const rate = Number(pricing.usd_cny_rate) > 0 ? pricing.usd_cny_rate : DEFAULT_RATE;
  const models = pricing.models || {};

  let updatedMain = 0, autoConverted = 0, usdUpdated = 0, regionSet = 0, bigDiff = [];

  for (const key of Object.keys(models)) {
    const m = models[key];
    if (!m || typeof m !== 'object') continue;

    const localNorm = norm(key);
    const srcId = SRC_ID_MAP[key] || null;
    const llmaHit = llma ? cnFind(llma, srcId, localNorm) : null;
    const llcHit = llc ? cnFind(llc, srcId, localNorm) : null;

    // region 推断：模型无 region 字段时，优先用 llmabacus vendors country（US→US，其余→CN）
    if (!m.region) {
      if (llmaHit && llmaHit.country === 'US') m.region = 'US';
      else m.region = 'CN'; // 默认国内（现有模型均为国产）
      regionSet++;
    }

    // USD 参考价：三 USD 源中位数（所有模型都更新）
    const usdIn = median(usdSources.map((u) => usdFind(u, key, m.or_id, localNorm)?.usdIn));
    const usdOut = median(usdSources.map((u) => usdFind(u, key, m.or_id, localNorm)?.usdOut));
    if (usdIn != null && usdOut != null) {
      m.usd_input_price = Number(usdIn.toFixed(6));
      m.usd_output_price = Number(usdOut.toFixed(6));
      usdUpdated++;
    }

    if (m.region === 'CN') {
      // 国内模型：人民币主价优先国内源（llmabacus → llm-prices-cn）
      const cnHit = llmaHit || llcHit;
      if (cnHit) {
        const oldIn = m.input_price, oldOut = m.output_price;
        m.input_price = cnHit.in;
        m.output_price = cnHit.out;
        if (cnHit.cached != null) m.cached_price = cnHit.cached;
        m.price_source = llmaHit ? 'llmabacus(国内)' : 'llm-prices-cn(国内)';
        delete m.auto_converted;
        updatedMain++;
        // 峰谷模型价差大 → 提示核验
        if (typeof m.peak_multiplier === 'number' && m.peak_multiplier > 1) {
          const dIn = oldIn ? Math.abs(m.input_price - oldIn) / oldIn : 0;
          const dOut = oldOut ? Math.abs(m.output_price - oldOut) / oldOut : 0;
          if (dIn > 0.6 || dOut > 0.6) bigDiff.push(`${key}(±${Math.max(dIn, dOut).toFixed(0)}%)`);
        }
      } else if (m.auto_converted === true) {
        // 国内源也没有 → 原本是估算价的才用 USD 换算兜底
        if (usdIn != null && usdOut != null) {
          m.input_price = Number((usdIn * rate).toFixed(2));
          m.output_price = Number((usdOut * rate).toFixed(2));
          m.cached_price = Number((m.cached_price != null ? m.cached_price : usdIn * rate * 0.1).toFixed(2));
          m.price_source = 'usd×汇率(估算)';
          autoConverted++;
        }
      }
      // 非估算模型且国内源无 → 保留本地人工/官方价
    } else {
      // 国外模型：人民币主价 = USD 源 × 汇率（国外定价）
      if (usdIn != null && usdOut != null) {
        m.input_price = Number((usdIn * rate).toFixed(2));
        m.output_price = Number((usdOut * rate).toFixed(2));
        m.cached_price = Number((m.cached_price != null ? m.cached_price : usdIn * rate * 0.1).toFixed(2));
        m.price_source = 'usd×汇率(国外源)';
        m.auto_converted = true;
        autoConverted++;
      }
    }
  }

  pricing.date = today;
  pricing.usd_cny_rate = rate;
  pricing.last_source = 'multi-source';
  delete pricing.last_refresh_error;
  delete pricing.last_refresh_error_at;

  const noteParts = [];
  for (const [k, s] of Object.entries(SOURCES)) {
    const r = results[k];
    noteParts.push(`${s.name}${r.ok ? '✓' : `✗(${r.err || '?'})`}`);
  }
  pricing.last_refresh_note = `${new Date().toISOString()} 多源刷新：${noteParts.join(' | ')}；人民币主价更新 ${updatedMain} 个${autoConverted ? `，USD换算 ${autoConverted} 个` : ''}，USD参考 ${usdUpdated} 个，region 设定 ${regionSet} 个（汇率 ${rate}）${bigDiff.length ? `；⚠️峰谷模型价差>60%需核验：${bigDiff.join('、')}` : ''}`;

  try { save(pricing); }
  catch (e) { process.stderr.write(`[refresh-prices] 写入失败: ${e.message}\n`); process.exit(1); }

  console.log(`[refresh-prices] 多源刷新完成：date=${today}，源成功 ${okCount}/${Object.keys(SOURCES).length}(国内${cnOk ? '✓' : '✗'} 国外${usdOk ? '✓' : '✗'})，人民币主价 ${updatedMain} 个，USD换算 ${autoConverted} 个，USD参考 ${usdUpdated} 个，region ${regionSet} 个${bigDiff.length ? `，⚠️价差大：${bigDiff.join('、')}` : ''}`);
}

main().catch((e) => {
  process.stderr.write(`[refresh-prices] 异常: ${e.message}\n`);
  process.exit(1);
});
