import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FileBucket} from '../scripts/local-server.mjs';
import worker from '../server/worker.mjs';
import {portfolioBacktest} from '../dist/portfolio.mjs';
import {fixture} from './fixture.mjs';
test('immutable portfolio report storage verifies arithmetic, requires saved snapshots, rejects cross-origin writes',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-portfolio-report-')),bucket=new FileBucket(dir),b=fixture(80),id='a'.repeat(64),r=portfolioBacktest([{symbol:'600519',data:b,snapshotId:id}],{from:b.calendar[65],to:b.calendar.at(-1),dataMode:'single',strategies:['ma'],fast:2,slow:3,timeframe:'15m',maxHoldings:1}),env={BUCKET:bucket};
 const req=(report=r,origin)=>new Request('http://localhost/api/portfolio/reports',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify({report})});
 try{
  const missing=await worker.fetch(req(),env);assert.equal(missing.status,400);assert.match((await missing.json()).error,/原快照不存在/);
  await bucket.put('snapshots/'+id+'.json',JSON.stringify(b));const saved=await worker.fetch(req(),env);assert.equal(saved.status,201);const receipt=await saved.json();assert.match(receipt.id,/^[a-f0-9]{64}$/);assert.match(receipt.validation,/not an independent/);
  const repeated=await worker.fetch(req(),env);assert.equal(repeated.status,200);assert.equal((await repeated.json()).id,receipt.id);
  const read=await worker.fetch(new Request('http://localhost/api/portfolio/reports/'+receipt.id),env);assert.equal(read.status,200);assert.deepEqual((await read.json()).report,r);
  const invalid=structuredClone(r);invalid.curve[2].cash-=100;assert.equal((await worker.fetch(req(invalid),env)).status,400);
  assert.equal((await worker.fetch(req(r,'https://example.com'),env)).status,403);
 }finally{await rm(dir,{recursive:true,force:true});}
});
