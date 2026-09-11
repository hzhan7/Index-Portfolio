/** Dependency-free, long-only 3-asset annual arithmetic mean/variance model.
 * rows: [NDX monthly return, SPX monthly return, BOND monthly return, RF].
 * An active-set enumeration solves every nonempty simplex face. No covariance
 * regularization or guessed returns are silently added. All rates are decimals.
 */
const TOL = 1e-10;
const dot = (a,b) => a.reduce((s,x,i)=>s+x*b[i],0);
const quadratic = (w,cov) => w.reduce((s,x,i)=>s+x*dot(cov[i],w),0);
const subsets = Array.from({length:7},(_,i)=>[0,1,2].filter(j=>(i+1)&(1<<j)));

// Row-scaled Gaussian elimination with partial pivoting; null means singular.
function linearSolve(matrix, rhs) {
  const n=rhs.length, a=matrix.map((row,i)=>{
    const scale=Math.max(...row.map(Math.abs));
    return scale>0?[...row.map(x=>x/scale),rhs[i]/scale]:[...row,rhs[i]];
  });
  for(let k=0;k<n;k++) {
    let pivot=k;
    for(let i=k+1;i<n;i++)if(Math.abs(a[i][k])>Math.abs(a[pivot][k]))pivot=i;
    if(Math.abs(a[pivot][k])<1e-13)return null;
    [a[k],a[pivot]]=[a[pivot],a[k]];
    const p=a[k][k];for(let j=k;j<=n;j++)a[k][j]/=p;
    for(let i=0;i<n;i++)if(i!==k){const f=a[i][k];for(let j=k;j<=n;j++)a[i][j]-=f*a[k][j];}
  }
  const answer=a.map(row=>row[n]);
  return answer.every(Number.isFinite)?answer:null;
}
function embed(subset, local) {
  if(!local||local.some(x=>x < -TOL)||Math.abs(local.reduce((s,x)=>s+x,0)-1)>1e-8)return null;
  const w=[0,0,0];subset.forEach((j,i)=>{w[j]=Math.max(0,local[i]);});
  const sum=w.reduce((s,x)=>s+x,0);return w.map(x=>x/sum);
}

export function buildMeanVarianceModel(rows, options={}) {
  if(!Array.isArray(rows)||rows.length<2)throw Error('At least two aligned monthly observations are required.');
  const n=rows.length, means=[0,0,0],excessMeans=[0,0,0];let meanRf=0;
  for(let t=0;t<n;t++) {
    if(!Array.isArray(rows[t])||rows[t].length<4||!rows[t].slice(0,4).every(Number.isFinite))throw Error(`Invalid return at row ${t}.`);
    meanRf+=rows[t][3]/n;
    for(let j=0;j<3;j++){means[j]+=rows[t][j]/n;excessMeans[j]+=(rows[t][j]-rows[t][3])/n;}
  }
  const cov=Array.from({length:3},()=>[0,0,0]),exCov=Array.from({length:3},()=>[0,0,0]);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)for(let t=0;t<n;t++) {
    cov[i][j]+=12*(rows[t][i]-means[i])*(rows[t][j]-means[j])/(n-1);
    exCov[i][j]+=12*(rows[t][i]-rows[t][3]-excessMeans[i])*(rows[t][j]-rows[t][3]-excessMeans[j])/(n-1);
  }
  const mu=options.expectedReturns==null?means.map(x=>12*x):options.expectedReturns.slice();
  if(mu.length!==3||!mu.every(Number.isFinite))throw Error('expectedReturns must be three annual arithmetic returns.');
  const anchor=options.anchorRate??12*meanRf;
  if(!Number.isFinite(anchor))throw Error('anchorRate must be a finite annual rate.');
  return {
    assetOrder:['NDX','SPX','BOND'],nMonths:n,expectedReturns:mu,annualCovariance:cov,anchorRate:anchor,
    historicalAnnualArithmeticReturns:means.map(x=>12*x),historicalAnnualRfProxy:12*meanRf,
    historicalAnnualExcessReturns:excessMeans.map(x=>12*x),annualExcessCovariance:exCov,
    expectedReturnsSource:options.expectedReturns==null?'historical arithmetic means':'custom annual arithmetic assumptions',
    anchorSource:options.anchorRate==null?'12 × mean monthly RF proxy':'custom fixed annual intercept',
    conventions:{mean:'12 × mean(raw monthly return)',covariance:'12 × sample covariance(raw monthly returns), ddof=1',
      historicalSharpe:'sqrt(12) × mean(rp − RF) / sample_std(rp − RF), ddof=1',
      classicSlope:'(annual expected arithmetic return − fixed anchorRate) / annual raw-return volatility',
      constraints:'weights >= 0; sum(weights)=1; monthly rebalancing'},
  };
}

/** O(assets²) metrics, suitable for a page's portfolio grid. */
export function computeModelMetrics(weights, model) {
  if(!Array.isArray(weights)||weights.length!==3||!weights.every(Number.isFinite)||weights.some(x=>x < -TOL))throw Error('Invalid long-only weights.');
  const sum=weights.reduce((s,x)=>s+x,0);
  if(Math.abs(sum-1)>1e-8)throw Error('Weights must sum to one.');
  const w=weights.map(x=>Math.max(0,x));const total=w.reduce((s,x)=>s+x,0);for(let i=0;i<3;i++)w[i]/=total;
  const variance=Math.max(0,quadratic(w,model.annualCovariance)),vol=Math.sqrt(variance),ret=dot(w,model.expectedReturns);
  const exVar=Math.max(0,quadratic(w,model.annualExcessCovariance)),histEx=dot(w,model.historicalAnnualExcessReturns);
  return {weights:w,expectedReturn:ret,modelVariance:variance,modelVol:vol,
    slope:vol>1e-12?(ret-model.anchorRate)/vol:null,
    historicalAnnualArithmeticReturn:dot(w,model.historicalAnnualArithmeticReturns),
    historicalSharpe:exVar>1e-24?histEx/Math.sqrt(exVar):null,
    historicalExcessVol:Math.sqrt(exVar)};
}

export function optimizeMeanVariance(rows,options={}) {
  return solveMeanVarianceModel(buildMeanVarianceModel(rows,options),options);
}

export function solveMeanVarianceModel(model,options={}) {
  const mu=model.expectedReturns,cov=model.annualCovariance,anchor=model.anchorRate;
  const gamma=options.gamma??5,targetVol=options.targetVol??0.12;
  const frontierPoints=Math.max(2,Math.round(options.frontierPoints??101));
  if(!Number.isFinite(gamma)||gamma<0)throw Error('gamma must be finite and nonnegative.');
  if(!Number.isFinite(targetVol)||targetVol<0)throw Error('targetVol must be finite and nonnegative.');
  function faceGmv(subset) {
    const m=subset.length;
    if(m===1){const w=[0,0,0];w[subset[0]]=1;return w;}
    const kkt=subset.map(i=>[...subset.map(j=>cov[i][j]),1]);kkt.push([...Array(m).fill(1),0]);
    const solved=linearSolve(kkt,[...Array(m).fill(0),1]);return embed(subset,solved?.slice(0,m));
  }
  function minVariance(target=null,allowed=[0,1,2]) {
    let best=null;
    for(const subset of subsets.filter(s=>s.every(i=>allowed.includes(i)))) {
      const m=subset.length,faceMeans=subset.map(i=>mu[i]);let w=null;
      if(target==null)w=faceGmv(subset);
      else if(target<Math.min(...faceMeans)-1e-11||target>Math.max(...faceMeans)+1e-11)continue;
      else if(Math.max(...faceMeans)-Math.min(...faceMeans)<1e-13) {
        if(Math.abs(target-faceMeans[0])<1e-10)w=faceGmv(subset);
      } else {
        // Equality constraints: sum(w)=1 and mu·w=target.
        const kkt=subset.map(i=>[...subset.map(j=>cov[i][j]),1,mu[i]]);
        kkt.push([...Array(m).fill(1),0,0]);kkt.push([...faceMeans,0,0]);
        const solved=linearSolve(kkt,[...Array(m).fill(0),1,target]);w=embed(subset,solved?.slice(0,m));
      }
      if(!w||(target!=null&&Math.abs(dot(w,mu)-target)>2e-9))continue;
      const point=computeModelMetrics(w,model);
      if(!best||point.modelVariance<best.modelVariance-1e-15||(Math.abs(point.modelVariance-best.modelVariance)<=1e-15&&point.expectedReturn>best.expectedReturn))best=point;
    }
    return best;
  }
  const gmv=minVariance();if(!gmv)throw Error('No valid minimum-variance solution; inspect covariance data.');
  const maximumMean=Math.max(...mu),maxMeanAssets=[0,1,2].filter(i=>Math.abs(mu[i]-maximumMean)<1e-12);
  const maximumReturn=minVariance(null,maxMeanAssets);
  const frontier=[];
  if(maximumMean-gmv.expectedReturn<1e-12)frontier.push({...gmv,targetReturn:gmv.expectedReturn});
  else for(let i=0;i<frontierPoints;i++) {
    const target=gmv.expectedReturn+(maximumMean-gmv.expectedReturn)*i/(frontierPoints-1);
    const point=i===0?gmv:i===frontierPoints-1?maximumReturn:minVariance(target);
    if(!point)throw Error(`Unable to solve frontier at target return ${target}.`);
    frontier.push({...point,targetReturn:target});
  }
  const vertexPoints=[0,1,2].map(i=>computeModelMetrics([0,1,2].map(j=>i===j?1:0),model));
  const finiteVertices=vertexPoints.filter(p=>p.slope!=null);
  const bestVertex=finiteVertices.reduce((best,p)=>!best||p.slope>best.slope?p:best,null);
  let tangency;
  if(maximumMean<=anchor+1e-14) {
    tangency={exists:false,status:'no-positive-premium',reason:'All expected asset returns are at or below the anchor. No positive-premium upper capital-allocation tangency is drawn.',mathematicalMaximumRatio:bestVertex};
  } else {
    const candidates=vertexPoints.filter(p=>p.expectedReturn>anchor&&p.slope!=null);
    let zeroVariancePositive=gmv.modelVol<=1e-12&&gmv.expectedReturn>anchor?gmv:null;
    for(const subset of subsets) {
      const solution=linearSolve(subset.map(i=>subset.map(j=>cov[i][j])),subset.map(i=>mu[i]-anchor));
      if(!solution)continue;
      const total=solution.reduce((s,x)=>s+x,0);if(total<=0)continue;
      const w=embed(subset,solution.map(x=>x/total));if(!w)continue;
      const p=computeModelMetrics(w,model);
      if(p.modelVol<=1e-12&&p.expectedReturn>anchor)zeroVariancePositive=p;
      if(p.expectedReturn>anchor&&p.slope!=null)candidates.push(p);
    }
    if(zeroVariancePositive)tangency={exists:false,status:'unbounded-zero-variance-premium',reason:'A zero model-variance portfolio has positive premium; the finite tangency ratio is undefined.',zeroVariancePortfolio:zeroVariancePositive};
    else {
      const best=candidates.reduce((a,p)=>!a||p.slope>a.slope?p:a,null);
      tangency=best?{exists:true,status:'positive-premium',...best}:{exists:false,status:'singular-no-finite-candidate',reason:'No finite positive tangency candidate; inspect singular covariance data.'};
    }
  }
  let utility=null;
  if(gamma===0)utility={...maximumReturn,gamma,utility:maximumReturn.expectedReturn};
  else for(const subset of subsets) {
    const m=subset.length,kkt=subset.map(i=>[...subset.map(j=>gamma*cov[i][j]),1]);kkt.push([...Array(m).fill(1),0]);
    const solution=linearSolve(kkt,[...subset.map(i=>mu[i]),1]),w=embed(subset,solution?.slice(0,m));
    if(!w)continue;const p=computeModelMetrics(w,model),u=p.expectedReturn-gamma*p.modelVariance/2;
    if(!utility||u>utility.utility+1e-14||(Math.abs(u-utility.utility)<=1e-14&&p.modelVariance<utility.modelVariance))utility={...p,gamma,utility:u};
  }
  const targetVariance=targetVol*targetVol;let riskBudget;
  if(targetVariance<gmv.modelVariance-1e-12)riskBudget={feasible:false,targetVol,status:'below-global-minimum-volatility',minimumFeasibleVol:gmv.modelVol,reason:'The volatility cap is below the long-only global minimum variance portfolio.'};
  else if(maximumReturn.modelVariance<=targetVariance+1e-12)riskBudget={feasible:true,targetVol,binding:false,...maximumReturn};
  else {
    let lo=gmv.expectedReturn,hi=maximumMean,best=gmv;
    for(let i=0;i<64;i++) {
      const mid=(lo+hi)/2,p=minVariance(mid);
      if(p&&p.modelVariance<=targetVariance){lo=mid;best=p;}else hi=mid;
    }
    riskBudget={feasible:true,targetVol,binding:true,...best};
  }
  return {model,gmv,maximumReturn,frontier,
    tangency:tangency.exists?tangency:null,tangencyStatus:tangency.status,tangencyMessage:tangency.reason??null,
    mathematicalMaximumRatio:tangency.mathematicalMaximumRatio??(tangency.exists?tangency:null),
    zeroVarianceTangencyPortfolio:tangency.zeroVariancePortfolio??null,
    utility,riskBudget:riskBudget.feasible?riskBudget:null,
    riskBudgetStatus:riskBudget.feasible?'feasible':riskBudget.status,riskBudgetMessage:riskBudget.reason??null,
    settings:{gamma,targetVol,frontierPoints},
    method:'Enumeration of all seven nonempty long-only simplex active sets. KKT linear systems for minimum variance and utility; analytical tangency candidates; monotone return bisection for the volatility cap.',
    notes:['Model expected returns are annual arithmetic means or custom arithmetic assumptions, never CAGR.',
      'The annual RF proxy is 12 × mean monthly RF; it is treated as a fixed capital-allocation intercept.',
      'Classic slope uses raw-return covariance. Historical Sharpe uses covariance of monthly returns after subtracting the varying RF series.',
      'A line from an arbitrary target-return intercept is a geometric allocation line, not a CAPM equilibrium claim.',
      'The optimization portfolio remains long only and fully invested in the three assets. The displayed line does not authorize borrowing or add a fourth allocated asset.']};
}
