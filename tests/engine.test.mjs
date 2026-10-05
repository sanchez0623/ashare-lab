import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,parseCSV,backtest,demoData,demoMinuteData,detectTimeframe,resampleData,compareParameters} from '../dist/engine.mjs';
import {slots} from '../dist/data.mjs';
const dailyMarket=(n=70)=>Array.from({length:n},(_,i)=>{const date=new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10),p=10+i*.1;return {date,open:p,high:p+.1,low:p-.1,close:p,volume:100000,prev_close:i?p-.1:p,halted:0};});
function minuteMarket(n=100){const result=[];let di=0,prev=10;for(let d=new Date('2024-01-01T00:00:00Z');di<n;d.setUTCDate(d.getUTCDate()+1)){if([0,6].includes(d.getUTCDay()))continue;const day=d.toISOString().slice(0,10);slots(5).forEach((time,bi)=>{const p=10+di*.04+bi*.0008;result.push({date:day+' '+time,open:p,high:p+.002,low:p-.002,close:p+.0004,volume:10000,prev_close:prev,halted:0});});prev=result.at(-1).close;di++;}return result;}
const config=d=>({...defaults,strategy:'ma',timeframe:'1d',taxMode:'manual',rulesMode:'manual',from:d[35].date,to:d.at(-1).date,fast:5,slow:10,stop:0,take:0,management:'base',handling:0,regulatory:0,commission:0,minCommission:0,transfer:0,stamp:0,slippage:0,limit:0});
const minuteConfig=d=>({...defaults,strategy:'ma',timeframe:'5m',taxMode:'manual',rulesMode:'manual',from:d[48*2].date.slice(0,10),to:d.at(-1).date.slice(0,10),fast:2,slow:3,stop:0,take:0,management:'base',handling:0,regulatory:0,commission:0,minCommission:0,transfer:0,stamp:0,slippage:0,limit:0});

test('all five strategies have deterministic finite results and preserve accounting',()=>{const d=demoData(),prices=new Map(d.map(r=>[r.date,r.close]));for(const strategy of['swing','ma','macd','rsi','boll']){const c={...defaults,strategy,timeframe:'1d'},r=backtest(d,c);assert.equal(r.curve.length,782);assert.ok(Number.isFinite(r.metrics.total));assert.ok(r.metrics.cash>=0);assert.equal(r.metrics.quantity%100,0);for(const p of r.curve)assert.ok(Math.abs(p.equity-(p.cash+p.quantity*prices.get(p.date)))<1e-7);assert.deepEqual(r,backtest(d,c));}});

test('future bars do not change previous fills or equity',()=>{const d=dailyMarket(),c=config(d),r1=backtest(d,c),d2=structuredClone(d);for(let i=50;i<d2.length;i++)for(const key of['open','high','low','close','prev_close'])d2[i][key]*=.8;const r2=backtest(d2,c);assert.deepEqual(r1.curve.slice(0,15),r2.curve.slice(0,15));assert.deepEqual(r1.trades.filter(t=>t.date<d[50].date),r2.trades.filter(t=>t.date<d[50].date));});

test('current high, low and future total volume cannot alter opening fills',()=>{const d=dailyMarket(),c={...config(d),slippage:100},original=backtest(d,c),changed=structuredClone(d);for(const r of changed){r.high*=2;r.low*=.5;r.volume*=10;}const r2=backtest(changed,c);assert.deepEqual(original.trades,r2.trades);assert.ok(original.trades[0].price>d[35].high,'cost estimate must not be clipped to future bar high');});

test('current close cannot influence its own opening order',()=>{const d=dailyMarket(),c=config(d),r1=backtest(d,c),d2=structuredClone(d);d2[35].close*=.5;d2[35].low=d2[35].close-.1;const r2=backtest(d2,c);assert.deepEqual(r1.trades.filter(t=>t.date===d[35].date),r2.trades.filter(t=>t.date===d[35].date));assert.notEqual(r1.curve[0].equity,r2.curve[0].equity,'close affects mark-to-market after opening, as intended');});

test('100-share lots and fixed-cost accounting include initial drawdown',()=>{const d=dailyMarket(),c={...config(d),commission:.03,minCommission:5,stamp:.05,transfer:.001},r=backtest(d,c),t=r.trades[0];assert.equal(t.date,c.from);assert.equal(t.quantity%100,0);assert.ok(Math.abs(t.fee-(Math.max(5,t.amount*.0003)+t.amount*.00001))<1e-8);assert.ok(Math.abs(r.curve[0].equity-(c.capital-t.fee))<1e-8);assert.ok(r.curve[0].drawdown<0);});

test('opening-known halt status and opening limit-up block entries',()=>{const d=dailyMarket(),c={...config(d),limit:10};d[35].volume=0;d[35].halted=1;d[36].open=20;d[36].high=20;d[36].close=20;const r=backtest(d,c);assert.equal(r.trades[0].date,d[37].date);assert.equal(r.metrics.blocked,2);});

test('T+1 in minute data means a different trading date, with risk exit retained',()=>{const d=minuteMarket(6),c={...minuteConfig(d),stop:5,stamp:.05};const start=48*2;d[start].close=d[start].open*.8;d[start].low=d[start].close;const r=backtest(d,c),entry=r.trades[0],sell=r.trades.find(t=>t.side==='卖出');assert.equal(entry.executionTime,d[start].date.slice(0,10)+' 09:30');assert.equal(sell.executionTime.slice(0,10),d[start+48].date.slice(0,10));assert.ok(r.metrics.t1Blocked>0);assert.equal(sell.signalTime,d[start].date);assert.ok(Math.abs(sell.fee-sell.amount*.0005)<1e-8);assert.equal(r.closed[0].pnl,sell.amount-sell.fee-entry.amount-entry.fee);assert.equal(r.closed[0].days,1);});

test('minute daily limits are based on yesterday close, not previous minute close',()=>{const d=minuteMarket(4),start=48*2,previousDayClose=d[start-1].close;for(let i=0;i<3;i++){const r=d[start+i];r.open=previousDayClose*1.2;r.close=previousDayClose*(.88+i*.01);r.high=r.open;r.low=r.close;}
  d[start+3].open=previousDayClose*1.05;d[start+3].high=d[start+3].open;d[start+3].prev_close=previousDayClose;const r=backtest(d,{...minuteConfig(d),limit:10});assert.equal(r.trades[0].executionTime,d[start+3].date.slice(0,10)+' 09:45');});

test('5m and 15m annualization and Sharpe use matching daily equity samples',()=>{const d=minuteMarket(8),c=minuteConfig(d),r5=backtest(d,c),r15=backtest(d,{...c,timeframe:'15m'});assert.equal(r5.period.tradingDays,6);assert.equal(r15.period.tradingDays,6);assert.equal(r5.curve.length,r15.curve.length*3);assert.equal(r5.metrics.annual,r5.curve.at(-1).nav**(252/6)-1);assert.deepEqual(r5.dailyCurve.map(p=>p.equity),r15.dailyCurve.map(p=>p.equity));assert.equal(r5.metrics.sharpe,r15.metrics.sharpe);});

test('5m aggregates only complete 15m candles, lunch break is not filled, daily cannot generate minutes',()=>{const d=minuteMarket(2),r=resampleData(d,'15m');assert.equal(r.length,32);assert.equal(r[0].date.slice(11),'09:45');assert.equal(r[7].date.slice(11),'11:30');assert.equal(r[8].date.slice(11),'13:15');assert.equal(r[0].open,d[0].open);assert.equal(r[0].close,d[2].close);assert.equal(r[0].volume,30000);assert.equal(resampleData(d.slice(0,7),'15m').length,2);assert.throws(()=>resampleData(d.slice(0,4),'15m'),/不足两根/);});

test('no fabricated finer resolution and native timeframe inference',()=>{const d=minuteMarket(2);assert.equal(detectTimeframe(d),'5m');assert.equal(detectTimeframe(resampleData(d,'15m')),'15m');assert.throws(()=>resampleData(dailyMarket(),'5m'),/无法/);assert.throws(()=>resampleData(resampleData(d,'15m'),'5m'),/无法/);});

test('prefix-invariant multi-timeframe signals: future daily close never leaks into intraday trades',()=>{const d=minuteMarket(100),c={...minuteConfig(d),strategy:'swing',maxExtensionATR:10,from:d[48*65].date.slice(0,10),timeframe:'15m'},full=backtest(d,c),cut=48*80+21,prefix=d.slice(0,cut),truncated=backtest(prefix,c),last=truncated.curve.at(-1).date;
  assert.ok(full.trades.length>0);assert.deepEqual(truncated.curve,full.curve.filter(p=>p.date<=last));assert.deepEqual(truncated.trades,full.trades.filter(t=>t.executionTime<last));
  const changed=structuredClone(d);for(let i=cut;i<changed.length;i++){changed[i].close*=.7;changed[i].low=Math.min(changed[i].low,changed[i].close);changed[i].high*=1.3;}
  const r2=backtest(changed,c);assert.deepEqual(full.curve.filter(p=>p.date<=last),r2.curve.filter(p=>p.date<=last));assert.deepEqual(full.trades.filter(t=>t.executionTime<last),r2.trades.filter(t=>t.executionTime<last));
  for(const t of full.trades){assert.ok(t.signalTime<=t.executionTime);assert.ok(t.dailySignalTime<t.executionTime);assert.ok(t.dailySignalTime.slice(0,10)<t.executionTime.slice(0,10));}
  assert.equal(full.audit.timingViolations,0);
});

test('swing breakout excludes the signal day and can buy a fresh record high',()=>{const d=minuteMarket(90),c={...minuteConfig(d),strategy:'swing',maxExtensionATR:10,from:d[48*65].date.slice(0,10)};const r=backtest(d,c);assert.ok(r.trades.some(t=>t.side==='买入'),'including the signal day in maximum would prevent every breakout');assert.equal(r.trades[0].dailySignalTime.slice(0,10),d[48*65-1].date.slice(0,10));});

test('large swing strategy ignores isolated minute down-crosses while daily trend remains valid',()=>{const d=minuteMarket(90),start=48*65,c={...minuteConfig(d),strategy:'swing',maxExtensionATR:10,from:d[start].date.slice(0,10),atrMult:0};for(let i=start+10;i<start+14;i++){d[i].close*=.98;d[i].low=d[i].close;}
  const r=backtest(d,c);assert.ok(r.trades.some(t=>t.side==='买入'));assert.equal(r.trades.filter(t=>t.side==='卖出').length,0);assert.ok(r.metrics.quantity>0);});

test('training selection is invariant to changed validation prices',()=>{const d=minuteMarket(230),c={...minuteConfig(d),strategy:'swing',maxExtensionATR:10,objective:'return',timeframe:'15m',from:d[48*125].date.slice(0,10)},comparison=compareParameters(d,c),changed=structuredClone(d);
  for(const r of changed)if(r.date.slice(0,10)>=comparison.validationFrom)for(const key of['open','high','low','close','prev_close'])r[key]*=.7;
  const second=compareParameters(changed,c);assert.equal(comparison.rows.length,9);assert.equal(comparison.selectionRule,'training_return_only');assert.deepEqual(comparison.rows.map(r=>[r.config.dailySlow,r.config.atrMult,r.training?.total]),second.rows.map(r=>[r.config.dailySlow,r.config.atrMult,r.training?.total]));assert.ok(comparison.trainTo<comparison.validationFrom);
});

test('no trades produces null win rate, null Sharpe and no drawdown',()=>{const d=dailyMarket().map(r=>({...r,open:10,high:10,low:10,close:10,prev_close:10})),r=backtest(d,config(d));assert.equal(r.trades.length,0);assert.equal(r.metrics.winrate,null);assert.equal(r.metrics.sharpe,null);assert.equal(r.metrics.maxdd,0);});

test('CSV rejects duplicates, invalid OHLC, nonfinite values and unknown opening halts',()=>{const h='date,open,high,low,close,volume\n';assert.throws(()=>parseCSV(h+'2024-01-01,10,11,9,10,100\n2024-01-01,10,11,9,10,100'),/重复/);assert.throws(()=>parseCSV(h+'2024-01-01,10,9,9,10,100\n2024-01-02,10,11,9,10,100'),/OHLC/);assert.throws(()=>parseCSV(h+'2024-01-01,NaN,11,9,10,100\n2024-01-02,10,11,9,10,100'),/无效/);assert.throws(()=>parseCSV(h+'2024-01-01,10,11,9,10,0\n2024-01-02,10,11,9,10,100'),/halted/);const sorted=parseCSV(h+'2024-01-02,10,11,9,10,100\n2024-01-01,10,11,9,10,100');assert.equal(sorted[0].date,'2024-01-01');});

test('minute CSV accepts close timestamps and rejects lunch/start-time misalignment',()=>{const h='datetime,open,high,low,close,volume\n';const d=parseCSV(h+'2024-01-02 09:35,10,11,9,10,100\n2024-01-02 09:40,10,11,9,10,100');assert.equal(detectTimeframe(d),'5m');assert.throws(()=>parseCSV(h+'2024-01-02 09:30,10,11,9,10,100\n2024-01-02 09:35,10,11,9,10,100'),/分钟网格/);assert.throws(()=>parseCSV(h+'2024-01-02 12:00,10,11,9,10,100\n2024-01-02 13:15,10,11,9,10,100'),/分钟网格/);});

test('warmup is required in daily sessions for swings and in bars for other strategies',()=>{const d=dailyMarket();assert.throws(()=>backtest(d,{...config(d),from:d[1].date}),/预热/);assert.throws(()=>backtest(d,{...config(d),fast:20,slow:10}),/短期/);const m=minuteMarket(40);assert.throws(()=>backtest(m,{...minuteConfig(m),strategy:'swing',from:m[48*30].date.slice(0,10)}),/完整交易日预热/);});

test('minute demo is deterministic, complete and works at both execution periods',()=>{const d=demoMinuteData();assert.deepEqual(d.slice(0,10),demoMinuteData().slice(0,10));for(const timeframe of['5m','15m']){const r=backtest(d,{...defaults,dataMode:'demo',timeframe});assert.equal(r.period.tradingDays,782);assert.equal(r.warnings.length,0);assert.equal(r.audit.timingViolations,0);assert.ok(r.trades.length>0);}});


test('15m aggregation preserves halt known at bucket open rather than future resume state',()=>{const d=minuteMarket(5),start=48*2;d[start].halted=1;d[start].volume=0;const bars=resampleData(d,'15m');assert.equal(bars[16*2].halted,1);assert.ok(bars[16*2].volume>0);const r=backtest(d,{...minuteConfig(d),timeframe:'15m'});assert.equal(r.trades[0].executionTime,d[start].date.slice(0,10)+' 09:45');assert.equal(r.metrics.blocked,1);});
