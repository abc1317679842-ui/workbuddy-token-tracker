'use strict';
// transc-lines.js —— transcript「物理行数 / 残行」口径的**单一实现**（v3.61.0 · 审计 F2）
//
// 病根（v3.59.0~v3.60.0 潜伏，v3.61.0 修）：
//   主链 token-tracker.js 的 readTranscLinesFrom：末尾残行（最后一个 '\n' 之后到 EOF）若
//   JSON.parse 成功 → **收下该行且水位线 +1**（v3.42.0 A19 修「残行永久丢弃」时定下）。
//   backfill.js 的 readRows：`raw.split('\n')` 会把残行**也解析进 rows**（= 回填记账了），
//   但 physicalLines 只数 '\n'（= 水位线没盖住这一行）。
//   → 跑过 backfill 之后，主链下一轮从旧水位线重读该残行 = **同一行 token 记两次**（钱量双错、静默）。
//   backfill.js:248 注释自称「与主脚本 totalLines 同口径」早已过期。
//
// 修法：把口径收敛成这一个函数，两侧都调它 —— 由**调用关系**保证一致，不再有"复制实现靠注释同步"。
//
// 纯函数：不读盘、不写盘、不持锁 → selftest 可直接 require 做行为验证。

/**
 * 度量一段文本的物理行数（含残行），并顺带给出残行解析结果。
 *
 * 口径（与 v3.42.0 A19 起的主链语义逐字一致）：
 *   - `lines` = '\n' 的个数；
 *   - 若最后一个 '\n' 之后到 EOF 的残余文本**非空且 JSON.parse 成功**（它只是缺尾换行、内容已完整）
 *     → `lines + 1`，且 `residualRow` = 解析出的对象；
 *   - 残余文本为空（文件以 '\n' 正常结尾）或**残缺 JSON**（半写行）→ 不加 1，`residualRow` = null
//       （半写行留给下一轮文件长全再读，绝不提前记账）。
//     ⚠ 判据必须真 JSON.parse，不能用"看最后字符是不是 }"之类脆弱判据（字符串里可能含 }）。
 *
 * @param {string|Buffer} text
 * @returns {{ lines: number, residualRow: Object|null, residualText: string }}
 */
function measureTranscriptLines(text) {
  const s = String(text == null ? '' : text);
  const nls = (s.match(/\n/g) || []).length;
  const lastNl = s.lastIndexOf('\n');
  const residualText = lastNl === -1 ? s : s.slice(lastNl + 1);
  const trimmed = residualText.trim();
  if (!trimmed) return { lines: nls, residualRow: null, residualText };
  try {
    return { lines: nls + 1, residualRow: JSON.parse(trimmed), residualText };
  } catch (e) {
    return { lines: nls, residualRow: null, residualText };
  }
}

module.exports = { measureTranscriptLines };
