#!/usr/bin/env node
// refresh-prices.js — 每日价格自动刷新（token-usage-tracker 技能配套）。
//
// 策略（用户要求）：
//   - 当天第一次运行（pricing.json 的 date 非今天）→ 联网拉取 OpenRouter API 更新价格；
//   - 当天已经刷新过（date == 今天）→ 直接退出，不再联网；
//   - 拉取失败 → 保留本地价格、date 不改（次日重试），stderr 报错。
//
// 数据源：OpenRouter 免费 API https://openrouter.ai/api/v1/models（无需 key，约每 12 小时更新）。
//   返回 USD/token，×1e6×usd_cny_rate → 元/百万 tokens。
// 更新规则：
//   - 已收录模型（有 or_id 匹配）：更新 usd_input_price / usd_output_price 参考字段，不动本地官方人民币主价；
//   - 未收录主价的模型（本地缺 input_price 但 OpenRouter 有）：用 USD×汇率补人民币估算价，标 auto_converted: true。
//
// 用法：node refresh-prices.js
// 测试：WB_ROOT 环境变量可覆盖 ~/.workbuddy（WB_ROOT 下需存在 skills/token-usage-tracker/pricing.json）。

const fs = require('fs');
const path = require('path');
const os = require('os');

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const OR_URL = 'https://openrouter.ai/api/v1/models';
const TIMEOUT_MS = 10000;
const DEFAULT_RATE = 7.2;

function todayStr() { return new Date().toISOString().slice(0, 10); }

function load() {
  try { return JSON.parse(fs.readFileSync(PRICING, 'utf-8')); }
  catch (e) { throw new Error(`pricing.json 读取失败: ${e.message}`); }
}

function save(p) {
  fs.mkdirSync(path.dirname(PRICING), { recursive: true });
  fs.writeFileSync(PRICING, JSON.stringify(p, null, 2) + '\n');
}

async function fetchOrPricing() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OR_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'token-usage-tracker/1.0 (WorkBuddy skill)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const out = {};
    for (const m of (j.data || [])) {
      const pr = (m && m.pricing) || {};
      const pIn = Number(pr.prompt), pOut = Number(pr.completion);
      if (!(pIn >= 0 && pOut >= 0)) continue;
      out[m.id] = { usdIn: pIn * 1e6, usdOut: pOut * 1e6 };
    }
    if (!Object.keys(out).length) throw new Error('OpenRouter 返回空价格表');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let pricing;
  try { pricing = load(); }
  catch (e) { process.stderr.write(`[refresh-prices] ${e.message}\n`); process.exit(1); }

  const today = todayStr();
  if (pricing.date === today) {
    console.log(`[refresh-prices] 今天(${today})已刷新过，跳过联网`);
    return;
  }

  let or;
  try { or = await fetchOrPricing(); }
  catch (e) {
    process.stderr.write(`[refresh-prices] OpenRouter 拉取失败（保留本地价格，次日重试）: ${e.message}\n`);
    process.exit(1);
  }

  const rate = Number(pricing.usd_cny_rate) > 0 ? pricing.usd_cny_rate : DEFAULT_RATE;
  const models = pricing.models || {};
  let updated = 0, added = 0;

  for (const key of Object.keys(models)) {
    const m = models[key];
    if (!m || typeof m !== 'object') continue;
    const orId = m.or_id;
    const ref = orId && or[orId];
    if (!ref) continue;
    m.usd_input_price = Number(ref.usdIn.toFixed(6));
    m.usd_output_price = Number(ref.usdOut.toFixed(6));
    updated++;
    // 本地缺人民币主价（未收录）→ 用 USD 换算补估算价
    if (typeof m.input_price !== 'number') {
      m.input_price = Number((ref.usdIn * rate).toFixed(2));
      m.output_price = Number((ref.usdOut * rate).toFixed(2));
      m.cached_price = Number((ref.usdIn * rate * 0.1).toFixed(2)); // 缓存价按输入 10% 估算，仅占位
      m.auto_converted = true;
      added++;
    }
  }

  pricing.date = today;
  pricing.usd_cny_rate = rate;
  pricing.last_source = 'openrouter';
  pricing.last_refresh_note = `${new Date().toISOString()} 自动刷新：更新 ${updated} 个模型 USD 参考价${added ? `，为 ${added} 个未收录模型补估算价` : ''}（汇率 ${rate}）`;
  try { save(pricing); }
  catch (e) { process.stderr.write(`[refresh-prices] 写入失败: ${e.message}\n`); process.exit(1); }

  console.log(`[refresh-prices] 刷新完成：date=${today}，更新 ${updated} 个模型 USD 参考价${added ? `，补 ${added} 个估算价` : ''}`);
}

main().catch((e) => {
  process.stderr.write(`[refresh-prices] 异常: ${e.message}\n`);
  process.exit(1);
});
