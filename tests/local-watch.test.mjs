import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,chmod,appendFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureSources,prepareRuntime,LocalWatcher,resolvePython} from '../scripts/local-watch.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=15000){const started=Date.now();while(Date.now()-started<timeout){const value=await check();if(value)return value;await wait(50);}throw Error('watch condition timed out');}
async function copySources(target){const snapshot=await captureSources(project);for(const [name,bytes] of snapshot.files){await mkdir(path.dirname(path.join(target,name)),{recursive:true});await writeFile(path.join(target,name),bytes);}}

test('source capture excludes secrets, data, generated builds and Python environments',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ashare-watch-files-'));
  try{
    for(const name of ['dist/app.js','dist/client/generated.js','dist/server/generated.js','server/sample.mjs','collector/sources.py','collector/.venv/secret.py','collector/store/private.json','scripts/local-server.mjs','.env','.local-data/private.json','collector/token.json','dist/archive.zip']){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),name);}
    const a=await captureSources(root);assert.deepEqual([...a.files.keys()].sort(),['collector/sources.py','dist/app.js','scripts/local-server.mjs','server/sample.mjs']);
    await writeFile(path.join(root,'collector/token.json'),'new secret');assert.equal((await captureSources(root)).revision,a.revision);
    await writeFile(path.join(root,'dist/app.js'),'new UI');assert.notEqual((await captureSources(root)).revision,a.revision);
    assert.equal(await resolvePython(root,{ASHARE_PYTHON:'selected executable'}),'selected executable');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('candidate validation preserves the previous runtime and distinguishes UI from backend changes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ashare-watch-build-')),dataDir=path.join(root,'data');let a,b;
  try{
    await copySources(root);a=await prepareRuntime(await captureSources(root),{root,dataDir,python:'python3'});
    await appendFile(path.join(root,'dist/style.css'),'\n/* frontend only */');b=await prepareRuntime(await captureSources(root),{root,dataDir,python:'python3'});
    assert.notEqual(a.revision,b.revision);assert.equal(a.backendRevision,b.backendRevision);
    await appendFile(path.join(root,'dist/engine.mjs'),'\nexport const invalid = ;');
    await assert.rejects(prepareRuntime(await captureSources(root),{root,dataDir,python:'python3'}));
    assert.match(await readFile(path.join(a.root,'dist/engine.mjs'),'utf8'),/function/);await access(path.join(a.assetsDir,'index.html'));
    assert.equal((await readFile(path.join(a.root,'dist/engine.mjs'),'utf8')).includes('export const invalid'),false);
    await writeFile(path.join(root,'dist/engine.mjs'),await readFile(path.join(a.root,'dist/engine.mjs')));await appendFile(path.join(root,'collector/sources.py'),'\ndef broken(:\n');
    await assert.rejects(prepareRuntime(await captureSources(root),{root,dataDir,python:'python3'}),/Python源码检查失败/);await access(path.join(a.root,'collector/sources.py'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('watch reload saves checkpoints, resumes compatible tasks and preserves manual pauses', {skip:process.platform==='win32',timeout:60000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ashare watcher 研究 #%-')),root=path.join(dir,'project'),dataDir=path.join(dir,'data'),fakePython=path.join(dir,'fake-python');let watcher;
  try{
    await copySources(root);
    // No SDK or market network calls. A fake collector persists one query and
    // waits to be interrupted; the next invocation reuses the saved query.
    await writeFile(fakePython,`#!/usr/bin/env python3
import sys,pathlib,json,time
if sys.argv[1]=='-c':
 code=sys.argv[2];sys.argv=['-c']+sys.argv[3:];exec(code);sys.exit(0)
if pathlib.Path(sys.argv[1]).name=='research_collect.py':
 root=pathlib.Path(sys.argv[sys.argv.index('--root')+1]);root.mkdir(parents=True,exist_ok=True)
 with (root/'attempts.txt').open('a') as f:f.write('invoked\\n')
 if not (root/'checkpoint.json').exists():(root/'checkpoint.json').write_text('verified original response')
 print(json.dumps({'query':['minute','test-month'],'phase':'query-complete','queryElapsedMs':10,'requests':1,'rows':48,'checkpoints':1}),flush=True)
 while True:time.sleep(.1)
print(json.dumps({'sources':[],'probePolicy':'test: no market request'}))
`);await chmod(fakePython,0o755);
    const logs=[];watcher=await new LocalWatcher({root,port:0,dataDir,pollMs:50,debounceMs:120,env:{...process.env,ASHARE_PYTHON:fakePython},log:m=>logs.push(m)}).start();
    const url='http://127.0.0.1:'+watcher.port;
    const api=async(route,body)=>{const r=await fetch(url+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});assert.ok(r.ok,await r.clone().text());return r.json();};
    const created=await api('/api/research/jobs',{purpose:'collect',symbol:'600519',from:'2025-10-01',to:'2026-09-30',config:{timeframe:'5m'}});
    const statePath=path.join(dataDir,'research/jobs',created.id,'state.json'),collection=path.join(dataDir,'research/jobs',created.id,'collection');
    const state=async()=>JSON.parse(await readFile(statePath,'utf8'));
    await until(async()=>{try{return (await readFile(path.join(collection,'attempts.txt'),'utf8')).includes('invoked');}catch{return false;}});
    const pid=watcher.child.pid,revision=watcher.applied;
    await appendFile(path.join(root,'dist/style.css'),'\n/* UI edit */');await until(()=>watcher.applied!==revision);
    assert.equal(watcher.child.pid,pid);assert.equal((await state()).status,'running');
    const checkpoint=await readFile(path.join(collection,'checkpoint.json'),'utf8'),before=(await state()).timing.activeMs;
    const beforeBackend=watcher.applied;await appendFile(path.join(root,'scripts/local-server.mjs'),'\n// Compatible backend reload test\n');
    await until(()=>watcher.child?.pid!==pid&&watcher.applied!==beforeBackend);
    await until(async()=>{try{return (await readFile(path.join(collection,'attempts.txt'),'utf8')).trim().split('\n').length===2;}catch{return false;}});
    const resumed=await state();assert.equal(resumed.status,'running');assert.equal(resumed.id,created.id);assert.equal(resumed.requestHash,created.requestHash);assert.equal(resumed.timing.runs.length,2);assert.ok(resumed.timing.activeMs>=before);assert.equal(await readFile(path.join(collection,'checkpoint.json'),'utf8'),checkpoint);
    // A syntactically valid candidate that fails before listening rolls back,
    // with the same task/checkpoint automatically restored by the old runtime.
    const entry=path.join(root,'scripts/local-server.mjs'),goodEntry=await readFile(entry,'utf8'),beforeFailure=watcher.applied;
    await writeFile(entry,"throw new Error('Mock startup failure');\n"+goodEntry);
    await until(async()=>{try{return (await api('/api/local/status')).state==='error';}catch{return false;}});
    assert.equal(watcher.applied,beforeFailure);await until(async()=>{try{return (await readFile(path.join(collection,'attempts.txt'),'utf8')).trim().split('\n').length===3;}catch{return false;}});assert.equal((await state()).status,'running');assert.equal(await readFile(path.join(collection,'checkpoint.json'),'utf8'),checkpoint);
    await writeFile(entry,goodEntry);await until(async()=>{try{return (await api('/api/local/status')).state==='ready';}catch{return false;}});
    await api('/api/research/jobs/'+created.id+'/pause',{});const pausedPID=watcher.child.pid,beforePaused=watcher.applied;
    await appendFile(path.join(root,'scripts/local-server.mjs'),'\n// Reload must not resume a manual pause\n');await until(()=>watcher.child?.pid!==pausedPID&&watcher.applied!==beforePaused);
    assert.equal((await state()).status,'paused');assert.equal((await readFile(path.join(collection,'attempts.txt'),'utf8')).trim().split('\n').length,3);
    // Invalid JS must keep the working backend and frozen Python version.
    const goodPID=watcher.child.pid;await appendFile(path.join(root,'dist/engine.mjs'),'\nexport const syntaxError = ;');
    await until(async()=>{try{return (await api('/api/local/status')).state==='error';}catch{return false;}});assert.equal(watcher.child.pid,goodPID);assert.equal((await fetch(url)).status,200);
    const broken=await readFile(path.join(root,'dist/engine.mjs'),'utf8');await writeFile(path.join(root,'dist/engine.mjs'),broken.replace('\nexport const syntaxError = ;',''));await until(async()=>{try{return (await api('/api/local/status')).state==='ready';}catch{return false;}});
    await api('/api/research/jobs/'+created.id+'/resume',{});await until(async()=>(await state()).status==='running');
    const incompatiblePID=watcher.child.pid,beforeIncompatible=watcher.applied;await appendFile(path.join(root,'collector/sources.py'),'\n# unknown pipeline must not silently migrate\n');await until(()=>watcher.child?.pid!==incompatiblePID&&watcher.applied!==beforeIncompatible);
    await until(async()=>{try{return (await state()).status==='blocked';}catch{return false;}});assert.equal((await state()).error.code,'PIPELINE_CHANGED');assert.ok(logs.some(m=>m.includes('前端已更新')));assert.ok(logs.some(m=>m.includes('后台重载完成')));
  }finally{if(watcher)await watcher.close();await rm(dir,{recursive:true,force:true});}
});
