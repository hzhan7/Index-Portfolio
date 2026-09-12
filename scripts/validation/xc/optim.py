"""Independent long-only 3-asset solvers.

Exact active-set enumerations on the simplex plane w = W0 + P x (x = (w_NDX, w_SPX)), each confirmed by
SciPy SLSQP multistart where the SPEC asks for it. Vol and TE constraints share the Hessian Q = P'ΣP, so
their difference is linear on the plane; that makes the two-ellipse intersection and the min-vol-on-TE-ellipse
problems closed-form.
"""
import math

import numpy as np
from scipy.optimize import brentq, minimize

from .metrics import SQ12

E_SPX = np.array([0.0, 1.0, 0.0])
W0 = np.array([0.0, 0.0, 1.0])
P = np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, -1.0]])
VERTICES = [np.array([0.0, 0.0]), np.array([1.0, 0.0]), np.array([0.0, 1.0])]
EDGES = [(np.array([0.0, 0.0]), np.array([1.0, 0.0])), (np.array([0.0, 0.0]), np.array([0.0, 1.0])),
         (np.array([1.0, 0.0]), np.array([-1.0, 1.0]))]
TOL = 1e-12


def to_w(x):
    return W0 + P @ x


def in_triangle(x, tol=TOL):
    return min(x[0], x[1], 1 - x[0] - x[1]) >= -tol


class Ellipse:
    """{x : (w(x) − centre)'Σ(w(x) − centre) ≤ rhs} expressed as x'Qx + 2b'x + s ≤ rhs."""

    def __init__(self, S, centre, rhs=0.0):
        d0 = W0 - centre
        self.Q, self.b, self.s, self.rhs = P.T @ S @ P, P.T @ S @ d0, d0 @ S @ d0, rhs
        self.Qi = np.linalg.inv(self.Q)
        self.xc = -self.Qi @ self.b

    def f(self, x):
        return x @ self.Q @ x + 2 * self.b @ x + self.s

    def slack(self, x):
        return self.f(x) - self.rhs

    def extreme(self, g, sign=1.0):
        """Boundary point maximising sign·g'x."""
        r2, d = self.rhs - self.f(self.xc), self.Qi @ g
        den = g @ d
        return [] if r2 < 0 or den <= 0 else [self.xc + sign * math.sqrt(r2 / den) * d]

    def line_roots(self, p, d):
        """t with p + t·d on the boundary."""
        qa, qb, qc = d @ self.Q @ d, 2 * (d @ (self.Q @ p + self.b)), self.slack(p)
        disc = qb * qb - 4 * qa * qc
        if qa <= 0 or disc < 0:
            return []
        sd = math.sqrt(disc)
        return [(-qb - sd) / (2 * qa), (-qb + sd) / (2 * qa)]

    def edge_points(self, tol=TOL):
        return [p + min(1.0, max(0.0, t)) * d for p, d in EDGES for t in self.line_roots(p, d) if -tol <= t <= 1 + tol]


def _normalise(w):
    w = np.clip(w, 0, None)
    return w / w.sum()


# ------------------------------------------------------------------------------------------------ isoVolTe
def iso_exact_cap(mu, S, cap_vol, cap_te=None):
    cons = [Ellipse(S, np.zeros(3), cap_vol ** 2)] + ([Ellipse(S, E_SPX, cap_te ** 2)] if cap_te is not None else [])
    g = P.T @ mu
    cands = list(VERTICES)
    for E in cons:
        cands += E.extreme(g) + E.edge_points()
    if len(cons) == 2:
        E1, E2 = cons
        ell, h = 2 * (E1.b - E2.b), (E2.s - E2.rhs) - (E1.s - E1.rhs)
        if ell @ ell > 0:
            x0, u = h * ell / (ell @ ell), np.array([-ell[1], ell[0]])
            cands += [x0 + t * u for t in E1.line_roots(x0, u)]
    best = None
    for x in cands:
        if not in_triangle(x) or any(E.slack(x) > TOL for E in cons):
            continue
        w = _normalise(to_w(x))
        m, v = mu @ w, w @ S @ w
        if best is None or m > best[0] + 1e-13 or (abs(m - best[0]) <= 1e-13 and v < best[1]):
            best = (m, v, w)
    if best is None:
        return None
    w = best[2]
    te2 = (w - E_SPX) @ S @ (w - E_SPX)
    V, K = cap_vol ** 2, None if cap_te is None else cap_te ** 2
    return dict(w=w, model=dict(mu=float(mu @ w), vol=math.sqrt(w @ S @ w), te=math.sqrt(max(te2, 0.0))),
                binding=dict(vol=bool(abs(w @ S @ w - V) < 1e-10 * V), te=bool(K is not None and abs(te2 - K) < 1e-10 * K)))


def iso_slsqp(mu, S, cap_vol, cap_te=None, nstart=40, seed=0):
    sv = 1 / cap_vol ** 2
    cons = [dict(type='eq', fun=lambda w: w.sum() - 1, jac=lambda w: np.ones(3)),
            dict(type='ineq', fun=lambda w: (cap_vol ** 2 - w @ S @ w) * sv, jac=lambda w: -2 * (S @ w) * sv)]
    if cap_te is not None:
        st = 1 / cap_te ** 2
        cons.append(dict(type='ineq', fun=lambda w: (cap_te ** 2 - (w - E_SPX) @ S @ (w - E_SPX)) * st,
                         jac=lambda w: -2 * (S @ (w - E_SPX)) * st))
    starts = [np.eye(3)[i] for i in range(3)] + [np.ones(3) / 3] + list(np.random.default_rng(seed).dirichlet(np.ones(3), nstart))
    best = None
    for w0 in starts:
        w = minimize(lambda w: -10 * (mu @ w), w0, jac=lambda w: -10 * mu, method='SLSQP', bounds=[(0, 1)] * 3,
                     constraints=cons, options=dict(ftol=1e-16, maxiter=3000)).x
        if w.min() < -1e-9 or abs(w.sum() - 1) > 1e-9 or w @ S @ w > cap_vol ** 2 * (1 + 1e-9):
            continue
        if cap_te is not None and (w - E_SPX) @ S @ (w - E_SPX) > cap_te ** 2 * (1 + 1e-9):
            continue
        if best is None or mu @ w > mu @ best + 1e-14:
            best = w
    return best


def iso_solve(mu, S, vm=1.0, k=None, slsqp_starts=40):
    """Exact solution, certified against SLSQP multistart (raises if SLSQP finds a better objective)."""
    cap = vm * math.sqrt(S[1, 1])
    ex = iso_exact_cap(mu, S, cap, k)
    if slsqp_starts:
        sq = iso_slsqp(mu, S, cap, k, slsqp_starts)
        if ex is None and sq is not None:
            raise AssertionError(f'exact isoVolTe missed a feasible point vm={vm} k={k}')
        if ex is not None and sq is not None:
            if mu @ sq > ex['model']['mu'] + 1e-10:
                raise AssertionError(f'SLSQP beats exact isoVolTe vm={vm} k={k}: {sq} vs {ex["w"]}')
            ex['slsqpMaxAbsDiff'] = float(np.abs(sq - ex['w']).max())
    return ex


def min_quad(obj, con=None):
    """min obj.f over triangle ∩ con (both ellipse forms share Q). Returns the minimum value or None if empty."""
    cands = list(VERTICES) + [obj.xc]
    for p, d in EDGES:
        qa = d @ obj.Q @ d
        t = -(d @ (obj.Q @ p + obj.b)) / qa
        if 0 <= t <= 1:
            cands.append(p + t * d)
    if con is not None:
        cands += con.extreme(2 * (obj.b - con.b), sign=-1.0) + con.edge_points()
    vals = [obj.f(x) for x in cands if in_triangle(x) and (con is None or con.slack(x) <= TOL)]
    return min(vals) if vals else None


def iso_feasibility(mu, S, vm):
    sig = math.sqrt(S[1, 1])
    vol_obj, te_obj = Ellipse(S, np.zeros(3)), Ellipse(S, E_SPX)
    by_te = {str(k): math.sqrt(min_quad(vol_obj, Ellipse(S, E_SPX, k * k))) / sig for k in (0.02, 0.03, 0.04, 0.05, 0.06, 0.08)}
    by_te['none'] = math.sqrt(min_quad(vol_obj)) / sig
    te_min = min_quad(te_obj, Ellipse(S, np.zeros(3), (vm * sig) ** 2))
    return dict(minVolMultByTe=by_te, minTeForVolCap=None if te_min is None else math.sqrt(max(te_min, 0.0)))


# ------------------------------------------------------------------------------------------------ tangency
FACES = [(0,), (1,), (2,), (0, 1), (0, 2), (1, 2), (0, 1, 2)]


def tangency(mu, S, c):
    best = None
    for face in FACES:
        idx, w = list(face), np.zeros(3)
        if len(idx) == 1:
            w[idx[0]] = 1.0
        else:
            z = np.linalg.solve(S[np.ix_(idx, idx)], mu[idx] - c)
            if z.sum() <= 0 or (z / z.sum()).min() < -1e-12:
                continue
            w[idx] = z / z.sum()
            w = _normalise(w)
        prem = mu @ w - c
        if prem <= 0:
            continue
        slope = prem / math.sqrt(w @ S @ w)
        if best is None or slope > best[1] + 1e-14:
            best = (w, slope)
    if best is None:
        return dict(status='no-premium', w=None)
    w = best[0]
    return dict(status='ok', w=w, mu=float(mu @ w), vol=math.sqrt(w @ S @ w), slope=best[1], c=c)


def implied_intercept(mu, S, w, held_tol=1e-8, tol=1e-9):
    held = [i for i in range(3) if w[i] > held_tol]
    Sw = S @ w
    if len(held) >= 2:
        A = np.column_stack([np.ones(len(held)), Sw[held]])
        (c, gamma), *_ = np.linalg.lstsq(A, mu[held], rcond=None)
        resid = np.abs(mu[held] - c - gamma * Sw[held]).max()
        dual = all(mu[j] - c - gamma * Sw[j] <= tol for j in range(3) if j not in held)
        return dict(kind='point', c=float(c), gamma=float(gamma)) if gamma > tol and resid <= tol and dual else None
    i = held[0]
    lo, hi = -math.inf, mu[i]
    for j in range(3):
        if j == i:
            continue
        # μ_j − c ≤ (μ_i − c)·β with β = Σ_ij/Σ_ii  ⇔  c·(β − 1) ≤ β·μ_i − μ_j
        beta = S[i, j] / S[i, i]
        rhs = beta * mu[i] - mu[j]
        if beta > 1:
            hi = min(hi, rhs / (beta - 1))
        elif beta < 1:
            lo = max(lo, rhs / (beta - 1))
        elif rhs < 0:
            return None
    return dict(kind='interval', cLow=float(lo), cHigh=float(hi)) if lo < hi else None


def kinked_cal(mu, S, rf_ann, spread, target_vol):
    """cUsed: intercept at which the risky portfolio is the tangency (rf+spread when borrowing, rf when lending,
    the implied intercept of the unlevered frontier point otherwise; None at a vertex)."""
    tb, tl = tangency(mu, S, rf_ann + spread), tangency(mu, S, rf_ann)
    if tb['status'] == 'ok' and target_vol >= tb['vol']:
        mode, t, c_used, kind = 'lever', tb, rf_ann + spread, 'borrow'
    elif tl['status'] == 'ok' and target_vol <= tl['vol']:
        mode, t, c_used, kind = 'delever', tl, rf_ann, 'lend'
    else:
        f = iso_exact_cap(mu, S, target_vol)
        mode, t, kind = 'frontier', dict(w=f['w'], mu=f['model']['mu'], vol=f['model']['vol']), 'frontier'
        ii = implied_intercept(mu, S, f['w'])
        c_used = ii['c'] if ii is not None and ii['kind'] == 'point' else None
    L = target_vol / t['vol'] if mode != 'frontier' else 1.0
    return dict(mode=mode, w=t['w'], L=L, notional=L * t['w'], borrow=max(L - 1, 0.0), lend=max(1 - L, 0.0),
                expReturn=L * t['mu'] - (L - 1) * rf_ann - max(L - 1, 0.0) * spread, targetVol=target_vol, cUsed=c_used, cUsedKind=kind)


def levered_returns(R, rf, w, L, spread):
    return L * (R @ w) - (L - 1) * rf - max(L - 1, 0.0) * spread / 12


def tangency_thresholds(mu, S, c_lo, c_hi, held_tol=1e-8):
    """Smallest c in [c_lo, c_hi] where w_UST < 0.5, w_UST ≈ 0, w_NDX ≈ 1 (bisection on the exact solver)."""
    def w_at(c):
        t = tangency(mu, S, c)
        return None if t['status'] != 'ok' else t['w']

    preds = dict(cUstUnder50=lambda w: w[2] < 0.5, cZeroUst=lambda w: w[2] <= held_tol, cAllNdx=lambda w: w[0] >= 1 - held_tol)
    grid = np.arange(c_lo, c_hi, 2.5e-4)
    out = {}
    for name, pred in preds.items():
        out[name] = None
        prev = None
        for c in grid:
            w = w_at(c)
            if w is not None and pred(w):
                if prev is None:
                    out[name] = float(c)
                    break
                lo, hi = prev, c
                for _ in range(200):
                    mid = 0.5 * (lo + hi)
                    wm = w_at(mid)
                    if wm is not None and pred(wm):
                        hi = mid
                    else:
                        lo = mid
                out[name] = float(hi)
                break
            prev = c
    return out


# ------------------------------------------------------------------------------------------------ path-based objectives
def simplex_grid(steps):
    i, j = np.meshgrid(np.arange(steps + 1), np.arange(steps + 1), indexing='ij')
    m = (i + j) <= steps
    return np.column_stack([i[m], j[m], steps - i[m] - j[m]]).astype(float) / steps


def _grid_eval(R, rf, W, chunk=20000):
    sh, lg = np.empty(len(W)), np.empty(len(W))
    for s in range(0, len(W), chunk):
        Pm = R @ W[s:s + chunk].T
        E = Pm - rf[:, None]
        sh[s:s + chunk] = SQ12 * E.mean(0) / E.std(0, ddof=1)
        lg[s:s + chunk] = np.log1p(Pm).mean(0)
    return sh, lg


def max_sharpe_cagr_floor(R, rf):
    """max path Sharpe s.t. path CAGR ≥ SPX CAGR: 0.2% grid → SLSQP from distinct seeds → 0.01% local grid → SLSQP polish."""
    g_spx = np.log1p(R[:, 1]).mean()

    def shp(w):
        e = R @ w - rf
        return SQ12 * e.mean() / e.std(ddof=1)

    def feasible(w):
        return w.min() >= -1e-10 and abs(w.sum() - 1) <= 1e-9 and np.log1p(R @ np.clip(w, 0, None)).mean() >= g_spx - 1e-13

    cons = [dict(type='eq', fun=lambda w: w.sum() - 1), dict(type='ineq', fun=lambda w: (np.log1p(R @ w).mean() - g_spx) * 1e4)]

    def polish(w0):
        w = minimize(lambda w: -shp(w), w0, method='SLSQP', bounds=[(0, 1)] * 3, constraints=cons,
                     options=dict(ftol=1e-16, maxiter=2000)).x
        return _normalise(w) if feasible(w) else None

    W = simplex_grid(500)
    sh, lg = _grid_eval(R, rf, W)
    score = np.where(lg >= g_spx - 1e-15, sh, -np.inf)
    order = np.argsort(-score)
    seeds = []
    for j in order:
        if not np.isfinite(score[j]) or len(seeds) >= 8:
            break
        if all(np.abs(W[j] - W[p]).max() > 0.02 for p in seeds):
            seeds.append(j)
    best = W[order[0]].copy()
    for j in seeds:
        w = polish(W[j])
        if w is not None and shp(w) > shp(best):
            best = w
    U = 10000
    c = np.round(best * U).astype(int)
    a, b = np.meshgrid(np.arange(-60, 61), np.arange(-60, 61), indexing='ij')
    u0, u1 = c[0] + a.ravel(), c[1] + b.ravel()
    ok = (u0 >= 0) & (u1 >= 0) & (U - u0 - u1 >= 0)
    Wl = np.column_stack([u0[ok], u1[ok], U - u0[ok] - u1[ok]]).astype(float) / U
    shl, lgl = _grid_eval(R, rf, Wl)
    fine = Wl[int(np.argmax(np.where(lgl >= g_spx - 1e-15, shl, -np.inf)))]
    for w0 in (fine, best):
        w = polish(w0)
        if w is not None and shp(w) > shp(best) + 1e-15:
            best = w
    return dict(w=best, sharpe=shp(best), cagrSlack=12 * (np.log1p(R @ best).mean() - g_spx),
                gridSharpe=float(score[order[0]]), gridW=W[order[0]])


def two_asset(R, rf, i, j, spx_stats):
    """Analytic equal-to-SPX roots for mixes x·asset_i + (1−x)·asset_j (SPEC §2.5 item 4)."""
    ei, ej = R[:, i] - rf, R[:, j] - rf
    C = np.cov(np.vstack([ei, ej]), ddof=1)
    a, b = ej.mean(), ei.mean() - ej.mean()
    c0, c1, c2 = C[1, 1], 2 * (C[0, 1] - C[1, 1]), C[0, 0] + C[1, 1] - 2 * C[0, 1]
    V = np.cov(np.vstack([R[:, i], R[:, j]]), ddof=1)
    v0, v1, v2 = V[1, 1], 2 * (V[0, 1] - V[1, 1]), V[0, 0] + V[1, 1] - 2 * V[0, 1]
    S_spx, var_spx = spx_stats['sharpe'], R[:, 1].var(ddof=1)

    def quad_roots(qa, qb, qc):
        if abs(qa) < 1e-300:
            return [] if qb == 0 else [-qc / qb]
        disc = qb * qb - 4 * qa * qc
        if disc < 0:
            return []
        sd = math.sqrt(disc)
        return [(-qb - sd) / (2 * qa), (-qb + sd) / (2 * qa)]

    def in01(xs):
        return sorted({min(1.0, max(0.0, x)) for x in xs if -1e-12 <= x <= 1 + 1e-12})

    def sharpe_x(x):
        return SQ12 * (a + b * x) / math.sqrt(c0 + c1 * x + c2 * x * x)

    sharpe_roots = [x for x in in01(quad_roots(12 * b * b - S_spx ** 2 * c2, 24 * a * b - S_spx ** 2 * c1, 12 * a * a - S_spx ** 2 * c0))
                    if np.sign(a + b * x) == np.sign(S_spx)]
    vol_roots = in01(quad_roots(v2, v1, v0 - var_spx))

    d = R[:, i] - R[:, j]
    base = 1 + R[:, j]
    g_spx = np.log1p(R[:, 1]).mean()

    def g(x):
        return np.log(base + x * d).mean()

    def dg(x):
        return (d / (base + x * d)).mean()

    if dg(0) <= 0:
        xm = 0.0
    elif dg(1) >= 0:
        xm = 1.0
    else:
        xm = brentq(dg, 0, 1, xtol=1e-15)
    cagr_roots = []
    for lo, hi in ((0.0, xm), (xm, 1.0)):
        if hi - lo <= 0:
            continue
        flo, fhi = g(lo) - g_spx, g(hi) - g_spx
        if flo == 0:
            cagr_roots.append(lo)
        if fhi == 0:
            cagr_roots.append(hi)
        if flo * fhi < 0:
            cagr_roots.append(brentq(lambda x: g(x) - g_spx, lo, hi, xtol=1e-15))
    if not cagr_roots and g(xm) == g_spx:
        cagr_roots = [xm]
    cagr_roots = sorted(set(cagr_roots))

    def trivial(x):
        """The mix is 100% SPX (x = 1 when asset i is SPX, x = 0 when asset j is SPX)."""
        return (i == 1 and abs(x - 1) < 1e-9) or (j == 1 and abs(x) < 1e-9)

    def snap(x):
        """Trivial roots snap to the exact endpoint so float ties (e.g. 3.65e-16 next to 0.0) dedupe to one root."""
        return (1.0 if x > 0.5 else 0.0) if trivial(x) else x

    split = lambda xs: ([x for x in xs if not trivial(x)], [snap(x) for x in xs if trivial(x)])
    sr, st = split(sharpe_roots)
    cr, ct = split(cagr_roots)
    vr, vt = split(vol_roots)

    # CAGR floor. g is concave, so {x : g(x) ≥ g_SPX} is an interval around the growth argmax xm. Feasibility uses a
    # 1e-15 threshold on mean log growth and the interval edges are bisected on that same test: at an SPX endpoint
    # g equals g_SPX only up to rounding (log(1 + r_j + 1·(r_i − r_j)) vs log1p(r_SPX)), and an exact comparison there
    # silently widened the interval to [0, 1] (SPX+UST best 0.449 with CAGR ≈ 9% < SPX).
    def above(x):
        return g(x) >= g_spx - 1e-15

    def edge(bad, good):
        for _ in range(200):
            mid = 0.5 * (bad + good)
            if mid == bad or mid == good:
                break
            if above(mid):
                good = mid
            else:
                bad = mid
        return good

    best = None
    if above(xm):
        xl = 0.0 if above(0.0) else edge(0.0, xm)
        xr = 1.0 if above(1.0) else edge(1.0, xm)
        cands = [xl, xr]
        den = b * c1 / 2 - a * c2
        if den != 0:
            xs = (a * c1 / 2 - b * c0) / den
            if xl < xs < xr:
                cands.append(xs)
        best = snap(max(cands, key=sharpe_x))
    # 'all-above': one non-trivial root and Sharpe above SPX beyond it, tested at the midpoint between that root and x = 1
    # (S(1) = S_SPX exactly when asset i is SPX, so the endpoint itself is a float tie)
    status = 'none' if not sr else ('all-above' if len(sr) == 1 and sharpe_x((sr[0] + 1) / 2) > S_spx else 'ok')
    return dict(roots=dict(sharpeEqSpx=sr, cagrEqSpx=cr, volEqSpx=vr, trivial=sorted(set(st + ct + vt))),
                best=dict(maxSharpeCagrFloor=best), headline=max(sr) if sr else None, status=status)
