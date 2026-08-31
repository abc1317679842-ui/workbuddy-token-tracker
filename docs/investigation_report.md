# Worker Buddy — Context Compaction 提前弹窗 排查闭环报告

> 方法原则：**优先用现有后台历史真实数据取证**，历史无法回答的部分才建立真实机制复现。
> 定位到的可编辑根因代码：`C:/Users/14779/.workbuddy/skills/token-usage-tracker/token-tracker.js`
> （Popup/Watcher/Stop Hook/coalesce/lastStopAt/mainModelState/initialTerminalError 全部在此实现）

---

## 一、历史真实数据统计

| 指标 | 数值 |
|---|---|
| 扫描的真实 session（主 transcript） | **36** |
| 发生真实 Context Compaction 的 session | **10**（共 **50** 次压缩事件） |
| ├ 专家团 / 多 Agent（含子代理） | **8** |
| └ 普通单 Agent | **2** |
| 无压缩会话（基线） | 26 |
| WATCHER 路径（专家团，coalesce+`--flush-delayed` 后台 watcher） | 8 会话；其中 **aa64e728 有 `.watch-debug` 实证** |
| DIRECT_STOP 路径（普通 Agent，Stop 即弹） | 2 压缩会话 + 26 无压缩会话 |
| 其它路径 | 0 |

真实 Compaction 判定标准：transcript 中出现 `role:user` 且内容含 `<conversation_history_summary>` 的注入消息（排除 Agent 推理中**引用**其它 transcript 的假阳性）。10 个压缩会话**全部**在压缩后继续产生了 assistant/function_call（agent 续跑）。

---

## 二、已确认的根因

所有根因区分：**CONFIRMED（真实日志/复现） / LIKELY（证据较强未完全复现） / UNPROVEN（未证实）**

- **R1 — v2.57 watcher「每轮轮询把 unknown 提升为 terminal-error」（CONFIRMED）**
  Context Compaction 重写 transcript 时尾部短暂不可读 → `lastTranscLine` 返回 null → `mainModelState` 返回 `unknown`。v2.57 在 `initialTerminalError` 存在时**每一轮轮询**都把 `unknown` 提升为 `terminal-error` → 进入确认期 → watcher 误判 Run 结束 → **提前弹窗**。
  - 实证①：`aa64e728` 的 `.watch-debug`（第 48 行压缩 continue `message:user` → 第 52 行 `tail=null` + `terminal-error` → 第 54 行 `break`；第 55 行 **8 分钟后**才启动新 watcher = 误弹后 agent 继续跑了数小时）。
  - 实证②：用 v2.57-emu 副本复现 → **7.2s 误弹**（压缩窗口内）。

- **R2 — v2.58 修复有效性（CONFIRMED，本次验证）**
  v2.58 将提升限制为**仅首轮**（`!firstPollDone` 守卫，token-tracker.js:1807）。
  - 真实脚本复现：压缩期尾部不可读 → 首轮提升为 terminal-error，但**下一轮 unknown 因守卫不再提升→`confirmSince` 被重置** → 不误弹；agent 真正结束后**精确弹 1 次**（Final=1, Premature=0）。watch-debug 直接印证该机制。
  - 结论：R1 在 v2.58 已被覆盖。

- **关于 652f2909（修正归因）**：该会话**末次弹窗比最后活动早 194s、同轮续跑**= 一次提前弹窗，但经核实它 **0 次压缩**，属「通用 unknown 提升误弹」而非压缩触发；其确切成因无 watch-debug 佐证（**UNPROVEN 具体成因**）。v2.58 修复覆盖该通用缺陷，但**不能把它当作"压缩导致"的实证**——此前归因过度。

- **普通 Stop Hook 路径（CONFIRMED 安全）**：2 个普通压缩会话均在**真实结尾**弹窗（`lastStopAt` 仅比 `last_event` 晚 115/185ms），无提前弹窗。Stop 仅在真正轮次结束时触发，压缩对 Agent 循环透明——**它不是独立的提前弹窗根因**，未与 watcher bug 混淆。

---

## 三、修复内容

- **F1（已由前序 Claw 会话在 v2.58 实施，本次仅验证，未改代码）**：`token-tracker.js:1807`
  将 `if (st === 'unknown' && initialTerminalError)` 改为 `if (st === 'unknown' && initialTerminalError && !firstPollDone)`。
- 验证方式：真实机制复现（见第四节），未做任何代码修改（遵循"无复现/证据不足不修改"）。
- 为何不再额外改：首轮提升在「下一轮仍 unknown→重置」机制下**无法持续触发误弹**（已逻辑+复现证明）；仅当下一轮变为**真实** terminal-error 时才弹，而那是正确的（agent 真死）。无证据表明需进一步改动。

---

## 四、测试结果

| 项目 | 数值 |
|---|---|
| 历史真实 Compaction 次数 | **50**（10 会话） |
| 历史提前 Popup 次数（PRE-v2.58） | **≥1 确证**（aa64e728）+ 652f2909（成因未证、非压缩） |
| v2.58 下「真实机制」复现 — Premature Popup | **0** |
| v2.58 下「真实机制」复现 — Final Popup | **1** |

**目标达成：Premature = 0，Final = 1 ✓**

复现说明：`repro_v257.js` 用 9000 个 `x` 填满 8KB 尾部窗 → 真实 `lastTranscLine` 返回 null → 真实 `mainModelState` 返回 `unknown`（watch-debug 见 `tail:"null"`），完整走通真实压缩「尾部不可读」路径；对照 v2.57-emu 副本 7.2s 误弹，v2.58 真实脚本 0 误弹且精确 1 次末弹。

---

## 五、残留风险

1. **UNPROVEN/低**：首轮提升在「下一轮 unknown→重置」下不会持续误弹，已证明安全；仅当下一轮确为真实 terminal-error 才弹（正确）。无证据需进一步改。
2. **运行时伪 Stop（UNPROVEN）**：若运行时在压缩期间**伪触发 Stop**，普通 Agent 会立即弹（DIRECT_STOP 路径）。历史无证据；token-tracker 无法感知运行时 Stop 真伪，须由运行时侧处理，非本技能范围。
3. **扫描判定缺陷（已披露）**：`scan_phase1.py` 的"提前弹窗"判定未把压缩 continue 用户消息计入 new_user 基线，可能虚报进行中/压缩续跑会话（如 `7386b18a` 被误标 PREMATURE，但它正是**进行中**的当前会话，应排除）。该判定仅用于排疑，最终结论未引用该假阳性。
4. **复现代理性（已披露）**：harness 用"写入不可解析末行"代理"尾部不可读"，未真正触发 `<conversation_history_summary>` 重写事件；但 bug 本质（不可读尾→unknown）被真实复现，真实压缩触发证据来自 aa64e728（运行中 `tail=null`）。

---

## 六、独立审查结论（Phase 6）

独立审查 Agent 复跑脚本并逐行核对代码/日志，确认：36/10/8/2/50 分类成立；aa64e728 实证确凿且 v2.58 守卫可挡；普通路径正确排除；复现走真实 `mainModelState`/`--flush-delayed` 机制；真实代码未改。
审查修正两点（已纳入本报告）：① 652f2909 无压缩，属通用 unknown 提升误弹而非压缩触发，去掉过度归因；② 扫描误弹判定对压缩续跑有虚报风险，已披露。
**无代码被修改。**
