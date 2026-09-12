"""Reproduce the Nasdaq-100 dividend backfill for 1985-02..1999-03 (stdlib only).

Inputs: Nasdaq calendar-year-end dividend yields from QQQ SEC filings
(data/sources/backfill_1985/ndx_yearend_dividend_yield_sec.csv) and NDX month-end levels
(data/sources/nasdaq_monthly.csv). For month m in calendar year Y:

    d_m = (y_Y / 100 * NDX_Dec(Y) / 12) / NDX_(m-1)

Year Y's cash dividends in index points (yield x year-end level) are spread evenly over its months and divided
by the prior month-end level. 1985 is unpublished and assumed equal to 1986. The low/high bands scale every
yield by 0.75 / 1.25.

    python3 scripts/backfill/ndx_dividends.py          verify the committed CSV byte-for-byte
    python3 scripts/backfill/ndx_dividends.py --write  regenerate it
"""
import argparse
import csv
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKFILL = ROOT / 'data/sources/backfill_1985'
TABLE = BACKFILL / 'ndx_yearend_dividend_yield_sec.csv'
OUTPUT = BACKFILL / 'ndx_dividend_backfill_1985_1999.csv'
LEVELS = ROOT / 'data/sources/nasdaq_monthly.csv'
FIRST, LAST = '1985-02', '1999-03'
BANDS = {'default': 1.0, 'low': 0.75, 'high': 1.25}
DECIMALS = 10  # the research CSV rounds every return to 1e-10


def load():
    with TABLE.open(newline='') as f:
        yields = {int(r['year']): float(r['dividend_yield_pct']) if r['dividend_yield_pct'] else None
                  for r in csv.DictReader(f)}
    with LEVELS.open(newline='') as f:
        levels = {r['month']: float(r['NDX']) for r in csv.DictReader(f)}
    return yields, levels


def backfill(yields, levels):
    """Full-precision rows. Operation order mirrors the research model, so the rounded CSV reproduces exactly."""
    assumed = yields[1986]
    months = sorted(levels)
    rows = []
    for prev, month in zip(months, months[1:]):
        if not FIRST <= month <= LAST:
            continue
        year = int(month[:4])
        published = yields[year]
        base = assumed if published is None else published
        div = {band: (base * mult) / 100 * levels[f'{year}-12'] / 12 / levels[prev] for band, mult in BANDS.items()}
        rows.append(dict(month=month, NDX=levels[month], ndx_pr=levels[month] / levels[prev] - 1, div=div,
                         flat=base / 1200, label=published if published is not None else f'N/A (assumed {assumed})'))
    return rows


def render(rows):
    fmt = lambda x: f'{x:.{DECIMALS}f}'
    buf = io.StringIO()
    writer = csv.writer(buf)  # default CRLF line endings, as in the research output
    writer.writerow(['month', 'NDX', 'ndx_pr', *(f'div_{b}' for b in BANDS), 'div_flat_alt',
                     *(f'ndx_tr_{b}' for b in BANDS), 'nasdaq_yearend_yield_pct'])
    for r in rows:
        writer.writerow([r['month'], r['NDX'], fmt(r['ndx_pr']), *map(fmt, r['div'].values()), fmt(r['flat']),
                         *(fmt(r['ndx_pr'] + d) for d in r['div'].values()), r['label']])
    return buf.getvalue()


def verify():
    """Assert the committed CSV equals the regenerated one; return (rows, max rounding error of the CSV values)."""
    rows = backfill(*load())
    if OUTPUT.read_bytes().decode() != render(rows):
        raise AssertionError(f'{OUTPUT.relative_to(ROOT)} does not reproduce from its inputs')
    assert (rows[0]['month'], rows[-1]['month'], len(rows)) == (FIRST, LAST, 170)
    with OUTPUT.open(newline='') as f:
        published = {r['month']: r for r in csv.DictReader(f)}
    rounding = max(abs(float(published[r['month']][f'div_{b}']) - d) for r in rows for b, d in r['div'].items())
    assert rounding <= 0.5 * 10 ** -DECIMALS + 1e-16
    return rows, rounding


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Reproduce the NDX 1985-1999 dividend backfill.')
    parser.add_argument('--write', action='store_true', help='regenerate the CSV instead of only verifying it')
    if parser.parse_args().write:
        OUTPUT.write_bytes(render(backfill(*load())).encode())
    rows, rounding = verify()
    print(f'{OUTPUT.relative_to(ROOT)}: {len(rows)} rows reproduce byte-for-byte; '
          f'max |CSV - full precision| = {rounding:.1e} (10-decimal rounding)')
