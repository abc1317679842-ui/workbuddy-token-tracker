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
  if (rebuilt) ok('T3 R4 护栏告警进 stderr（⚠价库）', String(r.stderr || '').indexOf('⚠价库') >= 0, String(r.stderr || '').slice(0, 140));
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 过 / ${fail} 败${skipped ? '（有跳过项：本环境禁止 node 子进程）' : ''}`);
process.exit(fail ? 1 : 0);
