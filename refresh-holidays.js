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
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const OUT = path.join(DIR, 'holidays.json');
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
  const nowY = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const years = arg ? [Number(arg)] : [nowY - 1, nowY, nowY + 1];
  const tok = ghToken();
  let old = { years: {} };
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch (e) {}
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
    if (!a && !b) { console.log(`  ⚠ ${y}: 两源都取不到 → 保留旧数据`); continue; }
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

  if (ok === 0 && Object.keys(old.years || {}).length) {
    console.log('  全年份均失败 → 不覆盖现有 holidays.json');
    process.exit(2);
  }
  // v3.19.0（P5）：原子写（tmp + rename），与其它写盘路径同口径（原先裸 writeFileSync，中断留半截 JSON）
  const payload = JSON.stringify({
    updated_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    note: '只列「放假」日期；峰谷判定用它排除法定假日。双源交叉验证，不一致时取交集。',
    sources: { primary: SRC_A, verify: SRC_B },
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
  console.log(`  已写入 ${OUT}`);
  console.log(`  覆盖年份: ${Object.keys(yearsMap).sort().join(', ')}`);
  if (fails.length) { console.log('  部分失败: ' + fails.join(' | ')); process.exitCode = 1; }
})();

// v3.29.0（C-5）：导出纯函数供离线单测（本文件此前无可 require 的导出，且 IIFE 会立即联网写盘）。
module.exports = { crossCheck };
