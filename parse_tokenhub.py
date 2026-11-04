"""解析腾讯云大模型服务平台 TokenHub「模型价格」文档页。
源：https://cloud.tencent.com/document/product/1823/130055
该页服务端渲染 + gzip，requests 可直接抓取（无需浏览器）。
v3.23.4：requests 降为可选依赖（缺失时 fetch() 自动回退 urllib，显式要求 identity 编码避免 gzip）；
TLS 证书一律严格校验，不再全局关闭（价格影响计费）。

产出：广州地域「在线推理-语言模型」价表的结构化记录，含：
  - 模型名 / 归一化 api 名 / 品牌 / 是否原厂直供(自营 or 转售)
  - 分档 tiers：type=peak(峰谷:空闲/高峰) 或 length(输入长度分档) 或 base
  - 每档 输入/输出/缓存命中 单价（元/百万 tokens）

v3.51.0（2026-10-12，审计批1·A）：地域与币种改为**显式解析**，废止一切猜测。
  旧实现用「三特征匹配 + \\d+\\.\\d{3,} 小数位数排除新加坡块 + cands[0] fallback」挑目标表，
  输出 region='广州'/currency='CNY' 却是 L260-261 硬编码 —— 2026-10-12 实测该猜测链**已触发
  fallback**：广州表里 MiMo 缓存命中价 0.025 是合法 3 位小数，被排除规则误杀 → 三候选全灭 →
  靠 cands[0] 蒙对。一旦腾讯调整 tab 顺序（新加坡面板在前），USD/新加坡价就会盖上「广州/CNY」戳
  静默入账。现改为解析页面 tse-tabs 组件的「地域标签 → 面板」结构（见 find_region_panels），
  单位/币种从价表表头声明读取（见 parse_unit_currency），任何一环不符即 exit(2) 保留旧文件。
"""
import os, re, json, ssl, gzip, zlib, urllib.request, sys, time
try:
    import requests  # 可选依赖：缺失时 fetch() 自动回退 urllib（本页服务端渲染，不需要 requests 的任何特性）
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

URL = 'https://cloud.tencent.com/document/product/1823/130055'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

# 模型名 -> (品牌, 归一化 api 名)
# ⚠ v3.63.4（用户 2026-10-21 拍板）：本表**只收腾讯自家通用 LLM**（混元系通用模型）。
#   腾讯云这个页面同时卖三类东西：① 混元通用模型（收）② 混元非通用模型（不收：
#   Hy-MT2 机器翻译系 —— 用户明确「只要通用模型，不要翻译模型」，2026-08-31 已决定
#   不按 LLM token 库保存）③ 转售第三方（DeepSeek/智谱/Kimi/MiniMax/Qwen/MiMo/阶跃，
#   各自有官方页或聚合源，不收）。把 Hy-MT 系补进本表会被 NON_GENERAL_RE 双重拦下。
BRAND_MAP = {
    # 2026-11-04：Hy4 正式版上线（TokenHub 同日 12:13 加行 `Hy4 | hy4 | 6/18/0.3`），
    #   本表没跟上 → 该行落到「未识别」被丢弃，只打一条 stderr WARN（hook 子进程里看不到）。
    #   实测证据：当天 15:08 抓取的 tokenhub_lang.json 里 `_unmapped` 首位就是 "Hy4"。
    #   → 这是本表**结构性问题**：白名单的漏洞必然落在「最新模型」上，因为新模型天生不在旧表里。
    'Hy4': ('hunyuan', 'hy4'),
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


def ssl_context():
    """严格校验为默认；仅当显式设 CN_PRICES_INSECURE_TLS=1 才降级（打警告，不静默）。"""
    ctx = ssl.create_default_context()
    if os.environ.get('CN_PRICES_INSECURE_TLS') == '1':
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        import sys
        sys.stderr.write('[WARN] CN_PRICES_INSECURE_TLS=1：已关闭 TLS 证书校验，抓取到的价格可被中间人篡改\n')
    return ctx


def decode_body(raw, encoding):
    """按 Content-Encoding 解压（requests 自动做，urllib 不会）。
    实测腾讯云文档页无视 Accept-Encoding: identity、永远回 gzip —— 不解压会拿到二进制垃圾，
    解析结果「0 个模型」却没有任何报错，属于最坏的一类静默失败。"""
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


# v3.59.0（审计 M21）：抓取重试（指数退避），同 fetch-cn-prices.http_get 的口径。
#   腾讯文档页瞬时抖动/Cloudflare 挑战一次失败 → 整条源 exit(2) 保留旧版，本可不必。
TOKENHUB_RETRIES = int(os.environ.get('CN_PRICE_HTTP_RETRIES') or '2')
TOKENHUB_RETRY_BASE_MS = 400


def fetch():
    last = None
    for attempt in range(TOKENHUB_RETRIES + 1):
        try:
            if requests is not None:
                # v3.48.0（审计 S6）：原实现 `requests.get(URL,...).text` **不校验 HTTP 状态**——腾讯文档页临时
                #   5xx / Cloudflare 挑战页会被 .text 原样吃下：页面里恰有含"峰谷计费"的块时，错误价表直接写进
                #   tokenhub_lang.json；没切出块则 0 模型"假成功"。而 urllib 分支非 2xx 直接抛 → 同一故障两条
                #   分支给出两种结局。raise_for_status 让 requests 分支与 urllib 分支对齐（fail-closed）。
                #   另：requests 分支的 verify 与 urllib 分支同受 CN_PRICES_INSECURE_TLS 控制（见 ssl_context
                #   上方注释），无需在此重复处理。
                resp = requests.get(URL, headers={'User-Agent': UA}, timeout=30)
                resp.raise_for_status()
                return resp.text
            req = urllib.request.Request(URL, headers={'User-Agent': UA})
            resp = urllib.request.urlopen(req, timeout=30, context=ssl_context())
            return decode_body(resp.read(), resp.headers.get('Content-Encoding'))
        except Exception as e:
            last = e
            if attempt >= TOKENHUB_RETRIES:
                break
            time.sleep(TOKENHUB_RETRY_BASE_MS * (2 ** attempt) / 1000.0)
    raise last


# v3.52.0（审计批2·L2）：列语义同义词表 —— 腾讯改列表头词面时**只补表、不动解析逻辑**。
#   认领顺序至关重要（见 map_columns）：特殊列（条件/峰谷/缓存命中）必须先于 in/out 认领，
#   否则「输入长度」这类条件列会被含「输入」的 in 抢走。
#   ⚠️ 与 fetch-cn-prices.py 的 COL_SYNONYMS 需保持一致（两个 py 无共享模块，各自实现）。
COL_SYNONYMS = {
    'name': ('模型名称', 'model', '模型', '名称'),
    'cond': ('条件', 'token', '输入长度'),
    'peak': ('峰谷', '时段'),
    'cache': ('缓存命中', '缓存价格', '缓存'),
    'in': ('推理输入', '输入价格', '输入单价', '输入'),
    'out': ('推理输出', '输出价格', '输出单价', '输出'),
    # 2026-11-04（批27 · C）：空元组 = 本表不参与同义词认领，由 map_columns 第二遍专门处理
    #   （见该函数注释：'model' 与 name 的同义词冲突，谁先拿到取决于表头顺序）。
    'api': (),
}
# 认领顺序：先特殊列，再 in/out（含裸「输入/输出」的同义词最宽，必须最后认领）
CLAIM_ORDER = ('name', 'cond', 'peak', 'cache', 'in', 'out')


def map_columns(hdr):
    """表头单元格 -> 各语义列索引（未认领为 None）。v3.52.0 取代原 col(['字面量']) 位置式写法。

    v3.63.9（2026-10-25 全解析器复核）：比较改**大小写不敏感**。此前 `w in c` 区分大小写，
    腾讯把表头改成「Input Price / Input」这种英文写法时整表 0 模型。

    2026-11-04（批27 · C）：新增 `api` 列认领（页面第 2 列 `model（调用参数）`）。
      这一列是**腾讯自己声明的真实调用参数**（实测：Hy4→`hy4`、Hy4 preview→`hy4-preview`、
      Hy-Role-Latest→`hunyuan-role-latest`），也就是"宿主上报的 id 长什么样"的权威来源。
      此前它完全没被读 —— COL_SYNONYMS['name'] 里有 'model' 同义词，但「模型名称」先占位，
      于是这一列被静默丢弃。**不能用同义词表认领**：'model' 同时是 name 的同义词，
      谁先拿到取决于表头顺序（不可控），必须单独第二遍、并显式跳过已被 name 认领的那一列。
    """
    res = {k: None for k in COL_SYNONYMS}
    for i, c in enumerate(hdr or []):
        cl = str(c or '').lower()
        for k in CLAIM_ORDER:
            if res[k] is None and any(w.lower() in cl for w in COL_SYNONYMS[k]):
                res[k] = i
                break
    # 第二遍：api 列（调用参数）。① 含「调用参数」直接认领；② 否则按 model/api 词面认领，
    #   但**跳过 name 已占的那一列**（否则英文表 `Model` 会被 api 抢走，name 反而没了）。
    res['api'] = None
    for i, c in enumerate(hdr or []):
        if i == res['name']:
            continue
        cl = str(c or '').lower()
        if '调用参数' in cl or 'api' in cl or re.search(r'model', cl):
            res['api'] = i
            break
    return res


# 2026-11-04（批27 · C）：从 `model（调用参数）` 单元格挑出"真正的 api 名"。
#   实测该列可能塞**多个**调用参数（空格分隔，如
#   `deepseek-v4-flash-202605 deepseek/deepseek-v4-flash-0731 deepseek/deepseek-v4-flash`），
#   混元自家则都是单值（hy4 / hy4-preview / hunyuan-role-latest）。
#   规则：按空格切，取第一个**不含 '/'、不含中文**的 token —— 带斜杠的是聚合平台写法（vendor/model），
#   不是本库价库 key 的形态；取不到就返回 ''（宁可没有，也不要拿半截名字当 key）。
def pick_api_decl(cell):
    for tok in str(cell or '').replace('\u3000', ' ').split():
        t = tok.strip().strip(',，、')
        if not t or '/' in t:
            continue
        if re.search(r'[\u4e00-\u9fa5]', t):
            continue
        return t
    return ''


def _cell_text(cell):
    """单元格 HTML → 纯文本（去标签、压空白）。cells_of_row 的兜底用。"""
    s = re.sub(r'<[^>]+>', ' ', cell or '')
    s = s.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').replace('&nbsp;', ' ')
    return ' '.join(s.split())


def cells_of_row(seg):
    """一个 <tr> 片段 -> 各 <td>/<th> 的文本（多行合并为一格）。

    v3.63.9（2026-10-25 全解析器复核）：腾讯文档页靠 `data-slate-string="true"` 属性取字 ——
    这是**渲染实现细节**，上游换编辑器或改个属性名就让所有格变空 → 整表 0 模型、退出码 0，
    与"官网改版"在日志里长得一模一样。现加兜底：整行一个 slate 串都取不到时退回纯文本，
    宁可多带几个空格也不整厂停更（空格由 _num / 列匹配的宽容逻辑吸收）。"""
    cells = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', seg, re.S)
    out, any_slate = [], False
    for cell in cells:
        texts = re.findall(r'data-slate-string="true">([^<]*)</span>', cell)
        if texts:
            any_slate = True
        out.append(' '.join(t.strip() for t in texts).strip())
    if cells and not any_slate:
        out = [_cell_text(c) for c in cells]
    return out


def rows_of_block(block):
    rows = []
    for seg in re.split(r'<tr', block):
        cells = cells_of_row(seg)
        if cells:
            rows.append(cells)
    return rows


def _num(s):
    """单元格 -> 数字。v3.63.9：允许带币种/单位（`¥0.8` / `0.8 元` / `0.8元/百万tokens`），
    取首个数字；`-`/`—`/空 仍返回 None（不进价库）。"""
    s = (s or '').strip()
    if s in ('-', '', '—'):
        return None
    m = re.match(r'^[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元.*)?$', s)
    return float(m.group(1)) if m else None


def parse_lang_table(block):
    """解析广州语言模型价表（含峰谷/分档）。返回模型列表。"""
    rows = rows_of_block(block)
    # 表头：定位各列索引
    # v3.52.0（审计批2·L2）：表头定位与列映射均改走语义同义词表（原 `any('模型名称' in c)` +
    #   `col(['推理输入'])` 是字面量硬匹配：腾讯把「推理输入」改成「输入单价」→ 找不到表头 →
    #   解析 0 模型 → 触发 exit(2)，混元价从索引消失）。
    hidx = None
    for i, r in enumerate(rows):
        cm = map_columns(r)
        if cm['name'] is not None and cm['in'] is not None:
            hidx = i
            break
    if hidx is None:
        return []
    cm = map_columns(rows[hidx])
    i_name, i_cond, i_peak = cm['name'], cm['cond'], cm['peak']
    i_in, i_out, i_cache = cm['in'], cm['out'], cm['cache']
    i_api = cm['api']  # 2026-11-04（C）：`model（调用参数）` 列，腾讯声明的真实 api 名
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
                # 2026-11-04（C）：页面自己声明的 api 名（`model（调用参数）` 列）。
                #   与 BRAND_MAP 手写的 api_name 是**两个独立来源**：一个来自官网表格，一个来自人工表。
                #   两者不一致时以官网为准做**告警**（不自动改 key —— 改 key 会让历史账本桶名分裂），
                #   见 verify_api_names + keep_hunyuan 的双轨收录。
                'api_decl': pick_api_decl(get(r, i_api)),
                'api_source': 'brand_map' if api else None,
                'sku': '原厂直供' if is_first else ('腾讯标准版' if brand != 'hunyuan' else '官方'),
                'first_party': is_first or (brand == 'hunyuan'),
                'tiers': [],
            }
            models.append(cur)
        if cur is None:
            continue
        peak_v = '空闲时段' if '空闲' in peak else ('高峰时段' if '高峰' in peak else '')
        # v3.63.9：条件列判定改大小写不敏感（`128K` / `128k` / `K)` 都能识别成长度档；
        #   旧实现只认半角小写 k，官方把门槛写成 `128K Tokens` 时会退化成 base 档 → 分档价错位）
        cond_l = cond.lower()
        if peak_v:
            ttype, tval = 'peak', peak_v
        elif ('输入长度' in cond or 'k)' in cond_l or 'k]' in cond_l or 'k+' in cond_l or 'k）' in cond):
            ttype, tval = 'length', cond.strip()
        else:
            ttype, tval = 'base', (cond.strip() or '-')
        cur['tiers'].append({
            'type': ttype,
            'value': tval,
            'in': pin, 'out': pout, 'cache': pcache,
        })
    return models


# v3.63.4（用户 2026-10-21 拍板）：腾讯自家**非通用**模型名（机器翻译系）。
#   本库只收通用 LLM：翻译/语音/嵌入类一律不收。匹配到的名字不进 kept 也不进 unmapped
#   （不刷「请补 BRAND_MAP」告警——那不是遗漏，是范围外），仅在 _excluded_non_general 留痕。
#   新增非通用型号（如下一代翻译模型）落到未识别 → 告警 → 人工确认后补本正则，不会误收。
NON_GENERAL_RE = re.compile(r'^Hy-MT', re.I)

# ── 2026-11-04（A 批·漏收可见）：本库「应负责」的名字范围 ───────────────────────────
# 背景：`_unmapped` 是个大杂烩 —— 里面既有「腾讯混元新品没进 BRAND_MAP」（**我们的漏收**，
#   必须有人看见），也有「TokenHub 页面转售的第三方新品」（**预期不收**，天天照单报警就是噪音）。
#   Hy4 正式版漏收那次，`_unmapped` 的首位就是 "Hy4"，但它只写进了 stderr 一行 WARN ——
#   而调用方是 hook 子进程，用户根本看不到。最终态：官网有明码价、本地按「未收录」计 0 元，
#   用户从弹窗只能看到「未收录」，无法区分"抓取器瞎了"还是"这模型真没公开价"。
# 这里只做**范围界定**（不猜品牌、不猜价）：名字以 Hy / 混元 / Hunyuan 开头即视为本库应负责。
#   判定结果只用于「要不要告警」，**不参与收录逻辑本身** —— 收录仍严格走 BRAND_MAP（宁可不收）。
# ⚠ 顺序：NON_GENERAL_RE（翻译系 Hy-MT*）先被判范围外，不会进 unmapped，故此处无需再排除。
IN_SCOPE_RE = re.compile(r'^(?:Hy|混元|Hunyuan)', re.I)

# 2026-11-04（批27 · C）：**双轨收录**用 —— 腾讯自家 api 命名空间。
#   依据不是"名字像"，而是 TokenHub 页面 `model（调用参数）` 列**腾讯自己写的调用参数**（实测：
#   hy4 / hy4-preview / hy3 / hunyuan-role-latest / hy-mt2-pro 全部落在这个命名空间）。
#   这一轨解决的是 BRAND_MAP 的**结构性缺陷**：白名单的漏洞必然落在"最新模型"上（Hy4 漏收那次就是），
#   而 api 名是官网逐行随表更新的，不需要我们维护。范围仍受 NON_GENERAL_RE 约束（翻译系不进）。
TEN_API_RE = re.compile(r'^(?:hy|hunyuan)', re.I)


def verify_api_names(models):
    """交叉校验：BRAND_MAP 手写的 api_name 与页面声明的 api_decl 是否一致（只管腾讯自家）。

    2026-11-04（C）实测抓到 1 条真不一致：
      `Hy-Role-Latest` —— 我们表里写 `hy-role-latest`，官网声明 `hunyuan-role-latest`。
    后果：宿主若上报官网那个名字，findModel 精确匹配 miss，弹窗「未收录」，而价库里明明有这条。
    **不自动改 key**：价库 key 是账本桶名，改它会让历史计量分裂成两个桶（且旧 key 的记录再也
    匹配不上）。只告警 + 落 `api_mismatch` 字段，由人工决定是否同步（改 key 需配一次账本合并）。
    第三方转售模型的 api 列是多值/带 vendor 前缀（`deepseek/deepseek-flash`），形态本就不一致，
    不参与校验（否则每次抓取刷 5 条噪音，把真问题埋掉）。
    """
    out = []
    for m in models:
        if (m.get('brand') or '') != 'hunyuan':
            continue
        mapped = (m.get('api_name') or '').strip()
        decl = (m.get('api_decl') or '').strip()
        if not mapped or not decl or mapped == decl:
            continue
        m['api_mismatch'] = {'mapped': mapped, 'declared': decl}
        if m['name'] not in out:
            out.append(m['name'])
    return out


def keep_hunyuan(models):
    """从价表解析结果中挑出腾讯自家(混元)模型。

    v3.55.0（审计批5·A2）：**未映射模型不再静默丢弃**。
      旧实现就一条 `brand == 'hunyuan'` 过滤：BRAND_MAP 里没有的新混元模型 → brand=None →
      被同一条语句丢掉且**无声**。0 模型 exit(2) 只在「全都没映射」时兜住，**部分失效**
      （新混元上线 / 老模型改名）时旧模型照常解析 → models 非空 → 新模型静默消失，无人察觉。
      修法遵守「品牌不许猜」红线：**不新增任何启发式**（如按名字前缀推断品牌），
      而是把「丢弃」分三路记账 —— 已知第三方=预期丢弃(不告警) / 未识别=意外(告警 + _unmapped 留痕)。

    v3.63.4（用户 2026-10-21 拍板）：范围收窄为**腾讯自家通用 LLM**。混元系里的非通用模型
      （Hy-MT2 机器翻译系）原先落在「未识别」里，每次抓取都刷「请补 BRAND_MAP」告警 ——
      诱导把翻译模型补进价库，与用户「只要通用模型，不要翻译模型」直接冲突。现在
      NON_GENERAL_RE 命中的名字**两路都不进**（不收录、不告警），由 split_scope 留痕到
      `_excluded_non_general`；对 brand 已误映射为 hunyuan 的翻译系同样拦下（双保险）。

    返回 (kept, unmapped)：kept = 收录的混元通用模型；unmapped = 未识别被丢的模型名
    （调用方负责告警）。非通用模型不进任何一个列表（见 split_scope）。
    """
    unmapped = []
    kept = []
    for m in models:
        nm = m.get('name') or '?'
        # 范围外：腾讯自家非通用模型（翻译系等）—— 不收录也不告警（split_scope 留痕）
        if NON_GENERAL_RE.match(nm):
            continue
        b = m.get('brand')
        if b == 'hunyuan':
            kept.append(m)
        elif b:
            pass  # 已知第三方品牌（deepseek/zhipu/kimi/minimax/qwen 等）：预期丢弃，不告警
        elif _page_api_is_tencent(m):
            # 2026-11-04（C）：**第二轨收录** —— 显示名没进 BRAND_MAP，但官网 `model（调用参数）`
            #   列把它写成了腾讯自家命名空间（hy*/hunyuan*）。这是官网逐行声明的真实数据，不是猜品牌；
            #   且本表本身就是「在线推理-语言模型」价表 → 收录符合「只收腾讯自家通用 LLM」的既定范围。
            #   留痕：api_source='page'（main 会单独打一条 [API] 日志，便于事后核对/回滚）。
            m['brand'] = 'hunyuan'
            m['api_name'] = m['api_decl']
            m['api_source'] = 'page'
            kept.append(m)
        elif nm not in unmapped:
            unmapped.append(nm)  # 去重：页面存在同名多行，告警不刷屏
    return kept, unmapped


def _page_api_is_tencent(m):
    """页面声明的 api 名是否属腾讯自家命名空间（双轨收录的判据，单列出来便于测试与复用）。"""
    decl = (m.get('api_decl') or '').strip()
    if not decl or not TEN_API_RE.match(decl):
        return False
    if NON_GENERAL_RE.match(decl):  # 翻译系 api 名（hy-mt2-*）同样排除，双保险
        return False
    return True


def split_scope(models):
    """按收录范围把解析结果分四路（v3.63.4）。
    返回 (kept, unmapped, excluded)：
      kept      —— 腾讯自家通用 LLM（入索引）；
      unmapped  —— 未识别名字（告警：可能是混元新通用模型/改名，需人工补 BRAND_MAP；
                   也可能是第三方新品——两类都不收，但前者要人看一眼）；
      excluded  —— 腾讯自家非通用（Hy-MT 翻译系等）：范围外，留痕不告警。
    后两个列表按原顺序去重（页面存在同名多行，去重后告警不刷屏）。"""
    kept, unmapped = keep_hunyuan(models)
    excluded = []
    for m in models:
        nm = m.get('name') or '?'
        if NON_GENERAL_RE.match(nm) and nm not in excluded:
            excluded.append(nm)
    return kept, unmapped, excluded


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


# v3.51.0（审计批1·A）：本库只收「广州」地域人民币价。地域不再靠猜（小数位数/数量级/
# 区域名推断一律禁用），改为解析页面 tse-tabs 组件的「地域标签 → 面板」显式结构。
TARGET_REGION = '广州'


def find_region_panels(html):
    """解析 tse-tabs 组件的「地域标签 → 面板内容」显式映射。

    页面结构（2026-10-12 实测 cloud.tencent.com/document/product/1823/130055）：
      <div class="tse-tabs">
        <div class="tse-tabs__bar">…<div class="tse-tabs__list">
          <div class="tse-tabs__item is-active">…<div class="tse-tabs__item-label">广州</div>…
          <div class="tse-tabs__item">…<div class="tse-tabs__item-label">新加坡</div>…
        </div></div>
        <div class="tse-tabs__cont is-active">…广州面板（语言模型价表）…</div>
        <div class="tse-tabs__cont">…新加坡面板（语言模型价表）…</div>
      </div>
    标签与面板按同序一一对应；is-active 在两个维度必须指向同一下标（错位即结构异常）。
    返回 [(label, panel_html), ...]；任何组件结构不符即跳过该组件（宁缺勿错）。
    """
    panels = []
    comps = [m.start() for m in re.finditer(r'class="tse-tabs"', html)]
    conts = [m.start() for m in re.finditer(r'class="tse-tabs__cont', html)]
    if not comps or not conts:
        return panels
    for ci, cs in enumerate(comps):
        ce = comps[ci + 1] if ci + 1 < len(comps) else len(html)
        my = [c for c in conts if cs <= c < ce]
        if not my:
            continue
        # 标签只出现在第一个面板之前（tse-tabs__list 位于 bar 内）
        labels = [s.strip() for s in re.findall(r'tse-tabs__item-label">([^<]*)<', html[cs:my[0]])]
        if len(labels) != len(my):
            continue  # 标签与面板数量不符 → 该组件不可信
        # is-active 错位检查：激活项与激活面板必须同下标（防标签/面板相对顺序被改）
        act_items = [i for i, _ in enumerate(re.finditer(r'tse-tabs__item is-active"', html[cs:my[0]]))]
        act_conts = [i for i, c in enumerate(my) if 'is-active' in html[c:c + 64]]
        if len(act_items) == 1 and len(act_conts) == 1 and act_items[0] != act_conts[0]:
            continue
        for i, c in enumerate(my):
            end = my[i + 1] if i + 1 < len(my) else ce
            panels.append((labels[i], html[c:end]))
    return panels


def parse_unit_currency(tbl):
    """从价表表头显式解析计价单位与币种（如「（元/百万 tokens）」→ ('元/百万 tokens', 'CNY')）。
    禁止按小数位数/数量级猜测币种；解析不出返回 (None, None)（调用方按契约不全处理）。"""
    hdr = ''
    for seg in re.split(r'<tr', tbl)[:40]:
        if '模型名称' in seg:
            hdr = seg
            break
    if not hdr:
        return None, None
    for um in re.finditer(r'[（(]([^（()）]*)[）)]', hdr):
        u = um.group(1).strip()
        if not u:
            continue
        if '美元' in u or 'USD' in u.upper() or '$' in u:
            return u, 'USD'
        if '元' in u:
            return u, 'CNY'
    return None, None


def scan_fingerprint(html):
    """页面结构指纹（v3.52.0·L1）—— 与 fetch-cn-prices.py 同口径。
    0 模型/结构异常时把它打进 stderr：让「网络失败」与「官网改版」在日志里可区分
    （旧版两者都只表现为「解析到模型数: 0」）。"""
    import hashlib
    tbls = re.findall(r'<table[\s\S]*?</table>', html or '') or []
    heads = []
    for t in tbls[:3]:
        r = re.search(r'<tr[^>]*>[\s\S]*?</tr>', t)
        if r:
            heads.append(re.sub(r'<[^>]+>', ' ', r.group(0)).split()[:8])
    return {
        'bytes': len(html or ''),
        'sha1_8': hashlib.sha1((html or '').encode('utf-8', 'replace')).hexdigest()[:8],
        'tables': len(tbls),
        'headers': heads,
    }


def dump_fingerprint(html):
    """把结构指纹打进 stderr（各 fail-closed 分支共用，避免四处复制）。"""
    try:
        sys.stderr.write('[parse_tokenhub][FINGERPRINT] %s\n'
                         % json.dumps(scan_fingerprint(html), ensure_ascii=False))
    except Exception:
        pass


def main():
    html = fetch()
    # v3.51.0（审计批1·A）：显式区域绑定 —— 按页面 tse-tabs 结构找「广州」面板，再取面板内
    # 的语言模型价表。废止：三特征猜块 + 小数位数排除 + cands[0] fallback（会把新加坡块当
    # 广州块：实测新加坡块 GLM-5.3 为 10.07524 而广州为 8，错价 26% 且无任何告警）。
    panels = find_region_panels(html)
    if not panels:
        sys.stderr.write('[parse_tokenhub][ERROR] 页面未找到 tse-tabs 地域选项卡结构（可能改版/被拦/结构变化），不写入；保留上一版本\n')
        dump_fingerprint(html)
        print('解析到模型数: 0 | 页面无地域选项卡结构，已保留上一版 tokenhub_lang.json')
        sys.exit(2)
    hits = [(lb, p) for lb, p in panels if TARGET_REGION in lb]
    if len(hits) != 1:
        sys.stderr.write('[parse_tokenhub][ERROR] 地域面板匹配异常：期望恰好 1 个含「%s」的面板，实际 %d 个（全部标签: %s）；不写入；保留上一版本\n'
                         % (TARGET_REGION, len(hits), [lb for lb, _ in panels]))
        print('解析到模型数: 0 | 地域面板匹配异常，已保留上一版 tokenhub_lang.json')
        sys.exit(2)
    region_label, panel = hits[0]
    # v3.52.0（审计批2·L2）：价表定位改走语义列映射（原 `'模型名称' in t and '推理输入' in t and
    #   '峰谷计费' in t` 是字面量判定 —— 腾讯把「推理输入」改名即整条源 exit(2)、混元价静默消失）。
    #   判据：表头必须同时认领到「模型名称 / 输入价 / 峰谷」三类列（缺一即不是语言模型价表）。
    tbl = None
    for t in re.split(r'<table', panel)[1:]:
        hrow = re.search(r'<tr[^>]*>[\s\S]*?</tr>', t)
        if not hrow:
            continue
        hc = cells_of_row(hrow.group(0))
        if not any(hc):
            hc = [re.sub(r'<[^>]+>', ' ', x).strip()
                  for x in re.findall(r'<t[dh][^>]*>([\s\S]*?)</t[dh]>', hrow.group(0))]
        cm = map_columns(hc)
        if cm['name'] is not None and cm['in'] is not None and cm['peak'] is not None:
            tbl = t
            break
    if tbl is None:
        sys.stderr.write('[parse_tokenhub][ERROR] 「%s」面板内未找到语言模型价表（页面可能改版），不写入；保留上一版本\n' % region_label)
        print('解析到模型数: 0 | 面板内无语言模型价表，已保留上一版 tokenhub_lang.json')
        sys.exit(2)
    unit, currency = parse_unit_currency(tbl)
    if not unit or not currency:
        sys.stderr.write('[parse_tokenhub][ERROR] 价表表头未声明计价单位/币种（契约不全，禁止猜测），不写入；保留上一版本\n')
        print('解析到模型数: 0 | 表头无单位/币种声明，已保留上一版 tokenhub_lang.json')
        sys.exit(2)
    if currency != 'CNY':
        # 区域与币种矛盾（CN 区出现 $）→ 拒收。本库只收人民币价，非 CNY 一律不写。
        sys.stderr.write('[parse_tokenhub][ERROR] 「%s」面板表头声明币种 %s（%s）——本库只收人民币价，区域与币种矛盾，不写入；保留上一版本\n'
                         % (region_label, currency, unit))
        print('解析到模型数: 0 | 区域币种矛盾（%s/%s），已保留上一版 tokenhub_lang.json' % (region_label, currency))
        sys.exit(2)
    models = parse_lang_table(tbl)
    # 只保留腾讯自家通用 LLM；页面里其余是腾讯转售的第三方(智谱/Kimi/DeepSeek/MiniMax)，
    # 以及混元系里的非通用模型(翻译系 Hy-MT*)——两类都不收（用户 2026-10-21：只要通用模型）
    models, unmapped, excluded = split_scope(models)
    # 2026-11-04（C）：双轨收录留痕 + api 名交叉校验（两条都只写 stderr，不影响本期写入内容）
    page_added = [m.get('name') for m in models if m.get('api_source') == 'page']
    if page_added:
        sys.stderr.write('[parse_tokenhub][API] 双轨收录 %d 个模型（显示名未进 BRAND_MAP，'
                         '但官网 `model（调用参数）` 列声明为腾讯自家命名空间）：%s\n'
                         '  -> 这些条目的价库 key 直接取自官网调用参数，**不是**人工表里的值；'
                         '若需固定，建议把名字补进 BRAND_MAP（品牌 + api 名）以便留档\n'
                         % (len(page_added), '、'.join(page_added)))
    mismatch = verify_api_names(models)
    if mismatch:
        detail = '；'.join('%s：表内 %s / 官网 %s' % (m['name'], m['api_mismatch']['mapped'], m['api_mismatch']['declared'])
                          for m in models if m.get('api_mismatch'))
        sys.stderr.write('[parse_tokenhub][API] ★ 以下 %d 个腾讯模型的 api 名与官网 `model（调用参数）` 列不一致：%s\n'
                         '  -> 若宿主上报的是**官网那个名字**，价库精确匹配会 miss → 弹窗「未收录」，'
                         '而价库里其实有这条\n'
                         '  -> 不自动改 key（价库 key = 账本桶名，改它会分裂历史计量）；'
                         '请人工确认后同步 BRAND_MAP 并安排一次账本合并\n'
                         % (len(mismatch), detail))
    if excluded:
        sys.stderr.write('[parse_tokenhub][SKIP] 以下 %d 个腾讯自家非通用模型按范围排除（不收录、不告警）：%s\n'
                         '  -> 本库只收通用 LLM；翻译/语音/嵌入类一律不进（用户 2026-10-21 拍板）\n'
                         % (len(excluded), '、'.join(excluded)))
    if unmapped:
        sys.stderr.write('[parse_tokenhub][WARN] 以下 %d 个模型名未在 BRAND_MAP 中映射，本次未收录：%s\n'
                         '  -> 若为腾讯混元**新通用模型**/改名，请补 BRAND_MAP（本库不猜品牌：宁可不收，也不误收）\n'
                         '  -> 若为第三方新品（转售），属预期不收，可忽略\n'
                         % (len(unmapped), '、'.join(unmapped)))
    # 2026-11-04（A 批）：从 unmapped 里挑出**本库应负责**的那些（腾讯自家命名），单独留痕 + 醒目告警。
    #   旧实现把这两类混在一行 WARN 里，等于告诉用户"里面有要看的也有不用看的"，结果是都不看。
    #   这份清单会被 build_index 汇进 index.json 的 `_fetch_degraded.unrecognized_models`，
    #   进而出现在弹窗（⚠漏收，仅当本轮模型相关时才挂）与 --report 顶部（全量）。
    in_scope = [n for n in unmapped if IN_SCOPE_RE.match(n)]
    if in_scope:
        sys.stderr.write('[parse_tokenhub][MISS] ★ 以下 %d 个**腾讯自家**模型名本次未收录（官网有行、本库没认出来）：%s\n'
                         '  -> 这是真漏收（不是第三方转售）：价库缺它 → 用到该模型时无法计价，'
                         '弹窗将显示「未收录」并挂「⚠漏收」标签\n'
                         '  -> 修法：把该名字补进本文件 BRAND_MAP（品牌 + api 名），重跑流水线即收录\n'
                         % (len(in_scope), '、'.join(in_scope)))
    if not models:
        # v3.48.0（审计 F8）：0 模型一律不写、非零退出。5xx/Cloudflare/列序变化都可能切出 0 模型，
        #   而 0 模型文件会让 build_index 的"逐模型沿用 ≤7 天"失效 → Hunyuan 从索引消失 →
        #   该模型按 0/未收录计费。宁可这次没数据，也不能用空数据覆盖好数据。
        sys.stderr.write('[parse_tokenhub][ERROR] 解析到 0 个混元模型（页面可能改版/被拦/列序变化），不写入；保留上一版本\n')
        dump_fingerprint(html)
        print('解析到模型数: 0 | 未解析到混元模型，已保留上一版 tokenhub_lang.json')
        sys.exit(2)
    peak_rule = parse_peak_rule(html)
    if not peak_rule:
        # 峰谷规则缺失只告警、仍写模型价：模型价是主数据，峰谷规则缺失时 build_index 会沿用上一版
        #   （:217-273 的逐模型沿用逻辑）。若为此整份不写，反而会让 Hunyuan 整条源消失（F5 的过度保守）。
        sys.stderr.write('[parse_tokenhub][WARN] 未提取到峰谷时段规则（页面文案可能变化）；仍写入模型价，峰谷规则由 build_index 沿用上一版\n')
    # v3.62.0（外部审计 F-4）：北京时间（aware）。本文件是 tokenhub_lang.json 的唯一产出方，
    #   而 build_index 的 SOURCE_TTL_HOURS 单独校验它的新鲜度（它不受流水线日期约束，
    #   停更时此前完全无感）。改前用本地 naive 时间 → 非 UTC+8 机器上新鲜度判定偏移。
    fetched_at = __import__('datetime').datetime.now(
        __import__('datetime').timezone(__import__('datetime').timedelta(hours=8), 'CST')
    ).isoformat(timespec='seconds')
    # v3.51.0（审计批1·A/B）：region/currency/unit 全部来自页面显式解析（标签 + 表头声明），
    # 不再硬编码；每条模型记录携带完整契约字段，供 build_index 契约海关校验。
    for m in models:
        m['unit'] = unit
        m['currency'] = currency
        m['region'] = region_label
        m['source_url'] = URL
        m['fetched_at'] = fetched_at
    out = {
        'source': '腾讯云大模型服务平台 TokenHub 模型价格文档',
        'url': URL,
        'fetched_at': fetched_at,
        'region': region_label,
        'currency': currency,
        'unit': unit,
        'peak_rule': peak_rule,
        'models': models,
        # v3.55.0（A2）：本次被丢弃的未识别模型名（留痕，供人工补 BRAND_MAP）
        '_unmapped': unmapped,
        # 2026-11-04（A 批）：其中**属于本库范围**的那些（腾讯自家命名）—— 这是"真漏收"，
        #   由 build_index 汇进 _fetch_degraded.unrecognized_models → 弹窗/报表可见。
        #   与 _unmapped 分开存：第三方转售名不该触发漏收告警（否则天天报，等于没报）。
        '_unmapped_in_scope': in_scope,
        # v3.63.4：本次按范围排除的腾讯自家非通用模型（翻译系等；留痕，build_index 不消费）
        '_excluded_non_general': excluded,
    }
    import os
    # v3.51.0（审计批1·C）：输出目录改为 HERE 锚定。原实现 `os.makedirs('prices')` 是
    #   **cwd 相对路径**——换个工作目录跑就写到别处，而 build_index.py 只读
    #   HERE/prices/tokenhub_lang.json → 混元价从索引静默消失（靠 ≤7 天逐模型沿用兜底，
    #   无人察觉）。与 fetch-cn-prices.py 的 HERE/OUT_DIR 模式对齐。
    # v3.52.0（审计批2·S1）：输出目录可用 CN_PRICES_DIR 显式指定（同 fetch-cn-prices.py）。
    #   原实现恒写脚本自身目录的 prices/，与调用方（token-tracker.js）自动发现的价库目录
    #   CN_PRICE_DIR 不一致时 → 混元价写到技能目录、**价库目录里的 tokenhub_lang.json 永不更新**。
    out_dir = os.environ.get('CN_PRICES_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prices')
    os.makedirs(out_dir, exist_ok=True)
    # v2.82：原子写（唯一 tmp + os.replace），防多会话并发时读方拿到半截 JSON
    tmp = os.path.join(out_dir, 'tokenhub_lang.json.tmp-%d' % os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        # v3.59.0（批10·M17）：allow_nan=False —— 写出 `NaN` 会让 Node 侧 JSON.parse 抛错致计费崩溃
        json.dump(out, f, ensure_ascii=False, indent=1, allow_nan=False)
    os.replace(tmp, os.path.join(out_dir, 'tokenhub_lang.json'))
    print('解析到模型数:', len(models), '| 峰谷规则:', len(peak_rule))
    print('已写入 prices/tokenhub_lang.json')
    return models


if __name__ == '__main__':
    main()
