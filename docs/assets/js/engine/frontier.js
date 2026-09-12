// Exact long-only mean-variance geometry on the 3-asset simplex: 7-face enumeration (carried over from the v1 site's
// mean-variance module, removed in v2) plus closed-form ellipse problems on the plane w = (x0, x1, 1 − x0 − x1).
import { engineError } from './params.js?v=20260912';

const TOL = 1e-10;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const quad = (w, cov) => dot(w, [dot(cov[0], w), dot(cov[1], w), dot(cov[2], w)]);
const FACES = Array.from({ length: 7 }, (_, i) => [0, 1, 2].filter(j => (i + 1) & (1 << j)));
const point = (w, mu, cov) => ({ w, mu: dot(w, mu), vol: Math.sqrt(Math.max(0, quad(w, cov))) });

// Row-scaled Gaussian elimination with partial pivoting; null means singular.
function linearSolve(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => {
    const scale = Math.max(...row.map(Math.abs));
    return scale > 0 ? [...row.map(x => x / scale), rhs[i] / scale] : [...row, rhs[i]];
  });
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[p][k])) p = i;
    if (Math.abs(a[p][k]) < 1e-13) return null;
    [a[k], a[p]] = [a[p], a[k]];
    const piv = a[k][k];
    for (let j = k; j <= n; j++) a[k][j] /= piv;
    for (let i = 0; i < n; i++) if (i !== k) { const f = a[i][k]; for (let j = k; j <= n; j++) a[i][j] -= f * a[k][j]; }
  }
  const x = a.map(row => row[n]);
  return x.every(Number.isFinite) ? x : null;
}

function embed(face, local) {
  if (!local || local.some(x => x < -TOL) || Math.abs(local.reduce((s, x) => s + x, 0) - 1) > 1e-8) return null;
  const w = [0, 0, 0];
  face.forEach((j, i) => { w[j] = Math.max(0, local[i]); });
  const sum = w[0] + w[1] + w[2];
  return w.map(x => x / sum);
}

function faceMinVariance(mu, cov, face, target) {
  const m = face.length;
  if (target == null) {
    if (m === 1) { const w = [0, 0, 0]; w[face[0]] = 1; return w; }
    const kkt = face.map(i => [...face.map(j => cov[i][j]), 1]);
    kkt.push([...Array(m).fill(1), 0]);
    return embed(face, linearSolve(kkt, [...Array(m).fill(0), 1])?.slice(0, m));
  }
  const means = face.map(i => mu[i]), lo = Math.min(...means), hi = Math.max(...means);
  if (target < lo - 1e-11 || target > hi + 1e-11) return null;
  if (hi - lo < 1e-13) return Math.abs(target - means[0]) < 1e-10 ? faceMinVariance(mu, cov, face, null) : null;
  const kkt = face.map(i => [...face.map(j => cov[i][j]), 1, mu[i]]);
  kkt.push([...Array(m).fill(1), 0, 0], [...means, 0, 0]);
  return embed(face, linearSolve(kkt, [...Array(m).fill(0), 1, target])?.slice(0, m));
}

function minVariance(mu, cov, target = null, allowed = [0, 1, 2]) {
  let best = null;
  for (const face of FACES.filter(f => f.every(i => allowed.includes(i)))) {
    const w = faceMinVariance(mu, cov, face, target);
    if (!w || (target != null && Math.abs(dot(w, mu) - target) > 2e-9)) continue;
    const v = quad(w, cov), p = point(w, mu, cov);
    if (!best || v < best.v - 1e-15 || (Math.abs(v - best.v) <= 1e-15 && p.mu > best.p.mu)) best = { v, p };
  }
  return best?.p ?? null;
}

export function solveFrontier(mu, cov, { points = 121 } = {}) {
  const gmv = minVariance(mu, cov);
  if (!gmv) throw engineError('E_INFEASIBLE', '协方差矩阵异常，无法求最小方差组合');
  const maxMean = Math.max(...mu);
  const maxReturn = minVariance(mu, cov, null, [0, 1, 2].filter(i => Math.abs(mu[i] - maxMean) < 1e-12));
  const frontier = [];
  if (maxMean - gmv.mu < 1e-12) frontier.push(gmv);
  else for (let i = 0; i < points; i++) {
    const target = gmv.mu + ((maxMean - gmv.mu) * i) / (points - 1);
    const p = i === 0 ? gmv : i === points - 1 ? maxReturn : minVariance(mu, cov, target);
    if (!p) throw engineError('E_INFEASIBLE', `有效前沿在目标收益 ${target} 处无解`);
    frontier.push(p);
  }
  return { gmv, maxReturn, frontier };
}

export function tangency(mu, cov, c) {
  const none = status => ({ status, w: null, mu: null, vol: null, slope: null });
  if (Math.max(...mu) <= c + 1e-14) return none('no-premium');
  let best = null, zeroVariance = false;
  for (const face of FACES) {
    const z = face.length === 1 ? [1] : linearSolve(face.map(i => face.map(j => cov[i][j])), face.map(i => mu[i] - c));
    if (!z) continue;
    const total = z.reduce((s, x) => s + x, 0);
    const w = total > 0 ? embed(face, z.map(x => x / total)) : null;
    if (!w) continue;
    const p = point(w, mu, cov);
    if (p.mu <= c) continue;
    if (p.vol <= 1e-12) { zeroVariance = true; continue; }
    const slope = (p.mu - c) / p.vol;
    if (!best || slope > best.slope + 1e-14) best = { ...p, slope };
  }
  if (zeroVariance) return none('zero-variance');
  return best ? { status: 'ok', ...best } : none('singular');
}

// Intercept c (and γ) for which w satisfies the long-only tangency KKT conditions; vertices give an interval.
// Interval: vertex = held asset; openAbove = only the vertex's own μ bounds it above (every c in [cLow, μ_vertex) gives
// the vertex); otherwise a higher-beta asset takes over above cHigh.
export function impliedIntercept(mu, cov, w, { heldTol = 1e-8, tol = 1e-9 } = {}) {
  const held = [0, 1, 2].filter(i => w[i] > heldTol), Sw = [dot(cov[0], w), dot(cov[1], w), dot(cov[2], w)];
  if (held.length >= 2) {
    let m = 0, s = 0, s2 = 0, y = 0, sy = 0;
    for (const i of held) { m++; s += Sw[i]; s2 += Sw[i] ** 2; y += mu[i]; sy += Sw[i] * mu[i]; }
    const det = m * s2 - s * s;
    if (!(Math.abs(det) > 0)) return null;
    const c = (s2 * y - s * sy) / det, gamma = (m * sy - s * y) / det;
    const resid = Math.max(...held.map(i => Math.abs(mu[i] - c - gamma * Sw[i])));
    const dual = [0, 1, 2].filter(j => !held.includes(j)).every(j => mu[j] - c - gamma * Sw[j] <= tol);
    return gamma > tol && resid <= tol && dual ? { kind: 'point', c, gamma } : null;
  }
  const i = held[0];
  let lo = -Infinity, hi = mu[i];
  for (const j of [0, 1, 2].filter(k => k !== i)) {
    const beta = cov[i][j] / cov[i][i], rhs = beta * mu[i] - mu[j]; // μ_j − c ≤ β(μ_i − c) ⇔ c(β − 1) ≤ βμ_i − μ_j
    if (beta > 1) hi = Math.min(hi, rhs / (beta - 1));
    else if (beta < 1) lo = Math.max(lo, rhs / (beta - 1));
    else if (rhs < 0) return null;
  }
  return lo < hi ? { kind: 'interval', cLow: Number.isFinite(lo) ? lo : null, cHigh: hi, vertex: i, openAbove: hi >= mu[i] - 1e-12 } : null;
}

export function tangencyPath(mu, cov, { cMin, cMax, step = 0.0005 } = {}) {
  const points = [];
  for (let k = 0; ; k++) {
    const c = cMin + k * step;
    if (c > cMax + 1e-12) break;
    const t = tangency(mu, cov, c);
    points.push({ c, w: t.w, mu: t.mu, vol: t.vol });
  }
  const wAt = c => tangency(mu, cov, c).w;
  const threshold = pred => {
    const k = points.findIndex(p => p.w && pred(p.w));
    if (k < 0) return null;
    if (k === 0) return points[0].c;
    let lo = points[k - 1].c, hi = points[k].c;
    for (let it = 0; it < 100 && hi - lo > 1e-15; it++) {
      const mid = (lo + hi) / 2, w = wAt(mid);
      if (w && pred(w)) hi = mid; else lo = mid;
    }
    return hi;
  };
  return {
    points, cUstUnder50: threshold(w => w[2] < 0.5), cZeroUst: threshold(w => w[2] <= 1e-8), cAllNdx: threshold(w => w[0] >= 1 - 1e-8),
  };
}

// ---- plane geometry: x = (w_NDX, w_SPX); every quadratic form (w − centre)'Σ(w − centre) shares A = P'ΣP
const VERTICES = [[0, 0], [1, 0], [0, 1]];
const EDGES = [[[0, 0], [1, 0]], [[0, 0], [0, 1]], [[1, 0], [-1, 1]]];
const EPS = 1e-12;
const toW = x => [x[0], x[1], 1 - x[0] - x[1]];
const inTriangle = x => Math.min(x[0], x[1], 1 - x[0] - x[1]) >= -EPS;

export function planeEllipse(cov, centre = [0, 0, 0], rhs = 0) {
  const A = [[cov[0][0] - 2 * cov[0][2] + cov[2][2], cov[0][1] - cov[0][2] - cov[1][2] + cov[2][2]], [0, cov[1][1] - 2 * cov[1][2] + cov[2][2]]];
  A[1][0] = A[0][1];
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0], Ai = [[A[1][1] / det, -A[0][1] / det], [-A[0][1] / det, A[0][0] / det]];
  const d0 = [-centre[0], -centre[1], 1 - centre[2]], v = [dot(cov[0], d0), dot(cov[1], d0), dot(cov[2], d0)];
  const b = [v[0] - v[2], v[1] - v[2]], s = dot(d0, v);
  const Ax = x => [A[0][0] * x[0] + A[0][1] * x[1], A[1][0] * x[0] + A[1][1] * x[1]];
  const f = x => { const q = Ax(x); return x[0] * q[0] + x[1] * q[1] + 2 * (b[0] * x[0] + b[1] * x[1]) + s; };
  const xc = [-(Ai[0][0] * b[0] + Ai[0][1] * b[1]), -(Ai[1][0] * b[0] + Ai[1][1] * b[1])];
  const E = { A, b, s, rhs, f, xc, slack: x => f(x) - rhs };
  E.extreme = (g, sign = 1) => { // boundary point maximising sign·g'x
    const r2 = rhs - f(xc), d = [Ai[0][0] * g[0] + Ai[0][1] * g[1], Ai[1][0] * g[0] + Ai[1][1] * g[1]], den = g[0] * d[0] + g[1] * d[1];
    if (r2 < 0 || !(den > 0)) return [];
    const k = sign * Math.sqrt(r2 / den);
    return [[xc[0] + k * d[0], xc[1] + k * d[1]]];
  };
  E.lineRoots = (p, d) => {
    const Ad = Ax(d), Ap = Ax(p), qa = d[0] * Ad[0] + d[1] * Ad[1];
    const qb = 2 * (d[0] * (Ap[0] + b[0]) + d[1] * (Ap[1] + b[1])), qc = E.slack(p), disc = qb * qb - 4 * qa * qc;
    if (!(qa > 0) || disc < 0) return [];
    const sd = Math.sqrt(disc);
    return [(-qb - sd) / (2 * qa), (-qb + sd) / (2 * qa)];
  };
  E.edgePoints = () => EDGES.flatMap(([p, d]) => E.lineRoots(p, d).filter(t => t >= -EPS && t <= 1 + EPS)
    .map(t => { const u = Math.min(1, Math.max(0, t)); return [p[0] + u * d[0], p[1] + u * d[1]]; }));
  return E;
}

const normalise = w => { const c = w.map(x => Math.max(0, x)), s = c[0] + c[1] + c[2]; return c.map(x => x / s); };

// max μ'w on the simplex s.t. w'Σw ≤ volCap² and (w − e_SPX)'Σ(w − e_SPX) ≤ teCap² (teCap null = no TE cap).
export function maxReturnInEllipses(mu, cov, volCap, teCap = null) {
  const cons = [planeEllipse(cov, [0, 0, 0], volCap * volCap)];
  if (teCap != null) cons.push(planeEllipse(cov, [0, 1, 0], teCap * teCap));
  const g = [mu[0] - mu[2], mu[1] - mu[2]], cands = [...VERTICES];
  for (const E of cons) cands.push(...E.extreme(g), ...E.edgePoints());
  if (cons.length === 2) { // both boundaries: their difference is the line ℓ'x = h
    const [E1, E2] = cons, l = [2 * (E1.b[0] - E2.b[0]), 2 * (E1.b[1] - E2.b[1])], ll = l[0] * l[0] + l[1] * l[1];
    const h = (E2.s - E2.rhs) - (E1.s - E1.rhs);
    if (ll > 0) {
      const x0 = [(h * l[0]) / ll, (h * l[1]) / ll], u = [-l[1], l[0]];
      for (const t of E1.lineRoots(x0, u)) cands.push([x0[0] + t * u[0], x0[1] + t * u[1]]);
    }
  }
  let best = null;
  for (const x of cands) {
    if (!inTriangle(x) || cons.some(E => !(E.slack(x) <= EPS))) continue; // NaN caps are never satisfied
    const w = normalise(toW(x)), m = dot(mu, w), v = quad(w, cov);
    if (!best || m > best.m + 1e-13 || (Math.abs(m - best.m) <= 1e-13 && v < best.v)) best = { w, m, v };
  }
  return best && best.w;
}

// min of obj.f over simplex ∩ {con ≤ rhs} (both from planeEllipse on the same Σ); null when empty.
export function minQuadOnSimplex(obj, con = null) {
  const cands = [...VERTICES, obj.xc];
  for (const [p, d] of EDGES) {
    const Ad = [obj.A[0][0] * d[0] + obj.A[0][1] * d[1], obj.A[1][0] * d[0] + obj.A[1][1] * d[1]];
    const Ap = [obj.A[0][0] * p[0] + obj.A[0][1] * p[1], obj.A[1][0] * p[0] + obj.A[1][1] * p[1]];
    const t = -(d[0] * (Ap[0] + obj.b[0]) + d[1] * (Ap[1] + obj.b[1])) / (d[0] * Ad[0] + d[1] * Ad[1]);
    if (t >= 0 && t <= 1) cands.push([p[0] + t * d[0], p[1] + t * d[1]]);
  }
  if (con) cands.push(...con.extreme([2 * (obj.b[0] - con.b[0]), 2 * (obj.b[1] - con.b[1])], -1), ...con.edgePoints());
  let best = null;
  for (const x of cands) if (inTriangle(x) && (!con || con.slack(x) <= EPS)) { const v = obj.f(x); if (best === null || v < best) best = v; }
  return best;
}

// Kinked capital allocation line: borrow at rf + spread, lend at rf (Brennan).
// cUsed = intercept at which the risky portfolio w is the tangency: rf + spread ('borrow'), rf ('lend'), or for the
// unlevered frontier point its implied intercept, which lies between the two (null at a vertex).
export function kinkedCal(mu, cov, { rfAnn, spread = 0, targetVol }) {
  const tb = tangency(mu, cov, rfAnn + spread), tl = tangency(mu, cov, rfAnn);
  let mode, t, cUsed, cUsedKind;
  if (tb.status === 'ok' && targetVol >= tb.vol) [mode, t, cUsed, cUsedKind] = ['lever', tb, rfAnn + spread, 'borrow'];
  else if (tl.status === 'ok' && targetVol <= tl.vol) [mode, t, cUsed, cUsedKind] = ['delever', tl, rfAnn, 'lend'];
  else {
    const w = maxReturnInEllipses(mu, cov, targetVol);
    if (!w) return { mode: 'infeasible', w: null, L: null, notional: null, borrow: null, lend: null, expReturn: null, targetVol, cUsed: null, cUsedKind: null };
    const ii = impliedIntercept(mu, cov, w);
    [mode, t, cUsed, cUsedKind] = ['frontier', point(w, mu, cov), ii?.kind === 'point' ? ii.c : null, 'frontier'];
  }
  const L = mode === 'frontier' ? 1 : targetVol / t.vol;
  return {
    mode, w: t.w, L, notional: t.w.map(x => L * x), borrow: Math.max(L - 1, 0), lend: Math.max(1 - L, 0),
    expReturn: L * t.mu - (L - 1) * rfAnn - Math.max(L - 1, 0) * spread, targetVol, cUsed, cUsedKind,
  };
}

export function leveredReturns(sample, w, L, spread = 0) {
  const { R, rf, n } = sample, out = new Float64Array(n), fee = (Math.max(L - 1, 0) * spread) / 12;
  for (let t = 0; t < n; t++) out[t] = L * (w[0] * R[0][t] + w[1] * R[1][t] + w[2] * R[2][t]) - (L - 1) * rf[t] - fee;
  return out;
}
