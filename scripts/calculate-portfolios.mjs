#!/usr/bin/env node
/**
 * Pure Node.js CLI. Run from the repository root; no npm dependencies.
 * node scripts/calculate-portfolios.mjs --start 1985-01 --end 2025-12 \
 *   --stocksIncome false --bondIncome true --objective all
 *
 * Defaults: input=docs/data/history.json, optimizer=docs/assets/optimizer.js.
 * Dates are month-end wealth endpoints: start is excluded from return rows.
 */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const OBJECTIVES = ['maxSharpe','maxSharpeAtLeastSpxCagr','maxCagrAtLeastSpxSharpe','equalSpxCagr','equalSpxSharpe'];
const bool = (v, defaultValue) => v == null ? defaultValue : ['true','1','yes'].includes(String(v).toLowerCase()) ? true : ['false','0','no'].includes(String(v).toLowerCase()) ? false : (()=>{throw Error(`Expected true/false, got ${v}`);})();

export function calculateHistory(history, options, optimizePortfolios) {
  const stocksIncome = bool(options.stocksIncome, false), bondIncome = bool(options.bondIncome, true);
  const start = options.start ?? (stocksIncome ? history.total_return_baseline : history.price_baseline);
  const end = options.end ?? history.observations.at(-1).month;
  const objective = options.objective ?? 'all';
  if (objective !== 'all' && !OBJECTIVES.includes(objective)) throw Error(`Unknown objective: ${objective}`);
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end) || start >= end) throw Error('Invalid start/end month.');
  if (!history.observations.some(o=>o.month===start) || !history.observations.some(o=>o.month===end)) throw Error('Endpoint outside available history.');
  const fields = stocksIncome ? ['ndx_tr','spx_tr'] : ['ndx_pr','spx_pr'];
  fields.push(bondIncome ? 'bond_tr' : 'bond_pr', 'RF');
  const selected = history.observations.filter(o=>o.month>start && o.month<=end);
  const expectedMonths = (+end.slice(0,4)- +start.slice(0,4))*12+ +end.slice(5)- +start.slice(5);
  if (selected.length !== expectedMonths) throw Error('History has missing months; no gaps are silently dropped.');
  const rows = selected.map(o=>fields.map(f=>{
    if (!Number.isFinite(o[f])) throw Error(`Missing ${f} at ${o.month}; narrow the dates or change the return basis.`);
    return o[f];
  }));
  const began = performance.now();
  const result = optimizePortfolios(rows);
  const elapsedMs = performance.now()-began;
  function addDates(x) {
    if (!x) return null;
    return {...x, mddPeakMonth:x.mddPeakIndex<0?start:selected[x.mddPeakIndex]?.month ?? null,
      mddTroughMonth:x.mddTroughIndex<0?null:selected[x.mddTroughIndex]?.month ?? null,
      mddRecoveryMonth:x.mddRecoveryIndex==null?null:selected[x.mddRecoveryIndex]?.month ?? null};
  }
  return {schemaVersion:1, parameters:{start,end,stocksIncome,bondIncome,objective},
    source:{inputFile:'docs/data/history.json',asOf:history.as_of,retrieved:history.retrieved},
    period:{startWealthMonth:start,endWealthMonth:end,firstReturnMonth:selected[0].month,lastReturnMonth:selected.at(-1).month,
      nMonths:rows.length,years:rows.length/12,startExcludedFromReturnRows:true},
    returnFields:fields, assetOrder:result.assetOrder, baseline:addDates(result.baseline),
    solutions:Object.fromEntries(Object.entries(result.solutions).filter(([k])=>objective==='all'||k===objective).map(([k,v])=>[k,addDates(v)])),
    method:result.method,assumptions:result.assumptions,diagnostics:{...result.diagnostics,elapsedMs}};
}

async function cli() {
  const options={};
  for(let i=2;i<process.argv.length;i++) {
    const key=process.argv[i];
    if(key==='--help') {
      console.log('Run from repository root: node scripts/calculate-portfolios.mjs --start YYYY-MM --end YYYY-MM --stocksIncome true|false --bondIncome true|false --objective all|maxSharpe|maxSharpeAtLeastSpxCagr|maxCagrAtLeastSpxSharpe|equalSpxCagr|equalSpxSharpe [--out results.json]');
      return;
    }
    if(!key.startsWith('--')||process.argv[i+1]==null)throw Error(`Invalid argument ${key}`);
    options[key.slice(2)]=process.argv[++i];
  }
  const input=options.input??'docs/data/history.json';
  const optimizer=options.optimizer??'docs/assets/optimizer.js';
  const bytes=await fs.readFile(path.resolve(input));
  const history=JSON.parse(bytes);
  const {optimizePortfolios}=await import(pathToFileURL(path.resolve(optimizer)).href);
  const result=calculateHistory(history,options,optimizePortfolios);
  result.source.inputSha256=createHash('sha256').update(bytes).digest('hex');
  const output=JSON.stringify(result,null,2)+'\n';
  if(options.out)await fs.writeFile(options.out,output);
  else process.stdout.write(output);
}
// Compare real paths: Node resolves symlinks in import.meta.url but not in argv[1].
const isMain=()=>{try{return realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(process.argv[1]&&isMain()) {
  cli().catch(e=>{console.error(e.message);process.exitCode=1;});
}
