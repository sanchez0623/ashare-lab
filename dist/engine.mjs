import { detectTimeframe, resampleData, dailyGroups, dayOf, closeTime, executionTime } from './data.mjs';
import {knownLimits,buyQuantity,rulesVersion} from './rules.mjs';
import {prepareBundle} from './quality.mjs';
import {CorporateLedger} from './corporate.mjs';
import {orderFees,roundTripCost} from './fees.mjs';
import {Inventory} from './inventory.mjs';
export {orderFees,roundTripCost} from './fees.mjs';
export { parseCSV, demoData, demoMinuteData, detectTimeframe, resampleData, dailyGroups, periodLabel } from './data.mjs';

export const defaults = {
  strategy:'swing', timeframe:'15m', dataMode:'exploration', board:'main', rulesMode:'historical', taxMode:'manual', fast:10, slow:30,
  confirmationDays:2, maxGap:3, maxExtensionATR:2, minTrades:20, minProfitFactor:1.2, maxDrawdown:20, objective:'quality', dailyFast:20, dailySlow:60, breakout:20, exitPeriod:20, atrPeriod:14, atrMult:3, cooldownDays:3,
  rsiPeriod:14, rsiBuy:30, rsiSell:70, bbPeriod:20, bbMult:2,
  capital:1000000, allocation:95, commission:0.005, minCommission:5,
  stamp:0.05, handling:0.00341, regulatory:0.002, transfer:0.001, slippage:5, limit:10, stop:8, take:0,
  management:'pyramid', baseAllocation:40, addAllocation:20, maxAdds:2, addATR:1, addSpacing:2, riskBudget:2,
  tAllocation:10, tDeviation:0.6, tTarget:0.5, tStop:1, tMaxBars:12, tDailyPairs:2, tCostBuffer:2,
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
  if(!['demo','formal','exploration'].includes(c.dataMode))throw Error('数据准入模式无效。');
  if(!['main','chinext','star','bse'].includes(c.board))throw Error('板块无效。');
  if(!['historical','manual'].includes(c.rulesMode)||!['historical','manual'].includes(c.taxMode))throw Error('规则或税费模式无效。');
  if(c.taxMode==='historical'&&c.from<'2015-08-01')throw Error('自动税费表覆盖2015-08-01起；更早区间需提供经核实的手工费率并分段研究。');
  if(!Number.isInteger(c.confirmationDays)||c.confirmationDays<1||c.confirmationDays>10||c.maxGap<0||c.maxGap>20||c.maxExtensionATR<=0||c.maxExtensionATR>10||!Number.isInteger(c.minTrades)||c.minTrades<5||c.minTrades>500||c.minProfitFactor<1||c.minProfitFactor>10||c.maxDrawdown<=0||c.maxDrawdown>100||!['quality','return'].includes(c.objective))throw Error('入场过滤或训练准入参数无效。');
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
  for(const k of ['commission','stamp','handling','regulatory','transfer','slippage','stop','take','minCommission'])if(c[k]<0)throw Error('成本与风控参数不能为负数。');
  if(c.stop>100||c.take>1000||c.slippage>1000||c.commission>5||c.stamp>5||c.transfer>5||c.handling>5||c.regulatory>5||c.minCommission>10000)throw Error('成本或风控参数超出合理范围。');
  if(!['base','pyramid','positive','reverse','adaptive'].includes(c.management))throw Error('仓位方案无效。');
  if(c.baseAllocation<=0||c.baseAllocation>c.allocation||c.addAllocation<=0||c.addAllocation>100||!Number.isInteger(c.maxAdds)||c.maxAdds<0||c.maxAdds>10||c.addATR<=0||c.addATR>10||!Number.isInteger(c.addSpacing)||c.addSpacing<1||c.addSpacing>30||c.riskBudget<=0||c.riskBudget>20)throw Error('底仓、加仓或风险预算参数无效。');
  if(c.tAllocation<=0||c.tAllocation>30||c.tDeviation<=0||c.tDeviation>10||c.tTarget<=0||c.tTarget>10||c.tStop<=0||c.tStop>20||!Number.isInteger(c.tMaxBars)||c.tMaxBars<1||c.tMaxBars>96||!Number.isInteger(c.tDailyPairs)||c.tDailyPairs<1||c.tDailyPairs>10||c.tCostBuffer<1||c.tCostBuffer>10)throw Error('做 T 参数无效。');
  if(c.strategy==='swing'&&c.management!=='base'&&c.stop===0&&c.atrMult===0)throw Error('分仓管理需启用固定止损或 ATR 止损以计算风险预算。');
  if(![0,5,10,20,30].includes(c.limit))throw Error('涨跌停比例无效。');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.from)||!/^\d{4}-\d{2}-\d{2}$/.test(c.to)||c.from>=c.to)throw Error('开始日期必须早于结束日期。');
}
export function backtest(input,config={}) {
  const c={...defaults,...config};validate(c);
  let qualityReport=null,actions=[],metadata=null,sessionCalendar=[],dailyMeta=new Map();
  if(Array.isArray(input)&&c.dataMode==='formal')throw Error('正式研究需要完整数据包，不接受未经独立校验的行情数组。');
  if(!Array.isArray(input)){const prepared=prepareBundle(input);qualityReport=prepared.report;actions=prepared.actions;metadata=prepared.metadata;sessionCalendar=prepared.calendar;dailyMeta=new Map(prepared.daily.map(d=>[d.date,d]));input=prepared.bars;c.board=metadata.board;c.rulesMode='historical';}
  const native=detectTimeframe(input),data=resampleData(input,c.timeframe);
  if(data.length<2)throw Error('行情不足两根 K 线。');
  for(let i=0;i<data.length;i++){
    const r=data[i];if(i&&r.date<=data[i-1].date)throw Error('行情必须严格按时间排序，不得有重复时间。');
    if(r.volume===0&&r.halted!==1)throw Error('零成交量 K 线需要开盘已知的 halted=1；禁止用未来成交量决定开盘成交。');
  }
  const groups=dailyGroups(data),halts=metadata?sessionCalendar.filter(day=>dailyMeta.get(day)?.halted===1&&!groups.some(g=>g.date===day)).map(day=>{const d=dailyMeta.get(day),x=d.close*d.causalFactor;return {date:day,complete:true,close:d.close,signal_close:x,signal_high:x,signal_low:x,availableAt:day+' 15:00'};}):[],completeDays=[...groups.filter(g=>g.complete),...halts].sort((a,b)=>a.date.localeCompare(b.date)),daily=dailyIndicators(completeDays,c),ind=indicators(data,c);
  const sessionIndex=new Map(sessionCalendar.map((d,i)=>[d,i]));
  const groupByDay=new Map(groups.map((g,i)=>[g.date,{...g,index:i,sessionIndex:sessionIndex.get(g.date)??i}]));
  const gapDays=halts.filter(d=>d.date>=c.from&&d.date<=c.to).map(d=>d.date);let gapIndex=0;
  const start=data.findIndex(r=>dayOf(r)>=c.from),end=data.findLastIndex(r=>dayOf(r)<=c.to);
  if(start<0||end<=start)throw Error('所选日期内至少需要两根 K 线。');
  const warm={swing:c.slow,ma:c.slow,macd:35,rsi:c.rsiPeriod+1,boll:c.bbPeriod}[c.strategy];
  if(start<warm)throw Error(`开始日期前至少需要 ${warm} 根执行周期 K 线作为指标预热。`);
  const dailyWarm=Math.max(c.confirmationDays+1,c.dailySlow,c.breakout+1,c.exitPeriod,c.atrPeriod);
  if(c.strategy==='swing'&&completeDays.filter(d=>d.availableAt<executionTime(data[start],c.timeframe)).length<dailyWarm)
    throw Error(`大波段策略开始前至少需要 ${dailyWarm} 个完整交易日预热，分钟数量不能替代日线历史。`);

  let cash=c.capital,qty=0,entry=null,fees=0,peak=c.capital,desired=false,blocked=0,t1Blocked=0;
  let dailyIndex=-1,pendingExit=null,lastExitDay=-Infinity,peakSignal=0,exposureBars=0;
  const trades=[],closed=[],curve=[],dailyCurve=[],tPairs=[],inventory=new Inventory();
  const managed=c.strategy==='swing', pyramiding=managed&&c.management!=='base', doingT=managed&&['positive','reverse','adaptive'].includes(c.management)&&c.timeframe!=='1d';
  let tPending=null,tSerial=0,tDay=null,tAttempts=0,lastTIndex=-Infinity,adds=0;
  const feeTotals={commission:0,stamp:0,handling:0,regulatory:0,transfer:0};
  const ledger=new CorporateLedger(actions),benchmarkLedger=new CorporateLedger(actions);
  let benchmarkQty=Math.floor(c.capital/data[start].open),benchmarkCash=c.capital-benchmarkQty*data[start].open,lastDay=null;
  const audit={engineVersion:'4.0-inventory-swing-T',inventoryPolicy:'FIFO sell only prior-date purchases; listed bonus shares immediately available; one shared cash book',feePolicy:'five separate per-order fees; fixed user rates by default; no bundled commission',management:c.management,rulesVersion,qualityReport,snapshotId:c.snapshotId??null,board:c.board,stExcluded:0,unknownSTAssumption:!metadata,corporatePolicy:'record-date entitlement; receivable on ex-date; pay/list date release; rights blocked; fractional bonus floored',dividendTax:'gross or provided net per event; no personalized holding-period tax',timingViolations:0,decisions:0,sameBarRangeUsed:false,sameBarVolumeUsed:false,dailyAvailableAfter:'15:00 Asia/Shanghai',breakoutShift:1};
  let feeDay=c.from;
  const fee=(amount,sell)=>orderFees(amount,sell,c,feeDay).total;
  const charge=(amount,sell)=>{const detail=orderFees(amount,sell,c,feeDay);for(const k of Object.keys(feeTotals))feeTotals[k]+=detail[k];fees+=detail.total;return detail;};
  function cancelT(reason,date){if(tPending){tPairs.push({...tPending,status:'unmatched',end:date,reason,pnl:null});tPending=null;}}
  function riskQuantity(n,price,factor,stopSignal,equity){if(!managed)return n;const perShare=Math.max(0,price-stopSignal/factor);if(perShare===0)return n;const heldRisk=(qty+ledger.locked())*Math.max(0,price-stopSignal/factor);return Math.min(n,Math.max(0,Math.floor((equity*c.riskBudget/100-heldRisk)/perShare)));}

  function finalize(day,i,g,exitAt=null){if(entry&&qty===0&&!ledger.outstanding()&&!ledger.futureEntitlements(day)){const pnl=(entry.proceeds??0)+(entry.dividends??0)-entry.cost;closed.push({entry:entry.date,exit:exitAt??(c.timeframe==='1d'?day:executionTime(data[i],c.timeframe)),pnl,return:pnl/(entry.capitalBasis??entry.cost),days:g.sessionIndex-entry.dayIndex,bars:i-entry.index});entry=null;pendingExit=null;peakSignal=0;lastExitDay=g.sessionIndex;const lastSell=trades.findLast(t=>t.side==='卖出');if(lastSell&&lastSell.pnl===null){lastSell.pnl=pnl;lastSell.settledAt=exitAt??(c.timeframe==='1d'?day:executionTime(data[i],c.timeframe));}}}
  function release(day){const a=ledger.open(day,qty);cash+=a.cash;qty+=a.shares;inventory.release(a.shares,day);if(entry)entry.dividends=(entry.dividends??0)+a.cash;const b=benchmarkLedger.open(day,benchmarkQty);benchmarkCash+=b.cash;benchmarkQty+=b.shares;}
  function gapValuation(day,i){
    release(day);const d=dailyMeta.get(day),price=actions.some(a=>a.exDate===day)?d.prev_close:d.close,equity=cash+qty*price+ledger.value(price);peak=Math.max(peak,equity);
    const point={date:day+' 15:00',equity,nav:equity/c.capital,benchmark:(benchmarkCash+benchmarkQty*price+benchmarkLedger.value(price))/c.capital,drawdown:equity/peak-1,cash,quantity:qty,receivable:ledger.receivable(),lockedQuantity:ledger.locked(),valuationOnly:true};curve.push(point);dailyCurve.push(point);ledger.record(day,qty+ledger.locked());benchmarkLedger.record(day,benchmarkQty+benchmarkLedger.locked());finalize(day,i,{sessionIndex:sessionIndex.get(day)},day+' 15:00');
  }
  function technicalSignal(i,held){
    if(c.strategy==='ma')return ind.fast[i]>ind.slow[i];
    if(c.strategy==='macd')return ind.dif[i]>ind.dea[i];
    if(c.strategy==='rsi')return ind.rsi[i]<c.rsiBuy?true:ind.rsi[i]>c.rsiSell?false:held;
    return ind.xs[i]<ind.mid[i]-c.bbMult*ind.std[i]?true:ind.xs[i]>=ind.mid[i]?false:held;
  }
  for(let i=start;i<=end;i++) {
    const r=data[i],prev=data[i-1],day=dayOf(r),g=groupByDay.get(day);
    const execAt=executionTime(r,c.timeframe),sourceAt=closeTime(prev);feeDay=day;
    if(day!==lastDay){while(gapIndex<gapDays.length&&gapDays[gapIndex]<day)gapValuation(gapDays[gapIndex++],i);release(day);lastDay=day;finalize(day,i,g);}
    // Only a daily bar whose closing event already happened can become visible.
    while(dailyIndex+1<completeDays.length&&completeDays[dailyIndex+1].availableAt<=execAt)dailyIndex++;
    const d=dailyIndex>=0?completeDays[dailyIndex]:null;
    if(sourceAt>execAt||d&&d.availableAt>execAt){audit.timingViolations++;throw Error('信号时序违规：读取了尚未完成的 K 线。');}
    audit.decisions++;
    let reason='指标信号';
    if(c.strategy==='swing') {
      const lastObservedDay=groups[g.index-1];
      const canOpen=d&&lastObservedDay?.date===d.date&&dailyIndex>=dailyWarm-1;
      const confirmed=canOpen&&dailyIndex>=c.confirmationDays&&daily.fast[dailyIndex]>daily.fast[dailyIndex-1]&&daily.xs.slice(dailyIndex-c.confirmationDays+1,dailyIndex+1).every((x,j)=>x>daily.fast[dailyIndex-c.confirmationDays+1+j]);
      const trend=confirmed&&daily.fast[dailyIndex]>daily.slow[dailyIndex]&&daily.xs[dailyIndex]>daily.slow[dailyIndex];
      const breakout=canOpen&&daily.previousHigh[dailyIndex]!==null&&daily.xs[dailyIndex]>daily.previousHigh[dailyIndex];
      const confirmation=ind.fast[i-1]>ind.slow[i-1]&&ind.xs[i-1]>ind.fast[i-1]&&(daily.atr[dailyIndex]===null||ind.xs[i-1]-daily.fast[dailyIndex]<=c.maxExtensionATR*daily.atr[dailyIndex]);
      desired=qty>0?true:Boolean(trend&&breakout&&confirmation&&g.sessionIndex-lastExitDay>c.cooldownDays);
      reason='日线突破 + 执行周期确认';
      if(qty>0&&d&&daily.xs[dailyIndex]<daily.exit[dailyIndex])pendingExit=pendingExit||{reason:'日线趋势离场',signalTime:sourceAt,dailySignalTime:d.availableAt};
      if(qty>0&&d&&c.atrMult>0&&daily.atr[dailyIndex]!==null&&ind.xs[i-1]<=peakSignal-c.atrMult*daily.atr[dailyIndex])pendingExit=pendingExit||{reason:'ATR 跟踪止损',signalTime:sourceAt,dailySignalTime:d.availableAt};
    }else desired=technicalSignal(i-1,desired);
    if(qty&&entry) {
      const change=ind.xs[i-1]/entry.signalPrice-1;
      if(c.stop>0&&change<=-c.stop/100)pendingExit=pendingExit||{reason:'前根收盘止损',signalTime:sourceAt,dailySignalTime:c.strategy==='swing'?d?.availableAt:null};
      if(c.take>0&&change>=c.take/100)pendingExit=pendingExit||{reason:'前根收盘止盈',signalTime:sourceAt,dailySignalTime:c.strategy==='swing'?d?.availableAt:null};
    }
    if(metadata&&r.isHS300!==1&&qty>0)pendingExit=pendingExit||{reason:'历史沪深300成分调出',signalTime:day+' 09:30',dailySignalTime:null};
    if(r.isST===1){if(qty>0)pendingExit=pendingExit||{reason:'历史 ST 状态生效，退出持仓',signalTime:day+' 09:30',dailySignalTime:null};else if(desired)audit.stExcluded++;desired=false;}
    if(pendingExit){desired=false;reason=pendingExit.reason;}
    // Daily price limits use prior SESSION close, never the prior intraday bar close.
    const previousSession=groups[g.index-1];
    const prevPrice=r.prev_close??previousSession?.close??prev.close;
    const {up,down,rule}=knownLimits(r,prevPrice,c);
    const eligible=r.isST!==1&&(!metadata||r.isHS300===1&&r.membershipFresh===1)&&(c.strategy!=='swing'||Math.abs(r.open/prevPrice-1)<=c.maxGap/100)&&(r.listingSession==null||r.listingSession>20)&&r.specialSession!==1;
    const sell=qty>0&&!desired,buy=qty===0&&!entry&&desired&&eligible;
    // halted, prev_close and limit prices are input contracts: they must be known at this open.
    // Current HIGH / LOW / CLOSE / VOLUME are intentionally absent from execution decisions.
    const tradeable=r.halted!==1&&(sell?r.open>down+0.001:r.open<up-0.001);
    if((buy||sell)&&!tradeable)blocked++;
    const available=inventory.available(day);
    if(sell&&available<qty)t1Blocked++;
    if(sell)cancelT('趋势 / 风控离场，中止配对',execAt);
    const timing={signalTime:pendingExit?.signalTime??sourceAt,executionTime:execAt,dailySignalTime:pendingExit?pendingExit.dailySignalTime:c.strategy==='swing'?d?.availableAt:null};
    if(sell&&tradeable&&available>0) {
      const n=Math.min(qty,available,rule.maxOrder),price=Math.max(down,r.open*(1-c.slippage/10000)),amount=n*price,f=fee(amount,true);
      cash+=amount-f;const feeBreakdown=charge(amount,true);inventory.sell(n,day);
      trades.push({date:c.timeframe==='1d'?day:execAt,side:'卖出',price,quantity:n,amount,fee:f,feeBreakdown,purpose:'exit',sellableBefore:available,reason,pnl:null,...timing});
      entry.proceeds=(entry.proceeds??0)+amount-f;qty-=n;const before=closed.length;finalize(day,i,g);if(closed.length>before)trades.at(-1).pnl=closed.at(-1).pnl;
    }
    if(buy&&tradeable) {
      const price=Math.min(up,r.open*(1+c.slippage/10000));
      const equity=cash+qty*r.open+ledger.value(r.open),factor=r.signal_factor??(prev.signal_close??prev.close)/prev.close;
      const fixed=c.stop>0?price*factor*(1-c.stop/100):0,trail=d&&c.atrMult>0?price*factor-c.atrMult*(daily.atr[dailyIndex]??Infinity):0;
      let n=buyQuantity(cash*(managed?c.baseAllocation:c.allocation)/100,price,rule);
      n=riskQuantity(n,price,factor,Math.max(fixed,trail),equity);n=Math.floor(n/rule.step)*rule.step;
      while(n>=rule.minBuy&&n*price+fee(n*price,false)>cash)n-=rule.step;
      if(n>=rule.minBuy){const amount=n*price,f=fee(amount,false);qty=n;cash-=amount+f;const feeBreakdown=charge(amount,false);inventory.buy(n,day);
        entry={date:c.timeframe==='1d'?day:execAt,day,dayIndex:g.sessionIndex,price,signalPrice:price*(r.signal_factor??(prev.signal_close??prev.close)/prev.close),cost:amount+f,capitalBasis:amount+f,index:i,proceeds:0,dividends:0,initialSignal:price*factor,lastAddSignal:price*factor,lastAddDay:g.sessionIndex,addCount:0,baseQuantity:n};
        peakSignal=entry.signalPrice;
        trades.push({date:entry.date,side:'买入',price,quantity:n,amount,fee:f,feeBreakdown,purpose:'core',sellableBefore:available,reason,pnl:null,...timing});
      }
    }
    // Position management uses only the completed prior bar and visible prior daily bars.
    const factor=r.signal_factor??(prev.signal_close??prev.close)/prev.close,signalOpen=r.open*factor;
    const trendOK=d&&groups[g.index-1]?.date===d.date&&daily.fast[dailyIndex]>daily.slow[dailyIndex]&&daily.xs[dailyIndex]>daily.fast[dailyIndex]&&daily.fast[dailyIndex]>daily.fast[dailyIndex-1];
    const stockEquity=()=>cash+qty*r.open+ledger.value(r.open);
    const buyPrice=Math.min(up,r.open*(1+c.slippage/10000)),sellPrice=Math.max(down,r.open*(1-c.slippage/10000));
    const canBuy=eligible&&r.halted!==1&&r.open<up-.001,canSell=r.halted!==1&&r.open>down+.001;
    const stopSignal=entry?Math.max(c.stop>0?entry.signalPrice*(1-c.stop/100):0,d&&c.atrMult>0?peakSignal-c.atrMult*(daily.atr[dailyIndex]??Infinity):0):0;
    function purchase(n,purpose,why,tId=null){const amount=n*buyPrice,feeBreakdown=charge(amount,false);cash-=amount+feeBreakdown.total;qty+=n;inventory.buy(n,day,purpose);entry.cost+=amount+feeBreakdown.total;if(purpose==='add')entry.capitalBasis+=amount+feeBreakdown.total;const t={date:c.timeframe==='1d'?day:execAt,side:'买入',price:buyPrice,quantity:n,amount,fee:feeBreakdown.total,feeBreakdown,purpose,tId,sellableBefore:inventory.available(day),reason:why,pnl:null,...timing};trades.push(t);return t;}
    function sale(n,purpose,why,tId=null){const sellableBefore=inventory.available(day),amount=n*sellPrice,feeBreakdown=charge(amount,true);cash+=amount-feeBreakdown.total;qty-=n;inventory.sell(n,day);entry.proceeds+=amount-feeBreakdown.total;const t={date:execAt,side:'卖出',price:sellPrice,quantity:n,amount,fee:feeBreakdown.total,feeBreakdown,purpose,tId,sellableBefore,reason:why,pnl:null,...timing};trades.push(t);return t;}
    function affordable(n){while(n>=rule.minBuy&&n*buyPrice+fee(n*buyPrice,false)>cash)n-=rule.step;return n;}
    // A cross-day corporate action changes share units; do not fabricate a paired T profit.
    if(tPending&&tPending.day!==day&&actions.some(a=>a.exDate>tPending.day&&a.exDate<=day))cancelT('跨除权日，转为未配对库存',execAt);
    let managedOrder=false;
    if(tPending&&entry&&desired){
      const positive=tPending.direction==='positive',change=ind.xs[i-1]/tPending.signalPrice-1;
      const target=positive?change>=c.tTarget/100:change<=-c.tTarget/100;
      const loss=positive?change<=-c.tStop/100:change>=c.tStop/100;
      const expired=i-tPending.index>=c.tMaxBars||day>tPending.day||execAt.slice(11)>=(c.timeframe==='15m'?'14:45':'14:55');
      if(target||loss||expired){
        const n=tPending.quantity,can=positive?canSell&&inventory.available(day)>=n:canBuy&&affordable(n)>=n&&riskQuantity(n,buyPrice,factor,stopSignal,stockEquity())>=n&& (qty+n)*buyPrice+ledger.locked()*buyPrice<=stockEquity()*c.allocation/100;
        if(can){const second=positive?sale(n,'t-close',loss?'正 T 止损':expired?'正 T 超时收束':'正 T 反弹减回',tPending.id):purchase(n,'t-close',loss?'反 T 止损回补':expired?'反 T 超时回补':'反 T 回落回补',tPending.id);
          const first=tPending.first,buyLeg=positive?first:second,sellLeg=positive?second:first,pnl=sellLeg.amount-sellLeg.fee-buyLeg.amount-buyLeg.fee;
          tPairs.push({...tPending,status:'paired',end:execAt,second,pnl,reason:loss?'stop':expired?'timeout':'target'});tPending=null;managedOrder=true;lastTIndex=i;
        }else if(expired){cancelT('到期无法成交 / 回补，保留真实仓位',execAt);lastTIndex=i;}
      }
    }
    if(pyramiding&&entry&&qty>0&&desired&&eligible&&trendOK&&!tPending&&!managedOrder&&canBuy&&entry.addCount<c.maxAdds&&g.sessionIndex-entry.lastAddDay>=c.addSpacing&&daily.atr[dailyIndex]>0&&ind.xs[i-1]>=entry.lastAddSignal+c.addATR*daily.atr[dailyIndex]&&ind.xs[i-1]>ind.fast[i-1]&&signalOpen>entry.lastAddSignal){
      const equity=stockEquity(),coreCap=Math.max(c.baseAllocation,c.allocation-(doingT?c.tAllocation:0));
      let n=buyQuantity(Math.max(0,Math.min(equity*c.addAllocation/100,equity*coreCap/100-(qty+ledger.locked())*buyPrice)),buyPrice,rule);
      n=riskQuantity(n,buyPrice,factor,stopSignal,equity);n=affordable(Math.floor(n/rule.step)*rule.step);
      if(n>=rule.minBuy){purchase(n,'add','趋势延伸，风险预算内加仓');entry.lastAddSignal=buyPrice*factor;entry.lastAddDay=g.sessionIndex;entry.addCount++;adds++;managedOrder=true;}
    }
    if(tDay!==day){tDay=day;tAttempts=0;}
    if(doingT&&entry&&qty>0&&desired&&trendOK&&eligible&&!tPending&&!managedOrder&&tAttempts<c.tDailyPairs&&i-lastTIndex>1&&dayOf(prev)===day&&execAt.slice(11)<'14:30'&&ind.fast[i-1]>0){
      const deviation=ind.xs[i-1]/ind.fast[i-1]-1;
      const positive=['positive','adaptive'].includes(c.management)&&deviation<=-c.tDeviation/100&&ind.xs[i-1]>ind.xs[i-2];
      const reverse=['reverse','adaptive'].includes(c.management)&&deviation>=c.tDeviation/100&&ind.xs[i-1]<ind.xs[i-2];
      if(positive||reverse){
        const equity=stockEquity(),sellable=inventory.available(day);
        let n=buyQuantity(equity*c.tAllocation/100,buyPrice,rule);
        const keep=Math.ceil(entry.baseQuantity*.75/rule.step)*rule.step;
        n=Math.min(n,positive?sellable:Math.max(0,Math.min(sellable,qty-keep)),rule.maxOrder);
        if(positive){n=Math.min(n,Math.floor(Math.max(0,equity*c.allocation/100-(qty+ledger.locked())*buyPrice)/buyPrice));n=riskQuantity(n,buyPrice,factor,stopSignal,equity);n=affordable(Math.floor(n/rule.step)*rule.step);}else n=Math.floor(n/rule.step)*rule.step;
        const meanGap=positive?ind.fast[i-1]/factor-r.open:r.open-ind.fast[i-1]/factor;
        const expectedSpread=n*Math.max(0,Math.min(r.open*c.tTarget/100,meanGap));
        const enoughSpread=expectedSpread>=c.tCostBuffer*roundTripCost(n,buyPrice,c,day);
        if(n>=rule.minBuy&&enoughSpread&&(positive?canBuy&&canSell:canSell)){
          const id=++tSerial,first=positive?purchase(n,'t-open','正 T：回撤买入，预留可卖旧仓',id):sale(n,'t-open','反 T：偏离均线减仓，等回落回补',id);
          tPending={id,direction:positive?'positive':'reverse',day,index:i,quantity:n,signalPrice:first.price*factor,first,start:execAt};tAttempts++;lastTIndex=i;
        }
      }
    }
    // CLOSE becomes observable only now; it may affect equity now and the NEXT opening decision.
    if(qty){peakSignal=Math.max(peakSignal,ind.xs[i]);exposureBars++;}
    const equity=cash+qty*r.close+ledger.value(r.close);peak=Math.max(peak,equity);
    const point={date:r.date,equity,nav:equity/c.capital,benchmark:(benchmarkCash+benchmarkQty*r.close+benchmarkLedger.value(r.close))/c.capital,drawdown:equity/peak-1,cash,quantity:qty,receivable:ledger.receivable(),lockedQuantity:ledger.locked()};
    curve.push(point);
    if(r.date===g.availableAt||c.timeframe==='1d'){ledger.record(day,qty+ledger.locked());benchmarkLedger.record(day,benchmarkQty+benchmarkLedger.locked());}
    if(dailyCurve.length&&dayOf(dailyCurve.at(-1))===day)dailyCurve[dailyCurve.length-1]=point;else dailyCurve.push(point);
  }
  while(gapIndex<gapDays.length)gapValuation(gapDays[gapIndex++],end);
  if(tPending)cancelT('期末未完成，按真实现金 / 库存估值',curve.at(-1).date);
  const last=curve.at(-1),total=last.nav-1,tradingDays=dailyCurve.length,annual=last.nav**(252/tradingDays)-1;
  const returns=dailyCurve.map((r,i)=>r.equity/(i?dailyCurve[i-1].equity:c.capital)-1);
  const mean=returns.reduce((s,x)=>s+x,0)/returns.length;
  const sd=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(1,returns.length-1));
  const maxdd=curve.reduce((m,r)=>Math.min(m,r.drawdown),0),wins=closed.filter(t=>t.pnl>0),losses=closed.filter(t=>t.pnl<0);
  const incomplete=groups.filter(g=>!g.complete).map(g=>g.date);
  const warnings=[];
  if(actions.some(a=>a.cashBasis==='gross'))warnings.push('股息按税前金额核算，未计算个人持有期补税。');
  if(!metadata&&config.dataMode==='exploration')warnings.push('CSV探索：历史ST、成分股、公司行动与整日缺口未校验；不得将该结果视作正式研究。');
  if(incomplete.length)warnings.push(`${incomplete.length} 个交易日的分钟网格不完整；这些日线不会用于波段信号，缺少上一完整日线时禁止新开仓。`);
  if(c.strategy==='swing'&&completeDays.length===0)warnings.push('没有完整日线，无法形成大波段信号。');
  if(managed&&c.timeframe==='1d'&&['positive','reverse','adaptive'].includes(c.management))warnings.push('日线无法执行盘中 T，当前只运行底仓与分批加仓。');
  return {config:c,curve,dailyCurve,trades,closed,tPairs,feeTotals,audit,warnings,corporateEvents:ledger.log,metadata,
    dataInfo:{nativeTimeframe:native,executionTimeframe:c.timeframe,inputBars:input.length,executionBars:data.length,completeDailyBars:completeDays.length,incompleteDays:incomplete},
    metrics:{total,annual,maxdd,sharpe:sd>0&&tradingDays>1?mean/sd*Math.sqrt(252):null,winrate:closed.length?wins.length/closed.length:null,
      profitFactor:losses.length?wins.reduce((s,x)=>s+x.pnl,0)/-losses.reduce((s,x)=>s+x.pnl,0):null,
      adds,tPaired:tPairs.filter(t=>t.status==='paired').length,tUnmatched:tPairs.filter(t=>t.status==='unmatched').length,tNet:tPairs.filter(t=>t.status==='paired').reduce((s,t)=>s+t.pnl,0),tFees:trades.filter(t=>t.purpose?.startsWith('t-')).reduce((s,t)=>s+t.fee,0),fees,blocked,t1Blocked,equity:last.equity,quantity:qty,cash,benchmark:last.benchmark-1,excess:total-(last.benchmark-1),volatility:sd*Math.sqrt(252),
      closedTrades:closed.length,wilsonLower:wilson(wins.length,closed.length),expectancy:closed.length?closed.reduce((s,t)=>s+t.pnl,0)/closed.length:null,worstTrade:closed.length?Math.min(...closed.map(t=>t.return)):null,openUnrealized:entry?last.equity-cash+(entry.proceeds??0)+(entry.dividends??0)-entry.cost:0,
      averageHoldingDays:closed.length?closed.reduce((s,t)=>s+t.days,0)/closed.length:null,exposure:exposureBars/(end-start+1)},
    period:{from:curve[0].date,to:last.date,bars:end-start+1,valuationPoints:curve.filter(p=>p.valuationOnly).length,tradingDays}};
}

export function wilson(wins,n){if(!n)return null;const z=1.96,p=wins/n;return (p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);}
export function qualityScore(m,c){const eligible=m.closedTrades>=c.minTrades&&m.total>0&&m.expectancy>0&&(m.profitFactor===null?m.winrate===1:m.profitFactor>=c.minProfitFactor)&&m.maxdd>=-c.maxDrawdown/100;return {eligible,score:(m.wilsonLower??0)+Math.min(m.total,1)*.1+Math.max(m.maxdd,-1)*.2,reason:m.closedTrades<c.minTrades?'已平仓样本不足':!eligible?'收益、盈亏比或回撤未达标':'通过训练准入'};}

export function compareParameters(data,config) {
  const rowsInput=Array.isArray(data)?data:data.bars;
  const c={...defaults,...config};validate(c);
  const days=[...new Set(rowsInput.filter(r=>dayOf(r)>=c.from&&dayOf(r)<=c.to).map(dayOf))];
  if(days.length<20)throw Error('参数比较至少需要 20 个交易日，以保留独立验证区间。');
  const split=Math.floor(days.length*.7),trainTo=days[split-1],validationFrom=days[split];
  const combinations=[];
  if(c.strategy==='swing')for(const dailySlow of[60,90,120])for(const atrMult of[2,3,4])combinations.push({...c,dailySlow,atrMult});
  else for(const fast of[5,10,20])for(const slow of[30,60,90])combinations.push({...c,strategy:'ma',fast,slow});
  const rows=combinations.map(params=>{
    try{const training=backtest(data,{...params,to:trainTo});const validation=backtest(data,{...params,from:validationFrom});return {config:params,training:training.metrics,validation:validation.metrics,quality:qualityScore(training.metrics,c)};}
    catch(e){return {config:params,error:e.message};}
  });
  rows.sort((a,b)=>a.error?1:b.error?-1:c.objective==='return'?b.training.total-a.training.total:Number(b.quality.eligible)-Number(a.quality.eligible)||b.quality.score-a.quality.score);
  return {rows,trainFrom:c.from,trainTo,validationFrom,validationTo:c.to,selectionRule:c.objective==='return'?'training_return_only':'training_quality_only',qualified:rows.filter(r=>r.quality?.eligible).length,positionPolicy:'validation starts flat; past bars used only for indicator warmup'};
}

export const managementNames={base:'仅底仓',pyramid:'底仓 + 趋势加仓',positive:'加仓 + 正 T',reverse:'加仓 + 反 T',adaptive:'加仓 + 择向 T'};
export function compareManagement(data,config={}){
  const c={...defaults,...config};validate(c);
  if(c.strategy!=='swing')throw Error('仓位方案对照仅适用于大波段策略。');
  const input=Array.isArray(data)?data:data.bars,days=[...new Set(input.filter(r=>dayOf(r)>=c.from&&dayOf(r)<=c.to).map(dayOf))];
  if(days.length<20)throw Error('方案对照至少需要 20 个交易日。');
  const split=Math.floor(days.length*.7),trainTo=days[split-1],validationFrom=days[split];
  const rows=Object.keys(managementNames).map(management=>{const params={...c,management};try{
    const training=backtest(data,{...params,to:trainTo}),validation=backtest(data,{...params,from:validationFrom});
    return {name:managementNames[management],config:params,training:training.metrics,validation:validation.metrics,quality:qualityScore(training.metrics,c)};
  }catch(e){return {name:managementNames[management],config:params,error:e.message};}});
  const base=rows.find(r=>r.config.management==='base');for(const r of rows)if(!r.error&&base&&!base.error){r.trainingDelta=r.training.total-base.training.total;r.validationDelta=r.validation.total-base.validation.total;}
  // The held-out segment never contributes to ranking or admission.
  rows.sort((a,b)=>a.error?1:b.error?-1:Number(b.quality.eligible)-Number(a.quality.eligible)||b.quality.score-a.quality.score);
  return {rows,trainFrom:c.from,trainTo,validationFrom,validationTo:c.to,qualified:rows.filter(r=>r.quality?.eligible).length,selectionRule:'training_quality_only',positionPolicy:'same capital and fees; validation starts flat; daily historical warmup only',baselinePolicy:'same baseAllocation and riskBudget across all schemes; report full NAV difference, not isolated T spread'};
}
