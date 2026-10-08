// v3.42.0（plan-B B1）：数据根探测「单点实现」。
// 原先 token-tracker.js / backfill.js / recalc-day.js / refresh-prices.js 各抄一份完全相同的
// detectWorkBuddyRoot()，靠注释约定同步——这正是本项目要治的 A3 口径分裂的病根土壤。
// 现在 4 处调用方统一 require 本文件（各自独立 require，避免加载顺序问题），改这里即可。
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

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

module.exports = { detectWorkBuddyRoot };
