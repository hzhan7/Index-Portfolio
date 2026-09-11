import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeMain,computeSensitivity,modelForPeriod,periodRows} from '../docs/assets/worker.js';
import {computeModelMetrics} from '../docs/assets/mean-variance.js';
import {portfolioStats} from '../docs/assets/math.js';

const history=JSON.parse(readFileSync(new URL('../docs/data/history.json',import.meta.url))).observations;
const base={start:'1999-03',end:'2025-12',equityIncome:true,bondIncome:true,objective:'tangency'};
const rows=periodRows(history,base),mv=modelForPeriod(rows,base);
const close=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);

test('Classic tangency matches independent validation and differs from historical excess-return Sharpe',()=>{
  const p=mv.tangency;
  const expected=[.1302924556,.2793825856,.5903249587];p.weights.forEach((w,i)=>close(w,expected[i],1e-7));
  close(p.slope,.60724773,1e-7);close(p.modelVol,.0756402065,1e-9);
  assert.ok(Math.abs(p.slope-portfolioStats(rows,p.weights).sharpe)>.001);
  for(const point of mv.frontier)assert.ok(point.expectedReturn<=mv.model.anchorRate+p.slope*point.modelVol+1e-10);
});
test('Risk-budget default uses same-sample SPX volatility, with no hidden allocation cap',()=>{
  close(mv.settings.targetVol,portfolioStats(rows,[0,1,0]).vol);
  close(mv.riskBudget.modelVol,mv.settings.targetVol);
  const expected=[.50589830,.26662564,.22747606];mv.riskBudget.weights.forEach((w,i)=>close(w,expected[i],2e-7));
});
test('High hurdle and infeasible volatility cap have no fake optimum',()=>{
  const impossible=modelForPeriod(rows,{...base,anchorSource:'custom',anchorRate:1,budgetSource:'custom',targetVol:.0001});
  assert.equal(impossible.tangency,null);assert.equal(impossible.riskBudget,null);
  assert.equal(impossible.tangencyStatus,'no-positive-premium');
  assert.equal(impossible.riskBudgetStatus,'below-global-minimum-volatility');
  const result=computeMain(history,{...base,anchorSource:'custom',anchorRate:1});
  assert.equal(result.result.solutions.tangency,null);
});
test('Custom expected returns alter model selection without rewriting historical returns',()=>{
  const custom=modelForPeriod(rows,{...base,expectedSource:'custom',expectedReturns:[.07,.08,.05],anchorSource:'custom',anchorRate:.03});
  assert.deepEqual(custom.model.expectedReturns,[.07,.08,.05]);
  assert.deepEqual(custom.model.annualCovariance,mv.model.annualCovariance);
  assert.ok(Math.abs(custom.tangency.weights[0]-mv.tangency.weights[0])>.01);
  const main=computeMain(history,{...base,expectedSource:'custom',expectedReturns:[.07,.08,.05],anchorSource:'custom',anchorRate:.03});
  const p=main.result.solutions.tangency,historical=portfolioStats(rows,p.w);close(p.cagr,historical.cagr);close(p.sharpe,historical.sharpe);
  assert.ok(Math.abs(p.expectedReturn-p.cagr)>.0001);
});
test('Increasing risk aversion reduces optimal variance; utility is not an arbitrary hurdle ratio',()=>{
  const low=modelForPeriod(rows,{...base,gamma:1}),high=modelForPeriod(rows,{...base,gamma:20});
  assert.ok(high.utility.modelVariance<low.utility.modelVariance);
  close(high.utility.utility,high.utility.expectedReturn-10*high.utility.modelVariance);
  const newAnchor=modelForPeriod(rows,{...base,gamma:20,anchorSource:'custom',anchorRate:.15});
  high.utility.weights.forEach((w,i)=>close(w,newAnchor.utility.weights[i]));
});
test('Frontier has nondecreasing return and volatility, and model variance agrees with historical total volatility',()=>{
  let ret=-Infinity,vol=-Infinity;
  for(const p of mv.frontier){assert.ok(p.expectedReturn>=ret-1e-10);assert.ok(p.modelVol>=vol-1e-10);ret=p.expectedReturn;vol=p.modelVol;close(p.weights.reduce((a,b)=>a+b),1);assert.ok(p.weights.every(w=>w>=0));}
  const point=computeModelMetrics([.4,.3,.3],mv.model);close(point.modelVol,portfolioStats(rows,[.4,.3,.3]).vol);
});
test('Rolling windows support the new objectives and keep the same risk-budget policy',()=>{
  const periods=computeSensitivity(history,{...base,objective:'risk_budget'},'rolling',10);
  for(const p of periods){assert.equal(p.n,120);assert.ok(p.optimal);close(p.optimal.targetVol,p.baseline.vol,1e-7);assert.ok(p.optimal.modelVol<=p.baseline.vol+1e-8);if(p.optimal.binding)close(p.optimal.modelVol,p.baseline.vol,1e-7);}
});
