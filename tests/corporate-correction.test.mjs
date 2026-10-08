import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFile,mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {dividendFixture} from './corporate-correction-fixture.mjs';
import {correctOfficialActions,verifyOfficialCorrections,officialEvidence} from '../dist/corporate-correction.mjs';
import {auditBundle} from '../dist/quality.mjs';import {CorporateLedger} from '../dist/corporate.mjs';
import {assembleBundles,canonical} from '../server/assemble.mjs';import {correctStoredActions} from '../server/corporate-correction.mjs';
import {FileBucket} from '../scripts/local-server.mjs';import worker from '../server/worker.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');

test('official document hash, reported 3.07→4.30 economics, immutable candles and no double special dividend',async()=>{
 const b=dividendFixture(),original=canonical(b),parentId=hash(original),before=auditBundle(b,{scope:'single-security'});assert.ok(before.blockingIssues.some(i=>i.code==='ACTION_ECONOMICS'));
 const {bundle,changes}=correctOfficialActions(b,parentId),q=auditBundle(bundle,{scope:'single-security'});assert.equal(changes.length,1);assert.equal(q.status,'passed');assert.ok(Math.abs(q.actionChecks[0].theoreticalReference-19.7133333333)<1e-8);assert.ok(q.actionChecks[0].difference<.011);
 for(const k of ['bars','daily','factors','calendar','universe'])assert.deepEqual(bundle[k],b[k]);assert.equal(canonical(b),original);assert.equal(bundle.actions[0].cashPerShare,4.3);
 const proof=bundle.metadata.corporateCorrections.records[0];assert.equal(proof.before.cashPerShare,3.07);assert.equal(proof.sourceSnapshotId,parentId);
 assert.equal(correctOfficialActions(bundle,hash(canonical(bundle))).bundle,bundle);assert.equal(correctOfficialActions(bundle).changes.length,0);
 const e=officialEvidence.records[0];assert.equal(hash(await readFile(new URL('../dist'+e.localDocument,import.meta.url))),e.documentSHA256);
 const ledger=new CorporateLedger(bundle.actions);assert.deepEqual(ledger.open('2023-07-13',1000),{cash:0,shares:0});ledger.record('2023-07-14',1000);assert.deepEqual(ledger.open('2023-07-14',1000),{cash:0,shares:0});assert.deepEqual(ledger.open('2023-07-17',1000),{cash:4300,shares:500});assert.deepEqual(ledger.open('2023-07-18',1500),{cash:0,shares:0});assert.equal(ledger.dividendTotal,4300);
});
test('unreviewed fields, contradictory daily references, duplicate events and tampered proof block',()=>{
 for(const edit of [b=>b.actions[0].bonusPerShare=.3,b=>b.actions[0].cashPerShare=2,b=>b.actions[0].payDate='2023-07-18',b=>b.actions[0].cashBasis='net',b=>b.daily.find(d=>d.date==='2023-07-17').prev_close=18,b=>b.actions.push({...b.actions[0],id:'second'}),b=>b.actions[0].announcementTime='2023-07-18 00:00']){const b=dividendFixture();edit(b);assert.throws(()=>correctOfficialActions(b),e=>e.code==='ACTION_CORRECTION_PROOF');}
 for(const edit of [b=>b.metadata.corporateCorrections.records[0].documentSHA256='bad',b=>b.metadata.corporateCorrections.records[0].before.cashPerShare=1,b=>b.actions[0].cashPerShare=5.53]){const b=correctOfficialActions(dividendFixture()).bundle;edit(b);assert.throws(()=>verifyOfficialCorrections(b));assert.ok(auditBundle(b,{scope:'single-security'}).blockingIssues.some(i=>i.code==='ACTION_CORRECTION_PROOF'));}
 const unrelated=dividendFixture();unrelated.metadata.symbol='600519';assert.equal(correctOfficialActions(unrelated).changes.length,0);assert.ok(auditBundle(unrelated,{scope:'single-security'}).blockingIssues.some(i=>i.code==='ACTION_ECONOMICS'));
});
test('old and corrected overlapping snapshots merge deterministically and other raw conflicts remain blocked',()=>{
 const b=dividendFixture(),id=hash(canonical(b)),fixed=correctOfficialActions(b,id).bundle,parents=[{id,bundle:b},{id:hash(canonical(fixed)),bundle:fixed}],input={symbol:'600188',from:'2023-07-03',to:'2023-09-15',warmupSessions:60},before=canonical(parents);
 const {bundle,report}=assembleBundles(parents,input);assert.equal(report.status,'passed');assert.equal(bundle.actions.length,1);assert.equal(bundle.actions[0].cashPerShare,4.3);assert.equal(bundle.metadata.corporateCorrections.records.length,1);verifyOfficialCorrections(bundle);assert.equal(canonical(parents),before);assert.equal(canonical(assembleBundles([...parents].reverse(),input).bundle),canonical(bundle));
 parents[1].bundle.bars[100].volume+=1;assert.throws(()=>assembleBundles(parents,input),e=>e.code==='ASSEMBLY_CONFLICT');
});
test('saved correction verifies hashes, keeps warnings/other blockers, reuses ID and retries interrupted manifest publication',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-action-'));try{const bucket=new FileBucket(dir),b=dividendFixture();b.bars[4000].volume+=1000;const bytes=canonical(b),id=hash(bytes);await bucket.put('snapshots/'+id+'.json',bytes);
  const originalPut=bucket.put.bind(bucket);let interrupted=true;bucket.put=async(key,body)=>{if(key.startsWith('manifests/')&&interrupted){interrupted=false;throw Error('injected interruption');}return originalPut(key,body);};await assert.rejects(correctStoredActions(bucket,{snapshots:[id]}),/interruption/);
  const a=await correctStoredActions(bucket,{snapshots:[id]}),c=await correctStoredActions(bucket,{snapshots:[id]});assert.equal(a.entries[0].id,c.entries[0].id);assert.equal(c.entries[0].reused,true);assert.equal(a.entries[0].report.status,'warning');assert.equal((await bucket.get('snapshots/'+id+'.json')).body.toString(),bytes);const fixed=await (await bucket.get('snapshots/'+a.entries[0].id+'.json')).json();verifyOfficialCorrections(fixed);assert.equal(fixed.metadata.parquetArchive,undefined);
  assert.equal((await correctStoredActions(bucket,{snapshots:[a.entries[0].id]})).changedSnapshots,0);
  const other=dividendFixture();other.daily[5].isST=null;const oid=hash(canonical(other));await bucket.put('snapshots/'+oid+'.json',canonical(other));const still=await correctStoredActions(bucket,{snapshots:[oid]});assert.equal(still.entries[0].report.status,'blocked');assert.ok(still.entries[0].report.blockingIssues.some(i=>i.code==='ST_HISTORY'));
  await bucket.put('snapshots/'+id+'.json','{}');await assert.rejects(correctStoredActions(bucket,{snapshots:[id]}),e=>e.code==='SNAPSHOT_HASH');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('correction API guards origin/size/IDs and archive mutation cannot silently change prices',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-action-api-'));try{const env={BUCKET:new FileBucket(dir)},b=dividendFixture(),id=hash(canonical(b));await env.BUCKET.put('snapshots/'+id+'.json',canonical(b));const req=(input,origin='http://localhost')=>new Request('http://localhost/api/data/corporate-correction',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await worker.fetch(req({snapshots:[id]},'https://evil.example'),env)).status,403);assert.equal((await worker.fetch(req({snapshots:[]}),env)).status,409);assert.equal((await worker.fetch(req({snapshots:{}}),env)).status,409);assert.equal((await worker.fetch(req({huge:'x'.repeat(21000)}),env)).status,413);
  env.CORPORATE_ARCHIVER=async b=>{const c=structuredClone(b);c.bars[0].close+=1;c.metadata.parquetArchive={};return c;};assert.equal((await worker.fetch(req({snapshots:[id]}),env)).status,409);delete env.CORPORATE_ARCHIVER;const response=await worker.fetch(req({snapshots:[id]}),env);assert.equal(response.status,201);assert.equal((await response.json()).entries[0].report.status,'passed');
 }finally{await rm(dir,{recursive:true,force:true});}
});
