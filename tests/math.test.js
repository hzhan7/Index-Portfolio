import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {portfolioStats,adjustWeight,displayWeights} from '../docs/assets/math.js';
import {computeMain,computeSensitivity,periodRows} from '../docs/assets/worker.js';

const history=JSON.parse(readFileSync(new URL('../docs/data/history.json',import.meta.url))).observations;
const close=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const config={start:'1999-03',end:'2025-12',equityIncome:true,bondIncome:true,objective:'cagr_floor'};
test('Historical overlap matches the independently calculated total-return benchmark',()=>{
  const result=computeMain(history,config);
  assert.equal(result.rows.length,321);close(result.result.baseline.cagr,.08414559532810793);
  const optimal=result.result.solutions.maxSharpeAtLeastSpxCagr;
  close(optimal.cagr,result.result.baseline.cagr);close(optimal.sharpe,.54426735,1e-7);
  const direct=portfolioStats(result.rows,optimal.w);for(const metric of ['cagr','sharpe','vol','mdd'])close(direct[metric],optimal[metric]);
});
test('1985 includes 491 complete months and does not fabricate early dividend returns',()=>{
  const price=computeMain(history,{...config,start:'1985-01',equityIncome:false});
  assert.equal(price.rows.length,491);close(price.result.baseline.cagr,.0930503159,1e-9);
  assert.throws(()=>computeMain(history,{...config,start:'1985-01'}),/缺少/);
  assert.equal(history[0].XNDX,null);assert.equal(history[0].SPXTR,null);
});
test('Equal Sharpe is distinct from a Sharpe floor',()=>{
  const {result}=computeMain(history,{...config,start:'1985-01',equityIncome:false});
  const same=result.solutions.equalSpxSharpe,minimum=result.solutions.maxCagrAtLeastSpxSharpe;
  close(same.sharpe,result.baseline.sharpe);close(minimum.w[0],1);
  assert.ok(minimum.cagr>same.cagr+.04);
});
test('Income switches isolate distributions and endpoint returns exclude the baseline month',()=>{
  const a=periodRows(history,config),b=periodRows(history,{...config,bondIncome:false});
  const apr=history.find(r=>r.month==='1999-04');close(a[0][2]-b[0][2],apr.coupon);
  assert.equal(a[0][0],apr.ndx_tr);assert.equal(a[0][3],apr.RF);
  const p=periodRows(history,{...config,equityIncome:false});assert.equal(p[0][0],apr.ndx_pr);
});
test('Rolling periods have exact length and never extend beyond the selected endpoint',()=>{
  const periods=computeSensitivity(history,config,'rolling',10);
  assert.ok(periods.length>10);for(const p of periods){assert.equal(p.n,120);assert.ok(p.end<=config.end);}
  assert.equal(periods.at(-1).end,config.end);
});
test('Weights remain long-only, sum to one, and displayed percentages total 100',()=>{
  for(const w of [[1,0,0],[.40449388,.26915329,.32635283],[0,0,1]])for(let i=0;i<3;i++){
    const next=adjustWeight(w,i,.37);close(next.reduce((a,b)=>a+b),1);assert.ok(next.every(x=>x>=0));
    close(displayWeights(next).reduce((a,b)=>a+Number(b),0),100,1e-10);
  }
  assert.throws(()=>portfolioStats([[.1,.2,.3,.01],[.1,.2,.3,.01]],[1,1,0]));
});
