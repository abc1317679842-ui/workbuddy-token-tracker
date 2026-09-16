#!/usr/bin/env node
// deepseek-official.js — DeepSeek 官方定价页抓取器（token-usage-tracker 配套）
//
// 用户需求（2026-08-23）：
//   1) 直连 DeepSeek 官方定价文档（api-docs.deepseek.com），每日拉取官方在售模型的
//      空闲/高峰价格 + 时段规则 + 周末低峰规则，本地保存；
//   2) 官方模型清单为权威：本地 DeepSeek 系模型名先与官方清单对比——官方有则用官方价；
//      官方没有（如已下线的 V3 系列）则回落第三方聚合源价格；
//   3) 抓取失败：立即重试（默认间隔 60s，可配），重试仍失败则返回失败信息（非零退出），
//      由调用方（refresh-prices.js）把失败状态传给模型/用户，提示「当前数据更新失败，排查原因」。
//
// 用法：
//   node deepseek-official.js              # 抓一次，成功输出 JSON，失败重试后仍失败退出码非0
//   node deepseek-official.js --raw        # 只输出原始解析结果（模型清单+价格+时段），不读/写 pricing.json
//   WB_ROOT 环境变量可覆盖 ~/.workbuddy（测试隔离）
//   WB_NO_NET=1 时跳过联网（模拟失败路径）
//
// 输出（成功，stdout JSON）：
//   {
//     "ok": true,
//     "official": {                       // 官方在售模型（与本地定价对齐的 key）
//       "deepseek-v4-flash":   { "input_price":1.5, "cached_price":0.05, "output_price":4.5, "peak_multiplier":2 },
//       "deepseek-v4-pro":     { "input_price":4.5, "cached_price":0.15, "output_price":13.5,"peak_multiplier":2 },
//       "deepseek-v4-flash-vision-exp": {...},
//     },
//     "peak_schedule": "09:00-12:00、14:00-18:00",   // 官方时段文本
//     "weekend_off_peak": true,                      // 官方是否声明「周末统一低谷价」
//     "fetched_at": "2026-08-23T..."
//   }

const fs = require('fs');
const path = require('path');
const os = require('os');

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const OFFICIAL_URL = process.env.DS_OFFICIAL_URL || 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'; // 可覆盖（代理/镜像/测试）
const TIMEOUT_MS = 15000;
const RETRIES = Number(process.env.DS_RETRIES || 2);      // 首次 + 重试次数
const RETRY_DELAY_MS = Number(process.env.DS_RETRY_DELAY_MS || 60000); // 间隔 60s
const NO_NET = process.env.WB_NO_NET === '1';

function loadPricing() {
  try { return JSON.parse(fs.readFileSync(PRICING, 'utf-8')); }
  catch (e) { return null; }
}

function savePricing(p) {
  fs.mkdirSync(path.dirname(PRICING), { recursive: true });
  fs.writeFileSync(PRICING, JSON.stringify(p, null, 2) + '\n');
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 token-usage-tracker/2.2',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 提取 <table> 里表头模型名 + 三组价格（缓存命中/未命中/输出，各 空闲/高峰）
// 返回 { models:[...], prices: { cached:{off,peak}, uncached:{off,peak}, output:{off,peak} } }
// prices 每个值是与 models 同序的数组。
function parseOfficial(html) {
  const out = { models: [], prices: null };
  const tb = html.match(/<table[\s\S]*?<\/table>/);
  if (!tb) throw new Error('官方页未找到价格表格');
  const trs = tb[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  const cellText = (t) => t.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').split('|').map((s) => s.trim()).filter(Boolean);

  // 表头（第一个含 模型 的 tr）
  let header = null;
  for (const t of trs) {
    const c = cellText(t);
    if (c[0] === '模型' || c.includes('模型')) { header = c; break; }
  }
  if (!header) throw new Error('官方页未找到模型表头');
  // v2.93：模型名过滤从 /^deepseek-v4-/ 放宽为 /^deepseek-/。
  // 旧正则在官方上架 "deepseek-v4.1-flash" 这类**带点版本号**的模型时会静默漏掉它
  // （第 12 个字符是 '.' 不是 '-'），而价格行的数字个数仍是全部模型的 → grab() 取前 n 个
  // 会导致**其余模型价格整体错位**（v4-pro 拿到 v4.1 的价、vision-exp 拿到 v4-pro 的价），
  // 且不报错。放宽后新模型名（v4.1 / v4-1 / 未来任意 deepseek-*）都能被自动收录。
  out.models = header.filter((s) => /^deepseek-/.test(s));
  if (!out.models.length) throw new Error('官方页未解析到 deepseek 模型');
  const n = out.models.length;

  // v3.07（2026-09-16）：解析「模型版本」行（如 DeepSeek-V4.1-Flash）。
  // 用途：官方现行 API ID 可能与本地 key 不同名（本地 deepseek-v4.1-flash ↔ 官方 deepseek-flash），
  // 「模型版本」是这两者同属一个模型的权威依据 → 供 main() 做跨 key 接管。
  // 列数与模型列不一致 → 视为不可用（返回空数组），退回纯 key 精确匹配，绝不猜测对齐。
  let versions = [];
  for (const t of trs) {
    const c = cellText(t);
    if (c[0] === '模型版本') { versions = c.slice(1).filter(Boolean); break; }
  }
  if (versions.length !== n) versions = [];
  out.versions = versions;

  const grab = (tr, baseIdx) => {
    const c = cellText(tr);
    // 行内形如：| 高峰时段 | 0.10元 | 0.30元 | 0.10元 |
    const nums = c.map((s) => { const m = s.match(/^(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : NaN; });
    const vals = nums.filter((v) => !isNaN(v));
    return vals.length >= n ? vals.slice(0, n) : null;
  };

  const prices = { cached: { off: null, peak: null }, uncached: { off: null, peak: null }, output: { off: null, peak: null } };
  for (const t of trs) {
    const c = cellText(t);
    const joined = c.join(' ');
    if (/百万tokens输入/.test(joined) && /缓存命中/.test(joined) && /空闲/.test(joined)) prices.cached.off = grab(t, 0);
    if (/高峰时段/.test(joined) && /缓存命中/.test(cellText(trs[trs.indexOf(t) - 1] || '').join(' '))) prices.cached.peak = grab(t, 0);
    if (/百万tokens输入/.test(joined) && /缓存未命中/.test(joined) && /空闲/.test(joined)) prices.uncached.off = grab(t, 0);
    if (/高峰时段/.test(joined) && /缓存未命中/.test(cellText(trs[trs.indexOf(t) - 1] || '').join(' '))) prices.uncached.peak = grab(t, 0);
    if (/百万tokens输出/.test(joined) && /空闲/.test(joined)) prices.output.off = grab(t, 0);
    if (/高峰时段/.test(joined) && /百万tokens输出/.test(cellText(trs[trs.indexOf(t) - 1] || '').join(' '))) prices.output.peak = grab(t, 0);
  }

  if (!prices.cached.off || !prices.cached.peak || !prices.uncached.off || !prices.uncached.peak || !prices.output.off || !prices.output.peak) {
    throw new Error(`官方页价格解析不完整: ${JSON.stringify(prices)}`);
  }
  out.prices = prices;
  return out;
}

// 提取时段规则 + 周末低峰声明 + 生效时间（从页面文本）
function parseRules(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // 高峰时段文本（官方 8-23 后改为"周一至周五"前缀；旧版无前缀）：
  //   "高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）"
  //   "高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00"
  let peak = text.match(/高峰时段为北京时间[^0-9]*([0-9:，、,\s\-]+)/);
  // 周末低峰规则存在性：
  //   新版：明确"周一至周五"为高峰时段（即周末空闲）；旧版：明确"周末...统一按照低谷时段价格"
  const weekend = /周一至周五/.test(text) || /周末[^。]{0,80}统一按照低谷时段价格/.test(text);
  // 生效时间：官方"将于北京时间YYYY年M月D日（周X）HH:MM起/00:00起"或"自...起"。
  // 无生效时间 → 视为立即生效（effective_at = null，由调用方按"立即生效"处理）。
  // 北京时间固定 UTC+8。
  let effectiveAt = null;
  const effMatch = text.match(/北京时间?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^起]{0,10}?(\d{1,2}:\d{2})?\s*起/);
  if (effMatch) {
    const y = Number(effMatch[1]), mo = Number(effMatch[2]), d = Number(effMatch[3]);
    const hm = effMatch[4] ? effMatch[4].split(':').map(Number) : [0, 0];
    if (y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(Date.UTC(y, mo - 1, d, hm[0] - 8, hm[1])); // 北京时间 UTC+8 → 转 UTC
      if (!isNaN(dt.getTime())) effectiveAt = dt.toISOString();
    }
  }
  return {
    peak_schedule: peak ? peak[1].trim() : '',
    weekend_off_peak: weekend,
    effective_at: effectiveAt,
  };
}

// 官方价 → 本地模型块（只填价格+峰谷，其他字段不动）
function toModelBlock(prices, models, i) {
  return {
    input_price: prices.uncached.off[i],
    cached_price: prices.cached.off[i],
    output_price: prices.output.off[i],
    peak_multiplier: 2,
  };
}

// 去标点归一化（与 token-tracker.js 的 alnumKey 同口径）：DeepSeek-V4.1-Flash → deepseekv41flash
function alnumOf(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 相对差异百分比（官方 vs 手动）：(official - manual) / manual × 100
function pctDiff(manual, official) {
  return (typeof manual === 'number' && manual !== 0 && typeof official === 'number')
    ? Number((((official - manual) / manual) * 100).toFixed(2))
    : null;
}

async function main() {
  const args = process.argv.slice(2);
  const RAW = args.includes('--raw');

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      process.stderr.write(`[deepseek-official] 第${attempt}次重试（${RETRY_DELAY_MS}ms 后）...\n`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    try {
      if (NO_NET) throw new Error('WB_NO_NET=1');
      const html = await fetchHtml(OFFICIAL_URL);
      const parsed = parseOfficial(html);
      const rules = parseRules(html);
      if (!RAW) {
        // 写回 pricing.json：官方模型对齐（新增/更新/标记 retired）
        const pricing = loadPricing() || { models: {} };
        const officialSet = new Set(parsed.models);
        // 1) 官方有的模型：新增或更新价格
        parsed.models.forEach((mkey, i) => {
          const blk = toModelBlock(parsed.prices, parsed.models, i);
          const existing = pricing.models[mkey] || {};
          // v2.92：官方源收录了先前手动补录的模型 → 先落一条对账记录（手动值 vs 官方值），
          // 再由下方重建逻辑采信官方价（重建时不带 manual → 标记自然消失 = 交接到官方价）。
          // 这样「手动补录」与「官方拉取」不需要人工比对，差异自动留痕可回查。
          if (existing.manual === true) {
            const official = { input_price: blk.input_price, cached_price: blk.cached_price, output_price: blk.output_price };
            const manual = { input_price: existing.input_price, cached_price: existing.cached_price, output_price: existing.output_price };
            const pct = (a, b) => (typeof a === 'number' && a !== 0 && typeof b === 'number') ? Number((((b - a) / a) * 100).toFixed(2)) : null;
            const diff = { input_pct: pct(manual.input_price, official.input_price), cached_pct: pct(manual.cached_price, official.cached_price), output_pct: pct(manual.output_price, official.output_price) };
            if (!Array.isArray(pricing._manual_audit)) pricing._manual_audit = [];
            const rec = pricing._manual_audit.find((r) => r && r.model === mkey);
            const patch = { manual, official, diff, status: 'official-adopted', adopted_at: new Date().toISOString() };
            if (rec) Object.assign(rec, patch);
            else pricing._manual_audit.push({ model: mkey, manual_at: existing.manual_at || null, source: existing.price_source || null, ...patch });
            process.stderr.write(`[deepseek-official] ${mkey} 官方价已收录，手动补录价交接到官方价：${manual.input_price}/${manual.cached_price}/${manual.output_price} → ${official.input_price}/${official.cached_price}/${official.output_price}\n`);
          }
          pricing.models[mkey] = {
            name: existing.name || mkey,
            input_price: blk.input_price,
            cached_price: blk.cached_price,
            output_price: blk.output_price,
            peak_multiplier: 2,
            or_id: existing.or_id || `deepseek/${mkey}`,
            usd_input_price: existing.usd_input_price,
            usd_output_price: existing.usd_output_price,
            price_source: 'deepseek官方',
            region: 'CN',
            ...(existing.lock !== undefined ? { lock: existing.lock } : {}),
          };
          delete pricing.models[mkey].retired; // 官方回归 → 解除 retired
        });
        // 1.5) v3.07（2026-09-16）跨 key 接管：官方现行 API ID ≠ 本地 key 时，靠「模型版本」对齐。
        // 场景：运行时上报 deepseek-v4.1-flash，官方现行 ID 是 deepseek-flash（版本 DeepSeek-V4.1-Flash）。
        // 旧逻辑只按官方 ID 精确匹配本地 key → 永远匹配不上 → 手动条目永久 pending、lock 冻结永不更新。
        // 现按去标点归一化的版本名与本地 key/name 对齐，命中即判定同一模型并：
        //   ① 官方价覆盖手动价（用户要求：官方为准，手动设定不再生效）
        //   ② 解除 manual / manual_at / lock（去掉冻结，此后每次刷新持续同步）
        //   ③ 打 alias_of=<官方ID>（保留本地 key 供运行时匹配；并豁免 retired 扫描）
        //   ④ 写 _manual_audit 留痕（manual vs official + diff + official-adopted）
        // 只接管「手动补录条目」或「已绑定别名的条目」，不做无差别改名——避免误伤其他模型。
        const versions = Array.isArray(parsed.versions) ? parsed.versions : [];
        let aliasAdopted = 0;
        parsed.models.forEach((mkey, i) => {
          const vkey = alnumOf(versions[i]);
          if (!vkey) return;
          const blk = toModelBlock(parsed.prices, parsed.models, i);
          for (const key of Object.keys(pricing.models)) {
            if (key === mkey) continue;
            const m = pricing.models[key];
            if (!m || typeof m !== 'object') continue;
            if (!(m.manual === true || m.alias_of === mkey)) continue;      // 只动手动/已绑定别名的条目
            const byKey = alnumOf(key) === vkey;
            const byName = alnumOf(m.name) === vkey;
            if (!byKey && !byName) continue;
            const manual = { input_price: m.input_price, cached_price: m.cached_price, output_price: m.output_price };
            const official = { input_price: blk.input_price, cached_price: blk.cached_price, output_price: blk.output_price };
            // ① 覆盖
            m.input_price = official.input_price;
            m.cached_price = official.cached_price;
            m.output_price = official.output_price;
            m.peak_multiplier = blk.peak_multiplier || 2;
            m.price_source = 'deepseek官方';
            m.region = 'CN';
            // ② 解冻
            delete m.manual;
            delete m.manual_at;
            delete m.lock;
            delete m.retired;
            // ③ 绑定官方 ID
            m.alias_of = mkey;
            // ④ 留痕
            if (!Array.isArray(pricing._manual_audit)) pricing._manual_audit = [];
            const rec = pricing._manual_audit.find((r) => r && r.model === key);
            const patch = {
              manual,
              official,
              diff: {
                input_pct: pctDiff(manual.input_price, official.input_price),
                cached_pct: pctDiff(manual.cached_price, official.cached_price),
                output_pct: pctDiff(manual.output_price, official.output_price),
              },
              status: 'official-adopted',
              adopted_at: new Date().toISOString(),
              official_id: mkey,
              official_version: versions[i],
              matched_by: byKey ? 'key-version' : 'name-version',
            };
            if (rec) Object.assign(rec, patch);
            else pricing._manual_audit.push({ model: key, manual_at: null, source: m.price_source || null, ...patch });
            aliasAdopted++;
            process.stderr.write(
              `[deepseek-official] 跨 key 接管：本地 ${key} ≡ 官方 ${mkey}（版本 ${versions[i]}，按${byKey ? 'key' : 'name'}匹配）→ ` +
              `官方价 ${manual.input_price}/${manual.cached_price}/${manual.output_price} → ${official.input_price}/${official.cached_price}/${official.output_price}，已解除手动+冻结标记\n`
            );
          }
        });
        // 2) 本地 DeepSeek 系、官方清单没有的 → 标记 retired（保留历史账本，不再计费匹配）
        for (const key of Object.keys(pricing.models)) {
          const isDS = /(^|[\/\-_])deepseek/i.test(key);
          // v2.92：手动补录条目豁免 retired——「官方暂未收录」不等于「官方已下线」。
          // 否则新模型刚手工补价，次日刷新就被打成 retired（=不再计费），补录等于白做。
          // v3.07：alias_of 条目同样豁免——它绑定了官方在售模型（只是本地 key 不同名），
          // 若被打成 retired 会导致运行时该名查不到价（回退联网估算），故必须保留可计费。
          if (pricing.models[key].manual === true || pricing.models[key].alias_of) continue;
          if (isDS && !officialSet.has(key)) {
            pricing.models[key].retired = true;
            if (!pricing.models[key].price_source) pricing.models[key].price_source = '聚合源(官方已下线)';
          }
        }
        // 3) 时段/周末规则存本地（供 isPeakHour 读取）+ 生效时间分流（v2.59）：
        //    - 官方标注了未来生效时间（effective_at > now）→ 存 deepseek_rules_pending，暂不覆盖当前规则；
        //    - 否则 → 更新 deepseek_rules 为当前生效规则；
        //    - 已有 pending 且已到生效时间 → 提升为当前规则。
        const nowIso = new Date().toISOString();
        const pending = pricing.deepseek_rules_pending;
        if (pending && pending.effective_at && pending.effective_at <= nowIso) {
          // pending 到期 → 提升为当前规则，清除 pending
          pricing.deepseek_rules = { ...pending, applied_at: nowIso };
          delete pricing.deepseek_rules_pending;
        }
        if (rules.effective_at && rules.effective_at > nowIso) {
          // 官方预告未来生效 → 存 pending（新规则内容），当前规则不动
          pricing.deepseek_rules_pending = {
            peak_schedule: rules.peak_schedule,
            weekend_off_peak: rules.weekend_off_peak,
            effective_at: rules.effective_at,
            fetched_at: nowIso,
          };
        } else {
          // 立即生效或已生效 → 直接更新当前规则
          pricing.deepseek_rules = {
            peak_schedule: rules.peak_schedule,
            weekend_off_peak: rules.weekend_off_peak,
            effective_at: rules.effective_at,
            updated_at: nowIso,
          };
          delete pricing.deepseek_rules_pending;
        }
        // 4) 清理失败标记（成功即清除）
        delete pricing.last_refresh_error;
        delete pricing.last_refresh_error_at;
        savePricing(pricing);
      }
      const out = { ok: true, official: {}, versions: parsed.versions || [], peak_schedule: rules.peak_schedule, weekend_off_peak: rules.weekend_off_peak, effective_at: rules.effective_at, fetched_at: new Date().toISOString() };
      parsed.models.forEach((mkey, i) => {
        out.official[mkey] = toModelBlock(parsed.prices, parsed.models, i);
      });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    } catch (e) {
      lastErr = e;
      process.stderr.write(`[deepseek-official] 第${attempt + 1}次抓取失败: ${e.message}\n`);
    }
  }

  // 全部失败 → 非零退出 + stderr 错误说明（调用方据此提示用户）
  process.stderr.write(`[deepseek-official] 官方定价抓取失败（已重试 ${RETRIES} 次）：${lastErr.message}\n`);
  process.stderr.write('[deepseek-official] FAIL_REASON=' + (lastErr.message || 'unknown') + '\n');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`[deepseek-official] 异常: ${e.message}\n`);
  process.exit(1);
});
