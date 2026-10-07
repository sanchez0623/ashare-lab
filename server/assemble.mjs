import {auditBundle,isAuditAdmitted} from '../dist/quality.mjs';
import {reconciliationReport} from '../dist/reconciliation.mjs';
import {verifyRepairSnapshot,rawBar,stable} from '../dist/minute-repair.mjs';
export const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=(code,message,details)=>{throw Object.assign(Error(message),{code,status:409,details});};
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const between=(day,range)=>day>=range.from&&day<=range.to;
const dayAfter=day=>new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const without=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k)));
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function admit(map,key,row,label){const prior=map.get(key);if(prior&&canonical(prior)!==canonical(row))fail('ASSEMBLY_CONFLICT',`${label}在重叠日期存在冲突：${key}。请核验并补采冲突日期，系统不会默选一份。`,{date:key});if(!prior)map.set(key,row);}

export function assembleBundles(parents,{symbol,from,to,warmupSessions=60},{verifiedRepairs=new Set()}={}){
  if(!/^[0-9]{6}$/.test(symbol??'')||!date(from)||!date(to)||from>=to||!Number.isInteger(warmupSessions)||warmupSessions<60||warmupSessions>1000)fail('ASSEMBLY_REQUEST','合并代码、日期或预热要求无效。');
  if(!parents.length)fail('ASSEMBLY_COVERAGE',`${symbol} 没有覆盖 ${from} — ${to} 的本地行情快照。请补采对应区间和预热历史。`);
  parents=[...parents].sort((a,b)=>a.id.localeCompare(b.id));const base=parents[0].bundle.metadata;
  const primarySource=base.primarySource??base.source,overrides=new Map();
  for(const p of parents)if(p.bundle.metadata.minuteRepair){
    if(!verifiedRepairs.has(p.id))fail('ASSEMBLY_REPAIR_PROOF','修复快照必须先独立核验逐日证据，不接受未经核验的覆盖。');
    for(const proof of p.bundle.metadata.minuteRepair.days){const replacement=p.bundle.bars.filter(r=>r.date.slice(0,10)===proof.date).map(rawBar),prior=overrides.get(proof.date);
      if(prior&&stable(prior.replacement)!==stable(replacement))fail('ASSEMBLY_CONFLICT','第二源修复证据相互冲突：'+proof.date);
      if(!prior)overrides.set(proof.date,{proof,replacement,original:new Map(proof.originalBars.map(r=>[r.date,rawBar(r)])),selected:new Map(replacement.map(r=>[r.date,r]))});
    }
  }
  const calendars=new Set(),calendarIndexes=new Map(),daily=new Map(),bars=new Map(),actions=new Map(),factors=new Map(),universe=new Map();
  for(const {id,bundle:b} of parents){
    const m=b?.metadata,r=m?.requested;
    if(m?.primarySource&&m.primarySource!==m.source&&!m.minuteRepair)fail('ASSEMBLY_REPAIR_PROOF','不同来源不能仅声明primarySource就覆盖原始数据，需完整第二源修复证据。');
    if(!/^[a-f0-9]{64}$/.test(id)||b.schemaVersion!==1||m?.symbol!==symbol||m.timeframe!=='5m'||m.priceBasis!=='raw'||m.volumeUnit!=='shares'||m.timezone!=='Asia/Shanghai'||m.timestampConvention!=='bar-close'||m.board!==base.board||(m.primarySource??m.source)!==primarySource||m.listedDate!==base.listedDate||!!m.synthetic!==!!base.synthetic||!date(r?.from)||!date(r?.to))fail('ASSEMBLY_IDENTITY','只能合并同证券、同原始来源或已核验第二源修复、同板块和同原始5分钟口径的快照；演示与真实数据不能混合。');
    for(const key of ['calendar','daily','actions','factors']){const p=m.coverage?.[key];if(p?.status!=='complete'||!date(p.from)||!date(p.to)||p.from>r.from||p.to<r.to||!p.source)fail('ASSEMBLY_PROOF','快照缺少完整'+key+'覆盖证明：'+id.slice(0,12));}
    calendarIndexes.set(id,new Set(b.calendar??[]));for(const day of b.calendar??[])if(day<=to)calendars.add(day);
    for(const row of b.daily??[])if(between(row.date,r)&&row.date<=to)admit(daily,row.date,without(row,['causalFactor']), '独立日线、ST或停牌资料');
    for(const row of b.bars??[])if(between(row.date?.slice(0,10),r)&&row.date.slice(0,10)<=to){let raw=rawBar(row);const repair=overrides.get(row.date.slice(0,10));
      if(repair){const selected=repair.selected.get(row.date),original=repair.original.get(row.date);if(stable(raw)!==stable(selected)&&stable(raw)!==stable(original))fail('ASSEMBLY_CONFLICT','分钟修订与已核验修复的原始证据不符：'+row.date);raw=selected;}
      admit(bars,row.date,raw,'原始分钟行情');}
    for(const row of b.actions??[])if(between(row.exDate,r)&&row.exDate<=to){const value=without(row,['id']);admit(actions,row.exDate+'|'+(row.type??'dividend'),value,'公司行动');}
    // Forward factors change when later events arrive and are never used here.
    for(const row of b.factors??[]){const day=row.dividOperateDate??row.exDate;if(between(day,r)&&day<=to)admit(factors,day,without(row,['foreAdjustFactor']),'后复权事件因子');}
    if(m.universe==='HS300')for(const row of b.universe??[])if(between(row.date,r)&&row.date<=to)admit(universe,row.date,{...row,codes:[...row.codes].sort()},'历史沪深300名单');
  }
  const calendar=[...calendars].sort();if(calendar.some(d=>!date(d)))fail('ASSEMBLY_CALENDAR','源快照含无效交易日历日期。');
  const prior=calendar.filter(d=>d<from&&d>=base.listedDate);if(prior.length<warmupSessions)fail('ASSEMBLY_WARMUP',`现有快照的交易日历无法定位${warmupSessions}个预热交易日，请补采更早历史。`);
  const start=prior.at(-warmupSessions),range={from:start,to};
  const covering=(key,day)=>parents.filter(({bundle:b})=>{const p=b.metadata.coverage[key];return p.status==='complete'&&between(day,p)&&between(day,b.metadata.requested);});
  for(let day=start;day<=to;day=dayAfter(day)){
    for(const key of ['calendar','daily','actions','factors'])if(!covering(key,day).length)fail('ASSEMBLY_COVERAGE',`${symbol} 没有覆盖 ${from} — ${to} 的完整本地行情；${key}首个缺口 ${day}，需补采该区间和预热。`,{day,key});
    const observations=covering('calendar',day).map(p=>calendarIndexes.get(p.id).has(day));if(observations.some(v=>v!==observations[0]))fail('ASSEMBLY_CALENDAR','交易日历在重叠日期存在冲突：'+day);
  }
  const dayRows=[...daily.values()].filter(r=>between(r.date,range)).sort((a,b)=>a.date.localeCompare(b.date));let factor=1,previous=null;
  for(const d of dayRows){if(d.halted!==1){if(previous&&d.prev_close>0)factor*=previous/d.prev_close;previous=d.close;}d.causalFactor=factor;}
  const hs300=parents.every(({bundle:b})=>b.metadata.universe==='HS300');
  const metadata={symbol,name:base.name??'',board:base.board,source:base.source,timeframe:'5m',listedDate:base.listedDate,priceBasis:'raw',volumeUnit:'shares',timezone:'Asia/Shanghai',timestampConvention:'bar-close',requested:range,research:{from,to,warmupSessions},universe:hs300?'HS300':'SINGLE_SECURITY',universePolicy:hs300?'weekly-asof-next-session':'not-requested',coverage:Object.fromEntries(['calendar','daily','actions','factors'].map(k=>[k,{status:'complete',from:start,to,source:'verified parent snapshots; assembled and re-audited'}])),assembly:{version:1,parents:parents.map(p=>p.id),policy:'raw-union; overlap-equality; causal chain rebuilt from chronological daily references'},provenance:{assemblerVersion:1,parents:parents.map(p=>({snapshotId:p.id,providerEvidence:p.bundle.metadata.provenance??null}))}};
  const repairs=[...overrides.values()].filter(x=>between(x.proof.date,range));if(repairs.length){metadata.source='verified-minute-repair';metadata.primarySource=primarySource;metadata.minuteRepair={version:'minute-repair-1',status:'verified',baseSnapshotId:parents.find(p=>p.bundle.metadata.minuteRepair)?.bundle.metadata.minuteRepair.baseSnapshotId,policy:'verified whole-day replacement; only matching original/replacement candles may overlap',days:repairs.map(x=>x.proof)};}
  if(base.synthetic)metadata.synthetic=true;if(!hs300)metadata.collectionPurpose='market-data-only';
  // Keep the full calendar for listing age. A supplied historical offset must
  // refer to this calendar's first date, rather than to a later fragment.
  if(!calendar.includes(base.listedDate)){
    const offsets=parents.filter(p=>Number.isInteger(p.bundle.metadata.listingSessionOffset)).map(p=>p.bundle.metadata.listingSessionOffset-calendar.filter(d=>d>=base.listedDate&&d<p.bundle.calendar[0]).length);
    if(!offsets.length||new Set(offsets).size!==1||offsets[0]<0)fail('ASSEMBLY_LISTING_AGE','无法统一上市交易日偏移，请补齐上市以来的交易日历。');metadata.listingSessionOffset=offsets[0];
  }
  metadata.coverage.universe=hs300?{status:'complete',from:start,to,source:'verified historical member parent snapshots'}:{status:'not-requested',reason:'仅研究指定证券，不证明历史沪深300成员'};
  metadata.providerDuplicates=parents.flatMap(p=>p.bundle.metadata.providerDuplicates??[]).filter(d=>typeof d!=='string'||between(d.slice(0,10),range));
  metadata.conflicts=parents.flatMap(p=>p.bundle.metadata.conflicts??[]).filter(d=>!d.date||between(d.date.slice(0,10),range));
  const bundle={schemaVersion:1,metadata,calendar,daily:dayRows,bars:[...bars.values()].filter(r=>between(r.date.slice(0,10),range)).sort((a,b)=>a.date.localeCompare(b.date)),actions:[...actions.values()].filter(r=>between(r.exDate,range)).sort((a,b)=>a.exDate.localeCompare(b.exDate)).map((r,i)=>({...r,id:symbol+'-'+r.exDate+'-'+i})),factors:[...factors.values()].filter(r=>between(r.dividOperateDate??r.exDate,range)).sort((a,b)=>(a.dividOperateDate??a.exDate).localeCompare(b.dividOperateDate??b.exDate)),universe:hs300?[...universe.values()].filter(r=>between(r.date,range)).sort((a,b)=>a.date.localeCompare(b.date)):[]};
  if(bundle.bars.length>120000)fail('ASSEMBLY_SIZE','合并快照超过120,000根行情，请缩小区间。');
  const report=auditBundle(bundle,{scope:hs300?'hs300':'single-security'});if(!isAuditAdmitted(report)){
    const reconciliation=reconciliationReport(bundle,report,parents),detail=reconciliation?.summary;
    const explanation=detail?`量价不一致 ${detail.failedChecks} 项，涉及 ${detail.affectedDays} 日：收盘价 ${detail.priceChecks} 项、成交量 ${detail.volumeChecks} 项${detail.openChecks||detail.highChecks||detail.lowChecks?`、开盘 ${detail.openChecks} 项、最高 ${detail.highChecks} 项、最低 ${detail.lowChecks} 项`:''}。${detail.sourceMismatchDays?`${detail.sourceMismatchDays} 日的差异在原快照中已存在。`:''}请下载量价核验报告查看日期和原始值，或在本地“分钟第二源核验 / 修复”中核验原始快照；暂不需要重复采集整段历史。`:'请核对对应日期资料。';
    fail('ASSEMBLY_ADMISSION','已有数据合并后仍未通过完整性校验：'+report.blockingIssues.map(i=>i.message+'（'+i.count+'）').join('；')+'。'+explanation,{issues:report.issues,reconciliation});
  }
  return {bundle,report};
}

export async function assembleStored(bucket,input){
  if(!Array.isArray(input?.snapshots))fail('ASSEMBLY_REQUEST','合并来源须为快照编号列表。');
  const ids=[...new Set(input.snapshots??[])];if(!ids.length||ids.length>64||ids.some(id=>!(/^[a-f0-9]{64}$/.test(id))))fail('ASSEMBLY_REQUEST','需提供1至64个有效来源快照编号。');
  const parents=[];let total=0;
  for(const id of ids){const obj=await bucket.get('snapshots/'+id+'.json');if(!obj)fail('ASSEMBLY_MISSING','来源快照不存在：'+id.slice(0,12));const bytes=new Uint8Array(await new Response(obj.body).arrayBuffer());total+=bytes.length;if(total>40*1024*1024)fail('ASSEMBLY_SIZE','来源快照合计超过40MB，请减少区间或来源数量。');if(await sha256(bytes)!==id)fail('SNAPSHOT_HASH','来源快照SHA-256不符，已拒绝合并：'+id.slice(0,12));parents.push({id,bundle:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))});}
  const verifiedRepairs=new Set();for(const p of parents)if(p.bundle.metadata.minuteRepair){await verifyRepairSnapshot(p.bundle);verifiedRepairs.add(p.id);}
  const {bundle,report}=assembleBundles(parents,input,{verifiedRepairs}),bytes=new TextEncoder().encode(canonical(bundle));if(bytes.length>25*1024*1024)fail('ASSEMBLY_SIZE','合并快照超过25MB，请缩小区间。');
  const id=await sha256(bytes),key='manifests/'+id+'.json',existing=await bucket.get(key);if(existing){const saved=await bucket.get('snapshots/'+id+'.json');if(!saved||await sha256(new Uint8Array(await new Response(saved.body).arrayBuffer()))!==id)fail('SNAPSHOT_HASH','已保存的合并快照哈希不符。');return {...await existing.json(),report,reused:true};}
  const m=bundle.metadata,manifest={id,symbol:m.symbol,name:m.name,board:m.board,timeframe:m.timeframe,source:m.source,research:m.research,assembly:m.assembly,...(m.minuteRepair?{minuteRepair:{baseSnapshotId:m.minuteRepair.baseSnapshotId,verifiedDays:m.minuteRepair.days.length}}:{}),syncedAt:new Date().toISOString(),bytes:bytes.length,report};
  await bucket.put('snapshots/'+id+'.json',bytes,{httpMetadata:{contentType:'application/json'}});const stored=await bucket.get('snapshots/'+id+'.json');if(!stored||await sha256(new Uint8Array(await new Response(stored.body).arrayBuffer()))!==id)fail('SNAPSHOT_HASH','合并快照写入后哈希核对失败。');
  await bucket.put(key,canonical(manifest),{httpMetadata:{contentType:'application/json'}});return manifest;
}
