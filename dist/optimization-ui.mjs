import {tuningCandidates} from './parameter-tuning.mjs';
import {managementNames,periodLabel} from './engine.mjs';
import {parameterSchema,tuningSpecs,strategyNames,candidateLabel} from './parameter-schema.mjs';
import {assessWarmup,warmupAvailability,warmupMessage} from './warmup.mjs';

export function setupOptimization({getContext,setConfig,showView,runBacktest,notify,prepareHistory,prepareCollection}){
  const $=s=>document.querySelector(s),escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=v=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:2}):'—';
  const percent=v=>Number.isFinite(v)?number(v*100)+'%':'—';
  const changeNames=Object.fromEntries(Object.entries(parameterSchema).map(([k,v])=>[k,v.label]));
  const options=()=>Object.fromEntries([...new FormData($('#tuning-form'))].map(([k,v])=>[k,Number(v)]));
  let activeRun=null,report=null,reportData=null,stepStrategy=null,historyCache=null,historyPlan=null;
  function checkHistory(context,candidates){
    const c=context.config;if(historyCache?.data!==context.data||historyCache.from!==c.from||historyCache.to!==c.to||historyCache.timeframe!==c.timeframe)historyCache={data:context.data,from:c.from,to:c.to,timeframe:c.timeframe,availability:warmupAvailability(context.data,c)};
    return assessWarmup(context.data,c,candidates,historyCache.availability);
  }
  const sourceLabel=context=>context.source==='demo'||context.data?.metadata?.synthetic?'合成数据 · 仅验证功能流程':context.source==='bundle'?(context.quality?.status==='warning'?'行情数据包 · 带量价警告（未修复）':context.quality?.status==='passed'?'行情数据包 · 结构校验通过':'行情数据包 · 资料未通过准入'):'CSV探索 · 历史资料未校验';
  function refresh(){
    const context=getContext(),c=context.config;
    if(stepStrategy!==c.strategy){
      stepStrategy=c.strategy;
      $('#tuning-steps').innerHTML=tuningSpecs[c.strategy].map(([key,option,value,min,max])=>`<label>${parameterSchema[key].label}步长<input name="${option}" type="number" min="${min}" max="${max}" step="${min<1?min:1}" value="${value}" required></label>`).join('');
    }
    $('#tuning-management').disabled=!!activeRun||c.strategy!=='swing';
    document.querySelectorAll('[data-training-key]').forEach(input=>{if(document.activeElement!==input)input.value=c[input.dataset.trainingKey];});
    $('#tuning-source').textContent=context.name+' · '+sourceLabel(context);
    $('#tuning-context').textContent=`${strategyNames[c.strategy]} · ${c.from} — ${c.to} · ${periodLabel(c.timeframe)}\n资金 ¥${number(c.capital)} · ${c.strategy==='swing'?managementNames[c.management]:'固定总仓位上限 '+c.allocation+'%'}\n训练门槛：平仓≥${c.minTrades}笔，盈利因子≥${c.minProfitFactor}，回撤≤${c.maxDrawdown}%`;
    try{const {grid,candidates}=tuningCandidates(c,options());$('#tuning-grid').textContent=Object.entries(grid).map(([k,v])=>parameterSchema[k].label+'：'+v.join(' / ')).join('；')+`。共${candidates.length}组，包含当前配置；无效的参数组合会跳过。`;
      historyPlan=checkHistory(context,candidates.map(p=>p.config));$('#tuning-history-status').textContent=historyPlan.sufficient?`整轮预热检查通过：需要 ${historyPlan.requiredDailySessions} 个完整交易日 / ${historyPlan.requiredExecutionBars} 根执行周期K线，当前有 ${historyPlan.availableDailySessions} 日 / ${historyPlan.availableExecutionBars} 根。`:warmupMessage(historyPlan)+' 点击开始时先尝试载入本地已有历史。';$('#tuning-history-collect').hidden=historyPlan.sufficient||!prepareCollection;$('#tuning-history-collect').disabled=!!activeRun;
    }
    catch(e){historyPlan=null;$('#tuning-grid').textContent=e.message;$('#tuning-history-status').textContent='';$('#tuning-history-collect').hidden=true;}
  }
  function busy(value){$('#tuning-start').disabled=value;$('#tuning-history-collect').disabled=value;$('#tuning-management').disabled=value||getContext().config.strategy!=='swing';$('#tuning-cancel').hidden=!value;$('#tuning-progress').hidden=!value;$('#tuning-export').disabled=value||!report;}
  async function apply(candidate){
    if((getContext().data)!==reportData){notify('行情已改变，请针对当前行情重新计算后再载入参数。');return;}
    if(!candidate.validation){notify('该候选的验证段未完成，请先查看资料或预热问题。');return;}
    setConfig({...candidate.config,from:report.validationFrom,to:report.validationTo});showView('backtest');
    notify('已载入本轮参数、资金费用及验证区间，正在运行验证段回测。');await runBacktest();
  }
  function render(){
    const result=report,management=result.type==='management-comparison',winner=management?result.rows.find(r=>result.recommendation&&r.config.management===result.recommendation.config.management):result.rows.find(r=>r.id===result.recommendation?.id);
    const baseline=result.baseline,valid=result.rows.filter(r=>r.training).length;
    const note=!winner?'没有候选达到训练门槛；不推荐自动应用。可查看失败原因或单独研究某组参数。':!result.recommendation.changed?'训练优选仍是当前配置，本轮未找到更好的达标参数。':'已按训练质量选出候选，验证表现单独列出。';
    const delta=winner?.validationDelta;
    const changes=result.recommendation?.changes.map(x=>`<span class="tuning-change">${escape(changeNames[x.key])}：${escape(x.key==='management'?managementNames[x.before]:x.before)} → ${escape(x.key==='management'?managementNames[x.after]:x.after)}</span>`).join('')||'';
    $('#tuning-results').innerHTML=`<p class="tuning-result-note">${escape(result.input.dataset)} · ${escape(sourceLabel({source:result.input.source,data:{metadata:{synthetic:result.input.synthetic}},quality:result.input.quality}))}<br>训练 ${escape(result.trainFrom)} — ${escape(result.trainTo)}<br>验证 ${escape(result.validationFrom)} — ${escape(result.validationTo)} · 从空仓开始，之前行情只用于预热<br>基准：${management?'仅底仓':'本轮当前参数'} · 资金 ¥${number(result.inputConfig.capital)}，五项费用和滑点固定</p><div class="tuning-summary"><div><span>可计算 / 训练达标</span><strong>${valid} / ${result.qualified} 组</strong></div><div><span>优选训练收益</span><strong>${percent(winner?.training.total)}</strong></div><div><span>优选验证收益</span><strong>${percent(winner?.validation?.total)}</strong></div><div><span>验证相对基准</span><strong>${Number.isFinite(delta)?number(delta*100)+' 个百分点':'—'}</strong></div></div><p class="tuning-result-note">${note}${winner?.validation?.total<=0?' 验证段收益未转正，不能据此认定策略有效。':''}${winner?.validationError?' 验证段失败：'+escape(winner.validationError):''}</p>${changes}${winner?.validation?'<div class="tuning-actions"><button id="tuning-apply" class="button primary">应用训练优选并回测验证段</button></div>':''}<div class="table-wrap"><table><thead><tr><th>${management?'仓位方案':strategyNames[result.inputConfig.strategy]+'参数'}</th><th>训练收益 / 平仓</th><th>训练回撤 / 盈利因子</th><th>训练准入</th><th>验证收益 / 回撤</th><th>验证相对基准<br>百分点</th><th>操作</th></tr></thead><tbody>${result.rows.map((r,i)=>{
      const label=management?managementNames[r.config.management]:candidateLabel(r.config),isBase=management?r.config.management==='base':r.isBaseline;
      return `<tr class="${r===winner?'picked':''}"><td>${escape(label)}${isBase?'<br><small>基准</small>':''}${r===winner?'<br><small>训练优选</small>':''}</td>${r.error?`<td colspan="6">无法计算：${escape(r.error)}</td>`:`<td>${percent(r.training.total)} / ${r.training.closedTrades}笔</td><td>${percent(r.training.maxdd)} / ${number(r.training.profitFactor)}</td><td>${escape(r.quality.reason)}</td><td>${r.validation?percent(r.validation.total)+' / '+percent(r.validation.maxdd):escape(r.validationError||'未完成')}</td><td>${number(r.validationDelta*100)}</td><td>${r.validation?`<button class="load-params" data-tuning-row="${i}">查看验证回测</button>`:'—'}</td>`}</tr>`;
    }).join('')}</tbody></table></div><p class="help">基准训练收益 ${percent(baseline?.training?.total)}；验证收益 ${percent(baseline?.validation?.total)}。参数应用及单独查看不会下单。优化报告包含全部候选、失败原因、参数和行情指纹。</p>`;
    if($('#tuning-apply'))$('#tuning-apply').onclick=()=>apply(winner);
    document.querySelectorAll('[data-tuning-row]').forEach(b=>b.onclick=()=>apply(result.rows[Number(b.dataset.tuningRow)]));
  }
  async function start(type){
    if(activeRun)return;
    let context=getContext(),c={...context.config};const search=options();
    if(context.source==='import'&&c.dataMode!=='exploration'){notify('CSV未校验历史资料；请载入完整行情包，或明确选择CSV探索。');return;}
    const current={cancelled:false,worker:null,reject:null};activeRun=current;busy(true);$('#tuning-progress').value=0;
    $('#tuning-status').textContent=type==='management'?'正在比较5种仓位方案，资金与费用固定。':'正在自动生成当前参数附近的候选，训练选参后再检查验证段。';
    try{
      if(context.quality?.status==='blocked')throw Error('数据准入失败：'+(context.quality.blockingIssues??context.quality.issues??[]).map(i=>i.message).join('；'));
      const candidates=type==='management'?[c]:tuningCandidates(c,search).candidates.map(p=>p.config);let history=checkHistory(context,candidates),prepareError=null;
      if(!history.sufficient&&prepareHistory){
        $('#tuning-status').textContent='正在按整轮候选检查并载入本地预热历史，不请求行情供应商…';
        try{await prepareHistory(history.requiredCollectionSessions,c,()=>!current.cancelled);}catch(e){if(e.code==='STALE_CONTEXT')throw e;prepareError=e;}
        if(current.cancelled)throw Error('已停止本轮计算；没有应用任何参数。');
        const next=getContext();if(Object.keys(parameterSchema).some(k=>next.config[k]!==c[k]))throw Error('载入预热期间参数已改变，请重新开始微调。');context=next;c={...next.config};history=checkHistory(context,candidates);refresh();
      }
      if(!history.sufficient)throw Error(warmupMessage(history)+(prepareError?' 本地历史载入未完成：'+prepareError.message:''));
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(context.data)));
      if(current.cancelled)throw Error('已停止本轮计算；没有应用任何参数。');
      const value=await new Promise((resolve,reject)=>{
        current.reject=reject;const worker=new Worker(new URL('./tuning-worker.js',import.meta.url),{type:'module'});current.worker=worker;
        worker.onmessage=({data})=>{
          if(data.progress){const p=data.progress;$('#tuning-progress').value=p.phase==='training'?50*p.completed/p.total:p.phase==='validation'?50+50*p.completed/p.total:100*p.completed/p.total;$('#tuning-status').textContent=`${{training:'训练试算',validation:'独立验证',management:'仓位方案比较'}[p.phase]} ${p.completed} / ${p.total} · 参数尚未应用`;return;}
          worker.terminate();data.error?reject(Error(data.error)):resolve(data.result);
        };worker.onerror=()=>{worker.terminate();reject(Error('优化计算无法运行，请刷新页面或使用支持模块Worker的浏览器。'));};
        worker.postMessage({type,data:context.data,config:c,options:search});
      });
      report={...value,createdAt:new Date().toISOString(),input:{dataset:context.name,source:context.source,synthetic:context.source==='demo'||context.data?.metadata?.synthetic===true,quality:context.quality,snapshotId:context.snapshotId??null,dataHash:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),symbol:context.data?.metadata?.symbol??null,bars:(context.data.bars??context.data).length}};reportData=context.data;render();
      $('#tuning-status').textContent=`计算完成：${value.rows.length}组，${value.qualified}组达到训练门槛。${report.input.synthetic?'当前使用合成数据，仅验证功能流程。':''}`;
    }catch(e){$('#tuning-status').textContent=e.message+(report?' 下方保留上次完成的报告。':'');notify(e.message);}
    finally{current.worker?.terminate();activeRun=null;busy(false);}
  }
  $('#tuning-form').onsubmit=e=>{e.preventDefault();start('parameters');};$('#tuning-form').oninput=e=>{const key=e.target.dataset.trainingKey;if(key&&e.target.value!==''&&e.target.validity.valid){const field=document.querySelector('#config').elements.namedItem(key);field.value=e.target.value;field.dispatchEvent(new Event('input',{bubbles:true}));}refresh();};
  $('#tuning-history-collect').onclick=()=>{if(historyPlan&&!historyPlan.sufficient)prepareCollection?.(historyPlan.requiredCollectionSessions);};
  $('#tuning-management').onclick=()=>start('management');
  $('#tuning-cancel').onclick=()=>{if(!activeRun)return;activeRun.cancelled=true;activeRun.worker?.terminate();activeRun.reject?.(Error('已停止本轮计算；没有应用任何参数。'));};
  $('#tuning-export').onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='青衡-'+(report.type==='parameter-tuning'?'自动微调':'仓位对照')+'-'+report.validationTo+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return {refresh};
}
