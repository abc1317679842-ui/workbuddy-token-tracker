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

HERE = os.path.dirname(os.path.abspath(__file__))
LATEST = os.path.join(HERE, 'prices', 'latest.json')


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
OUT = os.path.join(HERE, 'prices', 'index.json')
TOKENHUB = os.path.join(HERE, 'prices', 'tokenhub_lang.json')

# v2.82（2026-09-01）：「逐模型沿用」的保留天数上限。
# 上一版有、本次抓取缺失的模型会沿用旧价（防官网改版/软404导致价格凭空消失、按 0 元计）；
# 连续缺失超过此天数则判定模型已真下架，自动淘汰，避免僵尸条目永久占位。
CARRY_MAX_DAYS = 7

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


def main():
    d = json.load(open(LATEST, encoding='utf-8'))
    groups = {}
    for vk, v in d['vendors'].items():
        for m in v.get('models', []):
            key = norm(m.get('api_name') or m.get('name'))
            if not key:
                continue
            inp, outp, cache = in_out_cache(m)
            if inp is None and outp is None and cache is None:
                continue  # 无价格，跳过
            st = src_type(vk, m)
            groups.setdefault(key, []).append({
                'vendor': vk,
                'name': m.get('name'),
                'api_name': m.get('api_name'),
                'source_type': st,
                'in': inp, 'out': outp, 'cache': cache,
                'tier_note': m.get('tier_note', ''),
                'source': m.get('source', vk),
            })

    # 摄入腾讯云 TokenHub 文档（含峰谷分档 / 原厂直供 / 输入长度分档）
    # v3.19.2（B4）：不再汇总顶层 peak_rules。原实现把 TokenHub 的 peak_rule 自由文本
    #   （+ 一条 DeepSeek 规则串）写进 index.json，但技能侧从未读取（峰谷判定只认
    #   pricing.deepseek_rules），且自由文本无法机器解析 → 删掉这半截链路，别让
    #   "看起来支持各厂商峰谷" 的空字段误导后人。
    if os.path.exists(TOKENHUB):
        th = json.load(open(TOKENHUB, encoding='utf-8'))
        for m in th.get('models', []):
            key = norm(m.get('api_name') or m.get('name'))
            if not key:
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
                continue
            inp = base_t['in']
            outp = base_t['out']
            cache = base_t['cache']
            if inp is None and outp is None and cache is None:
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
                'source': '腾讯云TokenHub文档(广州,' + (m.get('sku') or '') + ')',
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
                if peak:
                    rec['peak'] = peak
                merged[k] = rec
                injected += 1
                overlay += 1

    # 单厂商当天抓取失败 → 该厂商模型整体缺席时沿用上一份完整库（计费不降级到聚合源；次日该厂恢复自动更新）
    # 注意不限定 built_at：今天早上成功/晚上失败重建时，早上那份就是最新完整版，同样要沿用
    prev = None
    try:
        prev = json.load(open(OUT, encoding='utf-8'))
    except Exception:
        prev = None
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
                continue  # 真下架：连续缺失过久，淘汰
            vv['missing_since'] = since
            vv['carried_from'] = prev.get('built_at')
            if tag_of(v.get('primary_source')) in today_tags:
                vv['tier_note'] = '官网当日未返回该模型（可能改版/下架），沿用 %s 价' % (prev.get('built_at') or '上版')
            merged[k] = vv
            carried.append((tag_of(v.get('primary_source')) or '其他', k))
        if carried:
            by = {}
            for t, k in carried:
                by.setdefault(t, []).append(k)
            print('沿用前一天（厂商今日抓取失败）: ' + '; '.join('%s %d个(%s)' % (t, len(ks), ','.join(ks)) for t, ks in sorted(by.items())))

    result = {
        'built_at': datetime.date.today().isoformat(),  # 每日刷新闸门：skill 读此字段判断是否需要重抓
        'merged_at': d.get('fetched_at'),
        'currency': 'CNY',
        'conflict_resolved': conflicts,
        'authoritative_overrides': overlay,
        'models': merged,
    }
    # 原子写：先写临时文件再替换，保证读取方(技能)在刷新中途读到的要么是旧完整版要么是新完整版
    # v2.82：tmp 按 PID 唯一化——固定名 .tmp 在多会话并发时两个进程互写同一文件 → PermissionError(exit 1)
    tmp = '%s.tmp-%d' % (OUT, os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OUT)
    print('合并完成：%d 个归一化模型，解决 %d 处来源冲突，%d 个被 pricing.json(lock) 权威覆盖（其中 %d 个为新注入的官方项）'
          % (len(merged), conflicts, overlay, injected))
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
