"""Head-to-head, rolling excess, regime/decade tables and the relative P/E anchor decomposition (SPEC §2.7)."""
import math

import numpy as np

from .data import build_sample, estimated_ranges, month_diff
from .metrics import ols_nw, path_stats, quantile7, sharpe_diff_ci, vol_matched

REGIMES = [('prebubble', '泡沫前', '1985-01', '1994-12'), ('bubble', '互联网泡沫', '1994-12', '2000-03'),
           ('bust', '泡沫破裂', '2000-03', '2002-09'), ('recovery', '复苏', '2002-09', '2007-10'),
           ('gfc', '全球金融危机', '2007-10', '2009-02'), ('bull', '十年牛市', '2009-02', '2019-12'),
           ('covid', '疫情宽松', '2019-12', '2021-12'), ('hike', '加息熊市', '2021-12', '2022-12'), ('ai', 'AI行情', '2022-12', 'latest')]
DECADES = ['1985-01', '1994-12', '2004-12', '2014-12', '2024-12', 'latest']
SHORT_MONTHS = 36


def _sample(h, o, **over):
    o = {**o, **over}
    return build_sample(h, o['start'], o.get('end'), o['basis'], o['ndx_div'], o['wht'], o.get('min_months', 24))


def head_to_head(h, o, seed=20260912):
    s = _sample(h, o)
    R, rf = s['R'], s['rf']
    ndx, spx = (path_stats(R[:, a], rf, s['start'], s['months']) for a in (0, 1))
    diff = {k: None if ndx[k] is None or spx[k] is None else ndx[k] - spx[k] for k in ('cagr', 'sharpe', 'vol', 'mdd', 'worst12m')}
    vm = vol_matched(s)
    out = dict(ndx=ndx, spx=spx, diff=diff,
               volMatched=dict(a=vm['a'], levered=vm['levered'], ndxCagr=vm['stats']['cagr'], spxCagr=spx['cagr'],
                               spread=vm['stats']['cagr'] - spx['cagr'], ndxMdd=vm['stats']['mdd']),
               alphaBeta=ols_nw(R[:, 0] - rf, R[:, 1] - rf), sharpeDiffCI=sharpe_diff_ci(R, rf, 0, 1, seed=seed),
               priceBasis=None, divContribution=None, estimateImpact=None)
    if s['basis'] != 'tr':
        return out
    p = _sample(h, o, basis='pr')
    pn, ps = path_stats(p['R'][:, 0], p['rf']), path_stats(p['R'][:, 1], p['rf'])
    out['priceBasis'] = dict(ndxSharpe=pn['sharpe'], spxSharpe=ps['sharpe'], ndxCagr=pn['cagr'], spxCagr=ps['cagr'])
    out['divContribution'] = dict(ndx=ndx['cagr'] - pn['cagr'], spx=spx['cagr'] - ps['cagr'])
    if estimated_ranges(h, s)['ndxDiv'] is not None:
        band = {}
        for b in ('low', 'high'):
            q = _sample(h, o, ndx_div=b)
            qn, qs = path_stats(q['R'][:, 0], q['rf']), path_stats(q['R'][:, 1], q['rf'])
            band[b] = (qn['cagr'], qn['sharpe'], qn['sharpe'] - qs['sharpe'])
        out['estimateImpact'] = {k: [band['low'][i], band['high'][i]] for i, k in enumerate(('ndxCagr', 'ndxSharpe', 'sharpeDiff'))}
    return out


def relative_wealth(s):
    R = s['R']
    ratio = np.concatenate([[1.0], np.cumprod(1 + R[:, 0]) / np.cumprod(1 + R[:, 1])])
    return dict(months=[s['start']] + s['months'], ratio=ratio, endRatio=float(ratio[-1]))


def losing_runs(starts, excess, max_gap=12):
    """Losing start months (excess ≤ 0) grouped into runs; runs merge when ≤ max_gap non-losing months separate them."""
    runs = []
    for m, v in zip(starts, excess):
        if v > 0:
            continue
        if runs and month_diff(runs[-1]['to'], m) - 1 <= max_gap:
            runs[-1]['to'] = m
            runs[-1]['n'] += 1
        else:
            runs.append({'from': m, 'to': m, 'n': 1})
    return sorted(runs, key=lambda r: -r['n'])


def rolling_excess(h, o, years=10, volmatched=False):
    s = _sample(h, o, start=h.first, end=h.latest)
    R, rf, L = s['R'], s['rf'], 12 * years
    starts, ends, plain, vm = [], [], [], []
    for k in range(s['n'] - L + 1):
        rn, rs, f = R[k:k + L, 0], R[k:k + L, 1], rf[k:k + L]
        cs = math.expm1(12 * np.log1p(rs).mean())
        a = (rs - f).std(ddof=1) / (rn - f).std(ddof=1)
        plain.append(math.expm1(12 * np.log1p(rn).mean()) - cs)
        vm.append(math.expm1(12 * np.log1p(a * rn + (1 - a) * f).mean()) - cs)
        starts.append(s['start'] if k == 0 else s['months'][k - 1])
        ends.append(s['months'][k + L - 1])
    ex = np.array(vm if volmatched else plain)
    out = dict(years=years, volMatched=volmatched, points=dict(start=starts, end=ends, excess=ex), n=len(ex))
    if not len(ex):
        return {**out, 'nWin': 0, 'winRate': None, 'median': None, 'p10': None, 'p90': None, 'worst': None, 'nLose': 0,
                'losingRuns': [], 'vmWinRate': None}
    j = int(np.argmin(ex))
    n_win = int((ex > 0).sum())
    return {**out, 'nWin': n_win, 'winRate': n_win / len(ex), 'median': quantile7(ex, 0.5), 'p10': quantile7(ex, 0.1),
            'p90': quantile7(ex, 0.9), 'worst': dict(start=starts[j], end=ends[j], excess=float(ex[j])), 'nLose': len(ex) - n_win,
            'losingRuns': losing_runs(starts, ex), 'vmWinRate': float((np.array(vm) > 0).mean())}


def _period_row(h, o, pid, label, a, b):
    b = h.resolve(b)
    s = _sample(h, o, start=a, end=b, min_months=1)

    def side(r):
        st = path_stats(r, s['rf'])
        return dict(cagr=st['cagr'], cumReturn=st['cumReturn'], sharpe=st['sharpe'] if s['n'] >= SHORT_MONTHS else None, mdd=st['mdd'])
    ndx, spx = side(s['R'][:, 0]), side(s['R'][:, 1])
    return {'id': pid, 'label': label, 'from': a, 'to': b, 'n': s['n'], 'short': s['n'] < SHORT_MONTHS, 'ndx': ndx, 'spx': spx,
            'spreadCagr': ndx['cagr'] - spx['cagr']}


def regime_table(h, o):
    return [_period_row(h, o, *r) for r in REGIMES]


def decade_id(a):
    return 'd' + str(int(a[:4]) + (1 if a[5:] == '12' else 0))


def decade_table(h, o):
    return [_period_row(h, o, decade_id(a), f'{a}～{h.resolve(b)}', a, b) for a, b in zip(DECADES, DECADES[1:])]


# ------------------------------------------------------------------------------------------------ decomposition
def anchor_value(val, month, tier):
    for a in val['anchors']:
        if a['month'] == month and a['tier'] == tier:
            return a['M']
    if month == val['latest']['month'] and tier == val['latest']['tier']:
        return val['latest']['M']
    raise KeyError(f'anchor {month}/{tier}')


def _material(ln, years):
    return abs(ln) >= 0.10 and abs(100 * ln / years) >= 1.0


def decomp_row(h, a, b, m_start, m_end, ndx_div='default', wht=0.0):
    years = month_diff(a, b) / 12
    i0, i1 = h.idx[a], h.idx[b]
    NDX, SPX = h.col('NDX'), h.col('SPX')
    ln_r = math.log((NDX[i1] / SPX[i1]) / (NDX[i0] / SPX[i0]))
    ln_m = math.log(m_end / m_start)
    ln_e = ln_r - ln_m
    s = build_sample(h, a, b, 'tr', ndx_div, wht, min_months=1)
    sl = slice(i0 + 1, i1 + 1)
    div = ((np.log1p(s['R'][:, 0]).sum() - np.log1p(h.col('ndx_pr')[sl]).sum())
           - (np.log1p(s['R'][:, 1]).sum() - np.log1p(h.col('spx_pr')[sl]).sum()))
    ln_t = ln_r + div
    lp = lambda x: 100 * x / years
    return dict(start=a, end=b, years=years, M_start=m_start, M_end=m_end, price_lp_yr=lp(ln_r), pe_lp_yr=lp(ln_m), eps_lp_yr=lp(ln_e),
                div_lp_yr=lp(div), tr_lp_yr=lp(ln_t),
                factors=dict(price=math.exp(ln_r), pe=math.exp(ln_m), eps=math.exp(ln_e), div=math.exp(div), tr=math.exp(ln_t)),
                sharesPrice=dict(pe=ln_m / ln_r, eps=ln_e / ln_r) if _material(ln_r, years) else None,
                sharesTr=dict(pe=ln_m / ln_t, eps=ln_e / ln_t, div=div / ln_t) if _material(ln_t, years) else None)


def break_even(h, val):
    a, b = val['segments'][0]['start'], val['segments'][-1]['end']
    r0 = h.col('NDX')[h.idx[a]] / h.col('SPX')[h.idx[a]]
    rt = h.col('NDX')[h.idx[b]] / h.col('SPX')[h.idx[b]]
    ln_r, m_end = math.log(rt / r0), val['latest']['M']
    return dict(R0=r0, RT=rt, lnR=ln_r, years=month_diff(a, b) / 12, M_end=m_end,
                m0ForPeShare=dict(p0=m_end, p25=m_end * math.exp(-0.25 * ln_r), p50=m_end * math.exp(-0.5 * ln_r)))


def split_at_m0(be, m0):
    ln_m = math.log(be['M_end'] / m0)
    ln_e = be['lnR'] - ln_m
    return dict(pe_lp_yr=100 * ln_m / be['years'], eps_lp_yr=100 * ln_e / be['years'],
                epsSharePrice=ln_e / be['lnR'] if _material(be['lnR'], be['years']) else None,
                factors=dict(pe=math.exp(ln_m), eps=math.exp(ln_e)))


def anchor_decomposition(h, val, ndx_div='default', wht=0.0, m0=None):
    segs = val['segments']
    a0, b1 = segs[0]['start'], segs[-1]['end']
    rows = []
    for sg in segs:
        override = m0 is not None and sg['start'] == a0
        m_start = m0 if override else anchor_value(val, sg['start'], sg['startTier'])
        row = decomp_row(h, sg['start'], sg['end'], m_start, anchor_value(val, sg['end'], sg['endTier']), ndx_div, wht)
        rows.append(dict(id=sg['id'], label=sg['label'], startTier='user' if override else sg['startTier'], endTier=sg['endTier'],
                         splice=sg['splice'], **row))
    m0_used = val['m0_1985']['central'] if m0 is None else m0
    full = decomp_row(h, a0, b1, m0_used, val['latest']['M'], ndx_div, wht)
    be = break_even(h, val)
    lo, hi = split_at_m0(be, val['m0_1985']['low']), split_at_m0(be, val['m0_1985']['high'])
    full.update(id='full', label='全期', startTier=val['m0_1985']['tier'] if m0 is None else 'user', endTier=val['latest']['tier'],
                splice=False, m0Used=m0_used,
                band=dict(m0Low=val['m0_1985']['low'], m0High=val['m0_1985']['high'],
                          **{k: sorted([lo[k], hi[k]]) for k in ('epsSharePrice', 'pe_lp_yr', 'eps_lp_yr')}))
    splice_total = 100 * math.log(full['M_end'] / full['M_start']) - sum(100 * math.log(r['M_end'] / r['M_start']) for r in rows)
    return dict(rows=rows, spliceRow=dict(label='口径拼接差', lp_total=splice_total, lp_yr=splice_total / full['years']),
                full=full, breakEven=be)
