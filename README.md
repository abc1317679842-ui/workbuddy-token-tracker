# WorkBuddy Token Tracker（token-usage-tracker）

> 在每次回答后显示真实 **Token 消耗 / 耗时 / 费用** 的 WorkBuddy 技能（Skill + Hook）

## 为什么做这个

WorkBuddy 客户端 **不显示每轮对话的 token 用量**：

- 内置模型模式只显示「积分」，不显示 token；
- 自有 API（BYOK，自定义模型）模式也不展示 token。

但平台在每次模型调用**整轮结束后**，都会把真实用量落盘成一个新文件 `~/.workbuddy/traces/<pid>/trace_*.json`（含 `totalTokens` / `totalInputTokens` / `totalOutputTokens` / `totalCachedTokens` / `duration`）。本技能把这些**平台自己记录的账**读出来，让你每轮都能看到真实消耗——不是估算，不是推算。

## 核心功能

| 功能 | 说明 |
|---|---|
| 🪟 **每轮即时推送** | 回答结束后，Windows 系统通知（toast）立即弹出本条消耗：耗时 / 输入 / 输出 / 缓存命中 / 费用 |
| 🧩 **空壳 trace 兜底** | 平台有时顶层 `modelInfo` 为空（空壳 trace），自动从 `spans` 的 generation 节点聚合还原真实消耗（已验证与官方顶层统计完全一致） |
| 💰 **费用估算** | 内置 20+ 主流模型官方人民币价（元/百万 tokens）；支持 DeepSeek 高峰时段（北京时间 9-12/14-18 ×2）；不足 ¥0.01 显示 `¥<0.01` |
| 🔄 **每日价格自动刷新** | 当天首次运行自动拉取 OpenRouter 免费 API（无需 key）更新 USD 参考价；**当天已刷新则不再联网**；失败保留旧价次日重试 |
| 🔤 **可读性** | 大数自动用「万/亿」单位（287.9万 / 1.5亿），读起来快 |
| 🔒 **纯本地** | 不修改 WorkBuddy 应用包/签名/账号/对话数据，只读 traces + 维护自身快照 |

## 预览

实际运行时 Windows 系统通知效果（回答结束后立即弹出）：

![Toast 系统通知预览](assets/preview-toast.png)

*两行展示：上一行耗时 / 输入 / 输出，下行缓存命中 / 费用估算（本图示例为该技能自身一次日常使用）*

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
# 上一轮 ⏱️ 耗时 2m 27s | 输入 332.1万 / 输出 1.5万 tokens（该轮累计 333.5万，缓存命中 328.9万）
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
├── token-tracker.js          # 核心脚本：读 trace、聚合 spans、算费用、弹 toast
├── refresh-prices.js         # 每日价格自动刷新（OpenRouter 免费 API，当天只拉一次）
├── pricing.json              # 20+ 模型官方人民币价格 + OpenRouter or_id 映射 + 高峰倍率
├── SKILL.md                  # 技能说明与使用指令（含时序限制说明）
└── assets/
    └── preview-toast.png     # README 中引用的 Windows 系统通知效果图
```

## 系统要求

- Node.js **20+**（脚本使用内置 `fetch`）
- **Windows**：toast 走 PowerShell WinRT API（用 `execFileSync` 同步等待，保证通知弹出）
- macOS / Linux：`--hook` 与手动模式可用；toast 在不支持的平台自动跳过，不影响主流程
- 适用范围：**自有 API 与内置积分模式均统计**——只要走了模型调用就有 trace

## 隐私与安全

- **纯本地处理**：不发送任何数据到外部（价格刷新仅拉取 OpenRouter 公开价格接口）
- **不修改任何平台文件**：只读 `traces/`，只写技能目录下的自身快照 `.snapshot.json`
- 无遥测、无埋点、无第三方统计

## 免责声明

本技能是独立的第三方工具，与 WorkBuddy 官方无隶属或授权关系。WorkBuddy 名称及相关商标归其权利人所有。

## License

[MIT](LICENSE)