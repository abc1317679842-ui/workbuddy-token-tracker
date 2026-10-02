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

// v3.16：数据根智能探测（与 token-tracker.js 同口径）：WB_ROOT > ~/.workbuddy-ai（新版客户端）> ~/.workbuddy
function detectWorkBuddyRoot() {
  const h = os.homedir();
  const cands = [path.join(h, '.workbuddy-ai'), path.join(h, '.workbuddy')];
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'traces')) || fs.existsSync(path.join(c, 'settings.json'))) return c;
    } catch (e) { /* 单个候选探测失败不影响下一个 */ }
  }
  return path.join(h, '.workbuddy');
}
const WB = process.env.WB_ROOT || detectWorkBuddyRoot();
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
  // v3.19.0（P8）：原子写（tmp + rename）——原先裸 writeFileSync，中断/并发会留半截 JSON
  // （pricing.json 是重建链路的基础，半截文件会让下次启动走 repair 分支）
  // v3.23.5 已知边界（审计 #9，记录不修）：本函数**不持 `.pricing.lock`**，而 refresh-prices.js 的
  // save() 持锁，两者还共用同一个 tmp 名 `pricing.json.tmp`。正常链路是 refresh-prices.js 用
  // spawnSync **串行**调用本脚本，不会撞；只有手动并行跑两个脚本才可能互相覆盖 tmp。
  // 不修的理由：跨进程锁目前在 token-tracker.js / refresh-prices.js 各有一份同构实现（已是两份复制），
  // 再往本文件复制第三份会加剧「同一原则多处漂移」——真正该做的是抽共享模块（已记入 KNOWN-ISSUES）。
  fs.mkdirSync(path.dirname(PRICING), { recursive: true });
  const tmp = PRICING + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
    fs.renameSync(tmp, PRICING);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
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

// v3.19.1（N1）：峰谷时段解析改为**句式无关 + 不变式校验**。
// 原实现只有一条正则 `/高峰时段为北京时间…/`；官方 2026-09 把文案改成倒装句
// 「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段」后
// 匹配失败，且失败时**静默把 pricing.json 里的 peak_schedule 覆盖成空串**——下游回落默认值
// 恰好等于官方当前时段，毫无异常表现，只在官方真调时段那天一次性算错钱（实测 9-30 那次刷新已发生）。
const PEAK_PATTERNS = [
  // ① 旧句式：「高峰时段为北京时间[周一至周五] 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）」
  /高峰时段为北京时间[^0-9]*([0-9:：，、,\s\-–—]+)/,
  // ② 倒装句式（官方 2026-09 起）：「…9:00 - 12:00、14:00 - 18:00 为高峰时段」
  //    间隔段排除「为」字：否则「9:00-12:00 为低谷时段，其余为高峰时段」会跨句错配后半段的「为高峰时段」
  /(\d{1,2}[:：]\d{2}\s*[-–—~至到]\s*\d{1,2}[:：]\d{2}(?:\s*[、,，]\s*\d{1,2}[:：]\d{2}\s*[-–—~至到]\s*\d{1,2}[:：]\d{2})*)[^。；;为]{0,30}?为高峰时段/,
];

// 从文本片段提取时间区间 + 不变式校验（0 <= 起 < 止 <= 24），防「9月12日」之类误匹配
function extractRanges(str) {
  const out = [];
  const re = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  let m;
  while ((m = re.exec(String(str || '')))) {
    const s = Number(m[1]) + Number(m[2]) / 60;
    const e = Number(m[3]) + Number(m[4]) / 60;
    if (!(s >= 0 && s < e && e <= 24)) continue;
    out.push({ s, e });
  }
  return out;
}

const fmtHM = (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
const fmtRanges = (rs) => rs.map((r) => `${fmtHM(r.s)} - ${fmtHM(r.e)}`).join('、');

// 返回归一化时段串（"9:00 - 12:00、14:00 - 18:00"）；**解析失败返回 null**（调用方保留旧值，绝不清空）
function extractPeakSchedule(text) {
  for (const re of PEAK_PATTERNS) {
    const m = String(text || '').match(re);
    if (!m) continue;
    const rs = extractRanges(m[1]);
    if (rs.length) return fmtRanges(rs);
  }
  // ③ 兜底：句式彻底变了也要能捞到——取「含高峰、不含空闲/低谷」句子内的时间区间。
  //    排除「空闲/低谷」是防「9:00-12:00 为低谷时段，其余为高峰时段」这类对调式文案被反向误判。
  for (const sent of String(text || '').split(/[。；;\n]/)) {
    if (!/高峰/.test(sent) || /空闲|低谷/.test(sent)) continue;
    const rs = extractRanges(sent);
    if (rs.length) return fmtRanges(rs);
  }
  return null;
}

// v3.29.0（A-10）：周末低谷价判定加固（原实现见下方三级判定说明）。
// A-10 原始缺陷：旧实现 `weekend_off_peak = /周一至周五/.test(text)` —— 官方定价页**任意一处**
// 出现「周一至周五」这个词就置 true。若官方只是改文案提到该词、而实际周末已恢复原价，
// 本地会继续按「周末全天低谷」计费 → **系统性少算且无任何告警**。
// 现分三级判定（**硬性前提：当前判定结果必须不变**——当前该值为 true 且正确）：
//   ① 带锚点（高置信）：以下两条任一命中即 true，均视为「周末语义与周一至周五同处邻近上下文」：
//      ①-a 邻近：`周末…(≤80字)…周一至周五` 或 `周一至周五…(≤80字)…周末`（同句 / 窗口内，不含句末标点）
//      ①-b 正向表述：`周末…(≤80字)…低谷|低峰|低价|优惠|折扣|空闲`（含官方现行「…包括周末…全天均为空闲时段」句式）
//   ② 全文兜底（低置信，保底回退）：锚点未命中、但原文任意位置含「周一至周五」→ **仍判 true**，
//      同时打 `weekend_off_peak_fallback=true` 标记 + stderr 告警一次（置信度低，需人工核验）。
//   ③ ①②都不命中 → false（原行为）。
// 【窗口为何是 80（A-10 二次修正）】独立验证方实测官方**真实**定价页：「周一至周五」与「周末」的
//   字符间距为 56，而初版窗口 40 → ①-a 在真页面上**永不命中** → 每次刷新都落到 ② 兜底 → 每次都写
//   `weekend_off_peak_fallback:true` + 每次 stderr 告警，兜底告警从「异常」退化成「常态噪声」。
//   放宽到 80 的风险论证：
//   · ①-a **恒为 ② 的子集**——它要求「周末」与「周一至周五」同时出现 ⇒ 全文必含「周一至周五」⇒ ②
//     必然也命中。故放宽 ①-a 窗口**不可能**产生 ② 不会产生的 true，**不引入任何新的假阳性**；
//     放宽后仅剩「多出的假阳性」一种风险，而该风险在放宽前已由 ② 全额承担。收益是真页面回归高置信分支。
//   · ①-b **不是 ② 的子集**（只要求「周末 + 低谷/空闲…」，不要求出现「周一至周五」），本就是一条
//     **独立的正向信号**——本次把「空闲」并入其词表是有意为之：官方现行文案正是用「空闲时段」表达
//     周末低峰，只认「低谷/低峰/低价/优惠」会漏掉它。其新增假阳性面（「周末」与「空闲」因无关语义
//     落进同一 80 字窗口）**远窄于** ② 全文兜底，且页面正文里「周末」基本只出现在规则句。
const WEEKEND_ANCHOR_RE = /周末[^。；\n]{0,80}周一至周五|周一至周五[^。；\n]{0,80}周末/; // ①-a 邻近锚点
const WEEKEND_POSITIVE_RE = /周末[^。；\n]{0,80}(?:低谷|低峰|低价|优惠|折扣|空闲)/;      // ①-b 正向表述
let _weekendFallbackWarned = false; // 「告警一次」：同一进程内兜底告警只打一次
function parseRules(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const peakSchedule = extractPeakSchedule(text);
  // 周末低峰规则存在性（v3.29.0/A-10：见文件内 WEEKEND_* 常量上方的三级判定说明）
  const weekendAnchor = WEEKEND_ANCHOR_RE.test(text) || WEEKEND_POSITIVE_RE.test(text); // ① 高置信
  const weekendFallback = !weekendAnchor && /周一至周五/.test(text);                    // ② 全文兜底（保底，结果仍 true）
  const weekend = weekendAnchor || weekendFallback;
  if (weekendFallback && !_weekendFallbackWarned) {
    _weekendFallbackWarned = true;
    // stderr（不用 console.log：stdout 是给 refresh-prices.js 的纯 JSON，不能污染）
    process.stderr.write('[deepseek-official] ⚠ 周末低谷价判定来自全文兜底匹配（官方文案任意位置提及「周一至周五」即生效），置信度低；若周末已恢复原价请人工核验\n');
  }
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
    peak_schedule: peakSchedule, // v3.19.1（N1）：null = 解析失败 → 调用方保留旧值 + 告警，绝不清空
    weekend_off_peak: weekend,
    // v3.29.0（A-10）：本次 weekend_off_peak 是否来自「全文兜底」（②分支）——仅作置信度标记，
    //   布尔语义与字段名 `weekend_off_peak` 完全不变（下游 token-tracker.js 只读后者）。
    weekend_off_peak_fallback: weekendFallback,
    effective_at: effectiveAt,
  };
}

// v3.19.1（N1）：把解析结果并入 pricing —— **解析失败不清空**是本次修复的核心，故抽为纯函数并导出单测。
// 旧实现在解析失败时无条件写 `peak_schedule: ''`，把原本正确的时段覆盖掉；下游回落默认值，
// 而默认值恰好等于官方当前时段 → 故障完全不可见（实测 9-30 那次刷新已发生，此前所有备份均非空）。
// 返回 'error' | 'pending' | 'applied'，调用方据此输出 stderr 告警。
function applyRules(pricing, rules, nowIso, officialUrl) {
  const pending = pricing.deepseek_rules_pending;
  if (pending && pending.effective_at && pending.effective_at <= nowIso) {
    // pending 到期 → 提升为当前规则，清除 pending
    pricing.deepseek_rules = { ...pending, applied_at: nowIso };
    delete pricing.deepseek_rules_pending;
  }
  if (!rules.peak_schedule) {
    // 解析失败 → 保留 pricing.json 既有规则，只落告警（宁可本次不更新，也不能把好数据弄坏）
    pricing.deepseek_rules_error = {
      at: nowIso,
      reason: '峰谷时段文案解析失败（官方页句式可能已变更）',
      url: officialUrl || null,
    };
    return 'error';
  }
  if (rules.effective_at && rules.effective_at > nowIso) {
    // 官方预告未来生效 → 存 pending（新规则内容），当前规则不动
    pricing.deepseek_rules_pending = {
      peak_schedule: rules.peak_schedule,
      weekend_off_peak: rules.weekend_off_peak,
      // v3.29.0（A-10）：兜底标记随规则落盘（仅置信度标记，不下发弹窗；见 parseRules 三级判定说明）
      weekend_off_peak_fallback: rules.weekend_off_peak_fallback === true,
      effective_at: rules.effective_at,
      fetched_at: nowIso,
    };
    delete pricing.deepseek_rules_error;
    return 'pending';
  }
  // 立即生效或已生效 → 直接更新当前规则
  pricing.deepseek_rules = {
    peak_schedule: rules.peak_schedule,
    weekend_off_peak: rules.weekend_off_peak,
    // v3.29.0（A-10）：同上——落盘置信度标记，但**不**接进 token-tracker.js 的 priceAuditTag
    //   （否则每天刷新弹窗都挂 ⚠价核验，属常态噪音而非异常）。
    weekend_off_peak_fallback: rules.weekend_off_peak_fallback === true,
    effective_at: rules.effective_at,
    updated_at: nowIso,
  };
  delete pricing.deepseek_rules_pending;
  delete pricing.deepseek_rules_error;
  return 'applied';
}

// v3.29.0（A-4a）：由官方页解析出的「高峰价 / 空闲价」比值推**真实**峰谷倍率。
// 旧实现 toModelBlock 恒写 peak_multiplier: 2 —— parseOfficial 明明解析了 prices.*.peak（第 147-152 行），
// 但该值只参与完整性校验、从未参与计价：官方把倍率改成 ×1.5 / ×3 或分档时，本地仍一律按 ×2 算，
// 且倍率变化不在 bigDiff（那里只在源价差 >60% 时告警）监控范围内 → 系统性少算/多算且零告警。
// 基准取「未命中输入价」（三组价通常同倍率）；异常时依次回退 output / cached；全失败兜底 2（向后兼容旧行为）。
function peakMultiplierOf(prices, i) {
  for (const g of [prices && prices.uncached, prices && prices.output, prices && prices.cached]) {
    const off = g && g.off ? g.off[i] : NaN;
    const peak = g && g.peak ? g.peak[i] : NaN;
    if (typeof off === 'number' && off > 0 && typeof peak === 'number') {
      const r = peak / off;
      if (Number.isFinite(r) && r > 0) return Number(r.toFixed(4));
    }
  }
  return 2; // 解析不出真实倍率 → 保持向后兼容（与旧硬编码一致）
}

// 官方价 → 本地模型块（只填价格+峰谷，其他字段不动）
function toModelBlock(prices, models, i) {
  return {
    input_price: prices.uncached.off[i],
    cached_price: prices.cached.off[i],
    output_price: prices.output.off[i],
    peak_multiplier: peakMultiplierOf(prices, i),
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

  // v3.23.2：M7 守卫提前到联网之前——pricing.json 损坏时根本不该发起网络请求。
  // 旧实现先 fetch 成功、写盘前才拒绝：断网/WB_NO_NET 环境下重试循环先烧完再 exit(1)，
  // 守卫永远到不了（CI selftest T4 首跑抓出）。RAW 模式只解析输出不写库，维持不检查。
  if (!RAW) {
    // v3.24.0：守卫补「缺 models 字段」形态 —— 原先只查 JSON 可否解析，`{}`（合法 JSON 但无
    // models）会放行 → 循环里 pricing.models[mkey] 抛 TypeError，被外层 catch 误报成网络失败。
    const _cur = loadPricing();
    if (fs.existsSync(PRICING) && (!_cur || !_cur.models || typeof _cur.models !== 'object')) {
      process.stderr.write('FAIL_REASON=pricing.json 存在但损坏（JSON 不可解析或缺 models 字段），deepseek-official 拒绝覆盖式重建（请人工修复后重试）\n');
      process.exit(2);
    }
  }

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
        // v3.18（M7）：文件存在但解析失败（损坏）→ 拒绝覆盖式重建。旧实现 `|| { models: {} }`
        // 会用官方极简清单（只有 DeepSeek 系）覆盖整个价格库——lock/人工核验价/_manual_audit/
        // _lookedup_models 与全部其他厂商模型被静默清空。宁可本次失败，也不能静默降级。
        let pricing = loadPricing();
        // v3.24.0：写盘前二次读取也走同一守卫（堵 TOCTOU：main 开头检查后文件被换坏的情形）
        if (!pricing) {
          if (fs.existsSync(PRICING)) {
            process.stderr.write('FAIL_REASON=写入前二次读取 pricing.json 失败（损坏），deepseek-official 拒绝覆盖\n');
            process.exit(2);
          }
          pricing = { models: {} }; // 首次运行（文件不存在）允许从零建档
        }
        if (!pricing.models || typeof pricing.models !== 'object') pricing.models = {};
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
            // v3.29.0（A-4a）：旧实现此处同样硬编码 2（与 toModelBlock 同病）→ 改用官方真实峰谷倍率
            peak_multiplier: blk.peak_multiplier,
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
        // 2) 本地 DeepSeek 系、官方清单没有的 → 标记 retired（**仅作来源标注**，供人工排查「官方已下线」）
        //    ⚠ D-3 事实说明（v3.29.0 更正）：`retired` **只写不读** —— token-tracker.js 全仓无任何
        //    `retired` 读取（grep 零命中），`findModel` / `calcCost` 都不检查该标记；被打上 retired 的
        //    模型**仍按留存旧价继续计费**（不会回退去联网估算、也不会「不再计费」）。此处旧注释与实现相反。
        for (const key of Object.keys(pricing.models)) {
          const isDS = /(^|[\/\-_])deepseek/i.test(key);
          // v2.92：手动补录条目豁免 retired——「官方暂未收录」不等于「官方已下线」，不应污染其来源标注
          //   （注意：标记与否都不影响计费，`retired` 只写不读，见上方说明）。
          // v3.07：alias_of 条目同样豁免——它绑定了官方在售模型（只是本地 key 不同名），
          //   豁免是为避免来源标注被误写成「官方已下线」；其价已由官方接管，计费不受此标记影响。
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
        if (applyRules(pricing, rules, nowIso, OFFICIAL_URL) === 'error') {
          process.stderr.write('[deepseek-official] ⚠️ 峰谷时段文案解析失败（页面句式可能已变更）→ 保留本地既有规则、未覆盖；请人工核对官方定价页\n');
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
      // v3.29.0（A-4a）：倍率 != 2 时留痕——系统性少算/多算的来源，必须让调用方与日志都看得到。
      // 注意：stdout 是给 refresh-prices.js 的**纯 JSON**（它做 JSON.parse(sp.stdout)），
      // 故提示只能走 stderr + out.peak_multiplier_note，绝不能用 console.log（会污染 JSON 输出）。
      const peakNotes = parsed.models
        .map((mkey, i) => ({ mkey, mult: peakMultiplierOf(parsed.prices, i) }))
        .filter((x) => x.mult !== 2)
        .map((x) => `${x.mkey} ×${x.mult}`);
      if (peakNotes.length) {
        out.peak_multiplier_note = `官方高峰倍率已变更（非 ×2）：${peakNotes.join('、')}；本地已按官方真实倍率计费`;
        process.stderr.write(`[deepseek-official] ⚠ 官方高峰倍率已变更为非 ×2：${peakNotes.join('、')}（本地已同步真实倍率，请人工复核官方定价页）\n`);
      }
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

// v3.19.1：导出纯函数供 selftest 直接单测（句式解析是 N1 的核心，必须能离线验证六个文案变体）
// v3.29.0（A-4a）：补导出 peakMultiplierOf —— 真实峰谷倍率推导是 A-4a 的核心，同样必须能离线单测
module.exports = { parseRules, extractPeakSchedule, extractRanges, applyRules, PEAK_PATTERNS, peakMultiplierOf };

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[deepseek-official] 异常: ${e.message}\n`);
    process.exit(1);
  });
}
