"""isoVolTe bootstrap (ported RNG) and walk-forward (SPEC §2.9) on the exact solver."""
import math

import numpy as np

from .data import build_sample
from .metrics import Mulberry32, block_indices, draw_seed, effective_block, mean_cov, path_stats, quantile7
from .optim import iso_exact_cap, iso_solve


def iso_weights(mu, S, vm, k):
    res = iso_exact_cap(mu, S, vm * math.sqrt(S[1, 1]), k)
    return None if res is None else res['w']


def bootstrap_iso(s, vm=1.0, k=0.05, B=1000, block=24, seed=20260912, slsqp_draws=20, keep=5):
    R, n = s['R'], s['n']
    block = effective_block(n, block)
    draws = np.full((B, 3), np.nan)
    slsqp_diff = 0.0
    for b in range(B):
        ix = block_indices(Mulberry32(draw_seed(seed, b)), n, block)
        mu, S = mean_cov(R[ix])
        if b < slsqp_draws:
            res = iso_solve(mu, S, vm, k, slsqp_starts=10)
            slsqp_diff = max(slsqp_diff, (res or {}).get('slsqpMaxAbsDiff', 0.0))
        w = iso_weights(mu, S, vm, k)
        if w is not None:
            draws[b] = w
    ok = draws[~np.isnan(draws[:, 0])]
    q = lambda p: [quantile7(ok[:, a], p) for a in range(3)]
    return dict(rule='isoVolTe', params=dict(volMult=vm, teCap=k), B=B, block=block, seed=seed, nFeasible=len(ok),
                weights=dict(p10=q(0.1), p50=q(0.5), p90=q(0.9), mean=ok.mean(0)),
                probUstOver50=float((ok[:, 2] > 0.5).mean()), probSpxUnder1=float((ok[:, 1] < 0.01).mean()),
                probCorner=float((ok.max(1) >= 0.99).mean()), probInfeasible=(B - len(ok)) / B,
                firstDraws=draws[:keep], slsqpMaxAbsDiffFirstDraws=slsqp_diff)


def calendar_return(r, months, year):
    sel = [t for t, m in enumerate(months) if m.startswith(year)]
    return float(np.prod(1 + r[sel]) - 1) if len(sel) == 12 else None


def walk_forward_iso(h, o, vm=1.0, k=0.05, window='trailing', lookback_years=10):
    full = build_sample(h, h.first, h.latest, o['basis'], o['ndx_div'], o['wht'])
    user = build_sample(h, o['start'], o.get('end'), o['basis'], o['ndx_div'], o['wht'])
    fidx = {m: i for i, m in enumerate(full['months'])}
    L = 12 * lookback_years
    taus = [user['months'][0]] + [m for m in user['months'][1:] if m.endswith('-01')]
    weights = []
    for tau in taus:
        i = fidx[tau]
        if i < L:
            continue
        lo = i - L if window == 'trailing' else 0
        w = iso_weights(*mean_cov(full['R'][lo:i]), vm, k)
        if w is None:
            raise AssertionError(f'walk-forward window infeasible at {tau}')
        weights.append(dict(month=tau, w=w, estFrom=full['months'][lo], estTo=full['months'][i - 1]))
    if not weights:
        return dict(status='insufficient', firstOos=None, months=0)
    u0 = user['months'].index(weights[0]['month'])
    R, rf, ms = user['R'][u0:], user['rf'][u0:], user['months'][u0:]
    start = user['start'] if u0 == 0 else user['months'][u0 - 1]
    held, wi = np.empty((len(ms), 3)), 0
    for t, m in enumerate(ms):
        while wi + 1 < len(weights) and weights[wi + 1]['month'] <= m:
            wi += 1
        held[t] = weights[wi]['w']
    series = dict(rule=(R * held).sum(1), spx=R[:, 1], ndx=R[:, 0], sixty40=0.6 * R[:, 1] + 0.4 * R[:, 2], ndxSpx5050=0.5 * R[:, 0] + 0.5 * R[:, 1])
    w_static = iso_weights(*mean_cov(R), vm, k)
    wealth = {key: float(np.prod(1 + r)) for key, r in series.items()}
    return dict(status='ok' if len(ms) >= 36 else 'insufficient', window=window, params=dict(volMult=vm, teCap=k), firstOos=ms[0],
                months=len(ms), stats={key: path_stats(r, rf, start, ms) for key, r in series.items()}, weights=weights,
                wealthEnd=wealth, relToSpxEnd=wealth['rule'] / wealth['spx'],
                inSampleStatic=dict(w=w_static, stats=path_stats(R @ w_static, rf, start, ms)),
                ustOver50Years=int(sum(x['w'][2] > 0.5 for x in weights)),
                y2022=None if calendar_return(series['rule'], ms, '2022') is None else
                dict(rule=calendar_return(series['rule'], ms, '2022'), spx=calendar_return(series['spx'], ms, '2022')))
