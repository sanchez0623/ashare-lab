import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFile,mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import terms from './600188-action-terms.fixture.json' with {type:'json'};
import {slots} from '../dist/data.mjs';import {auditBundle} from '../dist/quality.mjs';import {CorporateLedger} from '../dist/corporate.mjs';
import {correctOfficialActions,verifyOfficialCorrections,officialEvidence} from '../dist/corporate-correction.mjs';
import {assembleBundles,canonical} from '../server/assemble.mjs';import {FileBucket} from '../scripts/local-server.mjs';import sourceWorker from '../server/worker.mjs';
const worker=process.env.ASHARE_TEST_BUILT_WORKER==='1'?(await import('../dist/server/index.js')).default:sourceWorker;
const hash=x=>createHash('sha256').update(x).digest('hex');

// Minute grids are synthetic. Only corporate terms/references come from the
// uploaded diagnostic; the user's full six real snapshots are not available.
function fragments(){
 const calendar=[];for(let d=new Date('2020-07-01T00:00:00Z');d.toISOString().slice(0,10)<='2026-09-30';d.setUTCDate(d.getUTCDate()+1))if(![0,6].includes(d.getUTCDay()))calendar.push(d.toISOString().slice(0,10));
 const daily=[],bars=[];let previous=18,factor=1;
 for(const date of calendar){
  const check=terms.checks.find(c=>c.exDate===date),next=terms.checks.find(c=>c.exDate>date),price=check?.dailyReference??next?.previousTradingClose??terms.checks.at(-1).dailyReference,reference=check?.dailyReference??previous;
  factor*=previous/reference;daily.push({date,open:price,high:price,low:price,close:price,prev_close:reference,volume:48000,halted:0,isST:0,knownAt:date+' 09:00',causalFactor:factor});previous=price;
  for(const time of slots(5))bars.push({date:date+' '+time,open:price,high:price,low:price,close:price,volume:1000,halted:0});
 }
 const parents=[];
 for(let year=2020;year<2026;year++){
  const from=year+'-10-01',to=(year+1)+'-09-30',start=calendar.filter(d=>d<from).at(-60),inRange=date=>date>=start&&date<=to;
  const bundle={schemaVersion:1,metadata:{symbol:'600188',name:'SYNTHETIC six-year grid with reported corporate terms',synthetic:true,source:'baostock',board:'main',listedDate:'1998-07-01',listingSessionOffset:5000,timeframe:'5m',priceBasis:'raw',volumeUnit:'shares',timezone:'Asia/Shanghai',timestampConvention:'bar-close',requested:{from:start,to},research:{from,to,warmupSessions:60},universe:'SINGLE_SECURITY',collectionPurpose:'market-data-only',coverage:Object.fromEntries(['calendar','daily','actions','factors'].map(k=>[k,{status:'complete',from:start,to,source:'synthetic fixture only'}]))},calendar,daily:daily.filter(d=>inRange(d.date)),bars:bars.filter(b=>inRange(b.date.slice(0,10))),actions:terms.actions.filter(a=>inRange(a.exDate)).map(a=>({...a})),factors:[],universe:[]};
  parents.push({id:hash(canonical(bundle)),bundle});
 }
 return {parents,input:{symbol:'600188',from:'2020-10-01',to:'2026-09-30',warmupSessions:60}};
}

test('all reviewed documents match pinned hashes and announced totals',async()=>{
 for(const e of officialEvidence.records){assert.equal(hash(await readFile(new URL('../dist'+e.localDocument,import.meta.url))),e.documentSHA256);assert.ok(Math.abs(e.regularCashPerShare+e.specialCashPerShare-e.terms.cashPerShare)<1e-12);}
});
test('reported 2021/2022 omissions correct from official evidence; raw data and unknown events stay intact',()=>{
 const {parents}=fragments(),parent=parents[2],original=canonical(parent.bundle),before=auditBundle(parent.bundle,{scope:'single-security'});assert.ok(before.blockingIssues.some(i=>i.code==='ACTION_ECONOMICS'));
 const fixed=correctOfficialActions(parent.bundle,parent.id),q=auditBundle(fixed.bundle,{scope:'single-security'});
 assert.equal(q.status,'passed');assert.equal(fixed.bundle.actions.find(a=>a.exDate==='2022-07-14').cashPerShare,2);assert.equal(fixed.changes.length,1);assert.deepEqual(fixed.bundle.daily,parent.bundle.daily);assert.deepEqual(fixed.bundle.bars,parent.bundle.bars);assert.equal(canonical(parent.bundle),original);
 assert.equal(correctOfficialActions(fixed.bundle).changes.length,0);verifyOfficialCorrections(fixed.bundle);
 for(const edit of [b=>b.actions[0].cashPerShare=.7,b=>b.actions[0].recordDate='2021-07-21',b=>b.daily.find(d=>d.date==='2021-07-23').prev_close=17.2]){const b=structuredClone(parents[0].bundle);edit(b);assert.throws(()=>correctOfficialActions(b),e=>e.code==='ACTION_CORRECTION_PROOF');}
 const unknown=structuredClone(parents[0].bundle);unknown.metadata.symbol='600519';assert.equal(correctOfficialActions(unknown).changes.length,0);assert.ok(auditBundle(unknown,{scope:'single-security'}).blockingIssues.some(i=>i.code==='ACTION_ECONOMICS'));
 const ledger=new CorporateLedger(terms.actions.filter(a=>['2021-07-23','2022-07-14'].includes(a.exDate)).map(a=>({...a,cashPerShare:a.exDate.startsWith('2021')?1:2})));
 ledger.record('2021-07-22',1000);assert.equal(ledger.open('2021-07-23',1000).cash,1000);assert.equal(ledger.open('2021-07-26',1000).cash,0);ledger.record('2022-07-13',1000);assert.equal(ledger.open('2022-07-14',1000).cash,2000);assert.equal(ledger.dividendTotal,3000);
});
test('six annual snapshots with existing 2023 proof assemble through API, retain warnings and reuse deterministic output',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-six-year-'));
 try{
  const {parents,input}=fragments();
  parents[3].bundle.actions.find(a=>a.exDate==='2023-07-17').cashPerShare=3.07;
  parents[3].bundle=correctOfficialActions(parents[3].bundle,hash(canonical(parents[3].bundle))).bundle;parents[3].id=hash(canonical(parents[3].bundle));
  parents[5].bundle.bars.find(b=>b.date==='2025-12-01 09:35').volume+=1000;parents[5].id=hash(canonical(parents[5].bundle));
  const original=parents.map(p=>canonical(p.bundle)),bucket=new FileBucket(dir);for(let i=0;i<parents.length;i++)await bucket.put('snapshots/'+parents[i].id+'.json',original[i]);
  const post=ids=>worker.fetch(new Request('http://localhost/api/data/assemble',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({...input,snapshots:ids})}),{BUCKET:bucket});
  const response=await post(parents.map(p=>p.id));assert.equal(response.status,201);const manifest=await response.json();assert.equal(manifest.report.status,'warning');assert.equal(manifest.assembly.parents.length,6);
  const merged=await (await bucket.get('snapshots/'+manifest.id+'.json')).json();verifyOfficialCorrections(merged);assert.equal(merged.actions.length,9);assert.equal(merged.actions[0].cashPerShare,1);assert.equal(merged.actions[1].cashPerShare,2);assert.equal(merged.actions[2].cashPerShare,4.3);assert.equal(merged.metadata.corporateCorrections.records.length,3);assert.deepEqual(merged.metadata.research,{from:input.from,to:input.to,warmupSessions:60});
  assert.deepEqual(merged.daily.map(d=>[d.date,d.close,d.prev_close]),[...new Map(parents.flatMap(p=>p.bundle.daily).map(d=>[d.date,d])).values()].filter(d=>d.date>=merged.metadata.requested.from&&d.date<=input.to).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>[d.date,d.close,d.prev_close]));
  const repeat=await post(parents.map(p=>p.id).reverse());assert.equal(repeat.status,200);assert.equal((await repeat.json()).id,manifest.id);
  for(let i=0;i<parents.length;i++)assert.equal((await bucket.get('snapshots/'+parents[i].id+'.json')).body.toString(),original[i]);
  const bad=structuredClone(parents);for(const p of bad)p.bundle.actions=p.bundle.actions.map(a=>a.exDate==='2025-06-18'?{...a,cashPerShare:.50}:a);
  assert.throws(()=>assembleBundles(bad,input),e=>e.code==='ASSEMBLY_ADMISSION'&&e.details.actionDiagnostics.checks.some(c=>c.exDate==='2025-06-18'&&c.economicsStatus==='failed'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
