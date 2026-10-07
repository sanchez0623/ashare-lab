// Browser checks use explicit fixture task responses; no provider calls.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:421,height:810}}),errors=[],id='c'.repeat(24);let submitted;
  page.on('pageerror',e=>errors.push(e.message));
  const j={id,status:'completed',stage:'completed',snapshotId:'d'.repeat(64),reportHash:'e'.repeat(64),reportRun:2,collectionRange:{from:'2025-07-08',to:'2026-09-30'},request:{purpose:'collect',symbol:'600519',from:'2025-10-01',to:'2026-09-30',config:{timeframe:'5m'},warmupSessions:60},
   timing:{version:1,activeMs:3723000,stages:{collect:3723000},runs:[{startedAt:'2026-10-07T00:00:00Z',endedAt:'2026-10-07T00:02:00Z',activeMs:120000,stopReason:'paused'},{startedAt:'2026-10-07T01:00:00Z',endedAt:'2026-10-07T02:00:03Z',activeMs:3603000,stopReason:'completed'}]},
   queryTiming:{minute:{completed:15,failed:1,cached:2,elapsedMs:3700000,rateWaitMs:600000,requests:30}},
   events:[{at:'2026-10-07T02:00:03Z',stage:'collect',message:'查询完成：minute / sh.600519',activeMs:3723000,stageMs:3723000}],quality:{completeSessions:240,suspendedSessions:0,actual:{bars:11520},issues:[]}};
  await page.route('**/api/research/jobs',async route=>{if(route.request().method()==='POST'){submitted=route.request().postDataJSON();await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify(j)});}else await route.fulfill({contentType:'application/json',body:JSON.stringify({jobs:[j]})});});
  await page.goto(process.env.ASHARE_TEST_URL||'http://127.0.0.1:8099',{waitUntil:'domcontentloaded'});await page.locator('nav [data-view="data"]').click();
  const article=page.locator('#research-jobs article');await article.waitFor();assert.match(await article.innerText(),/累计运行 1时2分3秒/);assert.match(await article.innerText(),/仅采集行情 · 未校验沪深300成员/);
  assert.equal(await article.locator('[data-task-optimize]').count(),0);assert.equal(await article.locator('a[href$="/timing"]').count(),1);assert.equal(await article.locator('a[href*="/api/data/bundle?"]').count(),1);
  await article.locator('summary').click();assert.match(await article.locator('details').innerText(),/限流等待/);assert.match(await article.locator('details').innerText(),/第1次/);assert.match(await article.locator('details').innerText(),/暂停/);
  assert.match(await article.locator('details').innerText(),/5分钟K线/);assert.match(await article.locator('details').innerText(),/0时10分0秒/);
  await page.locator('#research-purpose').selectOption('research');await page.locator('#research-period').selectOption('15m');await page.locator('#research-purpose').selectOption('collect');assert.ok(await page.locator('#research-period').isEnabled());
  await page.locator('#research-submit').click();await page.waitForFunction(()=>!document.querySelector('#research-submit').disabled);assert.equal(submitted.purpose,'collect');assert.equal(submitted.config.timeframe,'15m');
  assert.ok(await article.locator('details').evaluate(e=>e.open));
  assert.match(await article.innerText(),/实际采集范围（含预热）：2025-07-08 — 2026-09-30/);
  j.status='running';j.stage='collect';j.reportRun=1;await page.locator('#research-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#research-jobs').textContent.includes('上次尝试报告（本轮尚未完成）'));
  assert.equal(await article.locator('a[href$="/report"]').innerText(),'下载上次报告');assert.match(await article.innerText(),/采集阶段累计 1时2分3秒/);assert.match(await article.innerText(),/本次运行 1时0分3秒/);
  j.status='completed';j.stage='completed';j.reportRun=2;await page.locator('#research-refresh').click();
  await page.waitForFunction(()=>!document.querySelector('#research-jobs').textContent.includes('上次尝试报告'));
  assert.equal(await article.locator('a[href$="/report"]').innerText(),'下载完整报告');assert.ok(await article.locator('details').evaluate(e=>e.open));
  for(const width of [360,421,768,1100,1440]){
   await page.setViewportSize({width,height:900});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'page overflow '+width);
   const clipped=await page.locator('#research-form select').evaluateAll(es=>es.filter(e=>{
    const s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=s.font;
    return c.measureText(e.options[e.selectedIndex].text).width>e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-24;
   }).map(e=>e.id));assert.deepEqual(clipped,[],'selected text clipping '+width);
  }
  await page.screenshot({path:'/workspace/scratch/qingheng-timing-desktop.png',fullPage:true});await page.setViewportSize({width:421,height:810});await page.screenshot({path:'/workspace/scratch/qingheng-timing-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('Timing UI passed: collection default, raw 5m submission, mode distinction, cumulative/stage/run/query/wait display, export links, logs stay open, five viewport widths.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
