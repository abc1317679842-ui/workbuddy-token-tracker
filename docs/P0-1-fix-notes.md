# token-usage-tracker P0-1 修复记录

- 代码版本：**v2.59**（2026-08-23，已写入 `token-tracker.js` 头部）
- 修复范围：watcher 的 compaction 期间 unknown 误弹（R1 回归）风险
- 状态：**本次 P0-1 回归排查完成；R2/R3/R4 及阶段2修复此前已闭合，v2.59 为整体收口版本**。P0-2 及以后按用户指令不做。

---

## 1. 修复了什么

### 1.1 生产代码（token-tracker.js）

**问题**：阶段2 把 `unknown` 状态无条件纳入 6s 确认窗（`else if (st === 'final' || interrupted || st === 'terminal-error' || st === 'unknown')`）。
Context Compaction 期间会截断重写 transcript 末行，导致末行半写/不可解析 → 持续 `unknown` > 6s 且无新行 → 6s 后误弹窗（R1 回归：compaction 期间把"正在改写"误判为"已结束"）。

**修复**：在 unknown 分支内新增 **transient 判定**（1937-1958 行）。
- 用 `readTailRaw(tsPath)` 取 transcript **原始末行**（不 JSON.parse，591-602 行实现：读最后 4KB、split 换行、取末非空行原文）。
- 与上一轮 `lastTailRaw` 做**字符串对比**：
  - 末行变了 → 文件正在被改写（compaction 重写中）→ 重置 confirmSince / busySince / lastActiveAt，续等，**不进确认期、不弹**。
  - 末行连续两次相同（转录确已停写）→ 非 transient → 走下方确认期收口弹窗。

**为什么选"末行内容对比"而非 size / mtime / 哈希**（见 1943-1945 行注释）：
- compaction 是覆盖末行的**截断重写**，等长重写下 `size` 可能不变；
- 重写时 `lastTranscLine` 会回退到前半部旧完整行导致**内容不变**；
- 二者都会漏判 transient → 提前弹（R1 回归）。原始末行在重写时必然抖动、静默时稳定，最能区分"正在改写"与"已停写"。

### 1.2 测试脚本（工作区）

**P0-1 验证脚本 bug（与生产代码无关）**：
- 原脚本写 COAL 文件名用 `coalesce-<SID>.json`（无前导点），但生产 `coalescePath`（66-69 行）生成的是 `.coalesce-<SID>.json`（带前导点，隐藏文件）。
- 差一个前导点 → watcher `readCoalesceInfo` 永远找不到 COAL → 返回 null → 直接 return，根本没进循环，导致两个 P0-1 场景都验证失败。
- 修复：测试脚本 COAL / SNAP 均改为带前导点 `.coalesce-` / `.snapshot-`，与 `coalescePath` / `snapshotPath` 对齐。
- 受影响文件：`p0_compaction_unknown.js`、`p0_real_end_unknown.js`。

---

## 2. 验证结论（已跑通）

| 场景 | 结果 | 证据 |
|------|------|------|
| P0-1 compaction 期间 unknown 持续重写（>6s） | ✅ 不弹，等待不回归 | watch-debug 显示 `confirmSince` 反复重置为 0（transient 生效）；compaction 结束 @12s 时 `coal删=false`；转录恢复后 @24.9s 才收口弹窗 |
| P0-1b 真结束 unknown 末行停写（纯 unknown，无补 final） | ✅ 正确弹窗（修复未破坏正确性） | `poppedAt=6896ms`（≈6s 确认期），coalesce 删 + lastStopAt 推进；TS 末行从始至终是半写 unknown，从未补 final |

判定指标与 hack 触发均正确：hack 每 150ms 重写末行带随机 junk → `tailRaw` 持续变化 → 稳定触发 transient 分支。

---

## 3. 调试探针清理情况（2026-08-23 推送前已全部清理）

**发布/推送前必须删除的临时调试桩——本次已删除：**

| 位置 | 原行号 | 内容 | 作用 | 状态 |
|------|------|------|------|------|
| watcher 首查后 | 1804 | `[DBG-INFO0] fSid=.. info0=has-agg/NULL` | 确认 COAL 是否被正确读取（定位脚本 COAL 文件名 bug 用） | ✅ 已删除 |
| unknown transient 判定内 | 1949 | `[DBG-P0] tailRawLen=.. lastTailRawLen=.. transient=..` | 确认 transient 判定是否被触发、末行是否变化 | ✅ 已删除 |

**watch-debug 落盘（v2.57 功能）**：改为环境变量 `WATCH_DEBUG=1` 才启用，默认关闭——生产不产生 `.watch-debug` 残留文件、无 I/O 开销；排查 watcher 状态时设 `WATCH_DEBUG=1` 运行即可复现调试日志。

**测试残留文件**：技能目录 P0/dbg/transcript 相关残留（`.coalesce-p0*`、`.snapshot-dbg*`、`.transcript-*`、`*.watch-debug` 等约 130 个）已全部删除；工作区测试脚本（`p0_*.js`、`test_deepseek_follow.js`、`test_r2_*.js`、`repro_*.js`、`race_fuzz.js` 等 27 个）已删除，仅保留报告文档。

---

## 4. 本次未做的项（按用户 2026-08-23 收尾指令砍掉，非遗漏）

- **P0-2**：showToast 同步阻塞（execFileSync powershell）导致锁不释放 / coalesce 不清的生产风险评估与修复 —— 未做。
- **P1-1**：锁释放 TOCTOU —— 未评估。
- **P1-2**：pid 复用致 R3 失效 —— 未评估。
- **P1-3**：WATCH_BUSY_MAX_MS 默认 2min 合理性 —— 未评估。
- **P1-4**：锁 TTL 30min 是否偏长 —— 未评估。
- **P2-1**：race_fuzz 加 MOCK_TOAST 开关消除真实 toast 依赖 —— 未做。
- **P2-2（头部版本号）**：本次已单独补做（见文件头部 `// token-usage-tracker v2.59 (2026-08-23)`）。
- **远程仓库**：GitHub 远程仍停在 v2.38，本次 v2.59 本地修复未推送（用户指令：仓库先不推，不管它）。

---

## 5. 关联文件

- 生产代码：`C:/Users/14779/.workbuddy/skills/token-usage-tracker/token-tracker.js`
- 官方定价抓取器（本次新增）：`C:/Users/14779/.workbuddy/skills/token-usage-tracker/deepseek-official.js`
- 价格刷新脚本：`C:/Users/14779/.workbuddy/skills/token-usage-tracker/refresh-prices.js`
- 定价文件：`C:/Users/14779/.workbuddy/skills/token-usage-tracker/pricing.json`
- 测试脚本：本次已全部删除（原 `p0_compaction_unknown.js`、`p0_real_end_unknown.js`、`test_deepseek_follow.js` 等）

---

## 6. 本次推送内容（2026-08-23）

本次推送 v2.59 到 GitHub 远程（原远程停在 v2.38），包含：

1. **P0-1 修复**：watcher compaction 期间 unknown 误弹（R1 回归）——transient 末行对比判定。
2. **DeepSeek 官方定价直连抓取**：新增 `deepseek-official.js`，直连官方定价页，解析模型清单 + 三组价格（空闲/高峰）+ 时段 + 周末规则 + 生效时间；失败重试；DeepSeek 系官方优先、非官方回落聚合源；模型清单自动对齐（新增/retired）。
3. **生效时间机制**：官方预告未来生效的规则存 `deepseek_rules_pending`，到点自动提升为当前规则（如 8-23 起周末低峰）。
4. **峰谷时段/周末通用跟随**：`isPeakHour(rules, now)` 读官方规则，官方改任何时段/周末规则自动跟随；无规则回退内置默认。
5. **代码清理**：DBG 探针删除、watch-debug 改为 `WATCH_DEBUG=1` 开关、测试残留文件清理、`.gitignore` 扩充（`.coalesce-*`/`.transcript-*`/账本备份等）。
6. **vision-exp 本地定价**：聚合源无数据，手动录入与 flash 同价（空闲 1.5/0.05/4.5，peak=2）。

**已知限制（当前）**：DeepSeek 系价格以官方价为准；若用户使用**第三方 API**（非 DeepSeek 官方域名），模型名识别仍锚定官方定价，暂无法区分第三方渠道价，统一按官方价计费。
