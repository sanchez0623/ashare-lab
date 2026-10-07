// UI regression: synthetic task responses, no market collection or paid requests.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:421,height:810}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const a='a'.repeat(24),b='b'.repeat(24);let order=[a,b],requests=0,holdNext=false,failNext=false,releaseHeld,heldStarted;
  const states={[a]:'running',[b]:'blocked'};
  const job=id=>({id,status:states[id],stage:'collect',request:{symbol:id===a?'600519':'000333',from:'2025-10-01',to:'2026-09-30',config:{timeframe:'5m'},warmupSessions:60},events:[{at:'2026-10-07T00:00:00Z',message:'测试日志 · 刷新轮次：'+requests}]});
  await page.route('**/api/research/jobs',async route=>{
   requests++;
   if(holdNext){holdNext=false;const held=new Promise(resolve=>releaseHeld=resolve);heldStarted();await held;}
   if(failNext){failNext=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'刷新测试暂时失败'})});return;}
   await route.fulfill({contentType:'application/json',body:JSON.stringify({jobs:order.map(job)})});
  });
  const details=id=>page.locator('details[data-task-logs="'+id+'"]');
  const toggle=async id=>details(id).locator('summary').click();
  const isOpen=async(id,value)=>assert.equal(await details(id).evaluate(e=>e.open),value,id);
  const rendered=async()=>Number((await details(a).textContent()).match(/刷新轮次：(\d+)/)[1]);
  const waitRender=async previous=>page.waitForFunction(({id,previous})=>Number(document.querySelector('details[data-task-logs="'+id+'"]').textContent.match(/刷新轮次：(\d+)/)[1])>previous,{id:a,previous});
  const manualRefresh=async()=>{const previous=await rendered();await page.locator('#research-refresh').click();await waitRender(previous);};
  await page.goto(process.env.ASHARE_TEST_URL||'http://127.0.0.1:8099',{waitUntil:'domcontentloaded'});
  await page.locator('nav [data-view="data"]').click();await details(a).waitFor();

  await toggle(a);let previous=await rendered();await waitRender(previous);
  await isOpen(a,true);await isOpen(b,false);
  assert.equal(await page.evaluate(()=>document.activeElement.parentElement?.dataset.taskLogs),a);

  await toggle(a);previous=await rendered();await waitRender(previous);
  await isOpen(a,false);await isOpen(b,false);

  await toggle(b);order=[b,a];previous=await rendered();await waitRender(previous);
  assert.equal(await page.locator('#research-jobs details').first().getAttribute('data-task-logs'),b);
  await isOpen(a,false);await isOpen(b,true);

  await toggle(a);await manualRefresh();await isOpen(a,true);await isOpen(b,true);
  await toggle(b);
  const started=new Promise(resolve=>heldStarted=resolve);holdNext=true;previous=await rendered();
  await page.locator('#research-refresh').click();await started;
  await toggle(a);releaseHeld();await waitRender(previous);
  await isOpen(a,false);await isOpen(b,false);

  await toggle(b);failNext=true;await page.locator('#research-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#research-status').textContent.includes('刷新测试暂时失败'));
  await isOpen(b,true);await manualRefresh();await isOpen(a,false);await isOpen(b,true);

  states[a]='completed';states[b]='paused';await manualRefresh();
  await isOpen(a,false);await isOpen(b,true);
  assert.match(await page.locator('#research-jobs').textContent(),/已完成/);
  assert.deepEqual(errors,[]);
  console.log('Task logs regression passed: 3-second polling, deliberate collapse, independent jobs, reorder, manual refresh, in-flight toggles, keyboard focus, failed refresh recovery and status transitions.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
