import {mkdir,readFile,writeFile,rename,readdir,rm,open,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {defaults,validate} from '../dist/engine.mjs';
import {auditBundle} from '../dist/quality.mjs';
import {resampleData} from '../dist/data.mjs';
import {ensureTiming,accrue,startTiming,stopTiming,timingView,iso} from './research-timing.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString(),date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const failure=(code,message,details)=>Object.assign(Error(message),{code,details});
// Reviewed predecessors retain collection query identities and price basis.
// Research jobs remain pinned to their strategy engine; collection-only jobs
// never execute that engine. All collection responses are still revalidated.
// Unknown pipelines still cannot reuse old work.
const compatiblePipelines=new Set(['42a250326c788ca9a1b81e818537396179b2d6b2b3ad822dee6f44493bd333e9','5ba9106a87d7f621d730eb8366b486f172862bb0950bc1afc326410e1fa83967','29824a5da745fb0d388a82719a4c4ff0c3b0bb3de81b5dc25a61a44ba4d0e36c']);
async function atomic(target,value){await mkdir(path.dirname(target),{recursive:true});const temp=target+'.tmp-'+randomUUID(),handle=await open(temp,'wx');try{await handle.writeFile(typeof value==='string'?value:canonical(value));await handle.sync();}finally{await handle.close();}await rename(temp,target);}
export function yearStart(to){const d=new Date(to+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);d.setUTCFullYear(d.getUTCFullYear()-1);return d.toISOString().slice(0,10);}
export function normalizeRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw failure('REQUEST','任务请求无效');
  const symbol=String(input.symbol??'600519'),board=symbol.startsWith('688')?'star':/^30[01]/.test(symbol)?'chinext':'main';
  if(!/^(6\d{5}|[03]\d{5})$/.test(symbol))throw failure('REQUEST','此验收仅支持BaoStock沪深证券代码');
  if(input.board&&input.board!==board)throw failure('REQUEST','显式板块与证券代码不符');
  if(!date(input.to))throw failure('REQUEST','请选择有效的研究结束日期');
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  if(input.to>=today)throw failure('REQUEST','研究结束日期必须早于北京时间今天，避免采集未完成交易日');
  const rangeMode=input.rangeMode??(input.from===undefined?'year':'custom');
  if(!['year','custom'].includes(rangeMode))throw failure('REQUEST','研究区间模式须为year或custom');
  const from=rangeMode==='year'?yearStart(input.to):input.from;
  if(!date(from))throw failure('REQUEST','请选择有效的研究开始日期');
  if(from>=input.to)throw failure('REQUEST','研究开始日期必须早于结束日期');
  if(rangeMode==='year'&&input.from!==undefined&&input.from!==from)throw failure('REQUEST','一年模式的开始日期由结束日期自动计算；自定义日期请使用custom模式');
  const cfg=Object.fromEntries(Object.keys(defaults).map(k=>[k,input.config?.[k]??defaults[k]]));
  Object.assign(cfg,{from,to:input.to,board,dataMode:'formal',rulesMode:'historical'});
  if(!['5m','15m'].includes(cfg.timeframe))throw failure('REQUEST','验收需在5或15分钟执行，原始采集均为5分钟');
  validate(cfg);
  const warmupSessions=Math.max(60,cfg.dailySlow,cfg.breakout+1,cfg.exitPeriod,cfg.atrPeriod,cfg.confirmationDays+1,Math.ceil(Math.max(cfg.slow,35,cfg.rsiPeriod+1,cfg.bbPeriod)/(cfg.timeframe==='5m'?48:16))+1);
  const budget=input.budget??10000;if(!Number.isInteger(budget)||budget<1||budget>40000)throw failure('REQUEST','日预算须为1至40000，默认10000');
  const purpose=input.purpose??'research';if(!['collect','research'].includes(purpose))throw failure('REQUEST','任务用途须为collect或research');
  return {schemaVersion:1,symbol,board,purpose,rangeMode,from,to:input.to,warmupSessions,budget,provider:'baostock',config:cfg};
}
export function acceptanceAudit(bundle,request){
  const collectOnly=request.purpose==='collect',quality=auditBundle(bundle),issues=quality.issues.filter(i=>!collectOnly||!i.code.startsWith('UNIVERSE_')),add=(code,message)=>issues.push({code,message,count:1,samples:[]});
  const m=bundle.metadata??{},rows=bundle.bars??[];
  if(m.symbol!==request.symbol||m.board!==request.board)add('IDENTITY','数据包证券或板块不符');
  if(m.timeframe!=='5m')add('NATIVE_5M','验收必须使用原生5分钟，禁止拆分日线或15分钟');
  if(m.requested?.to!==request.to||m.requested?.from>=request.from)add('RESEARCH_RANGE','数据包须完整覆盖研究区间和独立预热区间');
  if(m.research&&(m.research.from!==request.from||m.research.to!==request.to||m.research.warmupSessions!==request.warmupSessions))add('RESEARCH_RANGE','采集回执的研究区间或预热要求与固定请求不一致');
  if(!m.synthetic&&(m.source!=='baostock'||!Object.keys(m.provenance?.queries??{}).length))add('PROVENANCE','缺少BaoStock原始查询检查点证明');
  if(!m.synthetic&&['bars','daily','calendar','universe','actions','factors'].some(k=>!m.parquetArchive?.tables?.[k]))add('PARQUET_ARCHIVE','缺少完整本地Parquet归档回执');
  const warm=(bundle.calendar??[]).filter(d=>d>=m.requested?.from&&d<request.from&&d>=m.listedDate);
  if(warm.length<request.warmupSessions)add('WARMUP','完整预热交易日不足：需要'+request.warmupSessions+'日');
  const code=(request.symbol.startsWith('6')?'sh.':'sz.')+request.symbol;
  if(!collectOnly&&!(bundle.universe??[]).some(u=>u.date>=request.from&&u.date<=request.to&&u.codes?.includes(code)))add('HISTORICAL_MEMBER','研究区间内未证明曾为沪深300成分股');
  if(!rows.some(r=>r.date.slice(0,10)>=request.from&&r.date.slice(0,10)<=request.to))add('RESEARCH_EMPTY','研究区间无分钟数据');
  return {...quality,status:issues.length?'blocked':'passed',...(collectOnly?{scope:'market-data-only',label:issues.length?'行情已保存，存在资料问题':'行情完整性校验通过，未核验指数成员'}:{}),issues,warmupSessions:warm.length,requiredWarmup:request.warmupSessions,research:{from:request.from,to:request.to},synthetic:m.synthetic===true};
}
// Separate accounting checks use raw closing prices, quantities and fees from
// saved outputs. This is deliberately independent of the engine's NAV formula.
export function auditAccounting(result,bundle){
  const prices=new Map(resampleData(bundle.bars,result.config.timeframe).map(r=>[r.date,r.close]));
  const daily=new Map(bundle.daily.map(d=>[d.date,d])),exDates=new Set(bundle.actions.map(a=>a.exDate));
  const movements=result.trades.map(t=>({at:t.executionTime,cash:t.side==='买入'?-t.amount-t.fee:t.amount-t.fee,quantity:t.side==='买入'?t.quantity:-t.quantity,locked:0,receivable:0}));
  for(const e of result.corporateEvents){const p={at:e.date+' 09:00',cash:0,quantity:0,locked:0,receivable:0};if(e.event==='股息到账'){p.cash=e.amount;p.receivable=-e.amount;}else if(e.event==='送转股上市'){p.quantity=e.quantity;p.locked=-e.quantity;}else if(e.event==='除权权益入账'){p.receivable=e.cashReceivable;p.locked=e.lockedShares;}else continue;movements.push(p);}
  movements.sort((a,b)=>a.at.localeCompare(b.at));let cursor=0,cash=result.config.capital,quantity=0,locked=0,receivable=0;
  let checked=0;for(const p of result.curve){const day=p.date.slice(0,10),d=daily.get(day),price=prices.get(p.date)??(p.valuationOnly?(exDates.has(day)?d?.prev_close:d?.close):undefined);
    while(cursor<movements.length&&movements[cursor].at<=p.date){const flow=movements[cursor++];cash+=flow.cash;quantity+=flow.quantity;locked+=flow.locked;receivable+=flow.receivable;}
    if(Math.abs(p.cash-cash)>.011||p.quantity!==quantity||p.lockedQuantity!==locked||Math.abs(p.receivable-receivable)>.011)throw failure('ACCOUNTING','成交现金流、股份或权益流水核对失败：'+p.date);
    const expected=p.cash+(p.quantity+p.lockedQuantity)*price+p.receivable;
    if(!Number.isFinite(expected)||Math.abs(p.equity-expected)>0.011||Math.abs(p.nav-p.equity/result.config.capital)>1e-10||p.cash<-.011||p.quantity<0)throw failure('ACCOUNTING','现金、持仓或净值核对失败：'+p.date);
    checked++;
  }
  const fees=result.trades.reduce((s,t)=>s+t.fee,0);
  if(Math.abs(fees-result.metrics.fees)>.011||Math.abs(result.metrics.equity-result.curve.at(-1).equity)>.011)throw failure('ACCOUNTING','成交费用或期末资产核对失败');
  for(const t of result.trades){if(t.signalTime>t.executionTime||t.dailySignalTime&&t.dailySignalTime>t.executionTime)throw failure('LOOKAHEAD','发现执行早于信号可得时间');if(Math.abs(t.amount-t.quantity*t.price)>.011||t.side==='卖出'&&t.sellableBefore<t.quantity)throw failure('ACCOUNTING','成交金额或T+1可卖库存核对失败');}
  return {status:'passed',valuationPoints:checked,fees,checks:['order and corporate cash/share movements','cash + tradable/locked stock value + dividend receivable','order fee sum','final equity','signal availability','sellable quantity']};
}
async function engineHash(){const files=['engine.mjs','quality.mjs','data.mjs','rules.mjs','corporate.mjs','fees.mjs','inventory.mjs'];const parts=[];for(const f of files)parts.push([f,hash(await readFile(path.join(project,'dist',f)))]);parts.push(['runner',hash(await readFile(path.join(project,'server/research-runner.mjs')))]);return hash(canonical(parts));}
async function pipelineHash(){const files=['server/research.mjs','server/research-timing.mjs','collector/research_collect.py','collector/sources.py','collector/sync.py','collector/locking.py','collector/baostock_guard.py','collector/parquet_store.py'];const parts=[];for(const f of files)parts.push([f,hash(await readFile(path.join(project,f)))]);return hash(canonical(parts));}
const jsonResponse=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
// Node decodes collector output as UTF-8; Windows pipe encodings must match.
const pythonEnv=()=>({...process.env,PYTHONIOENCODING:'utf-8'});

export class ResearchManager {
  constructor({root,bucket,collector,runner,clock=Date.now,heartbeatMs=5000}={}){this.root=path.resolve(root);this.bucket=bucket;this.collector=collector;this.runner=runner;this.clock=clock;this.heartbeatMs=heartbeatMs;this.jobs=new Map();this.active=null;this.stopping=false;this.saves=Promise.resolve();}
  location(id,name){if(!/^[a-f0-9]{24}$/.test(id))throw failure('NOT_FOUND','任务不存在');return path.join(this.root,'jobs',id,name);}
  async init(){
    await mkdir(this.root,{recursive:true});this.lock=path.join(this.root,'.controller-lock');this.owner=randomUUID();
    try{await mkdir(this.lock);}catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(await readFile(path.join(this.lock,'owner.json'),'utf8'));}catch{throw Error('任务控制锁未完成初始化；检查是否有另一服务正在启动');}
      let alive=true;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      if(alive)throw Error('该数据目录已有本地任务服务，禁止两个调度器并发');await rm(this.lock,{recursive:true});await mkdir(this.lock);
    }
    await atomic(path.join(this.lock,'owner.json'),{pid:process.pid,owner:this.owner});this.fingerprint=await engineHash();this.pipelineFingerprint=await pipelineHash();
    await mkdir(path.join(this.root,'jobs'),{recursive:true});
    for(const id of await readdir(path.join(this.root,'jobs'))){if(!/^[a-f0-9]{24}$/.test(id))continue;
      try{const state=JSON.parse(await readFile(this.location(id,'state.json'),'utf8'));const raw=await readFile(this.location(id,'request.json'),'utf8');
        if(hash(raw)!==state.requestHash)throw Error('任务请求哈希不符');state.request=JSON.parse(raw);this.jobs.set(id,state);
        ensureTiming(state);
        if(state.status==='running'){stopTiming(state,this.clock(),'interrupted',{recovered:true});state.status='queued';state.recoveryCount=(state.recoveryCount??0)+1;await this.save(state,'服务中断后自动恢复；累计时间截至最后落盘心跳，停机期间不计时；复用已完成分段');}
      }catch(e){const state={id,status:'failed',stage:'recovery',createdAt:now(),updatedAt:now(),events:[],error:{code:'JOB_INTEGRITY',message:e.message}};this.jobs.set(id,state);}
    }
    this.pump();return this;
  }
  async save(job,message){const at=this.clock();accrue(job,at);job.updatedAt=iso(at);let event;
    if(message){event={at:job.updatedAt,stage:job.stage,message,activeMs:job.timing.activeMs,stageMs:job.timing.stages[job.stage]??0,run:job.timing.runs.length};job.events??=[];job.events.push(event);job.events=job.events.slice(-80);}
    const copy=JSON.parse(JSON.stringify(job));delete copy.request;delete copy.controller;this.saves=this.saves.catch(()=>{}).then(async()=>{await atomic(this.location(job.id,'state.json'),copy);if(event)await writeFile(this.location(job.id,'events.jsonl'),canonical(event)+'\n',{flag:'a'});});await this.saves;
  }
  view(job){const {controller,...value}=job;return {...value,timing:timingView(job,this.clock()),events:job.events??[]};}
  async create(input,{replay}={}){
    const request=replay?replay.request:normalizeRequest(input),id=randomUUID().replaceAll('-','').slice(0,24),bytes=canonical(request);
    const job={id,request,requestHash:hash(bytes),engineHash:replay?.engineHash??this.fingerprint,pipelineHash:replay?.pipelineHash??this.pipelineFingerprint,configHash:hash(canonical(request.config)),status:'queued',stage:'queued',createdAt:iso(this.clock()),updatedAt:iso(this.clock()),events:[],recoveryCount:0,timing:{version:1,activeMs:0,stages:{},runs:[],accountedAt:null}};
    if(replay){job.snapshotId=replay.snapshotId;job.expectedResultHash=replay.resultHash;job.replayOf=replay.id;}
    await atomic(this.location(id,'request.json'),bytes);await this.save(job,'任务已保存，等待串行执行');this.jobs.set(id,job);this.pump();return this.view(job);
  }
  pump(){if(this.active||this.stopping)return;const job=[...this.jobs.values()].filter(j=>j.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];if(!job)return;
    this.active=job;job.status='running';job.controller=new AbortController();startTiming(job,this.clock());
    const heartbeat=setInterval(()=>{if(job.status==='running')this.save(job).catch(()=>{});},this.heartbeatMs);heartbeat.unref();
    this.running=this.execute(job).catch(async e=>{const paused=job.controller.signal.aborted||e.code==='PAUSED';const status=paused?'paused':e.code==='ACCOUNTING'||e.code==='REPRODUCIBILITY'||e.code==='SNAPSHOT_HASH'?'failed':'blocked';stopTiming(job,this.clock(),status);job.status=status;job.error={code:e.code??'TASK_ERROR',message:e.message,...(e.details?{details:e.details}:{})};delete job.controller;await this.save(job,e.message);if(!paused)await this.saveReport(job,{schemaVersion:1,acceptance:'blocked',input:{requestHash:job.requestHash,configHash:job.configHash,engineHash:job.engineHash,pipelineHash:job.pipelineHash,snapshotId:job.snapshotId??null},request:job.request,error:job.error,quality:job.quality??null});}).finally(()=>{clearInterval(heartbeat);delete job.controller;this.active=null;this.pump();});
  }
  check(job){if(job.controller?.signal.aborted||this.stopping)throw failure('PAUSED','任务已暂停，断点保留');}
  async stage(job,stage,message){this.check(job);accrue(job,this.clock());job.stage=stage;await this.save(job,message);}
  async progress(job,p){
    job.progress=p;let message;
    if(p.collectionRange)job.collectionRange=p.collectionRange;
    if(p.stage==='blocked')job.collectorError=p;
    if(p.query){
      const query=p.query.join(' / ');
      if(p.phase==='query-start')message=(p.cached?'校验缓存：':'开始查询：')+query;
      else if(p.queryElapsedMs!==undefined){
        const stats=job.queryTiming??={};const s=stats[p.query[0]]??={completed:0,failed:0,cached:0,elapsedMs:0,rateWaitMs:0,requests:0};
        s[p.phase==='query-error'?'failed':'completed']++;if(p.cached)s.cached++;s.elapsedMs+=p.queryElapsedMs;s.rateWaitMs+=p.rateWaitMs??0;s.requests+=p.requests??0;
        message=`${p.phase==='query-error'?'查询中断':p.cached?'复用断点':'查询完成'}：${query} · ${p.rows??0} 行 · 耗时 ${(p.queryElapsedMs/1000).toFixed(3)}秒 · 限流等待 ${((p.rateWaitMs??0)/1000).toFixed(3)}秒 · SDK请求 ${p.requests??0} 次`;
      }
    }else if(p.message)message=p.message;
    await this.save(job,message);
  }
  async execute(job){
    await this.stage(job,'preflight','检查固定输入和引擎版本');
    if(hash(await readFile(this.location(job.id,'request.json')))!==job.requestHash)throw failure('REQUEST_HASH','任务参数文件发生变化');
    if(job.request.purpose!=='collect'&&job.engineHash!==await engineHash())throw failure('ENGINE_CHANGED','引擎代码已改变。旧任务不能用新引擎静默恢复，请创建新任务');
    // An immutable snapshot needs no collection checkpoints. Keep its original
    // provenance while checking request/snapshot hashes and, for research, engine.
    const currentPipeline=await pipelineHash();
    if(!job.snapshotId&&job.pipelineHash!==currentPipeline){
      if(compatiblePipelines.has(job.pipelineHash)){
        job.pipelineMigrations??=[];job.pipelineMigrations.push({from:job.pipelineHash,to:currentPipeline,at:iso(this.clock()),reason:'已审查升级：查询身份和行情口径兼容；采集任务不运行策略引擎，断点仍按当前规则重新校验'});job.pipelineHash=currentPipeline;
        await this.save(job,'兼容恢复旧任务，保留原参数及累计时间；交易日历先校验完整覆盖，不完整日历隔离后重查；升级前未计时时段无法补测');
      }else throw failure('PIPELINE_CHANGED','采集或验收代码已改变，不能与旧断点混用，请创建新任务');
    }
    const cfg=job.request.config,collection=this.location(job.id,'collection');let bundle,bytes;
    if(job.snapshotId){const object=await this.bucket.get('snapshots/'+job.snapshotId+'.json');if(!object)throw failure('SNAPSHOT_MISSING','固定行情快照不存在');bytes=Buffer.from(object.body);if(hash(bytes)!==job.snapshotId)throw failure('SNAPSHOT_HASH','固定行情快照哈希不一致');bundle=JSON.parse(bytes);}
    else {
      await this.stage(job,'collect',job.request.purpose==='collect'?'采集指定证券原生5分钟、日线、历史状态和公司行动；不查询沪深300成员':'采集原生5分钟及日线、历史状态、成分和公司行动');await mkdir(collection,{recursive:true});await rm(path.join(collection,'cancel'),{force:true});
      if(this.collector){bundle=await this.collector(job.request,collection,job.controller.signal,p=>this.progress(job,p));bytes=Buffer.from(canonical(bundle));}
      else {await this.collectPython(job,collection);bytes=await readFile(path.join(collection,'bundle.json'));const receipt=JSON.parse(await readFile(path.join(collection,'receipt.json'),'utf8'));if(hash(bytes)!==receipt.sha256)throw failure('CACHE_HASH','采集结果与检查点回执不符');bundle=JSON.parse(bytes);bytes=Buffer.from(canonical(bundle));}
    }
    await this.stage(job,'validate','逐日核验48根原生5分钟、日线量价、历史ST、预热及除权因子');job.quality=acceptanceAudit(bundle,job.request);await this.save(job);
    if(job.quality.status!=='passed'&&job.request.purpose!=='collect')throw failure('DATA_ADMISSION','资料未通过正式准入；保留缺口报告',job.quality.issues);
    await this.stage(job,'ingest','保存不可变行情快照并读回核对SHA-256');const id=hash(bytes);
    const old=await this.bucket.get('snapshots/'+id+'.json');if(old&&hash(Buffer.from(old.body))!==id)throw failure('SNAPSHOT_HASH','仓库已有对象哈希不符');
    if(!old)await this.bucket.put('snapshots/'+id+'.json',bytes);
    const manifest={id,symbol:bundle.metadata.symbol,name:bundle.metadata.name??'',board:bundle.metadata.board,timeframe:'5m',source:bundle.metadata.source,syncedAt:job.createdAt,bytes:bytes.length,report:auditBundle(bundle)};
    if(!await this.bucket.get('manifests/'+id+'.json'))await this.bucket.put('manifests/'+id+'.json',canonical(manifest));
    if(hash(Buffer.from((await this.bucket.get('snapshots/'+id+'.json')).body))!==id)throw failure('SNAPSHOT_HASH','入库后读回核对失败');job.snapshotId=id;await this.save(job);
    const snapshot=this.location(job.id,'input.json');await atomic(snapshot,bytes.toString('utf8'));
    if(job.request.purpose==='collect'){
      // Collection preserves incomplete raw evidence too, but never runs the
      // engine or claims HS300 research admission. Formal audit stays strict.
      job.acceptance=bundle.metadata.synthetic?'synthetic-test-only':job.quality.status==='passed'?'market-data-only':'market-data-incomplete';job.resultHash=id;
      await this.stage(job,'report','保存行情采集报告；未进行策略回测或指数成员资格校验');
      await this.saveReport(job,{schemaVersion:1,acceptance:job.acceptance,input:{requestHash:job.requestHash,pipelineHash:job.pipelineHash,snapshotId:id},request:job.request,quality:job.quality,collection:{bars:bundle.bars.length,daily:bundle.daily.length,membershipChecked:false},limitations:['此报告仅确认行情采集和完整性，不是沪深300正式回测准入或盈利证明','存在资料问题时保留原始行情和问题清单，不补造缺失数据']});
      stopTiming(job,this.clock(),'completed');job.status='completed';job.stage='completed';delete job.error;await this.save(job,job.quality.status==='passed'?'行情采集完成，已入库；未查询指数成员、未运行回测':'行情已入库，存在资料问题，请查看报告');return;
    }
    const runConfig={...cfg,snapshotId:id};
    await this.stage(job,'backtest','后台运行回测；网页关闭后任务仍继续');const first=await this.runEngine(job,snapshot,runConfig);this.check(job);
    await this.stage(job,'verify','使用同一快照和参数独立重跑，并核对资产及费用');const second=await this.runEngine(job,snapshot,runConfig);const firstHash=hash(canonical(first)),secondHash=hash(canonical(second));
    if(firstHash!==secondHash||job.expectedResultHash&&firstHash!==job.expectedResultHash)throw failure('REPRODUCIBILITY','相同输入得到不同结果，验收失败');
    const accounting=auditAccounting(first,bundle);job.resultHash=firstHash;job.acceptance=bundle.metadata.synthetic?'synthetic-test-only':'passed';
    const report={schemaVersion:1,acceptance:job.acceptance,input:{requestHash:job.requestHash,configHash:job.configHash,engineHash:job.engineHash,pipelineHash:job.pipelineHash,snapshotId:id,runtime:{node:process.versions.node}},request:job.request,quality:job.quality,reproducibility:{status:'passed',runs:2,resultHash:firstHash,repeatedHash:secondHash},accounting,result:first,limitations:['历史沪深300成员按BaoStock周度快照；不证明交易所逐事件历史可得性','公司行动资料不完整或遇到未支持的配股时阻止正式回测','单标的历史样本不保证盈利；未平仓和未配对T均保留在报告']};
    await this.stage(job,'report','保存完整报告、交易明细与净值曲线');await this.saveReport(job,report);job.metrics=first.metrics;stopTiming(job,this.clock(),'completed');job.status='completed';job.stage='completed';delete job.error;await this.save(job,job.acceptance==='passed'?'真实数据流程验收通过（不代表策略盈利）':'合成夹具流程测试完成，不属于真实数据验收');
  }
  async saveReport(job,report){const bytes=canonical(report),id=hash(bytes);await atomic(path.join(this.root,'reports',id+'.json'),bytes);job.reportHash=id;job.reportRun=job.timing.runs.length;await this.save(job);}
  async python(){if(process.env.ASHARE_PYTHON)return process.env.ASHARE_PYTHON;for(const base of ['collector/.venv','.venv']){const venv=path.join(project,base,process.platform==='win32'?'Scripts/python.exe':'bin/python');try{await access(venv);return venv;}catch{}}return process.platform==='win32'?'python':'python3';}
  async sourceStatus(){
    if(this.sourceCache&&Date.now()-this.sourceCache.at<60000)return this.sourceCache.value;
    if(this.sourceProbe)return this.sourceProbe;
    this.sourceProbe=(async()=>{
      const executable=await this.python();let value;
      try{const stdout=await new Promise((resolve,reject)=>execFile(executable,[path.join(project,'collector/sources.py'),'--status'],{cwd:project,env:pythonEnv(),windowsHide:true,timeout:10000,maxBuffer:512*1024,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout)));
        value={backend:'local',ttlSeconds:60,...JSON.parse(stdout)};
      }catch(e){value={backend:'local',ttlSeconds:60,error:'无法读取Python数据源配置；网页演示仍可运行。请安装Python或设置ASHARE_PYTHON。',code:e.code==='ENOENT'?'PYTHON_MISSING':'SOURCE_STATUS_FAILED',sources:[]};}
      this.sourceCache={at:Date.now(),value};return value;
    })();try{return await this.sourceProbe;}finally{this.sourceProbe=null;}
  }
  async collectPython(job,collection){
    const executable=await this.python();await rm(path.join(collection,'error.json'),{force:true});
    const child=spawn(executable,[path.join(project,'collector/research_collect.py'),'--request',this.location(job.id,'request.json'),'--root',collection,'--store',path.join(this.root,'market'),'--parent',String(process.pid)],{cwd:project,env:pythonEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});this.child=child;
    let pending='',stderr='';const abort=()=>{writeFile(path.join(collection,'cancel'),'pause').catch(()=>{});child.kill();};job.controller.signal.addEventListener('abort',abort,{once:true});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{pending+=chunk;if(pending.length>1024*1024)pending=pending.slice(-65536);let index;while((index=pending.indexOf('\n'))!==-1){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const p=JSON.parse(line);this.progress(job,p).catch(()=>{});}catch{}}});
    child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
    try{await new Promise((resolve,reject)=>{child.once('error',e=>reject(failure('PYTHON_MISSING','无法启动Python。安装依赖，或设置ASHARE_PYTHON：'+e.code)));child.once('close',code=>code===0?resolve():reject(failure('COLLECTOR_ERROR','采集器中断：'+(stderr.includes('ModuleNotFoundError')?'缺少Python依赖，请安装collector/requirements.txt':'退出码 '+code))));});}
    catch(e){this.check(job);let detail;try{detail=JSON.parse(await readFile(path.join(collection,'error.json'),'utf8'));}catch{}throw detail?failure(detail.code,detail.error,detail.traceback?{collectorTraceback:detail.traceback}:undefined):e;}
    finally{job.controller.signal.removeEventListener('abort',abort);this.child=null;}
  }
  async runEngine(job,snapshot,config){
    if(this.runner)return this.runner(snapshot,config,job.controller.signal);
    const runner=new Worker(path.join(project,'server/research-runner.mjs'),{workerData:{snapshot,config}});this.engineWorker=runner;
    const abort=()=>runner.terminate();job.controller.signal.addEventListener('abort',abort,{once:true});
    try{return await new Promise((resolve,reject)=>{let received=false;runner.once('message',m=>{received=true;m.error?reject(failure('ENGINE_ERROR',m.error)):resolve(m.result);});runner.once('error',reject);runner.once('exit',code=>{if(!received)reject(failure(job.controller.signal.aborted?'PAUSED':'ENGINE_ERROR','回测线程退出：'+code));});});}
    finally{job.controller.signal.removeEventListener('abort',abort);await runner.terminate();this.engineWorker=null;}
  }
  async pause(id){const job=this.jobs.get(id);if(!job)throw failure('NOT_FOUND','任务不存在');if(!['running','queued'].includes(job.status))throw failure('STATE','任务当前无需暂停');
    if(job===this.active){job.controller.abort();await this.running;}else{job.status='paused';await this.save(job,'用户暂停，等待恢复');}return this.view(job);
  }
  async resume(id){const job=this.jobs.get(id);if(!job?.request)throw failure('NOT_FOUND','任务请求损坏或不存在');if(!['paused','blocked','failed'].includes(job.status))throw failure('STATE','仅暂停或受阻任务可以恢复');if(job.request.purpose!=='collect'&&job.engineHash!==this.fingerprint)throw failure('ENGINE_CHANGED','引擎已变更，请创建新任务');job.status='queued';delete job.error;delete job.collectorError;await this.save(job,'从已核验的检查点恢复');this.pump();return this.view(job);}
  async report(job){if(!job?.reportHash)throw failure('NOT_FOUND','报告尚未生成');const body=await readFile(path.join(this.root,'reports',job.reportHash+'.json'));if(hash(body)!==job.reportHash)throw failure('REPORT_HASH','报告文件哈希不一致');return body;}
  async repeat(id){const job=this.jobs.get(id);if(job?.status!=='completed')throw failure('STATE','仅完成的任务可固定快照复现');await this.report(job);if(job.request.purpose!=='collect'&&job.engineHash!==this.fingerprint)throw failure('ENGINE_CHANGED','引擎已变更，无法按原版本复现');return this.create(null,{replay:job});}
  async close(){this.stopping=true;if(this.active){this.active.controller.abort();await this.running;}await this.saves;await rm(this.lock,{recursive:true,force:true});}
  async fetch(request){
    try{const url=new URL(request.url),pathname=url.pathname,base='/api/research/jobs';
      if(pathname==='/api/research/sources'&&request.method==='GET')return jsonResponse(await this.sourceStatus());
      if(request.method==='POST'){const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return jsonResponse({error:'只接受本站任务写入'},403);if(!request.headers.get('content-type')?.startsWith('application/json'))return jsonResponse({error:'需要JSON请求'},415);}
      if(pathname===base&&request.method==='GET')return jsonResponse({jobs:[...this.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>this.view(j)),backend:'local',serial:true});
      if(pathname===base&&request.method==='POST')return jsonResponse(await this.create(await request.json()),202);
      const match=pathname.match(/^\/api\/research\/jobs\/([a-f0-9]{24})(?:\/(pause|resume|repeat|report|timing))?$/);if(!match)return jsonResponse({error:'任务接口不存在'},404);const job=this.jobs.get(match[1]);if(!job)return jsonResponse({error:'任务不存在'},404);
      if(!match[2]&&request.method==='GET')return jsonResponse(this.view(job));
      if(match[2]==='report'&&request.method==='GET')return new Response(await this.report(job),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="'+job.id+'-report.json"','cache-control':'no-store','etag':'"'+job.reportHash+'"'}});
      if(match[2]==='timing'&&request.method==='GET'){
        await this.saves;let events=[];try{events=(await readFile(this.location(job.id,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
        return new Response(JSON.stringify({id:job.id,status:job.status,stage:job.stage,timing:timingView(job,this.clock()),queryTiming:job.queryTiming??{},events:events.length?events:job.events,notes:['activeMs只包含实际执行，包括网络与限流等待；暂停、排队、停机时间不计入','每5秒落盘；异常退出最多缺少最后未落盘片段，标记interruptedTailUnmeasured','legacyUnmeasured表示升级前没有计时，旧耗时无法补测','耗时与日志独立于确定性回测报告哈希']}),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="'+job.id+'-timing.json"','cache-control':'no-store'}});
      }
      if(['pause','resume','repeat'].includes(match[2])&&request.method==='POST')return jsonResponse(await this[match[2]](job.id),202);
      return jsonResponse({error:'任务方法不存在'},405);
    }catch(e){return jsonResponse({error:e.message,code:e.code??'TASK_ERROR'},e.code==='NOT_FOUND'?404:e.code==='REQUEST'||e.message.includes('参数')?400:409);}
  }
}
