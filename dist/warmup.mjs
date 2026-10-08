import {dailyGroups,resampleData,dayOf,executionTime} from './data.mjs';
import {requiredWarmupSessions} from './research-input.mjs';

// History diagnostics only. The engine still independently audits the bundle,
// historical states and execution timing before any simulated transaction.
export function warmupAvailability(input,c){
 const raw=Array.isArray(input)?input:input.bars,data=resampleData(raw,c.timeframe);
 const start=data.findIndex(r=>dayOf(r)>=c.from&&dayOf(r)<=c.to);
 if(start<0)throw Error('所选研究日期内没有行情，无法检查预热。');
 const firstExecutionAt=executionTime(data[start],c.timeframe),groups=dailyGroups(data),groupDays=new Set(groups.map(g=>g.date));
 const complete=new Set(groups.filter(g=>g.complete&&g.availableAt<firstExecutionAt).map(g=>g.date));
 if(!Array.isArray(input)){
  const calendar=new Set(input.calendar??[]);
  for(const d of input.daily??[])if(calendar.has(d.date)&&d.halted===1&&!groupDays.has(d.date)&&d.date+' 15:00'<firstExecutionAt)complete.add(d.date);
 }
 return {availableDailySessions:complete.size,availableExecutionBars:start,firstExecutionAt};
}
export function assessWarmup(input,c,candidates=[c],availability=null){
 const available=availability??warmupAvailability(input,c);
 const requiredDailySessions=Math.max(...candidates.map(p=>p.strategy==='swing'?Math.max(p.dailySlow,p.breakout+1,p.exitPeriod,p.atrPeriod,p.confirmationDays+1):0));
 const requiredExecutionBars=Math.max(...candidates.map(p=>({swing:p.slow,ma:p.slow,macd:p.macdSlow+p.macdSignal,rsi:p.rsiPeriod+1,boll:p.bbPeriod})[p.strategy]));
 const requiredCollectionSessions=Math.max(...candidates.map(requiredWarmupSessions));
 const missingDailySessions=Math.max(0,requiredDailySessions-available.availableDailySessions),missingExecutionBars=Math.max(0,requiredExecutionBars-available.availableExecutionBars);
 return {...available,requiredDailySessions,requiredExecutionBars,requiredCollectionSessions,missingDailySessions,missingExecutionBars,sufficient:!missingDailySessions&&!missingExecutionBars,researchFrom:c.from,researchTo:c.to};
}
export function warmupMessage(w){
 return `本轮候选预热不足：需要 ${w.requiredDailySessions} 个完整交易日和 ${w.requiredExecutionBars} 根执行周期K线；当前研究开始前有 ${w.availableDailySessions} 个完整交易日和 ${w.availableExecutionBars} 根K线${w.missingDailySessions?'，缺 '+w.missingDailySessions+' 个完整交易日':''}${w.missingExecutionBars?'，缺 '+w.missingExecutionBars+' 根执行周期K线':''}。请补齐 ${w.researchFrom} 前的历史，采集预热设置为至少 ${w.requiredCollectionSessions} 个交易日；研究起止日期保持不变。`;
}
