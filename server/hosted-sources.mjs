const evidenceKey='source-health/lixinger.json';
const keyOf=env=>env.LIXINGER_API_KEY||env.LIXINGER_TOKEN||env['lixingren-key'];
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
let activeProbe;
export async function hostedSourceStatus(env){
  let evidence=null;try{const obj=await env.BUCKET?.get(evidenceKey);if(obj)evidence=await obj.json();}catch{}
  const configured=!!keyOf(env);
  return json({backend:'hosted',sources:[
    {name:'baostock',transport:'tcp',requiresKey:false,capabilities:['daily','minute5','adj_factor','historical_st'],health:{state:'blocked',code:'HOSTED_TCP_UNSUPPORTED'}},
    {name:'akshare',transport:'http',requiresKey:false,capabilities:['daily','minute5','adj_factor'],health:{state:'unavailable',code:'PYTHON_LOCAL_ONLY'}},
    {name:'mootdx',transport:'tcp',requiresKey:false,capabilities:['daily','minute5'],health:{state:'blocked',code:'HOSTED_TCP_UNSUPPORTED'}},
    {name:'lixinger',transport:'http',requiresKey:true,capabilities:['daily'],health:configured?{state:evidence?.ok&&Date.now()-Date.parse(evidence.checkedAt)<86400000?'healthy':'ready-unprobed',code:null}:{state:'unavailable',code:'CREDENTIAL_MISSING'}},
    {name:'sina',transport:'http',requiresKey:false,capabilities:['minute5'],health:{state:'unavailable',code:'COLLECTOR_LOCAL_ONLY'}}
  ],lixinger:{configured,lastProbe:evidence?{ok:evidence.ok,checkedAt:evidence.checkedAt,symbol:evidence.symbol,from:evidence.from,to:evidence.to,bars:evidence.bars,code:evidence.code}:null}});
}
export async function probeLixinger(request,env,fetcher=fetch){
  const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return json({error:'只接受本站验证请求'},403);
  if(!keyOf(env))return json({error:'网站尚未配置理杏仁密钥',code:'CREDENTIAL_MISSING'},503);
  if(!env.BUCKET)return json({error:'验证记录仓库暂不可用'},503);
  // A paid probe is explicit, single-request and cached for 24 hours. Never run
  // it from the readiness GET, retry automatically, or return vendor errors.
  if(activeProbe)return activeProbe.then(v=>json(v));
  activeProbe=(async()=>{
    const old=await env.BUCKET.get(evidenceKey),saved=old?await old.json():null;
    if(saved&&Date.now()-Date.parse(saved.checkedAt)<86400000)return {...saved,cached:true};
    const evidence={ok:false,symbol:'600519',from:'2026-09-30',to:'2026-09-30',checkedAt:new Date().toISOString(),bars:0,formalAdmission:false,code:null};
    try{
      const response=await fetcher('https://open.lixinger.com/api/cn/company/candlestick',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:keyOf(env),stockCode:evidence.symbol,type:'ex_rights',startDate:evidence.from,endDate:evidence.to}),signal:AbortSignal.timeout(30000)});
      if(!response.ok){evidence.code='PROVIDER_HTTP_'+response.status;}
      else{
        const result=await response.json(),rows=result.data;
        if(result.code!==1)evidence.code='PROVIDER_PERMISSION_OR_QUOTA';
        else if(!Array.isArray(rows)||rows.length!==1||String(rows[0].date).slice(0,10)!==evidence.from||['open','high','low','close'].some(k=>!Number.isFinite(rows[0][k])||rows[0][k]<=0)||rows[0].high<Math.max(rows[0].open,rows[0].close)||rows[0].low>Math.min(rows[0].open,rows[0].close)||!Number.isFinite(rows[0].volume)||rows[0].volume<0)evidence.code='DATA_VALIDATION_FAILED';
        else{
          evidence.ok=true;evidence.bars=rows.length;
          const bytes=new TextEncoder().encode(JSON.stringify(rows)),digest=await crypto.subtle.digest('SHA-256',bytes);
          evidence.rawSha256=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
          await env.BUCKET.put('source-evidence/lixinger-'+evidence.rawSha256+'.json',JSON.stringify({source:'lixinger',symbol:evidence.symbol,requested:{from:evidence.from,to:evidence.to},rows,priceBasis:'raw',volumeUnit:'provider-unverified',formalAdmission:false}),{httpMetadata:{contentType:'application/json'}});
        }
      }
    }catch{evidence.ok=false;evidence.code='PROVIDER_REQUEST_FAILED';}
    await env.BUCKET.put(evidenceKey,JSON.stringify(evidence),{httpMetadata:{contentType:'application/json'}});
    return evidence;
  })();
  try{return json(await activeProbe);}catch{return json({error:'验证记录未确认保存成功',code:'PROBE_STORAGE_FAILED'},503);}finally{activeProbe=null;}
}
