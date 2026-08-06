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
const SNAP_DIR = path.join(WB, 'skills', 'token-usage-tracker');
const SNAP = path.join(SNAP_DIR, '.snapshot.json');
// v2.21（2026-08-06）：快照按 session_id 拆分。多会话并发时全局单快照会被互相覆盖
// （B 会话提交会把 lastUserMsgAt 盖成自己的时间 → A 会话 Stop 聚合起点错乱）。
// 有 sid → .snapshot-<sid>.json（各会话隔离）；无 sid（手动运行）→ 全局 .snapshot.json（行为不变）。
function snapPath(sid) {
  if (!sid) return SNAP;
  // 防御：session_id 来自外部 payload，只留安全字符防路径注入（C6）
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? path.join(SNAP_DIR, `.snapshot-${safe}.json`) : SNAP;
}
const PROBE = path.join(WB, 'skills', 'token-usage-tracker', '.stop-probe.json');
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const MODELS_CFG = path.join(WB, 'models.json'); // 自定义 API 配置（含 apiKey），仅 DeepSeek 官方模型启用余额显示
const BALANCE_CACHE = path.join(WB, 'skills', 'token-usage-tracker', '.balance.json');
const BALANCE_TTL_MS = 15 * 1000; // 余额缓存 15 秒（v2.18 从 60s 压短：用户要求实时，接口实测 300ms 级；正常轮询间隔 >15s 即每轮拿实时数，15s 内连发才复用）
// 积分/自定义 API 模式识别（v2.10）：官方文档证实内置模型列表就有 deepseek-v4-flash（与自定义 id 同名），
// trace/hook payload/transcript 无模式标记，进程级探测（tasklist/wmic/netstat）被本机安全策略禁用——
// "密钥是否在用"信号抓不到。用户认可方案 = **默认不显示，检测到余额变化才显示**：
// 余额会变 = DeepSeek 账户在真实消耗 = 自定义 API 模式（或其他处使用同一 key），这正是"有密钥才有消耗"的等价信号；
// 积分模式余额恒定 → 永不显示。
const BALANCE_HISTORY_MAX = 20;        // 缓存里保留的余额观测条数（用于与上次对比判定"是否变化"）

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

// v2.20：聚合"一轮内所有模型调用"的完整消耗。
// 一个用户轮次会落盘多个 trace（如会话起标题的 terminalTitleGenerator 小调用 + 主任务 trace，
// 实测 744 + 122.3 万），旧实现只取最新一个 trace，丢掉了其余部分——用户明确要求完整数据。
// 聚合规则（与锚点 trace 同 pid 目录，即同一进程/会话空间）：
//   1. startedAt >= 本轮起点（UserPromptSubmit hook 记录的 lastUserMsgAt，精确到用户提交时刻）；
//   2. trace 有 sessionId → 只有与 Stop payload 一致才计入（明确异会话排除）；
//   3. trace 无 sessionId（内部调用如起标题）→ 归属到「时间距离最近的主任务 trace」（v2.22）。
// v2.22（2026-08-06）：多会话并发时，仅"起点之后"不足以隔离内部调用——B 会话在 A 任务中途
// 提交时，A 的内部调用时间戳可能落在 B 起点之后而被 B 误收。用户洞察："各会话的任务结束
// 时间不可能在同一秒"——因此对无 sessionId 的内部调用，改为归属到「时间上最近的、有 sessionId
// 的主任务 trace」：落在某主任务窗口内（距离=0）或距某主任务端点最近者即为归属会话，只有
// 归属本会话的才累加。比"±N 秒容差窗口"精确，能利用任务时间线天然分隔并发会话。
// 累加 in/out/cached/total；耗时 = 窗口内最早 startedAt → 最新 endedAt；模型名取最后一次出现的。
function aggregateRound(roundStartMs, sessionId, anchorFile) {
  const dir = path.dirname(anchorFile);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^trace_.+\.json$/.test(f)); }
  catch (e) { return null; }
  // 第一遍：收集全部候选，并提取"主任务时间线"（有 sessionId 的有效 trace，作为内部调用的归属锚点）
  const cands = [];
  const mains = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    let t;
    try { t = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (e) { continue; } // 半写/损坏：跳过
    const tr = (t && t.trace) || {};
    const st = Date.parse(tr.startedAt || '');
    const et = Date.parse(tr.endedAt || '') || st;
    const sid = tr.sessionId ? String(tr.sessionId) : '';
    const s = extract(t);
    cands.push({ st, et, sid, s });
    if (sid && (s.in || s.out)) mains.push({ st, et, sid });
  }
  // 归属：无 sid 内部调用 → 距它时间最近的主任务 trace 的会话（在窗口内距离=0；否则取端点最近者）
  const ownerOf = (c) => {
    if (c.sid) return c.sid;
    if (!mains.length) return sessionId; // 无任何主任务锚点（罕见）→ 退化为按本会话处理（v2.20 行为）
    let best = null, bestD = Infinity;
    for (const m of mains) {
      const d = (c.st > m.et) ? (c.st - m.et) : ((c.et < m.st) ? (m.st - c.et) : 0);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best ? best.sid : sessionId;
  };
  let inSum = 0, outSum = 0, cachedSum = 0, totalSum = 0;
  let firstStart = null, lastEnd = null, model = '';
  for (const c of cands) {
    if (!(c.st >= roundStartMs)) continue;                       // 必须在本轮用户提交之后
    const owner = ownerOf(c);
    if (owner && sessionId && owner !== sessionId) continue;     // 归属非本会话 → 排除（含异会话主任务与错位的内部调用）
    const s = c.s;
    if (!(s.in || s.out)) continue;                              // 无真实 token 的空壳：跳过
    inSum += s.in; outSum += s.out; cachedSum += s.cached;
    totalSum += s.total || (s.in + s.out);
    if (firstStart === null || c.st < firstStart) firstStart = c.st;
    if (lastEnd === null || c.et > lastEnd) lastEnd = c.et;
    if (s.model) model = s.model;
  }
  if (!inSum && !outSum) return null;
  return {
    in: inSum, out: outSum, cached: cachedSum, total: totalSum || (inSum + outSum),
    durMs: (firstStart !== null && lastEnd !== null) ? Math.max(0, lastEnd - firstStart) : 0,
    model,
  };
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

function loadSnapshot(sid) {
  try {
    return JSON.parse(fs.readFileSync(snapPath(sid), 'utf-8'));
  } catch (e) {
    return null; // 不存在或损坏：按首轮处理
  }
}

function saveSnapshot(snap, sid) {
  try {
    const p = snapPath(sid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap));
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
  if (isPeakHour() && mult > 1) return `高峰`; // v2.14: 只显示「高峰」两字（用户拍板：不带 ×N、保持 1m 40s 耗时格式，省 2u 给余额腾位）
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
const TOAST_LINE_MAX_W = 52; // 一行最大显示宽度单位（正文小字上限；实测用户原行1 约 51u 即"占满"，52 为安全值）
// v2.17 实测修正：用户弹 5 个通知逐步加空格定位真实极限——测试四（模型名后 4 空格=47u）第一行不换行、测试五（5 空格=48u）换行
// → 行1 标题大字真实上限 47u（此前 42u 是保守估算值，低估了 5u；放宽后空间充裕可给分隔符两侧加空格）
const TOAST_ROW1_MAX_W = 47;
// toast 行1（v2.11：余额紧跟耗时 1 空格——v2.10 的"剩余空间居中"在带高峰标注时标题大字超宽变 3 行，
// 用户实测反馈后要求"不留空直接紧挨时间"；行1 宽度保护用实测安全值 42u，超宽丢余额）
// 布局：行1 = 模型名 | 时段标注 | 耗时 余额X（v2.17：实测上限 47u 后空间充裕，分隔符「 | 」两侧各 1 空格——
// 用户反馈"模型名和分隔符挨太近像一体"；高峰与模型名不再紧贴，可读性优先）
function toastLine1(stat, modelShort, period, balTxt) {
  const head = modelShort || '';
  // 分隔符「 | 」两侧各 1 空格：有时段 → 模型名 | 时段 | 耗时；无时段 → 模型名 | 耗时；无模型 → 不补
  const mid = period ? ` | ${period} | ` : (modelShort ? ' | ' : '');
  const base = `${head}${mid}${fmtDur(stat.durMs)}`;
  if (!balTxt) return base;
  const line = `${base} ${balTxt}`; // 耗时↔余额 1 空格分隔
  // 行1 标题大字超宽（>47u 实测换行）→ 退回无余额 base
  return dispWidth(line) <= TOAST_ROW1_MAX_W ? line : base;
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

// ===== DeepSeek 账户余额查询（NIX 客户端同款原理，仅自定义 API 模式） =====
// 原理：DeepSeek 官方接口 GET https://api.deepseek.com/user/balance + Bearer 认证即可查余额，
// 无需网页登录——这就是 NIX 等 DeepSeek 客户端"只给 API key 就能显示余额"的原因。
// 仅当 models.json 里配置了 DeepSeek 官方模型（url 指向 api.deepseek.com）时启用；内置积分模式无 key → 返回空。

// 从 models.json 提取 DeepSeek 官方 API key（脱敏使用：仅本机请求 api.deepseek.com，不外传）
function deepSeekApiKey() {
  try {
    const list = JSON.parse(fs.readFileSync(MODELS_CFG, 'utf-8'));
    if (!Array.isArray(list)) return '';
    for (const m of list) {
      const url = String((m && m.url) || '');
      const key = String((m && m.apiKey) || '');
      if (url.includes('api.deepseek.com') && key.startsWith('sk-')) return key;
    }
  } catch (e) { /* models.json 缺失/损坏 → 内置积分模式，无余额可查 */ }
  return '';
}

// 同步子进程 fetch 余额（主流程是同步的，沿用 lookupOrPrice 的子进程模式）。
// 返回 { total, currency } 或 null（失败/无余额）。
function queryBalance(key, timeoutMs) {
  const script = [
    '(async () => {',
    '  try {',
    `    const res = await fetch('https://api.deepseek.com/user/balance', { headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + ${JSON.stringify(key)} } });`,
    '    if (!res.ok) { console.error(\'HTTP \' + res.status); process.exit(2); }',
    '    const j = await res.json();',
    '    const arr = (j && Array.isArray(j.balance_infos)) ? j.balance_infos : [];',
    '    const cny = arr.find(b => b && b.currency === \'CNY\') || arr[0];',
    '    if (!cny || cny.total_balance == null) { console.error(\'NO_BALANCE\'); process.exit(3); }',
    '    console.log(JSON.stringify({ total: Number(cny.total_balance), currency: cny.currency || \'CNY\' }));',
    '  } catch (e) { console.error(String(e && e.message)); process.exit(1); }',
    '})();',
  ].join('\n');
  try {
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
      timeout: timeoutMs || 5000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
    });
    const lines = out.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    if (stderr.includes('NO_BALANCE')) return null;
    process.stderr.write(`[token-tracker] 余额查询失败: ${stderr.slice(0, 150)}\n`);
    return null;
  }
}

// 读取余额缓存（含历史），损坏/缺失 → 返回默认空结构（不抛错）
function readBalanceCache() {
  try {
    const j = JSON.parse(fs.readFileSync(BALANCE_CACHE, 'utf-8'));
    if (j && typeof j === 'object') {
      j.history = Array.isArray(j.history) ? j.history : [];
      return j;
    }
  } catch (e) { /* 无缓存/损坏 → 默认结构 */ }
  return { time: 0, total: null, currency: 'CNY', history: [] };
}

// 追加一次余额观测到历史（保留最近 BALANCE_HISTORY_MAX 条，旧格式缓存自动补 history 字段）
function pushBalanceHistory(cache, now, total) {
  cache.history.push({ time: now, total });
  if (cache.history.length > BALANCE_HISTORY_MAX) cache.history = cache.history.slice(-BALANCE_HISTORY_MAX);
}

// 余额显示文本：`余额¥2.77`（v2.18 恢复 ¥ 符号——实测行1 上限 47u 空间充裕；v2.15 曾去符号省宽度）；无 key / 非 DeepSeek / 余额未变化 / 查询失败且无缓存 → 空串（不显示，不报错）
// v2.10 变化检测：默认不显示（用户："宁愿先几轮不显示"）；每次查询与上次观测对比，
// 余额变了（账户在真实消耗=自定义 API 模式或别处用同一 key）才显示，积分模式余额恒定 → 永不显示。
// 缓存 15 秒（BALANCE_TTL_MS，v2.18 从 60s 压短——用户要求实时：余额接口实测 300ms 级，15s 内连发 toast 才复用缓存，正常轮询基本每轮都拿实时数）。
function balanceText() {
  const key = deepSeekApiKey();
  if (!key) return '';
  const now = Date.now();
  const cache = readBalanceCache();
// 取当前余额：15 秒缓存命中直接复用，否则网络查询；查询失败降级用旧缓存
  let total = null;
  if (typeof cache.total === 'number' && (now - (cache.time || 0)) < BALANCE_TTL_MS) {
    total = cache.total;
  } else {
    const r = queryBalance(key);
    if (r && typeof r.total === 'number') total = r.total;
    else if (typeof cache.total === 'number') total = cache.total; // 失败降级，不因网络抖动闪没
  }
  if (total === null) return '';
  const last = cache.history.length ? cache.history[cache.history.length - 1].total : null;
  pushBalanceHistory(cache, now, total);
  try { fs.writeFileSync(BALANCE_CACHE, JSON.stringify({ time: now, total, currency: cache.currency || 'CNY', history: cache.history })); } catch (e) { /* 缓存写失败不致命 */ }
  // 首次观测：只记录 baseline，不显示（给变化检测建立对比基准）
  if (last === null) return '';
  // 余额与上次不同（toFixed(2) 字符串比较，避免浮点相等判断）→ 账户在消耗 → 显示
  // v2.18: 恢复「¥」符号（实测行1 上限 47u，峰值场景 45u+1u=46u 仍有富余）
  return total.toFixed(2) !== last.toFixed(2) ? `余额¥${total.toFixed(2)}` : '';
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
  // v2.21：hook 与 stop 都从 payload 读 session_id（快照按会话拆分，多会话并发不互相覆盖）；
  // 手动运行无 payload → sid='' → 全局快照（行为不变）。stdin 只读一次，后面全部复用 payloadRaw。
  const payloadRaw = (asHook || asStop) ? readStdin() : '';
  let sid = '';
  try { sid = String((JSON.parse(payloadRaw).session_id) || ''); } catch (e) { /* payload 非 JSON 或无 session 字段 */ }

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
      writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: false, reason: 'trace-not-ready', payload: summarizePayload(payloadRaw) });
    }
    out(plain('trace 文件尚未完成写入（稍后重试）'));
    return;
  }

  const stat = extract(t);
  const snap = loadSnapshot(sid);
  const sameRound = !!(snap && snap.file === f);
  const pricing = autoRefreshPricing(loadPricing());
  // 刷新失败/文件缺失时的提醒（不静默）
  if (pricing && pricing.date !== todayStr()) {
    process.stderr.write(`[token-tracker] 定价数据过期（${pricing.date}），自动刷新未成功，请手动运行 refresh-prices.js\n`);
  }

  if (asStop) {
    const stopPayload = payloadRaw; // stdin 已在 main 开头读取一次：聚合取 session_id、探针记录 payload 共用
    // v2.19 修复（2026-08-06）：Stop 触发可能比本轮 trace 落盘早（实测早 15ms）。
    // 旧逻辑只在 sameRound || !snap 时等待；若入口文件恰是"另一个旧文件"（如会话起标题的
    // terminalTitleGenerator 小 trace）且 != 快照文件，会被误判为"本条"直接弹 toast
    // （曾把 744 tokens 当成本轮展示，真实为 122.3 万）。
    // 新逻辑：入口文件非"刚落盘"（≤1s）时一律轮询等待"比入口更新的有效 trace"（最多 3 秒），
    // 拿到即本条精确数据；超时且入口明显是旧文件（落盘 >3s 前）→ 标"上一轮"，不冒充本条。
    let tf = f, ts = stat, tSame = sameRound;
    const entryMtime = fs.statSync(f).mtimeMs;
    const freshEnough = (Date.now() - entryMtime) <= 1000; // 1 秒内落盘 → 入口本身就是本条
    if (!freshEnough) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        sleep(200);
        const nf = latestTraceFile(true);
        if (nf && nf !== f && fs.statSync(nf).mtimeMs > entryMtime) {
          try { ts = extract(readTrace(nf)); tf = nf; tSame = false; break; }
          catch (e) { /* 新文件半写中，继续等 */ }
        }
      }
      if (tf === f && (Date.now() - entryMtime) > 3000) tSame = true; // 没等到且入口很旧 → 按"上一轮"展示
    }
    // v2.20：聚合本轮起点（UserPromptSubmit hook 记录的 lastUserMsgAt）之后、同会话的全部有效
    // trace，得到一轮的完整消耗（起标题内部调用 + 主任务等全部算入）；无起点记录（如手动运行
    // --stop）→ 退化为单 trace（v2.19 行为）。
    // v2.21：快照按 sid 隔离读取——多会话并发时只聚合本会话的起点，不被其他会话覆盖。
    const prevSnap = loadSnapshot(sid) || {};
    const roundStart = prevSnap.lastUserMsgAt || 0;
    if (roundStart > 0) {
      const agg = aggregateRound(roundStart, sid, tf);
      if (agg) { ts = agg; tSame = false; }
    }
    if (!tSame) saveSnapshot({ file: tf, stat: ts, lastUserMsgAt: prevSnap.lastUserMsgAt || 0 }, sid);
    const modelShort = shortModelName(ts, pricing);
    const line = lineFor(ts, tSame, modelShort);
    const nmNote = ensureNewModelPricing(pricing, ts).note;
    writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: tSame, traceFile: tf, stat: ts, line, waited: !sameRound ? 0 : (tSame ? 'timeout' : 'ok'), payload: summarizePayload(stopPayload) });
    // 本条精确数据 → 弹 Windows 系统通知（两行：模型/耗时/余额 + 输入输出/缓存/费用；execFileSync 保证弹出；UI 内 systemMessage 通道实测不显示，故用 toast）
    if (!tSame) {
      const bal = balanceText(); // 自定义 API 的 DeepSeek 模型显示余额（60 秒缓存，每轮 toast 基本都拿实时数）
      showToast(toastLine1(ts, modelShort, periodNote(ts, pricing), bal), toastLine2(ts, pricing));
    }
    // systemMessage 保留：若未来平台支持即生效，不显示则无副作用；含新模型补录提示
    out({ hookSpecificOutput: { systemMessage: nmNote ? `${line}\n${nmNote}` : line } });
    return;
  }

  if (asHook) {
    // v2.20：--hook 在用户提交消息时运行——记录本轮起点时间戳（供 Stop 端聚合"一轮内所有 trace"），
    // 同时更新"上一轮"文件/统计。无论是否 sameRound 都要刷新起点。
    // v2.21：按 sid 拆分快照（多会话并发各自记录起点，互不覆盖）。
    saveSnapshot({ file: f, stat, lastUserMsgAt: Date.now() }, sid);
  } else if (!sameRound) {
    // 手动模式：新轮次展示该轮统计并记录快照（供后续轮次去重）
    saveSnapshot({ file: f, stat }, sid);
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
