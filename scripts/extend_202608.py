"""Append verified Jan-Aug 2026 observations; an estimated August RF requires an explicit flag."""
import argparse
import csv
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'data/sources'
EXT=SOURCE/'extension_202608'
parser=argparse.ArgumentParser()
parser.add_argument('--use-estimated-rf',action='store_true')
args=parser.parse_args()

def read(path):
    with path.open(newline='') as f:
        reader=csv.DictReader(f)
        return reader.fieldnames,{row['month']:row for row in reader}

ndx_fields,ndx=read(SOURCE/'nasdaq_monthly.csv')
other_fields,other=read(SOURCE/'sp500_treasury_monthly.csv')
_,n_new=read(EXT/'nasdaq_append.csv')
_,s_new=read(EXT/'sp500_monthly.csv')
_,b_new=read(EXT/'rf_bond_append.csv')
months=[f'2026-{i:02}' for i in range(1,9)]
assert set(n_new)==set(months)
quality=[]
rows=[]
for month in months:
    n,s,b=n_new[month],s_new[month],b_new[month]
    assert n['ndx_close_date'].startswith(month) and n['xndx_close_date'].startswith(month)
    assert s['spx_price_observation_date'].startswith(month)
    assert s['spx_total_return_observation_date'].startswith(month)
    rf=b['RF']
    if not rf:
        if not args.use_estimated_rf:raise ValueError(f'{month}: observed RF missing; explicit estimate selection is required')
        estimate=json.loads((EXT/'estimated_rf_aug2026.json').read_text())
        assert estimate['month']==month
        rf=str(estimate['estimated_RF'])
        quality.append(dict(month=month,field='RF',status='estimated',observed_value=None,effective_value=float(rf),
                            note='French官方尚未发布；按前月末四周国库券折价报价及实际31天期限暂估，并非实际GBOM指数回报。',
                            source='data/sources/extension_202608/estimated_rf_aug2026.json'))
    row={field:(s.get(field) or b.get(field) or '') for field in other_fields}
    row['RF']=rf
    previous=other['2025-12'] if month=='2026-01' else rows[-1]
    for price,ret in [('spx_price','spx_price_return'),('spx_total_return_index','spx_total_return')]:
        row[ret]=str(float(row[price])/float(previous[price])-1)
    assert all(row[k] for k in other_fields)
    rows.append(row)

def append(path,fields,existing,records):
    new=[row for row in records if row['month'] not in existing]
    for row in records:
        if row['month'] in existing:
            for key in fields:
                a,b=existing[row['month']][key],str(row[key])
                if a!=b:
                    try:assert abs(float(a)-float(b))<1e-12
                    except ValueError:assert a==b
    with path.open('a',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');writer.writerows(new)

append(SOURCE/'nasdaq_monthly.csv',ndx_fields,ndx,[n_new[m] for m in months])
append(SOURCE/'sp500_treasury_monthly.csv',other_fields,other,rows)
(SOURCE/'data_quality.json').write_text(json.dumps(dict(notes=quality),ensure_ascii=False,indent=2)+'\n')
print('Appended eight months; provisional RF values:',quality)
