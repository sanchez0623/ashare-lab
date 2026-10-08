import {indicators,sma} from './engine.mjs';
import {dailyGroups,executionTime} from './data.mjs';

export const strategyNames={swing:'大波段趋势',ma:'双均线',macd:'MACD',rsi:'RSI超卖',boll:'布林下轨'};
export const entryModeNames={all:'共同确认',any:'任一策略满足'};
export function validateEntryMode(mode='all'){
 if(typeof mode!=='string'||!Object.hasOwn(entryModeNames,mode))throw Error('入场组合方式无效：请选择共同确认或任一策略满足。');
 return mode;
}
export function entryDecision(signals,strategies,mode='all'){
 mode=validateEntryMode(mode);
 const triggered=strategies.filter(k=>signals[k]===true);
 return {matched:triggered.length>0&&(mode==='any'||triggered.length===strategies.length),strategies:triggered};
}
export function validateCombination(strategies){
 if(!Array.isArray(strategies)||!strategies.length||strategies.length>5||new Set(strategies).size!==strategies.length||strategies.some(s=>typeof s!=='string'||!Object.hasOwn(strategyNames,s)))throw Error('请选择1–5个不重复的策略。');
 return [...strategies];
}
function dailySignals(days,c){
 const xs=days.map(d=>d.signal_close),fast=sma(xs,c.dailyFast),slow=sma(xs,c.dailySlow),exit=sma(xs,c.exitPeriod);
 const previousHigh=days.map((_,j)=>j<c.breakout?null:Math.max(...days.slice(j-c.breakout,j).map(d=>d.signal_high)));
 const tr=days.map((d,j)=>j?Math.max(d.signal_high-d.signal_low,Math.abs(d.signal_high-xs[j-1]),Math.abs(d.signal_low-xs[j-1])):d.signal_high-d.signal_low);
 let value=null;const atr=tr.map((v,j)=>{if(j<c.atrPeriod-1)return null;value=j===c.atrPeriod-1?tr.slice(0,c.atrPeriod).reduce((a,b)=>a+b,0)/c.atrPeriod:(value*(c.atrPeriod-1)+v)/c.atrPeriod;return value;});
 return {xs,fast,slow,exit,previousHigh,atr};
}
// Values are precomputed, but a decision can access only indices whose
// closing event has happened. Completed daily bars become visible at 15:00.
export function combinationSignals(data,c,{calendar=[],daily=[]}={}){
 const groups=dailyGroups(data),observed=new Map(groups.map((g,i)=>[g.date,{...g,index:i}])),dm=new Map(daily.map(d=>[d.date,d]));
 const halted=calendar.filter(day=>!observed.has(day)&&dm.get(day)?.halted===1).map(day=>{const d=dm.get(day),x=d.close*d.causalFactor;return {date:day,signal_close:x,signal_high:x,signal_low:x,complete:true,availableAt:day+' 15:00'};});
 const days=[...groups.filter(g=>g.complete),...halted].sort((a,b)=>a.date.localeCompare(b.date)),di=dailySignals(days,c),ind=indicators(data,c);
 let visible=-1;
 return {ind,days,groups,at(i){
  const at=executionTime(data[i],c.timeframe),j=i-1;
  while(visible+1<days.length&&days[visible+1].availableAt<=at)visible++;
  const k=visible,d=days[k],g=observed.get(data[i].date.slice(0,10));
  const warm=Math.max(c.confirmationDays+1,c.dailySlow,c.breakout+1,c.exitPeriod,c.atrPeriod);
  const previous=groups[g.index-1],canOpen=k>=warm-1&&d&&previous?.date===d.date;
  const confirmed=canOpen&&di.fast[k]>di.fast[k-1]&&di.xs.slice(k-c.confirmationDays+1,k+1).every((x,n)=>x>di.fast[k-c.confirmationDays+1+n]);
  const swing=Boolean(confirmed&&di.fast[k]>di.slow[k]&&di.xs[k]>di.slow[k]&&di.previousHigh[k]!==null&&di.xs[k]>di.previousHigh[k]&&ind.fast[j]>ind.slow[j]&&ind.xs[j]>ind.fast[j]&&(di.atr[k]===null||ind.xs[j]-di.fast[k]<=c.maxExtensionATR*di.atr[k]));
  return {entry:{swing,ma:ind.fast[j]!==null&&ind.slow[j]!==null&&ind.fast[j]>ind.slow[j],macd:ind.dif[j]>ind.dea[j],rsi:ind.rsi[j]!==null&&ind.rsi[j]<c.rsiBuy,boll:ind.mid[j]!==null&&ind.xs[j]<ind.mid[j]-c.bbMult*ind.std[j]},
   exit:{swing:d&&di.exit[k]!==null&&di.xs[k]<di.exit[k],ma:ind.fast[j]<=ind.slow[j],macd:ind.dif[j]<=ind.dea[j],rsi:ind.rsi[j]!==null&&ind.rsi[j]>c.rsiSell,boll:ind.mid[j]!==null&&ind.xs[j]>=ind.mid[j]},
   signalPrice:ind.xs[j],atr:k>=0?di.atr[k]:null,dailySignalTime:d?.availableAt??null,signalTime:data[j].date.length===10?data[j].date+' 15:00':data[j].date};
 }};
}
