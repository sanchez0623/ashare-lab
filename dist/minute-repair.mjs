import {auditBundle} from './quality.mjs';
import {slots} from './data.mjs';

export const repairVersion='minute-repair-1';
export const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const rawBar=r=>Object.fromEntries(['date','open','high','low','close','volume','halted'].map(k=>[k,k==='halted'?(r[k]??0):r[k]]));
export const repairScope=b=>b.metadata?.collectionPurpose==='market-data-only'||b.metadata?.universe==='SINGLE_SECURITY'?'single-security':'hs300';
const reject=(code,message)=>{throw Object.assign(Error(message),{code,status:409});};
const byDay=rows=>{const map=new Map();for(const r of rows){const d=r.date.slice(0,10);if(!map.has(d))map.set(d,[]);map.get(d).push(r);}return map;};

// The daily totals are admission checks only, never inputs to a bar correction.
export function verifyMinuteDay(rows,daily){
  const issues=[],grid=slots(5),day=daily?.date;
  if(!daily||daily.halted!==0||!Number.isFinite(daily.volume)||daily.volume<=0)return ['缺少独立有交易日线'];
  if(rows.length!==48||rows.some((r,i)=>r.date!==day+' '+grid[i]))issues.push('不是完整的48根原生5分钟网格');
  if(rows.some(r=>r.halted===1||['open','high','low','close'].some(k=>!Number.isFinite(r[k])||r[k]<=0)||!Number.isFinite(r.volume)||r.volume<0||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.high<r.low))issues.push('OHLC或成交量无效');
  if(rows.length){
    if(Math.abs(rows.at(-1).close-daily.close)>.011)issues.push('末根收盘价与日线不一致');
    if(Math.abs(rows.reduce((s,r)=>s+r.volume,0)-daily.volume)>Math.max(100,daily.volume*.005))issues.push('成交量与日线不一致');
    for(const [field,value] of [['open',rows[0].open],['high',Math.max(...rows.map(r=>r.high))],['low',Math.min(...rows.map(r=>r.low))]])if(Number.isFinite(daily[field])&&Math.abs(value-daily[field])>.011)issues.push(field+'与日线不一致');
  }
  return issues;
}

export function repairPlan(bundle){
  const m=bundle?.metadata;if(m?.synthetic||m?.timeframe!=='5m'||m?.priceBasis!=='raw'||m?.volumeUnit!=='shares')reject('REPAIR_IDENTITY','修复仅接受真实、未复权、股单位的原生5分钟完整数据包。');
  if(m.minuteRepair)reject('REPAIR_PARENT','请使用原始快照发起核验；未完成任务可断点恢复。');
  const report=auditBundle(bundle,{scope:repairScope(bundle)});
  const other=report.issues.filter(x=>!['DAILY_CROSSCHECK','DAILY_OHLC_CROSSCHECK','MINUTE_GAPS'].includes(x.code));
  if(other.length)reject('REPAIR_PREREQUISITES','请先处理非分钟量价问题：'+other.map(x=>x.message).join('；'));
  const grouped=byDay(bundle.bars),days=[];
  for(const d of bundle.daily){if(d.date<m.requested.from||d.date>m.requested.to||d.halted===1)continue;const rows=grouped.get(d.date)??[];
    const n=rows.length,reasons=[];
    if(n!==48)reasons.push('分钟根数');
    if(n&&Math.abs(rows.at(-1).close-d.close)>.011)reasons.push('收盘价');
    if(n===48){for(const [field,value,label] of [['open',rows[0].open,'开盘价'],['high',Math.max(...rows.map(r=>r.high)),'最高价'],['low',Math.min(...rows.map(r=>r.low)),'最低价']])if(Number.isFinite(d[field])&&Math.abs(value-d[field])>.011)reasons.push(label);}
    if(n===48&&Math.abs(rows.reduce((s,r)=>s+r.volume,0)-d.volume)>Math.max(100,d.volume*.005))reasons.push('成交量');
    if(reasons.length)days.push({date:d.date,reasons});
  }
  days.sort((a,b)=>a.date.localeCompare(b.date));
  if(!days.length)reject('REPAIR_NOT_NEEDED','没有需要修复的分钟量价日期。');
  return {version:repairVersion,symbol:m.symbol,requested:m.requested,days,range:{from:days[0].date,to:days.at(-1).date},policy:'whole-day verified native bars only; raw originals retained; no rescale, fill or daily-to-minute reconstruction'};
}

export async function textHash(text){const bytes=new TextEncoder().encode(text);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function repairHash(value){return textHash(stable(value));}

export async function candidateBatch(batch,bundle){
  if(!['mootdx','akshare','sina'].includes(batch?.source)||batch.kind!=='minute5'||batch.symbol!==bundle.metadata.symbol||batch.metadata?.priceBasis!=='raw'||batch.metadata?.nativeTimeframe!=='5m'||!Array.isArray(batch.raw)||!Array.isArray(batch.rows))reject('REPAIR_SOURCE','候选响应来源、证券、原始5分钟口径或原始证据无效。');
  if(typeof batch.rawJSON!=='string'||stable(JSON.parse(batch.rawJSON))!==stable(batch.raw)||await textHash(batch.rawJSON)!==batch.metadata.rawSHA256)reject('REPAIR_HASH','候选原始响应哈希不符，拒绝使用。');
  if(!batch.requested||batch.requested.from>batch.requested.to||typeof batch.requested.from!=='string'||typeof batch.requested.to!=='string')reject('REPAIR_RANGE','候选原始响应缺少有效请求范围。');
  const reconstructed=batch.raw.map(r=>batch.source==='akshare'?{date:String(r['时间']).replace('T',' ').slice(0,16),open:r['开盘'],high:r['最高'],low:r['最低'],close:r['收盘'],volume:r['成交量']}:{date:String(r.datetime??r.day??r.date).replace('T',' ').slice(0,16),open:r.open,high:r.high,low:r.low,close:r.close,volume:r.vol??r.volume}).filter(r=>r.date.slice(0,10)>=batch.requested.from&&r.date.slice(0,10)<=batch.requested.to).map(r=>({...r,...Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,Number(r[k])*(k==='volume'&&batch.source==='akshare'?100:1)]))})).sort((a,b)=>a.date.localeCompare(b.date));
  if(stable(reconstructed)!==stable(batch.rows))reject('REPAIR_DERIVATION','候选K线不能由原始响应无损推导，拒绝手工改价或改量。');
  if(new Set(reconstructed.map(r=>r.date)).size!==reconstructed.length)reject('REPAIR_DUPLICATE','第二源含重复分钟时间，拒绝拼接。');
  if(!reconstructed.length){const retained=batch.raw.map(r=>String(r.datetime??r.day??r.date??r['时间']??'').replace('T',' ').slice(0,16)).filter(Boolean).sort();reject('REPAIR_COVERAGE','第二源没有返回请求区间的分钟数据'+(retained.length?'；实际保存范围 '+retained[0]+' — '+retained.at(-1):'；原始响应也为空'));}
  let multiplier=1,calibration=[];
  if(batch.source==='mootdx'){
    // Only categorical share/lot conversion is allowed. Never fit an arbitrary
    // daily multiplier, or use today's total to rewrite earlier intraday bars.
    const days=byDay(reconstructed),fits=[1,100].map(scale=>({scale,days:bundle.daily.filter(d=>verifyMinuteDay((days.get(d.date)??[]).map(r=>({...r,volume:r.volume*scale})),d).length===0).map(d=>d.date)})).filter(x=>x.days.length>=5);
    if(fits.length!==1)reject('REPAIR_UNIT','通达信成交量单位不能在至少5个独立完整交易日唯一核验为股/手；不猜测或按日缩放。');
    multiplier=fits[0].scale;calibration=fits[0].days;
  }else if(batch.metadata.volumeUnit!=='shares')reject('REPAIR_UNIT','候选分钟成交量未声明股单位。');
  return {source:batch.source,rows:reconstructed.map(r=>({...rawBar(r),volume:r.volume*multiplier})),rawSHA256:batch.metadata.rawSHA256,multiplier,calibration,proof:batch};
}

export async function makeRepair(bundle,baseSnapshotId,batches){
  if(!/^[a-f0-9]{64}$/.test(baseSnapshotId))reject('REPAIR_PARENT','原快照编号无效。');
  const plan=repairPlan(bundle),originals=byDay(bundle.bars),daily=new Map(bundle.daily.map(r=>[r.date,r])),choices=new Map(),attempts=[];
  for(const batch of batches){let verified;try{verified=await candidateBatch(batch,bundle);}catch(e){attempts.push({source:batch?.source,code:e.code??'REPAIR_SOURCE',message:e.message});continue;}
    const grouped=byDay(verified.rows),accepted=[],rejected=[];
    for(const day of plan.days){if(choices.has(day.date))continue;const rows=grouped.get(day.date)??[],issues=verifyMinuteDay(rows,daily.get(day.date));if(issues.length)rejected.push({date:day.date,issues});else{choices.set(day.date,{...verified,rows});accepted.push(day.date);}}
    const retained=batch.raw.map(r=>String(r.datetime??r.day??r.date??r['时间']??'').replace('T',' ').slice(0,16)).filter(Boolean).sort();
    attempts.push({source:verified.source,rawSHA256:verified.rawSHA256,unitMultiplier:verified.multiplier,calibrationDays:verified.calibration,accepted,rejected,actual:{from:verified.rows[0]?.date??null,to:verified.rows.at(-1)?.date??null},providerRetainedRange:{from:retained[0]??null,to:retained.at(-1)??null}});
  }
  const unresolved=plan.days.filter(d=>!choices.has(d.date)),evidence=[];
  for(const day of plan.days){const v=choices.get(day.date);if(v)evidence.push({date:day.date,source:v.source,unitMultiplier:v.multiplier,rawSHA256:v.rawSHA256,originalBars:(originals.get(day.date)??[]).map(rawBar),originalSHA256:await repairHash((originals.get(day.date)??[]).map(rawBar)),replacementSHA256:await repairHash(v.rows)});}
  const report={version:repairVersion,baseSnapshotId,symbol:plan.symbol,requested:plan.requested,targetDays:plan.days.length,verifiedDays:evidence.length,unresolved,attempts,status:unresolved.length?'blocked':'passed',policy:plan.policy};
  if(unresolved.length)return {report,bundle:null};
  const repaired=structuredClone(bundle);repaired.bars=bundle.bars.flatMap(r=>{const v=choices.get(r.date.slice(0,10));if(!v)return [r];return r.date===originals.get(r.date.slice(0,10))[0].date?v.rows:[];});
  repaired.metadata.source='verified-minute-repair';repaired.metadata.primarySource=bundle.metadata.source;
  repaired.metadata.minuteRepair={version:repairVersion,baseSnapshotId,status:'verified',policy:plan.policy,days:evidence,report,originalParquetArchive:bundle.metadata.parquetArchive??null};delete repaired.metadata.parquetArchive;
  repaired.metadata.provenance={...repaired.metadata.provenance,minuteRepair:{baseSnapshotId,sources:attempts.filter(x=>x.accepted?.length).map(x=>({source:x.source,rawSHA256:x.rawSHA256,unitMultiplier:x.unitMultiplier}))}};
  const audit=auditBundle(repaired,{scope:repairScope(repaired)});if(audit.status!=='passed')reject('REPAIR_ADMISSION','修复后仍未通过完整数据校验：'+audit.issues.map(x=>x.message).join('；'));
  return {report,bundle:repaired,audit};
}

export async function verifyRepairSnapshot(bundle){
  const proof=bundle.metadata?.minuteRepair;if(!proof)return;
  if(bundle.metadata.source!=='verified-minute-repair'||!bundle.metadata.primarySource||!/^[a-f0-9]{64}$/.test(proof.baseSnapshotId??'')||proof.version!==repairVersion||proof.status!=='verified'||!proof.days?.length||new Set(proof.days.map(x=>x.date)).size!==proof.days.length||proof.report&&(proof.report.status!=='passed'||proof.report.unresolved?.length))reject('REPAIR_PROOF','修复快照缺少有效逐日证据。');
  const grouped=byDay(bundle.bars),daily=new Map(bundle.daily.map(r=>[r.date,r]));
  for(const d of proof.days){if(!['mootdx','akshare','sina'].includes(d.source)||![1,100].includes(d.unitMultiplier)||!/^[a-f0-9]{64}$/.test(d.rawSHA256??'')||await repairHash(d.originalBars)!==d.originalSHA256||await repairHash((grouped.get(d.date)??[]).map(rawBar))!==d.replacementSHA256||verifyMinuteDay(grouped.get(d.date)??[],daily.get(d.date)).length)reject('REPAIR_PROOF','逐日修复证据或量价核验不符：'+d.date);}
}
