import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ResearchManager} from '../server/research.mjs';
import {FileBucket} from '../scripts/local-server.mjs';
import {fixture} from './fixture.mjs';

test('reload never silently resumes a formal research task under a different engine',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-reload-engine-')),bucket=new FileBucket(path.join(dir,'warehouse')),b=fixture(90);let manager,calls=0,entered;const started=new Promise(r=>entered=r);
 const options={root:path.join(dir,'research'),bucket,collector:async(_request,_root,signal)=>{calls++;entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('reload')),{once:true}));return b;}};
 try{
  manager=await new ResearchManager(options).init();const j=await manager.create({symbol:'600519',from:b.calendar[65],to:b.calendar.at(-1),config:{timeframe:'5m'}});await started;
  manager.jobs.get(j.id).engineHash='0'.repeat(64);await manager.close({reload:true});
  manager=await new ResearchManager(options).init();const blocked=manager.jobs.get(j.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.error.code,'ENGINE_CHANGED');assert.equal(blocked.reloadResume,undefined);assert.equal(blocked.requestHash,j.requestHash);assert.equal(calls,1);
 }finally{if(manager)await manager.close();await rm(dir,{recursive:true,force:true});}
});
