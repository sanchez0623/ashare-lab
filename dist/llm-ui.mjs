import {parameterContext,parameterSchema,validateParameterValue,strategyNames} from './parameter-schema.mjs';
import {validate,managementNames,periodLabel} from './engine.mjs';

export function setupLLM({getContext,setConfig,notify}){
 const $=s=>document.querySelector(s),escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let providers=[],editable=false,proposal=null,sourceData=null,active=null;
 const display=(key,v)=>key==='strategy'?strategyNames[v]:key==='management'?managementNames[v]:key==='timeframe'?periodLabel(v):Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:5}):v;
 async function request(url,body,signal){const r=await fetch(url,body===undefined?{signal}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});let v;try{v=await r.json();}catch{throw Error('模型后台未返回 JSON，请更新完整部署包并重启');}if(!r.ok)throw Object.assign(Error(v.error||'模型请求失败'),{code:v.code,field:v.field});return v;}
 function clear(){proposal=null;$('#llm-proposal').replaceChildren();$('#llm-apply').hidden=true;}
 function clearProfileValidation(form){for(const field of form.elements){field.setCustomValidity?.('');field.removeAttribute('aria-invalid');}}
 function providerOptions(selected){
  $('#llm-provider').innerHTML=providers.length?providers.map(p=>`<option value="${escape(p.id)}">${escape(p.name)} · ${escape(p.model)}${p.ready?'':' · 缺少密钥'}</option>`).join(''):'<option value="">尚未配置模型服务</option>';
  if(providers.some(p=>p.id===selected))$('#llm-provider').value=selected;
  $('#llm-profile-existing').innerHTML='<option value="">新增服务</option>'+providers.map(p=>`<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
  $('#llm-send').disabled=!providers.length||!!active;
 }
 async function refreshProviders(){try{
  const v=await request('/api/llm/providers'),selected=$('#llm-provider').value;providers=v.providers;editable=v.editable;providerOptions(selected);
  $('#llm-profile-form').hidden=!editable;
  $('#llm-config-note').textContent=editable?'可保存多个服务，密钥仅保存在本机后台。留空密钥表示保留原值；修改服务地址时需重新填写或清除密钥。':'托管版由后台私有环境变量 LLM_PROVIDERS_JSON 配置服务；本机服务需在本地部署版使用。';
  $('#llm-status').textContent=providers.length?'已载入 '+providers.length+' 个模型服务。每次发送只调用所选服务一次。':'尚未配置 LLM。请展开“模型服务配置”；自动微调可以独立使用。';
 }catch(e){$('#llm-status').textContent=e.message;$('#llm-send').disabled=true;}}
 function editProfile(){
  const p=providers.find(p=>p.id===$('#llm-profile-existing').value),form=$('#llm-profile-form');
  for(const [name,value]of Object.entries({id:p?.id??'',name:p?.name??'',kind:p?.kind??'volcengine',baseUrl:p?.baseUrl??'https://ark.cn-beijing.volces.com/api/v3',model:p?.model??'',apiKey:''}))form.elements.namedItem(name).value=value;
  clearProfileValidation(form);
  form.elements.namedItem('id').readOnly=!!p;form.elements.namedItem('clearKey').checked=false;form.elements.namedItem('apiKey').placeholder=p?.hasKey?'已配置；留空保留':'云端服务填写 API Key';$('#llm-profile-remove').disabled=!p;
 }
 const profileForm=$('#llm-profile-form');
 profileForm.addEventListener('input',()=>clearProfileValidation(profileForm));
 profileForm.addEventListener('change',e=>{clearProfileValidation(profileForm);if(['id','name','model','baseUrl'].includes(e.target.name))e.target.value=e.target.value.trim();});
 profileForm.addEventListener('invalid',e=>{e.target.setAttribute('aria-invalid','true');$('#llm-status').textContent=e.target.name==='id'?'服务编号需为 1–48 个英文、数字、点号、下划线或短横线，例如 deepseek-v4.1-flash。':'请检查'+(e.target.closest('label')?.firstChild?.textContent??'服务配置')+'：'+e.target.validationMessage;},true);
 $('#llm-profile-existing').onchange=editProfile;
 $('#llm-profile-form [name=kind]').onchange=e=>{if($('#llm-profile-existing').value)return;const local=e.target.value==='local';$('#llm-profile-form [name=baseUrl]').value=local?'http://127.0.0.1:11434/v1':e.target.value==='custom'?'':'https://ark.cn-beijing.volces.com/api/v3';};
 $('#llm-profile-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget,submit=$('#llm-profile-save');submit.disabled=true;
  try{const fields=Object.fromEntries(new FormData(form)),provider=Object.fromEntries(['id','name','kind','baseUrl','model','apiKey'].map(k=>[k,fields[k]]));await request('/api/llm/providers/save',{provider,clearKey:fields.clearKey==='on'});form.elements.namedItem('apiKey').value='';clear();await refreshProviders();$('#llm-provider').value=provider.id;$('#llm-profile-existing').value=provider.id;editProfile();$('#llm-status').textContent='服务已保存；密钥不回传浏览器。发送参数要求时才会调用模型。';}
  catch(error){$('#llm-status').textContent=error.message;const field=form.elements.namedItem(error.field??'');if(field?.setCustomValidity){field.setCustomValidity(error.message);field.setAttribute('aria-invalid','true');field.focus();field.reportValidity();}}finally{submit.disabled=false;}
 };
 $('#llm-profile-remove').onclick=async()=>{const id=$('#llm-profile-existing').value;if(!id)return;try{await request('/api/llm/providers/save',{removeId:id});clear();await refreshProviders();editProfile();}catch(e){$('#llm-status').textContent=e.message;}};
 $('#llm-refresh').onclick=refreshProviders;
 $('#llm-instruction').oninput=()=>{if(proposal){clear();$('#llm-status').textContent='调整要求已改变，请重新解析。';}};
 $('#llm-provider').onchange=()=>{clear();$('#llm-status').textContent='已更换服务，请重新解析参数要求。';};
 $('#llm-form').onsubmit=async e=>{
  e.preventDefault();if(active)return;clear();const c=getContext();sourceData=c.data;const config=parameterContext(c.config),current={controller:new AbortController()};active=current;
  $('#llm-send').disabled=true;$('#llm-provider').disabled=true;$('#llm-instruction').readOnly=true;$('#llm-refresh').disabled=true;$('#llm-cancel').hidden=false;$('#llm-status').textContent='正在解析参数要求…界面参数尚未修改。';
  try{
   const value=await request('/api/llm/suggest',{providerId:$('#llm-provider').value,instruction:$('#llm-instruction').value,config},current.controller.signal);
   if(active!==current)return;
   if(getContext().data!==sourceData||JSON.stringify(parameterContext(getContext().config))!==JSON.stringify(config))throw Error('解析期间行情或参数已改变，请重新发送要求。');
   if(JSON.stringify(value.baseConfig)!==JSON.stringify(config))throw Error('模型建议的参数上下文不一致，未应用。');
   const patch=value.changes;if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('参数建议格式无效');for(const [key,v]of Object.entries(patch))validateParameterValue(key,v);validate({...getContext().config,...patch});
   proposal=value;
   const rows=Object.entries(patch).map(([key,after])=>({key,before:config[key],after}));
   $('#llm-proposal').innerHTML=`<p class="help">${escape(value.provider.name)} · ${escape(value.provider.model)} · 尚未回测验证</p><p>${escape(value.explanation)}</p>${value.warnings?.length?'<ul>'+value.warnings.map(w=>'<li>'+escape(w)+'</li>').join('')+'</ul>':''}${rows.length?'<div class="table-wrap"><table><thead><tr><th>参数</th><th>当前值</th><th>建议值</th></tr></thead><tbody>'+rows.map(r=>`<tr><td>${escape(parameterSchema[r.key].label)}</td><td>${escape(display(r.key,r.before))}</td><td>${escape(display(r.key,r.after))}</td></tr>`).join('')+'</tbody></table></div>':'<p>没有需要应用的修改；请补充更明确的参数要求。</p>'}`;
   $('#llm-apply').hidden=!rows.length;$('#llm-status').textContent=rows.length?'已解析 '+rows.length+' 项修改。检查对照后点击“确认应用参数”，再运行回测。':'模型未生成参数修改；请查看说明。';
  }catch(error){if(active===current){clear();$('#llm-status').textContent=error.name==='AbortError'?'已取消等待，参数没有修改；模型服务已接收的请求可能仍会计费。':error.message;}}
  finally{if(active===current){active=null;$('#llm-send').disabled=!providers.length;$('#llm-provider').disabled=false;$('#llm-instruction').readOnly=false;$('#llm-refresh').disabled=false;$('#llm-cancel').hidden=true;}}
 };
 $('#llm-cancel').onclick=()=>active?.controller.abort();
 $('#llm-apply').onclick=()=>{
  if(!proposal)return;const context=getContext();
  if(context.data!==sourceData||JSON.stringify(parameterContext(context.config))!==JSON.stringify(proposal.baseConfig)){clear();$('#llm-status').textContent='行情或参数已改变，旧建议不能应用；请重新解析。';return;}
  try{for(const [k,v]of Object.entries(proposal.changes))validateParameterValue(k,v);validate({...context.config,...proposal.changes});setConfig({...context.config,...proposal.changes});clear();$('#llm-status').textContent='参数已应用，尚未运行回测。可在下方自动微调比较，或回到“策略回测”运行。';notify('已应用参数；原回测结果已标为待更新。');}catch(e){$('#llm-status').textContent=e.message;}
 };
 refreshProviders();return {refreshProviders};
}
