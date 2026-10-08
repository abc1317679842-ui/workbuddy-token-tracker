#!/usr/bin/env node
// token-usage-tracker v3.40.0 (2026-10-10)
//
// ── 版本要点（v2.61 … v3.32.1）已迁出本文件 ──────────────────────────────
//   为什么要迁：这段逐版要点是 CHANGELOG.md 的镜像，且**永不参与运行**，却常驻文件头部——
//   读文件时先要越过两百多行历史（与 SKILL.md v3.23.0 那次瘦身同一个病根：把"历史"当"上下文"）。
//   迁到 docs/version-diary.md（默认不加载，需要时再读）；**权威变更记录一律以 CHANGELOG.md 为准**。
//   本文件头部此后只保留**参与运行/供人定位**的内容：版本号行（T12-i4 守卫）+ 用法 + 轮次语义 + 测试开关。
//
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
//
// ── 静默 catch 约定（v3.33.0 T-19）──────────────────────────────────────
//   本技能有意保留一批**空 catch**：toast / 诊断日志 / 清理失败**必须静默**——为它们加日志
//   就是把噪音写进日志本身，而且这些路径每次运行都会走到（见下方白名单类别）。问题在于
//   此前"刻意静默"与"忘了写处理"在这份代码里长得**一模一样**，谁也没法一眼分辨。
//   约定：本技能内所有 `catch (x) {}` **必须**在行尾带 `// silent-ok:<类别> — <理由>`。
//   类别四选一：
//     · 诊断 —— 只影响诊断/形态快照的采集，失败留空即可
//     · 清理 —— unlink / kill / mkdir 这类收尾动作，失败多为"本来就没了"或"下次再清"
//     · 探测 —— 候选路径/环境枚举，未命中即试下一个
//     · 降级 —— 紧随其后有明确回退路径（会改变行为，但回退是设计好的）
//   **不在这四类里的静默 = 缺陷**：要么补降级/告警，要么补进白名单并写清理由。
//   selftest T33 逐条核对（未标注即红），所以"顺手吞掉一个错误"不再能蒙过去。
//
//   注意：`catch (e) { return <兜底>; }` **不算**裸 catch（它有明确返回值），本约定只管 `{}`。

const fs = require('fs');
const path = require('path');
const os = require('os');
const peakRules = require('./peak-rules.js'); // v3.19.0（P1）：峰谷判定的单一实现，与 backfill/recalc-day 共用
// v3.32.0（方案 H2/H3）：触发判定纯函数与主脚本共用同一实现（不许两边各抄一份条件）。
//   refresh-holidays.js 顶部 IIFE 有 require.main 守卫（v3.29.0），被 require 不会联网/写盘。
const holidayModule = require('./refresh-holidays.js');
// v3.32.0（P1-3）：USD→CNY 兜底汇率**单一真源**在 refresh-prices.js（DEFAULT_RATE）——
//   此前 addModelPrice 兜底处又硬编码了一个 7.2，两处一旦改不同步就会静默跑偏。require 无循环
//   （refresh-prices → deepseek-official，均不反向依赖主脚本），且两者顶层都有 require.main 守卫。
const priceRefreshModule = require('./refresh-prices.js');
// v3.35.0（B1）：Stop 端（--stop）处理整块迁出到 stop-handler.js——main() 曾 1151 行，把
//   「CLI 分发 / --hook 路径 / --stop 路径」三件语义不同的事压在一起，v3.34.0 修的 P0-1
//   （--hook 兜底对已记账轮次重复计费）正是这种「一段代码服务两个相反契约」的结构孕育出来的。
//   单向依赖：**本脚本 → stop-handler.js**，stop-handler 不反向 require 主脚本（无循环），
//   它需要的 46 个只读能力由调用点显式注入（漏传/改名 → selftest T37 立刻红）。
const { handleStopEnd, STOP_TX_NAMES } = require('./stop-handler.js');

// v3.16（2026-09-28，外部用户 PR#2 要点采纳）：数据根智能探测。
// 背景：较新版本 WorkBuddy 客户端可能把数据根迁移到 ~/.workbuddy-ai（~/.workbuddy 仅剩
// device-id/logs），此时写死 ~/.workbuddy 会读不到任何 trace → 记账全 0、弹窗空。
// 探测顺序：WB_ROOT 环境变量（测试/隔离用，最高优先）> ~/.workbuddy-ai > ~/.workbuddy（兜底）。
function detectWorkBuddyRoot() {
  const h = os.homedir();
  const cands = [path.join(h, '.workbuddy-ai'), path.join(h, '.workbuddy')];
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'traces')) || fs.existsSync(path.join(c, 'settings.json'))) return c;
    } catch (e) { /* 单个候选探测失败不影响下一个 */ }
  }
  return path.join(h, '.workbuddy'); // 两个都判不出 → 旧默认，行为向后兼容
}
const WB = process.env.WB_ROOT || detectWorkBuddyRoot();
const TRACE_DIR = path.join(WB, 'traces');

// ===== 联网功能开关（v2.30）=====
// 说明：本脚本默认「零密钥联网」——唯一的密钥型请求（DeepSeek 余额查询）默认关闭。
// 公开价表（OpenRouter）每日自动刷新/新模型补录默认开启，均无需密钥，失败自动降级为本地价。
// 三个分开关各自独立；ENABLE_NETWORK=false 时所有联网请求一律跳过（一键零联网）。
// v3.29.0（A-3③）：允许环境变量强制关闭——此前 WB_NO_NET=1 只被 refresh-prices.js / deepseek-official.js
//   消费，主脚本自己完全不读，于是「离线自测」（CI 里设 WB_NO_NET=1）对主脚本无效、仍会发起真实网络请求。
//   现主脚本同样遵从 WB_NO_NET / WB_DISABLE_NET（任一为 '1' 即全局关闭）；local-config.json 对分开关的
//   控制语义不变（ENABLE_NETWORK=false 时全部分开关短路，见下方 ENABLE_NETWORK && ENABLE_XXX 判断）。
const ENABLE_NETWORK = !(process.env.WB_NO_NET === '1' || process.env.WB_DISABLE_NET === '1'); // 总开关：false = 全部联网功能关闭（含分开关）
// v3.18（2026-09-30）：余额查询开关改读**本地未入库**配置 local-config.json（仓库分发版默认 false）。
//   要开启：在技能目录放 local-config.json 写 {"enable_balance_query": true}（该文件不进仓库，
//   密钥本身仍在 models.json）。2026-09-28 用户曾指令本机开启（弹窗第二行显示「余额¥X」），
//   本机由 local-config.json 承接，不再改源码默认值。
function loadLocalFlag(name, dflt) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'local-config.json'), 'utf-8'));
    return typeof cfg[name] === 'boolean' ? cfg[name] : dflt;
  } catch (e) { return dflt; }
}
const ENABLE_BALANCE_QUERY = loadLocalFlag('enable_balance_query', false);
const ENABLE_PRICE_REFRESH = true;  // 分开关2：每日价格自动刷新（OpenRouter 公开价表，无需密钥）
const ENABLE_MODEL_LOOKUP = true;   // 分开关3：新模型价格自动补录（OpenRouter 公开价表，无需密钥）
// v3.21.0：分开关4——版本更新检查（匿名读 GitHub releases/latest，**只读、零密钥、不含任何本地数据**）。
//   默认开启；要关掉在技能目录的 local-config.json 写 {"enable_update_check": false}。
//   作用范围：仅在 `--hook` 路径触发（用户提问时），7 天闸门 → 绝大多数轮次零联网。
const ENABLE_UPDATE_CHECK = loadLocalFlag('enable_update_check', true);
// v3.32.0（方案 H3）：分开关5——假日数据自适应自动刷新（2 个 GitHub 公开仓库请求，零密钥、不含本地数据）。
//   默认开启：DeepSeek 峰谷计费依赖法定假日表，表过期/缺失 = 双向静默计费偏差（真假日按高峰×2 多算、
//   调休上班日按周末低峰少算）。触发条件见 refresh-holidays.js 的 holidayRefreshNeeded（不满足完全不联网）。
//   要关掉在 local-config.json 写 {"enable_holiday_refresh": false}。
const ENABLE_HOLIDAY_REFRESH = loadLocalFlag('enable_holiday_refresh', true);
// 余额查询安全性：开启后仅向官方 https://api.deepseek.com/user/balance 发送请求，密钥只通过
// Authorization: Bearer 头传给该官方域名，不会发给第三方；请求内容不含任何本地数据。
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
    try { shape.lineCount = getTranscriptStats(tsPath).lineCount; } catch (e) {} // silent-ok:诊断 — compaction 形态快照，只读、绝不抛错
    try {
      const tl = lastTranscLine(tsPath);
      shape.tail = tl ? { type: tl.type, role: tl.role || null, status: tl.status || null } : null;
    } catch (e) {} // silent-ok:诊断 — 同上（末行类型采集失败即留空）
    try {
      let mid = null;
      for (const ln of readTailRawLines(tsPath, 30)) { const m = compactionMarkerId(ln); if (m !== null) mid = m; }
      shape.markerId = mid;
    } catch (e) {} // silent-ok:诊断 — 同上（压缩标记 id 采集失败即留空）
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
      // v3.19.3：compactionSuspected / compactionMode / lastMarkerId 三个字段已删除。
      // 前两者在原压缩状态机里结构性恒为 false/null（compactionSuspected 置 true 后立刻 continue，
      // 永远到不了这里；compactionMode 从未被置 true），留在日志里只会误导排查。
      tailFingerprint: st.tailFingerprint != null ? st.tailFingerprint : null, // v3.18（M14）：原 tailRawPrefix 存原文前 80 字符，改指纹
      lastTailFingerprint: st.lastTailFingerprint != null ? st.lastTailFingerprint : null,
      pendingSubCount: st.pendingSubCount != null ? st.pendingSubCount : null,
      hasNewTail: st.hasNewTail != null ? st.hasNewTail : null,
      watchStartTime: st.watchStartTime != null ? st.watchStartTime : null,
      traceFile: st.traceFile != null ? st.traceFile : (gLastTraceFile != null ? gLastTraceFile : null),
      // v3.33.0（补-S5 声明 + 截断评估）：本字段 = 弹窗完整文案（showToast 传的 `line1 + ' | ' + line2`），
      //   以**本机明文 JSON Lines** 落 TOAST_LOG_PATH（~/.workbuddy/token-tracker-toast.log），**只写本地、不上传**。
      //     该落盘事实已如实写进 README「隐私与数据安全」的本地落盘表与 CHANGELOG「隐私与安全」（v3.33.0 补声明）。
      //   内容构成：模型名 / 耗时 / 输入·输出·缓存 token 数 / 金额 / 缓存命中率 / 价格标注；余额查询开启
      //     且余额发生变动时，line1 会带一个「余额¥X」数字。**不含用户消息正文、文件路径、对话内容**——
      //     实证：本机 1779 条真实记录全字段扫描，toastText 无一例外只含上述字段（它就是你眼睛已经看到的那两行）。
      //   截断评估（为何 cap=200 且不改）：实测 1779 条样本 toastText 长度 p50=69 / p90=76 / max=87，
      //     **恰好触顶 200 的 0 条 → 从未发生截断**，cap 是实测最大值的 2.3 倍。保留 cap 只为一件事：
      //     将来若有人往 toast 里加长标注（模型名变长 / 新增分段），防单行撑爆日志。故**不加宽、不改动**。
      //     审计原话把它与 rounds 的「用户消息前 40 字明文」并列，实为两类数据（那份才真的含用户文本）。
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
    // v3.34.0（P0-1）：本轮用量**在写 coalesce 之前已经入账**的标记。
    //   只写 true（false/缺省不写字段 → 与旧格式逐字节一致，零噪音）。
    if (meta.alreadyRecorded === true) payload.alreadyRecorded = true;
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
  // v3.38.0（C3②）：**已有 watcher 且心跳新鲜 → 直接判定"已接管"**，不必再 spawn 一个。
  //   旧逻辑只看"spawn 后锁 mtime 是否变化"：若已有 watcher 持有心跳锁，新 spawn 的那个拿不到锁、
  //   也不会刷新 mtime → 1.5s 后误判"启动失败"，白跑一次降级分支。心跳锁让"谁在跑"变得可直接读取。
  try {
    if (fs.existsSync(lockF)) {
      const lo = JSON.parse(fs.readFileSync(lockF, 'utf-8'));
      if (lo && lo.hb === 1 && Number.isFinite(Number(lo.at)) && (Date.now() - Number(lo.at)) < 15000) return true;
    }
  } catch (e) { /* 锁不可读 → 走下方 spawn 判定 */ }
  spawnFlushWatcher(sid);
  for (let i = 0; i < 10; i++) {                 // 最多约 1.5s（10 × 150ms）
    if (lastWatcherSpawnError) return false;     // 已收到异步 error → 立即判定失败，不空等
    try {
      if (fs.existsSync(lockF) && fs.statSync(lockF).mtimeMs > lockBefore) return true; // 锁被新建/更新 → watcher 已接管
    } catch (e) { /* 读取瞬时失败：下一轮重试 */ }
    try { syncSleepMs(150); } catch (e) { /* sleep 150ms（v3.18：原 ping.exe 模拟，改 Atomics.wait） */ }
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
    // v3.19.2（B2）：改用探测出的数据根 WB，与 detectWorkBuddyRoot() 一致。
    // 原写死 ~/.workbuddy → 数据根迁到 ~/.workbuddy-ai 的用户此处永久失效（第二信号源丢失），
    // 且 WB_ROOT 隔离测试会误读真实 ~/.workbuddy/logs。
    const dir = path.join(WB, 'logs', todayStr());
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
//   背景：原实现曾硬编码作者本机的某个具体工作区路径（v3.18 已彻底删除，见下方 cands 注释），
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
  // v3.18（M1）：删除旧实现遗留的作者个人绝对路径兜底——对其他用户必然是死路径，
  // 且向所有安装者泄漏作者用户名/目录结构。自动发现（①②③）未命中时返回空串走降级路径即可。
  for (const c of cands) {
    if (!c) continue;
    try { if (fs.existsSync(path.join(c, 'index.json'))) return c; } catch (e) { /* 继续下一候选 */ }
  }
  return cands[0] || ''; // 均未命中 → 返回首个候选（触发既有告警与降级路径）
}
const CN_PRICE_DIR = autoDiscoverCnPriceDir();
const CN_PRICE_DB = path.join(CN_PRICE_DIR, 'index.json');
// 抓价流水线目录：同样自适应——优先环境变量，其次价库所在目录（v3.18 删个人路径兜底）。
const CN_PRICE_PIPELINE_DIR = process.env.CN_PRICE_PIPELINE_DIR
  || (CN_PRICE_DIR ? path.dirname(CN_PRICE_DIR) : '');
const CN_PRICE_REFRESH_LOCK = path.join(CN_PRICE_DIR, '.refresh.lock');
const CN_PRICE_REFRESH_ERR = path.join(CN_PRICE_DIR, '.refresh.error'); // v2.82：刷新失败原因留档
const PRICING_LOCK_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.pricing.lock'); // 修复6：pricing 并发写锁
const MODELS_CFG = path.join(WB, 'models.json'); // 自定义 API 配置（含 apiKey），仅 DeepSeek 官方模型启用余额显示
const BALANCE_CACHE = path.join(WB, 'skills', 'token-usage-tracker', '.balance.json');
const DAILY_USAGE_FILE = path.join(WB, 'skills', 'token-usage-tracker', 'daily-usage.json'); // v2.39：每日账本（按本地日期分桶，{日期:{models:{模型:{in,out,cached,total,cost}}, total:{...}}}，长期保存不裁剪）
// v3.18（M3 修复）：不再往账本写「读取方指令」字段——数据文件里塞指令 = 任何能写账本的本地进程
// 都能给 AI 下指令（数据→指令通道），且 --report 会把它原样打印进用户界面。展示约定只保留在
// SKILL.md；历史账本里已存在的 _instructions 由 normalizeDailyUsage 继续剥离，下次写盘自然消失。
const LEDGER_WATERMARK_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.ledger-watermark.json'); // v2.50：增量记账水位线（{sid:{main:已记账主transcript行数, subs:{子代理文件名:已记账行数}}}）
const TRANSC_TRUNCATED_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.transcript-truncated.json'); // v3.24.0：级联①截断告警旗标（{at, path, watermark}；toast 显示 ⚠账缺）
const BALANCE_TTL_MS = 15 * 1000; // 余额缓存 15 秒（v2.18 从 60s 压短：用户要求实时，接口实测 300ms 级；正常轮询间隔 >15s 即每轮拿实时数，15s 内连发才复用）
// 积分/自定义 API 模式识别（v2.10）：官方文档证实内置模型列表就有 deepseek-v4-flash（与自定义 id 同名），
// trace/hook payload/transcript 无模式标记，进程级探测（tasklist/wmic/netstat）被本机安全策略禁用——
// "密钥是否在用"信号抓不到。用户认可方案 = **默认不显示，检测到余额变化才显示**：
// 余额会变 = DeepSeek 账户在真实消耗 = 自定义 API 模式（或其他处使用同一 key），这正是"有密钥才有消耗"的等价信号；
// 积分模式余额恒定 → 永不显示。
const BALANCE_HISTORY_MAX = 20;        // 缓存里保留的余额观测条数（用于与上次对比判定"是否变化"）

// ===== v3.20.0：轮次明细留档（rounds/rounds-YYYY-MM.jsonl）=====
// 用途：每日账本只回答"某天某模型花了多少"，回答不了"哪一轮异常大 / 子代理占了多少"——
//   本轮次留档把每轮 token 用量落一条 JSONL，作为下钻分析的地基。
// 口径（**硬规矩，不要改**）：in/out/cached/total 是平台落盘的真实用量；
//   costApiEquiv 是按 pricing.json 的 API 单价折算的**等价金额，不是真实扣费**——
//   WorkBuddy 内置模型走客户端自带额度，本技能读不到额度扣减，故一律不做"金额↔积分"换算。
const ROUNDS_DIR = path.join(__dirname, 'rounds');
const ROUNDS_KEEP_MONTHS = 6;          // 保留最近 N 个月，--report 运行时顺带清理
const ROUND_LABEL_MAX = 40;            // 轮次标签（本轮首条 user 消息）截断长度
const EXPORTS_DIR = path.join(__dirname, 'exports'); // v3.20.0：--report --csv 落盘目录（已 gitignore）
// v3.34.0（A2·第五轮审计 P1）：exports/ 此前**零清理**——每次 `--report --csv` 都按秒级时间戳新建
//   一个 CSV，目录只增不减（rounds/ 至少有保留期，exports/ 连保留期都没有）。
//   与 rounds/ 同款：只在 --report 入口跑，不引入常驻任务；按文件 mtime 保留最近 N 天。
//   ⚠️ 只认 `report-*.csv` 前缀——目录里若有用户手放的别的文件，一律不动（绝不误删）。
const EXPORTS_KEEP_DAYS = 30;

// ===== v2.66 通用工具：模型名归一化 + 文件锁 + 原子写 =====
// 账本文件曾损坏 → 本轮禁止写回空对象以免覆盖历史（损坏文件已备份为 .corrupt）
let gDailyCorrupt = false;
// v3.40.0（plan-B A21）：本进程是否**真的隔离过**损坏账本（rename 成 .corrupt-<ts>）。
//   与 gDailyCorrupt 分工：后者是"本轮别写回"的闸门，本标志是"文件是我自己搬走的"的记忆。
//   两者一起才能回答 loadDailyUsage 的 ENOENT 分支该不该复位（见该处注释）。
let gLedgerQuarantined = false;

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

// v3.27.0：**「查到了但厂商未公布按 token 价」**的哨兵值（匿名模型 / 订阅制模型，OpenRouter 标 $0）。
//   与 `null`（查不到这个模型）、`undefined`（网络/解析失败）三者严格区分——三种情况处理方式不同：
//     null  → not-found：不写入任何条目，弹窗标 ⚠未计价
//     undefined → 失败：静默重试下轮
//     NO_PUBLIC_PRICE → 写入 pricing_status:'unpublished' 的 0 元条目，弹窗/账本标「无公开价」
//   为什么必须单独一类：把 $0 当合法价写进价库，会让弹窗显示 ¥<0.01（读起来像"几乎免费"）、
//   账本记 cost:0（与"真的免费"不可区分），当日合计被系统性低估且零提示——静默失败。
const NO_PUBLIC_PRICE = Symbol('no_public_price');

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
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (e) {} // silent-ok:清理 — 建锁目录；真失败会在随后的建锁处报错
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
    const merged = Object.assign({}, d); // v3.18：不再注入 _instructions（见 DAILY_USAGE_FILE 上方注释）
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
    } catch (e) {} // silent-ok:降级 — 时长估算失败即回退 source=fallback（下方随即判定）
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
// v3.19.3（压缩判定降级）：判断 transcript 末尾窗口内是否存在"新鲜的"压缩标记，返回标记 id 或 null。
// 背景：原 compactionMode / compressionPending 状态机（v2.62 / v2.70）经全量日志复核，在生产环境
// **从未生效过一次**（compactionMode=true 出现 0 次、compression-omen/resumed/timeout 各 0 次、
// 185 次 flush-watch 启动快照命中标记 0 次）——原因是压缩判定只活在 flush watcher 内，而 55% 的
// 弹窗走 Stop 端同步路径、根本不启动 watcher；且压缩标记在 Stop 时刻早已滑出末尾 30 行窗口
// （1158 次 stop-transcript 仅 6 次命中）。该状态机已整体删除，只在下方 Stop 端 no-token 分支
// 保留这一个单点判据。
// 唯一需要豁免的真实场景（2026-09-12 07:31 实测）：上下文压缩期间客户端会连续触发多次 Stop，
// 每次本轮都无 usage → 连弹 3 条"本轮无 token 消耗记录"。
// 判据：末尾 30 行内存在压缩标记，且该标记行 timestamp 距现在不超过 ttl（默认 10 分钟，
// COMPACTION_MARKER_TTL_MS 可覆盖）——TTL 用于排除上一轮遗留的旧标记（标记在压缩完成瞬间落盘，
// 之后 transcript 仍会追加大量行，旧标记可能长期停留在末尾窗口内）。
function freshCompactionMarker(tsPath, ttlMs) {
  try {
    if (!tsPath) return null;
    const now = Date.now();
    const ttl = (typeof ttlMs === 'number' && ttlMs > 0)
      ? ttlMs
      : (Number(process.env.COMPACTION_MARKER_TTL_MS) || 10 * 60 * 1000);
    let hit = null;
    for (const ln of readTailRawLines(tsPath, 30)) {
      const id = compactionMarkerId(ln);
      if (id === null) continue;
      let ts = 0;
      try { const o = JSON.parse(ln); ts = Number(o && o.timestamp) || 0; } catch (e) { ts = 0; }
      // 无时间戳无法判定新鲜度 → 保守视为新鲜（宁可不弹这条噪音，也不误报"无记录"）
      if (!ts || (now - ts) <= ttl) hit = id;
    }
    return hit;
  } catch (e) { return null; }
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
// v3.16（2026-09-28，外部用户 Issue#3-① 采纳）：transcript_path 截断兜底。
// 背景（外部用户实测）：客户端偶尔把 transcript_path 末尾截断 2 字符（bcf...e5618 → bcf...e5），
// existsSync=false → 返回 null → transcript 记账整条被跳过 → toast 有显示（traces 兜底）但
// daily-usage 永远为空。防御：路径找不到文件时，用 session_id 在 projects/ 下按文件名精确匹配
// 兜底（projects/<会话目录>/<sid>.jsonl，兼容旧布局 projects/<sid>.jsonl）。慢路径仅在
// 常规路径失效时触发，不影响正常会话性能。
function findTranscriptBySessionId(sid) {
  const safe = String(sid || '').replace(/[^a-zA-Z0-9_-]/g, ''); // 防路径注入（同 snapPath C6）
  if (!safe) return null;
  const root = path.join(WB, 'projects');
  const names = [safe + '.jsonl', safe + '.json'];
  try {
    for (const d of fs.readdirSync(root)) {
      for (const nm of names) {
        const fp = path.join(root, d, nm);
        try { if (fs.existsSync(fp)) return fp; } catch (e) {} // silent-ok:探测 — 路径候选探测，未命中即试下一个
      }
    }
    for (const nm of names) {
      const fp = path.join(root, nm);
      try { if (fs.existsSync(fp)) return fp; } catch (e) {} // silent-ok:探测 — 同上
    }
  } catch (e) { /* projects/ 不存在等 → 放弃兜底 */ }
  return null;
}

function transcriptPathFromPayload(payloadRaw) {
  try {
    const p = JSON.parse(payloadRaw);
    let tp = p && p.transcript_path ? String(p.transcript_path) : '';
    if (!tp) return null;
    if (/\.jsonl?$/.test(tp)) { /* 已是 json/jsonl */ }
    else if (tp.endsWith('.json')) tp = tp + 'l';
    if (!fs.existsSync(tp) && tp.endsWith('l')) tp = tp.slice(0, -1); // .jsonl 不存在回退 .json
    if (fs.existsSync(tp)) return tp;
    // v3.16 截断兜底：常规路径失效 → 按 session_id 精确匹配
    return findTranscriptBySessionId(p && p.session_id);
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
// v3.19.2（B1）：旧注释的等价性依据（"文件总以 '\n' 结尾、无空行、无可解析失败行，故已解析行数 ≡ 原始行号"）
//   是**从未被强制的假设**——compaction 重写残留、进程被杀留下的残行都会打破它，
//   而一旦打破就是静默多记账。现已把水位线口径直接改成"完整行数"，不再依赖该假设。
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
//   rows       —— 水位线之后、**完整行**中解析成功的行
//   totalLines —— 已消费的**完整行数**（文件内 '\n' 的累计个数），水位线口径
//
// v3.19.2（B1 修复）：水位线口径由"解析成功行数"改为"物理完整行数"。
//   旧实现拿「解析成功行数」当水位线，却用「换行符个数」做字节偏移定位——两者只在"每行都能解析"时相等。
//   文件中间一旦出现空行或永久坏行（compaction 重写残留 / 进程被杀留下的残行 / 双写竞争），
//   水位线就比真实偏移少 k → 下一轮从第 N-k 个换行符处开始读，而第 N-k…N-1 行**上一轮已经记过账**，
//   于是被再读一遍、再记一遍：静默多记（无 stderr、无告警），实测多记 1 行。
//   现改为：水位线 = 以 '\n' 结尾的完整行累计数，与定位口径严格一致——空行、坏行都照样计入，
//   不再产生重读窗口。尾部没有 '\n' 的半写行不计入水位线（等写完下一轮再读），
//   因此不存在"半写行被提前记账、写完后又记一次"的双记路径。
//   读文件失败时返回 fromLine（水位线不倒退，交由 Math.max 保护）。
function readTranscLinesFrom(tsPath, fromLine) {
  let buf;
  const start = fromLine > 0 ? fromLine : 0;
  try { buf = fs.readFileSync(tsPath); } catch (e) { return { rows: [], totalLines: start }; }
  // 定位到第 start 个完整行之后：跳过 start 个 '\n'（0x0A）
  let off = 0;
  for (let i = 0; i < start; i++) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) {
      // v3.24.0（级联①）：文件完整行数 < 水位线 = 平台**压缩/重写**过历史（重写后的文件不会
      // 恢复到原长度）→「不推进等恢复」成了死代码：水位线永久冻结，之后所有消耗**永久静默少计**。
      // 深修（水位重置 + 按时间戳去重重读）涉及记账核心时序，另行立项（KNOWN-ISSUES KI-5）；
      // 此处先让故障**可见**：落旗标文件，toast 显示「⚠账缺」（24h 节流，不刷屏）。
      try {
        let last = 0;
        try { last = JSON.parse(fs.readFileSync(TRANSC_TRUNCATED_FILE, 'utf-8')).at || 0; } catch (e2) {}
        if (Date.now() - last > 24 * 3600 * 1000) {
          const tf = TRANSC_TRUNCATED_FILE + '.tmp-' + process.pid;
          fs.writeFileSync(tf, JSON.stringify({ at: Date.now(), path: tsPath, watermark: start }));
          fs.renameSync(tf, TRANSC_TRUNCATED_FILE);
          process.stderr.write(`[token-tracker] ⚠ transcript 完整行数少于水位线 ${start}（历史被压缩/重写），水位线已冻结 → 之后的消耗将静默少计。已被压缩的行本地不可恢复（见 KNOWN-ISSUES KI-5）；**不要跑 backfill --write**——它是全量重建替换，会把压缩窗口外的历史账一并抹掉\n`);
        }
      } catch (e2) { /* 旗标写失败不影响记账主流程 */ }
      // v3.25.0（KI-5）：显式告知调用方「这是截断」——调用方 incrementalRecord 据此走
      // 截断恢复分支（水位重置 + 时间戳去重重读）。正常「无新行」路径 totalLines >= start
      // 且 truncated 为 undefined，语义可区分（旧返回值形状完全兼容，多一个字段）。
      return { rows: [], totalLines: start, truncated: true };
    }
    off = nl + 1;
  }
  // 只解析完整行：最后一个 '\n' 之后是半写行，留给下一轮
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < off) return { rows: [], totalLines: start };
  // 统计本轮新增的完整行数（[off, lastNl] 内的 '\n' 个数）
  let added = 0;
  for (let p = buf.indexOf(0x0a, off); p !== -1 && p <= lastNl; p = buf.indexOf(0x0a, p + 1)) added++;
  const rows = parseTranscChunk(buf.toString('utf-8', off, lastNl + 1));
  return { rows, totalLines: start + added };
}

// v3.33.0（A5 对齐）：timestamp 取值口径统一。**同一含义不该有两种判据。**
//   病根：本函数与 `perModelFromRows`（账本入口）用 `typeof ts === 'number'` **硬判**——平台若把
//   timestamp 换成数字字符串，整行用量会被**静默丢弃**（该行明明有 usage，账本却少记），零提示。
//   而本文件其他 10+ 处（estimateInterrupted / peakTs / 起点推断 / msgTsOf …）早就用 `Number(...)`
//   强制转换——同一字段两种判据，迟早分叉。
//   **实测（310 份真实 transcript、抽样 34,960 行）：timestamp 100% 为 number，含 usage 的 8,987 行
//   无一例外 → 该缺陷从未在真实数据上触发，属潜伏型。** 故本次不是"补一个不存在的场景"，而是对齐口径
//   + 把"将来真发生时的静默丢账"改成**有痕**：数字型输入经 Number() 后按位不变（零行为变化），
//   非数字才 warnOnce 到 stderr。
//   注意：null / '' 仍返回 NaN（保持"无有效时间戳就跳过"的原语义，不因 `Number(null)===0` 被放行）。
//   决策类站点（hasTeamActivity / hasNewTranscSince / subagentModelSet）**刻意不动**——它们保守跳过
//   的代价只是"少标一个标签/少触发一次"，而误判的代价更大；且它们不参与记账。
let gNonNumTsWarned = false;
function numTs(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (!gNonNumTsWarned) {
      gNonNumTsWarned = true;
      process.stderr.write(`[token-tracker] ⚠timestamp 不是数字（${JSON.stringify(v)}）——已按数字解析并计入；`
        + '若平台改用 ISO 时间串（本函数无法解析），该行用量会被跳过，请反馈\n');
    }
    return n;
  }
  if (!gNonNumTsWarned) {
    gNonNumTsWarned = true;
    process.stderr.write(`[token-tracker] ⚠timestamp 无法解析为数字（${JSON.stringify(v)}）——该行用量被跳过，请反馈\n`);
  }
  return NaN;
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
  const models = {}; // v3.26.0（KI-6 ⑧）：分模型明细（{name:{in,out,cached,total,lastTs}}）
  for (const r of rows) {
    // v3.33.0（A5）：改 `numTs()`——原 `typeof ts === 'number'` 硬判会让数字字符串时间戳的整行
    //   用量静默消失（见 numTs 上方注释）。数字输入经 Number() 后不变 → 零行为变化。
    const ts = numTs(r.timestamp);
    if (!Number.isFinite(ts) || ts <= fromTs) continue;
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
    // v3.26.0（KI-6 ⑧）：同循环顺手产出**分模型明细**（与总量同一 seen 去重、同一口径）——
    // toastLine2 据此做分模型计价求和（混合模型轮不再整轮按单一主导价折算）。lastTs 供峰谷判定。
    const mkName = normalizeModelName(pd.model || pd.requestModelId || 'unknown');
    // v3.38.2：桶同时记 **firstTs** —— 供按模型分条时算"该模型自己的真实跨度"
    //   （改前只有 lastTs，分条后每条只能照抄整轮 durMs → 子代理条显示成主轮时长，实测 hy3 显示 9m2s）。
    const mb = models[mkName] || (models[mkName] = { in: 0, out: 0, cached: 0, total: 0, lastTs: 0, firstTs: 0 });
    mb.in += u.in; mb.out += u.out; mb.cached += u.cached; mb.total += u.in + u.out;
    if (ts > mb.lastTs) mb.lastTs = ts;
    if (mb.firstTs === 0 || ts < mb.firstTs) mb.firstTs = ts;
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
  return { in: inSum, out: outSum, cached: cachedSum, total: inSum + outSum, durMs: Math.max(0, lastTs - (firstTs || lastTs)), model, firstTs, lastTs, count, reasoning: reasoningSum, models };
}

// v3.26.0（KI-6 ⑧ 自审修正）：被中断估算并入弹窗聚合时必须**同步并入分模型明细**——
//   否则 toastLine2 分模型计价只算完整调用段、漏掉估算段金额，而账本（incrementalRecord）
//   含估算 → 弹窗与账本再次口径分裂（正是 ⑧ 要消灭的形态）。估算桶形状与 models 桶一致
//   （{name:{in,out,cached,total}}，无 lastTs → 补 0，计价按非高峰兜底口径，与估算本身的估算性质一致）。
function mergeEstIntoModels(agg, estByModel) {
  if (!agg || !estByModel) return;
  if (!agg.models || typeof agg.models !== 'object') agg.models = {};
  for (const [n, b] of Object.entries(estByModel)) {
    if (!b || typeof b !== 'object') continue;
    const t = agg.models[n] || (agg.models[n] = { in: 0, out: 0, cached: 0, total: 0, lastTs: 0 });
    t.in += b.in || 0; t.out += b.out || 0; t.cached += b.cached || 0; t.total += b.total || 0;
  }
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
// v3.19.2（B1）：去掉 watermark 参数——它并入水位线体系后已无用途，且语义已与调用方脱节。
function estimateInterruptedInc(tsPath, rows) {
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
  if (!needHistory) return estimateInterrupted(rows, 0);
  // v3.19.2（B1）：回退全量时，本轮新增行就是全量解析成功行的**尾部**（readTranscLines 与
  // parseTranscChunk 用同一套逐行解析规则，同样的行→同样的结果），起点由长度相减得出。
  // 旧实现把 watermark 当索引用，而 watermark 已改为"完整行数"口径，与"解析成功行数"不同量纲 → 会错位。
  const full = readTranscLines(tsPath);
  return estimateInterrupted(full, Math.max(0, full.length - rows.length));
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
    // v3.33.0（A5）：与上方 aggregateTranscLines 同款 `numTs()`——这对孪生函数（注释自称"完全一致的
    //   去重口径"）此前共用同一个硬判 typeof，只修其中一个会让两者口径分叉，故必须同改。
    const ts = numTs(r.timestamp);
    if (!Number.isFinite(ts) || ts <= fromTs) continue;
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
// fullRows：全量解析后的行数组；newStart：**数组下标**（从第几个解析行开始扫）；
// fromTs：**epoch 毫秒时间戳**（可选，仅弹窗路径传"本轮开始时刻"做行级过滤）。
// v3.19.2（B9）：此前 estimateInterruptedInc 把「行数水位线」（如 15234）当 fromTs 传进来，
//   与 ~1.7e12 的毫秒时间戳比较恒为真 → 该过滤器形同空转（当前无害，但语义是错的）。
//   B1 修复后该调用点已不再传第三参，此处显式声明量纲，禁止再拿行数当时间戳。
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
        // v3.19.2（B7）：补 i 标志，与其余 8 处 agent-*.jsonl 正则统一（大小写不敏感）
        if (!/^agent-.*\.jsonl$/i.test(f)) continue;
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
        if (!/^agent-.*\.jsonl$/i.test(f)) continue;
        const fp = path.join(subDir, f);
        let mt = 0;
        try { mt = fs.statSync(fp).mtimeMs; } catch (e) { continue; }
        if (mt <= roundStartMs) continue; // 本轮之前创建的子代理（上一轮专家团）→ 排除
        subRows = subRows.concat(readTranscLines(fp));
      }
    } catch (e) { /* subagents 读取失败：忽略子代理部分 */ }
  }
  // v3.13（2026-09-23）：子代理行**必须做行级时间戳过滤**（原先传 0 = 不过滤）。
  //   根因实测：子代理文件被"唤醒/复用"时（如给旧成员发消息），文件 mtime 变新 → 被算作"本轮"，
  //   但文件里**含更早轮次的行** → 不过滤会把旧行也算进本轮 → **弹窗数字偏大**
  //   （真实数据实测：唤醒 agent-51c238cc 后，连续 5 轮各多算 82.0 万 token）。
  //   ⚠️ 账本不受影响：账本走 `.ledger-watermark.json` 行数水位线，同一行只记一次；
  //   本处只修"每次全量重算"的弹窗路径，使其与 `aggregateSubsOnly`（拆分路径）口径一致。
  const sub = aggregateTranscLines(subRows, roundStartMs); // 子代理文件本身只属于本次专家团
  if (!main && !sub) return null;
  // v3.11：区分「主模型」与「子代理模型」（**仅供显示**）。历史根因：下面的 model 字段是
  //   `sub.model || main.model`（子代理优先）→ 团队轮标题显示成子代理模型（如 hy3），用户误以为自己的模型变了。
  //   ⚠️ 但 `model` 字段**不能改**——`calcCost`（:2197）用它取价目表算全轮费用，改了会让费用静默换价目表。
  //   因此新增 modelMain（主转录主导模型）与 subModels（子代理模型，按 token 降序去重）专供弹窗显示。
  const subModels = (() => {
    try {
      // v3.19.2（B6）：行级时间过滤与 aggregateTranscLines(subRows, roundStartMs) 对齐。
      //   原先传 0（不过滤）→ 子代理文件被唤醒复用时，旧轮的行会被算进本轮，
      //   toast 第一行「（子代理 XXX）」可能标到一个本轮根本没跑的模型（仅影响显示，token/账本无关）。
      const m = perModelFromRows(subRows, roundStartMs);
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
  // v3.26.0（KI-6 ⑧）：合并主+子代理的分模型明细 → toastLine2 分模型计价（与账本同口径）。
  // 旧缺陷：混合模型轮 toast 金额 = 全部 tokens 按 model 字段（子代理优先）单一价折算。
  res.models = {};
  for (const part of [main, sub]) {
    if (!part || !part.models) continue;
    for (const [n, b] of Object.entries(part.models)) {
      const t = res.models[n] || (res.models[n] = { in: 0, out: 0, cached: 0, total: 0, lastTs: 0, firstTs: 0 });
      t.in += b.in; t.out += b.out; t.cached += b.cached; t.total += b.total;
      if (b.lastTs > t.lastTs) t.lastTs = b.lastTs;
      // v3.38.2：合并时也要带上 firstTs（否则主+子代理同名桶的首时间戳丢失 → 该条跨度算不出来）
      if (b.firstTs && (!t.firstTs || b.firstTs < t.firstTs)) t.firstTs = b.firstTs;
    }
  }
  // v3.19.2（B10）：显式处理"两个 firstTs 都为空"——原 Math.min(...[]) = Infinity，
  //   durMs = Math.max(0, lastTs - Infinity) = 0。当前不可达（上方已保证 main/sub 至少一个非空
  //   且 firstTs 恒为真实 epoch ms），属防御性写法，结果与旧行为一致但不再依赖 Infinity 传播。
  const firstCands = [main && main.firstTs, sub && sub.firstTs].filter(Boolean);
  const firstTs = firstCands.length ? Math.min(...firstCands) : 0;
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
    // v3.38.0：带上**分模型明细**（优先用 aggregateTranscLines 算好的 sub.models，含 lastTs，
    //   与整轮聚合 res.models 同口径）——供弹窗「按模型分条」各自单独计价（见 splitByModelStats）。
    //   旧行为不变：此前本函数返回对象没有 models，调用方（toastLine2）会回退到单模型计价；
    //   现在多模型轮改为逐模型计价，与账本口径一致（v3.26.0 ⑧ 的设计意图）。
    models: sub.models || byModel,
    count: sub.count, durMs: sub.durMs, firstTs: sub.firstTs, lastTs: sub.lastTs, reasoning: sub.reasoning,
  };
}

// v3.38.0（用户 2026-10-08 定案）：把整轮聚合**按模型拆成多条弹窗 stat**。
//   需求：主模型任务结束时跟着弹——同模型合并 1 条；**每种不同模型的子代理各 1 条**
//   （例：主 hy4-preview + 子 hy3 / deepseek-v4.1-flash / glm → 1 + 3 = 4 条）。
//   实现要点：
//     ① 按模型分桶（models 明细本就是按模型合并的）→ 与主模型同模型天然并入主模型那条（落实 v2.95）；
//     ② 每条只带自己那一桶 models → toastLine2 分模型计价（v3.26.0 ⑧）**各自单独计价**，不做跨模型混合；
//     ③ 返回 [] = 无法拆（无明细 / 只有 1 个模型）→ 调用方走原单条路径，行为**逐字节不变**；
//     ④ token=0 的模型桶不产出（V13：空跑不该弹窗）；本地模型桶照常产出（显示「本地·免费」）。
//   排序：主模型第一条，其余按 token 降序。
function splitByModelStats(agg) {
  try {
    if (!agg) return [];
    const modelsObj = (agg.models && typeof agg.models === 'object') ? agg.models : null;
    if (!modelsObj) return [];
    const keys = Object.keys(modelsObj).filter((n) => {
      const b = modelsObj[n];
      if (!b || typeof b !== 'object') return false;
      return (Number(b.total) || (Number(b.in) || 0) + (Number(b.out) || 0)) > 0;
    });
    if (keys.length <= 1) return []; // 单模型 → 不拆（保持原单条行为）
    const mainKey = normalizeModelName(agg.modelMain || agg.model || '');
    keys.sort((a, b) => {
      if (normalizeModelName(a) === mainKey) return -1;
      if (normalizeModelName(b) === mainKey) return 1;
      return (Number(modelsObj[b].total) || 0) - (Number(modelsObj[a].total) || 0);
    });
    return keys.map((n) => {
      const b = modelsObj[n];
      return {
        model: n,
        stat: {
          in: b.in || 0, out: b.out || 0, cached: b.cached || 0,
          total: b.total || ((b.in || 0) + (b.out || 0)),
          model: n, modelMain: n, subModels: undefined,
          models: { [n]: b }, // 单桶 → 该条只按该模型计价
          count: b.count || 0,
          // v3.38.2：耗时改用**该模型桶自己的跨度**（首行→末行），不再照抄整轮 durMs。
          //   改前：每条 stat.durMs = agg.durMs → 主条与子代理条显示同一个整轮时长（实测两条都是 9m2s，
          //   而 hy3 子代理实际只跑了 6.9s）。改后：子代理条显示真实跨度；主模型桶横跨全轮 → 主条基本不变。
          //   口径说明（写进 CHANGELOG / SKILL 的已知局限）：跨度是**墙钟**口径——并行子代理不累加
          //   （2 个并行各 4.0s / 6.9s → 显示 6.9s，不是 10.9s）；多批次（返回→主模型再派）含批间等待 → 偏大。
          durMs: Math.max(0, (b.lastTs || agg.lastTs) - (b.firstTs || agg.firstTs)),
          firstTs: b.firstTs || agg.firstTs, lastTs: b.lastTs || agg.lastTs,
        },
      };
    });
  } catch (e) { return []; } // 拆分失败 → 退化为单条，绝不因显示改造丢弹窗
}

// v3.38.0（C3③）：**按模型分条弹窗**的唯一实现（flush-delayed 收口 / --hook 兜底 / v3.12 补弹三处共用）。
//   为什么抽成函数（而非在 main() 内展开）：v3.35.0 拆分 main() 的守卫（T37-b1，上限 950 行）不允许
//   把显示逻辑堆回 main；且三处出口共用同一实现，才不会出现"watcher 分条了、兜底没分条"的漂移。
//   返回：true = 已分条弹出（≥2 个模型）；false = 单模型或无法拆 → 调用方走原单条路径（行为不变）。
//   参数 opts：{ pricing, tsPath, roundStart, bal, firstToday, reason, alwaysTag, subs }
//     firstToday —— 只给第一条用（--hook 兜底路径它可能是带记账的 todayDisplay，绝不能重复调用）；
//     alwaysTag  —— 补弹子代理条时用：每条都挂形态标注（该 agg 本来就只含子代理）；
//     subs       —— 调用方已算好的 subagentModelSet，避免重复扫盘。
function showToastsSplitByModel(agg, opts) {
  const o = opts || {};
  const pricing = o.pricing;
  const parts = splitByModelStats(agg);
  if (parts.length <= 1) return false;
  const subs = o.subs || subagentModelSet(o.tsPath, o.roundStart || 0);
  const mainKey = normalizeModelName(agg.modelMain || '');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const mShort = shortModelName(p.stat, pricing);
    const isMain = normalizeModelName(p.model) === mainKey;
    const entry = subs.get(normalizeModelName(p.model));
    // v3.38.0（C3④）：标注统一走 v2.98 文案「（子代理使用）」/「（专家团使用）」；查不到形态时保守按子代理。
    //   走 toastLineTagged（而非手拼 label）——它带"放不下就放弃标注"的超宽保护，绝不挤掉真实数据。
    const needTag = o.alwaysTag || (!isMain && entry);
    const tag = (entry) ? subagentTagOf(entry) : '（子代理使用）';
    // 余额 / 今日累计只在第一条显示：多条重复同一个累计值易被误读成"要累加"
    const todayI = i === 0 ? (o.firstToday != null ? o.firstToday : todayUsageTxt()) : todayUsageTxt();
    const balI = i === 0 ? (o.bal || '') : '';
    const periodI = periodNote(p.stat, pricing);
    if (needTag) {
      showToast(toastLineTagged(p.stat, pricing, tag), toastLine2(p.stat, pricing), o.reason || 'split-by-model', o.tsPath);
    } else {
      showToast(
        toastLine1(p.stat, shortModelName(p.stat, pricing), periodI, balI, todayI, noPriceTag1(p.stat, pricing)),
        toastLine2(p.stat, pricing), o.reason || 'split-by-model', o.tsPath,
      );
    }
  }
  return true;
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
        if (!/^agent-.*\.jsonl$/i.test(f)) continue;
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
  // v3.33.0（第四轮审计 S3 治本）：改走**块回溯**（eachTailLineReverse）——原 8KB 硬窗口在真实
  //   transcript（83.8MB/17,413 行，平均行 4.3KB、13% 的行 >8KB）下末行常落窗外 → 窗口内无换行符
  //   → split 只剩残片 → parse 恒失败 → 末行类型判定恒 null → watcher 退化成全量回退（最多 20 次全量读）。
  let parsed = null;
  eachTailLineReverse(tsPath, 512 * 1024, (ln) => {
    try { parsed = JSON.parse(ln.trim()); return true; }
    catch (e) { return false; } // 半写行：继续往前找
  });
  return parsed;
}
// v2.59/P0-1：读 transcript 文件【原始末行】（不做 JSON.parse），用于识别 compaction 重写中的
// transient unknown。compaction 是覆盖末行的截断重写，原始末行会持续抖动；真结束静默时末行不变。
function readTailRaw(tsPath) {
  // v3.33.0（第四轮审计 S3 治本）：改走块回溯——原 4KB 硬窗口是最严重的一处（真实数据里
  //   **30% 的行 >4KB**）→ 末行落窗外 → 恒返回 '' → 指纹恒定 → watcher 判定"文件无变化" →
  //   提前 idle-timeout 弹窗（数字偏小）。快路径仍是第一块（64KB），超长末行才继续回溯（≤256KB）。
  let out = '';
  eachTailLineReverse(tsPath, 256 * 1024, (ln) => { out = ln.trim(); return true; });
  return out;
}
// v2.62：读 transcript 文件【原始末 n 行】（不做 JSON.parse）。用于扫描末尾窗口内的压缩标记
// （append-only transcript 行数永不减少，旧 lineCount 检测方案失效）。n 行可能较长，故取末尾
// 64KB 足以覆盖；返回按文件顺序（旧→新）的最后 n 条非空行。
// v3.19.3：调用方仅剩 captureTranscShape（诊断快照）与 freshCompactionMarker（Stop 端单点豁免）。
// v3.18（M14）：诊断日志不再存对话内容原文——transcript 末行改存「sha1 前 10 位 + 长度」指纹。
// 同内容 → 同指纹，排查"末行是否变化"类问题仍然可用，但不再把助手回复片段明文落盘。
function fpOfStr(s) {
  if (!s) return '';
  let h = 'err';
  try { h = require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 10); } catch (e) { /* crypto 异常降级 */ }
  return h + ':' + String(s).length;
}
function tailFingerprint(tsPath) {
  return fpOfStr(readTailRaw(tsPath));
}
// v3.18（M1）：价格补录已查列表的键——路径型模型名（本地 .gguf 等）取末段，
// 避免把本机绝对路径（如 D:/LMStudioModels/...）写进 pricing.json 并随仓库分发。
function lookupKeyOf(modelName) {
  let s = String(modelName || '').toLowerCase();
  if (/[\\/]/.test(s)) s = s.split(/[\\/]/).pop() || s;
  return s;
}
// ── v3.33.0（第四轮审计 S3 **单点治本**）：从文件尾按块回溯、逐行倒序回调 ──────────────
// 病根：代码里三处各自硬编码"从文件尾读多少字节"（65536 / 8192 / 4096），谁也不知道对方存在。
//   真实 transcript 实测（83.8MB / 17,413 行）：**平均行长 4,331 B、最大 206 KB**；
//   行 >4K 占 **30%**、>8K 占 **13%**、>64K 有 10 行。后果有两层，都比"截断"更隐蔽：
//     ① 超长行落窗外 → 窗口内无换行符 → split 只剩残片 → parse 失败 → **整行被静默丢弃**；
//     ② 窗口按**字节**划，而调用方按**行数**要（如 roundLabel 要尾部 400 行）→ 64KB 只够约 15 行
//        → 请求 400 行实际拿到 15 行 → 年龄判定/标签全部失真。
// 本函数一次解决两层：块回溯（不限死字节）+ 按需提前终止（cb 返回 true 即停）+ 残行按 **Buffer**
//   拼接（不切断多字节字符）。cb(line, idxFromEnd) 从最后一行往前回调；最多回读 maxBytes。
// 【回溯不变式】（v3.33.0 第二轮修正——首版按 lastIndexOf 切分，把 body 的**首段残行**当完整行发出，
//   导致 >64KB 的行被截断成 64KB 残片；且 carry 与后读字节并不相邻，会伪拼接）：
//   读取方向为"从右往左"，故 **只有已读区最左侧那一行** 可能尚未闭合，其余行的左右边界均已确定。
//   因此每轮：merged = [本块] ++ [上一轮遗留的最左残行]（二者在原文件中严格相邻）；
//     取 **第一个** 换行符切分——其右侧全部是闭合行（可立即倒序回调），其左侧字节是新的最左残行；
//     若本块已抵达文件头（start === 0），该残行即为真行首，立即回调并清空。
//   最左残行按 Buffer 逐轮累积，故超长行（真实数据最大 206KB）跨块拼回后完整无截断、不切多字节字符。
function eachTailLineReverse(file, maxBytes, cb) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return false;
    const cap = Number(maxBytes) > 0 ? Number(maxBytes) : 4 * 1024 * 1024;
    const limit = Math.max(0, size - cap);
    const CHUNK = 64 * 1024;
    let pos = size;
    let frag = Buffer.alloc(0); // 已读区最左端的未闭合行（原始字节，右边界已知、左边界待拼）
    let idx = 0;
    const emitReverse = (text) => {
      const parts = text.split('\n');
      for (let i = parts.length - 1; i >= 0; i--) {
        const ln = parts[i];
        if (!ln.trim()) continue;
        if (cb(ln, idx++) === true) return true;
      }
      return false;
    };
    while (pos > limit) {
      const start = Math.max(limit, pos - CHUNK);
      const buf = Buffer.alloc(pos - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const merged = frag.length ? Buffer.concat([buf, frag]) : buf;
      const nl = merged.indexOf(0x0a); // 第一个换行符 → 其左为未闭合行，其右全部闭合
      const body = nl >= 0 ? merged.slice(nl + 1).toString('utf8') : '';
      const nextFrag = nl >= 0 ? merged.slice(0, nl) : merged;
      if (body && emitReverse(body) === true) return true;
      if (start === 0) { // 已抵文件头：最左残行就是真正的首行
        const head = nextFrag.toString('utf8');
        if (head.trim() && cb(head, idx++) === true) return true;
        frag = Buffer.alloc(0);
      } else {
        frag = nextFrag;
      }
      pos = start;
    }
    // 走到这里只可能是 maxBytes 用尽（未抵文件头）而仍剩一段最左残行：其左端被 cap 截断，
    //   但右边界完整。必须照发——tailFingerprint 依赖"尾部字节变化→指纹变化"，丢弃会退化成
    //   恒定空串（watcher 误判"文件未变化"→ 提前 idle 弹窗）。调用方按需自行容忍首条被截断。
    if (frag.length) {
      const head = frag.toString('utf8');
      if (head.trim() && cb(head, idx++) === true) return true;
    }
    return false;
  } catch (e) { return false; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 关闭失败不影响结果 */ } } }
}
function readTailRawLines(tsPath, n, maxBytes) {
  // v3.33.0（S3 治本）：原实现取末尾 64KB → 实测只够约 15 行（请求 400 行）→ roundLabel 年龄/
  //   标签判定大幅失真，且超长行整行消失。改为按块回溯直到收够 n 行（上限默认 4MB，防超大文件）。
  const want = Number(n) > 0 ? Number(n) : 400;
  const out = [];
  eachTailLineReverse(tsPath, Number(maxBytes) > 0 ? Number(maxBytes) : 4 * 1024 * 1024, (ln) => {
    const t = ln.trim();
    if (t) out.push(t);
    return out.length >= want;
  });
  return out.reverse(); // 与原语义一致：按文件顺序（旧→新）返回尾部 n 条非空行
}
// v2.62：判断一条原始 transcript 行是否为"压缩标记"——
// 一条 role=user 的消息，内容以 <conversation_history_summary>（新格式）或 <cb_summary>（旧格式外包一层）开头。
// 命中则返回该标记的稳定 id（uuid/timestamp 优先，缺失时退回内容前缀 hash），否则返回 null。
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
    } catch (e) {} // silent-ok:降级 — 会话 id 解析失败即回退 sidFromPath
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
// v3.13（2026-09-23）：本轮子代理文件是否**全部已终止**（末行是 assistant 且非 incomplete）。
//   用途：Stop 时若子代理"刚写过"（mtime 落在 20s 活跃窗内），但文件其实已写完（末行终止态），
//   说明只差毫秒级写入时差（实测 01:45：文件 01:45:05.904 写完，Stop 在 01:45:05.2，差 0.7 秒）
//   → 可走单条完整弹窗（含子代理 token），避免白拆两条。
//   ⚠️ 严格要求"非 incomplete"：被取消/中断的子代理末行是 incomplete → **不放行**（宁拆不错，保证不漏 token）。
//   ⚠️ 仅用于"微重判"配合：调用方还会复查 `subagentPending()`，双重确认后才走单条。
function allInRoundSubFilesTerminal(tsPath, roundStartMs) {
  try {
    const dir = subagentsDirFromTranscript(tsPath);
    const files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/i.test(f));
    let any = false;
    for (const f of files) {
      const p = path.join(dir, f);
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch (e) { continue; }
      if (mt <= roundStartMs) continue; // 非本轮的子代理文件 → 不参与判定
      any = true;
      const last = lastTranscLine(p);
      if (!(last && last.type === 'message' && last.role === 'assistant' && last.status !== 'incomplete')) return false;
    }
    return any; // 本轮没有子代理文件 → 不算"已终止"，交给原有 mtime 判据
  } catch (e) { return false; }
}

// v3.38.0（2026-10-08）：本轮子代理是否**全部已落定** —— 比 allInRoundSubFilesTerminal 宽松一级。
//   ① 末行终止态（message/assistant 且非 incomplete）→ 已跑完，落定；
//   ② 末行 incomplete 但**已停写 ≥ staleMs** → 属被取消/中断，永远不会再写，视为落定；
//   ③ 其它（末行非 assistant / 仍在写）→ 未落定。
// 为什么要加 ②：v3.09.1 当年否决"文件终态"判据，理由是真实会话 21 个子代理里 3 个末行永远是
//   incomplete（≈14%），只判①会让快速路径永不触发。②正是堵这个洞——**incomplete 不等于还在跑**，
//   只要已经停写够久就是死了。
// 实测（本机 27 会话 / 210 子代理文件）：只判①会话级放行率 **48.1%**；加②后 **81.5%（22/27）**，
//   未放行的 5 个（01593e8c / 652f2909 / 9609fc9f / 689004dc / 64565a2f）**全是手动取消/中断会话**，
//   正该交给兜底。另实测：终止态文件 99% 早停 ≥20s（中位 4789s），incomplete 85% 早停 ≥20s。
// 与 subagentsAllStagnant 的区别：那个是"全部停写超时"（不看末行），本函数看末行状态 + 停写，更准。
function subagentsAllSettled(tsPath, roundStartMs, staleMs) {
  try {
    const dir = subagentsDirFromTranscript(tsPath);
    const files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/i.test(f));
    let any = false;
    const now = Date.now();
    const stale = Number(staleMs) || SUBAGENT_IDLE_MS;
    for (const f of files) {
      const p = path.join(dir, f);
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch (e) { continue; }
      if (mt <= roundStartMs) continue; // 非本轮的子代理文件 → 不参与判定
      any = true;
      const last = lastTranscLine(p);
      const isMsg = !!(last && last.type === 'message' && last.role === 'assistant');
      if (isMsg && last.status !== 'incomplete') continue;           // ① 终止态 → 落定
      if (isMsg && (now - mt) >= stale) continue;                    // ② incomplete 且已停写 → 落定
      return false;                                                  // ③ 未落定
    }
    return any; // 本轮没有子代理文件 → 不算"已落定"，交给原有 mtime 判据
  } catch (e) { return false; }
}

// 同步等待（不 spawn 子进程）：用 Atomics.wait 睡 ms 毫秒
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (e) { /* 环境不支持则忽略（退化为不等待） */ }
}

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
    cleanupCoalesceLocks(sid); // v3.23.5：同批清理被收割 watcher 留下的死锁
  } catch (e) {
    // 快照写失败不阻断主输出，但按 C2 要求必须在 stderr 暴露，不静默
    process.stderr.write(`[token-tracker] 快照写入失败: ${e.message}\n`);
  }
}

// v2.36：清理历史会话快照（.snapshot-*.json）。保留规则：最近 30 天 + 最多 50 个 + 当前 sid 永不清。
// v3.23.5：coalesce 残留锁清理（KI-3 副产物）。
// watcher 被宿主 job object 收割时来不及释放锁 → 每个被收割的 watcher 在技能目录留一个
// `.coalesce-<sid>.json.lock`。实测本机 9/05~10/01 累积 4 个、owner 进程全部已死。
// 这些死锁不会造成漏弹（withFileLock 有 pid 存活探测 + TTL），但它们是**唯一没有 prune 的
// 运行时产物**（快照 50 个/30 天、明细 6 个月、账本备份 3 份都有上限）。规则照抄快照清理。
function cleanupCoalesceLocks(curSid) {
  try {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 3600 * 1000; // 锁的生命周期以分钟计，7 天已远远过期
    const files = fs.readdirSync(SNAP_DIR)
      .filter((f) => /^\.coalesce-.*\.lock$/.test(f))
      .map((f) => {
        const full = path.join(SNAP_DIR, f);
        try { return { name: f, full, mtime: fs.statSync(full).mtimeMs }; }
        catch (e) { return null; }
      })
      .filter(Boolean);
    if (files.length === 0) return;
    files.sort((a, b) => b.mtime - a.mtime);
    // 当前会话的锁正在使用中，永不清理
    const keepName = curSid ? `.coalesce-${String(curSid).replace(/[^a-zA-Z0-9_-]/g, '')}.json.lock` : '';
    let deleted = 0;
    for (let i = 30; i < files.length; i++) { // 数量上限 30 个
      if (files[i].name === keepName) continue;
      try { fs.unlinkSync(files[i].full); deleted++; } catch (e) { /* 忽略 */ }
    }
    for (const f of files) { // 时间上限 7 天
      if (f.mtime >= cutoff) continue;
      if (f.name === keepName) continue;
      try { fs.unlinkSync(f.full); deleted++; } catch (e) { /* 忽略 */ }
    }
    if (deleted > 0) {
      process.stderr.write(`[token-tracker] 已清理 ${deleted} 个残留 coalesce 锁（watcher 被收割留下的死锁）\n`);
    }
  } catch (e) { /* 清理失败不影响主流程 */ }
}

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
    catch (e) { if (attempt === 0) { try { syncSleepMs(60); } catch (e2) {} } } // v3.18：原 ping.exe 模拟，改 Atomics.wait
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
  // v3.19.2（B4）：不再合并 index.json 的顶层 peak_rules。
  //   该字段是 TokenHub 原文的**自由文本**（如「自2026-08-29起：工作日执行峰谷…」），
  //   不是机器可读的分厂商时段表；calcCost / isPeakHour / isPeakAt 全程只认
  //   pricing.deepseek_rules —— 合并进内存却从不读取，属"数据链路通了一半"的静默缺口：
  //   看着像支持各厂商峰谷，实则非 DeepSeek 厂商一律按 1× 计价。
  //   接上不可行（自由文本无从解析）→ 按"别悬着"原则删掉这半截（build_index.py 同步停止生成）。
  pricing.local_db = { built_at: db.built_at || null, models: mergedCount };
  return pricing;
}

// 写盘前剥离本地官方库合并条目 + 峰谷规则（它们由 index.json 每日重建，不入 pricing.json，
// 避免与聚合源复检互相覆盖/膨胀）
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
  // v3.19.2（B4）：防御性保留——现版本已不再读取 peak_rules，但磁盘上可能仍是旧版 index.json
  //   合并过、或由其它写入方带进来的字段，一并剥离，避免污染 pricing.json。
  delete out.peak_rules;
  delete out._lookedup_models; // v3.18.1（N6）：已查列表已迁至 .lookedup-models.json，防御性剥离旧字段
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
    } catch (e) {} // silent-ok:探测 — 枚举 venv 目录，读不到即跳过该级
    // 托管理论裸解释器兜底（通常无第三方依赖，排 venv 之后）
    const base = path.join(pyRoot, 'versions');
    const vers = fs.readdirSync(base).filter((d) => /^3\d*\.\d+/.test(d)).sort().reverse();
    for (const v of vers) cands.push(path.join(base, v, 'python.exe'));
  } catch (e) {} // silent-ok:降级 — Python 探测失败即回退裸 python
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
      // v3.19.0（P9）：改数组形式 spawn（exe 直传 + 脚本名作独立参数），去掉 shell: true 的字符串拼接——
      // 旧实现只对空格加引号，路径含 & / | 等 cmd 元字符时可被解释执行（纵深防御缺口）。
      const scripts = ['fetch-cn-prices.py', 'parse_tokenhub.py', 'build_index.py'];
      const runAll = (idx) => new Promise((resolve) => {
        if (idx >= scripts.length) return resolve({ code: 0, timedOut: false });
        let c;
        try {
          c = require('child_process').spawn(exe, [scripts[idx]], {
            cwd: CN_PRICE_PIPELINE_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (e) { return resolve({ code: -1, timedOut: false, err: 'spawn 失败: ' + String(e.message).slice(0, 200) }); }
        let timedOut = false;
        const killTimer = setTimeout(() => {
          timedOut = true;
          try { c.kill('SIGKILL'); } catch (e) {} // silent-ok:清理 — 超时杀子进程；已退出/已被杀都会抛，属预期
        }, REFRESH_TIMEOUT_MS);
        try {
          c.stdout && c.stdout.on('data', (b) => { if (out.length < 4000) out += String(b); });
          c.stderr && c.stderr.on('data', (b) => { if (out.length < 4000) out += String(b); });
        } catch (e) {} // silent-ok:诊断 — 采集子进程输出失败即放弃这段 tail，不影响判定
        c.on('exit', (code) => {
          clearTimeout(killTimer);
          if (code === 0 && !timedOut) return resolve(runAll(idx + 1));
          resolve({ code, timedOut });
        });
        c.on('error', (e) => {
          clearTimeout(killTimer);
          resolve({ code: -1, timedOut: false, err: 'error: ' + String(e.message).slice(0, 200) });
        });
      });
      let out = '';
      const REFRESH_TIMEOUT_MS = 180000; // 实测约 12s，给足 3 分钟（单脚本上限）
      runAll(0).then((r) => {
        if (r.code === 0) {
          try { fs.unlinkSync(CN_PRICE_REFRESH_LOCK); } catch (e) {} // silent-ok:清理 — 清残留锁文件
          try { fs.unlinkSync(CN_PRICE_REFRESH_ERR); } catch (e) {} // silent-ok:清理 — 清残留错误文件
          return;
        }
        const why = r.err ? r.err : ((r.timedOut ? `超时 ${REFRESH_TIMEOUT_MS}ms 被杀` : `exit=${r.code}`) + ' | ' + tail(out, 400));
        noteRefreshFailure(attempts + 1, why);
      }).catch((e) => noteRefreshFailure(attempts + 1, '异常: ' + String(e.message).slice(0, 200)));
    });
  } catch (e) { /* 静默：刷新失败沿用旧库，弹窗会有 ⚠价库 标注 */ }
}

// v2.82：把失败原因落到磁盘（prices/.refresh.error），让 ⚠价库M/D 提示可被追溯，不再盲猜。
function noteRefreshFailure(attempts, reason) {
  try {
    fs.writeFileSync(CN_PRICE_REFRESH_ERR, JSON.stringify({
      at: Date.now(), atLocal: new Date().toLocaleString('zh-CN'), attempts, day: todayStr(), reason,
    }, null, 2));
  } catch (e) {} // silent-ok:降级 — 刷新失败沿用旧库，弹窗有 ⚠价库 标注
}
function tail(s, n) { return String(s || '').replace(/\s+/g, ' ').slice(-n); }

// v3.18.3（F1）：损坏备份的容错抢救解析——v3.18.2 的"并回"分支用 JSON.parse 解析备份，
// 但进入该分支的前提恰是同一份字节 JSON.parse 失败（逻辑互斥，分支不可达）。这里改为
// 花括号逐条提取：先试整体 parse（覆盖"合法 JSON 但形状不对"），失败则定位 "models" 后
// 逐条匹配完整条目（截断尾部自动丢弃、单条坏跳过），把能抢救的模型条目捞回来。
function salvageModelsFromText(text) {
  try {
    const o = JSON.parse(text);
    return (o && typeof o === 'object' && o.models && typeof o.models === 'object') ? o.models : null;
  } catch (e) { /* 整体解析失败 → 走逐条抢救 */ }
  const m = String(text || '').match(/"models"\s*:\s*\{/);
  if (!m) return null;
  const t = text;
  let i = m.index + m[0].length - 1; // 指向 models 的 '{'
  i++;
  const models = {};
  let count = 0;
  while (i < t.length) {
    while (i < t.length && /[\s,]/.test(t[i])) i++;
    if (i >= t.length || t[i] === '}') break;
    const km = t.slice(i).match(/^"((?:[^"\\]|\\.)*)"\s*:\s*\{/);
    if (!km) break;
    let j = i + km[0].length; // 条目 '{' 之后
    let depth = 1, inStr = false, esc = false;
    while (j < t.length && depth > 0) {
      const ch = t[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') depth--; }
      j++;
    }
    if (depth !== 0) break; // 文件在此截断，后面全是残片
    try { models[km[1]] = JSON.parse(t.slice(i + km[0].length - 1, j)); count++; } catch (e) { /* 单条坏，跳过 */ }
    i = j;
  }
  return count ? models : null;
}

function loadPricing() {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { return null; }
  try { p = mergeLocalPriceDb(p); } catch (e) {} // silent-ok:降级 — 本地价库合并失败即用原价库
  try { if (ENABLE_NETWORK) maybeRefreshLocalDb(); } catch (e) {} // silent-ok:降级 — 本地价库刷新失败即沿用旧库
  // v3.32.0（方案 H3）：假日数据自适应自动刷新，与 maybeRefreshLocalDb 并列挂每日链路。
  //   开关/四条件/同日节流都在函数内自带（进程内每实例只判一次，热路径零 IO 增量）。
  try { maybeRefreshHolidays(); } catch (e) {} // silent-ok:降级 — 假日刷新失败即沿用旧表
  return p;
}

// v3.32.0（方案 H3，审计 P1-4）：假日数据此前**零调用方**（README 自认"不会被自动调用"）——
//   数据永不更新，2027 拿不到就永远空着；靠人记得手动跑 = 等于没有。现挂进每日刷新链路：
//   每进程最多判定一次（loadPricing 高频调用，gHolidayRefreshKicked 闸门保证零 IO 增量）；
//   命中 holidayRefreshNeeded 四条件之一才 spawn **detach** 子进程联网刷新（照 --round-watch 写法，
//   同步会卡 hook 提问路径）；同日只试一次（lastAttemptDay 节流，stale 重试的天粒度）。
//   子进程成败主流程不感知也不等——数据由 refresh-holidays.js 原子落盘 + 写回 lastSuccessAt；
//   失败仅其内部退出码，可观测走 `node refresh-holidays.js --check`（只读体检）。
let gHolidayRefreshKicked = false;
function maybeRefreshHolidays() {
  if (gHolidayRefreshKicked) return;
  gHolidayRefreshKicked = true;
  if (!(ENABLE_NETWORK && ENABLE_HOLIDAY_REFRESH)) return;
  const statePath = path.join(SNAP_DIR, '.holidays-refresh.json');
  const dataPath = path.join(SNAP_DIR, 'holidays.json');
  let h = {}, state = {};
  try { h = JSON.parse(fs.readFileSync(dataPath, 'utf-8')); } catch (e) { h = {}; }
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch (e) { state = {}; }
  const nowMs = Date.now();
  const need = holidayModule.holidayRefreshNeeded(h, state, nowMs);
  if (!need) return; // 四条件全不命中 → 完全不联网、零成本、零噪音
  const day = todayStr();
  if (state && state.lastAttemptDay === day) return; // 同日已试过（成败都算），明天再说
  try {
    fs.writeFileSync(statePath, JSON.stringify(Object.assign({}, state, {
      lastAttemptDay: day, lastAttemptAt: nowMs, lastReason: need,
    })));
  } catch (e) { /* 状态写失败则本轮照试，最坏同日多试一次 */ }
  try {
    const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'refresh-holidays.js')], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, { WB_ROOT: WB }), // 与读取方同一 WB_ROOT 解析（P1-16 口径）
    });
    child.on('error', (e) => {
      process.stderr.write(`[token-tracker] 假日数据刷新启动失败(异步): ${(e && e.message) || e}\n`);
    });
    child.unref();
  } catch (e) {
    process.stderr.write(`[token-tracker] 假日数据刷新 spawn 失败: ${(e && e.message) || e}\n`);
  }
}

// v3.18.1（N6）：模型"已查未收录"列表——本地 sidecar 文件（.lookedup-models.json，.gitignore 排除），
// 不再写进 pricing.json（旧实现把本机自定义模型名随公开仓库分发）。上限 200 条防无界增长。
const LOOKEDUP_FILE = path.join(path.dirname(PRICING), '.lookedup-models.json');
let _lookedupCache = null;
function loadLookedup() {
  if (_lookedupCache) return _lookedupCache;
  try {
    const a = JSON.parse(fs.readFileSync(LOOKEDUP_FILE, 'utf-8'));
    _lookedupCache = Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(-200) : [];
  } catch (e) { _lookedupCache = []; }
  return _lookedupCache;
}
function rememberLookedup(name) {
  const a = loadLookedup();
  if (a.indexOf(name) < 0) {
    a.push(name);
    if (a.length > 200) a.splice(0, a.length - 200);
    try { fs.writeFileSync(LOOKEDUP_FILE, JSON.stringify(a)); } catch (e) { /* 写失败仅影响下次去重，不致命 */ }
  }
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
// v3.18.2（R4）→ v3.18.3（F1 做实）→ v3.18.4（G1/G3 修接线）：重建规模护栏（可导出，供 selftest 直接单测）。
// 关键口径（G1 教训）：rebuilt 是 loadPricing() 的结果，**内部已合并本地官方价库**（可达数十条），
// 绝不能拿 rebuilt.models 与"原始文件抢救出的条目"比大小——必须用**重建文件本身**的 models。
// 流程：① 容错抢救备份（salvageModelsFromText）；② 抢救出条目 → 按"缺失键"并回（只看 miss.length，
// 不再加v3.18.3 那个有害的 nOld > nNew）；③ 未触发并回 → 仍要评估体积告警（解耦，不再整支跳过）；
// ④ _shrink_note 必须在写盘**之前**赋值（G3），否则 ⚠价库缩水 标记不会落盘，进程退出即丢。
function guardRebuildScale(rebuilt, bak) {
  if (!rebuilt || !bak || !fs.existsSync(bak)) return;
  try {
    const szNew = fs.statSync(PRICING).size, szBak = fs.statSync(bak).size;
    const oldModels = salvageModelsFromText(fs.readFileSync(bak, 'utf-8'));
    let rawModels = {};
    try { const raw = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); rawModels = (raw && raw.models) || {}; } catch (e) { /* 读不出按空算 */ }
    const nFile = Object.keys(rawModels).length;
    let merged = false;
    if (oldModels) {
      const nOld = Object.keys(oldModels).length;
      const miss = Object.keys(oldModels).filter((k) => !(k in rawModels));
      if (miss.length > 0) {
        merged = true;
        for (const k of miss) rebuilt.models[k] = oldModels[k];
        rebuilt._shrink_note = `重建缩水（备份 ${nOld} 模型 → 重建文件 ${nFile}），已并回 ${miss.length} 条；建议跑 refresh-prices.js --force 补全`;
        try { fs.writeFileSync(PRICING, JSON.stringify(stripLocalDbEntries(rebuilt), null, 2) + '\n'); } catch (e) { /* 写失败只影响本轮 */ }
        process.stderr.write(`[token-tracker] ⚠价库 重建规模异常（备份 ${nOld} 模型 → 重建文件 ${nFile}），已并回备份条目（+${miss.length}）；建议手动跑 refresh-prices.js --force 用最新数据补全\n`);
      }
    }
    if (!merged && szBak > szNew * 3) {
      rebuilt._shrink_note = `重建缩水（备份 ${szBak}B → 重建 ${szNew}B），无法抢救，费用大面积未收录`;
      try { fs.writeFileSync(PRICING, JSON.stringify(stripLocalDbEntries(rebuilt), null, 2) + '\n'); } catch (e) { /* 同上 */ }
      process.stderr.write(`[token-tracker] ⚠价库 重建结果 ${szNew}B 明显小于损坏备份 ${szBak}B，可能仅部分源重建成功（大量模型将显示「费用未收录」）；建议手动跑 refresh-prices.js --force 补全（备份 ${path.basename(bak)} 保留）\n`);
    }
  } catch (e) { /* 护栏自身异常不影响主流程 */ }
}

function autoRefreshPricing(pricing) {
  if (!pricing || typeof pricing !== 'object') {
    // v3.18.1（N3）：区分「文件缺失」与「文件损坏」。损坏时先改名备份为 .corrupt-<ts> 再重建（自愈，
    // 与账本的 .corrupt 处理一致）；重建失败时提示可用备份人工恢复，不再用误导性的「沿用本地价」文案。
    const missing = !fs.existsSync(PRICING);
    if (!(ENABLE_NETWORK && ENABLE_PRICE_REFRESH)) {
      process.stderr.write(`[token-tracker] pricing.json ${missing ? '缺失' : '损坏'}且联网开关关闭，无法重建（所有模型费用将无法计算）；请手动修复文件或开启联网刷新\n`);
      return null;
    }
    let bak = null;
    if (!missing) {
      try {
        bak = `${PRICING}.corrupt-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 17)}`;
        fs.renameSync(PRICING, bak);
        process.stderr.write(`[token-tracker] pricing.json 损坏，已备份为 ${path.basename(bak)}，尝试重建\n`);
      } catch (e) {
        process.stderr.write(`[token-tracker] pricing.json 损坏且备份失败，拒绝覆盖（所有模型费用将无法计算）: ${String(e.message).slice(0, 120)}\n`);
        return null;
      }
    }
    const script = path.join(path.dirname(PRICING), 'refresh-prices.js');
    if (!fs.existsSync(script)) {
      process.stderr.write(`[token-tracker] refresh-prices.js 不存在，pricing 重建失败（所有模型费用将无法计算）\n`);
      return null;
    }
    try {
      require('child_process').execFileSync(process.execPath, [script], {
        timeout: 60000, stdio: 'pipe', windowsHide: true, env: Object.assign({}, process.env, { WB_ROOT: WB }),
      });
    } catch (e) {
      process.stderr.write(`[token-tracker] pricing 重建失败（所有模型费用将无法计算；可把 .corrupt 备份改名回 pricing.json 人工恢复）: ${String(e.message).slice(0, 200)}\n`);
      return null;
    }
    const rebuilt = loadPricing();
    guardRebuildScale(rebuilt, bak);
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
    // v3.23.5：**内外层 timeout 打架修复** —— refresh-prices.js 内部 spawnSync(deepseek-official.js)
    // 的 timeout 是 120s（含 2 次重试 × 60s 间隔），而这里外层 execFileSync 只有 60s
    // → 外层先到点把整个刷新杀掉，内层重试机制**从未真正生效过**（DeepSeek 官方价只有首轮成功才拿得到）。
    // 且这里是同步阻塞（挂在 --hook 用户提问路径），让它干等 60s 重试 = 用户提问卡一分钟。
    // 处置：自动路径显式 DS_RETRIES=0 → 内层只跑一次（单次 TIMEOUT_MS=15s，总耗时 ≪ 60s），
    // 失败即沿用旧价、次日再试；手动 `node refresh-prices.js` 不受影响，仍保留重试（后台场景不在乎时长）。
    require('child_process').execFileSync(process.execPath, [script], {
      timeout: 60000, stdio: 'pipe', windowsHide: true,
      env: Object.assign({}, process.env, { WB_ROOT: WB, DS_RETRIES: '0' }),
    });
    return loadPricing(); // 刷新成功 → 重新读取（含新 date）
  } catch (e) {
    // 刷新失败：保留旧价，date 不变（次日重试）；失败原因已在 refresh-prices.js 的 stderr 输出
    process.stderr.write(`[token-tracker] 价格自动刷新失败（沿用本地价）: ${String(e.message).slice(0, 200)}\n`);
    return pricing;
  }
}

// 模型匹配（v2.71 起双模式；v2.67 曾严格化为"只认归一化完全相等"）。
// v3.29.0（D-1 文档核实，仅更正注释）：**当前全仓 4 个调用点全部传 mode='price'**
//   （calcCost:2802、显示用名 shortModelName:3602、时段标注 periodNote:3702、新模型补录判定 ensureNewModelPricing:4239），
//   **不存在走默认模式的调用点**。故「默认（精确）」分支目前无实际使用者，仅作为精确匹配的前置阶段被
//   mode='price' 复用（步骤 1/1.5/2 对两种模式都执行，只有步骤 3 宽松边界匹配受 mode 控制）。
//   ——此前注释写「默认（精确）…统计分桶/别名判定用」与实现不符（统计分桶实际用的是原始名，不经 findModel）。
// 两种模式的差异只在步骤 3：
// - mode='price'（计费模式）：步骤 3 做「边界分隔 + 单向」宽松匹配——只允许具体模型名命中
//   家族/前缀 key（norm 较长、key 是它的边界子串），命中多个取 key 最长者。用于计费/显示/时段标注/补录判定——
//   让 hy3-x 按 hy3 计价、deepseek-ai/DeepSeek-V4-Flash 按 deepseek-v4-flash 计价。
// - 其它（默认/精确）：跳过步骤 3，只保留步骤 1（归一化完全相等）+1.5（去标点）+2（别名表），
//   失败即返回 null（当前无调用点，保留为 API 语义与防御）。
// 依据（v2.67 源数据核查仍有效）：日期后缀模型的价格并不可靠相同——deepseek-r1 vs r1-0528、
// deepseek-chat-v3-0324 vs chat-v3.1、deepseek-v4-pro vs v4-pro-0813 价格均不同；
// 因此【精确路径】不做后缀归并（宁可不计价也不算错价）；【计费路径】仅做边界子串匹配
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
    // v3.31.0（缺陷C）：双向子串**保留**——两侧各有真实场景（models.json 登记全名
    //   `lmstudio-community/qwen3.5-9b` ↔ 实际调用名 `qwen3.5-9b`，正反方向都可能需要）。
    //   真正的病灶是**短名**：lm 很短（如 `qwen`/`glm`）时，任何含这个短串的**云端**模型
    //   （`qwen-max` / `glm-5.3-flash`）都会被判成本地免费 → calcCost 返回 null → 三个出口全
    //   ¥0.00 且连 unpriced 标记都不打（isLocalModel 先拦截）→ 云端模型被静默当成免费。
    //   修法：**精确匹配永远放行；双向子串要求 lm ≥5 字符**。取 5 的理由：最常见的危险短名
    //   （`qwen`/`glm`/`gpt`）都 ≤4 被挡住；真实本地登记名（LM Studio 场景）几乎都 ≥5
    //   （`glm-4`/`qwen3.5`），不会被误挡。本机 models.json 无本地模型 → 改动零行为变化。
    if (n === lm) return true;
    if (lm.length >= 5 && (n.includes(lm) || lm.includes(n))) return true;
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

// 峰谷时段判定（北京时间）。口径单一实现见 peak-rules.js（v3.19.0 P1）：
//   peak_schedule / weekend_off_peak 读自 pricing.deepseek_rules（refresh 每日解析官方页写入），
//   叠加 holidays.json 法定假日全天低峰（官方口径「峰时段不含法定假日」）。
//   官方改时段 / 取消周末低峰时本地自动跟随；无 rules（抓取失败/旧数据）→ peak-rules.js 内部回退内置默认
//   （9-12 / 14-18 + 周末低峰）。
// v3.19.2（B3）：删除本文件内 parsePeakSchedule / isChineseHolidayBeijing 两份「零调用死副本」。
//   它们与 peak-rules.js 重复，且 parsePeakSchedule 仍丢分钟（v3.19.1 已在模块修掉的 N4 旧 bug），
//   isChineseHolidayBeijing 又用本地时区 getFullYear()（与模块的 tsMs+8h 口径不一致）——只留在 exports 里
//   误导后人「照这里改」。现仅保留 HOLIDAYS_FILE 供 isPeakHour 使用；假日与时段判定全部走 peak-rules.js。
const HOLIDAYS_FILE = path.join(WB, 'skills', 'token-usage-tracker', 'holidays.json');

// v3.32.0（方案 H4）：峰谷真受影响时的**降级可见性**——有 DeepSeek 官方动态时段 + 该年假日数据未知/陈旧
//   → 峰谷判定是降级而非事实，必须让用户看见（此前 2027:[] 被当"全年无假日"，双向错且零告警）。
//   进程内每年至多 1 条 stderr（Set 去重；isPeakHour 是计费热路径，绝不能每笔都打）。
const _holidayWarnedYears = new Set();
function isPeakHour(rules, now) {
  const t = now || new Date();
  if (rules && typeof rules === 'object' && rules.peak_schedule && HOLIDAYS_FILE) {
    try {
      const yNow = new Date(t.getTime() + 8 * 3600e3).getUTCFullYear();
      if (!_holidayWarnedYears.has(yNow) && peakRules.holidayYearUnknown(t.getTime(), HOLIDAYS_FILE)) {
        _holidayWarnedYears.add(yNow);
        process.stderr.write(`[token-tracker] ⚠ ${yNow} 年法定假日数据未知或已陈旧 → 该年峰谷判定按「非假日」降级：真假日按高峰 ×2 多算、调休上班日按周末低峰少算；联网后跑 node refresh-holidays.js ${yNow} 可修复（默认自动链路也会探测）\n`);
      }
    } catch (e) { /* 告警失败绝不影响计费判定本身 */ }
  }
  // v3.19.0（P1）：判定逻辑抽到 peak-rules.js 单一实现——backfill/recalc-day 调用同一模块。
  // 旧实现是三份复制（靠注释约束同步），官方改时段时只同步了假日、没同步时段 → 同一批数据金额差一倍。
  return peakRules.isPeakAt(t.getTime(), { deepseek_rules: rules }, HOLIDAYS_FILE);
}

// cost = 未命中输入×输入价 + 命中输入×缓存价 + 输出×输出价（元），按当前时段取倍率
function calcCost(stat, pricing, tsMs) {
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
  // v3.19.2（B8）：峰谷必须按 **token 实际发生时刻** 判，而不是「脚本运行时刻」。
  //   原实现 isPeakHour() 内部取 new Date() → Stop/hook 若在跨时段边界（12:00 / 18:00）之后才跑，
  //   整轮会按**终点**那一档计价，而 backfill.js / recalc-day.js 是按每行 ts 逐条判定 →
  //   同一批数据两条路径金额不同（P1「口径分裂」的残留形态，只是触发条件收窄到跨边界轮）。
  //   时刻来源优先级：显式 tsMs（incrementalRecord 传入的本批新行最大 ts）
  //     > stat.lastTs（aggregateTranscLines 产出的本轮最后一个 usage 行 ts，epoch ms）
  //     > 不传（stat 无时间信息）→ 退回「当下时刻」，与旧行为一致。
  const effTs = (typeof tsMs === 'number' && tsMs > 0)
    ? tsMs
    : (Number(stat && stat.lastTs) > 0 ? Number(stat.lastTs) : 0);
  const mult = isPeakHour(pricing.deepseek_rules, effTs > 0 ? new Date(effTs) : undefined) ? peakMult : 1;
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
  if (cost == null || !Number.isFinite(cost)) return null; // v3.24.0：NaN 也返回 null（原只挡 null → NaN 会直出「¥NaN」上 toast）
  if (cost < 0) return null; // v3.24.0：负价不合常理（上游有非负钳制，这里是 toast 侧最后一道闸）
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
  // v3.24.0：钳制到 [0,100] —— 脏数据（cached>in，如平台重传）会显示 ">100%" 报表
  const v = Math.round((cachedTok / denom) * 10000) / 100;
  return Math.min(100, Math.max(0, v));
}
function dayTotalOf(models) {
  const t = { in: 0, out: 0, cached: 0, total: 0, cost: 0 };
  for (const m of Object.values(models || {})) {
    if (!m || typeof m !== 'object') continue; // v3.24.0（级联⑪）：账本一条 null 条目曾让 --report/区间/CSV/外推全线 TypeError
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
  let raw = '';
  try {
    raw = fs.readFileSync(DAILY_USAGE_FILE, 'utf-8');
    // v3.18（H6）：剥 UTF-8 BOM——PowerShell `Out-File -Encoding utf8` 等工具写出的文件带 BOM，
    // JSON.parse 直接失败 → 整个历史被判"损坏"且 --report 显示为空（v3.06 水位线同类事故，
    // 当时只修了水位线，账本路径漏了）。剥掉 BOM 后正常解析，数据无损。
    raw = raw.replace(/^\uFEFF/, '');
    const parsed = normalizeDailyUsage(JSON.parse(raw));
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
      //
      // v3.40.0（plan-B A21 修复）：**但上面这条"永不清除"在长驻进程里会变成永久失记**。
      //   病根：损坏文件被 rename 成本 .corrupt-<ts> 后，本进程内此后每次 loadDailyUsage 都走
      //   ENOENT 分支 → 标志永不清 → `recordUsage` 恒返回 false → **该进程之后所有用量再也不记**。
      //   触发面：watcher（`--flush-delayed`）与 Stop 兜底都是**同一进程多轮调用**的形态。
      //   处置与 v2.99 的关切相反但同为 fail-safe：**区分"本进程刚隔离过"与"文件本就不存在"**。
      //   · 本进程内隔离过（gLedgerQuarantined 为真）→ 现状：不清标志（防用空账本覆盖历史）；
      //   · 文件从未存在过、且本进程未隔离过 → 人工已把损坏文件修好/删掉、或首次运行 →
      //     清标志让记账恢复。**这是恢复路径，不是覆盖路径**：文件真的不存在时，
      //     recordUsage 用空账本起步只会丢掉"本来就已不在磁盘上的历史"（那部分在 .corrupt 备份里），
      //     不会覆盖任何现存数据 —— 而"永久失记"会持续丢掉**将来**的所有用量，危害更大。
      if (!gLedgerQuarantined) gDailyCorrupt = false;
      return {};
    }
    // v3.24.0（级联③）：**区分「文件真损坏」与「瞬时读失败」** —— 原先所有非 ENOENT 错误一律
    // 把账本改名 .corrupt-<ts>。EACCES / EBUSY / EIO 这类**文件本身完好**的瞬时占用（杀毒扫描、
    // 同步盘锁定）也会触发改名 → "一次瞬时文件占用 = 历史账本永久消失"。
    // v3.24.1（自审收紧）：只有 JSON 解析失败（SyntaxError，文件内容真坏）才隔离改名；
    // **其余一律不动原文件**——包括未知异常（无 code，如 TypeError）：文件可能是好的，
    // 按「读失败」处理才 fail-safe（原先 `!e.code` 被归入解析类 → 未知异常也会改名，与主张相悖）。
    // 读失败 → 原文件原位不动，gDailyCorrupt 照样置 true 阻止本轮用空账本写回（防覆盖不变），下次重试。
    const isParseError = e instanceof SyntaxError;
    if (!isParseError) {
      gDailyCorrupt = true;
      process.stderr.write(`[token-tracker] 账本读取失败（${e.code || e.message}）——文件未改动，本轮不写回，下次重试\n`);
      return {};
    }
    // 损坏文件：重命名为 .corrupt-<时间戳> 备份（保留历史数据），本轮禁止写回空对象以免覆盖。
    // v3.18（H6）：只备份一次——已存在 .corrupt-* 备份时不再生成新备份（源文件保持原位，
    // gDailyCorrupt 照样阻止写回），避免"每次运行都多一个备份"的无上限增长。
    try {
      if (fs.existsSync(DAILY_USAGE_FILE)) {
        let hasBackup = false;
        try {
          hasBackup = fs.readdirSync(path.dirname(DAILY_USAGE_FILE))
            .some((f) => f.startsWith(path.basename(DAILY_USAGE_FILE) + '.corrupt-'));
        } catch (e3) { /* 列目录失败按无备份处理 */ }
        if (!hasBackup) {
          const corruptPath = DAILY_USAGE_FILE + '.corrupt-' + Date.now();
          fs.renameSync(DAILY_USAGE_FILE, corruptPath);
          gLedgerQuarantined = true; // v3.40.0（A21）：记住"文件是我搬走的" → ENOENT 分支才敢不复位
          process.stderr.write(`[token-tracker] 账本损坏，已备份为 ${path.basename(corruptPath)}（本轮不写回覆盖）\n`);
        } else {
          process.stderr.write(`[token-tracker] 账本损坏（此前已备份过，不重复备份；本轮不写回覆盖）\n`);
        }
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
// ===== v3.20.0：轮次明细留档 =====
// 注入型 user 行的标签白名单（**单一定义**）。
//   v3.33.0（B 系列）：此前同一份正则被**抄成两遍**（roundLabel 一处、inferRoundStartFromText 一处），
//   新增一种注入形态就得改两处、漏一处立刻分叉——正是本文件"同一病根多处打补丁"的老毛病。
//   实测代价：本机 `rounds-2026-10.jsonl` 219 条里 **32 条**的 label 是 `<teammate-message teammate_id=…`
//   的开头 40 字符 —— 白名单漏了 `teammate-message`，于是"这轮到底在干什么"的标签变成一段 XML，
//   既不是用户的话，作为标签也完全没用。
//   **两个调用方的策略刻意不同，禁止"顺手统一"**：
//     · roundLabel —— 命中即改写成 `[注入] <tag>`，纯展示层改写，无副作用 → 用**宽表**（ALL）。
//     · inferRoundStartFromText —— 返回 0 的代价是 6041 的 `roundStart0 > 0` 不成立 → **整轮记账被跳过**
//       （就是 S1 那类静默丢账）。故它只能用**窄表**：只排除"确证不是用户提交、且排除后仍能扫到更早的
//       用户提交"的形态。teammate-message 恰好不能进窄表——团队模式下整段 transcript 的 user 行可能
//       全是队友消息，排除它 = 起点归 0 = 丢账；宁可取到一个偏晚的起点（少记，下次 Stop 会补），
//       也不能取 0（不记）。
const INJECTION_TAGS_ALL = ['task-notification', 'conversation_history_summary', 'cb_summary', 'system-reminder', 'user-context', 'teammate-message'];
const INJECTION_TAGS_NOT_SUBMIT = ['task-notification', 'conversation_history_summary', 'cb_summary', 'system-reminder', 'user-context'];
// 取行首的尖括号标签名，命中白名单则返回标签名，否则返回 ''
function injectionTagOf(txt, tags) {
  const m = /^<([a-zA-Z0-9_-]+)/.exec(String(txt || '').trim());
  return m && tags.indexOf(m[1]) >= 0 ? m[1] : '';
}
// 从原始 transcript 行里取纯文本（content 可能是字符串，也可能是 [{type:'text',text}] 数组）
function transcTextOfRow(obj) {
  try {
    const c = obj && obj.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (x && (x.text || x.content)) || '').join('');
    return '';
  } catch (e) { return ''; }
}
// 本轮标签：取 roundStart 之后第一条「非注入型」user 消息的前 ROUND_LABEL_MAX 字符。
// 为什么必须有它：没有标签的明细就只是一堆数字，回答不了「这一轮到底在干什么」。
// 只读尾部 400 行而非全文件——Stop 端本次已多次全量读 transcript（40MB 级），不再加一次。
function roundLabel(tsPath, roundStartMs) {
  try {
    if (!tsPath || !(roundStartMs > 0)) return '';
    for (const ln of readTailRawLines(tsPath, 400)) {
      let r;
      try { r = JSON.parse(ln); } catch (e) { continue; }
      if (!r || r.type !== 'message' || r.role !== 'user') continue;
      const ts = Number(r.timestamp) || 0;
      if (ts && ts < roundStartMs) continue; // 上一轮的 user 行
      const txt = transcTextOfRow(r).trim();
      if (!txt) continue;
      // 注入型 user 行（客户端 / 钩子 / 队友消息塞进来的）不是「用户说了什么」，不能当标签。
      // v3.33.0：改用统一白名单 INJECTION_TAGS_ALL 并补上 teammate-message（实测本机 32/219 条中招）。
      const inj = injectionTagOf(txt, INJECTION_TAGS_ALL);
      if (inj) return '[注入] ' + inj;
      // v3.33.0（B 系列·隐私声明）：这里是**本技能唯一一处会把用户自己敲的话落盘的地方**——
      //   用户消息的前 ROUND_LABEL_MAX(40) 字符，明文、只写本地、随 rounds-*.jsonl 保留 6 个月后清理。
      //   保留它的理由（权衡过）：没有标签的轮次明细就只是一堆数字，回答不了"这一轮到底在干什么"。
      //   已在 README「隐私与数据安全」逐条声明；**不要**因为"看起来像日志"就顺手删掉或加大截断长度。
      return txt.slice(0, ROUND_LABEL_MAX).replace(/\s+/g, ' ');
    }
    return '';
  } catch (e) { return ''; }
}
// v3.33.0（第四轮审计 S1 修复）：从 transcript **反推本轮起点**（= UserPromptSubmit hook 记录的
//   lastUserMsgAt 的等价物）。
//   病根：`lastUserMsgAt` 全仓只在 --hook 分支写入 → **只配 Stop、不配 UserPromptSubmit 的机器恒为 0**
//   → 5636 的 `roundStart0 > 0` 恒不成立 → 整段记账被跳过 → toast 照弹但 daily-usage.json 永不写、
//   --report 全家静默失效（用户以为在工作）。这是"机制上双重封死"的第一重。
//   语义对齐：取尾部**最后一条「非注入型」user 消息**的 timestamp —— 用户提交时刻，与 hook 同源。
//   只读尾部 400 行（同 roundLabel 口径；Stop 端本次已多次全量读 transcript，不再加一次）。
//   只在 lastUserMsgAt 为 0 时调用 → 正常配了 hook 的机器**零开销、零行为变化**（零噪音红线）。
function inferRoundStartFromText(tsPath) {
  let best = 0;
  // v3.33.0（S3 治本配套）：改用**块回溯**找最后一条「非注入型」user 行——它可能距文件尾很远
  //   （一轮内几十条工具调用，实测尾部 256KB 内 43 行全是工具/推理，**零 user 行**）。
  //   原 readTailRawLines(400) 在 64KB 窗口下只看得到约 15 行 → 恒返回 0 → 兜底失效。
  //   上限 16MB（Stop 端本就要全量读 transcript 聚合，成本可控），命中即停。
  eachTailLineReverse(tsPath, 16 * 1024 * 1024, (ln) => {
    let r;
    try { r = JSON.parse(ln); } catch (e) { return false; }
    if (!r || r.type !== 'message' || r.role !== 'user') return false;
    const ts = Number(r.timestamp) || 0;
    if (!ts) return false;
    const txt = transcTextOfRow(r).trim();
    if (!txt) return false;
    // 注入型 user 行（客户端 / 钩子塞进来的）不是"用户提交"，不当轮起点。
    // v3.33.0：改用统一白名单，但**刻意只用窄表 INJECTION_TAGS_NOT_SUBMIT**——
    //   见 INJECTION_TAGS_ALL 处注释：这里返回 0 会让整轮记账被跳过（静默丢账），
    //   而 teammate-message 在团队模式下可能是**唯一**的 user 行（排除它 → 起点归 0 → 丢账）。
    if (injectionTagOf(txt, INJECTION_TAGS_NOT_SUBMIT)) return false;
    best = ts;
    return true; // 倒序扫描：第一条命中的就是"最后一条 user 行"
  });
  return best;
}
// 落一条轮次明细。**调用点唯一**（recordUsage 内），且只在账本真正写盘成功后调用——
//   于是「同一轮无新增用量时不重复落档」由记账自身的幂等性白送，不需要额外维护去重状态
//   （同轮二次 Stop 时 byModel 为空 → recordUsage 提前 return false → 到这里之前就结束了）。
// 任何异常都不得影响记账（调用方另有 try/catch，这里再兜一层）。
function appendRoundDetail(byModel, stat, pricing, tsMs, meta) {
  if (!meta || typeof meta !== 'object') return;
  const models = {};
  if (byModel && Object.keys(byModel).length) {
    for (const [n, b] of Object.entries(byModel)) {
      models[n] = { in: b.in || 0, out: b.out || 0, cached: b.cached || 0, total: b.total || 0 };
    }
  } else if (stat && ((stat.in || 0) + (stat.out || 0)) > 0) {
    models[stat.model || 'unknown'] = { in: stat.in || 0, out: stat.out || 0, cached: stat.cached || 0, total: stat.total || 0 };
  } else return;
  let inT = 0, outT = 0, cachedT = 0, totalT = 0, costT = 0;
  for (const [n, b] of Object.entries(models)) {
    inT += b.in; outT += b.out; cachedT += b.cached; totalT += b.total;
    const c = calcCost(Object.assign({ model: n }, b), pricing, tsMs);
    if (c != null) costT += c;
  }
  const rec = {
    ts: Date.now(),
    date: todayStr(),
    sid: String(meta.sid || ''),
    roundStart: Number(meta.roundStart) || 0,
    durMs: Number(meta.durMs) || 0,
    in: inT, out: outT, cached: cachedT, total: totalT,
    hitPct: hitRate(inT, cachedT),
    models,
    model: String(meta.model || ''),
    subModels: Array.isArray(meta.subModels) ? meta.subModels : [],
    subCount: Number(meta.subCount) || 0,
    teamActive: meta.teamActive === true,
    source: String(meta.source || ''),
    label: String(meta.label || ''),
    // 字段名刻意带 ApiEquiv：这是按 API 单价折算的等价金额，**不是真实扣费**，
    // 与 WorkBuddy 客户端自带积分/额度之间不存在换算关系（改名前先想清楚这一点）。
    costApiEquiv: Math.round(costT * 10000) / 10000,
  };
  fs.mkdirSync(ROUNDS_DIR, { recursive: true });
  fs.appendFileSync(path.join(ROUNDS_DIR, 'rounds-' + todayStr().slice(0, 7) + '.jsonl'),
    JSON.stringify(rec) + '\n', 'utf-8');
}

// 把一条 stat（单模型）累加进某天的 models，并重算该日 total（保证总合计永远=各模型之和）
// tsMs（v3.19.2/B8）：本批 token 的发生时刻，透传给 calcCost 做峰谷判定；缺省回退 stat.lastTs / 当下
function addModelUsage(day, model, stat, pricing, tsMs) {
  const name = String(model || '').trim() || 'unknown';
  const cost = calcCost(Object.assign({ model: name }, stat), pricing, tsMs);
  const m = day.models[name] || (day.models[name] = { in: 0, out: 0, cached: 0, total: 0, cost: 0 });
  m.in += stat.in || 0; m.out += stat.out || 0; m.cached += stat.cached || 0; m.total += stat.total || 0;
  m.hit = hitRate(m.in, m.cached);
  if (cost != null) m.cost += cost;
  // v3.27.0：无公开价模型（pricing_status:'unpublished'）在账本条目上留痕 no_price=true。
  //   cost 仍保持 0（token 数照常记、金额待官方公布后由 recalc-day.js 回填），
  //   但 no_price 让展示层能把「厂商没公布价」与「真的免费（cost 0）」区分开——
  //   否则 --report 里显示 ¥0.00，用户无从知道当日合计因它而偏低。
  if (pricing && pricing.models && pricing.models[name]
      && pricing.models[name].pricing_status === 'unpublished') {
    m.no_price = true;
    m.no_price_note = '厂商未公布按 token 单价（匿名/订阅制模型）'; // 供 --report 表格与后续排查
  } else if (m.no_price) {
    // 价库已补上真实单价 → 清标记，下轮起金额正常计入（recalc 回填后由 recalc-day 清，见 recalc 侧）
    delete m.no_price; delete m.no_price_note;
  }
  // v3.31.0（P1-7）：**缓存价未知**是与「无公开价」不同的另一种低估——模型有真实单价、金额也算得出来，
  //   只是厂商没公布缓存命中价 → calcCost(:2854) 对 cached_price=null 取 0 → 缓存 token 被"免单"。
  //   本机缓存命中 ~97%（金额 ≈ 缓存价×缓存量），这一项缺失实测让总额偏差 45%~86%。
  //   处理口径与 no_price 完全一致：**不改写金额**（不凭空造缓存价），只在账本条目上留痕，
  //   让 --report / --report <区间> / CSV / toast 能把"合计偏低"讲到用户眼前。
  if (pricing && pricing.models && pricing.models[name]
      && pricing.models[name].cached_price_unknown === true) {
    m.cached_price_unknown = true;
    m.cached_price_unknown_note = '厂商未公布缓存命中价，缓存 token 按 0 元计 → 金额偏低';
  } else if (m.cached_price_unknown) {
    // 人工补上 cached_price 后自动失效（recalc-day.js 回算同理）
    delete m.cached_price_unknown; delete m.cached_price_unknown_note;
  }
  // v3.31.0（缺陷B）：**未收录**模型（pricing.json 里压根没有这个模型 → calcCost 返回 null）单独留痕 unpriced。
  //   与 no_price（厂商未公布单价）**刻意分成两个标记**——成因不同、用户处置也不同：
  //     no_price = 厂商没公布单价，等公布后跑 recalc；unpriced = 我们自己没收录，得先补录单价。
  //   此前只有 no_price 有标记，`cost == null`（未收录）走到这里**什么标记都不打** →
  //   账本表 / summary / CSV 三个出口一律输出 ¥0.00 且无告警，"算不出"被读成"免费"，
  //   而同一轮的 toast 侧早已显示「未收录｜⚠未计价」→ 同一份数据两个出口口径不一致。
  //   **本地模型必须排除**：它 cost 恒为 null 是既定正确行为（本地不计费），打"未收录"就是误报。
  if (cost == null && !isLocalModel(name) && !m.no_price) {
    m.unpriced = true;
    m.unpriced_note = '价库未收录该模型（无单价可折算）'; // 供 --report 表格与后续排查
  } else if (m.unpriced) {
    // 补录单价后（刷新价库 / recalc 回填）→ 清标记，下轮起金额正常计入
    delete m.unpriced; delete m.unpriced_note;
  }
  day.total = dayTotalOf(day.models);
}
// 统一记账入口：byModel（transcript 按模型分桶）优先；否则按 stat.model 单桶。
// 每轮只在最终落点调用一次（普通轮 Stop / watcher 汇总 / hook 兜底补弹），天然不重复记账。
// v2.68 修复1：返回 true/false 表示本轮用量是否真的落盘。调用方（incrementalRecord）必须据此
// 决定是否推进水位线——记账失败却推进水位线 = 这部分用量永久丢失。
// 返回 false 的三种情形：账本此前损坏 / 锁获取失败 / 无用量可记；写盘失败也返回 false。
// meta（v3.20.0）：轮次元信息（sid/roundStart/durMs/model/subCount/teamActive/source/label），
//   仅用于轮次明细留档；**可选**——不传即完全保持旧行为（其余 8 个调用点都没传，明细里也不会出现它们）。
function recordUsage(stat, pricing, byModel, tsMs, meta) {
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
      for (const [name, b] of Object.entries(byModel)) addModelUsage(day, name, b, pricing, tsMs);
    } else if (stat && ((stat.in || 0) + (stat.out || 0)) > 0) {
      addModelUsage(day, stat.model || 'unknown', stat, pricing, tsMs);
    } else {
      return false; // 无用量可记：不算失败也不算成功（调用方无需推进水位线，因为没记任何东西）
    }
    const saved = saveDailyUsageRaw(d);
    // v3.20.0：账本确认落盘后才落轮次明细，且写在锁内（与记账串行化，不会出现半条记录）。
    //   saved 为假（写盘失败）→ 不落明细，避免"账本没记但明细有"的不一致。
    //   明细自身异常一律吞掉——它只是附带产物，绝不能影响记账返回值与水位线推进。
    if (saved) { try { appendRoundDetail(byModel, stat, pricing, tsMs, meta); } catch (e) { /* 明细失败不影响记账 */ } }
    return saved;
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
    // v3.39.0（A2）：返回 false 供调用方回滚账本。改前静默返回 undefined —— 账本已写入、
    // 水位线没推进 → 下轮从旧偏移重读同一批行再累加一遍 = **重复计费**（不可恢复地多收钱）。
    return false;
  }
  // v3.39.0（A2）：写后校验。磁盘满 / 权限 / 被别的进程覆盖都可能「没抛异常但内容不对」，
  // 只靠 try/catch 抓不到。只校验本次涉及的键（别的会话键可能是别的进程写的，不算失败）。
  try {
    const back = JSON.parse(fs.readFileSync(LEDGER_WATERMARK_FILE, 'utf-8'));
    for (const k of Object.keys(wm || {})) {
      const a = wm[k] || {};
      const b = (back && back[k]) || null;
      if (!b) return false;
      if ((a.main || 0) !== (b.main || 0)) return false;
      if ((a.lastTs || 0) !== (b.lastTs || 0)) return false;
    }
  } catch (e) {
    return false;
  }
  return true;
}

// v3.39.0（A2 反向闸门）：「账本已写入、水位线没落盘」的回滚。
// 只做文件层恢复、不做任何计算 → 保持确定性，可单测（不靠"我觉得回滚了"）。
// snap = { ledgerPath, preLedger(Buffer|null), roundsPath, preSize, postSize }
// 安全方向：回滚后水位线仍是旧值 → 下轮重新记账（少记可恢复）；不回滚 = 重复计费（不可恢复）。
function rollbackLedgerAfterWatermarkFailure(snap) {
  const out = { ledger: false, rounds: false };
  if (!snap) return out;
  try {
    // 只有「回滚前确为合法 JSON 对象」才原样写回。preLedger 是损坏内容时（本轮记账里
    // loadDailyUsage 已把它改名隔离成 .corrupt-<ts> 并另起新账本）原样写回 = 把损坏内容塞回去，
    // 下轮又要重新隔离一遍。此时写 '{}' 才是真正的「回到记账前」（历史仍在 .corrupt 备份里）。
    let restore = null;
    if (snap.preLedger !== null && snap.preLedger !== undefined) {
      try {
        const parsed = JSON.parse(Buffer.from(snap.preLedger).toString('utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) restore = snap.preLedger;
      } catch (e) { restore = null; } // 损坏内容 → 落到下面的 '{}'
    }
    // 原本不存在 / 原本损坏 → 写回空账本，**不删文件**（删除是不可逆动作，且空账本与缺失对读侧等价）
    fs.writeFileSync(snap.ledgerPath, restore !== null ? restore : '{}');
    out.ledger = true;
  } catch (e) { /* 回滚失败也不再补救：下面只如实告警 */ }
  try {
    if (snap.roundsPath && Number.isFinite(snap.preSize)) {
      const now = fs.statSync(snap.roundsPath).size;
      // 期间有别的进程追加过 → 不截断（truncate 会误删别人的行，宁可留一条多余明细）
      if (Number.isFinite(snap.postSize) && now !== snap.postSize) out.rounds = false;
      else { fs.truncateSync(snap.roundsPath, snap.preSize); out.rounds = true; }
    }
  } catch (e) { /* 明细回滚失败不影响金额正确性 */ }
  return out;
}
// 增量记账：累加主 transcript + 各子代理文件中"水位线之后"的新 usage 行，并推进水位线。
// v2.82.1：整个「读水位线→算增量→记账→推进」序列放入水位线锁（.ledger-watermark.lock）——
// watcher(--flush-delayed) 与新一轮 Stop 并发时，两进程可能读到同一旧水位线 → 同一批行
// 各记一遍 = 账本重复计费（专家团 6s 确认窗 ∩ 新 Stop 真实可触发）。串行化后：后到者读到
// 先到者推进的新水位线，只记增量。锁获取失败 → 本轮跳过（下轮 Stop 补记，不丢不重）。
function incrementalRecord(tsPath, sid, meta) {
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
  // v3.19.2（B8）：本批新行的最大 timestamp —— 用作峰谷判定时刻，避免"脚本运行时刻"计价
  let peakTs = 0;
  const bumpTs = (rows) => {
    for (const r of rows) { const t = Number(r && r.timestamp); if (Number.isFinite(t) && t > peakTs) peakTs = t; }
  };
  // v3.25.0（KI-5）：各文件独立的「已消费 max ts」收集（peakTs 是主+子代理混用的计价时刻，不能挪用）。
  const maxTsOf = (rows) => {
    let m = 0;
    for (const r of rows) { const t = Number(r && r.timestamp); if (Number.isFinite(t) && t > m) m = t; }
    return m;
  };
  let mainMaxTs = 0;
  // 1. 主 transcript 新行（行数水位线，单调递增，slice 可靠）
  // v2.68 修复1：先算出"候选新水位线"，记账成功后再落；失败则保持旧值，下轮重扫重记。
  // v2.68 修复2：候选值取 Math.max —— transcript 可能被截断（Context Compaction 覆盖重写、
  // 外部工具清空重建、磁盘故障），行数会**下降**。若直接赋新值，水位线被拉回小值，
  // 之后文件重新长到原长度时会把已记过的行再记一遍 = 重复计费。水位线只许前进不许后退。
  // v2.69 性能：只读 + 只解析"水位线之后的新行"。
  // 统计口径完全不变：rows 等价于旧实现的 mainRows.slice(entry.main)，totalLines 等价于 mainRows.length。
  // v3.25.0（KI-5）：截断恢复 —— truncated 时水位线不再永久冻结。
  // 恢复语义：从 0 重读重写后文件的**全部完整行**，perModelFromRows / estimateInterrupted 按
  // fromTs = entry.lastTs 过滤（ts <= lastTs 的行已记过账，跳过；ts > lastTs 的行从未记账，计入）。
  // 判据成立的前提：transcript 行按时间追加写入 → 已记账行的 ts 全部 <= lastTs（lastTs 即历史 max）。
  // 已知盲区（可接受）：写入晚、但 ts 回填早于 lastTs 的未记账行会被过滤丢失——单行损失且有告警，
  // 换取「重置后新消耗恢复记账」这一定收益（否则从冻结点起**所有**消耗永久静默少计）。
  // lastTs 缺失（旧版本水位线升级而来）→ 无去重判据，**宁可保持冻结也不重置**（无过滤重置 = 无条件重复计费）。
  // nextMain 一次推进到重写后文件实际行数 → 之后恢复正常增量，重读只发生一轮。
  let { rows: mainRows, totalLines, truncated } = readTranscLinesFrom(tsPath, entry.main || 0);
  let nextMain = Math.max(entry.main || 0, totalLines);
  let fromTsMain = 0; // 正常路径恒 0（perModelFromRows 不过滤），行为与旧版逐字节一致
  if (truncated && (entry.main || 0) > 0) {
    const lastTs = Number(entry.lastTs) || 0;
    if (lastTs > 0) {
      const full = readTranscLinesFrom(tsPath, 0);
      mainRows = full.rows;
      fromTsMain = lastTs;
      nextMain = full.totalLines;
      process.stderr.write(`[token-tracker] ⚠ transcript 曾被压缩重写（水位线 ${entry.main} > 完整行数），已按时间戳去重重置水位线到 ${nextMain}：新消耗恢复记账；被压缩的历史差额不可恢复（见 KNOWN-ISSUES KI-5）\n`);
    }
  }
  if (totalLines > entry.main || fromTsMain > 0) {
    bumpTs(mainRows);
    mainMaxTs = maxTsOf(mainRows); // v3.25.0（KI-5）：本批 max ts → 写侧持久化为截断恢复判据
    merge(perModelFromRows(mainRows, fromTsMain));
    // v3.25.0（KI-5）：重置场景不能用 estimateInterruptedInc —— 其全量回退分支按「行数差」推起点
    // （full.length - rows.length），对重置语义不成立（两侧都= M → 起点 0 → 已记账行全部重估重复）。
    // 改用同量纲 estimateInterrupted(mainRows, 0, fromTsMain)：fromTs 过滤已记账行（该函数内建支持）。
    if (fromTsMain > 0) merge(estimateInterrupted(mainRows, 0, fromTsMain));
    else merge(estimateInterruptedInc(tsPath, mainRows)); // v2.52：中断补偿
  }
  // 2. 各子代理文件新行
  // v3.25.0（KI-5）：子代理文件同样会被 compaction 截断重写 → 对称恢复。判据用**各文件自己的**
  // subTs[f]（不能用主文件 lastTs：主文件通常更新、ts 更大，会把子代理未记账的行误过滤掉）。
  const nextSubs = {};
  const subMaxTs = {}; // v3.25.0（KI-5）：各子代理文件本批 max ts（写侧持久化为去重判据）
  const subDir = subagentsDirFromTranscript(tsPath);
  if (fs.existsSync(subDir)) {
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!/^agent-.+\.jsonl$/i.test(f)) continue;
        const fp = path.join(subDir, f);
        // v2.69 性能：与主 transcript 同口径，只解析水位线之后的新行
        const start = entry.subs[f] || 0;
        let { rows: subRows, totalLines: subTotal, truncated: subTrunc } = readTranscLinesFrom(fp, start);
        let nextSubVal = Math.max(start, subTotal);
        let fromTsSub = 0;
        if (subTrunc && start > 0) {
          const sLast = Number((entry.subTs || {})[f]) || 0;
          if (sLast > 0) {
            const full = readTranscLinesFrom(fp, 0);
            subRows = full.rows;
            fromTsSub = sLast;
            nextSubVal = full.totalLines;
            process.stderr.write(`[token-tracker] ⚠ 子代理 ${f} 曾被压缩重写（水位线 ${start}），已按时间戳去重重置到 ${nextSubVal}（KI-5）\n`);
          }
        }
        if (subTotal > start || fromTsSub > 0) {
          bumpTs(subRows);
          subMaxTs[f] = maxTsOf(subRows); // v3.25.0（KI-5）
          merge(perModelFromRows(subRows, fromTsSub));
          if (fromTsSub > 0) merge(estimateInterrupted(subRows, 0, fromTsSub));
          else merge(estimateInterruptedInc(fp, subRows)); // v2.53：子代理被中断思考也估算
        }
        // 修复2：子代理水位线同样只许前进（子代理 transcript 也会被 compaction 截断重写）
        nextSubs[f] = nextSubVal;
      }
    } catch (e) { /* 忽略 */ }
  }
  // 3. 累加进账本（loadDailyUsage + addModelUsage + saveDailyUsage）
  //    无用量的轮次视为成功（无需落盘，推进水位线无害）；有用量时必须确认真的写进去了。
  const willRecord = Object.keys(byModel).length > 0;
  // v3.39.0（A2）：记账前快照，供水位线落盘失败时回滚（只有真要记账才需要）。
  //   顺序刻意保持「先记账、后水位线」：反过来（先水位线）在账本写失败时会**静默永久少记**，
  //   而少记本可由「不推进水位线 + 下轮重记」自动补回，不该退化成丢数据。
  //   代价就是必须补这道反向闸门——记账成功但水位线没落盘 = 下轮重复计费。
  let snap = null;
  if (willRecord) {
    let preLedger = null;
    try { preLedger = fs.existsSync(DAILY_USAGE_FILE) ? fs.readFileSync(DAILY_USAGE_FILE) : null; } catch (e) { preLedger = null; }
    let roundsPath = null;
    let preSize = null;
    try {
      roundsPath = path.join(ROUNDS_DIR, 'rounds-' + todayStr().slice(0, 7) + '.jsonl');
      preSize = fs.statSync(roundsPath).size;
    } catch (e) { roundsPath = null; preSize = null; }
    snap = { ledgerPath: DAILY_USAGE_FILE, preLedger, roundsPath, preSize, postSize: null };
  }
  let recorded = true;
  if (willRecord) recorded = recordUsage({}, loadPricing(), byModel, peakTs || undefined, meta);
  if (!recorded) {
    // 记账失败（账本损坏 / 锁获取失败 / 写盘失败）→ 绝不推进水位线，
    // 否则这些用量再也不会被补记 = 永久丢失。保持旧水位线，下轮重新记账。
    process.stderr.write(`[token-tracker] 本轮用量未落盘，水位线保持 ${entry.main} 不推进（下轮重试，避免用量永久丢失）\n`);
    return;
  }
  if (willRecord && snap && snap.roundsPath) {
    try { snap.postSize = fs.statSync(snap.roundsPath).size; } catch (e) { snap.postSize = null; }
  }
  // 4. 记账成功 → 推进水位线
  const prevMain = entry.main || 0; // v3.39.0：回滚告警要用旧值（下一行就把 entry.main 改掉了）
  entry.main = nextMain;
  for (const f of Object.keys(nextSubs)) entry.subs[f] = nextSubs[f];
  // v3.25.0（KI-5）：持久化各文件「已消费最大时间戳」——截断恢复（水位重置 + 时间戳去重）的判据。
  // 与水位线同一 entry 对象、同一次 saveLedgerWatermark 落盘 → 记账失败时两者同退，天然一致。
  // 数学安全：重置场景 rows 为全量行，但已记账行 ts 全部 <= lastTs → max(全量) = max(新行) 或 lastTs，不越界。
  if (mainMaxTs > (Number(entry.lastTs) || 0)) entry.lastTs = mainMaxTs;
  if (Object.keys(subMaxTs).length) {
    entry.subTs = entry.subTs || {};
    for (const [f, t] of Object.entries(subMaxTs)) {
      if (t > (Number(entry.subTs[f]) || 0)) entry.subTs[f] = t;
    }
  }
  const wmOk = saveLedgerWatermark(wm);
  // v3.39.0（A2 反向闸门）：记账成功、但水位线没落盘 → 下轮从旧偏移重读同一批行再累加 = **重复计费**。
  //   回滚本轮账本（+轮次明细），水位线保持旧值 → 下轮重记（少记可恢复，重复不可恢复）。
  if (willRecord && !wmOk) {
    const rb = rollbackLedgerAfterWatermarkFailure(snap);
    process.stderr.write(`[token-tracker] ⚠ 水位线落盘失败，已回滚本轮账本${rb.ledger ? '' : '（回滚失败！请人工核对 daily-usage.json）'}，水位线保持 ${prevMain} 不推进（下轮重记，避免重复计费）\n`);
    return;
  }
  }, { ttl: 300000, retries: 30, retryDelay: 100 }); // v2.82.1：水位线锁；拿不到锁 → 本轮跳过，下轮补记
}

// ===== v3.32.0（P1-1 兜底）：金额格「该显示什么」的唯一判定 =====
// 病根：此前「无公开价 / 未收录」的判定被**抄了三份**（表格行 / CSV / 区间透传），改一处漏一处是必然——
//   v3.31.0 修 unpriced 时就踩过：formatUsageRow 改好了，aggregateRangeModels 没透传标记 → 区间表静默 ¥0.00。
// 语义（**真价优先**，见 plan-v3.32.0 §0.2 裁决）：
//   cost > 0 = 这笔钱已经算出来了 → 显示金额。此时若还挂着 no_price / unpriced 标记，
//   那标记必是**陈旧残留**（价已补录但标记没清）；把已算出的钱藏起来 = 信息丢失，重于少显示一个标记。
//   cost == 0 + 标记 = 钱真算不出来 → 显示成因（未收录 / 无公开价），绝不显示 ¥0.00（会被读成"免费"）。
// 注意：本函数只决定「显示什么」，**不改账本标记**；告警尾注另走一套判据（见各尾注处的注释）。
function costCellKind(s) {
  if (s.cost > 0) return 'ok';
  if (s.unpriced) return 'unpriced';
  if (s.no_price) return 'no_price';
  return 'zero';
}

// ===== v3.20.0：账本表格行格式化（reportTxt / reportRangeTxt 共用）=====
// 抽出来只为一件事：让「单日/all」与「区间」两个入口的列格式**永远不可能失配**。
// 若以后要加列，只改这里一处；selftest 有一条「既有入口逐字节不变」的断言兜底。
function formatUsageRow(s, bold) {
  const f = (v) => (bold ? `**${v}**` : v);
  // hit 列：优先读已存字段，旧数据兜底现算；两位小数 %
  const hit = (s.hit != null ? s.hit : (s.in > 0 ? hitRate(s.in, s.cached) : 0)).toFixed(2) + '%';
  // v3.27.0：no_price 条目（厂商未公布按 token 单价）金额列显示「无公开价」而不是 ¥0.00——
  //   ¥0.00 会被读成"这天这个模型免费"，而真相是"厂商没发布价、这笔钱算不出来"，
  //   直接导致读者以为当日合计是完整的。合计行不标（合计本来就只是已知部分和，另有行尾提示）。
  // v3.31.0（缺陷B）：unpriced（价库**未收录**该模型 → calcCost 返回 null）同理显示「未收录」——
  //   它与 no_price（厂商未公布单价）是两种成因、两种处置，措辞**刻意不同**，用户一眼能分：
  //     「无公开价」= 等厂商公布；「未收录」= 我们没这模型，先把单价补进 pricing.json。
  //   两标记由 addModelUsage 互斥写入，这里先判 unpriced 只是为了兜底顺序确定。
  // v3.32.0（P1-1 兜底）：判定交给 costCellKind 一处，本行不再自己排优先级——
  //   真价优先（cost>0 → 显示金额）由那一个函数统一保证，CSV 与区间表共用同一判据。
  const kindRow = costCellKind(s);
  const costCell = kindRow === 'unpriced' ? '未收录'
    : kindRow === 'no_price' ? '无公开价'
      : (s.cost > 0 ? fmtCost(s.cost) : '¥0.00');
  return `| ${f(s.label)} | ${f(fmt(s.in))} | ${f(fmt(s.out))} | ${f(fmt(s.cached))} | ${f(hit)} | ${f(fmt(s.total))} | ${f(costCell)} |`;
}
// ===== v3.20.0：--report 区间 / CSV / 外推 =====
// 设计红线：既有的 `--report`、`--report <date>`、`--report all`、`--report summary [all|<date>]`
// 四条入口的输出必须**逐字节不变**（selftest 有断言），新区间能力全部走新分支。
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}
function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
// 解析区间参数：week / month / <起>..<止>；非区间写法（'' / all / 具体日期 / summary）→ null。
// 起止写反时自动纠正（`2026-09-30..2026-09-01` 不该报错，用户意图显然）。
function parseReportRange(arg) {
  const a0 = String(arg || '');
  if (a0 === 'week') return { from: daysAgoStr(6), to: todayStr(), label: 'week' };
  if (a0 === 'month') return { from: monthStartStr(), to: todayStr(), label: 'month' };
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(a0);
  if (m) {
    const a = m[1], b = m[2];
    return { from: a <= b ? a : b, to: a <= b ? b : a, label: 'range' };
  }
  return null;
}
// 区间聚合：只做两件事——按字段求和（token/金额）、按 Σin/Σcached **重算** hit。
//   为什么必须重算 hit：它是比率。跨天 token 量可能差 100 倍，取各天 hit 的算术均值毫无意义。
//   total 保持累加（不重算 in+out），以便与「逐日 total 相加」严格可对账。
function aggregateRangeModels(d, from, to) {
  const models = {};
  const allKeys = Object.keys(d || {});
  const dates = allKeys.filter((k) => k >= from && k <= to).sort();
  // v3.31.0（P0-1 复核结论）：这里**不是**正则匹配日期，而是字典序字符串比较 `k >= from && k <= to`。
  //   后果：非 ISO 键会被静默排除——'/' 是 0x2F > '-' 0x2D，故 '2026/10/02' 恒 > '2026-10-02'
  //   （落在区间内也取不到，且越往后越排不上）；'20261002' 同理（index 4 的 '1' > '-'）。
  //   **但不改它**：账本键由本工具自己写 —— todayStr() / daysAgoStr() / monthStartStr() 恒产出 ISO，
  //   唯一的非 ISO 来源是人工手改 daily-usage.json，概率极低；而"模糊识别日期"会把
  //   `2026-W40` / `2026-10-2`（少补零）这类键的解释权交给猜，收益 < 引入新口径的风险。
  //   改为**低成本告警**：一旦真出现就把话说到 stderr + 报表行尾，不再"凭空消失且无人知晓"。
  const nonIsoKeys = allKeys.filter((k) => !/^\d{4}-\d{2}-\d{2}$/.test(k) && /^\D*\d{4}\D?\d{2}\D?\d{2}\D*$/.test(k));
  if (nonIsoKeys.length) {
    process.stderr.write(`[token-tracker] ⚠ 账本存在 ${nonIsoKeys.length} 个非 ISO 日期键（${nonIsoKeys.slice(0, 5).join('、')}）`
      + `——区间聚合按字典序比较日期，这些天不会进入区间报表/CSV。请把键名改为 YYYY-MM-DD\n`);
  }
  let days = 0;
  for (const date of dates) {
    const day = d[date];
    if (!day) continue;
    days++;
    for (const [n, m] of Object.entries(day.models || {})) {
      // v3.33.0（补-S2 治本）：与 dayTotalOf 同一道守卫。v3.24.0 只给 dayTotalOf 加了这道 null 守卫，
      //   本函数（区间聚合）漏了 —— 账本里一条 `"某模型": null` 会让区间报表与 CSV 直接 TypeError 崩掉
      //   （实测 rc=1），而单日表/summary 因 `{...null}` 是合法的空展开而幸免 → 症状是"只有区间和 CSV 打不开"。
      //   守卫必须与 dayTotalOf 同口径：null/非对象条目一律跳过（不计入该模型，也不参与标记透传）。
      if (!m || typeof m !== 'object') continue;
      const t = models[n] || (models[n] = { in: 0, out: 0, cached: 0, total: 0, cost: 0 });
      t.in += m.in || 0; t.out += m.out || 0; t.cached += m.cached || 0;
      t.total += m.total || 0; t.cost += m.cost || 0;
      // v3.27.0：区间聚合透传 no_price（任一天有标记即整段标记）——否则区间表会把无公开价
      // 模型的金额显示成 ¥0.00，与单日表口径不一致（同一份数据两个入口显示不同 = 新的不一致源）。
      // v3.32.0（P1-1）：透传加 `!(m.cost > 0)` 门槛——**当天真的算出了钱**就说明这天的价是有的，
      //   标记是陈旧残留，不该让它把整段都染上（否则区间表会为一段根本没缺失的数据发"合计偏低"假告警）。
      //   门槛加在**每一天**而不是聚合结果上，是为了保住"月中补价"的混合场景：
      //   day1 缺价(cost 0,有标记) + day2 有价(cost 5) → 标记照传（合计确实偏低），金额列仍显示 ¥5.00。
      if (m.no_price && !(m.cost > 0)) t.no_price = true;
      // v3.31.0（P1-7）：缓存价未知同口径透传（任一天有 → 整段标记），否则区间表会比单日表多一份静默低估
      if (m.cached_price_unknown && !(m.cost > 0)) t.cached_price_unknown = true;
      // v3.31.0（缺陷B）：unpriced 同口径透传（任一天有 → 整段标记）。漏了它，区间表会把
      //   未收录模型显示成 ¥0.00 且零告警——formatUsageRow 虽为单日/区间共用，但标记在聚合时丢了。
      if (m.unpriced && !(m.cost > 0)) t.unpriced = true;
    }
  }
  for (const t of Object.values(models)) t.hit = hitRate(t.in, t.cached);
  const total = { in: 0, out: 0, cached: 0, total: 0, cost: 0 };
  for (const m of Object.values(models)) {
    total.in += m.in; total.out += m.out; total.cached += m.cached;
    total.total += m.total; total.cost += m.cost;
  }
  total.hit = hitRate(total.in, total.cached);
  return { models, total, days, dates, nonIsoKeys };
}
// 区间汇总表（一行/模型 + 合计行）。列结构与 reportTxt 完全一致。
function reportRangeTxt(from, to) {
  const d = loadDailyUsage();
  const agg = aggregateRangeModels(d, from, to);
  const names = Object.keys(agg.models).sort();
  const lines = [];
  lines.push(`===== ${from} ~ ${to}（${agg.days} 天有记录）=====`);
  lines.push('| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  if (!names.length) {
    lines.push(formatUsageRow(Object.assign({ label: '合计' }, agg.total), true));
  } else {
    for (const n of names) lines.push(formatUsageRow(Object.assign({ label: n }, agg.models[n]), false));
    lines.push(formatUsageRow(Object.assign({ label: '合计' }, agg.total), true));
  }
  lines.push('');
  // v3.27.0：与单日表同口径——区间内有 no_price 模型时明示合计偏低。
  const npRange = names.filter((n) => agg.models[n] && agg.models[n].no_price);
  if (npRange.length) {
    lines.push(`⚠ 本区间 ${npRange.length} 个模型无公开价（${npRange.join('、')}）`
      + `→ 上面的合计金额**偏低**，只含有价部分；厂商公布单价后补录并跑 recalc-day.js 可回算`);
    lines.push('');
  }
  // v3.31.0（缺陷B）：区间内未收录模型同口径告警（与单日表/summary 措辞同构，只把"本日"换"本区间"；
  //   recalc 不带日期——区间是多天，让 recalc-day.js 自己逐天回算）。
  const upRange = names.filter((n) => agg.models[n] && agg.models[n].unpriced);
  if (upRange.length) {
    lines.push(`⚠ 本区间 ${upRange.length} 个模型未收录单价（${upRange.join('、')}）`
      + `→ 上面的合计金额**偏低**，只含有价部分；把单价补进 pricing.json 后跑 recalc-day.js 可回算`);
    lines.push('');
  }
  // v3.31.0（P1-7）：缓存价未知 → 合计偏低（与"无公开价"是两种不同的低估，必须分别说清楚）
  const ncRange = names.filter((n) => agg.models[n] && agg.models[n].cached_price_unknown && !agg.models[n].no_price);
  if (ncRange.length) {
    lines.push(`⚠ 本区间 ${ncRange.length} 个模型缺缓存价（${ncRange.join('、')}）`
      + `→ 缓存 token 按 0 元计，合计金额**偏低**（缓存命中率越高偏得越多）；补上 cached_price 后跑 recalc-day.js 可回算`);
    lines.push('');
  }
  // v3.31.0（P0-1）：账本混进非 ISO 日期键 → 那些天在本区间是**被静默排除**的，必须让用户知道
  if (agg.nonIsoKeys && agg.nonIsoKeys.length) {
    lines.push(`⚠ 账本含 ${agg.nonIsoKeys.length} 个非 ISO 日期键（${agg.nonIsoKeys.slice(0, 5).join('、')}）`
      + `——区间聚合按字典序比较日期，这些天的记录未计入上表；请把 daily-usage.json 的键名改为 YYYY-MM-DD`);
    lines.push('');
  }
  lines.push('口径：金额按 pricing.json 的 API 单价折算（缓存价 / 峰谷倍数已计入），**不是真实扣费**；');
  lines.push('      本技能只读 WorkBuddy 落盘的 token 用量，与客户端自带积分/额度之间不存在换算关系。');
  return lines.join('\n');
}
// CSV 导出：逐日 × 逐模型明细 + 末尾 ALL 合计行（用户可在 Excel 里自行透视）。
// 编码必须带 UTF-8 BOM，否则 Excel 打开中文列头必乱码（与 loadDailyUsage 剥 BOM 是同一个坑的两面）。
function exportReportCsv(range) {
  const d = loadDailyUsage();
  const agg = aggregateRangeModels(d, range.from, range.to);
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['date', 'model', 'in', 'out', 'cached', 'hit_pct', 'total', 'cost_api_equiv'].join(',')];
  for (const date of agg.dates) {
    const day = d[date];
    if (!day) continue;
    for (const n of Object.keys(day.models || {}).sort()) {
      const m = day.models[n] || {};
      const hit = (m.hit != null ? m.hit : hitRate(m.in || 0, m.cached || 0)).toFixed(2);
      // v3.31.0（缺陷B）：金额格不再是"全是数字"——未收录 / 无公开价的模型写 ASCII 标记，
      //   否则 Excel 里看到 0.000000 会当成"这笔免费"，与 --report 表的「未收录 / 无公开价」口径分裂。
      //   **刻意不新增列**：表头一变就会破坏既有 CSV 消费者，也会让"全有价账本输出一字不差"这条红线失效；
      //   改成只在这两类异常行里替换金额格的写法后，正常行仍严格是 %.6f 数字，零噪音成立。
      // v3.32.0（P1-1 兜底）：与表格行共用 costCellKind（此前两份判定各自抄一遍 → 改一处漏一处）。
      const kindCsv = costCellKind(m);
      const costCell = kindCsv === 'unpriced' ? 'unpriced'
        : kindCsv === 'no_price' ? 'no_price'
          : (m.cost || 0).toFixed(6);
      rows.push([date, cell(n), m.in || 0, m.out || 0, m.cached || 0, hit, m.total || 0, costCell].join(','));
    }
  }
  rows.push(['ALL', '__TOTAL__', agg.total.in, agg.total.out, agg.total.cached,
    agg.total.hit.toFixed(2), agg.total.total, agg.total.cost.toFixed(6)].join(','));
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const file = path.join(EXPORTS_DIR, `report-${range.label}-${stamp}.csv`);
  try {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(file, '\uFEFF' + rows.join('\n') + '\n', 'utf-8');
  } catch (e) {
    return `导出失败：${e.message}`;
  }
  return `已导出：${file}（${rows.length - 1} 行，UTF-8 BOM，金额为 API 单价折算值）`;
}
// v3.33.0（B 系列·`--report summary --csv` 补出口）：
//   病根：`summary` 是**唯一**没有 CSV 出口的 `--report` 入口。实测 `--report summary --csv` 得到的是
//   「无法识别的参数：summary」——而 summary 明明是合法参数，**连那句错误文案自己都漏列了它**
//   （原文案只写 week / month / <起>..<止> / all / <日期> / forecast）。用户敲了正确命令却被判非法。
//   口径：与 `reportSummaryTxt` **同口径**——每天一行、只出总合计（不出模型明细），
//   并把「无公开价 / 未收录单价」的**模型个数**写进最后两列；否则 Excel 里那个金额会被当成完整金额
//   （与文本版的那两行 `⚠` 同义：合计只含已知部分）。两处过滤条件刻意逐字对齐文本版，
//   而不是改用 costCellKind —— 后者在"两个标记同时置位"时只会归一类，与文本版会把同一模型计入两栏不一致。
//   **一处刻意的差异（已权衡，不是遗漏）**：请求的日期不在账本里时，文本版打 `（无记录）`，
//   这里打**整行空白**而不是 0——数值列写 0 会被读成"那天没用量/免费"，与"没有这天的记录"是两回事。
//   实际上 `summary all` 只遍历账本里已有的日期，**永不**产生这种行；只有用户显式点一个账本里没有的
//   日期（如 `--report summary 2020-01-01 --csv`）才会命中。空白行不计入 ALL 合计（缺失即 0 增量，口径正确）。
function exportSummaryCsv(arg) {
  const d = loadDailyUsage();
  const today = todayStr();
  const allDates = Object.keys(d).sort(); // 旧→新：CSV 从上往下读即时间顺序
  let targets;
  if (arg === 'all') targets = allDates;
  else if (arg) targets = [arg];
  else targets = [today];
  if (!targets.length) return '账本为空（暂无可导出数据）';
  const rows = [['date', 'in', 'out', 'cached', 'total', 'cost_api_equiv', 'no_price_models', 'unpriced_models'].join(',')];
  let sIn = 0, sOut = 0, sCached = 0, sTotal = 0, sCost = 0;
  for (const date of targets) {
    const day = d[date];
    // 日期不在账本里：整行空白（= 文本版的「（无记录）」），**不写 0**——0 会被读成"零用量/免费"。
    if (!day) { rows.push([date, '', '', '', '', '', '', ''].join(',')); continue; }
    const models = (day.models && typeof day.models === 'object') ? day.models : {};
    const total = day.total || dayTotalOf(models);
    const np = Object.keys(models).filter((n) => models[n] && models[n].no_price && !(models[n].cost > 0)).length;
    const up = Object.keys(models).filter((n) => models[n] && models[n].unpriced && !(models[n].cost > 0)).length;
    sIn += total.in || 0; sOut += total.out || 0; sCached += total.cached || 0;
    sTotal += total.total || 0; sCost += total.cost || 0;
    rows.push([date, total.in || 0, total.out || 0, total.cached || 0, total.total || 0,
      (total.cost > 0 ? total.cost : 0).toFixed(6), np, up].join(','));
  }
  // 合计行：金额同文本版——只含"有价部分"。异常栏留空（合计不存在"哪个模型"）
  rows.push(['ALL', sIn, sOut, sCached, sTotal, (sCost > 0 ? sCost : 0).toFixed(6), '', ''].join(','));
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const label = arg === 'all' ? 'summary-all' : (arg ? 'summary-' + arg : 'summary');
  const file = path.join(EXPORTS_DIR, `report-${label}-${stamp}.csv`);
  try {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(file, '\uFEFF' + rows.join('\n') + '\n', 'utf-8');
  } catch (e) {
    return `导出失败：${e.message}`;
  }
  return `已导出：${file}（${rows.length - 1} 行，UTF-8 BOM，金额为 API 单价折算值）`;
}

// 消耗外推（v3.20.0）：**只推 token，不推金额**。
//   为什么砍掉金额外推：金额本身是 API 单价折算值，不是真实扣费，外推它等于在虚拟数上再乘一次，
//   只会制造"这个月要花多少钱"的错觉。token 数是平台真实落盘的，外推它才有意义。
function reportForecastTxt() {
  const d = loadDailyUsage();
  const today = todayStr();
  const day = d[today];
  const t = day ? (day.total || dayTotalOf(day.models || {})) : { total: 0 };
  const now = new Date();
  const minsPassed = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const lines = [];
  lines.push('===== 消耗外推（只推 token，不推金额）=====');
  lines.push(`今日至 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    + `   总 ${fmt(t.total || 0)} tokens（已过 ${(minsPassed / 60).toFixed(1)}h）`);
  if (minsPassed >= 10 && (t.total || 0) > 0) {
    lines.push(`按当前速率到 24:00   约 ${fmt(Math.round((t.total || 0) / minsPassed * 1440))} tokens`);
  } else {
    lines.push('按当前速率到 24:00   不外推（今日已过 < 10 分钟，或无用量）');
  }
  const past = Object.keys(d || {}).filter((k) => k < today).sort().reverse().slice(0, 7);
  const vals = past.map((k) => { const x = d[k].total || dayTotalOf(d[k].models || {}); return x.total || 0; });
  if (vals.length >= 2) {
    lines.push(`近 ${vals.length} 日实测均值   ${fmt(Math.round(vals.reduce((s, v) => s + v, 0) / vals.length))} tokens/日`);
  } else {
    lines.push(`近 7 日实测均值   不计算（历史样本 ${vals.length} 天 < 2 天）`);
  }
  lines.push('');
  lines.push('说明：外推 = 今日已消耗 ÷ 已过时间 × 24h 的线性估算，只推 token；');
  lines.push('      金额列一律为「按 API 单价折算」，与 WorkBuddy 客户端额度之间不存在换算关系。');
  return lines.join('\n');
}
// ===== v3.33.0（第四轮审计 P1-3/建议 1）：--doctor 只读体检 =====
// 为什么需要：本技能的历史缺陷几乎全是**静默失效**型 —— 配了 hook 但结构性不工作（S1）、价库/假日数据
//   长期陈旧、账本被 null 条目污染（补-S2）、锁与合并文件堆积。它们都不报错，只在某天让用户发现
//   "数字不对"。它同时是 P4 拆分重构的前置条件：拆完必须能一键确认各条链路仍健康。
// 硬约束（体检就得是体检）：
//   ① **只读**——不联网、不写任何文件、不触发任何刷新。故**刻意不用** `loadPricing()`（其内部会
//      maybeRefreshLocalDb / maybeRefreshHolidays 联网并 spawn）与 `loadDailyUsage()`（账本真损坏时
//      它会改名隔离 = 写操作），改为本地只读解析。
//   ② 永不改变退出码。它是手动命令，不该让 hook/CI 变红。
function doctorTxt() {
  const lines = [];
  let nPass = 0, nWarn = 0, nBad = 0;
  const sec = (tag, level, msg) => {
    if (level === 'ok') nPass++; else if (level === 'warn') nWarn++; else nBad++;
    lines.push(`[${tag}] ${level === 'ok' ? '✅' : level === 'warn' ? '⚠ ' : '❌'} ${msg}`);
  };
  const spanTxt = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '未知';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    if (m < 1440) return `${Math.floor(m / 60)} 小时前`;
    return `${Math.floor(m / 1440)} 天前`;
  };
  const daysSince = (iso) => {
    const t = Date.parse(String(iso || '') + 'T00:00:00');
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  };
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')); } catch (e) { return null; } };

  lines.push('===== token-tracker 自检（--doctor）=====');
  lines.push(`运行环境：WB=${WB}`);
  lines.push('');

  // ① 账本可读性
  try {
    if (!fs.existsSync(DAILY_USAGE_FILE)) {
      sec('账本', 'warn', `尚未生成（${path.basename(DAILY_USAGE_FILE)} 不存在）——若已经用了一阵子，说明 Stop 端没在记账`);
    } else {
      const st = fs.statSync(DAILY_USAGE_FILE);
      const raw = fs.readFileSync(DAILY_USAGE_FILE, 'utf-8').replace(/^\uFEFF/, '');
      let d = null, perr = '';
      try { d = JSON.parse(raw); } catch (e) { perr = String(e && e.message); }
      if (!d) {
        sec('账本', 'bad', `解析失败（${perr}）→ 跑 --report 会自动隔离改名并重建，历史需靠备份`);
      } else {
        const dates = Object.keys(d).filter((k) => k !== '_instructions' && d[k] && typeof d[k] === 'object');
        let dirty = 0, models = new Set(), tok = 0;
        for (const k of dates) {
          const mm = (d[k].models && typeof d[k].models === 'object') ? d[k].models : {};
          for (const [n, m] of Object.entries(mm)) {
            if (!m || typeof m !== 'object') { dirty++; continue; }
            models.add(n); tok += m.total || 0;
          }
        }
        sec('账本', dirty ? 'warn' : 'ok',
          `可读 ｜ ${dates.length} 天 / ${models.size} 模型 ｜ 累计 ${fmt(tok)} tokens ｜ 最后更新 ${spanTxt(Date.now() - st.mtimeMs)}`
          + (dirty ? ` ｜ **脏条目 ${dirty} 个**（null/非对象，v3.33.0 前会让区间报表与 CSV 崩；现已跳过）` : ' ｜ 脏条目 0'));
      }
    }
  } catch (e) { sec('账本', 'bad', `检查异常：${(e && e.message) || e}`); }

  // ② 水位线 / 合并文件 / 锁 堆积
  try {
    const wm = readJson(LEDGER_WATERMARK_FILE);
    const wmSids = wm && typeof wm === 'object' ? Object.keys(wm).length : 0;
    let coa = [], lck = [], snap = [];
    try {
      for (const f of fs.readdirSync(SNAP_DIR)) {
        if (/^\.coalesce-.*\.json$/.test(f)) coa.push(f);
        else if (/\.lock$/.test(f)) lck.push(f);
        else if (/^\.snapshot-.*\.json$/.test(f)) snap.push(f);
      }
    } catch (e) { /* 目录不存在 → 视为 0 */ }
    const oldest = (arr) => {
      let t = Infinity;
      for (const f of arr) { try { t = Math.min(t, fs.statSync(path.join(SNAP_DIR, f)).mtimeMs); } catch (e) { /* 忽略 */ } }
      return Number.isFinite(t) ? Date.now() - t : 0;
    };
    const stale = coa.filter((f) => oldest([f]) > 10 * 60 * 1000); // >10min：watcher 本该已清（KI-6 自愈阈）
    sec('状态文件', (stale.length || lck.length) ? 'warn' : 'ok',
      `水位线 ${wmSids} 个会话 ｜ 快照 ${snap.length} 个 ｜ 合并文件 ${coa.length} 个${stale.length ? `（**${stale.length} 个滞留 >10min**，watcher 可能被杀，见 KI-3）` : ''} ｜ 锁 ${lck.length} 个${lck.length ? `（最老 ${spanTxt(oldest(lck))}）` : ''}`);
  } catch (e) { sec('状态文件', 'bad', `检查异常：${(e && e.message) || e}`); }

  // ③ 价库年龄 / 覆盖
  try {
    const p = readJson(PRICING);
    if (!p) sec('价库', 'bad', 'pricing.json 读取失败');
    else {
      const models = (p.models && typeof p.models === 'object') ? p.models : {};
      const keys = Object.keys(models);
      let zero = 0, unpublished = 0;
      for (const k of keys) {
        const m = models[k];
        if (!m || typeof m !== 'object') continue;
        if (m.pricing_status === 'unpublished') unpublished++;
        else if (!(Number(m.input_price) > 0) && !(Number(m.output_price) > 0)) zero++;
      }
      const age = daysSince(p.date);
      const amb = Array.isArray(p._ambig_warnings) ? p._ambig_warnings.length : 0;
      // v3.33.0（A2）：已 lock 条目的歧义告警不进 `_ambig_warnings`（不挂弹窗），但**必须在体检里可见**，
      //   否则 A2 的处置就从"消除误报"变成"隐藏信息"。两者分开列，看到的人自己能判断该不该管。
      const ambLocked = Array.isArray(p._ambig_warnings_locked) ? p._ambig_warnings_locked.length : 0;
      // v3.36.0（P0）：官方价已命中模型的**备用源**歧义同样不进 `_ambig_warnings`（不挂弹窗），
      //   但信息不能丢——否则"静音误报"就变成"隐藏信息"。与 ambLocked 同款处置：独立列出、体检可见。
      const ambOfficial = Array.isArray(p._ambig_warnings_official) ? p._ambig_warnings_official.length : 0;
      const lvl = (age === null || age > 14 || zero) ? 'warn' : 'ok';
      sec('价库', lvl,
        `最后刷新 ${p.date || '未知'}${age === null ? '' : `（${age} 天前${age > 14 ? '，**建议手动跑 refresh-prices.js**' : ''}）`}`
        + ` ｜ 收录 ${keys.length} 个 ｜ 厂商未公布价 ${unpublished} 个 ｜ 0 价 ${zero} 个 ｜ 歧义告警 ${amb} 条`
        + (ambLocked ? `（另有已 lock 条目 ${ambLocked} 条，价已人工冻结、匹配结果不被采用 → 不上弹窗）` : '')
        + (ambOfficial ? `（另有官方价已命中模型 ${ambOfficial} 条，写价走官方价、备用源结果未被采用 → 不上弹窗）` : '')
        + ` ｜ 美元折算汇率 ${p.usd_cny_rate || DEFAULT_RATE}（仅在"模型只有美元源"时参与折算，误差主源是拿不到官网人民币价）`);
    }
  } catch (e) { sec('价库', 'bad', `检查异常：${(e && e.message) || e}`); }

  // ④ 假日数据年份状态（只判定，不联网、不写状态文件）
  try {
    const hp = path.join(SNAP_DIR, 'holidays.json');
    const h = readJson(hp);
    if (!h) sec('假日', 'warn', 'holidays.json 缺失 → 峰谷判定一律降级为「非假日」（不会多算，但会少算高峰）');
    else {
      const years = (h.years && typeof h.years === 'object') ? h.years : {};
      const y = new Date().getFullYear();
      const staleYears = new Set([].concat(h._stale || [], h.stale_years || []).map(String));
      const desc = [y, y + 1].map((yy) => {
        const arr = years[String(yy)];
        if (!Array.isArray(arr) || !arr.length) return `${yy} **未知**`;
        if (staleYears.has(String(yy))) return `${yy} 陈旧`;
        return `${yy} 已确认`;
      });
      const need = holidayModule.holidayRefreshNeeded(h, {}, Date.now());
      const unknown = desc.some((s) => s.includes('**未知**') || s.includes('陈旧'));
      sec('假日', unknown ? 'warn' : 'ok',
        `${desc.join(' ｜ ')}` + (need ? ` ｜ 体检判定需要刷新（${need}）——自动刷新链路会在下次 loadPricing 时触发` : ''));
    }
  } catch (e) { sec('假日', 'bad', `检查异常：${(e && e.message) || e}`); }

  // ⑤ hook 配置完整性（S1 类"配了但不工作"的可见化）
  try {
    const sp = path.join(WB, 'settings.json');
    const st = loadUpdateState();
    const has = (obj, key) => {
      const v = obj && obj.hooks && obj.hooks[key];
      return v && (Array.isArray(v) ? v.length > 0 : true) ? JSON.stringify(v) : '';
    };
    if (!fs.existsSync(sp)) {
      sec('hooks', 'warn', `未找到 ${sp}，无法核对 hook 配置`);
    } else {
      const s = readJson(sp);
      const stopRaw = has(s, 'Stop'), upRaw = has(s, 'UserPromptSubmit');
      const mine = (raw) => raw.includes('token-tracker.js');
      const lastHook = Number(st.lastHookAt) || 0;
      const age = lastHook ? Date.now() - lastHook : Infinity;
      let lvl = 'ok', note = '';
      if (!stopRaw) { lvl = 'bad'; note = '**Stop hook 未配置** → 不会弹窗也不会记账（核心功能等于没装）'; }
      else if (!mine(stopRaw)) { lvl = 'warn'; note = 'Stop 已配但命令里没有 token-tracker.js（可能配错了脚本）'; }
      else if (age > 3 * 86400000) { lvl = 'warn'; note = `Stop 已配，但 lastHookAt ${spanTxt(age)} → 可能结构性不工作（v3.33.0 起只配 Stop 也能记账，仍建议核对 settings.json 是否被判了 Invalid hook config）`; }
      if (!upRaw) note += (note ? '；' : '') + '未配 UserPromptSubmit → 无上下文注入（v3.33.0 起记账不受影响）';
      sec('hooks', lvl,
        `Stop ${stopRaw ? '已配' : '未配'} ｜ UserPromptSubmit ${upRaw ? '已配' : '未配'} ｜ lastHookAt ${lastHook ? spanTxt(age) : '从未'}`
        + (note ? ` ｜ ${note}` : ''));
    }
  } catch (e) { sec('hooks', 'bad', `检查异常：${(e && e.message) || e}`); }

  // ⑥ 日志规模
  try {
    const jobs = [['弹窗日志', TOAST_LOG_PATH], ['快照/决策日志', COMPACTION_LOG_PATH]];
    const parts = jobs.map(([n, p]) => {
      try {
        const sz = fs.statSync(p).size;
        const lc = sz < 10 * 1024 * 1024 ? fs.readFileSync(p, 'utf-8').split('\n').length - 1 : null;
        return `${n} ${(sz / 1048576).toFixed(1)}MB${lc === null ? '' : `/${lc} 行`}`;
      } catch (e) { return `${n} 无`; }
    });
    sec('日志', 'ok', parts.join(' ｜ ') + '（弹窗日志超 5MB 会自动轮清）');
  } catch (e) { sec('日志', 'bad', `检查异常：${(e && e.message) || e}`); }

  // ⑦ 轮次明细 / 版本
  try {
    let rounds = 0, roundsOld = '—';
    try {
      const fs2 = fs.readdirSync(ROUNDS_DIR).filter((f) => /^rounds-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
      rounds = fs2.length; roundsOld = fs2[0] || '—';
    } catch (e) { /* 目录不存在 */ }
    // v3.34.0（A2）：CSV 导出目录同样纳入体检（只读列举，绝不删）。
    let expN = 0, expOld = '';
    try {
      const fe = fs.readdirSync(EXPORTS_DIR).filter((f) => /^report-.*\.csv$/.test(f)).sort();
      expN = fe.length; expOld = fe[0] || '';
    } catch (e) { /* 目录不存在 */ }
    const st = loadUpdateState();
    const latest = st.latestVersion || '';
    const outdated = latest && cmpVersion(latest, SKILL_VERSION) > 0;
    sec('版本', outdated ? 'warn' : 'ok',
      `本地 ${SKILL_VERSION}${latest ? ` ｜ 远端已知 ${latest}${outdated ? '（**有新版本**）' : '（已是最新）'}` : ' ｜ 远端未知（未查到）'}`
      + ` ｜ 轮次明细 ${rounds} 个月（最早 ${roundsOld}，保留 ${ROUNDS_KEEP_MONTHS} 个月，--report 时清理）`
      // v3.34.0（A2）：把"exports/ 也有保留期"变成可见——此前该目录连保留期都没有，且体检里根本不出现。
      + ` ｜ CSV 导出 ${expN} 个${expOld ? `（最早 ${expOld}）` : ''}，保留 ${EXPORTS_KEEP_DAYS} 天，--report 时清理`);
  } catch (e) { sec('版本', 'bad', `检查异常：${(e && e.message) || e}`); }

  lines.push('');
  lines.push(`体检完成：${nPass} 项通过 / ${nWarn} 项警告 / ${nBad} 项异常`);
  lines.push('说明：--doctor 全程只读——不联网、不写文件、不触发刷新；退出码恒为 0（它不该让 hook 变红）。');
  return lines.join('\n');
}

// 清理超过保留期的轮次明细文件。只在 --report 时跑（用户手动触发），不引入常驻任务。
function pruneRoundFiles(keepMonths) {
  try {
    if (!fs.existsSync(ROUNDS_DIR)) return 0;
    const n = Number(keepMonths) > 0 ? Number(keepMonths) : ROUNDS_KEEP_MONTHS;
    const keep = new Set();
    const now = new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keep.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    let removed = 0;
    for (const f of fs.readdirSync(ROUNDS_DIR)) {
      const m = /^rounds-(\d{4}-\d{2})\.jsonl$/.exec(f);
      if (!m || keep.has(m[1])) continue;
      try { fs.unlinkSync(path.join(ROUNDS_DIR, f)); removed++; } catch (e) { /* 单个失败不影响其它 */ }
    }
    return removed;
  } catch (e) { return 0; }
}

// v3.34.0（A2）：清理超过保留期的 CSV 导出。与 pruneRoundFiles 同款——只在 --report 入口跑，
//   不引入常驻任务；单个文件删除失败不影响其它；目录不存在直接返回 0。
//   ⚠️ 只删 `report-*.csv`：目录里非本技能产出的文件一律不动（用户手动放进来的 Excel/笔记绝不能被误删）。
//   失败一律吞掉：清理是附带动作，绝不能让 `--report` 因为清不掉一个旧文件而失败。
function pruneExports(keepDays) {
  try {
    if (!fs.existsSync(EXPORTS_DIR)) return 0;
    const n = Number(keepDays) > 0 ? Number(keepDays) : EXPORTS_KEEP_DAYS;
    const cutoff = Date.now() - n * 86400000;
    let removed = 0;
    for (const f of fs.readdirSync(EXPORTS_DIR)) {
      if (!/^report-.*\.csv$/.test(f)) continue;
      let st = null;
      try { st = fs.statSync(path.join(EXPORTS_DIR, f)); } catch (e) { continue; }
      if (!st || !st.isFile() || st.mtimeMs >= cutoff) continue;
      try { fs.unlinkSync(path.join(EXPORTS_DIR, f)); removed++; } catch (e) { /* 单个失败不影响其它 */ }
    }
    return removed;
  } catch (e) { return 0; }
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
    // v3.20.0：函数体上移到模块级 formatUsageRow（与区间报告共用，保证两个入口列格式永不失配），
    //   本行输出一字未改——selftest 有「既有入口逐字节不变」的断言。
    const cells = formatUsageRow;
    lines.push('| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    if (!names.length) {
      // 仅有金额合计（旧格式迁移天）：直接输出合计行
      lines.push(cells({ label: '合计', in: total.in, out: total.out, cached: total.cached, total: total.total, cost: total.cost }, true));
    } else {
      for (const n of names) lines.push(cells({ label: n, ...models[n] }, false));
      lines.push(cells({ label: '合计', ...total }, true));
    }
    // v3.27.0：当日存在无公开价模型 → 明示"合计金额偏低"，否则读者会把 ¥0.00 当成免费。
    // v3.32.0（P1-1）：排除 cost>0 的条目——钱已算出还说"无公开价→合计偏低"是假告警（标记陈旧残留）
    const noPriceNames = names.filter((n) => models[n] && models[n].no_price && !(models[n].cost > 0));
    if (noPriceNames.length) {
      lines.push(`⚠ 本日 ${noPriceNames.length} 个模型无公开价（${noPriceNames.join('、')}）`
        + `→ 上面的合计金额**偏低**，只含有价部分；厂商公布单价后补录并跑 recalc-day.js ${date} 可回算`);
    }
    // v3.31.0（缺陷B）：未收录模型（价库里没有 → 金额算不出来）同样明示合计偏低。
    //   措辞沿用上面 no_price 那套口径风格（本日 N 个模型…→ 合计偏低…跑 recalc-day.js 可回算），
    //   但**成因与处置刻意写清区别**：未收录 = 我们没这模型，得先把单价补进 pricing.json（不是等厂商）。
    const unpricedNames = names.filter((n) => models[n] && models[n].unpriced && !(models[n].cost > 0));
    if (unpricedNames.length) {
      lines.push(`⚠ 本日 ${unpricedNames.length} 个模型未收录单价（${unpricedNames.join('、')}）`
        + `→ 上面的合计金额**偏低**，只含有价部分；把单价补进 pricing.json 后跑 recalc-day.js ${date} 可回算`);
    }
    // v3.18（M3 修复）：删除 v2.58 引入的「【读取方指令】」提示行——SKILL.md 要求 AI"原样贴出
    // --report 输出"，而该行自带"请勿包含本行"，两者矛盾；且"数据输出里嵌给 AI 的指令"本身就是
    // 指令注入面。展示约定只保留在 SKILL.md（展示格式约束节）。
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
    const models = day.models || {};
    const total = day.total || dayTotalOf(models);
    const tag = date === today ? '（今天）' : '';
    lines.push(`${date}${tag}  输入 ${fmt(total.in)} / 输出 ${fmt(total.out)} / 缓存 ${fmt(total.cached)} / 总 ${fmt(total.total)} tokens ｜ ${total.cost > 0 ? fmtCost(total.cost) : '¥0.00'}`);
    // v3.31.0（P1-8 修正）：与单日表 reportTxt / 区间表 reportRangeTxt **同口径**——本日含无公开价模型时
    //   明示合计偏低。此前 summary 是三个出口里唯一一个**既无告警、又直接打 ¥0.00** 的：
    //   "厂商没公布价、这笔钱算不出来"被读成"这天免费"，而 summary 恰恰是"快速看花了多少"的默认入口，
    //   误导性比明细表更强（明细表至少还有「无公开价」单元格可看）。
    //   措辞与 reportTxt 单日行**逐字一致**（只把日期换成 ${date}），不发明第三套口径；
    //   合计金额本身照常显示（与 reportTxt 合计行一致：合计只含已知部分，偏低由本行提示，不改写数字）。
    // v3.32.0（P1-1）：同上排除 cost>0（summary 是"今天花了多少"的默认入口，假告警在这里最伤人）
    const npNames = Object.keys(models).sort().filter((n) => models[n] && models[n].no_price && !(models[n].cost > 0));
    if (npNames.length) {
      lines.push(`⚠ 本日 ${npNames.length} 个模型无公开价（${npNames.join('、')}）`
        + `→ 上面的合计金额**偏低**，只含有价部分；厂商公布单价后补录并跑 recalc-day.js ${date} 可回算`);
    }
    // v3.31.0（缺陷B）：未收录模型同样告警——summary 是最容易被当成"今天花了多少"的默认入口，
    //   金额算不出来却打 ¥1.64（只含有价部分）而不说一句，比明细表更容易被读成完整金额。
    //   措辞与 reportTxt 单日行逐字一致，与 no_price 那条只差"未收录单价 / 把单价补进 pricing.json"。
    const upNames = Object.keys(models).sort().filter((n) => models[n] && models[n].unpriced && !(models[n].cost > 0));
    if (upNames.length) {
      lines.push(`⚠ 本日 ${upNames.length} 个模型未收录单价（${upNames.join('、')}）`
        + `→ 上面的合计金额**偏低**，只含有价部分；把单价补进 pricing.json 后跑 recalc-day.js ${date} 可回算`);
    }
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
  // v3.19.0（P7 核查结论）：下方 XML 由 **单引号字面量**（'...'）承载 —— 单引号内 $( ) 与反引号都不展开，
  // 且 escapeXml 已把 ' 转成 &apos;（无法越狱）。故模型名即使含 $ 或反引号也不构成注入；此处无需额外转义。
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
const CJK_WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
// v3.30.0（F-3）：⚠ 这类符号在 Windows 通知里按 **emoji 呈现**渲染，实际占位 ≈ 2 个汉字（4 半角单位），
//   而旧模型按 1 个汉字（2u）计 → **每出现一个 ⚠ 就低估 2u**。这不是理论问题，是实测踩中的坑：
//   用户 2026-10-02 截图里"有的弹窗有标签、有的没有"，与 toast 诊断日志逐条对账后发现——
//   日志里 5 条**全部**含「｜⚠价核验」，但其中 3 条（估宽 50~52u）在通知气泡里被**横向裁掉了行尾标签**。
//   OS 裁切发生在渲染层，代码完全无感 → 只有把"估宽"修到 ≥ 实际渲染宽，守卫才拦得住。
//   现把 emoji 呈现类字符按 4u 计；变体选择符（U+FE0E/FE0F）按 0u 计（它是零宽，旧模型误记 1u）。
// 注意：必须带 `u` 标志并用 \u{...} 写星平面码点——不加 `u` 时 `\u1F000` 会被 JS 拆成 `\u1F00` + `0`，
//   与后面的 `-` 拼成 `0-\u1FAF` 这种**吃掉整个 ASCII 区**的畸形区间（实测把行宽算成 2 倍）。
const EMOJI_WIDE_RE = /[\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}]/u;
const EMOJI_VS_RE = /[\uFE0E\uFE0F]/;
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    if (EMOJI_VS_RE.test(ch)) continue;                     // 变体选择符零宽
    if (EMOJI_WIDE_RE.test(ch)) { w += 4; continue; }       // emoji 呈现 ≈ 2 个汉字
    w += CJK_WIDE_RE.test(ch) ? 2 : 1;
  }
  return w;
}

// 行1 标题大字专用宽度：中文/全角按 2.5 计（半角 1）。v2.33 修正（2026-08-14 用户实测反馈）：
//   - v2.17 实测纯半角 47u 不换行、48u 换行 → 标题大字纯半角真实上限 ≈ 47u
//   - 本次含中文混排 46u（2:1 模型）实测溢出 → 反推标题大字下中文实际 ≈2.5 半角单位，
//     2:1 模型每中文字低估 0.5u，多字累积导致判定"放得下"实际已溢出
//   → 行1 必须用此保守模型，不能复用 dispWidth（那是正文小字 2:1 模型，行1/行2 极限本就不同）
// v3.31.0（P1-9 修正）：补 emoji 分支——v3.30.0 只修了 dispWidth（正文小字），行1 这个**独立宽度模型**
//   漏了同一个分支，于是 `｜⚠无公开价`、`⬆vX.Y.Z`、`⚠价库M/D` 里的 ⚠(U+26A0) / ⬆(U+2B06) 仍按 1u 计，
//   而 Windows 通知里它们按 **emoji 呈现**渲染 → 每出现一个低估 4u（标题模型应记 5u，见下）→
//   守卫放行、渲染层被系统裁掉行尾标签（与 v3.30.0 F-3 同一病症，行1 未根治）。
//   宽度取 5u 的推导（**不能照抄 dispWidth 的 4u**，那是另一把尺子）：
//     ① 本函数 CJK 记 2.5u，dispWidth 记 2u —— 依据见上方 v2.33 实测（纯半角 47u 不换行/48u 换行、
//        含中文混排 46u 溢出 → 反推标题大字下 1 汉字 ≈ 2.5 半角单位）；
//     ② dispWidth 里 emoji(4u) = 2 × CJK(2u)，即「1 个 emoji ≈ 2 个汉字」这一**实测比例**两把尺子共用；
//     ③ 按同一比例换算到本模型：emoji = 2 × 2.5 = **5u**（≈ 2 个标题汉字）。
//   方向安全性：只把估宽调**大** → 守卫更保守（更早缩模型名 / 更早丢行尾标签），**不会**放宽到溢出，
//   因此不存在「改完反而溢出」的风险。
//   复用上方 EMOJI_WIDE_RE / EMOJI_VS_RE（已带 `u` 标志并用 \u{} 写星平面——不加 `u` 时 \u1F000 会被拆成
//   \u1F00 + `0` 与 `-` 拼成吃掉整个 ASCII 区的畸形区间这个老坑，v3.30.0 已踩过一次）；
//   本函数原有的 CJK 正则是**不带 u 标志**的 BMP 范围，那一个是安全的，保持不动。
function dispWidthTitle(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    if (EMOJI_VS_RE.test(ch)) continue;                   // 变体选择符零宽（⚠️ = U+26A0 U+FE0F）
    if (EMOJI_WIDE_RE.test(ch)) { w += 5; continue; }     // 标题大字下 emoji ≈ 2 个汉字 = 5u
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
  if (!pricing) return '⚠价库'; // v3.24.0（弹窗专项）：价库整个没加载进来是最缺价的场景，原返回 '' 零告警
  if (pricing._shrink_note) return '⚠价库缩水'; // v3.18.3（F1）：损坏重建缩水告警进 toast，不只 stderr
  const ldb = pricing.local_db;
  if (!ldb) return '⚠价库缺失';
  if (ldb.built_at && ldb.built_at !== todayStr()) {
    const p = String(ldb.built_at).split('-');
    return `⚠价库${Number(p[1])}/${Number(p[2])}`;
  }
  return '';
}

// v3.19.1（N1）：峰谷时段解析失败 → toast 可见告警（对齐上方 dbStaleTag 的 ⚠价库 模式）。
// 背景：官方改文案导致解析失败时，v3.19.0 会把 peak_schedule 覆盖成空串，下游静默回落默认时段，
// 而默认时段恰好等于官方当前值 → 故障零可见性。现既不清空、又让用户看得见。
// 触发：① 本次刷新解析失败落盘的 deepseek_rules_error；② peak_schedule 为空串（历史遗留坏值）。
function peakRuleTag(pricing) {
  if (!pricing) return '';
  if (pricing.deepseek_rules_error) return '⚠时段';
  const r = pricing.deepseek_rules;
  if (r && typeof r === 'object' && !r.peak_schedule) return '⚠时段';
  return '';
}

// v3.29.0（A-8）：价格诊断告警链修复 —— refresh-prices.js 会往 pricing.json 落四类诊断字段，
//   但此前 token-tracker.js **只消费 last_refresh_error**，其余（_price_audit / last_refresh_note /
//   _ambig_warnings）全部只写不读，用户在弹窗里完全看不到。这里补上：toast 只挂一个**极短**标签
//   「⚠价核验」（行2 宽度敏感，TOAST_LINE_MAX_W=51，绝不能塞整段文本），详细告警走 stderr 落日志。
// 触发源（任一命中即标；字段类型容错，缺字段/类型异常都安全忽略）：
//   ① pricing._price_audit        —— refresh-prices.js 价格一致性自检 { at, warnings:[...] }，无告警即 delete
//   ② pricing._ambig_warnings     —— 模糊匹配歧义（纯字符串数组），无歧义即 delete
//   —— 两者都是"当前价库真实健康状态"的**结构化**字段，每次刷新重写、干净就删除 → 自愈、不会永久驻留。
//
// v3.30.0（F-1 修正）：A-8 原实现还消费了第三个触发源 `pricing.last_refresh_note`（"含 ⚠ 即挂"），
//   实测**把标签变成了常驻噪音**——该字段是"上次刷新的操作流水账"，历史 ⚠️ 条目会永远留在文本里
//   （本机 2026-10-01T17:53 写入的「⚠️模糊匹配歧义: kimi-k3 / glm-5.3-flash」到 10-02 仍在，
//   刷新前一直有效），于是**每一条**弹窗都挂「⚠价核验」。用户看到的正是：
//   「明明有价格，为什么又在报那个价核验？」——这不是误报某一次，是**永恒误报**。
//   这与 A-7 当初把 `_retired_locked` 刻意踢出 `_price_audit` 要躲的是**同一个坑**（永久性条目 = 永久噪音）。
//   现修正为两条：
//     ① **不再消费 last_refresh_note**（流水账不做 toast 触发源，只进 stderr 诊断）；
//     ② 且结构化告警**必须点名本轮弹窗涉及的模型**才挂标签——别的模型的歧义/价差（如上面两条
//        kimi-k3 / glm-5.3-flash）与本轮计价无关，不该污染每一条弹窗。
//   stderr 仍**全量**输出所有告警（含与本轮无关者），诊断能力不减。
let _priceAuditLogged = false; // 同轮可能经多条路径构建行2 → stderr 详情只打一轮，避免刷屏

// 本轮弹窗涉及的模型名集合（顶层模型 + 分模型明细的键；显示名与实际键可能不同，故匹配用宽松口径）
function roundModelNames(stat) {
  const s = new Set();
  const add = (n) => { const v = String(n == null ? '' : n).trim(); if (v) s.add(v); };
  if (stat && typeof stat === 'object') {
    add(stat.model); add(stat.modelMain);
    if (stat.models && typeof stat.models === 'object') for (const k of Object.keys(stat.models)) add(k);
  }
  return [...s];
}
// 告警条目形如 `<价库键>: 说明`（见 refresh-prices.js 的 warning 构造）→ 取冒号前做宽松匹配。
// 宽松口径：完全相同 / 互为子串 均算相关（覆盖「hy3」vs「hy3-preview」这类显示名与键名不一致）。
function warnMentionsModel(w, names) {
  const seg = String(w == null ? '' : w).split(/[:：]/)[0].trim().toLowerCase();
  if (!seg) return false;
  return names.some((n) => {
    const b = String(n).toLowerCase();
    return !!b && (seg === b || seg.indexOf(b) >= 0 || b.indexOf(seg) >= 0);
  });
}
function priceAuditTag(stat, pricing) {
  if (!pricing || typeof pricing !== 'object') return '';
  const audit = pricing._price_audit;
  const auditWarn = (audit && typeof audit === 'object' && Array.isArray(audit.warnings)) ? audit.warnings.filter(Boolean) : [];
  const ambigWarn = Array.isArray(pricing._ambig_warnings) ? pricing._ambig_warnings.filter(Boolean) : [];
  const all = [];
  for (const w of auditWarn) all.push({ kind: '价格一致性自检', text: w });
  for (const w of ambigWarn) all.push({ kind: '模糊匹配歧义', text: w });
  const names = roundModelNames(stat);
  const hit = names.length ? all.filter((it) => warnMentionsModel(it.text, names)) : [];
  if (!_priceAuditLogged && all.length) {
    _priceAuditLogged = true;
    // 全量告警走 stderr（诊断不减）；命中的额外标一行，便于对照"为什么这条弹窗挂了标签"
    const lines = all.map((it) => `[token-tracker]   - ${it.kind}: ${it.text}`);
    process.stderr.write(`[token-tracker] 价格库待人工核验项 ${all.length} 个${hit.length ? `（其中 ${hit.length} 个涉及本轮模型 → 弹窗已标注「⚠价核验」）` : '（均与本轮模型无关 → 弹窗不标注）'}：\n${lines.join('\n')}\n`);
  }
  return hit.length ? '⚠价核验' : '';
}

function periodNote(stat, pricing) {
  const base = periodPeakNote(stat, pricing);
  const tag = [dbStaleTag(pricing), peakRuleTag(pricing)].filter(Boolean).join(' ');
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
// v3.30.0（F-3 修正）：52 → 51。原注释自述"实测用户原行1 约 51u 即**占满**，52 为安全值"——
//   "占满"= 能完整显示的最后一格，不是"还有富余"；把 52 当"安全值"等于明知 51 已是极限还多放 1u。
//   （真正造成裁切的元凶是下方 dispWidth 对 ⚠ 的低估，已单独修正；这里只做 51→52 这一处收紧。）
const TOAST_LINE_MAX_W = 51; // 一行最大显示宽度单位（正文小字上限；51u = 实测"占满"，即极限值本身）
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

function toastLine1(stat, modelShort, period, balTxt, todayTxt, extraTag) {
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
  // v3.27.0：extraTag（如「｜⚠无公开价」）并入行1 —— 用户 2026-10-02 明确要求放行1：
  //   行2 已有「输入/输出/缓存/缓存命中/金额」五段，标注塞那里会把缓存百分比挤掉；
  //   行1 模型名右侧本来就有空位。标注同样受下面的超宽守卫保护（放不下就丢标注，绝不挤掉数据）。
  const periodTxt = period ? ` ${period}` : '';
  const tagTxt = extraTag ? String(extraTag) : '';
  const line1 = `${head}${periodTxt}${tagTxt}`;
  // v3.22.0：版本更新标记（`⬆vX.Y.Z`）——**只有「本机没配 UserPromptSubmit hook」的用户会出现**
  //   （updateTagForToast 内以 lastHookAt 判定；已配 hook 的永远走回答注入，这里恒为空串）。
  //   空间规则：**整个标记放得下才加**，因此绝不会触发下面的「缩略模型名」逻辑、绝不动 line2。
  //   放不下就整个丢弃——更新提示永远不许挤压真实数据。
  let line1Out = line1;
  try {
    const upTag = updateTagForToast();
    if (upTag) {
      const cand = `${line1} ｜${upTag}`;
      if (dispWidthTitle(cand) <= TOAST_ROW1_MAX_W) line1Out = cand;
    }
  } catch (e) { /* 标记失败不影响弹窗 */ }
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
  // v3.27.0：① periodTxt 与 tagTxt 一起算进「标注预算」（extraTag 与 period 同属要保住的标注）；
  //   ② 顺带修一个既有缺陷——旧写法在「head+标注其实放得下、只是被行1 的第三个元素（更新标记）
  //   顶超宽」时会掉进 fallback 把标注**整段丢掉**（实测：高峰标注 + ⚠无公开价 + 长模型名 =
  //   49.5u，本可缩名到 30.5u 放下，却输出成裸模型名）。现按「标注预算」统一缩名，不再误丢。
  if (dispWidthTitle(line1Out) > TOAST_ROW1_MAX_W) {
    const keep = periodTxt + tagTxt;
    const keepW = dispWidthTitle(keep);
    if (keep && TOAST_ROW1_MAX_W - keepW >= 8) {
      const budget = TOAST_ROW1_MAX_W - keepW;
      const headKeep = dispWidthTitle(head) > budget ? shrinkTitle(head, budget) : head;
      return `${headKeep}${keep}\n${line2}`;
    }
    const headFit = dispWidthTitle(head) > TOAST_ROW1_MAX_W ? shrinkTitle(head, TOAST_ROW1_MAX_W) : head;
    return `${headFit}\n${line2}`;
  }
  return `${line1Out}\n${line2}`;
}
// v3.27.0：本轮是否存在「厂商未公布按 token 单价」的模型（pricing_status:'unpublished'）。
//   行1 标记（noPriceTag1）与行2 金额省略（toastLine2）**共用这一判定**——两处口径分裂会出
//   「行1没标、金额也没显示」或反之的诡异组合。混合轮看全部模型（stat.models），旧形状看顶层 model。
function anyNoPublicPrice(stat, pricing) {
  if (!stat || !pricing || !pricing.models) return false;
  const isUnpub = (n) => {
    const m = pricing.models[n];
    return !!(m && m.pricing_status === 'unpublished');
  };
  if (stat.models && typeof stat.models === 'object') {
    for (const n of Object.keys(stat.models)) if (isUnpub(n)) return true;
  }
  return isUnpub(stat.model);
}
// v3.31.0（P1-7）：本轮是否有「已收录、但厂商未公布**缓存命中价**」的参与方。
//   与 unpublished 的区别至关重要：这类模型输入输出单价都是真的、钱也算得出来，
//   缺的只是 cached_price → calcCost(:2854) 把它按 0 计 → 缓存占比 ~97% 时金额偏低 45%~86%（审计 §六）。
//   旧代码对此**零提示**：用户看到的 ¥ 数字比真实值小一大截，却没有任何信号提示"这个数偏低"。
//   刻意**不**并入 anyNoPublicPrice —— 那会触发 toastLine2 的 hideCost（整段不显示金额），
//   把"有价但偏低"说成"算不出来"，反而丢信息。它只应该点亮行1 这一个标注。
function anyCachePriceUnknown(stat, pricing) {
  if (!stat || !pricing || !pricing.models) return false;
  const isUnk = (n) => {
    const m = pricing.models[n];
    return !!(m && m.cached_price_unknown === true && m.pricing_status !== 'unpublished');
  };
  if (stat.models && typeof stat.models === 'object') {
    for (const n of Object.keys(stat.models)) if (isUnk(n)) return true;
  }
  return isUnk(stat.model);
}
// v3.27.0：行1 用的标注文本（用户 2026-10-02 指定放行1 模型名右侧，那里有空位）。
//   有 token 消耗才标（空轮不标）；行1 放不下时由 toastLine1 的超宽守卫丢弃，绝不挤掉数据。
// v3.31.0：缓存价未知 → 降级挂「⚠缓存价未知」；两种缺陷同时存在时只显示更严重的「无公开价」
//   （那时金额整段算不出来，标注必须优先给最严重的一条）。
function noPriceTag1(stat, pricing) {
  if (anyNoPublicPrice(stat, pricing)) return ((stat && stat.in) || (stat && stat.out)) ? '｜⚠无公开价' : '';
  // 只有**真有缓存命中**时才会因缺缓存价而低估 —— 无缓存命中的轮标了纯属噪音
  if (anyCachePriceUnknown(stat, pricing)) return Number(stat && stat.cached) > 0 ? '｜⚠缓存价未知' : '';
  return '';
}
function toastLine2(stat, pricing) {
  // v3.30.0（F-2）：本函数内部对 stat 的取值风格本就是"半防御"（model 用 `stat &&`、in/out 直接点），
  //   一旦有别处传 null 就会在 `fmt(stat.in)` 上抛 TypeError。补一句归一，风格统一、零行为变化。
  stat = stat || {};
  const isLocal = isLocalModel(stat && stat.model);
  const anyNoPrice = anyNoPublicPrice(stat, pricing);
  // v3.26.0（KI-6 ⑧）：混合模型轮**分模型计价求和**（与账本/轮次明细同口径）——
  // 旧口径 = 全部 tokens 按 stat.model（子代理优先）单一价折算，混合轮金额失真且与账本对不上。
  // 规则：① models 明细存在 → 逐模型 calcCost（v3.31.0 起统一用**批级**峰谷时刻，与账本同口径）；
  //       ② 部分模型无价 → 金额 = 已知部分和 +「⚠未计价」标注（不再静默）；
  //       ③ 全部无价 / 无明细（旧 coalesce 残留的 agg）→ 回退旧口径（行为不变）；
  //       ④ 本地/云端混合 → 本地段免费跳过、金额 = 云端段；**纯本地**才显示「本地·免费」。
  let costVal = null;
  let partUnknown = false;
  const modelsObj = (stat && stat.models && typeof stat.models === 'object') ? stat.models : null;
  let cloudCount = 0;
  if (modelsObj && Object.keys(modelsObj).length > 0) {
    let sum = 0, known = 0, unknown = 0;
    // v3.31.0（峰谷口径统一 A）：**弹窗与账本必须用同一个峰谷判定时刻**。
    //   账本侧 recordUsage(:3312 附近) 对 byModel 里**每个模型**都传同一个批级 tsMs
    //   （= 主+子代理全部行取 max 的 peakTs，见 :3222-3298 的 bumpTs）；弹窗旧实现却按
    //   各模型**自己的** lastTs 判峰谷（:4080）→ 跨 12:00/18:00 峰谷边界的混合轮
    //   （含 DeepSeek 系，×2）会出现"同一批 token：弹窗 ¥2.00 / 账本 ¥4.00"，差整倍且零提示。
    //   修法：弹窗也用批级 ts（各模型 lastTs 的最大值 ≈ 账本 peakTs；两者仅在"批内最后一条
    //   是无 usage 行"的毫秒级场景可不同，时段判定不受影响）。单模型轮 max = 原值 → 零行为变化。
    let batchTs = 0;
    for (const b0 of Object.values(modelsObj)) {
      const t0 = Number(b0 && b0.lastTs);
      if (Number.isFinite(t0) && t0 > batchTs) batchTs = t0;
    }
    for (const [n, b] of Object.entries(modelsObj)) {
      if (!b || typeof b !== 'object') continue;
      if (isLocalModel(n)) continue; // 本地模型免费，不进计价也不算「未知」
      cloudCount++;
      const c = calcCost({ model: n, in: b.in || 0, out: b.out || 0, cached: b.cached || 0, lastTs: batchTs }, pricing);
      if (c != null) { sum += c; known++; } else unknown++;
    }
    if (cloudCount > 0) {
      if (known > 0) { costVal = sum; partUnknown = unknown > 0; }
      else { costVal = calcCost(stat, pricing); partUnknown = true; } // 云端全无价 → 回退旧口径并明示缺口
    } // cloudCount===0 → 全本地，costVal 保持 null（下方 allLocal 走「本地·免费」）
  } else {
    costVal = calcCost(stat, pricing);
  }
  const allLocal = isLocal && cloudCount === 0; // 顶层本地且无云端参与（顶层本地但混合云端 → 显示云端金额）
  // v3.27.0（用户 2026-10-02 明确要求，**标记挪到行1**）：本轮涉及无公开价模型时，
  //   **行2 整段不显示金额**——不显示 ¥0、也不显示「无公开价」字样（两个字比数字占位更多，
  //   而标注已移到行1 模型名右侧）。行2 已有「输入/输出/缓存/缓存命中/金额」五段，
  //   金额算不出来时直接省掉整段最干净，也就不会挤掉缓存百分比。
  //   有已知金额（混合轮里的有价部分）→ 照常显示，缺口由行1 的 ⚠无公开价 标注承担。
  const hideCost = !!anyNoPrice && !(costVal > 0);
  const cost = allLocal ? '本地·免费'
    : (hideCost ? '' : (fmtCost(costVal) || '未收录'));
  const input = (stat && stat.in) || 0;
  const cached = (stat && stat.cached) || 0;
  // 缓存占比精确到两位小数（如 99.12%）；无输入数据则不显示缓存段
  const ratioPct = input > 0 ? ((cached / input) * 100).toFixed(2) : null;
  const ratioTxt = ratioPct === null ? '' : `缓存${ratioPct}%`;
  // 金额段整段省略时，用「｜」只作为 ratio 与 cost 之间的分隔（两者都有才加），行尾不留孤竖线
  const parts2 = [`输入 ${fmt(stat.in)} / 输出 ${fmt(stat.out)}`];
  const segs = [];
  if (ratioTxt) segs.push(ratioTxt);
  if (cost) segs.push(cost);
  if (segs.length) parts2.push(segs.join('｜'));
  let line = parts2.join('｜');
  // v2.31：价格多源拉取全失败 → 提示「价⚠️」，表示费用按上次价格估算（refresh-prices.js 全源失败时写入 last_refresh_error）
  if (pricing && pricing.last_refresh_error) {
    line += '｜价⚠️';
  }
  // v2.59：DeepSeek 官方定价抓取失败（回落聚合源）→ 提示「官价⚠️」，表示 DeepSeek 系按本地/聚合源价估算
  if (pricing && pricing.deepseek_refresh_error) {
    line += '｜官价⚠️';
  }
  // v3.29.0（A-8）：价格诊断告警链修复——把 refresh-prices.js 已落盘的 _price_audit / _ambig_warnings
  //   变成用户可见提示。toast 只挂极短标签「⚠价核验」（详情见 priceAuditTag 的 stderr 输出），
  //   与上方 价⚠️ / 官价⚠️ 同位置、同模式，避免撑破行2。
  // v3.30.0（F-1）：触发源去掉 last_refresh_note（历史流水账 → 永久误报），且改为"只报本轮模型被点名的"。
  if (pricing) {
    // v3.30.0（F-1）：必须传 stat —— 标签只在本轮模型被点名的告警上挂（详见 priceAuditTag 注释）
    const auditTag = priceAuditTag(stat, pricing);
    if (auditTag) line += '｜' + auditTag;
  }
  // v3.24.0（级联②）：该模型在价库里找不到 → 金额显示「未收录」，但那不够醒目（报告实测：
  // 纯净环境无本地价库时 hy3 等子代理模型金额静默=0，用户毫无感知）。补「⚠未计价」标注，
  // 对齐 价⚠️/官价⚠️ 模式。只在确实有 token 消耗时标注（空轮不标）。
  // v3.26.0（KI-6 ⑧）：分模型计价时「部分模型无价」同样标注（partUnknown）——金额是部分和，必须明示缺口。
  // v3.29.0 修正：此块曾被**重复写了两遍**（v3.28.0 行2 布局重构时复制粘贴引入），弹窗实测出现
  //   `｜⚠未计价｜⚠未计价` 双标签。这里收敛为单块；selftest T18 已补「同一标签在行2 至多出现一次」断言。
  // v3.27.0：⚠未计价 = "我们没收录到价"；⚠无公开价 = "厂商根本没公布单价"——行动含义不同，必须能区分。
  //   **⚠无公开价 已挪到行1**（用户 2026-10-02 明确要求：行2 位置留给缓存百分比）。
  //   行2 只保留「金额算不出来」类标注：⚠未计价（账本/弹窗会缺金额）仍留行2。
  if ((pricing && !isLocal && costVal == null && ((stat && stat.in) || (stat && stat.out))) || partUnknown) {
    line += '｜⚠未计价';
  }
  // v3.24.0（级联①）：transcript 被平台压缩/重写导致水位线冻结 → 之后的消耗静默少计。
  // 旗标由 readTranscLinesFrom 落盘（24h 节流），这里让用户在弹窗里看得见。7 天后自动失效。
  try {
    const tf = JSON.parse(fs.readFileSync(TRANSC_TRUNCATED_FILE, 'utf-8'));
    if (tf && tf.at && Date.now() - tf.at < 7 * 24 * 3600 * 1000) {
      line += '｜⚠账缺';
    }
  } catch (e2) { /* 无旗标 = 正常 */ }
  // 宽度守卫（两级，**顺序即优先级**）。
  // v3.30.0（F-2 修正）：A-8/A-10 时期这里**顺序倒挂**——第一级先丢缓存占比（ratioTxt），第二级才丢标签；
  //   于是"为了给 ⚠价核验 腾位置，先把缓存命中百分比砍掉"成了默认行为。用户 2026-10-02 直接点破：
  //   「那个子代理下面的，又报价核验，又把那个缓存命中百分比也顶掉了」。
  //   而 v3.27.0 用户定版布局的原话是「行2 位置留给缓存百分比」（⚠无公开价 就是为此被挪到行1 的）
  //   → 缓存占比的优先级**高于**价格来源降级标签，现按此重排：
  //     第一级：丢价格降级标签（详情都在 stderr / 日志里，丢得起）
  //     第二级：仍放不下，才丢缓存占比
  //   ⚠未计价（金额缺失）/ ⚠账缺（token 少计）是「数据不可信」信号，**两级都不丢**。
  // 安全说明：'｜价⚠️' 与 '｜官价⚠️' **不会互相误伤**——`'｜官价⚠️'.indexOf('｜价⚠️') === -1`
  //   （「｜」后紧邻的是「官」而非「价」），故 replace 各丢各的，顺序无副作用。
  const TAG_DROP_ORDER = ['｜⚠价核验', '｜价⚠️', '｜官价⚠️'];
  for (const t of TAG_DROP_ORDER) {
    if (dispWidth(line) <= TOAST_LINE_MAX_W) break;
    line = line.replace(t, '');
  }
  if (dispWidth(line) > TOAST_LINE_MAX_W) {
    // v3.27.0：ratioTxt 现在不带尾随「｜」（金额段可能整体缺席），
    //   所以要多清一次「<ratio>｜」形式，以及清完后的行尾孤立「｜」。
    line = line.replace(ratioTxt + '｜', '').replace(ratioTxt, '');
    line = line.replace(/｜(?=｜)|｜$/g, '');
  }
  return line;
}

// v3.12：在 toast 第一行模型名后插入状态标注（异常轮用"子代理运行中"、补弹用"子代理"），
//   不改动 toastLine1 本体（保证正常轮/团队轮一字不变）。超宽时放弃标注，绝不超出 TOAST_ROW1_MAX_W。
function toastLineTagged(agg, pricing, tag) {
  if (!tag) return toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), balanceText(), todayUsageTxt(), noPriceTag1(agg, pricing));
  const mShort = shortModelName(agg, pricing);
  const base = toastLine1(agg, mShort, periodNote(agg, pricing), balanceText(), todayUsageTxt(), noPriceTag1(agg, pricing));
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
  // v3.18（2026-09-30）：key 不再拼进脚本字符串（会经 argv 出现在子进程命令行，进程列表/审计日志
  // 可读）——改经环境变量 WB_DS_KEY 传给子进程，命令行只剩 '-e' 与脚本（脚本内不含 key 原文）。
  const script = [
    '(async () => {',
    '  try {',
    `    const key = process.env.WB_DS_KEY || '';`,
    `    if (!key) { console.error('NO_KEY'); process.exit(5); }`,
    `    const res = await fetch('https://api.deepseek.com/user/balance', { headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + key } });`,
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
      env: Object.assign({}, process.env, { WB_DS_KEY: String(key) }),
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
  let isFreshQuery = false; // v3.40.0（A12）：本次是否**真的从网络拿到了**新余额
  if (typeof cache.total === 'number' && (now - (cache.time || 0)) < BALANCE_TTL_MS) {
    total = cache.total;                    // TTL 命中：沿用缓存，time 不刷新（本来就新鲜）
  } else {
    const r = queryBalance(key);
    if (r && typeof r.total === 'number' && Number.isFinite(r.total)) { total = r.total; isFreshQuery = true; }
    else if (typeof cache.total === 'number' && Number.isFinite(cache.total)) total = cache.total; // 失败降级，不因网络抖动闪没
  }
  if (total === null) return '';
  const last = cache.history.length ? cache.history[cache.history.length - 1].total : null;
  pushBalanceHistory(cache, now, total);
  // A12 附带修复：`typeof NaN === 'number'` 为真 → 接口返回非数字时 total=NaN 能通过全部校验 →
  //   弹窗显示「余额¥NaN」。这里显式挡住非有限值（NaN/Infinity 一律视为无效观测，不写缓存）。
  try {
    if (Number.isFinite(total)) {
      fs.writeFileSync(BALANCE_CACHE, JSON.stringify({
        // v3.40.0（plan-B A12）：**只有真查到**才把 time 刷新为 now。
        //   病根：失败降级用旧值时也写 `time: now` —— API 持续不可达 → 旧余额被反复"续命"，
        //   缓存永远读不到过期信号 → 弹窗显示的余额可能已陈旧数天而用户毫无察觉。
        //   isFreshQuery 为假（TTL 命中 / 网络失败降级）→ 保留旧 time，让 TTL 正常老化。
        time: isFreshQuery ? now : (cache.time || now),
        total, currency: cache.currency || 'CNY', history: cache.history,
      }));
    }
  } catch (e) { /* 缓存写失败不致命 */ }
  // 首次观测：只记录 baseline，不显示（给变化检测建立对比基准）
  if (last === null) return '';
  // 余额与上次不同（toFixed(2) 字符串比较，避免浮点相等判断）→ 账户在消耗 → 显示
  // v2.18: 恢复「¥」符号（实测行1 上限 47u，峰值场景 45u+1u=46u 仍有富余）
  return total.toFixed(2) !== last.toFixed(2) ? `余额¥${total.toFixed(2)}` : '';
  // ⚠️ 2026-09-28 曾一度改为"每轮都显示"，用户当天明确要求**保留变化检测**并说明理由：
  //   「变化还是留着，因为它无法判断你用的是 API 还是 WorkBuddy 自带的，**只有余额变动了才知道用的是 API**」
  //   → 故本逻辑维持原样：仅余额变化时显示。已回滚"恒定显示"。
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
    // v3.27.0：输入输出**同时为 0** = 厂商未公布按 token 价（匿名/订阅制模型在 OpenRouter 标价 $0，
    //   例如 Space Bunny、MiniMax-M3.1-Flash-Preview 均为订阅制无单价）。旧代码把 0 当合法价写进
    //   pricing.json → 弹窗显示 ¥<0.01（读起来像"几乎免费"）、账本记 cost:0 → 与"真的免费"不可区分，
    //   且当日合计被系统性低估而无任何提示（本项目最典型的静默失败）。改抛 NO_PUBLIC_PRICE，
    //   由 ensureNewModelPricing 落 pricing_status:'unpublished' 条目。
    "    if (pIn === 0 && pOut === 0) { console.error('NO_PUBLIC_PRICE'); process.exit(5); }",
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
    // v3.27.0：查到了但厂商未公布按 token 价（OpenRouter 标 $0 = 订阅制）→ 返回特殊标记，
    //   调用方据此落 pricing_status:'unpublished'，而不是当成"免费"或"查不到"。
    if (stderr.includes('NO_PUBLIC_PRICE')) return NO_PUBLIC_PRICE;
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
    // v3.27.0：与 OpenRouter 同款保护——输入输出同时为 0 = 未公布按 token 价（匿名/订阅制），不是免费。
    "    if (inP === 0 && outP === 0) { console.error('NO_PUBLIC_PRICE'); process.exit(5); }",
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
    if (stderr.includes('NO_PUBLIC_PRICE')) return NO_PUBLIC_PRICE; // v3.27.0：同 OpenRouter
    process.stderr.write(`[token-tracker] llmabacus 查价失败: ${stderr.slice(0, 150)}\n`);
    return undefined;
  }
}

// 把新模型补入 pricing.json（v2.31 区分国内外：region='CN' 直接人民币价；region='US' USD×汇率换算）
// 修复6：pricing 原子写（无锁，由调用方负责加锁）。写临时文件成功后 rename 覆盖，写失败保留原文件。
// v3.31.0（P1-11）：新增可选第二参 mergeKeys —— **锁内重新读盘**。
//   背景：本函数的调用点全都套在 PRICING_LOCK_FILE 里，但「加锁」与「不整份覆写」是两件事——
//   若把此刻内存里的整份 pricing 直接覆写磁盘，同一把锁释放后由他人（refresh-prices.js）
//   刚落盘的价格更新会被**整份吃掉**（写串行 ≠ 读改写安全）。addModelPrice(:4332) 早就有这层保护，
//   ensureNewModelPricing 的「国内外源均无」分支与 rememberNoPublicPrice 漏了同一层。
//   语义：传数组时以**磁盘**为准，只把 mergeKeys 列出的模型条目从 pricing 合并进磁盘版本；
//   磁盘读不出来（首次 / 损坏）才退回整份 pricing——与旧行为一致。
function savePricingAtomic(pricing, mergeKeys) {
  const tmp = PRICING + '.tmp';
  try {
    fs.mkdirSync(path.dirname(PRICING), { recursive: true });
    let out = pricing;
    if (Array.isArray(mergeKeys)) {
      let base = null;
      try { base = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { base = null; }
      if (base && base.models && typeof base.models === 'object') {
        // 磁盘侧的本地官方库残留同样剥掉，保持「合并条目不入库」的原约定
        const clean = stripLocalDbEntries(base);
        for (const k of mergeKeys) {
          const src = pricing && pricing.models ? pricing.models[k] : undefined;
          if (src && typeof src === 'object') clean.models[k] = src;
        }
        if (pricing && pricing.usd_cny_rate != null && clean.usd_cny_rate == null) clean.usd_cny_rate = pricing.usd_cny_rate;
        out = clean;
      }
    }
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    // v3.40.0（plan-B A6）：**覆盖前留一份上一版**。
    //   病根：原实现直接 rename 覆盖，写盘前无备份 → 自动补录一旦采到错价（模糊匹配单命中即采用，
    //   见 lookupCnPrice / refresh-prices 的 ambigAdd），**发现后只能人肉改文件**，没有回滚手段。
    //   与 backfill 的 `.bak-backfill-*` 有界保留同一做法：带时间戳归档、只留最近 3 份，避免线性堆积。
    //   任何失败一律静默 —— 备份是尽力而为的**附加保护**，绝不能因为它让写盘失败（写盘才是主目的）。
    try {
      if (fs.existsSync(PRICING)) {
        const dir = path.dirname(PRICING);
        const base = path.basename(PRICING);
        const stamp = path.join(dir, base + '.bak-autofill.' + Date.now());
        fs.copyFileSync(PRICING, stamp);
        const olds = fs.readdirSync(dir)
          .filter((f) => f.startsWith(base + '.bak-autofill.'))
          .sort(); // 文件名内嵌 13 位时间戳 → 字典序 == 时间序
        for (const f of olds.slice(0, Math.max(0, olds.length - 3))) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* silent-ok:清理 — 占用/权限：静默，下次再清 */ }
        }
      }
    } catch (e) { /* silent-ok:降级 — 备份失败不阻断计价写入（备份是尽力而为的附加保护） */ }
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
  const rate = Number(pricing.usd_cny_rate) > 0 ? pricing.usd_cny_rate : priceRefreshModule.DEFAULT_RATE; // v3.32.0（P1-3）：兜底汇率收敛到 refresh-prices 单一真源，不再复制字面量
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
  // v3.31.0（P1-7）：缓存价缺失 → **保留"按 0 计"的金额行为不变**，但必须把"这份数据不可信"写进价库。
  //   为什么仍然不补估价：v2.82.1 刻意删掉"输入价×10%"是因为各厂商实际缓存价 3%~25% 不等，
  //   瞎估等于用错价替换缺价——金额从"确定偏低"变成"看着可信但错了"，更难发现（当时的决策是对的）。
  //   不补价不等于可以不出声：本机缓存命中 ~97%，金额 ≈ 缓存价×缓存量（审计 §六）→
  //   cached_price 缺失时输入费近乎整段丢掉，**实测偏差 45%~86%，而用户此前看不到任何提示**。
  //   故这里落 cached_price_unknown:true —— 金额仍按 0 计（不凭空造价），但价库、账本、toast、报表
  //   四个出口都能据此显示"缓存价未知 → 合计偏低"。人工补上 cached_price 后本标记应一并删除，
  //   recalc-day.js 回算时才能算准（届时 addModelUsage 也会自动清掉账本上的影子标记）。
  if (!(typeof m.cached_price === 'number' && Number.isFinite(m.cached_price))) m.cached_price_unknown = true;
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
  // v3.39.0（plan-B A8）：**"无公开价"条目要能自愈**。原判据只要求 input_price 是 number ——
  //   unpublished 条目的 input_price 恒为 0（也是 number）→ 直接 return → **永不重新联网**，
  //   官方日后公布单价也不会自动回填。现在：unpublished 条目过了重查窗口（30 天）→ 放行去查。
  //   注意只放行"重查"，不改变"本轮记 0 元"的行为（计价链路不看这里）。
  const NO_PUBLIC_RECHECK_MS = 30 * 24 * 3600 * 1000;
  if (hit && typeof hit.m.input_price === 'number') {
    const isUnpub = hit.m.pricing_status === 'unpublished';
    const dueAt = Number(hit.m.unpublished_at || 0) + NO_PUBLIC_RECHECK_MS;
    if (!isUnpub || (dueAt > 0 && Date.now() >= dueAt)) return { status: 'none', note: '' };
    // unpublished 且未到窗口 → 走下面的重查流程；顺手记一次"本轮查过了"供排查
    hit.m.unpublished_checked_at = Date.now();
    process.stderr.write(`[token-tracker] ${stat.model} 为「无公开价」条目且已过重查窗口 → 本轮重新联网确认官方是否已公布单价\n`);
  }
  const name = lookupKeyOf(stat.model); // v3.18：路径型模型名（本地 .gguf 等）取末段做键，避免把本机绝对路径写进价格库
  const looked = loadLookedup().indexOf(name) >= 0;
  if (looked) {
    return { status: 'skipped', note: `⚠️ 新模型 ${stat.model} 价格已查过未收录，可搜官方定价页人工补录` };
  }

  // v2.31：先查国内源 llmabacus（人民币价，自动判断国内外），再回退 OpenRouter
  const cnRef = lookupCnPrice(stat.model);
  if (cnRef === NO_PUBLIC_PRICE) return rememberNoPublicPrice(pricing, stat.model);
  if (cnRef && typeof cnRef.id === 'string') {
    if (cnRef.priceCurrency === 'CNY') {
      // 国内模型：直接人民币价补录
      const ok = addModelPrice(pricing, stat.model, cnRef, 'CN');
      return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已从国内源(llmabacus·人民币)自动补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
    } else if (cnRef.priceCurrency === 'USD') {
      // 国外模型（llmabacus 明确标注 USD 价）→ 按国外定价 USD×汇率
      const usdRef = { id: cnRef.id, usdIn: cnRef.in, usdOut: cnRef.out };
      const ok = addModelPrice(pricing, stat.model, usdRef, 'US');
      return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已从 llmabacus(USD·国外定价)自动补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
    }
    // v3.40.0（plan-B A7）：**priceCurrency 缺失/为别的值时不得默认按 USD 处理**。
    //   病根：原实现是 `if (CNY) {...} else {...按 USD×7.2...}` —— 把「明确标了 USD」与
    //   「字段缺失 / null / 未知值」一视同仁。某国产模型在源上没标币种时，人民币价被 ×7.2
    //   写成人民币（**虚高约 7 倍**），且数值落在合理区间内 → 不触发任何告警。
    //   方向性判断：错补 7 倍是"多收钱"且无痕；漏补只是"本轮没自动补上"，下次刷新还能补（少记可恢复）。
    //   → 拒绝自动补录，改为把候选值挂出来供人工确认（人工补价路径见 SKILL.md「无公开价」章节）。
    process.stderr.write(`[token-tracker] ⚠ 新模型 ${stat.model}：国内源命中但 priceCurrency=`
      + `${JSON.stringify(cnRef.priceCurrency)}（既非 CNY 也非 USD）→ **拒绝自动折算**`
      + `（按 USD 处理会把人民币价乘汇率写成人民币，虚高数倍且无告警）；`
      + `候选值 ${cnRef.in}/${cnRef.out}，请人工核对币种后补录\n`);
    rememberLookedup(name);
    return { status: 'skipped', note: `⚠️ 新模型 ${stat.model} 币种未知，已跳过自动补录（避免错价 7 倍），请人工核对` };
  }
  if (cnRef === undefined) {
    process.stderr.write(`[token-tracker] 国内源 llmabacus 不可达，回退 OpenRouter 补录\n`);
  }

  const ref = lookupOrPrice(stat.model);
  if (ref === NO_PUBLIC_PRICE) return rememberNoPublicPrice(pricing, stat.model);
  if (ref === null) {
    // 国内外源均确认没有 → 记入已查列表，避免每次运行都联网
    // v3.18.1（N6）：已查列表改存本地 sidecar 文件（.lookedup-models.json，不入库）——
    // 旧实现写进 pricing.json，本机自定义模型名（fast-model 等）会随公开仓库分发
    rememberLookedup(name);
    // 修复6：加锁写，避免与 refresh-prices.js 并发覆盖。
    // v2.80：内存 pricing 含本地官方库合并条目（只属于 index.json），写盘前剥离，防止两源互相覆盖/膨胀
    // v3.31.0（P1-11）：本分支**没有改动任何价格条目**（已查列表已迁 sidecar，见上），
    //   过去却把整份内存 pricing 覆写回磁盘 → 抢锁释放后他人刚落盘的价格被吃掉 →
    //   下轮 findModel 又命中不到 → 再走一遍补录联网，**写放大 + 丢更新**。
    //   现改 savePricingAtomic(persist, [])：锁内以**磁盘**为准重新合并，空串数组 = 一个条目都不改写。
    const persist = stripLocalDbEntries(pricing);
    const lr = withFileLock(PRICING_LOCK_FILE, () => savePricingAtomic(persist, []), { ttl: 300000, retries: 50, retryDelay: 100 });
    if (lr.skipped) process.stderr.write(`[token-tracker] 已查列表写入跳过（被其他进程持锁）\n`);
    return { status: 'not-found', note: `⚠️ 新模型 ${stat.model} 国内外价格源均未收录，请搜索厂商官方定价页人工补录` };
  }
  if (ref === undefined) {
    return { status: 'error', note: `⚠️ 新模型 ${stat.model} 联网查价失败（国内外源均不可达），稍后自动重试` };
  }
  const ok = addModelPrice(pricing, stat.model, ref, 'US');
  return { status: ok ? 'added' : 'error', note: ok ? `ℹ️ 新模型 ${stat.model} 已自动补录估算价（OpenRouter·国外定价，待核验）；时段折扣策略（高峰/夜间）请用搜索技能核验补录` : `⚠️ 新模型 ${stat.model} 价格写入失败` };
}

// v3.27.0：查到了模型但**厂商未公布按 token 价**（匿名模型 / 订阅制模型，两个源都标 0）时调用。
//   落一个 pricing_status:'unpublished' 的 0 元条目——token 照常统计、金额记 0 供将来 recalc 回填，
//   但**所有展示层都必须能把它与"真的免费"区分开**（弹窗「⚠无公开价」、账本 no_price 标记、报表不显示 ¥0.00）。
//   为什么不直接不写条目：那样每轮都会重新联网查（lookupCnPrice→lookupOrPrice 双源 2 次子进程 fetch），
//   且弹窗只会显示笼统的「⚠未计价」——用户看不出"厂商根本没公布价"和"我们没收录到"的区别。
function rememberNoPublicPrice(pricing, modelName) {
  const key = lookupKeyOf(modelName);
  const m = pricing.models[key] || (pricing.models[key] = {
    name: String(modelName), input_price: 0, cached_price: null, output_price: 0,
    region: 'US', peak_multiplier: 1, pricing_status: 'unpublished',
    price_source: 'openrouter/llmabacus(标价 0 = 订阅制或未公布单价)',
    note: '厂商未公布按 token 单价（多为匿名/订阅制模型，聚合平台标价 $0）→ 金额记 0 待回填；'
      + '官方公布价格后把本条 input_price/output_price 补上并跑 recalc-day.js 即可回算历史',
  });
  m.pricing_status = 'unpublished'; // 已存在条目时确保标记（可能是旧版误写的 0 元条目）
  m.input_price = 0; m.output_price = 0;
  // v3.39.0（plan-B A8）：**"无公开价"不再永久锁死**。
  //   病根：`input_price: 0` 是 number → 下轮 `findModel` 精确命中直接返回 → **永不重新联网**，
  //   官方日后公布单价也不会自动回填。KI-7 写了"人工补价 + recalc-day 回算"的补救路径，
  //   但没写"自动链路永远不会自愈"这个事实。
  //   修法：记 `unpublished_at`（首次判定的时间戳）+ `unpublished_checked_at`（每次重查的时间）。
  //   `ensureNewModelPricing` 侧据此判"过了重查窗口就再查一次"（见该处 noPublicRecheckDue）。
  //   窗口取 30 天：官方公布价属低频事件，30 天粒度足够且不显著增加联网量。
  //   只补时间戳，**不动 input_price / pricing_status**（保持原有"0 = 未公布"语义不变）。
  if (!m.unpublished_at) m.unpublished_at = Date.now();
  // v3.31.0（P1-11）：本分支只改了这一个条目 → 锁内重读合并时**只合并它**，避免整份覆写
  //   吃掉 refresh-prices.js 并发落盘的其它价格（与 NOT_FOUND 分支同源，见 savePricingAtomic 注释）。
  const persist = stripLocalDbEntries(pricing);
  const lr = withFileLock(PRICING_LOCK_FILE, () => savePricingAtomic(persist, [key]), { ttl: 300000, retries: 50, retryDelay: 100 });
  if (lr.skipped) process.stderr.write(`[token-tracker] 无公开价标记写入跳过（被其他进程持锁）\n`);
  return {
    status: 'no-public-price',
    note: `⚠ 无公开价 新模型 ${modelName} 厂商未公布按 token 单价（多为匿名/订阅制模型）`
      + `→ 本轮 token 照记、金额暂记 0；官方公布价格后补录并跑 recalc-day.js 可回算历史`,
  };
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
// v3.19.1（N2）：watcher 单轮读取（导出供 selftest 验证"未变化跳过 IO"与增量等价性）。
// v3.19.0 把「解码 + JSON.parse」做成了增量，但 readTranscLinesFrom 第一行仍是 fs.readFileSync 全量
// 读入整个 transcript（本机 91MB），每 2 秒一次、watcher 最长活 3 小时 → Buffer 分配/GC 压力不必要。
// 现按 (size, mtimeMs) 双条件短路：两者都没动才跳过——压缩重写不改行数但必改 mtime，仍会被读到。
// state: { rowsCache, linesRead, lastSize, lastReadSize, lastReadMtime }
function watchReadStep(state, tsPath, st) {
  if (st.size === state.lastReadSize && st.mtimeMs === state.lastReadMtime) {
    return; // 文件未变化 → 沿用缓存，本轮不做任何文件 IO
  }
  state.lastReadSize = st.size;
  state.lastReadMtime = st.mtimeMs;
  if (st.size < state.lastSize) { state.rowsCache = []; state.linesRead = 0; } // 被截断/重写 → 缓存失效
  state.lastSize = st.size;
  try {
    const r = readTranscLinesFrom(tsPath, state.linesRead);
    if (r.totalLines < state.linesRead) {
      state.linesRead = 0;
      state.rowsCache = [];
    } else {
      if (r.rows && r.rows.length) state.rowsCache.push(...r.rows);
      state.linesRead = r.totalLines;
    }
  } catch (e) { /* 本轮读取失败：沿用缓存，下轮重试 */ }
}

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
  // v3.19.0（P3）：增量读——缓存已解析行，每轮只解析新落盘的部分。
  // 原先每 2 秒 readTranscLines() 全量读 + 全量 JSON.parse；本机存在 91MB transcript、watcher 最长活 3 小时，
  // 长会话期间持续高 CPU/IO（incrementalRecord 早已用 readTranscLinesFrom，watcher 没跟上）。
  const watchState = { rowsCache: [], linesRead: 0, lastSize: 0, lastReadSize: -1, lastReadMtime: -1 };
  let logOffset = 0, logCancelTs = 0;
  try { if (logFile && fs.existsSync(logFile)) logOffset = fs.statSync(logFile).size; } catch (e) {} // silent-ok:诊断 — 弹窗日志偏移探测失败即从 0 读
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
      watchReadStep(watchState, tsPath, st);
      const rows = watchState.rowsCache;
      const linesRead = watchState.linesRead;
      if (linesRead !== lastLines || st.mtimeMs !== lastMtime) {
        lastLines = linesRead; lastMtime = st.mtimeMs; lastChangeAt = Date.now();
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
            mergeEstIntoModels(aggC, estByModelC); // v3.26.0（⑧ 自审修正）：估算段并入分模型明细
          }
          const durC = Math.max(0, cancelTs - roundStart);
          aggC.durMs = aggC.durMs || durC;
          const modelC = shortModelName(aggC, pricing);
          ensureNewModelPricing(pricing, aggC);
          // v3.20.0：手动取消轮同样留明细（用户会关心"取消了但也烧了"）
          incrementalRecord(tsPath, sid, {
            sid, roundStart, durMs: aggC.durMs,
            model: aggC.modelMain || aggC.model, subModels: aggC.subModels,
            subCount: aggC.subCount, teamActive: aggC.teamActive === true,
            source: 'cancelled-round-watch', label: roundLabel(tsPath, roundStart),
          });
          writeProbe({ time: new Date().toISOString(), event: 'RoundWatch', ok: true, sid, sameRound: false,
            note: 'cancelled-round-watch', transcriptPath: tsPath, stat: aggC,
            line: lineFor(aggC, false, modelC), source: 'transcript-cancelled-round-watch',
            intrAt: new Date(cancelTs).toISOString() });
          showToast(
            toastLine1(aggC, modelC, '（手动取消）', balanceText(), todayUsageTxt(), noPriceTag1(aggC, pricing)),
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
            showToast(toastLine1(estStat, estModelShort, '（手动取消）（估算）', balanceText(), todayUsageTxt(), noPriceTag1(estStat, pricing)), toastLine2(estStat, pricing), 'cancelled-round-watch-est');
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

// ===== 版本更新检查（v3.21.0）=====
// 目的：装了旧版的用户除非手动去看仓库，否则不知道有新版本 → 每周匿名查一次 releases/latest，
//   有新版就向模型注入**一行极短提示**，由模型在回答末尾带一句。
//
// 通道决策（为什么不是 toast 弹窗）：
//   ① toast 第二行实测约 41u 已贴 42u 上限（`TOAST_ROW2_MAX_W`），再塞更新提示必然触发降级链
//      （丢余额 → 丢今日价 → 保底耗时）→ 等于**用本轮真实数据换一句提示**，不划算；
//   ② 独立再弹一条通知 → 会被 Windows「SmartOptOut」（长期未点开该应用通知 → 注册表写
//      `ShowBanner=0`）静默关掉，且阅后即焚；
//   ③ `--hook` 的 `additionalContext` 注入给模型 → 不占任何显示空间，载体是用户必然会看的回答本身，
//      且模型能把它说成人话。已有现成先例：新模型未收录提醒走的正是这条通道。
//
// 前提（必须知晓）：**帮不了「已装旧版」的存量用户**——检查逻辑在被安装的那份代码里，
//   旧版没有它，只能靠 README / 发布页。本功能只对「第一个带检查的版本」之后的分发生效。
//
// 不做全自动更新：安装方式是「拷目录」，自动覆盖会动用户文件，可能抹掉 `local-config.json` /
//   本机改动 → 只提示，升级动作交给用户（步骤见 SKILL.md）。
const SKILL_VERSION = '3.40.0'; // 单一真源：本常量（selftest 会断言它与 manifest.yaml / README 徽章 / CHANGELOG 一致）
const UPDATE_CHECK_FILE = path.join(__dirname, '.update-check.json');
const UPDATE_REPO = 'abc1317679842-ui/workbuddy-token-tracker';
const UPDATE_INTERVAL_MS = 7 * 24 * 3600 * 1000;            // 检查周期：7 天
const UPDATE_BACKOFF_MS = [3600 * 1000, 6 * 3600 * 1000, 24 * 3600 * 1000]; // 失败退避 1h / 6h / 1d
const UPDATE_MAX_FAILS = 3;                                  // 连败 3 次 → 本周期内不再重试
const UPDATE_MAX_NOTIFY = 2;                                 // 同一新版本最多提示 2 次（避免反复打扰）
const UPDATE_NOTIFY_GAP_MS = 24 * 3600 * 1000;               // 两次提示至少间隔 24h
const HOOK_IDLE_MS = 3 * 24 * 3600 * 1000;                   // v3.22.0：hook 多久没动静就认为「没配 hook」→ 走 toast 兜底

// 版本号**数值**比较：a>b→1，a<b→-1，相等→0。
// ⚠️ 绝不能直接字符串比较——`'3.9.0' > '3.10.0'` 会判成 true（错）。
// 严格性：任一侧不是纯 `数字(.数字)*` 形状（如 `release-2026` / `junk` / 空）→ 一律返回 0（视为"无法确定"），
//   保证**绝不因为畸形 tag 误报「有新版」**；缺段按 0 补（`3.21` == `3.21.0`）。
function cmpVersion(a, b) {
  const parse = (s) => {
    const t = String(s == null ? '' : s).trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(t)) return null;
    return t.split('.').map((x) => parseInt(x, 10));
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return 0;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function loadUpdateState() {
  try {
    const j = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8'));
    if (j && typeof j === 'object') return j;
  } catch (e) { /* 缺失/损坏 → 空状态（下次重新查） */ }
  return {};
}

function saveUpdateState(s) {
  try { fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(s, null, 2) + '\n'); }
  catch (e) { /* 写失败只影响下次判断，不影响本轮输出 */ }
}

// 同步子进程匿名查询「最新版本」（沿用 queryBalance 的子进程模式：主流程是同步的）。
// v3.22.0：**同时查两个端点，取版本号较大者**——
//   ① `releases/latest`（正式发布的最新 release）；② `git/matching-refs/tags/v`（全部 tag）。
//   为什么必须两个都查：只查 ① 时，若某次「只打了 tag 没发 release」（或顺序颠倒），
//   检测结果就与事实不一致 → **漏报**；只查 ② 则会把握手用的 prerelease 也算进来。
//   两个结果取 max 是「宁可早报、不可漏报」的取向（本项目不使用 prerelease，故无副作用）。
// 返回 `vX.Y.Z` 形态字符串；任一成功即返回，两个都失败返回 null——不抛错、不写 stderr、不污染 stdout。
// 注意：不携带任何密钥、不发本地数据；请求头只声明 Accept 与 User-Agent（GitHub 要求 UA）。
function queryLatestTag(timeoutMs) {
  const script = [
    '(async () => {',
    `  const H = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'workbuddy-token-tracker' };`,
    `  const B = 'https://api.github.com/repos/${UPDATE_REPO}';`,
    '  const parse = (s) => { const t = String(s == null ? "" : s).trim().replace(/^v/i, ""); if (!/^\\d+(\\.\\d+)*$/.test(t)) return null; return t.split(".").map((x) => parseInt(x, 10)); };',
    '  const cmp = (a, b) => { const pa = parse(a), pb = parse(b); if (!pa || !pb) return 0;',
    '    const n = Math.max(pa.length, pb.length); for (let i = 0; i < n; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x > y) return 1; if (x < y) return -1; } return 0; };',
    '  const tags = [];',
    '  try {',
    "    const r1 = await fetch(B + '/releases/latest', { headers: H });",
    "    if (r1.ok) { const j = await r1.json(); if (j && j.tag_name) tags.push(String(j.tag_name)); }",
    '  } catch (e) { /* 单端点失败不影响另一个 */ }',
    '  try {',
    "    const r2 = await fetch(B + '/git/matching-refs/tags/v', { headers: H });",
    "    if (r2.ok) { const a = await r2.json(); if (Array.isArray(a)) for (const x of a) { const n = String((x && x.ref) || '').split('/').pop(); if (n) tags.push(n); } }",
    '  } catch (e) { /* 同上 */ }',
    '  if (!tags.length) { console.error("NO_TAG"); process.exit(3); }',
    '  let best = tags[0];',
    '  for (const t of tags) if (cmp(t, best) > 0) best = t;',
    '  console.log(String(best));',
    '})();',
  ].join('\n');
  try {
    const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
      timeout: timeoutMs || 5000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true,
    });
    const lines = String(out).trim().split('\n');
    return (lines[lines.length - 1] || '').trim() || null;
  } catch (e) { return null; }
}

// 到点就查一次（7 天闸门 + 失败退避）。只改状态、不产生任何文案，hook / Stop 两条通道共用。
// 返回 true = 本次真的发起了查询（无论成败）。
function maybeFetchLatest(st, now) {
  const due = !st.lastCheckAt || (now - Number(st.lastCheckAt) >= UPDATE_INTERVAL_MS);
  const backoffOk = !st.nextRetryAt || now >= Number(st.nextRetryAt);
  if (!due || !backoffOk) return false;
  const tag = queryLatestTag(5000);
  if (tag) {
    st.latestVersion = String(tag).replace(/^v/i, '');
    st.lastCheckAt = now; st.failCount = 0; st.nextRetryAt = 0;
  } else {
    // 失败静默：不打扰用户，只记退避（1h → 6h → 1d；连败 3 次本周期内不再试）
    const fc = (Number(st.failCount) || 0) + 1;
    st.failCount = fc;
    st.nextRetryAt = now + (fc >= UPDATE_MAX_FAILS
      ? UPDATE_INTERVAL_MS
      : UPDATE_BACKOFF_MS[Math.min(fc - 1, UPDATE_BACKOFF_MS.length - 1)]);
    if (!st.lastCheckAt) st.lastCheckAt = now; // 首次即失败也要落时间，避免每轮重试
  }
  return true;
}

// 提示节流闸门（两条通道共用同一套计数）：命中则"消费"一次并返回 true。
// 规则：同一版本最多 UPDATE_MAX_NOTIFY 次、两次之间至少隔 UPDATE_NOTIFY_GAP_MS。
function claimNotify(st, latest, now) {
  if (!latest || cmpVersion(latest, SKILL_VERSION) <= 0) return false;
  const same = st.notifiedVersion === latest;
  const cnt = same ? (Number(st.notifyCount) || 0) : 0;
  const lastAt = same ? (Number(st.lastNotifyAt) || 0) : 0;
  if (cnt >= UPDATE_MAX_NOTIFY) return false;
  if (same && lastAt && now - lastAt < UPDATE_NOTIFY_GAP_MS) return false;
  st.notifiedVersion = latest; st.notifyCount = cnt + 1; st.lastNotifyAt = now;
  return true;
}

// UserPromptSubmit hook 是否在跑：`lastHookAt` 每次 --hook 都会刷新。
// 超过 HOOK_IDLE_MS 没刷新（或从未写过）= 该用户没配 hook → 注入通道不可达，改走 toast 兜底。
function hookIdle(now, st) {
  const t = Number(st && st.lastHookAt) || 0;
  return !t || now - t >= HOOK_IDLE_MS;
}

// 版本更新提示（**仅 `--hook` 调用**）：命中则返回一行极短注入文案，否则返回 ''。
// 注入文案刻意**不含任何升级步骤**（升级方法只写在 SKILL.md），也不含任何用户数据。
function updateNotice(nowMs) {
  try {
    if (!(ENABLE_NETWORK && ENABLE_UPDATE_CHECK)) return '';
    const now = nowMs || Date.now();
    const st = loadUpdateState();
    st.lastHookAt = now;               // v3.22.0：标记「hook 通道活着」→ Stop 端据此决定是否兜底
    maybeFetchLatest(st, now);
    saveUpdateState(st);               // 无论是否到检查点，都要把 lastHookAt 落盘
    if (!claimNotify(st, st.latestVersion || '', now)) return '';
    saveUpdateState(st);
    return `[技能更新] 有新版 v${st.latestVersion}，回复末尾提一句即可，勿展开`;
  } catch (e) { return ''; } // 任何异常都不该影响记账/注入主流程
}

// toast 兜底标记（v3.22.0）：**只给「没配 UserPromptSubmit hook」的用户用**，返回 `⬆vX.Y.Z` 或 ''。
// 每个进程只计算一次（模块级缓存）——一次 Stop 可能格式化多次 toastLine1，不能重复消费计数。
let gUpTag = null;
function updateTagForToast(nowMs) {
  if (gUpTag !== null) return gUpTag;
  gUpTag = '';
  try {
    if (!(ENABLE_NETWORK && ENABLE_UPDATE_CHECK)) return gUpTag;
    const now = nowMs || Date.now();
    const st = loadUpdateState();
    if (!hookIdle(now, st)) return gUpTag; // hook 在跑 → 由回答里提示，toast 绝不打扰
    if (!claimNotify(st, st.latestVersion || '', now)) return gUpTag;
    saveUpdateState(st);
    gUpTag = `⬆v${st.latestVersion}`;
  } catch (e) { /* 标记失败不影响弹窗主流程 */ }
  return gUpTag;
}

// Stop 端预检查（v3.22.0）：仅在「hook 通道不可达」时替它查一次，否则纯浪费。
// 调用点在 main() 最开头（asStop 分支）——**在弹窗之前**，这样同一轮的弹窗就能带上标记。
function maybeFetchLatestForStop(nowMs) {
  try {
    if (!(ENABLE_NETWORK && ENABLE_UPDATE_CHECK)) return;
    const now = nowMs || Date.now();
    const st = loadUpdateState();
    if (!hookIdle(now, st)) return; // hook 在跑：检查由 hook 端负责
    if (maybeFetchLatest(st, now)) saveUpdateState(st);
  } catch (e) { /* 预检查失败静默 */ }
}

function main() {
  const asHook = process.argv.includes('--hook');
  const asStop = process.argv.includes('--stop');
  // v3.22.0：版本更新提示**在 main() 最开头算一次并缓存**，追加动作下沉到 out()。
  //   为什么提前：v3.21.0 挂在两个 out() 调用点上，被 --hook 的 3 条早退分支绕过
  //   （`trace 文件尚未完成写入` / 手动取消轮补弹 / …）→ 命中这些分支的那一轮**收不到提示**。
  //   下沉到 out() 之后，只要这一轮有任何 hook 输出就必然带上，**结构上不可能被 return 绕过**。
  //   代价：早退分支也会触发一次检查（7 天一次、实测约 1s），可接受。
  const upNote = asHook ? updateNotice() : '';
  // v3.22.0：Stop 端兜底预检查——只给「没配 UserPromptSubmit hook」的用户跑（hookIdle 判定），
  //   放在**弹窗之前**，这样同一轮的弹窗就能带上 `⬆vX.Y.Z` 标记（不必等下一轮）。
  if (asStop) maybeFetchLatestForStop();
  // v2.39：--report [all|<date>] —— 打印每日账本（今天分模型明细+合计；历史天同样明细+合计）。
  // v2.39.1：--report summary [all|<date>] —— 只输出总合计（一行/天），让助手/用户只读最下面那行总数。
  // 纯文本输出，不影响 hooks 流程；无参=今天，all=全部天，也可指定日期。
  // v3.33.0（第四轮审计 P1-3）：--doctor 只读体检（见 doctorTxt 注释）。放在 --report 之前，
  //   因为它**不**参与 prune/网络/刷新任何一条链路——体检命令必须零副作用。
  if (process.argv.includes('--doctor')) {
    process.stdout.write(doctorTxt() + '\n');
    return;
  }
  if (process.argv.includes('--report')) {
    // v3.33.0（第四轮审计 A7 治本）：轮次明细保留期清理**下沉到 --report 统一入口**。
    //   病根：`ROUNDS_KEEP_MONTHS` 的定义处注释写的是"--report 运行时顺带清理"（v3.20.0 的原意），
    //   但实现只在 forecast / 区间 / --csv 三个**后来新增**的子分支里各插了一次，
    //   最常用的 `--report`（今天）与 `--report summary` 反而**从不触发** → 文档意图与实现不符，
    //   且"最常跑的入口不清、偶尔跑的入口才清"完全反了。三处重复调用一并删除，改为入口一次。
    pruneRoundFiles();
    // v3.34.0（A2·第五轮审计 P1）：exports/ 与 rounds/ 同病——注释承诺 / 实现缺失。
    //   挂在**同一个入口**：无论是 `--report`、`--report all`、`--report --csv` 还是 forecast，都会清。
    //   （清理发生在本次导出**之前**，刚写出来的 CSV 不会被自己删掉。）
    pruneExports();
    const ri = process.argv.indexOf('--report');
    const rest = process.argv.slice(ri + 1);
    const wantCsv = rest.includes('--csv');           // v3.20.0：CSV 导出血开关
    const pos = rest.filter((a) => !a.startsWith('--')); // 位置参数（剥掉 --csv）
    const rArg = pos[0] || '';

    // v3.20.0：--report forecast —— 纯 token 外推（不含金额，理由见 reportForecastTxt 注释）
    if (rArg === 'forecast') {
      process.stdout.write(reportForecastTxt() + '\n');
      return;
    }
    // v3.20.0：区间模式（week / month / <起>..<止>）—— 全新分支，不影响下方既有四个入口
    const range = parseReportRange(rArg);
    if (range) {
      process.stdout.write((wantCsv ? exportReportCsv(range) : reportRangeTxt(range.from, range.to)) + '\n');
      return;
    }
    // v3.33.0（B 系列）：`--report summary [all|<日期>] --csv` —— 此前落到下方 else 分支报
    //   「无法识别的参数：summary」（把合法参数判成非法）。注意 summary 的第二个位置参数是
    //   "all / 日期"，故这里取 pos[1]（下方通用分支只认 pos[0]）。
    if (wantCsv && (rArg === 'summary' || rArg === 'totals')) { // totals 是同一入口的别名，行为必须一致
      process.stdout.write(exportSummaryCsv(pos[1] || '') + '\n');
      return;
    }
    // v3.20.0：--csv 也可用于既有写法（今天 / all / 指定日期）—— 只在带 --csv 时介入，不带则完全走原逻辑
    if (wantCsv) {
      const d0 = loadDailyUsage();
      const allDates0 = Object.keys(d0).sort();
      let from = todayStr(), to = todayStr(), label = 'today';
      if (rArg === 'all') { if (!allDates0.length) { process.stdout.write('账本为空（暂无可导出数据）\n'); return; } from = allDates0[0]; label = 'all'; }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(rArg)) { from = rArg; to = rArg; label = rArg; }
      // v3.33.0：补全可用参数清单——原文案漏列了同属合法的 `summary`（以及它的别名 `totals`），
      //   于是 `--report summary --csv` 的报错里"可用"列表本身就不完整，把人往错方向带。
      else if (rArg) { process.stdout.write(`无法识别的参数：${rArg}（可用：week / month / <起>..<止> / all / <日期> / summary [all|<日期>] / forecast）\n`); return; }
      process.stdout.write(exportReportCsv({ from, to, label }) + '\n');
      return;
    }
    if (rArg === 'summary' || rArg === 'totals') {
      process.stdout.write(reportSummaryTxt(pos[1] || '') + '\n');
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
    // WATCH_LOCK_TTL 5min（v3.23.2 从 30min 收紧）：这是「owner 崩溃后死锁」的漏弹上限。
    // 30min 的代价大于收益——owner 崩溃后 30min 内所有 Stop 都不弹（KI-2）；
    // 收紧到 5min 后误接管风险仅限「新 watcher 比旧 owner 晚启动且旧 owner 仍在跑」的场景，
    // 而接管条件本来就保守（ESRCH 判死才动 + 原子 wx 建锁），误接管最坏结果是多弹一次，比漏弹 25 分钟好。
    // 不做「锁里写进程启动时间对比」：node 无跨进程查启动时间的纯 API，Windows 上只能 PowerShell/wmic——沙箱禁。
    const WATCH_LOCK_TTL = 5 * 60 * 1000; // 锁失效时间（v3.23.2: 30min → 5min）
    // 启动即拿锁：R3（2026-08-23）stale lock 接管 + R4（2026-08-23）原子 acquire 消除 TOCTOU。
    // 旧逻辑只查 at<TTL 从不验证 pid 存活：残留锁 owner 已死 → 新 watcher 误判锁有效 → watchStarts=0
    // 漏弹（B 类 Missing，repro_r3_lock.js 已确认）。且仅 readFileSync→writeFileSync 非原子 → 并发
    // TOCTOU 双启动（R4，前序 S4 starts=2 + repro_r4_logic.js 确定性临界窗）。
    // 修复：open('wx') 原子建锁；EEXIST 时评估锁有效性（pid 探活区分"可确认死亡/无法确认"），
    // 仅可确认死亡或 TTL 过期才安全接管；释放只删自己持有的锁（校验 pid===自己）。
    const WATCH_LOCK_HB_MS = 15 * 1000; // v3.38.0：心跳判死阈值（3s 一跳，15s 未刷新即判 owner 已死）
    const lockPath = coalescePath(fSid) + '.lock';
    let gotLock = false;
    const myPid = process.pid;
    // v3.38.0（C3②）：锁内容加 `hb:1` 标记（本版本起的锁是"心跳锁"）。三处建锁统一走这里。
    const writeLockSync = (fd) => { fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid, hb: 1 })); };
    const tryCreateLock = () => {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        writeLockSync(fd);
        fs.closeSync(fd);
        return true;
      } catch (e) { return false; }
    };
    // v3.38.0（C3②）：**每轮 poll 刷新 at（心跳）** —— 让"owner 是否还活着"不再依赖 pid 探活。
    //   只刷自己持有的锁（校验 pid===自己）；刷新失败不致命，下一轮再刷。
    const touchWatchLock = () => {
      if (!gotLock) return;
      try {
        const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        if (!o || o.pid !== myPid) return;
        fs.writeFileSync(lockPath, JSON.stringify({ at: Date.now(), pid: myPid, hb: 1 }));
      } catch (e) { /* 心跳刷新失败：不抛，下一轮重试 */ }
    };
    const acquireWatchLock = () => {
      try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (e) {} // silent-ok:清理 — 建锁目录；真失败会在随后的建锁处报错
      // 先尝试原子建锁（R4 核心）：不存在才创建，EEXIST 表示已有人持有
      try {
        const fd = fs.openSync(lockPath, 'wx');
        writeLockSync(fd);
        fs.closeSync(fd);
        return true; // 原子获取成功
      } catch (e) {
        if (e.code !== 'EEXIST') return false; // 其他 IO 错误：退化为无锁（不抢，行为同旧版）
      }
      // 已存在锁 → 评估有效性（R3）
      let mine = null;
      try { mine = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch (e) { mine = null; }
      // v3.38.0（C3②）：**心跳优先判定**（原 pid 探活在 Windows 上必踩 PID 复用 → 永久孤儿锁）。
      //   实证：`.coalesce-907e5d21….lock` 至今残留，pid 18620 已被 cmd 进程复用 → `process.kill(pid,0)`
      //   误判存活、TTL 分支也拒绝接管 → 该 sid **永久失去 watcher**（这正是 124 秒延迟的放大器）。
      //   规则（只对带 hb:1 的新锁生效；旧格式锁走下方原逻辑，行为不变）：
      //     心跳新鲜（<15s） → owner 一定在跑 → 不抢（交给它弹）；
      //     心跳停 ≥15s     → owner 已死/被宿主收割/卡死 → **立即接管**（不看 pid，15 秒内自愈）。
      //   pid 复用不再影响判定：心跳是 owner 自己写的证据，与 pid 是否被无关进程占用无关。
      if (mine && mine.hb === 1 && Number.isFinite(Number(mine.at))) {
        if ((Date.now() - Number(mine.at)) < WATCH_LOCK_HB_MS) return false; // owner 在跑 → 保持互斥
        try { fs.unlinkSync(lockPath); } catch (e) {} // silent-ok:清理 — 心跳已停，接管
        return tryCreateLock();
      }
      const fresh = mine && (Date.now() - (mine.at || 0) < WATCH_LOCK_TTL);
      if (!fresh) {
        // v3.24.0（级联⑩）：TTL 过期分支**补 pid 探活** —— 原先不看 pid 直接抢锁，而 v3.23.2 把
        // TTL 30min→5min 后这个洞被放大 6 倍：owner 是**活着的长任务 watcher**（运行 >5min）时
        // 新 Stop 会删它的锁另起 watcher → 双 watcher 双弹窗。
        // 正确语义：owner 活着 → 它负责本会话的弹窗，不抢（不是漏弹）；owner 死了 → 才接管。
        // 与下方"ESRCH 判死才动"同一口径（EPERM 视为存活，保守）。
        const pid0 = mine && Number(mine.pid);
        if (pid0 && pid0 > 0 && Number.isFinite(pid0)) {
          let alive0 = false;
          try { process.kill(pid0, 0); alive0 = true; } catch (e0) { alive0 = e0.code !== 'ESRCH'; }
          if (alive0) return false; // owner 仍在跑（锁只是超时）→ 交给它
        }
        // TTL 过期且 owner 已死（或无 pid）→ 锁失效，安全接管：删旧锁后重新原子建锁
        try { fs.unlinkSync(lockPath); } catch (e) {} // silent-ok:清理 — 释放锁；未持有/已被清都会抛
        return tryCreateLock(); // v3.38.0：新锁带 hb:1，此后本机 watcher 锁均为心跳锁
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
      try { fs.unlinkSync(lockPath); } catch (e) {} // silent-ok:清理 — 释放锁；同上
      return tryCreateLock(); // v3.38.0：同上（仅旧格式锁残留时才会走到这里）
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
      if (gotLock) { try { const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); if (o && o.pid === myPid) fs.unlinkSync(lockPath); } catch (e) {} } // silent-ok:清理 — 接管死锁时清理（内容已不可解析即直接删）
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
    let lastTailRaw = ''; // v2.59/P0-1：上一次 poll 的 transcript 原始末行，用于识别"正在改写中"的 transient unknown

    let toastReason = null;     // v2.61/debug：触发弹窗的原因（break 时赋值，用于去重日志）
    let lastPollSnapshot = null; // v2.61/debug：最近一次 poll 的状态快照，供 idle-timeout 兜底日志使用
    while (Date.now() - lastActiveAt < WATCH_MAX_MS) {   // 空闲超时：主模型持续活跃则永不退出、绝不弹
      // v3.38.0（C3②）：每轮轮询刷新锁心跳（3s/跳，远快于 15s 判死阈值）。
      //   作用：外部（下一个 Stop / startWatcherVerified）只看锁里 at 的新鲜度即可确认本 watcher 还活着，
      //   不再依赖 process.kill(pid,0) —— 那是 PID 复用误判存活、产生永久孤儿锁的根因。
      touchWatchLock();
      // v3.19.3：原 compactionMode（v2.62）+ compressionPending（v2.70）状态机已整体删除。
      // 全量日志复核：该判定在生产环境从未生效过一次（compactionMode=true 0 次、
      // compression-omen/resumed/timeout 各 0 次、185 次 flush-watch 启动快照命中标记 0 次），
      // 且压缩标记在 Stop 时刻早已滑出末尾 30 行窗口。压缩期噪音改由 Stop 端 no-token 分支
      // 用 freshCompactionMarker() 单点豁免，详见该函数注释。
      const currentStats = getTranscriptStats(tsPath);
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
      const pendingSubRaw = subagentPending(tsPath);
      // v3.38.0：子代理文件若**已全部落定**（末行终止 / incomplete 但已停写 ≥20s），
      //   就否决 pending 的**假非空**——pending 靠"spawn 名 vs 结束通知"匹配，而 22 次 Agent 调用
      //   无 name 字段时会抓出噪声名（实测 ["subagent","schema"]），且非团队子代理不发
      //   teammate-message 通知 → ended 恒空 → pending 恒非空 → 永远走不到收口。
      //   文件落盘状态是更权威的证据。仍保留 pendingSubRaw 供 deadTeam 判定使用（那里要的是"真未完成"）。
      const subsSettled = subagentsAllSettled(tsPath, info0.roundStart || 0, SUBAGENT_IDLE_MS);
      const pendingSub = subsSettled ? [] : pendingSubRaw;
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
        tailFingerprint: tailFingerprint(tsPath), // v3.18（M14）：原 readTailRaw().slice(0,80) 存原文，改指纹
        lastTailFingerprint: fpOfStr(lastTailRaw), // v3.18（M14）：原 lastTailRaw.slice(0,80) 存原文，改指纹
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
          // v3.38.0：改用「文件是否已全部落定」替代单纯 mtime 活跃窗。
          //   旧判据 hasSubagentsRecentlyActive(20s) 只看"最近有没有写过"——一个**已经跑完**的子代理
          //   文件，只要末次写入落在 20s 内就被判"还在写"，白白空等 20s；本次 124 秒的延迟有一半来自这类空等。
          //   subagentsAllSettled 看末行状态：终止态直接算落定（不用等）；incomplete 才要求停写 ≥20s。
          //   收口前**重新计算一次**（3 秒轮询内可能有新的收尾写入），避免用轮询开头的旧结论。
          if (!subagentsAllSettled(tsPath, info0.roundStart || 0, SUBAGENT_IDLE_MS)) {
            // 仍有子代理未落定 → 继续等（不收口）
            lastActiveAt = Date.now();
            busySince = 0;
          } else {
            // 子代理确实已落定 + 末行已稳定 >=3 帧 → 立即收口（v2.60：无确认窗口）
            toastReason = 'subagents-settled';
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
      // v3.20.0：带上轮次元信息（watcher 汇总路径也会落明细，source 区分来源）
      if (info.tsPath) incrementalRecord(info.tsPath, fSid, {
        sid: fSid, roundStart: info.roundStart || 0, durMs: agg.durMs,
        model: agg.modelMain || agg.model, subModels: agg.subModels,
        subCount: agg.subCount, teamActive: agg.teamActive === true,
        source: 'flush-delayed', label: roundLabel(info.tsPath, info.roundStart || 0),
      });
      const bal = balanceText();
      if (info.mainToastedAt) {
        // v3.12：异常轮——主模型已在 Stop 先弹，此处只补弹【子代理】部分（不含主模型用量，否则重复）。
        // v3.38.0：Stop 端已不再拆分弹（C2），本分支只服务**旧 coalesce 残留**（升级前写下的 mainToastedAt）；
        //   同时按 §3.3b 修缺陷——原实现无论几种模型都只弹 1 条，异模型时违反"分开弹"且金额跨模型混合。
        const subAgg = aggregateSubsOnly(info.tsPath, info.roundStart || 0);
        if (subAgg && subAgg.total > 0) {
          const subsMap = subagentModelSet(info.tsPath, info.roundStart || 0);
          if (!showToastsSplitByModel(subAgg, { pricing, tsPath: info.tsPath, roundStart: info.roundStart || 0, subs: subsMap, alwaysTag: true, reason: 'team-sub-only' })) {
            const subToastAgg = Object.assign({}, subAgg, { subModels: undefined });
            const e0 = subsMap.get(normalizeModelName(subAgg.model || ''));
            showToast(toastLineTagged(subToastAgg, pricing, e0 ? subagentTagOf(e0) : '（子代理使用）'), toastLine2(subToastAgg, pricing), 'team-sub-only', info.tsPath);
          }
        }
        appendCompactionLog('flush-team-sub-only', { sid: fSid, subTotal: subAgg ? subAgg.total : 0 });
        clearCoalesce(fSid);
        const ws = loadSnapshot(fSid) || {};
        saveSnapshot({ file: ws.file || '', stat: ws.stat || null, lastUserMsgAt: ws.lastUserMsgAt || 0, lastStopAt: Date.now() }, fSid);
      } else {
        // v3.38.0（C3③）：**按模型分条弹**（用户 2026-10-08 定案：「不同模型的子代理也要单独弹窗」）。
        //   单模型（含"子代理与主模型同模型"已按桶合并）→ 下方原单条路径，**逐字节不变**；
        //   ≥2 个模型 → 主模型 1 条 + 每种不同子代理模型各 1 条，各自单独计价，不做跨模型混合。
        if (showToastsSplitByModel(agg, {
          pricing, tsPath: info.tsPath, roundStart: info.roundStart || 0,
          bal, firstToday: todayUsageTxt(), reason: toastReason,
        })) {
          appendCompactionLog('flush-split-by-model', { sid: fSid, parts: Object.keys(agg.models || {}) });
        } else {
          // v2.98：子代理/专家团弹窗标注——区分两种形态（专家团=带 agentColor 的成员；普通子代理=内置类型）。
          // 与主模型同名的子代理会被并入同一模型桶（按模型分桶已天然实现），此处仅做标注，不改计费与数据结构。
          const subModels = subagentModelSet(info.tsPath, info.roundStart || 0);
          const modelShort = shortModelName(agg, pricing);
          const subEntry = subModels.get(normalizeModelName(agg.model || ''));
          const modelLabel = subEntry ? modelShort + subagentTagOf(subEntry) : modelShort;
          showToast(toastLine1(agg, modelLabel, periodNote(agg, pricing), bal, todayUsageTxt(), noPriceTag1(agg, pricing)), toastLine2(agg, pricing), toastReason, info.tsPath);
        }
        clearCoalesce(fSid);
        // v2.27：watcher 弹窗完成 = 专家团本轮真正结束 → 推进 lastStopAt（供 hook 端起点刷新守卫）
        const ws = loadSnapshot(fSid) || {};
        saveSnapshot({ file: ws.file || '', stat: ws.stat || null, lastUserMsgAt: ws.lastUserMsgAt || 0, lastStopAt: Date.now() }, fSid);
      }
    }
    // R4（2026-08-23）：释放只删自己持有的锁（校验 pid===自己），避免异常路径误删新 owner 的锁
    if (gotLock) { try { const o = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); if (o && o.pid === myPid) fs.unlinkSync(lockPath); } catch (e) {} } // silent-ok:清理 — 同上
    return;
  }
  // v2.21：hook 与 stop 都从 payload 读 session_id（快照按会话拆分，多会话并发不互相覆盖）；
  // 手动运行无 payload → sid='' → 全局快照（行为不变）。stdin 只读一次，后面全部复用 payloadRaw。
  const payloadRaw = (asHook || asStop) ? readStdin() : '';
  let sid = '';
  let hookCwd = '';
  try { const hp = JSON.parse(payloadRaw); sid = String(hp.session_id || ''); hookCwd = String(hp.cwd || ''); } catch (e) { /* payload 非 JSON 或无 session 字段 */ }

  // 输出统一走 stdout；hook 场景输出 Claude-Code 风格 JSON
  // v3.22.0：版本更新提示的追加**下沉到 out() 内部**——`--hook` 的每一条输出（含各条早退分支）
  //   都会自动带上提示，不存在"忘了在某条分支上挂"的可能。非 hook 模式 payload 原样输出，
  //   与旧版**逐字节相同**（upNote 为 '' 时 `payload === hookOut`）。
  const out = (hookOut) => {
    let payload = hookOut;
    if (asHook && upNote) {
      const hs = payload && payload.hookSpecificOutput;
      const prev = hs ? hs.additionalContext : (typeof payload === 'string' ? payload : '');
      payload = { hookSpecificOutput: Object.assign({}, hs || {}, { additionalContext: prev ? `${prev}\n${upNote}` : upNote }) };
    }
    process.stdout.write(asHook || asStop ? JSON.stringify(payload) : payload);
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
  // v3.35.0（B1）：Stop 端处理整块迁出到 stop-handler.js（main() 1151→~825 行）。
  //   依赖显式注入而非反向 require —— 保持"主脚本 → 兄弟模块"的单向依赖。
  //   返回 true = 已在函数内 out() 并收口，main() 直接 return；false = 继续共用尾巴。
  if (asStop && handleStopEnd({ sid, payloadRaw, pricing, out, tx: {
    SUBAGENT_IDLE_MS,
    TOAST_LINE_MAX_W,
    aggregateMainOnly,
    aggregatePerModel,
    aggregateTranscript,
    allInRoundSubFilesTerminal,
    appendCompactionLog,
    balanceText,
    captureTranscShape,
    clearCoalesce,
    coalescePath,
    dispWidth,
    ensureNewModelPricing,
    estimateInterrupted,
    freshCompactionMarker,
    hasSubagentsRecentlyActive,
    incrementalRecord,
    inferRoundStartFromText,
    lastWatcherSpawnError,
    latestTraceFile,
    ledgerKey,
    lineFor,
    loadSnapshot,
    mergeEstIntoModels,
    noPriceTag1,
    periodNote,
    readCoalesceInfo,
    readTranscLines,
    roundLabel,
    saveSnapshot,
    shortModelName,
    showToast,
    showToastsSplitByModel,
    sleep,
    sleepSync,
    startWatcherVerified,
    subagentPending,
    summarizePayload,
    terminalError,
    toastLine1,
    toastLine2,
    toastLineTagged,
    todayUsageTxt,
    traceWallDurMs,
    transcriptPathFromPayload,
    writeCoalesce,
    writeProbe,
  } })) return;

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
    // v3.33.0（第四轮审计 S1 修复·第二重）：本块与上方 transcript 块是**平行的顶层 if (asStop)**
    //   （拿不到上块的 tsPath，自取）。同样依赖 lastUserMsgAt → 一并做起点兜底。
    const tsPathT = transcriptPathFromPayload(payloadRaw) || null;
    let roundStart = prevSnap.lastUserMsgAt || 0;
    if (!roundStart) roundStart = inferRoundStartFromText(tsPathT || tf);
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
        // v3.33.0（S1 修复）：traces 兜底必须把 tsPath/roundStart 一并交给 watcher ——
        //   此前只带 traceFile → watcher 的 `if (info.tsPath)` 不成立 → **永不记账**（双封死第二重）。
        // v3.34.0（P0-1）：alreadyRecorded **显式为 false** —— 本 traces 兜底路径在 Stop 端**没有**跑
        //   incrementalRecord（transcript 块没进），pendInfo.tsPath 为空或 watcher 未跑时，--hook 兜底补弹处（pendToday）的
        //   recordUsage 是**唯一**记账点。**绝不能**跟着 P0-1 一起改成"只显示"——那会让这些轮永不入账。
        writeCoalesce(sid, ts, { traceFile: tf, tsPath: tsPathT, roundStart, alreadyRecorded: false });
        spawnFlushWatcher(sid);
      } else {
        // R2 修复（2026-08-23）：单 trace 普通轮原 0ms 确认窗立即弹并推进 lastStopAt，存在 Premature
        // 风险（同轮续跑/恢复被误判结束）。统一改走 coalesce + watcher 6s 确认窗，由 --flush-delayed
        // 判定真结束并推进 lastStopAt（与专家团/transcript 源 plain 路径一致）。
        saveSnapshot({ file: tf, stat: ts, lastUserMsgAt: prevSnap.lastUserMsgAt || 0, lastStopAt: prevSnap.lastStopAt || 0 }, sid);
        // v3.33.0（S1 修复）：traces 兜底必须把 tsPath/roundStart 一并交给 watcher ——
        //   此前只带 traceFile → watcher 的 `if (info.tsPath)` 不成立 → **永不记账**（双封死第二重）。
        // v3.34.0（P0-1）：alreadyRecorded **显式为 false** —— 本 traces 兜底路径在 Stop 端**没有**跑
        //   incrementalRecord（transcript 块没进），pendInfo.tsPath 为空或 watcher 未跑时，--hook 兜底补弹处（pendToday）的
        //   recordUsage 是**唯一**记账点。**绝不能**跟着 P0-1 一起改成"只显示"——那会让这些轮永不入账。
        writeCoalesce(sid, ts, { traceFile: tf, tsPath: tsPathT, roundStart, alreadyRecorded: false });
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
        // v3.38.0（C3④ + §3.3b）：同 flush-delayed 端处理——标注改 v2.98 文案；异模型按模型分条。
        const subAgg = aggregateSubsOnly(pendInfo.tsPath, (pendInfo && pendInfo.roundStart) || 0);
        if (subAgg && subAgg.total > 0) {
          const subsMap = subagentModelSet(pendInfo && pendInfo.tsPath, (pendInfo && pendInfo.roundStart) || 0);
          if (!showToastsSplitByModel(subAgg, { pricing, tsPath: pendInfo && pendInfo.tsPath, roundStart: (pendInfo && pendInfo.roundStart) || 0, subs: subsMap, alwaysTag: true, reason: 'team-sub-only' })) {
            const subToastAgg = Object.assign({}, subAgg, { subModels: undefined });
            const e0 = subsMap.get(normalizeModelName(subAgg.model || ''));
            showToast(toastLineTagged(subToastAgg, pricing, e0 ? subagentTagOf(e0) : '（子代理使用）'), toastLine2(subToastAgg, pricing), 'team-sub-only', pendInfo.tsPath);
          }
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
        // v3.34.0（第五轮审计 P0-1 修复）：此处原本**无条件** `todayDisplay()`（= recordUsage + 读当日累计）。
        //   recordUsage **没有水位线去重**（水位线只在 incrementalRecord 里推进），于是：
        //     coalesce 由本处（subCount>0 且 teamActive≠true 且子代理未收尾）写出时，Stop 端 transcript 块
        //     已跑过 incrementalRecord —— 本轮用量**已入账**；watcher 一旦被宿主收割，下次 --hook 走到
        //     本分支再记一次 → **整轮用量重复计费**（账本虚高一倍，且不可自愈）。
        //   但 traces 兜底路径（本文件下方两处 writeCoalesce）在 Stop 端**没有**记账，本处的 recordUsage 是**唯一**记账点
        //   —— 删掉会让这些轮**永不入账**（v3.33.0 S1 刚修好的"双封死"会原样复发）。
        //   故按 coalesce 元信息分岔：alreadyRecorded → 只显示；否则照旧记账。
        const pendToday = (pendInfo && pendInfo.alreadyRecorded === true) ? todayUsageTxt() : todayDisplay(pendAgg, pricing);
        // v3.38.0（C3③ + §3.3b）：hook 兜底**同样按模型分条**（与 watcher 出口共用同一实现）。
        //   原缺陷：Stop 端不再先弹后，coalesce 里没有 mainToastedAt → 一律走本分支弹**完整一条**，
        //   异模型时违反"不同模型分开弹"，且金额跨模型混合。现同模型 → 单条（原行为）；异模型 → 每条各弹。
        //   ⚠️ pendToday 已在上方算好（含记账语义），传给分条函数只用于第一条，绝不重复入账。
        if (!showToastsSplitByModel(pendAgg, {
          pricing, tsPath: pendInfo && pendInfo.tsPath, roundStart: (pendInfo && pendInfo.roundStart) || 0,
          bal, firstToday: pendToday, reason: 'hook-fallback',
        })) {
          showToast(toastLine1(pendAgg, pendModel, periodNote(pendAgg, pricing), bal, pendToday, noPriceTag1(pendAgg, pricing)), toastLine2(pendAgg, pricing), 'hook-fallback');
        }
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
              mergeEstIntoModels(aggC, estByModelC); // v3.26.0（⑧ 自审修正）：估算段并入分模型明细
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
              toastLine1(aggC, modelC, '（手动取消）', balC, todayUsageTxt(), noPriceTag1(aggC, pricing)),
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
    // v3.26.0（KI-6 ⑨ 自审修正）：结算分支推进的 lastStopAt 必须存活到下方 L5543 的**整文件覆盖**。
    //   缺陷：结算分支 saveSnapshot({…, lastStopAt: nowH}) 后，L5543 又用 `psnap2.lastStopAt || 0`
    //   （结算前的旧值，全新会话恒 0）整文件重写快照 → 刚推进的 lastStopAt 被打回 →
    //   下轮 hook 的 inProgress 仍真 → 起点再次刷新 → 本轮开头 token 漏聚合（正是 ⑨ 要防的形态）。
    //   连锁测试 b1 实测复现：结算告警/起点推进/coalesce 清除都对，唯 lastStopAt=0。
    let stopAtH = prevStop;
    const inProgress0 = prevStart > 0 && prevStop < prevStart; // 上一轮未结束（专家团进行中）
    const nowH = Date.now();
    let inProgress = inProgress0;
    let startH = nowH;
    // v3.26.0（KI-6 ⑨）：**补弹链路死亡检测** —— 团队轮拆分弹（team-main-first）后「绝不推进
    // lastStopAt」（v3.12.1），轮次边界由 watcher 出口/hook 兜底推进。watcher 被宿主收割（KI-3）时
    // 两者都到不了 → lastStopAt 永不推进 → inProgress 恒真 → 起点**永久停在旧轮** → 下一轮聚合
    // 窗口含上轮全部 tokens（审计实证：03:35 toast 355万 与 03:29 轮 136万 窗口重叠；两轮 subCount
    // 均记 131，按正确窗口应 139/8）= 双弹屏 + subCount 陈旧。
    // 判「链路已死」（双条件，保守）：① coalesce 写入时间距今 > STALE_MS（默认 10min；正常补弹
    //    = 6s 确认窗 + idle 检测，分钟级完成）；② 子代理文件已静止（真在跑不误判）。
    // 动作：清残留 coalesce + **lastUserMsgAt 与 lastStopAt 一并推进到 now**（只推起点不推 lastStopAt
    // 的话，下轮 hook 的 inProgress 仍真 → 起点再次刷新 → 本轮开头 token 漏聚合；lastStopAt=now 后
    // 下轮正常，且同轮 Stop 的 aggStart0=max(lastStopAt, roundStart0)=now，口径仍正确）。
    if (inProgress && tsPathH) {
      try {
        const cInfo9 = readCoalesceInfo(sid);
        const coalAt9 = Number(cInfo9 && cInfo9.at) || 0;
        const staleMs9 = Number(process.env.WB_TEAM_SPLIT_STALE_MS) || 600000;
        if (coalAt9 > 0 && nowH - coalAt9 > staleMs9 && !hasSubagentsRecentlyActive(tsPathH, SUBAGENT_IDLE_MS)) {
          clearCoalesce(sid);
          saveSnapshot({ file: hookFile, stat, lastUserMsgAt: nowH, lastStopAt: nowH }, sid);
          stopAtH = nowH; // v3.26.0（⑨ 自审修正）：同步给下方 L5543（否则被旧值覆盖回退）
          inProgress = false;
          startH = nowH;
          process.stderr.write(`[token-tracker] ⚠ 检测到团队轮补弹链路已死亡（coalesce 残留 ${Math.round((nowH - coalAt9) / 60000)} 分钟且子代理已静止），已宣告结算并刷新轮起点（KI-6 ⑨，防双弹屏）\n`);
          try { appendCompactionLog('hook-stale-coalesce-settled', { sid, coalAt: coalAt9, ageMs: nowH - coalAt9 }); } catch (e9) {}
        }
      } catch (e9) { /* 检测失败保持原行为 */ }
    }
    saveSnapshot({ file: hookFile, stat, lastUserMsgAt: inProgress ? prevStart : startH, lastStopAt: stopAtH }, sid);
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

  // v3.22.0：版本更新提示由 out() 统一追加（见 main() 开头），此处保持旧版表达式不变。
  out(plain(nmNote ? `${line}\n${nmNote}` : line));
}

// v2.39：被 require 时不执行 main()（hooks/手动仍走 node token-tracker.js，main 正常跑）；
// 导出内部函数供测试/回填脚本复用同一套记账逻辑，避免逻辑复制漂移。
if (require.main === module) main();
module.exports = {
  todayStr, loadDailyUsage, saveDailyUsage, recordUsage, dayTotalOf, hitRate,
  calcCost, findModel, isLocalModel, fmtCost, cleanModelName,
  readTranscLines, parseTranscChunk, readTranscLinesFrom, extractUsage, perModelFromRows, aggregatePerModel,
  aggregateMainOnly, aggregateSubsOnly, aggregateTranscript,
  todayDisplay, reportTxt, reportSummaryTxt, normalizeDailyUsage,
  // v3.20.0：--report 区间 / CSV / 外推 + 轮次明细留档（selftest 直接单测，不再只能靠 spawn 看 stdout）
  formatUsageRow, costCellKind, aggregateRangeModels, parseReportRange, reportRangeTxt,
  exportReportCsv, reportForecastTxt, pruneRoundFiles,
  // v3.33.0（B 系列）：summary 的 CSV 出口（此前唯一没有 CSV 出口的 --report 形态）
  exportSummaryCsv,
  appendRoundDetail, roundLabel, transcTextOfRow, inferRoundStartFromText, readTailRawLines, readTailRaw,
  // v3.33.0（A5）：timestamp 口径统一的唯一实现（selftest 直接单测，无需造 transcript）
  numTs,
  // v3.33.0（B 系列）：注入型 user 行的统一标签白名单（宽表/窄表刻意分开，selftest 直接断言两者不同）
  INJECTION_TAGS_ALL, INJECTION_TAGS_NOT_SUBMIT, injectionTagOf,
  doctorTxt,
  ROUNDS_DIR, EXPORTS_DIR,
  mainModelState, lastTranscLine, coalescePath, hasActiveSubagentsSince, subagentsDirFromTranscript, subagentPending, subagentsAllStagnant, interruptedByUser, hasSubagentsRecentlyActive,
  subagentsAllSettled, // v3.38.0：子代理「是否已全部落定」判据（终止态 / incomplete 且停写≥20s），selftest 可直接单测
  splitByModelStats, showToastsSplitByModel, // v3.38.0：按模型分条（拆分 / 弹窗），selftest 可直接单测
  interruptedRowsAfter,
  incrementalRecord, loadLedgerWatermark, saveLedgerWatermark,
  // v3.39.0（A2）：「记账成功但水位线没落盘」的回滚（纯文件层、可单测，避免只能靠注释自证）
  rollbackLedgerAfterWatermarkFailure,
  estimateInterrupted, estimateInterruptedInc,
  extractUsageFromRow, terminalErrorFromRow, terminalError, freshCompactionMarker, compactionMarkerId,
  showToast, toastLineTagged,
  traceWallDurMs, withFileLock,
  loadPricing, autoRefreshPricing, addModelPrice, savePricing, normalizeModelName, saveDailyUsageRaw,
  getTranscriptStats, sidFromPath, ledgerKey,
  // v3.18.4（G2/G3）：护栏与抢救函数导出，selftest 可直接单测（不再只能靠 spawn，受限环境也能验）
  guardRebuildScale, salvageModelsFromText, dbStaleTag,
  // v3.19.0（P6）：本地官方价库合并导出——recalc-day.js 复用它，避免"只读主库漏掉本地库"
  mergeLocalPriceDb, isPeakHour,
  // v3.19.1（N1）：时段告警标签导出，selftest 直接单测（无法解析时 toast 必须可见）
  peakRuleTag,
  // v3.19.1（N2）：watcher 单轮读取导出，selftest 验证"未变化跳过 IO"与增量等价性
  watchReadStep,
  // v3.21.0：版本更新检查（selftest 直接单测版本比较/闸门/节流/退避，不必真联网）
  // v3.22.0：新增 Stop 端兜底链路（hookIdle / claimNotify / maybeFetchLatest / updateTagForToast）
  updateNotice, cmpVersion, loadUpdateState, saveUpdateState, queryLatestTag,
  updateTagForToast, maybeFetchLatest, maybeFetchLatestForStop, claimNotify, hookIdle,
  toastLine2, TRANSC_TRUNCATED_FILE, // v3.24.0：弹窗标注（⚠未计价/⚠账缺）行为测试用
  toastLine1, noPriceTag1, anyNoPublicPrice, dispWidthTitle, dispWidth, // v3.27.0：⚠无公开价 挪进行1 + 布局测试用
  mergeEstIntoModels, // v3.26.0（KI-6 ⑧）：估算段并入分模型明细（selftest 单测）
  // v3.23.5：残留锁清理导出（KI-3 副产物；selftest 可直接单测"删旧留新、当前会话锁不动"）
  cleanupCoalesceLocks, coalescePath,
  // v3.34.0（P0-1）：合并文件的读写导出——selftest 可直接断言「alreadyRecorded 标记写进去了 / 没写进去
  //   时与旧格式逐字节一致」，不必靠 spawn 全链路复现"watcher 被宿主收割"这一不可控场景。
  writeCoalesce, readCoalesce, readCoalesceInfo,
  SKILL_VERSION, UPDATE_CHECK_FILE, UPDATE_INTERVAL_MS, UPDATE_MAX_NOTIFY, UPDATE_NOTIFY_GAP_MS, HOOK_IDLE_MS,
  // v3.34.0（A2）：exports/ 清理导出——与 pruneRoundFiles 同款，selftest 直接单测保留期与目录边界。
  pruneExports, EXPORTS_KEEP_DAYS,
};
