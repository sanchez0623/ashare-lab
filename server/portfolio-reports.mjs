const fail=(message,status=400)=>Object.assign(Error(message),{status,code:'PORTFOLIO_REPORT'});
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
export async function portfolioReports(request,bucket){
 const url=new URL(request.url),path=url.pathname;
 if(path.startsWith('/api/portfolio/reports/')&&request.method==='GET'){
  const id=path.slice('/api/portfolio/reports/'.length);if(!/^[a-f0-9]{64}$/.test(id))throw fail('报告编号无效');const obj=await bucket.get('portfolio-reports/'+id+'.json');if(!obj)return reply({error:'组合报告不存在'},404);return new Response(obj.body,{headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, max-age=31536000, immutable','etag':obj.httpEtag}});
 }
 if(path!=='/api/portfolio/reports'||request.method!=='POST')return reply({error:'接口或方法不存在'},404);
 const origin=request.headers.get('origin');if(origin&&origin!==url.origin)throw fail('只接受本站写入',403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw fail('需要JSON组合报告',415);
 const reader=request.body?.getReader();if(!reader)throw fail('报告为空');const chunks=[];let size=0;
 while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>25*1024*1024){await reader.cancel();throw fail('组合报告超过25MB，请缩短区间或下载到本机保留',413);}chunks.push(x.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length;}
 let report;try{report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).report;}catch{throw fail('JSON或UTF-8无效');}
 if(report?.kind!=='portfolio'||report.schemaVersion!==1||report.engineVersion!=='1.0-shared-account'||!Array.isArray(report.inputs)||!report.inputs.length||report.inputs.length>30||!Array.isArray(report.curve)||!report.curve.length||report.curve.length>250000||!Array.isArray(report.trades)||!Array.isArray(report.contributions)||!report.config||!report.metrics)throw fail('组合报告格式无效');
 if(report.inputs.some(s=>!/^\d{6}$/.test(s.symbol)||report.config.dataMode!=='demo'&&!/^[a-f0-9]{64}$/.test(s.snapshotId??'')))throw fail('真实报告必须保留每只股票的固定快照编号');
 const capital=report.config.capital;if(!Number.isFinite(capital)||capital<1000)throw fail('报告资金无效');
 for(let i=0;i<report.curve.length;i++){const p=report.curve[i];if(['cash','equity','stockValue','receivable','reservedCash','nav'].some(k=>!Number.isFinite(p[k]))||p.cash<-.011||p.reservedCash<-.011||p.reservedCash>p.cash+.011||Math.abs(p.equity-p.cash-p.stockValue-p.receivable)>.011||Math.abs(p.nav-p.equity/capital)>1e-8||i&&p.date<=report.curve[i-1].date)throw fail('组合净值或现金核对失败');}
 for(const t of report.trades)if(!report.inputs.some(s=>s.symbol===t.symbol)||!['买入','卖出'].includes(t.side)||!Number.isInteger(t.quantity)||t.quantity<=0||!Number.isFinite(t.price)||t.price<=0||!Number.isFinite(t.amount)||!Number.isFinite(t.fee)||t.fee<0||Math.abs(t.amount-t.price*t.quantity)>.011||t.signalTime>t.executionTime||t.executionTime>t.confirmationTime||t.dailySignalTime&&t.dailySignalTime>t.executionTime||t.side==='卖出'&&t.quantity>t.sellableBefore)throw fail('组合交易金额或时序核对失败');
 const pnl=report.contributions.reduce((n,s)=>n+s.pnl,0),fees=report.trades.reduce((n,t)=>n+t.fee,0),last=report.curve.at(-1);
 if(!Number.isFinite(pnl)||Math.abs(last.equity-capital-pnl)>.011||Math.abs(last.equity-report.metrics.equity)>.011||Math.abs(fees-report.metrics.fees)>.011)throw fail('组合收益贡献或费用核对失败');
 if(report.config.dataMode!=='demo')for(const s of report.inputs)if(!await bucket.get('snapshots/'+s.snapshotId+'.json'))throw fail(s.symbol+' 原快照不存在，请先保存行情再保存报告');
 const envelope={schemaVersion:1,origin:'browser-portfolio-engine',validation:'report identities and arithmetic checked; not an independent backend rerun',report},encoded=new TextEncoder().encode(JSON.stringify(envelope));
 const digest=await crypto.subtle.digest('SHA-256',encoded),id=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),key='portfolio-reports/'+id+'.json',exists=await bucket.get(key);
 if(!exists)await bucket.put(key,encoded,{httpMetadata:{contentType:'application/json'}});return reply({id,reused:!!exists,validation:envelope.validation},exists?200:201);
}
