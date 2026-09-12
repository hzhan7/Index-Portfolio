// Allocation rules (SPEC §2.5): every rule is (sample, params, ctx) → result with a common shape.
import { engineError, normalizeWeights } from './params.js?v=20260912';
import { yieldToAnnualReturn } from './series.js?v=20260912';
import { moments, pathStats, portfolioReturns, teStats } from './stats.js?v=20260912';
import { impliedIntercept, kinkedCal, leveredReturns, maxReturnInEllipses, minQuadOnSimplex, planeEllipse,
  tangency as tangencyPoint } from './frontier.js?v=20260912';
import { optimizePortfolios } from './history-objectives.js?v=20260912';

const SQ12 = Math.sqrt(12);
const E_SPX = [0, 1, 0];
const TE_CHIPS = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const quad = (w, cov) => dot(w, [dot(cov[0], w), dot(cov[1], w), dot(cov[2], w)]);

// lite: skip SPX path stats (bootstrap / walk-forward windows only need moments).
export function makeCtx(sample, { mu = 'hist' } = {}, { lite = false } = {}) {
  if (mu === 'y10bond' && sample.basis !== 'tr') throw engineError('E_Y10_REQUIRES_TR', '「美债=10年期收益率」只适用于含息总回报口径');
  const m = moments(sample), y10 = yieldToAnnualReturn(sample.dgs10End);
  // DGS10 → effective annual return, plus σ²/2 to express it as an arithmetic mean like the other μ.
  const muUsed = mu === 'y10bond' ? [m.mu[0], m.mu[1], y10 + m.cov[2][2] / 2] : m.mu.slice();
  const spx = lite ? null : pathStats(sample.R[1], sample.rf, { startMonth: sample.start, months: sample.months });
  return { sample, mu, moments: m, muUsed, cov: m.cov, sigmaSpx: Math.sqrt(m.cov[1][1]), rfAnn: m.rfAnn, y10, spx };
}

export const modelOf = (ctx, w) => ({
  mu: dot(ctx.muUsed, w), vol: Math.sqrt(Math.max(0, quad(w, ctx.cov))), te: Math.sqrt(Math.max(0, quad([w[0], w[1] - 1, w[2]], ctx.cov))),
});

function vsSpx(ctx, r, stats) {
  const d = k => (stats[k] == null || ctx.spx[k] == null ? null : stats[k] - ctx.spx[k]);
  const { te, ir } = teStats(r, ctx.sample.R[1]);
  return { cagr: d('cagr'), sharpe: d('sharpe'), vol: d('vol'), mdd: d('mdd'), worst12m: d('worst12m'), te, ir };
}

function evaluateReturns(ctx, r) {
  const { sample } = ctx, stats = pathStats(r, sample.rf, { startMonth: sample.start, months: sample.months });
  return { stats, vsSpx: vsSpx(ctx, r, stats) };
}

function result(rule, params, ctx, w, extra = {}) {
  const empty = { w: null, model: null, stats: null, vsSpx: null };
  const body = w ? { w, model: modelOf(ctx, w), ...evaluateReturns(ctx, portfolioReturns(ctx.sample, w)) } : empty;
  return { rule, params, status: w ? 'ok' : 'infeasible', ...body, binding: {}, note: null, ...extra };
}

export function calendarReturn(months, r, year) {
  let g = 1, count = 0;
  months.forEach((m, t) => { if (m.startsWith(year)) { g *= 1 + r[t]; count++; } });
  return count === 12 ? g - 1 : null;
}

export function pathCagr(sample, w) {
  const { R, n } = sample;
  let lg = 0;
  for (let t = 0; t < n; t++) lg += Math.log1p(w[0] * R[0][t] + w[1] * R[1][t] + w[2] * R[2][t]);
  return Math.expm1((12 * lg) / n);
}

// ---- 1. isoVolTe
export const solveIsoVolTe = (mu, cov, volMult, teCap) => maxReturnInEllipses(mu, cov, volMult * Math.sqrt(cov[1][1]), teCap);

export function isoFeasibility(cov, volMult) {
  const sig = Math.sqrt(cov[1][1]), volObj = planeEllipse(cov), root = v => (v == null ? null : Math.sqrt(Math.max(v, 0)));
  const minVolMultByTe = Object.fromEntries(TE_CHIPS.map(k => [String(k), root(minQuadOnSimplex(volObj, planeEllipse(cov, E_SPX, k * k))) / sig]));
  minVolMultByTe.none = root(minQuadOnSimplex(volObj)) / sig;
  const minTe = minQuadOnSimplex(planeEllipse(cov, E_SPX), planeEllipse(cov, [0, 0, 0], (volMult * sig) ** 2));
  return { minVolMultByTe, minTeForVolCap: root(minTe) };
}

export function isoVolTe(sample, params = {}, ctx = makeCtx(sample)) {
  const volMult = params.volMult ?? 1, teCap = params.teCap === undefined ? 0.05 : params.teCap;
  const { muUsed, cov, sigmaSpx } = ctx;
  const w = solveIsoVolTe(muUsed, cov, volMult, teCap);
  const pureW = teCap == null ? w : solveIsoVolTe(muUsed, cov, volMult, null);
  const pureModel = pureW && modelOf(ctx, pureW), teU = pureModel ? pureModel.te : null;
  const pure = pureW ? { w: pureW, model: pureModel, teUnconstrained: teU, impliedIntercept: impliedIntercept(muUsed, cov, pureW) } : null;
  const muShift = [-0.01, -0.02].map(dNdx => ({ dNdx, w: solveIsoVolTe([muUsed[0] + dNdx, muUsed[1], muUsed[2]], cov, volMult, teCap) }));
  const out = result('isoVolTe', { volMult, teCap }, ctx, w, { pure, feasibility: isoFeasibility(cov, volMult), muShift, path: [], flatTop: null });
  if (!w) return { ...out, note: '波动上限与跟踪误差上限无法同时满足' };
  const V = (volMult * sigmaSpx) ** 2, te2 = quad([w[0], w[1] - 1, w[2]], cov);
  out.binding = { vol: Math.abs(quad(w, cov) - V) < 1e-10 * V, te: teCap != null && Math.abs(te2 - teCap ** 2) < 1e-10 * teCap ** 2 };
  if (teU != null) {
    const ks = teU <= 0.01 ? [teU] : Array.from({ length: 20 }, (_, i) => 0.01 + ((teU - 0.01) * i) / 19);
    for (const k of [0.02, 0.03, 0.04, 0.05]) if (k <= teU && !ks.some(x => Math.abs(x - k) < 1e-9)) ks.push(k);
    ks.sort((a, b) => a - b);
    for (const k of ks) {
      const wk = k >= teU - 1e-12 ? pureW : solveIsoVolTe(muUsed, cov, volMult, k);
      if (wk) out.path.push({ k, w: wk, ...modelOf(ctx, wk), cagr: pathCagr(sample, wk) });
    }
    const w3 = teU > 0.03 ? solveIsoVolTe(muUsed, cov, volMult, 0.03) : null;
    if (w3) out.flatTop = { kFrom: 0.03, kTo: teU, ndxFrom: w3[0], ndxTo: pureW[0], cagrGap: pathCagr(sample, pureW) - pathCagr(sample, w3) };
  }
  return out;
}

// ---- 2. maxSharpeCagrFloor (historical path objective)
export function solveMaxSharpeCagrFloor(sample) {
  return optimizePortfolios(sample, { objectives: ['maxSharpeAtLeastSpxCagr'] }).solutions.maxSharpeAtLeastSpxCagr;
}

export function maxSharpeCagrFloor(sample, params = {}, ctx = makeCtx(sample)) {
  const sol = solveMaxSharpeCagrFloor(sample);
  const out = result('maxSharpeCagrFloor', {}, ctx, sol?.w ?? null);
  if (sol) out.binding = { cagrFloor: Math.abs(sol.cagrGapVsSpx) < 1e-8 };
  return out;
}

// ---- 3. tangency
function tangencyBlock(ctx, c) {
  const t = c == null ? null : tangencyPoint(ctx.muUsed, ctx.cov, c);
  if (!t || t.status !== 'ok') return { c, status: t ? t.status : 'undefined', w: null, model: null, slope: null, stats: null, vsSpx: null };
  return { c, status: 'ok', w: t.w, model: modelOf(ctx, t.w), slope: t.slope, ...evaluateReturns(ctx, portfolioReturns(ctx.sample, t.w)) };
}

export function leveredTangency(sample, ctx, { spread = 0.005, volMult = 1 } = {}) {
  const k = kinkedCal(ctx.muUsed, ctx.cov, { rfAnn: ctx.rfAnn, spread, targetVol: volMult * ctx.sigmaSpx });
  const out = { ...k, spread, volMult, stats: null, vsSpx: null, y2022: null };
  if (!k.w) return out;
  const r = leveredReturns(sample, k.w, k.L, spread), ev = ctx.spx ? evaluateReturns(ctx, r) : null;
  const spx2022 = calendarReturn(sample.months, sample.R[1], '2022'), rule2022 = calendarReturn(sample.months, r, '2022');
  return { ...out, ...ev, y2022: rule2022 == null ? null : { rule: rule2022, spx: spx2022 } };
}

// Intercept c for the tangency rule; 'implied' = c* of the pure iso-vol point (cLow for a vertex interval: that vertex is the
// tangency for every c in [cLow, cHigh], and for every c ≥ cLow only when the interval is openAbove).
export function resolveIntercept(ctx, { intercept = 'implied', interceptC = null, volMult = 1 } = {}) {
  const pureW = solveIsoVolTe(ctx.muUsed, ctx.cov, volMult, null);
  const ii = pureW ? impliedIntercept(ctx.muUsed, ctx.cov, pureW) : null;
  const cImplied = ii == null ? null : ii.kind === 'point' ? ii.c : ii.cLow;
  const c = intercept === 'implied' ? cImplied : ({ rf: ctx.rfAnn, y10: ctx.y10, custom: interceptC }[intercept] ?? null);
  return { c, cImplied, ii };
}

export function tangency(sample, params = {}, ctx = makeCtx(sample)) {
  const { intercept = 'implied', interceptC = null, spread = 0.005, volMult = 1 } = params;
  const { rfAnn, y10 } = ctx;
  const { c, cImplied, ii } = resolveIntercept(ctx, { intercept, interceptC, volMult });
  const unlevered = tangencyBlock(ctx, c);
  // Vertex interval: cRange = [cLow, cHigh]; "≥ cLow" (atLeast) only when nothing but the vertex's own μ bounds it above.
  const interval = ii?.kind === 'interval', atLeast = interval && ii.openAbove, cRange = interval ? [ii.cLow, ii.cHigh] : null;
  const implied = cImplied == null ? null : { ...tangencyBlock(ctx, cImplied), kind: ii.kind, atLeast, cRange };
  return {
    rule: 'tangency', params: { intercept, interceptC, spread, volMult },
    status: unlevered.status === 'ok' ? 'ok' : c == null ? 'undefined' : 'infeasible',
    w: unlevered.w, model: unlevered.model, stats: unlevered.stats, vsSpx: unlevered.vsSpx,
    binding: {}, note: c == null ? '隐含截距无定义（同波动组合不在有效前沿上）' : null,
    c, atLeast: intercept === 'implied' && atLeast, cRange: intercept === 'implied' ? cRange : null,
    unlevered, levered: leveredTangency(sample, ctx, { spread, volMult }),
    // unlevered tangencies at the sample rf and at the converted sample-end 10Y yield, whatever intercept is selected
    atRf: c === rfAnn ? unlevered : tangencyBlock(ctx, rfAnn),
    atY10: c === y10 ? unlevered : tangencyBlock(ctx, y10),
    implied, impliedIntercept: ii, cRf: rfAnn, cY10: y10,
  };
}

// ---- 4. twoAsset: x·asset_i + (1 − x)·asset_j
function quadRoots(qa, qb, qc) {
  if (Math.abs(qa) < 1e-300) return qb === 0 ? [] : [-qc / qb];
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return [];
  const sd = Math.sqrt(disc);
  return [(-qb - sd) / (2 * qa), (-qb + sd) / (2 * qa)];
}
const in01 = xs => [...new Set(xs.filter(x => x >= -1e-12 && x <= 1 + 1e-12).map(x => Math.min(1, Math.max(0, x))))].sort((a, b) => a - b);

function bisect(f, lo, hi, iters = 200) { // f(lo) and f(hi) have opposite signs (or f is monotone-decreasing sign test)
  const flo = f(lo) > 0;
  for (let i = 0; i < iters && hi - lo > 0; i++) { const mid = (lo + hi) / 2; if (mid === lo || mid === hi) break; if ((f(mid) > 0) === flo) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export function twoAsset(sample, params = {}, ctx = makeCtx(sample)) {
  const [i, j] = params.pair ?? [0, 2];
  const { R, rf, n } = sample, Sspx = ctx.spx.sharpe;
  let mi = 0, mj = 0, ri = 0, rj = 0, gSpx = 0;
  for (let t = 0; t < n; t++) { mi += R[i][t] - rf[t]; mj += R[j][t] - rf[t]; ri += R[i][t]; rj += R[j][t]; gSpx += Math.log1p(R[1][t]); }
  [mi, mj, ri, rj, gSpx] = [mi / n, mj / n, ri / n, rj / n, gSpx / n];
  let cii = 0, cjj = 0, cij = 0, vii = 0, vjj = 0, vij = 0, vs = 0, ms = 0;
  for (let t = 0; t < n; t++) ms += R[1][t] / n;
  for (let t = 0; t < n; t++) {
    const ei = R[i][t] - rf[t] - mi, ej = R[j][t] - rf[t] - mj, ui = R[i][t] - ri, uj = R[j][t] - rj;
    cii += ei * ei; cjj += ej * ej; cij += ei * ej; vii += ui * ui; vjj += uj * uj; vij += ui * uj; vs += (R[1][t] - ms) ** 2;
  }
  [cii, cjj, cij, vii, vjj, vij, vs] = [cii, cjj, cij, vii, vjj, vij, vs].map(v => v / (n - 1));
  const a = mj, b = mi - mj, c0 = cjj, c1 = 2 * (cij - cjj), c2 = cii + cjj - 2 * cij;
  const sharpeX = x => (SQ12 * (a + b * x)) / Math.sqrt(c0 + c1 * x + c2 * x * x);
  const S2 = Sspx * Sspx;
  const sharpeRoots = in01(quadRoots(12 * b * b - S2 * c2, 24 * a * b - S2 * c1, 12 * a * a - S2 * c0)).filter(x => Math.sign(a + b * x) === Math.sign(Sspx));
  const volRoots = in01(quadRoots(vii + vjj - 2 * vij, 2 * (vij - vjj), vjj - vs));
  const g = x => { let s = 0; for (let t = 0; t < n; t++) s += Math.log(1 + R[j][t] + x * (R[i][t] - R[j][t])); return s / n; };
  const dg = x => { let s = 0; for (let t = 0; t < n; t++) { const d = R[i][t] - R[j][t]; s += d / (1 + R[j][t] + x * d); } return s / n; };
  const xm = dg(0) <= 0 ? 0 : dg(1) >= 0 ? 1 : bisect(dg, 0, 1);
  let cagrRoots = [];
  for (const [lo, hi] of [[0, xm], [xm, 1]]) {
    if (hi - lo <= 0) continue;
    const flo = g(lo) - gSpx, fhi = g(hi) - gSpx;
    if (flo === 0) cagrRoots.push(lo);
    if (fhi === 0) cagrRoots.push(hi);
    if (flo * fhi < 0) cagrRoots.push(bisect(x => g(x) - gSpx, lo, hi));
  }
  if (!cagrRoots.length && g(xm) === gSpx) cagrRoots = [xm];
  cagrRoots = [...new Set(cagrRoots)].sort((u, v) => u - v);
  const trivial = x => (i === 1 && Math.abs(x - 1) < 1e-9) || (j === 1 && Math.abs(x) < 1e-9);
  const nonTrivial = xs => xs.filter(x => !trivial(x));
  const roots = { sharpeEqSpx: nonTrivial(sharpeRoots), cagrEqSpx: nonTrivial(cagrRoots), volEqSpx: nonTrivial(volRoots),
    trivial: [...new Set([...sharpeRoots, ...cagrRoots, ...volRoots].filter(trivial).map(x => (x > 0.5 ? 1 : 0)))].sort((u, v) => u - v) };
  // Feasible set {g ≥ g_SPX − ε} is an interval around xm; its edges are bisected on the thresholded test so an SPX
  // endpoint that ties g_SPX up to rounding cannot widen the interval to the whole segment.
  let best = null;
  const above = x => g(x) >= gSpx - 1e-15;
  const edge = (bad, good) => {
    for (let k = 0; k < 200; k++) { const mid = (bad + good) / 2; if (mid === bad || mid === good) break; if (above(mid)) good = mid; else bad = mid; }
    return good;
  };
  if (above(xm)) {
    const xl = above(0) ? 0 : edge(0, xm), xr = above(1) ? 1 : edge(1, xm);
    const cands = [xl, xr], den = (b * c1) / 2 - a * c2;
    if (den !== 0) { const xs = ((a * c1) / 2 - b * c0) / den; if (xl < xs && xs < xr) cands.push(xs); }
    best = cands.reduce((p, x) => (sharpeX(x) > sharpeX(p) ? x : p));
    if (trivial(best)) best = best > 0.5 ? 1 : 0;
  }
  const sr = roots.sharpeEqSpx;
  // S(1) equals S_SPX exactly when asset i is SPX, so test beyond the single root instead of the endpoint itself.
  const status = !sr.length ? 'none' : sr.length === 1 && sharpeX((sr[0] + 1) / 2) > Sspx ? 'all-above' : 'ok';
  const weightsAt = x => { const w = [0, 0, 0]; w[i] += x; w[j] += 1 - x; return w; };
  const curve = { x: new Float64Array(1001), cagr: new Float64Array(1001), sharpe: new Float64Array(1001), vol: new Float64Array(1001), mdd: new Float64Array(1001) };
  const r = new Float64Array(n);
  for (let k = 0; k <= 1000; k++) {
    const x = k / 1000;
    for (let t = 0; t < n; t++) r[t] = x * R[i][t] + (1 - x) * R[j][t];
    const st = pathStats(r, rf);
    curve.x[k] = x; curve.cagr[k] = st.cagr; curve.sharpe[k] = st.sharpe ?? NaN; curve.vol[k] = st.vol; curve.mdd[k] = st.mdd;
  }
  const raw = [...sr.map(x => ['sharpeEqSpx', x]), ...roots.cagrEqSpx.map(x => ['cagrEqSpx', x]), ...roots.volEqSpx.map(x => ['volEqSpx', x]),
    ...(best == null ? [] : [['maxSharpeCagrFloor', best]])].sort((u, v) => u[1] - v[1]);
  const points = [];
  for (const [id, x] of raw) {
    const last = points.at(-1);
    if (last && Math.abs(last.x - x) <= 1e-4) { last.ids.push(id); last.id = last.ids.join('+'); continue; }
    points.push({ id, ids: [id], x });
  }
  for (const p of points) { p.w = weightsAt(p.x); p.stats = pathStats(portfolioReturns(sample, p.w), rf, { startMonth: sample.start, months: sample.months }); }
  return { rule: 'twoAsset', params: { pair: [i, j] }, status, w: null, curve, roots, best: { maxSharpeCagrFloor: best },
    headline: sr.length ? Math.max(...sr) : null, points, spx: { cagr: ctx.spx.cagr, sharpe: Sspx, vol: ctx.spx.vol } };
}

// ---- 5. custom
export function custom(sample, params = {}, ctx = makeCtx(sample)) {
  const w = normalizeWeights(params.w);
  if (!w) throw engineError('E_BAD_WEIGHTS', '自定义权重缺失');
  return result('custom', { w }, ctx, w);
}

export const RULES = { isoVolTe, maxSharpeCagrFloor, tangency, twoAsset, custom };

// Custom weights default: isoVolTe at the current caps as integer percents (largest remainder), else 100% SPX.
export function defaultCustomWeights(ctx, { volMult = 1, teCap = 0.05 } = {}) {
  const w = solveIsoVolTe(ctx.muUsed, ctx.cov, volMult, teCap);
  if (!w) return [0, 1, 0];
  const pct = w.map(x => Math.floor(x * 100)), order = [0, 1, 2].sort((a, b) => (w[b] * 100 - pct[b]) - (w[a] * 100 - pct[a]));
  const missing = 100 - pct.reduce((s, x) => s + x, 0);
  for (let k = 0; k < missing; k++) pct[order[k % 3]]++;
  return pct.map(x => x / 100);
}

const REFERENCES = [
  { id: 'spx', label: '标普500', w: [0, 1, 0] }, { id: 'ndx', label: '纳指100', w: [1, 0, 0] },
  { id: 'sixty40', label: '60/40（标普500/美债）', w: [0, 0.6, 0.4] }, { id: 'ndxSpx5050', label: '50/50（纳指100/标普500）', w: [0.5, 0.5, 0] },
];

export function references(sample, ctx) {
  return REFERENCES.map(ref => ({ ...ref, w: ref.w.slice(),
    stats: pathStats(portfolioReturns(sample, ref.w), sample.rf, { startMonth: sample.start, months: sample.months }) }));
}

export function askedPortfolios({ rules, references: refs }) {
  const ref = id => refs.find(r => r.id === id), ta = rules.twoAssetNdxUst, lev = rules.tangency?.levered;
  const pointFor = (id, x) => (x == null ? null : ta.points.find(p => p.ids.includes(id) && Math.abs(p.x - x) <= 1e-4) ?? null);
  const row = (id, label, src, group = 'asked', extra = {}) => ({ id, label, group, w: src?.w ?? null, stats: src?.stats ?? null, oos: null, ...extra });
  const cagrRoot = ta.roots.cagrEqSpx.length ? Math.max(...ta.roots.cagrEqSpx) : null;
  return [
    row('spx', '标普500', ref('spx')),
    row('ndxUstSharpeEqSpx', '纳指100+美债·夏普=标普500', pointFor('sharpeEqSpx', ta.headline)),
    row('ndxUstCagrEqSpx', '纳指100+美债·收益=标普500', pointFor('cagrEqSpx', cagrRoot)),
    row('maxSharpeCagrFloor', '收益≥标普500·夏普最高', rules.maxSharpeCagrFloor),
    row('isoVolTe', '同波动·收益最高（默认）', rules.isoVolTe),
    row('tangencyLevered', '切点×杠杆到标普波动', lev?.w ? lev : null, 'asked', { notional: lev?.notional ?? null, L: lev?.L ?? null }),
    row('ndx', '纳指100', ref('ndx')),
    row('sixty40', ref('sixty40').label, ref('sixty40'), 'reference'),
    row('ndxSpx5050', ref('ndxSpx5050').label, ref('ndxSpx5050'), 'reference'),
  ];
}
