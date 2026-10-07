// Real UI and persistence, simulated provider candles only; zero market calls.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,rm}=require('node:fs/promises');
(async()=>{
 const {startLocal}=await import('../scripts/local-server.mjs'),{fixture}=await import('./fixture.mjs'),{stable,textHash}=await import('../dist/minute-repair.mjs');
 const good=fixture(100);delete good.metadata.synthetic;Object.assign(good.metadata,{symbol:'001389',source:'baostock',universe:'SINGLE_SECURITY',collectionPurpose:'market-data-only',name:'模拟传输测试，不是真实行情'});good.universe=[];good.metadata.coverage.universe={status:'not-requested'};
 const bad=structuredClone(good),day=bad.calendar[65];for(const r of bad.bars)if(r.date.startsWith(day))r.volume*=2;
 const rows=good.bars.map(r=>Object.fromEntries(['date','open','high','low','close','volume'].map(k=>[k,r[k]]))),raw=rows.map(({date,...r})=>({datetime:date,...r,vol:r.volume})),rawJSON=stable(raw);
 const batch={source:'mootdx',symbol:'001389',kind:'minute5',requested:good.metadata.requested,metadata:{priceBasis:'raw',nativeTimeframe:'5m',volumeUnit:'provider-unverified',rawSHA256:await textHash(rawJSON)},rows,raw,rawJSON};
 const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-repair-ui-'));let calls=0;const server=await startLocal({port:0,dataDir:dir,repairOptions:{collector:async(_r,_d,signal)=>{calls++;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,6500);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('pause'));},{once:true});});return batch;},archiver:async b=>b}}),base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ingest=await page.request.post(base+'/api/data/ingest',{data:bad});assert.equal(ingest.status(),201);const originalId=(await ingest.json()).id;
  const csrf=await page.request.post(base+'/api/research/repairs',{headers:{Origin:'https://example.invalid'},data:{snapshotId:originalId}});assert.equal(csrf.status(),403);
  await page.goto(base,{waitUntil:'networkidle'});await page.locator('nav [data-view=data]').click();await page.locator('[data-bundle="0"]').click();await page.waitForFunction(()=>!document.querySelector('#minute-repair-start').disabled);assert.match(await page.locator('#minute-repair-context').innerText(),/001389.*1 个异常日/);
  await page.locator('#minute-repair-start').click();await page.waitForFunction(()=>document.querySelector('[data-repair-logs]'));await page.locator('[data-repair-logs] summary').click();await page.waitForTimeout(5300);assert.ok(await page.locator('[data-repair-logs]').evaluate(e=>e.open),'logs must remain open after refresh');
  await page.waitForFunction(()=>document.querySelector('[data-repair-load]'),{},{timeout:20000});await page.locator('[data-repair-load]').click();await page.waitForFunction(()=>document.querySelector('#quality-status').textContent.includes('校验通过'));assert.equal(calls,1);
  await page.locator('[data-repair-action=verify]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('没有请求行情供应商'));assert.equal(calls,1);
  for(const width of [360,421,828,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'repair panel overflow '+width);}
  const list=await page.request.get(base+'/api/research/repairs'),j=(await list.json()).jobs[0];assert.equal(j.status,'completed');const original=await page.request.get(base+'/api/data/bundle?id='+originalId);assert.equal((await original.json()).bars.find(r=>r.date.startsWith(day)).volume,20000);
  await page.screenshot({path:'/workspace/scratch/minute-repair-ui.png'});assert.deepEqual(errors,[]);console.log('Second-minute-source repair UI passed: fixed original snapshot, strict all-day evidence, new snapshot loading, zero-call repeat, expanded logs survive refresh, same-origin protection, and four viewport widths. Simulated source fixtures only.');
 }finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
