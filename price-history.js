// price-history.js —— 每日价格历史快照的**单一实现**（v3.62.0 外部审计 F-3）
//
// 背景（审计 F-3「历史不可复现」）：recalc-day.js 与 backfill.js 都按 **pricing.json 的现价**
// 回算历史金额。厂商调价后跑一次，那天的金额就被按**今天**的单价改写 —— 账本失去"可回放"
// 这个最值钱的属性，且两条路径各自为政（recalc 整日重算 / backfill 逐行重放），零报错。
//
// 根治思路：价库流水线（build_index.py）每天把**当天主链实际生效的定价面**落一份快照
// （`prices/history/prices-<北京日>.json`），回溯工具按"目标行/目标日所属的那一天"取快照计价。
//   快照 = 那天主链路真实在用的价格：index 最终形态 ∪ pricing.json 自有条目（索引未覆盖的），
//   且 pricing.json 的 lock 条目永远赢 —— 与 token-tracker.js `mergeLocalPriceDb` 同一套规则。
//   ⚠ v3.62.0（外部审计 AUD-F-01）：本节此前写的是"含 lock 覆盖层 + 索引最终形态"，实测**不成立**：
//     旧 build_index 只落索引层，pricing.json 自有非 lock 条目（生产 6 个，含用户主用
//     deepseek-v4.1-flash）整体缺席 → recalc 永久判"当天无价"、backfill --write 静默记 ¥0。
//     现由 write_price_history 一侧补齐（见该函数 docstring 的三条规则）。
//
// 为什么单独成文件（而不是在 recalc/backfill 各写一份）：本仓已有三次"复制实现靠注释同步"
// 翻车（A3：峰谷倍率三份、行数口径两份、dayTotalOf 两份 —— 分别记在 v3.46.0 / v3.61.0 /
// v3.59.1）。快照的**读取 + 目录解析 + 快照→pricing 形态转换**是两个消费端（recalc-day /
// backfill）都要用的，故按 transc-lines / ledger-merge / wb-root 的路子抽成单点模块。
//
// 快照格式（build_index.py 的 write_price_history 产出，改动须两端同步）：
//   { "date": "2026-10-16", "built_at": "2026-10-16T03:00:00+08:00",
//     "models": { "<索引键>": { "in": 1.5, "out": 6, "cache": 0.3,
//                              "peak_mult": 2, "effective_from": "...",
//                              "superseded_at": null, "source": "..." } } }
//   ⚠ 只收 in/out 均为数值的条目（None 主价不进历史材料，与索引侧 S-3 拒收同口径）。
'use strict';

const fs = require('fs');
const path = require('path');

// 快照根目录解析。优先级与主脚本 autoDiscoverCnPriceDir 的 env 级一致：
//   ① CN_PRICE_DB_DIR（测试隔离用，主脚本同名单）
//   ② CN_PRICES_DIR（py 侧流水线的同名单；token-tracker.js 把它传给 py，两端目录唯一）
//   ③ 本文件同级 prices/（技能目录内默认）
// 调用方（recalc-day / backfill）**应显式传入** tt.CN_PRICE_DIR（自动发现的那一份），
// 这里的 env 兜底只服务"没传参"的调用与单测。
function historyDirOf(explicitDir) {
  const base = explicitDir
    || process.env.CN_PRICE_DB_DIR
    || process.env.CN_PRICES_DIR
    || path.join(__dirname, 'prices');
  return path.join(base, 'history');
}

function snapshotPath(dir, date) {
  return path.join(dir, `prices-${date}.json`);
}

// 读某日快照；任何失败（不存在 / 损坏 / 形状不对）一律返回 null —— **调用方必须能区分
// "没有快照"与"有快照"**，因为 F-3 的语义是"缺快照就不能按当时价回算"。
//   不抛异常、不打印：告警文案两个消费端各不相同（recalc 要拒绝并给逃逸口、backfill 要按日 WARN），
//   由调用方决定说什么是单一出口；本模块只负责"取不到就说取不到"。
function readSnapshot(dir, date) {
  const d = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const p = snapshotPath(dir, d);
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''); } catch (e) { return null; }
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { return null; }
  if (!snap || typeof snap !== 'object' || !snap.models || typeof snap.models !== 'object') return null;
  return snap;
}

// 目录下全部快照日期（升序）。用于"最早可从哪天开始按当时价回算"的提示与体检。
function listSnapshotDates(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .map((f) => /^prices-(\d{4}-\d{2}-\d{2})\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

// 快照 → pricing 形态（与 mergeLocalPriceDb 从 index.json 建出来的条目同构：
//   input_price / output_price / cached_price / peak_multiplier）。
// 为什么必须同构：findModel / peakMultOf / triPriceRounded / costFromPeakSplit 全部只认这套字段名，
// 自造一套就要在每个消费端各写一遍映射（又一处 A3）。
// cached 缺失时的保守口径与 mergeLocalPriceDb 逐字一致：**按输入价计**（官方未列缓存价 ≠ 免费；
// 按 0 计会把占总金额 ~97% 的缓存 token 免单）。快照里没有 cache 键 = 那天索引里就是 null。
function pricingFromSnapshot(snap) {
  const models = {};
  for (const [k, rec] of Object.entries((snap && snap.models) || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.in !== 'number' || typeof rec.out !== 'number') continue;
    const m = {
      name: k,
      input_price: rec.in,
      output_price: rec.out,
      cached_price: (typeof rec.cache === 'number') ? rec.cache : rec.in,
      region: 'CN',
      price_source: rec.source ? `历史快照(${String(rec.source).slice(0, 40)})` : '历史快照',
    };
    if (typeof rec.peak_mult === 'number') m.peak_multiplier = rec.peak_mult;
    if (rec.effective_from) m.effective_from = rec.effective_from;
    if (rec.superseded_at) m.superseded_at = rec.superseded_at;
    models[k] = m;
  }
  return { models: models, _snapshot_date: (snap && snap.date) || null };
}

module.exports = {
  historyDirOf, snapshotPath, readSnapshot, listSnapshotDates, pricingFromSnapshot,
};
