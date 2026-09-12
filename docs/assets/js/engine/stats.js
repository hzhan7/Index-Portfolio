// Path statistics, moments, regressions and the seeded circular block bootstrap (SPEC §2.0, §2.3).
const SQ12 = Math.sqrt(12);

function meanSd(x, get = t => x[t], n = x.length) {
  let s = 0;
  for (let t = 0; t < n; t++) s += get(t);
  const mean = s / n;
  let v = 0;
  for (let t = 0; t < n; t++) { const d = get(t) - mean; v += d * d; }
  return { mean, sd: n > 1 ? Math.sqrt(v / (n - 1)) : NaN };
}

export function portfolioReturns(sample, w) {
  const { R, n } = sample, out = new Float64Array(n);
  for (let t = 0; t < n; t++) out[t] = w[0] * R[0][t] + w[1] * R[1][t] + w[2] * R[2][t];
  return out;
}

export function pathStats(r, rf, { startMonth = null, months = null } = {}) {
  const n = r.length, wealth = new Float64Array(n + 1);
  wealth[0] = 1;
  let lg = 0;
  for (let t = 0; t < n; t++) { lg += Math.log1p(r[t]); wealth[t + 1] = wealth[t] * (1 + r[t]); }
  const raw = meanSd(r), ex = meanSd(null, t => r[t] - rf[t], n);
  let peakW = 1, peakIdx = 0, mdd = 0, trough = 0, peak = 0;
  for (let k = 1; k <= n; k++) {
    if (wealth[k] > peakW) { peakW = wealth[k]; peakIdx = k; }
    const dd = wealth[k] / peakW - 1;
    if (dd < mdd) { mdd = dd; trough = k; peak = peakIdx; }
  }
  let rec = null;
  if (mdd < 0) for (let k = trough + 1; k <= n; k++) if (wealth[k] >= wealth[peak]) { rec = k; break; }
  let worst12m = null, j = -1;
  if (n >= 12) for (let k = 0; k + 12 <= n; k++) {
    const v = wealth[k + 12] / wealth[k] - 1;
    if (worst12m === null || v < worst12m) { worst12m = v; j = k; }
  }
  const label = k => (months ? (k === 0 ? startMonth : months[k - 1]) : null);
  return {
    n, cagr: Math.expm1((12 * lg) / n), mu: 12 * raw.mean, vol: n > 1 ? SQ12 * raw.sd : null,
    sharpe: n >= 12 && ex.sd > 0 ? (SQ12 * ex.mean) / ex.sd : null,
    mdd, mddPeak: label(peak), mddTrough: label(trough), mddRecovery: rec == null ? null : label(rec),
    recoveryMonths: rec == null ? null : rec - trough,
    worst12m, worst12mEnd: months && j >= 0 ? months[j + 11] : null, cumReturn: wealth[n] - 1, wealth,
  };
}

function meanCov(cols, n) {
  const k = cols.length, mean = cols.map(c => { let s = 0; for (let t = 0; t < n; t++) s += c(t); return s / n; });
  const cov = mean.map(() => new Array(k).fill(0));
  for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
    let s = 0;
    for (let t = 0; t < n; t++) s += (cols[a](t) - mean[a]) * (cols[b](t) - mean[b]);
    cov[a][b] = cov[b][a] = (12 * s) / (n - 1);
  }
  return { mu: mean.map(m => 12 * m), cov };
}

export function moments(sample) {
  const { R, rf, n } = sample;
  const raw = meanCov([0, 1, 2].map(i => t => R[i][t]), n);
  const ex = meanCov([0, 1, 2].map(i => t => R[i][t] - rf[t]), n);
  let s = 0;
  for (let t = 0; t < n; t++) s += rf[t];
  return { mu: raw.mu, cov: raw.cov, muEx: ex.mu, covEx: ex.cov, rfAnn: (12 * s) / n };
}

export function teStats(rp, rb) {
  const a = meanSd(null, t => rp[t] - rb[t], rp.length), te = SQ12 * a.sd;
  return { te, activeMu: 12 * a.mean, ir: te > 0 ? (12 * a.mean) / te : null };
}

// OLS y = α + βx with Newey-West (Bartlett, 12 lags, no df correction) t-stat for α; centred R².
export function olsAlphaBeta(y, x, lags = 12) {
  const n = y.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < n; t++) { sx += x[t]; sy += y[t]; sxx += x[t] * x[t]; sxy += x[t] * y[t]; }
  const det = n * sxx - sx * sx, inv = [[sxx / det, -sx / det], [-sx / det, n / det]];
  const alpha = inv[0][0] * sy + inv[0][1] * sxy, beta = inv[1][0] * sy + inv[1][1] * sxy;
  const u = new Float64Array(n);
  let ssr = 0, sst = 0;
  const ym = sy / n;
  for (let t = 0; t < n; t++) { u[t] = y[t] - alpha - beta * x[t]; ssr += u[t] * u[t]; sst += (y[t] - ym) ** 2; }
  const S = [[0, 0], [0, 0]];
  for (let l = 0; l <= lags; l++) {
    const wgt = l === 0 ? 1 : 1 - l / (lags + 1);
    const G = [[0, 0], [0, 0]];
    for (let t = l; t < n; t++) {
      const a0 = u[t], a1 = x[t] * u[t], b0 = u[t - l], b1 = x[t - l] * u[t - l];
      G[0][0] += a0 * b0; G[0][1] += a0 * b1; G[1][0] += a1 * b0; G[1][1] += a1 * b1;
    }
    for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) S[p][q] += l === 0 ? G[p][q] : wgt * (G[p][q] + G[q][p]);
  }
  const V00 = [0, 1].reduce((acc, p) => acc + inv[0][p] * [0, 1].reduce((z, q) => z + S[p][q] * inv[q][0], 0), 0);
  return { alpha, alphaAnn: 12 * alpha, beta, tAlphaNW: alpha / Math.sqrt(V00), r2: 1 - ssr / sst };
}

// NDX mixed with cash so its excess-return volatility equals SPX's (a > 1 borrows at rf).
export function volMatched(sample) {
  const { R, rf, n } = sample;
  const a = meanSd(null, t => R[1][t] - rf[t], n).sd / meanSd(null, t => R[0][t] - rf[t], n).sd;
  const r = new Float64Array(n);
  for (let t = 0; t < n; t++) r[t] = a * R[0][t] + (1 - a) * rf[t];
  return { a, r, stats: pathStats(r, rf, { startMonth: sample.start, months: sample.months }), levered: a > 1 };
}

// ---- randomness: mulberry32, per-draw seeding and circular blocks (bit-exact contract with the Python port)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const drawSeed = (seed, b) => (seed ^ Math.imul(b + 1, 0x9e3779b1)) >>> 0;

// Block length actually used: the requested block capped at ⌊n/4⌋ (≥ 1), so every draw has at least 4 blocks. A single
// block of length n only rotates the sample, which leaves means, vols and Sharpe unchanged and collapses the interval.
export const effectiveBlock = (n, block = 24) => Math.max(1, Math.min(block, Math.floor(n / 4)));

export function blockIndices(n, block, rng, out = new Int32Array(n)) {
  for (let k = 0, m = 0; m < n; k++) {
    const s = Math.floor(rng() * n);
    for (let j = 0; j < block && m < n; j++) out[m++] = (s + j) % n;
  }
  return out;
}

export function quantile7(values, p) {
  const x = Float64Array.from(values).sort(), h = (x.length - 1) * p, lo = Math.floor(h);
  return x[lo] + (h - lo) * (x[Math.min(lo + 1, x.length - 1)] - x[lo]);
}

function sharpeAt(ri, rf, idx) {
  const { mean, sd } = meanSd(null, t => ri[idx[t]] - rf[idx[t]], idx.length);
  return (SQ12 * mean) / sd;
}

// `block` in the result is the effective block length (see effectiveBlock).
export function sharpeDiffCI(sample, i, j, { B = 1000, block = 24, seed = 20260912 } = {}) {
  const { R, rf, n } = sample, idx = new Int32Array(n), d = new Float64Array(B), blk = effectiveBlock(n, block);
  for (let b = 0; b < B; b++) {
    blockIndices(n, blk, mulberry32(drawSeed(seed, b)), idx);
    d[b] = sharpeAt(R[i], rf, idx) - sharpeAt(R[j], rf, idx);
  }
  const identity = Int32Array.from({ length: n }, (_, t) => t);
  return { point: sharpeAt(R[i], rf, identity) - sharpeAt(R[j], rf, identity), lo: quantile7(d, 0.025), hi: quantile7(d, 0.975), B, block: blk, seed };
}
