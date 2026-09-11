import {optimizePortfolios} from './optimizer.js';
import {portfolioStats} from './math.js';
import {buildMeanVarianceModel,solveMeanVarianceModel} from './mean-variance.js?v=2';

export const objectiveKeys={cagr_floor:'maxSharpeAtLeastSpxCagr',cagr_equal:'equalSpxCagr',sharpe_floor:'maxCagrAtLeastSpxSharpe',sharpe_equal:'equalSpxSharpe',max_sharpe:'maxSharpe',tangency:'tangency',utility:'utility',risk_budget:'riskBudget'};
export function modelForPeriod(rows,config,frontierPoints=101){
  const model=buildMeanVarianceModel(rows,{
    expectedReturns:config.expectedSource==='custom'?config.expectedReturns:undefined,
    anchorRate:config.anchorSource==='custom'?config.anchorRate:undefined,
  });
  const gamma=config.gamma??5,targetVol=config.budgetSource==='custom'?config.targetVol:Math.sqrt(model.annualCovariance[1][1]);
  return {...solveMeanVarianceModel(model,{gamma,targetVol,frontierPoints}),settings:{gamma,targetVol}};
}
function historicalPoint(point,rows){return point?.weights?{...point,w:point.weights,...portfolioStats(rows,point.weights)}:null;}
function addModelSolutions(result,meanVariance,rows){
  for(const key of ['tangency','utility','riskBudget'])result.solutions[key]=historicalPoint(meanVariance[key],rows);
}
export function periodRows(history,config){
  return history.filter(d=>d.month>config.start&&d.month<=config.end).map(d=>[d[config.equityIncome?'ndx_tr':'ndx_pr'],d[config.equityIncome?'spx_tr':'spx_pr'],d[config.bondIncome?'bond_tr':'bond_pr'],d.RF]);
}
export function computeMain(history,config){
  const rows=periodRows(history,config);
  if(rows.length<12)throw new Error('请选择至少12个完整月份。');
  if(rows.some(r=>r.some(v=>v===null||!Number.isFinite(v))))throw new Error('所选期间缺少当前口径的数据；含股票股息模式请从1999年3月末开始。');
  const result=optimizePortfolios(rows);
  const meanVariance=modelForPeriod(rows,config);
  addModelSolutions(result,meanVariance,rows);
  const grid=[];
  for(let i=0;i<=50;i++)for(let j=0;j<=50-i;j++){
    const w=[i/50,j/50,(50-i-j)/50];grid.push({i,j,w,...portfolioStats(rows,w)});
  }
  return {rows,result,grid,meanVariance};
}
export function computeSensitivity(history,config,mode,years){
  const earliest=config.equityIncome?'1999-03':'1985-01', periods=[];
  const shift=(s,m)=>{let d=new Date(s+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+m);return d.toISOString().slice(0,7);};
  if(mode==='starts'){
    const starts=[earliest,'1990-01','1995-01','1999-03','2000-01','2003-01','2005-01','2009-01','2010-01','2015-01','2020-01'];
    for(const start of [...new Set(starts)].sort())if(start>=earliest&&shift(start,12)<=config.end)periods.push({start,end:config.end});
  }else{
    for(let start=earliest;shift(start,years*12)<=config.end;start=shift(start,12))periods.push({start,end:shift(start,years*12)});
    const lastStart=shift(config.end,-years*12);
    if(lastStart>=earliest&&!periods.some(p=>p.start===lastStart))periods.push({start:lastStart,end:config.end});
  }
  return periods.map(p=>{
    const rows=periodRows(history,{...config,...p});
    const result=optimizePortfolios(rows);
    if(['tangency','utility','risk_budget'].includes(config.objective))addModelSolutions(result,modelForPeriod(rows,config,2),rows);
    return {...p,n:rows.length,baseline:result.baseline,optimal:result.solutions[objectiveKeys[config.objective]]};
  });
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=({data})=>{
  try{const output=data.type==='main'?computeMain(data.history,data.config):computeSensitivity(data.history,data.config,data.mode,data.years);self.postMessage({id:data.id,type:data.type,output});}
  catch(error){self.postMessage({id:data.id,type:data.type,error:error.message});}
};
