"""Metric conventions of SPEC §2.0 and the bit-exact port of the engine's mulberry32 circular block bootstrap."""
import math

import numpy as np

SQ12 = math.sqrt(12.0)
U32 = 0xFFFFFFFF


def label(k, start, months):
    """Wealth index k -> month label (k = 0 is the sample start month)."""
    return start if k == 0 else months[k - 1]


def sharpe(r, rf):
    e = np.asarray(r) - rf
    return SQ12 * e.mean() / e.std(ddof=1)


def path_stats(r, rf, start=None, months=None):
    r, rf = np.asarray(r, float), np.asarray(rf, float)
    n = len(r)
    wealth = np.concatenate([[1.0], np.cumprod(1.0 + r)])
    dd = wealth / np.maximum.accumulate(wealth) - 1
    trough = int(np.argmin(dd))
    peak = int(np.argmax(wealth[:trough + 1]))
    rec = None
    if dd[trough] < 0:
        hit = np.nonzero(wealth[trough + 1:] >= wealth[peak])[0]
        rec = trough + 1 + int(hit[0]) if len(hit) else None
    out = dict(n=n, cagr=math.expm1(12 * np.log1p(r).mean()), mu=12 * r.mean(), vol=SQ12 * r.std(ddof=1) if n > 1 else None,
               sharpe=None, mdd=float(dd[trough]), worst12m=None, cumReturn=float(wealth[-1] - 1))
    j = None
    if n >= 12:
        out['sharpe'] = sharpe(r, rf)
        roll = wealth[12:] / wealth[:-12] - 1
        j = int(np.argmin(roll))
        out['worst12m'] = float(roll[j])
    if months is not None:
        out.update(mddPeak=label(peak, start, months), mddTrough=label(trough, start, months),
                   mddRecovery=None if rec is None else label(rec, start, months),
                   recoveryMonths=None if rec is None else rec - trough,
                   worst12mEnd=None if j is None else months[j + 11])
    return out


def mean_cov(R):
    return 12 * R.mean(0), 12 * np.cov(R, rowvar=False, ddof=1)


def moments(R, rf):
    mu, cov = mean_cov(R)
    mu_ex, cov_ex = mean_cov(R - rf[:, None])
    return dict(mu=mu, cov=cov, muEx=mu_ex, covEx=cov_ex, rfAnn=12 * rf.mean())


def te_stats(rp, rb):
    a = np.asarray(rp) - rb
    te = SQ12 * a.std(ddof=1)
    return dict(te=te, activeMu=12 * a.mean(), ir=(12 * a.mean() / te) if te > 0 else None)


def ols_nw(y, x, lags=12):
    """OLS y = a + b x; Newey-West (Bartlett, `lags`, no df correction) t-stat of a; centred R^2."""
    n = len(y)
    X = np.column_stack([np.ones(n), x])
    XtXi = np.linalg.inv(X.T @ X)
    b = XtXi @ X.T @ y
    u = y - X @ b
    Xu = X * u[:, None]
    meat = Xu.T @ Xu
    for lag in range(1, lags + 1):
        G = Xu[lag:].T @ Xu[:-lag]
        meat += (1 - lag / (lags + 1)) * (G + G.T)
    V = XtXi @ meat @ XtXi
    yc = y - y.mean()
    return dict(alpha=b[0], alphaAnn=12 * b[0], beta=b[1], tAlphaNW=b[0] / math.sqrt(V[0, 0]), r2=1 - (u @ u) / (yc @ yc))


def vol_matched(s):
    R, rf = s['R'], s['rf']
    a = (R[:, 1] - rf).std(ddof=1) / (R[:, 0] - rf).std(ddof=1)
    r = a * R[:, 0] + (1 - a) * rf
    return dict(a=a, levered=bool(a > 1), r=r, stats=path_stats(r, rf, s['start'], s['months']))


# ------------------------------------------------------------------------------------------------ randomness
def imul(a, b):
    return (a * b) & U32


class Mulberry32:
    """Bit-exact port of mulberry32(seed>>>0): identical uint32 state transitions and output doubles."""

    def __init__(self, seed):
        self.a = seed & U32

    def __call__(self):
        self.a = (self.a + 0x6D2B79F5) & U32
        a = self.a
        t = imul(a ^ (a >> 15), 1 | a)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & U32) ^ t
        return ((t ^ (t >> 14)) & U32) / 4294967296.0


def draw_seed(seed, b):
    return ((seed & U32) ^ imul(b + 1, 0x9E3779B1)) & U32


def effective_block(n, block=24):
    """Requested block capped at floor(n/4), at least 1 (engine stats.effectiveBlock): one block as long as the sample only rotates it."""
    return max(1, min(block, n // 4))


def block_indices(rng, n, block):
    starts = [math.floor(rng() * n) for _ in range(-(-n // block))]
    return ((np.array(starts)[:, None] + np.arange(block)[None, :]) % n).ravel()[:n]


def quantile7(x, p):
    x = np.sort(np.asarray(x, float))
    h = (len(x) - 1) * p
    lo = math.floor(h)
    hi = min(lo + 1, len(x) - 1)
    return x[lo] + (h - lo) * (x[hi] - x[lo])


def sharpe_diff_ci(R, rf, i, j, B=1000, block=24, seed=20260912):
    n = len(rf)
    blk = effective_block(n, block)
    d = np.empty(B)
    for b in range(B):
        ix = block_indices(Mulberry32(draw_seed(seed, b)), n, blk)
        d[b] = sharpe(R[ix, i], rf[ix]) - sharpe(R[ix, j], rf[ix])
    return dict(point=sharpe(R[:, i], rf) - sharpe(R[:, j], rf), lo=quantile7(d, 0.025), hi=quantile7(d, 0.975), B=B, block=blk, seed=seed)
