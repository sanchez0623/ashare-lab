import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {startLocal,FileBucket} from '../scripts/local-server.mjs';
import worker from '../server/worker.mjs';
import {fixture} from './fixture.mjs';

test('local deployment serves UI and persists exact warehouse snapshots across restart',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-local-'));let server;
 try{
  server=await startLocal({port:0,dataDir:dir,worker});let url='http://127.0.0.1:'+server.address().port;
  const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/波段策略回测/);
  const raw=JSON.stringify(fixture()),id=createHash('sha256').update(raw).digest('hex');
  let r=await fetch(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json'},body:raw});assert.equal(r.status,201);const manifest=await r.json();assert.equal(manifest.id,id);assert.equal(manifest.report.status,'passed');
  const read=await fetch(url+'/api/data/bundle?id='+id);assert.equal(await read.text(),raw);
  r=await fetch(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json'},body:raw});assert.equal((await r.json()).reused,true);
  await new Promise(resolve=>server.close(resolve));server=await startLocal({port:0,dataDir:dir,worker});url='http://127.0.0.1:'+server.address().port;
  const catalog=await(await fetch(url+'/api/data/catalog')).json();assert.equal(catalog.entries[0].id,id);assert.equal(await(await fetch(url+'/api/data/bundle?id='+id)).text(),raw);
  const forbidden=await fetch(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json',origin:'https://example.com'},body:raw});assert.equal(forbidden.status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(url,{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(hostStatus,403);
  assert.equal((await fetch(url+'/%2e%2e%2fpackage.json')).status,403);
  assert.equal((await fetch(url+'/api/data/ingest',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(25*1024*1024+1)})).status,413);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
test('file warehouse paginates stable keys and rejects arbitrary paths',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-bucket-'));try{const b=new FileBucket(dir),ids=Array.from({length:103},(_,i)=>i.toString(16).padStart(64,'0'));
  for(const id of ids)await b.put('manifests/'+id+'.json',JSON.stringify({id}));const first=await b.list({limit:100}),next=await b.list({limit:100,cursor:first.cursor});assert.equal(first.objects.length,100);assert.equal(first.truncated,true);assert.equal(next.objects.length,3);assert.equal(next.truncated,false);assert.equal(new Set([...first.objects,...next.objects].map(x=>x.key)).size,103);
  assert.throws(()=>b.location('../secret'),/路径/);assert.equal(await b.get('snapshots/'+'f'.repeat(64)+'.json'),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
