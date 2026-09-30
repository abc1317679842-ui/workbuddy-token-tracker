---
name: token-usage-tracker
description: 在每次回答结束后弹出 Windows 系统通知（toast），显示本条真实 token 消耗、耗时与费用估算；并在本地记录每日分模型账本（各模型输入/输出/缓存命中/总 token/金额 + 当日合计，长期保存可查历史）。【仅适配 WorkBuddy 桌面客户端（Windows），不适用于其他 AI 工具/平台——数据源是 WorkBuddy 每轮调用后落盘的 trace/transcript 文件，依赖其 hooks 机制】WorkBuddy 客户端不显示 token（内置模式只显示积分、自有 API 模式也不显示），但每轮 LLM 调用结束都会把真实 token/耗时落盘。本技能通过 Stop hook 读取该数据，在每次回答结束后自动弹出 toast（模型名/耗时/今日累计/输入输出 token/费用），同时把本轮消耗按模型累计进 `daily-usage.json` 每日账本；`--hook` 模式在下一轮提交时把上一轮用量注入上下文作兜底；`--report` 命令可查看今日/历史每日明细与合计，并支持区间（周 / 月 / 任意日期段）汇总、CSV 导出、消耗外推，以及每轮轮次明细留档。当用户说「显示 token」「看消耗」「这次用了多少 token」「统计用量」「看每日消耗」「看历史用量」「这周/最近 7 天用了多少」「这个月消耗」「9 月 1 号到 30 号」「照这速度还能用多久」「只要个总数」「导个 CSV」「上一轮用了多少」或任何希望看到每次回答成本时触发（每种问法对应的命令见「自然语言问法 → 命令映射」一节）。本技能每 7 天匿名查一次仓库版本（同时查 release 与 tag，取较大者），有新版本时在回答末尾提示一句（每版本最多 2 次；没配 UserPromptSubmit hook 的机器改走弹窗标记）。统计的是 WorkBuddy 落盘的消耗，不等于用户账上被扣的全部消耗——中途手动停止的长思考本地不落盘、只能估算且通常偏低，内置积分模式的额度扣减也读不到，对账须以服务商账单/积分记录为准。token 用量为平台落盘的实测值；金额为按 API 单价折算的等价计价——自备 API key 模式下等同真实花费，内置模型模式下只是参考值，与客户端积分/额度无换算关系。
type: skill
---

# Token Usage Tracker（每轮 token 消耗追踪）

## 环境要求（新用户先看）
- **仅适配 WorkBuddy / CodeBuddy 桌面端（Windows 10/11）**：本技能的数据源是客户端落盘的 `~/.workbuddy/traces/<pid>/trace_*.json`（每轮模型调用结束自动生成）+ 客户端 hooks 挂载点——**其他 AI 工具/平台（Claude Code、Cursor、ChatGPT 桌面版、其他 OpenClaw 客户端等）没有这套机制，装上也不会工作**，请勿在其他环境安装。
- **Windows 10/11**：系统通知（toast）仅 Windows 支持；macOS/Linux 可正常手动使用（方式 A），但不弹通知。
- **Node.js ≥ 20**：脚本零依赖单文件，无需 npm install。
- **Python 3 + `requests`**（可选）：国内厂商官方价格库流水线（`fetch-cn-prices.py` 等 3 个脚本）需要；缺失时该功能降级为聚合源价并持续弹 `⚠价库缺失` 提示，token 统计与 toast 不受影响。

## ⚠️ 常见故障：通知「不弹横幅」（Windows 会静默"长期没点开"的应用通知）

> 2026-09 实机遇到并已定位修复，**放在最前面**，因为现象诡异、极易误判成"技能坏了"。

**症状**：技能本身正常（账本、日志都在更新），但通知**还有提示音、在「通知中心」（Win+N）里也能翻到**，**唯独右下角不再弹出横幅**了。

**根因**：Windows 有个「**通知建议**」机制（内部名 `SmartOptOut`）—— 系统发现你对某应用的通知**长期不点开**，就会弹一条建议问你"要不要关掉这个应用的通知"；**无论你点了确认，还是系统按习惯自动降级**，它都会在注册表里给该应用写下：

```
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AppId>
    ShowBanner     = 0            ← ★横幅被关（"不弹"的直接原因）
    LastOptOutTime = <时间戳>      ← 那次"关闭"操作的记录
```

实机证据（2026-09-26 本机）：`ShowBanner=0`、`LastOptOutTime=1790248477`、`PeriodicNotificationCount=52`；同机 `Windows.ActionCenter.SmartOptOut` 项也已存在（说明建议机制确实触发过）。

**为什么在「设置 → 系统 → 通知」里找不到这个应用**：本技能的 toast 用**自定义 AppId「WorkBuddy Token Tracker」**直接调 Windows API ——
`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('WorkBuddy Token Tracker').Show($t)`
它**不是已安装应用**，因此**不出现在设置的应用列表里**（这是刻意设计：不经过 WorkBuddy 客户端通知开关，两者互不影响）→ **只能用注册表改**。

**解决方法（普通权限，无需管理员）**：

> ⚠️ **约束（必须遵守）**：以下命令会修改用户注册表。仅当用户明确同意"帮我修通知横幅"后才执行；执行前先说明要改哪两项、改完如何回退。**禁止**把"直接改注册表"当作"没弹窗"的默认第一反应（先查本表其余排查点）。

```powershell
# ① 重新打开横幅（必做）
Set-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\WorkBuddy Token Tracker" -Name ShowBanner -Value 1

# ② 关掉"通知建议"，免得以后又被问"要不要关掉该应用通知"（可选但推荐）
$k = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.ActionCenter.SmartOptOut"
New-Item -Path $k -Force | Out-Null
New-ItemProperty -Path $k -Name Enabled -Value 0 -PropertyType DWord -Force | Out-Null
```

**验证**（回显 `ShowBanner : 1` 即已恢复）：

```powershell
Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\WorkBuddy Token Tracker" | Select-Object ShowBanner
```

**实测结果**：2026-09-26 执行 ① 后**当场恢复**（`ShowBanner 0 → 1`，后续弹窗正常）。

**其他会让横幅消失的原因**（若上面无效，按此顺序排查）：专注助手/免打扰（含自动规则：全屏、游戏、投影时段）→ 该应用通知总开关 → 电量节能限制后台活动 → 全屏应用抑制横幅 → 系统时间/时区异常。这些都在「设置 → 系统 → 通知」里可核对；**只有"自定义 AppId"这一类（本技能）必须走上面的注册表法**。

## 当前功能总览（v3.22.1 · 2026-10-01，版本以 manifest.yaml 为准）

> **v3.22.1 要点（2026-10-01）：把「怎么问 → 得到什么表」写进文档（纯文档版，代码零改动）。** 起因是用户追问「介绍和技能里有没有说清楚？怎么通过问模型得到不同的数据表格？」——逐条核过后确认：**功能 v3.20.0 就有**（`week` / `month` / 任意区间 / `forecast` / `--csv`），但**两份文档里从头到尾没有一份「自然语言问法 → 命令」的对照**，两头都抓瞎。本次补两处：① **SKILL.md 新增「自然语言问法 → 命令映射」强制表**（这是触发层——用户说「这周用了多少」，你必须跑 `--report week`，**不许**跑 `--report all` 让他在几十天里自己找；区间必须让脚本一次出表，你自己按天相加会把命中率算错）+ 反模式表；② **README 新增「怎么查消耗：直接问模型就行」章节**，含问法→表格对照表与 **6 段真实输出示例**。另如实写明两个拿不到的东西：**单轮明细没有 CLI 入口**（只有 `rounds/*.jsonl`，账本粒度是天）、**拿不到小时粒度**（按天分桶）。
>
> **v3.22.0 要点（2026-10-01）：版本更新提示的检测点修准 + 覆盖盲区补齐。** 起因是用户质疑「检测的点准确吗？不准确会导致别人收不到更新」——逐条实测后确认 **2 处真缺陷**：①**挂载点被早退分支绕过**：v3.21.0 把提示挂在两个 `out()` 调用点上，而 `--hook` 路径有 3 条早退分支（`trace 文件尚未完成写入`、手动取消轮补弹 等）走的是**另外的** `out()`，命中这些分支的那一轮根本不会带上提示。修法：追加逻辑**下沉到 `out()` 内部**、检查提前到 `main()` 最开头算一次缓存 → 只要这一轮有任何 hook 输出就必然带上，**结构上不可能再被 `return` 绕过**（新增早退分支也自动覆盖）；实测已确认「暂无 trace 数据」这类早退分支同样带上提示。②**检测点漏「有 tag 无 release」**：v3.21.0 只查 `releases/latest`，某次只打 tag 不发 release（或顺序颠倒）就会漏报。修法：**同时查 `git/matching-refs/tags/v`，两者取版本号较大者**（宁可早报不可漏报；两次请求合并在同一个子进程里，实测总耗时约 1.5s）。③**补覆盖盲区**：只配了 `Stop`、没配 `UserPromptSubmit` hook 的用户**永远**触发不了注入通道 → Stop 端按 `lastHookAt`（每次 `--hook` 刷新）判断，超过 **3 天**没动静就认为"没配 hook"，改走 **toast 兜底**：弹窗前做同一套检查，命中就在**弹窗第一行尾部**加 `｜⬆vX.Y.Z`，**放不下就整个不显示**（绝不触发缩略模型名、绝不动第二行的耗时/今日/余额）。已配 hook 的用户**永远不会**看到该标记，不产生打扰。④**回归**：`--report` 五种入口 + 手动模式 + `--hook` + `--stop` 共 8 种输出与 v3.21.0 **逐字节相同**（`cmp` 验证）。
>
> **v3.21.0 要点（2026-10-01）：版本更新提示（每周一次、匿名只读、注入给模型）。** —— 装了旧版的用户不会主动去仓库看更新，本版起每 **7 天**匿名查一次 `releases/latest`，有新版就**向模型注入一行极短提示**，由模型在回答末尾带一句。①**为什么不用弹窗**：toast 第二行实测 ≈41u、上限 42u，再塞内容必然触发降级链（丢余额 → 丢今日价 → 保底耗时）→ 等于**用本轮真实数据换一句提示**；独立再弹一条又会被 Windows SmartOptOut 静默关掉且阅后即焚。②**为什么走 `--hook` 注入**：不占显示空间、载体是用户必然会看的回答本身，已有现成先例（新模型未收录提醒走的就是这条通道）。③**规格**：只在提问时触发（**绝不放 `--stop`**，联网会把 toast 推迟）；超时 5 秒；失败**完全静默** + 退避 1h→6h→1d（连败 3 次当周不再试）；同一新版本**最多提示 2 次、间隔 ≥24h**；版本比较按 `major.minor.patch` **逐段转整数**（直接字符串比较会把 `3.9.0 > 3.10.0` 判成 true）。④**注入文案不含任何升级步骤**（`[技能更新] 有新版 vX.Y.Z，回复末尾提一句即可，勿展开`）——**升级操作只写在本文件的「版本更新提示与如何升级」章节**，模型照那一节回答追问即可。⑤**开关**：`ENABLE_UPDATE_CHECK`（默认 true，`local-config.json` 写 `{"enable_update_check": false}` 可关）。⑥**边界（务必如实告知）**：**帮不了「已装旧版」的存量用户**——检查逻辑在被安装的那份代码里，旧版没有它；也不做全自动更新（安装方式是拷目录，自动覆盖会动用户文件）。
>
> **v3.20.0 要点（2026-10-01）：账本查询能力扩展 + 轮次明细留档（两项一起）。** —— ①**区间报表**：`--report` 新增 `week` / `month` / `<起>..<止>`（任意闭区间，起止写反自动纠正）→ 输出**一张按模型的汇总表**，列结构与单日入口**完全一致**。区间命中率按 **`hitRate(Σ输入, Σ缓存)` 重算**，不是各天 hit 的算术均值（跨天 token 量可能差 100 倍，均值无意义）；`total` 保持逐日累加，便于与逐日核对账。**既有 `--report` / `--report <日期>` / `--report all` / `--report summary` 四条入口的输出逐字节不变**（`selftest` 有硬编码期望输出的断言兜底）。②**CSV 导出**：`--report <范围> --csv`（同样支持 `all` / 单日 / 不带参数=今天）→ 落盘 `exports/report-<范围>-<时间戳>.csv`，内容为**逐日 × 逐模型**明细 + `ALL` 合计行；**必须带 UTF-8 BOM**（否则 Excel 打开中文列头乱码——与 `loadDailyUsage` 剥 BOM 是同一个坑的两面）；命令只回一行路径，不把几十行数据灌进上下文。③**消耗外推** `--report forecast`：**只推 token、不推金额**——金额本身是按 API 单价折算的虚拟计价，在虚拟数上再外推一次只会制造「这个月要花多少钱」的错觉；样本 < 2 天时拒绝计算。④**轮次明细留档**：每轮向 `rounds/rounds-YYYY-MM.jsonl` 追加一条，含分模型 token 明细、耗时、主/子代理模型、子代理数、`source` 来源标记、`costApiEquiv`，以及**从本轮首条非注入型 user 消息自动提取的 `label`**（注入型标 `[注入] <类型>`）——用来回答「哪一轮异常大 / 子代理占了多少」这类每日账本答不了的问题。⑤**落点决策（关键）**：明细**只写在 `recordUsage` 一处**（账本确认落盘之后、锁内），而不是在 Stop 的 4 个互斥出口各写一遍——于是「同轮重复 Stop 不重复落档」由记账自身的幂等性白送，无需额外维护去重状态；`meta` 是**可选参数**，其余 8 个调用点不传即完全保持旧行为。⑥**金额口径（硬规矩，README 同步声明）**：`in/out/cached/total` 是平台落盘的**实测值**；金额一律按 `pricing.json` 的 API 单价折算，**不是真实扣费**——内置模型走客户端自带额度，本技能读不到额度扣减，**不做任何「金额 ↔ 积分」换算**（自备 API key 模式下才等同真实花费）。明细字段名直接写成 `costApiEquiv` 就是为了防后人误当真实花费。⑦**自测**：`selftest.js` 新增 T11 段 30 项（含「既有入口逐字节不变」硬编码断言、区间 hit 重算、CSV BOM 字节、明细幂等、`label` 提取与注入识别），**80 过 0 败**；另跑隔离端到端：Stop 主路径（账本 md5 与 v3.19.3 基线**逐字节相同**，同时落 1 条明细）、重放同一轮 Stop（不重复落档）、专家团 `--flush-delayed` 路径（落 1 条 `source=flush-delayed` 明细且正常收口）。
>
> **v3.19.3 要点（2026-10-01）：压缩弹窗判定整体降级——删掉一套从未生效过的死机制，只留一个真正管用的单点豁免。** —— ①**取证**：全量复核 `token-tracker-toast.log`（1560 条）/ `token-tracker-compaction.log`（3006 条）——`compactionMode=true` 出现 **0 次**、`compression-omen/resumed/timeout` 各 **0 次**、185 次 `flush-watch-start` 快照命中压缩标记 **0 次**、1158 次 `stop-transcript` 仅 **6 次**命中（0.5%）。②**根因（三层）**：v3.01 把普通轮改为 Stop 端同步弹窗后**不再 spawn watcher**，而压缩判定只活在 flush watcher 内 → 占全部弹窗 **55%（862/1560）** 的 `plain-immediate` 路径完全绕过它；且压缩标记在**压缩完成瞬间**落盘，等 Stop 触发时 transcript 已追加成百上千行、标记早已滑出末尾 30 行窗口；语义上也错位——标记出现时压缩已结束、模型已恢复输出。③**认知纠偏（重要）**：压缩后弹出的窗口 **99% 是那一轮的正常结算弹窗**（实测 12 次压缩现场后 9 次弹窗，内容为真实用量：输入 4.9万~70万、耗时 46s~8m24s）——**压掉它就是丢数据**，不该抑制。④**真正该修的是压缩期噪音**：2026-09-12 07:31 一个现场 18 秒内连弹 3 条「本轮无 token 消耗记录」，而该分支在 Stop 路径上、原 watcher 判定同样够不着。⑤**处置**：删除 `compactionMode` / `compressionPending` 两套状态机（含每轮末尾 30 行扫描 + 每轮末尾 5 行的超长前兆扫描）+ 死函数 `contextOverflowOmenTs` / `contextOverflowOmen` + 死常量 `WATCH_COMPACT_GRACE_MS` / `COMPRESSION_WAIT_MAX_MS`；新增 `freshCompactionMarker()`（末尾 30 行内存在压缩标记**且**该标记行 timestamp 距今 ≤10 分钟，`COMPACTION_MARKER_TTL_MS` 可调）作为 Stop 端 `no-token` 分支的**单点豁免**——命中则静默跳过弹窗（落 `stop-no-token-compaction-skip`），`lastStopAt` 照常推进、账本不受影响。TTL 用于排除上一轮遗留的旧标记（实测标记可在末尾窗口停留很久）。⑥**顺带清理**：`compactionSuspected`（置 true 后立刻 `continue`，**结构性永远进不了日志**）/ `compactionMode` / `lastMarkerId` 三个误导性日志字段 + 零引用的 `lastUnknownTs` 一并删除。⑦**自测**：`selftest.js` 新增 T10 段 9 项（判据单测 + 源码零残留守卫 + 豁免分支位置守卫），**48 过 0 败**；另跑 3 组隔离端到端（新鲜标记→0 弹窗 / 无标记→照弹 / 1 小时旧标记→照弹，证明 TTL 未误杀），**14 过 0 败**；`--flush-delayed` 主循环冒烟正常收口。
>
> **v3.19.2 要点（2026-10-01 · 外部全量逐行重审 B1–B10）：账本正确性 + 消灭「两份实现靠注释同步」** —— ①**B1【高】水位线口径漂移导致账本静默重复记账**：`readTranscLinesFrom` 用「**已解析行数**」当水位线、却用「**原始换行符个数**」做字节偏移定位，两者只在"每行都能解析"时相等 → transcript 中途出现**空行或永久坏 JSON 行**时，水位线比真实偏移小 k，下一轮从偏早位置重读已计过的行、**再记一遍**（实测：10 行真实用量 1000/100，账本记成 **1100/110**，无 stderr 无告警；触发后自愈但多记的不回滚）。现水位线口径统一为**物理完整行数**（文件 `\n` 累计），空行/坏行不再造成漂移，半写尾行仍不计入。②**B5 + B3【中】复制实现彻底清理**：`backfill.js` 删除自带的价库合并镜像与 `findModel`/`normalizeModelName` 副本（镜像缺了并发半写重读、`tier_note` 传递等三处逻辑），改为在主脚本 `require` 前钉住 `CN_PRICE_DB_DIR` 后**直接复用 `tt.mergeLocalPriceDb` / `tt.findModel`**；主脚本内两份**零调用死副本** `parsePeakSchedule`（仍丢分钟的 N4 旧 bug）/ `isChineseHolidayBeijing`（时区口径与模块不一致）连同 exports 一并删除——"留着带旧 bug 的副本 + 详细正确注释"是最高级的误导。③**B8【低·口径】峰谷按 token 发生时刻判，不再按脚本运行时刻**：`calcCost` 新增可选 `tsMs`，取 `tsMs > stat.lastTs > 当下` 优先级；`incrementalRecord` 传入本批新行的最大时间戳 → 跨 12:00/18:00 边界的长轮不再整轮按"终点档"计价，与 `backfill`/`recalc-day` 的逐行口径收敛。④**B4【中】删掉 `peak_rules` 半截链路**：该字段是 TokenHub 原文**自由文本**（非机器可读的分厂商时段表），抓了、存了、**从不参与判定**（非 DeepSeek 厂商一律按 1× 计价）——`build_index.py` 停止生成、`mergeLocalPriceDb` 停止合并。⑤**B2**【中】`resolveWorkspaceLogFile` 改走探测出的数据根 `WB`（原先写死 `~/.workbuddy/logs`，数据根迁到 `~/.workbuddy-ai` 的用户「取消确认第二信号源」永久失效，且是 `WB_ROOT` 隔离泄漏）。⑥**B6/B7/B9/B10**【低】`aggregateTranscript` 的 `subModels` 补行级时间过滤（子代理被唤醒复用时旧行不再外溢到弹窗）；3 处 `agent-*.jsonl` 正则补 `i` 标志（全仓 11 处统一）；`estimateInterrupted` 的 `fromTs` 显式声明为 **epoch 毫秒**（此前 `estimateInterruptedInc` 把行数当时间戳传、过滤器空转）；`firstTs` 空集不再依赖 `Infinity` 传播。⑦**自测**：`selftest.js` 新增 T9 段 16 项（含 B1 端到端、B8 端到端到账本金额、B6 旧行不外溢），**39 过 0 败**。
>
> **v3.19 要点（2026-10-01）：全仓审计落地——①峰谷时段判定收敛为单一实现 `peak-rules.js`（主脚本 / `backfill.js` / `recalc-day.js` 共用；此前三份硬编码副本，官方一旦调时段，增量记账与回溯重算会判出不同峰谷、金额静默差一倍且无报错）；②`recalc-day.js` 写盘改为「写前备份 + `tmp`+`rename` 原子写」，读取端剥 BOM 并把损坏文件隔离为 `.corrupt-*`；③watcher 改增量读 transcript（此前每 2 秒全量 parse，大 trace 下开销显著；文件被截断/重写时自动重建缓存）；④`backfill.js` 不再继承旧账本的 `_instructions`（数据→指令通道保持关闭）；⑤`refresh-holidays.js` 加 15s 超时 + 原子写；⑥`recalc-day.js` 合并本地官方价库（重算不再把国内模型误判为无价）；⑦`deepseek-official.js` 原子写 `pricing.json`；⑧`maybeRefreshLocalDb` 去掉 `shell:true` 改数组 spawn。⑨v3.19.1 修复峰谷「静默失效」：官方 2026-09 改文案为倒装句导致时段解析一直失败、并把 `peak_schedule` 静默清成空串（下游回落默认值恰好正确，故毫无异常表现）——现改为句式无关解析 + 失败不覆盖 + toast `⚠时段` 告警。v3.18 安全修复要点（余额开关本地化 / 账本 BOM 防损坏 / 个人路径清除）详见 `CHANGELOG.md`。**

> **⚠️ 强制（查询触发总纲）：所有统计查询必须调用 `--report` 命令并原样贴出脚本输出，禁止自行解析 JSON。** 无论用户问「今日消耗」「今天用了多少」「账本」「报告」「统计」「花费」还是历史某天，一律先跑 `node token-tracker.js --report`（或 `--report <日期>`），再把脚本打印的 Markdown 表格原文贴给用户；不得自行读取 `daily-usage.json`、不得自行汇总、不得转成列表/纯文本/代码块。详细规则见下方「查询触发规则（强制）」与「展示格式约束（强制）」。

以下为 v2.55 的功能总览（保持不变）：

> 本技能以 **Windows 系统通知（toast）** 为唯一展示通道：每次回答结束后，由 `Stop` 钩子读取本轮真实落盘数据，自动弹出本条消耗。以下是当前支持的全部能力：

- **本地模型识别增强（v2.54~v2.55，2026-08-18）**：`isLocalModel()` 构建本地集合时按 url 特征判断——**host 是本机（localhost/127.0.0.1/0.0.0.0/::1）→ 无条件本地；host 是局域网 IP（192.168.x/10.x/172.16-31.x）且端口命中已知本地服务端口 → 本地**。已知本地端口：Ollama:11434 / LM Studio:1234 / llama.cpp·llamafile·LocalAI:8080 / vLLM:8000 / Jan:1337 / GPT4All:4891 / koboldcpp·oobabooga:5000·5001。本地部署（Ollama/LM Studio/llama.cpp/vLLM 等）模型即使名字与云端同名（如 `qwen3.8-27b` 撞 OpenRouter 的 `qwen/qwen3.8-27b`）也一律计费 0、只统计 token，并禁止自动补录云端价。修复动机：本地模型改名 `qwen3.8-27b` 后与 pricing.json 云端条目精确同名，被按云价误计费 3.32 元（详见 daily-usage 修复）。
- **本条精确统计**：`Stop` 钩子在回答完全结束后触发，此时本轮 trace/transcript 已写完，弹出的是**本条回答**的真实 token、耗时与费用（不是上一轮）。
- **toast 两行大字布局**：行1 标题大字 = 模型完整名 + 时段标注（`高峰双倍`/`夜间X折`）＋ 换行后 = `耗时` + `今日¥X` + `余额¥Y`；行2 正文小字 = `输入/输出 token` + `缓存占比` + `本条费用`。
- **每日分模型账本（v2.39）**：每轮 Stop 自动把消耗**按模型**累计进 `daily-usage.json`（本地日期分桶，`{日期:{models:{模型:{in,out,cached,hit,total,cost}}, total:{...}}}`，`hit` = 缓存命中率%（两位小数，cached/in）），**每天保留两套统计**：`models` 各模型明细 + `total` 不分模型的当日总合计（输入/输出/缓存命中/总 token/金额，含总命中率）。**长期保存不裁剪**，可查任意历史天。查看：`node token-tracker.js --report`（今天）／`--report all`（全部天）／`--report <日期>`，也可让助手直接读文件整理展示。**v3.20.0 新增区间汇总**：`--report week`（近 7 天）／`--report month`（本月至今）／`--report 2026-09-01..2026-09-30`（任意闭区间）→ 输出与单日**同列**的按模型汇总表 + 合计行（命中率按 `Σ缓存/Σ输入` 重算）；`--report forecast` 看 token 消耗外推。
- **轮次明细留档（v3.20.0）**：每轮记账成功后在 `rounds/rounds-YYYY-MM.jsonl` 追加一条 JSONL，字段含 `roundStart` / `durMs` / `in,out,cached,total` / `hitPct` / `models`（分模型明细）/ `model` / `subModels` / `subCount` / `teamActive` / `source`（`stop-transcript` / `flush-delayed` / `cancelled-round-watch`）/ `label`（本轮首条用户消息前 40 字，注入型标 `[注入]`）/ `costApiEquiv`（**按 API 单价折算，非真实扣费**）。保留最近 6 个月，过期文件在跑 `--report` 时顺带清理。用途是**分布分析**（哪些轮异常大、子代理占比多少），不是归因分析——`label` 只给一个开头线索，别指望它解释"这一轮为什么贵"。
- **版本更新提示（v3.21.0，v3.22.0 补覆盖）**：每 **7 天**匿名查一次仓库版本（**同时查 `releases/latest` 与全部 tag，取较大者** —— 只查 release 时「有 tag 无 release」会漏报），发现新版本时**由模型在回答末尾提一句**，不占 toast 空间。检测结果由 `out()` 统一追加，**任何 hook 输出路径都带得上**（不会被早退分支绕过）；**只配 Stop 的用户**改走弹窗兜底（第一行尾部 `｜⬆vX.Y.Z`，放不下就不显示）。失败静默退避（1h→6h→1d，连败 3 次当周不再试）；同一新版本**最多提示 2 次、间隔 ≥24h**。开关 `ENABLE_UPDATE_CHECK`（默认开，`local-config.json` 可关）。**升级操作方法见「版本更新提示与如何升级」章节**——注入的提示里不含升级步骤。⚠️ 该功能**帮不了已装旧版（<v3.21.0）的用户**（检查逻辑在被安装的那份代码里）。
- **统计范围边界（务必对用户如实说）**：本技能统计的是「**WorkBuddy 落盘了的消耗**」，**不等于账上被扣的全部消耗**。已知缺口：① **长思考中途手动停止** —— 本地不落盘 usage，只能用估算（弹窗标 `（估算）`，通常偏低），但**服务商已计费、积分记录里也有**；② 内置积分模式的额度扣减读不到；③ WorkBuddy 之外的调用不计；④ 进程异常终止那一段可能缺失。**对账须以 API 服务商账单 / WorkBuddy 积分消耗记录为准**。
- **今日累计**：toast 行1 显示 `今日¥X.XX`（读当日账本 total.cost，含本条）。
- **时段标注**：DeepSeek 原厂系支持峰谷定价，自动标注 `高峰双倍`；声明 `night_discount` 的模型夜间标注 `夜间X折`。**DeepSeek 时段自动跟随官方**（`deepseek_rules.peak_schedule` 由 `deepseek-official.js` 每日抓官方定价页；无规则回落内置默认 9-12/14-18 + 周末低峰），**无需手动维护**；其他厂商的峰谷/夜间字段仍需人工写入 `pricing.json`。
- **余额显示**：仅 DeepSeek 自定义 API 且开启开关时启用，默认隐藏 + 变化检测（余额变才显示），15 秒 TTL 缓存。
- **专家团/多子回合聚合**：识别 `Agent`/`TeamCreate` 等团队活动，专家团跑完延迟约 6 秒**只弹一次整轮汇总**，不重复弹 N 次。
- **多会话隔离**：按 hook payload 的 `session_id` 拆分快照，多会话并发互不串扰。
- **价格体系（零密钥联网）**：`pricing.json` 官方人民币价 + 每日自动多源刷新（国内 llmabacus/llm-prices-cn + 国外 OpenRouter/LiteLLM/Portkey，按模型 region 区分国内外，取中位数）+ 未收录新模型自动联网补录（国内源优先，人民币价）。默认零密钥：仅余额查询携带 API key（默认关闭）。
- **快照自动清理**：`.snapshot-<sid>.json` 保留最近 30 天 + 最多 50 个，当前会话永不清。
- **兜底通道**：`--hook`（UserPromptSubmit）在下一轮提交时把上一轮用量注入上下文；手动运行 `token-tracker.js --stop` 查看最近一轮。
- **每日账本报告**：`node token-tracker.js --report [all|<日期>]` 输出每日分模型明细 + 当日合计（今天/历史任意天）；`--report summary [all|<日期>]` 只输出每天**总合计**（一行/天，不含模型明细）——仅供助手内部快速判断/调试用，**禁止**作为给用户的展示输出。
- **区间报表 / CSV 导出 / 消耗外推（v3.20.0）**：`--report week`（近 7 天）／`--report month`（本月至今）／`--report <起>..<止>`（任意闭区间）输出**按模型的区间汇总表**，列结构与 `--report <日期>` 完全一致，同样**原样贴出**；加 `--csv` 则改成导出文件——落 `exports/report-<范围>-<时间戳>.csv`（逐日 × 逐模型明细 + `ALL` 合计行，带 UTF-8 BOM），命令**只回一行路径**，此时**不要贴任何表格**（文件是给 Excel 用的）；`--report forecast` 输出 token 消耗外推，**不含金额**。
- **展示格式约束（v2.39.2，强制）**：向用户展示账本数据**一律用 `--report`（明细版）**，其输出为 **Markdown 表格**（表头 + 每个模型一行 + 合计行加粗，**含单模型明细与总计**），**表格列为 `模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额`**，其中「缓存命中」列 = 缓存命中率百分比（两位小数，`cached/in`，如 `96.89%`），每条数据行与合计行都带该列。**必须**直接把脚本输出的 Markdown 表格原文贴给用户（聊天界面渲染为真表格列，天然对齐），**禁止**手排空格对齐、**禁止**转成纯文本/代码块、**禁止**改用 summary 一行式。原因：空格对齐依赖字体宽度，不同环境渲染必歪（用户反复纠正过的坑）。**区间模式（`--report week|month|<起>..<止>`）适用同一条规则**：原样贴出汇总表；但带 `--csv` 时**不要贴表格**，命令只会回一行导出路径。

## 查询触发规则（强制）

- 当用户以任何形式询问「今日消耗」「今天用了多少」「账本」「报告」「统计」「花费」等查询类请求时，**必须首先执行**：`node token-tracker.js --report`（或 `node token-tracker.js --report <日期>` 查询历史）。
- 然后**原样贴出脚本输出的 Markdown 表格**，不得自行读取 daily-usage.json、不得自行汇总、不得转换成列表/纯文本/代码块。
- 如果用户只问某一天的消耗，也使用 `--report <日期>` 并原样贴出。
- 如果用户问的是 summary（只要总合计，不要模型明细），才允许使用 `--report summary`，但同样必须贴出脚本输出，不得自行加工。
- 如果用户问的是**一段时间**（「这周」「本月」「最近 7 天」「9 月 1 号到 10 号」这类），用 `--report week` / `--report month` / `--report <起>..<止>`，同样**原样贴出**脚本输出的汇总表。
- 如果用户明确要**导出成文件**（「导个 CSV」「给我一份 Excel 能打开的」），加 `--csv`，然后把命令回显的导出路径给用户——**不要贴表格内容**（文件是给 Excel 用的，贴出来只是刷屏）。
- 任何情况下，禁止绕过脚本直接解析账本 JSON 后手工格式化输出。

### 自然语言问法 → 命令映射（照此执行，不许自由发挥）

用户**不会**说 `--report week`，他只会说「这周用了多少」。下面这张表就是「他怎么说 → 你必须跑哪条命令」的强制对应——**跑错命令等于答非所问**：

| 用户说法（示例） | 你必须执行的命令 | 输出怎么处理 |
|---|---|---|
| 今天 / 今日 / 这次 / 现在用了多少 / 看消耗 | `--report` | 原样贴 7 列 Markdown 表 |
| 给出具体某一天（「9 月 28 号花了多少」） | `--report 2026-09-28` | 原样贴表 |
| 这周 / 最近 7 天 / 过去一周 / 一周内 | `--report week` | 原样贴**一张**区间汇总表 |
| 这个月 / 本月 / 这个月到现在 | `--report month` | 原样贴表 |
| 一段日期（「9 月 1 号到 30 号」） | `--report 2026-09-01..2026-09-30` | 原样贴表（**起止写反脚本自己会纠正**，你不用管） |
| 全部 / 历史 / 所有的 / 从装到现在 | `--report all` | 原样贴表 |
| 只要总数 / 别列模型 / 一行就好 | `--report summary [all\|<日期>]` | **仅供你内部判断趋势，禁止当作给用户的展示输出** |
| 照这速度 / 还能用多久 / 估一下后面 | `--report forecast` | 原样贴（**只有 token，没有金额**；样本不足 2 天脚本会拒算） |
| 导 CSV / 要 Excel / 给我文件 | `--report <范围> --csv` | **只回一行路径，不要贴表格** |
| 上一轮 / 刚才那条 / 上一次回答 | 手动模式（无参数） | 贴一行结果 |

**反模式（出现即错）**：

| 错误做法 | 为什么错 / 正确做法 |
|---|---|
| 用户问「这周」，你跑 `--report all` 让他自己在几十天里找 | 用 `--report week` 一次出一张表 |
| 用户问区间，你按天跑 N 次再自己相加 | 必须让脚本一次出表（`--report <起>..<止>`）。区间命中率是按 `Σ缓存/Σ输入` **重算**的，你自己相加会算错 |
| 带 `--csv` 时还把表格贴一遍 | 只回路径——文件才是交付物，贴出来纯刷屏 |
| 拿 `summary` 的输出当正式表格给用户 | `summary` 只给你内部看趋势；给用户的必须是 `--report` 明细表 |
| 用户问「哪一轮最贵 / 子代理占了多少」，你编一个数字 | 轮次明细在 `rounds/rounds-YYYY-MM.jsonl`，**没有 CLI 入口**——先如实说明这点，再按需读那个文件 |
| 用户问「上午花了多少」，你硬按小时拆 | 账本按**天**分桶，拿不到小时粒度；如实说 |

## 安装与启用（新用户必读：装完必须配 hooks 才自动弹通知）
从技能市场安装 = 文件拷入 skills 目录，**不会自动挂 hook**。请让 WorkBuddy 助手帮你把下面配置合并进 `settings.json`（或手动添加）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": ".*", "hooks": [ { "type": "command", "command": "node <技能目录>/token-tracker.js --hook" } ] }
    ],
    "Stop": [
      { "matcher": ".*", "hooks": [ { "type": "command", "command": "node <技能目录>/token-tracker.js --stop" } ] }
    ]
  }
}
```

`<技能目录>` 替换为实际安装路径（如 `C:/Users/你的用户名/.workbuddy/skills/token-usage-tracker`）。效果：
- 挂好 `Stop` hook → **每轮回答结束自动弹「本条消耗」Windows 通知**（核心体验）
- 挂好 `UserPromptSubmit` hook → 下轮提问时自动注入上一轮用量
- **不挂 hooks 也能用**：手动运行 `node <技能目录>/token-tracker.js --stop` 查看最近一轮消耗（方式 A）
- 不需要通知：只删 `Stop` 段即可，其余功能不受影响

## 🔔 版本更新提示与「如何升级」（v3.21.0 起 · v3.22.0 补覆盖 · 本节是升级操作的唯一权威处）

### 检测点在哪（被问到「会不会收不到更新」时照此回答）

脚本每 **7 天**匿名查一次仓库版本，**两个端点都查、取版本号较大者**：

| 端点 | 作用 |
|---|---|
| `releases/latest` | 正式发布的那个 release 的 tag |
| `git/matching-refs/tags/v` | 仓库里**全部** `v*` tag |

**为什么两个都查**：只查 `releases/latest` 时，万一某次「只打了 tag 没发 release」（或顺序颠倒），检测结果就会与事实不一致 → **漏报**。取两者较大值是「宁可早报、不可漏报」的取向。

**提示怎么送达**（两条通道，自动二选一，不会重复打扰）：

1. **主通道 —— 回答里**：`--hook`（你提交问题时）触发，检查结果拼进注入上下文，模型在回答末尾提一句。
   追加逻辑在 `out()` 内部完成，所以 `--hook` 的**任何**输出路径（含各种提前返回的分支）都会带上，不存在"走了某个分支就漏掉"的可能。
2. **兜底通道 —— 弹窗标记**：只给**没配 `UserPromptSubmit` hook** 的用户（判据：状态文件里 `lastHookAt` 缺失或距今 ≥3 天）。命中时弹窗第一行尾部出现 `｜⬆v3.22.0`，**放不下就整个不显示**。已配 hook 的机器永远不会出现这个标记。

> ⚠️ **对用户要如实说的边界**：这套机制**帮不了「已经装了旧版」的用户**——检查逻辑在被安装的那份代码里，v3.21.0 之前的版本根本没有它，他们只能靠 README / 发布页知道更新。这是机制使然，不是配置问题。

### 提示长什么样

发现新版本时会在 `--hook` 注入的上下文里**多出一行**：

```
[技能更新] 有新版 v3.22.0，回复末尾提一句即可，勿展开
```

**模型该怎么做**（就这一件事，别多做）：

1. **在本次回复的最末尾加一句**，例如：`本技能有新版本 v3.21.0，可更新`。**一句话说完就停**。
2. **不要展开**、不要贴目录树、不要贴命令、不要列 changelog 摘要——**除非用户追问**「怎么更新 / 更新了什么」。
3. 用户追问升级方法时，**照本节下面的「升级操作」回答**（这是唯一权威步骤）。用户追问更新内容时，回答「跑 `git log` 或看仓库的 CHANGELOG.md」或直接读 `CHANGELOG.md` 顶部那节。
4. 用户没追问 = 到此为止。同一版本最多提示 2 次、间隔 ≥24h，脚本自动节流，你**不需要**自己做去重。

> ⚠️ 不要因为收到这一行，就把回答写长、或每轮都提一遍——那正是这个功能要避免的「让用户反感」。它只是提醒，不是任务。

### 升级操作（用户追问时照此回答）

**本技能没有自动更新**——安装方式就是「把目录拷进技能目录」，自动覆盖会动用户自己的文件（可能抹掉 `local-config.json`、`models.json`、本机改动）。脚本只负责告诉你，升级动作由用户执行：

```bash
cd ~/.workbuddy/skills/token-usage-tracker

# 1) 备份本地配置与运行时数据（这些不在仓库里，重装会丢）
cp local-config.json models.json /tmp/ 2>/dev/null      # 有才需要
cp daily-usage.json .ledger-watermark.json /tmp/ 2>/dev/null   # 想保老账本就一起备

# 2) 拉新版本（clone 后目录名是 workbuddy-token-tracker，需改名）
git clone https://github.com/abc1317679842-ui/workbuddy-token-tracker.git /tmp/wtt-new

# 3) 覆盖技能目录里的程序文件（.js/.py/.json/.md），不删旧目录
cp /tmp/wtt-new/*.js /tmp/wtt-new/*.py /tmp/wtt-new/pricing.json /tmp/wtt-new/holidays.json ~/.workbuddy/skills/token-usage-tracker/
cp /tmp/wtt-new/*.md ~/.workbuddy/skills/token-usage-tracker/

# 4) 把本机配置拷回来
cp /tmp/local-config.json /tmp/models.json ~/.workbuddy/skills/token-usage-tracker/ 2>/dev/null

# 5) 验证
node ~/.workbuddy/skills/token-usage-tracker/token-tracker.js --report
```

**要点（回答时务必带上）**：

- **hooks 配置不用改**（`settings.json` 里的路径没变）。
- **账本 `daily-usage.json` 在旧目录里**——覆盖前先备份，**不要直接删旧目录**。
- 升级后可以用 `node token-tracker.js --report` 出表来验证；升级成功后脚本自己就把提示静默掉（本地版本 ≥ 远端即不再提示）。
- 更省事的替代方案：按「安装与启用」一节重新安装一次到技能目录，再把备份的两个配置文件拷回去。

### 想关掉这个检查

在技能目录的 `local-config.json` 写 `{"enable_update_check": false}`（文件不进仓库）。关掉后只少一条提示，统计 / 账本 / 弹窗 / 价格刷新都不受影响。也可以整个用 `ENABLE_NETWORK = false` 一键全关。

> ⚠️ **前提（对用户要如实说）**：这个功能**帮不了「已经装了旧版」的用户**——检查逻辑在被安装的那份代码里，旧版根本没有它。存量用户只能靠 README / 发布页知道更新。

## 为什么需要
WorkBuddy 客户端 UI 不显示每轮对话的 token 用量：内置模型只显示「积分」，自有 API 模式也不展示 token。但平台在每次模型调用**整轮结束后**都会把真实用量写进一个新的 `traces/<pid>/trace_*.json`（含 `totalTokens` / `totalInputTokens` / `totalOutputTokens` / `totalCachedTokens` / `duration` / `startedAt` / `endedAt`）。本技能把这些数据读出来，让你每轮都能看到真实消耗。

## 触发条件
- 用户明确要求看 token / 消耗 / 用时
- **默认不在回复末尾附加用量行**：以系统通知为准（见下方「方式 C」说明，2026-08 起生效）；仅当用户明确要求时才运行脚本贴出

## 使用方式（三种，任选/并用；方式 C 为当前主通道）

### 方式 A：手动（技能指令驱动，最贴合「回复末尾」）
在生成最终可见回复时，先运行读数脚本，把其输出作为**回复的最后单独一行**：

```
node ~/.workbuddy/skills/token-usage-tracker/token-tracker.js
```

脚本输出形如：
`GLM-4.6V ｜ 耗时 3m 43s | 输入 287.9万 / 输出 1.2万 tokens（该轮累计 289.1万，缓存命中 287.2万）`

模型名完整显示（去括号说明，不截断）；未识别到模型名时省略模型段。数字自动用「万/亿」单位（保留 1 位小数），低于 1 万显示原值，方便速读。

把这行原样贴在回复最末尾（独占一行，前面空一行与其它内容隔开）。**2026-08 起以系统通知（方式 C）为准**：每次回答结束 Stop hook 已自动弹「本条 Token 消耗」通知，回复末尾的「上一轮」行时效性差且冗余——默认省略；仅在用户明确要求（"贴一下用量/这次用了多少"）时才运行脚本贴出。

### 方式 B：自动（hook 注入，不依赖记得）
`settings.json` 的 `hooks.UserPromptSubmit` 配置本技能的 `--hook` 模式后（配置方法见「安装与启用」），会在你提交下一轮时自动把「上一轮」的 token 注入上下文，无需手动跑脚本。

### 方式 C：Stop 事件 + Windows 系统通知（目标：本条回答显示本条消耗与费用）
WorkBuddy 是 Claude Code fork，支持 `Stop` 事件（回答**结束后**触发）。`settings.json` 的 `hooks.Stop` 配置本技能 `--stop` 模式后：回答结束时本轮 trace 已落盘（实测 Stop 比落盘早 ~15ms，脚本会轮询等待最多 3 秒），读到最新文件即为**本条回答**的精确统计，然后：

- **Windows 系统通知（toast，标题两行大字 + 正文一行）**：调用 PowerShell WinRT Toast API 弹出（ToastText02，标题 text 内插 `&#10;` 换行符实现标题两行大字）
  ```
  DeepSeek-V4 Flash 高峰双倍
  耗时 4m 26s 今日¥8.21 余额¥2.77
  输入 391.2万 / 输出 1.9万｜缓存99.74%｜¥0.25
  ```
  ——**布局原则（v2.34/2.35 两行大字定稿）**：行1（标题大字）分两行——第一行 = 模型完整名 + 时段标注（`高峰双倍`/`夜间X折`，仅有时段策略的模型显示，空格分隔）；第二行 = `耗时` + `今日¥X` + `余额¥Y`（今日价 = 当天 24 小时总消费，余额仅开启余额查询且检测到变化时显示）。行2（正文小字）= 输入/输出 + 缓存占比（两位小数）+ 费用（未收录显示「未收录」）。**换行点固定在「时间」前**——行1 第二行永远从行首对齐，与第一行长度无关。**宽度双模型（v2.33）**：行1 标题大字用 `dispWidthTitle`（中文按 2.5 半角单位，v2.17 纯半角实测上限 47u、含中文更紧）+ 阈值 45u（= `TOAST_ROW1_MAX_W`，**以代码为准**）；行1 第二行阈值 42u（= `TOAST_ROW2_MAX_W`，**以代码为准**）；行2 正文小字用 `dispWidth`（中文按 2）+ 阈值 52u（= `TOAST_LINE_MAX_W`，**以代码为准**）。**降级链（v2.35 定稿）**：行1 第二行超 42u → 丢余额 → 再超丢今日价 → 保底 `耗时`（绝对安全）；行1 第一行超宽（长模型名）→ 丢时段标注保模型名。**时段标注 `periodNote()`**：`peak_multiplier>1`（DeepSeek 原厂系=2）且当前在高峰时段（北京时间 9-12/14-18）→ `高峰双倍`；`night_discount`（如 0.5）且当前在 `night_hours` → `夜间X折`；无时段策略不显示。**布局演进（历史）**：v2.6 行1 带时段标注 → v2.8 余额移至行1 → v2.11 余额紧跟时间 → v2.14 时段只显示「高峰」两字 → v2.17 实测上限 47u + 分隔符两侧加空格 → v2.18 恢复「¥」符号 → v2.32 加今日累计 → v2.33 行1 中文按 2.5 宽度模型 → v2.34/2.35 换行点移到时间前、两行大字布局定稿。**实现说明**：旧式 ToastText 系列无展开按钮，ToastText04 的第 3 个 text 元素在部分环境不渲染（v2.34 实测被吞），故用「ToastText02 标题 text 内插 `&#10;` 换行符」实现两行大字（用户实测 A1 方案成功）。这是当前唯一确认有效的"本条可见"通道（UI 内 `systemMessage` 通道实测不显示，v2.37 已移除该死代码）
- **时段折扣数据（2026-08-05 搜索核验；DeepSeek 原厂时段 v3.19.1 起自动跟随官方；v3.22.0 修正本节过时表述）**：目前仅 **DeepSeek 原厂系**有峰谷定价（V4 起推出，工作日北京时间 9-12/14-18 高峰，所有计费项 ×2，含缓存价；原因=算力挤兑削峰填谷；2025 年的「夜间错峰优惠」已被高峰溢价模式取代）。智谱 GLM / MiniMax / Kimi / 混元均为统一定价无峰谷；小米 MiMo 是 2026-05 永久降价 99%（非时段折扣）。⚠️ **时段数据的来源分两类，别再把它们混为一谈**（v3.22.0 修正过时表述——此前本节与 README 都写「无公开 API 数据源，需手动维护」，对 DeepSeek 原厂并不成立）：
  - ① **DeepSeek 原厂系 → 官方自动跟随**：`deepseek-official.js` 每日抓官方定价页，写入 `pricing.json` 顶层的 `deepseek_rules.peak_schedule`（含 `weekend_off_peak`）。官方调时段 / 取消周末低峰 / 改文案，本地自动同步；**解析失败保留旧值**并亮 `⚠时段`（v3.19.1 前的旧版会把 `peak_schedule` 静默清成空串，下游回落默认值恰好正确所以毫无异常表现——这是历史坑）。无 `deepseek_rules` 时回落内置默认 9-12/14-18。
  - ② **其他厂商 → 需人工维护**：这些厂商的时段政策（高峰/低谷/夜间折扣/取消）**没有**可程序化读取的数据源，变动时在 `pricing.json` 该模型条目上更新 `peak_multiplier`（高峰倍率）、`night_discount`（夜间系数，0<d<1，如 0.2=夜间2折）、`night_hours`（可选 `[起,止]`，覆盖默认夜间窗口 00:00–08:00）字段，代码自动读取显示（可在对话中提示模型更新）。
  - ⚠️ **不存在 `peak_hours` 字段**：高峰时段只来自 `deepseek_rules.peak_schedule` 或内置默认，历史文档里写的 `peak_hours` 是错的（全仓无任何代码读取该键），不要照它去改 `pricing.json`。新模型自动补录默认 `peak_multiplier:1`。
- Stop 端输出 `hookSpecificOutput:{}`（v2.37：`systemMessage` 通道 WorkBuddy UI 实测不显示、弹不进对话回复，已移除该无效注入；toast 为唯一结算展示通道）。
- 探针 `.stop-probe.json` 记录每次触发：`sameRound=false`+`waited=ok` = 成功拿到本条；`waited=timeout` = 3 秒内 trace 未落盘，退化为「上一轮」且不弹通知。
- 若用户不需要系统通知，可删除 `settings.json` 中 `hooks.Stop` 配置（`--hook`/手动模式不受影响）。

## 费用估算（pricing.json + 高峰时段 + 每日自动刷新）
- 模型名读取：`trace.modelInfo.models[0]`（空壳 trace 从 spans 的 `toolOutput[].model` 取）。
- **模型匹配（v2.67 起严格化）**：`findModel()` 只认**归一化后完全相等**的键，一个字符不同即视为不同模型。归一化仅做三件事：统一小写、去首尾空格、连续空格合并为单空格。**不做**前后缀/包含/版本号/日期归并，`.` 与 `-` 也不再等价（如 `glm-5.2` ≠ `glm-5-2`）。带厂商前缀的名字（如 `moonshotai/kimi-k2.7-code`）必须原样收录在 `pricing.json` 才能命中，不会自动剥离前缀去匹配。匹配不上返回 `null` → 走新模型联网补价，补不到就只记 token 不记金额。
- 价格缓存：`~/.workbuddy/skills/token-usage-tracker/pricing.json`（官方人民币价：输入/缓存命中输入/输出，元每百万 tokens；`region` 国内外标记 CN/US；`peak_multiplier` 高峰倍率、`night_discount`/`night_hours` 夜间折扣字段（**DeepSeek 原厂时段走顶层 `deepseek_rules` 自动跟随，无需动这几个；其余厂商需人工维护**）；`or_id` 关联 OpenRouter 模型 id；`usd_input_price/usd_output_price` 为自动刷新写入的 USD 参考价）。
- **已收录模型与价格**：**以 `pricing.json` 实际内容为准**（`region`/`lock`/`peak_multiplier` 等字段随每日刷新与人工核验持续变动，本文档不再手抄价格表——历史上手抄表曾与实际库严重脱节）。查某个模型现价：读 `pricing.json` 对应条目，或跑 `--report` 看计费结果。
- **新模型自动补录（v2.31，国内源优先；用户要求"检测到未收录模型立即联网查"）**：trace 读到**未收录模型**（pricing.json 无匹配且无 input_price）时，`token-tracker.js` 自动执行：
  1. **立即联网**先查国内源 llmabacus（`llmabacus.com/api/prices`，无需 key）按模型名匹配，`priceCurrency=CNY` 直接人民币价补录 `region=CN`、`USD` 走 USD×汇率 `region=US`；
  2. llmabacus 无 → 回退 OpenRouter（`openrouter.ai/api/v1/models`）按模型名匹配，USD×汇率（7.2）补入 `pricing.json`（`auto_converted: true`，缓存价不估算（缺失按 0 计，v2.82.1 起），标 note "待人工核验官方价"），同时 hook/手动输出附提示「已自动补录估算价」；
  3. 两源均确认无此模型 → 记入本地已查列表 `.lookedup-models.json`（v3.18.1 起，不入库；同一模型当天不再重复联网），输出提示「请搜索该模型厂商官方定价页人工核验补录」；
  4. 联网失败 → 不记已查（下次重试），输出提示「联网查价失败」。
  - 维护原则：**不追求收录所有模型**，只维护应用内置 + 用户常用模型；新模型由上述自动补录 + 人工核验（搜索厂商官方定价页）补齐。
- 高峰时段（仅 DeepSeek 原厂系）：**优先取 `pricing.json` 的 `deepseek_rules.peak_schedule`（官方页每日抓取、自动跟随官方改版）**；无规则时用内置默认 **北京时间 9:00-12:00、14:00-18:00**（该窗口所有计费项翻倍，周末按 `weekend_off_peak` 全天低峰）；其余模型无峰谷。
- 计费公式：`未命中输入×输入价 + 命中输入×缓存价 + 输出×输出价`，按当前时段取倍率；结果不足 ¥0.01 显示 `¥<0.01`。
- toast 为两行：行1 `模型名 | 时段标注 | 耗时[ 空格]余额¥X（半角 | 两侧各 1 空格）`，行2 `输入 X / 输出 Y｜缓存NN.NN%｜¥费用`（详见方式 C）。

## 余额显示（v2.8 新增，v2.10 改为"默认隐藏 + 变化检测"，仅自定义 API 的 DeepSeek 官方模型）
- **原理（NIX 客户端同款）**：DeepSeek 官方接口 `GET https://api.deepseek.com/user/balance` + `Authorization: Bearer <API key>` 即可查询账户余额，**无需网页登录**——这就是 NIX 等 DeepSeek 客户端"只给 API key 就能显示余额"的原因。
- **启用条件**：仅当 `~/.workbuddy/models.json` 里存在 url 指向 `api.deepseek.com` 的模型（即用户自己的 DeepSeek API key）时启用；无 key → 不显示余额，不影响其他功能。
- **模式识别（v2.10，用户定调"默认不显示、抓到变化才显示"）**：积分模式与自定义 API 模式无法从本地数据区分——官方文档证实内置模型列表就有 `Deepseek-V4-Flash`（与自定义 id 同名）；trace/hook payload/transcript 无模式标记；进程级探测（tasklist/wmic/netstat）被本机安全策略禁用。"密钥是否在用"信号抓不到，但 **余额变化 = 账户在真实消耗** 是其等价信号（有密钥才有消耗）。判定规则：每次查询与上次观测对比（`toFixed(2)` 字符串比较避免浮点陷阱）——
  - **余额变了**（降=消费 / 升=充值）→ 显示 `余额¥X`（自定义 API 模式，或其他处用同一 key，显示的是真实余额）；
  - **余额不变** → 不显示（积分模式余额恒定 → 永不显示）；
  - **首次观测**只记录 baseline 不显示（用户："宁愿先几轮不显示"）。
- **显示位置**：Stop toast **行1 紧跟耗时**（1 空格分隔）`余额¥2.77`（金额两位小数，**带 ¥ 符号**——v2.18 恢复：实测行1 上限 47u 后空间充裕，峰值场景 46u 仍有富余）。放行1 的原因：行2 已满（实测约 49u/上限 52u，= `TOAST_LINE_MAX_W`，**以代码为准**），追加余额会折叠变 3 行。**行1 是标题大字，宽度上限 `TOAST_ROW1_MAX_W=45`（**以代码为准**；v2.33 由 47 下调至 45，留 2u 余量，v2.63 保持该值不变）**；超宽（长模型名）时余额自动让位，不折叠。**v2.17 定稿：行1 分隔符用半角 `|`（全角「｜」dispWidth 算 2u 太浪费）且两侧各 1 空格**——`模型名 | 高峰 | 耗时 余额¥X`，模型名与分隔符不再贴死。
- **缓存（实时性）**：余额写入 `.balance.json`（含 history 数组，保留最近 20 条观测），**15 秒 TTL**（v2.18 从 60s 压短：用户要求实时，接口实测 300ms 级，正常轮询间隔 >15s 即每轮拿实时数；15s 内连发 toast 才复用缓存秒回）——查询失败降级用旧缓存，无缓存则隐藏余额（不报错、不影响 toast）。
- **隐私**：API key 仅用于本机向官方 `api.deepseek.com` 发请求，缓存文件只存余额数值与观测历史、不存 key；脚本不打印、不上传 key。
- **每日刷新策略（用户要求"当天第一次打开软件/第一次回答才搜，当天搜过就不搜"）**：
  - 脚本自动兜底（**v2.65 起触发点收敛**）：**仅 `--hook`（用户提交提问时）**才检查 `pricing.json` 的 `date`，**过期才**同步调用 `refresh-prices.js` 联网刷新；`--stop` 路径**不再**做全量刷新（此前会在 Stop 时联网，阻塞弹窗）。判定仍是「当天已刷新则直接跳过、不联网」。手动运行 `node refresh-prices.js`（加 `--force` 可强制）随时可刷。**v2.66 补充**：`pricing.json` 缺失或损坏时会自动尝试重建；刷新子进程超时为 60 秒。**v2.2（2026-08-14，多源 + 国内外区分）**：并行拉 **5 源**——国内 2 个：llmabacus（`llmabacus.com/api/prices`，**主**，每日自动核价、人民币、含 vendors country）、llm-prices-cn（`raw.githubusercontent.com/szp2005/llm-prices-cn/main/prices.json`，**备份**，llmabacus 每日镜像）；国外 3 个：OpenRouter（USD，接近实时）、LiteLLM `model_prices_and_context_window.json`（USD，1-3 天滞后）、Portkey `configs.portkey.ai/pricing/<provider>.json`（USD，美分/token）；**按模型 `region` 区分国内外**（CN=国内模型主价来自国内源人民币价；US=国外模型主价用三 USD 源中位数×汇率），region 自动从 llmabacus vendors country 推断；USD 参考价取三源中位数；国内源都没有的模型仅当本地原本是 `auto_converted` 才用 USD 兜底，人工核验过的官方价保留不被覆盖；**全源失败写 `last_refresh_error`，token-tracker 在 toast 显示「价⚠️」提示费用按上次价格估算**；当天已刷新则直接跳过、不联网；`--force` 可强制刷新。备份：`refresh-prices.js.bak-20260814`。
  - 新模型补录（v2.31）：`ensureNewModelPricing` 检测到未收录模型时**立即联网补录**——先查国内源 llmabacus（`priceCurrency=CNY` 直接人民币价补录 region=CN；`USD` 走 USD×汇率 region=US），再回退 OpenRouter（region=US）。已收录模型不触发，只有真遇到新模型才联网。**v2.67 起匹配变严格后**，新模型/新构建名更容易落到这条路径（找不到精确键即触发）。
  - 陈旧模型清理（v2.65）：每次刷新时删除「曾出现在 `daily-usage.json` 且超过 14 天未使用」的模型（**从未出现在账本的模型一律保留**——v2.82 修复后与代码一致），`lock: true` 的三个（deepseek-v4-flash / -vision-exp / v4-pro）始终保留。被删模型再次使用时会由上面的新模型补录自动回补。
  - 人工权威核验（兜底）：**每日首次对话时**，若发现自动刷新覆盖的国内源价格与厂商官方定价页有出入（尤其峰谷模型如 DeepSeek 的基准价口径），按 SKILL.md 数据源清单核对官方定价页后修正 `pricing.json`。自动刷新的 `last_refresh_note` 会在峰谷模型价差 >60% 时提示人工核验。
  - 开源/实时价格源清单（已全部接入自动刷新）：**llmabacus.com/api/prices**（国内人民币主源，每日自动核价，szp2005/llm-prices-cn 的上游，含 vendors country/currency）、**llm-prices-cn**（国内人民币备份源，每日镜像同步）、OpenRouter API（USD，接近实时）、LiteLLM `model_prices_and_context_window.json`（USD，社区 PR 1-3 天滞后）、Portkey `https://configs.portkey.ai/pricing/<provider>.json`（USD，美分/token，SaaS 即时）、厂商官方定价页（权威，兜底人工核验）。国内网页参考（不可程序化）：51token.com / jingxialai.com / tokenbijia.com。

## ⏱️ 时序限制（务必理解，不要对用户造假）
- **一个 trace 文件 = 一轮完整 LLM 调用，整轮结束后才落盘**。因此在「回答生成完毕」那一刻，本轮自己的 trace 还没写出来——手动/`--hook` 模式读到的永远是**最新已完成的一轮**（即上一条回答，精确但滞后一轮）。**回答末尾贴出的行不可能显示本条**（本条尚未落盘），必须如实标注「上一轮/最近完成轮」，不许冒充"本条"。
- **例外（方式 C）**：`Stop` 事件在本轮回答完全结束后触发，此时（等待后）本轮 trace 已写完，`--stop` 模式能拿到本条精确数据，通过 **Windows 系统通知**展示——这是唯一能显示「本条」的通道。
- 首次运行（无快照）或新轮次：直接显示该轮统计，无"上一轮"前缀。
- 同一轮被第二次读到（例如 hook 刚记录过、或上一条回复末尾已贴过）：输出会带「上一轮」前缀，避免同一行重复出现。

## 数据源与准确性
- 数据：最新 `traces/<pid>/trace_*.json` 的 `trace.modelInfo` / `trace.duration`。
- 轮次识别：脚本用 `~/.workbuddy/skills/token-usage-tracker/.snapshot.json` 记录「上次已统计的 trace 文件路径 + 该轮统计」，只用于去重；不做总量 diff，因此换会话 / 清空上下文导致总量变小也不会出现负数或 0。
- 适用范围：自有 API 与内置积分模式都统计——只要走了模型调用就有 trace。
- 统计口径：`该轮累计` 是该 trace 内多次模型调用的合计；`duration` 为平台记录的该轮总耗时（含工具调用等）。
- ⚠️ **统计范围边界（v3.22.0 起明确写入文档，对用户必须如实说）**：本技能统计的是「**WorkBuddy 落盘了的消耗**」，**不等于「用户账上被扣的全部消耗」**。四条已知缺口：
  1. **模型长时间思考时被手动停止 / 被中断**——平台**不落盘**这部分的 usage，本地读不到；而**服务商那边已经真实计费、WorkBuddy 积分消耗记录里也有**。本技能在这条路径上只能**估算**：输入侧取"往前最近一次有 usage 的调用"的输入量近似，输出侧按本地记到的思考文本长度粗算（中文约 1.5 字/token、其他约 4 字符/token），弹窗会标注 **`（估算）`**。思考过程本身可能被截断 → **通常偏低**，**不是账单**。相关实现：`estimateInterrupted()`，Stop 端 `transcript-interrupted-est` 分支。
  2. **内置积分模式**：只有 token 与折算金额，**读不到**积分/额度扣减明细。
  3. **在 WorkBuddy 之外用同一 API key 发起的调用**：完全不在统计内。
  4. **应用 / 进程异常终止、trace 来不及落盘**：那一段可能缺失。
  → 用户要**对账**时，必须引导其以 **API 服务商账单 / WorkBuddy 积分消耗记录**为准；正常跑完的轮次那四列 token 才是可直接信的。
- 反面要求：**不许把 `（估算）` 轮次的数字当实测值说**——被问到时必须点明这是估算、且通常偏低。

## 注意事项
- 不要伪造数字：脚本读的是平台真实落盘数据，直接输出即可；读不到/解析失败时如实显示"暂无数据/尚未完成写入"，绝不编造。
- 若输出显示「上一轮」，说明这一轮已统计过（数字与上次相同属正常）。
- 本技能不修改任何平台文件，仅读取 traces 与维护自身快照。

## 维护与排查

### 弹窗诊断日志
- 每次弹窗时，代码**自动**向 `~/.workbuddy/token-tracker-toast.log` 追加一行 JSON 诊断记录（无需任何开关，默认开启）。
- 记录内容包含：`ts`（时间）、`reason`（触发原因）、`sessionId`、`watchStartTime`（本次 watcher 启动时间）、`lineCount`、`stableCount`、`tailFingerprint`、`lastTailFingerprint`、`pendingSubCount`、`hasNewTail`、`traceFile`（当前处理的 trace 文件名，获取不到为 null）、`toastText`（弹窗真实文本前 200 字符）。
  - v3.19.3 起删除了 `compactionSuspected` / `compactionMode` / `lastMarkerId` 三个字段：前者在原压缩状态机里结构性恒为 false/null（置 true 后立刻 continue，永远到不了日志），后两者从未被置 true——留着只会误导排查。
- `reason` 取值：`busy-timeout` / `interrupted` / `deadTeam` / `stableCount>=3` / `idle-timeout` / `estimate` / `no-token` / `hook-fallback`。
- 日志文件超过 5MB 会自动清空后重新追加，避免无限增长。
- 写入失败（权限/磁盘问题）被 try-catch 吞掉，绝不影响弹窗主流程。

### 常见排查步骤
1. 如果用户反馈"压缩上下文后仍然弹窗"或"漏弹"，直接打开 `~/.workbuddy/token-tracker-toast.log`。
2. 搜索最近的记录，查看 `reason` 是 `stableCount>=3` 还是 `interrupted` 或其他。
3. 查看该记录的 `tailFingerprint` / `lastTailFingerprint`（末行指纹），判断触发时末行是否已连续多帧不变。
4. 根据日志判断是判定逻辑问题还是数据源问题，不要凭记忆修改代码。

### 故障排查速查表

| 现象 | 优先查看文件 | 关键判断依据 |
|---|---|---|
| 完全无弹窗 | `.stop-probe.json`（mtime 是否更新）、`token-tracker-toast.log`（是否存在） | 若 probe 未更新，说明 Stop hook 未触发或命令失败；若 toast.log 无记录，说明判定未收口 |
| 弹窗延迟过长 | `token-tracker-toast.log` | 查看 `reason` 是否为 `stableCount>=3`，并看 `ts` 与 run 结束时间差 |
| 压缩上下文后提前弹窗 | `token-tracker-compaction.log` + transcript 尾部 | **v3.19.3 起判定已降级**：压缩状态机（compactionMode/compressionPending）经全量日志复核从未生效，已删除。现在只有一种压缩豁免——Stop 端 `no-token` 分支检测到「10 分钟内落盘的压缩标记」→ 静默跳过（落 `stop-no-token-compaction-skip`）。压缩后弹出的**正常轮结算窗**属预期行为，不再抑制 |
| 压缩期间连弹多条「本轮无 token 消耗记录」 | `token-tracker-compaction.log` | 查 `stop-no-token-compaction-skip` 是否存在：存在说明豁免已生效；缺失则说明末尾 30 行未命中标记或标记已超 10 分钟 TTL（`COMPACTION_MARKER_TTL_MS` 可调） |
| 弹窗内容异常（会话错乱） | `token-tracker-toast.log` + trace 文件 | 查看 `sessionId` 是否为空或与实际会话不一致；检查 trace 的 `sessionId` 字段 |
| 账本数据未更新 | `daily-usage.json`（mtime）、`.ledger-watermark.json` | 若 mtime 停在某时间，说明 Stop 路径未执行；结合 probe 判断 |
| 弹窗频繁重复 | `.ledger-watermark.json` + `token-tracker-toast.log` | 查看 watermark 去重是否生效，以及 toast.log 中同一 `reason` 是否反复出现 |
| 弹窗提示「⚠价库8/31」/ 价库不刷新 | `WorkBuddy\2026-08-30-22-25-15\prices\.refresh.lock`（失败会常驻）+ `.refresh.error`（v2.82 起失败留档）+ `binaries/python/envs/default`（venv 是否有 requests） | 刷新失败首查 `.refresh.error` 内容；「python 环境」问题查 resolvePython 是否命中 venv（v2.82 根修：候选表必须含 venv 路径） |
| 弹窗耗时与 WorkBuddy 显示差很多 | 本轮 trace 文件数量（`~/.workbuddy/traces/<pid>/` 同窗口几个 trace） | 长任务会分多个 trace 文件，v2.74 单文件口径只算最后一段（11:27 显示 4:22）；v2.82.1 起 = 最新 trace endedAt − 用户提交时刻（roundStart0），差 ≤1s |
| 新模型计费明显不对 / 显示 unknown | `pricing.json` 对应条目 + `daily-usage.json` 模型名 | v2.82.2 起 findModel 为单向边界匹配：`glm-5.3-air` 不会撞 `glm-5` 的价；模型名缺失（`unknown`）只记 token 不记钱——若出现 unknown 条目，说明 transcript 的 `providerData.model` 缺失 |
| 已下线模型（`retired: true`）仍按旧价计费 | `pricing.json` 该条目的 `retired` 与 `price_source` | **设计行为（v3.19.1 起明确写入文档）**：官方下线后仍保留最后已知官方价，供历史账本回溯；`findModel`/`calcCost` **不检查 `retired`** → 若该模型仍被调用则按留存旧价计费，且因官方已不再给价、该条目永不再更新、也不告警。要停用请显式删除条目或手工接管价格 |
| 官方调价后本地价一直不更新 / 手动条目长期 `pending-official` | `pricing.json` 该条目（`manual`/`lock`/`alias_of`）+ `_manual_audit` | v3.07 起官方页「模型版本」行与本地 key/name 对齐后**跨 key 接管**（官方价覆盖手动价 + 解绑 `manual`/`lock` + 打 `alias_of`）。若仍 pending：① 「模型版本」列数与模型列数不一致 → 安全降级为纯 key 匹配（不猜测对齐）；② 官方现行 ID 与本地 key 同名时走常规精确匹配；③ `alias_of` 条目在聚合源刷新时靠 `official.official[m.alias_of]` 回退取官方价，若被 llmabacus 价覆盖说明该回退失效 |
| 手动取消后不弹窗（v2.83+，v2.85 起实时补弹） | `token-tracker-toast.log`（搜 `cancelled-round-watch` / `cancelled-round-flush`）+ transcript 取消标记（`role=assistant`/`status=incomplete`/`error.message` = `Interrupted by user`） | v2.85 起每个新轮 hook spawn 轮级 watcher（`--round-watch`），取消标记收尾 + 8s 无新行即补弹，reason=`cancelled-round-watch`（有 usage）/`-est`（估算）/`-no-token`（无凭据）。若仍不弹：① 取消标记后直接跟 assistant 回复（续跑，设计内不弹）；② 轮已被结算（`lastStopAt ≥ roundStart`，防双弹退出）；③ 应用关闭时 watcher 被 Job Object 连带收割（失效边界，退回下一轮 hook 兜底 `cancelled-round-flush`） |
| 未取消却弹「（手动取消）」（v3.08 修复的误判） | 该轮 transcript（搜 `Interrupted by user`）+ 取消标记那一行是否带 `skipRun=true` + 标记之后是否存在「正常完成」的 assistant 行 + `~/.workbuddy/<proj>/token-tracker/<sid>/snapshot.json` 的 `lastStopAt` | v3.08 起：① 标记行 `skipRun===true`（应用中止在飞请求/编辑重发分叉，非用户取消）→ 不算取消；② 标记之后任意位置存在 `role=assistant` 且 `status!=='incomplete'` 的完成行 → 该轮已继续完成，不算取消；③ no-token Stop 已推进 `lastStopAt`，`intrInfo.ts > lastStopAt` 不成立则兜底不触发。若仍误弹：核查标记行是否确为 `skipRun=true` 且其后有完成行——若是而仍误判，说明兜底 `intrInfo.ts > lastStopAt` 校验没挡住（lastStopAt 陈旧），检查 no-token 分支是否真的写了快照 |
| 专家团金额疑似翻倍（双记） | `.ledger-watermark.json` 各会话水位线 + 账本模型 token | v2.82.2 起 incrementalRecord 整体加 `.ledger-watermark.json.lock` 水位线锁，watcher 与 Stop 并发只记一次；仍翻倍则查是否锁被异常跳过（stderr 有「水位线保持不推进」则下轮会补记） |
| 当日弹窗金额与 `recalc-day.js` 重算结果对不上 | `peak-rules.js`（唯一口径）+ `pricing.json` 的 `deepseek_rules.peak_schedule` | v3.19.0 前主脚本 / `backfill.js` / `recalc-day.js` 各存一份峰谷硬编码——官方调时段后增量记账判低峰、回溯重算判高峰，**金额静默差一倍且无报错**。v3.19.0 起三处统一委托 `peak-rules.js`；若仍不一致，`grep -n "9, *12" *.js` 查是否残留旧副本。**跨时段边界轮**（如 11:55→12:08）v3.19.2 起账本侧按**行时间戳**判峰谷（`calcCost` 的 `tsMs`/`stat.lastTs`），与 backfill/recalc 的逐行口径收敛；窗口未跨边界的轮不受影响 |
| 账本比实际用量**多记一行**（金额略高于预期，无任何报错） | transcript 中途是否存在**空行**或**永久坏 JSON 行**（`grep -c '^$'` / 逐行 `JSON.parse` 试）+ `.ledger-watermark.json` 的 `main` 值 | **v3.19.2 前**：`readTranscLinesFrom` 用「已解析行数」当水位线、却按「原始 `\n` 个数」做字节偏移 → 两者差 k（被跳过的空行/坏行数）→ 下一轮从偏早偏移重读已计过的行再记一遍（实测 1000/100 记成 **1100/110**），触发后自愈但不回滚。**v3.19.2 起**水位线口径统一为**物理完整行数**，不再漂移。若在旧版发现该症状：升级后重跑 `backfill.js --write` 重建账本 |
| 区间汇总的「缓存命中」与各天百分比对不上 | `--report <起>..<止>` 的输出 | **设计如此，不是 bug**：命中率是比率，区间值按 `Σ缓存 / Σ输入` **重算**（按 token 量加权），不是各天 hit 的算术平均——跨天量级差 100 倍时均值会严重偏离。要核对请手算 `Σ缓存/Σ输入` |
| CSV 用 Excel 打开中文列头乱码 | `exports/report-*.csv` 前 3 字节是否为 `EF BB BF` | 必须带 UTF-8 BOM，否则 Excel 按 GBK 解码必乱码。`--report --csv` 已固定写入 BOM；若仍乱码，先确认该文件是否被别的工具改写过 |
| 轮次明细里同一轮出现多条 | 各条的 `roundStart` 与 `source` | **正常**：同一轮可能分多批落盘（如 Stop 记一批、`--flush-delayed` 再补一批），`source` 区分来源。被幂等拦掉的只有「无新增用量」的重复 Stop。按轮聚合请用 `sid + roundStart` 分组 |
| 明细 `label` 为空 | 该轮 `roundStart` 与 transcript 中 user 行的 timestamp | `roundLabel` 只取 **timestamp ≥ roundStart** 的 user 行，且只扫 transcript **尾部 400 行**；取不到就留空（不编造）。常见原因：本轮很长、首行已被挤出尾部窗口；或测试夹具用了与真实时间不符的 `roundStart` |
| 回答末尾出现「本技能有新版本」 | `.update-check.json` 的 `latestVersion` / `notifyCount` | **正常**（v3.21.0 版本更新提示）。`notifyCount ≥ 2` 后自动静默；升级后本地版本 ≥ 远端即不再提示。想彻底关：`local-config.json` 写 `{"enable_update_check": false}` |
| 从没见过更新提示（但确实有新版本） | `.update-check.json`（是否存在 / `lastCheckAt` 是否在 7 天内 / `failCount`） | ① 检查只在 `--hook` 触发，`--stop`/手动模式永远不会提示；② 7 天闸门内不重复查；③ `failCount ≥ 3` 会当周停止重试；④ `ENABLE_UPDATE_CHECK` 或 `ENABLE_NETWORK` 关掉时静默跳过。**注意：装了旧版的用户根本不会有这个文件——检查逻辑在被安装的那份代码里** |
| 更新提示重复出现很多次 | `.update-check.json` 的 `notifiedVersion` / `notifyCount` / `lastNotifyAt` | 设计上限是**同一版本最多 2 次、间隔 ≥24h**。若远超此数：确认状态文件是否可写（写失败会导致次数不累计），或每次都在换技能目录（状态文件跟着目录走） |
| 弹窗第一行尾部出现 `｜⬆v3.22.0` | `.update-check.json` 的 `lastHookAt` | **正常且只应出现在"没配 UserPromptSubmit hook"的机器上**（v3.22.0 toast 兜底）。判据：`lastHookAt` 缺失或距今 ≥3 天。若已配 hook 却仍出现 → 说明 `--hook` 根本没被触发（检查 `settings.json` 的 `UserPromptSubmit` 配置），顺手就把"注入通道失效"这个更大的问题暴露出来了 |
| 怀疑「有新版但用户收不到提示」 | `.update-check.json` + 该用户是否配了 `UserPromptSubmit` hook | 逐条排查：① `ENABLE_UPDATE_CHECK`/`ENABLE_NETWORK` 关了；② 7 天闸门未到；③ `failCount ≥ 3` 当周停；④ 远端版本没高于本地 `SKILL_VERSION`；⑤ **没配 `--hook`** → 只有 toast 兜底（首轮会因检查而略慢约 1.5s，之后正常）；⑥ 用户装的是 v3.21.0 之前的版本 —— **那些版本的代码里根本没有检查逻辑，收不到是必然而非 bug** |
| 用户问「这周/本月」却拿到一大张全部天的表 | 你实际跑的命令 | 跑错命令了：「这周」→ `--report week`、「本月」→ `--report month`、「某段日期」→ `--report <起>..<止>`；只有「全部/历史」才用 `--report all`。详见「自然语言问法 → 命令映射」 |
| 用户问「哪一轮最贵 / 子代理占了多少」但答不上来 | `rounds/rounds-YYYY-MM.jsonl` | **没有 CLI 入口**，账本粒度是天。只能读那个 jsonl 文件（这不算「绕过 --report 解析账本」，账本与轮次明细是两回事） |
| 用户说「统计的比我实际扣的少」 | 弹窗是否标了 `（估算）`、账本该轮 token | **很可能属实，不要辩解**：长思考被手动停止那部分云端已计费但本地不落盘，本技能只能估算且通常偏低；内置积分模式的额度扣减本技能也读不到。正确回答：以服务商账单 / WorkBuddy 积分记录为准（见「数据源与准确性」的统计范围边界） |

> ⚠️ **hooks 命令铁律**：所有 hook 命令必须保持**纯净的 `node` 调用**（如 `node C:/.../token-tracker.js --stop`），**禁止使用 `cmd /c` 包装或环境变量前缀**（如 `cmd /c "set X=1 && node ..."`）。此类包装会被 WorkBuddy 判为无效 hook 配置（`Invalid hook config`），导致整个事件组（Stop / UserPromptSubmit）跳过、进程瞬间失败且无任何日志产物。调试日志已改为弹窗时自动记录，无需通过环境变量或命令前缀开启。

## 反借口表（2026-09-14 补）

| 我会这么想 | 现实 |
|---|---|
| 数字差不多就行 | 账本只许技能自带入口读，禁手撸脚本解析 `daily-usage.json` |
| 自己写个脚本解析更快 | PreToolUse 有物理拦截，绕过会被 deny |
| 报个总消耗就够了 | 问账本必须跑 `--report` 并**原样贴出** 7 列 Markdown 表格 |
| 金额估算随便填 | 走 `pricing.json` 口径，不自造单价 |
| 这条没记上，算了 | 有行数水位线机制；缺记要查根因，不能放过 |
| 表格列太多，精简一下 | 7 列一列都不能少，格式不许改 |
| 金额就是我真花的钱 | 除非自备 API key，金额一律是按 API 单价折算的**等价计价**，与客户端积分/额度**无换算关系**——要分析用量以 token 列为准 |
| 导 CSV 顺手把表格也贴一遍 | `--csv` 模式只回一行导出路径；表格贴出来纯刷屏，文件是给 Excel 用的 |
| 收到「[技能更新]」就顺手把升级步骤贴出来 | 注入行只要求**末尾提一句**；升级步骤只在用户追问时给，且照 SKILL.md「版本更新提示与如何升级」那一节回答——注进上下文的内容本身不含任何升级步骤是有意的 |
| 更新提示每轮都值得提一遍 | 脚本已按「同版本最多 2 次、间隔 ≥24h」节流；重复提只会让用户反感 |
| 弹窗标了`（估算）`，数字看着也差不多，就当实测报 | 被中断的长思考**云端已计费、本地只有估算**，且估算**通常偏低**（思考文本本身可能被截断）。必须点明这是估算而非实测 |
| 用户说「你这统计比我实际扣的少」，先解释成他记错了 | 大概率**用户是对的**：被中断的思考、内置积分模式的额度扣减、WorkBuddy 之外的调用，本技能都拿不到。如实说明边界，并引导以服务商账单 / 积分记录为准 |

**红旗（出现即停）**：手算费用；拿别处的数字代替账本；改了表格列或格式；绕过 `--report` 直接读原始文件；主动展开版本更新说明或升级步骤；把 `（估算）` 当实测数字报，或对「统计不全」的质疑作辩解。
