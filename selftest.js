#!/usr/bin/env node
// selftest.js —— 离线冒烟自测（v3.18.2 起随仓库分发，第三方可复跑）
// 用法：node selftest.js
// 不依赖 WorkBuddy 环境：全部在 os.tmpdir() 隔离目录跑，TOKEN_TRACKER_NO_TOAST=1，不碰真实账本、不弹通知。
// 退出码：0=通过（可能有**环境受限**跳过项）；1=有失败项（含主模块 require/导出缺失）。
//   环境受限跳过（envSkip，需要 spawn 的端到端用例 / WB_NO_NET 前提不成立）属**环境能力**问题，
//   与代码正确性无关 → **不影响退出码**（此前误用 exit 2，在 CI 上被 GitHub Actions 当成 job 失败，
//   红的原因看起来像"测试失败"而非"环境受限"）。真回归仍然 exit 1。
//   代价：CI（SPAWN_OK=true、无 WB_NO_NET 前提缺口）上 envSkip 数应为 0，summary 会显式标注。
// 基于 require 的单元测试段始终运行 —— v3.18.4 起不再整表 SKIP。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const NODE = process.execPath;
let pass = 0, fail = 0, envSkipCount = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}
// envSkip：**环境受限**类跳过（非代码问题）——只统计，不影响退出码。reason 必须说明真实原因，
// 不再像旧 skip() 那样所有跳过都硬编码「本环境禁止 node 子进程」（require 失败也这么说 → 误导）。
function envSkip(name, reason) {
  envSkipCount++;
  console.log(`  – ${name}（跳过：${reason}）`);
}
const SPAWN_SKIP_REASON = '本环境禁止 node 子进程（SPAWN_OK=false，属环境能力限制、非代码问题；CI 上应真跑）';

// 统一注释剥离（T10/T14/T17 源码守卫与「导出一致性」检查共用这一份，不再各自维护一份实现）：
// ① 先统一行尾 \r\n → \n（Windows 上 git checkout 默认 core.autocrlf=true，残留 \r 会让行尾正则失效）；
// ② 逐行剥 `//` 到行尾（`(^|[^:])` 保证 `https://` 这类 `//` 不被误当注释起始）；
// ③ 逐行剥**同行** `/* … */`（不跨行）。
// 为什么不用跨行块注释正则 `/\*[\s\S]*?\*\//`：本项目实测踩过——注释里出现的 glob 写法（如
// `subagents/*.jsonl`、`~/WorkBuddy/*/prices/index.json`）会让 `/*` 被当成块注释开头，跨行吞掉**真实代码**。
// 局限：字符串字面量里若出现 ` // ` 仍可能被误剥（token-tracker.js 现无此写法）；这里选择"宁可多剥注释
// 也不跨行吞代码"，这是本项目两害相权后的既定取舍。
const stripComments = (s) => s.replace(/\r\n/g, '\n')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/\/\*[^*]*\*\//g, ''))
  .join('\n');

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
  if (!SPAWN_OK) { envSkip(`语法 ${f}`, SPAWN_SKIP_REASON); continue; }
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
if (!SPAWN_OK) envSkip('T1 --hook exit 0', SPAWN_SKIP_REASON);
else {
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], { input: HOOK_PAYLOAD, env, timeout: 30000, windowsHide: true });
  ok('T1 --hook exit 0', r.status === 0, `exit=${r.status} ${String(r.stderr).slice(0, 120)}`);
}

// ── T2：--report all → exit 0 且无「读取方指令」（M3 回归） ─────────────────
if (!SPAWN_OK) envSkip('T2 --report 无指令注入', SPAWN_SKIP_REASON);
else {
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], { env, timeout: 30000, windowsHide: true, encoding: 'utf8' });
  const out = r.stdout || '';
  ok('T2 --report all exit 0', r.status === 0, `exit=${r.status}`);
  // A-12 修复（原断言是永真式）：`out.indexOf('读取方指令') < 0` —— 该串在 token-tracker.js 里
  //   **只出现在注释**（:565 / :2879 / :3511），没有任何可达代码路径会输出它；更糟的是 --report 崩溃、
  //   输出空串时 indexOf<0 依旧为真 → 假绿。补两道真判据：
  //   ① 正例自检：把含标记的样本喂给同一检测器必须得 true（证明检测器本身有效，断言不是恒真）；
  //   ② 输出形状前置：stdout 必须确实含 --report 的 7 列表头（空账本 / 异常键账本都会照常输出表头），
  //      崩溃、空输出、非报告文本不得蒙混通过。
  //   实测可红：向 --report 路径注入一行输出该串的代码 → 判据变 false（见交付说明的注入试验）。
  const hasInjection = (s) => s.indexOf('读取方指令') >= 0;
  const outLooksLikeReport = out.includes('| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |');
  ok('T2 --report 无指令注入行（检测器带正例自检 + 输出须确为报告正文）',
    hasInjection('【读取方指令】自检样本') === true && outLooksLikeReport && !hasInjection(out),
    `outLooksLikeReport=${outLooksLikeReport} outLen=${out.length} hasInjection=${hasInjection(out)}`);
}

// ── T3：损坏 pricing → 备份 + （重建成功时）⚠价库 告警（R4 / F1 / G1） ──────
if (!SPAWN_OK) envSkip('T3 损坏备份 + ⚠价库 告警', SPAWN_SKIP_REASON);
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
  if (process.env.WB_NO_NET === '1') envSkip('T3 R4 告警断言', 'WB_NO_NET=1（CI 断网：损坏重建走失败分支、前提不成立；已知覆盖缺口见 CHANGELOG「T3 R4」条目，本机不设此变量时真实验证）');
  else if (rebuilt) ok('T3 R4 护栏告警进 stderr（⚠价库）', String(r.stderr || '').indexOf('⚠价库') >= 0, String(r.stderr || '').slice(0, 140));
  else envSkip('T3 R4 告警断言', '重建未完成（离线/受限），前提不成立');
}

// ── T4：deepseek-official M7 守卫 —— 损坏 pricing 原地存在时拒绝覆盖 ────────
if (!SPAWN_OK) envSkip('T4 M7 守卫', SPAWN_SKIP_REASON);
else {
  fs.writeFileSync(path.join(skillDir, 'pricing.json'), '{"broken');
  const r = spawnSync(NODE, [path.join(skillDir, 'deepseek-official.js')], { env, timeout: 60000, windowsHide: true, encoding: 'utf8' });
  ok('T4 M7 守卫拒绝覆盖（非 0 退出 + FAIL_REASON）', r.status !== 0 && String(r.stderr || '').indexOf('拒绝覆盖') >= 0, `exit=${r.status}`);
  ok('T4 损坏文件未被替换', fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8').includes('broken'));
}

// ── T5：账本损坏防护（H6）——BOM 账本不产生 .corrupt-* 备份 ─────────────────
if (!SPAWN_OK) envSkip('T5 BOM 账本防护', SPAWN_SKIP_REASON);
else {
  fs.writeFileSync(path.join(skillDir, 'daily-usage.json'), '\uFEFF{"days":{}}');
  const before = fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-')).length;
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], { env, timeout: 30000, windowsHide: true, encoding: 'utf8' });
  const after = fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-')).length;
  ok('T5 BOM 账本不再被判损坏（无新增 .corrupt-*）', after === before);
  // A-12 修复：原断言只比 .corrupt-* 文件数 —— 若 --report 在 BOM 账本上整体崩溃退出，同样不会生成
  //   .corrupt-*，测试照样"通过"（测不出真正结果）。补进程级断言：必须正常退出（status 0）、
  //   未被信号杀死、spawn 本身无 error（排除超时/被杀/起不来）。
  ok('T5 --report 在 BOM 账本下正常退出（status=0、未超时、未被信号杀死）',
    r.status === 0 && r.signal === null && !r.error,
    `status=${r.status} signal=${r.signal} error=${r.error && r.error.code}`);
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
if (!SPAWN_OK) envSkip('T7-P2 recalc-day 写盘原子性/备份', SPAWN_SKIP_REASON);
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
    // A-12 修复（mock 了被测逻辑）：原实现只替换 `fs.readFileSync` 计数 —— 若 watchReadStep 改用
    //   `fs.openSync`/`fs.createReadStream` 等通道，"reads === 0" 会**假绿**（计数器永远为 0）。
    //   这里改为**覆盖所有可能的读文件通道**（readFileSync / openSync / readSync / createReadStream），
    //   并加一条**正向对照**：文件真正变化后必须观察到读事件（证明计数器确实能非零，上一条不是恒真）。
    const origAPI = { readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync, createReadStream: fs.createReadStream };
    let reads = 0, idleReads = 0, changedReads = 0;
    try {
      const bump = () => { reads++; };
      fs.readFileSync = function (...a) { bump(); return origAPI.readFileSync.apply(this, a); };
      fs.openSync = function (...a) { bump(); return origAPI.openSync.apply(this, a); };
      fs.readSync = function (...a) { bump(); return origAPI.readSync.apply(this, a); };
      fs.createReadStream = function (...a) { bump(); return origAPI.createReadStream.apply(this, a); };
      const stFixed = fs.statSync(fp);
      for (let i = 0; i < 5; i++) ttMod.watchReadStep(st, fp, stFixed);
      idleReads = reads;
      fs.appendFileSync(fp, [mkRow(4), mkRow(5)].join('\n') + '\n');
      const afterAppend = reads; // appendFileSync 自身可能走 openSync，剔除它，只看 watchReadStep 的读
      ttMod.watchReadStep(st, fp, fs.statSync(fp));
      changedReads = reads - afterAppend;
    } finally {
      Object.assign(fs, origAPI);
    }
    const full = ttMod.parseTranscChunk(fs.readFileSync(fp, 'utf-8')).length;
    ok('T8-N2a ★文件未变的 5 轮轮询不产生任何文件读（覆盖 readFileSync/openSync/readSync/createReadStream）',
      idleReads === 0 && firstLines === 3, `idleReads=${idleReads} lines=${firstLines}`);
    ok('T8-N2a2 ★正向对照：文件变化后确实发生了读（证明计数器可非零、N2a 不是恒真假绿）',
      changedReads > 0, `changedReads=${changedReads}`);
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
    // A-12 修复（定位价值为零 + 守卫恒真）：
    // ① 原 `bad.push(f)` 只报文件名、`extra` 重复列文件名 → 改为 `文件:行`，一行指到具体位置。
    // ② 原正则 `/\^agent-[^\n]*\\\.jsonl\$\/\./g` 结尾的 `\.` 是**字面点**（不是"任意字符"），
    //    只能命中 `$/` 后紧跟 `.` 的形态（如 `$/.test(`），对 `$/g`、`$/;` 一律漏报 →
    //    实测在整个仓库 **0 命中**，这条守卫从建立起就是恒真的。真意图 = "`$/` 后面的 flags 里没有 i"，
    //    故改为**捕获 flags 组再判断**（`([a-z]*)` + `includes('i')`）：
    //    - `/…$/i`     → flags=`i`     → 合规
    //    - `/…$/gi`    → flags=`gi`    → 合规（含 i；若用 `[^i]` 会把 `gi` 误判为违规）
    //    - `/…$/.test` → flags=``      → 违规（无 i）
    //    - `/…$/g`     → flags=`g`     → 违规（无 i）
    for (const f of SYNTAX_FILES) {
      src(f).split('\n').forEach((line, i) => {
        const re = /\^agent-[^\n]*\\\.jsonl\$\/([a-z]*)/g;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (!m[1].includes('i')) bad.push(`${f}:${i + 1}`);
        }
      });
    }
    ok('T9-B7 agent-*.jsonl 正则全部带 i 标志（0 处缺；违规按 文件:行 定位）', bad.length === 0, bad.join(', '));
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
  // 剥掉注释后再做"残留引用"检查——本版在注释里保留了大量历史说明，直接对源码文本做正则会被
  // 注释误判（教训：守卫测试必须只看代码，不看注释）。用**全局共享**的行级 stripComments
  // （此前 T10/T14/T17 各有一份、行为不一，同一段代码会被"看"成不同内容）。
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
  if (!SPAWN_OK) envSkip('T11-d 既有 --report 入口逐字节不变', SPAWN_SKIP_REASON);
  else {
    const run = (...a) => spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report'].concat(a),
      { env, timeout: 30000, windowsHide: true, encoding: 'utf8' }).stdout || '';
    // A-15 修复：原先直接 `===` 逐字节比较，把**可读数字格式**也焊死（¥3.50 的小数位、150万/100.1万 的
    //   中文单位写法）——任何纯格式化改进都会被误判为 bug。改为「**归一化数字格式后再逐字节比较**」。
    //   关键：只规范化**呈现格式**（去掉小数尾零、统一数值写法），**保留数值与顺序**——否则把 150万 与 2万
    //   两列对调也会被归一化成同一个「#万」而漏检（实测踩过）。这样列顺序 / 分隔符 / 文案 / 缺列多列等
    //   结构性回归照样被抓，纯数字格式改进不再假红。
    //   （刻意不碰裸数字 `1000` 与百分比 `93.33%`——它们不属于"可读格式"，改动仍应被抓。）
    const canonNum = (n) => { const v = parseFloat(n); return Number.isFinite(v) ? String(v) : n; };
    const normNums = (s) => s
      .replace(/¥(\d+(?:\.\d+)?)/g, (_, n) => '¥' + canonNum(n))        // ¥3.50 → ¥3.5
      .replace(/(\d+(?:\.\d+)?)(万|亿)/g, (_, n, u) => canonNum(n) + u); // 150.0万 → 150万
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
    const gotAll = run('all');
    ok('T11-d1 --report all 结构逐字节不变（数字格式归一化后比较）', normNums(gotAll) === normNums(wantAll), JSON.stringify(normNums(gotAll).slice(0, 160)));
    const wantOne = ['===== 2026-01-01 =====', ...HDR,
      '| m-b | 100万 | 1000 | 0 | 0.00% | 100.1万 | ¥1.25 |',
      '| **合计** | **100万** | **1000** | **0** | **0.00%** | **100.1万** | **¥1.25** |'].join('\n') + '\n';
    const gotOne = run('2026-01-01');
    ok('T11-d2 --report <date> 结构逐字节不变（数字格式归一化后比较）', normNums(gotOne) === normNums(wantOne), JSON.stringify(normNums(gotOne).slice(0, 160)));
    const wantSum = '2026-01-02  输入 150万 / 输出 2万 / 缓存 140万 / 总 152万 tokens ｜ ¥3.50\n'
      + '2026-01-01  输入 100万 / 输出 1000 / 缓存 0 / 总 100.1万 tokens ｜ ¥1.25\n';
    const gotSum = run('summary', 'all');
    ok('T11-d3 --report summary all 结构逐字节不变（数字格式归一化后比较）', normNums(gotSum) === normNums(wantSum), JSON.stringify(normNums(gotSum).slice(0, 160)));
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
  if (!SPAWN_OK) envSkip('T12-j --hook 端到端注入提示', SPAWN_SKIP_REASON);
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
  // 源码守卫必须先剥注释：注释里会引用"改之前的写法"做说明（本轮正是因此误判一次）。
  // 用全局共享的行级 stripComments（已内含 \r\n → \n 归一化，解决 Windows CRLF 让 `//…$` 失效的问题）。
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
  // 主模块 require 失败在 CI 正常环境（SPAWN_OK=true）下必是代码回归，不再是"环境受限"→ 真 fail。
  if (!tt2) ok('T14-a3 findModel 归一化命中（裸字典不命中）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const p = { models: { 'DeepSeek-V4-Flash': { input_price: 1, output_price: 2 } } };
    const bare = p.models['deepseek-v4-flash'];              // 裸字典：大小写不同 → 取不到
    const viaFn = tt2.findModel(p, 'deepseek-v4-flash', 'price');
    ok('T14-a3 ★同一模型名：裸字典取不到价、findModel 取得到（证明 recalc 原先会静默漏价）',
      bare === undefined && !!(viaFn && viaFn.m && viaFn.m.input_price === 1));
  }
  // d2：残留锁清理 —— 旧锁删除、新锁保留、当前会话锁绝不动
  if (!tt2 || typeof tt2.cleanupCoalesceLocks !== 'function') ok('T14-d2 cleanupCoalesceLocks 行为', false, 'token-tracker.js 导出缺失或 require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
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

  // ── T15：v3.24.0 修复守卫（R8/R9 审计 13 条级联链择要）─────────────────────────
  // a：数据层 —— shipped 价库必须有 hy3（子代理默认模型，缺价 = 纯净环境金额静默 0）
  const pricingJson = JSON.parse(fs.readFileSync(path.join(SRC, 'pricing.json'), 'utf8'));
  ok('T15-a1 ★shipped pricing.json 必须收录 hy3（子代理默认模型）',
    !!(pricingJson.models && pricingJson.models.hy3 && pricingJson.models.hy3.input_price > 0));
  ok('T15-a2 ★缺价模型 toast 有「⚠未计价」标注（对齐 价⚠️/官价⚠️ 模式）',
    /⚠未计价/.test(main));
  ok('T15-a3 ★transcript 截断（行数<水位线）必须落旗标 + toast「⚠账缺」',
    main.indexOf('TRANSC_TRUNCATED_FILE') > 0 && /⚠账缺/.test(main));
  // b：错误处理 —— 瞬时读失败（EACCES/EBUSY）不得把账本改名 .corrupt
  const lduStart = main.indexOf('function loadDailyUsage');
  const lduCode = stripComments(main.slice(lduStart, main.indexOf('\nfunction ', lduStart + 10)));
  ok('T15-b1 ★loadDailyUsage 区分解析错误与读取失败（后者不动原文件）',
    /isParseError/.test(lduCode) && lduCode.indexOf('isParseError') < lduCode.indexOf('.corrupt-'));
  ok('T15-b2 ★watcher 锁 TTL 过期分支必须先探活 owner（防抢活 watcher → 双弹窗）',
    /alive0/.test(main));
  // c：口径 —— 假日空年拒绝写入；backfill 子水位不回退；recalc 不改写已有金额
  const holSrc = fs.readFileSync(path.join(SRC, 'refresh-holidays.js'), 'utf8');
  ok('T15-c1 ★refresh-holidays 空年（0 天）拒绝写入（真实世界不可能 → 判定源异常）',
    /判定为源异常/.test(holSrc) || /空年守卫/.test(holSrc));
  const bfSrc = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf8').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  ok('T15-c2 ★backfill 子水位合并 = 新旧取大（旧 no-op 表达式已删）',
    /Math\.max\(n, o\.subs\[sf\] \|\| 0\)/.test(bfSrc) && !/v\.subs\[sf\]\) \|\| n \|\| 0/.test(bfSrc));
  const rcSrc = fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf8').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  ok('T15-c3 ★recalc 峰谷占比未知时不得改写已有金额（原账>0 → 保留原额）',
    /dayTotal \+= stat\.cost; continue;/.test(rcSrc));
  // d：行为验证（直接调主脚本导出函数）
  if (!tt2) ok('T15-d 行为验证（fmtCost/hitRate/dbStaleTag）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    ok('T15-d1 ★fmtCost(NaN) → null（NaN 曾直出「¥NaN」上 toast）',
      tt2.fmtCost(NaN) === null && tt2.fmtCost(-1) === null && tt2.fmtCost(1.234) === '¥1.23');
    ok('T15-d2 ★hitRate 钳制到 [0,100]（cached>in 脏数据曾显示 ">100%"）',
      tt2.hitRate(100, 150) === 100 && tt2.hitRate(100, 30) === 30 && tt2.hitRate(0, 30) === 0);
    ok('T15-d3 ★dbStaleTag(null) → 「⚠价库」（价库没加载 = 最缺价场景，曾零告警）',
      tt2.dbStaleTag(null) === '⚠价库');
  }
}

// ===== T16：KI-5 截断恢复（水位重置 + 时间戳去重，v3.25.0）=====
{
  // ⚠必须 require tmp 副本（skillDir）而非 SRC：副本实例的模块级路径（账本/水位线）才指向 tmp。
  // v3.25.0 教训：曾用 require(SRC)——require 时 WB_ROOT 已恢复 → 实例路径指向真实技能目录，
  // 测试数据直接写进真实账本（已修复并清理）。同进程缓存命中，与其他 T 段共用实例。
  const mod16 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod16) ok('T16 KI-5 行为验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const T16 = path.join(tmp, 'projects', 'ki5');
    fs.mkdirSync(path.join(T16, 's1', 'subagents'), { recursive: true });
    const tp16 = path.join(T16, 's1.jsonl');
    const T0 = 1727827200000; // 真实量级 epoch ms（防行数/时间戳量纲混淆回归）
    let seq16 = 0;
    const mkRow16 = (ts, input, output) => {
      const i = seq16++;
      return JSON.stringify({ type: 'assistant', id: 'm' + i, timestamp: ts,
        providerData: { model: 'ki5-model', messageId: 'mid-' + i, usage: { input_tokens: input, output_tokens: output } } });
    };
    const wmFile16 = path.join(tmp, 'skills', 'token-usage-tracker', '.ledger-watermark.json');
    const dailyFile16 = path.join(tmp, 'skills', 'token-usage-tracker', 'daily-usage.json');
    const readLedgerIn16 = () => {
      try {
        const d = JSON.parse(fs.readFileSync(dailyFile16, 'utf-8'));
        for (const day of Object.values(d)) {
          const m = day && day.models && day.models['ki5-model'];
          if (m) return m.in || 0;
        }
      } catch (e) {}
      return 0;
    };
    const readWm16 = () => JSON.parse(fs.readFileSync(wmFile16, 'utf-8'));
    // a1：压缩恢复只计新账（重复计会是 600）
    fs.writeFileSync(wmFile16, JSON.stringify({ s1: { main: 8, subs: {}, lastTs: T0 + 70000 } }));
    fs.writeFileSync(tp16, [0,1,2,3,4,5,6,7,8,9].map((i) => mkRow16(T0 + i * 10000, 100, 10)).slice(4).join('\n') + '\n');
    mod16.incrementalRecord(tp16, 's1');
    ok('T16-a1 ★transcript 压缩截断 → 水位重置+时间戳去重恢复记账（只计新行，不重复计已记账行）',
      readLedgerIn16() === 200 && readWm16().s1.main === 6 && readWm16().s1.lastTs === T0 + 90000);
    // a2：无 lastTs 的旧水位线 → 冻结不重记（无过滤重置 = 无条件重复计费）
    fs.writeFileSync(path.join(T16, 's2.jsonl'), [0,1,2].map((i) => mkRow16(T0 + i * 10000, 30, 3)).join('\n') + '\n');
    fs.writeFileSync(wmFile16, JSON.stringify({ s2: { main: 5, subs: {} } }));
    const beforeA2 = readLedgerIn16();
    mod16.incrementalRecord(path.join(T16, 's2.jsonl'), 's2');
    ok('T16-a2 ★旧水位线（无 lastTs 判据）→ 宁可保持冻结也不无过滤重置（防重复计费）',
      readLedgerIn16() === beforeA2 && readWm16().s2.main === 5);
    // b1：子代理对称恢复（判据 = 各文件独立的 subTs[f]，不是主文件 lastTs）
    fs.writeFileSync(wmFile16, JSON.stringify({ s1: { main: 6, subs: { 'agent-a.jsonl': 4 }, lastTs: T0 + 90000, subTs: { 'agent-a.jsonl': T0 + 30000 } } }));
    const beforeB1 = readLedgerIn16();
    seq16 = 100;
    fs.writeFileSync(path.join(T16, 's1', 'subagents', 'agent-a.jsonl'),
      [0,1,2,3,4].map((i) => mkRow16(T0 + i * 10000, 40, 4)).slice(2).join('\n') + '\n');
    mod16.incrementalRecord(tp16, 's1');
    ok('T16-b1 ★子代理 transcript 压缩截断 → 按 subTs[f] 对称恢复（各文件独立判据）',
      readLedgerIn16() === beforeB1 + 40 && readWm16().s1.subs['agent-a.jsonl'] === 3);
    // c1：truncated 标志（正常路径无此字段，旧调用方零影响）
    const rT16 = mod16.readTranscLinesFrom(path.join(T16, 's2.jsonl'), 5);
    const rN16 = mod16.readTranscLinesFrom(path.join(T16, 's2.jsonl'), 0);
    ok('T16-c1 ★readTranscLinesFrom 截断分支显式返回 truncated:true（正常路径无此字段）',
      rT16.truncated === true && rT16.totalLines === 5 && rN16.truncated === undefined);
    // c2：backfill 水位线合并保真 lastTs/subTs（丢弃 = --write 后截断恢复退化为冻结）
    const bf16 = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf8').replace(/\r\n/g, '\n');
    ok('T16-c2 ★backfill 水位线合并保真 lastTs/subTs（判据字段不得在合并时丢失）',
      /lastTs: Math\.max\(o\.lastTs \|\| 0, v\.lastTs \|\| 0\)/.test(bf16) && /subTs: Object\.assign\(\{\}, o\.subTs \|\| \{\}/.test(bf16));
  }
}

// ===== T17：KI-6 弹窗层三件套（⑧分模型计价 / ⑨补弹链路死亡检测，v3.26.0）=====
{
  // ⑧ 行为测试（require skillDir 副本实例——模块级路径由 require 时的 WB_ROOT 决定，见 T16 教训）
  const mod17 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod17) ok('T17 KI-6 行为验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const T17 = path.join(tmp, 'projects', 'ki6');
    fs.mkdirSync(path.join(T17, 's1', 'subagents'), { recursive: true });
    const tp17 = path.join(T17, 's1.jsonl');
    const T0 = 1727827200000;
    let seq17 = 0;
    const mkRow17 = (ts, model, input, output) => {
      const i = seq17++;
      return JSON.stringify({ type: 'assistant', id: 'm' + i, timestamp: ts,
        providerData: { model, messageId: 'mid-' + i, usage: { input_tokens: input, output_tokens: output } } });
    };
    fs.writeFileSync(tp17, [mkRow17(T0 + 1000, 'glm-5.3-flash', 100, 10), mkRow17(T0 + 2000, 'expensive-m', 200, 20)].join('\n') + '\n');
    fs.writeFileSync(path.join(T17, 's1', 'subagents', 'agent-a.jsonl'), mkRow17(T0 + 3000, 'hy3', 400, 40) + '\n');
    const agg17 = mod17.aggregateTranscript(tp17, 0);
    ok('T17-a1 ★混合轮产出分模型明细（主2模型+子代理1模型，与总量同 seen 去重）',
      agg17 && agg17.models && Object.keys(agg17.models).length === 3
      && agg17.models['glm-5.3-flash'].in === 100 && agg17.models['expensive-m'].in === 200 && agg17.models['hy3'].in === 400);
    ok('T17-a2 每模型 bucket 含 lastTs（峰谷判定依据）', agg17.models['hy3'].lastTs === T0 + 3000);
    // 分模型计价：expensive 段按 expensive 价折算（旧口径 = 全部按主导模型价 → 0.10）
    const pricing17 = { models: {
      'glm-5.3-flash': { name: 'glm-5.3-flash', input_price: 1, output_price: 4, cached_price: 0.25, region: 'CN' },
      'hy3': { name: 'hy3', input_price: 1, output_price: 4, cached_price: 0.25, region: 'CN' },
      'expensive-m': { name: 'expensive-m', input_price: 100, output_price: 400, region: 'CN' },
    } };
    const l2a = mod17.toastLine2(agg17, pricing17);
    const expectA = (200 / 1e6 * 100 + 20 / 1e6 * 400) + (100 / 1e6 * 1 + 10 / 1e6 * 4) + (400 / 1e6 * 1 + 40 / 1e6 * 4);
    const gotA = l2a.match(/¥([\d.]+)/) ? parseFloat(l2a.match(/¥([\d.]+)/)[1]) : null;
    ok('T17-a3 ★弹窗金额 = 分模型计价求和（与账本同口径；旧口径会按单一主导价失真）',
      gotA != null && Math.abs(gotA - expectA) < 0.011, `got=${gotA} expect≈${expectA.toFixed(3)}`);
    // 部分模型无价 → ⚠未计价（金额是部分和，必须明示缺口）
    const aggP = { in: 300, out: 30, cached: 0, model: 'expensive-m',
      models: { 'glm-5.3-flash': { in: 100, out: 10, cached: 0, total: 110, lastTs: T0 }, 'no-price-m': { in: 200, out: 20, cached: 0, total: 220, lastTs: T0 } } };
    ok('T17-a4 ★部分模型无价 → ⚠未计价标注（不再静默）', mod17.toastLine2(aggP, pricing17).indexOf('⚠未计价') >= 0);
    // 旧形状（无 models，如 coalesce 残留 agg）→ 回退旧口径，不崩、有金额、无误标
    const aggOld = { in: 300, out: 30, cached: 0, model: 'expensive-m' };
    const l2old = mod17.toastLine2(aggOld, pricing17);
    ok('T17-a5 旧形状回退旧口径（不崩、有金额、无 ⚠未计价）', /¥[\d.]+/.test(l2old) && l2old.indexOf('⚠未计价') < 0);
    // 本地/云端混合 → 本地段免费、金额 = 云端段；纯本地 → 「本地·免费」
    const aggMix = { in: 300, out: 30, cached: 0, model: 'custom-local:qwen3.5-9b',
      models: { 'custom-local:qwen3.5-9b': { in: 100, out: 10, cached: 0, total: 110, lastTs: T0 }, 'glm-5.3-flash': { in: 200, out: 20, cached: 0, total: 220, lastTs: T0 } } };
    const l2mix = mod17.toastLine2(aggMix, pricing17);
    const expMix = 200 / 1e6 * 1 + 20 / 1e6 * 4;
    const gotMix = l2mix.match(/¥<?([\d.]+)/) ? parseFloat(l2mix.match(/¥<?([\d.]+)/)[1]) : null;
    ok('T17-a6 本地+云混合 → 金额=云端段（本地段免费跳过）', gotMix != null && Math.abs(gotMix - expMix) < 0.011, `got=${gotMix}`);
    const aggLocal = { in: 300, out: 30, cached: 0, model: 'custom-local:qwen3.5-9b',
      models: { 'custom-local:qwen3.5-9b': { in: 300, out: 30, cached: 0, total: 330, lastTs: T0 } } };
    const l2loc = mod17.toastLine2(aggLocal, pricing17);
    ok('T17-a7 纯本地 → 「本地·免费」', l2loc.indexOf('本地·免费') >= 0 && l2loc.indexOf('¥') < 0);
    // ★正常路径零变化守卫：单模型轮分模型计价 == 旧口径 calcCost(stat)
    const tp1m = path.join(T17, 's2.jsonl');
    fs.writeFileSync(tp1m, [mkRow17(T0 + 1000, 'glm-5.3-flash', 300, 30), mkRow17(T0 + 2000, 'glm-5.3-flash', 50, 5)].join('\n') + '\n');
    const agg1m = mod17.aggregateTranscript(tp1m, 0);
    const got1m = parseFloat(mod17.toastLine2(agg1m, pricing17).match(/¥<?([\d.]+)/)[1]);
    const ref1m = mod17.calcCost(agg1m, pricing17);
    ok('T17-a8 ★单模型轮金额与旧口径逐位一致（正常路径零变化）',
      got1m != null && ref1m != null && Math.abs(got1m - ref1m) < 0.011, `got=${got1m} ref=${ref1m}`);
    // a9：估算段并入分模型明细（3 处弹窗合并点共用 helper；漏并 = 弹窗金额漏估算段、与账本口径分裂）
    const aggE = { in: 100, out: 10, cached: 0, total: 110, model: 'glm-5.3-flash',
      models: { 'glm-5.3-flash': { in: 100, out: 10, cached: 0, total: 110, lastTs: T0 } } };
    mod17.mergeEstIntoModels(aggE, { 'expensive-m': { in: 200, out: 20, cached: 0, total: 220 } });
    const gotE = parseFloat(mod17.toastLine2(aggE, pricing17).match(/¥([\d.]+)/)[1]);
    const expE = (100 / 1e6 * 1 + 10 / 1e6 * 4) + (200 / 1e6 * 100 + 20 / 1e6 * 400);
    ok('T17-a9 ★被中断估算并入分模型明细（弹窗金额含估算段，与账本同口径）',
      aggE.models['expensive-m'] && aggE.models['expensive-m'].in === 200 && gotE != null && Math.abs(gotE - expE) < 0.011,
      `got=${gotE} expect≈${expE.toFixed(3)}`);
    // a10：无 models 字段的旧聚合 → helper 自动建桶（不崩）
    const aggE2 = { in: 5, out: 1, cached: 0, total: 6, model: 'x' };
    mod17.mergeEstIntoModels(aggE2, { x: { in: 5, out: 1, cached: 0, total: 6 } });
    ok('T17-a10 旧形状聚合并入估算不崩（自动建 models 桶）', aggE2.models && aggE2.models.x && aggE2.models.x.in === 5);
  }
  // ⑨ 源码守卫（**行级剥注释**——注释里的 `/*.jsonl` glob 会被朴素块注释剥离误当 `/*` 开头、
  // 跨行吞掉真实代码（本版实测吞掉 1 处调用 → 守卫假红），故不跨行匹配）。
  // 用全局共享的 stripComments（同一份实现，T10/T14/T17 不再各写各的）。
  {
    const src17 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
    ok('T17-b1 ★⑨结算分支推进的 stopAtH 必须存活到最终快照写入（L5543 整文件覆盖曾把它打回旧值）',
      /stopAtH = nowH;/.test(src17) && /lastStopAt: stopAtH/.test(src17));
    ok('T17-b2 ★旧缺陷写法不得回归（lastStopAt: psnap2.lastStopAt || 0）',
      !/lastStopAt: psnap2\.lastStopAt \|\| 0/.test(src17));
    ok('T17-b3 死亡检测阈值 env 可调（WB_TEAM_SPLIT_STALE_MS）', /WB_TEAM_SPLIT_STALE_MS/.test(src17));
    ok('T17-b4 ★估算并入分模型明细：helper 定义 + 3 个弹窗合并点全部调用（漏一处 = 该路径弹窗金额漏估算段）',
      (src17.match(/mergeEstIntoModels\(/g) || []).length >= 4);
  }
  // ⑨ 端到端（spawn）：残留 coalesce 超时 + 子代理静止 → 结算推进双时间戳。沙箱 SPAWN_OK=false 时跳过，CI 真跑。
  if (!SPAWN_OK) envSkip('T17-c1 ⑨端到端（需要 node 子进程）', SPAWN_SKIP_REASON);
  else {
    const SID17 = 't17e2e';
    const proj17 = path.join(tmp, 'projects', 'ki6e2e');
    const tpE = path.join(proj17, SID17 + '.jsonl');
    fs.mkdirSync(proj17, { recursive: true });
    fs.writeFileSync(tpE, JSON.stringify({ type: 'user', timestamp: Date.now() - 30 * 60000, message: { role: 'user', content: 'hi' } }) + '\n');
    fs.writeFileSync(path.join(skillDir, '.snapshot-' + SID17 + '.json'),
      JSON.stringify({ file: tpE, stat: null, lastUserMsgAt: Date.now() - 30 * 60000, lastStopAt: 0 }));
    fs.writeFileSync(path.join(skillDir, '.coalesce-' + SID17 + '.json'), JSON.stringify({ at: Date.now() - 11 * 60000 }));
    fs.mkdirSync(path.join(tmp, 'traces', SID17), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'traces', SID17, 'trace_x.json'),
      JSON.stringify({ trace: { sessionId: SID17, totalTokens: 50, modelInfo: { totalInputTokens: 30, totalOutputTokens: 20 } } }));
    const payloadE = JSON.stringify({ session_id: SID17, transcript_path: tpE, cwd: proj17 });
    const r17 = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'],
      { input: payloadE, env: Object.assign({}, env, { ENABLE_UPDATE_CHECK: '0' }), timeout: 30000, windowsHide: true, encoding: 'utf8' });
    const snapE = (() => { try { return JSON.parse(fs.readFileSync(path.join(skillDir, '.snapshot-' + SID17 + '.json'), 'utf-8')); } catch (e) { return null; } })();
    const coalGone = !fs.existsSync(path.join(skillDir, '.coalesce-' + SID17 + '.json'));
    const T1E = Date.now() - 30 * 60000;
    ok('T17-c1 ★⑨端到端：残留 coalesce 超时 → 结算（coalesce 清除 + lastUserMsgAt/lastStopAt 双推进）',
      r17.status === 0 && coalGone && snapE && snapE.lastUserMsgAt > T1E && snapE.lastStopAt > T1E
      && Math.abs(snapE.lastStopAt - snapE.lastUserMsgAt) < 5000,
      `exit=${r17.status} coalGone=${coalGone} snap=${snapE ? JSON.stringify({ u: snapE.lastUserMsgAt, s: snapE.lastStopAt }) : 'null'}`);
    ok('T17-c2 ⑨端到端：stderr 有结算告警', (r17.stderr || '').indexOf('补弹链路已死亡') >= 0);
    try { fs.unlinkSync(path.join(skillDir, '.snapshot-' + SID17 + '.json')); } catch (e) {}
  }
}

// ===== T18：无公开价模型（v3.27.0）——匿名/订阅制模型厂商不公布按 token 单价 =====
// 病根：两个查价源对这类模型都标价 $0，旧代码把 0 当合法价写进 pricing.json →
//   弹窗显示 ¥<0.01（读起来像"几乎免费"）、账本 cost:0 与"真免费"不可区分、当日合计被系统性低估且零提示。
{
  const mod18 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod18) ok('T18 无公开价行为验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const UNPUB = { name: 'unpub-m', input_price: 0, cached_price: null, output_price: 0, region: 'US', pricing_status: 'unpublished' };
    const PAID = { name: 'paid-m', input_price: 1, cached_price: 0.25, output_price: 4, region: 'CN' };
    const pUnpub = { models: { 'unpub-m': UNPUB } };
    const pMix = { models: { 'unpub-m': UNPUB, 'paid-m': PAID } };
    const pFree = { models: { 'free-m': { name: 'free-m', input_price: 0, output_price: 0, region: 'CN' } } };
    const pPaid = { models: { 'paid-m': PAID } };
    const statU = { in: 500000, out: 10000, cached: 400000, model: 'unpub-m',
      models: { 'unpub-m': { in: 500000, out: 10000, cached: 400000, total: 510000, lastTs: 1727827200000 } } };
    const statM = { in: 1000000, out: 50000, cached: 900000, model: 'paid-m',
      models: { 'paid-m': { in: 1000000, out: 50000, cached: 900000, total: 1050000, lastTs: 1727827200000 },
                'unpub-m': { in: 500000, out: 10000, cached: 400000, total: 510000, lastTs: 1727827200000 } } };
    const lU = mod18.toastLine2(statU, pUnpub);
    // v3.27.0（用户 2026-10-02 定版布局）：⚠无公开价 在**行1**、行2 **完全不显示金额**
    ok('T18-a1 ★纯无公开价轮：行2 不显示任何金额（不是 ¥0、也不是「无公开价」字样）',
      lU.indexOf('¥') < 0 && lU.indexOf('无公开价') < 0, lU);
    ok('T18-a2 ★纯无公开价轮：行2 保留缓存百分比且无孤悬分隔符「｜」结尾',
      lU.indexOf('缓存80.00%') >= 0 && !/｜\$/.test(lU) && lU.indexOf('｜｜') < 0, lU);
    const lM = mod18.toastLine2(statM, pMix);
    ok('T18-a3 ★混合轮（有价 + 无公开价）：行2 **已知金额照常显示**（不抹掉已知部分）',
      /¥[\d.]+/.test(lM), lM);
    const lF = mod18.toastLine2({ in: 1000000, out: 50000, cached: 900000, model: 'free-m' }, pFree);
    ok('T18-a4 ★真 0 元（免费）保持旧显示 ¥<0.01、不误标无公开价（不制造新噪声）',
      /¥/.test(lF) && lF.indexOf('无公开价') < 0, lF);
    // 行1 标记：位置、宽度、以及超宽时的降级
    const tagU = mod18.noPriceTag1(statU, pUnpub);
    ok('T18-a5 ★⚠无公开价 标记落在**行1**（toastLine1 第 6 参），格式为「｜⚠无公开价」', tagU === '｜⚠无公开价', 'got=' + tagU);
    const full1 = mod18.toastLine1(statU, 'space-bunny', '', '', '', tagU);
    const l1Only = full1.split('\n')[0];
    ok('T18-a6 ★行1 输出含标记且不超宽（≤45u）',
      l1Only.indexOf('⚠无公开价') >= 0 && mod18.dispWidthTitle(l1Only) <= 45,
      `w=${mod18.dispWidthTitle(l1Only)} line1=${l1Only}`);
    const LONGA = 'a-very-very-long-model-name-that-overflows-row1-limit';
    const shrink1 = mod18.toastLine1(statU, LONGA, '（高峰）', '', '', mod18.noPriceTag1(statU, pUnpub)).split('\n')[0];
    ok('T18-a7 ★超长模型名：缩名保标注（两标注都在、不超宽）',
      shrink1.indexOf('⚠无公开价') >= 0 && shrink1.indexOf('高峰') >= 0 && mod18.dispWidthTitle(shrink1) <= 45,
      `w=${mod18.dispWidthTitle(shrink1)} line1=${shrink1}`);
    const drop1 = mod18.toastLine1(statU, LONGA, '（高峰 ×2 时段很长）', '', '', mod18.noPriceTag1(statU, pUnpub)).split('\n')[0];
    ok('T18-a8 ★标注预算不足时丢标注保模型名（不超宽、数据不丢）',
      mod18.dispWidthTitle(drop1) <= 45 && drop1.indexOf('⚠无公开价') < 0, `w=${mod18.dispWidthTitle(drop1)} line1=${drop1}`);
    ok('T18-a9 ★无标注轮行1 逐字节不变（超长名 + 高峰，回归旧行为）',
      mod18.toastLine1(statU, LONGA, '（高峰）', '', '', '').split('\n')[0] === 'a-very-very-long…flows-row1-limit （高峰）',
      mod18.toastLine1(statU, LONGA, '（高峰）', '', '', '').split('\n')[0]);
    // 行1/行2 判定口径必须同源（分裂会出「行1没标、金额也没显示」的诡异组合）
    ok('T18-a10 ★行1 标记与行2 省略共用 anyNoPublicPrice 同一判定（口径不得分裂）',
      mod18.anyNoPublicPrice(statU, pUnpub) === true && mod18.anyNoPublicPrice(statM, pMix) === true
      && mod18.anyNoPublicPrice(statM, pPaid) === false && mod18.anyNoPublicPrice({ in: 1, out: 1, model: 'free-m' }, pFree) === false);
    // 账本层：formatUsageRow 对 no_price 显示「无公开价」；普通条目逐字节不变
    const rowU = mod18.formatUsageRow({ label: 'unpub-m', in: 500000, out: 10000, cached: 400000, total: 510000, cost: 0, hit: 80, no_price: true }, false);
    ok('T18-b1 ★账本行 no_price → 金额列「无公开价」而非 ¥0.00', rowU.indexOf('无公开价') >= 0 && rowU.indexOf('¥0.00') < 0, rowU);
    const rowN = mod18.formatUsageRow({ label: 'paid-m', in: 100, out: 10, cached: 50, total: 110, cost: 1.23, hit: 50 }, false);
    ok('T18-b2 无 no_price 的行输出逐字节不变（正常路径零变化）', rowN === '| paid-m | 100 | 10 | 50 | 50.00% | 110 | ¥1.23 |', rowN);
    // 区间聚合透传 no_price（同一份数据两个入口不得显示不同）
    const aggD = { '2026-10-01': { models: { 'unpub-m': { in: 500000, out: 10000, cached: 400000, total: 510000, cost: 0, hit: 80, no_price: true } },
      total: { in: 500000, out: 10000, cached: 400000, total: 510000, cost: 0, hit: 80 } } };
    const aggR = mod18.aggregateRangeModels(aggD, '2026-10-01', '2026-10-01');
    ok('T18-b3 区间聚合透传 no_price（单日表标了、区间表也必须标）', aggR.models['unpub-m'] && aggR.models['unpub-m'].no_price === true);
  }
  // 源码守卫：查价源必须拒 0 价（否则下次自动补录又会写回误导条目）
  {
    const code = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
    const main18 = code('token-tracker.js');
    const back18 = code('backfill.js');
    const recalc18 = code('recalc-day.js');
    ok('T18-c1 ★两个查价源都把「输入输出同为 0」判为未公布单价（NO_PUBLIC_PRICE），不再当合法价',
      (main18.match(/NO_PUBLIC_PRICE/g) || []).length >= 4, 'occurrences=' + (main18.match(/NO_PUBLIC_PRICE/g) || []).length);
    ok('T18-c2 ★哨兵值与 null/undefined 三态严格区分（查不到 vs 查失败 vs 无公开价）',
      /const NO_PUBLIC_PRICE = Symbol/.test(main18) && /if \(ref === NO_PUBLIC_PRICE\)/.test(main18) && /if \(cnRef === NO_PUBLIC_PRICE\)/.test(main18));
    ok('T18-c3 ★backfill 重建账本时同样留痕 no_price（漏则 --write 会把标记洗掉）',
      /isNoPublicPrice\(name\)/.test(back18) && /m\.no_price = true/.test(back18));
    ok('T18-c4 ★recalc 回算后清除 no_price 标记（金额已真实，不能仍显示"无公开价"）',
      /delete stat\.no_price/.test(recalc18) && /cost > 0/.test(recalc18));
    // T18-c5（v3.28.0）：toastLine2 曾把「⚠未计价」追加块**逐字复制两遍**（条件相同、都 `line += '｜⚠未计价'`）
    //   → 弹窗实测出现 `｜⚠未计价｜⚠未计价`。这里锁住"标签追加块"的数量不变量，专防复制粘贴：
    //   ① `line += '｜…'`（追加一个标签段）在全函数体内**恰好 5 处**（价⚠️/官价⚠️/⚠价核验/⚠未计价/⚠账缺）；
    //   ② `line += '｜⚠未计价'` **恰好 1 次**（这处正是被复制过的那个块）。
    //   若有人再粘贴一遍任何标签块，①或②必然超标 → 立刻红。（后续新增正当标签时需同步更新此计数，
    //   这正是"新标签必须被显式意识到"的预期摩擦，不是误报。）
    const tl2Start = main18.indexOf('function toastLine2');
    const tl2End = main18.indexOf('\nfunction ', tl2Start + 10);
    const tl2Body = stripComments(main18.slice(tl2Start, tl2End));
    const tagAppendCount = (tl2Body.match(/line \+= '｜/g) || []).length;
    const unpaidAppendCount = (tl2Body.match(/line \+= '｜⚠未计价'/g) || []).length;
    ok('T18-c5 ★toastLine2 标签追加块无重复（line += \'｜…\' 恰好 5 处、⚠未计价 恰好追加 1 次）',
      tl2Start > 0 && tl2End > tl2Start && tagAppendCount === 5 && unpaidAppendCount === 1,
      `tagAppend=${tagAppendCount} unpaidAppend=${unpaidAppendCount}`);
  }
}

// ===== T19：弹窗行2 真因修正（v3.30.0）—— 价核验误报 / 缓存被顶掉 / emoji 估宽 =====
// 起因：用户 2026-10-02 发弹窗截图三问（有价格还报价核验 / 缓存百分比被顶掉 / 有的有标签有的没有）。
// 定位：把截图与 ~/.workbuddy/token-tracker-toast.log 的 toastText 逐条对账 —— 5 条**全部**含「｜⚠价核验」，
//   但 3 条在气泡里被横向裁掉 → 第三问不是代码分支，是渲染层裁切（详见 CHANGELOG v3.30.0）。
// 本段把三条修法的**行为判据**钉死，防回归。
{
  const mod19 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod19) ok('T19 弹窗行2 修正验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    // 隔离：⚠账缺 旗标（TRANSC_TRUNCATED_FILE）会被本段之前的用例写出来，而它的优先级最高、**绝不丢**
    //   → 会稳定吃掉行2 的 12u 预算，把本段要验的标签/缓存挤掉（首轮 T19 就是因此 4 条误红）。
    //   断言期间临时移走、结束后原样恢复，把被测因素隔离出来。
    const tfPath19 = mod19.TRANSC_TRUNCATED_FILE;
    let tfSaved19 = null;
    try { tfSaved19 = fs.readFileSync(tfPath19, 'utf-8'); fs.unlinkSync(tfPath19); } catch (e) { tfSaved19 = null; }
    try {
    const M19 = 'deepseek-v4.1-flash';
    const PAID19 = { name: 'paid-m', input_price: 1, cached_price: 0.25, output_price: 4, region: 'CN' };
    const P19 = (extra) => Object.assign({ models: { [M19]: PAID19 } }, extra || {});
    // 短行（base ≈ 40u）：标签才有机会存活 —— 用来验证"该挂的时候挂得上"
    const short19 = { model: M19, in: 1000000, out: 10000, cached: 0 };
    const l2of = (s, p) => mod19.toastLine2(s, p);

    // ── a. 价核验触发源收窄（用户疑问①：停用历史流水账 + 必须点名本轮模型）──
    const pNote19 = P19({ last_refresh_note: '2026-10-01T17:53:35.143Z 多源刷新：⚠️模糊匹配歧义: kimi-k3: ...' });
    ok('T19-a1 ★历史 last_refresh_note 含 ⚠ 不再挂「⚠价核验」（A-8 的永久误报根因）',
      l2of(short19, pNote19).indexOf('价核验') < 0, l2of(short19, pNote19));
    const pOther19 = P19({ _ambig_warnings: ['kimi-k3: USD源 模糊命中 2 个不同价候选，已放弃', 'glm-5.3-flash: USD源 模糊命中 3 个'] });
    ok('T19-a2 ★与本轮模型**无关**的歧义不挂标签（别的模型的问题不得污染每一条弹窗）',
      l2of(short19, pOther19).indexOf('价核验') < 0, l2of(short19, pOther19));
    const pMine19 = P19({ _ambig_warnings: ['kimi-k3: xx', M19 + ': USD源 模糊命中 2 个不同价候选，已放弃'] });
    ok('T19-a3 ★点名本轮模型的歧义 → 照常挂标签（收窄不等于失效）',
      l2of(short19, pMine19).indexOf('⚠价核验') >= 0, l2of(short19, pMine19));
    const pAudit19 = P19({ _price_audit: { at: 'x', warnings: [M19 + ': 人民币价 1 vs usd×7.2=0.5 偏差 50%'] } });
    ok('T19-a4 ★_price_audit 点名本轮模型 → 挂标签', l2of(short19, pAudit19).indexOf('⚠价核验') >= 0, l2of(short19, pAudit19));
    const pAuditOther19 = P19({ _price_audit: { at: 'x', warnings: ['other-m: 偏差 50%'] } });
    ok('T19-a5 ★_price_audit 与本轮无关 → 不挂', l2of(short19, pAuditOther19).indexOf('价核验') < 0, l2of(short19, pAuditOther19));
    const pHy19 = { models: { hy3: PAID19 }, _ambig_warnings: ['hy3-preview: USD源歧义'] };
    ok('T19-a6 ★显示名与价库键不一致也能命中（hy3 ↔ hy3-preview 宽松匹配）',
      l2of({ model: 'hy3', in: 1000000, out: 10000, cached: 0 }, pHy19).indexOf('⚠价核验') >= 0);

    // ── b. 行2 宽度守卫优先级（用户疑问②：缓存百分比优先于降级标签）──
    const long19 = { model: M19, in: 2163000, out: 20000, cached: Math.round(2163000 * 0.9557) };
    const lLong19 = l2of(long19, pMine19);
    ok('T19-b1 ★长行时「缓存百分比」不被「⚠价核验」顶掉（v3.27.0 用户定版优先级）',
      lLong19.indexOf('缓存95.57%') >= 0 && lLong19.indexOf('价核验') < 0, lLong19);
    ok('T19-b2 ★长行结果宽度 ≤ 上限', mod19.dispWidth(lLong19) <= 51, 'w=' + mod19.dispWidth(lLong19));
    const huge19 = { model: M19, in: 199800000, out: 11100000, cached: 190000000 };
    const lHuge19 = l2of(huge19, P19());
    ok('T19-b3 ★超长行不留孤悬「｜」结尾 / 不出现「｜｜」',
      !/｜$/.test(lHuge19) && lHuge19.indexOf('｜｜') < 0, lHuge19);
    ok('T19-b4 ★超长行宽度仍 ≤ 上限', mod19.dispWidth(lHuge19) <= 51, 'w=' + mod19.dispWidth(lHuge19));

    // ── c. 显示宽度模型（用户疑问③：⚠ 按 emoji 呈现，实际 ≈ 2 个汉字）──
    ok('T19-c1 ★dispWidth(⚠) === 4（emoji 呈现宽；旧模型按 2 计 → 每个 ⚠ 低估 2u）',
      mod19.dispWidth('⚠') === 4, 'w=' + mod19.dispWidth('⚠'));
    ok('T19-c2 dispWidth(⚠️) === 4（变体选择符 U+FE0F 零宽）', mod19.dispWidth('⚠️') === 4, 'w=' + mod19.dispWidth('⚠️'));
    ok('T19-c3 常规汉字/ASCII 宽度未变（输入 ab = 7u）', mod19.dispWidth('输入 ab') === 7, 'w=' + mod19.dispWidth('输入 ab'));
    ok('T19-c4 纯 ASCII 行宽度未变（输入 127万 / 输出 9002 = 22u）',
      mod19.dispWidth('输入 127万 / 输出 9002') === 22, 'w=' + mod19.dispWidth('输入 127万 / 输出 9002'));
    // 回归守卫：emoji 区间必须以 `u` 标志 + \u{...} 书写。不加 `u` 时 `\u1F000` 会被拆成 `\u1F00`+`0`，
    // 与 `-` 拼成 `0-\u1FAF` → **吃掉整个 ASCII 区**，行宽被算成 2 倍（本次开发中真实踩到）。
    ok('T19-c5 ★emoji 区间不吞 ASCII（回归：畸形区间曾把行宽算成 2 倍）',
      mod19.dispWidth('abcXYZ0189') === 10, 'w=' + mod19.dispWidth('abcXYZ0189'));

    // ── d/e. 既有不变量：⚠未计价 绝不丢；空 stat 不崩 ──
    const lUnpaid19 = l2of({ model: 'nope-m', in: 1000000, out: 50000, cached: 900000 }, { models: {} });
    ok('T19-d1 ★「⚠未计价」不被宽度守卫丢弃（数据不可信信号优先级最高）',
      lUnpaid19.indexOf('⚠未计价') >= 0, lUnpaid19);
    let noCrash19 = true;
    try { l2of(null, P19({ _ambig_warnings: [M19 + ': x'] })); } catch (e) { noCrash19 = false; }
    ok('T19-e1 stat=null 不抛异常（函数内半防御风格的兜底归一）', noCrash19);

    // ── f. 源码守卫：priceAuditTag 体内**不得**再出现 last_refresh_note（防"流水账当状态"重演）──
    const main19 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
    const paStart = main19.indexOf('function priceAuditTag');
    const paEnd = main19.indexOf('\nfunction ', paStart + 10);
    const paBody = paEnd > paStart ? stripComments(main19.slice(paStart, paEnd)) : '';
    ok('T19-f1 ★priceAuditTag 不再消费 last_refresh_note（流水账 ≠ 当前健康状态，永久条目 = 永久噪音）',
      paStart > 0 && paBody.length > 0 && paBody.indexOf('last_refresh_note') < 0
      && paBody.indexOf('_ambig_warnings') >= 0 && paBody.indexOf('_price_audit') >= 0);
    } finally {
      // 原样恢复被临时移走的 ⚠账缺 旗标
      if (tfSaved19 !== null) { try { fs.writeFileSync(tfPath19, tfSaved19); } catch (e) { /* 恢复失败不影响被测逻辑 */ } }
    }
  }
}

// ===== 导出一致性（A-16）：自动推导，替代"手工清单"的兜底 =====
// 病根：selftest 里"新增导出必须存在"是**三张手工清单**（T8-N1g/N2 的 typeof 检查、T11-a 的 `exported`、
//   T12-a 的 `ex12`），全靠人记得往里加。`cleanupCoalesceLocks` 三张都不含 → 一旦它"定义还在、导出没了"，
//   :902 的 `typeof tt2.cleanupCoalesceLocks !== 'function'` 只会走 skip，而 T14-d1 的源码正则只证明
//   "函数**定义**还在"、不证明"被**导出**" → 该状态零覆盖（静默）。
// 做法：从 selftest.js **自身源码**（剥注释后）正则抽取所有对被测模块的成员引用，与模块的实际导出键
//   求差集；差集非空 = 引用了一个并不存在的导出 = 必是代码回归 → fail。
{
  const selfCode = stripComments(fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf-8'));
  // 被测主模块在 selftest 里的全部局部变量名（grep 得来，勿漏；均为 require(skillDir/token-tracker.js) 的别名）
  const MOD_VARS = ['mod', 'ttMod', 'tt2', 'mod16', 'mod17', 'mod18', 'mod19'];
  const memberRe = new RegExp('\\b(?:' + MOD_VARS.join('|') + ')\\.([A-Za-z_$][A-Za-z0-9_$]*)', 'g');
  const referenced = new Set();
  let mm;
  while ((mm = memberRe.exec(selfCode)) !== null) referenced.add(mm[1]);
  // 例外：selftest 有意断言"该成员**不得**被导出"（T9-B3b 的死副本守卫）——负向引用不是"引用缺失导出"。
  const ABSENT_BY_DESIGN = new Set(['parsePeakSchedule']);

  let ttAll = null;
  try { ttAll = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { ttAll = null; }
  if (!ttAll) {
    ok('★导出一致性：selftest 引用到的所有成员都必须真的被导出', false,
      'token-tracker.js require 失败 —— 无法核对导出');
  } else {
    // hasOwnProperty 排除原型链属性（constructor / toString 等），只认真正的显式导出。
    const missing = [...referenced].filter(
      (n) => !ABSENT_BY_DESIGN.has(n) && !Object.prototype.hasOwnProperty.call(ttAll, n));
    ok('★导出一致性：selftest 引用到的所有成员都必须真的被导出（自动推导，非手工清单）',
      missing.length === 0,
      '缺失: ' + missing.join(', ') + `（已核对 ${referenced.size} 个引用成员）`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
// v3.24.0（审计⑤）：skip 数显式化 —— 「138 全绿」曾掩盖 26 条端到端用例全部 SKIP 的事实
// （SPAWN_OK=false 的沙箱环境里绿 ≠ 真跑过）。
// v3.29.0（A-3）：**退出码语义修正** —— 只有真失败才 exit 1；envSkip 是"环境能力受限"（沙箱禁 spawn、
//   CI 的 WB_NO_NET 前提缺口），不是代码问题，**不再让 job 变红**（旧行为 exit 2 会被 GitHub Actions
//   一律判失败，且红的原因看起来像"测试失败"）。CI 正常环境下 envSkip 应为 0，summary 会显式标注。
//   为此**不需要** job 级 continue-on-error —— 那玩意无法区分 exit 1/2，会连带吞掉真实回归。
console.log(`\n结果：${pass} 过 / ${fail} 败 / ${envSkipCount} 环境受限跳过`
  + (envSkipCount > 0 ? '（需要 node 子进程或 WB_NO_NET 前提缺口；属环境能力限制、不计入退出码；CI 上应为 0）' : ''));
process.exit(fail ? 1 : 0);
