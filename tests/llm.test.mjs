import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {defaults} from '../dist/engine.mjs';
import {parameterContext} from '../dist/parameter-schema.mjs';
import {LLMGateway,hostedLLM,suggestParameters,validateProposal,validateProvider} from '../server/llm.mjs';
import {LocalLLM} from '../server/llm-local.mjs';

const p={id:'doubao',name:'测试服务',kind:'doubao',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'test-model-only',apiKey:'fixture-secret-never-a-real-key'};
const c={...defaults,dataMode:'demo'},input={providerId:p.id,instruction:'RSI周期改14，买入25，卖出75，止损6%。',config:parameterContext(c)};
const output={changes:{strategy:'rsi',rsiBuy:25,rsiSell:75,stop:6},explanation:'按明确要求修改；尚未回测。',warnings:[]};
const request=(route,body,origin='http://localhost')=>new Request('http://localhost'+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json',origin},body:body===undefined?undefined:JSON.stringify(body)});
const completion=value=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]}));

test('one compatible request carries parameter context only and returns validated changes without executing anything',async()=>{
 let calls=0;const result=await suggestParameters(p,input,{fetcher:async(url,options)=>{
  calls++;assert.equal(url,p.baseUrl+'/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer '+p.apiKey);
  const body=JSON.parse(options.body),user=JSON.parse(body.messages[1].content);assert.equal(body.model,p.model);assert.equal(body.stream,false);assert.deepEqual(user.current,input.config);assert.equal(body.messages.length,2);assert.equal(user.instruction,input.instruction);assert.ok(!JSON.stringify(body).includes(p.apiKey));assert.ok(!Object.hasOwn(user,'bars'));return completion(output);
 }});
 assert.equal(calls,1);assert.deepEqual(result.changes,output.changes);assert.equal(result.rows.length,4);assert.equal(result.unverified,true);assert.deepEqual(result.baseConfig,input.config);assert.ok(!JSON.stringify(result).includes(p.apiKey));assert.equal(c.strategy,'swing');
});
test('model changes are a closed schema: rules, unknown fields, invalid types, dates and coupling are rejected atomically',()=>{
 for(const changes of [{dataMode:'exploration'},{isST:0},{rulesMode:'manual'},{__unexpected:'run-code'},{macdFast:26,macdSlow:12,strategy:'macd'},{strategy:'rsi',rsiBuy:80,rsiSell:20},{from:'2026-02-30'},{capital:'1000000'},{allocation:30},{strategy:'ma',bbMult:2.5},{strategy:'rsi',rsiBuy:25.5},{commission:-1},{strategy:'macd',macdSignal:251}])assert.throws(()=>validateProposal({...output,changes},c),/校验/);
 assert.throws(()=>validateProposal({...output,script:'anything'},c),/约定/);
 assert.deepEqual(validateProposal({changes:{capital:c.capital},explanation:'不需修改',warnings:[]},c).changes,{});
 assert.equal(validateProposal({changes:{commission:.005,handling:.00341,capital:2000000},explanation:'资金修改',warnings:[]},c).changes.capital,2000000);
 assert.equal(validateProposal({changes:{strategy:'ma',allocation:20},explanation:'普通均线仓位20%',warnings:[]},c).changes.allocation,20);
});
test('endpoint controls reject credential URLs, redirects, metadata and hosted local targets while local services can omit keys',async()=>{
 for(const baseUrl of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?key=123','https://169.254.169.254/v1','https://127.0.0.1/v1','file:///tmp/api'])assert.throws(()=>validateProvider({...p,baseUrl}),/地址|HTTPS/);
 const local=validateProvider({...p,kind:'local',baseUrl:'http://127.0.0.1:11434/v1',apiKey:''},{local:true});
 await suggestParameters(local,input,{fetcher:async(_,o)=>{assert.ok(!Object.hasOwn(o.headers,'authorization'));return completion(output);}});
 assert.throws(()=>validateProvider({...p,apiKey:'bad\r\nkey'}),/Key/);
});
test('gateway does not expose keys, rejects cross-origin and user-supplied endpoints, and bounds paid calls',async()=>{
 let calls=0;const gateway=new LLMGateway({providers:()=>[p],fetcher:async()=>{calls++;return completion(output);},clock:()=>1000});
 const listed=await(await gateway.fetch(request('/api/llm/providers'))).json();assert.equal(listed.editable,false);assert.equal(listed.providers[0].hasKey,true);assert.ok(!JSON.stringify(listed).includes(p.apiKey));
 assert.equal((await gateway.fetch(request('/api/llm/suggest',input,'https://evil.example'))).status,403);assert.equal(calls,0);
 assert.equal((await gateway.fetch(request('/api/llm/suggest',{...input,baseUrl:'https://evil.example'}))).status,400);assert.equal(calls,0);
 for(let i=0;i<9;i++)assert.equal((await gateway.fetch(request('/api/llm/suggest',input))).status,200);
 assert.equal(calls,9);assert.equal((await gateway.fetch(request('/api/llm/suggest',input))).status,429);
 const hosted=await(await hostedLLM(request('/api/llm/providers'),{LLM_PROVIDERS_JSON:JSON.stringify([p])})).json();assert.equal(hosted.providers[0].id,p.id);assert.ok(!JSON.stringify(hosted).includes(p.apiKey));
 assert.equal((await hostedLLM(request('/api/llm/providers/save',{provider:p}),{LLM_PROVIDERS_JSON:JSON.stringify([p])})).status,404);
});
test('provider errors, truncation, invalid JSON and oversized responses never leak raw provider errors or trigger retry',async()=>{
 for(const response of [()=>new Response('vendor diagnostic '+p.apiKey,{status:401}),()=>new Response(JSON.stringify({choices:[{message:{content:'incomplete'},finish_reason:'length'}]})),()=>new Response('not JSON'),()=>completion({...output,explanation:'x'.repeat(70000)})]){
  let calls=0;const gateway=new LLMGateway({providers:()=>[p],fetcher:async()=>{calls++;return response();}}),r=await gateway.fetch(request('/api/llm/suggest',input)),body=await r.text();assert.equal(r.status,502);assert.equal(calls,1);assert.ok(!body.includes(p.apiKey));assert.ok(!body.includes('vendor diagnostic'));
 }
 const timeout=new LLMGateway({providers:()=>[p],timeoutMs:20,fetcher:(_,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))});const r=await timeout.fetch(request('/api/llm/suggest',input));assert.match((await r.json()).error,/超时/);
});
test('multiple local profiles persist atomically, blank keys retain credentials and destination changes require a new key',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ashare-llm-'));
 try{
  const local=await new LocalLLM({root}).init();
  for(const provider of [p,{...p,id:'local',name:'本地测试',kind:'local',baseUrl:'http://127.0.0.1:11434/v1',apiKey:''}]){const r=await local.fetch(request('/api/llm/providers/save',{provider}));assert.equal(r.status,200);assert.ok(!(await r.text()).includes(p.apiKey));}
  assert.equal((await new LocalLLM({root}).init()).saved.length,2);if(process.platform!=='win32')assert.equal((await stat(local.file)).mode&0o777,0o600);
  assert.equal((await local.fetch(request('/api/llm/providers/save',{provider:{...p,apiKey:'',name:'修改名称'}}))).status,200);assert.equal(local.saved.find(x=>x.id===p.id).apiKey,p.apiKey);
  assert.equal((await local.fetch(request('/api/llm/providers/save',{provider:{...p,apiKey:'',baseUrl:'https://another.example/v1'}}))).status,400);assert.ok((await readFile(local.file,'utf8')).includes(p.apiKey));
  assert.equal((await local.fetch(request('/api/llm/providers/save',{provider:{...p,apiKey:''},clearKey:true}))).status,200);assert.equal(local.saved.find(x=>x.id===p.id).apiKey,'');
  assert.equal((await local.fetch(request('/api/llm/providers/save',{removeId:p.id}))).status,200);assert.equal(local.saved.length,1);
  await writeFile(local.file,'broken');const damaged=await new LocalLLM({root}).init();assert.equal((await damaged.fetch(request('/api/llm/providers'))).status,503);assert.equal(await readFile(local.file,'utf8'),'broken');
 }finally{await rm(root,{recursive:true,force:true});}
});
