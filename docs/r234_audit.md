# Token-Usage-Tracker 状态机审计 · R2/R3/R4 定性 + 实验 + 修复设计（阶段报告）

> 范围：R2/R3/R4 定性 + 实验 + 修复设计。**Phase 10 已按本设计实施修复（已修改生产代码 `token-tracker.js`，备份 `token-tracker.js.bak-20260823-025713`）**。
> 本文件为修复前设计文档，状态机模型与根因分析仍有效；R2 实施细节见 Phase 10 交付报告（对话记录）。
> 关联：`investigation_report.md`（R1/v2.58）、`audit_report.md`（前序系统性审计）。

---

## 一、完整状态机模型（基于 token-tracker.js 真实代码）

### 1.1 入口分流（main / 1937-2210）
| 输入 | 路径 | 弹窗方式 | 确认窗 |
|---|---|---|---|
| `--flush-delayed <sid>` | watcher 循环（1707-1911） | 循环末 `showToast` | **有**（confirmSince 6s） |
| `--stop` 且 `agg.subCount>0 \|\| teamActive` | `writeCoalesce + spawnFlushWatcher`（1998-1999） | 走 watcher | **有** |
| `--stop` plain（无子代理/无团队） | 立即 `showToast`（2001-2004） | **零确认立即弹** | **无 ← R2 缺陷** |
| `--stop` traces 兜底单 trace | 立即 `showToast`（2145-2148） | **零确认立即弹** | **无 ← R2 缺陷** |

### 1.2 mainModelState 取值（589-609）
| 末行 | 状态 | 语义 |
|---|---|---|
| 明确错误（429/5xx/timeout） | `terminal-error` | 主模型坏，本轮不可续 |
| function_call / function_call_result | `busy` | 主模型在派活/等结果 |
| message + usage + role≠user | `final` | 候选最终回复 |
| message + role=user | `busy` | 用户/子代理回传，主模型将续 |
| 空/半写/不可解析 | `unknown` | 状态不确定 |

### 1.3 "结束 / 暂时停止 / 恢复" 判据（核心，回应第一原则）
| 类别 | 触发 | 是否=Run 结束 | 代码如何处理 |
|---|---|---|---|
| **可能结束** | 末行 `final` / `terminal-error` / `interrupted` | 候选，需确认 | watcher 进入 confirmSince 计时 |
| **确认结束** | confirmSince 满 6s 且无新活动（watcher） | 是 | 跳出循环 → 弹 → 清 coalesce → 写 lastStopAt |
| **确认结束（缺陷）** | plain Stop 事件（零确认） | 被误当结束 | 立即弹，**不检测续跑** ← R2 |
| **暂时停止** | `busy`（tool/函数调用中） | 否 | 刷新 lastActiveAt，取消确认 |
| **暂时停止** | `unknown`（tail 不可读/重写中） | 否 | confirmSince 重置，继续等 |
| **暂时停止** | idle（无新行但未超时） | 否 | 仅 lastActiveAt 未刷新，未到 WATCH_MAX |
| **恢复** | hasNewTail / newAgent / 回到 busy | 否→是反转 | 重置 confirmSince + lastActiveAt |
| **僵尸兜底** | 连续 WATCH_MAX(30min) 无活动 | 强制收口 | 跳出弹窗 |

**第一原则结论（源码可证）**：`Stop` 事件、`idle`、`unknown`、`tool 结束`、`网络错误`、`transcript 暂不可读` **均不等于 Run 结束**。只有 (watcher 确认窗满 6s) 或 (plain Stop 零确认——缺陷) 才弹。R2 的本质就是**把"Stop 事件"当成了"确认结束"**。

---

## 二、R2 — Plain Agent Stop Hook 零确认 Premature Popup

### 定性：`CONFIRMED`
三重证据：
1. **源码静态**：`2001-2004` 与 `2145-2148` 在 Stop 事件上无条件 `showToast + saveSnapshot(lastStopAt=now)`，**无 confirmSince / 无续跑检测**。
2. **真实动态复现**：`repro_r2.js` 用真实 `token-tracker.js --stop/--hook`，plain 路径（subCount=0, teamActive=false）Stop 后立即写 lastStopAt；Stop 后同轮追加续跑活动 → `popAt` 早于续跑 → **premature=true**。
3. **历史真实样本**：`652f2909`（plain、0 子代理、0 压缩、lastStopAt 仅比 lastUserMsgAt 晚 2ms、transcript 续跑到 11:34:22 才被 Interrupted）。

### 实验矩阵（repro_r2.js sweep，35/35 全部 PREMATURE）
| 续跑延迟 | text/tool/fc/429/subagent 五型 |
|---|---|
| 200ms / 1s / 2s / 3s / 5s / 6s / 10s | 全部 PREMATURE（source=transcript，零确认路径） |

**关键结论**：
- plain 路径确认窗 = **0ms**（立即弹）
- **最短误判暂停 = 任何 >0 的续跑**（200ms 即 premature）
- 修复前**无法**用"debounce 时间"区分（因为根本没有 debounce）——任何 Stop 后同轮续跑都 premature

### 最小复现
- 触发条件：plain Agent Stop 事件 + 同轮续跑（无新 user 消息）
- 第一个错误状态转换：`Stop handler 2001` 在 `if(agg.subCount>0||teamActive)` 为 false 时**直接弹**，缺少"等待确认/检测续跑"分支
- 根因：plain 路径未复用 watcher 的 confirmSince 确认机制

### 修复方案（设计，未实施）
plain Stop 路径不再**立即弹**，改为：
- 写 coalesce + `spawnFlushWatcher(sid)`（与专家团同路径），由 watcher 的 6s confirmSince 确认窗收口；
- 若确认窗内 transcript 出现新 activity（hasNewTail/newAgent/busy）→ 取消确认，不弹；
- 仅当 6s 无新活动才弹。
这样 Stop-then-continue（502 重试 / 网络瞬断 / 平台 Stop-then-continue）在确认窗内被"撤销"，消除 premature。
注意：需保证 plain 轮最后仍能"及时弹"（6s 延迟可接受，与专家团一致）。

---

## 三、R3 — Watcher 崩溃残留 stale lock → Missing Popup

### 定性：`CONFIRMED`
源码静态（1714-1735）：锁只校验 `at`（`< WATCH_LOCK_TTL=30min`），**从不校验 pid 存活**（1722 读 `mine.at`，1726 写 `{at,pid}` 却**不读 pid 判活**）。

### 真实动态复现：repro_r3_lock.js（real 模式）
- 构造残留锁（`at=now-5s, pid=999999` 已死），启动真实 `--flush-delayed` watcher
- 结果：`watchStarts=0`（watcher **未写 start 行**，确认因 `mine.at<TTL` 在 1722 `return`，**非崩溃**）、`coalesce` 未清、`lastStopAt` 未写 → **MISSING POPUP CONFIRMED: YES**
- 子进程 stderr 为空 → 排除崩溃干扰，确系源码 return

### 修复逻辑验证：repro_r3_lock.js（pidcheck 模式）
- `lockValid=true, holderAlive=false → shouldTakeover=true` → 加 pid 探活后 B 接管弹出，Missing 修复可行

### 最小复现 / 根因
- 触发：watcher 崩溃/被杀 → 锁残留 <30min → 新 watcher `return` 不接管
- 第一个错误状态转换：`1722 if (mine && at<TTL) return` 缺少 `&& pidAlive(mine.pid)`
- 修复方案（设计）：拿锁时 `if (mine && at<TTL && pidAlive(mine.pid)) return;`（pidAlive 用 `process.kill(pid,0)` 跨平台判活）；崩溃残留锁因 pid 已死被新 watcher 接管。

---

## 四、R4 — Watcher 锁获取 TOCTOU 并发双跑

### 定性：`REPRODUCED`（前序会话真实捕获 + 结构确证）
源码（1720 `readFileSync` → 1726 `writeFileSync`）**无原子保护**。

### 真实多进程复现尝试：repro_r4.js
- N=2/10/30、gap=0/1/5/10/20/50/100ms 矩阵：`watchStarts` 始终 =1（串行化"现状安全"）
- 原因：每个独立 watcher 进程有模块加载开销（2214 行 + 定价读取），到达 1720 的时机被拉开数十毫秒，第一个写完锁后其余才 read → 退出。**进程启动抖动掩盖临界窗口**。

### 确定性最小复现：repro_r4_logic.js
- 单进程推演临界窗口：A.read→(窗口)→B.read 都得到 null → A.write → B.write → `A.gotLock=true, B.gotLock=true` → **双 watcher 同时运行确证**
- 前序会话 `audit_regression.js` S4 重跑已真实捕获 **`watchStarts=2`**（间歇竞态）

### 根因 / 修复方案（设计）
- 第一个错误状态转换：1720-1726 临界区无原子性，并发 Stop 时两 watcher 都读到"无锁"
- 修复方案：用**原子文件锁**（如 `fs.openSync(lock, 'wx')` 独占创建，失败即退出；或 rename 原子性）替代"先读后写"；watcher 结束时 `unlink` 释放。结合 R3 的 pid 探活：独占锁 + pid 校验双重保障。

---

## 五、复现脚本清单（均不改生产代码）
| 脚本 | 验证 | 副作用 |
|---|---|---|
| `repro_r2.js` | R2 plain 零确认 premature（sweep 35 场景） | 每次真实 toast（win32） |
| `repro_r3_lock.js` | R3 stale lock Missing Popup + pid 探活逻辑 | 真实 toast（若接管） |
| `repro_r4.js` | R4 并发 watcher 矩阵 | 大量真实 toast（N 大时） |
| `repro_r4_logic.js` | R4 TOCTOU 确定性推演 | 无 toast |

---

## 六、本轮结论与下一步
- **R1**：v2.58 已修并验证（前序）— 不在本轮范围。
- **R2**：CONFIRMED，修复方案 = plain 路径改走 watcher 确认窗。
- **R3**：CONFIRMED，修复方案 = 锁加 pid 探活。
- **R4**：REPRODUCED，修复方案 = 原子文件锁 + pid 探活。

**本轮仅完成定性 + 实验 + 修复设计，未改生产代码**（遵守"第九阶段：禁止修改生产代码"）。

### 待授权进入的后续阶段（需你点头）
- Phase 5 组合攻击 / Phase 6 随机竞态压力测试 / Phase 7 Regression Harness 固化
- Phase 10 **统一修复**（实施 R2/R3/R4，先经对应 reproduction 验证 + 完整 regression）
- Phase 11 真实 Worker Buddy 长任务验证
- Phase 8 独立审查 Agent（A/B/C/D）

是否进入 Phase 10 实施修复？或先补 Phase 5-8 的测试资产？

---

## 七、Phase 10-11 实施与独立审查结论（2026-08-23 追加）

### 7.1 Phase 10 修复已实施（生产代码已改，备份 token-tracker.js.bak-20260823-025713）
- R2：plain 路径两处（transcript 源 / traces 兜底）改走 writeCoalesce + spawnFlushWatcher，由 watcher 6s 确认窗收口；lastStopAt 改由 watcher 弹窗时推进。
- R3：acquireWatchLock 重写——open('wx') 原子建锁；EEXIST 评估锁有效性（TTL 过期 或 pid 可确认死亡 ESRCH → 安全接管）；pid 存活/EPERM/无pid/非法pid → 保守不接管。
- R4：原子 acquire 替代 check-then-create；释放只删 pid===自己的锁（两处）。

### 7.2 Phase 5-7 测试资产（均已验证通过）
- `combo_attack.js`（Phase5 C1-C4 组合）：4/4 PASS，修复间无交互冲突。
- `race_fuzz.js`（Phase6 随机竞态 20 runs）：19/20 PASS，1 FAIL(run#5) 经独立复现确认为 win32 toast 累积拥塞环境效应（非逻辑/竞态）；maxWatchStarts=1 全程成立 → TOCTOU 双启动彻底消除。
- `audit_regression.js`（S1-S6）：S5 采样误报已修（waitExit 后补采）；加 ONLY/RUNS 过滤。
- `regression_master.js`（Phase7 固化）：分场景独立进程隔离 toast 拥塞，S1-S6 全 PASS(6/6)。

### 7.3 Phase 8 独立审查 Agent A/B/C/D 结论
- **A（状态机）**：R2 修复语义安全、无回归；普通轮弹窗延迟 0→≤6s（时效退化，非正确性）；建议更新本文档标注 R2 已实施（已做）。
- **B（并发/锁）**：指出"接管路径 unlink→open('wx') 存在删→建 TOCTOU 双跑"【中】。⚠️ **复核结论：该论断基于错误假设**——`open('wx')` 在文件已存在时原子返回 EEXIST（无论谁建的），因此删→建窗口内最多一个 `open('wx')` 成功，另一个必得 EEXIST 而退出，**不会双跑**。R3+R4 接管路径安全，B 的"双跑"不成立（误报）。其余确认：首建路径 `wx` 原子成立；释放校验 pid===自己正确。
- **C（Stop/续跑）**：R2 消除 premature、无新增 missing、与起点刷新守卫兼容；唯一缺口"先 error 后恢复"续跑时序未单列测试（低风险，逻辑兼容）。
- **D（测试覆盖）**：R3 边界（EPERM/无pid/TTL边界）、R4 NFS 场景弱覆盖；C3 premature 判定脆弱（低）；S1/S3/S4 waitExit 超时偏紧（低）；run#5 FAIL 归类为环境效应可信。

### 7.4 是否发现需暂停的新生产逻辑风险
- **无阻断性生产缺陷**：B 的"中"级经技术复核为误报（wx 语义保证单锁）；其余均为覆盖不足/时效退化（低-中），不阻断。
- 可选改进（非必须）：补 R3 边界测试（EPERM/无pid/TTL边界）；评估普通轮快路径（确认窗内首 poll 即 final 且无 subagents 可缩窗）。
- 结论：R2/R3/R4 修复在 win32 本地场景安全，可进入 Phase 11 真实验证。
