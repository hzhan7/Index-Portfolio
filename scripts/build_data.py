"""Build website history from preserved monthly source observations (stdlib only)."""
import csv
import json
import math
import calendar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(name):
    with (ROOT / 'data/sources' / name).open() as f:
        return {r['month']: r for r in csv.DictReader(f)}

def value(row, key):
    return float(row[key]) if row.get(key) else None

ndx = read('nasdaq_monthly.csv')
other = read('sp500_treasury_monthly.csv')
output = []
previous = None
for month in sorted(ndx.keys() & other.keys()):
    a, b = ndx[month], other[month]
    row = dict(month=month, NDX=value(a,'NDX'), SPX=value(b,'spx_price'),
               XNDX=value(a,'XNDX'), SPXTR=value(b,'spx_total_return_index'),
               RF=value(b,'RF'), dgs10_pct=value(b,'dgs10_yield_pct'))
    for level, ret in [('NDX','ndx_pr'),('SPX','spx_pr'),('XNDX','ndx_tr'),('SPXTR','spx_tr')]:
        row[ret] = row[level] / previous[level] - 1 if previous and row[level] and previous[level] else None
    y0, y1 = value(b,'prior_dgs10_yield_pct')/100, row['dgs10_pct']/100
    discount = (1+y1/2)**(-2*(10-1/12))
    row['coupon'] = y0/12
    row['bond_pr'] = y0/y1*(1-discount)+discount-1
    row['bond_tr'] = row['bond_pr']+row['coupon']
    assert abs(row['bond_tr'] - value(b,'bond_total')) < 1e-12
    assert all(v is None or not isinstance(v,float) or math.isfinite(v) for v in row.values())
    output.append(row)
    previous = row

quality_path=ROOT/'data/sources/data_quality.json'
quality=json.loads(quality_path.read_text())['notes'] if quality_path.exists() else []
rf_quality={q['month']:q['status'] for q in quality if q['field']=='RF'}
columns = ['month','NDX','SPX','XNDX','SPXTR','ndx_pr','spx_pr','ndx_tr','spx_tr','bond_tr','bond_pr','coupon','RF','dgs10_pct','RF_status']
with (ROOT/'docs/data/monthly_history.csv').open('w', newline='') as f:
    writer=csv.DictWriter(f,fieldnames=columns);writer.writeheader()
    writer.writerows({**row,'RF_status':rf_quality.get(row['month'],'observed')} for row in output)
last_year,last_month=map(int,output[-1]['month'].split('-'))
as_of=f'{last_year:04d}-{last_month:02d}-{calendar.monthrange(last_year,last_month)[1]:02d}'
payload=dict(as_of=as_of, retrieved='2026-09-11', observations=output,
             price_baseline='1985-01',total_return_baseline='1999-03',quality_notes=quality)
(ROOT/'docs/data/history.json').write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')
print(f'Built {len(output)} month-end observations; {output[0]["month"]} to {output[-1]["month"]}.')
