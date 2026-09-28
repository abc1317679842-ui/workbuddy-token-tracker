#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国内厂商官方人民币价抓取器（v0.1，2026-08-31）

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
        'mode': 'tr',
        # 该页混有视频生成模型(按秒计费，非 token 计价)——只保留"元/百万 tokens"文本计价行
        'require_re': re.compile(r'百万\s*tokens?', re.I),
    },
    'stepfun': {
        'name': '阶跃星辰',
        'url': 'https://platform.stepfun.com/docs/zh/guides/pricing/details',
        'mode': 'tr',
        # 剔除语音/图像类与坏行(stepaudio·step-tts按万字符/step-asr按小时/audio列序不可靠/仅单价行)；保留 step-1o-audio(按token计价)
        'drop_re': re.compile(r'step-?tts|step-?asr|step-?audio|step-image|step-2x-large', re.I),
    },
    'deepseek': {
        'name': 'DeepSeek',
        'url': '(来自 pricing.json 用户已校对官方价)',
        'mode': 'pricing',
    },
    'zhipu': {
        'name': '智谱 GLM',
        'url': 'https://open.bigmodel.cn/pricing',
        'mode': 'bundle',
        'asset_base': 'https://static.bigmodel.cn/wd-paas-front',
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


def parse_tr(html, keep=None, keep_re=None, drop_re=None, require_re=None):
    """通用表格解析：逐 <tr> 提取含'元'的行。
    keep:      可选前缀元组，仅保留自家模型名（如 ('qwen',) 过滤掉转售的第三方）。
    keep_re:   可选正则，仅保留匹配的主流档位名。
    drop_re:   可选正则，命中模型名则丢弃（如阶跃剔除语音类）。
    require_re:可选正则，行文本必须命中才保留（如 MiniMax 只留"百万 tokens"计价行）。"""
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
        if SNAP_RE.search(name):
            continue
        if drop_re and drop_re.search(name):
            continue
        if keep_re and not keep_re.match(name):
            continue
        out.append({
            'name': name,
            'raw_text': text[:300],
            'prices_cny': prices,
            'context': next((t for t in tokens if re.match(r'^\d+[KkMm]$', t)), ''),
        })
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


def parse_bundle(html, cfg):
    """SPA 三步解析：骨架 -> bundle 路径 -> 结构化价格"""
    m = re.search(r'/js/app\.[a-f0-9]+\.js', html)
    if not m:
        return []
    js = fetch(cfg['asset_base'] + m.group(0))
    out = []
    idx = 0
    while True:
        k = js.find('name:"', idx)
        if k < 0:
            break
        seg = js[k:k + 700]
        nm = seg[6:seg.find('"', 6)]
        # 只收 GLM 系（该 bundle 里还有其他文案段落）
        if nm.startswith('GLM') and not SNAP_RE.search(nm):
            def grab(field):
                mm = re.search(field + r':\[([^\]]*)\]', seg)
                if not mm:
                    return []
                return re.findall(r'"([^"]*)"', mm.group(1))
            out.append({
                'name': nm,
                'in_price': grab('inPrice'),
                'out_price': grab('outPrice'),
                'cache_hit': grab('hit'),
                'cache_storage': (re.search(r'storage:"([^"]*)"', seg) or [None, ''])[1],
                'context': (grab('upDownText') or [''])[0],
                'tier_note': (re.search(r'intro:"([^"]*)"', seg) or [None, ''])[1],
                'source': '智谱 GLM 官方定价页(open.bigmodel.cn/pricing)',
            })
        idx = k + 10
    seen, uniq = set(), []
    for m in out:
        if m['name'] in seen:
            continue
        seen.add(m['name'])
        uniq.append(m)
    return uniq


KIMI_PAGES = ['chat-k3', 'chat-k27-code', 'chat-k26', 'chat-k25', 'chat-v1']


def parse_kimi():
    """Kimi(Moonshot) 官方价：各模型单独的 mintlify 文档页(.md 源，比 HTML 干净)。
    表格行形如：
      ["kimi-k3","1M tokens","¥2.00","¥20.00","¥100.00","1,048,576 tokens"]
      → 缓存命中/输入(未命中)/输出 = 2.00 / 20.00 / 100.00（¥/1M）
    旧版(如 moonshot-v1)无缓存列：["moonshot-v1-8k","1M tokens","¥2.00","¥10.00","8,192 tokens"]
    """
    out = []
    base = 'https://platform.moonshot.cn/docs/pricing/'
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
            if len(prices) == 3:
                cache, inp, outp = prices
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
                    entry['models'] = parse_tr(html, cfg.get('keep'), cfg.get('keep_re'), cfg.get('drop_re'), cfg.get('require_re'))
                elif cfg['mode'] == 'bundle':
                    entry['models'] = parse_bundle(html, cfg)
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
