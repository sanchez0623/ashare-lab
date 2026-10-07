const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=v=>Number.isFinite(v)?v.toLocaleString('zh-CN'):'未知';
const sourceNames={environment:'人工声明 BS_MONITOR_IP','http-echo':'HTTP echo 候选','interface-only':'仅网卡地址',unknown:'识别失败','invalid-environment':'人工声明无效'};
export function trafficUsageHTML(u){
 if(!u)return '';
 const ip=u.monitorIP,limit=Number.isFinite(u.budget)?' / '+number(u.budget)+' 次（任务保守预算）':' 次（任务预算以采集表单为准）';
 return `<p class="task-timing">BaoStock 本机日累计 ${number(u.requests)}${limit} · 北京时间 ${escape(u.day)} · ${u.blocked?'本日已触发黑名单，停止采集':'含登录、分页和登出'}</p>${ip?`<p class="task-timing">监控公网 IP：${escape(ip.ip||'未识别')} · ${escape(sourceNames[ip.source]||'来源未知')}${ip.echoService?' / '+escape(ip.echoService):''}${ip.cached?' · 缓存 '+number(ip.cacheAgeSeconds)+' 秒':''}${ip.httpProxyDetected?' · 检测到 HTTP 代理':''}<br>${ip.ip?'该 IP 的本机已记录请求 '+number(u.ipRequests)+' 次。':ip.interfaceIP?'网卡诊断地址 '+escape(ip.interfaceIP)+'，未作为公网身份。':''}${ip.observedAt?' 识别时间 '+escape(new Date(ip.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))+ '。':''}<br>${escape(ip.note||'监控IP未独立证明BaoStock实际TCP出口')}。${u.unattributedRequests?' 本日另有 '+number(u.unattributedRequests)+' 次旧版/未知IP请求未归属。':''}</p>`:'<p class="task-timing">此为旧版记录，未保存监控IP。</p>'}<p class="help">官方每天 50,000 次按公网 IP 统计；这里只统计本机，未包含相同公网 IP 下的其他设备或项目。切换 IP、缓存到期和识别失败均不清零本机日预算；其他设备需统一协调额度与连接。</p>`;
}
