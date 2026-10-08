#!/usr/bin/env node
// refresh-prices.js v3.18 — 多源价格自动刷新（token-usage-tracker 技能配套）
//
// 用户需求（2026-08-14）：
//   1) 已有模型每天刷新一次；新模型由 token-tracker.js 的 ensureNewModelPricing 立即补录；
//   2) 增加国内人民币价格源，且要有【备份】——国内源 2 个（llmabacus 主 + llm-prices-cn 备）；
//   3) 区分国内外模型：国内模型优先国内源人民币价，国外模型用国外 USD 源定价；
//   4) 所有源都拉取失败时，写 last_refresh_error，供 token-tracker.js 在 toast 提示「价⚠️」。
//
// 数据源（5 个，并行拉取，互不依赖）：
//   国内（人民币）：A. llmabacus.com/api/prices（主，每日自动核价，含 vendors country/currency）
//                  B. llm-prices-cn GitHub raw（备，llmabacus 的每日镜像）
//   国外（USD）：   C. OpenRouter（接近实时）
//                  D. LiteLLM model_prices_and_context_window.json（社区 PR，1-3 天滞后）
//                  E. Portkey configs.portkey.ai/pricing/<provider>.json（美分/token ×1e4）
//
// 更新规则（按模型 region 区分）：
//   - region=CN（国内模型，默认）：人民币主价 先 A 再 B；两者都无 → 保留本地价
//     （仅当本地原本是 USD 估算价 auto_converted=true 时，才用 USD 中位数×汇率换算兜底）；
//   - region=US（国外模型）：人民币主价 = 三 USD 源中位数 × usd_cny_rate（标 auto_converted）；
//   - USD 参考价（usd_input_price/usd_output_price）：三 USD 源中位数（所有模型都更新）；
//   - region 推断：模型无 region 字段时，用 A 的 vendors country 判断（US→US，其余→CN）；
//   - 峰谷保护：peak_multiplier>1（DeepSeek），源价当「空闲/基准价」，高峰倍率保留本地；
//     若源价与本地价差异 >60% 写入 last_refresh_note 提示人工核验；
//   - 全源失败：写 last_refresh_error（date 不变次日重试），token-tracker toast 提示；
//   - 至少一个源成功：更新 date、清空 last_refresh_error。
//
// 用法：
//   node refresh-prices.js            # 当天首次运行自动刷新（date 非今天才联网）
//   node refresh-prices.js --force    # 强制联网刷新（测试/人工手动更新用）
//   WB_ROOT 环境变量可覆盖 ~/.workbuddy（测试隔离）
//   WB_NO_NET=1 时跳过联网（模拟全源失败路径）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { detectWorkBuddyRoot } = require('./wb-root.js'); // v3.42.0（plan-B B1）：数据根探测单点实现，已抽到 wb-root.js

const WB = process.env.WB_ROOT || detectWorkBuddyRoot();
const PRICING = path.join(WB, 'skills', 'token-usage-tracker', 'pricing.json');
const PRICING_LOCK_FILE = path.join(WB, 'skills', 'token-usage-tracker', '.pricing.lock'); // 修复6：pricing 并发写锁（与 token-tracker.js 共用）
const DS_OFFICIAL = process.env.DS_OFFICIAL || path.join(__dirname, 'deepseek-official.js'); // 可覆盖（测试/镜像）
const TIMEOUT_MS = 12000;
// v3.37.0（L1'）：**大载荷源的单独超时预算**。
// 背景：`litellm` 的 model_prices_and_context_window.json 实测 3,003 KB，是其余四个源
// （88KB / 62KB / 756KB / 2KB）的 4~34 倍，而 TIMEOUT_MS 罩住的是「DNS+TLS+响应头+**整段
// body 下载**+JSON 解析」——3MB 的下载时间才是大头。
// 实测 5 轮（凌晨空闲时段）：0.74 / 1.39 / 0.74 / 5.51 / 3.14 s，**波动 7.5×**；
// 历史 6 次真实刷新里 litellm 有 4 次失败，其中 3 次错误是 `This operation was aborted`
// （= 我们自己的 12s 超时器触发，不是源不可达）。晚间拥塞时段 12s 会被轻松突破。
// 30s 相对实测最慢值留约 5× 余量；总耗时仍远低于 token-tracker.js 侧
// REFRESH_TIMEOUT_MS=180000 的整进程上限（五源是 Promise.all 并行，只取最慢那个）。
const BIG_SOURCE_TIMEOUT_MS = 30000;
const DEFAULT_RATE = 7.2; // v3.32.0（P1-3）：USD→CNY 兜底汇率的**单一真源**，token-tracker.js 新模型补录兜底处引用本导出（selftest T21-d 断言两侧一致）
const FORCE = process.argv.includes('--force');
const NO_NET = process.env.WB_NO_NET === '1';

const SOURCES = {
  llma: { name: 'llmabacus(国内·人民币·主)', url: 'https://www.llmabacus.com/api/prices' },
  llc: { name: 'llm-prices-cn(国内·人民币·备)', url: 'https://raw.githubusercontent.com/szp2005/llm-prices-cn/main/prices.json' },
  or: { name: 'openrouter(USD)', url: 'https://openrouter.ai/api/v1/models' },
  // v3.37.0（L1'）：唯一的大载荷源 → 给它单独的超时预算（理由见 BIG_SOURCE_TIMEOUT_MS 注释）
  litellm: { name: 'litellm(USD)', url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', timeoutMs: BIG_SOURCE_TIMEOUT_MS },
  portkey: { name: 'portkey(USD)', url: 'https://configs.portkey.ai/pricing/deepseek.json' },
};

// 本地 pricing.json 的 key → llm-prices-cn / llmabacus 的 id（归一化匹配兜不住的特殊映射）
const SRC_ID_MAP = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v3-0324': 'deepseek-v3-2-legacy',
  'deepseek-v3-1': 'deepseek-v3-2-legacy',
  'deepseek-r1-0528': 'deepseek-r1',
  'glm-5.2': 'glm-5-2',
  'glm-5.1': 'glm-5-1',
  'glm-5': 'glm-5',
  'glm-4.7': 'glm-4-7',
  'kimi-k3': 'kimi-k3',
  'kimi-k3-1': 'kimi-k3',
  'kimi-k2.6': 'kimi-k2-6',
  'minimax-m3': 'minimax-m3',
  'minimax-m2.7': 'minimax-m2-7',
  'hy3': 'hunyuan-hy3',
  'hy3-preview': 'hunyuan-hy3',
};

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
} // v2.39：本地日期（与 token-tracker.js 一致，避免 UTC+8 凌晨错位）

function load() {
  try { return JSON.parse(fs.readFileSync(PRICING, 'utf-8')); }
  catch (e) {
    // v3.18.1（N3）：文件缺失（含损坏被备份改名后）→ 从空库起步重建（DeepSeek 官方抓取器先建底，
    // 聚合源再合并）。损坏文件原地存在时仍 throw 拒绝处理（M7 守卫语义不变）。
    if (e.code === 'ENOENT') return { models: {} };
    throw new Error(`pricing.json 读取失败: ${e.message}`);
  }
}

// 独立文件锁（与 token-tracker.js 的 withFileLock 完全同构：原子 openSync 'wx' + pid 存活探测 + TTL 兜底）。
// 返回 true=获取成功并已在 finally 中释放；false=获取失败（调用方应跳过写，避免覆盖）。
// v2.68（锁逻辑同步）：抢占规则与 token-tracker.js 的 withFileLock 保持一致——
//   1) 锁不存在 → 创建并持有；
//   2) 能解析出 pid 且该 pid 仍存活 → **绝不抢占**，返回 false 让上层重试；
//   3) pid 已死 → 立即接管（不看 TTL，快速自愈）；
//   4) 解析不出 pid（锁文件为空/损坏）→ 退化为按 TTL 判定，超时后才接管。
// 旧逻辑只看"锁是否超过 TTL"就抢，会把仍在工作（只是慢）的持有者的锁抢走，
// 导致两个进程同时认为自己持锁 → pricing.json 并发写 → 丢模型价格。
// 死锁防护：重试有上限（retries×retryDelay = 5s），到点返回 false 而非无限等待。
function syncSleepMs(ms) { // v2.82.3：真睡眠替代 while 空转（Atomics.wait 零依赖不烧 CPU；异常降级空转）
  const ia = _SLEEP_IA;
  try { Atomics.wait(ia, 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) {} }
}
const _SLEEP_SAB = new SharedArrayBuffer(4);
const _SLEEP_IA = new Int32Array(_SLEEP_SAB);

function withPricingLock(fn) {
  const ttl = 300000; // v2.68：30s → 300s（只用于"解析不出 pid"的退化分支）
  const retries = 50;
  const retryDelay = 100;
  const myPid = process.pid;
  const tryCreate = () => {
    try {
      const fd = fs.openSync(PRICING_LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: myPid }));
      fs.closeSync(fd);
      return true;
    } catch (e) { return false; }
  };
  const pidAlive = (pid) => {
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (e2) { if (e2.code === 'ESRCH') alive = false; else if (e2.code === 'EPERM') alive = true; else alive = true; }
    return alive;
  };
  const acquire = () => {
    try { fs.mkdirSync(path.dirname(PRICING_LOCK_FILE), { recursive: true }); } catch (e) {} // silent-ok:清理 — 建价库锁目录；真失败会在随后的建锁处报错
    // 1) 锁不存在 → 创建
    if (tryCreate()) return true;
    let mine = null;
    try { mine = JSON.parse(fs.readFileSync(PRICING_LOCK_FILE, 'utf-8')); } catch (e) { mine = null; }
    const pid = mine && Number(mine.pid);
    if (pid && pid > 0 && Number.isFinite(pid)) {
      // 2)(3) 有 pid → 只认存活与否，与 TTL 无关
      if (pidAlive(pid)) return false;     // 持有者还活着 → 不抢
      // 持有者已死 → 落到下面统一接管
    } else {
      // 4) 解析不出 pid → 退化为 TTL 判定，未超时则保守等待
      const fresh = mine && (Date.now() - (mine.at || 0) < ttl);
      if (fresh) return false;
    }
    try { fs.unlinkSync(PRICING_LOCK_FILE); } catch (e2) {}
    return tryCreate();
  };
  let got = false;
  for (let i = 0; i < retries; i++) {
    got = acquire();
    if (got) break;
    syncSleepMs(retryDelay); // v2.82.3：真睡眠（原 while 空转烧 CPU）
  }
  if (!got) return false;
  try { fn(); return true; }
  finally {
    try {
      const o = JSON.parse(fs.readFileSync(PRICING_LOCK_FILE, 'utf-8'));
      if (o && o.pid === myPid) fs.unlinkSync(PRICING_LOCK_FILE);
    } catch (e2) {}
  }
}

// v3.24（F2·缺陷4）：锁内「逐 key 归并写」——修复 12 秒抓取窗口造成的 lost update。
// 背景：main() 在 load() 之后要联网抓 5 个源（约 12 秒），期间 token-tracker.js 的
// addModelPrice 可能已正确持锁写入新模型；旧版最后用整份内存 pricing 覆盖写盘，
// 会把抓取期间新增/更新的条目整体抹掉（不是竞态，是设计层面的 lost update）。
// 归并规则（保守优先，只覆盖本次真正改动过的 key）：
//   ① 磁盘现值打底：本次刷新**未改动**的 key 一律保留磁盘现值（含窗口期外部新增/更新）；
//   ② 内存值覆盖：仅覆盖 changedKeys（本次刷新实际写入过的 key）；
//   ③ 清理删除的 key（deletedKeys）不复活；
//   ④ 磁盘读不到（缺失/损坏）→ 退化为整份写（与旧行为一致）。
// 注：changedKeys/deletedKeys 均来自 main() 的实测快照比对与清理清单，不依赖人肉维护。
function mergeWithDisk(p, changedKeys, deletedKeys) {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); }
  catch (e) { return p; } // 读不到现值 → 不做归并（保持原整份写语义）
  const diskModels = (disk && disk.models && typeof disk.models === 'object') ? disk.models : null;
  if (!diskModels) return p;
  const memModels = (p.models && typeof p.models === 'object') ? p.models : {};
  const changed = changedKeys instanceof Set ? changedKeys : new Set(changedKeys || []);
  const deleted = deletedKeys instanceof Set ? deletedKeys : new Set(deletedKeys || []);
  const merged = {};
  for (const k of Object.keys(diskModels)) {           // ①
    if (deleted.has(k)) continue;                      //   ③
    if (changed.has(k)) continue;                      //   ② 稍后用内存值覆盖
    merged[k] = diskModels[k];
  }
  for (const k of changed) { if (memModels[k]) merged[k] = memModels[k]; } // ②
  for (const k of Object.keys(memModels)) {            // ④ 防御：内存有但磁盘无且未删除
    if (!(k in merged) && !deleted.has(k)) merged[k] = memModels[k];
  }
  p.models = merged;
  return p;
}

// v3.24（F2·缺陷3）：返回值语义明确化——false = 抢锁超时，本次**未落盘**（不是"写成功"）。
// 调用方必须检查返回值：真实生产事故里 save() 只打一行 stderr，进程照样跑完全流程
// （date 不更新 → 次日才重试），刷新被静默丢弃。
// opts 为可选写盘模式参数：
//   - { changedKeys, deletedKeys } → 锁内逐 key 归并写（缺陷4，正常刷新路径）；
//   - { errorOnly: true }          → 锁内以磁盘现值为基准，只贴错误标记（缺陷4 全源失败路径补漏）；
//   - 不传                          → 整份写（向后兼容旧行为）。
function save(p, opts) {
  delete p._shrink_note; // v3.18.3（F1）：成功全量刷新后清除「⚠价库缩水」标记
  // 修复6 + 修复9：临时文件 + rename 原子写，加锁避免与 addModelPrice 并发覆盖
  const ok = withPricingLock(() => {
    if (opts && opts.errorOnly) {
      // v3.24（F2·缺陷4 补漏）：全源失败路径同样不得整份覆盖——pricing 是 12 秒抓取窗口**之前**
      // load() 来的快照，若整份写会抹掉窗口期内 token-tracker.js addModelPrice 新增/更新的模型
      // （该模型随即变「未收录」，下轮计费显示「费用未收录」）。断网时每次刷新都走这条路，不可接受。
      // 处理：以锁内磁盘现值为基准，只贴 last_refresh_error/at 并清除 _shrink_note，其余一律保留。
      // 注意：磁盘上的 date 本来就未被本路径改动，故「date 不变、次日重试」的更严格语义自动成立；
      //       不新增任何落盘字段。
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(PRICING, 'utf-8')); } catch (e) { disk = null; }
      if (disk && typeof disk === 'object' && !Array.isArray(disk)) {
        delete disk._shrink_note;
        disk.last_refresh_error = p.last_refresh_error;
        disk.last_refresh_error_at = p.last_refresh_error_at;
        p = disk;
      }
      // 读不到磁盘（缺失/损坏）→ 退化为整份写（此时磁盘本身异常，用内存快照重建可接受）
    } else if (opts && (opts.changedKeys || opts.deletedKeys)) {
      // v3.24（F2·缺陷4）：锁内重读磁盘并逐 key 归并（必须在锁内，否则归并读与 rename 之间仍有窗口）
      p = mergeWithDisk(p, opts.changedKeys, opts.deletedKeys);
    }
    // v3.31.0（P1-13）：写盘前把**当前** pricing.json 复制成唯一一份 `.pricing.json.bak`
    // （对比：账本 saveDailyUsageRaw、水位线 saveLedgerWatermark 都有备份，唯独价库没有——
    //  唯一的回滚点是"上次成功抓取的内存快照"，下次刷新即被覆盖）。
    // · 只保留**一份**、不带日期：回滚只需要"上一版"，滚动备份会无限增长（滚雪球）。
    // · 备份失败**绝不阻断主流程**（备份是兜底，主流程是更新价库）→ 整段 try/catch，只 stderr。
    // · errorOnly 路径不备份：那条路径只贴错误标记、不动价格，没有可回滚的内容。
    // · 已知边界：deepseek-official.js 在本脚本之前已写过一次 pricing.json（官方价对齐），
    //   故本备份是"官方价已合并、聚合源未合并"的中间态；官方抓取失败/断网时它才是刷新前原值。
    //   要修得彻底需把官方抓取也纳入同一份备份，代价是再复制一份跨进程锁实现（见 P1-14 取舍）。
    if (!(opts && opts.errorOnly)) {
      try {
        if (fs.existsSync(PRICING)) fs.copyFileSync(PRICING, PRICING + '.bak');
      } catch (e) {
        process.stderr.write(`[refresh-prices] ⚠pricing.json 备份(.bak)失败（不阻断本次刷新）: ${e.message}\n`);
      }
    }
    const tmp = PRICING + '.tmp';
    try {
      fs.mkdirSync(path.dirname(PRICING), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
      fs.renameSync(tmp, PRICING);
    } catch (e) {
      // 写失败：清理临时文件，原 pricing.json 未被触碰（rename 只在写成功后执行）
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  });
  if (!ok) process.stderr.write('[refresh-prices] 价格写入跳过（被其他进程持锁）\n');
  return ok;
}

// 名称归一化：小写 + 去所有非字母数字（glm-5-2 → glm52；glm5.2 → glm52）
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// v3.24（F2·缺陷1）：免费变体识别。OpenRouter 等源里零价模型的 id 形如
//   `vendor/model:free`（最常见）或 `xxx-free`；这类变体的报价恒为 0，一旦被精确命中，
//   主价会被刷成 `input_price: 0`（¥0 计费且无任何标记），因此解析阶段直接跳过、不参与定价。
// 注意：这里只跳"明确的免费变体后缀"，**不做 0 价一刀切** —— 部分源用 0 表示"未提供价格"，
// 那种情况由 median()/各解析器的 `> 0` 下界统一过滤（见缺陷1 的另一半修改）。
function isFreeVariant(id) {
  const s = String(id || '').toLowerCase();
  return s.endsWith(':free') || s.endsWith('-free');
}

// v3.37.0（L1'）：`timeoutMs` 参数——默认沿用全局 TIMEOUT_MS，大载荷源由 SOURCES 显式指定更大的值。
async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'token-usage-tracker/3.18 (WorkBuddy skill)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // v3.18（M6）：响应零校验修复——上游返回 `{}`/数组/改 schema 时旧版静默产出空索引
    // 且仍被计为"源成功"。这里至少保证顶层是对象。
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('响应不是 JSON 对象');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

function median(arr) {
  // v3.24（F2·缺陷1）：价格合法性下界 `>= 0` → `> 0`。0 既可能是 `:free` 变体的真实报价，
  // 也可能是源"未提供价格"的哨兵值；两者混在一起会让中位数算成 0 → 主价被写成 ¥0 且无告警。
  // 统一按「仅 > 0 视为有效报价」处理：0/负数/NaN/Infinity 一律丢弃；全被丢弃时返回 null，
  // 上层据此保留本地价（不覆盖），宁可保留旧价也不写错价。
  const v = arr.filter((x) => typeof x === 'number' && isFinite(x) && x > 0);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ===== 源 A：llmabacus（国内主源，人民币；含 vendors country/currency） =====
function parseLlma(j) {
  const vendors = {};
  for (const v of (j.vendors || [])) vendors[v.id] = { country: v.country, currency: v.currency };
  const models = {};
  for (const m of (j.models || [])) {
    // v3.24（F2·缺陷1）：跳过 `:free`/`-free` 免费变体（报价恒为 0，精确命中会把主价刷成 ¥0）
    if (isFreeVariant(m.id)) continue;
    const inP = Number(m.inputPrice), outP = Number(m.outputPrice);
    if (!(inP > 0 && outP > 0)) continue;
    const cached = m.cachedInputPrice != null ? Number(m.cachedInputPrice) : null;
    models[m.id] = {
      in: inP, out: outP, cached,
      vendorId: m.vendorId,
      country: (vendors[m.vendorId] || {}).country || null,
      currency: (vendors[m.vendorId] || {}).currency || null,
    };
  }
  return models;
}

// ===== 源 B：llm-prices-cn（国内备份源，人民币） =====
function parseLlc(j) {
  const out = {};
  for (const m of (j.models || [])) {
    // v3.24（F2·缺陷1）：跳过 `:free`/`-free` 免费变体
    if (isFreeVariant(m.id)) continue;
    const inP = Number(m.input_price_cny_per_m);
    const outP = Number(m.output_price_cny_per_m);
    if (!(inP > 0 && outP > 0)) continue;
    const cached = m.cached_input_price_cny_per_m != null ? Number(m.cached_input_price_cny_per_m) : null;
    out[m.id] = { in: inP, out: outP, cached };
  }
  return out;
}

// ===== 源 C：OpenRouter（USD/token → USD/1M） =====
// v3.24（F2·A-4c）：新增 cacheUsd 维度。OpenRouter 的模型对象里缓存命中价是
// `pricing.input_cache_read`（单位 USD/token，与 prompt/completion 同单位）→ ×1e6 换算为 USD/1M。
// 实测（2026-10-02 抓取）：464 个模型中 304 个带该字段。未提供时为 null（由 median 丢弃）。
function parseOr(j) {
  const out = {};
  for (const m of (j.data || [])) {
    // v3.24（F2·缺陷1）：OpenRouter 的 `:free` 变体是零价重灾区，解析阶段直接跳过
    if (isFreeVariant(m && m.id)) continue;
    const pr = (m && m.pricing) || {};
    const pIn = Number(pr.prompt), pOut = Number(pr.completion);
    if (!(pIn > 0 && pOut > 0)) continue;
    const cRaw = pr.input_cache_read != null ? Number(pr.input_cache_read) : NaN;
    out[m.id] = { usdIn: pIn * 1e6, usdOut: pOut * 1e6, cacheUsd: isFinite(cRaw) ? cRaw * 1e6 : null };
  }
  return out;
}

// ===== 源 D：LiteLLM（USD/token → USD/1M） =====
// v3.24（F2·A-4c）：新增 cacheUsd 维度——LiteLLM 字段名 `cache_read_input_token_cost`
// （USD/token，与 input_cost_per_token 同单位）→ ×1e6 换算为 USD/1M。
// 实测：4453 条目中 1700 条带该字段（只取基础档，忽略 *_above_200k 等分档变体）。
function parseLitellm(j) {
  const out = {};
  for (const key of Object.keys(j)) {
    const m = j[key];
    if (!m || typeof m !== 'object') continue;
    // v3.24（F2·缺陷1）：跳过 `:free`/`-free` 免费变体
    if (isFreeVariant(key)) continue;
    const pIn = Number(m.input_cost_per_token);
    const pOut = Number(m.output_cost_per_token);
    if (!(pIn > 0 && pOut > 0)) continue;
    const cRaw = m.cache_read_input_token_cost != null ? Number(m.cache_read_input_token_cost) : NaN;
    out[key] = { usdIn: pIn * 1e6, usdOut: pOut * 1e6, cacheUsd: isFinite(cRaw) ? cRaw * 1e6 : null };
  }
  return out;
}

// ===== 源 E：Portkey（美分/token → ×1e4 = USD/1M） =====
// v3.24（F2·A-4c）：新增 cacheUsd 维度——Portkey 缓存命中价在 pay_as_you_go 下的
// `cache_read_input_token.price`，与 request_token/response_token **同一层级、同一单位**
// （美分/token），故沿用既有 ×1e4 换算得到 USD/1M。实测：5 个条目中 4 个带该字段
// （deepseek-chat/reasoner/v4-flash/v4-pro；default 无）。
function parsePortkey(j) {
  const out = {};
  for (const key of Object.keys(j)) {
    const m = j[key];
    if (!m || typeof m !== 'object') continue;
    // v3.24（F2·缺陷1）：跳过 `:free`/`-free` 免费变体
    if (isFreeVariant(key)) continue;
    const cfg = (m.pricing_config && m.pricing_config.pay_as_you_go) || {};
    const rIn = Number(cfg.request_token && cfg.request_token.price);
    const rOut = Number(cfg.response_token && cfg.response_token.price);
    if (!(rIn > 0 && rOut > 0)) continue;
    const cRaw = (cfg.cache_read_input_token && cfg.cache_read_input_token.price) != null
      ? Number(cfg.cache_read_input_token.price) : NaN;
    out[key] = { usdIn: rIn * 1e4, usdOut: rOut * 1e4, cacheUsd: isFinite(cRaw) ? cRaw * 1e4 : null };
  }
  return out;
}

// v3.18（M5）：无界双向子串匹配修复——旧版对全量源索引做 `includes` 且取首个命中，
// 无歧义检测（短 key 极易撞到无关模型，错价还会带上正常来源标签）。现规则：
//   ① 归一化精确相等 → 直接命中；
//   ② 模糊匹配：双方归一化名都 ≥4 字符才参与，收集**全部**命中——
//      唯一命中 → 采用；多个命中但价格一致 → 取首个（无害）；多个命中且价格不同 → 判歧义放弃并告警。
// v3.19.1（N3）：Set 去重——同一模型会在多个 USD 源（openrouter/litellm/portkey…）各回路上各报一次，
// 原数组 push 让真实 last_refresh_note 里同一条出现 2 次（实测 20 条里 10 组重复），纯冗余。
// v3.24（F2·缺陷2）：该 Set 旧版只在 last_refresh_note 里拼进一行文本，**从未落盘**，等于没有消费方
// （下次刷新进程重启即丢）。现在由 main() 在写盘前落成 pricing._ambig_warnings（纯字符串数组，
// 不带时间戳对象，便于 token-tracker.js 或其他脚本直接读取消费）。
const AMBIG_WARNINGS = new Set();
// v3.33.0（A2 治本）：**已 lock 条目**的歧义告警单独归集，不进 `_ambig_warnings`。
//   病根：`m.lock === true` 的模型，主价分支本就整段跳过（CN 分支 812 行 / US 分支 843 行 `lockKept++`），
//   即 **模糊匹配的结果根本没被用上**；但 looseFind 仍把"唯一模糊命中…需人工核验"塞进 `_ambig_warnings`，
//   而该字段被 token-tracker.js 的 priceAuditTag 直接翻成弹窗标签「⚠价核验」→ **常用模型每条弹窗都挂**。
//   这不是"某次误报"，是**永久误报**（lock 不会自己消失，告警也就永不消失）→ 告警疲劳，
//   把 ⚠价核验 对"可修复异常"的警示价值稀释掉。用户原话："明明有价格，为什么又在报价核验？"
//   处置沿用同一文件里 A-7 对 `_retired_locked` 的既有先例（937 行注释：**刻意不进 _price_audit**，
//   改为独立字段 + stderr 留痕）——信息不丢，只是不再驱动弹窗。
const AMBIG_WARNINGS_LOCKED = new Set();
// v3.36.0（P0）：**官方价已命中**的模型，其备用源（国内源 / USD 源）的歧义告警单独归集。
//   病根（用户 2026-10-07 指出）：主循环里 `usdFind`/`cnFind` 在**官方价判定之前**无条件执行，
//   于是已有 DeepSeek 官方价的模型（如 deepseek-v4.1-flash，price_source='deepseek官方'），
//   仍会把「USD源 模糊命中 N 个不同价候选，已放弃」记进 `_ambig_warnings` → 弹窗挂「⚠价核验」。
//   用户原话：「官方价格源已经命中的情况下，后面备用源的那些，刷新到还是没刷新到，都已经是无关紧要的东西了」。
//   处置：官方价命中 → 备用源匹配结果**根本不被采用**（写价走 officialBlk 分支）→ 其歧义不驱动弹窗，
//   但**信息不丢**：落独立字段 `_ambig_warnings_official`，`--doctor` 可见、stderr 留痕。
//   ⚠️ 关键：**只静音告警，绝不改变取到的值** —— usdFind 的返回值仍照常喂
//   `region=US` 的 usd_* 参考字段（:803）与 `auto_converted` 兜底分支（:856），否则会误伤无官方价的模型。
const AMBIG_WARNINGS_OFFICIAL = new Set();
// 本模型此刻是否处于「官方价已命中」状态（由主循环按模型设置/复位）。
//   用模块级开关而非给 looseFind 加参数：调用点（usdFind ×9、cnFind ×2）一行都不用改，改动面最小。
let AMBIG_SILENT = false;
function ambigAdd(msg, locked) {
  if (locked) AMBIG_WARNINGS_LOCKED.add(msg);
  else if (AMBIG_SILENT) AMBIG_WARNINGS_OFFICIAL.add(msg);
  else AMBIG_WARNINGS.add(msg);
}
function looseFind(index, localNorm, kind, forKey, locked) {
  if (!index) return null;
  let hits = [];
  for (const k of Object.keys(index)) {
    const kn = norm(k);
    if (!kn) continue;
    if (kn === localNorm) return index[k];
    if (localNorm.length >= 4 && kn.length >= 4 && (kn.includes(localNorm) || localNorm.includes(kn))) hits.push(k);
  }
  if (!hits.length) return null;
  if (hits.length === 1) {
    // v3.24（F2·缺陷2）：唯一命中 ≠ 可信命中。若命中的源键与被查键「归一化后并不相等」，
    // 说明它是靠子串/边界放宽才撞上的（如 deepseek-v4-flash 撞上 deepseek-v4-flash-vision-exp），
    // 价格很可能属于另一个模型。旧版直接采用且不告警 → 错价静默传播。
    // 处理策略（保守）：仍采用该候选（不放价，避免误伤正常命中的源），但记入 AMBIG_WARNINGS，
    // 由 main() 在写盘时落到 pricing._ambig_warnings，让人工核验时能看见。
    if (norm(hits[0]) !== localNorm) {
      ambigAdd(`${forKey}: ${kind} 唯一模糊命中 ${hits[0]}（与被查键不同名，已采用但需人工核验）`, locked);
    }
    return index[hits[0]];
  }
  const priceSig = (v) => JSON.stringify([v.usdIn != null ? v.usdIn : v.in, v.usdOut != null ? v.usdOut : v.out]);
  const sigs = new Set(hits.map((k) => priceSig(index[k])));
  if (sigs.size === 1) return index[hits[0]];
  ambigAdd(`${forKey}: ${kind} 模糊命中 ${hits.length} 个不同价候选(${hits.slice(0, 3).join(',')})，已放弃`, locked);
  return null;
}

// v3.33.0（A2）：末位 `locked` 由调用方传 `m.lock === true`——已锁条目的匹配结果不会被采用（见上方注释），
//   故其歧义只记入 `_ambig_warnings_locked`（独立字段 + stderr），不再挂弹窗「⚠价核验」。
function usdFind(usdIndex, localKey, orId, localNorm, locked) {
  if (!usdIndex) return null;
  if (usdIndex[localKey]) return usdIndex[localKey];
  if (orId && usdIndex[orId]) return usdIndex[orId];
  return looseFind(usdIndex, localNorm, 'USD源', localKey, locked);
}

// 在人民币源索引里找模型：先 srcId（归一化），再精确，再模糊（带歧义防护）
function cnFind(cnIndex, srcId, localNorm, forKey, locked) {
  if (!cnIndex) return null;
  if (srcId && cnIndex[srcId]) return cnIndex[srcId];
  return looseFind(cnIndex, localNorm, '国内源', forKey || localNorm, locked);
}

// v3.24（F2·A-4c）：USD 系（US 模型 + CN 的 auto_converted 估算分支）缓存价写入策略。
// 背景：三个 USD 源解析器旧版都不提取缓存价 → US 模型的 cached_price 只能用「输入价×10%」
// 拍脑袋估算，且一次写入后永不更新（历史事故：hy4-preview 的 cache 被估成翻倍值）。
// 现已从三源提取真实缓存价（cacheUsd，USD/1M tokens 中位数），策略改为：
//   ① 源有真实值 → 用源值×汇率覆盖，并清除估算标记；
//   ② 源无值但本地已有 cached_price → 沿用本地（保持既有行为）；若本地本就是估算的，
//      保留 cached_price_estimated 标记（提示用户这个数还是拍的）；
//   ③ 源无值且本地也没有 → 才退回「输入价×10%」估算，并打 cached_price_estimated: true。
// 返回取值来源：'source' | 'kept' | 'kept-estimated' | 'estimated'（供统计/测试）。
function applyUsdCachedPrice(m, cacheUsd, usdIn, rate) {
  if (cacheUsd != null) {
    m.cached_price = Number((cacheUsd * rate).toFixed(2));
    delete m.cached_price_estimated; // 真实值到位 → 估算标记必须清除，否则标记会撒谎
    return 'source';
  }
  if (m.cached_price != null) return m.cached_price_estimated === true ? 'kept-estimated' : 'kept';
  m.cached_price = Number((usdIn * rate * 0.1).toFixed(2));
  m.cached_price_estimated = true;
  return 'estimated';
}

// v3.24（F2·A-7）：retired + lock 组合 = 永久冻结的错价条目。三处逻辑叠加导致「三不管」：
//   ① 第 ~457 行 `if (m.lock === true || m.alias_of) continue;` → 陈旧清理永久跳过；
//   ② 主价分支 `else if (m.lock === true)` → 主价永久不被覆盖；
//   ③ `retired` 全仓无读取方 → 也不会被标记为「不可用」。
// 结果：该条目永远不会被刷新、不会被删除、也不会被标记不可用，若仍被调用就永久按已下线旧价计费。
// 本函数**只产出告警文案，不改任何 lock/retired 语义**（解除冻结属人工决策）。
function retiredLockWarnings(models) {
  const out = [];
  for (const [key, m] of Object.entries(models || {})) {
    if (!m || typeof m !== 'object') continue;
    if (m.retired === true && m.lock === true) {
      out.push(`${key}: 已标记 retired 但 lock=true，价格永久冻结在 ${m.input_price}/${m.output_price} —— 不会被刷新、不会被清理、也不会被标记不可用；若该模型确已下线请人工核验`);
    }
  }
  return out;
}

// v3.24（F2·A-7）：把 retired+lock 清单落到独立字段 `_retired_locked`（纯字符串数组，与 _ambig_warnings 同构）。
// **刻意不进 _price_audit**：retired+lock 是 TROUBLESHOOTING.md 白纸黑字记载的**设计行为**
//（已下线模型按旧价计费），我们刻意未解除 lock；它永远无法被用户消除，若挂上弹窗就是永久噪音，
// 会稀释 ⚠价核验 对「可修复异常」的警示价值（与 D-10「exit 2 让 CI 常红 → 被习惯性忽略」同一失败模式）。
// 故只做「落盘留痕 + stderr 告警」，不进 _price_audit。返回告警数组供调用方打印。
function applyRetiredLocked(pricing, models) {
  const w = retiredLockWarnings(models);
  if (w.length) pricing._retired_locked = w;
  else delete pricing._retired_locked;
  return w;
}

// ===== v3.31.0（P0-5 / P1-7）：价格落盘前 sanity check =====
// 背景（审计 §六 核心洞察）：本机缓存命中率 ~97%，**金额 ≈ 缓存价 × 缓存量** → pricing.json 一旦
// 写入错价，toast / daily-usage.json / --report / --csv 全线同向错误且**无任何提示**；
// 更糟的是写入后 `date` 被更新 → 当天不再重试 → 错价至少驻留 24h。
//
// 设计原则（宁可漏报，绝不误杀：误杀 = 正常刷新被拒 = 价库停滞 = 比错价更大的问题）：
//   ① 只拦**数量级 / 骤变**级异常（超出合理区间，或相对旧值 ≥3× 骤变），常规波动一律放行；
//   ② 任何拦截 = 保留旧值 + 可见告警（stderr 一行 + pricing._price_audit.warnings）；
//   ③ 告警文本必须是 `<价库键>: 说明` 形状 —— token-tracker.js:3732 的 warnMentionsModel 取
//      冒号前一段与本轮模型名做宽松匹配；写成别的形状要么污染全部弹窗、要么永远不显示。
//   ④ 绝不把已有值回退成 null —— calcCost 里 `(m.cached_price || 0)` 会让 null 按 0 计，
//      那比错价更隐蔽（P1-7 正是这个失败模式）。
const PRICE_SANITY = {
  min: 0.0005,  // 元/百万 token 下界（本机实测最低缓存价 0.02，向下留两个数量级余量）
  max: 5000,    // 上界（本机实测最高输出价 100）；只用来拦「单位改成 元/千 token」这类整段错位
  abortAt: 3,   // 相对旧值 ≥3× 或 ≤1/3 → 判异常，保留旧值（真调价极少一步 3 倍）
  warnAt: 1.5,  // 相对旧值 ≥50% → 只告警不阻断（真调价属正常，不能把价库冻住）
};
const PRICE_FIELD_LABEL = { input_price: '输入价', output_price: '输出价', cached_price: '缓存命中价' };

// 对单个模型「本次刷新后的值 now」与「刷新前的快照 pre」做体检。
// 返回 { main:boolean, cached:boolean }：main=输入价/输出价异常（整块回退）；cached=仅缓存价异常。
// warnSink 收集告警字符串（形状固定为 `<key>: 说明`）。
function priceGate(key, now, pre, warnSink) {
  const out = { main: false, cached: false };
  const check = (field) => {
    const nv = now[field];
    if (nv == null) return false;                        // 本次没写这个字段 → 不校验
    if (nv === pre[field]) return false;                 // 值没变 → 不校验（存量越界值不该天天报警）
    const label = PRICE_FIELD_LABEL[field];
    // v3.40.0（plan-B A9）：**0 是合法值，不是"抓取值非法"**。
    //   病根：原判据 `nv <= 0`（现改为 `< 0`）把 0 判非法并推 warning，而 KI-7 明确写
    //   「0 = 厂商未公布价，是合法常态」（pricing_status:'unpublished'，见 token-tracker.js
    //   rememberNoPublicPrice）。两个模块对同一个 0 的语义定义**相反**，且共用 `_price_audit.warnings`
    //   这一个字段 → `space-bunny` 这类未公布价模型**每次刷新都被判非法**（既然 0→0 但 nv===pre[field]
    //   会提前 return，实际触发点是"从有价变无价"或"首次写入 0"）→ 真告警被这个噪音淹没。
    //   现在：负数 / NaN / Infinity 仍是非法（真异常）；0 放行（合法常态）。
    if (typeof nv !== 'number' || !isFinite(nv) || nv < 0) {
      warnSink.push(`${key}: ${label}抓取值非法(${nv})，已保留旧值`);
      return true;
    }
    if (nv === 0) {
      // 0 = 厂商未公布价（合法）→ 不告警，但要越过下面的"合理区间"与"骤变"校验
      //   （0 必然低于 min=0.001，不特判会每条未公布价模型都刷一条"超出合理区间"）。
      return false;
    }
    if (nv < PRICE_SANITY.min || nv > PRICE_SANITY.max) {
      warnSink.push(`${key}: ${label}${nv} 元/百万token 超出合理区间[${PRICE_SANITY.min}, ${PRICE_SANITY.max}]（上游单位可能已变更，如改成「元/千 token」），已保留旧值`);
      return true;
    }
    const ov = pre[field];
    if (typeof ov === 'number' && isFinite(ov) && ov > 0) {
      const r = nv / ov;
      if (r >= PRICE_SANITY.abortAt || r <= 1 / PRICE_SANITY.abortAt) {
        warnSink.push(`${key}: ${label}由 ${ov} 骤变至 ${nv}（×${r.toFixed(2)}，超 ${PRICE_SANITY.abortAt}× 阈值），已保留旧值待人工核验`);
        return true;
      }
      if (r >= PRICE_SANITY.warnAt || r <= 1 / PRICE_SANITY.warnAt) {
        warnSink.push(`${key}: ${label}由 ${ov} 变动至 ${nv}（×${r.toFixed(2)}，变动超 50%），请人工核验`);
      }
    }
    return false;
  };
  const bi = check('input_price');
  const bo = check('output_price');
  out.main = bi || bo;                                   // 主价任一异常 → 整块回退（半新半旧更危险）
  out.cached = check('cached_price');
  // 交叉校验：缓存命中价必须 ≤ 输入价（缓存是折扣价）。命中此条几乎总是**列错位**
  // （输入价与缓存价取串了）——正是 §六 点名的、影响 45%~86% 金额的最高风险形态。
  const effIn = out.main ? pre.input_price : now.input_price;
  const effCa = out.cached ? pre.cached_price : now.cached_price;
  if (typeof effIn === 'number' && effIn > 0 && typeof effCa === 'number' && effCa > effIn) {
    warnSink.push(`${key}: 缓存命中价 ${effCa} 高于输入价 ${effIn}（缓存应是折扣价），疑似列错位/单位错误，请人工核验`);
    // 有旧值才回退；无旧值时保留新值（回退成 null 会被 calcCost 按 0 计，比错价更隐蔽）
    if (pre.cached_price != null) out.cached = true;
  }
  return out;
}

// 整块回退到快照（含分支里被删/新增的字段：先删多出来的，再赋值）
function restoreBlock(m, snap) {
  for (const k of Object.keys(m)) if (!(k in snap)) delete m[k];
  Object.assign(m, snap);
}
// 只回退缓存价（连同「是否估算」标记一起还原，避免标记与值互相撒谎）
function restoreCached(m, snap) {
  if (snap.cached_price === undefined) delete m.cached_price; else m.cached_price = snap.cached_price;
  if (snap.cached_price_estimated === undefined) delete m.cached_price_estimated; else m.cached_price_estimated = snap.cached_price_estimated;
}

// v3.18（M6）：解析器注册表——拉取后立即解析并校验"解析出 >0 个模型"，
// 上游 schema 变更/返回空体不再被计为"源成功"。
const PARSERS = { llma: parseLlma, llc: parseLlc, or: parseOr, litellm: parseLitellm, portkey: parsePortkey };

async function main() {
  // DeepSeek 官方定价抓取（v2.59，2026-08-23）放在 load() 之前：
  // deepseek-official.js 会先写 pricing.json（模型清单对齐：新增官方模型/标记已下线 retired/更新官方价），
  // 之后 load() 拿到的就是官方对齐后的数据，refresh 循环在此基础上做聚合源兜底。
  // 失败不中断：官方抓不到 → 回落聚合源，仅记 deepseek_refresh_error。
  let officialOk = false;
  let official = null; // { official: {模型:{input_price,cached_price,output_price,peak_multiplier}}, weekend_off_peak }
  if (!NO_NET) {
    try {
      // v3.36.0（测试钩子）：DS_OFFICIAL_JSON 指向一份已抓好的官方价 JSON 时直接读取，
      //   跳过 spawnSync。**仅用于测试**：沙箱里 node spawn node 恒 EBUSY，
      //   导致 officialOk 永远为 false，A 路径（官方价命中）无法端到端复现。
      //   生产路径不受影响（该环境变量不设置时行为与旧版逐字节一致）。
      let sp;
      if (process.env.DS_OFFICIAL_JSON) {
        const fs = require('fs');
        const raw = fs.readFileSync(process.env.DS_OFFICIAL_JSON, 'utf-8');
        sp = { status: 0, stdout: raw, stderr: '' };
      } else {
        sp = spawnSync(process.execPath, [DS_OFFICIAL], {
          encoding: 'utf-8',
          timeout: 120000, // 含重试（2 次 × 60s）
          env: { ...process.env, DS_RETRIES: '0' }, // 本次外部已整体由 refresh 控制节奏，子进程不再追加重试，避免重复 60s
        });
      }
      if (sp.status === 0) {
        const j = JSON.parse(sp.stdout);
        if (j.ok && j.official) {
          official = j;
          officialOk = true;
        }
      } else {
        // v3.18：sp.stderr 可能为 null（spawn 本身失败，如 EBUSY/ENOENT），先兜底空串
        const reason = (((sp.stderr || '') + '').match(/FAIL_REASON=([^\n]+)/) || [])[1] || String(sp.stderr || '').trim().slice(0, 200) || (sp.error && sp.error.code) || '未知';
        process.stderr.write(`[refresh-prices] DeepSeek 官方定价抓取失败（回落聚合源）: ${reason}\n`);
      }
    } catch (e) {
      process.stderr.write(`[refresh-prices] DeepSeek 官方抓取器执行异常（回落聚合源）: ${e.message}\n`);
    }
  }

  let pricing;
  try { pricing = load(); }
  catch (e) { process.stderr.write(`[refresh-prices] ${e.message}\n`); process.exit(1); }

  const today = todayStr();
  if (!FORCE && pricing.date === today) {
    console.log(`[refresh-prices] 今天(${today})已刷新过，跳过联网（--force 强制刷新）`);
    return;
  }

  // 并行拉 5 源（v3.18/M6：拉取后立刻解析+校验，解析失败/零模型 = 源失败）
  const results = NO_NET
    ? Object.fromEntries(Object.keys(SOURCES).map((k) => [k, { ok: false, err: 'WB_NO_NET=1' }]))
    : await Promise.all(Object.entries(SOURCES).map(async ([k, s]) => {
        try {
          const j = await fetchJson(s.url, s.timeoutMs);
          const parsed = PARSERS[k](j);
          const n = Object.keys(parsed || {}).length;
          if (!n) throw new Error('解析出 0 个模型（上游 schema 可能已变更）');
          return { ok: true, data: parsed };
        }
        catch (e) { return { ok: false, err: e.message }; }
      })).then((arr) => {
        const o = {};
        Object.keys(SOURCES).forEach((k, i) => { o[k] = arr[i]; });
        return o;
      });

  const okCount = Object.values(results).filter((r) => r.ok).length;
  const cnOk = (results.llma.ok || results.llc.ok);
  const usdOk = (results.or.ok || results.litellm.ok || results.portkey.ok);

  // 全源失败 → 写错误标记，date 不变（次日重试），token-tracker 会 toast 提示
  if (okCount === 0) {
    const errMsg = Object.entries(results).map(([k, r]) => `${SOURCES[k].name}: ${r.err || '?'}`).join('；');
    pricing.last_refresh_error = `所有价格源拉取失败（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）：${errMsg}`;
    pricing.last_refresh_error_at = new Date().toISOString();
    // v3.24（F2·缺陷3）：同样接收返回值——抢锁超时时错误标记也没落盘，必须让退出码/日志可见，
    // 否则「全源失败」这个事实会被静默吞掉。此处本就以非零码退出，退出码沿用原有语义。
    // v3.24（F2·缺陷4 补漏）：传 errorOnly，禁止用窗口期前的内存快照整份覆盖（会抹掉窗口内新增模型）。
    let errSaved = false;
    try { errSaved = save(pricing, { errorOnly: true }); } catch (e) { process.stderr.write(`[refresh-prices] 写入失败: ${e.message}\n`); process.exit(1); }
    if (!errSaved) process.stderr.write('[refresh-prices] 价库写入失败：抢锁超时（可能有其他进程正在刷新），本次刷新未落盘\n');
    process.stderr.write(`[refresh-prices] 全部 ${Object.keys(SOURCES).length} 个价格源拉取失败，已写 last_refresh_error（费用按上次价格估算）\n`);
    process.exit(1);
  }

  // 解析各源（v3.18/M6：main 拉取阶段已完成解析与校验，这里只取结果）
  const llma = results.llma.ok ? results.llma.data : null;
  const llc = results.llc.ok ? results.llc.data : null;
  const or = results.or.ok ? results.or.data : null;
  const litellm = results.litellm.ok ? results.litellm.data : null;
  const portkey = results.portkey.ok ? results.portkey.data : null;
  const usdSources = [or, litellm, portkey].filter(Boolean);

  const rate = Number(pricing.usd_cny_rate) > 0 ? pricing.usd_cny_rate : DEFAULT_RATE;
  const models = pricing.models || {};

  // v2.65：清理超过 14 天未使用的模型，防止 pricing.json 无限膨胀。
  // 删除不影响历史账本：daily-usage.json 独立存储，不依赖 pricing.models 里条目。
  const cleanedKeys = new Set(); // v3.24（F2·缺陷4）：本次清理删除的 key（供锁内归并写排除，避免复活）
  {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    let daily = {};
    try {
      const dPath = path.join(WB, 'skills', 'token-usage-tracker', 'daily-usage.json');
      daily = JSON.parse(fs.readFileSync(dPath, 'utf-8'));
    } catch (e) { daily = {}; }
    const lastUsed = {};   // 精确模型名 → 最后使用日期
    const normUsed = {};   // 归一化名 → 最后使用日期（兼容 daily-usage 与 pricing 命名不一致）
    for (const [date, v] of Object.entries(daily)) {
      if (date === '_instructions' || !v || typeof v !== 'object') continue;
      const mods = v.models || {};
      for (const mk of Object.keys(mods)) {
        if (lastUsed[mk] == null || date > lastUsed[mk]) lastUsed[mk] = date;
        const nk = norm(mk);
        if (nk && (normUsed[nk] == null || date > normUsed[nk])) normUsed[nk] = date;
      }
    }
    // v2.82（2026-09-01）修复：原代码写 `if (lu == null || lu < cutoffStr)`，与上方注释
    // 「从未出现在 daily-usage 的一律保留」完全相反 —— lu==null 被无条件删除。
    // 后果：每次刷新都清掉所有不在 daily-usage 里的模型（含人工核验的官方价），
    // pricing.json 从 26~30 个模型被刷到只剩 6 个。正确条件是 lu != null && lu < cutoffStr。
    const keysBefore = Object.keys(models).length;
    let removed = 0;
    const doomed = [];
    for (const key of Object.keys(models)) {
      const m = models[key];
      if (!m || typeof m !== 'object') continue;
      if (m.lock === true || m.alias_of) continue; // 冻结模型 / 官方别名条目 故意保留，不删
      const lu = lastUsed[key] || normUsed[norm(key)];
      // 护栏 A：仅删除「曾出现在 daily-usage 且最后使用超过 14 天」的模型；
      // 从未出现在 daily-usage（lastUsed=none，如新加/手动/未记账模型）一律保留。
      if (lu != null && lu < cutoffStr) doomed.push(key);
    }
    // 护栏 B（v2.82）：反常规模熔断。正常每日清理是个位数；若一次要删掉超过半数
    // 且多于 10 个，判定为逻辑异常（如护栏 A 再次写反 / daily-usage 损坏被清空），
    // 直接放弃本次清理并告警，宁可膨胀也不能把价格库刷空。
    if (doomed.length > 10 && doomed.length > keysBefore * 0.5) {
      console.log(`[refresh-prices] ⚠清理熔断：本次拟删 ${doomed.length}/${keysBefore} 个，超过半数且>10，判定异常，已跳过清理`);
      console.log(`[refresh-prices]   拟删清单（前10）: ${doomed.slice(0, 10).join(', ')}`);
    } else {
      for (const key of doomed) { delete models[key]; removed++; }
      // v3.24（F2·缺陷4）：记录本次清理删除的 key —— 锁内归并写时据此不把已删条目「复活」
      for (const key of doomed) cleanedKeys.add(key);
      if (removed) console.log(`[refresh-prices] 已清理 ${removed} 个超过14天未使用的模型（共 ${keysBefore} 个）`);
    }
  }

  // v3.32.0（P1-1）：unpublishedCleared = 本次补到真价后被清掉的「无公开价」标记数（会在小结里报出来）
  let updatedMain = 0, autoConverted = 0, usdUpdated = 0, regionSet = 0, bigDiff = [], lockKept = 0, unpublishedCleared = 0, lockKeptMain = 0;
  const regionInferred = []; // v3.24（F2·缺陷5）：靠推断（而非天生带 region）得到国内外归属的模型 key
  const sanityWarnings = []; // v3.31.0（P0-5 / P1-7）：价格体检告警（`<key>: 说明` 形状，并入 _price_audit）

  // v3.24（F2·缺陷4）：抓取前对每个模型做 JSON 快照，循环后用快照比对得出「本次真正改动过的 key」，
  // 供 save() 锁内归并时使用（只覆盖改动过的条目，保护抓取窗口内外部新增/更新的模型）。
  const beforeSnap = new Map();
  for (const key of Object.keys(models)) {
    const m = models[key];
    beforeSnap.set(key, m && typeof m === 'object' ? JSON.stringify(m) : null);
  }

  for (const key of Object.keys(models)) {
    const m = models[key];
    if (!m || typeof m !== 'object') continue;
    // v3.36.0：每轮循环开头无条件复位静音开关——防止上一轮的 true 残留到本轮
    //   （模块级变量，若某轮走 continue/异常跳出而漏复位，会把无官方价模型的告警一起静音 = 漏报）。
    AMBIG_SILENT = false;

    const localNorm = norm(key);
    const srcId = SRC_ID_MAP[key] || null;
    // v3.33.0（A2）：lock 条目下面三个写价分支**全部跳过**（CN: 812 / US: 843），匹配结果不被采用
    //   → 其歧义告警只留痕不挂弹窗（避免"永久误报"稀释 ⚠价核验 的警示价值）。
    //   为何还要求 `region !== 'US'`：region=US 的条目**在分支之前**就会把匹配值写进 `usd_*` 参考字段
    //   （见上方 780 行 `if (m.region === 'US' && ...)`），那段写入并**没有** lock 守卫 → 此时匹配结果
    //   确实仍被消费，告警不该静音。判据精确到"匹配结果真的没人用"才静音。
    //   本机实测：17 模型中 6 个 lock 条目，**region 全为 CN**（lock 且 US 的 0 个）；现有 10 条歧义告警里
    //   **6 条挂在 lock 条目上**（含用户日常追踪的 hy4-preview / glm-5.3-flash）→ 正是"常年挂 ⚠价核验"的来源。
    const isLocked = m.lock === true && m.region !== 'US';

    // v3.36.0（P0）：**官方价命中判定提前到源匹配之前**（原在 :824，晚于 usdFind → 造成永久噪音）。
    //   判据与 :824 的 officialBlk **完全一致**（纯读，无副作用），故提前不改变任何取值：
    //     officialOk（官方价抓取成功） && （本 key 在官方清单里 || 别名在官方清单里）
    //   命中即为真 → 下面 11 次源匹配（cnFind ×2 + usdFind ×9）产生的歧义**只留痕不挂弹窗**。
    //   ⚠️ 仅静音告警：匹配照常执行、返回值照常被 :803（region=US 参考字段）与 :856（USD 兜底换算）消费。
    const officialHitPre = !!(officialOk && official
      && (official.official[key] || (m.alias_of ? official.official[m.alias_of] : null)));
    AMBIG_SILENT = officialHitPre;

    const llmaHit = llma ? cnFind(llma, srcId, localNorm, key, isLocked) : null;
    const llcHit = llc ? cnFind(llc, srcId, localNorm, key, isLocked) : null;

    // region 推断：模型无 region 字段时，优先用 llmabacus vendors country（US→US，其余→CN）
    // v3.24（F2·缺陷5）：**判定行为保持不变**（改了会影响计价口径），仅增加可观测性——
    // 把「靠推断得到归属」的模型 key 收集起来，写盘为 pricing._region_inferred，
    // 并在汇总行打印，让用户清楚这些模型的国内/国外归属是猜的、需要人工核验。
    // v3.40.0（plan-B A10）：**推断结果不再永久固化**。
    //   病根：`if (!m.region)` 一旦写入就不再重判 —— 某轮 llmabacus 拉取失败（llmaHit=null）→
    //   真实 US 模型被按默认写死成 CN → 此后**永远**走错计价分支（CN 主价 vs USD×7.2 折算），
    //   且 `region` 字段本身无任何痕迹表明"这是猜的"。
    //   修法：推断出来的 region 同时打 `region_inferred: true`；下轮若仍是推断值，允许**重判**
    //   （llmaHit 到位就纠正）。人工写死 / 官方来源的 region 没有该标记 → 依旧被尊重、绝不重判。
    //   `_region_inferred` 汇总数组的语义不变（仍是"当前靠推断定归属的 key"）。
    const regionWasInferred = m.region_inferred === true;
    if (!m.region || regionWasInferred) {
      const inferred = (llmaHit && llmaHit.country === 'US') ? 'US' : 'CN';
      if (m.region !== inferred) {
        if (regionWasInferred && llmaHit) {
          // 有依据可重判，且结论变了 → 纠正并留痕（旧值写进 _region_corrected 供排查）
          process.stderr.write(`[token-tracker] region 纠正：${key} ${m.region} → ${inferred}（此前为推断值，本轮 llmabacus 有数据）\n`);
          m._region_corrected = { from: m.region, at: new Date().toISOString().slice(0, 10) };
        }
        m.region = inferred;
      }
      // 只有在"没有可靠来源"时才是真正的推断；llmaHit 到位时视为已确认（不再打推断标记）
      if (llmaHit) { delete m.region_inferred; } else { m.region_inferred = true; }
      regionSet++;
      if (!llmaHit) regionInferred.push(key);
    }

    // USD 参考价：三 USD 源中位数
    const usdIn = median(usdSources.map((u) => usdFind(u, key, m.or_id, localNorm, isLocked)?.usdIn));
    const usdOut = median(usdSources.map((u) => usdFind(u, key, m.or_id, localNorm, isLocked)?.usdOut));
    // v3.24（F2·A-4c）：USD 缓存命中价（三源中位数，USD/1M tokens 口径）。无任何源提供时为 null，
    // 交由 applyUsdCachedPrice 决定「沿用本地 / 退回 10% 估算并打标记」。
    const cacheUsd = median(usdSources.map((u) => usdFind(u, key, m.or_id, localNorm, isLocked)?.cacheUsd));
    // v3.18（H3）：usd_* 参考字段只对 region=US 模型写盘——region=CN 的人民币主价是权威口径，
    // 计费从不读 usd_*，留着只会与主价互相矛盾（实测偏差 -78%~+8%）并污染人工对账。
    // CN 模型的 usdIn/usdOut 仍保留在循环变量里，供下方 auto_converted 估算兜底使用。
    if (m.region === 'US' && usdIn != null && usdOut != null) {
      m.usd_input_price = Number(usdIn.toFixed(6));
      m.usd_output_price = Number(usdOut.toFixed(6));
      usdUpdated++;
    }

    // v3.31.0（P0-5 / P1-7）：主价分支**之前**对本模型做一次深拷贝快照（region / usd_* 已写完，
    // 这些是参考字段、不在体检范围内）。分支写完后用 priceGate 比对，异常即整体回退到本快照。
    // 放在这里的好处：三个写价分支（官方价 / 国内源 / USD 换算）共用同一道闸，且分支内部逻辑
    // 一行未改 → 正常路径逐字节不变。
    const preSnap = JSON.parse(JSON.stringify(m));
    const uMain0 = updatedMain, uAuto0 = autoConverted;

    if (m.region === 'CN') {
      // 国内模型：人民币主价优先国内源（llmabacus → llm-prices-cn）
      const cnHit = llmaHit || llcHit;
      // v2.59（2026-08-23）：官方优先——DeepSeek 系模型若官方清单里有，直接用官方价
      //（官方页含空闲/高峰价 + 时段 + 周末低峰规则，聚合源只有高峰价且无周末规则）。
      // 官方没有的 DeepSeek 系（如已下线 V3 系列）→ 回落聚合源。
      // v3.07（2026-09-16）：别名条目（本地 key 与官方 ID 不同名，如 deepseek-v4.1-flash ↔ deepseek-flash）
      // 也必须走官方价——否则会落进下面的聚合源分支，用 llmabacus 价覆盖掉 deepseek-official.js 刚写入的官方价。
      // v3.36.0：复用循环开头提前算好的 officialHitPre（判据完全相同）——避免两处判据各改各的而漂移。
      const officialBlk = officialHitPre ? (official.official[key] || (m.alias_of ? official.official[m.alias_of] : null)) : null;
      // v3.40.0（plan-B A11）：**官方价分支也必须尊重 m.lock**。
      //   病根：原实现 `if (officialBlk) {...} else if (m.lock === true) {...}` —— 官方分支在 lock 之前
      //   且自身无 lock 守卫 → `deepseek-v4-pro`(lock:true) 每轮仍被官方价覆写。
      //   而上游注释（:812）明写"lock 条目下面三个写价分支**全部跳过**"——**契约对官方价不成立**，
      //   文档却按成立来写。这是"人工冻结"语义被静默破坏：用户冻结了价，刷新后价却变了。
      //   判据：region 为 US 的条目走 usd_* 参考字段、主价本就由 US 分支管，这里只拦 CN 主价分支
      //   （与 :819 isLocked 的口径保持一致）。
      const lockBlocksMainPrice = m.lock === true && m.region !== 'US';
      if (officialBlk && lockBlocksMainPrice) {
        // 冻结条目：官方价不覆盖主价，但**仍记录官方价以备人工对比**（不改主价，只留痕）。
        m._official_ref = {
          input_price: officialBlk.input_price, cached_price: officialBlk.cached_price,
          output_price: officialBlk.output_price, peak_multiplier: officialBlk.peak_multiplier || 2,
          at: new Date().toISOString().slice(0, 10),
        };
        lockKeptMain++;
      } else if (officialBlk) {
        m.input_price = officialBlk.input_price;
        m.cached_price = officialBlk.cached_price;
        m.output_price = officialBlk.output_price;
        m.peak_multiplier = officialBlk.peak_multiplier || 2;
        m.price_source = 'deepseek官方';
        delete m.auto_converted;
        delete m.retired;
        delete m.cached_price_estimated; // v3.24（F2·A-4c）：官方真实缓存价到位 → 清估算标记（只清标记，不动价格）
        updatedMain++;
      } else if (m.lock === true) {
        // 跳过人民币主价覆盖，保留本地价 + peak_multiplier
      } else if (cnHit) {
        const oldIn = m.input_price, oldOut = m.output_price;
        m.input_price = cnHit.in;
        m.output_price = cnHit.out;
        if (cnHit.cached != null) {
          m.cached_price = cnHit.cached;
          delete m.cached_price_estimated; // v3.24（F2·A-4c）：国内源真实缓存价到位 → 清估算标记
        }
        m.price_source = llmaHit ? 'llmabacus(国内)' : 'llm-prices-cn(国内)';
        delete m.auto_converted;
        updatedMain++;
        // 峰谷模型价差大 → 提示核验
        if (typeof m.peak_multiplier === 'number' && m.peak_multiplier > 1) {
          const dIn = oldIn ? Math.abs(m.input_price - oldIn) / oldIn : 0;
          const dOut = oldOut ? Math.abs(m.output_price - oldOut) / oldOut : 0;
          if (dIn > 0.6 || dOut > 0.6) bigDiff.push(`${key}(±${Math.max(dIn, dOut).toFixed(0)}%)`);
        }
      } else if (m.auto_converted === true) {
        // 国内源也没有 → 原本是估算价的才用 USD 换算兜底
        if (usdIn != null && usdOut != null) {
          m.input_price = Number((usdIn * rate).toFixed(2));
          m.output_price = Number((usdOut * rate).toFixed(2));
          // v3.24（F2·A-4c）：缓存价优先用 USD 源真实值；无源值才退回 10% 估算并打标记
          applyUsdCachedPrice(m, cacheUsd, usdIn, rate);
          m.price_source = 'usd×汇率(估算)';
          autoConverted++;
        }
      }
      // 非估算模型且国内源无 → 保留本地人工/官方价
    } else if (m.lock === true) {
      // v3.23.5：CN 分支早就有 lock 保护，US 分支漏了——人工/官方 lock 的模型一旦被 region 判定
      // 划成国外（llmabacus 的 vendors country 每次刷新都会重设 region），刷新会把 lock 价冲掉，
      // 还会打上 auto_converted=true，把「官方价」的语义改成「估算价」。补齐这一分支。
      lockKept++;
    } else {
      // 国外模型：人民币主价 = USD 源 × 汇率（国外定价）
      if (usdIn != null && usdOut != null) {
        m.input_price = Number((usdIn * rate).toFixed(2));
        m.output_price = Number((usdOut * rate).toFixed(2));
        // v3.24（F2·A-4c）：缓存价优先用 USD 源真实值（三源中位数×汇率），无源值才退回 10% 估算 + 标记
        applyUsdCachedPrice(m, cacheUsd, usdIn, rate);
        m.price_source = 'usd×汇率(国外源)';
        m.auto_converted = true;
        autoConverted++;
      }
    }

    // v3.31.0（P0-5 / P1-7）：落盘前体检。异常 → 回退旧值 + 留可见告警，**绝不静默写错价**。
    const gate = priceGate(key, m, preSnap, sanityWarnings);
    if (gate.main) {
      restoreBlock(m, preSnap);
      updatedMain = uMain0; autoConverted = uAuto0; // 已回退 → 不能计入"已更新"
    } else if (gate.cached && preSnap.cached_price != null) {
      restoreCached(m, preSnap); // 旧值为 null 时不回退（写 null = calcCost 按 0 计，比错价更隐蔽）
    }
    // v3.32.0（P1-1 治根）：补到真价后必须让「无公开价」标记**同步失效**。
    //   病根：本文件此前对 pricing_status **零命中** —— 厂商公布单价、我们把价刷进 pricing.json 之后，
    //   那个 'unpublished' 标记还挂在模型上 → 账本侧 addModelUsage 继续打 no_price=true（cost 已被算出 > 0），
    //   于是四出口一律把**已算出来的真金额**盖成「无公开价」。靠人记得手动删字段，等于没有这道保障。
    //   放在 gate 之后：价被 sanity 拦下并回退时（gate.main）说明新价不可信，**不许**顺手清标记。
    // v3.33.0（第四轮审计 补-S1 修复）：判据必须是 **> 0**，不能是 `!= null`。
    //   病根：0 != null 为真 → space-bunny 这类「输入输出同为 0 = 厂商未公布」的条目，下一次刷新就把
    //   unpublished 标记删掉 → 账本不再打 no_price → 四出口显示 ¥0.00（用户读成"免费"）→ 合计偏低告警消失。
    //   这正是 v3.27.0 修掉的 KI-7 病根（$0 与真免费不可区分）从另一扇门回来。
    //   语义界定：**0 价一律视为"仍未公布"**（宁可标「无公开价」，也不显示一个会被误读的 ¥0.00）。
    if (!gate.main && m.pricing_status === 'unpublished'
        && m.input_price > 0 && m.output_price > 0) {
      delete m.pricing_status;
      delete m.pricing_status_note;
      unpublishedCleared++;
    }
  }

  // v3.31.0（P0-5 / P1-7）：体检告警必须**当场可见**（stderr），随后并入 _price_audit.warnings。
  if (sanityWarnings.length) {
    process.stderr.write(
      `[refresh-prices] ⚠价格 sanity check 拦截 ${sanityWarnings.length} 处（已保留旧值，需人工核验）:\n`
      + sanityWarnings.map((w) => `  - ${w}`).join('\n') + '\n'
    );
  }

  pricing.models = models; // v3.24（F2·缺陷4）：确保写盘对象与归并基准同一引用

  // v3.24（F2·缺陷4）：快照比对得出本次真正改动过的 key（含 region/USD/主价/lock 等任何字段变动），
  // 交给 save() 做「只覆盖改动条目」的锁内归并写，避免覆盖抓取窗口内新增的模型。
  const changedKeys = new Set();
  for (const key of Object.keys(models)) {
    const m = models[key];
    const nowSnap = m && typeof m === 'object' ? JSON.stringify(m) : null;
    if (beforeSnap.get(key) !== nowSnap) changedKeys.add(key);
  }

  pricing.date = today;
  pricing.usd_cny_rate = rate;
  pricing.last_source = 'multi-source';
  delete pricing.last_refresh_error;
  delete pricing.last_refresh_error_at;

  // v3.18（H3+H4）：写盘前一致性自检——静默错价没有任何测试会发现，这里兜一道：
  //   ① 人民币主价 vs usd×汇率 偏差 >25% → 告警（US 模型主价即换算结果，正常应≈0%；
  //      CN 模型已不再写 usd_*，存量脏数据被检测出来提醒清理）；
  //   ② peak_multiplier>1 但不是 DeepSeek 原厂系 → 与 peak_hours_cn 声明矛盾，告警。
  const auditWarnings = [];
  for (const [key, m] of Object.entries(models)) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.input_price === 'number' && typeof m.usd_input_price === 'number' && m.input_price > 0) {
      const dev = Math.abs(m.input_price - m.usd_input_price * rate) / m.input_price;
      if (dev > 0.25) auditWarnings.push(`${key}: 人民币价 ${m.input_price} vs usd×${rate}=${(m.usd_input_price * rate).toFixed(2)} 偏差 ${(dev * 100).toFixed(0)}%`);
    }
    if ((m.peak_multiplier || 1) > 1 && !/deepseek/i.test(key) && !/deepseek/i.test(String(m.or_id || ''))) {
      auditWarnings.push(`${key}: peak_multiplier=${m.peak_multiplier} 但非 DeepSeek 原厂系，与 peak_hours_cn 声明矛盾`);
    }
  }
  // v3.24（F2·缺陷6）：峰谷模型价差 >60% 的条目（bigDiff）旧版只在 console.log 打印，
  // 用户/下游脚本看不到；这里并入 _price_audit.warnings（结构与字段不变，只是多追加字符串）。
  for (const b of bigDiff) auditWarnings.push(`${b}: 峰谷模型价差>60%，需人工核验`);
  // v3.31.0（P0-5 / P1-7）：价格体检告警并入同一出口（形状同样是 `<key>: 说明`，
  // 才能被 token-tracker.js 的 warnMentionsModel 点名命中、挂到对应模型的弹窗上）。
  for (const w of sanityWarnings) auditWarnings.push(w);

  if (auditWarnings.length) pricing._price_audit = { at: new Date().toISOString(), warnings: auditWarnings };
  else delete pricing._price_audit;

  // v3.24（F2·A-7）：retired+lock = 设计行为下的永久冻结（见 retiredLockWarnings 注释）。
  // **刻意不进 _price_audit**：它永远无法被用户消除，挂上弹窗就是永久噪音，
  // 会稀释 ⚠价核验 对「可修复异常」的警示价值。改为独立字段 + stderr 留痕。
  const frozenRetired = applyRetiredLocked(pricing, models);
  if (frozenRetired.length) {
    process.stderr.write(`[refresh-prices] ⚠retired+lock 永久冻结条目 ${frozenRetired.length} 个（价格既不会刷新、也不会被清理，且未被标记不可用）: ${frozenRetired.map((s) => s.split(':')[0]).join('、')}\n`);
  }

  // v3.24（F2·A-4c）：cached_price 仍是「输入价×10%」拍脑袋估算的条目数，只走 stderr 汇总一行
  //（不逐条塞 _price_audit，避免刷屏）。这些条目的 cached_price 缺真实源值，用户需知晓。
  const cacheEstimatedKeys = Object.keys(models).filter((k) => models[k] && models[k].cached_price_estimated === true);
  if (cacheEstimatedKeys.length) {
    process.stderr.write(`[refresh-prices] ⚠cached_price 为估算值（输入价×10%）的条目 ${cacheEstimatedKeys.length} 个（三 USD 源均未提供缓存价）: ${cacheEstimatedKeys.slice(0, 10).join('、')}${cacheEstimatedKeys.length > 10 ? ' 等' : ''}\n`);
  }

  // v3.24（F2·缺陷2）：模糊匹配告警必须落盘（旧版只进 last_refresh_note 文本，进程结束即丢）。
  // 字段名固定为 `_ambig_warnings`，内容是纯字符串数组（无时间戳对象），便于其他脚本直接消费。
  if (AMBIG_WARNINGS.size) pricing._ambig_warnings = [...AMBIG_WARNINGS];
  else delete pricing._ambig_warnings;

  // v3.33.0（A2）：lock 条目的歧义告警落**独立字段** `_ambig_warnings_locked` —— 沿用 A-7 对
  //   `_retired_locked` 的同一处置（见上方 937 行注释：刻意不进 `_price_audit`，改为独立字段 + stderr 留痕）。
  //   理由：`m.lock === true` 是**人工/官方已裁决**的价，其匹配结果根本不参与写价 → 该告警永远无法被消除，
  //   挂上弹窗就是**永久噪音**（会把 ⚠价核验 对"可修复异常"的警示价值稀释掉）。
  //   信息不丢：本字段可被 token-tracker.js 的 `--doctor` 读到（计入体检展示，不上弹窗）。
  if (AMBIG_WARNINGS_LOCKED.size) pricing._ambig_warnings_locked = [...AMBIG_WARNINGS_LOCKED];
  else delete pricing._ambig_warnings_locked;
  if (AMBIG_WARNINGS_LOCKED.size) {
    process.stderr.write(`[refresh-prices] 已 lock 条目的模糊匹配告警 ${AMBIG_WARNINGS_LOCKED.size} 条（价已人工冻结、匹配结果不被采用 → 不挂弹窗，仅留痕于 pricing._ambig_warnings_locked）: ${[...AMBIG_WARNINGS_LOCKED].map((s) => s.split(':')[0]).join('、')}\n`);
  }

  // v3.36.0（P0）：**官方价已命中**模型的备用源歧义告警落独立字段 `_ambig_warnings_official`。
  //   与 `_ambig_warnings_locked` 同款处置（信息不丢、不驱动弹窗）：写价走官方价分支，
  //   备用源（国内源 / USD 源）的匹配结果**根本不被采用**，其歧义永远无法被用户修复 → 挂弹窗即永久噪音。
  //   消费方：token-tracker.js 的 `--doctor` 计入体检展示；stderr 全量留痕（见下）。
  if (AMBIG_WARNINGS_OFFICIAL.size) pricing._ambig_warnings_official = [...AMBIG_WARNINGS_OFFICIAL];
  else delete pricing._ambig_warnings_official;
  if (AMBIG_WARNINGS_OFFICIAL.size) {
    process.stderr.write(`[refresh-prices] 官方价已命中模型的备用源歧义 ${AMBIG_WARNINGS_OFFICIAL.size} 条（写价走官方价、备用源结果不被采用 → 不挂弹窗，仅留痕于 pricing._ambig_warnings_official）: ${[...AMBIG_WARNINGS_OFFICIAL].map((s) => s.split(':')[0]).join('、')}\n`);
  }

  // v3.24（F2·缺陷5）：靠推断得到 region 的模型清单（可观测性；判定行为本身未改）。
  if (regionInferred.length) pricing._region_inferred = [...regionInferred];
  else delete pricing._region_inferred;

  const noteParts = [];
  for (const [k, s] of Object.entries(SOURCES)) {
    const r = results[k];
    noteParts.push(`${s.name}${r.ok ? '✓' : `✗(${r.err || '?'})`}`);
  }
  // 官方 DeepSeek 规则（时段/周末/生效时间）同步已由 deepseek-official.js 完成（含 pending 分流）：
  // 它非 raw 模式会自己写 pricing.json 的 deepseek_rules / deepseek_rules_pending / 模型对齐。
  // 这里只处理失败标记：官方抓取成功 → 清除；失败 → 保留上次规则 + 写失败标记（供模型/用户提示）。
  if (officialOk && official) {
    delete pricing.deepseek_refresh_error;
  } else {
    pricing.deepseek_refresh_error = `DeepSeek 官方定价抓取失败（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}），DeepSeek 系价格沿用本地/聚合源价`;
    // 失败不阻塞整体刷新：其余模型照常更新
  }
  pricing.last_refresh_note = `${new Date().toISOString()} 多源刷新：${noteParts.join(' | ')}；人民币主价更新 ${updatedMain} 个${autoConverted ? `，USD换算 ${autoConverted} 个` : ''}，USD参考 ${usdUpdated} 个，region 设定 ${regionSet} 个${(lockKept + lockKeptMain) ? `，lock 价保留 ${lockKept + lockKeptMain} 个${lockKeptMain ? `（含被官方价拦下 ${lockKeptMain} 个）` : ''}` : ''}（汇率 ${rate}）${bigDiff.length ? `；⚠️峰谷模型价差>60%需核验：${bigDiff.join('、')}` : ''}${officialOk ? '；DeepSeek官方价✓' : '；DeepSeek官方价✗(回落聚合源)'}${AMBIG_WARNINGS.size ? `；⚠️模糊匹配歧义: ${[...AMBIG_WARNINGS].join('；')}` : ''}${AMBIG_WARNINGS_LOCKED.size ? `；已 lock 条目的歧义 ${AMBIG_WARNINGS_LOCKED.size} 条（不挂弹窗，见 _ambig_warnings_locked）` : ''}${AMBIG_WARNINGS_OFFICIAL.size ? `；官方价已命中模型的备用源歧义 ${AMBIG_WARNINGS_OFFICIAL.size} 条（备用源结果不被采用 → 不挂弹窗，见 _ambig_warnings_official）` : ''}${auditWarnings.length ? `；⚠️价格一致性自检: ${auditWarnings.join('；')}` : ''}`;

  // v3.24（F2·缺陷3）：接收 save() 返回值。false = 抢锁超时、本次未落盘（date/价格都没更新）。
  // 用 process.exitCode=1 而非 process.exit(1)：不中断后续汇总输出与 atexit 清理，
  // 但退出码仍为非零，调用方（token-tracker.js spawnSync / 定时任务）能识别失败并重试。
  let saved = false;
  try { saved = save(pricing, { changedKeys, deletedKeys: cleanedKeys }); }
  catch (e) { process.stderr.write(`[refresh-prices] 写入失败: ${e.message}\n`); process.exit(1); }
  if (!saved) {
    process.stderr.write('[refresh-prices] 价库写入失败：抢锁超时（可能有其他进程正在刷新），本次刷新未落盘\n');
    process.exitCode = 1;
  }

  console.log(`[refresh-prices] 多源刷新完成：date=${today}，源成功 ${okCount}/${Object.keys(SOURCES).length}(国内${cnOk ? '✓' : '✗'} 国外${usdOk ? '✓' : '✗'})，人民币主价 ${updatedMain} 个，USD换算 ${autoConverted} 个，USD参考 ${usdUpdated} 个，region ${regionSet} 个${regionInferred.length ? `（⚠️${regionInferred.length} 个靠推断: ${regionInferred.join('、')}）` : ''}${(lockKept + lockKeptMain) ? `，lock 价保留 ${lockKept + lockKeptMain} 个${lockKeptMain ? `（含被官方价拦下 ${lockKeptMain} 个）` : ''}` : ''}${unpublishedCleared ? `，补价后清「无公开价」标记 ${unpublishedCleared} 个` : ''}${bigDiff.length ? `，⚠️价差大：${bigDiff.join('、')}` : ''}`);
}

// 仅当以 `node refresh-prices.js` 直接运行时才执行主流程；被 require 时不自动跑（避免测试/复用触发联网刷新）
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[refresh-prices] 异常: ${e.message}\n`);
    process.exit(1);
  });
}

// 供测试/外部复用（不影响脚本直接运行）
// v3.24（F2）：新增导出 isFreeVariant / parse* / mergeWithDisk / applyUsdCachedPrice /
// retiredLockWarnings / applyRetiredLocked，供单元测试直接验证（纯函数，无副作用）
// v3.31.0（P0-5 / P1-7）：导出价格体检纯函数与阈值，供 selftest 离线单测（行为可验证，不靠源码守卫）
// v3.37.0（L1'）：导出 SOURCES / TIMEOUT_MS / BIG_SOURCE_TIMEOUT_MS，供 selftest T39 断言「大载荷源有独立超时预算」。
module.exports = { save, load, todayStr, PRICING, usdFind, cnFind, looseFind, norm, median, AMBIG_WARNINGS, AMBIG_WARNINGS_LOCKED, AMBIG_WARNINGS_OFFICIAL, isFreeVariant, parseLlma, parseLlc, parseOr, parseLitellm, parsePortkey, mergeWithDisk, applyUsdCachedPrice, retiredLockWarnings, applyRetiredLocked, priceGate, restoreBlock, restoreCached, PRICE_SANITY, DEFAULT_RATE, SOURCES, TIMEOUT_MS, BIG_SOURCE_TIMEOUT_MS };
