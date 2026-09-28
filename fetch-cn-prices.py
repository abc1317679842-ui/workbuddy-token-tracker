#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国内厂商官方人民币价抓取器（v0.3，2026-09-28）
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
import datetime
import urllib.request
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'prices')
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
TIMEOUT = 30

# DeepSeek 官方价由用户已在 pricing.json 校对（lock），不重复抓取，
# 直接读该文件作为库的 DeepSeek first_party 源。
PRICING_PATH = os.path.join(os.path.expanduser('~'), '.workbuddy', 'skills',
                            'token-usage-tracker', 'pricing.json')

# 阿里云(通义千问)不抓本地库——计费统一走聚合源(llmabacus)人民币价；
# 其官方价分地域/阶梯/思考模式/Batch半价，本地难以精确解析，故放弃本地存储。

# 通用：丢弃历史快照版/区域版/预览别名(-2025-01-12 / -us / -latest / -preview)
# 注意：腾讯混元只走 parse_tokenhub.py，不受此规则影响(Hy4 preview 含 preview 但必须保留)
SNAP_RE = re.compile(r'-20\d\d-\d\d-\d\d|-us$|-latest$|-preview$|快照', re.I)

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
        'url': 'https://platform.stepfun.com/docs/zh/guides/pricing/details',
        'mode': 'tr',
        # 剔除语音/图像类与坏行(stepaudio·step-tts按万字符/step-asr按小时/audio列序不可靠/仅单价行)；保留 step-1o-audio(按token计价)
        'drop_re': re.compile(r'step-?tts|step-?asr|step-?audio|step-image|step-2x-large', re.I),
        # v0.3(2026-09-28)：列序修正——表头实为「输入(缓存未命中)/输入(缓存命中)/输出」，
        # 旧版按 [in,out,cache] 映射导致 out/cache 整体错位（step-3.7-flash 输出 ¥8.1 被记成 ¥0.27）
        'order': ('in', 'cache', 'out'),
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


def fetch(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    return urllib.request.urlopen(req, timeout=timeout, context=CTX).read().decode('utf-8', 'replace')


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
        if keep_over_re and keep_over_re.search(name):
            pass  # 白名单：真模型名含 -preview 等快照样式，放行
        elif SNAP_RE.search(name):
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


def parse_zhipu_docs(html):
    """智谱官方文档站定价页（v0.2，2026-09-28）——服务端渲染语义表格，无需 bundle 解析。
    列：模型名称 | 上下文 | 输入单价 | 输出单价 | 缓存存储 | 缓存命中 | 输入模态。

    v0.1 曾抓控制台页(open.bigmodel.cn/pricing 的 SPA bundle)：2026-09-28 实测该页
    「5折限时两周至09-09」活动过期 19 天仍未恢复原价(0.4/1.4)，而文档站现行价已是
    原价(0.8/2.8/0.23) → 两官方页矛盾，以文档站为准，弃用 bundle 通道。"""
    out = []
    seen = set()
    for table in re.findall(r'<table[\s\S]*?</table>', html):
        if '输入单价' not in table:
            continue
        for row in re.findall(r'<tr[^>]*>([\s\S]*?)</tr>', table):
            cells = [strip_tags(c) for c in re.findall(r'<td[^>]*>([\s\S]*?)</td>', row)]
            if len(cells) < 6:
                continue
            name = cells[0].strip()
            if not re.match(r'^GLM[-A-Za-z0-9.]*$', name):
                continue
            inp = _znum(cells[2])
            outp = _znum(cells[3])
            cache = _znum(cells[5]) if len(cells) > 5 else None
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
        header = strip_tags(rows[0])
        if '输入价格' not in header or '元/百万' not in header:
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
            t = requests.get(base + pg + '.md', headers={'User-Agent': UA}, timeout=20).text
        except Exception as e:
            print('[WARN] kimi %s: %s' % (pg, repr(e)[:80]))
            continue
        for line in t.splitlines():
            if not line.strip().startswith('['):
                continue
            m = re.match(r'\["([^"]+)",\s*"1M tokens",\s*(.*?),\s*"([\d,]+) tokens"\]', line)
            if not m:
                continue
            name = m.group(1)
            if SNAP_RE.search(name):
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
        rec = {
            'name': v.get('name', key),
            'api_name': key,
            'source_type': 'first_party',
            'in_price': ['%s元' % v['input_price']],
            'out_price': ['%s元' % v['output_price']],
            'cache_hit': ['%s元' % v.get('cached_price', 0)],
            'tier_note': v.get('tier_note', 'pricing.json 用户已校对官方价'),
            'source': 'pricing.json(用户已校对官方价)',
        }
        # 峰谷：高峰价 = 基础价 × peak_multiplier（DeepSeek 原厂系）
        if mult and mult != 1:
            rec['peak'] = {
                'idle': {'in': v['input_price'], 'out': v['output_price'],
                         'cache': v.get('cached_price', 0)},
                'peak': {'in': v['input_price'] * mult, 'out': v['output_price'] * mult,
                         'cache': v.get('cached_price', 0) * mult},
            }
        out.append(rec)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    result = {
        'fetched_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'currency': 'CNY',
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
                html = fetch(cfg['url'])
                if cfg['mode'] == 'tr':
                    entry['models'] = parse_tr(html, cfg.get('keep'), cfg.get('keep_re'), cfg.get('drop_re'), cfg.get('require_re'),
                                               cfg.get('order', ('in', 'out', 'cache')), cfg.get('keep_over_re'))
                elif cfg['mode'] == 'minimax':
                    entry['models'] = parse_minimax(html)
                elif cfg['mode'] == 'zhipu_docs':
                    entry['models'] = parse_zhipu_docs(html)
                elif cfg['mode'] == 'kimi':
                    entry['models'] = parse_kimi()
            # 补全 source 标注（解析器未设时回退到厂商名）
            for mm in entry['models']:
                mm.setdefault('source', cfg['name'])
            total += len(entry['models'])
            print('[OK]   %-22s %d 个模型' % (cfg['name'], len(entry['models'])))
        except Exception as e:
            entry['status'] = 'error'
            entry['error'] = repr(e)[:200]
            print('[FAIL] %-22s %s' % (cfg['name'], repr(e)[:80]))
        result['vendors'][key] = entry
        time.sleep(0.5)

    result['model_count'] = total
    stamp = datetime.datetime.now().strftime('%Y-%m-%d')
    path = os.path.join(OUT_DIR, 'cn-prices-%s.json' % stamp)
    # v2.82：原子写（唯一 tmp + os.replace）。多会话并发刷新时另一进程的 build_index.py
    # 可能正在读 latest.json，裸 open('w') 会写出半截 JSON，对方 json.load 直接崩。
    tmp = path + '.tmp-%d' % os.getpid()
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    latest = os.path.join(OUT_DIR, 'latest.json')
    tmp2 = latest + '.tmp-%d' % os.getpid()
    with open(tmp2, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp2, latest)
    print('\n共 %d 个模型，已写入：\n  %s\n  %s'
          % (total, path, latest))
    return 0 if total else 1


if __name__ == '__main__':
    sys.exit(main())
