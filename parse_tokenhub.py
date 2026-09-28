"""解析腾讯云大模型服务平台 TokenHub「模型价格」文档页。
源：https://cloud.tencent.com/document/product/1823/130055
该页服务端渲染 + gzip，requests 可直接抓取（无需浏览器）。

产出：广州地域「在线推理-语言模型」价表的结构化记录，含：
  - 模型名 / 归一化 api 名 / 品牌 / 是否原厂直供(自营 or 转售)
  - 分档 tiers：type=peak(峰谷:空闲/高峰) 或 length(输入长度分档) 或 base
  - 每档 输入/输出/缓存命中 单价（元/百万 tokens）
"""
import re, json, requests

URL = 'https://cloud.tencent.com/document/product/1823/130055'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

# 模型名 -> (品牌, 归一化 api 名)
# 注：Hy-MT2 系是语音/机器翻译模型，不按 LLM token 库保存（用户 2026-08-31 决定），只留 LLM 模型
BRAND_MAP = {
    'Hy4 preview': ('hunyuan', 'hy4-preview'),
    'Hy3': ('hunyuan', 'hy3'),
    'Hy3 preview': ('hunyuan', 'hy3-preview'),
    'Hy-Role-Latest': ('hunyuan', 'hy-role-latest'),
    'Hy-Role': ('hunyuan', 'hy-role'),
    'DeepSeek-V4-Flash 0731 正式版': ('deepseek', 'deepseek-v4-flash'),
    'DeepSeek-V4-Pro 0813 正式版': ('deepseek', 'deepseek-v4-pro'),
    'DeepSeek-V4-Flash-Vision-Exp': ('deepseek', 'deepseek-v4-flash-vision-exp'),
    'DeepSeek-V4-Flash': ('deepseek', 'deepseek-v4-flash'),
    'DeepSeek-V4-Pro': ('deepseek', 'deepseek-v4-pro'),
    'GLM-5.3': ('zhipu', 'glm-5.3'),
    'GLM-5.3-Flash': ('zhipu', 'glm-5.3-flash'),
    'GLM-5.2': ('zhipu', 'glm-5.2'),
    'GLM-5.1': ('zhipu', 'glm-5.1'),
    'GLM-5V-Turbo': ('zhipu', 'glm-5v-turbo'),
    'GLM-5-Turbo': ('zhipu', 'glm-5-turbo'),
    'GLM-5': ('zhipu', 'glm-5'),
    'Kimi K3': ('kimi', 'kimi-k3'),
    'Kimi K2.7 Code HighSpeed': ('kimi', 'kimi-k2.7-code-highspeed'),
    'Kimi K2.7 Code': ('kimi', 'kimi-k2.7-code'),
    'Kimi-K2.6': ('kimi', 'kimi-k2.6'),
    'Kimi-K2.5': ('kimi', 'kimi-k2.5'),
    'MiniMax-M3': ('minimax', 'minimax-m3'),
    'MiniMax-M2.7': ('minimax', 'minimax-m2.7'),
    'Qwen3.5-Flash': ('qwen', 'qwen3.5-flash'),
    'Qwen3.5-Plus': ('qwen', 'qwen3.5-plus'),
    'MiMo-V2.5-Pro': ('minimax', 'mimo-v2.5-pro'),
}


def fetch():
    return requests.get(URL, headers={'User-Agent': UA}, timeout=30).text


def cells_of_row(seg):
    """一个 <tr> 片段 -> 各 <td>/<th> 的文本（多行合并为一格）"""
    out = []
    for cell in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', seg, re.S):
        texts = re.findall(r'data-slate-string="true">([^<]*)</span>', cell)
        out.append(' '.join(t.strip() for t in texts).strip())
    return out


def rows_of_block(block):
    rows = []
    for seg in re.split(r'<tr', block):
        cells = cells_of_row(seg)
        if cells:
            rows.append(cells)
    return rows


def _num(s):
    s = (s or '').strip()
    if s in ('-', '', '—'):
        return None
    m = re.match(r'^\d+(\.\d+)?$', s)
    return float(s) if m else None


def parse_lang_table(block):
    """解析广州语言模型价表（含峰谷/分档）。返回模型列表。"""
    rows = rows_of_block(block)
    # 表头：定位各列索引
    hidx = None
    for i, r in enumerate(rows):
        if any('模型名称' in c for c in r) and any('推理输入' in c for c in r):
            hidx = i
            break
    if hidx is None:
        return []
    hdr = rows[hidx]
    def col(keywords):
        for j, c in enumerate(hdr):
            if any(k in c for k in keywords):
                return j
        return None
    i_name = col(['模型名称'])
    i_cond = col(['条件', 'token'])
    i_peak = col(['峰谷'])
    i_in = col(['推理输入'])
    i_out = col(['推理输出'])
    i_cache = col(['缓存命中'])
    if None in (i_name, i_in, i_out):
        return []

    def get(r, idx):
        return r[idx] if idx is not None and idx < len(r) else ''

    models = []
    cur = None
    for r in rows[hidx + 1:]:
        if len(r) < 3:
            continue
        raw_name = get(r, i_name).strip()
        cond = get(r, i_cond)
        peak = get(r, i_peak)
        pin = _num(get(r, i_in))
        pout = _num(get(r, i_out))
        pcache = _num(get(r, i_cache))
        # 归一化名字：去“原厂直供”、去“（...下线）”
        base = raw_name.replace('原厂直供', '').strip()
        base = re.sub(r'\s*（[^）]*下线[^）]*）', '', base).strip()
        is_first = '原厂直供' in raw_name
        if base and base not in ('-', ''):
            brand, api = BRAND_MAP.get(base, (None, None))
            cur = {
                'name': base,
                'brand': brand,
                'api_name': api,
                'sku': '原厂直供' if is_first else ('腾讯标准版' if brand != 'hunyuan' else '官方'),
                'first_party': is_first or (brand == 'hunyuan'),
                'tiers': [],
            }
            models.append(cur)
        if cur is None:
            continue
        peak_v = '空闲时段' if '空闲' in peak else ('高峰时段' if '高峰' in peak else '')
        if peak_v:
            ttype, tval = 'peak', peak_v
        elif '输入长度' in cond or 'k)' in cond or 'k]' in cond or 'k+' in cond or 'k）' in cond:
            ttype, tval = 'length', cond.strip()
        else:
            ttype, tval = 'base', (cond.strip() or '-')
        cur['tiers'].append({
            'type': ttype,
            'value': tval,
            'in': pin, 'out': pout, 'cache': pcache,
        })
    return models


def parse_peak_rule(html):
    """从正文提取峰谷时段规则（结构化文本）。"""
    rules = []
    # 通用峰谷窗口（含顿号/空格，完整捕获多段如 "9:00 - 12:00、14:00 - 18:00"）
    m = re.search(r'高峰时段为北京时间\s*([0-9:：–\-、,\s]+)', html)
    if m:
        rules.append('高峰时段(北京时间): ' + m.group(1).strip('、, '))
    # 周末/工作日规则
    if '周末' in html and '空闲时段' in html:
        rules.append('自2026-08-29起：工作日(周一~周五)执行峰谷(高峰如上)，周末(周六日)全天按空闲时段计费')
    # 判定基准
    if '请求接收时间' in html:
        rules.append('时段判定以平台服务端接收请求的时间(北京时间)为准')
    return rules


def main():
    html = fetch()
    blocks = re.split(r'<table', html)[1:]
    # 候选块：含 Hy4 preview + 峰谷计费 + 推理输入
    cands = [b for b in blocks if 'Hy4 preview' in b and '峰谷计费' in b and '推理输入' in b]
    target = None
    for b in cands:
        # 排除新加坡区域（价格多位小数，如 10.07524）；广州价为整数/一位小数
        if re.search(r'\d+\.\d{3,}', b):
            continue
        target = b
        break
    if target is None and cands:
        target = cands[0]
    models = parse_lang_table(target)
    # 只保留腾讯自家(混元)模型；页面里其余是腾讯转售的第三方(智谱/Kimi/DeepSeek/MiniMax)，一律不要
    models = [m for m in models if m.get('brand') == 'hunyuan']
    peak_rule = parse_peak_rule(html)
    out = {
        'source': '腾讯云大模型服务平台 TokenHub 模型价格文档',
        'url': URL,
        'fetched_at': __import__('datetime').datetime.now().isoformat(timespec='seconds'),
        'region': '广州',
        'currency': 'CNY',
        'peak_rule': peak_rule,
        'models': models,
    }
    import os
    os.makedirs('prices', exist_ok=True)
    # v2.82：原子写（唯一 tmp + os.replace），防多会话并发时读方拿到半截 JSON
    tmp = os.path.join('prices', 'tokenhub_lang.json.tmp-%d' % os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join('prices', 'tokenhub_lang.json'))
    print('解析到模型数:', len(models), '| 峰谷规则:', len(peak_rule))
    print('已写入 prices/tokenhub_lang.json')
    return models


if __name__ == '__main__':
    main()
