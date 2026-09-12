import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSample } from '../docs/assets/js/engine/series.js?v=20260912';
import { moments, mulberry32, pathStats, portfolioReturns } from '../docs/assets/js/engine/stats.js?v=20260912';
import { impliedIntercept, kinkedCal, leveredReturns, maxReturnInEllipses, minQuadOnSimplex, planeEllipse, solveFrontier, tangency,
  tangencyPath } from '../docs/assets/js/engine/frontier.js?v=20260912';
import { optimizePortfolios } from '../docs/assets/js/engine/history-objectives.js?v=20260912';

const doc = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const s = buildSample(doc, { start: '1985-01' });
const { mu, cov, rfAnn } = moments(s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vol = w => Math.sqrt(dot(w, [dot(cov[0], w), dot(cov[1], w), dot(cov[2], w)]));
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const rng = mulberry32(7);
const randomW = () => { const r = [rng(), rng(), rng()], t = r[0] + r[1] + r[2]; return r.map(x => x / t); };
const RANDOM = Array.from({ length: 3000 }, randomW);
const longOnly = w => { close(w[0] + w[1] + w[2], 1, 1e-12, 'sum'); assert.ok(w.every(x => x >= 0)); };

test('frontier: long-only, μ and vol non-decreasing, and no portfolio with at least the same μ has lower vol', () => {
  const f = solveFrontier(mu, cov);
  assert.equal(f.frontier.length, 121);
  assert.equal(f.frontier[0], f.gmv);
  assert.equal(f.frontier.at(-1), f.maxReturn);
  f.frontier.forEach((p, i) => {
    longOnly(p.w);
    if (i) { assert.ok(p.mu >= f.frontier[i - 1].mu - 1e-12); assert.ok(p.vol >= f.frontier[i - 1].vol - 1e-12); }
  });
  for (const w of RANDOM) {
    const m = dot(w, mu);
    for (const p of f.frontier) if (m >= p.mu) assert.ok(vol(w) >= p.vol - 1e-12, `random ${w} beats frontier at μ ${p.mu}`);
  }
});

test('tangency: the line from c dominates every portfolio, statuses, and implied intercept round-trips', () => {
  for (const c of [rfAnn, 0.0475, 0.06]) {
    const t = tangency(mu, cov, c);
    assert.equal(t.status, 'ok');
    longOnly(t.w);
    for (const w of RANDOM) if (dot(w, mu) > c) assert.ok((dot(w, mu) - c) / vol(w) <= t.slope + 1e-12);
    const ii = impliedIntercept(mu, cov, t.w);
    assert.equal(ii.kind, 'point');
    close(ii.c, c, 1e-9, 'implied c');
    assert.ok(ii.gamma > 0);
  }
  assert.equal(tangency(mu, cov, 1).status, 'no-premium');
  assert.equal(tangency(mu, cov, 1).w, null);
  assert.equal(impliedIntercept(mu, cov, [0.3, 0.05, 0.65]), null);
});

test('vertex intercept interval: 100% NDX is the tangency exactly from cLow', () => {
  const ii = impliedIntercept(mu, cov, [1, 0, 0]);
  assert.equal(ii.kind, 'interval');
  assert.ok(ii.cLow < ii.cHigh && ii.cHigh <= mu[0]);
  assert.ok(tangency(mu, cov, ii.cLow + 1e-6).w[0] >= 1 - 1e-9);
  assert.ok(tangency(mu, cov, ii.cLow - 1e-4).w[0] < 1 - 1e-6);
});

test('tangencyPath: μ non-decreasing in c and thresholds bracket their weight conditions', () => {
  const p = tangencyPath(mu, cov, { cMin: rfAnn - 0.02, cMax: mu[0] - 1e-6 });
  const pts = p.points.filter(x => x.w);
  pts.forEach((x, i) => { if (i) assert.ok(x.mu >= pts[i - 1].mu - 1e-12, `μ decreases at c=${x.c}`); });
  const w = c => tangency(mu, cov, c).w;
  assert.ok(w(p.cUstUnder50 + 1e-6)[2] < 0.5 && w(p.cUstUnder50 - 1e-6)[2] >= 0.5);
  assert.ok(w(p.cZeroUst + 1e-6)[2] <= 1e-8 && w(p.cZeroUst - 1e-6)[2] > 1e-8);
  close(p.cAllNdx, impliedIntercept(mu, cov, [1, 0, 0]).cLow, 1e-6, 'cAllNdx');
  assert.ok(p.cUstUnder50 < p.cZeroUst && p.cZeroUst < p.cAllNdx);
});

test('kinkedCal: lever T_b above its vol, de-lever T_l below its vol, unlevered frontier point in between', () => {
  const spread = 0.02, tb = tangency(mu, cov, rfAnn + spread), tl = tangency(mu, cov, rfAnn);
  assert.ok(tl.vol < tb.vol);
  const lev = kinkedCal(mu, cov, { rfAnn, spread, targetVol: 1.2 * tb.vol });
  assert.equal(lev.mode, 'lever'); assert.deepEqual(lev.w, tb.w); close(lev.L, 1.2, 1e-12);
  close(lev.expReturn, 1.2 * tb.mu - 0.2 * rfAnn - 0.2 * spread, 1e-15);
  close(lev.borrow, 0.2, 1e-12); assert.equal(lev.lend, 0);
  const del = kinkedCal(mu, cov, { rfAnn, spread, targetVol: 0.8 * tl.vol });
  assert.equal(del.mode, 'delever'); assert.deepEqual(del.w, tl.w); close(del.L, 0.8, 1e-12);
  close(del.expReturn, 0.8 * tl.mu + 0.2 * rfAnn, 1e-15);
  const target = (tl.vol + tb.vol) / 2, mid = kinkedCal(mu, cov, { rfAnn, spread, targetVol: target });
  assert.equal(mid.mode, 'frontier'); assert.equal(mid.L, 1); close(vol(mid.w), target, 1e-10);
  assert.ok(dot(mid.w, mu) > tl.mu && dot(mid.w, mu) < tb.mu);
});

test('leveredReturns charges the financing spread only on borrowed money', () => {
  const w = [0.2, 0.3, 0.5], rT = portfolioReturns(s, w), down = leveredReturns(s, w, 0.8, 0.01), up = leveredReturns(s, w, 1.5, 0.01);
  for (let t = 0; t < s.n; t += 11) {
    close(down[t], 0.8 * rT[t] + 0.2 * s.rf[t], 1e-15);
    close(up[t], 1.5 * rT[t] - 0.5 * s.rf[t] - (0.5 * 0.01) / 12, 1e-15);
  }
});

test('ellipse solvers are feasible and never beaten by a 0.2% simplex grid', () => {
  const grid = [];
  for (let i = 0; i <= 500; i++) for (let j = 0; j <= 500 - i; j++) grid.push([i / 500, j / 500, (500 - i - j) / 500]);
  const sig = Math.sqrt(cov[1][1]), te = w => vol([w[0], w[1] - 1, w[2]]);
  for (const [m, k] of [[1, 0.05], [1, null], [0.8, 0.08], [1.1, 0.08], [0.9, 0.03]]) {
    const w = maxReturnInEllipses(mu, cov, m * sig, k);
    longOnly(w);
    assert.ok(vol(w) <= m * sig * (1 + 1e-12) && (k == null || te(w) <= k * (1 + 1e-12)));
    const best = Math.max(...grid.filter(g => vol(g) <= m * sig && (k == null || te(g) <= k)).map(g => dot(g, mu)));
    assert.ok(dot(w, mu) >= best - 1e-12, `grid beats exact at m=${m} k=${k}`);
  }
  const volObj = planeEllipse(cov), teCon = planeEllipse(cov, [0, 1, 0], 0.03 ** 2), exact = minQuadOnSimplex(volObj, teCon);
  const gridMin = Math.min(...grid.filter(g => te(g) <= 0.03).map(g => vol(g) ** 2));
  assert.ok(exact <= gridMin + 1e-15 && exact >= gridMin * (1 - 1e-2));
  assert.equal(minQuadOnSimplex(planeEllipse(cov, [0, 1, 0]), planeEllipse(cov, [0, 0, 0], 0.01 ** 2)), null);
  assert.equal(maxReturnInEllipses(mu, cov, 0.01, null), null);
});

test('ellipse solvers treat NaN caps as unsatisfiable, never as satisfied', () => {
  const sig = Math.sqrt(cov[1][1]);
  assert.equal(maxReturnInEllipses(mu, cov, NaN, null), null); // returned 100% NDX before
  assert.equal(maxReturnInEllipses(mu, cov, sig, NaN), null);
  assert.equal(minQuadOnSimplex(planeEllipse(cov), planeEllipse(cov, [0, 1, 0], NaN)), null);
});

test('history objectives: the objectives filter reproduces the full optimizer, and rows input equals sample input', () => {
  const full = optimizePortfolios(s), one = optimizePortfolios(s, { objectives: ['maxSharpeAtLeastSpxCagr'] });
  assert.deepEqual(Object.keys(one.solutions), ['maxSharpeAtLeastSpxCagr']);
  assert.deepEqual(one.solutions.maxSharpeAtLeastSpxCagr, full.solutions.maxSharpeAtLeastSpxCagr);
  const rows = Array.from({ length: s.n }, (_, t) => [s.R[0][t], s.R[1][t], s.R[2][t], s.rf[t]]);
  assert.deepEqual(optimizePortfolios(rows, { objectives: ['maxSharpeAtLeastSpxCagr'] }).solutions, one.solutions);
});

test('history objectives: floors hold, equal Sharpe differs from a Sharpe floor, and metrics equal pathStats (ported)', () => {
  const pr = buildSample(doc, { start: '1985-01', basis: 'pr' }), res = optimizePortfolios(pr), { baseline, solutions: sol } = res;
  close(sol.equalSpxSharpe.sharpe, baseline.sharpe, 3e-9);
  assert.ok(sol.maxCagrAtLeastSpxSharpe.cagr > sol.equalSpxSharpe.cagr);
  assert.ok(sol.maxSharpe.sharpe >= sol.maxSharpeAtLeastSpxCagr.sharpe - 1e-12);
  for (const [sample, opt] of [[pr, sol.maxSharpeAtLeastSpxCagr], [s, optimizePortfolios(s, { objectives: ['maxSharpeAtLeastSpxCagr'] }).solutions.maxSharpeAtLeastSpxCagr]]) {
    const direct = pathStats(portfolioReturns(sample, opt.w), sample.rf), spx = pathStats(sample.R[1], sample.rf);
    for (const k of ['cagr', 'sharpe', 'vol', 'mdd']) close(opt[k], direct[k], 1e-12, k);
    assert.ok(opt.cagr >= spx.cagr - 1e-9);
    for (let i = 0; i <= 50; i++) for (let j = 0; j <= 50 - i; j++) {
      const g = [i / 50, j / 50, (50 - i - j) / 50], st = pathStats(portfolioReturns(sample, g), sample.rf);
      if (st.cagr >= spx.cagr) assert.ok(opt.sharpe >= st.sharpe - 1e-9, `grid ${g} beats maxSharpeCagrFloor`);
    }
  }
});
