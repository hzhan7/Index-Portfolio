export function portfolioStats(rows, weights) {
  if (weights.length !== 3 || weights.some(x => !Number.isFinite(x) || x < -1e-12) || Math.abs(weights.reduce((a,b)=>a+b,0)-1)>1e-8) throw new Error('权重必须非负且合计为100%');
  const n=rows.length;
  let logGrowth=0,sumR=0,sumE=0,sumR2=0,sumE2=0,wealth=1,peak=1,mdd=0;
  for (const row of rows) {
    const r=weights[0]*row[0]+weights[1]*row[1]+weights[2]*row[2],e=r-row[3];
    logGrowth+=Math.log1p(r);sumR+=r;sumE+=e;sumR2+=r*r;sumE2+=e*e;
    wealth*=1+r;peak=Math.max(peak,wealth);mdd=Math.min(mdd,wealth/peak-1);
  }
  const varianceR=Math.max(0,(sumR2-sumR*sumR/n)/(n-1));
  const varianceE=Math.max(0,(sumE2-sumE*sumE/n)/(n-1));
  return {cagr:Math.expm1(logGrowth*12/n),sharpe:Math.sqrt(12)*(sumE/n)/Math.sqrt(varianceE),vol:Math.sqrt(varianceR*12),mdd};
}
export function adjustWeight(weights,index,value){
  const next=Math.max(0,Math.min(1,value)),others=1-weights[index];
  return weights.map((w,i)=>i===index?next:(others>1e-10?w/others:0.5)*(1-next));
}
export function displayWeights(weights){
  const values=weights.map(w=>Math.floor(w*10000));
  const indices=[0,1,2].sort((a,b)=>(weights[b]*10000-values[b])-(weights[a]*10000-values[a]));
  let left=10000-values.reduce((a,b)=>a+b,0);
  for(let i=0;i<left;i++)values[indices[i%3]]++;
  return values.map(x=>(x/100).toFixed(2));
}
