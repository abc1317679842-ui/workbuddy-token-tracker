# token-usage-tracker Backlog

> 状态：v2.63 核心链路已收口（R1/R2/R3/R4 + P0-1 全部落地并测试通过）。
> 以下项目**全部为 backlog**，按用户 2026-08-24 指令：**不主动处理，等实际出问题再评估**。

## 近期变更记录（v2.60 ~ v2.63）

> 仅摘要，详细说明见 `SKILL.md` 对应版本条目。

- **v2.60（2026-08-25）统一稳定帧保护**：把 `unknown` 分支的 `stableCount >= 3` 门槛扩展到 `final` / `terminal-error`；去除冗余 6s 确认窗（`WATCH_CONFIRM_MS` / `confirmSince`），收口延迟从 ~12–15s 收敛回 ~6–9s；保留子代理安全闸门与 `stableCount` 重置一致性。
- **v2.61（2026-08-25）showToast 回归修复**：回退 v2.59 误改的 `spawn(detached+unref)`，恢复同步 `execFileSync`，修复「完全无弹窗」回归（本条同时关闭上方 P0-2）；清理 `WATCH_CONFIRM_MS` / `confirmSince` 死代码；`getTranscriptStats` 性能优化（换行符计数 + `transcriptStatsCache`）。
- **v2.62（2026-08-25）compactionMode 方案**：压缩检测由「行数减少 > 5」改为「扫描 transcript 末尾 30 行识别压缩标记」——本客户端 transcript 为 append-only、行数永不减少，旧方案永远不触发。**首次**压缩标记触发完整重置（`stableCount=0` + 刷新 busy/idle 计时）并暂停本轮收口，**后续**新标记只暂停本轮、不重复重置；无新标记时走正常 `stableCount >= 3` 收口（`compactionMode` 置 true 后不再回退）。
- **v2.63（2026-08-25）弹窗诊断日志**：废弃 `TOKEN_TRACKER_DEBUG` 环境变量开关 + poll 全量记录，改为**每次 `showToast` 无条件**向 `~/.workbuddy/token-tracker-toast.log` 追加一行 JSON 诊断（含 reason / sessionId / 行数 / 稳定计数 / compaction 状态等），无需开关；同时增加 `sessionId` 从 `tsPath` 提取、`traceFile` 从 `latestTraceFile` 提取。

## ~~P0-2 — showToast 同步阻塞风险~~（已关闭）
- **已关闭：v2.61 论证必须同步，异步会导致 toast 丢失，本条目作废。**
- 关闭依据：v2.59 的 compaction-fix 曾把同步 `execFileSync` 改成 `spawn(detached + unref)`，结果 watcher 进程退出时 PowerShell 子进程被提前终止、toast 完全不弹；v2.61 已回退为同步 `execFileSync`（`timeout: 10000` / `stdio: 'ignore'` / `windowsHide: true`），保证 toast 弹出后父进程才退出。即「同步阻塞」是**正确性代价而非性能缺陷**，异步化会直接丢失弹窗。
- 原条目内容（仅留档）：
  - 现象：`showToast` 用 `execFileSync(powershell)` 同步弹窗，阻塞 watcher 主循环。
  - 风险：弹窗期间锁不释放 / coalesce 文件不清（生产级风险评估，非已确认 bug）。
  - 触发条件：疑似在 toast 极慢或 powershell 卡住时出现。
- 状态：已关闭（2026-08-28 文档一致性清理）。

## P1-1 — 锁释放 TOCTOU 极端边界
- R3 已修主路径（原子 acquire + pid 存活校验 + 只删自己锁）。
- 残余边界：极端并发下原子锁边界未穷尽评估。
- 状态：backlog。

## P1-2 — pid 复用致 R3 失效
- Windows pid 回收后新进程复用旧 pid → pid 存活校验误判旧锁仍有效。
- 状态：backlog。

## P1-3 — WATCH_BUSY_MAX_MS 默认 2min 合理性
- busy 无后续兜底弹上限，默认 2 分钟是否过长/过短未评估。
- 状态：backlog。

## P1-4 — 锁 TTL 30min 是否偏长
- `WATCH_LOCK_TTL = 30*60*1000`，残留锁最长 30min 才被接管。
- 状态：backlog。

## P2-1 — race_fuzz 加 MOCK_TOAST 开关
- 消除破坏性测试对真实 toast 的依赖（测试健壮性，非生产问题）。
- 状态：backlog。

## 备注
- **生效时间机制（`deepseek_rules_pending`）是真实需求，非死代码**：官方更新日志（/zh-cn/updates，2026-07-31 公告）明确"新价格将于北京时间 2026 年 8 月 17 日 0 时开始生效"——当初要求此功能正是为这种"预告未来生效"文案。`parseRules` 的生效时间正则匹配"X年X月X日X时起"预告式，逻辑正确。
  - 当前（2026-08-24）定价页文案已改为陈述式"高峰时段为北京时间周一至周五…"，预告已"消费"为当前事实，故 `effective_at` 恒为 null、pending 不触发——这是**正确行为**（规则即当前生效），不是 bug。
  - 抓取器已对两种文案兼容（预告式 + 陈述式），无需改代码。若官方未来再加预告时间，pending 会自动激活。
- 调试残留已清（`.watch-debug` 已被 `.gitignore` 忽略，本地删除）。
- 历史审计/排查文档已归档至 `docs/`。
