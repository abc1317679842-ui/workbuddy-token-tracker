#!/usr/bin/env node
// recalc-day.js —— 账本回溯重算工具（v2.93 附带，独立进程，不侵入 token-tracker.js 主链路）
//
// 用途：新模型价格补录之后，把当天曾按「未收录」记成 ¥0 的历史数据，按现价 + 峰谷重算。
//      没有这个工具时，补录只能让「之后的消耗」计上价，当天之前的部分永远是 0，账本失真。
//
// v3.24.0 行为变更（级联④）：**峰谷占比拿不到时不再改写已有金额** ——
//   原账 > 0 → 保留原额（报告不列，避免把历史金额悄悄改写成空闲口径）；
//   原账 = 0 → 按空闲价补记（本工具的核心用途：¥0 欠账补价，低估可接受且报告会标注）。
//
// 用法：
//   node recalc-day.js                  → 重算今天（全部有价模型）
//   node recalc-day.js 2026-09-10       → 重算指定日期
//   node recalc-day.js 2026-09-10 deepseek-v4.1-flash
//
// 峰谷判定：读 toast 日志里该模型当天的轮次时间戳，按「工作日 9:00-12:00 / 14:00-18:00（北京）」
//          判定高峰；按轮次数占比近似 token 占比（同一天内轮次分布不均时会有少量误差，日志中会标注）。
// 数据来源：daily-usage.json（总量）+ token-tracker-toast.log（轮次时间）+ pricing.json（现价）

const fs = require('fs');
const path = require('path');
const os = require('os');
const peakRules = require('./peak-rules.js'); // v3.19.0（P1）：峰谷判定单一实现（原先硬编码时段，与官方动态时段脱节）
const { detectWorkBuddyRoot } = require('./wb-root.js'); // v3.42.0（plan-B B1）：数据根探测单点实现，已抽到 wb-root.js

const WB = process.env.WB_ROOT || detectWorkBuddyRoot();
const SKILL_DIR = path.join(WB, 'skills', 'token-usage-tracker');
const DAILY = path.join(SKILL_DIR, 'daily-usage.json');
const PRICING = path.join(SKILL_DIR, 'pricing.json');
const TOAST_LOG = path.join(WB, 'token-tracker-toast.log');
const HOLIDAYS = path.join(SKILL_DIR, 'holidays.json'); // v3.19.0：假日表传给 peak-rules（口径唯一）


// v3.19.0（P2/P6）：复用主脚本的原子写（saveDailyUsageRaw）与本地官方价库合并（mergeLocalPriceDb），
// 不再自制写盘、不再漏合并本地库。显式对齐 WB_ROOT，保证子模块的路径口径与本工具一致。
if (!process.env.WB_ROOT) process.env.WB_ROOT = WB;
const tt = require(path.join(__dirname, 'token-tracker.js'));


// v3.58.0（批8-⑨）：峰谷**降级可见性** —— 与主脚本 token-tracker.js isPeakHour（v3.32.0 H4）同款告警。
//   recalc 是**独立路径**，从不经过主脚本的 isPeakHour，所以主脚本那条告警对回溯重算完全无效：
//   假日数据未知/陈旧的年份在这里照样按「非假日」判定，双向错（真假日按高峰 ×2 多算、
//   调休上班日按周末低峰少算）且零提示。进程内每年至多 1 条 stderr（Set 去重，本函数是热路径）。
const _holidayWarnedYears = new Set();
function isPeakBeijing(iso, pricing) {
  const tMs = new Date(iso).getTime();
  try {
    const yNow = new Date(tMs + 8 * 3600e3).getUTCFullYear();
    if (!_holidayWarnedYears.has(yNow) && peakRules.holidayYearUnknown(tMs, HOLIDAYS)) {
      _holidayWarnedYears.add(yNow);
      process.stderr.write(`[recalc-day] ⚠ ${yNow} 年法定假日数据未知或已陈旧 → 该年峰谷判定按「非假日」降级：真假日按高峰 ×2 多算、调休上班日按周末低峰少算；联网后跑 node refresh-holidays.js ${yNow} 可修复\n`);
    }
  } catch (e) { /* 告警失败绝不影响判定本身 */ }
  return peakRules.isPeakAt(tMs, pricing, HOLIDAYS);
}

// v3.58.0（批8-①）：账本 cost 的**安全取值**——非有限数（NaN / "abc" / undefined / null）一律归一为 0。
//   病根：`dayTotal += stat.cost` 用的是 `+` 而不是「数值累加」——只要账本里某条 cost 是**字符串**
//   （旧版本写入 / 外部手改 / 导入脏数据），就变成字符串拼接：
//       0 + "0.5"        → "00.5"（字符串）
//       "00.5" + "1.2"   → "00.51.2"（字符串，数值上已完全错误）
//       Math.round("00.51.2" * 1e6) → NaN → 当日合计落盘 NaN，**不抛错、不自愈**（下轮读到仍是 NaN）。
//   归一为 0 后：脏条目被判成「原账 0」→ 由上游补出正确金额并回写（L323）→ 账本**自愈**。
//   与 v3.24.0「原账 > 0 保留原额」的语义不冲突：脏值不是"原额"，它根本不是一个金额。
function safeCost(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// toast 行1 形如「<模型名>[ 时段标注][｜⚠无公开价][（子代理 X）]」——模型名永远在最前
//   （主脚本 toastLine1：head=模型显示名，其后依次拼空格时段标注 / ｜标签 / 全角括号子代理段）。
//   取首段得到模型名；后面那些是**标注**，不是模型名的一部分。
function toastHeadModel(text) {
  return String(text || '').split('\n')[0].split(/[\s（｜]/)[0].trim();
}

// 两个名字是否同一个模型（大小写/首尾空格/连续空格差异视为同一个；口径同主脚本）
function sameModelName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return tt.normalizeModelName(a) === tt.normalizeModelName(b); } catch (e) { return false; }
}

// v3.31.0（审计 P1-15 真缺陷侧）：**一行 toast 只能归属一个模型** —— 整名优先，前缀兜底时取最长者。
//   动机：toast 日志里模型显示名互为前缀（`hy4-preview` ↔ `hy4-preview-xxx`）时，旧实现
//   `toastText.startsWith(model)` 让**两个模型都拿到同一批轮次** → 高峰占比被对方的轮次拉偏 →
//   该模型的峰谷倍率 `1 + (peakMult-1)×占比` 整体偏移，回算金额偏离当日主链路且零报错。
//   （注意串的是**峰谷占比**，不是单价：查价在 L132 早已走主脚本 findModel，两键各自精确命中。）
function roundOwner(head, allModels) {
  if (!head || !allModels || !allModels.length) return null;
  for (const m of allModels) if (sameModelName(head, m)) return m; // ① 整名（各自归各家）
  let best = null;                                                 // ② 前缀兜底取最长
  for (const m of allModels) {
    if (!head.startsWith(m)) continue;
    if (!best || m.length > best.length) best = m;
  }
  return best;
}

// v3.56.0（G6）：toast 日志**一次读入、按模型分组**。
//   病根：roundHoursOf 每次调用都 `fs.readFileSync(TOAST_LOG)` 整份读 + 全量 JSON.parse，
//   而预热对「当天全部模型」逐个调用 → N 个模型 = N 次整份读同一份日志（v3.29.0 的"锁外预热"
//   只把 I/O 移出锁，没消除重复 I/O 本身）。日志随使用时间单调增长，recalc 一天的成本线性恶化。
//   修法：readToastRounds 读一次文件，逐行委托 groupToastLines 仲裁归属，产出 Map<model, ts[]>；
//   contested 统计（互前缀轮次被更长模型名抢走）按模型归集，由调用方统一 stderr —— 与 roundHoursOf
//   内逐模型打点的语义逐字对齐（同样一条不落，只是从"N 次读里各打一次"变成"一次读里归类打"）。
//   分组逻辑（groupToastLines）是纯函数：不碰文件系统，selftest 可直接喂行数组断言，
//   不必为了一条行为守卫去伪造整个 WB_ROOT 目录树。
function groupToastLines(lines, date, allModels) {
  const byModel = new Map();
  const contested = new Map();
  for (const line of (lines || [])) {
    if (!line || !line.includes(date)) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    if (!d.ts || !d.ts.startsWith(date)) continue;
    const head = toastHeadModel(d.toastText);
    const owner = roundOwner(head, allModels);
    if (owner) {
      if (!byModel.has(owner)) byModel.set(owner, []);
      byModel.get(owner).push(d.ts);
    }
    // 与本模型互为前缀、但归属了更长模型名的轮次（旧前缀口径会两边都算 → 金额偏离）
    if (!owner) continue;
    for (const m of (allModels || [])) {
      if (owner === m || sameModelName(owner, m)) continue;
      if (!String(head).startsWith(m)) continue;
      const c = contested.get(m) || { n: 0, owner: '' };
      c.n += 1;
      c.owner = owner;
      contested.set(m, c);
    }
  }
  return { byModel: byModel, contested: contested };
}

function readToastRounds(date, allModels) {
  let raw = '';
  try { raw = fs.readFileSync(TOAST_LOG, 'utf-8'); } catch (e) { raw = ''; }
  return groupToastLines(raw ? raw.split('\n') : [], date, allModels);
}

// 读 toast 日志中某天某模型的轮次（只取「已结算」的记账行，避免与 watcher 补弹重复计数）
// v3.56.0（G6）：保留作锁内 fallback —— 预热已用 readToastRounds 一次读入分组，只有并发新出现
//   （预热后才写进账本）的模型才会走到这里现场读，正常路径不再重复整份读。
function roundHoursOf(date, model, allModels) {
  let raw = '';
  try { raw = fs.readFileSync(TOAST_LOG, 'utf-8'); } catch (e) { return null; }
  const rows = [];
  let contested = 0;   // 本模型按旧前缀口径会多算的轮次数（已被本修复排除）
  let ownerName = '';  // 抢走这些轮次的模型名
  for (const line of raw.split('\n')) {
    if (!line.includes(date)) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    if (!d.ts || !d.ts.startsWith(date)) continue;
    const head = toastHeadModel(d.toastText);
    const owner = roundOwner(head, allModels);
    if (owner === model) rows.push(d.ts);
    else if (owner && !sameModelName(owner, model) && String(head).startsWith(model)) { contested++; ownerName = owner; }
  }
  if (contested) {
    process.stderr.write(`[recalc-day] ⚠ ${model}: toast 日志有 ${contested} 条轮次同属更长的模型名 ${ownerName}（互为前缀），已按最长名归属、不再并入本模型的高峰占比（旧实现会两边都算 → 回算金额偏离当日）\n`);
  }
  return rows.length ? rows : null;
}

function costOf(m, inTok, cachedTok, outTok, mult) {
  // v3.42.0（plan-B B1）：收敛到 token-tracker.js 单点实现 triPriceRounded（带 1e-6 四舍五入）
  return tt.triPriceRounded(inTok, cachedTok, outTok, m, mult);
}

// v3.40.0（plan-B A3）：**按行精确的峰谷合计**——比"轮次数占比折算"高一个量级的口径。
//   数据来源：rounds/rounds-YYYY-MM.jsonl 里主链路落下的 `peakSplit` 字段（见 token-tracker.js
//   appendRoundDetail）。主链路是**在逐行循环里**按每行自己的 ts 判峰谷后累加的，所以这里读到的
//   是真正的高峰/空闲 token 切分，而不是"高峰轮次占几成"的近似。
//   与旧折算的关系：本函数能给出结果时**一律优先用它**（精确 > 近似）；读不到（当天明细被 prune 掉 /
//   旧版本落的明细没有该字段 / 文件缺失）→ 返回 null → 调用方回退旧的占比折算（行为与 v3.39.0 相同）。
//   归集口径：明细里 `date` 字段 = token 发生日（A4 之后跟随发生时刻）→ 按日期过滤；模型名走
//   sameModelName 归并（明细里的键是 normalizeModelName 后的，账本键可能带别名/大小写差异）。
function peakSplitOf(date, model) {
  const monthFile = path.join(SKILL_DIR, 'rounds', `rounds-${String(date).slice(0, 7)}.jsonl`);
  let raw = '';
  try { raw = fs.readFileSync(monthFile, 'utf-8'); } catch (e) { return null; }
  const acc = { pIn: 0, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 };
  let hit = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    if (!rec || !rec.peakSplit) continue;
    // 归属日期：优先 rec.date（A4 后 = 发生日）；旧明细没有 date → 用 rec.ts 的本地日期兜底
    const recDate = rec.date || (() => {
      const d = new Date(Number(rec.ts) || 0);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    if (recDate !== date) continue;
    for (const [n, sp] of Object.entries(rec.peakSplit)) {
      if (!sameModelName(n, model)) continue;
      if (!sp || typeof sp !== 'object') continue;
      hit = true;
      for (const k of ['pIn', 'pCached', 'pOut', 'oIn', 'oCached', 'oOut']) acc[k] += Number(sp[k]) || 0;
    }
  }
  return hit ? acc : null;
}

// v3.19.0（P2）：BOM 剥离 + 损坏备份（与主脚本 H6 同口径）。原先裸 JSON.parse，
// 账本带 BOM 或轻微损坏时直接抛异常崩溃（连备份都不留）。
function loadJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')); }
  catch (e) {
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch (e2) {} }
    return null;
  }
}

// v3.19.0（P2）：写前备份（保留最近 3 份），并把写盘交给主脚本导出的原子写。
function backupDaily() {
  try {
    fs.copyFileSync(DAILY, `${DAILY}.bak-recalc-${Date.now()}`);
    const baks = fs.readdirSync(SKILL_DIR).filter((f) => f.startsWith('daily-usage.json.bak-recalc-')).sort();
    for (const f of baks.slice(0, Math.max(0, baks.length - 3))) { try { fs.unlinkSync(path.join(SKILL_DIR, f)); } catch (e) {} } // silent-ok:清理 — 旧备份有界保留，删不掉就留着
  } catch (e) { /* 备份失败不阻塞（写盘本身仍是原子的） */ }
}

function main() {
  const argv = process.argv.slice(2);
  // v3.24.0：缺省日期用**本地**日期（原 `toISOString()` 是 UTC —— 北京 00:00~08:00 之间跑，
  // 会把"今天"算成前一天：账本里没有那天的记录 → "账本中无 X 记录"，或重算了错误的一天）。
  const _n = new Date();
  const date = argv[0] || `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}`;
  const onlyModel = argv[1] || '';
  // v3.59.0（审计 M24）：日期合法性校验。改前 `argv[0]` 原样拿去查字典 →
  //   `node recalc-day.js 2026-13-45` 报「账本中无 2026-13-45 记录」——**把"参数非法"说成"数据缺失"**：
  //   用户会以为账本坏了、或那天真的没有用量，转头去查账本、甚至跑去跑 backfill（正是 KI-5 警告的
  //   危险操作）。校验要在**查字典之前**做，否则两个失败原因永远混在一条信息里。
  if (argv[0]) {
    const bad = (msg) => {
      console.error(`✗ 日期参数非法：${JSON.stringify(argv[0])} —— ${msg}`
        + `（应为 YYYY-MM-DD，如 ${date}；不传参数默认重算今天）`);
      process.exit(2);
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(argv[0])) bad('格式不是 YYYY-MM-DD');
    const p = argv[0].split('-').map(Number);
    // 日历校验（不是只看形状）：`2026-13-45` / `2026-02-30` 形状合法但不是真实日期 →
    // `new Date(2026,12,45)` 会静默滚到下一年，必须靠回读年/月/日识别。
    const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    if (dt.getUTCFullYear() !== p[0] || dt.getUTCMonth() !== p[1] - 1 || dt.getUTCDate() !== p[2]) bad('不是真实存在的日期');
  }

  const daily = loadJsonSafe(DAILY);
  if (!daily) { console.error('账本读取失败（已备份为 .corrupt-*）；请检查 daily-usage.json'); process.exit(1); }
  let pricing = loadJsonSafe(PRICING);
  if (!pricing) { console.error('pricing.json 读取失败（已备份为 .corrupt-*）'); process.exit(1); }
  // v3.19.0（P6）：合并本地官方价库——原先只读 pricing.json，只在本地库有价的国内模型被判"无价"跳过
  try { pricing = tt.mergeLocalPriceDb(pricing); } catch (e) { /* 本地库不可用则沿用主库 */ }
  const day = daily[date];
  if (!day) { console.error(`账本中无 ${date} 记录`); process.exit(1); }

  // v3.29.0（S-2 补漏）：锁外预热 roundHoursOf —— 它是本工具里唯一的重 I/O（每次调用都整份读 toast 日志）。
  //   v3.56.0（G6）：预热改走 readToastRounds **一次读入、按模型分组** —— 原实现逐模型各整份读一遍
  //   （N 模型 = N 次全量读 + N 次全量 JSON.parse），日志随使用时间单调增长，成本线性恶化；
  //   现在整份日志只读一次，锁内仍只对「预热后并发新出现」的模型现场读（见 recalcDay 内 hoursCache 分支）。
  const hoursCache = new Map();
  const allModels = Object.keys(day.models || {}); // v3.31.0（P1-15）：轮次归属要按「当天全部模型」仲裁归属
  const toastRounds = readToastRounds(date, allModels);
  for (const model of allModels) {
    const rows = toastRounds.byModel.get(model);
    hoursCache.set(model, rows && rows.length ? rows : null);
    const c = toastRounds.contested.get(model);
    if (c && c.n > 0) {
      // 与 roundHoursOf 内的打点逐字一致（同一条不落，只是从"N 次读里各打一次"归到"一次读里归类打"）
      process.stderr.write(`[recalc-day] ⚠ ${model}: toast 日志有 ${c.n} 条轮次同属更长的模型名 ${c.owner}（互为前缀），已按最长名归属、不再并入本模型的高峰占比（旧实现会两边都算 → 回算金额偏离当日）\n`);
    }
  }

  // v3.29.0（S-2 补漏）：把「重算一天」抽成函数，逻辑逐字搬自原 L115-175（findModel/峰谷/no_price/costOf 一律不动）。
  //   基准改为**传入的 dayObj**：锁内传入的是 cur[date] 现值（不再是锁外旧快照），
  //   这样「目标日期自己在锁外窗口被主链路追加的新数据」才不会被旧快照静默抹掉。
  function recalcDay(dayObj) {
    let dayTotal = 0;
    const report = [];
    // v3.59.0（批16）：**可观测性补漏** —— recalc 此前没有任何"到底处理了几个模型"的输出信号：
    //   早退路径（无价 / 被 onlyModel 过滤 / 条目损坏）与"真处理了但金额没变"在 stdout 上**完全一致**
    //   → 端到端测试只能断言"没崩"（T68-e3 的弱断言），分不清"重算成功"与"压根没走到重算"。
    let modelsSeen = 0;     // 遍历到的账本条目数（含被跳过的）
    let modelsRecalced = 0; // 真正走到计价重算的（有价 + 未被 onlyModel 过滤）

    for (const [model, stat] of Object.entries(dayObj.models || {})) {
      modelsSeen += 1;
      // v3.46.0（审计 S-10）：账本条目可能是 null / 非对象（手写编辑、第三方工具写坏、半截 JSON 修复后残留）。
      //   改前 `stat.cost` 直接抛 TypeError → 整个 recalc 崩在**锁内**、账本已备份但未写回 →
      //   用户只看到一段异常栈。跳过坏条目（不动它的金额），其余模型照常重算。
      if (!stat || typeof stat !== 'object') continue;
      // v3.59.0（批10·S1）：两处早退累加原先用 `stat.cost || 0` —— 脏字符串 cost 会把 dayTotal
      //   腐化成字符串（"0.5"+12.3 → "0.5012.3"），末行 safeCost 兜底解析失败 → 当日合计静默归 0，
      //   后续模型的金额全部丢失。与 :337/:372 同口径走 safeCost（非有限数归一为 0，由上游补正）。
      if (onlyModel && model !== onlyModel) { dayTotal += safeCost(stat.cost); continue; }
      // v3.23.5：查价改走主脚本的 findModel（归一化 + 边界匹配 + 别名），与 backfill / 主链路同口径。
      // 原先裸查字典 `(pricing.models || {})[model]` —— 账本里的模型名与价库键差一个后缀/别名就取不到价，
      // 表现为「同一天 backfill 算得出金额、recalc 算不出」，且没有任何报错。
      const hit = tt.findModel(pricing, model, 'price');
      const m = hit ? hit.m : null;
      if (!m || typeof m.input_price !== 'number') { dayTotal += safeCost(stat.cost); continue; }

      // v3.29.0（S-2 补漏）：优先用锁外预热缓存；并发新出现的模型（不在缓存里）才现场读 toast。
      // v3.31.0（P1-15）：并发新出现的模型不在 allModels 里 → 补进候选表，否则它自己的轮次会被仲裁给别的模型
      const cands = allModels.includes(model) ? allModels : allModels.concat([model]);
      const hours = hoursCache.has(model) ? hoursCache.get(model) : roundHoursOf(date, model, cands);
      // v3.57.0（K1）：无峰谷模型结构性退出峰谷时段判定——只有 peakMultOf>1 才算高峰占比。
      //   改前无条件算占比（无峰谷模型靠倍率 1 打平）；deepseek 名+显式 mult≤1 组合生产不存在，
      //   且「显式 peak_multiplier 优先」本就是 peakMultOf 既定口径（v3.46.0 S-9）。
      const pm = tt.peakMultOf(m, model);
      let peakRatio = null;
      if (pm > 1) {
        if (hours) {
          peakRatio = hours.filter((iso) => isPeakBeijing(iso, pricing)).length / hours.length;
        }
        // 有峰谷但拿不到轮次时间 → peakRatio 保持 null（占比未知 → 走降级路径）
      } else {
        peakRatio = 0; // 无峰谷 → 不判时段
      }

      modelsRecalced += 1; // 走到这里 = 有价且未被 onlyModel 过滤，真的要重算金额
      const base = costOf(m, stat.in, stat.cached, stat.out, 1);
      let cost;
      // v3.40.0（plan-B A3）：**优先级① —— 行级精确切分**（明细里落下的 peakSplit）。
      //   这条路不依赖 toast 轮次、也不需要"轮次数 ≈ token 数"这个近似：高峰 token 与空闲 token
      //   是主链路逐行判定的结果，直接各自乘各自倍率即可，**与实时链路逐字节同口径**。
      //   旧折算（下面 peakRatio 那一支）只在读不到 peakSplit 时才走 —— 于是同一批数据
      //   "实时链路算的"与"recalc 回算的"不再可能给出两个金额（A3 的验收标准）。
      const split = peakSplitOf(date, model);
      let splitUsed = false;
      // v3.57.0（H5 收口 / 逻辑审计 R1）：at-time 切分**必须全覆盖**才采用 —— 三对桶加总与账本
      //   条目三值完全相等，证明明细覆盖了当天全部轮次。修前此处只要求「六桶和 > 0」：
      //   hook-fallback 轮不落明细（A22，已知不修）、明细被 prune、跨版本残留都会让桶和 < 条目值，
      //   此时按 split 计价 = 只给明细轮次定价、**漏掉其余轮次的全部用量**（把账本金额改小），
      //   且与 backfill.js v3.57.0 的全覆盖口径分叉。对不上 → 落到下面的轮次占比折算 /
      //   「未知按空闲」降级路径（v3.24.0 既定语义：原账 >0 保留、=0 按空闲补记）。
      const stIn = Number(stat.in) || 0, stOut = Number(stat.out) || 0, stCached = Number(stat.cached) || 0;
      if (split && (split.pIn + split.pCached + split.pOut + split.oIn + split.oCached + split.oOut) > 0
       && split.pIn + split.oIn === stIn
       && split.pOut + split.oOut === stOut
       && split.pCached + split.oCached === stCached) {
        // v3.46.0（审计 S-9）：峰谷倍率与分桶展开式**都改为调用主脚本单点实现**。
        //   改前这里手写了一份 6 项展开式 + 一份倍率三元式，注释还写「与主链路 calcCost 同款钳制」
        //   ——只对分桶支成立、对回退支不成立（两份注释各自对一半 = 病根标本）。
        //   现在两侧调同一个函数：主链路改口径 → recalc 自动跟着变，**不可能再分裂**。
        //   表达式侧逐字照搬（含 cached ≤ in 钳制）→ 金额零变化（T55-b1 fuzz + 真机逐日比对验收）。
        const peakMultS = tt.peakMultOf(m, model);
        const rawC = tt.costFromPeakSplit(m, split, peakMultS);
        cost = Math.round(rawC * 1e6) / 1e6;
        splitUsed = true;
      } else if (peakRatio === null) {
        // v3.24.0（级联④，补 v3.23.5 的另一半）：峰谷占比未知时**不得瞎改已有金额**。
        // 原实现一律按空闲 ×1 重写 —— 对已有账（按 token 实际发生时刻记的，含高峰 ×2 部分）
        // 是口径改写：任何一次 recalc 都会把历史金额悄悄改小。现在分两种情况：
        //   原账 > 0 → 保留原额不动（只在报告标注"时段未知"）；
        //   原账 = 0 → 是"当时未收录"的历史欠账，按空闲价补上（低估可接受，且这正是本工具存在的目的）。
        // v3.58.0（批8-①）：此处 `dayTotal += stat.cost` 必须走 safeCost —— 上面的判据是
        //   `Number(stat.cost || 0) > 0`（只对**数值**成立），但累加用的却是未归一化的 stat.cost：
        //   字符串型 cost（如 "0.5"）判据为真 → 走本分支 → 字符串拼接 → 整日合计变字符串 → 落盘 NaN。
        if (Number(stat.cost || 0) > 0) { dayTotal += safeCost(stat.cost); continue; }
        cost = base; // ¥0 欠账 → 按空闲价补记
      } else {
        // v3.23.5：缺省值与主脚本 calcCost（token-tracker.js L2599）对齐——DeepSeek 系缺省 2，其余缺省 1。
        // 原先一律 `|| 1`：deepseek 条目若缺 peak_multiplier 字段，回溯重算会比主链路**整整少算一倍**，且不报错。
        // v3.46.0（审计 S-9）：倍率判定同样收敛到 tt.peakMultOf（与精确切分支、主链路 calcCost 三处同一判据）。
        //   改前这里第三份抄写（且写法又不同），注释还写着「与主脚本 calcCost L2599 对齐」——靠人记得同步。
        const peakMult = tt.peakMultOf(m, model);
        // 加权：高峰部分按 peak_multiplier，其余按 1
        const ratio = Math.min(1, Math.max(0, peakRatio));
        cost = costOf(m, stat.in, stat.cached, stat.out, 1 + (peakMult - 1) * ratio);
      }

      // v3.58.0（批8-①）：`Number(stat.cost || 0)` 对脏值（"abc" / NaN）得到 NaN，
      //   于是 `Math.abs(cost - NaN)` = NaN → `NaN > 0.0005` = false → **不回写**，脏值永久留在账本。
      //   归一为 0 后判据成立 → 用正确金额覆盖脏值 → 自愈（同一条数据第二轮即变正确数值）。
      const old = safeCost(stat.cost);
      if (Math.abs(cost - old) > 0.0005) {
        stat.cost = cost;
        report.push({
          model, old, neu: cost,
          rounds: hours ? hours.length : 0,
          // v3.40.0（A3）：口径来源可见 —— '精确(逐行)' 表示走的是主链路落下的行级切分；
          //   百分比表示仍走旧的"轮次数占比"近似（读不到 peakSplit 时的退路）
          peakRatio: splitUsed ? '精确(逐行)'
            : (peakRatio === null ? '未知(按空闲)' : `${(peakRatio * 100).toFixed(0)}%`),
        });
      }
      // v3.27.0：官方价补上并回算后，条目不再属于「无公开价」→ 必须清标记，
      //   否则金额已是真实值、报表却仍显示「无公开价」+ 合计偏低提示（自己打自己的脸）。
      if (stat.no_price && cost > 0) {
        delete stat.no_price; delete stat.no_price_note;
        report.push({ model, note: '已补公开价并回算，清除 no_price 标记' });
      }
      // v3.58.0（批8-①）：同上 —— 累加侧再兜一次（未回写的原值仍是脏值时也不能污染合计）。
      dayTotal += safeCost(stat.cost);
    }

    // v3.46.0（审计 S-10）：`dayObj.total` 缺失时补空对象再写 cost。
    //   改前 `dayObj.total.cost = ...` 对没有 total 键的旧/坏账本直接抛（锁内抛出 → 同上，只留异常栈）。
    if (!dayObj.total || typeof dayObj.total !== 'object') dayObj.total = {};
    // v3.58.0（批8-①）：最后一关兜底 —— 即便上面某条漏网把 dayTotal 变成非有限数，
    //   也只让当日合计降级为 0（可重跑修复），绝不让 NaN 落进账本（NaN 一旦落盘即不自愈）。
    dayObj.total.cost = Math.round(safeCost(dayTotal) * 1e6) / 1e6;
    return { total: dayObj.total.cost, report, modelsSeen, modelsRecalced };
  }

  // v3.19.0（P2）：先备份，再走主脚本的原子写（tmp+rename）。原先直接 writeFileSync 覆盖，
  // 写盘中断 = 全部历史账本损坏（唯一三样全无的写入路径）。
  // v3.29.0（S-2 修复）：原先只复用了主脚本**无锁**的内层写 saveDailyUsageRaw —— 主链路 recordUsage 是
  //   withFileLock(DAILY_USAGE_FILE + '.lock') 包着同一个写函数（token-tracker.js L3062），recalc 却把锁丢了；
  //   且 recalc 在锁外早已读好 daily 快照（约 L106），期间主链路累加的新数据会被这份旧快照整体覆盖。
  //   现在改为：与主链路共用**同一把锁**（DAILY + '.lock' 即 DAILY_USAGE_FILE + '.lock'），
  //   锁内**重读账本现值**，只把「目标日期」这一个键替换成重算结果，其余日期保持账本现值
  //   （recalc 是单日回算，绝不能整份替换）。
  // v3.29.0（S-2 补漏）：重算也搬进锁内、以锁内现值 cur[date] 为基准 —— 原先把锁外旧快照 day 直接塞回
  //   cur[date]，只挡住了「其他日期被覆盖」，挡不住「目标日期自己在锁外窗口被追加的新数据被旧快照抹掉」。
  let writeOk = false;
  let rereadFailed = false;
  let targetMissing = false;
  let recalc = null;
  const lockRes = tt.withFileLock(DAILY + '.lock', () => {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(DAILY, 'utf-8').replace(/^\uFEFF/, '')); } catch (e) { cur = null; }
    if (!cur || typeof cur !== 'object') { rereadFailed = true; return; } // 重读失败 → 不写，原文件保持不动
    // v3.29.0（S-2 补漏）：目标日期锁外存在、锁内却没了（极端并发删除）→ 不写盘，锁外报错退出
    if (!cur[date]) { targetMissing = true; return; }
    backupDaily();          // 备份仍在本工具写盘之前执行
    // v3.29.0（S-2 补漏）：以锁内现值 cur[date] 为基准重算（不再是锁外旧快照），其余日期绝不触碰
    recalc = recalcDay(cur[date]);
    writeOk = tt.saveDailyUsageRaw(cur);
  }, { ttl: 300000, retries: 50 });

  if (!lockRes || !lockRes.ok) {
    // 抢锁失败：绝不无锁续写（否则又退回「旧快照整体覆盖」老问题）
    console.error('账本正被占用（WorkBuddy 可能正在运行），请先退出 WorkBuddy 再执行 recalc-day');
    process.exit(1);
  }
  if (rereadFailed) { console.error('账本读取失败，原文件未改动；请检查 daily-usage.json'); process.exit(1); }
  if (targetMissing) { console.error(`账本中无 ${date} 记录（重算期间被并发改动？）；原文件未改动`); process.exit(1); }
  if (!writeOk) { console.error('账本写入失败，原文件未改动'); process.exit(1); }

  console.log(`===== 回溯重算 ${date} =====`);
  if (!recalc.report.length) console.log('无需修正（各模型金额已一致）');
  for (const r of recalc.report) {
    // v3.29.0：report 里有**两类**条目 —— ①「金额变更」带 old/neu/rounds/peakRatio；
    //   ②「仅清 no_price 标记」只有 {model, note}（见上方 `report.push({ model, note })`）。
    //   原先无条件读 `r.old.toFixed()` → 走到 ② 就抛 `TypeError: Cannot read properties of undefined`。
    //   而 ② 恰恰在**本工具的主用法**上触发（补价后 recalc：no_price 条目从 ¥0 变成 >0）。
    //   此时账本已写盘成功，用户却只看到一段异常栈、拿不到重算报告 → 误以为工具失败。
    console.log(`  ${r.model}`);
    if (r.note) { console.log(`    ${r.note}`); continue; }
    console.log(`    原 ¥${r.old.toFixed(4)} → 现 ¥${r.neu.toFixed(4)}  （轮次 ${r.rounds}，高峰占比 ${r.peakRatio}）`);
  }
  console.log(`  当日合计 ¥${recalc.total.toFixed(2)}`);
  // v3.59.0（批16）：处理模型数的**显式信号**（见 recalcDay 内计数器注释）。
  //   `重算/总计` 的差额 = 未收录价 / 被 onlyModel 过滤 / 条目损坏 —— 差额大时一眼看出"没算全"。
  console.log(`  处理模型 ${recalc.modelsRecalced}/${recalc.modelsSeen} 个（重算 / 总计）`);
}

// v3.40.0（plan-B A3）：被 require 时**不自动跑 main**（供 selftest 单测 peakSplitOf/精确切分）。
//   旧实现裸调 main() —— selftest 一旦 require 本文件就会直接执行 CLI（读真实账本、可能改盘），
//   这在测试里是**不可接受**的副作用。改判 `require.main === module`：直接 `node recalc-day.js`
//   仍然照常跑（行为零变化），被 require 时只暴露纯函数。
if (require.main === module) main();

// v3.58.0（批8-①）：safeCost 一并导出 —— 供 selftest 做**行为级**验证（只靠源码形态守不住「数值化」语义）。
module.exports = { peakSplitOf, costOf, readToastRounds, groupToastLines, safeCost };
