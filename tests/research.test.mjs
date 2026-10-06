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
  const invalid=await fetch(base+'/api/research/jobs',{method:'POST',headers:{'content-type':'application/json'},body:'{"symbol":"600519","to":"2025-05-01","from":"2024-01-01"}'});assert.equal(invalid.status,400);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
