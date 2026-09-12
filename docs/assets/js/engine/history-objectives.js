// Path-based (historical CAGR / Sharpe) objectives on fixed-weight, monthly rebalanced portfolios.
// Carried over from the v1 site's path optimizer (removed in v2), with an `objectives` filter. The search profiles over NDX weight x;
// conditional on x, Sharpe stationary points and equality roots are analytic and log-growth is concave in the
// SPX weight y (bisection). A dense outer scan plus golden-section refinements finds continuous candidates.
const SQRT12 = Math.sqrt(12);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const OBJECTIVES = ['maxSharpe', 'maxSharpeAtLeastSpxCagr', 'maxCagrAtLeastSpxSharpe', 'equalSpxCagr', 'equalSpxSharpe'];

// input: sample {R:[3 arrays], rf, n} or rows [[ndx, spx, bond, rf], …]
function columns(input) {
  if (Array.isArray(input)) {
    const n = input.length, R = [0, 1, 2].map(() => new Float64Array(n)), rf = new Float64Array(n);
    input.forEach((row, t) => {
      if (!Array.isArray(row) || row.length < 4 || !row.slice(0, 4).every(Number.isFinite)) throw new Error(`第 ${t} 行收益缺失`);
      for (let j = 0; j < 3; j++) R[j][t] = row[j];
      rf[t] = row[3];
    });
    return { R, rf, n };
  }
  return { R: input.R, rf: input.rf, n: input.n };
}

// options.certifiedRoots (default true) skips growth passes whose bisection outcome is already proven; false runs every
// pass. Both give bit-identical results (tests/engine-core-robust.test.js); diagnostics.passes counts the n-month passes.
export function optimizePortfolios(input, options = {}) {
  const { R: returns, rf, n } = columns(input);
  if (n < 2) throw new Error('至少需要两个月的收益');
  const objectives = options.objectives ?? OBJECTIVES;
  const scanSteps = Math.max(24, Math.round(options.scanSteps ?? 128));
  const refineIterations = Math.max(20, Math.round(options.refineIterations ?? 52));
  const maxRefinements = Math.max(2, Math.round(options.maxRefinements ?? 10));
  const certifiedRoots = options.certifiedRoots ?? true;
  const rootIterations = 46;
  const base = new Float64Array(n), dn = new Float64Array(n), ds = new Float64Array(n);
  const means = [0, 0, 0], rawMeans = [0, 0, 0];
  let absLogSum = 0, minGross = Infinity;
  for (let t = 0; t < n; t++) {
    for (let j = 0; j < 3; j++) {
      if (returns[j][t] <= -1) throw new Error(`第 ${t} 行资产收益 ≤ −100%`);
      means[j] += (returns[j][t] - rf[t]) / n;
      rawMeans[j] += returns[j][t] / n;
    }
    base[t] = 1 + returns[2][t]; dn[t] = returns[0][t] - returns[2][t]; ds[t] = returns[1][t] - returns[2][t];
    const lo = 1 + Math.min(returns[0][t], returns[1][t], returns[2][t]), hi = 1 + Math.max(returns[0][t], returns[1][t], returns[2][t]);
    absLogSum += Math.max(Math.abs(Math.log(lo)), Math.abs(Math.log(hi)));
    minGross = Math.min(minGross, lo);
  }
  // Rounding bound for a computed mean log growth vs the exact mean over the same rounded gross returns: sequential-sum
  // rounding ≤ ulp(A)/2 with A = Σ_t max|log gross_t| ≥ every partial sum on the simplex, plus log, argument and
  // division rounding ≤ 6e-16 / min gross. Certificates use 3× that bound (2× suffices for two computed values).
  const growthMargin = 3 * (2 ** (Math.floor(Math.log2(absLogSum * (1 + 1e-9))) - 53) + 6e-16 / minGross);
  const cov = Array.from({ length: 3 }, () => [0, 0, 0]), rawCov = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let t = 0; t < n; t++) {
    cov[i][j] += ((returns[i][t] - rf[t] - means[i]) * (returns[j][t] - rf[t] - means[j])) / (n - 1);
    rawCov[i][j] += ((returns[i][t] - rawMeans[i]) * (returns[j][t] - rawMeans[j])) / (n - 1);
  }
  const quadratic = (w, m) => w.reduce((s, wi, i) => s + wi * w.reduce((z, wj, j) => z + m[i][j] * wj, 0), 0);
  const portfolioSharpe = w => {
    const v = quadratic(w, cov);
    return v > 1e-24 ? (SQRT12 * w.reduce((s, wi, i) => s + wi * means[i], 0)) / Math.sqrt(v) : NaN;
  };
  function metrics(weights) {
    const w = weights.map(v => clamp(v, 0, 1)), sum = w[0] + w[1] + w[2];
    for (let j = 0; j < 3; j++) w[j] /= sum;
    let logTotal = 0, wealth = 1, peak = 1, mdd = 0;
    for (let t = 0; t < n; t++) {
      const r = w[0] * returns[0][t] + w[1] * returns[1][t] + w[2] * returns[2][t];
      logTotal += Math.log1p(r); wealth *= 1 + r;
      if (wealth > peak) peak = wealth;
      mdd = Math.min(mdd, wealth / peak - 1);
    }
    const s = portfolioSharpe(w);
    return { w, cagr: Math.expm1((12 * logTotal) / n), sharpe: Number.isFinite(s) ? s : null,
      vol: Math.sqrt(Math.max(0, 12 * quadratic(w, rawCov))), mdd };
  }
  const baseline = metrics([0, 1, 0]);
  if (baseline.sharpe === null) throw new Error('标普500 超额收益波动为零，夏普约束无定义');
  const growthFloor = Math.log1p(baseline.cagr) / 12, sharpeFloor = baseline.sharpe;
  const tc = { nn: cov[0][0] + cov[2][2] - 2 * cov[0][2], ss: cov[1][1] + cov[2][2] - 2 * cov[1][2],
    ns: cov[0][1] - cov[0][2] - cov[1][2] + cov[2][2], nb: cov[0][2] - cov[2][2], sb: cov[1][2] - cov[2][2] };
  let profileCalls = 0, passes = 0;
  const caches = Object.fromEntries(objectives.map(k => [k, new Map()]));
  // bx[t] = base[t] + x·dn[t] for the x being profiled; bx[t] + y·ds[t] is bit-identical to base[t] + x·dn[t] + y·ds[t].
  const bx = new Float64Array(n);

  function profile(x, kind) {
    x = clamp(x, 0, 1);
    const key = x.toPrecision(16), cache = caches[kind];
    if (cache.has(key)) return cache.get(key);
    profileCalls++;
    const high = 1 - x, a = means[2] + x * (means[0] - means[2]), b = means[1] - means[2];
    const c = cov[2][2] + 2 * x * tc.nb + x * x * tc.nn, d = 2 * (tc.sb + x * tc.ns), e = tc.ss;
    for (let t = 0; t < n; t++) bx[t] = base[t] + x * dn[t];
    const sharpeAt = y => { const v = c + d * y + e * y * y; return v > 1e-24 ? (SQRT12 * (a + b * y)) / Math.sqrt(v) : NaN; };
    const growthAt = y => { passes++; let v = 0; for (let t = 0; t < n; t++) v += Math.log(bx[t] + y * ds[t]); return v / n; };
    const growthDerivative = y => { passes++; let v = 0; for (let t = 0; t < n; t++) v += ds[t] / (bx[t] + y * ds[t]); return v / n; };
    const known = new Map(); // growthAt is deterministic, so a value already computed at y is reused as is
    const growth = y => { let g = known.get(y); if (g === undefined) known.set(y, (g = growthAt(y))); return g; };
    // Same summation as growthAt (identical value) plus the slope, for Newton steps.
    const growthAndSlope = y => {
      passes++;
      let v = 0, s = 0;
      for (let t = 0; t < n; t++) { const u = bx[t] + y * ds[t]; v += Math.log(u); s += ds[t] / u; }
      known.set(y, v / n);
      return [v / n, s / n];
    };
    function maximumGrowthY(lo, hi) {
      if (hi - lo < 1e-14) return (lo + hi) / 2;
      if (growthDerivative(lo) <= 0) return lo;
      if (growthDerivative(hi) >= 0) return hi;
      for (let i = 0; i < rootIterations; i++) { const mid = (lo + hi) / 2; if (growthDerivative(mid) > 0) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }
    // Points that settle bisection steps without a pass, for g = floor on [lo, hi] where g is monotone (increasing = left
    // of the growth argmax) and g(low end) < floor. certBelow: computed g < floor − margin, so every mid on the low side
    // of it also computes below the floor; certAbove: computed g ≥ floor + margin, likewise on the high side. Newton runs
    // from the low end; the tangent of concave g lies above g, so its steps do not overshoot the root.
    function rootCertificates(lo, hi, increasing) {
      const dir = increasing ? 1 : -1, M = growthMargin, inside = y => y > lo && y < hi;
      let y = increasing ? lo : hi, [g, s] = growthAndSlope(y), certBelow = null, certAbove = null;
      for (let k = 0, gap = growthFloor - g; k < 12; k++) {
        if (gap > M) certBelow = y;
        if (gap <= 2 * M || !(dir * s > 0)) break;
        const next = y + gap / s;
        if (!inside(next) || dir * (next - y) <= 0) break;
        y = next; [g, s] = growthAndSlope(y);
        const shrink = gap / (growthFloor - g);
        gap = growthFloor - g;
        if (shrink < 4 && gap > 2 * M) { if (gap > M) certBelow = y; break; } // slow (flat top): give up on tightening
      }
      if (!(dir * s > 0)) return [certBelow, null];
      const slope = dir * s;
      if (growthFloor - g <= M) { // y is within the margin of the floor: step back for a tight low-side certificate
        const q = y - (dir * 4 * M) / slope;
        if (inside(q) && growthFloor - growthAndSlope(q)[0] > M) certBelow = q;
      }
      for (let k = 0, step = (1.5 * (Math.max(growthFloor - g, 0) + 4 * M)) / slope; k < 4; k++, step *= 8) {
        const q = y + dir * step;
        if (!inside(q)) break;
        if (growthAndSlope(q)[0] - growthFloor >= M) { certAbove = q; break; }
      }
      return [certBelow, certAbove];
    }
    // Fixed 46-step bisection for g(y) = floor on [lo, hi]; mids outside the certificates skip their pass.
    function growthRoot(lo, hi, increasing) {
      const [certBelow, certAbove] = certifiedRoots && hi - lo > 1e-9 ? rootCertificates(lo, hi, increasing) : [null, null];
      for (let i = 0; i < rootIterations; i++) {
        const mid = (lo + hi) / 2;
        const below = certBelow !== null && (increasing ? mid <= certBelow : mid >= certBelow) ? true
          : certAbove !== null && (increasing ? mid >= certAbove : mid <= certAbove) ? false
            : growthAt(mid) < growthFloor;
        if (below === increasing) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }
    function sharpeCandidates(lo, hi) {
      const ys = [lo, hi], den = b * d - 2 * a * e;
      if (Math.abs(den) > 1e-28) { const st = (a * d - 2 * b * c) / den; if (st > lo && st < hi) ys.push(st); }
      return ys;
    }
    function growthRegion() {
      const ym = maximumGrowthY(0, high), g0 = growth(0), gh = growth(high), gm = growth(ym);
      if (gm < growthFloor - 2e-13) return null;
      const roots = [];
      let left = 0, right = high;
      if (g0 < growthFloor) { left = growthRoot(0, ym, true); roots.push(left); }
      else if (Math.abs(g0 - growthFloor) < 2e-13) roots.push(0);
      if (gh < growthFloor) { right = growthRoot(ym, high, false); roots.push(right); }
      else if (Math.abs(gh - growthFloor) < 2e-13) roots.push(high);
      const allEqual = Math.max(Math.abs(g0 - growthFloor), Math.abs(gh - growthFloor), Math.abs(gm - growthFloor)) < 2e-13;
      return { left, right, roots, allEqual };
    }
    function sharpeRoots() {
      const q = sharpeFloor * sharpeFloor, aa = q * e - 12 * b * b, bb = q * d - 24 * a * b, cc = q * c - 12 * a * a;
      const scale = Math.max(Math.abs(aa), Math.abs(bb), Math.abs(cc), 1e-30);
      let ys = [];
      if (Math.abs(aa) < scale * 1e-14) { if (Math.abs(bb) > scale * 1e-14) ys.push(-cc / bb); }
      else {
        let disc = bb * bb - 4 * aa * cc;
        if (disc >= -Math.max(bb * bb, Math.abs(4 * aa * cc), 1e-40) * 1e-12) {
          disc = Math.sqrt(Math.max(0, disc));
          const qq = -0.5 * (bb + (bb >= 0 ? disc : -disc));
          if (Math.abs(qq) > 1e-30) ys.push(qq / aa, cc / qq); else ys.push(-bb / (2 * aa));
        }
      }
      ys.push(0, high);
      ys = ys.filter(y => y >= -1e-10 && y <= high + 1e-10).map(y => clamp(y, 0, high))
        .filter(y => Math.abs(sharpeAt(y) - sharpeFloor) < 2e-9).sort((u, v) => u - v);
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
      const roots = sharpeRoots(), allEqual = [0, high / 2, high].every(y => Math.abs(sharpeAt(y) - sharpeFloor) < 1e-11);
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
      const s = sharpeAt(y), g = growth(y);
      if (!Number.isFinite(s) || !Number.isFinite(g)) continue;
      if ((kind === 'maxSharpeAtLeastSpxCagr' && g < growthFloor - 5e-12) || (kind === 'equalSpxCagr' && Math.abs(g - growthFloor) > 5e-12)
        || (kind === 'maxCagrAtLeastSpxSharpe' && s < sharpeFloor - 3e-9) || (kind === 'equalSpxSharpe' && Math.abs(s - sharpeFloor) > 3e-9)) continue;
      const item = { x, y, score: useSharpe ? s : g, secondary: useSharpe ? g : s };
      if (!best || item.score > best.score + 1e-14 || (Math.abs(item.score - best.score) <= 1e-14 && item.secondary > best.secondary)) best = item;
    }
    cache.set(key, best);
    return best;
  }

  const better = (a, b) => (!a ? b : !b ? a : b.score > a.score + 1e-14 || (Math.abs(b.score - a.score) <= 1e-14 && b.secondary > a.secondary) ? b : a);
  function solve(kind) {
    const scan = Array.from({ length: scanSteps + 1 }, (_, i) => profile(i / scanSteps, kind));
    let best = scan.reduce(better, null);
    const peaks = scan.map((v, i) => ({ v, i })).filter(({ v, i }) => v
      && (!scan[i - 1] || v.score >= scan[i - 1].score - 1e-14) && (!scan[i + 1] || v.score >= scan[i + 1].score - 1e-14));
    peaks.sort((a, b) => b.v.score - a.v.score);
    const phi = (Math.sqrt(5) - 1) / 2;
    for (const { i } of peaks.slice(0, maxRefinements)) {
      let lo = Math.max(0, (i - 1) / scanSteps), hi = Math.min(1, (i + 1) / scanSteps);
      let left = hi - phi * (hi - lo), right = lo + phi * (hi - lo), vl = profile(left, kind), vr = profile(right, kind);
      for (let iter = 0; iter < refineIterations; iter++) {
        best = better(best, better(vl, vr));
        if ((vl?.score ?? -Infinity) > (vr?.score ?? -Infinity)) { hi = right; right = left; vr = vl; left = hi - phi * (hi - lo); vl = profile(left, kind); }
        else { lo = left; left = right; vl = vr; right = lo + phi * (hi - lo); vr = profile(right, kind); }
      }
      best = better(best, profile((lo + hi) / 2, kind));
    }
    if (!best) return null;
    const result = metrics([best.x, best.y, 1 - best.x - best.y]);
    return { ...result, cagrGapVsSpx: result.cagr - baseline.cagr, sharpeGapVsSpx: result.sharpe - baseline.sharpe };
  }
  return { assetOrder: ['NDX', 'SPX', 'UST'], nMonths: n, baseline,
    solutions: Object.fromEntries(objectives.map(kind => [kind, solve(kind)])),
    diagnostics: { scanSteps, refineIterations, maxRefinements, profileCalls, passes, certifiedRoots } };
}
