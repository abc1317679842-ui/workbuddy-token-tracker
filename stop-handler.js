#!/usr/bin/env node
// stop-handler.js —— Stop 端（--stop）处理，v3.35.0（B1）从 token-tracker.js 的 main() 里整块迁出。
//
// 为什么迁：main() 曾 1151 行，把「CLI 分发 / --hook 路径 / --stop 路径」三件语义完全不同的事压在
//   一个函数里；v3.34.0 修的 P0-1（--hook 兜底对已记账轮次重复计费）正是这种「同一段代码服务两个
//   相反契约」的结构孕育出来的。迁出后 --stop 的契约收敛到本文件一处，改弹窗/改记账不必再穿
//   越 CLI 分发与 hook 分支的上下文。
//
// 为什么**不**反向 require 主脚本：本文件被主脚本 require，反向 require 会形成循环依赖
//   （且让"谁依赖谁"失去方向）。改为**显式注入**：主脚本把这里需要的 46 个只读能力打包成 tx 传进来，
//   本文件顶部一次性解构，正文因此与主脚本里的原样逐字节相同。
//   漏传/改名 → selftest 的 T37（注入完整性）会立刻红，不会等到运行时才 ReferenceError。
//
// 返回值契约：
//   true  = 本轮已经在函数内 out() 过并收口，main() 应立刻 return；
//   false = 未收口，main() 继续走共用的 trace/snapshot/公共弹窗尾巴（与迁移前行为一致）。
//
// 正文来自迁移前的 main() 且**未重排缩进**——模板字符串里的空白是弹窗文案的一部分，
//   为了"看起来整齐"去改缩进会静默改掉弹窗文本（零噪音红线）。故本文件正文缩进比常规多 2 空格。
//
// ── 静默 catch 约定（同主脚本 v3.33.0 T-19）────────────────────────────────
//   每一处裸 catch 都必须带 `// silent-ok:<类别> — <理由>`，类别 ∈ 诊断/清理/探测/降级。
//   不在这四类里的静默 = 缺陷。selftest T33 会连本文件一起扫（FILES33 已含 stop-handler.js）。
'use strict';
const fs = require('fs');
const path = require('path');

function handleStopEnd(ctx) {
  const { sid, payloadRaw, pricing, out, tx } = ctx;
  const {
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
  } = tx;
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
      return true;
    }

    const prevSnap0 = loadSnapshot(sid) || {};
    // v3.33.0（第四轮审计 S1 修复·第一重）：lastUserMsgAt 只由 --hook 分支写入 → 只配 Stop、
    //   不配 UserPromptSubmit 的机器恒为 0 → 下方 `roundStart0 > 0` 恒不成立、整段记账被跳过。
    //   没起点时从 transcript 反推（语义同 hook 记录值），让"配了但结构性不工作"变成"其实能工作"。
    let roundStart0 = prevSnap0.lastUserMsgAt || 0;
    if (!roundStart0) roundStart0 = inferRoundStartFromText(tsPath);
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
          mergeEstIntoModels(agg, estByModel0); // v3.26.0（⑧ 自审修正）：估算段并入分模型明细
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
      // v3.20.0：带上轮次元信息 → 这一轮会在 rounds/rounds-YYYY-MM.jsonl 留一条明细。
      incrementalRecord(tsPath, sid, {
        sid, roundStart: roundStart0, durMs: agg.durMs,
        model: agg.modelMain || agg.model, subModels: agg.subModels,
        subCount: agg.subCount, teamActive: agg.teamActive === true,
        source: 'stop-transcript', label: roundLabel(tsPath, roundStart0),
      });
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
          // v3.13（2026-09-23）：原判据只看 mtime 活跃窗（20s）→ 子代理"刚写完但差 <20s"会被误判"仍在跑"，
          //   白拆两条（实测 01:45：文件 01:45:05.904 写完，Stop 在 01:45:05.2，只差 0.7 秒）。
          //   新增**有界微重判**：pending=0 且文件"刚活跃"时，最多重判 3 次（每次等 700ms，共 ~2.1s），
          //   其间只要 `subagentPending()` 仍为 0 且**本轮子代理文件全部为终止态**（allInRoundSubFilesTerminal）
          //   就放行**单条完整弹窗**（含子代理 token）。
          //   ⚠️ 准确性优先：只有**全部**文件确认终止才放行；超预算仍未终止 → 走拆分兜底（绝不漏 token）。
          //   关闭开关：环境变量 WB_NO_SUB_WAIT=1（用于测试或异常时快速回退）。
          const pend0 = subagentPending(tsPath).length === 0;
          const active0 = hasSubagentsRecentlyActive(tsPath, SUBAGENT_IDLE_MS);
          teamDataReady = pend0 && !active0;
          if (pend0 && active0 && process.env.WB_NO_SUB_WAIT !== '1') {
            for (let i = 0; i < 3 && !teamDataReady; i++) {
              sleepSync(700);
              try {
                teamDataReady = subagentPending(tsPath).length === 0 && allInRoundSubFilesTerminal(tsPath, aggStart0);
              } catch (e) { teamDataReady = false; }
              if (teamDataReady) appendCompactionLog('stop-sub-wait-resolved', { sid: effSid, tries: i + 1 });
            }
          }
        } catch (e) { teamDataReady = false; }
        if (isPlainRound || teamDataReady) {
          // 普通轮：同步立即弹（不 spawn、不等确认窗），并清掉 coalesce 以免被兜底二次补弹
          try {
            // v3.38.1（真机复现 2026-10-09 00:52，用户截图质问「为什么还是合并了」）：
            //   本快速路径（v3.09 加）在 v3.38.0 改造时**漏改**——它先于 TEAM_SPLIT 与 watcher 执行，
            //   teamDataReady 时直接单条弹（旧标注「（子代理 hy3）」+ 跨模型混合计价），把 C3③ 的
            //   按模型分条整个绕过。时序洞：子代理 00:50:23 写完 → 主模型继续写回复 110s → Stop 时
            //   hasSubagentsRecentlyActive(20s)=false（mtime 已出窗）→ teamDataReady=true → 单条弹。
            //   修法：团队轮（!isPlainRound）先试 showToastsSplitByModel——≥2 模型 → 分条弹
            //   （与 watcher 收口同一实现）；单模型返回 false → 回落原单条，逐字节不变。
            //   真普通轮（isPlainRound）不试分条：无子代理，models 必然单桶，白扫盘。
            if (!isPlainRound && showToastsSplitByModel(agg, {
              pricing, tsPath, roundStart: aggStart0,
              bal: balanceText(), firstToday: todayUsageTxt(),
              reason: (typeof toastReason === 'string' && toastReason) ? toastReason + '+plain-immediate' : 'plain-immediate',
            })) {
              appendCompactionLog('stop-plain-immediate-split', { sid: effSid, parts: Object.keys((agg && agg.models) || {}) });
            } else {
              showToast(
                toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), balanceText(), todayUsageTxt(), noPriceTag1(agg, pricing)),
                toastLine2(agg, pricing),
                (typeof toastReason === 'string' && toastReason) ? toastReason + '+plain-immediate' : 'plain-immediate',
                tsPath
              );
            }
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
          return true;
        }
        // v3.12「异常轮拆分弹窗兜底」——**已实测通过（2026-09-23，带 trace 夹具）**，默认开启：
        //   实测：① 异常轮 Stop → 立刻 1 条【主模型】条（标"子代理运行中"）；
        //        ② 子代理结束后 `--hook` → 补弹 1 条【子代理】条（reason `team-sub-only`），coalesce 清理；
        //        ③ 再次触发 → 不重复；④ 真实 toast 日志 md5 前后一致（零污染）。
        //   ⚠️ 排查提示：**补弹路径依赖 trace 文件存在**——早前在"沙箱未造 trace"的夹具里测出"补弹不触发"，
        //      是夹具缺失导致的假象，非代码缺陷（排查花了很久，记此备忘）。
        // v3.38.0（2026-10-08 用户定案）：**默认改为不再拆分弹**。
        //   需求原文：① 中间过程（主模型读子代理回传 → 再派任务 → 批与批的间隔）**一律不弹窗，
        //   只落盘记账**——用户"在任务中间弹不弹其实无所谓"；② 要的"及时"是**主模型任务结束时
        //   弹窗跟着一起出来**，不是"每批子代理完成就弹一次"。
        //   实证依据：2026-10-02 18:20~18:41 一轮内因每批补弹都推进 lastStopAt，退化成「按批弹」，
        //   26 分钟弹了 **22 条**；且该批主子同模型，按 v2.95 本就不该拆。
        //   现默认走下方「写 coalesce + 启 watcher + 启动失败则同步降级」路径（= v3.11 行为），
        //   由 watcher 在主任务真结束时**按模型分条**一次弹出（分条逻辑见 token-tracker.js 出口）。
        //   紧急回退：设 WB_TEAM_SPLIT=1 可回到 v3.12 拆分弹行为（每条主模型先弹、子代理后补）。
        const TEAM_SPLIT_ENABLED = process.env.WB_TEAM_SPLIT === '1';
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
          return true;
        }
        // v3.34.0（P0-1）：本分支上方（transcript 块的 incrementalRecord）**已经跑过记账**（transcript 路径无条件记账），
        //   本轮用量已入账 → 标 alreadyRecorded，供 --hook 兜底补弹时只显示、**不二次记账**。
        writeCoalesce(effSid, agg, { tsPath, roundStart: aggStart0, byModel, terminalError: teAtStop || undefined, traceFile, alreadyRecorded: true });
        // 专家团/多子回合：仍需 watcher（要等子代理落盘后才汇总），启动并校验是否接管；
        // 未接管 → 立即降级为同步弹窗，保证**任何情况下至少弹一次**。
        if (!startWatcherVerified(effSid)) {
          // 二次确认：coalesce 仍在（未被其它 watcher 清掉）才补弹，避免与在跑的 watcher 双弹
          let stillPending = false;
          try { stillPending = fs.existsSync(coalescePath(effSid)); } catch (e) { stillPending = false; }
          if (stillPending) {
            try {
              showToast(
                toastLine1(agg, shortModelName(agg, pricing), periodNote(agg, pricing), balanceText(), todayUsageTxt(), noPriceTag1(agg, pricing)),
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
        return true;
      } else {
        // v2.86：同轮二次 Stop 且已结算过 → 聚合窗口内无新增 usage 行 → 静默跳过（绝不弹"无记录"
        // 误导——数据其实早已结算过）；记账照跑保底残余行，水位线幂等不重复。
        if (settledAt0 > roundStart0) {
          incrementalRecord(tsPath, sid);
          writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: false,
            transcriptPath: tsPath, stat: null, note: 'same-round-settled-no-new-usage-skip',
            payload: summarizePayload(payloadRaw) });
          out({ hookSpecificOutput: {} });
          return true;
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
          showToast(toastLine1(estStat, estModelShort, '（估算）', bal, todayUsageTxt(), noPriceTag1(estStat, pricing)), toastLine2(estStat, pricing), 'estimate');
          out({ hookSpecificOutput: {} });
          return true;
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
        // v3.19.3：压缩期噪音豁免（单点判据，替代已删除的 compactionMode/compressionPending 状态机）。
        //   实测场景（2026-09-12 07:31，同一现场 18 秒内 3 条）：上下文压缩期间客户端连续触发多次
        //   Stop，每次本轮都无 usage → 连弹多条"本轮无 token 消耗记录"，纯噪音。
        //   判据：transcript 末尾 30 行内存在「新鲜」压缩标记（10 分钟内）→ 静默跳过本次弹窗。
        //   保留原快照推进（上面已写 lastStopAt），轮次边界行为与原来完全一致；
        //   账本不受影响：incrementalRecord 已在本函数开头按水位线跑过，本分支只决定"弹不弹"。
        const freshMarker0 = freshCompactionMarker(tsPath);
        if (freshMarker0) {
          appendCompactionLog('stop-no-token-compaction-skip', { sid, markerId: freshMarker0, aggStart: aggStart0 });
          writeProbe({ time: new Date().toISOString(), event: 'Stop', ok: true, sid, sameRound: false, transcriptPath: tsPath,
            stat: null, note: 'compaction-fresh-marker-skip-no-toast', source: 'transcript-empty-compaction',
            payload: summarizePayload(payloadRaw) });
          out({ hookSpecificOutput: {} });
          return true;
        }
        showToast('本轮无 token 消耗记录', body0, 'no-token');
        out({ hookSpecificOutput: {} });
        return true;
      }
    }
  return false;
}

module.exports = { handleStopEnd, STOP_TX_NAMES: ["SUBAGENT_IDLE_MS","TOAST_LINE_MAX_W","aggregateMainOnly","aggregatePerModel","aggregateTranscript","allInRoundSubFilesTerminal","appendCompactionLog","balanceText","captureTranscShape","clearCoalesce","coalescePath","dispWidth","ensureNewModelPricing","estimateInterrupted","freshCompactionMarker","hasSubagentsRecentlyActive","incrementalRecord","inferRoundStartFromText","lastWatcherSpawnError","latestTraceFile","ledgerKey","lineFor","loadSnapshot","mergeEstIntoModels","noPriceTag1","periodNote","readCoalesceInfo","readTranscLines","roundLabel","saveSnapshot","shortModelName","showToast","showToastsSplitByModel","sleep","sleepSync","startWatcherVerified","subagentPending","summarizePayload","terminalError","toastLine1","toastLine2","toastLineTagged","todayUsageTxt","traceWallDurMs","transcriptPathFromPayload","writeCoalesce","writeProbe"] };
