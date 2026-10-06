import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,demoMinuteData} from '../dist/engine.mjs';
import {tuningCandidates,tuneParameters,tuneManagement} from '../dist/parameter-tuning.mjs';
import {fixture} from './fixture.mjs';

const data=demoMinuteData().slice(0,48*500);
const config={...defaults,dataMode:'demo',management:'base',dailyFast:5,dailySlow:20,exitPeriod:5,breakout:5,confirmationDays:1,atrPeriod:5,maxExtensionATR:10,minTrades:5,to:data.at(-1).date.slice(0,10)};
const costKeys=['capital','commission','minCommission','stamp','handling','regulatory','transfer','slippage','taxMode','baseAllocation','riskBudget','management','from','to'];

test('local candidates keep exact current values, fees and risk rules; bounds deduplicate instead of expanding search',()=>{
 const c={...config,dailySlow:249,atrMult:.1,confirmationDays:10};const search=tuningCandidates(c);
 assert.ok(search.candidates.length<=27);assert.equal(new Set(search.candidates.map(r=>r.id)).size,search.candidates.length);
 assert.ok(search.candidates.some(r=>r.config.dailySlow===249&&r.config.atrMult===.1&&r.config.confirmationDays===10));
 for(const row of search.candidates){assert.ok(row.config.dailySlow>c.dailyFast&&row.config.dailySlow<=250);assert.ok(row.config.atrMult>=0);assert.ok(row.config.confirmationDays<=10);for(const key of costKeys)assert.equal(row.config[key],c[key]);}
 assert.throws(()=>tuningCandidates(config,{dailySlowStep:0}),/步长/);assert.throws(()=>tuningCandidates({...config,strategy:'rsi'}),/大波段/);
});
test('automatic tuning ranks on training only, preserves inputs and reproduces results under the same snapshot',()=>{
 const before=JSON.stringify(data),progress=[];const first=tuneParameters(data,config,{},p=>progress.push(p));
 assert.equal(first.selectionRule,'training_quality_only');assert.ok(first.recommendation);assert.ok(first.qualified>0);assert.equal(JSON.stringify(data),before);
 assert.equal(progress.filter(p=>p.phase==='training').length,first.rows.length);assert.equal(progress.filter(p=>p.phase==='validation').length,first.rows.length);
 assert.deepEqual(tuneParameters(data,config),first);
 const changed=structuredClone(data);for(const r of changed)if(r.date.slice(0,10)>=first.validationFrom)for(const k of ['open','high','low','close','prev_close'])r[k]*=.7;
 const second=tuneParameters(changed,config);
 assert.deepEqual(second.rows.map(r=>[r.id,r.training,r.quality]),first.rows.map(r=>[r.id,r.training,r.quality]));assert.deepEqual(second.recommendation,first.recommendation);assert.notEqual(second.baseline.validation.total,first.baseline.validation.total);
 for(const r of first.rows)for(const k of costKeys)assert.equal(r.config[k],config[k]);
 assert.equal(first.baseline.trainingDelta,0);assert.equal(first.baseline.validationDelta,0);assert.ok(first.trainTo<first.validationFrom);
});
test('tuning cannot manufacture qualification from a small sample, missing warmup or blocked historical data',()=>{
 const b=fixture(100),c={...defaults,from:b.calendar[60],to:b.calendar.at(-1),dataMode:'formal'};
 const result=tuneParameters(b,c);assert.equal(result.recommendation,null);assert.equal(result.qualified,0);
 assert.ok(result.rows.some(r=>r.config.dailySlow===65&&r.error?.includes('65')));assert.equal(result.baseline.quality.reason,'已平仓样本不足');
 assert.throws(()=>tuneParameters(b,{...c,dailySlow:90}),/90/);
 const missing=structuredClone(b);delete missing.daily[61].isST;assert.throws(()=>tuneParameters(missing,c),/准入失败/);
 const management=tuneManagement(b,c);assert.equal(management.rows.length,5);assert.equal(management.baseline.config.management,'base');assert.equal(management.recommendation,null);assert.equal(management.selectionRule,'training_quality_only');
 for(const row of management.rows)for(const k of costKeys.filter(k=>k!=='management'))assert.equal(row.config[k],c[k]);
});
