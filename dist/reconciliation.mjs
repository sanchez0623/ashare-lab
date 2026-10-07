// Diagnostic values only: auditBundle remains the authority for admission.
const finite=v=>Number.isFinite(v)?v:null;
function index(bundle){
  const days=new Map();
  for(const r of bundle.bars??[]){const day=r.date?.slice(0,10);let g=days.get(day);if(!g){g={bars:0,lastTime:null,close:null,volume:0,open:finite(r.open),high:r.high,low:r.low};days.set(day,g);}g.bars++;g.lastTime=r.date;g.close=finite(r.close);g.volume+=r.volume;g.high=Math.max(g.high,r.high);g.low=Math.min(g.low,r.low);}
  return {days,daily:new Map((bundle.daily??[]).map(d=>[d.date,d])),expected:({'1d':1,'15m':16,'5m':48})[bundle.metadata.timeframe]};
}
function compare(day,idx){
  const minute=idx.days.get(day),daily=idx.daily.get(day);if(!daily)return null;
  const close=finite(daily.close),volume=finite(daily.volume),minuteVolume=finite(minute?.volume),minuteClose=finite(minute?.close);
  const priceDelta=close===null||minuteClose===null?null:minuteClose-close;
  const volumeDelta=volume===null||minuteVolume===null?null:minuteVolume-volume;
  const volumeTolerance=volume===null?null:Math.max(100,volume*.005);
  return {date:day,bars:minute?.bars??0,lastBarTime:minute?.lastTime??null,halted:daily.halted,
    ...Object.fromEntries(['open','high','low'].map(k=>{const a=finite(minute?.[k]),b=finite(daily[k]),difference=a===null||b===null?null:a-b;return [k,{minute:a,daily:b,difference,tolerance:.011,checked:daily.halted!==1&&b!==null&&minute?.bars===idx.expected,passed:difference!==null&&Math.abs(difference)<=.011}];})),
    close:{minute:minuteClose,daily:close,difference:finite(priceDelta),tolerance:.011,checked:daily.halted!==1&&(close===null||close<=0||!!minute),passed:close!==null&&close>0&&(minuteClose===null||Math.abs(priceDelta)<=.011)},
    volume:{minute:minuteVolume,daily:volume,difference:finite(volumeDelta),tolerance:volumeTolerance,ratio:volume>0&&minuteVolume!==null?minuteVolume/volume:null,checked:daily.halted!==1&&daily.volume!==undefined&&minute?.bars===idx.expected,passed:volumeDelta!==null&&Math.abs(volumeDelta)<=volumeTolerance}};
}
export function reconciliationReport(bundle,report,parents=[]){
  const issues=report.issues.filter(i=>['DAILY_CROSSCHECK','DAILY_OHLC_CROSSCHECK'].includes(i.code));if(!issues.length)return null;
  const idx=index(bundle),parentIndexes=parents.map(p=>({id:p.id,bundle:p.bundle,index:index(p.bundle)}));
  const rows=[];
  for(const date of bundle.calendar??[]){
    const range=bundle.metadata.requested;if(date<range.from||date>range.to||date<bundle.metadata.listedDate||bundle.metadata.delistedDate&&date>bundle.metadata.delistedDate)continue;
    const row=compare(date,idx);if(!row)continue;
    const failed=['open','high','low','close','volume'].filter(k=>row[k].checked&&!row[k].passed);if(!failed.length)continue;
    row.metrics=failed;row.parents=parentIndexes.map(p=>{const r=p.bundle.metadata.requested;if(date<r.from||date>r.to)return null;const value=compare(date,p.index);return value?{snapshotId:p.id,...value}:null;}).filter(Boolean);
    row.origin=failed.every(k=>row.parents.some(p=>p[k].checked&&!p[k].passed&&p[k].minute===row[k].minute&&p[k].daily===row[k].daily))?'source-snapshot':row.parents.length?'assembly-only':'unknown';
    rows.push(row);
  }
  return {schemaVersion:1,kind:'minute-daily-reconciliation',symbol:bundle.metadata.symbol,source:bundle.metadata.source,
    requested:bundle.metadata.requested,research:bundle.metadata.research??null,priceBasis:bundle.metadata.priceBasis,volumeUnit:bundle.metadata.volumeUnit,timeframe:bundle.metadata.timeframe,
    thresholds:{closeAbsolute:.011,volumeAbsoluteMinimum:100,volumeRelative:.005},
    summary:{failedChecks:issues.reduce((s,i)=>s+i.count,0),affectedDays:rows.length,priceChecks:rows.filter(r=>r.metrics.includes('close')).length,openChecks:rows.filter(r=>r.metrics.includes('open')).length,highChecks:rows.filter(r=>r.metrics.includes('high')).length,lowChecks:rows.filter(r=>r.metrics.includes('low')).length,volumeChecks:rows.filter(r=>r.metrics.includes('volume')).length,sourceMismatchDays:rows.filter(r=>r.origin==='source-snapshot').length,assemblyOnlyDays:rows.filter(r=>r.origin==='assembly-only').length},
    parents:parents.map(p=>({snapshotId:p.id,source:p.bundle.metadata.source,requested:p.bundle.metadata.requested,priceBasis:p.bundle.metadata.priceBasis,volumeUnit:p.bundle.metadata.volumeUnit,timeframe:p.bundle.metadata.timeframe})),issues:report.issues,rows};
}
