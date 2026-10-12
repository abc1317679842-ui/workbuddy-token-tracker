'use strict';
// ledger-merge.js —— 账本合并（backfill --write 专用**纯函数**模块）
//
// v3.55.0（审计批5·S3）：把原 backfill.js 锁内的 `Object.assign({}, cur, newDaily)` 抽成可单测的纯函数。
//   旧式合并的 key 是**日期** → 同日期整块被 newDaily 顶掉：某模型的用量只存在于已删除/归档的
//   transcript（重放抓不到）时，账本里该模型当天的量被**抹掉**，唯一出路是去翻 `.bak-backfill-*`。
//   backfill.js 的扫描指纹比对（+锁内二次比对）只缓解「扫描期间新写入被覆盖」，管不了这一路；
//   该文件自己就在注释里承认了这个缺陷（"会被 Object.assign 直接覆盖..."）。
//
// 合并语义（与水位线「逐键取大、绝不删键」同一哲学）：
//   ① 日期级：cur 打底 → 重放日期覆盖，其余日期原样保留；
//   ② 模型级：同日期内 od.models 打底 → **重放值覆盖同 key（不取 max** —— backfill 的目的就是用重放
//      重建，取 max 会把历史错值钉死），重放抓不到的 key **保留并打 stale_carried**；
//   ③ total 按合并后的 models 重算（dayTotalOf 由调用方注入，避免两处实现漂移）。
//   不做交互确认 —— 正确性缺陷不该要人点确认，返回 carriedSummary 由调用方打一行 stderr 即可回溯。
//
// 纯函数：不读盘、不写盘、不持锁 → selftest 可直接 require 做行为验证。

/**
 * @param {Object}   cur        当前账本：日期 -> { models, total }
 * @param {Object}   newDaily   重放结果：日期 -> { models, total }
 * @param {Function} dayTotalOf (models) => total
 * @returns {{ merged: Object, carriedSummary: string[] }}
 */
function mergeDailyLedger(cur, newDaily, dayTotalOf) {
  const merged = Object.assign({}, cur);
  const carriedSummary = [];
  for (const date of Object.keys(newDaily || {})) {
    const nd = newDaily[date];
    const od = cur[date];
    if (!od || !od.models || typeof od.models !== 'object') { merged[date] = nd; continue; }
    const m = Object.assign({}, od.models);                    // 旧模型打底 → 绝不丢
    for (const mk of Object.keys((nd && nd.models) || {})) m[mk] = nd.models[mk]; // 重放权威覆盖
    let carried = 0;
    for (const mk of Object.keys(m)) {
      if (!(nd.models && Object.prototype.hasOwnProperty.call(nd.models, mk))) {
        if (m[mk] && typeof m[mk] === 'object' && !Array.isArray(m[mk])) {
          m[mk] = Object.assign({}, m[mk], { stale_carried: true }); // 不就地改旧对象
          carried += 1;
        }
      }
    }
    if (carried > 0) carriedSummary.push(date + '(' + carried + '个模型)');
    merged[date] = { models: m, total: dayTotalOf(m) };
  }
  return { merged: merged, carriedSummary: carriedSummary };
}

module.exports = { mergeDailyLedger };
