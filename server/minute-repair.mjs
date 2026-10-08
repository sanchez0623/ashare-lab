import {mkdir,readFile,writeFile,rename,readdir,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {repairPlan,makeRepair,verifyRepairSnapshot,repairVersion,stable,repairScope} from '../dist/minute-repair.mjs';
import {auditBundle} from '../dist/quality.mjs';
import {ensureTiming,accrue,startTiming,stopTiming,timingView} from './research-timing.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const error=(code,message,status=409)=>Object.assign(Error(message),{code,status});
const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
// Reviewed previous version used identical immutable source responses and raw
// bar semantics. Recovery still validates its request, parent and evidence.
const compatibleRepairs=new Set(['8e8916f5d794a1becf21bd1bf61691831a1f2616d75be9664dbf85ca51afa7c2','5b96eb04c4967c73c285189ffa3fdc6ada2a17a010ce7e003a2bc8d0ffb233ff']);
async function atomic(target,value){await mkdir(path.dirname(target),{recursive:true});const temp=target+'.tmp-'+randomUUID(),handle=await open(temp,'wx');try{await handle.writeFile(typeof value==='string'?value:stable(value));await handle.sync();}finally{await handle.close();}await rename(temp,target);}

export class MinuteRepairManager {
  constructor({root,bucket,python,collector,archiver,clock=Date.now,heartbeatMs=5000}={}){this.root=root;this.bucket=bucket;this.python=python;this.collector=collector;this.archiver=archiver;this.clock=clock;this.heartbeatMs=heartbeatMs;this.jobs=new Map();this.writes=Promise.resolve();this.active=null;this.stopping=false;}
  location(id,name){if(!/^[a-f0-9]{24}$/.test(id))throw error('REPAIR_NOT_FOUND','核验任务不存在',404);return path.join(this.root,id,name);}
  async init(){
    await mkdir(this.root,{recursive:true});this.fingerprint=hash((await Promise.all(['server/minute-repair.mjs','dist/minute-repair.mjs','dist/quality.mjs','dist/data.mjs','collector/minute_repair.py','collector/repair_archive.py','collector/sources.py','collector/query_cache.py','collector/parquet_store.py','dist/corporate-correction.mjs','dist/corporate-evidence.json'].map(p=>readFile(path.join(project,p))))).map(hash).join('|'));
    for(const id of await readdir(this.root)){if(!/^[a-f0-9]{24}$/.test(id))continue;try{const j=JSON.parse(await readFile(this.location(id,'state.json'),'utf8'));const request=await readFile(this.location(id,'request.json'));if(j.id!==id||hash(request)!==j.requestHash)throw Error('核验请求哈希不符');j.request=JSON.parse(request);ensureTiming(j);if(j.status==='running'){stopTiming(j,this.clock(),'interrupted',{recovered:true});j.status='paused';}this.jobs.set(id,j);}catch(e){this.jobs.set(id,{id,status:'blocked',stage:'recovery',createdAt:new Date(this.clock()).toISOString(),events:[],error:{code:'REPAIR_INTEGRITY',message:e.message}});}}
    this.pump();return this;
  }
  view(j){const {controller,...state}=j;return {...state,timing:timingView(j,this.clock())};}
  async save(j,message){accrue(j,this.clock());j.updatedAt=new Date(this.clock()).toISOString();if(message){j.events??=[];j.events.push({at:j.updatedAt,stage:j.stage,message,activeMs:j.timing.activeMs});j.events=j.events.slice(-100);}const value=stable(this.view(j));this.writes=this.writes.then(()=>atomic(this.location(j.id,'state.json'),value));await this.writes;}
  async snapshot(id){if(!/^[a-f0-9]{64}$/.test(id??''))throw error('REPAIR_REQUEST','请选择完整原始行情快照',400);const o=await this.bucket.get('snapshots/'+id+'.json');if(!o)throw error('REPAIR_MISSING','原始快照不存在',404);const bytes=Buffer.from(await new Response(o.body).arrayBuffer());if(hash(bytes)!==id)throw error('REPAIR_HASH','原始快照哈希不符，拒绝修复');return {bytes,bundle:JSON.parse(bytes)};}
  async create(input){
    const baseSnapshotId=input?.snapshotId;const {bundle}=await this.snapshot(baseSnapshotId),plan=repairPlan(bundle);
    const duplicate=[...this.jobs.values()].find(j=>j.request?.baseSnapshotId===baseSnapshotId&&j.fingerprint===this.fingerprint);if(duplicate)return this.view(duplicate);
    const request={version:repairVersion,baseSnapshotId,symbol:plan.symbol,plan,sources:['mootdx','akshare','sina']},bytes=stable(request),id=randomUUID().replaceAll('-','').slice(0,24);
    const j={id,request,requestHash:hash(bytes),fingerprint:this.fingerprint,createdAt:new Date(this.clock()).toISOString(),status:'queued',stage:'queued',events:[],evidence:{},attempts:[],symbol:plan.symbol,baseSnapshotId,targetDays:plan.days.length,verifiedDays:0};ensureTiming(j);await atomic(this.location(id,'request.json'),bytes);this.jobs.set(id,j);await this.save(j,'已固定原始快照与异常日期；只使用独立分钟证据，不改写原始数据');this.pump();return this.view(j);
  }
  check(j){if(j.controller.signal.aborted||this.stopping)throw error('REPAIR_PAUSED','已暂停；完整第二源响应和分页证据已保留');}
  pump(){if(this.active||this.stopping)return;const j=[...this.jobs.values()].find(x=>x.status==='queued');if(!j)return;this.active=j;j.controller=new AbortController();this.running=this.execute(j).catch(async e=>{stopTiming(j,this.clock(),j.controller.signal.aborted?'paused':'blocked');j.status=j.controller.signal.aborted?'paused':'blocked';if(!j.controller.signal.aborted)j.error={code:e.code??'REPAIR_FAILED',message:e.message};await this.save(j,j.controller.signal.aborted?'核验暂停，保留断点及累计耗时':e.message);}).finally(()=>{this.active=null;delete j.controller;this.pump();});}
  async execute(j){
    if(j.fingerprint!==this.fingerprint){
      if(!compatibleRepairs.has(j.fingerprint))throw error('REPAIR_VERSION','核验实现已变更，请从原快照创建新版本任务');
      const {bundle}=await this.snapshot(j.request.baseSnapshotId);const plan=repairPlan(bundle);
      if(stable(plan.days)!==stable(j.request.plan.days)||stable(plan.range)!==stable(j.request.plan.range))throw error('REPAIR_VERSION','原快照异常日期已变更，请创建新核验任务');
      j.previousFingerprint=j.fingerprint;j.fingerprint=this.fingerprint;await this.save(j,'已恢复经审查的旧版任务；原始响应与分页哈希仍核验，成功来源保留，只重试失败来源');
    }
    startTiming(j,this.clock());j.status='running';j.stage='collect';delete j.error;await this.save(j,'开始核验第二分钟源；不调用BaoStock，不消费理杏仁额度');
    const timer=setInterval(()=>this.save(j).catch(()=>{}),this.heartbeatMs);timer.unref();
    try{
      const {bundle}=await this.snapshot(j.request.baseSnapshotId),batches=[];
      for(const source of j.request.sources){
        this.check(j);j.source=source;await this.save(j,'检查 '+source+' 的真实分钟覆盖');let batch;
        try{
          if(j.evidence[source]){const body=await readFile(this.location(j.id,'evidence/'+source+'.json'));if(hash(body)!==j.evidence[source])throw error('REPAIR_HASH','已保存的 '+source+' 响应哈希不符');batch=JSON.parse(body);await this.save(j,'复用已完成 '+source+' 响应，不重新请求');}
          else {
            const request={source,symbol:j.request.symbol,range:j.request.plan.range,baseSnapshotId:j.request.baseSnapshotId};
            batch=this.collector?await this.collector(request,this.location(j.id,'collection'),j.controller.signal,p=>this.save(j,p.message)):await this.collectPython(j,request);
            this.check(j);const body=stable(batch);await atomic(this.location(j.id,'evidence/'+source+'.json'),body);j.evidence[source]=hash(body);await this.save(j);
          }
          batches.push(batch);
        }catch(e){this.check(j);if(e.code==='REPAIR_HASH')throw e;j.attempts.push({source,code:e.code??'REPAIR_PROVIDER_FAILED',message:e.message});await this.save(j,source+' 未能取得可核验响应：'+e.message);}
        const result=await makeRepair(bundle,j.request.baseSnapshotId,batches);j.verifiedDays=result.report.verifiedDays;j.unresolved=result.report.unresolved;await this.save(j,'已核验可替代 '+j.verifiedDays+' / '+j.targetDays+' 个异常日');if(result.bundle)break;
      }
      this.check(j);j.stage='validate';const result=await makeRepair(bundle,j.request.baseSnapshotId,batches);result.report.connectionAttempts=j.attempts;const reportBody=stable(result.report);j.reportHash=hash(reportBody);await atomic(this.location(j.id,'reports/'+j.reportHash+'.json'),reportBody);j.verifiedDays=result.report.verifiedDays;j.unresolved=result.report.unresolved;j.coverageSummary=result.report.summary;j.sourceCoverage=result.report.attempts.map(a=>({source:a.source,actual:a.actual??null,providerRetainedRange:a.providerRetainedRange??null,code:a.code??null}));await this.save(j);
      if(!result.bundle)throw error('REPAIR_COVERAGE','仍有 '+result.report.unresolved.length+' 日未取得通过核验的第二源证据（未返回该日数据 '+result.report.summary.noResponseDays+' 日；返回后未通过 '+result.report.summary.returnedButUnverifiedDays+' 日），未生成修复快照。这不代表原快照缺失这些日期。原快照保留；只有量价警告时仍可回测，公司行动等阻断须另行处理。请下载第二源核验报告，检查失败源与实际覆盖。');
      this.check(j);j.stage='archive';await this.save(j,'全部异常日期已验证，生成新的Parquet归档和不可变快照');let repaired=result.bundle;
      if(this.archiver)repaired=await this.archiver(repaired,this.location(j.id,'archive'),j.controller.signal);else repaired=await this.archivePython(j,repaired);
      this.check(j);await verifyRepairSnapshot(repaired);const bytes=Buffer.from(stable(repaired)),id=hash(bytes);const prior=await this.bucket.get('snapshots/'+id+'.json');if(prior&&hash(Buffer.from(await new Response(prior.body).arrayBuffer()))!==id)throw error('REPAIR_HASH','仓库同名修复快照哈希冲突');if(!prior)await this.bucket.put('snapshots/'+id+'.json',bytes);
      const m=repaired.metadata,manifest={id,symbol:m.symbol,name:m.name,board:m.board,timeframe:'5m',source:m.source,primarySource:m.primarySource,minuteRepair:{baseSnapshotId:j.baseSnapshotId,verifiedDays:j.verifiedDays},syncedAt:j.createdAt,bytes:bytes.length,report:auditBundle(repaired,{scope:repairScope(repaired)})};
      await this.snapshot(id);if(!await this.bucket.get('manifests/'+id+'.json'))await this.bucket.put('manifests/'+id+'.json',stable(manifest));j.snapshotId=id;j.stage='completed';j.status='completed';stopTiming(j,this.clock(),'completed');await this.save(j,'修复快照已入库并读回核验；原始快照未变，可载入回测');
    }finally{clearInterval(timer);}
  }
  async runPython(j,args){
    this.check(j);const child=spawn(await this.python(),args,{cwd:project,env:{...process.env,PYTHONIOENCODING:'utf-8'},windowsHide:true,stdio:['ignore','pipe','pipe']});let pending='',last=null,stderr='';const abort=()=>child.kill();j.controller.signal.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(()=>child.kill(),240000);timeout.unref();
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{pending+=chunk;if(pending.length>1024*1024){child.kill();return;}let i;while((i=pending.indexOf('\n'))!==-1){const line=pending.slice(0,i);pending=pending.slice(i+1);try{last=JSON.parse(line);if(last.message)this.save(j,last.message).catch(()=>{});}catch{}}});
    child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    try{await new Promise((resolve,reject)=>{child.once('error',()=>reject(error('PYTHON_MISSING','无法启动采集Python环境，请检查本地依赖')));child.once('close',code=>code===0?resolve():reject(error(last?.code??'REPAIR_PROVIDER_FAILED',last?.message??(stderr.includes('ModuleNotFoundError')?'缺少Python依赖，请按本地说明安装':'第二源进程中断，已保留检查点'))));});this.check(j);}
    finally{clearTimeout(timeout);j.controller.signal.removeEventListener('abort',abort);}
  }
  async collectPython(j,request){const dir=this.location(j.id,'collection'),input=path.join(dir,request.source+'-request.json'),output=path.join(dir,request.source+'-response.json');await atomic(input,request);await this.runPython(j,[path.join(project,'collector/minute_repair.py'),'--request',input,'--root',path.join(dir,request.source),'--output',output,'--parent',String(process.pid)]);return JSON.parse(await readFile(output,'utf8'));}
  async archivePython(j,bundle){const dir=this.location(j.id,'archive'),input=path.join(dir,'input.json'),output=path.join(dir,'bundle.json');await atomic(input,bundle);await this.runPython(j,[path.join(project,'collector/repair_archive.py'),'--input',input,'--output',output,'--root',path.join(this.root,'parquet')]);return JSON.parse(await readFile(output,'utf8'));}
  async pause(id){const j=this.jobs.get(id);if(!j||!['queued','running'].includes(j.status))throw error('REPAIR_STATE','只有等待或运行中的任务可暂停');if(j===this.active){j.controller.abort();await this.running;}else{j.status='paused';await this.save(j,'已暂停，等待恢复');}return this.view(j);}
  async resume(id){const j=this.jobs.get(id);if(!j?.request||!['blocked','paused'].includes(j.status))throw error('REPAIR_STATE','只有受阻或暂停任务可恢复');if(j.fingerprint!==this.fingerprint&&!compatibleRepairs.has(j.fingerprint))throw error('REPAIR_VERSION','核验实现已变更，请从原快照创建新版本任务');j.status='queued';await this.save(j,'恢复已固定的原快照与响应检查点；累计耗时继续计时');this.pump();return this.view(j);}
  async report(id){const j=this.jobs.get(id);if(!j?.reportHash||!/^[a-f0-9]{64}$/.test(j.reportHash))throw error('REPAIR_NOT_FOUND','报告尚未生成',404);const bytes=await readFile(this.location(id,'reports/'+j.reportHash+'.json'));if(hash(bytes)!==j.reportHash)throw error('REPAIR_HASH','核验报告哈希不符');return bytes;}
  async verify(id){const j=this.jobs.get(id);if(!j?.snapshotId||j.status!=='completed')throw error('REPAIR_STATE','仅完成的修复快照可复现核验');const {bundle}=await this.snapshot(j.snapshotId);await verifyRepairSnapshot(bundle);const report=auditBundle(bundle,{scope:repairScope(bundle)});if(report.status!=='passed')throw error('REPAIR_ADMISSION','固定修复快照未通过完整校验');return {status:'passed',snapshotId:j.snapshotId,report,noMarketRequests:true};}
  async close(){this.stopping=true;if(this.active){this.active.controller.abort();await this.running;}await this.writes;}
  async fetch(request){
    const url=new URL(request.url),base='/api/research/repairs';try{
      if(request.method==='POST'){if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin)return reply({error:'只接受本站写入'},403);if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'需要JSON参数'},415);}
      if(url.pathname===base&&request.method==='GET')return reply({backend:'local',version:repairVersion,jobs:[...this.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>this.view(j))});
      if(url.pathname===base&&request.method==='POST'){const body=await request.text();if(body.length>1000)return reply({error:'参数过长'},413);return reply(await this.create(JSON.parse(body)),202);}
      const match=url.pathname.match(/^\/api\/research\/repairs\/([a-f0-9]{24})(?:\/(pause|resume|report|verify))?$/),j=match&&this.jobs.get(match[1]);if(!j)return reply({error:'核验任务不存在'},404);
      if(!match[2]&&request.method==='GET')return reply(this.view(j));
      if(match[2]==='report'&&request.method==='GET')return new Response(await this.report(j.id),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="minute-repair-report.json"'}});
      if(['pause','resume','verify'].includes(match[2])&&request.method==='POST')return reply(await this[match[2]](j.id),202);return reply({error:'核验方法不存在'},405);
    }catch(e){return reply({error:e.message,code:e.code??'REPAIR_FAILED'},e.status??409);}
  }
}
