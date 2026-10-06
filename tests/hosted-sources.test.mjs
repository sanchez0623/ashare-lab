import test from 'node:test';
import assert from 'node:assert/strict';
import {hostedSourceStatus,probeLixinger} from '../server/hosted-sources.mjs';
function setup(){const data=new Map();return {data,env:{'lixingren-key':'test-private-secret',BUCKET:{get:async k=>data.has(k)?{json:async()=>JSON.parse(data.get(k))}:null,put:async(k,v)=>data.set(k,v)}}};}
const request=origin=>new Request('https://example.test/api/sources/lixinger/probe',{method:'POST',headers:origin?{origin}:{}});
const bar={date:'2026-09-30T00:00:00+08:00',open:1500,high:1510,low:1490,close:1505,volume:100000};
test('hosted readiness exposes no credential and never calls the provider',async()=>{
 const {env,data}=setup();const response=await hostedSourceStatus(env),body=await response.json();assert.equal(body.backend,'hosted');assert.equal(body.lixinger.configured,true);assert.equal(body.sources.find(s=>s.name==='lixinger').health.state,'ready-unprobed');assert.equal(data.size,0);assert.ok(!JSON.stringify(body).includes(env['lixingren-key']));
});
test('explicit daily probe uses private alias and caches one request without formal admission',async()=>{
 const {env,data}=setup();let calls=0;const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://open.lixinger.com/api/cn/company/candlestick');assert.equal(JSON.parse(options.body).token,env['lixingren-key']);return Response.json({code:1,data:[bar]});};
 const a=await (await probeLixinger(request(),env,fetcher)).json(),b=await (await probeLixinger(request(),env,fetcher)).json();assert.equal(a.ok,true);assert.equal(a.formalAdmission,false);assert.equal(a.bars,1);assert.equal(b.cached,true);assert.equal(calls,1);assert.equal(data.size,2);assert.ok(!JSON.stringify([...data]).includes(env['lixingren-key']));assert.ok(!JSON.stringify(a).includes(env['lixingren-key']));
 const status=await (await hostedSourceStatus(env)).json();assert.equal(status.sources.find(s=>s.name==='lixinger').health.state,'healthy');
});
test('paid probe rejects cross-origin and missing credentials before any request',async()=>{
 const {env}=setup();let calls=0;const fetcher=async()=>{calls++;};assert.equal((await probeLixinger(request('https://attacker.test'),env,fetcher)).status,403);delete env['lixingren-key'];assert.equal((await probeLixinger(request(),env,fetcher)).status,503);assert.equal(calls,0);
});
test('provider errors are redacted and failures are cached without automatic retries',async()=>{
 const {env}=setup();let calls=0;const fetcher=async()=>{calls++;throw Error('response leaked test-private-secret');};const result=await (await probeLixinger(request(),env,fetcher)).json();assert.equal(result.ok,false);assert.equal(result.code,'PROVIDER_REQUEST_FAILED');assert.ok(!JSON.stringify(result).includes(env['lixingren-key']));await probeLixinger(request(),env,fetcher);assert.equal(calls,1);
});
test('daily probe rejects malformed prices and timestamps',async()=>{
 for(const bad of [{...bar,high:1},{...bar,date:'2026-10-01'},{...bar,volume:null}]){const {env}=setup();const result=await (await probeLixinger(request(),env,async()=>Response.json({code:1,data:[bad]}))).json();assert.equal(result.ok,false);assert.equal(result.code,'DATA_VALIDATION_FAILED');}
});
