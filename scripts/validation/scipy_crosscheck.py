"""Independent SciPy checks of data/validation/reference_results.json; run generate-reference-results.mjs first."""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

ROOT=Path(__file__).resolve().parents[2]
raw=(ROOT/'docs/data/history.json').read_bytes()
history=json.loads(raw)
js=json.loads((ROOT/'data/validation/reference_results.json').read_text())
assert js['inputSha256']==hashlib.sha256(raw).hexdigest(),'History changed after JS calculation; rerun generate-reference-results.mjs.'
starts=[np.array([i,j,10-i-j],dtype=float)/10 for i in range(11) for j in range(11-i)]
checks=[]
for case in js['cases']:
    start,end=case['parameters']['start'],case['parameters']['end']
    selected=[o for o in history['observations'] if start<o['month']<=end]
    columns=case['returnFields']
    data=np.array([[o[k] for k in columns] for o in selected],dtype=float)
    assert np.isfinite(data).all()
    r,rf=data[:,:3],data[:,3]
    assert len(data)==case['period']['nMonths']
    ex=r-rf[:,None]
    mu=ex.mean(axis=0)
    covariance=np.cov(ex,rowvar=False,ddof=1)
    def sharpe(w): return math.sqrt(12)*(w@mu)/math.sqrt(w@covariance@w)
    def grad_sharpe(w):
        sd=math.sqrt(w@covariance@w)
        return math.sqrt(12)*(mu/sd-(mu@w)*(covariance@w)/sd**3)
    def growth(w): return float(np.log1p(r@w).mean())
    def grad_growth(w): return np.mean(r/(1+r@w)[:,None],axis=0)
    def metrics(w):
        rp=r@w
        wealth=np.r_[1.0,np.cumprod(1+rp)]
        return {'cagr':float(np.expm1(12*np.log1p(rp).mean())),
                'sharpe':float(math.sqrt(12)*np.mean(rp-rf)/np.std(rp-rf,ddof=1)),
                'vol':float(math.sqrt(12)*np.std(rp,ddof=1)),
                'excessVol':float(math.sqrt(12)*np.std(rp-rf,ddof=1)),
                'mdd':float(np.min(wealth/np.maximum.accumulate(wealth)-1))}
    sp=np.array([0.,1.,0.])
    sg,ss=growth(sp),sharpe(sp)
    baseline=metrics(sp)
    assert max(abs(baseline[k]-case['baseline'][k]) for k in baseline)<1e-12
    for name,result in case['solutions'].items():
        assert result is not None,(case['id'],name)
        w=np.array(result['w'])
        assert min(w)>=-1e-12 and abs(w.sum()-1)<1e-12
        direct=metrics(w)
        metric_errors={k:abs(direct[k]-result[k]) for k in direct}
        assert max(metric_errors.values())<1e-12,(case['id'],name,metric_errors)
        use_sharpe=name in ['maxSharpe','maxSharpeAtLeastSpxCagr','equalSpxCagr']
        objective,gradient=(sharpe,grad_sharpe) if use_sharpe else (growth,grad_growth)
        constraints=[{'type':'eq','fun':lambda w:float(w.sum()-1),'jac':lambda w:np.ones(3)}]
        if name in ['maxSharpeAtLeastSpxCagr','equalSpxCagr']:
            equality=name=='equalSpxCagr'
            constraints.append({'type':'eq' if equality else 'ineq','fun':lambda w:growth(w)-sg,'jac':grad_growth})
            gap=direct['cagr']-baseline['cagr']
            assert abs(gap)<1e-8 if equality else gap>=-1e-8
        elif name in ['maxCagrAtLeastSpxSharpe','equalSpxSharpe']:
            equality=name=='equalSpxSharpe'
            constraints.append({'type':'eq' if equality else 'ineq','fun':lambda w:sharpe(w)-ss,'jac':grad_sharpe})
            gap=direct['sharpe']-baseline['sharpe']
            assert abs(gap)<1e-8 if equality else gap>=-1e-8
        else: gap=None
        sols=[]
        for w0 in starts:
            sol=minimize(lambda w:-objective(w),w0,jac=lambda w:-gradient(w),method='SLSQP',bounds=[(0,1)]*3,
                         constraints=constraints,options={'ftol':1e-13,'maxiter':1600})
            if all(abs(c['fun'](sol.x))<1e-9 if c['type']=='eq' else c['fun'](sol.x)>=-1e-9 for c in constraints):
                sols.append(sol)
        assert sols,(case['id'],name,'No feasible scipy solution')
        best=max(sols,key=lambda s:objective(s.x))
        ref=metrics(best.x)
        errors={'weight':float(np.max(np.abs(w-best.x))),
                'cagr':abs(ref['cagr']-result['cagr']),'sharpe':abs(ref['sharpe']-result['sharpe'])}
        assert errors['cagr']<2e-7 and errors['sharpe']<2e-7 and errors['weight']<5e-5,(case['id'],name,errors,best.x,w)
        checks.append({'case':case['id'],'objective':name,'nMonths':len(data),
                       'weightSum':float(w.sum()),'minimumWeight':float(w.min()),'constraintGap':gap,
                       'directMetricErrors':metric_errors,'scipy':{'w':best.x.tolist(),**ref},
                       'javascript':{'w':result['w'],**direct},'scipyAbsoluteErrors':errors,'feasibleScipyStarts':len(sols)})

summary={'schemaVersion':1,'status':'passed','inputFile':'docs/data/history.json',
         'inputSha256':hashlib.sha256(raw).hexdigest(),'caseCount':len(js['cases']),'objectiveChecks':len(checks),
         'method':'Independent SciPy SLSQP; 66 simplex starting points per objective; analytic gradients. Direct NumPy ddof=1 Sharpe/volatility and month-end MDD checks.',
         'dateConvention':'Start/end are month-end wealth endpoints. Monthly return observations satisfy start < month <= end.',
         'maxAbsoluteError':{k:max(x['scipyAbsoluteErrors'][k] for x in checks) for k in ['weight','cagr','sharpe']},
         'maxDirectMetricError':max(v for x in checks for v in x['directMetricErrors'].values()),
         'allConstraintsPassed':True,'allWeightsLongOnlyAndSumOne':True,'allDdoFOneChecksPassed':True,
         'limitations':['Numerical agreement is not a strict global-optimality certificate.','All optima are retrospective within the selected sample.','Drawdown uses month ends, not daily observations.'],
         'checks':checks}
(ROOT/'data/validation/scipy_crosscheck.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='checks'},indent=2))
