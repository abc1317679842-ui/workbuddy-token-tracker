#!/usr/bin/env node
// peak-rules.js —— 峰谷时段判定的**唯一实现**（v3.19.0，修 P1 口径分裂）
//
// 为什么要有这个文件：主脚本从 pricing.deepseek_rules.peak_schedule 读官方动态时段（官方改版自动跟随），
// 而 backfill.js / recalc-day.js 各自硬编码 [[9,12],[14,18]]。官方一旦调整时段，增量记账判低峰、
// 回溯重算判高峰 → **同一批数据金额差一倍且静默无报错**。法定假日口径此前同样是三份复制
// （v3.15 只同步了假日、没同步时段）。现在三处统一调用本模块：靠模块强制同步，而不是靠注释约束。
//
// 口径（与主脚本 v2.95/v2.59/v3.15 完全一致）：
//   ① 法定假日（holidays.json）→ 全天低峰；
//   ② 有 deepseek_rules → 按 peak_schedule；weekend_off_peak=true 时周末低峰；时段解析失败 → 回落默认；
//   ③ 无 rules → 周末低峰 + 默认时段 9:00-12:00 / 14:00-18:00（北京时间）。
'use strict';
const fs = require('fs');

const DEFAULT_RANGES = [{ s: 9, e: 12 }, { s: 14, e: 18 }]; // 官方当前口径；无 rules 时兜底

let _holidaysCache = null;
let _holidaysPathCache = null;
let _holidaysMtimeCache = -1;

function loadHolidays(holidaysPath) {
  // v3.19.1（N4）：缓存加 mtime 校验。原先只在「路径变化」时失效 → 同一进程内（watcher 最长活 3 小时）
  // refresh-holidays.js 更新了 holidays.json 也仍用旧表。假日表虽一年一更，但跨年/临时调休补录会漏。
  let mtime = -1;
  try { mtime = fs.statSync(holidaysPath).mtimeMs; } catch (e) { mtime = -1; } // 缺失/不可 stat → 不判假
  if (_holidaysCache !== null && _holidaysPathCache === holidaysPath && _holidaysMtimeCache === mtime) return _holidaysCache;
  let h = { years: {} };
  try { h = JSON.parse(fs.readFileSync(holidaysPath, 'utf-8')); } catch (e) { h = { years: {} }; } // 缺失→不判假，绝不抛错
  _holidaysCache = h;
  _holidaysPathCache = holidaysPath;
  _holidaysMtimeCache = mtime;
  return h;
}

// 支持 "9:00 - 12:00、14:00 - 18:00" / "9:00-12:00,14:00-18:00" 等
function parsePeakSchedule(sched) {
  const ranges = [];
  const parts = String(sched || '').split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/(\d{1,2}):?(\d{2})?\s*[-–—~至到]\s*(\d{1,2}):?(\d{2})?/);
    if (!m) continue;
    // v3.19.1：保留分钟（判定侧 hm 本就是小数小时）。官方现给整点，但 deepseek-official 按原文归一化，
    // 若官方改成 9:30 起，此处按整点处理会静默提前 30 分钟计高峰。
    const sH = Number(m[1]) + (Number(m[2]) || 0) / 60;
    const eH = Number(m[3]) + (Number(m[4]) || 0) / 60;
    if (isNaN(sH) || isNaN(eH)) continue;
    ranges.push({ s: sH, e: eH });
  }
  return ranges;
}

function isHolidayBeijing(tsMs, holidaysPath) {
  if (!holidaysPath) return false;
  try {
    const bj = new Date(Number(tsMs) + 8 * 3600 * 1000);
    const y = bj.getUTCFullYear();
    const key = `${y}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
    const arr = (loadHolidays(holidaysPath).years || {})[String(y)] || [];
    return arr.indexOf(key) >= 0;
  } catch (e) { return false; }
}

// v3.32.0（方案 H1，审计 P1-4）：该时刻所在年份的假日数据是「未知/陈旧」还是「已确认」？
//   病根：isHolidayBeijing 的 `|| []` 把三种完全不同的状态压成同一个结果——
//     ① years[y] = null / 键不存在 = 从未获取成功（未知）
//     ② years[y] = []   = 旧版把「源返回 0 天」落了盘（陈旧，且 0 天在真实世界不可能，见 CHANGELOG 0 天守卫）
//     ③ years[y] = [日期…] = 已确认（双源交叉验证过）
//   ①②③的峰谷判定都是「按非假日降级」（不许凭空猜假日，这条红线不动），
//   但**上层必须能看见这是降级而非事实**——2027 被当成"全年无假日"时，真假日按高峰 ×2 多算、
//   调休上班日按周末低峰少算，双向错且此前零告警。本函数就是那个"能看见"的探针。
//   返回 true = 该年数据不可信（判定是降级）；false = 已确认（判定是事实）。
//   判定用 mtime 缓存同款 loadHolidays， watcher 长驻进程同样跟随文件更新。
function holidayYearUnknown(tsMs, holidaysPath) {
  if (!holidaysPath) return true; // 没表 = 一概未知（宁可多告警，不可静默假确认）
  try {
    const bj = new Date(Number(tsMs) + 8 * 3600 * 1000);
    const y = String(bj.getUTCFullYear());
    const h = loadHolidays(holidaysPath);
    const v = (h.years || {})[y];
    if (!Array.isArray(v) || v.length === 0) return true; // null / 键缺失 / 空数组 / 非数组 → 未知
    if (h._stale === true && Array.isArray(h.stale_years)
        && h.stale_years.map(String).indexOf(y) >= 0) return true; // 数据在但被标陈旧
    // ↑ stale_years 元素可能是**数字**（refresh-holidays 的目标年份数组是 Number 数组），
    //   必须两边 String 化再比，否则真实落盘形态下这条兜底永远不命中（实测 holidays.json 写出 [2027]）。
    return false;
  } catch (e) { return true; }
}

// tsMs：UTC epoch 毫秒（绝对时刻）→ 返回该时刻在北京时间下是否处于高峰
function isPeakAt(tsMs, pricing, holidaysPath) {
  const bj = new Date(Number(tsMs) + 8 * 3600 * 1000);
  const dow = bj.getUTCDay();
  const hm = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  if (isHolidayBeijing(tsMs, holidaysPath)) return false; // ① 法定假日全天低峰
  const rules = pricing && pricing.deepseek_rules;
  if (rules && typeof rules === 'object') {
    const weekendOff = rules.weekend_off_peak === true || rules.weekend_off_peak === 'true';
    if (weekendOff && (dow === 0 || dow === 6)) return false;
    const ranges = parsePeakSchedule(rules.peak_schedule);
    if (ranges.length) {
      for (const r of ranges) {
        if (r.e <= r.s) continue; // 跨午夜区间暂不处理（官方当前无此档）
        if (hm >= r.s && hm < r.e) return true;
      }
      return false;
    }
    // rules 存在但时段解析不出 → 回落默认（保留周末开关语义）
    if (dow === 0 || dow === 6) return false;
    return DEFAULT_RANGES.some((r) => hm >= r.s && hm < r.e);
  }
  // ② 无 rules → 周末低峰 + 默认时段
  if (dow === 0 || dow === 6) return false;
  return DEFAULT_RANGES.some((r) => hm >= r.s && hm < r.e);
}

module.exports = { isPeakAt, isHolidayBeijing, holidayYearUnknown, parsePeakSchedule, DEFAULT_RANGES };
