# WorkBuddy Token Tracker（token-usage-tracker）

![License](https://img.shields.io/github/license/abc1317679842-ui/workbuddy-token-tracker)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)
![Version](https://img.shields.io/badge/version-v3.06-blue)

> 在每次回答后显示真实 **Token 消耗 / 耗时 / 费用** 的 WorkBuddy 技能（Skill + Hook）

## ⚠️ 适用性声明（安装前必读）

| | |
|---|---|
| ✅ **唯一适配** | **WorkBuddy 桌面客户端**（Windows 10/11，Node.js ≥ 20）——数据源是 WorkBuddy 每轮调用后落盘的 trace 文件（及会话 transcript），并依赖其 hooks 机制自动触发 |
| ❌ **不适用** | 其他任何 AI 工具 / 平台（Claude Code、Cursor、ChatGPT 桌面版、其他 OpenClaw 客户端等）——它们没有 WorkBuddy 的 traces/transcript 落盘机制与 hooks 挂载点，装上也不会工作 |
| ⚠️ **功能差异** | 每轮系统通知（toast）仅 Windows 支持；macOS/Linux 即使装了本技能也不弹通知（可手动查看统计） |

**简单说：不在 WorkBuddy 桌面端使用，本技能没有意义。** 请确认你的环境再安装。

## 为什么做这个

WorkBuddy 客户端 **不显示每轮对话的 token 用量**：

- 内置模型模式只显示「积分」，不显示 token；
- 自有 API（BYOK，自定义模型）模式也不展示 token。

但平台在每次模型调用**整轮结束后**，都会把真实用量落盘（`~/.workbuddy/traces/<pid>/trace_*.json` 及会话 transcript 的 `providerData.usage`）。本技能把这些**平台自己记录的账**读出来，让你每轮都能看到真实消耗——不是估算，不是推算。

## 核心功能

| 功能 | 说明 |
|---|---|
| 🪟 **每轮即时推送** | 回答结束后，Windows 系统通知（toast）立即弹出本条消耗，**两行大字紧凑布局**：行1 第一行 = 模型名 + 时段标注（高峰双倍/夜间X折）；行1 第二行 = 耗时 + 今日累计消费 + 余额；行2 = 输入 / 输出 + 缓存占比 + 费用 |
| 📊 **今日累计消费** | toast 行1 显示当天总消费 `今日¥X.XX`（读取每日账本 total.cost） |
| 📓 **每日分模型账本** | 每轮 Stop 自动把消耗**按模型**累计进 `daily-usage.json`（本地日期分桶）：`{日期:{models:{模型:{in,out,cached,total,cost}}, total:{...}}}`——每个模型一行（输入/输出/缓存命中/总 token/金额）+ 不分模型的当日总合计；**长期保存不裁剪**，历史天仅保留各模型 + 合计（无每轮/每次会话明细），文件紧凑。查看：`--report`（今天）/ `--report all`（全部天）/ `--report <日期>`（明细+合计）；`--report summary [all|<日期>]` 只看每天**总合计**一行 |
| 🧠 **专家团全量聚合** | WorkBuddy 专家团（多个子代理并行 + 主理人汇总）的全部模型调用，一次性聚合成整轮真实消耗——**平台不把子代理调用落盘 traces，本技能直接从主会话 + `subagents/*.jsonl` transcript 读取**，跑完一个专家团弹**一条**整轮汇总，不会弹 N 次 |
| 🧩 **异步子代理识别** | 专家团子代理是异步 spawn，文件比 Agent 调用晚落盘——检测主会话是否有 `Agent`/`TeamCreate` 等团队活动，未落盘也能判定"这是专家团"→ 走合并延迟弹，不误判为普通轮 |
| 🛡️ **中途插话守卫** | 专家团运行中你插话不会把统计起点刷晚（`lastStopAt` 轮次边界守卫）——整轮消耗不丢 |
| 🔒 **快照防串会话** | 多会话并发时 snapshot 按 session_id 隔离、用本会话 transcript 路径标记，不把别的会话的数据串进来；**自动清理**（保留最近 30 天 / 最多 50 个，当前会话永不清） |
| 💰 **余额显示** | 仅自定义 API 的 DeepSeek 官方模型：调用官方 `GET /user/balance` 接口（Bearer 认证，无需网页登录）在 toast 显示 `余额¥2.77`；**默认关闭（见下方联网开关）**，开启后检测到余额变化才显示；15 秒缓存保实时又不重复请求 |
| 💰 **费用估算** | 内置主流模型**人民币官方价**（元/百万 tokens，来源见下「本地官方价格库」）；支持高峰/夜间时段倍率（见下「时段价格标注」）；不足 ¥0.01 显示 `¥<0.01` |
| ⏰ **时段价格标注** | 行1 显示时段策略：DeepSeek 原厂系高峰 → **`高峰双倍`**；声明了 `night_discount` 的模型夜间 → **`夜间X折`**。⚠️ **时段策略无公开 API 数据源，需手动维护**（厂商时段政策变动时，请在 `pricing.json` 中提示模型更新 `peak_multiplier`/`night_discount`/`peak_hours`/`night_hours` 字段，代码自动读取） |
| 🆕 **新模型自动补录** | 检测到未收录模型**立即联网**补录：先查国内源 llmabacus（人民币价，`region=CN`），再回退 OpenRouter（USD×汇率，`region=US`）；查不到则提示用搜索技能人工核验官方定价页 |
| 🔄 **每日价格自动刷新** | 每天首次运行自动拉 **5 个价格源**（国内 2：llmabacus / llm-prices-cn；国外 3：OpenRouter / LiteLLM / Portkey），按模型 `region` 区分国内外定价（CN 用国内人民币价、US 用三 USD 源中位数×汇率）；**当天已刷新则不再联网**；全源失败 toast 显示「价⚠️」并保留上次价格 |
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

## 🔌 联网功能与开关（v2.30 起）

本脚本有 3 处会联网，均在 `token-tracker.js` **顶部**用常量开关单独控制：

| 开关常量 | 默认值 | 联网功能 | 请求目标 | 是否携带密钥 |
|---|---|---|---|---|
| `ENABLE_NETWORK` | `true` | **总开关**——`false` 时下面所有联网功能一律跳过（一键零联网） | — | — |
| `ENABLE_BALANCE_QUERY` | **`false`** | 余额查询 | 仅 `https://api.deepseek.com/user/balance` | ⚠️ **是**（DeepSeek API key） |
| `ENABLE_PRICE_REFRESH` | `true` | 每日价格自动刷新 | **5 个公开价格源**：llmabacus（`llmabacus.com/api/prices`）、llm-prices-cn（GitHub raw）、OpenRouter（`openrouter.ai/api/v1/models`）、LiteLLM（GitHub raw）、Portkey（`configs.portkey.ai/pricing/<provider>.json`） | 否 |
| `ENABLE_MODEL_LOOKUP` | `true` | 新模型价格自动补录 | 同上（llmabacus 优先，OpenRouter 兜底） | 否 |

**默认配置 = 零密钥联网**：唯一携带 API key 的请求（余额查询）默认关闭；其余联网均为**公开价格源、无需任何密钥**，失败自动降级为本地价，不影响统计与 toast。

### 如何更改

编辑 `token-tracker.js` 顶部约第 35-38 行的常量：

```js
const ENABLE_NETWORK = true;        // 总开关：false = 全部联网功能关闭
const ENABLE_BALANCE_QUERY = false; // 余额查询（默认关，需自定义 API 的 DeepSeek key）
const ENABLE_PRICE_REFRESH = true;  // 每日价格自动刷新（5 个公开价格源）
const ENABLE_MODEL_LOOKUP = true;   // 新模型价格自动补录（llmabacus + OpenRouter 公开价表）
```

## 🔐 余额查询安全性说明

启用余额查询（`ENABLE_BALANCE_QUERY = true`）后，请知悉以下事实：

- **只访问一个网址**：`https://api.deepseek.com/user/balance`（DeepSeek 官方接口，`GET` 请求）。
- **密钥只走官方**：你的 DeepSeek API key 仅通过 `Authorization: Bearer <key>` 头发送给上述官方域名，**不会发给任何第三方**；请求内容不含任何本地文件、对话或系统数据。
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
- 永不溢出换行：行1 第一行 ≤ 45u（`TOAST_ROW1_MAX_W=45`）、行1 第二行 ≤ 42u（`TOAST_ROW2_MAX_W=42`，超限按「丢余额 → 丢今日价 → 保底耗时」降级）、行2 ≤ 52u（`TOAST_LINE_MAX_W=52`）——**以上三个阈值均以代码为准**（见 `token-tracker.js` 常量定义），文档若与代码冲突一律以代码为准

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

```bash
# 1. 拷贝技能目录到用户级技能目录
cp -r token-usage-tracker ~/.workbuddy/skills/

# 2. 在 ~/.workbuddy/settings.json 配置 hooks（见下）
```

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
            "command": "node ~/.workbuddy/skills/token-usage-tracker/token-tracker.js --hook"
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
            "command": "node ~/.workbuddy/skills/token-usage-tracker/token-tracker.js --stop"
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
node ~/.workbuddy/skills/token-usage-tracker/token-tracker.js
# 输出示例：
# 上一轮 DeepSeek-V4 Flash ｜ 耗时 1m 47s ｜ 输入 69.8万 / 输出 1.1万 tokens（该轮累计 70.9万，缓存命中 64.1万）
```

## 只保留 Token 通知（关闭 WorkBuddy 自带通知）

```
Windows 设置 → 系统 → 通知 → 应用通知
→ 找到「WorkBuddy」→ 关闭它的通知开关
```

本技能的 toast 使用**独立应用名「WorkBuddy Token Tracker」** 直接调用 Windows 系统通知 API 弹出，**不经过 WorkBuddy 客户端设置**——关闭 WorkBuddy 自带通知**不影响 Token 通知**。若想连 Token 通知一起关：在通知列表单独关闭「WorkBuddy Token Tracker」即可。

## 更新记录（Changelog）

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
├── pricing.json              # 26 个模型官方人民币价格 + region 国内外标记 + 高峰/夜间时段字段
└── SKILL.md                  # 技能说明与使用指令（含时序限制说明）
```
- `daily-usage.json`（运行时生成，不入库）：每日分模型账本，长期保存；`--report` 查看。

## 系统要求

- Node.js **20+**（脚本使用内置 `fetch`）
- **Windows**：toast 走 PowerShell WinRT API（`execFileSync` 同步等待 + `windowsHide`，不闪黑窗）
- macOS / Linux：`--hook` 与手动模式可用；toast 在不支持的平台自动跳过
- 适用范围：**自有 API 与内置积分模式均统计**——只要走了模型调用就有数据

## 隐私与安全

- **默认零密钥联网**：唯一携带密钥的请求（余额查询）默认关闭；其余联网仅拉取 OpenRouter 公开价格接口，无需任何密钥。
- **纯本地处理**：除上述两处 OpenRouter 公开价表 + 可选的官方余额查询外，不发送任何数据到外部。
- **不修改任何平台文件**：只读 traces/transcript，只写技能目录下的自身快照。
- **余额查询**：仅访问 DeepSeek 官方接口，密钥只经 Bearer 头发给官方域名，缓存不存 key（详见上文「余额查询安全性说明」）。
- 无遥测、无埋点、无第三方统计。

## 免责声明

本技能是独立的第三方工具，与 WorkBuddy 官方无隶属或授权关系。WorkBuddy 名称及相关商标归其权利人所有。

## License

[MIT](LICENSE)
