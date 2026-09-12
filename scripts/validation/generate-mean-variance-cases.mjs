// Writes the uncommitted cases file read by mean_variance_crosscheck.py (default: OS temp dir).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {optimizeMeanVariance} from '../../docs/assets/mean-variance.js';
const out=process.argv[2]??path.join(os.tmpdir(),'index-portfolio-mean-variance-cases.json');
const bytes=await fs.readFile(new URL('../../docs/data/history.json',import.meta.url));const history=JSON.parse(bytes);
const cases=[
 {id:'1985_PR_bondTR',start:'1985-01',end:'2025-12',stocksIncome:false,options:{}},
 {id:'1999_TR_bondTR',start:'1999-03',end:'2025-12',stocksIncome:true,options:{}},
 {id:'2000_2009_TR',start:'2000-01',end:'2009-12',stocksIncome:true,options:{}},
 {id:'2015_2025_TR',start:'2015-12',end:'2025-12',stocksIncome:true,options:{}},
 {id:'custom_returns',start:'1999-03',end:'2025-12',stocksIncome:true,options:{expectedReturns:[.09,.08,.035],anchorRate:.04,gamma:3,targetVol:.12}},
 {id:'high_anchor',start:'1999-03',end:'2025-12',stocksIncome:true,options:{anchorRate:.50}},
 {id:'negative_custom_premiums',start:'1999-03',end:'2025-12',stocksIncome:true,options:{expectedReturns:[-.01,-.02,0],anchorRate:.03}},
 {id:'infeasible_vol_cap',start:'1999-03',end:'2025-12',stocksIncome:true,options:{targetVol:.01}},
 {id:'tied_expected_returns',start:'1999-03',end:'2025-12',stocksIncome:true,options:{expectedReturns:[.06,.06,.03],anchorRate:.01}},
 {id:'zero_risk_aversion',start:'1999-03',end:'2025-12',stocksIncome:true,options:{gamma:0}},
 {id:'spx_vol_budget',start:'1999-03',end:'2025-12',stocksIncome:true,useSpxVolCap:true,options:{}},
];
const startTime=performance.now();
for(const c of cases){
 const fields=c.stocksIncome?['ndx_tr','spx_tr','bond_tr','RF']:['ndx_pr','spx_pr','bond_tr','RF'];
 const rows=history.observations.filter(o=>o.month>c.start&&o.month<=c.end).map(o=>fields.map(f=>o[f]));
 if(c.useSpxVolCap){const mean=rows.reduce((s,r)=>s+r[1],0)/rows.length;c.options.targetVol=Math.sqrt(12*rows.reduce((s,r)=>s+(r[1]-mean)**2,0)/(rows.length-1));}
 const begin=performance.now();c.result=optimizeMeanVariance(rows,c.options);c.elapsedMs=performance.now()-begin;
}
const result={inputFile:'docs/data/history.json',inputSha256:createHash('sha256').update(bytes).digest('hex'),totalElapsedMs:performance.now()-startTime,cases};
await fs.writeFile(out,JSON.stringify(result,null,2)+'\n');
console.log(`${out}: ${cases.length} cases, inputSha256 ${result.inputSha256}`);
