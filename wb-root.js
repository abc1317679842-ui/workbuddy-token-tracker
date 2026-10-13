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
  // v3.58.0（批8-⑦）：marker 全不命中时，先用「目录本身是否存在」再选一轮，最后才兜底。
  //   改前两个候选都没 marker（如 traces/ 尚未首次创建、settings.json 被清空/改名）就**直接**返回
  //   `.workbuddy` —— 若实际用的是 `.workbuddy-ai`，则账本 / toast 日志 / 价库**整套路径错位到另一个根**，
  //   表现为「记账了但报表为空 / 报表读到别人的旧账」，且全程零报错。目录存在性比 marker 弱，但比硬兜底强。
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) { /* 单个候选探测失败不影响下一个 */ }
  }
  // 两个候选都不存在：仍须返回一个可用路径（调用方全部依赖非空返回值，返回 null 会让它们全线抛错）。
  // 此处是**真正的兜底**，保持原行为。
  return path.join(h, '.workbuddy');
}

module.exports = { detectWorkBuddyRoot };
