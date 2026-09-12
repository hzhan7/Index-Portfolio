// Ternary lattice of fixed-weight portfolios (SPEC §2.6): one pass over the months per lattice point.
import { pathStats } from './stats.js?v=20260912';

// i = NDX weight in lattice steps (percent when step = 0.01), j = SPX weight; UST is the remainder.
export function ternaryLattice(sample, { step = 0.01 } = {}) {
  const S = Math.round(1 / step), N = ((S + 1) * (S + 2)) / 2, { R, rf, n } = sample;
  const [a, b, c] = R;
  const i = new Uint8Array(N), j = new Uint8Array(N);
  const cagr = new Float32Array(N), sharpe = new Float32Array(N), vol = new Float32Array(N), mdd = new Float32Array(N);
  let k = 0;
  for (let p = 0; p <= S; p++) for (let q = 0; q <= S - p; q++) {
    const w0 = p / S, w1 = q / S, w2 = (S - p - q) / S;
    let lg = 0, sr = 0, sr2 = 0, se = 0, se2 = 0, W = 1, peak = 1, dd = 0;
    for (let t = 0; t < n; t++) {
      const r = w0 * a[t] + w1 * b[t] + w2 * c[t], e = r - rf[t];
      lg += Math.log1p(r); sr += r; sr2 += r * r; se += e; se2 += e * e;
      W *= 1 + r;
      if (W > peak) peak = W;
      else if (W / peak - 1 < dd) dd = W / peak - 1;
    }
    i[k] = p; j[k] = q;
    cagr[k] = Math.expm1((12 * lg) / n);
    sharpe[k] = (Math.sqrt(12) * (se / n)) / Math.sqrt(Math.max(0, (se2 - (se * se) / n) / (n - 1)));
    vol[k] = Math.sqrt((12 * Math.max(0, sr2 - (sr * sr) / n)) / (n - 1));
    mdd[k] = dd;
    k++;
  }
  const spx = pathStats(R[1], rf);
  return { step, n: N, i, j, cagr, sharpe, vol, mdd, spx: { cagr: spx.cagr, sharpe: spx.sharpe } };
}
