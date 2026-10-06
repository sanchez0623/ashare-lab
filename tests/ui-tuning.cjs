const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {mkdtemp,rm}=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
(async()=>{
 const {startLocal}=await import('../scripts/local-server.mjs'),{fixture}=await import('./fixture.mjs');
 const bundle=fixture(360),dir=await mkdtemp(path.join(os.tmpdir(),'ashare-tuning-ui-'));
 const server=await startLocal({port:0,dataDir:dir,researchOptions:{collector:async()=>bundle}});
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='http://127.0.0.1:'+server.address().port;
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#tuning-start').disabled,{},{timeout:90000});
  const exported=async()=>{const event=page.waitForEvent('download');await page.locator('#tuning-export').click();return JSON.parse(fs.readFileSync(await(await event).path(),'utf8'));};
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#config-status').textContent.includes('回测完成'));
  assert.ok(await page.locator('.notice [data-view=optimization]').isVisible());await page.locator('nav [data-view=optimization]').click();
  assert.ok(await page.locator('#tuning-start').isVisible());assert.match(await page.locator('#tuning-source').innerText(),/合成数据/);assert.match(await page.locator('#tuning-grid').innerText(),/共27组/);
  await page.locator('#tuning-start').click();await ready();assert.equal(await page.locator('#tuning-results tbody tr').count(),27);assert.match(await page.locator('#tuning-results').innerText(),/不推荐自动应用/);
  const initial=await exported();assert.equal(initial.input.synthetic,true);assert.equal(initial.recommendation,null);assert.equal(initial.input.dataHash.length,64);
  assert.equal(initial.inputConfig.capital,1000000);assert.equal(initial.inputConfig.commission,.005);assert.equal(initial.inputConfig.stamp,.05);
  await page.locator('#tuning-start').click();await page.locator('#tuning-cancel').click();await ready();assert.match(await page.locator('#tuning-status').innerText(),/已停止/);
  await page.locator('#tuning-management').click();await ready();assert.equal(await page.locator('#tuning-results tbody tr').count(),5);const management=await exported();assert.equal(management.baseline.config.management,'base');assert.equal(management.selectionRule,'training_quality_only');
  await page.locator('#view-optimization [data-view=backtest]').click();
  for(const [key,value] of Object.entries({dailyFast:5,dailySlow:20,exitPeriod:5,breakout:5,confirmationDays:1,atrPeriod:5,maxExtensionATR:10}))await page.locator('#config [name='+key+']').fill(String(value));
  await page.locator('#config [name=management]').selectOption('base');await page.locator('nav [data-view=optimization]').click();
  await page.locator('.tuning-thresholds summary').click();await page.locator('#tuning-mintrades').fill('5');assert.equal(await page.locator('[name=minTrades]').inputValue(),'5');
  await page.locator('#tuning-start').click();await ready();const tuned=await exported();assert.equal(tuned.rows.length,18);assert.ok(tuned.recommendation);assert.equal(tuned.inputConfig.minTrades,5);assert.ok(tuned.trainTo<tuned.validationFrom);
  assert.equal(tuned.rows.find(r=>r.isBaseline).validationDelta,0);assert.equal(tuned.recommendation.config.commission,.005);assert.ok(await page.locator('#tuning-apply').isVisible());
  await page.screenshot({path:'/workspace/scratch/tuning-results-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:'/workspace/scratch/tuning-results-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1050});
  await page.locator('#tuning-apply').click();await page.waitForFunction(()=>document.querySelector('#config-status').textContent.includes('回测完成'));assert.equal(await page.locator('#config [name=from]').inputValue(),tuned.validationFrom);assert.equal(await page.locator('#config [name=atrMult]').inputValue(),String(tuned.recommendation.config.atrMult));
  // Completed-job integration uses an explicitly synthetic transport fixture,
  // never a fabricated claim that the production provider was collected.
  const request=await page.request.post(base+'/api/research/jobs',{data:{symbol:'600519',to:bundle.calendar.at(-1),config:{dailyFast:5,dailySlow:20,exitPeriod:5,breakout:5,confirmationDays:1,atrPeriod:5,maxExtensionATR:10,minTrades:5,management:'base'}}});assert.equal(request.status(),202);const job=await request.json();
  for(let i=0;i<100&&server.research.jobs.get(job.id).status!=='completed';i++)await page.waitForTimeout(100);assert.equal(server.research.jobs.get(job.id).status,'completed');
  await page.locator('nav [data-view=data]').click();await page.locator('#research-refresh').click();await page.waitForSelector('[data-task-optimize="'+job.id+'"]');await page.locator('[data-task-optimize="'+job.id+'"]').click();await page.waitForFunction(()=>!document.querySelector('#view-optimization').hidden);
  assert.equal(await page.locator('#config [name=from]').inputValue(),job.request.from);assert.match(await page.locator('#tuning-context').innerText(),new RegExp(job.request.from));assert.match(await page.locator('#tuning-source').innerText(),/合成数据/);
  await page.locator('#tuning-start').click();await ready();const snapshotReport=await exported();assert.equal(snapshotReport.input.snapshotId,server.research.jobs.get(job.id).snapshotId);assert.equal(snapshotReport.trainFrom,job.request.from);
  const bad=fixture(100);delete bad.daily[61].isST;await page.locator('nav [data-view=data]').click();await page.locator('#file').setInputFiles({name:'缺少历史ST的合成测试.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bad))});await page.waitForFunction(()=>document.querySelector('#import-status').textContent.includes('已持久保存'));
  await page.locator('nav [data-view=optimization]').click();await page.locator('#tuning-start').click();await ready();assert.match(await page.locator('#tuning-status').innerText(),/准入失败/);
  assert.deepEqual(errors,[]);console.log('Optimization UI passed: visible entry, 27/18 candidates, fixed fees, no recommendation on small samples, cancellation, 5-scheme baseline, frozen reports, apply+validate, native snapshot task bounds, blocked historical ST and mobile. All market fixtures are synthetic.');
 }finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
