// A running page keeps its loaded ES modules. Ask for a refresh instead of
// discarding unsaved parameters or terminating an in-browser backtest.
export function setupLocalUpdates({fetcher=fetch,documentRef=document,locationRef=location,intervalMs=5000}={}){
  if(!['127.0.0.1','localhost'].includes(locationRef.hostname))return ()=>{};
  let baseline=documentRef.querySelector('meta[name="ashare-local-revision"]')?.content??null,stopped=false,timer,banner;
  const hide=()=>{if(banner)banner.hidden=true;};
  function show(message,refresh=false){
    if(!banner){banner=documentRef.createElement('aside');banner.className='local-update-banner';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');documentRef.body.append(banner);}
    banner.replaceChildren();const text=documentRef.createElement('span');text.textContent=message;banner.append(text);
    if(refresh){const button=documentRef.createElement('button');button.type='button';button.textContent='刷新加载新版本';button.onclick=()=>locationRef.reload();banner.append(button);}
    banner.hidden=false;
  }
  async function poll(){
    try{
      const response=await fetcher('/api/local/status',{cache:'no-store',signal:AbortSignal.timeout(3000)});
      if(response.status===404){stopped=true;return;}
      if(!response.ok)throw Error('reloading');
      const status=await response.json();if(status.backend!=='local'||!status.enabled){stopped=true;return;}
      baseline??=status.revision;
      if(status.state==='error')show(status.error||'代码更新失败，服务继续使用上一个可用版本。');
      else if(status.state==='reloading')show('后台正在保存断点并重载，兼容的采集任务将自动恢复。');
      else if(status.revision!==baseline)show('新版本已就绪。刷新会结束本页正在计算的回测或调参；后台采集不受影响，请先保存参数或报告。',true);
      else if(status.dependencyRestartRequired)show('依赖清单已更新：请安装新依赖后重启一次。普通源码更新继续自动加载。');
      else if(status.supervisorRestartRequired)show('自动更新监测器自身有新版本，请在方便时重启一次；普通源码更新仍会自动加载。');
      else hide();
    }catch{if(baseline)show('本地后台暂时无法连接，正在等待恢复；页面参数保留。');}
    finally{if(!stopped)timer=setTimeout(poll,intervalMs);}
  }
  poll();return ()=>{stopped=true;clearTimeout(timer);hide();};
}
