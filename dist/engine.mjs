import { detectTimeframe, resampleData, dailyGroups, dayOf, closeTime, executionTime } from './data.mjs';
export { parseCSV, demoData, demoMinuteData, detectTimeframe, resampleData, dailyGroups, periodLabel } from './data.mjs';

export const defaults = {
  strategy:'swing', timeframe:'15m', fast:10, slow:30,
  dailyFast:20, dailySlow:60, breakout:20, exitPeriod:20, atrPeriod:14, atrMult:3, cooldownDays:3,
  rsiPeriod:14, rsiBuy:30, rsiSell:70, bbPeriod:20, bbMult:2,
  capital:100000, allocation:95, commission:0.03, minCommission:5,
  stamp:0.05, transfer:0.001, slippage:5, limit:10, stop:8, take:0,
  from:'2023-01-03', to:'2025-12-31'
};
export function sma(xs,n) {
  let sum=0;
  return xs.map((v,i)=>{sum+=v;if(i>=n)sum-=xs[i-n];return i>=n-1?sum/n:null;});
}
export function ema(xs,n) {
  let prev=xs[0];return xs.map((v,i)=>prev=i?v*2/(n+1)+prev*(1-2/(n+1)):v);
}
export function indicators(data,c) {
  const xs=data.map(x=>x.signal_close??x.close), fast=sma(xs,c.fast), slow=sma(xs,c.slow);
  const e12=ema(xs,12),e26=ema(xs,26),dif=e12.map((v,i)=>v-e26[i]),dea=ema(dif,9);
  let gain=0,loss=0;
  const rsi=xs.map((v,i)=>{
    if(!i)return null;const d=v-xs[i-1];
    if(i<=c.rsiPeriod){gain+=Math.max(d,0)/c.rsiPeriod;loss+=Math.max(-d,0)/c.rsiPeriod;}
    else{gain=(gain*(c.rsiPeriod-1)+Math.max(d,0))/c.rsiPeriod;loss=(loss*(c.rsiPeriod-1)+Math.max(-d,0))/c.rsiPeriod;}
    return i<c.rsiPeriod?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss);
  });
  const mid=sma(xs,c.bbPeriod),std=xs.map((v,i)=>mid[i]===null?null:Math.sqrt(xs.slice(i-c.bbPeriod+1,i+1).reduce((s,x)=>s+(x-mid[i])**2,0)/c.bbPeriod));
  return {xs,fast,slow,dif,dea,rsi,mid,std};
}
function dailyIndicators(days,c) {
  const xs=days.map(d=>d.signal_close),fast=sma(xs,c.dailyFast),slow=sma(xs,c.dailySlow),exit=sma(xs,c.exitPeriod);
  // Explicitly shifted: the breakout level for day j excludes day j itself.
  const previousHigh=days.map((_,j)=>j<c.breakout?null:days.slice(j-c.breakout,j).reduce((p,d)=>Math.max(p,d.signal_high),-Infinity));
  const tr=days.map((d,j)=>j?Math.max(d.signal_high-d.signal_low,Math.abs(d.signal_high-xs[j-1]),Math.abs(d.signal_low-xs[j-1])):d.signal_high-d.signal_low);
  let atr=null;
  const atrs=tr.map((v,j)=>{if(j<c.atrPeriod-1)return null;if(j===c.atrPeriod-1)atr=tr.slice(0,c.atrPeriod).reduce((s,x)=>s+x,0)/c.atrPeriod;else atr=(atr*(c.atrPeriod-1)+v)/c.atrPeriod;return atr;});
  return {xs,fast,slow,exit,previousHigh,atr:atrs};
}
export function validate(c) {
  for(const[k,v]of Object.entries(defaults))if(typeof v==='number'&&!Number.isFinite(c[k]))throw Error('参数必须是有效数字。');
  if(!['swing','ma','macd','rsi','boll'].includes(c.strategy))throw Error('策略无效。');
  if(!['1d','5m','15m'].includes(c.timeframe))throw Error('请选择日线、5 分钟或 15 分钟周期。');
  for(const k of ['fast','slow','dailyFast','dailySlow','breakout','exitPeriod','atrPeriod','rsiPeriod','bbPeriod'])if(!Number.isInteger(c[k])||c[k]<2||c[k]>250)throw Error('指标周期需为 2–250 的整数。');
  if(c.fast>=c.slow||c.dailyFast>=c.dailySlow)throw Error('短期均线必须小于长期均线。');
  if(!Number.isInteger(c.cooldownDays)||c.cooldownDays<0||c.cooldownDays>30)throw Error('冷却期需为 0–30 个交易日。');
  if(c.atrMult<0||c.atrMult>10)throw Error('ATR 倍数需在 0–10 之间；0 为禁用。');
  if(c.capital<1000||c.capital>1e9)throw Error('初始资金需在 1,000–10 亿之间。');
  if(c.allocation<=0||c.allocation>100)throw Error('仓位需在 0–100% 之间。');
  if(c.rsiBuy<0||c.rsiSell>100||c.rsiBuy>=c.rsiSell)throw Error('RSI 买入阈值必须低于卖出阈值，范围为 0–100。');
  if(c.bbMult<=0||c.bbMult>5)throw Error('布林带倍数需在 0–5 之间。');
  for(const k of ['commission','stamp','transfer','slippage','stop','take','minCommission'])if(c[k]<0)throw Error('成本与风控参数不能为负数。');
  if(c.stop>100||c.take>1000||c.slippage>1000||c.commission>5||c.stamp>5||c.transfer>5||c.minCommission>10000)throw Error('成本或风控参数超出合理范围。');
  if(![0,5,10,20,30].includes(c.limit))throw Error('涨跌停比例无效。');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.from)||!/^\d{4}-\d{2}-\d{2}$/.test(c.to)||c.from>=c.to)throw Error('开始日期必须早于结束日期。');
}
export function backtest(input,config={}) {
  const c={...defaults,...config};validate(c);
  const native=detectTimeframe(input),data=resampleData(input,c.timeframe);
  if(data.length<2)throw Error('行情不足两根 K 线。');
  for(let i=0;i<data.length;i++){
    const r=data[i];if(i&&r.date<=data[i-1].date)throw Error('行情必须严格按时间排序，不得有重复时间。');
    if(r.volume===0&&r.halted!==1)throw Error('零成交量 K 线需要开盘已知的 halted=1；禁止用未来成交量决定开盘成交。');
  }
  const groups=dailyGroups(data),completeDays=groups.filter(g=>g.complete),daily=dailyIndicators(completeDays,c),ind=indicators(data,c);
  const groupByDay=new Map(groups.map((g,i)=>[g.date,{...g,index:i}]));
  const start=data.findIndex(r=>dayOf(r)>=c.from),end=data.findLastIndex(r=>dayOf(r)<=c.to);
  if(start<0||end<=start)throw Error('所选日期内至少需要两根 K 线。');
  const warm={swing:c.slow,ma:c.slow,macd:35,rsi:c.rsiPeriod+1,boll:c.bbPeriod}[c.strategy];
  if(start<warm)throw Error(`开始日期前至少需要 ${warm} 根执行周期 K 线作为指标预热。`);
  const dailyWarm=Math.max(c.dailySlow,c.breakout+1,c.exitPeriod,c.atrPeriod);
  if(c.strategy==='swing'&&completeDays.filter(d=>d.availableAt<executionTime(data[start],c.timeframe)).length<dailyWarm)
    throw Error(`大波段策略开始前至少需要 ${dailyWarm} 个完整交易日预热，分钟数量不能替代日线历史。`);

  let cash=c.capital,qty=0,entry=null,fees=0,peak=c.capital,desired=false,blocked=0,t1Blocked=0;
  let dailyIndex=-1,pendingExit=null,lastExitDay=-Infinity,peakSignal=0,exposureBars=0;
  const trades=[],closed=[],curve=[],dailyCurve=[];
  const audit={engineVersion:'2.0-causal',timingViolations:0,decisions:0,sameBarRangeUsed:false,sameBarVolumeUsed:false,dailyAvailableAfter:'15:00 Asia/Shanghai',breakoutShift:1};
  const fee=(amount,sell)=>Math.max(c.minCommission,amount*c.commission/100)+amount*c.transfer/100+(sell?amount*c.stamp/100:0);
  function technicalSignal(i,held){
    if(c.strategy==='ma')return ind.fast[i]>ind.slow[i];
    if(c.strategy==='macd')return ind.dif[i]>ind.dea[i];
    if(c.strategy==='rsi')return ind.rsi[i]<c.rsiBuy?true:ind.rsi[i]>c.rsiSell?false:held;
    return ind.xs[i]<ind.mid[i]-c.bbMult*ind.std[i]?true:ind.xs[i]>=ind.mid[i]?false:held;
  }
  for(let i=start;i<=end;i++) {
    const r=data[i],prev=data[i-1],day=dayOf(r),g=groupByDay.get(day);
    const execAt=executionTime(r,c.timeframe),sourceAt=closeTime(prev);
    // Only a daily bar whose closing event already happened can become visible.
    while(dailyIndex+1<completeDays.length&&completeDays[dailyIndex+1].availableAt<=execAt)dailyIndex++;
    const d=dailyIndex>=0?completeDays[dailyIndex]:null;
    if(sourceAt>execAt||d&&d.availableAt>execAt){audit.timingViolations++;throw Error('信号时序违规：读取了尚未完成的 K 线。');}
    audit.decisions++;
    let reason='指标信号';
    if(c.strategy==='swing') {
      const lastObservedDay=groups[g.index-1];
      const canOpen=d&&lastObservedDay?.date===d.date&&dailyIndex>=dailyWarm-1;
      const trend=canOpen&&daily.fast[dailyIndex]>daily.slow[dailyIndex]&&daily.xs[dailyIndex]>daily.slow[dailyIndex];
      const breakout=canOpen&&daily.previousHigh[dailyIndex]!==null&&daily.xs[dailyIndex]>daily.previousHigh[dailyIndex];
      const confirmation=ind.fast[i-1]>ind.slow[i-1]&&ind.xs[i-1]>ind.fast[i-1];
      desired=qty>0?true:Boolean(trend&&breakout&&confirmation&&g.index-lastExitDay>c.cooldownDays);
      reason='日线突破 + 执行周期确认';
      if(qty>0&&d&&daily.xs[dailyIndex]<daily.exit[dailyIndex])pendingExit=pendingExit||{reason:'日线趋势离场',signalTime:sourceAt,dailySignalTime:d.availableAt};
      if(qty>0&&d&&c.atrMult>0&&daily.atr[dailyIndex]!==null&&ind.xs[i-1]<=peakSignal-c.atrMult*daily.atr[dailyIndex])pendingExit=pendingExit||{reason:'ATR 跟踪止损',signalTime:sourceAt,dailySignalTime:d.availableAt};
    }else desired=technicalSignal(i-1,desired);
    if(qty&&entry) {
      const change=prev.close/entry.price-1;
      if(c.stop>0&&change<=-c.stop/100)pendingExit=pendingExit||{reason:'前根收盘止损',signalTime:sourceAt,dailySignalTime:c.strategy==='swing'?d?.availableAt:null};
      if(c.take>0&&change>=c.take/100)pendingExit=pendingExit||{reason:'前根收盘止盈',signalTime:sourceAt,dailySignalTime:c.strategy==='swing'?d?.availableAt:null};
    }
    if(pendingExit){desired=false;reason=pendingExit.reason;}
    // Daily price limits use prior SESSION close, never the prior intraday bar close.
    const previousSession=groups[g.index-1];
    const prevPrice=r.prev_close??previousSession?.close??prev.close;
    const up=r.limit_up??(c.limit?Math.round(prevPrice*(1+c.limit/100)*100)/100:Infinity);
    const down=r.limit_down??(c.limit?Math.round(prevPrice*(1-c.limit/100)*100)/100:0);
    const sell=qty>0&&!desired,buy=qty===0&&desired;
    // halted, prev_close and limit prices are input contracts: they must be known at this open.
    // Current HIGH / LOW / CLOSE / VOLUME are intentionally absent from execution decisions.
    const tradeable=r.halted!==1&&(sell?r.open>down+0.001:r.open<up-0.001);
    if((buy||sell)&&!tradeable)blocked++;
    if(sell&&day===entry.day)t1Blocked++;
    const timing={signalTime:pendingExit?.signalTime??sourceAt,executionTime:execAt,dailySignalTime:pendingExit?pendingExit.dailySignalTime:c.strategy==='swing'?d?.availableAt:null};
    if(sell&&tradeable&&day>entry.day) {
      const price=Math.max(down,r.open*(1-c.slippage/10000)),amount=qty*price,f=fee(amount,true),pnl=amount-f-entry.cost;
      cash+=amount-f;fees+=f;
      trades.push({date:c.timeframe==='1d'?day:execAt,side:'卖出',price,quantity:qty,amount,fee:f,reason,pnl,...timing});
      closed.push({entry:entry.date,exit:c.timeframe==='1d'?day:execAt,pnl,return:pnl/entry.cost,days:g.index-entry.dayIndex,bars:i-entry.index});
      qty=0;entry=null;pendingExit=null;peakSignal=0;lastExitDay=g.index;
    }
    if(buy&&tradeable) {
      const price=Math.min(up,r.open*(1+c.slippage/10000));
      let n=Math.floor(cash*c.allocation/100/(price*100))*100;
      while(n>0&&n*price+fee(n*price,false)>cash)n-=100;
      if(n>0){const amount=n*price,f=fee(amount,false);qty=n;cash-=amount+f;fees+=f;
        entry={date:c.timeframe==='1d'?day:execAt,day,dayIndex:g.index,price,cost:amount+f,index:i};
        peakSignal=price*(prev.signal_close??prev.close)/prev.close;
        trades.push({date:entry.date,side:'买入',price,quantity:n,amount,fee:f,reason,pnl:null,...timing});
      }
    }
    // CLOSE becomes observable only now; it may affect equity now and the NEXT opening decision.
    if(qty){peakSignal=Math.max(peakSignal,ind.xs[i]);exposureBars++;}
    const equity=cash+qty*r.close;peak=Math.max(peak,equity);
    const point={date:r.date,equity,nav:equity/c.capital,benchmark:r.close/data[start].open,drawdown:equity/peak-1,cash,quantity:qty};
    curve.push(point);
    if(dailyCurve.length&&dayOf(dailyCurve.at(-1))===day)dailyCurve[dailyCurve.length-1]=point;else dailyCurve.push(point);
  }
  const last=curve.at(-1),total=last.nav-1,tradingDays=dailyCurve.length,annual=last.nav**(252/tradingDays)-1;
  const returns=dailyCurve.map((r,i)=>r.equity/(i?dailyCurve[i-1].equity:c.capital)-1);
  const mean=returns.reduce((s,x)=>s+x,0)/returns.length;
  const sd=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(1,returns.length-1));
  const maxdd=curve.reduce((m,r)=>Math.min(m,r.drawdown),0),wins=closed.filter(t=>t.pnl>0),losses=closed.filter(t=>t.pnl<0);
  const incomplete=groups.filter(g=>!g.complete).map(g=>g.date);
  const warnings=[];
  if(incomplete.length)warnings.push(`${incomplete.length} 个交易日的分钟网格不完整；这些日线不会用于波段信号，缺少上一完整日线时禁止新开仓。`);
  if(c.strategy==='swing'&&completeDays.length===0)warnings.push('没有完整日线，无法形成大波段信号。');
  return {config:c,curve,dailyCurve,trades,closed,audit,warnings,
    dataInfo:{nativeTimeframe:native,executionTimeframe:c.timeframe,inputBars:input.length,executionBars:data.length,completeDailyBars:completeDays.length,incompleteDays:incomplete},
    metrics:{total,annual,maxdd,sharpe:sd>0&&tradingDays>1?mean/sd*Math.sqrt(252):null,winrate:closed.length?wins.length/closed.length:null,
      profitFactor:losses.length?wins.reduce((s,x)=>s+x.pnl,0)/-losses.reduce((s,x)=>s+x.pnl,0):null,
      fees,blocked,t1Blocked,equity:last.equity,quantity:qty,cash,benchmark:last.benchmark-1,excess:total-(last.benchmark-1),volatility:sd*Math.sqrt(252),
      averageHoldingDays:closed.length?closed.reduce((s,t)=>s+t.days,0)/closed.length:null,exposure:exposureBars/curve.length},
    period:{from:curve[0].date,to:last.date,bars:curve.length,tradingDays}};
}

export function compareParameters(data,config) {
  const c={...defaults,...config};validate(c);
  const days=[...new Set(data.filter(r=>dayOf(r)>=c.from&&dayOf(r)<=c.to).map(dayOf))];
  if(days.length<20)throw Error('参数比较至少需要 20 个交易日，以保留独立验证区间。');
  const split=Math.floor(days.length*.7),trainTo=days[split-1],validationFrom=days[split];
  const combinations=[];
  if(c.strategy==='swing')for(const dailySlow of[60,90,120])for(const atrMult of[2,3,4])combinations.push({...c,dailySlow,atrMult});
  else for(const fast of[5,10,20])for(const slow of[30,60,90])combinations.push({...c,strategy:'ma',fast,slow});
  const rows=combinations.map(params=>{
    try{const training=backtest(data,{...params,to:trainTo});const validation=backtest(data,{...params,from:validationFrom});return {config:params,training:training.metrics,validation:validation.metrics};}
    catch(e){return {config:params,error:e.message};}
  });
  rows.sort((a,b)=>a.error?1:b.error?-1:b.training.total-a.training.total);
  return {rows,trainFrom:c.from,trainTo,validationFrom,validationTo:c.to,selectionRule:'training_return_only',positionPolicy:'validation starts flat; past bars used only for indicator warmup'};
}
