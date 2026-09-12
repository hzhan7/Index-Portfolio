// Fixed comparison periods ('YYYY-MM'; 'latest' = last data month). Month arithmetic lives in series.js.

export const REGIMES = [
  { id: 'prebubble', label: '泡沫前', from: '1985-01', to: '1994-12' },
  { id: 'bubble', label: '互联网泡沫', from: '1994-12', to: '2000-03' },
  { id: 'bust', label: '泡沫破裂', from: '2000-03', to: '2002-09' },
  { id: 'recovery', label: '复苏', from: '2002-09', to: '2007-10' },
  { id: 'gfc', label: '全球金融危机', from: '2007-10', to: '2009-02' },
  { id: 'bull', label: '十年牛市', from: '2009-02', to: '2019-12' },
  { id: 'covid', label: '疫情宽松', from: '2019-12', to: '2021-12' },
  { id: 'hike', label: '加息熊市', from: '2021-12', to: '2022-12' },
  { id: 'ai', label: 'AI行情', from: '2022-12', to: 'latest' },
];
export const DECADES = ['1985-01', '1994-12', '2004-12', '2014-12', '2024-12', 'latest'];

export const resolveMonth = (m, latest) => (m === 'latest' || m == null ? latest : m);

export const regimePeriods = latest => REGIMES.map(r => ({ ...r, to: resolveMonth(r.to, latest) }));

/** Consecutive DECADES boundaries → [{id:'d1985'…, label:'1985-01～1994-12', from, to}]; ids match valuation.json segments. */
export function decadePeriods(latest) {
  const ends = DECADES.map(m => resolveMonth(m, latest));
  return ends.slice(1).map((to, i) => {
    const from = ends[i];
    return { id: `d${Number(from.slice(0, 4)) + (from.endsWith('-12') ? 1 : 0)}`, label: `${from}～${to}`, from, to };
  });
}
