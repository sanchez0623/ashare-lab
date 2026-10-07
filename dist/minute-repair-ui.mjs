import {repairPlan} from './minute-repair.mjs';

export function setupMinuteRepair({getContext,api,loadSnapshot,notify}){
  const $=s=>document.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let local=false,jobs=[],busy=false;const expanded=new Set();
  const time=ms=>{const s=Math.floor((ms??0)/1000);return `${Math.floor(s/3600)}时${Math.floor(s%3600/60)}分${s%60}秒`;};
  function context(){const {bundle,snapshotId}=getContext();const button=$('#minute-repair-start');button.disabled=true;if(!local){$('#minute-repair-context').textContent='第二源分钟核验需在本地部署版运行；网页托管环境无法连接通达信。';return;}if(!bundle||!snapshotId){$('#minute-repair-context').textContent='先在下方仓库“载入 / 查看缺口”，或导入并保存完整原始JSON快照。';return;}
    try{const plan=repairPlan(bundle);$('#minute-repair-context').textContent=`${plan.symbol} · ${plan.days.length} 个异常日 · ${plan.range.from} — ${plan.range.to}。核验通达信 → 东财 → 新浪的实际覆盖；不会重拉整年或按日线总量改写分钟。`;button.disabled=busy;}catch(e){$('#minute-repair-context').textContent=e.message;}
  }
  function render(){
    $('#minute-repair-jobs').innerHTML=jobs.map(j=>`<article class="research-job"><h3>${esc(j.symbol??'核验')} · ${esc({queued:'等待执行',running:'核验中',paused:'已暂停',blocked:'受阻',completed:'已修复'}[j.status]??j.status)}</h3><p>异常 ${j.targetDays??0} 日 · 已有可替代证据 ${j.verifiedDays??0} 日${j.source?' · '+(j.status==='running'?'当前':'最近来源')+' '+esc(j.source):''}</p><p>累计运行 ${time(j.timing?.activeMs)} · 本次 ${time(j.timing?.runs?.at(-1)?.activeMs)} · 当前阶段 ${time(j.timing?.stages?.[j.stage])} · 每5秒保存计时；停机和暂停不计时</p>${j.error?`<p class="research-error">${esc(j.error.code)}：${esc(j.error.message)}</p>`:''}${j.unresolved?.length?`<p>未通过日期：${esc(j.unresolved.slice(0,5).map(d=>d.date).join('、'))}${j.unresolved.length>5?'等':''}</p>`:''}<div class="warehouse-actions">${['queued','running'].includes(j.status)?`<button class="text-button" data-repair-action="pause" data-repair-id="${j.id}">暂停</button>`:''}${['paused','blocked'].includes(j.status)?`<button class="text-button" data-repair-action="resume" data-repair-id="${j.id}">断点恢复 / 重试缺失源</button>`:''}${j.reportHash?`<a class="text-button" href="/api/research/repairs/${j.id}/report" download>下载第二源核验报告</a>`:''}${j.snapshotId?`<button class="load-params" data-repair-load="${j.snapshotId}">载入修复快照</button><button class="text-button" data-repair-action="verify" data-repair-id="${j.id}">固定快照复现核验</button>`:''}</div><details data-repair-logs="${j.id}"${expanded.has(j.id)?' open':''}><summary>核验日志</summary><ol>${(j.events??[]).slice(-20).map(e=>`<li>${esc(new Date(e.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))} · 累计 ${time(e.activeMs)} · ${esc(e.message)}</li>`).join('')}</ol></details></article>`).join('');
    for(const [i,article] of [...$('#minute-repair-jobs').querySelectorAll('article')].entries()){
      const j=jobs[i],lines=[];
      if(j.coverageSummary)lines.push(`未返回第二源数据 ${j.coverageSummary.noResponseDays} 日；返回但未通过 ${j.coverageSummary.returnedButUnverifiedDays} 日。原快照是否完整，仍以原快照自身校验为准。`);
      for(const s of j.sourceCoverage??[])if(s.providerRetainedRange?.from)lines.push(`${s.source} 实际保留 ${s.providerRetainedRange.from} — ${s.providerRetainedRange.to}。`);
      const seen=new Set();for(const a of [...(j.attempts??[])].reverse()){if(seen.has(a.source))continue;seen.add(a.source);lines.push(`${a.source} 最近连接失败：${a.message}`);}
      if(lines.length){const p=document.createElement('p');p.className='help';p.textContent=lines.join('\n');p.style.whiteSpace='pre-line';article.querySelector('.warehouse-actions').before(p);}
    }
    $('#minute-repair-jobs').querySelectorAll('[data-repair-logs]').forEach(el=>el.addEventListener('toggle',()=>{if(!el.isConnected)return;el.open?expanded.add(el.dataset.repairLogs):expanded.delete(el.dataset.repairLogs);}));
    $('#minute-repair-jobs').querySelectorAll('[data-repair-action]').forEach(el=>el.onclick=async()=>{el.disabled=true;try{const v=await api(`/api/research/repairs/${el.dataset.repairId}/${el.dataset.repairAction}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(el.dataset.repairAction==='verify')notify(v.status==='passed'?'固定修复快照校验通过；没有请求行情供应商':'校验未通过');await refresh();}catch(e){notify(e.message);}finally{el.disabled=false;}});
    $('#minute-repair-jobs').querySelectorAll('[data-repair-load]').forEach(el=>el.onclick=async()=>{try{await loadSnapshot(el.dataset.repairLoad);notify('已载入修复快照；原始快照保留，请确认区间并运行回测。');}catch(e){notify(e.message);}});
  }
  async function refresh(){try{const v=await api('/api/research/repairs');local=v.backend==='local';jobs=v.jobs??[];$('#minute-repair-status').textContent=jobs.length?'核验任务保存在本地，网页关闭后继续；只有全部异常日通过才生成修复快照。':'没有第二源核验任务。';render();}catch(e){local=false;$('#minute-repair-status').textContent=e.message;}context();}
  $('#minute-repair-start').onclick=async()=>{const {snapshotId}=getContext();busy=true;context();try{const job=await api('/api/research/repairs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({snapshotId})});notify(job.status==='blocked'?'已有受阻核验任务，请查看日志并断点恢复。':'已提交第二源核验任务；原始快照保留。');await refresh();}catch(e){notify(e.message);}finally{busy=false;context();}};
  $('#minute-repair-refresh').onclick=refresh;refresh();
  const timer=setInterval(()=>{if(!document.hidden&&jobs.some(j=>['running','queued'].includes(j.status)))refresh();},5000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  return {refresh,context};
}
