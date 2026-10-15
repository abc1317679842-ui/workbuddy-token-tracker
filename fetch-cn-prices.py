#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国内厂商官方人民币价抓取器（v0.5，2026-10-02）
- v0.5：① 数据根探测 detect_workbuddy_root()（WB_ROOT > ~/.workbuddy-ai > ~/.workbuddy，与 Node 侧
  detectWorkBuddyRoot 同口径）——修「客户端迁到 ~/.workbuddy-ai 后 Python 侧仍写死 ~/.workbuddy」；
  ② requests 分支补 verify=，修 CN_PRICES_INSECURE_TLS 降级对「装了 requests 的机器」静默失效；
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
try:
    import requests  # 可选依赖：全脚本只有 Kimi 文档页用到；缺失时 http_get() 自动回退 urllib
except ImportError:
    requests = None

# v3.60.0（CI 编码 · 2026-10-15）：Windows 上 sys.stdout 默认走 **locale 编码**（如 cp1252）——
#   一旦 print 中文即 UnicodeEncodeError、整个脚本崩（CI Windows runner 实测；本机 locale=UTF-8 故不复现）。
#   调用方 token-tracker.js 按 utf-8 解码流水线输出 → 输出契约本就该是 utf-8。
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

def detect_workbuddy_root():
    """v0.5（2026-10-02）：WorkBuddy 数据根探测，与 Node 侧 detectWorkBuddyRoot
    （token-tracker.js:239-249 / refresh-prices.js:40-50）**逐字等价**。背景：新版客户端可能把数据根
    迁到 ~/.workbuddy-ai，若此处写死 ~/.workbuddy，本脚本读 DeepSeek 价的 PRICING_PATH 会指向错误
    路径，且 build_index.py 的「沿用旧价」分支会静默兜底，用户完全察觉不到。
    语义（与 Node 完全一致，勿自作聪明「更稳」——两端必须算出同一个根）：
      ① WB_ROOT 环境变量**非空即用**（空串等同未设置；不校验目录是否存在，对应 Node 的 `||`）；
      ② 否则在 [~/.workbuddy-ai, ~/.workbuddy] 中取第一个含 traces/ 或 settings.json 签名者；
      ③ 都不命中 → 兜底 ~/.workbuddy（对应 Node 末尾的 return）。
    ⚠️ 本函数需与 build_index.py 中的同名实现保持一致，且必须与 token-tracker.js:239-249 等价
      （两个 py 文件无共享模块，各自实现）。
    """
    env = os.environ.get('WB_ROOT')
    if env:  # 空串等同未设置，与 Node 的 `process.env.WB_ROOT ||` 一致
        return env
    h = os.path.expanduser('~')
    for c in (os.path.join(h, '.workbuddy-ai'), os.path.join(h, '.workbuddy')):
        try:
            if os.path.exists(os.path.join(c, 'traces')) or os.path.exists(os.path.join(c, 'settings.json')):
                return c
        except OSError:
            pass
    return os.path.join(h, '.workbuddy')


# DeepSeek 官方价由用户已在 pricing.json 校对（lock），不重复抓取，
# 直接读该文件作为库的 DeepSeek first_party 源。
WB_ROOT = detect_workbuddy_root()
PRICING_PATH = os.path.join(WB_ROOT, 'skills', 'token-usage-tracker', 'pricing.json')

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

# 厂商配置。mode:
#   tr     —— 页面含 <table>，逐行提取含"元"的行
#   bundle —— SPA，价格硬编码在前端 JS bundle 里，需三步解析
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
        'url': '(来自 pricing.json 用户已校对官方价)',
        'mode': 'pricing',
    },
    'zhipu': {
        'name': '智谱 GLM',
        'url': 'https://docs.bigmodel.cn/cn/guide/start/pricing',
        'mode': 'zhipu_docs',
    },
    'kimi': {
        'name': 'Kimi(Moonshot)',
        'url': 'https://platform.moonshot.cn/docs/pricing/',
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


def parse_minimax(html):
    """MiniMax 官方定价页（v0.3，2026-09-28）——页面已改版：数据行不含'元'（单位在表头）。
    实测结构（urllib 直抓 577KB，76 行）：
      - 语言模型区有「标准 / 优先」两个 service tier 表，优先 = 标准价 ×1.5（页脚注明）；
        两表行名完全相同 → 同名同档只取首次出现（标准表在前）。
      - M3 行：模型名后带档位与「永久五折」，6 个数字两两成对 = 刊例/五折：
          MiniMax-M3 ≤512k 永久五折 4.20 2.10 16.80 8.40 0.84 0.42
          → 输入 刊例4.20/五折2.10；输出 刊例16.80/五折8.40；缓存读 刊例0.84/五折0.42
        >512k 档整体 ×2。计费价取「永久五折」价（官方标注永久折扣 = 实际扣费口径），
        主档取 ≤512k，>512k 与优先 tier 写入 tier_note。
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
            nums = re.findall(r'(\d+(?:\.\d+)?)', rest)
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
                # M2.x 行：[输入, 输出, 缓存读, (缓存写)]
                in_v = float(nums[0])
                out_v = float(nums[1])
                ca_v = float(nums[2]) if len(nums) > 2 else None
                extra = '%s档' % ('highspeed' if 'highspeed' in name else '标准')
                emit(name, api, in_v, out_v, ca_v, extra)
    return out


KIMI_PAGES = ['chat-k3']


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
      - 调价公告（生效日期在未来）→ 当日按公告的「由」值入账，future 值写 tier_note；
        生效日期已过/无公告 → 按表格现值。全部取页面显式数据，不猜测。
    """
    out = []
    lines = md.splitlines()
    # 预扫描：调价公告（归一化模型名 → 字段/旧值/新值/生效时间）。
    # 公告句形如「Step 5 Preview 的缓存命中输入价格自北京时间 2026 年 10 月 14 日 00:30 起由 0.35
    #   元／百万 tokens 调整为 0.70 元／百万 tokens」——模型名是显示名（有空格），与 API id
    #   （step-5-preview）不同形，两边都去标点归一后对齐。
    adjustments = {}
    for ln in lines:
        m = STEP_ADJ_RE.search(ln)
        if not m:
            continue
        y, mo, d, hh, mm, old_v, new_v = m.groups()
        nm_m = re.search(r'([A-Za-z][A-Za-z0-9 .\-]{2,40}?)\s*的\s*(缓存命中)?(输入|输出)价格', ln)
        fld_m = re.search(r'的\s*(缓存命中)?(输入|输出)价格', ln)
        names = set()
        if nm_m:
            names.add(re.sub(r'[\s_\-.]', '', nm_m.group(1).lower()))
        for nm in re.findall(r'`(step-[0-9a-z.\-]+)`', ln):
            names.add(re.sub(r'[\s_\-.]', '', nm.lower()))
        if not names:
            continue
        field = 'cache' if (fld_m and fld_m.group(1)) else ('out' if (fld_m and fld_m.group(2) == '输出') else 'in')
        for nk in names:
            adjustments[nk] = {
                'old': float(old_v), 'new': float(new_v),
                'effective': '%04d-%02d-%02dT%02d:%02d' % (int(y), int(mo), int(d), int(hh), int(mm)),
                'field': field,
            }
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
            # 生效日期公告：仅当表格现值 == 公告新值时才判定「该公告针对此列」（防误伤）；
            #   未来生效 → 当日按公告旧值；已生效 → 表格现值。全部取页面显式数据。
            adj = adjustments.get(re.sub(r'[\s_\-.]', '', name.lower()))
            if adj:
                cur = {'in': in_v, 'cache': cache_v, 'out': out_v}[adj['field']]
                fld_label = ('缓存命中' if adj['field'] == 'cache' else '') + ('输出' if adj['field'] == 'out' else '输入')
                if cur is not None and abs(cur - adj['new']) < 1e-9:
                    now_iso = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M')
                    if adj['effective'] > now_iso:
                        if adj['field'] == 'in':
                            in_v = adj['old']
                        elif adj['field'] == 'cache':
                            cache_v = adj['old']
                        else:
                            out_v = adj['old']
                        note += '；⚠官方公告：%s价 %s 起 %s→%s（生效前按 %s 计）' % (
                            fld_label, adj['effective'], adj['old'], adj['new'], adj['old'])
                    else:
                        note += '；官方公告：%s价 %s 起 %s→%s（已生效）' % (
                            fld_label, adj['effective'], adj['old'], adj['new'])
            out.append({
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
            })
    return out


def parse_kimi():
    """Kimi(Moonshot) 官方价：各模型单独的 mintlify 文档页(.md 源，比 HTML 干净)。
    v0.3(2026-09-28)：moonshot.cn 文档已 301 迁至 platform.kimi.com（requests 自动跟随，
    但直接用新域免去一跳）；chat-k25 / chat-v1 实测已是死页（0 行），剔除；
    3 个有效页返回同一张表（k3/k2.7-code/k2.7-code-highspeed/k2.6），留 1 页即可。
    表格行形如：
      ["kimi-k3","1M tokens","¥20.00","¥40.00","¥2.00","¥20.00","¥100.00","1,048,576 tokens"]
      ["kimi-k2.7-code","1M tokens","¥1.30","¥6.50","¥27.00","262,144 tokens"]
    价格语义 = [缓存命中, 输入(未命中), 输出]；k3 行多出历史列（共 5 个价）→ 统一取末 3 位，
    实测 k3 末 3 位 = 2.00/20.00/100.00，与 pricing.json 用户已校对 lock 价完全一致。
    """
    out = []
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
            m = re.match(r'\["([^"]+)",\s*"([\d.,]+[MK])\s*tokens",\s*(.*?),\s*"([\d,]+) tokens"\]', line)
            if not m:
                continue
            # v3.59.0（审计 S5）：单位显式断言。原正则把 "1M tokens" 写死成字面量 →
            #   页面改用「1K tokens」计价时整行不匹配 → 静默 0 模型（连 WARN 都没有）。
            #   现放宽量纲匹配再显式校验：非 1M tokens 计价 → WARN + 跳过（可见的失败）。
            if m.group(2).upper() != '1M':
                print('[WARN] kimi %s: 计价单位非 1M tokens（%s tokens）→ 跳过该行'
                      % (pg, m.group(2)))
                continue
            name = m.group(1)
            # v3.52.0（S4）：同其余解析器 —— 只丢真快照，soft 收录 + 待确认留痕
            if not apply_snap_verdict(name):
                continue
            prices = re.findall(r'"¥([\d.]+)"', m.group(2))
            if len(prices) >= 3:
                cache, inp, outp = prices[-3:]  # k3 行多历史列 → 取末 3 位
            elif len(prices) == 2:
                cache, inp, outp = None, prices[0], prices[1]
            else:
                continue
            out.append({
                'name': name,
                'brand': 'kimi',
                'api_name': name,
                'source_type': 'first_party',
                'unit': '元/百万 tokens',  # v3.59.0（S5）：行首 "1M tokens" 单位断言通过后显式回传
                'in_price': ['%s元' % inp],
                'out_price': ['%s元' % outp],
                'cache_hit': ['%s元' % cache] if cache else [],
                'tier_note': 'Kimi 官方价(¥/1M tokens)',
                'source': 'Kimi 官方文档 %s.md' % pg,
            })
    seen, uniq = set(), []
    for m in out:
        if m['api_name'] in seen:
            continue
        seen.add(m['api_name'])
        uniq.append(m)
    return uniq


def parse_pricing_deepseek():
    """DeepSeek 官方价由用户已在 pricing.json 校对（lock），不再重复抓取网页。
    直接读 pricing.json 的 deepseek-* 条目作为库的 DeepSeek first_party 源。"""
    if not os.path.exists(PRICING_PATH):
        print('[WARN] 未找到 pricing.json: %s' % PRICING_PATH)
        return []
    p = json.load(open(PRICING_PATH, encoding='utf-8'))
    out = []
    for key, v in p.get('models', {}).items():
        if not key.startswith('deepseek'):
            continue
        # v2.82.1（2026-09-01）：只合并 lock=True 的条目——本函数的语义是「用户已校对官方价」，
        # 非 lock 的兜底价（如回填的 8-23 聚合源价）混进来会被标成 first_party「用户已校对」，
        # 且官方已下线的模型（v3-1-volc）会以旧价永久冒充新鲜数据。非 lock 的 deepseek 模型
        # 仍留在 pricing.json 兜底计费（loadPricing 合并层），只是不进本地库。
        if not v.get('lock'):
            continue
        mult = v.get('peak_multiplier', 1)
        # v3.48.0（审计 F2）：原实现用**下标**读这两个字段——lock 条目缺键时 KeyError 被外层
        #   `except Exception` 吞掉 → 整个 deepseek 厂商**当轮 0 价**、摘要失真，且只留一行 stderr，
        #   看不出是"缺键"还是"网络失败"。改为显式取 + 缺键跳过该条（其余厂商/模型不受影响），
        #   并明确告警让人去补 pricing.json。
        in_p = v.get('input_price')
        out_p = v.get('output_price')
        if in_p is None or out_p is None:
            sys.stderr.write('[WARN] pricing.json lock 条目 %s 缺 input_price/output_price，已跳过该条（请手动补价）\n' % key)
            continue
        rec = {
            'name': v.get('name', key),
            'api_name': key,
            'source_type': 'first_party',
            'in_price': ['%s元' % in_p],
            'out_price': ['%s元' % out_p],
            'cache_hit': ['%s元' % v.get('cached_price', 0)],
            'tier_note': v.get('tier_note', 'pricing.json 用户已校对官方价'),
            'source': 'pricing.json(用户已校对官方价)',
        }
        # 峰谷：高峰价 = 基础价 × peak_multiplier（DeepSeek 原厂系）
        # v3.48.0（审计 F2）：这里原来也是下标访问（与上面 in_p/out_p 同源）——能走到这里说明
        #   in_p/out_p 都已取到，直接复用即可，别再碰一遍原始字典。
        if mult and mult != 1:
            rec['peak'] = {
                'idle': {'in': in_p, 'out': out_p,
                         'cache': v.get('cached_price', 0)},
                'peak': {'in': in_p * mult, 'out': out_p * mult,
                         'cache': v.get('cached_price', 0) * mult},
            }
        out.append(rec)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    result = {
        'fetched_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'currency': 'CNY',
        'unit': '元/百万 tokens',
        'region': 'CN',
        'source_type': 'vendor-official-page',
        'vendors': {},
    }
    total = 0
    for key, cfg in VENDORS.items():
        entry = {'name': cfg['name'], 'url': cfg['url'], 'mode': cfg['mode'],
                 'status': 'ok', 'models': [], 'error': None}
        try:
            if cfg['mode'] == 'pricing':
                # 不从网页抓，直接读用户已校对的 pricing.json
                entry['models'] = parse_pricing_deepseek()
            else:
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
    failed = {}
    for key, entry in result['vendors'].items():
        if entry['status'] != 'ok':
            failed[key] = entry.get('error') or '未知错误'
        elif not entry['models']:
            failed[key] = '解析出 0 个模型（官网改版/schema 变更?）'
    ok_keys = [k for k in result['vendors'] if k not in failed]

    result['model_count'] = total
    # 供下游消费的失败摘要（本脚本 stdout 无 JSON 契约，此字段落在 cn-prices-*.json / latest.json）。
    # ⚠需下游配合读取：目前 build_index.py 只读 result['vendors']，本字段为增量信息、向后兼容（不破坏解析）。
    result['_fetch_summary'] = {
        'vendors_total': len(result['vendors']),
        'vendors_ok': len(ok_keys),
        'vendors_failed': len(failed),
        'models_total': total,
        'ok': ok_keys,
        'failed': failed,
        # v3.52.0（审计批2·L1/L4）：0 模型厂商的结构指纹（区分「网络失败」vs「官网改版」）；
        #   S4 待确认清单（soft 快照样式被收录的型号，供人工确认是否为真型号）。
        'fingerprints': {k: v.get('fingerprint') for k, v in result['vendors'].items()
                         if k in failed and v.get('fingerprint')},
        'pending_confirm': sorted(set(PENDING_CONFIRM)),
        'note': 'failed 非空表示当日这些厂商源未产出数据，价格可能沿用上版；需下游配合读取',
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
    stamp = datetime.datetime.now().strftime('%Y-%m-%d')
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
