#!/usr/bin/env node
// selftest.js —— 离线冒烟自测（v3.18.2 起随仓库分发，第三方可复跑）
// 用法：node selftest.js
// 不依赖 WorkBuddy 环境：全部在 os.tmpdir() 隔离目录跑，TOKEN_TRACKER_NO_TOAST=1，不碰真实账本、不弹通知。
// 退出码：0=通过（可能有跳过项）；1=有失败项。受限环境（禁止 node 子进程）只跳过需要 spawn 的用例
// （标注 –）；基于 require 的单元测试段始终运行 —— v3.18.4 起不再整表 SKIP。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const NODE = process.execPath;
let pass = 0, fail = 0, skipped = false;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}
function skip(name) { skipped = true; console.log(`  – ${name}（跳过：本环境禁止 node 子进程）`); }

// 环境能力探测：部分沙箱禁止 node→node 子进程（spawnSync 报 EBUSY）。只有需 spawn 的用例受影响。
function canSpawn() {
  try {
    const probe = spawnSync(NODE, ['-e', 'console.log("ok")'], { timeout: 10000, windowsHide: true });
    return !(probe.status === null && probe.error);
  } catch (e) { return false; }
}
const SPAWN_OK = canSpawn();
const SYNTAX_FILES = ['token-tracker.js', 'refresh-prices.js', 'deepseek-official.js', 'refresh-holidays.js',
  'backfill.js', 'recalc-day.js', 'peak-rules.js', 'selftest.js'];

// ── T0：语法检查 ───────────────────────────────────────────────────────────
for (const f of SYNTAX_FILES) {
  if (!SPAWN_OK) { skip(`语法 ${f}`); continue; }
  const r = spawnSync(NODE, ['--check', path.join(SRC, f)], { windowsHide: true });
  ok(`语法 ${f}`, r.status === 0, String(r.stderr || '').slice(0, 120));
}

// ── 隔离环境：<tmp>/tt-selftest-*/skills/token-usage-tracker/ ───────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-selftest-'));
const skillDir = path.join(tmp, 'skills', 'token-usage-tracker');
fs.mkdirSync(skillDir, { recursive: true });
for (const f of ['token-tracker.js', 'refresh-prices.js', 'deepseek-official.js', 'pricing.json', 'holidays.json', 'peak-rules.js', 'recalc-day.js']) {
  fs.copyFileSync(path.join(SRC, f), path.join(skillDir, f));
}
// v3.18.4（G2）：隔离本地官方价库——autoDiscoverCnPriceDir 第②级会扫 ~/WorkBuddy/*/prices/index.json
// （WB_ROOT 管不到这里），否则测试结果取决于"这台机器有没有本地价库"。这里显式指向空库。
const pricesDir = path.join(tmp, 'prices');
fs.mkdirSync(pricesDir, { recursive: true });
fs.writeFileSync(path.join(pricesDir, 'index.json'), JSON.stringify({ models: {} }));
const env = Object.assign({}, process.env, {
  WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', CN_PRICE_DB_DIR: pricesDir,
});
const HOOK_PAYLOAD = JSON.stringify({ session_id: 'selftest', prompt: 't' });

// v3.21.0：预置版本检查状态（7 天闸门闭合 + 已知最新版 0.0.0）→ 让后续 --hook 冒烟
// 不会因为「首次运行」而真的去联网查 GitHub，保持"离线自测"的承诺；T12 段会按需改写它。
fs.writeFileSync(path.join(skillDir, '.update-check.json'),
  JSON.stringify({ lastCheckAt: Date.now(), latestVersion: '0.0.0', failCount: 0, nextRetryAt: 0 }));

// ── T1：--hook 正常路径 → exit 0 ───────────────────────────────────────────
if (!SPAWN_OK) skip('T1 --hook exit 0');
else {
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], { input: HOOK_PAYLOAD, env, timeout: 30000, windowsHide: true });
  ok('T1 --hook exit 0', r.status === 0, `exit=${r.status} ${String(r.stderr).slice(0, 120)}`);
}

// ── T2：--report all → exit 0 且无「读取方指令」（M3 回归） ─────────────────
if (!SPAWN_OK) skip('T2 --report 无指令注入');
else {
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], { env, timeout: 30000, windowsHide: true, encoding: 'utf8' });
  ok('T2 --report all exit 0', r.status === 0, `exit=${r.status}`);
  ok('T2 --report 无指令注入行', (r.stdout || '').indexOf('读取方指令') < 0);
}

// ── T3：损坏 pricing → 备份 + （重建成功时）⚠价库 告警（R4 / F1 / G1） ──────
if (!SPAWN_OK) skip('T3 损坏备份 + ⚠价库 告警');
else {
  const big = JSON.stringify({ date: '2020-01-01', models: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`model-${i}`, { input_price: 1 + i, output_price: 2 + i, region: 'US' }])) }, null, 2);
  fs.writeFileSync(path.join(skillDir, 'pricing.json'), big.slice(0, Math.floor(big.length * 0.7))); // 截断 30%
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], { input: HOOK_PAYLOAD, env, timeout: 90000, windowsHide: true, encoding: 'utf8' });
  const baks = fs.readdirSync(skillDir).filter((f) => f.startsWith('pricing.json.corrupt-'));
  ok('T3 损坏 pricing 产生 .corrupt-* 备份', baks.length === 1, `found=${baks.length}`);
  ok('T3 损坏文件已改名移走', !fs.existsSync(path.join(skillDir, 'pricing.json')) || (() => {
    try { JSON.parse(fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8')); return true; } catch (e) { return false; }
  })());
  const rebuilt = (() => { try { return JSON.parse(fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8')); } catch (e) { return null; } })();
  if (process.env.WB_NO_NET === '1') console.log('  – T3 R4 告警断言：WB_NO_NET=1 断网环境重建走失败分支，前提不成立，已跳过（CI）');
  else if (rebuilt) ok('T3 R4 护栏告警进 stderr（⚠价库）', String(r.stderr || '').indexOf('⚠价库') >= 0, String(r.stderr || '').slice(0, 140));
  else console.log('  – T3 R4 告警断言：重建未完成（离线/受限），已跳过');
}

// ── T4：deepseek-official M7 守卫 —— 损坏 pricing 原地存在时拒绝覆盖 ────────
if (!SPAWN_OK) skip('T4 M7 守卫');
else {
  fs.writeFileSync(path.join(skillDir, 'pricing.json'), '{"broken');
  const r = spawnSync(NODE, [path.join(skillDir, 'deepseek-official.js')], { env, timeout: 60000, windowsHide: true, encoding: 'utf8' });
  ok('T4 M7 守卫拒绝覆盖（非 0 退出 + FAIL_REASON）', r.status !== 0 && String(r.stderr || '').indexOf('拒绝覆盖') >= 0, `exit=${r.status}`);
  ok('T4 损坏文件未被替换', fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8').includes('broken'));
}

// ── T5：账本损坏防护（H6）——BOM 账本不产生 .corrupt-* 备份 ─────────────────
if (!SPAWN_OK) skip('T5 BOM 账本防护');
else {
  fs.writeFileSync(path.join(skillDir, 'daily-usage.json'), '\uFEFF{"days":{}}');
  const before = fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-')).length;
  spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], { env, timeout: 30000, windowsHide: true });
  const after = fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-')).length;
  ok('T5 BOM 账本不再被判损坏（无新增 .corrupt-*）', after === before);
}

// ── T6：直接 require 单测导出函数（不依赖 spawn，受限环境同样运行） ─────────
// v3.18.4（G1/G3）：G1 的根因是"判定口径"问题，只有真实调用 guardRebuildScale 并带上本地价库
// 干扰才能验到——这正是本轮唯一能在任何环境下跑通的关键用例。
{
  const savedEnv = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  process.env.CN_PRICE_DB_DIR = pricesDir;
  let mod = null;
  try { mod = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod = null; }
  if (!mod || typeof mod.guardRebuildScale !== 'function') {
    ok('T6 导出护栏/抢救/dbStaleTag 可单测', false, mod ? '缺少 guardRebuildScale' : 'require 失败');
  } else {
    ok('T6 导出函数可单测', typeof mod.salvageModelsFromText === 'function' && typeof mod.dbStaleTag === 'function');

    const big = JSON.stringify({ date: '2020-01-01', models: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`m${i}`, { input_price: 1 + i, output_price: 2 + i, region: 'US' }])) }, null, 2);
    ok('T6-U1 抢救：16 模型库截断 70% ≥10 条', Object.keys(mod.salvageModelsFromText(big.slice(0, Math.floor(big.length * 0.7))) || {}).length >= 10);

    // G1 回归场景：rebuilt 内存对象混入本地官方库条目（真实用户环境常态），磁盘重建文件只有 2 个模型
    const bakPath = path.join(skillDir, 'pricing.json.corrupt-T6');
    fs.writeFileSync(bakPath, big.slice(0, Math.floor(big.length * 0.7)));
    fs.writeFileSync(path.join(skillDir, 'pricing.json'), JSON.stringify({ date: '2020-01-01', models: { 'model-a': { input_price: 1, output_price: 2 }, 'model-b': { input_price: 1, output_price: 2 } } }, null, 2));
    const rebuiltObj = { models: { 'local-lib-x': { input_price: 9, price_source: '本地官方库' } } };
    const errs = []; const oldWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { errs.push(String(s)); return true; };
    try { mod.guardRebuildScale(rebuiltObj, bakPath); } finally { process.stderr.write = oldWrite; }
    const after = (() => { try { return JSON.parse(fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8')); } catch (e) { return {}; } })();
    ok('T6-U2 G1 回归：本地库干扰下仍并回（磁盘 models > 2）', Object.keys(after.models || {}).length > 2, `models=${Object.keys(after.models || {}).length}`);
    ok('T6-U2 stderr 含 ⚠价库 告警', errs.join('').indexOf('⚠价库') >= 0);
    ok('T6-U3 _shrink_note 已落盘（G3）', Boolean(after._shrink_note), String(after._shrink_note || ''));
    ok('T6-U4 dbStaleTag 显示 ⚠价库缩水', mod.dbStaleTag(after) === '⚠价库缩水', mod.dbStaleTag(after));
    try { fs.unlinkSync(bakPath); } catch (e) {}
  }
  if (savedEnv === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv;
}

// ── T7：v3.19.0 新增回归 ───────────────────────────────────────────────────
// P1：峰谷口径统一——三处工具共用 peak-rules，且不得再有硬编码时段副本
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  ok('T7-P1a backfill/recalc 不含硬编码峰谷范围声明', !/const PEAK_RANGES\s*=/.test(src('backfill.js')) && !/const PEAK_RANGES\s*=/.test(src('recalc-day.js')));
  ok('T7-P1b backfill/recalc 均引用 peak-rules.js', /require\('\.\/peak-rules\.js'\)/.test(src('backfill.js')) && /require\('\.\/peak-rules\.js'\)/.test(src('recalc-day.js')));
  const peak = require(path.join(SRC, 'peak-rules.js'));
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  const rules = { weekend_off_peak: true, peak_schedule: '10:00-13:00,15:00-19:00' }; // 假设官方改版
  const mk = (h, mi) => new Date(Date.UTC(2026, 8, 30, h - 8, mi, 0)); // 2026-09-30 周三
  const expect = { '9:30': false, '10:30': true, '14:30': false, '15:30': true };
  let bad = [];
  for (const [k, want] of Object.entries(expect)) {
    const [h, mi] = k.split(':').map(Number);
    const a = peak.isPeakAt(mk(h, mi).getTime(), { deepseek_rules: rules }, path.join(skillDir, 'holidays.json'));
    const b = ttMod.isPeakHour(rules, mk(h, mi));
    if (a !== want || b !== want) bad.push(`${k}: module=${a} main=${b} want=${want}`);
  }
  ok('T7-P1c 共享模块与主脚本跟随官方动态时段（4/4）', bad.length === 0, bad.join('; '));
}

// P2：recalc-day 写盘三件套（需子进程；受限环境跳过）
if (!SPAWN_OK) skip('T7-P2 recalc-day 写盘原子性/备份');
else {
  const d = { '2026-01-01': { models: { 'deepseek-v4-flash': { in: 1000000, cached: 0, out: 1000, cost: 0, hit: 0 } }, total: { cost: 0, in: 1000000, cached: 0, out: 1000 } } };
  fs.writeFileSync(path.join(skillDir, 'daily-usage.json'), '\uFEFF' + JSON.stringify(d, null, 2)); // 带 BOM（P2 崩溃场景）
  const r = spawnSync(NODE, [path.join(skillDir, 'recalc-day.js'), '2026-01-01'], { env, timeout: 60000, windowsHide: true, encoding: 'utf8' });
  ok('T7-P2a BOM 账本不再崩溃', r.status === 0, `exit=${r.status} ${String(r.stderr || '').slice(0, 120)}`);
  const parsed = (() => { try { return JSON.parse(fs.readFileSync(path.join(skillDir, 'daily-usage.json'), 'utf8')); } catch (e) { return null; } })();
  ok('T7-P2b 写盘后账本仍可解析', Boolean(parsed && parsed['2026-01-01']));
  ok('T7-P2c 写前已备份 .bak-recalc-*', fs.readdirSync(skillDir).some((f) => f.startsWith('daily-usage.json.bak-recalc-')));
}

// P4：backfill 不再继承 _instructions
{
  const src = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8');
  ok('T7-P4 backfill 无 _instructions 继承', !/newDaily\._instructions/.test(src));
}

// ── T8：v3.19.1 新增回归（N1 峰谷静默失效 / N2 watcher IO / N3 告警去重 / N4 假日缓存） ──
// 全部基于 require，不依赖 spawn，受限环境同样运行。
{
  const dso = require(path.join(SRC, 'deepseek-official.js'));

  // N1-a～d：句式解析。官方 2026-09 改为倒装句，v3.19.0 的正则在此处失败且**把好数据清成空串**。
  const NEW_SENTENCE = '空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。';
  ok('T8-N1a 官方现行倒装句式可解析', dso.extractPeakSchedule(NEW_SENTENCE) === '9:00 - 12:00、14:00 - 18:00', String(dso.extractPeakSchedule(NEW_SENTENCE)));
  ok('T8-N1b 旧句式仍兼容', dso.extractPeakSchedule('高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）') === '9:00 - 12:00、14:00 - 18:00');
  ok('T8-N1c 无法识别 → null（不是空串）', dso.extractPeakSchedule('繁忙时段为北京时间 9:00 - 12:00') === null);
  ok('T8-N1d 不变式：倒置 / 超范围 / 低谷对调式均不误判',
    dso.extractPeakSchedule('高峰时段 18:00 - 9:00') === null
    && dso.extractPeakSchedule('高峰时段 25:00 - 26:00') === null
    && dso.extractPeakSchedule('9:00-12:00 为低谷时段，其余为高峰时段') === null);

  // N1-e/f：**失败不得清空**（本次修复核心）
  const p1 = { deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00', weekend_off_peak: true } };
  const act = dso.applyRules(p1, { peak_schedule: null, weekend_off_peak: true, effective_at: null }, '2026-10-01T00:00:00.000Z', 'x');
  ok('T8-N1e ★解析失败保留旧规则（v3.19.0 会清成空串）',
    act === 'error' && p1.deepseek_rules.peak_schedule === '9:00 - 12:00、14:00 - 18:00' && !!p1.deepseek_rules_error,
    `act=${act} sched=${JSON.stringify(p1.deepseek_rules.peak_schedule)}`);
  const p2 = {};
  dso.applyRules(p2, { peak_schedule: '9:00 - 12:00', weekend_off_peak: true, effective_at: null }, '2026-10-01T00:00:00.000Z', 'x');
  ok('T8-N1f 解析成功则覆盖并清除 error 标记', !p2.deepseek_rules_error && p2.deepseek_rules.peak_schedule === '9:00 - 12:00');

  // N1-g/h：toast 可见告警（对齐 ⚠价库 模式）
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  if (typeof ttMod.peakRuleTag === 'function') {
    ok('T8-N1g ⚠时段 标签：error 与空串都显示',
      ttMod.peakRuleTag({ deepseek_rules_error: {} }) === '⚠时段' && ttMod.peakRuleTag({ deepseek_rules: { peak_schedule: '' } }) === '⚠时段');
    ok('T8-N1h 正常规则不显示标签', ttMod.peakRuleTag({ deepseek_rules: { peak_schedule: '9:00 - 12:00' } }) === '');
  } else ok('T8-N1g peakRuleTag 已导出', false, '缺少导出');

  // N2：watcher 未变化即跳过文件 IO
  if (typeof ttMod.watchReadStep !== 'function') ok('T8-N2 watchReadStep 已导出', false);
  else {
    const fp = path.join(tmp, 'watch-transc.jsonl');
    const mkRow = (i) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: i, output_tokens: 1 } }, ts: i });
    fs.writeFileSync(fp, [mkRow(1), mkRow(2), mkRow(3)].join('\n') + '\n');
    const st = { rowsCache: [], linesRead: 0, lastSize: 0, lastReadSize: -1, lastReadMtime: -1 };
    ttMod.watchReadStep(st, fp, fs.statSync(fp));
    const firstLines = st.linesRead;
    const origRead = fs.readFileSync; let reads = 0; const stFixed = fs.statSync(fp);
    fs.readFileSync = function (...a) { reads++; return origRead.apply(this, a); };
    for (let i = 0; i < 5; i++) ttMod.watchReadStep(st, fp, stFixed);
    fs.readFileSync = origRead;
    ok('T8-N2a ★文件未变的 5 轮轮询 readFileSync 调用 0 次', reads === 0 && firstLines === 3, `reads=${reads} lines=${firstLines}`);
    fs.appendFileSync(fp, [mkRow(4), mkRow(5)].join('\n') + '\n');
    ttMod.watchReadStep(st, fp, fs.statSync(fp));
    const full = ttMod.parseTranscChunk(fs.readFileSync(fp, 'utf-8')).length;
    ok('T8-N2b 追加后增量结果与全量解析等价', st.linesRead === full && st.rowsCache.length === full, `${st.linesRead}/${full}`);
    fs.rmSync(fp, { force: true });
  }

  // N3：歧义告警去重（同一模型在多源回路各报一次）
  const rp = require(path.join(SRC, 'refresh-prices.js'));
  const idx = { 'a-kimi-x': { usdIn: 1, usdOut: 2 }, 'b-kimi-y': { usdIn: 3, usdOut: 4 } };
  const beforeN3 = rp.AMBIG_WARNINGS.size;
  rp.looseFind(idx, 'kimi', 'USD源', 'kimi-k3');
  rp.looseFind(idx, 'kimi', 'USD源', 'kimi-k3');
  ok('T8-N3 歧义告警去重（同内容两次只留 1 条）', rp.AMBIG_WARNINGS.size - beforeN3 === 1, `size+${rp.AMBIG_WARNINGS.size - beforeN3}`);

  // N4：假日表 mtime 失效 + 时段分钟
  const pk2 = require(path.join(SRC, 'peak-rules.js'));
  const hp = path.join(tmp, 'holidays-mtime.json');
  const tsN4 = Date.UTC(2026, 9, 1, 2, 0); // 北京时间 2026-10-01
  fs.writeFileSync(hp, JSON.stringify({ years: { '2026': [] } }));
  const hA = pk2.isHolidayBeijing(tsN4, hp);
  fs.writeFileSync(hp, JSON.stringify({ years: { '2026': ['2026-10-01'] } }));
  const tFuture = new Date(Date.now() + 5000); fs.utimesSync(hp, tFuture, tFuture);
  const hB = pk2.isHolidayBeijing(tsN4, hp);
  ok('T8-N4 假日表更新后同进程内立即重载（mtime 失效）', hA === false && hB === true, `${hA} → ${hB}`);
  const rsN4 = pk2.parsePeakSchedule('9:30 - 12:30');
  ok('T8-N4b 时段解析保留分钟', rsN4[0].s === 9.5 && rsN4[0].e === 12.5, JSON.stringify(rsN4));
  fs.rmSync(hp, { force: true });
}

// ── T9：v3.19.2 新增回归（外部全量重审 B1–B10）─────────────────────────────
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));

  // B1：水位线口径必须是「物理完整行数」（'\n' 累计），不能是「可解析行数」
  //   旧实现两者混用 → 空行/坏行使水位线偏小 → 下一轮从偏早偏移重读已计过的行 = 静默重复记账。
  {
    const d1 = path.join(tmp, 'b1');
    fs.mkdirSync(d1, { recursive: true });
    const fp = path.join(d1, 'a.jsonl');
    const good = (i) => JSON.stringify({ type: 'assistant', timestamp: 1000 + i, providerData: { model: 'm1', messageId: 'k' + i, usage: { inputTokens: 10, outputTokens: 1 } } });
    // 内容：good / 空行 / 坏 JSON / good / good（5 个物理行，4 个有效解析行）
    const content = [good(1), '', '{broken', good(2), good(3)].join('\n') + '\n';
    fs.writeFileSync(fp, content);
    const phys = (content.match(/\n/g) || []).length;
    const r1 = ttMod.readTranscLinesFrom(fp, 0);
    ok('T9-B1a 水位线 = 物理换行数（空行/坏行不缩水）', r1.totalLines === phys && r1.rows.length === 3, `totalLines=${r1.totalLines} phys=${phys} rows=${r1.rows.length}`);
    const r2 = ttMod.readTranscLinesFrom(fp, r1.totalLines);
    ok('T9-B1b 从水位线续读不重复（同轮再来 0 行）', r2.rows.length === 0 && r2.totalLines === phys, `rows=${r2.rows.length}`);

    // 半写尾行（无结尾 \n）不计入水位线
    const fp2 = path.join(d1, 'b.jsonl');
    fs.writeFileSync(fp2, good(1) + '\n' + '{"type":"assist'); // 尾行未写完
    const r3 = ttMod.readTranscLinesFrom(fp2, 0);
    ok('T9-B1c 半写尾行不计入水位线（补齐后才会被消费）', r3.totalLines === 1 && r3.rows.length === 1, `totalLines=${r3.totalLines} rows=${r3.rows.length}`);
    fs.rmSync(d1, { recursive: true, force: true });
  }

  // B2：日志目录必须走探测出的数据根 WB（否则数据根迁到 ~/.workbuddy-ai 的用户第二信号源永久失效）
  ok('T9-B2 日志目录走数据根（无写死 ~/.workbuddy/logs）',
    !/path\.join\(os\.homedir\(\),\s*'\.workbuddy',\s*'logs'/.test(src('token-tracker.js'))
    && /path\.join\(WB,\s*'logs',\s*todayStr\(\)\)/.test(src('token-tracker.js')));

  // B3：主脚本内的峰谷/假日死副本必须删除（否则后人照它改 = 改了没用）
  const mainSrc = src('token-tracker.js');
  ok('T9-B3a 主脚本无 parsePeakSchedule 死副本', !/function parsePeakSchedule\s*\(/.test(mainSrc));
  ok('T9-B3b 主脚本无 isChineseHolidayBeijing 死副本 + 未导出',
    !/function isChineseHolidayBeijing\s*\(/.test(mainSrc) && typeof ttMod.parsePeakSchedule === 'undefined');

  // B4：peak_rules 半截链路已删（自由文本，从未参与判定）
  ok('T9-B4a mergeLocalPriceDb 不再写入 peak_rules', !/pricing\.peak_rules\s*=\s*db\.peak_rules/.test(mainSrc));
  ok('T9-B4b build_index.py 不再产出顶层 peak_rules', !/'peak_rules'/.test(src('build_index.py')));

  // B5：backfill 复用主模块（不再手抄镜像）
  const bfSrc = src('backfill.js');
  ok('T9-B5a backfill 无 mergeLocalDbMirror 镜像，改用 tt.mergeLocalPriceDb',
    !/function mergeLocalDbMirror/.test(bfSrc) && /tt\.mergeLocalPriceDb\(/.test(bfSrc));
  ok('T9-B5b backfill 复用 tt.findModel（不再自带实现）',
    !/^function findModel\s*\(/m.test(bfSrc) && /const findModel = tt\.findModel/.test(bfSrc));
  ok('T9-B5c backfill 水位线口径 = 物理换行数',
    /physicalLines:\s*\(raw\.match\(\/\\n\/g\) \|\| \[\]\)\.length/.test(bfSrc));

  // B6：aggregateTranscript 的 subModels 必须做行级时间过滤（旧行不得算进本轮）
  {
    const projDir = path.join(tmp, 'projects', 'b6');
    const subDir = path.join(projDir, 'sess-b6', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const roundStart = Date.UTC(2026, 2, 4, 2, 0, 0);
    const mk = (model, ts, id) => JSON.stringify({ type: 'assistant', timestamp: ts, providerData: { model, messageId: id, usage: { inputTokens: 100, outputTokens: 100 } } });
    const subF = path.join(subDir, 'agent-x.jsonl');
    fs.writeFileSync(subF, mk('hy3-old-model', roundStart - 3600000, 'o1') + '\n' + mk('hy3-new-model', roundStart + 1000, 'n1') + '\n');
    fs.utimesSync(subF, new Date(), new Date()); // mtime=现在 → 文件属本轮（模拟"被唤醒复用"）
    const mainF = path.join(projDir, 'sess-b6.jsonl');
    fs.writeFileSync(mainF, mk('deepseek-v4.1-flash', roundStart + 500, 'm1') + '\n');
    const agg = ttMod.aggregateTranscript(mainF, roundStart);
    const sm = (agg && agg.subModels) || [];
    ok('T9-B6 subModels 只含本轮跑过的子代理模型（旧行不外溢）',
      sm.includes('hy3-new-model') && !sm.includes('hy3-old-model'), JSON.stringify(sm));
    fs.rmSync(projDir, { recursive: true, force: true });
  }

  // B7：全部 agent-*.jsonl 正则必须带 i 标志
  {
    const bad = [];
    for (const f of SYNTAX_FILES) {
      const s = src(f);
      const re = /\^agent-[^\n]*\\\.jsonl\$\/\./g; // 命中 `$/` 紧跟 `.`（= 无 i 标志）
      let m;
      while ((m = re.exec(s)) !== null) bad.push(`${f}`);
    }
    ok('T9-B7 agent-*.jsonl 正则全部带 i 标志（0 处缺）', bad.length === 0, bad.join(','));
  }

  // B8：峰谷按 token 发生时刻判定，不再按"脚本运行时刻"
  {
    const pricing8 = {
      deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00' },
      models: { 'deepseek-v4.1-flash': { name: 'x', input_price: 1, output_price: 2, cached_price: 0.1 } },
    };
    const peakTs = Date.UTC(2026, 2, 4, 2, 0, 0);  // 北京 2026-03-04(周三) 10:00
    const offTs = Date.UTC(2026, 2, 4, 12, 0, 0);  // 北京 20:00
    const st = { model: 'deepseek-v4.1-flash', in: 1000000, cached: 0, out: 0 };
    const cPeak = ttMod.calcCost(st, pricing8, peakTs);
    const cOff = ttMod.calcCost(st, pricing8, offTs);
    ok('T9-B8a calcCost 按显式 tsMs 判峰谷（峰=2×谷）', Math.abs(cPeak - 2 * cOff) < 1e-9 && cOff > 0, `peak=${cPeak} off=${cOff}`);
    const cLast = ttMod.calcCost(Object.assign({ lastTs: peakTs }, st), pricing8);
    const cLastOff = ttMod.calcCost(Object.assign({ lastTs: offTs }, st), pricing8);
    ok('T9-B8b calcCost 回退 stat.lastTs 判峰谷', Math.abs(cLast - 2 * cLastOff) < 1e-9 && cLast > 0, `peak=${cLast} off=${cLastOff}`);

    // 端到端：incrementalRecord 落账必须按"行时间戳"计价（旧实现按脚本运行时刻）
    //   注意 T6 会把 skillDir/pricing.json 覆写成 2 模型假库且不还原 → 此处自建确定的价目表。
    const pricing8b = {
      deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00' },
      models: { 'deepseek-v4.1-flash': { name: 'tb', input_price: 1000, cached_price: 100, output_price: 2000, peak_multiplier: 2, region: 'CN' } },
    };
    fs.writeFileSync(path.join(skillDir, 'pricing.json'), JSON.stringify(pricing8b, null, 2));
    const projDir8 = path.join(tmp, 'projects', 'b8');
    fs.mkdirSync(projDir8, { recursive: true });
    const tsPath8 = path.join(projDir8, 'sess-b8.jsonl');
    fs.writeFileSync(tsPath8, JSON.stringify({
      type: 'assistant', timestamp: peakTs,
      providerData: { model: 'deepseek-v4.1-flash', messageId: 'b8m1', usage: { inputTokens: 1000000, outputTokens: 0 } },
    }) + '\n');
    try { fs.rmSync(path.join(skillDir, '.ledger-watermark.json'), { force: true }); } catch (e) { /* 干净起点 */ }
    ttMod.incrementalRecord(tsPath8, 'sess-b8');
    const ledPath = path.join(skillDir, 'daily-usage.json');
    const led = (() => { try { return JSON.parse(fs.readFileSync(ledPath, 'utf-8').replace(/^\uFEFF/, '')); } catch (e) { return null; } })();
    const tok8 = ttMod.todayStr();
    const rec8 = led && led[tok8] && led[tok8].models && led[tok8].models['deepseek-v4.1-flash'];
    const pk8 = ttMod.mergeLocalPriceDb(JSON.parse(JSON.stringify(pricing8b)));
    const cPeak8 = ttMod.calcCost({ model: 'deepseek-v4.1-flash', in: 1000000, cached: 0, out: 0 }, pk8, peakTs);
    const cOff8 = ttMod.calcCost({ model: 'deepseek-v4.1-flash', in: 1000000, cached: 0, out: 0 }, pk8, offTs);
    ok('T9-B8c incrementalRecord 端到端：账本金额按行时间戳（高峰）计价',
      Boolean(rec8) && cPeak8 > 0 && Math.abs(cPeak8 - 2 * cOff8) < 1e-9 && Math.abs(rec8.cost - cPeak8) < 1e-6,
      `ledger=${rec8 && rec8.cost} expect=${cPeak8} off=${cOff8}`);
    fs.rmSync(projDir8, { recursive: true, force: true });
    try { fs.rmSync(path.join(skillDir, '.ledger-watermark.json'), { force: true }); } catch (e) { /* 清理 */ }
  }
}

// ── T10（v3.19.3）：压缩判定降级 —— 状态机整体移除 + Stop 端单点豁免 ──────────
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  // 剥掉块注释与整行 `//` 注释后再做"残留引用"检查——本版在注释里保留了大量历史说明，
  // 直接对源码文本做正则会被注释误判（教训：守卫测试必须只看代码，不看注释）。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const codeOnly = stripComments(src('token-tracker.js'));

  // a：新判据已导出
  ok('T10-a freshCompactionMarker / compactionMarkerId 已导出',
    typeof ttMod.freshCompactionMarker === 'function' && typeof ttMod.compactionMarkerId === 'function');

  // b~e：判据本身（新鲜命中 / 过期不命中 / 无标记 / 旧格式兼容）
  if (typeof ttMod.freshCompactionMarker === 'function') {
    const mp = path.join(tmp, 'compaction-marker.jsonl');
    const nowMs = Date.now();
    const rowOf = (tag, ts) => JSON.stringify({
      type: 'message', role: 'user', timestamp: ts, uuid: 'u' + tag + ts,
      content: '<' + tag + '>\n历史摘要\n</' + tag + '>',
    });
    const plainRow = JSON.stringify({ type: 'message', role: 'assistant', timestamp: nowMs - 3000, status: 'completed' });

    fs.writeFileSync(mp, [plainRow, rowOf('conversation_history_summary', nowMs - 2000)].join('\n') + '\n');
    const hitFresh = ttMod.freshCompactionMarker(mp);
    ok('T10-b 新鲜压缩标记（2 秒前）→ 命中并返回标记 id',
      typeof hitFresh === 'string' && hitFresh.length > 0, String(hitFresh));

    fs.writeFileSync(mp, rowOf('conversation_history_summary', nowMs - 60 * 60 * 1000) + '\n');
    ok('T10-c 过期压缩标记（1 小时前）→ 不命中（TTL 生效，防旧标记长期留在末尾窗口）',
      ttMod.freshCompactionMarker(mp) === null, String(ttMod.freshCompactionMarker(mp)));

    fs.writeFileSync(mp, JSON.stringify({ type: 'message', role: 'user', timestamp: nowMs, content: '普通用户消息' }) + '\n');
    ok('T10-d 末尾窗口无压缩标记 → null', ttMod.freshCompactionMarker(mp) === null);

    fs.writeFileSync(mp, rowOf('cb_summary', nowMs - 1000) + '\n');
    ok('T10-e 旧格式 <cb_summary> 同样命中', ttMod.freshCompactionMarker(mp) !== null);

    ok('T10-f TTL 可经 COMPACTION_MARKER_TTL_MS 覆盖（传 0 走 env，显式传参优先）',
      ttMod.freshCompactionMarker(mp, 1) === null, 'ttl=1ms 应判过期');
    fs.rmSync(mp, { force: true });
  }

  // g：旧压缩状态机的全部标识符在【代码】中零残留
  const staleIds = [
    'compactionSuspected', 'compactionMode', 'compressionPending', 'compressionWaitStart',
    'lastOmenTs', 'processedMarkers', 'processedMarkerCount', 'curMarkerId', 'tailRawLines',
    'contextOverflowOmenTs', 'contextOverflowOmen', 'WATCH_COMPACT_GRACE_MS', 'COMPRESSION_WAIT_MAX_MS',
  ];
  const staleHits = staleIds.filter((n) => new RegExp('\\b' + n + '\\b').test(codeOnly));
  ok('T10-g 旧压缩状态机标识符在代码中零残留（注释里的历史说明不算）', staleHits.length === 0, staleHits.join(','));

  // h：Stop 端 no-token 分支已接入单点豁免
  ok('T10-h Stop 端 no-token 分支已接入 freshCompactionMarker 豁免',
    /freshCompactionMarker\(tsPath\)/.test(codeOnly)
    && /stop-no-token-compaction-skip/.test(codeOnly));

  // i：豁免分支仍在 no-token 弹窗【之前】，且保留 lastStopAt 推进（顺序错了就白改）
  const idxSnapshot = codeOnly.indexOf('const snap0 = loadSnapshot(sid)');
  const idxGuard = codeOnly.indexOf('freshCompactionMarker(tsPath)');
  const idxToast = codeOnly.indexOf("showToast('本轮无 token 消耗记录'");
  ok('T10-i 豁免判定位于快照推进之后、no-token 弹窗之前',
    idxSnapshot > 0 && idxGuard > idxSnapshot && idxToast > idxGuard,
    `snap=${idxSnapshot} guard=${idxGuard} toast=${idxToast}`);
}

// ── T11（v3.20.0）：--report 区间/CSV/外推 + 轮次明细留档 ────────────────────
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  const mainSrc = src('token-tracker.js');

  // a：新函数全部导出（受限环境同样运行）
  const exported = ['formatUsageRow', 'aggregateRangeModels', 'parseReportRange', 'reportRangeTxt',
    'exportReportCsv', 'reportForecastTxt', 'pruneRoundFiles', 'appendRoundDetail', 'roundLabel', 'transcTextOfRow', 'hitRate'];
  ok('T11-a 新函数已全部导出', exported.every((n) => typeof ttMod[n] === 'function'),
    exported.filter((n) => typeof ttMod[n] !== 'function').join(','));

  // b：parseReportRange —— 区间识别 / 起止写反自动纠正 / 非区间一律 null
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);
  const rWeek = ttMod.parseReportRange('week');
  ok('T11-b1 week = 最近 7 天（含今天）',
    Boolean(rWeek) && rWeek.to === ttMod.todayStr() && dayDiff(rWeek.from, rWeek.to) === 6,
    JSON.stringify(rWeek));
  const rMonth = ttMod.parseReportRange('month');
  ok('T11-b2 month = 本月 1 号 ~ 今天',
    Boolean(rMonth) && rMonth.to === ttMod.todayStr() && /-01$/.test(rMonth.from) && rMonth.from <= rMonth.to,
    JSON.stringify(rMonth));
  const rRev = ttMod.parseReportRange('2026-09-30..2026-09-01');
  const rFwd = ttMod.parseReportRange('2026-09-01..2026-09-30');
  ok('T11-b3 起止写反自动纠正（等价于正序）',
    Boolean(rRev) && rRev.from === '2026-09-01' && rRev.to === '2026-09-30'
    && Boolean(rFwd) && rFwd.from === rRev.from && rFwd.to === rRev.to, JSON.stringify(rRev));
  const notRange = ['', 'all', '2026-09-30', 'summary', 'forecast', 'weekly', '2026-09-01..', '..2026-09-01']
    .filter((x) => ttMod.parseReportRange(x) !== null);
  ok('T11-b4 非区间写法一律返回 null（不会误吞既有入口）', notRange.length === 0, notRange.join(','));

  // c：区间聚合 —— hit 必须按 Σcached/Σin 重算，不能取各天算术均值
  const dd = {
    '2026-01-01': { models: { m: { in: 100, out: 0, cached: 0, total: 100, cost: 1, hit: 0 } } },
    '2026-01-02': { models: { m: { in: 1000000, out: 0, cached: 1000000, total: 1000000, cost: 2, hit: 100 } } },
  };
  const ag = ttMod.aggregateRangeModels(dd, '2026-01-01', '2026-01-02');
  const avgHit = (0 + 100) / 2;
  ok('T11-c1 ★区间 hit 按 Σcached/Σin 重算（不是各天均值）',
    Math.abs(ag.models.m.hit - ttMod.hitRate(1000100, 1000000)) < 1e-9 && Math.abs(ag.models.m.hit - avgHit) > 1,
    `hit=${ag.models.m.hit} 均值=${avgHit}`);
  ok('T11-c2 区间 total 严格等于逐日相加（可与逐日核对账）',
    ag.models.m.total === 1000100 && ag.total.total === 1000100, `m=${ag.models.m.total} t=${ag.total.total}`);
  ok('T11-c3 天数与日期列表正确', ag.days === 2 && ag.dates.join(',') === '2026-01-01,2026-01-02',
    `days=${ag.days} dates=${ag.dates.join(',')}`);
  const ag1 = ttMod.aggregateRangeModels(dd, '2026-01-02', '2026-01-02');
  ok('T11-c4 闭区间边界不越界', ag1.days === 1 && ag1.models.m.in === 1000000, `days=${ag1.days}`);
  const ag0 = ttMod.aggregateRangeModels(dd, '2030-01-01', '2030-01-02');
  ok('T11-c5 空区间不崩且合计全 0', ag0.days === 0 && ag0.total.total === 0 && ag0.total.hit === 0);

  // d：既有四个入口「逐字节不变」——硬编码期望输出（本版新增分支最多的风险点）
  const led11 = {
    '2026-01-02': {
      models: { 'm-a': { in: 1500000, out: 20000, cached: 1400000, total: 1520000, cost: 3.5, hit: 93.33 } },
      total: { in: 1500000, out: 20000, cached: 1400000, total: 1520000, cost: 3.5, hit: 93.33 },
    },
    '2026-01-01': {
      models: { 'm-b': { in: 1000000, out: 1000, cached: 0, total: 1001000, cost: 1.25, hit: 0 } },
      total: { in: 1000000, out: 1000, cached: 0, total: 1001000, cost: 1.25, hit: 0 },
    },
  };
  fs.writeFileSync(path.join(skillDir, 'daily-usage.json'), JSON.stringify(led11, null, 2));
  if (!SPAWN_OK) skip('T11-d 既有 --report 入口逐字节不变');
  else {
    const run = (...a) => spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report'].concat(a),
      { env, timeout: 30000, windowsHide: true, encoding: 'utf8' }).stdout || '';
    const HDR = ['| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |', '| --- | --- | --- | --- | --- | --- | --- |'];
    const wantAll = [
      '===== 2026-01-02 =====',
      ...HDR,
      '| m-a | 150万 | 2万 | 140万 | 93.33% | 152万 | ¥3.50 |',
      '| **合计** | **150万** | **2万** | **140万** | **93.33%** | **152万** | **¥3.50** |',
      '===== 2026-01-01 =====',
      ...HDR,
      '| m-b | 100万 | 1000 | 0 | 0.00% | 100.1万 | ¥1.25 |',
      '| **合计** | **100万** | **1000** | **0** | **0.00%** | **100.1万** | **¥1.25** |',
    ].join('\n') + '\n';
    ok('T11-d1 --report all 逐字节不变', run('all') === wantAll, JSON.stringify(run('all').slice(0, 160)));
    const wantOne = ['===== 2026-01-01 =====', ...HDR,
      '| m-b | 100万 | 1000 | 0 | 0.00% | 100.1万 | ¥1.25 |',
      '| **合计** | **100万** | **1000** | **0** | **0.00%** | **100.1万** | **¥1.25** |'].join('\n') + '\n';
    ok('T11-d2 --report <date> 逐字节不变', run('2026-01-01') === wantOne, JSON.stringify(run('2026-01-01').slice(0, 160)));
    const wantSum = '2026-01-02  输入 150万 / 输出 2万 / 缓存 140万 / 总 152万 tokens ｜ ¥3.50\n'
      + '2026-01-01  输入 100万 / 输出 1000 / 缓存 0 / 总 100.1万 tokens ｜ ¥1.25\n';
    ok('T11-d3 --report summary all 逐字节不变', run('summary', 'all') === wantSum, JSON.stringify(run('summary', 'all').slice(0, 160)));
  }

  // e：区间报告 —— 列头与单日一致 + 必带金额口径声明 + 空区间不崩
  const rTxt = ttMod.reportRangeTxt('2026-01-01', '2026-01-02');
  ok('T11-e1 区间报告列头与单日入口完全一致',
    rTxt.includes('| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |'));
  ok('T11-e2 区间报告必带金额口径声明（不是真实扣费 / 无换算关系）',
    rTxt.includes('不是真实扣费') && rTxt.includes('不存在换算关系'));
  ok('T11-e3 空区间报告不崩', typeof ttMod.reportRangeTxt('1999-01-01', '1999-01-02') === 'string');

  // f：forecast 只推 token，输出里不得出现金额符号
  const fTxt = ttMod.reportForecastTxt();
  ok('T11-f forecast 不含金额符号 ¥（只推 token）', !/¥/.test(fTxt) && fTxt.includes('tokens'), fTxt.split('\n')[1]);

  // g：CSV 导出 —— UTF-8 BOM 必须存在（否则 Excel 中文列头乱码）
  const csvMsg = ttMod.exportReportCsv({ from: '2026-01-01', to: '2026-01-02', label: 't11' });
  const csvPath = (/已导出：(.+?)（/.exec(csvMsg) || [])[1];
  ok('T11-g1 CSV 导出返回路径', Boolean(csvPath) && fs.existsSync(csvPath), csvMsg);
  if (csvPath && fs.existsSync(csvPath)) {
    const buf = fs.readFileSync(csvPath);
    ok('T11-g2 ★CSV 前 3 字节为 UTF-8 BOM(EF BB BF)',
      buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, buf.slice(0, 3).toString('hex'));
    const csvTxt = buf.toString('utf-8');
    ok('T11-g3 CSV 含表头与 ALL 合计行',
      csvTxt.includes('date,model,in,out,cached,hit_pct,total,cost_api_equiv') && /^ALL,__TOTAL__,/m.test(csvTxt));
    ok('T11-g4 CSV 行数 = 表头 + 明细 + 合计（2 天各 1 模型 → 4 行）',
      csvTxt.trim().split('\n').length === 4, String(csvTxt.trim().split('\n').length));
  }

  // h：轮次明细 —— 唯一落点、幂等、无 meta 零影响
  const roundsDir = ttMod.ROUNDS_DIR;
  const roundsFile = path.join(roundsDir, 'rounds-' + ttMod.todayStr().slice(0, 7) + '.jsonl');
  const readRounds = () => {
    try {
      return fs.readFileSync(roundsFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { return []; }
  };
  fs.rmSync(roundsDir, { recursive: true, force: true });
  const projDir11 = path.join(tmp, 'projects', 't11');
  fs.mkdirSync(projDir11, { recursive: true });
  const tsPath11 = path.join(projDir11, 'sess-t11.jsonl');
  const mkRow11 = (i) => JSON.stringify({
    type: 'assistant', timestamp: 1700000000000 + i * 1000,
    providerData: { model: 'm-x', messageId: 'x' + i, usage: { inputTokens: 1000000, outputTokens: 0 } },
  });
  fs.writeFileSync(tsPath11, mkRow11(1) + '\n');
  fs.writeFileSync(path.join(skillDir, 'pricing.json'), JSON.stringify({
    models: { 'm-x': { name: 'x', input_price: 1000, cached_price: 100, output_price: 2000 } },
  }, null, 2));
  try { fs.rmSync(path.join(skillDir, '.ledger-watermark.json'), { force: true }); } catch (e) { /* 干净起点 */ }
  try { fs.rmSync(path.join(skillDir, 'daily-usage.json'), { force: true }); } catch (e) { /* 干净起点 */ }
  const meta11 = {
    sid: 'sess-t11', roundStart: 1700000000000, durMs: 12345, model: 'm-x', subModels: [],
    subCount: 0, teamActive: false, source: 'test', label: '测试轮',
  };
  ttMod.incrementalRecord(tsPath11, 'sess-t11', meta11);
  const rr1 = readRounds();
  ok('T11-h1 带 meta 记账后落一条轮次明细', rr1.length === 1 && rr1[0].in === 1000000 && rr1[0].source === 'test',
    `n=${rr1.length} in=${rr1[0] && rr1[0].in}`);
  ok('T11-h2 ★明细字段名为 costApiEquiv 而非 cost（口径命名，防后人误当真实花费）',
    rr1.length === 1 && rr1[0].costApiEquiv > 0 && rr1[0].cost === undefined,
    JSON.stringify(rr1[0] || {}).slice(0, 120));
  ttMod.incrementalRecord(tsPath11, 'sess-t11', meta11);
  const rr2 = readRounds();
  ok('T11-h3 ★同轮二次记账（无新增行）不重复落档（幂等由记账水位线白送）', rr2.length === 1, `n=${rr2.length}`);
  fs.appendFileSync(tsPath11, mkRow11(2) + '\n');
  ttMod.incrementalRecord(tsPath11, 'sess-t11'); // 不传 meta = 其余 8 个调用点的形态
  const rr3 = readRounds();
  ok('T11-h4 不传 meta 的调用点零影响：账本照记、明细不落', rr3.length === 1, `n=${rr3.length}`);
  const ledNow = (() => { try { return JSON.parse(fs.readFileSync(path.join(skillDir, 'daily-usage.json'), 'utf-8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
  const rec11 = ledNow[ttMod.todayStr()] && ledNow[ttMod.todayStr()].models['m-x'];
  ok('T11-h5 不传 meta 时账本仍正确累加（200 万 in）', Boolean(rec11) && rec11.in === 2000000, rec11 && rec11.in);

  // i：roundLabel —— 取出本轮首条非注入 user 消息
  const tsL = path.join(tmp, 'label-t11.jsonl');
  const labRow = (c) => JSON.stringify({ type: 'message', role: 'user', timestamp: 1700000000000, content: c });
  fs.writeFileSync(tsL, [labRow('帮我看看这个方案'), JSON.stringify({ type: 'assistant', timestamp: 1700000001000 })].join('\n') + '\n');
  ok('T11-i1 提取本轮首条 user 消息（≤40 字）', ttMod.roundLabel(tsL, 1699999999000) === '帮我看看这个方案',
    JSON.stringify(ttMod.roundLabel(tsL, 1699999999000)));
  fs.writeFileSync(tsL, labRow('<task-notification>x') + '\n');
  ok('T11-i2 注入型 user 行标为 [注入]（不拿注入文本当标签）',
    ttMod.roundLabel(tsL, 1699999999000) === '[注入] task-notification', JSON.stringify(ttMod.roundLabel(tsL, 1699999999000)));
  fs.writeFileSync(tsL, labRow('上一条消息') + '\n');
  ok('T11-i3 早于 roundStart 的 user 行不算本轮（返回空串）',
    ttMod.roundLabel(tsL, 1700000001000) === '', JSON.stringify(ttMod.roundLabel(tsL, 1700000001000)));
  ok('T11-i4 文件不存在不抛错', ttMod.roundLabel(path.join(tmp, 'no-such-file.jsonl'), 1) === '');

  // j：过期 rounds 清理
  fs.mkdirSync(roundsDir, { recursive: true });
  fs.writeFileSync(path.join(roundsDir, 'rounds-2020-01.jsonl'), '{}\n');
  fs.writeFileSync(roundsFile, '{}\n');
  const removed11 = ttMod.pruneRoundFiles();
  ok('T11-j 清理过期月份、保留当月',
    removed11 === 1 && !fs.existsSync(path.join(roundsDir, 'rounds-2020-01.jsonl')) && fs.existsSync(roundsFile),
    `removed=${removed11}`);
  fs.rmSync(roundsDir, { recursive: true, force: true });

  // k：源码级守卫
  const gi = fs.readFileSync(path.join(SRC, '.gitignore'), 'utf-8');
  ok('T11-k1 .gitignore 已排除 rounds/ 与 exports/', /^rounds\/$/m.test(gi) && /^exports\/$/m.test(gi));
  ok('T11-k2 明细唯一落点在 recordUsage 内（不在 Stop 三个出口各写一遍）',
    /if \(saved\) \{ try \{ appendRoundDetail\(/.test(mainSrc));
  ok('T11-k3 明细写在账本落盘之后、锁释放之前', (() => {
    const i1 = mainSrc.indexOf('const saved = saveDailyUsageRaw(d);');
    const i2 = mainSrc.indexOf('appendRoundDetail(byModel, stat, pricing, tsMs, meta)', i1);
    const i3 = mainSrc.indexOf('}, { ttl: 300000, retries: 50 });', i1);
    return i1 > 0 && i2 > i1 && i3 > i2;
  })());
  ok('T11-k4 recordUsage 的 meta 为可选参数（不传 = 旧行为，8 个调用点零改动）',
    /function recordUsage\(stat, pricing, byModel, tsMs, meta\)/.test(mainSrc));
}

// ── T12（v3.21.0 建立 / v3.22.0 扩充）：版本更新提示 ──────────────────────────────
// 覆盖：版本比较（含畸形 tag）/ 闸门 / 节流 / 退避 / 状态容错 / 双端点检测点 /
//       挂载点下沉 out() 的源码守卫 / hookIdle 与 toast 兜底 / 版本号四处一致。
// 全部离线：把 `.update-check.json` 预置成「闸门闭合」状态，就不会发网络请求。
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  const mainSrc = src('token-tracker.js');
  const UF = path.join(skillDir, '.update-check.json');
  const put = (o) => fs.writeFileSync(UF, JSON.stringify(o));
  const day = 24 * 3600 * 1000;
  const now = Date.now();

  // a：新增函数/常量已导出
  const ex12 = ['updateNotice', 'cmpVersion', 'loadUpdateState', 'saveUpdateState', 'queryLatestTag',
    'updateTagForToast', 'maybeFetchLatest', 'maybeFetchLatestForStop', 'claimNotify', 'hookIdle'];
  ok('T12-a 版本检查函数/常量已全部导出',
    ex12.every((n) => typeof ttMod[n] === 'function')
      && typeof ttMod.SKILL_VERSION === 'string'
      && typeof ttMod.HOOK_IDLE_MS === 'number' && ttMod.HOOK_IDLE_MS === 3 * 24 * 3600 * 1000,
    ex12.filter((n) => typeof ttMod[n] !== 'function').join(','));

  // b：版本号**数值**比较（直接字符串比较会把 '3.9.0' > '3.10.0' 判成 true）
  const cv = ttMod.cmpVersion;
  ok('T12-b1 ★3.9.0 < 3.10.0（数值比较，字符串比较会判错）', cv('3.9.0', '3.10.0') === -1, cv('3.9.0', '3.10.0'));
  ok('T12-b2 v3.21.0 > 3.20.0（带 v 前缀同样正确）', cv('v3.21.0', '3.20.0') === 1);
  ok('T12-b3 3.21 == 3.21.0（缺段按 0 补）', cv('3.21', '3.21.0') === 0);
  ok('T12-b4 ★非版本形状的 tag（release-2026 / junk / 空）一律返回 0，绝不误报「有新版」',
    cv('release-2026', '3.21.0') === 0 && cv('junk', '3.21.0') === 0 && cv('', '3.21.0') === 0);
  ok('T12-b5 相等返回 0 / 缺段按 0 补（3.21.0 与 3.21.0.0 等价）',
    cv('3.21.0', '3.21.0') === 0 && cv('3.21.0.0', '3.21.0') === 0);

  // c：闸门闭合 + 远端更高 → 返回提示（离线：lastCheckAt=now 关掉 7 天检查）
  put({ lastCheckAt: now, latestVersion: '9.9.9', failCount: 0, nextRetryAt: 0 });
  const n1 = ttMod.updateNotice();
  ok('T12-c1 ★远端更高时返回一行提示（闸门闭合 → 零联网）',
    typeof n1 === 'string' && n1.indexOf('v9.9.9') >= 0, JSON.stringify(n1));
  ok('T12-c2 提示文案极短（≤ 45 字符）且不含金额/链接/升级步骤',
    n1.length > 0 && n1.length <= 45 && !/¥|http|git |覆盖|备份/.test(n1), `len=${n1.length} ${n1}`);

  // d：节流 —— 同版本 24h 内第二次静默
  ok('T12-d1 同版本 24h 内第二次不重复提示', ttMod.updateNotice() === '');
  const st1 = ttMod.loadUpdateState();
  ok('T12-d2 提示计数已落盘（notifiedVersion + notifyCount）',
    st1.notifiedVersion === '9.9.9' && st1.notifyCount === 1, JSON.stringify(st1));
  put(Object.assign({}, st1, { notifyCount: ttMod.UPDATE_MAX_NOTIFY }));
  ok('T12-d3 达到提示上限后彻底静默', ttMod.updateNotice() === '');

  // e：本地已是最新 / 远端更旧 → 静默
  put({ lastCheckAt: now, latestVersion: ttMod.SKILL_VERSION });
  ok('T12-e1 远端 == 本地 → 静默', ttMod.updateNotice() === '');
  put({ lastCheckAt: now, latestVersion: '3.9.0' });
  ok('T12-e2 远端低于本地（3.9.0 < 当前版本）→ 静默', ttMod.updateNotice() === '');

  // f：退避未到 → 静默且不联网（nextRetryAt 在未来）
  put({ failCount: 1, nextRetryAt: now + 3600000 });
  ok('T12-f 退避未到（nextRetryAt 在未来）→ 静默且不发起检查', ttMod.updateNotice() === '');

  // g：状态文件损坏/缺失容错
  fs.writeFileSync(UF, '{broken json');
  ok('T12-g1 状态文件损坏 → 返回空状态不抛错', JSON.stringify(ttMod.loadUpdateState()) === '{}');
  fs.rmSync(UF, { force: true });
  ok('T12-g2 状态文件缺失 → 返回空状态不抛错', JSON.stringify(ttMod.loadUpdateState()) === '{}');

  // h：源码级守卫（v3.22.0 重写）—— 追加逻辑必须**下沉在 out() 内部**，
  //    因为 v3.21.0 把它挂在两个 out() 调用点上，会被 --hook 的 3 条早退分支 return 绕过。
  ok('T12-h1 ★v3.21.0 的 withUpdate 包装函数已彻底删除（挂在调用点上就会被 return 绕过）',
    mainSrc.indexOf('withUpdate') < 0, '仍存在 withUpdate');
  ok('T12-h2 ★追加逻辑下沉到 out() 内部（`if (asHook && upNote)` 夹在 out 定义体与 stdout.write 之间）', (() => {
    const i0 = mainSrc.indexOf('const out = (hookOut) => {');
    const i1 = mainSrc.indexOf('if (asHook && upNote)', i0);
    const i2 = mainSrc.indexOf('process.stdout.write(asHook || asStop', i0);
    return i0 > 0 && i1 > i0 && i2 > i1;
  })());
  ok('T12-h3 ★upNote 在 main() 开头只算一次，且位于 out() 定义之前（保证任何早退分支都带得上）', (() => {
    const iUp = mainSrc.indexOf("const upNote = asHook ? updateNotice() : '';");
    const iOut = mainSrc.indexOf('const out = (hookOut) => {');
    return iUp > 0 && iOut > 0 && iUp < iOut;
  })());
  ok('T12-h4 Stop 端兜底预检查在弹窗之前触发（`if (asStop) maybeFetchLatestForStop();`）',
    /if \(asStop\) maybeFetchLatestForStop\(\);/.test(mainSrc));
  ok('T12-h5 ★检测点双端点：queryLatestTag 同时查 releases/latest 与 git/matching-refs/tags/v',
    mainSrc.indexOf("'/releases/latest'") >= 0 && mainSrc.indexOf("'/git/matching-refs/tags/v'") >= 0);
  ok('T12-h6 ★两端点结果取版本号较大者（内联 cmp + `if (cmp(t, best) > 0) best = t;`）',
    /const cmp = \(a, b\) => \{/.test(mainSrc) && /if \(cmp\(t, best\) > 0\) best = t;/.test(mainSrc));
  ok('T12-h7 联网仍受总开关约束（ENABLE_NETWORK && ENABLE_UPDATE_CHECK 出现在 3 条通道函数里）',
    (mainSrc.match(/ENABLE_NETWORK && ENABLE_UPDATE_CHECK/g) || []).length >= 3);
  ok('T12-h8 .gitignore 已排除 .update-check.json', /^\.update-check\.json$/m.test(src('.gitignore')));

  // p：v3.22.0 新增纯函数（全部离线——闸门/退避未到即不发起网络请求）
  ok('T12-p1 hookIdle：无 lastHookAt（从没跑过 --hook）→ true', ttMod.hookIdle(now, {}) === true);
  ok('T12-p2 hookIdle：lastHookAt 刚刷新 → false', ttMod.hookIdle(now, { lastHookAt: now }) === false);
  ok('T12-p3 ★hookIdle 边界：正好 3 天 → true（≥ HOOK_IDLE_MS 即判定为「没配 hook」）',
    ttMod.hookIdle(now, { lastHookAt: now - ttMod.HOOK_IDLE_MS }) === true);
  ok('T12-p4 hookIdle：阈值内 1 小时 → false（还没到）',
    ttMod.hookIdle(now, { lastHookAt: now - ttMod.HOOK_IDLE_MS + 3600000 }) === false);

  ok('T12-p5 claimNotify：远端不高于本地 → false',
    ttMod.claimNotify({}, ttMod.SKILL_VERSION, now) === false && ttMod.claimNotify({}, '3.9.0', now) === false);
  const cs = {};
  ok('T12-p6 ★claimNotify：首次命中 → true 并写入 notifiedVersion / notifyCount / lastNotifyAt',
    ttMod.claimNotify(cs, '9.9.9', now) === true && cs.notifiedVersion === '9.9.9' && cs.notifyCount === 1 && cs.lastNotifyAt === now);
  ok('T12-p7 ★同版本 24h 内第二次 → false（节流生效）', ttMod.claimNotify(cs, '9.9.9', now + 3600000) === false);
  ok('T12-p8 同版本满 24h 后 → true（允许再提示一次）', ttMod.claimNotify(cs, '9.9.9', now + 24 * 3600 * 1000) === true);
  ok('T12-p9 ★达到上限 2 次后彻底静默', ttMod.claimNotify(cs, '9.9.9', now + 48 * 3600 * 1000) === false && cs.notifyCount === 2);
  ok('T12-p10 claimNotify：换新版本 → 计数重置（新版本重新给 2 次机会）',
    ttMod.claimNotify(cs, '9.9.10', now) === true && cs.notifyCount === 1);

  ok('T12-p11 maybeFetchLatest：闸门未到（lastCheckAt=now）→ false 且不联网',
    ttMod.maybeFetchLatest({ lastCheckAt: now }, now) === false);
  ok('T12-p12 maybeFetchLatest：退避未到（nextRetryAt 在未来）→ false 且不联网',
    ttMod.maybeFetchLatest({ lastCheckAt: 0, nextRetryAt: now + 3600000 }, now) === false);

  // q：toast 兜底标记（模块级缓存 → 只测一次 + 缓存行为；反向分支由源码守卫覆盖）
  put({ lastCheckAt: now, latestVersion: '9.9.9', failCount: 0, nextRetryAt: 0 }); // 无 lastHookAt → hookIdle=true
  const tag1 = ttMod.updateTagForToast(now);
  ok('T12-q1 ★没配 hook（无 lastHookAt）→ toast 兜底标记产出 `⬆v9.9.9`', tag1 === '⬆v9.9.9', JSON.stringify(tag1));
  ok('T12-q2 同进程重复调用返回缓存（一次 Stop 会格式化多次 toastLine1，不能重复消费计数）',
    ttMod.updateTagForToast(now + 99999) === tag1);
  ok('T12-q3 ★源码守卫：updateTagForToast 内先判 hookIdle、再 claimNotify（hook 活着 → 永不产出标记）', (() => {
    const i = mainSrc.indexOf('function updateTagForToast');
    const body = mainSrc.slice(i, mainSrc.indexOf('function maybeFetchLatestForStop', i));
    return body.indexOf('if (!hookIdle(now, st)) return gUpTag;') > 0
      && body.indexOf('claimNotify(st') > body.indexOf('hookIdle(now, st)');
  })());

  // i：版本号四处一致（防漂移：源码常量 / manifest / README 徽章 / CHANGELOG 顶部条目）
  const v = ttMod.SKILL_VERSION;
  ok('T12-i1 SKILL_VERSION 与 manifest.yaml 一致',
    new RegExp(`^version:\\s*${v.replace(/\./g, '\\.')}\\s*$`, 'm').test(src('manifest.yaml')));
  ok('T12-i2 SKILL_VERSION 与 README 徽章一致',
    src('README.md').indexOf(`badge/version-v${v}-blue`) >= 0);
  ok('T12-i3 SKILL_VERSION 与 CHANGELOG 顶部条目一致',
    new RegExp(`^## v${v.replace(/\./g, '\\.')}（`, 'm').test(src('CHANGELOG.md')));
  ok('T12-i4 SKILL_VERSION 与主脚本头注释一致',
    new RegExp(`^// token-usage-tracker v${v.replace(/\./g, '\\.')} `, 'm').test(mainSrc));
  // i5：SKILL.md「当前功能总览」标题不得内嵌硬版本号（版本以 manifest 为准——标题里的硬版本号是历史漂移源）
  const skillMd = src('SKILL.md');
  const overviewHead = (skillMd.match(/^##.*当前功能总览.*$/m) || [''])[0];
  ok('T12-i5 SKILL.md「当前功能总览」标题不内嵌版本号',
    overviewHead.indexOf('当前功能总览') >= 0 && !/^##\s*当前功能总览（\s*v\d/.test(overviewHead),
    overviewHead.slice(0, 70));
  // i6：SKILL.md 里 Read 指向的旁支文件必须真实存在（防引用了不存在的文件，模型 Read 时扑空）
  const SIDE_FILES = ['TROUBLESHOOTING.md', 'docs/balance.md', 'docs/pricing-refresh.md', 'docs/windows-notification.md'];
  const missingSide = SIDE_FILES.filter((f) => !fs.existsSync(path.join(SRC, f)));
  ok(`T12-i6 SKILL.md 指向的旁支文件全部存在（${SIDE_FILES.length} 个）`,
    missingSide.length === 0, missingSide.join(', ') || '全部存在');

  // j：端到端（spawn）—— 预置「有新版」状态跑 --hook，提示必须出现在注入里
  if (!SPAWN_OK) skip('T12-j --hook 端到端注入提示');
  else {
    put({ lastCheckAt: Date.now(), latestVersion: '9.9.9', failCount: 0, nextRetryAt: 0 });
    const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'],
      { input: HOOK_PAYLOAD, env, timeout: 30000, windowsHide: true, encoding: 'utf8' });
    const ac = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (e) { return ''; } })();
    ok('T12-j1 ★有新版时 --hook 的 additionalContext 末尾带更新提示',
      String(ac).indexOf('[技能更新]') >= 0, String(ac).slice(0, 160));
    ok('T12-j2 提示位于注入内容最后一行（不插入到用量行中间）',
      String(ac).split('\n').slice(-1)[0].indexOf('[技能更新]') === 0, JSON.stringify(String(ac).split('\n').slice(-2)));
    // 换成「已是最新」再跑一次 → 注入内容必须**不含**提示（回归：旧行为逐字节不变）
    put({ lastCheckAt: Date.now(), latestVersion: ttMod.SKILL_VERSION, notifyCount: 0 });
    const r2 = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'],
      { input: HOOK_PAYLOAD, env, timeout: 30000, windowsHide: true, encoding: 'utf8' });
    ok('T12-j3 已是最新时 --hook 注入不含任何更新提示（旧行为不变）',
      String(r2.stdout || '').indexOf('[技能更新]') < 0, String(r2.stdout).slice(0, 160));
  }
  fs.rmSync(UF, { force: true });
}

// ── T13：Python 流水线守卫（v3.23.4：抓的是"决定计费金额"的价格数据，安全 + 依赖两条红线）─────
{
  const pyFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.py'));
  const pySrc = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  const has = (f, re) => re.test(pySrc(f));
  // a：TLS —— 允许"显式开关降级"，绝不允许无条件关闭校验
  const insecure = pyFiles.filter((f) => has(f, /CERT_NONE|check_hostname\s*=\s*False/) && !has(f, /CN_PRICES_INSECURE_TLS/));
  ok('T13-a1 ★无 .py 无条件关闭 TLS 校验（关校验必须由 CN_PRICES_INSECURE_TLS 显式开启）',
    insecure.length === 0, insecure.join(', ') || '全部合规');
  const silentDowngrade = pyFiles.filter((f) => has(f, /CN_PRICES_INSECURE_TLS/) && !has(f, /\[WARN\]/));
  ok('T13-a2 降级开关必须带 [WARN] 输出（不允许静默关校验）',
    silentDowngrade.length === 0, silentDowngrade.join(', ') || '全部合规');
  // b：requests 必须是可选依赖
  const hardImport = pyFiles.filter((f) => has(f, /^import[^\n]*\brequests\b/m));
  ok('T13-b1 ★requests 不得是顶层硬 import（须包在 try/except 里，缺失时回退 urllib）',
    hardImport.length === 0, hardImport.join(', ') || '全部合规');
  const noFallback = pyFiles.filter((f) => has(f, /\brequests\b/) && !has(f, /urllib\.request/));
  ok('T13-b2 用到 requests 的脚本必须同时具备 urllib 回退实现',
    noFallback.length === 0, noFallback.join(', ') || '全部合规');
  ok('T13-b3 fetch-cn-prices.py 提供 http_get() 统一入口（有 requests 用它，没有走 urllib）',
    has('fetch-cn-prices.py', /def http_get/));
  // c：编码 —— 服务端无视 Accept-Encoding 直接回 gzip 的页面（实测腾讯云文档页），不解压 = 静默 0 模型
  ok('T13-c1 ★两个抓取脚本都能按 Content-Encoding 解压（否则拿到二进制垃圾、解析 0 模型且无报错）',
    has('fetch-cn-prices.py', /def decode_body/) && has('parse_tokenhub.py', /def decode_body/));
}

// ── T14：口径一致性守卫（v3.23.5：同一个原则在 A 脚本做对了、在 B 脚本没跟上的漂移）─────────────
{
  const srcOf = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  // 源码守卫必须先剥注释：这里的注释里会引用"改之前的写法"做说明（本轮正是因此误判一次）
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  const recalc = srcOf('recalc-day.js');
  const recalcCode = stripComments(recalc);
  const refresh = srcOf('refresh-prices.js');
  const main = srcOf('token-tracker.js');
  // a：查价入口必须统一（recalc 不得裸查字典）
  ok('T14-a1 ★recalc-day.js 查价必须走 findModel（不得裸查 pricing.models[model]）',
    /findModel\(/.test(recalcCode) && !/\(pricing\.models \|\| \{\}\)\[model\]/.test(recalcCode));
  // b：峰谷倍率缺省必须与主脚本 calcCost 同口径（deepseek 系 2 / 其余 1）
  const recalcDef = /typeof m\.peak_multiplier === 'number' \? m\.peak_multiplier : \(isDeepSeek \? 2 : 1\)/.test(recalc);
  const mainDef = /isDeepSeek \? \(typeof m\.peak_multiplier === 'number' \? m\.peak_multiplier : 2\)/.test(main);
  ok('T14-a2 ★recalc-day.js 与主脚本 calcCost 的 peak_multiplier 缺省口径一致（deepseek=2 / 其余=1）',
    recalcDef && mainDef);
  // c：US 分支必须也有 lock 保护（CN 分支早有）
  ok('T14-b1 ★refresh-prices.js 国外模型（US）分支必须检查 m.lock（CN 分支已有）',
    /else if \(m\.lock === true\)/.test(refresh) && refresh.indexOf('else if (m.lock === true)') < refresh.indexOf('// 国外模型：人民币主价'));
  // d：内外层 timeout 不得打架——自动刷新路径必须关掉内层重试
  ok('T14-c1 ★自动刷新路径传 DS_RETRIES=0（否则内层 120s 重试撞外层 60s timeout，重试永远跑不完）',
    /DS_RETRIES: '0'/.test(main));
  // e：coalesce 残留锁必须有 prune
  ok('T14-d1 coalesce 残留锁有 prune（watcher 被收割留下的死锁不得无限增长）',
    /function cleanupCoalesceLocks/.test(main) && /cleanupCoalesceLocks\(sid\)/.test(main));

  // ── 行为验证（源码守卫只能证明"写了"，这里证明"真的起作用"）─────────────────────────
  const tt2 = (() => {
    try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; }
  })();
  // a3：findModel 能命中、裸字典命中不了 —— 证明「recalc 原先会静默漏价」不是理论风险
  if (!tt2) skip('T14-a3 findModel 归一化命中（裸字典不命中）');
  else {
    const p = { models: { 'DeepSeek-V4-Flash': { input_price: 1, output_price: 2 } } };
    const bare = p.models['deepseek-v4-flash'];              // 裸字典：大小写不同 → 取不到
    const viaFn = tt2.findModel(p, 'deepseek-v4-flash', 'price');
    ok('T14-a3 ★同一模型名：裸字典取不到价、findModel 取得到（证明 recalc 原先会静默漏价）',
      bare === undefined && !!(viaFn && viaFn.m && viaFn.m.input_price === 1));
  }
  // d2：残留锁清理 —— 旧锁删除、新锁保留、当前会话锁绝不动
  if (!tt2 || typeof tt2.cleanupCoalesceLocks !== 'function') skip('T14-d2 cleanupCoalesceLocks 行为');
  else {
    const snapDir = path.join(skillDir); // SNAP_DIR = WB/skills/token-usage-tracker，隔离环境即此
    const mk = (name, ageDays) => {
      const fp = path.join(snapDir, name);
      fs.writeFileSync(fp, '{}');
      const t = Date.now() - ageDays * 24 * 3600 * 1000;
      fs.utimesSync(fp, new Date(t), new Date(t));
      return fp;
    };
    const old1 = mk('.coalesce-old1.json.lock', 30);   // 远超 7 天 → 删
    const old2 = mk('.coalesce-old2.json.lock', 10);   // 超 7 天 → 删
    const fresh = mk('.coalesce-fresh.json.lock', 0);  // 今天的 → 保留
    const cur = mk('.coalesce-cursid.json.lock', 30);  // 当前 sid → 即使过期也保留
    tt2.cleanupCoalesceLocks('cursid');
    const has = (p) => fs.existsSync(p);
    ok('T14-d2 ★残留锁清理：过期锁被删、当天锁保留、当前会话锁即使过期也保留',
      !has(old1) && !has(old2) && has(fresh) && has(cur),
      `old1=${has(old1)} old2=${has(old2)} fresh=${has(fresh)} cur=${has(cur)}`);
    for (const p of [old1, old2, fresh, cur]) { try { fs.unlinkSync(p); } catch (e) {} }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 过 / ${fail} 败${skipped ? '（有跳过项：本环境禁止 node 子进程）' : ''}`);
process.exit(fail ? 1 : 0);
