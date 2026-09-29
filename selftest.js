#!/usr/bin/env node
// selftest.js —— 离线冒烟自测（v3.18.2 起随仓库分发，第三方可复跑）
// 用法：node selftest.js
// 不依赖 WorkBuddy 环境：全部在 os.tmpdir() 隔离目录跑，TOKEN_TRACKER_NO_TOAST=1，不碰真实账本、不弹通知。
// 已知限制：联网重建依赖网络可达，离线时对应断言自动降级为「备份行为」检查。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SRC = __dirname;
const NODE = process.execPath;
let pass = 0, fail = 0, skipped = false;

// 前置探测：部分沙箱/受限环境禁止 node→node 子进程（spawnSync 报 EBUSY 等）。
// 此时本测试无法运行（不是失败），报 SKIP 让调用方知道需在正常环境复跑。
{
  const probe = spawnSync(NODE, ['-e', 'console.log("ok")'], { timeout: 10000, windowsHide: true });
  if (probe.status === null && probe.error) {
    console.log(`SKIP：本环境禁止 node 子进程（${probe.error.code || probe.error.message}），selftest 需在正常环境运行`);
    process.exit(2);
  }
}

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

// T0：语法检查（全部可执行 JS）
for (const f of ['token-tracker.js', 'refresh-prices.js', 'deepseek-official.js', 'refresh-holidays.js']) {
  const r = spawnSync(NODE, ['--check', path.join(SRC, f)], { windowsHide: true });
  ok(`语法 ${f}`, r.status === 0, String(r.stderr || '').slice(0, 120));
}

// 隔离环境：<tmp>/selftest-<ts>/skills/token-usage-tracker/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-selftest-'));
const skillDir = path.join(tmp, 'skills', 'token-usage-tracker');
fs.mkdirSync(skillDir, { recursive: true });
for (const f of ['token-tracker.js', 'refresh-prices.js', 'deepseek-official.js', 'pricing.json', 'holidays.json']) {
  fs.copyFileSync(path.join(SRC, f), path.join(skillDir, f));
}
const env = Object.assign({}, process.env, { WB_ROOT: tmp, TOKEN_TRACKER_NO_TOAST: '1' });

// T1：--hook 正常路径（合法 pricing + 空 ledger）→ exit 0
{
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
    input: JSON.stringify({ session_id: 'selftest', prompt: 't' }), env, timeout: 30000, windowsHide: true,
  });
  ok('--hook exit 0', r.status === 0, `exit=${r.status} ${String(r.stderr).slice(0, 120)}`);
}

// T2：--report all → exit 0 且输出不含「读取方指令」（M3 回归）
{
  const r = spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], {
    env, timeout: 30000, windowsHide: true, encoding: 'utf8',
  });
  ok('--report all exit 0', r.status === 0, `exit=${r.status}`);
  ok('--report 无指令注入行', (r.stdout || '').indexOf('读取方指令') < 0);
}

// T3：损坏 pricing → 备份 .corrupt-* 创建 + 原文件被改名移走（自愈链路第一步，离线可验证）
{
  fs.writeFileSync(path.join(skillDir, 'pricing.json'), '{"broken');
  spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--hook'], {
    input: JSON.stringify({ session_id: 'selftest', prompt: 't' }), env, timeout: 90000, windowsHide: true,
  });
  const baks = fs.readdirSync(skillDir).filter((f) => f.startsWith('pricing.json.corrupt-'));
  ok('损坏 pricing 产生 .corrupt-* 备份', baks.length === 1, `found=${baks.length}`);
  ok('损坏文件已改名移走', !fs.existsSync(path.join(skillDir, 'pricing.json')) || (() => {
    try { JSON.parse(fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8')); return true; } catch (e) { return false; }
  })());
}

// T4：deepseek-official M7 守卫——损坏 pricing 原地存在时拒绝覆盖式重建
{
  fs.writeFileSync(path.join(skillDir, 'pricing.json'), '{"broken');
  const r = spawnSync(NODE, [path.join(skillDir, 'deepseek-official.js')], {
    env, timeout: 60000, windowsHide: true, encoding: 'utf8',
  });
  ok('M7 守卫拒绝覆盖（非 0 退出 + 明确 FAIL_REASON）', r.status !== 0 && String(r.stderr || '').indexOf('拒绝覆盖') >= 0,
    `exit=${r.status}`);
  ok('损坏文件未被替换', fs.readFileSync(path.join(skillDir, 'pricing.json'), 'utf8').includes('broken'));
}

// T5：账本损坏防护（H6 回归）——BOM 账本不产生 .corrupt-* 备份
{
  fs.writeFileSync(path.join(tmp, 'skills', 'token-usage-tracker', 'daily-usage.json'), '\uFEFF{"days":{}}');
  const before = fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-')).length;
  spawnSync(NODE, [path.join(skillDir, 'token-tracker.js'), '--report', 'all'], {
    env, timeout: 30000, windowsHide: true,
  });
  const after = fs.readdirSync(skillDir).filter((f) => f.startsWith('daily-usage.json.corrupt-')).length;
  ok('BOM 账本不再被判损坏（无新增 .corrupt-*）', after === before);
}

// 清理
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
