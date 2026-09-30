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

module.exports = { isPeakAt, isHolidayBeijing, parsePeakSchedule, DEFAULT_RANGES };
