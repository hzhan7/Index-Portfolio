"""Inputs for the independent cross-check: history (schema v2) and valuation anchors.

When docs/data/history.json is still schema v1 or docs/data/valuation.json is absent, equivalent in-memory
documents are assembled from the research backfills (SPEC §1.1/§1.2) so development can proceed; the output
JSON records which mode was used and the tests refuse a fallback-mode file once the real inputs exist.
"""
import csv
import hashlib
import json
import math
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
HISTORY = REPO / 'docs/data/history.json'
VALUATION = REPO / 'docs/data/valuation.json'
SCRATCH = Path('/private/tmp/claude-501/-Users-hainan-Projects-Index-Portfolio--claude-worktrees-index-portfolio-optimization-7bdaf1/'
               '32585fd6-1426-4b6a-b4bf-d4aa32c4bf87/scratchpad/research')
BASIS_SHIFT_LN = 0.14


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def month_index(m):
    return int(m[:4]) * 12 + int(m[5:7]) - 1


def month_diff(a, b):
    return month_index(b) - month_index(a)


# ------------------------------------------------------------------------------------------------ history
def _fallback_history(doc):
    rows = {o['month']: o for o in doc['observations']}
    with open(SCRATCH / 'd1-ndx-dividends/ndx_dividend_backfill_1985_1999.csv') as f:
        for r in csv.DictReader(f):
            for band in ('default', 'low', 'high'):
                rows[r['month']]['ndx_div_' + band] = float(r['div_' + band])
    levels = {}
    with open(SCRATCH / 'd2-spx-tr-early/spxtr_backfill_1985_1987_recommended.csv') as f:
        for r in csv.DictReader(f):
            levels[r['month']] = float(r['SPXTR'])
    levels['1988-01'] = rows['1988-01']['SPXTR']
    months = sorted(levels)
    for prev, m in zip(months, months[1:]):
        if '1985-02' <= m <= '1988-01':
            rows[m]['spx_tr_con'] = levels[m] / levels[prev] - 1
    for o in doc['observations']:
        for k in ('ndx_div_default', 'ndx_div_low', 'ndx_div_high', 'spx_tr_con'):
            o.setdefault(k, None)
    doc['schemaVersion'] = 2
    return doc


def _fallback_valuation():
    c3 = SCRATCH / 'c3-decomposition'
    chain = json.load(open(c3 / 'decomposition_tables.json'))['chain_1985_2026_bridge_shift']
    bridge = {chain[0]['start']: chain[0]['M_start'], chain[1]['start']: chain[1]['M_start'], chain[1]['end']: chain[1]['M_end']}
    bbg = {}
    with open(c3 / 'bbg_screenshot_levels_extracted.csv') as f:
        for r in csv.DictReader(f):
            if r['quarter_end'][:7] in ('2004-12', '2014-12', '2024-12'):
                bbg[r['quarter_end'][:7]] = float(r['ratio_codex'])
    anchors = [dict(month=m, M=v * math.exp(BASIS_SHIFT_LN), M_raw=v, tier='bridge', alignment='shift') for m, v in sorted(bridge.items())]
    anchors += [dict(month=m, M=v, tier='bbg_chart') for m, v in sorted(bbg.items())]
    latest = dict(month='2026-08', M=1.4152, M_label=1.4152, tier='bbg_label')
    anchors.append(dict(month=latest['month'], M=latest['M'], tier='bbg_label'))
    segs = [('d1985', '1985-01', '1994-12', 'bridge', 'bridge', False), ('d1995', '1994-12', '2004-12', 'bridge', 'bridge', False),
            ('d2005', '2004-12', '2014-12', 'bbg_chart', 'bbg_chart', False), ('d2015', '2014-12', '2024-12', 'bbg_chart', 'bbg_chart', False),
            ('d2025', '2024-12', '2026-08', 'bbg_chart', 'bbg_label', True)]
    return dict(schemaVersion=1, basis_shift_ln=BASIS_SHIFT_LN, latest=latest,
                m0_1985=dict(central=anchors[0]['M'], low=1.8, high=2.5, tier='estimate'), anchors=anchors,
                segments=[dict(id=i, label=f'{a}～{b}', start=a, end=b, startTier=st, endTier=et, splice=sp) for i, a, b, st, et, sp in segs])


def load_inputs():
    hist = json.loads(HISTORY.read_text())
    mode = {'history': 'file', 'valuation': 'file'}
    if hist.get('schemaVersion') != 2:
        hist = _fallback_history(hist)
        mode['history'] = 'in-memory-fallback(v1+research backfills)'
    if VALUATION.exists():
        val = json.loads(VALUATION.read_text())
    else:
        val = _fallback_valuation()
        mode['valuation'] = 'in-memory-fallback(research c3)'
    return hist, val, mode


# ------------------------------------------------------------------------------------------------ samples
class History:
    """Column access over history rows (NaN for null)."""

    def __init__(self, doc):
        self.doc = doc
        self.rows = doc['observations']
        self.months = [o['month'] for o in self.rows]
        self.idx = {m: i for i, m in enumerate(self.months)}
        self.first, self.latest = self.months[0], self.months[-1]
        self._cols = {}

    def col(self, key):
        if key not in self._cols:
            self._cols[key] = np.array([np.nan if o.get(key) is None else float(o[key]) for o in self.rows])
        return self._cols[key]

    def resolve(self, m):
        return self.latest if m in (None, 'latest') else m


class SampleError(Exception):
    def __init__(self, code, msg):
        super().__init__(f'{code}: {msg}')
        self.code = code


def tr_components(h, band):
    """(ndx_tr, spx_tr, ndx_div, spx_div) columns per the SPEC §1.1 tr-basis rule."""
    ndx_pr, spx_pr = h.col('ndx_pr'), h.col('spx_pr')
    ndx_obs, spx_obs = h.col('ndx_tr'), h.col('spx_tr')
    ndx_tr = np.where(np.isnan(ndx_obs), ndx_pr + h.col('ndx_div_' + band), ndx_obs)
    spx_tr = np.where(np.isnan(spx_obs), h.col('spx_tr_con'), spx_obs)
    return ndx_tr, spx_tr, ndx_tr - ndx_pr, spx_tr - spx_pr


def build_sample(h, start, end=None, basis='tr', ndx_div='default', wht=0.0, min_months=24):
    end = h.resolve(end)
    if start not in h.idx or end not in h.idx or start >= end:
        raise SampleError('E_BAD_RANGE', f'{start}..{end}')
    i0, i1 = h.idx[start], h.idx[end]
    sl = slice(i0 + 1, i1 + 1)
    n = i1 - i0
    if n < min_months:
        raise SampleError('E_SHORT_SAMPLE', f'{n} < {min_months}')
    if basis == 'tr':
        ndx_tr, spx_tr, ndx_div, spx_div = tr_components(h, ndx_div)
        div = np.column_stack([ndx_div[sl], spx_div[sl]])
        R = np.column_stack([ndx_tr[sl] - wht * div[:, 0], spx_tr[sl] - wht * div[:, 1], h.col('bond_tr')[sl]])
    elif basis == 'pr':
        div = np.zeros((n, 2))
        R = np.column_stack([h.col('ndx_pr')[sl], h.col('spx_pr')[sl], h.col('bond_pr')[sl]])
    else:
        raise SampleError('E_BAD_RANGE', basis)
    rf = h.col('RF')[sl].copy()
    if np.isnan(R).any() or np.isnan(rf).any():
        raise SampleError('E_NULL_DATA', f'{start}..{end} {basis}')
    return dict(start=start, end=end, basis=basis, ndxDiv=ndx_div, wht=wht, months=h.months[sl], R=R, rf=rf, div=div, n=n,
                years=n / 12, dgs10End=float(h.col('dgs10_pct')[i1] / 100), dgs10Start=float(h.col('dgs10_pct')[i0] / 100))


def estimated_ranges(h, s):
    """Which sample months carry estimated NDX dividends / constructed SPX TR (tr basis only)."""
    if s['basis'] != 'tr':
        return dict(ndxDiv=None, spxConstructed=None)
    ms = s['months']

    def rng(flag):
        hit = [m for m in ms if flag(h.rows[h.idx[m]])]
        return dict(**{'from': hit[0], 'to': hit[-1]}, count=len(hit)) if hit else None
    return dict(ndxDiv=rng(lambda o: o.get('ndx_tr') is None), spxConstructed=rng(lambda o: o.get('spx_tr') is None))


def yield_to_annual_return(y):
    return (1 + y / 2) ** 2 - 1
