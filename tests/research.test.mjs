import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ResearchManager,normalizeRequest,acceptanceAudit,canonical,hash,auditAccounting} from '../server/research.mjs';
import {FileBucket,startLocal} from '../scripts/local-server.mjs';
import worker from '../server/worker.mjs';
import {fixture,withEvent} from './fixture.mjs';

const dataset=()=>withEvent(fixture(360),160,{cash:.1,bonus:.05});
const input=b=>({symbol:'600519',to:b.calendar.at(-1),config:{timeframe:'5m',dailyFast:5,dailySlow:20,breakout:2,confirmationDays:1,maxExtensionATR:10,fast:2,slow:3}});
async function until(manager,id,status=['completed','blocked','failed']){for(let i=0;i<200;i++){const j=manager.jobs.get(id);if(status.includes(j.status))return j;await new Promise(r=>setTimeout(r,50));}throw Error('任务超时');}
async function setup(collector){const dir=await mkdtemp(path.join(tmpdir(),'ashare-research-'));const bucket=new FileBucket(path.join(dir,'warehouse'));const manager=await new ResearchManager({root:path.join(dir,'research'),bucket,collector}).init();return {dir,bucket,manager};}

test('research dates preserve the year default and accept explicit or inferred custom intervals',()=>{
 const req={symbol:'600519',to:'2026-09-30'};
 assert.equal(normalizeRequest(req).from,'2025-10-01');assert.equal(normalizeRequest(req).rangeMode,'year');
 assert.equal(normalizeRequest({...req,to:'2024-02-29'}).from,'2023-03-01');
 for(const from of ['2026-09-01','2024-01-01']){
  const custom=normalizeRequest({...req,from,rangeMode:'custom'});assert.equal(custom.from,from);assert.equal(custom.config.from,from);assert.equal(custom.config.to,req.to);assert.equal(custom.warmupSessions,60);
  assert.deepEqual(normalizeRequest({...req,from}),custom);
 }
 for(const change of [{rangeMode:'custom'},{from:'2026-02-30'},{from:'2026-10-01'},{from:req.to},{rangeMode:'all'},{rangeMode:'year',from:'2024-01-01'},{from:''},{from:null},{to:'2026-13-01'}])assert.throws(()=>normalizeRequest({...req,...change}),e=>e.code==='REQUEST');
 const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);assert.throws(()=>normalizeRequest({...req,to:today}),/北京时间今天/);
 assert.equal(normalizeRequest({...req,from:'2024-01-01',config:{dailySlow:120}}).warmupSessions,120);
 const extended=normalizeRequest({...req,rangeMode:'custom',from:'2024-01-01',warmupSessions:125});assert.equal(extended.warmupSessions,125);assert.equal(extended.config.dailySlow,60);assert.equal(extended.from,'2024-01-01');assert.equal(extended.to,req.to);
 for(const warmupSessions of [59,60.5,1001,'90',null]){if(warmupSessions===null)continue;assert.throws(()=>normalizeRequest({...req,warmupSessions}),/预热交易日/);}
 assert.throws(()=>normalizeRequest({...req,config:{dailySlow:120},warmupSessions:90}),/120/);
});
test('collection-only persists raw data without membership or backtest; formal admission remains strict',async()=>{
 const b=dataset();b.universe=[];b.metadata.universe='SINGLE_SECURITY';b.metadata.coverage.universe={status:'not-requested'};
 let runs=0;const ctx=await setup(async()=>b);ctx.manager.runner=async()=>{runs++;throw Error('仅采集不可回测');};
 try{
  const req={...input(b),purpose:'collect'},j=await ctx.manager.create(req),done=await until(ctx.manager,j.id);
  assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(runs,0);assert.equal(done.quality.status,'passed');assert.equal(done.quality.scope,'market-data-only');assert.ok(done.snapshotId);
  const report=JSON.parse(await ctx.manager.report(done));assert.equal(report.collection.membershipChecked,false);assert.equal(report.result,undefined);assert.equal(report.timing,undefined);
  const replay=await ctx.manager.repeat(done.id),again=await until(ctx.manager,replay.id);assert.equal(again.reportHash,done.reportHash);
  const formal=await ctx.manager.create(input(b)),blocked=await until(ctx.manager,formal.id);assert.equal(blocked.status,'blocked');assert.ok(blocked.quality.issues.some(i=>i.code==='HISTORICAL_MEMBER'));
  // Gaps remain visible and raw evidence downloadable in collection-only mode.
  b.bars=b.bars.filter(r=>!r.date.startsWith(b.calendar[180]));const incomplete=await ctx.manager.create(req),saved=await until(ctx.manager,incomplete.id);
  assert.equal(saved.status,'completed');assert.equal(saved.quality.status,'blocked');assert.ok(saved.quality.issues.some(i=>i.code==='MISSING_DAYS'));assert.ok(saved.snapshotId);assert.equal(runs,0);
  assert.throws(()=>normalizeRequest({...req,purpose:'unknown'}),e=>e.code==='REQUEST');
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('background research saves and reproduces warning-only data without claiming it was repaired',async()=>{
 const b=dataset(),day=b.calendar[180];for(const r of b.bars)if(r.date.startsWith(day))r.volume*=1.01;const before=canonical(b),ctx=await setup(async()=>b);
 try{const j=await ctx.manager.create(input(b)),done=await until(ctx.manager,j.id);assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(done.quality.status,'warning');const report=JSON.parse(await ctx.manager.report(done));assert.equal(report.quality.warningCount,1);assert.equal(report.result.audit.qualityReport.status,'warning');assert.ok(report.result.warnings.some(w=>w.includes('未修复')));assert.equal(report.reproducibility.status,'passed');assert.equal(report.accounting.status,'passed');assert.equal(report.acceptance,'synthetic-test-only');assert.equal(canonical(b),before);const replay=await ctx.manager.repeat(done.id),again=await until(ctx.manager,replay.id);assert.equal(again.reportHash,done.reportHash);
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('job timing and query diagnostics persist over pause/restart and stay separate from result reports',async()=>{
 const b=dataset(),dir=await mkdtemp(path.join(tmpdir(),'ashare-timing-')),bucket=new FileBucket(path.join(dir,'warehouse'));let tick=100000,waiting=true;
 const collect=async(_r,_p,signal,progress)=>{
  tick+=2000;await progress({query:['minute','month'],phase:'query-complete',queryElapsedMs:2000,requests:2,rateWaitMs:1000,rows:10,checkpoints:1});
  if(waiting)await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('暂停'),{code:'PAUSED'})),{once:true}));return b;
 };
 let m=await new ResearchManager({root:path.join(dir,'research'),bucket,collector:collect,clock:()=>tick}).init();
 try{
  const j=await m.create({...input(b),purpose:'collect'});for(let i=0;i<100&&!m.jobs.get(j.id).progress;i++)await new Promise(r=>setTimeout(r,10));
  tick+=3000;const paused=await m.pause(j.id);assert.equal(paused.timing.activeMs,5000);assert.equal(paused.timing.runs[0].stopReason,'paused');await m.close();
  const statePath=m.location(j.id,'state.json'),state=JSON.parse(await readFile(statePath,'utf8'));assert.equal(state.timing.activeMs,5000);
  tick+=86400000;waiting=false;m=await new ResearchManager({root:path.join(dir,'research'),bucket,collector:collect,clock:()=>tick}).init();assert.equal(m.view(m.jobs.get(j.id)).timing.activeMs,5000);
  await m.resume(j.id);const done=await until(m,j.id);assert.equal(done.timing.activeMs,7000);assert.equal(done.timing.runs.length,2);assert.equal(done.queryTiming.minute.rateWaitMs,2000);assert.equal(done.queryTiming.minute.requests,4);
  const response=await m.fetch(new Request('http://localhost/api/research/jobs/'+j.id+'/timing')),log=await response.json();assert.equal(log.timing.activeMs,7000);assert.ok(log.events.some(e=>e.message.includes('查询完成')));assert.ok(log.events.every(e=>typeof e.activeMs==='number'));
  const report=JSON.parse(await m.report(done));assert.equal(report.timing,undefined);assert.equal(report.result,undefined);
 }finally{await m.close();await rm(dir,{recursive:true,force:true});}
});
test('collection snapshots and reviewed checkpoints survive an engine-only upgrade; formal reports remain pinned',async()=>{
 const b=dataset(),ctx=await setup(async()=>b),currentEngine=ctx.manager.fingerprint;
 try{
  ctx.manager.fingerprint=hash('previous strategy engine');ctx.manager.pipelineFingerprint='42a250326c788ca9a1b81e818537396179b2d6b2b3ad822dee6f44493bd333e9';
  const j=await ctx.manager.create({...input(b),purpose:'collect'}),done=await until(ctx.manager,j.id);assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(done.engineHash,ctx.manager.fingerprint);assert.equal(done.pipelineMigrations.length,1);
  ctx.manager.fingerprint=currentEngine;const replay=await ctx.manager.repeat(done.id),again=await until(ctx.manager,replay.id);assert.equal(again.reportHash,done.reportHash);
  ctx.manager.fingerprint=hash('previous strategy engine');
  const formal=await ctx.manager.create(input(b)),blocked=await until(ctx.manager,formal.id);assert.equal(blocked.error.code,'ENGINE_CHANGED');assert.equal(blocked.snapshotId,undefined);
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('only the reviewed legacy pipeline can migrate and reuse original research checkpoints',async()=>{
 const b=dataset(),ctx=await setup(async()=>b);
 try{
  ctx.manager.pipelineFingerprint='5ba9106a87d7f621d730eb8366b486f172862bb0950bc1afc326410e1fa83967';
  const j=await ctx.manager.create(input(b)),done=await until(ctx.manager,j.id);assert.equal(done.status,'completed',JSON.stringify(done.error));
  assert.equal(done.pipelineMigrations.length,1);assert.notEqual(done.pipelineHash,ctx.manager.pipelineFingerprint);
  for(const legacy of ['29824a5da745fb0d388a82719a4c4ff0c3b0bb3de81b5dc25a61a44ba4d0e36c','2919a15466915f406402cc68147bcfcbb2abcfd156dd7fd787ce8a53bbcf5942']){
   ctx.manager.pipelineFingerprint=legacy;
   const raw=await ctx.manager.create({...input(b),purpose:'collect'}),collected=await until(ctx.manager,raw.id);assert.equal(collected.status,'completed');assert.equal(collected.pipelineMigrations.length,1);assert.equal(collected.request.purpose,'collect');assert.equal(collected.pipelineMigrations[0].from,legacy);
  }
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('a blocked report remains downloadable but belongs to the previous attempt after resume',async()=>{
 const b=dataset();let first=true;
 const ctx=await setup(async(_r,_p,signal,progress)=>{
  if(first){first=false;throw Error('模拟断网');}
  await progress({collectionRange:{from:b.metadata.requested.from,to:b.calendar.at(-1),researchFrom:input(b).to,warmupSessions:60}});
  if(signal.aborted)throw Object.assign(Error('暂停'),{code:'PAUSED'});
  return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('暂停'),{code:'PAUSED'})),{once:true}));
 });
 try{
  const j=await ctx.manager.create({...input(b),purpose:'collect'}),blocked=await until(ctx.manager,j.id);await ctx.manager.running;const prior=blocked.reportHash;
  assert.equal(blocked.reportRun,1);const resumed=await ctx.manager.resume(j.id);assert.equal(resumed.reportHash,prior);assert.equal(resumed.reportRun,1);assert.equal(resumed.timing.runs.length,2);
  for(let i=0;i<100&&!ctx.manager.jobs.get(j.id).collectionRange;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(ctx.manager.jobs.get(j.id).collectionRange);assert.equal(hash(await ctx.manager.report(resumed)),prior);await ctx.manager.pause(j.id);
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('interrupted running state restores only durable active time and automatically accumulates a new run',async()=>{
 const b=dataset(),dir=await mkdtemp(path.join(tmpdir(),'ashare-crash-time-')),bucket=new FileBucket(path.join(dir,'warehouse'));let tick=100000,waiting=true;
 const collect=async(_r,_p,signal,progress)=>{tick+=2000;await progress({query:['minute','month'],checkpoints:1});if(waiting)await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stop'),{code:'PAUSED'})),{once:true}));return b;};
 let m=await new ResearchManager({root:path.join(dir,'research'),bucket,collector:collect,clock:()=>tick}).init();
 try{
  const j=await m.create({...input(b),purpose:'collect'});for(let i=0;i<100&&!m.jobs.get(j.id).progress;i++)await new Promise(r=>setTimeout(r,10));
  tick+=3000;await m.save(m.jobs.get(j.id));const statePath=m.location(j.id,'state.json'),durable=await readFile(statePath,'utf8');assert.equal(JSON.parse(durable).timing.activeMs,5000);
  tick+=1100;await m.close();await writeFile(statePath,durable);tick+=86400000;waiting=false;
  m=await new ResearchManager({root:path.join(dir,'research'),bucket,collector:collect,clock:()=>tick}).init();const done=await until(m,j.id);
  assert.equal(done.timing.activeMs,7000);assert.equal(done.timing.runs[0].stopReason,'interrupted');assert.equal(done.timing.runs[0].endedAt,new Date(105000).toISOString());assert.equal(done.timing.runs[1].activeMs,2000);assert.ok(done.timing.interruptedTailUnmeasured);assert.equal(done.recoveryCount,1);
 }finally{await m.close();await rm(dir,{recursive:true,force:true});}
});
test('custom short and multi-year jobs count only the selected interval and replay immutable snapshots',async()=>{
 for(const [days,fromIndex,timeframe] of [[360,320,'5m'],[660,80,'15m']]){
  const b=fixture(days);let calls=0;const ctx=await setup(async()=>{calls++;return b;});
  try{
   const req={...input(b),rangeMode:'custom',from:b.calendar[fromIndex]};req.config.timeframe=timeframe;
   const j=await ctx.manager.create(req),done=await until(ctx.manager,j.id);assert.equal(done.status,'completed',JSON.stringify(done.error));
   const report=JSON.parse(await ctx.manager.report(done));assert.equal(report.request.rangeMode,'custom');assert.equal(report.request.from,req.from);assert.equal(report.request.to,req.to);
   assert.equal(report.result.period.bars,(days-fromIndex)*(timeframe==='5m'?48:16));assert.ok(report.result.curve.every(p=>p.date.slice(0,10)>=req.from&&p.date.slice(0,10)<=req.to));assert.ok(report.result.trades.every(t=>t.executionTime.slice(0,10)>=req.from));assert.equal(report.result.audit.timingViolations,0);assert.equal(report.accounting.status,'passed');
   const replay=await ctx.manager.repeat(j.id),again=await until(ctx.manager,replay.id);assert.equal(again.resultHash,done.resultHash);assert.equal(again.reportHash,done.reportHash);assert.equal(calls,1);
   if(days===360){
    // A changed collector must block old collection checkpoints, but cannot
    // force a fixed, verified snapshot to fetch market data again.
    const legacy=await ctx.manager.create(null,{replay:{...done,pipelineHash:hash('previous collector')}});assert.equal((await until(ctx.manager,legacy.id)).resultHash,done.resultHash);assert.equal(calls,1);
    ctx.manager.pipelineFingerprint=hash('previous collector');const unfinished=await ctx.manager.create(req);assert.equal((await until(ctx.manager,unfinished.id)).error.code,'PIPELINE_CHANGED');assert.equal(calls,1);
    const wrong=structuredClone(b);wrong.metadata.research={from:'2024-01-01',to:req.to,warmupSessions:60};assert.ok(acceptanceAudit(wrong,done.request).issues.some(i=>i.code==='RESEARCH_RANGE'));
   }
  }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
 }
});

test('one-year native-5m closed loop archives fees, corporate accounting and exact replay',async()=>{
 const b=dataset();let calls=0;const ctx=await setup(async()=>{calls++;return b;});let manager=ctx.manager;
 try{const j=await manager.create(input(b)),done=await until(manager,j.id);assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(done.acceptance,'synthetic-test-only');assert.ok(done.metrics.quantity>0);assert.ok(done.metrics.fees>0);
  const report=JSON.parse(await manager.report(done));assert.equal(report.reproducibility.runs,2);assert.equal(report.accounting.status,'passed');assert.equal(report.result.audit.timingViolations,0);assert.ok(report.result.corporateEvents.some(x=>x.event==='股息到账'));assert.ok(report.result.trades.length>0);
  assert.equal(report.request.config.capital,1000000);assert.equal(report.request.config.commission,.005);assert.equal(report.request.config.stamp,.05);assert.equal(report.request.config.minCommission,5);
  const replay=await manager.repeat(j.id),again=await until(manager,replay.id);assert.equal(again.status,'completed',JSON.stringify(again.error));assert.equal(again.resultHash,done.resultHash);assert.equal(again.reportHash,done.reportHash);assert.equal(calls,1);
  await manager.close();manager=await new ResearchManager({root:path.join(ctx.dir,'research'),bucket:ctx.bucket,collector:async()=>{throw Error('复现不能重新拉数据');}}).init();const persisted=manager.jobs.get(j.id);assert.equal(persisted.reportHash,done.reportHash);assert.equal(hash(await manager.report(persisted)),done.reportHash);
  const tampered=structuredClone(report.result);tampered.curve[5].equity+=100;assert.throws(()=>auditAccounting(tampered,b),/净值/);
  await writeFile(path.join(ctx.dir,'warehouse','snapshots',done.snapshotId+'.json'),'{}');const bad=await manager.repeat(j.id);assert.equal((await until(manager,bad.id)).error.code,'SNAPSHOT_HASH');
 }finally{await manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('minute gaps and warmup deficits block before warehouse/backtest',async()=>{
 const b=dataset();b.bars=b.bars.filter(r=>!r.date.startsWith(b.calendar[180]));const ctx=await setup(async()=>b);
 try{const j=await ctx.manager.create(input(b)),done=await until(ctx.manager,j.id);assert.equal(done.status,'blocked');assert.equal(done.error.code,'DATA_ADMISSION');assert.ok(done.quality.issues.some(x=>x.code==='MISSING_DAYS'));assert.equal(done.snapshotId,undefined);const r=JSON.parse(await ctx.manager.report(done));assert.equal(r.acceptance,'blocked');
  const short=fixture(50),req=normalizeRequest(input(dataset()));assert.ok(acceptanceAudit(short,req).issues.some(x=>x.code==='WARMUP'));
  const m15=dataset();m15.metadata.timeframe='15m';assert.ok(acceptanceAudit(m15,req).issues.some(x=>x.code==='NATIVE_5M'));
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('backend 15m execution uses native-5m source and preserves event cash flows',async()=>{
 const b=dataset(),ctx=await setup(async()=>b);try{const req=input(b);req.config.timeframe='15m';req.config.management='adaptive';const j=await ctx.manager.create(req),done=await until(ctx.manager,j.id);assert.equal(done.status,'completed',JSON.stringify(done.error));const report=JSON.parse(await ctx.manager.report(done));assert.equal(report.result.dataInfo.nativeTimeframe,'5m');assert.equal(report.result.dataInfo.executionTimeframe,'15m');assert.equal(report.accounting.valuationPoints,report.result.curve.length);assert.equal(report.result.period.bars,b.calendar.filter(d=>d>=report.request.from&&d<=report.request.to).length*16);}
 finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('pause preserves a checkpoint; restart recovers interrupted job and serializes tasks',async()=>{
 const b=dataset();let active=0,maxActive=0,calls=0,waiting=true;
 const collect=async(_req,root,signal,progress)=>{active++;maxActive=Math.max(maxActive,active);calls++;
  try{await mkdir(root,{recursive:true});const checkpoint=path.join(root,'saved-month');try{await readFile(checkpoint);}catch{await writeFile(checkpoint,'immutable month');}await progress({query:['minute','first-month'],checkpoints:1,rows:100,cached:calls>1});
   if(waiting)await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('暂停'),{code:'PAUSED'})),{once:true});});return b;
  }finally{active--;}
 };
 const ctx=await setup(collect);let m=ctx.manager;
 try{const j=await m.create(input(b));for(let i=0;i<100&&!m.jobs.get(j.id).progress;i++)await new Promise(r=>setTimeout(r,10));const paused=await m.pause(j.id);assert.equal(paused.status,'paused');assert.equal(await readFile(m.location(j.id,'collection/saved-month'),'utf8'),'immutable month');await m.close();
  const statePath=m.location(j.id,'state.json'),state=JSON.parse(await readFile(statePath,'utf8'));state.status='running';await writeFile(statePath,canonical(state));waiting=false;
  m=await new ResearchManager({root:path.join(ctx.dir,'research'),bucket:ctx.bucket,collector:collect}).init();const second=await m.create(input(b));assert.equal((await until(m,j.id)).status,'completed');assert.equal((await until(m,second.id)).status,'completed');assert.equal(m.jobs.get(j.id).recoveryCount,1);assert.equal(maxActive,1);assert.ok(m.jobs.get(j.id).progress.cached);
  await assert.rejects(new ResearchManager({root:path.join(ctx.dir,'research'),bucket:ctx.bucket}).init(),/已有/);
 }finally{await m.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('report and request tampering cannot silently resume or reproduce',async()=>{
 const b=dataset(),ctx=await setup(async()=>b);try{const j=await ctx.manager.create(input(b)),done=await until(ctx.manager,j.id);await writeFile(path.join(ctx.dir,'research/reports',done.reportHash+'.json'),'{}');await assert.rejects(ctx.manager.repeat(j.id),/报告文件哈希/);
  await writeFile(ctx.manager.location(j.id,'request.json'),'{}');await ctx.manager.close();const m=await new ResearchManager({root:path.join(ctx.dir,'research'),bucket:ctx.bucket}).init();assert.equal(m.jobs.get(j.id).error.code,'JOB_INTEGRITY');await m.close();
 }finally{await ctx.manager.close();await rm(ctx.dir,{recursive:true,force:true});}
});
test('local HTTP task API runs on backend and keeps replay pinned; rejects cross-origin writes',async()=>{
 const b=dataset(),dir=await mkdtemp(path.join(tmpdir(),'ashare-job-api-'));let server;
 try{server=await startLocal({port:0,dataDir:dir,worker,researchOptions:{collector:async()=>b}});const base='http://127.0.0.1:'+server.address().port;
  const rejected=await fetch(base+'/api/research/jobs',{method:'POST',headers:{'content-type':'application/json',origin:'https://example.com'},body:JSON.stringify(input(b))});assert.equal(rejected.status,403);
  const r=await fetch(base+'/api/research/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input(b))});assert.equal(r.status,202);const job=await r.json(),done=await until(server.research,job.id);assert.equal(done.status,'completed');
  const report=await fetch(base+'/api/research/jobs/'+job.id+'/report');assert.equal(report.status,200);assert.equal(hash(Buffer.from(await report.arrayBuffer())),done.reportHash);
  const repeat=await(await fetch(base+'/api/research/jobs/'+job.id+'/repeat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();assert.equal((await until(server.research,repeat.id)).resultHash,done.resultHash);
  const customRequest={...input(b),rangeMode:'custom',from:b.calendar.at(-40)};
  const custom=await fetch(base+'/api/research/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(customRequest)});assert.equal(custom.status,202);const customJob=await custom.json();assert.equal(customJob.request.from,customRequest.from);assert.equal((await until(server.research,customJob.id)).status,'completed');
  const invalid=await fetch(base+'/api/research/jobs',{method:'POST',headers:{'content-type':'application/json'},body:'{"symbol":"600519","rangeMode":"custom","to":"2025-05-01","from":"2025-05-02"}'});assert.equal(invalid.status,400);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
