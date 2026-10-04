# WorkBuddy Token Tracker（token-usage-tracker）

![License](https://img.shields.io/github/license/abc1317679842-ui/workbuddy-token-tracker)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)
![Version](https://img.shields.io/badge/version-v3.32.1-blue)

> 在每次回答后显示 **Token 消耗 / 耗时 / 折算费用** 的 WorkBuddy 技能（Skill + Hook）

## ⚠️ 适用性声明（安装前必读）

| | |
|---|---|
| ✅ **唯一适配** | **WorkBuddy 桌面客户端**（Windows 10/11，Node.js ≥ 20）——数据源是 WorkBuddy 每轮调用后落盘的 trace 文件（及会话 transcript），并依赖其 hooks 机制自动触发 |
| ❌ **不适用** | 其他任何 AI 工具 / 平台（Claude Code、Cursor、ChatGPT 桌面版、其他 OpenClaw 客户端等）——它们没有 WorkBuddy 的 traces/transcript 落盘机制与 hooks 挂载点，装上也不会工作 |
| ⚠️ **功能差异** | 每轮系统通知（toast）仅 Windows 支持；macOS/Linux 即使装了本技能也不弹通知（可手动查看统计） |

**简单说：不在 WorkBuddy 桌面端使用，本技能没有意义。** 请确认你的环境再安装。

> ⛔ **本项目不经 npm 分发**（无 `package.json`）。npm 上的同名包 `token-usage-tracker` 与本项目**无关**（曾有恶意包记录），请勿 `npm i token-usage-tracker`——唯一安装方式是从本仓库下载拷入技能目录。

## ⚠️ 统计范围声明（**看数据前必读**）

**本技能统计的是「WorkBuddy 落盘了的消耗」，不是「你账上被扣的全部消耗」。** 两者会不一致，尤其是下面几种情况：

| 情况 | 本技能显示什么 | 实际扣费 |
|---|---|---|
| **模型长时间思考时你手动停止 / 被中断** | 平台**不落盘**这部分的 usage → 本技能只能用估算填补，弹窗会标注 **`（估算）`** | ⚠️ **服务商那边已真实计费**，WorkBuddy 的积分消耗记录里也有 |
| **内置积分模式**（走客户端自带额度） | 只有 token 与折算金额 | 真实扣的是积分 / 额度，本技能**读不到**扣减明细 |
| **在 WorkBuddy 之外用同一个 API key 发起的调用** | 完全不统计 | 会计费 |
| **应用 / 进程异常终止，trace 来不及落盘** | 那一段可能缺失 | 会计费 |

### 关于「估算」——它是估算，不是实测

模型长时间思考时你点了停止，这轮思考**已经用掉 token 且已被计费**，但平台不会把这段的 usage 写进本地文件。本技能在这条路径上做的是**估算**：

- **输入侧**：往前找最近一次有 usage 的调用，**拿它的输入量当本轮输入量的近似**（同一会话上下文连续，量级接近）；
- **输出侧**：按本地记到的思考文本长度粗算（**1 汉字 ≈ 1.5 token**，其他字符约 4 字符/token；与脚本 `cjk*1.5` 同口径）。

**这个数字与真实计费不是一回事**，且**偏差方向不确定**：输入侧的近似系数偏高、而思考文本本身可能没完整落盘（被截断，这部分偏低），两股偏差方向相反、净结果不保证偏向哪边。看到弹窗标注 `（估算）` 时，请当量级参考，不要当账单。

> **要对账，请以你的 API 服务商账单 / WorkBuddy 积分消耗记录为准。**
>
> 正常跑完的轮次里，`输入 / 输出 / 缓存命中 / 总 token` 四列全部来自平台自己落盘的 usage 记录，是**真实值**——这部分可以直接信。

## ⚠️ 金额口径声明（**看数据前必读**）

**除非你是「自备 API key」模式，本技能显示的「金额」都不是你的真实花费。**

| 你的模式 | 本技能显示的「金额」到底是什么 |
|---|---|
| **内置模型**（走 WorkBuddy 自带积分 / 额度）——绝大多数用户 | 把你实际用掉的 token，**按外部 API 单价折算**出来的「等价金额」。它只是一个便于横向比较的参考值：**你真正扣掉的是积分/额度，不是这些钱**。它与积分之间**不存在任何可验证的换算关系**，不要拿它当账单看、也不要据此推算"积分还能用多久" |
| **自备 API key**（BYOK / 自定义模型） | 与你自己那份 API 账单同口径，可以视为真实花费的近似（仍受峰谷倍率、缓存价、汇率取值的近似影响） |

**为什么不做「积分 ↔ 金额」换算**：WorkBuddy 客户端**不暴露**积分扣减明细，本插件能读到的只有平台落盘的 token 用量。把 token 乘上单价得到的数字，与积分余额之间没有可验证的映射；硬凑一个系数只会给出误导性结论，所以本插件**明确不做**这件事。

**准确的是什么**：`输入 / 输出 / 缓存命中 / 总 token` 四列全部来自平台自己落盘的 usage 记录，是**真实值**——分析用量请以这四列为准。所有金额列（toast、账本、区间报表、CSV）都带「按 API 单价折算」的口径标注，CSV 里字段名直接写成 `cost_api_equiv`，就是为了防止半年后自己都把它当成真实扣费。

> 实测佐证（作者本机，2026-10-01）：账本近 6 日折算金额日均 **¥39.03**，而同一时期自定义 API 余额观测值**恒定 5.36 两天未变**——按折算金额算"余额只够 0.14 天"，显然荒谬。这正说明金额列是虚拟计价、不是真实扣款。

### ⚠️ 无公开价模型：金额列显示「无公开价」（v3.27.0 起）

有些模型**厂商根本没有公布按 token 的单价**，最常见的是两类：

- **匿名模型**（厂商未公布身份，聚合平台上标 `$0`），例如 `space-bunny`（社区普遍推测是 MiniMax M3.1 Flash，但官方从未确认）；
- **订阅制模型**（只在包月套餐 / 官方客户端内可用，不按调用计费），例如 `MiniMax-M3.1-Flash-Preview`。

这类模型的 token 用量**照常精确统计**（输入/输出/缓存/命中率四列都是真实值），但**金额算不出来**。本技能的处理：

| 位置 | 表现 |
|---|---|
| 弹窗**行1**（模型名右侧） | 追加标注 **`｜⚠无公开价`** |
| 弹窗**行2** | 金额段**整段不显示**（连 `¥0` 都不显示），缓存百分比等其余信息完整保留 |
| `--report` 表格 | 该行金额列显示 **`无公开价`**，表尾追加一行 `⚠ 本日 N 个模型无公开价 → 合计金额偏低` |
| 区间报表 | 同上（口径与单日表一致） |
| 账本条目 | 除金额 0 之外带 `no_price: true` 标记，供后续排查 |

> 混合场景（一轮里既有有价模型又有无公开价模型）：行2 的金额显示**已知部分**（有价部分照常算），缺口由行1 的 `⚠无公开价` 标注承担。

**⚠️ 这意味着：只要当天用过这类模型，当日合计金额就是偏低的**（只含有价部分）。这是有意为之的诚实标注，不是 bug。

**厂商日后公布单价怎么办**（两条路，任选其一，之后跑一条命令即可回算历史）：

```bash
# ① 直接编辑 pricing.json 里那个模型条目的 input_price / output_price（单位：元 / 百万 token）
#    （把 pricing_status: "unpublished" 删掉）
# ② 或把它加进 SKILL 顶部的查价开关清单，让每日刷新自动补价

# 然后回算历史（自动备份 + 原子写 + 自动清除 no_price 标记）：
node recalc-day.js              # 今天
node recalc-day.js 2026-10-02   # 指定某天
node recalc-day.js              # 不带参数即当天；历史多天需逐日执行
```

> 注意：`backfill --write` 是**全量重建替换**，不是 merge——用它回填会抹掉压缩窗口外的历史账，**不要为回填目的跑它**（详见 `TROUBLESHOOTING.md` 与 KNOWN-ISSUES KI-5）。

### ⚠️ 弹窗标注速查：`⚠未计价` / `⚠账缺` / `⚠价核验`

弹窗正文行（行2）末尾偶尔会出现 `｜⚠未计价` / `｜⚠账缺` / `｜⚠价核验`。它们和你直接能在弹窗里看到的 `（估算）` 一样，是**有意暴露的数据缺口提示**，不是渲染错误；`｜⚠无公开价` 见上一节。含义各不相同：

| 标注 | 出现位置 | 含义（触发条件） | 你该怎么办 |
|---|---|---|---|
| `｜⚠未计价` | 行2 末尾 | **本轮有 token 消耗、但金额算不出来**：该模型在 `pricing.json` 里查不到匹配（未收录 / `findModel` 未命中），或混合轮里**部分模型无价** → 金额位显示 `未收录`（混合轮为有价部分的**部分和**） | 「这轮金额缺了一块」。补 `pricing.json` 该条目价 → `node recalc-day.js <日期>` 回算历史；**不要用 `backfill --write`**（会抹历史账）。无输入/输出的空轮不会标 |
| `｜⚠账缺` | 行2 末尾 | 平台**压缩 / 重写过 transcript**，文件完整行数少于水位线 → 压缩窗口之后**可能静默少计**。v3.25.0 起新消耗已自动恢复记账，但**被压缩掉的历史行本地不可恢复**（见 `KNOWN-ISSUES.md` KI-5） | 对账时这段历史缺口**以服务商账单为准**；旗标（`.transcript-truncated.json`）7 天自动过期，**不要用 `backfill --write`** |
| `价⚠️` / `官价⚠️` | 行2 末尾 | 价格多源刷新**全源失败** / DeepSeek **官方价抓取失败** → 本轮金额按上一次的价格估算 | 属刷新失败的可见化；看 `pricing.json` 的 `last_refresh_error` / `deepseek_refresh_error`，稍后重刷即可 |
| `｜⚠价核验` | 行2 末尾 | `pricing.json` 里存在**待人工核验**的告警条目（`_price_audit.warnings` 价格一致性自检 / `_ambig_warnings` 模糊匹配歧义）**且点名了本轮这个模型** → 该模型计价可能不准。**v3.30.0 起才会这样**：之前它读的是 `last_refresh_note`（刷新操作流水账），历史告警会永久留在文本里 → 每条弹窗都挂标签、永远消不掉 | 跑 `node refresh-prices.js` 重刷一次价库（干净则告警字段被删、标签自动消失）。详细条目在 `pricing.json` 的 `_price_audit` / `_ambig_warnings`，**每次刷新进程的 stderr 也会全量打印**（含与本轮无关的告警） |

> 这些标注都受弹窗宽度守卫保护，**顺序即优先级**：超宽时先丢「价格来源降级」类标注（`⚠价核验` → `价⚠️` → `官价⚠️`，详情都能在 stderr / 日志里追），仍放不下才丢**缓存命中百分比**；`⚠未计价` / `⚠账缺` 是「数据不可信」信号，**任何情况下都不丢**（v3.30.0 起。此前顺序相反，会出现"缓存百分比被 `⚠价核验` 顶掉"）。

## 为什么做这个

WorkBuddy 客户端 **不显示每轮对话的 token 用量**：

- 内置模型模式只显示「积分」，不显示 token；
- 自有 API（BYOK，自定义模型）模式也不展示 token。

但平台在每次模型调用**整轮结束后**，都会把真实用量落盘（`~/.workbuddy/traces/<pid>/trace_*.json` 及会话 transcript 的 `providerData.usage`）。本技能把这些**平台自己记录的账**读出来，让你每轮都能看到真实消耗——正常跑完的轮次是实测值，**不是估算、不是推算**（例外与边界见上方「统计范围声明」）。

## 核心功能

| 功能 | 说明 |
|---|---|
| 🪟 **每轮即时推送** | 回答结束后，Windows 系统通知（toast）立即弹出本条消耗，**两行大字紧凑布局**：行1 第一行 = 模型名 + 时段标注（高峰双倍/夜间X折）；行1 第二行 = 耗时 + 今日累计消费 + 余额；行2 = 输入 / 输出 + 缓存占比 + 费用 |
| 📊 **今日累计消费** | toast 行1 显示当天总消费 `今日¥X.XX`（读取每日账本 total.cost） |
| 📓 **每日分模型账本** | 每轮 Stop 自动把消耗**按模型**累计进 `daily-usage.json`（本地日期分桶）：`{日期:{models:{模型:{in,out,cached,total,cost,hit}}, total:{...}}}`——每个模型一行（输入/输出/缓存命中/总 token/金额）+ 不分模型的当日总合计；`hit` 为该模型当日**缓存命中率**（百分比，`v3.30.0+` 落盘；旧数据由展示层现算兜底）；**长期保存不裁剪**，历史天仅保留各模型 + 合计，文件紧凑。查看：`--report`（今天）/ `--report all`（全部天）/ `--report <日期>`（明细+合计）；`--report summary [all|<日期>]` 只看每天**总合计**一行 |
| 📅 **区间报表**（v3.20.0） | `--report week`（近 7 天）/ `--report month`（本月至今）/ `--report 2026-09-01..2026-09-30`（任意闭区间）→ 输出**一张按模型的汇总表**（列结构与单日完全一致）+ 合计行。区间命中率按 **Σ缓存/Σ输入 重算**，不是各天均值（跨天 token 量差 100 倍时均值毫无意义）；起止写反自动纠正；**既有四个入口的输出逐字节不变** |
| 📤 **CSV 导出**（v3.20.0） | `--report week --csv` / `--report all --csv` / `--report 2026-09-30 --csv` → 落盘到 `exports/report-<范围>-<时间戳>.csv`（**逐日 × 逐模型**明细 + `ALL` 合计行，可在 Excel 里自行透视）。带 **UTF-8 BOM**，中文列头不乱码；命令只回一行路径，不把几十行数据灌进对话 |
| 📈 **消耗外推**（v3.20.0） | `--report forecast` → 今日 token 速率外推 + 近 7 日实测均值对照。**只推 token，不推金额**（金额本身是折算值，再外推一次只会制造"这个月要花多少钱"的错觉）；样本不足 2 天时拒绝计算 |
| 🧾 **轮次明细留档**（v3.20.0） | 每轮向 `rounds/rounds-YYYY-MM.jsonl` 追加一条：分模型 token 明细、耗时、主/子代理模型、子代理数、来源标记，以及**自动从本轮首条用户消息提取的可读标签**——用来回答「哪一轮异常大 / 子代理占了多少」这类每日账本答不了的问题。写入点选在记账唯一入口（账本确认落盘之后），所以同轮重复 Stop **不会重复落档**；保留最近 6 个月，过期的由 `--report` 顺带清理 |
| 🔔 **版本更新提示**（v3.21.0 起，v3.22.0 补覆盖） | 每 **7 天**匿名查一次仓库版本（只读、零密钥、不带任何本地数据），发现新版本时**由模型在回答末尾提一句**（如「本技能有新版本，可更新」）——**不占 toast 空间**，也不反复打扰：同一版本最多提示 2 次、两次至少隔 24h。**检测点同时查两处并取较大版本**：`releases/latest` + 全部 tag（`git/matching-refs/tags/v`）——只查 release 时，万一某次「只打了 tag 没发 release」就会漏报。失败**静默退避**（1h→6h→1d，连败 3 次当周不再试）。**只配了 Stop、没配 `UserPromptSubmit` hook 的用户**走弹窗兜底：弹窗第一行尾部加一个 `｜⬆v3.22.0`（**放不下就整个不显示**，绝不挤压模型名与耗时/今日/余额）；已配 hook 的用户**永远不会**看到这个标记。升级方法见下方「如何升级」。⚠️ 该功能**帮不了已安装旧版的用户**——检查逻辑在被安装的那份代码里，只从 v3.21.0 起生效 |
| 🧠 **专家团全量聚合** | WorkBuddy 专家团（多个子代理并行 + 主理人汇总）的全部模型调用，一次性聚合成整轮真实消耗——**平台不把子代理调用落盘 traces，本技能直接从主会话 + `subagents/*.jsonl` transcript 读取**，跑完一个专家团弹**一条**整轮汇总，不会弹 N 次 |
| 🧩 **异步子代理识别** | 专家团子代理是异步 spawn，文件比 Agent 调用晚落盘——检测主会话是否有 `Agent`/`TeamCreate` 等团队活动，未落盘也能判定"这是专家团"→ 走合并延迟弹，不误判为普通轮 |
| 🛡️ **中途插话守卫** | 专家团运行中你插话不会把统计起点刷晚（`lastStopAt` 轮次边界守卫）——整轮消耗不丢 |
| 🔒 **快照防串会话** | 多会话并发时 snapshot 按 session_id 隔离、用本会话 transcript 路径标记，不把别的会话的数据串进来；**自动清理**（保留最近 30 天 / 最多 50 个，当前会话永不清） |
| 💰 **余额显示** | 仅自定义 API 的 DeepSeek 官方模型：调用官方 `GET /user/balance` 接口（Bearer 认证，无需网页登录）在 toast 显示 `余额¥2.77`；**默认关闭（见下方联网开关）**，开启后检测到余额变化才显示；15 秒缓存保实时又不重复请求 |
| 💰 **费用估算** | 内置主流模型**人民币官方价**（元/百万 tokens，来源见下「本地官方价格库」）；支持高峰/夜间时段倍率（见下「时段价格标注」）；不足 ¥0.01 显示 `¥<0.01` |
| ⏰ **时段价格标注** | 行1 显示时段策略：DeepSeek 原厂系高峰 → **`高峰双倍`**；声明了 `night_discount` 的模型夜间 → **`夜间X折`**。**DeepSeek 原厂时段「自动跟随官方」**——`pricing.json` 顶层的 `deepseek_rules.peak_schedule` 由 `deepseek-official.js` 每日从官方定价页抓取，官方改时段/取消周末低峰本地自动同步；解析失败**保留旧值**并亮 `⚠时段`（绝不静默清空），无规则时回落内置默认（9:00–12:00 / 14:00–18:00，周末全天低峰）。**其他厂商**的峰谷/夜间折扣没有可程序化读取的数据源，仍需人工在 `pricing.json` 该模型条目上维护 `peak_multiplier`（高峰倍率）与 `night_discount`（夜间系数）+ 可选的 `night_hours=[起,止]`（覆盖默认夜间窗口 00:00–08:00）。⚠️ **没有 `peak_hours` 这个字段**——高峰时段只来自 `deepseek_rules.peak_schedule` 或内置默认，别去改一个不存在的键 |
| 🆕 **新模型自动补录** | 检测到未收录模型**立即联网**补录：先查国内源 llmabacus（人民币价，`region=CN`），再回退 OpenRouter（USD×汇率，`region=US`）；查不到则提示用搜索技能人工核验官方定价页 |
| 🔄 **每日价格自动刷新** | 每天首次运行自动拉 **5 个价格源**（国内 2：llmabacus / llm-prices-cn；国外 3：OpenRouter / LiteLLM / Portkey），按模型 `region` 区分国内外定价（CN 用国内人民币价、US 用三 USD 源中位数×汇率）；**当天已刷新则不再联网**；全源失败 toast 显示「价⚠️」并保留上次价格 |
| 🔗 **官方价跨 key 接管**（v3.07） | 官方现行 API ID 与本地 key 不同名时（如本地 `deepseek-v4.1-flash` ↔ 官方 `deepseek-flash`），按官方页「模型版本」行自动对齐识别为同一模型：**官方价强制覆盖手动补录价**、解除 `manual`/`lock` 冻结、绑定 `alias_of` 并写 `_manual_audit` 留痕；聚合源刷新也不会再覆盖官方价 |
| 🏪 **本地官方价格库优先**（v2.81） | 计费新增**本地官方库层**（各厂商官网直抓的人民币官方价），优先级：`pricing.json 的 lock` > **本地官方库** > 聚合源补录。**每天第一次对话后台强制刷新**（实测约 12s，非阻塞，刷新没跑完自动用前一天完整库）；本地没有的模型才走聚合源实时查价并永久记录 |
| ⚠️ **刷新失败告警**（v2.81） | 本地库停留在昨天/缺失时，弹窗模型名后追加 **`⚠价库8/30`** / **`⚠价库缺失`**（正常时与原来一字不差）；失败**退避重试** 3→10→30→60 分钟、当日满 5 次熔断，次日自动恢复——不会再无限重拉，也不会让你蒙在鼓里 |
| ⏱️ **耗时口径对齐**（v2.82.1） | 耗时 = 最后一次 LLM 结束 − 用户提交时刻，与 WorkBuddy 显示**分毫不差**（长任务多 trace 分段落盘不再只算最后一段：实测 11:27 的任务旧版只显示 4:22） |
| 🛡️ **专家团防双记**（v2.82.2） | 增量记账整体加水位线锁，watcher 补记账与新一轮 Stop 并发时不再重复计费（集成测试两进程并发实测只记一次） |
| 🛑 **手动取消补弹**（v2.83/v2.84） | 用户手动取消任务时 WorkBuddy **不触发 Stop hook**（取消被挂起直到下一条消息），被取消轮的 token 会被并进下一轮弹窗、无法辨认。v2.83 起在 hook 端识别 transcript 的 `Interrupted by user` 取消标记并**立即补弹**（文案带 **（手动取消）**，日志 `reason=cancelled-round-flush`）；**v2.84** 修正续跑判定——取消后先有用户新消息 = 新轮次（补弹），取消后直接跟模型回复 = 续跑（不补弹）。5 项回放测试全通过 |
| 🧮 **计价精度**（v2.82.2） | 未收录模型改**边界分隔匹配**（不再 glm-5.3-air 撞 glm-5 的价）；模型名缺失/`unknown` 不记价；缓存价缺失按 0 计（不再拍脑袋 ×10%） |
| 🔤 **可读性** | 大数自动用「万/亿」单位（287.9万 / 1.5亿），缓存占比精确到两位小数（99.12%） |

## 🏪 本地官方价格库（v2.81 起）

计费新增「本地官方库」层，**各厂商官网直抓的人民币官方价**，与聚合源互为兜底：

```
每天第一次对话
  → 后台跑本地抓取流水线（~12s，非阻塞）→ 重建 prices/index.json（原子写）
  → 查价顺序：pricing.json 的 lock（你手工核对的）> 本地官方库 > 聚合源补录 > 实时聚合源
  → 本地库没刷完/失败 → 自动用前一天的完整库；也没有 → 聚合源兜底
```

- **覆盖**：混元（含 Hy4 6/18/0.3）、DeepSeek 原厂 3 个（含峰谷 空闲/高峰 两档 + 时段规则）、智谱 GLM（含 5.3-Flash 五折双档自动跟随）、Kimi、阶跃、MiniMax 文本模型；阿里千问不存本地库（计费规则复杂放弃解析，走聚合源人民币价）。
- **峰谷**：DeepSeek 高峰×2（9:00–12:00 / 14:00–18:00 工作日、周末全天空闲）；其他模型峰谷按官方页比例换算，非整数倍时自动标注「需人工核验」。
- **环境要求**：需要 **Python 3**（自动探测：`CN_PYTHON` 环境变量 → WorkBuddy 自带 python → 系统 `python`/`python3`）+ 网络。无 python 时静默跳过刷新，弹窗会亮 `⚠价库` 提示，不影响计费。
- **可配置**：`CN_PRICE_DB_DIR`（本地库目录，默认价格库项目 `prices/`）、`CN_PRICE_PIPELINE_DIR`（流水线脚本目录）、`CN_PYTHON`（python 可执行文件路径）。流水线脚本：`fetch-cn-prices.py` + `parse_tokenhub.py` + `build_index.py`（每日手动跑一次即等价于自动刷新）。
- **流水线脚本已随仓库开源（v3.16.1）**：`fetch-cn-prices.py`（MiniMax/阶跃/智谱/Kimi 官方页直抓 + DeepSeek 读 lock 价）、`parse_tokenhub.py`（腾讯云 TokenHub 文档页解析，混元峰谷/分档）、`build_index.py`（合并去重 + lock 权威覆盖 + 单厂商失败沿用防僵尸）。依赖：**仅 Python 3**（v3.23.4 起 `requests` 降为可选——缺失时自动回退脚本内置的 urllib 实现，无需 `pip install requests`）。三个脚本与本技能同目录放置即可被自动发现；抓到的 `prices/index.json` 放在 `CN_PRICE_DB_DIR` 指向的目录。
- **安全（v3.23.4）**：抓取一律走 **TLS 严格证书校验**（价格直接决定计费金额）。仅当你的网络是 MITM 企业代理/自签证书、确需降级时，设环境变量 `CN_PRICES_INSECURE_TLS=1`，脚本会打印一行 `[WARN]` 提示（不会静默关闭）。

## 🔌 联网功能与开关（v2.30 起）

本脚本有 **4 个可单独开关**的联网功能，均在 `token-tracker.js` **顶部**用常量开关控制；另有 **1 条每日自动调起的本地价库 Python 流水线**，它**只受总开关 `ENABLE_NETWORK` 约束**（不受 `ENABLE_PRICE_REFRESH` 管——关掉价格刷新，流水线照跑），单独列出以免误解：

| 开关常量 | 默认值 | 联网功能 | 请求目标 | 是否携带密钥 |
|---|---|---|---|---|
| `ENABLE_NETWORK` | `true` | **总开关**——`false` 时 `token-tracker.js` **自身**的所有联网功能一律跳过（含 5 个分开关，**也包括每日自动调起的本地价库 Python 流水线**，见 `loadPricing` → `maybeRefreshLocalDb`）。注意：兄弟脚本（`refresh-prices.js`/`deepseek-official.js`）只认 `WB_NO_NET=1` 环境变量 |
| `ENABLE_HOLIDAY_REFRESH` | `true` | **分开关5（v3.32.0）**——法定假日表自适应自动刷新（`loadPricing` → `maybeRefreshHolidays` → detach spawn `refresh-holidays.js`）。四条件触发（缺今年 / 10-12 月缺明年 / 任一年陈旧 / >30 天未成功），不满足**完全不联网**，同日最多尝试一次。数据源为 2 个 GitHub 公开仓库（零密钥、不含本地数据）。关掉后峰谷判定遇到数据缺失年份按「非假日」降级并打 stderr 告警，修复用 `node refresh-holidays.js <年>` |
| *(非开关项)* 本地价库 Python 流水线 | 只认总开关 | `fetch-cn-prices.py` → `parse_tokenhub.py` → `build_index.py`，由 `loadPricing()` **每日首次调用时自动后台调起**（`~12s`，非阻塞；每天成功一次即不再跑，失败按 3/10/30/60 分钟退避、当日满 5 次熔断）。`ENABLE_PRICE_REFRESH=false` **不会**关掉它 | `llmabacus` / 各厂商官网 / 腾讯云 TokenHub 文档页 | 否 |
| `ENABLE_BALANCE_QUERY` | **`false`** | 余额查询 | 仅 `https://api.deepseek.com/user/balance` | ⚠️ **是**（DeepSeek API key） |
| `ENABLE_PRICE_REFRESH` | `true` | 每日价格自动刷新 | **5 个公开价格源**：llmabacus（`llmabacus.com/api/prices`）、llm-prices-cn（GitHub raw）、OpenRouter（`openrouter.ai/api/v1/models`）、LiteLLM（GitHub raw）、Portkey（`configs.portkey.ai/pricing/<provider>.json`） | 否 |
| `ENABLE_MODEL_LOOKUP` | `true` | 新模型价格自动补录 | 同上（llmabacus 优先，OpenRouter 兜底） | 否 |
| `ENABLE_UPDATE_CHECK` | `true` | 版本更新检查（**每 7 天最多 1 次**） | 仅 `https://api.github.com/repos/abc1317679842-ui/workbuddy-token-tracker` 的 `releases/latest` 与 `git/matching-refs/tags/v`（两个端点取较大版本） | 否 |

**默认配置 = 零密钥联网**：唯一携带 API key 的请求（余额查询）默认关闭；其余联网均为**公开价格源、无需任何密钥**，失败自动降级为本地价，不影响统计与 toast。

### 如何更改

余额查询开关在 `token-tracker.js` 顶部常量区（v3.18 起读**本地未入库**的 `local-config.json`）：

```js
const ENABLE_NETWORK = true;        // 总开关：false = 全部联网功能关闭
const ENABLE_BALANCE_QUERY = loadLocalFlag('enable_balance_query', false); // 默认关
const ENABLE_PRICE_REFRESH = true;  // 每日价格自动刷新（5 个公开价格源）
const ENABLE_MODEL_LOOKUP = true;   // 新模型价格自动补录（llmabacus + OpenRouter 公开价表）
const ENABLE_UPDATE_CHECK = loadLocalFlag('enable_update_check', true);    // 版本更新检查（可关）
```

要开启余额查询：在技能目录新建 `local-config.json`（内容 `{"enable_balance_query": true}`，文件不进仓库、不会被推送），并确认 `models.json` 里配置了 DeepSeek key。

要关掉版本更新检查（不想让脚本每周访问一次 GitHub）：同一个 `local-config.json` 里写 `{"enable_update_check": false}` 即可（也可以整个用 `ENABLE_NETWORK = false` 一键全关）。关掉后**只影响「有没有新版本」这一条提示**，统计、账本、弹窗、价格刷新都不受影响。

## 🔐 隐私与数据安全

**出网主机清单（全部匿名只读，除余额查询外零密钥；完整的本地写盘位置、诊断日志内容、已知限制见 [CHANGELOG.md](CHANGELOG.md) 的「隐私与安全」章节）**：

| 主机 | 用途 | 密钥 |
|---|---|---|
| `api.deepseek.com` | DeepSeek 官方价（`/models`）；余额查询（`/user/balance`） | 价：无；余额：需你的 DeepSeek key（默认关闭） |
| `api-docs.deepseek.com` | DeepSeek 官方定价页解析 | 无 |
| `www.llmabacus.com` | 聚合价源（国内·人民币·主） | 无 |
| `raw.githubusercontent.com` | `szp2005/llm-prices-cn`（国内备）、`BerriAI/litellm`（USD）、`NateScarlet/holiday-cn` + `HankAviator/china-holiday-calendar`（法定假日表） | 无 |
| `api.github.com` | 假日表 contents API（v3.32.0 起每日链路自适应触发）、版本更新检查（每 7 天） | 无 |
| `openrouter.ai` | 聚合价源（USD） | 无 |
| `configs.portkey.ai` | 聚合价源（USD） | 无 |

请求内容一律不含本地对话/账本数据；假日与版本检查只读公开仓库。

## 🔐 余额查询安全性说明

启用余额查询（`local-config.json` 写 `{"enable_balance_query": true}`，且 `models.json` 配置 DeepSeek key）后，请知悉以下事实：

- **只访问一个网址**：`https://api.deepseek.com/user/balance`（DeepSeek 官方接口，`GET` 请求）。
- **密钥只走官方**：你的 DeepSeek API key 仅通过 `Authorization: Bearer <key>` 头发送给上述官方域名，**不会发给任何第三方**；请求内容不含任何本地文件、对话或系统数据。
- **key 不进进程命令行**（v3.18）：查询子进程经**环境变量**接收 key——进程命令行（任务管理器/审计日志可见）中不含 key 明文。
- **缓存不存密钥**：余额只缓存数值与观测历史（`.balance.json`，保留最近 20 条），**不存 key**；脚本不打印、不上传 key。
- **开启条件**：`~/.workbuddy/models.json` 里需有 url 指向 `api.deepseek.com` 的模型（即你自己的 DeepSeek key）才会真正查询；无 key → 不显示余额，不影响其他功能。
- **默认关闭**：这是全脚本唯一需要联网 + 携带密钥的功能，故默认 `false`。担心隐私可保持关闭，其余功能不受影响。

## 预览

实际运行时 Windows 系统通知效果（回答结束后立即弹出）：

```
DeepSeek-V4 Flash 高峰双倍
耗时 4m 26s 今日¥8.21 余额¥2.77
输入 391.2万 / 输出 1.9万｜缓存99.74%｜¥0.25
```

- **行1（标题大字，分两行）**：
  - 第一行 = 模型完整名 + 时段标注（`高峰双倍` / `夜间X折`，仅有时段策略的模型显示）
  - 第二行 = `耗时` + **今日累计消费**（`今日¥X`，当天 24 小时总花费）+ **余额**（`余额¥X`，仅开启余额且检测到变化时显示）
- **行2（正文小字）**：输入 / 输出 + 缓存占比（两位小数）+ 费用（未收录显示「未收录」）
- 永不溢出换行：行1 第一行 ≤ 45u（`TOAST_ROW1_MAX_W=45`）、行1 第二行 ≤ 42u（`TOAST_ROW2_MAX_W=42`，超限按「丢余额 → 丢今日价 → 保底耗时」降级）、行2 ≤ 51u（`TOAST_LINE_MAX_W=51`）——**以上三个阈值均以代码为准**（见 `token-tracker.js` 常量定义），文档若与代码冲突一律以代码为准

## 💬 怎么查消耗：直接问模型就行（附真实输出示例）

**你不需要记任何命令。** 装好并配好 hooks 之后（见下方「安装」），直接在对话里问就行——模型会自己跑脚本，并把表格**原样**贴给你。下面这张表是「你说什么 → 你会拿到什么」的对照。

### 你说什么 → 你会拿到什么

| 你只要这么说 | 模型实际跑的命令 | 你拿到的表 |
|---|---|---|
| 「今天用了多少」「看今天的消耗」「今日统计」 | `--report` | **今天**的分模型明细（每个模型一行）+ 当日合计行 |
| 「9 月 28 号花了多少」 | `--report 2026-09-28` | 那**一天**的同结构明细 |
| 「这周用了多少」「最近 7 天」 | `--report week` | **近 7 天**按模型汇总成**一张表** + 合计行 |
| 「这个月消耗」「本月到现在」 | `--report month` | **本月至今**按模型汇总的一张表 |
| 「9 月 1 号到 9 月 30 号」 | `--report 2026-09-01..2026-09-30` | 任意区间按模型汇总的一张表（**起止写反会自动纠正**） |
| 「把历史都列出来」 | `--report all` | 全部历史天，每天一块明细 + 该日合计 |
| 「只要个总数，别列模型」 | `--report summary all` | 每天**只有一行**总计（仅当用户明确要「只要总数/别列模型」时才贴；它**不含模型明细**，不是默认视图） |
| 「照这速度还能用多久」「估一下后面的消耗」 | `--report forecast` | **只推 token、不推金额**的速率外推（样本不足 2 天会拒绝算） |
| 「导个 CSV」「要能在 Excel 里打开的」 | `--report <范围> --csv` | **不贴表格**，只回**一行文件路径** |
| 「上一轮用了多少」 | 手动模式（无参数） | 一行：上一轮的模型 / 耗时 / 输入输出 token |

> 表格列固定 **7 列**：`模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额`。模型**必须原样贴出脚本输出**——不许自己重排、不许改成列表、不许精简列。原因很实在：空格对齐依赖字体宽度、不同环境必歪，Markdown 表格才不会。

### 真实输出示例

以下数据都是**作者本机 2026-10-01 的真实输出**（你的数字当然不一样），数字未做任何加工；排版上把脚本输出的表格转成了 Markdown 表格渲染——脚本吐的原始文本没做列宽对齐，直接贴在代码块里会错位（v3.23.1 修正过这个问题）。

**① 问「今天用了多少」→ `--report`**（脚本输出标题：`===== 2026-10-01（今天） =====`）

| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |
|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | 1.6亿 | 74.8万 | 1.6亿 | 98.35% | 1.6亿 | ¥8.71 |
| hy3 | 27.4万 | 787 | 18.2万 | 66.52% | 27.4万 | ¥0.14 |
| hy4-preview | 2791.3万 | 16万 | 2608.4万 | 93.45% | 2807.3万 | ¥21.68 |
| **合计** | **1.9亿** | **90.9万** | **1.8亿** | **97.57%** | **1.9亿** | **¥30.53** |

**② 问「这周用了多少」→ `--report week`**（脚本输出标题：`===== 2026-09-25 ~ 2026-10-01（7 天有记录） =====`）

| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |
|---|---|---|---|---|---|---|
| deepseek-flash | 1.2亿 | 37.5万 | 1.2亿 | 98.27% | 1.2亿 | ¥5.87 |
| deepseek-v4.1-flash | 6.1亿 | 403.9万 | 6亿 | 98.18% | 6.1亿 | ¥45.15 |
| glm-5.3-flash | 3.1亿 | 107.3万 | 2.9亿 | 94.19% | 3.1亿 | ¥83.80 |
| hy3 | 264.7万 | 1.1万 | 179.7万 | 67.89% | 265.8万 | ¥1.34 |
| hy4-preview | 1.7亿 | 58.7万 | 1.6亿 | 94.38% | 1.7亿 | ¥118.65 |
| **合计** | **12.1亿** | **608.5万** | **11.7亿** | **96.57%** | **12.2亿** | **¥254.82** |

口径：金额按 pricing.json 的 API 单价折算（缓存价 / 峰谷倍数已计入），**不是真实扣费**；本技能只读 WorkBuddy 落盘的 token 用量，与客户端自带积分/额度之间不存在换算关系。

> `--report month`（本月至今）与 `--report 2026-09-01..2026-09-30`（任意区间）**表结构完全一样**，只是标题里的日期范围不同。

**③ 问「9 月 28 号花了多少」→ `--report 2026-09-28`**（脚本输出标题：`===== 2026-09-28 =====`）

| 模型 | 输入 | 输出 | 缓存 | 缓存命中 | 总 token | 金额 |
|---|---|---|---|---|---|---|
| deepseek-flash | 7429.6万 | 24万 | 7314.5万 | 98.45% | 7453.6万 | ¥3.57 |
| deepseek-v4.1-flash | 1.9亿 | 123.3万 | 1.9亿 | 98.20% | 1.9亿 | ¥12.21 |
| glm-5.3-flash | 4762.1万 | 32.2万 | 4450万 | 93.45% | 4794.3万 | ¥13.63 |
| hy3 | 24.2万 | 697 | 16.1万 | 66.56% | 24.3万 | ¥0.12 |
| hy4-preview | 4872.5万 | 16.2万 | 4587.8万 | 94.16% | 4888.7万 | ¥33.75 |
| **合计** | **3.6亿** | **195.7万** | **3.5亿** | **97.07%** | **3.7亿** | **¥63.30** |

**④ 问「照这速度还能用多久」→ `--report forecast`**（脚本输出标题：`===== 消耗外推（只推 token，不推金额） =====`）

- 今日至 06:24 —— 总 1.9亿 tokens（已过 6.4h）
- 按当前速率到 24:00 —— 约 7亿 tokens
- 近 7 日实测均值 —— 1.5亿 tokens/日

说明：外推 = 今日已消耗 ÷ 已过时间 × 24h 的线性估算，只推 token；金额列一律为「按 API 单价折算」，与 WorkBuddy 客户端额度之间不存在换算关系。

**⑤ 问「导个 CSV」→ `--report 2026-09-01..2026-09-30 --csv`**

```
已导出：C:/Users/<你的用户名>/.workbuddy/skills/token-usage-tracker/exports/report-range-20261001-062750.csv（81 行，UTF-8 BOM，金额为 API 单价折算值）
```

> 注意这里**只有一行路径、没有表格**——文件是给 Excel 用的（逐日 × 逐模型明细 + `ALL` 合计行，带 UTF-8 BOM 所以中文列头不会乱码），把几十行贴进对话纯属刷屏。

**⑥ 问「只要个总数」→ `--report summary all`**（每天一行；仅在用户明确要「只要总数/别列模型」时展示，不含模型明细）

| 日期 | 输入 | 输出 | 缓存 | 总 token | 金额 |
|---|---|---|---|---|---|
| 2026-08-17 | 2973.3万 | 20.8万 | 2817.8万 | 2994.1万 | ¥3.45 |
| 2026-08-16 | 8387.3万 | 42.1万 | 8079.5万 | 8429.5万 | ¥11.33 |
| 2026-08-15 | 3.1亿 | 173.1万 | 3亿 | 3.2亿 | ¥52.75 |

### 拿不到的东西（别指望，也别让模型编）

- **单轮明细**（「哪一轮最贵」「子代理占了多少」）：账本粒度是**天**。每轮明细确实写在 `rounds/rounds-YYYY-MM.jsonl` 里，但**没有对应的查询命令**，只能让模型直接读那个文件——这是已知缺口，不是你没问对。
- **一天里某个时段的消耗**（「上午花了多少」）：账本按**天**分桶，不按小时。
- **真实扣费金额**：见上方「金额口径声明」——内置模型模式下金额只是按 API 单价折算的参考值，与客户端积分/额度**没有换算关系**。

## 工作原理

- **普通对话**：`Stop` 事件（平台在回答结束后触发）→ 聚合本轮 trace（或 transcript）→ 弹系统通知「本条 Token 消耗」
- **专家团**：子代理 + 主理人的全部调用从 transcript 聚合 → watcher 延迟约 6 秒弹**一条**整轮汇总（等待最后一个子代理落盘，不弹多次）
- **手动 / `--hook` 模式** → 显示「最近完成轮次」（即上一条回答，精确但滞后一轮）

```
回答结束 → Stop hook → 读本轮 trace/transcript → 弹系统通知「本条 Token 消耗」
专家团场景 → 多个子代理调用 → 合并延迟 ~6s → 弹一条整轮汇总
你发下一条 → UserPromptSubmit hook → 注入「上一轮」用量到上下文
```

## 安装

仓库目录名是 `workbuddy-token-tracker`，技能目录名必须是 `token-usage-tracker`（`token-tracker.js` 按此路径定位），**clone 后需改名**：

```bash
# 1. clone 并改名为技能目录名，拷入用户级技能目录
git clone https://github.com/abc1317679842-ui/workbuddy-token-tracker.git
cp -r workbuddy-token-tracker ~/.workbuddy/skills/token-usage-tracker

# 2. 在 ~/.workbuddy/settings.json 配置 hooks（见下）
```

> Windows 提示：hook 命令里**不要用 `~`**（部分执行环境不展开），请写完整路径，如 `node "C:/Users/<你的用户名>/.workbuddy/skills/token-usage-tracker/token-tracker.js" --hook`。

### 文件清单

| 文件 | 作用 |
|---|---|
| `token-tracker.js` | 主脚本：`--hook` 注入 / `--stop` 通知 / `--report` 账本（重算用 `recalc-day.js`，见下行） |
| `refresh-prices.js` | 多源价格刷新（每天首次运行自动触发，也可手动跑） |
| `peak-rules.js` | 峰谷时段判定的**唯一实现**：主脚本 / `backfill.js` / `recalc-day.js` 共用（v3.19.0 起，消除三份硬编码副本） |
| `deepseek-official.js` | DeepSeek 官方定价抓取（被 refresh-prices 调用） |
| `refresh-holidays.js` | 中国法定节假日双源刷新（峰谷计费用）。**v3.32.0 起默认自动**：每日链路按四条件自适应触发（缺今年 / 10-12 月缺明年 / 任一年陈旧 / >30 天未成功），无需手动；强制触发 `node refresh-holidays.js <年>`，只读体检 `node refresh-holidays.js --check`。两源不一致时**取交集**（保守）并在 **stderr 逐日告警**（列出仅 A / 仅 B 认定的假日）；差异按年落 `holidays.json` 的 `cross_check_diff.<年份>.only_a / .only_b`；缺数据年份落 `null` + `_stale/stale_years` 标记（**绝不写空数组**） |
| `peak-rules.js` | 峰谷时段判定的**唯一实现**（主脚本 / `recalc-day.js` / `backfill.js` 共用，避免三处硬编码口径分裂） |
| `fetch-cn-prices.py` | 国内厂商官网价抓取（Python 3；`requests` 可选，缺失自动回退 urllib） |
| `parse_tokenhub.py` / `build_index.py` | 本地官方价库解析/建索引（可选） |
| `pricing.json` / `holidays.json` | 价格库 / 节假日数据（技能目录内） |
| `recalc-day.js` / `backfill.js` | 账本维护工具（指定日重算 / 历史回填） |
| `SKILL.md` / `CHANGELOG.md` / `manifest.yaml` / `LICENSE` | 技能说明 / 变更史 / 元数据 / 许可 |
| `selftest.js` | 离线冒烟自测（`node selftest.js`，不碰真实账本；沙箱类受限环境自动 SKIP） |
| `KNOWN-ISSUES.md` | 已知未修问题（脱敏公开记录） |
| `TROUBLESHOOTING.md` | **故障排查手册**（弹窗诊断日志 + 34 行故障速查表），v3.23.0 从 SKILL.md 移出 |
| `docs/balance.md` | 余额显示细节（原理 / 启用条件 / 模式识别 / 隐私） |
| `docs/pricing-refresh.md` | 价格刷新策略（5 源）+ 峰谷时段口径 + 计费公式 |
| `docs/windows-notification.md` | Windows「不弹横幅」修复（SmartOptOut 注册表法 + 实测证据） |
| `rounds/`（运行时生成） | 轮次明细留档 `rounds-YYYY-MM.jsonl`，保留最近 6 个月，**不入库** |
| `exports/`（运行时生成） | `--report --csv` 的 CSV 导出目录，**不入库** |
| `.update-check.json`（运行时生成） | 版本检查状态（上次检查时间 / 已知最新版 / 已提示次数），**不入库** |
| `.gitignore` | 排除本地运行时文件与私密配置 |

### 文档怎么读（v3.23.0 起 SKILL.md 已瘦身）

v3.23.0 把 `SKILL.md` 从 **76.2 KB（≈18,400 token）精简到 42.4 KB（≈10,000 token）**——精简掉的是「CHANGELOG 副本 + 排障手册 + 历史细节」，挪进下面这些**按需加载**的文件（模型默认不读，命中症状才读）：

| 你想知道什么 | 看哪个文件 |
|---|---|
| 怎么用、怎么问 | 本 README（给**你**看的门面） |
| 技能的触发规则与铁律 | `SKILL.md`（给**模型**看的，精简版） |
| 不弹窗 / 账本数字不对 / 价库异常 / 更新提示异常 | `TROUBLESHOOTING.md` |
| 余额怎么来的、为什么不显示 | `docs/balance.md` |
| 价格怎么刷新的、峰谷怎么算的 | `docs/pricing-refresh.md` |
| 「有提示音但不弹横幅」 | `docs/windows-notification.md` |
| 某个版本改了什么 | `CHANGELOG.md` |

功能行为**没有任何变化**——这次是纯文档重构，主脚本除版本号外未动一行。

### Hook 配置示例（`settings.json`）

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/<你的用户名>/.workbuddy/skills/token-usage-tracker/token-tracker.js\" --hook"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/<你的用户名>/.workbuddy/skills/token-usage-tracker/token-tracker.js\" --stop"
          }
        ]
      }
    ]
  }
}
```

- **`UserPromptSubmit`**：你提交下一条消息时自动注入「上一轮」用量（不依赖模型自觉）
- **`Stop`**：每次回答结束后自动触发，弹 Windows 系统通知显示**本条**消耗

### 手动使用（不想配 hook 时）

```bash
node "C:/Users/<你的用户名>/.workbuddy/skills/token-usage-tracker/token-tracker.js"
# 输出示例：
# 上一轮 DeepSeek-V4 Flash ｜ 耗时 1m 47s ｜ 输入 69.8万 / 输出 1.1万 tokens（该轮累计 70.9万，缓存命中 64.1万）
```

## 如何升级（版本更新提示弹出来之后做什么）

本技能**没有自动更新**——安装方式就是「把目录拷进技能目录」，自动覆盖会动你自己的文件（可能抹掉 `local-config.json`、本机改动）。所以脚本只负责**告诉你**有新版本，升级动作由你（或让助手）执行：

```bash
# 1) 备份你自己的本地配置（这两类文件不在仓库里，重装会丢）
cd ~/.workbuddy/skills/token-usage-tracker
cp local-config.json /tmp/     # 有的话
cp models.json /tmp/           # 有的话

# 2) 拉新版本（clone 后目录名是 workbuddy-token-tracker，需改名为 token-usage-tracker）
git clone https://github.com/abc1317679842-ui/workbuddy-token-tracker.git /tmp/wtt-new

# 3) 覆盖旧目录（保留你的运行时数据：账本/快照/水位线本来就在旧目录里，先备份再覆盖）
cp /tmp/wtt-new/*.js /tmp/wtt-new/*.py /tmp/wtt-new/*.json /tmp/wtt-new/*.md ~/.workbuddy/skills/token-usage-tracker/ 2>/dev/null
```

> 更省事的做法：直接对新 clone 下来的目录执行一次「拷入技能目录」的安装步骤（见上方「安装」），再把 `/tmp/` 里备份的 `local-config.json` / `models.json` 拷回去。
>
> **hooks 配置不用改**（路径没变），账本 `daily-usage.json` 在旧目录里——**千万别删旧目录前不备份**。升级完 `node token-tracker.js --report` 能正常出表即成功。

## 只保留 Token 通知（关闭 WorkBuddy 自带通知）

```
Windows 设置 → 系统 → 通知 → 应用通知
→ 找到「WorkBuddy」→ 关闭它的通知开关
```

本技能的 toast 使用**独立应用名「WorkBuddy Token Tracker」** 直接调用 Windows 系统通知 API 弹出，**不经过 WorkBuddy 客户端设置**——关闭 WorkBuddy 自带通知**不影响 Token 通知**。若想连 Token 通知一起关：在通知列表单独关闭「WorkBuddy Token Tracker」即可。

## 更新记录（Changelog）

完整版本变更史已拆分至 **[CHANGELOG.md](CHANGELOG.md)**（v3.18 起，含从本文件与 SKILL.md 迁入的全部历史条目）。

