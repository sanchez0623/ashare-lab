// Closed vocabulary: data admission, exchange rules, ST and timing are not editable.
export const strategyNames={swing:'大波段趋势',ma:'双均线',macd:'MACD',rsi:'RSI',boll:'布林带'};
const numeric=(label,min,max,step=1)=>({label,type:'number',min,max,step});
const enumeration=(label,values)=>({label,type:'enum',values});
export const parameterSchema={
 strategy:enumeration('策略',Object.keys(strategyNames)),timeframe:enumeration('执行周期',['5m','15m','1d']),from:{label:'开始日期',type:'date'},to:{label:'结束日期',type:'date'},
 fast:numeric('执行短均线',2,250),slow:numeric('执行长均线',2,250),macdFast:numeric('MACD 快线',2,250),macdSlow:numeric('MACD 慢线',2,250),macdSignal:numeric('MACD 信号线',2,250),
 dailyFast:numeric('日线短均线',2,250),dailySlow:numeric('日线长均线',2,250),breakout:numeric('突破窗口',2,250),exitPeriod:numeric('趋势离场均线',2,250),atrPeriod:numeric('ATR 周期',2,250),atrMult:numeric('ATR 跟踪倍数',0,10,.01),confirmationDays:numeric('连续确认',1,10),maxGap:numeric('允许开盘缺口 / %',0,20,.1),maxExtensionATR:numeric('最大延伸 / ATR',.1,10,.1),cooldownDays:numeric('冷却交易日',0,30),
 rsiPeriod:numeric('RSI 周期',2,250),rsiBuy:numeric('RSI 买入阈值',0,100),rsiSell:numeric('RSI 卖出阈值',0,100),bbPeriod:numeric('布林窗口',2,250),bbMult:numeric('布林标准差倍数',.1,5,.1),capital:numeric('初始资金 / 元',1000,1e9),allocation:numeric('总仓位上限 / %',1,100),
 management:enumeration('波段仓位方案',['base','pyramid','positive','reverse','adaptive']),baseAllocation:numeric('底仓上限 / %',1,100),riskBudget:numeric('风险预算 / %',.1,20,.1),addAllocation:numeric('每次加仓 / %',1,100),maxAdds:numeric('最多加仓次数',0,10),addATR:numeric('加仓间隔 / ATR',.1,10,.1),addSpacing:numeric('加仓间隔交易日',1,30),tAllocation:numeric('T 机动仓 / %',1,30),tDeviation:numeric('T 偏离均线 / %',.1,10,.1),tTarget:numeric('T 目标价差 / %',.1,10,.1),tStop:numeric('T 不利价差止损 / %',.1,20,.1),tMaxBars:numeric('T 最多等待根数',1,96),tDailyPairs:numeric('每天最多开 T',1,10),tCostBuffer:numeric('T 成本门槛倍数',1,10,.1),stop:numeric('固定止损 / %',0,100,.1),take:numeric('固定止盈 / %',0,1000,.1),
 commission:numeric('佣金 / %',0,5,.00001),minCommission:numeric('最低佣金 / 元',0,10000,.01),stamp:numeric('印花税 / %',0,5,.00001),handling:numeric('经手费 / %',0,5,.00001),regulatory:numeric('证管费 / %',0,5,.00001),transfer:numeric('过户费 / %',0,5,.00001),slippage:numeric('滑点 / bp',0,1000),minTrades:numeric('训练最少平仓样本',5,500),minProfitFactor:numeric('训练最低盈利因子',1,10,.1),maxDrawdown:numeric('训练最大回撤 / %',.1,100,.1),objective:enumeration('训练选参目标',['quality','return'])
};
export const tuningSpecs={
 swing:[['dailySlow','dailySlowStep',5,1,50],['atrMult','atrStep',.25,.05,2],['confirmationDays','confirmationStep',1,1,3]],
 ma:[['fast','fastStep',2,1,50],['slow','slowStep',5,1,50]],
 macd:[['macdFast','macdFastStep',2,1,50],['macdSlow','macdSlowStep',3,1,50],['macdSignal','macdSignalStep',1,1,20]],
 rsi:[['rsiPeriod','rsiPeriodStep',2,1,50],['rsiBuy','rsiBuyStep',5,1,20],['rsiSell','rsiSellStep',5,1,20]],
 boll:[['bbPeriod','bbPeriodStep',2,1,50],['bbMult','bbMultStep',.1,.1,1]]
};
export const tuningKeys=strategy=>(tuningSpecs[strategy]??[]).map(x=>x[0]);
export const candidateLabel=c=>tuningKeys(c.strategy).map(k=>parameterSchema[k].label+' '+c[k]).join(' / ');
export const parameterContext=config=>Object.fromEntries(Object.keys(parameterSchema).map(k=>[k,config[k]]));
export function validateParameterValue(key,value){
 const s=parameterSchema[key];if(!s)throw Error('不允许调整参数：'+key);
 if(s.type==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||value<s.min||value>s.max||Math.abs(value/s.step-Math.round(value/s.step))>1e-6)throw Error(s.label+'超出范围或精度要求');
 }else if(s.type==='enum'){if(!s.values.includes(value))throw Error(s.label+'选项无效');}
 else if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error(s.label+'不是有效日期');
}
