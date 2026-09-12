import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveJob } from '../docs/assets/js/engine/params.js?v=20260912';
import { buildSample, firstMonth, latestMonth, monthDiff, sliceSample } from '../docs/assets/js/engine/series.js?v=20260912';
import { optimizePortfolios } from '../docs/assets/js/engine/history-objectives.js?v=20260912';
import { blockIndices, drawSeed, moments, mulberry32, pathStats } from '../docs/assets/js/engine/stats.js?v=20260912';
import { kinkedCal } from '../docs/assets/js/engine/frontier.js?v=20260912';
import { defaultCustomWeights, makeCtx, solveIsoVolTe } from '../docs/assets/js/engine/rules.js?v=20260912';
import { bootstrapRule, robustPlan, ruleWeights, runRobust, walkForward } from '../docs/assets/js/engine/robust.js?v=20260912';

const doc = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const tr = buildSample(doc, { start: '1985-01' });
const ISO = { volMult: 1, teCap: 0.05 };
const same = (a, b) => a.length === b.length && Array.from(a).every((x, i) => Object.is(x, b[i]));

test('bootstrap: deterministic, chunk-invariant, per-draw seeded; percentiles ordered', () => {
  const full = bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 300 });
  assert.ok(same(full.draws, bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 300 }).draws));
  const a = bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 300, from: 0, to: 120 }), b = bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 300, from: 120, to: 300 });
  const merged = full.draws.map((_, k) => (k < 360 ? a.draws[k] : b.draws[k]));
  assert.ok(same(merged, full.draws));
  assert.equal(a.nFeasible + b.nFeasible, full.nFeasible);
  assert.ok(!same(full.draws, bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 300, seed: 1 }).draws));
  const n = tr.n, idx = blockIndices(n, 24, mulberry32(drawSeed(20260912, 7)));
  const rs = { ...tr, months: null, R: tr.R.map(x => Float64Array.from(idx, t => x[t])), rf: Float64Array.from(idx, t => tr.rf[t]) };
  const m = moments(rs), w = solveIsoVolTe(m.mu, m.cov, 1, 0.05);
  assert.deepEqual(Array.from(full.draws.slice(21, 24)), w.map(Math.fround));
  for (let i = 0; i < 3; i++) assert.ok(full.weights.p10[i] <= full.weights.p50[i] && full.weights.p50[i] <= full.weights.p90[i]);
  for (const k of ['probUstOver50', 'probSpxUnder1', 'probCorner', 'probInfeasible']) assert.ok(full[k] >= 0 && full[k] <= 1);
  assert.equal(full.draws.length, 900);
});

test('bootstrap: isoVolTe B=1000 < 2 s with progress every 25 draws; infeasible draws are NaN', () => {
  let calls = 0;
  const t0 = performance.now(), r = bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 1000, onProgress: () => calls++ });
  assert.ok(performance.now() - t0 < 2000, 'bootstrap too slow');
  assert.equal(calls, 40);
  assert.equal(r.B, 1000);
  const bad = bootstrapRule(tr, 'isoVolTe', { volMult: 0.5, teCap: 0.02 }, {}, { B: 20 });
  assert.equal(bad.nFeasible, 0); assert.equal(bad.probInfeasible, 1); assert.ok(bad.draws.every(Number.isNaN)); assert.equal(bad.weights.p50[0], null);
  for (const [rule, B] of [['tangency', 40], ['maxSharpeCagrFloor', 6]]) {
    const x = bootstrapRule(tr, rule, rule === 'tangency' ? { intercept: 'rf' } : {}, {}, { B });
    assert.equal(x.nFeasible + Math.round(x.probInfeasible * B), B);
    for (let k = 0; k < B; k++) if (!Number.isNaN(x.draws[3 * k])) assert.ok(Math.abs(x.draws[3 * k] + x.draws[3 * k + 1] + x.draws[3 * k + 2] - 1) < 1e-6);
  }
});

test('walk-forward: January schedule, trailing 120-month windows from full history, OOS bookkeeping', () => {
  const wf = walkForward(doc, { start: '1985-01' }, 'isoVolTe', ISO, {}, { window: 'trailing' });
  assert.equal(wf.status, 'ok');
  assert.equal(wf.firstOos, wf.weights[0].month);
  wf.weights.forEach((e, k) => {
    if (k) assert.ok(e.month.endsWith('-01'));
    assert.equal(monthDiff(e.estFrom, e.month), 120);
    assert.equal(monthDiff(e.estTo, e.month), 1);
  });
  const history0 = monthDiff(firstMonth(doc), wf.weights[0].month) - 1; // return months available before the first τ
  assert.ok(history0 >= 120 && history0 - 12 < 120);
  assert.equal(wf.months, monthDiff(wf.firstOos, tr.end) + 1);
  assert.equal(wf.oosMonths.length, wf.months);
  assert.deepEqual([wf.oosMonths[0], wf.oosMonths.at(-1)], [wf.firstOos, tr.end]);
  wf.oosMonths.forEach((m, k) => { if (k) assert.equal(monthDiff(wf.oosMonths[k - 1], m), 1); });
  assert.equal(wf.series.rule.length, wf.months + 1);
  assert.equal(wf.relToSpx.at(-1), wf.series.rule.at(-1) / wf.series.spx.at(-1));
  assert.equal(wf.stats.rule.n, wf.months);
  assert.ok(wf.y2022 && Number.isFinite(wf.y2022.rule));
  assert.equal(wf.ustOver50Years, wf.weights.filter(e => e.w[2] > 0.5).length);
  const u = buildSample(doc, { start: '1985-01' }), oos = sliceSample(u, u.months.indexOf(wf.firstOos), u.n);
  assert.deepEqual(wf.inSampleStatic.w, ruleWeights('isoVolTe', oos, ISO).w);
  const exp = walkForward(doc, { start: '1985-01' }, 'isoVolTe', ISO, {}, { window: 'expanding' });
  exp.weights.forEach(e => assert.equal(e.estFrom, buildSample(doc, { start: firstMonth(doc), minMonths: 1 }).months[0]));
});

test('walk-forward: no look-ahead — perturbing returns from 2010-01 leaves earlier weights unchanged', () => {
  const bumped = { ...doc, observations: doc.observations.map(o => (o.month >= '2010-01'
    ? { ...o, ndx_tr: o.ndx_tr + 0.02, ndx_pr: o.ndx_pr + 0.02, spx_tr: o.spx_tr - 0.01, spx_pr: o.spx_pr - 0.01 } : o)) };
  for (const rule of ['isoVolTe', 'maxSharpeCagrFloor', 'tangency']) {
    const params = rule === 'tangency' ? { spread: 0.005, volMult: 1 } : rule === 'isoVolTe' ? ISO : {};
    const a = walkForward(doc, { start: '1985-01' }, rule, params), b = walkForward(bumped, { start: '1985-01' }, rule, params);
    const early = e => e.month <= '2010-01';
    assert.deepEqual(a.weights.filter(early), b.weights.filter(early), `${rule} look-ahead`);
    assert.notDeepEqual(a.weights.filter(e => !early(e)), b.weights.filter(e => !early(e)));
  }
});

test('walk-forward: short samples use pre-sample history; insufficient OOS; levered and fixed-weight rules', () => {
  const recent = walkForward(doc, { start: '2016-08' }, 'isoVolTe', ISO);
  assert.equal(recent.firstOos, buildSample(doc, { start: '2016-08' }).months[0]);
  assert.equal(recent.status, 'ok');
  const short = walkForward(doc, { start: '2024-01' }, 'isoVolTe', ISO, {}, {});
  assert.equal(short.status, 'insufficient'); assert.equal(typeof short.reason, 'string'); assert.ok(short.months < 36);
  assert.equal(short.oosMonths.length, short.months);
  const none = walkForward(doc, { start: '1985-01', end: '1994-06' }, 'isoVolTe', ISO); // no τ with 120 months of history
  assert.deepEqual([none.status, none.months, none.oosMonths], ['insufficient', 0, []]);
  const lev = walkForward(doc, { start: '1999-03' }, 'tangency', { spread: 0.005, volMult: 1 });
  lev.weights.forEach(e => { assert.ok(e.L > 0); e.notional.forEach((x, i) => assert.ok(Math.abs(x - e.L * e.w[i]) < 1e-15)); });
  const fixed = walkForward(doc, { start: '1999-03' }, 'custom', { w: [0.4, 0.4, 0.2] });
  fixed.weights.forEach(e => assert.deepEqual(e.w, [0.4, 0.4, 0.2]));
});

test('history optimizer: certified root skipping is bit-identical to the plain 46-step bisections and needs far fewer passes', () => {
  const KEYS = ['cagr', 'sharpe', 'vol', 'mdd', 'cagrGapVsSpx', 'sharpeGapVsSpx'];
  const same = (a, b) => a === b || (a && b && KEYS.every(k => Object.is(a[k], b[k])) && a.w.every((x, i) => Object.is(x, b.w[i])));
  let fast = 0, plain = 0, solutions = 0;
  const check = (input, objectives, label) => {
    const a = optimizePortfolios(input, { objectives }), b = optimizePortfolios(input, { objectives, certifiedRoots: false });
    for (const k of Object.keys(b.solutions)) { assert.ok(same(a.solutions[k], b.solutions[k]), `${label} ${k}`); solutions++; }
    fast += a.diagnostics.passes; plain += b.diagnostics.passes;
  };
  for (const o of [{ start: '1985-01' }, { start: '1985-01', basis: 'pr' }, { start: '2009-02', ndxDiv: 'low', wht: 0.3 }]) {
    const s = buildSample(doc, o), n = s.n, idx = new Int32Array(n), label = JSON.stringify(o);
    check(s, undefined, `${label} all objectives`);
    const rs = { n, R: [0, 1, 2].map(() => new Float64Array(n)), rf: new Float64Array(n) };
    for (let b = 0; b < 12; b++) { // the maxSharpeCagrFloor bootstrap resamples
      blockIndices(n, 24, mulberry32(drawSeed(20260912, b)), idx);
      for (let t = 0; t < n; t++) { const k = idx[t]; for (let a = 0; a < 3; a++) rs.R[a][t] = s.R[a][k]; rs.rf[t] = s.rf[k]; }
      check(rs, ['maxSharpeAtLeastSpxCagr'], `${label} draw ${b}`);
    }
  }
  const full = buildSample(doc, { start: firstMonth(doc), minMonths: 1 });
  for (const f of [120, 200, 300, full.n]) check(sliceSample(full, f - 120, f), ['maxSharpeAtLeastSpxCagr'], `walk-forward window ending ${full.months[f - 1]}`);
  assert.equal(solutions, 3 * (5 + 12) + 4);
  assert.ok(fast < 0.7 * plain, `passes ${fast} vs plain ${plain}`);
});

test('timing: robust job with maxSharpeCagrFloor active well inside the 6 s browser budget (≈1.3 s in Node on the reference Mac)', () => {
  const job = resolveJob({ rule: 'maxSharpeCagrFloor' }, { latest: latestMonth(doc) });
  const t0 = performance.now(), res = runRobust(doc, job), ms = performance.now() - t0;
  assert.equal(res.byRule.maxSharpeCagrFloor.bootstrap.B, 200);
  assert.ok(ms < 6000, `robust job took ${ms.toFixed(0)} ms`);
});

test('robustPlan stages by active rule; runRobust reports progress per stage and resolves default custom weights', () => {
  const ids = state => robustPlan(resolveJob(state, { latest: '2026-08' })).map(s => s.id);
  const base = ['wf:isoVolTe', 'wf:maxSharpeCagrFloor', 'wf:tangency', 'bs:isoVolTe'];
  assert.deepEqual(ids({}), base);
  assert.deepEqual(ids({ rule: 'twoAsset' }), base);
  assert.deepEqual(ids({ rule: 'maxSharpeCagrFloor' }), [...base, 'bs:maxSharpeCagrFloor']);
  assert.deepEqual(ids({ rule: 'tangency' }), [...base, 'bs:tangency']);
  assert.deepEqual(ids({ rule: 'custom' }), [...base, 'wf:custom']);
  const job = resolveJob({ rule: 'custom', start: '2009-02' }, { latest: '2026-08' }), events = [];
  const res = runRobust(doc, job, { onProgress: e => events.push(e) });
  assert.deepEqual(res.stages, [...base, 'wf:custom']);
  for (const id of res.stages) assert.ok(events.some(e => e.stage === id && e.done === e.total));
  const w = defaultCustomWeights(makeCtx(buildSample(doc, job.sample)), job.params.isoVolTe);
  res.byRule.custom.walkForward.weights.forEach(e => assert.deepEqual(e.w, w));
  assert.equal(res.byRule.isoVolTe.bootstrap.B, 1000);
});

test('bootstrap on a 24-month sample uses a 6-month block: draws differ and weight percentiles do not collapse', () => {
  const short = buildSample(doc, { start: '2024-08', end: '2026-08' });
  assert.equal(short.n, 24);
  const r = bootstrapRule(short, 'isoVolTe', ISO, {}, { B: 300 });
  assert.equal(r.block, 6);
  const distinct = new Set(Array.from({ length: r.B }, (_, b) => Array.from(r.draws.subarray(3 * b, 3 * b + 3)).join('/')));
  assert.ok(distinct.size > 50, `${distinct.size} distinct isoVolTe draws (block 24 gave 1)`);
  assert.ok([0, 1, 2].some(i => r.weights.p90[i] - r.weights.p10[i] > 0.1), JSON.stringify(r.weights));
  assert.ok(r.probCorner < 1);
  const msf = bootstrapRule(short, 'maxSharpeCagrFloor', {}, {}, { B: 20 });
  assert.equal(msf.block, 6);
  assert.ok(new Set(Array.from({ length: 20 }, (_, b) => Array.from(msf.draws.subarray(3 * b, 3 * b + 3)).join('/'))).size > 1, 'maxSharpeCagrFloor draws identical');
  assert.equal(bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 2 }).block, 24);
});

test('tangency robustness is one portfolio: bootstrap and walk-forward both resample the levered kinked CAL', () => {
  const P = { intercept: 'implied', interceptC: null, spread: 0.005, volMult: 1 };
  const bs = bootstrapRule(tr, 'tangency', P, {}, { B: 60 });
  assert.equal(bs.variant, 'levered');
  assert.equal(bs.drawsL.length, 60);
  const b = 7, idx = blockIndices(tr.n, 24, mulberry32(drawSeed(20260912, b)));
  const rs = { ...tr, months: null, R: tr.R.map(x => Float64Array.from(idx, t => x[t])), rf: Float64Array.from(idx, t => tr.rf[t]) };
  const c = makeCtx(rs, {}, { lite: true }), k = kinkedCal(c.muUsed, c.cov, { rfAnn: c.rfAnn, spread: 0.005, targetVol: c.sigmaSpx });
  assert.deepEqual(Array.from(bs.draws.subarray(3 * b, 3 * b + 3)), k.w.map(Math.fround), 'draw = risky weights of the kinked CAL on the resample');
  assert.equal(bs.drawsL[b], Math.fround(k.L));
  // the intercept selector moves only the unlevered tangency, not the levered portfolio being resampled
  assert.ok(same(bootstrapRule(tr, 'tangency', { ...P, intercept: 'custom', interceptC: 0.07 }, {}, { B: 60 }).draws, bs.draws));
  const quantiles = [bs.leverage, ...[0, 1, 2].map(i => ({ p10: bs.notional.p10[i], p50: bs.notional.p50[i], p90: bs.notional.p90[i] }))];
  for (const q of quantiles) assert.ok(q.p10 <= q.p50 && q.p50 <= q.p90, JSON.stringify(q));
  assert.ok(bs.leverage.p10 > 0);
  const a1 = bootstrapRule(tr, 'tangency', P, {}, { B: 60, from: 0, to: 25 }), a2 = bootstrapRule(tr, 'tangency', P, {}, { B: 60, from: 25, to: 60 });
  assert.ok(same(bs.drawsL.map((_, j) => (j < 25 ? a1.drawsL[j] : a2.drawsL[j])), bs.drawsL), 'drawsL chunk-invariant');
  const wf = walkForward(doc, { start: '1999-03' }, 'tangency', P);
  assert.equal(wf.variant, 'levered');
  wf.weights.forEach(e => assert.ok(e.L > 0));
  assert.equal(walkForward(doc, { start: '2016-08' }, 'isoVolTe', ISO).variant, 'unlevered');
  const iso = bootstrapRule(tr, 'isoVolTe', ISO, {}, { B: 5 });
  assert.deepEqual([iso.variant, iso.drawsL, iso.leverage, iso.notional], ['unlevered', undefined, undefined, undefined]);
});

test('walk-forward carries a 50/50 NDX/SPX reference path on the same OOS months', () => {
  const wf = walkForward(doc, { start: '1985-01' }, 'isoVolTe', ISO);
  const u = buildSample(doc, { start: '1985-01' }), oos = sliceSample(u, u.months.indexOf(wf.firstOos), u.n);
  const r = Float64Array.from({ length: oos.n }, (_, t) => 0.5 * oos.R[0][t] + 0.5 * oos.R[1][t]);
  const { wealth, ...st } = pathStats(r, oos.rf, { startMonth: oos.start, months: oos.months });
  assert.deepEqual(wf.stats.ndxSpx5050, st);
  assert.deepEqual(Array.from(wf.series.ndxSpx5050), Array.from(wealth));
  assert.equal(wf.series.ndxSpx5050.length, wf.months + 1);
});
