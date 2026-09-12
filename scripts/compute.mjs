#!/usr/bin/env node
// Engine CLI: node scripts/compute.mjs --state "<url query>" --kinds context,sample,alloc,robust [--json] [--out FILE]
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KINDS, handle, latestMonth, toPlain } from '../docs/assets/js/engine/jobs.js?v=20260912';

// URL key → [state key, parser]; URL percents become decimals (SPEC §2.1 table).
const PARSE = {
  str: v => v, num: Number, pct: v => Number(v) / 100, pctOrNone: v => (v === 'none' ? null : Number(v) / 100),
  pair: v => v.split('-').map(Number), weights: v => v.split(',').map(Number), bool: v => v === '1',
};
const URL_KEYS = {
  s: ['start', 'str'], e: ['end', 'str'], b: ['basis', 'str'], d: ['ndxDiv', 'str'], t: ['wht', 'pct'], r: ['rule', 'str'],
  vm: ['volMult', 'num'], te: ['teCap', 'pctOrNone'], ic: ['intercept', 'str'], cc: ['interceptC', 'pct'], sp: ['spread', 'pct'],
  pr: ['pair', 'pair'], w: ['customW', 'weights'], fl: ['fill', 'num'], mu: ['mu', 'str'], rw: ['roll', 'num'], rv: ['rollVm', 'bool'],
  wf: ['wfWindow', 'str'], pe: ['m0', 'num'], tm: ['ternaryMetric', 'str'],
};

export function stateFromQuery(query = '') {
  const state = {};
  for (const [k, v] of new URLSearchParams(query.replace(/^\?/, ''))) {
    if (!URL_KEYS[k]) { if (k !== 'v') throw new Error(`未知参数：${k}`); continue; }
    const [name, type] = URL_KEYS[k];
    state[name] = PARSE[type](v);
  }
  return state;
}

const readInput = rel => readFileSync(new URL(rel, import.meta.url));
const pct = (x, d = 2) => (x == null ? '—' : `${(100 * x).toFixed(d)}%`);
const weights = w => (w ? w.map(x => (x == null ? '—' : (100 * x).toFixed(1))).join('/') : '—');

const SUMMARY = {
  context: r => [`滚动${r.rolling?.years}年：跑赢 ${pct(r.rolling?.winRate, 1)} · 中位 ${pct(r.rolling?.median)} · 最差买入 ${r.rolling?.worst?.start}`,
    `拆分（全期）：估值 ${r.decomp?.full?.pe_lp_yr?.toFixed(3)} · EPS ${r.decomp?.full?.eps_lp_yr?.toFixed(3)} 个百分点/年`],
  sample: r => [`样本 ${r.sample.start}～${r.sample.end}（${r.sample.n}个月，${r.sample.basis}）`,
    `纳指100 年化 ${pct(r.h2h?.ndx?.cagr)} 夏普 ${r.h2h?.ndx?.sharpe?.toFixed(3)} · 标普500 年化 ${pct(r.h2h?.spx?.cagr)} 夏普 ${r.h2h?.spx?.sharpe?.toFixed(3)}`,
    `夏普差 95%区间 ${r.h2h?.sharpeDiffCI?.lo?.toFixed(3)}～${r.h2h?.sharpeDiffCI?.hi?.toFixed(3)}`],
  alloc: r => [`同波动·收益最高 ${r.rules.isoVolTe.status} ${weights(r.rules.isoVolTe.w)} 年化 ${pct(r.rules.isoVolTe.stats?.cagr)}`,
    `收益≥标普·夏普最高 ${weights(r.rules.maxSharpeCagrFloor.w)} · 切点(c=${pct(r.rules.tangency.c)}) ${weights(r.rules.tangency.w)}`
      + ` · 切点(c=无风险 ${pct(r.rules.tangency.atRf?.c)}) ${weights(r.rules.tangency.atRf?.w)}`
      + ` · 切点(c=10年 ${pct(r.rules.tangency.atY10?.c)}) ${weights(r.rules.tangency.atY10?.w)}`,
    `切点×杠杆 ${r.rules.tangency.levered.mode}（${r.rules.tangency.levered.cUsedKind} c=${pct(r.rules.tangency.levered.cUsed)}）`
      + ` L=${r.rules.tangency.levered.L?.toFixed(3)} · 纳指+美债 夏普=标普 x=${pct(r.rules.twoAssetNdxUst.headline)}`],
  robust: r => Object.entries(r.byRule).map(([id, v]) => `${id}: 样本外 ${v.walkForward?.firstOos ?? '—'} 起 ${v.walkForward?.oosMonths?.length ?? 0}个月 年化 ${pct(v.walkForward?.stats?.rule?.cagr)}`
    + ` 对标普 ${pct(v.walkForward?.stats?.spx?.cagr)}${v.bootstrap ? ` · p10 ${weights(v.bootstrap.weights.p10)} p90 ${weights(v.bootstrap.weights.p90)}` : ''}`),
};

function main(argv) {
  const args = { state: '', kinds: KINDS.join(','), json: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (['--state', '--kinds', '--out'].includes(a) && argv[i + 1] != null) args[a.slice(2)] = argv[++i];
    else throw new Error(`用法：node scripts/compute.mjs --state "<url query>" --kinds ${KINDS.join(',')} [--json] [--out FILE]（无法识别 ${a}）`);
  }
  const kinds = args.kinds.split(',').filter(Boolean);
  const bad = kinds.filter(k => !KINDS.includes(k));
  if (bad.length) throw new Error(`未知任务：${bad.join(',')}`);
  const bytes = { history: readInput('../docs/data/history.json'), valuation: readInput('../docs/data/valuation.json') };
  const data = { history: JSON.parse(bytes.history), valuation: JSON.parse(bytes.valuation) };
  const state = stateFromQuery(args.state), results = {}, timingsMs = {};
  for (const kind of kinds) {
    const t0 = performance.now();
    results[kind] = handle({ kind, state }, data);
    timingsMs[kind] = Math.round(performance.now() - t0);
  }
  if (args.json || args.out) {
    const doc = { query: args.state, state, latest: latestMonth(data.history), timingsMs,
      inputSha256: Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, createHash('sha256').update(b).digest('hex')])), results: toPlain(results) };
    const text = `${JSON.stringify(doc)}\n`;
    if (args.out) writeFileSync(args.out, text); else process.stdout.write(text);
    if (!args.out) return;
  }
  for (const kind of kinds) console.log(`[${kind}] ${timingsMs[kind]} ms\n  ${SUMMARY[kind](results[kind]).join('\n  ')}`);
}

// Compare real paths: import.meta.url has symlinks resolved, process.argv[1] does not.
const invokedDirectly = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (invokedDirectly()) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.code ? `${e.code}: ${e.message}` : e.message); process.exitCode = 1; }
}
