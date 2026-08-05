# WorkBuddy Token Tracker（token-usage-tracker）

![License](https://img.shields.io/github/license/abc1317679842-ui/workbuddy-token-tracker)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green)
![Release](https://img.shields.io/github/v/release/abc1317679842-ui/workbuddy-token-tracker)

> 在每次回答后显示真实 **Token 消耗 / 耗时 / 费用** 的 WorkBuddy 技能（Skill + Hook）

## ⚠️ 适用性声明（安装前必读）

| | |
|---|---|
| ✅ **唯一适配** | **WorkBuddy 桌面客户端**（Windows 10/11，Node.js ≥ 20）——数据源是 WorkBuddy 每轮调用后落盘的 `~/.workbuddy/traces/<pid>/trace_*.json`，并依赖其 hooks 机制自动触发 |
| ❌ **不适用** | 其他任何 AI 工具 / 平台（Claude Code、Cursor、ChatGPT 桌面版、其他 OpenClaw 客户端等）——它们没有 WorkBuddy 的 traces 落盘机制与 hooks 挂载点，装上也不会工作 |
| ⚠️ **功能差异** | 每轮系统通知（toast）仅 Windows 支持；macOS/Linux 即使装了本技能也不弹通知（可手动查看统计） |

**简单说：不在 WorkBuddy 桌面端使用，本技能没有意义。** 请确认你的环境再安装。

## 为什么做这个

WorkBuddy 客户端 **不显示每轮对话的 token 用量**：

- 内置模型模式只显示「积分」，不显示 token；
- 自有 API（BYOK，自定义模型）模式也不展示 token。

但平台在每次模型调用**整轮结束后**，都会把真实用量落盘成一个新文件 `~/.workbuddy/traces/<pid>/trace_*.json`（含 `totalTokens` / `totalInputTokens` / `totalOutputTokens` / `totalCachedTokens` / `duration`）。本技能把这些**平台自己记录的账**读出来，让你每轮都能看到真实消耗——不是估算，不是推算。

## 核心功能

| 功能 | 说明 |
|---|---|
| 🪟 **每轮即时推送** | 回答结束后，Windows 系统通知（toast）立即弹出本条消耗，两行紧凑布局：行1 = 模型名 + 时段标注 + 耗时 + 余额，行2 = 输入 / 输出 + 缓存占比 + 费用 |
| 💰 **余额显示** | 仅自定义 API 的 DeepSeek 官方模型：调用官方 `GET /user/balance` 接口（Bearer 认证，无需网页登录）在 toast 行1 **紧跟耗时**显示 `余额¥2.77`；**默认不显示，检测到余额变化（账户在真实消耗）才显示**——积分模式余额恒定永不显示，切回自定义 API 自动出现；15 秒缓存保实时又不重复请求，key 不出本机 |
| 🧩 **空壳 trace 兜底** | 平台有时顶层 `modelInfo` 为空（空壳 trace），自动从 `spans` 的 generation 节点聚合还原真实消耗（已验证与官方顶层统计完全一致） |
| 💰 **费用估算** | 内置 26 个主流模型官方人民币价（元/百万 tokens）；支持 DeepSeek 高峰时段（工作日北京时间 9-12/14-18 价格×2）；不足 ¥0.01 显示 `¥<0.01` |
| ⏰ **时段价格标注** | 行1 显示 `高峰` 两字（DeepSeek 原厂系峰谷定价；不带 ×N 省宽度）；其他模型统一定价不显示，避免噪音；预留夜间折扣字段 |
| 🆕 **新模型自动补录** | 检测到未收录模型立即联网查 OpenRouter（无需 key）自动补录估算价并提示；查不到则提示用搜索技能人工核验官方定价页 |
| 🔄 **每日价格自动刷新** | 当天首次运行自动拉取 OpenRouter 免费 API 更新 USD 参考价；**当天已刷新则不再联网**；失败保留旧价次日重试 |
| 🔤 **可读性** | 大数自动用「万/亿」单位（287.9万 / 1.5亿），缓存占比精确到两位小数（99.12%） |
| 🔒 **纯本地** | 不修改 WorkBuddy 应用包/签名/账号/对话数据，只读 traces + 维护自身快照 |

## 预览

实际运行时 Windows 系统通知效果（回答结束后立即弹出，两行紧凑布局）：

```
DeepSeek-V4 Flash | 高峰 | 4m 26s 余额¥2.77
输入 391.2万 / 输出 1.9万｜缓存99.74%｜¥0.25
```

- **行1（标题大字）**：模型完整名 + 时段标注（`高峰` 两字，仅峰谷定价模型高峰时显示）+ 耗时（`1m 40s` 单位格式）+ **余额紧跟耗时**（`余额¥X`，1 空格分隔；仅自定义 API 的 DeepSeek 官方模型且检测到余额变化；**行1 是标题大字，宽度上限 47u（v2.17 实测：47u 不换行 / 48u 换行），超宽时余额让位不折叠**；**行1 分隔符用半角 `|` 且两侧各 1 空格——全角「｜」dispWidth 算 2u 太浪费，加空格避免模型名与分隔符贴死**）
- **行2（正文小字）**：输入 / 输出 + 缓存占比（两位小数）+ 费用（不带「约」字，未收录显示「未收录」）
- 宽度保护：行1 标题大字上限 47u（v2.17 实测：47u 安全 / 48u 换行；带高峰+余额最坏 47u）、行2 极端场景（千万级数字 + 高价）实测 49u / 上限 52u，永远两行不换行

> 💡 **默认隐藏 + 变化检测**：积分模式与自定义 API 的模型 id 相同（官方内置列表就有 DeepSeek-V4-Flash）、本地无模式标记、进程探测被安全策略禁用，无法直接判断"密钥是否在用"。但**余额变化 = 账户在真实消耗**（有密钥才有消耗）：每次查询与上次对比，余额变了才显示，首次观测只记基准不显示——积分模式余额恒定，永不显示；切回自定义 API（余额开始扣）自动出现。

## 工作原理

每个 `trace_*.json` = 一轮完整 LLM 调用，**整轮结束后才落盘**：

- **手动 / `--hook` 模式** → 显示「最近完成轮次」（即上一条回答，精确但滞后一轮）
- **`Stop` 事件**（平台在回答结束后触发）→ 轮询等待本轮 trace 落盘（实测 Stop 比落盘早几百毫秒，最多等 3 秒）→ 弹出**本条**精确消耗

```
回答结束 → Stop hook → 轮询等 trace 落盘 → 读本轮数据 → 弹系统通知「本条 Token 消耗」
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

如果只想看到本技能的 Token 推送、不想被 WorkBuddy 应用自带的「任务已完成」等通知打扰：

```
Windows 设置 → 系统 → 通知 → 应用通知
→ 找到「WorkBuddy」→ 关闭它的通知开关
```

本技能的 toast 使用**独立应用名「WorkBuddy Token Tracker」** 直接调用 Windows 系统通知 API 弹出，**不经过 WorkBuddy 客户端设置**——所以关闭 WorkBuddy 自带通知**不影响 Token 通知**，两者互不干扰。

- 若在通知列表里找不到「WorkBuddy」条目：说明该版本把通知设为系统级强发（应用内开关也管不住），只能忽略或按应用提示处理。
- 若想连 Token 通知也一起关：在通知列表单独关闭「WorkBuddy Token Tracker」即可（本技能的 toast 会随之停止）。

## 文件结构

```
token-usage-tracker/
├── token-tracker.js          # 核心脚本：读 trace、聚合 spans、算费用、弹 toast、新模型自动补录
├── refresh-prices.js         # 每日价格自动刷新（OpenRouter 免费 API，当天只拉一次）
├── pricing.json              # 26 个模型官方人民币价格 + OpenRouter or_id 映射 + 高峰倍率
└── SKILL.md                  # 技能说明与使用指令（含时序限制说明）
```

## 系统要求

- Node.js **20+**（脚本使用内置 `fetch`）
- **Windows**：toast 走 PowerShell WinRT API（用 `execFileSync` 同步等待，保证通知弹出）
- macOS / Linux：`--hook` 与手动模式可用；toast 在不支持的平台自动跳过，不影响主流程
- 适用范围：**自有 API 与内置积分模式均统计**——只要走了模型调用就有 trace

## 隐私与安全

- **纯本地处理**：不发送任何数据到外部（价格刷新仅拉取 OpenRouter 公开价格接口、查价仅查询 OpenRouter 模型列表）
- **不修改任何平台文件**：只读 `traces/`，只写技能目录下的自身快照 `.snapshot.json`
- 无遥测、无埋点、无第三方统计

## 免责声明

本技能是独立的第三方工具，与 WorkBuddy 官方无隶属或授权关系。WorkBuddy 名称及相关商标归其权利人所有。

## License

[MIT](LICENSE)
