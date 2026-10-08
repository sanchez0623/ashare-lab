import {auditBundle} from '../dist/quality.mjs';
import {hostedSourceStatus,probeLixinger} from './hosted-sources.mjs';
import {assembleStored} from './assemble.mjs';
import {correctStoredActions} from './corporate-correction.mjs';
import {verifyOfficialCorrections} from '../dist/corporate-correction.mjs';
import {verifyRepairSnapshot} from '../dist/minute-repair.mjs';
import {hostedLLM} from './llm.mjs';
import {portfolioReports} from './portfolio-reports.mjs';
const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
export default {async fetch(request,env){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  try{
    if(url.pathname==='/api/research/traffic'||url.pathname==='/api/research/traffic/settings')return reply({error:'本机IP与BaoStock用量需在本地部署版查看；托管后台不能采集BaoStock TCP，也不能探测你电脑的公网IP。',code:'TRAFFIC_LOCAL_ONLY'},501);
    if(url.pathname.startsWith('/api/llm/'))return await hostedLLM(request,env);
    if(url.pathname.startsWith('/api/research/repairs'))return reply({error:'第二分钟源核验需在本地部署版运行；托管网站不能连接通达信TCP。',code:'REPAIR_LOCAL_ONLY'},501);
    if(url.pathname==='/api/research/sources'&&request.method==='GET')return await hostedSourceStatus(env);
    if(url.pathname==='/api/sources/lixinger/probe'&&request.method==='POST')return await probeLixinger(request,env);
    if(!env.BUCKET)return reply({error:'行情仓库暂不可用，请稍后重试；当前文件仍可保留在浏览器中。'},503);
    if(url.pathname.startsWith('/api/portfolio/'))return await portfolioReports(request,env.BUCKET);
    if(url.pathname==='/api/data/catalog'&&request.method==='GET'){
      const listed=await env.BUCKET.list({prefix:'manifests/',limit:100,cursor:url.searchParams.get('cursor')||undefined});const entries=await Promise.all(listed.objects.map(async x=>{const obj=await env.BUCKET.get(x.key);return obj?await obj.json():null;}));return reply({entries:entries.filter(Boolean).sort((a,b)=>b.syncedAt.localeCompare(a.syncedAt)),truncated:listed.truncated,cursor:listed.truncated?listed.cursor:null});
    }
    if(url.pathname==='/api/data/bundle'&&request.method==='GET'){
      const id=url.searchParams.get('id');if(!/^[a-f0-9]{64}$/.test(id??''))return reply({error:'快照编号无效'},400);
      const obj=await env.BUCKET.get('snapshots/'+id+'.json');return obj?new Response(obj.body,{headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, max-age=31536000, immutable','etag':obj.httpEtag}}):reply({error:'快照不存在'},404);
    }
    if(['/api/data/assemble','/api/data/corporate-correction'].includes(url.pathname)&&request.method==='POST'){
      const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return reply({error:'只接受本站写入'},403);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'需要JSON合并参数'},415);
      const reader=request.body?.getReader();if(!reader)return reply({error:'参数为空'},400);let size=0;const chunks=[];
      while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>20000){await reader.cancel();return reply({error:'合并参数超过20KB'},413);}chunks.push(x.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length;}
      let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reply({error:'合并参数JSON无效'},400);}
      const saved=url.pathname==='/api/data/corporate-correction'?await correctStoredActions(env.BUCKET,input,{archiver:env.CORPORATE_ARCHIVER}):await assembleStored(env.BUCKET,input);return reply(saved,saved.reused?200:201);
    }
    if(url.pathname==='/api/data/ingest'&&request.method==='POST'){
      // The platform dispatch authenticates this owner-private Site before entry.
      // Browser mutations must be same-origin; unattended clients use the platform
      // service credential header (consumed upstream), not any browser/API key.
      const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return reply({error:'只接受本站写入'},403);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'需要 JSON 数据包'},415);
      const reader=request.body?.getReader();if(!reader)return reply({error:'数据包为空'},400);let size=0;const chunks=[];while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>25*1024*1024){await reader.cancel();return reply({error:'数据包超过 25 MB'},413);}chunks.push(x.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length;}
      let bundle;try{bundle=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reply({error:'JSON 或 UTF-8 编码无效'},400);}
      if(bundle.bars?.length>120000)return reply({error:'单快照最多 120,000 根行情，较长历史请分段采集'},400);
      let report;try{report=auditBundle(bundle,{scope:bundle.metadata?.collectionPurpose==='market-data-only'||bundle.metadata?.universe==='SINGLE_SECURITY'?'single-security':'hs300'});}catch(e){return reply({error:e.message},400);}
      if(bundle.metadata?.minuteRepair)await verifyRepairSnapshot(bundle);
      verifyOfficialCorrections(bundle);
      const digest=await crypto.subtle.digest('SHA-256',bytes),id=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      const key='manifests/'+id+'.json',existing=await env.BUCKET.get(key);if(existing)return reply({...await existing.json(),reused:true});
      const metadata=bundle.metadata??{};const manifest={id,symbol:metadata.symbol??'',name:metadata.name??'',board:metadata.board,timeframe:metadata.timeframe,source:metadata.source??'uploaded',syncedAt:new Date().toISOString(),bytes:size,report};
      await env.BUCKET.put('snapshots/'+id+'.json',bytes,{httpMetadata:{contentType:'application/json'}});
      // Immutable manifest is published only after the full snapshot is durable.
      await env.BUCKET.put(key,JSON.stringify(manifest),{httpMetadata:{contentType:'application/json'}});
      return reply(manifest,201);
    }
    return reply({error:'接口或方法不存在'},404);
  }catch(e){if(e.status)return reply({error:e.message,code:e.code,details:e.details},e.status);console.error('data warehouse request failed',url.pathname,e.message);return reply({error:'行情仓库操作失败，未确认保存成功。保留文件后重试。'},503);}
}};
