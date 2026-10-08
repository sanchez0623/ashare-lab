// Browser update prompts and graceful backend reload; no market/LLM calls.
const {chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright');
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,writeFile,mkdir,appendFile,rm}=require('node:fs/promises');
(async()=>{
 const {LocalWatcher,captureSources}=await import('../scripts/local-watch.mjs');
 const dir=await mkdtemp(path.join(os.tmpdir(),'ashare-hot-ui-')),root=path.join(dir,'source'),snapshot=await captureSources(path.resolve(__dirname,'..'));let watcher,browser;
 try{
  for(const [name,bytes] of snapshot.files){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);}
  watcher=await new LocalWatcher({root,port:0,dataDir:path.join(dir,'data'),pollMs:100,debounceMs:200,env:{...process.env,ASHARE_PYTHON:path.join(dir,'not-installed-python')},log:()=>{}}).start();
  browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+watcher.port,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#config-status').textContent.includes('回测完成'));
  assert.equal(await page.locator('meta[name="ashare-local-revision"]').getAttribute('content'),watcher.applied);
  const pid=watcher.child.pid;await page.locator('#config [name=capital]').fill('1234567');await appendFile(path.join(root,'dist/style.css'),'\n/* live frontend update */');
  const banner=page.locator('.local-update-banner');await banner.waitFor({state:'visible',timeout:15000});assert.match(await banner.innerText(),/刷新.*后台采集不受影响/);assert.equal(watcher.child.pid,pid);assert.equal(await page.locator('#config [name=capital]').inputValue(),'1234567');
  for(const width of [360,421,828,1440]){await page.setViewportSize({width,height:900});const box=await banner.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'banner overflow '+width);assert.ok(await banner.locator('button').isVisible());}
  await Promise.all([page.waitForEvent('load'),banner.locator('button').click()]);await page.waitForTimeout(500);assert.equal(await page.locator('meta[name="ashare-local-revision"]').getAttribute('content'),watcher.applied);assert.equal(await banner.isVisible(),false);
  await appendFile(path.join(root,'scripts/local-server.mjs'),'\n// compatible backend UI test\n');await page.waitForFunction(()=>document.querySelector('.local-update-banner')?.textContent.includes('新版本已就绪'),{},{timeout:15000});assert.notEqual(watcher.child.pid,pid);
  await appendFile(path.join(root,'dist/app.js'),'\nexport const brokenSyntax = ;');await page.waitForFunction(()=>document.querySelector('.local-update-banner')?.textContent.includes('继续上一个可用版本'),{},{timeout:15000});assert.ok(await page.locator('#config [name=capital]').isEditable());
  assert.deepEqual(errors,[]);console.log(JSON.stringify({updatePrompt:true,manualRefresh:true,backendReload:true,failedBuildRetainsPage:true,responsiveWidths:[360,421,828,1440],pageErrors:errors,marketRequests:0}));
 }finally{if(browser)await browser.close();if(watcher)await watcher.close();await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
