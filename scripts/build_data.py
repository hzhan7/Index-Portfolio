"""Build docs/data and data/manifest.json from data/sources (stdlib only; idempotent).

Outputs: docs/data/history.json (schemaVersion 2), docs/data/monthly_history.csv, docs/data/valuation.json and
data/manifest.json. v1 row values are computed exactly as in schemaVersion 1. The 1985 backfills and their range
notes are attached here, so data/sources/data_quality.json only has to carry month-level notes.
"""
import calendar
import csv
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'data/sources'
BACKFILL = SOURCES / 'backfill_1985'
VALUATION = SOURCES / 'valuation'
OUT = ROOT / 'docs/data'
RETRIEVED = '2026-09-11'
NDX_DIV_RANGE = ('1985-02', '1999-03')
SPX_CON_RANGE = ('1985-02', '1988-01')
SPX_TR_TARGETS = {1985: 31.73, 1986: 18.67, 1987: 5.25}  # published calendar-year totals the construction is scaled to
MAX_CHAIN_GAP_LP = 2.0

sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'scripts/backfill'))
import ndx_dividends  # noqa: E402

HISTORY_SOURCES = {
    'nasdaq_ndx': dict(title='Nasdaq Global Indexes：NDX 价格指数历史', url='https://indexes.nasdaq.com/Index/History/NDX',
                       note='官网月末收盘；基值日 1985-01-31'),
    'nasdaq_xndx': dict(title='Nasdaq Global Indexes：XNDX 总回报指数历史', url='https://indexes.nasdaq.com/Index/History/XNDX',
                        note='官网月末收盘；指数起点 1999-03-04'),
    'crsp_spindx': dict(title='CRSP 标普500 日度数据（教学公开副本，spindx）',
                        url='https://lukestein-classes.github.io/fdap/data/sp500d.csv', note='由日度记录取月末收盘'),
    'fred_sp500': dict(title='FRED SP500（S&P Dow Jones Indices）', url='https://fred.stlouisfed.org/series/SP500',
                       note='实际日收盘取月末'),
    'yahoo_sp500tr': dict(title='Yahoo ^SP500TR 月末收盘',
                          url='https://github.com/vanexymx/sp500-historical-analysis/blob/main/data/SP500TR_monthly.json',
                          note='GitHub 月末快照（二手副本）；2026 年取 Yahoo 日收盘'),
    'french_rf': dict(title='Kenneth R. French 数据库：RF',
                      url='https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_factors.html',
                      note='1个月国库券月收益，原始百分数÷100'),
    'rf_estimate': dict(title='FRED DTB4WK 四周国库券报价（暂估）', url='https://fred.stlouisfed.org/series/DTB4WK',
                        note='French 尚未发布的月份按前月末银行折价报价暂估'),
    'fred_dgs10': dict(title='FRED DGS10 10年期国债收益率', url='https://fred.stlouisfed.org/series/DGS10',
                       note='月末收益率按10年期平价债券模型推算月收益'),
    'nasdaq_div_sec': dict(title='Nasdaq 年末股息率（QQQ SEC 文件）',
                           url='https://www.sec.gov/Archives/edgar/data/1067839/0001047469-99-008995.txt',
                           note='年度现金股息÷年末成分股总市值，按月平摊估算；1985 年假设同 1986 年'),
    'spx_tr_backfill': dict(title='标普500 含息 1985–1987 构建序列', url=None,
                            note='价格月收益 × CRSP 股息时点，按年校准到公开年度总回报；方法见 data/sources/backfill_1985/README.md'),
}
SERIES_LABELS = {'NDX': '纳指100 价格', 'SPX': '标普500 价格', 'NDX_TR': '纳指100 含息', 'SPX_TR': '标普500 含息',
                 'RF': '无风险利率（1个月国库券）', 'UST': '10年美债（模型）'}
RANGE_NOTES = [
    {'field': 'ndx_div', 'from': NDX_DIV_RANGE[0], 'to': NDX_DIV_RANGE[1], 'status': 'estimated',
     'note': '纳指100 月度股息收益按 Nasdaq 公布的年末股息率按月平摊估算；1985 年未公布，假设同 1986 年；低/高档为 ×0.75/×1.25。1999-04 起用 XNDX 实测。',
     'source': 'data/sources/backfill_1985/ndx_dividend_backfill_1985_1999.csv'},
    {'field': 'spx_tr', 'from': SPX_CON_RANGE[0], 'to': SPX_CON_RANGE[1], 'status': 'constructed',
     'note': '标普500 含息月收益 = 价格月收益 × CRSP 股息时点，股息部分按年校准到公开年度总回报；1988-01 = SPXTR ÷ 1987 年末基值 − 1。1988-02 起用 SPXTR 实测。',
     'source': 'data/sources/backfill_1985/spxtr_backfill_1985_1987_recommended.csv'},
]
CSV_COLUMNS = ['month', 'NDX', 'SPX', 'XNDX', 'SPXTR', 'ndx_pr', 'spx_pr', 'ndx_tr', 'spx_tr', 'bond_tr', 'bond_pr',
               'coupon', 'RF', 'dgs10_pct', 'RF_status', 'ndx_div_default', 'ndx_div_low', 'ndx_div_high', 'ndx_tr_ext',
               'ndx_tr_status', 'spx_tr_con', 'spx_tr_ext', 'spx_tr_status']


def read_csv(path):
    with path.open(newline='') as f:
        return {r['month']: r for r in csv.DictReader(f)}


def value(row, key):
    return float(row[key]) if row.get(key) else None


def in_range(month, bounds):
    return bounds[0] <= month <= bounds[1]


def month_end(month):
    year, mon = map(int, month.split('-'))
    return f'{month}-{calendar.monthrange(year, mon)[1]:02d}'


def observations(ndx, other):
    """schemaVersion 1 rows; the arithmetic must stay unchanged."""
    rows, previous = [], None
    for month in sorted(ndx.keys() & other.keys()):
        a, b = ndx[month], other[month]
        row = dict(month=month, NDX=value(a, 'NDX'), SPX=value(b, 'spx_price'), XNDX=value(a, 'XNDX'),
                   SPXTR=value(b, 'spx_total_return_index'), RF=value(b, 'RF'), dgs10_pct=value(b, 'dgs10_yield_pct'))
        for level, ret in [('NDX', 'ndx_pr'), ('SPX', 'spx_pr'), ('XNDX', 'ndx_tr'), ('SPXTR', 'spx_tr')]:
            row[ret] = row[level] / previous[level] - 1 if previous and row[level] and previous[level] else None
        y0, y1 = value(b, 'prior_dgs10_yield_pct') / 100, row['dgs10_pct'] / 100
        discount = (1 + y1 / 2) ** (-2 * (10 - 1 / 12))
        row['coupon'] = y0 / 12
        row['bond_pr'] = y0 / y1 * (1 - discount) + discount - 1
        row['bond_tr'] = row['bond_pr'] + row['coupon']
        assert abs(row['bond_tr'] - value(b, 'bond_total')) < 1e-12
        assert all(v is None or not isinstance(v, float) or math.isfinite(v) for v in row.values())
        rows.append(row)
        previous = row
    return rows


def add_backfills(rows):
    """Attach ndx_div_<band> (1985-02..1999-03) and spx_tr_con (1985-02..1988-01), checking calibration and overlap."""
    ndx_dividends.verify()
    div = read_csv(BACKFILL / 'ndx_dividend_backfill_1985_1999.csv')
    con = read_csv(BACKFILL / 'spxtr_backfill_1985_1987_recommended.csv')
    levels = {m: float(r['SPXTR']) for m, r in con.items()}
    for year, target in SPX_TR_TARGETS.items():
        assert abs((levels[f'{year}-12'] / levels[f'{year - 1}-12'] - 1) * 100 - target) < 1e-9, year
    previous = None
    for row in rows:
        month = row['month']
        estimated, constructed = in_range(month, NDX_DIV_RANGE), in_range(month, SPX_CON_RANGE)
        assert (month in div) == estimated and not (estimated and row['ndx_tr'] is not None)
        for band in ndx_dividends.BANDS:
            row[f'ndx_div_{band}'] = float(div[month][f'div_{band}']) if estimated else None
        assert not estimated or row['ndx_div_low'] <= row['ndx_div_default'] <= row['ndx_div_high']
        row['spx_tr_con'] = None
        if constructed:
            assert row['spx_tr'] is None
            level = levels[month] if row['SPXTR'] is None else row['SPXTR']  # 1988-01: observed SPXTR over the 1987-12 base
            assert level == levels[month]
            row['spx_tr_con'] = level / levels[previous['month']] - 1
            assert abs(row['spx_tr_con'] - float(con[month]['spx_tr'])) < 1e-12 and row['spx_tr_con'] >= row['spx_pr']
        previous = row
    for row in rows[1:]:
        ndx_tr = row['ndx_tr'] if row['ndx_tr'] is not None else row['ndx_div_default']
        spx_tr = row['spx_tr'] if row['spx_tr'] is not None else row['spx_tr_con']
        assert None not in (ndx_tr, spx_tr, row['bond_tr'], row['RF']), row['month']


def segments(rows, classify):
    """Merge contiguous months with equal (status, source_id); classify returns None for uncovered months."""
    out, last = [], None
    for i, row in enumerate(rows):
        kind = classify(row)
        if kind is None:
            continue
        if out and last == i - 1 and (out[-1]['status'], out[-1]['source_id']) == kind:
            out[-1]['to'] = row['month']
        else:
            out.append({'from': row['month'], 'to': row['month'], 'status': kind[0], 'source_id': kind[1]})
        last = i
    return out


def coverage(rows, other, estimated_rf):
    prefixes = {'CRSP': 'crsp_spindx', 'FRED': 'fred_sp500'}
    spx_source = lambda m: prefixes[other[m]['spx_price_source'][:4]]
    rules = {
        'NDX': lambda r: None if r['NDX'] is None else ('observed', 'nasdaq_ndx'),
        'SPX': lambda r: None if r['SPX'] is None else ('observed', spx_source(r['month'])),
        'NDX_TR': lambda r: ('observed', 'nasdaq_xndx') if r['ndx_tr'] is not None
        else ('estimated', 'nasdaq_div_sec') if r['ndx_div_default'] is not None else None,
        'SPX_TR': lambda r: ('observed', 'yahoo_sp500tr') if r['spx_tr'] is not None
        else ('constructed', 'spx_tr_backfill') if r['spx_tr_con'] is not None else None,
        'RF': lambda r: None if r['RF'] is None
        else ('estimated', 'rf_estimate') if r['month'] in estimated_rf else ('observed', 'french_rf'),
        'UST': lambda r: None if r['bond_tr'] is None else ('model', 'fred_dgs10'),
    }
    return [dict(id=key, label=SERIES_LABELS[key], segments=segments(rows, rule)) for key, rule in rules.items()]


def csv_row(row, rf_status):
    ndx_obs, ndx_est, spx_obs = row['ndx_tr'] is not None, row['ndx_div_default'] is not None, row['spx_tr'] is not None
    return {**row, 'RF_status': rf_status.get(row['month'], 'observed'),
            'ndx_tr_ext': row['ndx_tr'] if ndx_obs else row['ndx_pr'] + row['ndx_div_default'] if ndx_est else None,
            'ndx_tr_status': 'observed' if ndx_obs else 'estimated' if ndx_est else '',
            'spx_tr_ext': row['spx_tr'] if spx_obs else row['spx_tr_con'],
            'spx_tr_status': 'observed' if spx_obs else 'constructed' if row['spx_tr_con'] is not None else ''}


def fred_closes(name):
    with (VALUATION / name).open(newline='') as f:
        reader = csv.reader(f)
        next(reader)
        return {date: float(close) for date, close in reader if close}


def chain_gap_lp(rows, doc):
    """Full-period log-points minus the sum of the decade segments; price chains exactly, P/E and EPS absorb splices."""
    by = {r['month']: r for r in rows}
    ln_r = lambda m: math.log(by[m]['NDX'] / by[m]['SPX'])
    M = {(a['month'], a['tier']): a['M'] for a in doc['anchors']}
    parts = [(ln_r(s['end']) - ln_r(s['start']), math.log(M[s['end'], s['endTier']] / M[s['start'], s['startTier']]))
             for s in doc['segments']]
    first, last = doc['segments'][0], doc['segments'][-1]
    price = 100 * (ln_r(last['end']) - ln_r(first['start']) - sum(p for p, _ in parts))
    pe = 100 * (math.log(M[last['end'], last['endTier']] / doc['m0_1985']['central']) - sum(q for _, q in parts))
    return dict(price=price, pe=pe, eps=price - pe)


def valuation(rows):
    spec = json.loads((VALUATION / 'relative_pe_inputs.json').read_text())
    shift, label, last = spec['basis_shift_ln'], spec['label'], rows[-1]
    anchors = [dict(month=a['month'], M=a['M_raw'] * math.exp(shift) if a['tier'] == 'bridge' else a['M_raw'],
                    M_raw=a['M_raw'], tier=a['tier'], alignment=a['alignment'], source_id=a['source_id'])
               for a in spec['anchors']]
    ndx, spx = (fred_closes(spec['fred_closes'][k]) for k in ('NASDAQ100', 'SP500'))
    end, date = month_end(last['month']), label['labelDate']
    verified = (all(d in s for s in (ndx, spx) for d in (end, date))
                and abs(ndx[end] - last['NDX']) <= 0.005 and abs(spx[end] - last['SPX']) <= 0.005)
    if verified:  # R(end) from the site's month-end levels, R(labelDate) from FRED closes
        M = label['M_label'] * (last['NDX'] / last['SPX']) / (ndx[date] / spx[date])
        adj = f'M = M_label × R({end}) ÷ R({date})，R = 纳指100/标普500 收盘价比；假设两日之间 TTM EPS 不变'
        closes = {end: dict(NDX=last['NDX'], SPX=last['SPX'], source_id='history', fred=dict(NDX=ndx[end], SPX=spx[end])),
                  date: dict(NDX=ndx[date], SPX=spx[date], source_id='fred_daily')}
    else:
        M, closes = label['M_label'], None
        adj = f'未能核实 FRED {date} 与 {end} 收盘价：M = M_label，未做日期调整'
    latest = dict(month=last['month'], M=M, M_label=label['M_label'], labelDate=date, ndx_pe_label=label['ndx_pe_label'],
                  spx_pe_label=label['spx_pe_label'], adj=adj, verified=verified, closes=closes, tier=label['tier'],
                  source_id=label['source_id'])
    anchors.append(dict(month=last['month'], M=M, M_raw=label['M_label'], tier=label['tier'],
                        alignment='label_adjusted', source_id=label['source_id']))
    assert len({(a['month'], a['tier']) for a in anchors}) == len(anchors)
    m0 = next(a['M'] for a in anchors if (a['month'], a['tier']) == ('1985-01', 'bridge'))
    bounds = [('d1985', '1985-01', '1994-12', 'bridge', 'bridge'), ('d1995', '1994-12', '2004-12', 'bridge', 'bridge'),
              ('d2005', '2004-12', '2014-12', 'bbg_chart', 'bbg_chart'),
              ('d2015', '2014-12', '2024-12', 'bbg_chart', 'bbg_chart'),
              ('d2025', '2024-12', last['month'], 'bbg_chart', label['tier'])]
    doc = dict(schemaVersion=1, definition=spec['definition'], basis_shift_ln=shift, latest=latest,
               m0_1985=dict(central=m0, **spec['m0_1985']), anchors=anchors,
               segments=[dict(id=i, label=f'{s}～{e}', start=s, end=e, startTier=st, endTier=et, splice=st != et)
                         for i, s, e, st, et in bounds],
               sources=spec['sources'], tiers=spec['tiers'], licence_note=spec['licence_note'])
    gap = chain_gap_lp(rows, doc)
    assert abs(gap['price']) < 1e-9 and abs(gap['pe']) <= MAX_CHAIN_GAP_LP, gap
    return doc, gap, spec['retrieved']


def manifest(as_of, rows, estimated_rf, valuation_retrieved):
    files = sorted(p for base in (SOURCES, OUT) for p in base.rglob('*') if p.is_file()
                   and not any(part.startswith('.') or part == '__pycache__' for part in p.relative_to(ROOT).parts))
    return dict(retrieved=RETRIEVED, valuation_retrieved=valuation_retrieved, data_through=as_of,
                rf_observed_through=max(r['month'] for r in rows if r['RF'] is not None and r['month'] not in estimated_rf),
                estimated_rf_months=sorted(estimated_rf),
                files=[dict(path=p.relative_to(ROOT).as_posix(), bytes=p.stat().st_size,
                            sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in files])


def write_json(path, payload, **kwargs):
    path.write_text(json.dumps(payload, allow_nan=False, **kwargs) + '\n')


def main():
    other = read_csv(SOURCES / 'sp500_treasury_monthly.csv')
    rows = observations(read_csv(SOURCES / 'nasdaq_monthly.csv'), other)
    add_backfills(rows)
    quality_path = SOURCES / 'data_quality.json'
    notes = json.loads(quality_path.read_text())['notes'] if quality_path.exists() else []
    rf_status = {q['month']: q['status'] for q in notes if q['field'] == 'RF'}
    estimated_rf = {m for m, status in rf_status.items() if status == 'estimated'}
    range_fields = {n['field'] for n in RANGE_NOTES}
    as_of = month_end(rows[-1]['month'])

    with (OUT / 'monthly_history.csv').open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(csv_row(row, rf_status) for row in rows)
    history = dict(schemaVersion=2, as_of=as_of, retrieved=RETRIEVED, price_baseline='1985-01',
                   total_return_baseline='1999-03', coverage=coverage(rows, other, estimated_rf), sources=HISTORY_SOURCES,
                   quality_notes=[q for q in notes if q['field'] not in range_fields] + RANGE_NOTES, observations=rows)
    write_json(OUT / 'history.json', history, ensure_ascii=False, separators=(',', ':'))
    doc, gap, valuation_retrieved = valuation(rows)
    write_json(OUT / 'valuation.json', doc, ensure_ascii=False, indent=2)
    write_json(ROOT / 'data/manifest.json', manifest(as_of, rows, estimated_rf, valuation_retrieved), indent=2)

    print(f'Built {len(rows)} month-end observations; {rows[0]["month"]} to {rows[-1]["month"]}.')
    print(f'Backfills: ndx_div {sum(r["ndx_div_default"] is not None for r in rows)} months, '
          f'spx_tr_con {sum(r["spx_tr_con"] is not None for r in rows)} months.')
    print(f'valuation: latest M {doc["latest"]["M"]:.6f} (label {doc["latest"]["M_label"]}, verified={doc["latest"]["verified"]}); '
          f'm0 central {doc["m0_1985"]["central"]:.6f}; chain gap lp price {gap["price"]:+.2e} P/E {gap["pe"]:+.3f} EPS {gap["eps"]:+.3f}.')


if __name__ == '__main__':
    main()
