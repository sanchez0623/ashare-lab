import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,demoMinuteData} from '../dist/engine.mjs';
import {tuningCandidates,tuneParameters,tuneManagement} from '../dist/parameter-tuning.mjs';
import {fixture} from './fixture.mjs';
import {assessWarmup} from '../dist/warmup.mjs';

const data=demoMinuteData().slice(0,48*500);
const config={...defaults,dataMode:'demo',management:'base',dailyFast:5,dailySlow:20,exitPeriod:5,breakout:5,confirmationDays:1,atrPeriod:5,maxExtensionATR:10,minTrades:5,to:data.at(-1).date.slice(0,10)};
const costKeys=['capital','commission','minCommission','stamp','handling','regulatory','transfer','slippage','taxMode','baseAllocation','riskBudget','management','from','to'];

test('local candidates keep exact current values, fees and risk rules; bounds deduplicate instead of expanding search',()=>{
 const c={...config,dailySlow:249,atrMult:.1,confirmationDays:10};const search=tuningCandidates(c);
 assert.ok(search.candidates.length<=27);assert.equal(new Set(search.candidates.map(r=>r.id)).size,search.candidates.length);
 assert.ok(search.candidates.some(r=>r.config.dailySlow===249&&r.config.atrMult===.1&&r.config.confirmationDays===10));
 for(const row of search.candidates){assert.ok(row.config.dailySlow>c.dailyFast&&row.config.dailySlow<=250);assert.ok(row.config.atrMult>=0);assert.ok(row.config.confirmationDays<=10);for(const key of costKeys)assert.equal(row.config[key],c[key]);}
 assert.throws(()=>tuningCandidates(config,{dailySlowStep:0}),/步长/);
});
test('all strategy grids tune their own meaningful fields, keep baselines and filter coupled bounds',()=>{
 const fields={swing:['dailySlow','atrMult','confirmationDays'],ma:['fast','slow'],macd:['macdFast','macdSlow','macdSignal'],rsi:['rsiPeriod','rsiBuy','rsiSell'],boll:['bbPeriod','bbMult']};
 for(const strategy of Object.keys(fields)){
  const c={...config,strategy},search=tuningCandidates(c);assert.equal(search.candidates.length,strategy==='ma'||strategy==='boll'?9:strategy==='swing'?18:27);
  assert.ok(search.candidates.some(r=>fields[strategy].every(k=>r.config[k]===c[k])));
  for(const row of search.candidates)for(const key of Object.keys(c).filter(k=>!fields[strategy].includes(k)))assert.equal(row.config[key],c[key]);
 }
 for(const c of [{...config,strategy:'ma',fast:29,slow:30},{...config,strategy:'macd',macdFast:25,macdSlow:26},{...config,strategy:'rsi',rsiBuy:49,rsiSell:50},{...config,strategy:'boll',bbMult:.1,bbPeriod:250}]){
  const search=tuningCandidates(c);assert.ok(search.candidates.length>0&&search.candidates.length<=27);assert.equal(new Set(search.candidates.map(r=>r.id)).size,search.candidates.length);for(const row of search.candidates){assert.ok(row.config.fast<row.config.slow);assert.ok(row.config.macdFast<row.config.macdSlow);assert.ok(row.config.rsiBuy<row.config.rsiSell);}
 }
});
test('held-out price changes cannot alter recommendation or training ranking for the other four strategies',()=>{
 const input=data.slice(0,48*150),c={...config,from:input[48*50].date.slice(0,10),to:input.at(-1).date.slice(0,10)};
 for(const strategy of ['ma','macd','rsi','boll']){
  const first=tuneParameters(input,{...c,strategy}),changed=structuredClone(input);
  for(const r of changed)if(r.date.slice(0,10)>=first.validationFrom)for(const key of ['open','high','low','close','prev_close'])r[key]*=.7;
  const second=tuneParameters(changed,{...c,strategy});assert.deepEqual(second.recommendation,first.recommendation);assert.deepEqual(second.rows.map(r=>[r.id,r.training,r.quality]),first.rows.map(r=>[r.id,r.training,r.quality]));assert.ok(first.rows.every(r=>r.config.strategy===strategy));assert.equal(first.baseline.trainingDelta,0);assert.equal(first.baseline.validationDelta,0);
 }
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
 assert.throws(()=>tuneParameters(b,c),e=>e.code==='TUNING_WARMUP'&&e.warmup.requiredDailySessions===65&&e.warmup.availableDailySessions===60);
 const enough={...c,from:b.calendar[65]},result=tuneParameters(b,enough);assert.equal(result.recommendation,null);assert.equal(result.qualified,0);assert.ok(result.rows.every(r=>!r.error));assert.equal(result.baseline.quality.reason,'已平仓样本不足');
 assert.throws(()=>tuneParameters(b,{...c,dailySlow:90}),/95/);
 const missing=structuredClone(b);delete missing.daily[61].isST;assert.throws(()=>tuneParameters(missing,enough),/准入失败/);
 const management=tuneManagement(b,c);assert.equal(management.rows.length,5);assert.equal(management.baseline.config.management,'base');assert.equal(management.recommendation,null);assert.equal(management.selectionRule,'training_quality_only');
 for(const row of management.rows)for(const k of costKeys.filter(k=>k!=='management'))assert.equal(row.config[k],c[k]);
});

test('preflight counts completed daily history rather than minute rows, keeps study dates, and covers execution-period indicators',()=>{
 const b=fixture(120),c={...defaults,dataMode:'formal',from:b.calendar[60],to:b.calendar.at(-1),dailySlow:60};
 const configs=tuningCandidates(c,{dailySlowStep:3}).candidates.map(r=>r.config),w=assessWarmup(b,c,configs);
 assert.equal(w.requiredDailySessions,63);assert.equal(w.availableDailySessions,60);assert.equal(w.missingDailySessions,3);assert.equal(w.sufficient,false);assert.equal(w.researchFrom,c.from);
 const before=JSON.stringify(b);let progress=0;assert.throws(()=>tuneParameters(b,c,{dailySlowStep:3},()=>progress++),e=>e.code==='TUNING_WARMUP'&&e.warmup.requiredCollectionSessions===63);assert.equal(progress,0);assert.equal(JSON.stringify(b),before);
 const partial=structuredClone(b);partial.bars=partial.bars.filter(r=>r.date!==b.calendar[10]+' 10:00');assert.equal(assessWarmup(partial,c,configs).availableDailySessions,59);
 const halted=structuredClone(b);halted.bars=halted.bars.filter(r=>r.date.slice(0,10)!==b.calendar[10]);halted.daily[10].halted=1;assert.equal(assessWarmup(halted,c,configs).availableDailySessions,60);
 const daily={...c,strategy:'ma',timeframe:'1d',fast:10,slow:60},ma=tuningCandidates(daily).candidates.map(r=>r.config);assert.equal(assessWarmup(b,daily,ma).missingExecutionBars,5);assert.equal(assessWarmup(b,daily,ma).requiredDailySessions,0);
 const longer=fixture(125),longConfig={...c,from:longer.calendar[65],to:longer.calendar.at(-1)};assert.ok(assessWarmup(longer,longConfig,configs).sufficient);
});
