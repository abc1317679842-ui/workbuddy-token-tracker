# 价格刷新策略与峰谷时段口径

> 本文件**默认不加载**。仅当用户问到「价格怎么刷新的 / 为什么价库不更新 / 时段标注不对 / 峰谷怎么算的」时才 Read。
> 摘要：价格库**每天自动刷新一次**（只在 `--hook`、即用户提交提问时触发，`--stop` 不刷）；峰谷时段**只有 DeepSeek 原厂系有**，且自动跟随官方。

## 每日刷新策略（用户要求"当天第一次打开软件/第一次回答才搜，当天搜过就不搜"）

- **触发点（v2.65 起收敛）**：**仅 `--hook`（用户提交提问时）**才检查 `pricing.json` 的 `date`，**过期才**同步调用 `refresh-prices.js` 联网刷新；`--stop` 路径**不再**做全量刷新（此前会在 Stop 时联网，阻塞弹窗）。判定仍是「当天已刷新则直接跳过、不联网」。手动运行 `node refresh-prices.js`（加 `--force` 可强制）随时可刷。**v2.66 补充**：`pricing.json` 缺失或损坏时会自动尝试重建；刷新子进程超时为 60 秒。
- **v3.23.5（内外层 timeout 打架修复）**：这里的 60 秒是**外层**（`execFileSync` 同步阻塞，发生在用户提交提问时）。而 `refresh-prices.js` 内部 `spawnSync(deepseek-official.js)` 的 timeout 是 120 秒（含 2 次重试 × 60 秒间隔）——**外层先到点把整个刷新杀掉，内层重试从未生效过**。修复：自动路径显式传 `DS_RETRIES=0`（内层只跑一次，单次 15 秒，总耗时远小于 60 秒），失败即沿用旧价、次日再试；**手动跑 `node refresh-prices.js` 不受影响，仍保留重试**（后台场景不在乎时长）。
- **多源 + 国内外区分（v2.2，2026-08-14）**：并行拉 **5 源**——
  - 国内 2 个：llmabacus（`llmabacus.com/api/prices`，**主**，每日自动核价、人民币、含 vendors country）、llm-prices-cn（`raw.githubusercontent.com/szp2005/llm-prices-cn/main/prices.json`，**备份**，llmabacus 每日镜像）；
  - 国外 3 个：OpenRouter（USD，接近实时）、LiteLLM `model_prices_and_context_window.json`（USD，1-3 天滞后）、Portkey `configs.portkey.ai/pricing/<provider>.json`（USD，美分/token）；
  - **按模型 `region` 区分国内外**（CN=国内模型主价来自国内源人民币价；US=国外模型主价用三 USD 源中位数×汇率），region 自动从 llmabacus vendors country 推断；USD 参考价取三源中位数；国内源都没有的模型仅当本地原本是 `auto_converted` 才用 USD 兜底，人工核验过的官方价保留不被覆盖；
  - **全源失败写 `last_refresh_error`**，token-tracker 在 toast 显示「价⚠️」提示费用按上次价格估算；当天已刷新则直接跳过、不联网；`--force` 可强制刷新。
- **新模型补录（v2.31）**：`ensureNewModelPricing` 检测到未收录模型时**立即联网补录**——先查国内源 llmabacus（`priceCurrency=CNY` 直接人民币价补录 region=CN；`USD` 走 USD×汇率 region=US），再回退 OpenRouter（region=US）。已收录模型不触发，只有真遇到新模型才联网。**v2.67 起匹配变严格后**，新模型/新构建名更容易落到这条路径（找不到精确键即触发）。
- **陈旧模型清理（v2.65）**：每次刷新时删除「曾出现在 `daily-usage.json` 且超过 14 天未使用」的模型（**从未出现在账本的模型一律保留**——v2.82 修复后与代码一致），`lock: true` 的三个（deepseek-v4-flash / -vision-exp / v4-pro）始终保留。被删模型再次使用时会由上面的新模型补录自动回补。
- **人工权威核验（兜底）**：**每日首次对话时**，若发现自动刷新覆盖的国内源价格与厂商官方定价页有出入（尤其峰谷模型如 DeepSeek 的基准价口径），按数据源清单核对官方定价页后修正 `pricing.json`。自动刷新的 `last_refresh_note` 会在峰谷模型价差 >60% 时提示人工核验。
- **价格源清单（已全部接入自动刷新）**：**llmabacus.com/api/prices**（国内人民币主源，每日自动核价，szp2005/llm-prices-cn 的上游，含 vendors country/currency）、**llm-prices-cn**（国内人民币备份源，每日镜像同步）、OpenRouter API（USD，接近实时）、LiteLLM `model_prices_and_context_window.json`（USD，社区 PR 1-3 天滞后）、Portkey `https://configs.portkey.ai/pricing/<provider>.json`（USD，美分/token，SaaS 即时）、厂商官方定价页（权威，兜底人工核验）。国内网页参考（不可程序化）：51token.com / jingxialai.com / tokenbijia.com。

## Python 抓取流水线（v3.23.4 起）

- **`requests` 是可选依赖，不是前置条件**：`fetch-cn-prices.py` / `parse_tokenhub.py` 都写成 `try: import requests / except ImportError: requests = None`，缺失时自动回退脚本内置的 urllib 实现（`http_get()` / `fetch()`）。文档里的 `pip install requests` 已删除——不再需要。
  - 背景：`resolvePython`（v2.82 起）两轮探测，第一轮按 `import requests` 命中带依赖的 venv（`binaries/python/envs/default`），全灭才降级裸解释器（通常无 requests）。**以前**降级后脚本一进文件就 `ModuleNotFoundError`，表现为弹窗 `⚠价库缺失`（用户根本猜不到是缺 pip 包）。
- **urllib 回退必须自己解压**：urllib 不会自动解压 `Content-Encoding`，且**腾讯云文档页实测无视 `Accept-Encoding: identity`、永远回 gzip** → 不解压就拿到二进制垃圾 → 解析出「0 个模型」且**毫无报错**。两个脚本都有 `decode_body()` 处理 gzip / deflate / br。
- **TLS 严格校验（默认）**：抓的是直接决定计费金额的价格，默认 `ssl.create_default_context()`。确需降级（MITM 企业代理 / 自签证书）时设环境变量 `CN_PRICES_INSECURE_TLS=1`，脚本会打一行 `[WARN]`（不静默）。**不要改代码把校验关掉**。

## 时段折扣数据（2026-08-05 搜索核验）

目前仅 **DeepSeek 原厂系**有峰谷定价（V4 起推出，工作日北京时间 9-12/14-18 高峰，所有计费项 ×2，含缓存价；原因=算力挤兑削峰填谷；2025 年的「夜间错峰优惠」已被高峰溢价模式取代）。智谱 GLM / MiniMax / Kimi / 混元均为统一定价无峰谷；小米 MiMo 是 2026-05 永久降价 99%（非时段折扣）。

⚠️ **时段数据的来源分两类，别再把它们混为一谈**（v3.22.0 修正过时表述——此前文档都写「无公开 API 数据源，需手动维护」，对 DeepSeek 原厂并不成立）：

- ① **DeepSeek 原厂系 → 官方自动跟随**：`deepseek-official.js` 每日抓官方定价页，写入 `pricing.json` 顶层的 `deepseek_rules.peak_schedule`（含 `weekend_off_peak`）。官方调时段 / 取消周末低峰 / 改文案，本地自动同步；**解析失败保留旧值**并亮 `⚠时段`（v3.19.1 前的旧版会把 `peak_schedule` 静默清成空串，下游回落默认值恰好正确所以毫无异常表现——这是历史坑）。无 `deepseek_rules` 时回落内置默认 9-12/14-18。
- ② **其他厂商 → 需人工维护**：这些厂商的时段政策（高峰/低谷/夜间折扣/取消）**没有**可程序化读取的数据源，变动时在 `pricing.json` 该模型条目上更新 `peak_multiplier`（高峰倍率）、`night_discount`（夜间系数，0<d<1，如 0.2=夜间2折）、`night_hours`（可选 `[起,止]`，覆盖默认夜间窗口 00:00–08:00）字段，代码自动读取显示（可在对话中提示模型更新）。
- ⚠️ **不存在 `peak_hours` 字段**：高峰时段只来自 `deepseek_rules.peak_schedule` 或内置默认，历史文档里写的 `peak_hours` 是错的（全仓无任何代码读取该键），不要照它去改 `pricing.json`。新模型自动补录默认 `peak_multiplier:1`。

**高峰时段判定（仅 DeepSeek 原厂系）**：优先取 `pricing.json` 的 `deepseek_rules.peak_schedule`（官方页每日抓取、自动跟随官方改版）；无规则时用内置默认 **北京时间 9:00-12:00、14:00-18:00**（该窗口所有计费项翻倍，周末按 `weekend_off_peak` 全天低峰）；其余模型无峰谷。

**计费公式**：`未命中输入×输入价 + 命中输入×缓存价 + 输出×输出价`，按当前时段取倍率；结果不足 ¥0.01 显示 `¥<0.01`。
