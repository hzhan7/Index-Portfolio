import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSample, sliceSample, yieldToAnnualReturn } from '../docs/assets/js/engine/series.js?v=20260912';
import { blockIndices, drawSeed, effectiveBlock, moments, mulberry32, olsAlphaBeta, pathStats, portfolioReturns, quantile7, sharpeDiffCI,
  teStats, volMatched } from '../docs/assets/js/engine/stats.js?v=20260912';

const doc = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);
const row = m => doc.observations.find(o => o.month === m);
const tr = buildSample(doc, { start: '1985-01' });
const code = c => err => err.code === c;

test('tr basis follows the SPEC rule: ndx_tr ?? ndx_pr + ndx_div band, spx_tr ?? spx_tr_con, bond_tr; rows start after start', () => {
  assert.equal(tr.months[0], '1985-02');
  assert.equal(tr.end, doc.observations.at(-1).month);
  assert.equal(tr.n, doc.observations.length - 1);
  for (const [m, band] of [['1990-06', 'default'], ['1999-03', 'default'], ['1999-04', 'default'], ['2005-06', 'default']]) {
    const t = tr.months.indexOf(m), o = row(m);
    assert.equal(tr.R[0][t], o.ndx_tr ?? o.ndx_pr + o[`ndx_div_${band}`]);
    assert.equal(tr.R[1][t], o.spx_tr ?? o.spx_tr_con);
    assert.equal(tr.R[2][t], o.bond_tr);
    assert.equal(tr.rf[t], o.RF);
  }
  const low = buildSample(doc, { start: '1985-01', ndxDiv: 'low' }), high = buildSample(doc, { start: '1985-01', ndxDiv: 'high' });
  const cagr = s => pathStats(s.R[0], s.rf).cagr;
  assert.ok(cagr(low) < cagr(tr) && cagr(tr) < cagr(high));
  const pr = buildSample(doc, { start: '1985-01', basis: 'pr' }), t = pr.months.indexOf('2005-06'), o = row('2005-06');
  assert.deepEqual([pr.R[0][t], pr.R[1][t], pr.R[2][t]], [o.ndx_pr, o.spx_pr, o.bond_pr]);
  assert.deepEqual(pr.warnings, ['W_PR_SHARPE_VS_CASH']);
  assert.ok(pr.div.every(d => d.every(x => x === 0)));
});

test('estimated ranges, RF notes and DGS10 fields are derived from the rows in the sample', () => {
  const est = list => (list.length ? { from: list[0], to: list.at(-1), count: list.length } : null);
  assert.deepEqual(tr.estimated.ndxDiv, est(tr.months.filter(m => row(m).ndx_tr == null)));
  assert.deepEqual(tr.estimated.spxConstructed, est(tr.months.filter(m => row(m).spx_tr == null)));
  const rfNotes = doc.quality_notes.filter(q => q.field === 'RF' && q.status === 'estimated').map(q => q.month);
  assert.deepEqual(tr.estimated.rfEstimated, rfNotes.filter(m => tr.months.includes(m)));
  assert.equal(buildSample(doc, { start: '2000-01', end: '2020-12' }).estimated.ndxDiv, null);
  assert.equal(tr.dgs10End, row(tr.end).dgs10_pct / 100);
  assert.equal(tr.dgs10Start, row('1985-01').dgs10_pct / 100);
  close(yieldToAnnualReturn(0.05), 0.050625, 1e-15);
});

test('withholding tax removes wht × dividend from equities only', () => {
  const w = buildSample(doc, { start: '1985-01', wht: 0.3 });
  for (let t = 0; t < tr.n; t += 37) {
    assert.equal(w.R[0][t], tr.R[0][t] - 0.3 * tr.div[0][t]);
    assert.equal(w.R[1][t], tr.R[1][t] - 0.3 * tr.div[1][t]);
    assert.equal(w.R[2][t], tr.R[2][t]);
  }
});

test('validation errors carry SPEC codes', () => {
  assert.throws(() => buildSample(doc, { start: '2026-08', end: '2020-01' }), code('E_BAD_RANGE'));
  assert.throws(() => buildSample(doc, { start: '1970-01' }), code('E_BAD_RANGE'));
  assert.throws(() => buildSample(doc, { start: '2025-01', end: '2026-01' }), code('E_SHORT_SAMPLE'));
  assert.equal(buildSample(doc, { start: '2025-01', end: '2026-01', minMonths: 1 }).n, 12);
  const broken = { ...doc, observations: doc.observations.map(o => (o.month === '2010-05' ? { ...o, bond_tr: null } : o)) };
  assert.throws(() => buildSample(broken, { start: '2009-12', end: '2012-12' }), code('E_NULL_DATA'));
});

test('pathStats: month-end wealth, drawdown labels, recovery and short-sample nulls', () => {
  const r = [0.1, -0.5, 0.2, 1.0, -0.1], months = ['2000-01', '2000-02', '2000-03', '2000-04', '2000-05'];
  const s = pathStats(r, new Float64Array(5), { startMonth: '1999-12', months });
  assert.deepEqual(Array.from(s.wealth).map(x => +x.toFixed(12)), [1, 1.1, 0.55, 0.66, 1.32, 1.188]);
  close(s.mdd, -0.5, 1e-15);
  assert.deepEqual([s.mddPeak, s.mddTrough, s.mddRecovery, s.recoveryMonths], ['2000-01', '2000-02', '2000-04', 2]);
  close(s.cagr, 1.188 ** (12 / 5) - 1, 1e-12);
  close(s.cumReturn, 0.188, 1e-12);
  assert.equal(s.sharpe, null);
  assert.equal(s.worst12m, null);
  const up = pathStats([0.01, 0.02], [0, 0], { startMonth: '1999-12', months: months.slice(0, 2) });
  assert.deepEqual([up.mdd, up.mddRecovery], [0, null]);
  const full = pathStats(tr.R[1], tr.rf, { startMonth: tr.start, months: tr.months });
  let worst = Infinity;
  for (let k = 0; k + 12 <= tr.n; k++) worst = Math.min(worst, full.wealth[k + 12] / full.wealth[k] - 1);
  close(full.worst12m, worst, 1e-15);
});

test('model vol / TE from Σ equal path vol / TE for 1000 random weights (same months, ddof=1)', () => {
  const { cov } = moments(tr), rng = mulberry32(99), spx = tr.R[1];
  const q = (w, C) => w.reduce((s, wi, i) => s + wi * w.reduce((z, wj, j) => z + C[i][j] * wj, 0), 0);
  for (let k = 0; k < 1000; k++) {
    const raw = [rng(), rng(), rng()], sum = raw[0] + raw[1] + raw[2], w = raw.map(x => x / sum);
    const rp = portfolioReturns(tr, w);
    close(Math.sqrt(q(w, cov)), pathStats(rp, tr.rf).vol, 1e-12, 'vol');
    close(Math.sqrt(q([w[0], w[1] - 1, w[2]], cov)), teStats(rp, spx).te, 1e-12, 'te');
  }
});

test('olsAlphaBeta matches an independent OLS + Newey-West(12, Bartlett) computation', () => {
  const y = Float64Array.from(tr.rf, (r, t) => tr.R[0][t] - r), x = Float64Array.from(tr.rf, (r, t) => tr.R[1][t] - r), n = y.length;
  const mean = a => a.reduce((s, v) => s + v, 0) / n, mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let t = 0; t < n; t++) { sxy += (x[t] - mx) * (y[t] - my); sxx += (x[t] - mx) ** 2; syy += (y[t] - my) ** 2; }
  const beta = sxy / sxx, alpha = my - beta * mx, u = Array.from(y, (v, t) => v - alpha - beta * x[t]);
  const X = Array.from(x, v => [1, v]), XtXi = (() => { const a = n, b = n * mx, d = Array.from(x).reduce((s, v) => s + v * v, 0), det = a * d - b * b; return [[d / det, -b / det], [-b / det, a / det]]; })();
  const S = [[0, 0], [0, 0]];
  for (let l = 0; l <= 12; l++) for (let t = l; t < n; t++) for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) {
    const g = X[t][p] * u[t] * X[t - l][q] * u[t - l], wgt = l === 0 ? 1 : 1 - l / 13;
    S[p][q] += l === 0 ? g : wgt * (g + X[t][q] * u[t] * X[t - l][p] * u[t - l]);
  }
  let V00 = 0;
  for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) V00 += XtXi[0][p] * S[p][q] * XtXi[q][0];
  const res = olsAlphaBeta(y, x);
  close(res.beta, beta, 1e-12); close(res.alpha, alpha, 1e-14); close(res.alphaAnn, 12 * alpha, 1e-13);
  close(res.tAlphaNW, alpha / Math.sqrt(V00), 1e-9); close(res.r2, (sxy * sxy) / (sxx * syy), 1e-12);
});

test('volMatched mixes NDX with cash so excess volatility equals SPX', () => {
  const vm = volMatched(tr), sd = a => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
  close(sd(Array.from(vm.r, (v, t) => v - tr.rf[t])), sd(Array.from(tr.R[1], (v, t) => v - tr.rf[t])), 1e-15);
  assert.equal(vm.levered, vm.a > 1);
  assert.equal(vm.stats.n, tr.n);
});

test('mulberry32 and per-draw seeds are bit-exact against a BigInt uint32 reference', () => {
  const M = 0xffffffffn, imul = (a, b) => (a * b) & M;
  const ref = seed => { let a = BigInt(seed >>> 0); return () => { a = (a + 0x6d2b79f5n) & M; let t = imul(a ^ (a >> 15n), 1n | a); t = ((t + imul(t ^ (t >> 7n), 61n | t)) & M) ^ t; return Number((t ^ (t >> 14n)) & M) / 4294967296; }; };
  for (const seed of [0, 1, 20260912, 0xffffffff]) {
    const a = mulberry32(seed), b = ref(seed);
    for (let k = 0; k < 2000; k++) assert.equal(a(), b());
  }
  for (const b of [0, 1, 999, 123456]) assert.equal(drawSeed(20260912, b), Number((20260912n ^ ((BigInt(b + 1) * 0x9e3779b1n) & M)) & M));
});

test('circular block indices and type-7 quantiles', () => {
  const n = 50, block = 24, rng = mulberry32(5), starts = [], shadow = mulberry32(5), idx = blockIndices(n, block, rng);
  for (let k = 0; k < Math.ceil(n / block); k++) starts.push(Math.floor(shadow() * n));
  assert.deepEqual(Array.from(idx), starts.flatMap(s => Array.from({ length: block }, (_, j) => (s + j) % n)).slice(0, n));
  assert.equal(quantile7([3, 1, 2, 4], 0.25), 1.75);
  assert.equal(quantile7([3, 1, 2, 4], 1), 4);
  assert.equal(quantile7([7], 0.9), 7);
});

test('sharpeDiffCI is deterministic per seed and brackets a finite interval', () => {
  const a = sharpeDiffCI(tr, 0, 1, { B: 200 }), b = sharpeDiffCI(tr, 0, 1, { B: 200 }), c = sharpeDiffCI(tr, 0, 1, { B: 200, seed: 7 });
  assert.deepEqual(a, b);
  assert.notEqual(a.lo, c.lo);
  assert.ok(a.lo < a.hi);
  close(a.point, pathStats(tr.R[0], tr.rf).sharpe - pathStats(tr.R[1], tr.rf).sharpe, 1e-12);
});

test('effective bootstrap block is capped at ⌊n/4⌋: a 24-month sample no longer collapses the Sharpe CI to a point', () => {
  assert.deepEqual([499, 96, 95, 36, 30, 24, 7, 3].map(n => effectiveBlock(n, 24)), [24, 24, 23, 9, 7, 6, 1, 1]);
  assert.equal(effectiveBlock(499, 12), 12);
  // with block 24 these windows gave lo === hi (every draw a rotation of the sample)
  for (const [o, block] of [[{ start: '2024-08', end: '2026-08' }, 6], [{ start: '2000-03', end: '2002-03' }, 6], [{ start: '2008-03', end: '2010-09' }, 7]]) {
    const s = buildSample(doc, o), ci = sharpeDiffCI(s, 0, 1), label = JSON.stringify(o);
    assert.equal(ci.block, block, label);
    assert.ok(ci.hi - ci.lo > 0.2, `${label}: CI width ${ci.hi - ci.lo}`);
    const idx = blockIndices(s.n, ci.block, mulberry32(drawSeed(20260912, 0)));
    assert.ok(Array.from(idx).some((t, k) => k && t !== (idx[k - 1] + 1) % s.n), `${label}: draw 0 is a pure rotation`);
  }
  assert.equal(sharpeDiffCI(tr, 0, 1, { B: 20 }).block, 24); // n ≥ 96 keeps the requested block
});

test('sliceSample keeps labels and DGS10 endpoints aligned with the parent sample', () => {
  const s = sliceSample(tr, 12, 132);
  assert.equal(s.start, tr.months[11]);
  assert.equal(s.months[0], tr.months[12]);
  assert.equal(s.n, 120);
  assert.equal(s.dgs10End, tr.dgs10[131]);
  assert.equal(s.R[2][0], tr.R[2][12]);
});
