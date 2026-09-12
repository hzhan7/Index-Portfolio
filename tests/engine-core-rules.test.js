import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveJob } from '../docs/assets/js/engine/params.js?v=20260912';
import { buildSample, yieldToAnnualReturn } from '../docs/assets/js/engine/series.js?v=20260912';
import { pathStats, portfolioReturns } from '../docs/assets/js/engine/stats.js?v=20260912';
import { leveredReturns, tangency as tangencyPoint } from '../docs/assets/js/engine/frontier.js?v=20260912';
import { askedPortfolios, calendarReturn, custom, defaultCustomWeights, isoFeasibility, isoVolTe, leveredTangency, makeCtx, maxSharpeCagrFloor,
  references, solveIsoVolTe, tangency, twoAsset } from '../docs/assets/js/engine/rules.js?v=20260912';

const bytes = f => readFileSync(new URL(`../${f}`, import.meta.url));
const doc = JSON.parse(bytes('docs/data/history.json'));
const tr = buildSample(doc, { start: '1985-01' }), ctx = makeCtx(tr);
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const quad = (w, C) => dot(w, [dot(C[0], w), dot(C[1], w), dot(C[2], w)]);
const code = c => err => err.code === c;

// Independent reference: bisection on the target return t; each constraint is an interval on the μ-level segment.
function isoBisection(mu, cov, V, K) {
  const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const segment = t => {
    const pts = [];
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      if (Math.abs(mu[a] - mu[b]) < 1e-15) { if (Math.abs(mu[a] - t) < 1e-15) pts.push(E[a], E[b]); continue; }
      const lam = (t - mu[b]) / (mu[a] - mu[b]);
      if (lam >= -1e-14 && lam <= 1 + 1e-14) { const l = Math.min(1, Math.max(0, lam)); pts.push(E[a].map((x, i) => l * x + (1 - l) * E[b][i])); }
    }
    let best = null;
    for (const p of pts) for (const q of pts) { const d = p.reduce((s, x, i) => s + Math.abs(x - q[i]), 0); if (!best || d > best[2]) best = [p, q, d]; }
    return best;
  };
  const interval = (p, d, centre, cap2) => {
    const u = p.map((x, i) => x - centre[i]), Sd = [dot(cov[0], d), dot(cov[1], d), dot(cov[2], d)];
    const a = dot(d, Sd), b = 2 * dot(u, Sd), c = quad(u, cov) - cap2;
    if (a < 1e-18) return c <= 0 ? [-Infinity, Infinity] : null;
    const disc = b * b - 4 * a * c;
    return disc < 0 ? null : [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)];
  };
  const feasibleAt = t => {
    const seg = segment(t);
    if (!seg) return null;
    const [p, q] = seg, d = q.map((x, i) => x - p[i]);
    let lo = 0, hi = 1;
    for (const [centre, cap2] of [[[0, 0, 0], V * V], ...(K == null ? [] : [[[0, 1, 0], K * K]])]) {
      const iv = interval(p, d, centre, cap2);
      if (!iv) return null;
      lo = Math.max(lo, iv[0]); hi = Math.min(hi, iv[1]);
    }
    return lo > hi ? null : p.map((x, i) => x + ((lo + hi) / 2) * d[i]);
  };
  const tlo = Math.min(...mu), thi = Math.max(...mu), ts = Array.from({ length: 4001 }, (_, i) => tlo + ((thi - tlo) * i) / 4000);
  let idx = -1;
  ts.forEach((t, i) => { if (feasibleAt(t)) idx = i; });
  if (idx < 0) return null;
  let lo = ts[idx], hi = ts[Math.min(idx + 1, 4000)];
  if (feasibleAt(hi)) lo = hi;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (feasibleAt(mid)) lo = mid; else hi = mid; }
  return feasibleAt(lo);
}

// KKT certificate: μ = ν·1 + λv·2Σw + λt·2Σ(w−e) − Σ η_i e_i with λ, η ≥ 0 on active constraints only.
function kktCertified(mu, cov, w, V, K) {
  const Sw = [dot(cov[0], w), dot(cov[1], w), dot(cov[2], w)], d = [w[0], w[1] - 1, w[2]], Sd = [dot(cov[0], d), dot(cov[1], d), dot(cov[2], d)];
  const ineq = [];
  if (Math.abs(quad(w, cov) - V * V) <= 1e-9 * V * V) ineq.push(Sw.map(x => 2 * x));
  if (K != null && Math.abs(quad(d, cov) - K * K) <= 1e-9 * K * K) ineq.push(Sd.map(x => 2 * x));
  w.forEach((x, i) => { if (x <= 1e-12) ineq.push([0, 1, 2].map(j => (j === i ? -1 : 0))); });
  const subsets = [[]];
  for (let a = 0; a < ineq.length; a++) { subsets.push([a]); for (let b = a + 1; b < ineq.length; b++) subsets.push([a, b]); }
  for (const sub of subsets) {
    const cols = [[1, 1, 1], ...sub.map(k => ineq[k])], m = cols.length;
    const A = cols.map(ci => cols.map(cj => dot(ci, cj))), rhs = cols.map(ci => dot(ci, mu));
    for (let k = 0; k < m; k++) { // Gaussian elimination
      let p = k; for (let i = k + 1; i < m; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i;
      [A[k], A[p]] = [A[p], A[k]]; [rhs[k], rhs[p]] = [rhs[p], rhs[k]];
      if (Math.abs(A[k][k]) < 1e-18) break;
      for (let i = 0; i < m; i++) if (i !== k) { const f = A[i][k] / A[k][k]; for (let j = k; j < m; j++) A[i][j] -= f * A[k][j]; rhs[i] -= f * rhs[k]; }
    }
    const x = rhs.map((v, k) => v / A[k][k]);
    if (!x.every(Number.isFinite) || x.slice(1).some(v => v < -1e-10)) continue;
    const resid = [0, 1, 2].map(i => mu[i] - cols.reduce((s, c, k) => s + x[k] * c[i], 0));
    if (Math.max(...resid.map(Math.abs)) <= 1e-8) return true;
  }
  return false;
}

const CASES = [['1985-01', null, 'tr', 1, 0.05], ['1985-01', null, 'tr', 1, null], ['1985-01', null, 'tr', 1, 0.02], ['1985-01', '2007-12', 'tr', 1, 0.05],
  ['2009-03', null, 'tr', 0.8, 0.08], ['1985-01', null, 'tr', 1.1, 0.08], ['1985-01', null, 'pr', 1, 0.05], ['2016-08', null, 'tr', 0.9, 0.03],
  ['2000-03', null, 'tr', 1, null], ['1999-03', null, 'tr', 0.7, null], ['1985-01', null, 'tr', 0.7, 0.02]];

test('isoVolTe exact enumeration matches an independent bisection solver and carries a KKT certificate', () => {
  for (const [start, end, basis, m, k] of CASES) {
    const s = buildSample(doc, { start, end, basis }), c = makeCtx(s), V = m * c.sigmaSpx, label = `${start}-${end} ${basis} m=${m} k=${k}`;
    const exact = solveIsoVolTe(c.muUsed, c.cov, m, k), ref = isoBisection(c.muUsed, c.cov, V, k);
    if (!ref) { assert.equal(exact, null, label); continue; }
    assert.ok(exact, `${label} infeasible`);
    assert.ok(Math.max(...exact.map((x, i) => Math.abs(x - ref[i]))) <= 1e-6, `${label}: ${exact} vs ${ref}`);
    assert.ok(dot(c.muUsed, exact) >= dot(c.muUsed, ref) - 1e-12, label);
    close(exact[0] + exact[1] + exact[2], 1, 1e-12); assert.ok(exact.every(x => x >= 0));
    assert.ok(quad(exact, c.cov) <= V * V * (1 + 1e-12) && (k == null || quad([exact[0], exact[1] - 1, exact[2]], c.cov) <= k * k * (1 + 1e-12)), label);
    assert.ok(kktCertified(c.muUsed, c.cov, exact, V, k), `${label}: no KKT certificate`);
  }
});

test('isoVolTe solve < 1 ms and the full rule result is consistent (binding, pure, path, flat top, μ shifts)', () => {
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) solveIsoVolTe(ctx.muUsed, ctx.cov, 1, 0.05);
  assert.ok((performance.now() - t0) / 1000 < 1, 'isoVolTe solve ≥ 1 ms');
  const r = isoVolTe(tr, { volMult: 1, teCap: 0.05 }, ctx);
  assert.equal(r.status, 'ok');
  close(r.model.vol, r.stats.vol, 1e-12, 'model vs path vol');
  close(r.model.te, r.vsSpx.te, 1e-12, 'model vs path TE');
  assert.equal(r.binding.vol, Math.abs(r.model.vol - ctx.sigmaSpx) < 1e-9);
  assert.ok(r.pure.teUnconstrained >= 0.05 || !r.binding.te);
  const ii = r.pure.impliedIntercept;
  if (ii?.kind === 'point') tangencyPoint(ctx.muUsed, ctx.cov, ii.c).w.forEach((x, i) => close(x, r.pure.w[i], 1e-7, 'tangency at c* = pure iso-vol'));
  const ks = r.path.map(p => p.k);
  for (const k of [0.02, 0.03, 0.04, 0.05]) if (k <= r.pure.teUnconstrained) assert.ok(ks.includes(k));
  r.path.forEach(p => { if (p.k < r.pure.teUnconstrained - 1e-9) close(p.te, p.k, 1e-9, 'path TE'); });
  assert.deepEqual(r.path.at(-1).w, r.pure.w);
  if (r.flatTop) assert.equal(r.flatTop.ndxTo, r.pure.w[0]);
  const [w1, w2] = r.muShift.map(x => x.w);
  assert.ok(w1[0] <= r.w[0] + 1e-9 && w2[0] <= w1[0] + 1e-9, 'lower NDX μ never raises NDX weight');
});

test('isoVolTe feasibility thresholds are tight', () => {
  const f = isoFeasibility(ctx.cov, 0.8), chips = ['0.02', '0.03', '0.04', '0.05', '0.06', '0.08', 'none'];
  chips.slice(1).forEach((k, i) => assert.ok(f.minVolMultByTe[k] <= f.minVolMultByTe[chips[i]] + 1e-12));
  const m5 = f.minVolMultByTe['0.05'];
  assert.ok(solveIsoVolTe(ctx.muUsed, ctx.cov, m5 * (1 + 1e-7), 0.05) && !solveIsoVolTe(ctx.muUsed, ctx.cov, m5 * (1 - 1e-7), 0.05));
  const kMin = f.minTeForVolCap;
  assert.ok(kMin > 0 && solveIsoVolTe(ctx.muUsed, ctx.cov, 0.8, kMin * (1 + 1e-7)) && !solveIsoVolTe(ctx.muUsed, ctx.cov, 0.8, kMin * (1 - 1e-7)));
  assert.equal(isoFeasibility(ctx.cov, 1).minTeForVolCap, 0);
  const bad = isoVolTe(tr, { volMult: 0.7, teCap: 0.02 }, ctx);
  assert.equal(bad.status, 'infeasible'); assert.equal(bad.w, null); assert.ok(bad.feasibility.minTeForVolCap > 0.02); assert.equal(typeof bad.note, 'string');
});

test('maxSharpeCagrFloor keeps CAGR ≥ SPX and reports the floor binding', () => {
  const r = maxSharpeCagrFloor(tr, {}, ctx);
  assert.equal(r.status, 'ok');
  assert.ok(r.vsSpx.cagr >= -1e-9);
  assert.equal(typeof r.binding.cagrFloor, 'boolean');
  close(r.stats.cagr, pathStats(portfolioReturns(tr, r.w), tr.rf).cagr, 1e-15);
});

test('tangency rule: intercepts, implied point, kinked leverage path and calendar-2022 returns', () => {
  const r = tangency(tr, {}, ctx), pure = solveIsoVolTe(ctx.muUsed, ctx.cov, 1, null);
  assert.equal(r.c, r.implied.c); assert.equal(r.atLeast, false);
  r.w.forEach((x, i) => close(x, pure[i], 1e-7));
  close(r.cRf, ctx.rfAnn, 1e-15); close(r.cY10, yieldToAnnualReturn(tr.dgs10End), 1e-15);
  assert.equal(tangency(tr, { intercept: 'rf' }, ctx).c, ctx.rfAnn);
  assert.equal(tangency(tr, { intercept: 'custom', interceptC: 0.07 }, ctx).c, 0.07);
  const none = tangency(tr, { intercept: 'custom', interceptC: null }, ctx);
  assert.equal(none.status, 'undefined'); assert.equal(none.w, null);
  const lev = r.levered;
  assert.ok(['lever', 'delever', 'frontier'].includes(lev.mode));
  if (lev.mode !== 'frontier') close(lev.L * Math.sqrt(quad(lev.w, ctx.cov)), lev.targetVol, 1e-12, 'L·σ_T');
  lev.notional.forEach((x, i) => close(x, lev.L * lev.w[i], 1e-15));
  const path = leveredReturns(tr, lev.w, lev.L, lev.spread);
  close(lev.stats.cagr, pathStats(path, tr.rf).cagr, 1e-15);
  assert.deepEqual(lev.y2022, { rule: calendarReturn(tr.months, path, '2022'), spx: calendarReturn(tr.months, tr.R[1], '2022') });
  const vertex = tangency(buildSample(doc, { start: '2000-03' }), {});
  if (vertex.impliedIntercept?.kind === 'interval') assert.equal(vertex.atLeast, vertex.impliedIntercept.openAbove);
});

test('vertex implied intercept: cRange is reported and "≥ cLow" (atLeast) holds only when no higher-beta asset takes over above cHigh', () => {
  // 100% SPX bounded above by NDX (β > 1): above cHigh the tangency leaves the vertex, so "≥ cLow" would be false
  for (const o of [{ start: '2024-08', end: '2026-08' }, { start: '2000-03' }]) {
    const s = buildSample(doc, o), c = makeCtx(s), r = tangency(s, {}, c), ii = r.impliedIntercept, label = JSON.stringify(o);
    assert.deepEqual([ii.kind, ii.vertex, ii.openAbove], ['interval', 1, false], label);
    assert.deepEqual([r.atLeast, r.implied.atLeast], [false, false], label);
    assert.deepEqual(r.cRange, [ii.cLow, ii.cHigh], label); assert.deepEqual(r.implied.cRange, r.cRange, label);
    assert.ok(ii.cHigh < c.muUsed[1] - 1e-6, label);
    assert.ok(tangencyPoint(c.muUsed, c.cov, (ii.cLow + ii.cHigh) / 2).w[1] >= 1 - 1e-9, `${label}: inside the interval`);
    assert.ok(tangencyPoint(c.muUsed, c.cov, ii.cHigh + 1e-4).w[1] < 1 - 1e-6, `${label}: still 100% SPX above cHigh`);
  }
  // 100% UST with the highest μ (2000-03…2002-03): open above, every c in [cLow, μ_UST) gives the vertex
  const s = buildSample(doc, { start: '2000-03', end: '2002-03' }), c = makeCtx(s), r = tangency(s, {}, c), ii = r.impliedIntercept;
  assert.deepEqual([ii.kind, ii.vertex, ii.openAbove, r.atLeast, r.implied.atLeast], ['interval', 2, true, true, true]);
  for (const x of [ii.cLow + 1e-6, (ii.cLow + c.muUsed[2]) / 2, c.muUsed[2] - 1e-6]) assert.ok(tangencyPoint(c.muUsed, c.cov, x).w[2] >= 1 - 1e-9, `c ${x}`);
  const atRf = tangency(s, { intercept: 'rf' }, c);
  assert.deepEqual([atRf.atLeast, atRf.cRange], [false, null]);
});

test('tangency.atY10 is the unlevered tangency at the converted sample-end 10Y yield for every intercept', () => {
  const atY10 = tangency(tr, { intercept: 'y10' }, ctx).unlevered;
  assert.equal(atY10.status, 'ok'); assert.equal(atY10.c, yieldToAnnualReturn(tr.dgs10End));
  tangencyPoint(ctx.muUsed, ctx.cov, ctx.y10).w.forEach((x, i) => assert.equal(atY10.w[i], x));
  assert.deepEqual(Object.keys(atY10.model).sort(), ['mu', 'te', 'vol']);
  for (const params of [{}, { intercept: 'rf' }, { intercept: 'custom', interceptC: 0.07 }, { intercept: 'custom', interceptC: null }]) {
    assert.deepEqual(tangency(tr, params, ctx).atY10, atY10, JSON.stringify(params));
  }
  close(atY10.model.vol, atY10.stats.vol, 1e-12, 'atY10 model vs path vol');
  close(atY10.model.te, atY10.vsSpx.te, 1e-12, 'atY10 model vs path TE');
  const y = makeCtx(tr, { mu: 'y10bond' }), ry = tangency(tr, {}, y);
  tangencyPoint(y.muUsed, y.cov, y.y10).w.forEach((x, i) => assert.equal(ry.atY10.w[i], x));
});

test('tangency.atRf is the unlevered tangency at the sample rf for every intercept; levered.cUsed names the intercept levered', () => {
  const atRf = tangency(tr, { intercept: 'rf' }, ctx).unlevered;
  assert.equal(atRf.status, 'ok'); assert.equal(atRf.c, ctx.rfAnn);
  tangencyPoint(ctx.muUsed, ctx.cov, ctx.rfAnn).w.forEach((x, i) => assert.equal(atRf.w[i], x));
  for (const params of [{}, { intercept: 'y10' }, { intercept: 'custom', interceptC: 0.07 }, { intercept: 'custom', interceptC: null }]) {
    const r = tangency(tr, params, ctx);
    assert.deepEqual(r.atRf, atRf, JSON.stringify(params));
    close(r.atRf.model.vol, r.atRf.stats.vol, 1e-12, 'atRf model vs path vol');
  }
  const modes = new Set();
  for (const [spread, volMult] of [[0.005, 1], [0, 1], [0.005, 0.5], [0.01, 0.6], [0.01, 1]]) {
    const k = leveredTangency(tr, ctx, { spread, volMult }), label = `spread ${spread} vm ${volMult} ${k.mode}`;
    modes.add(k.mode);
    if (k.mode === 'lever') { assert.equal(k.cUsedKind, 'borrow', label); assert.equal(k.cUsed, ctx.rfAnn + spread, label); }
    else if (k.mode === 'delever') { assert.equal(k.cUsedKind, 'lend', label); assert.equal(k.cUsed, ctx.rfAnn, label); }
    else { assert.equal(k.cUsedKind, 'frontier', label); assert.ok(k.cUsed > ctx.rfAnn && k.cUsed < ctx.rfAnn + spread, `${label}: ${k.cUsed}`); }
    tangencyPoint(ctx.muUsed, ctx.cov, k.cUsed).w.forEach((x, i) => close(x, k.w[i], 1e-7, `${label}: tangency at cUsed = levered w`));
  }
  assert.deepEqual([...modes].sort(), ['delever', 'frontier', 'lever']);
});

test('twoAsset: analytic roots solve their equations, trivial SPX roots are excluded, best respects the CAGR floor', () => {
  for (const pair of [[0, 2], [1, 2], [0, 1]]) {
    const r = twoAsset(tr, { pair }, ctx), at = x => { const w = [0, 0, 0]; w[pair[0]] += x; w[pair[1]] += 1 - x; return pathStats(portfolioReturns(tr, w), tr.rf); };
    const spx = ctx.spx, label = pair.join('-');
    assert.equal(r.curve.x.length, 1001);
    r.roots.sharpeEqSpx.forEach(x => close(at(x).sharpe, spx.sharpe, 1e-9, `${label} sharpe root`));
    r.roots.cagrEqSpx.forEach(x => close(at(x).cagr, spx.cagr, 1e-9, `${label} cagr root`));
    r.roots.volEqSpx.forEach(x => close(at(x).vol, spx.vol, 1e-9, `${label} vol root`));
    const trivialX = pair[0] === 1 ? 1 : pair[1] === 1 ? 0 : null;
    for (const list of [r.roots.sharpeEqSpx, r.roots.cagrEqSpx, r.roots.volEqSpx]) assert.ok(!list.some(x => trivialX != null && Math.abs(x - trivialX) < 1e-9));
    if (trivialX == null) assert.deepEqual(r.roots.trivial, []);
    else assert.ok(r.roots.trivial.every(x => x === trivialX));
    assert.equal(r.headline, r.roots.sharpeEqSpx.length ? Math.max(...r.roots.sharpeEqSpx) : null);
    const b = r.best.maxSharpeCagrFloor;
    if (b != null) {
      assert.ok(at(b).cagr >= spx.cagr - 1e-12);
      for (let k = 0; k <= 1000; k++) if (r.curve.cagr[k] >= spx.cagr) assert.ok(at(b).sharpe >= r.curve.sharpe[k] - 1e-9, `${label} curve beats best`);
    }
    if (r.status === 'none') assert.equal(r.roots.sharpeEqSpx.length, 0);
    if (r.status === 'all-above') for (let k = Math.ceil(r.headline * 1000) + 2; k < 1000; k++) assert.ok(r.curve.sharpe[k] > spx.sharpe, `${label} not above at ${k}`);
    r.points.forEach((p, i) => { if (i) assert.ok(p.x - r.points[i - 1].x > 1e-4); close(p.w[pair[0]], p.x, 1e-15); assert.equal(p.id, p.ids.join('+')); });
  }
});

test('custom weights, references and the asked-portfolio table', () => {
  assert.throws(() => custom(tr, { w: [0.5, 0.6, 0] }, ctx), code('E_BAD_WEIGHTS'));
  assert.throws(() => custom(tr, { w: [-0.1, 0.6, 0.5] }, ctx), code('E_BAD_WEIGHTS'));
  assert.deepEqual(custom(tr, { w: [40, 40, 20] }, ctx).w, [0.4, 0.4, 0.2]);
  const d = defaultCustomWeights(ctx, { volMult: 1, teCap: 0.05 }), iso = solveIsoVolTe(ctx.muUsed, ctx.cov, 1, 0.05);
  assert.equal(d.reduce((s, x) => s + Math.round(x * 100), 0), 100);
  d.forEach((x, i) => assert.ok(Math.abs(x - iso[i]) < 0.01 && Number.isInteger(Math.round(x * 1e6) / 1e4)));
  const refs = references(tr, ctx);
  assert.deepEqual(refs.map(r => r.id), ['spx', 'ndx', 'sixty40', 'ndxSpx5050']);
  const rules = { isoVolTe: isoVolTe(tr, {}, ctx), maxSharpeCagrFloor: maxSharpeCagrFloor(tr, {}, ctx), tangency: tangency(tr, {}, ctx), twoAssetNdxUst: twoAsset(tr, { pair: [0, 2] }, ctx) };
  const asked = askedPortfolios({ rules, references: refs });
  assert.deepEqual(asked.map(a => a.id), ['spx', 'ndxUstSharpeEqSpx', 'ndxUstCagrEqSpx', 'maxSharpeCagrFloor', 'isoVolTe', 'tangencyLevered', 'ndx', 'sixty40', 'ndxSpx5050']);
  assert.deepEqual(asked.map(a => a.group), [...Array(7).fill('asked'), 'reference', 'reference']);
  assert.equal(asked[4].w, rules.isoVolTe.w);
  assert.deepEqual(asked[5].notional, rules.tangency.levered.notional);
  assert.ok(asked.every(a => a.oos === null));
});

test('y10bond replaces UST μ with the converted 10Y yield plus σ²/2 and requires the tr basis', () => {
  const y = makeCtx(tr, { mu: 'y10bond' });
  close(y.muUsed[2], yieldToAnnualReturn(tr.dgs10End) + ctx.cov[2][2] / 2, 1e-15);
  assert.deepEqual(y.muUsed.slice(0, 2), ctx.muUsed.slice(0, 2));
  const r = isoVolTe(tr, {}, y);
  assert.notDeepEqual(r.w, isoVolTe(tr, {}, ctx).w);
  close(r.stats.cagr, pathStats(portfolioReturns(tr, r.w), tr.rf).cagr, 1e-15);
  assert.throws(() => makeCtx(buildSample(doc, { start: '1985-01', basis: 'pr' }), { mu: 'y10bond' }), code('E_Y10_REQUIRES_TR'));
});

test('resolveJob: defaults, per-kind keys, percent normalisation and validation', () => {
  const base = resolveJob({}, { latest: '2026-08' });
  assert.deepEqual(base.sample, { start: '1985-01', end: '2026-08', basis: 'tr', ndxDiv: 'default', wht: 0 });
  assert.deepEqual(base.rule, { id: 'isoVolTe', params: { volMult: 1, teCap: 0.05 } });
  const diff = (a, b) => Object.keys(a.keys).filter(k => a.keys[k] !== b.keys[k]).sort();
  const at = s => resolveJob(s, { latest: '2026-08' });
  assert.deepEqual(diff(base, at({ volMult: 0.9 })), ['alloc', 'robust']);
  assert.deepEqual(diff(base, at({ start: '1999-03' })), ['alloc', 'robust', 'sample']);
  assert.deepEqual(diff(base, at({ basis: 'pr' })), ['alloc', 'context', 'robust', 'sample']);
  assert.deepEqual(diff(base, at({ wfWindow: 'expanding' })), ['robust']);
  assert.deepEqual(diff(base, at({ roll: 5 })), ['context']);
  assert.deepEqual(diff(base, at({ ternaryMetric: 'cagr', fill: 1 })), []);
  const p = at({ wht: 30, teCap: 5, spread: 0.5, interceptC: 7, pair: '1-2', customW: [40, 40, 20] });
  assert.equal(p.sample.wht, 0.3); assert.equal(p.params.isoVolTe.teCap, 0.05); assert.equal(p.params.tangency.spread, 0.005);
  assert.equal(p.params.tangency.interceptC, 0.07); assert.deepEqual(p.params.twoAsset.pair, [1, 2]); assert.deepEqual(p.params.custom.w, [0.4, 0.4, 0.2]);
  assert.equal(at({ teCap: null }).params.isoVolTe.teCap, null);
  assert.throws(() => at({ basis: 'pr', mu: 'y10bond' }), code('E_Y10_REQUIRES_TR'));
  assert.throws(() => at({ customW: [50, 60, 0] }), code('E_BAD_WEIGHTS'));
  assert.throws(() => at({ pair: [2, 0] }), code('E_BAD_RANGE'));
  assert.throws(() => at({ rule: 'nope' }), code('E_BAD_RANGE'));
});

test('resolveJob rejects non-finite, out-of-range or unknown state values with E_BAD_RANGE (the CLI bypasses ui/state.js)', () => {
  const at = s => resolveJob(s, { latest: '2026-08' });
  const show = s => JSON.stringify(s, (k, v) => (Number.isNaN(v) ? 'NaN' : v));
  const bad = [{ volMult: NaN }, { volMult: 'abc' }, { volMult: 0 }, { volMult: null }, { teCap: NaN }, { teCap: 'x' }, { teCap: -1 }, { spread: NaN },
    { spread: -0.5 }, { interceptC: NaN }, { wht: NaN }, { wht: -1 }, { wht: 150 }, { m0: 0 }, { m0: 'x' }, { roll: NaN }, { roll: 7 },
    { rollVm: 'maybe' }, { wfWindow: 'bogus' }, { mu: 'nope' }, { intercept: 'nope' }, { basis: 'xx' }, { ndxDiv: 'mid' }];
  for (const s of bad) assert.throws(() => at(s), code('E_BAD_RANGE'), show(s));
  for (const s of [{ teCap: null }, { teCap: 0 }, { interceptC: null }, { intercept: 'custom', interceptC: -0.01 }, { spread: 0 }, { m0: 2.5 },
    { m0: null }, { roll: 20 }, { rollVm: true }, { rollVm: 0 }, { wfWindow: 'expanding' }, { volMult: '0.9' }, { wht: 30 }]) assert.doesNotThrow(() => at(s), show(s));
});

// Core solver outputs vs the independent Python cross-check (skipped when inputs changed since it was generated).
const XC = 'data/validation/crosscheck_v2.json';
const xc = existsSync(new URL(`../${XC}`, import.meta.url)) ? JSON.parse(bytes(XC)) : null;
const sha = f => createHash('sha256').update(bytes(f)).digest('hex');
const fresh = xc && xc.inputSha256?.history === sha('docs/data/history.json') && xc.inputSha256?.valuation === sha('docs/data/valuation.json');
test('isoVolTe / tangency / twoAsset agree with crosscheck_v2.json', { skip: fresh ? false : 'crosscheck missing or stale: rerun python3 scripts/validation/crosscheck_v2.py' }, () => {
  for (const [name, state] of Object.entries(xc.conventions.scenarioState)) {
    const s = buildSample(doc, state), c = makeCtx(s), e = xc.scenarios[name];
    for (const x of e.isoVolTe) {
      const w = solveIsoVolTe(c.muUsed, c.cov, x.params.volMult, x.params.teCap);
      assert.equal(!w, !x.w, `${name} feasibility ${JSON.stringify(x.params)}`);
      if (w) w.forEach((v, i) => close(v, x.w[i], 1e-6, `${name} iso ${JSON.stringify(x.params)}`));
    }
    const t = tangency(s, { intercept: 'rf' }, c);
    t.w.forEach((v, i) => close(v, e.tangency.rf.w[i], 1e-6, `${name} tangency rf`));
    close(t.c, e.tangency.rf.c, 1e-12);
    for (const [pk, ta] of Object.entries(e.twoAsset ?? {})) {
      const r = twoAsset(s, { pair: pk.split('-').map(Number) }, c);
      for (const k of ['sharpeEqSpx', 'cagrEqSpx', 'volEqSpx']) { assert.equal(r.roots[k].length, ta.roots[k].length, `${name} ${pk} ${k}`); r.roots[k].forEach((v, i) => close(v, ta.roots[k][i], 1e-6)); }
      assert.equal(r.status, ta.status, `${name} ${pk} status`);
    }
  }
});
