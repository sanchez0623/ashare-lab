import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {startLocal,FileBucket,loadBuiltWorker} from '../scripts/local-server.mjs';
import worker from '../server/worker.mjs';
import {fixture} from './fixture.mjs';
// Drain response bodies even when only the status matters: a larger UI page
// can otherwise leave an active client stream after the HTTP server closes.
async function fetchStatus(url,options){const response=await fetch(url,options);await response.arrayBuffer();return response.status;}

test('local deployment serves UI and persists exact warehouse snapshots across restart',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-local-'));let server;
 try{
  server=await startLocal({port:0,dataDir:dir});let url='http://127.0.0.1:'+server.address().port;
  const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/波段策略回测/);
  const raw=JSON.stringify(fixture()),id=createHash('sha256').update(raw).digest('hex');
  let r=await fetch(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json'},body:raw});assert.equal(r.status,201);const manifest=await r.json();assert.equal(manifest.id,id);assert.equal(manifest.report.status,'passed');
  const read=await fetch(url+'/api/data/bundle?id='+id);assert.equal(await read.text(),raw);
  r=await fetch(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json'},body:raw});assert.equal((await r.json()).reused,true);
  await new Promise(resolve=>server.close(resolve));server=await startLocal({port:0,dataDir:dir});url='http://127.0.0.1:'+server.address().port;
  const catalog=await(await fetch(url+'/api/data/catalog')).json();assert.equal(catalog.entries[0].id,id);assert.equal(await(await fetch(url+'/api/data/bundle?id='+id)).text(),raw);
  assert.equal(await fetchStatus(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json',origin:'https://example.com'},body:raw}),403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(url,{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(hostStatus,403);
  assert.equal(await fetchStatus(url+'/%2e%2e%2fpackage.json'),403);
  assert.equal(await fetchStatus(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(25*1024*1024+1)}),413);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
test('reload waits for an in-flight handler even if its HTTP client disconnects',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-local-drain-'));let server,entered,release,closed=false;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 try{
  server=await startLocal({port:0,dataDir:dir,worker:{fetch:async()=>{entered();await gate;return new Response('done');}}});
  const client=http.get('http://127.0.0.1:'+server.address().port+'/slow');client.on('error',()=>{});await started;client.destroy();
  const closing=server.shutdown({reload:true}).then(()=>closed=true);await new Promise(r=>setTimeout(r,50));assert.equal(closed,false);await access(path.join(dir,'research/.controller-lock/owner.json'));
  release();await closing;assert.equal(closed,true);await assert.rejects(access(path.join(dir,'research/.controller-lock/owner.json')),e=>e.code==='ENOENT');server=null;
 }finally{release?.();if(server)await server.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('built runtime imports from a path with spaces, Chinese characters and URL delimiters',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-import-'));const root=path.join(dir,'研究系统 #预算 % 文件');
 try{
  await mkdir(path.join(root,'dist/server'),{recursive:true});await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await copyFile(new URL('../dist/server/index.js',import.meta.url),path.join(root,'dist/server/index.js'));
  const built=await loadBuiltWorker(root);const response=await built.fetch(new Request('http://localhost/'),{ASSETS:{fetch:async()=>new Response('packaged runtime')}});
  assert.equal(await response.text(),'packaged runtime');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing build and failed module import have different actionable diagnostics',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-build-diagnostic-'));
 try{
  await assert.rejects(loadBuiltWorker(dir),e=>e.code==='BUILD_MISSING'&&e.message.includes(path.join(dir,'dist/server/index.js')));
  await mkdir(path.join(dir,'dist/server'),{recursive:true});await writeFile(path.join(dir,'package.json'),'{"type":"module"}');await writeFile(path.join(dir,'dist/server/index.js'),'export default { broken syntax');
  await assert.rejects(loadBuiltWorker(dir),e=>e.code==='BUILD_LOAD_FAILED'&&e.cause instanceof SyntaxError&&!e.message.includes('缺少构建文件'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('file warehouse paginates stable keys and rejects arbitrary paths',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-bucket-'));try{const b=new FileBucket(dir),ids=Array.from({length:103},(_,i)=>i.toString(16).padStart(64,'0'));
  for(const id of ids)await b.put('manifests/'+id+'.json',JSON.stringify({id}));const first=await b.list({limit:100}),next=await b.list({limit:100,cursor:first.cursor});assert.equal(first.objects.length,100);assert.equal(first.truncated,true);assert.equal(next.objects.length,3);assert.equal(next.truncated,false);assert.equal(new Set([...first.objects,...next.objects].map(x=>x.key)).size,103);
  assert.throws(()=>b.location('../secret'),/路径/);assert.equal(await b.get('snapshots/'+'f'.repeat(64)+'.json'),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('source readiness API caches configuration checks without requiring source SDKs',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-source-status-'));let server;
 try{server=await startLocal({port:0,dataDir:dir,worker});const url='http://127.0.0.1:'+server.address().port+'/api/research/sources';
  const [a,b]=await Promise.all([fetch(url).then(r=>r.json()),fetch(url).then(r=>r.json())]);assert.deepEqual(a,b);assert.equal(a.backend,'local');assert.equal(a.ttlSeconds,60);
  if(a.sources.length){assert.deepEqual(a.sources.map(s=>s.name),['baostock','akshare','mootdx','lixinger','sina']);assert.match(a.probePolicy,/no market request/);assert.equal(a.sources.find(s=>s.name==='sina').requiresKey,false);}else assert.ok(['PYTHON_MISSING','SOURCE_STATUS_FAILED'].includes(a.code));
 }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('missing Python does not stop local UI or turn a real task into demo success',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-no-python-')),previous=process.env.ASHARE_PYTHON;let server;
 try{process.env.ASHARE_PYTHON=path.join(dir,'missing-python');server=await startLocal({port:0,dataDir:dir,worker});const url='http://127.0.0.1:'+server.address().port;
  assert.equal(await fetchStatus(url),200);const readiness=await(await fetch(url+'/api/research/sources')).json();assert.equal(readiness.code,'PYTHON_MISSING');assert.deepEqual(readiness.sources,[]);
  const j=await server.research.create({symbol:'600519',to:'2025-09-30',config:{timeframe:'5m'}});for(let i=0;i<100&&['queued','running'].includes(server.research.jobs.get(j.id).status);i++)await new Promise(r=>setTimeout(r,10));const task=server.research.jobs.get(j.id);assert.equal(task.status,'blocked');assert.equal(task.error.code,'PYTHON_MISSING');assert.equal(task.snapshotId,undefined);assert.equal(await fetchStatus(url),200);
 }finally{if(previous===undefined)delete process.env.ASHARE_PYTHON;else process.env.ASHARE_PYTHON=previous;if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
