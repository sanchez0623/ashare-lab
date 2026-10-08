// All minute timestamps label BAR CLOSE in Asia/Shanghai, with no implicit timezone conversion.
export const dayOf = r => r.date.slice(0, 10);
export const periodLabel = tf => ({'1d':'日线','5m':'5 分钟','15m':'15 分钟'}[tf] || tf);
export function slots(minutes) {
  const result = [];
  for (const start of [570, 780]) for (let m = start + minutes; m <= start + 120; m += minutes)
    result.push(`${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`);
  return result;
}
export function detectTimeframe(data) {
  if (!data.length) throw Error('行情数据为空。');
  const daily = data[0].date.length === 10;
  if (data.some(r => (r.date.length === 10) !== daily)) throw Error('不能混用日线和分钟时间戳。');
  return daily ? '1d' : data.some(r => Number(r.date.slice(14,16)) % 15 !== 0) ? '5m' : '15m';
}
export function executionTime(r, tf) {
  if (tf === '1d') return `${dayOf(r)} 09:30`;
  const n = Number(r.date.slice(11,13)) * 60 + Number(r.date.slice(14,16)) - parseInt(tf);
  return `${dayOf(r)} ${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
}
export const closeTime = r => r.date.length === 10 ? `${r.date} 15:00` : r.date;
function validDate(value) {
  const date = value.slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
}
export function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  if (lines.length > 120001) throw Error('最多支持 120,000 根 K 线。');
  const split = s => {
    let result=[], value='', quoted=false;
    for(let i=0;i<s.length;i++) {
      const char=s[i];
      if(char==='"') { if(quoted&&s[i+1]==='"'){value+='"';i++;}else quoted=!quoted; }
      else if(char===','&&!quoted){result.push(value.trim());value='';} else value+=char;
    }
    if(quoted) throw Error('CSV 引号未闭合。');
    result.push(value.trim()); return result;
  };
  const aliases={'日期':'date','时间':'date','datetime':'date','开盘':'open','最高':'high','最低':'low','收盘':'close','成交量':'volume','昨收':'prev_close','复权收盘':'signal_close','涨停价':'limit_up','跌停价':'limit_down','停牌':'halted'};
  const headers=split(lines[0]).map(s=>aliases[s.toLowerCase()]||s.toLowerCase());
  for(const key of ['date','open','high','low','close','volume']) if(!headers.includes(key)) throw Error('缺少列：'+key);
  if(new Set(headers).size!==headers.length) throw Error('CSV 存在重复列名。');
  const seen=new Set();
  const data=lines.slice(1).filter(s=>s.trim()).map((line,i)=>{
    const values=split(line), r={};
    if(values.length!==headers.length) throw Error(`第 ${i+2} 行列数不一致。`);
    headers.forEach((h,j)=>{if(values[j]!=='')r[h]=h==='date'?values[j].replace('T',' '):Number(values[j]);});
    // A trailing :00 is seconds only for a 19-character datetime, not 15:00 minutes.
    const raw=values[headers.indexOf('date')].replace('T',' ');
    r.date=raw.length===19&&raw.endsWith(':00')?raw.slice(0,16):raw;
    if(!/^(\d{4}-\d{2}-\d{2})( \d{2}:\d{2})?$/.test(r.date)||!validDate(r.date)) throw Error(`第 ${i+2} 行时间需为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm（北京时间，K线结束时间）。`);
    if(seen.has(r.date)) throw Error('存在重复时间：'+r.date); seen.add(r.date);
    for(const key of ['open','high','low','close','volume']) if(!Number.isFinite(r[key])||r[key]<(key==='volume'?0:0.000001))throw Error(`第 ${i+2} 行 ${key} 无效。`);
    if(r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.low>r.high)throw Error(`第 ${i+2} 行 OHLC 价格关系不正确。`);
    for(const key of ['prev_close','signal_close','limit_up','limit_down'])if(r[key]!==undefined&&(!Number.isFinite(r[key])||r[key]<=0))throw Error(`第 ${i+2} 行 ${key} 无效。`);
    if(r.halted!==undefined&&![0,1].includes(r.halted))throw Error('halted 只能为 0 或 1，表示开盘时已知的停牌状态。');
    // Zero traded volume is an execution outcome, not opening-known suspension.
    // Keep the candle and the supplied status; the engine resolves fills later.
    if((r.limit_up===undefined)!==(r.limit_down===undefined))throw Error('涨停价与跌停价需成对提供。');
    if(r.limit_up!==undefined&&r.limit_up<r.limit_down)throw Error('涨停价不能低于跌停价。');
    return r;
  }).sort((a,b)=>a.date.localeCompare(b.date));
  if(data.length<2)throw Error('CSV 至少需要两根 K 线。');
  if(data.some(r=>r.signal_close!==undefined)&&data.some(r=>r.signal_close===undefined))throw Error('signal_close 列必须每行都有数值。');
  const tf=detectTimeframe(data);
  if(tf!=='1d') { const grid=new Set(slots(parseInt(tf)));for(const r of data)if(!grid.has(r.date.slice(11)))throw Error('分钟结束时间必须位于 A 股 09:30–11:30、13:00–15:00 的 5/15 分钟网格；不接受午休或未对齐 K 线。'); }
  return data;
}
export function dailyGroups(data) {
  const tf=detectTimeframe(data), expected=tf==='1d'?null:slots(parseInt(tf));
  const groups=[];
  for(let i=0;i<data.length;i++) {
    const r=data[i],day=dayOf(r),factor=r.signal_close===undefined?1:r.signal_close/r.close;
    let g=groups.at(-1);
    if(!g||g.date!==day){g={date:day,open:r.open,high:r.high,low:r.low,close:r.close,volume:0,signal_close:r.signal_close??r.close,signal_high:r.high*factor,signal_low:r.low*factor,startIndex:i,endIndex:i,times:[],halted:r.halted===1?1:0,prev_close:r.prev_close,limit_up:r.limit_up,limit_down:r.limit_down};groups.push(g);}
    g.high=Math.max(g.high,r.high);g.low=Math.min(g.low,r.low);g.close=r.close;g.volume+=r.volume;g.signal_close=r.signal_close??r.close;g.signal_high=Math.max(g.signal_high,r.high*factor);g.signal_low=Math.min(g.signal_low,r.low*factor);g.endIndex=i;g.times.push(r.date.slice(11));
  }
  for(const g of groups){g.complete=tf==='1d'||(g.times.length===expected.length&&g.times.every((t,i)=>t===expected[i]));g.availableAt=g.date+' 15:00';}
  return groups;
}
export function resampleData(data,target) {
  const native=detectTimeframe(data);
  if(native===target)return data;
  if(native==='1d'||native==='15m'&&target==='5m')throw Error(`无法从${periodLabel(native)}生成${periodLabel(target)}；请导入真实 ${target==='5m'?'5':'15'} 分钟行情。`);
  if(target==='1d')return dailyGroups(data).filter(g=>g.complete).map(g=>({...g,halted:g.halted}));
  if(target!=='15m')throw Error('不支持的 K 线周期。');
  const buckets=new Map();
  for(const r of data){const minute=Number(r.date.slice(11,13))*60+Number(r.date.slice(14,16)),end=Math.ceil(minute/15)*15;const key=dayOf(r)+' '+String(Math.floor(end/60)).padStart(2,'0')+':'+String(end%60).padStart(2,'0');if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(r);}
  const out=[];
  for(const[date,rows]of buckets){if(rows.length!==3)continue;const minute=Number(date.slice(11,13))*60+Number(date.slice(14,16));if(!rows.every((r,i)=>Number(r.date.slice(11,13))*60+Number(r.date.slice(14,16))===minute-10+i*5))continue;const first=rows[0],last=rows[2];out.push({...first,date,high:Math.max(...rows.map(r=>r.high)),low:Math.min(...rows.map(r=>r.low)),close:last.close,signal_close:last.signal_close,volume:rows.reduce((s,r)=>s+r.volume,0),halted:first.halted??0});}
  if(out.length<2)throw Error('完整的 15 分钟 K 线不足两根。');
  return out;
}
export function demoData(){let seed=9271,p=24,last=p;const out=[];const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};for(let d=new Date('2022-07-01T00:00:00Z'),i=0;d<=new Date('2025-12-31T00:00:00Z');d.setUTCDate(d.getUTCDate()+1)){if([0,6].includes(d.getUTCDay()))continue;const open=p*(1+(rand()-.5)*.014);p=Math.max(5,open*(1+Math.sin(i/39)*.0035+(rand()-.49)*.037));out.push({date:d.toISOString().slice(0,10),open:+open.toFixed(2),high:+(Math.max(open,p)*(1+rand()*.018)).toFixed(2),low:+(Math.min(open,p)*(1-rand()*.018)).toFixed(2),close:+p.toFixed(2),volume:Math.floor(700000+rand()*4500000),prev_close:+last.toFixed(2),halted:0});last=p;i++;}return out;}
export function demoMinuteData() {
  let seed=19427,price=24,dayIndex=0;const out=[],times=slots(5);
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let d=new Date('2022-07-01T00:00:00Z');d<=new Date('2025-12-31T00:00:00Z');d.setUTCDate(d.getUTCDate()+1)){
    if([0,6].includes(d.getUTCDay()))continue;
    const day=d.toISOString().slice(0,10),prevClose=+price.toFixed(2);price*=1+(rand()-.5)*.014;
    for(const time of times){const open=+price.toFixed(2);price=Math.max(5,price*(1+Math.sin(dayIndex/42)*.0001+(rand()-.5)*.007));const close=+price.toFixed(2);out.push({date:day+' '+time,open,high:+(Math.max(open,close)*(1+rand()*.0015)).toFixed(2),low:+(Math.min(open,close)*(1-rand()*.0015)).toFixed(2),close,volume:Math.floor(12000+rand()*55000),prev_close:prevClose,halted:0});}
    dayIndex++;
  }
  return out;
}
