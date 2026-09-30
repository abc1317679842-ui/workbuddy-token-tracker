# 故障排查手册

> 本文件**默认不加载**。仅当出现下列情况时才 Read 本文件：
> - 用户反馈「不弹窗 / 弹窗内容不对 / 弹窗延迟 / 弹多了」
> - 账本数字对不上（多记、少记、重复记、与 `recalc-day.js` 不一致）
> - 价库刷新异常、时段标注不对、模型计费不对
> - 更新提示异常（收不到 / 重复出现 / 弹窗出现 `⬆vX.Y.Z`）
>
> 日常回答消耗查询**不需要**读本文件——那只涉及 `--report` 系列命令。

## 弹窗诊断日志

- 每次弹窗时，代码**自动**向 `~/.workbuddy/token-tracker-toast.log` 追加一行 JSON 诊断记录（无需任何开关，默认开启）。
- 记录内容包含：`ts`（时间）、`reason`（触发原因）、`sessionId`、`watchStartTime`（本次 watcher 启动时间）、`lineCount`、`stableCount`、`tailFingerprint`、`lastTailFingerprint`、`pendingSubCount`、`hasNewTail`、`traceFile`（当前处理的 trace 文件名，获取不到为 null）、`toastText`（弹窗真实文本前 200 字符）。
  - v3.19.3 起删除了 `compactionSuspected` / `compactionMode` / `lastMarkerId` 三个字段：前者在原压缩状态机里结构性恒为 false/null（置 true 后立刻 continue，永远到不了日志），后两者从未被置 true——留着只会误导排查。
- `reason` 取值：`busy-timeout` / `interrupted` / `deadTeam` / `stableCount>=3` / `idle-timeout` / `estimate` / `no-token` / `hook-fallback`。
- 日志文件超过 5MB 会自动清空后重新追加，避免无限增长。
- 写入失败（权限/磁盘问题）被 try-catch 吞掉，绝不影响弹窗主流程。

## 常见排查步骤

1. 如果用户反馈"压缩上下文后仍然弹窗"或"漏弹"，直接打开 `~/.workbuddy/token-tracker-toast.log`。
2. 搜索最近的记录，查看 `reason` 是 `stableCount>=3` 还是 `interrupted` 或其他。
3. 查看该记录的 `tailFingerprint` / `lastTailFingerprint`（末行指纹），判断触发时末行是否已连续多帧不变。
4. 根据日志判断是判定逻辑问题还是数据源问题，不要凭记忆修改代码。

## 故障排查速查表

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
| 弹窗第一行尾部出现 `｜⬆vX.Y.Z` | `.update-check.json` 的 `lastHookAt` | **正常且只应出现在"没配 UserPromptSubmit hook"的机器上**（v3.22.0 toast 兜底）。判据：`lastHookAt` 缺失或距今 ≥3 天。若已配 hook 却仍出现 → 说明 `--hook` 根本没被触发（检查 `settings.json` 的 `UserPromptSubmit` 配置），顺手就把"注入通道失效"这个更大的问题暴露出来了 |
| 怀疑「有新版但用户收不到提示」 | `.update-check.json` + 该用户是否配了 `UserPromptSubmit` hook | 逐条排查：① `ENABLE_UPDATE_CHECK`/`ENABLE_NETWORK` 关了；② 7 天闸门未到；③ `failCount ≥ 3` 当周停；④ 远端版本没高于本地 `SKILL_VERSION`；⑤ **没配 `--hook`** → 只有 toast 兜底（首轮会因检查而略慢约 1.5s，之后正常）；⑥ 用户装的是 v3.21.0 之前的版本 —— **那些版本的代码里根本没有检查逻辑，收不到是必然而非 bug** |
| 用户问「这周/本月」却拿到一大张全部天的表 | 你实际跑的命令 | 跑错命令了：「这周」→ `--report week`、「本月」→ `--report month`、「某段日期」→ `--report <起>..<止>`；只有「全部/历史」才用 `--report all`。详见 SKILL.md 的「自然语言问法 → 命令映射」 |
| 用户问「哪一轮最贵 / 子代理占了多少」但答不上来 | `rounds/rounds-YYYY-MM.jsonl` | **没有 CLI 入口**，账本粒度是天。只能读那个 jsonl 文件（这不算「绕过 --report 解析账本」，账本与轮次明细是两回事） |
| 用户说「统计的比我实际扣的少」 | 弹窗是否标了 `（估算）`、账本该轮 token | **很可能属实，不要辩解**：长思考被手动停止那部分云端已计费但本地不落盘，本技能只能估算且通常偏低；内置积分模式的额度扣减本技能也读不到。正确回答：以服务商账单 / WorkBuddy 积分记录为准（见 SKILL.md「数据源与准确性」的统计范围边界） |

> ⚠️ **hooks 命令铁律**：所有 hook 命令必须保持**纯净的 `node` 调用**（如 `node C:/.../token-tracker.js --stop`），**禁止使用 `cmd /c` 包装或环境变量前缀**（如 `cmd /c "set X=1 && node ..."`）。此类包装会被 WorkBuddy 判为无效 hook 配置（`Invalid hook config`），导致整个事件组（Stop / UserPromptSubmit）跳过、进程瞬间失败且无任何日志产物。调试日志已改为弹窗时自动记录，无需通过环境变量或命令前缀开启。
