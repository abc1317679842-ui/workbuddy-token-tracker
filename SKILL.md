---
name: token-usage-tracker
description: 在每次回答结束后弹出 Windows 系统通知（toast），显示本条真实 token 消耗、耗时与费用估算；并在本地记录每日分模型账本（各模型输入/输出/缓存命中/总 token/金额 + 当日合计，长期保存可查历史）。【仅适配 WorkBuddy 桌面客户端（Windows），不适用于其他 AI 工具/平台——数据源是 WorkBuddy 每轮调用后落盘的 trace/transcript 文件，依赖其 hooks 机制】WorkBuddy 客户端不显示 token（内置模式只显示积分、自有 API 模式也不显示），但每轮 LLM 调用结束都会把真实 token/耗时落盘。本技能通过 Stop hook 读取该数据，在每次回答结束后自动弹出 toast（模型名/耗时/今日累计/输入输出 token/费用），同时把本轮消耗按模型累计进 `daily-usage.json` 每日账本；`--hook` 模式在下一轮提交时把上一轮用量注入上下文作兜底；`--report` 命令可查看今日/历史每日明细与合计。当用户说「显示 token」「看消耗」「这次用了多少 token」「统计用量」「看每日消耗」「看历史用量」或任何希望看到每次回答成本时触发。
type: skill
---

# Token Usage Tracker（每轮 token 消耗追踪）

## 环境要求（新用户先看）
- **仅适配 WorkBuddy / CodeBuddy 桌面端（Windows 10/11）**：本技能的数据源是客户端落盘的 `~/.workbuddy/traces/<pid>/trace_*.json`（每轮模型调用结束自动生成）+ 客户端 hooks 挂载点——**其他 AI 工具/平台（Claude Code、Cursor、ChatGPT 桌面版、其他 OpenClaw 客户端等）没有这套机制，装上也不会工作**，请勿在其他环境安装。
- **Windows 10/11**：系统通知（toast）仅 Windows 支持；macOS/Linux 可正常手动使用（方式 A），但不弹通知。
- **Node.js ≥ 20**：脚本零依赖单文件，无需 npm install。

## 当前功能总览（v2.82.3 · 2026-09-01）

> **v2.82 系列要点（详见文末更新记录）：** 本地价格库每日自动刷新根修（resolvePython 补 venv）+ 刷新子进程 180s 超时治理 + 护栏 A 修复（价格库不再被清空）+ 流水线原子写并发加固 + build_index 逐模型沿用（官网软 404 不丢模型）；**v2.82.1** 弹窗耗时口径根修（= 最新 trace endedAt − 用户提交时刻，与 WorkBuddy 显示差 ≤1s）；**v2.82.2** findModel 单向边界匹配（未收录不再撞价）+ incrementalRecord 水位线锁（专家团 watcher/Stop 并发不双记）+ 缓存价缺失置 null（不拍脑袋 ×10%）+ 缺名不记价；**v2.82.3** 锁等待 Atomics.wait 去忙等。全套 108 项测试 + 全天账本对账 0 差异。

> **⚠️ 强制（查询触发总纲）：所有统计查询必须调用 `--report` 命令并原样贴出脚本输出，禁止自行解析 JSON。** 无论用户问「今日消耗」「今天用了多少」「账本」「报告」「统计」「花费」还是历史某天，一律先跑 `node token-tracker.js --report`（或 `--report <日期>`），再把脚本打印的 Markdown 表格原文贴给用户；不得自行读取 `daily-usage.json`、不得自行汇总、不得转成列表/纯文本/代码块。详细规则见下方「查询触发规则（强制）」与「展示格式约束（强制）」。

> **v2.82.2（2026-09-01，全方位审查三修）：** 备份含于 `*.bak-before-fix-20260901`。
> - **findModel 计费匹配收紧（中一）**：v2.71 双向 includes 任意子串会把未收录模型撞到无关 key（glm-5.3-air→glm-5 价、kimi→kimik25 价），且因「宽松命中=已收录」不再联网补真价 → 错价永久化。改为**单向边界分隔匹配**：仅允许 norm 较长、key 是 norm 的边界子串（`-/_:空格/中文` 为边界，`.` 不算——glm-5.3 与 glm-5 是不同模型）。hy3-x→hy3、deepseek-ai/DeepSeek-V4-Flash→deepseek-v4-flash 仍命中；kimi/gemini-3.7/glm-5.3-air → null 走补价。
> - **incrementalRecord 竞态锁（中二）**：watcher(--flush-delayed) 与新一轮 Stop 并发时读同一旧水位线 → 同一批行各记一遍（专家团 6s 确认窗 ∩ 新 Stop 可触发）。整个「读水位线→算增量→记账→推进」放入 `.ledger-watermark.lock`；拿不到锁本轮跳过、下轮补记（不丢不重）。`withFileLock` 已导出供测试。
> - **自动补录缓存价不估算（中三）**：llmabacus/USD 无缓存价时原按输入价×10% 拍脑袋（DeepSeek 实际 3.3% 高估 3 倍、glm 25% 低估）→ 改为 `cached_price: null`（按 0 计，宁少算不估错），note 标注待人工核验。
> - **缺名不记价（用户 03:42 反馈）**：`calcCost` 旧代码 `stat.model || 'deepseek-v4-flash'`——模型名缺失时把 token 按 v4-flash 价入账（错价）。现空名 / 'unknown' 一律返回 null（只记 token 不记钱）；`aggregateTranscLines` 缺名时输出 'unknown' 而非空串（弹窗可见、可追查）。
> - **锁等待去忙等（v2.82.3）**：`withFileLock` / `withPricingLock` 重试等待原为 `while(Date.now()<end)` 空转（50×100ms 白烧一个核）→ 改 `Atomics.wait` 真睡眠（零依赖，catch 降级空转保底）。复查：锁嵌套顺序固定 wm→daily→pricing 无死锁；watcher 轮询与 trace 等待循环内部均有 sleep（Atomics.wait 实现），非忙等；无连锁影响。全套 105 项 0 失败 + 账本对账 0 差异。
> - **专家团双记集成验收（test-expert-race.js）**：造真实形态多子代理 transcript（主 20 行 + subagents 5 行），两进程并发调 incrementalRecord（模拟 watcher 与 Stop 同窗）——账本只记一次（in=20000/2500 精确，双记会是 40000/5000）；第二轮并发仍不重复（水位线已推进）。锁失败→本轮跳过下轮补记（不丢不重）；嵌套顺序固定无死锁；崩溃残留锁由 pidAlive 接管。全套 62+13+16+14+3 = 108 项 0 失败，测试自备份自恢复不污染真实账本。
> - **退役模型自动淘汰确认**：refresh-prices 每日以聚合源为基准合并，官方已下线的 deepseek V3 系（retired:true，账本零记录）在刷新时被自然淘汰（31→26），无需手动清理；当前 pricing.json 26 个全部为官方在售模型。
> - 验证：新增 `test-audit-fixes.js` 14 项（findModel 边界矩阵/缓存价 null/锁互斥两进程实测）+ 全套回归 62+13+16 = 105 项 0 失败 + audit-ledger 全天账本对账 0 差异。

> **v2.82.1（2026-09-01，弹窗耗时口径根修）：** 备份含于 `*.bak-before-fix-20260901`。
> - **耗时 = 最新 trace `endedAt` − 用户提交时刻(roundStart0)**。v2.74 用「单 trace 文件 startedAt→endedAt」，但长任务落盘多个 trace（切分时机由客户端决定、不可预测）：实测 11:27 的任务只显示 4:22；有时单文件恰好覆盖全轮又显示对——「时对时错、修了还犯」的根源。WorkBuddy 显示的就是「提交→最后一次 LLM 结束」墙钟，实测新公式 687.0s 与其 11:27 **分毫不差**（旧公式 262s 错 62%）。
> - 计算核心提为 `traceWallDurMs(ltPath, roundStartMs, sid)`（已导出，可独立测试）：roundStart0 缺失 / endedAt 缺失或早于起点（防负数）/ 异会话归属 / trace 损坏 → 一律回退 transcript 口径，绝不抛错。
> - **hook 起点语义实证**：snapshot 证明 `lastUserMsgAt` = 用户点发送瞬间（与系统时间分毫不差）；用户连点多次提交时 hook 记最后一次（与 WorkBuddy 入列计时一致）。同毫秒证据：user 行落盘时刻 = 当次 trace.startedAt。
> - **fetch-cn-prices 联动修复**：`parse_pricing_deepseek()` 只合并 `lock=True` 条目——回填的非 lock 兜底价（8-23 聚合源）曾被标成 first_party「用户已校对官方价」混入本地库且下架模型永久冒充新鲜数据；现在缺失模型走沿用逻辑（`carried_from`/`missing_since` 标记，7 天自动淘汰）。
> - 测试：`test-duration-fix.js` 16 项（真实 4-trace 重放 + 单 trace 回归 + 合成 9 场景）+ 回归 62+13 项，共 **91 项 0 失败**。

> **v2.82（2026-09-01，本地价格库四连修 + 并发加固）：** 备份 `*.bak-before-fix-20260901`（tracker/refresh/pricing + 流水线三脚本，可整体回滚）。
> - **resolvePython 补 venv 候选（根因主修）**：旧候选表只有托管 python（无 requests）与裸 python，唯一带 requests 的 venv（`binaries/python/envs/default`）不在表里 → 本地价格库自动刷新**从上线起就没成功过**，`.refresh.lock` 常驻、弹窗永远「⚠价库8/31」。现 venv（Win `Scripts/python.exe` / POSIX `bin/python`）排最前。
> - **刷新子进程超时保护**：180s SIGKILL（旧版网络 hang → 锁永久卡死不再重试）；捕获 stdout/stderr，失败写 `.refresh.error` 留档（旧版 `stdio:'ignore'` 全静默，出了问题无处可查）。
> - **refresh-prices 护栏A修复**：`lu == null || lu < cutoff` → `lu != null && lu < cutoff`——注释写「未用过的保留」，代码却在删，每次刷新把不在 daily-usage 的模型全删空（26→6，4 个靠 lock 幸免）。实测 `--force` 后零丢失。
> - **findModel 跨库 alnum 桥接**：本地价库 key 是去标点的 `glm53`，findModel 只做大小写归一 → `glm-5.3` 永远未命中、反复联网补录。现严格匹配失败后追加「两边都去标点且**完全相等**才命中」的桥接——不违反 v2.67 严格匹配（不做库内模糊归并，`deepseek-v4-flash` 与 `-vision-exp` 仍严格区分）。
> - **流水线并发加固（fetch/parse/build 三脚本）**：写盘全改「唯一 tmp(PID)+os.replace」——多会话并发时两个 build_index 互写 `index.json.tmp` → PermissionError exit=1；fetch 裸写 latest.json 会让并发的 build 读到半截 JSON。
> - **build_index 逐模型沿用**：旧版按「厂商当天整体缺席」判断，Moonshot 官网改版（chat-k25/chat-v1 软404）当天仍抓到 4 个 → 缺失的 kimik25 等 4 个被静默丢弃（35→31，用户用这些模型当天按 0 元计）。现任何上一版有、本次缺失的都沿用旧价并标 `carried_from`，`missing_since` 超 7 天才淘汰。
> - 验证：62+13 项测试 0 失败；完整流水线并发×3 全 exit=0（11.5s）；强制刷新后 pricing.json 零丢失。

> **v2.68（2026-08-28，数据完整性 4 项 + 锁逻辑同步）：** 备份 `token-tracker.js.bak-dataintegrity-20260828`。
> - **记账失败不再推进水位线**：`saveDailyUsageRaw` 返回成败 → `recordUsage` 回传 → `incrementalRecord` 先算候选水位线，**仅记账成功才提交**。此前账本写入失败（Windows 下 `rename` 覆盖被占用文件会 EPERM）而水位线照推进，这部分用量**永久丢失**且只留一行 stderr。现失败则保持旧水位线、下轮补记。
> - **transcript 截断不回退水位线**：`entry.main` / `entry.subs[f]` 改取 `Math.max(旧值, 当前行数)`。此前 transcript 行数下降（Context Compaction 重写、外部工具截断）会把水位线拉回小值，文件重新长回原长时**重复计费**。代价：截断后被重写到同行位置的内容不再重记（少记优于多记）。
> - **水位线键消除跨项目串扰**：新增 `ledgerKey(sid, tsPath)`——有 `session_id` 用原值（行为不变），无则用 transcript **完整路径** sha1 前 16 位。此前 watcher 用 `sid || basename`、记账用原始 `sid`（空串），两处不一致且 basename 跨项目同名会撞键，实测两个 `default.jsonl` 只记一半用量。已确认线上 79 个键全是真实 session_id，换键不触发重记。
> - **锁抢占安全化**：`withFileLock`（及 `refresh-prices.js` 的 `withPricingLock`）抢占规则改为**只看持有者 pid 存活**——存活绝不抢、已死立即接管、解析不出 pid 才退化为 TTL 判定；TTL 30s → 300s。此前超 30s 就抢，会把仍在工作（只是慢）的持有者的锁抢走 → 两进程同时写。重试上限 5s，不会死等。

> **v2.67（2026-08-28，模型名严格精确匹配）：** `findModel` 只认**归一化后完全相等**的模型名，一个字符不同即视为不同模型、分开统计分开计费。
> - 删除：双向 `includes` 模糊匹配、版本/日期后缀归并（`isVersionSuffix`）、`.` 与 `-` 等价替换（`normalizeModelKey`）、自动推断的别名表条目。
> - 保留：归一化 = 统一小写 + 去首尾空格 + 连续空格合并（仅此三件）；`MODEL_ALIASES` 保留为空表，供人工核实后手动添加等价名。
> - 依据（源数据核查）：日期后缀模型价格**不可靠地相同**——`deepseek-r1`(0.700/2.500) vs `r1-0528`(0.500/2.150) 日期版更便宜；`chat-v3-0324`(0.250/1.000) vs `chat-v3.1`(0.550/1.650) 新版更贵 2.2×；`v4-pro`(0.870/1.740) vs `v4-pro-0813`(0.660/1.980) 交叉（输入便宜、输出更贵）。
> - 影响：未收录模型返回 `null` → 走 `ensureNewModelPricing` 联网补价；补价失败则记 token 不记金额（宁可不计价也不算错价）。

> **v2.66（2026-08-28，数据完整性 10 项 + 3 个额外 bug）：** 备份 `*.bak-full-fix-20260828`。
> - 原子写：水位线 / `daily-usage.json` / `pricing.json` 全部改为「临时文件 + rename」，写失败不动原文件。
> - 损坏自愈：`loadDailyUsage` 解析失败 → 备份 `.corrupt-<时间戳>` + 本轮禁写（不用空对象覆盖历史）；`loadLedgerWatermarkSafe` 三级降级（主文件 → `.bak` → 跳过记账）；`autoRefreshPricing` 遇 null/非对象自动重建。
> - 并发锁：`recordUsage` / `saveDailyUsage` / `addModelPrice` 全部加锁；`addModelPrice` 在**锁内重新读盘再合并**（防读改写竞态丢更新）。
> - 记账口径统一 `extractUsageFromRow`（兼容 `pd.usage` / `pd.rawUsage` / `message.usage`）；模型名归一化（大小写/空格）避免同模型拆多条。
> - 其它：刷新超时 15s → 60s；`findModel` 先去掉模糊 includes 改为严格三级匹配；`sessionId` 解析失败回退 basename（不再用 `'unknown'`）并兼容 `sessionId`/`session_id` 写法。
> - 额外修复 3 个 bug：`require('refresh-prices.js')` 会触发 `main()` 联网刷新（加 `require.main === module` 守卫）；`addModelPrice` 内部会把模型名转小写（文档口径统一）；水位线损坏即重复计费。
> - 验证：9 个测试脚本 94 条断言全通过；真实数据冒烟无回归。

> **v2.65（2026-08-28，价格刷新改由 Hook 触发 + 清理长期未用模型）：**
> - **刷新时机挪位**：全量刷新从 `--stop` 路径移到 `--hook`（用户提问时触发）。避免 Stop 路径被联网阻塞、拖慢弹窗。`--stop` 仍保留新模型补价。
> - **清理陈旧模型**：`refresh-prices.js` 刷新时删除「未出现在 `daily-usage.json` 或超过 14 天未使用」的模型，`lock: true` 的（`deepseek-v4-flash` / `-vision-exp` / `v4-pro`）始终保留。被删模型在用时会由 `ensureNewModelPricing` 自动补回。

> **v2.64（2026-08-28，新模型首用 cost 丢失修复）：** Stop 路径中 `incrementalRecord`（记账）原本在 `ensureNewModelPricing`（补价）**之前**执行，而记账内部 `loadPricing()` 读的是磁盘——新模型首用时定价尚未落盘 → `calcCost` 返回 null → **token 记了、金额静默丢弃**。改为**先补价再记账**。已收录模型不受影响（`findModel` 命中即直接返回，不联网）。

> **v2.59（2026-08-23，DeepSeek 官方定价直连 + 生效时间机制 + P0-1 回归修复）：**
> - **官方定价直连抓取**：新增 `deepseek-official.js`，每日直连 DeepSeek 官方定价页解析模型清单 + 价格（空闲/高峰）+ 时段 + 周末规则。DeepSeek 系官方优先、官方没有的（已下线 V3 等）回落聚合源；模型清单自动对齐（官方新增自动收录、官方下线自动标 `retired`，如 vision-exp 已自动收录）。
> - **峰谷时段通用跟随**：`isPeakHour(rules, now)` 读官方规则，官方改任何时段/周末规则自动生效；周末低峰（周六周日全天低谷价）默认开启。
> - **生效时间机制**：官方"将于...起"预告 → 存 `deepseek_rules_pending`，生效前用旧规则、到点自动切换（如 8-23 00:00 起周末统一低谷）。
> - **P0-1 回归修复**：watcher compaction 期间 unknown 误弹（R1 回归）——`readTailRaw` 末行内容对比识别 transient unknown，改写中续等不弹、真停写才 6s 收口。
> - **调试清理**：临时 DBG 探针已删除；watch-debug 改为 `WATCH_DEBUG=1` 环境变量开关（默认关）。

> **v2.60（2026-08-25，统一稳定帧保护 + 去冗余确认窗 + 修复 compaction 后 final 提前弹窗）：**
> - **统一所有终态稳定帧保护**：将 `unknown` 分支的 `stableCount >= 3` 门槛扩展到 `final` / `terminal-error` 分支（原 `final` 仅靠单一 6s `confirmSince`，compaction 等长重写后末行被判为 `final` 且模型静默 >6s 即误弹）。`interrupted` 为真终态保留立即判定，仅享受 transient 重置保护。
> - **去除冗余确认窗口**：`stableCount >= 3` 即直接收口（触发弹窗），不再启动/检查 `confirmSince` 6s 等待；正常回合结束弹窗延迟从 ~12–15s 收敛回 ~6–9s（仅 3 稳定帧）。
> - **保留子代理安全闸门**：`final`/`terminal-error` 收口前仍校验 `pendingSub` 与子代理文件活跃度（v2.43/v2.47/deadTeam），活跃团队运行期间绝不提前结算。
> - **重置一致性**：`hasNewTail()`/`newAgent` 新活动与 compaction 检测、文件不可读均正确归零 `stableCount`，杜绝计数残留误判。

> **v2.61（2026-08-25，清理 + 性能 + 可观测性 + 弹窗回归修复）：**
> - **【关键修复】showToast 回归修复**：v2.59 的 compaction-fix 误将同步 `execFileSync` 改为 `spawn('powershell.exe', […], { detached: true, stdio: 'ignore' }) + child.unref()`，导致 watcher 进程退出时 PowerShell 子进程被提前终止、toast 通知丢失（表现为「完全无弹窗」）。本版回退为原同步 `execFileSync`（带 `timeout: 10000`、`stdio: 'ignore'`、`windowsHide: true`），保证 toast 弹出后父进程才退出。
> - **清理残留**：删除已不再使用的 `WATCH_CONFIRM_MS` 常量与 `confirmSince` 变量的全部声明/赋值/读取及关联注释（v2.60 已用 `stableCount>=3` 直接收口取代 6s 确认窗，该变量成为死代码）。
> - **`getTranscriptStats` 性能优化**：① 不再 `split('\n')` 生成整文件行数组，改用 `'\n'` 字符计数（`换行符数 + 1`，与原 `split` 行数在所有情形一致，已用边界用例验证）；② 新增模块级 `transcriptStatsCache`，当 `path` 与 `mtimeMs` 均命中时直接返回缓存，跳过 `fs.readFileSync` + 整文件扫描（对 91MB transcript 每轮 3s poll 的 I/O/GC 压力显著下降）。
> - **调试日志**：（v2.61 原始实现，v2.63 已重构，见下）新增 `writeDebugLog(message)`（受 `TOKEN_TRACKER_DEBUG=1` 开关控制，默认关闭；日志落 `~/.workbuddy/token-tracker-debug.log`，超 5MB 自动清空）。每轮 poll 落完整状态（ts/sessionId/lineCount/stableCount/st/hasNewTail/pendingSubCount/interrupted/deadTeam/tailRawPrefix/lastTailRawPrefix），compaction 期间单独落 `compaction-continue`；任一 `break` 触发弹窗前落 `==== TOAST TRIGGER ====` 含 `reason`（`busy-timeout`/`interrupted`/`deadTeam`/`stableCount>=3`/`idle-timeout`）与关键状态，便于排查提前弹窗与 compaction 误判。

> **v2.63（2026-08-25，弹窗诊断日志——调试日志机制重构）：废弃环境变量开关，改为「弹窗即记录」。**
> - **废弃 `TOKEN_TRACKER_DEBUG` 开关 + poll 全量记录**：旧方案默认关闭、打开后每轮 poll 全量落盘，噪音大且排查时必须先验开启。改为**每次 `showToast` 无条件**向 `~/.workbuddy/token-tracker-toast.log` 追加一行 JSON 诊断，**无需任何环境变量开关**——弹窗这个动作本身就是最值得记录的事件，排查「为什么弹了 / 为什么没弹」直接翻这个文件即可。
> - **日志字段**（`writeToastLog(reason, state)` 写入的单行 JSON）：`ts`、`reason`（触发原因：`busy-timeout`/`interrupted`/`deadTeam`/`stableCount>=3`/`idle-timeout`，取不到为 `unknown`）、`sessionId`、`traceFile`、`toastText`（实际弹出的文本，截断 200 字符）、`lineCount`、`stableCount`、`compactionSuspected`、`compactionMode`、`lastMarkerId`、`tailRawPrefix`/`lastTailRawPrefix`（各截断 80 字符）、`pendingSubCount`、`hasNewTail`、`watchStartTime`。字段缺失一律写 `null`，**日志写入失败静默吞掉、绝不阻塞弹窗**。
> - **轮清策略**：`MAX_TOAST_LOG_SIZE = 5MB`，超过即清空后重新追加，避免无限增长。
> - **配套提取（v2.63.1 / v2.63.3）**：`traceFile` 由 `latestTraceFile(true)` 取 basename（模块级 `gLastTraceFile` 兜底，循环外调用也能带上）；`sessionId` **优先用 payload 的 `sid`，缺失时才从 `tsPath` 的 basename 提取**（去 `.jsonl`，如 `7386b18a-….jsonl` → `7386b18a-…`）。目的：诊断日志里 sessionId / traceFile 不再为 `null`/`unknown`，多会话并发时每条日志都能归属到具体会话与 trace 文件。
> - **诊断状态来源**：watcher 轮询把状态快照存入 `gLastWatchState`，`showToast` 内部据此补全字段；循环外调用（估算 / 无记录 / 挂起聚合补弹）该快照可能为 `null`，故 `writeToastLog` 必须容忍字段缺失。

> **v2.62（2026-08-25，compactionMode 方案——替换失效的行数减少检测）：**
> - **背景/根因**：原压缩检测为「transcript 行数减少 > 5 → 判定发生了上下文压缩」。但本客户端 transcript 是 **append-only**（只追加、不回删），行数永不减少 —— 该方案在此客户端**永远不触发、检测彻底失效**，导致压缩期间收口逻辑被误判为「正常稳定」而提前弹窗。
> - **新方案（compactionMode）**：每轮 poll 用 `readTailRawLines` 读 transcript **末尾 30 行**，识别压缩标记（`role=user` 且内容以 `<conversation_history_summary>` 或 `<cb_summary>` 开头）：
>   - **出现新压缩标记**（当前最新标记非空且 id ≠ 上一轮 `lastMarkerId`，已滑出窗口的 `null` 不视为新标记）→ 置 `compactionMode = true`、`compactionSuspected = true`，本轮 `continue` 跳过收口（不弹窗）；
>     - **首次进入**（`compactionMode` 原为 false）额外做**完整重置**：`stableCount = 0` + 刷新 `busySince` / `lastActiveAt` + 清空 `lastTailRaw`，避免压缩期间误收口；
>     - **后续新标记**只做「暂停本轮」，**不重复重置**（否则多轮压缩会反复归零、永不收口）。
>   - **无新标记** → `compactionSuspected = false`，直接进入正常收口逻辑；`compactionMode` **置 true 后整个 watcher 生命周期内保持，不回退为 false**（历史事实标记，供诊断日志与后续判定参考）。
> - **状态变量**：`compactionMode` / `lastMarkerId` / `processedMarkers`（已处理标记 id 集合，仅用于观测计数 `processedMarkerCount`）。
> - 备份：`token-tracker.js.bak-before-compactionMode-fix`（已归档至 `docs/archive/`）。

> **v2.58（2026-08-22，展示约定固化）：`--report`（明细版）每天合计行正下方固定输出一行「展示约定」提示**——「向用户展示以上账本时，请直接使用上面的 Markdown 表格原文（保留完整 7 列，不要手排/转纯文本/缩写）」。目的：调用方（AI 助手）读取账本数据时，最下面这行字即告知展示规则，无需再翻技能规定的展示格式约束。适用所有日期档（今天/历史/all）。

> **v2.57（2026-08-21，第一阶段确定性 Bug 修复）：终态错误识别 + watcher 可观测性。**
> 修复「429 限流 → `mainModelState` 落 `unknown` → watcher 无限空转 → coalesce 残留 → 直到下次用户提交才补弹」的确定性 Bug（Bug 会话 aa64e728 实测：18:04:46 Stop `stopReason=failed`，toast 延到 18:19 才弹，显示 1h36m）。
> 三项改动：① `mainModelState` 新增 `terminal-error` 终态（末行 `role=assistant` + 明确 `providerData.error` 且 status 命中 429/5xx/timeout 才算，**单纯 `status=incomplete` 不算终态**，避免误弹被中断的合法思考）；② watcher 主循环对 `terminal-error` 与 `final` 同等对待进入确认期收口，专家团（pendingSub>0 且子代理活跃）仍遵守团队生命周期不提前结算；③ watcher 调试日志 `.watch-debug-<sid>.jsonl`（每轮记录 state/reason/confirmSince/pendingSub/tail/terminalError/unknownStreak，上限 2000 行自动截断），`unknown` 只计数不弹窗（本阶段不把 unknown 超时当终态，误弹风险）。Stop payload 实测无 `stopReason` 字段（只有 SessionHookManager 内部日志有），故以 transcript 末行终态错误判定同口径替代。

以下为 v2.55 的功能总览（保持不变）：

> 本技能以 **Windows 系统通知（toast）** 为唯一展示通道：每次回答结束后，由 `Stop` 钩子读取本轮真实落盘数据，自动弹出本条消耗。以下是当前支持的全部能力：

- **本地模型识别增强（v2.54~v2.55，2026-08-18）**：`isLocalModel()` 构建本地集合时按 url 特征判断——**host 是本机（localhost/127.0.0.1/0.0.0.0/::1）→ 无条件本地；host 是局域网 IP（192.168.x/10.x/172.16-31.x）且端口命中已知本地服务端口 → 本地**。已知本地端口：Ollama:11434 / LM Studio:1234 / llama.cpp·llamafile·LocalAI:8080 / vLLM:8000 / Jan:1337 / GPT4All:4891 / koboldcpp·oobabooga:5000·5001。本地部署（Ollama/LM Studio/llama.cpp/vLLM 等）模型即使名字与云端同名（如 `qwen3.8-27b` 撞 OpenRouter 的 `qwen/qwen3.8-27b`）也一律计费 0、只统计 token，并禁止自动补录云端价。修复动机：本地模型改名 `qwen3.8-27b` 后与 pricing.json 云端条目精确同名，被按云价误计费 3.32 元（详见 daily-usage 修复）。
- **本条精确统计**：`Stop` 钩子在回答完全结束后触发，此时本轮 trace/transcript 已写完，弹出的是**本条回答**的真实 token、耗时与费用（不是上一轮）。
- **toast 两行大字布局**：行1 标题大字 = 模型完整名 + 时段标注（`高峰双倍`/`夜间X折`）＋ 换行后 = `耗时` + `今日¥X` + `余额¥Y`；行2 正文小字 = `输入/输出 token` + `缓存占比` + `本条费用`。
- **每日分模型账本（v2.39）**：每轮 Stop 自动把消耗**按模型**累计进 `daily-usage.json`（本地日期分桶，`{日期:{models:{模型:{in,out,cached,hit,total,cost}}, total:{...}}}`，`hit` = 缓存命中率%（两位小数，cached/in）），**每天保留两套统计**：`models` 各模型明细 + `total` 不分模型的当日总合计（输入/输出/缓存命中/总 token/金额，含总命中率）。**长期保存不裁剪**，可查任意历史天。查看：`node token-tracker.js --report`（今天）／`--report all`（全部天）／`--report <日期>`，也可让助手直接读文件整理展示。
- **今日累计**：toast 行1 显示 `今日¥X.XX`（读当日账本 total.cost，含本条）。
- **时段标注**：DeepSeek 原厂系支持峰谷定价（工作日北京 9-12/14-18 高峰 ×2），自动标注 `高峰双倍`；其他模型无峰谷。策略存于 `pricing.json` 手动维护字段。
- **余额显示**：仅 DeepSeek 自定义 API 且开启开关时启用，默认隐藏 + 变化检测（余额变才显示），15 秒 TTL 缓存。
- **专家团/多子回合聚合**：识别 `Agent`/`TeamCreate` 等团队活动，专家团跑完延迟约 6 秒**只弹一次整轮汇总**，不重复弹 N 次。
- **多会话隔离**：按 hook payload 的 `session_id` 拆分快照，多会话并发互不串扰。
- **价格体系（零密钥联网）**：`pricing.json` 官方人民币价 + 每日自动多源刷新（国内 llmabacus/llm-prices-cn + 国外 OpenRouter/LiteLLM/Portkey，按模型 region 区分国内外，取中位数）+ 未收录新模型自动联网补录（国内源优先，人民币价）。默认零密钥：仅余额查询携带 API key（默认关闭）。
- **快照自动清理**：`.snapshot-<sid>.json` 保留最近 30 天 + 最多 50 个，当前会话永不清。
- **兜底通道**：`--hook`（UserPromptSubmit）在下一轮提交时把上一轮用量注入上下文；手动运行 `token-tracker.js --stop` 查看最近一轮。
- **每日账本报告**：`node token-tracker.js --report [all|<日期>]` 输出每日分模型明细 + 当日合计（今天/历史任意天）；`--report summary [all|<日期>]` 只输出每天**总合计**（一行/天，不含模型明细）——仅供助手内部快速判断/调试用，**禁止**作为给用户的展示输出。
- **展示格式约束（v2.39.2，强制）**：向用户展示账本数据**一律用 `--report`（明细版）**，其输出为 **Markdown 表格**（表头 + 每个模型一行 + 合计行加粗，**含单模型明细与总计**），**表格列为 `模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额`**，其中「缓存命中」列 = 缓存命中率百分比（两位小数，`cached/in`，如 `96.89%`），每条数据行与合计行都带该列。**必须**直接把脚本输出的 Markdown 表格原文贴给用户（聊天界面渲染为真表格列，天然对齐），**禁止**手排空格对齐、**禁止**转成纯文本/代码块、**禁止**改用 summary 一行式。原因：空格对齐依赖字体宽度，不同环境渲染必歪（用户反复纠正过的坑）。

## 查询触发规则（强制）

- 当用户以任何形式询问「今日消耗」「今天用了多少」「账本」「报告」「统计」「花费」等查询类请求时，**必须首先执行**：`node token-tracker.js --report`（或 `node token-tracker.js --report <日期>` 查询历史）。
- 然后**原样贴出脚本输出的 Markdown 表格**，不得自行读取 daily-usage.json、不得自行汇总、不得转换成列表/纯文本/代码块。
- 如果用户只问某一天的消耗，也使用 `--report <日期>` 并原样贴出。
- 如果用户问的是 summary（只要总合计，不要模型明细），才允许使用 `--report summary`，但同样必须贴出脚本输出，不得自行加工。
- 任何情况下，禁止绕过脚本直接解析账本 JSON 后手工格式化输出。

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

## 为什么需要
WorkBuddy 客户端 UI 不显示每轮对话的 token 用量：内置模型只显示「积分」，自有 API 模式也不展示 token。但平台在每次模型调用**整轮结束后**都会把真实用量写进一个新的 `traces/<pid>/trace_*.json`（含 `totalTokens` / `totalInputTokens` / `totalOutputTokens` / `totalCachedTokens` / `duration` / `startedAt` / `endedAt`）。本技能把这些数据读出来，让你每轮都能看到真实消耗。

## 触发条件
- 用户明确要求看 token / 消耗 / 用时
- 或作为默认习惯：**每次生成最终回复时**，都在末尾附上最近一轮用量

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
`settings.json` 的 `hooks.UserPromptSubmit` 已挂接本技能的 `--hook` 模式，会在你提交下一轮时自动把「上一轮」的 token 注入上下文，无需手动跑脚本。

### 方式 C：Stop 事件 + Windows 系统通知（目标：本条回答显示本条消耗与费用）
WorkBuddy 是 Claude Code fork，支持 `Stop` 事件（回答**结束后**触发）。`settings.json` 的 `hooks.Stop` 已挂接本技能 `--stop` 模式：回答结束时本轮 trace 已落盘（实测 Stop 比落盘早 ~15ms，脚本会轮询等待最多 3 秒），读到最新文件即为**本条回答**的精确统计，然后：

> **v2.19（2026-08-06 修复）**：旧逻辑只在 `sameRound || !snap` 时等待；若入口文件恰是"另一个旧文件"（如会话起标题的 terminalTitleGenerator 小 trace）且 ≠ 快照文件，会被误判为"本条"直接弹 toast（曾把 744 tokens 当成本轮展示，真实 122.3 万）。现改为：入口文件非"刚落盘"（≤1s）时一律轮询等待"比入口更新的有效 trace"（≤3s）；超时且入口明显是旧文件（落盘 >3s 前）→ 标"上一轮"不冒充本条。备份：`token-tracker.js.bak-20260806`。

> **v2.20（2026-08-06，完整消耗聚合）**：一个用户轮次会落盘多个 trace（起标题内部调用 + 主任务，实测 744 + 122.3 万），v2.19 仍只取最新一个——用户明确要求完整数据。现增加整轮聚合：`--hook`（用户提交时）把本轮起点时间戳 `lastUserMsgAt` 写入快照；`--stop` 聚合「起点之后、同 pid 目录、（无 sessionId 的内部调用 或 sessionId 与 Stop payload 一致）」的全部有效 trace，累加 in/out/cached/total，耗时 = 窗口内最早 startedAt → 最新 endedAt；无起点记录（手动运行）退化为单 trace（v2.19 行为）。快照保存时保留 lastUserMsgAt。备份：`token-tracker.js.v2.19-20260806`。

> **v2.21（2026-08-06，多会话并发快照隔离）**：v2.20 的 `.snapshot.json` 是**全局单文件、不带 sessionId**，hook matcher 为 `.*` 全局触发——同时开多个会话时，后提交的会话会把 `lastUserMsgAt` 覆盖成自己的时间 → 先结束的会话 Stop 聚合起点错乱（用户问"多任务并发时 token 计算是不是没用了"）。现改为快照按 `session_id` 拆分：hook/stop 都从 payload 读 `session_id`（WorkBuddy 所有 hook payload 均带此字段，实测/官方文档确认），有 sid → `.snapshot-<sid>.json`（各会话隔离）；无 sid（手动运行）→ 全局 `.snapshot.json`（行为不变）。sid 来自外部 payload，只留 `[a-zA-Z0-9_-]` 防路径注入。备份：`token-tracker.js.v2.20-20260806`。验证：隔离测试 7/7 通过（A/B 双会话互不覆盖、起点先后正确、手动全局快照兼容、单会话聚合回归）。已知限制（P1 沿用）：无 sessionId 的内部调用（起标题等）在**同一 pid 目录同时活跃多会话**时无法归属会话，理论上会串入窗口内的其他会话——仅限"同进程多会话真并发"，日常单会话/顺序多会话不受影响。

> **v2.22（2026-08-06，内部调用按最近主任务归属）**：v2.21 遗留 P1——无 sessionId 的内部调用（起标题等）只看"起点之后"，B 会话在 A 任务中途提交时，A 的内部调用时间戳落在 B 起点之后会被 B 误收。用户洞察："各会话任务结束时间不可能在同一秒"。现改为**最近主任务归属**：对无 sessionId 的内部调用，找到时间距离最近的主任务 trace（有 sessionId 的，窗口内距离=0，否则取端点最近者），归属该会话；只有归属本会话的才累加。这样利用任务时间线天然分隔并发会话，比"±N 秒容差窗口"精确。备份：`token-tracker.js.v2.21-20260806`。验证：隔离测试 10/10 通过（含核心 S4：真并发交错时 A 的内部调用归 A、B 不误收；S5 反向验证）。剩余极限：两个会话的内部调用与各自主任务时间线完全重合（同秒级真并发）时仍无法区分——数据源无 sessionId 标记，属平台限制。

> **v2.23（2026-08-12，专家团/多子回合防重）**：用户在应用内选择**专家团**（Team 型，7 个专家）时，每个专家完成思考都会触发一次 Stop hook，旧逻辑每次读到新 trace 都弹 toast → 弹 7 次。修复：Stop 端统计本轮（roundStart 之后、同会话归属）有真实 token 的 trace 数量，**>1 即判定多子回合**（专家团/并行子代理）→ 不再每次弹。

> **v2.24（2026-08-12，修正 v2.23 弹窗时机——Stop 端 debounce 延迟几秒弹，符合"任务完成后及时弹出"）**：v2.23 把弹窗延后到"用户下次提交消息（--hook）"，被用户当场否决——技能要求是**当前任务完成后及时弹出（可延迟几秒）**，延后一整轮不叫延迟几秒。修正为 Stop 端 debounce：判定多子回合时写 `.coalesce-<sid>.json`（含 `at` 时间戳）并 **spawn 一个 detached 后台 watcher**（`--flush-delayed` 模式，unref 独立存活）；watcher 延迟 **6 秒**后复查——延迟窗口内又有新 trace 落盘（下一子回合在跑）→ 退出不弹，下一次 Stop 会重写合并文件并再起 watcher（计时重置）；窗口内无新 trace → 整轮汇总**只弹一次**并清除合并文件。效果：最后一个专家完成后约 6 秒弹出一次整轮汇总，不再弹 7 次、也不用等用户下次发言。单 trace 普通轮次行为不变（Stop 立即弹本条）。`--hook` 端保留兜底：watcher 意外未弹（如应用关闭/进程被终止）时，下次提交读到残留合并 → 补弹一次并清除。`DELAY_TOAST_MS=6s` 可按需调。备份：`token-tracker.js.bak-20260812-v2.23`。验证：隔离测试 4/4 通过（A 多子回合→watcher 延迟 ~6s 弹一次汇总并清除 ✅；B 延迟窗口内有新 trace→watcher 退出不弹、合并保留 ✅；C 单 trace→立即弹、无合并 ✅；D hook 兜底→残留合并补弹并清除 ✅）。已知限制：同轮内两个子回合 Stop 间隔若超 6s（极端串行专家），可能提前弹一次汇总（延迟窗口按 6s 固定，非智能）；普通轮次若 roundStart 后确有 2 个带 token 的独立 trace 也会走合并（内容正确，弹窗延后 ~6s）。

> **v2.25（2026-08-12，数据源真相：专家团 token 从不落盘 traces → 改用 transcript 权威数据源）**：用户实测 KET 备考专家团（5 专家 + 主理人，11 分钟）后追问"弹的 token 准不准"。深挖真实数据发现**根本性错误**：专家团真实消耗 **675.8万 tokens**（主会话 transcript 35 次调用 324.6万 + 5 个子代理 `subagents/*.jsonl` 65 次调用 351.2万），而 token-tracker 只弹了 **4.6万**（traces 里仅落了第一条调用的空壳 trace）——**差 147 倍**。根因：WorkBuddy 5.3.11 专家团（`Agent` 工具 spawn 子代理）的模型调用**不落盘 `~/.workbuddy/traces/`**，真实数据在 transcript（jsonl）的 `providerData.usage`（camelCase：`inputTokens/outputTokens/totalTokens` + `inputTokensDetails[].cached_tokens`）。已验证：① 普通会话 transcript 按时间窗统计 = trace `totalInputTokens` 完全一致（同源）；② 专家团 Stop 晚于 transcript 写完 3.2s（时序足够）；③ 主/子代理 usage 行 key（messageId/conversationRequestId）全部唯一、无重复统计。**v2.25 改动**：Stop 端优先读 Stop payload 的 `transcript_path`（兼容 .json/.jsonl）→ 聚合本轮（hook 记录 lastUserMsgAt 之后）主 transcript + `subagents/*.jsonl`（按 mtime>本轮起点归属）的全部 usage；无 payload/无 transcript 数据 → 退回 traces 兜底。普通会话（无 subagents）立即弹整轮聚合（无论几次调用，v2.20 语义）；仅专家团（本轮有子代理 subagents）→ 写合并文件（含 tsPath+roundStart）+ watcher 延迟 6s 弹一次汇总（watcher 复查 transcript/subagents 是否有新调用）。hook 端在无 trace 时也记录本轮起点（全新会话首轮可统计）。备份：`token-tracker.js.bak-20260812-v2.24`。验证：隔离测试用 **KET 真实数据**——聚合结果 in=659.5万/out=16.3万/total=675.8万/耗时10m59s，与手算完全一致 ✅；多调用写 coalesce + watcher 延迟弹一次并清除 ✅；hook 无 trace 记录起点 ✅。已知限制：耗时由 transcript 最早→最晚调用时间差估算（traces 的 duration 更精确，但专家团场景 trace 缺失）；专家团中间若触发多次 Stop，靠 debounce watcher 合并（同 v2.24）；同一会话同一轮内多次专家团（罕见）的 subagents 归属按 mtime 粗略划分。

> **v2.26（2026-08-12，消除弹窗前闪黑窗——execFileSync 全量加 windowsHide）**：用户在复盘 A 股大盘的专家团运行后反馈"弹 toast 前闪了两个像 CAD 的黑窗口"。定位：v2.25 专家团走 watcher 延迟弹路径时，弹窗前会跑两个子进程——① `queryBalance()`（余额缓存过期）里 `execFileSync(node -e)`（line 749）② `showToast()` 里 `execFileSync(powershell.exe)`（line 627），二者都没设 `windowsHide`，Windows 下各弹一个控制台黑窗；另两处同类隐患：`autoRefreshPricing`（line 535，定价过期时刷新）和 `lookupOrPrice`（line 833，未知模型补录）。修复：4 处 `execFileSync` 全部补 `windowsHide: true`（纯隐藏子进程窗口，不改逻辑）。watcher 本身 v2.24 已设 windowsHide。备份：`token-tracker.js.bak-20260812-v2.25`。验证：语法 OK，4 处 options 逐一确认含 `windowsHide: true`。数据/弹窗逻辑零改动，无需重测专家团。

> **v2.27（2026-08-12，起点刷新守卫——专家团中途插话不再漏统计）**：用 v2.26 对三个真实专家团任务回归时发现 bug——**法律体检**（7 子代理）聚合只出 **159.8万**，手算真实 **409.3万**（漏 2.5 倍）。根因：专家团运行中途用户真实提交（`<system-reminder` 前缀的消息触发 hook）会把 `lastUserMsgAt`（本轮起点）一路刷到很晚，最终 Stop 聚合只统计"插话之后"的调用，漏掉前面 17 次主调用 + 6 个子代理文件（subagents 按 mtime > 起点归属，插话后旧文件被排除）。KET/A股 没触发是因为提交后无中途插话。**修复（三处配合）**：① hook 端起点刷新守卫——新增 `lastStopAt` 字段（Stop/watcher 完成时推进），hook 仅在 `lastStopAt >= lastUserMsgAt`（上一轮已结束）时才刷新起点；专家团进行中（无完成的 Stop）插话 → 保留旧起点不重置本轮；② Stop 端（transcript + traces 分支）普通轮（subCount=0）立即弹并推进 lastStopAt，专家团（subCount>0）写合并文件 + watcher、**不推进**（轮次边界由 watcher 弹窗收口）；③ `--flush-delayed` watcher 弹窗完成后推进 lastStopAt。另修正 hook 无 trace 分支同样套用守卫（此前无条件刷新绕过了守卫）。备份：`token-tracker.js.bak-20260812-v2.26`。验证（隔离测试 7/7）：场景1 三任务专家团全量聚合 ket 675.8万/ashare 258.2万/**legal 409.3万** ✅；场景2/2b 专家团进行中 hook 插话保留起点 ✅；场景3 专家团结束后 hook 正常刷新新起点 ✅；场景4 普通轮立即弹+推进 ✅；场景5 legal 完整复现（插话3次起点保留→最终 409.3万）✅；场景7 transcript 普通轮立即弹+推进 ✅。**关键洞察**：transcript 里 `role=user` 消息分两种——真实用户提交（`<system-reminder` 前缀，触发 hook）与子代理回传（`<teammate-message` 前缀，不触发 hook），此前误判"插话 11 次"实为子代理回传。已知限制：`lastStopAt` 仅记录到 snapshot，跨会话并发各自隔离（按 sid）；旧版 snapshot 无 lastStopAt 字段时 hook 会当"已结束"刷新起点（升级首轮行为与 v2.26 一致，可接受）。

> **v2.28（2026-08-12，异步 spawn 识别——子代理未落盘也能判定专家团）**：用户跑 design-engine-web 专家团（48 秒）后反馈"弹了 3 次弹窗"。真实数据：主 transcript 19:27:09 ToolSearch → 19:27:11 TeamCreate → **19:27:16 Agent** → 19:27:18 SendMessage，而子代理文件 **19:27:36 才落盘**——专家团异步 spawn，子代理文件比 Agent 调用晚 20s。中途 Stop 聚合时 subCount=0（文件还没写）→ 被误判成"普通轮" → **立即弹 toast + 推进 lastStopAt**（连带破坏 v2.27 起点守卫）。弹 3 次 = 中途 2 次误判 + 最终 1 次汇总。**修复**：新增 `hasTeamActivity(tsPath, roundStartMs)`——检查主 transcript 本轮是否有 `Agent`/`TeamCreate`/`TeamDelete`/`DeferExecuteTool(Team...)`/`SendMessage(teammate/recipient)` 等团队工具调用，命中即 `agg.teamActive=true`；Stop 判定专家团条件从 `subCount > 0` 改为 **`subCount > 0 || teamActive`**。效果：子代理文件未落盘时也能识别专家团 → 中途 Stop 一律走合并延迟弹，不误弹、不推进 lastStopAt；最终只弹一次汇总。备份：`token-tracker.js.bak-20260812-v2.27`。验证（隔离测试 4 任务回归 + 新场景）：KET 675.8万/ashare 258.2万（追加调用前）/legal 409.3万 聚合不变 ✅；design 完整聚合 45.2万/36.1s ✅；场景8 子代理改名模拟未落盘 → teamActive=True subCount=0 仍判专家团 ✅；场景9 中途 Stop 不推进 lastStopAt ✅；场景10 最终 Stop 写合并+watcher 延迟弹一次并清除 ✅；场景11 普通轮（teamActive=False）立即弹+推进无回归 ✅。已知限制：`hasTeamActivity` 靠工具名/参数正则识别团队调用，若平台改工具名需同步更新；耗时在"专家团结束后同会话又发普通消息"场景下，roundStart 由 hook 刷新（v2.27 守卫），普通轮只统计新调用（已验证）。

> **v2.29（2026-08-12，消除 snapshot 跨会话污染——hook 用 transcript 路径而非全局最新 trace）**：用户跑 design-engine-web 二次专家团（19:37-19:38）反馈"只弹了一次"，数据验证 toast 正确（50.5万），但发现 snapshot-56451bef 里 stat 残留 **715.5万**、file 指向**别的会话**的 trace（`trace_9d4ce7` 属于 Claw 主会话 6b03b000，in=713.8万）。根因：hook 端 `saveSnapshot({ file: f, ... })` 的 `f = latestTraceFile(true)`（**全局最新 trace**），多会话并发时会把别的会话的 trace 路径/stat 写进本会话 snapshot → `sameRound` 判定、上一轮展示串会话。**修复**：hook 分支新增 `const tsPathH = transcriptPathFromPayload(payloadRaw); const hookFile = tsPathH || f;`——payload 有 `transcript_path` 时 snapshot.file 用本会话 transcript 路径（按 sid 天然隔离），无 payload（手动运行）退回全局最新 trace。两处 saveSnapshot（兜底补弹 + 常规）都用 hookFile。备份：`token-tracker.js.bak-20260812-v2.28`。验证（隔离测试 5 任务回归 + 新场景）：5 真实专家团聚合 ket 675.8万/legal 409.3万/design 45.2万/design2 50.5万 全部正确 ✅；场景12 多会话并发（制造别的 trace 作为全局最新）→ hook 后 snapshot.file 指向本会话 transcript，未被污染 ✅；场景13 hook 起点守卫回归（专家团进行中保留起点）✅；场景14 普通轮立即弹+推进无回归 ✅。已知限制：Stop 端 traces 兜底分支仍用 `tf = latestTraceFile`（该分支本就依赖全局最新 trace 语义，专家团走 transcript 分支不受影响）；hook 的 stat 字段在 payload 无 transcript 时仍可能来自全局 trace（仅影响 additionalContext 展示，不影响 toast）。

> **v2.30（2026-08-12，联网功能独立开关——默认零密钥联网）**：用户要求给所有联网功能加显式开关并单独控制，README 须声明"哪些功能联网、开关在哪、安全性如何"。现于 `token-tracker.js` 顶部新增 4 个开关常量：`ENABLE_NETWORK`（总开关，false=全部联网关闭）+ 3 个分开关 `ENABLE_BALANCE_QUERY`（余额查询，**默认 false**——唯一携带 API key 的请求，最敏感）、`ENABLE_PRICE_REFRESH`（每日价格自动刷新，**默认 true**——OpenRouter 公开价表无需 key）、`ENABLE_MODEL_LOOKUP`（新模型价格自动补录，**默认 true**——OpenRouter 公开价表无需 key）。三个分开关各自独立；总开关关 → 全部跳过。改动极小：三处函数入口各加一行判断（`balanceText`/`autoRefreshPricing`/`ensureNewModelPricing`），关闭时静默跳过、不影响 toast 主流程。**默认配置 = 零密钥联网**：唯一带 key 的请求（余额）默认关闭；仅两个 OpenRouter 公开请求默认开启且失败自动降级。备份：`token-tracker.js.bak-20260812-v2.29`。验证（隔离测试 6 场景全过）：①默认配置普通轮 toast 正常弹、无余额字样 ✅；②总开关关 → toast 照常、价格刷新不触发 ✅；③余额开关开但无 key → 不联网不崩 ✅；④有 key + 开关关 → 探针证实不进入查询路径；开关开 → 进入查询路径（实测假 key 请求官方接口返回 401，证明只发往 `api.deepseek.com` 官方域名，失败降级不崩）✅；⑤价格刷新开关开/关正确控制联网 ✅；⑥总开关关 → 价格/补录全不触发 ✅。安全性：余额查询仅向 `https://api.deepseek.com/user/balance` 发送请求，key 只经 Authorization: Bearer 头传给该官方域名，请求不含任何本地数据。

> **v2.31~v2.32（2026-08-14，新模型补录国内外区分 + 今日累计）**：v2.31——`ensureNewModelPricing` 遇到未收录模型改为**先查国内源 llmabacus**（`priceCurrency=CNY` 直接人民币价补录 `region=CN`；`USD` 走 USD×汇率 `region=US`），再回退 OpenRouter（`region=US`），国内外定价自动区分；已有模型每天只刷新一次（`autoRefreshPricing` 按 `pricing.json.date` 判断当天是否已刷）。v2.32——新增 `daily-usage.json` 按自然日累计当天所有模型总消费（`todayDisplay`/`addTodayUsage`，保留最近 7 天、跨天自动开新桶），toast 行1 显示 `今日¥X.XX`（不区分模型）。备份：`token-tracker.js.bak-20260814-multisrc`。

> **v2.33（2026-08-14，行1 标题大字宽度模型修正）**：用户实测弹 5 条通知发现含中文时 `dispWidth`（中文按 2）低估宽度——标题大字（ToastText02 text id=1）下中文字符实宽约 2.5 半角单位，46u 即溢出（旧模型算 46u、实际渲染 48u）。新增 `dispWidthTitle`（中文按 2.5）+ 行1 阈值 47→45 留 2u 余量；行2 正文小字保持 `dispWidth`（2:1 正确）。验证：648 种真实组合 0 溢出、今日价 100% 保住。

> **v2.34~v2.35（2026-08-14，toast 两行大字布局定稿）**：用户实测 A1 方案（ToastText02 标题 text 内插 `&#10;` 换行符）成功——标题可分两行渲染且第二行从行首对齐。布局：**行1 标题大字分两行**——第一行 = 模型名 + 时段标注（`高峰双倍`/`夜间X折`）；第二行 = `耗时` + `今日¥X` + `余额¥Y`（换行点固定在"时间"前）；行2 正文小字 = 输入/输出+缓存+费用。`periodNote` 升级：`peak_multiplier>1` 且高峰 → `高峰双倍`；`night_discount` 且夜间 → `夜间X折`。行1 第二行宽度阈值 `TOAST_ROW2_MAX_W=42`，超限降级「丢余额 → 丢今日价 → 保底耗时」。`fmtDur` 超 1 小时改 `1h 59m 59s` 制。备份：`token-tracker.js.bak-20260814-v2.33-3line`。

> **v2.36（2026-08-14，快照自动清理）**：`.snapshot-<sid>.json` 按会话隔离但长期积累无清理。`saveSnapshot` 每次写入后调用 `cleanupSnapshots(sid)`：保留最近 30 天 + 最多 50 个 + 当前 sid 永不清。测试：55 新快照留 50、3 个 40 天旧文件全删、真实 32 个完整恢复。

> **v2.37（2026-08-14，移除无效 systemMessage 注入）**：用户确认 WorkBuddy UI 不渲染 Stop hook 的 `systemMessage`（无法"弹到对话回复里"），属死代码。删除两处无效注入（transcript 分支 + traces 分支），改为 `out({ hookSpecificOutput: {} })` 空返回保持进程行为；toast 为唯一结算展示通道。`--hook` 的 `additionalContext` 保留（真正注入上下文，即每轮消息头部的 hook 统计）。

> **v2.39（2026-08-15，每日分模型账本 + 长期历史 + --report）**：用户需求——每天按模型记录（输入/输出/缓存命中/总 token/金额），多模型多行；每天还有一个不分模型的总合计；历史长期保存可查。改动：① `daily-usage.json` 结构升级为 `{日期:{models:{模型:{in,out,cached,total,cost}}, total:{in,out,cached,total,cost}}}`，**长期保存不裁剪**（原保留 7 天）；② `todayStr()` 改**本地日期**（原 UTC，UTC+8 用户凌晨 0–8 点跨天错位），`refresh-prices.js` 同步；③ Stop 记账：transcript 数据源按模型分桶（`perModelFromRows`/`aggregatePerModel`，与 `aggregateTranscript` 同口径），专家团 byModel 存进 coalesce 由 watcher 记账，trace 兜底按 stat.model 单桶，每轮只在最终落点记一次（复用现有防重）；④ 新增 `--report [all|<日期>]` 查看今日/历史每日明细+合计；⑤ `require.main===module` 守卫 + `module.exports`（测试/回填脚本复用同一套逻辑）；⑥ 旧格式 `{"date":金额}` 自动迁移。备份：`token-tracker.js.bak-20260815-v2.38`。验证：临时环境 Stop 分模型记账（两模型明细+合计精确）/二次 Stop 累加不覆盖/旧格式迁移/跨天新开桶旧天保留/flush-delayed byModel 记账/--report 全格式 全部通过；真实账本今日回填 673.5万 tokens 与 transcript 一致，旧 08-14 金额 14.14 迁移保留。

> **v2.39.1（2026-08-15，--report summary 仅合计模式）**：用户要求"读前一天时只读最下面那行总数，别每次读一大堆"。新增 `--report summary [all|<日期>]`——只输出每天的总合计（一行/天，不含模型明细），助手/用户看总数只读这一行，省 token、省缓存占用；`--report`（明细版）行为不变。历史天结构确认：每天仅保留 `models`（各模型数量）+ `total`（合计），**不存每轮/每次会话明细**，文件本身就紧凑。

> **v2.40~v2.49（2026-08-15，专家团"结束信号"逐个击穿与修复）**：v2.25 换 transcript 数据源后数字对了，但"专家团何时真正结束、该结算"成了新噩梦——每个版本修一个边界、下一个又被真实场景击穿。v2.40 watcher 结束信号只查主 transcript 最后一行 + 固定 6s 窗口 + mtime 均不可靠；v2.41 兜底超时改"空闲超时"（原固定 deadline 会误弹跑超 30 分钟仍活跃的任务）；v2.42 子代理活跃检测（mtime 判据后被击穿）；v2.43 语义化子代理判定（按 spawn vs completed/failed 通知，mtime 判据在子代理未发结束信号时会漏）；v2.44 子代理结束信号两种 + "死寂"检测（文件全停更超 60s）；v2.45 用户手动停止即时信号（`Interrupted by user`）；v2.46 中断标记有时只写在子代理文件、主 transcript 不写；v2.47 中文团队 spawn 失败（pending false-empty）+ 轮次后缀正则（`-3`/`-c1`）+ 子代理收尾确认；v2.48 确认期 10s→6s；v2.49 真正中断标记是 assistant role（排除 role=user 的摘要）、上下文压缩误触发修复。

> **v2.50（2026-08-15，架构重写：增量记账，摆脱"判断任务结束"）**：v2.40~v2.49 证明"判断任务结束"这个前提本身不可靠——每个结束信号都能被真实场景击穿。v2.50 彻底放弃该思路，借鉴 WorkBuddy 自己的逐笔实时记账，改用**增量记账**：水位线 `.ledger-watermark.json`（`{sid:{main:已记账主 transcript 行数, subs:{子代理文件名:已记账行数}}}`）逐行累加 transcript 的 usage，每个子代理文件独立记录行数，**落盘一行记一行、绝不重复**；任务有没有结束不再影响记账正确性。

> **v2.51~v2.53（2026-08-15，增量记账收尾边界）**：v2.51 修复"停太快无 usage"的 fall-through bug；v2.52 中断补偿（`estimateInterrupted`——被中断的不完整调用按最后一条完整调用的输入 + 推理文本长度估算）；v2.53 混合场景合并（同一轮既有完整调用 usage 又有被中断思考无 usage）+ 子代理文件被中断思考估算。

> **诚实复盘（用户要求写清"为什么几次修复说烂了结果还是没修复"）**：两层根因——① v2.23/v2.24 在**错误数据源**（traces）上打补丁，专家团 token 根本不落盘 traces（真实在 transcript），弹窗次数调对了、数字差 147 倍；② v2.25 换对数据源后，"判断任务结束"成为不可靠前提，每个结束信号都被击穿，直到 v2.50 架构重写成增量记账才彻底摆脱。详见 README changelog「v2.40~v2.53」。

- **Windows 系统通知（toast，标题两行大字 + 正文一行）**：调用 PowerShell WinRT Toast API 弹出（ToastText02，标题 text 内插 `&#10;` 换行符实现标题两行大字）
  ```
  DeepSeek-V4 Flash 高峰双倍
  耗时 4m 26s 今日¥8.21 余额¥2.77
  输入 391.2万 / 输出 1.9万｜缓存99.74%｜¥0.25
  ```
  ——**布局原则（v2.34/2.35 两行大字定稿；演进史见后）**：行1（标题大字）分两行——第一行 = 模型完整名 + 时段标注（`高峰双倍`/`夜间X折`，仅有时段策略的模型显示，空格分隔）；第二行 = `耗时` + `今日¥X` + `余额¥Y`（今日价 = 当天 24 小时总消费，余额仅开启余额查询且检测到变化时显示）。行2（正文小字）= 输入/输出 + 缓存占比（两位小数）+ 费用（未收录显示「未收录」）。**换行点固定在「时间」前**——行1 第二行永远从行首对齐，与第一行长度无关。**宽度双模型（v2.33）**：行1 标题大字用 `dispWidthTitle`（中文按 2.5 半角单位，v2.17 纯半角实测上限 47u、含中文更紧）+ 阈值 45u（= `TOAST_ROW1_MAX_W`，**以代码为准**）；行1 第二行阈值 42u（= `TOAST_ROW2_MAX_W`，**以代码为准**）；行2 正文小字用 `dispWidth`（中文按 2）+ 阈值 52u（= `TOAST_LINE_MAX_W`，**以代码为准**）。**降级链（v2.35 定稿）**：行1 第二行超 42u → 丢余额 → 再超丢今日价 → 保底 `耗时`（绝对安全）；行1 第一行超宽（长模型名）→ 丢时段标注保模型名。**时段标注 `periodNote()`**：`peak_multiplier>1`（DeepSeek 原厂系=2）且当前在高峰时段（北京时间 9-12/14-18）→ `高峰双倍`；`night_discount`（如 0.5）且当前在 `night_hours` → `夜间X折`；无时段策略不显示。**布局演进（历史）**：v2.6 行1 带时段标注 → v2.8 余额移至行1 → v2.11 余额紧跟时间 → v2.14 时段只显示「高峰」两字 → v2.17 实测上限 47u + 分隔符两侧加空格 → v2.18 恢复「¥」符号 → v2.32 加今日累计 → v2.33 行1 中文按 2.5 宽度模型 → v2.34/2.35 换行点移到时间前、两行大字布局定稿。**实现说明**：旧式 ToastText 系列无展开按钮，ToastText04 的第 3 个 text 元素在部分环境不渲染（v2.34 实测被吞），故用「ToastText02 标题 text 内插 `&#10;` 换行符」实现两行大字（用户实测 A1 方案成功）。这是当前唯一确认有效的"本条可见"通道（UI 内 `systemMessage` 通道实测不显示，v2.37 已移除该死代码）
- **时段折扣数据（2026-08-05 搜索核验 + 手动维护）**：目前仅 **DeepSeek 原厂系**有峰谷定价（V4 起推出，工作日北京时间 9-12/14-18 高峰，所有计费项 ×2，含缓存价；原因=算力挤兑削峰填谷；2025 年的「夜间错峰优惠」已被高峰溢价模式取代）。智谱 GLM / MiniMax / Kimi / 混元均为统一定价无峰谷；小米 MiMo 是 2026-05 永久降价 99%（非时段折扣）。⚠️ **时段策略无公开 API 数据源，需手动维护**：厂商时段政策（高峰/低谷/夜间折扣/取消）变动时，在 `pricing.json` 更新 `peak_multiplier`/`night_discount`/`peak_hours`/`night_hours` 字段，代码自动读取显示（可在对话中提示模型更新）；新模型自动补录默认 `peak_multiplier:1`。
- Stop 端输出 `hookSpecificOutput:{}`（v2.37：`systemMessage` 通道 WorkBuddy UI 实测不显示、弹不进对话回复，已移除该无效注入；toast 为唯一结算展示通道）。
- 探针 `.stop-probe.json` 记录每次触发：`sameRound=false`+`waited=ok` = 成功拿到本条；`waited=timeout` = 3 秒内 trace 未落盘，退化为「上一轮」且不弹通知。
- 若用户不需要系统通知，可删除 `settings.json` 中 `hooks.Stop` 配置（`--hook`/手动模式不受影响）。

## 费用估算（pricing.json + 高峰时段 + 每日自动刷新）
- 模型名读取：`trace.modelInfo.models[0]`（空壳 trace 从 spans 的 `toolOutput[].model` 取）。
- **模型匹配（v2.67 起严格化）**：`findModel()` 只认**归一化后完全相等**的键，一个字符不同即视为不同模型。归一化仅做三件事：统一小写、去首尾空格、连续空格合并为单空格。**不做**前后缀/包含/版本号/日期归并，`.` 与 `-` 也不再等价（如 `glm-5.2` ≠ `glm-5-2`）。带厂商前缀的名字（如 `moonshotai/kimi-k2.7-code`）必须原样收录在 `pricing.json` 才能命中，不会自动剥离前缀去匹配。匹配不上返回 `null` → 走新模型联网补价，补不到就只记 token 不记金额。
- 价格缓存：`~/.workbuddy/skills/token-usage-tracker/pricing.json`（官方人民币价：输入/缓存命中输入/输出，元每百万 tokens；`region` 国内外标记 CN/US；`peak_multiplier` 高峰倍率、`night_discount`/`night_hours` 夜间折扣字段（手动维护）；`or_id` 关联 OpenRouter 模型 id；`usd_input_price/usd_output_price` 为自动刷新写入的 USD 参考价）。
- **已收录模型**（2026-08-04 官方定价页 + OpenRouter 交叉核对）：deepseek-v4-flash(1/0.02/2,峰谷×2)/v4-pro(3/0.025/6,峰谷×2)/v3.2/v3.1/r1、glm-5.2(8/2/28)/5.1(8/2/28)/5-turbo(7/1.8/26)/5(6/1.5/22)/5v-turbo(8.6/1.7/28.8)/4.7/4.7-flash(免费)、kimi-k3(20/2/100)/k2.7-code(6.5/1.3/27)/k2.7-code-highspeed(13/2.6/54)/k2.6(6.5/1.1/27)/k2.5(4/0.7/21)、minimax-m3(≤512k 标准 4.2/0.84/16.8，>512k 翻倍，促销五折 2.1/0.42/8.4)/m2.7(2.1/0.42/8.4)、hy3(1/0.25/4)/hy3-preview/hunyuan-a13b。
- **新模型自动补录（v2.31，国内源优先；用户要求"检测到未收录模型立即联网查"）**：trace 读到**未收录模型**（pricing.json 无匹配且无 input_price）时，`token-tracker.js` 自动执行：
  1. **立即联网**先查国内源 llmabacus（`llmabacus.com/api/prices`，无需 key）按模型名匹配，`priceCurrency=CNY` 直接人民币价补录 `region=CN`、`USD` 走 USD×汇率 `region=US`；
  2. llmabacus 无 → 回退 OpenRouter（`openrouter.ai/api/v1/models`）按模型名匹配，USD×汇率（7.2）补入 `pricing.json`（`auto_converted: true`，缓存价按输入 10% 估算，标 note "待人工核验官方价"），同时 hook/手动输出附提示「已自动补录估算价」；
  3. 两源均确认无此模型 → 记入 `pricing._lookedup_models`（同一模型当天不再重复联网），输出提示「请用 unified-search 搜官方定价页补录」；
  4. 联网失败 → 不记已查（下次重试），输出提示「联网查价失败」。
  - 维护原则：**不追求收录所有模型**，只维护应用内置 + 用户常用模型；新模型由上述自动补录 + 人工核验（unified-search 搜厂商官方定价页）补齐。
- 高峰时段（仅 DeepSeek 原厂系）：北京时间 **9:00-12:00、14:00-18:00** 价格翻倍；其余模型无峰谷。
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
  - 陈旧模型清理（v2.65）：每次刷新时删除「未出现在 `daily-usage.json` 或超过 14 天未使用」的模型，`lock: true` 的三个（deepseek-v4-flash / -vision-exp / v4-pro）始终保留。被删模型再次使用时会由上面的新模型补录自动回补。
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

## 注意事项
- 不要伪造数字：脚本读的是平台真实落盘数据，直接输出即可；读不到/解析失败时如实显示"暂无数据/尚未完成写入"，绝不编造。
- 若输出显示「上一轮」，说明这一轮已统计过（数字与上次相同属正常）。
- 本技能不修改任何平台文件，仅读取 traces 与维护自身快照。

## 维护与排查

### 弹窗诊断日志
- 每次弹窗时，代码**自动**向 `~/.workbuddy/token-tracker-toast.log` 追加一行 JSON 诊断记录（无需任何开关，默认开启）。
- 记录内容包含：`ts`（时间）、`reason`（触发原因）、`sessionId`、`watchStartTime`（本次 watcher 启动时间）、`lineCount`、`stableCount`、`compactionSuspected`、`compactionMode`、`lastMarkerId`、`tailRawPrefix`、`lastTailRawPrefix`、`pendingSubCount`、`hasNewTail`、`traceFile`（当前处理的 trace 文件名，获取不到为 null）、`toastText`（弹窗真实文本前 200 字符）。
- `reason` 取值：`busy-timeout` / `interrupted` / `deadTeam` / `stableCount>=3` / `idle-timeout` / `estimate` / `no-token` / `hook-fallback`。
- 日志文件超过 5MB 会自动清空后重新追加，避免无限增长。
- 写入失败（权限/磁盘问题）被 try-catch 吞掉，绝不影响弹窗主流程。

### 常见排查步骤
1. 如果用户反馈"压缩上下文后仍然弹窗"或"漏弹"，直接打开 `~/.workbuddy/token-tracker-toast.log`。
2. 搜索最近的记录，查看 `reason` 是 `stableCount>=3` 还是 `interrupted` 或其他。
3. 查看该记录的 `compactionMode` / `lastMarkerId` / `tailRawPrefix`，判断触发时是否处于压缩上下文过渡态。
4. 根据日志判断是判定逻辑问题还是数据源问题，不要凭记忆修改代码。

### 故障排查速查表

| 现象 | 优先查看文件 | 关键判断依据 |
|---|---|---|
| 完全无弹窗 | `.stop-probe.json`（mtime 是否更新）、`token-tracker-toast.log`（是否存在） | 若 probe 未更新，说明 Stop hook 未触发或命令失败；若 toast.log 无记录，说明判定未收口 |
| 弹窗延迟过长 | `token-tracker-toast.log` | 查看 `reason` 是否为 `stableCount>=3`，并看 `ts` 与 run 结束时间差 |
| 压缩上下文后提前弹窗 | `token-tracker-toast.log` + transcript 尾部 | 查看 `compactionSuspected`/`compactionMode`/`lastMarkerId`，以及 `tailRawPrefix` 是否在弹窗前已连续多帧不变 |
| 弹窗内容异常（会话错乱） | `token-tracker-toast.log` + trace 文件 | 查看 `sessionId` 是否为空或与实际会话不一致；检查 trace 的 `sessionId` 字段 |
| 账本数据未更新 | `daily-usage.json`（mtime）、`.ledger-watermark.json` | 若 mtime 停在某时间，说明 Stop 路径未执行；结合 probe 判断 |
| 弹窗频繁重复 | `.ledger-watermark.json` + `token-tracker-toast.log` | 查看 watermark 去重是否生效，以及 toast.log 中同一 `reason` 是否反复出现 |
| 弹窗提示「⚠价库8/31」/ 价库不刷新 | `WorkBuddy\2026-08-30-22-25-15\prices\.refresh.lock`（失败会常驻）+ `.refresh.error`（v2.82 起失败留档）+ `binaries/python/envs/default`（venv 是否有 requests） | 刷新失败首查 `.refresh.error` 内容；「python 环境」问题查 resolvePython 是否命中 venv（v2.82 根修：候选表必须含 venv 路径） |
| 弹窗耗时与 WorkBuddy 显示差很多 | 本轮 trace 文件数量（`~/.workbuddy/traces/<pid>/` 同窗口几个 trace） | 长任务会分多个 trace 文件，v2.74 单文件口径只算最后一段（11:27 显示 4:22）；v2.82.1 起 = 最新 trace endedAt − 用户提交时刻（roundStart0），差 ≤1s |
| 新模型计费明显不对 / 显示 unknown | `pricing.json` 对应条目 + `daily-usage.json` 模型名 | v2.82.2 起 findModel 为单向边界匹配：`glm-5.3-air` 不会撞 `glm-5` 的价；模型名缺失（`unknown`）只记 token 不记钱——若出现 unknown 条目，说明 transcript 的 `providerData.model` 缺失 |
| 专家团金额疑似翻倍（双记） | `.ledger-watermark.json` 各会话水位线 + 账本模型 token | v2.82.2 起 incrementalRecord 整体加 `.ledger-watermark.json.lock` 水位线锁，watcher 与 Stop 并发只记一次；仍翻倍则查是否锁被异常跳过（stderr 有「水位线保持不推进」则下轮会补记） |

> ⚠️ **hooks 命令铁律**：所有 hook 命令必须保持**纯净的 `node` 调用**（如 `node C:/.../token-tracker.js --stop`），**禁止使用 `cmd /c` 包装或环境变量前缀**（如 `cmd /c "set X=1 && node ..."`）。此类包装会被 WorkBuddy 判为无效 hook 配置（`Invalid hook config`），导致整个事件组（Stop / UserPromptSubmit）跳过、进程瞬间失败且无任何日志产物。调试日志已改为弹窗时自动记录，无需通过环境变量或命令前缀开启。
