---
name: token-usage-tracker
description: 在每次回答后显示真实 token 消耗与耗时。WorkBuddy 客户端不显示 token（内置模式只显示积分、自有 API 模式也不显示），但每轮 LLM 调用结束都会把真实 token/耗时落盘成一个新 trace 文件（~/.workbuddy/traces/<pid>/trace_*.json）。本技能读取该数据，在每次最终回复的最后单独一行附上「耗时 + 输入/输出 token」。当用户说「显示 token」「看消耗」「这次用了多少 token」「统计用量」或任何希望看到每次回答成本时触发。
type: skill
---

# Token Usage Tracker（每轮 token 消耗追踪）

## 为什么需要
WorkBuddy 客户端 UI 不显示每轮对话的 token 用量：内置模型只显示「积分」，自有 API 模式也不展示 token。但平台在每次模型调用**整轮结束后**都会把真实用量写进一个新的 `traces/<pid>/trace_*.json`（含 `totalTokens` / `totalInputTokens` / `totalOutputTokens` / `totalCachedTokens` / `duration` / `startedAt` / `endedAt`）。本技能把这些数据读出来，让你每轮都能看到真实消耗。

## 触发条件
- 用户明确要求看 token / 消耗 / 用时
- 或作为默认习惯：**每次生成最终回复时**，都在末尾附上最近一轮用量

## 使用方式（两种，任选/并用）

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
WorkBuddy 是 Claude Code fork，支持 `Stop` 事件（回答**结束后**触发）。`settings.json` 的 `hooks.Stop` 已挂接本技能 `--stop` 模式：回答结束时本轮 trace 已落盘（实测 Stop 比落盘早几百毫秒，脚本会轮询等待最多 3 秒），读到最新文件即为**本条回答**的精确统计，然后：

- **Windows 系统通知（toast，两行，Windows 通知默认只显示两行）**：调用 PowerShell WinRT Toast API 弹出
  ```
  DeepSeek-V4 Flash｜高峰×2｜4m 26s
  输入 391.2万 / 输出 1.9万｜缓存99.74%｜¥0.25
  ```
  ——**布局原则（避免 ToastText02 正文超长自动换行变 3 行；v2.6 起行1 带时段标注、行2 去「约」字、v2.7 输入/输出写完整）**：行1 = 模型完整名（去括号说明，不截断）｜[时段标注]｜耗时（标题大字）。**时段标注** `periodNote()`：模型声明 `peak_multiplier>1`（DeepSeek 原厂系=2）且当前在高峰时段（工作日 9-12/14-18）→ `高峰×N`；其余模型统一定价不显示；预留 `night_discount` 夜间折扣字段。行2 = **输入** X / **输出** Y｜缓存NN.NN%（**两位小数**）｜¥费用（**不带「约」字**，未收录显示「未收录」）。紧凑化：分隔符「｜」两侧不加空格。**宽度压力测试**（用户要求算极端）：双千万级（1e8 以下最坏 `10000万`）输入+输出 + 缓存99.99% + 价格 ¥3000 级 = **49u / 上限 52u**，余 3u + 保护兜底（丢缓存占比）；价格实际常见 ≤¥几十（GLM-5V 输出 28.8 元/百万，输出百万级高峰可达 ¥58），均放得下。**说明：Windows toast 第二行默认即「正文小字号」（ToastText02=标题大字+正文小字）；更小字号（Caption）需 AdaptiveGroup+HintStyle 自定义 XML（Win10 周年更新+），兼容性有风险，暂未采用**。这是当前唯一确认有效的"本条可见"通道（UI 内 `systemMessage` 通道实测不显示，已放弃）。
- **时段折扣数据（2026-08-05 搜索核验）**：目前仅 **DeepSeek 原厂系**有峰谷定价（V4 起推出，工作日北京时间 9-12/14-18 高峰，所有计费项 ×2，含缓存价；原因=算力挤兑削峰填谷；2025 年的「夜间错峰优惠」已被高峰溢价模式取代）。智谱 GLM / MiniMax / Kimi / 混元均为统一定价无峰谷；小米 MiMo 是 2026-05 永久降价 99%（非时段折扣）。新模型自动补录时默认 `peak_multiplier:1`，提示里会要求搜索核验时段折扣策略。
- 仍同时输出 `hookSpecificOutput.systemMessage`（保留，若未来平台支持即生效，无副作用）。
- 探针 `.stop-probe.json` 记录每次触发：`sameRound=false`+`waited=ok` = 成功拿到本条；`waited=timeout` = 3 秒内 trace 未落盘，退化为「上一轮」且不弹通知。
- 若用户不需要系统通知，可删除 `settings.json` 中 `hooks.Stop` 配置（`--hook`/手动模式不受影响）。

## 费用估算（pricing.json + 高峰时段 + 每日自动刷新）
- 模型名读取：`trace.modelInfo.models[0]`（空壳 trace 从 spans 的 `toolOutput[].model` 取）；带厂商前缀的模型名（如 `moonshotai/kimi-k2.7-code`、`deepseek/deepseek-v4-flash`）由 `findModel()` 做包含匹配，自动落到本地 key。
- 价格缓存：`~/.workbuddy/skills/token-usage-tracker/pricing.json`（官方人民币价：输入/缓存命中输入/输出，元每百万 tokens；`peak_multiplier` 高峰倍率；`or_id` 关联 OpenRouter 模型 id；`usd_input_price/usd_output_price` 为自动刷新写入的 USD 参考价）。
- **已收录模型**（2026-08-04 官方定价页 + OpenRouter 交叉核对）：deepseek-v4-flash(1/0.02/2,峰谷×2)/v4-pro(3/0.025/6,峰谷×2)/v3.2/v3.1/r1、glm-5.2(8/2/28)/5.1(8/2/28)/5-turbo(7/1.8/26)/5(6/1.5/22)/5v-turbo(8.6/1.7/28.8)/4.7/4.7-flash(免费)、kimi-k3(20/2/100)/k2.7-code(6.5/1.3/27)/k2.7-code-highspeed(13/2.6/54)/k2.6(6.5/1.1/27)/k2.5(4/0.7/21)、minimax-m3(≤512k 标准 4.2/0.84/16.8，>512k 翻倍，促销五折 2.1/0.42/8.4)/m2.7(2.1/0.42/8.4)、hy3(1/0.25/4)/hy3-preview/hunyuan-a13b。
- **新模型自动补录（用户要求"检测到未收录模型立即联网查"）**：trace 读到**未收录模型**（pricing.json 无匹配且无 input_price）时，`token-tracker.js` 自动执行：
  1. **立即联网**查 OpenRouter（`openrouter.ai/api/v1/models`，无需 key）按模型名精确/包含匹配；
  2. 找到 → 按 USD×汇率（7.2）补入 `pricing.json`（`auto_converted: true`，缓存价按输入 10% 估算，标 note "待人工核验官方价"），同时 hook/手动输出附提示「已自动补录估算价」；
  3. OpenRouter 确认无此模型 → 记入 `pricing._lookedup_models`（同一模型当天不再重复联网），输出提示「请用 unified-search 搜官方定价页补录」；
  4. 联网失败 → 不记已查（下次重试），输出提示「联网查价失败」。
  - 维护原则：**不追求收录所有模型**，只维护应用内置 + 用户常用模型；新模型由上述自动补录 + 人工核验（unified-search 搜厂商官方定价页）补齐。
- 高峰时段（仅 DeepSeek 原厂系）：北京时间 **9:00-12:00、14:00-18:00** 价格翻倍；其余模型无峰谷。
- 计费公式：`未命中输入×输入价 + 命中输入×缓存价 + 输出×输出价`，按当前时段取倍率；结果不足 ¥0.01 显示 `¥<0.01`。
- toast 为两行：行1 `[模型名｜][时段标注｜]耗时`，行2 `输入 X / 输出 Y｜缓存NN.NN%｜¥费用`（详见方式 C）。
- **每日刷新策略（用户要求"当天第一次打开软件/第一次回答才搜，当天搜过就不搜"）**：
  - 脚本自动兜底：每次运行 `token-tracker.js` 时检查 `pricing.json` 的 `date`——**过期才**同步调用 `refresh-prices.js` 联网拉 **OpenRouter 免费 API**（openrouter.ai/api/v1/models，无需 key，每 12 小时更新）更新所有 `or_id` 匹配模型的 USD 参考价 + 补未收录模型的估算价，写回 `date=今天`；**当天已刷新则直接跳过、不联网**；拉取失败保留本地价、`date` 不变（次日重试），stderr 如实报错。
  - 人工权威核验：**每日首次对话时**，按 SKILL.md 数据源清单联网核对各厂商官方定价页（DeepSeek api-docs / 智谱 open.bigmodel.cn / Kimi platform.moonshot.cn / MiniMax platform.minimaxi.com / 混元 cloud.tencent.com），把变化的官方人民币主价更新进 `pricing.json`（自动刷新只动 USD 参考字段，不覆盖本地权威主价）。
  - 开源/实时价格源清单（供每日核验）：OpenRouter API（首选自动源）、LiteLLM `model_prices_and_context_window.json`（BerriAI/litellm，静态聚合）、Portkey `https://configs.portkey.ai/pricing/<provider>.json`（免费 API 每日更新）、厂商官方定价页（权威）。

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
