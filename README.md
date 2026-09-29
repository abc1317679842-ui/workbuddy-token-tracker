# WorkBuddy Token Tracker（token-usage-tracker）

![License](https://img.shields.io/github/license/abc1317679842-ui/workbuddy-token-tracker)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)
![Version](https://img.shields.io/badge/version-v3.18.2-blue)

> 在每次回答后显示真实 **Token 消耗 / 耗时 / 费用** 的 WorkBuddy 技能（Skill + Hook）

## ⚠️ 适用性声明（安装前必读）

| | |
|---|---|
| ✅ **唯一适配** | **WorkBuddy 桌面客户端**（Windows 10/11，Node.js ≥ 20）——数据源是 WorkBuddy 每轮调用后落盘的 trace 文件（及会话 transcript），并依赖其 hooks 机制自动触发 |
| ❌ **不适用** | 其他任何 AI 工具 / 平台（Claude Code、Cursor、ChatGPT 桌面版、其他 OpenClaw 客户端等）——它们没有 WorkBuddy 的 traces/transcript 落盘机制与 hooks 挂载点，装上也不会工作 |
| ⚠️ **功能差异** | 每轮系统通知（toast）仅 Windows 支持；macOS/Linux 即使装了本技能也不弹通知（可手动查看统计） |

**简单说：不在 WorkBuddy 桌面端使用，本技能没有意义。** 请确认你的环境再安装。

> ⛔ **本项目不经 npm 分发**（无 `package.json`）。npm 上的同名包 `token-usage-tracker` 与本项目**无关**（曾有恶意包记录），请勿 `npm i token-usage-tracker`——唯一安装方式是从本仓库下载拷入技能目录。

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
- **流水线脚本已随仓库开源（v3.16.1）**：`fetch-cn-prices.py`（MiniMax/阶跃/智谱/Kimi 官方页直抓 + DeepSeek 读 lock 价）、`parse_tokenhub.py`（腾讯云 TokenHub 文档页解析，混元峰谷/分档）、`build_index.py`（合并去重 + lock 权威覆盖 + 单厂商失败沿用防僵尸）。依赖：`requests`（`pip install requests`），Python 3。三个脚本与本技能同目录放置即可被自动发现；抓到的 `prices/index.json` 放在 `CN_PRICE_DB_DIR` 指向的目录。

## 🔌 联网功能与开关（v2.30 起）

本脚本有 3 处会联网，均在 `token-tracker.js` **顶部**用常量开关单独控制：

| 开关常量 | 默认值 | 联网功能 | 请求目标 | 是否携带密钥 |
|---|---|---|---|---|
| `ENABLE_NETWORK` | `true` | **总开关**——`false` 时 `token-tracker.js` **自身**的所有联网功能一律跳过（含分开关）。注意：兄弟脚本（`refresh-prices.js`/`deepseek-official.js`）只认 `WB_NO_NET=1`；`refresh-holidays.js` 与 Python 流水线无开关（仅手动运行时联网） | — | — |
| `ENABLE_BALANCE_QUERY` | **`false`** | 余额查询 | 仅 `https://api.deepseek.com/user/balance` | ⚠️ **是**（DeepSeek API key） |
| `ENABLE_PRICE_REFRESH` | `true` | 每日价格自动刷新 | **5 个公开价格源**：llmabacus（`llmabacus.com/api/prices`）、llm-prices-cn（GitHub raw）、OpenRouter（`openrouter.ai/api/v1/models`）、LiteLLM（GitHub raw）、Portkey（`configs.portkey.ai/pricing/<provider>.json`） | 否 |
| `ENABLE_MODEL_LOOKUP` | `true` | 新模型价格自动补录 | 同上（llmabacus 优先，OpenRouter 兜底） | 否 |

**默认配置 = 零密钥联网**：唯一携带 API key 的请求（余额查询）默认关闭；其余联网均为**公开价格源、无需任何密钥**，失败自动降级为本地价，不影响统计与 toast。

### 如何更改

余额查询开关在 `token-tracker.js` 顶部常量区（v3.18 起读**本地未入库**的 `local-config.json`）：

```js
const ENABLE_NETWORK = true;        // 总开关：false = 全部联网功能关闭
const ENABLE_BALANCE_QUERY = loadLocalFlag('enable_balance_query', false); // 默认关
const ENABLE_PRICE_REFRESH = true;  // 每日价格自动刷新（5 个公开价格源）
const ENABLE_MODEL_LOOKUP = true;   // 新模型价格自动补录（llmabacus + OpenRouter 公开价表）
```

要开启余额查询：在技能目录新建 `local-config.json`（内容 `{"enable_balance_query": true}`，文件不进仓库、不会被推送），并确认 `models.json` 里配置了 DeepSeek key。

## 🔐 隐私与数据安全

> 完整的**出网主机清单、本地写盘位置、诊断日志内容、已知限制（固定汇率）**见 [CHANGELOG.md](CHANGELOG.md) 的「隐私与安全」章节（v3.18 起集中维护，本文件不重复抄写）。

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
| `deepseek-official.js` | DeepSeek 官方定价抓取（被 refresh-prices 调用） |
| `refresh-holidays.js` | 中国法定节假日双源刷新（峰谷计费用，手动运行） |
| `fetch-cn-prices.py` | 国内厂商官网价抓取（Python 3 + requests，可选） |
| `parse_tokenhub.py` / `build_index.py` | 本地官方价库解析/建索引（可选） |
| `pricing.json` / `holidays.json` | 价格库 / 节假日数据（技能目录内） |
| `recalc-day.js` / `backfill.js` | 账本维护工具（指定日重算 / 历史回填） |
| `SKILL.md` / `CHANGELOG.md` / `manifest.yaml` / `LICENSE` | 技能说明 / 变更史 / 元数据 / 许可 |
| `selftest.js` | 离线冒烟自测（`node selftest.js`，不碰真实账本；沙箱类受限环境自动 SKIP） |
| `KNOWN-ISSUES.md` | 已知未修问题（脱敏公开记录） |
| `.gitignore` | 排除本地运行时文件与私密配置 |

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

## 只保留 Token 通知（关闭 WorkBuddy 自带通知）

```
Windows 设置 → 系统 → 通知 → 应用通知
→ 找到「WorkBuddy」→ 关闭它的通知开关
```

本技能的 toast 使用**独立应用名「WorkBuddy Token Tracker」** 直接调用 Windows 系统通知 API 弹出，**不经过 WorkBuddy 客户端设置**——关闭 WorkBuddy 自带通知**不影响 Token 通知**。若想连 Token 通知一起关：在通知列表单独关闭「WorkBuddy Token Tracker」即可。

## 更新记录（Changelog）

完整版本变更史已拆分至 **[CHANGELOG.md](CHANGELOG.md)**（v3.18 起，含从本文件与 SKILL.md 迁入的全部历史条目）。

