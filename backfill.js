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
//   node backfill.js --write --force → 允许「账本写失败时把水位线回退到写入前」
//     （v3.61.0 审计 G4：默认**不回退**，只许单调递增 —— 回退会抹掉主链路并发推进的进展，
//      导致下轮重读已记账行 = 重复计费。确需回退才显式加 --force，并自行承担该风险）
//
// 语义与口径（与 token-tracker.js 增量记账严格对齐）：
// - usage 提取：extractUsage 同口径（usage / rawUsage / message.usage 三处落点 + 数值钳制取整）
// - 去重：同文件内按 messageId/conversationRequestId/id 去重（perModelFromRows 同口径）
// - 日期归属：行 timestamp + 8h 的北京时间日期（与 v2.39「本地时间日界」一致）
// - 费用：pricing.json 精确匹配模型名；行级按**行时间**判峰谷（工作日 9-12/14-18 北京时间 ×
//   peak_multiplier；周末与法定假日全天低峰——v3.15 同口径）。v3.57.0（H5）起：对主链路落有
//   at-time peakSplit 明细且六桶全覆盖的 (日期,模型)，改按**当时规则**的切分计价（详见组装循环
//   处注释）；明细缺失/部分覆盖 → 保持行级现值。匹配不到价的模型只记 token 不记钱
//   （与 addModelUsage 的 cost=null 行为一致）。
// - 水位线：写完后把每个扫描到的会话推满到当前行数（键=session_id，与 ledgerKey 一致），
//   并与旧水位线逐键取 max——未来的 Stop 增量记账从满水位继续，**不会重复计数**。
//
// 已知差异（如实标注）：
// - 「被中断思考」估算已包含（v2.52 镜像），但归属日期 = reasoning 行自身时间戳（增量版归记账当天），
//   且增量版的回溯基数可能与全量扫描略有差异 → 单日金额允许小幅出入。
// - 水位线键由 tt.ledgerKey(sid, path) 生成（v3.49.0 起改调用，原为本地内联 sha1 拼接）：
//   项目目录布局取文件名去扩展名（WorkBuddy 实际落盘即 session_id）、根直放布局同理；
//   文件名与 hook 的 session_id 不一致时（改版/外部改名）仍会各按各的键记账——该残差与主链路
//   自身的 sid 来源相同，不是本脚本独有，故不再试图在扫描侧"猜" session_id。

const fs = require('fs');
const peakRules = require('./peak-rules.js'); // v3.19.0（P1）：峰谷判定单一实现（原先这里硬编码 PEAK_RANGES，与官方动态时段脱节）
const path = require('path');
const os = require('os');
// v3.49.0（审计 C6）：crypto 导入已删——水位线键的两处内联 sha1 拼接改为调用 tt.ledgerKey 后，
//   本文件不再需要任何哈希。（保留无人使用的 import 会诱导下一个人继续在本地拼键。）
const { detectWorkBuddyRoot } = require('./wb-root.js'); // v3.42.0（plan-B B1）：数据根探测单点实现，已抽到 wb-root.js
const { mergeDailyLedger } = require('./ledger-merge.js'); // v3.55.0（S3）：账本合并抽成可单测纯函数
const { measureTranscriptLines } = require('./transc-lines.js'); // v3.61.0（审计 F2）：行数/残行口径单一实现（与主链共用）

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
// v3.57.0（审计批7·H5 修复）：复用 recalc-day.js 的 peakSplitOf —— 与 recalc 回算**同一函数、
//   同一数据文件**（rounds/rounds-YYYY-MM.jsonl），保证"当时规则"的切分全项目只有一处实现。
//   recalc-day.js 被 require 时不跑 main（:388 `require.main === module` 守卫），可安全 import。
const recalcDay = require(path.join(__dirname, 'recalc-day.js'));
// v3.45.0（审计 F-2 / P-20）：账本/水位线的**原子写单点**直接复用主脚本实现。
//   原回滚路径自带 fs.copyFileSync / fs.writeFileSync（非 tmp+rename）→ 回滚中途失败会留下半截账本，
//   且这是"写盘最容易失败的场景"（磁盘满/占用），半截概率不低。改成调用后，写盘方式全项目只有一处。
const saveLedgerRawAtomic = tt.saveLedgerRawAtomic;

const WRITE = process.argv.includes('--write');


// v3.59.0（审计 M25）：峰谷**降级可见性** —— 与 recalc-day.js（v3.58.0 批8-⑨）/ 主脚本
//   token-tracker.js isPeakHour（v3.32.0 H4）同款告警。backfill 是**第三条**独立计价路径
//   （主链路增量 / recalc 回溯 / backfill 重建），前两条都已有这条告警，唯独 backfill 没有：
//   假日数据未知/陈旧的年份在这里照样按「非假日」判定 → 真假日按高峰 ×2 多算、调休上班日按周末
//   低峰少算，**双向错且零提示**，而 backfill 恰恰是最常被拿去"重建整个账本"的那一把刀。
//   进程内每年至多 1 条 stderr（Set 去重，本函数在扫描循环里是热路径）。
const _holidayWarnedYears = new Set();
function isPeakBeijingTs(tsMs) {
  try {
    const yNow = new Date(tsMs + 8 * 3600e3).getUTCFullYear();
    if (!_holidayWarnedYears.has(yNow) && peakRules.holidayYearUnknown(tsMs, HOLIDAYS)) {
      _holidayWarnedYears.add(yNow);
      process.stderr.write(`[backfill] ⚠ ${yNow} 年法定假日数据未知或已陈旧 → 该年峰谷判定按「非假日」降级：真假日按高峰 ×2 多算、调休上班日按周末低峰少算；联网后跑 node refresh-holidays.js ${yNow} 可修复\n`);
    }
  } catch (e) { /* 告警失败绝不影响判定本身 */ }
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
//   physicalLines —— 物理行数（**含残行 +1**），仅供水位线使用。
// v3.19.2（B1 对齐）：水位线口径必须 = physicalLines。主脚本 v3.19.2 起 readTranscLinesFrom 的
//   totalLines 就是物理完整行数；此处若仍记「可解析行数」，空行/坏行会让记下的水位线比真实偏移小 k，
//   主脚本下一轮从偏早的偏移重读已计过的行 → 重复记账。
// v3.61.0（审计 F2，致命）：上一行注释说的「= 物理完整行数」只对了一半 —— 主链自 v3.42.0（A19）起，
//   末尾残行（无 '\n' 但 JSON.parse 成功）**既计入 rows 又让水位线 +1**；而本函数仍只数 '\n'。
//   → rows 收了残行（= 回填已经记了它的 token）、水位线却没盖住它 → 主链下一轮重读 = **双记**（钱量双错、静默）。
//   修法：行数口径收敛到 transc-lines.js 的单一实现，两侧都调它（本函数与主链 readTranscLinesFrom 共用），
//   由调用关系保证一致；下方 :248 那句「与主脚本 totalLines 同口径」的过期注释随之作废。
function readRows(fp) {
  let raw = '';
  try { raw = fs.readFileSync(fp, 'utf-8'); } catch (e) { return { rows: [], physicalLines: 0 }; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* 半写行跳过 */ }
  }
  return { rows, physicalLines: measureTranscriptLines(raw).lines };
}

// 成本：单行级计算（峰谷按行时间）；findModel 与主脚本同口径（归一化/去标点/边界匹配）
function rowCost(pricing, modelName, u, tsMs) {
  if (!modelName || modelName === 'unknown') return null;
  const hit = findModel(pricing, modelName, 'price');
  if (!hit) return null;
  const m = hit.m;
  if (typeof m.input_price !== 'number') return null;
  // v3.49.0（审计 B3）：峰谷倍率收敛到主脚本单点 tt.peakMultOf（calcCost / recalc-day 共用同一份）。
  //   改前这里是内联手抄（DeepSeek 缺省 2、其余缺省 1）——语义虽与单点等价，但"等价"只靠注释维护，
  //   peakMultOf 一侧改动（如新增厂商峰谷规则）不会传导到这里 → 回填与增量记账系统性分歧且零报错。
  //   收敛后口径由**调用关系**保证，不再有"复制实现靠注释同步"这最后一处。
  // v3.57.0（K1）：无峰谷模型结构性退出峰谷时段判定（只有 peakMultOf>1 才判时段）。
  //   改前所有模型都判 isPeakBeijingTs，无峰谷模型靠倍率 1 打平 = 时段表全局共享。
  const pm = tt.peakMultOf(m, modelName);
  const mult = pm > 1 && isPeakBeijingTs(tsMs) ? pm : 1;
  const inT = u.in || 0, cached = Math.min(u.cached || 0, inT), outT = u.out || 0;
  const uncached = Math.max(0, inT - cached);
  // v3.42.0（plan-B B1）：收敛到 token-tracker.js 单点实现 triPriceRounded（带 1e-6 四舍五入）
  return tt.triPriceRounded(inT, cached, outT, m, mult);
}
// v3.58.0（批8-②）：缓存命中率收敛到主脚本单点 tt.hitRate —— 本函数此前是**未钳制的复制**：
//   主脚本 v3.24.0 已把 hit 钳制到 [0,100]（脏数据 cached>in 会显示「>100%」的假报表），backfill 这份
//   没跟上 → 同一账本、同一批数据，重建出来的命中率与增量记账的不一致（A3「复制实现靠注释同步」的又一标本）。
//   ⚠️ 绝不能改成「累加时把 cached 钳到 ≤ in」：主链路累加侧同样不钳制，钳了会让两条路径的 cached
//   **token 硬账**不相等，违反本项目最高口径（token 量必须三路相等且可复算）。钳在**显示层**才是对的。
const hitRate = (inTok, cachedTok) => tt.hitRate(inTok, cachedTok);
// v3.59.1（审计批17·高危）：与 token-tracker.js:3403 dayTotalOf **逐字同构**。
//   改前本函数是 `t.cost += m.cost || 0` 且**无 null 守卫** —— 与批10（v3.58.0）在 recalc-day 里
//   干掉的四处完全同族，而后果更重：本函数的返回值经 ledger-merge.js `mergeDailyLedger` 的
//   `total: dayTotalOf(m)` **直接写进 daily-usage.json**：
//     ① 旧账本某 (日期,模型) 的 cost 是脏字符串 → 重放抓不到 → 保留并打 stale_carried →
//        `0 + "0.51.2"` 字符串拼接 → total.cost 以字符串形态落盘 → 报表 `(total.cost > 0)`
//        是 NaN 比较恒 false → **该日金额整天显示 ¥0.00（钱静默消失）**；
//     ② 账本一条 `"某模型": null` → `m.in` 抛 TypeError → **崩在 backfill 的文件锁内**。
//   token-tracker.js 那份 v3.24.0（级联⑪）就有 null 守卫、本份一直没有 —— A3「复制实现靠注释
//   同步」的又一标本，本次连同数值归一一次对齐。
//   ⚠️ 五字段的数值归一统一走 `tt.numOr0`（token-tracker.js:3403 导出），**不许本地再抄一份**：
//     抄了就会再次漂移（同类漂移已记 KI-29）。
function dayTotalOf(models) {
  const t = { in: 0, out: 0, cached: 0, total: 0, cost: 0 };
  for (const m of Object.values(models || {})) {
    if (!m || typeof m !== 'object') continue; // v3.59.1：与 token-tracker.js:3405 同构（null 条目曾让主脚本报表全线 TypeError）
    t.in += tt.numOr0(m.in); t.out += tt.numOr0(m.out); t.cached += tt.numOr0(m.cached); t.total += tt.numOr0(m.total);
    t.cost += tt.numOr0(m.cost);
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
    try { if (c && fs.existsSync(c)) return c; } catch (e) {} // silent-ok:探测 — Python 候选探测，未命中即试下一个
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

  // v3.29.0（S-1 加固）：扫描窗口账本指纹 —— 在**开始递归扫描之前**记录。锁只能保证「写入原子」，
  //   保证不了「扫描内容含最新行」：若主链路在 backfill 读完某 transcript 之后、本进程写盘之前才把
  //   当轮 usage 写进当天账本，该轮不在 newDaily 的同日期桶里，会被 Object.assign 直接覆盖，而水位线
  //   照推 → 永久丢失。故扫描前记 size/mtimeMs，锁内写盘前再比对，不一致即中止本次写入。
  const preStat = (() => { try { const s = fs.statSync(DAILY); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { return null; } })();

  // 布局：projects/<项目目录>/<sid>.jsonl + projects/<项目目录>/<sid>/subagents/agent-*.jsonl
  //       （兼容根直放 projects/<sid>.jsonl）
  const projDirs = [];
  try { for (const d of fs.readdirSync(PROJECTS)) projDirs.push(d); } catch (e) { /* 空 */ }
  for (const d of projDirs) {
    const dp = path.join(PROJECTS, d);
    let st = null;
    try { st = fs.statSync(dp); } catch (e) { continue; }
    if (!st.isDirectory()) {
      if (/\.jsonl?$/.test(d)) { // 根直放布局（罕见，projects/<sid>.jsonl）
        const rows = scanFile(dp, acc, modelNames);
        // v3.49.0（审计 C6）：水位线键改调主脚本单点 tt.ledgerKey（原为本地内联 sha1 拼接）。
        //   根直放布局下主链路用 sid 作键（hook 的 session_id 恒有值），此处却用 path-hash →
        //   backfill 推满的键主链路不认 → 主链路按自己的键从旧偏移重读 = 重复计费。
        //   根直放布局的文件名即 sid（与项目目录布局同构），故取文件名去扩展名传入。
        const sidRoot = d.replace(/\.jsonl?$/, '');
        newWm[tt.ledgerKey(sidRoot, dp)] = { main: rows, subs: {} };
        filesMain++;
      }
      continue;
    }
    for (const f of fs.readdirSync(dp)) {
      if (!/\.jsonl$/.test(f)) continue;
      const fp = path.join(dp, f);
      const sid = f.replace(/\.jsonl$/, '');
      // v3.49.0（审计 C6）：同上——本地内联 `sid || sha1(path)` 与主脚本 ledgerKey 契约仅靠注释同步，
      //   一侧改键规则另一侧不传导 → 同一次回填写出两个键、各按各的重读。改为调用后由单点保证。
      const key = tt.ledgerKey(sid, fp);
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
  try { oldWm = JSON.parse(fs.readFileSync(WATERMARK, 'utf-8')); } catch (e) {} // silent-ok:降级 — 旧水位线读取失败即视为空（下面会重建）
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
  try { oldDaily = JSON.parse(fs.readFileSync(DAILY, 'utf-8')); } catch (e) {} // silent-ok:降级 — 旧账本读取失败即视为空（上面已确认存在才进这里）
  const newDaily = {};
  const dates = Object.keys(acc).sort();
  // v3.57.0（审计批7·H5 修复）：**历史日按当时规则计价**（at-time peak split）
  //   病根：rowCost 逐行用 isPeakBeijingTs(ts) 判峰谷——那是**当前** pricing.deepseek_rules 的
  //   口径。厂商调整峰谷时段后，拿它重算全部历史行，同一历史日的金额会与 recalc-day.js（读 rounds
  //   明细里主链路**当时**落下的 peakSplit 六桶）系统性分叉（审计实证差 2 倍：¥0.0024 vs ¥0.0048）。
  //   修法：主链路 appendRoundDetail 已按每行当时的峰谷切好六桶（pIn/pCached/pOut/oIn/oCached/oOut）。
  //   这里对每个 (date, model) 读回该切分，**全覆盖才采用**——三对桶加总与行级累加完全相等，
  //   证明明细覆盖了当天全部用量，不存在"只给部分轮次按当时规则定价"的半吊子状态；对不上即保持
  //   行级现值（旧日期无明细 / 中断补偿估算段无明细 / 明细被 prune），与 v3.56.0 及以前行为一致。
  //   无公开价模型同样不动（findModel 失败即跳过）——与 rowCost 返回 null 的语义一致。
  for (const date of dates) {
    const models = acc[date];
    for (const m of Object.values(models)) m.hit = hitRate(m.in, m.cached);
    for (const [name, st] of Object.entries(models)) {
      if (!(st.in || st.out)) continue; // 零用量行（防御；cached ≤ in 钳制下 cached 不可能独存）
      const split = recalcDay.peakSplitOf(date, name);
      if (!split) continue; // 无 at-time 明细 → 行级现值
      if (split.pIn + split.oIn !== st.in
       || split.pOut + split.oOut !== st.out
       || split.pCached + split.oCached !== st.cached) continue; // 非全覆盖 → 行级现值
      const hit = findModel(_pricing, name, 'price');
      if (!hit || typeof hit.m.input_price !== 'number') continue; // 无价模型只记 token 不记钱
      const c = tt.costFromPeakSplit(hit.m, split, tt.peakMultOf(hit.m, name));
      if (c != null) st.cost = Math.round(c * 1e6) / 1e6;
    }
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

  // v3.29.0（S-1 修复）：账本写入必须与主链路 recordUsage（token-tracker.js）共用**同一把锁**。
  //   DAILY + '.lock' 即 DAILY_USAGE_FILE + '.lock'（两者都解析到 skills/token-usage-tracker/daily-usage.json），
  //   锁路径不一致就锁不住主链路，等于没加锁。
  //   原实现零锁直写：backfill 要递归扫描 projects/**/*.jsonl（本机数百文件），全程不持锁 —— TOCTOU 窗口极大。
  //   扫描期间用户正常对话 → Stop hook 持锁累加本轮增量并落盘 → backfill 扫描完再 rename 覆盖 → 本轮及窗口内
  //   所有增量被整体抹除，而水位线已被推满（下面几步），这些消耗永久无法恢复。
  //   锁内**重读账本再合并**：重放结果覆盖同日期，同时保留账本里重放不到的日期（如 transcript 已删除、旧日期）。
  // v3.29.0（S-1 加固）：锁内写盘前再比对 preStat 指纹（见扫描前注释）——扫描窗口内账本被改过即中止。
  //   备份 bak1/bak2 放在锁内、指纹比对**之后**（仍在本工具写盘之前）：这样中止分支不会留下多余的
  //   *.bak-backfill-* 残留，且备份内容更贴近真实写入前状态。
  // ══ 提交阶段（v3.48.0 审计 S1：提交顺序倒置为「先水位线、后账本」）══
  //   病根（原顺序先账本、后水位线）：两步 rename 之间进程被杀（SIGKILL / 断电 / 未捕获异常）时，
  //   账本已是**全量重建值**而水位线仍是**旧偏移** → 主链路 incrementalRecord 按旧水位线把全部
  //   历史行再累加一遍 → 重建值 + 重放增量 = 重复计费，且**零报错、不可恢复**。
  //   这与项目"宁可少记不重记"的哲学正好相反：原写入顺序在崩溃时给出的是**最坏方向**。
  //   倒置后崩溃只剩「水位线已推满、账本还是旧值」= 少记（重跑 backfill 即恢复），与哲学同向。
  //   代价：账本写失败/被并发改时，必须把水位线回滚到 bak2（写入前快照）——回滚丢的只是扫描窗口内
  //   主链路已推进的那部分，下轮重放 = 少记，同样可恢复。
  //   两把锁仍分开取（主链路从不嵌套持两把锁，无锁序死锁风险）；每把锁内只做一次 rename，
  //   持握时间几十毫秒，主链路最多多等一个 retryDelay。

  // 步骤 A（DAILY 锁）：中止判定（扫描窗口内账本是否被改过）+ 写入前备份。
  //   备份必须早于任何写入：步骤 C 失败时要靠 bak2 回滚水位线。
  const preLock = tt.withFileLock(DAILY + '.lock', () => {
    const st = (() => { try { const s = fs.statSync(DAILY); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { return null; } })();
    if (preStat === null) {
      if (st !== null) return { aborted: true }; // 扫描前账本不存在：锁内已被创建 → 视为扫描期间被改
    } else if (st === null || st.size !== preStat.size || st.mtimeMs !== preStat.mtimeMs) {
      return { aborted: true }; // size 或 mtimeMs 任一不同 → 扫描期间有进程写过账本（Windows 上 mtimeMs 精度足够直接 !== 比较）
    }
    // v3.58.0（批8-③）：顺带记录「写入前水位线是否存在」——步骤 C 失败回滚时要靠它区分
    //   「无需回滚」与「回滚失败」，否则文案只能二选一，必然对一半（见 rollbackWatermark）。
    const wmExists = fs.existsSync(WATERMARK);
    try { if (fs.existsSync(DAILY)) fs.copyFileSync(DAILY, bak1); } catch (e) {} // silent-ok:清理 — 备份失败不阻断回填（备份是尽力而为）
    try { if (wmExists) fs.copyFileSync(WATERMARK, bak2); } catch (e) {} // silent-ok:清理 — 同上
    return { aborted: false, stat: st, wmExists };
  }, { ttl: 600000, retries: 50 }); // ttl/retries 放宽：回填扫描长、持锁久，给足重试等待
  if (!preLock || !preLock.ok) {
    // 抢锁失败：绝不无锁续写，否则又退回「整体覆盖丢增量」老问题
    console.error('[backfill] 账本正被占用（WorkBuddy 可能正在运行），请先退出 WorkBuddy 再执行 backfill --write');
    process.exit(1);
  }
  if (preLock.result && preLock.result.aborted) {
    // 扫描窗口内账本被改：本次可能漏掉新写入的当天增量，直接覆盖＝永久丢失；什么都不要写
    console.error('[backfill] 扫描期间账本已被其他进程修改（WorkBuddy 可能正在记账中），为避免覆盖造成不可恢复的丢失，本次写入已中止；请退出 WorkBuddy 后重试');
    process.exit(1);
  }
  const baseStat = preLock.result.stat; // 步骤 C 的指纹基线：A→C 之间无人改动才算数
  const wmExisted = preLock.result.wmExists === true; // v3.58.0（批8-③）：回滚文案的判据之一

  // 步骤 B（WATERMARK 锁）：**先**写水位线 —— 与主链路 incrementalRecord 共用**同一把锁**
  //   （WATERMARK + '.lock' 即 token-tracker.js 的 LEDGER_WATERMARK_FILE + '.lock'），
  //   锁内「重读现值 → 逐键取 max → 原子写」。
  //   原先是锁外整份覆盖：backfill 在扫描后才读 oldWm，而扫描期间主链路一直在记账并推水位线，
  //   主链路在读取之后推的会话键/行数不在 mergedWm 里 → 被整份覆盖 → 水位线**回退** → 下轮主链路从
  //   偏早偏移重读已记账的行 → **重复计费**（历史教训：v2.99 实测 .bak 回退造成重放增量 5500 in / 1600 out）。
  //   「只许前进，绝不回退」的理由：水位线偏低 = 少记（可恢复），水位线回退 = 重记（不可恢复地多收费）；
  //   宁可少记不重记，与主链路 incrementalRecord 的 `if (!recorded) return` 同一哲学。
  //   合并保留四层字段 {main, subs, lastTs, subTs}（v3.25.0 KI-5：丢 lastTs/subTs = 截断恢复退化为冻结）。
  const wmRes = tt.withFileLock(WATERMARK + '.lock', () => {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(WATERMARK, 'utf-8')) || {}; } catch (e) { cur = {}; }
    const out = Object.assign({}, cur); // 主链路可能新增会话键：以现值打底，逐键用 max 抬升、绝不删键
    for (const [k, v] of Object.entries(mergedWm)) {
      const o = out[k] || { main: 0, subs: {}, lastTs: 0, subTs: {} };
      const subs = Object.assign({}, o.subs || {});
      for (const [sf, n] of Object.entries(v.subs || {})) subs[sf] = Math.max(subs[sf] || 0, n);
      const subTs = Object.assign({}, o.subTs || {});
      for (const [sf, t] of Object.entries(v.subTs || {})) subTs[sf] = Math.max(subTs[sf] || 0, t);
      out[k] = {
        main: Math.max(o.main || 0, v.main || 0),
        subs,
        lastTs: Math.max(o.lastTs || 0, v.lastTs || 0),
        subTs,
      };
    }
    const tmp2 = WATERMARK + '.tmp-' + process.pid;
    fs.writeFileSync(tmp2, JSON.stringify(out));
    fs.renameSync(tmp2, WATERMARK);
    return out;
  }, { ttl: 300000, retries: 50 });
  if (!wmRes || !wmRes.ok) {
    // v3.48.0：水位线没写成时**账本还没动过**，本次整体作废即可，不需要任何回滚。
    //   （原顺序下这里必须回滚账本到 bak1，正因为账本已经先写了——顺序倒置后这个危险分支消失。）
    console.error('[backfill] 水位线正被占用（WorkBuddy 可能正在运行），本次回填已作废（账本未改动）；请退出 WorkBuddy 后重试');
    process.exit(1);
  }

  // v3.48.0：账本没写成时回滚水位线到 bak2（写入前快照）。
  //   ⚠ 必须接返回值：saveLedgerRawAtomic 内部 catch 后**返回 false 而不抛**（与 copyFileSync 不同）；
  //     照旧写成"调完就置 true"，回滚实际失败时标志却说成功 → 告警文案会谎报"已回滚"。
  //   不回滚账本：此时账本根本没被本次改动过，保持原样即可（也不要写 {}——那是旧代码针对
  //   "账本已写、要撤销"的分支，现在不存在这种情形）。
  const rollbackWatermark = (why) => {
    let restored = false;
    // v3.58.0（批8-③）：水位线是本次新建（写入前不存在）时 bak2 必然不存在 —— 那是「无需回滚」，不是失败。
    let needless = false;
    // v3.61.0（审计 G4）：默认**不回退**水位线（只许单调递增），确需回退要显式 `--force`。
    //   bak2 是步骤 B 写入**前**的快照，而写入后主链路可能已并发推高水位线（backfill 与主链
    //   并发推进是常态）→ 原样恢复 bak2 会把主线进展一并抹掉 = 水位线**回退** → 下轮主链从
    //   偏早偏移重读**已记账**的行 → **重复计费**（不可恢复地多收费）。
    //   放任不一致的后果相反，是**少记**（主链按推高的水位线跳过这些行，重跑 backfill 即恢复）——
    //   与写入侧逐键 max 同一哲学：**宁可少记，不重记**。
    let keptMonotonic = false;
    try {
      if (fs.existsSync(bak2)) {
        if (process.argv.includes('--force')) {
          restored = saveLedgerRawAtomic(WATERMARK, fs.readFileSync(bak2));
        } else {
          keptMonotonic = true;
        }
      }
      else if (!wmExisted) needless = true;
    } catch (e) {} // silent-ok:降级 — 回滚是尽力而为，失败由下方告警兜底
    // v3.58.0（批8-③）：改前只有「已回滚 / 回滚失败」两态 → 首次回填（原本无水位线）时 bak2 必不存在，
    //   于是**必定**落到「回滚失败！请手动用 .bak-backfill-* 还原」= 谎报故障：其实没有任何东西要还原，
    //   用户照着做反而可能把别处的备份盖进来。现在三态，把「无需回滚」讲清楚。
    // v3.61.0（审计 G4）：再加第四态「未回退（默认单调）」—— 回退本身在这里是**更危险**的那个选项。
    const rollbackState = restored ? '已回滚到写入前状态（--force，已承担水位线回退→重复计费的风险）'
      : (keptMonotonic ? '未回退（默认单调递增：回退会抹掉主线并发推进的进展 → 重复计费；'
        + '保留现值只会少记，重跑 backfill 即恢复。确需回退请显式加 --force）'
        : (needless ? '无需回滚（水位线文件是本次新建的，原本不存在）'
          : '回滚失败！请手动用 .bak-backfill-* 还原'));
    console.error('[backfill] ' + why + '，本次回填已作废；水位线'
      + rollbackState
      + '（放任水位线与账本不一致的后果是**少记**而非多收：主链路会按推高的水位线跳过这些行，重跑 backfill 即恢复）；请退出 WorkBuddy 后重试');
  };

  // 步骤 C（DAILY 锁）：**后**写账本。与主链路 recordUsage 共用**同一把锁**
  //   （DAILY + '.lock' 即 DAILY_USAGE_FILE + '.lock'，两者都解析到 skills/token-usage-tracker/daily-usage.json；
  //    锁路径不一致就锁不住主链路，等于没加锁）。锁内**重读账本再合并**：重放结果覆盖同日期，
  //    同时保留账本里重放不到的日期（如 transcript 已删除、旧日期）。
  //   锁内还要**再比对一次指纹**（基线是步骤 A 的快照）：A→C 之间又有进程写过账本 → 本次的整体
  //   重建会覆盖那些增量 → 中止，并把步骤 B 已推高的水位线回滚到 bak2。
  const lockRes = tt.withFileLock(DAILY + '.lock', () => {
    const postStat = (() => { try { const s = fs.statSync(DAILY); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { return null; } })();
    if (baseStat === null) {
      if (postStat !== null) return { aborted: true };
    } else if (postStat === null || postStat.size !== baseStat.size || postStat.mtimeMs !== baseStat.mtimeMs) {
      return { aborted: true };
    }
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(DAILY, 'utf-8')); } catch (e) { cur = {}; }
    // v3.55.0（审计批5·S3）：日期级整块替换 → **模型级 merge**（纯函数已抽到 ledger-merge.js，可单测）。
    //   旧式 `Object.assign({}, cur, newDaily)` 的 key 是日期 → 同日期整块被 newDaily 顶掉：
    //   某模型的用量只存在于已删除/归档的 transcript（重放抓不到）时，账本里该模型当天的量被抹掉。
    //   :270-274 的扫描指纹比对（+锁内二次比对）只缓解了「扫描期间新写入被覆盖」，管不了这一路。
    const { merged: mergedDaily, carriedSummary } = mergeDailyLedger(cur, newDaily, dayTotalOf);
    if (carriedSummary.length > 0) {
      console.error('[backfill] 已保留重放未覆盖的旧模型记录（标记 stale_carried）：' + carriedSummary.join('、')
        + '；这些用量来自本次扫描不到的 transcript（已删除/归档），保留以免被整块覆盖抹掉');
    }
    const tmp1 = DAILY + '.tmp-' + process.pid;           // 保留原临时文件名（不与主链路共享固定名）
    fs.writeFileSync(tmp1, JSON.stringify(mergedDaily, null, 2) + '\n');
    fs.renameSync(tmp1, DAILY);
    return mergedDaily;
  }, { ttl: 600000, retries: 50 }); // ttl/retries 放宽：回填扫描长、持锁久，给足重试等待
  if (!lockRes || !lockRes.ok) {
    rollbackWatermark('账本正被占用');
    process.exit(1);
  }
  if (lockRes.result && lockRes.result.aborted) {
    rollbackWatermark('写入前账本又被其他进程修改');
    process.exit(1);
  }
  // v3.33.0（第四轮审计 B 系列）：`.bak-backfill-*` **有界保留**。
  //   病根：每次 --write 落一对备份（账本 + 水位线），文件名带 ISO 时间戳 → **线性堆积**、全仓无任何清理。
  //   虽非高频操作，但确实没有上界。账本本身只有几十 KB，留最近 5 对足够回溯（真要反查更早状态，
  //   用最近一次即可；再往前的备份只会无限占位）。
  //   只清理**本工具自己产生**的文件名（严格前缀匹配 DAILY / WATERMARK 的 basename），不碰用户其他文件；
  //   时间戳里的 `:`/`.` 已被替换成 `-` → 文件名字典序 == 时间序，直接 sort 取尾部即可。
  //   任何失败一律静默：清理失败不影响"本次回填已成功"这一事实，下次运行会再清。
  try {
    const KEEP_BAK = 5;
    const dir = path.dirname(DAILY);
    for (const prefix of [path.basename(DAILY), path.basename(WATERMARK)].map((b) => b + '.bak-backfill-')) {
      const olds = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - KEEP_BAK))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 占用/权限：静默，下次再清 */ }
      }
    }
  } catch (e) { /* 清理失败不影响回填结果 */ }
  console.log('');
  console.log(`✅ 已写入账本：${DAILY}`);
  console.log(`✅ 已推满水位线：${WATERMARK}（${Object.keys(wmRes.result).length} 个会话键，逐键取 max 防回退）`);
  console.log(`备份：${bak1}`);
  console.log(`备份：${bak2}`);
}

// v3.59.1（审计批17）：`main()` 加 require.main 守卫 + 导出 dayTotalOf。
//   改前是无条件 `main()` → 被 require 就会真跑一遍全盘扫描（可能写盘）→ selftest 只能靠 spawn
//   做行为验证，而 spawn 型用例在 CI/受限环境里会 envSkip（覆盖缺口）。加上守卫后可安全 import，
//   与 recalc-day.js:388 同一模式（backfill.js:68 的注释早就这么写了，实现没跟上）。
if (require.main === module) main();
module.exports = { dayTotalOf };
