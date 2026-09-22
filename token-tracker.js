#!/usr/bin/env node
// token-usage-tracker v2.91 (2026-09-05)
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
// v2.99（2026-09-10，测试发现的隔离泄漏修复）：以下两个诊断日志原先硬编码 `os.homedir()`，
//   绕过了 WB_ROOT 隔离——导致测试时即使设了 WB_ROOT，日志仍写进真实 ~/.workbuddy，
//   污染真实日志文件（实测：一次隔离测试在真实 compaction 日志留下 11 行、toast 日志 5 行痕迹）。
//   改为与 daily-usage / ledger-watermark 一致地基于 WB 变量。
//   **注意：默认 WB === ~/.workbuddy，故正式使用时路径与行为完全不变（零影响）。**
const TOAST_LOG_PATH = path.join(WB, 'token-tracker-toast.log');
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
// v2.97（2026-09-10 用户反馈"子代理结束 1 分钟后才弹窗，太久"）：
//   子代理「静默多久即视为停写」的判定窗口。原为硬编码 60s，造成 ~7 倍冗余。
//   实测依据（Explore-3 真实子代理转录）：事件间**最大间隔 8.8s**（模型思考空档）、平均 1.6s；
//   且子代理最后一笔写入时间 == 文件 mtime（无落盘延迟）。故 20s 已覆盖实测最大间隔的 2.3 倍。
//   收口延迟预期：60s+9s(稳定帧) ≈ 69s → 20s+9s ≈ 29s（缩短约 58%）。
//   **误判的代价可控**：即使子代理思考超 20s 被误判停写而提前弹窗，也**不影响账本准确性**——
//   记账走 transcript 行数水位线增量，后续落盘的部分会在下一轮被补记（v2.50 机制）。
//   可用 SUBAGENT_IDLE_MS 环境变量覆盖。
const SUBAGENT_IDLE_MS = Number(process.env.SUBAGENT_IDLE_MS) || 20 * 1000;
// v2.87：compaction 专项事件日志——压缩对 hook 侧是纯黑盒（触发时机/Stop 次数/重写方式无契约），
// 历史 8 次压缩相关弹窗异常（08-25~09-05）每次只能从弹窗反推机制。本日志在关键决策点落盘
// transcript 形态快照（行数/mtime/末行类型/压缩标记/聚合起点决策），出问题先看数据再修，不再猜。
const COMPACTION_LOG_PATH = path.join(WB, 'token-tracker-compaction.log');
// v2.90：跨进程弹窗指纹文件（token-tracker-toast-fp.json）随抑制机制一并撤除。
// v2.87：transcript 形态快照（只读，绝不抛错）——行数/mtime/大小/末行类型/末 30 行压缩标记 id。
function captureTranscShape(tsPath) {
  try {
    if (!tsPath || !fs.existsSync(tsPath)) return { exists: false };
    const st = fs.statSync(tsPath);
    const shape = { exists: true, mtimeMs: Math.round(st.mtimeMs), size: st.size };
    try { shape.lineCount = getTranscriptStats(tsPath).lineCount; } catch (e) {}
    try {
      const tl = lastTranscLine(tsPath);
      shape.tail = tl ? { type: tl.type, role: tl.role || null, status: tl.status || null } : null;
    } catch (e) {}
    try {
      let mid = null;
      for (const ln of readTailRawLines(tsPath, 30)) { const m = compactionMarkerId(ln); if (m !== null) mid = m; }
      shape.markerId = mid;
    } catch (e) {}
    return shape;
  } catch (e) { return { exists: false, err: String(e && e.message || e) }; }
}
// v2.87：compaction 事件日志追加（诊断通道，绝不影响主流程）。
function appendCompactionLog(event, data) {
  try {
    const rec = Object.assign({ ts: new Date().toISOString(), pid: process.pid, event }, data || {});
    fs.appendFileSync(COMPACTION_LOG_PATH, JSON.stringify(rec) + '\n');
  } catch (e) { /* 诊断日志写失败忽略 */ }
}
// v2.90：跨进程弹窗抑制已整体撤除（误杀真弹窗，见 showToast 内 v2.90 注释）。
// 保留 captureTranscShape / appendCompactionLog（事件观测，v2.87-① 继续有效）。
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
    if (typeof meta.mainToastedAt === 'number') payload.mainToastedAt = meta.mainToastedAt; // v3.12：异常轮主模型已先弹标记（供补弹判断不重复）
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
// v3.00：记录最近一次 watcher spawn 的异步错误（供调用方决定是否降级同步弹窗）
let lastWatcherSpawnError = null;
function spawnFlushWatcher(sid) {
  try {
    const cp = require('child_process');
    const child = cp.spawn(process.execPath, [__filename, '--flush-delayed', sid || ''], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    // v3.00（2026-09-11 故障修复）：**spawn 的失败是异步 'error' 事件，不是同步异常**。
    //   原实现只有 try/catch，且没有 'error' 监听 → 找不到可执行文件时错误被**静默丢弃**：
    //   无日志、无降级、调用方也以为已启动 → 表现为"弹窗彻底不弹、只有下次 hook 兜底"。
    //   这正是 2026-09-11 22:38 起（WorkBuddy 重部署 node 后）watcher 全部失效的根因。
    //   现补上监听：留痕供诊断 + 置位标记供调用方降级。
    lastWatcherSpawnError = null;
    child.on('error', (e) => {
      lastWatcherSpawnError = (e && (e.code || e.message)) || 'unknown';
      try {
        appendCompactionLog('watcher-spawn-error', {
          sid, execPath: String(process.execPath || ''), err: (e && e.message) || '', code: (e && e.code) || '',
        });
      } catch (e2) { /* 留痕失败不阻塞 */ }
      process.stderr.write(`[token-tracker] watcher 启动失败(异步): ${(e && e.message) || e}\n`);
    });
    child.unref();
    return child;
  } catch (e) {
    lastWatcherSpawnError = `sync:${e && e.message}`;
    process.stderr.write(`[token-tracker] 延迟弹窗 watcher 启动失败: ${e.message}\n`);
    return null;
  }
}

// v3.00（2026-09-11 故障修复）：启动 watcher 并**校验其是否真的接管**。
//   判据：watcher 启动后第一件事就是抢锁（coalescePath(sid) + '.lock'），锁文件 mtime 会新于启动时刻。
//   原实现 spawn 后**不校验**，spawn 异步失败时调用方毫不知情 → 弹窗静默消失（本次故障根因）。
//   返回 true = watcher 已接管（弹窗由它负责）；false = 未起来，**调用方必须降级为同步弹窗**。
function startWatcherVerified(sid) {
  let cp = null;
  try { cp = require('child_process'); } catch (e) { return false; }
  const lockF = coalescePath(sid) + '.lock';
  let lockBefore = 0;
  try { if (fs.existsSync(lockF)) lockBefore = fs.statSync(lockF).mtimeMs; } catch (e) { lockBefore = 0; }
  spawnFlushWatcher(sid);
  for (let i = 0; i < 10; i++) {                 // 最多约 1.5s（10 × 150ms）
    if (lastWatcherSpawnError) return false;     // 已收到异步 error → 立即判定失败，不空等
    try {
      if (fs.existsSync(lockF) && fs.statSync(lockF).mtimeMs > lockBefore) return true; // 锁被新建/更新 → watcher 已接管
    } catch (e) { /* 读取瞬时失败：下一轮重试 */ }
    try { cp.execSync('ping -n 1 -w 100 127.0.0.1 >NUL', { stdio: 'ignore' }); } catch (e) { /* sleep 150ms */ }
  }
  return false;
}

// v2.85：轮级临时 watcher——UserPromptSubmit（--hook）为每个新轮 spawn 的自限时观察进程（非兜底、
// 非常驻）。职责：盯住「本轮被手动取消且未触发 Stop hook」的场景——取消标记收尾 + 8 秒无新行 →
// 立即补弹，不再等下一轮用户提交触发 v2.83 兜底（0-usage 取消时兜底还会静默丢失，15:33 型漏弹）。
// 退出条件（任一，见 roundWatchMain）：轮已结算 / 新轮接管起点 / coalesce 出现 / transcript 消失 / 生命上限。
// v2.91：工作区日志定位——logs/<today>/<工作区目录名>__*.log 中 mtime 最新者。
// 取消信号源（客户端源码实证：[ACP Agent] cancel: received cancel request 每次取消必写）。
function resolveWorkspaceLogFile(cwd) {
  try {
    const ws = path.basename(String(cwd || '').replace(/[\\/]+$/, ''));
    if (!ws) return '';
    const dir = path.join(os.homedir(), '.workbuddy', 'logs', todayStr());
    if (!fs.existsSync(dir)) return '';
    let best = '', bestM = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(ws + '__') || !f.endsWith('.log')) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > bestM) { bestM = m; best = path.join(dir, f); }
    }
    return best;
  } catch (e) { return ''; }
}
function spawnRoundWatcher(sid, tsPath, roundStart, logFile) {
  try {
    if (!tsPath || !(roundStart > 0)) return;
    const cp = require('child_process');
    const child = cp.spawn(process.execPath, [__filename, '--round-watch', sid || '', tsPath, String(roundStart), logFile || ''], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.unref();
  } catch (e) { process.stderr.write(`[token-tracker] 轮级取消 watcher 启动失败: ${e.message}\n`); }
}
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
// ===== 本地官方价格库（v2.80, 2026-08-31）=====
// 各厂商官网直抓（人民币官方价），由 python 流水线每日重建：
//   fetch-cn-prices.py && parse_tokenhub.py && build_index.py → prices/index.json（原子写，含 built_at 闸门）
// 可用环境变量覆盖路径；默认指向价格库项目目录。
// v3.02（2026-09-11 解耦·自适应）：价库路径**自动发现**，不再写死某个具体工作区。
//   背景：原实现硬编码 `C:\Users\14779\WorkBuddy\2026-08-30-22-25-15\prices`，
//   该工作区一旦改名/迁移/删除，价库即**静默失效**（国内模型失去官方价、费用显示为空）。
//   WorkBuddy 更新频繁且会重建工作区，这类"写死路径"是最典型的易碎点。
//   自适应策略（按优先级，命中即用）：
//     ① 环境变量 `CN_PRICE_DB_DIR`（显式覆盖，最高优先）
//     ② **自动扫描** `~/WorkBuddy/*/prices/index.json`，取 mtime **最新**者
//        —— 抗工作区改名/新建/多份并存，无需人工维护路径
//     ③ 技能自身目录 `prices/`（随技能走的兜底副本，完全不依赖任何工作区）
//     ④ 旧硬编码路径（向后兼容，最后兜底）
//   全部未命中 → 返回空串，走既有降级（stderr 告警 + 回退聚合价），绝不崩溃。
function autoDiscoverCnPriceDir() {
  const cands = [];
  if (process.env.CN_PRICE_DB_DIR) cands.push(String(process.env.CN_PRICE_DB_DIR));
  try {
    const wsRoot = path.join(os.homedir(), 'WorkBuddy');
    let best = null, bestM = -1;
    for (const d of fs.readdirSync(wsRoot)) {
      const dir = path.join(wsRoot, d, 'prices');
      const idx = path.join(dir, 'index.json');
      try {
        if (!fs.existsSync(idx)) continue;
        const m = fs.statSync(idx).mtimeMs;
        if (m > bestM) { bestM = m; best = dir; }
      } catch (e) { /* 单个目录失败不影响其它候选 */ }
    }
    if (best) cands.push(best);
  } catch (e) { /* ~/WorkBuddy 不存在 → 跳过该级 */ }
  cands.push(path.join(__dirname, 'prices'));
  cands.push('C:\\Users\\14779\\WorkBuddy\\2026-08-30-22-25-15\\prices');
  for (const c of cands) {
    if (!c) continue;
    try { if (fs.existsSync(path.join(c, 'index.json'))) return c; } catch (e) { /* 继续下一候选 */ }
  }
  return cands[0] || ''; // 均未命中 → 返回首个候选（触发既有告警与降级路径）
}
const CN_PRICE_DIR = autoDiscoverCnPriceDir();
const CN_PRICE_DB = path.join(CN_PRICE_DIR, 'index.json');
// 抓价流水线目录：同样自适应——优先环境变量，其次价库所在目录，最后旧硬编码。
const CN_PRICE_PIPELINE_DIR = process.env.CN_PRICE_PIPELINE_DIR
  || (CN_PRICE_DIR ? path.dirname(CN_PRICE_DIR) : 'C:\\Users\\14779\\WorkBuddy\\2026-08-30-22-25-15');
const CN_PRICE_REFRESH_LOCK = path.join(CN_PRICE_DIR, '.refresh.lock');
const CN_PRICE_REFRESH_ERR = path.join(CN_PRICE_DIR, '.refresh.error'); // v2.82：刷新失败原因留档
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
// v2.82.3：同步睡眠（Atomics.wait，零依赖、不耗 CPU）。
// 锁重试等待用——旧实现 while 空转 50×100ms 白烧一个核；Atomics.wait 阻塞事件循环但不再
// 空耗 CPU。适用于 Stop hook 这类单任务短命进程（阻塞期间无并发任务需要响应）。
// 极端环境 Atomics.wait 不可用时降级回空转（保底行为不变）。
const _SLEEP_SAB = new SharedArrayBuffer(4);
const _SLEEP_IA = new Int32Array(_SLEEP_SAB);
function syncSleepMs(ms) {
  try { Atomics.wait(_SLEEP_IA, 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

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
    syncSleepMs(retryDelay); // v2.82.3：真睡眠（原 while 空转烧 CPU）
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

// v2.82.1（2026-09-01）：弹窗耗时统一口径的计算核心（Stop 路径与测试复用）。
// 口径 = 最后一次 LLM 结束(latest trace endedAt) − 用户提交时刻(roundStartMs)。
// v2.74 用「单 trace 文件 startedAt→endedAt」，但长任务会落盘多个 trace（切分时机由客户端
// 决定、不可预测）：实测 11:27 的任务只显示 4:22——最新文件只是最后一段；有时单文件恰好
// 覆盖全轮又显示对——这就是「时对时错、修了还犯」的来源。WorkBuddy 显示的就是
// 「提交→最后一次 LLM 结束」的墙钟（实测 688s vs 687s，差 1s）。
// 返回 { durMs, source:'trace' } 或 { source:'fallback' }（条件不满足 → 调用方保留 transcript 口径）：
//   - ltPath 缺失 / roundStartMs<=0（快照丢失）/ endedAt 缺失或解析失败或早于起点（防负数/时钟异常）
//   - latest trace 带 sessionId 且 ≠ sid（多会话并发保护，与 v2.74 行为一致；sid 空视为不匹配）
function traceWallDurMs(ltPath, roundStartMs, sid, tsPath) {
  try {
    if (!ltPath || !(roundStartMs > 0)) return { source: 'fallback' };
    const tr = ((readTrace(ltPath) || {}).trace) || {};
    let tea = Date.parse(tr.endedAt || '');
    // v2.88：轮尾压缩盲区——压缩（contextSummary）不写 trace 文件，最新 trace 的 endedAt 停在
    // 模型回复结束，压缩段耗时被整个漏掉（实测 09-05：弹窗显示 4m6s、客户端实际 12m49s）。
    // 修复：endedAt 取 max(trace.endedAt, transcript 末行 timestamp)——压缩 marker/调用行的 ts
    // 覆盖压缩段。cap 在 Date.now() 防未来时间戳（测试数据）。
    try {
      if (tsPath && fs.existsSync(tsPath)) {
        const tl = lastTranscLine(tsPath);
        const tlTs = tl ? Number(tl.timestamp || 0) : 0;
        if (tlTs > tea) tea = Math.min(tlTs, Date.now());
      }
    } catch (e) {}
    if (!(tea > roundStartMs)) return { source: 'fallback' };
    const trSid = tr.sessionId ? String(tr.sessionId) : '';
    if (trSid && trSid !== String(sid || '')) return { source: 'fallback' };
    return { durMs: tea - roundStartMs, source: 'trace' };
  } catch (e) { return { source: 'fallback' }; }
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
  // v2.99（2026-09-10，测试发现的防御性加固）：token 数值统一做「数值化 + 非负钳制 + 取整」。
  //   原实现 `u.inputTokens || 0` 直接采信原值——若客户端把 token 数改成**字符串**（如 "100"），
  //   JS 隐式转换会让下游 `inSum += u.in` 变成**字符串拼接**（"100200"），账本彻底脏掉且难以察觉；
  //   负数/浮点同样会污染累加与计费。
  //   真实数据实测（9574 个样本）当前全为 int 且无负值，故本条为**防御性**改动、正常路径行为不变。
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const inT = num(u.inputTokens != null ? u.inputTokens : (u.input_tokens != null ? u.input_tokens : u.prompt_tokens));
  const outT = num(u.outputTokens != null ? u.outputTokens : (u.output_tokens != null ? u.output_tokens : u.completion_tokens));
  if (!inT && !outT) return null;
  let cached = 0;
  const det = u.inputTokensDetails || u.prompt_tokens_details || null;
  if (Array.isArray(det)) { for (const d of det) { if (d && d.cached_tokens) cached += num(d.cached_tokens); } }
  else if (det && typeof det === 'object') cached = num(det.cached_tokens);
  cached = num(cached);
  // v2.96：额外提取「思考 token」(reasoning)。实测本会话占输出 **63.8%**，此前完全未统计。
  //   仅**新增字段**，不改动 in/out/cached 语义；账本写入 addModelUsage() 显式只取
  //   in/out/cached/total，因此该字段**不会污染 daily-usage.json**。
  //   两个可能位点：usage.outputTokensDetails[] 与 rawUsage.completion_tokens_details。
  let reasoning = 0;
  const od = u.outputTokensDetails || u.completion_tokens_details || null;
  if (Array.isArray(od)) {
    for (const d of od) { if (d && typeof d.reasoning_tokens === 'number') reasoning += d.reasoning_tokens; }
  } else if (od && typeof od === 'object' && typeof od.reasoning_tokens === 'number') {
    reasoning = od.reasoning_tokens;
  }
  return { in: inT, out: outT, cached, reasoning };
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
  let reasoningSum = 0; // v2.96：思考 token 累计（仅用于弹窗展示，不写入账本）
  // v3.04（自适应·schema 漂移留痕）：统计「有 providerData 结构、却提取不出 usage」的行数。
  //   动机：上游若改了 usage 字段名，原实现会**静默 fallback**（读不到就当 0），
  //   技能安静地算错而你无从察觉 —— 这正是本轮反复出现的"静默失败"同类病。
  //   现改为：疑似漂移时**主动留痕**（仅在下面严格条件下触发），让"算错"变成"有据可查"。
  let missWithPd = 0;
  let firstTs = null, lastTs = 0, model = '', count = 0;
  for (const r of rows) {
    const ts = r.timestamp;
    if (!(typeof ts === 'number') || ts <= fromTs) continue;
    const pd = r.providerData || {};
    // v2.66：统一用 extractUsageFromRow，兼容 pd.usage / pd.rawUsage / message.usage
    const u = extractUsageFromRow(r);
    if (!u) {
      // v3.04：行内有 providerData 结构却提取不出 usage → 计入"疑似漂移"（无 providerData 的行不算，属正常）
      if (pd && typeof pd === 'object' && Object.keys(pd).length > 0) missWithPd++;
      continue;
    }
    const key = pd.messageId || pd.conversationRequestId || r.id || (r.type + ':' + ts);
    if (seen.has(key)) continue;
    seen.add(key);
    inSum += u.in; outSum += u.out; cachedSum += u.cached;
    reasoningSum += u.reasoning || 0; // v2.96：思考 token（仅展示）
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    if (!model) model = pd.model || pd.requestModelId || 'unknown'; // v2.82.2：模型名缺失 → 'unknown' 诚实标注（旧为 ''，弹窗显示空白且无法追查）
    count++;
  }
  if (!count) {
    // v3.04（自适应）：仅在**严格条件**下留痕，避免正常轮次刷日志——
    //   ① 本窗口内一条 usage 都没解析出来（count === 0，确实异常）
    //   ② 且有 ≥3 行带 providerData（排除"本就是纯消息轮/空轮次"的正常情况）
    //   触发即说明：上游可能改了 usage 字段结构。留痕后可在 compaction log 中检索
    //   `schema-drift-suspect` 定位，而不再是无从察觉地算错。
    if (missWithPd >= 3) {
      try { appendCompactionLog('schema-drift-suspect', { missWithPd, totalRows: rows.length, fromTs }); } catch (e) { /* 留痕失败不阻塞 */ }
    }
    return null;
  }
  return { in: inSum, out: outSum, cached: cachedSum, total: inSum + outSum, durMs: Math.max(0, lastTs - (firstTs || lastTs)), model, firstTs, lastTs, count, reasoning: reasoningSum };
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

// v2.98（2026-09-10）：升级为「返回带形态信息的子代理模型表」，以支持区分两种协作形态。
// 背景：WorkBuddy 有两类多代理形态（官方文档 workbuddy.cn/docs/cli/agent-teams 明确区分）——
//   ① **Sub-agents（子代理）**：单会话内运行、只向主代理汇报；内置类型 Explore / Plan / general-purpose。
//   ② **Agent Teams（专家团）**：成员完全独立、可互相通信、有共享任务列表；成员有**分配的颜色**。
// 实测可区分特征（本项目 86 个子代理转录）：
//   · 两者转录内均有 `providerData.isSubAgent === true`（最硬的"是子代理"证据）；
//   · 普通子代理 `providerData.agent` = 内置类型名（如 "Explore"），**无** agentColor；
//   · 专家团成员 `providerData.agent` = 专家角色名（topic-researcher / prototype-builder 等），**有** agentColor。
// 返回：Map<normalizedModel, { isTeam: boolean, names: Set<string> }>
// 设计原则不变：纯读取、不改任何现有数据结构；异常一律返回空 Map → 调用方退化为不标注。
function subagentModelSet(tsPath, roundStartMs) {
  const map = new Map();
  if (!tsPath) return map;
  const since = Number(roundStartMs) || 0;
  const add = (model, isTeam, name) => {
    const k = normalizeModelName(model);
    if (!k) return;
    let e = map.get(k);
    if (!e) { e = { isTeam: false, names: new Set() }; map.set(k, e); }
    if (isTeam) e.isTeam = true;              // 任一成员带颜色 → 视为专家团
    if (name) e.names.add(String(name));
  };
  try {
    // 1) 收集本轮子代理转录中的模型与形态
    const subDir = subagentsDirFromTranscript(tsPath);
    if (!fs.existsSync(subDir)) return map;
    for (const f of fs.readdirSync(subDir)) {
      if (!/\.jsonl?$/i.test(f)) continue;
      const fp = path.join(subDir, f);
      try { if (since && fs.statSync(fp).mtimeMs < since) continue; } catch (e) { continue; }
      for (const r of readTranscLines(fp)) {
        const pd = (r && r.providerData) || {};
        const nm = pd.model;
        if (!nm) continue;
        // isSubAgent 为最硬证据；缺失时靠"来自 subagents/ 目录"这个事实兜底（等价旧行为）
        const isSub = pd.isSubAgent === true || pd.isSubAgent === undefined;
        if (!isSub) continue;
        add(nm, !!pd.agentColor, pd.agent); // 有 agentColor ⇒ 专家团成员
      }
    }
    if (!map.size) return map;
    // 2) 减去本轮主转录出现过的模型（主模型同名的场景不该被标注）——读取失败必须清空，宁可漏标不可误标
    for (const r of readTranscLines(tsPath)) {
      const ts = r && r.timestamp;
      if (since && !(typeof ts === 'number' && ts > since)) continue;
      const nm = (r && r.providerData || {}).model;
      if (nm) map.delete(normalizeModelName(nm));
    }
  } catch (e) {
    map.clear(); // 任何异常 → 不标注，退化为原行为
  }
  return map;
}

// v2.98：把形态信息格式化为弹窗标注后缀。
//   专家团 → 「（专家团使用）」；普通子代理 → 「（子代理使用）」；未知 → 「（子代理使用）」保守兜底。
function subagentTagOf(entry) {
  if (!entry) return '';
  return entry.isTeam ? '（专家团使用）' : '（子代理使用）';
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
  // v3.11：区分「主模型」与「子代理模型」（**仅供显示**）。历史根因：下面的 model 字段是
  //   `sub.model || main.model`（子代理优先）→ 团队轮标题显示成子代理模型（如 hy3），用户误以为自己的模型变了。
  //   ⚠️ 但 `model` 字段**不能改**——`calcCost`（:2197）用它取价目表算全轮费用，改了会让费用静默换价目表。
  //   因此新增 modelMain（主转录主导模型）与 subModels（子代理模型，按 token 降序去重）专供弹窗显示。
  const subModels = (() => {
    try {
      const m = perModelFromRows(subRows, 0);
      return Object.entries(m)
        .filter(([n, b]) => n && b && b.total > 0)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([n]) => n);
    } catch (e) { return []; }
  })();
  const res = {
    in: (main ? main.in : 0) + (sub ? sub.in : 0),
    out: (main ? main.out : 0) + (sub ? sub.out : 0),
    cached: (main ? main.cached : 0) + (sub ? sub.cached : 0),
    model: (sub && sub.model) || (main && main.model) || '',
    modelMain: (main && main.model) || (sub && sub.model) || '',
    subModels,
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

// v3.12（异常轮拆分弹窗兜底）：只聚合【主转录】——异常轮 Stop 时子代理仍在跑，先弹主模型条用。
//   复用 aggregateTranscLines(readTranscLines(tsPath), roundStartMs)，返回形状与 aggregateTranscript 一致
//   （model/in/out/cached/total/durMs/count…）；不带 subModels（避免 toastLine1 显示成"子代理标注"）。
function aggregateMainOnly(tsPath, roundStartMs) {
  try { return aggregateTranscLines(readTranscLines(tsPath), roundStartMs); }
  catch (e) { return null; }
}

// v3.12：只聚合【子代理文件】（subagents/agent-*.jsonl 中 mtime > roundStartMs 的），用于异常轮补弹"子代理部分"。
//   返回形状同 aggregateTranscript：model 用子代理主导模型（按 token 最多），subModels 填子代理模型列表；
//   不含主模型用量（否则与主模型条重复）。
function aggregateSubsOnly(tsPath, roundStartMs) {
  const subDir = subagentsDirFromTranscript(tsPath);
  if (!fs.existsSync(subDir)) return null;
  let subRows = [];
  try {
    for (const f of fs.readdirSync(subDir)) {
      if (!/^agent-.*\.jsonl$/i.test(f)) continue;
      const fp = path.join(subDir, f);
      let mt = 0;
      try { mt = fs.statSync(fp).mtimeMs; } catch (e2) { continue; }
      if (mt <= roundStartMs) continue; // 本轮之前创建的子代理（上一轮专家团）→ 排除
      subRows = subRows.concat(readTranscLines(fp));
    }
  } catch (e) { return null; }
  if (!subRows.length) return null;
  // v3.12.1 加固（2026-09-23）：原先两处都传 0（=不做内部时间戳过滤），仅靠文件 mtime 归属本轮——
  //   若 mtime 被外部改动（备份还原 / 复制文件），会把**旧轮**的行也算进来（实测：夹具出现"耗时 301 小时"、
  //   金额被放大）。改为传 roundStartMs 做**行级 timestamp 二次过滤**，与主聚合口径一致。
  const sub = aggregateTranscLines(subRows, roundStartMs);
  if (!sub) return null;
  // 主导模型：按 token 最多；subModels 列表（同样按行级 timestamp 过滤）
  const byModel = perModelFromRows(subRows, roundStartMs);
  const subModels = Object.entries(byModel)
    .filter(([n, b]) => n && b && b.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([n]) => n);
  const dominant = subModels.length ? subModels[0] : sub.model;
  return {
    in: sub.in, out: sub.out, cached: sub.cached, total: sub.total,
    model: dominant, modelMain: dominant, subModels,
    count: sub.count, durMs: sub.durMs, firstTs: sub.firstTs, lastTs: sub.lastTs, reasoning: sub.reasoning,
  };
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
  const cutoff = Date.now() - (windowMs || SUBAGENT_IDLE_MS);
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
// v2.83：手动取消漏弹修复的判据函数——从 transcript 行中提取「取消标记」（role=assistant +
// status=incomplete + providerData.error.message 精确为 "Interrupted by user"）。
// v2.84 续跑判定修正：取消后【先 user 新消息再 assistant 回复】= 新轮次（正常取消流程，补弹）；
// 取消后【直接 assistant 回复】（中间无 user 消息）= 续跑（不补弹）。
// v2.83 初版误把"取消→用户新消息→模型回复"判成续跑，导致真实取消场景全部漏弹（实测 ab3c8bf6）。
// 返回 [{ts}] 列表。
// 与 interruptedByUser（watcher 即时信号）不同：这里只看主 transcript（hook 端无子代理上下文）。
function interruptedRowsAfter(rows, roundStartMs) {
  const out = [];
  let lastIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.type !== 'message') continue;
    const isCancel = r.role === 'assistant' && r.status === 'incomplete'
      && r.providerData && r.providerData.error
      && /^Interrupted by user$/i.test(String(r.providerData.error.message || '').trim());
    // ⚠️ 勿用 providerData.skipRun 作取消判据（2026-09-22 全库实证）：207 个 transcript 中
    //    183/183 条真实取消标记**全部**带 providerData.skipRun=true —— 它是应用中止在飞请求时的
    //    通用字段（用户点停止 / 编辑重发 / 分叉 都会写），**不是"编辑重发"的特征**。
    //    据此排除会 100% 灭掉真实取消检测。真正有效的是下方"后续完成行即否决"（修复1b）。
    if (isCancel && (Number(r.timestamp) || 0) > (roundStartMs || 0)) {
      out.push({ ts: Number(r.timestamp), idx: i }); lastIdx = i;
    }
  }
  if (lastIdx >= 0) {
    // v3.10 关键修正（2026-09-22 全库实证）：否决条件**只能**是"该轮被编辑重发/分叉"，不能是"其后有完成行"。
    //   证据：247 处取消标记分类 → E=12（有精确 resend-fork 匹配 = 真编辑重发）、
    //   C=208（**无** resend、标记后先出现普通用户提问、再出现完成行 = 真取消 + 用户随后又提问）、U=27。
    //   若按"后续有完成行"否决，误杀率 = 208/220 = **94.5%**，后果正是 v2.83 治过的病：
    //   取消轮不补弹 → 其 token 静默并入下一轮（历史实证 108.7 万并入下轮、显示 25m3s）。
    //   现改为精确匹配：取标记之前最近一条 role==='user' 消息的 id，全文找 type==='resend-fork-notice'
    //   且 editedUserItemId 等于该 id 的行 → 命中才否决（2026-09-22 事故正是此形态，仍被挡住）。
    let prevUserId = null;
    for (let j = lastIdx - 1; j >= 0; j--) {
      const rj = rows[j];
      if (rj && rj.type === 'message' && rj.role === 'user' && rj.id) { prevUserId = rj.id; break; }
    }
    if (prevUserId) {
      for (let j = 0; j < rows.length; j++) {
        const rj = rows[j];
        if (rj && rj.type === 'resend-fork-notice' && String(rj.editedUserItemId) === String(prevUserId)) return [];
      }
    }
  }
  return out;
}

function interruptedByUser(tsPath) {
  if (!tsPath) return false;
  const intrIn = (r) => {
    if (!r || r.type !== 'message') return false;
    if (r.role !== 'assistant') return false; // v2.49：真正的中断标记是 assistant（主模型输出被中断），排除 role=user 的摘要
    // ⚠️ 此处禁止加 skipRun 判据：183/183 真实取消均带 providerData.skipRun=true（见 interruptedRowsAfter 顶部注释）。
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
// ===== 本地官方价格库合并 + 每日刷新（v2.80, 2026-08-31）=====
// 归一化口径：本库 key 已是「小写去连字符/点」形态，与 normalizeModelName(保留连字符) 不同。
// 同模型识别用 alnumKey（仅字母数字），避免 glm-5.3-flash 与 glm53flash 出现双条目。
function alnumKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// 峰谷绝对价 → 倍数（非整齐倍数时保留换算值并由 tier_note 提示人工核验）
function peakMultiplierOf(peak) {
  if (!peak || !peak.idle || !peak.peak) return null;
  const i = Number(peak.idle.in), p = Number(peak.peak.in);
  if (!(i > 0) || !(p > 0)) return null;
  return Math.round((p / i) * 100) / 100;
}

// 把 prices/index.json 合并进内存 pricing（每次 loadPricing 都重读 → 永远用当天/最近一份完整库）。
// 优先级：pricing.json 的 lock 项 > 本地官方库 > pricing.json 其他（聚合自动补录）。
// 合并条目只存在于内存（price_source 以「本地官方库」开头），写盘前由 stripLocalDbEntries 剥离。
function mergeLocalPriceDb(pricing) {
  if (!pricing || typeof pricing !== 'object') return pricing;
  if (!pricing.models || typeof pricing.models !== 'object') pricing.models = {};
  let db = null;
  // v2.81.2：Windows 下 os.replace 与读取并发时可能读到空文件 → 失败重读一次（60ms 后），
  // 仍失败则沿用 pricing.json（原子写保证旧完整版仍在，只是恰好撞上替换窗口）
  for (let attempt = 0; attempt < 2; attempt++) {
    try { db = JSON.parse(fs.readFileSync(CN_PRICE_DB, 'utf-8')); break; }
    catch (e) { if (attempt === 0) { require('child_process').execSync('ping -n 1 -w 60 127.0.0.1 >NUL', { stdio: 'ignore' }); } }
  }
  if (!db) {
    // v2.96：价库缺失不再静默。原先直接 return pricing，会让国内模型价格悄悄退化为聚合源/估算价，
    //   全程无任何提示（与 Exa 断链同类"静默失效"病）。此处仅**增加告警**，不改路径解析逻辑，
    //   避免牵动 CN_PRICE_REFRESH_LOCK / _ERR 等同目录文件带来的联动风险。
    //   仅当文件确实不存在时告警，避开原子替换的正常窗口。
    try {
      if (!fs.existsSync(CN_PRICE_DB)) {
        process.stderr.write('[token-tracker] ⚠️ 本地官方价库缺失: ' + CN_PRICE_DB + '（国内模型价格将退化为聚合源/估算价，请检查该目录是否被移动/删除）\n');
      } else {
        // v2.99（测试发现的漏洞修复）：文件**存在但解析失败**（JSON 损坏 / 半写 / 被截断）——
        //   这比"缺失"更危险：用户看到文件还在，不会怀疑价库有问题，而国内模型其实已静默无价。
        //   原实现只在"不存在"时告警，此处补齐"存在但损坏"分支。
        process.stderr.write('[token-tracker] ⚠️ 本地官方价库已损坏（JSON 解析失败）: ' + CN_PRICE_DB + '（国内模型将无价可用、费用显示为空，请检查该文件）\n');
      }
    } catch (e) { /* 忽略：告警本身不得影响主流程 */ }
    return pricing;
  }
  const byAlnum = {};
  for (const key of Object.keys(pricing.models)) {
    const ak = alnumKey(key);
    if (ak && !byAlnum[ak]) byAlnum[ak] = key;
  }
  let mergedCount = 0;
  for (const [k, v] of Object.entries(db.models || {})) {
    if (!v || typeof v.in_price !== 'number' || typeof v.out_price !== 'number') continue; // 坏数据不收
    const ak = alnumKey(k);
    const existingKey = byAlnum[ak];
    if (existingKey && pricing.models[existingKey] && pricing.models[existingKey].lock === true) continue; // lock 永远赢
    const rec = {
      name: v.name || k,
      input_price: v.in_price,
      output_price: v.out_price,
      // v2.81：官方页未列缓存价 → 不能按 0 元计（calcCost 对 null 取 0 会把缓存 token 免单），
      // 保守按输入价计（= 无缓存折扣假设），宁可略微高估也不算错账
      cached_price: (typeof v.cache_hit === 'number') ? v.cache_hit : v.in_price,
      region: 'CN',
      price_source: '本地官方库(' + String(v.primary_source || '').replace(/^本地官方库\(|\)$/g, '').slice(0, 40) + ')',
    };
    if (typeof v.cache_hit !== 'number') {
      rec.tier_note = '缓存价官方未列，按输入价保守计';
    }
    if (v.peak && v.peak.idle && v.peak.peak) {
      const mult = peakMultiplierOf(v.peak);
      if (mult && Math.abs(mult - 2) < 0.05) rec.peak_multiplier = 2;
      else if (mult) { rec.peak_multiplier = mult; rec.tier_note = '峰谷非整数倍(' + mult + '×)，需人工核验'; }
    }
    if (v.tier_note) rec.tier_note = (rec.tier_note ? rec.tier_note + '；' : '') + String(v.tier_note).slice(0, 80);
    if (existingKey) Object.assign(pricing.models[existingKey], rec); // 覆盖非 lock 旧条目（聚合旧价→今日官方价），保留原 key 名
    else { pricing.models[k] = rec; byAlnum[ak] = k; }
    mergedCount++;
  }
  if (Array.isArray(db.peak_rules) && db.peak_rules.length) pricing.peak_rules = db.peak_rules;
  pricing.local_db = { built_at: db.built_at || null, models: mergedCount };
  return pricing;
}

// 写盘前剥离本地官方库合并条目 + 峰谷规则（它们由 index.json 每日重建，不入 pricing.json，
// 避免与聚合源复检互相覆盖/膨胀；peak_rules 仅本地库持有）
function stripLocalDbEntries(pricing) {
  let out;
  try { out = JSON.parse(JSON.stringify(pricing)); } catch (e) { return pricing; }
  if (out.models) {
    for (const k of Object.keys(out.models)) {
      const ps = out.models[k] && out.models[k].price_source;
      if (typeof ps === 'string' && ps.indexOf('本地官方库') === 0) delete out.models[k];
    }
  }
  delete out.local_db;
  delete out.peak_rules;
  return out;
}

// 每日强制更新本地官方库（非阻塞）：built_at != 今天 → 后台跑抓取流水线（实测约12s），不等它。
// 刷新没跑完时 loadPricing 读到的仍是磁盘上 last 一份完整 index.json（前一天），天然兜底。
// v2.81 失败治理（用户要求）：退避重试 3min→10min→30min→60min，当日失败满 5 次熔断——
//   防止「整天失败=整天无限重拉」；熔断期间沿用前一天库+聚合源，次日自动恢复。
// python 不存在时自动回退 python3（ENOENT 才回退，其他错误照常计失败）。
// 弹窗提示：失败/熔断期间 periodNote 会带 ⚠价库M/D 标注（见 dbStaleTag），用户可见可修。
let gLocalDbRefreshKicked = false;
let gPythonExe = null; // 缓存已解析的 python 绝对路径
// 解析可用的 python（绝对路径优先）：裸 `python` 若不在 PATH，cmd 会把 .py 当文档执行→
// 弹「选择打开方式」对话框（v2.81 实测用户被弹）。
// 顺序：CN_PYTHON env → WorkBuddy venv（有 requests） → WorkBuddy 自带解释器 → python → python3。
// v2.82（2026-09-01）两处修复（本地官方价库自动刷新从未成功，built_at 永远停在前一天）：
//   ① 候选表漏了 venv 路径 → 命中托管裸解释器（无 requests）→ 流水线 import requests 即崩。
//   ② 探测命令 print(1) 只能证明"python 能跑"，不能证明"依赖齐全" → 裸解释器先命中，
//      永远轮不到 venv。改为两轮探测：先 `import requests`，全灭才降级 `print(1)`。
function resolvePython(cb, _pass) {
  if (gPythonExe) return cb(gPythonExe);
  const pass = _pass || 0; // 0=校验依赖齐全；1=仅校验可运行（兜底，让脚本自己报错，好过静默熔断）
  const cands = [];
  if (process.env.CN_PYTHON) cands.push(process.env.CN_PYTHON);
  try {
    const pyRoot = path.join(os.homedir(), '.workbuddy', 'binaries', 'python');
    // venv 优先：第三方依赖（requests）只装在这里
    try {
      const envsRoot = path.join(pyRoot, 'envs');
      const envs = fs.readdirSync(envsRoot).filter((d) => !d.startsWith('.'));
      const ordered = envs.includes('default') ? ['default', ...envs.filter((e) => e !== 'default')] : envs;
      for (const e of ordered) {
        for (const rel of [['Scripts', 'python.exe'], ['bin', 'python'], ['bin', 'python3']]) {
          const p = path.join(envsRoot, e, ...rel);
          if (fs.existsSync(p)) cands.push(p);
        }
      }
    } catch (e) {}
    // 托管理论裸解释器兜底（通常无第三方依赖，排 venv 之后）
    const base = path.join(pyRoot, 'versions');
    const vers = fs.readdirSync(base).filter((d) => /^3\d*\.\d+/.test(d)).sort().reverse();
    for (const v of vers) cands.push(path.join(base, v, 'python.exe'));
  } catch (e) {}
  cands.push('python', 'python3');
  const probe = pass === 0 ? 'import requests' : 'print(1)';
  let i = 0;
  const tryNext = () => {
    if (i >= cands.length) {
      if (pass === 0) return resolvePython(cb, 1); // 依赖级探测全灭 → 降级为可运行级
      return cb(null);
    }
    const exe = cands[i++];
    let c;
    try { c = require('child_process').spawn(exe, ['-c', probe], { windowsHide: true, stdio: 'ignore', shell: false }); }
    catch (e) { return tryNext(); }
    let settled = false;
    const fin = (ok) => { if (!settled) { settled = true; if (ok) { gPythonExe = exe; cb(exe); } else tryNext(); } };
    c.on('exit', (code) => fin(code === 0));
    c.on('error', () => fin(false));
  };
  tryNext();
}

function maybeRefreshLocalDb() {
  const BACKOFF = [180000, 600000, 1800000, 3600000]; // 第1/2/3/4次失败后分别等 3/10/30/60 分钟
  const MAX_ATTEMPTS = 5;                              // 当日第5次起熔断
  const readLock = () => {
    try { return JSON.parse(fs.readFileSync(CN_PRICE_REFRESH_LOCK, 'utf-8')); } catch (e) { return null; }
  };
  if (gLocalDbRefreshKicked) return;
  let builtAt = '';
  try { builtAt = String(JSON.parse(fs.readFileSync(CN_PRICE_DB, 'utf-8')).built_at || ''); } catch (e) { builtAt = ''; }
  if (builtAt === todayStr()) return; // 今天已重建成功
  const lk = readLock();
  const attempts = (lk && lk.day === todayStr()) ? (Number(lk.attempts) || 0) : 0;
  if (attempts >= MAX_ATTEMPTS) return; // 当日熔断
  if (attempts > 0) {
    const wait = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
    if (Date.now() - Number(lk.at) < wait) return; // 退避窗口内不重试
  }
  gLocalDbRefreshKicked = true;
  try {
    fs.writeFileSync(CN_PRICE_REFRESH_LOCK, JSON.stringify({ at: Date.now(), attempts: attempts + 1, day: todayStr() }));
    // v2.81.1 修复：每一段都必须带 python 前缀——裸 .py 会被 cmd 按文档关联执行，
    // 弹「选择打开方式」对话框（实测用户被弹）。exe 用绝对路径（resolvePython 解析）。
    resolvePython((exe) => {
      if (!exe) return; // 系统无 python：保留锁按退避节奏静默重试，弹窗⚠标注可见
      const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
      const cmd = `${q(exe)} fetch-cn-prices.py && ${q(exe)} parse_tokenhub.py && ${q(exe)} build_index.py`;
      // v2.82：捕获输出 + 超时保护。旧版 stdio:'ignore' 导致失败完全静默（用户只能看到
      // ⚠价库M/D 却查不到原因）；网络 hang 时子进程永不退出 → 锁永久卡死不再重试。
      const REFRESH_TIMEOUT_MS = 180000; // 实测约 12s，给足 3 分钟
      let c;
      let out = '';
      try {
        c = require('child_process').spawn(cmd, {
          cwd: CN_PRICE_PIPELINE_DIR, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return noteRefreshFailure(attempts + 1, 'spawn 失败: ' + String(e.message).slice(0, 200));
      }
      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        try { c.kill('SIGKILL'); } catch (e) {}
      }, REFRESH_TIMEOUT_MS);
      try {
        c.stdout && c.stdout.on('data', (b) => { if (out.length < 4000) out += String(b); });
        c.stderr && c.stderr.on('data', (b) => { if (out.length < 4000) out += String(b); });
      } catch (e) {}
      c.on('exit', (code) => {
        clearTimeout(killTimer);
        if (code === 0) {
          try { fs.unlinkSync(CN_PRICE_REFRESH_LOCK); } catch (e) {}
          try { fs.unlinkSync(CN_PRICE_REFRESH_ERR); } catch (e) {}
          return;
        }
        noteRefreshFailure(attempts + 1, (timedOut ? `超时 ${REFRESH_TIMEOUT_MS}ms 被杀` : `exit=${code}`) + ' | ' + tail(out, 400));
      });
      c.on('error', (e) => {
        clearTimeout(killTimer);
        noteRefreshFailure(attempts + 1, 'error: ' + String(e.message).slice(0, 200));
      });
    });
  } catch (e) { /* 静默：刷新失败沿用旧库，弹窗会有 ⚠价库 标注 */ }
}

// v2.82：把失败原因落到磁盘（prices/.refresh.error），让 ⚠价库M/D 提示可被追溯，不再盲猜。
function noteRefreshFailure(attempts, reason) {
  try {
    fs.writeFileSync(CN_PRICE_REFRESH_ERR, JSON.stringify({
      at: Date.now(), atLocal: new Date().toLocaleString('zh-CN'), attempts, day: todayStr(), reason,
    }, null, 2));
  } catch (e) {}
}
function tail(s, n) { return String(s || '').replace(/\s+/g, ' ').slice(-n); }

function loadPricing() {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { return null; }
  try { p = mergeLocalPriceDb(p); } catch (e) {}
  try { if (ENABLE_NETWORK) maybeRefreshLocalDb(); } catch (e) {}
  return p;
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

  // 1.5) v2.82（2026-09-01）：去标点匹配（alnum）。本地官方价库 index.json 的 key 是
  // 去标点归一化名（glm53 / glm53flash / deepseekv4flash），而实际模型名带标点（glm-5.3）。
  // normalizeModelName 保留标点 → 步骤1 失配；且 'glm-5.3' 与 'glm53' 互不为子串 →
  // 步骤3 也救不了。结果：明明本地库有准确的官方人民币价（8/28/2），却判定未收录，
  // 每次弹窗都走一遍联网补录（慢），失败还会按 OpenRouter 美元估算价记账（不准）。
  // 补这一级后 glm-5.3→glm53 直接命中本地官方价，不再联网、不再误报未收录。
  const normAlnum = alnumKey(modelName);
  if (normAlnum) {
    for (const key of keys) {
      if (alnumKey(key) === normAlnum) return { key, m: models[key] };
    }
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

  // 3) 计费模式（v2.82.1 收紧）：仅「边界分隔」匹配，且**单向**——只允许具体模型名命中
  //    家族/前缀 key（norm 较长，key 是它的边界子串）。反向（kimi→kimik25、gemini-3.7→
  //    gemini-3.7-flash 这种家族短名）一律拒绝：撞哪个 key 取决于遍历顺序、且撞到的是
  //    家族里最高价版本，错价风险最大 → 返回 null 走联网补价。
  //    旧 v2.71 双向 includes 任意子串会把未收录模型撞到无关 key（glm-5.3-air→glm-5 价），
  //    且 ensureNewModelPricing 因「宽松命中=已收录」不再联网补真价 → 错价永久化。
  //    收紧后：hy3-x→hy3、deepseek-ai/DeepSeek-V4-Flash→deepseek-v4-flash 仍宽松命中
  //    （边界 - 和 /）；kimi→null、gemini-3.7→null、glm-5.3-air→null（. 不是边界）。
  if (mode === 'price') {
    const BOUND = /[-/_: \u4e00-\u9fa5]/;
    const boundaryHit = (short, long) => { // short 是 long 的子串且两侧均为边界
      if (!long.includes(short)) return false;
      const i = long.indexOf(short);
      const leftOk = i === 0 || BOUND.test(long.charAt(i - 1));
      const rightOk = (i + short.length) === long.length || BOUND.test(long.charAt(i + short.length));
      return leftOk && rightOk;
    };
    let best = null; // { key, m, len }
    for (const key of keys) {
      const kn = normalizeModelName(key);
      if (!kn || kn.length > norm.length) continue; // 只允许「norm 较长」方向（拒绝家族短名反向撞）
      if (boundaryHit(kn, norm) && (!best || kn.length > best.len)) best = { key, m: models[key], len: kn.length };
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
  // v2.95：统一按**北京时间**判定峰谷，与 recalc-day.js 的 isPeakBeijing 口径一致。
  //   原实现用机器本地时区（t.getDay()/getHours()），非 GMT+8 机器会与回填工具判定相悖。
  //   换算：UTC = local + getTimezoneOffset()分钟；北京时间 = UTC + 8h。
  //   GMT+8 机器下两者恒等 → **零行为变化**（已验算：offset=-480 时 bj 时刻 === t 时刻）。
  const bj = new Date(t.getTime() + t.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  const day = bj.getDay();
  const h = bj.getHours() + bj.getMinutes() / 60;
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
  const modelName = String(stat.model || '').trim();
  // v2.82.2：模型名缺失（空串 / unknown）不记价——「不知道模型名字还记价个毛」。
  // 旧代码 fallback 'deepseek-v4-flash' 会把缺名 token 按 v4-flash 价入账（错价）。
  if (!modelName || modelName === 'unknown') return null;
  if (isLocalModel(modelName)) return null; // 本地模型不计费（即使 pricing 误收录也不按云端价算）
  const hit = findModel(pricing, modelName, 'price'); // v2.71：计费模式（精确失败后边界匹配近似取价）
  if (!hit) return null;
  const m = hit.m;
  // 峰谷倍率：DeepSeek 系（不论后缀）统一执行峰谷规则 + 周末低峰（v2.59 用户规则）。
  // 判定：模型名含 'deepseek' 即强制套用峰谷倍率（peak_multiplier 缺省按 2），
  // 再经 isPeakHour()（已含周末→全天×1）；非 DeepSeek 系维持原行为：显式声明 peak_multiplier 才翻倍。
  const isDeepSeek = /(^|[\/\-_])deepseek/i.test(String(stat.model || ''));
  const peakMult = isDeepSeek ? (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 2) : (typeof m.peak_multiplier === 'number' ? m.peak_multiplier : 1);
  // 时段判定跟随官方 deepseek_rules（通用：官方调时段/周末规则自动生效）
  const mult = isPeakHour(pricing.deepseek_rules) ? peakMult : 1;
  // v2.99（测试发现的防御性加固）：cached / out 补非负钳制。
  //   原实现 in 侧已有 Math.max(0,...)，但 cached 与 out 仅用 (v || 0)——负数会直接参与计算：
  //   · 负 out → 总价变负，污染当日账本合计；
  //   · 负 cached → uncached = max(0, in-cached) 反向变大，账单被静默放大。
  //   真实数据（9574 样本）当前无负值，属防御性改动；正数路径结果完全不变。
  const cached = Math.max(0, Number(stat.cached) || 0);
  const outTok = Math.max(0, Number(stat.out) || 0);
  const uncached = Math.max(0, Math.max(0, Number(stat.in) || 0) - cached);
  const cost = (uncached / 1e6) * (m.input_price || 0) * mult
             + (cached / 1e6) * (m.cached_price || 0) * mult
             + (outTok / 1e6) * (m.output_price || 0) * mult;
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
    const parsed = normalizeDailyUsage(JSON.parse(fs.readFileSync(DAILY_USAGE_FILE, 'utf-8')));
    gDailyCorrupt = false; // v2.99：只在**成功解析**后清除标志
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 文件尚不存在 → 视为空账本（首次运行），**不在此处臆断地清除 gDailyCorrupt**。
      // v2.99（测试发现的"日志与行为不符 + 历史丢失"修复）：
      //   原实现把 `gDailyCorrupt = false` 放在函数**开头**，导致同一进程内第二次调用时，
      //   因文件已被本轮重命名为 .corrupt-<ts> 而走 ENOENT 分支 → 标志被清 → recordUsage 不再跳过
      //   → 用空账本写回，历史累计丢失（而日志仍声称"本轮不写回覆盖"，与实际行为矛盾）。
      //   现在标志只由"成功解析"来清除，损坏状态在本进程内保持，确保跳过写入生效。
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
  // v3.06（审查结论·**刻意保持当前顺序，不要"修正"它**）：
  //   表面看这个守卫像是"死代码"——`gDailyCorrupt` 初始为 false，而真正置位它的 `loadDailyUsage()`
  //   在下面（锁内）才执行，于是首次遇损坏时本守卫不会命中。
  //   但实测确认：**这是良性的、且优于"修正"后的行为**——
  //     当前顺序：损坏 → 备份为 `.corrupt-<ts>` → 用本轮用量**新建**账本 → **本轮用量不丢**，历史亦在备份中 ✓
  //     若改为"先 loadDailyUsage() 再判断"（看似更严谨）：损坏 → 备份 → 守卫命中 → **跳过写入 → 本轮用量丢失** ✗
  //   另外该守卫并非完全无效：同一进程内**第二次**调用 recordUsage 时，`gDailyCorrupt` 已被置为 true，
  //   此时会正确跳过（避免二次覆盖）。每轮通常只调用一次，故该分支很少触发。
  //   结论：**保持现状**。此处仅补充注释，避免后人误"修正"。
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
  // v2.99（测试发现的重复计费修复）：**不再自动回退 .bak**。
  //   原实现：主文件损坏 → 回退 .bak。但 .bak 是 saveLedgerWatermark 在写入**前**复制的旧主文件，
  //   恒落后一个保存周期 → 回退它等于把「上次保存 → 本次保存」之间**已记账的增量重放一遍** = 重复计费。
  //   这与下方注释确立的原则（宁可少记也不重复计费）直接冲突。
  //   （实测复现：主文件损坏回退 .bak 后，账本多出 5500 in / 1600 out，恰为两行已记增量被重放。）
  //   改为：主文件损坏 → 直接跳过本轮记账；.bak 仍留在磁盘上，**仅供人工恢复**。
  const bak = LEDGER_WATERMARK_FILE + '.bak';
  const hasBak = (() => { try { return fs.existsSync(bak); } catch (e) { return false; } })();
  if (fs.existsSync(LEDGER_WATERMARK_FILE)) {
    process.stderr.write(`[token-tracker] 水位线已损坏，本轮跳过记账以避免重复计费（确认后请手动删除 ${path.basename(LEDGER_WATERMARK_FILE)} 再重记）`
      + (hasBak ? `；.bak 备份仍在（${path.basename(bak)}），但它恒落后一个保存周期，**直接覆盖会导致重复计费**，仅在人工核对进度一致后方可使用` : '')
      + '\n');
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
// v2.82.1：整个「读水位线→算增量→记账→推进」序列放入水位线锁（.ledger-watermark.lock）——
// watcher(--flush-delayed) 与新一轮 Stop 并发时，两进程可能读到同一旧水位线 → 同一批行
// 各记一遍 = 账本重复计费（专家团 6s 确认窗 ∩ 新 Stop 真实可触发）。串行化后：后到者读到
// 先到者推进的新水位线，只记增量。锁获取失败 → 本轮跳过（下轮 Stop 补记，不丢不重）。
function incrementalRecord(tsPath, sid) {
  if (!tsPath || !fs.existsSync(tsPath)) return;
  withFileLock(LEDGER_WATERMARK_FILE + '.lock', () => {
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
  }, { ttl: 300000, retries: 30, retryDelay: 100 }); // v2.82.1：水位线锁；拿不到锁 → 本轮跳过，下轮补记
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
function showToast(line1, line2, reason, tsPath) {
  // v2.63.1：把实际文案拼进诊断日志；合并最近 watcher 轮询快照字段（gLastWatchState），
  // 字段缺失时 writeToastLog 内部以 null 兜底，绝不因诊断而影响弹窗。
  const toastState = Object.assign({}, gLastWatchState || {});
  toastState.toastText = String(line1 || '') + ' | ' + String(line2 || '');
  writeToastLog(reason, toastState);
  // v2.90：测试静默开关——TOKEN_TRACKER_NO_TOAST=1 时只写诊断日志、不调系统通知。
  // 【硬规矩（用户 2026-09-05 两次强调，已记 ~/.workbuddy/MEMORY.md）：一切测试/回放必须设此开关，
  // 禁止真弹窗与控制台闪烁骚扰前台】。诊断日志先行（上方 writeToastLog），断言照旧基于 toast 日志。
  if (process.env.TOKEN_TRACKER_NO_TOAST === '1') return;
  // v2.90：撤销 v2.87 的跨进程弹窗抑制（toastSuppressCheck）——实测误杀真弹窗：短轮（纯问答）
  // 每轮只往 transcript 加 2~4 行，"行数差<10=同轮重复"的假设不成立（实测 18:48 吞掉全新轮弹窗，
  // compaction log toast-suppressed 铁证）。它防的"同轮双弹"已被 v2.86 聚合起点根修覆盖，
  // 残余场景（watcher 被杀时重复弹）概率低且后果轻——误杀代价 >> 防重复收益，整体撤除。
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
  // v3.11：**显示**优先用主转录模型 `modelMain`（团队轮时 `stat.model` 会被子代理模型占据，见 :1158 注释）。
  //   与计费解耦：calcCost 仍用 stat.model，本函数只负责显示名。
  const raw = String((stat && (stat.modelMain || stat.model)) || '');
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
// v2.81：本地官方库状态标注（模型名后，格式同「（估算）」系列；超宽由行1守卫自动丢弃）
//   库停在昨天（刷新失败/熔断中）→ ⚠价库M/D（标出数据日期，用户可见可修）
//   库文件缺失（合并失败）     → ⚠价库缺失
//   今天已更新正常             → 空串（弹窗与原来一字不差）
function dbStaleTag(pricing) {
  if (!pricing) return '';
  const ldb = pricing.local_db;
  if (!ldb) return '⚠价库缺失';
  if (ldb.built_at && ldb.built_at !== todayStr()) {
    const p = String(ldb.built_at).split('-');
    return `⚠价库${Number(p[1])}/${Number(p[2])}`;
  }
  return '';
}

function periodNote(stat, pricing) {
  const base = periodPeakNote(stat, pricing);
  const tag = dbStaleTag(pricing);
  if (!base) return tag;
  if (!tag) return base;
  return `${base} ${tag}`;
}

function periodPeakNote(stat, pricing) {
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
function isNightHour(m, now) {
  // v2.95：与 isPeakHour 同步——统一按北京时间判定（原先用机器本地时区）。
  //   now 为可选参数（向后兼容，现有调用不传 → 等价于旧行为）；换算方式与 isPeakHour 相同。
  const t = now || new Date();
  const bj = new Date(t.getTime() + t.getTimezoneOffset() * 60000 + 8 * 3600 * 1000);
  const h = bj.getHours();
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
// 超长模型名中间缩略（v2.81，用户要求）：保留开头组织名+结尾型号名，中间 …。
// 修老毛病：此前超宽守卫直接丢耗时行，超长名自动换行把「耗时/今日/余额」整行挤没。
function shrinkTitle(s, maxW) {
  if (dispWidthTitle(s) <= maxW) return s;
  const chars = [...String(s)];
  const ell = '…';
  const take = Math.max(4, Math.floor((maxW - dispWidthTitle(ell)) / 2)); // 每侧宽度预算
  let head = '', w = 0;
  for (const ch of chars) { const cw = dispWidthTitle(ch); if (w + cw > take) break; head += ch; w += cw; }
  let tail = ''; w = 0;
  for (let i = chars.length - 1; i >= 0; i--) { const cw = dispWidthTitle(chars[i]); if (w + cw > take) break; tail = chars[i] + tail; w += cw; }
  return head + ell + tail;
}

function toastLine1(stat, modelShort, period, balTxt, todayTxt) {
  let head = modelShort || '';
  // v3.11：团队轮在第一行补「（子代理 X）」——只补与主模型**不同**的子代理模型；最多列 1 个 + 「等」。
  //   需求（用户 2026-09-23 明确）：① 第一个必须是主模型；② 第一行最多两个模型名；③ 超宽就截断，先截子代理段。
  //   实现：主模型完整保留；给子代理段按剩余预算截断（shrinkTitle），预算不足则整段丢弃。
  try {
    const subs = Array.isArray(stat && stat.subModels)
      ? stat.subModels.filter((m) => m && m !== (modelShort || ''))
      : [];
    if (subs.length) {
      const periodW = period ? dispWidthTitle(` ${period}`) : 0;
      // 6 = 「（子代理 」+「）」的近似显示宽度
      const budget = TOAST_ROW1_MAX_W - dispWidthTitle(head) - periodW - 6;
      if (budget >= 6) {
        const one = String(subs[0]);
        const shown = dispWidthTitle(one) <= budget ? one : shrinkTitle(one, budget);
        head = `${head}（子代理 ${shown}${subs.length > 1 ? '等' : ''}）`;
      }
    }
  } catch (e) { /* 标注失败不影响主流程 */ }
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
  // 行1 超宽守卫（v2.81 重写）：标注优先保住——缩略名字给标注留位；名字+标注都放不下才丢标注；
  // 耗时行（line2）任何情况不丢。TOAST_ROW1_MAX_W=45。
  if (dispWidthTitle(line1) > TOAST_ROW1_MAX_W) {
    if (periodTxt) {
      const budget = TOAST_ROW1_MAX_W - dispWidthTitle(periodTxt);
      if (budget >= 8 && dispWidthTitle(head) + dispWidthTitle(periodTxt) > TOAST_ROW1_MAX_W) {
        return `${shrinkTitle(head, budget)}${periodTxt}\n${line2}`;
      }
    }
    const headFit = dispWidthTitle(head) > TOAST_ROW1_MAX_W ? shrinkTitle(head, TOAST_ROW1_MAX_W) : head;
    return `${headFit}\n${line2}`;
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

// v3.12：在 toast 第一行模型名后插入状态标注（异常轮用"子代理运行中"、补弹用"子代理"），
//   不改动 toastLine1 本体（保证正常轮/团队轮一字不变）。超宽时放弃标注，绝不超出 TOAST_ROW1_MAX_W。
function toastLineTagged(agg, pricing, tag) {
  if (!tag) return toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), balanceText(), todayUsageTxt());
  const mShort = shortModelName(agg, pricing);
  const base = toastLine1(agg, mShort, periodNote(agg, pricing), balanceText(), todayUsageTxt());
  const nl = base.indexOf('\n');
  const line1 = nl >= 0 ? base.slice(0, nl) : base;
  const tail = nl >= 0 ? base.slice(nl) : '';
  const tagged = mShort ? line1.replace(mShort, mShort + tag) : (tag + line1);
  if (dispWidthTitle(tagged) > TOAST_ROW1_MAX_W) return base; // 超宽保护：放弃标注
  return tagged + tail;
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
  // v2.94：按模型族写「正确的」峰谷倍率，而不是一律写 1。
  //   原实现一律写 1（number），会绕过 calcCost(:1979) 对 DeepSeek 的"缺省按 2"逻辑
  //   （typeof === 'number' 成立 → 不取缺省）→ 新收录的 DeepSeek 模型高峰不翻倍、长期低估。
  //   这里直接写正确值而非删字段，是为了让显示层 periodPeakNote(:2421) 也拿到 number：
  //   显示层没有 DeepSeek 缺省分支（缺省一律 1），若删字段会导致「计费×2 但弹窗不显示高峰双倍」
  //   的新不一致。判定正则与 calcCost 保持一致；非 DeepSeek 仍写 1，与原行为完全相同。
  const isDSModel = /(^|[\/\-_])deepseek/i.test(String(modelName));
  const m = {
    name: String(modelName),
    peak_multiplier: isDSModel ? 2 : 1,
    region: region || 'CN',
  };
  if (region === 'CN') {
    // 国内模型：llmabacus 人民币价直接写入
    m.input_price = Number(ref.in);
    m.output_price = Number(ref.out);
    // v2.82.1：缓存价缺失 → null（按 0 计），不再按输入价×10% 拍脑袋估算
    //（各厂商实际缓存价 3%~25% 不等：DeepSeek 3.3% 会被高估 3 倍、glm 25% 被低估，失真）
    m.cached_price = ref.cached != null ? Number(ref.cached) : null;
    m.or_id = ref.id;
    m.price_source = 'llmabacus(国内)';
    m.note = '新模型自动补录（llmabacus 国内人民币价；缓存价缺失按 0 计，待人工核验补录）';
  } else {
    // 国外模型：USD×汇率换算
    m.input_price = Number((ref.usdIn * rate).toFixed(2));
    m.cached_price = null; // v2.82.1：不再 usdIn×10% 估算，缺失按 0 计（待人工核验官方缓存价）
    m.output_price = Number((ref.usdOut * rate).toFixed(2));
    m.or_id = ref.id;
    m.usd_input_price = Number(ref.usdIn.toFixed(6));
    m.usd_output_price = Number(ref.usdOut.toFixed(6));
    m.price_source = 'usd×汇率(国外源)';
    m.auto_converted = true;
    m.note = '新模型自动补录（USD×汇率估算，待人工核验官方价；缓存价缺失按 0 计；时段策略默认无峰谷，如厂商有高峰/夜间折扣需搜索核验后补 peak_multiplier/night_discount 字段）';
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
    // 修复6：加锁写，避免与 refresh-prices.js 并发覆盖。
    // v2.80：内存 pricing 含本地官方库合并条目（只属于 index.json），写盘前剥离，防止两源互相覆盖/膨胀
    const persist = stripLocalDbEntries(pricing);
    const lr = withFileLock(PRICING_LOCK_FILE, () => savePricingAtomic(persist), { ttl: 300000, retries: 50, retryDelay: 100 });
    if (lr.skipped) process.stderr.write(`[token-tracker] 已查列表写入跳过（被其他进程持锁）\n`);
    return { status: 'not-found', note: `⚠️ 新模型 ${stat.model} 国内外价格源均未收录，请用 unified-search 搜官方定价页补录` };
  }
  if (ref === undefined) {
    return { status: 'error', note: `⚠️ 新模型 ${stat.model} 联网查价失败（国内外源均不可达），稍后自动重试` };
  }
  const ok = addModelPrice(pricing, stat.model, ref, 'US');
  return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已自动补录估算价（OpenRouter·国外定价，待核验）；时段折扣策略（高峰/夜间）请用搜索技能核验补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
}

// v2.85：--round-watch <sid> <tsPath> <roundStart> 主循环（detached 自限时进程，非兜底非驻留）。
// 每 2s 轮询 transcript + snapshot：
//   退出（静默）：该轮已被 Stop/watcher 结算（lastStopAt>=roundStart）/ 新轮接管起点（lastUserMsgAt>
//   roundStart）/ coalesce 出现（正常 Stop 链路接管）/ transcript 消失 / 生命上限（默认 3h，防僵尸）。
//   补弹：出现「终止态取消标记（interruptedRowsAfter 非空 = 标记后无 assistant 续跑）+ 静默满 8s」→
//   聚合弹（手动取消）；聚合为空（0-usage 取消，usage 未落盘）→ estimateInterrupted 估算弹
//   （手动取消）（估算）（v2.52 Stop 端同款）。弹后推进 lastStopAt → 下一轮 hook 的兜底因"已结算"
//   自动跳过，不会双弹（注意 showToast 去重是进程内存态，跨进程无效——防双弹必须靠结算推进）。
//   静默判定同时看行数与 mtime（压缩重写不改行数但改 mtime）。
//   与下一轮 hook 兜底的竞态：弹前最后一刻复核 snapshot（结算即退出）；残余窗口毫秒级。
function roundWatchMain(sid, tsPath, roundStart, logFile) {
  const POLL_MS = Number(process.env.ROUND_WATCH_POLL_MS) || (2 * 1000);
  const QUIET_MS = Number(process.env.ROUND_WATCH_QUIET_MS) || (8 * 1000);
  // v2.91：自适应静默——取消确认后一旦发现新 usage 行落盘且稳定 ADAPT_QUIET_MS → 提前弹（典型 3~5s）；
  // 无新 usage（0-usage/空闲取消）→ QUIET_MS 兜底。ROUND_WATCH_ADAPT_QUIET_MS 可 env 覆盖。
  const ADAPT_QUIET_MS = Number(process.env.ROUND_WATCH_ADAPT_QUIET_MS) || (2 * 1000);
  const MAX_LIFE_MS = Number(process.env.ROUND_WATCH_MAX_MS) || (3 * 60 * 60 * 1000);
  if (!tsPath || !(roundStart > 0)) return;
  // v2.87：compaction 事件观测（方案①）——轮级取消 watcher 启动点落盘形态快照
  appendCompactionLog('round-watch-start', { sid, roundStart, shape: captureTranscShape(tsPath) });
  // v2.91：工作区日志信号（取消确认第二源，100% 可靠——客户端源码实证每次取消必写
  // "[ACP Agent] cancel: received cancel request for session <sid>"，含 Aborting 与 Ignoring idle 两个分支）。
  // 增量读：offset 起点为启动时文件大小（只认启动后的行，防历史取消误报）。
  const t0 = Date.now();
  let lastLines = -1, lastMtime = -1, lastChangeAt = t0;
  let logOffset = 0, logCancelTs = 0;
  try { if (logFile && fs.existsSync(logFile)) logOffset = fs.statSync(logFile).size; } catch (e) {}
  while (true) {
    sleep(POLL_MS);
    try {
      // --- 退出判定（先于弹窗判定，防与正常链路双弹）---
      const snap = loadSnapshot(sid) || {};
      if ((snap.lastStopAt || 0) >= roundStart) return;   // 该轮已由 Stop/兜底/watcher 结算
      if ((snap.lastUserMsgAt || 0) > roundStart) return; // 更新的轮次已接管起点
      if (readCoalesce(sid)) return;                      // Stop 端已写合并文件，正常链路接管
      let st;
      try { st = fs.statSync(tsPath); } catch (e) { return; } // transcript 消失（会话被删）
      const rows = readTranscLines(tsPath);
      if (rows.length !== lastLines || st.mtimeMs !== lastMtime) {
        lastLines = rows.length; lastMtime = st.mtimeMs; lastChangeAt = Date.now();
      }
      // --- v2.91：扫工作区日志增量，匹配本会话取消请求 ---
      if (logFile && fs.existsSync(logFile)) {
        try {
          const lst = fs.statSync(logFile);
          if (lst.size > logOffset) {
            const fd = fs.openSync(logFile, 'r');
            const buf = Buffer.alloc(lst.size - logOffset);
            fs.readSync(fd, buf, 0, buf.length, logOffset);
            fs.closeSync(fd);
            logOffset = lst.size;
            const needle = 'cancel: received cancel request for session ' + sid;
            const txt = buf.toString('utf8');
            if (txt.includes(needle) && !logCancelTs) {
              const lines = txt.split('\n').filter(l => l.includes(needle));
              const lastLn = lines[lines.length - 1] || '';
              const mm = /\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/.exec(lastLn);
              logCancelTs = mm ? new Date(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6], +(mm[7] || 0)).getTime() : Date.now();
              appendCompactionLog('round-watch-cancel-confirmed', { sid, via: 'client-log', logCancelTs });
            }
          }
        } catch (e) { /* 日志读取失败：退化纯 transcript 模式 */ }
      }
      // --- 弹窗判定：取消确认（transcript 标记行 ∨ 工作区日志信号）+ 静默满 ---
      const intr = interruptedRowsAfter(rows, roundStart);
      const intrInfo = intr.length ? intr[intr.length - 1] : null;
      // v2.91：取消确认双源——标记行 ts 或 日志信号 ts（取先到者，且必须晚于本轮起点）
      const cancelTs = intrInfo ? intrInfo.ts : (logCancelTs > roundStart ? logCancelTs : 0);
      if (cancelTs) {
        // v2.91 自适应：追踪确认之后新落盘的 usage 行——落盘且稳定 ADAPT_QUIET_MS → 提前弹
        let lastUsageTs = 0;
        for (const r of rows) {
          const ts = Number(r.timestamp || 0);
          if (ts > cancelTs && ts > lastUsageTs && extractUsage((r.providerData || {}).usage)) lastUsageTs = ts;
        }
        const anchor = Math.max(cancelTs, lastUsageTs, lastChangeAt);
        const needed = lastUsageTs > 0 ? ADAPT_QUIET_MS : QUIET_MS;
        if ((Date.now() - anchor) >= needed) {
        // 弹前最后一刻复核（防与下一轮 hook 的兜底路径竞态双弹）
        const snap2 = loadSnapshot(sid) || {};
        if ((snap2.lastStopAt || 0) >= roundStart || (snap2.lastUserMsgAt || 0) > roundStart) return;
        const pricing = loadPricing();
        const aggC0 = aggregateTranscript(tsPath, roundStart);
        // v3.06：同 hook 路径的修复 —— 零"已完成用量"但有"被中断估算"时构造零值基底，避免静默丢弃。
        const estByModelC0 = estimateInterrupted(rows, 0, roundStart);
        const estNamesC0 = Object.keys(estByModelC0);
        const aggC = aggC0 || (estNamesC0.length
          ? { in: 0, out: 0, cached: 0, total: 0, model: estNamesC0[0], durMs: 0, count: 0 }
          : null);
        if (aggC) {
          // 与 v2.83 兜底同构：合并被中断调用估算 + 补记账 + 弹窗
          const estByModelC = estByModelC0;
          const estNamesC = estNamesC0;
          if (estNamesC.length) {
            const estInC = estNamesC.reduce((s, n) => s + estByModelC[n].in, 0);
            const estOutC = estNamesC.reduce((s, n) => s + estByModelC[n].out, 0);
            const estCachedC = estNamesC.reduce((s, n) => s + estByModelC[n].cached, 0);
            aggC.in += estInC; aggC.out += estOutC; aggC.cached += estCachedC; aggC.total += estInC + estOutC;
          }
          const durC = Math.max(0, cancelTs - roundStart);
          aggC.durMs = aggC.durMs || durC;
          const modelC = shortModelName(aggC, pricing);
          ensureNewModelPricing(pricing, aggC);
          incrementalRecord(tsPath, sid);
          writeProbe({ time: new Date().toISOString(), event: 'RoundWatch', ok: true, sid, sameRound: false,
            note: 'cancelled-round-watch', transcriptPath: tsPath, stat: aggC,
            line: lineFor(aggC, false, modelC), source: 'transcript-cancelled-round-watch',
            intrAt: new Date(cancelTs).toISOString() });
          showToast(
            toastLine1(aggC, modelC, '（手动取消）', balanceText(), todayUsageTxt()),
            toastLine2(aggC, pricing),
            'cancelled-round-watch'
          );
        } else {
          // 0-usage 取消（取消时 usage 未落盘）→ 估算弹窗（v2.52 Stop 端同款）
          const estByModel = estimateInterrupted(rows, 0, roundStart);
          const estNames = Object.keys(estByModel);
          if (estNames.length) {
            const estTotal = estNames.reduce((s, n) => s + estByModel[n].total, 0);
            const estIn = estNames.reduce((s, n) => s + estByModel[n].in, 0);
            const estOut = estNames.reduce((s, n) => s + estByModel[n].out, 0);
            const estStat = { in: estIn, out: estOut, cached: 0, total: estTotal, durMs: Math.max(0, cancelTs - roundStart), model: estNames[0], count: estNames.length };
            const estModelShort = shortModelName(estStat, pricing);
            incrementalRecord(tsPath, sid); // 水位线幂等；估算依据如可记则按 Stop 端同款入账本
            writeProbe({ time: new Date().toISOString(), event: 'RoundWatch', ok: true, sid, sameRound: false,
              note: 'cancelled-round-watch-est', transcriptPath: tsPath, stat: estStat,
              line: '本轮被手动取消，估算 token（usage 未落盘）', source: 'transcript-cancelled-round-watch-est',
              intrAt: new Date(cancelTs).toISOString() });
            showToast(toastLine1(estStat, estModelShort, '（手动取消）（估算）', balanceText(), todayUsageTxt()), toastLine2(estStat, pricing), 'cancelled-round-watch-est');
          } else {
            // 取消早于首字节落盘（连 incomplete reasoning 行都没有，2026-09-05 15:33 实测型）→ 无估算依据。
            // 对齐 Stop 端 v2.51：弹「无记录」提示而非静默退出，让用户知道该轮已取消、无本地数据可计
            //（输入侧云端可能已计费，但本地无凭据，不编造数字）。
            incrementalRecord(tsPath, sid);
            writeProbe({ time: new Date().toISOString(), event: 'RoundWatch', ok: true, sid, sameRound: false,
              note: 'cancelled-round-watch-no-token', transcriptPath: tsPath, stat: null,
              line: '本轮无 token 消耗记录（手动取消）', source: 'transcript-cancelled-round-watch-no-token',
              intrAt: new Date(cancelTs).toISOString() });
            showToast('本轮无 token 消耗记录（手动取消）', '取消早于模型输出落盘，本地无该轮数据（输入侧云端或已计费，无法估算）', 'cancelled-round-watch-no-token');
          }
        }
        // 该轮已结算：推进 lastStopAt（lastUserMsgAt 取 max，防回写覆盖 hook 刚刷新的新起点）
        const psnapW = loadSnapshot(sid) || {};
        saveSnapshot({ file: psnapW.file || tsPath, stat: psnapW.stat || null,
          lastUserMsgAt: Math.max(psnapW.lastUserMsgAt || 0, roundStart), lastStopAt: Date.now() }, sid);
        return;
        } // v2.91：自适应静默判定（anchor/needed）闭合
      } // v2.91：取消确认（cancelTs）闭合
      if (Date.now() - t0 > MAX_LIFE_MS) return; // 生命上限：静默退出，绝不僵尸
    } catch (e) {
      // 轮询内异常（半写/瞬态 IO）：记诊断继续轮询；持续异常由生命上限兜底
      try {
        writeProbe({ time: new Date().toISOString(), event: 'RoundWatch', ok: false, sid, note: 'poll-error', error: String((e && e.message) || e) });
      } catch (e2) { /* 诊断失败不影响轮询 */ }
    }
  }
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
  // v2.85：--round-watch <sid> <tsPath> <roundStart> —— 轮级临时 watcher 入口（--hook 为新轮 spawn 的
  // detached 自限时观察进程）：盯「本轮被手动取消且无 Stop hook」，见 roundWatchMain。
  if (process.argv.includes('--round-watch')) {
    const rwi = process.argv.indexOf('--round-watch');
    roundWatchMain(process.argv[rwi + 1] || '', process.argv[rwi + 2] || '', Number(process.argv[rwi + 3]) || 0, process.argv[rwi + 4] || '');
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
    // v3.05（2026-09-11 修复·TDZ 崩溃）：**把 watcher 调试日志函数提前到抢锁之前定义**。
    //   原实现里 `appendWatchDebug` 定义在下方（抢锁成功之后），而"未拿到锁"分支会先调用它 ——
    //   const 存在暂时性死区（TDZ），导致任何抢锁失败（并发 watcher / 陈旧锁 pid 被存活进程复用）
    //   都抛出 `ReferenceError: Cannot access 'appendWatchDebug' before initialization`，
    //   watcher **未捕获异常崩溃**（退出码 1），既不弹窗也不留痕。实测已复现。
    //   修复：定义前移，使失败分支可安全调用。
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
    // 记录本 watcher 启动（含 sid / 起点 / 合并文件是否存在）
    appendWatchDebug({ type: 'start', ts: Date.now(), sid: fSid, tsPath, roundStart: info0.roundStart || 0, hasCoalesce: !!(info0 && info0.agg) });
    // v2.87：compaction 事件观测（方案①）——flush watcher 启动点落盘形态快照
    appendCompactionLog('flush-watch-start', { sid: fSid, roundStart: info0.roundStart || 0, hasCoalesce: !!(info0 && info0.agg), shape: captureTranscShape(tsPath) });

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
          // v2.97：窗口由硬编码 60s 改为 SUBAGENT_IDLE_MS（默认 20s）——实测事件间最大间隔仅 8.8s，
          //   60s 造成用户体感"子代理结束后 1 分钟才弹窗"。此处只收紧正常路径；
          //   异常死寂兜底（subagentsAllStagnant）仍保持 60s 保守值。
          if (hasSubagentsRecentlyActive(tsPath, SUBAGENT_IDLE_MS)) {
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
      if (info.mainToastedAt) {
        // v3.12：异常轮——主模型已在 Stop 先弹，此处只补弹【子代理】部分（不含主模型用量，否则重复）
        const subAgg = aggregateSubsOnly(info.tsPath, info.roundStart || 0);
        if (subAgg && subAgg.total > 0) {
          const subToastAgg = Object.assign({}, subAgg, { subModels: undefined });
          showToast(toastLineTagged(subToastAgg, pricing, '（子代理）'), toastLine2(subToastAgg, pricing), 'team-sub-only', info.tsPath);
        }
        appendCompactionLog('flush-team-sub-only', { sid: fSid, subTotal: subAgg ? subAgg.total : 0 });
        clearCoalesce(fSid);
        const ws = loadSnapshot(fSid) || {};
        saveSnapshot({ file: ws.file || '', stat: ws.stat || null, lastUserMsgAt: ws.lastUserMsgAt || 0, lastStopAt: Date.now() }, fSid);
      } else {
        // v2.98：子代理/专家团弹窗标注——区分两种形态（专家团=带 agentColor 的成员；普通子代理=内置类型）。
        // 与主模型同名的子代理会被并入同一模型桶（按模型分桶已天然实现），此处仅做标注，不改计费与数据结构。
        const subModels = subagentModelSet(info.tsPath, info.roundStart || 0);
        const modelShort = shortModelName(agg, pricing);
        const subEntry = subModels.get(normalizeModelName(agg.model || ''));
        const modelLabel = subEntry ? modelShort + subagentTagOf(subEntry) : modelShort;
        showToast(toastLine1(agg, modelLabel, periodNote(agg, pricing), bal, todayUsageTxt()), toastLine2(agg, pricing), toastReason, info.tsPath);
        clearCoalesce(fSid);
        // v2.27：watcher 弹窗完成 = 专家团本轮真正结束 → 推进 lastStopAt（供 hook 端起点刷新守卫）
        const ws = loadSnapshot(fSid) || {};
        saveSnapshot({ file: ws.file || '', stat: ws.stat || null, lastUserMsgAt: ws.lastUserMsgAt || 0, lastStopAt: Date.now() }, fSid);
      }
    }
    // R4（2026-08-23）：释放只删自己持有的锁（校验 pid===自己），避免异常路径误删新 owner 的锁
    if (gotLock) { try { const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); if (o && o.pid === myPid) fs.unlinkSync(lockPath); } catch (e) {} }
    return;
  }
  // v2.21：hook 与 stop 都从 payload 读 session_id（快照按会话拆分，多会话并发不互相覆盖）；
  // 手动运行无 payload → sid='' → 全局快照（行为不变）。stdin 只读一次，后面全部复用 payloadRaw。
  const payloadRaw = (asHook || asStop) ? readStdin() : '';
  let sid = '';
  let hookCwd = '';
  try { const hp = JSON.parse(payloadRaw); sid = String(hp.session_id || ''); hookCwd = String(hp.cwd || ''); } catch (e) { /* payload 非 JSON 或无 session 字段 */ }

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
    // v2.86：同轮二次 Stop 守卫——上次弹窗结算（lastStopAt）晚于本轮起点 → 聚合起点改从 lastStopAt 起，
    // 只算新增段。场景实证（2026-09-05 16:50/16:51 双弹）：压缩（compaction）完成会触发第二次 Stop hook，
    // 原逻辑无条件从 lastUserMsgAt 重聚整轮 → 弹窗2 = 弹窗1 已弹数据 + 压缩调用新增（实测 20.6万/146 +
    // 4.7万/385 = 25.3万/531，耗时同显 17.4s）→ 用户观感"重复弹窗"。账本因水位线幂等不受影响（实测弹窗2
    // 仅新增记账 ¥0.02），纯弹窗层重复。从未结算过（lastStopAt <= roundStart0）时 aggStart == roundStart0，
    // 单次 Stop 行为完全不变。
    const settledAt0 = prevSnap0.lastStopAt || 0;
    const aggStart0 = settledAt0 > roundStart0 ? settledAt0 : roundStart0;
    // v2.87：compaction 事件观测（方案①）——Stop 决策点落盘形态快照 + 聚合起点决策，事后可完整还原事件序列
    appendCompactionLog('stop-transcript', { sid, roundStart0, lastStopAt: settledAt0, aggStart: aggStart0, shape: captureTranscShape(tsPath) });
        if (tsPath && roundStart0 > 0) {
      let agg = aggregateTranscript(tsPath, aggStart0);
      // v3.05（2026-09-11 修复·重复弹窗）：两次重试**必须沿用 aggStart0，不能回退到 roundStart0**。
      //   aggStart0 = max(lastStopAt, roundStart0) 是"上次已结算点"；roundStart0 是本轮起点（更早）。
      //   原实现重试时改用 roundStart0 → 窗口回退到**已结算区间**，一旦首次聚合因数据未落盘失败，
      //   重试就会命中上一轮的旧用量并**重新弹一次窗**（实测复现：probe 显示 source=transcript、
      //   stat 为旧轮的 in:100/out:50）。这与 v2.86「已结算轮静默跳过」的设计意图相悖。
      //   改为沿用 aggStart0：数据延迟落盘时重试依然能捕到（文件在这 500ms/1500ms 内已更新），
      //   且窗口不回退 —— **既不漏新数据，也不会重弹旧数据**。
      if (!agg) { sleep(500); agg = aggregateTranscript(tsPath, aggStart0); } // transcript 尾部可能未 flush
      if (!agg) { sleep(1500); agg = aggregateTranscript(tsPath, aggStart0); }
      if (agg) {
        // v2.53：本轮可能"完整调用（有 usage）+ 被中断思考（无 usage）"混合——合并被中断估算，
        // 让弹窗显示两边汇总（之前只显示完整调用部分，被中断思考漏了）。
        const estByModel0 = estimateInterrupted(readTranscLines(tsPath), 0, aggStart0);
        const estNames0 = Object.keys(estByModel0);
        if (estNames0.length) {
          const estIn0 = estNames0.reduce((s, n) => s + estByModel0[n].in, 0);
          const estOut0 = estNames0.reduce((s, n) => s + estByModel0[n].out, 0);
          const estCached0 = estNames0.reduce((s, n) => s + estByModel0[n].cached, 0);
          agg.in += estIn0; agg.out += estOut0; agg.cached += estCached0; agg.total += estIn0 + estOut0;
        }
        // v2.82.1：耗时统一口径——改用 traceWallDurMs()（latest trace endedAt − 用户提交时刻）。
        // v2.74 的「单 trace 文件 startedAt→endedAt」在长任务（多 trace 分段落盘）下只算到
        // 最后一段：实测 11:27 只显示 4:22。详见 traceWallDurMs() 注释。
        // v2.88：起点恢复 roundStart0（v2.86 曾误用 aggStart0——同轮二次 Stop 时只算到上次结算点），
        // 并传 tsPath 让 endedAt 取 max(trace.endedAt, transcript 末行 ts)——压缩不写 trace，
        // 轮尾压缩段耗时靠 transcript 末行补全（实测 4m6s → 12m47s，与客户端一致）。
        // 条件不满足 → 回退 transcript 口径，绝不抛错。
        try {
          const wd = traceWallDurMs(latestTraceFile(true), roundStart0, sid, tsPath);
          if (wd.source === 'trace') agg.durMs = wd.durMs;
        } catch (e) { /* 保留 transcript 口径 */ }
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
        const byModel = aggregatePerModel(tsPath, aggStart0);
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
        // v3.01（2026-09-11 修复·第二版）：**普通轮直接同步弹窗，不再依赖 detached 后台 watcher**。
        //   根因（实测证据链）：WorkBuddy 新版在 hook 进程结束后会**连带终止其派生的 detached 子进程**
        //   —— watcher 刚 spawn 就被杀，表现为「无 watcher-spawn-error（spawn 成功）、无 flush-watch-start
        //   （没活到写日志）、锁未创建」，弹窗彻底失效，只能等下次 hook 兜底。
        //   对照实验：PowerShell 手动跑 --stop 时 watcher 正常（15:01:57 有 flush-watch-start）→ 证实是
        //   宿主进程管理行为差异，而非代码问题。该行为随客户端更新才出现，故"更新后开始坏"。
        //   本改动同时**回归代码原设计意图**（见上方 v2.27/v2.28 注释：普通轮立即弹，仅专家团走合并延迟）。
        //   判断依据 agg.subCount / agg.teamActive —— 二者均为 0/false 即普通轮。
        const isPlainRound = !(agg && (Number(agg.subCount) > 0 || agg.teamActive === true));
        // v3.09 修复D（2026-09-22 实证·弹窗时效）：团队轮若在 Stop 时刻**子代理已全部收尾**，说明数据已齐
        //   → 直接走同步立即弹窗，不再 spawn watcher。
        //   证据：当晚三次团队轮弹窗全靠下一轮 --hook 兜底（reason=hook-fallback），延迟 1~10 分钟；
        //   而 watcher 的降级分支只在"spawn 未接管"时触发，**覆盖不了"spawn 成功但随后被宿主收割"**
        //   （现场遗留 .coalesce-*.json.lock、无 toast）。账本不受影响（走行数水位线），受损的只是弹窗时效。
        // v3.09.1（BUG-1 修复，独立验证员发现）：**不能只看 subagentPending().length===0**。
        //   实测：当 Agent 调用的参数里取不到可解析 name（中文名/无 name 字段）时，subagentPending 会**假空**返回 []
        //   → 若据此走快速路径，会 ①本轮弹窗少算仍在跑的子代理用量 ②推进 lastStopAt 后子代理后续输出再无 watcher 接管
        //   → 该轮后续用量弹窗丢失。故加第二道判据：**每个子代理文件末行必须已是"已收尾"**（与时间无关，
        //   不用 stagnant 时间窗，避免把要修的延迟又带回来）。二者同时成立才走快速路径。
        // v3.09.1（BUG-1 修复，独立验证员发现）：**不能只看 subagentPending().length===0**。
        //   实测：Agent 调用参数取不到可解析 name 时（中文团队/无 name 字段），subagentPending 会**假空**返回 []
        //   → 若据此走快速路径，会 ①本轮弹窗少算仍在跑的子代理用量 ②推进 lastStopAt 后子代理后续输出
        //   再无 watcher 接管 → 该轮后续用量弹窗丢失（账本走水位线不受影响）。
        //   **正解是复用本文件既有的 v2.47 机制** `hasSubagentsRecentlyActive`（同源问题，见 :1458 注释）：
        //   靠子代理文件 mtime 判断是否仍有子代理在活跃写入（窗口 SUBAGENT_IDLE_MS = 20s，与 :3657 调用一致）。
        //   ⚠️ 不要改用"子代理末行是否都已收尾"——被取消/中断的子代理文件末行永远是 incomplete，
        //   会导致本快速路径永不触发（真实会话实测 21 个子代理中 3 个 incomplete）。
        let teamDataReady = false;
        try {
          teamDataReady = subagentPending(tsPath).length === 0
            && !hasSubagentsRecentlyActive(tsPath, SUBAGENT_IDLE_MS);
        } catch (e) { teamDataReady = false; }
        if (isPlainRound || teamDataReady) {
          // 普通轮：同步立即弹（不 spawn、不等确认窗），并清掉 coalesce 以免被兜底二次补弹
          try {
            showToast(
              toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), balanceText(), todayUsageTxt()),
              toastLine2(agg, pricing),
              (typeof toastReason === 'string' && toastReason) ? toastReason + '+plain-immediate' : 'plain-immediate',
              tsPath
            );
            clearCoalesce(effSid);
            // v3.03（蝴蝶效应修复）：**普通轮必须自己推进 lastStopAt**。
            //   原设计里 lastStopAt 由 watcher 弹窗完成后推进（见 --flush-delayed 内注释）。
            //   本分支改为同步弹窗、不启动 watcher 后，若此处不推进，则：
            //   下轮 --hook 计算 `inProgress = lastUserMsgAt > lastStopAt` 会**误判"上轮未结束"**
            //   → 起点刷新守卫不刷新 roundStart → 下轮聚合范围从上轮起点算起 → **弹窗数值偏大**。
            //   （账本不受影响：incrementalRecord 走行数水位线去重；受损的是"弹窗显示"。）
            //   写法对齐 watcher 内 :3184 —— lastUserMsgAt 取 max 防回写覆盖 hook 刚刷新的新起点。
            try {
              const psnapP = loadSnapshot(sid) || {};
              saveSnapshot({
                file: psnapP.file || tsPath,
                stat: psnapP.stat || null,
                lastUserMsgAt: Math.max(psnapP.lastUserMsgAt || 0, aggStart0),
                lastStopAt: Date.now(),
              }, sid);
            } catch (e) { /* 快照写失败不影响弹窗 */ }
            appendCompactionLog('stop-plain-immediate', { sid: effSid, subCount: agg && agg.subCount, teamActive: !!(agg && agg.teamActive), teamDataReady });
          } catch (e) { process.stderr.write(`[token-tracker] 普通轮同步弹窗失败: ${e.message}\n`); }
          out({ hookSpecificOutput: {} });
          return;
        }
        // v3.12「异常轮拆分弹窗兜底」——**已实测通过（2026-09-23，带 trace 夹具）**，默认开启：
        //   实测：① 异常轮 Stop → 立刻 1 条【主模型】条（标"子代理运行中"）；
        //        ② 子代理结束后 `--hook` → 补弹 1 条【子代理】条（reason `team-sub-only`），coalesce 清理；
        //        ③ 再次触发 → 不重复；④ 真实 toast 日志 md5 前后一致（零污染）。
        //   ⚠️ 排查提示：**补弹路径依赖 trace 文件存在**——早前在"沙箱未造 trace"的夹具里测出"补弹不触发"，
        //      是夹具缺失导致的假象，非代码缺陷（排查花了很久，记此备忘）。
        //   紧急关闭：设环境变量 WB_TEAM_SPLIT=0（回到 v3.11 行为：异常轮仍走 watcher，延迟但最终弹一条完整的）。
        const TEAM_SPLIT_ENABLED = process.env.WB_TEAM_SPLIT !== '0';
        const existingCoal = readCoalesceInfo(effSid);
        const mainAlreadyToasted = !!(existingCoal && existingCoal.mainToastedAt);
        if (TEAM_SPLIT_ENABLED && agg && agg.teamActive === true && !teamDataReady) {
          if (!mainAlreadyToasted) {
            // ① 立刻弹主模型条（标注子代理运行中），不等子代理
            const mainAgg = aggregateMainOnly(tsPath, aggStart0);
            if (mainAgg && mainAgg.total > 0) {
              showToast(
                toastLineTagged(mainAgg, pricing, '（子代理运行中）'),
                toastLine2(mainAgg, pricing),
                'team-main-first',
                tsPath
              );
            }
            appendCompactionLog('stop-team-main-first', { sid: effSid, subCount: agg && agg.subCount, teamActive: true, mainTotal: mainAgg ? mainAgg.total : 0 });
            // ② 写 coalesce 带 mainToastedAt（供补弹判断"主模型已弹过"）
            writeCoalesce(effSid, agg, { tsPath, roundStart: aggStart0, byModel, mainToastedAt: Date.now(), traceFile });
          } else {
            // 同一轮已弹过主模型（如异常轮内重复 Stop/hook 事件）→ 绝不重复弹，续跑 watcher 即可；
            // roundStart 沿用首次弹主模型时的值，避免后续 Stop 把聚合起点推进导致漏算子代理。
            writeCoalesce(effSid, agg, { tsPath, roundStart: (existingCoal && existingCoal.roundStart) || aggStart0, byModel, mainToastedAt: existingCoal.mainToastedAt, traceFile });
          }
          // ③ ⚠️ 这里**绝不推进 lastStopAt**（v3.12.1 实测修复，2026-09-23）：
          //    watcher 与 hook 兜底都用 `lastStopAt` 判断"本轮是否已结算"，一旦在此推进，
          //    两条补弹路径都会认为本轮已结束而**直接跳过** → 子代理那条永远不弹。
          //    （实测：推进后 Stop 后等 40 秒、再触发 --hook 均无补弹，且 coalesce 残留不清理。）
          //    轮次边界推进交给补弹路径自己完成——watcher 出口与 hook 兜底在弹完【子代理】条后
          //    都会 `saveSnapshot({lastStopAt: Date.now()})`；重复弹主模型由 coalesce 的 mainToastedAt 拦。
          // ④ 仍启动 watcher，子代理结束后补弹【子代理】部分
          startWatcherVerified(effSid);
          out({ hookSpecificOutput: {} });
          return;
        }
        writeCoalesce(effSid, agg, { tsPath, roundStart: aggStart0, byModel, terminalError: teAtStop || undefined, traceFile });
        // 专家团/多子回合：仍需 watcher（要等子代理落盘后才汇总），启动并校验是否接管；
        // 未接管 → 立即降级为同步弹窗，保证**任何情况下至少弹一次**。
        if (!startWatcherVerified(effSid)) {
          // 二次确认：coalesce 仍在（未被其它 watcher 清掉）才补弹，避免与在跑的 watcher 双弹
          let stillPending = false;
          try { stillPending = fs.existsSync(coalescePath(effSid)); } catch (e) { stillPending = false; }
          if (stillPending) {
            try {
              showToast(
                toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), balanceText(), todayUsageTxt()),
                toastLine2(agg, pricing),
                (typeof toastReason === 'string' && toastReason) ? toastReason + '+no-watcher' : 'no-watcher-fallback',
                tsPath
              );
              clearCoalesce(effSid);
              appendCompactionLog('stop-sync-fallback', { sid: effSid, why: lastWatcherSpawnError || 'watcher-not-up' });
            } catch (e) { process.stderr.write(`[token-tracker] 降级同步弹窗失败: ${e.message}\n`); }
          }
        }
        out({ hookSpecificOutput: {} });
        return;
      } else {
        // v2.86：同轮二次 Stop 且已结算过 → 聚合窗口内无新增 usage 行 → 静默跳过（绝不弹"无记录"
        // 误导——数据其实早已结算过）；记账照跑保底残余行，水位线幂等不重复。
        if (settledAt0 > roundStart0) {
          incrementalRecord(tsPath, sid);
          writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: false,
            transcriptPath: tsPath, stat: null, note: 'same-round-settled-no-new-usage-skip',
            payload: summarizePayload(payloadRaw) });
          out({ hookSpecificOutput: {} });
          return;
        }
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
        // v3.08 修复2：no-token 分支同样推进 lastStopAt，与正常结算路径一致写快照。
        // 目的：避免"应用中止在飞请求"（skipRun/fork）触发 no-token Stop 后，轮次边界 lastStopAt
        // 停滞在更早时刻，导致后续注入型 user 行（task-notification）唤起兜底判定时，旧取消标记
        // 因 intrInfo.ts > lastStopAt 仍成立而被"复活"误判为手动取消（实测 2026-09-22 b017080d…）。
        try {
          const snap0 = loadSnapshot(sid) || {};
          saveSnapshot({ file: snap0.file || tsPath, stat: snap0.stat || null, lastUserMsgAt: snap0.lastUserMsgAt || 0, lastStopAt: Date.now() }, sid);
        } catch (e) { /* 快照写失败不影响弹窗 */ }
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
      const bal = balanceText();
      if (pendInfo && pendInfo.mainToastedAt) {
        // v3.12：异常轮——主模型已在 Stop 先弹，hook 兜底只补弹【子代理】部分（不含主模型用量，否则重复）
        const subAgg = aggregateSubsOnly(pendInfo.tsPath, (pendInfo && pendInfo.roundStart) || 0);
        if (subAgg && subAgg.total > 0) {
          const subToastAgg = Object.assign({}, subAgg, { subModels: undefined });
          showToast(toastLineTagged(subToastAgg, pricing, '（子代理）'), toastLine2(subToastAgg, pricing), 'team-sub-only', pendInfo.tsPath);
        }
        appendCompactionLog('hook-team-sub-only', { sid, subTotal: subAgg ? subAgg.total : 0 });
        clearCoalesce(sid);
        // v2.27：兜底补弹完成 → 该轮已结束，标记 lastStopAt（供下轮起点刷新判断）
        const psnap = loadSnapshot(sid) || {};
        saveSnapshot({ file: psnap.file || hookFile, stat: psnap.stat || stat, lastUserMsgAt: psnap.lastUserMsgAt || 0, lastStopAt: Date.now() }, sid);
      } else {
        // v2.98：子代理/专家团弹窗标注（与主路径同规则；失败时 Map 为空 → 退化为原行为）
        const pendSubModels = subagentModelSet(pendInfo && pendInfo.tsPath, (pendInfo && pendInfo.roundStart) || 0);
        const pendModelBase = shortModelName(pendAgg, pricing);
        const pendEntry = pendSubModels.get(normalizeModelName(pendAgg.model || ''));
        const pendModel = pendEntry ? pendModelBase + subagentTagOf(pendEntry) : pendModelBase;
        showToast(toastLine1(pendAgg, pendModel, periodNote(pendAgg, pricing), bal, todayDisplay(pendAgg, pricing)), toastLine2(pendAgg, pricing), 'hook-fallback');
        clearCoalesce(sid);
        // v2.27：兜底补弹完成 → 该轮已结束，标记 lastStopAt（供下轮起点刷新判断）
        const psnap = loadSnapshot(sid) || {};
        saveSnapshot({ file: psnap.file || hookFile, stat: psnap.stat || stat, lastUserMsgAt: psnap.lastUserMsgAt || 0, lastStopAt: Date.now() }, sid);
      }
    }
    // v2.83：手动取消漏弹修复——上一轮未结算（inProgress）且 transcript 有「Interrupted by user」
    // 标记（role=assistant + status=incomplete + providerData.error.message 精确为 Interrupted by user）
    // → 用户手动取消后 WorkBuddy 未触发 Stop hook（实测 2026-09-02 00:33：取消被 SessionAbortMiddleware
    // 挂起，直到下一条用户消息才吸收，全程无 executeStopHooks）。此场景下立即把被取消轮聚合补弹，
    // 防止其 token 被静默合并进下一轮弹窗（实测被取消轮 108.7万 tokens 并入下轮，弹窗显示 25m3s 用户无法辨认）。
    // 安全条件（全部满足才补弹）：
    //   ① inProgress 为真（上一轮无完成的 Stop/watcher 弹窗 → 确实未结算）；
    //   ② transcript 存在"未被后续 assistant 消息跟进"的取消标记（= 取消后没有新回复 → 该轮确实终止）；
    //   ③ roundStart > 0 且取消标记 timestamp > roundStart（属于被取消的那一轮，不是更早的旧标记）。
    // 补弹后：推进 lastStopAt，随后起点刷新守卫按"已结束"路径刷新起点（下一轮从本次提交开始聚合）。
    // 不走 coalesce/watcher：取消轮是终态，无"是否续跑"的不确定性，直接弹即可。
    if (tsPathH) {
      const snapPre = loadSnapshot(sid) || {};
      const roundStartH = snapPre.lastUserMsgAt || 0;
      // v2.85：结算门槛从「轮未结束」（inProgress）放宽为「取消标记晚于最近一次结算」——
      // 轮级 watcher 补弹推进 lastStopAt 后，连环取消（取消→新轮→又取消）场景下一轮 hook
      // 仍能识别新的待结算标记；intrInfo.ts > lastStopAt 天然排除已结算的旧标记，不会重复补弹。
      if (roundStartH > 0) {
        // v2.96：原先此处对同一 transcript 全量读 2 次（本行 + estimateInterrupted），
        //   叠加 aggregateTranscript 内部的一次共 3 次；大会话（实测最大 49MB）下每次用户提交都重复解析。
        //   改为读取一次复用。**仅合并外围两处**——aggregateTranscript 内部还聚合子代理目录，
        //   不能简单替换为 aggregateTranscLines，否则会丢失子代理数据。
        const transcRowsH = readTranscLines(tsPathH);
        const intrRows = interruptedRowsAfter(transcRowsH, roundStartH);
        const intrInfo = intrRows.length ? intrRows[intrRows.length - 1] : null;
        if (intrInfo && intrInfo.ts > roundStartH && intrInfo.ts > (snapPre.lastStopAt || 0)) {
          // 聚合起点 = 旧 roundStartH（含被取消轮全部调用）；终点天然为 transcript 当前末尾
          let aggC = aggregateTranscript(tsPathH, roundStartH);
          // v3.06（修复·取消轮零用量漏补弹）：把"被中断估算"提到判断之前，
          //   原实现是 `if (aggC) { ...估算... }` —— 一旦本轮没有任何**已完成**的 usage 落盘
          //   （典型：用户刚提交就手动取消，模型还在思考），aggregateTranscript 返回 null，
          //   整个块被跳过 → 即使 estimateInterrupted() 估到了被中断的思考消耗，
          //   也**既不弹窗也不记账，静默丢弃**。
          //   现在：估算非空时先构造一个零值基底 agg，让下面的合并/弹窗/记账照常执行。
          const estByModelC = estimateInterrupted(transcRowsH, 0, roundStartH);
          const estNamesC = Object.keys(estByModelC);
          if (!aggC && estNamesC.length) {
            aggC = { in: 0, out: 0, cached: 0, total: 0, model: estNamesC[0], durMs: 0, count: 0 };
          }
          if (aggC) {
            if (estNamesC.length) {
              const estInC = estNamesC.reduce((s, n) => s + estByModelC[n].in, 0);
              const estOutC = estNamesC.reduce((s, n) => s + estByModelC[n].out, 0);
              const estCachedC = estNamesC.reduce((s, n) => s + estByModelC[n].cached, 0);
              aggC.in += estInC; aggC.out += estOutC; aggC.cached += estCachedC; aggC.total += estInC + estOutC;
            }
            const durC = Math.max(0, intrInfo.ts - roundStartH); // 取消时刻 - 轮起点 = 被取消轮墙钟时长
            aggC.durMs = aggC.durMs || durC;
            const modelC = shortModelName(aggC, pricing);
            ensureNewModelPricing(pricing, aggC);
            incrementalRecord(tsPathH, sid);
            writeProbe({ time: new Date().toISOString(), event: 'Hook', ok: true, sid, sameRound: false,
              note: 'cancelled-round-flush', transcriptPath: tsPathH, stat: aggC,
              line: lineFor(aggC, false, modelC), source: 'transcript-cancelled-round', intrAt: new Date(intrInfo.ts).toISOString() });
            const balC = balanceText();
            showToast(
              toastLine1(aggC, modelC, '（手动取消）', balC, todayUsageTxt()),
              toastLine2(aggC, pricing),
              'cancelled-round-flush'
            );
            // 该轮已彻底结束：推进 lastStopAt，并让下方起点刷新守卫按"已结束"路径刷新起点
            // v2.85/v2.89：就地刷新 lastUserMsgAt（旧起点残留会让下一轮 Stop 聚合窗错位重算被取消轮）
            // + 为新轮 spawn 轮级取消 watcher（v2.89 补回丢失的调用点，同守卫尾部）。
            const nowC = Date.now();
            const psnapC = loadSnapshot(sid) || {};
            saveSnapshot({ file: psnapC.file || hookFile, stat: psnapC.stat || null, lastUserMsgAt: nowC, lastStopAt: nowC }, sid);
            spawnRoundWatcher(sid, tsPathH, nowC, resolveWorkspaceLogFile(hookCwd));
            out({ hookSpecificOutput: {} });
            return;
          }
        }
      }
    }
    // v2.27（2026-08-12，起点刷新守卫）：专家团运行中途用户真实提交（system-reminder 触发 hook）
    // 会把 lastUserMsgAt 刷晚 → Stop 聚合起点变晚 → 漏掉之前的调用（实测 legal 409.3万漏成 159.8万）。
    // 修复：仅当上一轮已结束（lastStopAt >= lastUserMsgAt，即有过完成的 Stop/watcher 弹窗）才刷新起点；
    // 专家团进行中（无完成的 Stop）→ 保留旧起点，中途插话不重置本轮。
    const psnap2 = loadSnapshot(sid) || {};
    const prevStart = psnap2.lastUserMsgAt || 0;
    const prevStop = psnap2.lastStopAt || 0;
    const inProgress = prevStart > 0 && prevStop < prevStart; // 上一轮未结束（专家团进行中）
    const nowH = Date.now();
    saveSnapshot({ file: hookFile, stat, lastUserMsgAt: inProgress ? prevStart : nowH, lastStopAt: psnap2.lastStopAt || 0 }, sid);
    // v2.85/v2.89：全新轮（上一轮已结算）→ 为本轮 spawn 轮级取消 watcher。
    // v2.89 补记：v2.85 的这个调用点在后续编辑中丢失（测试直接调 --round-watch 入口、未覆盖
    // spawn 链路 → 6 项回放全 PASS 仍漏检），真实取消自 09-03 起全部退化为下一轮 hook 兜底。
    if (!inProgress && tsPathH) spawnRoundWatcher(sid, tsPathH, nowH, resolveWorkspaceLogFile(hookCwd));
    // v2.88：hook 注入行的耗时同源修复（asHook 路径内，tsPathH/prevStart 作用域正确）——
    // 单 trace 口径同样不含轮尾压缩段（trace endedAt 停在模型回复结束，实测 4m5s vs 实际 12m49s）。
    // 轮起点 prevStart（守卫前的上一轮起点）→ transcript 末行 ts 覆盖压缩段；取不到时保持 trace 口径。
    // 放在 saveSnapshot 之后：快照保留 trace 原口径，本次注入行用整轮口径。
    try {
      if (!sameRound && stat && stat.durMs != null && tsPathH && fs.existsSync(tsPathH) && prevStart > 0) {
        const tl = lastTranscLine(tsPathH);
        const tlTs = tl ? Number(tl.timestamp || 0) : 0;
        if (tlTs > prevStart) stat.durMs = Math.min(tlTs, Date.now()) - prevStart;
      }
    } catch (e) { /* 保持 trace 口径 */ }
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
  aggregateMainOnly, aggregateSubsOnly,
  todayDisplay, reportTxt, reportSummaryTxt, normalizeDailyUsage,
  mainModelState, lastTranscLine, coalescePath, hasActiveSubagentsSince, subagentsDirFromTranscript, subagentPending, subagentsAllStagnant, interruptedByUser, hasSubagentsRecentlyActive,
  interruptedRowsAfter,
  incrementalRecord, loadLedgerWatermark, saveLedgerWatermark,
  estimateInterrupted, estimateInterruptedInc,
  extractUsageFromRow, terminalErrorFromRow, terminalError, contextOverflowOmen,
  showToast, toastLineTagged,
  traceWallDurMs, withFileLock,
  loadPricing, autoRefreshPricing, addModelPrice, savePricing, normalizeModelName, saveDailyUsageRaw,
  getTranscriptStats, sidFromPath, ledgerKey,
};
