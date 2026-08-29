#!/usr/bin/env node
// token-usage-tracker v2.75 (2026-08-29)
// v2.63：调试日志机制重构——废弃 TOKEN_TRACKER_DEBUG 环境变量开关 + poll 全量记录，改为「弹窗时自动记录」：
//   每次 showToast 无条件向 ~/.workbuddy/token-tracker-toast.log 追加一行 JSON 诊断（原因/sessionId/行数/稳定计数/compaction 状态等）。
// v2.62：compaction 检测由"行数减少>5"改为"扫描 transcript 末尾 30 行识别压缩标记（compactionMode 方案）"。
//   原因：该客户端 transcript 为 append-only，行数永不减少，旧方案在该客户端永远不触发、检测失效。
//   新方案：每轮 poll 用 readTailRawLines 读末尾 30 行，若最新压缩标记（role=user 且内容以
//   <conversation_history_summary> 或 <cb_summary> 开头）的 id 与上一轮不同（新标记）→ compactionMode=true、
//   重置稳定计数并暂停本轮收口；之后标记不再新增时进入正常 stableCount>=3 收口。旧 showToast 同步修复见 v2.61。
// v2.61：修复 showToast 回归——v2.59 的 compaction-fix 误将 execFileSync 改为 spawn(detached+unref)，
// 导致 watcher 退出时 PowerShell 子进程被提前终止、toast 丢失。本版回退为同步 execFileSync。
// token-tracker.js — 读取 WorkBuddy 最新 trace 的真实 token / 耗时。
// 数据来源：~/.workbuddy/traces/<pid>/trace_*.json 中的 trace.modelInfo / trace.duration
// （WorkBuddy 每轮 LLM 调用结束都会落盘成一个新 trace 文件，但 UI 不显示，这里把它读出来）。
//
// 用法：
//   node token-tracker.js            -> 输出单行纯文本（供技能指令手动贴到回复末尾）
//   node token-tracker.js --hook     -> 输出 {"hookSpecificOutput":{"additionalContext":"..."}}（供 UserPromptSubmit hook 注入）
//   node token-tracker.js --stop     -> 输出 {"hookSpecificOutput":{}}（Stop hook：回答结束后触发，
//                                       此时本轮 trace 已落盘，读到的就是【本条回答】的精确统计，
//                                       通过 Windows 弹窗 toast 呈现给用户；systemMessage 通道
//                                       WorkBuddy UI 不显示，v2.37 已移除该无效注入）
//
// 轮次语义（v2 修复）：
//   每个 trace_*.json = 一轮完整 LLM 调用，整轮结束后才落盘。因此"当前正在生成的一轮"在回答
//   结束前是读不到的，手动/--hook 模式输出的永远是【最新已完成轮次】的统计：
//     - 快照记录了"上次已统计的文件"；若最新文件 == 快照文件，说明这一轮已显示过（例如上一轮
//       末尾显示过、或 hook 刚记录过），本次输出标为「上一轮」且不重复更新快照。
//   --stop 模式特殊：Stop 事件在回答【结束后】触发，此时本轮 trace 已写完，最新文件就是本轮，
//   因此能拿到本条回答的精确消耗，通过 toast 弹窗呈现。
//   快照只作"轮次去重"用，不做总量 diff —— 直接展示该轮自身统计，天然免疫"换会话/上下文重置
//   导致总量变小"的负数问题。
//
// 测试：设置环境变量 WB_ROOT 可覆盖 ~/.workbuddy 根目录（供构造场景验证）。

const fs = require('fs');
const path = require('path');
const os = require('os');

const WB = process.env.WB_ROOT || path.join(os.homedir(), '.workbuddy');
const TRACE_DIR = path.join(WB, 'traces');

// ===== 联网功能开关（v2.30）=====
// 说明：本脚本默认「零密钥联网」——唯一的密钥型请求（DeepSeek 余额查询）默认关闭。
// 公开价表（OpenRouter）每日自动刷新/新模型补录默认开启，均无需密钥，失败自动降级为本地价。
// 三个分开关各自独立；ENABLE_NETWORK=false 时所有联网请求一律跳过（一键零联网）。
const ENABLE_NETWORK = true;        // 总开关：false = 全部联网功能关闭（含分开关）
const ENABLE_BALANCE_QUERY = false; // 分开关1：余额查询（携带 DeepSeek API key 请求官方接口，最敏感）
const ENABLE_PRICE_REFRESH = true;  // 分开关2：每日价格自动刷新（OpenRouter 公开价表，无需密钥）
const ENABLE_MODEL_LOOKUP = true;   // 分开关3：新模型价格自动补录（OpenRouter 公开价表，无需密钥）
// 余额查询安全性：开启后仅向官方 https://api.deepseek.com/user/balance 发送请求，密钥只通过
// Authorization: Bearer 头传给该官方域名，不会发给第三方；请求内容不含任何本地数据。
// 注意：余额查询默认关闭，需要时把 ENABLE_BALANCE_QUERY 改为 true（且 models.json 需配置 DeepSeek key）。
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
// v2.23（2026-08-12）：专家团/多子回合防重。同一用户轮次内多个子代理（如专家团 7 个专家）
// 各自完成都会触发一次 Stop，旧逻辑每次都弹 toast → 弹 N 次。
// v2.24（2026-08-12）：修正 v2.23 缺陷——v2.23 把弹窗延后到"用户下次提交（--hook）"，违背
// 技能"任务完成后及时弹出（可延迟几秒）"的要求。v2.24 改为 Stop 端 debounce：Stop 检测到多
// 子回合时写合并文件（含 at 时间戳）+ spawn 一个 detached 后台 watcher（--flush-delayed），
// watcher 延迟 DELAY_TOAST_MS 后复查：若期间又有新 trace 落盘（下一子回合在跑）→ 退出不弹，
// 下一次 Stop 会重写合并文件并起新 watcher；若期间无新 trace → 整轮汇总只弹一次并清除文件。
// 单 trace 普通轮次行为不变（Stop 立即弹本条）。--hook 端保留兜底：watcher 意外未弹（如应用
// 关闭）时用户下次提交补弹一次。
const DELAY_TOAST_MS = 6 * 1000; // debounce 窗口：最后一个子回合结束后延迟几秒弹汇总（技能要求"可延迟几秒"）
// v2.63：弹窗诊断日志——取代旧的 TOKEN_TRACKER_DEBUG 环境变量调试机制。
// 每次弹窗无条件向 ~/.workbuddy/token-tracker-toast.log 追加一行 JSON 诊断，便于事后排查弹窗原因/compaction 判定。
const TOAST_LOG_PATH = path.join(os.homedir(), '.workbuddy', 'token-tracker-toast.log');
const MAX_TOAST_LOG_SIZE = 5 * 1024 * 1024; // 5MB 轮清：超过即清空后重新追加，避免无限增长
// 最近一次 watcher 轮询状态快照；showToast 内部据此补全诊断字段。
// 循环外调用（估算/无记录/挂起聚合补弹）时可能为 null，writeToastLog 须容忍缺失字段。
let gLastWatchState = null;
// v2.63.1：最近一次弹窗所涉 trace 文件名（basename），供 writeToastLog 记录；获取不到则为 null。
let gLastTraceFile = null;
// v2.70：弹窗去重状态（仅内存、不落盘）——同文案 toast 在 TOAST_DEDUP_MS（10 分钟）内只弹一次，
// 防同一会话的 Stop 弹窗与 watcher 兜底弹窗重复出现。去重跳过时仍写诊断日志（writeToastLog 先行）。
let gLastToastText = null;
let gLastToastTs = 0;
const TOAST_DEDUP_MS = 10 * 60 * 1000;
function writeToastLog(reason, state) {
  try {
    try {
      const sz = fs.statSync(TOAST_LOG_PATH).size;
      if (sz > MAX_TOAST_LOG_SIZE) fs.writeFileSync(TOAST_LOG_PATH, '', 'utf8'); // 超阈值先清空
    } catch (e) { /* 文件不存在 / 无权限读取：忽略，直接走下方追加 */ }
    const st = state || {};
    const rec = {
      ts: new Date().toISOString(),
      reason: reason || 'unknown',
      sessionId: st.sessionId != null ? st.sessionId : null,
      lineCount: st.lineCount != null ? st.lineCount : null,
      stableCount: st.stableCount != null ? st.stableCount : null,
      compactionSuspected: st.compactionSuspected != null ? st.compactionSuspected : null,
      compactionMode: st.compactionMode != null ? st.compactionMode : null,
      lastMarkerId: st.lastMarkerId != null ? st.lastMarkerId : null,
      tailRawPrefix: String(st.tailRawPrefix || '').slice(0, 80),
      lastTailRawPrefix: String(st.lastTailRawPrefix || '').slice(0, 80),
      pendingSubCount: st.pendingSubCount != null ? st.pendingSubCount : null,
      hasNewTail: st.hasNewTail != null ? st.hasNewTail : null,
      watchStartTime: st.watchStartTime != null ? st.watchStartTime : null,
      traceFile: st.traceFile != null ? st.traceFile : (gLastTraceFile != null ? gLastTraceFile : null),
      toastText: st.toastText != null ? String(st.toastText).slice(0, 200) : null,
    };
    fs.appendFileSync(TOAST_LOG_PATH, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { /* 日志写入失败：绝不阻塞主逻辑 */ }
}
function coalescePath(sid) {
  if (!sid) return path.join(SNAP_DIR, '.coalesce.json');
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? path.join(SNAP_DIR, `.coalesce-${safe}.json`) : path.join(SNAP_DIR, '.coalesce.json');
}
function readCoalesce(sid) {
  try {
    const d = JSON.parse(fs.readFileSync(coalescePath(sid), 'utf-8'));
    return (d && d.agg) ? d.agg : null;
  } catch (e) { return null; }
}
function readCoalesceInfo(sid) {
  try { return JSON.parse(fs.readFileSync(coalescePath(sid), 'utf-8')); }
  catch (e) { return null; }
}
function writeCoalesce(sid, agg, meta) {
  const payload = { at: Date.now(), agg };
  if (typeof meta === 'string') payload.traceFile = meta; // 兼容旧调用（传 traceFile 字符串）
  else if (meta && typeof meta === 'object') {
    if (meta.traceFile) payload.traceFile = meta.traceFile;
    if (meta.tsPath) payload.tsPath = meta.tsPath;         // v2.25：transcript 数据源（watcher 复查用）
    if (meta.roundStart) payload.roundStart = meta.roundStart;
    if (meta.byModel) payload.byModel = meta.byModel;       // v2.39：专家团按模型分桶明细（watcher 记账用）
    if (meta.terminalError) payload.terminalError = meta.terminalError; // v2.57：主模型终态错误标记（429/5xx/timeout），供 watcher 首查感知
  }
  try { fs.writeFileSync(coalescePath(sid), JSON.stringify(payload)); }
  catch (e) { process.stderr.write(`[token-tracker] 合并文件写入失败: ${e.message}\n`); }
}
function clearCoalesce(sid) {
  try { fs.unlinkSync(coalescePath(sid)); } catch (e) { /* 不存在则忽略 */ }
}
// 多子回合时起一个 detached 后台 watcher：延迟 DELAY_TOAST_MS 后复查，无新 trace 则弹汇总。
// 父进程是 Stop hook（同步短生命周期），必须 unref 让 watcher 独立存活；Windows 下 detached
// + stdio:'ignore' + windowsHide 避免闪黑窗。
function spawnFlushWatcher(sid) {
  try {
    const cp = require('child_process');
    const child = cp.spawn(process.execPath, [__filename, '--flush-delayed', sid || ''], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.unref();
  } catch (e) { process.stderr.write(`[token-tracker] 延迟弹窗 watcher 启动失败: ${e.message}\n`); }
}
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const PRICING_LOCK_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.pricing.lock'); // 修复6：pricing 并发写锁
const MODELS_CFG = path.join(WB, 'models.json'); // 自定义 API 配置（含 apiKey），仅 DeepSeek 官方模型启用余额显示
const BALANCE_CACHE = path.join(WB, 'skills', 'token-usage-tracker', '.balance.json');
const DAILY_USAGE_FILE = path.join(WB, 'skills', 'token-usage-tracker', 'daily-usage.json'); // v2.39：每日账本（按本地日期分桶，{日期:{models:{模型:{in,out,cached,total,cost}}, total:{...}}}，长期保存不裁剪）
// v2.59：写入 daily-usage.json 顶层的「读取方指令」，AI 直接读文件即可看到展示要求，无需翻技能说明。
// 仅作读取参考，展示给用户时务必剥离本字段（见 normalizeDailyUsage 跳过逻辑）。
const DAILY_INSTRUCTIONS = {
  _comment: '本字段仅供读取方（AI助手）参考，向用户展示时请勿包含本字段',
  show_table: '向用户展示以上账本时，必须使用 Markdown 表格原文（完整 7 列：模型、输入、输出、缓存、缓存命中、总 token、金额），不要手排、不要转纯文本、不要汇总',
  number_format: '数字用中文简写展示，如 10000 显示为 1万，1000000 显示为 100万，保留合适精度',
  currency: '成本字段 cost 单位为人民币，展示时使用 ¥ 符号，无需换算'
};
const LEDGER_WATERMARK_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.ledger-watermark.json'); // v2.50：增量记账水位线（{sid:{main:已记账主transcript行数, subs:{子代理文件名:已记账行数}}}）
const BALANCE_TTL_MS = 15 * 1000; // 余额缓存 15 秒（v2.18 从 60s 压短：用户要求实时，接口实测 300ms 级；正常轮询间隔 >15s 即每轮拿实时数，15s 内连发才复用）
// 积分/自定义 API 模式识别（v2.10）：官方文档证实内置模型列表就有 deepseek-v4-flash（与自定义 id 同名），
// trace/hook payload/transcript 无模式标记，进程级探测（tasklist/wmic/netstat）被本机安全策略禁用——
// "密钥是否在用"信号抓不到。用户认可方案 = **默认不显示，检测到余额变化才显示**：
// 余额会变 = DeepSeek 账户在真实消耗 = 自定义 API 模式（或其他处使用同一 key），这正是"有密钥才有消耗"的等价信号；
// 积分模式余额恒定 → 永不显示。
const BALANCE_HISTORY_MAX = 20;        // 缓存里保留的余额观测条数（用于与上次对比判定"是否变化"）

// ===== v2.66 通用工具：模型名归一化 + 文件锁 + 原子写 =====
// 账本文件曾损坏 → 本轮禁止写回空对象以免覆盖历史（损坏文件已备份为 .corrupt）
let gDailyCorrupt = false;

// 模型名归一化：去首尾空格、连续空格合并为单空格、统一小写（兼容 "GPT-4 " / "gpt-4" 等变体）
function normalizeModelName(n) {
  return String(n == null ? '' : n).replace(/\s+/g, ' ').trim().toLowerCase();
}

// v2.67：模型名归一化的唯一口径 = normalizeModelName（上面 182 行），即「统一小写 + 去首尾空格 +
// 连续空格合并为单空格」三件事，不做任何字符等价替换。
// 已删除 normalizeModelKey（原先把 "." 视为 "-"，会让 glm-5.2 与 glm-5-2 互为同一模型）——
// 按"一个字符不同就是不同模型"的要求，这类等价替换一律取消。

// 显式别名表：仅限人工逐一核实过的等价名称（如厂商改名、历史遗留 key）。
// 当前为空表——需要时手动添加，格式：'实际使用的名字': 'pricing.json 里的 key'。
// 注意：这里每加一条就等价于放行一次"不同名同价"，务必人工核实二者确实是同一模型且同价后再加。
const MODEL_ALIASES = {};

// 通用文件锁（复用 watch 锁思路：原子 openSync 'wx' + TTL + pid 存活探测）。
// 返回 { ok, result, skipped }。acquire 失败（被其他进程持有）→ 重试 retries 次，仍失败则 skipped
// （调用方应跳过写，避免覆盖）。
// v2.68 修复4：**抢占前必须确认持有者已死**。
//   原逻辑只看"锁是否超过 TTL(30s)"就直接接管，会把仍在工作（只是慢）的持有者的锁抢走，
//   导致两个进程同时认为自己持锁 → 并发写 → 丢更新（实测：伪造 at=40s 前、pid 存活的锁会被抢）。
//   现规则（按优先级）：
//     1) 锁不存在 → 直接创建并持有；
//     2) 能解析出 pid 且该 pid 仍存活 → **绝不抢占**，返回 false 让上层重试；
//     3) pid 已死（进程被杀/崩溃残留）→ 立即接管（不看 TTL，快速自愈）；
//     4) 解析不出 pid（锁文件为空/损坏）→ 退化为按 TTL 判定，超时后才接管。
//   死锁防护：重试次数有上限（retries×retryDelay，默认 5s），到点返回 skipped 而非无限等待；
//   全程无嵌套加锁（4 个调用点互不嵌套），不会自锁。
function withFileLock(lockPath, fn, opts) {
  opts = opts || {};
  const ttl = opts.ttl || 300000; // v2.68：30s → 300s（只用于"解析不出 pid"的退化分支）
  const retries = opts.retries != null ? opts.retries : 50;
  const retryDelay = opts.retryDelay || 100;
  const myPid = process.pid;
  const tryCreate = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid }));
      fs.closeSync(fd);
      return true;
    } catch (e) { return false; }
  };
  const pidAlive = (pid) => {
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (e2) { if (e2.code === 'ESRCH') alive = false; else if (e2.code === 'EPERM') alive = true; else alive = true; }
    return alive;
  };
  const acquire = () => {
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (e) {}
    // 1) 锁不存在 → 创建
    if (tryCreate()) return true;
    let mine = null;
    try { mine = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch (e) { mine = null; }
    const pid = mine && Number(mine.pid);
    if (pid && pid > 0 && Number.isFinite(pid)) {
      // 2)(3) 有 pid → 只认存活与否，与 TTL 无关
      if (pidAlive(pid)) return false;     // 持有者还活着 → 不抢，等下一轮重试
      // 持有者已死 → 落到下面统一接管
    } else {
      // 4) 解析不出 pid → 退化为 TTL 判定，未超时则保守等待
      const fresh = mine && (Date.now() - (mine.at || 0) < ttl);
      if (fresh) return false;
    }
    try { fs.unlinkSync(lockPath); } catch (e2) {}
    return tryCreate();
  };
  let got = false;
  for (let i = 0; i < retries; i++) {
    got = acquire();
    if (got) break;
    const end = Date.now() + retryDelay;
    while (Date.now() < end) { /* 短暂停，避免引入 timer 依赖 */ }
  }
  if (!got) return { ok: false, skipped: true };
  try {
    return { ok: true, result: fn() };
  } finally {
    try {
      const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (o && o.pid === myPid) fs.unlinkSync(lockPath);
    } catch (e2) {}
  }
}

// 账本原子写（无锁，由调用方负责加锁或单次调用）。写临时文件成功后 rename 覆盖，写失败保留原文件。
// v2.68 修复1：返回 true/false 表示写成功/失败——调用方（incrementalRecord）据此决定是否推进水位线，
// 否则记账失败而水位线照推进，这部分用量就再也不会被补记（永久丢失，且只留一行 stderr）。
function saveDailyUsageRaw(d) {
  const tmp = DAILY_USAGE_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(DAILY_USAGE_FILE), { recursive: true });
    const merged = Object.assign({ _instructions: DAILY_INSTRUCTIONS }, d);
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, DAILY_USAGE_FILE);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    process.stderr.write(`[token-tracker] 账本写入失败: ${e.message}\n`);
    return false;
  }
}

// pricing 原子写（带锁，跨进程协调 token-tracker.js 与 refresh-prices.js 的并发写）。
function savePricing(pricing) {
  const lockPath = PRICING + '.lock';
  const r = withFileLock(lockPath, () => {
    const tmp = PRICING + '.tmp';
    try {
      fs.mkdirSync(path.dirname(PRICING), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(pricing, null, 2) + '\n');
      fs.renameSync(tmp, PRICING);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      process.stderr.write(`[token-tracker] pricing 写入失败: ${e.message}\n`);
      return false;
    }
  }, { ttl: 300000, retries: 50 });
  if (!r.ok) process.stderr.write(`[token-tracker] pricing 锁获取失败，写入跳过（避免并发覆盖）\n`);
  return r.ok ? r.result : false;
}

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
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const r = totalSec % 60;
  // v2.34：超 1 小时显示 `1h 59m 59s`（此前 `119m 59s` 不直观；宽度不变，不影响布局）
  if (h > 0) return `${h}h ${m}m ${r}s`;
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

// v2.25（2026-08-12）：transcript 数据源——专家团/Agent 子代理的调用不落盘 traces，但
// transcript(jsonl) 的 providerData.usage 完整记录每次模型调用（主会话 + subagents/*.jsonl）。
// usage 字段为 camelCase：{requests, inputTokens, outputTokens, totalTokens, inputTokensDetails:[{cached_tokens}]}
function extractUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const inT = u.inputTokens || u.input_tokens || u.prompt_tokens || 0;
  const outT = u.outputTokens || u.output_tokens || u.completion_tokens || 0;
  if (!inT && !outT) return null;
  let cached = 0;
  const det = u.inputTokensDetails || u.prompt_tokens_details || null;
  if (Array.isArray(det)) { for (const d of det) { if (d && d.cached_tokens) cached += d.cached_tokens; } }
  else if (det && typeof det === 'object') cached = det.cached_tokens || 0;
  return { in: inT, out: outT, cached };
}

// v2.57（第一阶段修复）：从 transcript 整行提取 usage，兼容三个实际存在的数据位点：
//   providerData.usage（camelCase，主路径）、providerData.rawUsage（实测承载 raw 计费 usage，
//   含 snake_case 的 total_tokens 等）、message.usage（function_call 行的 usage 有时只落在这里）。
// 不改变现有增量记账体系（记账仍以 providerData.usage 为主，raw/message 作为兼容补充），
// 只修复"usage 只存在于 rawUsage/message.usage 时提取不到"的兼容性问题（本次 429 会话实测：
// 大量 hy3 function_call 行 usage 只在 rawUsage，主路径 providerData.usage 为 null）。
function extractUsageFromRow(r) {
  if (!r || typeof r !== 'object') return null;
  const pd = r.providerData || {};
  return extractUsage(pd.usage) || extractUsage(pd.rawUsage) || extractUsage(r.message && r.message.usage) || null;
}

// v2.57（第一阶段修复）：主模型终态错误判定——仅当有"明确的错误证据"才算 terminal-error。
// 判据（本次 Bug 会话实测）：末行 role=assistant + status=incomplete 本身不算终态
// （思考途中被中断的 incomplete 无 error 是常态，绝不能误弹）；
// 必须结合 providerData.error 存在且 status 命中 429 / 5xx / timeout / 明确的 error 信息，
// 或 role=assistant 且 status=incomplete + error.status 为上述之一。
// 注意：status=incomplete 单独出现（无 error）返回 false（合法未知/被中断，等待后续行）。
function terminalErrorFromRow(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.role !== 'assistant' && r.type !== 'message') return null; // 只看主模型末行
  const pd = r.providerData || {};
  const err = (pd && pd.error) || (r.error) || null;
  if (!err || typeof err !== 'object') return null;
  const s = String(err.status || err.code || '').toLowerCase();
  if (s.startsWith('429') || /^5\d\d/.test(s)) return `http-${s}`;
  if (s === 'timeout' || /timeout|rate.?limit|overload|server.?error|internal.?error|quota/i.test(String(err.type || err.message || ''))) return s || 'error';
  return null;
}
// v2.70：上下文超长前兆检测——模型返回 400 "input length too long" 等错误后，系统随即启动
// contextSummary 压缩，压缩期间 transcript 不写入（压缩标记要等压缩完成后才写入，watcher 检测不到）。
// 若 watcher 按"末行冻结 3 帧"误判回合结束会提前弹窗（本 Bug 根因）。
// 判据：读取 transcript 末尾 N 行（默认 5），存在 role=assistant 且 status=incomplete 且
// 错误/消息内容含超长关键词（input length too long / context length / too many tokens /
// context_window / maximum context）的行 → 判定"上下文超长，压缩即将发生或正在发生"。
// contextOverflowOmenTs 返回末尾 N 行内"最新一条前兆行"的 timestamp（无前兆返回 null）——
// watcher 用它做"新前兆"守卫：同一场停滞（末行冻结无新行）不会在超时/恢复后每轮重复进入等待窗口。
function contextOverflowOmenTs(tsPath, n) {
  const rawLines = readTailRawLines(tsPath, n || 5);
  let latestTs = null;
  for (const raw of rawLines) {
    let r;
    try { r = JSON.parse(raw); } catch (e) { continue; }
    if (!r || typeof r !== 'object') continue;
    if (r.role !== 'assistant' || r.status !== 'incomplete') continue;
    const texts = [];
    const err = (r.providerData && r.providerData.error) || r.error || null;
    if (typeof err === 'string') texts.push(err);
    else if (err && typeof err === 'object') {
      if (err.message != null) texts.push(String(err.message));
      if (err.type != null) texts.push(String(err.type));
      if (err.code != null) texts.push(String(err.code));
    }
    const msg = r.message;
    if (msg && typeof msg === 'object') {
      if (typeof msg.error === 'string') texts.push(msg.error);
      const mc = msg.content;
      if (typeof mc === 'string') texts.push(mc);
      else if (Array.isArray(mc)) texts.push(mc.map((x) => (x && x.text) || '').join(''));
    }
    if (typeof r.content === 'string') texts.push(r.content);
    else if (Array.isArray(r.content)) texts.push(r.content.map((x) => (x && x.text) || '').join(''));
    // 关键词允许下划线/连字符/空格分隔（如 input_length_too_long / input-length-too-long）
    if (/input\s*[-_ ]*length\s+too\s+long|context\s*[-_ ]*length|too\s*[-_ ]*many\s*tokens|context\s*[-_ ]*window|maximum\s*context/i.test(texts.join('\n'))) {
      const ts = Number(r.timestamp) || 0;
      if (latestTs === null || ts > latestTs) latestTs = ts;
    }
  }
  return latestTs;
}
function contextOverflowOmen(tsPath, n) {
  return contextOverflowOmenTs(tsPath, n) !== null;
}
// 主 transcript 末行是否为明确的终态错误（供 watcher / Stop 判定复用同一口径）。
function terminalError(tsPath) {
  const r = lastTranscLine(tsPath);
  if (!r) return null;
  const te = terminalErrorFromRow(r);
  if (te) return te;
  // 兜底顺带排查：末行前 1 行（Stop 触发时 429 末行可能还没完全落盘，但前一行已是错误行）
  if (r.type !== 'message') {
    const rows = readTranscLines(tsPath);
    for (let i = rows.length - 1; i >= 0; i--) {
      const te2 = terminalErrorFromRow(rows[i]);
      if (te2) return te2;
    }
  }
  return null;
}

// 从 Stop payload 拿主 transcript 路径（payload.transcript_path；兼容 .json / 实际落盘 .jsonl）
function transcriptPathFromPayload(payloadRaw) {
  try {
    const p = JSON.parse(payloadRaw);
    let tp = p && p.transcript_path ? String(p.transcript_path) : '';
    if (!tp) return null;
    if (/\.jsonl?$/.test(tp)) { /* 已是 json/jsonl */ }
    else if (tp.endsWith('.json')) tp = tp + 'l';
    if (!fs.existsSync(tp) && tp.endsWith('l')) tp = tp.slice(0, -1); // .jsonl 不存在回退 .json
    return fs.existsSync(tp) ? tp : null;
  } catch (e) { return null; }
}

// 读 jsonl 全部行（容错跳过损坏/半写行）
function readTranscLines(tsPath) {
  const rows = [];
  let raw;
  try { raw = fs.readFileSync(tsPath, 'utf-8'); } catch (e) { return rows; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* 半写行跳过 */ }
  }
  return rows;
}

// 解析一段 transcript 文本为行数组（容错口径与 readTranscLines 完全一致：跳过空行与半写行）
function parseTranscChunk(chunk) {
  const rows = [];
  for (const line of chunk.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* 半写行跳过 */ }
  }
  return rows;
}

// v2.69 性能：只解析"水位线之后的新行"（incrementalRecord 专用，不改任何统计口径）。
// 背景：原实现每次 Stop 都 readTranscLines 全量 JSON.parse（实测 100MB/15476 行：399ms + 295MB 峰值）。
// 等价性依据（实测 44 个 transcript，最大 100MB/15476 行）：文件总以 '\n' 结尾、无空行、无可解析失败行，
// 因此"已解析行数" ≡ "原始行号"，定位第 fromLine 行后取后缀，与"解析后按下标 slice"完全等价。
//
// 用字节缓冲而非字符串（实测，100MB/15476 行、水位线 15466）：
//   readFileSync(utf-8) 全量解码 = 233.8ms ← 真正的瓶颈；indexOf 定位仅 3.8ms；解析 10 行仅 3.4ms
//   readFileSync(Buffer)         =  23.7ms（不解码，1/10）
// 故：整文件一次性读入 Buffer（仍是 fs.readFileSync 全量读入，非流式），按字节 indexOf(0x0A) 定位，
// 只对尾部小块做 utf-8 解码 + split + JSON.parse。
// 安全性：UTF-8 的续字节恒 >= 0x80，0x0A 只可能作为换行符出现，绝不会落在多字节序列内部，
// 因此在换行边界按字节切分永远落在合法 UTF-8 边界上，解码结果与整串解码再取后缀逐字符相同。
//
// 返回 { rows, totalLines }：
//   rows       —— 第 fromLine 行（含，行号从 0 开始）之后解析成功的行，即 slice(fromLine) 的等价物
//   totalLines —— fromLine + rows.length；行数只按"解析成功"推进，半写行不会被越过，下一轮仍会补记
//                 （与旧实现 mainRows.length 同口径；读文件失败时返回 0，交由 Math.max 保护水位线）
function readTranscLinesFrom(tsPath, fromLine) {
  let buf;
  try { buf = fs.readFileSync(tsPath); } catch (e) { return { rows: [], totalLines: 0 }; }
  const start = fromLine > 0 ? fromLine : 0;
  if (start === 0) {
    // 水位线为 0（首次记账）→ 全量解析，行为与 readTranscLines 一致
    const rows = parseTranscChunk(buf.toString('utf-8'));
    return { rows, totalLines: rows.length };
  }
  // 定位到第 start 行的起始位置：跳过 start 个 '\n'（0x0A）
  let off = 0;
  for (let i = 0; i < start; i++) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) { off = buf.length; break; } // 文件被截断（行数 < 水位线）→ 无新行，水位线不前进
    off = nl + 1;
  }
  const rows = parseTranscChunk(buf.toString('utf-8', off));
  return { rows, totalLines: start + rows.length };
}

// 聚合 transcript 中 timestamp > fromTs 的全部调用（按 messageId/conversationRequestId 去重）
function aggregateTranscLines(rows, fromTs) {
  const seen = new Set();
  let inSum = 0, outSum = 0, cachedSum = 0;
  let firstTs = null, lastTs = 0, model = '', count = 0;
  for (const r of rows) {
    const ts = r.timestamp;
    if (!(typeof ts === 'number') || ts <= fromTs) continue;
    const pd = r.providerData || {};
    // v2.66：统一用 extractUsageFromRow，兼容 pd.usage / pd.rawUsage / message.usage
    const u = extractUsageFromRow(r);
    if (!u) continue;
    const key = pd.messageId || pd.conversationRequestId || r.id || (r.type + ':' + ts);
    if (seen.has(key)) continue;
    seen.add(key);
    inSum += u.in; outSum += u.out; cachedSum += u.cached;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    if (!model) model = pd.model || pd.requestModelId || '';
    count++;
  }
  if (!count) return null;
  return { in: inSum, out: outSum, cached: cachedSum, total: inSum + outSum, durMs: Math.max(0, lastTs - (firstTs || lastTs)), model, firstTs, lastTs, count };
}

// v2.69：estimateInterrupted 的增量版包装（只改解析范围，不改统计口径）。
// 背景：estimateInterrupted 估算"被中断调用"的输入基数时，会**从当前行往前回溯最近一次完整 usage**
// （for j = i-1 … 0）。只解析新行后，这个回溯可能越过水位线进入历史行 —— 直接传新行会让基数变成 0，
// 导致统计结果与全量解析不一致（已由 verify-v269 实测复现：合成/真实 transcript 均有命中）。
// 保证逐位一致的做法：
//   新行内回溯就能找到 usage  → 直接估（快路径，绝大多数轮次，回溯结果必然与全量解析相同：
//     新行是全文的后缀，能找到即说明"最近一次 usage"就在水位线之后，与全量扫描同解）
//   新行内回溯找不到 usage    → 说明基数在历史行里 → 回退全量解析，用旧口径 (fullRows, watermark) 估算
// 只有第二种情况才多付一次全量解析，且这种情况极罕见（见 verify-v269 的回退率统计）。
function estimateInterruptedInc(tsPath, rows, watermark) {
  if (!rows || !rows.length) return {};
  let needHistory = false;
  for (let i = 0; i < rows.length && !needHistory; i++) {
    const r = rows[i];
    if (r.type !== 'reasoning') continue;
    const pd = r.providerData || {};
    if (r.status !== 'incomplete' && !pd.isPartialAborted) continue;
    if (!(pd.conversationRequestId || pd.messageId)) continue;
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      const u = extractUsageFromRow(rows[j]);
      if (u && u.in > 0) { found = true; break; }
    }
    if (!found) needHistory = true;
  }
  return needHistory ? estimateInterrupted(readTranscLines(tsPath), watermark) : estimateInterrupted(rows, 0);
}

// 子代理 transcript 目录：主 transcript 同级 <session名>/subagents/（session 名 = 主文件去扩展名）
function subagentsDirFromTranscript(tsPath) {
  const base = path.basename(tsPath).replace(/\.jsonl?$/, '');
  return path.join(path.dirname(tsPath), base, 'subagents');
}

// v2.39：按模型分桶聚合 transcript 行（与 aggregateTranscLines 完全一致的去重口径），
// 供每日账本"分模型明细"记账用。返回 { "<模型名>": {in,out,cached,total} }。
function perModelFromRows(rows, fromTs) {
  const seen = new Set();
  const byModel = {};
  for (const r of rows) {
    const ts = r.timestamp;
    if (!(typeof ts === 'number') || ts <= fromTs) continue;
    const pd = r.providerData || {};
    // v2.66：统一用 extractUsageFromRow，兼容 pd.usage / pd.rawUsage / message.usage 三处落点
    const u = extractUsageFromRow(r);
    if (!u) continue;
    const key = pd.messageId || pd.conversationRequestId || r.id || (r.type + ':' + ts);
    if (seen.has(key)) continue;
    seen.add(key);
    // v2.66：模型名归一化（去空格/统一小写），避免同模型因大小写/空格拆成多条
    const name = normalizeModelName(pd.model || pd.requestModelId || 'unknown');
    const b = byModel[name] || (byModel[name] = { in: 0, out: 0, cached: 0, total: 0 });
    b.in += u.in; b.out += u.out; b.cached += u.cached; b.total += u.in + u.out;
  }
  return byModel;
}
// v2.52：中断补偿——检测 status=incomplete / isPartialAborted 且 usage=0 的被中断调用，
// 估算其 token 补进账本。依据（真实数据实证）：被中断的调用 WorkBuddy 不落盘 usage（transcript
// 无 usage、trace 无记录），但云端照常计费（输入上下文是大头，占 98%+；思考输出是小头）。
// 估算方法：输入=同会话最近一次完整落盘的 input/cached（上下文连续，误差 <5%）；输出=reasoning
// 文本长度（中文 1字≈1.5 token，英文 4字符≈1 token）。只认 reasoning 行为被中断调用的起点（一个
// 被中断调用只有一次 reasoning），用 conversationRequestId 天然去重（每个 cid 唯一）。
function estimateInterrupted(fullRows, newStart, fromTs) {
  const byModel = {};
  for (let i = newStart; i < fullRows.length; i++) {
    const r = fullRows[i];
    if (fromTs && !(Number(r.timestamp) > fromTs)) continue; // 可选时间戳过滤（弹窗场景：只估本轮）
    if (r.type !== 'reasoning') continue;
    const pd = r.providerData || {};
    if (r.status !== 'incomplete' && !pd.isPartialAborted) continue;
    const cid = pd.conversationRequestId || pd.messageId;
    if (!cid) continue;
    // v2.66：模型名归一化（与 perModelFromRows 一致）
    const model = normalizeModelName(pd.model || pd.requestModelId || 'unknown');
    // 估算输入：往前找最近一个有 usage 的调用（同会话上下文连续，量级接近）
    let estIn = 0, estCached = 0;
    for (let j = i - 1; j >= 0; j--) {
      const pu = extractUsageFromRow(fullRows[j]);
      if (pu && pu.in > 0) { estIn = pu.in; estCached = pu.cached || 0; break; }
    }
    // 估算输出：reasoning 文本长度（中英文混合系数）
    const c = Array.isArray(r.content) ? r.content.map((x) => (x && x.text) || '').join('') : (typeof r.content === 'string' ? r.content : '');
    const cjk = (c.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const other = c.length - cjk;
    const estOut = Math.round(cjk * 1.5 + other / 4);
    if (!estIn && !estOut) continue;
    const b = byModel[model] || (byModel[model] = { in: 0, out: 0, cached: 0, total: 0 });
    b.in += estIn; b.out += estOut; b.cached += estCached; b.total += estIn + estOut;
  }
  return byModel;
}

// v2.39：主 transcript + 子代理（与 aggregateTranscript 相同口径）按模型分桶
function aggregatePerModel(tsPath, roundStartMs) {
  const merged = perModelFromRows(readTranscLines(tsPath), roundStartMs);
  const subDir = subagentsDirFromTranscript(tsPath);
  if (fs.existsSync(subDir)) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!/^agent-.*\.jsonl$/.test(f)) continue;
        const fp = path.join(subDir, f);
        try { if (fs.statSync(fp).mtimeMs <= roundStartMs) continue; } catch (e) { continue; } // 本轮之前创建的排除
        const sub = perModelFromRows(readTranscLines(fp), 0); // 子代理文件本身只属于本次专家团
        for (const [n, b] of Object.entries(sub)) {
          if (merged[n]) { merged[n].in += b.in; merged[n].out += b.out; merged[n].cached += b.cached; merged[n].total += b.total; }
          else merged[n] = b;
        }
      }
    } catch (e) { /* subagents 读取失败：忽略子代理部分 */ }
  }
  return merged;
}

// v2.28：检测主 transcript 本轮（roundStart 之后）是否有专家团活动（Agent/Team 工具调用）。
// 专家团是异步 spawn——子代理文件可能比主理人的 Agent 调用晚 10~20s 才落盘，中途 Stop 聚合时
// subCount=0 会被误判成"普通轮"立即弹 toast（实测 48 秒专家团弹 3 次 = 中途 2 次误判 + 最终 1 次）。
// 判定专家团不能只看 subCount，还要看主 transcript 本轮是否出现 TeamCreate/Agent/SendMessage(teammate)。
function hasTeamActivity(tsPath, roundStartMs) {
  try {
    for (const r of readTranscLines(tsPath)) {
      if (r.type !== 'function_call') continue;
      const ts = r.timestamp;
      if (!(typeof ts === 'number') || ts <= roundStartMs) continue;
      const name = String(r.name || '');
      if (name === 'Agent' || name === 'TeamCreate' || name === 'TeamDelete') return true;
      if (name === 'DeferExecuteTool' || name === 'SendMessage') {
        const s = JSON.stringify(r.arguments || r.input || '');
        if (/Team(Create|Delete)|team_name|subagent_type|teammate|recipient/.test(s)) return true;
      }
    }
  } catch (e) { /* 读取失败：当作无团队活动 */ }
  return false;
}

// 聚合本轮（roundStartMs 之后）主 transcript + 子代理的全部调用。
// 子代理文件按 mtime > roundStartMs 归属本轮（一次专家团一批新文件，不跨轮复用）。
function aggregateTranscript(tsPath, roundStartMs) {
  const main = aggregateTranscLines(readTranscLines(tsPath), roundStartMs);
  const subDir = subagentsDirFromTranscript(tsPath);
  let subRows = [];
  if (fs.existsSync(subDir)) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!/^agent-.*\.jsonl$/.test(f)) continue;
        const fp = path.join(subDir, f);
        let mt = 0;
        try { mt = fs.statSync(fp).mtimeMs; } catch (e) { continue; }
        if (mt <= roundStartMs) continue; // 本轮之前创建的子代理（上一轮专家团）→ 排除
        subRows = subRows.concat(readTranscLines(fp));
      }
    } catch (e) { /* subagents 读取失败：忽略子代理部分 */ }
  }
  const sub = aggregateTranscLines(subRows, 0); // 子代理文件本身只属于本次专家团
  if (!main && !sub) return null;
  const res = {
    in: (main ? main.in : 0) + (sub ? sub.in : 0),
    out: (main ? main.out : 0) + (sub ? sub.out : 0),
    cached: (main ? main.cached : 0) + (sub ? sub.cached : 0),
    model: (sub && sub.model) || (main && main.model) || '',
    count: (main ? main.count : 0) + (sub ? sub.count : 0),
    subCount: sub ? sub.count : 0,
    // v2.28：本轮主 transcript 是否有专家团活动（子代理文件未落盘也能识别）
    teamActive: hasTeamActivity(tsPath, roundStartMs),
  };
  res.total = res.in + res.out;
  const firstTs = Math.min(...[main && main.firstTs, sub && sub.firstTs].filter(Boolean));
  const lastTs = Math.max(main ? main.lastTs : 0, sub ? sub.lastTs : 0);
  res.durMs = Math.max(0, lastTs - (firstTs || lastTs));
  return res;
}

// watcher 用：roundStart 后是否有 timestamp > sinceMs 的新调用（主 transcript）或子代理文件 mtime > sinceMs
function hasNewTranscSince(tsPath, roundStartMs, sinceMs) {
  if (roundStartMs <= 0 || !tsPath) return false;
  for (const r of readTranscLines(tsPath)) {
    const ts = r.timestamp;
    if (typeof ts === 'number' && ts > roundStartMs && ts > sinceMs && extractUsage((r.providerData || {}).usage)) return true;
  }
  const subDir = subagentsDirFromTranscript(tsPath);
  if (fs.existsSync(subDir)) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!/^agent-.*\.jsonl$/.test(f)) continue;
        try { if (fs.statSync(path.join(subDir, f)).mtimeMs > sinceMs) return true; } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  }
  return false;
}

// v2.40：读主 transcript 最后几行，判断主模型当前状态——用于 watcher 决定"专家团是否真正结束"。
// 业界标准（Anthropic stop_reason 语义）：模型输出"无工具调用的最终回复" = end_turn = 本轮结束；
// 而"最后一行是工具调用/子代理结果回传" = 主模型还在派活/等结果 = 绝不能弹。
// 返回：'busy'（主模型还在工作，绝不弹）| 'final'（出现候选最终回复）| 'unknown'（异常/空）
const TEAM_CALL_RE = /^(Agent|TeamCreate|TeamDelete|SendMessage|TaskOutput)$/;
function lastTranscLine(tsPath) {
  try {
    const fd = fs.openSync(tsPath, 'r');
    const stat = fs.fstatSync(fd);
    const sz = stat.size;
    if (sz <= 0) { fs.closeSync(fd); return null; }
    const buf = Buffer.alloc(sz > 8192 ? 8192 : sz);
    fs.readSync(fd, buf, 0, buf.length, sz - buf.length);
    fs.closeSync(fd);
    const tail = buf.toString('utf-8').split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = tail.length - 1; i >= 0; i--) {
      try { return JSON.parse(tail[i]); } catch (e) { /* 半写行：跳过往前找 */ }
    }
  } catch (e) { /* 文件不可读 */ }
  return null;
}
// v2.59/P0-1：读 transcript 文件【原始末行】（不做 JSON.parse），用于识别 compaction 重写中的
// transient unknown。compaction 是覆盖末行的截断重写，原始末行会持续抖动；真结束静默时末行不变。
function readTailRaw(tsPath) {
  try {
    const fd = fs.openSync(tsPath, 'r');
    const sz = fs.fstatSync(fd).size;
    if (sz <= 0) { fs.closeSync(fd); return ''; }
    const buf = Buffer.alloc(sz > 4096 ? 4096 : sz);
    fs.readSync(fd, buf, 0, buf.length, sz - buf.length);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  } catch (e) { return ''; }
}
// v2.62/compactionMode：读 transcript 文件【原始末 n 行】（不做 JSON.parse）。用于扫描末尾窗口内的
// 压缩标记（append-only transcript 行数永不减少，旧 lineCount 检测方案失效）。n 行可能较长，故取末尾
// 64KB 足以覆盖；返回按文件顺序（旧→新）的最后 n 条非空行。
function readTailRawLines(tsPath, n) {
  try {
    const fd = fs.openSync(tsPath, 'r');
    const sz = fs.fstatSync(fd).size;
    if (sz <= 0) { fs.closeSync(fd); return []; }
    const chunk = sz > 65536 ? 65536 : sz;
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, buf.length, sz - buf.length);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length > n ? lines.slice(-n) : lines;
  } catch (e) { return []; }
}
// v2.62/compactionMode：判断一条原始 transcript 行是否为"压缩标记"——
// 一条 role=user 的消息，内容以 <conversation_history_summary>（新格式）或 <cb_summary>（旧格式外包一层）开头。
// 命中则返回该标记的稳定 id（uuid/timestamp 优先，缺失时退回内容前缀 hash），否则返回 null。
// 稳定 id 用于跨轮 poll 识别"新出现的压缩标记"（同一压缩事件产生唯一 user 消息，id 不重复）。
function compactionMarkerId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return null; }
  if (!obj || obj.type !== 'message' || obj.role !== 'user') return null;
  const c = Array.isArray(obj.content)
    ? obj.content.map((x) => (x && x.text) || '').join('')
    : (typeof obj.content === 'string' ? obj.content : '');
  const s = (c || '').trimStart();
  if (s.startsWith('<conversation_history_summary>') || s.startsWith('<cb_summary>')) {
    if (obj.uuid) return 'u:' + obj.uuid;
    if (obj.timestamp) return 't:' + obj.timestamp;
    let h = 0;
    const pre = s.slice(0, 64);
    for (let i = 0; i < pre.length; i++) h = (h * 31 + pre.charCodeAt(i)) >>> 0;
    return 'h:' + h;
  }
  return null;
}
// v2.59/compaction-fix（步骤2）：获取 transcript 统计信息，用于 watcher 检测 Context Compaction。
// 注：原指令假设存在 getTranscriptPath()，但实际 v2.59 主 transcript 路径由 watcher 循环的 tsPath
// 变量持有，故此处直接接收 tsPath 参数，不新增全局路径函数。
// v2.61/perf+缓存：transcript 在单次 watcher 运行内路径不变，且每轮 poll（3s）都调本函数。
// 文件内容未变（mtimeMs 相同）时直接返回上次结果，避免反复 fs.readFileSync + 扫描整文件。
// 修复8：从 transcript 路径提取 sessionId（去 .jsonl 后缀）。路径 basename 天然唯一，
// 作为「首行解析失败」的兜底，避免所有解析失败的会话共用 'unknown' 而互相串扰。
function sidFromPath(tsPath) {
  try { return tsPath ? path.basename(String(tsPath), '.jsonl') : ''; } catch (e) { return ''; }
}

// v2.68 修复3：水位线键（ledger key）统一生成。
// 背景：水位线是"每个会话已记账到第几行"的凭据，键撞了就会互相打断（实测两个同名 default.jsonl
// 只记到一半用量）。原先两处生成逻辑不一致——记账用原始 sid（payload 缺 session_id 时是空串），
// watcher 用 sid || basename；而 basename 在**跨项目同名文件**时仍会撞。
// 规则：
//   1) 有真实 session_id（非空）→ 直接用，保持既有行为（同一会话的多个 transcript 片段仍归到一起）；
//   2) 无 session_id → 用 transcript **完整路径**的 sha1 前 16 位，同文件恒唯一、跨项目不撞。
// 注意：getTranscriptStats 里的 basename 回退（870 行）只用于诊断日志展示，不参与水位线键。
function ledgerKey(sid, tsPath) {
  const s = String(sid == null ? '' : sid).trim();
  if (s) return s;
  if (!tsPath) return 'unknown';
  try {
    return 'path-' + require('crypto').createHash('sha1')
      .update(path.resolve(String(tsPath))).digest('hex').slice(0, 16);
  } catch (e) {
    return sidFromPath(tsPath) || 'unknown';
  }
}

const transcriptStatsCache = { path: '', mtimeMs: 0, lineCount: -1, sessionId: 'error' };
function getTranscriptStats(tsPath) {
  try {
    const stat = fs.statSync(tsPath);
    // mtime 未变 → 文件内容必未变（行数 / sessionId 必同）→ 直接命中缓存，省去全量读。
    // 注意：仅靠 mtimeMs 比较；同一毫秒内多次写入的极端场景本缓存会返回旧值，但 watcher 以 3s 轮询，
    // 且 compaction 检测依赖 lineCount 严格下降（旧值与新值差 >5 才会触发），毫秒级误命中不影响判定。
    if (transcriptStatsCache.path === tsPath && transcriptStatsCache.mtimeMs === stat.mtimeMs) {
      return {
        lineCount: transcriptStatsCache.lineCount,
        mtimeMs: stat.mtimeMs,
        sessionId: transcriptStatsCache.sessionId,
      };
    }
    const content = fs.readFileSync(tsPath, 'utf8');
    // v2.61/perf：不再 split('\n') 生成整文件行数组（对百万行文件是巨大内存分配）。
    // 用 '\n' 字符计数替代行数：split('\n').length === 换行符数 + 1，对所有情形一致：
    //   content 无尾换行 "a\nb" → 换行符1 → 2；原生 split 也是 ["a","b"]=2
    //   content 有尾换行 "a\nb\n" → 换行符2 → 3；原生 split 也是 ["a","b",""]=3
    let newlineCount = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) newlineCount++;
    }
    const lineCount = newlineCount + 1;
    // 尝试从第一行提取 session id；提取不到时回退到 transcript 路径 basename（去 .jsonl）。
    // 修复8：不再回退 'unknown'——'unknown' 是常量，会导致所有解析失败的会话共用同一个 sessionId，
    // 进而互相串扰（水位线错记到别的会话 / 跨会话记账串台）。路径 basename 天然唯一。
    let sessionId = '';
    try {
      const firstLineEnd = content.indexOf('\n');
      const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
      if (firstLine && firstLine.includes('session')) {
        // 修复8：兼容多种写法——sessionId / session_id / session-id / session（原正则只认 "session" 后紧跟
        // : 或 =，遇到真实 transcript 里的 "sessionId":"xxx" 会匹配不上，只能回退）。
        // 捕获组排除引号/空白/逗号/右括号，避免把 JSON 的收尾符号吃进来。
        sessionId = firstLine.match(/session[\w-]*["']?\s*[:=]\s*["']?([^"'\s,}\]]+)/i)?.[1] || '';
      }
    } catch (e) {}
    if (!sessionId) sessionId = sidFromPath(tsPath) || 'unknown';
    transcriptStatsCache.path = tsPath;
    transcriptStatsCache.mtimeMs = stat.mtimeMs;
    transcriptStatsCache.lineCount = lineCount;
    transcriptStatsCache.sessionId = sessionId;
    return {
      lineCount,
      mtimeMs: stat.mtimeMs,
      sessionId,
    };
  } catch (e) {
    transcriptStatsCache.path = tsPath;
    transcriptStatsCache.mtimeMs = 0;
    transcriptStatsCache.lineCount = -1;
    transcriptStatsCache.sessionId = 'error';
    return { lineCount: -1, mtimeMs: 0, sessionId: 'error' };
  }
}
function mainModelState(tsPath) {
  const r = lastTranscLine(tsPath);
  if (!r) return 'unknown';
  const t = r.type;
  // v2.57（第一阶段修复）：终态错误优先——末行携带明确错误（429/5xx/timeout/明确 error）→
  // 主模型已经坏掉，本轮不可能再续跑，直接返回 'terminal-error'（watcher 据此走确认期收口）。
  // status=incomplete 单独出现（无 error）不算终态（可能是被中断/思考途中，等待后续行）。
  const te = terminalErrorFromRow(r);
  if (te) return 'terminal-error';
  // 工具调用（含团队派活、TaskOutput 等结果、ToolSearch 等内部）→ 主模型还在循环，绝不弹
  if (t === 'function_call') return 'busy';
  // 子代理结果刚回传 → 主模型马上要继续，绝不弹
  if (t === 'function_call_result') return 'busy';
  // 主模型的回复（assistant message，带真实 usage）→ 候选最终回复
  if (t === 'message') {
    const u = extractUsageFromRow(r);
    if (u && r.role !== 'user') return 'final';
    if (r.role === 'user') return 'busy'; // 用户/子代理回传消息 → 主模型即将继续
  }
  return 'unknown'; // reasoning 等中间行 / 异常
}

// v2.42：子代理活跃检测——判断是否有子代理在 sinceTs 之后仍在写入。
// 判据（真实 transcript 实证）：主模型 TaskOutput 阻塞等子代理时，主 transcript 会停在
// assistant message（看似 final），但子代理文件持续写入。所以拿 subagents 目录里每个
// agent-*.jsonl 的 mtime 与"主模型最后一行的时间戳"比较：有子代理在最后一行之后还在写
// = 专家团仍在干活，绝不能判结束；全部子代理都在最后一行之前停止 = 才可能真结束。
function hasActiveSubagentsSince(tsPath, sinceTs) {
  if (!tsPath) return false;
  const dir = subagentsDirFromTranscript(tsPath);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return false; } // 无 subagents 目录 → 普通轮，无子代理
  for (const f of entries) {
    if (!/^agent-.+\.jsonl$/i.test(f)) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > sinceTs) return true; // 子代理在 sinceTs 之后还在写 → 仍在运行
    } catch (e) { /* 文件被删/半写：忽略 */ }
  }
  return false;
}

// v2.43：子代理进度检测——基于"spawn vs completed/failed 通知"的语义判据，返回未完成的子代理名列表。
// spawn：主模型调 Agent（function_call name=Agent），agent 名从 args 的 "name" 字段或 prompt 的 （agent-name） 提取；
// ended：teammate-message teammate_id="system" summary="X completed / X failed" 系统通知（子代理结束的权威信号）。
// 名字带轮次后缀（critique-reviewer-3 → critique-reviewer）需 normalize（去尾部 -N）。
// pending 非空 = 还有子代理未完成/未回传 → 任务未结束，绝不能判 final。
// 这比 hasActiveSubagentsSince（mtime 判据）可靠得多：子代理可能长思考停顿不写文件（实测停顿超 100 秒），
// 但只要它还没发 completed/failed 通知，就绝不能判结束——mtime 判据在此场景会漏（v2.42 被用户实测击穿）。
function subagentPending(tsPath) {
  const spawned = new Set();
  const ended = new Set();
  if (!tsPath) return [];
  // v2.47：轮次后缀可能是纯数字(-3)或字母+数字(-c1/-c2/-c3)，旧正则 `-\d+$` 只匹配纯数字，
  // 会漏掉 -c1 这类 → topic-researcher-c1 匹配不上 topic-researcher → pending 卡死。
  // 改为兼容两者，但限制为"单字母+数字"避免误删 web-developer 这种正常连字符名字。
  const norm = (n) => String(n).replace(/-(\d+|[a-z]\d+)$/, '');
  const rows = readTranscLines(tsPath);
  for (const r of rows) {
    if (r.type === 'function_call' && r.name === 'Agent') {
      const args = typeof r.arguments === 'string' ? r.arguments : JSON.stringify(r.arguments || '');
      let m = args.match(/"name"\s*:\s*"([^"]+)"/);
      if (!m) m = args.match(/（([a-z][a-z0-9-]*)）/);
      if (m) spawned.add(m[1]);
    } else if (r.type === 'message' && r.role === 'user') {
      const c = Array.isArray(r.content) ? r.content.map((x) => (x && x.text) || '').join('') : (typeof r.content === 'string' ? r.content : '');
      // v2.44：子代理结束信号有两种——
      // ① system 系统通知：summary="X completed / X failed"（权威）
      const m1 = c.match(/teammate-message teammate_id="system"[^>]*summary="([^"]*)"/);
      if (m1) {
        const n = m1[1].match(/^([a-z][a-z0-9-]*?)\s+(?:completed|failed)/i);
        if (n) ended.add(norm(n[1]));
      }
      // ② 子代理回传：teammate-message teammate_id="<agent名>" summary="<实际产出>"（非 system、非 reactivated）
      //    实测 470fb702：critique-reviewer 只有回传（summary=审查报告）没有 system completed 通知，
      //    只认 system 通知会漏判 → pending 卡死不弹。
      const m2 = c.match(/teammate-message teammate_id="([^"]+)"[^>]*summary="([^"]*)"/);
      if (m2 && m2[1] !== 'system' && !/reactivated|processing new|awaiting|waiting/i.test(m2[2])) {
        ended.add(norm(m2[1]));
      }
    }
  }
  return [...spawned].filter((s) => !ended.has(norm(s)));
}

// v2.44：专家团"死寂"检测——子代理文件是否全部停更超过 stagnantMs。
// 场景：用户手动停止主模型后，子代理可能继续跑完但既无 system completed 通知也无回传
// （实测 3a35b538：topic-researcher 停止思考后 pending 永远非空）。此时"主模型静止 + 子代理文件全停更"
// 即为整体死寂，应强制结算弹窗，而不是傻等 pending 空或 30 分钟兜底。
function subagentsAllStagnant(tsPath, stagnantMs) {
  if (!tsPath) return false;
  const dir = subagentsDirFromTranscript(tsPath);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return false; } // 无 subagents 目录 → 普通轮
  const cutoff = Date.now() - (stagnantMs || 120 * 1000);
  let hasAny = false;
  for (const f of entries) {
    if (!/^agent-.+\.jsonl$/i.test(f)) continue;
    hasAny = true;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs >= cutoff) return false; // 还有子代理最近写过 → 未死寂
    } catch (e) { /* 文件被删/半写：忽略 */ }
  }
  return hasAny; // 有子代理但全部停更超窗口 → 死寂
}

// v2.47：子代理文件是否仍在活跃（最近 windowMs 内写过）。
// 用于 pending 假空兜底：中文团队（如"谭溯源"）Agent args 无 name 字段、prompt 里是中文名+音译，
// spawn 名提取失败 → pending 假空，但子代理可能还在跑（01593e8c 实测 11:12:14 派 6 章节研究员跑到 11:16:02）。
// 此时不能只信 pending 空，要靠子代理文件 mtime 判断是否真的还有子代理在活跃。
function hasSubagentsRecentlyActive(tsPath, windowMs) {
  if (!tsPath) return false;
  const dir = subagentsDirFromTranscript(tsPath);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return false; } // 无目录 → 无子代理 → 不活跃
  const cutoff = Date.now() - (windowMs || 60 * 1000);
  for (const f of entries) {
    if (!/^agent-.+\.jsonl$/i.test(f)) continue;
    try {
      if (fs.statSync(path.join(dir, f)).mtimeMs >= cutoff) return true; // 有子代理最近写过 → 活跃
    } catch (e) { /* 文件被删/半写：忽略 */ }
  }
  return false;
}

// v2.45：用户手动停止即时信号——WorkBuddy 在主模型生成被用户中断时，
// 会在 transcript 最后写入 assistant message content="Interrupted by user"（实测 652f2909/7d699843）。
// 检测到最后一行是 Interrupted → 用户手动停止 → 立即结算弹窗（不等死寂）。
// 注意：若任务随后恢复（Interrupted 后又追加新行），hasNewTail 会检测到并重置，不会误弹。
// v2.46：修正——停止标记有时只写在【子代理文件】里，主 transcript 不写（实测 9609fc9f/3a35b538：
// 主 transcript 无 Interrupted，但子代理文件最后一行是 Interrupted by user）。
// 之前的实现只查主 transcript 最后一行 → 误判"子代理还在运行"，其实子代理已停止（和用户界面一致）。
// 现在同时检查主 transcript 与所有子代理文件的最后一行。
function interruptedByUser(tsPath) {
  if (!tsPath) return false;
  const intrIn = (r) => {
    if (!r || r.type !== 'message') return false;
    if (r.role !== 'assistant') return false; // v2.49：真正的中断标记是 assistant（主模型输出被中断），排除 role=user 的摘要
    const c = Array.isArray(r.content) ? r.content.map((x) => (x && x.text) || '').join('') : (typeof r.content === 'string' ? r.content : '');
    return /^\s*Interrupted by user\s*$/i.test(c); // 精确匹配，排除长摘要里顺带提到 "Interrupted by user"（1686e062 上下文压缩误弹）
  };
  // 1. 主 transcript 最后一行
  if (intrIn(lastTranscLine(tsPath))) return true;
  // 2. 子代理文件最后一行（v2.46：主 transcript 不写标记时，子代理文件会写）
  const dir = subagentsDirFromTranscript(tsPath);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return false; } // 无 subagents 目录 → 普通轮
  for (const f of entries) {
    if (!/^agent-.+\.jsonl$/i.test(f)) continue;
    try {
      if (intrIn(lastTranscLine(path.join(dir, f)))) return true;
    } catch (e) { /* 文件被删/半写：忽略 */ }
  }
  return false;
}

// v2.23：统计本轮（roundStart 之后、同会话归属）内「有真实 token」的 trace 数量。
// >1 即视为多子回合（专家团/并行子代理），用于决定是否走合并防重。与 aggregateRound
// 口径一致：空壳 trace（无 in/out）不计；无 sid 的内部调用归属最近主任务（简单近似，
// 用于计数判断，无需极端精确）。
function countRoundValidTraces(roundStartMs, sessionId, anchorFile) {
  if (!(roundStartMs > 0)) return 1;
  const dir = path.dirname(anchorFile);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^trace_.+\.json$/.test(f)); }
  catch (e) { return 1; }
  let cnt = 0;
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const tr = (t && t.trace) || {};
      const st = Date.parse(tr.startedAt || '');
      if (!st || st < roundStartMs) continue;
      const s = extract(t);
      if (!(s.in || s.out)) continue;
      cnt++;
    } catch (e) { /* 半写/损坏：跳过 */ }
  }
  return cnt;
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
    // v2.36：快照清理——.snapshot-*.json 按会话隔离且无清理会无限积累。
    // 规则：保留最近 30 天，且最多保留 50 个（当前 sid 永远保留）。每次写入顺手清理，开销可忽略。
    cleanupSnapshots(sid);
  } catch (e) {
    // 快照写失败不阻断主输出，但按 C2 要求必须在 stderr 暴露，不静默
    process.stderr.write(`[token-tracker] 快照写入失败: ${e.message}\n`);
  }
}

// v2.36：清理历史会话快照（.snapshot-*.json）。保留规则：最近 30 天 + 最多 50 个 + 当前 sid 永不清。
function cleanupSnapshots(curSid) {
  try {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 3600 * 1000; // 30 天
    const files = fs.readdirSync(SNAP_DIR)
      .filter((f) => /^\.snapshot-.+\.json$/.test(f))
      .map((f) => {
        const full = path.join(SNAP_DIR, f);
        try { return { name: f, full, mtime: fs.statSync(full).mtimeMs }; }
        catch (e) { return null; }
      })
      .filter(Boolean);
    if (files.length === 0) return;
    // 按 mtime 从新到旧排序（最新的在前）
    files.sort((a, b) => b.mtime - a.mtime);
    const keepName = curSid ? `.snapshot-${String(curSid).replace(/[^a-zA-Z0-9_-]/g, '')}.json` : '';
    let deleted = 0;
    // 索引 >= 50 的（即第 51 个之后的所有较旧文件）→ 删除（数量上限）
    for (let i = 50; i < files.length; i++) {
      if (files[i].name === keepName) continue;
      try { fs.unlinkSync(files[i].full); deleted++; } catch (e) { /* 忽略 */ }
    }
    // 30 天前的 → 删除（时间上限；注意上面的 keepName 可能已在第 50 名内被保护，这里再兜底一次）
    for (const f of files) {
      if (f.mtime >= cutoff) continue;
      if (f.name === keepName) continue;
      try { fs.unlinkSync(f.full); deleted++; } catch (e) { /* 忽略 */ }
    }
    if (deleted > 0) {
      process.stderr.write(`[token-tracker] 已清理 ${deleted} 个过期会话快照\n`);
    }
  } catch (e) { /* 清理失败不影响主流程 */ }
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

// v2.39（2026-08-15）：日界改用「本地时间」——旧版用 UTC（toISOString），用户在 UTC+8，
// 凌晨 0–8 点会把当天算成前一天，导致每日账本/定价刷新错位。本地日期才是用户的"每天"。
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

// 每日价格自动刷新：当天已刷新（date==今天）→ 不联网直接返回；过期 → 同步调 refresh-prices.js
// 联网拉 OpenRouter 更新（execFileSync 保证刷新完成才继续；失败保留本地价并 stderr 暴露，不静默）。
function autoRefreshPricing(pricing) {
  if (!pricing || typeof pricing !== 'object') {
    // v2.66：pricing 缺失/损坏 → 尝试重建（联网拉取）。成功返回新 pricing；失败返回 null（不崩）。
    if (!(ENABLE_NETWORK && ENABLE_PRICE_REFRESH)) return null;
    const script = path.join(path.dirname(PRICING), 'refresh-prices.js');
    if (!fs.existsSync(script)) {
      process.stderr.write(`[token-tracker] refresh-prices.js 不存在，pricing 重建失败\n`);
      return null;
    }
    try {
      require('child_process').execFileSync(process.execPath, [script], {
        timeout: 60000, stdio: 'pipe', windowsHide: true, env: Object.assign({}, process.env, { WB_ROOT: WB }),
      });
    } catch (e) {
      process.stderr.write(`[token-tracker] pricing 重建失败（沿用本地价）: ${String(e.message).slice(0, 200)}\n`);
      return null;
    }
    const rebuilt = loadPricing();
    return rebuilt || null;
  }
  // v2.30：联网开关——总开关或分开关关闭时跳过自动刷新（沿用本地价，不联网）
  if (!(ENABLE_NETWORK && ENABLE_PRICE_REFRESH)) return pricing;
  if (pricing.date === todayStr()) return pricing;
  const script = path.join(path.dirname(PRICING), 'refresh-prices.js');
  if (!fs.existsSync(script)) {
    process.stderr.write(`[token-tracker] refresh-prices.js 不存在，跳过自动刷新\n`);
    return pricing;
  }
  try {
    require('child_process').execFileSync(process.execPath, [script], {
      timeout: 60000, stdio: 'pipe', windowsHide: true, env: Object.assign({}, process.env, { WB_ROOT: WB }),
    });
    return loadPricing(); // 刷新成功 → 重新读取（含新 date）
  } catch (e) {
    // 刷新失败：保留旧价，date 不变（次日重试）；失败原因已在 refresh-prices.js 的 stderr 输出
    process.stderr.write(`[token-tracker] 价格自动刷新失败（沿用本地价）: ${String(e.message).slice(0, 200)}\n`);
    return pricing;
  }
}

// 模型匹配（v2.71 起双模式；v2.67 曾严格化为"只认归一化完全相等"）。
// 模式：
// - 默认（精确）：只认「归一化后完全相等」的模型名，失败返回 null。统计分桶/别名判定用。
// - 计费（mode='price'）：归一化精确匹配失败后，遍历 pricing 所有 key 做双向 includes
//   子串匹配（原始名.includes(key) 或 key.includes(原始名)），命中多个取 key 长度最长的；
//   仍失败才返回 null。用于计费/显示/时段标注/补录判定——让 hy3-x 按 hy3 计价、
//   deepseek-ai/DeepSeek-V4-Flash 按 deepseek-v4-flash 计价，而统计桶名保持原始名（分开统计）。
// 依据（v2.67 源数据核查仍有效）：日期后缀模型的价格并不可靠相同——deepseek-r1 vs r1-0528、
// deepseek-chat-v3-0324 vs chat-v3.1、deepseek-v4-pro vs v4-pro-0813 价格均不同；
// 因此【精确模式】不做后缀归并（宁可不计价也不算错价）；【计费模式】仅做双向子串匹配
// 近似取价（精确优先，宽松兜底），且统计与计费解耦——桶名永不受影响。
function findModel(pricing, modelName, mode) {
  if (!pricing || !pricing.models || !modelName) return null;
  const norm = normalizeModelName(modelName);
  if (!norm) return null;
  const models = pricing.models;
  const keys = Object.keys(models);

  // 1) 精确匹配：归一化后字符串完全相等（大小写/首尾空格/连续空格差异视为同一个）
  if (models[norm]) return { key: norm, m: models[norm] };
  for (const key of keys) {
    if (normalizeModelName(key) === norm) return { key, m: models[key] };
  }

  // 2) 显式别名表：人工维护，当前为空表 → 不生效（见 MODEL_ALIASES 定义处说明）
  const alias = MODEL_ALIASES[norm];
  if (alias) {
    const ak = normalizeModelName(alias);
    if (models[ak]) return { key: ak, m: models[ak] };
    for (const key of keys) {
      if (normalizeModelName(key) === ak) return { key, m: models[key] };
    }
  }

  // 3) 计费模式：双向 includes 子串匹配，取 key 长度最长的命中（v2.71）
  if (mode === 'price') {
    let best = null; // { key, m, len }
    for (const key of keys) {
      const kn = normalizeModelName(key);
      if (!kn) continue;
      if (norm.includes(kn) || kn.includes(norm)) {
        if (!best || kn.length > best.len) best = { key, m: models[key], len: kn.length };
      }
    }
    if (best) return { key: best.key, m: best.m };
  }

  // 4) 到此为止：不做版本号 / 日期构建号等任何形式的模糊归并
  return null;
}

// 本地模型集合（v2.54，2026-08-18）：从 WorkBuddy models.json 读取 url 指向 localhost/127.0.0.1 的模型。
// 本地部署（Ollama / LM Studio / llama.cpp 等）的模型名往往不含标识（如 qwen3.8-27b 会与云端同名），
// 但 models.json 里 url 明确指向本地 → 一律免费、只统计 token 不计费。
// 主流本地模型服务的固定端口（host 为本机时无需端口匹配；局域网 IP 访问时要求端口命中）。
//   Ollama:11434 / LM Studio:1234 / llama.cpp·llamafile·LocalAI:8080 / vLLM:8000 / Jan:1337 /
//   GPT4All:4891 / koboldcpp·oobabooga:5000·5001 / TabbyAPI:5000
const LOCAL_MODEL_PORTS = new Set([11434, 1234, 8080, 8000, 1337, 4891, 5000, 5001]);

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]';
}

function isLanIp(host) {
  const h = String(host || '').toLowerCase();
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

let _localModelNames = null;
function localModelNames() {
  if (_localModelNames) return _localModelNames;
  const set = new Set();
  try {
    const cfgPath = path.join(WB, 'models.json');
    if (fs.existsSync(cfgPath)) {
      const arr = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      for (const m of Array.isArray(arr) ? arr : []) {
        let local = false;
        const urlStr = String(m.url || '').toLowerCase();
        try {
          const u = new URL(urlStr);
          const port = u.port ? Number(u.port) : null;
          if (isLocalHost(u.hostname)) local = true;                                             // 本机 → 无条件本地
          else if (isLanIp(u.hostname) && port && LOCAL_MODEL_PORTS.has(port)) local = true;     // 局域网 + 已知本地端口
        } catch (e) {
          local = urlStr.includes('localhost') || urlStr.includes('127.0.0.1');                   // URL 解析失败兜底
        }
        if (local) {
          if (m.id) set.add(String(m.id).toLowerCase());
          if (m.name) set.add(String(m.name).toLowerCase());
        }
      }
    }
  } catch (e) { /* models.json 不可读时不豁免，保持原行为 */ }
  _localModelNames = set;
  return set;
}

// 本地/自定义模型识别：custom-local: 前缀 / localhost/127.0.0.1 端点 / models.json 中 url 指向本地的模型 → 本地免费，不计费
function isLocalModel(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('custom-local') || n.includes('localhost') || n.includes('127.0.0.1')) return true;
  for (const lm of localModelNames()) {
    if (n === lm || n.includes(lm) || lm.includes(n)) return true;
  }
  return false;
}

// 模型显示名清理：去掉 provider 前缀与组织前缀（custom-local:qwen/qwen3.6-35b-a3b → qwen3.6-35b-a3b）
function cleanModelName(name) {
  let n = String(name || '').trim();
  const ci = n.indexOf(':');
  if (ci > 0 && ci < n.length - 1 && !n.includes('://')) n = n.slice(ci + 1); // 去掉 provider:（不含协议头）
  const si = n.lastIndexOf('/');
  if (si >= 0 && si < n.length - 1) n = n.slice(si + 1); // 去掉 org/ 组织前缀
  return n;
}

// 高峰时段（北京时间，本地时区即北京）：9:00-12:00、14:00-18:00，价格翻倍
// 峰谷时段判定（北京时间，v2.59 适配 2026-08-23 DeepSeek 新规：周末全天统一空闲价）
// 时段来源（v2.59 通用跟随）：优先读 pricing.deepseek_rules（refresh 每日从官方页解析写入）——
//   peak_schedule：官方高峰时段原文，如 "9:00 - 12:00、14:00 - 18:00"，官方调整时段则本地自动跟随；
//   weekend_off_peak：官方是否声明"周末统一低谷"，官方取消/改规则则自动跟随；
//   无 rules（抓取失败/旧数据）→ 回退内置默认（9-12/14-18 + 周末低峰）。
// 返回布尔：当前时刻是否处于高峰时段。
function parsePeakSchedule(sched) {
  // 支持 "9:00 - 12:00、14:00 - 18:00" / "9:00-12:00,14:00-18:00" 等
  const ranges = [];
  const parts = String(sched || '').split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/(\d{1,2}):?(\d{2})?\s*[-–—~至到]\s*(\d{1,2}):?(\d{2})?/);
    if (!m) continue;
    const sH = Number(m[1]), eH = Number(m[3]);
    if (isNaN(sH) || isNaN(eH)) continue;
    ranges.push({ s: sH, e: eH });
  }
  return ranges;
}
function isPeakHour(rules, now) {
  const t = now || new Date();
  const day = t.getDay();
  const h = t.getHours() + t.getMinutes() / 60;
  // 有官方规则 → 完全按官方来（通用跟随：官方改任何时段/周末规则都自动生效）
  if (rules && typeof rules === 'object') {
    const weekendOff = rules.weekend_off_peak === true || rules.weekend_off_peak === 'true';
    if (weekendOff && (day === 0 || day === 6)) return false; // 官方声明周末统一低谷
    const ranges = parsePeakSchedule(rules.peak_schedule);
    if (ranges.length) {
      for (const r of ranges) {
        // 区间为小时数（0-24）；跨午夜区间（s>e）按 23:59 封顶处理简化（官方当前无跨午夜档）
        if (r.e <= r.s) continue;
        if (h >= r.s && h < r.e) return true;
      }
      return false;
    }
    // rules 存在但时段解析不出 → 回退内置默认（但保留周末开关）
    if (day === 0 || day === 6) return false;
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  }
  // 无 rules → 内置默认（v2.59 周末低峰兜底）
  if (day === 0 || day === 6) return false;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// cost = 未命中输入×输入价 + 命中输入×缓存价 + 输出×输出价（元），按当前时段取倍率
function calcCost(stat, pricing) {
  if (!pricing || !stat) return null;
  if (isLocalModel(stat.model)) return null; // 本地模型不计费（即使 pricing 误收录也不按云端价算）
  const hit = findModel(pricing, stat.model || 'deepseek-v4-flash', 'price'); // v2.71：计费模式（精确失败后双向子串近似取价）
  if (!hit) return null;
  const m = hit.m;
  // 峰谷倍率：DeepSeek 系（不论后缀）统一执行峰谷规则 + 周末低峰（v2.59 用户规则）。
  // 判定：模型名含 'deepseek' 即强制套用峰谷倍率（peak_multiplier 缺省按 2），
  // 再经 isPeakHour()（已含周末→全天×1）；非 DeepSeek 系维持原行为：显式声明 peak_multiplier 才翻倍。
  const isDeepSeek = /(^|[\/\-_])deepseek/i.test(String(stat.model || ''));
  const peakMult = isDeepSeek ? (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 2) : (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 1);
  // 时段判定跟随官方 deepseek_rules（通用：官方调时段/周末规则自动生效）
  const mult = isPeakHour(pricing.deepseek_rules) ? peakMult : 1;
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

// ===== 每日账本 v2.39（2026-08-15，长期保存 + 分模型明细 + 当日合计）=====
// daily-usage.json 结构：
//   { "<YYYY-MM-DD>": {
//       "models": { "<模型名>": { "in", "out", "cached", "hit", "total", "cost" } },   // 单个模型当天累计；hit = 缓存命中率%（两位小数，cached/in）
//       "total":  { "in", "out", "cached", "hit", "total", "cost" }                     // 不分模型的当日总合计；hit 同样为总命中率%
//     } }
// - 按自然日（本地时间，修正 v2.32 用 UTC 导致的凌晨跨天错位）分桶，长期保存不裁剪。
// - 每天保留两套统计：models 各模型明细 + total 总合计（用户需求：两个总的统计）。
// - 旧格式（v2.32，{"date": 金额}）首次读取时自动迁移。
// 缓存命中率（缓存命中 / 总输入，两位小数百分比，口径与 toast「缓存NN.NN%」一致）
function hitRate(inTok, cachedTok) {
  const denom = inTok || 0;
  if (!(denom > 0)) return 0;
  return Math.round((cachedTok / denom) * 10000) / 100; // 保留两位小数
}
function dayTotalOf(models) {
  const t = { in: 0, out: 0, cached: 0, total: 0, cost: 0 };
  for (const m of Object.values(models || {})) {
    t.in += m.in || 0; t.out += m.out || 0; t.cached += m.cached || 0; t.total += m.total || 0;
    t.cost += m.cost || 0;
  }
  t.hit = hitRate(t.in, t.cached);
  return t;
}
function normalizeDailyUsage(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const out = {};
  for (const [date, v] of Object.entries(d)) {
    if (date === '_instructions') continue; // v2.59：跳过读取方指令字段，不当作日期键
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const models = v.models || {};
      out[date] = { models, total: v.total || dayTotalOf(models) }; // 新结构：缺 total 补算
    } else if (typeof v === 'number') {
      out[date] = { models: {}, total: { in: 0, out: 0, cached: 0, total: 0, cost: v } }; // v2.32 仅金额
    }
  }
  return out;
}
function loadDailyUsage() {
  try {
    gDailyCorrupt = false;
    return normalizeDailyUsage(JSON.parse(fs.readFileSync(DAILY_USAGE_FILE, 'utf-8')));
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 文件尚不存在（首次运行）→ 视为空账本，非损坏，不禁止后续写入
      gDailyCorrupt = false;
      return {};
    }
    // 损坏文件：重命名为 .corrupt-<时间戳> 备份（保留历史数据），本轮禁止写回空对象以免覆盖
    try {
      if (fs.existsSync(DAILY_USAGE_FILE)) {
        const corruptPath = DAILY_USAGE_FILE + '.corrupt-' + Date.now();
        fs.renameSync(DAILY_USAGE_FILE, corruptPath);
        process.stderr.write(`[token-tracker] 账本损坏，已备份为 ${path.basename(corruptPath)}（本轮不写回覆盖）\n`);
      }
    } catch (e2) { process.stderr.write(`[token-tracker] 账本损坏文件处理失败: ${e2.message}\n`); }
    gDailyCorrupt = true;
    return {};
  }
}
function saveDailyUsage(d) {
  // 独立调用场景：加锁保护整段写，避免与其他进程并发覆盖
  withFileLock(DAILY_USAGE_FILE + '.lock', () => saveDailyUsageRaw(d), { ttl: 300000, retries: 50 });
}
// 把一条 stat（单模型）累加进某天的 models，并重算该日 total（保证总合计永远=各模型之和）
function addModelUsage(day, model, stat, pricing) {
  const name = String(model || '').trim() || 'unknown';
  const cost = calcCost(Object.assign({ model: name }, stat), pricing);
  const m = day.models[name] || (day.models[name] = { in: 0, out: 0, cached: 0, total: 0, cost: 0 });
  m.in += stat.in || 0; m.out += stat.out || 0; m.cached += stat.cached || 0; m.total += stat.total || 0;
  m.hit = hitRate(m.in, m.cached);
  if (cost != null) m.cost += cost;
  day.total = dayTotalOf(day.models);
}
// 统一记账入口：byModel（transcript 按模型分桶）优先；否则按 stat.model 单桶。
// 每轮只在最终落点调用一次（普通轮 Stop / watcher 汇总 / hook 兜底补弹），天然不重复记账。
// v2.68 修复1：返回 true/false 表示本轮用量是否真的落盘。调用方（incrementalRecord）必须据此
// 决定是否推进水位线——记账失败却推进水位线 = 这部分用量永久丢失。
// 返回 false 的三种情形：账本此前损坏 / 锁获取失败 / 无用量可记；写盘失败也返回 false。
function recordUsage(stat, pricing, byModel) {
  if (gDailyCorrupt) {
    // 账本此前损坏：跳过写入，避免用空对象覆盖历史（历史已备份为 .corrupt 文件）
    process.stderr.write(`[token-tracker] 账本此前损坏，本轮跳过写入以免覆盖历史（备份在 .corrupt 文件）\n`);
    return false;
  }
  const r = withFileLock(DAILY_USAGE_FILE + '.lock', () => {
    const d = loadDailyUsage();
    const date = todayStr();
    const day = d[date] || (d[date] = { models: {}, total: { in: 0, out: 0, cached: 0, total: 0, cost: 0 } });
    if (byModel && Object.keys(byModel).length) {
      for (const [name, b] of Object.entries(byModel)) addModelUsage(day, name, b, pricing);
    } else if (stat && ((stat.in || 0) + (stat.out || 0)) > 0) {
      addModelUsage(day, stat.model || 'unknown', stat, pricing);
    } else {
      return false; // 无用量可记：不算失败也不算成功（调用方无需推进水位线，因为没记任何东西）
    }
    return saveDailyUsageRaw(d);
  }, { ttl: 300000, retries: 50 });
  if (!r.ok) process.stderr.write(`[token-tracker] 账本锁获取失败，本轮记账跳过（避免并发覆盖）\n`);
  return r.ok ? Boolean(r.result) : false;
}
function todayUsageTxt() {
  const d = loadDailyUsage();
  const day = d[todayStr()];
  const cost = day && day.total ? day.total.cost : 0;
  if (!(cost > 0)) return '';
  return `今日${fmtCost(cost)}`; // 无前导空格，由 toastLine1 统一加
}
// 弹 toast 前调用：把本条记入当日账本（含该模型/各模型），返回「当日累计」文本（含本条）
function todayDisplay(stat, pricing, byModel) {
  recordUsage(stat, pricing, byModel);
  return todayUsageTxt();
}

// ===== 增量记账（v2.50）：借鉴 WorkBuddy 的"逐笔实时记账"，摆脱"判断任务结束" =====
// 核心：每次 Stop 只累加"水位线之后的新 usage 行"，用行数去重（单调递增，可靠）。
// 不依赖"任务是否完整结束"——子代理/压缩/停止的每笔 usage 落盘后，在最近一次 Stop 就被记入账本。
// 记账与弹窗解耦：账本正确性不再受弹窗时机影响（多弹/漏弹都不影响账本）。
function loadLedgerWatermark() {
  try { return JSON.parse(fs.readFileSync(LEDGER_WATERMARK_FILE, 'utf-8')); } catch (e) { return {}; }
}
// 修复1 补充（对应最终验证"损坏场景不重复计费"）：水位线损坏时的安全降级。
// 水位线是"已记账到第几行"的唯一凭据，一旦丢失就会被当成从第 0 行开始，导致整段历史用量被重复计费。
// 三级降级：主文件 → .bak 备份（saveLedgerWatermark 每次写入前保留的上一版）→ 都不可用则跳过本轮记账。
// 注意：真损坏时**不**重命名/删除主文件——文件"缺失"会被 readTranscLines 从头记，同样重复计费；
// 保留损坏文件 + 每轮告警，由人工确认后手动删除（显式重记）更安全。
function loadLedgerWatermarkSafe() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_WATERMARK_FILE, 'utf-8'));
    if (j && typeof j === 'object') return { wm: j, corrupt: false };
  } catch (e) { /* 主文件缺失或损坏 → 继续降级 */ }
  const bak = LEDGER_WATERMARK_FILE + '.bak';
  try {
    const j = JSON.parse(fs.readFileSync(bak, 'utf-8'));
    if (j && typeof j === 'object') {
      process.stderr.write(`[token-tracker] 水位线主文件不可用，已回退 .bak 备份\n`);
      return { wm: j, corrupt: false };
    }
  } catch (e) { /* .bak 也不可用 */ }
  if (fs.existsSync(LEDGER_WATERMARK_FILE)) {
    process.stderr.write(`[token-tracker] 水位线已损坏且无可用备份，本轮跳过记账以避免重复计费（确认后请手动删除 ${path.basename(LEDGER_WATERMARK_FILE)} 再重记）\n`);
    return { wm: null, corrupt: true };
  }
  return { wm: {}, corrupt: false }; // 首次运行文件不存在 → 正常空水位线
}
function saveLedgerWatermark(wm) {
  const tmp = LEDGER_WATERMARK_FILE + '.tmp';
  const bak = LEDGER_WATERMARK_FILE + '.bak';
  try {
    fs.mkdirSync(path.dirname(LEDGER_WATERMARK_FILE), { recursive: true });
    // 保留上一版为 .bak 备份（损坏时可回滚）
    try { if (fs.existsSync(LEDGER_WATERMARK_FILE)) fs.copyFileSync(LEDGER_WATERMARK_FILE, bak); } catch (e2) {}
    // 先写临时文件，成功后原子 rename 覆盖；写失败则原文件完好、不清空
    fs.writeFileSync(tmp, JSON.stringify(wm));
    fs.renameSync(tmp, LEDGER_WATERMARK_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    process.stderr.write(`[token-tracker] 水位线写入失败: ${e.message}\n`);
  }
}
// 增量记账：累加主 transcript + 各子代理文件中"水位线之后"的新 usage 行，并推进水位线。
function incrementalRecord(tsPath, sid) {
  if (!tsPath || !fs.existsSync(tsPath)) return;
  // 修复1 补充：水位线损坏时跳过记账，宁可少记也不重复计费
  const lw = loadLedgerWatermarkSafe();
  if (lw.corrupt) return;
  const wm = lw.wm;
  // 修复3：键统一由 ledgerKey(sid, tsPath) 生成——有 session_id 用 session_id，
  // 没有则退化为 transcript 完整路径的哈希（跨项目同名文件不再撞键）。
  const key = ledgerKey(sid, tsPath);
  const entry = wm[key] || (wm[key] = { main: 0, subs: {} });
  const byModel = {};
  const merge = (m) => {
    for (const [n, b] of Object.entries(m)) {
      const t = byModel[n] || (byModel[n] = { in: 0, out: 0, cached: 0, total: 0 });
      t.in += b.in; t.out += b.out; t.cached += b.cached; t.total += b.total;
    }
  };
  // 1. 主 transcript 新行（行数水位线，单调递增，slice 可靠）
  // v2.68 修复1：先算出"候选新水位线"，记账成功后再落；失败则保持旧值，下轮重扫重记。
  // v2.68 修复2：候选值取 Math.max —— transcript 可能被截断（Context Compaction 覆盖重写、
  // 外部工具清空重建、磁盘故障），行数会**下降**。若直接赋新值，水位线被拉回小值，
  // 之后文件重新长到原长度时会把已记过的行再记一遍 = 重复计费。水位线只许前进不许后退。
  // v2.69 性能：只读 + 只解析"水位线之后的新行"。
  // 统计口径完全不变：rows 等价于旧实现的 mainRows.slice(entry.main)，totalLines 等价于 mainRows.length。
  const { rows: mainRows, totalLines } = readTranscLinesFrom(tsPath, entry.main || 0);
  const nextMain = Math.max(entry.main || 0, totalLines);
  if (totalLines > entry.main) {
    merge(perModelFromRows(mainRows, 0));
    merge(estimateInterruptedInc(tsPath, mainRows, entry.main || 0)); // v2.52：中断补偿
  }
  // 2. 各子代理文件新行
  const nextSubs = {};
  const subDir = subagentsDirFromTranscript(tsPath);
  if (fs.existsSync(subDir)) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!/^agent-.+\.jsonl$/i.test(f)) continue;
        const fp = path.join(subDir, f);
        // v2.69 性能：与主 transcript 同口径，只解析水位线之后的新行
        const start = entry.subs[f] || 0;
        const { rows: subRows, totalLines: subTotal } = readTranscLinesFrom(fp, start);
        if (subTotal > start) {
          merge(perModelFromRows(subRows, 0));
          merge(estimateInterruptedInc(fp, subRows, start)); // v2.53：子代理被中断思考也估算
        }
        // 修复2：子代理水位线同样只许前进（子代理 transcript 也会被 compaction 截断重写）
        nextSubs[f] = Math.max(entry.subs[f] || 0, subTotal);
      }
    } catch (e) { /* 忽略 */ }
  }
  // 3. 累加进账本（loadDailyUsage + addModelUsage + saveDailyUsage）
  //    无用量的轮次视为成功（无需落盘，推进水位线无害）；有用量时必须确认真的写进去了。
  let recorded = true;
  if (Object.keys(byModel).length) recorded = recordUsage({}, loadPricing(), byModel);
  if (!recorded) {
    // 记账失败（账本损坏 / 锁获取失败 / 写盘失败）→ 绝不推进水位线，
    // 否则这些用量再也不会被补记 = 永久丢失。保持旧水位线，下轮重新记账。
    process.stderr.write(`[token-tracker] 本轮用量未落盘，水位线保持 ${entry.main} 不推进（下轮重试，避免用量永久丢失）\n`);
    return;
  }
  // 4. 记账成功 → 推进水位线
  entry.main = nextMain;
  for (const f of Object.keys(nextSubs)) entry.subs[f] = nextSubs[f];
  saveLedgerWatermark(wm);
}

// ===== 每日账本报告（v2.39）：--report [all|<date>] =====
// 无参 → 今天明细+合计；all → 全部历史天；指定日期 → 该天。
function reportTxt(arg) {
  const d = loadDailyUsage();
  const today = todayStr();
  const allDates = Object.keys(d).sort().reverse();
  let targets;
  if (arg === 'all') targets = allDates;
  else if (arg) targets = [arg];
  else targets = [today];
  if (!targets.length) return '账本为空（暂无记录）';
  const lines = [];
  for (const date of targets) {
    const day = d[date];
    if (!day) { lines.push(`===== ${date} =====\n  （无记录）`); continue; }
    const models = day.models || {};
    const total = day.total || dayTotalOf(models);
    const tag = date === today ? '（今天）' : '';
    lines.push(`===== ${date}${tag} =====`);
    const names = Object.keys(models).sort();
    // Markdown 表格输出（v2.39.2）：聊天界面渲染真表格列，天然对齐，不依赖空格/字体宽度
    const cells = (s, bold) => {
      const f = (v) => (bold ? `**${v}**` : v);
      // hit 列：优先读已存字段，旧数据兜底现算；两位小数 %
      const hit = (s.hit != null ? s.hit : (s.in > 0 ? hitRate(s.in, s.cached) : 0)).toFixed(2) + '%';
      return `| ${f(s.label)} | ${f(fmt(s.in))} | ${f(fmt(s.out))} | ${f(fmt(s.cached))} | ${f(hit)} | ${f(fmt(s.total))} | ${f(s.cost > 0 ? fmtCost(s.cost) : '¥0.00')} |`;
    };
    lines.push('| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    if (!names.length) {
      // 仅有金额合计（旧格式迁移天）：直接输出合计行
      lines.push(cells({ label: '合计', in: total.in, out: total.out, cached: total.cached, total: total.total, cost: total.cost }, true));
    } else {
      for (const n of names) lines.push(cells({ label: n, ...models[n] }, false));
      lines.push(cells({ label: '合计', ...total }, true));
    }
    // v2.58（2026-08-22）：展示约定固化的提示行——每次 --report 读数据，最下面这行字直接告诉
    // 调用方（AI 助手）"向用户展示账本必须用上面的 Markdown 表格原文"，无需再翻技能规定。
    // 固定贴在最底部（合计行之后），任何日期档都输出。
    // v2.59：与 daily-usage.json 顶层 _instructions 保持同一套要求（表格原文 7 列 / 中文简写 / 人民币 ¥），避免 AI 看到两套说法。
    // 本行仅作读取参考，展示给用户时务必剥离。
    lines.push('> 【读取方指令】向用户展示以上账本时，必须使用 Markdown 表格原文（完整 7 列：模型、输入、输出、缓存、缓存命中、总 token、金额），不要手排、不要转纯文本、不要汇总；数字用中文简写（10000→1万，1000000→100万）；cost 单位为人民币，用 ¥ 符号，无需换算。本行仅供读取方参考，向用户展示请勿包含本行。');
    lines.push('');
  }
  return lines.join('\n');
}
// ===== 每日账本「仅合计」报告（v2.39.1）：--report summary [all|<日期>] =====
// 只输出每天的总合计（一行/天），不含模型明细——给"快速看某天/全部天数花了多少"用，
// 让助手只读最下面那行总数，省 token、省缓存占用。
function reportSummaryTxt(arg) {
  const d = loadDailyUsage();
  const today = todayStr();
  const allDates = Object.keys(d).sort().reverse();
  let targets;
  if (arg === 'all') targets = allDates;
  else if (arg) targets = [arg];
  else targets = [today];
  if (!targets.length) return '账本为空';
  const lines = [];
  for (const date of targets) {
    const day = d[date];
    if (!day) { lines.push(`${date}  （无记录）`); continue; }
    const total = day.total || dayTotalOf(day.models || {});
    const tag = date === today ? '（今天）' : '';
    lines.push(`${date}${tag}  输入 ${fmt(total.in)} / 输出 ${fmt(total.out)} / 缓存 ${fmt(total.cached)} / 总 ${fmt(total.total)} tokens ｜ ${total.cost > 0 ? fmtCost(total.cost) : '¥0.00'}`);
  }
  return lines.join('\n');
}

// Windows 系统通知：本条回答结束后把精确消耗以 toast 弹出（系统层面，用户可见）。
// 用 PowerShell WinRT Toast API，参数走 -EncodedCommand（UTF-16LE Base64）避免中文编码问题。
// 模板 ToastText02（两行）：行1=耗时/输入/输出，行2=缓存命中+费用。
// 用 PowerShell WinRT Toast API，参数走 -EncodedCommand（UTF-16LE Base64）避免中文编码问题。
// 模板 ToastText02（两行）：行1=耗时/输入/输出，行2=缓存命中+费用。
// v2.61：必须用同步 execFileSync（非 spawn+detached+unref）。原因：showToast 在 watcher 循环结束后才调用，
// 调用后立即清 coalesce / 释放锁 / return 退出；若用 detached+unref 异步 spawn，父进程（watcher）退出时
// PowerShell 子进程会被一起带走（宿主 job object 管理 hook 进程树，detached 不一定能脱离），toast 还没弹出就丢失。
// 同步 execFileSync 阻塞几百毫秒保证 toast 弹出后父进程才退出，与本函数调用位置（循环收口后）完全契合，不存在阻塞副作用。
// 失败不阻断主流程（stderr 记录）。
function showToast(line1, line2, reason) {
  // v2.63.1：把实际文案拼进诊断日志；合并最近 watcher 轮询快照字段（gLastWatchState），
  // 字段缺失时 writeToastLog 内部以 null 兜底，绝不因诊断而影响弹窗。
  const toastState = Object.assign({}, gLastWatchState || {});
  toastState.toastText = String(line1 || '') + ' | ' + String(line2 || '');
  writeToastLog(reason, toastState);
  // v2.70：弹窗去重——本次文案与上次完全相同且间隔 <10 分钟 → 跳过本次弹窗（诊断日志已写，
  // 去重状态仅内存不落盘）。防同一会话 Stop 弹窗与 watcher 兜底弹窗同文案重复弹出。
  const now = Date.now();
  if (gLastToastText !== null && toastState.toastText === gLastToastText && (now - gLastToastTs) < TOAST_DEDUP_MS) {
    process.stderr.write(`[token-tracker] toast 去重跳过: ${reason}\n`);
    return;
  }
  gLastToastText = toastState.toastText;
  gLastToastTs = now;
  if (process.platform !== 'win32') return;
  // v2.34：line1 可能含真实换行符 \n（toastLine1 两行大字布局）。先 escapeXml 转义 &<>"'，
  // 再把 \n 转成 XML 实体 &#10;（若先转再 escapeXml，& 会被转成 &amp; 导致换行失效）
  const l1 = escapeXml(String(line1 || '')).replace(/\n/g, '&#10;');
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${l1}</text><text id="2">${escapeXml(line2)}</text></binding></visual></toast>')`,
    "$t = New-Object Windows.UI.Notifications.ToastNotification $xml",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('WorkBuddy Token Tracker').Show($t)",
  ].join('; ');
  try {
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout: 10000, stdio: 'ignore', windowsHide: true });
  } catch (e) {
    process.stderr.write(`[token-tracker] toast 失败: ${e.message}\n`);
  }
}

// 模型显示名：优先取 pricing 里收录的 name（去掉括号说明），未收录用 trace 原始名。
// 完整显示不截断（用户要求：toast 两行空间足够放全名），仅去掉括号里的补充说明便于紧凑。
function shortModelName(stat, pricing) {
  let name = '';
  const raw = String((stat && stat.model) || '');
  if (isLocalModel(raw)) {
    name = cleanModelName(raw); // 本地模型：去 provider/组织前缀显示干净名
  } else {
    // v2.75：显示名使用应用原始模型名（如 hy3、deepseek-v4-flash），不取 pricing 的 name 字段。
    // 价格匹配仍由 findModel('price') 在计费路径（calcCost/periodNote/ensureNewModelPricing）完成，与此处显示解耦。
    const hit = findModel(pricing, raw, 'price');
    name = raw || (hit && hit.m && hit.m.name) || '';
  }
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

// 行1 标题大字专用宽度：中文/全角按 2.5 计（半角 1）。v2.33 修正（2026-08-14 用户实测反馈）：
//   - v2.17 实测纯半角 47u 不换行、48u 换行 → 标题大字纯半角真实上限 ≈ 47u
//   - 本次含中文混排 46u（2:1 模型）实测溢出 → 反推标题大字下中文实际 ≈2.5 半角单位，
//     2:1 模型每中文字低估 0.5u，多字累积导致判定"放得下"实际已溢出
//   → 行1 必须用此保守模型，不能复用 dispWidth（那是正文小字 2:1 模型，行1/行2 极限本就不同）
function dispWidthTitle(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2.5 : 1;
  }
  return w;
}

// 当前时段价格策略标注（放行1 模型名后，用户要求：第一行有空间，时段信息写第一行）：
//   - 模型声明 peak_multiplier>1 且当前在高峰时段 → `高峰双倍`（DeepSeek 原厂系=2）；倍数非 2 显示 `高峰×N`
//   - 模型声明 night_discount（夜间消耗系数，如 0.2=夜间2折）且当前在折扣时段 → `夜间N折`
//   - 无时段策略 → 空串不显示（避免噪音）
function periodNote(stat, pricing) {
  if (!pricing || !stat) return '';
  const hit = findModel(pricing, stat.model, 'price'); // v2.71：计费模式（时段标注与计价口径一致）
  if (!hit) return '';
  const m = hit.m;
  const mult = typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 1;
  if (isPeakHour(pricing.deepseek_rules) && mult > 1) {
    // 高峰标注写清倍数：2 倍显示「高峰双倍」，其他倍数显示「高峰×N」
    return mult === 2 ? '高峰双倍' : `高峰×${mult}`;
  }
  // 夜间折扣：模型声明了 night_discount（夜间消耗系数 0<d<1，如 0.2=打2折）且当前在夜间时段
  const nd = m.night_discount;
  if (nd != null && nd > 0 && nd < 1 && isNightHour(m)) {
    return `夜间${nd * 10}折`; // 0.2 → 夜间2折
  }
  return '';
}

// 夜间时段判断（默认 00:00-08:00，UTC+8；模型可声明 night_hours=[start,end] 覆盖）
function isNightHour(m) {
  const h = new Date().getHours();
  if (m && Array.isArray(m.night_hours) && m.night_hours.length === 2) {
    const [s, e] = m.night_hours;
    return s < e ? (h >= s && h < e) : (h >= s || h < e); // 跨天区间
  }
  return h >= 0 && h < 8;
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
// → 行1 标题大字真实上限 47u（纯半角；此前 42u 是保守估算值，低估了 5u）
// v2.33（2026-08-14）：行1 改用保守模型 dispWidthTitle（中文按 2.5 计）后，阈值定为 45——
//   留 2u 余量吸收中文实宽的系数误差，保证任何混排内容实际渲染 ≤ 47u（纯半角实测上限），永不换行
const TOAST_ROW1_MAX_W = 45;
// toast 标题（v2.35：两行大字布局，换行点从「今日」前移到「时间」前）：
//   行1（大字） = 模型名 [时段标注]      —— 只装名字+高峰双倍/夜间X折，最长 33u，远低于 41.5u 实测线
//   行2（大字） = 耗时 时间 今日¥X 余额¥Y —— 耗时/时间从行首开始，今日/余额紧跟；加前缀后极限 43u
//   返回含真实换行符 \n（showToast 里转成 &#10;），两行都是 ToastText02 标题大字
// 宽度保护（保守模型 dispWidthTitle）：
//   行2 用独立更保守阈值 42（上次实测 41.5u 成 / 46.5u 爆，43u 不确定 → 超 42 即降级丢余额，
//   保「耗时 时间 今日价」30u 绝对安全；再超丢今日价保底耗时 16u）。
//   行1 最长 33u 无需降级；极端情况超 45 丢时段保模型名。
const TOAST_ROW2_MAX_W = 42;
function toastLine1(stat, modelShort, period, balTxt, todayTxt) {
  const head = modelShort || '';
  // 行1：模型名 + 时段标注（空格分隔，不占用时间位置）
  const periodTxt = period ? ` ${period}` : '';
  const line1 = `${head}${periodTxt}`;
  // 行2：耗时 时间 今日¥X 余额¥Y（耗时/时间永远行首，今日/余额顺序保持）
  const durTxt = `耗时 ${fmtDur(stat.durMs)}`;
  const parts2 = [durTxt];
  if (todayTxt) parts2.push(todayTxt);
  if (balTxt) parts2.push(balTxt);
  let line2 = parts2.join(' ');
  // 行2 超宽保护：先丢余额，再丢今日价，保底耗时+时间
  if (dispWidthTitle(line2) > TOAST_ROW2_MAX_W && balTxt) {
    line2 = [durTxt, todayTxt].filter(Boolean).join(' ');
  }
  if (dispWidthTitle(line2) > TOAST_ROW2_MAX_W && todayTxt) {
    line2 = durTxt;
  }
  // 行1（模型名+时段标注）最长 33u，远低于 41.5u 实测线，无需降级；极端情况下若超宽丢时段保模型名
  if (dispWidthTitle(line1) > TOAST_ROW1_MAX_W) {
    return `${head}\n${line2}`;
  }
  return `${line1}\n${line2}`;
}
function toastLine2(stat, pricing) {
  const isLocal = isLocalModel(stat && stat.model);
  const cost = isLocal ? '本地·免费' : (fmtCost(calcCost(stat, pricing)) || '未收录');
  const input = (stat && stat.in) || 0;
  const cached = (stat && stat.cached) || 0;
  // 缓存占比精确到两位小数（如 99.12%）；无输入数据则不显示缓存段
  const ratioPct = input > 0 ? ((cached / input) * 100).toFixed(2) : null;
  const ratioTxt = ratioPct === null ? '' : `缓存${ratioPct}%｜`;
  let line = `输入 ${fmt(stat.in)} / 输出 ${fmt(stat.out)}｜${ratioTxt}${cost}`;
  // v2.31：价格多源拉取全失败 → 提示「价⚠️」，表示费用按上次价格估算（refresh-prices.js 全源失败时写入 last_refresh_error）
  if (pricing && pricing.last_refresh_error) {
    line += '｜价⚠️';
  }
  // v2.59：DeepSeek 官方定价抓取失败（回落聚合源）→ 提示「官价⚠️」，表示 DeepSeek 系按本地/聚合源价估算
  if (pricing && pricing.deepseek_refresh_error) {
    line += '｜官价⚠️';
  }
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
      timeout: timeoutMs || 5000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true,
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
  // v2.30：联网开关——总开关或余额分开关关闭时永不查询余额（默认关闭=零密钥联网）
  if (!(ENABLE_NETWORK && ENABLE_BALANCE_QUERY)) return '';
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
      timeout: timeoutMs || 10000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true,
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

// v2.31：同步子进程查 llmabacus 国内源（人民币价，含模型级 priceCurrency 判断国内外）。
// 返回：找到 → { id, in, out, cached, priceCurrency }（priceCurrency='CNY' 为人民币价，'USD' 为美元价）
//       未找到 → null；网络/解析失败 → undefined。
function lookupCnPrice(modelName, timeoutMs) {
  const script = [
    '(async () => {',
    "  try {",
    "    const res = await fetch('https://www.llmabacus.com/api/prices', { headers: { 'User-Agent': 'token-usage-tracker/2.2' } });",
    "    if (!res.ok) { console.error('HTTP ' + res.status); process.exit(2); }",
    "    const j = await res.json();",
    `    const needle = ${JSON.stringify(String(modelName).toLowerCase())};`,
    "    let hit = null, hitId = '';",
    "    for (const m of (j.models || [])) { if (String(m.id).toLowerCase() === needle) { hit = m; hitId = m.id; break; } }",
    "    if (!hit) for (const m of (j.models || [])) { const id = String(m.id).toLowerCase(); if (id && (id.includes(needle) || needle.includes(id))) { hit = m; hitId = m.id; break; } }",
    "    if (!hit) { console.error('NOT_FOUND'); process.exit(3); }",
    "    const inP = Number(hit.inputPrice), outP = Number(hit.outputPrice);",
    "    if (!(inP >= 0 && outP >= 0)) { console.error('NO_PRICE'); process.exit(4); }",
    "    const cached = hit.cachedInputPrice != null ? Number(hit.cachedInputPrice) : null;",
    "    console.log(JSON.stringify({ id: hitId, in: inP, out: outP, cached, priceCurrency: hit.priceCurrency || null }));",
    "  } catch (e) { console.error(String(e && e.message)); process.exit(1); }",
    '})();',
  ].join('\n');
  try {
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
      timeout: timeoutMs || 10000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true,
    });
    const lines = out.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    if (stderr.includes('NOT_FOUND') || stderr.includes('NO_PRICE')) return null;
    process.stderr.write(`[token-tracker] llmabacus 查价失败: ${stderr.slice(0, 150)}\n`);
    return undefined;
  }
}

// 把新模型补入 pricing.json（v2.31 区分国内外：region='CN' 直接人民币价；region='US' USD×汇率换算）
// 修复6：pricing 原子写（无锁，由调用方负责加锁）。写临时文件成功后 rename 覆盖，写失败保留原文件。
function savePricingAtomic(pricing) {
  const tmp = PRICING + '.tmp';
  try {
    fs.mkdirSync(path.dirname(PRICING), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(pricing, null, 2) + '\n');
    fs.renameSync(tmp, PRICING);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    process.stderr.write(`[token-tracker] 价格写入失败: ${e.message}\n`);
    return false;
  }
}

function addModelPrice(pricing, modelName, ref, region) {
  const name = String(modelName).toLowerCase();
  const rate = Number(pricing.usd_cny_rate) > 0 ? pricing.usd_cny_rate : 7.2;
  const m = {
    name: String(modelName),
    peak_multiplier: 1,
    region: region || 'CN',
  };
  if (region === 'CN') {
    // 国内模型：llmabacus 人民币价直接写入
    m.input_price = Number(ref.in);
    m.output_price = Number(ref.out);
    m.cached_price = ref.cached != null ? Number(ref.cached) : Number((ref.in * 0.1).toFixed(2));
    m.or_id = ref.id;
    m.price_source = 'llmabacus(国内)';
    m.note = '新模型自动补录（llmabacus 国内人民币价）';
  } else {
    // 国外模型：USD×汇率换算
    m.input_price = Number((ref.usdIn * rate).toFixed(2));
    m.cached_price = Number((ref.usdIn * rate * 0.1).toFixed(2));
    m.output_price = Number((ref.usdOut * rate).toFixed(2));
    m.or_id = ref.id;
    m.usd_input_price = Number(ref.usdIn.toFixed(6));
    m.usd_output_price = Number(ref.usdOut.toFixed(6));
    m.price_source = 'usd×汇率(国外源)';
    m.auto_converted = true;
    m.note = '新模型自动补录（USD×汇率估算，待人工核验官方价；时段策略默认无峰谷，如厂商有高峰/夜间折扣需搜索核验后补 peak_multiplier/night_discount 字段）';
  }
  pricing.models[name] = m; // 内存侧即时更新（供本进程 findModel 命中）
  // 修复6：加锁 + 锁内重新读盘合并，避免与 refresh-prices.js 并发读改写丢失更新
  const res = withFileLock(PRICING_LOCK_FILE, () => {
    let base;
    try { base = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { base = null; }
    if (!base || typeof base !== 'object' || !base.models || typeof base.models !== 'object') base = pricing;
    base.models[name] = m;
    if (pricing.usd_cny_rate != null) base.usd_cny_rate = pricing.usd_cny_rate;
    return savePricingAtomic(base);
  }, { ttl: 300000, retries: 50, retryDelay: 100 });
  if (res.skipped) {
    process.stderr.write(`[token-tracker] 新模型价格写入跳过（被其他进程持锁，稍后重试）\n`);
    return false;
  }
  return res.ok;
}

// 检测未收录模型 → 立即联网补录。返回 { status, note }：
//   none（已收录/无模型名）| added（自动补录成功）| not-found（国内外源均无此模型，记入已查列表）
//   | error（联网失败，不记已查，下次重试）| skipped（已查过未收录，不再重复联网）
function ensureNewModelPricing(pricing, stat) {
  if (!pricing || !pricing.models || !stat || !stat.model) return { status: 'none', note: '' };
  // v2.30：联网开关——总开关或补录分开关关闭时不联网，提示手动补录（不静默，避免用户误以为已收录）
  if (!(ENABLE_NETWORK && ENABLE_MODEL_LOOKUP)) {
    return { status: 'skipped', note: `ℹ️ 新模型 ${stat.model} 价格自动补录已关闭（ENABLE_MODEL_LOOKUP=false），请手动补录` };
  }
  if (isLocalModel(stat.model)) return { status: 'none', note: '' }; // 本地模型不计费，禁止自动补录云端价
  const hit = findModel(pricing, stat.model, 'price'); // v2.71：计费模式——宽松命中（如 hy3-x→hy3）即视为已收录，避免无谓联网补录
  if (hit && typeof hit.m.input_price === 'number') return { status: 'none', note: '' };
  const name = String(stat.model).toLowerCase();
  const looked = (pricing._lookedup_models || []).indexOf(name) >= 0;
  if (looked) {
    return { status: 'skipped', note: `⚠️ 新模型 ${stat.model} 价格已查过未收录，可搜官方定价页人工补录` };
  }

  // v2.31：先查国内源 llmabacus（人民币价，自动判断国内外），再回退 OpenRouter
  const cnRef = lookupCnPrice(stat.model);
  if (cnRef && typeof cnRef.id === 'string') {
    if (cnRef.priceCurrency === 'CNY') {
      // 国内模型：直接人民币价补录
      const ok = addModelPrice(pricing, stat.model, cnRef, 'CN');
      return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已从国内源(llmabacus·人民币)自动补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
    } else {
      // 国外模型（llmabacus 返回 USD 价）→ 按国外定价 USD×汇率
      const usdRef = { id: cnRef.id, usdIn: cnRef.in, usdOut: cnRef.out };
      const ok = addModelPrice(pricing, stat.model, usdRef, 'US');
      return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已从 llmabacus(USD·国外定价)自动补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
    }
  }
  if (cnRef === undefined) {
    process.stderr.write(`[token-tracker] 国内源 llmabacus 不可达，回退 OpenRouter 补录\n`);
  }

  const ref = lookupOrPrice(stat.model);
  if (ref === null) {
    // 国内外源均确认没有 → 记入已查列表，避免每次运行都联网
    pricing._lookedup_models = pricing._lookedup_models || [];
    if (pricing._lookedup_models.indexOf(name) < 0) pricing._lookedup_models.push(name);
    // 修复6：加锁写，避免与 refresh-prices.js 并发覆盖
    const lr = withFileLock(PRICING_LOCK_FILE, () => savePricingAtomic(pricing), { ttl: 300000, retries: 50, retryDelay: 100 });
    if (lr.skipped) process.stderr.write(`[token-tracker] 已查列表写入跳过（被其他进程持锁）\n`);
    return { status: 'not-found', note: `⚠️ 新模型 ${stat.model} 国内外价格源均未收录，请用 unified-search 搜官方定价页补录` };
  }
  if (ref === undefined) {
    return { status: 'error', note: `⚠️ 新模型 ${stat.model} 联网查价失败（国内外源均不可达），稍后自动重试` };
  }
  const ok = addModelPrice(pricing, stat.model, ref, 'US');
  return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已自动补录估算价（OpenRouter·国外定价，待核验）；时段折扣策略（高峰/夜间）请用搜索技能核验补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
}

function main() {
  const asHook = process.argv.includes('--hook');
  const asStop = process.argv.includes('--stop');
  // v2.39：--report [all|<date>] —— 打印每日账本（今天分模型明细+合计；历史天同样明细+合计）。
  // v2.39.1：--report summary [all|<date>] —— 只输出总合计（一行/天），让助手/用户只读最下面那行总数。
  // 纯文本输出，不影响 hooks 流程；无参=今天，all=全部天，也可指定日期。
  if (process.argv.includes('--report')) {
    const ri = process.argv.indexOf('--report');
    const rArg = process.argv[ri + 1] || '';
    if (rArg === 'summary' || rArg === 'totals') {
      process.stdout.write(reportSummaryTxt(process.argv[ri + 2] || '') + '\n');
    } else {
      process.stdout.write(reportTxt(rArg) + '\n');
    }
    return;
  }
  // v2.40：--flush-delayed <sid> —— Stop 端 spawn 的 detached 后台 watcher 入口。
  // 结束判定改为"锁定主模型"（业界标准 = 模型输出无工具调用的最终回复，即 stop_reason==end_turn）：
  // 每 3 秒轮询主 transcript 最后一行：
  //   - 是工具调用（Agent/TeamCreate/SendMessage/TaskOutput 等）或子代理结果回传 → 主模型还在工作，绝不弹，继续等；
  //   - 是主模型 assistant 最终回复 → 候选结束，进入确认期（连续 10 秒无任何新行追加）→ 才弹一次整轮汇总。
  // 不再用固定 6 秒赌子代理间隔（前几次反复崩的根因）。加互斥锁 + 30 分钟空闲兜底超时
  // （仅异常挂起触发，主模型持续活跃时绝不弹——v2.41 修正固定 deadline 会误弹活跃任务的缺陷）。
  if (process.argv.includes('--flush-delayed')) {
    const fSid = process.argv[process.argv.indexOf('--flush-delayed') + 1] || '';
    const WATCH_POLL_MS = 3 * 1000;      // 轮询间隔
    const WATCH_MAX_MS = 30 * 60 * 1000; // 空闲兜底超时（连续无任何活动才强制弹，防僵尸 watcher）
    // v2.59（2026-08-23）：纯 busy 无后续绝对上限。原逻辑 busy 末行无条件刷新 lastActiveAt →
    // WATCH_MAX_MS 永不超时 → 纯 busy（如主模型卡在 function_call 后崩溃/App 挂起，转录停写但末行仍 busy）
    // 可能长期不退出、不弹窗（比 30min 兜底更糟）。现：busy 不在"末行仍 busy"时刷新 lastActiveAt，
    // 仅 newTail/newAgent（真有新活动）才刷新；并给 busy 设独立绝对上限（默认 2min，测试可 env 缩短），
    // 纯 busy 无后续达到上限即兜底弹，绝不无限挂起。
    const WATCH_BUSY_MAX_MS = Number(process.env.WATCH_BUSY_MAX_MS) || (2 * 60 * 1000);
    // v2.59/P0-1：transient unknown 宽限——transcript mtime 在此时长内更新过，视为正在写入/重写中（如
    // Context Compaction 重写末行导致半写不可读），不进确认期、重置确认窗继续等，杜绝 compaction 期间
    // 因 unknown 持续 >6s 被误判结束而提前弹窗（R1 回归）。只有转录确实停写（mtime 旧）的 unknown 才收口。
    const WATCH_COMPACT_GRACE_MS = Number(process.env.WATCH_COMPACT_GRACE_MS) || (3 * 1000);
    // v2.70：上下文超长前兆等待窗——检测到"input length too long"等前兆后，压缩（contextSummary）
    // 启动期间 transcript 冻结，watcher 若按"末行冻结 3 帧"误判回合结束会提前弹窗。
    // 此窗口内暂停稳定帧收口、继续轮询不弹窗；超过该时长仍无新内容则恢复正常收口，
    // 避免无限等待（默认 120s 覆盖压缩最长耗时，测试可 env 缩短）。
    const COMPRESSION_WAIT_MAX_MS = Number(process.env.COMPRESSION_WAIT_MAX_MS) || (120 * 1000);
    const WATCH_LOCK_TTL = 30 * 60 * 1000; // 锁失效时间
    // 启动即拿锁：R3（2026-08-23）stale lock 接管 + R4（2026-08-23）原子 acquire 消除 TOCTOU。
    // 旧逻辑只查 at<TTL 从不验证 pid 存活：残留锁 owner 已死 → 新 watcher 误判锁有效 → watchStarts=0
    // 漏弹（B 类 Missing，repro_r3_lock.js 已确认）。且仅 readFileSync→writeFileSync 非原子 → 并发
    // TOCTOU 双启动（R4，前序 S4 starts=2 + repro_r4_logic.js 确定性临界窗）。
    // 修复：open('wx') 原子建锁；EEXIST 时评估锁有效性（pid 探活区分"可确认死亡/无法确认"），
    // 仅可确认死亡或 TTL 过期才安全接管；释放只删自己持有的锁（校验 pid===自己）。
    const lockPath = coalescePath(fSid) + '.lock';
    let gotLock = false;
    const myPid = process.pid;
    const acquireWatchLock = () => {
      try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (e) {}
      // 先尝试原子建锁（R4 核心）：不存在才创建，EEXIST 表示已有人持有
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid }));
        fs.closeSync(fd);
        return true; // 原子获取成功
      } catch (e) {
        if (e.code !== 'EEXIST') return false; // 其他 IO 错误：退化为无锁（继续尝试弹窗）
      }
      // 已存在锁 → 评估有效性（R3）
      let mine = null;
      try { mine = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch (e) { mine = null; }
      const fresh = mine && (Date.now() - (mine.at || 0) < WATCH_LOCK_TTL);
      if (!fresh) {
        // TTL 过期 → 锁失效，安全接管：删旧锁后重新原子建锁
        try { fs.unlinkSync(lockPath); } catch (e) {}
        try {
          const fd = fs.openSync(lockPath, 'wx');
          fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid }));
          fs.closeSync(fd);
          return true;
        } catch (e) { return false; }
      }
      // TTL 未过期 → 需判断 owner 是否存活
      const pid = mine && Number(mine.pid);
      if (!pid || pid <= 0 || !Number.isFinite(pid)) {
        // 无 pid / 非法 pid（旧格式或损坏）→ 无法确认死亡，保守保持互斥，不接管
        return false;
      }
      let alive = false;
      try { process.kill(pid, 0); alive = true; } // 无异常=进程存在（含无权限的 EPERM 也视为存活）
      catch (e) {
        if (e.code === 'ESRCH') alive = false;     // 进程不存在 → 可确认死亡
        else if (e.code === 'EPERM') alive = true; // 存在但无权限（跨进程/系统）→ 无法确认，保守视为存活
        else alive = true;                          // 其他异常 → 无法确认，保守存活
      }
      if (alive) return false; // owner 仍存活 → 保持互斥，本 watcher 退出
      // owner 已可确认死亡 → 安全接管
      try { fs.unlinkSync(lockPath); } catch (e) {}
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid }));
        fs.closeSync(fd);
        return true;
      } catch (e) { return false; }
    };
    gotLock = acquireWatchLock();
    if (!gotLock) {
      // 未获取锁（锁有效/无法确认/原子竞争失败）→ 退出，避免并发重复弹
      appendWatchDebug({ type: 'lock-denied', ts: Date.now(), sid: fSid, pid: myPid });
      return;
    }

    // 首查：若合并文件已被清理/已弹 → 退出（释放锁）
    const info0 = readCoalesceInfo(fSid);
    if (!info0 || !info0.agg) {
      // R4（2026-08-23）：释放只删自己持有的锁（校验 pid===自己），避免误删新 owner 的锁
      if (gotLock) { try { const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); if (o && o.pid === myPid) fs.unlinkSync(lockPath); } catch (e) {} }
      return;
    }
    const tsPath = info0.tsPath || '';
    // v2.41：兜底超时改为"空闲超时"。原固定 deadline（启动时刻+30 分钟）是缺陷：任务跑超 30 分钟且主模型仍在
    // 活跃时会被误弹。现在盯"最后活跃时刻 lastActiveAt"——只要轮询到主模型还在工作（busy / 新行追加）就不断刷新，
    // 只有连续 WATCH_MAX_MS 完全无任何活动（主模型崩了/App 挂了/transcript 停写）才触发兜底弹窗，杜绝僵尸 watcher。
    let lastActiveAt = Date.now(); // 最后活跃时刻（空闲超时计时基线）
    const watchStartTime = lastActiveAt; // v2.61/debug：watcher 启动时刻，用于调试日志量化运行时长
    let busySince = 0;             // v2.59：连续"末行 busy 且无新行"的起算时刻（绝对上限计时）
    let lastStats = null;          // v2.59/compaction-fix（步骤7）：上一次 poll 的 transcript 统计，用于检测 compaction
    let stableCount = 0;           // v2.59/compaction-fix（步骤7）：连续相同末行帧数，>=3 才视为真停写
    // v2.57：coalesce 携带的终态错误标记（Stop 端写入，末行明确 429/5xx/timeout）。
    // 作为初态假设：仅当首轮 pollTail 返回 unknown（末行被覆盖/尾行半写）时使用，避免误判。
    const initialTerminalError = info0.terminalError || null;
    let lastTailTs = -1;    // 上次轮询时看到的最后一行时间戳（用于检测"新行追加"）
    let firstPollDone = false; // v2.58：initialTerminalError 提升仅限首轮（修复 compaction 误弹）

    const pollTail = () => {
      if (!tsPath) return 'unknown';
      return mainModelState(tsPath);
    };
    const hasNewTail = () => {
      if (!tsPath) return false;
      const r = lastTranscLine(tsPath);
      if (!r) return false;
      const ts = Number(r.timestamp) || 0;
      if (ts > lastTailTs) { lastTailTs = ts; return true; }
      return false;
    };

    // 首轮记录尾部时间戳基线
    const baseR = lastTranscLine(tsPath);
    if (baseR) lastTailTs = Number(baseR.timestamp) || 0;

    // v2.42：记录已知子代理文件集合，用于检测确认期内主模型是否派了新子代理（新 agent 文件出现 = 刚派活 = 未结束）
    const knownAgents = () => {
      if (!tsPath) return new Set();
      try { return new Set(fs.readdirSync(subagentsDirFromTranscript(tsPath)).filter((f) => /^agent-.+\.jsonl$/i.test(f))); }
      catch (e) { return new Set(); }
    };
    let prevAgents = knownAgents();

    // v2.57（第一阶段修复）：watcher 调试日志——detached watcher 的 stdio 被丢弃（stdio:'ignore'），
    // 以往发生问题后无法知道内部状态。这里把每轮轮询判定落盘到 .watch-debug-<sid>.jsonl。
    // 清理策略：只保留最近 2000 行（约 100 分钟轮询），超出的旧行截断，避免无限增长。
    // v2.59：改为环境变量开关（WATCH_DEBUG=1 才落盘），默认关闭——生产不产生残留文件、无 I/O 开销；
    // 排查 watcher 状态时设 WATCH_DEBUG=1 运行即复现调试日志（watch-debug 曾实证定位 compaction 回归）。
    const watchDebugPath = coalescePath(fSid) + '.watch-debug';
    const maxDebugRows = 2000;
    const watchDebugOn = process.env.WATCH_DEBUG === '1';
    const appendWatchDebug = (o) => {
      if (!watchDebugOn) return;
      try {
        const line = JSON.stringify(o) + '\n';
        fs.appendFileSync(watchDebugPath, line);
        const buf = fs.readFileSync(watchDebugPath, 'utf-8');
        const ls = buf.split('\n');
        if (ls.length > maxDebugRows + 20) {
          fs.writeFileSync(watchDebugPath, ls.slice(ls.length - maxDebugRows).filter((x) => x !== '').join('\n') + '\n');
        }
      } catch (e) { /* 日志写入失败：不阻塞主逻辑 */ }
    };
    // 记录本 watcher 启动（含 sid / 起点 / 合并文件是否存在）
    appendWatchDebug({ type: 'start', ts: Date.now(), sid: fSid, tsPath, roundStart: info0.roundStart || 0, hasCoalesce: !!(info0 && info0.agg) });

    // v2.57（第一阶段修复）：unknown 计数日志——unknown 语义是"无法确定当前状态"，
    // 本阶段【不】用 unknown 超时当自动弹窗依据（误弹风险），但连续 unknown 需要可观测。
    let unknownStreak = 0;
    let lastUnknownTs = 0;
    let lastTailRaw = ''; // v2.59/P0-1：上一次 poll 的 transcript 原始末行，用于识别"正在改写中"的 transient unknown

    let toastReason = null;     // v2.61/debug：触发弹窗的原因（break 时赋值，用于去重日志）
    let lastPollSnapshot = null; // v2.61/debug：最近一次 poll 的状态快照，供 idle-timeout 兜底日志使用
    // v2.62/compactionMode：压缩标记追踪状态。
    // - processedMarkers：已处理过的压缩标记 id 集合（仅用于观测 processedMarkerCount）。
    // - compactionMode：一旦检测到压缩标记即置 true，整个 watcher 生命周期内保持（不重置回 false）。
    // - lastMarkerId：上一轮 poll 检测到的最新压缩标记 id（null 表示尚未见过）。
    const processedMarkers = new Set();
    let compactionMode = false;
    let lastMarkerId = null;
    // v2.70：上下文超长前兆 → 压缩等待窗口状态。
    // compressionPending=true：暂停稳定帧收口（继续轮询但不弹窗），直到 transcript 出现
    // 新的 assistant 消息（非 incomplete，= 压缩完成模型继续输出）或等待超时才恢复收口。
    // compressionWaitStart：进入等待窗口的时刻（超过 COMPRESSION_WAIT_MAX_MS 即恢复收口）。
    let compressionPending = false;
    let compressionWaitStart = 0;
    // lastOmenTs：最近一次进入压缩等待窗口时"最新前兆行"的 timestamp。前兆检测仅当新前兆
    // （timestamp 更大）才再次进入等待——防同一场停滞在超时/恢复后每轮重复触发、无限等待。
    let lastOmenTs = null;
    while (Date.now() - lastActiveAt < WATCH_MAX_MS) {   // 空闲超时：主模型持续活跃则永不退出、绝不弹
      // v2.62/compactionMode：每次 poll 开始时扫描 transcript 末尾窗口，识别压缩标记。
      // 该客户端 transcript 为 append-only，行数永不减少，旧"行数减少>5 行"检测恒不触发、已失效。
      // 真实 compaction 特征：一条 role=user 的消息，内容以 <conversation_history_summary>（新）或
      // <cb_summary>（旧）开头。系统在压缩时把历史摘要作为一条 user 消息追加进 transcript。
      const currentStats = getTranscriptStats(tsPath);
      let compactionSuspected = false;
      // 扫描末尾 30 行，取最新（最后命中）的压缩标记 id；无标记则 curMarkerId=null。
      let curMarkerId = null;
      const tailRawLines = readTailRawLines(tsPath, 30);
      for (const ln of tailRawLines) {
        const mid = compactionMarkerId(ln);
        if (mid !== null) curMarkerId = mid; // 同窗口内多条时取最新一条
      }
      // 发现"新"压缩标记：当前最新标记非空且不同于上一轮记录的最新标记（已滑出窗口的 null 不视为新标记）。
      if (curMarkerId !== null && curMarkerId !== lastMarkerId) {
        if (lastMarkerId !== null) processedMarkers.add(lastMarkerId); // 旧标记已处理完，入集合观测
        if (!compactionMode) {
          // 首次进入 compaction：完整重置——清空稳定计数并刷新空闲/busy 计时，避免压缩期间误收口。
          stableCount = 0;
          lastStats = currentStats;
          busySince = Date.now();
          lastActiveAt = Date.now();
          lastTailRaw = '';
        }
        compactionMode = true;
        compactionSuspected = true;
        lastMarkerId = curMarkerId;
        sleep(WATCH_POLL_MS);
        continue;
      }
      // v2.70：上下文超长前兆检测——模型返回 400 "input length too long" 等错误后，系统随即启动
      // contextSummary 压缩，压缩期间 transcript 不写入、压缩标记未落盘，watcher 若按"末行冻结
      // 3 帧"误判回合结束会提前弹窗。前兆命中 → 进入压缩等待窗口：清稳定帧、暂停收口、继续轮询。
      // 窗口内每轮检查恢复条件：① transcript 出现新的 assistant 消息（非 incomplete）= 压缩完成
      // 模型继续输出 → 恢复收口；② 超过 COMPRESSION_WAIT_MAX_MS 仍无新内容 → 恢复正常收口，
      // 避免无限等待。
      // 注意：仅"新前兆"（最新前兆行 timestamp 比上次处理过的大）才进入等待窗口——同一场停滞
      // 的旧错误行在超时/恢复后仍停留在末尾，若每轮重触发会永远等下去（实测 bug）。
      if (!compressionPending) {
        const omenTs = contextOverflowOmenTs(tsPath, 5);
        if (omenTs !== null && (lastOmenTs === null || omenTs > lastOmenTs)) {
          compressionPending = true;
          compressionWaitStart = Date.now();
          lastOmenTs = omenTs;
          stableCount = 0;
          lastTailRaw = '';
          busySince = 0;
          lastActiveAt = Date.now();
          compactionSuspected = true;
          appendWatchDebug({ type: 'compression-omen', ts: Date.now(), sid: fSid, compressionPending: true, omenTs });
        }
      }
      if (compressionPending) {
        const r = lastTranscLine(tsPath);
        const resumed = r && r.type === 'message' && r.role === 'assistant' && r.status !== 'incomplete';
        if (resumed) {
          // 压缩完成、模型已输出新的 assistant 消息 → 恢复正常收口（稳定帧从 0 重新累计）
          compressionPending = false;
          stableCount = 0;
          appendWatchDebug({ type: 'compression-resumed', ts: Date.now(), sid: fSid });
        } else if (Date.now() - compressionWaitStart > COMPRESSION_WAIT_MAX_MS) {
          // 最长等待已过仍无新内容 → 恢复正常收口，交由下方稳定帧判定决定是否弹窗
          compressionPending = false;
          appendWatchDebug({ type: 'compression-timeout', ts: Date.now(), sid: fSid });
        } else {
          // 仍在压缩等待窗口：暂停本轮收口判定（不弹窗），继续轮询
          sleep(WATCH_POLL_MS);
          continue;
        }
      }
      // 未发现新标记：compactionSuspected=false，compactionMode 保持不变（不重置），进入正常收口逻辑。
      lastStats = currentStats;
      let st = pollTail();
      // v2.57→v2.58：初态终态错误继承——coalesce 已标记 terminalError，首轮 poll 因末行被覆盖/尾行半写
      // 返回 unknown 时，继承该终态（Stop 端写入时已确认末行 429/5xx/timeout）。
      // 【修复】原代码每次轮询都做提升，违背「仅首轮」注释：本会话只要曾出现一次真实终态错误，
      // 此后任意一次 poll 遇到 Context Compaction 重写 transcript 导致短暂读不到（tail=null → unknown），
      // 都会被错误提升成 terminal-error → 进入确认期 → watcher 误判 Run 结束 → 提前弹窗
      // （实证 aa64e728 watch-debug：compaction 继续指令 message:user 之后 tail=null + terminal-error → break 误弹）。
      // 现严格限制为首轮 poll，且只信任「末行被覆盖/半写」这种确实读不到的场景；后续轮询一律以实际
      // 可读末行为准（真实终态错误由 terminalErrorFromRow 直接识别，无需继承），杜绝 compaction 误弹。
      if (st === 'unknown' && initialTerminalError && !firstPollDone) {
        st = 'terminal-error';
      }
      firstPollDone = true;
      const newTail = hasNewTail();
      // v2.43：子代理"未完成"语义判据——还有 spawn 但未发结束信号（system completed/failed 通知或子代理回传）→ 未结束。
      const pendingSub = subagentPending(tsPath);
      // v2.45：用户手动停止即时信号——末行 "Interrupted by user" → 立即结算（子代理同步停，实测行ts差0s）。
      const interrupted = interruptedByUser(tsPath);
      // v2.44：死寂检测——主模型静止(final) + 有未完成子代理 + 子代理文件全停更超 60 秒 → 手动停止/回传失效，
      // 强制结算（无 Interrupted 标记的停止，子代理最多多跑 40s，60s 窗口足够覆盖）。
      // v2.57：扩展——主模型终态错误(terminal-error) + 未完成子代理全停更同理视为死寂：
      // 主模型已 429/5xx 坏掉不会唤醒子代理，等子代理只是空等；停更超窗同样强制收口。
      const deadTeam = !interrupted && (st === 'final' || st === 'terminal-error') && pendingSub.length > 0 && subagentsAllStagnant(tsPath, 60 * 1000);
      // v2.57：末行终态错误检测（与 mainModelState 同口径，供日志记录 reason）
      const teNow = st === 'terminal-error' ? (terminalError(tsPath) || 'terminal-error') : null;
      // 检测是否出现了新子代理文件（主模型刚派新活）
      const agentsNow = knownAgents();
      let newAgent = false;
      for (const a of agentsNow) if (!prevAgents.has(a)) { newAgent = true; break; }
      prevAgents = agentsNow;

      // v2.57：本轮判定落盘（state/reason/pendingSub/tailTs/terminalError）——解决
      // detached watcher 内部状态不可观测问题。unknownStreak 只记录，不作为弹窗依据。
      const tailLine = lastTranscLine(tsPath);
      appendWatchDebug({
        type: 'poll', ts: Date.now(), state: st, newTail, newAgent,
        pendingSub: pendingSub.length, terminalError: teNow,
        tail: tailLine ? (tailLine.type + (tailLine.role ? ':' + tailLine.role : '') + '@' + (tailLine.timestamp || '-')) : 'null',
        unknownStreak,
      });

      const pollState = {
        ts: new Date().toISOString(), sessionId: (fSid && fSid !== 'unknown') ? fSid : currentStats.sessionId,
        watchStartTime: watchStartTime != null ? new Date(watchStartTime).toISOString() : null,
        lineCount: currentStats.lineCount, stableCount,
        st, hasNewTail: newTail, newAgent,
        pendingSubCount: pendingSub.length, interrupted, deadTeam,
        compactionSuspected: compactionSuspected,
        lastMarkerId, processedMarkerCount: processedMarkers.size, compactionMode,
        tailRawPrefix: readTailRaw(tsPath).slice(0, 80),
        lastTailRawPrefix: lastTailRaw.slice(0, 80),
      };
      gLastWatchState = pollState; // 最近快照供 showToast 内部 writeToastLog 补全诊断字段
      lastPollSnapshot = pollState; // 供循环退出后的 idle-timeout 日志复用

      if (newTail || newAgent) {
        // v2.59：仅有"真正的新活动"（新行追加 / 新子代理派活）才刷新空闲计时 + 取消确认期。
        // 不再把"末行仍是 busy"当作活跃信号（那是缺陷根因：纯 busy 无后续会持续刷新 lastActiveAt
        // 导致 WATCH_MAX_MS 永不超时）。新活动出现 → 重置 busy 连续计时。
        // v2.60：新活动 = 末行已变 → 稳定帧计数一并归零（与下方稳定帧保护一致）。
        lastActiveAt = Date.now();
        busySince = 0;
        stableCount = 0;
        unknownStreak = 0;
      } else if (st === 'busy') {
        // v2.59：末行仍是 busy 但本轮无新行 → 主模型可能只是停在工具调用等待（正常），也可能已崩溃挂起。
        // 取消收口候选（不收口），但【不】刷新 lastActiveAt（让空闲兜底能生效）；并启动 busy 绝对上限计时，
        // 纯 busy 无后续达到 WATCH_BUSY_MAX_MS 即兜底弹，杜绝长期不退出。
        unknownStreak = 0;
        if (busySince === 0) busySince = Date.now();
        else if (Date.now() - busySince > WATCH_BUSY_MAX_MS) {
          toastReason = 'busy-timeout';
          break;
        }
      } else if (st === 'final' || interrupted || st === 'terminal-error' || st === 'unknown') {
        // v2.57：terminal-error（末行明确 429/5xx/timeout）与 final 同级——收口。
        // 不把 status=incomplete（无 error）当终态；terminal-error 只产生于有明确错误证据的末行。
        // v2.59/v2.60：unknown 末行与 terminal-error 同级收口；unknown 表示转录停写且读不到确定状态，
        // 与"未知应弹"预期一致。若期间出现新行/新子代理（newTail/newAgent）会被上方分支重置计数，
        // 不会误弹活跃会话；兼顾 compaction 瞬时 unknown 的安全（有新行即取消）。
        // v2.60（compaction-fix 续）：统一稳定帧保护——将 unknown 分支的 stableCount>=3 门槛扩展到
        // final / terminal-error 分支（原 final 仅靠单一 6s 确认窗口，compaction 等长重写后末行被判
        // 为 final 且模型静默 >6s 即误弹）。interrupted 为真终态、子代理同步停，保留立即判定，仅享受
        // transient 重置保护。统一末行比对：末行在变（compaction 重写中 / 模型继续追加）→ 重置计数续等；
        // 末行稳定 → stableCount++；仅当 stableCount >= 3 才视为真停写并直接收口（无确认窗口）。
        // 同时覆盖 interrupted/terminal-error 的 transient 重置——重写期间末行抖动不收口。
        const stableGateRequired = (st === 'final' || st === 'unknown' || st === 'terminal-error');
        try {
          const tailRaw = readTailRaw(tsPath);
          if (lastTailRaw !== '' && tailRaw !== lastTailRaw) {
            // 末行在变：compaction 重写 / 模型继续追加 → 非停写，重置所有计数续等
            lastTailRaw = tailRaw;
            stableCount = 0;
            busySince = 0; lastActiveAt = Date.now();
            sleep(WATCH_POLL_MS);
            continue;
          }
          lastTailRaw = tailRaw;
          stableCount++; // 末行连续相同 → 计数（>=3 才视为真停写）
          pollState.stableCount = stableCount; // v2.70：日志记录自增后的真实值（原日志在自增前，与触发判定的值差 1）
        } catch (e) { stableCount = 0; /* 文件不可读 → 可能仍在写，重置计数续等 */ sleep(WATCH_POLL_MS); continue; }
        // 末行已稳定，final/unknown/terminal-error 需连续 >=3 帧稳定才收口（无确认窗口）；interrupted 免此门槛直接收口
        if (stableGateRequired && stableCount < 3) {
          sleep(WATCH_POLL_MS);
          continue;
        }
        if (interrupted) {
          // 用户手动停止 → 真终态立即收口（子代理同步停，实测行ts差0s）
          toastReason = 'interrupted';
          break;
        } else if (deadTeam) {
          // 专家团死寂（pending 非空 + 子代理停更 60s）→ 立即收口
          toastReason = 'deadTeam';
          break;
        } else if (pendingSub.length === 0) {
          // 名字匹配判据说"无未完成子代理"。但中文团队 spawn 名提取失败会 pending 假空，
          // 子代理可能还在跑 → 需再确认子代理文件确实停更（v2.47 修复）。
          if (hasSubagentsRecentlyActive(tsPath, 60 * 1000)) {
            // 子代理文件还在写 → 假空，继续等（不收口）
            lastActiveAt = Date.now();
            busySince = 0;
          } else {
            // 子代理确实停更 + 末行已稳定 >=3 帧 → 立即收口（v2.60：无确认窗口）
            toastReason = 'stableCount>=3';
            break;
          }
        } else {
          // 有未完成子代理且仍在活动 → 等待（子代理还在跑，主模型可能即将被唤醒）
          // v2.57：terminal-error 同理——主模型已坏但子代理还在跑，不提前结算团队，继续等；
          // 子代理停更后由上方 deadTeam（已扩展含 terminal-error）收口。
          lastActiveAt = Date.now();
          busySince = 0;
        }
      }
      sleep(WATCH_POLL_MS);
    }
    // idle-timeout：循环因 WATCH_MAX_MS 条件退出（非 break 触发）。toastReason 在 showToast 内部记录为 idle-timeout。
    if (!toastReason) {
      toastReason = 'idle-timeout';
    }
    // 兜底超时到 / 确认期过 → 弹（释放锁）
    const info = readCoalesceInfo(fSid);
    if (info && info.agg) {
      gLastTraceFile = info.traceFile || null; // v2.63.1：供下方 showToast 诊断记录 trace 文件名
      const pricing = loadPricing();
      const agg = info.agg;
      // v2.50：弹窗前补一次增量记账（子代理收尾可能在 Stop 之后才落盘，水位线保证不重复）
      if (info.tsPath) incrementalRecord(info.tsPath, fSid);
      const bal = balanceText();
      showToast(toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), bal, todayUsageTxt()), toastLine2(agg, pricing), toastReason);
      clearCoalesce(fSid);
      // v2.27：watcher 弹窗完成 = 专家团本轮真正结束 → 推进 lastStopAt（供 hook 端起点刷新守卫）
      const ws = loadSnapshot(fSid) || {};
      saveSnapshot({ file: ws.file || '', stat: ws.stat || null, lastUserMsgAt: ws.lastUserMsgAt || 0, lastStopAt: Date.now() }, fSid);
    }
    // R4（2026-08-23）：释放只删自己持有的锁（校验 pid===自己），避免异常路径误删新 owner 的锁
    if (gotLock) { try { const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); if (o && o.pid === myPid) fs.unlinkSync(lockPath); } catch (e) {} }
    return;
  }
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

  // v2.25：pricing 提前加载（transcript 数据源分支同样需要）
  let pricing = loadPricing();
  // v2.65：每日全量价格刷新改在 --hook（用户提问时）触发，避免 Stop 弹窗被刷新阻塞。
  // --stop 路径不再做全量刷新（只走各分支的 ensureNewModelPricing 补价），弹窗不被延迟。
  // 风险可接受：若当天第一次使用就是 Stop（罕见），价格用旧的，下次 --hook 会刷新。
  if (asHook) pricing = autoRefreshPricing(pricing);
  // 刷新失败/文件缺失时的提醒（不静默）；仅 --hook 路径（刷新实际发生处）提示，避免 --stop 误报"过期"
  if (asHook && pricing && pricing.date !== todayStr()) {
    process.stderr.write(`[token-tracker] 定价数据过期（${pricing.date}），自动刷新未成功，请手动运行 refresh-prices.js\n`);
  }
  // v2.59：DeepSeek 官方定价抓取失败 → stderr 返回给模型（hook 场景由 additionalContext 暴露），
  // 供 AI 向用户说明「当前数据更新失败，排查原因」；DeepSeek 系费用按本地/聚合源价估算。
  if (asHook && pricing && pricing.deepseek_refresh_error) {
    process.stderr.write(`[token-tracker] ${pricing.deepseek_refresh_error}\n`);
  }

  // v2.25（2026-08-12）：Stop 优先 transcript 数据源——WorkBuddy 5.3.11 专家团（Agent 工具
  // spawn 子代理）的模型调用**不落盘 traces**（实测 KET 专家团真实 675.8万 tokens，traces 只
  // 落了 4.6万空壳 trace，差 147 倍），但 transcript(providerData.usage) 完整记录主会话 +
  // subagents/*.jsonl。普通会话 transcript 按时间窗统计与 traces 完全一致（同源），故改用它。
  // 本轮边界 = 用户提交（hook 记 lastUserMsgAt）之后主 transcript + 子代理文件（mtime>本轮起点）
  // 的全部调用。无 payload（手动 --stop）或本轮无 transcript 数据 → 退回下方 traces 兜底逻辑。
  if (asStop) {
    const tsPath = transcriptPathFromPayload(payloadRaw);
    // v2.57（第一阶段修复）：Stop payload 无 stopReason 字段（实测只有 session_id/transcript_path/
    // cwd/hook_event_name/stop_hook_active/agent_type/last_assistant_message/...），stopReason 只存在于
    // SessionHookManager 内部日志。因此这里用 transcript 末行终态错误判定（与 mainModelState 同口径）：
    // terminal-error（末行明确 429/5xx/timeout，非 merely incomplete）= 强终态信号，写入探针供审计；
    // 不改变弹窗路径（专家团/team 生命周期照旧由 watcher 复查收口，仅记录 + 交由 watcher 的
    // terminal-error 分支快速收口）。
    const teAtStop = tsPath ? terminalError(tsPath) : null;
    if (teAtStop) {
      writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid,
        sameRound: false, note: 'terminal-error-detected', source: 'transcript-terminal-error',
        terminalError: teAtStop, transcriptPath: tsPath, payload: summarizePayload(payloadRaw) });
    }
    // v2.56：子代理路径守卫——如果 transcript_path 含 /subagents/，必然是子代理。
    // 只记账、不弹 toast。
    if (tsPath && (/\bsubagents\b/i.test(tsPath.replace(/\\/g, '/')))) {
      incrementalRecord(tsPath, sid);
      writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid,
        sameRound: false, note: 'subagent-skip-toast', source: 'transcript-subagent-path',
        transcriptPath: tsPath, payload: summarizePayload(payloadRaw) });
      out({ hookSpecificOutput: {} });
      return;
    }

    const prevSnap0 = loadSnapshot(sid) || {};
    const roundStart0 = prevSnap0.lastUserMsgAt || 0;
        if (tsPath && roundStart0 > 0) {
      let agg = aggregateTranscript(tsPath, roundStart0);
      if (!agg) { sleep(500); agg = aggregateTranscript(tsPath, roundStart0); } // transcript 尾部可能未 flush
      if (!agg) { sleep(1500); agg = aggregateTranscript(tsPath, roundStart0); }
      if (agg) {
        // v2.53：本轮可能"完整调用（有 usage）+ 被中断思考（无 usage）"混合——合并被中断估算，
        // 让弹窗显示两边汇总（之前只显示完整调用部分，被中断思考漏了）。
        const estByModel0 = estimateInterrupted(readTranscLines(tsPath), 0, roundStart0);
        const estNames0 = Object.keys(estByModel0);
        if (estNames0.length) {
          const estIn0 = estNames0.reduce((s, n) => s + estByModel0[n].in, 0);
          const estOut0 = estNames0.reduce((s, n) => s + estByModel0[n].out, 0);
          const estCached0 = estNames0.reduce((s, n) => s + estByModel0[n].cached, 0);
          agg.in += estIn0; agg.out += estOut0; agg.cached += estCached0; agg.total += estIn0 + estOut0;
        }
        // v2.74：耗时统一口径——优先用 trace 墙钟(startedAt→endedAt)，与 WorkBuddy 显示一致。
        // transcript 的 durMs 取"首条 usage 行→末条 usage 行"，而 usage 行在生成完成时落盘，
        // 起点被右移了首轮生成耗时（常 50s+），与 WorkBuddy 不一致。trace 不可读/时间戳缺失
        // （或归属非本会话）时回退 transcript 口径，绝不抛错。
        try {
          const lt = latestTraceFile(true);
          if (lt) {
            const ltj = readTrace(lt);
            const tr = (ltj && ltj.trace) || {};
            const tsa = Date.parse(tr.startedAt || '');
            const tea = Date.parse(tr.endedAt || '');
            const trSid = tr.sessionId ? String(tr.sessionId) : '';
            if (tsa > 0 && tea >= tsa && (!trSid || trSid === String(sid))) {
              agg.durMs = tea - tsa;
            }
          }
        } catch (e) { /* trace 半写/损坏：保留 transcript 口径 */ }
        const modelShort = shortModelName(agg, pricing);
      const nmNote = ensureNewModelPricing(pricing, agg).note;
      // v2.64：补价完成后再记账——确保新模型首用时 pricing.json 已含该模型价格，
      // 否则 incrementalRecord 内 loadPricing() 读不到价、calcCost 返回 null，cost 被静默丢弃。
      // 记账与弹窗解耦：即使弹窗时机错（多弹/漏弹），账本也已正确。
      incrementalRecord(tsPath, sid);
      const line = lineFor(agg, false, modelShort);
        writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: false, transcriptPath: tsPath, stat: agg, line, source: 'transcript', payload: summarizePayload(payloadRaw) });
        // 只有专家团（本轮有子代理 subagents 或有团队活动）才走合并延迟弹一次汇总——避免普通
        // 多工具轮也延迟；普通轮（无 subagents 且无团队活动）无论几次调用都立即弹整轮聚合（v2.20）
        // v2.27：普通轮立即弹并推进 lastStopAt 标记本轮结束；专家团不推进（中途多次 Stop 会写
        // coalesce+watcher，若推进会让插话 hook 误判轮次结束而刷新起点）——专家团的轮次边界由
        // watcher 弹窗完成时推进（见 --flush-delayed）。
        // v2.28：判定专家团 = subCount>0 或 teamActive（子代理异步落盘，中途 Stop 时 subCount 可能
        // 为 0，但主 transcript 本轮已有 Agent/TeamCreate 调用 → 仍按专家团合并，避免误弹多次）。
        // v2.39：本轮按模型分桶明细（每日账本"分模型"用，与 aggregateTranscript 同口径）
        const byModel = aggregatePerModel(tsPath, roundStart0);
        // R2 修复（2026-08-23）：plain 路径结构性零确认问题——原逻辑在 Stop 端 0ms 确认窗直接弹窗并
        // 立即推进 lastStopAt，导致"Stop 但主模型同轮续跑/恢复"被误判为轮次结束（A 类 Premature，
        // repro_r2.js 35/35 全 PREMATURE，历史实证 652f2909）。
        // 修复：统一改走 coalesce + watcher 确认窗（与专家团一致），由 --flush-delayed 的 6s 确认期
        // 判定真结束；确认窗内检测到 busy/新行/新子代理（续跑/恢复信号）则取消 pending，绝不弹。
        // Stop/idle/unknown/tool-end/网络错误/transcript 暂不可读均不再直接等价于 Run 真正结束。
        // watcher 弹窗完成时统一推进 lastStopAt（见 --flush-delayed）。
        // v2.63.3：transcript 路径也记录 traceFile / sessionId，供弹窗日志不再为 null/unknown。
        // sessionId 优先用 payload 的 sid，缺失时从 transcript 路径 basename 提取（如 7386b18a-….jsonl）。
        const latestTrace = latestTraceFile(true);
        const traceFile = latestTrace ? path.basename(latestTrace) : null;
        // 修复3：与 incrementalRecord 的记账键统一走 ledgerKey（原先这里用 basename 回退，
        // 而记账用的是原始 sid —— 两者不一致，且 basename 跨项目会撞）。
        const effSid = ledgerKey(sid, tsPath);
        writeCoalesce(effSid, agg, { tsPath, roundStart: roundStart0, byModel, terminalError: teAtStop || undefined, traceFile });
        spawnFlushWatcher(effSid);
        // v2.37：systemMessage 通道 WorkBuddy UI 实测不显示（无法注入到对话回复），删除该无效注入；
        // toast 已在上面弹出。保留空 hook 返回保证进程行为不变。
        out({ hookSpecificOutput: {} });
        return;
      } else {
        // v2.52：本轮无 usage 行（停止过快 / 思考途中停止，模型输出未落盘 usage）。
        // 先尝试中断补偿：若本轮有被中断的调用（incomplete reasoning），估算其 token 弹窗显示估算值；
        // 否则才走"无记录"提示（不 fall through trace 兜底，避免读错并发会话数据）。
        const estByModel = estimateInterrupted(readTranscLines(tsPath), 0, roundStart0);
        const estNames = Object.keys(estByModel);
        if (estNames.length) {
          const estTotal = estNames.reduce((s, n) => s + estByModel[n].total, 0);
          const estIn = estNames.reduce((s, n) => s + estByModel[n].in, 0);
          const estOut = estNames.reduce((s, n) => s + estByModel[n].out, 0);
          const estStat = { in: estIn, out: estOut, cached: 0, total: estTotal, durMs: 0, model: estNames[0], count: estNames.length };
          const estModelShort = shortModelName(estStat, pricing);
          writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: false, transcriptPath: tsPath, stat: estStat, line: '本轮被中断，估算 token（思考未落盘 usage）', source: 'transcript-interrupted-est', payload: summarizePayload(payloadRaw) });
          // 注意：估算值已在 incrementalRecord（本函数开头）按水位线记入账本，这里不再重复 recordUsage。
          const bal = balanceText();
          showToast(toastLine1(estStat, estModelShort, '（估算）', bal, todayUsageTxt()), toastLine2(estStat, pricing), 'estimate');
          out({ hookSpecificOutput: {} });
          return;
        }
        // v2.51：真正无记录（本轮既无 usage 也无被中断调用）
        // v2.53.1：文案升级——明确"应用层本地都无数据 + 常见原因"，避免用户误以为技能坏了。
        writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: false, transcriptPath: tsPath, stat: null, line: '本轮无 token 消耗记录（本地/应用层均无该轮数据：请求未发出或网络中断）', source: 'transcript-empty', payload: summarizePayload(payloadRaw) });
        const bal0 = balanceText();
        const today0 = todayUsageTxt();
        const reason0 = '本地与应用层均无该轮数据（请求未发出/网络中断）';
        const aux0 = (today0 ? '今日累计 ' + today0 + ' ｜ ' : '') + (bal0 ? bal0 + ' ｜ ' : '');
        // 宽度保护：原因优先，今日累计/余额超宽时丢弃（v2.53.1 原因提示是用户最想看的，保它）
        const body0 = dispWidth(aux0 + reason0) > TOAST_LINE_MAX_W ? reason0 : (aux0 + reason0);
        showToast('本轮无 token 消耗记录', body0, 'no-token');
        out({ hookSpecificOutput: {} });
        return;
      }
    }
  }

  // v2.56：traces 兜底路径的子代理守卫——如果 entry trace 的 sessionId != Stop payload 的 session_id，
  // 说明这个 Stop 事件的"本会话"和 trace 所属不是同一个会话，该 Stop 大概率来自子代理。
  // 子代理没有自己的 traces（v2.25 已验证），读到的是父会话或其他会话的 trace，不应弹 toast。
  const f = latestTraceFile(true);
  if (f && asStop) {
    try {
      const fTrace = readTrace(f);
      const fSessionId = (fTrace && fTrace.trace && fTrace.trace.sessionId) || '';
      if (fSessionId && fSessionId !== sid) {
        // entry trace 的 sessionId 和 Stop payload 不一致 → 跨会话了，跳过弹窗。
        // 此时依然尝试记账（若该子代理有自己的转录则累加）
        if (asStop) {
          const tsPathAlt = transcriptPathFromPayload(payloadRaw);
          if (tsPathAlt) incrementalRecord(tsPathAlt, sid);
        }
        writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid,
          sameRound: false, note: 'subagent-skip-toast-cross-session',
          traceSessionId: fSessionId, payload: summarizePayload(payloadRaw) });
        out({ hookSpecificOutput: {} });
        return;
      }
    } catch (e) { /* trace 半写/损坏：跳过检查 */ }
  }
  if (!f) {
    // v2.25：hook 无 trace 时也要记录本轮起点（否则全新会话第一轮 Stop 时 roundStart=0 无法聚合）
    // v2.27：同样应用起点刷新守卫——专家团进行中（无完成的 Stop）插话不刷新起点
    if (asHook) {
      const psnap3 = loadSnapshot(sid) || {};
      const prevStart3 = psnap3.lastUserMsgAt || 0;
      const prevStop3 = psnap3.lastStopAt || 0;
      const inProgress3 = prevStart3 > 0 && prevStop3 < prevStart3;
      saveSnapshot({ file: '', stat: null, lastUserMsgAt: inProgress3 ? prevStart3 : Date.now(), lastStopAt: psnap3.lastStopAt || 0 }, sid);
    }
    out(plain('暂无 trace 数据（可能尚未发生模型调用）'));
    return;
  }

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
    const modelShort = shortModelName(ts, pricing);
    const line = lineFor(ts, tSame, modelShort);
    const nmNote = ensureNewModelPricing(pricing, ts).note;
    writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: tSame, traceFile: tf, stat: ts, line, waited: !sameRound ? 0 : (tSame ? 'timeout' : 'ok'), payload: summarizePayload(stopPayload) });
    // 本条精确数据 → 弹 Windows 系统通知（两行：模型/耗时/余额 + 输入输出/缓存/费用；execFileSync 保证弹出；UI 内 systemMessage 通道实测不显示，故用 toast）
    // v2.23（2026-08-12）：多子回合防重——专家团等场景同一用户轮次内每个子代理完成都会触发
    // Stop，若每次都弹 toast 会出现"7 个专家弹 7 次"。本轮有效 trace >1 时判定多子回合。
    // v2.24（2026-08-12）：不延后到下次用户提交（那违背"及时弹出"），改为写合并文件 + spawn
    // 后台 watcher 延迟几秒复查（debounce）——期间无新子回合 → 整轮汇总只弹一次。单 trace 轮
    // 次行为不变（Stop 立即弹本条）。
    if (!tSame) {
      if (countRoundValidTraces(roundStart, sid, tf) > 1) {
        // 多子回合（专家团形态）→ 不推进 lastStopAt，由 watcher 弹窗时推进（--flush-delayed）
        saveSnapshot({ file: tf, stat: ts, lastUserMsgAt: prevSnap.lastUserMsgAt || 0, lastStopAt: prevSnap.lastStopAt || 0 }, sid);
        writeCoalesce(sid, ts, { traceFile: tf });
        spawnFlushWatcher(sid);
      } else {
        // R2 修复（2026-08-23）：单 trace 普通轮原 0ms 确认窗立即弹并推进 lastStopAt，存在 Premature
        // 风险（同轮续跑/恢复被误判结束）。统一改走 coalesce + watcher 6s 确认窗，由 --flush-delayed
        // 判定真结束并推进 lastStopAt（与专家团/transcript 源 plain 路径一致）。
        saveSnapshot({ file: tf, stat: ts, lastUserMsgAt: prevSnap.lastUserMsgAt || 0, lastStopAt: prevSnap.lastStopAt || 0 }, sid);
        writeCoalesce(sid, ts, { traceFile: tf });
        spawnFlushWatcher(sid);
      }
    }
    // v2.37：systemMessage 通道 WorkBuddy UI 实测不显示，删除该无效注入；toast 已在上方弹出。
    out({ hookSpecificOutput: {} });
    return;
  }

  if (asHook) {
    // v2.20：--hook 在用户提交消息时运行——记录本轮起点时间戳（供 Stop 端聚合"一轮内所有 trace"），
    // 同时更新"上一轮"文件/统计。无论是否 sameRound 都要刷新起点。
    // v2.21：按 sid 拆分快照（多会话并发各自记录起点，互不覆盖）。
    // v2.23：多子回合（专家团）Stop 端写合并文件——本次用户提交时补弹。
    // v2.24：正常路径由 Stop 端后台 watcher 延迟几秒弹（不再依赖下次提交）；这里仅兜底——
    // watcher 意外未弹（如应用关闭、进程被终止）时，用户下次提交读到残留合并 → 补弹一次并清除。
    // v2.29：snapshot.file 优先用 payload 的 transcript_path（本会话专属标识）而非全局最新 trace——
    // 多会话并发时 latestTraceFile 可能返回别的会话的 trace（实测新专家团 snapshot 残留 715.5万
    // 别的会话数据），导致 sameRound/去重串会话。transcript 路径按 sid 天然隔离，彻底避免污染。
    const tsPathH = transcriptPathFromPayload(payloadRaw);
    const hookFile = tsPathH || f;
    const pendAgg = readCoalesce(sid);
    const pendInfo = readCoalesceInfo(sid);
    if (pendAgg) {
      if (pendInfo && pendInfo.traceFile) gLastTraceFile = pendInfo.traceFile; // v2.63.1：诊断记录 trace 文件名
      const pendModel = shortModelName(pendAgg, pricing);
      const bal = balanceText();
      showToast(toastLine1(pendAgg, pendModel, periodNote(pendAgg, pricing), bal, todayDisplay(pendAgg, pricing)), toastLine2(pendAgg, pricing), 'hook-fallback');
      clearCoalesce(sid);
      // v2.27：兜底补弹完成 → 该轮已结束，标记 lastStopAt（供下轮起点刷新判断）
      const psnap = loadSnapshot(sid) || {};
      saveSnapshot({ file: psnap.file || hookFile, stat: psnap.stat || stat, lastUserMsgAt: psnap.lastUserMsgAt || 0, lastStopAt: Date.now() }, sid);
    }
    // v2.27（2026-08-12，起点刷新守卫）：专家团运行中途用户真实提交（system-reminder 触发 hook）
    // 会把 lastUserMsgAt 刷晚 → Stop 聚合起点变晚 → 漏掉之前的调用（实测 legal 409.3万漏成 159.8万）。
    // 修复：仅当上一轮已结束（lastStopAt >= lastUserMsgAt，即有过完成的 Stop/watcher 弹窗）才刷新起点；
    // 专家团进行中（无完成的 Stop）→ 保留旧起点，中途插话不重置本轮。
    const psnap2 = loadSnapshot(sid) || {};
    const prevStart = psnap2.lastUserMsgAt || 0;
    const prevStop = psnap2.lastStopAt || 0;
    const inProgress = prevStart > 0 && prevStop < prevStart; // 上一轮未结束（专家团进行中）
    saveSnapshot({ file: hookFile, stat, lastUserMsgAt: inProgress ? prevStart : Date.now(), lastStopAt: psnap2.lastStopAt || 0 }, sid);
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

// v2.39：被 require 时不执行 main()（hooks/手动仍走 node token-tracker.js，main 正常跑）；
// 导出内部函数供测试/回填脚本复用同一套记账逻辑，避免逻辑复制漂移。
if (require.main === module) main();
module.exports = {
  todayStr, loadDailyUsage, saveDailyUsage, recordUsage, dayTotalOf, hitRate,
  calcCost, findModel, isLocalModel, fmtCost, cleanModelName,
  readTranscLines, parseTranscChunk, readTranscLinesFrom, extractUsage, perModelFromRows, aggregatePerModel,
  todayDisplay, reportTxt, reportSummaryTxt, normalizeDailyUsage,
  mainModelState, lastTranscLine, coalescePath, hasActiveSubagentsSince, subagentsDirFromTranscript, subagentPending, subagentsAllStagnant, interruptedByUser, hasSubagentsRecentlyActive,
  incrementalRecord, loadLedgerWatermark, saveLedgerWatermark,
  estimateInterrupted, estimateInterruptedInc,
  extractUsageFromRow, terminalErrorFromRow, terminalError, contextOverflowOmen,
  showToast,
  loadPricing, autoRefreshPricing, addModelPrice, savePricing, normalizeModelName, saveDailyUsageRaw,
  getTranscriptStats, sidFromPath, ledgerKey,
};
