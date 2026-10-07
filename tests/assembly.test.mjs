// All market rows are explicit synthetic fixtures; no provider requests.
import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {assembleBundles,assembleStored,canonical} from '../server/assemble.mjs';
import {backtest,defaults} from '../dist/engine.mjs';
import {normalizeRequest} from '../server/research.mjs';import {FileBucket} from '../scripts/local-server.mjs';import worker from '../server/worker.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
import {fragments} from './assembly-fixture.mjs';
import {auditBundle} from '../dist/quality.mjs';
import {reconciliationReport} from '../dist/reconciliation.mjs';
test('two annual raw snapshots assemble a full two-year research and causal dividend chain',()=>{
  const {full,parents,input}=fragments(),before=canonical(parents),{bundle,report}=assembleBundles(parents,input);
  assert.equal(report.status,'passed');assert.equal(report.membershipChecked,false);assert.equal(bundle.metadata.research.from,input.from);assert.equal(bundle.metadata.requested.to,input.to);assert.equal(bundle.actions.length,2);assert.equal(new Set(bundle.actions.map(a=>a.id)).size,2);assert.equal(bundle.metadata.assembly.parents.length,2);assert.equal(bundle.metadata.parquetArchive,undefined);
  const expected=full.daily.filter(d=>d.date>=bundle.metadata.requested.from&&d.date<=input.to);assert.deepEqual(bundle.daily,expected);assert.equal(canonical(parents),before);assert.equal(canonical(assembleBundles([...parents].reverse(),input).bundle),canonical(bundle));
  const cfg={...defaults,from:input.from,to:input.to,dataMode:'single',strategy:'ma',fast:2,slow:3,management:'base',timeframe:'5m'};
  const result=backtest(bundle,cfg),again=backtest(bundle,cfg);assert.deepEqual(result,again);assert.equal(result.audit.timingViolations,0);assert.ok(result.corporateEvents.length);assert.ok(result.trades.every(t=>t.executionTime.slice(0,10)>=input.from));
});
test('calendar gaps, insufficient warmup and incomplete bars cannot manufacture coverage',()=>{
  const {parents,input}=fragments();assert.throws(()=>assembleBundles(parents,{...input,warmupSessions:150}),e=>e.code==='ASSEMBLY_COVERAGE');
  const bad=structuredClone(parents);bad[0].bundle.bars=bad[0].bundle.bars.filter(r=>r.date!=='2025-01-03 09:35');assert.throws(()=>assembleBundles(bad,input),e=>e.code==='ASSEMBLY_ADMISSION'&&e.message.includes('分钟'));
  bad[0].bundle.daily=bad[0].bundle.daily.filter(d=>d.date!=='2025-01-06');assert.throws(()=>assembleBundles(bad,input),e=>e.code==='ASSEMBLY_ADMISSION');
});
test('overlapping raw revisions and missing actions block rather than choosing a winner',()=>{
  const {parents,input}=fragments();const bad=structuredClone(parents),overlap=bad[1].bundle.bars[0];overlap.close+=.02;
  assert.throws(()=>assembleBundles(bad,input),e=>e.code==='ASSEMBLY_CONFLICT');
  for(const p of bad){p.bundle.bars=structuredClone(parents.find(q=>q.id===p.id).bundle.bars);p.bundle.actions=[];}
  assert.throws(()=>assembleBundles(bad,input),e=>e.code==='ASSEMBLY_ADMISSION'&&e.message.includes('公司行动'));
});
test('stock, native timeframe and synthetic/real identities cannot mix',()=>{
  for(const change of [b=>b.metadata.symbol='600519',b=>b.metadata.timeframe='15m',b=>delete b.metadata.synthetic]){
    const {parents,input}=fragments();change(parents[1].bundle);assert.throws(()=>assembleBundles(parents,input),e=>e.code==='ASSEMBLY_IDENTITY');
  }
});
test('merged storage verifies input and output hashes and reuses the same immutable snapshot',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-assembly-'));try{const bucket=new FileBucket(dir),{parents,input}=fragments();for(const p of parents)await bucket.put('snapshots/'+p.id+'.json',canonical(p.bundle));
    const a=await assembleStored(bucket,{...input,snapshots:parents.map(p=>p.id)}),b=await assembleStored(bucket,{...input,snapshots:parents.map(p=>p.id).reverse()});assert.equal(a.id,b.id);assert.equal(b.reused,true);assert.equal(hash((await bucket.get('snapshots/'+a.id+'.json')).body),a.id);assert.equal(a.report.status,'passed');
    await bucket.put('snapshots/'+parents[0].id+'.json',canonical({...parents[0].bundle,schemaVersion:99}));await assert.rejects(assembleStored(bucket,{...input,snapshots:parents.map(p=>p.id)}),e=>e.code==='SNAPSHOT_HASH');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('assembly API respects same-origin writes and reports precise missing coverage',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-assembly-api-'));try{const env={BUCKET:new FileBucket(dir)},url='http://localhost/api/data/assemble';
    const request=(data,origin='http://localhost')=>new Request(url,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(data)});
    assert.equal((await worker.fetch(request({},'https://example.com'),env)).status,403);assert.equal((await worker.fetch(request({snapshots:[]}),env)).status,409);assert.equal((await worker.fetch(request({huge:'x'.repeat(21000)}),env)).status,413);
    const {parents,input}=fragments();for(const p of parents)await env.BUCKET.put('snapshots/'+p.id+'.json',canonical(p.bundle));const response=await worker.fetch(request({...input,snapshots:parents.map(p=>p.id)}),env);assert.equal(response.status,201);assert.equal((await response.json()).report.status,'passed');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('collection execution supports 5m, 15m and daily while native acquisition remains 5m',()=>{
  for(const timeframe of ['5m','15m','1d']){const r=normalizeRequest({symbol:'001389',purpose:'collect',from:'2024-10-01',to:'2026-09-30',config:{timeframe}});assert.equal(r.config.timeframe,timeframe);assert.equal(r.provider,'baostock');}
  const daily=normalizeRequest({symbol:'001389',purpose:'collect',from:'2024-10-01',to:'2026-09-30',config:{timeframe:'1d',slow:250}});assert.equal(daily.warmupSessions,251);
  assert.throws(()=>normalizeRequest({symbol:'001389',purpose:'research',to:'2026-09-30',config:{timeframe:'1d'}}),/正式验收/);
});
test('147 inherited volume warnings permit assembly and retain every diagnostic without altering data',()=>{
  const {parents,input}=fragments(),bad=structuredClone(parents),days=new Set(bad[0].bundle.daily.slice(0,147).map(d=>d.date));
  for(const r of bad[0].bundle.bars)if(days.has(r.date.slice(0,10)))r.volume*=2;
  const before=canonical(bad);
  const {bundle,report}=assembleBundles(bad,input);
  assert.equal(report.status,'warning');assert.equal(report.blockingIssues.length,0);assert.equal(report.warningCount,147);
  const d=reconciliationReport(bundle,report,bad);
    assert.deepEqual(d.summary,{failedChecks:147,affectedDays:147,priceChecks:0,openChecks:0,highChecks:0,lowChecks:0,volumeChecks:147,sourceMismatchDays:147,assemblyOnlyDays:0});
    assert.equal(d.rows.length,147);assert.ok(d.rows.every(r=>r.bars===48&&r.volume.minute===960000&&r.volume.daily===480000&&r.volume.difference===480000&&r.volume.ratio===2&&r.volume.tolerance===2400&&r.parents[0].snapshotId===bad[0].id));
    assert.equal(d.admissionStatus,'warning');assert.equal(d.dataRepaired,false);
  assert.equal(canonical(bad),before);
});
test('diagnostics distinguish two failed checks on one day and keep sub-cent discrepancies',()=>{
  const {parents}=fragments(),b=structuredClone(parents[0].bundle),last=b.bars[47];last.close+=.02;last.high=Math.max(last.high,last.close);last.volume+=10000;
  const q=auditBundle(b,{scope:'single-security'}),d=reconciliationReport(b,q);
  assert.equal(d.summary.failedChecks,2);assert.equal(d.summary.affectedDays,1);assert.equal(d.summary.priceChecks,1);assert.equal(d.summary.volumeChecks,1);assert.ok(Math.abs(d.rows[0].close.difference-.02)<1e-10);assert.equal(d.rows[0].volume.difference,10000);assert.equal(d.rows[0].close.tolerance,.011);
  assert.equal(q.status,'warning');assert.equal(reconciliationReport(parents[0].bundle,auditBundle(parents[0].bundle,{scope:'single-security'})),null);
});
