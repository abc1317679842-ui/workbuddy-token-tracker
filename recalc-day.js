#!/usr/bin/env node
// recalc-day.js —— 账本回溯重算工具（v2.93 附带，独立进程，不侵入 token-tracker.js 主链路）
//
// 用途：新模型价格补录之后，把当天曾按「未收录」记成 ¥0 的历史数据，按现价 + 峰谷重算。
//      没有这个工具时，补录只能让「之后的消耗」计上价，当天之前的部分永远是 0，账本失真。
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

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const SKILL_DIR = path.join(WB, 'skills', 'token-usage-tracker');
const DAILY = path.join(SKILL_DIR, 'daily-usage.json');
const PRICING = path.join(SKILL_DIR, 'pricing.json');
const TOAST_LOG = path.join(WB, 'token-tracker-toast.log');

const PEAK_RANGES = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]; // 北京时间（分钟）

function isPeakBeijing(iso) {
  const beijing = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const dow = beijing.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return PEAK_RANGES.some(([a, b]) => mins >= a && mins < b);
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

function main() {
  const argv = process.argv.slice(2);
  const date = argv[0] || new Date().toISOString().slice(0, 10);
  const onlyModel = argv[1] || '';

  const daily = JSON.parse(fs.readFileSync(DAILY, 'utf-8'));
  const pricing = JSON.parse(fs.readFileSync(PRICING, 'utf-8'));
  const day = daily[date];
  if (!day) { console.error(`账本中无 ${date} 记录`); process.exit(1); }

  let dayTotal = 0;
  const report = [];

  for (const [model, stat] of Object.entries(day.models || {})) {
    if (onlyModel && model !== onlyModel) { dayTotal += stat.cost || 0; continue; }
    const m = (pricing.models || {})[model];
    if (!m || typeof m.input_price !== 'number') { dayTotal += stat.cost || 0; continue; }

    const hours = roundHoursOf(date, model);
    let peakRatio = null;
    if (hours) {
      peakRatio = hours.filter(isPeakBeijing).length / hours.length;
    } else if (m.peak_multiplier > 1) {
      peakRatio = null; // 无法判定 → 按空闲价（保守低估），并在报告中标注
    } else {
      peakRatio = 0;
    }

    const base = costOf(m, stat.in, stat.cached, stat.out, 1);
    let cost;
    if (peakRatio === null) {
      cost = base; // 单时段不明 → 全部按空闲（保守）
    } else {
      const peakMult = Number(m.peak_multiplier || 1);
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
    dayTotal += stat.cost;
  }

  day.total.cost = Math.round(dayTotal * 1e6) / 1e6;
  fs.writeFileSync(DAILY, JSON.stringify(daily, null, 2) + '\n');

  console.log(`===== 回溯重算 ${date} =====`);
  if (!report.length) console.log('无需修正（各模型金额已一致）');
  for (const r of report) {
    console.log(`  ${r.model}`);
    console.log(`    原 ¥${r.old.toFixed(4)} → 现 ¥${r.neu.toFixed(4)}  （轮次 ${r.rounds}，高峰占比 ${r.peakRatio}）`);
  }
  console.log(`  当日合计 ¥${day.total.cost.toFixed(2)}`);
}

main();
