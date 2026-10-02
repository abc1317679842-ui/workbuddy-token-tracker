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

// v3.19.2（B5）：复用主脚本，不再自带价库合并 / findModel 镜像。
// 「复制实现靠注释约束同步」正是 P1（峰谷口径分裂）的病根——镜像缺了并发半写重读、tier_note 等
// 三处逻辑，且此后每次改主实现都要人肉同步。这里在主脚本 require **之前**显式对齐两个路径口径
// （主脚本在 require 时即完成 CN_PRICE_DIR 解析），再直接用它的 mergeLocalPriceDb / findModel。
if (!process.env.WB_ROOT) process.env.WB_ROOT = WB;
if (!process.env.CN_PRICE_DB_DIR) {
  // 仅当调用方未显式指定时自动发现并「钉住」价库目录——保证主脚本 require 时解析到同一目录，
  // 避免两侧各扫一次目录却落在不同候选上。（若调用方已设 CN_PRICE_DB_DIR，两侧都直接用它。）
  try {
    const dbFile = discoverCnPriceDb();
    if (dbFile) process.env.CN_PRICE_DB_DIR = path.dirname(dbFile);
  } catch (e) { /* 发现失败 → 主脚本自带的多级发现逻辑兜底 */ }
}
const tt = require(path.join(__dirname, 'token-tracker.js'));
const normalizeModelName = tt.normalizeModelName;
const findModel = tt.findModel;

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

// 读 jsonl：返回 { rows, physicalLines }。
//   rows —— 容错跳过空行/半写行的可解析行（与 readTranscLines 同口径，供统计用）；
//   physicalLines —— 文件内 '\n' 累计数（**物理完整行数**），仅供水位线使用。
// v3.19.2（B1 对齐）：水位线口径必须 = physicalLines。主脚本 v3.19.2 起 readTranscLinesFrom 的
//   totalLines 就是物理完整行数；此处若仍记「可解析行数」，空行/坏行会让记下的水位线比真实偏移小 k，
//   主脚本下一轮从偏早的偏移重读已计过的行 → 重复记账。
function readRows(fp) {
  let raw = '';
  try { raw = fs.readFileSync(fp, 'utf-8'); } catch (e) { return { rows: [], physicalLines: 0 }; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* 半写行跳过 */ }
  }
  return { rows, physicalLines: (raw.match(/\n/g) || []).length };
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

// 扫描单个 transcript 文件（主或子代理），把 usage 行归入 acc[date][model]，返回水位线值
function scanFile(fp, acc, modelNames) {
  const { rows, physicalLines } = readRows(fp);
  const seen = new Set();
  for (const r of rows) {
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
    // v3.27.0：无公开价模型（pricing_status:'unpublished'）留痕 no_price —— 与主脚本
    //   addModelUsage 同口径。漏了它，backfill --write 重建出来的账本会把无公开价模型显示成
    //   ¥0.00（读成"免费"），正是 v3.27.0 要消灭的那种静默误导。
    if (isNoPublicPrice(name)) m.no_price = true;
  }
  // v2.52 中断补偿（按日期归属）：与增量记账同口径，被中断的思考也补进账本
  estimateInterruptedToDate(rows, acc);
  return physicalLines; // v3.19.2（B1）：水位线 = 物理完整行数（'\n' 累计），与主脚本 totalLines 同口径
}

let _pricing = { models: {} };

// v3.27.0：该模型在价库中是否标了「厂商未公布按 token 单价」。走 findModel 宽松匹配，
//   与主脚本 toastLine2 / addModelUsage 的判定口径一致（避免同一模型两处结论不同）。
function isNoPublicPrice(name) {
  try {
    const hit = tt.findModel(_pricing, name, 'price');
    return !!(hit && hit.m && hit.m.pricing_status === 'unpublished');
  } catch (e) { return false; }
}

// v3.19.2（B5）：normalizeModelName / findModel 已改为直接复用主脚本导出（见文件顶部 require 块），
// 原先这里手抄的三件镜像（normalizeModelName / alnumKey / findModel）已删除——「命名/匹配口径」由
// 主脚本单一实现，回填与增量记账再不会因一侧改动而分叉。
//
// 本地官方价库路径自动发现（与 token-tracker.js autoDiscoverCnPriceDir 同序；仅用于 require 前
// 对齐 CN_PRICE_DB_DIR，合并工作本身已交给主脚本的 mergeLocalPriceDb）
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

// v3.19.2（B5）：本地官方价库合并已改为调用主脚本 tt.mergeLocalPriceDb（含并发半写重读、tier_note 等
// 全部逻辑），原先这里的 mergeLocalDbMirror 手抄镜像已删除。

function main() {
  if (!fs.existsSync(PROJECTS)) {
    console.error(`[backfill] 找不到 transcript 目录: ${PROJECTS}`);
    process.exit(1);
  }
  try { _pricing = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { _pricing = { models: {} }; }
  // v3.19.2（B5）：复用主脚本的价库合并（口径与增量记账完全一致）
  try { _pricing = tt.mergeLocalPriceDb(_pricing); } catch (e) { /* 合并失败沿用 pricing.json */ }

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
      // v3.25.0（KI-5）：保真截断恢复判据（backfill 的 v 无这些字段，Math.max 兜底继承旧值）。
      // 若在此处丢弃 lastTs/subTs，--write 后截断恢复退化为「保持冻结」（旧水位线无判据）。
      lastTs: Math.max(o.lastTs || 0, v.lastTs || 0),
      subTs: Object.assign({}, o.subTs || {}, v.subTs || {}),
    };
    for (const [sf, n] of Object.entries(mergedWm[k].subs)) {
      // v3.24.0（级联⑥）：修复恒等 no-op —— 原式 `Math.max(n, (v.subs && v.subs[sf]) || n || 0)`
      // 在 sf 来自 v.subs（新值）时：n === v.subs[sf] → 恒等 max(n,n)=n，**旧值 o.subs[sf] 被完全忽略**
      // → 回填范围小于已有水位时（旧账已读到 1000 行、本次回填只到 500），合并结果回退到 500
      // → 下次正常记账从 500 行重读 → 子代理部分双计。正确语义就是新旧取大。
      mergedWm[k].subs[sf] = Math.max(n, o.subs[sf] || 0);
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
