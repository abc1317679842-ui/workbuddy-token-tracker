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
const SKILL_DIR = path.join(WB, 'skills', 'token-usage-tracker');
const DAILY = path.join(SKILL_DIR, 'daily-usage.json');
const PRICING = path.join(SKILL_DIR, 'pricing.json');
const TOAST_LOG = path.join(WB, 'token-tracker-toast.log');
const HOLIDAYS = path.join(SKILL_DIR, 'holidays.json'); // v3.19.0：假日表传给 peak-rules（口径唯一）


// v3.19.0（P2/P6）：复用主脚本的原子写（saveDailyUsageRaw）与本地官方价库合并（mergeLocalPriceDb），
// 不再自制写盘、不再漏合并本地库。显式对齐 WB_ROOT，保证子模块的路径口径与本工具一致。
if (!process.env.WB_ROOT) process.env.WB_ROOT = WB;
const tt = require(path.join(__dirname, 'token-tracker.js'));


function isPeakBeijing(iso, pricing) {
  return peakRules.isPeakAt(new Date(iso).getTime(), pricing, HOLIDAYS);
}

// 读 toast 日志中某天某模型的轮次（只取「已结算」的记账行，避免与 watcher 补弹重复计数）
function roundHoursOf(date, model) {
  let raw = '';
  try { raw = fs.readFileSync(TOAST_LOG, 'utf-8'); } catch (e) { return null; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.includes(date)) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    const tt = String(d.toastText || '');
    if (!tt.startsWith(model)) continue;
    if (!d.ts || !d.ts.startsWith(date)) continue;
    rows.push(d.ts);
  }
  return rows.length ? rows : null;
}

function costOf(m, inTok, cachedTok, outTok, mult) {
  const uncached = Math.max(0, inTok - cachedTok);
  const c = (uncached / 1e6) * Number(m.input_price || 0) * mult
    + (cachedTok / 1e6) * Number(m.cached_price || 0) * mult
    + (outTok / 1e6) * Number(m.output_price || 0) * mult;
  return Math.round(c * 1e6) / 1e6;
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
    for (const f of baks.slice(0, Math.max(0, baks.length - 3))) { try { fs.unlinkSync(path.join(SKILL_DIR, f)); } catch (e) {} }
  } catch (e) { /* 备份失败不阻塞（写盘本身仍是原子的） */ }
}

function main() {
  const argv = process.argv.slice(2);
  // v3.24.0：缺省日期用**本地**日期（原 `toISOString()` 是 UTC —— 北京 00:00~08:00 之间跑，
  // 会把"今天"算成前一天：账本里没有那天的记录 → "账本中无 X 记录"，或重算了错误的一天）。
  const _n = new Date();
  const date = argv[0] || `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}`;
  const onlyModel = argv[1] || '';

  const daily = loadJsonSafe(DAILY);
  if (!daily) { console.error('账本读取失败（已备份为 .corrupt-*）；请检查 daily-usage.json'); process.exit(1); }
  let pricing = loadJsonSafe(PRICING);
  if (!pricing) { console.error('pricing.json 读取失败（已备份为 .corrupt-*）'); process.exit(1); }
  // v3.19.0（P6）：合并本地官方价库——原先只读 pricing.json，只在本地库有价的国内模型被判"无价"跳过
  try { pricing = tt.mergeLocalPriceDb(pricing); } catch (e) { /* 本地库不可用则沿用主库 */ }
  const day = daily[date];
  if (!day) { console.error(`账本中无 ${date} 记录`); process.exit(1); }

  let dayTotal = 0;
  const report = [];

  for (const [model, stat] of Object.entries(day.models || {})) {
    if (onlyModel && model !== onlyModel) { dayTotal += stat.cost || 0; continue; }
    // v3.23.5：查价改走主脚本的 findModel（归一化 + 边界匹配 + 别名），与 backfill / 主链路同口径。
    // 原先裸查字典 `(pricing.models || {})[model]` —— 账本里的模型名与价库键差一个后缀/别名就取不到价，
    // 表现为「同一天 backfill 算得出金额、recalc 算不出」，且没有任何报错。
    const hit = tt.findModel(pricing, model, 'price');
    const m = hit ? hit.m : null;
    if (!m || typeof m.input_price !== 'number') { dayTotal += stat.cost || 0; continue; }

    const hours = roundHoursOf(date, model);
    let peakRatio = null;
    if (hours) {
      peakRatio = hours.filter((iso) => isPeakBeijing(iso, pricing)).length / hours.length;
    } else if ((typeof m.peak_multiplier === 'number' && m.peak_multiplier > 1) || /(^|[\/\-_])deepseek/i.test(String(model || ''))) {
      peakRatio = null; // 有峰谷价但拿不到轮次时间 → 占比未知
    } else {
      peakRatio = 0;
    }

    const base = costOf(m, stat.in, stat.cached, stat.out, 1);
    let cost;
    if (peakRatio === null) {
      // v3.24.0（级联④，补 v3.23.5 的另一半）：峰谷占比未知时**不得瞎改已有金额**。
      // 原实现一律按空闲 ×1 重写 —— 对已有账（按 token 实际发生时刻记的，含高峰 ×2 部分）
      // 是口径改写：任何一次 recalc 都会把历史金额悄悄改小。现在分两种情况：
      //   原账 > 0 → 保留原额不动（只在报告标注"时段未知"）；
      //   原账 = 0 → 是"当时未收录"的历史欠账，按空闲价补上（低估可接受，且这正是本工具存在的目的）。
      if (Number(stat.cost || 0) > 0) { dayTotal += stat.cost; continue; }
      cost = base; // ¥0 欠账 → 按空闲价补记
    } else {
      // v3.23.5：缺省值与主脚本 calcCost（token-tracker.js L2599）对齐——DeepSeek 系缺省 2，其余缺省 1。
      // 原先一律 `|| 1`：deepseek 条目若缺 peak_multiplier 字段，回溯重算会比主链路**整整少算一倍**，且不报错。
      const isDeepSeek = /(^|[\/\-_])deepseek/i.test(String(model || ''));
      const peakMult = typeof m.peak_multiplier === 'number' ? m.peak_multiplier : (isDeepSeek ? 2 : 1);
      // 加权：高峰部分按 peak_multiplier，其余按 1
      const ratio = Math.min(1, Math.max(0, peakRatio));
      cost = costOf(m, stat.in, stat.cached, stat.out, 1 + (peakMult - 1) * ratio);
    }

    const old = Number(stat.cost || 0);
    if (Math.abs(cost - old) > 0.0005) {
      stat.cost = cost;
      report.push({
        model, old, neu: cost,
        rounds: hours ? hours.length : 0,
        peakRatio: peakRatio === null ? '未知(按空闲)' : `${(peakRatio * 100).toFixed(0)}%`,
      });
    }
    // v3.27.0：官方价补上并回算后，条目不再属于「无公开价」→ 必须清标记，
    //   否则金额已是真实值、报表却仍显示「无公开价」+ 合计偏低提示（自己打自己的脸）。
    if (stat.no_price && cost > 0) {
      delete stat.no_price; delete stat.no_price_note;
      report.push({ model, note: '已补公开价并回算，清除 no_price 标记' });
    }
    dayTotal += stat.cost;
  }

  day.total.cost = Math.round(dayTotal * 1e6) / 1e6;
  // v3.19.0（P2）：先备份，再走主脚本的原子写（tmp+rename）。原先直接 writeFileSync 覆盖，
  // 写盘中断 = 全部历史账本损坏（唯一三样全无的写入路径）。
  backupDaily();
  if (!tt.saveDailyUsageRaw(daily)) { console.error('账本写入失败，原文件未改动'); process.exit(1); }

  console.log(`===== 回溯重算 ${date} =====`);
  if (!report.length) console.log('无需修正（各模型金额已一致）');
  for (const r of report) {
    console.log(`  ${r.model}`);
    console.log(`    原 ¥${r.old.toFixed(4)} → 现 ¥${r.neu.toFixed(4)}  （轮次 ${r.rounds}，高峰占比 ${r.peakRatio}）`);
  }
  console.log(`  当日合计 ¥${day.total.cost.toFixed(2)}`);
}

main();
