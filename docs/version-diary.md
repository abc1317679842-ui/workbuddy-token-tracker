# token-tracker.js 头注释「版本日记」（v2.61 … v3.32.1）

> v3.33.0 从头注释整段迁出（原文为 `// ` 注释行，此处原样保留缩进与措辞）。
> **权威变更记录一律以 [`CHANGELOG.md`](../CHANGELOG.md) 为准**；本文件是历史头部快照，不再更新。
> 保留它的唯一理由：防止"某版为什么这么改"的推理链随迁出一起丢失。

```
// v3.32.1：**CI 三版连红根因修复（selftest 断言与环境语义对齐，产品代码零改动）** ——
//   CI 自 v3.30.0 起连续 failure，四个失败项全是测试断言与运行环境不匹配（详见 CHANGELOG v3.32.1）；
//   深层教训：本机沙箱 SPAWN_OK=false 让 spawn 系断言全程跳过 → 「本机全绿」对 CI 环境是盲区。
// v3.32.0：**第三轮全量审计（2026-10-04，25 文件 14,957 行）落地** ——
//   ① P1-1 治根+兜底+守卫三层：refresh-prices 补价成功后删 pricing_status（此前全文件零命中）；
//      四出口新增共用判定 costCellKind（真价优先 cost>0，未收录/无公开价措辞不变）；T21 段 14 条断言。
//   ② P1-4 方案 H：假日年份三态语义（null=未知，废除空数组）+ holidayYearUnknown 探针 +
//      四条件自适应自动刷新挂每日链路（maybeRefreshHolidays）+ --check 只读体检 + 2027:[] 数据迁移。
//   ③ P1-3 汇率单一真源（DEFAULT_RATE）；P1-10 .gitignore 补 4 条；P1-12 KI-8 编号去重；
//      文档订正 7+ 处（量纲/偏差方向/触发路径/零依赖口径/出网清单内联/hit 字段）。
//   不修项（裁决记 KNOWN-ISSUES）：P1-6 savePricing 不持锁 / P1-9 日志轮转 / P1-5 源A单位校验。
// v3.31.0：**第二轮审计（2026-10-02 深夜）静默错价/口径分裂集中修复** ——
//   ① 峰谷判定时刻两出口分裂（最严重）：账本 recordUsage 对 byModel 每个模型都用**同一个**
//      批级 peakTs 判峰谷，弹窗却按各模型**自己的** lastTs 判 → 跨 12:00/18:00 边界的混合轮
//      （含 DeepSeek ×2）"同一批 token 弹窗 ¥2.00 / 账本 ¥4.00"且零提示 → 弹窗也改用批级 ts
//      （各模型 lastTs 取 max；单模型轮 = 原值，零行为变化）。
//   ② 未收录模型三出口口径：账本留痕 unpriced（价库没收录 vs 厂商没公布价是两回事、处置不同），
//      单日表/summary/区间/CSV 四个出口统一显示「未收录」+ 尾注告警，不再读成"免费"；
//      summary 同时补齐 no_price 告警（此前是三出口里唯一既无告警又打 ¥0.00 的）。
//   ③ isLocalModel 短名误伤：双向子串保留（登记全名/调用短名互变各有真实场景），但 **≥5 字符**
//      才参与——否则本地挂 `qwen` 这类短名时，`qwen-max` 等云端模型会被判免费且零标记。
//   ④ 价格管线 sanity（refresh-prices.js）：主价落盘前数量级/骤变体检（超界或 ≥3× → 保留旧值 +
//      stderr + `_price_audit.warnings`，形状 `<key>: 说明` 可被 ⚠价核验 点名命中）；写盘前
//      `.pricing.json.bak` 单份备份；deepseek-official grab() 列对齐校验（数字数 > 模型列数 →
//      判错位嫌疑返 null，不再静默 slice——官方页插列即整体错位的事故作者注释里就记过一次）；
//      tmp 名两脚本分离 + deepseek-official 写前锁探测。
//   ⑤ recalc-day 轮次归属整名优先（互为前缀的模型名不再互相吞轮次）；refresh-holidays 首跑
//      全失败**不写盘**（空骨架会让全年峰谷双向错）+ `_stale` 年份标记。
//   ⑥ 缓存价未知（cached_price 缺失按 0 计，缓存占比 ~97% 时金额低估 45%~86%）在账本留痕
//      cached_price_unknown + 弹窗行1 挂「⚠缓存价未知」，与「无公开价」分开、不整段藏金额。
//   不修项：P1-10（transcript 重写 size ≥ 旧值的重复弹窗残余窗口——无副作用修法不存在，
//   记 KNOWN-ISSUES）；P0-1（审计机制描述有误，实为字典序比较且账本键全为本工具写入的 ISO）。
//   完整条目见 CHANGELOG.md。
// v3.30.0：**弹窗行2 三处真因修正（用户 2026-10-02 弹窗截图反馈）** ——
//   ① 价核验标签**永久误报**：A-8 把 `last_refresh_note`（刷新操作流水账，历史 ⚠️ 条目永久驻留）
//      当触发源之一 → 每一条弹窗都挂「⚠价核验」，用户："明明有价格，为什么又在报价核验？"
//      → 只认"当前价库真实健康状态"的结构化字段（_price_audit / _ambig_warnings，刷新即重写、干净即删），
//      且**必须点名本轮弹窗涉及的模型**才挂；stderr 仍全量输出（含与本轮无关者）。
//   ② 缓存百分比被标签顶掉：行2 宽度守卫**顺序倒挂**（先丢缓存、后丢标签），违反 v3.27.0 用户定版的
//      「行2 位置留给缓存百分比」→ 改为标签先丢、缓存后丢；⚠未计价/⚠账缺 两级都不丢。
//   ③ "有的弹窗有标签、有的没有"**不是代码分支**：toast 诊断日志里 5 条全部含「｜⚠价核验」，
//      但 3 条在通知气泡里被**横向裁掉行尾** —— dispWidth 把 ⚠ 按 2u 计，实际 emoji 呈现 ≈ 4u，
//      每个 ⚠ 低估 2u → 修正 dispWidth（emoji 4u / 变体选择符 0u），上限 52 → 51（实测 51u 才"占满"）。
//   修正轮次：17 条新增行为断言全绿 + 全量 selftest 188 过 / 0 败。
// v3.29.0：**审计报告 42 条集中修复（S×3 / A×16 / D×11 / C×5 + 连锁链 4 条）** ——
//   硬核是两条**账本可能被静默抹掉**的严重缺陷：S-1 `backfill --write` 零锁全量覆盖、
//   S-2 `recalc-day` 绕过账本锁（及其「目标日期」TOCTOU 残留窗口）。其余：定价抓取链
//   （内存快照整份覆盖 / 0 价与 :free 变体 / 缓存价维度 / 峰谷倍率硬编码 / 周末低峰锚点
//   未命中真实文案）、Python 环境探测与主脚本逐字对齐、节假日两源不一致逐日告警、
//   文档一致性（D-1~D-9）、测试体系（退出码语义、导出一致性自动推导、统一注释剥离）。
//   完整条目见 CHANGELOG.md。
// v3.28.0：**⚠无公开价 标注挪到行1、行2 不再显示金额**（用户 2026-10-02 定版布局）——
//   行2 已有「输入/输出/缓存/缓存命中/金额」五段，标注塞那里会把缓存百分比挤掉；行1 模型名右侧
//   本来就有空位。改法：toastLine1 新增可选第 6 参 extraTag（默认空串 → 12 个调用点行为不变），
//   标记并入既有超宽守卫的「标注预算」（periodTxt + tagTxt 一起算）；行2 在本轮无任何已知金额时
//   **整段省略金额**（不是 ¥0、也不是「无公开价」字样），混合轮的有价部分照常显示。
//   ★顺带修一个既有守卫缺陷：旧写法在「head+标注其实放得下、只是被更新标记顶超宽」时会掉进
//   fallback 把标注整段丢掉（实测高峰标注+⚠无公开价+长模型名=49.5u，本可缩名到 30.5u 放下）。
// v3.27.0：**无公开价模型显式标注（匿名/订阅制模型厂商不公布按 token 单价）** ——
//   病根：两个查价源校验写作 price>=0，把聚合平台对这类模型标的 $0 当成合法价写进 pricing.json
//   → 弹窗显示 ¥<0.01（读起来像"几乎免费"）、账本 cost:0 与"真免费"不可区分、当日合计被系统性
//   低估且零提示（本项目典型静默失败）。修：查价源遇「输入输出同为 0」→ 抛 NO_PUBLIC_PRICE 哨兵
//   （与 null=查不到 / undefined=网络失败三态严格区分）→ 落 pricing_status:unpublished 条目；
//   弹窗金额位显示「无公开价」+⚠无公开价；--report 该行「无公开价」+ 表尾提示合计偏低；
//   账本条目带 no_price 标记（cost 保留 0 供将来 recalc 回填）；backfill 重建同样留痕；
//   recalc 回算后自动清标记。**token 四列统计始终是真实值，不受影响。**
//   实测案例：space-bunny（匿名，社区推测 MiniMax M3.1 Flash，官方未确认）、
//   MiniMax-M3.1-Flash-Preview（订阅制，官方与多方来源一致确认无按 token 费率）。
// v3.26.0：**KI-6 弹窗层三件套（⑧⑨）+ 连锁自审双修正** ——
//   ⑧ 混合模型轮弹窗金额改为**分模型计价求和**（与账本/轮次明细同口径）：aggregateTranscLines
//      同循环产出分模型明细（与总量同一 seen 去重），aggregateTranscript 合并主+子明细，
//      toastLine2 逐模型 calcCost（带各自 lastTs 峰谷时刻）——本地模型免费跳过、纯本地「本地·免费」、
//      部分模型无价 → 部分和 +「⚠未计价」、旧形状（无 models）回退旧口径。
//   ⑨ 补弹链路死亡检测（防团队轮双弹屏/subCount 陈旧）：Stop 拆分弹后「绝不推进 lastStopAt」
//      + watcher 被收割（KI-3）→ 起点永久停旧轮、窗口重叠。hook 端检测 coalesce 残留超时
//      （默认 10min，WB_TEAM_SPLIT_STALE_MS 可调）且子代理静止 → 宣告结算：清残留 + 双推进。
//   ★自审修正1（连锁测试 b1 实测抓出）：⑨ 结算分支写入的 lastStopAt 被下方整文件覆盖打回旧值
//      → 下轮 inProgress 恒真 → 起点再刷新（正是 ⑨ 要防的形态）。改 stopAtH 变量贯穿。
//   ★自审修正2（逐段复审抓出）：被中断估算并入弹窗聚合的 3 处（Stop 正常轮 / round-watch
//      取消轮 / hook 取消轮兜底）漏并分模型明细 → 弹窗金额漏估算段（账本含估算）。
//      新增 mergeEstIntoModels 三处统一调用。
// v3.25.0：**KI-5 落地 —— transcript 截断恢复（水位重置 + 时间戳去重），水位线不再永久冻结** ——
//   v3.22.2 起「行数 < 水位线 = 平台压缩过历史」只做告警（v3.24.0 补 ⚠账缺），水位线本身仍冻结
//   → 该会话之后的所有消耗**永久静默少计**。本版恢复记账，核心三件：
//   ① 持久化「已消费 max ts」判据：水位线 entry 新增 lastTs（主文件）/ subTs[f]（各子代理文件
//      独立——不能用主 lastTs，主文件 ts 通常更新，会把子代理未记账行误过滤）。与水位线同一
//      entry、同一次 saveLedgerWatermark 落盘 → 记账失败两者同退，天然一致。
//   ② 截断恢复：readTranscLinesFrom 显式返回 truncated:true（正常路径无此字段，旧调用方零影响）；
//      incrementalRecord 检测到 truncated 且有判据 → 从 0 重读全部完整行，perModelFromRows /
//      estimateInterrupted 按 fromTs=lastTs 过滤（两函数本就内建时间戳过滤，零新机制）——
//      ts<=lastTs 已记账跳过、ts>lastTs 从未记账计入，水位线一次推进到重写后实际行数，重读只一轮。
//      中断补偿在重置场景改用 estimateInterrupted(rows,0,fromTs)（estimateInterruptedInc 的
//      全量回退分支按行数差推起点，对重置语义不成立）。
//   ③ 防重复计费底线：lastTs 缺失（旧版本水位线升级而来）→ 无判据**宁可保持冻结也不重置**。
//      已知盲区（注释声明）：写入晚但 ts 回填早于 lastTs 的未记账行会被过滤——单行损失换
//      「新消耗全部恢复记账」。写入中读到半文件误判 truncated → ts 过滤保证无账务错误，仅多一次全量读。
//   ④ backfill 水位线合并保真 lastTs/subTs（丢弃 = --write 后截断恢复退化为冻结）。
//   ⑤ selftest 新增 T16 段 5 项 → 154 过 / 0 败 / 16 跳过；独立夹具 12 项全过（主/子代理恢复、
//      正常增量回归、无判据冻结、truncated 标志）。
//   教训（T16 首版踩坑）：selftest 里 require(SRC) 而非 tmp 副本（skillDir）→ 实例模块级路径指向
//   真实技能目录 → 测试数据写进真实账本（已清理并修复，T16 注释留档）。
// v3.24.1：**v3.24.0 发布后自审修正（3 条发现：1 必修 + 1 收紧 + 1 确认可接受）** ——
//   ① ★截断告警 stderr 文案误导（必修）：v3.24.0 的截断告警尾句写「可手动跑 node backfill.js
//      重算修复」——但 backfill 是**全量重建替换**（newDaily 完全由重放结果组装、不继承旧账本），
//      transcript 压缩场景下重放只扫到近期窗口，--write 会把**压缩窗口外的历史账一并抹掉**。
//      改：文案明确「被压缩的行本地不可恢复 + 不要跑 backfill --write」；KNOWN-ISSUES KI-5
//      补「历史不可恢复」层（⚠账缺 的意义正是提示这个不可恢复的缺口）。
//   ② loadDailyUsage 错误分类收紧：删死代码 ENOENT 判断（上方已 return）；`!e.code`（未知异常
//      如 TypeError）从「解析类 → 改名 .corrupt」改归「读失败 → 不动原文件」——文件可能是好的，
//      不动才 fail-safe，与「读取类错误不毁账本」的版本主张对齐。现语义：仅 SyntaxError 才改名。
//   ③ ⚠账缺旗标无主动清除：确认可接受——7 天自过期是刻意设计；①修正后 backfill 不再是修复
//      路径，旗标持续到过期反而合理。
//   其余 v3.24.0 改动段（alive0 / recalc 保留原额 / 假日空年 / TOCTOU / toastLine2）逐段复查无新问题。
// v3.24.0：**R8/R9 全量审计落地（13 条级联链修复 + 连锁反应测试两级全绿）** ——
//   ① 级联② hy3 补录 shipped pricing.json + toast 新增「⚠未计价」标注：hy3 是 WorkBuddy
//      子代理默认模型，shipped 价库连本机 pricing.json 都没有 → 纯净环境子代理金额静默 = 0。
//      ⚠未计价条件 = !isLocal && cost==null && (in||out)，对齐既有 价⚠️/官价⚠️ 标注模式。
//   ② 级联① transcript 截断告警 + 「⚠账缺」标注：完整行数 < 水位线 = 平台压缩过历史，
//      「不推进等恢复」成死代码（水位线永久冻结）→ 落旗标（.transcript-truncated.json，
//      24h 节流）+ toast 标注；水位重置深修立项 KI-5。
//   ③ 级联③ loadDailyUsage 错误分类：原先所有非 ENOENT 错误一律改名 .corrupt-<ts>，
//      EACCES/EBUSY 等读取类错误也会毁账本 → 只有解析类错误才改名；读取失败不写回、下轮重试。
//   ④ 级联④ recalc 保留已有金额 + 缺省日期改本地时区：峰谷占比未知时不再按空闲 ×1
//      改写已有金额（口径改写）；¥0 欠账才按空闲价补记；UTC 凌晨跨天错位修正。
//   ⑤ 级联⑩ watcher 锁 TTL 过期分支补 pid 探活：v3.23.2 TTL 30min→5min 把「活 watcher
//      被抢锁 → 双弹窗」窗口放大 6 倍 → owner 存活（EPERM 视为存活）不抢锁。
//   ⑥ 其余防御补齐：fmtCost NaN/负价挡板、hitRate 钳制 [0,100]、dayTotalOf null 条目
//      跳过（级联⑪ --report 全线崩）、dbStaleTag(null)、refresh-holidays 空年守卫（级联 B1）、
//      backfill 子水位 max 语义修复（级联 B3，原写法恒等 no-op 可回退）、
//      deepseek-official 缺 models 字段守卫 + 写盘前 TOCTOU 二次读取（级联 D）。
//   ⑦ selftest 新增 T15 段 10 项 → 149 过 / 0 败 / 16 跳过（exit 2 = 全过有跳过，新语义）；
//      连锁反应测试两级全绿（函数级 chain-test + 子进程级 chain-sub 8 项）。
//   未修立项：KI-5（截断水位深修）、KI-6（弹窗层三件套：⑧混合模型单条计价 / ⑨团队轮三件套 / ⑬同模型拆分弹）。
// v3.23.5：**口径一致性 + 一处真·静默失效（第七轮审计 E/C 面落地）** ——
//   ① ★内外层 timeout 打架（新发现，本版最值钱的一条）：自动刷新是 `execFileSync(refresh-prices.js,
//      timeout 60000)`，而 refresh-prices.js 内部 `spawnSync(deepseek-official.js, timeout 120000)`
//      （含 2 次重试 × 60s 间隔）→ **外层 60s 先到点把整个刷新杀掉，内层重试从未真正生效过**，
//      DeepSeek 官方价只有首轮就成功才拿得到，失败时只打一行 stderr 沿用旧价（静默）。
//      该调用还是同步阻塞、挂在 --hook（用户提问）路径。修复：自动路径显式 `DS_RETRIES=0`
//      （内层只跑一次，单次 15s ≪ 60s），失败沿用旧价次日再试；手动跑 refresh-prices.js 仍保留重试。
//   ② recalc-day.js 查价从裸字典 `(pricing.models||{})[model]` 改走主脚本 `findModel`
//      （归一化 + 边界匹配 + 别名）——原先模型名差一个后缀就取不到价，与 backfill 同天算出两个金额。
//   ③ recalc-day.js 峰谷倍率缺省值与主脚本 calcCost 对齐（deepseek 系 2 / 其余 1）；
//      原先一律缺省 1，deepseek 条目缺 peak_multiplier 时会比主链路整整少算一倍。
//   ④ refresh-prices.js 国外模型（US）分支补 `m.lock` 保护 —— CN 分支早有、US 分支漏了，
//      region 判定一旦把 lock 模型划成国外，官方/人工价会被冲掉并被打上 auto_converted=true。
//   ⑤ `.coalesce-*.lock` 残留锁加 prune（KI-3 副产物：watcher 被宿主收割留下的死锁，
//      实测本机 4 个；此前是唯一没有清理上限的运行时产物）。规则照抄 snapshot（7 天 / 30 个）。
//   ⑥ 审计 #9（两脚本共用 pricing.json.tmp 而只有一个持锁）**记录不修**：跨进程锁已有两份同构复制，
//      再复制第三份会加剧漂移；已在 deepseek-official.js 注释写明边界 + KNOWN-ISSUES 立项。
//   ⑦ selftest 新增 T14 段 7 项（5 源码守卫 + 2 行为验证）→ 138 过 / 0 败。
// v3.23.4：**价格流水线两处硬伤修复（requests 硬依赖 + 全局关闭 TLS 校验）** ——
//   ① P1：`fetch-cn-prices.py` / `parse_tokenhub.py` 顶层硬 `import requests`，而本机受管裸解释器
//      `binaries/python/versions/3.13.12` 根本没有 requests（实测 ModuleNotFoundError）——
//      一旦解析不到带 requests 的 venv（`resolvePython` pass 1 兜底），整条流水线进文件即崩。
//      修：requests 降级为**可选**，新增 `http_get()`，缺失时回退脚本自己已有的 urllib 实现
//      （顺带补 `decode_body()`：腾讯云文档页无视 `Accept-Encoding: identity`、永远回 gzip，
//      不解压会拿到二进制垃圾 → 解析「0 个模型」却毫无报错，属最坏的静默失败）。
//      实测：裸解释器从 ImportError → 47 个模型 / TokenHub 4 个模型，与 venv 结果完全一致。
//   ② P2：`ssl.check_hostname=False` + `verify_mode=CERT_NONE` 全局关闭证书校验，而抓的是
//      **直接写进 pricing.json、决定每轮计费金额**的厂商价格 —— 中间人改一次价，账本金额跟着错且无告警。
//      修：恢复严格校验（实测四家官方页严格校验均 200、字节数与关校验时一致，关闭毫无收益）；
//      企业代理/自签证书环境保留显式降级开关 `CN_PRICES_INSECURE_TLS=1`，且必须打 [WARN]（禁静默）。
//   ③ selftest 新增 T13 段 6 项守卫（禁无条件关 TLS / 降级必须带警告 / requests 禁顶层硬 import /
//      必须有 urllib 回退 / http_get 入口 / decode_body 存在），防回归。
// v3.23.3：**CI 首跑抓出的 M7 守卫时序修复（deepseek-official.js）** —— CI（windows-latest）首跑 T4 红：
//   「pricing 损坏拒绝覆盖」守卫原来放在 fetch 成功之后、写盘之前——WB_NO_NET=1 时重试循环先烧完再 exit(1)，
//   守卫永远到不了（重试总时长还撞了测试 60s 超时 → exit=null SIGTERM）。修复：守卫提前到 main() 开头，
//   损坏时**不发起任何网络请求**直接 exit(2)——语义本来就是「拒绝覆盖式重建」，先联网再拒绝是本末倒置。
//   selftest T3 R4 在 WB_NO_NET=1 时改 skip（断网重建走失败分支，断言前提不成立）。
//   本机 125 过 / 0 败；CI 复跑验证见 Actions。
// v3.23.2：**首个 CI（GitHub Actions selftest）+ KI-2 漏弹上限 30min → 5min** ——
//   ① `.github/workflows/selftest.yml`：push 到 master/main 时在 windows-latest 上裸跑 `node selftest.js`
//      （零依赖、WB_NO_NET=1 禁真联网；selftest 内部自设 TOKEN_TRACKER_NO_TOAST/WB_ROOT 隔离）。
//      最大增量：T12-j（--hook 端到端注入断言）在本机沙箱因 EBUSY 每次 SKIP、从未真跑，CI 上首次真验证。
//   ② KI-2：`WATCH_LOCK_TTL` 30min → 5min（watcher 崩溃后死锁的漏弹上限砍 6 倍）；
//      不做「锁里写进程启动时间对比」——node 无跨进程查启动时间的纯 API，Windows 只能 PowerShell/wmic，沙箱禁。
//      KNOWN-ISSUES KI-2 条目改标「已缓解」。
//   评审未采纳（记录在案）：grep 断言渐进换导出单测（顺手做，不开版本）；拆巨石单文件（不拆）。
// v3.23.1：**README「真实输出示例」排版修正：代码块 → 真表格渲染（纯文档排版修正，代码零改动）** ——
//   用户反馈示例表格在 GitHub 上「排版根本不整齐、错位的」。排查：仓库与本地逐字节一致（上传无损）；
//   根因是 ①②③ 段把 --report 的 markdown 表格包进了 ``` 代码块 —— GitHub 不渲染代码块里的表格语法，
//   而脚本原始输出不做列宽补齐 → 等宽显示整表错位。修法（用户要求「能成表格的成表格」）：
//   ①②③/⑥ 改真 Markdown 表格（GitHub 自动对齐，===== 标题移进段标题）、④ 外推改无序列表、⑤ 单行路径保留代码块。
//   全仓 8 个 md 扫描「代码块内嵌表格」，除 README（已修）外零命中。数字仍是 2026-10-01 真实输出未加工。
// v3.23.0：**SKILL.md 瘦身 76.2 KB → 42.4 KB，排障/边缘内容改为按需加载（纯文档重构，代码逻辑零改动）** ——
//   起因（用户原话）：「这个技能字符占据了多少？算是很超标吗？需要精简吗？哪些可以挪出去、
//   哪些可以挪到其他地方启用？」——实测：SKILL.md 77,999B（76.2 KB）/ ≈18,401 token / 406 行，
//   对照「单 skill 建议 ≤5,000 token」= **3.7 倍**；而常驻的 frontmatter description 只有 2.3 KB（触发键，不能动）。
//   病灶是**结构性**的：51% 的内容属于「CHANGELOG 副本 + 排障手册 + 历史细节」——
//   版本要点堆积 14,799B(19.0%)、故障排查速查表 12,266B(15.7%)、余额显示 6,576B(8.4%)、
//   方式 C 布局演进史 5,570B(7.1%)、Windows 通知横幅设置 3,358B(4.3%)。
//   本次挪出 4 个**默认不加载**的旁支文件（SKILL.md 只留触发规则 / 命令映射 / 核心机制 / 铁律 / 反借口表）：
//   ① `TROUBLESHOOTING.md`（弹窗诊断日志 + 排查步骤 + 31 行故障速查表，约 14 KB）；
//   ② `docs/balance.md`（余额原理 / 启用条件 / 模式识别判据 / 宽度让位 / 隐私）；
//   ③ `docs/pricing-refresh.md`（每日刷新 5 源策略 + 峰谷时段口径 + 计费公式）；
//   ④ `docs/windows-notification.md`（SmartOptOut 横幅修复，两条 PowerShell + 实测证据）。
//   SKILL.md 新增「📦 按需加载的旁支文件（默认不要读）」索引节，按症状指向对应文件。
//   实测结果：77,999B → 42,402B（−45.6%），估算 token ≈18,401 → ≈10,000，行数 406 → 326；
//   版本要点段 7 段 14,799B → 2 段 2,988B（v3.22.0 / v3.22.1）。
//   代码侧除 `SKILL_VERSION` 与头注释版本号外**未动一行**。
//   新增两条防漂移守卫（selftest T12）：i5 = SKILL.md「当前功能总览」标题不得内嵌版本号
//   （版本以 manifest.yaml 为准）；i6 = SKILL.md 里 Read 指向的旁支文件必须真实存在（4 个）。
// v3.22.1：**把「怎么问 → 得到什么表」写进文档（纯文档版，代码零改动）** ——
//   起因（用户原话）：「介绍和技能里面有没有说清楚？可以通过直接问模型问消耗……怎么通过说哪些话、
//   问哪些问题可以得到不同的数据表格？」——逐条核过后确认：**功能本身 v3.20.0 就有**（week / month /
//   任意区间 / forecast / --csv），但 README 与 SKILL.md **从头到尾没有一份「自然语言问法 → 命令」的对照**，
//   后果是两头都抓瞎：用户不知道能问什么，模型不知道该跑哪条命令（问「这周」却跑 `--report all`
//   让用户自己在几十天里找，就是典型翻车）。本次只补文档：
//   ① README 新增「💬 怎么查消耗：直接问模型就行」章节 —— 问法→表格对照表 + **6 段真实输出示例**
//      （今天 / 本周 / 历史某天 / 外推 / CSV 路径 / summary 一行式），让人一眼看到会得到什么；
//   ② SKILL.md 新增「自然语言问法 → 命令映射」**强制表** + 反模式表 —— 这才是触发层，不改模型就不会触发对；
//   ③ 排查速查表补 2 行（跑错命令 / 轮次明细无 CLI 入口）；④ frontmatter 触发词补齐
//      （最近 7 天 / 某段日期 / 照这速度 / 上一轮）。⑤ 如实写明两个拿不到的东西：
//      **单轮明细无 CLI 入口**（只有 rounds/*.jsonl）、**账本按天分桶拿不到小时粒度**。
// v3.22.0：**版本更新提示的检测点修准 + 覆盖盲区补齐**（用户质疑「检测点选的准不准？不准确会导致别人收不到更新」→ 实测后确认两处真缺陷）——
//   ① **挂载点被早退分支绕过（真缺陷）**：v3.21.0 把提示挂在两个 `out()` 调用点上，而 `--hook` 路径有
//      3 条早退分支（`trace 文件尚未完成写入` / `手动取消轮补弹` / …）走的是**另外的** `out()`，
//      根本不经过挂载点 → 命中这些分支的那一轮**收不到提示**。
//      修法：把追加逻辑**下沉到 `out()` 内部**、把检查提前到 `main()` 最开头算一次并缓存 →
//      结构上不可能再被任何 `return` 绕过（新增早退分支也自动覆盖）。非 hook 模式输出**逐字节不变**。
//   ② **检测点漏「有 tag 无 release」（真缺陷）**：v3.21.0 只查 `releases/latest`，若某次只打 tag
//      不发 release（或反之），检测结果与事实不一致 → 漏报。修法：同时查 `git/matching-refs/tags/v`，
//      **两者取版本号较大者**（宁可早报不可漏报）。两次请求合并在同一个子进程里完成。
//   ③ **覆盖盲区：只配了 Stop、没配 UserPromptSubmit hook 的用户永远查不到**（注入通道根本不触发）。
//      修法：Stop 端按「hook 是否活跃」判断——`lastHookAt` 超过 3 天没更新（或从未写入）= 该用户没配 hook
//      → 改走 **toast 兜底**：弹窗前做一次同样的检查（7 天闸门/退避照旧），命中就在**弹窗第一行尾部**
//      加 `｜⬆vX.Y.Z`。**放不下就整个丢弃**（绝不挤压模型名、绝不动第二行的耗时/今日/余额）。
//      已配 hook 的用户 `lastHookAt` 每次提问都刷新 → **永远不会看到 toast 标记**，不产生打扰。
// v3.21.0：**版本更新提示（每周一次，匿名只读）**——
//   装了旧版的用户不会主动去仓库看更新 → 每 7 天在 `--hook` 路径匿名查一次
//   `api.github.com/repos/<repo>/releases/latest`，有新版就向**模型**注入一行极短提示
//   （`[技能更新] 有新版 vX.Y.Z，回复末尾提一句即可，勿展开`），由模型在回答末尾带一句。
//   **不加 toast 弹窗**：toast 空间已被真实数据占满（第二行 42u 上限实测已贴边），
//   塞更新提示必然触发降级链 → 等于用本轮真实数据换一句提示。**升级操作方法只写在 SKILL.md**，
//   注入行本身不含任何升级步骤。开关 `ENABLE_UPDATE_CHECK`（默认 true，可经 local-config.json 关）。
//   状态落 `.update-check.json`（不入库）：7 天闸门 + 失败退避 1h/6h/1d + 连败 3 次本周期不再试；
//   同一新版本最多提示 2 次、两次间隔 ≥24h。
//   ⚠️ 前提：**帮不了「已装旧版」的存量用户**——检查逻辑在被安装的那份代码里，旧版没有它；
//   只对「第一个带检查的版本」之后的分发生效。
// v2.63：调试日志机制重构——废弃 TOKEN_TRACKER_DEBUG 环境变量开关 + poll 全量记录，改为「弹窗时自动记录」：
//   每次 showToast 无条件向 ~/.workbuddy/token-tracker-toast.log 追加一行 JSON 诊断（原因/sessionId/行数/稳定计数等）。
// v3.20.0：**账本查询能力扩展 + 轮次明细留档**（两项）——
//   ① `--report` 新增区间（week / month / <起>..<止>）、`--csv` 导出（UTF-8 BOM，落 exports/）、
//      `forecast` 外推；既有 `--report` / `--report <date>` / `all` / `summary` 四条入口输出**逐字节不变**。
//   ② 新增 rounds/rounds-YYYY-MM.jsonl 轮次明细（唯一落点在 recordUsage，账本落盘成功后追加）。
//   ⚠️ 金额口径（硬规矩）：cost / costApiEquiv 是按 pricing.json 的 **API 单价折算的等价金额，
//      不是真实扣费**。WorkBuddy 内置模型走客户端自带额度，本技能读不到额度扣减，
//      因此**不存在任何"金额 ↔ 积分/额度"换算**（用自备 API key 时才等于真实花费）。
// v3.19.3：**压缩弹窗判定整体降级**——原 v2.62 的 compactionMode 状态机与 v2.70 的 compressionPending
//   等待窗经全量日志复核在生产环境从未生效过一次（详见 freshCompactionMarker 注释），已整体删除。
//   压缩期噪音（压缩期间连续 Stop → 连弹"本轮无 token 消耗记录"）改由 Stop 端 no-token 分支单点豁免。
// v2.61：修复 showToast 回归——v2.59 的 compaction-fix 误将 execFileSync 改为 spawn(detached+unref)，
// 导致 watcher 退出时 PowerShell 子进程被提前终止、toast 丢失。本版回退为同步 execFileSync。
```
