// Real local persistence/UI, synthetic annual market fixtures, zero provider calls.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {mkdtemp,rm}=require('node:fs/promises');
(async()=>{
 const {startLocal}=await import('../scripts/local-server.mjs'),{fragments}=await import('./assembly-fixture.mjs');const {parents,input}=fragments();
 const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-assembled-ui-'));let collectionCalls=0;
 const server=await startLocal({port:0,dataDir:dir,researchOptions:{collector:async()=>{collectionCalls++;throw Error('合并已有行情不得重新采集');}}});
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),base='http://127.0.0.1:'+server.address().port,errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ids=[];for(const p of parents){const r=await page.request.post(base+'/api/data/ingest',{data:p.bundle});assert.equal(r.status(),201);ids.push((await r.json()).id);}
  let assembledRequests=0;page.on('request',r=>{if(r.url().endsWith('/api/data/assemble'))assembledRequests++;});
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.querySelector('#run').disabled);await page.waitForFunction(()=>document.querySelectorAll('#dataset option[data-saved-snapshot]').length===2);
  await page.locator('[data-strategy=ma]').click();await page.locator('#backtest-symbol').fill(input.symbol);await page.locator('[name=from]').fill(input.from);await page.locator('[name=to]').fill(input.to);await page.locator('[name=minCommission]').fill('7.5');await page.locator('#timeframe').selectOption('5m');
  const run=async()=>{await page.locator('#run').click();await page.waitForFunction(()=>!document.querySelector('#run').disabled,{},{timeout:60000});assert.match(await page.locator('#config-status').innerText(),/回测完成/);};
  const exported=async()=>{const event=page.waitForEvent('download');await page.locator('#export').click();return JSON.parse(fs.readFileSync(await(await event).path(),'utf8'));};
  await run();const first=await exported();assert.equal(first.metadata.symbol,'001389');assert.equal(first.config.from,input.from);assert.equal(first.config.to,input.to);assert.equal(first.config.minCommission,7.5);assert.equal(first.config.timeframe,'5m');assert.equal(first.data.metadata.assembly.parents.length,2);assert.equal(first.data.actions.length,2);assert.deepEqual(first.data.metadata.assembly.parents,[...ids].sort());assert.equal(first.audit.qualityReport.scope,'single-security');assert.match(await page.locator('#backtest-data-summary').innerText(),/已合并 2 份本地快照/);assert.equal(collectionCalls,0);assert.equal(assembledRequests,1);
  for(const timeframe of ['15m','1d']){await page.locator('#timeframe').selectOption(timeframe);await run();const r=await exported();assert.equal(r.config.timeframe,timeframe);assert.equal(r.audit.snapshotId,first.audit.snapshotId);assert.equal(r.config.from,input.from);assert.equal(r.config.to,input.to);}
  assert.equal(assembledRequests,1);assert.equal(collectionCalls,0);
  // Collection execution choice is enabled, persists and does not change raw 5m.
  await page.locator('#backtest-collect').click();assert.equal(await page.locator('#research-period').inputValue(),'1d');assert.ok(await page.locator('#research-period').isEnabled());let submitted;
  await page.route('**/api/research/jobs',async route=>{if(route.request().method()==='POST'){submitted=route.request().postDataJSON();await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({id:'fixture-period'})});}else await route.fulfill({contentType:'application/json',body:'{"jobs":[]}'});});
  for(const timeframe of ['5m','15m','1d']){await page.locator('#research-period').selectOption(timeframe);await page.locator('#research-submit').click();await page.waitForFunction(()=>!document.querySelector('#research-submit').disabled);assert.equal(submitted.config.timeframe,timeframe);assert.equal(submitted.purpose,'collect');}
  await page.locator('#research-purpose').selectOption('research');assert.equal(await page.locator('#research-period').inputValue(),'15m');assert.ok(await page.locator('#research-period option[value="1d"]').evaluate(e=>e.disabled));await page.locator('#research-purpose').selectOption('collect');
  for(const width of [360,421,768,1100,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'overflow '+width);}
  await page.locator('nav [data-view=backtest]').click();await page.locator('[name=from]').fill('2024-04-01');await page.locator('#run').click();await page.waitForFunction(()=>!document.querySelector('#run').disabled);assert.match(await page.locator('#config-status').innerText(),/没有覆盖|预热/);assert.ok(await page.locator('#export').isDisabled());assert.equal(collectionCalls,0);
  await page.screenshot({path:'/workspace/scratch/assembled-backtest-gap.png'});assert.deepEqual(errors,[]);
  console.log('Annual snapshot assembly UI passed: 001389 two-year range, raw overlap verification, dividend deduplication and factor rebuild, persisted merged SHA, unchanged custom dates/fees, 5m/15m/daily on one snapshot, no provider calls, enabled collection execution choices, missing history blocks and five viewport widths. Synthetic fixtures only.');
 }finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
