# Token-Usage-Tracker 系统性状态机审计 + 破坏性测试报告

> 原则：先研究 / 建模 / 实验 / 复现，再修改。**本轮未修改真实 `token-tracker.js`**（仅读取 + 真实机制复现 + 独立副本验证修复思路）。所有发现均有历史数据或真实复现佐证。

---

## 〇、审计范围与证据来源

- 代码：`C:/Users/14779/.workbuddy/skills/token-usage-tracker/token-tracker.js`（2214 行，只读未改）
- 历史真实数据：`.workbuddy/projects/**/*.jsonl`（98 个会话）+ 同技能目录的 `.snapshot-*` / `.coalesce-*` / `.watch-debug`
- 真实复现 harness：`audit_regression.js`（针对真实脚本，`WB_ROOT` 隔离）、`repro_r3.js`、`debug_s5.js`、`scan_history_audit.py`

---

## 一、完整状态机模型

### 1.1 `mainModelState(tail)` 取值（派生自 tail 末行）

| 状态 | 触发条件（末行） | 含义 |
|---|---|---|
| `busy` | 末行是 `function_call` / `function_call_result` / `role=user` | agent 在工具调用中 / 等待工具 / 等待用户输入 |
| `final` | 末行是 `assistant` 消息（非错误） | 轮次"看起来"结束 |
| `terminal-error` | assistant 末行带 `providerData.error`（429 / 5xx / timeout） | 真实终端错误 |
| `unknown` | tail 为空 / 半写 / 不可解析（`lastTranscLine` 返回 null） | transcript 正在重写（Compaction）或文件损坏 |

### 1.2 两条弹窗路径（Stop Hook 派发）

```
Stop 事件 / 轮次结束
   │
   ├─ plain 单 Agent (subCount==0 && !teamActive)
   │     └─► DIRECT_POP：立即 showToast（无确认窗口）★ 脆弱点 R2
   │
   └─ 专家团 / 多子代理 (subCount>0 || teamActive)
         └─► 派发 watcher（--flush-delayed）
               loop（每 3s poll）：
                 st = mainModelState(tail)
                 ├─ busy        → confirmSince=0（重置，agent 活跃）
                 ├─ final       → 若 confirmSince==0 置位；now-confirmSince>=6000 → doPop
                 ├─ terminal-error（含 unknown 经 initialTerminalError+!firstPollDone 提升）
                 │               → 同 final 走确认→doPop
                 └─ unknown      → unknownStreak++；超时阈值后放弃
                 firstPollDone=true（首轮后）
                 30min idle 超时 → break（放弃）
               doPop：写 lastStopAt + 清 coalesce + showToast + break
```

### 1.3 关键状态转换矩阵（进入/退出）

| 当前 | 事件 | 下一状态 | 备注 |
|---|---|---|---|
| 任意 | Stop-Hook 触发（plain） | DIRECT_POP | 瞬时停机也会弹 → R2 |
| WATCH/unknown | 首轮 + initialTerminalError | terminal-error（提升） | **仅首轮**（`!firstPollDone` 守卫，v2.58 修复 R1） |
| WATCH/final | 持续 ≥6s 无新活动 | POP | 确认窗口 |
| WATCH/busy | 出现新工具行 | 重置确认 | 防误弹 |
| WATCH/* | 新 Stop 事件 | 新 watcher/DIRECT_POP | 可能重复弹 → C（aa64e728 14 次） |
| WATCH/* | 旧 watcher 崩溃留锁 | 新 watcher 见陈旧锁 return | **漏弹** → B（R3） |

### 1.4 锁机制（串行化 + 致命缺陷）

- 锁文件 `.coalesce-<sid>.json.lock`，内容 `{pid, at}`。
- 进入时：若锁存在且 `at < 30min` → **直接 return（串行化/放弃）**。
- **缺陷：从不校验 `pid` 是否存活**（R3 根因）。崩溃的 watcher 留下"看起来有效"的锁，阻塞后续所有弹窗最长 30 分钟。

---

## 二、Popup 错误分类（A/B/C/D）

| 类 | 定义 | 严重度 | 本次是否确证 |
|---|---|---|---|
| **A Premature** | Popup 已出现，但同一轮 Agent 实际还在继续 | ★★★ 最高 | **是 ×2 条独立路径** |
| **B Missing** | 任务真结束，但没有 Popup | ★★ | **是（stale-lock 复现）** |
| **C Duplicate** | 同一轮结束，Popup ≥2 次 | ★ | 是（aa64e728 14 次，R1 的连锁症状） |
| **D Attribution** | Popup 出现但 token 归属错误 turn/run/session（compaction/子代理后） | ★ | 未复现，代码路径风险（见残留风险） |

**重点攻击 A** 的结果：发现两条相互独立、且 v2.58 **只修了其中一条**的 premature 路径（详见第四节）。

---

## 三、历史真实数据重扫（98 个会话）

扫描 `.workbuddy/projects` 全部 98 个 session，交叉校验 snapshot/coalesce/watch-debug。

| 指标 | 数值 |
|---|---|
| 总会话 | 98 |
| 真实 Compaction（`<conversation_history_summary>` 注入） | 13 |
| 有 Popup 记录（lastStopAt>0） | 30 |
| **A 类候选（popup 后无真实新 user 却继续）** | **1：`652f2909`** |
| B 类候选（tracker 跑过但无 lastStopAt） | **5**（细化后，已从 67 噪音中筛出） |
| C 类候选（watch-debug ≥2 start） | 2：`aa64e728`（14 start）、`7386b18a`（2 start，已证为干净单发 final，误报） |

**A 类深挖 —— `652f2909`（非压缩 premature，确证）：**
- `lastStopAt=1786764668217` 与 `lastUserMsgAt=1786764668219` **相差仅 2ms** → popup 在"最后事件"瞬间触发。
- 时间线：11:30:45 assistant 报 **502 网络错误** → 11:31:06 平台注入 `role=user` 的 `<system-reminder>`（非真人新轮）→ 11:31:08 watcher 写 lastStopAt（**立即弹**）→ 11:31:31 agent 续跑重试 → 11:34:22 被 "Interrupted by user"。
- **0 次压缩**（TAG/NEEDLE 命中 0）—— 推翻"premature 都来自压缩"的假设。这是 **Stop-Hook 瞬时停机即弹**的真实实例。

**B 类 5 候选：** `470fb702`(114条, 末活动比末用户晚40min，最可疑) / `9609fc9f` / `6480b072` / `788d4930` / `b826ce9d`（后4个均为 3–7 秒、3–5 条短会话，更像异常终止或仍在进行中，弱信号，需逐条人工确认，不断言 bug）。

---

## 四、已确认根因（CONFIRMED）

### R1 — Compaction 重写致 `unknown→terminal-error` 误提升（v2.57 bug，**v2.58 已修**）
- 触发：Compaction 重写 transcript 时尾部短暂不可读 → `tail=null` → `mainModelState=unknown`；v2.57 在 `initialTerminalError` 存在时**每轮**提升 → 误判结束 → 提前弹。
- 实证：① `aa64e728` 的 `.watch-debug`（tail=null→terminal-error→break，8 分钟后 agent 才续跑）；② `repro_v257.js` 复现 7.2s 误弹。
- 修复：token-tracker.js:1807 加 `&& !firstPollDone`（仅首轮提升）→ 下一轮 `unknown` 重置确认，不误弹。
- 状态：**已修复，本次验证通过。**

### R2 — 静默间隙 / 瞬时停机误判 final（**NEW，v2.58 未覆盖，CONFIRMED**）
- 触发（plain 单 Agent）：agent 在 502 重试停顿 / 网络瞬断 / 长 `sleep` / 平台误发 Stop-then-continue 时，Stop-Hook **无确认窗口立即弹**；agent 实际同一轮继续 → premature。
- 触发（专家团 watcher 侧）：末行是 `assistant`（final）但 agent 正处于"停顿重试"，沉默 >6s 确认窗 → watcher 误弹。
- 实证：① 历史 `652f2909`（11:31:08 即时弹，11:34:22 才被中断）；② `repro_r3.js` 真实复现 `popAt=6908ms`（6s 确认窗）premature=true，agent 在 9s 续跑。
- 根因：弹窗决策信号（"末行是 assistant"）**无法区分"轮次真正结束"与"agent 暂时空闲"**。plain 路径更脆弱（零确认）。
- 状态：**v2.58 守卫完全未覆盖，当前仍存活。**

### R3 — 陈旧锁导致 Missing Popup（**CONFIRMED，复现成功**）
- 触发：watcher A 崩溃/被杀 → 锁 + coalesce 残留；watcher B 见锁（仅校验 `at<30min`，**不校验 pid 存活**）→ 直接 return → 漏弹。
- 实证：`audit_regression.js` S2 `Stale Lock`：`lockAfterKill=true coalAfterKill=true Bexited=true` → `no popup (stale lock blocks)` → BUG。
- 状态：**当前存活。**

### R4 — 双 watcher TOCTOU（**CONFIRMED 间歇 bug**）
- 复现：`audit_regression.js` S4 `Double Watcher` 连跑两轮**结果不一致**——第一轮 `watchStarts=1`（串行化成功），第二轮 `watchStarts=2`（**两个 watcher 都执行了循环 = TOCTOU 突破串行化**）。`popped=true` 但两者都进入 watcher 循环，存在重复 doPop / coalesce 竞争风险。
- 根因：锁获取为"先读锁是否存在 → 再写锁"非原子；两个进程在极小时间窗内都判定"无锁"并同时进入循环。并发 Stop 事件（快速重 Stop、框架在 watcher 启动瞬间又发 Stop）即可触发。
- 状态：**当前存活，间歇触发；属 C 类（重复弹）潜在根因。**

### C — 重复弹窗连锁（aa64e728，R1 的连锁症状）
- `aa64e728` watch-debug 出现 **14 个 start**：premature 弹 → agent 继续 → 新 Stop → 新 watcher → 再 premature … 循环 14 次。属 R1 的后果，非独立根因。

---

## 五、真实场景测试矩阵覆盖

| # | 场景 | 分类 | 覆盖方式 | 结果 |
|---|---|---|---|---|
| 1 | 普通任务正常结束 | A/B | S1 真实 watcher | PASS |
| 2–6 | tool call / 多次 / 长时 / idle / Stop 后即续 | A | R2 覆盖"idle 后继续/错误后恢复/Stop 后即续" | **R2 BUG（premature）** |
| 7 | Stop 与新 user 接近 | A | 历史 7386b18a（多轮，干净） | PASS（非 premature） |
| 8–9 | 错误后恢复 / 真 terminal error | A/B | R2（错误恢复）+ 代码分析 | R2 暴露 |
| 10–18 | 专家团 / 多子代理全部 | A/C | watcher 路径 + S4 双 watcher | 串行化 OK；R1 连锁见 C |
| 19–21 | 普通 / 立即续 / 重写 | A | S5 + R1 | v2.58 PASS（isolated debug 确证） |
| 22–23 | tail=null / 不可解析 | A | S3 v2.58 守卫 + S5 | PASS（守卫生效） |
| 24–26 | 首次 poll / 确认窗 / 连续两次压缩 | A | S3（首轮守卫）覆盖 #24；#25/#26 代码分析 | 守卫覆盖 #24 |
| 27–30 | 压缩+tool/子代理/terminal/恢复 | A | S5 + R1/R2 | 已覆盖核心 |
| 31–40 | 时序竞态（Stop∥Compaction∥ToolResult∥poll 等） | A/B/C | S2(崩溃恢复)/S4(双 watcher)/S6(随机扰动) | S2 BUG(R3)；S4 安全；S6 稳定 |

**诚实声明**：40 场景未逐项独立跑（部分依赖真实 Stop-Hook 注入，headless 难触发）。已用"真实机制复现 + 历史实证 + 代码静态分析"三类证据覆盖最关键路径，并对 A 类（最严重）做到双重实证。

---

## 六、每 Bug 最小复现（规范输出）

### Bug R2（A Premature, 静默间隙）
- **触发条件**：transcript 末行为 assistant final，agent 沉默 > 确认窗(6s) 后续跑（同轮）。
- **Expected**：不弹，直到 agent 真正结束。
- **Actual**：6s 后误弹（`repro_r3.js` popAt=6908ms），agent 9s 续跑。
- **第一个错误状态转换**：`final` 状态在无"agent 真结束"信号下直接累计 confirmSince → doPop。
- **根因**：弹窗决策无"agent 仍存活"负信号；plain 路径零确认。
- **修复方案（未应用）**：plain 路径改派 watcher（带确认窗）或加 N 秒宽限；watcher 路径对 `final` 引入"新活动撤销确认"机制。
- **修复前/后**：前=误弹；后（提案）= 待验证。

### Bug R3（B Missing, 陈旧锁）
- **触发条件**：watcher 崩溃留锁（pid 已死），新 watcher 启动。
- **Expected**：崩溃恢复，正常弹。
- **Actual**：见陈旧锁 `at<30min` 直接 return，漏弹（`audit_regression.js` S2）。
- **第一个错误状态转换**：锁检查 `at<30min && pid 存活` 中 **pid 存活判断缺失**。
- **根因**：锁只校验时间戳，不校验持有者进程生死。
- **修复方案（未应用）**：锁中记 `pid`，进入时 `process.kill(pid,0)` 探活；pid 死亡则视为陈旧锁接管。
- **修复前/后**：前=漏弹；后（提案）= 待验证。

---

## 七、回归 Harness + 随机竞态

`audit_regression.js`（针对真实脚本，不改代码）：

```
[PASS] S1 Normal Final        (popup once)
[BUG ] S2 Stale Lock (B)      (no popup, stale lock blocks)   → R3
[PASS] S3 v2.58 Guard (A)     (no premature while alive; final pop once)
[BUG ] S4 Double Watcher (C)  (watchStarts 间歇 1→2: TOCTOU 突破串行化)  → R4
[PASS] S5 Compaction (A)      (isolated debug_s5.js: popAt=28009ms final=true premature=false)  → v2.58 守卫生效
                                       (整轮跑中偶发 never-popped = 连续真实 toast 负载导致 harness 环境 flake，非真实 bug)
[PASS] S6 Random Perturb (A/B/C)  normalOk=4/4 guardOk=4/4 (随机时序扰动稳定)
```

- **S4 双 watcher 间歇**：两轮结果不同（starts=1 / starts=2）→ 锁非原子获取，TOCTOU 确证（R4）。并发 Stop 可触发双 watcher 同跑。
- **S5 在整轮跑中曾报 "never popped"**：经 `debug_s5.js` 隔离复现，确认是 harness 在连续 4 个真实 toast 负载下的环境 flake（S5 子进程启动被拖慢/超时），**非真实 bug**；隔离调试明确 `popAt=28009ms final=true premature=false`，v2.58 守卫验证成立。
- 随机竞态（`s_random_perturb`）：0~400ms 抖动重复跑 normal/guard 变体，4/4 全过 → 当前守卫在时序扰动下稳定。

---

## 八、残留风险

1. **R2 未修复**：plain 单 Agent 在瞬时停机（重试/网络瞬断/平台 Stop-then-continue）时仍会 premature 弹。这是当前**最严重且存活**的 A 类缺陷。
2. **R3 未修复**：watcher 崩溃/被杀后，同会话最长 30 分钟内可能漏弹。
3. **D 类（归因）未验证**：Compaction 重写 transcript 后 `incrementalRecord` 是否存在 token 重复记账 / 子代理 token 归属父会话的错乱——代码路径存在风险，未构造复现。
4. **C 类连锁未根治**：R1 已修，但若 R2 发生（plain 路径零确认），仍会出现"弹→续跑→再 Stop→再弹"的重复弹；且 **R4 的 TOCTOU 在并发 Stop 时可直接让两个 watcher 同跑 → 重复 doPop / coalesce 竞争**（已确证间歇触发）。
5. **B 类 5 候选未逐条定性**：需人工确认是仍在进行中 / 异常终止 / 还是真漏弹。
6. **竞态覆盖不完整**：40 场景未全跑；真实 Stop-Hook 注入、watcher 重启竞态等极端排列未全部构造。

---

## 九、结论与下一步

- **本轮回放 + 重扫 + 真实复现，零代码修改。**
- 已确认 3 条独立根因：**R1（压缩，v2.58 已修）**、**R2（静默间隙/瞬时停机，存活）**、**R3（陈旧锁漏弹，存活）**。
- 推荐修复（待你授权后实施，不在本轮回放中改动）：R3 加 pid 探活；R2 给 plain 路径加确认窗 / 引入"续跑撤销确认"。
- 是否继续：① 对 R2/R3 建立独立副本验证修复；② 补 D 类归因复现；③ 跑满 40 场景极端竞态。
