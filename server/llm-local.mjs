import {mkdir,readFile,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LLMGateway,llmReply,llmJSON,llmError,validateProvider,publicProvider} from './llm.mjs';

export class LocalLLM extends LLMGateway{
 constructor({root,fetcher,timeoutMs,clock}={}){
  super({local:true,fetcher,timeoutMs,clock});this.root=path.resolve(root);this.file=path.join(this.root,'providers.json');this.saved=[];this.writes=Promise.resolve();this.loadError=null;this.providers=()=>{if(this.loadError)throw this.loadError;return this.saved;};
 }
 async init(){
  await mkdir(this.root,{recursive:true,mode:0o700});
  try{const raw=JSON.parse(await readFile(this.file,'utf8'));if(!Array.isArray(raw))throw Error();this.saved=raw.map(p=>validateProvider(p,{local:true}));await this.list();}catch(e){if(e.code!=='ENOENT')this.loadError=llmError('PROFILE','本地模型配置文件损坏，请修复 .local-data/llm/providers.json 后重启；其他回测功能仍可使用',503);}return this;
 }
 async persist(next){
  const tmp=this.file+'.tmp-'+randomUUID(),handle=await open(tmp,'wx',0o600);try{await handle.writeFile(JSON.stringify(next,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(tmp,this.file);this.saved=next;
 }
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname!=='/api/llm/providers/save'||request.method!=='POST')return super.fetch(request);
  try{
   if(this.loadError)throw this.loadError;
   const input=await llmJSON(request);
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['provider','removeId','clearKey'].includes(k)))throw llmError('PROFILE','服务修改格式无效');
   if(this.active)throw llmError('BUSY','请等待当前模型请求结束后再修改服务',409);
   const change=async()=>{
    if(this.active)throw llmError('BUSY','请等待当前模型请求结束后再修改服务',409);
    let next;
    if(input.removeId){if(input.provider||typeof input.removeId!=='string'||!this.saved.some(p=>p.id===input.removeId))throw llmError('PROFILE','要移除的服务不存在');next=this.saved.filter(p=>p.id!==input.removeId);}
    else{
     const old=this.saved.find(p=>p.id===input.provider?.id);
     if(old?.apiKey&&old.baseUrl.replace(/\/+$/,'')!==String(input.provider?.baseUrl??'').replace(/\/+$/,'')&&!input.provider?.apiKey&&!input.clearKey)throw llmError('KEY_ENDPOINT','服务地址改变时，请重新填写 API Key 或勾选清除密钥；原密钥不会转发到新地址');
     const p=validateProvider({...input.provider,apiKey:input.clearKey?'':input.provider?.apiKey||old?.apiKey||''},{local:true});
     next=[...this.saved.filter(x=>x.id!==p.id),p];if(next.length>20)throw llmError('PROFILE','最多保存 20 个模型服务');
    }
    await this.persist(next);return llmReply({providers:next.map(publicProvider),saved:true});
   };
   const task=this.writes.then(change);this.writes=task.catch(()=>{});return await task;
  }catch(e){return llmReply({error:e.status?e.message:'本地服务配置保存失败，未确认更新；请保留输入后重试',code:e.code??'PROFILE_SAVE'},e.status??503);}
 }
}
