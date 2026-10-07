import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accrue,startTiming,stopTiming,timingView,ensureTiming} from '../server/research-timing.mjs';

const job=()=>({stage:'collect',timing:{version:1,activeMs:0,stages:{},runs:[],accountedAt:null}});
test('timing excludes queue/pause/downtime, resumes cumulatively, and projects without mutation',()=>{
  const j=job();accrue(j,10000);assert.equal(j.timing.activeMs,0);
  startTiming(j,10000);accrue(j,13000);j.stage='validate';
  const projected=timingView(j,15000);assert.equal(projected.activeMs,5000);assert.equal(j.timing.activeMs,3000);
  stopTiming(j,16000,'paused');assert.equal(j.timing.activeMs,6000);assert.deepEqual(j.timing.stages,{collect:3000,validate:3000});
  accrue(j,900000);assert.equal(j.timing.activeMs,6000);
  j.stage='collect';startTiming(j,900000);stopTiming(j,904000,'completed');assert.equal(j.timing.activeMs,10000);
  assert.deepEqual(j.timing.runs.map(r=>[r.activeMs,r.stopReason]),[[6000,'paused'],[4000,'completed']]);
  assert.equal(timingView(j,9999999).activeMs,10000);
});
test('hard crash keeps last durable heartbeat and labels the unobserved tail; legacy time is not invented',()=>{
  const j=job();startTiming(j,10000);accrue(j,18000);
  const persisted=JSON.parse(JSON.stringify(j));stopTiming(persisted,1800000,'interrupted',{recovered:true});
  assert.equal(persisted.timing.activeMs,8000);assert.equal(persisted.timing.runs[0].endedAt,new Date(18000).toISOString());assert.ok(persisted.timing.interruptedTailUnmeasured);
  startTiming(persisted,1800000);stopTiming(persisted,1805000,'completed');assert.equal(persisted.timing.activeMs,13000);
  const legacy={createdAt:'2025-01-01',stage:'collect'};ensureTiming(legacy);assert.equal(legacy.timing.activeMs,0);assert.ok(legacy.timing.legacyUnmeasured);
});
