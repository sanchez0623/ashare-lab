// Real local warehouse and synthetic history only; no market-provider calls.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {mkdtemp,rm}=require('node:fs/promises');
(async()=>{
 const {startLocal}=await import('../scripts/local-server.mjs'),{fixture}=await import('./fixture.mjs');
 const full=fixture(140),from=full.calendar[80],to=full.calendar.at(-1),dir=await mkdtemp(path.join(os.tmpdir(),'ashare-warmup-ui-'));let providerCalls=0;
 function cut(begin,end,symbol='600519'){
  const b=structuredClone(full),start=b.calendar[begin],finish=b.calendar[end];
  Object.assign(b.metadata,{symbol,universe:'SINGLE_SECURITY',collectionPurpose:'market-data-only',requested:{from:start,to:finish}});b.universe=[];
  for(const key of ['calendar','daily','actions','factors'])Object.assign(b.metadata.coverage[key],{from:start,to:finish});b.metadata.coverage.universe={status:'not-requested'};
  b.calendar=b.calendar.filter(d=>d<=finish);b.daily=b.daily.filter(d=>d.date>=start&&d.date<=finish);b.bars=b.bars.filter(r=>r.date.slice(0,10)>=start&&r.date.slice(0,10)<=finish);
  return b;
 }
 const server=await startLocal({port:0,dataDir:dir,researchOptions:{collector:async()=>{providerCalls++;throw Error('History preparation must not call a provider');}}});
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),base='http://127.0.0.1:'+server.address().port,errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ingest=async b=>{const r=await page.request.post(base+'/api/data/ingest',{data:b});assert.equal(r.status(),201,await r.text());return (await r.json()).id;};
  const mainId=await ingest(cut(20,139));await ingest(cut(0,29));const missingId=await ingest(cut(20,139,'600188'));
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#config-status').textContent.includes('回测完成'));
  async function select(id){await page.locator('#dataset').selectOption('snapshot:'+id);await page.waitForFunction(id=>document.querySelector('#dataset').value==='snapshot:'+id&&!document.querySelector('#dataset').disabled,id);await page.locator('[data-strategy=swing]').click();await page.locator('#timeframe').selectOption('5m');await page.locator('#config [name=from]').fill(from);await page.locator('#config [name=to]').fill(to);await page.locator('#config [name=minCommission]').fill('7.5');await page.locator('nav [data-view=optimization]').click();await page.locator('#tuning-steps [name=dailySlowStep]').fill('3');}
  await select(mainId);assert.match(await page.locator('#tuning-history-status').innerText(),/需要 63.*当前.*60/s);
  let assemblyRequests=[];page.on('request',r=>{if(r.url().endsWith('/api/data/assemble'))assemblyRequests.push(r.postDataJSON());});
  await page.locator('#tuning-start').click();await page.waitForFunction(()=>!document.querySelector('#tuning-start').disabled,{},{timeout:90000});assert.match(await page.locator('#tuning-status').innerText(),/计算完成/);
  const downloaded=page.waitForEvent('download');await page.locator('#tuning-export').click();const report=JSON.parse(fs.readFileSync(await(await downloaded).path(),'utf8'));
  assert.equal(assemblyRequests.length,1);assert.equal(assemblyRequests[0].warmupSessions,63);assert.equal(assemblyRequests[0].from,from);assert.equal(assemblyRequests[0].to,to);assert.equal(report.warmup.availableDailySessions,63);assert.equal(report.warmup.requiredDailySessions,63);assert.equal(report.rows.length,27);assert.ok(report.rows.every(r=>!r.error));assert.equal(report.inputConfig.from,from);assert.equal(report.inputConfig.to,to);assert.equal(report.inputConfig.dailySlow,60);assert.equal(report.inputConfig.minCommission,7.5);assert.notEqual(report.input.snapshotId,mainId);assert.equal(providerCalls,0);
  // Only 60 days exist for this second symbol: no new fake history, no date shift.
  await page.locator('nav [data-view=backtest]').click();await select(missingId);await page.locator('#tuning-start').click();await page.waitForFunction(()=>!document.querySelector('#tuning-start').disabled,{},{timeout:30000});assert.match(await page.locator('#tuning-status').innerText(),/缺 3 个完整交易日/);assert.equal(await page.locator('#config [name=from]').inputValue(),from);assert.equal(await page.locator('#config [name=to]').inputValue(),to);assert.equal(await page.locator('#config [name=dailySlow]').inputValue(),'60');assert.equal(providerCalls,0);
  assert.ok(await page.locator('#tuning-history-collect').isVisible());
  for(const width of [360,421,828,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'optimization overflow '+width);}
  await page.setViewportSize({width:421,height:950});await page.locator('#tuning-history-status').scrollIntoViewIfNeeded();await page.screenshot({path:'/workspace/scratch/tuning-warmup-mobile.png'});
  await page.locator('#tuning-history-collect').click();assert.equal(await page.locator('#research-symbol').inputValue(),'600188');assert.equal(await page.locator('#research-start').inputValue(),from);assert.equal(await page.locator('#research-end').inputValue(),to);assert.equal(await page.locator('#research-warmup').inputValue(),'63');assert.equal(await page.locator('#research-period').inputValue(),'5m');assert.equal(providerCalls,0);
  for(const width of [360,421,828,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'collection overflow '+width);}
  let submitted;
  await page.route('**/api/research/jobs',async route=>{if(route.request().method()==='POST'){submitted=route.request().postDataJSON();await route.fulfill({status:202,contentType:'application/json',body:'{"id":"mock-warmup-job"}'});}else await route.fulfill({contentType:'application/json',body:'{"jobs":[]}'});});
  await page.locator('#research-submit').click();await page.waitForFunction(()=>!document.querySelector('#research-submit').disabled);assert.equal(submitted.warmupSessions,63);assert.equal(submitted.config.dailySlow,60);assert.equal(submitted.config.minCommission,7.5);assert.equal(submitted.from,from);assert.equal(submitted.to,to);assert.equal(submitted.purpose,'collect');assert.equal(providerCalls,0);assert.deepEqual(errors,[]);
  console.log('Warmup UI passed: 60→63-day local fragment assembly; full 27-candidate run; missing history stops before computation; collection prefill and submitted warmup preserve symbol/dates/parameters/fees; no provider calls; mobile and desktop layouts. Synthetic data only.');
 }finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
