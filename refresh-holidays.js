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
//
// 用法：node refresh-holidays.js            # 去年/今年/明年
//      node refresh-holidays.js 2027        # 指定年份
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const OUT = path.join(DIR, 'holidays.json');
const SRC_A = 'NateScarlet/holiday-cn';
const SRC_B = 'HankAviator/china-holiday-calendar';

function ghToken() {
  try {
    const c = JSON.parse(fs.readFileSync('C:/Users/14779/.workbuddy/mcp.json', 'utf-8'));
    const s = c.mcpServers || {};
    for (const k of Object.keys(s)) {
      const t = (((s[k] || {}).env) || {}).GITHUB_PERSONAL_ACCESS_TOKEN;
      if (t && String(t).length > 20) return String(t);
    }
  } catch (e) { /* 公开仓库无 token 也能读（受限流） */ }
  return '';
}

async function ghJson(repo, p, tok) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'token-usage-tracker' };
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${p}`, { headers });
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

(async () => {
  const arg = process.argv[2];
  const nowY = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const years = arg ? [Number(arg)] : [nowY - 1, nowY, nowY + 1];
  const tok = ghToken();
  let old = { years: {} };
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch (e) {}
  const yearsMap = Object.assign({}, old.years || {});
  const cross = Object.assign({}, old.cross_check || {});
  let ok = 0; const fails = [];

  for (const y of years) {
    let a = null, b = null;
    try { a = await fromA(y, tok); } catch (e) { fails.push(`A/${y}: ${e.message}`); }
    try { b = await fromB(y, tok); } catch (e) { fails.push(`B/${y}: ${e.message}`); }
    if (!a && !b) { console.log(`  ⚠ ${y}: 两源都取不到 → 保留旧数据`); continue; }
    // 两源比对
    let adopt, agree = null, onlyA = [], onlyB = [];
    if (a && b) {
      const sa = new Set(a), sb = new Set(b.offDays);
      onlyA = a.filter((d) => !sb.has(d));
      onlyB = b.offDays.filter((d) => !sa.has(d));
      agree = onlyA.length === 0 && onlyB.length === 0;
      adopt = agree ? a : a.filter((d) => sb.has(d)); // 不一致 → 取交集（保守）
    } else {
      adopt = a || b.offDays; // 单源可用 → 采用
      agree = null;
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
  fs.writeFileSync(OUT, JSON.stringify({
    updated_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    note: '只列「放假」日期；峰谷判定用它排除法定假日。双源交叉验证，不一致时取交集。',
    sources: { primary: SRC_A, verify: SRC_B },
    years: yearsMap,
    cross_check: cross,
  }, null, 1), 'utf-8');
  console.log(`  已写入 ${OUT}`);
  console.log(`  覆盖年份: ${Object.keys(yearsMap).sort().join(', ')}`);
  if (fails.length) { console.log('  部分失败: ' + fails.join(' | ')); process.exitCode = 1; }
})();
