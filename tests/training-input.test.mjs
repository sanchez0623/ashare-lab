import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults} from '../dist/engine.mjs';
import {validateTrainingInputs,trainingInputIssue} from '../dist/training-input.mjs';
import {normalizeRequest} from '../server/research.mjs';
test('precise training gate errors without silently relaxing requirements',()=>{
 assert.throws(()=>validateTrainingInputs({...defaults,minTrades:3}),e=>e.parameter==='minTrades'&&/5–500/.test(e.message));
 assert.equal(trainingInputIssue('minTrades',5),null);assert.equal(trainingInputIssue('minTrades',2.5).key,'minTrades');assert.equal(trainingInputIssue('minProfitFactor',.5).key,'minProfitFactor');
});
test('user acquisition payload ignores unrelated strategy gates, gives top-level dates priority, preserves periods',()=>{
 const payload={purpose:'collect',rangeMode:'custom',from:'2020-10-01',to:'2023-09-30',symbol:'600188',config:{...defaults,timeframe:'5m',dataMode:'single',management:'base',minTrades:3,from:'2023-10-01',to:'2026-09-30',snapshotId:'1b6b264a42eb1d48708b4ac9ada87ac8bb627fc6b01a1a2a86df4a1b86b87e5c'}};
 const req=normalizeRequest(payload);assert.equal(req.from,payload.from);assert.equal(req.config.from,payload.from);assert.equal(req.config.to,payload.to);assert.equal(req.config.minTrades,3);assert.equal(req.config.snapshotId,undefined);assert.equal(req.warmupSessions,60);
 assert.throws(()=>normalizeRequest({...payload,purpose:'research'}),e=>e.code==='REQUEST'&&e.details.parameter==='minTrades'&&/5–500/.test(e.message));
 for(const update of [{symbol:'bad'},{from:'2020-02-30'},{config:{dailySlow:NaN}},{config:{timeframe:'1m'}},{budget:50000},{warmupSessions:59}])assert.throws(()=>normalizeRequest({...payload,...update}),e=>e.code==='REQUEST');
});
