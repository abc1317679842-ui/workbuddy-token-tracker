#!/usr/bin/env node
// token-tracker.js — 读取 WorkBuddy 最新 trace 的真实 token / 耗时。
// 数据来源：~/.workbuddy/traces/<pid>/trace_*.json 中的 trace.modelInfo / trace.duration
// （WorkBuddy 每轮 LLM 调用结束都会落盘成一个新 trace 文件，但 UI 不显示，这里把它读出来）。
//
// 用法：
//   node token-tracker.js            -> 输出单行纯文本（供技能指令手动贴到回复末尾）
//   node token-tracker.js --hook     -> 输出 {"hookSpecificOutput":{"additionalContext":"..."}}（供 UserPromptSubmit hook 注入）
//   node token-tracker.js --stop     -> 输出 {"hookSpecificOutput":{"systemMessage":"..."}}（供 Stop hook：回答结束后触发，
//                                       此时本轮 trace 已落盘，读到的就是【本条回答】的精确统计，以系统消息显示给用户）
//
// 轮次语义（v2 修复）：
//   每个 trace_*.json = 一轮完整 LLM 调用，整轮结束后才落盘。因此"当前正在生成的一轮"在回答
//   结束前是读不到的，手动/--hook 模式输出的永远是【最新已完成轮次】的统计：
//     - 快照记录了"上次已统计的文件"；若最新文件 == 快照文件，说明这一轮已显示过（例如上一轮
//       末尾显示过、或 hook 刚记录过），本次输出标为「上一轮」且不重复更新快照。
//   --stop 模式特殊：Stop 事件在回答【结束后】触发，此时本轮 trace 已写完，最新文件就是本轮，
//   因此能拿到本条回答的精确消耗，直接以 systemMessage 呈现。
//   快照只作"轮次去重"用，不做总量 diff —— 直接展示该轮自身统计，天然免疫"换会话/上下文重置
//   导致总量变小"的负数问题。
//
// 测试：设置环境变量 WB_ROOT 可覆盖 ~/.workbuddy 根目录（供构造场景验证）。

const fs = require('fs');
const path = require('path');
const os = require('os');

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const TRACE_DIR = path.join(WB, 'traces');
const SNAP = path.join(WB, 'skills', 'token-usage-tracker', '.snapshot.json');
const PROBE = path.join(WB, 'skills', 'token-usage-tracker', '.stop-probe.json');
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');

function fmt(n) {
  n = Number(n || 0);
  // 大数用中文单位（万/亿），保留 1 位小数并去尾 0，读起来快
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function fmtDur(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  // 先对总秒取整再拆分，避免 3599.6s → "59m 60s" 的进位溢出
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  const r = totalSec % 60;
  return `${m}m ${r}s`;
}

// 只认 trace_*.json，避免把目录里其它 json 当 trace。
// skipInvalid=true 时跳过"空壳"trace（平台先建文件、modelInfo 稍后才填充，此时 totalTokens=0/modelInfo={}），
// 返回第一个有真实 token 数据的文件；解析失败（半写）同样跳过。
function latestTraceFile(skipInvalid) {
  if (!fs.existsSync(TRACE_DIR)) return null;
  const dirs = fs.readdirSync(TRACE_DIR)
    .map((d) => path.join(TRACE_DIR, d))
    .filter((p) => {
      try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const d of dirs) {
    const files = fs.readdirSync(d)
      .filter((f) => /^trace_.+\.json$/.test(f))
      .map((f) => path.join(d, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files) {
      if (!skipInvalid) return f;
      try {
        const t = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (isValidTrace(t)) return f;
      } catch (e) { /* 半写/损坏：跳过 */ }
    }
  }
  return null;
}

// 有效 = 含真实 token 数据（平台先建空壳 trace、后填充 modelInfo；totalTokens/modelInfo 全空视为无效）
function isValidTrace(t) {
  const tr = (t && t.trace) || {};
  const mi = tr.modelInfo || {};
  if ((tr.totalTokens || 0) > 0 || (mi.totalInputTokens || 0) > 0 || (mi.totalOutputTokens || 0) > 0) return true;
  // 顶层空壳但 spans 里有 generation usage 也算有效（见 aggregateFromSpans）
  const a = aggregateFromSpans(t);
  return (a.p + a.c) > 0;
}

// 从 spans 的 generation 节点聚合真实 token：平台有时顶层 modelInfo 为空（空壳 trace），
// 但每个 generation span 的 toolOutput 字符串里含 OpenAI 格式 usage
// {prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens}，逐条累加即本轮真实消耗。
// 顺带取模型名（item.model，用于计费）。
function aggregateFromSpans(t) {
  let p = 0, c = 0, ct = 0, model = '';
  const spans = (t && t.spans) || [];
  for (const s of spans) {
    if (!s || s.type !== 'generation') continue;
    const to = s.toolOutput;
    if (typeof to !== 'string') continue;
    let arr;
    try { arr = JSON.parse(to); } catch (e) { continue; }
    if (arr && typeof arr === 'object' && !Array.isArray(arr)) arr = [arr];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!model && item && typeof item === 'object' && item.model) model = String(item.model);
      const u = (item && typeof item === 'object') ? item.usage : null;
      if (u) {
        p += u.prompt_tokens || 0;
        c += u.completion_tokens || 0;
        const det = u.prompt_tokens_details || {};
        ct += det.cached_tokens || 0;
      }
    }
  }
  return { p, c, ct, model };
}

function extract(t) {
  const tr = (t && t.trace) || {};
  const mi = tr.modelInfo || {};
  const models = mi.models;
  const res = {
    in: mi.totalInputTokens || 0,
    out: mi.totalOutputTokens || 0,
    cached: mi.totalCachedTokens || 0,
    total: tr.totalTokens || 0,
    durMs: tr.duration || 0,
    model: Array.isArray(models) && models.length ? String(models[0]) : '',
  };
  // 兜底：顶层 modelInfo 缺失（空壳 trace）时从 spans 聚合（已验证与顶层一致）
  if (!res.in && !res.out) {
    const a = aggregateFromSpans(t);
    if (a.p + a.c > 0) {
      res.in = a.p; res.out = a.c; res.cached = a.ct; res.total = a.p + a.c;
      if (!res.model && a.model) res.model = a.model;
    }
  }
  return res;
}

// 同步休眠（Node 主线程可用 Atomics.wait，避免忙等烧 CPU；异常时退化为忙等兜底）
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 兜底忙等 */ }
  }
}

// 容忍"正在写"的半成品文件：最多重试 3 次（每次等 150ms），仍失败则抛错
function readTrace(f) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch (e) {
      lastErr = e;
      if (i < 2) sleep(150);
    }
  }
  throw lastErr;
}

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAP, 'utf-8'));
  } catch (e) {
    return null; // 不存在或损坏：按首轮处理
  }
}

function saveSnapshot(snap) {
  try {
    fs.mkdirSync(path.dirname(SNAP), { recursive: true });
    fs.writeFileSync(SNAP, JSON.stringify(snap));
  } catch (e) {
    // 快照写失败不阻断主输出，但按 C2 要求必须在 stderr 暴露，不静默
    process.stderr.write(`[token-tracker] 快照写入失败: ${e.message}\n`);
  }
}

function lineFor(stat, sameRound, modelShort) {
  const prefix = sameRound ? '上一轮 ' : '';
  const head = modelShort ? `${modelShort} ｜ ` : '';
  return `${prefix}${head}耗时 ${fmtDur(stat.durMs)} ｜ 输入 ${fmt(stat.in)} / 输出 ${fmt(stat.out)} tokens（该轮累计 ${fmt(stat.total)}，缓存命中 ${fmt(stat.cached)}）`;
}

// Stop hook 探针：记录触发时间、payload、读到的 trace 文件与统计，用于验证 Stop 事件
// 是否真的触发、触发时本轮 trace 是否已落盘（若 sameRound=true 说明读到的是旧轮）。
function writeProbe(info) {
  try {
    fs.mkdirSync(path.dirname(PROBE), { recursive: true });
    fs.writeFileSync(PROBE, JSON.stringify(info, null, 1));
  } catch (e) {
    process.stderr.write(`[token-tracker] 探针写入失败: ${e.message}\n`);
  }
}

function readStdin() {
  // hook 场景 stdin 是管道（有 payload）；交互终端是 TTY，readFileSync(0) 会阻塞等待输入直到 EOF
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf-8').toString();
  } catch (e) {
    return '';
  }
}

function summarizePayload(raw) {
  try {
    const p = JSON.parse(raw);
    const o = {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      o[k] = typeof v === 'string' ? v.slice(0, 120) : v;
    }
    return o;
  } catch (e) {
    return { raw: String(raw).slice(0, 200) };
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ===== 费用计算（基于 pricing.json 的官方 API 价格，支持高峰时段） =====
function loadPricing() {
  try { return JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { return null; }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// 每日价格自动刷新：当天已刷新（date==今天）→ 不联网直接返回；过期 → 同步调 refresh-prices.js
// 联网拉 OpenRouter 更新（execFileSync 保证刷新完成才继续；失败保留本地价并 stderr 暴露，不静默）。
function autoRefreshPricing(pricing) {
  if (!pricing) return null;
  if (pricing.date === todayStr()) return pricing;
  const script = path.join(path.dirname(PRICING), 'refresh-prices.js');
  if (!fs.existsSync(script)) {
    process.stderr.write(`[token-tracker] refresh-prices.js 不存在，跳过自动刷新\n`);
    return pricing;
  }
  try {
    require('child_process').execFileSync(process.execPath, [script], {
      timeout: 15000, stdio: 'pipe', env: Object.assign({}, process.env, { WB_ROOT: WB }),
    });
    return loadPricing(); // 刷新成功 → 重新读取（含新 date）
  } catch (e) {
    // 刷新失败：保留旧价，date 不变（次日重试）；失败原因已在 refresh-prices.js 的 stderr 输出
    process.stderr.write(`[token-tracker] 价格自动刷新失败（沿用本地价）: ${String(e.message).slice(0, 200)}\n`);
    return pricing;
  }
}

// 模型匹配：trace 里的模型名可能带厂商前缀（如 moonshotai/kimi-k2.7-code / deepseek/deepseek-v4-flash）。
// 先精确匹配，再对每个已收录 key 做包含匹配（任一方包含另一方即命中，取最长的那个避免误匹配）。
function findModel(pricing, modelName) {
  if (!pricing || !pricing.models || !modelName) return null;
  const name = String(modelName).toLowerCase();
  const direct = pricing.models[name];
  if (direct) return { key: name, m: direct };
  let best = null, bestLen = 0;
  for (const key of Object.keys(pricing.models)) {
    const k = key.toLowerCase();
    if (k && (name.includes(k) || k.includes(name)) && k.length > bestLen) {
      best = { key, m: pricing.models[key] };
      bestLen = k.length;
    }
  }
  return best;
}

// 高峰时段（北京时间，本地时区即北京）：9:00-12:00、14:00-18:00，价格翻倍
function isPeakHour() {
  const h = new Date().getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// cost = 未命中输入×输入价 + 命中输入×缓存价 + 输出×输出价（元），按当前时段取倍率
function calcCost(stat, pricing) {
  if (!pricing || !stat) return null;
  const hit = findModel(pricing, stat.model || 'deepseek-v4-flash');
  if (!hit) return null;
  const m = hit.m;
  // 峰谷倍率：显式声明了才翻倍（DeepSeek 原厂系=2），未声明默认无峰谷，避免高峰误翻倍
  const mult = isPeakHour() ? (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 1) : 1;
  const cached = stat.cached || 0;
  const uncached = Math.max(0, (stat.in || 0) - cached);
  const cost = (uncached / 1e6) * (m.input_price || 0) * mult
             + (cached / 1e6) * (m.cached_price || 0) * mult
             + ((stat.out || 0) / 1e6) * (m.output_price || 0) * mult;
  return cost;
}

function fmtCost(cost) {
  if (cost == null) return null;
  if (cost < 0.005) return '¥<0.01';
  return '¥' + cost.toFixed(2);
}

// Windows 系统通知：本条回答结束后把精确消耗以 toast 弹出（系统层面，用户可见）。
// 用 PowerShell WinRT Toast API，参数走 -EncodedCommand（UTF-16LE Base64）避免中文编码问题。
// 模板 ToastText02（两行）：行1=耗时/输入/输出，行2=缓存命中+费用。
// 用 execFileSync 同步等待 powershell 完成后再退出——避免 hook 进程先退出导致 toast 没弹出
//（实测：异步 execFile 下 node 退出时 powershell 可能被终止，通知丢失）。
// 失败不阻断主流程（stderr 记录）。
function showToast(line1, line2) {
  if (process.platform !== 'win32') return;
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${escapeXml(line1)}</text><text id="2">${escapeXml(line2)}</text></binding></visual></toast>')`,
    "$t = New-Object Windows.UI.Notifications.ToastNotification $xml",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('WorkBuddy Token Tracker').Show($t)",
  ].join('; ');
  try {
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout: 10000, stdio: 'ignore' });
  } catch (e) {
    process.stderr.write(`[token-tracker] toast 失败: ${e.message}\n`);
  }
}

// 模型显示名：优先取 pricing 里收录的 name（去掉括号说明），未收录用 trace 原始名。
// 完整显示不截断（用户要求：toast 两行空间足够放全名），仅去掉括号里的补充说明便于紧凑。
function shortModelName(stat, pricing) {
  let name = '';
  const hit = findModel(pricing, stat && stat.model);
  if (hit && hit.m && hit.m.name) name = String(hit.m.name);
  else name = String((stat && stat.model) || '');
  return name.replace(/\(.*?\)/g, '').trim();
}

// 显示宽度近似：全角字符≈2、半角≈1（用于 toast 超宽保护，避免触发换行变 3 行）
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

// 当前时段价格策略标注（放行1 模型名后，用户要求：第一行有空间，时段信息写第一行）：
//   - 模型声明 peak_multiplier>1 且当前在高峰时段 → `高峰×N`（如 DeepSeek 原厂系=2：工作日 9-12/14-18 翻倍）
//   - 预留：未来模型若声明 night_discount（夜间折扣），夜间显示 `夜间N折`
//   - 无时段策略 → 空串不显示（避免噪音）
function periodNote(stat, pricing) {
  if (!pricing || !stat) return '';
  const hit = findModel(pricing, stat.model);
  if (!hit) return '';
  const m = hit.m;
  const mult = typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 1;
  if (isPeakHour() && mult > 1) return `高峰×${mult}`;
  // 夜间折扣预留：if (m.night_discount && isNightHour()) return `夜间${m.night_discount}折`;
  return '';
}

// toast 两行数据（紧凑版，Windows 通知默认只显示两行；ToastText02 模板正文超长会换行变 3 行）。
// 布局原则（2026-08-05 v2.7，用户要求：行1 只放模型名+时段+耗时，行2 输入/输出写完整）：
//   行1 = [模型名｜][时段标注｜]耗时   —— 标题大字：模型名 + 时段策略（高峰×2 等）+ 耗时
//   行2 = 输入 X / 输出 Y｜缓存NN.NN%｜¥W  —— 正文小字：核心数字，价格不带「约」（价格本就是估算展示）
// 说明：Windows toast 第二行默认即「正文小字号」（ToastText02 模板标题大字+正文小字）；
//       更小字号（Caption）需 AdaptiveGroup+HintStyle 自定义 XML（Win10 周年更新+），兼容性有风险，未采用。
// 分隔符「｜」两侧不加空格以省宽度。两行均有超宽保护，保证绝不触发换行变 3 行。
const TOAST_LINE_MAX_W = 52; // 一行最大显示宽度单位（实测用户原行1 约 51u 即"占满"，52 为安全值）
function toastLine1(stat, modelShort, period) {
  const head = modelShort ? `${modelShort}｜` : '';
  const mid = period ? `${period}｜` : '';
  return `${head}${mid}${fmtDur(stat.durMs)}`;
}
function toastLine2(stat, pricing) {
  const cost = fmtCost(calcCost(stat, pricing));
  const input = (stat && stat.in) || 0;
  const cached = (stat && stat.cached) || 0;
  // 缓存占比精确到两位小数（如 99.12%）；无输入数据则不显示缓存段
  const ratioPct = input > 0 ? ((cached / input) * 100).toFixed(2) : null;
  const ratioTxt = ratioPct === null ? '' : `缓存${ratioPct}%｜`;
  let line = `输入 ${fmt(stat.in)} / 输出 ${fmt(stat.out)}｜${ratioTxt}${cost || '未收录'}`;
  // 宽度保护：超宽丢缓存占比，保住价格与核心数字（高峰标注已移至行1，行2 不再有溢出风险）
  if (dispWidth(line) > TOAST_LINE_MAX_W) {
    line = line.replace(ratioTxt, '');
  }
  return line;
}

// ===== 新模型价格自动补录（检测到未收录模型 → 立即联网查 OpenRouter） =====

// 同步跑一个子进程 fetch OpenRouter（父脚本主流程是同步的，用 execFileSync 等待结果）。
// 返回：找到 → {id, usdIn, usdOut}（USD/百万 tokens）；未找到 → null；网络/解析失败 → undefined。
function lookupOrPrice(modelName, timeoutMs) {
  const script = [
    '(async () => {',
    "  try {",
    "    const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'User-Agent': 'token-usage-tracker/1.0' } });",
    "    if (!res.ok) { console.error('HTTP ' + res.status); process.exit(2); }",
    "    const j = await res.json();",
    `    const needle = ${JSON.stringify(String(modelName).toLowerCase())};`,
    "    let hit = null;",
    "    for (const m of (j.data || [])) { if (String(m.id).toLowerCase() === needle) { hit = m; break; } }",
    "    if (!hit) for (const m of (j.data || [])) { const id = String(m.id).toLowerCase(); if (id && (id.includes(needle) || needle.includes(id))) { hit = m; break; } }",
    "    if (!hit) { console.error('NOT_FOUND'); process.exit(3); }",
    "    const pr = (hit.pricing || {});",
    "    const pIn = Number(pr.prompt), pOut = Number(pr.completion);",
    "    if (!(pIn >= 0 && pOut >= 0)) { console.error('NO_PRICE'); process.exit(4); }",
    "    console.log(JSON.stringify({ id: hit.id, usdIn: pIn * 1e6, usdOut: pOut * 1e6 }));",
    "  } catch (e) { console.error(String(e && e.message)); process.exit(1); }",
    '})();',
  ].join('\n');
  try {
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
      timeout: timeoutMs || 10000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
    });
    const lines = out.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    if (stderr.includes('NOT_FOUND') || stderr.includes('NO_PRICE')) return null;
    process.stderr.write(`[token-tracker] OpenRouter 查价失败: ${stderr.slice(0, 150)}\n`);
    return undefined;
  }
}

// 把新模型按 OpenRouter USD 价 × 汇率补入 pricing.json（标注 auto_converted，待人工核验官方价）
function addModelPrice(pricing, modelName, ref) {
  const name = String(modelName).toLowerCase();
  const rate = Number(pricing.usd_cny_rate) > 0 ? pricing.usd_cny_rate : 7.2;
  pricing.models[name] = {
    name: String(modelName),
    input_price: Number((ref.usdIn * rate).toFixed(2)),
    cached_price: Number((ref.usdIn * rate * 0.1).toFixed(2)),
    output_price: Number((ref.usdOut * rate).toFixed(2)),
    peak_multiplier: 1,
    or_id: ref.id,
    usd_input_price: Number(ref.usdIn.toFixed(6)),
    usd_output_price: Number(ref.usdOut.toFixed(6)),
    auto_converted: true,
    note: '新模型自动补录（OpenRouter USD×汇率估算，待人工核验官方价；时段策略默认无峰谷，如厂商有高峰/夜间折扣需搜索核验后补 peak_multiplier/night_discount 字段）',
  };
  try {
    fs.mkdirSync(path.dirname(PRICING), { recursive: true });
    fs.writeFileSync(PRICING, JSON.stringify(pricing, null, 2) + '\n');
    return true;
  } catch (e) {
    process.stderr.write(`[token-tracker] 新模型价格写入失败: ${e.message}\n`);
    return false;
  }
}

// 检测未收录模型 → 立即联网补录。返回 { status, note }：
//   none（已收录/无模型名）| added（自动补录成功）| not-found（OpenRouter 无此模型，记入已查列表）
//   | error（联网失败，不记已查，下次重试）| skipped（已查过未收录，不再重复联网）
function ensureNewModelPricing(pricing, stat) {
  if (!pricing || !pricing.models || !stat || !stat.model) return { status: 'none', note: '' };
  const hit = findModel(pricing, stat.model);
  if (hit && typeof hit.m.input_price === 'number') return { status: 'none', note: '' };
  const name = String(stat.model).toLowerCase();
  const looked = (pricing._lookedup_models || []).indexOf(name) >= 0;
  if (looked) {
    return { status: 'skipped', note: `⚠️ 新模型 ${stat.model} 价格已查过未收录，可搜官方定价页人工补录` };
  }
  const ref = lookupOrPrice(stat.model);
  if (ref === null) {
    // OpenRouter 确认没有 → 记入已查列表，避免每次运行都联网
    pricing._lookedup_models = pricing._lookedup_models || [];
    if (pricing._lookedup_models.indexOf(name) < 0) pricing._lookedup_models.push(name);
    try { fs.writeFileSync(PRICING, JSON.stringify(pricing, null, 2) + '\n'); }
    catch (e) { process.stderr.write(`[token-tracker] 已查列表写入失败: ${e.message}\n`); }
    return { status: 'not-found', note: `⚠️ 新模型 ${stat.model} OpenRouter 未收录，请用 unified-search 搜官方定价页补录` };
  }
  if (ref === undefined) {
    return { status: 'error', note: `⚠️ 新模型 ${stat.model} 联网查价失败（网络异常），稍后自动重试` };
  }
  const ok = addModelPrice(pricing, stat.model, ref);
  return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已自动补录估算价（OpenRouter，待核验）；时段折扣策略（高峰/夜间）请用搜索技能核验补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
}

function main() {
  const asHook = process.argv.includes('--hook');
  const asStop = process.argv.includes('--stop');

  // 输出统一走 stdout；hook 场景输出 Claude-Code 风格 JSON
  const out = (hookOut) => {
    process.stdout.write(asHook || asStop ? JSON.stringify(hookOut) : hookOut);
  };
  const plain = (msg) => (asHook ? { hookSpecificOutput: { additionalContext: msg } } : msg);

  const f = latestTraceFile(true);
  if (!f) { out(plain('暂无 trace 数据（可能尚未发生模型调用）')); return; }

  let t;
  try { t = readTrace(f); } catch (e) {
    if (asStop) {
      writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: false, reason: 'trace-not-ready', payload: summarizePayload(readStdin()) });
    }
    out(plain('trace 文件尚未完成写入（稍后重试）'));
    return;
  }

  const stat = extract(t);
  const snap = loadSnapshot();
  const sameRound = !!(snap && snap.file === f);
  const pricing = autoRefreshPricing(loadPricing());
  // 刷新失败/文件缺失时的提醒（不静默）
  if (pricing && pricing.date !== todayStr()) {
    process.stderr.write(`[token-tracker] 定价数据过期（${pricing.date}），自动刷新未成功，请手动运行 refresh-prices.js\n`);
  }

  if (asStop) {
    // 实测发现 Stop 触发比本轮 trace 落盘早几百毫秒（读到旧文件 → sameRound=true）。
    // 轮询等待"比快照更新的有效 trace"出现（最多 3 秒），拿到即本条精确数据；超时则退化为"上一轮"。
    let tf = f, ts = stat, tSame = sameRound;
    // 等待"比入口文件更新"的有效 trace 出现（最多 3 秒）＝本条落盘。两种情况必须等：
    //   sameRound=true（入口文件=上一轮，等本条）；snap 缺失（首轮，入口文件可能也是上一轮，不能直接当"本条"）。
    // 若入口文件本就是本条（落盘早于 Stop），3 秒内不会有新文件，超时后仍按"本条"处理（tSame 保持 false）。
    if (sameRound || !snap) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        sleep(200);
        const nf = latestTraceFile(true);
        if (nf && nf !== f) {
          try { ts = extract(readTrace(nf)); tf = nf; tSame = false; break; }
          catch (e) { /* 新文件半写中，继续等 */ }
        }
      }
    }
    if (!tSame) saveSnapshot({ file: tf, stat: ts });
    const modelShort = shortModelName(ts, pricing);
    const line = lineFor(ts, tSame, modelShort);
    const nmNote = ensureNewModelPricing(pricing, ts).note;
    writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sameRound: tSame, traceFile: tf, stat: ts, line, waited: !sameRound ? 0 : (tSame ? 'timeout' : 'ok'), payload: summarizePayload(readStdin()) });
    // 本条精确数据 → 弹 Windows 系统通知（两行：模型/耗时/输入输出 + 缓存/费用；execFileSync 保证弹出；UI 内 systemMessage 通道实测不显示，故用 toast）
    if (!tSame) showToast(toastLine1(ts, modelShort, periodNote(ts, pricing)), toastLine2(ts, pricing));
    // systemMessage 保留：若未来平台支持即生效，不显示则无副作用；含新模型补录提示
    out({ hookSpecificOutput: { systemMessage: nmNote ? `${line}\n${nmNote}` : line } });
    return;
  }

  if (!sameRound) {
    // 新轮次：展示该轮统计并记录快照（供后续轮次去重）
    saveSnapshot({ file: f, stat });
  }

  const shown = sameRound ? snap.stat : stat;
  const modelShort = shortModelName(shown, pricing);
  const nmNote = ensureNewModelPricing(pricing, shown).note;
  const line = lineFor(shown, sameRound, modelShort);

  out(asHook
    ? { hookSpecificOutput: { additionalContext: nmNote ? `${line}\n${nmNote}` : line } }
    : (nmNote ? `${line}\n${nmNote}` : line));
}

main();
