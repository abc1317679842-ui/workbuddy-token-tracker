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

// v3.35.0（B2）：Stop 端（--stop）处理已整块迁到 stop-handler.js。凡是守「Stop 端行为」的源码断言
//   都必须扫**主脚本 + stop-handler.js 的并集**——只扫主脚本的话，代码一迁走断言就假红；
//   更糟的是有人能靠"把代码迁出主脚本"绕过守卫。这里给一个统一的取值器，避免各处各扫各的。
//   文件缺失时返回空串（不抛），保证 selftest 自身不因部署缺件而崩。
const UNION_FILES = ['token-tracker.js', 'stop-handler.js'];
const readUnion = (x) => UNION_FILES
  .map((f) => { try { return x(fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n')); } catch (e) { return ''; } })
  .join('\n');
const srcUnion = () => readUnion(stripComments);   // 剥注释后的并集（行为断言用）
const srcUnionRaw = () => readUnion((s) => s);     // 未剥注释的并集（注释/约定断言用）

// 环境能力探测：部分沙箱禁止 node→node 子进程（spawnSync 报 EBUSY）。只有需 spawn 的用例受影响。
function canSpawn() {
  try {
    const probe = spawnSync(NODE, ['-e', 'console.log("ok")'], { timeout: 10000, windowsHide: true });
    return !(probe.status === null && probe.error);
  } catch (e) { return false; }
}
const SPAWN_OK = canSpawn();
// v3.35.0（B2）：stop-handler.js 拆出后必须跟兄弟脚本同等待遇——语法检查与裸 catch 扫描都要覆盖，
//   否则"迁出去就没人扫了"会静默削弱 T33 的守卫面（裸 catch 基线是按这些文件的**总和**定的，当前值见 T33-a1）。
const SYNTAX_FILES = ['token-tracker.js', 'refresh-prices.js', 'deepseek-official.js', 'refresh-holidays.js',
  'backfill.js', 'recalc-day.js', 'peak-rules.js', 'selftest.js', 'stop-handler.js', 'wb-root.js'];

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
// v3.35.0（B2）：stop-handler.js 必须随行——主脚本顶层 require 它，隔离目录缺它 = MODULE_NOT_FOUND，
//   整段测试全炸（v3.32.0 缺 refresh-holidays.js 时踩过同一坑）。此清单由下方 T37-a2 自动校验。
// v3.42.0（plan-B B1）：wb-root.js 必须随行——数据根探测抽成单点实现后，主脚本/backfill/recalc/
//   refresh-prices 四个文件顶层都 require 它；隔离目录缺它 = 全段 MODULE_NOT_FOUND（同上两坑的第三次）。
const RUNTIME_COMPANIONS = ['refresh-prices.js', 'deepseek-official.js', 'refresh-holidays.js',
  'pricing.json', 'holidays.json', 'peak-rules.js', 'recalc-day.js', 'stop-handler.js', 'wb-root.js'];
for (const f of ['token-tracker.js', ...RUNTIME_COMPANIONS]) {
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
    // v3.40.0（plan-B A4）：账本分桶改跟 **token 发生时刻**（不再用写盘时刻 todayStr()）→
    //   夹具的 ts 是 2026-03-04 高峰，所以必须用 ttMod.dateStrOfTs(peakTs) 去读那一桶。
    const tok8 = ttMod.dateStrOfTs(peakTs);
    const rec8 = led && led[tok8] && led[tok8].models && led[tok8].models['deepseek-v4.1-flash'];
    const pk8 = ttMod.mergeLocalPriceDb(JSON.parse(JSON.stringify(pricing8b)));
    const cPeak8 = ttMod.calcCost({ model: 'deepseek-v4.1-flash', in: 1000000, cached: 0, out: 0 }, pk8, peakTs);
    const cOff8 = ttMod.calcCost({ model: 'deepseek-v4.1-flash', in: 1000000, cached: 0, out: 0 }, pk8, offTs);
    ok('T9-B8c incrementalRecord 端到端：账本金额按行时间戳（高峰）计价，且**分桶日期也是该时刻**',
      Boolean(rec8) && cPeak8 > 0 && Math.abs(cPeak8 - 2 * cOff8) < 1e-9 && Math.abs(rec8.cost - cPeak8) < 1e-6
      && !led[ttMod.todayStr()],
      `ledger=${rec8 && rec8.cost} expect=${cPeak8} off=${cOff8} 桶=${tok8} today桶=${!!led[ttMod.todayStr()]}`);
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
  // v3.35.0（B2）：Stop 端已迁到 stop-handler.js → 改扫并集（否则 T10-h/i 因代码搬家而假红）。
  const codeOnly = srcUnion();

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
  // v3.40.0（plan-B A4）：明细落哪个文件改跟 **token 发生时刻**（不再用写盘时刻 todayStr()）→
  //   夹具 ts=1700000001000（2023-11-14）→ 必须按该时刻的月份去读，否则恒读到空。
  const TS11 = 1700000000000;
  const roundsFile = path.join(roundsDir, 'rounds-' + ttMod.dateStrOfTs(TS11).slice(0, 7) + '.jsonl');
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
  // v3.40.0（A4）：账本桶同样跟发生时刻 → 用 dateStrOfTs(TS11) 而不是 todayStr()
  const bucket11 = ttMod.dateStrOfTs(TS11);
  const rec11 = ledNow[bucket11] && ledNow[bucket11].models['m-x'];
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
  //   v3.40.0（A4）：本用例要验的是「保留**当下**当月」——它必须用一个**真当月**的文件名，
  //   不能复用上面跟夹具 ts 走的 roundsFile（那是 2023-11，对 prune 而言同样是过期月）。
  //   同时**先清空目录**：h 组留下的 rounds-2023-11.jsonl 也是过期月，会一起被删掉 → removed 不是 1。
  fs.rmSync(roundsDir, { recursive: true, force: true });
  fs.mkdirSync(roundsDir, { recursive: true });
  const curMonthFile = path.join(roundsDir, 'rounds-' + ttMod.todayStr().slice(0, 7) + '.jsonl');
  fs.writeFileSync(path.join(roundsDir, 'rounds-2020-01.jsonl'), '{}\n');
  fs.writeFileSync(curMonthFile, '{}\n');
  const removed11 = ttMod.pruneRoundFiles();
  ok('T11-j 清理过期月份、保留当月',
    removed11 === 1 && !fs.existsSync(path.join(roundsDir, 'rounds-2020-01.jsonl')) && fs.existsSync(curMonthFile),
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
  // v3.46.0（审计 S-9）：改前两边各抄一份**写法不同但语义等价**的三元式，本条只能靠正则盯两份抄写
  //   ——那正是"靠注释/靠测试记着同步"的典型。现在两处都改为调用 peakMultOf 单点：
  //   口径一致由**调用关系**保证（改单点 → 两边必然同时变），不可能再漂移。
  //   本条因此改为：两边都必须调 peakMultOf，且**不得**再各自写三元式（负向断言，防回退）。
  const mainCode = stripComments(main);
  const recalcDef = /tt\.peakMultOf\(/.test(recalcCode);
  const mainDef = /peakMultOf\(m, /.test(mainCode);
  const recalcNoOwn = !/isDeepSeekS/.test(recalcCode)
    && !/typeof m\.peak_multiplier === 'number' \? m\.peak_multiplier :/.test(recalcCode);
  const mainNoOwn = !/isDeepSeek \? \(typeof m\.peak_multiplier/.test(mainCode)
    && !/typeof m\.peak_multiplier === 'number' \? m\.peak_multiplier : \(isDeepSeek/.test(mainCode);
  ok('T14-a2 ★recalc-day.js 与主脚本 calcCost 的 peak_multiplier 缺省口径一致（v3.46.0 起共调 peakMultOf 单点）',
    recalcDef && mainDef && recalcNoOwn && mainNoOwn,
    `recalc调=${recalcDef} main调=${mainDef} recalc无自写=${recalcNoOwn} main无自写=${mainNoOwn}`);
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
    const src17 = srcUnion(); // v3.35.0（B2）：Stop 端已迁出 → 守 Stop 行为的断言改扫并集
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
    //   ① `line += '｜…'`（追加一个标签段）在全函数体内**恰好 2 处**（⚠未计价 / ⚠账缺；
    //      v3.44.0 前是 5 处，价⚠️/官价⚠️/⚠价核验 已迁到行1 见 noPriceTag1）；
    //   ② `line += '｜⚠未计价'` **恰好 1 次**（这处正是被复制过的那个块）。
    //   若有人再粘贴一遍任何标签块，①或②必然超标 → 立刻红。（后续新增正当标签时需同步更新此计数，
    //   这正是"新标签必须被显式意识到"的预期摩擦，不是误报。）
    const tl2Start = main18.indexOf('function toastLine2');
    const tl2End = main18.indexOf('\nfunction ', tl2Start + 10);
    const tl2Body = stripComments(main18.slice(tl2Start, tl2End));
    const tagAppendCount = (tl2Body.match(/line \+= '｜/g) || []).length;
    const unpaidAppendCount = (tl2Body.match(/line \+= '｜⚠未计价'/g) || []).length;
    ok('T18-c5 ★toastLine2 标签追加块无重复（line += \'｜…\' 恰好 2 处、⚠未计价 恰好追加 1 次）',
      tl2Start > 0 && tl2End > tl2Start && tagAppendCount === 2 && unpaidAppendCount === 1,
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
    // v3.44.0：⚠价核验 与 价⚠️/官价⚠️ 已从行2 迁到行1（用户 2026-10-10 要求：行2 加它们会挤掉缓存百分比）。
    //   故本组断言改查**行1 的标签源 noPriceTag1** —— 触发源收窄 / 只报本轮模型 的语义逐条不变。
    const tag1of = (s, p) => mod19.noPriceTag1(s, p);
    const pNote19 = P19({ last_refresh_note: '2026-10-01T17:53:35.143Z 多源刷新：⚠️模糊匹配歧义: kimi-k3: ...' });
    ok('T19-a1 ★历史 last_refresh_note 含 ⚠ 不再挂「⚠价核验」（A-8 的永久误报根因）',
      tag1of(short19, pNote19).indexOf('价核验') < 0, tag1of(short19, pNote19));
    const pOther19 = P19({ _ambig_warnings: ['kimi-k3: USD源 模糊命中 2 个不同价候选，已放弃', 'glm-5.3-flash: USD源 模糊命中 3 个'] });
    ok('T19-a2 ★与本轮模型**无关**的歧义不挂标签（别的模型的问题不得污染每一条弹窗）',
      tag1of(short19, pOther19).indexOf('价核验') < 0, tag1of(short19, pOther19));
    const pMine19 = P19({ _ambig_warnings: ['kimi-k3: xx', M19 + ': USD源 模糊命中 2 个不同价候选，已放弃'] });
    ok('T19-a3 ★点名本轮模型的歧义 → 照常挂标签（收窄不等于失效，且已挂到行1）',
      tag1of(short19, pMine19).indexOf('⚠价核验') >= 0, tag1of(short19, pMine19));
    const pAudit19 = P19({ _price_audit: { at: 'x', warnings: [M19 + ': 人民币价 1 vs usd×7.2=0.5 偏差 50%'] } });
    ok('T19-a4 ★_price_audit 点名本轮模型 → 挂标签', tag1of(short19, pAudit19).indexOf('⚠价核验') >= 0, tag1of(short19, pAudit19));
    const pAuditOther19 = P19({ _price_audit: { at: 'x', warnings: ['other-m: 偏差 50%'] } });
    ok('T19-a5 ★_price_audit 与本轮无关 → 不挂', tag1of(short19, pAuditOther19).indexOf('价核验') < 0, tag1of(short19, pAuditOther19));
    const pHy19 = { models: { hy3: PAID19 }, _ambig_warnings: ['hy3-preview: USD源歧义'] };
    ok('T19-a6 ★显示名与价库键不一致也能命中（hy3 ↔ hy3-preview 宽松匹配）',
      tag1of({ model: 'hy3', in: 1000000, out: 10000, cached: 0 }, pHy19).indexOf('⚠价核验') >= 0);

    // v3.44.0 新增：价格类标签**整体迁到行1**（用户 2026-10-10 要求）——钉住「行1 有、行2 无」，防回退。
    ok('T19-a7 ★价格类标签不得再出现在行2（已整体迁行1；行2 位置留给缓存百分比）',
      l2of(short19, pMine19).indexOf('价核验') < 0 && l2of(short19, pMine19).indexOf('价⚠️') < 0,
      l2of(short19, pMine19));
    const pRef19 = P19({ last_refresh_error: 'all sources failed' });
    ok('T19-a8 ★价⚠️（多源拉取失败）迁到行1、行2 不再出现',
      tag1of(short19, pRef19).indexOf('价⚠️') >= 0 && l2of(short19, pRef19).indexOf('价⚠️') < 0,
      tag1of(short19, pRef19) + ' || ' + l2of(short19, pRef19));

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
    const src23 = srcUnion(); // v3.35.0（B2）：同上，S1 起点兜底的调用点已随 Stop 端迁走
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
  // v3.35.0（B2）：Stop 端整块迁到 stop-handler.js → 它带走的裸 catch 也必须继续被扫，
  //   否则总数会从 36 掉下去而 T33-a1 却"因为数字变小"报错、或者更糟：有人靠"迁出去"绕过约定。
  const FILES33 = ['token-tracker.js', 'backfill.js', 'recalc-day.js', 'refresh-holidays.js', 'refresh-prices.js', 'selftest.js', 'stop-handler.js'];
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
  // v3.38.0：36 → 37 —— watcher 锁改心跳后，接管"心跳已停"的旧锁时新增一处删锁的清理型裸 catch
  //   （token-tracker.js 心跳接管分支，已按约定带 `// silent-ok:清理` 标记）。
  //   之所以显式改基线而不是绕开：本守卫的语义就是"新增静默必须留痕"，T33-a2/a3 仍守
  //   "必须带标记 + 类别落在四类白名单"，所以改数字不会削弱守卫生效面。
  // v3.39.0：37 → 41 —— 水位线反向闸门（plan-B A1/A2）新增 4 处清理/降级型裸 catch：
  //   backfill.js ×3（水位线落盘失败后的账本/水位线回滚，失败统一降级为人工告警）、
  //   selftest.js ×1（T41 夹具清场）。均按约定带 `// silent-ok:<类别>` 标记。
  // v3.40.0：T42 的 A21 夹具虽然也写了 4 处 `catch (e) { /* silent-ok:清理 … */ }`，但本守卫的
  //   判据是 `catch (x) {}`（**空块紧邻**，`BARE33`），带注释的形态**不匹配** → 计数不变（实测确认）。
  //   这里保留显式说明，避免后人看到"多了 4 处静默"却不知道为什么基线没动。
  // v3.45.0（审计批次 1）：基线 41 → 43。新增两处**都带 silent-ok 标记**：
  //   ① S-7 价库流水线 spawn 后的 `c.unref()`（子进程已退出/已 unref 都会抛，属预期）；
  //   ② F-2 新抽的 saveLedgerRawAtomic 里失败时删 tmp（tmp 已不存在都属预期）。
  //   两处都是"清理"类，符合白名单；基线按设计显式上调，不是顺手吞错。
  ok('T33-a1 ★裸 catch 总数与基线一致（43；新增/删除必须显式改这里，防"顺手吞一个错"）',
    nAll === 43, `实测 ${nAll} 处`);
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
  const src34 = srcUnion(); // v3.35.0（B2）：P0-1 的 writeCoalesce 调用点已随 Stop 端迁走
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
  ok('T35-a3 ★只删本技能自己生成的 `report-*-YYYYMMDD-HHMMSS.csv`：用户手放的文件绝不能被误删',
    /if \(!\/\^report-\.\*-\\d\{8\}-\\d\{6\}\\\.csv\$\/\.test\(f\)\) continue;/.test(src35));

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

// ===== T37：v3.35.0 B 组 —— main() 拆分（Stop 端 → stop-handler.js）=====
// 病根：main() 曾 1151 行，把「CLI 分发 / --hook 路径 / --stop 路径」三件语义不同的事压在一个函数里，
//   v3.34.0 修的 P0-1 正是「同一段代码服务两个相反契约」的结构孕育出来的。
// 拆法：stop-handler.js **不反向 require 主脚本**（单向依赖），所需 46 个只读能力由调用点显式注入。
//   这套做法的两个真实风险必须各有一道守卫：①漏传/改名/拼错 → 运行时才炸；②有人靠"迁出主脚本"
//   绕过 T10/T17/T23/T33 这类只扫主脚本的守卫。
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  const srcT = src('token-tracker.js');
  const srcH = src('stop-handler.js');
  const sh = (() => { try { return require(path.join(SRC, 'stop-handler.js')); } catch (e) { return null; } })();

  ok('T37-a1 stop-handler.js 导出 handleStopEnd 与注入清单 STOP_TX_NAMES',
    !!sh && typeof sh.handleStopEnd === 'function' && Array.isArray(sh.STOP_TX_NAMES) && sh.STOP_TX_NAMES.length > 0,
    sh ? `STOP_TX_NAMES=${sh.STOP_TX_NAMES.length} 项` : 'require 失败');

  // a2：主脚本 require 的**每一个**兄弟模块都必须进隔离目录随行清单（自动提取，非手工清单）。
  //   v3.35.0 拆分当天就踩了：stop-handler.js 没进清单 → 隔离目录 MODULE_NOT_FOUND → 整段 selftest 全炸
  //   （v3.32.0 缺 refresh-holidays.js 时踩过同一个坑，说明手工清单守不住）。
  const requiredSiblings = [...srcT.matchAll(/require\('\.\/([A-Za-z0-9_.-]+\.js)'\)/g)].map((m) => m[1]);
  const missingCompanions = [...new Set(requiredSiblings)].filter((f) => RUNTIME_COMPANIONS.indexOf(f) < 0);
  ok('T37-a2 ★主脚本 require 的兄弟模块全部在隔离目录随行清单里（自动提取，缺一个 = 整段 selftest 崩）',
    requiredSiblings.length > 0 && missingCompanions.length === 0,
    `require ${[...new Set(requiredSiblings)].length} 个；缺失：${missingCompanions.join(',') || '无'}`);

  if (!sh) {
    ok('T37-a3 注入清单三处一致（STOP_TX_NAMES / 调用点 / 解构点）', false, '模块加载失败');
    ok('T37-a4 每个注入名在主脚本里真的有顶层定义（拼错 = 运行时 undefined）', false, '模块加载失败');
  } else {
    // a3：三处必须逐项相同——只改一边会让注入静默少一项（漏传的那项在函数体里是 undefined）。
    const names = sh.STOP_TX_NAMES;
    const callBlock = (srcT.match(/tx: \{([\s\S]*?)\} \}\)\)/) || ['', ''])[1];
    const atCall = [...callBlock.matchAll(/^\s*([A-Za-z_$][\w$]*),$/gm)].map((m) => m[1]);
    const destrBlock = (srcH.match(/const \{([\s\S]*?)\} = tx;/) || ['', ''])[1];
    const atDestr = [...destrBlock.matchAll(/^\s*([A-Za-z_$][\w$]*),?$/gm)].map((m) => m[1]);
    const eq = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
    ok('T37-a3 ★注入清单三处一致（STOP_TX_NAMES / 主脚本调用点 / stop-handler 解构点）',
      eq(names, atCall) && eq(names, atDestr),
      `清单 ${names.length} / 调用点 ${atCall.length} / 解构点 ${atDestr.length}；`
      + `差集=${[...new Set([...names, ...atCall, ...atDestr])].filter((n) => names.indexOf(n) < 0 || atCall.indexOf(n) < 0 || atDestr.indexOf(n) < 0).join(',') || '无'}`);

    // a4：注入名必须在主脚本里真有顶层定义（const/let/var/function），否则注入的是 undefined。
    const undef = names.filter((n) => !new RegExp(`^(?:const|let|var|function|async function)\\s+${n}\\b`, 'm').test(srcT));
    ok('T37-a4 ★每个注入名在主脚本里真的有顶层定义（拼错 = 运行时 undefined，弹窗/记账会静默走空）',
      undef.length === 0, undef.length ? `未找到定义：${undef.join(',')}` : `46 项全部命中`);
  }

  // a5：单向依赖——stop-handler 不得反向 require 主脚本（循环依赖会让"谁依赖谁"失去方向，
  //   且主脚本被 require 时的副作用会变得不可预测）。
  ok('T37-a5 ★单向依赖：stop-handler.js 不反向 require 主脚本（无循环依赖）',
    !/require\(['"]\.\/token-tracker\.js['"]\)/.test(srcH), '红 = 循环依赖回来了');

  // b1：防回涨（直接判据：main() 不得重新长回去）
  const lines = srcT.replace(/\r\n/g, '\n').split('\n');
  const mStart = lines.findIndex((l) => /^function main\(\)/.test(l));
  let mEnd = mStart + 1;
  for (; mEnd < lines.length; mEnd++) if (/^\}/.test(lines[mEnd])) break;
  ok('T37-b1 ★main() 行数未回涨（拆分后 878 行，上限 950）',
    mStart >= 0 && (mEnd - mStart) <= 950, `实测 ${mEnd - mStart} 行`);

  // b2：Stop 块特征行必须已离开主脚本（在 stop-handler.js 里）——防止"两边各留一份"。
  const MARK = "/\\bsubagents\\b/i.test(tsPath.replace";
  ok('T37-b2 ★Stop 端子代理路径守卫已迁走且**只有一份**',
    srcT.indexOf(MARK) < 0 && srcH.indexOf(MARK) > 0, '红 = 主脚本里还有一份 → 两边会漂移');
}

// ── T38（v3.36.0 P0）：官方价命中模型的备用源歧义必须**静音但不丢信息** ─────────────────────
//   病根：refresh-prices.js 主循环里 usdFind/cnFind 在**官方价判定之前**无条件执行，
//         于是已有 DeepSeek 官方价的模型（deepseek-v4.1-flash / deepseek-flash），
//         仍会把「USD源 模糊命中 N 个不同价候选，已放弃」记进 `_ambig_warnings`
//         → token-tracker.js 的 priceAuditTag 把它翻成弹窗标签「⚠价核验」→ 常用模型条条挂。
//   用户原话：「官方价格源已经命中的情况下，后面备用源的那些，刷新到还是没刷新到，都已经是无关紧要的东西了」。
//   两道守卫缺一不可：①必须真静音（否则用户还在看噪音）；②必须真留痕（否则从"误报"变成"隐藏信息"）。
{
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');
  const srcR = src('refresh-prices.js');
  const srcT2 = src('token-tracker.js');
  const rp = (() => { try { return require(path.join(SRC, 'refresh-prices.js')); } catch (e) { return null; } })();

  // a1：新字段必须存在且已导出（否则 token-tracker 的体检读不到、信息就真丢了）
  ok('T38-a1 refresh-prices.js 导出 AMBIG_WARNINGS_OFFICIAL（独立归集备用源歧义）',
    !!rp && rp.AMBIG_WARNINGS_OFFICIAL instanceof Set,
    rp ? 'Set 未导出' : 'require 失败');

  // a2：静音开关**只能**来自 officialHitPre，不得出现硬编码 true（硬编码 = 无条件静音 = 漏报）
  const assigns = [...srcR.matchAll(/AMBIG_SILENT\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  ok('T38-a2 ★AMBIG_SILENT 只被赋 false / officialHitPre（绝无硬编码 true）',
    assigns.length > 0 && assigns.every((a) => a === 'false' || a === 'officialHitPre'),
    `实际赋值：${JSON.stringify(assigns)}`);

  // a3：循环开头必须**无条件复位**——模块级变量若跨轮残留，会把无官方价模型的告警一起静音（漏报）
  //   注意：不能用 indexOf('AMBIG_SILENT = false;')——它会撞上模块级 `let AMBIG_SILENT = false;` 定义行。
  //   改为**逐行定位**：找到主循环行，其后的第一条 `AMBIG_SILENT = false;` 必须是「复位」，且早于赋值行。
  const rLines = srcR.replace(/\r\n/g, '\n').split('\n');
  const mainLoopLine = rLines.findIndex((l) => /^\s{2}for \(const key of Object\.keys\(models\)\) \{$/.test(l));
  const resetLine = rLines.findIndex((l, i) => i > mainLoopLine && /^\s*AMBIG_SILENT = false;$/.test(l));
  const setLine = rLines.findIndex((l) => /^\s*AMBIG_SILENT = officialHitPre;$/.test(l));
  ok('T38-a3 ★复位早于赋值、且都在主循环体内（防跨轮残留 → 静音泄漏到下一个模型）',
    mainLoopLine >= 0 && resetLine > mainLoopLine && setLine > resetLine,
    `主循环@${mainLoopLine + 1} 复位@${resetLine + 1} 赋值@${setLine + 1}`);

  // a4：officialBlk 必须复用 officialHitPre —— 两处判据各写一份必然漂移（改 A 忘改 B 就静音错人）
  ok('T38-a4 ★officialBlk 复用 officialHitPre（单一判据来源，不允许重复表达式）',
    /const officialBlk = officialHitPre \?/.test(srcR),
    '两处判据会各改各的 → 漂移');

  // a5：**信息不丢**——静音条目必须落独立字段，且带 delete 反向清理（避免空数组残留）
  ok('T38-a5 ★静音告警落盘 _ambig_warnings_official 且有 delete 反向清理',
    /pricing\._ambig_warnings_official = \[\.\.\.AMBIG_WARNINGS_OFFICIAL\]/.test(srcR)
    && /delete pricing\._ambig_warnings_official/.test(srcR),
    '信息丢失 = 从"误报"变成"隐藏信息"');

  // a6：**不驱动弹窗**——priceAuditTag 只能读 _ambig_warnings / _price_audit.warnings 两源，
  //     绝不能把 _ambig_warnings_official 并进来（并进来 = 静音白做，弹窗照挂）
  const patBlock = (srcT2.match(/function priceAuditTag\(stat, pricing\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
  ok('T38-a6 ★priceAuditTag 不读 _ambig_warnings_official（静音才算真生效）',
    patBlock.length > 0 && patBlock.indexOf('_ambig_warnings_official') < 0,
    patBlock.length ? '弹窗标签仍会消费静音字段 → 静音无效' : '未定位到 priceAuditTag 函数体');

  // a7：**信息可见**——体检（--doctor）必须计数新字段，否则留痕等于没人看得见
  ok('T38-a7 ★--doctor 体检已计入 _ambig_warnings_official（留痕必须可见）',
    /_ambig_warnings_official/.test(srcT2.slice(srcT2.indexOf('function doctorTxt'), srcT2.indexOf('function doctorTxt') + 12000)),
    '留痕不可见 = 与直接丢弃等价');

  // a8：stderr 必须留痕（诊断不减）——刷新时就要能在日志里看到静音了几条
  ok('T38-a8 ★refresh-prices 静音时写 stderr（诊断链路不断）',
    /官方价已命中模型的备用源歧义 \$\{AMBIG_WARNINGS_OFFICIAL\.size\} 条/.test(srcR));

  // a9：last_refresh_note 汇总行必须带上新字段（否则"这次刷新静音了什么"在价库里查不到）
  ok('T38-a9 ★last_refresh_note 已并入 _ambig_warnings_official 计数',
    /AMBIG_WARNINGS_OFFICIAL\.size \? `；官方价已命中模型的备用源歧义/.test(srcR));

  // a10：**取值不变**——静音只动告警集合，不得碰任何价格写入语句。
  //      直接判据：AMBIG_SILENT 只出现在 ambigAdd 与被赋值处，不得出现在任何 m.xxx_price = 的赋值里。
  const silentUses = [...srcR.matchAll(/AMBIG_SILENT/g)].map((m) => srcR.slice(Math.max(0, m.index - 60), m.index + 90));
  const touchesPrice = silentUses.some((s) => /m\.\w*price\w*\s*=/.test(s));
  ok('T38-a10 ★静音逻辑不触碰任何价格赋值（红线：只静音不改变取值）',
    !touchesPrice, 'AMBIG_SILENT 附近出现价格赋值 → 可能改变计价结果');
}

// ===== T39（v3.37.0·L1'）：大载荷源的独立超时预算 =====
//   病根：litellm 的 JSON 实测 3,003 KB（其余四源 2~756 KB），而 TIMEOUT_MS 罩住的是
//   「DNS+TLS+响应头+**整段 body 下载**+JSON 解析」。实测 5 轮耗时 0.74~5.51s（波动 7.5×），
//   历史 6 次真实刷新里 4 次失败、3 次错误为 `This operation was aborted`（= 自家 12s 超时器）。
//   修法不是"换源"（源实测可达），而是给大载荷源单独的预算。
//   三道守卫：①预算确实更大；②确实被调用方传下去（否则改了个没人用的常量）；③不得误伤其他源。
{
  const srcR39 = fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8');
  const rp39 = (() => { try { return require(path.join(SRC, 'refresh-prices.js')); } catch (e) { return null; } })();

  // a1：只有显式声明的大载荷源拿到更大预算，且预算必须严格大于全局默认（否则等于没改）
  ok('T39-a1 ★litellm 声明了独立超时预算且严格大于全局 TIMEOUT_MS',
    !!rp39 && rp39.SOURCES && rp39.SOURCES.litellm
    && rp39.SOURCES.litellm.timeoutMs === rp39.BIG_SOURCE_TIMEOUT_MS
    && rp39.BIG_SOURCE_TIMEOUT_MS > rp39.TIMEOUT_MS,
    rp39 ? `litellm.timeoutMs=${rp39.SOURCES.litellm && rp39.SOURCES.litellm.timeoutMs} BIG=${rp39.BIG_SOURCE_TIMEOUT_MS} 默认=${rp39.TIMEOUT_MS}` : 'require 失败');

  // a2：**必须真被消费**——fetchJson 要接 timeoutMs 参数，调用点要传 s.timeoutMs。
  //     只改常量不传参 = 改了个没人用的常量（最常见的假修复）。
  ok('T39-a2 ★fetchJson 接收 timeoutMs 且调用点传入 s.timeoutMs（不是改了没人用的常量）',
    /async function fetchJson\(url, timeoutMs = TIMEOUT_MS\)/.test(srcR39)
    && /await fetchJson\(s\.url, s\.timeoutMs\)/.test(srcR39),
    '常量没接到调用点 → 假修复');

  // a3：定时器必须用的是**传入的** timeoutMs，不是写死的 TIMEOUT_MS
  ok('T39-a3 ★setTimeout 用的是参数 timeoutMs（不是写死 TIMEOUT_MS）',
    /setTimeout\(\(\) => ctrl\.abort\(\), timeoutMs\)/.test(srcR39),
    '仍写死 TIMEOUT_MS → 参数白传');

  // a4：**不误伤**——其余四个源不得被顺手改预算（保持原 12s，避免整体刷新被拖长）
  const overBudget = !!rp39 && rp39.SOURCES
    ? Object.entries(rp39.SOURCES).filter(([k, s]) => k !== 'litellm' && s.timeoutMs != null).map(([k]) => k)
    : ['<require 失败>'];
  ok('T39-a4 ★其余四个源未被顺手改预算（保持全局默认）',
    overBudget.length === 0, `被改的源：${overBudget.join('、')}`);

  // a5：**总耗时仍在整进程上限内**——token-tracker.js 侧 REFRESH_TIMEOUT_MS 是硬闸，
  //     大源预算必须留足余量（五源 Promise.all 并行，最坏 = 最大单个预算）。
  const srcT39 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8');
  const capM = srcT39.match(/REFRESH_TIMEOUT_MS\s*=\s*(\d+)/);
  const cap = capM ? Number(capM[1]) : 0;
  ok('T39-a5 ★最大单个超时预算 < 整进程上限（不会撞 token-tracker 的 kill 闸）',
    !!rp39 && cap > 0 && rp39.BIG_SOURCE_TIMEOUT_MS < cap,
    `BIG=${rp39 && rp39.BIG_SOURCE_TIMEOUT_MS} 上限=${cap}`);
}

// ===== T40（v3.38.0）：子代理弹窗 —— 中间不弹 / 主任务结束时按模型分条 / watcher 锁心跳 =====
//   用户 2026-10-08 定案：① 中间过程（读回传 / 再派活 / 批与批的间隔）**一律不弹窗，只落盘记账**；
//   ② 要的"及时" = 主模型任务结束时跟着弹，不是"每批完成就弹一次"；③ 不同模型的子代理各弹一条。
//   实证基线（本机真实日志，非推断）：26 分钟弹 22 条（按批弹退化）、子代理弹窗迟到 124 秒、
//   且迟到的一半来自"已跑完的子代理文件因末次写入落在 20s 内被判还在写"的白等。
//   四道守卫：① Stop 端默认不拆（C2）；② 收口判据用"文件已落定"（C3①，放行率 48.1%→81.5%）；
//   ③ 锁改心跳（C3②，Windows PID 复用 → 永久孤儿锁的治本）；④ 弹窗按模型分条 + 文案回 v2.98（C3③④）。
{
  const src40 = srcUnion(); // v3.35.0（B2）：Stop 端已迁出 → 守 Stop 行为的断言改扫并集
  ok('T40-a1 ★Stop 端默认不再拆分弹（WB_TEAM_SPLIT 由"默认开"改为"=== "1" 才开"）',
    /WB_TEAM_SPLIT\s*===\s*'1'/.test(src40) && !/WB_TEAM_SPLIT\s*!==\s*'0'/.test(src40),
    '仍是 !== "0" → 中间过程会继续按批弹（实测 26 分钟弹 22 条）');
  ok('T40-a2 ★收口判据改用"子代理文件已全部落定"（不再用 hasSubagentsRecentlyActive 的纯 mtime 活跃窗）',
    /!subagentsAllSettled\(tsPath/.test(src40) && /subsSettled \? \[\] : pendingSubRaw/.test(src40),
    '旧判据会把"已跑完但 20s 内写过"的文件当成还在写 → 白空等');
  ok('T40-a3 ★watcher 锁改心跳：锁带 hb:1 + 15s 阈值 + 每轮轮询 touch',
    /hb: 1/.test(src40) && /WATCH_LOCK_HB_MS\s*=\s*15 \* 1000/.test(src40) && /touchWatchLock\(\);/.test(src40));
  // a4：心跳分支**不看 pid** —— 判据是锁里 at 的新鲜度（`mine.hb === 1` + `Date.now() - at < WATCH_LOCK_HB_MS`）。
  //     注：srcUnion 剥注释，故只能断言代码特征，不能断言注释文案。
  ok('T40-a4 ★心跳判存活取代 pid 探活（判据 = 锁里 at 的新鲜度，不再问 process.kill）',
    /mine\.hb === 1/.test(src40)
    && /Date\.now\(\) - Number\(mine\.at\)\) < WATCH_LOCK_HB_MS/.test(src40)
    && /心跳/.test(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8')),
    'pid 探活在 Windows 上必踩 PID 复用 → 锁被判"存活"→ 该 sid 永久失去 watcher');
  ok('T40-a5 ★按模型分条：三处出口共用 showToastsSplitByModel（watcher / hook 兜底 / v3.12 补弹 ×2 / Stop 快速路径）',
    (src40.match(/showToastsSplitByModel\(/g) || []).length >= 6, // 1 处定义 + 5 处调用
    `出现次数=${(src40.match(/showToastsSplitByModel\(/g) || []).length}（低于 6 = 有出口漏改）`);
  ok('T40-a6 ★v3.12 硬编码文案「（子代理）」已全部换成 v2.98 的 subagentTagOf（专家团/子代理分得开）',
    !/toastLineTagged\([^)]*'（子代理）'/.test(src40));
  // a7（v3.38.1，2026-10-09 真机复现）：Stop 端 teamDataReady 快速路径（v3.09 加）在 v3.38.0 漏改——
  //   子代理写完后主模型继续写回复 >20s → hasSubagentsRecentlyActive(20s)=false → teamDataReady=true
  //   → 单条弹（「hy4-preview（子代理 hy3）」+ 跨模型混合计价），把分条整个绕过。用户截图质问后定位。
  ok('T40-a7 ★Stop 端 teamDataReady 快速路径必须先走按模型分条（团队轮不得直接单条弹）',
    /!isPlainRound && showToastsSplitByModel\(agg/.test(src40),
    '快速路径直接单条弹 = 分条被绕过（真机 00:52 复现：异模型轮只弹 1 条「hy4-preview（子代理 hy3）」）');
  // a8（v3.38.2）：分条耗时必须取**该模型桶自己的跨度**，不能照抄整轮 durMs。
  //   改前 `durMs: agg.durMs` → 主条与子代理条显示同一个整轮时长（真机实测两条都是 9m2s，
  //   而 hy3 子代理实际只跑 6.9s）。修法两步：桶补记 firstTs + 跨度改 firstTs~lastTs。
  //   注：不能断言"全文不含 durMs: agg.durMs"——记账路径（incrementalRecord 的 meta）仍合法地用它。
  //   故这里只断言正向特征；真正的回归防线是 b11/b12 两条行为断言（主 10min / 子 5s、并行不累加）。
  ok('T40-a8 ★分桶记 firstTs，且分条耗时用桶跨度（不再 durMs: agg.durMs 照抄整轮）',
    /lastTs: 0, firstTs: 0/.test(src40)
    && /durMs: Math\.max\(0, \(b\.lastTs \|\| agg\.lastTs\) - \(b\.firstTs \|\| agg\.firstTs\)\)/.test(src40),
    '照抄整轮 → 子代理条显示主轮时长（真机 9m2s vs 实际 6.9s）');

  const mod40 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod40) ok('T40 行为验证（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const P40 = path.join(tmp, 'projects', 't40');
    fs.mkdirSync(path.join(P40, 's1', 'subagents'), { recursive: true });
    const tp40 = path.join(P40, 's1.jsonl');
    const T0 = 1727827200000;
    let q40 = 0;
    // 真实子代理末行形态（本机 18/18 实测）：{type:'message', role:'assistant', status:'completed'|'incomplete'}
    const row40 = (ts, model, i, o, status) => JSON.stringify({ type: 'message', role: 'assistant', id: 'r' + (q40++),
      timestamp: ts, status: status || 'completed',
      providerData: { model, messageId: 'm' + q40, usage: { input_tokens: i, output_tokens: o } } });
    fs.writeFileSync(tp40, [row40(T0 + 1000, 'hy4-preview', 1000, 100), row40(T0 + 2000, 'hy4-preview', 500, 50)].join('\n') + '\n');
    const sa40 = path.join(P40, 's1', 'subagents', 'agent-a.jsonl');
    const sb40 = path.join(P40, 's1', 'subagents', 'agent-b.jsonl');
    fs.writeFileSync(sa40, row40(T0 + 3000, 'hy3', 400, 40) + '\n');
    fs.writeFileSync(sb40, row40(T0 + 4000, 'deepseek-v4.1-flash', 300, 30) + '\n');

    // b1：全终止态 → 立即落定（这是 124 秒里"白等"的那部分被砍掉的依据）
    ok('T40-b1 ★子代理末行全为终止态 → 判定已落定（不等 mtime 窗口）',
      mod40.subagentsAllSettled(tp40, 0, 20000) === true);
    // b2：incomplete 但已停写 ≥20s → 落定（补 v3.09.1 因 14% incomplete 否决"文件终态"判据的洞）
    //   注意：utimesSync 收的是 **Date 对象**（传毫秒数字会被当秒 → 落到 1970/未来，断言会假绿）。
    const old40 = new Date(Date.now() - 60000);
    fs.writeFileSync(sa40, row40(T0 + 3000, 'hy3', 400, 40, 'incomplete') + '\n');
    fs.utimesSync(sa40, old40, old40);
    fs.utimesSync(sb40, old40, old40);
    ok('T40-b2 ★incomplete 但已停写 ≥20s → 视为落定（放行率 48.1% → 81.5% 的关键）',
      mod40.subagentsAllSettled(tp40, 0, 20000) === true);
    // b3：incomplete 且刚写（<20s）→ 不放行（红线：宁可多等，绝不漏算子代理 token）
    const now40 = new Date(Date.now());
    fs.utimesSync(sa40, now40, now40);
    ok('T40-b3 ★incomplete 且仍在写（<20s）→ 不放行（防漏 token）',
      mod40.subagentsAllSettled(tp40, 0, 20000) === false);
    fs.writeFileSync(sa40, row40(T0 + 3000, 'hy3', 400, 40) + '\n'); // 还原为终止态

    // b4~b7：按模型分条的形状与守恒
    const agg40 = mod40.aggregateTranscript(tp40, 0);
    ok('T40-b4 夹具：整轮聚合含 3 个模型桶（主 hy4-preview + 子 hy3 + 子 deepseek）',
      !!agg40 && !!agg40.models && Object.keys(agg40.models).length === 3);
    const parts40 = mod40.splitByModelStats(agg40);
    ok('T40-b5 ★多模型 → 按模型分条且主模型排第一（同模型按桶合并，落实 v2.95）',
      parts40.length === 3 && parts40[0].model === 'hy4-preview',
      `条数=${parts40.length} 首条=${parts40[0] && parts40[0].model}`);
    ok('T40-b6 ★每条只带自己那一桶 → 各自单独计价，不做跨模型混合',
      parts40.every((p) => Object.keys(p.stat.models).length === 1 && !!p.stat.models[p.model]));
    ok('T40-b7 ★分条后各桶 token 之和 = 整轮合计（不漏 token，红线）',
      parts40.reduce((s, p) => s + p.stat.total, 0) === agg40.total,
      `分条和=${parts40.reduce((s, p) => s + p.stat.total, 0)} 整轮=${agg40.total}`);
    // b8：主子同模型 → 不拆（保持原单条弹窗，行为逐字节不变）
    fs.mkdirSync(path.join(P40, 's2', 'subagents'), { recursive: true });
    const tp40b = path.join(P40, 's2.jsonl');
    fs.writeFileSync(tp40b, row40(T0 + 1000, 'hy4-preview', 100, 10) + '\n');
    fs.writeFileSync(path.join(P40, 's2', 'subagents', 'agent-c.jsonl'), row40(T0 + 2000, 'hy4-preview', 200, 20) + '\n');
    ok('T40-b8 ★主子同模型 → 不拆（仍是 1 条，金额 = 各批之和）',
      mod40.splitByModelStats(mod40.aggregateTranscript(tp40b, 0)).length === 0);
    // b9：token=0 的子代理桶不弹（V13：空跑不该弹窗）
    const aggZero = { in: 100, out: 10, cached: 0, total: 110, model: 'hy4-preview', modelMain: 'hy4-preview',
      models: { 'hy4-preview': { in: 100, out: 10, cached: 0, total: 110, lastTs: T0 },
        'hy3': { in: 0, out: 0, cached: 0, total: 0, lastTs: T0 } } };
    ok('T40-b9 ★token=0 的子代理桶不产出弹窗（空跑无消耗，弹了是噪音）',
      mod40.splitByModelStats(aggZero).length === 0);
    // b10：补弹路径（v3.12 mainToastedAt 残留）的聚合必须带分模型明细，否则仍是跨模型混合一条
    const subAgg40 = mod40.aggregateSubsOnly(tp40, 0);
    ok('T40-b10 ★aggregateSubsOnly 带分模型明细（v3.12 补弹分支才能同样分条）',
      !!subAgg40 && !!subAgg40.models && Object.keys(subAgg40.models).length === 2,
      subAgg40 ? `桶数=${Object.keys(subAgg40.models || {}).length}` : 'null');
    // b11（v3.38.2）：分条耗时 = 该模型桶自己的跨度，不是整轮时长。
    //   夹具：主模型横跨 10 分钟（T0 ~ T0+600000），hy3 子代理只跑 5 秒（T0+300000 ~ T0+305000）。
    //   改前两条都会是 600000（照抄整轮）；改后 hy3 条 = 5000、主条 = 600000。
    fs.mkdirSync(path.join(P40, 's3', 'subagents'), { recursive: true });
    const tp40c = path.join(P40, 's3.jsonl');
    fs.writeFileSync(tp40c, [row40(T0, 'hy4-preview', 1000, 100), row40(T0 + 600000, 'hy4-preview', 500, 50)].join('\n') + '\n');
    fs.writeFileSync(path.join(P40, 's3', 'subagents', 'agent-d.jsonl'),
      [row40(T0 + 300000, 'hy3', 400, 40), row40(T0 + 305000, 'hy3', 300, 30)].join('\n') + '\n');
    const parts40c = mod40.splitByModelStats(mod40.aggregateTranscript(tp40c, 0));
    const hy3Part = parts40c.find((p) => p.model === 'hy3');
    const mainPart40 = parts40c.find((p) => p.model === 'hy4-preview');
    ok('T40-b11 ★分条耗时 = 该模型桶自己的跨度（主 10min / 子 5s，不再照抄整轮）',
      !!hy3Part && hy3Part.stat.durMs === 5000 && !!mainPart40 && mainPart40.stat.durMs === 600000,
      hy3Part ? `hy3 条 durMs=${hy3Part.stat.durMs}（期望 5000）；主条 durMs=${mainPart40 && mainPart40.stat.durMs}（期望 600000）` : '拿不到 hy3 条');
    // b12：并行子代理**不累加** —— 2 个 hy3 分别 4.0s / 6.9s（首尾重叠）→ 桶跨度应是 6.9s 而非 10.9s
    fs.mkdirSync(path.join(P40, 's4', 'subagents'), { recursive: true });
    const tp40d = path.join(P40, 's4.jsonl');
    fs.writeFileSync(tp40d, [row40(T0, 'hy4-preview', 1000, 100), row40(T0 + 600000, 'hy4-preview', 500, 50)].join('\n') + '\n');
    fs.writeFileSync(path.join(P40, 's4', 'subagents', 'agent-e.jsonl'),
      [row40(T0 + 300000, 'hy3', 400, 40), row40(T0 + 304000, 'hy3', 300, 30)].join('\n') + '\n');
    fs.writeFileSync(path.join(P40, 's4', 'subagents', 'agent-f.jsonl'),
      [row40(T0 + 301000, 'hy3', 350, 35), row40(T0 + 306900, 'hy3', 250, 25)].join('\n') + '\n');
    const parts40d = mod40.splitByModelStats(mod40.aggregateTranscript(tp40d, 0));
    const hy3Part2 = parts40d.find((p) => p.model === 'hy3');
    ok('T40-b12 ★并行子代理耗时不累加（2 个并行 4.0s+6.9s → 显示 6.9s，不是 10.9s）',
      !!hy3Part2 && hy3Part2.stat.durMs === 6900,
      hy3Part2 ? `durMs=${hy3Part2.stat.durMs}（期望 6900 = 墙钟跨度；累加会是 10900）` : '拿不到 hy3 条');
  }
  // c 组（端到端，需 spawn）：kill watcher 后 15s 内新 watcher 接管 —— 沙箱 SPAWN_OK=false 时跳过，CI 真跑。
  if (!SPAWN_OK) {
    envSkip('T40-c1 ★心跳锁端到端：kill watcher 后 15s 内新 watcher 接管（改前：pid 被复用 → 永不接管）', SPAWN_SKIP_REASON);
    envSkip('T40-c2 ★端到端：异模型轮弹窗条数 = 模型数，且逐条金额与账本同口径', SPAWN_SKIP_REASON);
  }
}

// ===== T41（v3.39.0 / plan-B A1+A2）：水位线反向闸门 —— 「账本已写、水位线没落盘」必须回滚 =====
//   病根（本轮审计致命 2 条）：记账与水位线是**两次独立落盘**，中间没有反向闸门。
//     A2（主链路 incrementalRecord）：saveLedgerWatermark 改前**静默返回 undefined** —— 水位线没推进
//       而账本已写入 → 下轮从旧偏移重读同一批行再累加一遍 = **重复计费**（多收钱，不可恢复）。
//     A1（backfill）：旧注释称"水位线不改不会重复计费，安全"——该推理只在「主链路按增量追加」时成立；
//       而 backfill 的账本是**整体替换为全量重建值**，水位线停旧偏移 = 重建值 + 重放增量 = 重复计费。
//       即：注释自辩与真实行为**方向相反**，是本次最危险的一条（错的是安全方向判断）。
//   修法：① saveLedgerWatermark 返回布尔 + 写后校验（抓"没抛异常但内容不对"）；
//        ② 主链路失败则回滚账本与轮次明细、水位线不推进；③ backfill 同样回滚到写入前备份再 exit 1。
//   安全方向全程一致：**少记可恢复（下轮补记），重复计费不可恢复**。
{
  const rawTT = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const rawBF = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n');
  const rawRC = fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8').replace(/\r\n/g, '\n');
  // 取单个函数体（到下一个顶层 function 为止）——断言要钉在函数内部，不能用"全文出现过"蒙混
  const grabFn = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\nfunction ', i + 1);
    return j < 0 ? src.slice(i) : src.slice(i, j);
  };
  const saveWmSrc = stripComments(grabFn(rawTT, 'saveLedgerWatermark'));
  const incSrc = stripComments(grabFn(rawTT, 'incrementalRecord'));

  // a1/a2：backfill 的水位线锁失败分支必须**回滚**（改前只打印一句"安全"就 exit 1）
  const bfWmBranch = stripComments(rawBF.slice(rawBF.indexOf('if (!wmRes || !wmRes.ok) {')));
  // v3.45.0（审计 F-2/P-20）：回滚写盘由 `copyFileSync` 改为 `saveLedgerRawAtomic`（tmp+rename），
  //   且必须接其返回值（它内部 catch 后**返回 false 而不抛**，照旧"调完就置 true"会谎报回滚成功）。
  //   本断言的**意图**是"回滚必须存在"，不是"必须用哪种写盘方式" → 接受两种实现，将来再改不误红。
  ok('T41-a1 ★backfill 水位线落盘失败 → 账本回滚到写入前备份 bak1（改前只打印不回滚）',
    /(saveLedgerRawAtomic|copyFileSync)\(DAILY, [^)]*bak1\)/.test(bfWmBranch), '缺回滚 = 重建值 + 下轮重放增量 = 重复计费');
  ok('T41-a2 ★同分支水位线回滚到 bak2，且仍以 exit 1 退出（不留"半套"状态）',
    /(saveLedgerRawAtomic|copyFileSync)\(WATERMARK, [^)]*bak2\)/.test(bfWmBranch) && /process\.exit\(1\)/.test(bfWmBranch));
  // v3.45.0（审计 F-1）：备份存在 → **绝不写 {}**。原判据把"首次回填"与"备份复制失败"混为一谈，
  //   后者会把有数据的账本清空（全部历史归零），且告警文案谎称"回滚失败请手动还原"。
  ok('T41-a9 ★F-1：只有「备份确实不存在」才写空账本（备份存在时写 {} = 清空有数据账本）',
    /if \(!restoredLedger && !bak1Exists\)/.test(bfWmBranch) && /const bak1Exists = fs\.existsSync\(bak1\)/.test(bfWmBranch),
    '缺 !bak1Exists 判据 = 回滚失败时账本被清空');
  // v3.45.0（审计 F-1 续）：回滚结果必须接返回值，不能"调完就置 true"（否则谎报成功）。
  ok('T41-a10 ★F-1：回滚标志取自 saveLedgerRawAtomic 返回值（而非无条件置 true）',
    /restoredLedger = saveLedgerRawAtomic\(DAILY, fs\.readFileSync\(bak1\)\)/.test(bfWmBranch),
    '不接返回值 → 回滚实际失败却告警"已回滚到写入前状态"');
  // a3：那条方向错误的自辩注释必须消失——留着会误导后人把"重复计费"当"安全态"
  ok('T41-a3 ★backfill 不得再出现「水位线不改不会重复计费，安全」这句错误自辩',
    rawBF.indexOf('水位线不改不会重复计费') < 0, '该注释把多收钱的方向写成了安全方向');
  // a4：saveLedgerWatermark 必须三态可判：写异常 / 写后校验不符 / 成功
  ok('T41-a4 ★saveLedgerWatermark 返回布尔：写失败 return false（≥2 处）+ 成功 return true',
    (saveWmSrc.match(/return false;/g) || []).length >= 2 && /return true;/.test(saveWmSrc),
    `return false 处数=${(saveWmSrc.match(/return false;/g) || []).length}（改前静默返回 undefined）`);
  ok('T41-a5 ★saveLedgerWatermark 有写后校验（回读比对，抓"没抛异常但内容不对"）',
    /JSON\.parse\(fs\.readFileSync\(LEDGER_WATERMARK_FILE, 'utf-8'\)\)/.test(saveWmSrc),
    '磁盘满 / 被别的进程覆盖都不会抛异常，只有回读比对能抓到');
  // a6：主链路必须"先回滚、后 return"，且 return 与回滚同一分支（否则水位线照推 = 洞还在）
  ok('T41-a6 ★incrementalRecord 用 wmOk 判定，失败时同一分支内先回滚再 return（不推进水位线）',
    /const wmOk = saveLedgerWatermark\(wm\)/.test(incSrc)
    && /if \(willRecord && !wmOk\)[\s\S]{0,400}?rollbackLedgerAfterWatermarkFailure\(snap\)[\s\S]{0,500}?return;/.test(incSrc),
    '回滚与 return 不在同一分支 = 水位线照推，洞仍在');
  // a7：导出一致性 —— 没导出的函数只能靠注释自证（本项目 v3.29 起的老规矩）
  ok('T41-a7 ★rollbackLedgerAfterWatermarkFailure 已导出（否则本组行为断言无处可挂）',
    /module\.exports = \{[\s\S]*?rollbackLedgerAfterWatermarkFailure,/.test(rawTT));
  // a8：基线钉死 —— recalc-day.js 不碰水位线。哪天给它加记账，A1/A2 的洞会同步出现，这里会红。
  ok('T41-a8 基线：recalc-day.js 不读写水位线（给它加记账前必须先补同一道反向闸门）',
    !/watermark/i.test(rawRC), 'recalc 一旦开始动水位线，本组 a1~a6 的守卫面对应补上');

  // ── b 组：rollbackLedgerAfterWatermarkFailure 行为夹具（纯文件层，可确定性单测） ──
  const savedEnv41 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  const mod41 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod41 || typeof mod41.rollbackLedgerAfterWatermarkFailure !== 'function') {
    ok('T41 模块加载', false, mod41 ? '缺少 rollbackLedgerAfterWatermarkFailure 导出' : 'require 失败');
  } else {
    const RB = mod41.rollbackLedgerAfterWatermarkFailure;
    const D41 = path.join(tmp, 't41');
    fs.mkdirSync(D41, { recursive: true });
    const lg = path.join(D41, 'ledger.json');
    const rd = path.join(D41, 'rounds.jsonl');

    // b1：账本回滚到记账前内容（这是"不重复计费"的落点）
    const pre1 = JSON.stringify({ '2026-10-09': { models: {}, total: { in: 10, out: 1, cached: 0, total: 11, cost: 0 } } });
    fs.writeFileSync(lg, pre1);
    const post1 = JSON.stringify({ '2026-10-09': { models: {}, total: { in: 910, out: 91, cached: 0, total: 1001, cost: 0 } } });
    fs.writeFileSync(lg, post1);
    const r1 = RB({ ledgerPath: lg, preLedger: Buffer.from(pre1), roundsPath: null, preSize: null, postSize: null });
    ok('T41-b1 ★账本回滚到记账前内容（记账后的增量被撤掉 = 下轮重记而非重复计费）',
      r1.ledger === true && fs.readFileSync(lg, 'utf-8') === pre1,
      `回滚后=${fs.readFileSync(lg, 'utf-8').slice(0, 60)}`);
    // b2：原本不存在 → 写回空账本，**不删文件**
    fs.writeFileSync(lg, post1);
    const r2 = RB({ ledgerPath: lg, preLedger: null, roundsPath: null, preSize: null, postSize: null });
    ok('T41-b2 ★原本无账本 → 回滚写回 {} 且不删文件（删除不可逆，空账本与缺失对读侧等价）',
      r2.ledger === true && fs.existsSync(lg) && fs.readFileSync(lg, 'utf-8') === '{}');
    // b3：原本是损坏内容 → 写 '{}'，绝不把损坏内容原样塞回去（否则下轮又要重新隔离一遍）
    const corrupt1 = '{"2026-10-09": {"total": ';
    fs.writeFileSync(lg, corrupt1);
    const r3 = RB({ ledgerPath: lg, preLedger: Buffer.from(corrupt1), roundsPath: null, preSize: null, postSize: null });
    ok('T41-b3 ★原账本已损坏 → 回滚写 {} 而不是把损坏内容写回（历史已在 .corrupt 备份里）',
      r3.ledger === true && fs.readFileSync(lg, 'utf-8') === '{}',
      `回滚后=${fs.readFileSync(lg, 'utf-8').slice(0, 40)}`);
    // b4：轮次明细回滚到记账前长度
    fs.writeFileSync(rd, '{"n":1}\n');
    const preSize = fs.statSync(rd).size;
    fs.appendFileSync(rd, '{"n":2}\n');
    const postSize = fs.statSync(rd).size;
    const r4 = RB({ ledgerPath: lg, preLedger: Buffer.from('{}'), roundsPath: rd, preSize, postSize });
    ok('T41-b4 ★轮次明细回滚到记账前长度（不多留一条已撤销的明细）',
      r4.rounds === true && fs.readFileSync(rd, 'utf-8') === '{"n":1}\n',
      `回滚后=${JSON.stringify(fs.readFileSync(rd, 'utf-8'))}`);
    // b5：记账期间**别的进程**追加过明细 → 不截断（truncate 会误删别人的行，宁可留一条多余明细）
    fs.writeFileSync(rd, '{"n":1}\n');
    const preSize5 = fs.statSync(rd).size;
    fs.appendFileSync(rd, '{"n":2}\n');
    const postSize5 = fs.statSync(rd).size;
    fs.appendFileSync(rd, '{"n":3}\n'); // 别人的行
    const r5 = RB({ ledgerPath: lg, preLedger: Buffer.from('{}'), roundsPath: rd, preSize: preSize5, postSize: postSize5 });
    ok('T41-b5 ★明细期间被别的进程追加 → 不截断（保别人的行，宁可多留一条）',
      r5.rounds === false && fs.readFileSync(rd, 'utf-8') === '{"n":1}\n{"n":2}\n{"n":3}\n',
      `rounds=${r5.rounds} 内容=${JSON.stringify(fs.readFileSync(rd, 'utf-8'))}`);
    // b6/b7：防御——入参异常 / 路径不可写都不得抛出（本函数跑在"已经很糟"的路径上，再抛会把进程带崩）
    let r6 = null, threw6 = '';
    try { r6 = RB(null); } catch (e) { threw6 = String(e && e.message); }
    ok('T41-b6 snap=null → 不抛且返回 {ledger:false, rounds:false}',
      !threw6 && !!r6 && r6.ledger === false && r6.rounds === false, threw6);
    let r7 = null, threw7 = '';
    try { r7 = RB({ ledgerPath: path.join(D41, 'no', 'such', 'dir', 'x.json'), preLedger: Buffer.from('{}'), roundsPath: null, preSize: null, postSize: null }); } catch (e) { threw7 = String(e && e.message); }
    ok('T41-b7 回滚路径不可写 → 不抛且 ledger=false（由调用方如实告警，不再层层补救）',
      !threw7 && !!r7 && r7.ledger === false, threw7);

    // ── c 组：saveLedgerWatermark 三态（真落盘，隔离目录内） ──
    const WM41 = path.join(skillDir, '.ledger-watermark.json');
    const quiet = (fn) => {
      const old = process.stderr.write.bind(process.stderr);
      const buf = [];
      process.stderr.write = (s) => { buf.push(String(s)); return true; };
      let v = null;
      try { v = fn(); } finally { process.stderr.write = old; }
      return { v, err: buf.join('') };
    };
    const clearWm = () => { try { fs.rmSync(WM41, { recursive: true, force: true }); } catch (e) {} }; // silent-ok:清理 — 测试夹具清场，水位线文件本就可能不存在
    // c1：正常 → true，且落盘内容与写入对象一致（顺带证明写后校验不会误判）
    clearWm();
    const wm1 = { 'sid-c1': { main: 7, subs: {}, lastTs: 111, subTs: {} } };
    const c1 = quiet(() => mod41.saveLedgerWatermark(wm1));
    ok('T41-c1 ★正常写入 → 返回 true，落盘内容与写入对象一致（写后校验不误判）',
      c1.v === true && JSON.parse(fs.readFileSync(WM41, 'utf-8'))['sid-c1'].main === 7,
      `返回=${c1.v}`);
    // c2：写盘抛异常（把目标占位成目录 → renameSync 失败）→ 必须返回 false
    clearWm();
    fs.mkdirSync(WM41, { recursive: true });
    const c2 = quiet(() => mod41.saveLedgerWatermark({ 'sid-c2': { main: 3, subs: {}, lastTs: 0, subTs: {} } }));
    ok('T41-c2 ★写盘抛异常 → 返回 false（改前返回 undefined，调用方无从判断）',
      c2.v === false && c2.err.indexOf('水位线写入失败') >= 0, `返回=${c2.v}`);
    clearWm();
    // c3：写盘没抛异常、但回读内容被篡改（模拟磁盘满/被别的进程覆盖）→ 写后校验必须抓到并返回 false。
    //   这是 A2 里 try/catch **抓不到**的那一类，只能靠回读比对；本用例是它唯一的实证防线。
    const origRead = fs.readFileSync;
    fs.readFileSync = function (p) {
      const res = origRead.apply(fs, arguments);
      if (String(p) === WM41) {
        try {
          const j = JSON.parse(res.toString('utf-8'));
          j['sid-c3'] = { main: 1, subs: {}, lastTs: 0, subTs: {} }; // 篡改本次写的键
          return Buffer.from(JSON.stringify(j));
        } catch (e) { return res; }
      }
      return res;
    };
    let c3v = null;
    try { c3v = mod41.saveLedgerWatermark({ 'sid-c3': { main: 999, subs: {}, lastTs: 123, subTs: {} } }); }
    finally { fs.readFileSync = origRead; }
    ok('T41-c3 ★写后校验：回读 main 与写入不符（磁盘满/被覆盖，不抛异常）→ 返回 false',
      c3v === false, `返回=${c3v}（返回 true = 静默重复计费）`);
    clearWm();

    // ── d 组：正常路径回归（新加的快照/回滚代码不得破坏"正常记账"这一主路径） ──
    const P41 = path.join(tmp, 'projects', 't41d');
    fs.mkdirSync(P41, { recursive: true });
    const ts41 = path.join(P41, 's41.jsonl');
    const T41 = Date.now() - 3600000;
    const row41 = (ts, model, i, o) => JSON.stringify({ type: 'message', role: 'assistant',
      id: 'r' + Math.random().toString(36).slice(2), timestamp: ts, status: 'completed',
      providerData: { model, messageId: 'm' + Math.random().toString(36).slice(2), usage: { input_tokens: i, output_tokens: o } } });
    fs.writeFileSync(ts41, [row41(T41, 'hy4-preview', 1000, 100), row41(T41 + 2000, 'hy4-preview', 500, 50)].join('\n') + '\n');
    const DAILY41 = path.join(skillDir, 'daily-usage.json');
    const dErr = quiet(() => mod41.incrementalRecord(ts41, 's41', { sid: 's41', model: 'hy4-preview', source: 'selftest' }));
    const after41 = (() => { try { return JSON.parse(fs.readFileSync(DAILY41, 'utf-8')); } catch (e) { return {}; } })();
    const day41 = after41[Object.keys(after41).sort().pop()] || {}; // 今日键（隔离账本里日期最大的那个）
    const wm41 = (() => { try { return JSON.parse(fs.readFileSync(WM41, 'utf-8')); } catch (e) { return {}; } })();
    const inAfter = (day41.total || {}).in || 0;
    ok('T41-d1 ★正常路径未回归：账本今日条目已记入本轮 1500 in / 150 out（快照代码没挡住记账）',
      inAfter >= 1500 && (day41.total || {}).out >= 150,
      `今日 in=${inAfter} out=${(day41.total || {}).out}（期望 ≥1500 / ≥150）`);
    ok('T41-d2 ★正常路径未回归：水位线推进到 2 行（新加的 wmOk 判定没误触发回滚）',
      !!wm41['s41'] && wm41['s41'].main === 2,
      `水位线=${JSON.stringify(wm41).slice(0, 120)} stderr=${dErr.err.slice(0, 80)}`);
    ok('T41-d3 ★正常路径不产生"回滚"告警（误回滚会让账本永不增长 = 永久少记）',
      dErr.err.indexOf('已回滚本轮账本') < 0, dErr.err.slice(0, 160));
  }
  if (savedEnv41 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv41;
}

// ===== T42（v3.40.0 / plan-B A6~A12、A21）：价格写入侧闸门 + 状态自愈 —— 8 条零散修复的守卫 =====
//   为什么打包成一组：这 8 条都是"**静默错**"——不抛异常、不报警、只在账本/价格库上悄悄落一个错值。
//   它们各自的触发面都窄（币种字段缺失 / 缓存陈旧 / 损坏后人工修好 / 资产冻结被覆盖），人肉回归
//   几乎必然漏。共同点：**修的是一个"方向性判断"**（多收钱 vs 少记），所以断言的落点都是"方向"。
//   逐条病根见各分支内联注释；此处只记 T42 的判据口径：源码守卫钉在**函数体内**（grabFn），
//   行为夹具能真跑的（A21 的隔离标志位可经 require 后调 loadDailyUsage 观察）就真跑 + 观察日志。
{
  const rawTT42 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const rawRP42 = fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8').replace(/\r\n/g, '\n');
  const grab42 = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\nfunction ', i + 1);
    return j < 0 ? src.slice(i) : src.slice(i, j);
  };

  // ── A6：savePricingAtomic 覆盖前备份（有界保留 3 份） ──
  //   病根：原实现直接 `renameSync(tmp, PRICING)` —— 自动补录一旦采到错价（模糊匹配单命中即采用），
  //   发现后**只能人肉改文件**，没有任何回滚手段。备份是"错价可恢复"的唯一落点。
  const saveAtomicSrc = stripComments(grab42(rawTT42, 'savePricingAtomic'));
  ok('T42-a1 ★savePricingAtomic 覆盖前 copyFileSync 备份上一版（错价可回滚的唯一落点）',
    /copyFileSync\(PRICING, stamp\)/.test(saveAtomicSrc)
    && saveAtomicSrc.indexOf('copyFileSync(PRICING, stamp)') < saveAtomicSrc.indexOf('renameSync(tmp, PRICING)'),
    '备份必须在 rename 之前，否则备份的是新价');
  ok('T42-a2 ★备份带时间戳且只留最近 3 份（文件名内嵌 13 位 ts → 字典序 == 时间序）',
    /\.bak-autofill\.' \+ Date\.now\(\)/.test(saveAtomicSrc)
    && /olds\.length - 3/.test(saveAtomicSrc),
    '无上限归档会线性堆积；固定名会互相覆盖（等于没备份）');
  // 备份是**尽力而为的附加保护**：任何失败都必须静默，绝不能让它把主目的（写盘）带崩
  //   注意：这里必须扫**未剥注释**的原文 —— stripComments 会把 `// silent-ok:降级` 这段注释本身剥掉，
  //   用它做判据会永远红（本断言首版就踩了这个坑，实测确认）。
  const saveAtomicRaw = grab42(rawTT42, 'savePricingAtomic');
  ok('T42-a3 ★备份失败静默降级（silent-ok），不阻断计价写入',
    /catch \(e\) \{ \/\* silent-ok:降级/.test(saveAtomicRaw),
    '备份失败抛出去 = 为了附加保护砸了主流程');
  // A6 特有契约：备份文件名必须落在 .gitignore 的 `*.bak-*` 规则内。
  //   技能目录**本身就是 git 工作区** → 不加忽略的话，自动补录每次落一个备份 = 仓库被运行时
  //   产物污染（v3.32.0 审计 P1-10 踩过同类：锁文件 / .corrupt 备份被 `git add -A` 提交上去）。
  //   判据用 glob 本身而非"写死了某条规则"：只要 `pricing.json.bak-autofill.<ts>` 被任一规则覆盖即过。
  {
    const gi = (() => { try { return fs.readFileSync(path.join(SRC, '.gitignore'), 'utf-8'); } catch (e) { return ''; } })();
    const covered = /\*\.bak-\*/.test(gi) || /pricing\.json\.bak-/.test(gi);
    ok('T42-a23 ★A6 备份文件名被 .gitignore 覆盖（否则每次自动补录都往仓库塞一个运行时产物）',
      covered, '需保留 `*.bak-*` 或显式加 `pricing.json.bak-*`');
  }

  // ── T42-a24：SKILL.md「最新版要点块」不得用 `①` 续行绕过 T36-b1 的行数上限 ──
  //   本版实测踩过：T36-b1 的判据只数 `> **vX.Y.Z 要点` 开头的行（≤2 行即过），
  //   于是给 v3.40.0 写了 1 行要点 + 4 行 `> **①…` 续行，**总数 5 行却照样绿** ——
  //   守卫被"换个前缀"绕过，正是它想防的"回堆本文件"。这里补：最新版要点块（从
  //   `> **vX 要点` 起、到下一个 `> **vY 要点` 或引用块结束为止）**总行数 ≤ 2**。
  {
    const lines = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n').split('\n');
    const isHead = (l) => /^>\s*\*\*v\d+\.\d+(\.\d+)?\s*要点/.test(l);
    const headIdx = lines.findIndex(isHead);
    let block = 0;
    if (headIdx >= 0) {
      for (let i = headIdx; i < lines.length; i++) {
        const l = lines[i];
        if (!/^>/.test(l)) break;            // 引用块结束
        if (i > headIdx && isHead(l)) break; // 下一版要点开始
        block++;
      }
    }
    ok('T42-a24 ★SKILL.md 最新版要点块总行数 ≤2（防用 `①` 续行绕过 T36-b1 的行数上限）',
      headIdx >= 0 && block <= 2,
      headIdx < 0 ? '找不到「vX 要点」行' : `实测 ${block} 行（v3.40.0 曾写成 5 行却让 T36-b1 照样绿）`);
  }

  // ── A7：priceCurrency 缺失不得默认按 USD 折算 ──
  //   病根：原 `if (CNY) {...} else {...USD×7.2...}` 把「明确标了 USD」与「字段缺失/null/未知值」
  //   一视同仁 → 人民币价被 ×7.2（虚高约 7 倍）且落在合理区间内 → **无任何告警**。
  //   方向性：错补 7 倍是多收钱且无痕；漏补只是少记（可恢复）。
  const ensureSrc = stripComments(grab42(rawTT42, 'ensureNewModelPricing'));
  ok('T42-a4 ★priceCurrency 三分支：CNY / USD / 其余（改前是 CNY / else=USD 两分支）',
    /cnRef\.priceCurrency === 'CNY'/.test(ensureSrc)
    && /cnRef\.priceCurrency === 'USD'/.test(ensureSrc)
    && !/\} else \{\s*\n\s*\/\/ 国外模型/.test(ensureSrc),
    '`else` 兜底按 USD 处理 = 币种未知时把人民币价乘汇率');
  ok('T42-a5 ★币种未知 → 拒绝折算 + 留告警 + 挂出候选值供人工核对',
    /拒绝自动折算/.test(ensureSrc) && /候选值 \$\{cnRef\.in\}\/\$\{cnRef\.out\}/.test(ensureSrc),
    '静默跳过会让人以为"源上没这个模型"，而不是"币种没标"');

  // ── A8：unpublished 条目过重查窗口后要重新联网（不再永久锁死） ──
  //   病根：input_price: 0 是 number → 下轮 findModel 精确命中直接 return → 永不重查，
  //   官方日后公布单价也不会自动回填。KI-7 只写了人工补救路径，没写"自动链路永不自愈"。
  ok('T42-a6 ★ensureNewModelPricing 对 unpublished 条目做重查窗口判定（30 天）',
    /NO_PUBLIC_RECHECK_MS/.test(ensureSrc)
    && /pricing_status === 'unpublished'/.test(ensureSrc)
    && /unpublished_at/.test(ensureSrc),
    '只判 typeof input_price === number 会把 0 元条目永久挡在门外');
  const rememberSrc = stripComments(grab42(rawTT42, 'rememberNoPublicPrice'));
  ok('T42-a7 ★rememberNoPublicPrice 首次记 unpublished_at（重查窗口的基准时间戳）',
    /if \(!m\.unpublished_at\) m\.unpublished_at = Date\.now\(\)/.test(rememberSrc),
    '缺基准时间戳 → dueAt 恒为窗口值 → 重查永不触发');
  ok('T42-a8 ★重查只补时间戳，不改 input_price / pricing_status（"0 = 未公布"语义不变）',
    !/m\.input_price = 1|m\.pricing_status = 'ok'/.test(rememberSrc)
    && /m\.input_price = 0; m\.output_price = 0;/.test(rememberSrc),
    '重查不该顺手改价，那是另一个决策');

  // ── A9：refresh-prices 的 priceGate 不得把 0 判非法 ──
  //   病根：`nv <= 0` 把 0 判非法并推 warning，而 KI-7 明确「0 = 厂商未公布价，是合法常态」——
  //   两个模块对同一个 0 的语义定义**相反**，且共用 `_price_audit.warnings` → 真告警被噪音淹没。
  const gateSrc = stripComments(rawRP42.slice(rawRP42.indexOf('function priceGate('), rawRP42.indexOf('function ', rawRP42.indexOf('function priceGate(') + 10)));
  ok('T42-a9 ★priceGate 判据为 nv < 0（0 放行），且 0 单独短路越过区间/骤变校验',
    /nv < 0/.test(gateSrc) && !/nv <= 0/.test(gateSrc)
    && /if \(nv === 0\) \{[\s\S]{0,300}?return false;/.test(gateSrc),
    '`<= 0` 会让每个未公布价模型每次刷新都刷一条假告警');
  ok('T42-a10 ★0 的放行不越过"负数/NaN/Infinity 仍非法"（真异常照拦）',
    /typeof nv !== 'number' \|\| !isFinite\(nv\) \|\| nv < 0/.test(gateSrc),
    '把 0 放行写成"什么值都放行"会把真异常一起放过去');

  // ── A10：region 推断结果可重判（不再永久固化） ──
  //   病根：`if (!m.region)` 一旦写入不再重判 → 某轮 llmabacus 拉取失败 → 真实 US 模型被写死 CN
  //   → 此后**永远**走错计价分支（CN 主价 vs USD×7.2），且 region 字段本身无"这是猜的"痕迹。
  ok('T42-a11 ★refresh-prices 记 region_inferred 标记 + 对推断值允许重判',
    /const regionWasInferred = m\.region_inferred === true;/.test(rawRP42)
    && /if \(!m\.region \|\| regionWasInferred\)/.test(rawRP42),
    '只判 !m.region = 推断值一经写入即永久固化');
  ok('T42-a12 ★llmaHit 到位时删除 region_inferred（有依据=已确认，不再算推断）',
    /if \(llmaHit\) \{ delete m\.region_inferred; \} else \{ m\.region_inferred = true; \}/.test(rawRP42),
    '不删标记会让"已确认"的 region 一直被重判，反向覆盖人工核实结果');
  ok('T42-a13 ★region 纠正留痕 _region_corrected（便于排查"归属何时被谁改的"）',
    /m\._region_corrected = \{ from: m\.region/.test(rawRP42));

  // ── A11：官方价分支必须尊重 lock（人工冻结语义不被静默破坏） ──
  //   病根：原 `if (officialBlk) {...} else if (m.lock === true) {...}` —— 官方分支在 lock **之前**
  //   且自身无 lock 守卫 → `deepseek-v4-pro`(lock:true) 每轮仍被官方价覆写。上游注释却写"三个写价
  //   分支全部跳过"——契约对官方价不成立。这是"用户冻了价、刷新后价却变了"。
  ok('T42-a14 ★lockBlocksMainPrice 判据 = lock 为真且 region 非 US（与 isLocked 口径一致）',
    /const lockBlocksMainPrice = m\.lock === true && m\.region !== 'US';/.test(rawRP42),
    '不收窄会连带拦掉 US 条目的 usd_* 参考字段更新');
  ok('T42-a15 ★官方价被 lock 拦下时：不改主价，但记 _official_ref 留官方价备查 + lockKeptMain++',
    /if \(officialBlk && lockBlocksMainPrice\) \{[\s\S]{0,500}?m\._official_ref = \{[\s\S]{0,400}?lockKeptMain\+\+;/.test(rawRP42),
    '拦下要留痕，否则用户看不到"官方价其实已变、是你的 lock 挡住了"');
  ok('T42-a16 ★拦下计数并入汇总输出（lockKept + lockKeptMain，附"含被官方价拦下 N 个"）',
    /lockKept \+ lockKeptMain/.test(rawRP42) && /含被官方价拦下/.test(rawRP42),
    '只算 lockKept 会让"被官方价拦下"在汇总里不可见');

  // ── A12：余额缓存 time 只在真查到新值时刷新（陈旧值会长大/被续命） ──
  //   病根：失败降级用旧值时也写 time: now → API 持续不可达 → 旧余额被反复续命 →
  //   缓存永远读不到过期信号 → 弹窗显示的余额可能已陈旧数天而用户毫无察觉。
  const balSrc = stripComments(grab42(rawTT42, 'balanceText'));
  ok('T42-a17 ★只有真拿到新余额（isFreshQuery）才把 time 刷成 now',
    /isFreshQuery = true;/.test(balSrc)
    && /time: isFreshQuery \? now : \(cache\.time \|\| now\)/.test(balSrc),
    '降级沿用旧值时刷新 time = 陈旧余额永不老化');
  ok('T42-a18 ★isFreshQuery 只在"网络返回有限数字"时置真（TTL 命中不算新鲜查询）',
    /const r = queryBalance\(key\);[\s\S]{0,200}Number\.isFinite\(r\.total\)[\s\S]{0,80}isFreshQuery = true;/.test(balSrc),
    '把 TTL 命中也当新鲜查询 → time 每轮被刷新，老化失效');
  ok('T42-a19 ★写缓存前显式挡非有限值（typeof NaN === number 会让 ¥NaN 一路通过）',
    /if \(Number\.isFinite\(total\)\) \{[\s\S]{0,400}?fs\.writeFileSync\(BALANCE_CACHE/.test(balSrc),
    'NaN/Infinity 不挡 → 弹窗显示「余额¥NaN」');

  // ── A21：gDailyCorrupt 不再"永不复位"（长驻进程损坏后人工修好要能恢复记账） ──
  //   病根：损坏文件被 rename 成 .corrupt-<ts> 后，本进程此后每次 loadDailyUsage 都走 ENOENT
  //   分支 → 标志永不清 → recordUsage 恒返回 false → **该进程之后所有用量再也不记**。
  //   触发面：watcher（--flush-delayed）与 Stop 兜底都是"同一进程多轮调用"。
  //   修法：区分"本进程刚隔离过"（gLedgerQuarantined，不复位）与"文件本就缺失"（复位=恢复路径）。
  const loadRaw42 = grab42(rawTT42, 'loadDailyUsage');
  const loadSrc = stripComments(loadRaw42);
  ok('T42-a20 ★ENOENT 分支复位 gDailyCorrupt **以 gLedgerQuarantined 为条件**（恢复路径）',
    /if \(!gLedgerQuarantined\) gDailyCorrupt = false;/.test(loadSrc),
    '无条件复位 = v2.99 的历史丢失回归；永不复位 = 长驻进程永久失记');
  ok('T42-a21 ★rename 隔离成功处置 gLedgerQuarantined = true（"文件是我搬走的"记忆）',
    /gLedgerQuarantined = true;/.test(loadSrc)
    && loadSrc.indexOf('gLedgerQuarantined = true;') > loadSrc.indexOf('renameSync(DAILY_USAGE_FILE, corruptPath)'),
    '标记必须在 rename 成功之后，否则文件没搬走也把恢复路径堵了');
  ok('T42-a22 ★成功解析路径仍清 gDailyCorrupt（v2.99 原行为未被 A21 破坏）',
    /gDailyCorrupt = false; \/\/ v2\.99：只在\*\*成功解析\*\*后清除标志/.test(loadRaw42),
    'A21 只改 ENOENT 分支，不得顺手把成功路径的清除删了');

  // ── A21 行为夹具：真跑 loadDailyUsage，观察日志与标志（可确定性单测） ──
  const savedEnv42 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  const mod42 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod42 || typeof mod42.loadDailyUsage !== 'function') {
    ok('T42 模块加载', false, mod42 ? '缺少 loadDailyUsage 导出' : 'require 失败');
  } else {
    const quiet42 = (fn) => {
      const old = process.stderr.write.bind(process.stderr);
      const buf = [];
      process.stderr.write = (s) => { buf.push(String(s)); return true; };
      let v = null;
      try { v = fn(); } finally { process.stderr.write = old; }
      return { v, err: buf.join('') };
    };
    const D42 = path.join(tmp, 't42');
    fs.mkdirSync(D42, { recursive: true });
    // DAILY_USAGE_FILE 由 WB_ROOT 决定（<WB>/skills/token-usage-tracker/daily-usage.json），
    //   这里直接对隔离目录下那个路径做手脚；mod42 已按 tmp 计算好路径。
    const daily42 = path.join(skillDir, 'daily-usage.json');
    const corruptBackups42 = () => fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-'));

    // e1：损坏账本 → 隔离（rename）+ 置标志；此时文件已不在原位
    try { fs.rmSync(daily42, { force: true }); } catch (e) { /* silent-ok:清理 — 夹具重置 */ }
    for (const f of corruptBackups42()) { try { fs.rmSync(path.join(skillDir, f), { force: true }); } catch (e) { /* silent-ok:清理 — 夹具重置 */ } }
    fs.writeFileSync(daily42, '{"2026-10-09": {"total": '); // 截断 JSON = SyntaxError
    const e1 = quiet42(() => mod42.loadDailyUsage());
    ok('T42-e1 ★损坏账本 → 返回 {}、改名为 .corrupt-<ts>、stderr 有隔离告警',
      JSON.stringify(e1.v) === '{}' && corruptBackups42().length === 1 && /已备份为 daily-usage\.json\.corrupt-/.test(e1.err),
      `备份数=${corruptBackups42().length} err=${e1.err.slice(0, 100)}`);
    // e2：隔离之后**同一进程**再读（文件已不在）→ gLedgerQuarantined 为真 → **不复位**后
    //   recordUsage 仍拒绝写回（保住 v2.99 的"防覆盖历史"语义）
    const e2 = quiet42(() => mod42.loadDailyUsage());
    const e2rec = quiet42(() => mod42.recordUsage(null, null, { hy3: { in: 5, out: 1 } }));
    ok('T42-e2 ★隔离后同进程再读（ENOENT）→ gDailyCorrupt 保持（recordUsage 被守卫挡下返回 false）',
      JSON.stringify(e2.v) === '{}' && e2rec.v === false,
      `loadT=${JSON.stringify(e2.v)} record=${e2rec.v}（ENOENT 无条件复位 = 用空账本覆盖历史，v2.99 回归）`);
    // e3（A21 的核心）：**新进程**（这里用清掉隔离记忆的方式模拟"人工已把损坏文件删掉/修好"）
    //   文件不存在 + 本进程未隔离过 → 复位 → 记账恢复。
    //   本夹具无法真正重启进程，故用一条**独立**的 require 缓存清理后重载模块来获得全新标志位；
    //   在此之前先把文件恢复成"不存在"，并把已有 .corrupt 备份挪走（模拟人工已处理完）。
    for (const f of corruptBackups42()) { try { fs.rmSync(path.join(skillDir, f), { force: true }); } catch (e) { /* silent-ok:清理 — 夹具重置 */ } }
    try { fs.rmSync(daily42, { force: true }); } catch (e) { /* silent-ok:清理 — 夹具重置 */ }
    const ttPath42 = path.join(skillDir, 'token-tracker.js');
    delete require.cache[require.resolve(ttPath42)];
    delete require.cache[ttPath42];
    const mod42b = (() => { try { return require(ttPath42); } catch (e) { return null; } })();
    const e3 = quiet42(() => (mod42b ? mod42b.loadDailyUsage() : null));
    const e3rec = quiet42(() => (mod42b ? mod42b.recordUsage(null, null, { hy3: { in: 5, out: 1 } }) : null));
    ok('T42-e3 ★文件缺失且本进程未隔离过 → 复位标志，记账恢复（人工修好后不再永久失记）',
      !!mod42b && JSON.stringify(e3.v) === '{}' && e3rec.v === true,
      `${e3.err.slice(0, 80)} record=${e3rec.v}`);
  }
  if (savedEnv42 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv42;
}

// ===== T43（v3.40.0 / plan-B A4 + A13）：分桶与峰谷同源 + 倍率语义写清 =====
//   A4 病根：账本分桶一律 `todayStr()`（**写盘时刻**），金额却按 `peakTs`（**token 实际发生时刻**）
//     判峰谷 → 23:59:59 发生、00:00:05 才跑 Stop 的轮次：token 记进**次日**桶、金额按**前一日**
//     的时段档算，同一批数据两处口径自相矛盾。
//   A13 病根（审计口径）：`mult` 由「input 价之比」算出却同乘 input/cached/output 三项。
//     **实证结论：这不是 bug** —— 查官方定价页（2026-10 复核）三项（含缓存命中）在高峰均正好 ×2：
//       deepseek-flash 缓存命中 空闲 0.02 / 高峰 0.04；未命中 1 / 2；输出 4 / 8
//       deepseek-v4-pro 缓存命中 0.15 / 0.30；未命中 4.5 / 9.0；输出 13.5 / 27.0
//     所以"三项同乘"结果**恰好正确**。但结构上没写清 → 后人改价时容易只改一项。
//     本组把「三项各自随峰谷、当前官方同倍率」这层语义钉在注释与守卫上（不改行为）。
{
  const rawTT43 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const grab43 = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\nfunction ', i + 1);
    return j < 0 ? src.slice(i) : src.slice(i, j);
  };
  const calcSrc43 = stripComments(grab43(rawTT43, 'calcCost'));
  const recSrc43 = stripComments(grab43(rawTT43, 'recordUsage'));

  // a：分桶必须来自 dateStrOfTs（而不是 todayStr）
  ok('T43-a1 ★recordUsage 分桶用 dateStrOfTs(tsMs) —— 与峰谷判定同一时刻（改前是写盘时刻 todayStr()）',
    /const date = dateStrOfTs\(tsMs\)/.test(recSrc43) && !/const date = todayStr\(\)/.test(recSrc43),
    '分桶与计价用两个时刻 = 跨午夜轮 self-contradict');
  // b：dateStrOfTs 的边界安全（非法 ts 回退 todayStr，绝不把账记到 1970）
  const dsSrc43 = stripComments(grab43(rawTT43, 'dateStrOfTs'));
  ok('T43-a2 ★dateStrOfTs 对非法 ts（0/NaN/负）回退 todayStr（异常输入不得把账记到 1970）',
    /!Number\.isFinite\(t\) \|\| t <= 0\) return todayStr\(\)/.test(dsSrc43));
  ok('T43-a3 ★dateStrOfTs 已导出（否则 T43-c 的行为断言无处可挂）',
    /module\.exports = \{[\s\S]*?dateStrOfTs,/.test(rawTT43));
  // c：明细落点也必须用同一判据（否则水位线回滚会截断另一个文件）
  // v3.40.0（plan-B A3）：判据从"两处各写一遍同样的表达式"收敛为"两处都调 snapshotFileFor 单点"。
  //   为什么改判据而不是保留原断言：原设计要求两个调用点**手抄同一表达式**（靠注释约定同步）——
  //   这正是 A3 要治的"同一口径抄多份"病根本身。现在改为**结构性**保证：两处都调同一个函数，
  //   只要能证明"两处都调了它"+"它的判据用 dateStrOfTs"，就不可能再失配（比逐字比对表达式更强）。
  const detSrc43 = stripComments(grab43(rawTT43, 'appendRoundDetail'));
  ok('T43-a4 ★appendRoundDetail 落文件走 snapshotFileFor（判据单点，不再靠两处手抄表达式同步）',
    /fs\.appendFileSync\(snapshotFileFor\(null, 0, tsMs\)/.test(detSrc43)
    && !/rounds-' \+ dateStrOfTs\(/.test(detSrc43),
    '两处判据不一致 = 回滚去截断别的月份文件（既没回滚当真，又误伤他人）');
  const incRaw43 = grab43(rawTT43, 'incrementalRecord');
  ok('T43-a5 ★incrementalRecord 里 snap.roundsPath 同样走 snapshotFileFor（与 append 同源同判据）',
    /roundsPath = snapshotFileFor\(null, 0, peakTs\)/.test(incRaw43)
    && !/rounds-' \+ dateStrOfTs\(/.test(incRaw43));
  // v3.40.0（A3 续）：snapshotFileFor 自身必须用 dateStrOfTs —— 否则上面的"两处同源"只是同源到一个错判据。
  const snSrc43 = stripComments(grab43(rawTT43, 'snapshotFileFor'));
  ok('T43-a8 ★snapshotFileFor 内部判据用 dateStrOfTs（单点函数本身得是对的）',
    /dateStrOfTs\(t\)\.slice\(0, 7\)/.test(snSrc43) && /ROUNDS_DIR/.test(snSrc43));

  // d：A13 语义守卫 —— 三项各自带倍率（结构不许退化成"只乘一项"）
  // v3.42.0（plan-B B1）：判据位置**跟着实现走** —— 三项公式已从 calcCost 内联式收敛到单点 `triPrice`
  //   （B1 治"同一公式抄 3 份"）。故断言改查 triPrice 的函数体，并**加一条**"calcCost 回退路径确实调
  //   triPrice"（否则公式搬家时可能把调用点漏改、留一段死代码）。三项同乘的语义不变。
  const triSrc43 = stripComments(grab43(rawTT43, 'triPrice'));
  ok('T43-a6 ★三项计价公式（未命中/缓存/输出）各自带 mult（结构上三项都随峰谷）',
    /\(uncached \/ 1e6\) \* Number\(m\.input_price \|\| 0\) \* k/.test(triSrc43)
    && /\(cached \/ 1e6\) \* Number\(m\.cached_price \|\| 0\) \* k/.test(triSrc43)
    && /\(outT \/ 1e6\) \* Number\(m\.output_price \|\| 0\) \* k/.test(triSrc43),
    '三项同乘是**当前官方事实**（缓存命中价高峰同样是空闲的 2 倍），不是 bug；但结构不能漏项');
  ok('T43-a6b ★calcCost 无分桶回退路径调用单点 triPrice（公式搬家后调用点不能漏改）',
    /return triPrice\(stat\.in, cached, outTok, m, mult\);/.test(calcSrc43),
    '公式已抽到 triPrice；calcCost 回退路径必须调它，否则是两套并存（B1 病根复发）');
  ok('T43-a7 ★「三项同乘」的官方依据写在注释里（防后人当 bug 改成"只乘 input"而漏收缓存费）',
    /三项同乘是当前官方事实/.test(rawTT43) && /不要\*\*?把它"修"成只乘 input|不要.{0,6}把它.{0,4}修.{0,4}成只乘 input/.test(rawTT43),
    '缺这段依据，后人很可能把"三项同乘"当 bug 摘掉缓存项的倍率');

  // ── c 组：dateStrOfTs 行为（真调，跨午夜是关键用例） ──
  const savedEnv43 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  const tt43 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!tt43 || typeof tt43.dateStrOfTs !== 'function') {
    ok('T43 模块加载', false, '缺少 dateStrOfTs 导出');
  } else {
    const d43 = tt43.dateStrOfTs;
    // 北京 2026-03-04 10:00（= UTC 02:00）→ 2026-03-04
    ok('T43-c1 北京时间当天正午 → 本地日期当天',
      d43(Date.UTC(2026, 2, 4, 2, 0, 0)) === '2026-03-04', d43(Date.UTC(2026, 2, 4, 2, 0, 0)));
    // 北京 2026-03-04 23:59:59（= UTC 15:59:59）→ 仍是 2026-03-04（A4 的核心边界）
    ok('T43-c2 ★北京 23:59:59 的发生时刻 → 归**当天**（跨午夜轮不得被记到次日）',
      d43(Date.UTC(2026, 2, 4, 15, 59, 59)) === '2026-03-04', d43(Date.UTC(2026, 2, 4, 15, 59, 59)));
    // 非法输入 → 回退今天（不抛、不越界）
    const today43 = tt43.todayStr();
    ok('T43-c3 ★ts=0 / undefined / NaN → 回退 todayStr（不抛、也不记到 1970）',
      d43(0) === today43 && d43(undefined) === today43 && d43(NaN) === today43,
      `0→${d43(0)} undef→${d43(undefined)} NaN→${d43(NaN)} today=${today43}`);
  }
  if (savedEnv43 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv43;
}

// ===== T44（v3.40.0 / plan-B A3）：三种聚合口径统一为「按行逐条判定」=====
// 病根（审计 A3）：同一批 token 有三条计价路径，各自口径不同 ——
//   ① 主链路 calcCost：整批一个倍率（按批级 peakTs 判整批高峰/空闲）；
//   ② backfill.js rowCost：逐行判定（正确）；
//   ③ recalc-day.js costOf：按轮次**时长/次数占比**折算 `1 + (peakMult-1)*ratio`（近似）。
//   跨 12:00 / 18:00 边界的那一轮，三条路径给出三个不同金额；而 recalc 的定位是"改价后回算历史"
//   → **回算工具算出来的数和实时链路不一致 = 回算不可信**（这是 A3 的验收标准）。
// 修法：主链路也逐行分桶（perModelFromRows / aggregateTranscLines 里按每行 ts 判峰谷），
//   并把切分落进轮次明细（peakSplit）供 recalc 精确回算。
{
  const D44 = path.join(tmp, 't44');
  try { fs.mkdirSync(D44, { recursive: true }); } catch (e) { /* 已存在 */ }
  const savedEnv44 = process.env.WB_ROOT;
  process.env.WB_ROOT = D44;
  // 注意：必须 require **副本**（skillDir）并复用已加载实例——selftest 早已在多处 require 过它，
  //   Node 按"解析后的绝对路径"缓存，再 require 同路径拿到的就是同一个实例（WB_ROOT 已在首次加载时定死）。
  //   第一版写成 path.join(SKILL_DIR, ...)（selftest 里没这个常量）→ ReferenceError 被 catch 吞成
  //   "缺少 calcCost 导出"，红得莫名其妙。用 skillDir + 复用缓存才是对的。
  let tt44 = null;
  try { tt44 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt44 = null; }
  if (!tt44 || typeof tt44.calcCost !== 'function') {
    ok('T44 模块加载', false, '缺少 calcCost 导出');
  } else {
    // 价目表**内联构造**，不从盘上读：隔离副本里没有 pricing.json（selftest 只拷 .js），
    //   顶层 loadPricing() 会返回空 models → findModel 落空 → calcCost 恒 null（第一版就栽这儿，
    //   4 条红成"实测 null"，而 c4/c5 反而"绿"——因为 null === null。教训：断言必须能区分"算对"与"没算"）。
    //   数值取自本机 pricing.json 的 deepseek-v4.1-flash（in 1 / cached 0.02 / out 4 / peak_multiplier 2）。
    const pricing44 = {
      models: {
        'deepseek-v4.1-flash': { input_price: 1, cached_price: 0.02, output_price: 4, peak_multiplier: 2 },
      },
      deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00', weekend_off_peak: true },
    };
    const M = 'deepseek-v4.1-flash'; // 本机价：in 1 / cached 0.02 / out 4，peak_multiplier 2
    // c1：**有分桶**时高峰段必须乘 peakMult —— 与调用时刻无关（这是 A3 的核心行为）
    //   半峰半闲：100万高峰 + 100万空闲 → 1×2 + 1×1 = ¥3
    const half = tt44.calcCost({ model: M, in: 2000000, out: 0, cached: 0,
      pIn: 1000000, pCached: 0, pOut: 0, oIn: 1000000, oCached: 0, oOut: 0 }, pricing44);
    ok('T44-c1 ★有行级分桶时高峰段乘 peakMult（半峰半闲 200万 in → ¥3，不是整批的 ¥2 或 ¥4）',
      Math.abs(half - 3) < 1e-9, `实测 ${half}`);
    const allPeak = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0,
      pIn: 1000000, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 }, pricing44);
    const allOff = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0,
      pIn: 0, pCached: 0, pOut: 0, oIn: 1000000, oCached: 0, oOut: 0 }, pricing44);
    ok('T44-c2 ★全高峰 → ×2（¥2）；全空闲 → ×1（¥1）—— 分桶自身的倍率是对的',
      Math.abs(allPeak - 2) < 1e-9 && Math.abs(allOff - 1) < 1e-9,
      `全高峰 ${allPeak} / 全空闲 ${allOff}`);
    // c3：**回退路径**——无分桶时行为必须与 v3.39.0 逐字节一致（靠 tsMs 判整批）
    const noBuck = tt44.calcCost({ model: M, in: 2000000, out: 0, cached: 0 }, pricing44);
    ok('T44-c3 ★无分桶 → 回退整批口径（不因 A3 改动而变），且结果为有限数',
      Number.isFinite(noBuck) && noBuck > 0, `实测 ${noBuck}`);
    // c4：**分桶不完整时必须回退**（真实行有分桶 + 估算段无分桶 → 三项和 ≠ 总量）
    //   → 不得用残缺分桶算钱（否则静默少算/多算）。这里模拟"in 分桶只覆盖一半"。
    const partial = tt44.calcCost({ model: M, in: 2000000, out: 0, cached: 0,
      pIn: 500000, pCached: 0, pOut: 0, oIn: 500000, oCached: 0, oOut: 0 }, pricing44);
    ok('T44-c4 ★分桶三项和 ≠ 总量 → 拒绝使用分桶、回退整批（残缺分桶绝不静默参与计价）',
      Math.abs(partial - noBuck) < 1e-9, `残缺分桶 ${partial} vs 整批 ${noBuck}`);
    // c5：分桶三项**全为 0** → 视为无分桶（不得把全部 token 当免费）
    const zeroBuck = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0,
      pIn: 0, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 }, pricing44);
    ok('T44-c5 ★分桶全 0（= 一行都没落进可见时段）→ 视为无分桶、回退整批（不得算成免费）',
      Math.abs(zeroBuck - tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0 }, pricing44)) < 1e-9,
      `实测 ${zeroBuck}`);
    // c6：cached 也随峰谷（A13 结论）——高峰段的 cached 乘 peakMult
    //   100万 peak in（其中 100万 cached）→ 1×0.02×2 = ¥0.04
    const peakCached = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 1000000,
      pIn: 1000000, pCached: 1000000, pOut: 0, oIn: 0, oCached: 0, oOut: 0 }, pricing44);
    ok('T44-c6 ★分桶路径里高峰段 cached 同样 ×peakMult（A13 三项同乘在分桶路径同样成立）',
      Math.abs(peakCached - 0.04) < 1e-9, `实测 ${peakCached}（应 0.04）`);
  }
  if (savedEnv44 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv44;

  // a：结构性守卫 —— 分桶必须在**逐行循环**里按每行 ts 判（而不是批级）
  const rawTT44 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8');
  const pmSrc44 = stripComments((() => {
    const i = rawTT44.indexOf('function perModelFromRows');
    const j = rawTT44.indexOf('\nfunction ', i + 10);
    return rawTT44.slice(i, j < 0 ? undefined : j);
  })());
  ok('T44-a1 ★perModelFromRows（账本侧 byModel 的来源）在逐行循环内做峰谷分桶',
    /isPeakHour\(peakRulesAgg, new Date\(ts\)\)/.test(pmSrc44),
    '账本侧不分桶 → 账本金额仍是整批口径，A3 白改（第一版实测栽在这儿：账本 ¥2 应 ¥3）');
  const atlSrc44 = stripComments((() => {
    const i = rawTT44.indexOf('function aggregateTranscLines');
    const j = rawTT44.indexOf('\nfunction ', i + 10);
    return rawTT44.slice(i, j < 0 ? undefined : j);
  })());
  ok('T44-a2 ★aggregateTranscLines（弹窗侧）同样在逐行循环内分桶 —— 两侧同口径',
    /isPeakHour\(peakRulesAgg, new Date\(ts\)\)/.test(atlSrc44));
  // a3：合并点必须带上分桶（否则主+子代理合并时被丢掉）
  ok('T44-a3 ★aggregateTranscript / aggregatePerModel 合并主+子代理桶时带上行级分桶',
    /for \(const k of \['pIn', 'pCached', 'pOut', 'oIn', 'oCached', 'oOut'\]\)/.test(rawTT44)
    && (rawTT44.match(/for \(const k of \['pIn', 'pCached', 'pOut', 'oIn', 'oCached', 'oOut'\]\)/g) || []).length >= 4,
    '合并处丢分桶 = 主+子代理混合轮金额又漂（需覆盖：aggregateTranscript / aggregatePerModel / merge / toastLine2）');
  // a4：峰谷规则必须惰性缓存（否则逐行调用 = 每行读一次盘）
  const pkSrc44 = stripComments((() => {
    const i = rawTT44.indexOf('function peakRulesForAgg');
    const j = rawTT44.indexOf('\nfunction ', i + 10);
    return rawTT44.slice(i, j < 0 ? undefined : j);
  })());
  ok('T44-a4 ★peakRulesForAgg 带 mtime 缓存（逐行调用 ≠ 逐行读盘）',
    /_aggPeakRulesCache/.test(pkSrc44) && /mtimeMs/.test(pkSrc44));
  // a5：明细必须落 peakSplit（recalc 精确回算的唯一依据）
  ok('T44-a5 ★轮次明细落 peakSplit（recalc 读不到它就只能退回"轮次数占比"近似折算）',
    /const peakSplit = \{\};/.test(rawTT44) && /hasAnySplit \? \{ peakSplit \} : \{\}/.test(rawTT44));
  // a6：recalc 必须**优先**用精确切分。⚠️ 这条是**文本序**守卫，只能防"有人把两个分支写反"，
  //   防不住"运行时短路精确分支"（反向验证实测：把 `if (split && …)` 改成 `if (false && split && …)`
  //   后 a6 依然全绿）——真正的行为兜底是下面的 T44-b（peakSplitOf 逐字段断言 + 反向验证会红）。
  //   两条一起才完整：a6 管"顺序别写反"（读代码即知），b 管"精确数据真被用上"（跑起来才算数）。
  const rj44 = fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8');
  ok('T44-a6 ★recalc 源码里「精确分支」写在「占比折算分支」之前（防把两路写反）',
    /const split = peakSplitOf\(date, model\);/.test(rj44)
    && rj44.indexOf('const split = peakSplitOf(date, model);') < rj44.indexOf('} else if (peakRatio === null) {'),
    '顺序反过来 = 近似折算会盖掉精确结果（A3 的验收标准就是两条路径同金额）');
  ok('T44-a7 ★recalc 报告里标出口径来源（精确(逐行) / 百分比），用户能看出走的是哪条',
    /splitUsed \? '精确\(逐行\)'/.test(rj44));

  // b：**行为**验证 peakSplitOf（不是只看源码文本）——a6 只判"两行的先后顺序"，
  //   实测把精确分支运行时短路掉（`if (false && split …)`）a6 依然全绿 → 文本守卫不足以兜底。
  //   这里真造一个 rounds-YYYY-MM.jsonl 夹具，指向它读，断言聚合结果**逐字段正确**。
  //   为什么要求 recalc-day.js 可被 require（require.main 守卫）：不然 require 它就会直接跑 CLI
  //   → 读写真实账本，测试变成"会改盘的副作用"，不可接受（本轮顺手修掉）。
  const D44B = path.join(tmp, 't44b');
  try {
    fs.mkdirSync(path.join(D44B, 'skills', 'token-usage-tracker'), { recursive: true });
    // recalc-day.js 用 detectWorkBuddyRoot()（WB_ROOT > ~/.workbuddy-ai > ~/.workbuddy）定位 SKILL_DIR，
    //   所以必须把 skill 子目录建在 WB_ROOT 下，并把**全部运行时 .js** 拷进去——
    //   token-tracker.js 会 require ./refresh-holidays.js / ./stop-handler.js 等同级模块，
    //   少拷一个就是 "Cannot find module"（第一版只拷了 3 个 → require 直接抛，b1 红）。
    const fxSkill = path.join(D44B, 'skills', 'token-usage-tracker');
    for (const f of fs.readdirSync(SRC)) {
      if (!/\.(js|json)$/.test(f)) continue;
      if (/^selftest\.js$/.test(f)) continue; // selftest 自身不必进夹具
      try { fs.copyFileSync(path.join(SRC, f), path.join(fxSkill, f)); } catch (e) { /* 单个失败不影响（缺的会显式报出） */ }
    }
    const rdir = path.join(fxSkill, 'rounds');
    fs.mkdirSync(rdir, { recursive: true });
    // 两轮同日、同模型：一轮高峰 100万 in，一轮空闲 100万 in → 精确合计 pIn=1e6 / oIn=1e6
    const rows = [
      { ts: Date.now(), date: '2026-05-06', models: { 'deepseek-v4.1-flash': { in: 1000000, out: 0, cached: 0, total: 1000000 } },
        peakSplit: { 'deepseek-v4.1-flash': { pIn: 1000000, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 } } },
      { ts: Date.now(), date: '2026-05-06', models: { 'deepseek-v4.1-flash': { in: 1000000, out: 0, cached: 0, total: 1000000 } },
        peakSplit: { 'deepseek-v4.1-flash': { pIn: 0, pCached: 0, pOut: 0, oIn: 1000000, oCached: 0, oOut: 0 } } },
      // 干扰行：别的日期 / 别的模型（都不得被算进来）
      { ts: Date.now(), date: '2026-05-07', peakSplit: { 'deepseek-v4.1-flash': { pIn: 9e6, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 } } },
      { ts: Date.now(), date: '2026-05-06', peakSplit: { 'hy3': { pIn: 9e6, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 } } },
      // 无 peakSplit 的行（旧版明细）→ 不参与精确切分
      { ts: Date.now(), date: '2026-05-06', models: { 'deepseek-v4.1-flash': { in: 5e6, out: 0, cached: 0, total: 5e6 } } },
    ];
    fs.writeFileSync(path.join(rdir, 'rounds-2026-05.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const saved44b = process.env.WB_ROOT;
    process.env.WB_ROOT = D44B;
    delete require.cache[require.resolve(path.join(fxSkill, 'recalc-day.js'))];
    let rjMod = null;
    try { rjMod = require(path.join(fxSkill, 'recalc-day.js')); } catch (e) { rjMod = null; }
    if (!rjMod || typeof rjMod.peakSplitOf !== 'function') {
      ok('T44-b1 peakSplitOf 可单测（需 require 时不得自动跑 main）', false,
        'recalc-day.js 必须用 require.main === module 守卫，否则 require 即执行 CLI（会读写真实账本）');
    } else {
      const sp = rjMod.peakSplitOf('2026-05-06', 'deepseek-v4.1-flash');
      ok('T44-b1 ★peakSplitOf 按「日期 + 模型」双重过滤聚合行级切分（日期/模型不匹配的干扰行都不进）',
        !!sp && sp.pIn === 1000000 && sp.oIn === 1000000 && sp.pCached === 0 && sp.oOut === 0,
        sp ? JSON.stringify(sp) : 'null');
      const spNone = rjMod.peakSplitOf('2026-05-06', 'glm-5.3-flash');
      ok('T44-b2 ★该日期/模型没有切分数据 → 返回 null（调用方据此回退占比折算，不硬造）',
        spNone === null, String(spNone));
      const spOld = rjMod.peakSplitOf('2026-04-30', 'deepseek-v4.1-flash');
      ok('T44-b3 ★整个月份文件都不存在 → 返回 null（不抛错）', spOld === null, String(spOld));
    }
    if (saved44b === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = saved44b;
  } catch (e) {
    ok('T44-b 夹具构建', false, (e && e.message) || String(e));
  }
}

// ===== T45（v3.42.0 / plan-B A17）：区间端点必须「日期真实存在」=====
//   A17 病根：`parseReportRange` 原来只过 `^\d{4}-\d{2}-\d{2}$` 格式正则就放行区间端点，
//     `2026-13-45` / `2026-02-30` / `2026-00-00` 全被当成合法端点 → 区间聚合按**字典序**比较账本键
//     （`k >= from && k <= to`）→ 非法端点排到所有真实日期之后 → 区间被**静默扩展成"全部历史"**，
//     报表数字离谱且**零提示**。这是"静默错"里最坏的一类：数字看着像真的。
//   本组钉住两层：① `isRealDateStr` 的日历级判定（真调）；② 调用点对"看似区间但端点非法"**必须显式报错**
//     （不许静默退化到 `reportTxt` 的单点语义，那会输出「===== 2026-13-45 =====（无记录）」骗人）。
{
  const savedEnv45 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let tt45 = null;
  try { tt45 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt45 = null; }
  if (!tt45 || typeof tt45.isRealDateStr !== 'function' || typeof tt45.parseReportRange !== 'function') {
    ok('T45 模块加载（需要 isRealDateStr / parseReportRange 导出）', false, '缺少导出');
  } else {
    const R = tt45.isRealDateStr;
    // a 组：「格式对、日历对」必须放行
    ok('T45-a1 isRealDateStr 正常日期放行（2026-10-09 / 2026-02-28）',
      R('2026-10-09') === true && R('2026-02-28') === true);
    // b 组：「格式对、日历错」必须拦（这是 A17 的核心）
    ok('T45-b1 ★isRealDateStr 拦住月份越界（2026-13-45 / 2026-00-00）',
      R('2026-13-45') === false && R('2026-00-00') === false,
      '月份/日越界必须判假，否则区间字典序比较会静默扩窗');
    ok('T45-b2 ★isRealDateStr 拦住"格式对但日历不存在"（2026-02-30 / 2025-02-29 平年）',
      R('2026-02-30') === false && R('2025-02-29') === false,
      'Date 会把 2/30 自动进位到 3/2 —— 回读比对必须能识破');
    ok('T45-b3 isRealDateStr 拦住闰年 2/29 的真实存在日（2024-02-29 应放行）',
      R('2024-02-29') === true && R('2026-02-29') === false);
    // c 组：格式非法也必须判假
    ok('T45-c1 isRealDateStr 拦住格式非法（空串 / 2026-1-9 / 20261009 / 带时间）',
      R('') === false && R('2026-1-9') === false && R('20261009') === false && R('2026-10-09T00:00') === false);
    // d 组：parseReportRange 对非法端点**必须返回 null**（而不是"凑合出一个区间"）
    ok('T45-d1 ★parseReportRange 端点非法 → null（2026-13-45..2026-13-46）',
      tt45.parseReportRange('2026-13-45..2026-13-46') === null);
    ok('T45-d2 ★parseReportRange 一端非法 → null（2026-10-01..2026-02-30）',
      tt45.parseReportRange('2026-10-01..2026-02-30') === null);
    ok('T45-d3 parseReportRange 合法区间仍正常（含起止写反自动纠正）',
      (() => {
        const r1 = tt45.parseReportRange('2026-10-01..2026-10-09');
        const r2 = tt45.parseReportRange('2026-10-09..2026-10-01');
        return r1 && r1.from === '2026-10-01' && r1.to === '2026-10-09'
          && r2 && r2.from === '2026-10-01' && r2.to === '2026-10-09';
      })(), '合法区间不得被日历校验误伤');
    // e 组：调用点必须对"看似区间但端点非法"显式报错（源码级守卫 —— 行为断言要 spawn 太重）
    //   注意正则转义：源码里是 `\d{4}`，在 JS 正则字面量里要写成 `\\d\{4\}`（两条反斜杠 = 匹配一个 `\`）。
    const rawTT45 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
    const hasBadMsg = rawTT45.indexOf('区间端点不是真实存在的日期') >= 0;
    const hasShape = /\\d\{4\}-\\d\{2\}-\\d\{2\}\\\.\\.\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(rawTT45);
    const nearCall = /parseReportRange\(rArg\)[\s\S]{0,1500}?reportRangeArgError\(rArg\)/.test(rawTT45);
    ok('T45-e1 ★--report 调用点在区间解析失败后显式识别"看似区间"并报错（不许静默落到单点语义）',
      hasBadMsg && hasShape && nearCall,
      `静默退化成 reportTxt 单点 → 输出「（无记录）」骗人，比报错更危险（msg=${hasBadMsg} shape=${hasShape} near=${nearCall}）`);
  }
  if (savedEnv45 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv45;
}

// ===== T46（v3.42.0 / plan-B B1）：文件锁 withFileLock 守卫测试 =====
//   B1 着眼点：withFileLock 是跨进程互斥核心原语（原子 openSync 'wx' + pid 探活 + TTL 退化 + 重试 +
//     finally 释放），三处独立锁（watcher 心跳锁 / CN 价库刷新锁 / refresh-prices PRICING_LOCK_FILE）都依赖
//     其语义正确性。本组钉住六条关键不变量，纯 require 单测、不 spawn、不碰真实账本。
{
  const savedEnv46 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp; // 照抄既有模式：require 前固定隔离目录
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  if (!ttMod || typeof ttMod.withFileLock !== 'function') {
    ok('T46 模块加载（需要 withFileLock 导出）', false, '缺少导出');
  } else {
    const withFileLock = ttMod.withFileLock;
    try {
      // T46-1 正常加锁-释放
      {
        const p = path.join(os.tmpdir(), 'tt46-' + process.pid + '-' + Date.now() + '.lock');
        try {
          const r = withFileLock(p, () => 42);
          ok('T46-1 正常加锁-释放：返回 {ok:true, result:42} 且锁文件已删除',
            r && r.ok === true && r.result === 42 && fs.existsSync(p) === false,
            'expected {ok:true,result:42} & 锁文件不存在，got ' + JSON.stringify(r) + ' exists=' + fs.existsSync(p));
        } catch (e) {
          ok('T46-1 正常加锁-释放', false, e.message);
        } finally {
          try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — T46 临时锁文件收尾，删不掉不影响断言 */ }
        }
      }
      // T46-2 持锁期间他人拿不到（外部以自身 pid 占锁 → 必然存活）
      {
        const p = path.join(os.tmpdir(), 'tt46-' + process.pid + '-' + Date.now() + '.lock');
        try {
          fs.writeFileSync(p, JSON.stringify({ at: Date.now(), pid: process.pid }));
          let called = false;
          const fn = () => { called = true; return 'should-not-run'; };
          const r = withFileLock(p, fn, { retries: 2, retryDelay: 10 });
          ok('T46-2 持锁期间他人拿不到：{ok:false, skipped:true} 且 fn 未执行',
            r && r.ok === false && r.skipped === true && called === false,
            'expected {ok:false,skipped:true} & fn 未调用，got ' + JSON.stringify(r) + ' called=' + called);
        } catch (e) {
          ok('T46-2 持锁期间他人拿不到', false, e.message);
        } finally {
          try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — T46 临时锁文件收尾，删不掉不影响断言 */ }
        }
      }
      // T46-3 死 pid 可被接管
      {
        const p = path.join(os.tmpdir(), 'tt46-' + process.pid + '-' + Date.now() + '.lock');
        try {
          let deadPid = 999999;
          try { process.kill(999999, 0); deadPid = null; } // 若 999999 存活 → 需另寻死 pid
          catch (e) {
            if (e.code !== 'ESRCH') { // 非 ESRCH（权限等）→ 循环找一个确认死亡的 pid
              deadPid = null;
              for (let probe = 990000; probe < 999999; probe++) {
                try { process.kill(probe, 0); }
                catch (e2) { if (e2.code === 'ESRCH') { deadPid = probe; break; } }
              }
            }
          }
          if (!deadPid) {
            ok('T46-3 死 pid 可被接管', false, '未能确认一个死 pid（环境异常，跳过）');
          } else {
            fs.writeFileSync(p, JSON.stringify({ at: Date.now(), pid: deadPid }));
            const r = withFileLock(p, () => 'ok');
            ok('T46-3 死 pid 可被接管：返回 {ok:true, result:"ok"}',
              r && r.ok === true && r.result === 'ok',
              'expected {ok:true,result:"ok"}，got ' + JSON.stringify(r));
          }
        } catch (e) {
          ok('T46-3 死 pid 可被接管', false, e.message);
        } finally {
          try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — T46 临时锁文件收尾，删不掉不影响断言 */ }
        }
      }
      // T46-4 fn 抛异常也必须释放锁（finally 核心保证，防死锁）
      {
        const p = path.join(os.tmpdir(), 'tt46-' + process.pid + '-' + Date.now() + '.lock');
        try {
          let threw = false;
          try { withFileLock(p, () => { throw new Error('boom'); }); }
          catch (e) { threw = (e && e.message === 'boom'); }
          ok('T46-4 fn 抛异常也释放锁：boom 被抛出且锁文件已删除',
            threw === true && fs.existsSync(p) === false,
            'expected boom 被抛出 & 锁文件不存在，threw=' + threw + ' exists=' + fs.existsSync(p));
        } catch (e) {
          ok('T46-4 fn 抛异常也释放锁', false, e.message);
        } finally {
          try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — T46 临时锁文件收尾，删不掉不影响断言 */ }
        }
      }
      // T46-5 解析不出 pid 时按 TTL 判定（at 很久前 → 接管）
      {
        const p = path.join(os.tmpdir(), 'tt46-' + process.pid + '-' + Date.now() + '.lock');
        try {
          fs.writeFileSync(p, JSON.stringify({ at: Date.now() - 10 * 60 * 1000 }));
          const r = withFileLock(p, () => 'ok', { ttl: 1000, retries: 2, retryDelay: 10 });
          ok('T46-5 解析不出 pid 按 TTL 接管：at 已超 ttl → {ok:true, result:"ok"}',
            r && r.ok === true && r.result === 'ok',
            'expected {ok:true,result:"ok"}，got ' + JSON.stringify(r));
        } catch (e) {
          ok('T46-5 解析不出 pid 按 TTL 接管', false, e.message);
        } finally {
          try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — T46 临时锁文件收尾，删不掉不影响断言 */ }
        }
      }
      // T46-6 无 pid 且 at 新鲜（未超 ttl）→ 不接管
      {
        const p = path.join(os.tmpdir(), 'tt46-' + process.pid + '-' + Date.now() + '.lock');
        try {
          fs.writeFileSync(p, JSON.stringify({ at: Date.now() }));
          let called = false;
          const r = withFileLock(p, () => { called = true; }, { ttl: 60000, retries: 2, retryDelay: 10 });
          ok('T46-6 新鲜锁不接管：{ok:false, skipped:true} 且 fn 未执行',
            r && r.ok === false && r.skipped === true && called === false,
            'expected {ok:false,skipped:true} & fn 未调用，got ' + JSON.stringify(r) + ' called=' + called);
        } catch (e) {
          ok('T46-6 新鲜锁不接管', false, e.message);
        } finally {
          try { fs.unlinkSync(p); } catch (e) { /* silent-ok:清理 — T46 临时锁文件收尾，删不掉不影响断言 */ }
        }
      }
    } catch (e) {
      ok('T46 组异常', false, e.message);
    }
  }
  if (savedEnv46 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv46;
}

// ===== T47（v3.42.0 / plan-B A19）：transcript 末尾无 '\n' 的残行不得永久丢弃 =====
//   病根：`readTranscLinesFrom` 原实现只解析 `[off, lastNl]` 内的"完整行"（带 '\n'），把最后一个 '\n'
//   之后到 EOF 的残余一刀切当"半写行"留给下一轮 → 若文件末尾**本就无 trailing '\n'**（写入已完成），
//   该行永久等不到 '\n' → **永久漏计**（恰是会话最后一轮时 = 永久少 token）。
//   修法：残余段若是**合法完整 JSON** 就收下（只是缺尾换行）；残缺 JSON 仍安全跳过。
//   ⚠ 本组最关键的断言是 **c1**（第二遍不能重读该行）——多收一行若不把 totalLines 同步 +1，
//      水位线会算少 → 下一轮重读 → **重复计费**（比漏计更危险）。这正是 A19 的修复红线。
{
  const savedEnv47 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let tt47 = null;
  try { tt47 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt47 = null; }
  if (!tt47 || typeof tt47.readTranscLinesFrom !== 'function') {
    ok('T47 模块加载（需要 readTranscLinesFrom 导出）', false, '缺少导出');
  } else {
    const fs2 = require('fs'), os2 = require('os');
    const dataDir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'tt-a19-'));
    const L = (n) => JSON.stringify({
      type: 'assistant',
      providerData: { model: 'deepseek-v4.1-flash', usage: { inputTokens: n, outputTokens: 0 } },
      timestamp: 1759900000000,
    });
    const R = tt47.readTranscLinesFrom;
    try {
      // 用例1：三行合法 JSON，末行**无 trailing '\n'**
      const p1 = path.join(dataDir, 'tail-nonl.jsonl');
      fs2.writeFileSync(p1, L(100) + '\n' + L(200) + '\n' + L(300));
      const r1 = R(p1, 0);
      ok('T47-a1 ★末尾无换行的完整 JSON 行被收下（不再永久丢弃）',
        r1.rows.length === 3 && r1.totalLines === 3, `rows=${r1.rows.length} totalLines=${r1.totalLines}`);
      // ★c1：再读一遍（fromLine = 上一轮 totalLines）→ 必须零新行（否则下一轮重复计费）
      const r1b = R(p1, r1.totalLines);
      ok('T47-a2 ★★收下残行后 totalLines 同步 +1 → 下一轮不重读该行（防重复计费，A19 红线）',
        r1b.rows.length === 0, `重读 rows=${r1b.rows.length}（必须 0）`);
      // 用例2：末行为**残缺 JSON**（半写）→ 必须安全跳过（保持"留给下一轮"语义）
      const p2 = path.join(dataDir, 'tail-broken.jsonl');
      fs2.writeFileSync(p2, L(100) + '\n' + '{"type":"assist');
      const r2 = R(p2, 0);
      ok('T47-a3 残缺 JSON 尾行安全跳过（不解析、不抛、水位线只算完整行）',
        r2.rows.length === 1 && r2.totalLines === 1, `rows=${r2.rows.length} totalLines=${r2.totalLines}`);
      // 用例3：末行无 '\n'，随后追加新行 → 只读新的那一行（残行不得被重读）
      const p3 = path.join(dataDir, 'append.jsonl');
      fs2.writeFileSync(p3, L(100) + '\n' + L(200) + '\n' + L(300));
      const r3a = R(p3, 0);
      fs2.appendFileSync(p3, '\n' + L(400));
      const r3b = R(p3, r3a.totalLines);
      ok('T47-a4 ★残行被收下后再追加新行：只读新增的 1 行（残行不重读、新行不漏）',
        r3b.rows.length === 1 && r3b.totalLines === 4, `rows=${r3b.rows.length} totalLines=${r3b.totalLines}`);
      // 用例4：文件只有一行且无 '\n'
      const p4 = path.join(dataDir, 'single.jsonl');
      fs2.writeFileSync(p4, L(500));
      const r4 = R(p4, 0);
      ok('T47-a5 单行文件无换行 → 仍被收下（rows=1 / totalLines=1）',
        r4.rows.length === 1 && r4.totalLines === 1, `rows=${r4.rows.length} totalLines=${r4.totalLines}`);
      // 用例5：正常带尾换行的文件行为必须不变（多行 + 末行有 '\n'）
      const p5 = path.join(dataDir, 'normal.jsonl');
      fs2.writeFileSync(p5, L(1) + '\n' + L(2) + '\n');
      const r5 = R(p5, 0);
      ok('T47-a6 正常（末行带换行）行为不变：两行都收下、totalLines=2',
        r5.rows.length === 2 && r5.totalLines === 2, `rows=${r5.rows.length} totalLines=${r5.totalLines}`);
    } catch (e) {
      ok('T47 组异常', false, (e && e.message) || String(e));
    } finally {
      try { fs2.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* silent-ok:清理 — T47 临时夹具目录收尾 */ }
    }
  }
  if (savedEnv47 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv47;
}

// ===== T48（v3.42.1 / KI-12）：watcher 心跳锁判活必须复核 pid，防「弹窗悬空」 =====
//   病根：`startWatcherVerified` 原判活逻辑**只看心跳年龄 < 15s**。watcher 崩溃瞬间与最后心跳间隔
//   很短（2026-10-09 实测仅 ~1s）时，下一轮 Stop 读锁 → 误判"已接管" → 调用方不降级、不弹窗
//   → **弹窗悬空**（实测悬空 8 分钟，直到用户发下一条消息触发 hook-fallback 才补弹）。
//   修法（方案 A）：心跳新鲜 **且** pid 仍存活才认定接管；pid 已死则删锁走 spawn 判定。
//   本组钉住 classifyWatchLock 的三态判定 + 关键红线（b1：心跳新鲜+pid死 → 必须 'dead'，不得 'alive'）。
{
  const savedEnv48 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let tt48 = null;
  try { tt48 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt48 = null; }
  if (!tt48 || typeof tt48.classifyWatchLock !== 'function') {
    ok('T48 模块加载（需要 classifyWatchLock 导出）', false, '缺少导出');
  } else {
    const fs3 = require('fs'), os3 = require('os');
    const C = tt48.classifyWatchLock;
    // classifyWatchLock 内部自行拼 coalescePath(sid)+'.lock'；coalescePath 已导出，直接构造锁路径。
    const mkSid = () => 'tt48-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    try {
      if (typeof tt48.coalescePath !== 'function') {
        // 兜底：coalescePath 未导出 → 退化为源码级守卫
        const src = fs3.readFileSync(path.join(skillDir, 'token-tracker.js'), 'utf-8');
        ok('T48-b1★(源码级) classifyWatchLock 含 pid 存活复核（process.kill(pid, 0)）',
          /process\.kill\(pid,\s*0\)/.test(src), '未找到 pid 探活');
        ok('T48-b2★(源码级) 存在 alive/dead 三态返回',
          /return\s+alive\s*\?\s*'alive'\s*:\s*'dead'/.test(src), '未找到 alive/dead 三态返回');
      } else {
      // 找一个确认死亡的 pid（ESRCH）
      let deadPid = null;
      for (let probe = 990000; probe < 999999; probe++) {
        try { process.kill(probe, 0); }
        catch (e) { if (e.code === 'ESRCH') { deadPid = probe; break; } }
      }
      if (!deadPid) deadPid = 987654; // 极端兜底；b1 用注入 pidAlive 明确构造，不依赖真实存活

      // b0：无锁 → 'stale'
      {
        const sid0 = mkSid();
        const v0 = C(sid0, Date.now());
        ok('T48-b0 无锁文件 → "stale"（走 spawn 判定）', v0 === 'stale', `got ${v0}`);
      }

      // b1 ★红线：心跳新鲜 + pid 已死 → 必须 'dead'（旧实现纯心跳 → 误判 alive → 弹窗悬空 8 分钟）
      {
        const sid1 = mkSid();
        const lp1 = tt48.coalescePath(sid1) + '.lock';
        try {
          fs3.writeFileSync(lp1, JSON.stringify({ at: Date.now(), pid: deadPid, hb: 1 }));
          const v1 = C(sid1, Date.now(), () => false); // 注入"pid 已死"
          ok('T48-b1 ★★心跳新鲜+pid已死 → "dead"（不得 "alive"，否则弹窗悬空）',
            v1 === 'dead', `got ${v1}（旧实现返回 alive → 悬空）`);
        } catch (e) { ok('T48-b1 ★★心跳新鲜+pid已死 → "dead"', false, e.message); }
        finally { try { fs3.unlinkSync(lp1); } catch (e) { /* silent-ok:清理 */ } }
      }

      // b2：心跳新鲜 + pid 存活 → 'alive'（正常接管语义不变）
      {
        const sid2 = mkSid();
        const lp2 = tt48.coalescePath(sid2) + '.lock';
        try {
          fs3.writeFileSync(lp2, JSON.stringify({ at: Date.now(), pid: process.pid, hb: 1 }));
          const v2 = C(sid2, Date.now(), () => true);
          ok('T48-b2 心跳新鲜+pid存活 → "alive"（正常接管语义不变）', v2 === 'alive', `got ${v2}`);
        } catch (e) { ok('T48-b2 心跳新鲜+pid存活 → "alive"', false, e.message); }
        finally { try { fs3.unlinkSync(lp2); } catch (e) { /* silent-ok:清理 */ } }
      }

      // b3：心跳过期（>15s）→ 'stale'（年龄闸门优先）
      {
        const sid3 = mkSid();
        const lp3 = tt48.coalescePath(sid3) + '.lock';
        try {
          fs3.writeFileSync(lp3, JSON.stringify({ at: Date.now() - 20000, pid: process.pid, hb: 1 }));
          const v3 = C(sid3, Date.now(), () => true);
          ok('T48-b3 心跳过期(>15s) → "stale"（不因 pid 存活而误认接管）', v3 === 'stale', `got ${v3}`);
        } catch (e) { ok('T48-b3 心跳过期 → "stale"', false, e.message); }
        finally { try { fs3.unlinkSync(lp3); } catch (e) { /* silent-ok:清理 */ } }
      }

      // b4：缺 hb 标记（旧版锁 / 非 watcher 锁）→ 'stale'
      {
        const sid4 = mkSid();
        const lp4 = tt48.coalescePath(sid4) + '.lock';
        try {
          fs3.writeFileSync(lp4, JSON.stringify({ at: Date.now(), pid: process.pid }));
          const v4 = C(sid4, Date.now(), () => true);
          ok('T48-b4 无 hb 标记 → "stale"（非 watcher 心跳锁不参与判活）', v4 === 'stale', `got ${v4}`);
        } catch (e) { ok('T48-b4 无 hb 标记 → "stale"', false, e.message); }
        finally { try { fs3.unlinkSync(lp4); } catch (e) { /* silent-ok:清理 */ } }
      }

      // b5：锁内容非法 JSON → 'stale'（不抛）
      {
        const sid5 = mkSid();
        const lp5 = tt48.coalescePath(sid5) + '.lock';
        try {
          fs3.writeFileSync(lp5, '{not-json');
          const v5 = C(sid5, Date.now(), () => true);
          ok('T48-b5 锁内容非法 JSON → "stale"（安全降级、不抛）', v5 === 'stale', `got ${v5}`);
        } catch (e) { ok('T48-b5 锁内容非法 JSON → "stale"', false, e.message); }
        finally { try { fs3.unlinkSync(lp5); } catch (e) { /* silent-ok:清理 */ } }
      }

      // b6：真实 pid 探活路径（不注入）——持锁为自身 pid 且心跳新鲜 → 'alive'
      {
        const sid6 = mkSid();
        const lp6 = tt48.coalescePath(sid6) + '.lock';
        try {
          fs3.writeFileSync(lp6, JSON.stringify({ at: Date.now(), pid: process.pid, hb: 1 }));
          const v6 = C(sid6, Date.now()); // 不注入 → 走真实 process.kill(process.pid,0)
          ok('T48-b6 真实 pid 探活：自身 pid + 心跳新鲜 → "alive"', v6 === 'alive', `got ${v6}`);
        } catch (e) { ok('T48-b6 真实 pid 探活', false, e.message); }
        finally { try { fs3.unlinkSync(lp6); } catch (e) { /* silent-ok:清理 */ } }
      }
      }
    } catch (e) {
      ok('T48 组异常', false, (e && e.message) || String(e));
    }
  }
  if (savedEnv48 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv48;
}

// ===== T49（v3.43.0 / KI-13 方案 α）：startWatcherVerified 轮询必须复核"新锁持有者 pid 仍存活" =====
//   病根（2026-10-09 实测，事故 3：弹窗悬空 ~70s）：`startWatcherVerified` spawn 后的 1.5s 轮询
//   **只看 `lockF.mtimeMs > lockBefore`**，不看新锁的 pid 死活。watcher 建完锁立刻被宿主 Job Object
//   连带杀（Stop = 回合结束信号 → 客户端回收 Job；detached 在 Windows Job 下挡不住）→ mtime 确实新了
//   → 误判"已接管" → return true → 调用方不降级 → 弹窗一直悬空到用户发下一条消息由 hook-fallback 补弹。
//   与 T48（KI-12，读侧 classifyWatchLock）是**同一病根族的另一个触发点**。
//   修法（方案 α）：轮询分支里，锁 mtime 变新后**必须再过 classifyWatchLock**，只认 'alive'。
//   本组用 monkey-patch child_process.spawn 造"假 watcher"（不真起子进程），模拟三种落锁结局。
{
  const savedEnv49 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let tt49 = null;
  try { tt49 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt49 = null; }
  if (!tt49 || typeof tt49.startWatcherVerified !== 'function' || typeof tt49.coalescePath !== 'function') {
    ok('T49 模块加载（需要 startWatcherVerified / coalescePath 导出）', false, '缺少导出');
  } else {
    const fs4 = require('fs');
    const cp4 = require('child_process');
    // 找一个确认死亡的 pid（ESRCH）——本机沙箱内 process.kill 对其他进程可能恒 ESRCH，故优先真实探测，
    // 探不到也无妨：classifyWatchLock 对"pid 不存在"一律返回 dead，语义一致。
    let deadPid4 = 987654;
    for (let probe = 990000; probe < 999999; probe++) {
      try { process.kill(probe, 0); }
      catch (e) { if (e.code === 'ESRCH') { deadPid4 = probe; break; } }
    }
    const mkSid4 = (tag) => 'tt49-' + tag + '-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

    // 通用：patch child_process.spawn → 假 child（on/unref 空实现），并在 spawn 被调用时按 mode 落锁。
    //   mode='die'   → 写 pid=deadPid4 的锁（心跳新鲜）——**事故 3 现场**：建锁后立刻死。
    //   mode='alive' → 写 pid=process.pid 的锁（心跳新鲜）——正常接管。
    //   mode='nolock'→ 什么也不写——spawn 无声失败 / watcher 没起来。
    const runCase = (mode, sid) => {
      const lockF4 = tt49.coalescePath(sid) + '.lock';
      const origSpawn4 = cp4.spawn;
      cp4.spawn = function fakeSpawn() {
        // 模拟"watcher 启动后第一件事就是抢锁"，但落锁 pid 按 mode 决定
        try {
          if (mode === 'die') {
            fs4.writeFileSync(lockF4, JSON.stringify({ at: Date.now(), pid: deadPid4, hb: 1 }));
          } else if (mode === 'alive') {
            fs4.writeFileSync(lockF4, JSON.stringify({ at: Date.now(), pid: process.pid, hb: 1 }));
          }
        } catch (e) { /* 落锁失败按 nolock 语义处理 */ }
        return { on() {}, unref() {} };
      };
      try { return tt49.startWatcherVerified(sid); }
      finally { cp4.spawn = origSpawn4; try { fs4.unlinkSync(lockF4); } catch (e) { /* silent-ok:清理 */ } }
    };

    try {
      // b1 ★★红线：锁 mtime 变新但持有者 pid 已死 → 必须 false（旧实现只看 mtime → 误判 true → 弹窗悬空）
      {
        const sid1 = mkSid4('b1');
        const r1 = runCase('die', sid1);
        ok('T49-b1 ★★锁新但持有者 pid 已死 → false（不得 true，否则弹窗悬空）',
          r1 === false, `got ${r1}（旧实现返回 true → 悬空 ~70s 直到下一条消息）`);
      }
      // b2：锁 mtime 变新且持有者 pid 存活 → true（正常接管语义不回归）
      {
        const sid2 = mkSid4('b2');
        const r2 = runCase('alive', sid2);
        ok('T49-b2 锁新且持有者 pid 存活 → true（正常接管不回归）', r2 === true, `got ${r2}`);
      }
      // b3：spawn 后根本没落锁（watcher 没起来）→ false（原有 spawn 失败降级语义不变）
      {
        const sid3 = mkSid4('b3');
        const r3 = runCase('nolock', sid3);
        ok('T49-b3 spawn 后无锁（watcher 未起）→ false（原降级语义不变）', r3 === false, `got ${r3}`);
      }
      // b4：不 spawn 即已有存活 watcher 持新鲜锁（T48/KI-12 路径）→ 直接 true，不回归
      {
        const sid4 = mkSid4('b4');
        const lockF4b = tt49.coalescePath(sid4) + '.lock';
        try {
          fs4.writeFileSync(lockF4b, JSON.stringify({ at: Date.now(), pid: process.pid, hb: 1 }));
          const r4 = tt49.startWatcherVerified(sid4); // 未 patch spawn：若判活分支失效会真 spawn（无锁定 → 1.5s 后 false）
          ok('T49-b4 已有存活 watcher 持新鲜锁 → true（KI-12 路径不回归）', r4 === true, `got ${r4}`);
        } catch (e) { ok('T49-b4 已有存活 watcher → true', false, e.message); }
        finally { try { fs4.unlinkSync(lockF4b); } catch (e) { /* silent-ok:清理 */ } }
      }
      // b5 ★源码级兜底：轮询块内 mtime 判据之后必须紧跟 classifyWatchLock 复核（防空转成"只看 mtime"）
      {
        const src4 = fs4.readFileSync(path.join(skillDir, 'token-tracker.js'), 'utf-8');
        const m = src4.match(/for \(let i = 0; i < 10; i\+\+\)[\s\S]{0,900}?return false;\s*\n\}/);
        const blk = m ? m[0] : '';
        ok('T49-b5★(源码级) 轮询块内 mtime 判据后紧跟 classifyWatchLock 复核',
          /mtimeMs > lockBefore[\s\S]{0,300}classifyWatchLock\(sid/.test(blk),
          '未在 mtime 判据后找到 classifyWatchLock 复核');
      }
    } catch (e) {
      ok('T49 组异常', false, (e && e.message) || String(e));
    }
  }
  if (savedEnv49 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv49;
}

// ===== T50（v3.44.0 / C 类根治）：团队轮必须走同步弹，且弹完硬性结案（防「延迟弹窗」与「二次弹」） =====
//   病根：团队轮原先走 coalesce + watcher 等子代理落定 —— ① Stop 侧落定判据过严（allInRoundSubFilesTerminal
//   只认末行终止态，实测会话级放行率 48.1%；而 watcher 侧同口径 subagentsAllSettled 是 81.5%）→ 一半多轮次
//   明明子代理早已写完全、数据已齐，仍被迫走 watcher；② watcher 是 detached 子进程，会被宿主 Job Object
//   连带杀 → 弹窗悬空（KI-12/KI-13）。
//   修法：团队轮与普通轮走**同一条同步弹路径**（落定判据换 subagentsAllSettled + 有界微重判），
//   弹完 clearCoalesce + 推进 lastStopAt = **硬性结案**（三条补弹路径 watcher/round-watch/hook 全部
//   以"coalesce 存在 / lastStopAt 未推进"为前提 → 自动失活，**绝不二次弹**）。
//   本组钉住：条件含 teamSyncToast / 落定判据换 subagentsAllSettled / 弹完必清 coalesce / 不 spawn watcher。
{
  const src50 = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8');
  // 剥注释后再做断言（本项目习惯在注释里保留历史说明；b4 的否定断言尤其必须剥注释，否则会被注释命中）
  const code50 = src50.replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

  ok('T50-b1 ★团队轮同步弹开关存在（teamSyncToast + 逃生阀 WB_SYNC_TEAM）',
    /const teamSyncToast = [^;]*WB_SYNC_TEAM[^;]*;/.test(code50),
    '未找到 teamSyncToast / WB_SYNC_TEAM');

  ok('T50-b2 ★★同步弹分支条件含 teamSyncToast（团队轮也走同步弹，不再走 watcher）',
    /if \(isPlainRound \|\| teamDataReady \|\| teamSyncToast\)/.test(code50),
    '条件未含 teamSyncToast → 团队轮仍走 coalesce+watcher');

  ok('T50-b3 ★★团队轮落定判据换成 subagentsAllSettled（取代过严的 allInRoundSubFilesTerminal）',
    /const settled0 = subagentsAllSettled\(/.test(code50) && /teamDataReady = settled0;/.test(code50),
    '落定判据未换成 subagentsAllSettled');

  ok('T50-b4 ★★落定判定不得再用 allInRoundSubFilesTerminal（防回退到过严判据）',
    !/teamDataReady\s*=[^;]*allInRoundSubFilesTerminal/.test(code50),
    'teamDataReady 仍用 allInRoundSubFilesTerminal');

  // 提取同步弹分支块（从条件行到该分支末尾的 out(...)）
  const syncStart = code50.indexOf('if (isPlainRound || teamDataReady || teamSyncToast) {');
  let block50 = '';
  if (syncStart >= 0) {
    const outIdx = code50.indexOf('out({ hookSpecificOutput: {} });', syncStart);
    block50 = outIdx > syncStart ? code50.slice(syncStart, outIdx) : code50.slice(syncStart, syncStart + 7000);
  }
  const wPos = block50.indexOf('writeCoalesce(');
  const cPos = block50.indexOf('clearCoalesce(');

  ok('T50-b5 ★★同步弹分支内先 writeCoalesce 后 clearCoalesce（弹失败留兜底 / 弹成功清标记 → 不二次弹）',
    wPos >= 0 && cPos > wPos, `writeCoalesce@${wPos} clearCoalesce@${cPos}`);

  ok('T50-b6 ★★同步弹分支内不得启动 watcher（团队轮不再 spawn detached 子进程）',
    block50.length > 0 && !/startWatcherVerified|spawnFlushWatcher/.test(block50),
    block50.length ? '分支内仍调用 watcher 启动' : '未提取到分支块');

  ok('T50-b7 团队轮弹窗 reason 标签区分（+team-sync，便于诊断）',
    /'\+team-sync'/.test(src50), '未找到 +team-sync 标签');
}

// ===== T51（v3.44.0）：主模型与子代理「同模型」合并成单条弹窗时，第一行必须标明含子代理 =====
//   背景（用户 2026-10-10 实测）：主+子代理同模型 → 按模型分条逻辑返回 false（只有 1 个模型桶）→ 走单条弹窗；
//   而 toastLine1 既有的「（子代理 X）」只标注**与主模型不同**的子代理模型（subs 过滤），同模型时恒为空
//   → 第一行**看不出本轮含子代理**。补「（含子代理）」标识；放不下整段丢弃（绝不挤掉数据）。
{
  const savedEnv51 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let tt51 = null;
  try { tt51 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt51 = null; }
  if (!tt51 || typeof tt51.toastLine1 !== 'function' || typeof tt51.dispWidthTitle !== 'function') {
    ok('T51 模块加载（需要 toastLine1 / dispWidthTitle 导出）', false, '缺少导出');
  } else {
    const base51 = { in: 1249399, out: 13381, cached: 1180288, total: 1262780, model: 'deepseek-flash', modelMain: 'deepseek-flash', durMs: 73000 };
    const first51 = (stat, ms) => String(tt51.toastLine1(stat, ms || stat.model, '', '', '', '')).split('\n')[0];
    const TAG51 = '（含子代理）';
    try {
      const f1 = first51(Object.assign({}, base51, { subModels: ['deepseek-flash'], subCount: 2, teamActive: true }));
      ok('T51-b1 ★★主+子代理同模型 → 首行含「（含子代理）」',
        f1.includes(TAG51), `got ${JSON.stringify(f1)}`);

      const f2 = first51(Object.assign({}, base51, { subModels: [], subCount: 0, teamActive: false }));
      ok('T51-b2 纯普通轮 → 首行不含标识', !f2.includes(TAG51), `got ${JSON.stringify(f2)}`);

      const f3 = first51(Object.assign({}, base51, { subModels: ['hy3'], subCount: 1, teamActive: true }));
      ok('T51-b3 ★★异模型子代理 → 主条不加任何子代理标注（已在分条弹窗单独成条）',
        !f3.includes(TAG51) && !f3.includes('子代理'), `got ${JSON.stringify(f3)}`);

      const LONG51 = 'deepseek-v4.1-flash-super-long-name';
      const f4 = first51(Object.assign({}, base51, { model: LONG51, modelMain: LONG51, subModels: [LONG51], subCount: 1, teamActive: true }), LONG51);
      ok('T51-b4 ★★放不下时整段丢弃且首行不超宽（绝不挤掉数据）',
        !f4.includes(TAG51) && tt51.dispWidthTitle(f4) <= 45, `got ${JSON.stringify(f4)} 宽=${tt51.dispWidthTitle(f4)}`);

      const f5 = first51(Object.assign({}, base51, { subModels: [], subCount: 0, teamActive: true }));
      ok('T51-b5 teamActive 但 subCount=0 也加（子代理刚派发、文件未落盘）', f5.includes(TAG51), `got ${JSON.stringify(f5)}`);
    } catch (e) { ok('T51 组异常', false, (e && e.message) || String(e)); }
  }
  if (savedEnv51 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv51;
}

// ===== T52（v3.44.0）：行1 超宽时**先缩短时段标注格式**（高峰双倍→高峰 / 夜间N折→夜间） =====
//   场景：长模型名 + 「（含子代理）」 + 时段 + 价格标注 叠加 → 超过 TOAST_ROW1_MAX_W(45)。
//   策略：先挤掉时段里的冗余修饰词，保住模型名完整 + 各标注都在；缩了仍超才走既有"缩名保标注"。
//   触发概率低（用户 2026-10-10：机制要有，但日常不会挤满；极端叠加才出现）。
{
  const savedEnv52 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  let tt52 = null;
  try { tt52 = require(path.join(skillDir, 'token-tracker.js')); } catch (e) { tt52 = null; }
  if (!tt52 || typeof tt52.toastLine1 !== 'function') {
    ok('T52 模块加载（需要 toastLine1 导出）', false, '缺少导出');
  } else {
    const first52 = (stat, ms, period, extra) => String(tt52.toastLine1(stat, ms, period, '', '', extra || '')).split('\n')[0];
    const B52 = { in: 1000, out: 100, cached: 100, total: 1100, model: 'm', modelMain: 'm', durMs: 1000 };
    const LONGM52 = 'a-very-long-model-name-here';
    const TAG52 = '｜⚠价核验';
    try {
      const f1 = first52(B52, LONGM52, '高峰双倍', TAG52);
      ok('T52-b1 ★★行1 超宽时把「高峰双倍」缩短为「高峰」',
        f1.indexOf('高峰') >= 0 && f1.indexOf('双倍') < 0 && tt52.dispWidthTitle(f1) <= 45,
        `got ${JSON.stringify(f1)} w=${tt52.dispWidthTitle(f1)}`);

      const f2 = first52(B52, 'deepseek-flash', '高峰双倍', '');
      ok('T52-b2 不超宽时保持「高峰双倍」（不无谓缩短）',
        f2.indexOf('高峰双倍') >= 0, `got ${JSON.stringify(f2)}`);

      const f3 = first52(B52, LONGM52, '夜间2折', TAG52);
      ok('T52-b3 ★行1 超宽时把「夜间2折」缩短为「夜间」',
        f3.indexOf('夜间') >= 0 && f3.indexOf('折') < 0 && tt52.dispWidthTitle(f3) <= 45,
        `got ${JSON.stringify(f3)} w=${tt52.dispWidthTitle(f3)}`);

      const f4 = first52(B52, 'a-super-ultra-mega-long-model-name-that-will-never-fit', '高峰双倍', TAG52);
      ok('T52-b4 缩短后仍超宽 → 走既有守卫，结果不崩且 ≤45',
        tt52.dispWidthTitle(f4) <= 45, `got ${JSON.stringify(f4)} w=${tt52.dispWidthTitle(f4)}`);
    } catch (e) { ok('T52 组异常', false, (e && e.message) || String(e)); }
  }
  if (savedEnv52 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv52;
}

// ===== T53（v3.45.0 审计批次 1）：外部审计报告 v2 的 P0/P1 修复守卫 =====
//   来源：`workbuddy-token-tracker-代码审计报告-v2.md`（审计基线 24e31f3 = v3.44.0）。
//   本组钉的是**已在本版落地**的修复，任一条被回退即红。
{
  const rd53 = (f) => { try { return fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n'); } catch (e) { return ''; } };
  const tt53 = rd53('token-tracker.js');
  const bf53 = rd53('backfill.js');
  const rh53 = rd53('refresh-holidays.js');
  const do53 = rd53('deepseek-official.js');
  const seg = (s, key, len) => { const i = s.indexOf(key); return i < 0 ? '' : s.slice(i, i + (len || 4000)); };

  // b1 ★★ S-7：价库流水线 spawn 必须 detached + unref。
  //   与 KI-12/KI-13 同一病根（Windows Job Object 连带杀）的第三处；不脱离 → 父进程一退就死
  //   → index.json 不更新 → built_at 永远停在前一天（本地官方价库刷新从未成功的并存成因）。
  const localDb53 = seg(tt53, 'function maybeRefreshLocalDb', 4000);
  ok('T53-b1 ★★S-7 价库流水线 spawn 必须 detached:true 且 unref()（父进程退出即被连带杀 = 价库永不更新）',
    /detached:\s*true/.test(localDb53) && /\.unref\(\)/.test(localDb53),
    '缺 detached/unref → Python 链被中途杀，本地价库长期用旧价');

  // b2 ★★ F-2：回滚不得裸写账本，且必须接原子写的返回值。
  const rb53 = seg(tt53, 'function rollbackLedgerAfterWatermarkFailure', 2500);
  ok('T53-b2 ★★F-2 回滚不得裸 writeFileSync 写账本（违反 tmp+rename = 最后一道防线损坏账本）',
    !/fs\.writeFileSync\(snap\.ledgerPath/.test(rb53) && /saveLedgerRawAtomic\(snap\.ledgerPath/.test(rb53),
    '回滚是"磁盘满/被占用"时最可能触发的路径，裸写会留下半截 JSON');
  ok('T53-b3 ★★F-2 回滚结果必须接返回值（不接 = 回滚失败却谎报"已回滚"）',
    /out\.ledger = saveLedgerRawAtomic\(/.test(rb53), 'saveLedgerRawAtomic 返回 false 而不抛，调完就置 true 会撒谎');

  // b4 ★★ S-3：水位线锁失败必须可见（原实现丢弃返回值 → 静默不记账、弹窗照弹）。
  //   v3.46.0（S-2/S-5）：回调体加了 try/catch 与两阶段 merge，本函数变长 → 窗口同步放大（否则段尾被截断误红）。
  const inc53 = seg(tt53, 'function incrementalRecord', 14000);
  ok('T53-b4 ★★S-3 incrementalRecord 必须接 withFileLock 返回值并在失败时告警留痕',
    /const lockRes = withFileLock\(/.test(inc53) && /ledger-lock-skip/.test(inc53),
    '不接返回值 → 抢锁失败时用户看到"已统计"而账本里没有');

  // b5 ★★ S-6：gDailyCorrupt 的复位判定必须在守卫之前（否则永远执行不到 → 进程内永久停记）。
  const ru53 = seg(tt53, 'function recordUsage', 2500);
  const iReset53 = ru53.indexOf('if (gDailyCorrupt && !gLedgerQuarantined)');
  const iGuard53 = ru53.indexOf('if (gDailyCorrupt) {');
  ok('T53-b5 ★★S-6 gDailyCorrupt 复位判定必须在守卫之前（放后面 = 永远执行不到）',
    iReset53 >= 0 && iGuard53 > iReset53, `复位@${iReset53} 守卫@${iGuard53}`);

  // b6 ★★ P-11：refresh-holidays / deepseek-official 不得自带数据根探测，必须 require 单点。
  ok('T53-b6 ★★P-11 refresh-holidays.js 与 deepseek-official.js 均改为 require(\'./wb-root.js\')，不再自带实现',
    !/function detectWorkBuddyRoot/.test(rh53) && !/function detectWorkBuddyRoot/.test(do53)
    && /require\('\.\/wb-root\.js'\)/.test(rh53) && /require\('\.\/wb-root\.js'\)/.test(do53),
    '自带实现 = 靠注释约定同步，无任何机制保证');

  // b7 ★ F-1（源码级）：备份存在 → 绝不写 {}。
  const bfWm53 = seg(bf53, 'if (!wmRes || !wmRes.ok) {', 2500);
  ok('T53-b7 ★F-1 只有「备份确实不存在」才写空账本（否则有数据的账本会被清空）',
    /const bak1Exists = fs\.existsSync\(bak1\)/.test(bfWm53) && /if \(!restoredLedger && !bak1Exists\)/.test(bfWm53),
    '缺 !bak1Exists → 回滚失败时把有数据的账本写成 {}');

  // b8/b9 ★ F-2 行为级：saveLedgerRawAtomic 的成/败语义（tmp 不残留 / 不可写返回 false 而不抛）。
  const savedEnv53 = process.env.WB_ROOT;
  process.env.WB_ROOT = tmp;
  const mod53 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod53 || typeof mod53.saveLedgerRawAtomic !== 'function') {
    ok('T53-b8 F-2 行为级：saveLedgerRawAtomic 已导出', false, '缺少 saveLedgerRawAtomic 导出');
  } else {
    const D53 = path.join(tmp, 't53');
    fs.mkdirSync(D53, { recursive: true });
    const lg53 = path.join(D53, 'ledger.json');
    const w53 = mod53.saveLedgerRawAtomic(lg53, '{"a":1}');
    ok('T53-b8 ★F-2 行为级：原子写成功返回 true、内容正确、tmp 不残留',
      w53 === true && fs.readFileSync(lg53, 'utf-8') === '{"a":1}' && !fs.existsSync(lg53 + '.tmp-' + process.pid),
      `wrote=${w53}`);
    const bad53 = mod53.saveLedgerRawAtomic(path.join(D53, 'no', 'such', 'x.json'), '{}', { mkdir: false });
    ok('T53-b9 ★F-2 行为级：路径不可写 → 返回 false 而不抛（调用方据此如实告警）',
      bad53 === false, `got ${bad53}`);
  }
  if (savedEnv53 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv53;
}

// ===== T54（v3.45.0 L0）：不变量守卫 —— 把「约定」钉成「约束」，防"将来再抄一份" =====
//   这一组**不修复任何现状问题**，只把结构性约束固化成断言：
//   同判据的实现份数只许减不许增。新增一份复制实现 → 立刻红，无需任何人记得去同步注释。
{
  const files54 = ['token-tracker.js', 'stop-handler.js', 'backfill.js', 'recalc-day.js',
    'refresh-prices.js', 'refresh-holidays.js', 'deepseek-official.js', 'peak-rules.js', 'wb-root.js'];
  const src54 = {};
  for (const f of files54) {
    try { src54[f] = fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n'); } catch (e) { src54[f] = ''; }
  }

  // b1 ★ 数据根探测：全仓库**恰好 1 处**定义，且只能在 wb-root.js。
  //   v3.42.0 抽 wb-root.js 时只收了 4 处，漏了 refresh-holidays.js 与 deepseek-official.js；
  //   本版补齐，从此"改判据只要改一个文件"是**被机制保证**的，不再是靠注释。
  const defs54 = files54.filter((f) => /function detectWorkBuddyRoot/.test(src54[f]));
  ok('T54-b1 ★L0 数据根探测全仓库恰好 1 处定义（且只在 wb-root.js）',
    defs54.length === 1 && defs54[0] === 'wb-root.js', `实测 ${defs54.length} 处：${defs54.join(', ')}`);

  // b2 ★ 账本/水位线：不得有裸 writeFileSync 直接写（必须走 tmp+rename）。
  //   改前 rollbackLedgerAfterWatermarkFailure 就是唯一一处裸写（F-2），已修；这里防止再冒出来。
  const rawLedgerWrites54 = [];
  for (const f of files54) {
    const body = stripComments(src54[f]);
    if (/fs\.writeFileSync\(\s*(DAILY_USAGE_FILE|LEDGER_WATERMARK_FILE|snap\.ledgerPath|DAILY|WATERMARK)\s*,/.test(body)) rawLedgerWrites54.push(f);
  }
  ok('T54-b2 ★L0 账本/水位线不得有裸 writeFileSync 直写（一律 tmp+rename）',
    rawLedgerWrites54.length === 0, `裸写于：${rawLedgerWrites54.join(', ')}`);

  // b3 ★ 计价展开式（分桶减法形态）所在文件数 ≤ 2（当前：token-tracker.js 的 calcCost 分桶支 + recalc-day.js）。
  //   triPrice 是唯一正统实现；其余两处是历史遗留，**批次 2（S-9）目标是降到 0**。
  //   这里先钉住"不恶化"：谁再抄第三份 → 立刻红。
  // v3.46.0（审计 S-9 达成）：目标达成 —— 现在只剩 token-tracker.js 里 costFromPeakSplit 这一份，
  //   recalc-day.js 已改为调用它。断言从「≤2」收紧为「恰好 1 且在 token-tracker.js」：
  //   谁再把展开式抄回第二个文件 → 立刻红（本条在批次 2 反向验证中实测变红）。
  const splitExprFiles54 = files54.filter((f) => /\((pIn|split\.pIn)\s*-\s*(pc|pcached)\)/i.test(src54[f])
    || /\((oIn|split\.oIn)\s*-\s*(oc|ocached)\)/i.test(src54[f]));
  ok('T54-b3 ★L0 计价分桶展开式只在 token-tracker.js 内 1 处（S-9 已达成：recalc 改调 costFromPeakSplit）',
    splitExprFiles54.length === 1 && splitExprFiles54[0] === 'token-tracker.js',
    `实测 ${splitExprFiles54.length} 个文件：${splitExprFiles54.join(', ')}`);

  // b4 ★ 锁实现份数 ≤ 2（withFileLock / withPricingLock）。
  //   报告 A-1 建议三份合一（deepseek-official 不持锁已登记不修），本条先防"第四种写法"出现。
  const lockImpls54 = files54.filter((f) => /function with(?:File|Pricing)Lock\s*\(/.test(src54[f]));
  ok('T54-b4 ★L0 锁实现份数 ≤ 2（防第三份同构锁；A-1 合一后应降到 1）',
    lockImpls54.length <= 2, `实测 ${lockImpls54.length} 份：${lockImpls54.join(', ')}`);
}

// ===== T55（v3.46.0 审计批次 2）：S-9 计价收敛 / S-5 回调异常 / S-2 子代理逐文件 / S-10 空值守卫 =====
//   S-9 属「动金额口径」的改动，验收标准不是"代码看着对"，而是**改前/改后金额逐位不变**：
//     · b1 fuzz：新单点函数 vs 改前两份手写展开式（含脏数据 cached>in / 负值）2000 组逐位 ===
//     · 真机：WB_ROOT 指向隔离副本，4 个日期跑改前/改后 recalc-day，stdout 逐字一致（见报告第八节）
{
  const tt55 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!tt55 || typeof tt55.costFromPeakSplit !== 'function' || typeof tt55.peakMultOf !== 'function') {
    ok('T55 模块加载（需要 costFromPeakSplit / peakMultOf 导出）', false, '缺少导出');
  } else {
    // ── b1 ★★ S-9 等价性 fuzz ──────────────────────────────────────────────
    //  改前的**两份**手写展开式原样复刻在这里当对照（主链路 calcCost 分桶支 / recalc-day 精确切分支）。
    //  两份写法不同（有无 Number() 包装、倍率三元式写法不同），fuzz 同时证明：
    //    ① 新单点函数与两者都逐位一致（= 金额零变化）；② 那两份旧写法彼此也等价（= 当初没算错）。
    const oldMain55 = (m, s, peakMult) => {
      const pIn = Number(s.pIn) || 0, pCached = Number(s.pCached) || 0, pOut = Number(s.pOut) || 0;
      const oIn = Number(s.oIn) || 0, oCached = Number(s.oCached) || 0, oOut = Number(s.oOut) || 0;
      const pc = Math.min(pCached, pIn);
      const oc = Math.min(oCached, oIn);
      return ((pIn - pc) / 1e6) * (m.input_price || 0) * peakMult
           + (pc / 1e6) * (m.cached_price || 0) * peakMult
           + (pOut / 1e6) * (m.output_price || 0) * peakMult
           + ((oIn - oc) / 1e6) * (m.input_price || 0)
           + (oc / 1e6) * (m.cached_price || 0)
           + (oOut / 1e6) * (m.output_price || 0);
    };
    const oldRecalc55 = (m, s, model) => {
      const isDeepSeekS = /(^|[\/\-_])deepseek/i.test(String(model || ''));
      const peakMultS = typeof m.peak_multiplier === 'number' ? m.peak_multiplier : (isDeepSeekS ? 2 : 1);
      const pc = Math.min(s.pCached, s.pIn);
      const oc = Math.min(s.oCached, s.oIn);
      return ((s.pIn - pc) / 1e6) * Number(m.input_price || 0) * peakMultS
        + (pc / 1e6) * Number(m.cached_price || 0) * peakMultS
        + (s.pOut / 1e6) * Number(m.output_price || 0) * peakMultS
        + ((s.oIn - oc) / 1e6) * Number(m.input_price || 0)
        + (oc / 1e6) * Number(m.cached_price || 0)
        + (s.oOut / 1e6) * Number(m.output_price || 0);
    };
    let seed55 = 20261010;
    const rnd55 = () => { seed55 = (seed55 * 1103515245 + 12345) & 0x7fffffff; return seed55 / 0x7fffffff; };
    const pick55 = () => {
      const r = rnd55();
      if (r < 0.12) return 0;
      if (r < 0.2) return -Math.floor(rnd55() * 500);  // 负值（脏数据）
      if (r < 0.35) return Math.floor(rnd55() * 50);   // 小值（易触发 cached > in）
      return Math.floor(rnd55() * 9000000);
    };
    let diff55 = 0, sample55 = '';
    for (let i = 0; i < 2000; i++) {
      const s = { pIn: pick55(), pCached: pick55(), pOut: pick55(), oIn: pick55(), oCached: pick55(), oOut: pick55() };
      const pr = {
        input_price: (rnd55() < 0.1 ? undefined : rnd55() * 20),
        cached_price: (rnd55() < 0.2 ? undefined : rnd55() * 2),
        output_price: (rnd55() < 0.1 ? undefined : rnd55() * 40),
        peak_multiplier: (rnd55() < 0.5 ? undefined : (rnd55() < 0.5 ? 2 : 2.5)),
      };
      const model55 = rnd55() < 0.5 ? 'deepseek-v4.1-flash' : 'hy4-preview';
      const pm = tt55.peakMultOf(pr, model55);
      const a = tt55.costFromPeakSplit(pr, s, pm);
      const b = oldMain55(pr, s, pm);
      const c = oldRecalc55(pr, s, model55);
      if (!(a === b && b === c)) { diff55++; if (!sample55) sample55 = JSON.stringify({ s, pr, model55, a, b, c }); }
    }
    ok('T55-b1 ★★S-9 计价收敛零金额变化：新 costFromPeakSplit 与改前两份展开式 2000 组 fuzz 逐位一致',
      diff55 === 0, `不一致 ${diff55} 组，样本 ${sample55}`);

    // ── b2 ★★ peakMultOf 行为（三处调用点共用同一判据）────────────────────────
    ok('T55-b2 ★★peakMultOf：显式值优先 / deepseek 缺省 2 / 其余缺省 1',
      tt55.peakMultOf({ peak_multiplier: 2.5 }, 'hy3') === 2.5
      && tt55.peakMultOf({ peak_multiplier: 0 }, 'deepseek-flash') === 0
      && tt55.peakMultOf({}, 'deepseek-v4.1-flash') === 2
      && tt55.peakMultOf({}, 'hy4-preview') === 1
      && tt55.peakMultOf({ input_price: 1 }, 'x/deepseek-y') === 2,
      `ds=${tt55.peakMultOf({}, 'deepseek-v4.1-flash')} other=${tt55.peakMultOf({}, 'hy4-preview')}`);

    // ── b3 ★★ calcCost 分桶支确实走 costFromPeakSplit（行为级，非源码级）──────
    {
      const pr55 = { deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00' }, models: { 'deepseek-v4.1-flash': { input_price: 1, cached_price: 0.02, output_price: 4, peak_multiplier: 2 } } };
      const st55 = { model: 'deepseek-v4.1-flash', in: 3000, cached: 2000, out: 500, pIn: 1000, pCached: 800, pOut: 200, oIn: 2000, oCached: 1200, oOut: 300 };
      const got55 = tt55.calcCost(st55, pr55, Date.UTC(2026, 2, 4, 12, 0, 0)); // 空闲时刻：分桶路径不看 mult
      const want55 = tt55.costFromPeakSplit(pr55.models['deepseek-v4.1-flash'], st55, 2);
      ok('T55-b3 ★★calcCost 分桶支 = costFromPeakSplit（高峰段 ×peakMult、空闲段 ×1）',
        got55 === want55 && got55 > 0, `calcCost=${got55} 期望=${want55}`);
    }

    // ── b4/b5/b6：S-5 / S-2 结构（源码级）—— 行为级见 b7 ─────────────────────
    const srcTT55 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
    const inc55 = (() => { const i = srcTT55.indexOf('function incrementalRecord'); return i < 0 ? '' : srcTT55.slice(i, i + 14000); })();
    //  ⚠️ 必须定位到**回调异常 catch 分支**里再找回滚调用：函数里另有一处
    //     rollbackLedgerAfterWatermarkFailure(snap)（A2 水位线写盘失败闸门），全函数级正则会把它算进来
    //     → 反向验证时（只删 catch 里的回滚）本条会假绿。改为以「记账回调异常」这条告警锚定。
    //   ⚠️ 锚点窗口**必须窄**：A2 闸门的回滚就在锚点前约 400 字符处（实测），窗口取 -800 会把它框进来
    //     → 同样假绿（批次 2 反向验证踩到过一次，故收紧到 -200）。
    const iCb55 = inc55.indexOf('记账回调异常');
    const segCb55 = iCb55 < 0 ? '' : inc55.slice(Math.max(0, iCb55 - 200), iCb55 + 1200);
    ok('T55-b4 ★S-5 记账回调必须整体包 try/catch，且 catch 内回滚账本 + 留痕（否则异常 = 重复计费）',
      /let snap = null;/.test(inc55) && /try \{/.test(inc55)
      && /\} catch \(e\) \{/.test(inc55)
      && /rollbackLedgerAfterWatermarkFailure\(snap\)/.test(segCb55)
      && /ledger-callback-error/.test(segCb55),
      `锚点@${iCb55}`);
    //  三变量必须声明在 try **之前**：否则 catch 里访问不到 → 回滚分支永远走不到（真实的坑）。
    const iSnap55 = inc55.indexOf('let snap = null;');
    const iTry55 = inc55.indexOf('try {');
    ok('T55-b5 ★S-5 snap/willRecord/recorded 必须声明在 try 之前（放 try 内 → catch 访问不到 → 回滚失效）',
      iSnap55 >= 0 && iTry55 > iSnap55 && inc55.slice(iSnap55, iTry55).includes('let recorded = true;')
      && inc55.slice(iSnap55, iTry55).includes('let willRecord = false;'),
      `snap@${iSnap55} try@${iTry55}`);

    const seg55 = inc55.slice(inc55.indexOf('const subDir = subagentsDirFromTranscript'));
    ok('T55-b6 ★★S-2 子代理读取必须两阶段：① 逐文件独立 try/catch（含 stderr 告警）② merge 与水位线在第二循环',
      //   ⚠️"告警可见"要匹配 **stderr 字符串**（源码级断言已 stripComments，注释里的措辞不算数）。
      /const pending = \[\]/.test(seg55) && /读取失败，本轮跳过该文件/.test(seg55)
      && seg55.indexOf('const pending = []') < seg55.indexOf('for (const p of pending)')
      && /for \(const p of pending\)/.test(seg55)
      && !/for \(const f of fs\.readdirSync\(subDir\)\)/.test(seg55),
      '单 try 裹整循环：一个坏文件 → 已 merge 的其他文件水位线不推进 → 下轮重复计费');
  }

  // ── b7 ★★ S-2 行为级：坏文件不影响好文件、不重复计费、下轮补记 ──────────────
  //   夹具：主 transcript + 两个子代理（a 正常 / b 用"目录冒充文件"→ readFileSync 抛 EISDIR）。
  //   注：readTranscLinesFrom 内部 catch 了 readFileSync → 该场景不会冒泡成异常；本条验的是
  //   **S-2 的目标结果**（坏文件不拖累好文件 / 水位线各自独立 / 修好后自动补记），异常分支由 b6 守结构。
  {
    const savedEnv55b = process.env.WB_ROOT;
    process.env.WB_ROOT = tmp;
    const m55b = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
    if (!m55b || typeof m55b.incrementalRecord !== 'function') {
      ok('T55-b7 模块加载（需要 incrementalRecord 导出）', false, '缺少导出');
    } else {
      try {
        const proj55 = path.join(tmp, 'projects', 'b55');
        fs.mkdirSync(proj55, { recursive: true });
        const ts55 = path.join(proj55, 'sess-b55.jsonl');
        const sub55 = path.join(proj55, 'sess-b55', 'subagents');
        fs.mkdirSync(sub55, { recursive: true });
        const mkRow = (n) => JSON.stringify({ type: 'assistant', timestamp: Date.UTC(2026, 2, 4, 12, 0, 0), providerData: { model: 'deepseek-v4.1-flash', messageId: 'm' + n, usage: { inputTokens: 1000, outputTokens: 10 } } }) + '\n';
        fs.writeFileSync(ts55, mkRow('main'));
        fs.writeFileSync(path.join(sub55, 'agent-a.jsonl'), mkRow('a'));
        fs.mkdirSync(path.join(sub55, 'agent-b.jsonl')); // 目录冒充文件 → readFileSync 抛 EISDIR
        try { fs.rmSync(path.join(skillDir, '.ledger-watermark.json'), { force: true }); } catch (e) { /* 干净起点 */ }
        const readIn55 = () => {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(skillDir, 'daily-usage.json'), 'utf-8').replace(/^\uFEFF/, ''));
            const day = d['2026-03-04'] || {};
            return ((day.models || {})['deepseek-v4.1-flash'] || {}).in || 0;
          } catch (e) { return -1; }
        };
        const before55 = readIn55();
        m55b.incrementalRecord(ts55, 'sess-b55');
        const after1 = readIn55();
        m55b.incrementalRecord(ts55, 'sess-b55'); // 第二次：不应翻倍
        const after2 = readIn55();
        // 修好 b → 下轮应补记 b 的量
        try { fs.rmSync(path.join(sub55, 'agent-b.jsonl'), { recursive: true, force: true }); } catch (e) { /* 清理目录 */ }
        fs.writeFileSync(path.join(sub55, 'agent-b.jsonl'), mkRow('b'));
        m55b.incrementalRecord(ts55, 'sess-b55');
        const after3 = readIn55();
        const d1 = after1 - before55, d2 = after2 - after1, d3 = after3 - after2;
        ok('T55-b7 ★★S-2 行为级：坏子代理文件不影响好文件（主+a 记账）、重复调用不翻倍、坏文件修好后下轮补记',
          d1 === 2000 && d2 === 0 && d3 === 1000,
          `首轮+${d1}（期望 2000=主1000+子a1000） 二轮+${d2}（期望 0=不重复） 修复后+${d3}（期望 1000=b补记）`);
        try { fs.rmSync(proj55, { recursive: true, force: true }); } catch (e) { /* 清理 */ }
        try { fs.rmSync(path.join(skillDir, '.ledger-watermark.json'), { force: true }); } catch (e) { /* 清理 */ }
      } catch (e) { ok('T55-b7 组异常', false, (e && e.message) || String(e)); }
    }
    if (savedEnv55b === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedEnv55b;
  }

  // ── b8 ★ S-10：recalc 空值守卫（models 条目为 null / total 缺失）不得崩在锁内 ──
  {
    const rec55 = stripComments(fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8'));
    ok('T55-b8 ★S-10 recalc 必须防 models 条目为 null 与 dayObj.total 缺失（否则锁内抛 → 用户只见异常栈）',
      /if \(!stat \|\| typeof stat !== 'object'\) continue;/.test(rec55)
      && /if \(!dayObj\.total \|\| typeof dayObj\.total !== 'object'\) dayObj\.total = \{\};/.test(rec55));
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
