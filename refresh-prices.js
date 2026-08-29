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
const { spawnSync } = require('child_process');

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const PRICING_LOCK_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.pricing.lock'); // 修复6：pricing 并发写锁（与 token-tracker.js 共用）
const DS_OFFICIAL = process.env.DS_OFFICIAL || path.join(__dirname, 'deepseek-official.js'); // 可覆盖（测试/镜像）
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

// 独立文件锁（与 token-tracker.js 的 withFileLock 完全同构：原子 openSync 'wx' + pid 存活探测 + TTL 兜底）。
// 返回 true=获取成功并已在 finally 中释放；false=获取失败（调用方应跳过写，避免覆盖）。
// v2.68（锁逻辑同步）：抢占规则与 token-tracker.js 的 withFileLock 保持一致——
//   1) 锁不存在 → 创建并持有；
//   2) 能解析出 pid 且该 pid 仍存活 → **绝不抢占**，返回 false 让上层重试；
//   3) pid 已死 → 立即接管（不看 TTL，快速自愈）；
//   4) 解析不出 pid（锁文件为空/损坏）→ 退化为按 TTL 判定，超时后才接管。
// 旧逻辑只看"锁是否超过 TTL"就抢，会把仍在工作（只是慢）的持有者的锁抢走，
// 导致两个进程同时认为自己持锁 → pricing.json 并发写 → 丢模型价格。
// 死锁防护：重试有上限（retries×retryDelay = 5s），到点返回 false 而非无限等待。
function withPricingLock(fn) {
  const ttl = 300000; // v2.68：30s → 300s（只用于"解析不出 pid"的退化分支）
  const retries = 50;
  const retryDelay = 100;
  const myPid = process.pid;
  const tryCreate = () => {
    try {
      const fd = fs.openSync(PRICING_LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid }));
      fs.closeSync(fd);
      return true;
    } catch (e) { return false; }
  };
  const pidAlive = (pid) => {
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (e2) { if (e2.code === 'ESRCH') alive = false; else if (e2.code === 'EPERM') alive = true; else alive = true; }
    return alive;
  };
  const acquire = () => {
    try { fs.mkdirSync(path.dirname(PRICING_LOCK_FILE), { recursive: true }); } catch (e) {}
    // 1) 锁不存在 → 创建
    if (tryCreate()) return true;
    let mine = null;
    try { mine = JSON.parse(fs.readFileSync(PRICING_LOCK_FILE, 'utf-8')); } catch (e) { mine = null; }
    const pid = mine && Number(mine.pid);
    if (pid && pid > 0 && Number.isFinite(pid)) {
      // 2)(3) 有 pid → 只认存活与否，与 TTL 无关
      if (pidAlive(pid)) return false;     // 持有者还活着 → 不抢
      // 持有者已死 → 落到下面统一接管
    } else {
      // 4) 解析不出 pid → 退化为 TTL 判定，未超时则保守等待
      const fresh = mine && (Date.now() - (mine.at || 0) < ttl);
      if (fresh) return false;
    }
    try { fs.unlinkSync(PRICING_LOCK_FILE); } catch (e2) {}
    return tryCreate();
  };
  let got = false;
  for (let i = 0; i < retries; i++) {
    got = acquire();
    if (got) break;
    const end = Date.now() + retryDelay;
    while (Date.now() < end) { /* 短暂停，避免引入 timer 依赖 */ }
  }
  if (!got) return false;
  try { fn(); return true; }
  finally {
    try {
      const o = JSON.parse(fs.readFileSync(PRICING_LOCK_FILE, 'utf-8'));
      if (o && o.pid === myPid) fs.unlinkSync(PRICING_LOCK_FILE);
    } catch (e2) {}
  }
}

function save(p) {
  // 修复6 + 修复9：临时文件 + rename 原子写，加锁避免与 addModelPrice 并发覆盖
  const ok = withPricingLock(() => {
    const tmp = PRICING + '.tmp';
    try {
      fs.mkdirSync(path.dirname(PRICING), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
      fs.renameSync(tmp, PRICING);
    } catch (e) {
      // 写失败：清理临时文件，原 pricing.json 未被触碰（rename 只在写成功后执行）
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  });
  if (!ok) process.stderr.write('[refresh-prices] 价格写入跳过（被其他进程持锁）\n');
  return ok;
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
  // DeepSeek 官方定价抓取（v2.59，2026-08-23）放在 load() 之前：
  // deepseek-official.js 会先写 pricing.json（模型清单对齐：新增官方模型/标记已下线 retired/更新官方价），
  // 之后 load() 拿到的就是官方对齐后的数据，refresh 循环在此基础上做聚合源兜底。
  // 失败不中断：官方抓不到 → 回落聚合源，仅记 deepseek_refresh_error。
  let officialOk = false;
  let official = null; // { official: {模型:{input_price,cached_price,output_price,peak_multiplier}}, weekend_off_peak }
  if (!NO_NET) {
    try {
      const sp = spawnSync(process.execPath, [DS_OFFICIAL], {
        encoding: 'utf-8',
        timeout: 120000, // 含重试（2 次 × 60s）
        env: { ...process.env, DS_RETRIES: '0' }, // 本次外部已整体由 refresh 控制节奏，子进程不再追加重试，避免重复 60s
      });
      if (sp.status === 0) {
        const j = JSON.parse(sp.stdout);
        if (j.ok && j.official) {
          official = j;
          officialOk = true;
        }
      } else {
        const reason = (sp.stderr.match(/FAIL_REASON=([^\n]+)/) || [])[1] || sp.stderr.trim().slice(0, 200);
        process.stderr.write(`[refresh-prices] DeepSeek 官方定价抓取失败（回落聚合源）: ${reason || '未知'}\n`);
      }
    } catch (e) {
      process.stderr.write(`[refresh-prices] DeepSeek 官方抓取器执行异常（回落聚合源）: ${e.message}\n`);
    }
  }

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

  // v2.65：清理超过 14 天未使用的模型，防止 pricing.json 无限膨胀。
  // 删除不影响历史账本：daily-usage.json 独立存储，不依赖 pricing.models 里条目。
  {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    let daily = {};
    try {
      const dPath = path.join(WB, 'skills', 'token-usage-tracker', 'daily-usage.json');
      daily = JSON.parse(fs.readFileSync(dPath, 'utf-8'));
    } catch (e) { daily = {}; }
    const lastUsed = {};   // 精确模型名 → 最后使用日期
    const normUsed = {};   // 归一化名 → 最后使用日期（兼容 daily-usage 与 pricing 命名不一致）
    for (const [date, v] of Object.entries(daily)) {
      if (date === '_instructions' || !v || typeof v !== 'object') continue;
      const mods = v.models || {};
      for (const mk of Object.keys(mods)) {
        if (lastUsed[mk] == null || date > lastUsed[mk]) lastUsed[mk] = date;
        const nk = norm(mk);
        if (nk && (normUsed[nk] == null || date > normUsed[nk])) normUsed[nk] = date;
      }
    }
    let removed = 0;
    for (const key of Object.keys(models)) {
      const m = models[key];
      if (!m || typeof m !== 'object') continue;
      if (m.lock === true) continue; // 冻结模型故意保留，不删
      const lu = lastUsed[key] || normUsed[norm(key)];
      // 护栏 A：仅删除「曾出现在 daily-usage 且最后使用超过 14 天」的模型；
      // 从未出现在 daily-usage（lastUsed=none，如新加/手动/未记账模型）一律保留。
      if (lu == null || lu < cutoffStr) { delete models[key]; removed++; }
    }
    if (removed) console.log(`[refresh-prices] 已清理 ${removed} 个超过14天未使用的模型`);
  }

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
      // v2.59（2026-08-23）：官方优先——DeepSeek 系模型若官方清单里有，直接用官方价
      //（官方页含空闲/高峰价 + 时段 + 周末低峰规则，聚合源只有高峰价且无周末规则）。
      // 官方没有的 DeepSeek 系（如已下线 V3 系列）→ 回落聚合源。
      const officialBlk = officialOk && official.official[key];
      if (officialBlk) {
        m.input_price = officialBlk.input_price;
        m.cached_price = officialBlk.cached_price;
        m.output_price = officialBlk.output_price;
        m.peak_multiplier = officialBlk.peak_multiplier || 2;
        m.price_source = 'deepseek官方';
        delete m.auto_converted;
        delete m.retired;
        updatedMain++;
      } else if (m.lock === true) {
        // 跳过人民币主价覆盖，保留本地价 + peak_multiplier
      } else if (cnHit) {
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
  // 官方 DeepSeek 规则（时段/周末/生效时间）同步已由 deepseek-official.js 完成（含 pending 分流）：
  // 它非 raw 模式会自己写 pricing.json 的 deepseek_rules / deepseek_rules_pending / 模型对齐。
  // 这里只处理失败标记：官方抓取成功 → 清除；失败 → 保留上次规则 + 写失败标记（供模型/用户提示）。
  if (officialOk && official) {
    delete pricing.deepseek_refresh_error;
  } else {
    pricing.deepseek_refresh_error = `DeepSeek 官方定价抓取失败（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}），DeepSeek 系价格沿用本地/聚合源价`;
    // 失败不阻塞整体刷新：其余模型照常更新
  }
  pricing.last_refresh_note = `${new Date().toISOString()} 多源刷新：${noteParts.join(' | ')}；人民币主价更新 ${updatedMain} 个${autoConverted ? `，USD换算 ${autoConverted} 个` : ''}，USD参考 ${usdUpdated} 个，region 设定 ${regionSet} 个（汇率 ${rate}）${bigDiff.length ? `；⚠️峰谷模型价差>60%需核验：${bigDiff.join('、')}` : ''}${officialOk ? '；DeepSeek官方价✓' : '；DeepSeek官方价✗(回落聚合源)'}`;

  try { save(pricing); }
  catch (e) { process.stderr.write(`[refresh-prices] 写入失败: ${e.message}\n`); process.exit(1); }

  console.log(`[refresh-prices] 多源刷新完成：date=${today}，源成功 ${okCount}/${Object.keys(SOURCES).length}(国内${cnOk ? '✓' : '✗'} 国外${usdOk ? '✓' : '✗'})，人民币主价 ${updatedMain} 个，USD换算 ${autoConverted} 个，USD参考 ${usdUpdated} 个，region ${regionSet} 个${bigDiff.length ? `，⚠️价差大：${bigDiff.join('、')}` : ''}`);
}

// 仅当以 `node refresh-prices.js` 直接运行时才执行主流程；被 require 时不自动跑（避免测试/复用触发联网刷新）
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[refresh-prices] 异常: ${e.message}\n`);
    process.exit(1);
  });
}

// 供测试/外部复用（不影响脚本直接运行）
module.exports = { save, load, todayStr, PRICING };
