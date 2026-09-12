"""Independent SciPy numerical checks of mean-variance.js; run generate-mean-variance-cases.mjs first."""
import hashlib,json,math,sys,tempfile
from pathlib import Path
import numpy as np
from scipy.optimize import minimize

ROOT=Path(__file__).resolve().parents[2]
raw=(ROOT/'docs/data/history.json').read_bytes(); history=json.loads(raw)
cases_file=Path(sys.argv[1]) if len(sys.argv)>1 else Path(tempfile.gettempdir())/'index-portfolio-mean-variance-cases.json'
cases=json.loads(cases_file.read_text())
assert cases['inputSha256']==hashlib.sha256(raw).hexdigest(),'History changed after JS calculation; rerun generate-mean-variance-cases.mjs.'
starts=[np.array([i,j,5-i-j],dtype=float)/5 for i in range(6) for j in range(6-i)]
checks=[];frontier_checks=[];direct_errors=[];states=[]
for case in cases['cases']:
    fields=['ndx_tr','spx_tr','bond_tr','RF'] if case['stocksIncome'] else ['ndx_pr','spx_pr','bond_tr','RF']
    rows=np.array([[o[f] for f in fields] for o in history['observations'] if case['start']<o['month']<=case['end']])
    result=case['result']; model=result['model']; options=case['options']
    r,rf=rows[:,:3],rows[:,3]
    hist_mu=12*r.mean(axis=0);cov=12*np.cov(r,rowvar=False,ddof=1);excov=12*np.cov(r-rf[:,None],rowvar=False,ddof=1)
    mu=np.array(options.get('expectedReturns',hist_mu));anchor=options.get('anchorRate',12*rf.mean())
    gamma=options.get('gamma',5);cap=options.get('targetVol',.12)
    direct_errors.extend([float(np.max(np.abs(np.array(model['annualCovariance'])-cov))),float(np.max(np.abs(np.array(model['annualExcessCovariance'])-excov))),float(np.max(np.abs(np.array(model['expectedReturns'])-mu))),abs(model['anchorRate']-anchor)])
    def variance(w):return float(w@cov@w)
    def ratio(w):return float((w@mu-anchor)/math.sqrt(variance(w)))
    def grad_ratio(w):
        sd=math.sqrt(variance(w));return mu/sd-(w@mu-anchor)*(cov@w)/sd**3
    simplex={'type':'eq','fun':lambda w:float(w.sum()-1),'jac':lambda w:np.ones(3)}
    def scipy_solve(fun,grad,constraints,initials=starts):
        good=[]
        for x in initials:
            sol=minimize(fun,x,jac=grad,method='SLSQP',bounds=[(0,1)]*3,constraints=[simplex]+constraints,options={'ftol':1e-13,'maxiter':1500})
            if all(abs(c['fun'](sol.x))<2e-9 if c['type']=='eq' else c['fun'](sol.x)>=-2e-9 for c in [simplex]+constraints):good.append(sol)
        assert good,(case['id'],'no scipy solution')
        return min(good,key=lambda s:fun(s.x))
    def compare(name,point,ref,fun):
        w=np.array(point['weights']);assert w.min()>=-1e-12 and abs(w.sum()-1)<1e-12
        exp=float(w@mu);vol=math.sqrt(variance(w));slope=(exp-anchor)/vol
        ex=r@w-rf;hist_sharpe=math.sqrt(12)*ex.mean()/ex.std(ddof=1)
        direct_errors.extend([abs(exp-point['expectedReturn']),abs(vol-point['modelVol']),abs(slope-point['slope']),abs(hist_sharpe-point['historicalSharpe'])])
        errs={'weight':float(np.max(np.abs(w-ref.x))),'expectedReturn':abs(exp-float(ref.x@mu)),'modelVol':abs(vol-math.sqrt(variance(ref.x))),'objective':abs(fun(w)-fun(ref.x))}
        assert errs['objective']<2e-8 and errs['weight']<5e-5,(case['id'],name,errs,w,ref.x)
        checks.append({'case':case['id'],'objective':name,'errors':errs,'javascriptWeights':w.tolist(),'scipyWeights':ref.x.tolist()})
    ref_gmv=scipy_solve(variance,lambda w:2*cov@w,[])
    compare('gmv',result['gmv'],ref_gmv,variance)
    t=result['tangency']
    if mu.max()<=anchor:
        assert t is None and result['tangencyStatus']=='no-positive-premium'
        ref=scipy_solve(lambda w:-ratio(w),lambda w:-grad_ratio(w),[])
        compare('mathematicalRatio_without_positive_tangent',result['mathematicalMaximumRatio'],ref,lambda w:-ratio(w))
        states.append({'case':case['id'],'noPositiveTangencyReturnedNull':True,'messagePresent':bool(result['tangencyMessage'])})
    else:
        ref=scipy_solve(lambda w:-ratio(w),lambda w:-grad_ratio(w),[])
        compare('tangency',t,ref,lambda w:-ratio(w))
    utility=lambda w:float(w@mu-gamma*variance(w)/2)
    ref=scipy_solve(lambda w:-utility(w),lambda w:-mu+gamma*cov@w,[])
    compare('utility',result['utility'],ref,lambda w:-utility(w))
    if cap**2<variance(ref_gmv.x)-1e-10:
        assert result['riskBudget'] is None and result['riskBudgetStatus']=='below-global-minimum-volatility'
        states.append({'case':case['id'],'infeasibleRiskBudgetReturnedNull':True,'messagePresent':bool(result['riskBudgetMessage'])})
    else:
        constraint={'type':'ineq','fun':lambda w:cap**2-variance(w),'jac':lambda w:-2*cov@w}
        ref=scipy_solve(lambda w:-float(w@mu),lambda w:-mu,[constraint])
        assert result['riskBudget']['modelVol']<=cap+1e-9
        compare('riskBudget',result['riskBudget'],ref,lambda w:-float(w@mu))
    previous_var=-1;previous_mu=-1e20
    frontier_worst={'variance':0.,'weight':0.};frontier_count=0
    for p in result['frontier']:
        target=p['targetReturn'];w=np.array(p['weights'])
        assert abs(w.sum()-1)<1e-12 and w.min()>=-1e-12 and abs(w@mu-target)<2e-9
        assert variance(w)>=previous_var-1e-12 and w@mu>=previous_mu-1e-12
        previous_var=variance(w);previous_mu=float(w@mu)
        constraint={'type':'eq','fun':lambda w,target=target:float(w@mu-target),'jac':lambda w:mu}
        low=int(mu.argmin());high=int(mu.argmax());feasible=np.zeros(3)
        if mu[high]-mu[low]>1e-13:
            f=(target-mu[low])/(mu[high]-mu[low]);feasible[high]=f;feasible[low]=1-f
            ref=scipy_solve(variance,lambda w:2*cov@w,[constraint],[feasible,np.ones(3)/3,*np.eye(3)])
        else:ref=ref_gmv
        err=abs(variance(w)-variance(ref.x));werr=float(np.max(np.abs(w-ref.x)))
        assert err<2e-8 and werr<1e-4,(case['id'],'frontier',target,err,werr)
        frontier_worst['variance']=max(frontier_worst['variance'],err);frontier_worst['weight']=max(frontier_worst['weight'],werr);frontier_count+=1
    frontier_checks.append({'case':case['id'],'pointsChecked':frontier_count,'maximumErrors':frontier_worst,'monotoneUpperEfficientBranch':True})

summary={'status':'passed','inputFile':'docs/data/history.json','inputSha256':hashlib.sha256(raw).hexdigest(),
         'method':'Independent NumPy raw annual moments and SciPy SLSQP with analytic gradients. 21 starts per named objective; up to five independent starts per frontier target.',
         'caseCount':len(cases['cases']),'namedObjectiveChecks':len(checks),'frontierPointsChecked':sum(x['pointsChecked'] for x in frontier_checks),
         'maximumDirectMomentAndMetricError':max(direct_errors),
         'maximumNamedObjectiveErrors':{k:max(x['errors'][k] for x in checks) for k in checks[0]['errors']},
         'maximumFrontierErrors':{k:max(x['maximumErrors'][k] for x in frontier_checks) for k in ['variance','weight']},
         'totalJavaScriptCaseGenerationMs':cases['totalElapsedMs'],'edgeStates':states,'objectives':checks,'frontierChecks':frontier_checks,
         'interpretation':'The graph uses arithmetic expected return and raw total volatility. Its fixed-anchor slope is not the historical Sharpe using a varying RF time series. Custom expected returns are model assumptions, not forecasts derived from the optimizer.'}
assert max(direct_errors)<2e-12
(ROOT/'data/validation/mean_variance_crosscheck.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ['objectives','frontierChecks']},indent=2))
