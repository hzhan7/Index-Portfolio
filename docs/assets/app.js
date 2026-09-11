import {portfolioStats,adjustWeight,displayWeights} from './math.js';

const $=id=>document.getElementById(id),d3=window.d3;
const keys={cagr_floor:'maxSharpeAtLeastSpxCagr',cagr_equal:'equalSpxCagr',sharpe_floor:'maxCagrAtLeastSpxSharpe',sharpe_equal:'equalSpxSharpe',max_sharpe:'maxSharpe'};
const names={cagr_floor:'收益 ≥ 标普，夏普最大',cagr_equal:'收益 = 标普，夏普最大',sharpe_floor:'夏普 ≥ 标普，收益最大',sharpe_equal:'夏普 = 标普，收益最大',max_sharpe:'无约束最高夏普'};
const pct=v=>(v*100).toFixed(2)+'%',fmt=v=>Number.isFinite(v)?v.toFixed(3):'—';
const state={history:[],main:null,config:null,w:[.4,.3,.3],sensitivity:[],mainId:0,sensitivityId:0};
const tooltip=$('chart-tooltip');
const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
const colors={ndx:'#2563c9',spx:'#bf8030',bond:'#788797',ink:'#17253e',line:'#dce3ed',accent:'#19634f'};
function readConfig(){return{start:$('start-month').value,end:$('end-month').value,equityIncome:$('equity-income').checked,bondIncome:$('bond-income').checked,objective:$('objective').value};}
function labelDate(month){const [y,m]=month.split('-').map(Number);return `${y}.${String(m).padStart(2,'0')}.${new Date(Date.UTC(y,m,0)).getUTCDate()}`;}
function notices(config){
  const stock=config.equityIncome?'股票计入股息再投资':'股票不含股息',bond=config.bondIncome?'美债计入模型票息':'美债剔除模型票息';
  return `${stock} · ${bond}。${config.equityIncome?'已核验含息共同基点为1999年3月末；1985–1999年含息缺口未填补。':'1985起价格历史可用；这不是包含全部收入的总回报。'}`;
}
function requestMain(){
  const config=readConfig();
  const earliest=config.equityIncome?'1999-03':'1985-01';
  if(!config.start||!config.end||config.start<earliest||config.end>'2025-12'||config.start>=config.end){
    state.mainId++;document.body.classList.remove('computing');
    $('data-notice').textContent=`所选日期不可用：当前口径起点最早为${earliest}，终点最晚为2025-12。图表仍显示上一组有效条件。`;
    return;
  }
  $('data-notice').textContent=notices(config)+' 正在重新计算…';
  document.body.classList.add('computing');
  state.pendingConfig=config;
  worker.postMessage({type:'main',id:++state.mainId,history:state.history,config});
}
function requestSensitivity(){
  if(!state.config)return;
  $('sensitivity-status').textContent='正在计算不同期间的最优权重…';
  worker.postMessage({type:'sensitivity',id:++state.sensitivityId,history:state.history,config:state.config,mode:$('sensitivity-mode').value,years:Number($('window-years').value)});
}
worker.onmessage=({data})=>{
  if(data.id!==(data.type==='main'?state.mainId:state.sensitivityId))return;
  if(data.error){document.body.classList.remove('computing');$(data.type==='main'?'data-notice':'sensitivity-status').textContent=data.error;return;}
  if(data.type==='main'){
    state.main=data.output;state.config=state.pendingConfig;state.optimal=state.main.result.solutions[keys[state.config.objective]];
    document.body.classList.remove('computing');
    $('sample-dates').textContent=`${labelDate(state.config.start)} — ${labelDate(state.config.end)}`;
    $('sample-details').textContent=`${state.main.rows.length}个月 · 美元 · 每月再平衡 · 无杠杆`;
    $('data-notice').textContent=notices(state.config);
    $('cagr-label').textContent=state.config.equityIncome&&state.config.bondIncome?'含息 CAGR':'当前口径 CAGR';
    $('contour-key').textContent=`┄ 标普 ${state.config.objective.startsWith('sharpe')?'夏普':'CAGR'} 等值线`;
    setWeights(state.optimal?.w??[0,1,0],true);
    redraw();requestSensitivity();
  }else{
    state.sensitivity=data.output;
    $('sensitivity-status').textContent=data.output.length?'':'可用历史不足以覆盖所选窗口。';
    drawSensitivity();renderSensitivityTable();
  }
};
worker.onerror=event=>{$('load-status').hidden=false;$('load-status').textContent='计算程序未能启动，请刷新页面重试。';document.body.classList.remove('computing');console.error(event.message);};

function conditionStatus(stats){
  const b=state.main.result.baseline,k=state.config.objective;
  if(k==='max_sharpe')return{pass:true,text:'不设标普收益或夏普约束'};
  const eq=k.endsWith('equal'),isS=k.startsWith('sharpe');
  const gap=isS?stats.sharpe-b.sharpe:stats.cagr-b.cagr;
  const tol=eq?1e-7:1e-8;
  const pass=eq?Math.abs(gap)<=tol:gap>=-tol;
  return{pass,text:`${pass?'满足':'不满足'} ${isS?'夏普':'CAGR'} ${eq?'=':'≥'} 标普${eq?'（数值容差内）':''}`};
}
function setWeights(w,announce=false){
  state.w=w.slice();state.stats=portfolioStats(state.main.rows,state.w);
  const shown=displayWeights(state.w);
  for(let i=0;i<3;i++){$(`weight-${i}`).value=state.w[i]*100;$(`weight-value-${i}`).textContent=shown[i]+'%';$(`segment-${i}`).style.width=(state.w[i]*100)+'%';}
  document.querySelector('.metrics').setAttribute('aria-live',announce?'polite':'off');
  $('metric-cagr').textContent=pct(state.stats.cagr);$('metric-sharpe').textContent=fmt(state.stats.sharpe);$('metric-vol').textContent=pct(state.stats.vol);$('metric-mdd').textContent=pct(state.stats.mdd);
  const b=state.main.result.baseline,cg=(state.stats.cagr-b.cagr)*100,sg=state.stats.sharpe-b.sharpe;
  $('delta-cagr').textContent=`较标普 ${cg>=0?'+':''}${cg.toFixed(2)} 个百分点`;
  $('delta-sharpe').textContent=`较标普 ${sg>=0?'+':''}${sg.toFixed(3)}`;
  const constraint=conditionStatus(state.stats);$('constraint-status').textContent=constraint.text;$('constraint-status').classList.toggle('fail',!constraint.pass);
  const candidates={optimal:state.optimal?.w,sp500:[0,1,0],ndx:[1,0,0],bond:[0,0,1]};
  document.querySelectorAll('[data-preset]').forEach(button=>{const candidate=candidates[button.dataset.preset];const active=candidate&&candidate.every((v,i)=>Math.abs(v-state.w[i])<1e-8);button.classList.toggle('active',!!active);button.setAttribute('aria-pressed',String(!!active));});
  $('selection-note').textContent=`当前：纳指 ${shown[0]}% / 标普 ${shown[1]}% / 美债 ${shown[2]}% · CAGR ${pct(state.stats.cagr)} · 夏普 ${fmt(state.stats.sharpe)}`;
  renderComparison();updateMarkers();
}
function showTooltip(event,w,stats){
  const shown=displayWeights(w);tooltip.innerHTML=`<b>纳指 ${shown[0]}% / 标普 ${shown[1]}% / 美债 ${shown[2]}%</b><span>CAGR ${pct(stats.cagr)} · 夏普 ${fmt(stats.sharpe)}</span>`;tooltip.hidden=false;
  const rect=tooltip.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(window.innerWidth-rect.width-8,event.clientX+14))+'px';tooltip.style.top=Math.max(8,Math.min(window.innerHeight-rect.height-8,event.clientY+14))+'px';
}
function hideTooltip(){tooltip.hidden=true;}
function renderComparison(){
  const r=state.main.result,items=[['当前配置',{w:state.w,...state.stats},'current'],['当前目标最优',state.optimal,'highlight'],['无约束最高夏普',r.solutions.maxSharpe,''],['100% 标普500',r.baseline,''],['100% 纳斯达克100',{w:[1,0,0],...portfolioStats(state.main.rows,[1,0,0])},''],['100% 10年期美债',{w:[0,0,1],...portfolioStats(state.main.rows,[0,0,1])},'']];
  $('comparison-body').innerHTML=items.filter(d=>d[1]).map(([label,s,cls])=>`<tr class="${cls}"><td>${label}</td><td>${displayWeights(s.w).join(' / ')}%</td><td>${pct(s.cagr)}</td><td>${fmt(s.sharpe)}</td><td>${pct(s.vol)}</td><td>${pct(s.mdd)}</td></tr>`).join('');
}
function pathTriangle(coords){return 'M'+coords.map(p=>p.join(',')).join('L')+'Z';}
const chartRefs={};
function drawSurface(metric){
  const container=$(`${metric}-surface`),width=container.clientWidth;
  if(width<100)return;
  const left=34,right=width-34,top=33,height=(right-left)*Math.sqrt(3)/2,bottom=top+height,totalHeight=bottom+38;
  const point=w=>[w[0]*width/2+w[1]*left+w[2]*right,w[0]*top+(w[1]+w[2])*bottom];
  const weight=p=>{let n=(bottom-p[1])/height,s=(right-p[0]-n*(right-width/2))/(right-left),b=1-n-s;const a=[n,s,b].map(x=>Math.max(0,x)),sum=a.reduce((x,y)=>x+y,0);return a.map(x=>x/sum);};
  const svg=d3.select(container).selectAll('svg').data([null]).join('svg').attr('viewBox',`0 0 ${width} ${totalHeight}`).attr('role','img').attr('aria-label',`${metric==='cagr'?'CAGR':'夏普比率'}配比曲面。顶点分别为纳指、标普、美债100%；使用上方滑块可通过键盘修改。`);svg.selectAll('*').remove();
  const [minimum,maximum]=d3.extent(state.main.grid,d=>d[metric]);
  const palette=metric==='cagr'?['#eaf2ff','#82afea','#1a53a5']:['#efedf8','#aaa0d8','#4b338c'];
  const color=d3.scaleSequential(d3.interpolateRgbBasis(palette)).domain([minimum,maximum]);
  const vertices=new Map(state.main.grid.map(d=>[`${d.i},${d.j}`,d])),triangles=[];
  for(let i=0;i<50;i++)for(let j=0;j<50-i;j++){
    triangles.push([vertices.get(`${i},${j}`),vertices.get(`${i+1},${j}`),vertices.get(`${i},${j+1}`)]);
    if(i+j<49)triangles.push([vertices.get(`${i+1},${j}`),vertices.get(`${i+1},${j+1}`),vertices.get(`${i},${j+1}`)]);
  }
  svg.append('g').selectAll('path').data(triangles).join('path').attr('d',t=>pathTriangle(t.map(d=>point(d.w)))).attr('fill',t=>color(d3.mean(t,d=>d[metric]))).attr('stroke',t=>color(d3.mean(t,d=>d[metric]))).attr('stroke-width',.4);
  for(let p=.2;p<1;p+=.2){
    const paths=[[[p,1-p,0],[p,0,1-p]],[[1-p,p,0],[0,p,1-p]],[[1-p,0,p],[0,1-p,p]]];
    paths.forEach(pair=>svg.append('path').attr('d','M'+pair.map(point).map(p=>p.join(',')).join('L')).attr('stroke','#fff').attr('stroke-opacity',.35).attr('fill','none'));
    const [x,y]=point([p,1-p,0]);svg.append('text').attr('x',x-8).attr('y',y+4).attr('text-anchor','end').text(Math.round(p*100));
  }
  const thresholdMetric=state.config.objective.startsWith('sharpe')?'sharpe':'cagr',threshold=state.main.result.baseline[thresholdMetric];
  let iso='';
  for(const tri of triangles){const cross=[];for(let k=0;k<3;k++){const a=tri[k],b=tri[(k+1)%3],av=a[thresholdMetric]-threshold,bv=b[thresholdMetric]-threshold;if(av*bv<=0&&Math.abs(av-bv)>1e-14){const t=av/(av-bv),p=point(a.w.map((v,i)=>v+t*(b.w[i]-v)));if(!cross.some(c=>Math.hypot(p[0]-c[0],p[1]-c[1])<.001))cross.push(p);}}if(cross.length===2)iso+='M'+cross[0].join(',')+'L'+cross[1].join(',');}
  svg.append('path').attr('d',iso).attr('fill','none').attr('stroke','#fff').attr('stroke-width',3.5);
  svg.append('path').attr('d',iso).attr('fill','none').attr('stroke',colors.ink).attr('stroke-width',1.4).attr('stroke-dasharray','4 3');
  svg.append('path').attr('d',pathTriangle([[width/2,top],[left,bottom],[right,bottom]])).attr('fill','none').attr('stroke',colors.line);
  svg.append('text').attr('class','vertex').attr('x',width/2).attr('y',17).attr('text-anchor','middle').text('纳指100%');
  svg.append('text').attr('class','vertex').attr('x',left-16).attr('y',bottom+26).attr('text-anchor','start').text('标普100%');
  svg.append('text').attr('class','vertex').attr('x',right+16).attr('y',bottom+26).attr('text-anchor','end').text('美债100%');
  const optimal=svg.append('path').attr('d',d3.symbol().type(d3.symbolStar).size(110)()).attr('fill',colors.ink).attr('stroke','#fff').attr('stroke-width',1.4);
  if(state.optimal)optimal.attr('transform',`translate(${point(state.optimal.w)})`);else optimal.attr('display','none');
  const current=svg.append('circle').attr('r',7).attr('fill','none').attr('stroke','#fff').attr('stroke-width',4);
  const currentInner=svg.append('circle').attr('r',7).attr('fill','none').attr('stroke',colors.ink).attr('stroke-width',1.8);
  let dragging=false;
  svg.append('path').attr('d',pathTriangle([[width/2,top],[left,bottom],[right,bottom]])).attr('fill','transparent').attr('class','chart-target')
    .on('pointerdown',function(event){dragging=true;this.setPointerCapture(event.pointerId);const w=weight(d3.pointer(event,svg.node()));setWeights(w);showTooltip(event,w,state.stats);})
    .on('pointermove',event=>{const w=weight(d3.pointer(event,svg.node())),s=portfolioStats(state.main.rows,w);showTooltip(event,w,s);if(dragging)setWeights(w);})
    .on('pointerup',event=>{dragging=false;setWeights(weight(d3.pointer(event,svg.node())),true);hideTooltip();}).on('pointercancel',()=>{dragging=false;hideTooltip();}).on('pointerleave',()=>{if(!dragging)hideTooltip();});
  chartRefs[metric]={point,current,currentInner};
  const format=metric==='cagr'?pct:fmt;
  $(`${metric}-scale`).innerHTML=`<span>${format(minimum)}</span><span class="color-strip" style="background:linear-gradient(90deg,${palette.join(',')})"></span><span>${format(maximum)}</span>`;
}
function drawFrontier(){
  const container=$('frontier-chart'),width=container.clientWidth,height=width<600?320:365;
  const pad={left:66,right:22,top:18,bottom:57},frame={x:pad.left,y:pad.top,w:width-pad.left-pad.right,h:height-pad.top-pad.bottom};
  const all=state.main.grid.concat(state.optimal?[state.optimal]:[]),xd=d3.extent(all,d=>d.cagr),yd=d3.extent(all,d=>d.sharpe),xp=(xd[1]-xd[0])*.06||.01,yp=(yd[1]-yd[0])*.08||.03;
  const x=d3.scaleLinear().domain([xd[0]-xp,xd[1]+xp]).range([frame.x+7,frame.x+frame.w-7]);
  const y=d3.scaleLinear().domain([yd[0]-yp,yd[1]+yp]).range([frame.y+frame.h-7,frame.y+7]);
  const svg=d3.select(container).selectAll('svg').data([null]).join('svg').attr('viewBox',`0 0 ${width} ${height}`).attr('role','img').attr('aria-label','各配比的CAGR与夏普比率散点图，实线为2%权重网格的近似有效边界。');svg.selectAll('*').remove();
  svg.append('g').attr('class','grid').attr('transform',`translate(${frame.x+frame.w},0)`).call(d3.axisLeft(y).ticks(5).tickSize(frame.w).tickFormat(''));
  svg.append('rect').attr('class','chart-frame').attr('x',frame.x).attr('y',frame.y).attr('width',frame.w).attr('height',frame.h);
  svg.append('g').attr('transform',`translate(0,${frame.y+frame.h})`).call(d3.axisBottom(x).ticks(width<500?4:7).tickFormat(d3.format('.1%')).tickSize(0)).call(g=>g.select('.domain').remove()).selectAll('text').attr('dy','1.2em');
  svg.append('g').attr('transform',`translate(${frame.x},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d3.format('.2f')).tickSize(0)).call(g=>g.select('.domain').remove()).selectAll('text').attr('dx','-.6em');
  svg.append('text').attr('class','axis-title').attr('x',frame.x+frame.w/2).attr('y',height-7).attr('text-anchor','middle').text('CAGR · 年化复合增长率');
  svg.append('text').attr('class','axis-title').attr('transform',`translate(16,${frame.y+frame.h/2}) rotate(-90)`).attr('text-anchor','middle').text('夏普比率');
  svg.append('g').selectAll('circle').data(state.main.grid).join('circle').attr('cx',d=>x(d.cagr)).attr('cy',d=>y(d.sharpe)).attr('r',1.65).attr('fill',colors.ndx).attr('opacity',.23);
  let best=-Infinity;const frontier=state.main.grid.slice().sort((a,b)=>b.cagr-a.cagr).filter(d=>{if(d.sharpe>best){best=d.sharpe;return true;}return false;});
  svg.append('path').datum(frontier).attr('d',d3.line().x(d=>x(d.cagr)).y(d=>y(d.sharpe))).attr('stroke',colors.accent).attr('stroke-width',2).attr('fill','none');
  const baseline=state.main.result.baseline,isSharpe=state.config.objective.startsWith('sharpe');
  svg.append('line').attr('x1',isSharpe?frame.x:x(baseline.cagr)).attr('x2',isSharpe?frame.x+frame.w:x(baseline.cagr)).attr('y1',isSharpe?y(baseline.sharpe):frame.y).attr('y2',isSharpe?y(baseline.sharpe):frame.y+frame.h).attr('stroke','#8a96a8').attr('stroke-dasharray','4 4');
  svg.append('path').attr('d',d3.symbol().type(d3.symbolDiamond).size(95)()).attr('transform',`translate(${x(baseline.cagr)},${y(baseline.sharpe)})`).attr('fill',colors.spx).attr('stroke','#fff').attr('stroke-width',1.5);
  if(state.optimal)svg.append('path').attr('d',d3.symbol().type(d3.symbolStar).size(115)()).attr('transform',`translate(${x(state.optimal.cagr)},${y(state.optimal.sharpe)})`).attr('fill',colors.ink).attr('stroke','#fff').attr('stroke-width',1.4);
  const current=svg.append('circle').attr('r',7).attr('fill','none').attr('stroke',colors.ink).attr('stroke-width',2);
  const nearest=event=>{const p=d3.pointer(event,svg.node());return d3.least(all,d=>(x(d.cagr)-p[0])**2+(y(d.sharpe)-p[1])**2);};
  svg.append('rect').attr('x',frame.x).attr('y',frame.y).attr('width',frame.w).attr('height',frame.h).attr('fill','transparent').attr('class','chart-target').on('pointermove',event=>{const d=nearest(event);showTooltip(event,d.w,d);}).on('pointerleave',hideTooltip).on('click',event=>{const d=nearest(event);setWeights(d.w,true);hideTooltip();});
  chartRefs.frontier={current,x,y};
}
function updateMarkers(){
  for(const metric of ['cagr','sharpe'])if(chartRefs[metric]){const c=chartRefs[metric],[x,y]=c.point(state.w);c.current.attr('cx',x).attr('cy',y);c.currentInner.attr('cx',x).attr('cy',y);}
  if(chartRefs.frontier){const c=chartRefs.frontier;c.current.attr('cx',c.x(state.stats.cagr)).attr('cy',c.y(state.stats.sharpe));}
}
function drawSensitivity(){
  const container=$('sensitivity-chart'),data=state.sensitivity.filter(p=>p.optimal),width=container.clientWidth,height=290,pad={l:66,r:20,t:16,b:59};
  const svg=d3.select(container).selectAll('svg').data([null]).join('svg').attr('viewBox',`0 0 ${width} ${height}`).attr('role','img').attr('aria-label','不同回测期间的最优资产权重，纳指、标普、美债权重合计100%。');svg.selectAll('*').remove();
  if(!data.length)return;
  const x=d3.scaleBand().domain(data.map((d,i)=>i)).range([pad.l,width-pad.r]).padding(.18),y=d3.scaleLinear().domain([0,1]).range([height-pad.b,pad.t]);
  svg.append('rect').attr('class','chart-frame').attr('x',pad.l).attr('y',pad.t).attr('width',width-pad.l-pad.r).attr('height',height-pad.t-pad.b);
  const maximumTicks=width<500?4:8,step=Math.max(1,Math.ceil(data.length/maximumTicks)),ticks=data.map((d,i)=>i).filter(i=>i%step===0);
  svg.append('g').attr('transform',`translate(0,${height-pad.b})`).call(d3.axisBottom(x).tickValues(ticks).tickFormat(i=>data[i].start).tickSize(0)).call(g=>g.select('.domain').remove()).selectAll('text').attr('dy','1.3em');
  svg.append('g').attr('transform',`translate(${pad.l},0)`).call(d3.axisLeft(y).tickValues([0,.25,.5,.75,1]).tickFormat(d3.format('.0%')).tickSize(0)).call(g=>g.select('.domain').remove()).selectAll('text').attr('dx','-.6em');
  svg.append('text').attr('class','axis-title').attr('x',(pad.l+width-pad.r)/2).attr('y',height-5).attr('text-anchor','middle').text('回测起点（月末）');
  svg.append('text').attr('class','axis-title').attr('transform',`translate(16,${(height-pad.b)/2}) rotate(-90)`).attr('text-anchor','middle').text('最优配置权重');
  data.forEach((p,i)=>{let sum=0;for(let asset=0;asset<3;asset++){const before=sum;sum+=p.optimal.w[asset];svg.append('rect').attr('x',x(i)).attr('y',y(sum)).attr('width',x.bandwidth()).attr('height',Math.max(0,y(before)-y(sum))).attr('fill',[colors.ndx,colors.spx,colors.bond][asset]);}});
  const nearest=event=>{const px=d3.pointer(event,svg.node())[0];return data[Math.max(0,Math.min(data.length-1,Math.floor((px-pad.l)/x.step())))];};
  svg.append('rect').attr('x',pad.l).attr('y',pad.t).attr('width',width-pad.l-pad.r).attr('height',height-pad.t-pad.b).attr('fill','transparent').attr('class','chart-target').on('pointermove',event=>{const p=nearest(event);showTooltip(event,p.optimal.w,p.optimal);}).on('pointerleave',hideTooltip).on('click',event=>{const p=nearest(event);selectPeriod(p);hideTooltip();});
}
function selectPeriod(period){$('start-month').value=period.start;$('end-month').value=period.end;requestMain();}
function renderSensitivityTable(){
  const body=$('sensitivity-body');body.innerHTML=state.sensitivity.map((p,i)=>`<tr><td><button type="button" class="period-link" data-row="${i}">${p.start} → ${p.end}</button></td>${p.optimal?`<td>${displayWeights(p.optimal.w).join(' / ')}%</td><td>${pct(p.optimal.cagr)}</td><td>${pct(p.baseline.cagr)}</td><td>${fmt(p.optimal.sharpe)}</td><td>${fmt(p.baseline.sharpe)}</td>`:'<td colspan="5">未找到可行解</td>'}</tr>`).join('');
  body.querySelectorAll('[data-row]').forEach(button=>button.addEventListener('click',()=>selectPeriod(state.sensitivity[Number(button.dataset.row)])));
}
function redraw(){if(!state.main)return;drawSurface('cagr');drawSurface('sharpe');drawFrontier();updateMarkers();drawSensitivity();}
for(let i=0;i<3;i++){$(`weight-${i}`).addEventListener('input',event=>{if(state.main)setWeights(adjustWeight(state.w,i,Number(event.target.value)/100));});$(`weight-${i}`).addEventListener('change',()=>{if(state.main)setWeights(state.w,true);});}
document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{if(!state.main)return;const w={optimal:state.optimal?.w,sp500:[0,1,0],ndx:[1,0,0],bond:[0,0,1]}[button.dataset.preset];if(w)setWeights(w,true);}));
document.querySelectorAll('[data-period]').forEach(button=>button.addEventListener('click',()=>{const p=button.dataset.period;if(p==='1985'){$('start-month').value='1985-01';$('equity-income').checked=false;}else if(p==='1999'){$('start-month').value='1999-03';$('equity-income').checked=true;}else $('start-month').value=p+'-01';$('end-month').value='2025-12';$('start-month').min=$('equity-income').checked?'1999-03':'1985-01';requestMain();}));
for(const id of ['start-month','end-month','objective','bond-income'])$(id).addEventListener('change',requestMain);
$('equity-income').addEventListener('change',()=>{const minimum=$('equity-income').checked?'1999-03':'1985-01';$('start-month').min=minimum;if($('start-month').value<minimum)$('start-month').value=minimum;requestMain();});
$('sensitivity-mode').addEventListener('change',()=>{$('window-years').disabled=$('sensitivity-mode').value!=='rolling';requestSensitivity();});$('window-years').addEventListener('change',requestSensitivity);
let resizeTimer,lastWidth=0;const observer=new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(Math.abs(width-lastWidth)<1)return;lastWidth=width;clearTimeout(resizeTimer);resizeTimer=setTimeout(redraw,100);});observer.observe(document.querySelector('main'));

try{
  if(!d3)throw new Error('图表资源未加载。');
  const response=await fetch(new URL('../data/history.json',import.meta.url));if(!response.ok)throw new Error('历史数据加载失败。');
  const data=await response.json();state.history=data.observations;
  $('load-status').hidden=true;$('app').hidden=false;requestMain();
}catch(error){$('load-status').textContent=error.message+' 请刷新重试。';}

// Optional page-scoped agent access; unsupported browsers keep the normal UI.
if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  try{await document.modelContext.registerTool({name:'configure_index_portfolio',title:'设置指数配置比例',description:'调整当前历史样本下的纳指、标普和美债权重，并返回页面显示的收益与风险指标。不会交易或提交数据。',inputSchema:{type:'object',properties:{weights:{type:'array',items:{type:'number',minimum:0,maximum:1},minItems:3,maxItems:3}},required:['weights'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!state.main)throw new Error('数据尚未就绪');portfolioStats(state.main.rows,input.weights);setWeights(input.weights,true);return{weights:state.w,statistics:state.stats,period:state.config};}},{signal:lifecycle.signal});window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});}catch(error){console.info('Optional agent interface unavailable:',error.message);}
}
