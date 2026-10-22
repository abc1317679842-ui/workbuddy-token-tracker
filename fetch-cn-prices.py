#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国内厂商官方人民币价抓取器（v0.5，2026-10-02）
- v3.62.0（外部审计 F-2，致命→严重）：**拆除 DeepSeek 自我引用闭环**。
  原实现 VENDORS['deepseek'] 用 `mode:'pricing'` 读回 pricing.json 自己的产物
  （而 pricing.json 正是这条流水线的最终汇）→「源 = 汇」：DeepSeek 官方调价后，
  只要 Node 侧 deepseek-official.js 那一轮失败，本地价就永远停在旧值，且
  latest.json 里还带着 `fetched_at=今天` + `source_type=first_party` 冒充当日新抓。
  现 DeepSeek 改走 `mode:'external'`（明确"本脚本不抓"）：它的官方价只有一条链路 ——
  Node 侧 deepseek-official.js（真抓官方页）→ pricing.json；进索引走 build_index.py 的
  pricing.json(lock) 权威覆盖层（同一份数据、诚实标签、不伪造 fetched_at）。
  随之删除本脚本的数据根探测（ detect_workbuddy_root / PRICING_PATH 全删）——
  它只为那个自读服务；数据根探测现存两处：build_index.py（价库流水线）与
  wb-root.js（Node 单点），由 selftest T99 契约测试盯一致。
- v0.5：② requests 分支补 verify=，修 CN_PRICES_INSECURE_TLS 降级对「装了 requests 的机器」静默失效；
  ③ 抓取失败改为结构化摘要（stderr + JSON _fetch_summary），exit code 维持 fail-soft 语义（详见 main()）。
- v0.4：requests 降为可选依赖（缺失自动回退 urllib 的 fetch()，无 requests 的机器不再 ImportError 整条崩）；
  TLS 恢复严格证书校验（价格影响计费；确需降级设 CN_PRICES_INSECURE_TLS=1，会打警告）
- v0.3：阶跃列序修正(输入未命中/输入命中/输出)；step-5-preview 白名单；MiniMax 专用解析
  (改版页补齐 M3/M2.x 共 9 模型)；Kimi 域名迁移 platform.kimi.com + k3 多列行取末 3 位
- v0.2：智谱切官方文档站 docs.bigmodel.cn（弃控制台 SPA bundle 通道）

用法：
    python fetch-cn-prices.py

产出：
    prices/cn-prices-<YYYY-MM-DD>.json
    （同时写 prices/latest.json 方便读取）

设计原则：
- 只抓「厂商官方定价页」，不用任何美元换算源
- 每家一个 URL，新模型上线会自动出现在页面上，代码不用改
- 单家失败不影响其他家（fail-soft）
- 只做只读 GET，不写任何厂商数据
"""
import json
import os
import re
import ssl
import sys
import time
import gzip
import zlib
import hashlib
import datetime
import urllib.request

# ── v3.62.0（外部审计 F-4）：统一北京时间 ──────────────────────────────────────
# 背景：本脚本原本**零时区概念**（grep zoneinfo|tzinfo|utcnow 全空），所有 datetime.now() /
#   date.today() 都按机器本地时区算，而价格流水线的语义全是「北京时间」：
#     ① 阶跃公告「自北京时间 X 起由 A 调整为 B」要用当前时刻比生效时刻（下方 parse_stepfun_md）；
#     ② cn-prices-<date>.json 的文件名是**数据归属日**，跨日边界（北京 0 点前后）用本地日会落错
#        文件名 → 之后按日回溯取不到当天的快照；
#     ③ fetched_at 是新鲜度判定的输入（build_index 的 SOURCE_TTL_HOURS 校验读它），本地 naive
#        时间在非 UTC+8 机器上会让"8 小时前的数据"被算成"0 小时前"或反之。
#   机器不在 UTC+8 时整体偏移若干小时 → 提前或延后采用新价，且零告警。
# ⚠️ 与 Node 侧口径一致（isPeakHour / isNightHour / todayStr 用的都是北京时间），不是自创一套。
CN_TZ = datetime.timezone(datetime.timedelta(hours=8), 'CST')

def beijing_now():
    """当前北京时间（aware datetime）。"""
    return datetime.datetime.now(CN_TZ)

def beijing_today():
    """当前北京日期（str, YYYY-MM-DD）。"""
    return beijing_now().date().isoformat()
try:
    import requests  # 可选依赖：全脚本只有 Kimi 文档页用到；缺失时 http_get() 自动回退 urllib
except ImportError:
    requests = None

# v3.60.0（CI 编码 · 2026-10-15）：Windows 上 sys.stdout 默认走 **locale 编码**（如 cp1252）——
#   一旦 print 中文即 UnicodeEncodeError、整个脚本崩（CI Windows runner 实测；本机 locale=UTF-8 故不复现）。#   调用方 token-tracker.js 按 utf-8 解码流水线输出 → 输出契约本就该是 utf-8。
#   强制 utf-8 + errors='replace'：管道/CI 下输出正确，老 cp1252 控制台也不再崩（个别字符降级为 '?'）。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
# v3.52.0（审计批2·S1）：输出目录可被调用方显式指定。原实现**恒写 HERE/prices**，而
#   token-tracker.js 的价库目录 CN_PRICE_DIR 是自动发现的（可能是任意工作区下的 prices/），
#   两者不同 → 流水线照跑、输出却落到技能目录 → **自定义价库目录永远不被填充**
#   （built_at 卡在旧日期，价库静默失效）。调用方 spawn 时传 CN_PRICES_DIR=CN_PRICE_DIR 对齐两端。
OUT_DIR = os.environ.get('CN_PRICES_DIR') or os.path.join(HERE, 'prices')
# v3.23.4：抓到的价格会写进 pricing.json、直接决定每轮计费金额 —— 不再无条件关闭证书校验。
# 实测四家官方页（智谱 / Kimi / 阶跃 / MiniMax）在严格校验下均 200 且字节数一致，
# 关闭校验既无收益，又留下「中间人改一次价格、账本金额跟着错且无告警」的漏洞。
# 企业代理 / 自签证书环境确需降级时显式设 CN_PRICES_INSECURE_TLS=1（会打一行警告，不静默）。
CTX = ssl.create_default_context()
if os.environ.get('CN_PRICES_INSECURE_TLS') == '1':
    CTX.check_hostname = False
    CTX.verify_mode = ssl.CERT_NONE
    sys.stderr.write('[WARN] CN_PRICES_INSECURE_TLS=1：已关闭 TLS 证书校验，抓取到的价格可被中间人篡改\n')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
TIMEOUT = 30

# v3.62.0（外部审计 F-2）：本脚本**不再做数据根探测**。
#   原实现 detect_workbuddy_root() 只为 `mode:'pricing'` 的 DeepSeek 自读服务
#   （读 WB_ROOT/skills/token-usage-tracker/pricing.json）。该自读已拆除 → 探测随之删除：
#   少一份"靠注释约定同步"的根判据复制（S-1 家族）。现存两处：
#     · build_index.py  —— 价库流水线侧（读 pricing.json 的 lock 权威覆盖层）；
#     · wb-root.js      —— Node 单点实现（主脚本/backfill/recalc 共用）。
#   两端一致性由 selftest T99 契约测试保证（同一组合成目录树分别跑，结果必须相同）。

# 阿里云(通义千问)不抓本地库——计费统一走聚合源(llmabacus)人民币价；
# 其官方价分地域/阶梯/思考模式/Batch半价，本地难以精确解析，故放弃本地存储。

# v3.52.0（审计批2·S4）：快照过滤**黑白名单分离**。
#   旧实现 `-us$|-latest$|-preview$` 与日期快照同属一刀切硬丢，而 `-preview/-latest` 在
#   Kimi / MiniMax / 智谱 / 阶跃路径上**也可能是真实在售型号**（hy4-preview、step-5-preview、
#   MiniMax-M3.1-Flash-Preview 类）→ 新模型上线即被静默丢弃、按未收录计价，且无任何提示。
#   只有「历史快照版」才是真垃圾：带日期后缀（-2025-01-12）或页面明写「快照」。
#   分级：hard → 丢（真快照）；soft → **保留 + 进待确认清单**（宁可多收录同价，不可漏收真型号）。
SNAP_HARD_RE = re.compile(r'-20\d\d-\d\d-\d\d|快照', re.I)
SNAP_SOFT_RE = re.compile(r'-us$|-latest$|-preview$|-exp$|-beta$', re.I)
# 待确认清单（进程内累计；main() 结尾统一 WARN 输出，供人工/自动化巡检消费）
PENDING_CONFIRM = []


def snap_verdict(name, keep_over_re=None):
    """模型名快照判定（v3.52.0·S4）。返回 'keep'（正常收录）/ 'drop'（真快照，丢）/ 'soft'
    （疑似快照但可能是真型号 → 收录并进待确认清单）。
    keep_over_re：厂商白名单（如 step-5-preview 是官方正式名）→ 直接 keep，连 WARN 都不打。"""
    if keep_over_re and keep_over_re.search(name or ''):
        return 'keep'
    if SNAP_HARD_RE.search(name or ''):
        return 'drop'
    if SNAP_SOFT_RE.search(name or ''):
        PENDING_CONFIRM.append(name)
        return 'soft'
    return 'keep'


def apply_snap_verdict(name, keep_over_re=None):
    """返回 True = 收录。soft 命中也返回 True（不再静默丢弃，改为留痕）。"""
    return snap_verdict(name, keep_over_re) != 'drop'


# v3.52.0（审计批2·L2）：列语义同义词表 —— 厂商改写列名词面时**只补表、不动解析逻辑**。
#   判定顺序（关键）：① 先看「缓存命中/未命中」修饰词 —— 「输入价格（缓存命中）」必须先被
#     cache 认领，否则会被当成普通输入列（智谱表有「缓存存储」与「缓存命中」两列，
#     只按主词「缓存」匹配会把存储价当成命中价）；② 再按主词认领 in/out；③ 每类只认领首列。
#   ⚠️ 与 parse_tokenhub.py 的同名表需保持一致（两个 py 无共享模块，各自实现；selftest T62 校验）。
COL_SYNONYMS = {
    'name': ('模型名称', 'model id', 'model', '模型', '名称'),
    'in': ('输入价格', '输入单价', '推理输入', '输入', 'input price', 'prompt', 'input'),
    'out': ('输出价格', '输出单价', '推理输出', '输出', 'output price', 'completion', 'output'),
    'cache': ('缓存命中', '缓存价格', '缓存读取', '缓存', 'cached', 'cache hit', 'cache'),
}
QUAL_HIT = ('缓存命中', '命中', 'cache hit', 'hit')
QUAL_MISS = ('缓存未命中', '未命中', 'cache miss', 'miss')


def _has(cell, words):
    c = (cell or '').lower()
    return any(w.lower() in c for w in words)


def map_price_columns(hdr):
    """表头单元格列表 -> {'name':i|None, 'in':i|None, 'out':i|None, 'cache':i|None}。
    语义匹配，不按位置（v3.52.0·L2）。未认领的列 = None（调用方按契约不全处理，**不猜**）。"""
    res = {'name': None, 'in': None, 'out': None, 'cache': None}
    for i, c in enumerate(hdr or []):
        if res['name'] is None and _has(c, COL_SYNONYMS['name']):
            res['name'] = i
            continue
        # ⚠️「未命中」含子串「命中」—— 必须先判 miss 再判 hit，否则
        #   「输入价格（缓存未命中）」会被 cache 抢走（阶跃表头正是这种写法，实测踩到）。
        miss = _has(c, QUAL_MISS)
        hit = (not miss) and _has(c, QUAL_HIT)
        if hit and res['cache'] is None:
            res['cache'] = i
            continue
        if res['in'] is None and _has(c, COL_SYNONYMS['in']) and not hit:
            res['in'] = i
            continue
        if res['out'] is None and _has(c, COL_SYNONYMS['out']) and not hit:
            res['out'] = i
            continue
    return res


def scan_fingerprint(text):
    """页面结构指纹（v3.52.0·L1）—— 解析出 0 个模型时，靠它区分「网络失败」与「官网改版」。
    只描述结构（字节数/哈希/表数量/表头前几格），**不猜测价格**。"""
    tbls = re.findall(r'<table[\s\S]*?</table>', text or '') or []
    heads = []
    for t in tbls[:3]:
        r = re.search(r'<tr[^>]*>[\s\S]*?</tr>', t)
        if r:
            heads.append(strip_tags(r.group(0)).split()[:8])
    md_rows = [ln for ln in (text or '').splitlines() if ln.lstrip().startswith('|')]
    return {
        'bytes': len(text or ''),
        'sha1_8': hashlib.sha1((text or '').encode('utf-8', 'replace')).hexdigest()[:8],
        'tables': len(tbls),
        'md_table_rows': len(md_rows),
        'headers': heads,
    }

# v3.51.0（审计批1·B/L2 活样例）：阶跃官方定价页 2026-10-12 当天改版（Mintlify 重构）——
#   新页面价格数字不再内联「元」字（单位挪到正文「单位：元／百万 tokens。」段落），旧 parse_tr
#   靠「行内有元」取价 → 实测解析出 0 个模型（A/B 实证：git HEAD 旧版同时段同样 0 个，
#   排除本地改动因素）。Mintlify 全站暴露 .md 源（llms.txt 标准，Kimi 解析器已在用同款路子），
#   改抓 .md：语义表头按列名映射列（不按位置）；单位从正文声明读取；「自北京时间…起由 A
#   调整为 B」公告按生效日期取当日有效值。
STEPFUN_MD_URL = 'https://platform.stepfun.com/docs/zh/guides/pricing/details.md'

# 调价公告（组：年/月/日/时/分/旧值/新值）：「自北京时间 2026 年 10 月 14 日 00:30 起由
# 0.35 元／百万 tokens 调整为 0.70 元／百万 tokens」。full-width ／与 half-width / 都认。
STEP_ADJ_RE = re.compile(
    r'自北京时间\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})\s*起'
    r'由\s*([\d.]+)\s*元[／/]百万\s*tokens\s*调整为\s*([\d.]+)\s*元[／/]百万\s*tokens')

# v3.62.0（外部审计 F-4）：调价公告检测的**可复用层**（原为阶跃专属、整段内联在 parse_stepfun_md 里）。
#   背景：这是全项目**唯一**一处"识别厂商预告调价"的逻辑（其余厂商完全没有生效时间概念），
#   却硬编码在阶跃解析器内 + 只认一句中文句式 → 别的厂商出同类公告只能再抄一遍。
#   抽成「句式库 + 纯函数」：将来扩厂商只需往 ADJ_NOTICE_PATTERNS 补一条正则，
#   「模型名归一 / 字段判定 / 生效时间格式化」这套逻辑不再复制。
#   ⚠ 句式必须**保守**：宁可漏认（漏认 = 按现值计，与没有公告一样）也不可误认
#     （误认 = 把普通句子当成公告、按旧值入账）——故每条正则都要求"起…由…调整为…"完整结构。
ADJ_NOTICE_PATTERNS = [STEP_ADJ_RE]

# 公告句里的模型名形态：「<显示名> 的（缓存命中）?（输入|输出）?价格 …」或行内 `step-x` 代码名。
# ⚠ (输入|输出) 在两条正则里都必须**可选**：缓存列的公告写的是「的缓存命中价格」（没有输入/输出
#   字样），写成必选时该句连 NAME_RE 都匹配不了 → names 为空 → 整条公告被丢弃（缓存调价静默
#   漏采，而缓存占总金额约 97%）。字段归属：有「缓存命中」→ cache，否则按 输入/输出 → in/out。
_ADJ_NAME_RE = re.compile(r'([A-Za-z][A-Za-z0-9 .\-]{2,40}?)\s*的\s*(缓存命中)?(输入|输出)?价格')
_ADJ_FIELD_RE = re.compile(r'的\s*(缓存命中)?(输入|输出)?价格')
_ADJ_API_RE = re.compile(r'`(step-[0-9a-z.\-]+)`')


def parse_adjustment_notices(text, patterns=None):
    """从页面文本抽取「调价公告」→ {归一化模型名: {old, new, effective, field}}。

    纯函数（无 IO / 无网络）→ selftest 可直接喂样本文本断言（F-4 的行为挂点）。
    patterns：句式库（默认 ADJ_NOTICE_PATTERNS）；新厂商接入只补这一项。
    effective：'YYYY-MM-DDTHH:MM'（公告写的是北京时间，故直接按字面取值、不做时区转换）。
    field：'in' / 'out' / 'cache'（公告针对哪一列）。
    """
    pats = ADJ_NOTICE_PATTERNS if patterns is None else patterns
    adjustments = {}
    for ln in (text or '').splitlines():
        for pat in pats:
            m = pat.search(ln)
            if not m:
                continue
            y, mo, d, hh, mm, old_v, new_v = m.groups()
            # 模型名：显示名（有空格，与 API id 不同形）与行内 `api-id` 都收，两边去标点归一后对齐
            names = set()
            nm_m = _ADJ_NAME_RE.search(ln)
            if nm_m:
                names.add(re.sub(r'[\s_\-.]', '', nm_m.group(1).lower()))
            for nm in _ADJ_API_RE.findall(ln):
                names.add(re.sub(r'[\s_\-.]', '', nm.lower()))
            if not names:
                continue  # 认不出是对哪个模型的公告 → 不猜（漏认的代价远小于误认）
            fld_m = _ADJ_FIELD_RE.search(ln)
            field = 'cache' if (fld_m and fld_m.group(1)) else ('out' if (fld_m and fld_m.group(2) == '输出') else 'in')
            for nk in names:
                adjustments[nk] = {
                    'old': float(old_v), 'new': float(new_v),
                    'effective': '%04d-%02d-%02dT%02d:%02d' % (int(y), int(mo), int(d), int(hh), int(mm)),
                    'field': field,
                }
            break  # 一行命中一条句式即够（多条同时命中 = 句式库写重了，先到的赢）
    return adjustments

# 厂商配置。mode:
#   tr     —— 页面含 <table>，逐行提取含"元"的行
#   bundle —— SPA，价格硬编码在前端 JS bundle 里，需三步解析
# v3.63.4（2026-10-21 页面改版，P1 停更修复）：Kimi 价格从 mintlify .md 源迁到 HTML 页的
#   RSC 负载 —— chat-k3.md 已 308 跳 chat.md 且导出表格为空（旧路径解析 0 模型、
#   价格永不更新，且无任何告警）。新形态（2026-10-21 实测）：
#     HTML 内 DocTable 序列化 `columns:[{title:`模型`,width:`12%`},…],rows:[[`kimi-k3`,
#     `1M tokens`,`¥20.00`,…]]`，单元格用**反引号**包裹；同一负载在页面里出现两次
#     （raw + __next_f.push 转义），按 api_name 去重。k3 表 8 列（多出「缓存写入 TTL
#     5min/1h」两列）、k2 表 6 列 —— 列数不固定，价格列必须按**表头语义**定位。
KIMI_HTML_URL = 'https://platform.kimi.com/docs/pricing/chat'
# 兜底路径：页面若回退到 .md 导出（旧格式：双引号 JSON 行），仍走 parse_kimi_row。
KIMI_PAGES = ['chat-k3']
# DocTable 块：columns:[...] 与 rows:[[...]] 必须同块匹配（列语义随表而异）。
#   rows 组必须**配平括号**（深度 ≤3）—— 早期版本用 `rows:\s*\[(?P<rows>[\s\S]*?)\]\]`，
#   外层 `[` 被模式吃掉、非贪婪又在行尾 `]]` 处收口 → 每组首/末行各缺一个括号，
#   KIMI_BT_ROW_RE 永远配不齐（k3 表单行、k2 表末行静默漏掉，且无任何告警）。
KIMI_TABLE_RE = re.compile(
    r'columns:\s*\[(?P<cols>[^\[\]]*)\]\s*,\s*rows:\s*'
    r'(?P<rows>\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\])')
KIMI_TITLE_RE = re.compile(r'title:\s*`([^`]+)`')
# 一行 = 反引号单元格数组（如 [`kimi-k3`,`1M tokens`,`¥20.00`,…]）
KIMI_BT_ROW_RE = re.compile(r'\[\s*((?:`[^`]*`\s*,\s*)+`[^`]*`)\s*\]')
KIMI_MODEL_RE = re.compile(r'^kimi-[0-9a-z.\-]+$', re.I)

VENDORS = {
    # 阿里云(通义千问)不抓本地库——计费统一走聚合源(llmabacus)人民币价
    'minimax': {
        'name': 'MiniMax',
        'url': 'https://platform.minimaxi.com/docs/guides/pricing-paygo',
        # v0.3(2026-09-28)：页面改版——数据行不再含'元'（单位挪进表头），M3 价为「刊例/永久五折」
        # 成对出现，另有优先 service tier 表（标准×1.5）。旧 tr 模式只能抓到 H3-Context-IR 一个
        # 模型（M3/M2.7/M2.5/M2.1/M2 共 9 个全被 '元' in text 过滤误杀），改专用解析器。
        'mode': 'minimax',
    },
    'stepfun': {
        'name': '阶跃星辰',
        # v3.51.0（2026-10-12 页面改版）：HTML 页价格数字不再内联「元」→ 旧 tr 模式实测 0 模型；
        #   Mintlify 暴露 .md 源（语义表头 + 正文单位声明），远比 HTML 行内正则稳。
        'url': STEPFUN_MD_URL,
        'mode': 'stepfun_md',
        # 剔除语音/图像类与坏行(stepaudio·step-tts按万字符/step-asr按小时/audio列序不可靠/仅单价行)；保留 step-1o-audio(按token计价)
        'drop_re': re.compile(r'step-?tts|step-?asr|step-?audio|step-image|step-2x-large', re.I),
        # step-5-preview 是真实产品名（非快照别名），SNAP_RE 的 -preview$ 会误杀，白名单放行
        'keep_over_re': re.compile(r'^step-5-preview$', re.I),
    },
    'deepseek': {
        'name': 'DeepSeek',
        # v3.62.0（外部审计 F-2）：**本脚本不抓 DeepSeek**。原先是 `mode:'pricing'` ——
        #   读回 pricing.json 自己的产物冒充"当日新抓的 first_party 官方价"（源=汇 闭环：
        #   官方调价后只要 deepseek-official.js 那一轮失败，本地价就永久停在旧值，
        #   而 latest.json 仍带 fetched_at=今天，下游无条件信任）。现改为显式 external：
        #   DeepSeek 官方价只走 Node 侧 deepseek-official.js（真抓官方页）→ pricing.json，
        #   进本地索引走 build_index.py 的 pricing.json(lock) 权威覆盖层（诚实标签）。
        #   ⚠ 该条目**不计入抓取失败**（不是失败，是设计上不抓）——否则每天都会假降级一次。
        'url': '(不抓：官方价走 deepseek-official.js → pricing.json)',
        'mode': 'external',
    },
    'zhipu': {
        'name': '智谱 GLM',
        'url': 'https://docs.bigmodel.cn/cn/guide/start/pricing',
        'mode': 'zhipu_docs',
    },
    'kimi': {
        'name': 'Kimi(Moonshot)',
        # v3.63.4（2026-10-21 页面改版）：价格迁到 HTML 页 RSC 负载（.md 导出已空表），
        #   主路径抓此页；.md 仅作兜底。旧 url(moonshot.cn/docs/pricing/)已 301 失效。
        'url': KIMI_HTML_URL,
        'mode': 'kimi',
    },
    # 腾讯自家(混元)价格走 parse_tokenhub.py（官方价页 1823/130055），此处不重复抓
}

# 表头行特征词——命中则跳过（不是真实模型行）
HEADER_WORDS = ('模型', '价格', '计费', '说明', '备注', '单位', '输入价格', '输出价格', 'token')


def decode_body(raw, encoding):
    """按 Content-Encoding 解压（requests 自动做，urllib 不会）。
    不解压会拿到二进制垃圾 → 解析出「0 个模型」却毫无报错，是最坏的一类静默失败。"""
    enc = (encoding or '').lower()
    if enc == 'gzip':
        return gzip.decompress(raw).decode('utf-8', 'replace')
    if enc == 'deflate':
        try:
            return zlib.decompress(raw).decode('utf-8', 'replace')
        except zlib.error:
            return zlib.decompress(raw, -zlib.MAX_WBITS).decode('utf-8', 'replace')
    if enc == 'br':
        try:
            import brotli
            return brotli.decompress(raw).decode('utf-8', 'replace')
        except ImportError:
            raise RuntimeError('服务端返回 br 编码且本机无 brotli：pip install brotli（或安装 requests）')
    return raw.decode('utf-8', 'replace')


def fetch(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    resp = urllib.request.urlopen(req, timeout=timeout, context=CTX)
    return decode_body(resp.read(), resp.headers.get('Content-Encoding'))


# v3.59.0（审计 M21）：抓取重试（指数退避）。原实现单次失败即让该厂商当日停更——
#   main 循环按厂商 try/except，一次瞬时抖动就 entry status=error，且次日之前不会自愈。
#   默认额外重试 2 次（共 3 次尝试），退避 0.4s/0.8s；可用 CN_PRICE_HTTP_RETRIES 调（0=关）。
HTTP_RETRIES = int(os.environ.get('CN_PRICE_HTTP_RETRIES') or '2')
HTTP_RETRY_BASE_MS = 400


def http_get(url, timeout=TIMEOUT):
    """GET 取回文本：有 requests 就用它（自动跟随 301），没有就回退上面的 urllib 实现。
    v3.23.4：requests 从「硬依赖」降级为「可选」——没有它的机器上整条流水线不再因 ImportError 崩掉。
    v0.5（2026-10-02）：requests 分支此前不传 verify，完全绕过模块级 CTX，导致
      CN_PRICES_INSECURE_TLS=1 的 TLS 降级对「装了 requests 的机器」（本函数首选路径）静默失效，
      而 fetch() 的 urllib 分支（urlopen(..., context=CTX)）是认 CTX 的 —— 两条路径语义不一致。
      实测 requests 2.34.2 的 verify 只接受 bool|str|None：adapters._urllib3_request_context 仅处理
      verify is False 与 isinstance(verify, str) 两种情况，传 ssl.SSLContext 会被当 truthy 静默忽略
      （实测 verify=<CERT_NONE 的 SSLContext> 仍得到 cert_reqs=CERT_REQUIRED），故不能靠传 CTX 生效。
      正确做法：按 CTX 的校验模式显式翻译 ——
        降级（CTX.verify_mode == CERT_NONE）→ verify=False（同时关链校验与 hostname 校验，与 urllib 分支对齐）
        否则 → verify=True（requests 默认严格校验，与修复前行为一致）
    v3.59.0（M21）：瞬时抖动重试——第 N 次失败睡 0.4s×2^(N-1) 再试；仍失败才抛（调用方按厂商 error 处理）。"""
    last = None
    for attempt in range(HTTP_RETRIES + 1):
        try:
            if requests is not None:
                verify = False if CTX.verify_mode == ssl.CERT_NONE else True
                return requests.get(url, headers={'User-Agent': UA}, timeout=timeout,
                                    verify=verify).text
            return fetch(url, timeout)
        except Exception as e:
            last = e
            if attempt >= HTTP_RETRIES:
                break
            time.sleep(HTTP_RETRY_BASE_MS * (2 ** attempt) / 1000.0)
    raise last


def strip_tags(s):
    s = re.sub(r'<[^>]+>', ' ', s)
    s = s.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
    return ' '.join(s.split())


def extract_prices(text):
    """从一行文本里抓出所有 '数字 元' 形式的价格"""
    return re.findall(r'(\d+(?:\.\d+)?)\s*元', text)


def looks_like_model(name):
    """模型名一般含字母数字与 - . _，且不是表头词/分档标签/价格或分辨率碎片"""
    if not name or len(name) > 60:
        return False
    if any(w in name for w in HEADER_WORDS) and not re.search(r'[a-z]{2,}', name):
        return False
    # 拒绝分档/说明标签：含 < ≤ （ ） / 等
    if re.search(r'[<≤（()）/]', name):
        return False
    # 必须含字母（纯数字/价格/分辨率片段如 0.15 / 1080P / 720P / 2K 不是模型名）
    if not re.search(r'[A-Za-z]', name):
        return False
    if re.match(r'^[\d.]+[PK]?$', name):
        return False
    return True


def parse_tr(html, keep=None, keep_re=None, drop_re=None, require_re=None,
             order=('in', 'out', 'cache'), keep_over_re=None):
    """通用表格解析：逐 <tr> 提取含'元'的行（v0.3 起输出结构化 in/out/cache）。
    keep:      可选前缀元组，仅保留自家模型名（如 ('qwen',) 过滤掉转售的第三方）。
    keep_re:   可选正则，仅保留匹配的主流档位名。
    drop_re:   可选正则，命中模型名则丢弃（如阶跃剔除语音类）。
    require_re:可选正则，行文本必须命中才保留（如 MiniMax 只留"百万 tokens"计价行）。
    order:     行内价格出现顺序对应的语义（默认 ('in','out','cache')）。
               阶跃表头为「输入(未命中)/输入(命中)/输出」→ order=('in','cache','out')。
    keep_over_re: 白名单正则——命中则无视 SNAP_RE（如 step-5-preview 是真模型名非快照）。"""
    out = []
    for row in re.findall(r'<tr[^>]*>[\s\S]{0,900}?</tr>', html):
        text = strip_tags(row)
        if '元' not in text:
            continue
        if require_re and not require_re.search(text):
            continue
        prices = extract_prices(text)
        if not prices:
            continue
        tokens = text.split()
        name = tokens[0] if tokens else ''
        if not looks_like_model(name):
            continue
        # v3.52.0（审计批2·S4）：黑白名单分离 —— 只有真快照（日期后缀/「快照」）才丢；
        #   -preview/-latest/-us 等 soft 命中**收录 + 进待确认清单**（漏收真型号 = 按未收录计价，更贵）。
        if not apply_snap_verdict(name, keep_over_re):
            continue
        if drop_re and drop_re.search(name):
            continue
        if keep_re and not keep_re.match(name):
            continue

        def _at(pos):
            return prices[pos] if len(prices) > pos else None
        slot = {'in': _at(0), 'out': _at(1), 'cache': _at(2)}
        in_v, out_v, cache_v = slot[order[0]], slot[order[1]], slot[order[2]]
        rec = {
            'name': name,
            'raw_text': text[:300],
            'in_price': ['%s元' % in_v] if in_v is not None else [],
            'out_price': ['%s元' % out_v] if out_v is not None else [],
            'context': next((t for t in tokens if re.match(r'^\d+[KkMm]$', t)), ''),
        }
        if cache_v is not None:
            rec['cache_hit'] = ['%s元' % cache_v]
        out.append(rec)
    if keep:
        out = [m for m in out if m['name'].lower().startswith(keep)]
    # 去重（保留首次出现）
    seen, uniq = set(), []
    for m in out:
        if m['name'] in seen:
            continue
        seen.add(m['name'])
        uniq.append(m)
    return uniq


def _znum(s):
    """表格单元格 → 数字；'免费'/'不支持'/'限时免费' 等非数字返回 None"""
    s = (s or '').strip()
    m = re.match(r'^(\d+(?:\.\d+)?)$', s)
    return float(m.group(1)) if m else None


# ── v3.59.0（审计 S5）：页面单位声明校验（公共）──────────────────────────────
# 背景：各家解析器只抓数字，unit 全靠 main 里 setdefault('元/百万 tokens') 兜底 →
#   厂商把计价单位从「元/百万 tokens」改成「元/千 tokens」时价格照抓、单位照盖，
#   1000× 错价**静默**入账（setdefault 把语义闸门架空了）。
# 口径（2026-10-14 逐家抓真实页面实证）：
#   智谱  —— 表头每列带「（元/百万 Tokens）」+ 全局「除特别说明外统一按元/百万 Tokens 展示」
#   阶跃  —— 表格上方正文「单位：元／百万 tokens。」（全角／）；非 token 计价表无此声明
#   MiniMax —— 表头含「元/百万」字样（:481 已有字面量校验）
#   Kimi  —— 行首 "1M tokens" 字面量（原为隐式，本批提为显式断言）
UNIT_TOKEN_MILLION_RE = re.compile(r'元\s*[／/]\s*百万\s*tokens?', re.I)


def unit_is_token_million(text):
    """该文本是否声明「元/百万 tokens」计价（全角／半角／大小写／空格均归一）。"""
    return bool(UNIT_TOKEN_MILLION_RE.search(text or ''))


def read_unit_decl(lines, before_idx, window=40):
    """在 lines[:before_idx] 里向上找最近的「单位：X。」声明（阶跃 .md 形态）。
    返回声明文本（不含「单位：」前缀），找不到返回 None。"""
    lo = max(0, before_idx - window)
    for j in range(before_idx - 1, lo - 1, -1):
        m = re.search(r'单位[:：]\s*([^。\n]+)', lines[j])
        if m:
            return m.group(1).strip()
    return None


def parse_zhipu_docs(html):
    """智谱官方文档站定价页（v0.2，2026-09-28）——服务端渲染语义表格，无需 bundle 解析。
    列：模型名称 | 上下文 | 输入单价 | 输出单价 | 缓存存储 | 缓存命中 | 输入模态。

    v0.1 曾抓控制台页(open.bigmodel.cn/pricing 的 SPA bundle)：2026-09-28 实测该页
    「5折限时两周至09-09」活动过期 19 天仍未恢复原价(0.4/1.4)，而文档站现行价已是
    原价(0.8/2.8/0.23) → 两官方页矛盾，以文档站为准，弃用 bundle 通道。"""
    out = []
    seen = set()
    for table in re.findall(r'<table[\s\S]*?</table>', html):
        rows = re.findall(r'<tr[^>]*>([\s\S]*?)</tr>', table)
        if not rows:
            continue
        # v3.52.0（审计批2·L2）：列索引由表头**语义映射**得出，不再写死 cells[2]/[3]/[5]。
        #   旧实现「按位置取第 3/4/6 列」+「页面必须含『输入单价』」双重硬约束：厂商在价格列前
        #   插入一列（如「计费模式」）→ 输入价取到上下文长度、缓存价取到缓存存储价，且**不报错**。
        #   现改为：表头认领不到 in 或 out 列 → 整表跳过（fail-closed，宁缺勿错）。
        hdr = [strip_tags(c) for c in re.findall(r'<t[dh][^>]*>([\s\S]*?)</t[dh]>', rows[0])]
        cmap = map_price_columns(hdr)
        if cmap['in'] is None or cmap['out'] is None:
            continue
        # v3.59.0（审计 S5）：单位声明校验——智谱表头每列都带「（元/百万 Tokens）」
        #   （2026-10-14 抓真实页面实证），认领不到元/百万单位的表整表跳过。
        #   没有这道校验时：厂商把 token 计价单位改成「元/千 Tokens」而列名不变 →
        #   价格照抓、unit 被 main 的 setdefault 盖回「元/百万 tokens」→ 1000× 错价静默入账。
        #   ⚠️ 必须锚到 **in/out 认领到的那两列**，不能整表头扫：真实页面还有
        #   「缓存存储（元/百万 Tokens/小时）」这种**不同量纲**列，整表头扫会被它带恒真
        #   （夹具实测：只改输入/输出列为元/千、缓存存储列仍元/百万 → 校验形同虚设）。
        #   微调表（元/千 Tokens）/ 语音表（元/万字符）无 in/out 列已被列语义排除，
        #   走到这里仍不是元/百万的 = 真单位漂移，宁缺勿错。
        if not (unit_is_token_million(hdr[cmap['in']]) and unit_is_token_million(hdr[cmap['out']])):
            continue
        for row in rows[1:]:
            cells = [strip_tags(c) for c in re.findall(r'<td[^>]*>([\s\S]*?)</td>', row)]
            if not cells:
                continue
            name = cells[cmap['name'] or 0].strip()
            if not re.match(r'^GLM[-A-Za-z0-9.]*$', name):
                continue
            inp = _znum(cells[cmap['in']]) if cmap['in'] < len(cells) else None
            outp = _znum(cells[cmap['out']]) if cmap['out'] < len(cells) else None
            cache = (_znum(cells[cmap['cache']])
                     if cmap['cache'] is not None and cmap['cache'] < len(cells) else None)
            if inp is None and outp is None:
                continue  # 免费/无法解析的行不进价库（build_index 同样拒收无价条目）
            if name in seen:
                continue  # 同名模型多表出现（如 5V-Turbo）只取首次
            seen.add(name)
            out.append({
                'name': name,
                'brand': 'zhipu',
                'api_name': None,
                'source_type': 'first_party',
                'unit': '元/百万 tokens',  # v3.59.0（S5）：表头单位校验通过后显式回传
                'in_price': ['%s元' % inp] if inp is not None else [],
                'out_price': ['%s元' % outp] if outp is not None else [],
                'cache_hit': ['%s元' % cache] if cache is not None else [],
                'tier_note': '智谱官方文档站现行价',
                'source': '智谱官方文档站(docs.bigmodel.cn/cn/guide/start/pricing)',
            })
    return out


# v3.63.4（2026-10-21 P1 修复）：长度分档门槛（「≤ 512k 输入 tokens」里的 512）。
#   strip_tags 已把 &gt;/&lt; 解码为 >/<，故直接匹配字符。只匹配「比较符 + 数字 + k」，
#   价格数字（2.10 这类）不带 k 后缀，不会误剥。
LEN_TIER_RE = re.compile(r'([≤≥<>]=?)\s*([\d.]+)\s*[kK](?![a-zA-Z])')


def parse_minimax(html):
    """MiniMax 官方定价页（v0.4，2026-10-21）——页面两次改版后的现行结构：
    实测结构（urllib 直抓 ~684KB）：
      - 语言模型区有「标准 / 优先」两个 service tier 页签，优先 = 标准价 ×1.5（页脚注明）；
        两表行名完全相同 → 同名只取首次出现（标准表在前）。
      - M3 行（2026-10-21 起新版）：模型名后带长度门槛，3 个数字 = 输入/输出/缓存读：
          MiniMax-M3 ≤ 512k 输入 tokens 2.10 8.40 0.42
          MiniMax-M3 > 512k 输入 tokens* 4.20 16.80 0.84   （>512k 档整体 ×2）
        优先页签内同名两行 = 3.15/12.60/0.63 与 6.30/25.20/1.26（×1.5）。
        主档取标准表 ≤512k 行；>512k 与优先 tier 记入 tier_note。
      - M3 行（旧版，2026-09-28~10-20）：6 个数字两两成对 = 刊例/永久五折，
        靠「永久五折」文案分流。该文案 2026-10-21 已从页面消失 → 分支死，
        M3 落入通用分支后 nums[0] 取到「512k」里的 512 当输入价（高 244 倍，见 v3.63.4 修法）。
        旧格式保留识别能力（页面若恢复五折文案仍按末 6 位成对解析）。
      - M2.x 行：数字 = 输入, 输出, 缓存读, (缓存写)。
      - H3-Context-IR 行：仍含'元'内联（2 个数字 = 输入/输出）。
    """
    out, seen = [], set()

    def emit(name, api, in_v, out_v, cache_v, note):
        if name in seen:
            return
        seen.add(name)
        rec = {
            'name': name,
            'brand': 'minimax',
            'api_name': api,
            'source_type': 'first_party',
            'unit': '元/百万 tokens',  # v3.59.0（S5）：表头「元/百万」字面量校验通过后显式回传
            'in_price': ['%s元' % in_v] if in_v is not None else [],
            'out_price': ['%s元' % out_v] if out_v is not None else [],
            'cache_hit': ['%s元' % cache_v] if cache_v is not None else [],
            'tier_note': note,
            'source': 'MiniMax 官方定价页(platform.minimaxi.com/docs/guides/pricing-paygo)',
        }
        out.append(rec)

    for tb in re.findall(r'<table[\s\S]*?</table>', html):
        rows = re.findall(r'<tr[^>]*>([\s\S]*?)</tr>', tb)
        if not rows:
            continue
        # v3.52.0（审计批2·L2）：表头判定改走语义同义词表（原 `if '输入价格' not in header` 是
        #   字面量硬匹配：官方把「输入价格」改成「输入单价 / 输入计费」→ 整页判为非计价表 →
        #   该厂商**静默 0 模型**）。单位声明（元/百万）保留字面量校验：币种/单位禁止猜。
        hdr = [strip_tags(c) for c in re.findall(r'<t[dh][^>]*>([\s\S]*?)</t[dh]>', rows[0])]
        cmap = map_price_columns(hdr)
        if cmap['in'] is None or cmap['out'] is None:
            continue
        if '元/百万' not in strip_tags(rows[0]):
            continue  # 只处理 token 计价表（跳过 TTS/视频等按秒/万字符计费表）
        for row in rows[1:]:
            text = strip_tags(row)
            mname = re.match(r'^(MiniMax-[A-Za-z0-9.\-]+)\s*(.*)$', text)
            if not mname:
                continue
            name, rest = mname.group(1), mname.group(2)
            # v3.63.4（2026-10-21 页面改版，P1 错价修复）：M3 行现为
            #   「MiniMax-M3 ≤ 512k 输入 tokens 2.10 8.40 0.42」——
            #   长度门槛数字（512）与价格混在同一行，旧代码 nums[0] 直接取到 512 当输入价
            #   （正确 2.10，高 244 倍，已进线上索引参与计费）。先剥掉「≤/> 512k」类门槛，
            #   再取价格数字。旧五折格式（6 数字）取末 6 位，不受剥离影响。
            tier_m = LEN_TIER_RE.search(rest)
            nums = re.findall(r'(\d+(?:\.\d+)?)', LEN_TIER_RE.sub('', rest))
            if not nums:
                continue
            api = name.lower()
            if name == 'MiniMax-H3-Context-IR':
                # 内联'元'行：[输入, 输出]
                in_v = float(nums[0]) if len(nums) > 0 else None
                out_v = float(nums[1]) if len(nums) > 1 else None
                emit(name, api, in_v, out_v, None, '上下文改写模型（官方现行价）')
            elif '永久五折' in text:
                # M3 行：档位文本含 '512k' 会被抓进数字 → 取末 6 位；
                # 6 数字成对 = [刊例in, 五折in, 刊例out, 五折out, 刊例cache, 五折cache]
                if len(nums) < 6:
                    continue
                six = nums[-6:]
                tier = '≤512k' if ('≤' in rest or '<=' in rest) else '>512k'
                if tier != '≤512k':
                    continue  # 主档只存 ≤512k，>512k 记入档位说明
                list_in, in_v = float(six[0]), float(six[1])
                list_out, out_v = float(six[2]), float(six[3])
                list_ca, ca_v = float(six[4]), float(six[5])
                emit(name, api, in_v, out_v, ca_v,
                     '官方标注永久五折(实际扣费价)；刊例 输入%s/输出%s/缓存%s；'
                     '>512k档×2(刊例8.4/33.6/1.68,五折4.2/16.8/0.84)；'
                     '优先service tier按标准×1.5' % (list_in, list_out, list_ca))
            else:
                # M2.x 行 / 新版 M3 长度分档行：[输入, 输出, 缓存读, (缓存写)]
                # v3.63.4：长度分档行的主档只取 ≤ 行，> 档显式跳过 —— 不能只靠 seen 去重：
                #   页面若调换两行顺序（>512k 在前），旧法会把 2 倍价当主档静默入账。
                if tier_m and tier_m.group(1) in ('>', '>=', '≥'):
                    continue
                in_v = float(nums[0])
                out_v = float(nums[1])
                ca_v = float(nums[2]) if len(nums) > 2 else None
                if tier_m:
                    note = ('官方现行价（主档 ≤512k）；>512k 档为该档×2；'
                            '优先 service tier 为标准×1.5（页面「优先」页签）')
                else:
                    note = '%s档' % ('highspeed' if 'highspeed' in name else '标准')
                emit(name, api, in_v, out_v, ca_v, note)
    return out


def kimi_col_map(titles):
    """DocTable 列标题 → 语义索引（v3.63.4）。与 COL_SYNONYMS 同思路：按词面映射、不按位置。
    判定顺序要紧：『未命中』含『命中』，必须先判未命中（否则输入价会被缓存列抢走）。
    返回 {'in': idx|None, 'out': idx|None, 'cache': idx|None}（相对行首的单元格下标）。"""
    idx = {'in': None, 'out': None, 'cache': None}
    for i, t in enumerate(titles or []):
        if '未命中' in t:
            idx['in'] = i
        elif '命中' in t:
            idx['cache'] = i
        elif '输出' in t:
            idx['out'] = i
    return idx


def kimi_bt_row_to_record(cells_src, col_map):
    """RSC 负载一行（反引号单元格串）→ (记录 dict | None, 原因)。纯函数（无 IO）→ 可夹具测试。
    cells_src = KIMI_BT_ROW_RE 的 group(1)（`` `a`,`b`,… ``）；col_map = kimi_col_map 产物。
    原因取值：'no-match'（不是模型行）/ 'name'（非 kimi 模型名）/ 'unit'（计价单位非 1M tokens）/
    'prices'（价格列取不到值）/ None（成功）。"""
    vals = [v.strip() for v in re.findall(r'`([^`]*)`', cells_src or '')]
    if len(vals) < 3:
        return None, 'no-match'
    name, unit = vals[0], vals[1]
    if not KIMI_MODEL_RE.match(name):
        return None, 'name'
    um = re.match(r'^(?P<qty>[\d.,]+)(?P<mag>[MK])\s*tokens$', unit, re.I)
    if not um:
        return None, 'no-match'
    # v3.59.0（审计 S5）单位断言：量纲错位会 1000× 错价，必须显式校验而非静默按 1M 解释
    if not (um.group('qty') == '1' and um.group('mag').upper() == 'M'):
        return None, 'unit'

    def _price(i):
        if i is None or i >= len(vals):
            return None
        pm = re.match(r'^¥([\d.]+)$', vals[i])
        return pm.group(1) if pm else None

    inp = _price(col_map.get('in'))
    outp = _price(col_map.get('out'))
    cache = _price(col_map.get('cache'))
    if inp is None and outp is None:
        return None, 'prices'
    return {
        'name': name,
        'brand': 'kimi',
        'api_name': name,
        'source_type': 'first_party',
        'unit': '元/百万 tokens',  # v3.59.0（S5）：单位断言通过后显式回传
        'in_price': ['%s元' % inp] if inp else [],
        'out_price': ['%s元' % outp] if outp else [],
        'cache_hit': ['%s元' % cache] if cache else [],
        'tier_note': 'Kimi 官方价(¥/1M tokens)',
    }, None


def parse_stepfun_md(md, drop_re=None, keep_over_re=None):
    """阶跃官方定价页 .md 源（v3.51.0，2026-10-12 页面改版后切换）。

    结构（实测）：
      单位：元／百万 tokens。
      | Model ID | 输入价格（缓存未命中） | 输入价格（缓存命中） | 输出价格 |
      | `step-5-preview` | 7 | 0.70 | 20 |
    规则：
      - 只收表头同时含「输入价格」「输出价格」的表（按 Token 计价）；TTS/ASR/复刻等
        「单价」表（元／万字符、元／小时、元／音色）不是 token 计价，直接跳过；
      - 列语义按表头文本映射（缓存未命中→in、缓存命中→cache、输出→out），不按位置；
      - 单位从表格上方最近的「单位：X。」正文读取，读不到即该表契约不全、跳过；
      - 调价公告（生效日期在未来）→ 当日按公告的「由」值入账，并落结构化
        `superseded_at`（旧值有效期到公告时刻）；已生效 → 现值 + `effective_from`。
        公告识别走可复用层 parse_adjustment_notices（句式库，见其定义处）。
    """
    out = []
    lines = md.splitlines()
    # 预扫描：调价公告（归一化模型名 → 字段/旧值/新值/生效时间）。
    # v3.62.0（外部审计 F-4）：抽成可复用层 parse_adjustment_notices（句式库 + 纯函数）——
    #   原先整段内联在此，别的厂商要抄整套；现在补一条正则即可接公告检测。
    adjustments = parse_adjustment_notices(md)
    i = 0
    while i < len(lines):
        ln = lines[i]
        if not ln.lstrip().startswith('|'):
            i += 1
            continue
        # 收集连续表格行
        tbl = []
        while i < len(lines) and lines[i].lstrip().startswith('|'):
            tbl.append(lines[i].strip())
            i += 1
        if len(tbl) < 3:
            continue
        # v3.52.0（审计批2·L2）：列索引改走**共享语义同义词表** map_price_columns。
        #   原实现在每家解析器里各写一份字面量判定（'输入价格' in c and '缓存未命中' in c …），
        #   厂商把「输入价格」改成「输入单价 / Prompt 单价」就得改代码；且 cache/in 的区分
        #   依赖「命中」修饰词顺序，复制多份必然走样。统一走同义词表：改词面只需补 COL_SYNONYMS。
        hdr = [c.strip() for c in tbl[0].strip('|').split('|')]
        cmap = map_price_columns(hdr)
        col_in, col_out, col_cache = cmap['in'], cmap['out'], cmap['cache']
        # 语义映射要求「同时认领到输入价列与输出价列」，否则不是 token 计价表
        #   （单价表：元／万字符、元／小时… 无输入/输出列 → 自然被排除，无需再写字面量判定）
        if col_in is None or col_out is None:
            continue
        # v3.59.0（审计 S5）：单位：向上找最近的「单位：X。」——此前只停在注释层、**未实现**，
        #   单位全靠 main 的 setdefault 兜底。真实页面（2026-10-14 抓取）形态：
        #   每个 token 计价表上方都有「单位：元／百万 tokens。」；万字符/小时/音色等
        #   非 token 表没有该声明（且已被列语义排除）→ 找不到声明 = 不是 token 计价表。
        #   声明存在但不是元/百万 = 真单位漂移 → WARN + 跳过（宁缺勿错）。
        tbl_start = i - len(tbl)
        unit_decl = read_unit_decl(lines, tbl_start)
        if unit_decl is None:
            continue
        if not unit_is_token_million(unit_decl):
            print('[WARN] stepfun: 表单位非元/百万 tokens（%s）→ 跳过该表' % unit_decl)
            continue
        for row in tbl[2:]:  # 跳过表头与分隔行
            cells = [c.strip().strip('`') for c in row.strip('|').split('|')]
            if len(cells) <= max(col_in, col_out):
                continue
            name = cells[0].strip()
            if not re.match(r'^step-[0-9a-z.\-]+$', name, re.I):
                continue
            # v3.52.0（S4）：同 parse_tr —— soft 快照样式不再静默丢弃
            if not apply_snap_verdict(name, keep_over_re):
                continue
            if drop_re and drop_re.search(name):
                continue
            def _num(s):
                m = re.match(r'^(\d+(?:\.\d+)?)$', (s or '').strip())
                return float(m.group(1)) if m else None
            in_v = _num(cells[col_in])
            cache_v = _num(cells[col_cache]) if col_cache is not None and col_cache < len(cells) else None
            out_v = _num(cells[col_out])
            if in_v is None and out_v is None:
                continue  # 限时免费（—）等非计价行
            note = '阶跃官方定价页现行价（.md 源）'
            # v3.62.0（外部审计 F-4）：**结构化生效时间**。改前公告只写进 tier_note 字符串
            #   （下游无法据此重算/回溯）；现同时落两个机器可读字段：
            #     effective_from —— 本条价格自何时起有效（公告已生效 = 公告生效时刻）；
            #     superseded_at  —— 本条价格将被何时取代（公告在未来 = 当日按旧值，旧值的有效期到公告时刻）。
            #   build_index 会把它们带进索引与每日价格快照（F-3 按当时价重算的判据之一）。
            eff_from = None
            superseded = None
            # 生效日期公告：仅当表格现值 == 公告新值时才判定「该公告针对此列」（防误伤）；
            #   未来生效 → 当日按公告旧值；已生效 → 表格现值。全部取页面显式数据。
            adj = adjustments.get(re.sub(r'[\s_\-.]', '', name.lower()))
            if adj:
                cur = {'in': in_v, 'cache': cache_v, 'out': out_v}[adj['field']]
                fld_label = ('缓存命中' if adj['field'] == 'cache' else '') + ('输出' if adj['field'] == 'out' else '输入')
                if cur is not None and abs(cur - adj['new']) < 1e-9:
                    # v3.62.0（外部审计 F-4）：公告写的是「北京时间」，比对必须同口径。
                    #   改前用 datetime.now()（机器本地）→ 非 UTC+8 机器整体偏移若干小时，
                    #   会把未生效的公告判成已生效（提前采用新价）或反之，且零告警。
                    now_iso = beijing_now().strftime('%Y-%m-%dT%H:%M')
                    if adj['effective'] > now_iso:
                        if adj['field'] == 'in':
                            in_v = adj['old']
                        elif adj['field'] == 'cache':
                            cache_v = adj['old']
                        else:
                            out_v = adj['old']
                        superseded = adj['effective']  # 旧值只有效到公告生效时刻
                        note += '；⚠官方公告：%s价 %s 起 %s→%s（生效前按 %s 计）' % (
                            fld_label, adj['effective'], adj['old'], adj['new'], adj['old'])
                    else:
                        eff_from = adj['effective']  # 现值即公告新值，自公告时刻起生效
                        note += '；官方公告：%s价 %s 起 %s→%s（已生效）' % (
                            fld_label, adj['effective'], adj['old'], adj['new'])
            rec = {
                'name': name,
                'brand': 'stepfun',
                'api_name': name.lower(),
                'source_type': 'first_party',
                'unit': '元/百万 tokens',  # v3.59.0（S5）：表格上方单位声明校验通过后显式回传
                'in_price': ['%s元' % in_v] if in_v is not None else [],
                'out_price': ['%s元' % out_v] if out_v is not None else [],
                'cache_hit': ['%s元' % cache_v] if cache_v is not None else [],
                'tier_note': note,
                'source': '阶跃官方定价页(platform.stepfun.com .md 源)',
            }
            if eff_from:
                rec['effective_from'] = eff_from
            if superseded:
                rec['superseded_at'] = superseded
            out.append(rec)
    return out


# v3.61.0（审计 F1 修复建议 2）：Kimi 行正则 + 行解析抽成**纯函数**，供 selftest 夹具测试
#   （不打网络、不读盘）——F1 的根因正是"没有 parse_kimi 的夹具测试"，索引漂移才能在线上躺一个版本。
KIMI_ROW_RE = re.compile(
    r'\["(?P<name>[^"]+)",\s*"(?P<unit>[\d.,]+[MK])\s*tokens",\s*'
    r'(?P<prices>.*?),\s*"(?P<total>[\d,]+) tokens"\]')


def parse_kimi_row(line):
    """解析 Kimi 文档页的一行表格 → (记录 dict | None, 原因)。

    纯函数（无 IO / 无网络 / 无全局副作用）→ selftest 可直接 require 本模块做夹具测试。
    原因取值：
      'no-match' —— 不是表格行（调用方据此不计入 matched_rows）；
      'unit'     —— 计价单位非 1M tokens（v3.59.0 审计 S5 的单位断言，量纲错位会 1000× 错价）；
      'prices'   —— 价格个数不足 2（<2 无法构成 in/out）；
      None       —— 成功。
    价格语义 = [缓存命中, 输入(未命中), 输出]；k3 行多出历史列（共 5 个价）→ 统一取**末 3 位**。
    """
    m = KIMI_ROW_RE.match(str(line).strip())
    if not m:
        return None, 'no-match'
    if m.group('unit').upper() != '1M':
        return None, 'unit'
    prices = re.findall(r'"¥([\d.]+)"', m.group('prices'))
    if len(prices) >= 3:
        cache, inp, outp = prices[-3:]  # k3 行多历史列 → 取末 3 位
    elif len(prices) == 2:
        cache, inp, outp = None, prices[0], prices[1]
    else:
        return None, 'prices'
    return {
        'name': m.group('name'),
        'brand': 'kimi',
        'api_name': m.group('name'),
        'source_type': 'first_party',
        'unit': '元/百万 tokens',  # v3.59.0（S5）：单位断言通过后显式回传
        'in_price': ['%s元' % inp],
        'out_price': ['%s元' % outp],
        'cache_hit': ['%s元' % cache] if cache else [],
        'tier_note': 'Kimi 官方价(¥/1M tokens)',
    }, None


def parse_kimi_html(html):
    """HTML 页 RSC DocTable → (记录 list, matched_rows)。纯函数（无 IO）→ 可夹具测试。
    matched_rows = 正则匹配到表格行的次数（区分「页面没行」与「行全被跳过」，同 .md 路径口径）。"""
    out = []
    matched_rows = 0
    for tm in KIMI_TABLE_RE.finditer(html or ''):
        col_map = kimi_col_map(KIMI_TITLE_RE.findall(tm.group('cols')))
        if col_map['in'] is None or col_map['out'] is None:
            continue  # 不是 token 计价表（无输入/输出语义列）
        for rm in KIMI_BT_ROW_RE.finditer(tm.group('rows')):
            rec, reason = kimi_bt_row_to_record(rm.group(1), col_map)
            if reason in ('no-match', 'name'):
                continue
            matched_rows += 1
            if reason == 'unit':
                print('[WARN] kimi: 计价单位非 1M tokens → 跳过该行（v3.59.0 S5 单位断言）')
                continue
            if rec is None:
                continue
            rec['source'] = 'Kimi 官方文档 %s（RSC DocTable）' % KIMI_HTML_URL
            out.append(rec)
    return out, matched_rows


def parse_kimi():
    """Kimi(Moonshot) 官方价。
    v0.4（2026-10-21 页面改版）：主路径改抓 HTML 页 RSC 负载（反引号 DocTable，列语义映射，
    见 kimi_bt_row_to_record）；旧 .md 路径降级为兜底（页面回退时仍能抓到）。
    v0.3(2026-09-28)：moonshot.cn 文档已 301 迁至 platform.kimi.com；chat-k25 / chat-v1
    实测已是死页（0 行），剔除；3 个有效页返回同一张表，留 1 页即可。
    """
    out = []
    matched_rows = 0  # v3.61.0：正则匹配到的行数 —— 用于区分「页面没行」与「行全被跳过」
    # ── 主路径：HTML 页 RSC DocTable（v3.63.4）──
    try:
        t = http_get(KIMI_HTML_URL, 20)
    except Exception as e:
        print('[WARN] kimi html: %s' % repr(e)[:80])
        t = ''
    out, matched_rows = parse_kimi_html(t)
    # ── 兜底：旧 .md 路径（页面回退到 mintlify .md 导出时；v3.63.4 起仅为 fallback）──
    if not out:
        print('[WARN] kimi: HTML 页未解析到价格行，回退旧 .md 路径（%s）' % KIMI_PAGES)
        base = 'https://platform.kimi.com/docs/pricing/'
        for pg in KIMI_PAGES:
            try:
                t = http_get(base + pg + '.md', 20)
            except Exception as e:
                print('[WARN] kimi %s: %s' % (pg, repr(e)[:80]))
                continue
            for line in t.splitlines():
                if not line.strip().startswith('['):
                    continue
                rec, reason = parse_kimi_row(line)
                if reason == 'no-match':
                    continue
                matched_rows += 1
                if reason == 'unit':
                    print('[WARN] kimi %s: 计价单位非 1M tokens（%s tokens）→ 跳过该行'
                          % (pg, KIMI_ROW_RE.match(line.strip()).group('unit')))
                    continue
                if rec is None:
                    continue
                name = rec['api_name']
                if not apply_snap_verdict(name):
                    continue
                rec['source'] = 'Kimi 官方文档 %s.md' % pg
                out.append(rec)
    seen, uniq = set(), []
    for m in out:
        if m['api_name'] in seen:
            continue
        seen.add(m['api_name'])
        uniq.append(m)
    # v3.61.0（审计 F1/P2）：细粒度告警。main() 的「0 模型即 failed」只知道**结果**，
    #   这里补上**原因**：正则匹配到行却 0 条收录 = 每行都被跳过（快照判定 / 单位断言 / 价格位数），
    #   而不是「页面没行」。没有这段，F1 那种「每行静默 continue」在下游看起来和「官网改版」一模一样。
    if matched_rows and not uniq:
        print('[WARN] kimi: 正则匹配到 %d 行但 0 条收录（快照判定/单位断言/价格位数把每行都跳过）'
              '→ 该厂商将 0 模型，价格沿用上版' % matched_rows)
    return uniq


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    result = {
        # v3.62.0（外部审计 F-4）：带时区的北京时刻。改前是本地 naive 时间，
        #   build_index 的 SOURCE_TTL_HOURS 校验只能按「假设是北京时间」解释，
        #   非 UTC+8 机器上新鲜度判定整体偏移。aware 后无需假设。
        'fetched_at': beijing_now().isoformat(timespec='seconds'),
        'currency': 'CNY',
        'unit': '元/百万 tokens',
        'region': 'CN',
        'source_type': 'vendor-official-page',
        'vendors': {},
    }
    total = 0
    skipped_vendors = {}   # v3.62.0（F-2）：设计上不抓的厂商（≠ 失败，不进 _fetch_summary.failed）
    for key, cfg in VENDORS.items():
        entry = {'name': cfg['name'], 'url': cfg['url'], 'mode': cfg['mode'],
                 'status': 'ok', 'models': [], 'error': None}
        try:
            if cfg['mode'] == 'external':
                # v3.62.0（外部审计 F-2）：DeepSeek 走 Node 侧 deepseek-official.js → pricing.json，
                #   本脚本明确不抓（原 mode:'pricing' 是「读回自己产物」的自我引用闭环，已拆）。
                #   status='skipped'：**不算抓取失败**（否则每天假降级一次），只作显式记录。
                entry['status'] = 'skipped'
                entry['note'] = '官方价走 deepseek-official.js → pricing.json；进索引走 build_index 的 lock 覆盖层'
                skipped_vendors[key] = entry['note']
                print('[SKIP] %-22s 设计上不抓（%s）' % (cfg['name'], entry['note']))
                result['vendors'][key] = entry
                continue
            # v3.52.0（审计批2·G3）：非 kimi 分支原走裸 fetch()（urllib）→ **绕过了 http_get 里
            #   的解压与 TLS 降级开关**：只装了 requests 的机器上，若某厂商开始返回压缩页
            #   （urllib 不自动解压）→ 拿到二进制垃圾 → 0 模型且退出码 0（最坏的静默失败）。
            #   统一走 http_get：requests 优先（自动解压/跟随 301）+ 无 requests 回退 urllib。
            html = http_get(cfg['url'])
            if cfg['mode'] == 'tr':
                entry['models'] = parse_tr(html, cfg.get('keep'), cfg.get('keep_re'), cfg.get('drop_re'), cfg.get('require_re'),
                                           cfg.get('order', ('in', 'out', 'cache')), cfg.get('keep_over_re'))
            elif cfg['mode'] == 'minimax':
                entry['models'] = parse_minimax(html)
            elif cfg['mode'] == 'zhipu_docs':
                entry['models'] = parse_zhipu_docs(html)
            elif cfg['mode'] == 'kimi':
                entry['models'] = parse_kimi()
            elif cfg['mode'] == 'stepfun_md':
                entry['models'] = parse_stepfun_md(html, cfg.get('drop_re'), cfg.get('keep_over_re'))
            # v3.52.0（审计批2·L1）：结构指纹 —— 页面「长什么样」的可审计证据。
            #   0 模型时两类根因（网络失败 vs 官网改版）在旧版输出里**长得一模一样**
            #   （都是「0 个模型」），只能靠人重跑肉眼比对；指纹把它变成可比对的结构数据。
            entry['fingerprint'] = scan_fingerprint(html)
            # 补全 source 标注（解析器未设时回退到厂商名）
            # v3.51.0（审计批1·B）：补全契约字段 —— 本脚本只抓国内厂商官方人民币价页，
            #   unit/currency/region 由设计前提恒定（页面价格均以「X元」形式给出，见
            #   extract_prices / 各 parse_* 的 '%s元' 构造）；逐条显式落到模型记录上，
            #   供 build_index 契约海关校验（缺字段的条目会被拒收+告警，不会静默入账）。
            for mm in entry['models']:
                mm.setdefault('source', cfg['name'])
                # v3.59.0（审计 S5）：unit 不再静默兜底。各家解析器已在**页面单位声明校验
                #   通过后**显式回传 unit（智谱表头/阶跃正文/MiniMax 表头/Kimi 行首 1M tokens）；
                #   走到 setdefault 说明该厂商解析器没有单位校验 = 页面改单位会 1000× 错价
                #   静默入账的那条路 → WARN 留痕（可见的失败），同时仍按设计前提兜底
                #   （缺 unit 会被 build_index 契约海关拒收 → 整厂商停更，比错价更糟）。
                if 'unit' not in mm:
                    print('[WARN] %s: 解析器未回传 unit（无页面单位校验）→ 按设计前提兜底 元/百万 tokens'
                          % cfg['name'])
                    mm['unit'] = '元/百万 tokens'
                mm.setdefault('currency', 'CNY')
                mm.setdefault('region', 'CN')
                mm.setdefault('source_url', cfg['url'])
                mm.setdefault('fetched_at', result['fetched_at'])
            total += len(entry['models'])
            print('[OK]   %-22s %d 个模型' % (cfg['name'], len(entry['models'])))
        except Exception as e:
            entry['status'] = 'error'
            entry['error'] = repr(e)[:200]
            print('[FAIL] %-22s %s' % (cfg['name'], repr(e)[:80]))
        result['vendors'][key] = entry
        time.sleep(0.5)

    # v0.5（2026-10-02）：抓取失败结构化摘要。
    # 原问题：只要有任意一家抓成功（total 非 0）进程就 exit 0，下游只看到「成功」——
    #   今天 4/5 家源挂了、价库悄悄少一大半数据，无人察觉。
    # 判定口径与流水线 M6 一致：status=error，或「成功但解析出 0 个模型」，都算失败
    #   （官网改版 / 软 404 常见于后者，旧版会把它静默算成功）。
    # v3.62.0（外部审计 F-2）：status='skipped'（设计上不抓，如 DeepSeek 走 external）
    #   **不算失败** —— 它每天都是 0 模型，若计入 failed 会天天假降级一次（A-8 永久噪音坑）。
    failed = {}
    for key, entry in result['vendors'].items():
        if entry['status'] == 'skipped':
            continue
        if entry['status'] != 'ok':
            failed[key] = entry.get('error') or '未知错误'
        elif not entry['models']:
            failed[key] = '解析出 0 个模型（官网改版/schema 变更?）'
    ok_keys = [k for k in result['vendors'] if k not in failed]

    result['model_count'] = total
    # 供下游消费的失败摘要（本脚本 stdout 无 JSON 契约，此字段落在 cn-prices-*.json / latest.json）。
    # ⚠需下游配合读取：build_index.py 自 v3.62.0 起消费 failed/stale（见 _fetch_degraded）。
    result['_fetch_summary'] = {
        'vendors_total': len(result['vendors']),
        'vendors_ok': len(ok_keys),
        'vendors_failed': len(failed),
        'models_total': total,
        'ok': ok_keys,
        'failed': failed,
        # v3.62.0（外部审计 F-2）：设计上不抓的厂商（≠ 失败）——让"今天只有 4 家在抓"这件事
        #   在摘要里显式可见，而不是靠读者自己发现"第五家永远 0 模型"。
        'skipped_vendors': skipped_vendors,
        # v3.52.0（审计批2·L1/L4）：0 模型厂商的结构指纹（区分「网络失败」vs「官网改版」）；
        #   S4 待确认清单（soft 快照样式被收录的型号，供人工确认是否为真型号）。
        'fingerprints': {k: v.get('fingerprint') for k, v in result['vendors'].items()
                         if k in failed and v.get('fingerprint')},
        'pending_confirm': sorted(set(PENDING_CONFIRM)),
        'note': 'failed 非空表示当日这些厂商源未产出数据，价格可能沿用上版；skipped_vendors 是设计上不抓（非失败）',
    }
    if failed:
        sys.stderr.write('[FAIL-SUMMARY] %d/%d 家厂商抓取失败（其余 %d 家成功，共 %d 个模型）：\n'
                         % (len(failed), len(result['vendors']), len(ok_keys), total))
        for key, err in failed.items():
            sys.stderr.write('  - %s(%s): %s\n' % (result['vendors'][key]['name'], key, err))
            fp = result['vendors'][key].get('fingerprint')
            if fp:
                sys.stderr.write('      结构指纹: %s\n' % json.dumps(fp, ensure_ascii=False))
    # v3.52.0（审计批2·S4）：待确认清单 WARN —— 这些模型带 preview/latest/us 后缀但**已收录**
    #   （旧版会静默丢弃它们）。人工确认是真型号即可把后缀加进 keep_over_re 消掉告警。
    if PENDING_CONFIRM:
        sys.stderr.write('[WARN] %d 个「疑似快照别名」型号已收录（旧版会静默丢弃，漏收真型号 = 按未收录计价）：%s\n'
                         % (len(set(PENDING_CONFIRM)), ', '.join(sorted(set(PENDING_CONFIRM))[:20])))
    # v3.62.0（外部审计 F-4）：文件名是**数据归属日**，必须用北京日。改前用本地日 →
    #   跨日边界（北京 0 点前后）落错文件名，之后按日回溯（价格历史快照）取不到当天数据。
    stamp = beijing_today()
    path = os.path.join(OUT_DIR, 'cn-prices-%s.json' % stamp)
    # v2.82：原子写（唯一 tmp + os.replace）。多会话并发刷新时另一进程的 build_index.py
    # 可能正在读 latest.json，裸 open('w') 会写出半截 JSON，对方 json.load 直接崩。
    tmp = path + '.tmp-%d' % os.getpid()
    with open(tmp, 'w', encoding='utf-8') as f:
        # v3.59.0（批10·M17）：allow_nan=False —— 默认会写出 `NaN` 字面量，Node 侧 JSON.parse 抛错致计费崩
        json.dump(result, f, ensure_ascii=False, indent=2, allow_nan=False)
    os.replace(tmp, path)
    latest = os.path.join(OUT_DIR, 'latest.json')
    tmp2 = latest + '.tmp-%d' % os.getpid()
    with open(tmp2, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2, allow_nan=False)
    os.replace(tmp2, latest)
    print('\n共 %d 个模型，已写入：\n  %s\n  %s'
          % (total, path, latest))
    # v0.5：exit code 维持 fail-soft（仅「全军覆没」total==0 才非 0）。
    # 依据实际调用契约（token-tracker.js kickLocalDbRefresh → runAll）：三脚本按
    #   fetch-cn-prices.py && parse_tokenhub.py && build_index.py 串行，且**只有 code===0 才继续下一个**
    #   （c.on('exit') 里 `if (code === 0 && !timedOut) return resolve(runAll(idx + 1))`）。
    # 若「部分厂商失败」也返回非 0 → 流水线在此中断，parse_tokenhub.py / build_index.py 不再执行，
    #   今天已抓到的部分数据不会并入 index.json，连 build_index.py 的「逐模型沿用上版」兜底也失效，
    #   比保持 0 更糟。故部分失败仍返回 0，改以 stderr [FAIL-SUMMARY] + JSON _fetch_summary 暴露。
    return 0 if total else 1


if __name__ == '__main__':
    sys.exit(main())
