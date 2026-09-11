import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {computeMain,periodRows} from '../docs/assets/worker.js';

const data=JSON.parse(readFileSync(new URL('../docs/data/history.json',import.meta.url))),history=data.observations;
const close=(a,b,t=1e-12)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
test('Eight complete months extend the same historical observations to August 2026',()=>{
  assert.equal(data.as_of,'2026-08-31');assert.equal(history.length,500);
  assert.deepEqual(history.slice(-8).map(r=>r.month),Array.from({length:8},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`));
  const old=createHash('sha256').update(JSON.stringify(history.slice(0,492))).digest('hex');
  assert.equal(old,'0620174c31cdd2d24ff18312f4033e73ac97a5e7b465c0895f32a844352d05cd');
  for(const row of history.slice(-8))for(const field of ['NDX','SPX','XNDX','SPXTR','ndx_pr','spx_pr','ndx_tr','spx_tr','bond_tr','bond_pr','RF'])assert.ok(Number.isFinite(row[field]),`${row.month} ${field}`);
});
test('August uses actual equity month ends and the unchanged bond formula',()=>{
  const august=history.at(-1),july=history.at(-2);
  close(august.NDX,29456.97325299668);close(august.XNDX,35976.93828495717);
  close(august.SPX,7686.14);close(august.SPXTR,17219.939453125);
  close(july.SPXTR,16763.419921875);
  close(august.spx_tr,august.SPXTR/july.SPXTR-1);close(august.ndx_tr,august.XNDX/july.XNDX-1);
  close(august.bond_tr,august.bond_pr+august.coupon);close(august.bond_pr,0);
});
test('Only August RF is explicitly provisional; January-July use published French returns',()=>{
  assert.equal(data.quality_notes.length,1);
  const q=data.quality_notes[0];assert.equal(q.month,'2026-08');assert.equal(q.field,'RF');assert.equal(q.status,'estimated');assert.equal(q.observed_value,null);
  close(q.effective_value,1/(1-.0363*31/360)-1);close(q.effective_value,history.at(-1).RF);
  const actual=[.003,.0028,.0029,.0029,.0031,.0029,.0033];history.slice(-8,-1).forEach((row,i)=>close(row.RF,actual[i]));
  const csv=readFileSync(new URL('../docs/data/monthly_history.csv',import.meta.url),'utf8');assert.ok(csv.split('\n')[0].includes('RF_status'));assert.ok(csv.trim().split('\n').at(-1).endsWith(',estimated'));
});
test('Both price and total-return backtests include August without changing optimization rules',()=>{
  const config={start:'1999-03',end:'2026-08',equityIncome:true,bondIncome:true,objective:'cagr_floor'};
  const result=computeMain(history,config);assert.equal(result.rows.length,329);
  assert.equal(periodRows(history,{...config,start:'1985-01',equityIncome:false}).length,499);
  const optimum=result.result.solutions.maxSharpeAtLeastSpxCagr;
  assert.ok(optimum.cagr>=result.result.baseline.cagr-1e-9);close(optimum.w.reduce((a,b)=>a+b),1);
});
