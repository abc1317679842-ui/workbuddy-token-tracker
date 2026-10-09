#!/usr/bin/env node
// refresh-holidays.js —— 抓取中国法定节假日（放假日期），**双源交叉验证**后写入 holidays.json
//
// 为什么需要：DeepSeek 官方峰谷口径规定 峰时段 = 工作日 01:00-04:00 / 06:00-10:00 UTC
//   **不含中国法定假日**；其余时段（含周末、法定假日全天）一律低峰。
//   技能需要"哪些日子是法定假日"才能算对高峰倍率。
//
// 两个独立来源（不同维护者、不同解析链路），**互为校验**：
//   源A（主）NateScarlet/holiday-cn        → <year>.json   取 days[].isOffDay===true
//   源B（校验）HankAviator/china-holiday-calendar → data/years/<year>.json 取 arrangements[].holiday_dates
//   源B 的 source.source_url 直指「国务院办公厅公告」原文 → 独立权威链路。
//
// 采用策略：两源一致 → 直接采用；**不一致 → 采用交集**（只认两源都说是假日的日期，最保守）
//   并把差异（onlyA / onlyB）写进 holidays.json 的 cross_check，便于人工核查。
// v3.29.0（C-5）：不一致时**额外**输出 stderr 告警（逐日列出「仅A / 仅B 认为是假日」的清单，非只给计数）
//   + 落盘 `cross_check_diff`（按年 `{ only_a: [...], only_b: [...] }`，元素为 YYYY-MM-DD）。
//   动机：「取交集」会把差异**静默吞掉** —— 源 A 页面改版漏抓时，漏判的假日会按高峰 ×2 **多算**、
//   误判的调休工作日会按低峰 **少算**，属双向计费偏差，必须可见。**最终判定（取交集）保持不变**。
//
// 用法：node refresh-holidays.js            # 去年/今年/明年
//      node refresh-holidays.js 2027        # 指定年份
//      node refresh-holidays.js --check     # 只读体检：列 已确认/未知/陈旧 年份 + 建议动作（不联网不写盘）
//
// v3.32.0（方案 H，审计 P1-4）：此前本脚本**零调用方**（README 自认"不会被自动调用"）→ 数据永不更新，
//   靠人记得手动跑等于没有；且 0 天结果被旧版写成 `[]` 落盘 → peak-rules 把 `2027: []` 读成"2027 全年无假日"，
//   与「年份未知」不可区分。本轮三处治理：
//   ① 三态落盘：0 天/两源全失败 → 该年写 **null**（显式未知）+ `_stale/stale_years/stale_detail`，绝不写 []；
//   ② 自适应触发：`holidayRefreshNeeded()` 纯函数（缺今年 / 10月起缺明年 / 任一年陈旧 / >30天未成功），
//      主脚本 maybeRefreshHolidays() 挂每日链路，命中才联网（不满足完全不联网）；
//   ③ 可观测：--check 体检 + 成功落盘时更新节流状态文件 .holidays-refresh.json（lastSuccessAt）。
const fs = require('fs');
const path = require('path');
const os = require('os');
// v3.45.0（审计 P-11 / L1）：数据根探测**不再自带实现**，改为 require 单点实现。
//   本文件原先自带第 3 份逐字相同的 detectWorkBuddyRoot（注释只能写「与 token-tracker.js 同序」，
//   **没有任何机制**保证它真的同步）。这正是全项目的核心病根：正确性靠注释约束而非结构约束。
//   v3.42.0 抽 wb-root.js 时漏了本文件与 deepseek-official.js，收敛只做了一半。
//   改为调用后，判据只有一处，改 wb-root.js 即全部生效。
const { detectWorkBuddyRoot } = require('./wb-root.js');

// v3.31.0（审计 P1-16）：写盘路径必须与**读取方同一解析**，消除「潜在分裂」。
//   读取方（token-tracker.js HOLIDAYS_FILE / recalc-day.js:41 / backfill.js:49）一律用
//   `<WB>/skills/token-usage-tracker/holidays.json`（WB = WB_ROOT > 数据根探测）。
//   本文件原先写 `__dirname/holidays.json`：本机安装目录恰好就是那个路径 → 两者同文件、不受影响；
//   但安装目录一旦 ≠ 该路径（手动拷贝/自定义技能根），写入者与读取者就分叉 → 两边峰谷各用一张假日表。
//   这里改为按读取方口径解析；解析不到目录时才退回 __dirname（兜底，保证总能落盘）。
// v3.45.0（审计 P-11）：本函数**已删除** —— 改由顶部 `require('./wb-root.js')` 提供（与
//   token-tracker.js / backfill.js / recalc-day.js / refresh-prices.js 同一份实现）。
//   （原实现与 wb-root.js 逐字相同，属"复制实现靠注释同步"，无任何机制保证同步。）
function resolveOutPath() {
  const WB = process.env.WB_ROOT || detectWorkBuddyRoot();
  const skillsRoot = path.join(WB, 'skills', 'token-usage-tracker');
  try {
    if (fs.existsSync(skillsRoot)) return path.join(skillsRoot, 'holidays.json');
  } catch (e) { /* stat 失败 → 走 __dirname 兜底 */ }
  const fallback = path.join(__dirname, 'holidays.json');
  if (fallback !== path.join(skillsRoot, 'holidays.json')) {
    process.stderr.write(`[refresh-holidays] ⚠ 未按读取方口径找到技能目录 ${skillsRoot} → 退回 ${fallback}（若读取方在此之外, 两处假日表会分叉, 峰谷判定双边不一致）\n`);
  }
  return fallback;
}
const OUT = resolveOutPath(); // v3.31.0 之前：path.join(__dirname, 'holidays.json')
const SRC_A = 'NateScarlet/holiday-cn';
const SRC_B = 'HankAviator/china-holiday-calendar';
const TIMEOUT_MS = 15000; // v3.19.0（P5）：单请求超时（与 deepseek-official 的 15s 同口径）

// v3.18.1：token 只从环境变量读取（GH_TOKEN / GITHUB_TOKEN），不再读任何本地凭据文件。
// 公开仓库无 token 也能读（受 GitHub 限流 60 次/小时，节假日刷新每天最多 1 次，够用）。
function ghToken() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  return t && String(t).length > 20 ? String(t) : '';
}

async function ghJson(repo, p, tok) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'token-usage-tracker' };
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  // v3.19.0（P5）：加超时——原先裸 fetch，网络 hang 会让进程永久挂起（手动跑卡终端）。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/contents/${p}`, { headers, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${repo}/${p}`);
  const j = await res.json();
  if (!j.content) throw new Error(`无 content @ ${repo}/${p}`);
  return JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
}

// 源A：{days:[{name,date,isOffDay}]} → 放假日
async function fromA(y, tok) {
  const o = await ghJson(SRC_A, `${y}.json`, tok);
  return (o.days || []).filter((d) => d.isOffDay).map((d) => d.date).sort();
}

// 源B：{arrangements:[{holiday_dates:[...]}], source:{source_url}} → 放假日 + 官方出处
async function fromB(y, tok) {
  const o = await ghJson(SRC_B, `data/years/${y}.json`, tok);
  const set = new Set();
  for (const a of o.arrangements || []) for (const d of a.holiday_dates || []) set.add(d);
  return { offDays: [...set].sort(), officialUrl: (o.source || {}).source_url || '', declared: o.holiday_day_count || null };
}

// v3.29.0（C-5）：两源交叉校验抽为**纯函数**（便于离线单测，见下）。
// 逻辑与修复前的内联实现**逐字等价**，判定结果一格未改——只把「取交集」的计算显式化，以便直接断言 adopt。
//   onlyA / onlyB：仅源A / 仅源B 认定为「放假」的日期（YYYY-MM-DD），供告警与 cross_check_diff 使用
//   agree：两源完全一致 → true；有差异 → false（单源场景不走本函数，由调用方置 null）
//   adopt：**最终采用值 = 交集（保守策略）**；一致时即 a 本身
function crossCheck(a, bOffDays) {
  const sa = new Set(a), sb = new Set(bOffDays);
  const onlyA = a.filter((d) => !sb.has(d));
  const onlyB = bOffDays.filter((d) => !sa.has(d));
  const agree = onlyA.length === 0 && onlyB.length === 0;
  const adopt = agree ? a : a.filter((d) => sb.has(d)); // 不一致 → 取交集（保守）
  return { onlyA, onlyB, agree, adopt };
}

// v3.29.0（C-5）：IIFE 仅在**直接运行**时执行。原实现无此守卫——一旦被 require 就会立即联网抓取
// 并覆盖 holidays.json（对测试/复用是隐患，也与本仓库其它脚本的 `require.main === module` 约定不一致）。
if (require.main === module) (async () => {
  const arg = process.argv[2];
  // v3.32.0（方案 H4）：只读体检——列出 已确认/未知/陈旧 年份与建议动作。不联网、不写盘、不 require 网络。
  if (arg === '--check') {
    const nowMs = Date.now() + 8 * 3600e3;
    let h = {};
    try { h = JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch (e) { h = {}; }
    const years = h.years || {};
    const stale = (h._stale === true && Array.isArray(h.stale_years)) ? h.stale_years : [];
    const detail = h.stale_detail || {};
    const keys = Object.keys(years).sort();
    const confirmed = keys.filter((y) => Array.isArray(years[y]) && years[y].length > 0);
    const unknown = keys.filter((y) => !(Array.isArray(years[y]) && years[y].length > 0));
    const thisYear = new Date(nowMs).getUTCFullYear();
    const month = new Date(nowMs).getUTCMonth() + 1;
    console.log('[refresh-holidays] --check（只读体检，不联网不写盘）');
    console.log(`  已确认: ${confirmed.join(', ') || '（无）'}`);
    console.log(`  未知:   ${unknown.join(', ') || '（无）'}`);
    console.log(`  陈旧:   ${stale.join(', ') || '（无）'}`);
    for (const y of stale) console.log(`          ${y}: 自 ${(detail[y] && detail[y].since) || '?'} — ${(detail[y] && detail[y].reason) || ''}`);
    if (!confirmed.includes(String(thisYear))) {
      console.log(`  ⚠ 今年(${thisYear})无假日数据 → 峰谷判定按非假日降级：真假日按高峰 ×2 多算、调休上班日按周末低峰少算`);
      console.log(`    → 联网后跑 node refresh-holidays.js ${thisYear} 可修复（默认自动链路同样会探测）`);
    } else if (!confirmed.includes(String(thisYear + 1)) && month >= 10) {
      console.log(`  ℹ 明年(${thisYear + 1})暂无数据属预期：国务院次年安排约 11 月发布，10 月起自动链路每日探测，发布后自动落地`);
    }
    process.exit(0);
  }
  const nowY = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const years = arg ? [Number(arg)] : [nowY - 1, nowY, nowY + 1];
  const tok = ghToken();
  let old = { years: {} };
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch (e) {} // silent-ok:降级 — 旧年表读取失败即视为空（随后会按新表写）
  const yearsMap = Object.assign({}, old.years || {});
  const cross = Object.assign({}, old.cross_check || {});
  // v3.29.0（C-5）：两源差异单独留一份**浅层、按年**的清单，供排查与文档直接引用
  // （cross_check 里虽已有 only_a/only_b，但深埋在按年对象内、且与一堆元数据混在一起）。
  const crossDiff = Object.assign({}, old.cross_check_diff || {});
  let ok = 0; const fails = [];

  for (const y of years) {
    let a = null, b = null;
    try { a = await fromA(y, tok); } catch (e) { fails.push(`A/${y}: ${e.message}`); }
    try { b = await fromB(y, tok); } catch (e) { fails.push(`B/${y}: ${e.message}`); }
    // v3.32.0（方案 H1）：无有效旧数据时给该年写 **null 显式未知占位**（绝不 []）——
    //   键缺失与 null 同义（都是"未知"），写 null 是为了让"从未获取成功"在文件里显式可见，
    //   也让 --check 与 holidayRefreshNeeded 的分类天然成立。已有有效旧数据（真实世界抓到过的）
    //   则保留不动 —— 源临时异常不该把好数据冲掉（CHANGELOG 0 天守卫的"保留旧数据"语义不变）。
    const keepOldOrMarkUnknown = () => {
      const oldV = yearsMap[String(y)];
      if (!Array.isArray(oldV) || oldV.length === 0) yearsMap[String(y)] = null;
    };
    if (!a && !b) { keepOldOrMarkUnknown(); console.log(`  ⚠ ${y}: 两源都取不到 → 保留旧数据`); continue; }
    // 两源比对（v3.29.0/C-5：计算抽为纯函数 crossCheck，逻辑与原先内联实现逐字等价）
    let adopt, agree = null, onlyA = [], onlyB = [];
    if (a && b) {
      const cc = crossCheck(a, b.offDays);
      onlyA = cc.onlyA; onlyB = cc.onlyB; agree = cc.agree; adopt = cc.adopt;
    } else {
      adopt = a || b.offDays; // 单源可用 → 采用
      agree = null;
    }
    // v3.29.0（C-5）：**两源不一致必须告警**（原先只在 stdout 打两行，人工可见但不会被日志/CI 捕获；
    // 「取交集」又会把差异静默吞掉 → 源 A 页面改版漏抓的假日会双向出错：漏判的假日按高峰 ×2 **多算**，
    // 误判的调休工作日按低峰 **少算**）。故补 stderr：**逐日清单**，不是只给计数。
    // 位置刻意放在下方「空年守卫」之前 —— 否则「交集为空 → 保留旧数据」这种最严重的分歧会被 continue 跳过、零告警。
    if (a && b && agree === false) {
      process.stderr.write(`[refresh-holidays] ⚠ ${y} 两源不一致（A=${a.length} 天 / B=${b.offDays.length} 天）→ 按交集取 ${adopt.length} 天（保守）；差异需人工核验\n`);
      process.stderr.write(`[refresh-holidays]   仅源A(${SRC_A}) 认为是假日 ${onlyA.length} 天: ${onlyA.join(' ') || '（无）'}\n`);
      process.stderr.write(`[refresh-holidays]   仅源B(${SRC_B}) 认为是假日 ${onlyB.length} 天: ${onlyB.join(' ') || '（无）'}\n`);
    }
    // v3.24.0（级联⑦）：**空年守卫** —— 中国每年法定假日 ≥11 天（另有调休上班日），全年 0 天
    // 只可能是"源返回了空内容"（页面改版 / API 空响应 / 字段改名），不是真实数据。
    // 原先 `a || b.offDays` 里 [] 是 truthy、空数组照写 → 2027 年被抓成 0 天后，假日判定按
    // "全年工作日"处理：假日按 2× 计费（高估）+ 调休周六按周末低峰（少计），**双向静默**。
    if (!adopt || adopt.length === 0) {
      keepOldOrMarkUnknown();
      console.log(`  ⚠ ${y}: 解析结果为 0 天（真实世界不可能，判定为源异常）→ 保留旧数据`);
      continue;
    }
    yearsMap[String(y)] = adopt;
    cross[String(y)] = {
      agree,
      source_a: `${SRC_A}/${y}.json`,
      source_b: `${SRC_B}/data/years/${y}.json`,
      source_b_official: b ? b.officialUrl : '',
      source_b_declared_count: b ? b.declared : null,
      count_a: a ? a.length : null, count_b: b ? b.offDays.length : null,
      only_a: onlyA, only_b: onlyB,
    };
    // v3.29.0（C-5）：与 cross_check 同步落一份按年差异清单（浅层、供排查/文档引用）
    crossDiff[String(y)] = { only_a: onlyA, only_b: onlyB };
    if (adopt.length) ok++;
    console.log(`  ${y}: A=${a ? a.length : '×'} 天  B=${b ? b.offDays.length : '×'} 天  → ${agree === true ? '✓一致，采用' : (agree === false ? `✗不一致 → 取交集 ${adopt.length} 天` : `仅单源 → 采用 ${adopt.length} 天`)}`);
    if (agree === false) {
      if (onlyA.length) console.log(`      仅A有: ${onlyA.join(' ')}`);
      if (onlyB.length) console.log(`      仅B有: ${onlyB.join(' ')}`);
    }
  }

  const missingYears = years.filter((y) => !(yearsMap[String(y)] || []).length);
  // v3.31.0（审计 P0-6 核心红线）：**一次都没刷到 → 绝不写盘**（原守卫仅在「已有有效旧数据」时才跳过写盘；
  //   首跑/旧文件损坏时 old.years 为空 → 条件不成立 → 照样把 `{years:{}}` 空骨架写进 holidays.json。
  //   空骨架的后果是**全年静默双向错**：真假日不判低峰（按高峰 ×2 多算）+ 调休上班日按周末低峰（少算），
  //   而文件「存在且语法合法」，下游完全看不出假日表不可信）。
  if (ok === 0) {
    const hadOld = Object.keys(old.years || {}).length > 0;
    if (!hadOld) {
      process.stderr.write(`[refresh-holidays] ✗ 全部年份均刷新失败 → **不写盘**（首跑失败写空骨架会让全年法定假日都不判假，峰谷全年双向错且无提示）\n`);
    } else {
      // 已有数据：写入毫无收益（内容=旧内容），且可能把有效数据换成空 → 同样不写
      process.stderr.write(`[refresh-holidays] ✗ 全部年份均刷新失败 → 现有 holidays.json 保持不动\n`);
    }
    if (fails.length) process.stderr.write(`[refresh-holidays]   失败明细: ${fails.join(' | ')}\n`);
    process.exit(2);
  }
  // v3.31.0（P0-6 可见性）：目标年份里仍有缺数据的年 → **逐一告警**（原实现对「某一年没抓到」零提示；
  //   该年会退化为「全年非假日」：真假日按高峰多算、调休上班日按周末少算）。
  if (missingYears.length) {
    process.stderr.write(`[refresh-holidays] ⚠ 以下年份没有可用假日数据: ${missingYears.join(', ')}\n`);
    process.stderr.write(`[refresh-holidays]   这些年份全部日期按「非假日」判定 ⟶ 真假日按高峰 ×2（多算）、调休上班日按周末低峰（少算）；请修复网络/数据源后重跑本脚本\n`);
  }
  // v3.19.0（P5）：原子写（tmp + rename），与其它写盘路径同口径（原先裸 writeFileSync，中断留半截 JSON）
  // v3.32.0（方案 H1）：stale_detail —— 每个缺数据年份的 since/reason 明细（--check 与人工排查消费；
  //   `stale_years` 保持既有字符串数组形态不破坏旧读者，明细另开一字段）。
  const staleDetail = Object.assign({}, old.stale_detail || {});
  for (const y of missingYears) {
    const yy = String(y);
    const failsY = fails.filter((f) => f.includes('/' + yy + ':'));
    staleDetail[yy] = {
      since: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
      reason: failsY.length ? '获取失败: ' + failsY.join('; ') : '源返回 0 天（真实世界不可能，判定为源异常）',
    };
  }
  const payload = JSON.stringify({
    updated_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    note: '只列「放假」日期；峰谷判定用它排除法定假日。双源交叉验证，不一致时取交集。年份值三态：[日期…]=已确认；null/键缺失=未知；见 _stale/stale_years=陈旧。',
    sources: { primary: SRC_A, verify: SRC_B },
    // v3.31.0（P0-6）：缺数据的年份标记——文件自身必须能说明「哪些年不可信」，
    //   供人工排查与后续下游（弹窗/报表）消费；`_stale:true` 时本表不代表真实法定假日全集。
    _stale: missingYears.length > 0,
    stale_years: missingYears,
    stale_detail: staleDetail,
    years: yearsMap,
    cross_check: cross,
    // v3.29.0（C-5）：两源差异清单（按年；两源一致时为空数组）。字段结构见文件头注释。
    cross_check_diff: crossDiff,
  }, null, 1);
  {
    const tmp = OUT + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, OUT);
  }
  // v3.32.0（方案 H3）：成功落盘 → 更新节流状态文件（maybeRefreshHolidays 的条件④"距上次成功>30天"消费）。
  //   失败路径不写它——lastAttemptAt 由主脚本 spawn 前自己记，这里只认"数据真的更新成功"。
  //   **merge 写**：主脚本在状态文件里还有 lastAttemptDay 等节流字段，整文件覆盖会把它们抹掉。
  try {
    const stPath = path.join(path.dirname(OUT), '.holidays-refresh.json');
    let st = {};
    try { st = JSON.parse(fs.readFileSync(stPath, 'utf-8')); } catch (e) { st = {}; }
    st.lastSuccessAt = Date.now();
    st.confirmedYears = Object.keys(yearsMap).filter((y) => Array.isArray(yearsMap[y]) && yearsMap[y].length > 0);
    fs.writeFileSync(stPath, JSON.stringify(st), 'utf-8');
  } catch (e) { /* 状态文件写失败不影响数据落盘成果，下轮按"陈旧"重试 */ }
  console.log(`  已写入 ${OUT}`);
  console.log(`  覆盖年份: ${Object.keys(yearsMap).sort().join(', ')}`);
  if (fails.length) { console.log('  部分失败: ' + fails.join(' | ')); process.exitCode = 1; }
})();

// v3.29.0（C-5）：导出纯函数供离线单测（本文件此前无可 require 的导出，且 IIFE 会立即联网写盘）。
// v3.32.0（方案 H2）：holidayRefreshNeeded —— 自适应触发判定的**纯函数**（主脚本与 selftest 共用同一实现，
//   不许两边各抄一份条件）。命中任一条件返回触发原因字符串；都不命中返回 null（**完全不联网**）。
//   ① 缺今年（当前计费正在用，任何月份都紧急）
//   ② 缺明年 且 当前月 ≥ 10（国务院次年安排约 11 月发布，10-12 月每日探测即覆盖发布窗口；
//      其余 9 个月源里根本没有，刷了只是空跑+噪音）
//   ③ 任一年处于 _stale（持续重试直到成功）
//   ④ 距上次成功 > 30 天（低频兜底，防源方补录调休）
//   同日节流（lastAttemptAt）不在此函数里——它是主脚本 spawn 前的机制层守卫，见 token-tracker.js。
function holidayRefreshNeeded(h, state, nowMs) {
  const bj = new Date(Number(nowMs) + 8 * 3600e3);
  const yCur = bj.getUTCFullYear();
  const month = bj.getUTCMonth() + 1;
  const years = (h && h.years) || {};
  const has = (y) => Array.isArray(years[String(y)]) && years[String(y)].length > 0;
  const staleYears = (h && h._stale === true && Array.isArray(h.stale_years)) ? h.stale_years : [];
  if (!has(yCur)) return 'missing-current';
  if (!has(yCur + 1) && month >= 10) return 'probe-next-year';
  if (staleYears.length > 0) return 'stale';
  const lastOk = Number(state && state.lastSuccessAt) || 0;
  if (!lastOk || (Number(nowMs) - lastOk) > 30 * 24 * 3600e3) return 'aged';
  return null;
}

module.exports = { crossCheck, holidayRefreshNeeded };
