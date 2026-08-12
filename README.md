# WorkBuddy Token Tracker（token-usage-tracker）

![License](https://img.shields.io/github/license/abc1317679842-ui/workbuddy-token-tracker)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)
![Release](https://img.shields.io/github/v/release/abc1317679842-ui/workbuddy-token-tracker)

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
| 🪟 **每轮即时推送** | 回答结束后，Windows 系统通知（toast）立即弹出本条消耗，两行紧凑布局：行1 = 模型名 + 时段标注 + 耗时 + 余额，行2 = 输入 / 输出 + 缓存占比 + 费用 |
| 🧠 **专家团全量聚合** | WorkBuddy 专家团（多个子代理并行 + 主理人汇总）的全部模型调用，一次性聚合成整轮真实消耗——**平台不把子代理调用落盘 traces，本技能直接从主会话 + `subagents/*.jsonl` transcript 读取**，跑完一个专家团弹**一条**整轮汇总，不会弹 N 次 |
| 🧩 **异步子代理识别** | 专家团子代理是异步 spawn，文件比 Agent 调用晚落盘——检测主会话是否有 `Agent`/`TeamCreate` 等团队活动，未落盘也能判定"这是专家团"→ 走合并延迟弹，不误判为普通轮 |
| 🛡️ **中途插话守卫** | 专家团运行中你插话不会把统计起点刷晚（`lastStopAt` 轮次边界守卫）——整轮消耗不丢 |
| 🔒 **快照防串会话** | 多会话并发时 snapshot 按 session_id 隔离、用本会话 transcript 路径标记，不把别的会话的数据串进来 |
| 💰 **余额显示** | 仅自定义 API 的 DeepSeek 官方模型：调用官方 `GET /user/balance` 接口（Bearer 认证，无需网页登录）在 toast 行1 紧跟耗时显示 `余额¥2.77`；**默认关闭（见下方联网开关），开启后检测到余额变化才显示**；15 秒缓存保实时又不重复请求 |
| 💰 **费用估算** | 内置 26 个主流模型官方人民币价（元/百万 tokens）；支持 DeepSeek 高峰时段（工作日北京时间 9-12/14-18 价格×2）；不足 ¥0.01 显示 `¥<0.01` |
| ⏰ **时段价格标注** | 行1 显示 `高峰` 两字（DeepSeek 原厂系峰谷定价）；其他模型统一定价不显示 |
| 🆕 **新模型自动补录** | 检测到未收录模型立即联网查 OpenRouter（无需 key）自动补录估算价并提示；查不到则提示用搜索技能人工核验官方定价页 |
| 🔄 **每日价格自动刷新** | 当天首次运行自动拉取 OpenRouter 免费 API 更新 USD 参考价；**当天已刷新则不再联网**；失败保留旧价次日重试 |
| 🔤 **可读性** | 大数自动用「万/亿」单位（287.9万 / 1.5亿），缓存占比精确到两位小数（99.12%） |

## 🔌 联网功能与开关（v2.30 起）

本脚本有 3 处会联网，均在 `token-tracker.js` **顶部**用常量开关单独控制：

| 开关常量 | 默认值 | 联网功能 | 请求目标 | 是否携带密钥 |
|---|---|---|---|---|
| `ENABLE_NETWORK` | `true` | **总开关**——`false` 时下面所有联网功能一律跳过（一键零联网） | — | — |
| `ENABLE_BALANCE_QUERY` | **`false`** | 余额查询 | 仅 `https://api.deepseek.com/user/balance` | ⚠️ **是**（DeepSeek API key） |
| `ENABLE_PRICE_REFRESH` | `true` | 每日价格自动刷新 | `https://openrouter.ai/api/v1/models` | 否 |
| `ENABLE_MODEL_LOOKUP` | `true` | 新模型价格自动补录 | `https://openrouter.ai/api/v1/models` | 否 |

**默认配置 = 零密钥联网**：唯一携带 API key 的请求（余额查询）默认关闭；两个 OpenRouter 公开请求（无需任何密钥）默认开启，失败自动降级为本地价，不影响统计与 toast。

### 如何更改

编辑 `token-tracker.js` 顶部约第 35-38 行的常量：

```js
const ENABLE_NETWORK = true;        // 总开关：false = 全部联网功能关闭
const ENABLE_BALANCE_QUERY = false; // 余额查询（默认关，需自定义 API 的 DeepSeek key）
const ENABLE_PRICE_REFRESH = true;  // 每日价格自动刷新（OpenRouter 公开价表）
const ENABLE_MODEL_LOOKUP = true;   // 新模型价格自动补录（OpenRouter 公开价表）
```

## 🔐 余额查询安全性说明

启用余额查询（`ENABLE_BALANCE_QUERY = true`）后，请知悉以下事实：

- **只访问一个网址**：`https://api.deepseek.com/user/balance`（DeepSeek 官方接口，`GET` 请求）。
- **密钥只走官方**：你的 DeepSeek API key 仅通过 `Authorization: Bearer <key>` 头发送给上述官方域名，**不会发给任何第三方**；请求内容不含任何本地文件、对话或系统数据。
- **缓存不存密钥**：余额只缓存数值与观测历史（`.balance.json`，保留最近 20 条），**不存 key**；脚本不打印、不上传 key。
- **开启条件**：`~/.workbuddy/models.json` 里需有 url 指向 `api.deepseek.com` 的模型（即你自己的 DeepSeek key）才会真正查询；无 key → 不显示余额，不影响其他功能。
- **默认关闭**：这是全脚本唯一需要联网 + 携带密钥的功能，故默认 `false`。担心隐私可保持关闭，其余功能不受影响。

## 预览

实际运行时 Windows 系统通知效果（回答结束后立即弹出，两行紧凑布局）：

```
DeepSeek-V4 Flash | 高峰 | 4m 26s 余额¥2.77
输入 391.2万 / 输出 1.9万｜缓存99.74%｜¥0.25
```

- **行1（标题大字）**：模型完整名 + 时段标注（`高峰` 两字）+ 耗时（`1m 40s`）+ **余额紧跟耗时**（`余额¥X`，仅开启余额且检测到变化时显示；行1 宽度上限 47u，超宽时余额让位不折叠）
- **行2（正文小字）**：输入 / 输出 + 缓存占比（两位小数）+ 费用（未收录显示「未收录」）
- 永远两行不换行（行1 上限 47u、行2 上限 52u，实测验证）

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
├── token-tracker.js          # 核心脚本：读 trace/transcript、聚合、算费用、弹 toast、联网开关
├── refresh-prices.js         # 每日价格自动刷新（OpenRouter 免费 API，当天只拉一次）
├── pricing.json              # 26 个模型官方人民币价格 + OpenRouter or_id 映射 + 高峰倍率
└── SKILL.md                  # 技能说明与使用指令（含时序限制说明）
```

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
