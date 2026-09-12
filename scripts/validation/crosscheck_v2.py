#!/usr/bin/env python3
"""Independent numpy/scipy re-implementation of the JS engine numbers (SPEC §2.11).

    python3 scripts/validation/crosscheck_v2.py

Writes data/validation/crosscheck_v2.json (inputSha256 of docs/data/history.json and valuation.json);
tests/crosscheck.test.js compares the engine against it. Rerun whenever either input file changes.
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import scipy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xc import analytics, data, metrics, optim, robust  # noqa: E402

OUT = data.REPO / 'data/validation/crosscheck_v2.json'
SEED = 20260912

SCENARIOS = {
    'default': dict(start='1985-01'),
    'tr1999': dict(start='1999-03'),
    'tr2009': dict(start='2009-02'),
    'pr1985': dict(start='1985-01', basis='pr'),
    'pr1999': dict(start='1999-03', basis='pr'),
    'pr2009': dict(start='2009-02', basis='pr'),
    'trLow': dict(start='1985-01', ndx_div='low'),
    'trHigh': dict(start='1985-01', ndx_div='high'),
    'wht30': dict(start='1985-01', wht=0.30),
    'tr1985to2007': dict(start='1985-01', end='2007-12'),
    'tr2009m03': dict(start='2009-03'),
}
ISO_GRID = [(1.0, 0.05), (1.0, None), (1.0, 0.02), (1.0, 0.03), (1.0, 0.08), (0.8, 0.05), (0.8, 0.08), (1.1, 0.08), (0.7, 0.02)]
REFERENCES = dict(spx=[0, 1, 0], ndx=[1, 0, 0], sixty40=[0, 0.6, 0.4], ndxSpx5050=[0.5, 0.5, 0])
# Short windows (n < 96) where the effective bootstrap block drops below 24 (n = 24 → block 6, n = 30 → block 7).
SHORT_SAMPLES = {'n24_2000': dict(start='2000-03', end='2002-03'), 'n30_2008': dict(start='2008-03', end='2010-09')}
CONTEXTS = dict(tr='default', pr='pr1985', trLow='trLow', trHigh='trHigh', wht30='wht30')


def opts(name):
    sc = SCENARIOS[name]
    return dict(start=sc['start'], end=sc.get('end'), basis=sc.get('basis', 'tr'), ndx_div=sc.get('ndx_div', 'default'), wht=sc.get('wht', 0.0))


def state_of(o):
    """Engine sampleOpts spelling of a scenario."""
    return dict(start=o['start'], end=o['end'], basis=o['basis'], ndxDiv=o['ndx_div'], wht=o['wht'])


def rule_stats(s, w, spx, r=None):
    R, rf = s['R'], s['rf']
    rp = R @ w if r is None else r
    st = metrics.path_stats(rp, rf, s['start'], s['months'])
    te = metrics.te_stats(rp, R[:, 1])
    vs = {k: None if st[k] is None or spx[k] is None else st[k] - spx[k] for k in ('cagr', 'sharpe', 'vol', 'mdd', 'worst12m')}
    return st, dict(vs, te=te['te'], ir=te['ir'])


def sample_block(h, s):
    R, rf = s['R'], s['rf']
    return dict(state=dict(start=s['start'], end=s['end'], basis=s['basis'], ndxDiv=s['ndxDiv'], wht=s['wht']), n=s['n'], years=s['years'],
                firstMonth=s['months'][0], lastMonth=s['months'][-1], sumR=R.sum(0), sumR2=(R * R).sum(0), sumRf=rf.sum(),
                sumDiv=s['div'].sum(0), firstRow=dict(R=R[0], rf=rf[0]), lastRow=dict(R=R[-1], rf=rf[-1]),
                dgs10End=s['dgs10End'], dgs10Start=s['dgs10Start'], estimated=data.estimated_ranges(h, s))


def iso_block(s, mo, spx, vm, k, detail=False):
    mu, cov = mo['mu'], mo['cov']
    res = optim.iso_solve(mu, cov, vm, k)
    out = dict(params=dict(volMult=vm, teCap=k), status='infeasible' if res is None else 'ok', feasibility=optim.iso_feasibility(mu, cov, vm))
    if res is None:
        return out
    st, vs = rule_stats(s, res['w'], spx)
    out.update(w=res['w'], model=res['model'], binding=res['binding'], stats=st, vsSpx=vs, slsqpMaxAbsDiff=res.get('slsqpMaxAbsDiff'))
    if not detail:
        return out
    pure = optim.iso_solve(mu, cov, vm, None)
    te_u = pure['model']['te']
    out['pure'] = dict(w=pure['w'], model=pure['model'], teUnconstrained=te_u, impliedIntercept=optim.implied_intercept(mu, cov, pure['w']),
                       stats=rule_stats(s, pure['w'], spx)[0])
    path = {}
    for kk in (0.02, 0.03, 0.04, 0.05):
        if kk <= te_u:
            r = optim.iso_solve(mu, cov, vm, kk, slsqp_starts=0)
            path[str(kk)] = dict(k=kk, w=r['w'], mu=r['model']['mu'], vol=r['model']['vol'], te=r['model']['te'],
                                 cagr=metrics.path_stats(s['R'] @ r['w'], s['rf'])['cagr'])
    out['path'] = path
    if '0.03' in path:
        out['flatTop'] = dict(kFrom=0.03, kTo=te_u, ndxFrom=path['0.03']['w'][0], ndxTo=pure['w'][0],
                              cagrGap=out['pure']['stats']['cagr'] - path['0.03']['cagr'])
    out['muShift'] = [dict(dNdx=d, w=optim.iso_solve(mu + np.array([d, 0, 0]), cov, vm, k)['w']) for d in (-0.01, -0.02)]
    return out


def tangency_block(s, mo, spx):
    mu, cov, rf_ann = mo['mu'], mo['cov'], mo['rfAnn']
    c_y10 = data.yield_to_annual_return(s['dgs10End'])
    implied = optim.implied_intercept(mu, cov, optim.iso_exact_cap(mu, cov, math.sqrt(cov[1, 1]))['w'])
    c_imp = None if implied is None else implied['c'] if implied['kind'] == 'point' else implied['cLow']
    out = dict(rfAnn=rf_ann, cY10=c_y10, impliedIntercept=implied, cImplied=c_imp)
    for name, c in (('rf', rf_ann), ('y10', c_y10), ('implied', c_imp), ('custom7', 0.07)):
        t = None if c is None else optim.tangency(mu, cov, c)
        if t is None or t['status'] != 'ok':
            out[name] = None if t is None else dict(c=c, status=t['status'])
            continue
        st, vs = rule_stats(s, t['w'], spx)
        d = np.asarray(t['w'], float) - np.array([0.0, 1.0, 0.0])
        out[name] = dict(c=c, status='ok', w=t['w'], model=dict(mu=t['mu'], vol=t['vol'], te=math.sqrt(max(0.0, float(d @ cov @ d)))),
                         slope=t['slope'], stats=st, vsSpx=vs)
    sig = math.sqrt(cov[1, 1])
    out['levered'] = {}
    for spread in (0.0, 0.005, 0.01):
        for vm in (1.0, 0.6, 0.5):
            kc = optim.kinked_cal(mu, cov, rf_ann, spread, vm * sig)
            r = optim.levered_returns(s['R'], s['rf'], kc['w'], kc['L'], spread)
            st, vs = rule_stats(s, None, spx, r)
            y22 = robust.calendar_return(r, s['months'], '2022')
            out['levered'][f'spread{spread}_vm{vm}'] = dict(kc, spread=spread, volMult=vm, stats=st, vsSpx=vs, y2022=None if y22 is None else
                                                            dict(rule=y22, spx=robust.calendar_return(s['R'][:, 1], s['months'], '2022')))
    lo = min(c for c in (rf_ann, c_y10, c_imp) if c is not None) - 0.02
    out['thresholds'] = dict(cMin=lo, cMax=float(mu.max()), **optim.tangency_thresholds(mu, cov, lo, float(mu.max()) - 1e-9))
    return out


def two_asset_block(s, spx, i, j):
    ta = optim.two_asset(s['R'], s['rf'], i, j, spx)
    curve = {}
    for x in (0.0, 0.25, 0.5, 0.75, 1.0):
        w = np.zeros(3)
        w[i] += x
        w[j] += 1 - x
        st = metrics.path_stats(s['R'] @ w, s['rf'])
        curve[str(x)] = {k: st[k] for k in ('cagr', 'sharpe', 'vol', 'mdd')}
    return dict(pair=[i, j], **ta, curveAt=curve)


def scenario(h, name):
    o = opts(name)
    s = data.build_sample(h, o['start'], o['end'], o['basis'], o['ndx_div'], o['wht'])
    mo = metrics.moments(s['R'], s['rf'])
    assets = {k: metrics.path_stats(s['R'][:, a], s['rf'], s['start'], s['months']) for a, k in enumerate(('ndx', 'spx', 'ust'))}
    spx = assets['spx']
    out = dict(sample=sample_block(h, s), assets=assets, moments=mo, sigmaSpx=math.sqrt(mo['cov'][1, 1]),
               references={k: metrics.path_stats(s['R'] @ np.array(w, float), s['rf'], s['start'], s['months']) for k, w in REFERENCES.items()},
               h2h=analytics.head_to_head(h, o, SEED))
    rw = analytics.relative_wealth(s)
    out['relativeWealth'] = dict(endRatio=rw['endRatio'], min=float(rw['ratio'].min()), max=float(rw['ratio'].max()))
    out['isoVolTe'] = [iso_block(s, mo, spx, vm, k, detail=(vm, k) == (1.0, 0.05)) for vm, k in ISO_GRID]
    msf = optim.max_sharpe_cagr_floor(s['R'], s['rf'])
    st, vs = rule_stats(s, msf['w'], spx)
    out['maxSharpeCagrFloor'] = dict(w=msf['w'], sharpe=msf['sharpe'], cagrSlack=msf['cagrSlack'], stats=st, vsSpx=vs,
                                     gridW=msf['gridW'], gridSharpe=msf['gridSharpe'])
    out['tangency'] = tangency_block(s, mo, spx)
    pairs = ((0, 2), (1, 2), (0, 1)) if name == 'default' else ((0, 2),)
    out['twoAsset'] = {f'{i}-{j}': two_asset_block(s, spx, i, j) for i, j in pairs}
    if o['basis'] == 'tr' and name == 'default':
        mu_y = mo['mu'].copy()
        mu_y[2] = data.yield_to_annual_return(s['dgs10End']) + mo['cov'][2, 2] / 2
        my = dict(mo, mu=mu_y)
        out['y10bond'] = dict(muUsed=mu_y, isoVolTe=[iso_block(s, my, spx, 1.0, k) for k in (0.05, None)], tangency=tangency_block(s, my, spx))
    return out


def compact_rolling(ro):
    pts = ro.pop('points')
    ro['excessAtJanuary'] = {m: v for m, v in zip(pts['start'], pts['excess']) if m.endswith('-01')}
    ro['firstPoint'] = dict(start=pts['start'][0], end=pts['end'][0], excess=pts['excess'][0]) if len(pts['start']) else None
    ro['lastPoint'] = dict(start=pts['start'][-1], end=pts['end'][-1], excess=pts['excess'][-1]) if len(pts['start']) else None
    return ro


def context(h, key):
    o = opts(CONTEXTS[key])
    rolling = {}
    for years in ((5, 10, 15, 20) if key == 'tr' else (10,)):
        for vm in (False, True):
            rolling[f'{years}{"vm" if vm else ""}'] = compact_rolling(analytics.rolling_excess(h, o, years, vm))
    return dict(opts=dict(basis=o['basis'], ndxDiv=o['ndx_div'], wht=o['wht']), rolling=rolling,
                regimes=analytics.regime_table(h, o), decades=analytics.decade_table(h, o))


def decomposition(h, val):
    variants = dict(default=('default', 0.0, None), low=('low', 0.0, None), high=('high', 0.0, None), wht30=('default', 0.3, None),
                    m0_1_8=('default', 0.0, 1.8), m0_2_5=('default', 0.0, 2.5))
    out = {k: dict(args=dict(ndxDiv=d, wht=t, m0=m), **analytics.anchor_decomposition(h, val, d, t, m))
           for k, (d, t, m) in variants.items()}
    be = analytics.break_even(h, val)
    out['splitAtM0'] = {str(m): analytics.split_at_m0(be, m) for m in (0.5, 1.0, 1.4152, 2.0, 4.0)}
    return out


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, np.ndarray)):
        return [clean(v) for v in (o.tolist() if isinstance(o, np.ndarray) else o)]
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, (int, np.integer)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if math.isfinite(o) else None
    return o


def main():
    t0 = time.time()
    doc, val, mode = data.load_inputs()
    h = data.History(doc)
    res = dict(schemaVersion=1, generator='scripts/validation/crosscheck_v2.py',
               inputSha256=dict(history=data.sha256(data.HISTORY), valuation=data.sha256(data.VALUATION)), inputMode=mode,
               latest=h.latest, versions=dict(numpy=np.__version__, scipy=scipy.__version__),
               conventions=dict(seed=SEED, bootstrapBlock=24, bootstrapBlockEffective='max(1, min(24, floor(n/4)))', quantile='type7', nwLags=12,
                                losingRunMaxGap=12, shortMonths=36,
                                recoveryMonths='trough→recovery months', scenarioState={k: state_of(opts(k)) for k in SCENARIOS}),
               tolerances=dict(weightsExact=1e-6, weightsSlsqp=2e-4, stats=1e-9, roots=1e-6, bootstrap=1e-9, feasibility=1e-6))
    res['scenarios'] = {}
    for name in SCENARIOS:
        res['scenarios'][name] = scenario(h, name)
        print(f'[{time.time() - t0:6.1f}s] scenario {name}', flush=True)
    res['context'] = {key: context(h, key) for key in CONTEXTS}
    print(f'[{time.time() - t0:6.1f}s] context', flush=True)
    res['decomp'] = decomposition(h, val)
    o = opts('default')
    s = data.build_sample(h, o['start'], o['end'], o['basis'], o['ndx_div'], o['wht'])
    res['robust'] = dict(bootstrapIsoVolTe=dict(default=robust.bootstrap_iso(s, 1.0, 0.05, 1000, 24, SEED)))
    res['robust']['shortSample'] = {}
    for key, win in SHORT_SAMPLES.items():
        so = dict(start=win['start'], end=win['end'], basis='tr', ndx_div='default', wht=0.0)
        ss = data.build_sample(h, so['start'], so['end'], so['basis'], so['ndx_div'], so['wht'])
        res['robust']['shortSample'][key] = dict(state=state_of(so), n=ss['n'], sharpeDiffCI=metrics.sharpe_diff_ci(ss['R'], ss['rf'], 0, 1, seed=SEED),
                                                 bootstrapIsoVolTe=robust.bootstrap_iso(ss, 1.0, 0.05, 1000, 24, SEED))
    print(f'[{time.time() - t0:6.1f}s] bootstrap', flush=True)
    wf = dict(default_trailing=('default', 'trailing', 0.05), default_expanding=('default', 'expanding', 0.05),
              default_trailing_pure=('default', 'trailing', None), tr1999_trailing=('tr1999', 'trailing', 0.05),
              pr1985_trailing=('pr1985', 'trailing', 0.05), tr2009_trailing=('tr2009', 'trailing', 0.05))
    res['robust']['walkForwardIsoVolTe'] = {key: dict(scenario=sc, **robust.walk_forward_iso(h, opts(sc), 1.0, k, win))
                                           for key, (sc, win, k) in wf.items()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(clean(res), ensure_ascii=False, indent=1, allow_nan=False) + '\n')
    print(f'[{time.time() - t0:6.1f}s] wrote {OUT.relative_to(data.REPO)} (mode {mode})')


if __name__ == '__main__':
    main()
