import {computeModelMetrics} from './mean-variance.js?v=2';

const d3=window.d3;
const colors={ink:'#17253e',line:'#dce3ed',frontier:'#19634f',reference:'#9255a2',cloud:'#638aba',assets:['#2563c9','#bf8030','#788797']};

export function drawMeanVarianceChart(container,{meanVariance,grid,objective,optimal,config,w,onSelect,onHover,onLeave}){
  const {model,frontier,gmv,tangency,utility,settings}=meanVariance;
  const points=grid.map(p=>computeModelMetrics(p.w,model));
  const assetPoints=[[1,0,0],[0,1,0],[0,0,1]].map(weights=>computeModelMetrics(weights,model));
  const chosen=optimal?computeModelMetrics(optimal.w,model):null;
  const width=container.clientWidth,height=width<600?365:415,pad={left:72,right:25,top:25,bottom:60};
  if(width<150)return{updateSelection(){}};
  const frame={x:pad.left,y:pad.top,w:width-pad.left-pad.right,h:height-pad.top-pad.bottom};
  const all=[...points,...frontier,...assetPoints,gmv,...(chosen?[chosen]:[])];
  const showLine=objective==='tangency'&&tangency;
  const xmax=Math.max(...all.map(p=>p.modelVol),objective==='risk_budget'?settings.targetVol:0)*1.06;
  const ys=all.map(p=>p.expectedReturn);if(showLine)ys.push(model.anchorRate);
  const [lo,hi]=d3.extent(ys),yp=Math.max((hi-lo)*.14,.003);
  const x=d3.scaleLinear().domain([0,Math.max(xmax,.001)]).range([frame.x+5,frame.x+frame.w-6]);
  const y=d3.scaleLinear().domain([lo-yp,hi+yp]).range([frame.y+frame.h-5,frame.y+5]);
  const svg=d3.select(container).selectAll('svg').data([null]).join('svg').attr('viewBox',`0 0 ${width} ${height}`).attr('role','img').attr('aria-label','均值方差有效前沿。横轴为年化总波动率，纵轴为算术年化预期收益。星号为当前优化目标的最优点。');
  svg.selectAll('*').remove();
  const clipId='mean-variance-plot-clip';svg.append('defs').append('clipPath').attr('id',clipId).append('rect').attr('x',frame.x).attr('y',frame.y).attr('width',frame.w).attr('height',frame.h);
  svg.append('g').attr('class','grid').attr('transform',`translate(${frame.x+frame.w},0)`).call(d3.axisLeft(y).ticks(6).tickSize(frame.w).tickFormat(''));
  svg.append('rect').attr('class','chart-frame').attr('x',frame.x).attr('y',frame.y).attr('width',frame.w).attr('height',frame.h);
  svg.append('g').attr('transform',`translate(0,${frame.y+frame.h})`).call(d3.axisBottom(x).ticks(width<500?4:7).tickFormat(d3.format('.0%')).tickSize(0)).call(g=>g.select('.domain').remove()).selectAll('text').attr('dy','1.25em');
  svg.append('g').attr('transform',`translate(${frame.x},0)`).call(d3.axisLeft(y).ticks(6).tickFormat(d3.format('.1%')).tickSize(0)).call(g=>g.select('.domain').remove()).selectAll('text').attr('dx','-.65em');
  svg.append('text').attr('class','axis-title').attr('x',frame.x+frame.w/2).attr('y',height-7).attr('text-anchor','middle').text('年化总波动率 σ');
  svg.append('text').attr('class','axis-title').attr('transform',`translate(16,${frame.y+frame.h/2}) rotate(-90)`).attr('text-anchor','middle').text('年化预期收益 μ（算术）');
  const plot=svg.append('g').attr('clip-path',`url(#${clipId})`);
  plot.append('g').selectAll('circle').data(points).join('circle').attr('cx',p=>x(p.modelVol)).attr('cy',p=>y(p.expectedReturn)).attr('r',1.7).attr('fill',colors.cloud).attr('opacity',.25);
  const line=d3.line().x(p=>x(p.modelVol)).y(p=>y(p.expectedReturn));
  plot.append('path').datum(frontier).attr('d',line).attr('fill','none').attr('stroke',colors.frontier).attr('stroke-width',2.6);
  if(showLine){
    const reference=[{modelVol:0,expectedReturn:model.anchorRate},{modelVol:x.domain()[1],expectedReturn:model.anchorRate+tangency.slope*x.domain()[1]}];
    plot.append('path').datum(reference).attr('d',line).attr('fill','none').attr('stroke',colors.reference).attr('stroke-width',1.8).attr('stroke-dasharray','7 4');
    plot.append('circle').attr('cx',x(0)).attr('cy',y(model.anchorRate)).attr('r',3.4).attr('fill',colors.reference);
    svg.append('text').attr('x',x(0)+8).attr('y',Math.max(frame.y+15,y(model.anchorRate)-10)).text(`截距 ${(model.anchorRate*100).toFixed(2)}%`);
  }
  if(objective==='utility'&&utility){
    const curve=d3.range(101).map(i=>{const v=x.domain()[1]*i/100;return{modelVol:v,expectedReturn:utility.utility+settings.gamma*v*v/2};});
    plot.append('path').datum(curve).attr('d',line).attr('fill','none').attr('stroke',colors.reference).attr('stroke-width',1.8).attr('stroke-dasharray','7 4');
  }
  if(objective==='risk_budget'){
    plot.append('line').attr('x1',x(settings.targetVol)).attr('x2',x(settings.targetVol)).attr('y1',frame.y).attr('y2',frame.y+frame.h).attr('stroke',colors.reference).attr('stroke-width',1.8).attr('stroke-dasharray','7 4');
    svg.append('text').attr('x',Math.min(x(settings.targetVol)-8,frame.x+frame.w-8)).attr('y',frame.y+15).attr('text-anchor','end').text(`上限 ${(settings.targetVol*100).toFixed(2)}%`);
  }
  // Labels stay inside the plot and optional labels yield when marks are close.
  const labelBoxes=[];
  assetPoints.forEach((p,i)=>{
    const px=x(p.modelVol),py=y(p.expectedReturn);
    plot.append('circle').attr('cx',px).attr('cy',py).attr('r',4).attr('fill',colors.assets[i]).attr('stroke','#fff').attr('stroke-width',1.3);
    const candidates=[[px+9,py-8,'start'],[px-9,py-8,'end'],[px+9,py+18,'start'],[px-9,py+18,'end']];
    for(const [tx,ty,anchor]of candidates){
      const text=svg.append('text').attr('x',tx).attr('y',ty).attr('text-anchor',anchor).text(['纳指100%','标普100%','美债100%'][i]);
      const b=text.node().getBBox();
      if(b.x<frame.x+4||b.x+b.width>frame.x+frame.w-4||b.y<frame.y+3||b.y+b.height>frame.y+frame.h-3||labelBoxes.some(a=>b.x<a.x+a.width+4&&b.x+b.width+4>a.x&&b.y<a.y+a.height+4&&b.y+b.height+4>a.y)){text.remove();continue;}
      labelBoxes.push(b);break;
    }
  });
  plot.append('rect').attr('x',x(gmv.modelVol)-3).attr('y',y(gmv.expectedReturn)-3).attr('width',6).attr('height',6).attr('fill',colors.ink);
  if(chosen)plot.append('path').attr('d',d3.symbol().type(d3.symbolStar).size(140)()).attr('transform',`translate(${x(chosen.modelVol)},${y(chosen.expectedReturn)})`).attr('fill',colors.ink).attr('stroke','#fff').attr('stroke-width',1.5);
  const ring=plot.append('circle').attr('r',8).attr('fill','none').attr('stroke','#fff').attr('stroke-width',4);
  const current=plot.append('circle').attr('r',8).attr('fill','none').attr('stroke',colors.ink).attr('stroke-width',1.9);
  const hits=[...all,...(tangency?[tangency]:[])];
  const nearest=event=>{const p=d3.pointer(event,svg.node());return d3.least(hits,v=>(x(v.modelVol)-p[0])**2+(y(v.expectedReturn)-p[1])**2);};
  svg.append('rect').attr('x',frame.x).attr('y',frame.y).attr('width',frame.w).attr('height',frame.h).attr('fill','transparent').attr('class','chart-target')
    .on('pointermove',event=>onHover(event,nearest(event))).on('pointerleave',onLeave).on('click',event=>{onSelect(nearest(event).weights);onLeave();});
  const updateSelection=weights=>{const p=computeModelMetrics(weights,model);for(const mark of [ring,current])mark.attr('cx',x(p.modelVol)).attr('cy',y(p.expectedReturn));};
  updateSelection(w);return{updateSelection};
}
