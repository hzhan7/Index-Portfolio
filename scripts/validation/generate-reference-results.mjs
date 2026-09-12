// Regenerates data/validation/reference_results.json from docs/data/history.json; then run scipy_crosscheck.py.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {calculateHistory} from '../calculate-portfolios.mjs';
import {optimizePortfolios} from '../../docs/assets/optimizer.js';
const bytes=await fs.readFile(new URL('../../docs/data/history.json',import.meta.url)),history=JSON.parse(bytes);
const cases=[
  {id:'1985_2025_stock_PR_bond_TR',start:'1985-01',end:'2025-12',stocksIncome:false,bondIncome:true},
  {id:'1999_2025_stock_TR_bond_TR',start:'1999-03',end:'2025-12',stocksIncome:true,bondIncome:true},
  {id:'2000_2009_stock_TR_bond_TR',start:'2000-01',end:'2009-12',stocksIncome:true,bondIncome:true},
  {id:'2015_2025_stock_TR_bond_TR',start:'2015-12',end:'2025-12',stocksIncome:true,bondIncome:true},
  {id:'1985_2025_stock_PR_bond_PR',start:'1985-01',end:'2025-12',stocksIncome:false,bondIncome:false},
];
const results=cases.map(c=>({id:c.id,...calculateHistory(history,c,optimizePortfolios)}));
const result={schemaVersion:1,inputSha256:createHash('sha256').update(bytes).digest('hex'),cases:results};
await fs.writeFile(new URL('../../data/validation/reference_results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(`reference_results.json: ${results.length} cases, inputSha256 ${result.inputSha256}`);
