import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {ResearchManager,canonical,hash} from '../server/research.mjs';
import {FileBucket,startLocal} from '../scripts/local-server.mjs';
import {parseCollectionCodes} from '../dist/collection-batch.mjs';
import {fixture} from './fixture.mjs';

const base=()=>({symbols:'600519,000001\n001389，600519',requestId:'batch-test-request',purpose:'collect',rangeMode:'custom',from:'2024-04-01',to:'2024-05-20',config:{timeframe:'5m'}});
const dataset=request=>{const b=fixture(110);Object.assign(b.metadata,{symbol:request.symbol,board:request.board,universe:'SINGLE_SECURITY',collectionPurpose:'market-data-only',research:{from:request.from,to:request.to,warmupSessions:request.warmupSessions}});b.universe=[];b.metadata.coverage.universe={status:'not-requested'};b.calendar=b.calendar.filter(d=>d<=request.to);b.bars=b.bars.filter(r=>r.date.slice(0,10)<=request.to);b.daily=b.daily.filter(d=>d.date<=request.to);b.metadata.requested.to=request.to;for(const k of ['calendar','daily','actions','factors'])b.metadata.coverage[k].to=request.to;return b;};
async function setup(collector){const dir=await mkdtemp(path.join(tmpdir(),'ashare-batch-')),bucket=new FileBucket(path.join(dir,'warehouse')),root=path.join(dir,'research');const manager=await new ResearchManager({root,bucket,collector}).init();return {dir,bucket,root,manager};}
async function until(fn){for(let i=0;i<400;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('batch timeout');}
async function cleanup(c){await c.manager.close();await rm(c.dir,{recursive:true,force:true});}

test('batch parser preserves leading zeroes, accepts common delimiters, deduplicates, and rejects invalid/oversized lists',()=>{
 assert.deepEqual(parseCollectionCodes('600519，000001 001389;600519\n000001、300750；688001'),{symbols:['600519','000001','001389','300750','688001'],duplicates:2});
 assert.deepEqual(parseCollectionCodes(['000001','600519']),{symbols:['000001','600519'],duplicates:0});
 for(const x of ['',null,'600519,bad','1','000001\n300750x',[1],Array.from({length:301},(_,i)=>String(i).padStart(6,'0'))])assert.throws(()=>parseCollectionCodes(x));
 assert.equal(parseCollectionCodes(Array.from({length:300},(_,i)=>String(i).padStart(6,'0'))).symbols.length,300);
});
test('all symbols and shared configuration validate before any durable task is submitted',async()=>{
 let calls=0;const c=await setup(async()=>{calls++;throw Error('must not collect');});
 try{for(const input of [{...base(),symbols:'600519,900001'},{...base(),symbols:'600519,123'},{...base(),from:'2024-02-30'},{...base(),config:{timeframe:'30m'}},{...base(),requestId:'../bad'}])await assert.rejects(c.manager.createBatch(input));assert.equal(c.manager.jobs.size,0);assert.equal(c.manager.batches.size,0);assert.equal(calls,0);assert.deepEqual(await readdir(path.join(c.root,'jobs')),[]);}
 finally{await cleanup(c);}
});
test('batch submission is idempotent, per-stock requests are frozen, and one stock failure does not block the next',async()=>{
 let active=0,maxActive=0;const calls=[];const c=await setup(async request=>{active++;maxActive=Math.max(maxActive,active);calls.push(request.symbol);try{await new Promise(r=>setTimeout(r,15));if(request.symbol==='000001')throw Error('synthetic single-stock provider failure');return dataset(request);}finally{active--;}});
 try{const inputs={...base(),config:{timeframe:'5m',commission:.005,capital:1000000}};const [one,two]=await Promise.all([c.manager.createBatch(inputs),c.manager.createBatch(inputs)]);assert.equal(one.id,two.id);assert.equal(two.reused,true);assert.equal(one.total,3);assert.equal(one.duplicates,1);assert.equal(c.manager.jobs.size,3);
  await until(()=>[...c.manager.jobs.values()].every(j=>['completed','blocked'].includes(j.status)));assert.deepEqual(calls,['600519','000001','001389']);assert.equal(maxActive,1);const view=c.manager.batchView(c.manager.batches.get(one.id));assert.equal(view.counts.completed,2);assert.equal(view.counts.blocked,1);assert.ok(view.jobIds.every(id=>c.manager.jobs.get(id).batchId===one.id));
  for(const j of c.manager.jobs.values()){assert.equal(j.request.from,inputs.from);assert.equal(j.request.to,inputs.to);assert.equal(j.request.config.capital,1000000);assert.equal(j.request.config.commission,.005);assert.equal(hash(await readFile(c.manager.location(j.id,'request.json'))),j.requestHash);}
  await assert.rejects(c.manager.createBatch({...inputs,symbols:'600519'}),/同一提交编号/);
 }finally{await cleanup(c);}
});
test('whole-batch pause survives restart and resumes checkpoints without re-running completed stocks',async()=>{
 let checkpointWritten=false;const calls=[],c=await setup(async(request,root,signal)=>{calls.push(request.symbol);if(request.symbol==='000001'){await writeFile(path.join(root,'saved-checkpoint'),'immutable synthetic month');checkpointWritten=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('pause'),{code:'PAUSED'})),{once:true}));}return dataset(request);});
 try{const batch=await c.manager.createBatch(base());await until(()=>checkpointWritten);const completed=c.manager.jobs.get(batch.jobIds[0]).reportHash;const paused=await c.manager.pauseBatch(batch.id);assert.equal(paused.counts.completed,1);assert.equal(paused.counts.paused,2);assert.equal(await readFile(c.manager.location(batch.jobIds[1],'collection/saved-checkpoint'),'utf8'),'immutable synthetic month');await c.manager.close();
  c.manager=await new ResearchManager({root:c.root,bucket:c.bucket,collector:async(request,root)=>{calls.push(request.symbol);if(request.symbol==='000001')assert.equal(await readFile(path.join(root,'saved-checkpoint'),'utf8'),'immutable synthetic month');return dataset(request);}}).init();assert.equal(c.manager.active,null);assert.equal(c.manager.batchView(c.manager.batches.get(batch.id)).paused,true);await c.manager.resumeBatch(batch.id);await until(()=>batch.jobIds.every(id=>c.manager.jobs.get(id).status==='completed'));assert.equal(c.manager.jobs.get(batch.jobIds[0]).reportHash,completed);assert.deepEqual(calls,['600519','000001','000001','001389']);
 }finally{await cleanup(c);}
});
test('a 300-stock batch is fully persisted with inferred boards before scheduling any provider work',async()=>{
 let calls=0;const c=await setup(async()=>{calls++;throw Error('paused submission cannot collect');});
 try{c.manager.stopping=true;const symbols=Array.from({length:297},(_,i)=>String(600000+i)).concat(['000001','300750','688001']),b=await c.manager.createBatch({...base(),symbols,requestId:'synthetic-300-stock-batch'});assert.equal(b.total,300);assert.equal(b.counts.queued,300);assert.equal(calls,0);assert.equal(c.manager.jobs.get(b.jobIds.at(-2)).request.board,'chinext');assert.equal(c.manager.jobs.get(b.jobIds.at(-1)).request.board,'star');assert.equal(c.manager.jobs.get(b.jobIds.at(-3)).request.symbol,'000001');assert.equal((await readdir(path.join(c.root,'jobs'))).length,300);}
 finally{await cleanup(c);}
});
test('an interrupted batch staging journal recreates only missing jobs and rejects tampered evidence',async()=>{
 const c=await setup(async()=>{throw Error('not while staging');});
 try{c.manager.stopping=true;const batch=await c.manager.createBatch(base()),stored=c.manager.batches.get(batch.id);stored.creationState='staging';await writeFile(c.manager.batchLocation(batch.id),canonical(stored));
  const second=batch.jobIds[1];await rm(c.manager.location(second,'state.json'));const third=batch.jobIds[2];await rm(c.manager.location(third,''),{recursive:true,force:true});await c.manager.close();
  c.manager=await new ResearchManager({root:c.root,bucket:c.bucket,collector:async request=>dataset(request)}).init();await until(()=>batch.jobIds.every(id=>c.manager.jobs.get(id)?.status==='completed'));assert.equal(c.manager.batches.get(batch.id).creationState,'ready');assert.equal(c.manager.jobs.size,3);assert.equal((await c.manager.createBatch(base())).reused,true);await c.manager.close();
  const journal=JSON.parse(await readFile(c.manager.batchLocation(batch.id),'utf8'));journal.requests[0].symbol='600000';await writeFile(c.manager.batchLocation(batch.id),canonical(journal));c.manager=await new ResearchManager({root:c.root,bucket:c.bucket,collector:async()=>{throw Error('tampered batch cannot collect');}}).init();assert.equal(c.manager.batchView(c.manager.batches.get(batch.id)).error.code,'BATCH_INTEGRITY');await assert.rejects(c.manager.resumeBatch(batch.id),/完整性受阻/);
 }finally{await cleanup(c);}
});
test('daily source budget and blacklist errors hold remaining batch jobs before another provider call',async()=>{
 for(const message of ['已达到保守日请求预算，停止并保留断点。','BaoStock黑名单10001011：立即停止']){let calls=0;const c=await setup(async()=>{calls++;throw Error(message);});try{const b=await c.manager.createBatch(base());await until(()=>!c.manager.active&&c.manager.batches.get(b.id).paused);const v=c.manager.batchView(c.manager.batches.get(b.id));assert.equal(calls,1);assert.equal(v.error.code,'SOURCE_LIMIT');assert.equal(v.counts.blocked,1);assert.equal(v.counts.paused,2);}finally{await cleanup(c);}}
});
test('staging recovery preserves the batch engine and pipeline versions after an upgrade',async()=>{
 const c=await setup(async()=>{throw Error('old engine cannot collect formal research');});
 try{c.manager.stopping=true;c.manager.fingerprint=hash('previous batch engine');const b=await c.manager.createBatch({...base(),purpose:'research',requestId:'batch-engine-recovery'}),stored=c.manager.batches.get(b.id);stored.creationState='staging';await writeFile(c.manager.batchLocation(b.id),canonical(stored));await rm(c.manager.location(b.jobIds[2],''),{recursive:true,force:true});await c.manager.close();
  c.manager=await new ResearchManager({root:c.root,bucket:c.bucket,collector:async()=>{throw Error('must reject before collection');}}).init();await until(()=>b.jobIds.every(id=>c.manager.jobs.get(id)?.status==='blocked'));for(const id of b.jobIds){const j=c.manager.jobs.get(id);assert.equal(j.engineHash,stored.versions.engineHash);assert.equal(j.pipelineHash,stored.versions.pipelineHash);assert.equal(j.error.code,'ENGINE_CHANGED');}
 }finally{await cleanup(c);}
});
test('batch HTTP endpoints retain same-origin protections and expose persistent per-stock progress',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-batch-http-')),server=await startLocal({port:0,dataDir:dir,researchOptions:{collector:async request=>dataset(request)}});const url='http://127.0.0.1:'+server.address().port;
 try{const denied=await fetch(url+'/api/research/batches',{method:'POST',headers:{'content-type':'application/json',origin:'https://elsewhere.invalid'},body:JSON.stringify(base())});assert.equal(denied.status,403);const request=()=>fetch(url+'/api/research/batches',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify(base())});const response=await request();assert.equal(response.status,202);const b=await response.json();assert.equal(b.total,3);assert.equal((await(await request()).json()).reused,true);const list=await(await fetch(url+'/api/research/jobs')).json();assert.equal(list.jobs.length,3);assert.equal(list.batches[0].id,b.id);assert.equal((await fetch(url+'/api/research/batches/'+b.id)).status,200);}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
