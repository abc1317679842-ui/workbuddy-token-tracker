#!/usr/bin/env node
// backfill.js —— 历史会话回填 / 账本重建工具（v3.17，Issue #3-③ 落地）
// 独立进程，不侵入 token-tracker.js 主链路（与 recalc-day.js 同模式）。
//
// 用途：账本 daily-usage.json 只增量记录「触发过 hook 的会话」；安装前/其他会话的历史用量
//      永远不在账本里。本工具递归扫描全部 transcript（含子代理），按**真实消费日期**（行
//      timestamp 的北京时间）重建整个账本。
//
// 用法：
//   node backfill.js             → **dry-run（默认）**：只扫描+打印将写入的账本，不落任何盘
//   node backfill.js --write     → 真正写入（先自动备份 daily-usage.json 与水位线）
//
// 语义与口径（与 token-tracker.js 增量记账严格对齐）：
// - usage 提取：extractUsage 同口径（usage / rawUsage / message.usage 三处落点 + 数值钳制取整）
// - 去重：同文件内按 messageId/conversationRequestId/id 去重（perModelFromRows 同口径）
// - 日期归属：行 timestamp + 8h 的北京时间日期（与 v2.39「本地时间日界」一致）
// - 费用：pricing.json 精确匹配模型名；峰谷按**行时间**判定（工作日 9-12/14-18 北京时间 ×
//   peak_multiplier；周末与法定假日全天低峰——v3.15 同口径）。匹配不到价的模型只记 token 不记钱
//   （与 addModelUsage 的 cost=null 行为一致）。
// - 水位线：写完后把每个扫描到的会话推满到当前行数（键=session_id，与 ledgerKey 一致），
//   并与旧水位线逐键取 max——未来的 Stop 增量记账从满水位继续，**不会重复计数**。
//
// 已知差异（如实标注）：
// - 「被中断思考」估算已包含（v2.52 镜像），但归属日期 = reasoning 行自身时间戳（增量版归记账当天），
//   且增量版的回溯基数可能与全量扫描略有差异 → 单日金额允许小幅出入。
// - 水位线键假设 transcript 文件名 = session_id（WorkBuddy 实际落盘即如此）。

const fs = require('fs');
const peakRules = require('./peak-rules.js'); // v3.19.0（P1）：峰谷判定单一实现（原先这里硬编码 PEAK_RANGES，与官方动态时段脱节）
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// v3.16：数据根智能探测（与 token-tracker.js 同口径）
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
const SKILL_DIR = path.join(WB, 'skills', 'token-usage-tracker');
const DAILY = path.join(SKILL_DIR, 'daily-usage.json');
const PRICING = path.join(SKILL_DIR, 'pricing.json');
const HOLIDAYS = path.join(SKILL_DIR, 'holidays.json');
const WATERMARK = path.join(SKILL_DIR, '.ledger-watermark.json');
const PROJECTS = path.join(WB, 'projects');

const WRITE = process.argv.includes('--write');


function isPeakBeijingTs(tsMs) {
  return peakRules.isPeakAt(tsMs, _pricing, HOLIDAYS);
}
function beijingDate(tsMs) {
  const bj = new Date(tsMs + 8 * 3600 * 1000);
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
}

// extractUsage 同口径（token-tracker.js v2.99 数值钳制版）
function extractUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const inT = num(u.inputTokens != null ? u.inputTokens : (u.input_tokens != null ? u.input_tokens : u.prompt_tokens));
  const outT = num(u.outputTokens != null ? u.outputTokens : (u.output_tokens != null ? u.output_tokens : u.completion_tokens));
  if (!inT && !outT) return null;
  let cached = 0;
  const det = u.inputTokensDetails || u.prompt_tokens_details || null;
  if (Array.isArray(det)) { for (const d of det) { if (d && d.cached_tokens) cached += num(d.cached_tokens); } }
  else if (det && typeof det === 'object') cached = num(det.cached_tokens);
  return { in: inT, out: outT, cached: num(cached) };
}
function usageFromRow(r) {
  if (!r || typeof r !== 'object') return null;
  const pd = r.providerData || {};
  return extractUsage(pd.usage) || extractUsage(pd.rawUsage) || extractUsage(r.message && r.message.usage) || null;
}

// 读 jsonl 全部行（容错跳过空行/半写行，与 readTranscLines 同口径）
function readRows(fp) {
  let raw = '';
  try { raw = fs.readFileSync(fp, 'utf-8'); } catch (e) { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* 半写行跳过 */ }
  }
  return rows;
}

// 成本：单行级计算（峰谷按行时间）；findModel 与主脚本同口径（归一化/去标点/边界匹配）
function rowCost(pricing, modelName, u, tsMs) {
  if (!modelName || modelName === 'unknown') return null;
  const hit = findModel(pricing, modelName, 'price');
  if (!hit) return null;
  const m = hit.m;
  if (typeof m.input_price !== 'number') return null;
  const isDeepSeek = /(^|[\/\-_])deepseek/i.test(String(modelName));
  const peakMult = isDeepSeek
    ? (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 2)
    : (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 1);
  const mult = isPeakBeijingTs(tsMs) ? peakMult : 1;
  const inT = u.in || 0, cached = Math.min(u.cached || 0, inT), outT = u.out || 0;
  const uncached = Math.max(0, inT - cached);
  const c = (uncached / 1e6) * Number(m.input_price || 0) * mult
    + (cached / 1e6) * Number(m.cached_price || 0) * mult
    + (outT / 1e6) * Number(m.output_price || 0) * mult;
  return Math.round(c * 1e6) / 1e6;
}
function hitRate(inTok, cachedTok) {
  const denom = inTok || 0;
  if (!(denom > 0)) return 0;
  return Math.round((cachedTok / denom) * 10000) / 100;
}
function dayTotalOf(models) {
  const t = { in: 0, out: 0, cached: 0, total: 0, cost: 0 };
  for (const m of Object.values(models || {})) {
    t.in += m.in || 0; t.out += m.out || 0; t.cached += m.cached || 0; t.total += m.total || 0;
    t.cost += m.cost || 0;
  }
  t.hit = hitRate(t.in, t.cached);
  return t;
}

// v2.52 中断补偿镜像（与 token-tracker.js estimateInterrupted 同口径，改动需同步）：
// 检测 status=incomplete / isPartialAborted 且无 usage 的被中断调用，估算其 token。
// 输入=往前最近一个有 usage 调用的 input/cached；输出=reasoning 文本长度（中文×1.5 + 其他/4）。
// 回填版差异：按 reasoning 行自己的 timestamp 归属北京日期（增量版归记账当天）。
function estimateInterruptedToDate(rows, acc) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type !== 'reasoning') continue;
    const ts = r.timestamp;
    if (!(typeof ts === 'number')) continue;
    const pd = r.providerData || {};
    if (r.status !== 'incomplete' && !pd.isPartialAborted) continue;
    if (!(pd.conversationRequestId || pd.messageId)) continue;
    const model = normalizeModelName(pd.model || pd.requestModelId || 'unknown');
    let estIn = 0, estCached = 0;
    for (let j = i - 1; j >= 0; j--) {
      const pu = usageFromRow(rows[j]);
      if (pu && pu.in > 0) { estIn = pu.in; estCached = pu.cached || 0; break; }
    }
    const c = Array.isArray(r.content) ? r.content.map((x) => (x && x.text) || '').join('') : (typeof r.content === 'string' ? r.content : '');
    const cjk = (c.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const other = c.length - cjk;
    const estOut = Math.round(cjk * 1.5 + other / 4);
    if (!estIn && !estOut) continue;
    const date = beijingDate(ts);
    const dAcc = acc[date] || (acc[date] = {});
    const b = dAcc[model] || (dAcc[model] = { in: 0, out: 0, cached: 0, total: 0, cost: 0 });
    b.in += estIn; b.out += estOut; b.cached += estCached; b.total += estIn + estOut;
    const u = { in: estIn, out: estOut, cached: estCached };
    const cst = rowCost(_pricing, model, u, ts);
    if (cst != null) b.cost = Math.round((b.cost + cst) * 1e6) / 1e6;
  }
}

// 扫描单个 transcript 文件（主或子代理），把 usage 行归入 acc[date][model] 与行数水位
function scanFile(fp, acc, modelNames) {
  const rows = readRows(fp);
  const seen = new Set();
  let usedLines = 0;
  for (const r of rows) {
    usedLines++; // 水位线口径 = 可解析行数（与 readTranscLinesFrom.totalLines 一致）
    const ts = r.timestamp;
    if (!(typeof ts === 'number')) continue;
    const pd = r.providerData || {};
    const u = usageFromRow(r);
    if (!u) continue;
    const key = pd.messageId || pd.conversationRequestId || r.id || (r.type + ':' + ts);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = String(pd.model || pd.requestModelId || '').trim() || 'unknown';
    modelNames.add(name);
    const date = beijingDate(ts);
    const dAcc = acc[date] || (acc[date] = {});
    const m = dAcc[name] || (dAcc[name] = { in: 0, out: 0, cached: 0, total: 0, cost: 0 });
    m.in += u.in; m.out += u.out; m.cached += u.cached; m.total += u.in + u.out;
    const c = rowCost(_pricing, name, u, ts);
    if (c != null) m.cost = Math.round((m.cost + c) * 1e6) / 1e6;
  }
  // v2.52 中断补偿（按日期归属）：与增量记账同口径，被中断的思考也补进账本
  estimateInterruptedToDate(rows, acc);
  return usedLines;
}

let _pricing = { models: {} };

// ===== 以下三件与 token-tracker.js 严格同口径（镜像自 v3.16，勿单独改动）=====
// normalizeModelName / alnumKey / findModel —— 回填计费必须与增量记账同价，否则会出现
// 「同一模型增量记了钱、回填记不到」的口径分裂。改动任一侧时必须同步另一侧。
function normalizeModelName(n) {
  return String(n == null ? '' : n).replace(/\s+/g, ' ').trim().toLowerCase();
}
function alnumKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
const MODEL_ALIASES = {};
function findModel(pricing, modelName, mode) {
  if (!pricing || !pricing.models || !modelName) return null;
  const norm = normalizeModelName(modelName);
  if (!norm) return null;
  const models = pricing.models;
  const keys = Object.keys(models);
  if (models[norm]) return { key: norm, m: models[norm] };
  for (const key of keys) {
    if (normalizeModelName(key) === norm) return { key, m: models[key] };
  }
  const normAlnum = alnumKey(modelName);
  if (normAlnum) {
    for (const key of keys) {
      if (alnumKey(key) === normAlnum) return { key, m: models[key] };
    }
  }
  const alias = MODEL_ALIASES[norm];
  if (alias) {
    const ak = normalizeModelName(alias);
    if (models[ak]) return { key: ak, m: models[ak] };
    for (const key of keys) {
      if (normalizeModelName(key) === ak) return { key, m: models[key] };
    }
  }
  if (mode === 'price') {
    const BOUND = /[-/_: \u4e00-\u9fa5]/;
    const boundaryHit = (short, long) => {
      if (!long.includes(short)) return false;
      const i = long.indexOf(short);
      const leftOk = i === 0 || BOUND.test(long.charAt(i - 1));
      const rightOk = (i + short.length) === long.length || BOUND.test(long.charAt(i + short.length));
      return leftOk && rightOk;
    };
    let best = null;
    for (const key of keys) {
      const kn = normalizeModelName(key);
      if (!kn || kn.length > norm.length) continue;
      if (boundaryHit(kn, norm) && (!best || kn.length > best.len)) best = { key, m: models[key], len: kn.length };
    }
    if (best) return { key: best.key, m: best.m };
  }
  return null;
}

// 本地官方价库路径自动发现（与 token-tracker.js autoDiscoverCnPriceDir 同序，镜像简化版）
function discoverCnPriceDb() {
  const cands = [];
  if (process.env.CN_PRICE_DB_DIR) cands.push(String(process.env.CN_PRICE_DB_DIR));
  try {
    const wsRoot = path.join(os.homedir(), 'WorkBuddy');
    let best = null, bestM = -1;
    for (const d of fs.readdirSync(wsRoot)) {
      const idx = path.join(wsRoot, d, 'prices', 'index.json');
      try {
        if (!fs.existsSync(idx)) continue;
        const m = fs.statSync(idx).mtimeMs;
        if (m > bestM) { bestM = m; best = idx; }
      } catch (e) { /* 单个目录失败不影响其它候选 */ }
    }
    if (best) cands.push(best);
  } catch (e) { /* ~/WorkBuddy 不存在 → 跳过该级 */ }
  cands.push(path.join(SKILL_DIR, 'prices', 'index.json'));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

// 本地官方价库合并镜像（与 mergeLocalPriceDb 同规则）：lock 永远赢；坏数据不收；
// 缓存价官方未列时保守按输入价计（宁高估不错账）。
function mergeLocalDbMirror(pricing) {
  const dbPath = discoverCnPriceDb();
  if (!dbPath) return pricing;
  let db = null;
  try { db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch (e) {
    process.stderr.write(`[backfill] ⚠️ 本地官方价库解析失败: ${dbPath}（该部分模型将无价可用）\n`);
    return pricing;
  }
  if (!pricing.models || typeof pricing.models !== 'object') pricing.models = {};
  const byAlnum = {};
  for (const key of Object.keys(pricing.models)) {
    const ak = alnumKey(key);
    if (ak && !byAlnum[ak]) byAlnum[ak] = key;
  }
  let n = 0;
  for (const [k, v] of Object.entries(db.models || {})) {
    if (!v || typeof v.in_price !== 'number' || typeof v.out_price !== 'number') continue;
    const ak = alnumKey(k);
    const existingKey = byAlnum[ak];
    if (existingKey && pricing.models[existingKey] && pricing.models[existingKey].lock === true) continue;
    const rec = {
      name: v.name || k,
      input_price: v.in_price,
      output_price: v.out_price,
      cached_price: (typeof v.cache_hit === 'number') ? v.cache_hit : v.in_price,
      region: 'CN',
      price_source: '本地官方库(' + String(v.primary_source || '').replace(/^本地官方库\(|\)$/g, '').slice(0, 40) + ')',
    };
    if (v.peak && v.peak.idle && v.peak.peak) {
      const i = Number(v.peak.idle.in), p = Number(v.peak.peak.in);
      if (i > 0 && p > 0) {
        const mult = Math.round((p / i) * 100) / 100;
        if (Math.abs(mult - 2) < 0.05) rec.peak_multiplier = 2;
        else if (mult) { rec.peak_multiplier = mult; rec.tier_note = '峰谷非整数倍(' + mult + '×)，需人工核验'; }
      }
    }
    if (existingKey) Object.assign(pricing.models[existingKey], rec);
    else { pricing.models[k] = rec; byAlnum[ak] = k; }
    n++;
  }
  process.stderr.write(`[backfill] 本地官方价库已合并 ${n} 条（${dbPath}）\n`);
  return pricing;
}

function main() {
  if (!fs.existsSync(PROJECTS)) {
    console.error(`[backfill] 找不到 transcript 目录: ${PROJECTS}`);
    process.exit(1);
  }
  try { _pricing = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { _pricing = { models: {} }; }
  try { _pricing = mergeLocalDbMirror(_pricing); } catch (e) { /* 合并失败沿用 pricing.json */ }

  const acc = {};            // date -> model -> stat
  const modelNames = new Set();
  const newWm = {};          // ledgerKey -> { main, subs:{f:lines} }
  let filesMain = 0, filesSub = 0;

  // 布局：projects/<项目目录>/<sid>.jsonl + projects/<项目目录>/<sid>/subagents/agent-*.jsonl
  //       （兼容根直放 projects/<sid>.jsonl）
  const projDirs = [];
  try { for (const d of fs.readdirSync(PROJECTS)) projDirs.push(d); } catch (e) { /* 空 */ }
  for (const d of projDirs) {
    const dp = path.join(PROJECTS, d);
    let st = null;
    try { st = fs.statSync(dp); } catch (e) { continue; }
    if (!st.isDirectory()) {
      if (/\.jsonl?$/.test(d)) { // 根直放布局（罕见）
        const rows = scanFile(dp, acc, modelNames);
        newWm['path-' + crypto.createHash('sha1').update(path.resolve(dp)).digest('hex').slice(0, 16)] = { main: rows, subs: {} };
        filesMain++;
      }
      continue;
    }
    for (const f of fs.readdirSync(dp)) {
      if (!/\.jsonl$/.test(f)) continue;
      const fp = path.join(dp, f);
      const sid = f.replace(/\.jsonl$/, '');
      const key = String(sid).trim() || ('path-' + crypto.createHash('sha1').update(path.resolve(fp)).digest('hex').slice(0, 16));
      const mainLines = scanFile(fp, acc, modelNames);
      filesMain++;
      const subs = {};
      const subDir = path.join(dp, sid, 'subagents');
      try {
        if (fs.existsSync(subDir)) {
          for (const sf of fs.readdirSync(subDir)) {
            if (!/^agent-.+\.jsonl$/i.test(sf)) continue;
            const sp = path.join(subDir, sf);
            subs[sf] = scanFile(sp, acc, modelNames);
            filesSub++;
          }
        }
      } catch (e) { /* 忽略 */ }
      // 与旧水位线逐键取 max（只许前进）
      newWm[key] = { main: mainLines, subs };
    }
  }

  // 合并旧水位线（max，防回退）
  let oldWm = {};
  try { oldWm = JSON.parse(fs.readFileSync(WATERMARK, 'utf-8')); } catch (e) {}
  const mergedWm = Object.assign({}, oldWm);
  for (const [k, v] of Object.entries(newWm)) {
    const o = mergedWm[k] || { main: 0, subs: {} };
    mergedWm[k] = {
      main: Math.max(o.main || 0, v.main),
      subs: Object.assign({}, o.subs, v.subs),
    };
    for (const [sf, n] of Object.entries(mergedWm[k].subs)) {
      mergedWm[k].subs[sf] = Math.max(n, (v.subs && v.subs[sf]) || n || 0);
    }
  }

  // 组装新账本（v3.19.0/P4：不再继承 _instructions——M3 已关闭"数据→指令"通道，旧账本残留字段
  // 会被原样带进新账本，等于把通道又开回来）
  let oldDaily = {};
  try { oldDaily = JSON.parse(fs.readFileSync(DAILY, 'utf-8')); } catch (e) {}
  const newDaily = {};
  const dates = Object.keys(acc).sort();
  for (const date of dates) {
    const models = acc[date];
    for (const m of Object.values(models)) m.hit = hitRate(m.in, m.cached);
    newDaily[date] = { models, total: dayTotalOf(models) };
  }

  // 当前账本对比
  const fmt = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(v));
  console.log(`===== backfill ${WRITE ? '--write（写入模式）' : 'dry-run（默认，不落盘）'} =====`);
  console.log(`扫描：主 transcript ${filesMain} 个，子代理 ${filesSub} 个，覆盖日期 ${dates.length} 天`);
  console.log('');
  let gTok = 0, gCost = 0, gOldCost = 0;
  for (const date of dates) {
    const t = newDaily[date].total;
    const oldT = oldDaily[date] && oldDaily[date].total;
    const oldCost = oldT ? (oldT.cost || 0) : 0;
    gTok += t.total; gCost += t.cost; gOldCost += oldCost;
    const delta = oldT ? `（现账本 ¥${oldCost.toFixed(2)}，差 ${oldCost ? ((t.cost - oldCost) / oldCost * 100).toFixed(1) : 'new'}%）` : '（现账本无此日）';
    console.log(`${date}  ${fmt(t.in)} in / ${fmt(t.out)} out / ${fmt(t.total)} tok / ¥${t.cost.toFixed(2)}  ${delta}`);
  }
  console.log('');
  console.log(`回填合计：${fmt(gTok)} tokens / ¥${gCost.toFixed(2)}（现账本同期合计 ¥${gOldCost.toFixed(2)}）`);
  console.log(`无价模型（只记 token 不记钱）：${[...modelNames].filter((n) => n !== 'unknown' && !findModel(_pricing, n, 'price')).join(', ') || '（无）'}`);
  if (!WRITE) {
    console.log('');
    console.log('这是 dry-run，未写任何文件。确认无误后执行：node backfill.js --write');
    return;
  }

  // --write：先备份，再落账本 + 水位线（原子写）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak1 = DAILY + '.bak-backfill-' + stamp;
  const bak2 = WATERMARK + '.bak-backfill-' + stamp;
  try { if (fs.existsSync(DAILY)) fs.copyFileSync(DAILY, bak1); } catch (e) {}
  try { if (fs.existsSync(WATERMARK)) fs.copyFileSync(WATERMARK, bak2); } catch (e) {}
  const tmp1 = DAILY + '.tmp-' + process.pid;
  fs.writeFileSync(tmp1, JSON.stringify(newDaily, null, 2) + '\n');
  fs.renameSync(tmp1, DAILY);
  const tmp2 = WATERMARK + '.tmp-' + process.pid;
  fs.writeFileSync(tmp2, JSON.stringify(mergedWm));
  fs.renameSync(tmp2, WATERMARK);
  console.log('');
  console.log(`✅ 已写入账本：${DAILY}`);
  console.log(`✅ 已推满水位线：${WATERMARK}（${Object.keys(mergedWm).length} 个会话键，逐键取 max 防回退）`);
  console.log(`备份：${bak1}`);
  console.log(`备份：${bak2}`);
}

main();
