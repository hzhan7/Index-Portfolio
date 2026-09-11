#!/usr/bin/env node
/** Standalone reproducible mean-variance analysis. Rates in CLI flags use percent. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {periodRows,modelForPeriod} from '../docs/assets/worker.js';
import {portfolioStats} from '../docs/assets/math.js';

const args={};
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i];
  if(key==='--help'){
    console.log('node scripts/calculate-frontier.mjs --start 1999-03 --end 2025-12 --equity-income true --bond-income true [--expected-percent 10,8,4] [--anchor-percent 3] [--vol-percent 12] [--gamma 5] [--out result.json]');process.exit(0);
  }
  if(!key.startsWith('--')||process.argv[i+1]==null)throw Error('Expected --name value');
  args[key.slice(2)]=process.argv[i+1];
}
const bool=(key,fallback)=>args[key]==null?fallback:args[key]==='true'?true:args[key]==='false'?false:(()=>{throw Error(`${key} must be true or false`);})();
const bytes=readFileSync(new URL('../docs/data/history.json',import.meta.url)),history=JSON.parse(bytes).observations;
const equityIncome=bool('equity-income',false),config={start:args.start??(equityIncome?'1999-03':'1985-01'),end:args.end??history.at(-1).month,equityIncome,bondIncome:bool('bond-income',true),
  expectedSource:args['expected-percent']?'custom':'historical',expectedReturns:args['expected-percent']?.split(',').map(v=>Number(v)/100),
  anchorSource:args['anchor-percent']!=null?'custom':'historical',anchorRate:Number(args['anchor-percent'])/100,
  budgetSource:args['vol-percent']!=null?'custom':'sp500',targetVol:Number(args['vol-percent'])/100,gamma:args.gamma==null?5:Number(args.gamma)};
if(!history.some(d=>d.month===config.start)||!history.some(d=>d.month===config.end)||config.start>=config.end)throw Error('Invalid month-end endpoints');
const rows=periodRows(history,config);
if(rows.length<12||rows.some(row=>!row.every(Number.isFinite)))throw Error('Insufficient complete monthly data for selected return basis');
const result=modelForPeriod(rows,config);
const output={parameters:config,inputFile:'docs/data/history.json',inputSha256:createHash('sha256').update(bytes).digest('hex'),...result,
  historicalPerformance:Object.fromEntries(['gmv','tangency','utility','riskBudget'].map(key=>[key,result[key]?.weights?portfolioStats(rows,result[key].weights):null]))};
const text=JSON.stringify(output,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?null:v,2)+'\n';
if(args.out)writeFileSync(args.out,text);else process.stdout.write(text);
