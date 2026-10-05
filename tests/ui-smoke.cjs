const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const run=async()=>{await page.locator('#run').click();await page.waitForFunction(()=>!document.querySelector('#run').disabled);};
    const report=async()=>{const event=page.waitForEvent('download');await page.locator('#export').click();return JSON.parse(fs.readFileSync(await(await event).path(),'utf8'));};
    await page.goto('http://localhost:8080',{waitUntil:'networkidle'});
    await page.waitForFunction(()=>document.querySelector('#config-status').textContent.includes('回测完成'));
    assert.equal(await page.locator('#timeframe').inputValue(),'15m');
    assert.match(await page.locator('#result-title').innerText(),/大波段/);
    assert.equal(await page.locator('#metrics .metric').count(),4);
    assert.match(await page.locator('#causal-status').innerText(),/时序校验通过/);
    const r15=await report();assert.equal(r15.period.tradingDays,782);assert.equal(r15.audit.timingViolations,0);assert.ok(r15.trades.length>0);
    await page.screenshot({path:'/workspace/scratch/qingheng-v2-desktop.png',fullPage:true});
    await page.locator('[data-tab="audit"]').click();assert.ok(await page.locator('#tab-audit tbody tr').count()>0);
    for(const t of r15.trades){assert.ok(t.signalTime<=t.executionTime);assert.ok(t.dailySignalTime<t.executionTime);}
    await page.locator('#timeframe').selectOption('5m');await run();
    const r5=await report();assert.equal(r5.period.bars,r15.period.bars*3);assert.equal(r5.period.tradingDays,r15.period.tradingDays);
    await page.locator('[data-strategy="rsi"]').click();await run();assert.match(await page.locator('#result-title').innerText(),/RSI/);
    await page.locator('[data-tab="stats"]').click();assert.equal(await page.locator('.stat-row').count(),14);
    await page.locator('[data-chart="drawdown"]').click();assert.match(await page.locator('#chart-subtitle').innerText(),/回撤/);
    await page.locator('[data-strategy="swing"]').click();await page.locator('#timeframe').selectOption('15m');await run();
    await page.locator('[data-tab="optimize"]').click();await page.locator('#optimize').click();await page.waitForFunction(()=>!document.querySelector('#optimize').disabled);
    assert.equal(await page.locator('#optimizer-results tbody tr').count(),9);assert.match(await page.locator('.validation-split').innerText(),/训练/);assert.match(await page.locator('.validation-split').innerText(),/验证/);
    await page.locator('[data-opt="0"]').click();assert.match(await page.locator('#config-status').innerText(),/更改/);await run();
    const validationReport=await report();assert.ok(validationReport.config.from>r15.config.from);
    await page.locator('nav [data-view="data"]').click();
    const {demoMinuteData,resampleData}=await import('../dist/engine.mjs');const native=resampleData(demoMinuteData().slice(0,48*150),'15m');
    const csv='datetime,open,high,low,close,volume,prev_close,halted\n'+native.map(r=>[r.date,r.open,r.high,r.low,r.close,r.volume,r.prev_close,0].join(',')).join('\n');
    await page.locator('#file').setInputFiles({name:'波段15分钟.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await page.waitForFunction(()=>document.querySelector('#import-status').textContent.includes('已导入 2,400'));
    await page.locator('nav [data-view="backtest"]').click();
    const stale=await report();assert.equal(stale.source,'demo');assert.equal(stale.data.length,43872);
    assert.equal(await page.locator('#timeframe').inputValue(),'15m');await run();
    const imported=await report();assert.equal(imported.source,'import');assert.equal(imported.data.length,2400);assert.equal(imported.dataInfo.nativeTimeframe,'15m');
    await page.locator('#timeframe').selectOption('5m');await run();assert.match(await page.locator('#config-status').innerText(),/无法/);
    await page.locator('#timeframe').selectOption('15m');await run();assert.match(await page.locator('#result-source').innerText(),/导入.*15 分钟/);
    await page.locator('nav [data-view="history"]').click();assert.ok(await page.locator('#history-body tbody tr').count()>0);await page.locator('#clear-history').click();assert.match(await page.locator('#history-body').innerText(),/暂无/);
    await page.locator('nav [data-view="backtest"]').click();await page.locator('#dataset').selectOption('demo');await page.locator('[data-strategy="swing"]').click();await run();
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/workspace/scratch/qingheng-v2-mobile.png',fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    assert.deepEqual(errors,[]);
    console.log('UI v2 passed: worker, 5/15 minute execution, daily swings, signal audit, training/validation, CSV import, exports, no fake finer resolution, history and mobile.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
