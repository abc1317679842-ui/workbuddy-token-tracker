#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 prices/latest.json 合并成去重索引 prices/index.json。

冲突解决（核心规则，优先级从高到低）：
1. **pricing.json 中 lock=True 的官方价 = 用户已校对，最高权威**，直接覆盖同名抓取价。
   （这是兜底安全网：即便下方抓取逻辑判错，你校对过的价也不会被冲掉。）
2. 抓取价内部：
   - first_party = 模型自家厂商官方页（aliyun 的 qwen、zhipu 的 glm、minimax 的 minimax、
     stepfun 的 step、tencent 的混元 Hy3、deepseek 自家）。
   - channel / reseller = 模型广场或云厂商转售的第三方模型（aliyun 上挂的 deepseek/glm、
     腾讯 TokenPlan 转售的 Kimi/GLM/DeepSeek/MiniMax）。
   - 合并时 first_party > channel/reseller；仅当没有 first_party 才用 channel 并标注。

价格口径：取数组第一项（折后/低档/空闲时段），与 pricing.json 一致；分档/折扣留 tier_note。
"""
import datetime
import json
import os
import re
import sys
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
# v3.52.0（审计批2·S1）：价库目录可用 CN_PRICES_DIR 显式指定（同另两个流水线脚本）。
#   原实现恒读写 HERE/prices，而调用方（token-tracker.js）读的是自动发现的 CN_PRICE_DIR ——
#   两者不同 → 流水线跑完 index.json 落在技能目录、调用方那份永远停在旧日期（价库静默失效）。
PRICES_DIR = os.environ.get('CN_PRICES_DIR') or os.path.join(HERE, 'prices')
LATEST = os.path.join(PRICES_DIR, 'latest.json')


def detect_workbuddy_root():
    """v0.5（2026-10-02）：WorkBuddy 数据根探测，与 Node 侧 detectWorkBuddyRoot
    （token-tracker.js:239-249 / refresh-prices.js:40-50）**逐字等价**。背景：新版客户端可能把数据根
    迁到 ~/.workbuddy-ai，若此处写死 ~/.workbuddy，本脚本的 PRICING 会指向错误路径 —— 而下方
    `if os.path.exists(PRICING)` 为假时会**整段跳过** pricing.json(lock) 权威覆盖层（既不覆盖也不
    注入），用户已校对的官方价与 Hy4 等 SPA 模型会静默从索引里消失，且无任何报错。
    语义（与 Node 完全一致，勿自作聪明「更稳」——两端必须算出同一个根）：
      ① WB_ROOT 环境变量**非空即用**（空串等同未设置；不校验目录是否存在，对应 Node 的 `||`）；
      ② 否则在 [~/.workbuddy-ai, ~/.workbuddy] 中取第一个含 traces/ 或 settings.json 签名者；
      ③ 都不命中 → 兜底 ~/.workbuddy（对应 Node 末尾的 return）。
    ⚠️ 本函数需与 fetch-cn-prices.py 中的同名实现保持一致，且必须与 token-tracker.js:239-249 等价
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


WB_ROOT = detect_workbuddy_root()
PRICING = os.path.join(WB_ROOT, 'skills', 'token-usage-tracker', 'pricing.json')
OUT = os.path.join(PRICES_DIR, 'index.json')
TOKENHUB = os.path.join(PRICES_DIR, 'tokenhub_lang.json')

# v2.82（2026-09-01）：「逐模型沿用」的保留天数上限。
# 上一版有、本次抓取缺失的模型会沿用旧价（防官网改版/软404导致价格凭空消失、按 0 元计）；
# 连续缺失超过此天数则判定模型已真下架，自动淘汰，避免僵尸条目永久占位。
CARRY_MAX_DAYS = 7

# ── v3.53.0（审计批3·L3 变更分级 / L4 人工缝前置闸门 / 审计流水）─────────────────────
# 背景：index.json 每日**整份重建**，却没有任何「今天到底变了什么」的记录。三类事故无从发现：
#   ① 厂商调价 → 金额突变，只能靠人肉记忆对比；
#   ② 解析把「元/千 tokens」当「元/百万 tokens」→ 价格差 1000 倍，索引里长得完全正常；
#   ③ 官方页改版/下架 → 条目被转售价顶替（first_party → channel 降级），静默发生。
# 分级口径（用户定调）：**值变=自动，语义变=人工**。
#   - 值变（in/out/cache 数字变了）→ 自动采纳（可能就是真调价），只留痕；
#   - 语义变（unit / currency 变了）→ 计价基准变了，采用会让金额差一个数量级
#     → **保留上一版价格 + `_manual_audit` 挂起**，等人确认（fail-closed 优于猜错）。
CHANGE_FILE = os.path.join(PRICES_DIR, 'changes.jsonl')
CHANGE_ROLL_TO = os.path.join(PRICES_DIR, 'changes.1.jsonl')
CHANGE_ROLL_MAX = 2 * 1024 * 1024  # 滚动阈值：超阈值先转存 .1，防审计流水无限增长

CONTRACT_MIN = ('currency', 'unit')          # 所有条目（含沿用）的底线（v3.51.0 契约海关）
CONTRACT_FULL = ('currency', 'unit', 'region', 'source_url', 'fetched_at')
#   ↑ 新条目必须齐全：新模型没有完整溯源 = 事后无法人工核验「这价从哪来、什么单位、哪个区」。
PRICE_MIN, PRICE_MAX = 0.0005, 5000.0        # 元/百万 tokens，与 fetch-cn-prices 的 priceGate 同口径
SEMANTIC_GUARDED = ('unit', 'currency')      # 这两个字段变了 = 计价基准变了
BIG_JUMP = 5.0                               # 价格跳变阈值：>5× 或 <1/5 → 采纳但仍 WARN

# aliyun 上挂的非阿里品牌 → 降为 channel（模型广场转售）
FOREIGN_IN_ALIYUN = ('deepseek', 'glm', 'kimi', 'minimax', 'hunyuan', 'step-',
                     'yi-', 'ernie', 'qianfan', 'llama', 'claude', 'gpt',
                     'doubao', 'seed-', 'abab', 'moonshot')


def norm(s):
    return re.sub(r'[\s_\-.]', '', (s or '').lower())


def to_float(arr):
    if not arr:
        return None
    if isinstance(arr, (list, tuple)):
        s = arr[0] if arr else ''
    else:
        s = arr
    m = re.search(r'(\d+(?:\.\d+)?)', str(s))
    return float(m.group(1)) if m else None


def in_out_cache(m):
    """兼容两种格式：结构化 in_price/out_price/cache_hit，或扁平 prices_cny=[in,out(,cache)]。"""
    if 'in_price' in m:
        return (to_float(m.get('in_price')), to_float(m.get('out_price')),
                to_float(m.get('cache_hit')))
    pc = m.get('prices_cny') or []
    inp = to_float([pc[0]]) if len(pc) >= 1 else None
    outp = to_float([pc[1]]) if len(pc) >= 2 else None
    cache = to_float([pc[2]]) if len(pc) >= 3 else None
    return inp, outp, cache


def src_type(vk, m):
    """判定来源性质"""
    if vk == 'tencent':
        return m.get('source_type') or 'reseller'  # parse_tencent 已标 Hy3=first_party
    if vk == 'aliyun':
        nm = (m.get('api_name') or m.get('name') or '').lower()
        if any(b in nm for b in FOREIGN_IN_ALIYUN):
            return 'channel'
        return 'first_party'
    return 'first_party'  # zhipu/minimax/stepfun/deepseek 均为自家官方页


# ===== v3.53.0：变更分级 / 新条目闸门 / 审计流水 =====
def price_values(e):
    """参与闸门校验的价格（只认数字；None 表示官方未列，不算越界）。"""
    return [e.get(f) for f in ('in_price', 'out_price') if isinstance(e.get(f), (int, float))]


def gate_new_model(e, full):
    """新条目闸门：返回 (ok, reason)。

    full=False（**首次构建**或上一版索引不可读）时只校验最小契约 + 价格区间：
    此时若按 CONTRACT_FULL 卡，任何字段不齐都会让整份索引变空 —— 闸门是保险，
    不能反过来变成数据灾难。有上一版可对比时才启用完整溯源要求。
    lock（authoritative）条目是用户已校对的价，闸门不干预。
    """
    if e.get('authoritative'):
        return True, ''
    need = CONTRACT_FULL if full else CONTRACT_MIN
    miss = [f for f in need if not e.get(f)]
    if miss:
        return False, '契约不全（缺 %s）' % ','.join(miss)
    vals = price_values(e)
    if not vals:
        return False, '无可校验价格'
    for v in vals:
        if not (PRICE_MIN <= v <= PRICE_MAX):
            return False, '价格越界（%s，合法区间 %.4f~%s %s）' % (v, PRICE_MIN, PRICE_MAX, '元/百万 tokens')
    return True, ''


def classify_change(pe, ne):
    """对比上一版条目 pe 与本次条目 ne，返回 (kinds:list[str], detail:dict)。

    ⚠️ 只在**两边都有值且不同**时才判变化 —— 上一版缺字段（老索引）而本版补上是「补全」，
       不是变化；判成 semantic 会保留旧价，等于把新解析结果整体作废。
    """
    kinds = []
    detail = {}
    for f in SEMANTIC_GUARDED:
        po, pn = pe.get(f), ne.get(f)
        if po and pn and po != pn:
            kinds.append('semantic')
            detail.setdefault('semantic', {})[f] = {'old': po, 'new': pn}
    po, pn = pe.get('region'), ne.get('region')
    if po and pn and po != pn:
        kinds.append('region')
        detail['region'] = {'old': po, 'new': pn}
    for f in ('in_price', 'out_price', 'cache_hit'):
        o, n = pe.get(f), ne.get(f)
        if o != n:
            kinds.append('price')
            detail.setdefault('price', {})[f] = {'old': o, 'new': n}
    # 跳变：值变自动采纳（可能就是真调价），但 >5×/÷5 多半是单位或列取错 → 让人看一眼
    for f, d in (detail.get('price') or {}).items():
        o, n = d['old'], d['new']
        if isinstance(o, (int, float)) and isinstance(n, (int, float)) and o > 0:
            r = n / o
            if r >= BIG_JUMP or r <= 1.0 / BIG_JUMP:
                kinds.append('big_jump')
                detail.setdefault('jump', {})[f] = round(r, 2)
    to, tn = pe.get('primary_source_type'), ne.get('primary_source_type')
    if to and tn and to != tn:
        kinds.append('source_downgrade' if to == 'first_party' else 'source_upgrade')
        detail['source'] = {'old': to, 'new': tn}
    return sorted(set(kinds)), detail


def append_changes(records):
    """审计流水 append-only（滚动上限内）。写失败只 WARN —— 审计是留痕，不能阻断索引产出。"""
    if not records:
        return 0
    try:
        if os.path.exists(CHANGE_FILE) and os.path.getsize(CHANGE_FILE) > CHANGE_ROLL_MAX:
            shutil.copyfile(CHANGE_FILE, CHANGE_ROLL_TO)
            os.remove(CHANGE_FILE)
    except Exception as e:
        sys.stderr.write('[build_index][WARN] changes.jsonl 滚动失败（%r）；继续追加，文件可能超限\n' % (e,))
    n = 0
    try:
        with open(CHANGE_FILE, 'a', encoding='utf-8') as f:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
                n += 1
    except Exception as e:
        sys.stderr.write('[build_index][WARN] changes.jsonl 写入失败（%r）；本次无审计流水，索引照常产出\n' % (e,))
        return 0
    return n


def main():
    # v3.51.0（审计批1·C）：latest.json 缺失/损坏不再裸崩。原实现 json.load 直接抛异常 →
    #   build_index 非零退出、index.json 停留在上一版（表面无事，实则今日抓取数据全丢且无告警）。
    #   改为 WARN + 按「今日无抓取数据」处理：下方逐模型沿用逻辑整体继承上一版索引
    #   （missing_since 计时，连续 >CARRY_MAX_DAYS 天才淘汰），与「厂商抓取失败」同路径。
    try:
        d = json.load(open(LATEST, encoding='utf-8'))
    except Exception as e:
        sys.stderr.write('[build_index][WARN] latest.json 缺失或损坏（%r）；本次无抓取数据，全部模型沿用上一版索引\n' % (e,))
        d = {'vendors': {}}
    # v3.53.0（审计批3）：上一版索引**提前读取** —— 新条目闸门与变更分级都以它为基线
    #   （原先只在「逐模型沿用」段读，闸门/分级拿不到基线就无法判断什么是「新」）。
    prev = None
    try:
        prev = json.load(open(OUT, encoding='utf-8'))
    except Exception:
        prev = None
    prev_models = (prev or {}).get('models') or {}
    # gate_mode：有上一版可对比 → 新条目必须带完整溯源；首次构建 → 只卡最小契约（防整库清空）
    gate_full = bool(prev_models)
    groups = {}
    # v3.51.0（审计批1·B/C）：被跳过的条目不再静默 continue —— 统一收集，结尾 WARN 列出。
    #   静默跳过的后果：官网改版/契约缺失时模型从索引悄悄消失，用户按未收录计费而无任何提示。
    skipped = []
    for vk, v in d['vendors'].items():
        for m in v.get('models', []):
            key = norm(m.get('api_name') or m.get('name'))
            if not key:
                skipped.append(('%s/?' % vk, '无模型名'))
                continue
            inp, outp, cache = in_out_cache(m)
            if inp is None and outp is None and cache is None:
                skipped.append(('%s/%s' % (vk, key), '无价格'))
                continue
            # v3.51.0（审计批1·B）：契约海关 —— 缺 currency/unit 的条目拒收。
            #   理由：不可验证币种/单位的价格不许入账（猜错币种 = 金额差一个数量级）。
            miss = [f for f in ('currency', 'unit') if not m.get(f)]
            if miss:
                skipped.append(('%s/%s' % (vk, key), '契约字段缺失: %s' % ','.join(miss)))
                continue
            st = src_type(vk, m)
            groups.setdefault(key, []).append({
                'vendor': vk,
                'name': m.get('name'),
                'api_name': m.get('api_name'),
                'source_type': st,
                'in': inp, 'out': outp, 'cache': cache,
                'tier_note': m.get('tier_note', ''),
                'source': m.get('source', vk),
                'currency': m.get('currency'),
                'unit': m.get('unit'),
                'region': m.get('region'),
                'source_url': m.get('source_url'),
                'fetched_at': m.get('fetched_at'),
            })

    # 摄入腾讯云 TokenHub 文档（含峰谷分档 / 原厂直供 / 输入长度分档）
    # v3.19.2（B4）：不再汇总顶层 peak_rules。原实现把 TokenHub 的 peak_rule 自由文本
    #   （+ 一条 DeepSeek 规则串）写进 index.json，但技能侧从未读取（峰谷判定只认
    #   pricing.deepseek_rules），且自由文本无法机器解析 → 删掉这半截链路，别让
    #   "看起来支持各厂商峰谷" 的空字段误导后人。
    if os.path.exists(TOKENHUB):
        th = json.load(open(TOKENHUB, encoding='utf-8'))
        # v3.51.0（审计批1·A）：地域从 tokenhub_lang.json 的解析结果读，不再硬编码「广州」——
        #   硬编码会让「解析器选错面板」与「正确数据」在索引里长得一模一样，无从审计。
        th_region = th.get('region') or '未知地域'
        for m in th.get('models', []):
            key = norm(m.get('api_name') or m.get('name'))
            if not key:
                skipped.append(('tokenhub/?', '无模型名'))
                continue
            # 基线价：优先“空闲时段”峰谷档；否则 base / 首个长度分档
            idle = peak = None
            for t in m['tiers']:
                if t['type'] == 'peak' and t['value'] == '空闲时段':
                    idle = t
                elif t['type'] == 'peak' and t['value'] == '高峰时段':
                    peak = t
            base_t = idle or next((t for t in m['tiers'] if t['type'] == 'base'), None) \
                    or (m['tiers'][0] if m['tiers'] else None)
            if base_t is None:
                skipped.append(('tokenhub/%s' % key, '无价格档位'))
                continue
            inp = base_t['in']
            outp = base_t['out']
            cache = base_t['cache']
            if inp is None and outp is None and cache is None:
                skipped.append(('tokenhub/%s' % key, '无价格'))
                continue
            # v3.51.0（审计批1·B）：契约海关（同 latest.json 路径）
            miss = [f for f in ('currency', 'unit') if not m.get(f)]
            if miss:
                skipped.append(('tokenhub/%s' % key, '契约字段缺失: %s' % ','.join(miss)))
                continue
            st = 'first_party' if m.get('first_party') else 'channel'
            cand = {
                'vendor': 'tencent_tokenhub',
                'name': m.get('name'),
                'api_name': m.get('api_name'),
                'source_type': st,
                'in': inp, 'out': outp, 'cache': cache,
                'tier_note': ('峰谷计费' if (idle or peak) else '') +
                             ('；输入长度分档' if any(t['type'] == 'length' for t in m['tiers']) else ''),
                'source': '腾讯云TokenHub文档(' + th_region + ',' + (m.get('sku') or '') + ')',
                'currency': m.get('currency'),
                'unit': m.get('unit'),
                'region': m.get('region'),
                'source_url': m.get('source_url'),
                'fetched_at': m.get('fetched_at'),
                'sku': m.get('sku'),
            }
            if idle or peak:
                cand['peak'] = {
                    'idle': {'in': idle['in'], 'out': idle['out'], 'cache': idle['cache']} if idle else None,
                    'peak': {'in': peak['in'], 'out': peak['out'], 'cache': peak['cache']} if peak else None,
                }
            groups.setdefault(key, []).append(cand)

    # 合并：first_party 优先
    merged = {}
    conflicts = 0
    for key, cands in groups.items():
        fps = [c for c in cands if c['source_type'] == 'first_party']
        others = [c for c in cands if c['source_type'] != 'first_party']
        primary = (fps or others)[0]
        if fps:
            primary = fps[0]
            conflicts += 1 if others else 0
        elif others:
            conflicts += 1
        entry = {
            'name': primary['name'],
            'api_name': primary['api_name'],
            'in_price': primary['in'],
            'out_price': primary['out'],
            'cache_hit': primary['cache'],
            'primary_source': primary['source'],
            'primary_source_type': primary['source_type'],
            'tier_note': primary['tier_note'],
            'all_sources': cands,
        }
        # v3.51.0（审计批1·B）：契约字段随主候选落进索引。下游 mergeLocalPriceDb
        #   （token-tracker.js:2544-2571）按固定字段白名单读取，未知字段直接忽略 →
        #   对计费侧零影响；这些字段供契约海关校验与人工审计消费。
        for f in ('currency', 'unit', 'region', 'source_url', 'fetched_at'):
            if primary.get(f):
                entry[f] = primary[f]
        # 携带峰谷价格：优先主候选；主候选无 peak 时从同组 first_party 候选里补
        peak_src = primary
        if not primary.get('peak'):
            fp_with_peak = [c for c in cands if c.get('peak') and c['source_type'] == 'first_party']
            if fp_with_peak:
                peak_src = fp_with_peak[0]
            elif any(c.get('peak') for c in cands):
                peak_src = next(c for c in cands if c.get('peak'))
        if peak_src.get('peak'):
            entry['peak'] = peak_src['peak']
        if primary.get('sku'):
            entry['sku'] = primary['sku']
        merged[key] = entry

    # 覆盖层：pricing.json 中 lock=True 的官方价 = 最高权威
    # 若该项未被任何抓取源覆盖（如官方页是 SPA 抓不到的 Hy4），也作为 first_party 权威项注入
    overlay = 0
    injected = 0
    if os.path.exists(PRICING):
        p = json.load(open(PRICING, encoding='utf-8'))
        # v3.51.0（审计批1·B）：pricing.json 文件级 currency/unit 传播到 lock 覆盖/注入条目
        #   （lock 条目是用户已校对官方价，同样必须带契约字段，否则索引里两类条目口径不一）
        p_currency = p.get('currency') or 'CNY'
        p_unit = p.get('unit') or '元/百万 tokens'
        # v3.19.2（B4）：原先此处把 DeepSeek 峰谷规则串并入顶层 peak_rules，已随该字段一并删除
        for key, v in p.get('models', {}).items():
            if not v.get('lock'):
                continue
            k = norm(key)
            # 峰谷：peak_multiplier 表示高峰价倍数（DeepSeek 原厂系）
            peak = None
            if v.get('peak_multiplier') and v['peak_multiplier'] != 1:
                mult = v['peak_multiplier']
                peak = {
                    'idle': {'in': v.get('input_price'), 'out': v.get('output_price'),
                             'cache': v.get('cached_price', 0)},
                    'peak': {'in': v.get('input_price') * mult,
                             'out': v.get('output_price') * mult,
                             'cache': v.get('cached_price', 0) * mult},
                }
            contract = {'currency': p_currency, 'unit': p_unit, 'region': v.get('region') or 'CN'}
            if k in merged:
                upd = {
                    'in_price': v.get('input_price'),
                    'out_price': v.get('output_price'),
                    'cache_hit': v.get('cached_price'),
                    'primary_source': 'pricing.json(用户已校对官方价,lock)',
                    'primary_source_type': 'first_party',
                    'tier_note': v.get('tier_note', merged[k].get('tier_note', '')),
                    'authoritative': True,
                }
                upd.update(contract)
                if peak:
                    upd['peak'] = peak
                merged[k].update(upd)
                overlay += 1
            else:
                # 未被抓取覆盖（如 Hy4 官方研究页是 SPA）→ 直接注入为官方权威项
                rec = {
                    'name': v.get('name', key),
                    'api_name': key,
                    'in_price': v.get('input_price'),
                    'out_price': v.get('output_price'),
                    'cache_hit': v.get('cached_price'),
                    'primary_source': v.get('price_source', 'pricing.json(用户已校对官方价,lock)'),
                    'primary_source_type': 'first_party',
                    'tier_note': v.get('tier_note', ''),
                    'authoritative': True,
                    'all_sources': [{
                        'name': v.get('name', key),
                        'in': v.get('input_price'),
                        'out': v.get('output_price'),
                        'cache': v.get('cached_price'),
                        'source': v.get('price_source', 'pricing.json(lock)'),
                        'source_type': 'first_party',
                    }],
                }
                rec.update(contract)
                if peak:
                    rec['peak'] = peak
                merged[k] = rec
                injected += 1
                overlay += 1

    # ── v3.53.0（审计批3）：新条目闸门 + 变更分级 ──────────────────────────────
    #   ① 闸门：上一版没有的条目，契约不全 / 价格越界 → 拒收（不进索引）+ 审计留痕。
    #      拒收的代价是「按未收录计价」，仍优于「收一个差 1000 倍的价并按它记账」。
    #   ② 安全阀：闸门若把整库清空而上一版非空 → 整体回退上一版（fail-closed 到已知好状态）。
    #   ③ 分级：与上一版逐条对比，值变自动采纳并留痕；语义变（unit/currency）保留旧价挂起。
    changes = []
    today_iso0 = datetime.date.today().isoformat()
    rejected = []
    for key in list(merged.keys()):
        e = merged[key]
        pe = prev_models.get(key)
        if pe is None:
            ok, why = gate_new_model(e, gate_full)
            if not ok:
                rejected.append((key, why))
                changes.append({'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                                'built_at': today_iso0, 'model': key, 'kind': 'rejected',
                                'reason': why, 'values': {f: e.get(f) for f in
                                                          ('in_price', 'out_price', 'cache_hit', 'unit', 'currency')}})
                del merged[key]
                continue
            changes.append({'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                            'built_at': today_iso0, 'model': key, 'kind': 'new',
                            'values': {f: e.get(f) for f in ('in_price', 'out_price', 'cache_hit')},
                            'source': e.get('primary_source')})
            continue
        kinds, detail = classify_change(pe, e)
        if 'semantic' in kinds:
            # 语义变 = 计价基准变了 → 保留上一版价格与单位，本次新值挂 _manual_audit 供人工对照
            new_vals = {f: e.get(f) for f in ('in_price', 'out_price', 'cache_hit')}
            for f in ('in_price', 'out_price', 'cache_hit'):
                if pe.get(f) is not None:
                    e[f] = pe[f]
            for f in SEMANTIC_GUARDED:
                if pe.get(f):
                    e[f] = pe[f]
            e['_manual_audit'] = {
                'kind': 'semantic',
                'reason': '单位/币种变化（计价基准变了，多为解析取错单位或列），已保留上一版价格待人工核验',
                'field_diff': detail.get('semantic'),
                'new_values': new_vals,
                'since': today_iso0,
            }
        elif 'region' in kinds:
            e['_manual_audit'] = {
                'kind': 'region',
                'reason': '地域变化（同币种下可能是真实区域差价），价格已采用新值，需人工确认是否为预期区域',
                'field_diff': detail.get('region'),
                'since': today_iso0,
            }
        for k in kinds:
            changes.append({'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                            'built_at': today_iso0, 'model': key, 'kind': k, 'detail': detail})
    # 安全阀：闸门把整库清空 → 回退上一版（宁可沿用旧价，也不能交付空索引）
    if not merged and prev_models:
        merged = {k: dict(v) for k, v in prev_models.items()}
        changes.append({'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                        'built_at': today_iso0, 'model': '*', 'kind': 'rollback',
                        'reason': '本次所有条目被闸门拒收（或抓取全空），已整体回退上一版索引',
                        'rejected': len(rejected)})
        sys.stderr.write('[build_index][ERROR] 本次 %d 个条目被新模型闸门拒收且索引将为空 → 已整体回退上一版（%d 个模型），请检查抓取与契约字段\n'
                         % (len(rejected), len(prev_models)))
    if rejected:
        sys.stderr.write('[build_index][WARN] %d 个新条目被闸门拒收（契约不全/价格越界，未进索引 → 该模型按未收录计价）：\n' % len(rejected))
        for key, why in rejected[:20]:
            sys.stderr.write('  - %s: %s\n' % (key, why))
        if len(rejected) > 20:
            sys.stderr.write('  …另 %d 条\n' % (len(rejected) - 20))

    # 单厂商当天抓取失败 → 该厂商模型整体缺席时沿用上一份完整库（计费不降级到聚合源；次日该厂恢复自动更新）
    # 注意不限定 built_at：今天早上成功/晚上失败重建时，早上那份就是最新完整版，同样要沿用
    if prev:
        VEND_TAGS = (('TokenHub', '腾讯混元'), ('bigmodel', '智谱'), ('智谱', '智谱'), ('Kimi', 'Kimi'),
                     ('moonshot', 'Kimi'), ('阶跃', '阶跃'), ('stepfun', '阶跃'), ('MiniMax', 'MiniMax'), ('minimax', 'MiniMax'))
        def tag_of(src):
            s = str(src or '')
            for kw, tag in VEND_TAGS:
                if kw in s:
                    return tag
            return None
        today_tags = {t for t in (tag_of(v.get('primary_source')) for v in merged.values()) if t}
        carried = []
        today_iso = datetime.date.today().isoformat()
        # v2.82（2026-09-01）修复：原判定 `if t and t not in today_tags` 是「按厂商整体」判断——
        # 厂商只要当天抓到任意一个模型（tag 进入 today_tags），该厂商其余缺失模型就全部丢弃。
        # 实测 Moonshot 官网改版：chat-k25 / chat-v1 两页返回软 404（HTTP 200 但内容是默认页），
        # 当天仍抓到 4 个 Kimi 模型 → tag 在 today_tags → kimik25 + moonshot-v1-8k/32k/128k
        # 共 4 个模型被静默丢弃（35→31）。用户若在用这些模型，当天直接按 0 元计。
        # 改为「逐模型沿用」：任何上一版有、本次缺失的模型都沿用，不看厂商当天是否部分成功。
        # 防僵尸：连续缺失超过 CARRY_MAX_DAYS 天则不再沿用（模型真下架时自动淘汰）。
        for k, v in prev.get('models', {}).items():
            if k in merged:
                continue
            vv = dict(v)
            since = vv.get('missing_since') or prev.get('built_at') or today_iso
            try:
                gap = (datetime.date.fromisoformat(today_iso) - datetime.date.fromisoformat(since)).days
            except Exception:
                gap = 0
            if gap > CARRY_MAX_DAYS:
                # v3.53.0：淘汰也要进审计流水（否则"模型从索引消失过"这件事无据可查）
                changes.append({'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                                'built_at': today_iso, 'model': k, 'kind': 'retired',
                                'reason': '连续缺失 %d 天 > %d 天上限，判定已下架' % (gap, CARRY_MAX_DAYS)})
                continue  # 真下架：连续缺失过久，淘汰
            vv['missing_since'] = since
            vv['carried_from'] = prev.get('built_at')
            changes.append({'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                            'built_at': today_iso, 'model': k, 'kind': 'carried',
                            'reason': '本版抓取未返回该模型，沿用 %s 价（第 %d 天）'
                                      % (prev.get('built_at') or '上版', gap)})
            if tag_of(v.get('primary_source')) in today_tags:
                vv['tier_note'] = '官网当日未返回该模型（可能改版/下架），沿用 %s 价' % (prev.get('built_at') or '上版')
            merged[k] = vv
            carried.append((tag_of(v.get('primary_source')) or '其他', k))
        if carried:
            by = {}
            for t, k in carried:
                by.setdefault(t, []).append(k)
            print('沿用前一天（厂商今日抓取失败）: ' + '; '.join('%s %d个(%s)' % (t, len(ks), ','.join(ks)) for t, ks in sorted(by.items())))

    # v3.51.0（审计批1·B/C）：被跳过条目统一 WARN 列出（此前全部静默 continue，
    #   官网改版/契约缺失时模型从索引悄悄消失、用户按未收录计费而无任何提示）。
    if skipped:
        sys.stderr.write('[build_index][WARN] %d 个条目未进索引（无价/契约不全/无名，已跳过）：\n' % len(skipped))
        for src, why in skipped[:20]:
            sys.stderr.write('  - %s: %s\n' % (src, why))
        if len(skipped) > 20:
            sys.stderr.write('  …另 %d 条\n' % (len(skipped) - 20))

    # ── v3.53.0：审计流水落盘 + 分级告警（「今天变了什么」的唯一留痕）──────────────
    counts = {}
    for c in changes:
        counts[c['kind']] = counts.get(c['kind'], 0) + 1
    written = append_changes(changes)

    def models_of(kind):
        return [c.get('model') for c in changes if c.get('kind') == kind]

    sem = models_of('semantic')
    if sem:
        sys.stderr.write('[build_index][WARN] %d 个条目「单位/币种」发生变化 —— 计价基准可能已被解析取错，'
                         '已**保留上一版价格**并挂 _manual_audit 待人工核验：%s\n'
                         % (len(sem), ', '.join(str(x) for x in sem[:10])))
    jm = models_of('big_jump')
    if jm:
        sys.stderr.write('[build_index][WARN] %d 个条目价格跳变 >%g× 或 <1/%g（多为单位或列取错；'
                         '按「值变=自动」已采纳，请复核）：%s\n'
                         % (len(jm), BIG_JUMP, BIG_JUMP, ', '.join(str(x) for x in jm[:10])))
    dg = models_of('source_downgrade')
    if dg:
        sys.stderr.write('[build_index][WARN] %d 个条目来源降级（first_party → channel/reseller，'
                         '官方价退化为转售价）：%s\n' % (len(dg), ', '.join(str(x) for x in dg[:10])))
    rg = models_of('region')
    if rg:
        sys.stderr.write('[build_index][WARN] %d 个条目地域变化（价格已采用新值，请确认是否为预期区域）：%s\n'
                         % (len(rg), ', '.join(str(x) for x in rg[:10])))
    if counts.get('new'):
        print('新增模型 %d 个（契约 + 价格闸门已过，自动采纳；明细见 %s）'
              % (counts['new'], os.path.basename(CHANGE_FILE)))

    result = {
        'built_at': datetime.date.today().isoformat(),  # 每日刷新闸门：skill 读此字段判断是否需要重抓
        'merged_at': d.get('fetched_at'),
        'currency': 'CNY',
        'unit': '元/百万 tokens',
        # v3.53.0（审计批3）：变更分级汇总。**仅供审计消费** —— mergeLocalPriceDb
        #   （token-tracker.js:2544-2571）按固定字段白名单读取，顶层新字段对计费零影响。
        '_changes': {
            'file': os.path.basename(CHANGE_FILE),
            'counts': counts,
            'written': written,
            'gate_mode': 'full' if gate_full else 'min',
        },
        'conflict_resolved': conflicts,
        'authoritative_overrides': overlay,
        'models': merged,
    }
    # v3.52.0（审计批2·G7）：写盘前**滚动备份上一版**。原实现只有 tmp + os.replace 的原子写
    #   （防读到半截 JSON），但**新索引内容出错时无法回滚**：一旦抓取/合并逻辑把价格算错并落盘，
    #   上一版正确索引已被覆盖、连人工恢复的材料都没有（只留 ≤7 天逐模型沿用，救不回整份错价）。
    #   备份失败只 WARN —— 备份是保险，不能因为备份不了就拒绝产出今日索引。
    if os.path.exists(OUT):
        try:
            shutil.copyfile(OUT, OUT + '.bak')
        except Exception as e:
            sys.stderr.write('[build_index][WARN] index.json 滚动备份失败（%r）；本次不回滚保护\n' % (e,))
    # 原子写：先写临时文件再替换，保证读取方(技能)在刷新中途读到的要么是旧完整版要么是新完整版
    # v2.82：tmp 按 PID 唯一化——固定名 .tmp 在多会话并发时两个进程互写同一文件 → PermissionError(exit 1)
    tmp = '%s.tmp-%d' % (OUT, os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OUT)
    print('合并完成：%d 个归一化模型，解决 %d 处来源冲突，%d 个被 pricing.json(lock) 权威覆盖（其中 %d 个为新注入的官方项）；跳过 %d 条契约不全/无价条目（详见 stderr）'
          % (len(merged), conflicts, overlay, injected, len(skipped)))
    print('已写入 %s' % OUT)
    # 打印关键冲突 / 覆盖样例
    print('\n--- 官方 vs 转售 冲突（已采用官方 first_party）---')
    shown = 0
    for key, m in merged.items():
        srcs = m['all_sources']
        if len(srcs) > 1 and any(s['source_type'] == 'first_party' for s in srcs) \
                and any(s['source_type'] != 'first_party' for s in srcs):
            fp = [s for s in srcs if s['source_type'] == 'first_party'][0]
            ch = [s for s in srcs if s['source_type'] != 'first_party'][0]
            print('  %s: 官方(%s)=%s/%s/%s  转售(%s)=%s/%s/%s'
                  % (m['name'], fp['source'], fp['in'], fp['out'], fp['cache'],
                     ch['source'], ch['in'], ch['out'], ch['cache']))
            shown += 1
            if shown >= 10:
                break
    return 0


if __name__ == '__main__':
    main()
