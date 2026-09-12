// Engine outputs vs the independent numpy/scipy implementation in data/validation/crosscheck_v2.json (SPEC §2.11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const RERUN = 'rerun python3 scripts/validation/crosscheck_v2.py';
const readText = p => readFileSync(new URL(p, ROOT));
const sha256 = p => (existsSync(new URL(p, ROOT)) ? createHash('sha256').update(readText(p)).digest('hex') : null);

const X = JSON.parse(readText('data/validation/crosscheck_v2.json'));
const history = JSON.parse(readText('docs/data/history.json'));
const valuation = JSON.parse(readText('docs/data/valuation.json'));
const TOL = X.tolerances;
const inputsMatch = sha256('docs/data/history.json') === X.inputSha256.history && sha256('docs/data/valuation.json') === X.inputSha256.valuation
  && X.inputMode.history === 'file' && X.inputMode.valuation === 'file';
const skip = inputsMatch ? false : `inputs changed: ${RERUN}`;

const load = name => import(`../docs/assets/js/engine/${name}.js?v=20260912`);
const [series, stats, frontier, rules, robust, compare, decomp] = await Promise.all(
  ['series', 'stats', 'frontier', 'rules', 'robust', 'compare', 'decomp'].map(load));

/** Recursively compare every key present in `expected`; numbers within tol (a number, or a function of the expected value), everything else strictly. */
function expectClose(actual, expected, tol, path) {
  if (expected === null) return assert.ok(actual == null || Number.isNaN(actual), `${path}: expected null, got ${actual}`);
  if (typeof expected === 'number') {
    const t = typeof tol === 'function' ? tol(expected) : tol;
    return assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= t, `${path}: engine ${actual} vs python ${expected} (tol ${t})`);
  }
  if (typeof expected !== 'object') return assert.equal(actual, expected, path);
  if (Array.isArray(expected)) {
    assert.ok(actual != null && actual.length === expected.length, `${path}: length ${actual?.length} vs ${expected.length}`);
    return expected.forEach((e, i) => expectClose(actual[i], e, tol, `${path}[${i}]`));
  }
  assert.ok(actual != null, `${path}: missing`);
  for (const [k, e] of Object.entries(expected)) expectClose(actual[k], e, tol, `${path}.${k}`);
}
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));

const scenarioOpts = name => {
  const s = X.conventions.scenarioState[name];
  return { start: s.start, end: s.end ?? X.latest, basis: s.basis, ndxDiv: s.ndxDiv, wht: s.wht };
};

test('crosscheck inputs match docs/data (sha256)', () => {
  assert.equal(X.latest, history.observations.at(-1).month, RERUN);
  assert.equal(X.inputMode.history, 'file', `history built in fallback mode: ${RERUN}`);
  assert.equal(X.inputMode.valuation, 'file', `valuation built in fallback mode: ${RERUN}`);
  assert.equal(sha256('docs/data/history.json'), X.inputSha256.history, `history.json changed: ${RERUN}`);
  assert.equal(sha256('docs/data/valuation.json'), X.inputSha256.valuation, `valuation.json changed: ${RERUN}`);
});

for (const [name, P] of Object.entries(X.scenarios)) {
  const setup = () => {
    const sample = series.buildSample(history, scenarioOpts(name));
    return { sample, ctx: rules.makeCtx(sample, { mu: 'hist' }) };
  };

  test(`${name}: sample, asset path stats, moments, references`, { skip }, () => {
    const { sample, ctx } = setup();
    const e = P.sample;
    assert.equal(sample.n, e.n);
    assert.equal(sample.months[0], e.firstMonth);
    assert.equal(sample.months.at(-1), e.lastMonth);
    const sum = (a, f) => a.reduce((s, v) => s + f(v), 0);
    expectClose(sample.R.map(r => sum(r, v => v)), e.sumR, TOL.stats, 'sumR');
    expectClose(sample.R.map(r => sum(r, v => v * v)), e.sumR2, TOL.stats, 'sumR2');
    expectClose(sum(sample.rf, v => v), e.sumRf, TOL.stats, 'sumRf');
    expectClose(sample.div.map(d => sum(d, v => v)), e.sumDiv, TOL.stats, 'sumDiv');
    expectClose(sample.estimated, pick(e.estimated, ['ndxDiv', 'spxConstructed']), 0, 'estimated');
    expectClose({ dgs10End: sample.dgs10End, dgs10Start: sample.dgs10Start }, pick(e, ['dgs10End', 'dgs10Start']), 1e-15, 'dgs10');
    for (const [i, k] of ['ndx', 'spx', 'ust'].entries()) {
      expectClose(stats.pathStats(sample.R[i], sample.rf, { startMonth: sample.start, months: sample.months }), P.assets[k], TOL.stats, `assets.${k}`);
    }
    expectClose(stats.moments(sample), P.moments, TOL.stats, 'moments');
    expectClose(ctx.sigmaSpx, P.sigmaSpx, TOL.stats, 'sigmaSpx');
    const refs = rules.references(sample, ctx);
    for (const [id, st] of Object.entries(P.references)) expectClose(refs.find(r => r.id === id).stats, st, TOL.stats, `references.${id}`);
  });

  test(`${name}: headToHead and relativeWealth`, { skip }, () => {
    const { sample } = setup();
    const h = compare.headToHead(history, scenarioOpts(name), { seed: X.conventions.seed });
    expectClose(h, P.h2h, TOL.stats, 'h2h');
    const rw = compare.relativeWealth(sample);
    expectClose({ endRatio: rw.endRatio, min: Math.min(...rw.ratio), max: Math.max(...rw.ratio) }, P.relativeWealth, TOL.stats, 'relativeWealth');
  });

  test(`${name}: isoVolTe (exact enumeration)`, { skip }, () => {
    const { sample, ctx } = setup();
    const checkIso = (res, e, label) => {
      assert.equal(res.status, e.status, `${label} status`);
      expectClose(res.feasibility, e.feasibility, TOL.feasibility, `${label}.feasibility`);
      if (e.status !== 'ok') return;
      expectClose(res.w, e.w, TOL.weightsExact, `${label}.w`);
      expectClose(res.model, e.model, TOL.stats, `${label}.model`);
      assert.deepEqual(res.binding, e.binding, `${label}.binding`);
      expectClose(res.stats, e.stats, TOL.stats, `${label}.stats`);
      expectClose(res.vsSpx, e.vsSpx, TOL.stats, `${label}.vsSpx`);
      if (!e.pure) return;
      expectClose(res.pure, pick(e.pure, ['w', 'teUnconstrained', 'impliedIntercept']), TOL.weightsExact, `${label}.pure`);
      for (const pt of Object.values(e.path)) {
        const got = res.path.find(p => Math.abs(p.k - pt.k) < 1e-12);
        assert.ok(got, `${label}.path k=${pt.k} missing`);
        expectClose(got.w, pt.w, TOL.weightsExact, `${label}.path[${pt.k}].w`);
        expectClose(pick(got, ['mu', 'vol', 'te', 'cagr']), pick(pt, ['mu', 'vol', 'te', 'cagr']), TOL.stats, `${label}.path[${pt.k}]`);
      }
      if (e.flatTop) expectClose(res.flatTop, e.flatTop, TOL.weightsExact, `${label}.flatTop`);
      expectClose(res.muShift, e.muShift, TOL.weightsExact, `${label}.muShift`);
    };
    for (const e of P.isoVolTe) checkIso(rules.isoVolTe(sample, e.params, ctx), e, `isoVolTe(${e.params.volMult},${e.params.teCap})`);
    if (P.y10bond) {
      const yctx = rules.makeCtx(sample, { mu: 'y10bond' });
      expectClose(yctx.muUsed, P.y10bond.muUsed, 1e-12, 'y10bond.muUsed');
      for (const e of P.y10bond.isoVolTe) checkIso(rules.isoVolTe(sample, e.params, yctx), e, `y10bond.isoVolTe(${e.params.teCap})`);
    }
  });

  test(`${name}: maxSharpeCagrFloor (vs SLSQP)`, { skip }, () => {
    const { sample, ctx } = setup();
    const res = rules.maxSharpeCagrFloor(sample, {}, ctx), e = P.maxSharpeCagrFloor;
    expectClose(res.w, e.w, TOL.weightsSlsqp, 'w');
    expectClose(res.stats.sharpe, e.sharpe, 1e-6, 'sharpe');
    // Path stats use a looser, relative tolerance than TOL.stats (1e-9). Python's optimum is SLSQP-polished on a
    // non-smooth path objective, while the engine's comes from a profile scan plus golden-section refinement, so the
    // two weight vectors agree only to TOL.weightsSlsqp (2e-4; measured ≤ 3.8e-7 on data through 2026-08). Path stats
    // are Lipschitz in w, so a weight gap of that size shows up as a proportional gap, e.g. ~1e-4 absolute on
    // cumReturn ≈ 110. Rule: |Δ| ≤ 1e-4·max(|python|, 1e-3); the 1e-3 floor covers near-zero vsSpx deltas
    // (vsSpx.cagr ≈ 0 when the floor binds). Measured worst 1.9e-5 (tr2009 vsSpx.vol). Dates still match exactly.
    const rel = v => 1e-4 * Math.max(Math.abs(v), 1e-3);
    expectClose(res.stats, e.stats, rel, 'stats');
    expectClose(res.vsSpx, e.vsSpx, rel, 'vsSpx');
    assert.ok(res.vsSpx.cagr >= -1e-9, `CAGR floor violated: ${res.vsSpx.cagr}`);
  });

  test(`${name}: tangency, kinked CAL and tangency path`, { skip }, () => {
    const { sample, ctx } = setup();
    const checkTangency = (T, context, label) => {
      for (const [key, intercept] of [['rf', 'rf'], ['y10', 'y10'], ['implied', 'implied'], ['custom7', 'custom']]) {
        const e = T[key];
        const res = rules.tangency(sample, { intercept, interceptC: 0.07 }, context);
        if (e == null) { assert.equal(res.c, null, `${label}.${key}.c`); continue; }
        expectClose(res.c, e.c, TOL.weightsExact, `${label}.${key}.c`);
        assert.equal(res.unlevered.status, e.status, `${label}.${key}.status`);
        if (e.status !== 'ok') continue;
        expectClose(res.unlevered.w, e.w, TOL.weightsExact, `${label}.${key}.w`);
        expectClose(pick(res.unlevered, ['model', 'slope', 'stats', 'vsSpx']), pick(e, ['model', 'slope', 'stats', 'vsSpx']), key === 'implied' ? 1e-6 : TOL.stats, `${label}.${key}`);
        expectClose({ cRf: res.cRf, cY10: res.cY10 }, { cRf: T.rfAnn, cY10: T.cY10 }, 1e-15, `${label}.intercepts`);
      }
      // atRf: unlevered tangency at the sample rf whatever intercept is selected = Python's 'rf' block
      if (T.rf?.status === 'ok') {
        const { atRf } = rules.tangency(sample, { intercept: 'implied' }, context);
        expectClose(atRf.w, T.rf.w, TOL.weightsExact, `${label}.atRf.w`);
        expectClose(pick(atRf, ['c', 'status', 'model', 'slope', 'stats', 'vsSpx']), pick(T.rf, ['c', 'status', 'model', 'slope', 'stats', 'vsSpx']),
          TOL.stats, `${label}.atRf`);
      }
      // atY10: unlevered tangency at the converted sample-end 10Y yield whatever intercept is selected = Python's 'y10' block
      if (T.y10?.status === 'ok') {
        const { atY10 } = rules.tangency(sample, { intercept: 'implied' }, context);
        expectClose(atY10.w, T.y10.w, TOL.weightsExact, `${label}.atY10.w`);
        expectClose(pick(atY10, ['c', 'status', 'model', 'slope', 'stats', 'vsSpx']), pick(T.y10, ['c', 'status', 'model', 'slope', 'stats', 'vsSpx']),
          TOL.stats, `${label}.atY10`);
      }
      for (const [key, e] of Object.entries(T.levered)) {
        const res = rules.leveredTangency(sample, context, { spread: e.spread, volMult: e.volMult });
        assert.equal(res.mode, e.mode, `${label}.levered.${key}.mode`);
        assert.equal(res.cUsedKind, e.cUsedKind, `${label}.levered.${key}.cUsedKind`);
        expectClose(pick(res, ['w', 'notional']), pick(e, ['w', 'notional']), TOL.weightsExact, `${label}.levered.${key}`);
        expectClose(pick(res, ['L', 'borrow', 'lend', 'expReturn', 'targetVol', 'cUsed', 'stats', 'vsSpx', 'y2022']),
          pick(e, ['L', 'borrow', 'lend', 'expReturn', 'targetVol', 'cUsed', 'stats', 'vsSpx', 'y2022']), TOL.stats, `${label}.levered.${key}`);
      }
      const path = frontier.tangencyPath(context.muUsed, context.cov, { cMin: T.thresholds.cMin, cMax: T.thresholds.cMax });
      expectClose(pick(path, ['cUstUnder50', 'cZeroUst', 'cAllNdx']), pick(T.thresholds, ['cUstUnder50', 'cZeroUst', 'cAllNdx']), TOL.roots, `${label}.thresholds`);
    };
    checkTangency(P.tangency, ctx, 'tangency');
    if (P.y10bond) checkTangency(P.y10bond.tangency, rules.makeCtx(sample, { mu: 'y10bond' }), 'y10bond.tangency');
  });

  test(`${name}: twoAsset roots`, { skip }, () => {
    const { sample, ctx } = setup();
    for (const [key, e] of Object.entries(P.twoAsset)) {
      const res = rules.twoAsset(sample, { pair: e.pair }, ctx);
      expectClose(res.roots, e.roots, TOL.roots, `${key}.roots`);
      expectClose(res.best, e.best, TOL.roots, `${key}.best`);
      expectClose(res.headline, e.headline, TOL.roots, `${key}.headline`);
      assert.equal(res.status, e.status, `${key}.status`);
      for (const [x, pt] of Object.entries(e.curveAt)) {
        const k = Math.round(Number(x) * 1000);
        expectClose(Object.fromEntries(Object.keys(pt).map(m => [m, res.curve[m][k]])), pt, TOL.stats, `${key}.curve@${x}`);
      }
    }
  });
}

for (const [key, C] of Object.entries(X.context)) {
  test(`context ${key}: rolling excess, regimes, decades`, { skip }, () => {
    const opts = C.opts;
    for (const [label, e] of Object.entries(C.rolling)) {
      const res = compare.rollingExcess(history, opts, { years: e.years, volMatched: e.volMatched });
      const { excessAtJanuary, firstPoint, lastPoint, ...summary } = e;
      expectClose(res, summary, TOL.stats, `rolling.${label}`);
      const { start, end, excess } = res.points;
      const jan = Object.fromEntries(start.map((m, k) => [m, excess[k]]).filter(([m]) => m.endsWith('-01')));
      expectClose(jan, excessAtJanuary, TOL.stats, `rolling.${label}.excessAtJanuary`);
      assert.equal(Object.keys(jan).length, Object.keys(excessAtJanuary).length, `rolling.${label} January count`);
      expectClose({ start: start[0], end: end[0], excess: excess[0] }, firstPoint, TOL.stats, `rolling.${label}.first`);
      expectClose({ start: start.at(-1), end: end.at(-1), excess: excess.at(-1) }, lastPoint, TOL.stats, `rolling.${label}.last`);
    }
    expectClose(compare.regimeTable(history, opts), C.regimes, TOL.stats, 'regimes');
    expectClose(compare.decadeTable(history, opts), C.decades, TOL.stats, 'decades');
  });
}

test('decomposition: anchor rows, splice, full band, break-even, splitAtM0', { skip }, () => {
  const { splitAtM0: splits, ...variants } = X.decomp;
  for (const [key, { args, ...e }] of Object.entries(variants)) {
    expectClose(decomp.anchorDecomposition(history, valuation, args), e, TOL.stats, `decomp.${key}`);
  }
  const be = decomp.breakEven(history, valuation);
  for (const [m0, e] of Object.entries(splits)) expectClose(decomp.splitAtM0(be, Number(m0)), e, TOL.stats, `splitAtM0(${m0})`);
});

test('robust: isoVolTe bootstrap percentiles (ported mulberry32)', { skip }, () => {
  for (const [name, e] of Object.entries(X.robust.bootstrapIsoVolTe)) {
    const sample = series.buildSample(history, scenarioOpts(name));
    const res = robust.bootstrapRule(sample, 'isoVolTe', e.params, { mu: 'hist' }, { B: e.B, block: e.block, seed: e.seed });
    expectClose(pick(res, ['B', 'block', 'seed', 'nFeasible', 'weights', 'probUstOver50', 'probSpxUnder1', 'probCorner', 'probInfeasible']),
      pick(e, ['B', 'block', 'seed', 'nFeasible', 'weights', 'probUstOver50', 'probSpxUnder1', 'probCorner', 'probInfeasible']), TOL.bootstrap, `bootstrap.${name}`);
    e.firstDraws.forEach((w, b) => expectClose(Array.from(res.draws.subarray(3 * b, 3 * b + 3)), w, 1e-6, `bootstrap.${name}.draw[${b}]`)); // Float32 draws
  }
});

test('robust: short samples (n < 96) use the effective block in sharpeDiffCI and the isoVolTe bootstrap', { skip }, () => {
  assert.ok(X.robust.shortSample && Object.keys(X.robust.shortSample).length >= 2, RERUN);
  const KEYS = ['B', 'block', 'seed', 'nFeasible', 'weights', 'probUstOver50', 'probSpxUnder1', 'probCorner', 'probInfeasible'];
  for (const [name, e] of Object.entries(X.robust.shortSample)) {
    const sample = series.buildSample(history, { ...e.state, end: e.state.end ?? X.latest });
    assert.equal(sample.n, e.n, `${name} n`);
    assert.ok(e.sharpeDiffCI.block < 24 && e.sharpeDiffCI.hi - e.sharpeDiffCI.lo > 0.1, `${name}: python CI collapsed`);
    expectClose(stats.sharpeDiffCI(sample, 0, 1, { seed: X.conventions.seed }), e.sharpeDiffCI, TOL.stats, `${name}.sharpeDiffCI`); // default block 24 requested
    const bs = e.bootstrapIsoVolTe, res = robust.bootstrapRule(sample, 'isoVolTe', bs.params, { mu: 'hist' }, { B: bs.B, seed: bs.seed });
    expectClose(pick(res, KEYS), pick(bs, KEYS), TOL.bootstrap, `${name}.bootstrap`);
    bs.firstDraws.forEach((w, b) => expectClose(Array.from(res.draws.subarray(3 * b, 3 * b + 3)), w, 1e-6, `${name}.bootstrap.draw[${b}]`));
  }
});

for (const [key, e] of Object.entries(X.robust.walkForwardIsoVolTe)) {
  test(`robust: walkForward isoVolTe ${key}`, { skip }, () => {
    const res = robust.walkForward(history, scenarioOpts(e.scenario), 'isoVolTe', e.params, { mu: 'hist' }, { window: e.window, lookbackYears: 10 });
    assert.equal(res.status, e.status);
    assert.equal(res.firstOos, e.firstOos);
    assert.equal(res.months, e.months);
    assert.equal(res.weights.length, e.weights.length);
    e.weights.forEach((x, i) => {
      const got = res.weights[i];
      assert.deepEqual([got.month, got.estFrom, got.estTo], [x.month, x.estFrom, x.estTo], `weights[${i}] dates`);
      expectClose(got.w, x.w, TOL.weightsExact, `weights[${i}].w`);
    });
    expectClose(res.stats, e.stats, TOL.stats, 'stats');
    expectClose(res.relToSpx.at(-1), e.relToSpxEnd, TOL.stats, 'relToSpxEnd');
    expectClose(res.inSampleStatic.w, e.inSampleStatic.w, TOL.weightsExact, 'inSampleStatic.w');
    expectClose(res.inSampleStatic.stats, e.inSampleStatic.stats, TOL.stats, 'inSampleStatic.stats');
    assert.equal(res.ustOver50Years, e.ustOver50Years);
    expectClose(res.y2022, e.y2022, TOL.stats, 'y2022');
  });
}
