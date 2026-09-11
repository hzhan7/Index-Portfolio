/**
 * Dependency-free ES module for fixed-weight, monthly-rebalanced portfolios.
 * Input rows: [NDX monthly return, SPX monthly return, BOND monthly return, RF].
 * All returns and weights are decimals. Asset order never changes.
 *
 * The search profiles over NDX weight. Conditional on that weight, Sharpe
 * stationary points and equality roots are analytical; log-growth is concave
 * in SPX weight and is optimized/root-solved by bisection. A dense outer scan
 * and multiple local refinements find continuous candidates. This is a
 * deterministic numerical search, NOT a certified global-optimum guarantee.
 */

const SQRT12 = Math.sqrt(12);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const OBJECTIVES = [
  'maxSharpe', 'maxSharpeAtLeastSpxCagr', 'maxCagrAtLeastSpxSharpe',
  'equalSpxCagr', 'equalSpxSharpe',
];

export function optimizePortfolios(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('At least two aligned monthly rows are required.');
  const n = rows.length;
  const scanSteps = Math.max(24, Math.round(options.scanSteps ?? 128));
  const refineIterations = Math.max(20, Math.round(options.refineIterations ?? 52));
  const maxRefinements = Math.max(2, Math.round(options.maxRefinements ?? 10));
  const rootIterations = 46;
  const base = new Float64Array(n), dn = new Float64Array(n), ds = new Float64Array(n);
  const rf = new Float64Array(n), returns = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const means = [0, 0, 0], rawMeans = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    if (!Array.isArray(rows[t]) || rows[t].length < 4 || !rows[t].slice(0, 4).every(Number.isFinite))
      throw new Error(`Invalid or missing return in row ${t}.`);
    if (rows[t].slice(0, 3).some(v => v <= -1)) throw new Error(`Asset return <= -100% in row ${t}.`);
    rf[t] = rows[t][3];
    for (let j = 0; j < 3; j++) {
      returns[j][t] = rows[t][j];
      means[j] += (rows[t][j] - rf[t]) / n;
      rawMeans[j] += rows[t][j] / n;
    }
    base[t] = 1 + rows[t][2]; dn[t] = rows[t][0] - rows[t][2]; ds[t] = rows[t][1] - rows[t][2];
  }
  const cov = Array.from({ length: 3 }, () => [0, 0, 0]);
  const rawCov = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    for (let t = 0; t < n; t++) {
      cov[i][j] += (returns[i][t] - rf[t] - means[i]) * (returns[j][t] - rf[t] - means[j]) / (n - 1);
      rawCov[i][j] += (returns[i][t] - rawMeans[i]) * (returns[j][t] - rawMeans[j]) / (n - 1);
    }
  }
  const quadratic = (w, matrix) => w.reduce((s, wi, i) => s + wi * w.reduce((z, wj, j) => z + matrix[i][j] * wj, 0), 0);
  const portfolioSharpe = w => {
    const v = quadratic(w, cov);
    return v > 1e-24 ? SQRT12 * w.reduce((s, wi, i) => s + wi * means[i], 0) / Math.sqrt(v) : NaN;
  };
  function metrics(weights) {
    const w = weights.map(v => clamp(v, 0, 1));
    const sum = w[0] + w[1] + w[2];
    for (let j = 0; j < 3; j++) w[j] /= sum;
    let logTotal = 0, wealth = 1, peak = 1, mdd = 0, peakIndex = -1, drawdownPeakIndex = -1, troughIndex = -1;
    const wealthPath = [];
    for (let t = 0; t < n; t++) {
      const r = w[0] * returns[0][t] + w[1] * returns[1][t] + w[2] * returns[2][t];
      logTotal += Math.log1p(r); wealth *= 1 + r; wealthPath.push(wealth);
      if (wealth > peak) { peak = wealth; peakIndex = t; }
      const drawdown = wealth / peak - 1;
      if (drawdown < mdd) { mdd = drawdown; drawdownPeakIndex = peakIndex; troughIndex = t; }
    }
    const recoveredPeak = drawdownPeakIndex < 0 ? 1 : wealthPath[drawdownPeakIndex];
    let recoveryIndex = null;
    if (troughIndex >= 0) for (let t = troughIndex + 1; t < n; t++) {
      if (wealthPath[t] >= recoveredPeak) { recoveryIndex = t; break; }
    }
    const s = portfolioSharpe(w);
    return { w, cagr: Math.expm1(12 * logTotal / n), sharpe: Number.isFinite(s) ? s : null,
      vol: Math.sqrt(Math.max(0, 12 * quadratic(w, rawCov))), excessVol: Math.sqrt(Math.max(0, 12 * quadratic(w, cov))),
      mdd, wealthMultiple: wealth, mddPeakIndex: drawdownPeakIndex, mddTroughIndex: troughIndex, mddRecoveryIndex: recoveryIndex };
  }
  const baseline = metrics([0, 1, 0]);
  if (baseline.sharpe === null) throw new Error('SPX excess-return volatility is zero; Sharpe constraints are undefined.');
  const growthFloor = Math.log1p(baseline.cagr) / 12, sharpeFloor = baseline.sharpe;
  const transformedCov = {
    nn: cov[0][0] + cov[2][2] - 2 * cov[0][2],
    ss: cov[1][1] + cov[2][2] - 2 * cov[1][2],
    ns: cov[0][1] - cov[0][2] - cov[1][2] + cov[2][2],
    nb: cov[0][2] - cov[2][2], sb: cov[1][2] - cov[2][2],
  };
  let profileCalls = 0;
  const caches = Object.fromEntries(OBJECTIVES.map(k => [k, new Map()]));

  function profile(x, kind) {
    x = clamp(x, 0, 1);
    const key = x.toPrecision(16), cache = caches[kind];
    if (cache.has(key)) return cache.get(key);
    profileCalls++;
    const high = 1 - x, a = means[2] + x * (means[0] - means[2]), b = means[1] - means[2];
    const c = cov[2][2] + 2 * x * transformedCov.nb + x * x * transformedCov.nn;
    const d = 2 * (transformedCov.sb + x * transformedCov.ns), e = transformedCov.ss;
    const sharpeAt = y => {
      const v = c + d * y + e * y * y;
      return v > 1e-24 ? SQRT12 * (a + b * y) / Math.sqrt(v) : NaN;
    };
    const growthAt = y => { let v = 0; for (let t = 0; t < n; t++) v += Math.log(base[t] + x * dn[t] + y * ds[t]); return v / n; };
    const growthDerivative = y => { let v = 0; for (let t = 0; t < n; t++) v += ds[t] / (base[t] + x * dn[t] + y * ds[t]); return v / n; };
    function maximumGrowthY(lo, hi) {
      if (hi - lo < 1e-14) return (lo + hi) / 2;
      if (growthDerivative(lo) <= 0) return lo;
      if (growthDerivative(hi) >= 0) return hi;
      for (let i = 0; i < rootIterations; i++) { const mid = (lo + hi) / 2; if (growthDerivative(mid) > 0) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }
    function sharpeCandidates(lo, hi) {
      const ys = [lo, hi], denominator = b * d - 2 * a * e;
      if (Math.abs(denominator) > 1e-28) {
        const stationary = (a * d - 2 * b * c) / denominator;
        if (stationary > lo && stationary < hi) ys.push(stationary);
      }
      return ys;
    }
    function growthRegion() {
      const ym = maximumGrowthY(0, high), g0 = growthAt(0), gh = growthAt(high), gm = growthAt(ym);
      if (gm < growthFloor - 2e-13) return null;
      const roots = [];
      let left = 0, right = high;
      if (g0 < growthFloor) {
        let lo = 0, hi = ym;
        for (let i = 0; i < rootIterations; i++) { const mid = (lo + hi) / 2; if (growthAt(mid) < growthFloor) lo = mid; else hi = mid; }
        left = (lo + hi) / 2; roots.push(left);
      } else if (Math.abs(g0 - growthFloor) < 2e-13) roots.push(0);
      if (gh < growthFloor) {
        let lo = ym, hi = high;
        for (let i = 0; i < rootIterations; i++) { const mid = (lo + hi) / 2; if (growthAt(mid) < growthFloor) hi = mid; else lo = mid; }
        right = (lo + hi) / 2; roots.push(right);
      } else if (Math.abs(gh - growthFloor) < 2e-13) roots.push(high);
      const allEqual = Math.max(Math.abs(g0 - growthFloor), Math.abs(gh - growthFloor), Math.abs(gm - growthFloor)) < 2e-13;
      return { left, right, roots, allEqual };
    }
    function sharpeRoots() {
      const q = sharpeFloor * sharpeFloor;
      const aa = q * e - 12 * b * b, bb = q * d - 24 * a * b, cc = q * c - 12 * a * a;
      const scale = Math.max(Math.abs(aa), Math.abs(bb), Math.abs(cc), 1e-30);
      let ys = [];
      if (Math.abs(aa) < scale * 1e-14) {
        if (Math.abs(bb) > scale * 1e-14) ys.push(-cc / bb);
      } else {
        let disc = bb * bb - 4 * aa * cc;
        const discScale = Math.max(bb * bb, Math.abs(4 * aa * cc), 1e-40);
        if (disc >= -discScale * 1e-12) {
          disc = Math.sqrt(Math.max(0, disc));
          const qq = -0.5 * (bb + (bb >= 0 ? disc : -disc));
          if (Math.abs(qq) > 1e-30) ys.push(qq / aa, cc / qq);
          else ys.push(-bb / (2 * aa));
        }
      }
      ys.push(0, high);
      ys = ys.filter(y => y >= -1e-10 && y <= high + 1e-10).map(y => clamp(y, 0, high));
      ys = ys.filter(y => Math.abs(sharpeAt(y) - sharpeFloor) < 2e-9).sort((u, v) => u - v);
      return ys.filter((y, i) => i === 0 || y - ys[i - 1] > 1e-11);
    }
    let candidates = [];
    const useSharpe = kind === 'maxSharpe' || kind === 'maxSharpeAtLeastSpxCagr' || kind === 'equalSpxCagr';
    if (kind === 'maxSharpe') candidates = sharpeCandidates(0, high);
    if (kind === 'maxSharpeAtLeastSpxCagr' || kind === 'equalSpxCagr') {
      const region = growthRegion();
      if (region) candidates = kind === 'maxSharpeAtLeastSpxCagr' || region.allEqual ? sharpeCandidates(region.left, region.right) : region.roots;
    }
    if (kind === 'maxCagrAtLeastSpxSharpe' || kind === 'equalSpxSharpe') {
      const roots = sharpeRoots();
      const allEqual = [0, high / 2, high].every(y => Math.abs(sharpeAt(y) - sharpeFloor) < 1e-11);
      if (kind === 'equalSpxSharpe') candidates = allEqual ? [maximumGrowthY(0, high)] : roots;
      else {
        candidates = roots.slice();
        const breaks = [0, ...roots, high].sort((u, v) => u - v);
        for (let i = 0; i < breaks.length - 1; i++) {
          const lo = breaks[i], hi = breaks[i + 1];
          if (sharpeAt((lo + hi) / 2) >= sharpeFloor - 1e-12) candidates.push(maximumGrowthY(lo, hi));
        }
      }
    }
    let best = null;
    for (const y of candidates) {
      const s = sharpeAt(y), g = growthAt(y);
      if (!Number.isFinite(s) || !Number.isFinite(g)) continue;
      if ((kind === 'maxSharpeAtLeastSpxCagr' && g < growthFloor - 5e-12)
          || (kind === 'equalSpxCagr' && Math.abs(g - growthFloor) > 5e-12)
          || (kind === 'maxCagrAtLeastSpxSharpe' && s < sharpeFloor - 3e-9)
          || (kind === 'equalSpxSharpe' && Math.abs(s - sharpeFloor) > 3e-9)) continue;
      const item = { x, y, score: useSharpe ? s : g, secondary: useSharpe ? g : s };
      if (!best || item.score > best.score + 1e-14 || (Math.abs(item.score - best.score) <= 1e-14 && item.secondary > best.secondary)) best = item;
    }
    cache.set(key, best);
    return best;
  }

  const better = (a, b) => !a ? b : !b ? a : b.score > a.score + 1e-14 || (Math.abs(b.score - a.score) <= 1e-14 && b.secondary > a.secondary) ? b : a;
  function solve(kind) {
    const scan = Array.from({ length: scanSteps + 1 }, (_, i) => profile(i / scanSteps, kind));
    let best = scan.reduce(better, null);
    const candidates = scan.map((v, i) => ({ v, i })).filter(({ v, i }) => v &&
      (!scan[i - 1] || v.score >= scan[i - 1].score - 1e-14) && (!scan[i + 1] || v.score >= scan[i + 1].score - 1e-14));
    candidates.sort((a, b) => b.v.score - a.v.score);
    const phi = (Math.sqrt(5) - 1) / 2;
    for (const { i } of candidates.slice(0, maxRefinements)) {
      let lo = Math.max(0, (i - 1) / scanSteps), hi = Math.min(1, (i + 1) / scanSteps);
      let left = hi - phi * (hi - lo), right = lo + phi * (hi - lo);
      let vl = profile(left, kind), vr = profile(right, kind);
      for (let iter = 0; iter < refineIterations; iter++) {
        best = better(best, better(vl, vr));
        if ((vl?.score ?? -Infinity) > (vr?.score ?? -Infinity)) {
          hi = right; right = left; vr = vl; left = hi - phi * (hi - lo); vl = profile(left, kind);
        } else {
          lo = left; left = right; vl = vr; right = lo + phi * (hi - lo); vr = profile(right, kind);
        }
      }
      best = better(best, profile((lo + hi) / 2, kind));
    }
    if (!best) return null;
    const result = metrics([best.x, best.y, 1 - best.x - best.y]);
    return { ...result, cagrGapVsSpx: result.cagr - baseline.cagr, sharpeGapVsSpx: result.sharpe - baseline.sharpe };
  }
  const solutions = Object.fromEntries(OBJECTIVES.map(kind => [kind, solve(kind)]));
  return {
    assetOrder: ['NDX', 'SPX', 'BOND'], nMonths: n, years: n / 12, baseline, solutions,
    method: 'Conditional analytical Sharpe roots and concave log-growth bisection; outer scan with multiple continuous refinements. Numerical search, not strict global certification.',
    assumptions: ['Long only; weights sum to 1; monthly rebalancing.', 'CAGR = exp(12 * mean(log(1 + monthly return))) - 1.', 'Sharpe = sqrt(12) * mean(monthly return - RF) / sample_std(monthly return - RF), ddof=1.', 'Volatility is annualized raw monthly-return sample standard deviation.', 'Drawdown uses month-end wealth including initial wealth 1; not daily drawdown.', 'Historical sample is optimized retrospectively; excludes trading costs, taxes and fees.'],
    diagnostics: { scanSteps, refineIterations, maxRefinements, profileCalls,
      cagrEqualityTolerance: 1e-9, sharpeEqualityTolerance: 3e-9 },
  };
}

/** Fixed 120-month return windows, advanced every 12 months by default. */
export function optimizeRolling(rows, options = {}) {
  const windowMonths = Math.round(options.windowMonths ?? 120), stepMonths = Math.round(options.stepMonths ?? 12);
  if (windowMonths < 2 || stepMonths < 1) throw new Error('Invalid rolling window or step.');
  const windows = [];
  for (let start = 0; start + windowMonths <= rows.length; start += stepMonths) {
    windows.push({ startIndex: start, endIndexExclusive: start + windowMonths,
      ...optimizePortfolios(rows.slice(start, start + windowMonths), options) });
  }
  return { windowMonths, stepMonths, overlappingWindowsAreNotIndependent: true, windows };
}
