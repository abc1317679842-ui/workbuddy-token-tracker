#!/usr/bin/env node
// secret-scan.js —— **零依赖**密钥 / 危险模式扫描（GitHub Actions 与本地通用）
//
// 为什么需要（v3.59.0 审计批15 · M40）：CI 此前只有「语法守卫」（node --check / py_compile），
//   **没有任何凭据泄漏的拦截**。本技能会读写 ~/.workbuddy 下的账本与价库、会调 GitHub API 与厂商页面，
//   一旦有人把调试用的 token / 私钥随手粘进代码并推送，**没有第二道防线**。
// 为什么不用 gitleaks 之类的第三方 action：
//   ① 本仓库的卖点是「零依赖单文件」，引入外部 action 就破坏了这一点，且把 CI 的可信度押在第三方仓库上；
//   ② 我们只需要拦"误粘进来的明文凭据"这一小类，正则足够，不需要全量历史扫描。
// 设计取舍：**只扫当前工作树**、**只报明文形态**（不做熵值猜测，避免把正常的长 id 当密钥刷红）。
//   命中即 exit 1 —— 误报宁可让人加白名单，也不要静默放过（凭据泄漏是不可逆的）。
//
// 用法：node .github/workflows/secret-scan.js（在仓库根目录跑）

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
// 形态级规则：命中即报。**顺序 = 报告顺序**，越靠前越严重。
const RULES = [
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/],
  ['GitHub PAT', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['sk- 形态密钥', /sk-[A-Za-z0-9]{24,}/],
  ['私钥 PEM 块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['硬编码凭据赋值', /(api[_-]?key|secret|passwd|password|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i],
  // v3.59.1（审计批17·中危）：补裸 `token` 赋值。改前只认 access[_-]?token —— `token = "长串"`
  //   这种最常见形态漏报（本仓库自己的 PAT 在 mcp.json 里就叫 GITHUB_PERSONAL_ACCESS_TOKEN，
  //   但别人误粘的往往是裸 token）。20+ 字符 + 引号包裹，避免命中普通英文句子里的 token 一词。
  ['疑似 token 赋值', /(?:^|[^a-zA-Z])token\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/i],
];
// 白名单：形似但确属正常的长串（本仓库实测零命中，故留空；新增规则后若出现已知安全项在此登记并写理由）
const ALLOW = [];
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'rounds']);
// v3.59.1（审计批17·中危）：补 .env/.sh/.toml/.ini/.cfg —— 凭据最常躺在这些文件里
//   （.env 尤其是），改前只扫代码/文档扩展名，正好把最常见的藏密处整个漏掉。
const SCAN_EXT = /\.(js|mjs|cjs|json|md|py|yml|yaml|txt|env|sh|toml|ini|cfg|pem|key)$/i;
const MAX_BYTES = 1024 * 1024; // v3.59.1：>1MB 跳过（大日志类文本整体读入 split 全部行，内存随文件涨）

const hits = [];
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!SCAN_EXT.test(e.name)) continue;
    // v3.59.1：体积 + 二进制防护。二进制文件（.pem 之外的密钥材料、编译产物）若扩展名命中会被
    //   当文本扫 → 读出来是乱码、既可能误报也可能漏报；NUL 字节是可靠的二进制判据。
    let sz = 0;
    try { sz = fs.statSync(p).size; } catch (err) { continue; }
    if (sz > MAX_BYTES) continue;
    let txt;
    try {
      const buf = fs.readFileSync(p);
      if (buf.subarray(0, 4096).includes(0)) continue; // 二进制：跳过
      txt = buf.toString('utf8');
    } catch (err) { continue; }
    txt.split(/\r?\n/).forEach((ln, i) => {
      if (ALLOW.some((re) => re.test(ln))) return;
      for (const [name, re] of RULES) {
        if (re.test(ln)) hits.push(`[${name}] ${path.relative(ROOT, p)}:${i + 1}: ${ln.trim().slice(0, 140)}`);
      }
    });
  }
};
walk(ROOT);

if (hits.length) {
  process.stderr.write(`[secret-scan] ✗ 命中 ${hits.length} 处疑似凭据，CI 判失败（确认是误报请加白名单并写理由，不要删规则）\n`);
  for (const h of hits.slice(0, 50)) process.stderr.write(`  ${h}\n`);
  process.exit(1);
}
console.log(`[secret-scan] ✓ 零命中（扫 ${ROOT} 下 ${SCAN_EXT.source} 文本文件）`);
