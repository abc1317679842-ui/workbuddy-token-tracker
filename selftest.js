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
// v3.32.0：refresh-holidays.js 必须随行——主脚本 v3.32.0 起 require('./refresh-holidays.js')
//   （方案 H：触发判定共用同一实现），隔离目录缺它 = 主模块 MODULE_NOT_FOUND，整段测试全炸。
for (const f of ['token-tracker.js', 'refresh-prices.js', 'deepseek-official.js', 'refresh-holidays.js', 'pricing.json', 'holidays.json', 'peak-rules.js', 'recalc-day.js']) {
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
  // v3.32.1（CI 红根因修复①）：本断言的「输出须确为报告正文」靠 7 列表头判据，但**空账本输出的是
  //   「账本为空（暂无记录）」短句**（无表头）——v3.31.0 注释里「空账本也会照常输出表头」的前提不成立。
  //   本机沙箱 SPAWN_OK=false 全程跳过才一直假绿；CI（SPAWN_OK=true）首次真跑即红（outLen=11）。
  //   预置 1 条最小记录（schema 同 T11-led11），让 T2 在「有账本」形态下验证报告正文。
  fs.writeFileSync(path.join(skillDir, 'daily-usage.json'), JSON.stringify({
    '2026-10-04': {
      models: { 'ci-fixture-model': { in: 100, out: 50, cached: 0, total: 150, cost: 0.01, hit: 0 } },
      total: { in: 100, out: 50, cached: 0, total: 150, cost: 0.01, hit: 0 },
    },
  }, null, 2));
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], { env, timeout: 30000, windowsHide: true, encoding: 'utf8' });
  const out = r.stdout || '';
  ok('T2 --report all exit 0', r.status === 0, `exit=${r.status}`);
  // A-12 修复（原断言是永真式）：`out.indexOf('读取方指令') < 0` —— 该串在 token-tracker.js 里
  //   **只出现在注释**（:565 / :2879 / :3511），没有任何可达代码路径会输出它；更糟的是 --report 崩溃、
  //   输出空串时 indexOf<0 依旧为真 → 假绿。补两道真判据：
  //   ① 正例自检：把含标记的样本喂给同一检测器必须得 true（证明检测器本身有效，断言不是恒真）；
  //   ② 输出形状前置：stdout 必须确实含 --report 的 7 列表头（上方预置了 1 条最小记录，有账本才有表头；
  //      空账本输出「账本为空（暂无记录）」短句——见上方 v3.32.1 注释），崩溃、空输出、非报告文本不得蒙混通过。
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
  // v3.32.1（CI 红根因修复②）：WB_NO_NET=1 下 v3.18.1（N3）既定保守行为 = 损坏**不 rename**（联网开关
  //   关闭无法重建，改名只会移走原文件、用户没法即时恢复）——CI step 设了 WB_NO_NET=1 → rename 分支
  //   永远不执行，原断言在 CI 必红（found=0，v3.30.0 起三版连续）。改为按环境各守各的行为：
  //   断网守「不 rename + 告警出现」，联网守「rename 备份 + 原文件移走」（自愈链路）。
  if (process.env.WB_NO_NET === '1') {
    ok('T3 断网模式：损坏 pricing 不 rename（既定保守行为，联网才自愈重建）', baks.length === 0, `found=${baks.length}`);
    ok('T3 断网模式：stderr 提示联网开关关闭（可观测）', String(r.stderr || '').indexOf('联网开关关闭') >= 0, String(r.stderr || '').slice(0, 140));
  } else {
    ok('T3 损坏 pricing 产生 .corrupt-* 备份', baks.length === 1, `found=${baks.length}`);
    ok('T3 损坏文件已改名移走', !fs.existsSync(path.join(skillDir, 'pricing.json')) || (() => {
      try { JSON.parse(fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8')); return true; } catch (e) { return false; }
    })());
  }
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
    try { fs.unlinkSync(bakPath); } catch (e) {} // silent-ok:清理 — 测试用临时文件清理
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

  // ── v3.30.0（CI 红修复）：把 T12 的「联网前提」显式化，不再依赖外部环境 ──────────
  // 根因：v3.29.0（A-3③）起主脚本在 token-tracker.js:278 读 WB_NO_NET / WB_DISABLE_NET 作为
  //   **联网总开关**（`const ENABLE_NETWORK = !(process.env.WB_NO_NET === '1' || …)`），而
  //   updateNotice()（:4746）与 updateTagForToast()（:4765）的**第一行**都是
  //   `if (!(ENABLE_NETWORK && ENABLE_UPDATE_CHECK)) return …;` —— 在**读状态文件之前**就短路。
  //   T12 的 c/d/e/f/q 组是 v3.21/3.22 时代写的老断言，它们的「离线」保证来自预置
  //   `lastCheckAt: now` 关掉 7 天闸门；总开关先短路 → 闸门根本没机会生效 →
  //   CI（env WB_NO_NET=1）里 c/q 拿 ''（假红）、e/f 恒 ''（**假绿**，等于没覆盖）。
  // 修法：用同一目录下的两份**模块副本**，分别在「WB_NO_NET 未设」/「WB_NO_NET=1」两种环境里
  //   require。ENABLE_NETWORK 是 require 期求值的模块级 const，同进程改 env 对已加载实例无效，
  //   故必须换路径重新加载（不能只改 process.env）。副本与原件同目录 → `__dirname/.update-check.json`
  //   仍是同一个文件，状态预置/落盘断言与 UF 落点全部照旧（刻意**不**挪 .update-check.json）。
  //   零联网仍由「预置 lastCheckAt=now 关掉闸门」承担，并由下面的 execFileSync 探针**硬证明**。
  // 为什么不用 spawnSync 起子进程：本沙箱 node→node spawnSync 报 EBUSY（SPAWN_OK=false），
  //   子进程方案在最需要验证的环境里反而跑不到、只能 envSkip；同进程重新 require 效果等价且可验证。
  const TTJS = path.join(skillDir, 'token-tracker.js');
  const mkVariant = (name, noNet) => {
    const p = path.join(skillDir, name);
    fs.copyFileSync(TTJS, p);
    const saved = { WB_NO_NET: process.env.WB_NO_NET, WB_DISABLE_NET: process.env.WB_DISABLE_NET };
    if (noNet) process.env.WB_NO_NET = '1';
    else { delete process.env.WB_NO_NET; delete process.env.WB_DISABLE_NET; }
    try { return require(p); }
    finally {
      for (const k of ['WB_NO_NET', 'WB_DISABLE_NET']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  };
  const ttNet = mkVariant('token-tracker.net.js', false);     // 联网总开关**开启**（CI / 本机表现一致）
  const ttNoNet = mkVariant('token-tracker.nonnet.js', true); // 联网总开关**关闭**

  // 零联网硬证明：queryLatestTag（:4692）是版本查询的唯一出口
  //   （`require('child_process').execFileSync(process.execPath, ['-e', script])`，script 含
  //   `api.github.com`）。探针只对这类调用计数并**直接抛错**（绝不放行），跑完断言计数必须为 0。
  const cp = require('child_process');
  const realExecFileSync = cp.execFileSync;
  let netProbes = 0;
  cp.execFileSync = function (file, args) {
    if (Array.isArray(args) && args.some((a) => String(a).indexOf('api.github.com') >= 0)) {
      netProbes++;
      throw new Error('T12 探针：闸门闭合期间不得发起版本查询');
    }
    return realExecFileSync.apply(this, arguments);
  };

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
  //    用 ttNet（联网总开关开启）→ 断言的是真实产品行为，而非 CI 上被总开关短路的假结果。
  put({ lastCheckAt: now, latestVersion: '9.9.9', failCount: 0, nextRetryAt: 0 });
  const n1 = ttNet.updateNotice();
  ok('T12-c1 ★远端更高时返回一行提示（闸门闭合 → 零联网）',
    typeof n1 === 'string' && n1.indexOf('v9.9.9') >= 0, JSON.stringify(n1));
  ok('T12-c2 提示文案极短（≤ 45 字符）且不含金额/链接/升级步骤',
    n1.length > 0 && n1.length <= 45 && !/¥|http|git |覆盖|备份/.test(n1), `len=${n1.length} ${n1}`);

  // d：节流 —— 同版本 24h 内第二次静默
  //    （e/f 同理：WB_NO_NET=1 时这两条是**假绿**——总开关先短路返回 ''，判据恒真；改用 ttNet 才有覆盖）
  ok('T12-d1 同版本 24h 内第二次不重复提示', ttNet.updateNotice() === '');
  const st1 = ttMod.loadUpdateState();
  ok('T12-d2 提示计数已落盘（notifiedVersion + notifyCount）',
    st1.notifiedVersion === '9.9.9' && st1.notifyCount === 1, JSON.stringify(st1));
  put(Object.assign({}, st1, { notifyCount: ttNet.UPDATE_MAX_NOTIFY }));
  ok('T12-d3 达到提示上限后彻底静默', ttNet.updateNotice() === '');

  // e：本地已是最新 / 远端更旧 → 静默
  put({ lastCheckAt: now, latestVersion: ttNet.SKILL_VERSION });
  ok('T12-e1 远端 == 本地 → 静默', ttNet.updateNotice() === '');
  put({ lastCheckAt: now, latestVersion: '3.9.0' });
  ok('T12-e2 远端低于本地（3.9.0 < 当前版本）→ 静默', ttNet.updateNotice() === '');

  // f：退避未到 → 静默且不联网（nextRetryAt 在未来）
  put({ failCount: 1, nextRetryAt: now + 3600000 });
  ok('T12-f 退避未到（nextRetryAt 在未来）→ 静默且不发起检查', ttNet.updateNotice() === '');

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
  const tag1 = ttNet.updateTagForToast(now);
  ok('T12-q1 ★没配 hook（无 lastHookAt）→ toast 兜底标记产出 `⬆v9.9.9`', tag1 === '⬆v9.9.9', JSON.stringify(tag1));
  ok('T12-q2 同进程重复调用返回缓存（一次 Stop 会格式化多次 toastLine1，不能重复消费计数）',
    ttNet.updateTagForToast(now + 99999) === tag1);
  ok('T12-q3 ★源码守卫：updateTagForToast 内先判 hookIdle、再 claimNotify（hook 活着 → 永不产出标记）', (() => {
    const i = mainSrc.indexOf('function updateTagForToast');
    const body = mainSrc.slice(i, mainSrc.indexOf('function maybeFetchLatestForStop', i));
    return body.indexOf('if (!hookIdle(now, st)) return gUpTag;') > 0
      && body.indexOf('claimNotify(st') > body.indexOf('hookIdle(now, st)');
  })());

  // r：v3.30.0 新增 —— **联网总开关优先级**：WB_NO_NET=1 时状态文件不得绕过总开关。
  //    这条同时是「c/d/q 改用 ttNet 仍属零联网」的对偶锁：总开关关 = 一律静默（断网时的正确产品行为）。
  put({ lastCheckAt: now, latestVersion: '9.9.9', failCount: 0, nextRetryAt: 0 }); // 无 lastHookAt → hookIdle=true
  const r1 = ttNoNet.updateNotice(now);
  const r2 = ttNoNet.updateTagForToast(now);
  ok('T12-r1 ★WB_NO_NET=1（联网总开关关）→ updateNotice() 恒为 ""（状态文件不得绕过总开关）',
    r1 === '', JSON.stringify(r1));
  ok('T12-r2 ★WB_NO_NET=1 → updateTagForToast() 恒为 ""（没配 hook 也不得产出 ⬆ 标记）',
    r2 === '', JSON.stringify(r2));
  const stNo = ttMod.loadUpdateState();
  ok('T12-r3 ★总开关关闭时不落盘提示计数（notifiedVersion / notifyCount 均未写）',
    !stNo.notifiedVersion && !stNo.notifyCount, JSON.stringify(stNo));
  cp.execFileSync = realExecFileSync; // 还原探针（后续 T12-j 的 spawn 不受影响）
  // 零联网证据：① execFileSync 探针 0 次（从未走到 queryLatestTag）；② 闸门字段未被改写
  //   （lastCheckAt 仍是预置的 now、failCount 仍为 0 → 没发起过任何一次版本查询）。
  const stEnd = ttMod.loadUpdateState();
  ok('T12-r4 ★零联网证明：c/d/e/f/q/r 全程未发起版本查询（探针 0 次 + lastCheckAt/failCount 未变）',
    netProbes === 0 && stEnd.lastCheckAt === now && Number(stEnd.failCount) === 0,
    `netProbes=${netProbes} ${JSON.stringify(stEnd)}`);

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
  // v3.34.0（A5·修既有假绿）：**自动提取**替代手写清单。手写清单正是这条守卫的假绿之源——
  //   SKILL.md 实际反引号指向 7 个 md（TROUBLESHOOTING / docs×4 / CHANGELOG / KNOWN-ISSUES），
  //   而这里原先手写只列 **4 个** → 另外 3 个"指了但文件不存在"**完全查不出来**（守卫只守半边）。
  //   这与 T24（null 守卫只加半边）是同一个病根：清单靠人记得往里加，就一定会漏。
  const skillRaw12 = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf-8');
  const SIDE_FILES = [...new Set((skillRaw12.match(/`([A-Za-z0-9_][A-Za-z0-9_./-]*\.md)`/g) || [])
    .map((s) => s.slice(1, -1))
    .filter((f) => f !== 'SKILL.md'))].sort(); // 排除自指（SKILL.md 自己当然存在，且它不在"旁支"语义里）
  ok(`T12-i6a ★旁支文件清单是自动提取的且非空（提取器退化 = 守卫变假绿）`,
    SIDE_FILES.length >= 6, `实际提取 ${SIDE_FILES.length} 个：${SIDE_FILES.join(', ')}`);
  const missingSide = SIDE_FILES.filter((f) => !fs.existsSync(path.join(SRC, f)));
  ok(`T12-i6 SKILL.md 指向的旁支文件全部存在（${SIDE_FILES.length} 个，自动提取）`,
    missingSide.length === 0, missingSide.join(', ') || '全部存在');

  // j：端到端（spawn）—— 预置「有新版」状态跑 --hook，提示必须出现在注入里
  //   ★v3.30.0：j 组与 c/d/q 同源——`env` 继承 CI 的 WB_NO_NET=1 → 子进程里 updateNotice() 走
  //   总开关短路返回 '' → j1/j2 在真 CI（SPAWN_OK=true）上必红（本沙箱 SPAWN_OK=false 被跳过才没暴露）。
  //   这里给子进程一套**删掉 WB_NO_NET / WB_DISABLE_NET** 的环境（envNet），零联网仍由
  //   `lastCheckAt = nowJ` 关掉 7 天闸门承担（见下面 j4 的证据断言）。
  const envNet = Object.assign({}, env);
  delete envNet.WB_NO_NET; delete envNet.WB_DISABLE_NET;
  const nowJ = Date.now();
  if (!SPAWN_OK) envSkip('T12-j --hook 端到端注入提示', SPAWN_SKIP_REASON);
  else {
    put({ lastCheckAt: nowJ, latestVersion: '9.9.9', failCount: 0, nextRetryAt: 0 });
    const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'],
      { input: HOOK_PAYLOAD, env: envNet, timeout: 30000, windowsHide: true, encoding: 'utf8' });
    const ac = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (e) { return ''; } })();
    ok('T12-j1 ★有新版时 --hook 的 additionalContext 末尾带更新提示',
      String(ac).indexOf('[技能更新]') >= 0, String(ac).slice(0, 160));
    ok('T12-j2 提示位于注入内容最后一行（不插入到用量行中间）',
      String(ac).split('\n').slice(-1)[0].indexOf('[技能更新]') === 0, JSON.stringify(String(ac).split('\n').slice(-2)));
    // 换成「已是最新」再跑一次 → 注入内容必须**不含**提示（回归：旧行为逐字节不变）
    // v3.32.1（CI 红根因修复③）：put 是**整文件覆盖**——此前漏带 failCount/nextRetryAt，
    //   j4 读回的对象没有 failCount 键 → Number(undefined)=NaN ≠ 0 → CI 必红（j4 输出自证：
    //   lastCheckAt 仍等于 nowJ、latestVersion=put 值，红的是 NaN 而非真联网）。
    put({ lastCheckAt: nowJ, latestVersion: ttNet.SKILL_VERSION, notifyCount: 0, failCount: 0, nextRetryAt: 0 });
    const r2 = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'],
      { input: HOOK_PAYLOAD, env: envNet, timeout: 30000, windowsHide: true, encoding: 'utf8' });
    ok('T12-j3 已是最新时 --hook 注入不含任何更新提示（旧行为不变）',
      String(r2.stdout || '').indexOf('[技能更新]') < 0, String(r2.stdout).slice(0, 160));
    // j4：子进程侧零联网证明 —— 闸门闭合（lastCheckAt=nowJ、nextRetryAt=0）时若真发起过查询，
    //   maybeFetchLatest 必然改写 lastCheckAt 或把 failCount 加 1；两者都没变 = 一次都没查。
    const stJ = ttMod.loadUpdateState();
    // failCount 用 ||0 容错（键缺失与 0 同义 = 未查询；真发起过查询则必为 ≥1 或 lastCheckAt 已变）。
    ok('T12-j4 ★子进程零联网证明：lastCheckAt 未变且 failCount 仍为 0（未发起版本查询）',
      stJ.lastCheckAt === nowJ && Number(stJ.failCount || 0) === 0, JSON.stringify(stJ));
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
    for (const p of [old1, old2, fresh, cur]) { try { fs.unlinkSync(p); } catch (e) {} } // silent-ok:清理 — 测试用临时文件清理
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
      } catch (e) {} // silent-ok:清理 — 测试夹具清理
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
    try { fs.unlinkSync(path.join(skillDir, '.snapshot-' + SID17 + '.json')); } catch (e) {} // silent-ok:清理 — 测试用快照清理
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

// ===== T20：v3.31.0 第二轮审计修复——新行为判据锁定 =====
// 覆盖五组：A 峰谷批级时刻（toastLine2 源码守卫）/ 缺陷C isLocalModel 短名门槛（源码守卫）/
//   P0-5 priceGate sanity（行为断言）/ P1-7 noPriceTag1 优先级（行为断言）/ 缺陷B 区间透传（行为断言）。
// 为什么 isLocalModel/toastLine2 用源码守卫：isLocalModel 有模块级缓存（_localModelNames）本进程无法
//   安全注入短名 fixture；toastLine2 峰谷行为级验证需构造跨档时刻对（收口时 focus.js 已验 4/4）。
//   源码守卫在本机与 CI 都真跑，锁"逻辑被改没"这类回归；数值级行为另有独立 CLI 验证留档。
{
  const mod20 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod20) ok('T20 v3.31.0 修复验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const main20 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');

    // ── a. 缺陷C：isLocalModel 短名门槛 ──
    const ilStart = main20.indexOf('function isLocalModel');
    const ilEnd = main20.indexOf('\nfunction ', ilStart + 10);
    const ilBody = ilEnd > ilStart ? stripComments(main20.slice(ilStart, ilEnd)) : '';
    ok('T20-a1 ★isLocalModel 双向子串必须带 lm.length>=5 门槛（短名 qwen 曾可把 qwen-max 误判本地免费）',
      ilBody.includes('lm.length >= 5') && ilBody.includes('n.includes(lm)') && ilBody.includes('lm.includes(n)'),
      '双向都保留但短名必须被挡；此条红 = 有人动了匹配逻辑');
    ok('T20-a2 精确匹配在门槛之前（n===lm 永远放行，登记全名↔调用短名互变的底线）',
      ilBody.indexOf('n === lm') >= 0 && ilBody.indexOf('n === lm') < ilBody.indexOf('lm.length >= 5'));

    // ── b. A 修复：toastLine2 峰谷批级时刻 ──
    const tlStart = main20.indexOf('function toastLine2');
    const tlEnd = main20.indexOf('\nfunction ', tlStart + 10);
    const tlBody = tlEnd > tlStart ? stripComments(main20.slice(tlStart, tlEnd)) : '';
    ok('T20-b1 ★toastLine2 用批级峰谷时刻 batchTs（跨 12:00/18:00 边界混合轮弹窗金额必须==账本金额）',
      tlBody.includes('batchTs'), '红 = 弹窗退回逐模型 lastTs，与账本口径分裂（弹窗¥2.00/账本¥4.00 形态复发）');

    // ── c. P0-5/P1-7：priceGate sanity（纯函数，直接行为断言）──
    const rp20 = (() => { try { return require(path.join(SRC, 'refresh-prices.js')); } catch (e) { return null; } })();
    if (!rp20) ok('T20-c priceGate 验证', false, 'refresh-prices.js require 失败');
    else {
      const warns20 = [];
      const gPass = rp20.priceGate('m', { input_price: 5, output_price: 15, cached_price: 0.5 }, { input_price: 4.5, output_price: 16, cached_price: 0.5 }, warns20);
      ok('T20-c1 正常波动（±10%）放行且零告警（宁可漏报绝不误杀的下半句：不冤枉正常刷新）',
        gPass && gPass.main === false && gPass.cached === false && warns20.length === 0, JSON.stringify({ gPass, warns20 }));
      warns20.length = 0;
      const gHuge = rp20.priceGate('m', { input_price: 6000, output_price: 15 }, { input_price: 5, output_price: 15, cached_price: 0.5 }, warns20);
      ok('T20-c2 ★主价 ×1200 骤变拦截 + 告警形状「key: 说明」（可被弹窗 ⚠价核验 点名命中）',
        gHuge && gHuge.main === true && warns20.length === 1 && /^m: /.test(warns20[0]), JSON.stringify({ gHuge, warns20 }));
      warns20.length = 0;
      // 列错位形态：cached 4→6 仅 ×1.5 不触发骤变，但 6 > input 5 → 交叉校验必须兜底
      const gMis = rp20.priceGate('m', { input_price: 5, output_price: 15, cached_price: 6 }, { input_price: 5, output_price: 15, cached_price: 4 }, warns20);
      ok('T20-c3 ★cached>input 列错位：告警点名「列错位」+ 有旧值回退（cached=true）',
        gMis && gMis.cached === true && warns20.some((w) => w.includes('列错位')), JSON.stringify({ gMis, warns20 }));
      ok('T20-c4 sanity 阈值导出（abortAt=3 的刻度不许被悄悄改掉）',
        rp20.PRICE_SANITY && rp20.PRICE_SANITY.abortAt === 3, JSON.stringify(rp20.PRICE_SANITY || null));
    }

    // ── d. P1-7：noPriceTag1 优先级（行为断言）──
    // 判定消费的是 refresh-prices 落盘的显式标记 cached_price_unknown:true（不是"条目缺 cached_price 键"）。
    const P20 = { models: { 'm-x': { input_price: 2, output_price: 6, cached_price_unknown: true } } }; // 主价真、缓存价未公布
    ok('T20-d1 ★cached_price_unknown + 有缓存命中 → 行1 标「⚠缓存价未知」（缓存占比 ~97% 时金额低估 45%~86% 的形态）',
      mod20.noPriceTag1({ model: 'm-x', in: 1000, out: 500, cached: 9000 }, P20).includes('缓存价未知'));
    ok('T20-d2 cached_price_unknown 但无缓存命中 → 不标（零噪音，没用到缓存就没有低估）',
      mod20.noPriceTag1({ model: 'm-x', in: 1000, out: 500, cached: 0 }, P20).length === 0);
    // 优先级的真实形态是**混合轮**：一个模型无公开价、另一个缓存价未知 → 只亮更严重的「无公开价」
    // （同一模型两种状态互斥：anyCachePriceUnknown 显式排除 pricing_status==='unpublished'）
    const stat20d3 = { model: 'm-pub', in: 1000, out: 500, cached: 9000, models: { 'm-pub': { in: 900, out: 400, cached: 8000 }, 'm-unk': { in: 100, out: 100, cached: 1000 } } };
    const P20d3 = { models: { 'm-pub': { pricing_status: 'unpublished' }, 'm-unk': { input_price: 2, output_price: 6, cached_price_unknown: true } } };
    ok('T20-d3 ★优先级：无公开价 > 缓存价未知（混合轮同时存在只显示前者，一个标注位给最严重的）',
      (() => { const t = mod20.noPriceTag1(stat20d3, P20d3); return t.includes('无公开价') && !t.includes('缓存价未知'); })());

    // ── e. 缺陷B：unpriced 区间透传（收口 CLI 验证抓到的漏网：聚合层曾只透传 no_price/cached_price_unknown）──
    const agg20 = mod20.aggregateRangeModels(
      { '2026-10-01': { models: { 'new-m': { in: 10, out: 5, cached: 0, total: 15, cost: 0, unpriced: true } } } },
      '2026-10-01', '2026-10-02');
    ok('T20-e1 ★aggregateRangeModels 透传 unpriced（标记丢失曾让区间表静默打 ¥0.00 且零告警）',
      !!(agg20.models['new-m'] && agg20.models['new-m'].unpriced === true), JSON.stringify(agg20.models['new-m'] || null));
    ok('T20-e2 ★formatUsageRow unpriced → 「未收录」（单日/区间共用行格式，不允许退回 ¥0.00）',
      mod20.formatUsageRow({ label: 'new-m', in: 10, out: 5, cached: 0, total: 15, cost: 0, unpriced: true, hit: 0 }, false).includes('未收录'));
  }
}

// ===== T21：v3.32.0 第三轮审计——「真价优先」不变量 + 四出口守卫（P1-1）=====
// 病根：refresh-prices.js 对 pricing_status **零命中** —— 厂商公布单价、我们把价刷进 pricing.json 之后，
//   'unpublished' 标记还挂在模型上 → 账本条目 cost>0 却带着 no_price → 四出口把**已算出的真金额**盖成
//   「无公开价」。三层治理：F3 治根（补价后删标记）/ F4 兜底（cost>0 优先显示金额）/ 本段守卫。
// 为什么除行为断言外还要**源码守卫**：v3.31.0 的教训是"共用函数已修 ≠ 调用方生效"——
//   formatUsageRow 改好了，aggregateRangeModels 漏透传标记，区间表照样静默 ¥0.00。
//   所以这里把"判定必须走同一个 costCellKind"也锁住，防第五个出口再复制一份旧的三元判定。
{
  const mod21 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod21) ok('T21 v3.32.0 修复验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是回归，不允许静默跳过');
  else {
    const main21 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');

    // ── a. 不变量本体：costCellKind「真价优先」 ──
    ok('T21-a1 ★cost>0 + no_price 残留 → 显示金额（已算出的钱不许被陈旧标记藏起来）',
      mod21.costCellKind({ cost: 3.5, no_price: true }) === 'ok');
    ok('T21-a2 ★cost>0 + unpriced 残留 → 同样显示金额（同一类陈旧残留，判据必须一致）',
      mod21.costCellKind({ cost: 3.5, unpriced: true }) === 'ok');
    ok('T21-a3 cost=0 + no_price → 仍「无公开价」（红线 C4：真算不出钱的条目绝不能退回 ¥0.00）',
      mod21.costCellKind({ cost: 0, no_price: true }) === 'no_price');
    ok('T21-a4 cost=0 + unpriced → 「未收录」，且定序优先于 no_price（两标记互斥，此处只锁兜底顺序）',
      mod21.costCellKind({ cost: 0, unpriced: true, no_price: true }) === 'unpriced'
      && mod21.costCellKind({ cost: 0, no_price: true }) === 'no_price');
    ok('T21-a5 cost=0 且无标记 → ¥0.00（真免费的模型照常显示 0，不许被误标）',
      mod21.costCellKind({ cost: 0 }) === 'zero');

    // ── b. 四出口：同一个矛盾态条目，各出口口径必须一致 ──
    const row21 = mod21.formatUsageRow(
      { label: 'm-x', in: 1000, out: 500, cached: 0, total: 1500, cost: 3.5, no_price: true, hit: 0 }, false);
    ok('T21-b1 ★表格行出口：cost>0 + no_price → 显示 ¥金额且不含「无公开价」',
      row21.includes('¥') && !row21.includes('无公开价'), row21);
    const fnBody21 = (name) => {
      const i = main21.indexOf('function ' + name);
      if (i < 0) return '';
      const j = main21.indexOf('\nfunction ', i + 10);
      return stripComments(main21.slice(i, j > i ? j : undefined));
    };
    ok('T21-b2 ★表格行判定走共用 costCellKind（不是自己抄一份三元判定）',
      fnBody21('formatUsageRow').includes('costCellKind(s)'), '红 = formatUsageRow 又内联了自己的优先级');
    ok('T21-b3 ★CSV 判定走共用 costCellKind（此前两份判定各抄一遍 → 改一处漏一处是必然）',
      fnBody21('exportReportCsv').includes('costCellKind(m)'), '红 = CSV 又复制了一份旧判定');
    ok('T21-b4 ★全文件不得残留第三份 unpriced 三元判定（出现即新出口漏改）',
      (stripComments(main21).match(/\bs\.unpriced \? '未收录'|\bm\.unpriced \? 'unpriced'/g) || []).length === 0);

    // ── c. 区间透传：只传"当天真缺价"的标记 ──
    const agg21a = mod21.aggregateRangeModels(
      { '2026-10-01': { models: { 'm-x': { in: 10, out: 5, cached: 0, total: 15, cost: 3.5, no_price: true } } } },
      '2026-10-01', '2026-10-02');
    ok('T21-b5 ★区间透传：当天 cost>0 的陈旧标记不传播（否则整段发「合计偏低」假告警）',
      !agg21a.models['m-x'].no_price, JSON.stringify(agg21a.models['m-x'] || null));
    const agg21b = mod21.aggregateRangeModels(
      { '2026-10-01': { models: { 'm-y': { in: 10, out: 5, cached: 0, total: 15, cost: 0, no_price: true } } } },
      '2026-10-01', '2026-10-02');
    ok('T21-b6 区间透传：当天 cost=0 的真缺价标记照传（月中补价的混合场景必须保住告警）',
      agg21b.models['m-y'].no_price === true, JSON.stringify(agg21b.models['m-y'] || null));

    // ── d. F3 治根：refresh-prices 补到真价后必须清标记 ──
    const rf21 = stripComments(fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8').replace(/\r\n/g, '\n'));
    ok('T21-c1 ★补价成功后 delete m.pricing_status（此前该文件对该字段零命中 = P1-1 病根）',
      rf21.includes('delete m.pricing_status'), '红 = 补了价却不摘「无公开价」帽子，矛盾条目还会继续产生');
    ok('T21-c2 清标记必须在 sanity gate 判定之后（价被 sanity 拦下回退时不许顺手清标记）',
      rf21.indexOf('const gate = priceGate') >= 0
      && rf21.indexOf('const gate = priceGate') < rf21.indexOf('delete m.pricing_status')
      && rf21.includes('!gate.main'), '红 = 新价不可信时仍清标记，等于白捡一个假"已公布价"');

    // ── e. F7：兜底汇率单一真源 ──
    const rp21x = (() => { try { return require(path.join(SRC, 'refresh-prices.js')); } catch (e) { return null; } })();
    ok('T21-d1 ★DEFAULT_RATE 单一真源：refresh-prices 导出 7.2，tt.js 兜底处引用它且全文件无第二个字面量',
      !!rp21x && rp21x.DEFAULT_RATE === 7.2
      && stripComments(main21).includes('priceRefreshModule.DEFAULT_RATE')
      && (stripComments(main21).match(/: 7\.2(?!\d)/g) || []).length === 0,
      '红 = 两处兜底汇率改不同步会静默跑偏（P1-3）');

    // ── e. v3.33.0（第四轮审计 补-S1）：清标判据必须是 > 0 —— 0 价不算"已公布" ──
    //   病灶：v3.32.0 写的判据是 `!= null`，而 `0 != null` 为真 → space-bunny（in/out 同为 0 =
    //   厂商未公布）下次刷新就丢标记 → 账本不打 no_price → 四出口显示 ¥0.00（读成"免费"）→
    //   合计偏低告警消失 = v3.27.0 修掉的 KI-7 病根从另一扇门回来。
    ok('T21-e1 ★补价清标判据为 > 0（0 价 = 仍未公布，清掉标记会把 KI-7 病根放回来）',
      rf21.includes('m.input_price > 0 && m.output_price > 0'),
      '红 = 判据回退，0 价条目下次刷新丢 unpublished → 出口显示 ¥0.00 被读成免费');
    ok('T21-e2 ★全文件不得残留 `!= null` 形式的清标判据（0 != null 为真 = 原病灶形态）',
      !/m\.input_price != null\s*&&\s*m\.output_price != null/.test(rf21));
  }
}

// ===== T22：v3.32.0 方案 H——假日三态语义 + 自适应触发判定（审计 P1-4）=====
// 病根：peak-rules 的 `years[y] || []` 把「null/缺键=未知」「[]=旧版 0 天落盘残留」「[日期…]=已确认」
//   压成同一结果 → `2027: []` 被当"全年无假日"，真假日按高峰 ×2 多算、调休上班日按周末低峰少算，双向错且零告警。
//   且 refresh-holidays 零调用方 → 数据永不更新。方案 H：三态语义（peak-rules 探针）+ 四条件自适应刷新
//   （holidayRefreshNeeded 纯函数，主脚本与 selftest 共用实现）+ 挂每日链路 + --check 体检。
{
  const pr22 = (() => { try { return require(path.join(SRC, 'peak-rules.js')); } catch (e) { return null; } })();
  const rh22 = (() => { try { return require(path.join(SRC, 'refresh-holidays.js')); } catch (e) { return null; } })();
  if (!pr22 || !rh22) {
    ok('T22 模块加载', false, 'peak-rules.js / refresh-holidays.js require 失败');
  } else {
    const dir22 = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-holidays-'));
    // v3.32.1（CI 红根因修复④）：refresh-holidays.js resolveOutPath 按**读取方口径**解析
    //   （WB_ROOT/skills/token-usage-tracker/，目录存在性检查不过 → 退回 __dirname）——fixture 必须建出
    //   该层级，否则 --check 静默读到真仓库的 holidays.json（CI stderr 自证退回路径），断言全空转。
    const skillsDir22 = path.join(dir22, 'skills', 'token-usage-tracker');
    fs.mkdirSync(skillsDir22, { recursive: true });
    const hp22 = path.join(skillsDir22, 'holidays.json');
    fs.writeFileSync(hp22, JSON.stringify({
      years: { '2025': ['2025-01-01'], '2026': ['2026-01-01', '2026-10-01'], '2027': null, '2024': [], '2023': ['2023-01-01'] },
      _stale: true, stale_years: ['2023'], stale_detail: { '2023': { since: '2026-10-04', reason: 'fixture' } },
    }));
    const ts22 = (s) => new Date(s + 'T12:00:00Z').getTime() - 8 * 3600e3; // 北京时间正午的 epoch ms
    ok('T22-a1 ★null 年（从未获取成功）→ 未知=true（2027 病灶形态）',
      pr22.holidayYearUnknown(ts22('2027-05-01'), hp22) === true);
    ok('T22-a2 键缺失年 → 未知=true',
      pr22.holidayYearUnknown(ts22('2028-05-01'), hp22) === true);
    ok('T22-a3 ★[] 空数组（旧版 0 天落盘残留）→ 未知=true（不许再当"全年无假日"）',
      pr22.holidayYearUnknown(ts22('2024-05-01'), hp22) === true);
    ok('T22-a4 非空数组且未标陈旧 → 已确认=false',
      pr22.holidayYearUnknown(ts22('2026-05-01'), hp22) === false
      && pr22.holidayYearUnknown(ts22('2025-05-01'), hp22) === false);
    ok('T22-a5 ★非空数组但被 _stale/stale_years 点名 → 未知=true（数据在但不可信）',
      pr22.holidayYearUnknown(ts22('2023-05-01'), hp22) === true);
    // v3.32.0 补验：真实落盘形态 stale_years 是**数字数组**（refresh 目标年份是 Number）→ 必须两边 String 化
    const hp22n = path.join(dir22, 'holidays-num.json');
    fs.writeFileSync(hp22n, JSON.stringify({
      years: { '2026': ['2026-01-01'] }, _stale: true, stale_years: [2026],
    }));
    ok('T22-a5b ★stale_years 为数字数组（真实落盘形态）→ 同样命中（String 化比对）',
      pr22.holidayYearUnknown(ts22('2026-05-01'), hp22n) === true);
    ok('T22-a6 文件不存在 → 未知=true（宁可多告警，不可静默假确认）',
      pr22.holidayYearUnknown(ts22('2026-05-01'), path.join(dir22, 'no-such.json')) === true);
    ok('T22-b1 ★isHolidayBeijing 已确认年判定零变化（零噪音红线 C7）',
      pr22.isHolidayBeijing(ts22('2026-10-01'), hp22) === true
      && pr22.isHolidayBeijing(ts22('2026-10-09'), hp22) === false);
    ok('T22-b2 ★isHolidayBeijing 未知年保持「非假日」降级（不许凭空猜假日，红线不动）',
      pr22.isHolidayBeijing(ts22('2027-10-01'), hp22) === false);
    // holidayRefreshNeeded：主脚本与 selftest 共用同一实现（不许两边各抄一份条件）
    const now22 = Date.now();
    const clean22 = { years: { '2026': ['2026-01-01'], '2027': ['2027-01-01'] } };
    ok('T22-c1 ★缺今年 → missing-current（当前计费正在用，任何月份都紧急）',
      rh22.holidayRefreshNeeded({ years: {} }, {}, now22) === 'missing-current');
    ok('T22-c2 ★全齐 + 30 天内成功过 → null（完全不联网、零成本）',
      rh22.holidayRefreshNeeded(clean22, { lastSuccessAt: now22 }, now22) === null);
    ok('T22-c3 ★缺明年 + 10 月 → probe-next-year（国务院次年安排约 11 月发布，10-12 月每日探测）',
      rh22.holidayRefreshNeeded({ years: { '2026': ['2026-01-01'] } }, { lastSuccessAt: now22 },
        new Date('2026-10-15T04:00:00Z').getTime()) === 'probe-next-year');
    ok('T22-c4 缺明年 + 9 月 + 近期成功 → null（发布窗口外不空跑）',
      rh22.holidayRefreshNeeded({ years: { '2026': ['2026-01-01'] } }, { lastSuccessAt: now22 },
        new Date('2026-09-15T04:00:00Z').getTime()) === null);
    ok('T22-c5 ★任一年 _stale → stale（持续重试直到成功）',
      rh22.holidayRefreshNeeded({ years: clean22.years, _stale: true, stale_years: ['2025'] }, {}, now22) === 'stale');
    ok('T22-c6 全齐 + 距上次成功 > 30 天 → aged（低频兜底，防源方补录调休）',
      rh22.holidayRefreshNeeded(clean22, { lastSuccessAt: now22 - 40 * 24 * 3600e3 }, now22) === 'aged');
    // 源码守卫：0 天/两源全失败 → 落盘必须是 null 占位，绝不允许 [] 复发（C9）
    const rf22 = stripComments(fs.readFileSync(path.join(SRC, 'refresh-holidays.js'), 'utf-8').replace(/\r\n/g, '\n'));
    ok('T22-d1 ★0 天/全失败分支写 null 显式占位（keepOldOrMarkUnknown）',
      rf22.includes('yearsMap[String(y)] = null'), '红 = 空数组落盘复发，2027 病灶形态回来');
    ok('T22-d2 ★全文件不得存在 yearsMap 空数组赋值（防有人把占位改回去）',
      (rf22.match(/yearsMap\[String\(y\)\]\s*=\s*\[\]/g) || []).length === 0);
    // --check 只读体检（端到端，SPAWN_OK 才跑）
    if (!SPAWN_OK) {
      envSkip('T22-e --check 只读体检', SPAWN_SKIP_REASON);
    } else {
      const before22e = fs.readFileSync(hp22, 'utf-8'); // 写前快照（e2 逐字节对比基准）
      const r22 = spawnSync(NODE, [path.join(SRC, 'refresh-holidays.js'), '--check'], {
        windowsHide: true, timeout: 20000,
        env: Object.assign({}, process.env, { WB_ROOT: dir22, TOKEN_TRACKER_NO_TOAST: '1' }),
      });
      const out22 = String(r22.stdout || '');
      ok('T22-e1 ★--check 只读体检：exit 0 + 点名未知/陈旧年份 + 给出建议动作',
        r22.status === 0 && out22.includes('2027') && out22.includes('2023')
        && (out22.includes('未知') || out22.includes('陈旧')), `exit=${r22.status} out=${out22.slice(0, 200)}`);
      const after22 = fs.readFileSync(hp22, 'utf-8');
      ok('T22-e2 ★--check 不写盘（体检就是体检，文件逐字节不变）',
        after22 === before22e && after22.includes('2027'));
    }
    fs.rmSync(dir22, { recursive: true, force: true }); // 临时 fixture 清理（本目录自产自销）
  }
}

// ===== T23：v3.33.0 第四轮审计——S3 尾部窗口治本 + S1 起点推断（Stop-only 记账）=====
// 病根 A（S3）：三处各自硬编码"从文件尾读多少字节"（65536/8192/4096），实测真实 transcript 平均行长
//   4.3KB、最大 206KB、30% 的行 >4KB → ① 超长行整行消失；② 64KB 窗口只够约 15 行而调用方按行数要
//   （400 行）→ 行数严重不足。治本：单点块回溯 eachTailLineReverse + 三个读者复用。
// 病根 B（S1）：lastUserMsgAt 只在 --hook 分支写 → 只配 Stop 的机器恒 0 → 记账整段跳过。
{
  const tt23 = (() => { try { return require(path.join(SRC, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!tt23) {
    ok('T23 模块加载', false, 'token-tracker.js require 失败');
  } else {
    const src23 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
    ok('T23-a1 ★三处尾部窗口硬编码已消除（65536/8192/4096 → 单点块回溯）',
      !/sz > 65536 \? 65536/.test(src23) && !/sz > 8192 \? 8192/.test(src23) && !/sz > 4096 \? 4096/.test(src23),
      '红 = 又按字节划窗口，长行整行消失 / 行数不足会复发');
    const n23 = (src23.match(/eachTailLineReverse\(/g) || []).length;
    ok('T23-a2 三个读者（readTailRaw/lastTranscLine/readTailRawLines）统一走 eachTailLineReverse',
      n23 >= 4, `实际出现 ${n23} 次（定义 1 + 调用 ≥3）`);
    ok('T23-a3 ★S1 起点兜底：inferRoundStartFromText 在两条 asStop 路径都被调用',
      (src23.match(/inferRoundStartFromText\(/g) || []).length >= 3,
      '红 = "只配 Stop 账本永不写"的病灶回归');
    ok('T23-a4 ★traces 兜底 writeCoalesce 必须带 tsPath（不带 → watcher 永不记账）',
      src23.includes('{ traceFile: tf, tsPath: tsPathT, roundStart, alreadyRecorded: false }'));
    // v3.34.0（P0-1 连锁）：traces 兜底路径**没有** Stop 端记账，它的 alreadyRecorded 必须是 false。
    //   若被"统一改成 true"，:6294 会退化成 todayUsageTxt → 这些轮**永不入账**（v3.33.0 S1 的双封死复发）。
    ok('T23-a5 ★traces 兜底的 alreadyRecorded 必须显式为 false（真值 → 该路径永不记账）',
      (src23.match(/tsPath: tsPathT, roundStart, alreadyRecorded: false/g) || []).length === 2,
      `实际 ${(src23.match(/tsPath: tsPathT, roundStart, alreadyRecorded: false/g) || []).length} 处（应恰为 2：多子回合 + 单 trace）`);

    const dir23 = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-tail-'));
    try {
      const f23 = path.join(dir23, 'mix.jsonl');
      const big23 = 'z'.repeat(200 * 1024); // 200KB 单行（贴近实测最大真实行 206KB）
      fs.writeFileSync(f23, [
        JSON.stringify({ type: 'message', role: 'user', timestamp: 1000, content: [{ type: 'text', text: '第一问' }] }),
        JSON.stringify({ type: 'message', role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: big23 }] }),
        JSON.stringify({ type: 'message', role: 'user', timestamp: 3000, content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }] }),
        JSON.stringify({ type: 'message', role: 'user', timestamp: 4000, content: [{ type: 'text', text: '真正的问题' }] }),
        JSON.stringify({ type: 'message', role: 'assistant', timestamp: 5000, content: [{ type: 'text', text: '答' }] }),
      ].join('\n') + '\n');
      const got23 = tt23.readTailRawLines(f23, 5);
      ok('T23-b1 ★含 200KB 超长行的文件：尾部 5 行全部完整可 parse（不再整行消失）',
        got23.length === 5 && got23.every((l) => { try { JSON.parse(l); return true; } catch (e) { return false; } }),
        `got=${got23.length} 各行长度=${got23.map((l) => l.length).join('/')}`);
      const rs23 = tt23.inferRoundStartFromText(f23);
      ok('T23-b2 ★起点推断跳过注入型 user 行，取最后一条真实提问（4000）',
        rs23 === 4000, `实际 ${rs23}`);
      const tl23 = tt23.lastTranscLine(f23);
      ok('T23-b3 lastTranscLine 末行可解析（超长行场景不再恒 null）',
        !!tl23 && tl23.timestamp === 5000, JSON.stringify(tl23).slice(0, 80));
      const onlyBig = path.join(dir23, 'big.jsonl');
      fs.writeFileSync(onlyBig, JSON.stringify({ type: 'message', role: 'assistant', timestamp: 9, content: [{ type: 'text', text: 'w'.repeat(200 * 1024) }] }) + '\n');
      const g2 = tt23.readTailRawLines(onlyBig, 1);
      ok('T23-b4 ★单行即超窗（旧实现只能返回残片）：现能完整读回该行',
        g2.length === 1 && (() => { try { JSON.parse(g2[0]); return true; } catch (e) { return false; } })(),
        `len=${g2.length ? g2[0].length : 0}`);
      ok('T23-b5 无 user 行 / 不存在 / null / 空串 → 0 且不抛异常',
        tt23.inferRoundStartFromText(onlyBig) === 0
        && tt23.inferRoundStartFromText(path.join(dir23, 'nope.jsonl')) === 0
        && tt23.inferRoundStartFromText(null) === 0
        && tt23.inferRoundStartFromText('') === 0);
    } finally { fs.rmSync(dir23, { recursive: true, force: true }); }
  }
}

// ===== T24：v3.33.0 第四轮审计——补-S2 守卫半边（null 模型条目让区间/CSV 崩） =====
// 病根：v3.24.0 只给 dayTotalOf 加了 null 守卫（"账本一条 null 条目曾让 --report/区间/CSV/外推全线
//   TypeError"），**aggregateRangeModels 漏了** → 守卫只加半边。实测症状（本机复现）：账本里一条
//   `"某模型": null` 时，`--report <起>..<止>` 与 `--report all --csv` 直接 TypeError、rc=1；
//   而单日表 / summary 因 `{...null}` 是合法的空展开（ES2018）而**幸免** → 表现为"只有区间和 CSV 打不开"。
{
  const tt24 = (() => { try { return require(path.join(SRC, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!tt24) {
    ok('T24 模块加载', false, 'token-tracker.js require 失败');
  } else {
    const src24 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
    const bodyOf = (name) => {
      const i = src24.indexOf('function ' + name);
      if (i < 0) return '';
      const j = src24.indexOf('\nfunction ', i + 1);
      return src24.slice(i, j < 0 ? src24.length : j);
    };
    const GUARD = 'if (!m || typeof m !== \'object\') continue;';
    ok('T24-a1 ★aggregateRangeModels 也带 null 守卫（此前只有 dayTotalOf 有 → 守卫只加半边）',
      bodyOf('aggregateRangeModels').includes(GUARD),
      '红 = 账本一条 null 条目就能让区间报表与 CSV 整体崩掉');
    ok('T24-a2 ★dayTotalOf 与 aggregateRangeModels 守卫同口径（两处判定必须一致）',
      bodyOf('dayTotalOf').includes(GUARD) && bodyOf('aggregateRangeModels').includes(GUARD),
      '红 = 又变成"改一处漏一处"');

    const d24 = {
      '2026-10-03': {
        models: {
          hy3: { in: 1000, out: 100, cached: 0, total: 1100, cost: 0.01 },
          broken: null,              // 真崩的那形态
          weird: 'not-an-object',    // 同族：非对象
        },
        total: { in: 1000, out: 100, cached: 0, total: 1100, cost: 0.01 },
      },
    };
    let agg24 = null; let threw24 = '';
    try { agg24 = tt24.aggregateRangeModels(d24, '2026-10-01', '2026-10-05'); } catch (e) { threw24 = String(e && e.message); }
    ok('T24-b1 ★含 null / 非对象模型条目的账本：aggregateRangeModels 不抛异常且跳过该条目',
      !!agg24 && !threw24
      && Object.keys(agg24.models).join(',') === 'hy3'
      && agg24.models.hy3.in === 1000 && agg24.models.hy3.total === 1100,
      threw24 ? ('抛了：' + threw24) : ('models=' + Object.keys(agg24 ? agg24.models : {}).join(',')));
    let dt24 = null; let threwDt = '';
    try { dt24 = tt24.dayTotalOf(d24['2026-10-03'].models); } catch (e) { threwDt = String(e && e.message); }
    ok('T24-b2 dayTotalOf 对同数据同样不抛（两出口口径对齐，不再"一个能开一个崩"）',
      !!dt24 && !threwDt && dt24.in === 1000 && dt24.total === 1100,
      threwDt ? ('抛了：' + threwDt) : ('in=' + (dt24 && dt24.in)));
  }
}

// ===== T25：v3.33.0 第四轮审计——A7 pruneRoundFiles 下沉统一出口 =====
// 病根：`ROUNDS_KEEP_MONTHS` 注释写着"--report 运行时顺带清理"，实现却只在 forecast / 区间 / --csv
//   三个后加的子分支各插一次 → **最常用的 `--report`（今天）与 `--report summary` 从不触发**
//   → 文档意图与实现不符，且"最常跑的入口不清、偶尔跑的才清"完全反了。
{
  const src25 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  const calls25 = (src25.match(/pruneRoundFiles\(\);/g) || []).length;
  ok('T25-a1 ★pruneRoundFiles 只在 --report 入口调用一次（三处子分支重复调用已合并）',
    calls25 === 1, `实际 ${calls25} 处（应恰为 1：下沉到统一入口）`);
  const iEntry = src25.indexOf("if (process.argv.includes('--report')) {");
  const iCall = src25.indexOf('pruneRoundFiles();');
  const iForecast = src25.indexOf('reportForecastTxt(', iEntry); // 必须从入口之后搜——否则会命中函数定义处
  ok('T25-a2 ★清理位于 --report 入口（在 forecast/区间/csv 各分支 return 之前）→ 所有变体都被覆盖',
    iEntry >= 0 && iCall > iEntry && iForecast > iCall,
    `entry=${iEntry} call=${iCall} forecast=${iForecast}`);
}

// ===== T26：v3.33.0 第四轮审计——新增 --doctor 只读体检 =====
// 存在意义：本技能的缺陷几乎全是"静默失效"型（配了 hook 不工作、价库/假日陈旧、账本被污染、锁与合并
//   文件堆积），都不报错。--doctor 把它们变成"一眼可见"，同时是 P4 拆分的前置条件。
// 硬约束（下面 a1/a2/b2 就是这三条的可检查形式）：
//   ① 只读——不联网、不写文件、不触发刷新；② 不调 loadPricing/loadDailyUsage（前者联网+spawn，后者在
//   账本损坏时会改名隔离 = 写操作）；③ 退出码恒 0（它是手动命令，不该让 hook/CI 变红）。
{
  const src26 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  const body26 = (() => {
    const i = src26.indexOf('function doctorTxt');
    if (i < 0) return '';
    const j = src26.indexOf('\nfunction ', i + 1);
    return src26.slice(i, j < 0 ? src26.length : j);
  })();
  ok('T26-a0 ★--doctor 存在且有 CLI 入口', body26.length > 0 && src26.includes("process.argv.includes('--doctor')"));
  ok('T26-a1 ★doctorTxt 内不得调用 loadPricing()（它会触发联网刷新 + detach spawn）',
    body26.length > 0 && !body26.includes('loadPricing('), '红 = 体检命令产生了副作用');
  ok('T26-a2 ★doctorTxt 内不得调用 loadDailyUsage()（账本损坏时它会改名隔离 = 写操作）',
    body26.length > 0 && !body26.includes('loadDailyUsage('));

  // 运行态：隔离环境下调用 doctorTxt()，前后目录指纹必须完全一致
  const savedEnv26 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let mod26 = null;
  try { mod26 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod26 = null; }
  const snap26 = () => {
    const out = [];
    const walk = (d) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { try { const st = fs.statSync(p); out.push(p + '|' + st.size + '|' + st.mtimeMs); } catch (e2) { out.push(p + '|err'); } }
      }
    };
    walk(tmp);
    return out.sort().join('\n');
  };
  if (!mod26 || typeof mod26.doctorTxt !== 'function') {
    ok('T26 模块加载', false, mod26 ? '缺少 doctorTxt 导出' : 'require 失败');
  } else {
    const before26 = snap26();
    let txt26 = '', threw26 = '';
    try { txt26 = mod26.doctorTxt(); } catch (e) { threw26 = String(e && e.message); }
    const after26 = snap26();
    ok('T26-b1 doctorTxt() 不抛异常且输出 7 个体检段落',
      !threw26 && ['账本', '状态文件', '价库', '假日', 'hooks', '日志', '版本'].every((t) => txt26.includes('[' + t + ']')),
      threw26 ? ('抛了：' + threw26) : txt26.split('\n')[1]);
    ok('T26-b2 ★只读：调用前后隔离目录内所有文件的尺寸/mtime 完全一致（体检=体检，零写入）',
      before26 === after26, before26 === after26 ? `已核对 ${before26.split('\n').length} 个文件` : '有文件被改动');
  }
  if (savedEnv26 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv26;
}

// ===== T27：v3.33.0 第四轮审计——补-S5 toast 诊断日志的明文声明与截断 =====
// 病根：`writeToastLog` 把**弹窗完整文案**（toastText）以明文写进 `~/.workbuddy/token-tracker-toast.log`，
//   而文档原先只声明"诊断日志含 sessionId 与 transcript 末行指纹"——读者会以为日志里没有可读文本。
// 实测裁决（本机 1779 条真实记录全字段扫描）：toastText 只含 模型名/耗时/输入·输出·缓存 token 数/金额/
//   缓存命中率/价格标注，**不含用户消息正文、文件路径、对话内容**；长度 p50=69 / p90=76 / max=87，
//   **恰好触顶 200 的 0 条 → 从未发生截断**（cap = 实测最大值的 2.3 倍）。
// 故处置 = **声明**（README 本地落盘表 + CHANGELOG 隐私章节 + 源码注释写明依据），cap 保留不动。
// 审计原话把它与 rounds 的「用户消息前 40 字明文」并列 —— 实为两类数据，后者才真的含用户文本。
// 下面 a1/a2/a3 锁"声明与截断不被静默删除"，b1/b2 锁"截断行为本身"。
{
  const raw27 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const src27 = stripComments(raw27);
  const iW = raw27.indexOf('function writeToastLog');
  const jW = iW < 0 ? -1 : raw27.indexOf('\nfunction ', iW + 1);
  const bodyRaw27 = iW < 0 ? '' : raw27.slice(iW, jW < 0 ? raw27.length : jW);
  ok('T27-a1 ★toastText 仍截断至 200（去掉它 = 日志随文案无上限膨胀）',
    /toastText:\s*st\.toastText\s*!=\s*null\s*\?\s*String\(st\.toastText\)\.slice\(0,\s*200\)/.test(src27),
    '未匹配到 slice(0, 200)');
  ok('T27-a2 ★writeToastLog 内保留声明性注释（只写本地 / 从未截断 的依据，防被静默删除）',
    bodyRaw27.includes('只写本地') && bodyRaw27.includes('从未发生截断'),
    iW < 0 ? '函数未找到' : '红 = 补-S5 的声明注释被删掉了');
  ok('T27-a3 ★文档如实声明该日志：README 本地落盘表出现文件名 + CHANGELOG 隐私章节点名 toastText',
    fs.readFileSync(path.join(SRC, 'README.md'), 'utf-8').includes('token-tracker-toast.log')
    && fs.readFileSync(path.join(SRC, 'CHANGELOG.md'), 'utf-8').includes('toastText'));

  // 运行态：真调 showToast（临时打 NO_TOAST 开关 → 只写日志、不弹系统通知），核对落盘文案的长度契约。
  //   注意 in-process 的 NO_TOAST 默认**未设**（只有 spawn 子进程的 env 里设了），故此处必须自行开关 ——
  //   否则在真机上跑 selftest 会真的弹出一个系统通知（违反"测试禁止真弹窗"硬规矩）。
  const savedEnv27 = process.env.WB_ROOT;
  const savedNoToast27 = process.env.TOKEN_TRACKER_NO_TOAST;
  process.env.WB_ROOT = tmp;
  process.env.TOKEN_TRACKER_NO_TOAST = '1';
  let mod27 = null;
  try { mod27 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod27 = null; }
  const logPath27 = path.join(tmp, 'token-tracker-toast.log');
  if (!mod27 || typeof mod27.showToast !== 'function') {
    ok('T27 模块加载', false, mod27 ? '缺少 showToast 导出' : 'require 失败');
  } else {
    const readLast27 = () => {
      try {
        const ls = fs.readFileSync(logPath27, 'utf-8').split('\n').filter(Boolean);
        return ls.length ? JSON.parse(ls[ls.length - 1]) : null;
      } catch (e) { return null; }
    };
    let threw27 = '';
    try { mod27.showToast('A'.repeat(300), 'B', 't27-long'); } catch (e) { threw27 = String(e && e.message); }
    const long27 = readLast27();
    ok('T27-b1 ★超长文案落盘后被截到恰好 200 字符（日志膨胀的行为契约）',
      !threw27 && long27 && long27.toastText === 'A'.repeat(200),
      threw27 ? ('抛了：' + threw27) : (long27 && long27.toastText ? ('落盘长度=' + long27.toastText.length) : '日志未写入'));
    let threw27b = '';
    try { mod27.showToast('短文案', 'B', 't27-short'); } catch (e) { threw27b = String(e && e.message); }
    const short27 = readLast27();
    ok('T27-b2 未超 200 的文案原样落盘（line1 + " | " + line2，一字不改）',
      !threw27b && short27 && short27.toastText === '短文案 | B',
      threw27b ? ('抛了：' + threw27b) : (short27 ? JSON.stringify(short27.toastText) : '日志未写入'));
  }
  if (savedEnv27 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv27;
  if (savedNoToast27 === undefined) delete process.env.TOKEN_TRACKER_NO_TOAST;
  else process.env.TOKEN_TRACKER_NO_TOAST = savedNoToast27;
}

// ===== T28：v3.33.0 第四轮审计——A2 已 lock 条目的歧义告警不再挂弹窗 =====
// 病根：`m.lock === true` 的模型，三个写价分支**全部跳过**（CN 812 / US 843），即模糊匹配的结果
//   根本没被采用；但 looseFind 仍把「唯一模糊命中…需人工核验」写进 `_ambig_warnings`，而该字段被
//   priceAuditTag 直接翻成弹窗标签「⚠价核验」→ lock 不会自己消失，告警也就**永不消失** = 永久误报。
// 本机实测（真实联网刷新，双臂隔离 A/B，见 plan §7）：17 模型 / 6 个 lock 条目，其中 4 个 lock 条目
//   （含用户日常追踪的 hy4-preview、glm-5.3-flash）贡献了 10 条告警里的 **6 条**。
// 处置（沿用同文件 A-7 对 `_retired_locked` 的既有先例：独立字段 + stderr，刻意不进驱动弹窗的字段）：
//   lock 条目（且 region≠US —— US 的 `usd_*` 参考字段在分支之前就会被写，匹配结果**仍被消费**）
//   的告警落入 `_ambig_warnings_locked`：不上弹窗，但 `--doctor` 可见 → 消除误报 ≠ 隐藏信息。
// a1/a2 锁"判据与调用点"，a3 锁"信息不丢"，b1/b2 锁告警路由，b3 锁**返回值一字不改**（本次只动路由）。
{
  const src28 = stripComments(fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T28-a1 ★lock 判据同时排除 region=US（US 的 usd_* 在分支前就被写 → 匹配仍被消费，不该静音）',
    /const\s+isLocked\s*=\s*m\.lock\s*===\s*true\s*&&\s*m\.region\s*!==\s*'US'/.test(src28),
    '未匹配到 isLocked 判据');
  const nCn28 = (src28.match(/cnFind\([^)]*isLocked\)/g) || []).length;
  const nUsd28 = (src28.match(/usdFind\([^)]*isLocked\)/g) || []).length;
  ok('T28-a2 ★全部查找调用点都传了 isLocked（cnFind 2 处 / usdFind 3 处）',
    nCn28 === 2 && nUsd28 === 3, `cnFind=${nCn28} usdFind=${nUsd28}`);
  ok('T28-a3 ★lock 告警落独立字段（不删信息）且 --doctor 能读到（消除误报 ≠ 隐藏信息）',
    src28.includes('pricing._ambig_warnings_locked = [...AMBIG_WARNINGS_LOCKED]')
    && stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8')).includes('_ambig_warnings_locked'));

  // 运行态：直接单测 looseFind（纯函数、无副作用、不联网）
  const savedEnv28 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let rp28 = null;
  try { rp28 = require(path.join(skillDir, 'refresh-prices.js')); } catch (e) { rp28 = null; }
  if (!rp28 || typeof rp28.looseFind !== 'function') {
    ok('T28 模块加载', false, rp28 ? '缺少 looseFind 导出' : 'require 失败');
  } else {
    // 造"子串撞名"场景：查 glm-5.3-flash（归一化 glm53flash），索引里只有 z-ai/glm-5.3-flashx
    //   （归一化 zaiglm53flashx）→ 唯一模糊命中且与被查键不同名 → 必然产生一条告警
    const idx28 = { 'z-ai/glm-5.3-flashx': { in: 1, out: 2 } };
    const qn28 = rp28.norm('glm-5.3-flash');
    const n028 = rp28.AMBIG_WARNINGS.size, l028 = rp28.AMBIG_WARNINGS_LOCKED.size;
    let rN28 = null, rL28 = null, threw28 = '';
    try {
      rN28 = rp28.looseFind(idx28, qn28, '国内源', 'glm-5.3-flash', false);
      rL28 = rp28.looseFind(idx28, qn28, '国内源', 'glm-5.3-flash', true);
    } catch (e) { threw28 = String(e && e.message); }
    const dN28 = rp28.AMBIG_WARNINGS.size - n028;
    const dL28 = rp28.AMBIG_WARNINGS_LOCKED.size - l028;
    ok('T28-b1 ★未锁条目：告警进 _ambig_warnings（对照组，原行为不变）', !threw28 && dN28 === 1, threw28 || `新增 ${dN28} 条`);
    ok('T28-b2 ★已锁条目：告警**不进** _ambig_warnings（dN 仍=1，只来自未锁那次）、改记 _ambig_warnings_locked',
      !threw28 && dL28 === 1 && dN28 === 1, threw28 || `_ambig_warnings 共新增 ${dN28} 条、locked 新增 ${dL28} 条`);
    ok('T28-b3 ★返回值一字不改（本次只动告警路由，绝不动匹配结果与价格）',
      !threw28 && rN28 === rL28 && !!rN28 && rN28.in === 1,
      `normal=${JSON.stringify(rN28)} locked=${JSON.stringify(rL28)}`);
  }
  if (savedEnv28 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv28;
}

// ===== T29：v3.33.0 第四轮审计——A5 timestamp 口径统一（防静默丢账） =====
// 病根：记账的两个"孪生"入口（弹窗聚合 `aggregateTranscLines` / 账本 `perModelFromRows`，注释自称
//   "完全一致的去重口径"）用 `typeof ts === 'number'` **硬判**——平台若把 timestamp 换成数字字符串，
//   整行用量被**静默丢弃**（该行明明有 usage，账本却少记），零提示；而本文件其他 10+ 处早就用
//   `Number(...)` 强制转换。同一字段两种判据 = 迟早分叉。
// **实测裁决（诚实声明）**：310 份真实 transcript、抽样 34,960 行 → timestamp **100% 为 number**，
//   含 usage 的 8,987 行无一例外 ⇒ **该缺陷从未在真实数据上触发，属潜伏型**。本次修的不是"不存在的
//   场景"，而是（a）统一口径、（b）把将来的静默丢账改成有痕。
// 零噪音（本项最关键）：40 份最大的真实 transcript 上一一跑 aggregateTranscript + perModelFromRows，
//   HEAD vs WORK 输出**逐字节一致（27,172 字节）**——因为 Number() 作用于 number 是恒等变换。
// a1/a2 锁口径统一与不可回退，b1-b4 锁行为（含 null/''/ISO 语义**不变**）。
{
  const src29 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T29-a1 ★两个记账入口都改走 numTs（不再各自硬判 typeof）',
    (src29.match(/const ts = numTs\(r\.timestamp\);/g) || []).length === 2,
    'numTs 调用点数=' + (src29.match(/const ts = numTs\(r\.timestamp\);/g) || []).length + '（应为 2）');
  ok('T29-a2 ★记账入口内不得再出现 `typeof ts === \'number\'` 硬判（防回退）',
    !/if \(!\(typeof ts === 'number'\) \|\| ts <= fromTs\) continue;/.test(src29));
  ok('T29-a3 ★决策类站点未被顺手改动（hasTeamActivity / hasNewTranscSince 仍保守硬判）',
    /if \(!\(typeof ts === 'number'\) \|\| ts <= roundStartMs\) continue;/.test(src29)
    && /if \(typeof ts === 'number' && ts > roundStartMs && ts > sinceMs/.test(src29));

  const savedEnv29 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let mod29 = null;
  try { mod29 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod29 = null; }
  if (!mod29 || typeof mod29.numTs !== 'function') {
    ok('T29 模块加载', false, mod29 ? '缺少 numTs 导出' : 'require 失败');
  } else {
    const N = mod29.numTs;
    ok('T29-b1 numTs 对 number 是恒等变换（零噪音的根因）',
      N(1759600000000) === 1759600000000 && N(0) === 0 && Object.is(N(-1), -1),
      `${N(1759600000000)} / ${N(0)}`);
    ok('T29-b2 ★数字字符串被正确解析（本次修复点：HEAD 会整行丢弃）',
      N('1759600000000') === 1759600000000 && N('123') === 123);
    ok('T29-b3 ★null / undefined / 空串 / ISO 串仍返回 NaN（不因 Number(null)===0 被放行，原语义不变）',
      [null, undefined, '', '2026-10-05T12:00:00.000Z'].every((v) => Number.isNaN(N(v))),
      [null, undefined, '', 'iso'].map((v) => String(N(v))).join(' / '));
    // 端到端（账本入口）：同一批行，timestamp 用数字字符串 → 必须被计入
    const rowsNum = [
      { type: 'message', role: 'assistant', timestamp: 1759600000000, id: 'a1', providerData: { model: 'hy3', usage: { inputTokens: 1000, outputTokens: 100 } } },
      { type: 'message', role: 'assistant', timestamp: 1759600100000, id: 'a2', providerData: { model: 'hy3', usage: { inputTokens: 2000, outputTokens: 200 } } },
    ];
    const rowsStr = rowsNum.map((r) => Object.assign({}, r, { timestamp: String(r.timestamp) }));
    const sum = (rows) => { const m = mod29.perModelFromRows(rows, 0); return Object.values(m).reduce((s, b) => s + b.total, 0); };
    let threw29 = '';
    let sNum = 0, sStr = 0, sNull = 0;
    try { sNum = sum(rowsNum); sStr = sum(rowsStr); sNull = sum(rowsNum.map((r) => Object.assign({}, r, { timestamp: null }))); }
    catch (e) { threw29 = String(e && e.message); }
    ok('T29-b4 ★账本入口：数字字符串 timestamp 的整行用量不再被丢弃（HEAD=0，现=3300）',
      !threw29 && sStr === 3300 && sNum === 3300 && sNull === 0,
      threw29 || `num=${sNum} str=${sStr} null=${sNull}`);
  }
  if (savedEnv29 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv29;
}

// ===== T30：v3.33.0 第四轮审计——B 系列：`--report summary --csv` 补出口 =====
// 病根：`summary` 是**唯一**没有 CSV 出口的 `--report` 入口。实测 `--report summary --csv` 得到
//   「无法识别的参数：summary」——合法参数被判成非法，而且**那句错误文案自己就漏列了 summary**
//   （原文案只有 week / month / <起>..<止> / all / <日期> / forecast）→ 用户敲对命令反被误导，
//   而其他所有 `--report` 形态（今天 / all / 单日 / 区间 / forecast）都早已有 CSV 出口。
// 处置：新增 `exportSummaryCsv()` + CLI 分支 `summary|totals --csv`（totals 是同一入口的别名，
//   行为必须一致）+ 补全错误文案。
// 口径：与文本版 `reportSummaryTxt` 同口径——每天一行、只出总合计（不出模型明细）、末尾 ALL 合计；
//   多出 `no_price_models` / `unpriced_models` 两列（**模型个数**），否则 Excel 里那个金额会被当成
//   完整金额（与文本版那两行 `⚠` 同义：合计只含已知部分）。两处计数滤条件刻意逐字对齐文本版，
//   而**不**改用 `costCellKind`——后者在"两个标记同时置位"时只归一类，与文本版把同一模型计入两栏不一致。
// 一处**刻意**差异（权衡过，不是遗漏）：请求的日期不在账本里时，文本版打「（无记录）」，
//   这里打**整行空白**而不是数值 0——0 会被读成"那天零用量/免费"，与"没有这天的记录"是两回事。
//   实测 `summary all` 只遍历账本里已有的日期，永不产生这种行；只有显式点一个账本外的日期才命中，
//   且空白行对 ALL 合计的贡献恰为 0（口径正确）。
// a1-a4 锁源码结构（出口函数 / CLI 分支 / 错误文案 / 空白行），b1-b5 锁行为。
{
  const src30 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T30-a1 ★存在 exportSummaryCsv（此前 summary 是唯一没有 CSV 出口的 --report 形态）',
    /function exportSummaryCsv\(arg\) \{/.test(src30));
  ok('T30-a2 ★CLI 分支：summary|totals 走 CSV 出口，且取 pos[1] 作为子参数（别名行为必须一致）',
    /if \(wantCsv && \(rArg === 'summary' \|\| rArg === 'totals'\)\) \{/.test(src30)
    && /exportSummaryCsv\(pos\[1\] \|\| ''\)/.test(src30));
  ok('T30-a3 ★错误文案补全 summary（原文案"可用"列表自己就漏列了这个合法参数）',
    /可用：week \/ month \/ <起>\.\.<止> \/ all \/ <日期> \/ summary \[all\|<日期>\] \/ forecast/.test(src30));
  ok('T30-a4 ★账本外日期写整行空白而非 0（0 会被读成"零用量/免费"，与"无记录"不是一回事）',
    /if \(!day\) \{ rows\.push\(\[date, '', '', '', '', '', '', ''\]\.join\(','\)\); continue; \}/.test(src30));

  const savedEnv30 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  const ledgerPath30 = path.join(skillDir, 'daily-usage.json');
  const savedLedger30 = fs.existsSync(ledgerPath30) ? fs.readFileSync(ledgerPath30, 'utf-8') : null;
  let mod30 = null;
  try { mod30 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod30 = null; }
  if (!mod30 || typeof mod30.exportSummaryCsv !== 'function') {
    ok('T30 模块加载', false, mod30 ? '缺少 exportSummaryCsv 导出' : 'require 失败');
  } else {
    const readExport30 = (msg) => {
      const f = (String(msg).match(/已导出：(.+?)（/) || [])[1] || '';
      return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').replace(/^\uFEFF/, '') : '';
    };
    try {
      fs.writeFileSync(ledgerPath30, JSON.stringify({
        '2026-10-04': {
          models: { hy3: { in: 1000, out: 200, cached: 0, total: 1200, cost: 0.01 }, 'space-bunny': { in: 50, out: 10, cached: 0, total: 60, cost: 0, no_price: true } },
          total: { in: 1050, out: 210, cached: 0, total: 1260, cost: 0.01 },
        },
        '2026-10-05': {
          models: { hy3: { in: 2000, out: 400, cached: 1000, total: 3400, cost: 0.02 }, 'some-unpriced': { in: 100, out: 20, cached: 0, total: 120, cost: 0, unpriced: true } },
          total: { in: 2100, out: 420, cached: 1000, total: 3520, cost: 0.02 },
        },
      }), 'utf-8');
      const snap30 = fs.readFileSync(ledgerPath30, 'utf-8');
      const lines30 = readExport30(mod30.exportSummaryCsv('all')).split('\n').filter(Boolean);
      ok('T30-b1 ★summary all --csv：表头 + 每天一行 + ALL，数字/计数与文本版同口径（含 UTF-8 BOM）',
        lines30.length === 4
        && lines30[0] === 'date,in,out,cached,total,cost_api_equiv,no_price_models,unpriced_models'
        && lines30[1] === '2026-10-04,1050,210,0,1260,0.010000,1,0'
        && lines30[2] === '2026-10-05,2100,420,1000,3520,0.020000,0,1'
        && lines30[3] === 'ALL,3150,630,1000,4780,0.030000,,',
        `行数=${lines30.length} 首行=${String(lines30[1]).slice(0, 40)}`);
      const one30 = readExport30(mod30.exportSummaryCsv('2026-10-04')).split('\n').filter(Boolean);
      ok('T30-b2 ★指定单日：只出该日 + ALL（ALL 与当日相同），不掺别的日期',
        one30.length === 3 && one30[1] === '2026-10-04,1050,210,0,1260,0.010000,1,0'
        && one30[2] === 'ALL,1050,210,0,1260,0.010000,,',
        JSON.stringify(one30.slice(1)));
      const miss30 = readExport30(mod30.exportSummaryCsv('2020-01-01')).split('\n').filter(Boolean);
      ok('T30-b3 ★账本外日期：该行整行空白（不是 0），ALL 仍为真 0 —— 不把"无记录"伪装成"零用量"',
        miss30.length === 3 && miss30[1] === '2020-01-01,,,,,,,' && miss30[2] === 'ALL,0,0,0,0,0.000000,,',
        JSON.stringify(miss30.slice(1)));
      ok('T30-b4 ★导出是只读操作：跑完 3 次导出（all / 单日 / 账本外日期）后账本文件逐字节不变',
        fs.readFileSync(ledgerPath30, 'utf-8') === snap30);
      fs.writeFileSync(ledgerPath30, '{}', 'utf-8');
      ok('T30-b5 ★空账本 summary all --csv：与文本版同句「账本为空」，不给一份只有表头的空 CSV',
        mod30.exportSummaryCsv('all') === '账本为空（暂无可导出数据）');
    } catch (e) {
      ok('T30 行为用例', false, String(e && e.message));
    }
    if (savedLedger30 === null) { try { fs.unlinkSync(ledgerPath30); } catch (e) { /* 无则忽略 */ } }
    else { try { fs.writeFileSync(ledgerPath30, savedLedger30, 'utf-8'); } catch (e) { /* 恢复失败留给后续用例 */ } }
  }
  if (savedEnv30 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv30;
}

// ===== T31：v3.33.0 第四轮审计 B 系列——轮次标签的注入白名单收敛 + 明文落盘声明 + .bak 有界保留 =====
// 病根（同一病根多处打补丁的又一例）：注入型 user 行的正则被**抄成两遍**（roundLabel / inferRoundStartFromText）。
//   实测代价：本机 `rounds-2026-10.jsonl` 219 条里 **32 条**的 label 是 `<teammate-message teammate_id=…`
//   开头 40 字符——白名单漏了 teammate-message，"这轮在干什么"的标签变成一段 XML。
// 处置：收敛为单一定义 `injectionTagOf(txt, tags)` + 两张**刻意不同**的白名单：
//   宽表（roundLabel：纯展示改写，无副作用）含 teammate-message；窄表（轮起点推断）**不含**——
//   那里返回 0 会让 6041 的 `roundStart0 > 0` 不成立 → 整轮记账被跳过（S1 类静默丢账），
//   团队模式下 user 行可能全是队友消息，排除它 = 丢账。a1-a3 锁结构，b1-b3 锁行为（含"不许回退"）。
// 另：`roundLabel` 是本技能**唯一**会把用户自己敲的话落盘的地方（前 40 字符，本地明文，随 rounds 保留
//   6 个月），已加源码声明 + README/CHANGELOG 声明（b4 锁声明不得被静默删除）。
{
  const src31 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T31-a1 ★注入白名单收敛为单一定义：源码里只剩一处标签字面量清单（旧的两份内联正则已删）',
    (src31.match(/task-notification\|conversation_history_summary/g) || []).length === 0
    && /const INJECTION_TAGS_ALL = \[/.test(src31)
    && (src31.match(/injectionTagOf\(/g) || []).length >= 3);
  ok('T31-a2 ★宽表含 teammate-message、窄表**不含**（轮起点推断返回 0 = 丢账，宁可取偏晚起点）',
    /const INJECTION_TAGS_ALL = \[[^\]]*'teammate-message'[^\]]*\]/.test(src31)
    && /const INJECTION_TAGS_NOT_SUBMIT = \[[^\]]*\]/.test(src31)
    && !/const INJECTION_TAGS_NOT_SUBMIT = \[[^\]]*'teammate-message'/.test(src31));
  // 注意：a3/b5 断言的是**注释本身的存在**（防后人删掉约束说明），故必须对**未剥注释**的原文匹配。
  const raw31 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  ok('T31-a3 ★两句"不许顺手统一"的约束注释仍在（防后人把两张表合成一张）',
    /禁止"顺手统一"/.test(raw31)
    && /整轮记账被跳过/.test(raw31));
  ok('T31-a4 ★backfill 的 .bak 有界保留：只清本工具自己的前缀（严格 basename 前缀），不是通配删除',
    /const KEEP_BAK = 5;/.test(stripComments(fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n')))
    && /\.map\(\(b\) => b \+ '\.bak-backfill-'\)/.test(stripComments(fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n'))));

  const savedEnv31 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let mod31 = null;
  try { mod31 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod31 = null; }
  if (!mod31 || typeof mod31.roundLabel !== 'function' || typeof mod31.inferRoundStartFromText !== 'function') {
    ok('T31 模块加载', false, mod31 ? '缺少 roundLabel / inferRoundStartFromText 导出' : 'require 失败');
  } else {
    const transc31 = path.join(tmp, 't31-transc.jsonl');
    const line = (role, ts, content) => JSON.stringify({ type: 'message', role, timestamp: ts, content }) + '\n';
    try {
      // 场景：真实提问（ts=1000，早于本轮起点）→ 队友消息（ts=3000，本轮内）
      fs.writeFileSync(transc31,
        line('user', 1000, '上一条真实提问')
        + line('assistant', 2000, 'ok')
        + line('user', 3000, '<teammate-message teammate_id="system" summary="s">hi</teammate-message>'), 'utf-8');
      ok('T31-b1 ★teammate-message 不再被当成用户的话当标签（旧行为：label = `<teammate-message teammate_id="s`）',
        mod31.roundLabel(transc31, 2500) === '[注入] teammate-message',
        JSON.stringify(mod31.roundLabel(transc31, 2500)));
      // 真实提问（本轮内）仍要被当标签，且截到 ROUND_LABEL_MAX(40)
      const long31 = 'P'.repeat(60);
      fs.writeFileSync(transc31,
        line('assistant', 2000, 'ok') + line('user', 3000, long31), 'utf-8');
      const lb31 = mod31.roundLabel(transc31, 2500);
      ok('T31-b2 真实用户提问仍取前 40 字符作标签（该功能与截断长度都不得被顺手改掉）',
        lb31 === 'P'.repeat(40) && lb31.length === 40, `len=${lb31.length}`);
      // 轮起点推断：**只有**队友消息时也必须给非 0（否则 6041 整轮记账被跳过 = 丢账）
      fs.writeFileSync(transc31,
        line('user', 1000, '真实提问') + line('user', 3000, '<teammate-message teammate_id="a">x</teammate-message>'), 'utf-8');
      ok('T31-b3 ★轮起点推断：整段只有队友消息时仍返回非 0（保守取偏晚起点，绝不因"排除注入"而归 0 丢账）',
        mod31.inferRoundStartFromText(transc31) === 3000,
        String(mod31.inferRoundStartFromText(transc31)));
      // 有真实提问时优先真实提问（窄表排除项不含 teammate-message，故取最后一条 user 行）
      fs.writeFileSync(transc31,
        line('user', 2000, '真实提问') + line('user', 3000, '<teammate-message teammate_id="a">x</teammate-message>'), 'utf-8');
      ok('T31-b4 轮起点推断对已有行为零变化：仍取尾部最后一条 user 行（本项只动标签、不动起点）',
        mod31.inferRoundStartFromText(transc31) === 3000);
      ok('T31-b5 ★明文落盘处有源码声明（说明这是唯一一处存用户原话的地方、40 字、本地、6 个月清理）',
        /唯一一处会把用户自己敲的话落盘的地方/.test(raw31));
      try { fs.unlinkSync(transc31); } catch (e) { /* 清理失败留给收尾 rmSync */ }
    } catch (e) {
      ok('T31 行为用例', false, String(e && e.message));
    }
  }
  if (savedEnv31 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv31;
}

// ===== T32：v3.33.0 瘦身①——头注释版本日记迁出（防回涨） =====
// 病根：`token-tracker.js` 头部曾是 CHANGELOG 的逐版镜像（v2.61 … v3.32.1 共 254 行），
//   **永不参与运行**却常驻文件头——任何人/模型读这个文件都要先越过两百多行历史。
//   与 SKILL.md v3.23.0 那次瘦身是同一个病根：把"历史"当"上下文"。
// 处置：整段迁到 `docs/version-diary.md`（默认不加载），头部只留参与运行/供人定位的内容
//   （版本号行 + 用法 + 轮次语义 + 测试开关）。实测 6710 → 6463 行（净 −247；含新增的 7 行迁出说明）。
// a1 是**防回涨**守卫（不带上限的话，下一个人继续在头部堆版本要点，一年后又回到 250 行）。
{
  const raw32 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const ls32 = raw32.split('\n');
  const iFirstCode = ls32.findIndex((l) => /^const fs = require\('fs'\);/.test(l));
  // 上限 80 行：迁出前是 279 行。**真正的判据不是行数，而是"头注释里有没有版本日记"**——
  //   行数上限只是兜底（运行/约定类说明多写几行不算病，反倒是好事）。所以另加一道直接判据：
  //   头注释里形如 `// v3.xx` 的**逐版要点行**不得 > 2（迁移后为 0）。
  const headLines = ls32.slice(0, iFirstCode);
  const diaryLines = headLines.filter((l) => /^\/\/ v\d+\.\d+/.test(l)).length;
  ok('T32-a1 ★头注释区不得回涨（≤80 行；迁出前是 279 行）—— 防"历史当上下文"复发',
    iFirstCode >= 0 && iFirstCode <= 80, `头注释 ${iFirstCode} 行（应为 1..80）`);
  ok('T32-a1b ★头注释里不得再出现逐版要点行（`// vX.Y` ≤2 行；这是"版本日记"的直接判据）',
    diaryLines <= 2, `实测 ${diaryLines} 行`);
  ok('T32-a2 ★版本号行仍在头部（T12-i4 的锚点，迁出时最容易顺手删掉）',
    /^\/\/ token-usage-tracker v\d/.test(ls32[1] || ''));
  const diaryPath = path.join(SRC, 'docs', 'version-diary.md');
  const hasDiary = fs.existsSync(diaryPath);
  const diary = hasDiary ? fs.readFileSync(diaryPath, 'utf-8') : '';
  ok('T32-a3 ★迁出件真实存在且**两端齐全**（不是"删掉了事"：v2.61 与 v3.32.1 都在）',
    hasDiary && diary.indexOf('v2.61') >= 0 && diary.indexOf('v3.32.1') >= 0
    && diary.split('\n').length > 200,
    hasDiary ? `${diary.split('\n').length} 行` : 'docs/version-diary.md 不存在');
  ok('T32-a4 头部保留迁出说明（指出权威记录是 CHANGELOG.md，避免读者以为历史被丢失）',
    /已迁出本文件/.test(raw32) && /以 CHANGELOG\.md 为准/.test(raw32));
  // a5：**推送白名单缺口**守卫。docs/ 整目录被 .gitignore 屏蔽（只放行 3 个公开 md）——
  //   迁出件若忘了加 `!` 例外，本地测试全绿、GitHub 用户却拿到一个指向不存在文件的指路牌
  //   （T32-a3 只查本地存在，天然查不出"推送时被忽略"）。这类"本地绿、分发缺"的缺口
  //   正是 v3.32.1 CI 红那类问题的同族，故单列一条。
  const gi32 = fs.existsSync(path.join(SRC, '.gitignore')) ? fs.readFileSync(path.join(SRC, '.gitignore'), 'utf-8') : '';
  ok('T32-a5 ★docs/version-diary.md 必须在 .gitignore 里被显式放行（本地存在 ≠ 会推送到 GitHub）',
    /^!docs\/version-diary\.md\s*$/m.test(gi32), gi32 ? '未找到例外行' : '.gitignore 不存在');
}

// ===== T33：v3.33.0 瘦身②——裸 catch 白名单化（防"顺手吞错"） =====
// 病根：全仓 36 处 `catch (x) {}`（审计报 34，实测 36——报告数字也不准）。它们**不是**都该修：
//   toast/诊断/清理失败的静默本来就是正确设计（给它们加日志 = 把噪音写进日志本身，
//   而且这些路径每次运行都走到）。真问题是对读者/复审者而言，"刻意静默"与"忘了写处理"
//   **长得一模一样**，无法据此判断哪一处是缺陷。
// 处置：不改行为，改为**可核对**——全仓裸 catch 行尾必须带 `// silent-ok:<类别> — <理由>`，
//   类别仅允许 诊断 / 清理 / 探测 / 降级 四种（约定写在 token-tracker.js 头部）。
//   T33 就是那条守卫：新增一处没写理由的裸 catch → 直接红。**这是把"约定"变成"约束"的那一步。**
{
  const FILES33 = ['token-tracker.js', 'backfill.js', 'recalc-day.js', 'refresh-holidays.js', 'refresh-prices.js', 'selftest.js'];
  const BARE33 = /catch \([a-z_]+\)\s*\{\}/;
  const KINDS33 = ['诊断', '清理', '探测', '降级'];
  let nAll = 0, nBad = 0, nKind = 0;
  const badSamples = [];
  for (const f of FILES33) {
    const fp = path.join(SRC, f);
    if (!fs.existsSync(fp)) continue;
    const ls = fs.readFileSync(fp, 'utf-8').split('\n');
    for (let i = 0; i < ls.length; i++) {
      const ix = ls[i].search(BARE33);
      // 只认真代码里的裸 catch：`catch (x) {}` 出现在 `//` 之后的一律是在注释里被**引用**
      // （本守卫自己的约定注释就要引用它，否则会把自己数进去）。
      if (ix < 0) continue;
      const cmtAt = ls[i].indexOf('//');
      if (cmtAt >= 0 && cmtAt < ix) continue;
      nAll++;
      const m = /\/\/\s*silent-ok:(\S+)/.exec(ls[i]);
      if (!m) { nBad++; if (badSamples.length < 3) badSamples.push(`${f}:${i + 1}`); continue; }
      if (KINDS33.indexOf(m[1]) < 0) { nKind++; if (badSamples.length < 3) badSamples.push(`${f}:${i + 1}=${m[1]}`); }
    }
  }
  ok('T33-a1 ★裸 catch 总数与基线一致（36；新增/删除必须显式改这里，防"顺手吞一个错"）',
    nAll === 36, `实测 ${nAll} 处`);
  ok('T33-a2 ★每一处裸 catch 都带 silent-ok:<类别> — <理由>（无标记即红）',
    nBad === 0, nBad ? `${nBad} 处无标记：${badSamples.join(', ')}` : '');
  ok('T33-a3 ★类别必须落在白名单四类（诊断/清理/探测/降级）内——写个别的不算数',
    nKind === 0, badSamples.join(', '));
  ok('T33-a4 ★约定本身有出处（头部注释写清"不在这四类里的静默 = 缺陷"）',
    /静默 catch 约定/.test(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'))
    && /不在这四类里的静默 = 缺陷/.test(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8')));
}

// ===== T36：v3.34.0 A6/A7 —— 文档分发缺口泛化 + 防回涨守卫 =====
// A6 病根：T32-a5 只守 `docs/version-diary.md` 一个文件的 .gitignore 放行。而 `docs/*` 是
//   **整目录被屏蔽 + 逐个加 `!` 例外**的机制——每新增一个被 SKILL.md 指向的 docs 文件都要加例外，
//   否则"本地绿、分发缺"（用户拿到一份指向不存在文件的指路牌）。守一个 = 守不住下一个。
// A7 病根：v3.32.1 把主脚本 254 行版本日记迁走时，只给**主脚本**加了 T32-a1/a1b 防回涨；
//   SKILL.md 的同类问题（堆 6 个历史版本要点块 = 19% 体积的陈旧常驻上下文）**没有任何守卫**
//   → 下次改版本时又会顺手往里堆。这里补上，且照 T32 的双层做法：直接判据 + 体积代理。
{
  const raw36 = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf-8');
  const refs36 = [...new Set((raw36.match(/`([A-Za-z0-9_][A-Za-z0-9_./-]*\.md)`/g) || [])
    .map((s) => s.slice(1, -1))
    .filter((f) => f !== 'SKILL.md'))].sort();
  const gi36 = fs.existsSync(path.join(SRC, '.gitignore')) ? fs.readFileSync(path.join(SRC, '.gitignore'), 'utf-8') : '';
  const underDocs = refs36.filter((f) => f.startsWith('docs/'));
  const esc36 = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noExcept = underDocs.filter((f) => !new RegExp(`^!${esc36(f)}\\s*$`, 'm').test(gi36));
  ok('T36-a1 ★SKILL.md 指向的 docs/ 文件**逐个**在 .gitignore 里显式放行（泛化 T32-a5）',
    underDocs.length > 0 && noExcept.length === 0,
    `已核对 ${underDocs.length} 个：${underDocs.join(', ')}${noExcept.length ? `；缺例外：${noExcept.join(', ')}` : ''}`);
  ok('T36-a2 ★docs/ 整目录仍被屏蔽 + 逐个放行（确认机制没被"顺手放开整个 docs/"破坏）',
    /^docs\/\*\s*$/m.test(gi36) && !/^!docs\/\s*$/m.test(gi36), '红 = 整目录放开，以后新增文件都不再需要例外、守卫失效');

  // A7：防回涨（双层，照 T32-a1 + T32-a1b 的做法）
  const vLines36 = raw36.split('\n').filter((l) => /^>\s*\*\*v\d+\.\d+(\.\d+)?\s*要点/.test(l));
  ok('T36-b1 ★SKILL.md「版本要点」块 ≤2 行（**直接判据**：逐版历史归 CHANGELOG，不回堆本文件）',
    vLines36.length <= 2, `实测 ${vLines36.length} 行`);
  const bytes36 = Buffer.byteLength(raw36);
  ok('T36-b2 ★SKILL.md ≤48KB（**代理判据**：v3.34.0 由 61,371 B 瘦到 ~43.8KB，留 4KB 余量）',
    bytes36 <= 48 * 1024, `实测 ${bytes36} B（${(bytes36 / 1024).toFixed(1)} KB）`);
  ok('T36-b3 ★「逐版细节查 CHANGELOG」的指路牌仍在（只删内容不删导航 = 读者会以为历史丢了）',
    /逐版细节/.test(raw36) && raw36.includes('CHANGELOG.md'));
}

// ===== T34：v3.34.0 第五轮审计 P0-1 —— --hook 兜底补弹不得二次记账 =====
// 病根：`--hook` 的兜底补弹分支无条件调 `todayDisplay()` = `recordUsage()` + 读当日累计。
//   而 `recordUsage` **没有水位线去重**（水位线只在 incrementalRecord 里推进），于是
//   「Stop 端 transcript 块已记账 → watcher 被宿主收割 → 下次 --hook 兜底」这条真实链路上，
//   整轮用量被**记两遍**（账本虚高一倍且不可自愈）。
// 修复的两难（这也是必须同时锁住两端的原因）：
//   traces 兜底路径（拿不到 transcript、只靠 trace 文件）在 Stop 端**没有**记账，
//   它的 `recordUsage` 是**唯一**记账点 —— 一刀切改成"只显示"会让这些轮**永不入账**
//   （正是 v3.33.0 S1 刚修好的"双封死"原样复发）。故按 coalesce 元信息 alreadyRecorded 分岔。
{
  const src34 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T34-a1 ★writeCoalesce 支持 alreadyRecorded 标记（无此字段 → --hook 无法区分两条路径）',
    src34.includes('if (meta.alreadyRecorded === true) payload.alreadyRecorded = true;'));
  ok('T34-a2 ★transcript 路径（Stop 端已记账）写 coalesce 时必须带 alreadyRecorded: true',
    /traceFile, alreadyRecorded: true \}/.test(src34),
    '红 = 已记账的那条路径没打标记 → 重复记账复发');
  ok('T34-a3 ★--hook 兜底补弹按 alreadyRecorded 分岔（已记→只显示 / 未记→照旧记账）',
    src34.includes('const pendToday = (pendInfo && pendInfo.alreadyRecorded === true) ? todayUsageTxt() : todayDisplay(pendAgg, pricing);'),
    '红 = 要么是"整轮重复计费"，要么是"traces 兜底永不入账"');
  const nDisp34 = (src34.match(/todayDisplay\(/g) || []).length;
  ok('T34-a4 ★todayDisplay 调用点没有变多（定义 1 + 调用 1 = 2；修复不得靠新增记账路径实现）',
    nDisp34 === 2, `实际 ${nDisp34} 处（应为 2：定义 1 + 调用 1；导出行无括号不计）`);

  // ── 行为验证（真跑 --hook，看账本增量）──
  const savedEnv34 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let mod34 = null;
  try { mod34 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod34 = null; }
  if (!mod34) {
    ok('T34 模块加载', false, 'token-tracker.js require 失败');
  } else {
    const sid34 = 't34-sid';
    const coal34 = mod34.coalescePath(sid34);
    const ledger34 = path.join(skillDir, 'daily-usage.json');
    // tryUnlink/重置失败一律吞掉（T33 约定：裸 catch 必须带 silent-ok）——清理类失败不该让测试变红。
    const rm34 = (p) => { try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — 文件本就可能不存在 */ } };
    const resetLedger34 = () => { try { fs.writeFileSync(ledger34, JSON.stringify({})); } catch (e) { /* silent-ok:清理 — 写不进就按空账本继续 */ } };
    const todayIn34 = () => {
      try {
        const j = JSON.parse(fs.readFileSync(ledger34, 'utf-8'));
        const d = j[mod34.todayStr()];
        return d && d.total ? Number(d.total.in || 0) : 0;
      } catch (e) { return 0; }
    };
    rm34(coal34);

    // b1/b2：写入端——标记真的落盘；false/缺省时字段不出现（与旧格式逐字节一致 → 零兼容风险）
    mod34.writeCoalesce(sid34, { in: 1 }, { tsPath: 'x', roundStart: 0, alreadyRecorded: true });
    let ci34 = null;
    try { ci34 = JSON.parse(fs.readFileSync(coal34, 'utf-8')); } catch (e) { ci34 = null; }
    ok('T34-b1 ★alreadyRecorded:true 真的落进 coalesce 文件（--hook 靠它区分两条路径）',
      !!ci34 && ci34.alreadyRecorded === true, JSON.stringify(ci34).slice(0, 80));
    mod34.writeCoalesce(sid34, { in: 1 }, { tsPath: 'x', roundStart: 0, alreadyRecorded: false });
    const raw34b = (() => { try { return fs.readFileSync(coal34, 'utf-8'); } catch (e) { return ''; } })();
    ok('T34-b2 ★alreadyRecorded:false 不写字段（JSON 与旧格式完全一致 → 老版本读它不会误解）',
      raw34b.length > 0 && !raw34b.includes('alreadyRecorded'), raw34b.slice(0, 80));

    if (!SPAWN_OK) {
      envSkip('T34-b3 ★已记账路径：--hook 兜底补弹账本增量 0（旧行为 = 整轮重复计费）', SPAWN_SKIP_REASON);
      envSkip('T34-b4 ★traces 兜底路径：--hook 兜底补弹**仍必须记账**（增量 = 整轮用量）', SPAWN_SKIP_REASON);
    } else {
      const ts34 = path.join(tmp, 't34-transcript.jsonl');
      fs.writeFileSync(ts34, JSON.stringify({ type: 'message', role: 'user', timestamp: Date.now() - 2000, content: [{ type: 'text', text: 'hi' }] }) + '\n');
      // ⚠️ 夹具陷阱（v3.12 就踩过一次，排查花了很久）：**必须造一条有效 trace**。
      //   否则 --hook 会在「暂无 trace 数据」那条早退分支 return，根本走不到兜底补弹分支
      //   → b3 假绿（0 本来就是 0）、b4 假红（应记 5000 却得 0）。缺夹具的"补弹不触发"是假象，不是代码缺陷。
      const trDir34 = path.join(tmp, 'traces', '1000');
      fs.mkdirSync(trDir34, { recursive: true });
      fs.writeFileSync(path.join(trDir34, 'trace_1.json'), JSON.stringify({
        trace: {
          modelInfo: { models: [{ name: 'hy3' }], totalInputTokens: 100, totalOutputTokens: 50, totalCachedTokens: 10, totalTokens: 150 },
          duration: 1000, startedAt: new Date(Date.now() - 3000).toISOString(), endedAt: new Date(Date.now() - 2000).toISOString(),
        },
      }));
      const PAY34 = JSON.stringify({ session_id: sid34, transcript_path: ts34, cwd: tmp });
      const agg34 = { in: 5000, out: 500, cached: 0, total: 5500, model: 'hy3', durMs: 1000, subCount: 0, teamActive: false };
      const runHook34 = () => spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'],
        { input: PAY34, env, timeout: 60000, windowsHide: true });

      // b3：已记账（transcript 路径）→ 兜底补弹只显示、**账本增量必须为 0**
      resetLedger34();
      mod34.writeCoalesce(sid34, agg34, { tsPath: ts34, roundStart: 0, alreadyRecorded: true });
      const r34a = runHook34();
      const in34a = todayIn34();
      ok('T34-b3 ★已记账路径：--hook 兜底补弹账本增量 0（旧行为 = 整轮 5000 再记一遍）',
        r34a.status === 0 && in34a === 0,
        `exit=${r34a.status} 账本 in=${in34a}（v3.33.0 HEAD 实测 = 5000，即整轮被记两遍）`);

      // b4：未记账（traces 兜底路径）→ 兜底补弹**必须仍然记账**（这是它的唯一记账点）
      resetLedger34();
      mod34.writeCoalesce(sid34, agg34, { tsPath: ts34, roundStart: 0, alreadyRecorded: false });
      const r34b = runHook34();
      const in34b = todayIn34();
      ok('T34-b4 ★traces 兜底路径：--hook 兜底补弹**仍必须记账**（增量 = 整轮 5000）',
        r34b.status === 0 && in34b === 5000,
        `exit=${r34b.status} 账本 in=${in34b}（应为 5000；若为 0 = 这些轮永不入账，v3.33.0 S1「双封死」复发）`);
      rm34(coal34);
    }
  }
  if (savedEnv34 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv34;
}

// ===== T35：v3.34.0 第五轮审计 P1 —— exports/ 必须有保留期（此前零清理） =====
// 病根：`--report --csv` 每次都按**秒级时间戳**新建一个 CSV（`report-<label>-<YYYYMMDD-HHMMSS>.csv`），
//   而 `exports/` 目录**没有任何清理**——rounds/ 至少还有 ROUNDS_KEEP_MONTHS，exports/ 连保留期都没有，
//   目录只增不减。与 v3.33.0 A7（rounds 清理只插在三个后加子分支里）是同一类"注释承诺 / 实现缺失"。
{
  const src35 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T35-a0 ★pruneExports 存在且 EXPORTS_KEEP_DAYS 有定义',
    src35.includes('function pruneExports(') && /const EXPORTS_KEEP_DAYS = \d+;/.test(src35));
  const calls35 = (src35.match(/pruneExports\(\);/g) || []).length;
  ok('T35-a1 ★pruneExports 只在 --report 入口调用一次（与 pruneRoundFiles 同款，不散落子分支）',
    calls35 === 1, `实际 ${calls35} 处（应恰为 1）`);
  const iEntry35 = src35.indexOf("if (process.argv.includes('--report')) {");
  const iCall35 = src35.indexOf('pruneExports();');
  const iForecast35 = src35.indexOf('reportForecastTxt(', iEntry35);
  ok('T35-a2 ★清理位于 --report 统一入口（在 forecast/区间/csv 各分支 return 之前）→ 所有变体都覆盖',
    iEntry35 >= 0 && iCall35 > iEntry35 && iForecast35 > iCall35,
    `entry=${iEntry35} call=${iCall35} forecast=${iForecast35}`);
  ok('T35-a3 ★只删 `report-*.csv`：目录里用户手放的文件绝不能被误删',
    /if \(!\/\^report-\.\*\\\.csv\$\/\.test\(f\)\) continue;/.test(src35));

  const savedEnv35 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let mod35 = null;
  try { mod35 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { mod35 = null; }
  if (!mod35) {
    ok('T35 模块加载', false, 'token-tracker.js require 失败');
  } else {
    const dir35 = mod35.EXPORTS_DIR;
    try { fs.mkdirSync(dir35, { recursive: true }); } catch (e) { /* silent-ok:清理 — 已存在或被占用 */ }
    const mk35 = (name, ageDays) => {
      const p = path.join(dir35, name);
      fs.writeFileSync(p, 'a,b\n1,2\n');
      const t = new Date(Date.now() - ageDays * 86400000);
      fs.utimesSync(p, t, t);
      return p;
    };
    const old1 = mk35('report-summary-20260101-010101.csv', 400);
    const old2 = mk35('report-week-20260202-020202.csv', 200);
    const fresh = mk35('report-summary-20990101-010101.csv', 0);
    const alien = mk35('我的手工笔记.csv', 900);   // 非本技能产出 → 绝不能删
    const alien2 = mk35('keep.txt', 900);
    let removed35 = -1;
    try { removed35 = mod35.pruneExports(); } catch (e) { removed35 = -1; }
    const ex = (p) => { try { fs.existsSync(p); return fs.existsSync(p); } catch (e) { return false; } };
    ok('T35-b1 ★超保留期的旧 CSV 被清理，保留期内的不动（返回值 = 实际删除数 2）',
      removed35 === 2 && !ex(old1) && !ex(old2) && ex(fresh),
      `removed=${removed35} old1=${ex(old1)} old2=${ex(old2)} fresh=${ex(fresh)}`);
    ok('T35-b2 ★非 `report-*.csv` 的文件一律保留（用户手放的 Excel/笔记绝不能被误删）',
      ex(alien) && ex(alien2), `alien=${ex(alien)} txt=${ex(alien2)}`);
    ok('T35-b3 目录不存在 / 空目录 → 返回 0 且不抛异常',
      (() => {
        const emptyDir = path.join(tmp, 't35-empty-exports');
        try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch (e) { /* silent-ok:清理 — 目录本就可能不存在 */ }
        return mod35.pruneExports() >= 0;
      })());
    for (const p of [old1, old2, fresh, alien, alien2]) { try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — 已被清掉的文件本就不存在 */ } }
  }
  if (savedEnv35 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv35;
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
  // v3.33.0：补 mod26（T26 --doctor）/ mod27（T27 补-S5）/ mod29（T29 numTs）/ mod30（T30 exportSummaryCsv）
  //   —— 本节注释自己就写着"勿漏"，而这些别名正是后来逐个新增的、当时都没往里加 → 它们引用的成员
  //   （doctorTxt / showToast / numTs / exportSummaryCsv）此前**不受本守卫覆盖**，新增导出漏了就查不出来。
  //   注意本守卫只核对 `token-tracker.js` 的导出：`rp28`（T28 用到的 refresh-prices.js）**刻意不列**，
  //   因为 ttAll 是主脚本的导出表，把它列进来会对 looseFind 这类"兄弟模块导出"产生**假失败**；
  //   那条路径由 T28 自己的 `typeof rp28.looseFind !== 'function'` 前置守卫覆盖。
  // v3.34.0：补 mod34（T34 P0-1 记账去重）/ mod35（T35 exports 保留期）—— 同上，本节注释自己写着"勿漏"。
  const MOD_VARS = ['mod', 'ttMod', 'tt2', 'mod16', 'mod17', 'mod18', 'mod19', 'mod20', 'mod21', 'mod26', 'mod27', 'mod29', 'mod30', 'mod31', 'mod34', 'mod35'];
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

// 隔离目录清理（v3.33.0 加固）：**有界重试**。
//   为什么需要：主脚本在被 require 时会跑 loadPricing → maybeRefreshHolidays（每进程一次、四条件命中即
//   **detach** spawn 一个 refresh-holidays.js 子进程并往 SNAP_DIR 写 `.holidays-refresh.json`）。该子进程
//   存活到测试结束之后，恰好与这里的 rmSync 抢同一批文件 → Windows 上 rimraf 报
//   `ENOTEMPTY: directory not empty, rmdir ...`，整个 selftest 以非零码崩掉、连结果汇总都打不出来。
//   实测症状是"断言全绿但 exit 1"，且**偶发**（`%TEMP%` 里有 2026-10-04 的历史残留，早于本轮改动 → 既有隐患）。
//   注意：这不是断言失败，也不能靠忽略错误掩盖（ENOTEMPTY 之外的错误照旧抛出）。
for (let i = 0; i < 5; i++) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
  catch (e) {
    if ((e && e.code !== 'ENOTEMPTY') || i === 4) throw e;
    // 子进程写完最后一批文件即退出，短暂退避后重试足够（5 次 × 200ms ≈ 1s 上限）
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch (e2) { /* 退避失败直接重试 */ }
  }
}
// v3.24.0（审计⑤）：skip 数显式化 —— 「138 全绿」曾掩盖 26 条端到端用例全部 SKIP 的事实
// （SPAWN_OK=false 的沙箱环境里绿 ≠ 真跑过）。
// v3.29.0（A-3）：**退出码语义修正** —— 只有真失败才 exit 1；envSkip 是"环境能力受限"（沙箱禁 spawn、
//   CI 的 WB_NO_NET 前提缺口），不是代码问题，**不再让 job 变红**（旧行为 exit 2 会被 GitHub Actions
//   一律判失败，且红的原因看起来像"测试失败"）。CI 正常环境下 envSkip 应为 0，summary 会显式标注。
//   为此**不需要** job 级 continue-on-error —— 那玩意无法区分 exit 1/2，会连带吞掉真实回归。
console.log(`\n结果：${pass} 过 / ${fail} 败 / ${envSkipCount} 环境受限跳过`
  + (envSkipCount > 0 ? '（需要 node 子进程或 WB_NO_NET 前提缺口；属环境能力限制、不计入退出码；CI 上应为 0）' : ''));
process.exit(fail ? 1 : 0);
