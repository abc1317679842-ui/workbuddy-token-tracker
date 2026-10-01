# 更新记录（Changelog）

> v3.18 起从 README.md / SKILL.md 拆出集中维护（原两处变更史逐字重复、体积失控且易漂移）。
> 历史条目按原样迁移，未改写内容。

## v3.23.3（2026-10-01）—— CI 首跑抓出的 M7 守卫时序修复（deepseek-official.js）

> CI（windows-latest）首跑红了 2 条：T4 M7（exit=null）+ T3 R4（stderr 无告警）。逐条定位后确认是 **1 个真代码缺陷 + 1 个断言前提问题**——这正是 CI 的价值：这两条在本机从未暴露过。

### 一、真缺陷：M7 守卫放在联网之后（deepseek-official.js）

- **原实现**：`main()` 先 `fetchHtml()` 官方页，成功后、写盘前才检查 pricing.json 是否损坏 → 损坏就 `exit(2)` 拒绝覆盖。
- **问题**：断网 / `WB_NO_NET=1` 环境下 fetch 抛错 → 重试循环烧完 → `exit(1)`，**守卫永远到不了**；且守卫语义本来就是「损坏就别发起网络请求、更别覆盖」——先联网再拒绝是本末倒置。重试总时长还撞了 selftest 的 60s 超时（`exit=null` = SIGTERM，CI 日志实锤）。
- **修复**：守卫提前到 `main()` 开头——`loadPricing()` 失败且文件存在 → 立即 `exit(2)`，**零网络请求**。写盘前的 `pricing = { models: {} }` 兜底保留（文件不存在 = 首次运行允许从零建档）。
- **行为影响**：正常环境（价库完好）零变化；损坏环境从「白跑一轮网络后才拒绝」变成「立刻拒绝」。

### 二、断言前提：T3 R4 在断网环境 skip

- T3 R4 测的是「损坏 → 重建完成 → stderr 带价库告警」。`WB_NO_NET=1` 下重建走失败分支，前提不成立 → selftest 里改 skip（与既有「重建未完成」skip 同型）。

### 三、验证

- 本机 selftest **125 过 / 0 败**；CI 复跑（本版推送自动触发）结果见 Actions 页。

---

## v3.23.2（2026-10-01）—— 首个 CI（GitHub Actions selftest）+ KI-2 漏弹上限 30min → 5min

> 缘起（用户拿外部评审来对证）：「分析一下」——四项建议（补 CI / KI-2 锁升级 / grep 断言渐进换导出 / 拆巨石文件）逐条核查后采纳前两项，本版落地。

### 一、新增 GitHub Actions CI（`.github/workflows/selftest.yml`）

- **触发**：push 到 master / main（个人仓库直接 push，`pull_request` 触发永远不会发生，不配）。
- **runner**：`windows-latest`——watcher / toast / PowerShell 相关断言依赖 Windows 行为；公共仓库 Windows runner 免费。
- **零依赖验证**：steps 不装任何包，`node selftest.js` 直接跑——**顺手验证「零依赖单文件」这个卖点没被悄悄破坏**。
- **`WB_NO_NET=1`**：refresh-prices / deepseek-official 读它模拟断网，CI 里禁止真联网（`TOKEN_TRACKER_NO_TOAST` / `WB_ROOT` 隔离由 selftest 内部自设，无需重复）。
- **增量价值（比"防手滑"更强的一条）**：`T12-j`（`--hook` 端到端「有新版 → 注入提示」断言）在本机沙箱因 node 子进程 EBUSY **每次都 SKIP、从没真正跑绿过**——CI runner 无此限制，这条路径第一次得到真实验证。
- **首跑预期**：T12-j 属于「从未在本机真跑过」的断言，首跑有概率红（要修一两处），属正常收敛，不是 CI 白干。

### 二、KI-2 漏弹上限收紧：`WATCH_LOCK_TTL` 30min → 5min

- **问题**（KNOWN-ISSUES KI-2）：watcher 崩溃/被杀后，锁残留；pid 复用会让 `kill(pid,0)` 误判"存活"，后续 Stop 全部不接管 → 漏弹最长 **30 分钟**。
- **处置**：TTL 30min → 5min（一行常量 + 注释），漏弹上限砍 6 倍；KNOWN-ISSUES 的 KI-2 从「存活」改标「**已缓解**」。
- **明确不采用**「锁里写进程启动时间对比」：node **没有**跨进程查启动时间的纯 API，Windows 上只能 PowerShell `Get-Process` / wmic——**被本机安全策略禁用**（与余额模式识别的进程探测限制同源，代码内有案底）。误接管风险可控：接管条件本来就保守（ESRCH 判死才动 + 原子 `wx` 建锁），最坏结果是多弹一次，优于漏弹。

### 三、评审未采纳项（记录在案）

- **grep 型源码断言渐进换导出单测**：方向认可，按「下次改到那块顺手换」执行，不专门开版本。
- **拆巨石单文件（切 watcher 出去）**：不拆。「拷入即用、零依赖、无构建」是安装方式的一部分；改动圈（watcher ≈600 行 / 5262 行 = 11%）小于拆分维护成本，优先级垫底。

### 四、验证

- selftest **125 过 / 0 败**（本机；T12-j 沙箱 SKIP 仍跳过，CI 上首跑）。
- CI 首跑结果见仓库 Actions 页；green 后本条目如有修正会追加说明。

---

## v3.23.1（2026-10-01）—— README「真实输出示例」排版修正：代码块 → 真表格渲染（纯文档排版修正，代码零改动）

> 缘起（用户反馈）：「输出的案例排版为什么不对？排版根本不整齐，**错位的**。如果能按照表格就按照表格，不按照表格也尽量把它对齐。」

### 一、根因（不是上传损坏，是排版方式的问题）

- 从仓库拉回 README 与本地**逐字节一致**（38,083B），先排除了上传出问题的可能。
- 真正的根因：①②③ 段把脚本输出的 **markdown 表格包进了 ` ``` ` 代码块**——GitHub **不渲染代码块里的表格语法**，按等宽纯文本显示；而 `--report` 的原始输出**不做列宽补齐**（单元格多长就多长，靠各环境字体渲染对齐），放进等宽代码块后每列起始位置参差不齐 → **整表错位**。④⑥ 段的纯文本同理（各行前缀长度不同，等宽下也对不齐）。

### 二、修法（按用户要求：能成表格的成表格，不成表格的对齐）

| 段 | 原排版 | 现排版 |
|---|---|---|
| ① 今天 / ② 本周 / ③ 某天 | 代码块内错位表格 | **真 Markdown 表格**（GitHub 渲染、自动对齐）；`===== 标题 =====` 移出表格写进段标题 |
| ④ 外推 forecast | 代码块内三行文本 | **无序列表**（前缀 → 数值，天然对齐） |
| ⑤ CSV 路径 | 代码块单行 | 保留代码块（单行无对齐问题） |
| ⑥ summary | 代码块内三行 | **真 Markdown 表格**（日期 / 输入 / 输出 / 缓存 / 总 token / 金额） |

示例开头说明同步改写：**数字仍是 2026-10-01 真实输出、未做任何加工**，排版转成了表格渲染（并注明为什么——原始输出不做列宽补齐，贴代码块必错位）。

### 三、同类问题全仓扫描

对全部 8 个 md 文件扫描「代码块内嵌表格」（围栏内出现 `\| --- \|` 分隔行即命中）：**除 README（已修）外零命中**。SKILL.md 方式 C 的 toast 示例是 3 行布局示意（非数据表、不需要纵向对齐），不属此类问题。

### 四、边界

纯 README 排版修正，**代码零改动**；`--report` 各入口、toast、账本、更新检测行为完全不变。selftest 全绿。

---

## v3.23.0（2026-10-01）—— SKILL.md 瘦身：76.2 KB → 42.4 KB，排障/边缘内容改为按需加载（纯文档重构，代码逻辑零改动）

> 缘起（用户追问）：「现在这个技能字符占据了多少啊？有多少字啊？**算是很超标吗？需要精简吗？** 哪些可以挪出去，哪些可以挪到其他地方启用？」

### 一、实测体量：超标 3.7 倍，且是「结构性超标」

| 文件 | 字节（改前） | 估算 token | 行 | 是否进上下文 |
|---|---:|---:|---:|---|
| **SKILL.md** | **77,999（76.2 KB）** | **≈18,401** | 406 | ✅ 技能激活即整体注入 |
| README.md | 36,665 | ≈8,668 | 405 | ❌ 用户自己看 |
| CHANGELOG.md | 193,187 | ≈45,522 | 1,245 | ❌ 不进上下文 |

对照「单 skill 的 SKILL.md 建议 ≤5,000 token」→ **18.4K ≈ 3.7 倍**。但真正常驻的 frontmatter description 只有 2.3 KB，**那是触发键、不能动**——问题全在正文。

### 二、病灶：51% 的内容是 CHANGELOG 副本 + 排障手册 + 历史细节

| 块 | 字节 | 占比 | 判定 |
|---|---:|---:|---|
| 版本要点堆积（v3.19~v3.22.1 七段大引用） | 14,799 | 19.0% | CHANGELOG 的镜像 → 删 |
| 故障排查速查表（31 行） | 12,266 | 15.7% | 排障时才看 → 挪 |
| 余额显示（仅 DeepSeek 自建 API） | 6,576 | 8.4% | 边缘功能 → 挪 |
| 方式 C 布局演进史（v2.6→v2.35） | 5,570 | 7.1% | 纯历史 → 压 |
| Windows 通知横幅设置 | 3,358 | 4.3% | 一次性装机设置 → 挪 |

### 三、挪出去了什么（4 个新文件，均**默认不加载**）

| 新文件 | 内容 | 命中什么症状才 Read |
|---|---|---|
| `TROUBLESHOOTING.md` | 弹窗诊断日志 + 常见排查步骤 + **31 行故障速查表**（约 14 KB） | 不弹窗 / 弹窗内容不对 / 账本数字不对 / 价库异常 / 更新提示异常 |
| `docs/balance.md` | 余额原理 / 启用条件 / 模式识别判据 / 显示位置与宽度让位 / 隐私 | 问「余额怎么来的 / 为什么不显示 / 余额不对」 |
| `docs/pricing-refresh.md` | 每日刷新策略（5 源）+ 峰谷时段口径 + 计费公式 | 问「价格怎么刷新 / 峰谷怎么算 / 时段标注不对」 |
| `docs/windows-notification.md` | SmartOptOut 横幅修复（两条 PowerShell + 实测证据 + 回退说明） | 「有提示音、通知中心能翻到，但右下角不弹横幅」 |

主文档新增「📦 按需加载的旁支文件（默认不要读）」索引节；SKILL.md 只留**触发规则 / 命令映射 / 核心机制 / 铁律 / 反借口表**。

### 四、实测结果

| 项 | 改前 | 改后 | 变化 |
|---|---:|---:|---|
| SKILL.md 字节 | 77,999 | **42,402** | **−35,597B（−45.6%）** |
| SKILL.md 估算 token | ≈18,401 | **≈10,000** | −46% |
| SKILL.md 行数 | 406 | 326 | −80 |
| 版本要点段 | 7 段 / 14,799B | 2 段（v3.22.0、v3.22.1）/ 2,988B | −11,811B |

**代码零改动**：主脚本 `token-tracker.js` 除 `SKILL_VERSION` 与头注释版本号外**未动一行**。

### 五、新增两条防漂移守卫（selftest T12）

- **i5**：SKILL.md 的「当前功能总览」标题**不得内嵌版本号**（版本以 `manifest.yaml` 为准）——总览标题里的硬版本号是历史漂移源，本次已改为「（版本以 manifest.yaml 为准）」。
- **i6**：SKILL.md 里 `Read` 指向的旁支文件**必须真实存在**（4 个）——防止文档引用了不存在的文件、模型 Read 时扑空。

### 六、边界（如实说明）

- 这是**纯文档重构**，`--report` 各入口、toast、账本、更新检测的行为**完全不变**。
- 排障路径多了一跳：模型要「先识别症状 → 再 Read 对应文件」。若模型没识别出症状就不会去读——这是渐进式加载的固有代价，已用 SKILL.md 顶部的索引表把症状写明确来兜底。

---

## v3.22.1（2026-10-01）—— 把「怎么问 → 得到什么表」写进文档（纯文档版，代码零改动）

> 缘起（用户追问）：「介绍和技能里面有没有说清楚？**可以通过直接问模型问消耗**……不是刚刚才更新的、可以看到模型更多的消耗时间段吗？这些技能有没有更新、介绍那里有没有写清楚？**怎么通过说哪些话、问哪些问题可以得到不同的数据表格？**」

### 一、核实结论：功能早就有了，**缺的是「怎么问」这一层文档**

- **功能不缺**：时间维度查询 v3.20.0 就已全部落地——`--report`（今天）/ `<日期>` / `all` / `summary [all|<日期>]` / `week` / `month` / `<起>..<止>` / `forecast` / `--csv`。
- **文档缺**：全仓搜 `问法 / 话术 / 怎么问 / 触发词` **零命中** —— README 与 SKILL.md 从头到尾**没有一份「自然语言说法 → 该跑哪条命令」的对照**。
- **后果是两头都抓瞎**：用户不知道能问什么（以为只能看弹窗），模型也不知道该跑哪条命令 —— 最典型的翻车是用户问「这周用了多少」，模型跑 `--report all` 把几十天全贴出来让用户自己找。

### 二、本次补的两处（分工明确）

| 文件 | 给谁看 | 补了什么 |
|---|---|---|
| **SKILL.md** | **模型**（= 触发层） | 新增「**自然语言问法 → 命令映射**」**强制表**（10 行：今天 / 某一天 / 这周 / 本月 / 一段日期 / 全部历史 / 只��总数 / 照这速度 / 导 CSV / 上一轮 → 各跑哪条命令）+ **反模式表**（6 条，含「问这周却跑 all」「问区间却按天跑 N 次自己相加」）+ 排查速查表 2 行 + frontmatter 触发词补齐（最近 7 天 / 9 月 1 号到 30 号 / 照这速度 / 上一轮） |
| **README.md** | **用户**（= 仓库门面） | 新增「**💬 怎么查消耗：直接问模型就行**」章节：问法→表格对照表 + **6 段真实输出示例**（今天 / 本周 / 历史某天 / 外推 / CSV 路径 / summary 一行式）+ 拿不到的东西 |

### 三、6 段真实输出示例（作者本机 2026-10-01 真实数据，未加工）

| 问法 | 命令 | 示例要点 |
|---|---|---|
| 今天用了多少 | `--report` | 4 行（3 模型 + 合计），合计 1.9 亿 tokens / ¥30.53 |
| 这周用了多少 | `--report week` | `2026-09-25 ~ 2026-10-01（7 天有记录）`，5 模型汇总成**一张表**，¥254.82 |
| 9 月 28 号花了多少 | `--report 2026-09-28` | 单日同结构明细，¥63.30 |
| 照这速度还能用多久 | `--report forecast` | 只推 token 不推金额：今日速率外推 + 近 7 日实测均值 |
| 导个 CSV | `--report <范围> --csv` | **只回一行路径**（81 行、UTF-8 BOM），不贴表格 |
| 只要个总数 | `--report summary all` | 每天一行（模型内部看趋势用，**禁止**当正式表格给用户） |

### 四、如实写明的两个「拿不到」

- **单轮明细**（「哪一轮最贵」「子代理占了多少」）：账本粒度是**天**；每轮明细确实写在 `rounds/rounds-YYYY-MM.jsonl`，但**没有 CLI 入口** —— 只能让模型读文件。**这是已知缺口，不是用户没问对。**
- **一天里某个时段**（「上午花了多少」）：账本按**天**分桶，拿不到小时粒度。

### 五、改动量

纯文档：`README.md` 新增一整章（含示例表格）、`SKILL.md` 新增映射表 + 反模式表 + 速查表 2 行 + frontmatter 触发词、`manifest.yaml` 版本与描述。**`token-tracker.js` 只改版本号与头注释，逻辑零改动** —— 回归只需确认既有输出不变（本次 8 种输出与上一版逐字节相同，见 v3.22.0 条目）。

---

## v3.22.0（2026-10-01）—— 版本提示的检测点修准 + 覆盖盲区补齐 + 全量文档复核

> 缘起（用户质疑）：「你对于检测更新、检测仓库的是哪里？选择的点准确吗？这些你多次测试测验了吗？这个地方不准确的话，会导致别人收不到更新。」
> 外加（用户指令）：「把整个项目的那些介绍全部审核一遍，我感觉里面好像有一些过时的东西。」

### 一、两处真缺陷（逐条实测后确认，非推测）

| # | 缺陷 | 现象 | 修法 |
|---|---|---|---|
| ① | **挂载点被早退分支绕过** | v3.21.0 把提示挂在两个 `out()` 调用点上，而 `--hook` 路径有 3 条**提前 `return`** 分支（`trace 文件尚未完成写入`、手动取消轮补弹 等）走的是**另外的** `out()` → 命中这些分支的那一轮**根本不会带上提示** | 追加逻辑**下沉到 `out()` 内部**（唯一输出出口），检查提前到 `main()` 最开头算一次并缓存 → 只要这一轮有任何 hook 输出就必然带上，**结构上不可能再被 `return` 绕过**，将来新增早退分支也自动覆盖 |
| ② | **检测点漏「有 tag 无 release」** | v3.21.0 只查 `releases/latest`——某次只打了 tag 没发 release（或顺序颠倒）就会**漏报**，与事实不一致 | 新增 `git/matching-refs/tags/v` 端点，**两个端点都查、取版本号较大者**（取向：宁可早报，不可漏报）。两次请求合并在**同一个子进程**里完成，实测总耗时约 **1.5s** |

### 二、覆盖盲区（③）

- **问题**：只配了 `Stop`、**没配 `UserPromptSubmit` hook** 的用户，**永远**触发不了注入通道 → 该功能对他们等于不存在。
- **判据**：`.update-check.json` 的 `lastHookAt`（每次 `--hook` 刷新）。缺失或距今 **≥3 天**（`HOOK_IDLE_MS`）即认为"没配 hook"。
- **兜底**：Stop 端在弹窗前做**同一套检查**（7 天闸门 / 退避照旧），命中就在**弹窗第一行尾部**追加 `｜⬆vX.Y.Z`；**放不下就整个不显示**——绝不触发"缩略模型名"，也绝不动第二行的耗时/今日/余额。
- **不打扰已配 hook 的用户**：他们永远不会看到这个标记（`updateTagForToast()` 仅在 `hookIdle()` 为真时产出）。

### 三、行为规格补充

- **版本比较 `cmpVersion` 改为数值比较 + 畸形 tag 一律返回 0**：非「纯数字点数」形状（`release-2026` / `junk` / 空串）视为**无法确定**返回 0，杜绝把畸形 tag 误判成"有新版"。字符串比较会把 `'3.9.0' > '3.10.0'` 判成 true，这是最初踩到的坑。
- **闸门与节流拆成两个纯函数**：`maybeFetchLatest()`（只改状态：7 天闸门 + 失败退避，hook / Stop 两条通道共用）与 `claimNotify()`（只判要不要提示：同版本最多 2 次、间隔 ≥24h）。
- **非 hook 输出逐字节不变**：`out()` 内是 `asHook && upNote` 双条件，手动模式 / `--report` / `--stop` 的 payload 与 v3.21.0 **完全一致**。

### 四、全量文档复核（发现并修正 3 类过时/失准表述）

| 位置 | 原文（错） | 修正 |
|---|---|---|
| `README.md` 时段价格标注行 / `SKILL.md` 时段折扣节 | 「**时段策略无公开 API 数据源，需手动维护**」+ 让你改 `peak_multiplier`/`night_discount`/`peak_hours`/`night_hours` | **对 DeepSeek 原厂不成立**——`deepseek-official.js` 每日抓官方定价页写 `deepseek_rules.peak_schedule`，**官方改时段自动跟随**（v3.19.1 起真正生效）。改为「**来源分两类**」：DeepSeek 官方自动跟随 / 其他厂商人工维护 |
| 同上 | 列出 `peak_hours` 字段 | **`peak_hours` 是幽灵字段**——全仓无任何代码读取该键（只有 `pricing.json` 里那个纯描述字符串 `peak_hours_cn`）。高峰时段只来自 `deepseek_rules.peak_schedule` 或内置默认。已明确标注"不存在此字段" |
| `README.md` 联网开关表 | 「`refresh-holidays.js` 与 **Python 流水线**无开关（仅手动运行时联网）」 | **双重错误**：本地价库 Python 流水线由 `loadPricing()` → `maybeRefreshLocalDb()` **每日自动调起**（非手动），且受总开关 `ENABLE_NETWORK` 约束（`ENABLE_PRICE_REFRESH=false` **关不掉它**）。已改为独立表格行说明 |
| `KNOWN-ISSUES.md` 抬头 | 「引用以 **v3.18.3** 的 `token-tracker.js` 为准」；`acquireWatchLock`「约 L3658-3720」 | 漂了 4 个版本、行号全错（实际 `acquireWatchLock` ≈ L4234、`withFileLock` = L463）。改为「**以函数名为主锚点**」，行号按 v3.22.0 重标 |

### 五、自测与回归

- `selftest.js` 新增 T12 段（版本比较含畸形 tag / 闸门 / 节流 / 退避 / 状态容错 / 文案长度与禁含项 / 仅 hook 挂载的源码守卫 / `.gitignore` 守卫 / **版本号四处一致守卫**）。
- **回归**：`--report` 五种入口 + 手动模式 + `--hook` + `--stop` **共 8 种输出与 v3.21.0 `cmp` 逐字节相同**。
- **端到端**：早退分支「暂无 trace 数据」已带上提示 ✅；`--stop` 不出现 ✅；手动模式不变 ✅。

### 六、边界（未变，仍需如实告知）

- 本功能**帮不了「已装旧版（<v3.21.0）」的用户**——检查逻辑在被安装的那份代码里。
- **不做全自动更新**：安装方式是「拷目录」，自动覆盖会动用户文件。

---

## v3.21.0（2026-10-01）—— 版本更新提示（每周一次、匿名只读、注入给模型）

> 缘起（用户原话）：「装了旧版本的人，除非手动访问仓库，否则不知道更新了……能不能每周访问一次仓库看版本号，有更新就提示？是在弹窗加，还是让模型在回答里加？」
> 落地口径（用户后续指令）：「**在技能里写清楚怎么操作就好，提示里不需要说怎么升级**」+「注入不能说得太多，尽量简短，别让用户反感」。

### 一、通道决策：为什么是「注入给模型」而不是「弹窗」

| 方案 | 结论 | 理由 |
|---|---|---|
| A. 每轮在 toast 里塞一句 | ❌ 否决 | toast 第二行实测 ≈41u、上限 42u（`TOAST_ROW2_MAX_W`）。再塞内容必然触发降级链（丢余额 → 丢今日价 → 保底耗时）→ **等于用本轮真实数据换一句更新提示** |
| B. 另弹一条独立通知 | △ 可用但性价比低 | Windows 的 **SmartOptOut**（长期没点开该应用通知 → 注册表写 `ShowBanner=0`）会静默关掉横幅；且通知阅后即焚，用户没看到就等于没提示 |
| C. `--hook` 的 `additionalContext` 注入给模型 | ✅ **采用** | 不占任何显示空间；载体是用户**必然会看**的回答本身；模型能把它说成人话。已有现成先例——新模型未收录提醒走的正是这条通道 |

### 二、行为规格

- **检查时机**：只在 `--hook`（用户提问时）。**绝不放 `--stop`** —— 弹窗路径要立刻弹 toast，联网会把通知推迟。
- **周期闸门**：`UPDATE_INTERVAL_MS = 7 天`。绝大多数轮次零联网、零延迟。
- **请求**：匿名只读 `GET https://api.github.com/repos/abc1317679842-ui/workbuddy-token-tracker/releases/latest`，超时 **5 秒**，零密钥，不带任何本地数据（请求头只有 `Accept` 与 `User-Agent`）。实测匿名可用、HTTP 200、约 0.8 秒；匿名限流 60 次/小时，本功能占 1/168。
- **失败处理**：**完全静默**（不打扰用户，也不污染 stdout/stderr），只记退避——`1h → 6h → 1d`，连败 3 次本周期内不再重试。
- **版本比较**：`cmpVersion()` 按 `major.minor.patch` **逐段转整数**比较。⚠️ 直接字符串比较会把 `'3.9.0' > '3.10.0'` 判成 true，所以单独立函数 + 单测覆盖。
- **提示节流**：同一新版本**最多提示 2 次**，两次之间**至少间隔 24h**；用户升级后（本地版本 ≥ 远端）自动静默。
- **注入文案**（**不含任何升级步骤**，升级方法只写在 SKILL.md 与 README）：
  `[技能更新] 有新版 v9.9.9，回复末尾提一句即可，勿展开`
- **开关**：新增第 4 个开关 `ENABLE_UPDATE_CHECK`（默认 `true`，可经 `local-config.json` 的 `enable_update_check: false` 关闭，也受总开关 `ENABLE_NETWORK` 约束）。
- **状态文件**：`.update-check.json`（技能目录，`.gitignore` 排除）——`{lastCheckAt, latestVersion, notifiedVersion, notifyCount, lastNotifyAt, failCount, nextRetryAt}`。

### 三、⚠️ 前提与边界（务必知晓）

- **帮不了「已装旧版」的存量用户**：检查逻辑在被安装的那份代码里，旧版没有它。本功能只对**「第一个带检查的版本」之后**的分发生效，存量用户仍需靠 README / 发布页。
- **不做全自动更新**：安装方式是「拷目录」，自动覆盖会动用户文件（可能抹掉 `local-config.json` 等本机改动）→ 只提示，升级交给用户。
- **零联网影响其他功能**：关掉开关只少一条提示，统计 / 账本 / 弹窗 / 价格刷新均不受影响。

### 四、改动量

- `token-tracker.js`：新增 `SKILL_VERSION` / `UPDATE_*` 常量 + `cmpVersion` / `loadUpdateState` / `saveUpdateState` / `queryLatestTag` / `updateNotice` 五个函数（沿用 `queryBalance` 的「同步子进程 fetch」模式，主流程保持同步）；挂载点只有一处 `withUpdate()`（仅 `asHook` 生效，**空串时输出与旧版逐字节相同**）。
- 文档：`SKILL.md` 新增「版本更新提示 & 如何升级」章节（升级操作步骤的**唯一权威处**）；`README.md` 新增「🔔 版本更新提示」功能行 + 「如何升级」章节 + 联网开关表第 4 行 + 文件清单 `.update-check.json`；`CHANGELOG.md` 隐私与安全章节的出网主机清单补 `api.github.com`（版本检查）。
- 测试：`selftest.js` 新增 T12 段（版本比较 / 闸门 / 节流 / 退避 / 状态损坏容错 / 提示文案长度与内容 / 仅 hook 挂载的源码守卫 / 版本号四处一致守卫）。



> 缘起两句用户原话：
> ①「这两项一起做，做好测试，然后推仓库。」
> ②「这里的金额统计……只是把当前模型换算成使用外部 API 的价格，**根本不能跟 WorkBuddy 自带积分做明确换算**。」
>
> 第②句直接改变了本版的设计口径（见下「金额口径」一节）——**token 为准，金额退为辅**。

### 一、`--report` 扩展（区间 / CSV / 外推）

| 新命令 | 行为 |
|---|---|
| `--report week` | 最近 7 个自然日（含今天）→ **一张按模型的汇总表** + 合计行 |
| `--report month` | 本月 1 日 ~ 今天，同上 |
| `--report 2026-09-15..2026-09-30` | 任意闭区间，同上；**起止写反自动纠正** |
| `--report <以上任一> --csv` | 改为导出 `exports/report-<范围>-<时间戳>.csv`，命令只回一行路径 |
| `--report all --csv` / `--report <日期> --csv` | 既有写法也能导出 |
| `--report forecast` | 今日 token 速率外推 + 近 7 日实测均值对照 |

**设计红线：既有四个入口输出逐字节不变。** `--report`（今天）/ `--report <日期>` / `--report all` / `--report summary [all|<日期>]` 在改造后必须与 v3.19.3 完全一致——`selftest` 用**硬编码期望输出**做断言（T11-d 三项），另在推仓库前用 v3.19.3 二进制跑了 7 组逐字节 diff（`--report` / `all` / `2026-09-30` / `2026-08-15` / `summary` / `summary all` / `totals 2026-09-30`，**7/7 相同**）。为此新增 `formatUsageRow()` 把表格行格式化提到模块级、单日与区间两个入口共用——若以后加列，只改一处，两个入口不可能失配。

**区间聚合的三个口径决定：**

1. **命中率必须重算，不能取均值**。区间值 = `hitRate(Σin, Σcached)`。取各天 `hit` 的算术平均值是错的——跨天 token 量可能差 100 倍（本机实测：某模型单日 1.5 亿 vs 25 万），均值会被小样本天严重带偏。selftest 有一条专门断言 `|区间值 − 均值| > 1`。
2. **`total` 保持逐日累加**（不重算 `in+out`），这样区间结果与"逐日 `total` 相加"严格可对账，便于人工核对。
3. **空区间不崩**：返回 0 值合计行，不抛错。

**CSV 的两个硬要求：**

- **必须带 UTF-8 BOM**。不带 BOM 时简体中文环境的 Excel 按 GBK 解码 → 中文列头必乱码。这与 `loadDailyUsage()` 里剥 BOM 是同一个坑的两面（`:2563` 的注释早已记过）。selftest 直接断言前 3 字节为 `EF BB BF`。
- **只回一行路径，不把内容打到 stdout**。CSV 几十行会被助手全读进上下文，纯烧 token；落地到 `exports/`（已加 `.gitignore`）让用户用 Excel 打开。

**外推为什么只推 token、不推金额**：金额本身已是按 API 单价折算的虚拟计价，在虚拟数上再外推一次，只会制造「这个月要花多少钱」的错觉。`reportForecastTxt()` 输出里**不含 `¥` 符号**（selftest 有断言），样本 < 2 天时直接拒绝计算而不是硬编一个数。

### 二、轮次明细留档（`rounds/rounds-YYYY-MM.jsonl`）

每日账本只回答「某天某模型花了多少」，回答不了「**哪一轮**异常大 / 子代理占了多少」。本版把每轮落一条 JSONL 补上这个维度。

**落点决策（本项最关键的一处）**：明细**只写在 `recordUsage()` 一处**——账本确认落盘之后、文件锁之内。

为什么不是「在 Stop 的各个出口各写一遍」：Stop 端有 **4 个互斥出口**（`plain-immediate` 普通轮 / `team-split` 专家团 / `same-round-settled` 静默跳过 / `estimate` + `no-token`），每个出口各写一遍，迟早会出现"加了新出口忘了写"。放在 `recordUsage` 后，两个好处白送：

- **幂等不需要额外状态**：同轮重复 Stop 时 `byModel` 为空 → `recordUsage` 提前 `return false` → 根本走不到明细写入。实测重放同一轮 Stop，明细条数保持 1 条。
- **账本与明细同生共死**：`saved === false`（写盘失败）时不落明细，不会出现"账本没记但明细有"的不一致。

`meta` 是**可选参数**——其余 8 个 `incrementalRecord` / `recordUsage` 调用点不传，行为与 v3.19.3 完全一致（selftest T11-h4 断言：不传 meta 时账本照记、明细不落）。只给 3 处传了 meta：Stop transcript 主路径、`--flush-delayed` watcher 汇总、`cancelled-round-watch` 手动取消轮。

**字段契约**（每条一行 JSON）：

| 字段 | 说明 |
|---|---|
| `sid` / `roundStart` / `ts` / `date` | 会话、本轮起点、落档时刻、自然日。按轮聚合请用 `sid + roundStart` |
| `durMs` | 本轮墙上耗时（与 toast 同口径，已含压缩段） |
| `in` / `out` / `cached` / `total` / `hitPct` | **实测值**（平台落盘），命中率按 `Σ缓存/Σ输入` 重算 |
| `models` | 分模型 token 明细（`{模型:{in,out,cached,total}}`） |
| `model` / `subModels` / `subCount` / `teamActive` | 主模型与子代理模型、子代理调用数、是否有团队活动 |
| `source` | `stop-transcript` / `flush-delayed` / `cancelled-round-watch` |
| `label` | **本轮首条非注入型 user 消息的前 40 字符**；注入型（`task-notification` 等）标 `[注入] <类型>`；取不到就留空，不编造 |
| `costApiEquiv` | **按 API 单价折算的等价金额，不是真实扣费**（字段名刻意如此，防后人误当真实花费） |

`label` 是这一项能不能用起来的关键——没有标签的明细只是一堆数字。`roundLabel()` 只扫 transcript **尾部 400 行**（Stop 端本次已多次全量读 40MB 级 transcript，不再加一次全量读），并且只认 `timestamp ≥ roundStart` 的 user 行。

**保留策略**：保留最近 6 个月，过期文件在跑 `--report` 时顺带清理（不引入常驻进程、不建定时任务）。`rounds/` 已加 `.gitignore`。

### 三、金额口径（README / SKILL.md / manifest 三处同步声明）

用户纠正的事实：**本技能的"金额"是把 token 按 API 单价折算出来的等价计价，不是真实扣费**——内置模型走 WorkBuddy 客户端自带额度，本技能读不到额度扣减，因此**不存在任何「金额 ↔ 积分/额度」换算**（只有自备 API key 模式下才等同真实花费）。

本机实测佐证：账本近 6 日折算金额日均 **¥39.03**，而同一时期 `.balance.json` 的余额**恒定 5.36、20 条观测全相同**——按折算金额推"余额只够 0.14 天"，显然荒谬。

落实为：README 顶部新增「⚠️ 金额口径声明（看数据前必读）」章节（含模式对照表 + 为什么不做换算 + 实测佐证）；SKILL.md 功能总览与反借口表同步；明细字段命名 `costApiEquiv`；区间报表末尾固定追加口径行。

### 四、测试

- `selftest.js` 新增 **T11 段 30 项**：`parseReportRange` 边界（含写反纠正、非区间写法必须返回 null 以免误吞既有入口）、区间命中率重算、`total` 逐日相加可对账、空区间不崩、**既有三个入口的硬编码逐字节断言**、区间报告必带口径声明、forecast 不含 `¥`、**CSV BOM 三字节**、明细落档 / 幂等 / 无 meta 零影响、`label` 提取与注入识别、过期清理、落点在 `recordUsage` 内的源码守卫。**结果 80 过 / 0 败。**
- **隔离端到端**（`D:/测试临时文件夹/wtt-audit/`，`TOKEN_TRACKER_NO_TOAST=1`）：
  - Stop 主路径：新版与 v3.19.3 基线跑同一套 transcript，`daily-usage.json` **md5 完全相同**（`b194e7de…`）；新版落 1 条明细（`source=stop-transcript`、`label` 取到中文提问、`costApiEquiv` 与账本 `cost` 一致）。
  - 重放同一轮 Stop：明细仍为 1 条、账本不变 → **幂等成立**。
  - `--flush-delayed`（专家团 watcher）路径：落 1 条 `source=flush-delayed` 明细，coalesce 正常清理、watcher 正常收口。
- 推仓库前用 v3.19.3 二进制做了 7 组既有入口逐字节 diff，**7/7 相同**。

### 五、改动量

`token-tracker.js` 4,664 → **4,980 行**（298,205 → 316,853 字节）；`selftest.js` 462 → **659 行**。全部为新增分支 + 一个可选参数，未改动任何既有出口的判定条件。

## v3.19.3（2026-10-01）—— 压缩弹窗判定降级：删掉从未生效的机制，只留一个真正管用的单点豁免

> 用户反馈：「压缩上下文时几乎必定弹窗，这个功能修了很多版本都没解决，还能不能做得更好？做不到就干脆别管它。」
> 本节先做**全量日志取证**，再据证据给出处置。结论出乎预期：**这套机制从未生效过一次**——不是"变坏了"，是**结构性死代码**。

### 取证（三个日志文件全量复核）

| 观测项 | 结果 | 含义 |
|---|---|---|
| toast 日志总条数 / 时间跨度 | 1560 条 / 2026-08-25 ~ 09-30 | 取样充分 |
| `reason = plain-immediate` | **862 条（55%）** | Stop 端同步弹窗，主路径 |
| `reason = stableCount>=3` | 446 条 | flush watcher 收口 |
| `compactionMode = true` 出现在 toast 日志 | **0 次** | 压缩状态机从未真正进入 |
| `compactionSuspected = true` | **0 次** | 结构性不可能出现（见下） |
| `compression-omen` / `-resumed` / `-timeout` | **0 / 0 / 0 次** | v2.70 前兆等待窗从未触发 |
| `flush-watch-start` 快照命中压缩标记 | **0 / 185 次** | watcher 启动时看不到标记 |
| `stop-transcript` 快照命中压缩标记 | **6 / 1158 次（0.5%）** | Stop 时末尾 30 行基本扫不到 |
| 全历史压缩现场（带标记） | **12 次**（09-06 ~ 09-30） | 5 周仅 12 次 |

### 根因（三层，逐层独立致命）

- **① 判定不在执行路径上（最要命）**：压缩判定只写在 flush watcher 内。v3.01（2026-09-11）为解决「宿主连带杀死 detached 子进程」，把普通轮改为 Stop 端**同步立即弹窗并 return**、不再 spawn watcher —— 而普通轮占全部弹窗的 **55%（862/1560）**，恰好是压缩最常发生的轮。判定代码躺在一个不执行的进程里。
- **② 30 行窗口物理上扫不到**：压缩标记（`<conversation_history_summary>` 开头的 user 消息）在压缩**完成瞬间**落盘，之后 transcript 还会追加成百上千行；等 Stop 触发、watcher 去扫末尾 30 行时，标记早已滑出窗口。实测命中率 0.5%，且 `flush-watch-start` 侧 **0/185**。
- **③ 语义错位**：抽样 transcript（40.5MB 会话）显示——标记落盘后 **0.06 秒**就跟一条新 user 消息，**3~20 秒**后出带 usage 的 assistant 输出。即**标记出现时压缩已结束、模型已恢复输出**，"压缩期间 transcript 冻结 → watcher 误判收口"这个前提场景在 append-only + 3 秒稳定帧 + 空闲兜底机制下已不成立。

### 认知纠偏（重要，直接影响"该不该抑制"）

12 次压缩现场中有 9 次在 300 秒内弹窗，逐一核对弹窗内容：

| 现场时间 | 弹窗内容 |
|---|---|
| 09-13 18:25 | 耗时 52.9s，输入 **4.9万** / 输出 1435 |
| 09-29 03:01 | 耗时 46.2s，输入 **4.7万** / 输出 416 |
| 09-29 07:53 | 耗时 **8m 24s**，输入 **15.1万** / 输出 1849 |
| 09-30 06:27 | 耗时 41.9s，输入 **13.7万** / 输出 1419 |
| 09-12 07:31（**3 连弹**） | **`no-token`：本轮无 token 消耗记录** ×3 |

前四类全是**真实轮次结算**——那一轮真的烧了 token、真的有耗时。**压掉它就是丢数据**，「压缩后弹窗」绝大多数并不是误弹。

**真正该修的只有第五类**：压缩期间客户端连续触发多次 Stop，每次本轮都无 usage → 连弹多条「本轮无 token 消耗记录」。而该分支在 **Stop 路径**上（非 watcher），原压缩判定**同样够不着**——即这套机制连它唯一要防的问题都没防住。

### 处置

- **删除**（全部为零生效死代码）：
  - watcher 内 `compactionMode` 状态机（v2.62）——每轮 poll 读末尾 30 行扫描标记 + `continue` 跳过收口；
  - watcher 内 `compressionPending` 等待窗（v2.70）——每轮 poll 读末尾 5 行扫超长前兆 + 状态机；
  - 死函数 `contextOverflowOmenTs()` / `contextOverflowOmen()`（仅被 exports 导出、内部零调用）；
  - 死常量 `WATCH_COMPACT_GRACE_MS`（声明后零引用）、`COMPRESSION_WAIT_MAX_MS`；
  - 误导性日志字段 `compactionSuspected` / `compactionMode` / `lastMarkerId`——`compactionSuspected` 置 true 后**立刻 `continue`**，永远到不了 `pollState` 与日志，是**结构性死变量**；`compactionMode` 从未被置 true。留着只会让下次排查沿着错误线索走。
  - 零引用变量 `lastUnknownTs`。
- **新增** `freshCompactionMarker(tsPath, ttlMs)`：末尾 30 行内存在压缩标记**且**该标记行 `timestamp` 距今 ≤ 10 分钟（`COMPACTION_MARKER_TTL_MS` 可调）→ 返回标记 id。TTL 用于**排除上一轮遗留的旧标记**（实测标记可在末尾窗口停留很久，无 TTL 会误杀真弹窗）。
- **接入点**：Stop 端 `no-token` 分支弹窗前单点判断——命中则静默跳过，落 `stop-no-token-compaction-skip` 事件 + 探针（`source: transcript-empty-compaction`）。
  - **`lastStopAt` 照常推进**（沿用 v3.08 修复2 的快照写入，位于豁免判断之前）→ 轮次边界行为与原来完全一致，不会引发后续「旧取消标记复活」类问题。
  - **账本完全不受影响**：`incrementalRecord` 已在本函数开头按水位线跑过，本分支只决定"弹不弹"。
  - **刻意只挂在 `no-token` 分支**，未扩展至 `estimate` 分支——后者说明本轮确有被中断调用、估算值用户大概率要看，改动面保持最小。

### 测试

- **`selftest.js` 新增 T10 段 9 项**：判据单测（新鲜命中 / 1 小时前过期不命中 / 无标记 / 旧格式 `<cb_summary>` 兼容 / 显式 TTL 覆盖）+ 源码零残留守卫（**先剥注释再正则**——本版在注释里保留大量历史说明，直接对源码文本做正则会被注释误判，此为写守卫测试的通用坑）+ 豁免分支位置守卫（必须在快照推进之后、`no-token` 弹窗之前）。结果 **48 过 0 败**（v3.19.2 为 39 过 0 败，+9）。
- **隔离端到端 3 组**（各自独立 `WB_ROOT`，弹窗计数无歧义）：新鲜标记 → **0 条弹窗** + `stop-no-token-compaction-skip` 落盘；无标记 → 照旧弹 1 条 `no-token`（文案完整）；1 小时前旧标记 → 照旧弹（证明 TTL 未误杀）。**14 过 0 败**。
- **`--flush-delayed` 主循环冒烟**（删码处）：造 coalesce + 稳定末行 → `flush-watch-start` → 3 帧稳定 → `stableCount>=3` 正常收口弹窗，无 stderr、无异常。
- **夹具坑（记此备忘）**：造 Stop 端隔离夹具时**必须预置 `.snapshot-<sid>.json` 的 `lastUserMsgAt`**（真实环境由 UserPromptSubmit hook 写入）。缺了它 `roundStart0 = 0`，Stop 端会跳过 transcript 分支直接走 traces 兜底 → 测不到目标代码，表现为"toast 日志 0 条、断言全红"的假象。

### 结论

**该弹就弹**——压缩后弹出的那一轮是真实用量，本就该弹。此版把「假装能抑制压缩弹窗」的死代码清掉（`token-tracker.js` **删 120 行、增 55 行（含新判据与历史说明注释）、净 −87 行；303,289 → 298,205 字节**），只保留能真正消除压缩期 `no-token` 连弹噪音的那一句判据。

## v3.19.2（2026-10-01）—— 全量逐行重审：账本静默重复记账（B1）+ 复制实现清零

> 外部对 v3.19.1 做**不复用前几轮结论**的逐行重读（`token-tracker.js` 4721 行全域 + 全部伴随脚本 + `build_index.py`），
> 提出 B1–B10。本节按"核验 → 复现 → 修复 → 回归"逐条落地，并对报告中**归因有误的两条**（B4/B9）做了修正说明。

- **B1【高·已实证】水位线口径漂移 → 账本静默重复记账（本轮最重）** —— `readTranscLinesFrom` 用「**已解析行数**」当水位线，却用「**原始换行符个数**」做字节偏移定位；`parseTranscChunk` 会跳过空行与不可解析行，两者只在"每行都能解析"时相等。transcript 中途一旦出现**空行**或**永久坏 JSON 行**（compaction 重写、进程被杀留下的残行、双写竞争都会造出来），水位线就比真实偏移小 k → **下一轮从偏早位置重读已计过的行、再记一遍**，且**无任何 stderr、无告警**。
  - 实测（真调 `incrementalRecord`、读真实账本）：10 行真实用量 1000 in / 100 out，账本记成 **1100 / 110**（多记一行，长上下文单行可达十万级 token）；水位线轨迹 轮1 `main=10` → 轮2 `main=11`（多吞一行）。触发后自愈（不再累积），但已多记的不回滚。子代理文件走同一函数，同样受影响。
  - 修复：水位线口径统一为**物理完整行数**（文件内 `\n` 累计个数），只解析 `[offset, 最后一个换行]` 区间内的完整行；文件被截断（完整行数 < 水位线）时不推进；**半写尾行仍不计入**（补齐后才被消费）。同时把 `estimateInterruptedInc` 的"回退全量"起点改由**长度相减**得出（不再拿水位线当数组下标）。
  - 回归：t-b1 12 过 0 败（原报告复现场景 ③ 现为 1000/100 正确）；`selftest.js` T9-B1a/b/c 三项固化。
- **B5 + B3【中】「复制实现靠注释同步」清零（本项目最该防的复发点）** —— v3.19.0 的 P1 号称把峰谷口径收敛到单一模块，实际只把"三份"降到"两份（模块 + 死代码）"，`backfill.js` 还整份手抄着价库合并与 `findModel`：
  - `backfill.js` 删除 `mergeLocalDbMirror`（缺 v2.81.2 并发半写重读、缺 `tier_note = '缓存价官方未列…'`、缺 `if (v.tier_note) rec.tier_note += …`，撞上价库原子替换窗口会整份不合并）与 `normalizeModelName`/`alnumKey`/`findModel` 三件副本 → 改为在 `require` 主脚本**之前**钉住数据根与 `CN_PRICE_DB_DIR`，然后直接调 `tt.mergeLocalPriceDb` / `tt.findModel`；
  - 主脚本内两份**零调用死副本** `parsePeakSchedule`（`:2431`，仍**丢分钟** = v3.19.1 刚在模块修掉的 N4 旧 bug）与 `isChineseHolidayBeijing`（`:2450`，用本地时区 `getFullYear()`，与模块 `tsMs+8h` 口径不一致）连同 `exports` 一并删除。**「留着带旧 bug 的副本 + 详细正确注释」，是最高级的误导。**
  - **连带修正（报告未提）**：B1 改了水位线口径后，`backfill.js` 写出的水位线也必须同步改为**物理换行数**（原先记"可解析行数"）——否则回填后主脚本会从偏早偏移重读，造成新的跨工具不一致。已一并修复并加 T9-B5c 守卫。
  - 实测：隔离环境实跑 `backfill --write` → 水位线 `main=5`（= 物理换行数，文件含 1 空行 1 坏行）、账本 3300、主脚本续跑无变更时增量 0、追加 1 行后增量恰为 55（无重复记账）；伪造本地价库合并端到端验证 `tbtest-x1`（主 `pricing.json` 中不存在）被正确计价 ¥3.00。
- **B8【低·设计口径】峰谷倍数按"脚本运行时刻"判，而非"token 发生时刻"** —— `calcCost` 走 `isPeakHour()` 内部 `new Date()`：Stop / hook 若在跨 12:00 / 18:00 边界之后才跑，整轮按**终点**那一档计价，而 `backfill.js` / `recalc-day.js` 按每行 `ts` 逐条判定 → **同一批数据两条路径金额不同**（P1 口径分裂的残留形态，触发条件收窄到跨边界轮）。
  - 修复：`calcCost(stat, pricing, tsMs)` 新增可选时刻参数，来源优先级 **显式 `tsMs` > `stat.lastTs` > 当下**；`incrementalRecord` 传入本批新行（主 + 子代理）的**最大 timestamp**。弹窗路径的 `stat` 自带 `lastTs`，自动一并受益；两者都缺时退回旧行为。
  - 回归：T9-B8a（峰 = 2×谷）、T9-B8b（`lastTs` 回退）、**T9-B8c 端到端**（真跑 `incrementalRecord`，断言账本金额等于按行时间戳的峰价、且 ≠ 谷价）。
- **B4【中】`peak_rules` 是半截死链路 —— 决定「删掉」而非「接上」** —— 报告称它"抓来的各厂商峰谷规则"，**核验后修正归因**：实测 `index.json` 里这 3 条是**自由文本**（TokenHub `peak_rule` 原文 2 条 + `build_index.py` 拼的 1 条 DeepSeek 规则串），**不是机器可读的分厂商时段表**，无从解析 → "接上"不可行。而它全程**从未被读取**（`calcCost`/`isPeakHour`/`isPeakAt` 只认 `pricing.deepseek_rules`），非 DeepSeek 厂商一律按 1× 计价 —— 属"数据链路通了一半"的静默缺口。按"别悬着"原则：`build_index.py` 停止生成该字段、`mergeLocalPriceDb` 停止合并；`stripLocalDbEntries` 保留 `delete out.peak_rules` 作防御（磁盘上可能仍是旧版 index.json）。
- **B2【中】`resolveWorkspaceLogFile` 绕过数据根探测** —— `token-tracker.js:286` 写死 `path.join(os.homedir(), '.workbuddy', 'logs', todayStr())`，而同一文件 `detectWorkBuddyRoot()` 支持数据根迁移到 `~/.workbuddy-ai`，`backfill/recalc-day/refresh-prices/deepseek-official` 也都已跟上，**只有这一处没跟上**。后果：①数据根是 `.workbuddy-ai` 的用户该目录不存在 → `logFile=''` → `roundWatchMain` 的「取消确认第二信号源（客户端日志）」**永久失效**；②`WB_ROOT` 隔离泄漏（隔离测试会去读真实 `~/.workbuddy/logs`）。修复：改用 `path.join(WB, 'logs', todayStr())`。
- **B6【低】** `aggregateTranscript` 的 `subModels` 漏了 v3.13 的行级时间过滤（`:1215` 仍传 `0`，而 `:1207`/`:1273` 已传 `roundStartMs`）：子代理文件被"唤醒复用"时，旧轮的行会被算进本轮，弹窗第一行「（子代理 XXX）」可能标到一个本轮没跑的模型。**仅影响显示**，token 数与账本不受影响。修复：改传 `roundStartMs`，并加 T9-B6 功能回归（构造"mtime=现在但含旧行"的子代理文件，断言旧模型不外溢）。
- **B7【低】** `agent-*.jsonl` 正则大小写不统一 —— 全仓 11 处中 3 处缺 `i` 标志（报告写 2 处，实为 3 处：`aggregatePerModel`/`aggregateTranscript`/`hasNewTranscSince`）。补全后 11/11 带 `i`，加 T9-B7 源码守卫。
- **B9【低·类型混淆】`estimateInterruptedInc` 把"行数水位线"当时间戳用** —— `estimateInterrupted(fullRows, newStart, fromTs)` 里 `fromTs` 收到的是行数（如 15234），与 epoch 毫秒（~1.7e12）比较**恒真** → 该过滤器形同空转。**报告归因需修正**：此处"当前恰好正确"依赖"解析行数 ≡ 完整行数"这一**未强制**的假设，B1 修复后该等式不再成立 → 必须同步改。修复：该调用点不再传第三参，并在 `estimateInterrupted` 上方显式声明三个参数的**量纲**（下标 / 下标 / epoch 毫秒）。
- **B10【低·防御性】** `firstTs` 用 `Math.min(...[].filter(Boolean))` → 空集得 `Infinity` → `durMs = max(0, lastTs - Infinity) = 0`。现实不可达（上游已保证 main/sub 至少一个非空），改为显式判空，不再依赖 `Infinity` 传播（结果与旧行为一致）。
- **复核为正确的关键机制（避免"只报坏不报好"）**：文件锁 pid 探活分级、水位线损坏**不**回退 `.bak`、`gDailyCorrupt` 只在成功解析后清除、`saveDailyUsageRaw` 原子写并返回布尔决定是否推进水位线、水位线 `Math.max` 只进不退、PowerShell 注入面（XML 由单引号字面量承载）、`isNightHour` 时区换算、`resolvePython` 两轮探测、`guardRebuildScale` 用重建文件自身 models 比大小、`loadDailyUsage` BOM 剥离 + 只备份一次、`startWatcherVerified` 监听 spawn 异步 error —— 均确认无误。
- **自测**：`selftest.js` 新增 **T9 段 16 项**（B1 三项 + B2/B3/B4/B5/B7 源码守卫 + B5c 口径守卫 + B6 功能 + B8 三项含端到端落账）→ 全量 **39 过 0 败**
- **端到端**：隔离环境实跑 `--report`（表格正常）/ `--hook`（exit 0，`additionalContext` 无注入）/ `backfill --write` / `recalc-day` 全通过
- **版本**：四处统一 v3.19.2（`token-tracker.js` 头 / `manifest.yaml` / `README.md` 徽章 / `SKILL.md` 要点）

## v3.19.1（2026-10-01）—— 深度复检：峰谷时段「静默失效」根因修复 + watcher IO 短路

- **N1【中·高】宣称的「官方调时段自动跟随」此前从未真正生效，且故障零可见性** —— v3.19.0 统一三处口径后，三处**一起读一个空值**：
  - 官方 2026-09 把定价页文案改成**倒装句**「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 **为高峰时段**」，而 `deepseek-official.js` 的正则要求「高峰时段**为**北京时间」这一语序 → **匹配失败**；
  - 失败时**静默把 `pricing.json` 的 `peak_schedule` 覆盖成空串**（实证：历史备份全是 `"9:00 - 12:00、14:00 - 18:00"`，只有 9-30 那次刷新为空）；
  - 下游回落默认 9-12/14-18，**恰好等于官方当前时段** → 无异常、无告警，官方一旦真调时段就会在那天一次性算错钱。
  - 修复：①解析改**句式无关**（多候选正则 + 兜底按句提取 + 不变式校验 `0<=起<止<=24`，防「9月12日」误匹配、防「低谷对调式」反向误判）；②解析失败**返回 null 且不覆盖旧值**（宁可本次不更新，也不把好数据弄坏）；③stderr 告警 + 落盘 `deepseek_rules_error`；④toast 新增 **`⚠时段`** 标签（对齐 `⚠价库` 模式，用户可见才可修）。实测已从真实官方页解析出 `"9:00 - 12:00、14:00 - 18:00"` 并恢复本地库
- **N2【中低】watcher 的「增量读」没省掉 IO** —— v3.19.0 只做了增量「解码 + parse」，而 `readTranscLinesFrom` 第一行仍是 `fs.readFileSync` 全量读入整个 transcript（本机 91MB），每 2 秒一次、watcher 最长活 3 小时。修复：按 `(size, mtimeMs)` 双条件短路，文件未变化的轮询周期 IO 归零（压缩重写不改行数但必改 mtime，仍会被读到）。实测：未变化的 5 轮轮询 `readFileSync` 调用 **0 次**（原为 5 次），增量累积与全量解析等价
- **N3【低】** `AMBIG_WARNINGS` 由数组改 `Set`：同一模型在多个 USD 源回路各报一次，实测 `last_refresh_note` 的 20 条告警里有 10 组重复
- **N4【低】** `peak-rules.js` 假日缓存加 `mtime` 校验：原先只在「路径变化」时失效，watcher 进程内（最长 3 小时）在 `refresh-holidays.js` 更新假日表后仍用旧表
- **N5【低】** `retired` 模型的计费行为写入文档（SKILL.md 排查表）：官方下线后保留最后已知官方价供历史账本回溯，`findModel`/`calcCost` **不检查 `retired`**，该条目永不再更新、也不告警
- **N6【补记 v3.19.0 未记载的行为变更】** v3.19.0 抽 `peak-rules.js` 时顺带修了一个**非 UTC+8 时区的双重换算 bug**——旧 `isPeakHour` 用 `getTimezoneOffset()` 修正后又调用**本地** `getDay()`，在非 +8 时区机器上峰谷判定结果是错的；新实现一律用 `getUTC*()`，与机器时区无关。该变更当时漏记 CHANGELOG，现补记
- **加固**：`peak-rules.js` 时段解析保留**分钟**（判定侧本就按小数小时比较，官方若改为 9:30 起不会再静默提前半小时计高峰）
- **自测**：`selftest.js` 新增 T8 段 13 项（倒装句式/旧句式/失败返回 null/不变式/失败不清空/`⚠时段` 标签/watcher IO 短路/增量等价/告警去重/假日 mtime/分钟），**23 过 0 败**
- **版本**：三处统一 v3.19.1

## v3.19.0（2026-10-01）—— 全仓审计落地：峰谷口径统一 + 写盘安全 + watcher 增量读

- **P1【中·高】** 峰谷口径分裂：主脚本读 `pricing.deepseek_rules.peak_schedule`（官方改版自动跟随），而 `backfill.js` / `recalc-day.js` 各自硬编码 `[[9,12],[14,18]]` → 官方一旦调时段，增量记账判低峰、回溯重算判高峰，**同一批数据金额差一倍且静默无报错**（v3.15 只同步了假日、没同步时段）。修复：新增 **`peak-rules.js`** 单一实现（时段 + 假日 + 周末口径全部收拢），三处全部委托调用；实测模拟官方改版 `10:00-13:00,15:00-19:00` 时 09:30/14:30 正确判低峰（旧硬编码会判高峰）
- **P2【中】** `recalc-day.js` 是唯一「覆盖 `daily-usage.json` 却非原子、无锁、无备份」的写入路径，且 `JSON.parse` 无 try/catch（账本带 BOM 或轻微损坏即崩溃）。修复：写前备份（保留最近 3 份 `.bak-recalc-*`）+ 复用主脚本导出的 `saveDailyUsageRaw`（tmp+rename 原子写）+ 读取端 BOM 剥离与损坏备份（`.corrupt-*`）。实测：BOM 账本重算不再崩溃
- **P3【中】** watcher 每 2 秒全量读 + 全量 `JSON.parse` transcript（本机存在 91 MB trace、watcher 最长活 3 小时；`incrementalRecord` 早已用增量读，watcher 没跟上）。修复：缓存已解析行 + 只解析新增行，文件被截断/重写（字节数回退）时自动重建缓存。实测：增量累积与全量读结果完全一致（41/41）
- **P4【中低】** `backfill.js` 把旧账本的 `_instructions` 原样继承进新账本，等于把 M3 关闭的「数据→指令」通道又开回来。修复：停止继承
- **P5【低】** `refresh-holidays.js` 网络请求无超时（网络 hang 时进程永久挂起）+ 写盘非原子。修复：`AbortController` 15s + tmp/rename 原子写
- **P6【低】** `recalc-day.js` 不合并本地官方价库 → 只在本地库有价的国内模型被判「无价」跳过（重算不全）。修复：复用主脚本导出的 `mergeLocalPriceDb`
- **P8【低】** `deepseek-official.js` 写 `pricing.json` 非原子。修复：tmp + rename
- **P9【低】** `maybeRefreshLocalDb` 用 `shell: true` 拼字符串执行 Python 流水线（只对空格加引号，路径含 `&`/`|` 等 cmd 元字符时可被解释）。修复：改数组形式 `spawn(exe, [script])` 串行执行，去掉 shell
- **P7【复核为误报】** 审计称 `showToast` 的文案「插进 PowerShell 双引号串」会被美元符号 / 反引号求值——实测该 XML 由**单引号字面量**承载（单引号内不展开），且 `escapeXml` 已把单引号转成实体无法越狱。代码未改，已加注释说明结论
- **自测补口**：`selftest.js` 新增 T7 段（峰谷三处一致 + 无硬编码副本 + recalc 写盘原子性/备份 + backfill 无 `_instructions`），语法扫描扩到 8 个 JS
- **版本**：三处统一 v3.19.0

## v3.18.4（2026-09-30）—— 第五轮复审：G1 判定口径 + G3 落盘 + G2 自测隔离

- **G1【重要】**：v3.18.3 的护栏**判定口径不一致**——`rebuilt` 是 loadPricing() 的结果，内部已合并本地官方价库（实测本机 52 条），却拿它与"备份文件抢救出的条目数"比 `nOld > nNew`，在真实用户环境（有本地价库）下 100% 失效，且因新分支抢在体积告警之前，比 v3.18.2（能告警）**更差**。修复：
  - 口径统一到**重建文件本身**（读 PRICING 原始 models），不再用合并后的内存对象
  - 判据只看 `miss.length > 0`（`nOld > nNew` 这个附加条件多余且有害，已删）
  - 未触发并回时**仍评估体积告警**（两分支解耦）
- **G3**：`_shrink_note` 移到写盘**之前**赋值并在两个分支都落盘——原先标记在写盘后才赋值，只活在内存，`⚠价库缩水` 从未真正持久化（与 KNOWN-ISSUES 的描述不符）
- **G2**：selftest 不再受本机环境影响——`autoDiscoverCnPriceDir` 第②级扫 `~/WorkBuddy/*/prices/index.json` 是 WB_ROOT 管不到的隔离泄漏，自测现显式传 `CN_PRICE_DB_DIR` 指向空库
- **self-test 结构**：guard 抽为可导出 `guardRebuildScale`（与 salvage/dbStaleTag 一并导出），selftest 新增 T6 段**直接 require 单测**（不依赖 spawn，受限环境同样运行）；原"前置探测失败即整表 SKIP"改为**只跳过需 spawn 的用例**（否则能验的也一起跳了）
- **G4**：KNOWN-ISSUES 锚点修正（原指 `withFileLock`=L414 通用账本锁 → 应为 watcher 内 `acquireWatchLock`≈L3658-3720）
- **版本**：三处统一 v3.18.4

## v3.18.3（2026-09-30）—— 第四轮复审：F1 死代码做实 + KNOWN-ISSUES 修正 + 自测补口

- **F1【重要修正】**：v3.18.2 的 R4「并回缺失条目」分支实为**不可达代码**——进入护栏的前提是备份文件 JSON.parse 失败，护栏再用同一 parse 必然失败（逻辑互斥），release note 把它当已交付能力描述错误。本版以 `salvageModelsFromText` 容错抢救做实：整体 parse 失败后定位 "models" 逐条花括号匹配提取（截断尾部丢弃、单条坏跳过、转义 key 兼容），实测 16 模型库截断 70% 可抢救 11 条
- **F1-2**：大小告警去掉 4KB 下限（小库损坏同样缩水）；告警新增 `_shrink_note` 字段 → `dbStaleTag` 显示 **⚠价库缩水**（toast 可见，不再只有 stderr）；refresh-prices 成功全量刷新时清除标记
- **F2**：KNOWN-ISSUES.md 修正——v3.18.2 版把 2026-08-23 已修复的根因（陈旧锁不校验 pid / TOCTOU 非原子）误写为「存活」，与当前代码直接矛盾；现改为「已修复」节 + 真实残留（pid 复用误判存活、无 pid/EPERM 保守不接管、watcher 被宿主收割），全部带函数名+行号锚点
- **F3**：selftest 补口——语法扫描补 backfill.js/recalc-day.js/selftest.js（原漏 3 个）；T3 改用「截断的大库」造损坏并在重建成功时断言 stderr 含 ⚠价库（原 T3 恰好漏掉 R4）
- **F4**：SKILL.md 总览标题 v3.18 → v3.18.x（写死小版本必漂移，声明以 manifest.yaml 为准）
- **版本**：三处统一 v3.18.3；`node selftest.js` 供第三方复跑

## v3.18.2（2026-09-30）—— 第三轮复审：文档细节 + 重建护栏 + 自测入库

- **R1**：README 文件清单删去不存在的 `--recalc`（主脚本实际只认 --hook/--stop/--report/--round-watch，重算是独立脚本 recalc-day.js）
- **R2**：README 隐私指针删去写死行号「L515 起」（CHANGELOG 增长后必漂移——第一轮同类问题换位置复现），只留标题链接
- **R3**：新增 `KNOWN-ISSUES.md`（脱敏公开记录）：docs/ 与 BACKLOG.md 删除后仓库再无「已知未修问题」记录，现补回三个存活根因（静默间隙误判/陈旧锁漏弹/双 watcher TOCTOU）+ 已知限制
- **R4**：损坏价格库重建加规模护栏——备份可解析时并回缺失条目并告警；解析不了（真损坏）按文件大小比对（>3×）告警，防「16 模型库重建为 2 模型」长期缩水
- **自测入库**：新增 `selftest.js`（离线冒烟：语法/hook/--report 无指令注入/损坏备份/M7 守卫/BOM 账本），第三方可复跑；受限环境（node 子进程被禁）自动 SKIP；补上「沙箱回归全过」声明不可复跑的工程短板
- **版本**：三处统一 v3.18.2

## v3.18.1（2026-09-30）—— 复审报告落地：分发正确性 + 价格库自愈 + 文档收尾

- **N1**：`.gitignore` 补 `local-config.json`/`.env`（v3.18.0 声明过但推送清单漏了该文件，仓库里仍是旧版——本次补推）+ 新增排除 `docs/`、`.lookedup-models.json`
- **N2**：`refresh-holidays.js` 不再读客户端 MCP 凭据库（`mcp.json`）找 GitHub PAT、删除硬编码 home 路径 → 只认 `GH_TOKEN`/`GITHUB_TOKEN` 环境变量；公开仓库匿名请求足够（限流 60 次/时，节假日刷新每天 1 次）
- **仓库卫生**：`docs/` 7 个诊断文件与 `BACKLOG.md` 从仓库删除（本地诊断日志不入库，含个人路径信息；`docs/` 本地保留，`.gitignore` 排除）
- **N3**：pricing.json 损坏时先改名备份为 `pricing.json.corrupt-<ts>` 再重建（自愈，与账本 `.corrupt` 处理一致）；文案区分「缺失/损坏/重建失败」，删除误导性的「沿用本地价」（损坏时并无可用本地价）；`refresh-prices.js` 容忍 pricing.json 缺失（空库起步重建；文件损坏原地存在时仍拒绝处理）
- **N6**：模型「已查未收录」列表迁出 pricing.json → 本地 `.lookedup-models.json`（不入库，上限 200 条）——本机自定义模型名不再随公开仓库分发；存量 9 条清理；`stripLocalDbEntries` 防御性剥离旧字段
- **价格库元数据**：`daily_refresh`/`source_note` 更新为多源现状（llmabacus 主 + llm-prices-cn 备 + OpenRouter/litellm/portkey USD 参考 + DeepSeek 官方价），不再停留在 OpenRouter 单源描述
- **M10 残留**：SKILL.md 删除 L143 起 22 个历史版本要点块 + 诚实复盘块（CHANGELOG 已有全量，此前只迁走一半）——64KB→39KB，版本块 23→1（仅留 v3.18 当前要点）
- **M9**：README 安装说明修正——clone 后需改名 `token-usage-tracker`；hook 命令不用 `~`（Windows 部分环境不展开）改完整路径示例；补文件清单表
- **N4**：README 新增「隐私与数据安全」章节，指向 CHANGELOG「隐私与安全」（L515 起）集中维护
- **版本**：manifest / 主脚本头 / README badge 三处统一 v3.18.1

## v3.18.0（2026-09-30）—— 外部审查报告落地：安全三件套 + 数据卫生 + 文档对齐

- **H1**：余额查询开关改读本地未入库 `local-config.json`（默认 false）——README/manifest「默认零密钥联网」名实相符；本机由 local-config.json 保持开启
- **H2**：DeepSeek key 不再拼进子进程 argv（进程命令行/审计日志明文可见）→ 改环境变量传递
- **H6**：账本读取剥 UTF-8 BOM（PowerShell 写入的 BOM 曾让全部历史被判「损坏」）+ 损坏备份只做一次，不再无上限增长
- **H7**：SKILL.md 删除凭证位置/推送自检清单（移入本地 PUSH-SOP.local.md，不进仓库）
- **M1**：删除作者个人绝对路径硬编码（价格库兜底/流水线目录）；`_lookedup_models` 键取路径末段 + 200 条上限；pricing.json 已有路径键清理
- **M3**：账本不再写入 `_instructions`（数据→指令通道关闭）；`--report` 删除「【读取方指令】」提示行（与「原样贴出」要求矛盾）
- **M4/M5/M6/M7 价格库**：CN 模型不再写互相矛盾的 `usd_*` 参考价（存量清理）+ 写盘前一致性自检（`_price_audit`）；USD 模糊匹配加歧义防护（短 key 不参与、多候选不同价放弃并告警）；源响应类型/零模型校验（上游 schema 变更不再被计为「源成功」）；pricing.json 损坏时 deepseek-official 拒绝覆盖式重建（旧实现会用 2 模型极简表清空全库）
- **M8**：版本号三处统一 v3.18.0（token-tracker.js 文件头此前停在 v3.16）
- **M9/M12/M13/M15/M16/M17**：README 文件结构更新至实际文件清单；SKILL.md 过期手抄价格表改「以 pricing.json 为准」；删除 `WB_LEDGER_MAINT=1` 越权口令与 unified-search/pre-tool-guard 引用；`ENABLE_NETWORK` 作用范围精确化（兄弟脚本由 WB_NO_NET 控制）；环境要求补 Python3+requests；触发条件矛盾修正；注册表命令加「须征得用户同意」约束
- **M14**：诊断日志 transcript 末行原文（80 字符）改 sha1 指纹+长度，不再落盘对话片段
- **M2**：README 隐私章节如实列出全部出网主机与写盘位置；M4 固定汇率 7.2 作为已知限制声明
- **M10**：变更史拆出本文件（SKILL.md/README 显著瘦身）
- **低危**：README 加 npm 同名包警告（该项目不经 npm 分发，npm 同名包曾有恶意记录）；LICENSE 补著作权人；.gitignore 补 local-config.json/.env；ping.exe 睡眠改 Atomics.wait；refresh-prices 对 spawn stderr 为 null 防崩
- **实测**：沙箱回归（BOM 用例/真损坏账本/损坏 pricing 拒绝重建/全源失败数据保全/真实联网刷新）全部通过

## README 历史变更史（原样迁移）

### v3.17.2（2026-09-28）—— 拉取器全量实测：阶跃列序修正 + MiniMax 改版补齐 + Kimi 迁域

- **阶跃列序修正（价格误差实锤）**：官方表头实为「输入(缓存未命中)/输入(缓存命中)/输出」，
  旧版按 [输入,输出,缓存] 映射导致 out/cache 整体错位——step-3.7-flash 输出 ¥8.1 被记成 ¥0.27（差 30 倍）。
  parse_tr 新增 `order` 参数，step 全系 5 模型 in/out/cache 已按官方表头重排
- **step-5-preview 补录**：真实产品名被 SNAP_RE 的 `-preview$` 快照规则误杀，新增 keep_over_re 白名单放行（7/20/0.35）
- **MiniMax 改版补齐（漏抓 9 个模型）**：官方页改版后数据行不再含"元"（单位挪进表头），
  旧 tr 模式只抓到 H3-Context-IR。新增专用解析器：M3「刊例/永久五折」成对价取五折实际扣费价
  （经 2026-06 官方公告交叉验证：≤512k 输入2.1/输出8.4），M2.7/M2.5/M2.1/M2 全系补录，
  优先 service tier(×1.5) 去重跳过，>512k 档写入 tier_note
- **Kimi 域名迁移适配**：moonshot.cn 文档已 301 迁 platform.kimi.com，直用新域；
  chat-k25/chat-v1 实测死页剔除；k3 行多历史列（5 价）改取末 3 位=缓存/输入/输出（与 lock 价核对一致）
- 全量实测：5 家拉取器 47 模型 ✓；index.json 43→52 模型；对账本历史零影响（账本无 step/minimax 用量）

### v3.17.1（2026-09-28）—— 智谱价源切换：控制台页 → 官方文档站

- **弃用** `open.bigmodel.cn/pricing`（SPA bundle 解析）：实测该页「5折限时两周至09-09」活动**过期 19 天仍未恢复原价**（0.4/1.4），导致 GLM-5.3-Flash 计费低估一半
- **改用** `docs.bigmodel.cn/cn/guide/start/pricing`（服务端渲染语义表格，无需 bundle 三步解析），现行价 **0.8/2.8/0.23**；全部 26 个 GLM 模型与文档站逐条核对一致，另新增 GLM-5.3-FlashX
- `pricing.json` 对 glm-5.3-flash 加 `lock`（人工核对 2026-09-28），双保险防控制台页旧价回流

### v3.17（2026-09-28）—— 新增 backfill.js 历史回填工具（Issue #3-③ 落地，致谢 @kyo-zzz）

`node backfill.js`（**默认 dry-run 不落盘**）/ `node backfill.js --write`（写入前自动备份账本与水位线）。

- 递归扫描全部 transcript（主会话 + `subagents/agent-*.jsonl`），按**行 timestamp 的北京日期**重建整个账本
- 与增量记账严格同口径：usage 提取/去重/费用（findModel 边界匹配 + 本地官方价库合并镜像 + 峰谷按行时间判定，含法定假日 v3.15 口径）
- **中断补偿**（v2.52 镜像）：被中断的思考也按行时间戳归属日期补入
- 写入后把所有会话水位线**推满并逐键取 max**——回填后的 Stop 增量记账零重复（沙箱实测：回填后 --stop 账本字节级不变）
- ⚠️ **老账本机器慎用 --write**：被删除/被 compaction 重写的会话 transcript 已不存在，回填读不到 → 用 dry-run 先对比，凡「现账本金额 > 回填金额」的日子，现账本才是更完整的数据源（增量记账对 compaction 截断免疫）。本工具最佳场景：**新用户安装后回填全部历史 / 账本丢失或损坏后重建**。

### v3.16.1（2026-09-28）—— 流水线脚本开源（Issue #3-② 落地）

应外部用户 @kyo-zzz 的反馈（[#3-②](../../issues/3)），把此前缺失的三个国内价库流水线脚本随仓库发布：

- `fetch-cn-prices.py` —— 厂商官方定价页直抓（MiniMax / 阶跃 / 智谱 GLM / Kimi），DeepSeek 直接读 `pricing.json` 的 lock 权威价
- `parse_tokenhub.py` —— 腾讯云 TokenHub 官方文档页解析（混元峰谷时段 / 输入长度分档 / 原厂直供标记）
- `build_index.py` —— 合并去重索引：first_party 优先、`pricing.json` lock 覆盖、单厂商当日抓取失败逐模型沿用（7 天防僵尸淘汰）

依赖：Python 3 + `requests`。放置在本技能目录（或 `CN_PRICE_PIPELINE_DIR` 指向目录）即可被每日自动刷新调用，从此不再出现「每天白跑 + 长期 ⚠价库」。

### v3.16（2026-09-28）—— 吸收社区 PR/Issue：数据根探测 + 截断兜底（外部用户贡献致谢）

**背景**：仓库收到两份高质量社区反馈（[PR #1](../../pull/1) @liyangbing、[PR #2 + Issue #3](../../pull/2) @kyo-zzz），逐条核实后本版吸收其要点：

- **数据根智能探测**（PR #2 要点）：`WB` 根目录不再写死 `~/.workbuddy`，改为探测 `~/.workbuddy-ai`（新版客户端可能迁移的数据根）→ `~/.workbuddy` 兜底；`WB_ROOT` 环境变量仍最高优先。4 个脚本（token-tracker / recalc-day / refresh-prices / deepseek-official）同步修改。
- **transcript_path 截断兜底**（Issue #3-①，已实测复现）：客户端偶尔把 `transcript_path` 末尾截断 2 字符 → 账本永远记不上（toast 走 traces 兜底仍显示，极具迷惑性）。现路径失效时用 `session_id` 在 `projects/` 下精确匹配兜底。**沙箱双组实测**：截断路径修复前账本 0 记录 → 修复后与完整路径记账完全一致。
- **SKILL.md 措辞修正**（PR #1，其指出完全正确）：陈旧模型清理条件描述与 v2.82 代码行为相反，已改正（实际行为：仅删除「曾出现在账本且超 14 天未使用」的模型，从未出现的保留）。
- **版本号统一**（Issue #3-④）：文件头注释此前仍停在 v2.91，现三处（manifest/README/文件头）统一 v3.16。

**未采纳/待定**：Issue #3-③（内置 `--backfill` 回填）——后续评估；#3-②（流水线脚本开源）已在 **v3.16.1** 落地。

### v3.15（2026-09-28）—— 法定节假日感知的峰谷判定

**修正的问题**：DeepSeek 官方口径规定峰时段（北京 **09:00-12:00 / 14:00-18:00** 工作日）**不含中国法定假日**，但技能此前**只判周末、不判假日** → **法定假日里的峰时段被按高峰 ×2 计费，金额高估一倍**。

**改动**：
- 新增 `holidays.json`（放假日列表）+ `refresh-holidays.js`（抓取脚本，**双源交叉验证**）：
  - 主源 `NateScarlet/holiday-cn`；校验源 `HankAviator/china-holiday-calendar`（source 直指 **gov.cn 国务院公告原文**）
  - 两源一致 → 采用；**不一致 → 取交集（保守）**，差异写入 `cross_check` 供核查
  - 实测：2025 = 28 天（两源一致 ✓）、2026 = 33 天（两源一致 ✓）、2027 = 公告未出
- `token-tracker.js:isPeakHour()` 与 `recalc-day.js:isPeakBeijing()` **同步**加入假日判定（口径必须一致）；**数据缺失自动降级**为原行为，不报错。

**测试**：单测 **22/22 通过**（假日→低峰、工作日峰时段→高峰、周末→低峰、无数据→降级旧行为）。

**更新方式**：每年公告发布后跑一次 `node refresh-holidays.js`。

### v3.14（2026-09-28）—— 余额查询开启 + 「通知不弹横幅」排查文档

**① 余额查询已开启**：`ENABLE_BALANCE_QUERY` 由默认 `false` 改为 `true`。弹窗**第二行**恢复显示 `余额¥X`，数据来自官方 `https://api.deepseek.com/user/balance`（key 从 `models.json` 读，仅本机使用、不外传，15 秒缓存）。**显示规则保留「变化检测」**：首次只记基线不显示，**余额与上次不同才显示** —— 因为无法判断用的是官方 API 还是产品内置额度，**只有余额变动才说明在用 API**；余额稳定不动时不显示属**设计行为**。宽度实测：第二行上限 42，极端场景（今日/余额各 5 位数）40 宽，不会超宽丢余额。

**② 「通知不弹横幅」排查（⚠️ 重要，详见 SKILL.md 最前面一节）**：Windows 的「**通知建议**」（`SmartOptOut`）会把**长期未点开**的应用通知静默成「只进通知中心、不弹横幅」，并在 `HKCU\...\Notifications\Settings\<AppId>` 写入 **`ShowBanner = 0`**。本技能用**自定义 AppId「WorkBuddy Token Tracker」**（直调 Windows API），**不出现在「设置 → 系统 → 通知」的应用列表里，只能改注册表**：

```powershell
Set-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\WorkBuddy Token Tracker" -Name ShowBanner -Value 1
```

（建议同时关掉"通知建议"：`...\Windows.ActionCenter.SmartOptOut` 新建 DWORD `Enabled=0`。）**实测 2026-09-26 当场恢复。**

### v3.13（2026-09-23）—— 子代理口径统一 + 有界微重判

**① 口径统一（准确性修复）**：`aggregateTranscript` 合并子代理时原先不做**行级时间戳过滤**（只靠文件 mtime 归属本轮）→ 子代理文件被**唤醒/复用**时（文件 mtime 变新但含更早轮次的行）会把旧行算进来，**弹窗数字偏大**。真实数据实测：唤醒 `agent-51c238cc` 后连续 5 轮各多算 **82.0 万** token。现改为传 `roundStartMs` 过滤，与拆分路径口径一致。**守恒验证**：改前单条 1108.7万 vs 拆分 1028.6万（差 80.1万）；改后 **1417.9万 vs 1417.9万（差 0.00万）**。账本走行数水位线，不受影响。

**② 有界微重判**：原 mtime 活跃窗（20s）会把"刚写完只差不到 20 秒"的子代理误判为仍在跑，白拆两条（实测只差 0.7 秒）。现新增最多 3×700ms 的重判：期间若**本轮子代理文件全部为终止态**则放行单条完整弹窗，否则回退拆分。**仅当全部文件确认终止才放行，绝不漏 token**；开关 `WB_NO_SUB_WAIT=1`。

### v3.12（2026-09-23）—— 异常轮拆分弹窗兜底（先主模型、后补子代理）

**问题**：团队轮若在 Stop 时子代理**仍在运行/卡死**，旧逻辑会把弹窗推迟到"下一个事件"（实测延迟 1~10 分钟），若无后续事件则**永远不弹**。

**实现**：Stop 新增第三分支 —— 判定"子代理仍在跑"时 **立刻弹【主模型】条**（第一行标注「子代理运行中」），并把 `mainToastedAt` 写入 coalesce；等子代理结束后由 watcher / `--hook` 兜底**补弹【子代理】条**（`team-sub-only`），不重复计主模型。**不引入任何阻塞等待**（实测子代理落盘滞后 0.0 秒，等待无收益）。新增 `aggregateMainOnly` / `aggregateSubsOnly` / `toastLineTagged`。

**实测**（隔离 `WB_ROOT` + 真 CLI + 真实 transcript/trace 复制件）：普通轮 1 条无标注 ✓；团队轮子代理已结束 1 条完整 ✓；**异常轮 = 主模型条 + 补弹子代理条** ✓；重复触发不重复弹 ✓；真实文件零改动 ✓；"子代理刚结束未满 20 秒"误拆频率 0/23。

**紧急开关**：`WB_TEAM_SPLIT=0` 回到 v3.11 行为。**排查备忘**：补弹依赖 trace 文件存在，缺 trace 的沙箱会误报"补弹不触发"。

### v3.11（2026-09-23）—— 弹窗第一行改为「主模型（子代理 X）」

**问题**：团队轮（专家团/子代理）的弹窗标题显示成**子代理用的模型**（如 `hy3`），用户误以为自己的模型变了或计费错了。根因：聚合出口 `aggregateTranscript` 的 `model: (sub && sub.model) || (main && main.model)` —— **子代理模型优先**。

**修法（只动显示，不碰计费）**：新增 `modelMain` / `subModels` 两个字段；`shortModelName` 优先取 `modelMain`；`toastLine1` 在第一行追加 `（子代理 X）`。规则：主模型永远在前；第一行最多两个模型名（多余标「等」）；子代理与主模型相同则不标注；超宽先截子代理段，预算不足整段丢弃。`stat.model` **保持原样**（`calcCost` 用它取价目表，不可改）。

**实测**（真 CLI + 隔离 `WB_ROOT` + 静默开关）：真实团队轮 → `deepseek-v4.1-flash（子代理 hy3）`；合成 5 用例全过（含超长名截断至 ≤45 宽）；真实文件零改动。

**已知近似（未修）**：团队轮弹窗的 ¥ 仍按单一价目表算全轮 token；账本按模型分桶记账不受影响。

### v3.10（2026-09-22）—— 两名独立验证员复核后的两处修正

**① 取消否决改为「精确编辑重发匹配」**（推翻 v3.09/v3.08 的"完成行否决"）：全库分类 247 处取消标记 → E=12（精确 `resend-fork-notice` 匹配＝真编辑重发）／C=208（无 resend、标记后先有普通用户提问再有完成行＝**真取消 + 用户随后又提问**）／U=27。按"完成行否决"计算**误杀率 94.5%（208/220）**，后果是取消轮不补弹 → token 静默并入下一轮（v2.83 治过的病；第三方证据：日志 42 条 `cancelled-*`、23 个 C 类样本取消后 7~31 秒确曾正常补弹）。现改为：标记前最近一条 user 消息的 `id` 与某条 `resend-fork-notice.editedUserItemId` 精确相等才否决。实测事故（E）仍被挡住、C 类真取消恢复识别。

**② 修复D 增「子代理活跃」兜底**（修 BUG-1）：原判据只看 `subagentPending().length===0`，而该函数在 **Agent 调用取不到可解析 name（中文团队/无 name）时假空返回 []** → 会提前弹窗、少算子代理用量，且推进边界后子代理后续输出再无人接管（弹窗丢失；账本不受影响）。现复用本文件既有的 `hasSubagentsRecentlyActive(tsPath, SUBAGENT_IDLE_MS=20s)` 作为第二道判据。⚠️ 勿改用"子代理末行都已收尾"——被取消的子代理末行永远是 `incomplete`，会让快速路径永不触发。

**复核结论**：轮次边界无偏差、不会同轮双弹、no-token 推进 `lastStopAt` 端到端通过、`interruptedByUser` 不漏检。

### v3.09（2026-09-22）—— 撤回 skipRun 判据 + 修复团队轮弹窗延迟/不弹（已被 v3.10 修正，见上）

**① 撤回 v3.08 的 `skipRun` 判据（前提被实证推翻）**：v3.08 曾按「标记行 `skipRun===true` → 非取消」排除，依据是"skipRun = 编辑重发特征"。全库实测推翻了它——扫描 207 个 transcript（274 MB），命中正规取消标记 **183 处，183/183 全部带 `providerData.skipRun=true`**。该字段是应用中止在飞请求的**通用字段**（点停止/编辑重发/分叉都会写），据此排除会 **100% 灭掉真实取消检测**。已删除该判据并就地注释固化证据。（另注意：字段位于 `providerData.skipRun`，v3.08 误写成顶层 `r.skipRun`，恰好空转未酿祸。）

**② 修复团队轮弹窗时效（此前可能延迟 1~10 分钟甚至不弹）**：Stop 判定为团队轮时走 coalesce + watcher；而 watcher 的降级兜底只在「spawn 未接管」时触发，**覆盖不了「spawn 成功但随后被宿主进程收割」**（现场遗留 `.coalesce-*.json.lock`、无 toast）→ 只能等下一轮 `--hook` 补弹。实测三条团队轮弹窗全部靠 `hook-fallback` 补出（延迟 1~10 分钟）。修法：Stop 时若 `subagentPending(tsPath).length === 0`（子代理已全部收尾 = 数据已齐）→ **直接同步立即弹窗**，不再 spawn watcher。实测该场景 pending=0，延迟全部消除；账本不受影响。

### v3.08（2026-09-22）—— 修复「未取消却弹（手动取消）」的取消误判 ⚠️（其中 `skipRun` 判据已被 v3.09 撤回；实际生效的是「后续完成行即否决」+「no-token 分支推进 lastStopAt」）

**问题**：2026-09-22 实测会话 b017080d-…：用户编辑后重发/分叉消息时，应用中止在飞请求并写一个通用中断标记（`role=assistant`/`status=incomplete`/`error.message="Interrupted by user"`/`skipRun=true`），主轮之后继续正常跑到完成——主轮从未被取消。但兜底判定把这条标记误判为「用户手动取消」，整轮 10m31s 被错标「（手动取消）」。根因三重叠加：① 命中标记行带 `skipRun=true`，旧逻辑未排除；② 标记之后主轮正常完成，旧逻辑遇到注入型 `user`（task-notification）行就 `break` 直接采信标记、没检查到后续完成行；③ 23:10:09 的 Stop 走 no-token 分支不推进 `lastStopAt`，导致 23:21 注入行唤起兜底时 `intrInfo.ts > lastStopAt` 仍成立。

**修复**：
- `interruptedRowsAfter` / `interruptedByUser`：命中标记行若 `skipRun===true` 一律不认定取消；命中后扫完全部后续行，只要存在任意「正常完成」的 `assistant`（`status!=='incomplete'`）行即判非取消、返回空；注入型 `user` 行不参与 break/续跑判断（治本）。
- no-token Stop 分支返回前同样 `saveSnapshot` 写入 `lastStopAt: Date.now()`，使后续注入行唤起兜底时 `intrInfo.ts > lastStopAt` 不再成立（堵触发链）。
- 真实取消（标记无 `skipRun` 且其后无完成行）仍必识别，不漏。

**验证**：`WB_ROOT` 隔离回放真实事故 transcript → 不再误判；合成「标记无 skipRun、其后无完成行」→ 仍识别为取消；普通轮/重复弹回归正常；真实账本与价库 md5 零改动。

### v3.07（2026-09-16）—— DeepSeek 官方价「跨 key 接管」：手动补录价不再永久锁死

**问题**：手动补录的模型 key（`deepseek-v4.1-flash`）与官方现行 API ID（`deepseek-flash`）不同名，旧逻辑只按官方 ID 精确匹配 → 永远匹配不上 → 手动条目停在 `pending-official`，且 `manual`+`lock` 双标记使其被彻底冻结，官方调价也不更新（静默用过期价）。

**修复**：
- `deepseek-official.js`：解析官方页「模型版本」行，用去标点归一化与本地 key/name 对齐，命中即判定同一模型 → 官方价强制覆盖手动价、解除 `manual`/`lock` 冻结、打 `alias_of=<官方ID>`（保留本地 key 供运行时匹配 + 豁免 retired）、写 `_manual_audit`（`official-adopted` + diff）。
- `refresh-prices.js`：官方价解析加别名回退 `official.official[m.alias_of]`（防止被聚合源 llmabacus 价覆盖）；14 天清理豁免别名条目。

**验证**：隔离 `WB_ROOT` 端到端（含 `--force` 五源全成功）——别名条目在聚合源刷新下保持官方价；真实价库零误写；`--report` 计费回归正常。

### v3.06（2026-09-12）—— 弹窗系统性失效根修 + 解耦 + 全面测试加固

**弹窗彻底不弹（根因）**：WorkBuddy 新版在 hook 进程结束后会**连带终止其派生的 detached 子进程**；原后台 watcher 刚启动即被杀，而 `cp.spawn` 的失败是**异步 `'error'` 事件**（原代码无监听）→ 完全静默（无日志、无降级）。
- 修复：`spawn` 补 `'error'` 监听留痕；新增 `startWatcherVerified()` 校验是否真接管；**普通轮改为同步立即弹窗**（不再依赖后台子进程），专家团仍走 watcher；普通轮自行推进 `lastStopAt`（原由 watcher 推进）。

**解耦（抗客户端更新）**
- 价库路径由硬编码工作区改为 `autoDiscoverCnPriceDir()` 四级自适应（环境变量 → 自动扫描 `~/WorkBuddy/*/prices` 取最新 → 技能自身目录副本 → 旧值）；已建兜底副本（31 模型），**工作区消失仍可用**。
- 新增 schema 漂移留痕（`schema-drift-suspect`，正常轮次 0 误报）。

**全面测试发现并修复**
- watcher 抢锁失败 → **TDZ 崩溃**（`appendWatchDebug` 的 `const` 定义在使用之后）→ 定义前移。
- 已结算轮**重复弹窗**（重试用 `roundStart0` 回退到已结算区间）→ 统一用 `aggStart0`。
- 取消轮"零已完成用量"漏补弹 → 估算前置 + 构造基底 agg（两处取消路径均已修）。
- 水位线 **UTF-8 BOM** 导致记账被跳过 → 已去 BOM（教训：勿用 `Out-File -Encoding utf8` 写会被 JSON 解析的文件）。
- `recordUsage` 损坏守卫：**审查后保持原顺序**（改为"先 load 再判断"反而丢本轮用量），补注释说明。

### v2.99（2026-09-10）—— 全方位测试后修复 6 项：消灭「账本静默失真」

由 4 个测试子代理并行扫描 4 个维度（解析健壮性 / 入口流程 / 计费定价 / 状态并发），报告 11 项经逐条复核**全部确证**。

- **a. token 数值类型加固**：`extractUsage` 原不校验类型 → 字符串触发 JS **字符串拼接**（`"100"+200="100200"`），账本脏掉且难察觉。统一数值化+非负+取整（真实 9574 样本全为 int，属防御性）。
- **b. 隔离泄漏修复**：`TOAST_LOG_PATH` / `COMPACTION_LOG_PATH` 原硬编码 `os.homedir()`，绕过 `WB_ROOT` → 测试污染真实日志（实测 16 行）。改用 `WB` 变量，默认路径不变。
- **c. 价库「存在但损坏」告警**：原仅「缺失」告警；文件在但 JSON 损坏时**完全静默**（比缺失更危险，用户不会怀疑）。补齐该分支。
- **d. `calcCost` 负数钳制**：负 out 产生**负总价**污染账本；负 cached 令账单**失真放大**。加非负钳制。
- **e. 水位线 `.bak` 不再自动回退（高）**：`.bak` 恒落后一个保存周期，回退它 = 重放已记增量 = **重复计费**（实测多记 5500 in / 1600 out），违反本函数自身「宁可少记不重复」原则。改为 skip + 提示人工核对。
- **f. 账本损坏标志不再被误清（高）**：`loadDailyUsage` 开头无条件清 `gDailyCorrupt`，同进程第二次调用走 ENOENT 会清标志 → **用空账本写回、历史丢失**（日志却称「不写回覆盖」）。标志改为只由「成功解析」清除。

**安全性**：解析 8/8、计费 5/5 等价性零差异 + 真实账本健康度检查（无负数、无 cached>in、无金额异常）+ `--report` 冒烟正常 —— **计数/计消耗零误报**。

**未采纳（设计取舍）**：`findModel` 边界匹配使未收录变体按家族基价计费（v2.82.1 有意设计，改会破坏正常变体匹配）；跨零点峰谷窗口（s>e）被跳过（官方无此档）。

### v2.98（2026-09-10）—— 弹窗区分「子代理」与「专家团」+ 判定依据升级

依据官方文档（workbuddy.cn/docs/cli/agent-teams）与 86 份真实子代理转录实测：普通子代理 `agent`=内置类型名（Explore / Plan / general-purpose）且**无** `agentColor`；专家团成员 `agent`=专家角色名（topic-researcher / prototype-builder 等）且**有** `agentColor`（官方：成员以分配颜色渲染）。
- 判定由「仅靠 subagents/ 目录位置」升级为优先读转录内 `isSubAgent === true`。
- 标注：专家团 →`（专家团使用）`；普通子代理 →`（子代理使用）`；**与主模型同模型** → 并入主弹窗不标注。
- 更正旧结论：`providerData.agent` 恒为 `cli` **只在主转录成立**；子代理转录里它是角色类型名，正是关键判据。

### v2.97（2026-09-10）—— 子代理弹窗提速（延迟 61s → 26s）

根因：`hasSubagentsRecentlyActive(tsPath, 60*1000)` 窗口过度保守。实测子代理事件间**最大间隔仅 8.8s**（模型思考空档），且最后写入时间 == 文件 mtime（无落盘延迟）。新增 `SUBAGENT_IDLE_MS`（默认 20s，可用环境变量覆盖）；**异常死寂兜底仍保持 60s 不动**。真机实测：**61 秒 → 26 秒（缩短 57%）**。

### v2.96（2026-09-10）—— 价库失效告警 + 热路径缓存 + reasoning 数据提取

- 价库缺失不再静默（stderr 告警；仅加告警、不改路径解析，避开刷新锁联动）。
- 取消路径重复全量读 3 次 → 1 次（大会话 49MB 下省约 2/3 解析）。
- `extractUsage` 新增 `reasoning` 字段（实测占输出 **63.8%**），账本不受影响（`addModelUsage` 只取 in/out/cached/total）。

### v2.95（2026-09-10）—— 子代理弹窗标注 + 时区统一

- 新增 `subagentModelSet()`：子代理与主模型不同模型 → 独立弹窗并标注「子代理使用」；同模型 → 并入主弹窗不标注。

### v2.94（2026-09-10）—— 自动补录峰谷倍率修正

`addModelPrice` 原把 `peak_multiplier` 一律写死 `1`，绕过 `calcCost` 对 DeepSeek 的「缺省按 2」→ 新收录的 DeepSeek 模型高峰不翻倍（长期低估）。改为按模型族写（**DeepSeek=2，其余=1**）。

### v2.93（2026-09-10）—— 官方模型名正则放宽 + 账本回溯重算

**① 官方页自动新增修复（根因级）**：旧正则 `/^deepseek-v4-/` 匹配不到带点版本号的新模型名（如 `deepseek-v4.1-flash`），会**静默漏掉**该模型，并导致**其余模型价格整体错位**（`grab()` 按模型数截取价格数组），且不报错。放宽为 `/^deepseek-/` 后，官方上架新模型可被自动收录（隔离测试 T1 验证）。

**② 新增 `recalc-day.js` 回溯工具**：补录只能让之后的消耗计上价，当天此前记成 ¥0 的历史数据需回溯重算。工具按现价 + 峰谷（读 toast 日志轮次时间判定高峰占比）重算指定日期，独立进程不侵入主链路。实测 09-10：¥0.5012 → ¥1.8643（4 轮全在高峰时段）。

### v2.92（2026-09-10）—— 新模型手动补录 + 官方价自动对账

**背景**：DeepSeek-V4.1 Flash 已在客户端上线，但官方定价页未上架、聚合源未收录 → 自动补录链路必然失败，账本持续记 ¥0.00（本日实测 263 万输入记 0 元）。

**修复**：① `pricing.json` 新增手动补录条目（`manual:true` + `lock:true`），价格取自官方公告（空闲 1 / 0.02 / 4，高峰 ×2）；② `deepseek-official.js` 的 retired 扫描豁免 `manual` 条目（原先手动新增模型次日会被打成 retired = 不再计费）；③ 新增对账机制：官方源收录后自动写入「手动值 vs 官方值 vs 差异%」到 `_manual_audit` 并交接到官方价。

**影响**：新模型从「等官方 / 等聚合源（时间不可控）」变为「立刻可补录，官方上线后自动纠偏并留痕」。

### v2.91（2026-09-05）—— 取消检测双信号 + 自适应静默

**信号升级**：round watcher 新增工作区日志信号源（`cancel: received cancel request for session <sid>`，客户端源码实证每次取消必写、含精确时间戳与会话 id），与 transcript 取消标记行互为冗余——标记行缺失/延迟也能确认取消。自适应静默：取消确认后新 usage 落盘且稳定 2s → 提前弹（典型 3~5s，原固定 8s）；无 usage → 8s 兜底。测试基建：`TOKEN_TRACKER_NO_TOAST=1` 静默开关，测试零弹窗零闪烁（硬规矩入 MEMORY.md）。

**验证**：S1 日志信号确认（标记行缺失）→ 聚合弹「4万/2000」精确；S2 自适应 4.8s 弹（固定静默需 6s+）。

### v2.89（2026-09-05）—— 实时取消补弹失效根修：spawn 调用点丢失

**现象**：手动取消后弹的是兜底（cancelled-round-flush，下一轮提交才弹），而非 v2.85 的实时补弹（8 秒内）。

**取证（toast log 全史 + git diff）**：① 客户端层：08-25~09-02 的取消全部即时弹（interrupted，Stop hook 触发），09-03 起取消不再稳定触发 Stop hook（挂起行为），出现兜底——客户端行为不稳定；② **技能层（主因）**：v2.85 的弹窗三分支/watcher 主体/--round-watch 入口全部完好，唯独两处 spawnRoundWatcher 调用点在后续编辑中丢失——round watcher 从未被启动，真实取消 0 次实时弹。旧测试直接调 --round-watch 入口测 watcher 主体、未覆盖 spawn 链路，全 PASS 仍漏检。

**修复**：补回两处调用点 + 新增端到端测试（--hook → spawn → 取消标记 → 实时弹）。验证：spawn 链路通、取消标记写入后 2.5s 实时弹（probe 记 RoundWatch）。

### v2.88（2026-09-05）—— 耗时显示压缩盲区根修：换数据源，不再依赖 trace

**现象**：弹窗显示耗时 4m6s、客户端实际 12m49s（差 3 倍）；hook 注入行同款（4m5s）。取证确认这轮 `aggStart == roundStart`，与 v2.86 无关——是耗时口径的老盲区被"轮尾压缩"形态触发。

**根因**：压缩（contextSummary）**不写 trace 文件**——最新 trace 的 endedAt 停在模型回复结束（17:27:47），压缩的 8m44s 只写 transcript。`traceWallDurMs = trace.endedAt − 轮起点` 无论怎么调，都补不回 trace 里根本不存在的压缩段。历次修（v2.74 分段 / v2.82.1 口径）都在 trace 里打转。

**修复**：结束时刻改取 **max(trace.endedAt, transcript 末行 timestamp)**——transcript 是唯一覆盖全轮（含压缩）的数据源；起点恢复整轮起点（v2.86 曾误用上次结算点）；hook 注入行同源修复（asHook 路径内增强 stat.durMs，快照保留 trace 原口径）。修复后该弹窗应显示 ≈12m47s（与客户端 12m49s 差 2s，UI 计时开销）。

**验证**：函数级单测 3/3——旧口径（无 tsPath）246s 不回归 / 新口径 767s 覆盖压缩段 / 起点晚于 endedAt 走 fallback。

### v2.87（2026-09-05）—— compaction 事件日志 + 跨进程弹窗兜底去重

**背景**：压缩相关弹窗异常 8 次（08-25~09-05）反复修反复出。取证结论：不是客户端某次更新改坏（09-01 旧客户端就有同款双弹痕迹），而是 **compaction 对 hook 侧完全黑盒、形态组合爆炸**——每次只能修当时观察到的那个形态。用户拍板：只做"观测先行 + 弹窗兜底"，不再打地鼠。

**① compaction 专项事件日志**（`~/.workbuddy/token-tracker-compaction.log`）：三个关键决策点落盘事件 + transcript 形态快照（`stop-transcript` 含聚合起点决策 / `flush-watch-start` / `round-watch-start`，shape 含 lineCount、mtime、size、末行 type+role+status、末 30 行压缩标记 id）。以后再出怪弹窗，直接有完整事件序列可查，不再猜机制。

**③ 跨进程弹窗兜底去重**（指纹文件 `token-tracker-toast-fp.json`）：四条件全满足才抑制第二窗——同 transcript、行数差 <10、间隔 <240s、同模型。行数差 <10 是关键信号：连续小轮每轮新增 10+ 行不会误伤；同轮数据被两个进程重复聚合时行数几乎不变（实测双弹 930→934 只差 4 行）。抑制只影响展示（账本按水位线已记完）；被抑制内容仍写入 toast 诊断日志；cancelled/估算/无记录文案不参与（取消补弹必须可见）。

**验证**：one-shot 全链路（stop → watcher → 弹窗「1万/550」精确 + compaction log 完整）；抑制实测（两连弹第二窗 `toast-suppressed` 记录、系统通知未弹）；实战验证 17:23 用户取消轮 `interrupted` 弹窗 29s 内及时弹出。

**失效边界**：指纹只记最后一条（三连弹的第三窗若行数差 >10 不拦，宁漏拦不误拦）；非 watcher 收口路径不参与抑制；行数差 <10 的小额新增段也会被拦（账本已记，仅少展示一个 ¥0.0x 小窗）。

### v2.86（2026-09-05）—— 同轮二次 Stop 守卫：压缩触发双弹根修

**现象**：16:50:35 与 16:51:13 连出两个几乎一样的弹窗（同模型 glm-5.3-flash、同"耗时 17.4s"，仅金额差 2 分钱），观感"重复弹窗"。

**根因链**（`token-tracker-toast.log` 取证）：「今天消耗」轮 16:48:34 Stop → coalesce + flush watcher → 上下文压缩随即开始（transcript 末行持续 busy）→ watcher 等 120s 后 busy-timeout 弹窗1（20.6万/146/¥0.08）并推进 lastStopAt。16:50:50 **压缩完成触发第二次 Stop hook** → Stop 端聚合起点只认 `lastUserMsgAt`（仍为 16:48）→ 无条件重聚整轮（已弹的 20.6万/146 + 压缩调用新增 4.7万/385 = 25.3万/531）→ spawn 新 watcher → 16:51:13 弹窗2。**账本从未重复**（incrementalRecord 水位线幂等，弹窗2 仅新增记 ¥0.02，16:48 时 ¥28.19 → 双弹后 ¥28.29 精确吻合），纯弹窗层重复。

**修复**：Stop 端 transcript 路径聚合起点改用 `aggStart = max(lastUserMsgAt, lastStopAt)`——已结算过（lastStopAt > 轮起点）只聚合新增段（`aggregateTranscript`/`estimateInterrupted`/`traceWallDurMs`/`aggregatePerModel`/`writeCoalesce` 五处同步）；聚合窗口无新增 usage 且已结算过 → **静默跳过**（记账照跑保底 + probe 记 `same-round-settled-no-new-usage-skip`），绝不弹"无记录"误导。未结算过时行为完全不变。

**验证**：3 项回放全 PASS——T-A 同轮二次 Stop 有新增 → 只弹新增段（2100/150，不再含已弹的 1万）；T-B 无新增 → 静默；T-C 单次 Stop 回归 → 弹整轮（1.2万/650）。账本自备份自恢复零污染。

**失效边界**：① watcher 从未弹成（进程被杀/应用关闭）→ lastStopAt 不推进，同轮二次 Stop 退回旧行为（重聚整轮）；② 同轮多段续跑（R2 场景）现在也只弹新增段——整轮汇总看弹窗"今日累计"；③ v2.85 取消补弹同样推进 lastStopAt，语义共享不冲突。

### v2.85（2026-09-05）—— 轮级临时 watcher：手动取消实时补弹（方案 A）

**动机**：v2.83/v2.84 的 hook 端兜底依赖「用户下次提交」触发，且 0-usage 取消（取消时 usage 尚未落盘）会静默跳过——实测 2026-09-05 15:33：15:31 发起 → 15:33:03 手动取消，窗口内 0 条 usage 行、0 条 reasoning 行，兜底全程无感知，该轮 2 分钟还被并入下一轮弹窗（16m49s 无法辨认）。用户拍板方案 A：**hook 时 spawn 轮级 watcher，取消后 8 秒即补弹**，非常驻、非兜底。

**实现**：
- 新增 `--round-watch <sid> <tsPath> <roundStart>` 入口 + `spawnRoundWatcher()`（detached/stdio ignore/windowsHide/unref，照 `spawnFlushWatcher` 模板）+ `roundWatchMain()` 2s 轮询主循环。spawn 点两处：① 每个全新轮的 hook（起点刷新守卫后）；② v2.83 兜底补弹 return 前（新轮同样需要 watcher）。
- **弹窗三分支**（终止态取消标记 + 静默满 8s，行数与 mtime 双跟踪防压缩误判）：有 usage → 聚合实数弹（`cancelled-round-watch`）；0-usage 有 incomplete reasoning → 估算弹（`cancelled-round-watch-est`，v2.52 Stop 端同款）；两者皆无 → 「本轮无 token 消耗记录（手动取消）」（`cancelled-round-watch-no-token`）——不静默、不编数字。
- **退出条件（防双弹，先于弹窗判定）**：轮已结算（`lastStopAt ≥ roundStart`）/ 新轮接管起点 / coalesce 出现（正常 Stop 链路接管）/ transcript 消失 / 生命上限 3h。注：showToast 的 10 分钟文案去重是进程内存态、跨进程无效，防双弹全靠结算推进 + 弹前复核。
- **兜底路径配套修复**：结算门槛放宽为「取消标记晚于最近一次结算」（连环取消不漏、已结算旧标记不重弹）；兜底补弹后就地刷新 `lastUserMsgAt`（原实现 `return` 跳过了起点刷新守卫，旧起点残留会让下一轮 Stop 聚合窗错位）。

**验证**：6 项回放全 PASS——T1 有 usage 聚合弹（20万/4000/缓存90% 精确）；T2 0-usage 估算弹（estIn=前轮 15万）；T3 已结算静默退出（445ms 零弹）；T4 续跑（标记后直接 assistant）不弹；T5 取消后 user 跟进仍补弹；T6 **真实 15:33 数据**回放 → 弹「无 token 消耗记录（手动取消）」。测试自备份自恢复账本，跑完与备份逐字段一致（零污染）。

**失效边界**：① 应用完全关闭时 watcher 可能被 Job Object 连带收割（与 `--flush-delayed` 同局限）→ 退回 hook 兜底；② 取消后 8s 内就发新消息（快于静默窗）→ 让位下一轮 hook 兜底；③ 上一轮未结算时不重复 spawn，旧 watcher 已死则退回兜底；④「无 token」场景输入侧云端或已计费但本地无凭据，只提示不估算。

### v2.83~v2.84（2026-09-04）—— 手动取消漏弹修复（v2.84 续跑判定修正）

**背景（真实事故，2026-09-02 00:33）**：用户手动取消一轮长任务（实测消耗 108.7万 tokens），**没有弹出任何通知**。排查确认：WorkBuddy 手动取消**不触发 Stop hook**（取消被 `SessionAbortMiddleware` 挂起，直到下一条用户消息才吸收，全程无 `executeStopHooks`）——该轮没有结算入口，其 token 在下一条消息时被静默合并进下一轮弹窗（显示 25m3s，用户完全无法辨认）。

**v2.83 —— hook 端补弹路径：**
- 新增判据函数 `interruptedRowsAfter(rows, roundStartMs)`：从 transcript 提取「取消标记」（`role=assistant` + `status=incomplete` + `providerData.error.message` 精确为 `Interrupted by user`），区别于既有的 `interruptedByUser`（只看末尾行、服务于 watcher 即时信号）。
- 三个安全条件全部满足才补弹，防重复弹：① `inProgress` 为真（上一轮无完成的 Stop/watcher 结算）；② 存在未被后续消息跟进的取消标记（该轮确实终止）；③ 取消标记 ts > `roundStart`（属于本轮，不是更早的旧标记）。
- 补弹后推进 `lastStopAt` 并 return；**不走 coalesce/watcher**——取消是终态，不存在"是否续跑"的不确定性。

**v2.84 —— 续跑判定修正（关键）：**
- v2.83 初版判定「取消标记后出现 assistant 消息 → 续跑、不补弹」，把真实流程 **取消 → 用户发新问题 → 模型回答新问题** 误判为续跑，导致真实取消场景仍然全部漏弹（实测 transcript `ab3c8bf6`：line1262 取消 / 1263 用户新消息 / 1266 新回复）。
- 改为**看中间隔没隔用户消息**：取消后先出现 `role=user` → `break`（新轮次，补弹）；取消后直接跟 assistant（无 user 分隔）→ 才算续跑，不补弹。

**验证**：5 项离线回放测试全通过 —— T1 真实 transcript（00:33:53 取消 → 00:35:07 user → 00:35:49 assistant）PASS；T2 续跑拦截 / T3 无取消标记 / T4 取消早于轮起点 / T5 连续两次取消（取最后一个）均 PASS。

**边界说明**：供应商侧或应用侧自行中断（非用户点击停止）也会写入同样的 `Interrupted by user` 标记，但此时 Stop hook **正常触发** → 走既有 watcher `interrupted` 路径弹窗，**不走**本补弹路径（实测 2026-09-02 01:35 即如此，日志 `reason=interrupted`）。补弹路径只兜「Stop hook 压根没触发」的情况。

### v2.82.0~v2.82.3（2026-09-01）—— 价格库刷新根修 + 耗时口径 + 计费精度 + 并发加固

**v2.82（2026-09-01）—— 本地价格库自动刷新根修 + 并发加固 + 逐模型沿用：**
- **resolvePython 补 venv**：本地价格库每日自动刷新从上线起从未成功过的根因——唯一带 requests 的 venv 不在 python 解析候选表里；补入后每日刷新恢复正常（`.refresh.lock` 不再常驻）。
- **刷新子进程治理**：180s 超时 SIGKILL（网络 hang 不再永久卡锁）+ 失败写 `.refresh.error` 留档（不再全静默）。
- **护栏 A 修复**：`refresh-prices` 清理逻辑与注释相反、每次刷新把不在账本的模型全删（26→6）——修正后 `--force` 实测零丢失。
- **findModel alnum 桥接**：`glm-5.3` 直接命中本地库 `glm53` 官方价（不再每次联网补录）。
- **流水线并发加固**：fetch/parse/build 三脚本写盘改「唯一 tmp + os.replace」原子写（多会话并发不再 PermissionError / 半截 JSON）。
- **build_index 逐模型沿用**：官网软 404（Moonshot 改版）不再静默丢模型（35→31 的 bug），缺失模型沿用旧价 + `missing_since` 7 天自动淘汰。

**v2.82.1（2026-09-01）—— 弹窗耗时口径根修：**
- 耗时 = 最新 trace `endedAt` − 用户提交时刻。旧版取「单个 trace 文件首尾」，长任务多 trace 分段落盘时只算最后一段（实测 11:27 只显示 4:22；trace 切分时机由客户端决定不可预测，所以时对时错）。新口径与 WorkBuddy 显示实测差 ≤1s。

**v2.82.2（2026-09-01）—— 计费精度三修 + 缺名不记价：**
- **findModel 单向边界匹配**：未收录模型不再撞价（glm-5.3-air→glm-5、kimi→kimik25 的错价来源），`hy3-x→hy3`、`deepseek-ai/xxx→v4-flash` 仍宽松命中。
- **incrementalRecord 水位线锁**：watcher 与 Stop 并发不再重复记账（专家团场景实测双记 bug，集成测试两进程并发只记一次）。
- **缓存价不估算**：自动补录的缓存价缺失置 `null`（按 0 计），不再按输入价 ×10% 拍脑袋（DeepSeek 实际 3.3% 会被高估 3 倍）。
- **缺名不记价**：模型名缺失 / `unknown` 只记 token 不记钱（旧版按 deepseek-v4-flash 默认价入账）。

**v2.82.3（2026-09-01）—— 锁等待去忙等：**
- `withFileLock` / `withPricingLock` 重试等待改 `Atomics.wait` 真睡眠（不再 50×100ms 空转烧 CPU）。全套 108 项测试 0 失败 + 全天账本对账 0 差异。

### v2.76~v2.81（2026-08-31）—— 本地官方价格库优先 + 每日强刷 + 失败治理

**v2.81（2026-08-31）—— 本地官方价格库接入计费 + 刷新失败治理 + 弹窗告警：**
- **本地官方库**：`loadPricing()` 合并 `prices/index.json`（各厂商官网直抓人民币官方价），优先级 `lock` > 本地库 > 聚合补录；同模型识别按字母数字归一化，避免 `glm-5.3-flash`/`glm53flash` 双条目；合并条目仅存内存，写盘前剥离（不污染 pricing.json）。
- **每日强刷**：`built_at` ≠ 今天 → 后台 `spawn` 流水线（python 前缀补齐 + 绝对路径解析，杜绝 cmd 文件关联弹窗；实测 ~12s 非阻塞）；没刷完自动用前一天的完整库；单厂商抓取失败自动沿用上一份库该厂商数据。
- **失败治理**：退避 3→10→30→60 分钟、当日满 5 次熔断、次日自动恢复；python 缺失自动回退 `python3`。
- **弹窗告警**：库停在昨天 → 模型名后 `⚠价库8/30`；库缺失 → `⚠价库缺失`；正常零改动。超长模型名改**中间缩略**（保头组织名+尾型号名，给标注留位），修复超长名换行挤掉耗时行的老毛病。
- **修正**：官方未列缓存价的模型按**输入价保守计费**（不再按 0 元免单）；Hy-MT2 语音翻译模型不再入库；glm-5.3-flash 移除 lock（官方页双档自动跟随促销）。

**v2.76~v2.80**：内部迭代，含价格库范围精简（只留各厂自家官方价、宁少勿滥）与抓取器健壮性修复，无独立公开记录。

### v2.60~v2.75（2026-08-25~29）—— 稳定帧收口 + 性能 + 数据完整性 + 显示名/耗时口径修正

**v2.75（2026-08-29）—— 弹窗显示名还原原始短名：**
- `shortModelName` 非本地模型分支优先用应用原始模型名（hy3、deepseek-v4-flash 等），不再取 pricing.json 的 `name` 字段；计费路径（findModel 'price'）不变。修复弹窗模型名从 hy3 变 Hunyuan-3.0 的问题。

**v2.74（2026-08-29）—— 耗时统一口径：**
- Stop 聚合优先用 trace 墙钟（startedAt→endedAt），与 WorkBuddy 显示一致；trace 不可用回退 transcript 口径。修复弹窗耗时与 WorkBuddy 差 ~53s 的问题（transcript 首条 usage 行在生成完成后落盘，起点右移首轮生成耗时）。

**v2.73~v2.72**：内部迭代，无独立公开记录。

**v2.71（2026-08-28）—— findModel 双模式：**
- 默认（精确）模式只认归一化完全相等；新增 `mode='price'` 计费模式（精确失败后双向 includes 子串近似取价，如 hy3-x→hy3）。统计桶名保持原始名，计费与统计解耦。

**v2.70（2026-08-28）—— 上下文超长前兆检测 + toast 去重：**
- 模型返回 "input length too long" 等错误后启动压缩前，watcher 进入压缩等待窗口（默认 120s），避免压缩期间提前弹窗。
- 同文案 toast 10 分钟内只弹一次（防 Stop 与 watcher 兜底重复弹）。

**v2.69（2026-08-28）—— 增量记账性能优化：**
- `readTranscLinesFrom` 只解析水位线之后的新行（字节缓冲定位，100MB 文件从 233ms → 24ms），统计口径不变；`estimateInterruptedInc` 快路径 + 历史行回退。

**v2.68（2026-08-28）—— 数据完整性 4 项 + 锁逻辑同步：**
- 记账失败不再推进水位线（防用量永久丢失）；transcript 截断不回退水位线（Math.max，防重复计费）；水位线键消除跨项目串扰（无 sid 用完整路径哈希）；锁抢占只认持有者 pid 存活（存活绝不抢、已死立即接管），TTL 30s→300s。

**v2.67（2026-08-28）—— 模型名严格精确匹配：**
- `findModel` 只认归一化后完全相等的模型名，一个字符不同即不同模型；删除 includes 模糊匹配/版本后缀归并/`.`与`-`等价替换。日期后缀模型价格不可靠相同（r1 vs r1-0528 等实证）。

**v2.66（2026-08-28）—— 数据完整性 10 项 + 3 个额外 bug：**
- 原子写（临时文件+rename）；损坏自愈（.corrupt 备份）；并发锁（recordUsage/saveDailyUsage/addModelPrice 锁内重读盘合并）；记账口径统一 extractUsageFromRow（pd.usage/rawUsage/message.usage）；刷新超时 15s→60s。额外修复：require('refresh-prices.js') 触发联网（加 require.main 守卫）、addModelPrice 小写模型名、水位线损坏重复计费。

**v2.65（2026-08-28）—— 价格刷新改由 Hook 触发 + 清理长期未用模型：**
- 全量刷新从 --stop 移到 --hook（避免 Stop 被联网阻塞）；刷新时删除超 14 天未用模型（lock:true 三个 DeepSeek 模型保留）。

**v2.64（2026-08-28）—— 新模型首用 cost 丢失修复：**
- Stop 路径改为先补价再记账（原增量记账先于 ensureNewModelPricing，新模型首用 pricing 未落盘导致金额静默丢弃）。

**v2.63（2026-08-25）—— 弹窗诊断日志机制重构：**
- 废弃 TOKEN_TRACKER_DEBUG 开关，改为每次 showToast 无条件写 ~/.workbuddy/token-tracker-toast.log 一行 JSON（reason/sessionId/traceFile/toastText 等），5MB 轮清。

**v2.62（2026-08-25）—— compactionMode 方案：**
- 原"行数减少>5"检测在 append-only transcript 上永不触发、彻底失效；改为扫描末尾 30 行识别压缩标记（role=user 且以 <conversation_history_summary>/<cb_summary> 开头），出现新标记暂停收口。

**v2.61（2026-08-25）—— showToast 回归修复 + 性能 + 可观测性：**
- 回退 spawn(detached+unref) 为同步 execFileSync（防 watcher 退出时 PowerShell 子进程被终止、toast 丢失）；getTranscriptStats 用 '\n' 计数 + mtime 缓存（91MB transcript 轮询压力显著下降）。

**v2.60（2026-08-25）—— 统一稳定帧保护 + 去冗余确认窗：**
- stableCount>=3 门槛扩展到 final/terminal-error 分支（原 final 仅靠 6s 确认窗，compaction 长重写后误弹）；去除冗余确认窗，正常回合弹窗延迟收敛到 ~6-9s。

### v2.54~v2.59（2026-08-23）—— DeepSeek 官方定价直连 + 峰谷时段通用跟随 + 生效时间机制

**v2.59（2026-08-23）—— 生效时间机制落地：**
- `isPeakHour(rules, now)`：新增时间注入参数（测试/模拟用）；优先读 `pricing.deepseek_rules`（官方时段 + 周末开关），**官方改任何时段/周末规则，判定自动跟随**；无规则回退内置默认（9-12/14-18 + 周末低峰）。
- **生效时间分流（pending 机制）**：官方页面若标注"将于...起"（未来生效），解析出 `effective_at` 存 `deepseek_rules_pending`，**生效前当前规则不动**；到点自动提升为当前规则。示例：官方 8-22 预告"8-23 00:00 起周末统一低谷"，22 号当天仍按旧规则计费，23 号起自动切换。
- **失败重试**：官方抓取失败立即重试（默认 2 次、间隔 60s，`DS_RETRIES`/`DS_RETRY_DELAY_MS` 可配），仍失败 → 非零退出 + `FAIL_REASON`，回落聚合源 + toast「官价⚠️」+ 输出"当前数据更新失败，排查原因"。

**v2.59（2026-08-23）—— 官方定价直连抓取（新增 `deepseek-official.js`）：**
- 直连 DeepSeek 官方定价页 `api-docs.deepseek.com/zh-cn/quick_start/pricing`，正则解析：模型清单 + 三组价格（缓存命中/未命中/输出 × 空闲/高峰）+ 时段 + 周末规则。
- **官方优先**：DeepSeek 系模型官方清单有 → 用官方价（空闲价 + peak_multiplier=2）；官方没有（如已下线 V3 系列）→ 回落聚合源价。
- **模型清单自动对齐**：官方有本地没有 → 自动新增；官方没有本地有 → 自动标 `retired:true`（历史账本保留、不再计费）。vision-exp 官方在售已自动收录。
- 刷新流程：`refresh-prices.js` 每日先跑官方抓取器 → DeepSeek 系官方价；其余模型照旧聚合源；官方失败不中断整体刷新。

**v2.54~v2.58（2026-08-18~23，此前已闭合）：**
- 本地模型识别增强（v2.54~55）：localhost/127.0.0.1/局域网已知端口 → 本地模型免计费，防止本地模型撞云端同名误计费。
- P0-1 回归修复（v2.59 含）：watcher compaction 期间 unknown 误弹（R1 回归）——`readTailRaw` 末行内容对比识别 transient unknown，改写中续等不弹、真停写才 6s 收口。
- `--report` 展示约定固化 + `daily-usage.json` 顶层 `_instructions` 字段（v2.58）：读取方（AI 助手）直接读文件即见展示规则（Markdown 表格原文 / 中文数字简写 / 人民币 ¥）。

**已知限制（当前版本）**：
- **DeepSeek 第三方 API 无法区分**：价格以 DeepSeek 官方定价锚定；若通过第三方中转/聚合 API 调用同名 DeepSeek 模型，仍按官方价计费，无法自动识别第三方渠道实际价格。
- 官方页面为 Docusaurus HTML，解析靠正则（官方改版可能需适配）；官方抓取失败时自动回落聚合源价并提示。
- 本地非 DeepSeek 系模型价格仍由聚合源（llmabacus 等 5 源）维护，源缺失时保留上次价。

### v2.40~v2.53（2026-08-15）—— 专家团结算彻底修复 + 增量记账架构重写

**先说清一件事：为什么之前几次「修复」了，专家团弹窗还是不对。**（诚实复盘，回答"修复了结果还是烂"）

之前 v2.23~v2.29 的修复踩了两个层面的坑：

1. **前两次（v2.23 / v2.24）根本修错了地方。** 它们默认专家团的 token 会像普通对话一样落盘 `traces/`，于是在这条**错误的数据源**上反复调"防重弹窗""延迟弹窗时机"。但真相是：WorkBuddy 专家团子代理的模型调用**从不落盘 traces**，真实数据在会话 transcript（`providerData.usage`）里。结果弹窗次数调对了，**弹出来的数字本身就是错的**——KET 专家团真实消耗 675.8 万 tokens，旧版只弹了 4.6 万，差 147 倍。这是第一根因：**修的是表象（弹几次），没发现地基（数据源）是错的。**

2. **v2.25 换成 transcript 数据源后数字对了，但"专家团什么时候真正结束、该结算"成了不可靠的前提。** 每次以为找到了可靠的结束信号，下一次都被真实场景击穿：子代理文件异步落盘（比 Agent 调用晚 20 秒）、用户中途插话（统计起点被刷晚）、用户手动停止（`Interrupted by user` 标记）、上下文压缩（摘要里出现中断字样被误判成停止）、子代理死寂（文件停更但任务没结束）、中文团队名 spawn 失败…… 这是第二根因：**把"判断任务结束"当成前提，而这个前提本身不可靠。**

**v2.40~v2.53 做的事：**

- **v2.40~v2.49（逐个补结束信号边界）**：语义化子代理判定（按 spawn / completed / failed 通知，而非 mtime）、死寂检测、手动停止即时信号、中断标记位置修正（有时只写在子代理文件、主 transcript 不写）、中文轮次后缀正则、上下文压缩误触发修正、确认期 10s→6s。
- **v2.50（架构重写，关键转折）**：彻底放弃"判断任务结束"，改用**增量记账**——借鉴 WorkBuddy 自己的逐笔实时记账，用水位线（watermark）逐行累加 transcript 的 usage，每个子代理文件独立记录已记账行数。任务有没有结束不重要，**落盘一行就记一行、绝不重复**。从此不再依赖任何"结束信号"。
- **v2.51~v2.53（补增量记账的收尾边界）**："停太快无 usage"的回退、中断补偿（被中断的不完整调用按最后一条完整调用 + 推理文本长度估算）、完整调用与被中断思考混合在同一轮时的合并、子代理文件被中断思考的估算。

**验证**：真实专家团任务（KET 备考 / A 股复盘 / 法律体检 / design-engine ×2 等）聚合值与手算逐行核对一致；普通轮、专家团、中途插话、手动停止、异步落盘、上下文压缩、多会话并发等场景全部通过。**现在可以正常弹窗、数字正确、只弹一次。**

### v2.39.1（2026-08-15）—— --report summary 仅合计模式

1. **只看总数**：`node token-tracker.js --report summary [all|<日期>]` 只输出每天总合计（一行/天，不含模型明细）——看"某天/全部天花了多少"只读最下面那行，省 token、省缓存。
2. **结构确认**：历史天仅存 `models`（各模型数量）+ `total`（合计），**不存每轮/每次会话明细**，文件本身紧凑。

### v2.39（2026-08-15）—— 每日分模型账本 + 长期历史 + --report

1. **每日分模型账本**：`daily-usage.json` 结构升级为 `{日期:{models:{模型:{in,out,cached,total,cost}}, total:{in,out,cached,total,cost}}}`——每天保留**两套统计**：`models` 各模型明细（多模型多行）+ `total` 不分模型的当日总合计（输入/输出/缓存命中/总 token/金额）。
2. **长期保存**：账本**不裁剪**（原保留最近 7 天），可查任意历史天；数据量极小（一天几百字节）。
3. **本地日期分桶**：`todayStr()` 改用本地时间（原 UTC，UTC+8 用户凌晨 0–8 点会把当天算成前一天），`refresh-prices.js` 同步。
4. **按模型记账**：Stop 端 transcript 数据源按模型分桶（`perModelFromRows`/`aggregatePerModel`，与 `aggregateTranscript` 同口径）；专家团 byModel 存进 coalesce 由 watcher 记账；trace 兜底按 stat.model 单桶。每轮只在最终落点记一次（复用现有防重），不重复记账。
5. **`--report` 命令**：`node token-tracker.js --report`（今天）/ `--report all`（全部天）/ `--report <日期>` 输出每日分模型明细 + 当日合计。
6. **可复用导出**：`require.main===module` 守卫 + `module.exports`（测试/回填脚本复用同一套逻辑）；旧格式 `{"date":金额}` 自动迁移。
7. 备份：`token-tracker.js.bak-20260815-v2.38`。

### v2.37（2026-08-14）—— 布局定稿 + 无效通道清理

1. **toast 两行大字布局定稿**：行1 拆成两行标题大字——第一行 = 模型名 + 时段标注（`高峰双倍`/`夜间X折`），第二行 = `耗时` + `今日¥X` + `余额¥Y`；行2 正文 = 输入/输出+缓存+费用。换行点固定在"时间"前，行1 第二行永远从行首对齐。
2. **今日累计消费**：`daily-usage.json` 按自然日累计当天所有模型总消费，toast 显示 `今日¥X.XX`（不区分模型），跨天自动开新桶、保留 7 天。
3. **行1 宽度双模型**：新增 `dispWidthTitle`（标题大字中文按 2.5 半角单位计，v2.17 实测修正），与正文 `dispWidth`（2:1）分开，行1 永不溢出换行；降级链「丢余额 → 丢今日价 → 保底耗时」。
4. **快照自动清理**：保留最近 30 天 / 最多 50 个，当前会话永不清。
5. **移除无效 `systemMessage` 注入**：WorkBuddy UI 不渲染 Stop hook 的 systemMessage（弹不进对话回复），删除该死代码；toast 为唯一结算展示通道。

### v2.31~v2.36（2026-08-14）—— 价格多源免维护 + 今日累计 + 布局演进

- **refresh-prices.js v2.2（5 源多源刷新 + 国内外区分）**：并行拉 5 个公开价格源——国内 2（llmabacus 主 / llm-prices-cn 备，人民币价）、国外 3（OpenRouter / LiteLLM / Portkey，USD 中位数×汇率）；按模型 `region` 区分定价（CN 用国内人民币价、US 用美元换算），region 自动从 llmabacus vendors country 推断；人工核验过的官方价不被自动覆盖；**全源失败写 `last_refresh_error`，toast 显示「价⚠️」**。价格从此免维护，厂商调价后 24 小时内自动跟随。
- **新模型补录国内外区分（v2.31）**：检测到未收录模型**立即联网**——先查国内源 llmabacus（`priceCurrency=CNY` 直接人民币价、`USD` 走美元），再回退 OpenRouter；已收录模型每天只刷新一次。
- **今日累计（v2.32）**：见上 v2.37 第 2 条。
- **时段标注升级**：`periodNote` 支持显示 `高峰双倍`（DeepSeek 原厂系，`peak_multiplier=2`）与 `夜间X折`（声明 `night_discount` 的模型）；⚠️ **时段策略无公开 API 数据源，需手动维护**——厂商时段政策变动时，在 `pricing.json` 更新 `peak_multiplier` / `night_discount` / `peak_hours` / `night_hours` 字段即可，代码自动读取显示。

### v2.30（2026-08-12）—— 最终版：专家团统计全面修复 + 联网开关

**本次版本修复的完整问题清单**（从 v2.23 起累积，均已在真实运行验证）：

1. **专家团 token 统计缺失（最严重）**：专家团子代理的模型调用**从不落盘 traces**，旧实现只统计到主会话第一条调用的零头（实测 KET 专家团真实消耗 **675.8万**，旧版只弹 **4.6万**，差 147 倍）。
   → **修复**：改用会话 transcript（`providerData.usage`）为权威数据源，主会话 + `subagents/*.jsonl` 全量聚合。
2. **专家团弹 N 次弹窗**：每个子代理完成触发一次 Stop，旧逻辑每次弹一次（实测 7 个专家弹 7 次）。
   → **修复**：判定专家团后写合并文件 + 后台 watcher 延迟约 6 秒，最终只弹**一条**整轮汇总。
3. **专家团中途插话漏统计**：专家团运行中用户插话把统计起点刷晚，前面调用全被排除（实测法律体检真实 409.3万，旧版只统计到 159.8万，漏 2.5 倍）。
   → **修复**：`lastStopAt` 轮次边界守卫——专家团进行中插话不刷新起点。
4. **异步子代理误判普通轮**：子代理文件比 Agent 调用晚 20 秒落盘，中途 Stop 把 `subCount=0` 误判为普通轮立即弹窗（实测 48 秒专家团弹 3 次）。
   → **修复**：`hasTeamActivity` 检测主会话是否有团队工具调用（`Agent`/`TeamCreate` 等），未落盘也能识别专家团。
5. **快照跨会话污染**：hook 用"全局最新 trace"写 snapshot，多会话并发时串入别的会话数据。
   → **修复**：snapshot.file 优先用本会话 transcript 路径（按 sid 隔离）。
6. **弹窗前闪黑窗**：`execFileSync` 漏 `windowsHide`，弹 toast 前查余额/弹通知会闪两个控制台黑窗。
   → **修复**：4 处 `execFileSync` 全部补 `windowsHide: true`。
7. **余额查询无法关闭（本次新增）**：余额查询需要联网 + 携带 API key，此前没有任何开关。
   → **修复**：新增联网开关体系（见上文「联网功能与开关」），默认零密钥联网。

**验证**：5 个真实专家团任务（KET 备考 / A 股复盘 / 法律体检 / design-engine ×2）聚合值与手算完全一致；隔离测试覆盖普通轮、专家团、中途插话、异步落盘、多会话并发、开关开闭等 14+ 场景全部通过。

## 文件结构

```
token-usage-tracker/
├── token-tracker.js          # 核心脚本：读 trace/transcript、聚合、算费用、弹 toast、联网开关、每日分模型账本、--report
├── refresh-prices.js         # 每日价格自动刷新（5 源：国内 llmabacus/llm-prices-cn + 国外 OpenRouter/LiteLLM/Portkey）
├── deepseek-official.js      # DeepSeek 官方定价页直抓（峰谷/周末规则 + 模型对齐，refresh-prices 前置）
├── recalc-day.js             # 账本单日回溯重算（价格补录/更正后重建某天金额，峰谷感知）
├── backfill.js               # 历史账本全量重建（--write 前自动备份；老账本机器慎用）
├── refresh-holidays.js       # 中国法定假日表刷新（峰谷判定的假日感知）
├── fetch-cn-prices.py        # 国内厂商官方价直抓（MiniMax/阶跃/智谱/Kimi；需 Python3 + requests）
├── parse_tokenhub.py         # 腾讯云 TokenHub 官方价解析（混元系）
├── build_index.py            # 合并 prices/latest.json + tokenhub + pricing.json(lock) → index.json
├── pricing.json              # 人民币主价（lock=人工核验权威）+ region + 峰谷/夜间字段
├── holidays.json             # 法定假日表（refresh-holidays.js 产出）
├── SKILL.md                  # 技能说明与使用指令
├── CHANGELOG.md              # 完整版本变更史（v3.18 起从 README/SKILL 拆出）
├── manifest.yaml / LICENSE / BACKLOG.md / docs/
└── prices/index.json         # 本地官方价格库（Python 流水线产出，路径自动发现）
```
- `daily-usage.json`（运行时生成，不入库）：每日分模型账本，长期保存；`--report` 查看。
- `local-config.json`（可选，不入库）：本机私有开关，如 `{"enable_balance_query": true}`。

## 系统要求

- Node.js **20+**（脚本使用内置 `fetch`）
- **Windows**：toast 走 PowerShell WinRT API（`execFileSync` 同步等待 + `windowsHide`，不闪黑窗）
- macOS / Linux：`--hook` 与手动模式可用；toast 在不支持的平台自动跳过
- 适用范围：**自有 API 与内置积分模式均统计**——只要走了模型调用就有数据

## 隐私与安全

- **默认零密钥联网**：唯一携带密钥的请求（余额查询）默认关闭；其余联网均为公开价格源，无需任何密钥。
- **实际出网主机全清单**（v3.18 起如实列出，比早期声明多）：
  - 价格源：`llmabacus.com`、`raw.githubusercontent.com`（llm-prices-cn / LiteLLM）、`openrouter.ai`、`configs.portkey.ai`、`api-docs.deepseek.com`（DeepSeek 官方定价页）
  - 国内厂商官方定价页（Python 流水线）：`platform.minimaxi.com`、`platform.stepfun.com`（经 `platform.kimi.com` 的 Kimi 文档）、`docs.bigmodel.cn`、`cloud.tencent.com`
  - 假日表：`api.github.com`；版本检查：`api.github.com`
  - 余额查询（默认关）：`api.deepseek.com`
  - **所有请求均为只读 GET，不携带本地数据/模型名/对话内容**（OpenRouter 等聚合源为全量价表拉取）。
- **本地写盘位置**：技能目录（快照/账本/水位线/`.balance.json`）、`~/.workbuddy/`（toast 与 compaction 诊断日志）、价格库工作区 `~/WorkBuddy/<工作区>/prices/`。诊断日志含 sessionId 与 transcript 末行**指纹**（sha1 短哈希 + 长度，v3.18 起不再存对话原文片段）。
- **不修改任何平台文件**：只读 traces/transcript，只写上述自有文件。
- **余额查询**：仅访问 DeepSeek 官方接口，密钥只经 Bearer 头发给官方域名，缓存不存 key，key 不进进程命令行（详见上文「余额查询安全性说明」）。
- 无遥测、无埋点、无第三方统计。
- **已知限制**：`region=US` 模型的人民币主价 = USD 源中位数 × 固定汇率 7.2（`usd_cny_rate`），汇率不自动跟踪市场。

## 免责声明

本技能是独立的第三方工具，与 WorkBuddy 官方无隶属或授权关系。WorkBuddy 名称及相关商标归其权利人所有。

## License

[MIT](LICENSE)

## SKILL.md 历史版本要点（原样迁移）

> **v3.16 要点（2026-09-28）：吸收社区 PR/Issue 三项修复 —— ①数据根智能探测（不再写死 `~/.workbuddy`，兼容迁移到 `~/.workbuddy-ai` 的客户端，`WB_ROOT` 仍最高优先，4 脚本同步）；②`transcript_path` 被客户端截断时按 `session_id` 兜底匹配（外部用户实测场景：toast 有显示但账本永远记不上，已沙箱复现+修复验证）；③陈旧模型清理措辞修正（与 v2.82 代码一致：从未出现在账本的模型一律保留）。**

> **v3.15 要点（2026-09-28）：法定节假日感知的峰谷判定 —— 修正"法定假日被当高峰、多算一倍"。**
> - **官方口径**（`api-docs.deepseek.com/quick_start/pricing`）：峰时段 = 工作日 **01:00-04:00 / 06:00-10:00 UTC**（= 北京 **09:00-12:00 / 14:00-18:00**），**不含中国法定假日**；其余时段（含**周末**与**法定假日全天**）一律低峰。
> - **修正的问题**：此前只判周末、不判假日 → **法定假日里的 9-12 / 14-18 点被按高峰 ×2 计费（金额高估一倍）**。
> - **新增数据与工具**：
>   - `holidays.json` —— 放假日列表（按年）；`refresh-holidays.js` —— 抓取脚本（**双源交叉验证**）。
>   - **主源** `NateScarlet/holiday-cn`（自动抓国务院公告，2178★）；**校验源** `HankAviator/china-holiday-calendar`（其 `source.source_url` 直指 **gov.cn 国务院办公厅公告原文**）。
>   - **策略**：两源一致 → 采用；**不一致 → 取交集（保守）**，并把 `only_a` / `only_b` 差异写入 `cross_check` 供人工核查；单源可用 → 采用该源。
>   - **实测**：2025 = 28 天（两源一致 ✓）；2026 = 33 天（两源一致 ✓）；2027 = 公告未出（0 天）。
> - **代码改动（两处必须同步，否则回溯对账会打架）**：`token-tracker.js: isPeakHour()` 与 `recalc-day.js: isPeakBeijing()` 均加入假日判定；**数据缺失/解析失败 → 自动降级为原行为**（不判假、不报错）。
> - **实测结果**：**单测 22/22 通过**（假日→低峰 ✓、工作日峰时段→高峰 ✓、周末→低峰 ✓、无数据→降级旧行为 ✓）；`node --check` 三个文件全 OK。
> - **更新方式**：每年国务院公告发布后跑一次 `node refresh-holidays.js`（也可挂进每日价格刷新流程）。

> **v3.14 要点（2026-09-28）：① 余额查询已开启（弹窗第二行恢复「余额¥X」）；② 新增「Windows 不弹横幅」排查说明。**
> - **① 余额显示已开启**：`ENABLE_BALANCE_QUERY` 由默认 `false` 改为 **`true`**（用户指令）。数据来自官方 `https://api.deepseek.com/user/balance`，key 从 `models.json` 读取、**仅本机使用、不外传**，15 秒缓存。显示位置＝弹窗**第二行**：`耗时 X 今日¥Y 余额¥Z`。
>   - **显示规则保留「变化检测」（用户 2026-09-28 明确要求保留）**：首次观测只记基线不显示；**余额与上次观测不同才显示**。理由（用户原话）：*"它无法判断你用的是 API 还是 WorkBuddy 自带的，**只有余额变动了才知道用的是 API**"*。→ 余额稳定不动时不显示余额段，这是**设计行为，不是故障**。
>   - 兜底：查不到且有旧缓存 → 用旧值；连缓存都没有 → 不显示（绝不显示错数字）。
>   - **宽度实测（第二行上限 `TOAST_ROW2_MAX_W = 42`）**：典型场景 31 宽；今日/余额各 4 位 38 宽；**极端各 5 位数（¥12345.67）40 宽** → 均不超宽，余额不会因宽度被丢弃。
> - **② 「通知不弹横幅」的排查与修复**：详细说明与命令见**本文最前面的《常见故障：通知「不弹横幅」》一节**（Windows 的「通知建议」会把长期未点开的应用通知静默为"只进通知中心"，并写入 `ShowBanner=0`；本技能用自定义 AppId，设置界面里找不到，只能改注册表）。

> **v3.13 要点（2026-09-23）：两处准确性修复 —— ① 子代理行级时间戳过滤统一口径；② 团队轮"差几毫秒就白拆两条"的有界微重判。**
> - **① 口径统一（准确性修复·重要）**：`aggregateTranscript` 合并子代理时原先传 `0`（**不做行级时间戳过滤**），只靠文件 mtime 归属本轮 → 当子代理文件被**唤醒/复用**（如给旧成员发消息）时，文件 mtime 变新但**含更早轮次的行** → **弹窗数字偏大**。真实数据实测：唤醒 `agent-51c238cc` 后，**连续 5 轮各多算 82.0 万 token**。现改为传 `roundStartMs` 做行级过滤，与拆分路径 `aggregateSubsOnly` 口径一致。
>   - **守恒验证**：同一份真实数据下 —— 改前「单条 1108.7万 vs 拆分 1028.6万（差 80.1万 ✗）」；改后「单条 1417.9万 vs 拆分 1417.9万（输入差 **0.00万** ✓）」。输出的 0.1 万残差来自两次测试各自复制的 transcript 间隔数秒（非口径问题）。
>   - **账本不受影响**：账本走 `.ledger-watermark.json` 行数水位线，同一行只记一次；本次只修"每次全量重算"的弹窗路径。
> - **② 有界微重判（消掉误拆）**：原判据只看 mtime 活跃窗（20s）→ 子代理"刚写完但差 <20s"被判"仍在跑"，白拆两条（实测 01:45：文件 01:45:05.904 写完，Stop 在 01:45:05.2，**只差 0.7 秒**）。新增：`pending===0` 且文件"刚活跃"时，最多重判 3 次（每次 700ms，共 ~2.1s），其间只要**本轮子代理文件全部为终止态**（`allInRoundSubFilesTerminal`：末行 `role=assistant` 且 `status!=='incomplete'`）即放行**单条完整弹窗**；超预算仍走拆分兜底。日志标记 `stop-sub-wait-resolved`。**准确性优先：仅当全部文件确认终止才放行，绝不漏 token。** 关闭开关 `WB_NO_SUB_WAIT=1`。
>   - **⚠️ 已知取舍**：被取消/中断的子代理末行永远是 `incomplete` → **不放行**（宁拆不错）；Stop 最多多花 ~2 秒。

> **v3.12 要点（2026-09-23）：异常轮拆分弹窗兜底（先主模型、后补子代理）。**
> - **动机**：团队轮若在 Stop 那一刻子代理**仍在运行/卡死**，旧逻辑走 watcher → 弹窗延迟到"下一个事件"才出（实测延迟 1~10 分钟），若一直无事件则**永远不弹**。
> - **实现**：Stop 新增第三分支（条件 `teamActive === true && !teamDataReady`）→ ① **立刻**弹【主模型】条（标注「子代理运行中」，**不 sleep/不轮询**：实测子代理落盘滞后 0.0 秒，等待无收益且 hook 超时预算未知）② 把 `mainToastedAt` 写进 coalesce ③ 仍启动 watcher。补弹路径（watcher 出口 + `--hook` 兜底）见到 `mainToastedAt` → **只弹【子代理】条**（reason `team-sub-only`）并清理 coalesce，**不重复计主模型**。
> - **新增函数**：`aggregateMainOnly`（只聚合主转录）/ `aggregateSubsOnly`（只聚合子代理文件）/ `toastLineTagged`（第一行插标注，超宽放弃标注）。
> - **实测（隔离 `WB_ROOT` + 真 CLI + 真实 transcript 复制件 + 真实 trace，`TOKEN_TRACKER_NO_TOAST=1`）**：
>   - 普通轮 → 1 条无标注 ✓；团队轮·子代理已结束 → 1 条完整（v3.11 的「（子代理 X）」标注）✓
>   - **异常轮 → Stop 弹主模型条 + 子代理结束后补弹【子代理】条** ✓；重复触发**不重复弹** ✓；coalesce 正确清理 ✓
>   - 真实文件零改动（toast 日志行数/md5 前后一致）✓
>   - 「子代理刚结束未满 20 秒」被误拆的频率：**真实数据 0/23**（子代理末行比主转录末行早 25~3974 秒）→ 误伤风险极低。
> - **⚠️ 排查备忘（花了很久，记此）**：**补弹路径依赖 trace 文件存在**——在"沙箱未造 trace"的夹具里会测出"补弹不触发"，那是**夹具缺失的假象**，非代码缺陷。下次排查同类问题先确认 trace 是否齐备。
> - **紧急开关**：`WB_TEAM_SPLIT=0` → 回到 v3.11 行为（异常轮仍走 watcher，延迟但最终弹一条完整的）。
> - **已知依赖**：`aggregateSubsOnly` 仅按**文件 mtime** 过滤"本轮"子代理；若 mtime 被外部改动（备份还原/复制），可能把旧轮用量算进来（建议后续加内部 timestamp 二次过滤）。

> **v3.11 要点（2026-09-23）：弹窗第一行改为「主模型（子代理 X）」。**
> - **根因**：聚合出口 `aggregateTranscript`（约 :1158）的 `model: (sub && sub.model) || (main && main.model) || ''` —— **子代理模型优先于主模型**，团队轮标题因此显示成 `hy3`（子代理用的混元3），用户误以为"我用的模型变了/计费错了"。**同时**该 `model` 字段还被 `calcCost`（:2197）用来取价目表算全轮费用。
> - **修法（只动显示，不碰计费）**：新增 `modelMain`（主转录主导模型）与 `subModels`（子代理模型，按 token 降序去重）两个字段；`shortModelName` 显示时优先取 `modelMain`；`toastLine1` 在第一行模型名后追加 `（子代理 X）`。
> - **显示规则（用户 2026-09-23 定稿）**：① 第一个**必须是主模型**；② 第一行**最多两个模型名**（主 + 1 个子代理，多余只标「等」）；③ **子代理模型与主模型相同时不标注**；④ 超宽**先截断子代理段**，预算不足则整段丢弃（主模型完整保留）；⑤ 仅动第一行，耗时/今日/余额/输入输出那两行不变。
> - **⚠️ 绝不能改的**：`stat.model` 保持原样（`sub.model` 优先）——`calcCost` 用它取价目表，改了会让费用静默换价目表。
> - **实测（真 CLI + 隔离 WB_ROOT + `TOKEN_TRACKER_NO_TOAST=1`，读真实生成的弹窗日志）**：真实团队轮 → `deepseek-v4.1-flash（子代理 hy3）`（宽 33 ≤45）；合成 5 用例全过（无子代理不标注 / 同模型不标注 / 子代理超长名截断至 43 / 主模型超长截断至 45）；真实文件零改动。
> - **附带发现（未修，待定）**：团队轮的弹窗**费用**仍按 `stat.model`（=子代理模型）单一价目表计算全轮 token —— 主模型与子代理价差大时会偏。账本按模型分桶记账，**不受影响**；仅弹窗那个 ¥ 是近似值。

> **v3.10 要点（2026-09-22，经两名独立验证员复核后定稿）：两处「改这里引出那里」的修正。**
> - **① 取消否决条件改为「精确编辑重发匹配」（推翻 v3.08 的"完成行否决"）**：独立验证员全库分类 247 处取消标记 → **E=12**（有精确 `resend-fork-notice` 匹配 = 真编辑重发）／**C=208**（**无** resend、标记后先出现普通用户提问再出现完成行 = **真取消 + 用户随后又提问**）／U=27。按 v3.08 的"其后有完成行即否决"计算，**误杀率 = 208/220 = 94.5%** —— 后果正是 v2.83 治过的病（取消轮不补弹 → token 静默并入下一轮；第三方证据：日志里 42 条 `cancelled-*` 弹窗、23 个 C 类样本在取消后 7~31 秒确曾正常补弹）。**现改为**：取标记之前最近一条 `role==='user'` 消息的 `id`，全文找 `type==='resend-fork-notice'` 且 `editedUserItemId === 该 id` 才否决。实测：事故（E 类）仍被正确否决，C 类真取消（1686e062=6 个 / a24fe947=3 个 / 9d97d713=5 个）恢复识别。
> - **② 修复D 加"子代理活跃"兜底（修 BUG-1，独立验证员发现）**：修复D 原判据只看 `subagentPending().length===0`，但该函数在 **Agent 调用取不到可解析 name 时（中文团队/无 name 字段）会假空返回 []**（本文件 v2.47 注释早已记录同源问题）→ 会导致 ①本轮弹窗少算仍在跑的子代理用量 ②推进 `lastStopAt` 后子代理后续输出再无 watcher 接管（弹窗丢失；账本不受影响）。**现复用本文件既有的 `hasSubagentsRecentlyActive(tsPath, SUBAGENT_IDLE_MS=20s)`**（:1462，原本就用于 pending 假空兜底）作为第二道判据。⚠️ 不要改用"子代理末行是否都已收尾"——被取消/中断的子代理文件末行永远是 `incomplete`（真实会话实测 21 个子代理中 3 个如此），那样会让本快速路径永不触发。
> - **验证实证**：真实团队轮 `pending=0 && recentlyActive=false` → `teamDataReady=true`（快速路径生效）；反向对照（30 天窗口）返回 true，证明该函数确按 mtime 判定。另经复核：**轮次边界无偏差、不会同轮双弹、no-token 推进 `lastStopAt` 端到端通过、`interruptedByUser` 不漏检**。

> **v3.09 要点（2026-09-22 深夜，已被 v3.10 修正）：撤回 v3.08 的 `skipRun` 判据（前提被实证推翻）；修团队轮弹窗延迟（修复D）。**
> - **撤回 `skipRun` 判据（重要，勿再犯）**：v3.08 曾用「标记行 `skipRun===true` → 非取消」，其前提（skipRun = 编辑重发特征）**已被全库实证推翻**——扫描 207 个 transcript（274 MB），命中正规取消标记 **183 处，183/183 全部带 `providerData.skipRun=true`**。它是应用中止在飞请求的**通用字段**（用户点停止 / 编辑重发 / 分叉 都会写），**据此排除会 100% 灭掉真实取消检测**。现已删除该判据并就地注释固化证据。⚠️ 注意字段实际位于 **`providerData.skipRun`**（非顶层 `r.skipRun`）——v3.08 的实现因路径写错恰好空转未酿祸，但属**地雷**。保留有效的「后续完成行即否决」。
> - **修复D：团队轮弹窗时效（可能延迟 1~10 分钟、甚至不弹）**。根因：Stop 时若判为团队轮（`subCount>0 || teamActive`）→ 写 coalesce + `startWatcherVerified` spawn watcher；而 watcher 的降级兜底**只在「spawn 未接管」时触发**，覆盖不了「**spawn 成功但随后被宿主进程收割**」（现场遗留 `.coalesce-*.json.lock`、无 toast）→ 只能等下一轮 `--hook` 补弹。实测 2026-09-22 三连：23:21:33 / 23:33:42 / 23:47:34 三条团队轮弹窗**全部**靠 `hook-fallback` 补出，延迟 1~10 分钟。修法：Stop 时若 `subagentPending(tsPath).length === 0`（子代理已全部收尾 = 数据已齐）→ **直接走同步立即弹窗**，不再 spawn watcher。实测该团队轮 transcript 的 pending = 0 → 三连延迟全部消除；账本不受影响（走行数水位线），受损的只是弹窗时效。

> **v3.08 要点（2026-09-22）：修复「未取消却弹（手动取消）」的取消误判。**（⚠️ 本段所述 `skipRun` 判据已被 v3.09 撤回，见上条；实际生效的是「后续完成行即否决」+「no-token 分支推进 lastStopAt」）
> - **根因（实测会话 b017080d-78d5-441a-9e33-fa89a0902c6d，2026-09-22 23:10~23:22）**：用户编辑后重发/分叉消息时，应用会**中止在飞请求并写一个通用中断标记**（`role=assistant`/`status=incomplete`/`error.message="Interrupted by user"`/`skipRun=true`），主轮之后继续正常跑到完成——**主轮从未被用户取消**。但兜底判定把这条标记当成「用户手动取消」：
>   ① 该标记带 `skipRun=true`，旧逻辑未排除；② 标记之后主轮**正常完成**，旧逻辑却在遇到注入型 `user`（task-notification）行时 `break` 直接采信标记、根本没检查到后续的完成行；③ 23:10:09 的 Stop 走 no-token 分支**不推进 `lastStopAt`**（停在 23:06:05），导致 23:21 注入行唤起兜底时 `intrInfo.ts > lastStopAt` 仍成立 → 误弹「（手动取消）」，整轮 10m31s 被错标。
> - **修复 1（治本·收窄取消判据，`interruptedRowsAfter` / `interruptedByUser`）**：(a) 命中标记行若 `skipRun===true` 一律不认定为取消；(b) 命中后**扫完全部后续行**，只要存在任意「正常完成」的 `assistant`（`status!=='incomplete'`）行即判非取消、返回空——不再中途 break 采信标记；(c) 注入型 `user` 行不参与 break/续跑判断。真实取消（标记无 `skipRun` 且其后无完成行）仍必识别。
> - **修复 2（堵触发链·no-token 分支推进 `lastStopAt`）**：no-token Stop 返回前同样 `saveSnapshot` 写入 `lastStopAt: Date.now()`，使后续注入行唤起兜底时 `intrInfo.ts > lastStopAt` 不再成立，从根上断掉「旧标记被注入行复活」的链条。两处修复独立即可挡住本次事故。
> - **验证**：`WB_ROOT` 隔离回放真实事故 transcript → 不再误判；合成「标记无 skipRun、其后无完成行」→ 仍识别为取消；普通轮/重复弹回归正常；真实账本与价库 md5 零改动。

> **v3.07 要点（2026-09-16）：DeepSeek 官方价「跨 key 接管」——手动补录价不再永久锁死。**
> - **背景**：用户手动补录 `deepseek-v4.1-flash`（1/0.02/4），而官方现行 API ID 是 `deepseek-flash`（页内「模型版本」= DeepSeek-V4.1-Flash）。旧逻辑只按官方 ID 精确匹配本地 key → **永远匹配不上** → 手动条目停在 `_manual_audit.status=pending-official`、`official:null`，且带 `manual`+`lock` 双标记被彻底冻结（`refresh-prices.js:468` 直接跳过覆盖）→ 官方再调价也不更新（静默用过期价）。
> - **修复（deepseek-official.js）**：解析官方页「模型版本」行，用去标点归一化（`DeepSeek-V4.1-Flash` → `deepseekv41flash`）与本地 key/name 对齐；命中即判定同一模型 → ① 官方价**强制覆盖**手动价 ② 删除 `manual`/`manual_at`/`lock`（解冻）③ 打 `alias_of=<官方ID>`（保留本地 key 供运行时匹配，并豁免 retired 扫描）④ 写 `_manual_audit`（manual vs official + diff + `official-adopted`）。只接管「手动条目」或「已绑定别名的条目」，不做无差别改名。
> - **配套（refresh-prices.js）**：官方价解析加别名回退 `official.official[m.alias_of]`——否则别名条目会落进聚合源分支、被 llmabacus 价覆盖掉刚写入的官方价；14 天清理同样豁免别名条目。
> - **测试**：隔离 `WB_ROOT` 端到端（官方抓取 + `--force` 五源全成功）——接管后别名条目在聚合源刷新下**保持官方价不被劫持**；真实价库零误写；`--report` 计费回归正常。

> **v3.06 要点（2026-09-11 深夜 ~ 09-12 凌晨）：弹窗系统性失效根修 + 解耦 + 全面测试加固。**
>
> **① 弹窗彻底不弹的根修（本次最重要）**
> - **根因**：WorkBuddy 新版在 hook 进程结束后会**连带终止其派生的 detached 子进程**。原实现靠 `spawn(detached+unref)` 起的后台 watcher 刚起来就被杀，且 `cp.spawn` 的失败是**异步 `'error'` 事件**，原代码没有监听 → **完全静默**（无日志、无降级、调用方以为已启动）。
> - **修复**：`spawnFlushWatcher` 补 `child.on('error')` 监听（留痕）；新增 `startWatcherVerified()` 校验 watcher 是否真接管；**普通轮（无子代理/无团队活动）改为同步立即弹窗**，不再依赖后台子进程；专家团才走 watcher。
> - **副作用修复**：普通轮同步弹窗后需**自己推进 lastStopAt**（原由 watcher 推进），否则下轮会误判"上轮未结束"→ 弹窗数值偏大。
>
> **② 解耦（抗 WorkBuddy 更新）**
> - 价库路径由**硬编码工作区**改为 `autoDiscoverCnPriceDir()` 四级自适应：环境变量 → 自动扫描 `~/WorkBuddy/*/prices` 取最新 → **技能自身目录副本** → 旧路径。已建立兜底副本（31 模型），**工作区消失也能用**。
> - 新增 **schema 漂移留痕**：usage 字段读不到且行数达标时记 `schema-drift-suspect`，让"上游改字段导致算错"有据可查（正常轮次 0 误报）。
>
> **③ 全面测试发现并修复的问题**
> - **watcher 抢锁失败 → TDZ 崩溃**（`appendWatchDebug` const 定义在使用之后）：定义前移，修复后 `exit=0`。
> - **已结算轮重复弹窗**（重试用 `roundStart0` 回退到已结算区间）：统一改用 `aggStart0`，窗口不回退。
> - **取消轮"零已完成用量"漏补弹**：估算提到判断前，零用量但有估算时构造基底 agg（两处取消路径均已修）。
> - 水位线 **UTF-8 BOM 导致记账被跳过**：已去 BOM（教训：勿用 `Out-File -Encoding utf8` 写会被 JSON 解析的文件）。
> - `recordUsage` 的"损坏跳过"守卫：**审查后保持原顺序不改**（改为"先 load 再判断"反而会丢本轮用量），已补注释说明。

> **v2.99 要点（2026-09-10）：全方位测试后修复 6 项，重点是消灭「账本静默失真」。**
> 本轮由 4 个测试子代理并行扫描 4 个维度（解析健壮性 / 入口流程 / 计费定价 / 状态并发），
> 报告 11 项**全部经我逐条复核确证**（子代理零误报，因指令强制"每条必附可复现命令+输出"）。
>
> **已修复 6 项（每项均验等价性，正常路径零行为变化）：**
> | # | 问题 | 严重度 |
> |---|---|---|
> | a | `extractUsage` 不校验 token 类型 → 字符串触发**字符串拼接**（`"100"+200="100200"`），账本脏掉难察觉 | 防御性（真实 9574 样本全为 int）|
> | b | **隔离泄漏**：`TOAST_LOG_PATH` / `COMPACTION_LOG_PATH` 硬编码 `os.homedir()` 绕过 `WB_ROOT`，测试污染真实日志（实测 16 行）| 中 |
> | c | 价库**存在但损坏**时完全静默——比"缺失"更危险：文件在，用户不会怀疑，但国内模型已悄然无价 | 中 |
> | d | `calcCost` 对负数 out/cached 无钳制 → 负 out 产生**负总价**污染账本；负 cached 令账单**失真放大** | 防御性 |
> | e | **水位线 `.bak` 自动回退 = 重复计费**（`.bak` 恒落后一个保存周期，回退会把已记增量重放；实测多记 5500 in / 1600 out），**违反本函数自身"宁可少记不重复"原则** | **高** |
> | f | **账本损坏标志被误清**：`loadDailyUsage` 开头无条件 `gDailyCorrupt=false`，同进程第二次调用因文件已被 rename 走 ENOENT → 标志清 → **用空账本写回、历史丢失**（日志却称"不写回覆盖"）| **高** |
>
> **安全性确认**：A/B 等价性验证（解析 8/8、计费 5/5 样本零差异）+ 真实账本健康度检查
> （无负数、无 cached>in、无金额异常跳变）+ 端到端 `--report` 冒烟正常。
> **计数/计消耗零误报。**
>
> **⏸️ 评估后未采纳（设计取舍，非缺陷）：**
> - `findModel` 边界匹配让未收录变体按家族基价计费（`deepseek-v4-flash-lite` → 更贵的 `deepseek-v4-flash`）——v2.82.1 有意设计（`hy3-x→hy3` 同逻辑），改会破坏正常变体匹配。风险为"变体更便宜时静默高估"，**记录待评估**。
> - 跨零点峰谷窗口（s>e，如 22:00-02:00）被跳过——官方当前无此档，属预留简化。

> **v2.98 要点（2026-09-10）：弹窗标注区分「子代理」与「专家团」两种形态 + 判定依据升级为转录内字段。**
>
> **① 形态区分（用户要求"这些更多的区分都要考虑到"）**
> 依据官方文档（workbuddy.cn/docs/cli/agent-teams）与 86 份真实子代理转录实测：
> | 形态 | 判定特征 | 弹窗标注 |
> |---|---|---|
> | **Sub-agents（子代理）** | `providerData.agent` = 内置类型名（Explore / Plan / general-purpose），**无** `agentColor` | `（子代理使用）` |
> | **Agent Teams（专家团）** | `providerData.agent` = 专家角色名（topic-researcher / prototype-builder / critique-reviewer…），**有** `agentColor` | `（专家团使用）` |
> | 子代理与主模型**同模型** | 按模型分桶天然并入主弹窗 | 不标注（符合"同模型汇总"要求） |
> | 子代理与主模型**不同模型** | 独立弹窗 | 按上表标注 |
>
> **② 判定依据升级**：由"仅靠 subagents/ 目录位置"升级为**优先读转录内 `providerData.isSubAgent === true`**（最硬证据），目录位置作为兜底。
>
> **③ 不变的安全原则**：纯读取、不改任何现有数据结构；异常一律返回空 Map → 退化为不标注；仍**减去本轮主转录出现过的模型**（宁可漏标不可误标）。
>
> **验证**：语法 ✓；真实数据判定 ✓（普通子代理 → 「子代理使用」；专家团样本 → 「专家团使用」）。

> **v2.96 要点（2026-09-10）：价库失效告警 + 热路径局部缓存 + reasoning 数据提取。**
>
> **① 价库缺失不再静默**：`mergeLocalPriceDb` 读取失败时原先直接 `return pricing`，会让国内模型价格悄悄退化为聚合源/估算价而**全程无提示**（与 Exa 断链同类"静默失效"病）。现增加 stderr 告警。**仅加告警、不改路径解析**——避免牵动同目录的 `CN_PRICE_REFRESH_LOCK` / `.refresh.error` 带来的联动风险。
>
> **② 热路径局部缓存**：取消路径原先对同一 transcript 全量读 2 次（叠加 `aggregateTranscript` 内部共 3 次），改为读一次复用。**仅合并外围两处**——`aggregateTranscript` 内部还聚合 `subagents/` 目录，不能简单替换为 `aggregateTranscLines`（会丢失子代理数据）。
>
> **③ reasoning_tokens 提取**：`extractUsage()` 新增 `reasoning` 字段（两个位点：`usage.outputTokensDetails[]` 与 `rawUsage.completion_tokens_details`），`aggregateTranscLines()` 同步累加并透出。**账本零影响**——`addModelUsage()` 显式只取 in/out/cached/total。实测该值占输出 **63.8%**。
>
> **⏸️ 评估后搁置两项**：
> - **P0-1 峰谷改用事件时间**——属**架构级改动**：账本按天累加，而峰谷要求按"每次调用"计价，不是加个参数能解决的，需重设计费模型。
> - **reasoning 的弹窗展示**——需打通 `span → aggregateRound → 弹窗` 链路，改动面大、收益有限。

> **v2.95 要点（2026-09-10）：子代理弹窗标注 + 时区统一。**
>
> **① 子代理弹窗标注（用户需求）。** 新增 `subagentModelSet(tsPath, roundStartMs)`：弹窗时若本轮模型**仅由子代理产生**（出现在 `subagents/*.jsonl`、且**本轮主转录未出现**该模型），首行注明「**（子代理使用）**」。
> - **同模型子代理** → 按模型分桶天然并入同一弹窗（按用户要求：同模型汇总、不标注）；**不同模型** → 各自独立弹窗并标注。
> - **纯新增、零副作用**：不修改任何现有函数的返回值或数据结构（避免标记字段被 `recordUsage` 写进账本污染数据）；任何异常一律退化为空集合 = 不标注，绝不因标注失败影响主流程。
> - **关键修正（实操中发现）**：必须**减去本轮主转录出现过的模型**——同一模型（如 hy3）时而作主模型、时而作子代理，只比对子代理集合会把主模型轮次**误标**。宁可漏标不可误标。
> - 已接入 2 条弹窗路径：watcher 主路径、hook 兜底路径。
>
> **② 时区统一。** `isPeakHour` / `isNightHour` 由「机器本地时区」改为**北京时间**（与 `recalc-day.js` 的 `isPeakBeijing` 口径一致）。GMT+8 机器下**零行为变化**（已验算 12:32/周四 两实现完全一致），非 GMT+8 机器不再与回填工具判定相悖。
>
> **验证**：语法 ✓；端到端 `--report` 实际加载执行正常 ✓；关键函数可达性 ✓；GMT+8 等价性验算 ✓；子代理标注按轮验证（本轮 hy3：主转录 0 次 / 子代理 178 次 → 正确标注）✓

> **v2.94 要点（2026-09-10）：自动补录按模型族写正确峰谷倍率。**
> `addModelPrice()` 原先把 `peak_multiplier` 一律写死为 `1`（number）→ 绕过 `calcCost()` 对 DeepSeek 系的"缺省按 2"逻辑（`typeof === 'number'` 成立即不取缺省）→ **新收录的 DeepSeek 模型高峰不翻倍、长期静默低估**。
> 现改为按模型族写正确值（判定正则与 `calcCost` 一致：`/(^|[\/\-_])deepseek/i`）：**DeepSeek 写 2，其余写 1**。
> **为何不直接删字段**：显示层 `periodPeakNote()` 无 DeepSeek 缺省分支（缺省一律 1），删字段会造成"计费×2 但弹窗不显示高峰双倍"的新不一致 → 故显式写正确 number，**零联动副作用**（已验证：6 个模型样本计费倍率与显示倍率完全一致；非 DeepSeek 行为与改动前等价）。

> **v2.93 要点（2026-09-10）：官方模型名正则放宽 + 账本回溯重算。**
>
> **① 官方页「自动新增」修复（根因级）。** 旧代码 `out.models = header.filter(s => /^deepseek-v4-/.test(s))` 在官方上架 **`deepseek-v4.1-flash`** 这类**带点版本号**的模型时会**静默漏掉**（第 12 字符是 `.` 不是 `-`）。后果比"少一个模型"严重得多：价格行的数字个数仍是全部模型的，`grab()` 按模型数 `slice(0,n)` 取值 → **其余模型价格整体错位**（v4-pro 拿到 v4.1 的价、vision-exp 拿到 v4-pro 的价），且**不报错**。已放宽为 `/^deepseek-/`，新模型名（v4.1 / v4-1 / 未来任意 `deepseek-*`）均可自动收录。
>
> **② 账本回溯重算（`recalc-day.js`）。** 补录只能让**之后的**消耗计上价，当天之前已按"未收录"记成 ¥0 的部分永远是 0。新工具按现价 + 峰谷重算指定日期的历史数据：
> ```
> node recalc-day.js                  # 重算今天
> node recalc-day.js 2026-09-10        # 重算指定日期
> node recalc-day.js 2026-09-10 deepseek-v4.1-flash
> ```
> 峰谷判定读 `token-tracker-toast.log` 里该模型当天的轮次时间戳（工作日 9:00–12:00 / 14:00–18:00 北京为高峰），按轮次占比近似 token 占比；无轮次数据时保守按空闲价并标注。独立进程，**不侵入 token-tracker.js 主链路**。
>
> **验证**：隔离环境（临时 `WB_ROOT` + 本地假官方页）双用例通过——T1「官方上架后自动新增」、T2「官方收录后对账交接（`_manual_audit` 写入、diff 0%）」；真实数据 09-10 回溯 ¥0.5012 → ¥1.8643（4 轮全在高峰时段，与逐轮手工核算一致）。

> **v2.92 要点（2026-09-10）：新模型「手动补录 + 官方价自动对账」。** 新模型在客户端已上线、但官方定价页/聚合源尚未收录时（如 DeepSeek-V4.1 Flash），自动补录必然失败，且会被 `_lookedup_models` 锁死不再重试。此前唯一出路是手改 pricing.json，而手改有两个坑：①`deepseek-official.js` 的官方对齐会**无条件重建**条目价格（`lock` 挡不住），手改的价次日被官方页旧价覆盖回去；②官方清单里没有的 DeepSeek 模型会被自动标 `retired`（= 不再计费），手动新增的条目次日即失效。
>
> **解法三件套**：
> ① **手动补录**：条目带 `manual:true` + `manual_at` + `lock:true`，价格取自官方公告（新区块字段 `price_source` 注明来源与生效时间）；
> ② **代码豁免**（`deepseek-official.js` retired 扫描）：`manual` 条目跳过「官方未收录 → 下线」，不被 retired；
> ③ **自动对账**：官方源一旦收录该模型，对齐逻辑把 `手动值 / 官方值 / 差异百分比` 写入 `pricing._manual_audit`（`status: official-adopted`），并按官方价接管（重建时不带 manual 标记）——**无需人工比对，差异自动留痕可回查**。
>
> **口径**：官方未收录期间按手动价计费；官方收录后自动切官方价 + 留痕；查 `pricing.json` 的 `_manual_audit` 即可看差异。

> **v2.91 要点（2026-09-05）：** 取消检测升级为**双信号 + 自适应静默**。**信号①（新增）**：工作区日志 `~/.workbuddy/logs/<today>/<工作区名>__*.log` 的 `[ACP Agent] cancel: received cancel request for session <sid>`——客户端源码实证每次取消必写（含 Aborting 与 Ignoring idle 两分支），round watcher 增量扫描此文件作为取消确认第二源，标记行缺失/延迟也能确认（hook 端 resolveWorkspaceLogFile 按 payload.cwd 的 basename 定位日志文件，mtime 最新者；watcher 增量读 offset 防历史误报）。**信号②**：transcript 取消标记行（原有）。**自适应静默**：取消确认后一旦发现新 usage 行落盘且稳定 `ROUND_WATCH_ADAPT_QUIET_MS`（默认 2s）→ 提前弹（典型 3~5s）；无新 usage → 8s 兜底弹（含 no-token 提示）。**测试基建**：`TOKEN_TRACKER_NO_TOAST=1` 测试静默开关（showToast 只写诊断日志不调系统通知，硬规矩：一切测试必须设此开关+windowsHide，禁止真弹窗骚扰前台）。端到端验证：S1 日志信号确认（标记行缺失场景）→ 聚合弹「4万/2000」精确；S2 自适应提前弹 4.8s（固定静默需 6s+）。

> **v2.89 要点（2026-09-05）：** **v2.85 实时取消补弹失效根因修复——spawn 调用点丢失**。用户发现 18:29 取消走的是兜底（cancelled-round-flush）而非实时补弹。取证（compaction log + toast log + git diff）：① 客户端行为变化确认——08-25~09-02 的 30+ 次取消全部是 `interrupted` 即时弹（Stop hook 触发），09-03 起取消不再稳定触发 Stop hook（v2.83 实测的 SessionAbortMiddleware 挂起），出现 cancelled-round-flush 兜底；② **v2.85 的 round watcher 弹窗三分支/watcher 主体/--round-watch 入口全部完好，但两处 spawnRoundWatcher 调用点（hook 守卫尾部 + 兜底尾部）在后续编辑中丢失**——round watcher 从未被启动，真实取消 100% 退化兜底；③ 旧测试直接调 `--round-watch` 入口测 watcher 主体，**未覆盖 spawn 链路**，6 项回放全 PASS 仍漏检。修复：补回两处调用点 + **端到端测试**（--hook → spawn → 写取消标记 → watcher 2.5s 实时弹）验证通过。

> **v2.88 要点（2026-09-05）：** 弹窗/hook 注入行**耗时显示压缩盲区修复**——压缩（contextSummary）不写 trace 文件，`traceWallDurMs` 的"最新 trace endedAt"停在模型回复结束，轮尾压缩段耗时整个漏掉（实测 09-05：弹窗显示 4m6s、客户端实际 12m49s，差 3 倍；hook 注入行同款 4m5s）。修复：endedAt 取 **max(trace.endedAt, transcript 末行 timestamp)**——transcript 是唯一覆盖全轮（含压缩）的数据源，压缩 marker/调用行 ts 补全压缩段；起点恢复**整轮起点**（v2.86 曾误用 aggStart0）；hook 注入行同源修复（asHook 路径内 stat.durMs 增强，作用域正确、快照保留 trace 原口径）。函数级单测 3/3（旧口径 246s 不回归 / 新口径 767s 覆盖压缩段 / fallback 正常）。**教训**：耗时口径历次修（v2.74/v2.82.1）都在 trace 里打转，而 trace 根本不覆盖压缩段——换数据源才是根修。

> **v2.87 要点（2026-09-05）：** 压缩黑盒治理两件套（用户拍板 ①+③，历史形态矩阵不做）。**① compaction 专项事件日志** `~/.workbuddy/token-tracker-compaction.log`——压缩对 hook 侧是纯黑盒（触发时机/Stop 次数/重写方式无契约，历史 8 次压缩弹窗异常 08-25~09-05 每次只能从弹窗反推），现于三个关键决策点落盘事件+transcript 形态快照（`stop-transcript` / `flush-watch-start` / `round-watch-start`，shape 含 lineCount/mtime/size/末行 type+role+status/末 30 行压缩标记 id），出问题先看数据再修，不再猜机制。**③ 跨进程弹窗兜底去重**——showToast 前查跨进程指纹（`token-tracker-toast-fp.json`，最后一条）：**同 transcript + 行数差 <10 + 间隔 <240s + 同模型** → 第二窗抑制（只影响展示，账本在弹窗前已按水位线记完；cancelled/估算/无记录文案不参与；被抑制内容仍写入 toast 诊断日志可查）。行数差 <10 是关键信号：连续小轮每轮新增 10+ 行不误伤；同轮数据被两个进程重复聚合时行数几乎不变（实测 09-05 双弹 930→934 只差 4 行）。

> **v2.86 要点（2026-09-05）：** 同轮二次 Stop 重复弹窗修复——**压缩（compaction）完成会触发第二次 Stop hook**，原逻辑无条件从 `lastUserMsgAt` 重聚整轮 → 弹窗2 = 弹窗1 已弹数据 + 压缩调用新增（实测 16:50/16:51 双弹：20.6万/146 + 4.7万/385 = 25.3万/531，耗时同显 17.4s，观感"重复弹窗"）。修复：Stop 端聚合起点改用 `aggStart = max(lastUserMsgAt, lastStopAt)`——已结算过（lastStopAt > 轮起点）只聚合新增段；聚合窗口无新增 usage → **静默跳过**（记账照跑保底，水位线幂等）。账本因水位线从未重复（实测弹窗2 只新增记 ¥0.02），纯弹窗层重复。3 项回放测试（同轮二次 Stop 有新增/无新增/单次 Stop 回归）全通过，账本零污染。

> **v2.85 要点（2026-09-05）：** 手动取消补弹从「下一轮 hook 兜底」升级为「**轮级临时 watcher 实时补弹**」——每个新轮 hook（UserPromptSubmit）spawn 一个 detached 自限时观察进程（`--round-watch <sid> <tsPath> <roundStart>`），2s 轮询 transcript：出现**终止态取消标记 + 8s 无新行** → 立即补弹，不再等用户下次提交（v2.83 兜底的最大缺口：0-usage 取消会被静默丢失，实测 09-05 15:33 场景）。三分支出口：有 usage → 聚合弹 `cancelled-round-watch`（（手动取消））；0-usage 但有 incomplete reasoning → 估算弹 `cancelled-round-watch-est`（（手动取消）（估算），v2.52 Stop 端同款）；连 reasoning 都没有（取消早于首字节落盘）→ 弹「无 token 消耗记录（手动取消）」`cancelled-round-watch-no-token`（对齐 Stop 端 v2.51，不编造数字）。退出条件（防双弹）：lastStopAt ≥ roundStart / 新轮接管起点 / coalesce 出现 / transcript 消失 / 生命上限 3h。配套修复：① hook 兜底结算门槛放宽为「取消标记晚于最近一次结算」（连环取消不再漏）；② 兜底补弹后**就地刷新 lastUserMsgAt**（原实现 return 跳过了起点刷新守卫，旧起点残留会让下一轮 Stop 聚合窗错位）。6 项回放测试（T1~T5 合成 + T6 真实 15:33 数据）全通过，测试账本自备份自恢复零污染。

> **v2.83~v2.84 要点（2026-09-04）：** 手动取消漏弹修复——WorkBuddy 手动取消不触发 Stop hook（实测 00:33 取消被 SessionAbortMiddleware 挂起，全程无 executeStopHooks），被取消轮的 token 会被静默并进下一轮弹窗（实测 108.7万并入下轮、显示 25m3s 无法辨认）。v2.83 在 hook 端新增「取消轮补弹」路径（文案带 **（手动取消）**）；**v2.84 修正续跑判定**——取消后【先 user 新消息再 assistant 回复】= 新轮次应补弹，取消后【直接 assistant 回复】= 续跑不补弹（v2.83 初版把正常取消流程误判为续跑，导致全部漏弹）。5 项离线回放测试（含真实 transcript ab3c8bf6）全部通过。

> **v2.82 系列要点（详见文末更新记录）：** 本地价格库每日自动刷新根修（resolvePython 补 venv）+ 刷新子进程 180s 超时治理 + 护栏 A 修复（价格库不再被清空）+ 流水线原子写并发加固 + build_index 逐模型沿用（官网软 404 不丢模型）；**v2.82.1** 弹窗耗时口径根修（= 最新 trace endedAt − 用户提交时刻，与 WorkBuddy 显示差 ≤1s）；**v2.82.2** findModel 单向边界匹配（未收录不再撞价）+ incrementalRecord 水位线锁（专家团 watcher/Stop 并发不双记）+ 缓存价缺失置 null（不拍脑袋 ×10%）+ 缺名不记价；**v2.82.3** 锁等待 Atomics.wait 去忙等。全套 108 项测试 + 全天账本对账 0 差异。

> **v2.89（2026-09-05，实时取消补弹失效根修——spawn 调用点丢失）：**
> - **现象**：18:29 取消 3m31s 轮走的是 `cancelled-round-flush`（下一轮提交才弹的兜底），而非 v2.85 的实时补弹。用户质问"以前几乎百分百取消就弹，现在怎么了"。
> - **取证结论（两层叠加）**：① **客户端层**：toast log 全史显示 08-25~09-02 取消全部走 `interrupted`（Stop hook 触发 → watcher 即时弹），09-03 起取消不再稳定触发 Stop hook（v2.83 实测的挂起行为），开始出现兜底；09-04/09-05 又有两次即时弹——客户端取消触发 Stop 与否**不稳定**（疑与取消时模型状态有关）。② **技能层（主因）**：git diff + grep 证实 v2.85 的弹窗三分支/watcher 主体/--round-watch 入口全部完好，**唯独两处 `spawnRoundWatcher` 调用点（hook 守卫尾部 + 兜底尾部）丢失**——round watcher 从未被启动，v2.85 上线后真实取消 0 次实时弹。旧测试直接调 `--round-watch` 入口，未覆盖 spawn 链路 → 全 PASS 漏检。
> - **修复**：补回两处调用点（守卫尾部：`!inProgress && tsPathH` 时 spawn；兜底尾部：就地刷新 lastUserMsgAt + spawn）；新增**端到端测试**（模拟 --hook → compaction log 断言 round-watch-start 出现 → 写取消标记 → 断言 watcher 实时弹）。
> - **验证**：E1 spawn 链路 PASS（round-watch-start 记录）；E2 实时弹 PASS（取消标记写入后 **2.5s** 弹 `cancelled-round-watch-no-token`，probe 记 RoundWatch）。注意测试中 watcher 有 ROUND_WATCH_MAX_MS 寿命（真实 3h），分步测试需在寿命内完成。
> - **测试方法论教训（已固化）**：链路型功能（A spawn B、B 弹 C）的测试必须端到端走全链，单独测 B/C 组件无法发现"A 没调 B"这类断链。

> **v2.87（2026-09-05，compaction 事件日志 + 跨进程弹窗兜底去重）：**
> - **背景**：用户质问"压缩问题修了多次还是反复坏"。取证结论：不是某次客户端更新改坏（09-01 旧客户端就有同款双弹痕迹，08-28 的小弹窗形态也是压缩调用），而是 **compaction 对 hook 侧完全黑盒、形态组合爆炸**——补丁数永远追不上形态数。用户拍板只做 ①观测先行 + ③弹窗兜底去重，历史形态矩阵不做（"新形态还会来，写已修的没用"）。
> - **① 事件日志**：`appendCompactionLog(event, data)` + `captureTranscShape(tsPath)`（只读绝不抛错）。观测点三个：Stop 端 transcript 路径决策点（含 roundStart0/lastStopAt/aggStart 聚合起点决策）、flush watcher 启动、round watcher 启动；抑制发生时追加 `toast-suppressed`。
> - **③ 兜底去重**：`toastSuppressCheck(line1, tsPath)`，showToast 增加第 4 参 tsPath（仅 watcher 收口聚合弹窗传入）。四条件全满足才抑制：同 transcript / 行数差 <10 / 间隔 <240s / 同模型。抑制只影响展示——记账在弹窗前已按水位线完成；writeToastLog 无条件先行，被抑制内容仍可在 toast 诊断日志追溯。
> - **验证**：one-shot 全链路实测（独立 sid：stop → coalesce → watcher 收口 → 弹窗「输入 1万 / 输出 550」精确 + compaction log 事件/shape 完整）；抑制实测（同 transcript 两连弹，第二窗 `toast-suppressed` 记录 lineCount 5 vs prev 3、ageMs 11s，系统通知未弹）。**顺带实战验证**：17:23 用户取消 7m19s 轮，`interrupted` 弹窗 29s 内及时弹出（v2.85 取消链路正常）。
> - **失效边界**：① 指纹只记最后一条——三连弹时第三窗若行数差 >10 不会被拦（设计保守，宁可漏拦不误拦）；② 非 watcher 收口路径（估算/无记录/取消补弹）不传 tsPath，不参与抑制；③ 抑制不区分"内容完全相同"与"行数接近的新增段"——行数差 <10 的小额新增段也会被拦（账本已记，只是不弹展示），极端情况下用户可能少看到一个 ¥0.0x 小窗。
> - **测试教训（重要）**：rw-test 多轮连跑被**残留锁**（watcher 异常退出未删 + R3 stale 接管需 TTL/存活判定）与 **detached watcher 延迟记账**（finally 恢复账本后 watcher 才收口 → 测试量混入真实账本 ≤¥0.01）两个坑击穿——多轮状态型测试必须每个用例独立 sid + 结束后清理锁/coalesce/snapshot/指纹；detached watcher 的副作用在测试进程退出后仍会发生。

> **v2.86（2026-09-05，同轮二次 Stop 守卫——压缩触发双弹根修）：**
> - **现象**：2026-09-05 16:50:35 与 16:51:13 连出两个几乎一样的弹窗（同模型 glm-5.3-flash、同"耗时 17.4s"，仅金额差 2 分钱）。`token-tracker-toast.log` 取证：弹窗1 `busy-timeout`（20.6万/146/¥0.08，watchStart 16:48:34）；弹窗2 `stableCount>=3` + `compactionMode=true`（25.3万/531/¥0.10，watchStart 16:51:04）。
> - **根因链**：「今天消耗」轮 16:48:34 Stop → coalesce + flush watcher → 压缩随即开始（transcript 末行持续 busy）→ watcher 等 120s busy-timeout 弹窗1 并推进 lastStopAt ✓。16:50:50 **压缩完成触发第二次 Stop hook** → Stop 端聚合起点只认 `lastUserMsgAt`（仍为 16:48）→ 无条件重聚整轮（弹窗1 已弹的 20.6万/146 + 压缩调用新增 4.7万/385）→ 写 coalesce + spawn 新 watcher → 16:51:13 弹窗2。**账本不重复**（incrementalRecord 水位线幂等，弹窗2 仅新增记 ¥0.02；16:48 时 ¥28.19 → 双弹后 ¥28.29 精确吻合），纯弹窗层重复。
> - **修复（Stop 端 transcript 路径，7 处）**：① 聚合起点 `aggStart0 = max(roundStart0, lastStopAt)`，`aggregateTranscript`/`estimateInterrupted`/`traceWallDurMs`/`aggregatePerModel`/`writeCoalesce.roundStart` 全部改用；② 聚合窗口无新增 usage 且已结算过（`settledAt0 > roundStart0`）→ **静默跳过**（incrementalRecord 保底 + probe 记 `same-round-settled-no-new-usage-skip`，绝不弹"无记录"误导）；③ 版本头 v2.85 漏升一并修正。未结算过时 `aggStart == roundStart0`，单次 Stop 行为完全不变。
> - **验证**：3 项回放全 PASS——T-A 同轮二次 Stop 有新增 → 只弹新增段（2100/150，不再含已弹的 1万）；T-B 同轮二次 Stop 无新增 → 静默（toast 行数不变）；T-C 单次 Stop 回归 → 弹整轮（1.2万/650）。测试账本自备份自恢复，与测试前逐字段一致零污染。
> - **失效边界**：① watcher 弹窗完成才推进 lastStopAt——若 watcher 进程被杀/应用关闭导致从未弹成，lastStopAt 不推进，同轮二次 Stop 仍会重聚整轮（退回旧行为）；② 同轮多段正常续跑（R2 场景）现在也只弹新增段——若用户想看整轮汇总，看弹窗里"今日累计"即可；③ v2.85 轮级 watcher 的取消补弹同样推进 lastStopAt，与本守卫共享语义不冲突。

> **v2.83~v2.84（2026-09-04，手动取消漏弹修复）：**
> - **根因（v2.83 定位）**：用户手动取消任务时，WorkBuddy **不触发 Stop hook**（实测 2026-09-02 00:33 汉化轮：取消被 SessionAbortMiddleware 挂起，直到下一条用户消息才吸收，全程无 `executeStopHooks`）。watcher 也已被吸收 → 该轮无任何结算入口，其 token 在下一条消息时被静默合并进下一轮弹窗（实测被取消轮 108.7万 tokens 并入下轮，弹窗显示 25m3s，用户完全无法辨认）。
> - **修复（v2.83）**：hook 端（`--hook` 的 asHook 分支）新增补弹路径。新增判据函数 `interruptedRowsAfter(rows, roundStartMs)`——从 transcript 提取「取消标记」（`role=assistant` + `status=incomplete` + `providerData.error.message` 精确为 `Interrupted by user`，区别于 `interruptedByUser` 只看末尾行）。三个安全条件全部满足才补弹：① `inProgress` 为真（上一轮无完成的 Stop/watcher 结算）；② 存在未被后续消息跟进的取消标记（该轮确实终止）；③ 取消标记 ts > `roundStart`（属于本轮，不是旧标记）。补弹后推进 `lastStopAt` 并 return，不走 coalesce/watcher（取消是终态，无续跑不确定性）。弹窗文案追加 **（手动取消）**，诊断日志 `reason` = `cancelled-round-flush`。
> - **v2.84 续跑判定修正**：v2.83 初版判定「取消标记后出现 assistant 消息 → 续跑不补弹」，把真实流程「取消 → 用户发新问题 → 模型回答新问题」误判为续跑，导致真实取消场景仍全部漏弹（实测 transcript ab3c8bf6 line1262 取消 / 1263 用户新消息 / 1266 新回复）。改为**看中间隔没隔用户消息**：取消后先出现 `role=user` → `break`（新轮次，补弹）；取消后直接跟 assistant（无 user 分隔）→ 才算续跑，不补弹。
> - **验证**：5 项离线回放测试全通过 —— T1 真实 transcript 场景（00:33:53 取消→00:35:07 user→00:35:49 assistant）PASS；T2 续跑拦截 / T3 无取消标记 / T4 取消早于轮起点 / T5 连续两次取消（取最后一个）均 PASS。
> - **边界（重要）**：供应商侧/应用侧自行中断的场景（非用户点击停止）也会在 transcript 写入同样的 `Interrupted by user` 标记，此时 Stop hook **正常触发** → 走既有 watcher `interrupted` 路径弹窗，**不走**本补弹路径（实测 2026-09-02 01:35 即如此，reason=interrupted）。补弹路径只兜「Stop hook 压根没触发」的情况。

> **v2.85（2026-09-05，轮级临时 watcher——取消实时补弹，不再依赖下次提交）：**
> - **动机**：v2.83 兜底依赖「用户下次提交」触发，且 0-usage 取消时 `aggregateTranscript` 返回 null 静默跳过（实测 09-05 15:33：15:31 发起 → 15:33:03 取消，窗口内 0 usage 行、0 reasoning 行，兜底全程无感知；顺带导致轮 1 的 2 分钟被并入轮 2 的 16m49s 弹窗）。用户拍板方案 A：**hook 时 spawn 轮级 watcher，取消后 8s 即补弹**，非常驻、非兜底。
> - **新入口 `--round-watch <sid> <tsPath> <roundStart>`** + `spawnRoundWatcher()`（照 `spawnFlushWatcher` 模板：detached/stdio ignore/windowsHide/unref）+ `roundWatchMain()` 轮询主循环。spawn 点两处：① asHook 起点刷新守卫后（`!inProgress` 全新一轮）；② v2.83 兜底补弹 return 前（兜底发生在新轮已提交时，新轮同样需要 watcher）。
> - **弹窗三分支**（终止态取消标记 + 静默满 8s，行数与 mtime 双跟踪防压缩误判）：有 usage → 聚合补弹 `cancelled-round-watch`（与 v2.83 兜底同构：合并 estimateInterrupted + incrementalRecord + 弹窗 + 推进 lastStopAt）；0-usage 有 incomplete reasoning → 估算弹 `cancelled-round-watch-est`（（手动取消）（估算））；两者皆无 → `cancelled-round-watch-no-token`「本轮无 token 消耗记录（手动取消）」——**不静默、不编数字**。
> - **退出条件（先于弹窗判定，防双弹）**：`lastStopAt ≥ roundStart`（已结算）/ `lastUserMsgAt > roundStart`（新轮接管）/ coalesce 存在（正常 Stop 链路接管）/ transcript 消失 / 生命上限 3h（`ROUND_WATCH_MAX_MS`，另 `ROUND_WATCH_POLL_MS`/`ROUND_WATCH_QUIET_MS` 可 env 覆盖测试）。注意 showToast 去重是**进程内存态**，跨进程无效——防双弹全靠结算推进 + 弹前最后一刻复核。
> - **兜底路径配套修复**：① 结算门槛从 `inProgressH`（lastStopAt < roundStart）放宽为「`intrInfo.ts > lastStopAt`」（取消标记晚于最近一次结算）——watcher 补弹推进后，连环取消（取消→新轮→又取消）下一轮 hook 仍能识别新标记，且天然排除已结算旧标记不重复弹；② 兜底补弹后 `lastUserMsgAt = Date.now()` 就地刷新（原实现注释声称"让下方守卫刷新"但实际 `return` 跳过了守卫——旧起点残留会让下一轮 Stop 聚合窗错位重算被取消轮）。
> - **验证**：6 项回放全 PASS——T1 有 usage 聚合弹（20万/4000/缓存90% 精确）/ T2 0-usage 估算弹（estIn=前轮 15万）/ T3 已结算静默退出（445ms 零弹）/ T4 续跑不弹（等满上限退出）/ T5 取消后 user 跟进仍补弹 / T6 **真实 15:33 数据**（roundStart=15:31:00，取消 15:33:03，窗口 0 usage 0 reasoning）→ 弹「无 token 消耗记录（手动取消）」。测试账本自备份自恢复，跑完与备份逐字段一致（今日 7394.7万/¥27.6154 零污染）。
> - **失效边界**：① 应用完全关闭时 hook 进程树可能被 Job Object 连带收割（detached 不保证脱离，与既有 --flush-delayed watcher 同局限）；② 取消后 8s 内用户就发新消息（快于静默窗）→ watcher 让位于下一轮 hook 兜底（v2.85 已放宽门槛，仍有补弹）；③ 上一轮未结算（inProgress）时不重复 spawn——若旧 watcher 已死（应用重启过）则该续接轮无实时 watcher，退回 hook 兜底；④「无 token」场景输入侧云端或已计费但本地无凭据，只提示不估算。

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
> - **清理陈旧模型**：`refresh-prices.js` 刷新时删除「曾出现在 `daily-usage.json` 且超过 14 天未使用」的模型（**从未出现在账本的模型一律保留**——v2.82 修复后与代码一致），`lock: true` 的（`deepseek-v4-flash` / `-vision-exp` / `v4-pro`）始终保留。被删模型在用时会由 `ensureNewModelPricing` 自动补回。

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
