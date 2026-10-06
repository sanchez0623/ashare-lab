// Browser smoke for the real local task endpoint in this TCP-restricted environment.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.ASHARE_TEST_URL||'http://127.0.0.1:8082',{waitUntil:'networkidle'});await page.locator('nav [data-view=data]').click();
  await page.waitForFunction(()=>document.querySelector('#research-status').textContent.includes('后台串行'));
  await page.waitForFunction(()=>document.querySelectorAll('#sources-table tbody tr').length===5);assert.match(await page.locator('#sources-status').innerText(),/不消耗行情或付费请求/);await page.locator('#sources-refresh').click();await page.waitForFunction(()=>!document.querySelector('#sources-refresh').disabled);assert.match(await page.locator('#sources-table').innerText(),/mootdx/);
  await page.locator('#research-symbol').fill('600519');await page.locator('#research-end').fill('2026-09-30');await page.locator('#research-period').selectOption('5m');
  assert.equal(await page.locator('#research-range').inputValue(),'year');assert.equal(await page.locator('#research-start').inputValue(),'2025-10-01');assert.ok(await page.locator('#research-start').evaluate(e=>e.readOnly));
  await page.locator('#research-end').fill('2024-02-29');assert.equal(await page.locator('#research-start').inputValue(),'2023-03-01');await page.locator('#research-end').fill('2026-09-30');
  const submitted=page.waitForResponse(r=>r.url().endsWith('/api/research/jobs')&&r.request().method()==='POST');await page.locator('#research-submit').click();const response=await submitted;assert.equal(response.status(),202);const job=await response.json();
  assert.equal(job.request.from,'2025-10-01');assert.equal(job.request.warmupSessions,60);assert.equal(job.request.config.capital,1000000);assert.equal(job.request.config.commission,.005);
  await page.waitForFunction(id=>[...document.querySelectorAll('#research-jobs article')].some(e=>e.querySelector('[href="/api/research/jobs/'+id+'/report"]')&&e.textContent.includes('NETWORK_TCP_NOT_GRANTED')),job.id);
  const article=page.locator('#research-jobs article').filter({has:page.locator('[href="/api/research/jobs/'+job.id+'/report"]')});assert.match(await article.innerText(),/受阻/);
  const downloaded=page.waitForEvent('download');await article.locator('a[download]').click();const report=JSON.parse(fs.readFileSync(await(await downloaded).path(),'utf8'));assert.equal(report.acceptance,'blocked');assert.equal(report.error.code,'NETWORK_TCP_NOT_GRANTED');assert.equal(report.input.snapshotId,null);
  await page.reload({waitUntil:'networkidle'});await page.locator('nav [data-view=data]').click();assert.ok(await page.locator('[href="/api/research/jobs/'+job.id+'/report"]').count());
  await page.locator('#research-range').selectOption('custom');assert.equal(await page.locator('#research-start').evaluate(e=>e.readOnly),false);
  await page.locator('#research-start').fill('2024-01-01');await page.locator('#research-period').selectOption('15m');
  const customSubmitted=page.waitForResponse(r=>r.url().endsWith('/api/research/jobs')&&r.request().method()==='POST');await page.locator('#research-submit').click();const customResponse=await customSubmitted;assert.equal(customResponse.status(),202);const custom=await customResponse.json();
  assert.equal(custom.request.rangeMode,'custom');assert.equal(custom.request.from,'2024-01-01');assert.equal(custom.request.to,'2026-09-30');assert.equal(custom.request.config.timeframe,'15m');assert.equal(custom.request.warmupSessions,60);
  await page.waitForFunction(id=>[...document.querySelectorAll('#research-jobs article')].some(e=>e.querySelector('[href="/api/research/jobs/'+id+'/report"]')&&e.textContent.includes('NETWORK_TCP_NOT_GRANTED')),custom.id);
  await page.locator('#research-start').fill('2026-10-01');assert.equal(await page.locator('#research-form').evaluate(e=>e.checkValidity()),false);await page.locator('#research-start').fill('2024-01-01');
  await page.locator('#research-end').fill('2026-08-31');assert.equal(await page.locator('#research-start').inputValue(),'2024-01-01');await page.locator('#research-end').fill('2026-09-30');
  await page.screenshot({path:'/workspace/scratch/qingheng-background-tasks.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
  console.log('Task browser passed: year/leap-year dates, custom multi-year dates, 5m/15m requests, invalid range, separate warmup, honest TCP block, persistent reports and mobile. Jobs '+job.id+' '+custom.id);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
