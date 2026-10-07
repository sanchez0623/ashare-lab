import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {startLocal} from '../scripts/local-server.mjs';
import worker from '../server/worker.mjs';
import {trafficUsageHTML} from '../dist/traffic-ui.mjs';
test('monitor labels host-only counters, legacy attribution and HTTP egress uncertainty, escaping data',()=>{
 const html=trafficUsageHTML({day:'2026-10-07',requests:5,budget:10000,ipRequests:2,unattributedRequests:3,monitorIP:{ip:'9.9.9.9',source:'http-echo',httpProxyDetected:true,note:'<img src=x>'}});
 assert.match(html,/本机日累计 5/);assert.match(html,/HTTP echo 候选/);assert.match(html,/本机已记录请求 2/);assert.match(html,/3 次旧版/);assert.match(html,/未包含.*其他设备或项目/);assert.match(html,/均不清零/);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);
});
test('explicit monitor endpoint reads budget without login/reservation; foreign origins rejected; hosted mode cannot probe local IP',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ashare-traffic-')),budget=path.join(dir,'budget.db'),old={BS_MONITOR_IP:process.env.BS_MONITOR_IP,BAOSTOCK_BUDGET_PATH:process.env.BAOSTOCK_BUDGET_PATH};let server;
 try{
  process.env.BS_MONITOR_IP='9.9.9.9';process.env.BAOSTOCK_BUDGET_PATH=budget;
  execFileSync('python3',['-c',"import sys;sys.path.insert(0,'collector');from baostock_guard import TrafficGuard;g=TrafficGuard();g.reserve();g.close()"],{cwd:path.resolve('.'),env:process.env});const before=await readFile(budget);
  server=await startLocal({port:0,dataDir:path.join(dir,'data'),worker});const url='http://127.0.0.1:'+server.address().port+'/api/research/traffic';
  let r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:'https://example.invalid'},body:'{}'});assert.equal(r.status,403);await r.arrayBuffer();
  r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);const v=await r.json();assert.equal(v.requests,1);assert.equal(v.ipRequests,1);assert.equal(v.monitorIP.ip,'9.9.9.9');assert.equal(v.monitorIP.source,'environment');assert.equal(v.monitorIP.tcpEgressVerified,false);assert.equal(v.otherHostsCounted,false);assert.deepEqual(await readFile(budget),before);
  const hosted=await worker.fetch(new Request('https://example.invalid/api/research/traffic',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{});assert.equal(hosted.status,501);assert.equal((await hosted.json()).code,'TRAFFIC_LOCAL_ONLY');
 }finally{if(server)await new Promise(r=>server.close(r));for(const [k,v] of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;await rm(dir,{recursive:true,force:true});}
});
