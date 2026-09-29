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

## 当前功能总览（v3.18 · 2026-09-30）

> **v3.18 要点（2026-09-30）：安全与数据卫生修复（外部审查报告落地）——①余额查询开关改读本地未入库 local-config.json（仓库分发版默认关，"默认零密钥联网"名实相符）；②DeepSeek key 不再经子进程命令行（改环境变量）；③SKILL.md 删除凭证/推送清单与越权口令（移入本地 PUSH-SOP.local.md）；④账本 BOM 防损坏（剥 BOM + 损坏只备份一次）；⑤账本不再内嵌"读取方指令"（数据→指令通道关闭）；⑥诊断日志对话片段改指纹；⑦价格库损坏拒绝覆盖式重建、USD 模糊匹配加歧义防护、CN 模型不再写矛盾 usd_* 参考价；⑧删除作者个人路径硬编码。历史版本要点详见 `CHANGELOG.md`。**

> **⚠️ 强制（查询触发总纲）：所有统计查询必须调用 `--report` 命令并原样贴出脚本输出，禁止自行解析 JSON。** 无论用户问「今日消耗」「今天用了多少」「账本」「报告」「统计」「花费」还是历史某天，一律先跑 `node token-tracker.js --report`（或 `--report <日期>`），再把脚本打印的 Markdown 表格原文贴给用户；不得自行读取 `daily-usage.json`、不得自行汇总、不得转成列表/纯文本/代码块。详细规则见下方「查询触发规则（强制）」与「展示格式约束（强制）」。

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
- **时段折扣数据（2026-08-05 搜索核验 + 手动维护）**：目前仅 **DeepSeek 原厂系**有峰谷定价（V4 起推出，工作日北京时间 9-12/14-18 高峰，所有计费项 ×2，含缓存价；原因=算力挤兑削峰填谷；2025 年的「夜间错峰优惠」已被高峰溢价模式取代）。智谱 GLM / MiniMax / Kimi / 混元均为统一定价无峰谷；小米 MiMo 是 2026-05 永久降价 99%（非时段折扣）。⚠️ **时段策略无公开 API 数据源，需手动维护**：厂商时段政策（高峰/低谷/夜间折扣/取消）变动时，在 `pricing.json` 更新 `peak_multiplier`/`night_discount`/`peak_hours`/`night_hours` 字段，代码自动读取显示（可在对话中提示模型更新）；新模型自动补录默认 `peak_multiplier:1`。
- Stop 端输出 `hookSpecificOutput:{}`（v2.37：`systemMessage` 通道 WorkBuddy UI 实测不显示、弹不进对话回复，已移除该无效注入；toast 为唯一结算展示通道）。
- 探针 `.stop-probe.json` 记录每次触发：`sameRound=false`+`waited=ok` = 成功拿到本条；`waited=timeout` = 3 秒内 trace 未落盘，退化为「上一轮」且不弹通知。
- 若用户不需要系统通知，可删除 `settings.json` 中 `hooks.Stop` 配置（`--hook`/手动模式不受影响）。

## 费用估算（pricing.json + 高峰时段 + 每日自动刷新）
- 模型名读取：`trace.modelInfo.models[0]`（空壳 trace 从 spans 的 `toolOutput[].model` 取）。
- **模型匹配（v2.67 起严格化）**：`findModel()` 只认**归一化后完全相等**的键，一个字符不同即视为不同模型。归一化仅做三件事：统一小写、去首尾空格、连续空格合并为单空格。**不做**前后缀/包含/版本号/日期归并，`.` 与 `-` 也不再等价（如 `glm-5.2` ≠ `glm-5-2`）。带厂商前缀的名字（如 `moonshotai/kimi-k2.7-code`）必须原样收录在 `pricing.json` 才能命中，不会自动剥离前缀去匹配。匹配不上返回 `null` → 走新模型联网补价，补不到就只记 token 不记金额。
- 价格缓存：`~/.workbuddy/skills/token-usage-tracker/pricing.json`（官方人民币价：输入/缓存命中输入/输出，元每百万 tokens；`region` 国内外标记 CN/US；`peak_multiplier` 高峰倍率、`night_discount`/`night_hours` 夜间折扣字段（手动维护）；`or_id` 关联 OpenRouter 模型 id；`usd_input_price/usd_output_price` 为自动刷新写入的 USD 参考价）。
- **已收录模型与价格**：**以 `pricing.json` 实际内容为准**（`region`/`lock`/`peak_multiplier` 等字段随每日刷新与人工核验持续变动，本文档不再手抄价格表——历史上手抄表曾与实际库严重脱节）。查某个模型现价：读 `pricing.json` 对应条目，或跑 `--report` 看计费结果。
- **新模型自动补录（v2.31，国内源优先；用户要求"检测到未收录模型立即联网查"）**：trace 读到**未收录模型**（pricing.json 无匹配且无 input_price）时，`token-tracker.js` 自动执行：
  1. **立即联网**先查国内源 llmabacus（`llmabacus.com/api/prices`，无需 key）按模型名匹配，`priceCurrency=CNY` 直接人民币价补录 `region=CN`、`USD` 走 USD×汇率 `region=US`；
  2. llmabacus 无 → 回退 OpenRouter（`openrouter.ai/api/v1/models`）按模型名匹配，USD×汇率（7.2）补入 `pricing.json`（`auto_converted: true`，缓存价不估算（缺失按 0 计，v2.82.1 起），标 note "待人工核验官方价"），同时 hook/手动输出附提示「已自动补录估算价」；
  3. 两源均确认无此模型 → 记入本地已查列表 `.lookedup-models.json`（v3.18.1 起，不入库；同一模型当天不再重复联网），输出提示「请搜索该模型厂商官方定价页人工核验补录」；
  4. 联网失败 → 不记已查（下次重试），输出提示「联网查价失败」。
  - 维护原则：**不追求收录所有模型**，只维护应用内置 + 用户常用模型；新模型由上述自动补录 + 人工核验（搜索厂商官方定价页）补齐。
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
| 官方调价后本地价一直不更新 / 手动条目长期 `pending-official` | `pricing.json` 该条目（`manual`/`lock`/`alias_of`）+ `_manual_audit` | v3.07 起官方页「模型版本」行与本地 key/name 对齐后**跨 key 接管**（官方价覆盖手动价 + 解绑 `manual`/`lock` + 打 `alias_of`）。若仍 pending：① 「模型版本」列数与模型列数不一致 → 安全降级为纯 key 匹配（不猜测对齐）；② 官方现行 ID 与本地 key 同名时走常规精确匹配；③ `alias_of` 条目在聚合源刷新时靠 `official.official[m.alias_of]` 回退取官方价，若被 llmabacus 价覆盖说明该回退失效 |
| 手动取消后不弹窗（v2.83+，v2.85 起实时补弹） | `token-tracker-toast.log`（搜 `cancelled-round-watch` / `cancelled-round-flush`）+ transcript 取消标记（`role=assistant`/`status=incomplete`/`error.message` = `Interrupted by user`） | v2.85 起每个新轮 hook spawn 轮级 watcher（`--round-watch`），取消标记收尾 + 8s 无新行即补弹，reason=`cancelled-round-watch`（有 usage）/`-est`（估算）/`-no-token`（无凭据）。若仍不弹：① 取消标记后直接跟 assistant 回复（续跑，设计内不弹）；② 轮已被结算（`lastStopAt ≥ roundStart`，防双弹退出）；③ 应用关闭时 watcher 被 Job Object 连带收割（失效边界，退回下一轮 hook 兜底 `cancelled-round-flush`） |
| 未取消却弹「（手动取消）」（v3.08 修复的误判） | 该轮 transcript（搜 `Interrupted by user`）+ 取消标记那一行是否带 `skipRun=true` + 标记之后是否存在「正常完成」的 assistant 行 + `~/.workbuddy/<proj>/token-tracker/<sid>/snapshot.json` 的 `lastStopAt` | v3.08 起：① 标记行 `skipRun===true`（应用中止在飞请求/编辑重发分叉，非用户取消）→ 不算取消；② 标记之后任意位置存在 `role=assistant` 且 `status!=='incomplete'` 的完成行 → 该轮已继续完成，不算取消；③ no-token Stop 已推进 `lastStopAt`，`intrInfo.ts > lastStopAt` 不成立则兜底不触发。若仍误弹：核查标记行是否确为 `skipRun=true` 且其后有完成行——若是而仍误判，说明兜底 `intrInfo.ts > lastStopAt` 校验没挡住（lastStopAt 陈旧），检查 no-token 分支是否真的写了快照 |
| 专家团金额疑似翻倍（双记） | `.ledger-watermark.json` 各会话水位线 + 账本模型 token | v2.82.2 起 incrementalRecord 整体加 `.ledger-watermark.json.lock` 水位线锁，watcher 与 Stop 并发只记一次；仍翻倍则查是否锁被异常跳过（stderr 有「水位线保持不推进」则下轮会补记） |

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

**红旗（出现即停）**：手算费用；拿别处的数字代替账本；改了表格列或格式；绕过 `--report` 直接读原始文件。
