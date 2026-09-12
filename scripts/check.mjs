#!/usr/bin/env node
// Static checks (npm run check, SPEC §2.11): syntax, ?v= suffixed specifiers, forbidden APIs, HTML hygiene, gzip budget.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUFFIX = '?v=20260912';
const failures = [];
const fail = (file, msg) => failures.push(`${relative(ROOT, file)}: ${msg}`);
const read = f => readFileSync(f, 'utf8');

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__' ? [] : walk(p, exts);
    return exts.includes(extname(e.name)) ? [p] : [];
  });
}

const siteJs = walk(join(ROOT, 'docs/assets/js'), ['.js', '.mjs']);
const scriptJs = walk(join(ROOT, 'scripts'), ['.js', '.mjs']);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// 1. syntax
for (const f of [...siteJs, ...scriptJs]) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fail(f, `node --check 失败：${(r.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`);
}

// 2. every relative module / asset specifier in docs/assets/js carries exactly the version suffix
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?(['"])([^'"]+)\1/g,
  /\bimport\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  /\bnew\s+URL\(\s*(['"`])([^'"`]+)\1/g,
  /\bnew\s+Worker\(\s*(['"`])([^'"`]+)\1/g,
];
for (const f of siteJs) {
  const text = read(f);
  for (const re of SPECIFIERS) for (const m of text.matchAll(re)) {
    const spec = m[2];
    if (!/^\.\.?\//.test(spec)) continue;
    if (!spec.endsWith(SUFFIX) || spec.indexOf('?') !== spec.length - SUFFIX.length) fail(f, `第${lineOf(text, m.index)}行 ${spec} 缺少或多出版本后缀 ${SUFFIX}`);
  }
  for (const m of text.matchAll(/\bnew\s+URL\(\s*([^'"`\s)][^,)]*),\s*import\.meta\.url/g))
    fail(f, `第${lineOf(text, m.index)}行 new URL(${m[1]}, import.meta.url) 必须用字符串字面量以便检查版本后缀`);
}

// 3. forbidden APIs in our code (d3 dsv parsers build functions with new Function; CSP forbids eval)
const FORBIDDEN = [[/\bd3\s*\.\s*(?:csvParse|tsvParse)\b/g, 'd3 CSV/TSV 解析器'], [/\bnew\s+Function\s*\(/g, 'new Function'], [/(?:^|[^.\w$])eval\s*\(/g, 'eval']];
for (const f of [...siteJs, ...scriptJs]) {
  const text = read(f);
  for (const [re, label] of FORBIDDEN) for (const m of text.matchAll(re)) fail(f, `第${lineOf(text, m.index)}行 禁止使用 ${label}`);
}

// 4. index.html / css hygiene
const html = join(ROOT, 'docs/index.html');
if (existsSync(html)) {
  const text = read(html);
  for (const m of text.matchAll(/<script\b([^>]*)>/gi)) if (!/\bsrc\s*=/i.test(m[1])) fail(html, `第${lineOf(text, m.index)}行 内联 <script>（CSP 禁止）`);
  for (const m of text.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)) fail(html, `第${lineOf(text, m.index)}行 ${m[1]}= 事件属性（CSP 禁止）`);
  for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']\//gi)) fail(html, `第${lineOf(text, m.index)}行 以 / 开头的地址（站点在子路径下）`);
} else fail(html, '缺少 docs/index.html');
const css = walk(join(ROOT, 'docs/assets/css'), ['.css']);
for (const f of css) { const text = read(f); for (const m of text.matchAll(/url\(\s*['"]?\//g)) fail(f, `第${lineOf(text, m.index)}行 以 / 开头的 url()`); }

// 5. gzip budgets from the module graph parsed out of the source (each file gzipped on its own, counted once; d3 excluded).
//    EAGER = index.html + linked stylesheets (+ their @import) + classic scripts other than d3 + static import graph of every
//            <script type="module"> + static import graphs of both worker entries + history.json + valuation.json.
//    LAZY  = modules reachable only through import() (sections, charts, bbg, …) and their static graphs, minus EAGER.
const DOCS = join(ROOT, 'docs');
const WORKERS = ['docs/assets/js/compute.worker.js', 'docs/assets/js/robust.worker.js'].map(f => join(ROOT, f));
const DATA = ['docs/data/history.json', 'docs/data/valuation.json'].map(f => join(ROOT, f));
const gz = f => gzipSync(readFileSync(f)).length;
const kb = bytes => (bytes / 1024).toFixed(1);
const localPath = (from, spec) => (/^(?:[a-z]+:|\/\/|\/|#|data:)/i.test(spec) ? null : join(dirname(from), spec.split(/[?#]/)[0]));
// Comments are dropped first so commented-out imports don't count; static imports are matched at statement starts only.
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const STATIC_IMPORT = /^\s*(?:import\s+(?:[\w$*{}\s,]+?\s+from\s+)?|export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)(['"])([^'"]+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*(['"`])([^'"`]+)\1\s*\)/g;
const WORKER_ENTRY = /\bnew\s+Worker\(\s*new\s+URL\(\s*(['"`])([^'"`]+)\1/g;
const edgeCache = new Map();
function edges(file) {
  if (!edgeCache.has(file)) {
    const text = stripComments(read(file)), all = re => [...text.matchAll(re)].map(m => localPath(file, m[2])).filter(Boolean);
    edgeCache.set(file, { static: [...all(STATIC_IMPORT), ...all(WORKER_ENTRY)], dynamic: all(DYNAMIC_IMPORT) });
  }
  return edgeCache.get(file);
}
function closure(roots, seen = new Set()) { // static edges only
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    if (!existsSync(f)) { fail(f, '被 import 引用但文件不存在'); continue; }
    seen.add(f);
    stack.push(...edges(f).static);
  }
  return seen;
}
const htmlText = existsSync(html) ? read(html) : '';
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? null;
const htmlRefs = { css: [], modules: [], classic: [] };
for (const [tag] of htmlText.matchAll(/<link\b[^>]*>/gi)) if (/\brel\s*=\s*["']?stylesheet/i.test(tag) && attr(tag, 'href')) htmlRefs.css.push(localPath(html, attr(tag, 'href')));
for (const [tag] of htmlText.matchAll(/<script\b[^>]*>/gi)) {
  const src = attr(tag, 'src') && localPath(html, attr(tag, 'src'));
  if (src) (/\btype\s*=\s*["']module["']/i.test(tag) ? htmlRefs.modules : htmlRefs.classic).push(src);
}
const cssFiles = new Set(), cssStack = htmlRefs.css.filter(Boolean);
while (cssStack.length) {
  const f = cssStack.pop();
  if (cssFiles.has(f)) continue;
  if (!existsSync(f)) { fail(html, `样式表 ${relative(DOCS, f)} 不存在`); continue; }
  cssFiles.add(f);
  for (const m of read(f).matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) { const p = localPath(f, m[1]); if (p) cssStack.push(p); }
}
const classic = htmlRefs.classic.filter(f => !/\bd3(?:\.v\d+)?(?:\.min)?\.js$/.test(f));
const eagerJs = closure([...htmlRefs.modules, ...classic, ...WORKERS]);
const lazyJs = new Set();
for (let frontier = [...eagerJs]; frontier.length;) {
  const targets = frontier.flatMap(f => edges(f).dynamic).filter(f => !eagerJs.has(f) && !lazyJs.has(f));
  const before = new Set(lazyJs);
  closure(targets, lazyJs);
  for (const f of eagerJs) lazyJs.delete(f);
  frontier = [...lazyJs].filter(f => !before.has(f));
}
const sumGz = files => [...files].filter(existsSync).reduce((s, f) => s + gz(f), 0);
const eager = { html: existsSync(html) ? gz(html) : 0, css: sumGz(cssFiles), js: sumGz(eagerJs), data: sumGz(DATA) };
const eagerBytes = Object.values(eager).reduce((s, x) => s + x, 0), lazyBytes = sumGz(lazyJs);
const EAGER_BUDGET_KB = 180, LAZY_BUDGET_KB = 140;
if (eagerBytes / 1024 > EAGER_BUDGET_KB) failures.push(`首屏 gzip 预算超标：EAGER ${kb(eagerBytes)} KB > ${EAGER_BUDGET_KB} KB`);
if (lazyBytes / 1024 > LAZY_BUDGET_KB) failures.push(`按需加载 gzip 预算超标：LAZY ${kb(lazyBytes)} KB > ${LAZY_BUDGET_KB} KB`);
const orphans = siteJs.filter(f => !eagerJs.has(f) && !lazyJs.has(f));

const top = files => [...files].map(f => [relative(join(DOCS, 'assets/js'), f), gz(f)]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, s]) => `${f} ${kb(s)}`).join(' · ');
console.log(`已检查 ${siteJs.length + scriptJs.length} 个脚本、${css.length} 个样式表`);
console.log(`gzip EAGER ${kb(eagerBytes)} KB / 预算 ${EAGER_BUDGET_KB} KB（html ${kb(eager.html)} · css ${kb(eager.css)} · js ${kb(eager.js)}（${eagerJs.size} 个模块）· data ${kb(eager.data)}）`);
console.log(`  EAGER 最大 JS：${top(eagerJs)}`);
console.log(`gzip LAZY ${kb(lazyBytes)} KB / 预算 ${LAZY_BUDGET_KB} KB（${lazyJs.size} 个模块，仅经 import() 可达）`);
if (lazyJs.size) console.log(`  LAZY 最大 JS：${top(lazyJs)}`);
if (orphans.length) console.log(`  未被引用的 JS（不计入预算）：${orphans.map(f => relative(ROOT, f)).join('、')}`);
if (failures.length) {
  console.error(`检查未通过（${failures.length} 项）：\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else console.log('检查通过');
