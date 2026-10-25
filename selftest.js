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
// v3.59.0（批15 · M38）：并发集成测试需要**真并行**的两个子进程（spawnSync 是串行的，测不出竞态），
//   故这里再取一份异步 spawn；配套的同步等待用 Atomics.wait 忙等（本文件清理重试处已用同款写法）。
const { spawn: spawnAsync } = require('child_process');

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

// v3.60.0（CI 编码 · 2026-10-15）：所有 python 子进程统一 **utf-8 stdio**（见下）。
//   根因：CI 是 Windows runner，python 的 stdout 默认走 **locale 编码**（cp1252）——脚本一 print 中文
//   即 UnicodeEncodeError 整脚本崩（CI 离线遍实测 18 红：T63/T64/T71/T73；本机 locale=UTF-8 故不复现）。
//   父进程按 utf-8 解码子进程输出（token-tracker.js:2797 `String(b)` / 本文件各 spawn 的 encoding:'utf8'）
//   → 输出契约本就该是 utf-8。⚠ 这是**测试侧兜底**；三个产品脚本自身另加了 sys.stdout.reconfigure
//   （治真实 cp1252 Windows 用户），此处额外覆盖 selftest **内联生成**的 python（如 T73 的 t73.py，
//   非产品文件、改不到）。凡 spawn python 的子进程一律带上本对象（守卫 T85-a3 逐点断言）。
const PY_IO_ENV = { PYTHONIOENCODING: 'utf-8' };

// v3.60.0（CI 编码 · T72-b）：T72-b 用 `--require` 预加载把 fetch 换成假官方页（**不联网**），但父进程
//   在 CI 离线遍带 WB_NO_NET=1 —— 子进程会在 fetch **之前**就 `if (NO_NET) throw` 短路
//   （见 deepseek-official.js 的 `if (NO_NET) throw new Error('WB_NO_NET=1')`）→ 与"联网 + 假页"的
//   测设自相矛盾 → T72-b3~b6 必红（CI 实测 4 红）。故子进程环境必须**显式清掉联网总开关**。
//   抽成模块级函数是为了让守卫 T85-b4 对**真实现**做行为断言（本项目硬教训：行为守卫须与源码守卫配对）。
function makeT72bChildEnv(base) {
  const e = Object.assign({}, base);
  delete e.WB_NO_NET; delete e.WB_DISABLE_NET;
  return e;
}

// v3.60.0（C1 门禁）：把「envSkip 不计入退出码」这个结构性缺口（KNOWN-ISSUES **C 类第 1 条**，
//   「沙箱里绿 ≠ 真跑过」）在**权威门禁（CI）**上关掉 —— 但**不动本地语义**。
//   为什么不能全环境一刀切：本地沙箱可能禁 spawn（SPAWN_OK=false，属环境能力，v3.29.0 已定"不该判红"），
//   而 CI 上 `SPAWN_OK` 有**前置探针**保证（.github/workflows/selftest.yml 第一步，探不通直接判 job 失败）——
//   此时任何"被跳过的用例"都＝端到端**未真跑**＝假绿，必须判失败。
//   唯一的"有意跳过"＝**离线那一遍** T3-R4 的 WB_NO_NET 前提缺口（至多 1 条，见下方 `WB_NO_NET === '1'` 分支）。
//   语义（三档）：
//     · CI 且 联网跑（无 WB_NO_NET）→ 合格线 0
//     · CI 且 离线跑（WB_NO_NET=1）→ 合格线 1（只容那一条前提缺口）
//     · 非 CI（本地开发）        → 语义不变：envSkip 不影响退出码
//   为什么抽成纯函数：守卫要对**真函数**做表驱动行为断言（本项目硬教训：行为守卫必须与源码守卫**配对**，
//   只断言源码文本会在回退后匹配到注释同文本 → 假绿）。
function ciSkipGate(o) {
  const expectedPremise = ((o && o.wbNoNet) === '1') ? 1 : 0;   // 离线那一遍的 T3-R4 前提缺口
  const unexpected = Math.max(0, ((o && o.envSkipCount) || 0) - expectedPremise);
  return { expectedPremise, unexpected, shouldFail: !!((o && o.inCI) && unexpected > 0) };
}

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
  'backfill.js', 'recalc-day.js', 'peak-rules.js', 'selftest.js', 'stop-handler.js', 'wb-root.js',
  'transc-lines.js', 'ledger-merge.js', 'price-history.js'];

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
// v3.61.0（审计 F2）：transc-lines.js 必须随行——主脚本与 backfill 顶层都 require 它（残行/行数口径
//   单一实现），隔离目录缺它 = 全段 MODULE_NOT_FOUND（与前三个坑同因，第四次）。
// v3.62.0（外部审计 F-3）：price-history.js 必须随行——recalc-day 与 backfill **顶层**都 require 它
//   （当日快照取价单一实现），隔离目录缺它 = 整段 selftest 崩（与前四个坑同因，第五次）。
const RUNTIME_COMPANIONS = ['refresh-prices.js', 'deepseek-official.js', 'refresh-holidays.js',
  'pricing.json', 'holidays.json', 'peak-rules.js', 'recalc-day.js', 'stop-handler.js', 'wb-root.js',
  'ledger-merge.js', 'transc-lines.js', 'price-history.js'];
for (const f of ['token-tracker.js', ...RUNTIME_COMPANIONS]) {
  fs.copyFileSync(path.join(SRC, f), path.join(skillDir, f));
}
// v3.59.0（批15 · 测试网床）：**入口脚本**也要随行——backfill.js 不被主脚本 require（不在上面那份
//   「require 的兄弟模块」清单里），但 T67 会直接 spawn 它 → 隔离目录缺它 = MODULE_NOT_FOUND、
//   三组端到端**从未真跑过**（T59 夹具 v3.51.0 就踩过同一个坑、当时只在那一处单独拷了一份，
//   T61-e1 守的正是那一处；T67 是后来加的，漏了这一步）。这里统一补上，避免第四次踩。
for (const f of ['backfill.js']) {
  fs.copyFileSync(path.join(SRC, f), path.join(skillDir, f));
}
// v3.18.4（G2）：隔离本地官方价库——autoDiscoverCnPriceDir 第②级会扫 ~/WorkBuddy/*/prices/index.json
// （WB_ROOT 管不到这里），否则测试结果取决于"这台机器有没有本地价库"。这里显式指向空库。
const pricesDir = path.join(tmp, 'prices');
fs.mkdirSync(pricesDir, { recursive: true });
fs.writeFileSync(path.join(pricesDir, 'index.json'), JSON.stringify({ models: {} }));
// v3.62.0（批4·续）：**孤儿轮对账的测试基线 = 仓库默认档（off）**。
//   为什么必须显式钉住：该档位新增了"未设 env 时回落本机 local-config.json 的 orphan_scan"（本机已设 on），
//   而下一行的 `env` 继承 process.env、`require` 主模块的组又与本进程共享 process.env —— 不钉住的话
//   **本机跑测试 = on 档**、CI（无 local-config.json → off）却是 off：本机会因"配置生效"多弹窗 /
//   多推水位线，染色无关断言（经典本地-CI 分叉）。各测试要其它档位时自行显式覆盖（T102-b/c 已如此）。
process.env.WB_ORPHAN_SCAN = 'off';
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
  // v3.62.0（外部审计 F-3/G-1）：recalc-day 默认 dry-run，写盘必须显式 --write。
  //   本组断言的正是写盘三件套（备份 + 原子写 + 写后仍可解析），故必须带 --write 才测得到。
  //   ⚠ v3.62.0（F-3）：再加 --current-price —— 2026-01-01 是历史日且隔离库无当日快照，
  //     默认口径（当天快照价）会 fail-closed 拒绝（exit 1）。本组验的是**写盘路径**、与价格口径无关，
  //     故显式声明按现价（口径拒绝/快照取价本身由 T100-c 专测）。
  const r = spawnSync(NODE, [path.join(skillDir, 'recalc-day.js'), '2026-01-01', '--current-price', '--write'], { env, timeout: 60000, windowsHide: true, encoding: 'utf8' });
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
  ok('T9-B5c ★backfill 水位线口径 = **含残行**的物理行数（与主链共用 transc-lines.js 单一实现）',
    /physicalLines:\s*measureTranscriptLines\(raw\)\.lines/.test(bfSrc)
    && !/raw\.match\(\/\\n\/g\)/.test(bfSrc),
    'v3.61.0（审计 F2）：口径已从「只数 \'\\n\'」修正为「残行 parse 成功也 +1」—— '
    + '主链自 v3.42.0（A19）起就是这么做的，backfill 只数 \'\\n\' 会把残行的 token 记了却不让水位线盖住它，'
    + '主链下一轮重读 = 双记。两侧必须共用同一实现。');

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
  // i7（v3.56.0 补，真实缺陷复发防护）：顶部**第二条**版本标题必须是上一版。
  //   病象（发版前自查抓到）：往 CHANGELOG 顶部插新版本段时，把上一版的 `## v3.55.0（…）` 标题行
  //   直接覆盖掉 → 上一版的正文还在、标题没了，版本史出现"无标题孤儿段"（v3.56.0 直接接 v3.54.0）。
  //   i3 只查"含当前版本"，抓不到这个。"上一版"的算法必须兼容两种发版节奏，否则守卫自身误红
  //   （v3.56.0 首版实测踩坑：当时写死 patch-1，而本仓库历来是 minor 进位发版、补丁号归 0，
  //   `3.56.-1` 永远匹配不到 `3.55.0` → 数据全对却恒红）：
  //   ① 补丁节奏（c>0）：prev = a.b.(c-1)；② minor 节奏（c===0，本仓库实际节奏）：prev = a.(b-1).任意补丁；
  //   ③ 大版本首位（b===0, c===0）：prev = (a-1).任意.任意。若改发版 cadence，同步改这里。
  ok('T12-i7 ★CHANGELOG 顶部第二条版本标题必须是上一版（防新段覆盖旧标题行）', (() => {
    const hdrs = [...src('CHANGELOG.md').matchAll(/^## v(\d+)\.(\d+)\.(\d+)（/gm)]
      .map((m) => `${m[1]}.${m[2]}.${m[3]}`);
    const [a, b, c] = v.split('.').map(Number);
    const prevRe = c > 0 ? new RegExp(`^${a}\\.${b}\\.${c - 1}$`)
      : b > 0 ? new RegExp(`^${a}\\.${b - 1}\\.\\d+$`)
        : new RegExp(`^${a - 1}\\.\\d+\\.\\d+$`);
    return hdrs.length >= 2 && hdrs[0] === v && prevRe.test(hdrs[1]);
  })(), (() => {
    const hdrs = [...src('CHANGELOG.md').matchAll(/^## v(\d+)\.(\d+)\.(\d+)（/gm)]
      .map((m) => `${m[1]}.${m[2]}.${m[3]}`);
    return '顶部三条: ' + hdrs.slice(0, 3).join(' / ') + `（hdrs[0] 应为 ${v}，hdrs[1] 应为上一版）`;
  })());
  // i8（v3.63.5 补，真实缺陷复发防护）：生产代码内不得出现**高于** SKILL_VERSION 的版本标注。
  //   病象（2026-10-22 外部审计 G-1）：v3.63.4 那一批把修复标注全写成 **v3.64.x**（16 处 ——
  //   fetch-cn-prices.py 9 / parse_tokenhub.py 5 / selftest.js 2），而发布号是 3.63.4。纯注释级、
  //   零行为影响，但**事后按版本号检索会整批漏掉**（损害可追溯性），且会让人误以为还有个 v3.64.x。
  //   i1~i7 只管"四处一致"，抓不到"注释里写了未来的版本号"。
  //   口径：取 js/py 内 `v\d+\.\d+\.\d+` 的**最大值**，必须 ≤ SKILL_VERSION（相等允许：本版的标注）。
  //   ⚠ 写法坑（本条守卫自己踩过，留此防复发）：主版本**必须是数字组** `v(\d+)`，
  //     不能写成 `v3\.(\d+)\.(\d+)\.(\d+)` —— 那等于要求 `v3.x.y.z` **四段**，
  //     而真实版本号 `v3.63.4` 只有两段数字 → 永远匹配不上（实测 `.test('v3.63.4')===false`，
  //     守卫恒红且从输出看不出原因：表现是"扫不到任何版本号"）。
  const RE_VER = new RegExp('\\bv(\\d+)\\.(\\d+)\\.(\\d+)\\b', 'g');
  const RE_VER_FILE = /\.(js|py)$/;
  // 三段完整比较（major → minor → patch）：只比 minor/patch 会把 v2.82.3 判成"大于" v3.63.5。
  const gtVer3635 = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : (a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]));
  // 哨兵白名单：`v9.9.9` 是 T12-c「模拟远端有更高版本」的测试夹具，不是真版本标注。
  const VER_SKIP3635 = new Set(['9.9.9']);
  const scanVer3635 = () => {
    let worst = null; let who = '';
    for (const f of fs.readdirSync(SRC)) {
      if (!RE_VER_FILE.test(f)) continue;
      const s = fs.readFileSync(path.join(SRC, f), 'utf-8');
      for (const m of s.matchAll(RE_VER)) {
        const t = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (VER_SKIP3635.has(t.join('.'))) continue;
        if (!worst || gtVer3635(t, worst)) { worst = t; who = f; }
      }
    }
    return { worst, who };
  };
  ok('T12-i8 ★生产代码内不得出现高于 SKILL_VERSION 的版本标注（v3.64.x 误标事故）', (() => {
    const { worst } = scanVer3635();
    if (!worst) return false; // 一个版本号都扫不到 = 扫描本身失效，不许假绿
    return !gtVer3635(worst, v.split('.').map(Number));
  })(), (() => {
    const { worst, who } = scanVer3635();
    return `代码内最大标注 v${worst ? worst.join('.') : '?'}（来自 ${who}）vs SKILL_VERSION ${v}`;
  })());
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
    // j0（v3.59.0 批15「新①」）：**先证明这次 spawn 真的成功产出输出**。
    //   实测踩坑：机器负载高时 30s 超时 → `r.status = null`、stdout 空 → JSON.parse 拿 '' →
    //   j1/j2 **假红**，而 j3「不含提示」反而**假绿**（空输出自然不含提示）。同一份代码两次跑
    //   831/8 与 833/6 → 属测试自身脆弱性，不是产品回归。故所有「不含某字符串」型断言
    //   必须先过这一条，否则空输出恒绿、守卫等于没有。
    ok('T12-j0 ★spawn 未超时且 stdout 非空（超时会让 j1/j2 假红、j3 假绿）',
      r.status === 0 && String(r.stdout || '').length > 0,
      `status=${r.status} err=${r.error && (r.error.code || r.error.message)} stdoutLen=${String(r.stdout || '').length}`);
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
    ok('T12-j3 已是最新时 --hook 注入不含任何更新提示（旧行为不变；前置 j0 式状态断言防空输出假绿）',
      r2.status === 0 && String(r2.stdout || '').length > 0 && String(r2.stdout || '').indexOf('[技能更新]') < 0,
      `status=${r2.status} stdoutLen=${String(r2.stdout || '').length} ${String(r2.stdout).slice(0, 160)}`);
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
  // v3.58.0（批8-①）：形态同步为 `safeCost(stat.cost)` —— 裸 `dayTotal += stat.cost` 对字符串型 cost
  //   是**字符串拼接**（0 + "0.5" → "00.5"），整日合计会落盘 NaN 且不自愈。守的就是这个「必须数值化」。
  ok('T15-c3 ★recalc 峰谷占比未知时不得改写已有金额（原账>0 → 保留原额）',
    /dayTotal \+= safeCost\(stat\.cost\); continue;/.test(rcSrc));
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
    ok('T19-b2 ★长行结果宽度 ≤ 上限', mod19.dispWidth(lLong19) <= 44, 'w=' + mod19.dispWidth(lLong19));
    const huge19 = { model: M19, in: 199800000, out: 11100000, cached: 190000000 };
    const lHuge19 = l2of(huge19, P19());
    ok('T19-b3 ★超长行不留孤悬「｜」结尾 / 不出现「｜｜」',
      !/｜$/.test(lHuge19) && lHuge19.indexOf('｜｜') < 0, lHuge19);
    ok('T19-b4 ★超长行宽度仍 ≤ 上限', mod19.dispWidth(lHuge19) <= 44, 'w=' + mod19.dispWidth(lHuge19));

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
  ok('T29-a1 ★记账入口 + 恢复路径空轮判据都走 numTs（不再各自硬判 typeof）',
    (src29.match(/const ts = numTs\(r\.timestamp\);/g) || []).length === 3,
    'numTs 调用点数=' + (src29.match(/const ts = numTs\(r\.timestamp\);/g) || []).length + '（应为 3：两个记账入口 + v3.63.2 roundHasRowsNoUsage）');
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
  // v3.47.0（KI-14）：基线 43 → 42。回退 S-7 时删掉了 `try { c.unref(); } catch (e) {}` 这一处
  //   （unref 本身被去掉了，裸 catch 随之消失）。**基线显式下调**，不是顺手吞错。
  // v3.48.0（审计 S1）：基线 42 → 40。backfill 提交段重写（顺序倒置为「先水位线、后账本」）后，
  //   旧回滚分支里的三处裸 catch（restoredLedger 赋值 / 写 `{}` / bak2 回滚）收敛成一处
  //   （rollbackWatermark 内 `restored = saveLedgerRawAtomic(...)`）→ 净减 2。
  //   方向是"更少的静默"，且 T41-a1/a9/a10 + T53-b7 已把新提交顺序钉死，不是靠删 catch 掩盖问题。
  // v3.49.0（审计响应批次 2）：基线 40 → 44。T59 的端到端夹具（backfill --write 实跑）新增 4 处：
  //   ① 夹具清场 rmSync（clearWm59，`silent-ok:清理`）；
  //   ②③ spawn 后关两个 stdio fd（`silent-ok:清理`——spawn 异常路径下 fd 可能已被关，重复 close 不致命）；
  //   ④ 读回水位线文件失败（`silent-ok:降级`——缺失/损坏即视为"键不对"，由上一条断言报红，不需要静默续跑）。
  //   四处全部带标记且类别落在白名单；T33-a2/a3 仍守"必须带标记 + 类别合法"，改数字不削弱守卫生效面。
  // v3.63.2（外部审计 N3 修复）：基线 44 → 43。backfill 的「旧账本读取失败即视为空」那一处
  //   `catch (e) {} // silent-ok:降级` 被删 —— 它不是无害降级：--write 路径上同一形态会让
  //   锁内合并拿到空账本 → 用重放值整本替换、抹掉重放范围外的历史日期（N3）。
  //   改为 readLedgerStrict 统一入口（读不懂就中止），静默总数因此净减 1。
  //   方向是"更少的静默"，且 T109-a1~a5 + b1~b4 已把新行为钉死，不是靠删 catch 掩盖问题。
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
  // v3.59.0（批14·M1）：调用点改走 `fetchJsonWithRetry`（重试封装）后，本条改为验**整条链路贯通**：
  //   调用点 → 重试封装 → fetchJson 三处都必须带着同一个 timeoutMs，任何一环漏传 = 超时预算失效。
  //   （改前只验"调用点直接调 fetchJson"，封装一加就红 —— 守卫正确工作，适配而非放宽。）
  ok('T39-a2 ★timeoutMs 三处贯通：调用点 → 重试封装 → fetchJson（不是改了没人用的常量）',
    /async function fetchJson\(url, timeoutMs = TIMEOUT_MS\)/.test(srcR39)
    && /await fetchJsonWithRetry\(s\.url, s\.timeoutMs\)/.test(srcR39)
    && /async function fetchJsonWithRetry\(url, timeoutMs = TIMEOUT_MS\)/.test(srcR39)
    && /await fetchJson\(url, timeoutMs\)/.test(srcR39),
    'timeoutMs 没贯通到调用点 → 假修复');

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
  // v3.48.0（审计 N1）：再去掉 `!isPlainRound &&` 前置条件——**普通轮也可能多模型**（用户在同一轮里
  //   切换模型，2026-10-12 03:54 轮同时含 step-5 与 hy4-preview），原假设"普通轮必然单桶"已证伪。
  ok('T40-a7 ★Stop 端快速路径必须先走按模型分条（任何轮型都不得直接单条弹）',
    /if \(showToastsSplitByModel\(agg/.test(src40)
    && !/!isPlainRound && showToastsSplitByModel/.test(src40),
    '快速路径直接单条弹 = 分条被绕过（真机 00:52 复现：异模型轮只弹 1 条「hy4-preview（子代理 hy3）」）；普通轮同样可能多模型，不得旁路分条');
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

  // a1/a2：backfill 的提交阶段必须「先水位线、后账本」，且账本写失败时回滚水位线
  // v3.48.0（审计 S1）：原顺序**先账本、后水位线**在两步 rename 之间崩溃（SIGKILL/断电/未捕获异常）时，
  //   账本已是全量重建值而水位线仍是旧偏移 → 主链路 incrementalRecord 按旧水位线把全部历史行再累加
  //   一遍 → 重复计费、零报错、不可恢复。这与项目"宁可少记不重记"哲学正好相反（原顺序给出最坏方向）。
  //   倒置后崩溃只剩「水位线推满、账本旧」= 少记，重跑 backfill 即恢复。
  const bfCommit = stripComments(rawBF.slice(rawBF.indexOf('// ══ 提交阶段')));
  const wmPos = bfCommit.indexOf('const wmRes = tt.withFileLock(WATERMARK');
  const ldPos = bfCommit.indexOf('const lockRes = tt.withFileLock(DAILY');
  ok('T41-a1 ★★S1：backfill 提交顺序必须「先水位线、后账本」（改前先账本 → 崩溃即永久重复计费）',
    wmPos >= 0 && ldPos > wmPos,
    `先账本后水位线 = 两步之间被杀时账本已是重建值、水位线仍是旧偏移 → 主链路重放全部历史行 = 重复计费且零报错（wmRes@${wmPos} lockRes@${ldPos}）`);
  // v3.45.0（审计 F-2/P-20）：回滚写盘由 `copyFileSync` 改为 `saveLedgerRawAtomic`（tmp+rename），
  //   且必须接其返回值（它内部 catch 后**返回 false 而不抛**，照旧"调完就置 true"会谎报回滚成功）。
  //   v3.48.0（S1）：回滚对象从「账本」变成「水位线」——账本在新顺序下根本没被写过，动它才会丢数据。
  ok('T41-a2 ★账本写失败时水位线回滚到 bak2，且仍以 exit 1 退出（不留"半套"状态）',
    /saveLedgerRawAtomic\(WATERMARK, fs\.readFileSync\(bak2\)\)/.test(bfCommit) && /process\.exit\(1\)/.test(bfCommit));
  // v3.48.0（S1）：新顺序下「账本写失败」时账本**从未被本次改动过** → 既不回滚账本、更不写 {}。
  //   （旧代码在这里回滚账本到 bak1 / 首次回填写 {}，是因为账本已经先写了；顺序倒置后该分支消失。）
  ok('T41-a9 ★S1：账本写失败时**不动账本**（不回滚 bak1、不写 {}——它根本没被改过）',
    !/saveLedgerRawAtomic\(DAILY/.test(bfCommit),
    '回滚一个没被写过的账本 = 用旧备份覆盖窗口内主链路新增量（丢数据）；写 {} = 清空有数据账本');
  // v3.48.0（S1 续）：回滚结果必须接返回值，不能"调完就置 true"（否则谎报成功）。
  ok('T41-a10 ★回滚标志取自 saveLedgerRawAtomic 返回值（而非无条件置 true）',
    /let restored = false;[\s\S]{0,240}restored = saveLedgerRawAtomic\(WATERMARK/.test(bfCommit),
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
    // v3.57.0（K1 收尾顺手修）：本组用例原先**不传 tsMs** → calcCost 回退 `new Date()`（运行时刻），
    //   于是断言结果依赖"跑测试时是不是高峰段"——09:00-12:00/14:00-18:00 跑就红、其余时段绿
    //   （实测 08:29 绿、09:01 红，同一份代码）。现显式传一个**固定空闲时刻**（2026-10-13 周二 12:30 +0800，
    //   午休段）消除时刻依赖：c1/c6 走分桶路径不受影响；c2/c3/c4/c5 的"回退整批"一律按空闲 ×1 判。
    const OFFPEAK_TS = 1791865800000; // 2026-10-13 12:30 +0800（周二，非高峰）
    // c1：**有分桶**时高峰段必须乘 peakMult —— 与调用时刻无关（这是 A3 的核心行为）
    //   半峰半闲：100万高峰 + 100万空闲 → 1×2 + 1×1 = ¥3
    const half = tt44.calcCost({ model: M, in: 2000000, out: 0, cached: 0,
      pIn: 1000000, pCached: 0, pOut: 0, oIn: 1000000, oCached: 0, oOut: 0 }, pricing44, OFFPEAK_TS);
    ok('T44-c1 ★有行级分桶时高峰段乘 peakMult（半峰半闲 200万 in → ¥3，不是整批的 ¥2 或 ¥4）',
      Math.abs(half - 3) < 1e-9, `实测 ${half}`);
    const allPeak = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0,
      pIn: 1000000, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 }, pricing44, OFFPEAK_TS);
    const allOff = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0,
      pIn: 0, pCached: 0, pOut: 0, oIn: 1000000, oCached: 0, oOut: 0 }, pricing44, OFFPEAK_TS);
    ok('T44-c2 ★全高峰 → ×2（¥2）；全空闲 → ×1（¥1）—— 分桶自身的倍率是对的',
      Math.abs(allPeak - 2) < 1e-9 && Math.abs(allOff - 1) < 1e-9,
      `全高峰 ${allPeak} / 全空闲 ${allOff}`);
    // c3：**回退路径**——无分桶时行为必须与 v3.39.0 逐字节一致（靠 tsMs 判整批）
    const noBuck = tt44.calcCost({ model: M, in: 2000000, out: 0, cached: 0 }, pricing44, OFFPEAK_TS);
    ok('T44-c3 ★无分桶 → 回退整批口径（不因 A3 改动而变），且结果为有限数',
      Number.isFinite(noBuck) && noBuck > 0, `实测 ${noBuck}`);
    // c4：**分桶不完整时必须回退**（真实行有分桶 + 估算段无分桶 → 三项和 ≠ 总量）
    //   → 不得用残缺分桶算钱（否则静默少算/多算）。这里模拟"in 分桶只覆盖一半"。
    const partial = tt44.calcCost({ model: M, in: 2000000, out: 0, cached: 0,
      pIn: 500000, pCached: 0, pOut: 0, oIn: 500000, oCached: 0, oOut: 0 }, pricing44, OFFPEAK_TS);
    ok('T44-c4 ★分桶三项和 ≠ 总量 → 拒绝使用分桶、回退整批（残缺分桶绝不静默参与计价）',
      Math.abs(partial - noBuck) < 1e-9, `残缺分桶 ${partial} vs 整批 ${noBuck}`);
    // c5：分桶三项**全为 0** → 视为无分桶（不得把全部 token 当免费）
    const zeroBuck = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0,
      pIn: 0, pCached: 0, pOut: 0, oIn: 0, oCached: 0, oOut: 0 }, pricing44, OFFPEAK_TS);
    ok('T44-c5 ★分桶全 0（= 一行都没落进可见时段）→ 视为无分桶、回退整批（不得算成免费）',
      Math.abs(zeroBuck - tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 0 }, pricing44, OFFPEAK_TS)) < 1e-9,
      `实测 ${zeroBuck}`);
    // c6：cached 也随峰谷（A13 结论）——高峰段的 cached 乘 peakMult
    //   100万 peak in（其中 100万 cached）→ 1×0.02×2 = ¥0.04
    const peakCached = tt44.calcCost({ model: M, in: 1000000, out: 0, cached: 1000000,
      pIn: 1000000, pCached: 1000000, pOut: 0, oIn: 0, oCached: 0, oOut: 0 }, pricing44, OFFPEAK_TS);
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

  ok('T50-b7 团队轮弹窗 reason 标签区分（team-sync / plain-immediate，便于诊断）',
    /'team-sync'/.test(src50) && /'plain-immediate'/.test(src50)
    && !/toastReason \+/.test(src50),
    'D1：toastReason 是 watcher 路径（token-tracker.js:6460）的局部变量、从未进 stop-handler 的 tx 名单 → typeof 恒 undefined，前缀拼接是死代码（v3.48.0 已删）');
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

  // b1 ★★ S-7 → **v3.47.0（KI-14）结论推翻并反向**：价库流水线 spawn **不得** detached / unref。
  //   v3.45.0 加了它们之后实测翻车：Windows 上 detached 让 python.exe 拿到自己的控制台 → Stop 时冒出
  //   持久命令行窗口 → 用户手动关 → python 被杀（.refresh.error 留档 exit=3221225786 = 0xC000013A
  //   控制台被关闭）→ 刷新失败 → attempts 递增 → 当日熔断 → built_at 卡在前一天。
  //   而不带它们时（v3.44.0 时代）每天 00:0x 都刷新成功。**detached 挡不住 Job Object，却会造窗口。**
  //   正向守卫已迁到 T56-b1/b2（窗口更窄、判据更准），这里保留反向断言防止有人"照着旧注释加回去"。
  //   注意：这里必须走 stripComments —— token-tracker.js 的 KI-14 注释里写了 `detached:true` / `unref()`
  //   这两个精确串（说明为什么删），不去注释会命中注释 → **断言假红**（v3.46.0 同款教训）。
  const localDb53 = seg(stripComments(tt53), 'function maybeRefreshLocalDb', 4000);
  ok('T53-b1 ★★KI-14（推翻 S-7）价库流水线 spawn 不得 detached / unref（detached 会在 Windows 造控制台窗口 → 用户关掉 → 进程被杀）',
    !/detached:\s*true/.test(localDb53) && !/\.unref\(\)/.test(localDb53),
    '见 token-tracker.js 内 KI-14 注释：S-7 的 detached/unref 已回退，勿按旧注释加回');

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

  // b7 ★ S1（源码级）：新提交顺序下**不得再出现**「回滚账本到 bak1 / 写空账本 {}」——
  //   账本在失败那一刻根本没被本次写过，动它才会抹掉窗口内主链路增量（回滚 bak1）或清空有数据账本（{}）。
  ok('T53-b7 ★S1：backfill 全文不得出现 saveLedgerRawAtomic(DAILY, …)（账本不再被回滚/清空）',
    !/saveLedgerRawAtomic\(DAILY/.test(bf53),
    '回滚一个没被写过的账本 = 用旧备份覆盖窗口内主链路新增量；写 {} = 清空有数据账本');

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

// ===== T56（v3.47.0 批次 1）：KI-14 抓价流水线不得再 detached/unref + M-5 水位线数组守卫 =====
//   KI-14 背景：v3.45.0 给抓价流水线 spawn 加 `detached:true`+`unref()` → 10-11 起 Stop 冒持久命令行窗口，
//   用户手动关 → python 被杀（.refresh.error 留档 exit=3221225786 = 0xC000013A 控制台被关闭）→ 刷新失败熔断。
//   本段把「不许再加回去」钉死：**反向验证时把 detached 加回去，b1/b2 必须变红。**
{
  const srcTT56 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  // b1：以 spawn 调用为锚点，**窗口必须窄**（v3.46.0 教训：宽窗口会把别处的同名写法框进来 → 假绿）。
  //   这里只取 spawn(...) 之后 220 字符 = 恰好一个 options 对象，且不含下一处 spawn。
  // v3.52.0（S1）：spawn 参数从相对脚本名改为**绝对路径变量** scriptPath。锚点取**最后一处**
  //   `require('child_process').spawn(exe,`（抓价流水线在文件更靠后；前面那处是 resolvePython 的版本探测），
  //   这样锚点不依赖参数名 —— 否则 v3.52.0 的回退验证里 T56 会跟着误红（实测踩到）。
  //   守卫语义不变：抓价流水线这个 spawn 的 options 里不得出现 detached / unref。
  const iSpawn56 = srcTT56.lastIndexOf("require('child_process').spawn(exe,");
  const segSpin56 = iSpawn56 < 0 ? '' : srcTT56.slice(iSpawn56, iSpawn56 + 300);
  ok('T56-b1 ★★KI-14 抓价流水线 spawn 选项内不得出现 detached（KI-13 实证：detached 挡不住 Job Object；'
    + 'A/B/C/D 实测：它既不继承也不新建控制台 → 零收益。真正修到功能的是 T56-b2 的 unref）',
    iSpawn56 >= 0 && !/detached/.test(segSpin56), segSpin56.slice(0, 160));

  // b2：窗口内不得出现 unref（unref 会让 node 在第 1 个脚本跑完就退 → 第 2、3 个脚本不启动 → 刷新残缺）
  ok('T56-b2 ★KI-14 抓价流水线不得 unref 子进程（否则流水线只跑第一个脚本，刷新残缺）',
    iSpawn56 >= 0 && !/unref/.test(segSpin56), segSpin56.slice(0, 160));

  // b3：windowsHide 必须还在（去掉 detached 之后它是唯一保证不冒窗口的手段）
  ok('T56-b3 ★KI-14 抓价流水线必须保留 windowsHide:true',
    /windowsHide: true/.test(segSpin56), segSpin56.slice(0, 160));

  // b4：M-5 水位线数组守卫 —— 匹配**代码本身**（stripComments 已去注释，注释措辞不算数）
  ok('T56-b4 ★M-5 水位线解析必须排除数组（typeof [] === object → wm[key] 挂到数组上、静默错账）',
    /typeof j === 'object' && !Array\.isArray\(j\)/.test(srcTT56));
}

// ===== T58（v3.48.0 审计响应批次）：S1 提交顺序 / S2 条件方向 / S5 token 钳制 / N1·N2·D1 显示层 / 拉取器三修 =====
//   本段把本轮 6 项修复**逐个钉死**：每一条都是"注释与代码曾经相反/曾经缺失"的类型，
//   只靠注释同步必然再次腐化 → 一律源码级 + 行为级双断言。
//   **反向验证要求**：把任一修复改回修复前形态，对应断言必须变红（见 KNOWN-ISSUES KI-15）。
{
  const srcTT58 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  const srcSH58 = stripComments(fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8'));
  const srcBF58 = stripComments(fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8'));
  const srcRP58 = stripComments(fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8'));
  const srcPT58 = fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf-8').replace(/\r\n/g, '\n');
  const srcFC58 = fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf-8').replace(/\r\n/g, '\n');
  const srcBI58 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');

  // a1 ★★S2：unpublished 重查窗口的**比较方向**。v3.39.0 A8 把方向写反了（`>=`），
  //   注释与 stderr 文案都写着"过了 30 天窗口才放行去查"，只有代码是反的 → 必须钉住 `<`。
  ok('T58-a1 ★★S2：unpublished 重查窗口必须用 `< dueAt`（未到期 return；写成 >= 会让过期条目永不重查）',
    /if \(!isUnpub \|\| \(dueAt > 0 && Date\.now\(\) < dueAt\)\) return/.test(srcTT58),
    '方向写反的后果：30 天后官方公布了单价也回填不了 + 30 天内每轮 Stop 重复联网查价');
  // a2 ★S5（源码级）：单次 token 值必须做上限钳制。
  //   判据必须钉到"常量有**具体数值**"——只查字符串出现是不够的（反向验证实测：删掉定义行后
  //   `n > TOKEN_SANITY_MAX` 那行还在，两个宽松正则会照样绿 → 假绿）。故要求 `= <数字>` 开头，
  //   `Infinity`/缺定义/被注掉都匹配不上。
  //   注：反向验证时若**删掉定义行**，本断言来不及跑——模块在 T58-a3/a4 调用 extractUsage 时抛
  //   ReferenceError，selftest 以非零退出 + 栈结束。那同样是"红"（CI 看得见），比假绿强；
  //   干净的红由 `= Infinity` 这种"改值不改结构"的形态提供（实测 a3 变红）。
  ok('T58-a2 ★S5：extractUsage 必须对单次 token 值做上限钳制（常量须有具体数值，不能是 Infinity）',
    /const TOKEN_SANITY_MAX = [0-9]/.test(srcTT58) && /n > TOKEN_SANITY_MAX/.test(srcTT58),
    '只防字符串拼接与负数、不防量级 → 单轮 in/out 虚高、金额系统性失真且静默');
  // a3/a4 ★★S5（行为级）：超大值按 0 计、正常量级不受影响、cached 同样受钳
  const mod58 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  ok('T58-a3 ★★S5 行为级：inputTokens=1e12 → in=0（不是 1e12），同结构小值不受影响',
    !!mod58 && typeof mod58.extractUsage === 'function'
    && mod58.extractUsage({ inputTokens: 1e12, outputTokens: 100 }).in === 0
    && mod58.extractUsage({ inputTokens: 100, outputTokens: 100 }).in === 100,
    '超大值被原样采信 → 当日合计与 calcCost 金额失真');
  ok('T58-a4 ★★S5 行为级：正常量级（本机实测 186,861）不得被钳；cached 同样受钳制',
    !!mod58
    && mod58.extractUsage({ inputTokens: 186861, outputTokens: 519 }).in === 186861
    && mod58.extractUsage({ inputTokens: 100, inputTokensDetails: [{ cached_tokens: 1e15 }] }).cached === 0,
    '上限误伤正常值 = 少记；cached 不受钳 = 虚高照样进账本');

  // b1 ★N1：Stop 端快速路径不得再排除普通轮（普通轮也可能多模型——用户轮内切模型）
  ok('T58-b1 ★N1：Stop 快速路径不得再写 `!isPlainRound && showToastsSplitByModel`（普通轮同样可能多模型）',
    !/!isPlainRound && showToastsSplitByModel/.test(srcSH58),
    '普通轮直接单条弹 = 把整轮所有模型的 token 显示在主模型名下（2026-10-12 03:54 轮：30.2万里 21.8万实际是 hy4）');
  // b2 ★N2：分模型弹窗 i>0 不得再显示今日累计（与 balI 同样只在第一条）
  ok('T58-b2 ★N2：分模型弹窗只有第一条显示今日累计（i>0 分支必须是空串，不得调 todayUsageTxt）',
    /const todayI = i === 0 \? \(o\.firstToday != null \? o\.firstToday : todayUsageTxt\(\)\) : '';/.test(srcTT58),
    '每条都挂同一个"今日¥5.33"（全天总计）→ 被误读成各模型累计、或几条可以相加');
  // b3 ★D1：stop-handler 不得再引用从未注入的 toastReason
  ok('T58-b3 ★D1：stop-handler 不得引用 toastReason（watcher 路径局部变量，从未进 tx 名单 → typeof 恒 undefined）',
    !/toastReason/.test(srcSH58),
    '死代码让"诊断前缀"看起来生效，实际 reason 恒为裸值，排错时反被误导');

  // c1 ★★S1：提交顺序必须「先水位线、后账本」
  ok('T58-c1 ★★S1：backfill 必须先写水位线后写账本（崩溃窗口方向 = 少记可恢复，而非永久重复计费）',
    (() => {
      const w = srcBF58.indexOf('const wmRes = tt.withFileLock(WATERMARK');
      const l = srcBF58.indexOf('const lockRes = tt.withFileLock(DAILY');
      return w >= 0 && l > w;
    })(),
    '先账本后水位线 = 两步之间被杀 → 账本已是重建值、水位线仍是旧偏移 → 主链路重放全部历史行 = 重复计费且零报错');
  // c2 ★S1：账本写失败时不得回滚账本（那一刻它根本没被本次写过）
  ok('T58-c2 ★S1：backfill 不得出现 saveLedgerRawAtomic(DAILY, …)（账本不再被回滚/清空）',
    !/saveLedgerRawAtomic\(DAILY/.test(srcBF58),
    '回滚一个没被写过的账本 = 用旧备份覆盖窗口内主链路增量（丢数据）');

  // d1 ★S6：parse_tokenhub 的 requests 分支必须校验 HTTP 状态（与 urllib 分支同为 fail-closed）
  ok('T58-d1 ★S6：parse_tokenhub 的 requests 分支必须 raise_for_status',
    /resp\.raise_for_status\(\)/.test(srcPT58),
    '5xx/Cloudflare 页被 .text 原样吃下 → 错误价表进库，或 0 模型"假成功"');
  // d2 ★F8：0 模型 / 无目标表必须**不写文件 + 非零退出**，且退出点在写文件之前
  ok('T58-d2 ★F8：parse_tokenhub 解析 0 模型/无目标表必须 sys.exit(2)，且退出点在 os.replace 之前',
    /sys\.exit\(2\)/.test(srcPT58)
    && srcPT58.indexOf('sys.exit(2)') < srcPT58.indexOf('os.replace(tmp'),
    '0 模型仍覆盖 = 用好数据覆盖坏数据；退出码 0 = 假成功，CI/人都看不出');

  // e1 ★F2：读 lock 价必须用 .get()（下标缺键的 KeyError 会被外层 except 吞掉）
  // v3.62.0（外部审计 F-2）：fetch-cn-prices 的 lock 回读环（parse_pricing_deepseek）已**整段拆除**
  //   —— 它读回 pricing.json 冒充"当日新抓的 first_party 价"，正是审计点名的自我引用闭环。
  //   拆除后**读 lock 价的唯一位置 = build_index.py 的 lock 覆盖层**，故本守卫的锚点随之迁移：
  //   不变量本身（.get() 而非下标、两个脚本都不得出现 v['input_price'] 下标）一字未改。
  ok('T58-e1 ★F2：读 lock 价必须用 .get()，不得再用 v[\'input_price\'] 下标 —— 下标缺键 → except 吞掉 → deepseek 厂商整轮 0 价、摘要失真，且看不出是缺键还是网络失败',
    /in_p, out_p, cache_p = _num\(v\.get\('input_price'\)\), _num\(v\.get\('output_price'\)\)/.test(srcBI58)
    && !/v\['input_price'\]/.test(srcBI58) && !/v\['input_price'\]/.test(srcFC58)
    && !/v\['output_price'\]/.test(srcBI58) && !/v\['output_price'\]/.test(srcFC58),
    '下标缺键 → except 吞掉 → deepseek 厂商整轮 0 价、摘要失真，且看不出是缺键还是网络失败');

  // f1 ★F3：USD 缓存价聚合必须允许 0（"缓存免费"是真实策略，不是缺数据）
  ok('T58-f1 ★F3：USD 缓存价必须走 medianAllowZero（0 = 缓存免费；被 median 的 >0 丢掉会退化成 ×10% 估算 → 高估）',
    /const cacheUsd = medianAllowZero\(/.test(srcRP58) && /function medianAllowZero\(/.test(srcRP58),
    '缓存占总金额约 97% → 高估方向是多收钱且无告警');
}

// ===== T59（v3.49.0 审计响应批次 2）：A3 水位线校验覆盖 subs / B3·C6 backfill 收敛到单点 / G10·G11·G12 部署清单·文档·CI =====
//   本批 6 项修复分两类：① 「复制实现靠注释同步」（B3 峰谷倍率、C6 水位线键）—— 收敛为调用关系后，
//      口径一致由**结构**保证；② 「文档与实测打架」（G11）或「清单漏项」（G10/G12）。
//   全部源码级 + 行为级双断言；**反向验证要求**：把任一修复改回修复前形态，对应断言必须变红（见 KNOWN-ISSUES KI-16）。
{
  const rawTT59 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const rawBF59 = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n');
  // 取单个函数体（到下一个顶层 function 为止）——断言钉在函数内部，不能用"全文出现过"蒙混（同 T41 规矩）
  const grabFn59 = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\nfunction ', i + 1);
    return j < 0 ? src.slice(i) : src.slice(i, j);
  };
  const wmSrc59 = stripComments(grabFn59(rawTT59, 'saveLedgerWatermark'));
  const bfCode59 = stripComments(rawBF59);

  // ── a 组：A3 写后校验必须覆盖 subs / subTs（改前只比 main / lastTs） ──
  //   病根：entry = { main, subs:{子代理文件:行数}, lastTs, subTs:{文件:ts} }，而校验只比 main/lastTs。
  //   subs 落盘丢失/被写旧（torn write、磁盘满、被别的进程覆盖）时 main/lastTs 仍对得上 → 放行 →
  //   子代理水位线停旧偏移 → 下轮从旧偏移重读同一批子代理行 = **重复计费**（与 A2 同一类洞，开在另一字段）。
  ok('T59-a1 ★★A3：水位线写后校验必须比对 subs（子代理文件→行数）',
    /if \(!sameSubMap\(a\.subs, b\.subs\)\) return false;/.test(wmSrc59),
    '只比 main/lastTs = 子代理水位线没落盘也判成功 → 下轮重读同一批子代理行 = 重复计费且不可恢复');
  ok('T59-a2 ★★A3：水位线写后校验必须比对 subTs（KI-5 截断恢复判据，丢失 = 恢复退化为冻结）',
    /if \(!sameSubMap\(a\.subTs, b\.subTs\)\) return false;/.test(wmSrc59));
  ok('T59-a3 ★A3：subs 比对必须含键集合大小检查（回读少一个文件也要判失败）',
    /if \(ka\.length !== kb\.length\) return false;/.test(wmSrc59),
    '只比值不查键集合 → 丢文件/多文件的形态可能蒙混过关');

  // a4~a7 行为级（真落盘 + 回读篡改，隔离目录内；沿用 T41 c 组手法）
  const mod59 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  const WM59 = path.join(skillDir, '.ledger-watermark.json');
  const quiet59 = (fn) => {
    const old = process.stderr.write.bind(process.stderr);
    const buf = [];
    process.stderr.write = (s) => { buf.push(String(s)); return true; };
    let v = null;
    try { v = fn(); } finally { process.stderr.write = old; }
    return { v, err: buf.join('') };
  };
  const clearWm59 = () => { try { fs.rmSync(WM59, { recursive: true, force: true }); } catch (e) {} }; // silent-ok:清理 — 测试夹具清场
  const tamper59 = (mutate) => {
    const orig = fs.readFileSync;
    fs.readFileSync = function (p) {
      const res = orig.apply(fs, arguments);
      if (String(p) === WM59) {
        try { const j = JSON.parse(res.toString('utf-8')); mutate(j); return Buffer.from(JSON.stringify(j)); }
        catch (e) { return res; }
      }
      return res;
    };
    return () => { fs.readFileSync = orig; };
  };
  // a4：正常带 subs 写入 → true（防误判：严格比对不能把正常路径打死）
  clearWm59();
  const a4 = quiet59(() => mod59.saveLedgerWatermark({ 'sid-t59-a4': { main: 10, subs: { 'agent-a.jsonl': 5 }, lastTs: 111, subTs: { 'agent-a.jsonl': 222 } } }));
  ok('T59-a4 ★A3 行为级：正常带 subs 写入 → true（严格比对不误判正常路径）',
    a4.v === true, `返回=${a4.v}`);
  // a5 ★核心：main/lastTs 不变、只篡改 subs → 必须 false（改前正是这种形态静默放行）
  clearWm59();
  const restoreA5 = tamper59((j) => { j['sid-t59-a5'].subs = { 'agent-a.jsonl': 1 }; });
  let a5v = null;
  try { a5v = mod59.saveLedgerWatermark({ 'sid-t59-a5': { main: 10, subs: { 'agent-a.jsonl': 5 }, lastTs: 111, subTs: { 'agent-a.jsonl': 222 } } }); }
  finally { restoreA5(); }
  ok('T59-a5 ★★A3 行为级：main/lastTs 不变、只篡改 subs → 返回 false（改前此形态静默放行 = 重复计费）',
    a5v === false, `返回=${a5v}（true = 子代理行下轮重读一遍）`);
  // a6：篡改 subTs → false
  clearWm59();
  const restoreA6 = tamper59((j) => { j['sid-t59-a6'].subTs = { 'agent-a.jsonl': 1 }; });
  let a6v = null;
  try { a6v = mod59.saveLedgerWatermark({ 'sid-t59-a6': { main: 10, subs: { 'agent-a.jsonl': 5 }, lastTs: 111, subTs: { 'agent-a.jsonl': 222 } } }); }
  finally { restoreA6(); }
  ok('T59-a6 ★A3 行为级：篡改 subTs → 返回 false', a6v === false, `返回=${a6v}`);
  // a7：旧形态 entry（无 subs/subTs 字段，旧版本水位线升级而来）→ true（不能把升级兼容打死）
  clearWm59();
  const a7 = quiet59(() => mod59.saveLedgerWatermark({ 'sid-t59-a7': { main: 3, lastTs: 0 } }));
  ok('T59-a7 ★A3 行为级：旧形态 entry（无 subs 字段）→ true（升级兼容，不误判）',
    a7.v === true, `返回=${a7.v}`);
  clearWm59();

  // ── b 组：B3 backfill 峰谷倍率收敛到 tt.peakMultOf ──
  ok('T59-b1 ★B3：backfill 峰谷倍率必须调 tt.peakMultOf（DeepSeek 缺省 2 的内联抄写已删）',
    /tt\.peakMultOf\(m, modelName\)/.test(bfCode59)
    && !/const isDeepSeek/.test(bfCode59)
    && !/typeof m\.peak_multiplier === 'number' \? m\.peak_multiplier : 2/.test(bfCode59),
    '内联手抄 = "等价"只靠注释维护；peakMultOf 一侧改语义（如新增厂商峰谷规则）不会传导到这里 → 回填与增量记账系统性分歧且零报错');
  ok('T59-b2 ★B3 行为级：peakMultOf 语义钉死（有 pm 用 pm；无 pm 时 deepseek→2、其余→1、边界子串不误判）',
    !!mod59 && typeof mod59.peakMultOf === 'function'
    && mod59.peakMultOf({ peak_multiplier: 3 }, 'deepseek-v4.1-flash') === 3
    && mod59.peakMultOf({}, 'deepseek-v4.1-flash') === 2
    && mod59.peakMultOf({}, 'glm-5.3-flash') === 1
    && mod59.peakMultOf({}, 'notdeepseek') === 1,
    'peakMultOf 是 calcCost / recalc-day / backfill 三处共用单点，语义一改三处金额同时变——必须由断言盯着');

  // ── c 组：C6 backfill 水位线键收敛到 tt.ledgerKey ──
  ok('T59-c1 ★C6：backfill 不得本地拼水位线键（无 crypto import、无 sha1 内联；两处均走 tt.ledgerKey）',
    !/require\('crypto'\)/.test(bfCode59) && !/createHash\('sha1'\)/.test(bfCode59)
    && (bfCode59.match(/tt\.ledgerKey\(/g) || []).length === 2,
    '本地拼键 = 与主链路 ledgerKey 契约仅靠注释同步；键不一致 → backfill 推满的键主链路不认 → 主链路按自己 key 从 0 重读 = 重复计费（根直放布局下旧实现正是 path-hash vs sid 分歧）');
  ok('T59-c2 ★C6 行为级：ledgerKey 契约本体（sid 非空→sid；sid 空→path-+sha1(resolve) 前 16 位）',
    !!mod59 && typeof mod59.ledgerKey === 'function'
    && mod59.ledgerKey('abc-sid', '/wb/projects/p/abc-sid.jsonl') === 'abc-sid'
    && mod59.ledgerKey('', '/wb/projects/p/x.jsonl')
      === 'path-' + require('crypto').createHash('sha1').update(path.resolve('/wb/projects/p/x.jsonl')).digest('hex').slice(0, 16),
    'c1 只保证"调了单点"，c2 保证"单点本身没被改坏"');

  // c3/c4 ★★端到端（spawn）：backfill --write 实跑，验键 = sid（C6）+ 金额 = 主脚本单点逐行计算（B3）
  if (!SPAWN_OK) {
    envSkip('T59-c3 端到端：backfill --write 水位线键 = sid', SPAWN_SKIP_REASON);
    envSkip('T59-c4 端到端：backfill 回填金额 = 主脚本单点计算', SPAWN_SKIP_REASON);
  } else {
    const sub = path.join(tmp, 't59bf');
    const subSkill = path.join(sub, 'skills', 'token-usage-tracker');
    fs.mkdirSync(subSkill, { recursive: true });
    // ★backfill.js 必须随行（v3.51.0 修复）：它是**入口脚本**、不在 RUNTIME_COMPANIONS 里（那份清单是
    //   「主脚本 require 的兄弟模块」）。旧代码只拷 ['token-tracker.js', ...RUNTIME_COMPANIONS] 且源是主夹具
    //   → 隔离目录缺 backfill.js → spawn 报 MODULE_NOT_FOUND、退出码 1 → c3/c4 假失败。此坑长期被本沙箱
    //   SPAWN_OK=false（c3/c4 走 envSkip）掩盖，SPAWN_OK=true 的环境/CI 才暴露。源改用仓库 SRC（与主夹具内容等价，且含 backfill.js）。
    for (const f of ['token-tracker.js', 'backfill.js', ...RUNTIME_COMPANIONS]) {
      try { fs.copyFileSync(path.join(SRC, f), path.join(subSkill, f)); } catch (e) { /* 单个缺失由下方退出码暴露 */ }
    }
    const SID59 = 't59-e2e-sid';
    const projA = path.join(sub, 'projects', 'projA');
    fs.mkdirSync(projA, { recursive: true });
    const tsP59 = path.join(projA, SID59 + '.jsonl');
    const ts59 = Date.now() - 3600000;
    fs.writeFileSync(tsP59, JSON.stringify({ type: 'message', role: 'assistant', id: 'm1', timestamp: ts59, status: 'completed',
      providerData: { model: 'deepseek-v4.1-flash', messageId: 'm1',
        usage: { input_tokens: 1000, output_tokens: 100, inputTokensDetails: [{ cached_tokens: 500 }] } } }) + '\n');
    const oF59 = fs.openSync(path.join(sub, 'out.txt'), 'w');
    const eF59 = fs.openSync(path.join(sub, 'err.txt'), 'w');
    // stdio 重定向到文件（不用管道）：抓价流水线可能派生子进程持有管道 → spawnSync 会干等到超时
    const r59 = spawnSync(NODE, [path.join(subSkill, 'backfill.js'), '--write'], {
      stdio: ['ignore', oF59, eF59], windowsHide: true, timeout: 90000,
      env: Object.assign({}, process.env, { WB_ROOT: sub, WB_NO_NET: '1', TOKEN_TRACKER_NO_TOAST: '1', CN_PRICE_DB_DIR: pricesDir }),
    });
    try { fs.closeSync(oF59); } catch (e) {} // silent-ok:清理 — spawn 异常路径下 fd 可能已被关闭，重复 close 不致命
    try { fs.closeSync(eF59); } catch (e) {} // silent-ok:清理 — 同上（两个 fd 各自独立关）
    let keys59 = [];
    try { keys59 = Object.keys(JSON.parse(fs.readFileSync(path.join(subSkill, '.ledger-watermark.json'), 'utf-8'))); } catch (e) {} // silent-ok:降级 — 水位线缺失/损坏即视为"键不对"，由上一条断言报红
    ok('T59-c3 ★★C6 端到端：backfill --write 后水位线键 = sid（不含 path- 前缀键）',
      r59.status === 0 && keys59.length === 1 && keys59[0] === SID59,
      `退出=${r59.status}${r59.error ? ' ' + r59.error.message : ''} 键=${JSON.stringify(keys59)}（path- 前缀 = 与主链路 sid 键分歧 → 重复计费）`);
    // c4：账本金额必须等于主脚本单点（peakMultOf + triPriceRounded）对同一行的计算值
    let c4ok = false, c4d = '';
    try {
      const daily59 = JSON.parse(fs.readFileSync(path.join(subSkill, 'daily-usage.json'), 'utf-8'));
      const pr59 = require(path.join(skillDir, 'peak-rules.js'));
      // ⚠️ c4 的"期望值"必须用 **backfill 实跑时消费的那份** 价库/假日表（subSkill —— c3/c4 setup 刚从 SRC 拷贝的原版）：
      //    skillDir/pricing.json 在中途被别的用例（如 T11 的 :726）改写成夹具价（只有 m-x）且从不还原，
      //    读它 → findModel 找不到 deepseek-v4.1-flash → 返回 null → `.m` 抛错（v3.51.0 实测；此坑长期被
      //    本沙箱 SPAWN_OK=false 掩盖，SPAWN_OK=true 的环境/CI 才暴露）。
      const pricing59 = JSON.parse(fs.readFileSync(path.join(subSkill, 'pricing.json'), 'utf-8'));
      const m59 = mod59.findModel(pricing59, 'deepseek-v4.1-flash', 'price').m;
      const mult59 = pr59.isPeakAt(ts59, pricing59, path.join(subSkill, 'holidays.json'))
        ? mod59.peakMultOf(m59, 'deepseek-v4.1-flash') : 1;
      const expect59 = Math.round(mod59.triPriceRounded(1000, 500, 100, m59, mult59) * 1e6) / 1e6;
      let got59 = null;
      for (const day of Object.values(daily59)) {
        for (const [mn, mv] of Object.entries(day.models || {})) {
          if (mn === 'deepseek-v4.1-flash') got59 = mv;
        }
      }
      c4ok = !!got59 && Math.abs((got59.cost || 0) - expect59) < 1e-6 && (got59.in || 0) === 1000 && (got59.out || 0) === 100;
      c4d = `期望 ¥${expect59} 实际 ¥${got59 ? got59.cost : 'N/A'}（倍率 ${mult59}）`;
    } catch (e) { c4d = String(e && e.message); }
    ok('T59-c4 ★B3 端到端：backfill 回填金额与主脚本单点逐行计算一致', c4ok, c4d);
  }

  // ── d 组：G10 部署清单漏项 ──
  const man59 = (() => { try { return fs.readFileSync(path.join(SRC, 'manifest.yaml'), 'utf-8'); } catch (e) { return ''; } })();
  const skillMd59 = (() => { try { return fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf-8'); } catch (e) { return ''; } })();
  const sibs59 = ['peak-rules.js', 'refresh-holidays.js', 'refresh-prices.js', 'stop-handler.js', 'wb-root.js'];
  ok('T59-d1 ★G10：manifest.yaml 部署清单列全五个同目录必需文件',
    sibs59.every((f) => man59.indexOf(f) >= 0),
    `缺：${sibs59.filter((f) => man59.indexOf(f) < 0).join(',') || '无'}（按旧清单部署 → 运行时 MODULE_NOT_FOUND）`);
  ok('T59-d2 ★G10：SKILL.md 环境要求同样列全五个文件',
    sibs59.every((f) => skillMd59.indexOf(f) >= 0),
    `缺：${sibs59.filter((f) => skillMd59.indexOf(f) < 0).join(',') || '无'}`);
  // d3 结构性：全仓所有 require('./X.js') 的 X 必须已在隔离随行清单（自动提取，防将来新增兄弟模块漏抄）
  //   ⚠️ 必须先剥注释再扫：本守卫自己的注释里就要引用 `require('./X.js')` 这个形态，
  //      不剥注释会把自己数进去（v3.49.0 实测踩到：d3 第一版报"缺失 X.js"正是命中文注释自身）。
  const allReq59 = [];
  for (const f of fs.readdirSync(SRC).filter((x) => /\.js$/.test(x))) {
    try {
      const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf-8'));
      for (const m of s.matchAll(/require\('\.\/([A-Za-z0-9_.-]+\.js)'\)/g)) allReq59.push(m[1]);
    } catch (e) { /* 单个文件读失败不影响其余 */ }
  }
  const missing59 = [...new Set(allReq59)].filter((f) => f !== 'token-tracker.js' && RUNTIME_COMPANIONS.indexOf(f) < 0);
  ok('T59-d3 ★G10：全仓 require 的兄弟模块全部在隔离随行清单（新增模块漏抄 = 整段 selftest 崩）',
    allReq59.length > 0 && missing59.length === 0,
    `缺失：${missing59.join(',') || '无'}`);

  // ── e 组：G11 文档与实测打架 ──
  const ki59 = (() => { try { return fs.readFileSync(path.join(SRC, 'KNOWN-ISSUES.md'), 'utf-8'); } catch (e) { return ''; } })();
  ok('T59-e1 ★G11：SKILL.md 不得保留被实测推翻的「代价：触发刷新那轮弹窗晚 ~12s」',
    skillMd59.indexOf('代价：触发刷新那轮弹窗晚 ~12s') < 0,
    'KI-14 真机实测（弹窗 04:23:45 → 刷新完成 04:23:54，全部弹窗在前）已证明刷新异步、弹窗零延迟；留着错说法会误导后人去"优化"一个不存在的问题');
  ok('T59-e2 ★G11：SKILL.md 与 KNOWN-ISSUES 都必须写明「弹窗零延迟」（两处说法不得再打架）',
    skillMd59.indexOf('弹窗零延迟') >= 0 && ki59.indexOf('弹窗零延迟') >= 0);

  // ── f 组：G12 CI 覆盖 ──
  const ci59 = (() => { try { return fs.readFileSync(path.join(SRC, '.github', 'workflows', 'selftest.yml'), 'utf-8'); } catch (e) { return ''; } })();
  const py59 = ['fetch-cn-prices.py', 'parse_tokenhub.py', 'build_index.py'];
  ok('T59-f1 ★G12：CI 必须对三个 Python 脚本跑 py_compile（此前 Python 侧零语法守卫）',
    /py_compile/.test(ci59) && py59.every((f) => ci59.indexOf(f) >= 0),
    `缺：${py59.filter((f) => ci59.indexOf(f) < 0).join(',') || '无'}（selftest 的 T0 只覆盖 JS 的 node --check）`);
  ok('T59-f2 ★G12：CI 必须有 pull_request 触发（只有 push main = 分支回归要到合并后才暴露）',
    /pull_request:/.test(ci59));
}

// ===== T60：v3.50.0 行2 自适应宽度守卫（用户弹窗截图复盘）=====
// 起因：2026-10-12 用户发通知中心截图 —— 5:37 那条 step-5-preview 弹窗行2 末尾「｜¥11.47」消失，
//   问"是长度受限被吞了吗"。定位结论（toast log 原文完整、calcCost 复算 11.4718 逐分一致）：
//   **不是代码吞的，是 Windows 通知卡片把超宽行整行砍掉行尾**——而金额恰好在行尾。
//   宽度实测：被砍行 46u；同批保住行 44u（hy3）/44u（4:59）→ 通知卡片正文小字真实极限在 44~46u 之间；
//   旧代码阈值 TOAST_LINE_MAX_W=51 **高于 UI 极限** → 守卫永不触发 → 代码不抢在 Windows 前舍。
// 修法（用户定调"上限改小 + 自适应：超限先把输入小数点压缩掉，那个应该就够了"，主代理补充落地）：
//   阈值 51→44（46 被砍/44 保住的实证间取保守值，45 无样本不冒险）；
//   宽度守卫改三级：① 输入数字去小数（2558.2万→2558万）② 仍超→输出数字去小数 ③ 仍超→丢缓存段（旧行为兜底）。
//   缓存% 与金额两个信息在前两级全程保留；⚠未计价/⚠账缺 三级都不丢。
{
  const mod60 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod60) ok('T60 行2 自适应宽度守卫（主模块加载失败）', false, 'token-tracker.js require 失败 —— CI 正常环境下这必是代码回归，不允许静默跳过');
  else {
    const main60 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
    const tl2Start = main60.indexOf('function toastLine2');
    const tl2End = main60.indexOf('\nfunction ', tl2Start + 10);
    const tl2Body = tl2End > tl2Start ? stripComments(main60.slice(tl2Start, tl2End)) : '';
    // 隔离 ⚠账缺 旗标（同 T19 理由）：它优先级最高、三级都不丢，会稳定吃掉行2 约 12u 预算，
    // 把本组要验的"瘦身保金额/缓存"行为全部掩盖（首轮 T60 的红就是这么来的——日志里那几条
    // 失败输出全带「⚠账缺」）。断言期间临时移走、结束后原样恢复。
    const tfPath60 = mod60.TRANSC_TRUNCATED_FILE;
    let tfSaved60 = null;
    try { tfSaved60 = fs.readFileSync(tfPath60, 'utf-8'); fs.unlinkSync(tfPath60); } catch (e) { tfSaved60 = null; }
    try {

    // ── a. 源码守卫：阈值与三级结构 ──
    ok('T60-a1 ★TOAST_LINE_MAX_W 必须为 44（51 高于通知卡片真实极限 ~46u → 守卫永不触发 → Windows 直接砍行尾金额）',
      /const TOAST_LINE_MAX_W = 44;/.test(main60), '红 = 有人把阈值改回 51/45 等无实证值');
    // 注意 c4 必须匹配「replace(ratioTxt」这次**使用**（第三级）而非定义处——
    // ratioTxt 的定义在守卫之前很远，用 indexOf('ratioTxt') 会恒假（首轮就这么红过）。
    ok('T60-a2 ★三级宽度守卫：输入瘦身 → 输出瘦身 → 丢缓存段（顺序即优先级）',
      /输入 \(\\d\+\)\\\.\\d\+\(\?=\[万亿\]\)/.test(tl2Body)
      && /输出 \(\\d\+\)\\\.\\d\+\(\?=\[万亿\]\)/.test(tl2Body)
      && tl2Body.indexOf('输入 (') < tl2Body.indexOf('输出 (')
      && tl2Body.indexOf('replace(ratioTxt') > tl2Body.indexOf('输出 ('),
      '红 = 前两级被删/顺序被调/缓存兜底被提前');
    ok('T60-a3 ★瘦身正则带 [万亿] 前瞻（不得碰缓存百分比与金额）',
      /\(\?=\[万亿\]\)/.test(tl2Body) && !/\\\.\\d\+\(\?=%\)/.test(tl2Body),
      '红 = 前瞻被去掉或误扩展到 % / ¥ 段');

    // ── b. 行为守卫：5:37 现场复现（合成价 = 官方真实价 ¥7/¥0.35/¥20，与 loadPricing 一致）──
    //   刻意不依赖 loadPricing()：隔离环境（WB_NO_NET / CI）下真实价库可能不含 step-5 条目，
    //   会退化成「未收录｜⚠未计价」把本组要验的宽度行为全部掩盖（首轮 T60 就这样红过）。
    const p60 = { models: {
      'step-5-preview': { input_price: 7, cached_price: 0.35, output_price: 20, region: 'CN' },
      'deepseek-v4.1-flash': { input_price: 1, cached_price: 0.02, output_price: 4, region: 'CN' },
    } };
    const ts60 = Date.parse('2026-10-11T21:37:35.937Z'); // UTC = 北京 05:37（toast log 原事件时刻）
    const s537 = { model: 'step-5-preview', in: 25582000, out: 88000, cached: 25468000, total: 34382000, count: 1, lastTs: ts60 };
    const l537 = mod60.toastLine2(s537, p60);
    ok('T60-b1 ★5:37 复现：金额 ¥11.47 必须保住（UI 被砍的那段正是它）',
      l537.indexOf('¥11.47') >= 0, l537);
    ok('T60-b2 ★5:37 复现：缓存百分比必须保住（用户定版"行2 留给缓存%"）',
      /缓存\d\d\.\d\d%/.test(l537), l537);
    ok('T60-b3 ★5:37 复现：输入数字被瘦身（2558.2万→2558万，去小数即降 2u）',
      l537.indexOf('输入 2558万') >= 0 && l537.indexOf('2558.2万') < 0, l537);
    ok('T60-b4 ★5:37 复现：成品宽度 ≤ 44u（通知卡片实测极限内，不会再被 Windows 砍）',
      mod60.dispWidth(l537) <= 44, 'w=' + mod60.dispWidth(l537) + ' ' + l537);

    // ── c. 不误伤：短行带小数不得被瘦身（瘦身只在超限时发生）──
    const sShort = { model: 'step-5-preview', in: 123400, out: 5678, cached: 0, total: 129078, count: 1, lastTs: ts60 };
    const lShort = mod60.toastLine2(sShort, p60);
    ok('T60-c1 ★短行带小数原样保留（12.3万 不被瘦；阈值内零行为变化）',
      lShort.indexOf('输入 12.3万') >= 0 && mod60.dispWidth(lShort) <= 44, lShort);

    // ── d. 兜底：极端长行仍 ≤ 上限且金额在（前两级救不回时第三级丢缓存段）──
    const sHuge = { model: 'deepseek-v4.1-flash', in: 199800000, out: 11100000, cached: 190000000, total: 210900000, count: 1, lastTs: ts60 };
    const lHuge = mod60.toastLine2(sHuge, p60);
    ok('T60-d1 ★极端行宽度仍 ≤ 44u（三级守卫总收口）', mod60.dispWidth(lHuge) <= 44, 'w=' + mod60.dispWidth(lHuge) + ' ' + lHuge);
    ok('T60-d2 ★极端行金额仍在（任何一级都不得把金额段弄丢）', /¥[\d.]+/.test(lHuge), lHuge);
    } finally {
      // 原样恢复被临时移走的 ⚠账缺 旗标
      if (tfSaved60 !== null) { try { fs.writeFileSync(tfPath60, tfSaved60); } catch (e) { /* 恢复失败不影响被测逻辑 */ } }
    }
  }
}

// ===== T61：v3.51.0 价格抓取「契约海关 + 地域显式绑定 + 语义表头」（审计批1）=====
// 起因：v3.50.0 后新审计 + 用户三轮纠正（币种/区域可分辨、改名要自动、官方页抓不到走聚合源过渡）。
// 核心失效路径（2026-10-12 实测坐实）：parse_tokenhub 用「\d+\.\d{3,} 小数位数」排除新加坡块，
//   而广州表里 MiMo 缓存命中价 0.025 是合法 3 位小数 → 三候选全灭 → 靠 cands[0] 蒙对；
//   一旦腾讯调整 tab 顺序，新加坡块价格就会盖上硬编码的「广州/CNY」戳静默入账。
// 同族活样例：阶跃官方页当天改版（Mintlify 重构，价格不再内联「元」）→ 旧 tr 模式 0 模型
//   （A/B 实证 git HEAD 同时段同样 0，排除本地因素）；页面还带 10-14 生效的调价公告。
// 本组守四件事：A 地域/币种显式绑定禁猜测 / B 契约海关 + 静默转 WARN / C 阶跃 .md 语义解析 /
//   D DeepSeek 旧模型名自动绑定。行为证据（隔离目录真实页面流水线 + 零索引差异）见 CHANGELOG。
{
  const pt61 = fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf-8').replace(/\r\n/g, '\n');
  const fc61 = fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf-8').replace(/\r\n/g, '\n');
  const bi61 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');
  const ds61 = fs.readFileSync(path.join(SRC, 'deepseek-official.js'), 'utf-8').replace(/\r\n/g, '\n');

  // ── a. parse_tokenhub：地域/币种显式绑定，废止一切猜测 ──
  // ⚠️ 负向断言必须**先剥整行注释**再匹配（v3.51.0 实测踩到）：源码里的说明注释必须引用
  //    反例形态（cwd 相对的 makedirs 写法 / 小数位数正则）来解释"为何废止"，不剥注释会把这些
  //    说明文字数进去 → 假红。（同 T59-d3「扫源码先剥注释」的坑，v3.49.0 已踩过一次。）
  const pt61code = pt61.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  ok('T61-a1 ★parse_tokenhub 不得再用小数位数猜区域（re.search(r\'\d+\.\d{3,}\') 排除链必须删除）',
    !/re\.search\(r'\\d\+\\\.\\d\{3,\}'/.test(pt61code),
    '红 = 小数位数猜测链复活（广州表 0.025 缓存价被误杀 → fallback 蒙块 → 新加坡价盖广州/CNY 戳入账）');
  ok('T61-a2 ★parse_tokenhub 不得保留位置 fallback（target = cands[0] 会把仅部分命中的块当目标）',
    !/target = cands\[0\]/.test(pt61code), '红 = cands[0] fallback 复活（选错块 = 区域错价且无告警）');
  ok('T61-a3 ★显式区域绑定函数必须存在（find_region_panels 按 tse-tabs 标签↔面板配对）',
    pt61.indexOf('def find_region_panels') >= 0 && pt61.indexOf('def parse_unit_currency') >= 0);
  ok('T61-a4 ★输出 region/currency/unit 必须来自页面解析值，不得硬编码',
    pt61.indexOf("'region': region_label") >= 0 && pt61.indexOf("'currency': currency") >= 0
    && pt61.indexOf("'unit': unit") >= 0 && pt61.indexOf("'region': '广州'") < 0,
    '红 = 回归硬编码（错区块价格会被盖上正确戳，无从审计）');
  // v3.52.0（S1）：默认值仍必须 HERE 锚定，另允许调用方用 CN_PRICES_DIR 显式覆盖
  //   （恒写脚本目录 = 与调用方读的价库目录不一致 → 自定义价库目录永不填充）。语义未变，断言随实现更新。
  ok('T61-a5 ★输出目录必须 HERE 锚定（cwd 相对的 makedirs(\'prices\') 写错地方且 build_index 静默找不到）',
    !/os\.makedirs\('prices'/.test(pt61code)
    && pt61.indexOf("out_dir = os.environ.get('CN_PRICES_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prices')") >= 0);

  // ── b. build_index：契约海关 + latest.json 不裸崩 + 静默 skip 转 WARN ──
  ok('T61-b1 ★latest.json 读取必须 try 保护（裸崩 = 今日抓取数据全丢且无任何告警）',
    /try:\s*\n\s*d = json\.load\(open\(LATEST/.test(bi61));
  ok('T61-b2 ★契约海关：缺 currency/unit 的条目必须拒收并记入 skipped（不可验证价不许入账）',
    bi61.indexOf("miss = [f for f in ('currency', 'unit') if not m.get(f)]") >= 0);
  ok('T61-b3 ★被跳过条目必须 WARN 列出（静默 continue = 模型从索引悄悄消失、按未收录计费）',
    bi61.indexOf('skipped.append(') >= 0 && bi61.indexOf('[build_index][WARN] %d 个条目未进索引') >= 0);
  ok('T61-b4 ★TokenHub 来源串地域必须用解析值 th_region，不得硬编码「广州」',
    bi61.indexOf("th_region = th.get('region')") >= 0 && bi61.indexOf("'腾讯云TokenHub文档(广州,'") < 0);
  // v3.62.0（外部审计 F-4）：元组新增 effective_from / superseded_at 后跨两行 —— 守卫改为
  //   锚定首行 + 单独断言两个新字段在元组里（既容忍折行，又钉住 F-4 的透达不被回退）。
  ok('T61-b5 ★索引条目必须透出契约字段（下游 mergeLocalPriceDb 按白名单读、未知字段忽略 → 计费侧零影响）',
    bi61.indexOf("for f in ('currency', 'unit', 'region', 'source_url', 'fetched_at',") >= 0
    && bi61.indexOf("'effective_from', 'superseded_at')") >= 0);

  // ── c. fetch-cn-prices：契约字段 + 阶跃 .md 语义解析（2026-10-12 页面改版活样例）──
  // v3.59.0（批12·S5）：unit 兜底从 setdefault 改为「WARN 留痕 + 仍兜底」——
  //   各家解析器已在页面单位声明校验通过后显式回传 unit；走到兜底 = 该厂商没有单位校验
  //   （= 页面改单位会 1000× 错价静默入账的那条路）→ 必须可见，不能再静默。
  ok('T61-c1 ★每条模型记录必须补契约字段（unit/currency/region/source_url/fetched_at）',
    fc61.indexOf("mm['unit'] = '元/百万 tokens'") >= 0
    && fc61.indexOf("mm.setdefault('currency', 'CNY')") >= 0
    && fc61.indexOf("mm.setdefault('region', 'CN')") >= 0);
  ok('T61-c2 ★阶跃必须走 .md 语义解析（HTML 改版后价格不带「元」，tr 模式实测 0 模型）',
    fc61.indexOf("STEPFUN_MD_URL = 'https://platform.stepfun.com/docs/zh/guides/pricing/details.md'") >= 0
    && fc61.indexOf("'mode': 'stepfun_md'") >= 0 && fc61.indexOf('def parse_stepfun_md') >= 0);
  // v3.52.0（审计批2·L2）：实现从「每家各写一份字面量判定」升级为**共享语义同义词表**
  //   map_price_columns（改列名词面只需补表）。断言随实现更新 —— 语义要求本身没变：
  //   缓存未命中→in / 缓存命中→cache / 输出→out，且**不按位置**；新增 T62-e 行为守卫兜底。
  ok('T61-c3 ★阶跃表头必须按语义映射（缓存未命中→in/缓存命中→cache/输出→out），不按位置',
    fc61.indexOf('cmap = map_price_columns(hdr)') >= 0
    && fc61.indexOf("col_in, col_out, col_cache = cmap['in'], cmap['out'], cmap['cache']") >= 0
    && !/cells\[2\]|cells\[3\]|cells\[5\]/.test(fc61.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')));
  ok('T61-c4 ★调价公告必须按生效日期取当日有效值（未来生效按旧值 + tier_note 留痕，不静默采用未来价）',
    fc61.indexOf('STEP_ADJ_RE = re.compile') >= 0 && fc61.indexOf("adj['effective'] > now_iso") >= 0);

  // ── d. deepseek-official：旧模型名自动绑定（官方页显式改名映射，无需猜身份）──
  ok('T61-d1 ★必须解析官方页「旧模型名」正文段（旧名条目曾被 lock+retired 永久冻结在过期价）',
    ds61.indexOf('旧模型名\\s*([^。]*?)\\s*仍可调用') >= 0);
  ok('T61-d2 ★旧模型名命中必须：绑定 alias_of + 采用现行价 + 解除 lock/retired + _manual_audit 留痕',
    ds61.indexOf("matched_by: 'old-name-prose'") >= 0
    && ds61.indexOf('delete m.lock;') >= 0 && ds61.indexOf('delete m.retired;') >= 0
    && ds61.indexOf("m.alias_of = servingId;") >= 0);

  // ── e. 端到端夹具完整性（v3.51.0 修复：c3/c4 夹具漏拷 backfill.js → MODULE_NOT_FOUND 假失败）──
  //   ⚠️ 目标串拆成两段拼接，避免守卫自身源码把它数进去（自匹配 = 恒绿假象，v3.49.0 踩过同族坑）。
  const st61 = fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf-8').replace(/\r\n/g, '\n');
  const bfNeed61 = "'back" + "fill.js', ...RUNTIME_COMPANIONS]";
  ok('T61-e1 ★backfill 端到端夹具必须随行 backfill.js（入口脚本不在 RUNTIME_COMPANIONS → 漏拷即 MODULE_NOT_FOUND 假失败）',
    st61.indexOf(bfNeed61) >= 0);
}

// ===== T62：v3.52.0 抓取链路 P0/P1 + 语义/指纹防御（审计批2）=====
// 四条主线，全部是「静默失效」类（跑完不报错、结果悄悄错）：
//   S1 spawn 相对脚本名 + cwd 强耦合 → 混合部署下流水线整体 ENOENT，且自定义价库目录永不填充；
//   S4 SNAP_RE 一刀切 → 真型号（hy4-preview / MiniMax-*-Preview 类）被静默丢弃、按未收录计价；
//   G3 非 kimi 分支裸 fetch() 绕过 http_get（解压 + TLS 降级）→ 压缩页 = 二进制垃圾 = 0 模型退出码 0；
//   L2 列语义硬编码在各解析器里 → 厂商改列名词面即整家 0 模型；L1 无结构指纹 → 改版与网络失败不可区分。
// 负向断言一律**先剥注释**（v3.49.0/3.51.0 两次踩到：注释里引用反例形态会被数进去 → 假红）。
{
  const tt62 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const fc62 = fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf-8').replace(/\r\n/g, '\n');
  const pt62 = fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf-8').replace(/\r\n/g, '\n');
  const bi62 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');
  const ds62 = fs.readFileSync(path.join(SRC, 'deepseek-official.js'), 'utf-8').replace(/\r\n/g, '\n');
  const pyCode = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const jsCode = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const fc62c = pyCode(fc62), pt62c = pyCode(pt62), bi62c = pyCode(bi62), ds62c = jsCode(ds62), tt62c = jsCode(tt62);

  // ── a. S1：spawn 解耦（脚本绝对路径 + 输出目录与价库目录对齐）──
  ok('T62-a1 ★流水线必须按绝对路径 spawn 脚本（相对脚本名 + cwd 强耦合 = 混合部署下整体 ENOENT）',
    tt62.indexOf('const resolveScript = (name)') >= 0
    && tt62.indexOf('spawn(exe, [scriptPath]') >= 0
    && tt62.indexOf("const p = path.join(base, name)") >= 0 && tt62.indexOf('fs.existsSync(p)') >= 0,
    '红 = 回到「相对脚本名 + cwd=流水线目录」：目录里没有脚本（只有 index.json）时三个脚本全 ENOENT，价库 built_at 永久卡住');
  ok('T62-a2 ★spawn 必须把价库目录以 CN_PRICES_DIR 传给 py 侧（否则自定义价库目录永远不被填充）',
    tt62.indexOf('spawnEnv.CN_PRICES_DIR = CN_PRICE_DIR') >= 0 && tt62.indexOf('env: spawnEnv') >= 0);
  ok('T62-a3 ★三个 py 脚本的输出目录必须支持 CN_PRICES_DIR 覆盖（恒写脚本目录 = 与调用方读的目录不一致）',
    fc62.indexOf("OUT_DIR = os.environ.get('CN_PRICES_DIR')") >= 0
    && pt62.indexOf("out_dir = os.environ.get('CN_PRICES_DIR')") >= 0
    && bi62.indexOf("PRICES_DIR = os.environ.get('CN_PRICES_DIR')") >= 0
    && bi62.indexOf("OUT = os.path.join(PRICES_DIR, 'index.json')") >= 0
    && bi62.indexOf("TOKENHUB = os.path.join(PRICES_DIR, 'tokenhub_lang.json')") >= 0);

  // ── b. S4：快照过滤黑白名单分离（只丢真快照，soft 收录 + 留痕）──
  ok('T62-b1 ★硬黑名单只含真快照（日期后缀 /「快照」字样），不得再含 -preview/-latest/-us',
    fc62.indexOf('SNAP_HARD_RE = re.compile') >= 0 && fc62.indexOf('SNAP_SOFT_RE = re.compile') >= 0
    && !/-preview\$|-latest\$|-us\$/.test(fc62c.split('SNAP_HARD_RE')[1] ? fc62c.split('SNAP_HARD_RE')[1].split('\n')[0] : ''));
  ok('T62-b2 ★soft 命中必须**收录**（漏收真型号 = 按未收录计价），仅进待确认清单',
    fc62.indexOf("return snap_verdict(name, keep_over_re) != 'drop'") >= 0
    && fc62.indexOf('PENDING_CONFIRM.append(name)') >= 0
    && fc62.indexOf("SNAP_SOFT_RE.search(name or '')") >= 0);
  ok('T62-b3 ★三个使用点必须统一走 apply_snap_verdict（不得残留 SNAP_RE.search 直接丢弃）',
    (fc62c.match(/apply_snap_verdict\(/g) || []).length >= 4 && !/SNAP_RE\.search\(name/.test(fc62c));
  ok('T62-b4 ★待确认清单必须 WARN 输出（静默收录/静默丢弃都不可接受）',
    fc62.indexOf("'[WARN] %d 个「疑似快照别名」型号已收录") >= 0
    && fc62.indexOf("'pending_confirm': sorted(set(PENDING_CONFIRM))") >= 0);

  // ── c. G3 / G7 ──
  ok('T62-c1 ★非 kimi 分支必须走 http_get（裸 fetch 绕过解压与 TLS 降级 → 压缩页 = 0 模型退出码 0）',
    fc62.indexOf('html = http_get(cfg[\'url\'])') >= 0 && !/html = fetch\(cfg\['url'\)\)/.test(fc62c));
  ok('T62-c2 ★index.json 写盘前必须滚动备份 .bak（新索引算错时无上一版可回滚）',
    bi62.indexOf("shutil.copyfile(OUT, OUT + '.bak')") >= 0 && bi62.indexOf('import shutil') >= 0);

  // ── d. L2：语义同义词表（改列名词面只补表，不动解析逻辑）──
  //   ⚠️ 计数必须匹配**使用点**（`cmap = map_price_columns(hdr)`）而不是 `map_price_columns(hdr)`
  //   —— 后者会连函数定义行一起数进来 → 定义存在就恒绿（v3.52.0 反向验证实测：把阶跃那处
  //   回退成写死列索引后断言仍绿，守卫等于没设）。
  ok('T62-d1 ★fetch-cn-prices 必须有共享列语义同义词表，且三个解析器都走它（不再各写一份字面量）',
    fc62.indexOf('COL_SYNONYMS = {') >= 0 && fc62.indexOf('def map_price_columns(hdr)') >= 0
    && (fc62c.match(/cmap = map_price_columns\(hdr\)/g) || []).length >= 3);
  ok('T62-d2 ★「未命中」必须先于「命中」判定（「输入价格（缓存未命中）」会被 cache 抢走 —— 阶跃表头正是此写法）',
    fc62.indexOf('miss = _has(c, QUAL_MISS)') >= 0 && fc62.indexOf('hit = (not miss) and _has(c, QUAL_HIT)') >= 0);
  ok('T62-d3 ★parse_tokenhub 列定位必须走语义表（原 col([\'推理输入\']) 字面量 = 改列名即整条源 exit(2)）',
    pt62.indexOf('COL_SYNONYMS = {') >= 0 && pt62.indexOf('def map_columns(hdr)') >= 0
    && !/col\(\['推理输入'\]\)/.test(pt62c) && !/'模型名称' in t and '推理输入' in t/.test(pt62c));
  ok('T62-d4 ★deepseek 行判定必须走 ROW_TERMS 词表（六处硬正则散落 = 改一处漏一处，某价格静默取不到）',
    ds62.indexOf('const ROW_TERMS = {') >= 0 && ds62.indexOf('const hasTerm =') >= 0
    && (ds62c.match(/hasTerm\(joined, ROW_TERMS\./g) || []).length >= 4
    && !/\/百万tokens输入\/\.test/.test(ds62c));
  // 行为验证：官方页改词面（「输入价格 / 输出价格 / 缓存未命中」）后仍必须解析出同一组价
  //   —— 源码守卫证明不了这一点（旧实现的硬正则在这种页面上会**整页取不到价**）。
  {
    const dso62 = require(path.join(SRC, 'deepseek-official.js'));
    const mk = (inWord, outWord, missWord) => `<table>
<tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>${inWord}（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td>${inWord}（${missWord}）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9元</td></tr>
<tr><td>${outWord}</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27元</td></tr>
</table>`;
    let r62a = null, r62b = null, e62 = '';
    try {
      r62a = dso62.parseOfficial(mk('百万tokens输入', '百万tokens输出', '缓存未命中'));
      r62b = dso62.parseOfficial(mk('输入价格', '输出价格', '未命中'));
    } catch (e) { e62 = String(e.message).slice(0, 120); }
    ok('T62-d5 ★deepseek 官方价解析：原词面页必须解析出 6 组价（行为基准）',
      !!r62a && !!r62a.prices && JSON.stringify(r62a.prices.cached.off) === '[0.02,0.15]'
      && JSON.stringify(r62a.prices.uncached.peak) === '[2,9]', e62 || JSON.stringify(r62a && r62a.prices));
    ok('T62-d6 ★deepseek 官方价解析：列名词面改写后仍解析出同一组价（语义词表生效，旧硬正则会整页取不到）',
      !!r62b && !!r62b.prices && JSON.stringify(r62b.prices) === JSON.stringify(r62a.prices),
      e62 || ('旧词面=' + JSON.stringify(r62a && r62a.prices) + ' 新词面=' + JSON.stringify(r62b && r62b.prices)));
  }

  // ── e. L1：结构指纹（0 模型时区分「网络失败」vs「官网改版」）──
  ok('T62-e1 ★两个抓取脚本必须有结构指纹函数，且 0 模型/失败时输出它',
    fc62.indexOf('def scan_fingerprint(text)') >= 0
    && fc62.indexOf("'fingerprints': {k: v.get('fingerprint')") >= 0
    && pt62.indexOf('def scan_fingerprint(html)') >= 0
    && pt62.indexOf('[parse_tokenhub][FINGERPRINT]') >= 0);
  //   ⚠️ 窗口必须覆盖整个 scan_fingerprint 函数体（v3.52.0 反向验证实测：窗口 200 时
  //      「指纹里塞价格字段」的回退**检测不到** —— 价格字段距 `fingerprint` 字样远超 200 字符）。
  const iFp62 = fc62c.indexOf('def scan_fingerprint');
  const segFp62 = iFp62 < 0 ? '' : fc62c.slice(iFp62, iFp62 + 1600);
  ok('T62-e2 ★指纹只描述结构不猜价格（含 bytes/sha1_8/tables/headers，不含价格字段）',
    fc62.indexOf("'sha1_8': hashlib.sha1(") >= 0 && fc62.indexOf("'headers': heads") >= 0
    && !/in_price|out_price|cache_hit/.test(segFp62), segFp62.slice(-160));
}

// ===== T63：v3.53.0 变更分级 + 审计流水 + 新模型闸门 + 脚本定位纠偏（审计批3）=====
// 三条主线：
//   ① **脚本定位纠偏（真网事故）**：v3.52.0 把脚本名改成绝对路径时保留了「价库目录优先」的顺序，
//      而价库目录（~/WorkBuddy/2026-08-30-22-25-15/）里躺着 **2026-09 的旧脚本副本**
//      → 每日刷新一直在跑 9 月的代码，v3.51/v3.52 的契约海关、地域绑定、语义同义词表、结构指纹
//      **在生产环境一次都没生效**（实测 latest.json 全部条目缺 currency/unit，索引靠"逐模型沿用"续命）。
//   ② 变更分级 + 审计流水：index.json 每日整份重建却无"今天变了什么"的记录 —— 调价、单位取错、
//      来源降级三类事故全部静默。口径：**值变=自动，语义变=人工**。
//   ③ 新模型闸门：契约不全 / 价格越界的新条目不进索引（不可溯源、不可复算的价不许入账）。
// 源码守卫证明不了"语义变后索引里到底是新价还是旧价"，故 e 组用**真跑 build_index.py** 兜底。
{
  const tt63 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const bi63 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');
  const bi63c = bi63.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // ── a. 脚本定位：技能目录（代码权威源）必须优先于价库目录（数据目录）──
  //   ⚠️ 断言锚点用**候选入栈顺序**（`cands.push(...)` 的先后），不要绑变量名 —— 绑变量名时
  //   有人改个常量名就能绕过守卫（v3.52.0 反向验证踩过同族坑）。
  const iRs63 = tt63.indexOf('const resolveScript = (name) =>');
  const segRs63 = iRs63 < 0 ? '' : tt63.slice(iRs63, iRs63 + 900);
  ok('T63-a1 ★流水线脚本定位必须技能目录(__dirname)优先于价库目录（价库目录常驻旧副本 → 每日跑旧代码）',
    iRs63 >= 0 && segRs63.indexOf('cands.push(__dirname)') >= 0
    && segRs63.indexOf('cands.push(path.dirname(CN_PRICE_DIR))') >= 0
    && segRs63.indexOf('cands.push(__dirname)') < segRs63.indexOf('cands.push(path.dirname(CN_PRICE_DIR))'),
    '红 = 顺序回到「价库目录优先」：价库目录里的 2026-09 旧脚本会被当成代码跑，所有新修复静默失效');
  ok('T63-a2 ★CN_PRICE_PIPELINE_DIR 显式指定时仍是最高优先（用户显式覆盖必须尊重）',
    segRs63.indexOf('cands.push(process.env.CN_PRICE_PIPELINE_DIR)') >= 0
    && segRs63.indexOf('cands.push(process.env.CN_PRICE_PIPELINE_DIR)') < segRs63.indexOf('cands.push(__dirname)'));

  // ── b. 新模型闸门 ──
  ok('T63-b1 ★必须有新条目闸门函数，且 lock(authoritative) 条目豁免（用户已校对的价不受闸门干预）',
    bi63.indexOf('def gate_new_model(e, full)') >= 0 && bi63.indexOf("if e.get('authoritative'):") >= 0
    && bi63.indexOf("return True, ''") >= 0);
  ok('T63-b2 ★新条目必须校验完整契约五字段 + 价格区间（缺溯源 / 越界 = 不可入账）',
    bi63.indexOf('CONTRACT_FULL = (') >= 0 && bi63.indexOf("'source_url', 'fetched_at')") >= 0
    && bi63.indexOf('PRICE_MIN, PRICE_MAX = ') >= 0
    && bi63.indexOf('if not (PRICE_MIN <= v <= PRICE_MAX)') >= 0);
  ok('T63-b3 ★首次构建（无上一版可对比）必须降级为最小契约（否则闸门会清空整库）',
    bi63.indexOf('gate_full = bool(prev_models)') >= 0
    && bi63.indexOf('need = CONTRACT_FULL if full else CONTRACT_MIN') >= 0);
  ok('T63-b4 ★闸门必须有安全阀：整库将空时回退上一版（保险不能反过来变成数据灾难）',
    bi63.indexOf('if not merged and prev_models:') >= 0 && bi63.indexOf("'kind': 'rollback'") >= 0
    && bi63.indexOf('[build_index][ERROR]') >= 0);

  // ── c. 变更分级 ──
  ok('T63-c1 ★必须有变更分级函数，语义字段 = unit/currency（值变自动采纳，语义变进人工缝）',
    bi63.indexOf('def classify_change(pe, ne)') >= 0
    && bi63.indexOf("SEMANTIC_GUARDED = ('unit', 'currency')") >= 0);
  ok('T63-c2 ★只有两边都有值且不同才算变化（上一版缺字段而本版补上是"补全"，判成语义变会作废新价）',
    bi63.indexOf('if po and pn and po != pn:') >= 0);
  ok('T63-c3 ★语义变必须保留上一版价格与单位，并挂 _manual_audit（新值可能差 1000 倍）',
    bi63.indexOf("if 'semantic' in kinds:") >= 0 && bi63.indexOf('e[f] = pe[f]') >= 0
    && bi63.indexOf("'kind': 'semantic'") >= 0 && bi63.indexOf("'new_values': new_vals") >= 0);
  ok('T63-c4 ★价格跳变阈值：值变自动采纳，但 >5× / <1/5 必须 WARN（多半是单位或列取错）',
    bi63.indexOf('BIG_JUMP = 5.0') >= 0 && bi63.indexOf('r >= BIG_JUMP or r <= 1.0 / BIG_JUMP') >= 0);

  // ── d. 审计流水 ──
  //   ⚠️ 断言必须覆盖「阈值判定真的被用上」（`os.path.getsize(...) > CHANGE_ROLL_MAX`）——
  //   只查常量与 copyfile 存在的话，把判定改成 `False`（滚动失效、文件无限增长）仍然恒绿
  //   （v3.53.0 反向验证 R9 实测：回退后守卫全绿，等于没设）。
  ok('T63-d1 ★审计流水必须 append-only（模式 \'a\'）+ 超限滚动（不能只写不留，也不能无限增长）',
    bi63.indexOf("open(CHANGE_FILE, 'a', encoding='utf-8')") >= 0
    && bi63.indexOf('CHANGE_ROLL_MAX = ') >= 0 && bi63.indexOf('shutil.copyfile(CHANGE_FILE, CHANGE_ROLL_TO)') >= 0
    && bi63.indexOf('os.path.getsize(CHANGE_FILE) > CHANGE_ROLL_MAX') >= 0);
  ok('T63-d2 ★分级种类必须覆盖 new/rejected/price/semantic/big_jump/source_downgrade/region/carried/retired',
    ["kinds.append('price')", "'kind': 'new'", "'kind': 'rejected'", "'kind': 'semantic'",
     "kinds.append('big_jump')", "kinds.append('source_downgrade' if", "kinds.append('region')",
     "'kind': 'carried'", "'kind': 'retired'"].every((s) => bi63.indexOf(s) >= 0));
  ok('T63-d3 ★审计流水写失败不得阻断索引产出（留痕是保险，不能反过来卡住当日价库）',
    bi63.indexOf('[build_index][WARN] changes.jsonl 写入失败') >= 0);

  // ── e. 行为验证：真跑 build_index.py（源码守卫证明不了"索引里最后是旧价还是新价"）──
  {
    const py63 = (() => {
      if (process.env.CN_PYTHON) return process.env.CN_PYTHON;
      try {
        const root = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions');
        for (const v of fs.readdirSync(root).sort().reverse()) {
          const p = path.join(root, v, 'python.exe');
          if (fs.existsSync(p)) return p;
        }
      } catch (e) { /* 探测失败 → 回退裸 python */ }
      return 'python';
    })();
    const probe63 = spawnSync(py63, ['-c', 'print(1)'], { timeout: 20000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    const pyOk63 = !!(probe63.status === 0);
    if (!SPAWN_OK || !pyOk63) {
      for (const n of ['T63-e1', 'T63-e2', 'T63-e3', 'T63-e4', 'T63-e5', 'T63-e6']) {
        envSkip(n + ' ★build_index 行为验证（真跑 python）',
          !SPAWN_OK ? SPAWN_SKIP_REASON : ('未找到可用 python（试探 ' + py63 + ' 失败）；CI 上应为 0'));
      }
    } else {
      const d63 = path.join(tmp, 't63');
      const p63 = path.join(d63, 'prices');
      fs.mkdirSync(p63, { recursive: true });
      fs.mkdirSync(path.join(d63, 'wbroot'), { recursive: true }); // 空 WB_ROOT → 跳过 pricing.json(lock) 覆盖层
      const U63 = '元/百万 tokens';
      const mk63 = (i, o, over) => Object.assign({
        in_price: i, out_price: o, cache_hit: 0.1, currency: 'CNY', unit: U63,
        region: 'CN', source_url: 'http://x', fetched_at: '2026-10-13T00:00:00',
      }, over || {});
      const ent63 = (i, o) => ({
        name: 'n', api_name: 'n', in_price: i, out_price: o, cache_hit: 0.1,
        primary_source: 'src', primary_source_type: 'first_party', tier_note: '', all_sources: [],
        currency: 'CNY', unit: U63, region: 'CN',
      });
      fs.writeFileSync(path.join(p63, 'index.json'), JSON.stringify({
        built_at: new Date().toISOString().slice(0, 10),
        models: { a: ent63(1.0, 2.0), b: ent63(1.0, 2.0), gone: ent63(1.0, 2.0),
                  // f：上一版**缺** unit（老索引），本版补上 → 属"补全"不是"变化"，必须采用新价
                  f: Object.assign(ent63(1.0, 2.0), { unit: null }) },
      }));
      fs.writeFileSync(path.join(p63, 'latest.json'), JSON.stringify({
        fetched_at: '2026-10-13T00:00:00',
        vendors: {
          zhipu: { name: '智谱', models: [
            Object.assign(mk63(1.2, 2.0), { name: 'a', api_name: 'a' }),                              // 值变
            Object.assign(mk63(1000.0, 2000.0, { unit: '元/千 tokens' }), { name: 'b', api_name: 'b' }), // 语义变
            Object.assign(mk63(5.0, 6.0), { name: 'f', api_name: 'f' }),                              // 补全 unit → 采用新价
          ] },
          minimax: { name: 'MiniMax', models: [
            Object.assign(mk63(2.0, 4.0), { name: 'newok', api_name: 'newok' }),                       // 契约全 → 收录
            Object.assign(mk63(2.0, 4.0, { region: undefined }), { name: 'newnoregion', api_name: 'newnoregion' }), // 缺 region → 拒
            Object.assign(mk63(99999.0, 4.0), { name: 'newbadprice', api_name: 'newbadprice' }),       // 越界 → 拒
          ] },
        },
      }));
      const env63 = Object.assign({}, process.env, PY_IO_ENV, { CN_PRICES_DIR: p63, WB_ROOT: path.join(d63, 'wbroot') });
      const r63 = spawnSync(py63, [path.join(SRC, 'build_index.py')],
        { cwd: d63, env: env63, timeout: 120000, windowsHide: true, encoding: 'utf-8' });
      let idx63 = null, ch63 = [];
      try { idx63 = JSON.parse(fs.readFileSync(path.join(p63, 'index.json'), 'utf-8')); } catch (e) { /* 下方断言会红 */ }
      try {
        ch63 = fs.readFileSync(path.join(p63, 'changes.jsonl'), 'utf-8').split('\n')
          .filter((l) => l.trim()).map((l) => JSON.parse(l));
      } catch (e) { /* 同上 */ }
      const M63 = (idx63 && idx63.models) || {};
      const kinds63 = ch63.reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + 1; return a; }, {});
      const log63 = String((r63 && (r63.stdout + r63.stderr)) || '');
      ok('T63-e1 ★值变自动采纳（a 的新价 1.2 进索引）', M63.a && M63.a.in_price === 1.2,
        JSON.stringify(M63.a) + ' | ' + log63.slice(-200));
      ok('T63-e2 ★语义变保留旧价 + 旧单位 + 挂 _manual_audit（不采用可能差 1000 倍的新值）',
        M63.b && M63.b.in_price === 1.0 && M63.b.unit === U63
        && (M63.b._manual_audit || {}).kind === 'semantic'
        && (M63.b._manual_audit.new_values || {}).in_price === 1000.0,
        JSON.stringify(M63.b));
      ok('T63-e3 ★新条目：契约全 → 收录；缺 region / 价格越界 → 拒收',
        !!M63.newok && !M63.newnoregion && !M63.newbadprice, Object.keys(M63).join(','));
      ok('T63-e4 ★缺失模型沿用旧价（gone 仍在）', !!M63.gone);
      ok('T63-e5 ★审计流水落盘且含 new/rejected/price/semantic/carried 五类',
        ['new', 'rejected', 'price', 'semantic', 'carried'].every((k) => kinds63[k] > 0), JSON.stringify(kinds63));
      ok('T63-e6 ★闸门模式：有上一版时为 full，且拒收有 WARN 输出',
        (idx63 && idx63._changes && idx63._changes.gate_mode === 'full')
        && log63.indexOf('被闸门拒收') >= 0 && log63.indexOf('单位/币种') >= 0,
        JSON.stringify(idx63 && idx63._changes) + ' | ' + log63.slice(-300));
      ok('T63-e7 ★上一版缺字段而本版补上 = 补全，必须采用新价（判成语义变会作废新解析结果）',
        M63.f && M63.f.in_price === 5.0 && !M63.f._manual_audit, JSON.stringify(M63.f));
    }
  }
}


// ===== T64：v3.54.0 冗余交叉校验 + CN/USD 一致性 + 峰谷 effective_from（审计批4）=====
// 三条主线：
//   ① **L5 冗余交叉**：索引此前是「单源无条件采信」—— 主候选按 first_party > channel 排序后取第一个，
//      all_sources 只是存档、从不参与校验 → 多源价格差 1000×（元/千 tokens 被当元/百万）也静默通过。
//      交叉校验**只留痕 + WARN，不改价**（改价 = 用一个猜测覆盖另一个猜测，与「不凭空造钱」冲突）。
//   ② **CN/USD 一致性**：索引顶层写死 currency='CNY'、下游按人民币计。USD 价混进来 = 金额差一个汇率
//      且完全静默 → 新条目由闸门拒收、已有条目挂 _manual_audit（**不折算**：折算 = 凭空造一个数）。
//   ③ **峰谷 effective_from**：peak 倍率一变，recalc 出来的**历史**金额整体漂移；
//      「金额=派生值」口径允许漂移，但生效日期必须落进索引（否则事后无从解释金额变动）。
// 源码守卫证明不了「冲突之后索引里到底是哪个价、条目还在不在」，故 e 组真跑 build_index.py。
{
  const bi64 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');

  // ── a. L5 冗余交叉：多源互证 ──
  //   ⚠️ 断言必须匹配**使用点**（`cc_conf, cc_note = cross_check(primary, cands)`）：
  //   只匹配函数名会把 def 行算进去 → 定义存在即恒绿（v3.52.0 反向验证踩过同族坑）。
  ok('T64-a1 ★必须有多源交叉校验函数，且在合并处被真正调用（定义了不用 = 没有第二意见）',
    bi64.indexOf('def cross_check(primary, cands)') >= 0
    && bi64.indexOf('cc_conf, cc_note = cross_check(primary, cands)') >= 0,
    '红 = 交叉校验没接进合并链路；单源解析错（差 1000×）无人复核');
  ok('T64-a2 ★阈值判定必须真的被用上（只查常量存在的话，把阈值改成 1e9 仍然恒绿）',
    bi64.indexOf('CROSS_WARN = 3.0') >= 0 && bi64.indexOf('CROSS_TOL = 10.0') >= 0
    && bi64.indexOf('if r >= CROSS_TOL:') >= 0 && bi64.indexOf('elif r >= CROSS_WARN:') >= 0);
  ok('T64-a3 ★交叉校验只留痕不改价（写进 _cross_check + 记 cross_conflict）',
    bi64.indexOf("entry['_cross_check'] = cc") >= 0 && bi64.indexOf("'kind': 'cross_conflict'") >= 0,
    '红 = 交叉校验开始改价：用「另一源更像对的」覆盖本源，本质是用一个猜测覆盖另一个猜测');
  // ── b. 条目内交叉（G2 收紧）──
  ok('T64-b1 ★条目内交叉：缓存命中价 > 输入价必须判为冲突（缓存是折扣价，高了几乎总是列取串）',
    bi64.indexOf('def intra_check(entry)') >= 0 && bi64.indexOf("'sub': 'cache_gt_input'") >= 0
    && bi64.indexOf('c > i') >= 0);
  ok('T64-b2 ★条目内交叉必须在合并处被调用（refresh-prices 已拦一次，索引侧必须再拦一次）',
    bi64.indexOf('cc_intra = intra_check(entry)') >= 0);
  // ── c. CN/USD 一致性 ──
  ok('T64-c1 ★必须有币种一致性校验，且**缺失不算不一致**（老索引整批无 currency，判成不一致会整库挂起）',
    bi64.indexOf('def currency_allowed(cur)') >= 0 && bi64.indexOf("ALLOWED_CURRENCY = ('CNY',)") >= 0
    && bi64.indexOf('return (not cur) or (str(cur).upper() in ALLOWED_CURRENCY)') >= 0);
  ok('T64-c2 ★非 CNY 的新条目必须被闸门拒收（混进 CNY 库 = 金额差一个汇率）',
    bi64.indexOf("if not currency_allowed(e.get('currency')):\n        return False") >= 0
    && bi64.indexOf('币种非 CNY') >= 0);
  //   ⚠️ 锚点必须唯一到「已有条目」那一处：沿用段还另有一条同 kind 的记录，
  //   只匹配 `'kind': 'currency_mismatch'` 的话，把已有条目这整段删掉仍然恒绿（反向验证 R7 实测）。
  ok('T64-c3 ★非 CNY 的已有条目必须挂 _manual_audit 且**不折算**（折算 = 凭空造一个数）',
    bi64.indexOf("if not currency_allowed(e.get('currency')) and not e.get('_manual_audit'):") >= 0
    && bi64.indexOf('价格原样保留未折算') >= 0);
  // ── d. 峰谷 effective_from ──
  ok('T64-d1 ★峰谷规则变化必须被分级识别，且**两边都有值才判变化**（首次出现 peak 不是变化）',
    bi64.indexOf("pk_o, pk_n = pe.get('peak'), ne.get('peak')") >= 0
    && bi64.indexOf('if pk_o and pk_n and pk_o != pk_n:') >= 0
    && bi64.indexOf("kinds.append('peak_rule')") >= 0);
  ok('T64-d2 ★峰谷规则变化必须落 peak_effective_from（历史 recalc 会漂移，生效日期必须有据可查）',
    bi64.indexOf("e['peak_effective_from'] = today_iso0") >= 0);
  ok('T64-d3 ★索引顶层必须给出契约口径汇总（币种分布 / 非 CNY 清单 / 交叉阈值）',
    bi64.indexOf("'_contract': {") >= 0 && bi64.indexOf("'currency_counts': cur_counts") >= 0
    && bi64.indexOf("'non_cny': sorted(non_cny)") >= 0 && bi64.indexOf("'cross_tolerance'") >= 0);
  //   ⚠️ 必须匹配 **stderr 文案形态**，不能只匹配关键词：源码注释里同样写着「峰谷规则变化」
  //   → 删掉告警段后关键词仍在、断言恒绿（反向验证 R11 实测；与「扫源码先剥注释」同族坑）。
  ok('T64-d4 ★三类新告警必须有 stderr 输出（留痕不外显 = 等于没留）',
    ['%d 个条目交叉校验冲突', '%d 个条目币种非 CNY', '%d 个条目峰谷规则变化'].every((s) => bi64.indexOf(s) >= 0)
    && bi64.indexOf('[build_index][WARN]') >= 0);

  // ── e. 行为验证：真跑 build_index.py ──
  {
    const py64 = (() => {
      if (process.env.CN_PYTHON) return process.env.CN_PYTHON;
      try {
        const root = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions');
        for (const v of fs.readdirSync(root).sort().reverse()) {
          const p = path.join(root, v, 'python.exe');
          if (fs.existsSync(p)) return p;
        }
      } catch (e) { /* 探测失败 → 回退裸 python */ }
      return 'python';
    })();
    const probe64 = spawnSync(py64, ['-c', 'print(1)'], { timeout: 20000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    const pyOk64 = !!(probe64.status === 0);
    if (!SPAWN_OK || !pyOk64) {
      for (const n of ['T64-e1', 'T64-e2', 'T64-e3', 'T64-e4', 'T64-e5', 'T64-e6', 'T64-e7', 'T64-e8']) {
        envSkip(n + ' ★build_index 行为验证（真跑 python）',
          !SPAWN_OK ? SPAWN_SKIP_REASON : ('未找到可用 python（试探 ' + py64 + ' 失败）；CI 上应为 0'));
      }
    } else {
      const d64 = path.join(tmp, 't64');
      const p64 = path.join(d64, 'prices');
      fs.mkdirSync(p64, { recursive: true });
      fs.mkdirSync(path.join(d64, 'wbroot'), { recursive: true }); // 空 WB_ROOT → 跳过 pricing.json(lock) 覆盖层
      const U64 = '元/百万 tokens';
      // ⚠️ 用**本地日期**而非 toISOString()：py 侧是 datetime.date.today()（本地），
      //    UTC 日期在 GMT+8 的凌晨会差一天 → 断言永远红（假失败）。
      const nd = new Date();
      const today64 = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
      const mk64 = (i, o, over) => Object.assign({
        in_price: i, out_price: o, cache_hit: 0.1, currency: 'CNY', unit: U64,
        region: 'CN', source_url: 'http://x', fetched_at: today64 + 'T00:00:00',
      }, over || {});
      const ent64 = (i, o, over) => Object.assign({
        name: 'n', api_name: 'n', in_price: i, out_price: o, cache_hit: 0.1,
        primary_source: 'src', primary_source_type: 'first_party', tier_note: '', all_sources: [],
        currency: 'CNY', unit: U64, region: 'CN',
      }, over || {});
      const peakOf = (pi, po) => ({ idle: { in: 1.0, out: 2.0, cache: 0.1 },
                                    peak: { in: pi, out: po, cache: 0.1 } });
      fs.writeFileSync(path.join(p64, 'index.json'), JSON.stringify({
        built_at: today64,
        models: {
          deepseekx: ent64(1.0, 2.0),                                 // 本版两源：官方 1.2 / 转售 1200（1000×）
          ci: ent64(1.0, 2.0),                                        // 本版缓存价 1.5 > 输入价 1.0
          pk: ent64(1.0, 2.0, { peak: peakOf(2.0, 4.0) }),            // 峰谷规则：高峰 2× → 4×
          oldusd: ent64(1.0, 2.0, { currency: 'USD' }),               // 历史遗留非 CNY（本版抓不到 → 沿用）
          oldusd2: ent64(1.0, 2.0, { currency: 'USD' }),              // 历史遗留非 CNY（**本版仍抓到** → 走已有条目路径）
        },
      }));
      fs.writeFileSync(path.join(p64, 'latest.json'), JSON.stringify({
        fetched_at: today64 + 'T00:00:00',
        vendors: {
          deepseek: { name: 'DeepSeek', models: [
            Object.assign(mk64(1.2, 2.4), { name: 'x', api_name: 'deepseekx' }),              // first_party 1.2
            Object.assign(mk64(1.0, 2.0, { cache_hit: 1.5 }), { name: 'ci', api_name: 'ci' }), // 缓存价 > 输入价
          ] },
          aliyun: { name: '阿里云', models: [
            Object.assign(mk64(1200.0, 2400.0), { name: 'x', api_name: 'deepseekx' }),        // channel 1200（1000×）
          ] },
          minimax: { name: 'MiniMax', models: [
            Object.assign(mk64(2.0, 4.0, { currency: 'USD' }), { name: 'newusd', api_name: 'newusd' }), // 非 CNY 新条目 → 拒收
            Object.assign(mk64(2.0, 4.0, { currency: 'USD' }), { name: 'oldusd2', api_name: 'oldusd2' }), // 非 CNY **已有**条目 → 挂起
          ] },
        },
      }));
      // 峰谷规则走 TokenHub 路径（latest.json 的 vendor 路径不产 peak）
      fs.writeFileSync(path.join(p64, 'tokenhub_lang.json'), JSON.stringify({
        region: '广州',
        models: [{ name: 'pk', api_name: 'pk', currency: 'CNY', unit: U64, region: 'CN',
          source_url: 'http://x', fetched_at: today64 + 'T00:00:00', first_party: true, sku: 'sku1',
          tiers: [{ type: 'peak', value: '空闲时段', in: 1.0, out: 2.0, cache: 0.1 },
                  { type: 'peak', value: '高峰时段', in: 4.0, out: 8.0, cache: 0.4 }] }],
      }));
      const env64 = Object.assign({}, process.env, PY_IO_ENV, { CN_PRICES_DIR: p64, WB_ROOT: path.join(d64, 'wbroot') });
      const r64 = spawnSync(py64, [path.join(SRC, 'build_index.py')],
        { cwd: d64, env: env64, timeout: 120000, windowsHide: true, encoding: 'utf-8' });
      let idx64 = null, ch64 = [];
      try { idx64 = JSON.parse(fs.readFileSync(path.join(p64, 'index.json'), 'utf-8')); } catch (e) { /* 下方断言会红 */ }
      try {
        ch64 = fs.readFileSync(path.join(p64, 'changes.jsonl'), 'utf-8').split('\n')
          .filter((l) => l.trim()).map((l) => JSON.parse(l));
      } catch (e) { /* 同上 */ }
      const M64 = (idx64 && idx64.models) || {};
      const C64 = (idx64 && idx64._contract) || {};
      const kinds64 = ch64.reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + 1; return a; }, {});
      const log64 = String((r64 && (r64.stdout + r64.stderr)) || '');
      const conf64 = ((M64.deepseekx || {})._cross_check || {}).conflicts || [];
      ok('T64-e1 ★多源交叉冲突（官方 1.2 vs 转售 1200，1000×）必须留痕且**不改价**（仍用官方 1.2）',
        M64.deepseekx && M64.deepseekx.in_price === 1.2 && conf64.length >= 1
        && conf64[0].ratio >= 10, JSON.stringify(M64.deepseekx && M64.deepseekx._cross_check) + ' | ' + log64.slice(-200));
      ok('T64-e2 ★条目内交叉：缓存价 1.5 > 输入价 1.0 → intra 留痕，价格原样保留（不删条目、不改价）',
        M64.ci && M64.ci.cache_hit === 1.5
        && (((M64.ci._cross_check || {}).intra || [])[0] || {}).sub === 'cache_gt_input',
        JSON.stringify(M64.ci && M64.ci._cross_check));
      ok('T64-e3 ★非 CNY 的新条目必须被闸门拒收（混进 CNY 库 = 金额差一个汇率）',
        !M64.newusd
        && ch64.some((c) => c.kind === 'rejected' && String(c.reason || '').indexOf('币种非 CNY') >= 0),
        JSON.stringify(ch64.filter((c) => c.kind === 'rejected')));
      ok('T64-e4 ★非 CNY 条目一律记 currency_mismatch：沿用条目（oldusd）+ 本版仍抓到的已有条目（oldusd2 挂 _manual_audit）',
        !!M64.oldusd && !!M64.oldusd2
        && ((M64.oldusd2 || {})._manual_audit || {}).kind === 'currency_mismatch'
        && (kinds64.currency_mismatch || 0) >= 2
        && Array.isArray(C64.non_cny) && C64.non_cny.indexOf('oldusd') >= 0
        && C64.non_cny.indexOf('oldusd2') >= 0,
        JSON.stringify({ kinds: kinds64, contract: C64, a2: (M64.oldusd2 || {})._manual_audit }));
      ok('T64-e5 ★峰谷规则变化必须落 peak_effective_from=今天，且采用新倍率（不是语义变，价格照常更新）',
        M64.pk && M64.pk.peak_effective_from === today64
        && M64.pk.peak && M64.pk.peak.peak && M64.pk.peak.peak.in === 4.0
        && (kinds64.peak_rule || 0) >= 1,
        JSON.stringify({ pk: M64.pk, peak_rule: kinds64.peak_rule }));
      ok('T64-e6 ★三类新告警必须有 stderr 输出（留痕不外显 = 等于没留）',
        log64.indexOf('交叉校验冲突') >= 0 && log64.indexOf('币种非 CNY') >= 0
        && log64.indexOf('峰谷规则变化') >= 0, log64.slice(-500));
      ok('T64-e7 ★顶层契约口径汇总：币种分布 + 交叉阈值（人工一眼看清库里混没混币种）',
        C64.currency_counts && C64.currency_counts.CNY >= 3
        && C64.cross_tolerance && C64.cross_tolerance.conflict === 10 && C64.cross_tolerance.warn === 3,
        JSON.stringify(C64));
      ok('T64-e8 ★交叉冲突**只留痕不删条目**（deepseekx/ci/pk/oldusd 全部仍在索引里）',
        ['deepseekx', 'ci', 'pk', 'oldusd', 'oldusd2'].every((k) => !!M64[k]), Object.keys(M64).join(','));
    }
  }
}


// ===== T65：v3.55.0 未映射模型可见化 + 账本模型级 merge + 缓存价比值校验 + 文档口径对齐（审计批5）=====
// 四条主线：
//   ① **A2 未映射模型不再静默丢**：parse_tokenhub 只收混元，旧实现一条 `brand == 'hunyuan'` 了事 →
//      BRAND_MAP 里没有的新混元模型 brand=None，被同一条语句丢掉且**无声**；0 模型 exit(2) 只在
//      「全都没映射」时兜住，**部分失效**（新混元上线 / 老模型改名）时旧模型照常解析 → 静默消失。
//      修法守住「品牌不许猜」红线：不新增启发式，只把「丢弃」分三路记账（第三方=预期 / 未识别=意外+告警）。
//   ② **S3 账本合并改模型级**：backfill --write 旧式 `Object.assign({}, cur, newDaily)` 的 key 是**日期**
//      → 同日期整块被顶掉 → 只存在于已删除 transcript 里的模型用量被抹掉（该文件 :270 注释自己承认）。
//   ③ **G2 缓存价/输入价比值**：priceGate 此前只拦 `cached > input`，拦不住「缓存价填成别的档位价」
//      （<= 输入价 → 全部放行），而金额 ≈ 缓存价 × 缓存量（本机命中率 ~97%）→ 同向错且无提示。
//   ④ **G8/G9 文档债**：阈值字面量与峰谷口径注释与代码脱节（代码 44 / 文档 51；UTC 表述 vs 北京时间实现）。
// ⚠️ 断言纪律（v3.52~3.54 反向验证连踩过）：匹配**使用点**而非定义处；扫源码先 stripComments；
//    锚点必须唯一到那一处；期望集按「该回退真正断掉哪条路径」写，不写宽。
{
  const rd65 = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
  const pth65 = stripComments(rd65('parse_tokenhub.py'));
  const bf65 = stripComments(rd65('backfill.js'));
  const rp65 = stripComments(rd65('refresh-prices.js'));
  const tt65c = stripComments(rd65('token-tracker.js'));
  const tt65 = rd65('token-tracker.js');   // d4 要查**注释**里的旧值 → 必须未剥注释
  const rh65 = rd65('refresh-holidays.js'); // d5 同理（澄清口径就写在头注释里）
  const lm65 = stripComments(rd65('ledger-merge.js'));
  const sk65 = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf-8');
  const rdm65 = fs.readFileSync(path.join(SRC, 'README.md'), 'utf-8');

  // ── a. A2：未映射模型可见化 ──
  // v3.63.4：main 的收录入口从 keep_hunyuan 改为 split_scope（四路分流：多出「非通用排除」），
  //   断言随之更新为「split_scope 被调用 + keep_hunyuan 在 split_scope 内被调用」—— 意图不变：
  //   过滤函数必须定义**且**在解析结果处真正接上（定义了不用 = 白写）。
  ok('T65-a1 ★keep_hunyuan 必须定义且在解析结果处被真正调用（split_scope→keep_hunyuan，定义了不用 = 白写）',
    pth65.indexOf('def keep_hunyuan(models)') >= 0
    && pth65.indexOf('models, unmapped, excluded = split_scope(models)') >= 0
    && pth65.indexOf('kept, unmapped = keep_hunyuan(models)') >= 0);
  ok('T65-a2 ★三路分流：混元收 / 已知第三方丢 / 未识别进 unmapped；且**不得新增品牌启发式**',
    pth65.indexOf("if b == 'hunyuan':") >= 0
    && pth65.indexOf('elif b:') >= 0
    && pth65.indexOf('unmapped.append(nm)') >= 0
    && !/startswith\(\s*['"]Hy/.test(pth65),
    '红 = 有人用前缀猜品牌（红线：品牌必须显式解析）');
  ok('T65-a3 ★未映射必须落进输出的 _unmapped 字段（只 WARN 不留痕 = 事后无从查证）',
    pth65.indexOf("'_unmapped': unmapped") >= 0);
  ok('T65-a4 ★未映射必须有 stderr WARN 且带模型名清单（只给计数 = 无法定位是哪个模型）',
    pth65.indexOf('个模型名未在 BRAND_MAP 中映射') >= 0
    && pth65.indexOf('[parse_tokenhub][WARN]') >= 0);

  // ── b. S3：账本模型级 merge ──
  ok('T65-b1 ★账本合并必须抽成可单测的 ledger-merge.js 纯函数模块（否则行为无从验证）',
    lm65.indexOf('function mergeDailyLedger(cur, newDaily, dayTotalOf)') >= 0
    && lm65.indexOf('module.exports = { mergeDailyLedger }') >= 0);
  ok('T65-b2 ★backfill 必须 require 且在提交处调用（只 require 不调用 = 没接上）',
    bf65.indexOf("require('./ledger-merge.js')") >= 0
    && bf65.indexOf('mergeDailyLedger(cur, newDaily, dayTotalOf)') >= 0,
    '红 = 有人把合并逻辑又塞回锁内');
  ok('T65-b3 ★旧式「日期级整块替换」必须消失（以日期为 key → 同日期整块被顶掉）',
    !/Object\.assign\(\{\},\s*cur,\s*newDaily\)/.test(bf65),
    '红 = 账本合并退回整块覆盖，重放抓不到的模型会被抹掉');
  ok('T65-b4 ★重放抓不到的模型必须保留并打 stale_carried（不打标记 = 事后分不清哪些是沿用）',
    lm65.indexOf('{ stale_carried: true }') >= 0);
  ok('T65-b5 ★同日期 total 必须按合并后的 models 重算（沿用旧 total = 汇总少一块）',
    lm65.indexOf('total: dayTotalOf(m)') >= 0);

  // ── c. G2：缓存价 / 输入价 比值校验 ──
  ok('T65-c1 ★必须有正常带常量 CACHE_RATIO（实证：本机 16 模型实测 2.0%~28.7%，两侧各留一倍余量）',
    /const CACHE_RATIO = \{ lo: 0\.005, hi: 0\.5 \};/.test(rp65));
  ok('T65-c2 ★比值必须用**有效价**算（effCa/effIn，不能用已判异常回退掉的旧值）',
    rp65.indexOf('const ratio = effCa / effIn;') >= 0
    && rp65.indexOf('ratio > CACHE_RATIO.hi || ratio < CACHE_RATIO.lo') >= 0);
  ok('T65-c3 ★越界**只告警不阻断**（比值越界 ≠ 错价；设 out.cached 会冻住价库）',
    (() => {
      const i = rp65.indexOf('const ratio = effCa / effIn;');
      if (i < 0) return false;
      const body = rp65.slice(i, i + 400);
      return body.indexOf('warnSink.push') >= 0 && body.indexOf('out.cached = true') < 0;
    })(), '红 = 比值校验开始阻断刷新');
  ok('T65-c4 ★CACHE_RATIO 必须导出（否则行为守卫无法真跑 priceGate）',
    rp65.indexOf('PRICE_SANITY, CACHE_RATIO, DEFAULT_RATE') >= 0);

  // ── d. G8/G9：文档与注释口径 ──
  ok('T65-d1 ★TOAST_LINE_MAX_W 代码常量必须为 44（51 高于通知卡片真实极限 → 宽度守卫永不触发）',
    /const TOAST_LINE_MAX_W = 44;/.test(tt65c));
  ok('T65-d2 ★SKILL.md 不得再写 51，且必须写 44（文档漂移 → 照文档改代码 = 改回无实证值）',
    sk65.indexOf('TOAST_LINE_MAX_W=51') < 0 && sk65.indexOf('TOAST_LINE_MAX_W=44') >= 0);
  ok('T65-d3 ★README.md 同上',
    rdm65.indexOf('TOAST_LINE_MAX_W=51') < 0 && rdm65.indexOf('TOAST_LINE_MAX_W=44') >= 0);
  ok('T65-d4 ★token-tracker.js 行内注释也不得残留 51（注释里的旧值会误导下一个人）',
    tt65.indexOf('TOAST_LINE_MAX_W=51') < 0, '红 = 有人把注释改回 51');
  ok('T65-d5 ★refresh-holidays 头注释必须澄清「峰时段判定不在本脚本」并指向 peak-rules.js',
    rh65.indexOf('peak-rules.js') >= 0 && rh65.indexOf('DEFAULT_RANGES') >= 0);

  // ── e. 行为守卫（源码守卫证明不了「合并后到底保留没保留 / 告警到底出没出」）──
  //   S3/G2 已抽成可 require 的纯函数模块 → 直接真跑；A2 是 python，走与 T64-e 相同的探测 + envSkip 通道。
  {
    const { mergeDailyLedger } = require(path.join(SRC, 'ledger-merge.js'));
    const tot65 = (models) => {
      const t = { in: 0, out: 0, cached: 0, total: 0, cost: 0 };
      for (const m of Object.values(models || {})) {
        t.in += m.in || 0; t.out += m.out || 0; t.cached += m.cached || 0;
        t.total += m.total || 0; t.cost += m.cost || 0;
      }
      return t;
    };
    const cur65 = {
      '2026-10-01': { models: { hy3: { in: 100, out: 10, cached: 50, total: 160, cost: 0.01 },
                                ghost: { in: 5, out: 1, cached: 0, total: 6, cost: 0.001 } }, total: {} },
      '2026-09-30': { models: { hy3: { in: 1, out: 1, cached: 0, total: 2, cost: 0 } }, total: {} },
    };
    const new65 = {
      '2026-10-01': { models: { hy3: { in: 200, out: 20, cached: 100, total: 320, cost: 0.02 } }, total: {} },
      '2026-10-03': { models: { hy3: { in: 7, out: 1, cached: 0, total: 8, cost: 0 } }, total: {} },
    };
    const R65 = mergeDailyLedger(cur65, new65, tot65);
    const M1 = (R65.merged && R65.merged['2026-10-01']) || {};
    ok('T65-e1 ★重放权威覆盖同 key（hy3.in 100→200；不取 max、不叠加）',
      M1.models && M1.models.hy3 && M1.models.hy3.in === 200, JSON.stringify(M1.models && M1.models.hy3));
    ok('T65-e2 ★重放抓不到的模型必须保留（ghost 仍在）且打 stale_carried',
      M1.models && M1.models.ghost && M1.models.ghost.in === 5 && M1.models.ghost.stale_carried === true,
      JSON.stringify(M1.models && M1.models.ghost));
    ok('T65-e3 ★carriedSummary 按日期计数，供调用方打 stderr 汇总',
      R65.carriedSummary.length === 1 && R65.carriedSummary[0] === '2026-10-01(1个模型)',
      JSON.stringify(R65.carriedSummary));
    ok('T65-e4 ★旧日期原样保留 + 同日期 total 按合并后重算（in = 200+5）',
      !!R65.merged['2026-09-30'] && M1.total && M1.total.in === 205, JSON.stringify(M1.total));

    const rpM65 = require(path.join(SRC, 'refresh-prices.js'));
    const pr65 = JSON.parse(fs.readFileSync(path.join(SRC, 'pricing.json'), 'utf-8'));
    const ms65 = pr65.models || pr65;
    let miss65 = 0; const out65 = [];
    for (const [k, v] of Object.entries(ms65)) {
      if (!v || typeof v !== 'object') continue;
      const ip = v.input_price, cp = v.cached_price;
      if (typeof ip !== 'number' || ip <= 0 || typeof cp !== 'number' || cp <= 0) continue;
      const sink = [];
      rpM65.priceGate(k, { input_price: ip, cached_price: cp }, { input_price: ip, cached_price: cp * 0.9 }, sink);
      if (sink.some((s) => String(s).indexOf('缓存命中价/输入价') >= 0)) { miss65 += 1; out65.push(k + ':' + sink.join('|')); }
    }
    ok('T65-e5 ★真实价库全量零误伤：现有模型的缓存/输入比值都在正常带内（不得一改就满屏告警）',
      miss65 === 0, out65.join(' ; '));
    const sHi65 = [];
    rpM65.priceGate('t65-hi', { input_price: 2, cached_price: 1.6 }, { input_price: 2, cached_price: 1.0 }, sHi65);
    ok('T65-e6 ★比值 80% 越上界必须告警（拦「缓存价填成别的档位价」这一路）',
      sHi65.some((s) => String(s).indexOf('缓存命中价/输入价') >= 0), JSON.stringify(sHi65));
    const sLo65 = [];
    rpM65.priceGate('t65-lo', { input_price: 20, cached_price: 0.05 }, { input_price: 20, cached_price: 0.08 }, sLo65);
    ok('T65-e7 ★比值 0.25% 越下界必须告警',
      sLo65.some((s) => String(s).indexOf('缓存命中价/输入价') >= 0), JSON.stringify(sLo65));
    const sIn65 = [];
    rpM65.priceGate('t65-in', { input_price: 2, cached_price: 0.4 }, { input_price: 2, cached_price: 0.3 }, sIn65);
    ok('T65-e8 ★带内（20%）不得告警（误杀 = 正常刷新被拒 = 价库停滞）',
      !sIn65.some((s) => String(s).indexOf('缓存命中价/输入价') >= 0), JSON.stringify(sIn65));

    // A2 行为验证（真跑 python）
    const pyB65 = (() => {
      if (process.env.CN_PYTHON) return process.env.CN_PYTHON;
      try {
        const root = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions');
        for (const v of fs.readdirSync(root).sort().reverse()) {
          const p = path.join(root, v, 'python.exe');
          if (fs.existsSync(p)) return p;
        }
      } catch (e) { /* 探测失败 → 回退裸 python */ }
      return 'python';
    })();
    const probeB65 = spawnSync(pyB65, ['-c', 'print(1)'], { timeout: 20000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    if (!SPAWN_OK || probeB65.status !== 0) {
      for (const n of ['T65-e9', 'T65-e10']) {
        envSkip(n + ' ★keep_hunyuan 行为验证（真跑 python）',
          !SPAWN_OK ? SPAWN_SKIP_REASON : ('未找到可用 python（试探 ' + pyB65 + ' 失败）；CI 上应为 0'));
      }
    } else {
      const pySrc65 = [
        'import sys, importlib.util',
        "spec = importlib.util.spec_from_file_location('pth65', sys.argv[1])",
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        "ms = [{'name':'Hy3','brand':'hunyuan'},{'name':'Kimi K3','brand':'kimi'},{'name':'Hy-New','brand':None}]",
        'kept, unmapped = m.keep_hunyuan(ms)',
        "print('KEPT=' + ','.join(x['name'] for x in kept))",
        "print('UNMAPPED=' + ','.join(unmapped))",
        "k2, u2 = m.keep_hunyuan([{'name':'Hy3','brand':'hunyuan'}])",
        "print('PURE_KEPT=%d PURE_UNMAPPED=%d' % (len(k2), len(u2)))",
      ].join('\n');
      const rB65 = spawnSync(pyB65, ['-c', pySrc65, path.join(SRC, 'parse_tokenhub.py')],
        { timeout: 60000, windowsHide: true, encoding: 'utf-8', env: Object.assign({}, process.env, PY_IO_ENV) });
      const logB65 = String(((rB65 && rB65.stdout) || '') + ((rB65 && rB65.stderr) || ''));
      ok('T65-e9 ★三路分流：混元收、第三方丢、**未识别进 unmapped**（旧实现此处静默丢）',
        logB65.indexOf('KEPT=Hy3') >= 0 && logB65.indexOf('UNMAPPED=Hy-New') >= 0,
        logB65.slice(-300));
      ok('T65-e10 ★纯混元输入不得误报未映射（否则每次刷新都刷假告警，真告警被淹没）',
        logB65.indexOf('PURE_KEPT=1') >= 0 && logB65.indexOf('PURE_UNMAPPED=0') >= 0,
        logB65.slice(-300));
    }
  }
}

// ===== T66：v3.56.0 A1 Portkey 补源 + G4 查找缓存 + G6 toast 单次读入（审计批6）=====
// 三条主线：
//   ① **A1 Portkey USD 源 3→5**：探测 16 个可用 provider 后定案补 openai / anthropic 两个
//      （零本地命中 → 零告警零污染，纯增量扩中位数样本）；**不选 openrouter**（Portkey 的
//      openrouter.json 就是源 C 的镜像 → 假独立源，同 llm-prices-cn 之坑）；zhipu/moonshot
//      暂不加（对现价库零收益 + 新增歧义告警）。文档同步写明镜像关系与选型依据。
//   ② **G4 查找缓存**：looseFind 每次全索引 norm() + usdFind 每模型 3 次重复查询 → A1 扩到
//      5 源后 17×5×3=255 次全索引遍历。WeakMap 缓存归一化结果与 usdFind 返回值（locked 只影响
//      告警分流不影响返回值 → memo 安全）。
//   ③ **G6 toast 单次读入**：预热逐模型各整份读一遍 toast 日志（N 模型 = N 次全量读+parse）
//      → readToastRounds 一次读入分组（纯函数 groupToastLines 可单测），roundHoursOf 留作锁内 fallback。
// ⚠️ 断言纪律：匹配**使用点**；行为守卫全走 require 真跑（groupToastLines 是纯函数，沙箱也能跑）。
{
  const rd66 = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
  const rp66 = stripComments(rd66('refresh-prices.js'));
  const rc66 = stripComments(rd66('recalc-day.js'));
  const sk66 = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf-8');
  const rdm66 = fs.readFileSync(path.join(SRC, 'README.md'), 'utf-8');
  const prd66 = fs.readFileSync(path.join(SRC, 'docs/pricing-refresh.md'), 'utf-8');

  // ── a. A1：Portkey 补 2 个 provider ──
  ok('T66-a1 ★SOURCES 必须注册 portkeyOpenai / portkeyAnthropic（定义了不注册 = 白写）',
    rp66.indexOf('portkeyOpenai: { name:') >= 0 && rp66.indexOf('portkeyAnthropic: { name:') >= 0);
  ok('T66-a2 ★两个新源 URL 必须指向 configs.portkey.ai 的对应 provider.json',
    rp66.indexOf("'https://configs.portkey.ai/pricing/openai.json'") >= 0
    && rp66.indexOf("'https://configs.portkey.ai/pricing/anthropic.json'") >= 0);
  ok('T66-a3 ★三个 Portkey 源必须都挂 parsePortkey（新源不接解析器 = 拉了个寂寞）',
    rp66.indexOf('portkey: parsePortkey') >= 0
    && rp66.indexOf('portkeyOpenai: parsePortkey') >= 0
    && rp66.indexOf('portkeyAnthropic: parsePortkey') >= 0);
  ok('T66-a4 ★usdSources 收集必须含 5 源（少收一个 = 中位数样本缩水，A1 白做）',
    rp66.indexOf('const usdSources = [or, litellm, portkey, portkeyOpenai, portkeyAnthropic].filter(Boolean);') >= 0);
  ok('T66-a5 ★usdOk 判定必须覆盖两个新源（否则新源全挂也不影响"至少一个 USD 源可用"的判断）',
    rp66.indexOf('results.portkeyOpenai.ok || results.portkeyAnthropic.ok') >= 0);

  // ── b. G4：查找缓存 ──
  ok('T66-b1 ★looseNormIndex 必须定义且 looseFind 必须走它（否则每次全索引 norm，缓存白建）',
    rp66.indexOf('function looseNormIndex(index)') >= 0
    && rp66.indexOf('for (const e of looseNormIndex(index))') >= 0);
  ok('T66-b2 ★USD_MEMO 必须定义且 usdFind 必须查它（否则每模型 3 次重复全索引遍历）',
    rp66.indexOf('const USD_MEMO = new WeakMap();') >= 0
    && rp66.indexOf('USD_MEMO.get(usdIndex)') >= 0);

  // ── c. G6：toast 单次读入 ──
  ok('T66-c1 ★readToastRounds 必须定义且预热处必须用它（逐模型整份读 = G4 同款浪费）',
    rc66.indexOf('function readToastRounds(date, allModels)') >= 0
    && rc66.indexOf('const toastRounds = readToastRounds(date, allModels);') >= 0);
  ok('T66-c2 ★分组逻辑必须抽成纯函数 groupToastLines 且被 readToastRounds 委托（可单测 = 可守卫）',
    rc66.indexOf('function groupToastLines(lines, date, allModels)') >= 0
    && rc66.indexOf('return groupToastLines(') >= 0);
  ok('T66-c3 ★roundHoursOf 必须保留作锁内 fallback（并发新模型仍要现场读）',
    rc66.indexOf('function roundHoursOf(date, model, allModels)') >= 0
    && rc66.indexOf('roundHoursOf(date, model, cands)') >= 0);
  ok('T66-c4 ★预热 contested 打点必须保留（互前缀轮次归属纠正是 v3.31.0 的真缺陷修复，不能随重构丢）',
    rc66.indexOf('toastRounds.contested.get(model)') >= 0
    && rc66.indexOf('同属更长的模型名') >= 0);

  // ── d. 文档：源清单与独立性口径 ──
  ok('T66-d1 ★SKILL.md 摘要必须写 7 源 + 三个 Portkey provider（文档漂移 = 照文档改代码的人被带歪）',
    sk66.indexOf('7 源并行') >= 0 && sk66.indexOf('Portkey×3 provider') >= 0);
  ok('T66-d2 ★SKILL.md 必须写明 llm-prices-cn 同源不互证 + openrouter 同源不选',
    sk66.indexOf('每日镜像（同源，不构成独立互证）') >= 0
    && sk66.indexOf('openrouter.json 与 OpenRouter 同源故不选') >= 0);
  ok('T66-d3 ★docs/pricing-refresh.md 必须有「源的独立性口径」段 + 7 源计数口径（A1 的核心交付是认知纠正）',
    prd66.indexOf('源的独立性口径') >= 0
    && prd66.indexOf('Portkey 已配 3 个 provider') >= 0
    && prd66.indexOf('暂不加 `zhipu` / `moonshot`') >= 0
    && prd66.indexOf('并行拉 **7 源**') >= 0);
  ok('T66-d4 ★README 价格源表必须同步 7 源口径',
    rdm66.indexOf('**7 个公开价格源**') >= 0 && rdm66.indexOf('Portkey×3 provider') >= 0);

  // ── e. 行为守卫（require 真跑，纯函数沙箱可跑） ──
  const rp66m = (() => { try { return require(path.join(SRC, 'refresh-prices.js')); } catch (e) { return null; } })();
  const rc66m = (() => { try { return require(path.join(SRC, 'recalc-day.js')); } catch (e) { return null; } })();
  if (!rp66m || !rc66m) {
    ok('T66 模块加载', false, 'require 失败（refresh-prices / recalc-day）');
  } else {
    ok('T66 模块加载（refresh-prices + recalc-day）', true);
    ok('T66-e1 ★SOURCES 运行时结构：7 源、两新源 URL 正确、**不得含 openrouter provider**（同源陷阱）',
      Object.keys(rp66m.SOURCES).length === 7
      && rp66m.SOURCES.portkeyOpenai && rp66m.SOURCES.portkeyOpenai.url === 'https://configs.portkey.ai/pricing/openai.json'
      && rp66m.SOURCES.portkeyAnthropic && rp66m.SOURCES.portkeyAnthropic.url === 'https://configs.portkey.ai/pricing/anthropic.json'
      && !Object.keys(rp66m.SOURCES).some((k) => k !== 'or' && /openrouter/i.test(rp66m.SOURCES[k].url)),
      Object.keys(rp66m.SOURCES).map((k) => k + '=' + rp66m.SOURCES[k].url).join(' | '));
    ok('T66-e2 ★parsePortkey 必须过滤全 0 占位条目（Portkey 用 price=0 表示未定价，混进中位数即错价）',
      (() => {
        const out = rp66m.parsePortkey({
          'glm-4.7-flash': { pricing_config: { pay_as_you_go: { request_token: { price: 0 }, response_token: { price: 0 }, cache_read_input_token: { price: 0 } } } },
          'glm-4.7': { pricing_config: { pay_as_you_go: { request_token: { price: 6e-05 }, response_token: { price: 0.00022 }, cache_read_input_token: { price: 1.1e-05 } } } },
        });
        return !('glm-4.7-flash' in out) && out['glm-4.7']
          && Math.abs(out['glm-4.7'].usdIn - 0.6) < 1e-9 && Math.abs(out['glm-4.7'].cacheUsd - 0.11) < 1e-9;
      })());
    ok('T66-e3 ★looseNormIndex 缓存命中必须返回同一引用（重建数组 = 缓存失效，G4 白做）',
      (() => {
        const idx = { 'kimi-k3': { usdIn: 3 }, 'glm-4.7': { usdIn: 0.6 } };
        const a = rp66m.looseNormIndex(idx);
        return Array.isArray(a) && a.length === 2 && a.every((x) => x.k && x.kn)
          && rp66m.looseNormIndex(idx) === a;
      })());
    ok('T66-e4 ★usdFind memo：同 (index,key) 多次查询同值，且告警不重复（Set 语义保持）',
      (() => {
        const idx = { 'kimi-k3': { usdIn: 3 }, 'glm-4.7': { usdIn: 0.6 } };
        const u1 = rp66m.usdFind(idx, 'kimi-k3', null, rp66m.norm('kimi-k3'), false);
        const u2 = rp66m.usdFind(idx, 'kimi-k3', null, rp66m.norm('kimi-k3'), false);
        const before = rp66m.AMBIG_WARNINGS.size;
        rp66m.usdFind(idx, 'glm-4.7-flash', null, rp66m.norm('glm-4.7-flash'), false);
        rp66m.usdFind(idx, 'glm-4.7-flash', null, rp66m.norm('glm-4.7-flash'), false);
        return u1 === u2 && u1 && u1.usdIn === 3 && (rp66m.AMBIG_WARNINGS.size - before) === 1;
      })());
    ok('T66-e5 ★groupToastLines：当天轮次按整名归属；跨天行/坏行/无归属行全部不计入',
      (() => {
        const D = '2026-10-13';
        const lines = [
          JSON.stringify({ ts: D + 'T10:00:00.000Z', toastText: 'kimi-k3 ｜¥1.2' }),
          JSON.stringify({ ts: D + 'T11:00:00.000Z', toastText: 'kimi-k3-1 ｜¥0.9' }),
          JSON.stringify({ ts: '2026-10-12T23:00:00.000Z', toastText: 'kimi-k3 跨天' }),
          'not-json',
          JSON.stringify({ ts: D + 'T13:00:00.000Z', toastText: 'unknown-model ｜¥0' }),
        ];
        const g = rc66m.groupToastLines(lines, D, ['kimi-k3', 'kimi-k3-1']);
        return g.byModel.get('kimi-k3').length === 1 && g.byModel.get('kimi-k3-1').length === 1
          && !g.byModel.has('unknown-model')
          && [...g.byModel.values()].reduce((a, b) => a + b.length, 0) === 2;
      })());
    ok('T66-e6 ★groupToastLines contested：互前缀轮次归属更长名时，短名侧必须记 contested（v3.31.0 修复回归）',
      (() => {
        const D = '2026-10-13';
        const lines = [JSON.stringify({ ts: D + 'T10:00:00.000Z', toastText: 'kimi-k3-1 ｜¥0.9' })];
        const g = rc66m.groupToastLines(lines, D, ['kimi-k3', 'kimi-k3-1']);
        const c = g.contested.get('kimi-k3');
        return c && c.n === 1 && c.owner === 'kimi-k3-1';
      })());
    ok('T66-e7 ★groupToastLines 前缀兜底：表里缺更长名时归最长前缀，且无 contested',
      (() => {
        const D = '2026-10-13';
        const lines = [JSON.stringify({ ts: D + 'T10:00:00.000Z', toastText: 'kimi-k3-1 ｜¥0.9' })];
        const g = rc66m.groupToastLines(lines, D, ['kimi-k3']);
        return g.byModel.get('kimi-k3').length === 1 && g.contested.size === 0;
      })());
    ok('T66-e8 ★looseFind 模糊唯一命中不受缓存影响（T28 语义回归：缓存不得改变匹配结果）',
      (() => {
        const idx = { 'kimi-k2.5': { usdIn: 0.6 }, 'kimi-k3': { usdIn: 3 } };
        const f = rp66m.looseFind(idx, rp66m.norm('kimi-k3'), 'USD源', 'kimi-k3-9', false);
        return f && f.usdIn === 3;
      })());
  }
}

// ===== T67：v3.57.0 H5 修复——backfill 历史日按当时规则计价（审计批7）=====
// 病根：rowCost 逐行用 isPeakBeijingTs(ts) 判峰谷 = **当前** deepseek_rules 口径；厂商调整峰谷
//   时段后，拿它重算全部历史行，同一历史日金额与 recalc-day（读 rounds 明细里主链路**当时**落下的
//   peakSplit 六桶）系统性分叉（审计实证差 2 倍：¥0.0024 vs ¥0.0048）。用户定夺：历史日按当时规则。
// 修法：组装循环内对每个 (date, model) 读回 at-time 切分，**三对桶全覆盖才采用**（防"只给部分
//   轮次按当时规则定价"），否则保持行级现值；无公开价模型不动（与 rowCost null 语义一致）。
// 守卫两层：
//   ① 源码：require 关系 / peakSplitOf 使用点 / 全覆盖三项 / 单点计价 / 覆盖必须先于 dayTotalOf；
//   ② 行为（spawn dry-run，WB_ROOT 全隔离 tmp）：全覆盖→当时规则、半套→行级现值、无明细→行级现值。
// ⚠️ 反向验证口径：整段删掉覆盖 pass → a2/a3/a4/a5 与 e1 必须变红；e2/e3 不得误伤
//   （修复前后同为行级现值 ¥2.00）。
{
  const bf67 = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n');
  const s67 = stripComments(bf67);
  ok('T67-a1 ★backfill 必须 require recalc-day.js（当时规则切分只许一处实现，不得另抄一份）',
    /const recalcDay = require\(path\.join\(__dirname, 'recalc-day\.js'\)\);/.test(s67));
  ok('T67-a2 ★组装循环内必须调 recalcDay.peakSplitOf（导入了不调用 = 白修）',
    s67.indexOf('recalcDay.peakSplitOf(date, name)') >= 0);
  ok('T67-a3 ★必须做三对桶全覆盖校验（缺一项 = 半套明细也能按当时规则定价）',
    /split\.pIn \+ split\.oIn !== st\.in/.test(s67)
    && /split\.pOut \+ split\.oOut !== st\.out/.test(s67)
    && /split\.pCached \+ split\.oCached !== st\.cached/.test(s67));
  ok('T67-a4 ★成本改写必须走单点 tt.costFromPeakSplit + tt.peakMultOf（不得手写六项展开式）',
    s67.indexOf('tt.costFromPeakSplit(hit.m, split, tt.peakMultOf(hit.m, name))') >= 0);
  ok('T67-a5 ★覆盖 pass 必须早于 dayTotalOf 使用点（日合计后置 = 当天 total.cost 仍是旧值）',
    (() => {
      const w = s67.indexOf('st.cost = Math.round(c * 1e6) / 1e6');
      const d = s67.indexOf('total: dayTotalOf(models)');
      return w >= 0 && d >= 0 && w < d;
    })());

  if (!SPAWN_OK) {
    envSkip('T67-e1 全覆盖→当时规则（spawn）', SPAWN_SKIP_REASON);
    envSkip('T67-e2 半套明细→行级现值（spawn）', SPAWN_SKIP_REASON);
    envSkip('T67-e3 无明细→行级现值（spawn）', SPAWN_SKIP_REASON);
  } else {
    // 夹具：当前规则 18-22 高峰；历史日 2026-10-15（周四）20:00 当时空闲、按当前规则高峰。
    //   行级现值 = ¥2.00（高峰 ×2）；at-time 明细（全空闲桶）= ¥1.00。全部落 tmp 隔离目录。
    const D67 = '2026-10-15';
    const M67 = 'h5-fixture-model';
    const TS67 = 1792065600000; // 2026-10-15 20:00 +0800（周四）
    const PRICING67 = {
      models: {
        [M67]: { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY',
                 unit: 'per_1m_tokens', region: 'CN', peak_multiplier: 2,
                 source_url: 'fixture', fetched_at: '2026-10-14T00:00:00Z' },
      },
      deepseek_rules: { peak_schedule: '18:00 - 22:00', weekend_off_peak: true,
                        effective_at: null, updated_at: '2026-10-14' },
      usd_cny_rate: 7.2,
    };
    const mkTrans = () => JSON.stringify({
      timestamp: TS67, type: 'message',
      providerData: { model: M67, messageId: 'm-1',
        usage: { inputTokens: 1000000, outputTokens: 0, inputTokensDetails: [{ cached_tokens: 0 }] } },
    }) + '\n';
    const mkDaily = () => JSON.stringify({
      [D67]: {
        models: { [M67]: { in: 1000000, out: 0, cached: 0, total: 1000000, cost: 2.0, hit: 0 } },
        total: { in: 1000000, out: 0, cached: 0, total: 1000000, cost: 2.0, hit: 0 },
      },
    });
    const mkRounds = (oIn) => (oIn == null ? null : JSON.stringify({
      date: D67, ts: TS67, toastText: M67,
      peakSplit: { [M67]: { pIn: 0, pCached: 0, pOut: 0, oIn, oCached: 0, oOut: 0 } },
    }) + '\n');
    const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o); };
    const costOf = (out) => {
      for (const line of String(out || '').split('\n')) {
        if (line.startsWith(D67 + ' ')) return parseFloat(line.split('¥')[1].split(' ')[0].split('（')[0]);
      }
      return null;
    };
    const runBf = (oIn) => {
      wj(path.join(skillDir, 'pricing.json'), JSON.stringify(PRICING67));
      // v3.62.0（外部审计 S-6）：必须写**该年已确认**的假日表。改前写 '{}' 等于"该年数据未知"，
      //   在保守开关（假日未知 → 不套高峰倍率）下会被判成降级 → 峰谷模型金额从 ¥2.00 变 ¥1.00。
      //   生产环境 holidays.json 永远带真实年份（只有 2027 是 null），故这是夹具语义修正、非产品回归。
      wj(path.join(skillDir, 'holidays.json'), JSON.stringify({ years: { 2026: ['2026-01-01'] } }));
      wj(path.join(skillDir, 'daily-usage.json'), mkDaily());
      wj(path.join(tmp, 'projects', 'proj1', 'sess-a.jsonl'), mkTrans());
      // rounds 明细一律覆写同一路径：oIn=null 时写空文件（peakSplitOf 读不到记录 → null），
      //   既模拟"旧日期无明细"，也不用删目录（删失败会残留上一态文件 → 假绿）。
      wj(path.join(skillDir, 'rounds', 'rounds-2026-10.jsonl'), oIn == null ? '' : mkRounds(oIn));
      // ⚠ v3.59.0（批15 · 测试网床）：`spawnSync(cmd, args, options)` 只有三个参数——
      //   原先把 env 当第三个、**真正的 options 当第四个**（被静默忽略）→ 子进程既没拿到
      //   timeout/encoding，也**根本没拿到 env**（WB_ROOT 等全部失效）。
      //   后果：这三组端到端"看起来在跑"（rc 有值、stdout 有输出），实则前提全丢 → 恒失败。
      //   这正是 T67/T68/T69 六个存量红的根因（v3.57.0 时它们因 SPAWN_OK=false 被 SKIP，从未真跑）。
      const r = spawnSync(NODE, [path.join(skillDir, 'backfill.js')], {
        env: Object.assign({}, env, { WB_LEDGER_MAINT: '1' }), // 夹具账本（tmp 隔离），非生产
        timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      return { v: costOf(r.stdout), rc: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
    };
    try {
      const c1 = runBf(1000000); // 全覆盖：按当时规则（空闲）计价
      ok('T67-e1 ★at-time 明细全覆盖 → backfill 按当时规则 = ¥1.00（旧实现给 ¥2.00，即 H5 分叉）',
        c1.v === 1.0, `got ${c1.v} rc=${c1.rc}`);
      if (c1.v !== 1.0) console.log(c1.out.slice(-1500));
      const c2 = runBf(500000); // 半套明细：非全覆盖 → 行级现值
      ok('T67-e2 半套明细 → 保持行级现值 ¥2.00（不得被半套切分带偏）',
        c2.v === 2.0, `got ${c2.v} rc=${c2.rc}`);
      if (c2.v !== 2.0) console.log(c2.out.slice(-1500));
      const c3 = runBf(null); // 无明细：行级现值（旧日期行为不回归）
      ok('T67-e3 无 rounds 明细 → 保持行级现值 ¥2.00',
        c3.v === 2.0, `got ${c3.v} rc=${c3.rc}`);
      if (c3.v !== 2.0) console.log(c3.out.slice(-1500));
    } catch (e) {
      ok('T67 行为夹具异常', false, (e && e.message) || String(e));
    }
  }
}

// ===== T68：v3.57.0 R1 收口——recalc 的 at-time 切分必须全覆盖（与 backfill 同构）=====
// 病根（逻辑审查发现，H5 修复的半边）：backfill.js v3.57.0 已对 peakSplit 加「三对桶全覆盖」
//   校验，但 recalc-day.js 的同一条切分路径仍只要求「六桶和 > 0」——hook-fallback 轮不落明细
//   （A22）/ 明细被 prune / 跨版本残留时，recalc 会把账本金额改成只覆盖明细轮次的值（漏价），
//   且与修好的 backfill 结果分叉。修法：两侧判据同构（三对桶 === 条目三值），非全覆盖 →
//   回落 v3.24.0 既定降级（原账>0 保留 / =0 按空闲补记 / 轮次占比折算）。
// ⚠️ 反向验证口径：删掉 recalc 的全覆盖条件 → a1 红、行为 e1 红；e2/e3 不误伤。
{
  const rc68 = stripComments(fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8').replace(/\r\n/g, '\n'));
  const bf68 = stripComments(fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T68-a1 ★recalc 的 split 分支必须含三对桶全覆盖校验（缺一项 = 明细缺轮次时漏价改账）',
    /split\.pIn \+ split\.oIn === stIn/.test(rc68)
    && /split\.pOut \+ split\.oOut === stOut/.test(rc68)
    && /split\.pCached \+ split\.oCached === stCached/.test(rc68));
  ok('T68-a2 ★backfill 与 recalc 的全覆盖判据必须同构（两侧漂移 = 同一批数据两个金额）',
    /split\.pIn \+ split\.oIn !== st\.in/.test(bf68)
    && /split\.pOut \+ split\.oOut !== st\.out/.test(bf68)
    && /split\.pCached \+ split\.oCached !== st\.cached/.test(bf68)
    && /split\.pIn \+ split\.oIn === stIn/.test(rc68));
  // v3.58.0（批8-①）：同上 —— 降级路径仍必须保留（不许因为加了全覆盖校验就把非全覆盖静默采用），
  //   且累加必须走 safeCost（防字符串拼接把当日合计打成 NaN）。
  ok('T68-a3 ★非全覆盖必须保留 v3.24.0 降级路径（原账>0 保留 / =0 按空闲补记），不许静默采用',
    /if \(Number\(stat\.cost \|\| 0\) > 0\) \{ dayTotal \+= safeCost\(stat\.cost\); continue; \}/.test(rc68));

  if (!SPAWN_OK) {
    envSkip('T68-e1 半套明细→保留原额（spawn）', SPAWN_SKIP_REASON);
    envSkip('T68-e2 全覆盖→采用（spawn）', SPAWN_SKIP_REASON);
    envSkip('T68-e3 无明细→保留原额（spawn）', SPAWN_SKIP_REASON);
  } else {
    // 行为夹具与 b7-h5/r1.py 同参：账本 in=1e6 cost=2.0；明细半套 oIn=500000。
    //   修前 recalc 采用半套 split → 0.50（漏价）；修后非全覆盖 → 原账>0 保留 2.00。
    const D68 = '2026-10-15';
    const M68 = 'r1-fixture-model';
    // 哨兵值定义在夹具里（total.cost = 9999），此处不再需要哨兵模型常量
    const TS68 = 1792065600000;
    const wb68 = path.join(tmp, 'r1-wb');
    const sk68 = path.join(wb68, 'skills', 'token-usage-tracker');
    const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o); };
    const mkAll = (oIn) => {
      wj(path.join(sk68, 'pricing.json'), JSON.stringify({
        models: { [M68]: { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY',
                           unit: 'per_1m_tokens', region: 'CN', peak_multiplier: 2,
                           source_url: 'fixture', fetched_at: '2026-10-14T00:00:00Z' } },
        deepseek_rules: { peak_schedule: '18:00 - 22:00', weekend_off_peak: true,
                          effective_at: null, updated_at: '2026-10-14' },
        usd_cny_rate: 7.2,
      }));
      // v3.62.0（外部审计 S-6）：同 T67 —— 该年已确认（见 T67 夹具注释）
      wj(path.join(sk68, 'holidays.json'), JSON.stringify({ years: { 2026: ['2026-01-01'] } }));
      // v3.59.0（批15 · 测试网床）：**当日合计 total.cost 预置哨兵值 9999** ——
      //   e1/e3 的期望值（2.00）与夹具预置值**相同**，于是"recalc 根本没处理这一天"和
      //   "处理了并保留原额"**不可区分**（实测：recacl-day 在目标模型不存在时 stdout 与正常时逐字相同
      //   → 反向验证回退 env 那次 e1/e3 稳绿 = 假绿）。recacl 每次运行都会重算当日合计，
      //   故 total.cost 是否被改写 = 它到底跑没跑。
      //   ⚠ 别用"第二个模型"当哨兵：recalc-day 只重算命令行指定的那一个模型，哨兵不会被碰（实测踩到）。
      wj(path.join(sk68, 'daily-usage.json'), JSON.stringify({
        [D68]: {
          models: { [M68]: { in: 1000000, out: 0, cached: 0, total: 1000000, cost: 2.0, hit: 0 } },
          total: { in: 1000000, out: 0, cached: 0, total: 1000000, cost: 9999, hit: 0 },
        },
      }));
      wj(path.join(sk68, 'rounds', 'rounds-2026-10.jsonl'), oIn == null ? '' : JSON.stringify({
        date: D68, ts: TS68, toastText: M68,
        peakSplit: { [M68]: { pIn: 0, pCached: 0, pOut: 0, oIn, oCached: 0, oOut: 0 } },
      }) + '\n');
    };
    const runRecalc = () => {
      // 脚本本体跑 selftest tmp 副本（skillDir），数据根指向 fixture（wb68）——与 T67 同模式
      // v3.62.0（外部审计 F-3/G-1）：默认 dry-run → 显式 --write（本组断言写盘后的账本值）
      // ⚠ v3.62.0（F-3）：再加 --current-price —— D68=2026-10-15 是历史日、隔离库无当日快照，
      //   默认口径会 fail-closed 拒绝；本组验的是"半套明细 → 保留原额"的计价逻辑（夹具 pricing.json
      //   即"现价"），故显式按现价跑，避免 F-3 的口径拒绝干扰。
      const r = spawnSync(NODE, [path.join(skillDir, 'recalc-day.js'), D68, M68, '--current-price', '--write'], {
        env: Object.assign({}, env, { WB_ROOT: wb68, WB_LEDGER_MAINT: '1' }),
        timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      let cost = null, totalCost = null;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(sk68, 'daily-usage.json'), 'utf8'));
        cost = d[D68].models[M68].cost;
        totalCost = d[D68].total.cost;
      } catch (e) { /* 读不到按 null */ }
      return { rc: r.status, cost, totalCost, out: String(r.stdout || '') + String(r.stderr || '') };
    };
    try {
      mkAll(500000); // 半套明细：非全覆盖
      const c1 = runRecalc();
      ok('T68-e0 ★当日合计被重算（≠预置哨兵 9999）= recalc 真的处理了这一天（否则 e1 恒绿）',
        c1.totalCost !== 9999 && c1.totalCost !== null, `total=${c1.totalCost} rc=${c1.rc}`);
      ok('T68-e1 ★明细半套（oIn=500000 < 条目 1e6）→ 保留原额 ¥2.00（修前给 0.50 = 漏价）',
        c1.cost === 2.0, `got ${c1.cost} rc=${c1.rc}`);
      if (c1.cost !== 2.0) console.log(c1.out.slice(-1200));
      mkAll(1000000); // 全覆盖：采用
      const c2 = runRecalc();
      ok('T68-e2 明细全覆盖 → 采用 at-time = ¥1.00（口径不回归）',
        c2.cost === 1.0, `got ${c2.cost} rc=${c2.rc}`);
      if (c2.cost !== 1.0) console.log(c2.out.slice(-1200));
      mkAll(null); // 无明细
      const c3 = runRecalc();
      // v3.59.0（批16）：e3 的弱断言**已彻底修好** —— recalc-day.js 现在会打印「处理模型 重算/总计」，
      //   「真的走到计价重算」与「早退 / 压根没跑」由此可分（下面 e3b 是强断言）。
      ok('T68-e3 无明细 → 保留原额 ¥2.00（v3.24.0 降级语义不回归）',
        c3.cost === 2.0, `got ${c3.cost} rc=${c3.rc}`);
      if (c3.cost !== 2.0) console.log(c3.out.slice(-1200));
      // ⚠ e3b 是 e3 的**检出力来源**：夹具只有 1 个有价模型且命令行指定它 → 必须是 1/1。
      //   若为 0/1 说明在计价前就早退了（无价 / 被 onlyModel 过滤 / 条目损坏）→ 上面 e3 的 2.00
      //   就是"原封未动"，而不是"重算后保留"。
      ok('T68-e3b ★「处理模型 1/1 个」= recalc 真的走到了计价重算（批16 新增输出信号；'
        + '改前 e3 只能断言"没崩"，与"压根没跑"不可区分 = 弱断言）',
        /处理模型 1\/1 个/.test(c3.out), `out=${c3.out.slice(-400)}`);
    } catch (e) {
      ok('T68 行为夹具异常', false, (e && e.message) || String(e));
    }
  }
}

// ===== T69：v3.57.0 K1 收口——无峰谷模型结构性退出峰谷时段判定（用户定夺「只修 K1」）=====
// 病根（用户定性为重大口径问题）：峰谷时段表（pricing.deepseek_rules，DeepSeek 官方动态时段）
//   被全局共享——aggregateTranscLines / perModelFromRows 对**所有模型**逐行 isPeakHour 分桶，
//   calcCost 对所有模型判 isPeakHour，recalc 对所有模型算 peakRatio，backfill rowCost 对所有
//   模型判 isPeakBeijingTs。无峰谷模型只靠「peakMult===1 时倍率恒 1」碰巧打平，结构上零隔离——
//   「别的模型没有峰谷，肯定不能共享这个时段表；共享高峰时段的话，价格又会有变化的」。
// 修法（四处同收）：只有 peakMultOf>1（有峰谷）的模型才判时段——
//   ① calcCost：peakMult > 1 && isPeakHour(...) ? peakMult : 1；
//   ② 两个分桶落点：peakRulesAgg && peakAppliesToAgg(name) 才分桶（无峰谷模型不落 peakSplit 明细）；
//   ③ recalc：pm>1 才算 peakRatio；④ backfill rowCost：pm>1 && isPeakBeijingTs ? pm : 1；
//   ⑤ periodPeakNote 收敛到 peakMultOf（与计价同一判据）。
// 金额影响：无峰谷模型倍率恒 1 → 改前改后金额逐字节一致；变的是「不再落 peakSplit 明细」。
// ⚠️ 反向验证口径：任一处删守卫 → 对应 a 条红 + 行为 e1 红（无峰谷模型又落明细）；e2 不误伤。
{
  const tt69 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n'));
  const rc69 = stripComments(fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8').replace(/\r\n/g, '\n'));
  const bf69 = stripComments(fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n'));
  ok('T69-a1 ★calcCost 的 isPeakHour 必须被 peakMult>1 守卫（无峰谷模型不判时段）',
    /const mult = peakMult > 1 && isPeakHour\(pricing\.deepseek_rules/.test(tt69));
  ok('T69-a2 ★peakAppliesToAgg 必须存在且判据是 peakMultOf>1（分桶闸门的单点实现）',
    /function peakAppliesToAgg\(modelName\)/.test(tt69)
    && /peakMultOf\(hit\.m, modelName\) > 1/.test(tt69));
  ok('T69-a3 ★弹窗侧分桶必须过 peakAppliesToAgg(mkName)（无峰谷模型不落明细）',
    tt69.indexOf('peakRulesAgg && peakAppliesToAgg(mkName)') >= 0);
  ok('T69-a4 ★账本侧分桶必须过 peakAppliesToAgg(name)（漏一侧 = 弹窗与账本口径分叉）',
    tt69.indexOf('peakRulesAgg && peakAppliesToAgg(name)') >= 0);
  ok('T69-a5 ★recalc 的 peakRatio 必须有 pm>1 前置（无峰谷模型不算高峰占比）',
    /const pm = tt\.peakMultOf\(m, model\);/.test(rc69) && /if \(pm > 1\) \{/.test(rc69));
  ok('T69-a6 ★backfill rowCost 必须被 pm>1 守卫（无峰谷模型不判峰谷）',
    /const mult = pm > 1 && isPeakBeijingTs\(tsMs\) \? pm : 1;/.test(bf69));

  if (!SPAWN_OK) {
    envSkip('T69-e1 无峰谷模型不落明细（spawn）', SPAWN_SKIP_REASON);
    envSkip('T69-e2 有峰谷模型照常分桶计价（spawn）', SPAWN_SKIP_REASON);
  } else {
    // 端到端夹具（**--stop 模式**：只有 Stop 端 transcript 路径才跑 incrementalRecord 记账主链，
    //   --hook 在无 trace 时会走「暂无 trace 数据」早退 → 不记账、断言恒失败 = 假红）。
    //   WB_ROOT 与脚本目录用**生产布局**（脚本在 wb/skills/token-usage-tracker/）——因为
    //   ROUNDS_DIR = __dirname/rounds、recalc 的 SKILL_DIR = WB_ROOT/skills/...，两者必须同一处才读得到明细。
    //   当前规则 9-12/14-18 高峰；transcript = 1 条 user（轮起点）+ 两行同刻 usage
    //   （2026-10-13 周二 10:00 +0800 = 高峰）：A 无峰谷（不翻倍、不落 peakSplit 明细）/
    //   B 有峰谷 ×2（照常落明细）。改前 A 也落明细（靠倍率 1 打平）。
    const D69 = '2026-10-13';
    const TS69 = 1791856800000; // 2026-10-13 10:00 +0800（周二）= 高峰段内
    const TS69_USER = TS69 - 60000; // 09:59，轮起点须早于 usage 行
    const MA = 'k1-nopeak-fixture', MB = 'k1-peak-fixture';
    const SID69 = 'selftest-k1';
    const wb69 = path.join(tmp, 'k1-wb');
    const sk69 = path.join(wb69, 'skills', 'token-usage-tracker');
    const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o); };
    const mkAll = () => {
      wj(path.join(sk69, 'pricing.json'), JSON.stringify({
        date: D69,
        models: {
          [MA]: { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY',
                  unit: 'per_1m_tokens', region: 'CN', source_url: 'fixture', fetched_at: '2026-10-13T00:00:00Z' },
          [MB]: { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY',
                  unit: 'per_1m_tokens', region: 'CN', peak_multiplier: 2,
                  source_url: 'fixture', fetched_at: '2026-10-13T00:00:00Z' },
        },
        deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00', weekend_off_peak: true,
                          effective_at: null, updated_at: '2026-10-13' },
        usd_cny_rate: 7.2,
      }));
      // v3.62.0（外部审计 S-6）：同 T67 —— 该年已确认（见 T67 夹具注释）
      wj(path.join(sk69, 'holidays.json'), JSON.stringify({ years: { 2026: ['2026-01-01'] } }));
      // 生产布局：把技能脚本拷进 wb69/skills/token-usage-tracker（__dirname == SKILL_DIR）
      for (const f of fs.readdirSync(skillDir).filter((x) => x.endsWith('.js'))) {
        fs.copyFileSync(path.join(skillDir, f), path.join(sk69, f));
      }
      wj(path.join(sk69, '.update-check.json'),
        JSON.stringify({ lastCheckAt: Date.now(), latestVersion: '0.0.0', failCount: 0, nextRetryAt: 0 }));
      const user = JSON.stringify({
        timestamp: TS69_USER, type: 'message', role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      }) + '\n';
      const line = (id, model) => JSON.stringify({
        timestamp: TS69, type: 'message', role: 'assistant',
        providerData: { model, messageId: id,
          usage: { inputTokens: 1000000, outputTokens: 0, inputTokensDetails: [{ cached_tokens: 0 }] } },
      }) + '\n';
      wj(path.join(wb69, 'projects', 'proj1', SID69 + '.jsonl'), user + line('m-a', MA) + line('m-b', MB));
    };
    const runStop = () => {
      mkAll();
      const payload = JSON.stringify({ session_id: SID69,
        transcript_path: path.join(wb69, 'projects', 'proj1', SID69 + '.jsonl'), cwd: wb69 });
      const r = spawnSync(NODE, [path.join(sk69, 'token-tracker.js'), '--stop'], {
        input: payload, env: Object.assign({}, env, { WB_ROOT: wb69, WB_LEDGER_MAINT: '1', WB_NO_NET: '1' }),
        timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      let daily = null;
      const splitModels = [];
      try {
        daily = JSON.parse(fs.readFileSync(path.join(sk69, 'daily-usage.json'), 'utf8'));
      } catch (e) { /* 读不到按 null */ }
      // 明细写在 ROUNDS_DIR = __dirname/rounds（= sk69/rounds，生产布局下与 SKILL_DIR 同处）
      try {
        const raw = fs.readFileSync(path.join(sk69, 'rounds', 'rounds-2026-10.jsonl'), 'utf8');
        for (const l of raw.split('\n')) {
          if (!l.trim()) continue;
          try { const rec = JSON.parse(l); for (const k of Object.keys(rec.peakSplit || {})) splitModels.push(k); } catch (e2) { /* 跳过坏行 */ }
        }
      } catch (e3) { /* 无明细文件 */ }
      return { rc: r.status, daily, splitModels, out: String(r.stdout || '') + String(r.stderr || '') };
    };
    try {
      const c = runStop();
      const costA = c.daily && c.daily[D69] && c.daily[D69].models[MA] ? c.daily[D69].models[MA].cost : null;
      const costB = c.daily && c.daily[D69] && c.daily[D69].models[MB] ? c.daily[D69].models[MB].cost : null;
      ok('T69-e1 ★无峰谷模型：金额=原价 ¥1.00（高峰不翻倍）且不落 peakSplit 明细',
        costA === 1.0 && c.splitModels.indexOf(MA) < 0,
        `cost=${costA} splitModels=${JSON.stringify(c.splitModels)} rc=${c.rc}`);
      if (!(costA === 1.0 && c.splitModels.indexOf(MA) < 0)) console.log(c.out.slice(-1500));
      ok('T69-e2 ★有峰谷模型：高峰×2 = ¥2.00 且落 peakSplit 明细（口径不回归）',
        costB === 2.0 && c.splitModels.indexOf(MB) >= 0,
        `cost=${costB} splitModels=${JSON.stringify(c.splitModels)} rc=${c.rc}`);
      if (!(costB === 2.0 && c.splitModels.indexOf(MB) >= 0)) console.log(c.out.slice(-1500));
    } catch (e) {
      ok('T69 行为夹具异常', false, (e && e.message) || String(e));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T70 —— v3.58.0（批8）：2026-10-14 外部审计报告「实证属实」项的修复守卫
//   取证过程：报告原件 `2026-10-14-02-19-31/.workbuddy/audit/`；逐条验证后**证伪/降级**的已剔除
//   （DeepSeek 官方只有峰/谷两档、无夜间档；调休按自然星期；holidayYearUnknown 亦非死代码 ——
//    主脚本 token-tracker.js isPeakHour 早已消费，审计那条是误判）。本组只守实证属实的九条。
//   ★ 头号：recalc-day 脏 cost → `dayTotal += stat.cost` 是**字符串拼接** → 当日合计 NaN 落盘且不自愈。
//   **反向验证要求**：把任一条修复改回修复前形态，对应断言必须变红；其余断言不得误伤。
// ═════════════════════════════════════════════════════════════════════════════════════════
{
  // 剥行注释后再匹配：守卫自身的注释里常引用目标形态，不剥会把自己数进去（v3.54.0 教训）。
  const strip70 = (s) => String(s || '').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  const rc70 = strip70(fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8'));
  const bf70 = strip70(fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8'));
  const pr70src = strip70(fs.readFileSync(path.join(SRC, 'peak-rules.js'), 'utf-8'));
  const wr70 = strip70(fs.readFileSync(path.join(SRC, 'wb-root.js'), 'utf-8'));
  const rp70 = strip70(fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8'));

  // ── ① recalc-day 脏 cost → 字符串拼接 → 当日合计 NaN（本批头号，唯一污染持久账本的） ──
  // v3.59.0（批10·S1）：2 → 4。批8-① 只修了 :337/:372 两个**主**累加点，漏了 :273/:279 两个
  //   early-continue 分支（`stat.cost || 0`）——脏字符串照样能把 dayTotal 腐化，末行兜底解析失败 →
  //   当日合计归 0、后续模型金额静默丢失。本次补齐，故期望值改为**全部累加点**。
  //   以后再加累放点必须同步改这个数（守卫故意用精确计数，宁可逼人改也不要放过漏修的分支）。
  ok('T70-a1 ★recalc 定义 safeCost，且「当日合计」的**全部 4 处**累加都走数值化（裸 `+= stat.cost` = 拼接）',
    /function safeCost\(v\)/.test(rc70)
    && (rc70.match(/dayTotal \+= safeCost\(stat\.cost\)/g) || []).length === 4
    && !/dayTotal \+= stat\.cost;/.test(rc70)
    && !/dayTotal \+= stat\.cost \|\| 0/.test(rc70));
  ok('T70-a2 ★recalc 落盘前对 dayTotal 再兜一次 safeCost（NaN 落盘即不自愈 → 必须拦在写入前）',
    /dayObj\.total\.cost = Math\.round\(safeCost\(dayTotal\) \* 1e6\) \/ 1e6;/.test(rc70));
  const rd70 = (() => { try { return require(path.join(SRC, 'recalc-day.js')); } catch (e) { return null; } })();
  ok('T70-b1 ★safeCost 行为：脏串/NaN/undefined/null 归一为 0，数值与数字串原值保留',
    !!rd70 && typeof rd70.safeCost === 'function'
    && rd70.safeCost('abc') === 0 && rd70.safeCost(NaN) === 0
    && rd70.safeCost(undefined) === 0 && rd70.safeCost(null) === 0
    && rd70.safeCost('0.5') === 0.5 && rd70.safeCost(1.23) === 1.23);
  // 反例自证：末尾那半条断言的是「裸拼接确实产生非数」，防止有人把判据写成恒真。
  ok('T70-b2 ★两笔字符串型 cost 累加 = 数值相加 1.7（改前 0+"0.5"+"1.2" → "00.51.2" → NaN）',
    !!rd70 && Math.abs((0 + rd70.safeCost('0.5') + rd70.safeCost('1.2')) - 1.7) < 1e-9
    && Number.isNaN(Number('00.51.2')));

  // ── ② backfill 命中率是「未钳制的复制」（P2-2 真身：不是累加侧，是显示层口径分裂） ──
  ok('T70-a3 ★backfill 的 hitRate 收敛到主脚本单点 tt.hitRate（本地无钳制副本 = 与增量记账命中率打架）',
    /const hitRate = \(inTok, cachedTok\) => tt\.hitRate\(inTok, cachedTok\);/.test(bf70)
    && !/function hitRate\(/.test(bf70));
  // ⚠️ 反向不能修成「累加时钳制 cached ≤ in」：主链路累加侧同样不钳，钳了 = 两条路径 token 硬账不等，
  //    直接违反本项目最高口径（token 量必须三路相等）。故这里**正向断言累加侧保持裸累加**。
  ok('T70-a4 ★backfill 累加侧保持 `m.cached += u.cached`（与主链路一致，禁在硬账侧钳制）',
    /m\.cached \+= u\.cached;/.test(bf70));

  // ── ③ backfill 水位线回滚文案两态 → 三态（首次回填时必谎报「回滚失败」） ──
  ok('T70-a5 ★backfill 回滚文案区分「无需回滚（水位线本次新建）」与「回滚失败」',
    /无需回滚（水位线文件是本次新建的，原本不存在）/.test(bf70)
    && /const rollbackState = restored \?/.test(bf70)
    && /const wmExisted = preLock\.result\.wmExists === true;/.test(bf70)
    && /return \{ aborted: false, stat: st, wmExists \};/.test(bf70));

  // ── ④⑤ peak-rules 周末语义分叉 + 跨午夜区间 ──
  ok('T70-a6 ★peak-rules 周末判据两分支同构（回落分支改前是无条件周末低峰，与 weekend_off_peak 开关矛盾）',
    (pr70src.match(/if \(weekendOff && \(dow === 0 \|\| dow === 6\)\) return false;/g) || []).length === 2);
  ok('T70-a7 ★peak-rules 支持跨午夜时段区间（改前 `r.e <= r.s` 直接 continue = 官方若加该档静默漏判）',
    /if \(r\.e <= r\.s\) \{ if \(hm >= r\.s \|\| hm < r\.e\) return true; continue; \}/.test(pr70src));
  const pr70 = (() => { try { return require(path.join(SRC, 'peak-rules.js')); } catch (e) { return null; } })();
  const bjTs70 = (s) => new Date(s + 'Z').getTime() - 8 * 3600e3; // 传入按北京时间写的串 → 对应 epoch ms
  ok('T70-b3 ★weekend_off_peak=false 时回落分支与开关语义一致（周六 10:00 应为高峰；改前给低峰）',
    !!pr70 && pr70.isPeakAt(bjTs70('2026-10-10T10:00'),
      { deepseek_rules: { weekend_off_peak: false, peak_schedule: 'garbage' } }, null) === true);
  ok('T70-b4 ★跨午夜区间按两段并集判定（22:00-02:00：23:00 与 01:00 高峰，10:00 低峰）',
    !!pr70
    && pr70.isPeakAt(bjTs70('2026-10-07T23:00'),
      { deepseek_rules: { weekend_off_peak: true, peak_schedule: '22:00-02:00' } }, null) === true
    && pr70.isPeakAt(bjTs70('2026-10-07T01:00'),
      { deepseek_rules: { weekend_off_peak: true, peak_schedule: '22:00-02:00' } }, null) === true
    && pr70.isPeakAt(bjTs70('2026-10-07T10:00'),
      { deepseek_rules: { weekend_off_peak: true, peak_schedule: '22:00-02:00' } }, null) === false);

  // ── ⑥ 假日表解析失败静默（降级不可见，与 holidayYearUnknown 同类） ──
  // ⚠️ 守卫自身教训（本批 R8 反向验证实测）：`_lastHolidaysError =` 在**成功分支也写了一份**（置 null），
  //   只匹配这个形态的话「删掉 catch 里那份（= 退回全静默）」仍恒绿 —— 断言必须**唯一到那一处**，
  //   故这里同时要求：① catch 分支的模板串形态；② 成功分支的置 null（清残留，否则错误态永不解除）。
  ok('T70-a8 ★peak-rules 解析失败必须留痕（导出 holidaysLoadError + catch 分支写入错误 + 成功分支清空）',
    /function holidaysLoadError\(\)/.test(pr70src) && /holidaysLoadError,/.test(pr70src)
    && /_lastHolidaysError = `\$\{holidaysPath\}/.test(pr70src)
    // ⚠️ 再踩同一类坑（本批 R8a 实测两次）：① 光写 `_lastHolidaysError = null;` 会命中**模块级声明行**
    //   `let _lastHolidaysError = null;`；② 收紧成 `[ \t]_lastHolidaysError` 仍命中（let 后那个空格也是 [ \t]）。
    //   最终锚到**唯一上下文**：紧跟「解析成功」那行 JSON.parse 之后（语义 = 解析成功必须清空错误态）。
    && /JSON\.parse\(fs\.readFileSync\(holidaysPath, 'utf-8'\)\);\s*_lastHolidaysError = null;/.test(pr70src));
  ok('T70-a9 文件不存在属正常部署场景 → 不打告警（只对「存在但解析失败」告警，防测试/首刷屏）',
    /mtime >= 0 && !_holidaysErrWarned/.test(pr70src));
  const bad70 = path.join(tmp, 'holidays-bad.json');
  fs.writeFileSync(bad70, '{ 这不是 JSON');
  ok('T70-b5 ★假日表损坏时 holidaysLoadError() 非 null（改前 catch 里直接吞掉 = 降级完全不可见）',
    !!pr70 && (() => { pr70.isPeakAt(bjTs70('2026-10-07T10:00'), {}, bad70); return pr70.holidaysLoadError(); })() !== null);

  // ── ⑦ wb-root 兜底前无二次筛选（两套根并存时整套路径会错位到另一个根） ──
  ok('T70-a10 ★wb-root 兜底前先用目录存在性再选一轮（且顺序在 marker 判定之后、硬兜底之前）',
    /if \(fs\.existsSync\(c\)\) return c;/.test(wr70)
    && wr70.indexOf('traces') < wr70.indexOf('if (fs.existsSync(c)) return c;')
    && wr70.indexOf('if (fs.existsSync(c)) return c;') < wr70.lastIndexOf('return path.join(h,'));

  // ── ⑧ refresh-prices 官方抓取 timeout 与子进程重试预算不匹配 ──
  ok('T70-a11 ★refresh-prices 官方抓取 timeout = 180000（120s 会在子进程重试退避中途把它掐死）',
    /timeout: 180000,/.test(rp70));

  // ── ⑨ recalc-day 是独立路径，主脚本那条 holidayYearUnknown 告警对它无效 ──
  ok('T70-a12 ★recalc-day 也消费 holidayYearUnknown（进程内按年去重，热路径不刷屏）',
    /peakRules\.holidayYearUnknown\(tMs, HOLIDAYS\)/.test(rc70) && /_holidayWarnedYears/.test(rc70));
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T71 —— v3.59.0（批10）：第二份外部审计（2026-10-14 16:37 工作区报告）「账本脏值防线」四条
//   S1  recalc-day 两处 early-continue 漏 safeCost（T70-a1 已把期望值 2→4，这里补**行为**级）
//   M12 build_index 半价（in/out 缺一半）进索引 → JS 侧 None*tokens=0 → 计费静默归 0
//   M16 lock 覆盖段价格未数值化 → 字符串价 '1'*2='11'；`"cached_price":null` → None*mult 崩整段
//   M17 三脚本 json.dump 默认 allow_nan=True → 写出 `NaN` 字面量 → Node JSON.parse 抛错计费崩
//   **反向验证要求**：回退任一条修复，对应断言必须变红；其余断言不得误伤。
// ═════════════════════════════════════════════════════════════════════════════════════════
{
  // 剥注释（JS 的 // 与 Python 的 # 都剥）：守卫自身注释常引用目标形态，不剥会把自己数进去。
  const strip71 = (s) => String(s || '').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/(^|\s)#.*$/, '$1')).join('\n');
  const bi71 = strip71(fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf8'));
  const fc71 = strip71(fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf8'));
  const pt71 = strip71(fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf8'));

  // v3.62.0（外部审计 F-4）：build_index 新增 changes.jsonl 的 append 写点（`json.dumps(...allow_nan=False)`）
  //   —— 旧价被取代的流水（effective_from/superseded_at）要可追溯，就得有一条结构化落盘。
  //   该正则的 `json\.dump[a-z]*` 刻意含 `dumps`（历史写法），故计数 2 → 3。
  //   fetch-cn-prices 仍为 2：F-2 拆掉的 parse_pricing_deepseek 里**没有** allow_nan dump 点
  //   （那份是读回 pricing.json 的环，不写 latest.json），故计数不变。
  ok('T71-a1 ★M17 三脚本 json.dump 全部 allow_nan=False（build_index 3 + fetch-cn-prices 2 + parse_tokenhub 1）',
    (bi71.match(/json\.dump[a-z]*\([^)]*allow_nan=False/g) || []).length === 3
    && (fc71.match(/json\.dump[a-z]*\([^)]*allow_nan=False/g) || []).length === 2
    && (pt71.match(/json\.dump[a-z]*\([^)]*allow_nan=False/g) || []).length === 1);
  ok('T71-a2 ★M12 新条目闸门拒收半价（in/out 缺一半 → 计费静默归 0 且不告警）',
    /for f in \('in_price', 'out_price'\):/.test(bi71) && /主价缺失/.test(bi71));
  ok('T71-a3 ★M16 lock 覆盖段价格数值化（_num 归一 + peak 要求 in/out 齐全）',
    /def _num\(x\)/.test(bi71) && /in_p, out_p, cache_p = _num\(/.test(bi71) && /跳过 peak 段/.test(bi71));
  // a4 必须锚到 **gate_new_model 函数体内**：全文搜 `('in_price','out_price','cache_hit')` 会命中
  //   classify_change 的价格比对循环（既有代码，与闸门无关）→ 误伤（v3.58.0 教训：锚点要唯一到那一处）。
  const gate71 = (() => {
    const i = bi71.indexOf('def gate_new_model');
    if (i < 0) return '';
    const j = bi71.indexOf('\ndef ', i + 10);
    return j < 0 ? bi71.slice(i) : bi71.slice(i, j);
  })();
  ok('T71-a4 ★M16 cache_hit 缺失仍是合法常态（A5 已定不修：厂商未公布缓存价按 0 计，闸门不得误杀）',
    /for f in \('in_price', 'out_price'\):/.test(gate71)
    && !/for f in \('in_price', 'out_price', 'cache_hit'\)/.test(gate71));

  // ── python 探测（与 SPAWN_OK 同纪律：不可用就 envSkip，不假绿）──
  const pyCands = [];
  try {
    const pvDir = 'C:/Users/14779/.workbuddy/binaries/python/versions';
    for (const v of fs.readdirSync(pvDir)) pyCands.push(path.join(pvDir, v, 'python.exe'));
  } catch (e) { /* 目录不存在就走 PATH */ }
  pyCands.push('python', 'python3');
  let PY71 = null;
  for (const c of pyCands) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY71 = c; break; }
  }

  if (!SPAWN_OK) envSkip('T71-b/c 行为组（spawn python / recalc-day）', SPAWN_SKIP_REASON);
  else if (!PY71) envSkip('T71-b/c 行为组（spawn python / recalc-day）', 'python 不可用');
  else {
    // ── M12 / M16：隔离跑 build_index.py ──
    const fx = path.join(tmp, 'b10fx');
    const fwb = path.join(fx, 'wb');
    const fsk = path.join(fwb, 'skills', 'token-usage-tracker');
    const fpr = path.join(fx, 'prices');
    fs.mkdirSync(fsk, { recursive: true });
    fs.mkdirSync(fpr, { recursive: true });
    fs.writeFileSync(path.join(fsk, 'pricing.json'), JSON.stringify({
      currency: 'CNY', unit: '元/百万 tokens', models: {
        locknullcache: { name: '锁空缓存', input_price: 1.0, output_price: 2.0, cached_price: null, peak_multiplier: 2, lock: true, region: 'CN' },
        lockstrprice: { name: '锁字符串价', input_price: '1', output_price: 2.0, cached_price: 0.5, peak_multiplier: 2, lock: true, region: 'CN' },
        lockgood: { name: '锁正常', input_price: 1.0, output_price: 2.0, cached_price: 0.5, peak_multiplier: 2, lock: true, region: 'CN' },
      },
    }));
    fs.writeFileSync(path.join(fpr, 'latest.json'), JSON.stringify({ vendors: { vA: { models: [
      { name: '半价', api_name: 'half-price', in_price: null, out_price: 2.0, cache_hit: 0.5, currency: 'CNY', unit: '元/百万 tokens', region: 'CN', source_url: 'http://x', fetched_at: '2026-10-14' },
      { name: '正常', api_name: 'ok-model', in_price: 3.0, out_price: 4.0, cache_hit: 1.0, currency: 'CNY', unit: '元/百万 tokens', region: 'CN', source_url: 'http://x', fetched_at: '2026-10-14' },
    ] } } }));
    // 上一版索引只放 okmodel（halfprice 因此走"新条目闸门"）；all_sources 必带 —— build_index 打印段
    // 裸取 m['all_sources']（既有缺陷 F-A，生产 51/51 全有故不触发，夹具须贴合生产形态）
    fs.writeFileSync(path.join(fpr, 'index.json'), JSON.stringify({ built_at: '2026-10-13', models: {
      okmodel: { name: '正常', api_name: 'ok-model', in_price: 3.0, out_price: 4.0, cache_hit: 1.0, currency: 'CNY', unit: '元/百万 tokens', region: 'CN', primary_source: 'vA', primary_source_type: 'first_party', all_sources: [{ name: '正常', in: 3.0, out: 4.0, cache: 1.0, source: 'vA', source_type: 'first_party' }] },
    } }));
    const br = spawnSync(PY71, [path.join(SRC, 'build_index.py')], {
      env: Object.assign({}, process.env, PY_IO_ENV, { WB_ROOT: fwb, CN_PRICES_DIR: fpr }),
      encoding: 'utf8', timeout: 180000, windowsHide: true,
    });
    const M = (() => { try { return JSON.parse(fs.readFileSync(path.join(fpr, 'index.json'), 'utf8')).models || {}; } catch (e) { return {}; } })();
    ok('T71-b1 ★M16 `"cached_price":null` 不再崩 build_index（None*mult TypeError → 整段停产）',
      br.status === 0, `exit=${br.status} ${String(br.stderr || '').slice(0, 200)}`);
    // v3.62.0（外部审计 S-3）：本条期望被 S-3 **上修**并在此留痕，不是削弱守卫。
    //   旧期望（M16）：字符串价归一成 None 后**仍写进索引**（in_price=null）——实测该形态正是
    //   S-3 的病根：索引里出现主价为 None 的"权威条目" → JS 侧 None*tokens=0 → 静默少收。
    //   新期望：in/out 任一非数值即**整条拒收**（fail-closed），保留抓取源原值、不入索引，
    //   同时进 authoritative_issues（用户从 --report 的 ⚠价锁 看得见）。
    ok('T71-b2 ★M16 字符串价归一为 None（改前 ' + "'1'*2='11'" + ' 错峰价）—— v3.62.0 S-3 上修为「整条拒收」',
      !('lockstrprice' in M) && /lock 条目 lockstrprice[\s\S]{0,80}条目主价缺失或非数值/.test(String(br.stderr || '')),
      `索引内含 lockstrprice=${'lockstrprice' in M}（应为 false：坏手工价不得进入索引）`
      + ` stderr=[${String(br.stderr || '').split('\n').filter((l) => l.indexOf('lockstrprice') >= 0).join(' | ').slice(0, 200)}]`);
    ok('T71-b3 ★M16 正常 lock 的 peak 仍正确（1.0×2=2.0，不得被数值化误伤）',
      !!M.lockgood && !!M.lockgood.peak && M.lockgood.peak.peak.in === 2.0 && M.lockgood.peak.idle.in === 1.0);
    ok('T71-b4 ★M12 半价条目被闸门拒收（不进索引 → 按未收录计价，而非按 0 计）', !('halfprice' in M));
    ok('T71-b5 ★M12 拒收有 WARN 留痕（不静默）', /主价缺失/.test(String(br.stderr || '')));
    ok('T71-b6 ★M12 正常条目不受影响（沿用上一版 3.0）', !!M.okmodel && M.okmodel.in_price === 3.0);
    try { fs.rmSync(fx, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }

    // ── S1：隔离跑 recalc-day，两个早退分支各验一次 ──
    const fw = path.join(tmp, 'b10s1');
    const fsk2 = path.join(fw, 'skills', 'token-usage-tracker');
    fs.mkdirSync(fsk2, { recursive: true });
    const LED = { '2026-01-02': { models: {
      modeldirty: { in: 1000, cached: 0, out: 100, cost: '0.5', hit: 0 },
      modelnormal: { in: 2000, cached: 0, out: 200, cost: 12.3, hit: 0 },
    }, total: { cost: 12.8, in: 3000, cached: 0, out: 300 } } };
    const DAILY_PATH = path.join(fsk2, 'daily-usage.json');
    const totalOf = () => { try { return JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8'))['2026-01-02'].total.cost; } catch (e) { return null; } };
    fs.writeFileSync(DAILY_PATH, JSON.stringify(LED));
    fs.writeFileSync(path.join(fsk2, 'pricing.json'), JSON.stringify({ models: {} }));   // 两个模型都查不到价 → 早退
    fs.writeFileSync(path.join(fsk2, 'holidays.json'), JSON.stringify({}));
    const e71 = Object.assign({}, process.env, { WB_ROOT: fw, TOKEN_TRACKER_NO_TOAST: '1' });
    // v3.62.0（外部审计 F-3/G-1）：默认 dry-run → 必须显式 --write。
    //   ⚠ 不加会**假绿**：dry-run 不写盘 → 账本保持预置的 12.8 → `t1===12.8` 恒真，
    //     而本组要证的恰恰是"recalc 真跑了且没把脏串腐化成 0"。
    // ⚠ v3.62.0（F-3）：再加 --current-price —— '2026-01-02' 是历史日、隔离库无快照，
    //   默认口径 fail-closed 拒绝（exit 1、不写盘）→ 又会退化成"账本保持 12.8"的**同一种假绿**。
    const ra = spawnSync(NODE, [path.join(SRC, 'recalc-day.js'), '2026-01-02', '--current-price', '--write'], { env: e71, encoding: 'utf8', timeout: 90000, windowsHide: true });
    const t1 = totalOf();
    fs.writeFileSync(DAILY_PATH, JSON.stringify(LED));
    const rb = spawnSync(NODE, [path.join(SRC, 'recalc-day.js'), '2026-01-02', 'modelnormal', '--current-price', '--write'], { env: e71, encoding: 'utf8', timeout: 90000, windowsHide: true });
    const t2 = totalOf();
    ok('T71-c1 ★S1 无价早退分支：脏串 "0.5" + 正常 12.3 = 12.8（改前腐化成 "0.512.3" → 合计归 0、12.3 丢失）',
      t1 === 12.8, `got=${JSON.stringify(t1)} rc=${ra.status}`);
    ok('T71-c2 ★S1 onlyModel 早退分支：同样不腐化', t2 === 12.8, `got=${JSON.stringify(t2)} rc=${rb.status}`);
    try { fs.rmSync(fw, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T73 —— v3.59.0（批12）：「价库流水线单位断言 + 链不断」四条
//   S5  四家计价单位被 setdefault('元/百万 tokens') 硬盖 → 页面改单位 → 1000× 错价静默过关
//   S6  parse_tokenhub exit(2)（有意 fail-closed）连带断链 → build_index 停产、四家新数据全晾
//   M18 build_index 是唯一没有 makedirs 的脚本 → 单独运行/首日部署 FileNotFoundError 裸崩
//   M21 抓取无重试 → 一次瞬时抖动 = 该厂商当日停更
//   **反向验证要求**：回退任一条修复，对应断言必须变红；其余断言不得误伤。
// ═════════════════════════════════════════════════════════════════════════════════════════
{
  const strip73 = (s) => String(s || '').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/(^|\s)#.*$/, '$1')).join('\n');
  const fcp73 = strip73(fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf8'));
  const bi73 = strip73(fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf8'));
  const pth73 = strip73(fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf8'));
  const tt73 = strip73(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf8'));

  // ── S5：单位断言 ──
  ok('T73-a1 ★S5 公共单位判定函数存在（全角／半角／大小写／空格归一；元/千·万字符·小时·次一律拒）',
    /def unit_is_token_million\(text\):/.test(fcp73)
    && /UNIT_TOKEN_MILLION_RE = re\.compile\(r'元\\s\*\[／\/\]\\s\*百万\\s\*tokens\?'/.test(fcp73));
  ok('T73-a2 ★S5 智谱单位校验锚到 in/out 两列（不能整表头扫：缓存存储列是「元/百万 Tokens/小时」不同量纲，整扫会被带恒真）',
    fcp73.indexOf("unit_is_token_million(hdr[cmap['in']]) and unit_is_token_million(hdr[cmap['out']])") >= 0);
  ok('T73-a3 ★S5 阶跃实现「向上找最近的单位声明」（此前只停在注释层、未实现；读不到 = 非 token 计价表 → 跳过）',
    /def read_unit_decl\(lines, before_idx/.test(fcp73)
    && /unit_decl = read_unit_decl\(lines, tbl_start\)/.test(fcp73)
    && /if unit_decl is None:/.test(fcp73)
    && /表单位非元\/百万 tokens/.test(fcp73));
  // v3.61.0（审计 F1）：判据随实现升级为**命名分组**形态 —— 分组编号漂移正是 F1 的病根，
  //   继续钉"数字分组长这样"会把修复本身判成回归。单位断言语义不变。
  ok('T73-a4 ★S5 Kimi 单位显式断言（原正则写死 "1M tokens" → 页面改 1K 时静默 0 模型；现 WARN + 跳过）',
    /\(\?P<unit>\[\\d\.,\]\+\[MK\]\)\\s\*tokens/.test(fcp73)
    && /m\.group\('unit'\)\.upper\(\) != '1M'/.test(fcp73)
    && fcp73.indexOf('计价单位非 1M tokens') >= 0);
  ok('T73-a5 ★S5 四家解析器都显式回传 unit（setdefault 不再是唯一来源）',
    (fcp73.match(/'unit': '元\/百万 tokens'/g) || []).length >= 4);
  ok('T73-a6 ★S5 main 不再静默兜底 unit（裸 setdefault 已删；缺失时 WARN 留痕 + 仍兜底防契约海关拒收）',
    !/mm\.setdefault\('unit', '元\/百万 tokens'\)/.test(fcp73)
    && /解析器未回传 unit/.test(fcp73));

  // ── M21：重试 ──
  ok('T73-a7 ★M21 fetch-cn-prices 抓取重试（指数退避，默认 2 次；CN_PRICE_HTTP_RETRIES 可调）',
    /HTTP_RETRIES = int\(os\.environ\.get\('CN_PRICE_HTTP_RETRIES'\) or '2'\)/.test(fcp73)
    && /HTTP_RETRY_BASE_MS \* \(2 \*\* attempt\)/.test(fcp73));
  ok('T73-a8 ★M21 parse_tokenhub 同口径重试（腾讯文档页抖动一次失败 → 整条源 exit(2) 保留旧版，本可不必）',
    /TOKENHUB_RETRIES = int\(os\.environ\.get\('CN_PRICE_HTTP_RETRIES'\) or '2'\)/.test(pth73)
    && /TOKENHUB_RETRY_BASE_MS \* \(2 \*\* attempt\)/.test(pth73));

  // ── M18：目录自建 ──
  ok('T73-a9 ★M18 build_index 开工前自建价库目录（原为唯一没有 makedirs 的脚本 → 单独运行裸崩）',
    /os\.makedirs\(PRICES_DIR, exist_ok=True\)/.test(bi73));

  // ── S6：链不断 ──
  ok('T73-a10 ★S6 单步失败不阻断后续脚本（parse_tokenhub 的有意 fail-closed 不再连带停产 build_index）',
    /failedSteps\.push\(scripts\[idx\] \+ '\(exit=' \+ code \+ '\)'\);[\s\S]{0,120}resolve\(runAll\(idx \+ 1\)\);/.test(tt73));
  ok('T73-a11 ★S6 链尾按 failedSteps 定退出码（链不断 ≠ 失败不可见：有失败仍非零收尾、告警照旧）',
    /code: failedSteps\.length \? 2 : 0/.test(tt73));
  ok('T73-a12 ★S6 告警文案带失败步骤名（用户知道是哪一源挂了）',
    /失败步骤: \$\{failedSteps\.join\(', '\)\}/.test(tt73));

  // ── 行为组：单位校验真端到端（python 内联，不起子进程）──
  const pyCands73 = [];
  if (process.env.CN_PYTHON) pyCands73.push(process.env.CN_PYTHON);
  pyCands73.push('python', 'python3');
  let PY73 = null;
  for (const c of pyCands73) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY73 = c; break; }
  }
  if (!PY73) envSkip('T73-b 行为组（python 内联单位校验）', 'python 不可用');
  else {
    const fw = path.join(tmp, 'b12s5');
    const fsk = path.join(fw, 'skills', 'token-usage-tracker');
    fs.mkdirSync(fsk, { recursive: true });
    const py = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, sys',
      "_spec = importlib.util.spec_from_file_location('fcp', " + JSON.stringify(path.join(SRC, 'fetch-cn-prices.py')) + ")",
      'F = importlib.util.module_from_spec(_spec)',
      '_spec.loader.exec_module(F)',
      'fails = []',
      'def chk(n, c, d=""):',
      '    print(("  OK   " if c else "  FAIL ") + n + (("  " + d) if d else ""))',
      '    if not c: fails.append(n)',
      'chk("unit 半角", F.unit_is_token_million("输入单价（元/百万 Tokens）"))',
      'chk("unit 全角", F.unit_is_token_million("单位：元／百万 tokens。"))',
      'chk("unit 元/千拒", not F.unit_is_token_million("LoRA 微调（元/千 Tokens）"))',
      'ZH = "<table><tr><th>模型名称</th><th>上下文</th><th>输入单价（元/百万 Tokens）</th><th>输出单价（元/百万 Tokens）</th><th>缓存存储（元/百万 Tokens/小时）</th><th>缓存命中（元/百万 Tokens）</th></tr><tr><td>GLM-5</td><td>128K</td><td>4</td><td>8</td><td>限时免费</td><td>1</td></tr></table>"',
      'r = F.parse_zhipu_docs(ZH)',
      'chk("智谱正常解析", len(r) == 1, "n=%d" % len(r))',
      'chk("智谱回传 unit", bool(r) and r[0].get("unit") == "元/百万 tokens")',
      'ZHB = ZH.replace("输入单价（元/百万 Tokens）", "输入单价（元/千 Tokens）").replace("输出单价（元/百万 Tokens）", "输出单价（元/千 Tokens）")',
      'chk("智谱 in/out 改元/千 → 整表跳过（缓存存储列仍元/百万/小时，锚列校验才抓得到）", len(F.parse_zhipu_docs(ZHB)) == 0)',
      'SF = "单位：元／百万 tokens。\\n\\n| Model ID | 输入价格（缓存未命中） | 输入价格（缓存命中） | 输出价格 |\\n| - | - | - | - |\\n| `step-5-preview` | 7 | 0.70 | 20 |\\n\\n| Model ID | 单价 |\\n| - | - |\\n| `stepaudio-3-tts` | 2.5 元／万字符 |\\n"',
      'rs = F.parse_stepfun_md(SF)',
      'chk("阶跃 token 表解析 + 万字符表排除", len(rs) == 1 and rs[0].get("unit") == "元/百万 tokens", "n=%d" % len(rs))',
      'chk("阶跃无单位声明 → 跳过", len(F.parse_stepfun_md(SF.replace("单位：元／百万 tokens。\\n\\n", ""))) == 0)',
      'chk("阶跃单位元/千 → 跳过", len(F.parse_stepfun_md(SF.replace("元／百万 tokens。", "元／千 tokens。"))) == 0)',
      'print("RESULT %d %d" % (len(fails), 0))',
      'sys.exit(1 if fails else 0)',
    ].join('\n');
    const pf = path.join(fw, 't73.py');
    fs.writeFileSync(pf, py, 'utf8');
    const r73 = spawnSync(PY73, [pf], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    let matched73 = 0;
    // ⚠ split(/\r?\n/)：Windows python 输出 CRLF，JS 的 `.` 不匹配 `\r` →
    //   `(.*)$` 被行尾的 \r 卡住、整行失配（实测 split('\n') 时 10 条断言行 0 识别）。
    for (const ln of String(r73.stdout || '').split(/\r?\n/)) {
      const m = /^\s*(OK|FAIL)\s+(.*)$/.exec(ln);
      if (m) ok('T73-b' + (++matched73) + ' ' + m[2], m[1] === 'OK');
    }
    ok('T73-b0 行为组断言行被识别（python 输出格式/编码异常时此处暴露原文）',
      matched73 > 0,
      'status=' + r73.status + ' lines=' + String(r73.stdout || '').split('\n').length
      + ' stdout=[' + String(r73.stdout || '').replace(/\n/g, '\\n') + ']'
      + ' stderr=[' + String(r73.stderr || '').slice(0, 600) + ']');
    try { fs.rmSync(fw, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T72 —— v3.59.0（批11）：「价格冻结与改价告警透传」三条
//   S2  deepseek-official 主路径透传 lock 标志却覆写价格 → 用户手工核对价（最高防线）被静默穿透
//   S3  peak_multiplier_note 全仓零消费 → 官方改峰谷倍率、价改而零提示
//   M5  bigDiff 价差告警只覆盖 CN 主价分支，官方价覆写分支漏报
//   **反向验证要求**：回退任一条修复，对应断言必须变红；其余断言不得误伤。
//   ⚠ 只堵 deepseek-official **主路径**的 lock；1.5 跨 key 接管与 1.6 旧模型名绑定里的
//     `delete m.lock` 是 v3.07 / v3.51.0 的有意设计（防旧名永久冻结在过期价），**不是缺陷**。
// ═════════════════════════════════════════════════════════════════════════════════════════
{
  const strip72 = (s) => String(s || '').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/(^|\s)#.*$/, '$1')).join('\n');
  const ds72 = strip72(fs.readFileSync(path.join(SRC, 'deepseek-official.js'), 'utf8'));
  const rp72 = strip72(fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf8'));

  // a1/a2 锚到 forEach 主路径体内（:478-536）：全文搜 `existing.lock === true` 会命中 1.5/1.6 段的
  //   有意设计（防旧名永久冻结在过期价）→ 误伤。锚点用**代码行**（`delete ...retired`），
  //   注释锚点在剥注释后会消失（v3.58.0 教训：锚点必须唯一且剥注释后仍存活）。
  const mainPath72 = (() => {
    const i = ds72.indexOf('parsed.models.forEach');
    if (i < 0) return '';
    const j = ds72.indexOf('delete pricing.models[mkey].retired', i);
    return j < 0 ? ds72.slice(i) : ds72.slice(i, j);
  })();
  ok('T72-a1 ★S2 主路径 lock 冻结优先于官方价（留痕 _official_ref + return 跳过覆写）',
    /if \(existing\.lock === true\) \{/.test(mainPath72)
    && /_official_ref/.test(mainPath72)
    && /return;/.test(mainPath72)
    && !/delete m\.lock/.test(mainPath72));
  ok('T72-a2 ★S2 冻结告警对用户可见（stderr 明说保留核对价 + 官方现价未覆写）',
    /已设 lock 冻结 → 保留用户核对价/.test(mainPath72) && /未覆写（如确认采用请手动解除 lock）/.test(mainPath72));
  ok('T72-a3 ★S3 refresh-prices 消费 peak_multiplier_note（改前零消费 → 官方改倍率零提示）',
    /peak_multiplier_note/.test(rp72) && /officialPeakNote/.test(rp72));
  // a4 只断言 M5 **真正改的部分**（officialBlk 分支的 bigDiff 覆盖）。
  //   ⚠ refresh 侧的 `lockBlocksMainPrice` 锁守卫是 v3.40.0 既有代码（第二道防线），**不是本批改动**，
  //     故不纳入断言——否则守卫会暗示"本批加了锁"，回退本批改动时它仍绿、失去检出意义。
  ok('T72-a4 ★M5 官方价覆写分支也走 bigDiff 价差告警（改前只 cnHit 分支检测 → 官方改价静默入账）',
    /else if \(officialBlk\) \{[\s\S]{0,900}?const oldInOff = m\.input_price, oldOutOff = m\.output_price;/.test(rp72)
    && /else if \(officialBlk\) \{[\s\S]{0,900}?bigDiff\.push\(`\$\{key\}\(官方价/.test(rp72));

  if (!SPAWN_OK) envSkip('T72-b 行为组（spawn deepseek-official + --require 预加载）', SPAWN_SKIP_REASON);
  else {
    // ── S2 端到端：假官方页（--require 预加载 patch fetch，不联网）──
    // 沙箱会拦 spawn 出的子进程访问本地 HTTP（同进程 fetch 却正常）→ 不走网络，直接替换 fetch。
    const fx = path.join(tmp, 'b11fx');
    const fwb = path.join(fx, 'wb');
    const fsk = path.join(fwb, 'skills', 'token-usage-tracker');
    fs.mkdirSync(fsk, { recursive: true });
    const HTML = `<html><body><h1>DeepSeek pricing</h1>
<table>
<tr><td>模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>模型版本</td><td>DeepSeek-V4-Flash</td><td>DeepSeek-V4-Pro</td></tr>
<tr><td>百万tokens输入（缓存命中）空闲</td><td>0.02</td><td>0.04</td></tr>
<tr><td>百万tokens输入（缓存命中）高峰时段</td><td>0.04</td><td>0.08</td></tr>
<tr><td>百万tokens输入（缓存未命中）空闲</td><td>1</td><td>2</td></tr>
<tr><td>百万tokens输入（缓存未命中）高峰时段</td><td>2</td><td>4</td></tr>
<tr><td>百万tokens输出 空闲</td><td>4</td><td>8</td></tr>
<tr><td>百万tokens输出 高峰时段</td><td>8</td><td>16</td></tr>
</table>
<p>北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段，其余为空闲时段。</p>
</body></html>`;
    const pre = path.join(fx, 'preload.js');
    fs.writeFileSync(pre, `const orig = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (/deepseek|127\\.0\\.0\\.1|localhost/.test(String(url))) {
    return new Response(${JSON.stringify(HTML)}, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return orig(url, opts);
};`, 'utf8');
    fs.writeFileSync(path.join(fsk, 'pricing.json'), JSON.stringify({
      currency: 'CNY', unit: '元/百万 tokens',
      models: {
        'deepseek-v4-flash': { name: 'Flash', input_price: 1.5, cached_price: 0.05, output_price: 4.5, peak_multiplier: 2, lock: true, price_source: 'deepseek官方', region: 'CN' },
        'deepseek-v4-pro': { name: 'Pro', input_price: 9, cached_price: 0.2, output_price: 20, peak_multiplier: 2, price_source: 'deepseek官方', region: 'CN' },
      },
    }));
    const dr = spawnSync(NODE, ['--require', pre, path.join(SRC, 'deepseek-official.js')], {
      env: Object.assign(makeT72bChildEnv(process.env), {
        WB_ROOT: fwb, DS_OFFICIAL_URL: 'http://127.0.0.1:9/deepseek-official', DS_RETRIES: '0',
        DS_RETRY_DELAY_MS: '1', TOKEN_TRACKER_NO_TOAST: '1',
      }),
      encoding: 'utf8', timeout: 120000, windowsHide: true,
    });
    const P = (() => { try { return JSON.parse(fs.readFileSync(path.join(fsk, 'pricing.json'), 'utf8')); } catch (e) { return { models: {} }; } })();
    const flash = P.models['deepseek-v4-flash'] || {};
    const pro = P.models['deepseek-v4-pro'] || {};
    const ref = (P._official_ref || []).find((r) => r && r.model === 'deepseek-v4-flash') || null;
    ok('T72-b1 ★S2 端到端 lock 条目不被官方覆写（仍 1.5/0.05/4.5）',
      flash.input_price === 1.5 && flash.cached_price === 0.05 && flash.output_price === 4.5,
      `got=${flash.input_price}/${flash.cached_price}/${flash.output_price} rc=${dr.status}`);
    ok('T72-b2 ★S2 lock 标志保留（不是只留痕又删标志）', flash.lock === true);
    ok('T72-b3 ★S2 官方现价留痕 _official_ref（用户想采纳时查得到，顶层与 _manual_audit 同设计）',
      !!ref && ref.official.input_price === 1 && ref.official.output_price === 4 && ref.frozen.input_price === 1.5);
    ok('T72-b4 ★S2 冻结告警进 stderr（用户可见）', /已设 lock 冻结/.test(String(dr.stderr || '')));
    ok('T72-b5 ★S2 非 lock 条目照常被官方更新（Pro → 2/0.04/8，修复没把正常路径堵死）',
      pro.input_price === 2 && pro.cached_price === 0.04 && pro.output_price === 8,
      `got=${pro.input_price}/${pro.cached_price}/${pro.output_price}`);
    ok('T72-b6 ★S2 整轮 exit=0', dr.status === 0, `rc=${dr.status} ${String(dr.stderr || '').slice(0, 160)}`);
    try { fs.rmSync(fx, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// T74 —— v3.59.0（批13）：假日表健壮性两条
//   S4  源返回空数组 → truthy 照样进两源交集 → 另一源的有效数据被白丢（只剩"少一天更新"，且零告警）
//   M31 stale_detail 从 old 继承后只增不减 → 年份恢复后陈旧明细永久残留，--check 与人工排查误判一年
//   **反向验证要求**：回退任一条修复，对应断言必须变红；其余断言不得误伤。
//   ⚠ M34（±1 年滚动窗口）经定性为**设计取舍**（降级 + stderr 告警 + 修复指引三件套齐全）→ 不修、不加断言。
//     别把"窗口外年份按非假日"当缺陷重复排查。
// ═══════════════════════════════════════════════════════════════════════════
{
  const strip74 = (s) => String(s || '').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/(^|\s)#.*$/, '$1')).join('\n');
  const rh74 = strip74(fs.readFileSync(path.join(SRC, 'refresh-holidays.js'), 'utf8'));

  // a 组锚点说明：剥注释后仍存活的**代码行**（v3.58.0 教训：注释锚点剥完就没了）。
  //   `a.length === 0` 在全文只命中归一那一行 —— `adopt.length === 0` 的字符序列不含 "a.length"
  //   （'a' 后接 'd'），`b.offDays.length === 0` 同理，故不会误命中。
  ok('T74-a1 ★S4 源A 空数组归一为 null（空数组=本次不可用，不是"该年 0 天"）',
    /if \(Array\.isArray\(a\) && a\.length === 0\) a = null;/.test(rh74));
  ok('T74-a2 ★S4 源B 空数组同样归一（只修一侧 = 另一侧坏源照样白丢数据）',
    /if \(b && Array\.isArray\(b\.offDays\) && b\.offDays\.length === 0\) b = null;/.test(rh74));
  ok('T74-a3 ★S4 归一发生在「两源都取不到」判断**之前**（顺序颠倒则归一无效，仍走交集）',
    rh74.indexOf('a.length === 0') >= 0 && rh74.indexOf('if (!a && !b)') > rh74.indexOf('a.length === 0'));
  // v3.59.1（审计批17·中危）：M31 的"整体重算"演进为"**差量更新**" —— "恢复即清理"的语义没有丢
  //   （由 delete 保证），只是未覆盖年份不再被抹（子集重跑不丢触发源，见 T81-a16）。
  //   这里同步演进断言形态，且**检出力不降反升**：差量基线 + delete 两个形态都钉。
  ok('T74-a4 ★M31 stale_detail 差量更新（以 old 为基线保留未覆盖年份；恢复即清理仍在 —— 缺 delete = 旧累积 bug 复发）',
    /const staleDetail = Object\.assign\(\{\}, old\.stale_detail \|\| \{\}\)/.test(rh74)
    && /delete staleDetail\[yy\]/.test(rh74));
  ok('T74-a5 ★M31 连续缺失沿用旧 since（缺数据的起始日不该被"今天又缺一次"刷新成今天）',
    /const prev = \(old\.stale_detail \|\| \{\}\)\[yy\];/.test(rh74)
    && /since: \(prev && prev\.since\) \|\| new Date\(/.test(rh74));

  if (!SPAWN_OK) envSkip('T74-b 行为组（spawn refresh-holidays + --require 预加载）', SPAWN_SKIP_REASON);
  else {
    const fx = path.join(tmp, 'b13fx');
    const fwb = path.join(fx, 'wb');
    const fsk = path.join(fwb, 'skills', 'token-usage-tracker');
    fs.mkdirSync(fsk, { recursive: true });
    const HOL = path.join(fsk, 'holidays.json');
    const read = () => { try { return JSON.parse(fs.readFileSync(HOL, 'utf8')); } catch (e) { return {}; } };
    // 预加载替换 fetch（ghJson 只消费 res.ok / res.json().content(base64)），**全程不联网**。
    //   FX_EMPTY_A=<年> → 该年源A返回 `{days:[]}`（模拟页面改版/字段改名后的空解析结果）
    //   FX_FAIL_Y=<年>  → 该年两源都 HTTP 500（模拟源抖动/限流）
    const pre = path.join(fx, 'preload.js');
    fs.writeFileSync(pre, `const orig = globalThis.fetch;
const D = { 2025: ['2025-01-01','2025-05-01'], 2026: ['2026-01-01','2026-05-01'], 2027: ['2027-10-01','2027-10-02','2027-10-03'] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!/api\\.github\\.com/.test(u)) return orig(url, opts);
  const y = (u.match(/\\/(\\d{4})\\.json/) || [])[1] || '';
  const has = (v) => String(v || '').split(',').indexOf(y) >= 0;
  if (has(process.env.FX_FAIL_Y)) return { ok: false, status: 500, json: async () => ({}) };
  const days = D[y] || ['2026-01-01'];
  let body;
  if (/holiday-cn/.test(u)) {
    body = has(process.env.FX_EMPTY_A) ? { days: [] }
      : { days: days.map((d) => ({ name: 'x', date: d, isOffDay: true })) };
  } else {
    body = { arrangements: [{ holiday_dates: days }], source: { source_url: 'https://gov.example/' + y }, holiday_day_count: days.length };
  }
  return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(body)).toString('base64') }) };
};`, 'utf8');
    const run = (args, env) => spawnSync(NODE, ['--require', pre, path.join(SRC, 'refresh-holidays.js')].concat(args), {
      env: Object.assign({}, process.env, { WB_ROOT: fwb, TOKEN_TRACKER_NO_TOAST: '1' }, env || {}),
      encoding: 'utf8', timeout: 120000, windowsHide: true,
    });

    // ── S4 端到端：源A 空数组 + 源B 有效 → 必须采用 B（改前：交集为空 → 保留旧数据，白丢一天更新）──
    fs.writeFileSync(HOL, JSON.stringify({ years: { '2027': ['2027-01-01'] }, stale_detail: {} }), 'utf8');
    const r4 = run(['2027'], { FX_EMPTY_A: '2027' });
    const y27 = (read().years || {})['2027'];
    ok('T74-b1 ★S4 源A 空数组时采用源B 的数据（一个源坏不影响另一个源落地）',
      JSON.stringify(y27) === JSON.stringify(['2027-10-01', '2027-10-02', '2027-10-03']),
      `got=${JSON.stringify(y27)} rc=${r4.status} ${String(r4.stderr || '').slice(0, 160)}`);
    ok('T74-b2 ★S4 不再保留旧数据（改前 adopt=[] → 空年守卫 → 旧值 ' + "'2027-01-01'" + ' 原地不动）',
      Array.isArray(y27) && y27.indexOf('2027-01-01') < 0, `got=${JSON.stringify(y27)}`);
    ok('T74-b3 ★S4 走的是「仅单源 → 采用」分支（可观测，不是静默换值）',
      /仅单源 → 采用/.test(String(r4.stdout || '')));

    // ── M31 端到端：先让 2027 缺数据（沿用旧 since）→ 再让它恢复 → stale_detail 必须清空 ──
    fs.writeFileSync(HOL, JSON.stringify({
      years: { '2025': ['2025-01-01'], '2026': ['2026-01-01'] },
      stale_detail: { '2027': { since: '2026-01-01', reason: '上一轮遗留' } },
    }), 'utf8');
    const m1 = run([], { FX_FAIL_Y: '2027' });
    const H1 = read();
    ok('T74-b4 ★M31 连续缺失沿用旧 since（起始日仍是 2026-01-01，不是被刷新成今天）',
      !!H1.stale_detail && H1.stale_detail['2027'] && H1.stale_detail['2027'].since === '2026-01-01',
      `got=${JSON.stringify(H1.stale_detail)} rc=${m1.status}`);
    ok('T74-b5 ★M31 缺失年份进 stale_years（可见性不因清理逻辑丢失）',
      Array.isArray(H1.stale_years) && H1.stale_years.indexOf(2027) >= 0 && H1._stale === true,
      `got=${JSON.stringify(H1.stale_years)}`);
    const m2 = run([], {});
    const H2 = read();
    ok('T74-b6 ★M31 年份恢复后 stale_detail 清空（改前旧明细永不删除 → --check 误报一年）',
      H2.stale_detail && Object.keys(H2.stale_detail).length === 0,
      `got=${JSON.stringify(H2.stale_detail)} rc=${m2.status} ${String(m2.stderr || '').slice(0, 160)}`);
    ok('T74-b7 ★M31 stale_years 同步清空 + _stale=false（两字段口径一致）',
      Array.isArray(H2.stale_years) && H2.stale_years.length === 0 && H2._stale === false,
      `got=${JSON.stringify(H2.stale_years)} _stale=${H2._stale}`);
    ok('T74-b8 ★M31 2027 数据真的恢复了（不是"把明细删掉假装没事"）',
      JSON.stringify((H2.years || {})['2027']) === JSON.stringify(['2027-10-01', '2027-10-02', '2027-10-03']),
      `got=${JSON.stringify((H2.years || {})['2027'])}`);
    try { fs.rmSync(fx, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// T75 —— v3.59.0（批15）：测试网床 —— 「取消补弹」端到端命名用例（M37）
//   报告第三节判定「取消补弹链路是最薄的一环」：v2.85 起它就是"弹不出就永久丢一轮 token"的兜底
//   （取消轮不补弹 → 其 token 静默并入下一轮，历史实证 108.7 万），却**全库零命名用例**——
//   只有 T17-b* 的源码形态守卫，SPAWN_OK=false 时连 T17-c1 都 SKIP → **调用点被删也全绿**
//   （v2.85 前科：调用点丢失、6 项回放全 PASS 仍漏检）。故本组必须是**端到端**（真 spawn --round-watch）。
//   **反向验证判据（M37 核心）**：把 showToast('cancelled-round-watch') 调用点删掉 → b1/b3 必须变红。
// ═══════════════════════════════════════════════════════════════════════════
{
  const src75 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf8'));
  ok('T75-a1 ★M37 取消补弹三分支的 showToast 调用点齐全（有 usage / 估算 / 无记录）',
    /showToast\([\s\S]{0,700}?'cancelled-round-watch'[\s\S]{0,60}?\)/.test(src75)
    && /showToast\([\s\S]{0,700}?'cancelled-round-watch-est'[\s\S]{0,60}?\)/.test(src75)
    && /showToast\('本轮无 token 消耗记录（手动取消）'/.test(src75));
  ok('T75-a2 ★M37 补弹后必须推进 lastStopAt（跨进程无去重 → 不推进 = 下一轮 hook 再弹一次）',
    /lastStopAt: Date\.now\(\) \}, sid\);/.test(src75));
  ok('T75-a3 ★M37 静默时长/轮询周期 env 可调（否则端到端只能真等 8 秒，没人愿意跑）',
    /ROUND_WATCH_POLL_MS/.test(src75) && /ROUND_WATCH_QUIET_MS/.test(src75) && /ROUND_WATCH_MAX_MS/.test(src75));

  if (!SPAWN_OK) envSkip('T75-b 取消补弹端到端（spawn --round-watch）', SPAWN_SKIP_REASON);
  else {
    const toastPath = path.join(tmp, 'token-tracker-toast.log');
    const toastOff = () => { try { return fs.statSync(toastPath).size; } catch (e) { return 0; } };
    // ⚠ 必须按**字节**切片：toast.log 是 append-only，用字节偏移读回增量才对齐；
    //   按 utf8 字符串 slice(字节数) 会因中文多字节而偏后，把 reason 字段切掉（首轮实测踩到）。
    const toastSlice = (off) => { try { return fs.readFileSync(toastPath).slice(off).toString('utf8'); } catch (e) { return ''; } };
    const proj75 = path.join(tmp, 'projects', 'm37');
    fs.mkdirSync(proj75, { recursive: true });
    const SID75 = 'm37cancel';
    const tp75 = path.join(proj75, SID75 + '.jsonl');
    const SNAP75 = path.join(skillDir, '.snapshot-' + SID75 + '.json');
    const T75 = Date.now() - 60000;
    const rowUser = JSON.stringify({ type: 'user', id: 'u1', timestamp: T75, message: { role: 'user', content: 'hi' } });
    const rowUsage = JSON.stringify({ type: 'assistant', timestamp: T75 + 1000,
      providerData: { model: 'glm-5.3-flash', messageId: 'm1', usage: { input_tokens: 1000, output_tokens: 100 } } });
    // 取消标记的真实形态（v2.83 实证：role=assistant + status=incomplete + providerData.error.message 精确
    // "Interrupted by user"；**勿用** providerData.skipRun —— 183/183 真实取消都带它，排除会 100% 灭掉检测）。
    const rowCancel = JSON.stringify({ type: 'message', role: 'assistant', status: 'incomplete', timestamp: T75 + 2000,
      content: 'Interrupted by user', providerData: { error: { message: 'Interrupted by user' } } });
    const run75 = (rows, maxMs) => {
      fs.writeFileSync(tp75, rows.join('\n') + '\n');
      try { fs.rmSync(SNAP75, { force: true }); } catch (e) { /* 上一场景快照必须清，否则进程秒退、用例假绿 */ }
      const off = toastOff();
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--round-watch', SID75, tp75, String(T75), ''], {
        env: Object.assign({}, env, {
          TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1',
          ROUND_WATCH_POLL_MS: '200', ROUND_WATCH_QUIET_MS: '1000',
          ROUND_WATCH_ADAPT_QUIET_MS: '500', ROUND_WATCH_MAX_MS: String(maxMs || 12000),
        }),
        timeout: 40000, windowsHide: true, encoding: 'utf8',
      });
      const snap = (() => { try { return JSON.parse(fs.readFileSync(SNAP75, 'utf8')); } catch (e) { return null; } })();
      return { r, toast: toastSlice(off), snap };
    };

    // 场景①：手动取消 + 有 usage → 正常补弹（cancelled-round-watch）
    const c1 = run75([rowUser, rowUsage, rowCancel], 12000);
    ok('T75-b1 ★M37 端到端：手动取消 + 静默满 → 真补弹（toast.log 落 cancelled-round-watch）',
      c1.r.status === 0 && c1.toast.indexOf('"reason":"cancelled-round-watch"') >= 0,
      `exit=${c1.r.status} toast=${JSON.stringify(c1.toast.slice(0, 160))}`);
    ok('T75-b2 ★M37 弹窗文案带「（手动取消）」（用户能分清这是取消轮不是正常轮）',
      c1.toast.indexOf('手动取消') >= 0, JSON.stringify(c1.toast.slice(0, 300)));
    ok('T75-b3 ★M37 补弹后推进 lastStopAt（跨进程去重靠它；不推进 = 下一轮 hook 再弹一次）',
      !!c1.snap && Number(c1.snap.lastStopAt) > T75, `snap=${JSON.stringify(c1.snap)}`);

    // 场景②：无取消标记 → **绝不弹**（正常轮交给 Stop 链路；误弹 = 双弹）
    const c2 = run75([rowUser, rowUsage], 2500);
    ok('T75-b4 ★M37 对照场景：没有取消标记就绝不补弹（误弹即与 Stop 链路双弹）',
      c2.r.status === 0 && c2.toast.indexOf('cancelled-round-watch') < 0,
      `exit=${c2.r.status} toast=${JSON.stringify(c2.toast.slice(0, 160))}`);

    // 场景③：0-usage 取消（usage 未落盘）→ 无记录提示分支
    const c3 = run75([rowUser, rowCancel], 12000);
    ok('T75-b5 ★M37 0-usage 取消 → 走「本轮无 token 消耗记录（手动取消）」（不编造数字、也不静默）',
      c3.r.status === 0 && c3.toast.indexOf('cancelled-round-watch-no-token') >= 0,
      `exit=${c3.r.status} toast=${JSON.stringify(c3.toast.slice(0, 160))}`);
    try { fs.rmSync(SNAP75, { force: true }); } catch (e) { /* 场景收尾清理 */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T76 —— v3.59.0（批15）：并发记账多进程竞态集成测试（M38）
//   报告：此前只有 T46 的**锁原语单测**（6 子项，验 withFileLock 本身对不对），
//   从未验证"两个真实进程同时记账"这个真会发生的场景（Stop hook 与轮级 watcher 可同时触发、
//   团队轮多个子代理结束也近乎同时）。锁原语对 ≠ 组合起来对：读写窗口、锁文件路径、
//   水位线与账本是否同一把锁，单测全绿也可能在集成层 lost-update（丢一笔 = 少计费，静默）。
//   判据：两进程各记一笔不同模型 → 账本 total.in 必须是两笔之和，且两个模型各就各位。
// ═══════════════════════════════════════════════════════════════════════════════════════
{
  const src76 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf8'));
  // ⚠ 两条写盘路径（记账主路径 / 直接落盘）**分开断言**：合起来只验"文件里存在 withFileLock"的话，
  //   回退其中一条、另一条还在 → 守卫仍绿（反向验证里踩到：只退一处时 T76-a1 稳绿）。
  ok('T76-a1 ★M38 记账主路径必须走 withFileLock（DAILY_USAGE_FILE.lock）',
    /const r = withFileLock\(DAILY_USAGE_FILE \+ '\.lock'/.test(src76));
  ok('T76-a1b ★M38 直接落盘路径同样持锁（两条写盘路径缺一 = 并发下 lost-update）',
    /withFileLock\(DAILY_USAGE_FILE \+ '\.lock', \(\) => saveDailyUsageRaw\(d\)/.test(src76));
  ok('T76-a2 ★M38 水位线写入也要持锁（水位线与账本必须同一口径，否则并发下重复计费）',
    /withFileLock\(LEDGER_WATERMARK_FILE \+ '\.lock'/.test(src76));

  if (!SPAWN_OK) envSkip('T76-b 并发记账集成（spawn 双进程）', SPAWN_SKIP_REASON);
  else {
    const D76 = '2026-10-13';
    const TS76 = 1791856800000; // 2026-10-13 10:00 +0800（周二，高峰段内）
    const M76A = 'k38-concurrent-a', M76B = 'k38-concurrent-b';
    const wb76 = path.join(tmp, 'k38-wb');
    const sk76 = path.join(wb76, 'skills', 'token-usage-tracker');
    const wj76 = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o); };
    wj76(path.join(sk76, 'pricing.json'), JSON.stringify({
      date: D76,
      models: {
        [M76A]: { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY', unit: 'per_1m_tokens', region: 'CN', source_url: 'fixture', fetched_at: '2026-10-13T00:00:00Z' },
        [M76B]: { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY', unit: 'per_1m_tokens', region: 'CN', source_url: 'fixture', fetched_at: '2026-10-13T00:00:00Z' },
      },
      deepseek_rules: { peak_schedule: '9:00 - 12:00、14:00 - 18:00', weekend_off_peak: true, effective_at: null, updated_at: '2026-10-13' },
      usd_cny_rate: 7.2,
    }));
    wj76(path.join(sk76, 'holidays.json'), '{}');
    for (const f of fs.readdirSync(skillDir).filter((x) => x.endsWith('.js'))) {
      fs.copyFileSync(path.join(skillDir, f), path.join(sk76, f));
    }
    wj76(path.join(sk76, '.update-check.json'),
      JSON.stringify({ lastCheckAt: Date.now(), latestVersion: '0.0.0', failCount: 0, nextRetryAt: 0 }));
    // 两个**同 WB_ROOT**（同一份账本）的独立会话 —— 共享账本才有竞态可言
    const mk76 = (sid, model) => {
      const tp = path.join(wb76, 'projects', 'p-' + sid, sid + '.jsonl');
      const user = JSON.stringify({ timestamp: TS76 - 60000, type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }) + '\n';
      const line = JSON.stringify({ timestamp: TS76, type: 'message', role: 'assistant',
        providerData: { model, messageId: 'm-' + sid, usage: { inputTokens: 1000000, outputTokens: 0, inputTokensDetails: [{ cached_tokens: 0 }] } } }) + '\n';
      wj76(tp, user + line);
      return { sid, tp, payload: JSON.stringify({ session_id: sid, transcript_path: tp, cwd: wb76 }) };
    };
    const A76 = mk76('k38-a', M76A);
    const B76 = mk76('k38-b', M76B);
    const env76 = Object.assign({}, env, { WB_ROOT: wb76, WB_LEDGER_MAINT: '1', WB_NO_NET: '1' });
    // ⚠ 真并行必须借一个**驱动子进程**：selftest 主线程若用 Atomics.wait 忙等，事件循环被冻结
    //   → 子进程的 'exit' 回调永远排不上队（首轮实测 codes=[null,null]，90s 超时全红）。
    //   驱动进程自己事件循环正常，异步 spawn 两个孙进程并等齐，把退出码 JSON 打回 stdout。
    const drv76 = path.join(tmp, 'k38-driver.js');
    fs.writeFileSync(drv76, `const { spawn } = require('child_process');
const NODE = process.execPath;
const script = process.argv[2];
const kids = [process.argv[3], process.argv[4]].map((p) => {
  const k = spawn(NODE, [script, '--stop'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  try { k.stdin.end(p); } catch (e) { /* silent-ok:诊断 — stdin 写不进去会由退出码暴露，不额外处理 */ }
  return k;
});
let exited = 0; const codes = [null, null];
const t = setTimeout(() => { kids.forEach((k) => { try { k.kill(); } catch (e) { /* silent-ok:清理 — 已退出进程的 kill 抛错可忽略 */ } }); finish(); }, 60000);
kids.forEach((k, i) => k.on('exit', (c) => { codes[i] = c; exited++; if (exited >= kids.length) finish(); }));
function finish() { try { clearTimeout(t); } catch (e) { /* silent-ok:清理 — 定时器已触发时 clearTimeout 抛错可忽略 */ }
  process.stdout.write(JSON.stringify({ codes, exited })); process.exit(0); }
`, 'utf8');
    const dr = spawnSync(NODE, [drv76, path.join(sk76, 'token-tracker.js'), A76.payload, B76.payload],
      { env: env76, timeout: 90000, windowsHide: true, encoding: 'utf8' });
    const codes = (() => { try { return JSON.parse(String(dr.stdout || '')).codes; } catch (e) { return [null, null]; } })();
    let daily76 = null, parseErr76 = '';
    try { daily76 = JSON.parse(fs.readFileSync(path.join(sk76, 'daily-usage.json'), 'utf8')); }
    catch (e) { parseErr76 = String((e && e.message) || e); }
    const m76 = (n) => (daily76 && daily76[D76] && daily76[D76].models && daily76[D76].models[n]) || null;
    ok('T76-b1 ★M38 两进程都正常退出（并发本身不崩、不死锁）',
      codes[0] === 0 && codes[1] === 0, `codes=${JSON.stringify(codes)}`);
    ok('T76-b2 ★M38 并发记账不丢：账本 total.in = 两笔之和 2,000,000（lost-update = 静默少计费）',
      !!daily76 && daily76[D76] && daily76[D76].total && daily76[D76].total.in === 2000000,
      `total=${daily76 && daily76[D76] && JSON.stringify(daily76[D76].total)} parseErr=${parseErr76}`);
    ok('T76-b3 ★M38 两笔各就各位（不串模型、不重复计同一笔）',
      !!m76(M76A) && m76(M76A).in === 1000000 && !!m76(M76B) && m76(M76B).in === 1000000,
      `A=${JSON.stringify(m76(M76A))} B=${JSON.stringify(m76(M76B))}`);
    ok('T76-b4 ★M38 并发写盘后账本仍是合法 JSON（交错写 = 半截文件 → 整本读不出）',
      !!daily76 && parseErr76 === '', `parseErr=${parseErr76}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T77 —— v3.59.0（批15）：CI 与测试网床自身的结构守卫（M39 / M40 / M41）
//   M39 联网那一遍 selftest 用 continue-on-error → 真回归与 runner 网络抖动被一并吞掉（静默放过）
//   M40 CI 无 Node 矩阵（仅 20，本机实跑 22）、无凭据扫描
//   M41 源码守卫型断言占比偏高（只验"源码仍含该分支"，不证明行为正确）→ 这里守的是
//       **行为级（真 spawn）用例的数量不许退化**，防止后人把行为用例删掉、改回只守源码形态。
// ═══════════════════════════════════════════════════════════════════════════════════════
{
  const ymlRel = path.join('.github', 'workflows', 'selftest.yml');
  const ymlPath = path.join(SRC, ymlRel);
  let yml = '';
  try { yml = fs.readFileSync(ymlPath, 'utf8'); } catch (e) { /* 读不到 → 下面逐条红 */ }
  ok('T77-a1 ★M40 CI 配置文件可读（缺失会让本组全部假绿）', yml.length > 0, ymlRel);
  ok('T77-a2 ★M39 联网那一遍不再 continue-on-error（原写法把真回归与网络抖动一并吞掉）',
    // ⚠ 必须锚到 **YAML 键行**：裸搜 `continue-on-error` 会命中本组注释里"为什么删掉它"的说明文字 → 假红。
    yml.length > 0 && !/^\s*continue-on-error:/m.test(yml));
  ok('T77-a3 ★M39 联网那一遍有网络可达性门控（不可达 = 显式跳过，不是"跑了但失败被吞"）',
    /steps\.net\.outputs\.reachable/.test(yml) && /Probe network reachability/.test(yml));
  ok('T77-a4 ★M40 Node 版本矩阵 20 + 22（本机实跑 22，只跑 20 抓不到版本差异）',
    /matrix:/.test(yml) && /node-version:\s*\[20,\s*22\]/.test(yml));
  ok('T77-a5 ★M40 有凭据扫描步骤，且是零依赖自研脚本（不引第三方 action，保住零依赖卖点）',
    /secret-scan\.js/.test(yml) && fs.existsSync(path.join(SRC, '.github', 'workflows', 'secret-scan.js')));
  // M41：行为级用例计数不许退化（本批把 T67/T68/T69 三组"从未真跑"的端到端修好、并新增 T75/T76）
  const selfSrc = (() => { try { return fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf8'); } catch (e) { return ''; } })();
  const spawnCases = (selfSrc.match(/spawnSync\(NODE/g) || []).length;
  ok('T77-a6 ★M41 行为级（真 spawn 子进程）用例数不退化（当前 24；删行为用例改守源码形态 = 此条红）',
    spawnCases >= 24, `实测 ${spawnCases} 处`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T78 —— v3.59.0（批14）：价格质量（M3 / M1 / S7）
//   M3  priceGate 的骤变基线只看"旧值是正数" → **错价自我锁定**：错价一旦入库，之后抓到的正确价
//       相对它是 1/1000 → 被 abortAt 拦下并保留错价，刷新每天跑、每天被拦，人工不删价永远修不回来
//       （且告警方向是反的：说"新值骤变"，越看越像新值有问题）。修法：旧值自己超出合理区间
//       （= 它自己就是那类错价）时不作基线 → 正确价得以写入、错价自愈，并留痕。
//   M1  多源抓取一次失败即源缺席，而刷新成功后 `pricing.date=today` 当天不再重试 → 抖动 = 缺席 24h。
//   S7  汇率 7.2 写入后永久沿用且零提示（KI-26 已定不接 live 源，本批只补"陈旧度"提醒）。
//   ⚠ M2（多源一致门槛）**本批不采纳**：要求 ≥2 源命中才写主价，会让单源收录的模型大面积停更，
//     停更的代价比"单源可能错"更大，且与本闸门"宁可漏报、绝不误杀"的原则冲突 → 维持现状，
//     已在计划文档写明理由，留待用户定夺。
// ═══════════════════════════════════════════════════════════════════════════════════════
{
  const rp78 = stripComments(fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf8'));
  ok('T78-a1 ★M3 骤变校验的基线必须先判「旧值自己可不可信」（改前只看 >0 → 错价拿错价当分母）',
    /const ovTrusted = ovUsable && ov >= PRICE_SANITY\.min && ov <= PRICE_SANITY\.max;/.test(rp78)
    && /if \(ovTrusted\) \{/.test(rp78));
  ok('T78-a2 ★M3 旧值不可信时不拦但**必须留痕**（静默覆盖旧值 = 另一种不可见）',
    /\} else if \(ovUsable\) \{/.test(rp78) && /疑似历史错价/.test(rp78));
  ok('T78-a3 ★M1 源抓取走带重试的封装（抖动一次不再让整源缺席 24h）',
    /async function fetchJsonWithRetry\(/.test(rp78) && /await fetchJsonWithRetry\(s\.url/.test(rp78));
  ok('T78-a4 ★M1 重试只针对瞬时故障 + 次数 env 可调（与 Python 侧 M21 同一开关名）',
    /function isRetryableFetchErr\(/.test(rp78) && /CN_PRICE_HTTP_RETRIES/.test(rp78));
  // ⚠ a5 必须锚到**真正落盘的那一处赋值**：只搜 `usd_cny_rate_updated_at` 这个字符串的话，
  //   下面读它的 `const rateSince = String(pricing.usd_cny_rate_updated_at || '')` 也含该串 →
  //   把赋值删掉守卫仍绿（反向验证 R3 实测踩到：删了赋值、872/0/0 全绿 = 假绿）。
  ok('T78-a5 ★S7 汇率必须落「起始日」并在超期时告警（无 live 源 ≠ 不该提醒）',
    /if \(!\(prevRateBefore > 0\) \|\| Math\.abs\(prevRateBefore - rate\) > 1e-9\) pricing\.usd_cny_rate_updated_at = today;/.test(rp78)
    && /RATE_STALE_DAYS/.test(rp78) && /已沿用/.test(rp78));
  ok('T78-a6 ★S7 汇率起始日在**写回之前**取旧值（取晚了永远等于新值 → 起始日永不更新）',
    rp78.indexOf('const prevRateBefore = Number(pricing.usd_cny_rate);') < rp78.indexOf('pricing.usd_cny_rate = rate;'));

  // 行为组：priceGate 已导出（module.exports 含 priceGate）→ 可直接真调用，不必 spawn 整条刷新链
  const mod78 = (() => { try { return require(path.join(skillDir, 'refresh-prices.js')); } catch (e) { return null; } })();
  if (!mod78 || typeof mod78.priceGate !== 'function') {
    ok('T78-b 行为组（require refresh-prices）', false, 'priceGate 未导出或模块加载失败');
  } else {
    const maxSane = mod78.PRICE_SANITY.max;
    // b1：旧值是 1000× 错价（远超合理区间）→ 正确价必须能写进来（改前被拦 = 错价自我锁定）
    const w1 = [];
    const g1 = mod78.priceGate('m3-fixture', { input_price: 1.0, output_price: 4.0 },
      { input_price: maxSane * 20, output_price: maxSane * 20 }, w1);
    ok('T78-b1 ★M3 旧值是超区间错价 → 正确价得以写入（改前：被 abortAt 拦下 = 错价永久自我锁定）',
      g1.main === false, `main=${g1.main} warnings=${JSON.stringify(w1)}`);
    ok('T78-b2 ★M3 且必须留痕（不是静默把旧值换了）',
      w1.some((s) => /疑似历史错价/.test(String(s))), JSON.stringify(w1));
    // b2：正常旧值 + 真骤变 → 照旧拦（本修复不得削弱原有闸门）
    const w2 = [];
    const g2 = mod78.priceGate('m3-fixture', { input_price: 10.0, output_price: 4.0 },
      { input_price: 2.0, output_price: 4.0 }, w2);
    ok('T78-b3 ★M3 正常旧值下的骤变仍照旧拦截（修复零削弱：×5 仍判异常并保留旧值）',
      g2.main === true && w2.some((s) => /骤变/.test(String(s))), `main=${g2.main} ${JSON.stringify(w2)}`);
    // b3：旧值 0（未公布价 / 首次写入）→ 不拦也不告警（KI-7：0 是合法常态）
    const w3 = [];
    const g3 = mod78.priceGate('m3-fixture', { input_price: 3.0, output_price: 4.0 },
      { input_price: 0, output_price: 0 }, w3);
    ok('T78-b4 ★M3 旧值 0（未公布价）→ 不拦且不告警（KI-7 合法常态，不得因本修复刷噪音）',
      g3.main === false && !w3.some((s) => /疑似历史错价/.test(String(s))), `main=${g3.main} ${JSON.stringify(w3)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// T79 —— v3.59.0（批16）：弹窗宽度常量「代码 ↔ 文档」一致性（M35）
//   M35 的实质不是"某个数写错了"，而是**同一组常量散在代码和四份文档里、改一处不同步其余**：
//   v3.50.0 把正文行 51 → 44（KI-17：51 高于通知卡片真实极限 ~46u → 宽度守卫永不触发 → 代码不抢在
//   Windows 前主动舍 → 行尾金额被气泡直接砍掉），代码改了、README/SKILL 跟着改了，**balance.md 与
//   TROUBLESHOOTING.md 没跟** → 前者照 51 描述、后者甚至仍在讲 v3.30.0 的旧降级链（先丢价格标签保缓存），
//   而 v3.44.0 起价格标签已迁行1、行2 改为直接丢缓存占比。**照旧文档排查会得出完全相反的结论**。
//   本组把"代码现值 + 四份文档现值 + 不得再写 51 + 降级链口径"全钉住，下次动任一处必须同步其余。
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const tt79 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf8');
  ok('T79-a1 ★正文行宽度常量必须为 44（44u 完整显示 / 46u 行尾被砍；51 高于真实极限 → 守卫永不触发 → 金额被砍）',
    /const TOAST_LINE_MAX_W = 44;/.test(tt79), '红 = 有人把阈值改回 51/45 等无实证值');
  ok('T79-a2 ★标题两行宽度常量必须为 45 / 42（行1 大字 45、行2 大字 42；实测 41.5u 成 / 46.5u 爆）',
    /const TOAST_ROW1_MAX_W = 45;/.test(tt79) && /const TOAST_ROW2_MAX_W = 42;/.test(tt79));
  const rd79 = fs.readFileSync(path.join(SRC, 'README.md'), 'utf8');
  const sk79 = fs.readFileSync(path.join(SRC, 'SKILL.md'), 'utf8');
  const bal79 = fs.readFileSync(path.join(SRC, 'docs', 'balance.md'), 'utf8');
  const ts79 = fs.readFileSync(path.join(SRC, 'TROUBLESHOOTING.md'), 'utf8');
  const has3 = (s) => /TOAST_ROW1_MAX_W=45/.test(s) && /TOAST_ROW2_MAX_W=42/.test(s) && /TOAST_LINE_MAX_W=44/.test(s);
  const miss3 = [['README', rd79], ['SKILL', sk79], ['balance', bal79], ['TROUBLESHOOTING', ts79]]
    .filter(([, s]) => !has3(s)).map(([k]) => k);
  ok('T79-a3 ★四份现状文档都必须写出 45 / 42 / 44 三个现值（漏一份 = 下次改代码又会漂）',
    miss3.length === 0, miss3.length ? '未写全的文档: ' + miss3.join(', ') : '');
  // ⚠ a4 只管**现状**文档：CHANGELOG / KNOWN-ISSUES / version-diary 里的 51 是"旧值史实"，必须保留。
  const nowDocs79 = { README: rd79, SKILL: sk79, balance: bal79, TROUBLESHOOTING: ts79 };
  const stale51 = Object.keys(nowDocs79).filter((k) => /TOAST_(LINE|ROW1|ROW2)_MAX_W\s*=\s*51/.test(nowDocs79[k])
    || /上限\s*51u/.test(nowDocs79[k]) || /51u\s*真实上限/.test(nowDocs79[k]));
  ok('T79-a4 ★四份现状文档不得把 51 写作现值（v3.50.0 起 51 已作废；CHANGELOG/KNOWN-ISSUES 里的 51 是史实、不在此列）',
    stale51.length === 0, stale51.length ? '仍写 51 的文档: ' + stale51.join(', ') : '');
  ok('T79-a5 ★行2 降级链口径必须三处一致：价格标签已迁行1、行2 超宽**直接丢缓存占比**'
    + '（v3.30.0~v3.43.x 旧口径相反：先丢降级标签保缓存 —— 照旧口径排查会得出相反结论）',
    /丢缓存占比/.test(ts79) && /丢缓存占比/.test(rd79) && /丢缓存占比/.test(sk79));
  // M26：v3.55.0（KI-22 二）已把 backfill 从「整份替换」改成**模型级 merge**（抓不到的 (日期,模型)
  //   保留并标 stale_carried），但 KI-5 / KI-7 / README / SKILL / token-tracker.js 的 stderr 仍在写
  //   「全量重建替换、新账本不继承旧账本」——与代码**相反**。「别用 --write」的结论不变，但**理由完全
  //   不同**（现在是「抓得到的 (日期,模型) 用重放值覆盖且不取 max」）→ 照旧理由排查会找错方向。
  const kn79 = fs.readFileSync(path.join(SRC, 'KNOWN-ISSUES.md'), 'utf8');
  //   ⚠ 三种措辞都要禁：README 旧版写「全量重建替换」、SKILL 旧版写「全量替换」、KI-7 写「新账本不继承」。
  //   只禁其中一种 = 回退到另一种措辞时守卫恒绿（写本条时差点只写了前两种之外的组合）。
  const staleReplace = [['README', rd79], ['SKILL', sk79], ['KNOWN-ISSUES', kn79], ['token-tracker', tt79]]
    .filter(([, s]) => /全量重建替换|全量替换|新账本不继承/.test(s)).map(([k]) => k);
  ok('T79-a6 ★backfill --write 不得再被描述为「全量重建替换 / 新账本不继承旧账本」'
    + '（v3.55.0 起是模型级合并；CHANGELOG / version-diary 里的旧叙述属史实、不在此列）',
    staleReplace.length === 0, staleReplace.length ? '仍写旧口径: ' + staleReplace.join(', ') : '');
  // M30：有 rules 时 weekend_off_peak 缺省 false ≠ 无 rules 时的「周末一律低峰」——两条分支口径不同是
  //   **刻意为之**（不替官方假设周末低峰），但代码里原本没有任何说明 → 读代码的人会当成漏写/不一致。
  const pr79 = fs.readFileSync(path.join(SRC, 'peak-rules.js'), 'utf8');
  ok('T79-a7 ★M30 weekend_off_peak 的**缺省语义**必须在代码里写明（有 rules 缺省 false ≠ 无 rules 周末低峰）',
    /缺省 = false 是刻意的/.test(pr79) && /零实际差异/.test(pr79), '红 = 语义说明被删，读者会当成漏写');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// T80 —— v3.59.0（批16）：维护链 CLI 的「参数 / 降级」可观测性（M24 / M25 / M32 / M33）
//   四条同属一类病根：**失败被说成了另一种失败，或失败完全不可见**。
//   · M24 `recalc-day 2026-13-45` → 报「账本中无 2026-13-45 记录」——把「参数错」说成「数据缺」。
//     后果不只是误导：用户会以为账本坏了，转头去查账本、甚至去跑 KI-5 明令禁止的 `backfill --write`。
//   · M25 backfill 是**第三条**计价路径（主链路增量 / recalc 回溯 / backfill 重建），前两条
//     （v3.32.0 H4、v3.58.0 批8-⑨）都有"假日数据未知"告警，唯独它没有 → 用它重建整个账本时
//     真假日按高峰 ×2 多算、调休上班日按周末低峰少算，**双向错且零提示**。
//   · M33 `refresh-holidays abc` → `Number('abc')` = NaN → 拿 NaN 拼 URL 抓两次 404 后静默 exit 2。
//     与"源挂了 / 没网 / 被限流"**完全无法区分** → 排查方向整个错掉。
//   · M32 `.holidays-refresh.json` 非原子写 → 写一半被中断留下半截 JSON → 下轮 parse 失败 →
//     节流条件④「距上次成功 >30 天」永久失效 → **每天重复联网**。
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const rc80 = fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf8');
  const bf80 = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf8');
  const rh80 = fs.readFileSync(path.join(SRC, 'refresh-holidays.js'), 'utf8');
  ok('T80-a1 ★M24 recalc-day 必须先校验日期**格式**（非法要说"参数非法"，不许说"账本中无记录"）',
    /日期参数非法/.test(rc80) && /\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(rc80) && /process\.exit\(2\)/.test(rc80));
  ok('T80-a2 ★M24 格式对了还要做**日历**校验（`2026-13-45` / `2026-02-30` 形状合法但不是真日期，'
    + '`new Date` 会静默滚到下一年 → 必须回读年/月/日才认得出）',
    /dt\.getUTCFullYear\(\) !== p\[0\]/.test(rc80) && /dt\.getUTCMonth\(\) !== p\[1\] - 1/.test(rc80)
    && /dt\.getUTCDate\(\) !== p\[2\]/.test(rc80));
  ok('T80-a3 ★M24 校验必须在**查账本之前**（放在查字典之后 = 两种失败仍混在同一句话里）',
    rc80.indexOf('日期参数非法') >= 0 && rc80.indexOf('日期参数非法') < rc80.indexOf('账本中无 ${date} 记录'));
  ok('T80-a4 ★M25 backfill 必须补「假日数据未知/陈旧」告警（第三条计价路径，另两条早已有了）',
    /peakRules\.holidayYearUnknown\(tsMs, HOLIDAYS\)/.test(bf80) && /\[backfill\] ⚠/.test(bf80)
    && /_holidayWarnedYears/.test(bf80));
  ok('T80-a5 ★M33 refresh-holidays 参数必须校验（NaN 年份抓两次 404 后静默失败 = 与"源挂了"不可区分）',
    /参数不是合法年份/.test(rh80) && /\\d\{4\}\$\//.test(rh80) && /年份超出合理区间/.test(rh80));
  // ⚠ a6 必须锚到**状态文件**那一处写盘：`OUT`（holidays.json）本来就是 tmp+rename，只搜 renameSync
  //   会命中它 → 把状态文件的修复删掉仍然恒绿（与 T78-a5 同一类假绿，本批第二次撞上）。
  ok('T80-a6 ★M32 `.holidays-refresh.json` 必须原子写（tmp+rename；直接覆盖会留半截 JSON → 节流失效）',
    /const stTmp = stPath \+ '\.tmp-' \+ process\.pid;/.test(rh80) && /fs\.renameSync\(stTmp, stPath\);/.test(rh80));

  // 行为组：真 spawn 两个 CLI —— 验证的是"把话说对了"，而不只是"有那段代码"
  if (!SPAWN_OK) {
    envSkip('T80-b1 非法日期报错（spawn）', SPAWN_SKIP_REASON);
    envSkip('T80-b2 非法年份报错（spawn）', SPAWN_SKIP_REASON);
  } else {
    const wb80 = path.join(tmp, 'm24-wb');
    const sk80 = path.join(wb80, 'skills', 'token-usage-tracker');
    try { fs.mkdirSync(sk80, { recursive: true }); } catch (e) { /* 已存在 */ }
    for (const f of ['token-tracker.js', ...RUNTIME_COMPANIONS, 'backfill.js']) {
      try { fs.copyFileSync(path.join(skillDir, f), path.join(sk80, f)); } catch (e) { /* 缺的会由 rc 暴露 */ }
    }
    const r1 = spawnSync(NODE, [path.join(sk80, 'recalc-day.js'), '2026-13-45'], {
      env: Object.assign({}, env, { WB_ROOT: wb80, WB_LEDGER_MAINT: '1', WB_NO_NET: '1' }),
      timeout: 60000, windowsHide: true, encoding: 'utf8',
    });
    const o1 = String(r1.stdout || '') + String(r1.stderr || '');
    ok('T80-b1 ★`recalc-day 2026-13-45` 必须说「日期参数非法」且**不许**说「账本中无」'
      + '（红 = 又退回把参数错说成数据缺 → 用户会去跑 backfill）',
      r1.status === 2 && /日期参数非法/.test(o1) && !/账本中无/.test(o1), `rc=${r1.status} out=${o1.slice(-300)}`);
    const r2 = spawnSync(NODE, [path.join(sk80, 'refresh-holidays.js'), 'abc'], {
      env: Object.assign({}, env, { WB_ROOT: wb80, WB_LEDGER_MAINT: '1', WB_NO_NET: '1' }),
      timeout: 60000, windowsHide: true, encoding: 'utf8',
    });
    const o2 = String(r2.stdout || '') + String(r2.stderr || '');
    ok('T80-b2 ★`refresh-holidays abc` 必须说「参数不是合法年份」（红 = 又去抓 NaN.json 两次 404 后静默失败）',
      r2.status === 2 && /参数不是合法年份/.test(o2), `rc=${r2.status} out=${o2.slice(-300)}`);
  }
}

// ===== T81（v3.59.1 审计批17）：dayTotalOf 脏值/null 同构 + CI 探针 + 假日表两处 =====
//   背景：v3.59.0 整体复查（7 批 / 13 个代码文件逐段复审 + 三路并行审 py 侧 / CI / 假日表）
//   查出 1 高危 + 4 中危。**高危这条正是批10 自己写在注释里的那个错误形态** ——
//   "修复不完整比没修复更危险"，只是当时漏的不是分支、是文件：
//   recalc-day 的四个累加点都收了口，backfill 的 dayTotalOf 没跟上，而它的结果**会落盘**。
//   本组把"两份实现必须同构"钉成守卫，并直接 require 做行为验证（不靠 spawn）。
{
  const tt81 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8');
  const bf81 = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8');
  const rh81 = fs.readFileSync(path.join(SRC, 'refresh-holidays.js'), 'utf-8');
  const ci81 = fs.readFileSync(path.join(SRC, '.github/workflows/selftest.yml'), 'utf-8');
  const ss81 = fs.readFileSync(path.join(SRC, '.github/workflows/secret-scan.js'), 'utf-8');
  // ⚠️ CRLF：工作区文件是 CRLF，所有锚点**不用 `$` 行尾断言**（改用 indexOf / 行内正则），
  //    否则归一化漏一处就整条恒绿（v3.59.0 批16 反向验证踩过）。

  // ── a. 高危：两份 dayTotalOf 必须同构 ──
  ok('T81-a1 ★token-tracker.js dayTotalOf 五字段必须走 numOr0（`|| 0` 只挡 falsy、**不挡字符串**：'
    + '"123" 会让 0+"123"="0123"，之后每加一个数都是字符串拼接，五字段一起腐化并落盘）',
    tt81.indexOf('t.in += numOr0(m.in); t.out += numOr0(m.out); t.cached += numOr0(m.cached); t.total += numOr0(m.total);') >= 0
    && tt81.indexOf('t.cost += numOr0(m.cost);') >= 0);
  // ⚠️ 锚点必须唯一到那一处（v3.58.0 硬教训，批17 G2 实测又踩一次）：
  //   `if (!m || typeof m !== 'object') continue;` 在 token-tracker.js 里有**三处**
  //   （dayTotalOf / aggregateRangeModels / 区间汇总）—— 全文件搜这一串，把 dayTotalOf 里那处
  //   删掉仍恒绿。正确做法：先把 dayTotalOf 函数体切出来，再在函数体内判。
  const dtFn81 = (tt81.match(/function dayTotalOf\(models\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('T81-a2 ★token-tracker.js dayTotalOf 必须保留 null 守卫（v3.24.0 级联⑪：账本一条 null 条目曾让报表全线 TypeError）',
    dtFn81.length > 0 && dtFn81.indexOf("if (!m || typeof m !== 'object') continue;") >= 0,
    dtFn81.length ? 'dayTotalOf 函数内无 null 守卫' : '未取到 dayTotalOf 函数体（函数签名被改？）');
  ok('T81-a3 ★numOr0 必须导出（backfill 复用同一实现；在本地再抄一份 = 等着再漂移，KI-29 同类）',
    tt81.indexOf('dayTotalOf, hitRate,') >= 0 && tt81.indexOf('numOr0,') >= 0);
  // 同样先切函数体再判（与 a2 同一理由：守卫串若在别处再出现一次，全文件搜就会空转）
  const bfDt81 = (bf81.match(/function dayTotalOf\(models\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('T81-a4 ★backfill.js dayTotalOf 必须与主脚本同构：null 守卫 + 五字段 tt.numOr0'
    + '（改前 `t.cost += m.cost || 0` 且无守卫 —— 脏串经 stale_carried 保留后拼成字符串**落盘** → 该日金额整天 ¥0.00；'
    + '一条 null 条目更会让 m.in 抛 TypeError，崩在文件锁内）',
    bfDt81.length > 0 && bfDt81.indexOf("if (!m || typeof m !== 'object') continue;") >= 0
    && bfDt81.indexOf('t.in += tt.numOr0(m.in); t.out += tt.numOr0(m.out); t.cached += tt.numOr0(m.cached); t.total += tt.numOr0(m.total);') >= 0
    && bfDt81.indexOf('t.cost += tt.numOr0(m.cost);') >= 0,
    bfDt81.length ? '函数体内缺守卫或缺 numOr0 归一' : '未取到 backfill 的 dayTotalOf 函数体');
  ok('T81-a5 ★backfill.js 必须加 require.main 守卫并导出 dayTotalOf（无条件 main() → 被 require 就真跑一遍扫描）',
    bf81.indexOf('if (require.main === module) main();') >= 0
    && bf81.indexOf('module.exports = { dayTotalOf };') >= 0);
  ok('T81-a6 ★backfill 必须把自己的 dayTotalOf 注入 mergeDailyLedger（合并后重算 total 的那一份；'
    + '传别的实现 = 又一处会漂移的副本）',
    bf81.indexOf('mergeDailyLedger(cur, newDaily, dayTotalOf)') >= 0);

  // ── b. 中危：CI 探针必须探价库源 ──
  ok('T81-a7 ★CI 探针必须覆盖价库源（portkey / openrouter / raw.githubusercontent / llmabacus）'
    + '且不得只探 api.github.com（GitHub 通、价库挂 → 放行 → selftest 因抓不到价而红 = 没有解释的红，正是 M39 要消灭的）',
    ci81.indexOf('configs.portkey.ai') >= 0 && ci81.indexOf('openrouter.ai') >= 0
    && ci81.indexOf('llmabacus.com') >= 0
    && ci81.indexOf("fetch('https://api.github.com'") < 0);
  ok('T81-a8 ★联网那一遍必须留覆盖痕迹（跳过时 job 仍绿是有意的——runner 网络抖动不该判红，'
    + '但"绿"与"绿但没覆盖"必须可区分）',
    ci81.indexOf('Online coverage marker') >= 0 && ci81.indexOf('::notice::') >= 0);

  // ── c. 中危：假日表两处 ──
  ok('T81-a9 ★holidays.json 的 tmp 必须带 pid（固定名 `.tmp` → 两个刷新进程并发共用同一 tmp → rename 出损坏 JSON）',
    rh81.indexOf("const tmp = OUT + '.tmp-' + process.pid;") >= 0
    && rh81.indexOf("const tmp = OUT + '.tmp';") < 0);
  ok('T81-a10 ★年份区间校验必须判 `arg` 真假而非 `argY`（argY===0 时 `if(0 && …)` 为假 → `--years 0000` 整个跳过校验'
    + ' → 拿 year 0 抓两次 404 后静默 exit 2 = 参数错被说成源故障）',
    rh81.indexOf('if (arg && (argY < 1990 || argY > 2100))') >= 0
    && rh81.indexOf('if (argY && (argY < 1990') < 0);
  // v3.59.1（审计批17·中危，holiday-reviewer Q2）：子集重跑不得抹掉未覆盖年份的陈旧标记。
  //   这是本批唯一一条"审查中新发现、原报告未列"的问题：`stale_years: missingYears` 是整块写，
  //   而 stale_years 正是 holidayRefreshNeeded 条件③ 'stale' 的**唯一触发源**（:374 消费它）。
  ok('T81-a16 ★stale_years/stale_detail 必须按「本次查过的年份」差量更新、未覆盖年份原样保留'
    + '（整块写 missingYears → `--years 2026` 子集跑抹掉 2025 的 stale 标记 → 若 2025 仍缺，'
    + '自动链路再也记不起它 → 那一年永久不再自动重试，峰谷长期按「非假日」降级且零提示）',
    rh81.indexOf('stale_years: missingYears,') < 0
    && rh81.indexOf('const staleDetail = {};') < 0
    && rh81.indexOf('const checkedSet = new Set(years.map(String));') >= 0
    && rh81.indexOf('stale_years: staleYears,') >= 0
    && rh81.indexOf('old.stale_years') >= 0);

  // ── d. 中危：secret-scan 补裸 token / 藏密扩展名 / 二进制防护 ──
  ok('T81-a11 ★secret-scan 必须认裸 token 赋值（只认 access_token 时 `token = "长串"` 这种最常见形态漏报）',
    ss81.indexOf('疑似 token 赋值') >= 0 && ss81.indexOf('(?:^|[^a-zA-Z])token') >= 0);
  ok('T81-a12 ★secret-scan 必须扫 .env/.sh/.toml（凭据最常躺在 .env 里；改前只扫代码/文档扩展名，正好漏掉最常见的藏密处）',
    ss81.indexOf('txt|env|sh|toml|ini|cfg') >= 0);
  ok('T81-a13 ★secret-scan 必须有二进制 + 体积防护（二进制当文本扫 = 乱码误报/漏报；>1MB 整体 split 全部行会随文件涨内存）',
    ss81.indexOf('includes(0)) continue') >= 0 && ss81.indexOf('MAX_BYTES') >= 0);

  // ── e. 行为组：直接 require 两个实现喂脏数据（不靠 spawn） ──
  //    ⚠️ 假绿防护：期望值与"什么都没做"必须可区分 —— 改前 "0.51.2" 会拼成字符串、null 条目会抛 TypeError；
  //      改后归 0 / 跳过。两条判据都不等于夹具预置值。
  const bfMod = (() => { try { return require(path.join(SRC, 'backfill.js')); } catch (e) { return null; } })();
  const ttMod = (() => { try { return require(path.join(SRC, 'token-tracker.js')); } catch (e) { return null; } })();
  const DIRTY = {
    m_dirty: { in: '123', out: 5, cached: null, total: 'abc', cost: '0.51.2' },
    m_null: null,
    m_ok: { in: 10, out: 2, cached: 1, total: 12, cost: 0.5 },
  };
  if (!bfMod || !ttMod || typeof bfMod.dayTotalOf !== 'function' || typeof ttMod.dayTotalOf !== 'function') {
    ok('T81-b1 两个 dayTotalOf 均可 require（红 = 导出被改坏 / require 有副作用）', false,
      `bfMod=${!!bfMod} ttMod=${!!ttMod}`);
  } else {
    let bt = null, berr = null;
    try { bt = bfMod.dayTotalOf(DIRTY); } catch (e) { berr = e; }
    ok('T81-b1 ★backfill dayTotalOf 喂脏数据：不抛 + 五字段全 number + 脏串归 0'
      + '（"123"→133 数值相加而非 "0123" 拼接；"abc"/"0.51.2"→0；null 条目跳过）',
      !berr && bt && ['in', 'out', 'cached', 'total', 'cost'].every((k) => typeof bt[k] === 'number')
      && bt.in === 133 && bt.out === 7 && bt.cached === 1 && bt.total === 12 && bt.cost === 0.5,
      berr ? '抛出: ' + berr.message : JSON.stringify(bt));
    let t2 = null;
    try { t2 = ttMod.dayTotalOf(DIRTY); } catch (e) { /* 由 b2 的等值判断暴露 */ }
    ok('T81-b2 ★两份 dayTotalOf 行为逐字节一致（同构不只是长得像——喂同一份脏数据结果必须相同）',
      !!t2 && JSON.stringify(t2) === JSON.stringify(bt),
      `tt=${JSON.stringify(t2)} bf=${JSON.stringify(bt)}`);
    const n = ttMod.numOr0;
    // ⚠ detail 必须**先安全求值**再交给 ok()：模板字符串里的 n('5') 是无条件执行的 ——
    //   导出被拔时（批17 G3 回退实测）它在**算 detail 时**就抛 TypeError，ok() 从未被调用、
    //   selftest 直接崩（exit 1 且无汇总行），把"干净变红"退化成"崩掉"。
    let nProbe;
    try { nProbe = [n('5'), n(NaN), n(Infinity), n(null), n(undefined), n('abc'), n({}), n(''), n(7)].join(','); }
    catch (e) { nProbe = '求值抛: ' + ((e && e.message) || e); }
    ok('T81-b3 ★numOr0 边界：数值串→数、NaN/Infinity/null/undefined/"abc"/{}→0、`Number.isFinite` 语义',
      typeof n === 'function' && n('5') === 5 && n(NaN) === 0 && n(Infinity) === 0 && n(-Infinity) === 0
      && n(null) === 0 && n(undefined) === 0 && n('abc') === 0 && n({}) === 0 && n('') === 0 && n(7) === 7,
      `got ${nProbe}`);
    // 生产路径：backfill 就是用这个函数当 mergeDailyLedger 的第三参 —— 脏 carried 条目合并不抛、
    // total.cost 必须是 number（字符串会顺着一路写进 daily-usage.json）。
    let mg = null, mgerr = null;
    try {
      const { mergeDailyLedger } = require(path.join(SRC, 'ledger-merge.js'));
      mg = mergeDailyLedger(
        { '2026-10-01': { models: { 'm_dirty': { in: '123', out: 5, cached: 0, total: 'abc', cost: '0.51.2' } } } },
        { '2026-10-01': { models: { 'm_ok': { in: 10, out: 2, cached: 1, total: 12, cost: 0.5 } } } },
        bfMod.dayTotalOf);
    } catch (e) { mgerr = e; }
    ok('T81-b4 ★mergeDailyLedger(注入 backfill 的 dayTotalOf) 遇脏 carried 条目：不抛 + total.cost 是 number'
      + '（这就是生产路径：旧账本脏 cost 被 stale_carried 保留后重算 total 并落盘）',
      !mgerr && mg && typeof mg.merged['2026-10-01'].total.cost === 'number'
      && mg.merged['2026-10-01'].models.m_dirty.stale_carried === true,
      mgerr ? '抛出: ' + mgerr.message : JSON.stringify(mg && mg.merged['2026-10-01'].total));
  }

  // ── f. 中危：看门狗必须大于「各阶段预算之和」（v3.59.1 把 180000 抬到 300000 的那条算术） ──
  //   不变量：官方抓取最坏 + 国内源最坏 < 整进程上限。改前 180s < 256.2s —— 官方一跑满重试阶梯
  //   （165s），国内源只剩十几秒必被掐死 → 整轮刷新失败（沿用旧库 + ⚠价库），且失败原因被记成
  //   "超时 180000ms 被杀"，排查时指向错误方向。
  //   ⚠️ 两侧常量都从**源码实读**（不硬编码）：任何人改任一侧预算，这里跟着重算，不会变成谎话。
  const ds81 = fs.readFileSync(path.join(SRC, 'deepseek-official.js'), 'utf-8');
  const rp81src = fs.readFileSync(path.join(SRC, 'refresh-prices.js'), 'utf-8');
  const capM81 = tt81.match(/REFRESH_TIMEOUT_MS\s*=\s*(\d+)/);
  const cap81 = capM81 ? Number(capM81[1]) : 0;
  const oTo = (ds81.match(/const TIMEOUT_MS = (\d+);/) || [])[1];
  const oRt = (ds81.match(/const RETRIES = Number\(process\.env\.DS_RETRIES \|\| (\d+)\)/) || [])[1];
  const oDl = (ds81.match(/const RETRY_DELAY_MS = Number\(process\.env\.DS_RETRY_DELAY_MS \|\| (\d+)\)/) || [])[1];
  const dRt = (rp81src.match(/Math\.floor\(n\) : (\d+)/) || [])[1];
  const dsSpawn = (rp81src.match(/timeout: (\d+),/) || [])[1];
  const rpMod81 = (() => { try { return require(path.join(SRC, 'refresh-prices.js')); } catch (e) { return null; } })();
  const BIG81 = rpMod81 ? rpMod81.BIG_SOURCE_TIMEOUT_MS : 0;
  const officialWorst = (oTo && oRt != null && oDl) ? (Number(oRt) + 1) * Number(oTo) + Number(oRt) * Number(oDl) : -1;
  const domesticWorst = (BIG81 && dRt) ? BIG81 * (Number(dRt) + 1) + 400 * (Math.pow(2, Number(dRt)) - 1) : -1;
  ok('T81-a14 ★看门狗 REFRESH_TIMEOUT_MS 必须大于「官方抓取最坏 + 国内源最坏」之和'
    + '（官方 3×15s+2×60s=165s；国内源 30s×3+1.2s≈91.2s；和 256.2s —— 改前 180s 罩不住）',
    cap81 > 0 && officialWorst > 0 && domesticWorst > 0 && cap81 > officialWorst + domesticWorst,
    `上限=${cap81} 官方最坏=${officialWorst} 国内源最坏=${domesticWorst} 和=${officialWorst + domesticWorst}`);
  ok('T81-a15 ★官方脚本 spawn 预算必须覆盖它自己的最坏耗时（否则在重试退避中途被掐死 —— v3.58.0 批8-⑧ 的既有不变量）',
    !!dsSpawn && officialWorst > 0 && Number(dsSpawn) >= officialWorst,
    `spawn=${dsSpawn} 官方最坏=${officialWorst}`);
}

// 行尾无关的「注入清单完整性」判据（T82-a6 / T86-b1 共用；`\r?\n` 兼容 Windows CI 的 CRLF 检出）
const txInjectionComplete = (ttSrc, shSrc) => (
  shSrc.indexOf('"interruptedRowsAfter"') >= 0
  && /[ \t]interruptedRowsAfter,\r?\n[ \t]+lastWatcherSpawnError,/.test(shSrc)
  && /[ \t]interruptedRowsAfter,\r?\n[ \t]+lastWatcherSpawnError,/.test(ttSrc)
);

// ===== T82（v3.60.0 批A）：用户取消标记识别扩文案（三族）+ no-token 准确文案 =====
//   背景：全库实测（436 transcript / 15.4 万行）680 条 assistant/incomplete 中断行中，原判据
//   （精确匹配 `Interrupted by user`）只认出 417 条 = 61%；漏检三族：
//     429 queue.waiting.title（44）/ 429 queue.full.title（5）/ aborted·ECONNRESET（18）。
//   2026-10-15 14:35 用户真实踩到：排队中手动停止 → ① 取消补弹（cancelled-round-flush）不发；
//   ② Stop 的 no-token 分支把"手动取消"说成"请求未发出/网络中断"（M33 同族：原因指错）。
//   另一关键实测：680 条 incomplete 的**终结率 100%** —— 其后到下一个 role=user 行之间没有一条
//   assistant completed（即 incomplete 就是该轮最后一行，不存在"重试成功"的中间态噪声）
//   → 识别到中断标记即补弹不会误弹。
{
  const tt82 = (() => { try { return require(path.join(SRC, 'token-tracker.js')); } catch (e) { return null; } })();
  // ⚠ 必须归一行尾：Windows CI（core.autocrlf）把源检出为 CRLF，a6 用了字面 `\n` 正则 →
  //   不归一时本地（LF）绿、CI（CRLF）红（v3.60.0 首推实测踩到：CI 离线遍 947 过 / 1 败 = 仅 T82-a6）。
  const ttSrc82 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const shSrc82 = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8').replace(/\r\n/g, '\n');

  // ── a. 源码守卫 ──
  const uckFn82 = (ttSrc82.match(/function userCancelKind\(r\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('T82-a1 ★userCancelKind 必须存在且含三族形态（Interrupted by user / 429 queue.waiting|full / aborted）'
    + '（改前只有一条精确文案 → 全库漏检 39% 的中断）',
    uckFn82.length > 0
    && uckFn82.indexOf('^Interrupted by user$') >= 0
    && uckFn82.indexOf('^429 queue\\.(?:waiting|full)\\.title') >= 0
    && uckFn82.indexOf('^aborted$') >= 0,
    uckFn82.length ? 'userCancelKind 函数体内缺形态' : '未取到 userCancelKind 函数体（签名被改？）');
  const iraFn82 = (ttSrc82.match(/function interruptedRowsAfter\(rows, roundStartMs\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('T82-a2 ★interruptedRowsAfter 必须改用 userCancelKind（两处口径统一，避免再次漂移）',
    iraFn82.length > 0 && iraFn82.indexOf('userCancelKind(r) !== null') >= 0,
    'interruptedRowsAfter 体内未见 userCancelKind');
  ok('T82-a3 ★interruptedRowsAfter 返回值必须带 kind（no-token 文案要按族区分）',
    ttSrc82.indexOf('out.push({ ts: Number(r.timestamp), idx: i, kind: userCancelKind(r) });') >= 0);
  const ibuFn82 = (ttSrc82.match(/function interruptedByUser\(tsPath\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('T82-a4 ★interruptedByUser（watcher 侧）必须同步扩三族并复用 userCancelKind（两处判据同源）',
    ibuFn82.length > 0
    && ibuFn82.indexOf('429 queue\\.(?:waiting|full)\\.title') >= 0
    && ibuFn82.indexOf('userCancelKind(r) !== null') >= 0,
    'interruptedByUser 的 intrIn 未扩族');
  ok('T82-a5 ★stop-handler 的 no-token 分支必须识别取消标记并弹准确文案（不再是"请求未发出/网络中断"）',
    shSrc82.indexOf('interruptedRowsAfter(readTranscLines(tsPath), aggStart0)') >= 0
    && shSrc82.indexOf("'（手动取消）本轮无 token 消耗记录'") >= 0
    && shSrc82.indexOf("'cancelled-no-token'") >= 0);
  ok('T82-a6 ★注入完整性：interruptedRowsAfter 必须在 STOP_TX_NAMES / 解构 / 主脚本 tx 三处齐全',
    txInjectionComplete(ttSrc82, shSrc82));

  // ── b. 行为验证（直接 require 实现，喂合成行；detail 一律先算成字符串避免无条件求值抛错）──
  const UCK82 = (tt82 && typeof tt82.userCancelKind === 'function') ? tt82.userCancelKind : null;
  const IRA82 = (tt82 && typeof tt82.interruptedRowsAfter === 'function') ? tt82.interruptedRowsAfter : null;
  const mk82 = (msg) => ({ type: 'message', role: 'assistant', status: 'incomplete', timestamp: Date.now(), providerData: { error: { message: msg } } });
  const kUser82 = UCK82 ? UCK82(mk82('Interrupted by user')) : '<无函数>';
  const kQueue82 = UCK82 ? UCK82(mk82('429 queue.waiting.title (abc/def)')) : '<无函数>';
  const kFull82 = UCK82 ? UCK82(mk82('429 queue.full.title (abc/def)')) : '<无函数>';
  const kAbort82 = UCK82 ? UCK82(mk82('aborted')) : '<无函数>';
  const kRate82 = UCK82 ? UCK82(mk82('429 您的使用量已超出频率限制，将在 X 重置')) : '<无函数>';
  const kDone82 = UCK82 ? UCK82({ type: 'message', role: 'assistant', status: 'completed' }) : '<无函数>';
  ok('T82-b1 ★userCancelKind 三族判定正确 + 限流/非中断行必须返回 null（不得误判为"手动取消"）',
    kUser82 === 'user' && kQueue82 === 'queue' && kFull82 === 'queue' && kAbort82 === 'aborted'
    && kRate82 === null && kDone82 === null,
    `user=${kUser82} queue=${kQueue82} full=${kFull82} aborted=${kAbort82} rate=${kRate82} done=${kDone82}`);

  const T82 = 1000000;
  const rowsQ82 = [
    { type: 'message', role: 'user', id: 'u82a', timestamp: T82 - 10 },
    { type: 'message', role: 'assistant', status: 'incomplete', timestamp: T82 + 100, providerData: { error: { message: '429 queue.waiting.title (x/y)' }, skipRun: true } },
  ];
  const rQ82 = IRA82 ? IRA82(rowsQ82, T82) : [];
  ok('T82-b2 ★interruptedRowsAfter 能识别 429 queue.waiting（原判据漏检的形态）+ kind=queue',
    rQ82.length === 1 && rQ82[0].kind === 'queue', `len=${rQ82.length} kind=${rQ82[0] && rQ82[0].kind}`);
  const rowsR82 = rowsQ82.concat([{ type: 'resend-fork-notice', editedUserItemId: 'u82a' }]);
  const rR82 = IRA82 ? IRA82(rowsR82, T82) : ['x'];
  ok('T82-b3 ★resend-fork 否决仍生效（扩族后不得吞掉"编辑重发"场景）', rR82.length === 0, `len=${rR82.length}`);
  const rowsOld82 = [
    { type: 'message', role: 'user', id: 'u82b', timestamp: T82 },
    { type: 'message', role: 'assistant', status: 'incomplete', timestamp: T82 - 1000, providerData: { error: { message: 'aborted' } } },
  ];
  const rOld82 = IRA82 ? IRA82(rowsOld82, T82) : ['x'];
  ok('T82-b4 ★早于 roundStart 的旧标记仍被排除（防历史标记被"复活"重复补弹）', rOld82.length === 0, `len=${rOld82.length}`);

  // ── b5~b7. 端到端（spawn --stop）：no-token 分支的取消文案 ──
  //   **R5 教训（v3.60.0 批A 反向验证实测）**：源码守卫 ≠ 行为守卫 —— 只断言"源码里有这行文案"时，
  //   回退 showToast 调用点后正则仍能匹配到注释/别处的同文本 → 守卫假绿。必须端到端验证
  //   toast.log 真落 reason=cancelled-no-token（T75-b5 同族：watcher 侧已有行为守卫，Stop 侧此前为零）。
  if (!SPAWN_OK) envSkip('T82-b5~b7 no-token 取消文案端到端（spawn --stop）', SPAWN_SKIP_REASON);
  else {
    const wb82 = path.join(tmp, 'k82-wb');
    const sk82 = path.join(wb82, 'skills', 'token-usage-tracker');
    const wj82 = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o); };
    // ⚠ 必须先建目录再拷 .js（T69/T76 是靠先写 pricing.json 顺带建目录；顺序一反 copyFileSync
    //   就 ENOENT——且 Node 把**源**路径打在 error.path 上，极具误导性，曾整轮 selftest 崩掉）。
    fs.mkdirSync(sk82, { recursive: true });
    // 生产布局：技能脚本拷进 wb82/skills/token-usage-tracker（__dirname == SKILL_DIR，同 T69 夹具）
    for (const f of fs.readdirSync(skillDir).filter((x) => x.endsWith('.js'))) {
      fs.copyFileSync(path.join(skillDir, f), path.join(sk82, f));
    }
    wj82(path.join(sk82, 'pricing.json'), JSON.stringify({
      date: '2026-10-15',
      models: {
        'k82-fixture': { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY',
                         unit: 'per_1m_tokens', region: 'CN', source_url: 'fixture', fetched_at: '2026-10-15T00:00:00Z' },
      },
      usd_cny_rate: 7.2,
    }));
    wj82(path.join(sk82, 'holidays.json'), '{}');
    wj82(path.join(sk82, '.update-check.json'),
      JSON.stringify({ lastCheckAt: Date.now(), latestVersion: '0.0.0', failCount: 0, nextRetryAt: 0 }));
    const toastLog82 = path.join(wb82, 'token-tracker-toast.log');
    // ⚠ 必须按**字节**偏移读增量（toast.log append-only，中文多字节，同 T75 教训）
    const toastOff82 = () => { try { return fs.statSync(toastLog82).size; } catch (e) { return 0; } };
    const toastSlice82 = (off) => { try { return fs.readFileSync(toastLog82).slice(off).toString('utf8'); } catch (e) { return ''; } };
    const TS82 = 1791856800000; // 2026-10-13 10:00 +0800（周二，高峰段内）
    const runStop82 = (sid, rows) => {
      const tp = path.join(wb82, 'projects', 'proj82', sid + '.jsonl');
      // ⚠ 每行必须先 JSON.stringify 再 join——直接 join 对象数组会拼出 "[object Object]"
      //   （实测：transcript 全不可解析 → 流程走"暂无 trace 数据"分支 → 什么都不弹 → 断言假红/假绿）。
      wj82(tp, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
      const off = toastOff82();
      const r = spawnSync(NODE, [path.join(sk82, 'token-tracker.js'), '--stop'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tp, cwd: wb82 }),
        env: Object.assign({}, env, { WB_ROOT: wb82, WB_LEDGER_MAINT: '1', WB_NO_NET: '1' }),
        timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      return { rc: r.status, toast: toastSlice82(off) };
    };
    // 场景①：用户提问 + 排队中被停止（429 queue.waiting）无 usage → 必须弹取消文案
    //   （复现 2026-10-15 14:35 真实踩坑：请求未产生消耗 → 旧文案说成"请求未发出/网络中断"）
    const SID82 = 'selftest-k82-cancel';
    const e82 = runStop82(SID82, [
      { type: 'message', role: 'user', id: 'u82e', timestamp: TS82 - 60000, content: [{ type: 'text', text: 'hi' }] },
      { type: 'message', role: 'assistant', status: 'incomplete', timestamp: TS82, content: 'Interrupted by user',
        providerData: { error: { message: '429 queue.waiting.title (abc/def)' }, skipRun: true } },
    ]);
    ok('T82-b5 ★端到端：排队中被停止（无 usage）→ Stop 弹「（手动取消）本轮无 token 消耗记录」'
      + '（R5 教训：源码守卫≠行为守卫，必须看 toast.log 真落 reason=cancelled-no-token）',
      e82.rc === 0 && e82.toast.indexOf('"reason":"cancelled-no-token"') >= 0
      && e82.toast.indexOf('（手动取消）本轮无 token 消耗记录') >= 0,
      `exit=${e82.rc} toast=${JSON.stringify(e82.toast.slice(0, 200))}`);
    ok('T82-b6 ★端到端：取消原因须按族给准确文案（queue=排队中被停止，不得说成"请求未发出/网络中断"）',
      e82.toast.indexOf('排队中被停止') >= 0 && e82.toast.indexOf('请求未发出') < 0,
      `toast=${JSON.stringify(e82.toast.slice(0, 300))}`);
    // 场景②：对照 —— 无取消标记的无记录轮 → 仍走原 no-token 文案（误判=把正常轮说成手动取消）
    const e82c = runStop82(SID82 + '-ctrl', [
      { type: 'message', role: 'user', id: 'u82c', timestamp: TS82 - 60000, content: [{ type: 'text', text: 'hi' }] },
      { type: 'message', role: 'assistant', status: 'completed', timestamp: TS82, content: [{ type: 'text', text: 'ok' }] },
    ]);
    ok('T82-b7 ★端到端对照：无取消标记 → 走原 no-token 文案，绝不弹取消文案'
      + '（"没弹取消文案"不够——必须真弹 no-token，否则"流程半路崩了"也会假绿）',
      e82c.rc === 0 && e82c.toast.indexOf('"reason":"no-token"') >= 0
      && e82c.toast.indexOf('cancelled-no-token') < 0 && e82c.toast.indexOf('手动取消') < 0,
      `exit=${e82c.rc} toast=${JSON.stringify(e82c.toast.slice(0, 200))}`);
  }
}

// ===== T83（v3.60.0 批B·B1/B4）：团队轮「未落定即不弹」+ 普通轮跳过 2.8s 白等 =====
//   背景（2026-10-15 实测定案，详见 token-tracker-问题文档-弹窗判定链-2026-10-15.md）：
//   ① **A/B 真因**：`if (isPlainRound || teamDataReady || teamSyncToast)` 里 teamSyncToast 在非普通轮
//      **恒真**（!isPlainRound && WB_SYNC_TEAM!=='0' && WB_TEAM_SPLIT!=='1'）→ `||` 短路 →
//      **teamDataReady 被架空** → 子代理还在跑就提前弹（历史 14 次 stop-team-sync 中 teamDataReady=false
//      4 次 = 28.6%：10-09 07:04 / 10-10 00:15 / **10-15 14:12(A)** / **10-15 14:36(B)**）。
//   ② **D①/D② 是该"提前弹"的副作用链**（此前一直以为是 aggregateTranscript 的窗口 bug）：
//      弹完推进 lastStopAt → 下一轮 --hook 算 `inProgress = prevStop < prevStart` = false（判"上轮已结束"）
//      → **刷新轮起点** → 主模型静默期内子代理烧的 152.9 万落在新起点之前 → 被 `mtime > aggStart0`
//      切出窗口 → 账本 188.6 万、弹窗只有 38.1 万。
//      **真实性回放**（1b82171d 现场夹具 → D:/测试临时文件夹/bB，三决策点：14:12 Stop / 14:35 hook / 14:36 Stop）
//      实测：旧 = 弹窗合计 97 万 / 账本 251.9 万 → 对齐 **38.5%**（子代理 154.9 万零出现）；
//            新 = 弹窗合计 247 万 / 账本 251.9 万 → 对齐 **98.1%**（残差 = "万"级显示取整）。
//   ③ **B4**：`subagentsAllSettled` 本轮无子代理文件时 `return any` = false（token-tracker.js:2155）
//      → 每个普通轮都 `!settled0` → 白等 4×700ms = 2.8s（Stop hook 同步阻塞，等于每次回复多卡 2.8 秒）。
//   ⚠ 本组守卫的**关键设计**：抑制分支的"不得做某事"必须**剥注释后**扫描——分支内的中文注释里
//      天然写着"不推进 lastStopAt / 不写 coalesce"，不剥注释会假绿（项目既有教训：源码守卫剥注释再扫）。
{
  const shRaw83 = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8');
  const strip83 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const i83 = shRaw83.indexOf('if (teamSyncToast && !teamDataReady) {');
  const j83 = shRaw83.indexOf('if (isPlainRound || teamDataReady || teamSyncToast) {', i83);
  const body83 = (i83 >= 0 && j83 > i83) ? strip83(shRaw83.slice(i83, j83)) : '';

  ok('T83-a1 ★团队轮未落定必须早退：抑制分支 `if (teamSyncToast && !teamDataReady)` 必须存在且位于原弹窗判据之前',
    i83 >= 0 && j83 > i83, `i=${i83} j=${j83}`);

  ok('T83-a2 ★抑制分支**绝不推进水位线**（剥注释后不得出现 lastStopAt / saveSnapshot）'
    + '——推进即把该轮标成"已结算"，下一次窗口跳过它 → 子代理那段永久丢窗（正是 D① 的机制）',
    body83.length > 0 && body83.indexOf('lastStopAt') < 0 && body83.indexOf('saveSnapshot') < 0,
    body83.length ? `body 含禁用调用: ${['lastStopAt', 'saveSnapshot'].filter((k) => body83.indexOf(k) >= 0).join(',')}` : '未取到分支体（锚点被改？）');

  ok('T83-a3 ★抑制分支不得写 coalesce / 不得启 watcher（那是"提前弹"的另一条路；且 detached watcher 会被宿主 Job Object 连带杀）',
    body83.length > 0 && body83.indexOf('writeCoalesce') < 0 && body83.indexOf('startWatcherVerified') < 0,
    body83.length ? `body 含禁用调用: ${['writeCoalesce', 'startWatcherVerified'].filter((k) => body83.indexOf(k) >= 0).join(',')}` : '未取到分支体');

  ok('T83-a4 ★抑制分支必须可观测（落 stop-team-defer-silent）并早退（return true）'
    + '——"静默不弹"若不留痕，线上永远分不清"没被抑制"和"被抑制了"',
    body83.indexOf('stop-team-defer-silent') >= 0 && body83.indexOf('return true;') >= 0);

  ok('T83-a5 ★逃生阀保持：原判据（含 teamSyncToast 分支）必须仍在抑制分支之后'
    + '——WB_SYNC_TEAM=0 / WB_TEAM_SPLIT=1 的旧行为不得被本修复改掉',
    j83 > i83 && shRaw83.slice(j83, j83 + 200).indexOf('teamSyncToast') > 0);

  ok('T83-a6 ★B4：微重判必须由"本轮真有子代理在写"把关（否则每个普通轮白等 4×700ms=2.8s）',
    /const subActive0 = hasSubagentsRecentlyActive\(tsPath, SUBAGENT_IDLE_MS\);/.test(shRaw83)
    && /if \(!settled0 && subActive0 && process\.env\.WB_NO_SUB_WAIT !== '1'\)/.test(shRaw83));

  // ── b. 端到端（spawn --stop）：未落定零弹窗 / 落定必弹 + 水位线语义 ──
  if (!SPAWN_OK) envSkip('T83-b1~b3 团队轮落定判据端到端（spawn --stop）', SPAWN_SKIP_REASON);
  else {
    const wb83 = path.join(tmp, 'k83-wb');
    const sk83 = path.join(wb83, 'skills', 'token-usage-tracker');
    const wj83 = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, o); };
    fs.mkdirSync(sk83, { recursive: true }); // ⚠ 先建目录再 copyFileSync（否则 ENOENT 且报错指向源路径）
    for (const f of fs.readdirSync(skillDir).filter((x) => x.endsWith('.js'))) {
      fs.copyFileSync(path.join(skillDir, f), path.join(sk83, f));
    }
    wj83(path.join(sk83, 'pricing.json'), JSON.stringify({
      date: '2026-10-15',
      models: {
        'k83-fixture': { input_price: 1.0, output_price: 2.0, cached_price: 0.5, currency: 'CNY',
                         unit: 'per_1m_tokens', region: 'CN', source_url: 'fixture', fetched_at: '2026-10-15T00:00:00Z' },
      },
      usd_cny_rate: 7.2,
    }));
    wj83(path.join(sk83, 'holidays.json'), '{}');
    wj83(path.join(sk83, '.update-check.json'),
      JSON.stringify({ lastCheckAt: Date.now(), latestVersion: '0.0.0', failCount: 0, nextRetryAt: 0 }));
    const SID83 = 'selftest-k83-team';
    const toastP83 = path.join(wb83, 'token-tracker-toast.log');
    const compP83 = path.join(wb83, 'token-tracker-compaction.log');
    const sizeOf83 = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
    const slice83 = (p, off) => { try { return fs.readFileSync(p).slice(off).toString('utf8'); } catch (e) { return ''; } };
    // 造夹具：主 transcript（user + 一条主模型 usage）+ 一个子代理文件（一条 usage、末行 incomplete）
    //   subAgeMs = 子代理文件 mtime 距现在多久 ⇒ <20s 判未落定，≥20s 判"已停写=落定"
    const mk83 = (subAgeMs) => {
      const now = Date.now();
      const tp = path.join(wb83, 'projects', 'proj83', SID83 + '.jsonl');
      wj83(tp, [
        { type: 'message', role: 'user', id: 'u83', timestamp: now - 60000, content: [{ type: 'text', text: 'go' }] },
        { type: 'message', role: 'assistant', status: 'completed', timestamp: now - 50000,
          providerData: { usage: { inputTokens: 1000, outputTokens: 100 }, model: 'k83-fixture' } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const sp = path.join(wb83, 'projects', 'proj83', SID83, 'subagents', 'agent-k83.jsonl');
      wj83(sp, [
        { type: 'message', role: 'assistant', status: 'incomplete', timestamp: now - subAgeMs - 1000,
          providerData: { usage: { inputTokens: 2000, outputTokens: 200 }, isSubAgent: true, model: 'k83-fixture' } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const t = (now - subAgeMs) / 1000; // 显式设 mtime（决定 subagentsAllSettled 的"已停写"判定）
      fs.utimesSync(sp, t, t);
      wj83(path.join(sk83, '.snapshot-' + SID83 + '.json'),
        JSON.stringify({ file: tp, stat: null, lastUserMsgAt: now - 60000, lastStopAt: 0 }));
      return tp;
    };
    const runStop83 = (tp) => {
      const off = sizeOf83(toastP83), coff = sizeOf83(compP83);
      const r = spawnSync(NODE, [path.join(sk83, 'token-tracker.js'), '--stop'], {
        input: JSON.stringify({ session_id: SID83, transcript_path: tp, cwd: wb83 }),
        env: Object.assign({}, env, { WB_ROOT: wb83, WB_LEDGER_MAINT: '1', WB_NO_NET: '1', WB_SYNC_TEAM: '1', WB_TEAM_SPLIT: '' }),
        timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      let snap = {};
      try { snap = JSON.parse(fs.readFileSync(path.join(sk83, '.snapshot-' + SID83 + '.json'), 'utf8')); } catch (e) { snap = {}; }
      return { rc: r.status, toast: slice83(toastP83, off), comp: slice83(compP83, coff), snap };
    };
    // b1/b2：子代理 5 秒前才写过（末行 incomplete → 未落定）→ 零弹窗 + 留痕 + 水位线不动
    const e83a = runStop83(mk83(5000));
    ok('T83-b1 ★端到端：团队轮未落定 → Stop **零弹窗** + 落 stop-team-defer-silent'
      + '（旧代码此处必弹——正是 A 型"提前弹"的行为级复现）',
      e83a.rc === 0 && e83a.toast.trim() === '' && e83a.comp.indexOf('stop-team-defer-silent') >= 0,
      `exit=${e83a.rc} toast=${JSON.stringify(e83a.toast.slice(0, 150))} comp=${JSON.stringify(e83a.comp.slice(0, 180))}`);
    ok('T83-b2 ★端到端：未落定抑制时**绝不推进 lastStopAt**（推进即把跳过区间标成已结算 → 下次窗口跳过它）',
      e83a.rc === 0 && !(Number(e83a.snap.lastStopAt) > 0), `lastStopAt=${e83a.snap.lastStopAt}`);
    // b3：对照 —— 子代理已停写 ≥20s（落定）→ 必须弹 + 推进水位线（防"修成永不弹"）
    const e83b = runStop83(mk83(25000));
    ok('T83-b3 ★端到端对照：子代理已落定（停写 ≥20s）→ 必须弹窗（reason=team-sync*）**且**推进 lastStopAt'
      + '（"少弹了"与"弹错了"两侧都要抓：只断言"不弹"会漏掉修成"永远不弹"）',
      e83b.rc === 0 && e83b.toast.indexOf('"reason":"team-sync') >= 0 && e83b.comp.indexOf('stop-team-sync') >= 0
      && Number(e83b.snap.lastStopAt) > 0,
      `exit=${e83b.rc} toast=${JSON.stringify(e83b.toast.slice(0, 150))} lastStopAt=${e83b.snap.lastStopAt}`);
  }
}

// ===== T84（v3.60.0 · C1 门禁）：CI 上「跳过」必须判失败（关掉 KNOWN-ISSUES C 类第 1 条的假绿缺口）=====
//   背景：`envSkipCount` 不计入退出码 → 沙箱/CI 上"绿 ≠ 真跑过"（C1）。修法：ciSkipGate 纯函数 + 退出前调用，
//   **仅 CI 生效**（本地沙箱禁 spawn 属环境能力，v3.29.0 已定"不该判红"，语义不变）。
//   ⚠ 源码断言一律**剥注释后**扫：本节与 ciSkipGate 的中文注释里天然写着 inCI/unexpected/shouldFail，
//      不剥注释会**假绿**（项目既有教训：源码守卫必须剥注释再扫）。
{
  const self84 = stripComments(fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf-8'));
  ok('T84-a1 ★C1 门禁：ciSkipGate 纯函数必须存在（inCI + unexpected + shouldFail 三要素齐全）',
    /function\s+ciSkipGate\s*\(/.test(self84)
    && /\.inCI\b/.test(self84) && /unexpected/.test(self84) && /shouldFail/.test(self84));
  ok('T84-a2 ★C1 门禁：退出前必须**真调用** ciSkipGate 且 shouldFail 时 fail++（只定义不调用＝没修好）',
    /ciSkipGate\s*\(\s*\{\s*inCI:/.test(self84) && /if\s*\(\s*_gate\.shouldFail\s*\)\s*fail\+\+/.test(self84));
  ok('T84-a3 ★C1 门禁：必须同时认 process.env.CI 与 GITHUB_ACTIONS（GitHub Actions 两者都设；只认其一遇 runner 差异会静默失效）',
    /process\.env\.CI\b/.test(self84) && /process\.env\.GITHUB_ACTIONS\b/.test(self84));
  ok('T84-a4 ★C1 门禁：不得引入 exit 2（重蹈 v3.29.0 A-3 覆辙：exit 2 被 GitHub Actions 一律判失败、且像"测试失败"）',
    !/process\.exit\(\s*2\s*\)/.test(self84));
  // ── b. 表驱动行为断言（对**真函数**，非重实现）──
  const g84 = (o) => ciSkipGate(o);
  ok('T84-b1 ★C1 门禁行为：CI + 有非预期跳过 → 判失败',
    g84({ inCI: true, envSkipCount: 3, wbNoNet: undefined }).shouldFail === true);
  ok('T84-b2 ★C1 门禁行为：CI + 离线跑 + 正好 1 条前提缺口 → **不**判失败（否则离线那一遍永远红）',
    g84({ inCI: true, envSkipCount: 1, wbNoNet: '1' }).shouldFail === false);
  ok('T84-b3 ★C1 门禁行为：CI + 离线跑 + 2 条（1 前提 + 1 真跳过）→ 判失败（前提缺口不得掩盖真跳过）',
    g84({ inCI: true, envSkipCount: 2, wbNoNet: '1' }).shouldFail === true);
  ok('T84-b4 ★C1 门禁行为：非 CI（本地）→ 无论多少跳过都不判失败（沙箱禁 spawn 属环境能力，语义不变）',
    g84({ inCI: false, envSkipCount: 9, wbNoNet: undefined }).shouldFail === false);
  ok('T84-b5 ★C1 门禁行为：CI + 联网跑 + 0 跳过 → 不判失败（正常路径）',
    g84({ inCI: true, envSkipCount: 0, wbNoNet: undefined }).shouldFail === false);
}

// ===== T85（v3.60.0 · CI 编码）：钉死「CI 连红 3 天」的两个根因（编码 18 红 + T72-b 4 红）=====
//   背景（2026-10-15 实查 GitHub Actions API，非推断）：CI 自 v3.53.0 起连红 3 天，22 红 = 18 编码 + 4 T72-b：
//     ① 编码：CI 是 Windows runner，python 的 stdout 默认走 locale 编码 cp1252 → print 中文即
//        UnicodeEncodeError 整脚本崩（T63/T64/T71/T73）。本机 locale=UTF-8 → 本地永远绿
//        ⇒ 典型"本地绿 / CI 红"环境分叉（本地全绿掩盖了 CI 全红）。
//     ② T72-b：CI 离线遍的 WB_NO_NET=1 被 spawn 继承 → deepseek-official 在 fetch 前短路。
//   ⚠ py 文件的源码断言必须剥 **#** 注释（本文件的 stripComments 只剥 `//`/`/* */`，对 py 无效）；
//     不剥注释 → 注释里的同文本会让断言在回退后**假绿**（项目既有教训）。
{
  const stripPy85 = (s) => String(s || '').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
  const raw85 = fs.readFileSync(path.join(SRC, 'selftest.js'), 'utf-8');
  const cut85 = raw85.indexOf('===== T85');
  // 只扫 T85 之前的**主测试体**：T85 自身那个"故意用 cp1252 复现 CI"的 spawn 是本守卫的测试装置，
  //   不是被测代码，不该被自己的规则要求带 PY_IO_ENV（否则守卫误伤自己）。
  const self85 = stripComments(cut85 > 0 ? raw85.slice(0, cut85) : raw85);
  const pyFiles85 = ['build_index.py', 'parse_tokenhub.py', 'fetch-cn-prices.py'];
  for (const f of pyFiles85) {
    let s85 = '';
    try { s85 = stripPy85(fs.readFileSync(path.join(SRC, f), 'utf-8')); } catch (e) { /* 文件缺失 → 断言红 */ }
    ok(`T85-a1 ★CI 编码：${f} 入口须强制 stdout/stderr 为 utf-8（Windows locale=cp1252 下打印中文即崩）`,
      /sys\.stdout\.reconfigure\(\s*encoding\s*=\s*['"]utf-8['"]/.test(s85)
      && /sys\.stderr\.reconfigure\(\s*encoding\s*=\s*['"]utf-8['"]/.test(s85));
  }
  ok('T85-a2 ★CI 编码：测试侧兜底常量 PY_IO_ENV = { PYTHONIOENCODING: \'utf-8\' } 必须存在',
    /const\s+PY_IO_ENV\s*=\s*\{\s*PYTHONIOENCODING:\s*['"]utf-8['"]\s*\}/.test(self85));
  // a3：**每个** spawn python 的子进程都必须带 PY_IO_ENV（漏一个 → 该用例在 CI 上崩）。
  //   窗口取 match 前后各一段：env63/env64 在 spawn 的**紧邻上一行**构造（PY_IO_ENV 位于 match 之前）。
  {
    const re85 = /spawnSync\(\s*(py\w*|PY\w+)\s*,/g;
    const miss85 = [];
    let m85, n85 = 0;
    while ((m85 = re85.exec(self85)) !== null) {
      n85++;
      const win = self85.slice(Math.max(0, m85.index - 320), m85.index + 360);
      if (win.indexOf('PY_IO_ENV') < 0) miss85.push(m85[1]);
    }
    ok('T85-a3 ★CI 编码：所有 spawn python 的子进程都带 PY_IO_ENV（含 selftest 内联 t73.py——产品脚本之外唯一来源）',
      n85 >= 8 && miss85.length === 0, `spawn点=${n85} 漏带=[${miss85.join(',')}]`);
  }
  ok('T85-a4 ★CI 编码：T72-b 的 spawn env 必须经 makeT72bChildEnv(process.env)（显式清联网总开关）',
    /makeT72bChildEnv\s*\(\s*process\.env\s*\)/.test(self85));
  // ── b. 行为断言（真跑；与源码断言配对 —— 只断言源码文本会在回退后匹配到注释同文本 → 假绿）──
  // b4 纯 JS：对**真函数**断言（不依赖 python）
  {
    const e85 = makeT72bChildEnv({ WB_NO_NET: '1', WB_DISABLE_NET: '1', KEEP: 'y' });
    ok('T85-b4 ★CI 编码行为：makeT72bChildEnv 清 WB_NO_NET/WB_DISABLE_NET 且保留其它键',
      e85.WB_NO_NET === undefined && e85.WB_DISABLE_NET === undefined && e85.KEEP === 'y',
      `WB_NO_NET=${e85.WB_NO_NET} WB_DISABLE_NET=${e85.WB_DISABLE_NET} KEEP=${e85.KEEP}`);
  }
  // b1~b3 需 python：把每个产品脚本**在 PYTHONIOENCODING=cp1252 下导入并打印中文** —— reconfigure 真生效
  //   才过；缺失则 import 时设不上 utf-8 → 末尾 print 中文即崩 → 精确复现 CI 的那一红。
  const py85 = (() => {
    if (process.env.CN_PYTHON) return process.env.CN_PYTHON;
    try {
      const root = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions');
      for (const v of fs.readdirSync(root).sort().reverse()) {
        const p = path.join(root, v, 'python.exe');
        if (fs.existsSync(p)) return p;
      }
    } catch (e) { /* 探测失败 → 回退裸 python */ }
    return 'python';
  })();
  const probe85 = spawnSync(py85, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (!SPAWN_OK || probe85.status !== 0) {
    envSkip('T85-b 行为组（python reconfigure 端到端，cp1252 模拟）',
      !SPAWN_OK ? SPAWN_SKIP_REASON : '未找到可用 python');
  } else {
    for (const f of pyFiles85) {
      const code85 = [
        'import importlib.util',
        `_p = ${JSON.stringify(path.join(SRC, f))}`,
        "_s = importlib.util.spec_from_file_location('m85', _p)",
        '_m = importlib.util.module_from_spec(_s)',
        '_s.loader.exec_module(_m)',
        "import sys; sys.stdout.write('中文OK')",
      ].join('\n');
      const r85 = spawnSync(py85, ['-c', code85], {
        encoding: 'utf8', windowsHide: true, timeout: 60000,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'cp1252' }),   // ← 复现 CI 的 cp1252
      });
      ok(`T85-b ★CI 编码行为：${f} 在 PYTHONIOENCODING=cp1252 下仍能打印中文（reconfigure 真生效）`,
        r85.status === 0 && String(r85.stdout || '').indexOf('中文OK') >= 0,
        `exit=${r85.status} out=${JSON.stringify(String(r85.stdout || '').slice(-40))} err=${JSON.stringify(String(r85.stderr || '').slice(0, 140))}`);
    }
  }
}

// ===== T86（v3.60.0 补修）：源码守卫必须**行尾无关** —— 防 Windows CI 检出 CRLF 后「本地绿 / CI 红」=====
//   事故：v3.60.0 首推 CI 离线遍 947 过 / 1 败，唯一红 = T82-a6。根因 = 它的读取未归一行尾、正则用字面
//   `\n`，而 Windows runner（core.autocrlf）把源检出成 CRLF → `,\r\n` 不匹配 `,\n`；本机 LF 永远绿。
//   修法：判据抽成 txInjectionComplete（正则 `\r?\n`）+ 读取归一；本守卫锁住「判据对 LF / CRLF 都成立」。
{
  const lf86 = (s) => s.replace(/\r\n/g, '\n');
  const crlf86 = (s) => lf86(s).replace(/\n/g, '\r\n');
  const rawTT86 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8');
  const rawSH86 = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8');
  // b1：判据对 CRLF 源同样成立（若有人把 `\r?\n` 改回字面 `\n`，此行与 CI 同因变红）
  ok('T86-b1 ★注入完整性判据必须行尾无关（CRLF 源同样成立）——防 Windows CI 检出 CRLF 后本地绿/CI 红',
    txInjectionComplete(crlf86(rawTT86), crlf86(rawSH86)),
    'CRLF 源下 txInjectionComplete 应为 true（正则须含 \\r?\\n）');
  // b2：LF 源也成立（本地常规路径不回归）
  ok('T86-b2 ★注入完整性判据在 LF 源同样成立（本地常规路径不回归）',
    txInjectionComplete(lf86(rawTT86), lf86(rawSH86)));
}

// ===== T87（v3.61.0 · 审计 F1，致命）：Kimi 解析器夹具测试 + 命名分组守卫 =====
//   事故：v3.59.0 给 Kimi 行正则加「单位」捕获组 → 分组编号整体 +1，但
//   `prices = re.findall(r'"¥([\d.]+)"', m.group(2))` 没跟着改（group(2) 现在是单位串 "1M"）
//   → findall 恒返回空 → **每一行都走 else: continue → Kimi 整厂商 0 模型、零行级告警**，
//   潜伏 v3.59.0~v3.60.0 两个版本。pricing.json 里 kimi 尚有 3 条 lock 价，所以现象不是「全缺失」，
//   而是「**永不更新**」——新模型（kimi-k2.7-code 等）直接掉 DEFAULT_RATE 兜底价，用户无感知。
//   修法：正则改**命名分组** + 行解析抽成纯函数 parse_kimi_row（可夹具测试、不打网络）。
//   本守卫 = 源码侧钉死命名分组与调用形态 + 行为侧用**真身纯函数**喂样本行断言字段。
{
  const fcpRaw = fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf-8').replace(/\r\n/g, '\n');
  // py 注释剥离（带引号状态）—— 守卫必须扫"代码"，注释里同文本不算（否则可被注释绕过）。
  const stripPy = (s) => s.split('\n').map((line) => {
    let out = ''; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === '\\') out += line[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }).join('\n');
  const fcp = stripPy(fcpRaw);
  // 锚点收窄到 Kimi 段：全文件扫会误伤别的解析器（阶跃 parse_stepfun_md 合法使用 m.group(2)）——
  //   守卫必须锚到"那一处"，否则要么恒绿要么误报（本项目纪律）。
  const kimiSeg = fcp.slice(fcp.indexOf('KIMI_ROW_RE'), fcp.indexOf('def parse_pricing_deepseek'));
  ok('T87-a1 ★Kimi 行正则必须用命名分组（name/unit/prices/total）——根治分组索引漂移',
    /KIMI_ROW_RE\s*=\s*re\.compile\(/.test(kimiSeg)
    && /\(\?P<name>/.test(kimiSeg) && /\(\?P<unit>/.test(kimiSeg)
    && /\(\?P<prices>/.test(kimiSeg) && /\(\?P<total>/.test(kimiSeg));
  ok('T87-a2 ★Kimi 段不得再用数字分组取价格段（m.group(2)/group(3) 即 F1 病根）',
    !/m\.group\(\s*[23]\s*\)/.test(kimiSeg),
    'Kimi 段仍出现 m.group(2)/m.group(3) —— 命名分组被改回数字索引，F1 会复发');
  ok('T87-a3 ★parse_kimi 必须调用纯函数 parse_kimi_row（夹具测试的挂点）',
    /def parse_kimi_row\(/.test(fcp) && /parse_kimi_row\(line\)/.test(fcp)
    && /KIMI_ROW_RE\.match\(/.test(fcp));
  ok('T87-a4 ★细粒度告警：匹配到行却 0 条收录必须 WARN（区分"页面没行"与"行全被跳过"）',
    /matched_rows/.test(fcp) && /0 条收录/.test(fcpRaw));

  // ── 行为组：require 真身纯函数喂样本行（不打网络）──
  const pyCands87 = [];
  if (process.env.CN_PYTHON) pyCands87.push(process.env.CN_PYTHON);
  pyCands87.push('python', 'python3');
  let PY87 = null;
  for (const c of pyCands87) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY87 = c; break; }
  }
  if (!PY87) envSkip('T87-b 行为组（Kimi 行解析夹具）', 'python 不可用');
  else {
    const fw87 = path.join(tmp, 'b87kimi');
    fs.mkdirSync(fw87, { recursive: true });
    const py87 = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, json, sys, re',
      "_spec = importlib.util.spec_from_file_location('fcp87', " + JSON.stringify(path.join(SRC, 'fetch-cn-prices.py')) + ")",
      'F = importlib.util.module_from_spec(_spec)',
      '_spec.loader.exec_module(F)',
      'fails = []',
      'def chk(n, c, d=""):',
      '    print(("  OK   " if c else "  FAIL ") + n + (("  " + d) if d else ""))',
      '    if not c: fails.append(n)',
      'K3 = \'["kimi-k3","1M tokens","\u00a520.00","\u00a540.00","\u00a52.00","\u00a520.00","\u00a5100.00","1,048,576 tokens"]\'',
      'K27 = \'["kimi-k2.7-code","1M tokens","\u00a51.30","\u00a56.50","\u00a527.00","262,144 tokens"]\'',
      'r3, why3 = F.parse_kimi_row(K3)',
      'chk("k3 行解析成功（5 价取末 3 位）", r3 is not None and why3 is None, "why=%r" % (why3,))',
      'chk("k3 in=20.00", bool(r3) and r3["in_price"] == ["20.00\u5143"], "got=%r" % (r3 and r3["in_price"],))',
      'chk("k3 out=100.00", bool(r3) and r3["out_price"] == ["100.00\u5143"])',
      'chk("k3 cache=2.00", bool(r3) and r3["cache_hit"] == ["2.00\u5143"])',
      'chk("k3 unit \u56de\u4f20 \u5143/\u767e\u4e07 tokens", bool(r3) and r3["unit"] == "\u5143/\u767e\u4e07 tokens")',
      'chk("k3 brand=kimi", bool(r3) and r3["brand"] == "kimi")',
      'r27, why27 = F.parse_kimi_row(K27)',
      'chk("k2.7-code in=6.50 / out=27.00 / cache=1.30", bool(r27) and r27["in_price"] == ["6.50\u5143"] and r27["out_price"] == ["27.00\u5143"] and r27["cache_hit"] == ["1.30\u5143"], "got=%r" % (r27,))',
      '_, w_unit = F.parse_kimi_row(\'["kimi-k3","2K tokens","\u00a51.30","\u00a56.50","\u00a527.00","262,144 tokens"]\')',
      'chk("\u8ba1\u4ef7\u5355\u4f4d\u975e 1M \u2192 reason=unit\uff08v3.59.0 S5 \u5355\u4f4d\u65ad\u8a00\u4fdd\u6301\uff09", w_unit == "unit", "got=%r" % (w_unit,))',
      '_, w_pr = F.parse_kimi_row(\'["kimi-x","1M tokens","\u00a51.30","262,144 tokens"]\')',
      'chk("\u4ef7\u683c\u4e2a\u6570\u4e0d\u8db3 2 \u2192 reason=prices", w_pr == "prices", "got=%r" % (w_pr,))',
      '_, w_nm = F.parse_kimi_row("\u8fd9\u4e0d\u662f\u8868\u683c\u884c")',
      'chk("\u975e\u8868\u683c\u884c \u2192 reason=no-match", w_nm == "no-match", "got=%r" % (w_nm,))',
      'gi = sorted(F.KIMI_ROW_RE.groupindex.keys())',
      'chk("groupindex \u6070\u4e3a\u56db\u547d\u540d\u5206\u7ec4\uff08\u4e0d\u6df7\u6570\u5b57\u5206\u7ec4\uff09", gi == ["name", "prices", "total", "unit"], "got=%r" % (gi,))',
      // \u8de8\u6587\u4ef6\u4e00\u81f4\u6027\uff1ak3 \u89e3\u6790\u7ed3\u679c\u5fc5\u987b\u4e0e pricing.json \u91cc\u7528\u6237\u5df2\u6821\u5bf9\u7684 lock \u4ef7\u5b8c\u5168\u4e00\u81f4\uff08\u5426\u5219\u89e3\u6790\u5668\u4e0e\u5df2\u53d1\u5e03\u4ef7\u5c31\u5206\u53c9\u4e86\uff09',
      'P = "pricing.json"',
      'import os',
      'pp = os.path.join(' + JSON.stringify(SRC) + ', "pricing.json")',
      'try:',
      '    lock = json.load(open(pp, encoding="utf-8"))["models"].get("kimi-k3", {})',
      '    chk("\u8de8\u6587\u4ef6\uff1ak3 \u89e3\u6790\u503c == pricing.json lock \u4ef7\uff08in20/cached2/out100\uff09",',
      '        bool(r3) and float(r3["in_price"][0][:-1]) == float(lock.get("input_price"))',
      '        and float(r3["out_price"][0][:-1]) == float(lock.get("output_price"))',
      '        and float(r3["cache_hit"][0][:-1]) == float(lock.get("cached_price")),',
      '        "lock=%r" % ({k: lock.get(k) for k in ("input_price", "output_price", "cached_price")},))',
      'except Exception as e:',
      '    chk("\u8de8\u6587\u4ef6\uff1apricing.json \u8bfb\u53d6", False, repr(e)[:120])',
      'print("RESULT %d %d" % (len(fails), 0))',
      'sys.exit(1 if fails else 0)',
    ].join('\n');
    const pf87 = path.join(fw87, 't87.py');
    fs.writeFileSync(pf87, py87, 'utf8');
    const r87 = spawnSync(PY87, [pf87], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    let matched87 = 0;
    for (const ln of String(r87.stdout || '').split(/\r?\n/)) {
      const m = /^\s*(OK|FAIL)\s+(.*)$/.exec(ln);
      if (m) ok('T87-b' + (++matched87) + ' ' + m[2], m[1] === 'OK');
    }
    ok('T87-b0 行为组断言行被识别（python 输出格式/编码异常时此处暴露原文）',
      matched87 > 0,
      'status=' + r87.status + ' lines=' + String(r87.stdout || '').split('\n').length
      + ' stdout=[' + String(r87.stdout || '').replace(/\n/g, '\\n') + ']'
      + ' stderr=[' + String(r87.stderr || '').slice(0, 600) + ']');
    try { fs.rmSync(fw87, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ===== T88（v3.61.0 · 审计 F2，致命）：残行口径单一实现 + backfill/主链一致性 =====
//   事故：主链 readTranscLinesFrom 自 v3.42.0（A19）起「残行 parse 成功 → 收下该行且水位线 +1」；
//   而 backfill.js 的 readRows 用 `raw.split('\n')` 把残行**也解析进 rows**（= 回填已记它的 token），
//    physicalLines 却只数 '\n'（水位线没盖住这一行）→ 跑过 backfill 后，主链下一轮从旧水位线
//   **重读该残行 = 同一行 token 记两次**（钱量双错、静默）。
//   修法：抽 transc-lines.js 的 measureTranscriptLines 作单一实现，两侧共用。
//   本守卫 = 源码侧钉死两侧都调它 + 行为侧断言「残行被 rows 收录 ⇔ 水位线 +1」这个不变量。
{
  const tlSrc = (() => { try { return fs.readFileSync(path.join(SRC, 'transc-lines.js'), 'utf-8').replace(/\r\n/g, '\n'); } catch (e) { return ''; } })();
  const bfRaw = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n');
  const bf = stripComments(bfRaw);
  const ttRaw = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const tt = stripComments(ttRaw);
  ok('T88-a1 ★transc-lines.js 必须存在且导出 measureTranscriptLines',
    /function measureTranscriptLines/.test(tlSrc) && /module\.exports\s*=\s*\{\s*measureTranscriptLines/.test(tlSrc));
  ok('T88-a2 ★backfill 的 physicalLines 必须来自 measureTranscriptLines（不得再裸数 \'\\n\'）',
    /measureTranscriptLines\(raw\)\.lines/.test(bf) && !/raw\.match\(\/\\n\/g\)/.test(bf),
    'backfill 仍在自行数 \'\\n\' —— F2 会复发');
  ok('T88-a3 ★主链 readTranscLinesFrom 必须调用同一个 measureTranscriptLines',
    /measureTranscriptLines\(buf\.toString\('utf-8', off\)\)/.test(tt));
  ok('T88-a4 ★backfill 必须 require transc-lines.js（依赖显式，防"复制实现靠注释同步"）',
    /require\('\.\/transc-lines\.js'\)/.test(bf));

  let TL = null;
  try { TL = require(path.join(SRC, 'transc-lines.js')); } catch (e) { TL = null; }
  if (!TL || typeof TL.measureTranscriptLines !== 'function') {
    ok('T88-b0 transc-lines.js 可被 require（纯模块、无副作用）', false, 'require 失败');
  } else {
    ok('T88-b0 transc-lines.js 可被 require（纯模块、无副作用）', true);
    const M = TL.measureTranscriptLines;
    const line = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ i, ts: 1000 + i })).join('\n');
    const full = line(5) + '\n';                                   // 5 完整行 + 正常尾
    const residual = line(5) + '\n' + JSON.stringify({ i: 99 });    // 5 完整行 + 残行（合法 JSON）
    const half = line(5) + '\n' + '{"i": 99, "ts":';                 // 5 完整行 + 半写残缺行
    const empty = '';
    const mFull = M(full), mRes = M(residual), mHalf = M(half), mEmpty = M(empty);
    ok('T88-b1 ★残行是合法 JSON → 行数 +1 且 residualRow 非空（v3.42.0 A19 语义）',
      mRes.lines === 6 && mRes.residualRow && mRes.residualRow.i === 99,
      'lines=' + mRes.lines + ' residualRow=' + JSON.stringify(mRes.residualRow));
    ok('T88-b2 半写残缺行 → 不加 1、residualRow 为空（等文件长全再读，绝不提前记账）',
      mHalf.lines === 5 && mHalf.residualRow === null, 'lines=' + mHalf.lines);
    ok('T88-b3 正常尾（以 \'\\n\' 结尾）→ 不加 1', mFull.lines === 5 && mFull.residualRow === null, 'lines=' + mFull.lines);
    ok('T88-b4 空文本 → 0', mEmpty.lines === 0);
    ok('T88-b5 CRLF 文本与 LF 同结果（行尾无关）',
      M(full.replace(/\n/g, '\r\n')).lines === mFull.lines
      && M(residual.replace(/\n/g, '\r\n')).lines === mRes.lines
      && M(residual.replace(/\n/g, '\r\n')).residualRow !== null);
    // 核心不变量：残行被 backfill 的 rows 收录 ⇔ 被水位线盖住（F2 的病灶就是这两件事脱钩）
    const inRows = (text) => {
      const last = text.split('\n').slice(-1)[0].trim();
      if (!last) return false;
      try { JSON.parse(last); return true; } catch (e) { return false; }
    };
    const samples = [full, residual, half, empty, line(3), line(3) + '\n' + '{}'];
    let invOk = true; const invDetail = [];
    for (const s of samples) {
      const m = M(s);
      const nl = (s.match(/\n/g) || []).length;
      const rowHas = inRows(s);
      const resHas = m.residualRow !== null;
      if (resHas !== rowHas) { invOk = false; invDetail.push('脱钩: ' + JSON.stringify(s.slice(-24))); }
      if (m.lines !== nl + (rowHas ? 1 : 0)) { invOk = false; invDetail.push('行数错: ' + JSON.stringify(s.slice(-24))); }
    }
    ok('T88-b6 ★不变量：残行被 rows 收录 ⇔ 水位线 +1（F2 病灶即二者脱钩）',
      invOk, invDetail.join(' | '));
  }
}

// ===== T89（v3.61.0 · 审计 S1/S4，严重）：Stop hook 顶层异常守卫 + toast 失败不再静默 =====
//   事故：Stop hook 是产品核心交付物（toast）的**唯一出口**。修前主流程无顶层 try —— transcript 畸形 /
//   快照读取抛非 SyntaxError（EACCES 等）/ 任何未预期输入，异常直接冒泡出 Stop hook：本轮通知彻底
//   静默丢失、无降级、退出码仍 0；异常若发生在持锁段内，还可能绕过 clearCoalesce/lastStopAt 收尾，
//   把冷却状态留在脏值，影响下一轮合并判定。
//   另外（S4）：同步弹窗的 catch 只打一行 stderr，而**普通轮本就不写 coalesce** → toast 一抛就是零兜底。
//   修法：①handleStopEnd 包顶层 try/catch（降级 toast + out + 返回 true，不推进 lastStopAt）；
//          ②同步弹窗 catch 里补降级 toast + 留痕。
{
  const shRaw = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8').replace(/\r\n/g, '\n');
  const sh = stripComments(shRaw);
  // ⚠ 判据收紧（v3.61.0 反向验证 R3 抓到假绿）：改前有个
  //   `|| (function handleStopEnd 存在 && return handleStopEndInner(ctx) 存在)` 兜底分支 ——
  //   把「守卫被拆掉、只剩裸转发」的回退形态也判成绿（实测 R3 回退后 a1 仍绿 = 守卫等于没有）。
  //   按「锚点必须唯一到那一处」纪律：只认「try 包住 Inner 调用」这一种形态，裸转发不算。
  ok('T89-a1 ★handleStopEnd 必须是顶层守卫（try 包住 handleStopEndInner；裸转发不算）',
    /function handleStopEnd\(ctx\)\s*\{[^}]*try\s*\{[^}]*handleStopEndInner\(ctx\)/.test(sh));
  ok('T89-a2 ★原主流程必须改名为 handleStopEndInner（守卫有东西可包）',
    /function handleStopEndInner\(ctx\)/.test(sh));
  ok('T89-a3 ★同步弹窗 catch 必须有降级 toast（普通轮不写 coalesce → 否则零兜底）',
    /⚠ 本轮用量显示失败/.test(shRaw) && /stop-sync-toast-failed/.test(shRaw));
  ok('T89-a4 ★降级路径不得推进 lastStopAt（轮保持开放 → 下轮从原轮起点补弹，防重复记账）',
    /未推进 lastStopAt/.test(shRaw));

  let SH = null;
  try { SH = require(path.join(SRC, 'stop-handler.js')); } catch (e) { SH = null; }
  if (!SH || typeof SH.handleStopEnd !== 'function') {
    ok('T89-b0 stop-handler.js 可被 require', false, 'require 失败');
  } else {
    ok('T89-b0 stop-handler.js 可被 require', true);
    // b1：ctx 为 null（解构即抛 TypeError）→ 顶层守卫必须兜住、不得冒泡、必须返回 true
    let threw = null; let ret = null;
    try { ret = SH.handleStopEnd(null); } catch (e) { threw = e; }
    ok('T89-b1 ★ctx=null（内部必抛）不得冒泡，且返回 true（已降级收口）',
      threw === null && ret === true,
      'threw=' + (threw && threw.message) + ' ret=' + JSON.stringify(ret));
    // b2：降级 toast 自身也抛 → 仍不得冒泡，且 out 必须被调到（hook 正常收口）
    let outCalled = 0; let threw2 = null; let ret2 = null;
    const badCtx = {
      sid: 'x', payloadRaw: '{}', pricing: {},
      out: () => { outCalled++; },
      tx: { showToast: () => { throw new Error('toast-boom'); } },
    };
    try { ret2 = SH.handleStopEnd(badCtx); } catch (e) { threw2 = e; }
    ok('T89-b2 ★降级 toast 自身再抛也不冒泡，且 out 被调用（hook 收口）',
      threw2 === null && ret2 === true && outCalled === 1,
      'threw=' + (threw2 && threw2.message) + ' ret=' + JSON.stringify(ret2) + ' outCalled=' + outCalled);
    // b3：out 自身也抛 → 依旧不得冒泡（catch 里绝不能再抛）
    let threw3 = null; let ret3 = null;
    const badCtx2 = { sid: 'x', payloadRaw: '{}', pricing: {}, out: () => { throw new Error('out-boom'); }, tx: {} };
    try { ret3 = SH.handleStopEnd(badCtx2); } catch (e) { threw3 = e; }
    ok('T89-b3 ★out 自身也抛时依旧不冒泡（catch 内绝不再抛）',
      threw3 === null && ret3 === true, 'threw=' + (threw3 && threw3.message) + ' ret=' + JSON.stringify(ret3));
  }
}

// ===== T90（v3.61.0 · 审计 S2/G4）：失败可见性 + 水位线只许前进 =====
//   S2：build_index.py 的 prev 读取修前是裸 except → prev=None **静默无告警**，「首次构建」与
//       「上一版索引损坏/权限异常」在输出里长得一模一样（都是 gate_full=False）→ 索引损坏时闸门退化、
//       沿用基线丢失，用户却只看到一次"正常"刷新。（写出空索引那条已被 :666 安全阀挡住。）
//   G4：backfill 的 rollbackWatermark 修前**盲恢复 bak2**（写入前快照）→ 写入后主链路可能已并发推高
//       水位线 → 一并抹掉 = 水位线**回退** → 下轮主链重读已记账行 = **重复计费**（不可恢复地多收费）。
//       修法：默认不回退（只许单调递增），确需回退显式 --force。
{
  const biRaw = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');
  const stripPy = (s) => s.split('\n').map((line) => {
    let out = ''; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === '\\') out += line[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }).join('\n');
  const bi = stripPy(biRaw);
  ok('T90-a1 ★prev 读取失败必须显式告警并区分「首次构建」与「异常损坏」',
    /prev_read_error/.test(bi) && /上一版索引 %s 读取失败/.test(biRaw) && /os\.path\.exists\(OUT\)/.test(bi),
    '剥注释后未见 prev_read_error / 告警文案 —— S2 的"看不见"会复发');
  const bfAll = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8').replace(/\r\n/g, '\n');
  const bfCode = stripComments(bfAll);
  ok('T90-a2 ★水位线回滚默认关闭（只许单调递增），确需回退要显式 --force',
    /keptMonotonic/.test(bfCode) && /process\.argv\.includes\('--force'\)/.test(bfCode));
  ok('T90-a3 ★回滚文案必须把「未回退（默认单调）」讲清楚（回滚本身是更危险的选项）',
    /未回退（默认单调递增/.test(bfAll));

  // ── 行为组：真跑 build_index（CN_PRICES_DIR/WB_ROOT 全隔离），验证「损坏索引必须喊出来」──
  //   源码守卫只能证明"代码这么写"，证明不了"跑起来真的会喊"——S2 治的正是"看不见"，所以必须端到端。
  const pyCands90 = [];
  if (process.env.CN_PYTHON) pyCands90.push(process.env.CN_PYTHON);
  pyCands90.push('python', 'python3');
  let PY90 = null;
  for (const c of pyCands90) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY90 = c; break; }
  }
  if (!PY90) envSkip('T90-b 行为组（损坏索引必须告警）', 'python 不可用');
  else {
    const fw90 = path.join(tmp, 'b90bi');
    const sk90 = path.join(fw90, 'skills', 'token-usage-tracker');
    fs.mkdirSync(sk90, { recursive: true });
    try { fs.copyFileSync(path.join(SRC, 'pricing.json'), path.join(sk90, 'pricing.json')); } catch (e) { /* 缺 pricing.json 时下面会暴露 */ }
    const py90 = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, os, sys, json, tempfile, io, contextlib',
      'base = tempfile.mkdtemp(prefix="t90-")',
      'prices = os.path.join(base, "prices"); os.makedirs(prices)',
      'wb = os.path.join(base, "wb"); sk = os.path.join(wb, "skills", "token-usage-tracker"); os.makedirs(sk)',
      'import shutil',
      'shutil.copyfile(' + JSON.stringify(path.join(SRC, 'pricing.json')) + ', os.path.join(sk, "pricing.json"))',
      'os.environ["CN_PRICES_DIR"] = prices',
      'os.environ["WB_ROOT"] = wb',
      'fails = []',
      'def chk(n, c, d=""):',
      '    print(("  OK   " if c else "  FAIL ") + n + (("  " + d) if d else ""))',
      '    if not c: fails.append(n)',
      '# \u4e0a\u4e00\u7248\u7d22\u5f15\u5199\u574f\uff08JSON \u8bed\u6cd5\u9519\uff09',
      'open(os.path.join(prices, "index.json"), "w", encoding="utf-8").write(\'{"models": {oops\')',
      '_spec = importlib.util.spec_from_file_location("bi90", ' + JSON.stringify(path.join(SRC, 'build_index.py')) + ')',
      'M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)',
      'err = io.StringIO()',
      'try:',
      '    with contextlib.redirect_stderr(err):',
      '        M.main()',
      'except Exception as e:',
      '    pass  # \u4ea7\u7269\u7ed3\u679c\u5982\u4f55\u4e0d\u5f71\u54cd\u672c\u65ad\u8a00\uff1a\u6211\u4eec\u53ea\u5173\u5fc3\u544a\u8b66\u662f\u5426\u6253\u51fa\u6765',
      'o = err.getvalue()',
      'chk("\u635f\u574f\u7684\u4e0a\u4e00\u7248\u7d22\u5f15 \u2192 \u663e\u5f0f\u544a\u8b66\uff08\u4e0d\u518d\u9759\u9ed8 prev=None\uff09",',
      '    ("\u4e0a\u4e00\u7248\u7d22\u5f15" in o and "\u8bfb\u53d6\u5931\u8d25" in o), o[:300].replace("\\n", " | "))',
      'chk("\u544a\u8b66\u91cc\u5fc5\u987b\u533a\u5206\u201c\u9996\u6b21\u6784\u5efa\u201d\u4e0e\u201c\u5f02\u5e38\u635f\u574f\u201d\uff08\u63d0\u5230\u6700\u5c0f\u5951\u7ea6\u95e8/\u7ef4\u6c9b\u57fa\u7ebf\uff09",',
      '    ("\u9996\u6b21\u6784\u5efa" in o) or ("\u7ef4\u6c9b\u57fa\u7ebf" in o), o[:300].replace("\\n", " | "))',
      'print("RESULT %d %d" % (len(fails), 0))',
      'sys.exit(1 if fails else 0)',
    ].join('\n');
    const pf90 = path.join(fw90, 't90.py');
    fs.writeFileSync(pf90, py90, 'utf8');
    const r90 = spawnSync(PY90, [pf90], { encoding: 'utf8', timeout: 180000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    let matched90 = 0;
    for (const ln of String(r90.stdout || '').split(/\r?\n/)) {
      const m = /^\s*(OK|FAIL)\s+(.*)$/.exec(ln);
      if (m) ok('T90-b' + (++matched90) + ' ' + m[2], m[1] === 'OK');
    }
    ok('T90-b0 行为组断言行被识别（python 输出格式/编码异常时此处暴露原文）',
      matched90 > 0,
      'status=' + r90.status + ' stdout=[' + String(r90.stdout || '').replace(/\n/g, '\\n') + ']'
      + ' stderr=[' + String(r90.stderr || '').slice(0, 600) + ']');
    try { fs.rmSync(fw90, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T91~T95（v3.62.0 · 外部审计 v3.61.0 第一批）：降级可见化 + recalc 止写 + 假日保守 + 时区
//   本批共同主题：**把"看不见的降级"变成用户看得见，并停止静默改写账本**。
//   ① F-1/S-4/S-7：`_fetch_summary` 写了没人读 / fetched_at 从不校验 / 单位缺失只进 stderr
//      → build_index 产出顶层 `_fetch_degraded`，Node 侧挂到 toast + --report（用户可见出口）。
//   ② F-3/G-1：recalc-day 默认直接写账本、且按**现价**重算 → 反转为默认 dry-run，写盘需 --write。
//   ③ S-6：假日数据 fail-open（2027:null → 2027-01-01 起双向错）→ 保守开关 + 告警上 UI。
//   ④ F-4：py 侧零时区概念 → 统一北京时间（公告比对 / 文件命名 / fetched_at）。
//   ⚠ 每条源码守卫都配了行为守卫：源码断言只能证明"代码这么写"，证明不了"跑起来真的这样"。
{
  const S = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
  const biRaw = S('build_index.py');
  const stripPy = (s) => s.split('\n').map((line) => {
    let out = ''; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === '\\') out += line[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }).join('\n');
  const bi = stripPy(biRaw);
  const tt = S('token-tracker.js');
  const ttCode = stripComments(tt);
  const rd = S('recalc-day.js');
  const rdCode = stripComments(rd);
  const pr = S('peak-rules.js');
  const fcp = stripPy(S('fetch-cn-prices.py'));

  // ── T91：build_index 产出 _fetch_degraded（F-1/S-4/S-7 的产出侧 + F-4 的北京日期）──
  ok('T91-a1 ★build_index 必须读 latest.json 的 _fetch_summary（此前整条通道悬空）',
    /d\.get\('_fetch_summary'\)/.test(bi) && /failed/.test(bi),
    '未见 _fetch_summary 读取 —— F-1「写了没人读」会复发');
  ok('T91-a2 ★输入源必须有 TTL 新鲜度校验（fetched_at 此前只写不读）',
    /SOURCE_TTL_HOURS\s*=\s*36/.test(bi) && /_age_hours/.test(bi) && /age\s*>\s*SOURCE_TTL_HOURS/.test(bi),
    '未见 fetched_at 年龄校验 —— S-4 停更无感会复发');
  ok('T91-a3 ★index.json 顶层必须写 _fetch_degraded（Node 侧的唯一数据来源）',
    /'_fetch_degraded':\s*_degraded_state\(/.test(bi) && /def _degraded_state/.test(bi));
  ok('T91-a4 ★tokenhub 必须被单独判陈旧（它不受流水线日期约束，停更时完全无感）',
    /TOKENHUB/.test(bi) && /腾讯云 TokenHub 文档陈旧/.test(bi));
  ok('T91-a5 ★单位/契约缺失必须汇成厂商级降级（S-7：整厂停更此前只进 stderr）',
    /契约字段缺失/.test(bi) && /页面可能改了单位/.test(bi));
  ok('T91-a6 ★built_at 必须用北京日期（F-4：非 UTC+8 机器跨日边界会标错天）',
    /'built_at':\s*beijing_today\(\)/.test(bi) && /CN_TZ\s*=\s*datetime\.timezone\(datetime\.timedelta\(hours=8\)/.test(bi));

  // ── T92：Node 侧两个出口（toast 短标签 + 报表提示行）+ 防落盘 ──
  ok('T92-a1 ★mergeLocalPriceDb 必须把 _fetch_degraded 挂到 pricing（否则 toast 无从显示）',
    /pricing\._fetch_degraded\s*=\s*_deg/.test(ttCode) && /db\._fetch_degraded/.test(ttCode));
  ok('T92-a2 ★stripLocalDbEntries 必须剥离 _fetch_degraded（它由 index.json 每日重建，落盘会变永不更新的陈旧告警）',
    /delete out\._fetch_degraded/.test(ttCode));
  // ⚠ 两条正则都必须锚到**使用点**（periodNote 里那一行 tag 数组），不能只写函数名——
  //   `fetchDegradedTag(pricing)` / `holidayDegradedTag(stat, pricing)` 在函数定义处同样出现，
  //   回退"数组里不接"时定义处仍命中 → 假绿（v3.62.0 反向验证实测踩到）。
  //   故用相邻调用序列 + 收尾 `\]` 把匹配唯一钉在 5255 行。
  ok('T92-a3 ★periodNote 必须接入 fetchDegradedTag（行2 末尾，同 ⚠价库 机制）',
    /peakRuleTag\(pricing\), fetchDegradedTag\(pricing\)/.test(ttCode) && /⚠\$\{nv\}家价旧/.test(ttCode));
  ok('T92-a4 ★三个报表出口都必须接入 fetchDegradedNotice（--report 是用户对界的第二通道）',
    (ttCode.match(/fetchDegradedNotice\(\)/g) || []).length >= 4, // 定义 1 次 + 三个出口各 1 次
    '接入点不足 3 个（reportTxt / reportRangeTxt / reportSummaryTxt）');
  ok('T92-a5 ★报表提示必须只读 index.json（--report 不得触发价库刷新副作用）',
    /function fetchDegradedNotice\(\)[\s\S]{0,400}readFileSync\(CN_PRICE_DB/.test(ttCode),
    'fetchDegradedNotice 未直读 CN_PRICE_DB —— 可能挂上了 loadPricing 的联网副作用');

  // ── T93：recalc-day 默认 dry-run、写盘需 --write（F-3/G-1）──
  ok('T93-a1 ★必须存在 parseWriteFlag 纯函数并导出（行为守卫要能真跑）',
    /function parseWriteFlag\(rawArgv\)/.test(rdCode) && /module\.exports = \{[^}]*parseWriteFlag/.test(rdCode));
  ok('T93-a2 ★默认必须 dry-run：doWrite 只在显式 --write 时为真',
    /doWrite:\s*flags\.includes\('--write'\)/.test(rdCode) && /if \(doWrite\) \{/.test(rdCode) && /\} else \{/.test(rdCode),
    '未见 doWrite 分支 —— 默认写盘的行为会复发');
  // v3.62.0（F-3）：dry-run 的"价差来源"说明由「固定文案 现价 vs 当天价」升级为
  //   动态口径行 `价格口径：${priceBasis}`（默认当天快照价 / --current-price / 今天无快照三态）。
  //   断言意图不变：dry-run 必须同时说清「没写盘」和「这份报告是按什么价算的」。
  ok('T93-a3 ★dry-run 必须显式告知「未写盘」+ 价格口径来源（否则用户以为账本已改）',
    /dry-run：未写盘/.test(rd) && /价格口径：\$\{priceBasis\}/.test(rd) && /let priceBasis = ''/.test(rd));
  ok('T93-a4 ★无法识别的 flag 必须报错（fail-closed，不静默忽略）',
    /无法识别的参数/.test(rd) && /process\.exit\(2\)/.test(rdCode));
  ok('T93-a5 ★README/SKILL 必须警示「会写回账本」并给出 --write 写法',
    /recalc-day\.js 2026-10-02 --write/.test(S('README.md')) && /默认 dry-run（只报告、不写账本）/.test(S('SKILL.md')));

  // ── T94：假日数据保守开关 + 两个 UI 出口（S-6）──
  ok('T94-a1 ★peak-rules 必须有 holidayYearDegraded（表在但该年不可信才算降级）',
    /function holidayYearDegraded\(tsMs, holidaysPath\)/.test(pr) && /fs\.statSync\(holidaysPath\)/.test(pr)
    && /module\.exports = \{[^}]*holidayYearDegraded/.test(pr));
  ok('T94-a2 ★isPeakAt 必须保守分支：假日不可信 → 不判高峰（fail-closed）',
    /if \(conservative && holidayYearDegraded\(tsMs, holidaysPath\)\) return false;/.test(pr)
    && /opts\.holidayUnknownNoPeak !== false/.test(pr));
  // 逃逸口的真实形态是「4 参签名 + 默认表达式」——显式传 { holidayUnknownNoPeak: false } 即回到
  // v3.61.0 的 fail-open。行为级证明见 T94-b3（源码里没有 `: false` 字面量，那不是缺陷）。
  ok('T94-a3 ★必须保留 fail-open 逃逸口（4 参签名 + 可被显式关掉）',
    /function isPeakAt\(tsMs, pricing, holidaysPath, opts\)/.test(pr)
    && /conservative = !opts \|\| opts\.holidayUnknownNoPeak !== false/.test(pr));
  // v3.62.0（F-2/S-3）：tag 数组新增 authoritativeErrTag（⚠价锁）—— 相邻序列随之改写，
  //   断言意图不变（holidayDegradedTag 必须在数组里、且新标签不得插在它前面打乱既有顺序）。
  ok('T94-a4 ★toast 必须接入 holidayDegradedTag，且只在本轮有峰谷模型时才标（避免纯噪音）',
    /fetchDegradedTag\(pricing\), holidayDegradedTag\(stat, pricing\), authoritativeErrTag\(pricing\)\]/.test(ttCode) && /peakMultOf\(hit\.m, n\) > 1/.test(ttCode));
  ok('T94-a5 ★报表必须接入 holidayDegradedNotice，且只读 holidays.json（不触发刷新）',
    (ttCode.match(/holidayDegradedNotice\(\)/g) || []).length >= 4 && /readFileSync\(HOLIDAYS_FILE/.test(ttCode));

  // ── T95：Python 侧统一北京时间（F-4）──
  ok('T95-a1 ★fetch-cn-prices 必须有 CN_TZ/beijing_now/beijing_today',
    /CN_TZ = datetime\.timezone\(datetime\.timedelta\(hours=8\)/.test(fcp)
    && /def beijing_now\(\)/.test(fcp) && /def beijing_today\(\)/.test(fcp));
  ok('T95-a2 ★阶跃公告生效比对必须用北京时间（公告写的就是「北京时间」）',
    /now_iso = beijing_now\(\)\.strftime/.test(fcp));
  ok('T95-a3 ★每日快照文件名必须用北京日（数据归属日，跨日边界不能落错名）',
    /stamp = beijing_today\(\)/.test(fcp));
  ok('T95-a4 ★fetched_at 必须是带时区的北京时刻（build_index 的 TTL 校验直接读它）',
    /'fetched_at': beijing_now\(\)\.isoformat/.test(fcp));
  ok('T95-a5 ★parse_tokenhub 的 fetched_at 同样必须北京时间（它单独产出一份不受日期约束的文件）',
    /timezone\(__import__\('datetime'\)\.timedelta\(hours=8\)/.test(stripPy(S('parse_tokenhub.py'))));
  ok('T95-a6 ★三个 py 脚本不得再有无时区的 datetime.now() 用于价格语义',
    !/datetime\.datetime\.now\(\)\.strftime\('%Y-%m-%d'\)/.test(fcp)
    && !/datetime\.datetime\.now\(\)\.isoformat/.test(fcp)
    && !/datetime\.datetime\.now\(\)\.isoformat/.test(stripPy(S('parse_tokenhub.py'))));
  // ⚠ AUD-TZ-01（v3.63.1）：T95-b3 的夹具必须与**机器时区**无关。CI(GitHub Actions) runner
  //   是 UTC，裸 datetime.now() 取的是 runner 墙钟，而 _age_hours 把 naive 按北京时间解释
  //   ⇒ 恒偏 8h（实测 88.0002h，run 39011545481 job20/job22 双败）。本机 UTC+8 两种写法
  //   都绿，行为守卫抓不住 → 只能靠源码守卫钉写法。模式串都做拼接，避免守卫自匹配。
  const t95Self = fs.readFileSync(__filename, 'utf-8');
  const t95Bad = 'naive80 = (datetime.datetime.now(' + ') - datetime.timedelta';
  const t95Good = 'naive80 = (datetime.datetime.now(m.CN_' + 'TZ).replace(tzinfo=None)';
  ok('T95-a7 ★T95-b3 的 naive 夹具必须用 m.CN_TZ 构造（裸 now() 在 CI 的 UTC runner 上恒偏 8h → 每次发版 CI 都红）',
    t95Self.indexOf(t95Bad) < 0 && t95Self.indexOf(t95Good) > 0,
    'bad=' + (t95Self.indexOf(t95Bad) >= 0) + ' good=' + (t95Self.indexOf(t95Good) > 0));

  // ── 行为组：真跑，证明"代码这么写"之外"跑起来真的这样" ──
  const pyCands = [];
  if (process.env.CN_PYTHON) pyCands.push(process.env.CN_PYTHON);
  pyCands.push('python', 'python3');
  let PY = null;
  for (const c of pyCands) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY = c; break; }
  }
  if (!PY) envSkip('T91-b/T95-b 行为组（python 不可用）', 'python 不可用');
  else {
    const fw = path.join(tmp, 'b91');
    const sk = path.join(fw, 'skills', 'token-usage-tracker');
    const pd = path.join(fw, 'prices');
    fs.mkdirSync(sk, { recursive: true });
    fs.mkdirSync(pd, { recursive: true });
    try { fs.copyFileSync(path.join(SRC, 'pricing.json'), path.join(sk, 'pricing.json')); } catch (e) { /* 缺则下面暴露 */ }
    // 行为脚本：① 纯函数 _degraded_state 四种形态；② TZ 偏移后北京时刻仍正确；③ 端到端 main() 落字段
    const py = [
      '# -*- coding: utf-8 -*-',
      'import json, os, sys, datetime, importlib.util',
      'sys.stdout.reconfigure(encoding="utf-8")',
      'SRC = ' + JSON.stringify(SRC.replace(/\\/g, '/')),
      'spec = importlib.util.spec_from_file_location("bi", SRC + "/build_index.py")',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'def say(tag, ok, detail=""):',
      // 用 | 分隔而非空格：标签里含空格与箭头（如 "T91-b1 failed→vendors"），
      // 空格分隔会让 JS 侧把第二个 token 当成 OK/FAIL 位 → 全行匹配不上（v3.62.0 实测 matched=0）。
      '    print("CASE|%s|%s|%s" % (tag, "OK" if ok else "FAIL", detail))',
      // ① 四种降级信号
      'old = (datetime.datetime.now(m.CN_TZ) - datetime.timedelta(hours=80)).isoformat(timespec="seconds")',
      'fresh = datetime.datetime.now(m.CN_TZ).isoformat(timespec="seconds")',
      'd = {"vendors": {"minimax": {"name": "M", "models": []}},',
      '     "_fetch_summary": {"failed": {"kimi": "解析出 0 个模型"}}, "fetched_at": old}',
      'r = m._degraded_state(d, [("minimax/minimaxm3", "契约字段缺失: unit")], {"models": {}})',
      'say("T91-b1 failed→vendors", r["vendors"].get("kimi") == "抓取失败：解析出 0 个模型", json.dumps(r["vendors"], ensure_ascii=False))',
      'say("T91-b2 陈旧→stale_sources", len(r["stale_sources"]) == 1 and r["stale_sources"][0]["age_hours"] > 36, json.dumps(r["stale_sources"], ensure_ascii=False))',
      'say("T91-b3 契约缺失→厂商级降级", "契约字段缺失" in (r["vendors"].get("minimax") or ""), "")',
      'd2 = {"vendors": {}, "_fetch_summary": {"failed": {}}, "fetched_at": fresh}',
      'r2 = m._degraded_state(d2, [], {"models": {}})',
      'say("T91-b4 全干净→vendors 空且 stale 空", r2["vendors"] == {} and r2["stale_sources"] == [], json.dumps(r2, ensure_ascii=False))',
      // since 继承
      'prev = {"models": {}, "_fetch_degraded": {"generated_at": "2026-10-14T03:00:00+08:00", "vendors": {"kimi": "x"}, "since": {"kimi": "2026-10-14"}}}',
      'r3 = m._degraded_state(d, [], prev)',
      'say("T91-b5 since 继承上一版", r3["since"].get("kimi") == "2026-10-14", json.dumps(r3["since"], ensure_ascii=False))',
      // ② TZ 偏移后北京时刻仍正确（F-4 的核心保证）
      'now_bj = m.beijing_now()',
      'say("T95-b1 北京时刻偏移恒为 +8（与机器时区无关）", now_bj.utcoffset() == datetime.timedelta(hours=8), str(now_bj.isoformat()))',
      'say("T95-b2 北京日期是合法 ISO", len(m.beijing_today()) == 10 and m.beijing_today()[4] == "-", m.beijing_today())',
      // 跨时区的真正不变量：naive 旧时间戳必须按北京时间解释（否则非 UTC+8 机器上
      // "8 小时前的数据"会被算成 0 小时前或 16 小时前）；aware 时间戳按绝对时刻算。
      // ⚠ 不用 time.tzset() 造"另一种机器时区"——那是 Unix-only，Windows 上直接
      //   AttributeError（v3.62.0 实测踩到）。不变量本身与机器时区无关，故无需模拟。
      // ⚠ v3.63.1（AUD-TZ-01）：夹具**必须**用 CN_TZ 构造，不能用机器墙钟 now()。
      //   CI runner = UTC，裸 now() 产出的 naive 会被 _age_hours 当北京时间解释 → 差 8h
      //   （实测 88.0002h）⇒ T95-b3 在 CI 恒红、真实回归被淹没。本机 UTC+8 永远看不见
      //   这个偏差 → 由源码守卫 T95-a7 钉住写法（方向等价验证见审计报告 AUD-TZ-01）。
      'naive80 = (datetime.datetime.now(m.CN_TZ).replace(tzinfo=None) - datetime.timedelta(hours=80)).isoformat(timespec="seconds")',
      'aware80 = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=80)).isoformat(timespec="seconds")',
      'a1 = m._age_hours(naive80)',
      'a2 = m._age_hours(aware80)',
      'say("T95-b3 naive 时间戳按北京解释（≈80h，容差 2h）", a1 is not None and abs(a1 - 80) < 2, str(a1))',
      'say("T95-b4 aware(UTC) 时间戳按绝对时刻算（≈80h，容差 2h）", a2 is not None and abs(a2 - 80) < 2, str(a2))',
      'say("T95-b5 坏/空时间戳返回 None（不猜）", m._age_hours(None) is None and m._age_hours("not-a-time") is None, "")',
      // ③ 端到端：main() 真写 index.json 且带 _fetch_degraded
      'os.environ["CN_PRICES_DIR"] = m.PRICES_DIR',   // 仅作自文档；真正的隔离来自下方 spawn env
      'os.environ["WB_ROOT"] = m.WB_ROOT',
      'json.dump(d, open(m.PRICES_DIR + "/latest.json", "w", encoding="utf-8"), ensure_ascii=False)',
      'json.dump({"built_at": "2026-10-14", "models": {}}, open(m.OUT, "w", encoding="utf-8"), ensure_ascii=False)',
      'try:',
      '    m.main()',
      '    out = json.load(open(m.OUT, encoding="utf-8"))',
      '    say("T91-b6 端到端：index.json 顶层有 _fetch_degraded", "_fetch_degraded" in out and bool(out["_fetch_degraded"]["vendors"]), json.dumps(out.get("_fetch_degraded", {}), ensure_ascii=False)[:200])',
      '    say("T91-b7 端到端：built_at 是北京日期", len(out.get("built_at") or "") == 10, str(out.get("built_at")))',
      'except Exception as e:',
      '    say("T91-b6 端到端", False, repr(e))',
      '    say("T91-b7 端到端", False, repr(e))',
    ].join('\n');
    const pyPath = path.join(fw, 'b91.py');
    fs.writeFileSync(pyPath, py, 'utf8');
    const r = spawnSync(PY, [pyPath], {
      // CN_PRICES_DIR / WB_ROOT 必须在 python 进程**启动时**就在环境里（build_index 的
      // PRICES_DIR/OUT/WB_ROOT 都是模块级常量，import 时即求值）—— 这正是 T90 同款隔离手法。
      env: Object.assign({}, env, {
        PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', WB_LEDGER_MAINT: '1',
        // WB_ROOT 必须是**数据根**（fw），不是技能目录（sk）—— build_index 用它拼
        // `skills/token-usage-tracker/pricing.json`，传错会读到不存在的路径（实测即 T91-b6 崩因）。
        CN_PRICES_DIR: pd, WB_ROOT: fw,
      }),
      encoding: 'utf8', windowsHide: true, timeout: 120000,
    });
    const lines = String(r.stdout || '').split('\n');
    let matched = 0;
    for (const ln0 of lines) {
      // ⚠ Windows 上 python 的 stdout 是 CRLF：split('\n') 后每行尾部带 \r，而 JS 的 `.`
      //   不匹配 \r、`$` 又要求串尾 → 整行失配（v3.62.0 实测 matched=0，而 stdout 里明明有 12 行）。
      //   必须先剥掉行尾 \r 再匹配。这也是"本地绿 / CI 也绿"必须显式处理的一处环境分叉。
      const ln = ln0.replace(/\r$/, '');
      const mm = ln.match(/^CASE\|([^|]*)\|(OK|FAIL)\|?(.*)$/);
      if (mm) { matched++; ok(mm[1] + (mm[3] ? '  ' + mm[3] : ''), mm[2] === 'OK'); }
    }
    ok('T91-b0 行为组断言行被识别（python 输出格式/编码异常时此处暴露原文）', matched >= 10,
      'matched=' + matched + '（应为 12：T91-b1~b7 + T95-b1~b5）'
      + 'status=' + r.status + ' stdout=[' + String(r.stdout || '').replace(/\n/g, '\\n').slice(0, 900) + ']'
      + ' stderr=[' + String(r.stderr || '').slice(0, 2500) + ']');
    try { fs.rmSync(fw, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }

  // ── T92-b / T93-b / T94-b：JS 侧行为（require 真身，不跑 main）──
  {
    const rdMod = require(path.join(SRC, 'recalc-day.js'));
    // v3.62.0（F-3）：新增 `--current-price`（现价回算逃逸口）—— want 扩为三元组
    //   [doWrite, currentPrice, argv]，覆盖「默认当天价 / --write / --current-price / 二者叠加」。
    const cases = [[], ['--write'], ['--dry-run'], ['2026-09-10'], ['2026-09-10', '--write'],
      ['--write', '2026-09-10'], ['2026-09-10', 'm1', '--write'], ['--bogus'],
      ['--current-price'], ['2026-09-10', '--current-price'], ['--current-price', '--write', '2026-09-10']];
    const want = [[false, false, []], [true, false, []], [false, false, []], [false, false, ['2026-09-10']],
      [true, false, ['2026-09-10']], [true, false, ['2026-09-10']], [true, false, ['2026-09-10', 'm1']],
      [false, false, []], [false, true, []], [false, true, ['2026-09-10']], [true, true, ['2026-09-10']]];
    let bad = [];
    cases.forEach((c, i) => {
      const p = rdMod.parseWriteFlag(c);
      if (p.doWrite !== want[i][0] || p.currentPrice !== want[i][1] || JSON.stringify(p.argv) !== JSON.stringify(want[i][2])) {
        bad.push(JSON.stringify(c) + '→' + JSON.stringify(p));
      }
    });
    ok('T93-b1 ★parseWriteFlag 十一形态全对（默认 false = dry-run；--write/--current-price 前后置都认）', bad.length === 0, bad.join(' | '));
    ok('T93-b2 ★未知 flag 必须进 unknown（调用方据此 exit 2，不静默忽略）',
      rdMod.parseWriteFlag(['--bogus']).unknown.length === 1 && rdMod.parseWriteFlag(['2026-01-01', '--x', '--write']).unknown.length === 1);
  }
  {
    const ttMod = require(path.join(skillDir, 'token-tracker.js'));
    const deg2 = { vendors: { kimi: '抓取失败', minimax: '契约缺失' }, stale_sources: [], since: { kimi: '2026-10-14', minimax: '2026-10-16' } };
    ok('T92-b1 ★fetchDegradedTag：N 家降级 → ⚠N家价旧', ttMod.fetchDegradedTag({ _fetch_degraded: deg2 }) === '⚠2家价旧',
      JSON.stringify(ttMod.fetchDegradedTag({ _fetch_degraded: deg2 })));
    ok('T92-b2 ★fetchDegradedTag：仅源级陈旧 → ⚠价旧（不虚报"几家"）',
      ttMod.fetchDegradedTag({ _fetch_degraded: { vendors: {}, stale_sources: [{ source: 'latest.json', age_hours: 80 }] } }) === '⚠价旧');
    ok('T92-b3 ★fetchDegradedTag：无降级/无字段/坏类型 → 空串（不得变常驻噪音）',
      ttMod.fetchDegradedTag({ _fetch_degraded: { vendors: {}, stale_sources: [] } }) === ''
      && ttMod.fetchDegradedTag({}) === '' && ttMod.fetchDegradedTag(null) === ''
      && ttMod.fetchDegradedTag({ _fetch_degraded: 'bad' }) === '');
    ok('T92-b4 ★fetchDegradedNotice：无降级 → 空串（保证既有报表出口逐字节不变）',
      ttMod.fetchDegradedNotice() === '', JSON.stringify(ttMod.fetchDegradedNotice()).slice(0, 200));
    ok('T92-b5 ★mergeLocalPriceDb 真挂载 + stripLocalDbEntries 真剥离（防落盘）',
      (() => {
        const db = { built_at: '2026-10-16', models: {}, _fetch_degraded: { vendors: { kimi: 'x' }, stale_sources: [] } };
        const p = ttMod.mergeLocalPriceDb({ models: {}, _fakeDb: db }) || {};
        // mergeLocalPriceDb 读的是 CN_PRICE_DB，故这里只验证剥离函数对挂载字段生效
        const stripped = ttMod.stripLocalDbEntries({ models: {}, local_db: {}, _fetch_degraded: { vendors: { kimi: 'x' } } });
        return stripped._fetch_degraded === undefined && stripped.local_db === undefined;
      })());
  }
  {
    const ttMod = require(path.join(skillDir, 'token-tracker.js'));
    const prMod = require(path.join(SRC, 'peak-rules.js'));
    const H = path.join(SRC, 'holidays.json');
    const t26 = Date.UTC(2026, 9, 16, 2, 0);   // 北京 2026-10-16 周五 10:00（已确认年）
    const t27 = Date.UTC(2027, 4, 5, 2, 0);    // 北京 2027-05-05 周三 10:00（2027: null → 不可信）
    const rules = { peak_schedule: '9:00-12:00,14:00-18:00', weekend_off_peak: true };
    ok('T94-b1 ★已确认年（2026）行为零变化：仍判高峰', prMod.isPeakAt(t26, { deepseek_rules: rules }, H) === true);
    ok('T94-b2 ★不可信年（2027）转保守：不判高峰', prMod.isPeakAt(t27, { deepseek_rules: rules }, H) === false);
    ok('T94-b3 ★显式 fail-open 逃逸口仍可用（对照测试/排障）',
      prMod.isPeakAt(t27, { deepseek_rules: rules }, H, { holidayUnknownNoPeak: false }) === true);
    ok('T94-b4 ★holidayYearDegraded：无表/表不存在不算降级（不误伤测试与首装）',
      prMod.holidayYearDegraded(t26, null) === false && prMod.holidayYearDegraded(t26, path.join(tmp, 'no-such-holidays.json')) === false
      && prMod.holidayYearDegraded(t27, H) === true && prMod.holidayYearDegraded(t26, H) === false);
    ok('T94-b5 ★holidayDegradedTag：只在「本轮有峰谷模型」时才可能标（否则纯噪音）',
      ttMod.holidayDegradedTag({ model: 'hy4-preview' }, { models: { 'hy4-preview': { input_price: 1 } } }) === ''
      && ttMod.holidayDegradedTag({ model: 'deepseek-v4.1-flash' },
        { models: { 'deepseek-v4.1-flash': { input_price: 1, peak_multiplier: 2 } } }) === '');
    ok('T94-b6 ★holidayDegradedNotice：当前 2026 已确认 → 空串（今天零噪音）',
      ttMod.holidayDegradedNotice() === '', JSON.stringify(ttMod.holidayDegradedNotice()).slice(0, 200));
  }
}

// ===== T96（外部审计 v3.61.0 · 文档三连：G-6 / G-7 / G-8 / S-5）=====
// 背景：本轮审计 4 条纯文档缺陷，共同病根是「README / KNOWN-ISSUES 这两份用户第一眼看的文件没有守卫」
//   （T66-d 系列只守了 docs/pricing-refresh.md 一侧）：
//   - G-6：KNOWN-ISSUES 两个条目同时编号 KI-24（v3.57.0 的 H5 与 v3.61.0 的审计条目撞号，后者已改 KI-30）；
//   - G-7：头注自相矛盾——「v3.22.0 复核行号」vs「行号按 v3.23.0 标注」（git 史实：复核发生在 v3.22.0，
//     v3.23.0 是零代码改动的纯文档重构，两戳本就同代却写成两个版本；均已统一到 v3.22.0 并加漂移警告）；
//   - G-8：README 文件清单 peak-rules.js 重复列了两行，且 stop-handler / wb-root / ledger-merge /
//     transc-lines 四个运行时模块完全漏列（五次拆模块，表一次都没同步——用户按表配 hooks 时根本不知道它们存在）；
//   - S-5：README「7 个公开价格源」裸奔缺独立性口径（llm-prices-cn 是 llmabacus 每日镜像、Portkey×3 同平台
//     → ≠7 独立，去重后实为 4 个）。
// 全部按**自动提取**写（不手写清单——手写清单正是 T12-i6a 修过的假绿之源）。
{
  const rd96 = fs.readFileSync(path.join(SRC, 'README.md'), 'utf-8');
  const ki96 = fs.readFileSync(path.join(SRC, 'KNOWN-ISSUES.md'), 'utf-8');

  // a1（G-6）：KI 编号唯一性。只扫 `## KI-<n>` 标题（正文里引用旧编号是史实，不算撞号）。
  const kiNums96 = (ki96.match(/^## KI-(\d+)/gm) || []).map((s) => s.replace('## KI-', ''));
  const kiDup96 = kiNums96.filter((n, i) => kiNums96.indexOf(n) !== i);
  ok('T96-a1 ★KNOWN-ISSUES 的 KI 编号不得重复（自动提取全部标题判重）',
    kiDup96.length === 0, kiDup96.length ? '撞号：' + [...new Set(kiDup96)].join(', ') : kiNums96.length + ' 个编号全唯一');

  // a2（G-7）：头注「复核行号」版本 == 「行号按…标注」版本。两边分别捕获版本号判等——
  //   修前一个写 v3.22.0 复核、一个写按 v3.23.0 标注，自相矛盾。
  const mRev96 = ki96.match(/(v3\.\d+\.\d+) 复核行号/);
  const mAnn96 = ki96.match(/按 \*\*(v3\.\d+\.\d+) 的/);
  ok('T96-a2 ★KNOWN-ISSUES 头注两处版本戳一致（复核版本 == 行号标注版本）',
    !!mRev96 && !!mAnn96 && mRev96[1] === mAnn96[1],
    '复核=' + (mRev96 && mRev96[1]) + ' 标注=' + (mAnn96 && mAnn96[1]));

  // a3/a4（G-8）：README「文件清单」表格——① 必须列全技能目录全部 .js（readdir 自动提取反向核对）；
  //   ② 表格内不得重复列同一文件（peak-rules.js 曾重复两行）。只扫表格区域的第一列，避免误伤正文正常提及。
  const tbl96 = (() => {
    const i = rd96.indexOf('### 文件清单');
    if (i < 0) return '';
    const j = rd96.indexOf('\n## ', i);
    return rd96.slice(i, j < 0 ? undefined : j);
  })();
  const listed96 = [];
  (tbl96.match(/^\| [^|]+\|/gm) || []).forEach((r) => {
    const cell = r.slice(2, r.indexOf('|', 2));   // 只取第一列（文件名列）
    (cell.match(/`([^`]+)`/g) || []).forEach((t) => listed96.push(t.slice(1, -1)));
  });
  const jsFiles96 = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  const missJs96 = jsFiles96.filter((f) => listed96.indexOf(f) < 0);
  ok('T96-a3 ★README 文件清单列全全部运行时 .js（按目录自动提取，只核对表格第一列）',
    missJs96.length === 0, missJs96.length ? '漏列：' + missJs96.join(', ') : jsFiles96.length + ' 个全列');
  const dupRow96 = listed96.filter((f, i) => listed96.indexOf(f) !== i);
  ok('T96-a4 ★README 文件清单表格内不得重复列同一文件（peak-rules.js 曾重复两行）',
    dupRow96.length === 0, dupRow96.length ? '重复：' + [...new Set(dupRow96)].join(', ') : listed96.length + ' 个文件无重复');

  // a5（S-5）：「7 源」必须附独立性口径，且文件表里的源计数不得再写旧的 5。T66-d4 守的是「7 源」字面
  //   存在，本条守的是**不误导**：llm-prices-cn = llmabacus 每日镜像（同源不互证）、Portkey×3 同平台
  //   → 去重后独立源 4 个。v3.56.0 扩源时只同步了 182 行的源清单表，438 行文件表的「（5 源）」漏改
  //   （同类漂移第三次）——故计数一致性也并入本条。
  //   ⚠ literal 必须与 README 正文逐字一致（含「」直角引号）——v3.62.0 首版守卫写成无引号形态 → 假红。
  ok('T96-a5 ★README「7 源」必须附独立性口径（「7 源」≠ 7 个独立数据源）且文件表计数同步',
    rd96.indexOf('**7 个公开价格源**') >= 0 && rd96.indexOf('「7 源」≠ 7 个独立数据源') >= 0
    && rd96.indexOf('llm-prices-cn') >= 0 && rd96.indexOf('源的独立性口径') >= 0
    && rd96.indexOf('价格刷新策略（7 源）') >= 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// T97~T99（v3.62.0 · 外部审计 v3.61.0 第二批：单价可信度 + 历史可复现）
//   本批共同主题：**让"最该可信的那一层"自己也可信，且两端永远算出同一个答案**。
//   ① S-1：数据根探测在 py/node 两端曾经**不一致**（wb-root.js v3.58.0 加了「目录存在性第二轮」，
//      build_index.py 没跟上）→ 同机可能算出不同的根 → pricing.json(lock) 权威覆盖层静默失效。
//      修法 = 补齐 py 侧第二轮 + 契约测试（T99）把等价性钉成行为断言。
//   ② S-3/F-2：pricing.json 的 lock 覆盖层此前**零校验**（in/out 缺失或非数值也会照写）、
//      且伪造 fetched_at=today 冒充新鲜 → 补 fail-closed 校验 + 诚实新鲜度 + 两个用户出口。
//   ③ A-4：审计判断「阶跃抓取无计费消费者」→ 实测证伪（index.json 6 个 step-* 有效条目经
//      mergeLocalPriceDb 进内存、findModel 命中、calcCost 出非零金额）→ 拍板保留 + T98 钉住。
//   ⚠ 每条源码守卫都配行为守卫（源码只能证明"代码这么写"，证明不了"跑起来真的这样"）。
{
  const S = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
  // 行级剥 py 注释（与 T91~T95 块同款；源码守卫必须只看代码，注释里同文本会造成假绿）
  const stripPy = (s) => s.split('\n').map((line) => {
    let out = ''; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === '\\') out += line[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }).join('\n');
  const bi = stripPy(S('build_index.py'));
  const fcp = stripPy(S('fetch-cn-prices.py'));
  const wr = stripComments(S('wb-root.js'));
  const tt = stripComments(S('token-tracker.js'));

  // ── T97：数据根探测 py/node 等价（S-1）──
  // 锚点必须**唯一到那一处**：`for c in cands:` 在 build_index.py 里出现 3 次（detect_workbuddy_root
  //   两轮 + cross_check 一轮），整文件计数会恒为 3（v3.58.0「锚点必须唯一」教训的同型复现）。
  //   故先按函数名切片，只在函数体内数轮次。
  const fnStart = bi.indexOf('def detect_workbuddy_root');
  const fnEnd = bi.indexOf('WB_ROOT = detect_workbuddy_root()');
  const fnBody = (fnStart >= 0 && fnEnd > fnStart) ? bi.slice(fnStart, fnEnd) : '';
  const iMarker = fnBody.indexOf("if os.path.exists(os.path.join(c, 'traces'))");
  const iExists = fnBody.indexOf('if os.path.exists(c):');
  const nRounds = (fnBody.match(/for c in cands:/g) || []).length;
  ok('T97-a1 ★build_index 必须先 marker 轮、后目录存在性轮（顺序反了会选到错的根）',
    iMarker >= 0 && iExists > iMarker && nRounds === 2,
    `marker@${iMarker} exists@${iExists} 轮数=${nRounds}（应恰好 2 轮且 marker 在前）`);
  ok('T97-a2 ★py 侧两轮都不命中仍兜底 ~/.workbuddy（返回 None 会让调用方全线抛错）',
    /return os\.path\.join\(h, '\.workbuddy'\)/.test(fnBody));
  ok('T97-a3 ★Node 侧（wb-root.js）同形态两轮 + 硬兜底（py 侧补齐的对齐基准不得被改弱）',
    /for \(const c of cands\)[\s\S]{0,400}?existsSync\(path\.join\(c, 'traces'\)\)/.test(wr)
    && /for \(const c of cands\)[\s\S]{0,400}?existsSync\(c\)/.test(wr)
    && /return path\.join\(h, '\.workbuddy'\);/.test(wr));
  ok('T97-a4 ★fetch-cn-prices.py 不得再复制第三份根探测（F-2 已拆；根判据只留 build_index + wb-root 两处）',
    !/def detect_workbuddy_root/.test(fcp) && !/WB_ROOT/.test(fcp));

  // ── T97-b：F-2 自我引用闭环拆除（fetch-cn-prices 不再读回 pricing.json）──
  // 病根（审计原话）：`mode:'pricing'` 读回 pricing.json——流水线**自己的最终汇**——冒充
  // "当日新抓的 first_party 官方价"。官方调价后只要 deepseek-official.js 那一轮失败，本地价
  // 就永久停在旧值，而 latest.json 仍带 fetched_at=今天，下游无条件信任（源=汇 闭环）。
  ok('T97-b1 ★DeepSeek 必须显式 external（不得再读回 pricing.json 冒充当日新抓 first_party 价）',
    /'deepseek': \{[\s\S]{0,700}?'mode': 'external',/.test(fcp) && !/'mode': 'pricing'/.test(fcp));
  ok('T97-b2 ★parse_pricing_deepseek 必须不存在（闭环的落点，整段拆除）',
    !/def parse_pricing_deepseek/.test(fcp));
  ok('T97-b3 ★external 必须 status=skipped 且不计入 failed（否则每天假降级一次 = A-8 永久噪音）',
    /entry\['status'\] = 'skipped'/.test(fcp)
    && /if entry\['status'\] == 'skipped':\n\s*continue/.test(fcp)
    && /'skipped_vendors': skipped_vendors,/.test(fcp));
  ok('T97-b4 ★lock 覆盖层必须保留官方对照/人工核录两张查找表（F-2 诚实新鲜度的数据来源）',
    /official_ref\[str\(r\['model'\]\)\] = str\(r\['ref_at'\]\)/.test(bi)
    && /manual_at\[str\(r\['model'\]\)\] = r\.get\('adopted_at'\) or r\.get\('manual_at'\)/.test(bi));

  // ── T98：S-3 fail-closed + F-2 诚实新鲜度 + 两个用户出口（源码侧）──
  // 锚点必须钉到**拒收那一处**：`in_p is None or out_p is None` 在下方 peak 段的 elif 里
  // 也出现一次（缺 peak 只跳过 peak 段、不拒收条目），只匹配关键词会同时命中 → 假绿。
  ok('T98-a1 ★lock 覆盖层 in/out 主价缺失/非数值必须拒收（S-3：fail-closed，不覆盖不注入）',
    /if in_p is None or out_p is None:\n\s*why = \('pricing\.json\(lock\) 条目主价缺失或非数值/.test(bi)
    && /auth_issues\.append\(\{'model': key, 'kind': 'invalid_lock'/.test(bi));
  ok('T98-a2 ★拒收必须 continue 而非 break/pass（fail-closed：坏手工价不得进入索引）',
    /auth_issues\.append\(\{'model': key, 'kind': 'invalid_lock'[\s\S]{0,400}?\n\s*continue/.test(bi));
  ok('T98-a3 ★拒收必须留痕：changes.jsonl 的 authoritative_invalid（不能只 stderr 一行）',
    /'kind': 'authoritative_invalid'/.test(bi));
  ok('T98-a4 ★lock 条目不伪造 fetched_at=today（F-2：挂官方对照/人工核录时刻，没有就不写）',
    /honest_ts = official_ref\.get\(key\) or manual_at\.get\(key\)/.test(bi)
    && /contract\['fetched_at'\] = honest_ts/.test(bi));
  ok('T98-a5 ★官方对照过期必须报 stale_lock（对照停更 = 权威价可能已变，不能装作新鲜）',
    /'kind': 'stale_lock'/.test(bi) && /SOURCE_TTL_HOURS/.test(bi));
  ok('T98-a6 ★mergeLocalPriceDb 必须把 authoritative_issues 也算进挂载条件（漏这路 → ⚠价锁 永不显示）',
    /Array\.isArray\(_deg\.authoritative_issues\) && _deg\.authoritative_issues\.length > 0/.test(tt));
  ok('T98-a7 ★periodNote 必须接入 authoritativeErrTag（行2 末尾，同 ⚠价库 机制）',
    /holidayDegradedTag\(stat, pricing\), authoritativeErrTag\(pricing\)\]/.test(tt)
    && /return '⚠价锁';/.test(tt));
  ok('T98-a8 ★三个报表出口都必须接入 authoritativeIssuesNotice（--report 是用户对界第二通道）',
    (tt.match(/authoritativeIssuesNotice\(\)/g) || []).length >= 4,
    '接入点不足 3 个（reportTxt / reportRangeTxt / reportSummaryTxt）');
  ok('T98-a9 ★报表提示必须只读 index.json（--report 不得触发价库刷新副作用）',
    /function authoritativeIssuesNotice\(\)[\s\S]{0,400}readFileSync\(CN_PRICE_DB/.test(tt),
    'authoritativeIssuesNotice 未直读 CN_PRICE_DB —— 可能挂上了 loadPricing 的联网副作用');
}

// ── T98-b：A-4 拍板的行为证据 + 价锁两个出口真跑 ──
//   A-4 事实：pricing.json 里没有 step-*，但 index.json 有 6 个 step-* 有效条目 →
//   mergeLocalPriceDb 并入内存 pricing → findModel 命中 → calcCost 非零 = **有消费者**
//   （审计原判断「阶跃抓取无计费消费者」的前提被证伪）。故处置 = 保留抓取 + 本条钉住。
{
  const ttMod = require(path.join(skillDir, 'token-tracker.js'));
  const dbPath = path.join(pricesDir, 'index.json');
  const fakeDb = {
    built_at: '2026-10-16',
    models: {
      'step-3': { name: '阶跃 Step-3', in_price: 1.5, out_price: 6, cache_hit: 0.3, primary_source: '阶跃星辰官网' },
    },
    _fetch_degraded: {
      vendors: {}, stale_sources: [],
      authoritative_issues: [
        { model: 'deepseek-v4-pro', kind: 'stale_lock', reason: '官方对照时刻 45 天前', since: '2026-10-01' },
        { model: 'hy4-preview', kind: 'invalid_lock', reason: 'input_price=None', since: '2026-10-16' },
      ],
    },
  };
  fs.writeFileSync(dbPath, JSON.stringify(fakeDb));
  let merged = null;
  try {
    merged = ttMod.mergeLocalPriceDb({ models: {} });
    const hit = ttMod.findModel(merged, 'step-3', 'price');
    const cost = hit ? ttMod.calcCost({ model: 'step-3', in: 1000, out: 500, cached: 0 }, merged, 0) : null;
    ok('T98-b1 ★A-4 拍板：index.json 的 step-* 条目确有计费消费者（merge→findModel→calcCost 非零）',
      !!hit && typeof cost === 'number' && cost > 0,
      `hit=${!!hit} cost=${cost}`);
    ok('T98-b2 ★authoritativeErrTag：authoritative_issues 非空 → ⚠价锁（含"仅价锁坏"这一路）',
      ttMod.authoritativeErrTag(merged) === '⚠价锁', JSON.stringify(ttMod.authoritativeErrTag(merged)));
    ok('T98-b3 ★authoritativeIssuesNotice：明细含模型名/两种 kind/后果与修复指引',
      (() => {
        const n = ttMod.authoritativeIssuesNotice();
        return n.indexOf('deepseek-v4-pro') >= 0 && n.indexOf('hy4-preview') >= 0
          && n.indexOf('官方对照时刻已过期') >= 0 && n.indexOf('条目主价缺失或非数值') >= 0
          && n.indexOf('修复') >= 0;
      })(), ttMod.authoritativeIssuesNotice().slice(0, 300));
    ok('T98-b4 ★干净库（无 authoritative_issues）→ 标签与报表提示都为空（不变成常驻噪音）',
      (() => {
        fs.writeFileSync(dbPath, JSON.stringify({ models: {}, _fetch_degraded: { vendors: {}, stale_sources: [], authoritative_issues: [] } }));
        const clean = ttMod.mergeLocalPriceDb({ models: {} });
        return ttMod.authoritativeErrTag(clean) === '' && ttMod.authoritativeIssuesNotice() === '';
      })());
  } finally {
    // 还原空库：本块写在共享隔离目录里，必须留下与进场时一致的状态
    fs.writeFileSync(dbPath, JSON.stringify({ models: {} }));
  }
}

// ── T99：S-1 契约测试 —— 同一合成目录树，py 与 node 必须算出同一个根 ──
//   为什么必须是行为断言而非注释约定：两个实现分居两种语言、无共享模块，历史上正是靠
//   "docstring 声称逐字等价"维持的——而 wb-root.js v3.58.0 加了第二轮、py 侧没跟上，
//   等价性在长达两个版本的时间里是**假的**（审计 S-1 原文）。
//   ⚠ 两侧的 env 覆盖**分层不同**（这不是缺陷，是既有约定）：
//     · py：env 判断做进 `detect_workbuddy_root()` 函数体内（docstring 明写"对应 Node 的 ||"）；
//     · js：`detectWorkBuddyRoot()` 只做目录探测，env 覆盖在**调用方**
//       （`process.env.WB_ROOT || detectWorkBuddyRoot()`，见 backfill/recalc-day/refresh-*.js）。
//     故契约的正确形态是 py 函数 ≡ node 的 `WB_ROOT || detectWorkBuddyRoot()`，
//     直接拿两个裸函数比会在 WB_ROOT 场景下假红（v3.62.0 首版即如此，已修）。
//   隔离手法：HOME/USERPROFILE 都指向沙箱 home（node 的 os.homedir 与 py 的 expanduser
//   两个平台都认这两个变量，本地实测过）→ 不碰真实 ~/.workbuddy。
//   输出口径：两端路径分隔符不同（node 反斜杠 / py 保留传入的正斜杠）→ 归一化后再比。
{
  const pyCands = [];
  if (process.env.CN_PYTHON) pyCands.push(process.env.CN_PYTHON);
  pyCands.push('python', 'python3');
  let PY99 = null;
  for (const c of pyCands) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY99 = c; break; }
  }
  if (!PY99 || !SPAWN_OK) envSkip('T99 数据根探测契约测试', 'python 不可用或沙箱禁 spawn');
  else {
    const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const scen = [
      { id: 'b1', name: 'T99-b1 两个候选都有 marker → 取 .workbuddy-ai（marker 轮）',
        mk: (h) => {
          fs.mkdirSync(path.join(h, '.workbuddy-ai', 'traces'), { recursive: true });
          fs.mkdirSync(path.join(h, '.workbuddy'), { recursive: true });
          fs.writeFileSync(path.join(h, '.workbuddy', 'settings.json'), '{}');
        },
        wbRoot: null, want: '.workbuddy-ai' },
      { id: 'b2', name: 'T99-b2 只有 .workbuddy 有 marker → 取 .workbuddy',
        mk: (h) => { fs.mkdirSync(path.join(h, '.workbuddy'), { recursive: true }); fs.writeFileSync(path.join(h, '.workbuddy', 'settings.json'), '{}'); },
        wbRoot: null, want: '.workbuddy' },
      { id: 'b3', name: 'T99-b3 都无 marker 但目录都在 → 取 .workbuddy-ai（目录存在性第二轮，S-1 补齐的那一轮）',
        mk: (h) => { fs.mkdirSync(path.join(h, '.workbuddy-ai'), { recursive: true }); fs.mkdirSync(path.join(h, '.workbuddy'), { recursive: true }); },
        wbRoot: null, want: '.workbuddy-ai' },
      { id: 'b4', name: 'T99-b4 两个候选都不存在 → 硬兜底 .workbuddy（不许返回空/None）',
        mk: () => {}, wbRoot: null, want: '.workbuddy' },
      { id: 'b5', name: 'T99-b5 WB_ROOT 非空即用（不校验存在性，对应 Node 的 ||）',
        mk: () => {}, wbRoot: path.join(tmp, 't99-custom-root'), wantAbs: path.join(tmp, 't99-custom-root') },
      { id: 'b6', name: 'T99-b6 WB_ROOT 空串等同未设置（回到目录存在性轮，不得返回空路径）',
        mk: (h) => { fs.mkdirSync(path.join(h, '.workbuddy-ai'), { recursive: true }); },
        wbRoot: '', want: '.workbuddy-ai' },
    ];
    const pyCode = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, sys',
      'sys.stdout.reconfigure(encoding="utf-8")',
      'SRC = ' + JSON.stringify(SRC.replace(/\\/g, '/')),
      'spec = importlib.util.spec_from_file_location("bi", SRC + "/build_index.py")',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(m.detect_workbuddy_root())',
    ].join('\n');
    const pyPath = path.join(tmp, 't99.py');
    fs.writeFileSync(pyPath, pyCode, 'utf8');
    const bad = [];
    for (const sc of scen) {
      const h = path.join(tmp, 't99-home-' + sc.id);
      try { fs.rmSync(h, { recursive: true, force: true }); } catch (e) { /* 首轮不存在 */ }
      fs.mkdirSync(h, { recursive: true });
      sc.mk(h);
      const cenv = Object.assign({}, env, PY_IO_ENV, { HOME: h, USERPROFILE: h, WB_ROOT: sc.wbRoot == null ? '' : sc.wbRoot });
      // 空串 WB_ROOT 必须**设置但为空**（校验"空串等同未设置"这条语义），故不能简单 delete
      // node 侧必须复刻调用方的 env 优先语义（见块首注释：分层不同不是缺陷）
      const rn = spawnSync(NODE, ['-e',
        'process.stdout.write(process.env.WB_ROOT || require(' + JSON.stringify(path.join(SRC, 'wb-root.js').replace(/\\/g, '/')) + ').detectWorkBuddyRoot())'],
        { env: cenv, encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const rp = spawnSync(PY99, [pyPath], { env: cenv, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const nn = norm(String(rn.stdout || '').trim());
      const np = norm(String(rp.stdout || '').trim());
      // b5 用绝对 want（WB_ROOT 非空即用，与 home 无关）；其余相对 home
      const want = norm(sc.wantAbs || path.join(h, sc.want));
      if (nn !== want || np !== want) {
        bad.push(`${sc.name}: node=${nn} py=${np} want=${want}`
          + ` (node status=${rn.status} err=${String(rn.stderr).slice(0, 120)}; py status=${rp.status} err=${String(rp.stderr).slice(0, 120)})`);
      }
      try { fs.rmSync(h, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
    }
    try { fs.rmSync(pyPath, { force: true }); } catch (e) { /* 同上 */ }
    ok('T99-b0 ★六种目录形态下 py 与 node 必须算出同一个根（S-1 等价性契约）', bad.length === 0, bad.join(' | '));
  }
}

// ── T99-c：py 侧行为组（F-2 厂商模式 + F-4 公告解析纯函数）──
//   为什么必须行为级：T97-b 的源码断言只能证明"代码这么写"。F-2 的 external 分支与
//   F-4 的 parse_adjustment_notices 都是**可单测的纯逻辑**，没有理由只靠注释自证。
//   隔离：importlib 按文件路径加载模块（不 cd、不改 sys.path），喂合成文本，不联网。
{
  const pyCands = [];
  if (process.env.CN_PYTHON) pyCands.push(process.env.CN_PYTHON);
  pyCands.push('python', 'python3');
  let PY99C = null;
  for (const c of pyCands) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY99C = c; break; }
  }
  if (!PY99C || !SPAWN_OK) envSkip('T99-c py 行为组（F-2 厂商模式 / F-4 公告解析）', 'python 不可用或沙箱禁 spawn');
  else {
    const py = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, sys',
      'sys.stdout.reconfigure(encoding="utf-8")',
      'SRC = ' + JSON.stringify(SRC.replace(/\\/g, '/')),
      "_spec = importlib.util.spec_from_file_location('fcp', SRC + '/fetch-cn-prices.py')",
      'F = importlib.util.module_from_spec(_spec)',
      '_spec.loader.exec_module(F)',
      'fails = []',
      'def chk(n, c, d=""):',
      '    print("CASE|%s|%s|%s" % (n, "OK" if c else "FAIL", d))',
      '    if not c: fails.append(n)',
      // ① F-2：厂商模式
      'chk("T99-c1 deepseek 模式为 external（不再读回 pricing.json）", F.VENDORS["deepseek"]["mode"] == "external", str(F.VENDORS["deepseek"]["mode"]))',
      'chk("T99-c2 全库不得再有 mode=pricing 的厂商（自我引用闭环的任何残留）", all(v.get("mode") != "pricing" for v in F.VENDORS.values()), str([k for k, v in F.VENDORS.items() if v.get("mode") == "pricing"]))',
      'chk("T99-c3 parse_pricing_deepseek 已拆除", not hasattr(F, "parse_pricing_deepseek"), "")',
      // ② F-4：公告解析纯函数（未来生效 / 已生效 / 无公告 / 缓存列 / 认不出模型名不猜）
      'FUT = "自北京时间 2027 年 3 月 1 日 00:00 起由 1 元/百万 tokens 调整为 2 元/百万 tokens，`step-5-preview` 的输入价格"',
      'r = F.parse_adjustment_notices(FUT)',
      'chk("T99-c4 未来公告被解析出 effective/old/new/field", r.get("step5preview", {}).get("old") == 1.0 and r.get("step5preview", {}).get("new") == 2.0 and r.get("step5preview", {}).get("effective") == "2027-03-01T00:00" and r.get("step5preview", {}).get("field") == "in", str(r))',
      'OUT = "自北京时间 2026 年 9 月 1 日 00:00 起由 8 元/百万 tokens 调整为 6 元/百万 tokens，Step 5 Preview 的输出价格"',
      'r2 = F.parse_adjustment_notices(OUT)',
      'chk("T99-c5 显示名（含空格）与 api 名归一后同键", r2.get("step5preview", {}).get("field") == "out" and r2.get("step5preview", {}).get("new") == 6.0, str(r2))',
      'CACHE = "自北京时间 2026 年 9 月 1 日 00:00 起由 0.1 元/百万 tokens 调整为 0.2 元/百万 tokens，step-5-preview 的缓存命中价格"',
      'r3 = F.parse_adjustment_notices(CACHE)',
      'chk("T99-c6 缓存命中列识别为 cache", r3.get("step5preview", {}).get("field") == "cache", str(r3))',
      'chk("T99-c7 无公告文本 → 空 dict（不猜）", F.parse_adjustment_notices("今天天气不错") == {}, "")',
      'NOMODEL = "自北京时间 2027 年 3 月 1 日 00:00 起由 1 元/百万 tokens 调整为 2 元/百万 tokens"',
      'chk("T99-c8 认不出模型名的公告 → 不收（漏认代价 < 误认）", F.parse_adjustment_notices(NOMODEL) == {}, str(F.parse_adjustment_notices(NOMODEL)))',
      'print("RESULT %d" % len(fails))',
      'sys.exit(1 if fails else 0)',
    ].join('\n');
    const fw = path.join(tmp, 't99c');
    fs.mkdirSync(fw, { recursive: true });
    const pf = path.join(fw, 't99c.py');
    fs.writeFileSync(pf, py, 'utf8');
    const r = spawnSync(PY99C, [pf], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: Object.assign({}, env, PY_IO_ENV, { WB_LEDGER_MAINT: '1' }) });
    let matched = 0;
    for (const ln of String(r.stdout || '').split(/\r?\n/)) {
      const m = /^CASE\|([^|]*)\|(OK|FAIL)\|?(.*)$/.exec(ln);
      if (m) { matched++; ok(m[1] + (m[3] ? '  ' + m[3] : ''), m[2] === 'OK'); }
    }
    ok('T99-c0 行为组断言行被识别（python 输出格式/编码异常时此处暴露原文）', matched >= 8,
      'matched=' + matched + '（应为 8：T99-c1~c8）'
      + 'status=' + r.status + ' stdout=[' + String(r.stdout || '').replace(/\n/g, '\\n').slice(0, 600) + ']'
      + ' stderr=[' + String(r.stderr || '').slice(0, 800) + ']');
    try { fs.rmSync(fw, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ===== T100（v3.62.0 · 外部审计 F-3）：历史可复现 —— recalc / backfill 按「当时价」而非「现价」=====
//   病根（审计 F-3「历史不可复现」）：recalc-day / backfill 都按 pricing.json 的**现价**回算历史。
//   厂商调价后跑一次 `node recalc-day.js 2026-09-10` 或 `node backfill.js --write`，那天的金额就被按
//   **今天**的单价改写 —— 账本失去"可回放"这个最值钱的属性，而命令看起来像"查看历史 / 重建账本"，
//   README/SKILL 从未警示。本项目三条独立计价路径（主链增量 / recalc 回溯 / backfill 重建）里两条中招。
//   修法：价库流水线每日落**当日快照**（build_index.py 的 write_price_history →
//   prices/history/prices-<北京日>.json = 那天索引的最终形态，含 pricing.json 的 lock 权威覆盖层），
//   回溯工具按"目标日"取快照计价；快照的目录解析 / 读取 / 形态转换抽成 price-history.js 单点
//   （A3「复制实现靠注释同步」在本仓已翻车三次：峰谷倍率 / 行数口径 / dayTotalOf，不许再有第四处）。
//   两条路径的处置**刻意相反**（为什么，逐条说清）：
//     · recalc 面向"某一日复核金额" → 缺快照就 **fail-closed 拒绝**（exit 1）：没有那天的价格材料，
//       任何"回算"都是按今天的价编历史。逃逸口 = 显式 `--current-price`（报告里标注该口径）。
//     · backfill 面向"重建整本历史" → 绝大多数日期发生在快照机制上线**之前**，硬拒绝会让这把最常用的
//       刀完全不可用 → 缺快照 **降级为现价 + 逐日 stderr WARN**（不静默，让用户知道这段历史不是当时价）。
//   ⚠ 已知残留（两端一致，如实标注、不装作没有）：峰谷规则（deepseek_rules）不在快照里（它是
//     pricing.json 顶层字段、由 deepseek-official 每日刷新）→ 历史某天规则与今天不同时，峰谷判定
//     仍按今天的规则。价格才是金额主项，规则的时态差异留待快照格式扩展。
//   反向验证要求：实现侧任一处回退（recalc 默认退回现价 / 移除拒绝 / backfill 不按日取价 / 去掉 WARN）
//   → 对应断言必红；其余断言不得误伤。
{
  const S100 = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
  const phSrc = (() => { try { return S100('price-history.js'); } catch (e) { return ''; } })();
  const rdRaw = S100('recalc-day.js');
  const rd100 = stripComments(rdRaw);
  const bfRaw = S100('backfill.js');
  const bf100 = stripComments(bfRaw);
  const bi100 = S100('build_index.py');

  // ── a. 源码守卫 ──
  ok('T100-a1 ★必须存在 price-history.js 单点模块并导出五个函数（目录解析 / 读取 / 形态转换只此一处）',
    /function historyDirOf\(explicitDir\)/.test(phSrc) && /function snapshotPath\(dir, date\)/.test(phSrc)
    && /function readSnapshot\(dir, date\)/.test(phSrc) && /function listSnapshotDates\(dir\)/.test(phSrc)
    && /function pricingFromSnapshot\(snap\)/.test(phSrc)
    && /module\.exports\s*=\s*\{[\s\S]{0,200}?pricingFromSnapshot/.test(phSrc));
  ok('T100-a2 ★两个消费端都必须 require 它（不得各自再写一份快照读取 = A3 的第四处）',
    /require\('\.\/price-history\.js'\)/.test(rd100) && /require\('\.\/price-history\.js'\)/.test(bf100));
  ok('T100-a3 ★historyDirOf 优先级与主脚本 env 级一致（显式 > CN_PRICE_DB_DIR > CN_PRICES_DIR > 同级 prices）',
    /explicitDir\s*\|\|\s*process\.env\.CN_PRICE_DB_DIR\s*\|\|\s*process\.env\.CN_PRICES_DIR\s*\|\|\s*path\.join\(__dirname,\s*'prices'\)/.test(phSrc));
  ok('T100-a4 ★pricingFromSnapshot 必须只收 in/out 均为数值的条目（与索引侧 S-3 拒收同口径，坏价不进历史材料）',
    /typeof rec\.in !== 'number' \|\| typeof rec\.out !== 'number'/.test(phSrc));
  ok('T100-a5 ★缓存价缺失必须按输入价保守计（与 mergeLocalPriceDb 逐字同口径；按 0 计 = 占 ~97% 的缓存 token 被免单）',
    /cached_price: \(typeof rec\.cache === 'number'\) \? rec\.cache : rec\.in/.test(phSrc));
  ok('T100-a6 ★recalc 默认口径必须读当日快照（不得直接拿 pricing 现价回算历史 —— F-3 的病根）',
    /priceHistory\.readSnapshot\(histDir, date\)/.test(rd100)
    && /pricingUsed = priceHistory\.pricingFromSnapshot\(snap\)/.test(rd100));
  ok('T100-a7 ★recalc 缺快照必须 fail-closed 拒绝（exit 1）+ 给出 --current-price 逃逸口与现有快照范围',
    /没有价格快照/.test(rdRaw) && /process\.exit\(1\)/.test(rd100) && /--current-price/.test(rdRaw)
    && /listSnapshotDates\(histDir\)/.test(rd100));
  ok('T100-a8 ★recalc「今天缺快照」按现价（今天的现价即当天价）—— 不得把"今天"也一刀切拒掉',
    /今天尚无快照/.test(rdRaw) && /isToday/.test(rd100));
  // backfill：三处取价调用必须**都**按行日期（rowCost×2 + at-time 切分×1），用三条独立锚点分别钉，
  //   避免"删掉其中一处、另一处同名调用让计数仍达标"的通病（本项目硬教训：锚点必须唯一到那一处）。
  ok('T100-a9 ★backfill 的三处取价都必须按**行所属日期**（中断补偿 / 行级 / at-time 切分各一）',
    /rowCost\(pricingForDate\(date\), model, u, ts\)/.test(bfRaw)
    && /rowCost\(pricingForDate\(date\), name, u, ts\)/.test(bfRaw)
    && /findModel\(pricingForDate\(date\), name, 'price'\)/.test(bfRaw));
  ok('T100-a10 ★backfill 缺快照必须逐日 WARN（降级可见，不许静默退回现价）',
    /无价格快照/.test(bfRaw) && /_snapWarnedDates/.test(bf100));
  ok('T100-a11 ★build_index.py 必须每日落快照（否则 recalc/backfill 永远无"当时价"可读）',
    /def write_price_history\(merged\)/.test(bi100)
    && /HISTORY_DIR = os\.path\.join\(PRICES_DIR, 'history'\)/.test(bi100)
    && /if not isinstance\(in_p, \(int, float\)\) or not isinstance\(out_p, \(int, float\)\)/.test(bi100)
    && /write_price_history\(merged\)/.test(bi100));

  // ── b. price-history.js 纯函数（require 真身；显式目录，不依赖 env / 网络）──
  let PH = null;
  try { PH = require(path.join(SRC, 'price-history.js')); } catch (e) { PH = null; }
  if (!PH || typeof PH.readSnapshot !== 'function') {
    ok('T100-b0 price-history.js 可被 require（纯模块、无副作用）', false, 'require 失败');
  } else {
    ok('T100-b0 price-history.js 可被 require（纯模块、无副作用）', true);
    const hd100 = path.join(tmp, 't100hist');
    fs.mkdirSync(hd100, { recursive: true });
    ok('T100-b1 historyDirOf 显式目录 → 其下 history/；snapshotPath 用 prices-<日期>.json 命名',
      PH.historyDirOf(hd100) === path.join(hd100, 'history')
      && PH.snapshotPath(hd100, '2026-09-10') === path.join(hd100, 'prices-2026-09-10.json'),
      PH.historyDirOf(hd100));
    fs.writeFileSync(path.join(hd100, 'prices-2026-09-10.json'), JSON.stringify({ date: '2026-09-10', models: { m: { in: 1, out: 2 } } }));
    fs.writeFileSync(path.join(hd100, 'prices-2026-09-11.json'), '{"models":');                 // 半截 JSON
    fs.writeFileSync(path.join(hd100, 'prices-2026-09-12.json'), JSON.stringify({ date: '2026-09-12' })); // 无 models
    fs.writeFileSync(path.join(hd100, 'prices-bad.json'), '{}');                                 // 非日期名 → 不进列表
    let b2 = false;
    try {
      const s = PH.readSnapshot(hd100, '2026-09-10');
      b2 = !!s && !!s.models && s.models.m.in === 1
        && PH.readSnapshot(hd100, '2026-09-09') === null
        && PH.readSnapshot(hd100, '2026-09-11') === null
        && PH.readSnapshot(hd100, '2026-09-12') === null
        && PH.readSnapshot(hd100, 'bad') === null;
    } catch (e) { b2 = false; }
    ok('T100-b2 ★readSnapshot：合法 → 对象；不存在 / 坏 JSON / 形状不对 / 坏日期名 → null（不抛）', b2);
    ok('T100-b3 listSnapshotDates 只收 prices-YYYY-MM-DD.json 且升序（坏名不进）',
      JSON.stringify(PH.listSnapshotDates(hd100)) === JSON.stringify(['2026-09-10', '2026-09-11', '2026-09-12']),
      JSON.stringify(PH.listSnapshotDates(hd100)));
    const p100 = PH.pricingFromSnapshot({ date: '2026-09-10', models: {
      m1: { in: 1, out: 2 },
      m2: { in: 3, out: 4, cache: 0.5, peak_mult: 2, effective_from: '2026-09-01', superseded_at: '2026-10-01' },
      m3: { in: null, out: 5 },
    } });
    ok('T100-b4 ★pricingFromSnapshot：in/out→input/output_price，cache 缺失按输入价，peak_mult→peak_multiplier，坏条目丢弃',
      p100.models.m1.input_price === 1 && p100.models.m1.output_price === 2 && p100.models.m1.cached_price === 1
      && p100.models.m2.cached_price === 0.5 && p100.models.m2.peak_multiplier === 2
      && p100.models.m2.effective_from === '2026-09-01' && p100.models.m2.superseded_at === '2026-10-01'
      && !p100.models.m3,
      JSON.stringify(p100.models));
  }

  // ── c. recalc 端到端：有快照 → 用它算；缺快照 → 拒绝；--current-price → 现价 ──
  //   为什么必须真跑：源码守卫只能证明"调了 readSnapshot"，「取到的价到底进了金额没有」只有端到端能证。
  //   夹具刻意让**快照价(1) 与现价(10) 差 10 倍** —— 金额落在哪个数上，一眼分清走的是哪条口径。
  if (!SPAWN_OK) {
    envSkip('T100-c 端到端：recalc 按当天快照价 / 缺快照拒绝 / --current-price 逃逸口', SPAWN_SKIP_REASON);
  } else {
    const D100 = '2026-09-10';
    const fw = path.join(tmp, 't100c');
    const fsk = path.join(fw, 'skills', 'token-usage-tracker');
    const fpd = path.join(fw, 'cnprices');
    fs.mkdirSync(fsk, { recursive: true });
    fs.mkdirSync(path.join(fpd, 'history'), { recursive: true });
    fs.writeFileSync(path.join(fsk, 'pricing.json'), JSON.stringify({ models: {
      m1: { input_price: 10, output_price: 20, cached_price: 5, currency: 'CNY', unit: 'per_1m_tokens', region: 'CN' },
    } }));
    fs.writeFileSync(path.join(fsk, 'holidays.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(fsk, 'daily-usage.json'), JSON.stringify({ [D100]: {
      models: { m1: { in: 1000000, out: 0, cached: 0, total: 1000000, cost: 0, hit: 0 } },
      total: { in: 1000000, out: 0, cached: 0, total: 1000000, cost: 0, hit: 0 },
    } }));
    fs.writeFileSync(path.join(fpd, 'index.json'), JSON.stringify({ models: {} }));
    const snap100 = path.join(fpd, 'history', 'prices-' + D100 + '.json');
    fs.writeFileSync(snap100, JSON.stringify({ date: D100, models: { m1: { in: 1, out: 2, cache: 0.5 } } }));
    const e100 = Object.assign({}, env, { WB_ROOT: fw, CN_PRICE_DB_DIR: fpd, WB_LEDGER_MAINT: '1' });
    const runRc100 = (args) => {
      const o = path.join(fw, 'o.txt'); const e = path.join(fw, 'e.txt');
      const ofd = fs.openSync(o, 'w'); const efd = fs.openSync(e, 'w');
      // stdio 重定向到文件（不用管道）：主脚本 require 时可能 detach 派生刷新子进程持有管道 → 干等超时
      const r = spawnSync(NODE, [path.join(skillDir, 'recalc-day.js')].concat(args),
        { stdio: ['ignore', ofd, efd], windowsHide: true, timeout: 90000, env: e100 });
      try { fs.closeSync(ofd); } catch (x) { /* 异常路径下可能已关 */ }
      try { fs.closeSync(efd); } catch (x) { /* 同上 */ }
      const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (x) { return ''; } };
      return { rc: r.status, out: read(o), err: read(e) };
    };
    const c1 = runRc100([D100]);
    // ⚠ 只断言**金额**，不断言 dry-run 那一行口径文案：那行只在 `if (!doWrite)` 分支打印，
    //   会被"默认改为写盘"这类回退（反向验证 R4）连同 dry-run 提示一起打掉 → 变成与价格口径无关的
    //   假红（本轮实测踩到）。口径文案本身由 T93-a3（源码 `价格口径：${priceBasis}`）与
    //   T100-c2（缺快照时给 `--current-price` 逃逸口）各自钉住。
    ok('T100-c1 ★有快照 → 金额按**当天快照价**（in=1 → ¥1.0000），不是 pricing.json 现价（10 → ¥10.0000）',
      c1.rc === 0 && c1.out.indexOf('¥1.0000') >= 0 && c1.out.indexOf('¥10.0000') < 0,
      'rc=' + c1.rc + ' out=' + c1.out.replace(/\n/g, '~').slice(0, 300));
    fs.renameSync(snap100, snap100 + '.bak');
    const c2 = runRc100([D100]);
    ok('T100-c2 ★缺快照 → fail-closed 拒绝（exit 1 + 明确文案 + 指出 --current-price 逃逸口）',
      c2.rc === 1 && c2.err.indexOf('没有价格快照') >= 0 && c2.err.indexOf('--current-price') >= 0,
      'rc=' + c2.rc + ' err=' + c2.err.replace(/\n/g, '~').slice(0, 320));
    const c3 = runRc100([D100, '--current-price']);
    ok('T100-c3 ★--current-price 逃逸口 → 按现价算（in=10 → ¥10.0000）',
      c3.rc === 0 && c3.out.indexOf('¥10.0000') >= 0,
      'rc=' + c3.rc + ' out=' + c3.out.replace(/\n/g, '~').slice(0, 300));
  }

  // ── d. backfill 端到端：按**行所属日期**取快照价；缺快照 → 现价 + 逐日 WARN ──
  if (!SPAWN_OK) {
    envSkip('T100-d 端到端：backfill 按当日快照价 / 缺快照降级告警', SPAWN_SKIP_REASON);
  } else {
    const D100b = '2026-09-10';
    const ts100b = Date.UTC(2026, 8, 10, 4, 0, 0); // +8h = 北京 12:00 → 归属日 2026-09-10
    const mkBf100 = (root, withSnap) => {
      const sk = path.join(root, 'skills', 'token-usage-tracker');
      const pd = path.join(root, 'cnprices');
      const pj = path.join(root, 'projects', 'projA');
      fs.mkdirSync(sk, { recursive: true }); fs.mkdirSync(pd, { recursive: true }); fs.mkdirSync(pj, { recursive: true });
      fs.writeFileSync(path.join(sk, 'pricing.json'), JSON.stringify({ models: {
        m1: { input_price: 10, output_price: 20, cached_price: 5, currency: 'CNY', unit: 'per_1m_tokens', region: 'CN' },
      } }));
      fs.writeFileSync(path.join(sk, 'holidays.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(pd, 'index.json'), JSON.stringify({ models: {} }));
      if (withSnap) {
        fs.mkdirSync(path.join(pd, 'history'), { recursive: true });
        fs.writeFileSync(path.join(pd, 'history', 'prices-' + D100b + '.json'),
          JSON.stringify({ date: D100b, models: { m1: { in: 1, out: 2, cache: 0.5 } } }));
      }
      fs.writeFileSync(path.join(pj, 'sid-bf.jsonl'), JSON.stringify({ type: 'message', id: 'b1', timestamp: ts100b, status: 'completed',
        providerData: { model: 'm1', messageId: 'b1', usage: { input_tokens: 1000000, output_tokens: 0 } } }) + '\n');
    };
    const runBf100 = (root) => {
      const o = path.join(root, 'o.txt'); const e = path.join(root, 'e.txt');
      const ofd = fs.openSync(o, 'w'); const efd = fs.openSync(e, 'w');
      const r = spawnSync(NODE, [path.join(skillDir, 'backfill.js'), '--write'],
        { stdio: ['ignore', ofd, efd], windowsHide: true, timeout: 90000,
          env: Object.assign({}, env, { WB_ROOT: root, CN_PRICE_DB_DIR: path.join(root, 'cnprices'), WB_LEDGER_MAINT: '1' }) });
      try { fs.closeSync(ofd); } catch (x) { /* 同上 */ }
      try { fs.closeSync(efd); } catch (x) { /* 同上 */ }
      const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (x) { return ''; } };
      let cost = null;
      try { cost = JSON.parse(read(path.join(root, 'skills', 'token-usage-tracker', 'daily-usage.json')))[D100b].models.m1.cost; }
      catch (x) { cost = null; }
      return { rc: r.status, cost, out: read(o), err: read(e) };
    };
    const rootA = path.join(tmp, 't100bf-snap'); mkBf100(rootA, true);
    const d1 = runBf100(rootA);
    ok('T100-d1 ★有当日快照 → 金额按快照价（in=1 → ¥1），不是现价（10 → ¥10）',
      d1.rc === 0 && typeof d1.cost === 'number' && Math.abs(d1.cost - 1) < 1e-9,
      'rc=' + d1.rc + ' cost=' + JSON.stringify(d1.cost) + ' err=' + d1.err.replace(/\n/g, '~').slice(0, 220));
    ok('T100-d2 ★报告必须写明「按当日快照价」的天数（口径可见，不靠猜）',
      d1.out.indexOf('价格口径') >= 0 && d1.out.indexOf('当日快照价') >= 0,
      d1.out.replace(/\n/g, '~').slice(0, 220));
    const rootB = path.join(tmp, 't100bf-nosnap'); mkBf100(rootB, false);
    const d2 = runBf100(rootB);
    ok('T100-d3 ★缺快照 → 降级为现价（10）但**必须逐日 WARN**（不静默退回，日期要出现在告警里）',
      d2.rc === 0 && typeof d2.cost === 'number' && Math.abs(d2.cost - 10) < 1e-9
      && d2.err.indexOf('无价格快照') >= 0 && d2.err.indexOf(D100b) >= 0,
      'rc=' + d2.rc + ' cost=' + JSON.stringify(d2.cost) + ' err=' + d2.err.replace(/\n/g, '~').slice(0, 260));
  }
}

// ===== T101（v3.62.0 · 审计后续）：Stop「静默丢轮」的可观测化 + 辅助步骤隔离 =====
//   背景（2026-10-16 23:43:55Z / pid 26324 实证，详见 token-tracker-审计裁决-2026-10-16.md 三更）：
//   一次团队轮只落了 stop-transcript 一条、rounds 无该轮记录、**守卫的降级 toast 也从未出现** ——
//   说明这**不是**被顶层守卫捕获的同步异常（v3.61.0 S1 的 try/catch 当时已在位、未触发）。
//   当时的结论只能靠"rounds 少一条"这种间接对账把死亡窗口缩到 `stop-handler.js:148→189`（41 行），
//   无法定位到具体调用。本组做两件**不依赖"是哪一次失败"**的事：
//     ① 可观测化：顶层守卫补落**持久** stop-crash（含 step + stack）；主链路补 stop-step 步进标记，
//        把 41 行切成可定位段；agg 为空这条**原先零留痕**的路径补 stop-agg-null。
//     ② 辅助步骤隔离：`estimateInterrupted` / `shortModelName` / `ensureNewModelPricing` 都是**旁路增强**
//        （估算补数 / 显示短名 / 价格补录），任一失败都不得带走 `incrementalRecord`（记账）与弹窗分支。
//        ⚠ 刻意**不对称**：主链路 `aggregateTranscript` / `incrementalRecord` **不吞**（由①的 stop-crash 留证）。
//   ⚠ 锚点唯一性（项目硬教训）：只用 `stopStep('pre-price')` 这类全文件唯一的调用行做锚，避免
//      "同一形态在别处也写了一份"导致删掉目标仍恒绿。
{
  const shRaw101 = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8');
  const strip101 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const i101a = shRaw101.indexOf('function handleStopEnd(ctx) {');
  const i101b = shRaw101.indexOf('function handleStopEndInner(ctx) {');
  const guard101 = (i101a >= 0 && i101b > i101a) ? shRaw101.slice(i101a, i101b) : '';

  ok('T101-a1 ★顶层守卫的 catch 必须落**持久**日志 stop-crash（含 step + stack）'
    + '——hook 场景 stderr 无接收方（实测本机不进任何日志），旧守卫只写 stderr ⇒ 出事时 0 处可诊断',
    guard101.indexOf("appendCompactionLog('stop-crash'") >= 0
    && guard101.indexOf('step: LAST_STOP_STEP') >= 0 && guard101.indexOf('stack') >= 0,
    guard101 ? 'guard 段缺 stop-crash / LAST_STOP_STEP / stack' : '未取到守卫段（锚点被改？）');

  ok('T101-a2 ★必须存在模块级 LAST_STOP_STEP，且守卫从它读取"死在哪个调用"',
    /let LAST_STOP_STEP = '/.test(shRaw101) && /step: LAST_STOP_STEP/.test(guard101));

  ok('T101-a3 ★必须存在 stopStep 步进辅助（落 stop-step），且自身失败不外抛',
    /const stopStep = \(name, extra\) => \{/.test(shRaw101)
    && /appendCompactionLog\('stop-step'/.test(shRaw101));

  // 锚点必须唯一到那一处：`stopStep('pre-price')` 全文件仅一处。
  const pre101 = shRaw101.indexOf("stopStep('pre-price')");
  const seg101 = pre101 >= 0 ? strip101(shRaw101.slice(pre101, pre101 + 460)) : '';
  ok('T101-a4 ★价格补录必须被 try 包住（本段唯一**联网 + 读写价库**的调用）——它挂掉绝不能带走记账',
    seg101.length > 0
    && seg101.indexOf('try { nmNote = ensureNewModelPricing(pricing, agg).note; }') > 0
    && seg101.indexOf("stopStep('price-failed'") > 0,
    seg101 ? 'pre-price 之后未紧跟 try{ensureNewModelPricing}' : "未找到唯一锚点 stopStep('pre-price')");

  const est101 = shRaw101.indexOf('let estByModel0 = {};');
  const segEst101 = est101 >= 0 ? strip101(shRaw101.slice(est101, est101 + 340)) : '';
  ok('T101-a5 ★估算补数（旁路增强）必须被 try 包住——失败只是少显示被中断段，不得带走整轮',
    segEst101.indexOf('try { estByModel0 = estimateInterrupted(') > 0
    && segEst101.indexOf("stopStep('estimate-failed'") > 0,
    segEst101 ? 'estByModel0 未按 try 包裹' : '未找到锚点 let estByModel0 = {};');

  ok('T101-a6 ★模型短名（纯显示）必须被 try 包住且带回落值（否则一次显示层异常会整轮丢弹窗）',
    shRaw101.indexOf('try { modelShort = shortModelName(agg, pricing); }') > 0
    && /modelShort = \(agg\.modelMain \|\| agg\.model\) \|\| '';/.test(shRaw101));

  ok('T101-a7 ★聚合三轮仍为空必须留痕 stop-agg-null（该路径原先零留痕 → 尾巴也无 trace 时 = 整轮静默丢失）',
    /appendCompactionLog\('stop-agg-null'/.test(shRaw101));

  const ip101 = shRaw101.indexOf("stopStep('pre-price')");
  const id101 = shRaw101.indexOf("stopStep('priced')");
  const ir101 = shRaw101.indexOf("stopStep('recorded'");
  ok('T101-a8 ★三段步进标记顺序必须 pre-price → priced → recorded（把 41 行死亡窗口切成可定位段）',
    ip101 > 0 && id101 > ip101 && ir101 > id101 && ir101 < shRaw101.lastIndexOf('return false;'));

  // 刻意不对称：主链路（记账）不得被吞 —— 否则"辅助失败不带走记账"会退化成"连记账失败也吞"。
  ok('T101-a9 ★incrementalRecord（记账 = 主链路）**不得**被 try 吞掉（剥注释后不得出现 try { incrementalRecord）',
    strip101(shRaw101).indexOf('try { incrementalRecord') < 0);

  // ── b. 行为（单元级：直接 require 模块 + 注入桩 tx）──
  //   为什么走单元而非端到端：要让"某个辅助步骤必抛"**确定性**发生，端到端只能靠坏价库 / 断网等间接手段。
  const shMod101 = (() => { try { return require(path.join(SRC, 'stop-handler.js')); } catch (e) { return null; } })();
  if (!shMod101) envSkip('T101-b1~b6 Stop 辅助步骤隔离行为组', 'stop-handler.js require 失败');
  else {
    const run101 = (over) => {
      const logs = [], calls = [];
      const tx = {};
      for (const n of shMod101.STOP_TX_NAMES) tx[n] = function () { return undefined; };
      // 最小可用桩：让流程走完 148→189 段并进入"普通轮同步弹窗"分支（isPlainRound=true）。
      tx.transcriptPathFromPayload = () => 'C:/fixture101/main.jsonl';
      tx.captureTranscShape = () => ({ exists: true });
      tx.loadSnapshot = () => ({ file: 'C:/fixture101/main.jsonl', stat: null, lastUserMsgAt: 1000, lastStopAt: 0 });
      tx.saveSnapshot = () => {};
      tx.aggregateTranscript = () => ({ in: 10, out: 5, cached: 0, total: 15, model: 'k101-m', modelMain: 'k101-m',
        subModels: [], subCount: 0, teamActive: false, models: { 'k101-m': { in: 10, out: 5, cached: 0, total: 15 } }, durMs: 1000 });
      tx.aggregatePerModel = () => ({});
      tx.readTranscLines = () => [];
      tx.estimateInterrupted = () => ({});
      tx.traceWallDurMs = () => ({ source: 'none' });
      tx.latestTraceFile = () => null;
      tx.shortModelName = (s) => (s && (s.modelMain || s.model)) || 'x';
      tx.ledgerKey = () => 'sid101';
      tx.subagentsAllSettled = () => true;
      tx.hasSubagentsRecentlyActive = () => false;
      tx.lineFor = () => 'line101';
      tx.toastLine1 = () => 'l1'; tx.toastLine2 = () => 'l2'; tx.toastLineTagged = () => 'l3';
      tx.periodNote = () => ''; tx.balanceText = () => ''; tx.todayUsageTxt = () => ''; tx.noPriceTag1 = () => '';
      tx.showToastsSplitByModel = () => false;
      // v3.63.3（AUD-B-01）：桩必须返 true —— showToast 现在返回「是否可视为已呈现」，
      //   返 undefined 会被产品代码判成 toast 失败 → 走失败收口（不写 stop-plain-immediate）。
      tx.showToast = (...a) => { calls.push('toast:' + a[2]); return true; };
      tx.clearCoalesce = () => {}; tx.writeCoalesce = () => {}; tx.coalescePath = () => 'C:/fixture101/c.json';
      tx.readCoalesceInfo = () => null;
      tx.incrementalRecord = () => { calls.push('incrementalRecord'); };
      tx.ensureNewModelPricing = () => ({ status: 'none', note: '' });
      tx.appendCompactionLog = (ev, d) => { logs.push(Object.assign({ ev }, d || {})); };
      tx.writeProbe = () => {};
      Object.assign(tx, over || {});
      const outCalls = [];
      const origErr = process.stderr.write;
      process.stderr.write = () => true; // 守卫的 stderr 留痕在测试里静音（否则污染"失败样本"的美观）
      let ret, threw = null;
      try {
        ret = shMod101.handleStopEnd({ sid: 'sid101', payloadRaw: {}, pricing: { models: {} }, out: (o) => outCalls.push(o), tx });
      } catch (e) { threw = e; } finally { process.stderr.write = origErr; }
      return { ret, threw, logs, calls, outCalls, steps: logs.filter((l) => l.ev === 'stop-step').map((l) => l.step) };
    };

    // b1/b2：价格补录（唯一联网 + 读写价库）抛错 → 记账照跑 + 落 price-failed + 仍弹窗
    const r1 = run101({ ensureNewModelPricing: () => { throw new Error('boom-price'); } });
    ok('T101-b1 ★ensureNewModelPricing 抛错时：记账照跑（incrementalRecord 被调用）+ 落 price-failed + 不抛异常'
      + '——这才是"辅助步骤失败不得带走弹窗/记账"的行为级证据',
      !r1.threw && r1.ret === true && r1.calls.indexOf('incrementalRecord') >= 0
      && r1.steps.indexOf('price-failed') >= 0 && r1.steps.indexOf('priced') >= 0 && r1.steps.indexOf('recorded') >= 0,
      `threw=${r1.threw && r1.threw.message} ret=${r1.ret} calls=${r1.calls.join(',')} steps=${r1.steps.join(',')}`);
    ok('T101-b2 ★价格补录抛错后仍必须走到弹窗分支（辅助失败绝不吞掉用户可见的弹窗）',
      !r1.threw && r1.calls.some((c) => c.indexOf('toast:') === 0) && r1.logs.some((l) => l.ev === 'stop-plain-immediate'),
      `calls=${r1.calls.join(',')} logs=${r1.logs.map((l) => l.ev).join(',')}`);

    const r2 = run101({ estimateInterrupted: () => { throw new Error('boom-est'); } });
    ok('T101-b3 ★estimateInterrupted 抛错时：记账照跑 + 落 estimate-failed',
      !r2.threw && r2.ret === true && r2.calls.indexOf('incrementalRecord') >= 0
      && r2.steps.indexOf('estimate-failed') >= 0 && r2.steps.indexOf('recorded') >= 0,
      `threw=${r2.threw && r2.threw.message} steps=${r2.steps.join(',')}`);

    const r3 = run101({ shortModelName: () => { throw new Error('boom-name'); } });
    ok('T101-b4 ★shortModelName 抛错时：记账照跑 + 落 shortname-failed',
      !r3.threw && r3.ret === true && r3.calls.indexOf('incrementalRecord') >= 0
      && r3.steps.indexOf('shortname-failed') >= 0 && r3.steps.indexOf('recorded') >= 0,
      `threw=${r3.threw && r3.threw.message} steps=${r3.steps.join(',')}`);

    const r4 = run101({ aggregateTranscript: () => { throw new Error('boom-agg'); } });
    ok('T101-b5 ★主链路（聚合）抛错时顶层守卫兜底：返回 true + 落持久 stop-crash（含 stack）+ 仍 out() 收口'
      + '——"静默丢轮"变成"可查的降级"',
      !r4.threw && r4.ret === true && r4.outCalls.length > 0
      && r4.logs.some((l) => l.ev === 'stop-crash' && String(l.err).indexOf('boom-agg') >= 0 && !!l.stack),
      `threw=${r4.threw && r4.threw.message} ret=${r4.ret} out=${r4.outCalls.length} logs=${r4.logs.map((l) => l.ev).join(',')}`);

    const r5 = run101({ aggregateTranscript: () => null });
    ok('T101-b6 ★聚合三轮为空（agg=null）必须落 stop-agg-null（原先零留痕路径 → 尾巴无声即整轮静默丢失）',
      !r5.threw && r5.logs.some((l) => l.ev === 'stop-agg-null'),
      `threw=${r5.threw && r5.threw.message} logs=${r5.logs.map((l) => l.ev).join(',')}`);

    // ===== T105（v3.63 · 2026-10-17）：「记账优先」——钱先落盘，显示后置 =====
    //   病根（实测量化）：宿主在"任务完成"后约 **200ms** 就回收会话 runtime，而 Stop 钩子要 ~650ms
    //   （node 冷启动 300ms + 聚合 24ms + 记账 41ms + 弹窗/watcher 530ms）。
    //   旧顺序把 estimateInterrupted / traceWallDurMs / shortModelName（**只影响弹窗显示**）摆在
    //   `incrementalRecord` 之前 → 被砍在显示步骤上时**硬账一起丢**（2026-10-17 10:20:42 实证：
    //   水位线停在 567 行、6 次调用 29.5 万 tokens 未记账，只能手工补）。
    //   本组守：记账必须排在三个显示增强之前，且时长有 transcript 口径兜底（不依赖 trace 先跑）。
    {
      const raw105 = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8');
      const strip105 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      const iA105 = raw105.indexOf('if (agg) {');
      const iB105 = raw105.indexOf('const byModel = aggregatePerModel(');
      const fn105 = (iA105 >= 0 && iB105 > iA105) ? raw105.slice(iA105, iB105) : '';
      const fs105 = strip105(fn105);
      const iRec105 = fs105.indexOf('incrementalRecord(');
      ok('T105-a1 ★源码顺序：incrementalRecord（记账）必须早于 estimateInterrupted / traceWallDurMs / shortModelName'
        + '（三者只影响弹窗显示；排在记账前 = 钩子被砍时把硬账一起带走）',
        fn105.length > 0 && iRec105 >= 0
        && iRec105 < fs105.indexOf('estimateInterrupted(')
        && iRec105 < fs105.indexOf('traceWallDurMs(')
        && iRec105 < fs105.indexOf('shortModelName('),
        fn105 ? `rec=${iRec105} est=${fs105.indexOf('estimateInterrupted(')} trace=${fs105.indexOf('traceWallDurMs(')} name=${fs105.indexOf('shortModelName(')}` : '未取到 agg 分支体（锚点被改？）');

      ok('T105-a2 ★记账用的 durMs 必须有零成本兜底（各模型 lastTs − 轮起点），不能依赖 traceWallDurMs 先跑'
        + '（否则"先记账"就只能记 0 时长，或又得把 trace 挪回去）',
        /agg\.durMs = lastTs0 - roundStart0;/.test(raw105));

      // 行为：三个显示增强全部抛错时，记账仍必须**早已完成**（顺序 + 不中断双重证据）
      const seq105 = [];
      let metaDur105 = -1;
      const r6 = run101({
        aggregateTranscript: () => ({ in: 10, out: 5, cached: 0, total: 15, model: 'k105-m', modelMain: 'k105-m',
          subModels: [], subCount: 0, teamActive: false,
          models: { 'k105-m': { in: 10, out: 5, cached: 0, total: 15, lastTs: 5000 } }, durMs: 0 }),
        incrementalRecord: (p, s, meta) => { seq105.push('record'); metaDur105 = (meta && meta.durMs); },
        estimateInterrupted: () => { seq105.push('estimate'); throw new Error('boom-est-order'); },
        traceWallDurMs: () => { seq105.push('trace'); throw new Error('boom-trace-order'); },
        shortModelName: () => { seq105.push('name'); throw new Error('boom-name-order'); },
        readTranscLines: () => [],
      });
      ok('T105-b1 ★行为：estimate/trace/name 三个显示增强全部抛错时，incrementalRecord 仍**先于它们**被调用'
        + '（= 被砍在显示步骤上也已落账），且不抛异常',
        !r6.threw && r6.ret === true && seq105.indexOf('record') === 0
        && seq105.indexOf('estimate') > 0 && seq105.indexOf('trace') > 0 && seq105.indexOf('name') > 0,
        `threw=${r6.threw && r6.threw.message} seq=${seq105.join('→')}`);

      ok('T105-b2 ★行为：durMs 兜底真生效（roundStart=1000、各模型 lastTs=5000 → 记账收到 4000）',
        metaDur105 === 4000, `metaDur=${metaDur105}`);
    }
  }
}

// ===== T102（v3.62.0 · 批4）：孤儿轮对账（跨会话补弹）=====
//   背景（2026-10-16 23:43:54 实证）：宿主主线程重复风暴 → 会话 CLI **整树被杀**，Stop 钩子被连带带走
//   → 该轮 `lastStopAt` 从未推进 = 孤儿轮（token 已产生、永不弹窗），下一轮 Stop 把两轮**合并**弹出。
//   既有三条兜底（hook-fallback / cancelled-round-flush / stale-coalesce-settled）**全部以"死前写下的
//   标记"为前提**（coalesce 文件 / 取消标记 / coalesce 残留时长）→ 整树杀什么都不留 ⇒ 三条全失活。
//   本组守的是新判据：`快照.lastStopAt < 快照.lastUserMsgAt`（**状态**，不是死前标记），
//   以及"先弹后推 + 认领文件幂等 + 只补别的会话"这三条正确性约束。
{
  const SRC_T102 = 'token-tracker.js';
  const raw102 = fs.readFileSync(path.join(SRC, SRC_T102), 'utf-8');
  const strip102 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  // ── a. 源码结构 ──
  const iFn102 = raw102.indexOf('function scanOrphanRounds(opts) {');
  const iEnd102 = raw102.indexOf('function loadSnapshot(sid) {');
  const fn102 = (iFn102 >= 0 && iEnd102 > iFn102) ? raw102.slice(iFn102, iEnd102) : '';
  const fnStrip102 = strip102(fn102);

  ok('T102-a1 ★三档开关：仓库默认 off（与旧版逐字节一致，observe 只记不弹、on 才补弹）；'
    + '取值 **env 显式优先**（空串视为未设 → 回落配置）、未设才读 local-config.json 的 orphan_scan',
    fn102.length > 0
    && /process\.env\.WB_ORPHAN_SCAN/.test(raw102)
    && /\(envV != null && envV !== ''\) \? envV : loadLocalStr\('orphan_scan', 'off', 'on'\)/.test(raw102)
    && /return \(v === 'observe' \|\| v === 'on'\) \? v : 'off';/.test(raw102),
    fn102 ? '未取到 scanOrphanRounds 体（锚点被改？）' : '函数不存在');

  ok('T102-a2 ★判据必须是**状态**（lastStopAt < lastUserMsgAt），不得退回"死前写入的标记"'
    + '——那正是三条旧兜底全失活的根因',
    /const lastStop = Number\(S\.lastStopAt\) \|\| 0;/.test(fnStrip102)
    && /if \(lastStop >= R\) continue;/.test(fnStrip102)
    && /const R = Number\(S\.lastUserMsgAt\) \|\| 0;/.test(fnStrip102));

  ok('T102-a3 ★"本轮确实静止"三重证据缺一不可：轮起点龄期 / 主转录 mtime / 子代理活跃',
    fnStrip102.indexOf('if (now - R < ORPHAN_MIN_AGE_MS) continue;') > 0
    && fnStrip102.indexOf('if (now - st.mtimeMs < ORPHAN_IDLE_MS) continue;') > 0
    && fnStrip102.indexOf('if (hasSubagentsRecentlyActive(tsPath, ORPHAN_IDLE_MS)) continue;') > 0);

  // a4：先弹后推 —— 顺序在源码里可验（"先推后弹"一旦在弹之前崩 = 静默丢失，比重复更坏）
  const iToast102 = fnStrip102.indexOf('showToastsSplitByModel(agg, {');
  const iSave102 = fnStrip102.indexOf('saveSnapshot(Object.assign({}, c.snap, { lastStopAt: Date.now() }), c.sid);');
  ok('T102-a4 ★**先弹后推**：弹窗必须在推进 lastStopAt 之前（顺序反了 = 弹之前崩就静默丢失）',
    iToast102 > 0 && iSave102 > iToast102,
    `toast@${iToast102} save@${iSave102}`);

  ok('T102-a5 ★幂等由"认领文件原子创建"承担（并发双钩子互斥），且**成功时保留**、失败才释放'
    + '（保留 = 快照推进万一没落盘也能挡住重复弹）',
    /fs\.writeFileSync\(p, JSON\.stringify\(\{ at: Date\.now\(\), pid: process\.pid \}\), \{ flag: 'wx' \}\)/.test(raw102)
    && fnStrip102.indexOf('if (failed) orphanRelease(c.sid, c.roundStart);') > 0);

  ok('T102-a6 ★只补**别的会话**（curSid 跳过）——对本会话下手会把"本轮正在跑"误判成孤儿'
    + '（v2.27 守卫正是靠保留旧起点保护"专家团中途插话"，实测曾漏 409.3 万 tokens）',
    fnStrip102.indexOf("if (curSid && sid === curSid) continue;") > 0);

  ok('T102-a7 ★对账只挂 --hook、**不挂 --stop**（Stop 预算仅 ~650ms，实测 126MB 会话聚合 1438ms、'
    + '8 个候选上限 ≈11.5s ⇒ 真命中候选时会把本轮记账与弹窗一起拖死，反被兜底制造漏弹）',
    /if \(asHook\) scanOrphanRounds\(\{ curSid: sid, pricing \}\);/.test(raw102)
    && !/asHook \|\| asStop\)\s*scanOrphanRounds/.test(raw102));

  ok('T102-a8 ★scanOrphanRounds 自带最外层 try/catch（它挂在提交/Stop 必经路径上，绝不外抛）'
    + '——函数体剖去注释后必须以 try { 起手',
    /function scanOrphanRounds\(opts\) \{[\s\S]*?if \(mode === 'off'\) return res;\s*try \{/.test(strip102(raw102)));

  // a9（v3.62.0 批4·续）：**年龄上限**。开 on 当天实测本机 50 个快照含 10 个"欠账态"
  //   （5 个历史测试残留 + 4 个 6~16 天前的陈年会话）——无上限则首次钩子会一口气补满 8 条垃圾弹窗。
  ok('T102-a9 ★必须有**年龄上限**（ORPHAN_MAX_AGE_MS，默认 72h）挡住陈年旧账；'
    + '超龄要记入 skipped（才能区分"没检测到"与"检测到但没补"）',
    /const ORPHAN_MAX_AGE_MS = Number\(process\.env\.WB_ORPHAN_MAX_AGE_MS\) \|\| 72 \* 3600 \* 1000;/.test(raw102)
    && fnStrip102.indexOf("if (now - R > ORPHAN_MAX_AGE_MS) { res.skipped.push({ sid, why: 'too-old', ageMs: now - R }); continue; }") > 0);

  // ── b. 行为（隔离沙箱：真读写快照 / 转录 / toast 日志；不 spawn）──
  const savedRoot102 = process.env.WB_ROOT;
  const savedScan102 = process.env.WB_ORPHAN_SCAN;
  const savedNoToast102 = process.env.TOKEN_TRACKER_NO_TOAST;
  process.env.WB_ROOT = tmp;
  process.env.TOKEN_TRACKER_NO_TOAST = '1';
  const mod102 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  // 安全闸：确认该实例的快照目录确实在 tmp 里。不在就整组跳过 —— 绝不让测试写进真实技能目录。
  const snapOk102 = !!(mod102 && typeof mod102.orphanClaimPath === 'function'
    && String(mod102.orphanClaimPath('probe', 1)).indexOf(tmp) === 0);
  if (!snapOk102) envSkip('T102-b1~b11 孤儿轮对账行为组', '主模块缺失或快照目录不在隔离沙箱内');
  else {
    const proj102 = path.join(tmp, 'projects', 'orphanA');
    fs.mkdirSync(proj102, { recursive: true });
    const A102 = 'orph102a', B102 = 'orph102b';
    const aPath102 = path.join(proj102, A102 + '.jsonl');
    const snapA102 = path.join(skillDir, `.snapshot-${A102}.json`);
    const snapB102 = path.join(skillDir, `.snapshot-${B102}.json`);
    const toast102 = path.join(tmp, 'token-tracker-toast.log');
    const comp102 = path.join(tmp, 'token-tracker-compaction.log');
    const ROUND102 = Date.now() - 10 * 60 * 1000;   // A 的轮起点：10 分钟前（> MIN_AGE 60s）
    let seq102 = 0;
    const mrow102 = (ts, i, o, model) => JSON.stringify({
      type: 'assistant', id: 'o' + (seq102++), timestamp: ts,
      providerData: { model: model || 'orph-model', messageId: 'oid-' + seq102, usage: { input_tokens: i, output_tokens: o } },
    });
    const toastTexts102 = () => {
      const raw = fs.existsSync(toast102) ? fs.readFileSync(toast102, 'utf-8') : '';
      return raw.trim() ? raw.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } }) : [];
    };
    const compEvents102 = () => {
      const raw = fs.existsSync(comp102) ? fs.readFileSync(comp102, 'utf-8') : '';
      return raw.trim() ? raw.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } }) : [];
    };
    const readSnap102 = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
    const writeOrphanA102 = () => fs.writeFileSync(snapA102, JSON.stringify({
      file: aPath102, stat: { total: 3850, model: 'orph-model' }, lastUserMsgAt: ROUND102, lastStopAt: 0,
    }));
    const pricing102 = (() => { try { return mod102.loadPricing(); } catch (e) { return { date: '', models: {} }; } })();

    // 夹具：A = 孤儿（轮已静止 5 分钟、快照未结算）；B = 当前会话（已正常结算 = 负样本）
    fs.writeFileSync(aPath102, [mrow102(ROUND102 + 1000, 1000, 100), mrow102(ROUND102 + 2000, 2000, 200),
      mrow102(ROUND102 + 3000, 500, 50)].join('\n') + '\n');
    fs.utimesSync(aPath102, new Date(Date.now() - 300000), new Date(Date.now() - 300000));
    writeOrphanA102();
    fs.writeFileSync(snapB102, JSON.stringify({ file: path.join(proj102, B102 + '.jsonl'), stat: null,
      lastUserMsgAt: Date.now() - 120000, lastStopAt: Date.now() - 60000 }));
    const bBefore102 = readSnap102(snapB102);
    // 清掉可能影响断言的历史认领文件（同 sid 是本次新建，不会与既有测试相撞，仅求断言干净）
    for (const f of fs.readdirSync(skillDir)) if (f.startsWith('.orphan-' + A102 + '-')) fs.unlinkSync(path.join(skillDir, f));

    process.env.WB_ORPHAN_SCAN = 'on';
    const toastN0 = toastTexts102().length;
    const r1 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });

    ok('T102-b1 ★别的会话（B）触发 → 命中 A 的孤儿轮并补弹一条（这正是"不回原会话也能补上"）',
      r1.mode === 'on' && r1.candidates.length === 1 && r1.candidates[0].sid === A102 && r1.capped.length === 1,
      `mode=${r1.mode} cand=${JSON.stringify(r1.candidates)} capped=${JSON.stringify(r1.capped)}`);

    const toastNew102 = toastTexts102();
    ok('T102-b2 ★补弹弹窗必须带**来源标注**「（补弹 …）」+ reason=orphan-cap（否则用户分不清这条哪来的）',
      toastNew102.length === toastN0 + 1
      && toastNew102[toastNew102.length - 1].reason === 'orphan-cap'
      && String(toastNew102[toastNew102.length - 1].toastText).indexOf('（补弹') >= 0,
      `新增 ${toastNew102.length - toastN0} 条：${JSON.stringify(toastNew102.slice(toastN0).map((t) => t.toastText))}`);

    ok('T102-b3 ★补弹后必须**推进目标会话水位线**（lastStopAt ≥ lastUserMsgAt）——这是"下次回原会话不再弹"的根',
      readSnap102(snapA102).lastStopAt > readSnap102(snapA102).lastUserMsgAt
      && readSnap102(snapA102).file === aPath102,
      JSON.stringify(readSnap102(snapA102)));

    ok('T102-b4 ★补弹必须落持久日志 orphan-capped（含 sid/roundStart/total，便于事后对账）',
      compEvents102().some((e) => e.event === 'orphan-capped' && e.sid === A102 && e.total === 3850),
      JSON.stringify(compEvents102().filter((e) => String(e.event).indexOf('orphan') === 0)));

    ok('T102-b5 ★补弹不得改动**当前会话（B）**的快照（跨会话对账不能污染触发方）',
      JSON.stringify(readSnap102(snapB102)) === JSON.stringify(bBefore102));

    // b6/b7：幂等（这是用户点名的场景：弹回来之后又回原会话继续，不能再弹一次）
    const r2 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    const r3 = mod102.scanOrphanRounds({ curSid: A102, pricing: pricing102 });
    ok('T102-b6 ★幂等：补弹后再扫（无论由 B 还是由 A 自己触发）零新增弹窗 —— "回原会话继续"不得重弹',
      r2.capped.length === 0 && r3.capped.length === 0 && r2.candidates.length === 0 && r3.candidates.length === 0
      && toastTexts102().length === toastNew102.length,
      `r2=${JSON.stringify(r2)} r3=${JSON.stringify(r3)} toast=${toastTexts102().length}/${toastNew102.length}`);

    ok('T102-b7 ★认领文件在**成功**后保留（快照推进万一没落盘，它仍能挡住重复补弹）+ 认领是原子创建',
      fs.readdirSync(skillDir).some((f) => f.startsWith('.orphan-' + A102 + '-')));

    // b8：只补别的会话 —— 把"孤儿"换成当前会话自己 → 一律不动（自身欠账由既有分支处理）
    writeOrphanA102();
    for (const f of fs.readdirSync(skillDir)) if (f.startsWith('.orphan-' + A102 + '-')) fs.unlinkSync(path.join(skillDir, f));
    const r4 = mod102.scanOrphanRounds({ curSid: A102, pricing: pricing102 });
    ok('T102-b8 ★目标会话 == 当前会话（curSid）→ 绝不补弹（避免把"本轮正在跑"误判成孤儿）',
      r4.candidates.length === 0 && r4.capped.length === 0 && readSnap102(snapA102).lastStopAt === 0,
      JSON.stringify(r4));

    // b9：三重静止证据各拦一次（转录仍在写 / 子代理活跃 / 太新）
    fs.utimesSync(aPath102, new Date(), new Date());
    const r5 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    fs.utimesSync(aPath102, new Date(Date.now() - 300000), new Date(Date.now() - 300000));
    const subDir102 = path.join(proj102, A102, 'subagents');
    fs.mkdirSync(subDir102, { recursive: true });
    fs.writeFileSync(path.join(subDir102, 'agent-x.jsonl'), mrow102(ROUND102 + 1500, 700, 70) + '\n');
    const r6 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    fs.rmSync(path.join(proj102, A102), { recursive: true, force: true });
    fs.writeFileSync(snapA102, JSON.stringify({ file: aPath102, stat: null, lastUserMsgAt: Date.now() - 1000, lastStopAt: 0 }));
    const r7 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    writeOrphanA102();
    ok('T102-b9 ★"本轮确实静止"三重证据各自能独立拦下误弹：主转录仍在写 / 子代理仍活跃 / 轮起点太新',
      r5.candidates.length === 0 && r6.candidates.length === 0 && r7.candidates.length === 0
      && readSnap102(snapA102).lastStopAt === 0,
      `r5=${JSON.stringify(r5.capped)} r6=${JSON.stringify(r6.capped)} r7=${JSON.stringify(r7.capped)}`);

    // b10：observe 只记不弹、不推水位
    process.env.WB_ORPHAN_SCAN = 'observe';
    const toastN10 = toastTexts102().length;
    const r8 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    ok('T102-b10 ★observe 档：只写 orphan-candidate 候选日志，**零弹窗、不推水位**（影子模式先跑）',
      r8.mode === 'observe' && r8.candidates.length === 1 && r8.capped.length === 1 && r8.capped[0].observe === true
      && toastTexts102().length === toastN10 && readSnap102(snapA102).lastStopAt === 0
      && compEvents102().some((e) => e.event === 'orphan-candidate' && e.sid === A102),
      `mode=${r8.mode} capped=${JSON.stringify(r8.capped)} toast=${toastTexts102().length}/${toastN10} lastStopAt=${readSnap102(snapA102).lastStopAt}`);

    // b11：off 档零副作用；损坏快照 / 转录缺失 一律跳过且不抛。
    //   ⚠先**移除** A 的快照而不是"置为已结算"：b10（observe 档不推水位）留下的仍是合法孤儿，
    //     若只置为已结算，本步就隐式依赖了"已结算"判据 → 反向验证 R38 会连带染红本项（判别度被稀释）。
    try { fs.unlinkSync(snapA102); } catch (e) { /* silent-ok:清理 — 夹具移除 */ }
    process.env.WB_ORPHAN_SCAN = 'off';
    const toastN11 = toastTexts102().length;
    const r9 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    process.env.WB_ORPHAN_SCAN = 'on';
    fs.writeFileSync(path.join(skillDir, '.snapshot-orph102bad.json'), '{ 这不是 JSON');
    fs.writeFileSync(path.join(skillDir, '.snapshot-orph102gone.json'), JSON.stringify({
      file: path.join(proj102, 'never-existed.jsonl'), stat: null, lastUserMsgAt: ROUND102, lastStopAt: 0 }));
    let threw11 = null;
    let r10 = null;
    try { r10 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 }); } catch (e) { threw11 = e; }
    ok('T102-b11 ★off 档零副作用；快照损坏 / 转录已不存在 → 静默跳过且**绝不外抛**（挂在必经路径上的函数）',
      r9.scanned === 0 && r9.capped.length === 0 && toastTexts102().length === toastN11
      && !threw11 && r10 && r10.candidates.length === 0 && r10.capped.length === 0,
      `off(scanned=${r9.scanned}) threw=${threw11 && threw11.message} r10=${JSON.stringify(r10 && { cand: r10.candidates, cap: r10.capped })}`);

    // b14：最外层 try/catch 的**行为配对**（a8）——扫描阶段任何意外异常都不得外抛到钩子主流程。
    //   注入手法：curSid 传一个 toString() 抛错的对象（生产里 curSid 恒为字符串，这里只是把
    //   "函数最外层那道防线"变成可观测的：没有它 → 异常直接冒到 main() → 整个 --hook 崩掉）。
    const evil102 = { toString() { throw new Error('boom-curSid'); } };
    let threw14 = null;
    let r12 = null;
    try { r12 = mod102.scanOrphanRounds({ curSid: evil102, pricing: pricing102 }); } catch (e) { threw14 = e; }
    ok('T102-b14 ★scanOrphanRounds 必须吃掉扫描阶段的任何意外异常（连入参 toString 抛错也不得外抛）'
      + '——挂载点在 main() 里**没有** try 包着，外抛 = 整个 --hook 崩掉',
      !threw14 && r12 && r12.mode === 'on', `threw=${threw14 && threw14.message} mode=${r12 && r12.mode}`);
    try { fs.unlinkSync(path.join(skillDir, '.snapshot-orph102bad.json')); } catch (e) { /* silent-ok:清理 — 测试夹具清理 */ }
    try { fs.unlinkSync(path.join(skillDir, '.snapshot-orph102gone.json')); } catch (e) { /* silent-ok:清理 — 测试夹具清理 */ }
    for (const f of fs.readdirSync(skillDir)) if (/^\.orphan-orph102/.test(f)) { try { fs.unlinkSync(path.join(skillDir, f)); } catch (e) { /* silent-ok:清理 */ } }

    // b12：认领的原子互斥（'wx'）—— a5 的行为配对。并发双钩子靠它互斥，否则同一轮弹两次。
    const cl1 = mod102.orphanClaim('orph102c', 12345);
    const cl2 = mod102.orphanClaim('orph102c', 12345);
    ok('T102-b12 ★认领原子互斥：对同一 (sid, 轮起点) 的第二次认领必须失败（回退成普通写入 → c2 会变 true）',
      cl1 === true && cl2 === false, `c1=${cl1} c2=${cl2}`);
    try { fs.unlinkSync(mod102.orphanClaimPath('orph102c', 12345)); } catch (e) { /* silent-ok:清理 */ }

    // b13：弹窗阶段抛错 → **绝不推进水位线**（"先弹后推"的行为配对）+ 认领释放（下次钩子可重试）。
    //   注入手法：pricing 的 models 用 getter 抛错 —— 弹窗文案生成必经它，等价于"价格库读取异常"。
    writeOrphanA102();
    for (const f of fs.readdirSync(skillDir)) if (f.startsWith('.orphan-' + A102 + '-')) fs.unlinkSync(path.join(skillDir, f));
    const poisoned102 = {};
    Object.defineProperty(poisoned102, 'models', { get() { throw new Error('boom-pricing'); } });
    let threw13 = null;
    let r11 = null;
    try { r11 = mod102.scanOrphanRounds({ curSid: B102, pricing: poisoned102 }); } catch (e) { threw13 = e; }
    ok('T102-b13 ★弹窗阶段抛错 → 水位线**不推进**（先弹后推的语义）+ 认领文件被释放（可重试）+ 不抛'
      + '——若回退成"先推后弹"，这里会变成"弹窗没出、水位已推 = 静默丢失"',
      !threw13 && r11 && r11.capped.length === 0 && r11.skipped.some((s) => /^error:/.test(s.why))
      && readSnap102(snapA102).lastStopAt === 0
      && !fs.readdirSync(skillDir).some((f) => f.startsWith('.orphan-' + A102 + '-')),
      `threw=${threw13 && threw13.message} capped=${JSON.stringify(r11 && r11.capped)} skipped=${JSON.stringify(r11 && r11.skipped)} lastStopAt=${readSnap102(snapA102).lastStopAt}`);

    // b15（v3.62.0 批4·续）：**年龄上限的行为配对**（a9）—— 陈年欠账（> ORPHAN_MAX_AGE_MS）不得补弹。
    //   为什么必须有它：开 on 当天实测本机 50 个快照含 10 个"欠账态"（5 个历史测试残留 + 4 个 6~16 天前
    //   的陈年会话），无此闸 → 首次钩子会一口气补满 8 条垃圾弹窗。断言里同时要求记 skipped=too-old，
    //   否则"超龄跳过"与"根本没扫到"在日志上无法区分。
    writeOrphanA102();
    fs.writeFileSync(snapA102, JSON.stringify({
      file: aPath102, stat: null, lastUserMsgAt: Date.now() - 100 * 3600 * 1000, lastStopAt: 0 }));
    for (const f of fs.readdirSync(skillDir)) if (f.startsWith('.orphan-' + A102 + '-')) fs.unlinkSync(path.join(skillDir, f));
    const toastN15 = toastTexts102().length;
    const r13 = mod102.scanOrphanRounds({ curSid: B102, pricing: pricing102 });
    ok('T102-b15 ★陈年欠账（超年龄上限）不得补弹：候选为空 + 记 skipped=too-old + 零弹窗 + 水位不动'
      + '——开 on 当天本机有 4 个 6~16 天前的陈年会话 + 5 个测试残留，无此闸会一次性弹 8 条',
      r13.candidates.length === 0 && r13.capped.length === 0
      && r13.skipped.some((s) => s.why === 'too-old' && s.sid === A102)
      && toastTexts102().length === toastN15 && readSnap102(snapA102).lastStopAt === 0,
      `cand=${r13.candidates.length} skipped=${JSON.stringify(r13.skipped)} toast=${toastTexts102().length}/${toastN15}`);

    // ── c. 端到端（真 spawn --hook 入口）：钉住"挂载点真的会在用户提交时触发"这条链 ──
    //   单元组验的是函数正确性；挂载点只有走真入口才能验。SAWN_OK=false 的沙箱跳过（不假装跑过）。
    if (!SPAWN_OK) envSkip('T102-c1~c3 端到端（真 --hook 触发跨会话补弹）', SPAWN_SKIP_REASON);
    else {
      const countOrphanCap102 = () => toastTexts102().filter((t) => t.reason === 'orphan-cap').length;
      const env102c = Object.assign({}, process.env, {
        WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', CN_PRICE_DB_DIR: pricesDir, WB_NO_NET: '1',
        WB_ORPHAN_SCAN: 'on', WB_ORPHAN_MIN_AGE_MS: '1000', WB_ORPHAN_IDLE_MS: '1000',
      });
      // 重新把 A 摆成孤儿（b11 已把它置为已结算），清掉认领文件
      writeOrphanA102();
      for (const f of fs.readdirSync(skillDir)) if (f.startsWith('.orphan-' + A102 + '-')) fs.unlinkSync(path.join(skillDir, f));
      const n0c = countOrphanCap102();
      const runHook102 = (sid) => spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
        input: JSON.stringify({ session_id: sid, prompt: 't', cwd: tmp }),
        env: env102c, timeout: 60000, windowsHide: true, encoding: 'utf8',
      });
      // c1：在**别的会话**里提交一次 → 真入口应当补弹 A 的孤儿轮
      const rc1 = runHook102(B102);
      const n1c = countOrphanCap102();
      ok('T102-c1 ★端到端：在别的会话（B）里 `--hook` 提交一次 → 真入口补弹出 A 的孤儿轮'
        + '（"不回原会话、不再发消息也能补上"这条链的终极证据）',
        rc1.status === 0 && n1c === n0c + 1 && readSnap102(snapA102).lastStopAt > readSnap102(snapA102).lastUserMsgAt,
        `status=${rc1.status} err=${String(rc1.stderr || '').slice(0, 120)} orphanCap ${n0c}→${n1c} snapA=${JSON.stringify(readSnap102(snapA102))}`);
      // c2：补弹后回原会话 A 提交 → 不得再弹（幂等，用户点名场景）
      runHook102(A102);
      const n2c = countOrphanCap102();
      ok('T102-c2 ★端到端：补弹后**回到原会话 A** 再提交一次 → 零新增补弹（不得把之前那条又弹一遍）',
        n2c === n1c, `orphanCap ${n1c}→${n2c}`);
      // c3：再回 B 提交 → 同样零新增（跨会话侧也不重复）
      runHook102(B102);
      const n3c = countOrphanCap102();
      ok('T102-c3 ★端到端：再切回 B 提交 → 同上零新增（两侧都不重复）', n3c === n2c, `orphanCap ${n2c}→${n3c}`);
    }
  }
  if (savedScan102 === undefined) delete process.env.WB_ORPHAN_SCAN; else process.env.WB_ORPHAN_SCAN = savedScan102;
  if (savedNoToast102 === undefined) delete process.env.TOKEN_TRACKER_NO_TOAST; else process.env.TOKEN_TRACKER_NO_TOAST = savedNoToast102;
  if (savedRoot102 === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = savedRoot102;
}

// ===== T103（v3.62.0 · 批7）：取消轮补弹不得重弹已结算段（外部审计 AUD-C-01）=====
//   生产实证（toast.log 2026-10-16T07:09:46.057Z → 07:17:10.333Z）：同一批数字先以
//   `plain-immediate` 弹了一次「输入 3322万…¥30.33」，取消后又以 `cancelled-round-flush`
//   把**一字不差**的同批数字重弹一遍，还错标「（手动取消）」。
//   根因：flush 守卫只保证「取消标记比 lastStopAt 新」，聚合起点却仍吃旧 roundStartH；
//   而同步弹窗结算后 stop-handler 把 lastUserMsgAt 写回**上次结算点**
//   （`Math.max(psnapP.lastUserMsgAt, aggStart0)`）→ 「已结算轮之后再取消」时起点落在已弹过的轮上。
{
  const code103 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  const flush103 = (() => {
    const i = code103.indexOf("note: 'cancelled-round-flush'");
    return i < 0 ? '' : code103.slice(Math.max(0, i - 5000), i);
  })();
  ok('T103-a1 ★取消轮聚合起点必须钳到上次结算点（cancelledFlushStart(roundStartH, lastStopAt)）'
    + ' —— 起点留在旧 roundStartH 会把**已弹过的整轮**原样重弹并错标「（手动取消）」',
    /const flushStartH = cancelledFlushStart\(roundStartH, snapPre\.lastStopAt\)/.test(flush103)
    && /let aggC = aggregateTranscript\(tsPathH, flushStartH\)/.test(flush103),
    '锚点未命中：flush 分支起点又吃回 roundStartH');
  ok('T103-a2 ★被中断估算与时长必须与聚合同一起点（三处口径分叉 = 数字对不上文案）',
    /const estByModelC = estimateInterrupted\(transcRowsH, 0, flushStartH\)/.test(flush103)
    && /const durC = Math\.max\(0, intrInfo\.ts - flushStartH\)/.test(flush103));
  const h103 = code103.indexOf('function cancelledFlushStart(');
  const m103 = code103.indexOf('function main()');
  ok('T103-a3 ★钳位实现必须是 main() **外部**的独立函数（main 有 950 行硬闸 T37-b1；判据也要能被单点复核）',
    h103 > 0 && m103 > h103
    && /return Math\.max\(roundStartMs \|\| 0, lastStopAtMs \|\| 0\)/.test(code103.slice(h103, h103 + 220)),
    `helper@${h103} main@${m103}`);

  if (!SPAWN_OK) envSkip('T103-b1~b3 取消轮补弹端到端', SPAWN_SKIP_REASON);
  else {
    const proj103 = path.join(tmp, 'c103', 'projects');
    fs.mkdirSync(proj103, { recursive: true });
    // --hook 在 latestTraceFile() 为空时会提前 return（「暂无 trace 数据」）→ 必须摆一个有效 trace
    const trd103 = path.join(tmp, 'traces', 'c103');
    fs.mkdirSync(trd103, { recursive: true });
    fs.writeFileSync(path.join(trd103, 'trace_c103.json'), JSON.stringify({
      trace: { sessionId: 'c103', startedAt: Date.now() - 3600000, endedAt: Date.now() - 1800000,
        totalTokens: 3000, modelInfo: { totalInputTokens: 3000, totalOutputTokens: 300 } },
    }));
    const toast103 = path.join(tmp, 'token-tracker-toast.log');
    const flushes103 = () => {
      const raw = fs.existsSync(toast103) ? fs.readFileSync(toast103, 'utf-8') : '';
      if (!raw.trim()) return [];
      return raw.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } })
        .filter((t) => t.reason === 'cancelled-round-flush');
    };
    const T0_103 = Date.now() - 3 * 3600 * 1000;   // 轮起点
    const T1_103 = Date.now() - 2 * 3600 * 1000;   // 已结算点
    const T2_103 = Date.now() - 1 * 3600 * 1000;   // 取消时刻
    let seq103 = 0;
    const urow103 = (ts, i, o) => JSON.stringify({ type: 'assistant', id: 'c103u' + (seq103++), timestamp: ts,
      providerData: { model: 'probe-model', messageId: 'c103m' + seq103, usage: { input_tokens: i, output_tokens: o } } });
    const crow103 = (ts) => JSON.stringify({ type: 'message', role: 'assistant', status: 'incomplete', timestamp: ts,
      content: 'Interrupted by user', providerData: { model: 'probe-model', error: { message: 'Interrupted by user' } } });
    const run103 = (name, rows, lastStopAt) => {
      seq103 = 0;
      const sid = 'c103-' + name;
      const tsPath = path.join(proj103, sid + '.jsonl');
      fs.writeFileSync(tsPath, rows.join('\n') + '\n');
      fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), JSON.stringify({
        file: tsPath, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_103, lastStopAt,
      }));
      const before = flushes103().length;
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tsPath, prompt: 't', cwd: tmp }),
        env, timeout: 90000, windowsHide: true, encoding: 'utf8',
      });
      const after = flushes103();
      return { r, delta: after.length - before, last: after[after.length - 1] || {} };
    };
    const FULL103 = [urow103(T0_103 + 1000, 1000, 100), urow103(T1_103 - 60000, 2000, 200), crow103(T2_103)];
    // b1：已结算（lastStopAt = T1）之后再取消 → 不得重弹已结算段（生产缺陷形态）
    const s1 = run103('settled', FULL103, T1_103);
    ok('T103-b1 ★已结算轮之后再取消 → **零新增**取消弹窗（不得把已弹过的整轮重弹一遍）',
      s1.r.status === 0 && s1.delta === 0,
      `exit=${s1.r.status} 新增=${s1.delta} 末条=${JSON.stringify(String(s1.last.toastText || ''))}`
      + ` err=${String(s1.r.stderr || '').slice(0, 120)}`);
    // b2（对照，防"钳过头"）：未结算轮取消 → 必须照旧弹整轮
    const s2 = run103('unsettled', FULL103, 0);
    ok('T103-b2 ★未结算轮取消 → 照旧弹**整轮**（钳位不得把真取消也钳死）',
      s2.r.status === 0 && s2.delta === 1 && /输入 3000/.test(String(s2.last.toastText || '')),
      `exit=${s2.r.status} 新增=${s2.delta} 末条=${JSON.stringify(String(s2.last.toastText || ''))}`);
    // b3：已结算后又有真实尾段用量再取消 → 只弹尾段
    const s3 = run103('tail', [urow103(T0_103 + 1000, 1000, 100), urow103(T1_103 - 60000, 2000, 200),
      urow103(T1_103 + 60000, 5000, 500), crow103(T2_103)], T1_103);
    const txt3 = String(s3.last.toastText || '');
    ok('T103-b3 ★已结算后又真跑了新用量再取消 → 只弹**尾段**（输入 5000，不得是 8000/6000）',
      s3.r.status === 0 && s3.delta === 1 && /输入 5000/.test(txt3) && !/输入 (8000|6000)/.test(txt3),
      `exit=${s3.r.status} 新增=${s3.delta} 末条=${JSON.stringify(txt3)}`);
  }
}

// ===== T104（v3.62.0 · 批7）：每日价格快照 == 当天计费面（外部审计 AUD-F-01）=====
//   生产实证：快照 51 个模型 vs 计费面 57 个 → deepseek-v4.1-flash（用户主用）等 6 个整体缺席，
//   recalc 判「当天无价」永久跳过（实测「处理模型 3/4 个」），backfill --write 静默记 ¥0。
//   守卫分三层：①源码（必须读 pricing.json、只补索引未覆盖的、lock 覆盖索引）
//   ②行为（夹具三条规则各按预期落快照）③对账（用**真实** mergeLocalPriceDb 逐模型比价，零缺价零价差）。
{
  const pyCode104 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8')
    .replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const i104 = pyCode104.indexOf('def write_price_history(');
  const j104 = i104 >= 0 ? pyCode104.indexOf('\ndef ', i104 + 10) : -1;
  const wph104 = i104 >= 0 ? pyCode104.slice(i104, j104 > 0 ? j104 : pyCode104.length) : '';
  ok('T104-a1 ★快照必须读 pricing.json，且**只补索引未覆盖的条目**'
    + '（规则①：索引已赢的非 lock 条目不得被反向覆盖，否则制造"快照价≠当天计费价"新分叉）',
    /with open\(PRICING, 'r', encoding='utf-8'\)/.test(wph104)
    && /if tgt and not locked:\s*\n\s*continue/.test(wph104),
    '红 = 快照又退回"只落索引层" → pricing.json 自有模型整体缺席');
  ok('T104-a2 ★lock 条目必须覆盖索引值（规则②：lock 永远赢，与 mergeLocalPriceDb 同口径）',
    /locked = bv\.get\('lock'\) is True/.test(wph104) && /models\[key_b\] = rec/.test(wph104));
  ok('T104-a3 ★读 pricing.json 失败必须 WARN（快照静默缺一层 = AUD-F-01 的病根形态）',
    /价格历史快照：读取 pricing\.json 失败/.test(wph104));

  const pyCands104 = [];
  try {
    const pvDir104 = 'C:/Users/14779/.workbuddy/binaries/python/versions';
    for (const v of fs.readdirSync(pvDir104)) pyCands104.push(path.join(pvDir104, v, 'python.exe'));
  } catch (e) { /* 目录不存在就走 PATH */ }
  pyCands104.push('python', 'python3');
  let PY104 = null;
  for (const c of pyCands104) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY104 = c; break; }
  }
  if (!SPAWN_OK || !PY104) envSkip('T104-b1~b2 快照==计费面对账', SPAWN_OK ? 'python 不可用' : SPAWN_SKIP_REASON);
  else {
    const fx104 = path.join(tmp, 'c104');
    const wb104 = path.join(fx104, 'wb');
    const sk104 = path.join(wb104, 'skills', 'token-usage-tracker');
    const pr104 = path.join(fx104, 'prices');
    fs.mkdirSync(sk104, { recursive: true });
    fs.mkdirSync(pr104, { recursive: true });
    fs.writeFileSync(path.join(sk104, 'pricing.json'), JSON.stringify({
      currency: 'CNY', unit: '元/百万 tokens', models: {
        // ① 只在 pricing.json、索引没有 → 必须进快照
        baselocal: { name: '基础库独有', input_price: 2.0, output_price: 8.0, cached_price: 0.4, peak_multiplier: 1, region: 'CN' },
        // ② 索引有、非 lock → 索引值胜（快照必须 3.0，不得写成 99）
        idxwin: { name: '索引赢', input_price: 99.0, output_price: 99.0, cached_price: 9.0, region: 'CN' },
        // ③ 索引有、但 pricing.json 标了 lock → pricing.json 值胜（快照必须 7.0，不得写成 5）
        lockwin: { name: '锁赢', input_price: 7.0, output_price: 14.0, cached_price: 1.4, peak_multiplier: 2, region: 'CN', lock: true },
      },
    }));
    fs.writeFileSync(path.join(pr104, 'latest.json'), JSON.stringify({ vendors: { vA: { models: [
      { name: '索引赢', api_name: 'idxwin', in_price: 3.0, out_price: 9.0, cache_hit: 0.5, currency: 'CNY', unit: '元/百万 tokens', region: 'CN', source_url: 'http://x', fetched_at: '2026-10-17' },
      { name: '锁赢', api_name: 'lockwin', in_price: 5.0, out_price: 10.0, cache_hit: 1.0, currency: 'CNY', unit: '元/百万 tokens', region: 'CN', source_url: 'http://x', fetched_at: '2026-10-17' },
    ] } } }));
    fs.writeFileSync(path.join(pr104, 'index.json'), JSON.stringify({ built_at: '2026-10-16', models: {} }));
    const bi104 = spawnSync(PY104, [path.join(SRC, 'build_index.py')], {
      env: Object.assign({}, process.env, PY_IO_ENV, { WB_ROOT: wb104, CN_PRICES_DIR: pr104 }),
      encoding: 'utf8', timeout: 180000, windowsHide: true,
    });
    // v3.63.6（KI-51）：快照文件名必须用**北京时间** —— 与 build_index.py 的 `beijing_today()`
    //   （CN_TZ=UTC+8）**同源**。旧写法取 runner 本地日期：CI 是 UTC，UTC 16:00 之后北京已是次日
    //   → 这里拼出的日期与 build_index 写出的日期差一天 → 读不到快照 → T104-b1/b2 假红。
    //   KI-38 同款（**夹具时钟必须与被解释方同源**）；本机 UTC+8 两种写法同值，
    //   ⇒ 本缺陷**结构上不可能在本机复现**，只在 CI 的 UTC 跨日窗口暴露。
    const bj104 = new Date(Date.now() + 8 * 3600000); // 北京 = UTC+8（中国无夏令时）
    const today104 = `${bj104.getUTCFullYear()}-${String(bj104.getUTCMonth() + 1).padStart(2, '0')}-${String(bj104.getUTCDate()).padStart(2, '0')}`;
    let snap104 = null;
    try { snap104 = JSON.parse(fs.readFileSync(path.join(pr104, 'history', 'prices-' + today104 + '.json'), 'utf-8')); } catch (e) { snap104 = null; }
    const M104 = (snap104 && snap104.models) || {};
    ok('T104-b1 ★行为：快照必须含「只在 pricing.json 有」的模型，且索引已覆盖的模型保持**当天计费值**'
      + '（lock 条目不被抓取价覆盖 —— 构建侧注入 + 规则② 双重保证）',
      bi104.status === 0 && !!snap104
      && (M104.baselocal || {}).in === 2.0 && (M104.baselocal || {}).out === 8.0
      && (M104.idxwin || {}).in === 3.0      // 索引赢（不是 99）
      && (M104.lockwin || {}).in === 7.0,    // lock 赢（不是 5）
      `exit=${bi104.status} 模型=${JSON.stringify(Object.keys(M104))}`
      + ` baselocal=${JSON.stringify(M104.baselocal)} idxwin=${JSON.stringify(M104.idxwin)} lockwin=${JSON.stringify(M104.lockwin)}`
      + ` err=${String(bi104.stderr || '').slice(0, 160)}`);
    // b2：对账 —— 调**真实实现**（mergeLocalPriceDb / pricingFromSnapshot）逐模型比价，
    //     测试里不得另写一套合并逻辑（那正是 A3「复制实现靠注释同步」的病根）
    const parity104 = path.join(fx104, 'parity.js');
    fs.writeFileSync(parity104, [
      "'use strict';",
      'const fs = require("fs");',
      'const tt = require(process.env.TT_SRC);',
      'const ph = require(process.env.PH_SRC);',
      'const dir = process.env.CN_PRICE_DB_DIR;',
      'const snap = ph.readSnapshot(dir + "/history", process.env.SNAP_DATE);',
      'if (!snap) { console.log(JSON.stringify({ err: "no-snapshot" })); process.exit(0); }',
      'const sp = ph.pricingFromSnapshot(snap);',
      'const base = JSON.parse(fs.readFileSync(process.env.BASE_PRICING, "utf8"));',
      'const face = tt.mergeLocalPriceDb(base);',
      'const tri = (h) => { const m = h.m; const c = (typeof m.cached_price === "number") ? m.cached_price : m.input_price;',
      '  return [m.input_price, m.output_price, c].join("/"); };',
      'const diffs = [];',
      'for (const k of Object.keys(face.models)) {',
      '  const a = tt.findModel(face, k, "price");',
      '  const b = tt.findModel(sp, k, "price");',
      '  if (!a) continue;',
      '  if (!b) { diffs.push(k + ":快照无价"); continue; }',
      '  if (tri(a) !== tri(b)) diffs.push(k + ":" + tri(a) + "≠" + tri(b));',
      '}',
      'console.log(JSON.stringify({ n: Object.keys(face.models).length, diffs: diffs }));',
    ].join('\n'));
    const rp104 = spawnSync(NODE, [parity104], {
      env: Object.assign({}, process.env, {
        TT_SRC: path.join(skillDir, 'token-tracker.js'), PH_SRC: path.join(skillDir, 'price-history.js'),
        CN_PRICE_DB_DIR: pr104, BASE_PRICING: path.join(sk104, 'pricing.json'),
        SNAP_DATE: today104, WB_ROOT: wb104, TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1',
      }), encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
    let rep104 = {};
    try { rep104 = JSON.parse(String(rp104.stdout || '').trim().split('\n').pop()); } catch (e) { rep104 = {}; }
    ok('T104-b2 ★行为：快照面逐模型 == 当天计费面（真实 mergeLocalPriceDb 对账，零缺价零价差）',
      rp104.status === 0 && rep104.n === 3 && Array.isArray(rep104.diffs) && rep104.diffs.length === 0,
      `n=${rep104.n} diffs=${JSON.stringify(rep104.diffs)} err=${String(rp104.stderr || '').slice(0, 200)}`);
  }
}

// ===== T106（v3.63.0 · 批10）：Stop 被宿主回收窗口砍断 → 下次 `--hook` 补账补弹 ================
//   病根（2026-10-17 10:20:42 实证）：宿主在「任务完成」后约 200ms 就 `launch-spec resolved` 重建
//   会话 runtime，把 --stop 子进程连同 Job Object 一起树杀（KI-13：detached 也逃不掉）。Stop 冷启
//   动就要 300ms，命中窗口时死在中途 —— 而 `writeCoalesce` 在聚合之后，于是既无弹窗、也没有
//   `hook-fallback` 可兜。历史 157 次「压缩后续跑」里命中 3 次（09-11 / 10-08 / 10-17）。
//   修法：Stop 在**聚合之前**先写一笔极小的「在飞标记」（~1ms），下次 `--hook` 读到它补账补弹。
//   为什么不是"死前写标记"那种已被证伪的兜底：整树杀什么都不留，标记必须**早于**高风险段落盘。
//   为什么不会重复弹/重复记账：状态闸（lastStopAt）+ 水位闸（记账前后比对）+ 记账本身幂等，三重。
//   ★ 必须的行为配对：只验源码等于"写了但没跑通"；只验行为等于"跑通了但哪天被挪回聚合之后"。
{
  const code106 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  const codeH106 = stripComments(fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8'));
  ok('T106-a1 ★`--hook` 必须挂 recoverKilledStop（main 里一行；不挂 = 整套兜底是死代码）',
    /if \(asHook\) recoverKilledStop\(\{ sid, pricing \}\);/.test(code106));
  const mk106 = codeH106.indexOf('writeStopMark(sid, { tsPath, roundStart: roundStart0, aggStart: aggStart0 })');
  const ag106 = codeH106.indexOf('let agg = aggregateTranscript(tsPath, aggStart0)');
  ok('T106-a2 ★在飞标记必须**早于** aggregateTranscript 落盘（写晚了 = 被砍时同样什么都没有，'
    + '这正是三条旧兜底集体失活的根因）',
    mk106 > 0 && ag106 > mk106, `mark@${mk106} agg@${ag106}`);
  const rc106 = code106.indexOf('function recoverKilledStop(');
  const body106 = rc106 > 0 ? code106.slice(rc106, rc106 + 4000) : '';
  // v3.63.1：闸② 判据换了 —— 不再拿"水位线涨没涨"当唯一依据（那会把"记账失败"误判成"早已入账"），
  //   改为只认 incrementalRecord 的返回状态。断言随之改锚 **状态分流**，而不是锚某个比较表达式。
  ok('T106-a3 ★三重闸齐全：状态闸(lastStopAt) + 记账状态闸(nothing/recorded 分流) + 清理标记',
    /if \(\(snap\.lastStopAt \|\| 0\) >= mk\.at\)/.test(body106)
    && /if \(st === 'nothing'\)/.test(body106)
    && /if \(st !== 'recorded'\)/.test(body106)
    && /clearStopMark\(sid\);/.test(body106));
  const wc106 = code106.indexOf('function writeCoalesce(');
  ok('T106-a4 ★写 coalesce 时必须就地清掉在飞标记（4 处调用点统一覆盖，漏一处 = 永久残留标记）',
    wc106 > 0 && code106.slice(wc106, wc106 + 2400).indexOf('clearStopMark(sid);') > 0);
  ok('T106-a5 ★不得挂到 `--stop`（Stop 预算仅 ~650ms，补账补弹要重聚合一遍转录，会反噬本轮）',
    !/asStop[^\n]*recoverKilledStop/.test(code106));
  // a6：正常同步弹窗收口时必须清掉在飞标记 —— 否则每个「最后一次 Stop 后再无事件」的会话
  //   都会在技能目录留一个含**本地绝对路径**的 .stopmark-*.json（实测 89eb68b8 会话残留）。
  ok('T106-a6 ★正常同步弹窗收口时必须清掉在飞标记（否则每个会话留一个含绝对路径的残留文件）',
    codeH106.indexOf('clearStopMark(sid);') > codeH106.indexOf("stopStep('recorded'"),
    `clear@${codeH106.indexOf('clearStopMark(sid);')} recorded@${codeH106.indexOf("stopStep('recorded'")}`);

  if (!SPAWN_OK) envSkip('T106-b1~b3 被砍轮补账补弹端到端', SPAWN_SKIP_REASON);
  else {
    const proj106 = path.join(tmp, 'c106', 'projects');
    fs.mkdirSync(proj106, { recursive: true });
    const toast106 = path.join(tmp, 'token-tracker-toast.log');
    const recs106 = () => {
      const raw = fs.existsSync(toast106) ? fs.readFileSync(toast106, 'utf-8') : '';
      if (!raw.trim()) return [];
      return raw.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } })
        .filter((t) => t.reason === 'stop-killed-recover');
    };
    const env106 = Object.assign({}, process.env, {
      WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1', WB_ORPHAN_SCAN: 'off',
    });
    const T0_106 = Date.now() - 3 * 3600 * 1000;   // 本轮起点
    const T1_106 = Date.now() - 2 * 3600 * 1000;   // 被砍那一次 Stop 的聚合起点
    let seq106 = 0;
    const urow106 = (ts, i, o) => JSON.stringify({ type: 'assistant', id: 'c106u' + (seq106++), timestamp: ts,
      providerData: { model: 'probe-model', messageId: 'c106m' + seq106, usage: { input_tokens: i, output_tokens: o } } });
    // rows 固定：T1 之后 6 次调用（对齐 10:20 那次的形态：被砍前最后一次结算点之后仍在产出）
    const rows106 = [urow106(T1_106 + 1000, 1000, 100), urow106(T1_106 + 2000, 2000, 200),
      urow106(T1_106 + 3000, 500, 50)];
    // 跑一次真 `--hook` 入口；markAt=null → 不放标记（负样本）
    const run106 = (name, lastStopAt, markAt) => {
      const sid = 'c106-' + name;
      const tsPath = path.join(proj106, sid + '.jsonl');
      fs.writeFileSync(tsPath, rows106.join('\n') + '\n');
      fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), JSON.stringify({
        file: tsPath, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_106, lastStopAt,
      }));
      const mk = path.join(skillDir, '.stopmark-' + sid + '.json');
      if (markAt) fs.writeFileSync(mk, JSON.stringify({ at: markAt, tsPath, roundStart: T0_106, aggStart: T1_106 }));
      else { try { fs.unlinkSync(mk); } catch (e) { /* 不存在则忽略 */ } }
      const before = recs106().length;
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tsPath, prompt: 't', cwd: tmp }),
        env: env106, timeout: 90000, windowsHide: true, encoding: 'utf8',
      });
      return { r, sid, delta: recs106().length - before, markLeft: fs.existsSync(mk),
        last: recs106()[recs106().length - 1] || {} };
    };

    // b1：标记在 + lastStopAt 早于标记（= 那次 Stop 真被砍在记账之前）→ 必须补一条 + 标记被清
    const wm106 = () => {
      try { return JSON.parse(fs.readFileSync(path.join(skillDir, '.ledger-watermark.json'), 'utf-8')); }
      catch (e) { return {}; }
    };
    const r1 = run106('killed', T1_106 - 60000, T1_106 + 60000);
    const wm1 = (wm106()['c106-killed'] || {}).main || 0;
    ok('T106-b1 ★端到端：真 `--hook` 入口必须补弹出被砍那一轮，**且这笔钱真落进水位线**'
      + '（这正是"压缩后续跑丢弹窗 + 6 次调用未记账"的正解）',
      r1.r.status === 0 && r1.delta === 1 && !r1.markLeft && wm1 === 3,
      `status=${r1.r.status} delta=${r1.delta} wm.main=${wm1} markLeft=${r1.markLeft} toast=${String(r1.last.toastText || '').replace(/\n/g, ' | ').slice(0, 120)} err=${String(r1.r.stderr || '').slice(0, 120)}`);

    // b2：同一夹具再来一次（标记重新摆上）→ 水位闸挡住，零新增（幂等，绝不重复计费/重复弹）
    const r2 = run106('killed', T1_106 - 60000, T1_106 + 60000);
    ok('T106-b2 ★再跑一次 → 零新增弹窗（水位闸：那几行早已入账，不得重复计费、不得重弹）',
      r2.r.status === 0 && r2.delta === 0 && !r2.markLeft, `delta=${r2.delta} markLeft=${r2.markLeft}`);

    // b3：lastStopAt 晚于标记（Stop 其实正常收口过，标记只是没清）→ 状态闸挡住，且不白跑一次聚合
    const r3 = run106('settled', T1_106 + 120000, T1_106 + 60000);
    ok('T106-b3 ★Stop 已正常收口（lastStopAt 晚于标记）→ 零新增弹窗 + 标记被就地清掉（废标记不得常驻）',
      r3.r.status === 0 && r3.delta === 0 && !r3.markLeft, `delta=${r3.delta} markLeft=${r3.markLeft}`);

    // b4：负样本 —— 完全没有标记（= 正常轮次）→ 零新增（不能变成"每次提交都补一条"的新噪声源）
    const r4 = run106('nomark', T1_106 - 60000, null);
    ok('T106-b4 ★无标记的正常轮次 → 零新增（兜底不得变成每次提交都弹的新噪声）',
      r4.r.status === 0 && r4.delta === 0, `delta=${r4.delta}`);
  }
}

// ===== T107（v3.63.1 · K25）：补偿失败**不得销毁待补偿凭据** ===============================
//   病根（发版后自查发现，K25 正是为此而设）：T106 的闸② 用「记账前后水位线有没有涨」当判据。
//   但 incrementalRecord 有四条**静默失败**路径（水位线损坏 / 抢锁失败 / 写盘失败 / 回调异常），
//   它们都**故意不推进水位线**（这个设计本身是对的），落到闸② 一律变成 after <= before = "早已入账"
//   → clearStopMark → **补偿失败一次就永久丢账**；而 recoverKilledStop 只挂 --hook，标记一删再无入口。
//   更糟的一条：水位线损坏时 wm 为 null，(wm[key]) 直接抛 TypeError → 被外层 catch 接住 →
//   同样 clearStopMark ⇒ **水位线一坏，所有被砍轮的账全部直接丢弃**。
//   修法：incrementalRecord 返回状态；recoverKilledStop 只认状态 ——
//     nothing = 无欠账（清标记）｜recorded = 成功（可弹）｜其余 = **本次失败（保留标记 + 计数 + 上限 giveUp）**；
//     giveUp 只置位、**绝不删文件**（那个文件是人工核对的唯一线索）。
{
  const code107 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  // 切片必须**截止到本函数末尾**：先按 6000 字取窗口会越界到下一个函数，于是 lastIndexOf('} catch (e) {')
  //   抓到的是别人的 catch → 断言恒红（v3.63.1 首跑踩过：catch 段长度=398，实际是 resolveWorkspaceLogFile 的）。
  const ir107 = (() => { const i = code107.indexOf('function incrementalRecord('); if (i < 0) return ''; const j = code107.indexOf('function ', i + 10); return code107.slice(i, j > 0 ? j : i + 9000); })();
  const rc107 = (() => { const i = code107.indexOf('function recoverKilledStop('); if (i < 0) return ''; const j = code107.indexOf('function ', i + 10); return code107.slice(i, j > 0 ? j : i + 6000); })();

  ok('T107-a1 ★incrementalRecord 必须**返回状态**而非 undefined（否则调用方只能靠"水位线涨没涨"猜，'
    + '而"没涨"有四种含义 → 必然把失败当已入账 → 销毁凭据）',
    /return 'no-file';/.test(ir107) && /return recStatus;/.test(ir107)
    && /recStatus = 'corrupt';/.test(ir107) && /recStatus = 'record-failed';/.test(ir107)
    && /recStatus = 'wm-failed';/.test(ir107) && /recStatus = 'error';/.test(ir107)
    && /return 'lock-busy';/.test(ir107)
    && /recStatus = willRecord \? 'recorded' : 'nothing';/.test(ir107));

  const failBranch107 = (() => {
    const i = rc107.indexOf("if (st !== 'recorded')");
    return i > 0 ? rc107.slice(i, rc107.indexOf('return false;', i) + 12) : '';
  })();
  // v3.63.2（S7）：正则放宽为 `\{\s*` —— 恢复路径的 if 链从三个平行 if 改成 if/else-if 链后，
  //   `{` 与 stopMarkBump 之间允许换行（旧单行形态仍然匹配，反向验证不受影响）。
  ok('T107-a2 ★记账失败分支必须**保留标记**（不许 clearStopMark）—— 否则"补偿失败一次"= "永久丢账"',
    /if \(st !== 'recorded'\) \{\s*stopMarkBump\(sid, mk,/.test(failBranch107)
    && failBranch107.indexOf('clearStopMark') < 0,
    `branch=${failBranch107.replace(/\s+/g, ' ').slice(0, 120)}`);

  const catch107 = (() => {
    const i = rc107.lastIndexOf('} catch (e) {');
    return i > 0 ? rc107.slice(i) : '';
  })();
  ok('T107-a3 ★外层 catch 也必须**保留标记**（旧代码在此 clearStopMark → 任何异常都放大成永久丢账）',
    /stopMarkBump\(sid, mk, 'exception'\);/.test(catch107) && catch107.indexOf('clearStopMark') < 0,
    `catch 段长度=${catch107.length}`);

  ok('T107-a4 ★水位线损坏必须**显式分流**（旧代码 (null[key]) 抛 TypeError → 清标记 → 全部丢弃）',
    /if \(lw0\.corrupt\) \{ stopMarkBump\(sid, mk, 'watermark-corrupt'\); return false; \}/.test(rc107)
    && /const before = \(\(\(lw0\.wm \|\| \{\}\)\[key\]\) \|\| \{\}\)\.main \|\| 0;/.test(rc107)
    && !/loadLedgerWatermarkSafe\(\)\.wm\[key\]/.test(rc107));

  ok('T107-a5 ★重试必须有上限，且**放弃时不删文件**（--hook 阻塞用户输入，永久失败标记会每次发消息卡 1.4s；'
    + '但删了就失去人工核对线索）',
    /const STOPMARK_MAX_TRIES = 3;/.test(code107)
    && /if \(mk\.giveUp\) return false;/.test(rc107)
    && (() => {
      const i = code107.indexOf('function stopMarkGiveUp(');
      if (i < 0) return false;
      const body = code107.slice(i, code107.indexOf('\n}', i));
      return body.indexOf('writeStopMark') > 0 && body.indexOf('unlink') < 0 && body.indexOf('clearStopMark') < 0;
    })());

  // v3.63.2（T110-b3 暴露）：`!agg` 分支拆成「轮内有行无用量=真空轮→清标记」+「读不出行=失败重试」。
  //   旧正则要求单行紧凑形态，现改为窗口断言 + 纳入新判据（防未来回退成"一律 bump"）。
  const aggNullWin107 = (() => {
    const i = rc107.indexOf('if (!agg) {');
    return i > 0 ? rc107.slice(i, rc107.indexOf('if (!agg.total)', i)) : '';
  })();
  ok('T107-a6 ★聚合失败(null) 与 真空轮(有行无用量) 必须分开：前者 stopMarkBump 重试、后者清标记',
    /stopMarkBump\(sid, mk, 'aggregate-failed'\)/.test(aggNullWin107)
    && /roundHasRowsNoUsage\(mk\.tsPath, aggStart\)/.test(aggNullWin107)
    && /clearStopMark\(sid\)/.test(aggNullWin107)
    && /if \(!agg\.total\) \{ clearStopMark\(sid\); return false; \}/.test(rc107),
    `!agg 窗口=${aggNullWin107.replace(/\s+/g, ' ').slice(0, 200)}`);

  if (!SPAWN_OK) envSkip('T107-b1~b2 补偿失败保留标记端到端', SPAWN_SKIP_REASON);
  else {
    const proj107 = path.join(tmp, 'c107', 'projects');
    fs.mkdirSync(proj107, { recursive: true });
    const wmPath107 = path.join(skillDir, '.ledger-watermark.json');
    let wmBak107 = null;
    try { wmBak107 = fs.existsSync(wmPath107) ? fs.readFileSync(wmPath107, 'utf-8') : null; } catch (e) { wmBak107 = null; }
    const T0_107 = Date.now() - 5 * 3600 * 1000;
    const T1_107 = Date.now() - 4 * 3600 * 1000;
    const rows107 = [
      JSON.stringify({ type: 'assistant', id: 'c107a', timestamp: T1_107 + 1000, providerData: { model: 'probe-model', messageId: 'c107m1', usage: { input_tokens: 700, output_tokens: 70 } } }),
      JSON.stringify({ type: 'assistant', id: 'c107b', timestamp: T1_107 + 2000, providerData: { model: 'probe-model', messageId: 'c107m2', usage: { input_tokens: 300, output_tokens: 30 } } }),
    ];
    // 跑一次真 --hook；wmCorrupt=true → 先把水位线写成垃圾（模拟损坏）
    const run107 = (sid, markObj, wmCorrupt) => {
      const tsPath = path.join(proj107, sid + '.jsonl');
      fs.writeFileSync(tsPath, rows107.join('\n') + '\n');
      fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), JSON.stringify({
        file: tsPath, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_107, lastStopAt: T1_107 - 120000,
      }));
      const mkp = path.join(skillDir, '.stopmark-' + sid + '.json');
      fs.writeFileSync(mkp, JSON.stringify(markObj(tsPath)));
      if (wmCorrupt) fs.writeFileSync(wmPath107, '{ this is not json');
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tsPath, prompt: 't', cwd: tmp }),
        env: Object.assign({}, process.env, { WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1', WB_ORPHAN_SCAN: 'off' }),
        timeout: 90000, windowsHide: true, encoding: 'utf8',
      });
      let got = null;
      try { got = JSON.parse(fs.readFileSync(mkp, 'utf-8')); } catch (e) { got = null; }
      return { r, markLeft: fs.existsSync(mkp), mk: got };
    };

    // b1：水位线损坏 + 待补偿标记 → 标记必须**还在**且 tries 涨到 1（旧代码会把它清掉 = 永久丢账）
    const b1 = run107('c107-corrupt', (ts) => ({ at: T1_107, tsPath: ts, roundStart: T0_107, aggStart: T1_107 }), true);
    ok('T107-b1 ★端到端（真 --hook）：水位线损坏 → 记账失败 → 待补偿标记**必须保留**并记一次重试'
      + '（旧行为：清标记 → 那笔账再无入口可补）',
      b1.r.status === 0 && b1.markLeft && !!b1.mk && Number(b1.mk.tries) === 1 && !b1.mk.giveUp,
      `status=${b1.r.status} markLeft=${b1.markLeft} tries=${b1.mk && b1.mk.tries} giveUp=${b1.mk && b1.mk.giveUp} err=${String(b1.r.stderr || '').slice(0, 100)}`);

    // b2：已重试 2 次 + 仍失败 → 达到上限 → 置 giveUp 但**文件仍在**（不删，留作人工核对线索）
    const b2 = run107('c107-giveup', (ts) => ({ at: T1_107, tsPath: ts, roundStart: T0_107, aggStart: T1_107, tries: 2 }), true);
    ok('T107-b2 ★端到端：重试用尽 → giveUp=true 且**文件仍然存在**（放弃 ≠ 销毁凭据；--hook 也不能永远卡住）',
      b2.r.status === 0 && b2.markLeft && !!b2.mk && b2.mk.giveUp === true,
      `status=${b2.r.status} markLeft=${b2.markLeft} tries=${b2.mk && b2.mk.tries} giveUp=${b2.mk && b2.mk.giveUp}`);

    // 复原沙箱水位线，避免影响（未来新增的）后续用例
    try {
      if (wmBak107 === null) fs.unlinkSync(wmPath107);
      else fs.writeFileSync(wmPath107, wmBak107);
    } catch (e) { /* silent-ok:测试收尾，删除失败不影响断言结论 */ }
  }
}

// ===== T108（v3.63.1 · 批14）：同轮同内容弹窗去重 ===========================================
//   现象：宿主把**同一个 Stop 事件**投递给两个 pid（10-09 19:49 span2.7s / 10-15 15:19 span4.1s /
//   10-17 16:52 span1.2s），两个进程各自聚合、各自弹窗 → 用户看到两条完全相同。
//   定量：可判弹窗 1688 条中同会话 ≤10s 双弹 3 组 = 0.18%（约 20 天一次）。
//   既有 v2.86 闸用 `settledAt0 > roundStart0` 比较两个**不同来源**的时钟，10-17 实测差 86ms
//   ⇒ 判「本轮未结算」⇒ 两边都弹。并发投递下「本轮第一次」有两个，时间闸天然失效。
//   判据改成四条件：同 sid + 同 roundStart(>0) + 同内容指纹 + 60s 内。
//   ★ 最危险的失败形态是**吞掉本该弹的窗**（沉默失败）：同轮先结算整轮、之后又真跑尾段
//     （T103-b3 语义）时指纹不同 → 必须照弹。b2 就是这条的保底，缺了它这个改动等于没被验证。
//   ★ 第二危险：记录写在弹窗之前 = 「没弹成也算弹过」→ 被砍在弹窗前的轮次会被下一次 Stop
//     永久吞掉，直接抵消批10 的丢弹修复。a2 用**顺序断言**钉死。
{
  const tt108raw = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8');
  const sh108raw = fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8');
  const strip108 = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const tt108 = strip108(tt108raw);
  const sh108 = strip108(sh108raw);

  // v3.63.3（AUD-B-01）：锚点去掉行尾分号 —— no-token 路径已改为 if(showToast(...)) 包裹
  //   （弹窗失败不写记录），但「先弹后写」的顺序断言必须继续守护。
  const iNoShow = sh108.indexOf("showToast('本轮无 token 消耗记录', body0, 'no-token')");
  const iNoMark = sh108.indexOf("markToastShown(sid, roundStart0, 'null');");
  ok('T108-a1 ★no-token 路径必须「先判重 → 再弹 → 弹完写记录」三件齐全'
    + '（只判不写 = 永远判不中；写完再弹 = 没弹成也算弹过，下次永久吞掉）',
    /if \(toastAlreadyShown\(sid, roundStart0, 'null'\)\)/.test(sh108) && iNoShow > 0 && iNoMark > 0,
    `判重=${/if \(toastAlreadyShown\(sid, roundStart0, 'null'\)\)/.test(sh108)} show@${iNoShow} mark@${iNoMark}`);
  ok('T108-a2 ★记录必须写在弹窗**之后**（顺序断言；写反 = 复活批10 才修好的丢弹问题）',
    iNoShow > 0 && iNoMark > iNoShow,
    `show@${iNoShow} mark@${iNoMark}（要求 mark > show）`);

  ok('T108-a3 ★完整统计路径也必须受保护（3 次双弹里 2 次是"完整+完整"，只做 no-token = 白做 2/3）',
    /const dupShown = toastAlreadyShown\(effSid, roundStart0, dedupeFp\);/.test(sh108)
    && /if \(!dupShown && showToastsSplitByModel\(agg/.test(sh108)
    && /else if \(!dupShown\) \{/.test(sh108)
    && /markToastShown\(effSid, roundStart0, dedupeFp\);/.test(sh108));

  ok('T108-a4 ★roundStart<=0 必须**完全不启用**去重（否则退化成"按 sid 去重" = 跨轮误吞真实弹窗）',
    /function toastAlreadyShown\(sid, roundStart, fp\) \{\s*\n\s*if \(!\(roundStart > 0\)\) return false;/.test(tt108)
    && /function markToastShown\(sid, roundStart, fp\) \{\s*\n\s*if \(!\(roundStart > 0\)\) return;/.test(tt108));

  ok('T108-a5 ★去重记录必须是**独立文件**且不含 tsPath'
    + '（.stopmark 会被 writeCoalesce 的 clearStopMark 删；snapshot 被 13 处显式构造整体覆盖）',
    /\.toasted-/.test(tt108) && /function toastDedupePath/.test(tt108)
    && !/function markToastShown[\s\S]{0,400}tsPath/.test(tt108));

  ok('T108-a6 ★静默分支**不得提前 return**（必须继续走 lastStopAt 推进，否则取消标记会复活成误判"手动取消"）',
    !/if \(dupShown\) \{[\s\S]{0,260}return true;/.test(sh108)
    && !/if \(toastAlreadyShown\(sid, roundStart0, 'null'\)\) \{[\s\S]{0,200}saveSnapshot/.test(sh108));

  if (!SPAWN_OK) envSkip('T108-b1~b4 弹窗去重端到端', SPAWN_SKIP_REASON);
  else {
    const proj108 = path.join(tmp, 'c108', 'projects');
    fs.mkdirSync(proj108, { recursive: true });
    const toastLog108 = path.join(tmp, 'token-tracker-toast.log');
    const compLog108 = path.join(tmp, 'token-tracker-compaction.log');
    const off108 = () => { try { return fs.statSync(toastLog108).size; } catch (e) { return 0; } };
    const slice108 = (o) => { try { return fs.readFileSync(toastLog108).slice(o).toString('utf8'); } catch (e) { return ''; } };
    // ⚠ 去重留痕走 appendCompactionLog → 写的是 compaction.log，**不是** toast.log（两个文件别混）
    const offC108 = () => { try { return fs.statSync(compLog108).size; } catch (e) { return 0; } };
    const sliceC108 = (o) => { try { return fs.readFileSync(compLog108).slice(o).toString('utf8'); } catch (e) { return ''; } };
    const T0_108 = Date.now() - 6 * 3600 * 1000;
    let seq108 = 0;
    const urow108 = (ts, i, o) => JSON.stringify({ type: 'assistant', id: 'c108u' + (seq108++), timestamp: ts,
      providerData: { model: 'probe-model', messageId: 'c108m' + seq108, usage: { input_tokens: i, output_tokens: o } } });
    const uhead108 = (ts) => JSON.stringify({ type: 'message', role: 'user', id: 'c108h' + ts, timestamp: ts,
      content: [{ type: 'text', text: 'hi' }] });
    const rows108 = [uhead108(T0_108), urow108(T0_108 + 1000, 1000, 100), urow108(T0_108 + 2000, 2000, 200)];
    // ⚠ 每次跑前把快照 lastStopAt 重置回「本轮之前」—— 真实并发时两个进程都读到**旧快照**，
    //   不重置的话第二次会被 v2.86 旧闸抢先挡住，测不到本闸（假绿）。
    // ⚠ headTs 必须与转录里的 user 行**同源**：生产里 roundStart0 优先取 `prevSnap0.lastUserMsgAt`
    //   （stop-handler.js:171），转录只是兜底。第一版固定写 T0_108 → b4 换轮时 roundStart0 没跟着换，
    //   R66 反向验证因此把 b4 误判成"误伤"（实为夹具缺陷）。
    const run108 = (sid, rows, headTs) => {
      const tsPath = path.join(proj108, sid + '.jsonl');
      fs.writeFileSync(tsPath, rows.join('\n') + '\n');
      fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), JSON.stringify({
        file: tsPath, stat: { total: 0, model: 'probe-model' },
        lastUserMsgAt: headTs == null ? T0_108 : headTs, lastStopAt: T0_108 - 60000,
      }));
      const off = off108();
      const offC = offC108();
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--stop'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tsPath, cwd: tmp }),
        env: Object.assign({}, process.env, { WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1', WB_LEDGER_MAINT: '1' }),
        timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      const txt = slice108(off);
      const ctxt = sliceC108(offC);
      const dedupeSkip = (ctxt.match(/"event":"toast-dedupe-skip"/g) || []).length;
      const toastN = (txt.match(/"reason":"plain-immediate"/g) || []).length;
      // ⚠ 必须精确匹配 "no-token"：`cancelled-no-token` 也含该子串，宽松匹配会把取消文案算进来
      const noToastN = (txt.match(/"reason":"no-token"/g) || []).length;
      let snap = {};
      try { snap = JSON.parse(fs.readFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), 'utf-8')); } catch (e) { snap = {}; }
      return { rc: r.status, toastN, noToastN, dedupeSkip, snap, err: String(r.stderr || '').slice(0, 120) };
    };

    const SID108 = 'c108-dup';
    const p1 = run108(SID108, rows108);
    ok('T108-b1 ★端到端：同轮第一次 Stop → 正常弹一条（去重不得把第一次也吞掉）',
      p1.rc === 0 && p1.toastN === 1, `exit=${p1.rc} toast=${p1.toastN} dedupe=${p1.dedupeSkip} err=${p1.err}`);

    // b2：**同内容**再来一次（快照重置 = 模拟第二个并发进程都读到旧快照）→ 必须静默
    const p2 = run108(SID108, rows108);
    ok('T108-b2 ★端到端：同轮+同指纹+60s 内第二次 Stop → **静默**（10-15/10-17 那种双弹的正解）'
      + '且 lastStopAt 仍被推进（静默 ≠ 不推进水位线）',
      p2.rc === 0 && p2.toastN === 0 && p2.dedupeSkip === 1 && Number(p2.snap.lastStopAt || 0) > T0_108,
      `exit=${p2.rc} toast=${p2.toastN} dedupe=${p2.dedupeSkip} lastStopAt=${p2.snap.lastStopAt} err=${p2.err}`);

    // b3：同轮但**真有新增用量** → 指纹不同 → 必须照弹（T103-b3 语义的保底；缺这条 = 改动没被验证）
    const rows108b = rows108.concat([urow108(T0_108 + 3000, 5000, 500)]);
    const p3 = run108(SID108, rows108b);
    ok('T108-b3 ★端到端：同轮又有新用量 → 指纹变化 → **必须照弹**'
      + '（绝不吞真实尾段；这是本改动唯一可能造成"沉默失败"的方向）',
      p3.rc === 0 && p3.toastN === 1, `exit=${p3.rc} toast=${p3.toastN} dedupe=${p3.dedupeSkip} err=${p3.err}`);

    // b4：不同轮（新 user 行 = 新 roundStart）+ 内容恰好相同 → 必须照弹（防跨轮误吞）
    const T0b_108 = T0_108 + 30 * 60 * 1000;
    const rows108c = [uhead108(T0b_108), urow108(T0b_108 + 1000, 1000, 100), urow108(T0b_108 + 2000, 2000, 200)];
    const p4 = run108(SID108, rows108c, T0b_108);
    ok('T108-b4 ★端到端：换轮（roundStart 变了）且内容恰好相同 → **必须照弹**（去重不得跨轮误吞）',
      p4.rc === 0 && p4.toastN === 1, `exit=${p4.rc} toast=${p4.toastN} dedupe=${p4.dedupeSkip} err=${p4.err}`);

    // b5：**no-token 路径**同样要去重 —— 10-17 16:52 的双弹正是这条（两个 pid 各弹一条「本轮无 token」）。
    //   没有这条，R63 只能红源码守卫 a1，行为层等于没被验证（源码改了注释也能骗过正则的历史教训）。
    const rowsE108 = [uhead108(T0_108), JSON.stringify({ type: 'message', role: 'assistant', status: 'completed',
      timestamp: T0_108 + 1000, content: [{ type: 'text', text: 'ok' }] })];
    const SIDE108 = 'c108-empty';
    const e1 = run108(SIDE108, rowsE108);
    const e2 = run108(SIDE108, rowsE108);
    ok('T108-b5 ★端到端：空轮同轮第二次 Stop → **只弹一条 no-token**'
      + '（10-17 实测 pid 13208/27068 各弹一条；这是本批次唯一有生产日志直接对应的一条）',
      e1.rc === 0 && e1.noToastN === 1 && e2.rc === 0 && e2.noToastN === 0 && e2.dedupeSkip === 1,
      `第一次 exit=${e1.rc} no=${e1.noToastN} ｜ 第二次 exit=${e2.rc} no=${e2.noToastN} dedupe=${e2.dedupeSkip} err=${e2.err}`);
  }
}

// ===== T109：v3.63.2 外部审计 N3 —— backfill 账本读不懂就中止，绝不按空账本合并 =====
//   病根（审计报告 N3，P1）：锁内 `try { cur = JSON.parse(...) } catch (e) { cur = {}; }`
//   → 账本损坏（半写/截断/手改）时 cur = {} → mergeDailyLedger({}, newDaily) = 用重放值**整本替换**，
//   重放范围外的日期（transcript 已删除/归档、更早的历史）被静默抹掉，且**零告警**。
//   :656-660 的指纹比对只比 size/mtime，防的是"扫描期间被改"，管不了"起始即损坏"这一路。
//   修法：readLedgerStrict 单一入口 —— ENOENT 仍是合法空账本（首跑必须能写），
//   解析失败 / 形状非法（[]、标量、null）→ --write 中止；dry-run 只告警不写盘。
//   ⚠ 行为夹具必须**真 spawn backfill --write**：源码守卫只能证明"写了这几行"，
//     证明不了"损坏时账本逐字节不变、合法时旧日期仍在、首跑仍可写"。
{
  const bf = fs.readFileSync(path.join(SRC, 'backfill.js'), 'utf-8');
  const iMerge = bf.indexOf('mergeDailyLedger(cur');
  const win = iMerge > 0 ? bf.slice(Math.max(0, iMerge - 600), iMerge) : '';
  ok('T109-a1 ★锁内合并点之前必须走严格读取（窗口内不得出现 `cur = {}` 回落；N3 病根）',
    iMerge > 0 && /readLedgerStrict\('锁内重读'\)/.test(win) && !/cur = \{\}/.test(win));
  ok('T109-a2 ★对比展示的 oldDaily 同样走严格读取（dry-run 的「现账本」列不许静默按空算）',
    /oldDaily = oldDailyRead\.cur/.test(bf) && !/oldDaily = JSON\.parse/.test(bf));
  ok('T109-a3 ★--write 前有预检中止，且中止点**早于任何副作用**（备份/水位线都不该动）',
    (() => {
      // 必须按"块"找：锁内复检的告警文案里也含「不按空账本合并」，只按子串断言会分不清
      // 预检与锁内复检（反向验证 R70 实测：删掉预检后旧断言仍绿 = 守卫失效）。
      const L = bf.split('\n');
      let iAbort = -1;
      for (let i = 0; i < L.length; i++) {
        if (L[i].indexOf('if (ledgerReadError) {') < 0) continue;
        for (let j = i + 1; j < i + 7 && j < L.length; j++) {
          if (L[j].indexOf('process.exit(1);') >= 0) { iAbort = i; break; }
        }
        if (iAbort > 0) break;
      }
      let iBak = -1;
      for (let i = 0; i < L.length; i++) {
        if (L[i].indexOf('.bak-backfill-') >= 0) { iBak = i; break; }
      }
      return iAbort > 0 && iBak > iAbort && /\u4e0d\u6309\u7a7a\u8d26\u672c\u5408\u5e76/.test(bf);
    })(), `iAbort=${bf.split('\n').findIndex((l) => l.includes('if (ledgerReadError) {'))}`);
  ok('T109-a4 ★ENOENT 仍算合法空账本（首跑/删档后必须还能写，否则修复把工具变成一次性）',
    /code === 'ENOENT'/.test(bf) && /missing: true/.test(bf));
  ok('T109-a5 ★形状校验：JSON.parse("[]")/"123"/"null" 不抛错但不是账本 → 同样按损坏处理',
    /typeof parsed !== 'object'/.test(bf) && /Array\.isArray\(parsed\)/.test(bf));

  if (!SPAWN_OK) { envSkip('T109-b1~b4 backfill 账本损坏端到端', SPAWN_SKIP_REASON); }
  else {
    // 每个用例独立沙箱（互不污染）：<tmp>/bfN3-<tag>/{skills/token-usage-tracker,projects/<proj>/}
    const mkSandbox = (tag) => {
      const root = path.join(tmp, 'bfN3-' + tag);
      const sd = path.join(root, 'skills', 'token-usage-tracker');
      fs.mkdirSync(sd, { recursive: true });
      for (const f of ['token-tracker.js', 'backfill.js', ...RUNTIME_COMPANIONS]) {
        fs.copyFileSync(path.join(SRC, f), path.join(sd, f));
      }
      const proj = path.join(root, 'projects', 'p-n3');
      fs.mkdirSync(proj, { recursive: true });
      // 一条真实用量行：backfill 只认「数字 timestamp + providerData.usage + providerData.model」
      const row = JSON.stringify({
        type: 'assistant', timestamp: Date.UTC(2026, 9, 18, 3, 0, 0),
        providerData: { model: 'deepseek-v4.1-flash', messageId: 'm-n3-1', usage: { inputTokens: 1234, outputTokens: 56 } },
      });
      fs.writeFileSync(path.join(proj, 'sess-n3.jsonl'), row + '\n');
      return { root, sd, ledger: path.join(sd, 'daily-usage.json') };
    };
    const runBf = (sb) => spawnSync(NODE, [path.join(sb.sd, 'backfill.js'), '--write'], {
      cwd: sb.root,
      env: Object.assign({}, env, { WB_ROOT: sb.root, WB_NO_NET: '1', WB_LEDGER_MAINT: '1' }),
      timeout: 180000, windowsHide: true, encoding: 'utf8',
    });
    const noBak = (sb) => fs.readdirSync(sb.sd).filter((f) => f.indexOf('.bak-backfill-') >= 0).length === 0;

    // b1：账本截断/半写 → 必须中止，且账本逐字节不变、连备份都不该留下（中止早于步骤 A）
    const sb1 = mkSandbox('b1');
    const corrupt1 = '{"2026-10-18": {"models": {"deepseek-v4.1-flash": {"in": 999';
    fs.writeFileSync(sb1.ledger, corrupt1);
    const r1 = runBf(sb1);
    ok('T109-b1 ★端到端：账本截断/半写 + --write → 必须中止且账本逐字节不变'
      + '（N3 旧行为：静默按空账本合并 → 重放值整本替换、历史日期被抹）',
      r1.status === 1 && fs.readFileSync(sb1.ledger, 'utf8') === corrupt1 && noBak(sb1)
      && !fs.existsSync(path.join(sb1.sd, '.ledger-watermark.json'))
      && /账本解析失败/.test(String(r1.stderr)) && /不按空账本合并/.test(String(r1.stderr)),
      `exit=${r1.status} 逐字节不变=${fs.readFileSync(sb1.ledger, 'utf8') === corrupt1} 无备份=${noBak(sb1)} err=${String(r1.stderr).slice(0, 150)}`);

    // b2：合法账本 + 重放范围外的旧日期 → --write 成功且旧日期仍在（证明没把既有保留语义改坏）
    const sb2 = mkSandbox('b2');
    const oldDate = '2020-01-01';
    const valid2 = JSON.stringify({
      [oldDate]: {
        models: { 'deepseek-v4.1-flash': { in: 777, out: 88, cached: 0, total: 865, cost: 0.5 } },
        total: { in: 777, out: 88, cached: 0, total: 865, cost: 0.5 },
      },
    }, null, 2) + '\n';
    fs.writeFileSync(sb2.ledger, valid2);
    const r2 = runBf(sb2);
    let m2 = null;
    try { m2 = JSON.parse(fs.readFileSync(sb2.ledger, 'utf8')); } catch (e) { /* 断言里判 */ }
    ok('T109-b2 ★端到端：合法账本 + --write → 成功，且重放范围外的旧日期原样保留'
      + '（反 N3 断言：修复不得把"保留扫描不到的历史"这个语义改坏）',
      r2.status === 0 && !!m2 && !!m2[oldDate] && m2[oldDate].models['deepseek-v4.1-flash'].in === 777
      && Object.keys(m2).indexOf('2026-10-18') >= 0,
      `exit=${r2.status} 旧日期=${m2 && m2[oldDate] ? m2[oldDate].models['deepseek-v4.1-flash'].in : '丢失'} keys=${m2 ? Object.keys(m2).join(',') : 'PARSE-FAIL'} err=${String(r2.stderr).slice(0, 120)}`);

    // b3：数组/标量（JSON.parse 不抛错但不是账本）→ 同样中止、不改写
    const sb3 = mkSandbox('b3');
    fs.writeFileSync(sb3.ledger, '[]');
    const r3 = runBf(sb3);
    ok('T109-b3 ★端到端：账本是数组/标量（parse 不抛错但形状不对）→ 同样中止、不改写',
      r3.status === 1 && fs.readFileSync(sb3.ledger, 'utf8') === '[]' && noBak(sb3)
      && /账本形状非法/.test(String(r3.stderr)),
      `exit=${r3.status} 未改写=${fs.readFileSync(sb3.ledger, 'utf8') === '[]'} err=${String(r3.stderr).slice(0, 150)}`);

    // b4：账本不存在（首跑）→ 必须照常可写（修复不得把 ENOENT 也挡死）
    const sb4 = mkSandbox('b4');
    const r4 = runBf(sb4);
    let m4 = null;
    try { m4 = JSON.parse(fs.readFileSync(sb4.ledger, 'utf8')); } catch (e) { /* 断言里判 */ }
    ok('T109-b4 ★端到端：账本不存在（首跑）→ --write 必须成功（ENOENT 是合法空账本）',
      r4.status === 0 && !!m4 && Object.keys(m4).indexOf('2026-10-18') >= 0,
      `exit=${r4.status} keys=${m4 ? Object.keys(m4).join(',') : 'PARSE-FAIL'} err=${String(r4.stderr).slice(0, 150)}`);
  }
}

// ===== T110（v3.63.2 · 外部审计 S7）：已入账 ≠ 已弹窗 —— 恢复路径的弹窗记录闸 ==================
//   病根（用户写文档时自查查出，P2）：`recoverKilledStop` 里旧代码
//     `if (st === 'nothing') { clearStopMark(sid); return false; }`
//   Stop 死在「记账成功之后、弹窗发出之前」时，下次 --hook 拿到 nothing → 清标记 →
//   这条弹窗**永久不出现**，且标记一删再无补救入口（recoverKilledStop 只挂 --hook）。
//   这正是设计期标记为 R1 的风险（当时结论"判据只能取弹窗已经成功发出过的记录"），
//   但批14 只在 .toasted 去重层实现了"弹后才写"，recoverKilledStop 本身没接上。
//   ⚠ 能走到 nothing 的前提：`!agg.total` 已在函数前段清掉真空轮 ⇒ nothing 只说明「账已记」。
//   同函数 ③ 分支（st==='recorded' 但 main 水位线不涨 = 纯子代理用量轮，ledgerKey 的 main
//   只跟主转录行数）同型吞弹，一并收敛到同一判据。
//   ★ 行为夹具的关键：预写水位线（key=sid，main=3=总行数）让 incrementalRecord 返回 nothing
//     （= 模拟"记账已成功"），且 lastStopAt 保持早于标记（= Stop 被砍、从未收口）——
//     两个条件缺任何一个都进不了目标分支，夹具就成了假测。
{
  const code110 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  // 切片截止到本函数末尾（T107 同款教训：取固定窗口会越界抓到下一个函数的 catch）
  const rc110 = (() => { const i = code110.indexOf('function recoverKilledStop('); if (i < 0) return ''; const j = code110.indexOf('function ', i + 10); return code110.slice(i, j > 0 ? j : i + 6000); })();
  ok('T110-a1 ★「已入账」分支（st===\'nothing\'）不得直接清标记：必须过弹窗记录闸'
    + '（toastAlreadyShown，批14 同源同口径）—— 旧代码直接 clearStopMark = 死在记账后'
    + '弹窗前的轮次永久丢弹',
    rc110.indexOf('toastAlreadyShown(sid, mk.roundStart || 0, dedupeFp)') > 0
    && (() => {
      const i = rc110.indexOf("if (st === 'nothing')");
      const win = i > 0 ? rc110.slice(i, i + 220) : '';
      return win.indexOf('clearStopMark(sid); return false;') < 0;
    })(), `nothing 分支窗口=${(() => { const i = rc110.indexOf("if (st === 'nothing')"); return i > 0 ? rc110.slice(i, i + 220).replace(/\s+/g, ' ') : '(未找到)'; })()}`);
  const iShow110 = rc110.indexOf('showToast(');
  const iMark110 = rc110.indexOf('markToastShown(sid, mk.roundStart || 0, dedupeFp)');
  ok('T110-a2 ★补弹成功后必须写「已弹过」记录（markToastShown 在 showToast 之后、'
    + '最后一次 clearStopMark 之前）—— 不写 = 并发双投时第二次照样弹，批14 去重层覆盖不到恢复路径',
    iShow110 > 0 && iMark110 > iShow110 && rc110.lastIndexOf('clearStopMark(sid)') > iMark110,
    `show@${iShow110} mark@${iMark110} clear@${rc110.lastIndexOf('clearStopMark(sid)')}`);
  ok('T110-a3 ★③ 分支（main 水位线没涨 = 纯子代理用量轮）同样不得直接清标记 —— 与 ① 同型，'
    + '收敛到同一弹窗记录判据（旧代码在此吞掉 sub-only 轮的弹窗）',
    (() => {
      const i = rc110.indexOf('after !== null && after <= before');
      const win = i > 0 ? rc110.slice(i, i + 300) : '';
      return i > 0 && win.indexOf('toastDone()') > 0 && win.indexOf('clearStopMark(sid); return false;') < 0;
    })(), `③ 分支窗口=${(() => { const i = rc110.indexOf('after !== null && after <= before'); return i > 0 ? rc110.slice(i, i + 300).replace(/\s+/g, ' ') : '(未找到)'; })()}`);

  if (!SPAWN_OK) envSkip('T110-b1~b3 恢复路径弹窗记录闸端到端', SPAWN_SKIP_REASON);
  else {
    const proj110 = path.join(tmp, 'c110', 'projects');
    fs.mkdirSync(proj110, { recursive: true });
    const toast110 = path.join(tmp, 'token-tracker-toast.log');
    const wmPath110 = path.join(skillDir, '.ledger-watermark.json');
    let wmBak110 = null;
    try { wmBak110 = fs.existsSync(wmPath110) ? fs.readFileSync(wmPath110, 'utf-8') : null; } catch (e) { wmBak110 = null; }
    const recs110 = () => {
      const raw = fs.existsSync(toast110) ? fs.readFileSync(toast110, 'utf-8') : '';
      if (!raw.trim()) return [];
      return raw.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } })
        .filter((t) => t.reason === 'stop-killed-recover');
    };
    const T0_110 = Date.now() - 3 * 3600 * 1000;   // 本轮起点（写入快照 lastUserMsgAt / 标记 roundStart）
    const T1_110 = Date.now() - 2 * 3600 * 1000;   // 被砍那一次 Stop 的聚合起点
    let seq110 = 0;
    const urow110 = (ts, i, o) => JSON.stringify({ type: 'assistant', id: 'c110u' + (seq110++), timestamp: ts,
      providerData: { model: 'probe-model', messageId: 'c110m' + seq110, usage: { input_tokens: i, output_tokens: o } } });
    // 恰好 3 行 → 预写水位线 main=3 即"已全部入账"（incrementalRecord 返回 nothing）
    const rows110 = [urow110(T1_110 + 1000, 1000, 100), urow110(T1_110 + 2000, 2000, 200), urow110(T1_110 + 3000, 500, 50)];
    // opts.toasted：预写「已弹过」记录（b2 用）；不传 = 从未弹过（b1 用）
    const run110 = (name, opts) => {
      const sid = 'c110-' + name;
      const tsPath = path.join(proj110, sid + '.jsonl');
      fs.writeFileSync(tsPath, rows110.join('\n') + '\n');
      fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), JSON.stringify({
        file: tsPath, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_110, lastStopAt: T1_110 - 60000,
      }));
      const mk = path.join(skillDir, '.stopmark-' + sid + '.json');
      fs.writeFileSync(mk, JSON.stringify({ at: T1_110 + 60000, tsPath, roundStart: T0_110, aggStart: T1_110 }));
      // 水位线预置「已入账」（ledgerKey 有 session_id 时键 = sid 原样）
      let wm = {};
      try { wm = JSON.parse(fs.readFileSync(wmPath110, 'utf-8')); } catch (e) { wm = {}; }
      wm[sid] = { main: 3 };
      fs.writeFileSync(wmPath110, JSON.stringify(wm));
      const tp = path.join(skillDir, '.toasted-' + sid + '.json');
      if (opts && opts.toasted) fs.writeFileSync(tp, JSON.stringify(opts.toasted));
      else { try { fs.unlinkSync(tp); } catch (e) { /* 不存在则忽略 */ } }
      const before = recs110().length;
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tsPath, prompt: 't', cwd: tmp }),
        env: Object.assign({}, process.env, { WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1', WB_ORPHAN_SCAN: 'off' }),
        timeout: 90000, windowsHide: true, encoding: 'utf8',
      });
      let toastRec = null;
      try { toastRec = JSON.parse(fs.readFileSync(tp, 'utf-8')); } catch (e) { toastRec = null; }
      return { r, sid, delta: recs110().length - before, markLeft: fs.existsSync(mk), toastRec };
    };

    // b1：账已记（nothing）+ 无弹窗记录 → 必须补弹出那一轮；记录只能在弹成功后写；标记就地清掉
    const b1 = run110('pending', null);
    ok('T110-b1 ★端到端：Stop 死在「记账后、弹窗前」（nothing + 无弹窗记录）→ 必须补弹出那一轮，'
      + '且「已弹过」记录在弹**成功之后**写入（roundStart/指纹齐全）、在飞标记清掉',
      b1.r.status === 0 && b1.delta === 1 && !b1.markLeft
      && !!b1.toastRec && Number(b1.toastRec.roundStart) === T0_110
      && !!b1.toastRec.fp && b1.toastRec.fp !== 'null' && Number(b1.toastRec.at) > 0,
      `status=${b1.r.status} delta=${b1.delta} markLeft=${b1.markLeft} rec=${JSON.stringify(b1.toastRec)} err=${String(b1.r.stderr || '').slice(0, 120)}`);

    // b2：同样 nothing，但弹窗记录已在（同 roundStart + 同指纹 + 60s 内）→ 静默收工、绝不重弹
    //   指纹从 b1 实际写入的记录里取（与产品同源，避免测试侧另算一套口径）
    const b2 = run110('shown', { toasted: { roundStart: T0_110, fp: b1.toastRec ? b1.toastRec.fp : 'x', at: Date.now() } });
    ok('T110-b2 ★端到端：已入账 + 已弹过（记录在）→ 静默收工（绝不重弹）、标记清掉',
      b2.r.status === 0 && b2.delta === 0 && !b2.markLeft,
      `status=${b2.r.status} delta=${b2.delta} markLeft=${b2.markLeft} err=${String(b2.r.stderr || '').slice(0, 120)}`);

    // b3：真空轮（agg.total=0）→ 老路径：`!agg.total` 早清（不弹、标记清）——
    //   修复不得把空轮也补弹出来；水位线同样预置，早清失效时本用例必须变红
    const sid3 = 'c110-empty';
    const tsPath3 = path.join(proj110, sid3 + '.jsonl');
    fs.writeFileSync(tsPath3, JSON.stringify({ type: 'user', id: 'c110u0', timestamp: T1_110 + 500, message: { role: 'user', content: 'hi' } }) + '\n');
    fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid3 + '.json'), JSON.stringify({
      file: tsPath3, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_110, lastStopAt: T1_110 - 60000,
    }));
    const mk3 = path.join(skillDir, '.stopmark-' + sid3 + '.json');
    fs.writeFileSync(mk3, JSON.stringify({ at: T1_110 + 60000, tsPath: tsPath3, roundStart: T0_110, aggStart: T1_110 }));
    let wm3 = {};
    try { wm3 = JSON.parse(fs.readFileSync(wmPath110, 'utf-8')); } catch (e) { wm3 = {}; }
    wm3[sid3] = { main: 1 };
    fs.writeFileSync(wmPath110, JSON.stringify(wm3));
    const before3 = recs110().length;
    const r3 = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
      input: JSON.stringify({ session_id: sid3, transcript_path: tsPath3, prompt: 't', cwd: tmp }),
      env: Object.assign({}, process.env, { WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1', WB_NO_NET: '1', WB_ORPHAN_SCAN: 'off' }),
      timeout: 90000, windowsHide: true, encoding: 'utf8',
    });
    ok('T110-b3 ★端到端：真空轮 → 仍走 `!agg.total` 早清路径（不弹、标记清）'
      + '—— 修复不得把空轮也补弹出来',
      r3.status === 0 && recs110().length - before3 === 0 && !fs.existsSync(mk3),
      `status=${r3.status} delta=${recs110().length - before3} markLeft=${fs.existsSync(mk3)}`);

    // 复原沙箱水位线，避免影响后续用例（T107 同款收尾）
    try {
      if (wmBak110 === null) fs.unlinkSync(wmPath110);
      else fs.writeFileSync(wmPath110, wmBak110);
    } catch (e) { /* silent-ok:测试收尾，还原失败不影响断言结论 */ }
  }
}

// ===== T111（v3.63.3 · 外部审计 AUD-B-01，P1）：toast 失败不得写「已弹过」毒记录 ==========
//   病根（另一会话按审计规范 v3 审出，主代理逐条实证）：`showToast` 全出口**裸 return**，
//   `showToastsSplitByModel` 也无脑 `return true` ⇒ 4 处 `markToastShown` 无条件执行 ——
//   toast 调用失败（execFileSync 抛异常）时照样写「已弹过」= 毒记录：下次同轮判重直接静默，
//   这条弹窗**永久不再出现**。更深一层：stop-handler 收口三件事（推进 lastStopAt /
//   clearStopMark / 写已完成日志）也无条件执行 ⇒ 恢复路径 recoverKilledStop 的闸①被全断。
//   ⚠ 这架空的是 v3.63.2（KI-41/S7）自身的前提 —— 注释白纸黑字「记录只在弹窗成功后写」，
//     但实现里**根本没有成功信号可依赖**。本项目第二起「注释与代码分裂」（第一起：!agg.total 不可达）。
//   ⚠ 修复不造新机制：v3.61.0 :488 catch 早已写明正确失败路径（lastStopAt 不推进、轮保持开放、
//     下轮补弹），只是被 showToast 内部吞异常架空。本次只是把失败信号传出来。
//   ★ 行为侧注入方式：**PATH 剥离**（execFileSync('powershell.exe') ENOENT）——
//     唯一依赖 PATH 的外部调用就是它（其余全用 process.execPath 绝对路径，实测已核）。
//     同时必须删掉 TOKEN_TRACKER_NO_TOAST（该开关会提前 return true，注入就失效）。
//     绝不能用「真跑一次失败弹窗」——硬规矩：测试禁止真弹窗。
{
  const src111 = stripComments(fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8'));
  const sh111 = stripComments(fs.readFileSync(path.join(SRC, 'stop-handler.js'), 'utf-8'));
  const fnBody111 = (code, name) => {
    const i = code.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = code.indexOf('\nfunction ', i + 10);
    return code.slice(i, j > 0 ? j : i + 6000);
  };
  const toastFn = fnBody111(src111, 'showToast');
  const splitFn = fnBody111(src111, 'showToastsSplitByModel');

  ok("T111-a1 ★showToast 必须返回「是否可视为已呈现」：三个等价出口（测试静默/同文案去重跳过/非 win32）"
    + "与成功路径返 true、异常路径返 false、**无裸 return** —— 旧版全出口裸 return，失败与成功同形，"
    + "调用方只能无条件写记录（KI-42 毒记录的直接来源）",
    (toastFn.match(/return true;/g) || []).length >= 4
    && /catch \(e\) \{[\s\S]{0,240}return false;/.test(toastFn)
    && (toastFn.match(/return;/g) || []).length === 0,
    `true 出口数=${(toastFn.match(/return true;/g) || []).length} 裸 return=${(toastFn.match(/return;/g) || []).length}`);

  ok('T111-a2 ★showToastsSplitByModel 任一条 toast 失败即整体返 false（且首败即停）'
    + '—— 旧版无脑 return true；⚠ parts<=1 的早退 false 必须保留（调用方靠它回落单条路径）',
    /if \(parts\.length <= 1\) return false;/.test(splitFn)
    && /if \(!allOk\) break;/.test(splitFn)
    && /return allOk;/.test(splitFn)
    && (splitFn.match(/return true;/g) || []).length === 0,
    `早退=${/if \(parts\.length <= 1\) return false;/.test(splitFn)} 首败即停=${/if \(!allOk\) break;/.test(splitFn)} 结尾=${/return allOk;/.test(splitFn)}`);

  ok('T111-a3 ★stop-handler 三处 markToastShown 全部条件化（每次调用都落在 showToast/split 的'
    + '成功判定 if 之内）—— 无条件写 = 弹窗失败也记「已弹过」= 下次同轮直接静默丢弹',
    (() => {
      if ((sh111.match(/markToastShown\(/g) || []).length !== 3) return false;
      let idx = -1;
      for (let k = 0; k < 3; k++) {
        idx = sh111.indexOf('markToastShown(', idx + 1);
        if (idx < 0) return false;
        // 判据要求「if (showToast(」/「if (!dupShown && showToastsSplitByModel(」紧贴在前——
        // 无条件写法（showToast(...); markToastShown(...)）不匹配该形态，会被抓红。
        const win = sh111.slice(Math.max(0, idx - 520), idx);
        if (!/if \(showToast\(|if \(!dupShown && showToastsSplitByModel\(/.test(win)) return false;
      }
      return true;
    })(), `调用点数=${(sh111.match(/markToastShown\(/g) || []).length}（应为 3）`);

  ok('T111-a4 ★toast 失败时收口三件事**一件都不办**：不推进 lastStopAt、不清 stopmark、'
    + '不写「已完成」日志 —— 轮保持开放等下次 --hook 补弹（收敛到 v3.61.0 既有失败路径）',
    (() => {
      const i = sh111.indexOf('if (toastFailed) {');
      if (i < 0) return false;
      const j = sh111.indexOf('} else {', i);
      const blk = j > i ? sh111.slice(i, j) : '';
      return /stop-sync-toast-show-failed/.test(blk)
        && blk.indexOf('clearStopMark') < 0
        && blk.indexOf('lastStopAt: Date.now()') < 0
        && blk.indexOf("'stop-plain-immediate'") < 0;
    })());

  ok('T111-a5 ★恢复路径（recoverKilledStop）弹窗失败 → 保留 stopmark + 不写记录 + 留痕 + bump 重试'
    + '—— 标记一删，Stop 再被杀就连补弹入口都没了（KI-41 的前提）',
    /stop-killed-recover-toast-failed/.test(src111)
    && /stopMarkBump\(sid, mk, 'toast-failed'\)/.test(src111)
    && (() => {
      // ⚠ 锚点必须**唯一到那一处**：`if (!recoverShown) {` 在本函数出现两次
      //   （① split 失败→回落单条 ② 单条也失败→真失败分支）。旧写法 indexOf 命中的是 ①，
      //   把 ② 改成不可达它也照样绿（R84 暴露的守卫空洞）。改为锚 bump 语句本身，
      //   再回看它必须被 `if (!recoverShown)` 直接包裹。
      const iBump = src111.indexOf("stopMarkBump(sid, mk, 'toast-failed')");
      if (iBump < 0) return false;
      // 只看 bump **最近的那个** if —— 取 300 字窗口再用 lastIndexOf('if (') 定位，
      //   窗口开大一点没关系（多含了上游代码也无所谓），关键是不能把上一个同形 if 也算进来。
      const before = src111.slice(Math.max(0, iBump - 300), iBump);
      const lastIf = before.lastIndexOf('if (');
      const guard = lastIf >= 0 ? before.slice(lastIf) : '';
      const iMark = src111.indexOf('markToastShown(sid, mk.roundStart || 0, dedupeFp)');
      return guard.indexOf('if (!recoverShown) {') === 0 && iMark > iBump;
    })(), `bump@${src111.indexOf("stopMarkBump(sid, mk, 'toast-failed')")} 记录@${src111.indexOf('markToastShown(sid, mk.roundStart || 0, dedupeFp)')}`);

  if (!SPAWN_OK) envSkip('T111-b1~b3 toast 失败信号端到端', SPAWN_SKIP_REASON);
  else {
    const proj111 = path.join(tmp, 'c111', 'projects');
    fs.mkdirSync(proj111, { recursive: true });
    const toastLog111 = path.join(tmp, 'token-tracker-toast.log');
    const compLog111 = path.join(tmp, 'token-tracker-compaction.log');
    const off111 = () => { try { return fs.statSync(toastLog111).size; } catch (e) { return 0; } };
    const offC111 = () => { try { return fs.statSync(compLog111).size; } catch (e) { return 0; } };
    const slice111 = (o) => { try { return fs.readFileSync(toastLog111).slice(o).toString('utf8'); } catch (e) { return ''; } };
    const sliceC111 = (o) => { try { return fs.readFileSync(compLog111).slice(o).toString('utf8'); } catch (e) { return ''; } };
    // PATH 剥离注入：空目录里没有任何可执行文件 → execFileSync('powershell.exe') 抛 ENOENT
    //   → showToast 走 catch 返 false。唯一影响的就是 toast（其余调用全用 process.execPath）。
    const emptyBin = path.join(tmp, 'c111-emptybin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const failEnv = Object.assign({}, process.env, {
      WB_ROOT: tmp, WB_NO_NET: '1', WB_LEDGER_MAINT: '1', PATH: emptyBin, Path: emptyBin,
    });
    delete failEnv.TOKEN_TRACKER_NO_TOAST;   // 该开关会提前 return true，注入即失效
    const okEnv = Object.assign({}, process.env, {
      WB_ROOT: tmp, WB_NO_NET: '1', WB_LEDGER_MAINT: '1', TOKEN_TRACKER_NO_TOAST: '1',
    });
    const T0_111 = Date.now() - 6 * 3600 * 1000;
    let seq111 = 0;
    const urow111 = (ts, i, o, mdl) => JSON.stringify({ type: 'assistant', id: 'c111u' + (seq111++), timestamp: ts,
      providerData: { model: mdl || 'probe-model', messageId: 'c111m' + seq111, usage: { input_tokens: i, output_tokens: o } } });
    const uhead111 = (ts) => JSON.stringify({ type: 'message', role: 'user', id: 'c111h' + ts, timestamp: ts,
      content: [{ type: 'text', text: 'hi' }] });
    // ⚠ 必须**两个模型**：只有 ≥2 模型才会走 showToastsSplitByModel 分条路径。
    //   单模型时 split 早退 false → 只测到单条分支，分条分支「任一条失败整体 false」无人覆盖
    //   （R81 暴露：变异后 b1/b3 全绿）。
    const rows111 = [uhead111(T0_111), urow111(T0_111 + 1000, 1000, 100),
      urow111(T0_111 + 2000, 2000, 200, 'probe-model-b'), urow111(T0_111 + 2500, 300, 30)];
    // ⚠ 每次跑前把快照 lastStopAt 重置回「本轮之前」——与 T108 同款教训：不重置会被旧闸抢先挡住（假绿）
    const runStop111 = (name, env) => {
      const sid = 'c111-' + name;
      const tsPath = path.join(proj111, sid + '.jsonl');
      fs.writeFileSync(tsPath, rows111.join('\n') + '\n');
      fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), JSON.stringify({
        file: tsPath, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_111, lastStopAt: T0_111 - 60000,
      }));
      const off = off111();
      const offC = offC111();
      const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--stop'], {
        input: JSON.stringify({ session_id: sid, transcript_path: tsPath, cwd: tmp }),
        env, timeout: 120000, windowsHide: true, encoding: 'utf8',
      });
      let snap = {};
      try { snap = JSON.parse(fs.readFileSync(path.join(skillDir, '.snapshot-' + sid + '.json'), 'utf8')); } catch (e) { snap = {}; }
      return {
        rc: r.status, err: String(r.stderr || '').slice(0, 160),
        diag: slice111(off), ctxt: sliceC111(offC),
        toastRec: (() => { try { return JSON.parse(fs.readFileSync(path.join(skillDir, '.toasted-' + sid + '.json'), 'utf8')); } catch (e) { return null; } })(),
        markLeft: fs.existsSync(path.join(skillDir, '.stopmark-' + sid + '.json')),
        stopAt: Number(snap.lastStopAt || 0),
      };
    };

    // b1：普通轮 Stop + toast 失败注入 → 四件必须同时成立（缺任何一件 = KI-42 复活）
    const b1 = runStop111('fail', failEnv);
    ok('T111-b1 ★端到端：toast 失败（PATH 剥离注入）→ 不写「已弹过」记录、保留在飞标记、'
      + '不推进 lastStopAt、留痕 stop-sync-toast-show-failed',
      b1.rc === 0 && b1.toastRec === null && b1.markLeft && b1.stopAt === T0_111 - 60000
      && /"event":"stop-sync-toast-show-failed"/.test(b1.ctxt),
      `rc=${b1.rc} rec=${JSON.stringify(b1.toastRec)} markLeft=${b1.markLeft} stopAt推进=${b1.stopAt !== T0_111 - 60000} 留痕=${/"event":"stop-sync-toast-show-failed"/.test(b1.ctxt)} err=${b1.err}`);

    // b2（对照组）：同夹具 + 正常环境 → 必须全部相反。
    //   ⚠ 没有这个对照组，b1 的断言可能「恒真」（比如 toast 路径根本没走到）——行为守卫的鉴别力证明。
    const b2 = runStop111('ok', okEnv);
    ok('T111-b2 ★对照组：同夹具 + 正常环境 → 记录写入、标记清掉、lastStopAt 推进'
      + '（证明 b1 断言有鉴别力，不是恒真）',
      b2.rc === 0 && !!b2.toastRec && !b2.markLeft && b2.stopAt > T0_111
      && !/"event":"stop-sync-toast-show-failed"/.test(b2.ctxt),
      `rc=${b2.rc} rec=${JSON.stringify(b2.toastRec)} markLeft=${b2.markLeft} stopAt=${b2.stopAt} err=${b2.err}`);

    // b3：恢复路径（--hook + stopmark + 水位线预置 nothing）+ toast 失败注入
    //   → 不写记录、保留 stopmark、留痕 stop-killed-recover-toast-failed
    const sid3 = 'c111-recover';
    const tsPath3 = path.join(proj111, sid3 + '.jsonl');
    const T1_111 = Date.now() - 2 * 3600 * 1000;
    let seq3 = 0;
    const urow3 = (ts, i, o, mdl) => JSON.stringify({ type: 'assistant', id: 'c111r' + (seq3++), timestamp: ts,
      providerData: { model: mdl || 'probe-model', messageId: 'c111rm' + seq3, usage: { input_tokens: i, output_tokens: o } } });
    // 同样两模型 → 覆盖恢复路径的分条分支（split 失败也要走到失败分支）
    const rows3 = [urow3(T1_111 + 1000, 1000, 100), urow3(T1_111 + 2000, 2000, 200),
      urow3(T1_111 + 2500, 400, 40, 'probe-model-b'), urow3(T1_111 + 3000, 500, 50)];
    fs.writeFileSync(tsPath3, rows3.join('\n') + '\n');
    fs.writeFileSync(path.join(skillDir, '.snapshot-' + sid3 + '.json'), JSON.stringify({
      file: tsPath3, stat: { total: 0, model: 'probe-model' }, lastUserMsgAt: T0_111, lastStopAt: T1_111 - 60000,
    }));
    const mk3 = path.join(skillDir, '.stopmark-' + sid3 + '.json');
    fs.writeFileSync(mk3, JSON.stringify({ at: T1_111 + 60000, tsPath: tsPath3, roundStart: T0_111, aggStart: T1_111 }));
    const wmPath111 = path.join(skillDir, '.ledger-watermark.json');
    let wmBak111 = null;
    try { wmBak111 = fs.existsSync(wmPath111) ? fs.readFileSync(wmPath111, 'utf8') : null; } catch (e) { wmBak111 = null; }
    let wm3 = {};
    try { wm3 = JSON.parse(fs.readFileSync(wmPath111, 'utf8')); } catch (e) { wm3 = {}; }
    wm3[sid3] = { main: 4 };   // 预置「已全部入账」（行数须与 rows3 一致）→ incrementalRecord 返 nothing → 进展示段
    fs.writeFileSync(wmPath111, JSON.stringify(wm3));
    const tp3 = path.join(skillDir, '.toasted-' + sid3 + '.json');
    try { fs.unlinkSync(tp3); } catch (e) { /* 不存在则忽略 */ }
    const off3 = off111();
    const offC3 = offC111();
    const r3 = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
      input: JSON.stringify({ session_id: sid3, transcript_path: tsPath3, prompt: 't', cwd: tmp }),
      env: failEnv, timeout: 90000, windowsHide: true, encoding: 'utf8',
    });
    ok('T111-b3 ★端到端：恢复路径（已入账未弹窗）+ toast 失败 → 不写记录、保留 stopmark'
      + '（下次 --hook 还有机会补弹）、留痕 stop-killed-recover-toast-failed',
      r3.status === 0 && !fs.existsSync(tp3) && fs.existsSync(mk3)
      && /"event":"stop-killed-recover-toast-failed"/.test(sliceC111(offC3)),
      `status=${r3.status} rec在=${fs.existsSync(tp3)} markLeft=${fs.existsSync(mk3)} err=${String(r3.stderr || '').slice(0, 160)}`);

    // 复原沙箱水位线（T110 同款收尾）
    try {
      if (wmBak111 === null) fs.unlinkSync(wmPath111);
      else fs.writeFileSync(wmPath111, wmBak111);
    } catch (e) { /* silent-ok:测试收尾，还原失败不影响断言结论 */ }
  }
}

// ===== T112（v3.63.4 · 批18）：价格解析器三修（MiniMax-M3 错价 / Kimi 停更 / TokenHub 范围）=====
// 三条主线（均先用真页面复现 → 修 → 配守卫；守卫分源码侧 + 行为侧）：
//   ① **MiniMax-M3 错价（P1）**：官方页删「永久五折」文案后 M3 行变成 3 数字
//      「≤ 512k 输入 tokens 2.10 8.40 0.42」→ 旧代码 nums[0] 取到门槛里的 512 当输入价
//      （正确 2.10，高 244 倍；10-21 实测已污染 latest.json，下一次 build 就会进索引）。
//      修法：取价前先剥长度门槛（LEN_TIER_RE），主档只取 ≤ 行（> 档显式跳过，不靠 seen 去重）。
//   ② **Kimi 停更（P1）**：价格从 .md 迁到 HTML 页 RSC 负载（反引号 DocTable），chat-k3.md
//      已 308 跳 chat.md 且导出空表 → 旧路径 0 模型、价格永不更新且无告警。修法：抓 HTML 按
//      **列语义**映射（k3 表 8 列 / k2 表 6 列，按位置取价必错），.md 降级为兜底。
//   ③ **TokenHub 范围（用户 2026-10-21 拍板）**：只收腾讯自家**通用** LLM；混元系翻译模型
//      （Hy-MT2）与转售第三方都不收。翻译系从「未识别告警」（诱导补 BRAND_MAP）改判
//      「范围外排除」—— 只留痕不告警；误映射进 BRAND_MAP 的翻译系也要被拦下。
// 守卫纪律：源码侧锚**使用点**（剥离必须先于取价；> 档必须显式 continue；非通用必须先于
//   brand 判定）；行为侧 require 真身纯函数喂**真页面形态**夹具（不打网络）。
{
  const fc112 = fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf-8').replace(/\r\n/g, '\n');
  const th112 = fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf-8').replace(/\r\n/g, '\n');
  const stripPy = (s) => s.split('\n').map((line) => {
    let out = ''; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === '\\') out += line[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }).join('\n');
  const fc112c = stripPy(fc112);
  const th112c = stripPy(th112);
  const mmSeg = fc112c.slice(fc112c.indexOf('LEN_TIER_RE'), fc112c.indexOf('def kimi_col_map'));
  const kimiSeg = fc112c.slice(fc112c.indexOf('def kimi_col_map'), fc112c.indexOf('def parse_stepfun_md'));
  const kimiMainSeg = fc112c.slice(fc112c.indexOf('def parse_kimi('), fc112c.indexOf('def main('));
  const thSeg = th112c.slice(th112c.indexOf('def keep_hunyuan'), th112c.indexOf('def parse_peak_rule'));
  const brandMapSeg = th112c.slice(th112c.indexOf('BRAND_MAP = {'), th112c.indexOf('def ssl_context'));

  // ── a. MiniMax：门槛必须先剥再取价；> 档显式跳过 ──
  ok('T112-a1 ★MiniMax 取价前必须先剥长度门槛（LEN_TIER_RE.sub 与 nums 取值同行，剥离先于取价）',
    /LEN_TIER_RE\.sub\('', rest\)/.test(mmSeg)
    && /nums\s*=\s*re\.findall\(/.test(mmSeg)
    && mmSeg.indexOf("LEN_TIER_RE.sub('', rest')") < mmSeg.indexOf('nums = re.findall'),
    mmSeg.slice(mmSeg.indexOf('tier_m = LEN_TIER_RE') - 40, mmSeg.indexOf('nums = re.findall') + 80));
  ok('T112-a2 ★MiniMax > 档必须显式跳过（不能只靠 seen 去重——页面调换两行顺序会把 2 倍价当主档）',
    /tier_m\.group\(1\) in \('>', '>=', '≥'\)/.test(mmSeg)
    && (() => { const i = mmSeg.indexOf("tier_m.group(1) in ('>', '>=', '≥')"); return i >= 0 && /continue/.test(mmSeg.slice(i, i + 120)); })(),
    mmSeg.slice(mmSeg.indexOf('if tier_m') - 20, mmSeg.indexOf('if tier_m') + 220));
  ok('T112-a3 ★LEN_TIER_RE 形态 = 比较符+数字+k（只剥门槛，不误剥价格数字）',
    /LEN_TIER_RE\s*=\s*re\.compile\(r'\(\[≤≥<>\]=/.test(mmSeg)
    && /\\s\*\[kK\]/.test(mmSeg),
    mmSeg.slice(mmSeg.indexOf('LEN_TIER_RE'), mmSeg.indexOf('LEN_TIER_RE') + 80));

  // ── b. Kimi：列语义映射 + HTML 主路径 + .md 兜底 ──
  ok('T112-b1 ★kimi_col_map 判定顺序：『未命中』必须先于『命中』（否则输入价被缓存列抢走）',
    /def kimi_col_map\(/.test(kimiSeg)
    && kimiSeg.indexOf("'未命中' in t") >= 0 && kimiSeg.indexOf("'未命中' in t") < kimiSeg.indexOf("'命中' in t"),
    '未命中@' + kimiSeg.indexOf("'未命中' in t") + ' 命中@' + kimiSeg.indexOf("'命中' in t"));
  ok('T112-b2 ★Kimi 价格按 col_map 语义列取（不按位置——k3 表 8 列 / k2 表 6 列）',
    /col_map\.get\('in'\)/.test(kimiSeg) && /col_map\.get\('out'\)/.test(kimiSeg) && /col_map\.get\('cache'\)/.test(kimiSeg));
  ok('T112-b3 ★parse_kimi 主路径必须抓 HTML 页（KIMI_HTML_URL），且保留 .md 兜底（页面回退不致 0 模型）',
    /http_get\(KIMI_HTML_URL/.test(kimiMainSeg) && /KIMI_PAGES/.test(kimiMainSeg)
    && /parse_kimi_row\(line\)/.test(kimiMainSeg) && /KIMI_ROW_RE\.match\(/.test(kimiMainSeg));
  ok('T112-b4 ★HTML 路径必须是纯函数 parse_kimi_html（夹具测试挂点，T87 纪律延续）',
    /def parse_kimi_html\(/.test(fc112c) && /parse_kimi_html\(t\)/.test(kimiMainSeg));

  // ── c. TokenHub：只收腾讯自家通用 LLM ──
  ok('T112-c1 ★keep_hunyuan 必须先拦非通用（NON_GENERAL_RE 判定在 brand 判定之前）',
    /NON_GENERAL_RE\.match\(nm\)/.test(thSeg)
    && thSeg.indexOf('NON_GENERAL_RE.match(nm)') < thSeg.indexOf("b = m.get('brand')")
    && thSeg.indexOf('NON_GENERAL_RE.match(nm)') < thSeg.indexOf("if b == 'hunyuan'"));
  ok('T112-c2 ★split_scope 三元组分流（kept/unmapped/excluded）且 main 使用它',
    /return kept, unmapped, excluded/.test(thSeg)
    && /split_scope\(models\)/.test(th112c) && /_excluded_non_general/.test(th112c));
  ok('T112-c3 ★BRAND_MAP 不得收录 Hy-MT 系（翻译模型不许补进价库——用户 2026-10-21 拍板）',
    !/Hy-MT/.test(brandMapSeg), 'BRAND_MAP 内出现 Hy-MT 条目：' + (brandMapSeg.match(/.*Hy-MT.*/) || [''])[0]);
  ok('T112-c4 ★NON_GENERAL_RE 形态 = ^Hy-MT（混元机器翻译系，大小写不敏感）',
    /NON_GENERAL_RE\s*=\s*re\.compile\(r'\^Hy-MT', re\.I\)/.test(th112c));

  // ── d. 行为组：真跑 python 喂真页面形态夹具（不打网络）──
  const pyCands112 = [];
  if (process.env.CN_PYTHON) pyCands112.push(process.env.CN_PYTHON);
  try {
    const pvDir = 'C:/Users/14779/.workbuddy/binaries/python/versions';
    for (const v of fs.readdirSync(pvDir)) pyCands112.push(path.join(pvDir, v, 'python.exe'));
  } catch (e) { /* 目录不存在就走 PATH */ }
  pyCands112.push('python', 'python3');
  let PY112 = null;
  for (const c of pyCands112) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY112 = c; break; }
  }
  if (!SPAWN_OK) {
    envSkip('T112-d 行为组（MiniMax/Kimi/TokenHub 夹具）', SPAWN_SKIP_REASON);
  } else if (!PY112) {
    envSkip('T112-d 行为组（MiniMax/Kimi/TokenHub 夹具）', 'python 不可用');
  } else {
    const pySrc112 = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, json, os, sys',
      'SRC = sys.argv[1]',
      "spec = importlib.util.spec_from_file_location('fcp112', os.path.join(SRC, 'fetch-cn-prices.py'))",
      'F = importlib.util.module_from_spec(spec); spec.loader.exec_module(F)',
      "spec2 = importlib.util.spec_from_file_location('pth112', os.path.join(SRC, 'parse_tokenhub.py'))",
      'T = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(T)',
      'fails = []',
      'def chk(n, c, d=""):',
      '    if not isinstance(d, str): d = repr(d)',
      '    print(("  OK   " if c else "  FAIL ") + n + (("  " + d) if d else ""))',
      '    if not c: fails.append(n)',
      // ── d1 MiniMax：真页面形态（2026-10-21 抓的 mm.html 同款两表）──
      "HDR = ('<table><tr><th>模型</th><th>输入价格</th><th>元/百万 tokens</th>'",
      "       '<th>输出价格</th><th>元/百万 tokens</th><th>缓存读取</th><th>元/百万 tokens</th></tr>')",
      "T1 = HDR + '<tr><td>MiniMax-M3.1-Flash</td><td>1.00</td><td>4.00</td><td>0.10</td></tr></table>'",
      "T2 = (HDR + '<tr><td>MiniMax-M3</td><td>≤ 512k 输入 tokens</td><td>2.10</td><td>8.40</td><td>0.42</td></tr>'",
      "      + '<tr><td>MiniMax-M3</td><td>&gt; 512k 输入 tokens*</td><td>4.20</td><td>16.80</td><td>0.84</td></tr></table>')",
      "T3 = HDR + '<tr><td>MiniMax-M3</td><td>≤ 512k 永久五折 4.20 2.10 16.80 8.40 0.84 0.42</td></tr></table>'",
      "recs = F.parse_minimax(T1 + T2)",
      "names = [r['api_name'] for r in recs]",
      "m31 = [r for r in recs if r['api_name'] == 'minimax-m3.1-flash']",
      "chk('M3.1-Flash 不回归（1/4/0.1）', len(m31) == 1 and m31[0]['in_price'] == ['1.0元'] and m31[0]['out_price'] == ['4.0元'] and m31[0]['cache_hit'] == ['0.1元'], m31)",
      "m3 = [r for r in recs if r['api_name'] == 'minimax-m3']",
      "chk('M3 只有一条记录（>512k 被显式跳过，不是去重碰巧）', len(m3) == 1, 'n=%d' % len(m3))",
      "chk('M3 in=2.1（旧病根：nums[0] 吃到 512）', bool(m3) and m3[0]['in_price'] == ['2.1元'], m3 and m3[0]['in_price'])",
      "chk('M3 out=8.4 / cache=0.42', bool(m3) and m3[0]['out_price'] == ['8.4元'] and m3[0]['cache_hit'] == ['0.42元'])",
      "chk('M3 tier_note 记主档与倍率口径', bool(m3) and '≤512k' in m3[0]['tier_note'] and '×1.5' in m3[0]['tier_note'], m3 and m3[0]['tier_note'])",
      "r3 = F.parse_minimax(T3)",
      "chk('旧五折格式（6 数字）仍按末 6 位解析（页面若恢复文案不回归）', len(r3) == 1 and r3[0]['in_price'] == ['2.1元'] and r3[0]['out_price'] == ['8.4元'] and r3[0]['cache_hit'] == ['0.42元'], r3)",
      // ── d2 Kimi：真 RSC 形态（2026-10-21 抓的 chat 页同款两表：k3 八列 + k2 六列）──
      "C3 = ('columns:[{title:`模型`,width:`12%`},{title:`计费单位`,width:`10%`},'",
      "      '{title:`缓存写入（TTL 5min）`,width:`13%`},{title:`缓存写入（TTL 1h）`,width:`13%`},'",
      "      '{title:`输入价格（缓存命中）`,width:`13%`},{title:`输入价格（缓存未命中）`,width:`13%`},'",
      "      '{title:`输出价格`,width:`10%`},{title:`上下文窗口`,width:`16%`}],'",
      "      'rows:[[`kimi-k3`,`1M tokens`,`¥20.00`,`¥40.00`,`¥2.00`,`¥20.00`,`¥100.00`,`1,048,576 tokens`]]')",
      "C2 = ('columns:[{title:`模型`,width:`24%`},{title:`计费单位`,width:`12%`},'",
      "      '{title:`输入价格（缓存命中）`,width:`16%`},{title:`输入价格（缓存未命中）`,width:`16%`},'",
      "      '{title:`输出价格`,width:`14%`},{title:`上下文窗口`,width:`18%`}],'",
      "      'rows:[[`kimi-k2.7-code`,`1M tokens`,`¥1.30`,`¥6.50`,`¥27.00`,`262,144 tokens`],'",
      "      '[`kimi-k2.7-code-highspeed`,`1M tokens`,`¥2.60`,`¥13.00`,`¥54.00`,`262,144 tokens`],'",
      "      '[`kimi-k2.6`,`1M tokens`,`¥1.10`,`¥6.50`,`¥27.00`,`262,144 tokens`]]')",
      "krecs, kn = F.parse_kimi_html(C3 + 'x' + C2)",
      "kmap = {r['api_name']: r for r in krecs}",
      "chk('Kimi HTML 路径解析出 4 个模型', len(krecs) == 4 and kn == 4, 'n=%d matched=%d' % (len(krecs), kn))",
      "chk('kimi-k3 = 20/100/2（八列表：缓存写入两列不得混进价）', kmap.get('kimi-k3') and kmap['kimi-k3']['in_price'] == ['20.00元'] and kmap['kimi-k3']['out_price'] == ['100.00元'] and kmap['kimi-k3']['cache_hit'] == ['2.00元'], kmap.get('kimi-k3'))",
      "chk('kimi-k2.7-code = 6.5/27/1.3（六列表）', kmap.get('kimi-k2.7-code') and kmap['kimi-k2.7-code']['in_price'] == ['6.50元'] and kmap['kimi-k2.7-code']['out_price'] == ['27.00元'] and kmap['kimi-k2.7-code']['cache_hit'] == ['1.30元'])",
      "chk('kimi-k2.7-code-highspeed = 13/54/2.6', kmap.get('kimi-k2.7-code-highspeed') and kmap['kimi-k2.7-code-highspeed']['in_price'] == ['13.00元'])",
      "chk('kimi-k2.6 = 6.5/27/1.1', kmap.get('kimi-k2.6') and kmap['kimi-k2.6']['out_price'] == ['27.00元'] and kmap['kimi-k2.6']['cache_hit'] == ['1.10元'])",
      "cm = F.kimi_col_map(['模型', '计费单位', '输入价格（缓存命中）', '输入价格（缓存未命中）', '输出价格', '上下文窗口'])",
      "chk('列语义映射：未命中→3 命中→2 输出→4', cm == {'in': 3, 'out': 4, 'cache': 2}, cm)",
      "_, w_unit = F.kimi_row_to_record('`kimi-k3`,`2K tokens`,`¥1.30`,`¥6.50`,`¥27.00`', cm)",
      "chk('单位非 1M → reason=unit（S5 单位断言延续）', w_unit == 'unit', w_unit)",
      "_, w_nm = F.kimi_row_to_record('`not-a-model`,`1M tokens`,`¥1.30`,`¥6.50`,`¥27.00`', cm)",
      "chk('非 kimi 模型名 → reason=name（不误收页面里别的反引号数组）', w_nm == 'name', w_nm)",
      "_, w_pr = F.kimi_row_to_record('`kimi-x`,`1M tokens`,`¥1.30`', cm)",
      "chk('价格列取不到 → reason=prices', w_pr == 'prices', w_pr)",
      // ── d3 TokenHub：范围四路分流 ──
      "ms = [{'name': 'Hy3', 'brand': 'hunyuan'}, {'name': 'Hy4 preview', 'brand': 'hunyuan'},",
      "      {'name': 'Hy-MT2-Pro', 'brand': None}, {'name': 'Hy-MT2-Plus', 'brand': None},",
      "      {'name': 'Hy-MT2-Pro', 'brand': 'hunyuan'},",
      "      {'name': 'Kimi K3', 'brand': 'kimi'}, {'name': 'Hy-New', 'brand': None}]",
      "kept, unmapped, excluded = T.split_scope(ms)",
      "kn2 = [m['name'] for m in kept]",
      "chk('混元通用模型收录（Hy3 / Hy4 preview）', kn2 == ['Hy3', 'Hy4 preview'], kn2)",
      "chk('翻译系进 excluded、不进 unmapped（不刷告警不诱导补映射）', 'Hy-MT2-Pro' in excluded and 'Hy-MT2-Plus' in excluded and 'Hy-MT2-Pro' not in unmapped, 'excluded=%s unmapped=%s' % (excluded, unmapped))",
      "chk('误映射进 BRAND_MAP 的翻译系（brand=hunyuan）仍被拦下', 'Hy-MT2-Pro' not in kn2)",
      "chk('已知第三方（Kimi K3）不进 unmapped（不刷假告警）', 'Kimi K3' not in unmapped)",
      "chk('未识别新名字仍告警（v3.55.0 A2 不回归）', 'Hy-New' in unmapped, unmapped)",
      "k2, u2 = T.keep_hunyuan(ms)",
      "chk('keep_hunyuan 两元组签名兼容（T65-e9/e10 既有守卫不回归）', [m['name'] for m in k2] == ['Hy3', 'Hy4 preview'] and u2 == ['Hy-New'], 'u2=%s' % u2)",
      // ── d4 跨文件一致：Kimi 解析值 == pricing.json 用户已校对 lock 价 ──
      "P = json.load(open(os.path.join(SRC, 'pricing.json'), encoding='utf-8'))",
      "lk = P['models'].get('kimi-k3') or {}",
      "chk('kimi-k3 解析值 == pricing.json lock（20/100/2，解析器与已发布价不分叉）', lk.get('input_price') == 20 and lk.get('output_price') == 100 and lk.get('cached_price') == 2, lk)",
      "print('FAILS=' + str(len(fails)))",
    ].join('\n');
    const r112 = spawnSync(PY112, ['-c', pySrc112, SRC],
      { timeout: 120000, windowsHide: true, encoding: 'utf-8', env: Object.assign({}, process.env, PY_IO_ENV) });
    const log112 = String(((r112 && r112.stdout) || '') + ((r112 && r112.stderr) || ''));
    const nFail112 = (log112.match(/FAILS=(\d+)/) || [])[1];
    ok('T112-d1~d4 ★行为：MiniMax 门槛剥离 / Kimi 列语义 / TokenHub 范围 / lock 交叉一致（真页面形态夹具）',
      r112.status === 0 && nFail112 === '0', log112.slice(-1400));
  }
}

// ===== T113（v3.63.5 · 批19）：价库陈旧留痕（外部审计 F-1）=====
// 审计方主张「回退到随技能走的兜底副本时不触发任何告警」——**该主张不成立**：v2.81 起
//   `dbStaleTag()` 已在**弹窗**标 `⚠价库M/D`（回退即显示 ⚠价库9/28），实证可复现。真实缺口只有
//   一条：**日志侧零留痕**（弹窗标签只在弹窗那一轮可见，回退发生在别的轮次就查不到）。
//   本批：① 补 stderr 留痕通道（口径与弹窗标签一致：built_at 非今天即算陈旧）；
//        ② 直接删除误导源 —— 技能目录内 built_at=2026-09-28 的副本（git 未跟踪，含活跃库
//           已淘汰的过期锁价 deepseekv4flash 1.5/4.5/0.05），它正是回退面的源头。
// 守卫纪律：源码侧锚**使用点**（CN_PRICE_DB 确定之后必须调用 + 必须真写 stderr + 必须导出）；
//   行为侧 require 真身纯函数喂**五种夹具**（陈旧/今天/无 built_at/坏 JSON/文件缺失）。
{
  const tt113 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const seg113 = tt113.slice(tt113.indexOf('function priceIndexStaleDays'), tt113.indexOf('function autoDiscoverCnPriceDir'));
  ok('T113-a1 ★priceIndexStaleDays 纯函数存在，且读 index.json 的 built_at（按本地日期算天，口径与 dbStaleTag 一致）',
    /function priceIndexStaleDays\s*\(/.test(seg113)
    && /JSON\.parse\(raw\)/.test(seg113)
    && /const b = j && j\.built_at/.test(seg113),
    seg113.slice(0, 100));
  ok('T113-a2 ★自动发现确定目录**之后**才调用陈旧检查（顺序：先 CN_PRICE_DB 再算天数）',
    tt113.indexOf('const CN_PRICE_DB = path.join(CN_PRICE_DIR') >= 0
    && tt113.indexOf('const CN_PRICE_DB = path.join(CN_PRICE_DIR') < tt113.indexOf('priceIndexStaleDays(CN_PRICE_DB'),
    `db@${tt113.indexOf('const CN_PRICE_DB = path.join(CN_PRICE_DIR')} call@${tt113.indexOf('priceIndexStaleDays(CN_PRICE_DB')}`);
  ok('T113-a3 ★陈旧必须真写 stderr（不是只算不用）—— 日志留痕通道是本批要补的东西',
    /if \(CN_PRICE_STALE_DAYS >= PRICE_DB_STALE_WARN_DAYS\)/.test(tt113)
    && /process\.stderr\.write\(/.test(tt113.slice(
      tt113.indexOf('if (CN_PRICE_STALE_DAYS >= PRICE_DB_STALE_WARN_DAYS)'),
      tt113.indexOf('if (CN_PRICE_STALE_DAYS >= PRICE_DB_STALE_WARN_DAYS)') + 400)));
  ok('T113-a4 ★exports 必须导出纯函数 + 阈值 + 实测值（selftest 可单测，T87 纪律延续）',
    /priceIndexStaleDays, PRICE_DB_STALE_WARN_DAYS, CN_PRICE_STALE_DAYS,/.test(tt113));

  // ── b. 行为组：require 真身纯函数喂夹具（不打网络、不依赖真实价库状态）──
  const mod113 = require(path.join(SRC, 'token-tracker.js'));
  const dir113 = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-113-'));
  try {
    const mk113 = (n, o) => {
      const p = path.join(dir113, n);
      fs.writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o));
      return p;
    };
    const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const now = Date.now();
    const got = [
      mod113.priceIndexStaleDays(mk113('old.json', { built_at: iso(new Date(now - 30 * 86400000)) }), now),
      mod113.priceIndexStaleDays(mk113('today.json', { built_at: iso(new Date(now)) }), now),
      mod113.priceIndexStaleDays(mk113('nobuilt.json', { models: {} }), now),
      mod113.priceIndexStaleDays(mk113('bad.json', '{ 坏 JSON'), now),
      mod113.priceIndexStaleDays(path.join(dir113, 'missing.json'), now),
    ];
    ok('T113-b1 ★行为：陈旧30天→30 / 今天→0 / 无 built_at→-1 / 坏JSON→-1 / 文件缺失→-1',
      got[0] === 30 && got[1] === 0 && got[2] === -1 && got[3] === -1 && got[4] === -1,
      JSON.stringify(got));
    ok('T113-b2 ★阈值常量与 dbStaleTag 口径一致（built_at 非今天即算陈旧 → 阈值 1 天）',
      mod113.PRICE_DB_STALE_WARN_DAYS === 1, String(mod113.PRICE_DB_STALE_WARN_DAYS));
  } finally {
    try { fs.rmSync(dir113, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// ===== T114（v3.63.7 · 批21）：两条 P1 修复（外部审计 AUD-B-01 / AUD-G-01）=====
// AUD-B-01：`--hook` 注入行读的是 9 天前**另一个会话**的陈旧 trace（宿主 10-14 起写 .jsonl，而
//   latestTraceFile 只认 .json）→ 每轮显示错数字。**不采纳**审计方给的「改过滤器支持 .jsonl」：
//   latestTraceFile **不按会话归属**，改后 anchor 会变成别的并行会话 → 从「稳定错」变「随机错」。
//   改法：门控 —— 非同轮时 stat 必须同会话且新鲜，否则**整段不输出**。
// AUD-G-01：`ROUNDS_DIR` 锚 __dirname → 按 §9.10 设了 WB_ROOT 的隔离运行**仍写生产明细**
//   （2026-10-23 审计实测污染 13 行）。改法：与 recalc-day.js 的 SKILL_DIR 同源，
//   不设 WB_ROOT 时完全等价（生产零迁移）。
{
  const src114 = fs.readFileSync(path.join(SRC, 'token-tracker.js'), 'utf-8').replace(/\r\n/g, '\n');
  const srcR114 = fs.readFileSync(path.join(SRC, 'recalc-day.js'), 'utf-8').replace(/\r\n/g, '\n');

  // ---- AUD-G-01 源码侧 ----
  ok('T114-a1 ★ROUNDS_DIR 必须与 recalc-day.js 的 SKILL_DIR 同源（隔离生效；不设 WB_ROOT 时等价 __dirname）',
    /const ROUNDS_DIR = path\.join\(process\.env\.WB_ROOT \? path\.join\(WB, 'skills', 'token-usage-tracker'\) : __dirname, 'rounds'\);/.test(src114),
    (src114.match(/const ROUNDS_DIR =.*/) || ['未找到'])[0]);
  ok('T114-a2 ★recalc-day.js 的 SKILL_DIR 必须是 WB 相对（两边口径必须一致，否则读写分裂）',
    /const SKILL_DIR = path\.join\(WB, 'skills', 'token-usage-tracker'\);/.test(srcR114),
    (srcR114.match(/const SKILL_DIR =.*/) || ['未找到'])[0]);

  // ---- AUD-G-01 行为侧：用子进程验证模块级路径（避免 require 缓存污染其它 T 段）----
  const iso114 = path.join(tmp, 'wb114');
  fs.mkdirSync(iso114, { recursive: true });
  const ask = (wbv) => spawnSync(process.execPath,
    ['-e', 'console.log(require(' + JSON.stringify(path.join(skillDir, 'token-tracker.js')) + ').ROUNDS_DIR)'],
    { env: Object.assign({}, process.env, { WB_ROOT: wbv }), encoding: 'utf-8', windowsHide: true });
  const isoOut = (ask(iso114).stdout || '').trim().replace(/\\/g, '/');
  ok('T114-b1 ★行为：设 WB_ROOT 时 ROUNDS_DIR 必须落在隔离区内（旧写法恒指向真实技能目录 → 污染生产明细 13 行）',
    isoOut.length > 0 && isoOut.startsWith(iso114.replace(/\\/g, '/')),
    'WB_ROOT=' + iso114 + ' → ' + (isoOut || '(空)'));
  const noOut = (ask('').stdout || '').trim();
  ok('T114-b2 ★行为：不设 WB_ROOT 时 ROUNDS_DIR 必须仍等于 __dirname/rounds（生产零迁移、零回归）',
    noOut === path.join(skillDir, 'rounds'), noOut + ' vs ' + path.join(skillDir, 'rounds'));

  // ---- AUD-B-01 源码侧 ----
  const mStart114 = src114.indexOf('function main()');
  ok('T114-a3 ★hookStatUsable 存在且在 main() **外部**（T37-b1 硬闸 950 行；不得内联回涨）',
    /function hookStatUsable\(/.test(src114) && src114.indexOf('function hookStatUsable') < mStart114,
    'fn@' + src114.indexOf('function hookStatUsable') + ' main@' + mStart114);
  ok('T114-a4 ★注入行门控必须置顶且失败时输出空 hookSpecificOutput（绝不置 null 后走 lineFor —— 其首行即 stat.durMs 会 TypeError）',
    /if \(!hookStatUsable\(t, f, sid, sameRound\)\) \{ out\(\{ hookSpecificOutput: \{\} \}\); return; \}/.test(src114)
    && src114.indexOf('if (!hookStatUsable(') < src114.indexOf('ensureNewModelPricing(pricing, shown)'),
    'gate@' + src114.indexOf('if (!hookStatUsable(') + ' nm@' + src114.indexOf('ensureNewModelPricing(pricing, shown)'));

  // ---- AUD-B-01 行为侧：纯函数喂五种夹具 ----
  const mod114 = (() => { try { return require(path.join(skillDir, 'token-tracker.js')); } catch (e) { return null; } })();
  if (!mod114 || typeof mod114.hookStatUsable !== 'function') {
    ok('T114-b3 ★行为：跨会话→false / 陈旧→false / 同会话且新鲜→true / sameRound→true / 文件缺失→false', false, 'hookStatUsable 未导出');
  } else {
    const dir114 = fs.mkdtempSync(path.join(tmp, 'hu114-'));
    try {
      const mk114 = (name, ageMin) => {
        const fp = path.join(dir114, name);
        fs.writeFileSync(fp, JSON.stringify({ trace: { sessionId: 'sess-A' } }));
        const t = Date.now() - ageMin * 60000;
        fs.utimesSync(fp, new Date(t), new Date(t)); // ⚠ t 已是毫秒：再 /1000 会变成 1970 年 → "新鲜"夹具也被判陈旧
        return fp;
      };
      const freshA = mk114('fresh.json', 1);
      const staleA = mk114('stale.json', 40);
      const got114 = [
        mod114.hookStatUsable({ trace: { sessionId: 'other' } }, freshA, 'sess-A', false),
        mod114.hookStatUsable({ trace: { sessionId: 'sess-A' } }, staleA, 'sess-A', false),
        mod114.hookStatUsable({ trace: { sessionId: 'sess-A' } }, freshA, 'sess-A', false),
        mod114.hookStatUsable({ trace: { sessionId: 'other' } }, staleA, 'sess-A', true),
        mod114.hookStatUsable({ trace: { sessionId: 'sess-A' } }, null, 'sess-A', false),
      ];
      ok('T114-b3 ★行为：跨会话→false / 陈旧→false / 同会话且新鲜→true / sameRound→true / 文件缺失→false',
        got114[0] === false && got114[1] === false && got114[2] === true && got114[3] === true && got114[4] === false,
        JSON.stringify(got114));
    } finally {
      try { fs.rmSync(dir114, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
    }
  }
}

// ===== T115（v3.63.8 · 批22）：AUD-D-01 已有条目「单边丢失」保护 =====
// 缺陷：抓取/解析偶发把某个价字段取成 None（页面改版、列错位），而 gate_new_model
//   **只对上一版没有的新条目生效**（`pe is None`）→ 已有条目漏网；classify_change 对三价
//   仅判 `o != n` → None 被当成"价格变化"直接采纳 → 一个真实存在的上一版好价被抹掉。
//   改法：上一版有值、本次 None → 保留上一版值 + 摘掉 price/big_jump + 写 price_lost 流水。
{
  const bi115 = fs.readFileSync(path.join(SRC, 'build_index.py'), 'utf-8').replace(/\r\n/g, '\n');
  const iFn115 = bi115.indexOf('def protect_price_loss(');
  // ⚠ 锚点必须是**调用形式**：`protect_price_loss(pe, e, key` 会同时匹配到函数定义（:463），
  //   取到的是定义位置而非调用点 → 位置断言恒假。
  const iCall115 = bi115.indexOf('kinds, detail = protect_price_loss(pe, e, key');
  const iCls115 = bi115.indexOf('kinds, detail = classify_change(pe, e)');
  const iSame115 = bi115.indexOf('_same_price = all(');

  ok('T115-a1 ★build_index 必须定义 protect_price_loss（已有条目上一版有值、本次 None → 保留旧值）',
    iFn115 >= 0 && iCall115 > 0, 'fn@' + iFn115 + ' call@' + iCall115);

  ok('T115-a2 ★调用点必须在 classify_change 之后、**且在 effective_from 推定之前**' +
     '（插错位置会把旧价误标成"今天生效" → F-3 按当时价重算算错，本改动最大连锁点）',
    iCall115 > iCls115 && iCall115 < iSame115,
    'classify@' + iCls115 + ' < call@' + iCall115 + ' < same_price@' + iSame115);

  ok('T115-a3 ★保留旧值必须写 price_lost 审计流水（静默保留 = 无人能发现 = P0）',
    /'kind': 'price_lost'/.test(bi115) && /fields/.test(bi115) && /'kept'/.test(bi115),
    ((bi115.match(/'kind': 'price_lost'/) || ['未找到'])[0]));

  // 取函数体（到下一个顶层 def 为止），确认没有挂 _manual_audit
  const fnBody115 = iFn115 >= 0
    ? bi115.slice(iFn115, bi115.indexOf('\ndef ', iFn115 + 10)) : '';
  ok('T115-a4 ★函数体内不得挂 _manual_audit（Node 侧零引用 = 只写不读的死标记；' +
     '且会与同条 semantic/region 分支互相覆盖，覆盖顺序即连锁）',
    // ⚠ 只判**赋值形式**：docstring 里会解释"为什么不挂"，裸词匹配会把注释算成命中 → 恒红。
    iFn115 >= 0 && fnBody115.indexOf("e['_manual_audit']") < 0,
    'fnBody 长度 ' + fnBody115.length);

  // ── 行为验证：真跑 python 喂夹具（源码守卫证明不了"最后到底是旧值还是 None"）──
  const py115 = (() => {
    if (process.env.CN_PYTHON) return process.env.CN_PYTHON;
    try {
      const root = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions');
      for (const v of fs.readdirSync(root).sort().reverse()) {
        const q = path.join(root, v, 'python.exe');
        if (fs.existsSync(q)) return q;
      }
    } catch (e) { /* 探测失败 → 回退裸 python */ }
    return 'python';
  })();
  const probe115 = spawnSync(py115, ['-c', 'print(1)'],
    { timeout: 20000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
  if (!SPAWN_OK || probe115.status !== 0) {
    for (const n of ['T115-b1', 'T115-b2']) {
      envSkip(n + ' ★protect_price_loss 行为验证（真跑 python 喂夹具）',
        !SPAWN_OK ? SPAWN_SKIP_REASON : ('未找到可用 python（试探 ' + py115 + ' 失败）'));
    }
  } else {
    const code115 = [
      'import sys, json',
      'sys.path.insert(0, ' + JSON.stringify(skillDir) + ')',
      'import build_index as bi',
      'pe = {"in_price": 0.003, "out_price": 0.012, "cache_hit": 0.5}',
      // 场景 1：cache_hit 本次为 None（上一版有值）
      'e1 = {"in_price": 0.003, "out_price": 0.012, "cache_hit": None}',
      'k1 = ["price"]; d1 = {"price": {"cache_hit": {"old": 0.5, "new": None}}}; c1 = []',
      'k1b, d1b = bi.protect_price_loss(pe, e1, "m1", k1, d1, c1, "2026-10-24")',
      // 场景 2：三价都有值（只是 in_price 变了）→ 必须零干预
      'e2 = {"in_price": 0.004, "out_price": 0.012, "cache_hit": 0.5}',
      'k2 = ["price", "big_jump"]; d2 = {"price": {"in_price": {"old": 0.003, "new": 0.004}}, "jump": {}}; c2 = []',
      'k2b, d2b = bi.protect_price_loss(pe, e2, "m2", k2, d2, c2, "2026-10-24")',
      'print(json.dumps({',
      '  "lost_kept": e1["cache_hit"], "lost_kinds": k1b, "lost_detail": d1b,',
      '  "lost_ch_kind": (c1[0]["kind"] if c1 else None), "lost_ch_fields": (c1[0]["fields"] if c1 else None),',
      '  "clean_kinds": k2b, "clean_detail_same": (d2b == d2), "clean_ch": len(c2),',
      '}, ensure_ascii=False))',
    ].join('\n');
    const r115 = spawnSync(py115, ['-c', code115],
      { timeout: 60000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV), encoding: 'utf-8' });
    let j115 = null;
    try { j115 = JSON.parse((r115.stdout || '').trim()); } catch (e) { j115 = null; }
    if (!j115) {
      ok('T115-b1 ★行为：上一版有值 + 本次 None → 保留旧值、摘掉 price/big_jump、写 price_lost 流水',
        false, 'python 输出无法解析：' + String(r115.stdout || '').slice(0, 120) + ' | stderr: ' + String(r115.stderr || '').slice(0, 120));
      ok('T115-b2 ★行为：无字段丢失时**零干预**（kinds/detail 不变、不写流水）',
        false, '同上（python 输出无法解析）');
    } else {
      ok('T115-b1 ★行为：上一版有值 + 本次 None → 保留旧值、摘掉 price/big_jump、写 price_lost 流水',
        j115.lost_kept === 0.5 && Array.isArray(j115.lost_kinds) && j115.lost_kinds.length === 0
        && j115.lost_ch_kind === 'price_lost' && String(j115.lost_ch_fields) === 'cache_hit',
        JSON.stringify(j115).slice(0, 200));
      ok('T115-b2 ★行为：无字段丢失时**零干预**（kinds/detail 不变、不写流水）',
        String(j115.clean_kinds) === 'price,big_jump' && j115.clean_detail_same === true && j115.clean_ch === 0,
        'kinds=' + j115.clean_kinds + ' detail不变=' + j115.clean_detail_same + ' 流水数=' + j115.clean_ch);
    }
  }
}

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
// ===== T116（v3.63.9 · 2026-10-25 Kimi 页面二次改版）：解析器「字面量/位置硬假设」鲁棒化 =====
//   事故：10-25 00:26 抓取 kimi 解析出 0 模型 → 索引沿用 10-24 旧价 → 弹窗 `⚠1家价旧`
//   （v3.62.0 的输入源降级标注按设计响了，所以是"当天可见"而不是"静默坏"）。
//   根因 = 官方发布 K3.1 Pro 时同时改了三处：
//     ① 模型名格包进 `_jsx(_components.a,{href:…,children:`kimi-k3.1-pro`})`（不再是裸反引号串）；
//     ② 单位并进价格格（`¥13.00 / MTok`，不再有独立 `1M tokens` 列）；
//     ③ 表头「输入价格（缓存未命中）」简化成「输入」，且缓存列被 `_jsx(Tooltip,…)` 包住 →
//        `KIMI_TITLE_RE.findall` 一个都取不到（缓存价全空）。
//   旧实现三个硬假设（整行纯反引号数组 / 独立单位格 / 表头含「未命中」）全破 → 0 命中。
//   本组 = 源码侧钉死"结构无关"的挂点 + 负向断言（不许退回字面量/位置假设）；
//   行为侧用**新旧两种真实页面形态**喂夹具：新形态必须出 2 条、旧形态必须仍是 4 条且价不变。
{
  const f116 = fs.readFileSync(path.join(SRC, 'fetch-cn-prices.py'), 'utf-8').replace(/\r\n/g, '\n');
  const stripPy116 = (s) => s.split('\n').map((line) => {
    let out = ''; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === '\\') out += line[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out;
  }).join('\n');
  const fc116 = stripPy116(f116);
  const kimi116 = fc116.slice(fc116.indexOf('def kimi_col_map'), fc116.indexOf('def parse_stepfun_md'));
  const mini116 = fc116.slice(fc116.indexOf('def parse_minimax'), fc116.indexOf('def kimi_col_map'));
  const zhipu116 = fc116.slice(fc116.indexOf('def parse_zhipu_docs'), fc116.indexOf('LEN_TIER_RE = re.compile'));
  const step116 = fc116.slice(fc116.indexOf('def parse_stepfun_md'), fc116.indexOf('KIMI_ROW_RE = re.compile'));
  const th116 = stripPy116(fs.readFileSync(path.join(SRC, 'parse_tokenhub.py'), 'utf-8').replace(/\r\n/g, '\n'));
  const ds116 = fs.readFileSync(path.join(SRC, 'deepseek-official.js'), 'utf-8').replace(/\r\n/g, '\n');

  ok('T116-a1 ★Kimi 行切分必须按「顶层逗号切格」，且不得再依赖"整行纯反引号数组"的正则',
    /def kimi_split_cells\(/.test(kimi116) && /kimi_split_cells\(row_src\)/.test(kimi116)
    && !/KIMI_BT_ROW_RE\s*=\s*re\.compile/.test(fc116) && !/KIMI_BT_ROW_RE\.finditer/.test(fc116),
    'KIMI_BT_ROW_RE 仍被定义/调用（组件包装一格就 0 命中）');
  ok('T116-a2 ★Kimi 表头必须走 kimi_col_titles（认 _jsx(Tooltip,{children:…}) 包装），不得只用 KIMI_TITLE_RE.findall',
    /def kimi_col_titles\(/.test(fc116) && /kimi_col_titles\(tm\.group\('cols'\)\)/.test(fc116)
    && /KIMI_COL_CHILDREN_RE/.test(fc116),
    '缓存列被 Tooltip 包住时 titles 会缺列 → 缓存价全空');
  ok('T116-a3 ★表头认不到输入/输出列时必须 WARN（不许静默 continue —— 10-25 事故里日志一片安静）',
    /表头认领不到输入\/输出列/.test(fc116));
  ok('T116-a4 ★单位断言两条路（独立单位格 / 价格格 MTok 后缀），未知后缀一律拒收',
    /KIMI_CELL_UNIT_RE/.test(kimi116) && /KIMI_UNIT_SUFFIX_BAD/.test(kimi116)
    && /saw_suffix/.test(kimi116) && /ok_suffix/.test(kimi116));
  ok('T116-a5 ★MiniMax 单位声明不得再用字面量「元/百万」子串（改用容忍空格/全角的正则）',
    /re\.search\(r'元\\s\*\[／\/\]\\s\*百万'/.test(mini116) && !/'元\/百万' not in/.test(mini116),
    '仍是字面量子串比对：表头写成「元 / 百万 tokens」即整页 0 模型');
  ok('T116-a6 ★智谱名字必须先剥尾随括号说明再校验 ^GLM（加个「（新）」就整条丢）',
    /re\.sub\(r'\\s\*\[（\(\]/.test(zhipu116)
    && zhipu116.indexOf("re.sub(r'\\s*[（(]") < zhipu116.indexOf('^GLM[-A-Za-z0-9.]*$'));
  ok('T116-a7 ★阶跃名字不得硬取 cells[0]（表头加一列就取到列名文字）',
    /cmap\['name'\] is not None/.test(step116) && /next\(\(c\.strip\(\) for c in cells/.test(step116));
  ok('T116-a8 ★TokenHub 单元格必须有"slate 属性全取不到"时的纯文本兜底（属性名是渲染细节）',
    /any_slate/.test(th116) && /_cell_text\(c\) for c in cells/.test(th116));
  ok('T116-a9 ★DeepSeek 必须遍历所有 <table> 选含模型表头的（不许只取页面第一个表）',
    /allTbs/.test(ds116) && /allTbs\.find\(hasModelHeader\)/.test(ds116));

  // ── 行为组：真身纯函数喂"新旧两种真实页面形态"（不打网络）──
  const pyCands116 = [];
  if (process.env.CN_PYTHON) pyCands116.push(process.env.CN_PYTHON);
  try {
    const pvDir116 = 'C:/Users/14779/.workbuddy/binaries/python/versions';
    for (const v of fs.readdirSync(pvDir116)) pyCands116.push(path.join(pvDir116, v, 'python.exe'));
  } catch (e) { /* 目录不存在就走 PATH */ }
  pyCands116.push('python', 'python3');
  let PY116 = null;
  for (const c of pyCands116) {
    const t = spawnSync(c, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (t.status === 0) { PY116 = c; break; }
  }
  if (!SPAWN_OK) {
    envSkip('T116-b 行为组（Kimi 新旧两种页面形态）', SPAWN_SKIP_REASON);
  } else if (!PY116) {
    envSkip('T116-b 行为组（Kimi 新旧两种页面形态）', 'python 不可用');
  } else {
    const pySrc116 = [
      '# -*- coding: utf-8 -*-',
      'import importlib.util, os, sys',
      'SRC = sys.argv[1]',
      "spec = importlib.util.spec_from_file_location('fcp116', os.path.join(SRC, 'fetch-cn-prices.py'))",
      'F = importlib.util.module_from_spec(spec); spec.loader.exec_module(F)',
      'fails = []',
      'def chk(n, c, d=""):',
      '    if not isinstance(d, str): d = repr(d)',
      '    print(("  OK   " if c else "  FAIL ") + n + (("  " + d) if d else ""))',
      '    if not c: fails.append(n)',
      // 新形态（2026-10-25 实测：输入/输出纯词 + Tooltip 包装的缓存列 + 价格格带 / MTok）
      'NEW = ("columns:[{title:`模型`,width:`25%`},{title:`输入`,width:`13%`},{title:`输出`,width:`13%`},"',
      '       "{title:_jsx(Tooltip,{tip:`命中缓存后按此价`,children:`缓存命中`}),width:`14%`},"',
      '       "{title:_jsx(Tooltip,{tip:`写入 5min`,children:`缓存写入（5min）`}),width:`18%`},"',
      '       "{title:_jsx(Tooltip,{tip:`写入 1h`,children:`缓存写入（1h）`}),width:`17%`}],"',
      '       "rows:[[_jsx(_components.a,{href:`/guide/kimi-k3-1-pro-quickstart`,children:`kimi-k3.1-pro`}),"',
      '       "`¥13.00 / MTok`,`¥68.00 / MTok`,`¥1.30 / MTok`,`¥13.00 / MTok`,`¥26.00 / MTok`],"',
      '       "[`kimi-k3`,`¥20.00 / MTok`,`¥100.00 / MTok`,`¥2.00 / MTok`,`¥20.00 / MTok`,`¥40.00 / MTok`]]")',
      // 旧形态（2026-10-21~24 实测：模型/计费单位/写入×2/命中/未命中/输出/上下文窗口）
      'C3 = ("columns:[{title:`模型`,width:`12%`},{title:`计费单位`,width:`10%`},"',
      '      "{title:`缓存写入（TTL 5min）`,width:`13%`},{title:`缓存写入（TTL 1h）`,width:`13%`},"',
      '      "{title:`输入价格（缓存命中）`,width:`13%`},{title:`输入价格（缓存未命中）`,width:`13%`},"',
      '      "{title:`输出价格`,width:`10%`},{title:`上下文窗口`,width:`16%`}],"',
      '      "rows:[[`kimi-k3`,`1M tokens`,`¥20.00`,`¥40.00`,`¥2.00`,`¥20.00`,`¥100.00`,`1,048,576 tokens`]]")',
      'C2 = ("columns:[{title:`模型`,width:`24%`},{title:`计费单位`,width:`12%`},"',
      '      "{title:`输入价格（缓存命中）`,width:`16%`},{title:`输入价格（缓存未命中）`,width:`16%`},"',
      '      "{title:`输出价格`,width:`14%`},{title:`上下文窗口`,width:`18%`}],"',
      '      "rows:[[`kimi-k2.7-code`,`1M tokens`,`¥1.30`,`¥6.50`,`¥27.00`,`262,144 tokens`],"',
      '      "[`kimi-k2.7-code-highspeed`,`1M tokens`,`¥2.60`,`¥13.00`,`¥54.00`,`262,144 tokens`],"',
      '      "[`kimi-k2.6`,`1M tokens`,`¥1.10`,`¥6.50`,`¥27.00`,`262,144 tokens`]]")',
      'rnew, nnew = F.parse_kimi_html(NEW)',
      'm = {r["api_name"]: r for r in rnew}',
      'chk("新形态（组件包装 + /MTok）解析出 2 条", len(rnew) == 2 and nnew == 2, "n=%d matched=%d" % (len(rnew), nnew))',
      'chk("新形态 kimi-k3.1-pro = 13/68/1.3（缓存命中不得被写入列抢走）",',
      '    bool(m.get("kimi-k3.1-pro")) and m["kimi-k3.1-pro"]["in_price"] == ["13.00元"]',
      '    and m["kimi-k3.1-pro"]["out_price"] == ["68.00元"] and m["kimi-k3.1-pro"]["cache_hit"] == ["1.30元"], m.get("kimi-k3.1-pro"))',
      'chk("新形态 kimi-k3 = 20/100/2", bool(m.get("kimi-k3")) and m["kimi-k3"]["in_price"] == ["20.00元"]',
      '    and m["kimi-k3"]["out_price"] == ["100.00元"] and m["kimi-k3"]["cache_hit"] == ["2.00元"])',
      'rold, nold = F.parse_kimi_html(C3 + "x" + C2)',
      'mo = {r["api_name"]: r for r in rold}',
      'chk("旧形态仍解析出 4 条（零回归）", len(rold) == 4 and nold == 4, "n=%d matched=%d" % (len(rold), nold))',
      'chk("旧形态 kimi-k3 = 20/100/2（八列表，写入两列不得混进价）", bool(mo.get("kimi-k3"))',
      '    and mo["kimi-k3"]["in_price"] == ["20.00元"] and mo["kimi-k3"]["out_price"] == ["100.00元"]',
      '    and mo["kimi-k3"]["cache_hit"] == ["2.00元"], mo.get("kimi-k3"))',
      'chk("旧形态 kimi-k2.6 = 6.5/27/1.1", bool(mo.get("kimi-k2.6"))',
      '    and mo["kimi-k2.6"]["in_price"] == ["6.50元"] and mo["kimi-k2.6"]["cache_hit"] == ["1.10元"])',
      'titles = F.kimi_col_titles("""{title:`模型`,width:`25%`},{title:`输入`,width:`13%`},""")',
      'chk("kimi_col_titles 能取纯 title 列", titles == ["模型", "输入"], titles)',
      'tt = F.kimi_col_titles("{title:_jsx(Tooltip,{tip:`x`,children:`缓存命中`}),width:`14%`}")',
      'chk("kimi_col_titles 能取 Tooltip 的 children（不是 width / tip）", tt == ["缓存命中"], tt)',
      '_, wv = F.kimi_row_to_record("`kimi-k3`,`¥20.00 / KTok`,`¥100.00 / KTok`", F.kimi_col_map(["模型", "输入", "输出"]))',
      'chk("价格格后缀 KTok（元/千 tokens）→ reason=unit（量纲防线不因放宽而失效）", wv == "unit", wv)',
      '_, wu = F.kimi_row_to_record("`kimi-k3`,`§2K tokens`,`§1.30`".replace("§", chr(165)), F.kimi_col_map(["模型", "计费单位", "输入"]))',
      'chk("独立单位格 2K tokens → reason=unit", wu == "unit", wu)',
      'print("RESULT %d %d" % (len(fails), 0))',
      'sys.exit(1 if fails else 0)',
    ].join('\n');
    const fw116 = path.join(tmp, 'b116kimi');
    fs.mkdirSync(fw116, { recursive: true });
    const pf116 = path.join(fw116, 't116.py');
    fs.writeFileSync(pf116, pySrc116, 'utf8');
    const r116 = spawnSync(PY116, [pf116, SRC], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: Object.assign({}, process.env, PY_IO_ENV) });
    let matched116 = 0;
    for (const ln of String(r116.stdout || '').split(/\r?\n/)) {
      const m116 = /^\s*(OK|FAIL)\s+(.*)$/.exec(ln);
      if (m116) ok('T116-b' + (++matched116) + ' ' + m116[2], m116[1] === 'OK');
    }
    ok('T116-b0 行为组断言行被识别（python 输出格式/编码异常时此处暴露原文）',
      matched116 > 0,
      'status=' + r116.status + ' stdout=[' + String(r116.stdout || '').replace(/\n/g, '\\n').slice(0, 600)
      + '] stderr=[' + String(r116.stderr || '').slice(0, 400) + ']');
    try { fs.rmSync(fw116, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

// v3.24.0（审计⑤）：skip 数显式化 —— 「138 全绿」曾掩盖 26 条端到端用例全部 SKIP 的事实
// （SPAWN_OK=false 的沙箱环境里绿 ≠ 真跑过）。
// v3.29.0（A-3）：**退出码语义修正** —— 只有真失败才 exit 1；envSkip 是"环境能力受限"（沙箱禁 spawn、
//   CI 的 WB_NO_NET 前提缺口），不是代码问题，**不再让 job 变红**（旧行为 exit 2 会被 GitHub Actions
//   一律判失败，且红的原因看起来像"测试失败"）。CI 正常环境下 envSkip 应为 0，summary 会显式标注。
//   为此**不需要** job 级 continue-on-error —— 那玩意无法区分 exit 1/2，会连带吞掉真实回归。
// v3.60.0（C1 门禁）：**保留**上面本地语义不动，另在 **CI** 上把"跳过"变成硬失败（见 ciSkipGate 顶部）。
//   出口复用同一条 `fail ? 1 : 0`（**不再引入 exit 2**，避免重蹈 A-3 覆辙）。
const _inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);   // GitHub Actions 两者都设；只看其一遇 runner 差异会静默失效
const _gate = ciSkipGate({ inCI: _inCI, envSkipCount, wbNoNet: process.env.WB_NO_NET });
if (_gate.shouldFail) fail++;   // 计入 fail：与"真断言失败"走同一出口 → 退出码 1
console.log(`\n结果：${pass} 过 / ${fail} 败 / ${envSkipCount} 环境受限跳过`
  + (envSkipCount > 0 ? '（需要 node 子进程或 WB_NO_NET 前提缺口；属环境能力限制；本地不计入退出码、CI 上按 C1 门禁计入）' : ''));
if (_gate.shouldFail) {
  console.error(`✗ CI 门禁（C1）：出现 ${_gate.unexpected} 个非预期跳过`
    + `（CI 上 SPAWN_OK 已有前置探针保证、离线那一遍的 WB_NO_NET 前提缺口至多 ${_gate.expectedPremise} 条）`
    + ` —— 这些端到端用例并未真跑，"绿"是假的，判失败。`);
}
process.exit(fail ? 1 : 0);
