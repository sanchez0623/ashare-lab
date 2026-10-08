import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,withEvent} from './fixture.mjs';
import {portfolioBacktest,comparePortfolio} from '../dist/portfolio.mjs';
import {orderFees} from '../dist/fees.mjs';
import {entryDecision,validateEntryMode} from '../dist/combination.mjs';

const config=b=>({strategy:'swing',timeframe:'5m',dataMode:'single',from:b.calendar[65],to:b.calendar.at(-1),strategies:['ma'],maxHoldings:2,capital:100000,dailyFast:5,dailySlow:20,fast:2,slow:3,stop:8,take:0});
function stock(symbol='600519',n=80){const b=fixture(n);b.metadata.symbol=symbol;return {symbol,data:b,snapshotId:symbol.padEnd(64,'a')};}
function accountAudit(r){
 let cash=r.config.capital;const qty=new Map(),fills=[...r.trades].sort((a,b)=>a.confirmationTime.localeCompare(b.confirmationTime));let i=0;
 const actions=r.corporateEvents.filter(e=>['股息到账','送转股上市'].includes(e.event)).map(e=>({...e,at:e.date+' 09:30'}));let j=0;
 for(const p of r.curve){while(j<actions.length&&actions[j].at<=p.date){const e=actions[j++];if(e.event==='股息到账')cash+=e.amount;else qty.set(e.symbol,(qty.get(e.symbol)??0)+e.quantity);}
  while(i<fills.length&&fills[i].confirmationTime<=p.date){const t=fills[i++];cash+=t.side==='买入'?-t.amount-t.fee:t.amount-t.fee;qty.set(t.symbol,(qty.get(t.symbol)??0)+(t.side==='买入'?t.quantity:-t.quantity));assert.ok(t.signalTime<=t.executionTime);assert.ok(!t.dailySignalTime||t.dailySignalTime<=t.executionTime);if(t.side==='卖出')assert.ok(t.sellableBefore>=t.quantity);assert.ok(Math.abs(t.amount-t.quantity*t.price)<1e-7);}
  assert.ok(Math.abs(cash-p.cash)<1e-6,p.date);assert.ok(p.cash>=-.001);assert.ok(p.reservedCash<=p.cash+.001);assert.ok(p.positions<=r.config.maxHoldings);assert.ok(Math.abs(p.equity-p.cash-p.stockValue-p.receivable)<1e-6);
 }
 assert.ok(Math.abs(r.metrics.equity-r.config.capital-r.contributions.reduce((n,s)=>n+s.pnl,0))<1e-6);
 assert.ok(Math.abs(r.metrics.fees-r.trades.reduce((n,t)=>n+t.fee,0))<1e-6);
}
test('shared account, equal slots, per-order fees and deterministic symbol priority',()=>{
 const inputs=[stock('600188'),stock('600519'),stock('000001')],c={...config(inputs[0].data),maxHoldings:2},r=portfolioBacktest(inputs,c);
 assert.equal(r.metrics.maxHeld,2);assert.deepEqual(r.trades.filter(t=>t.side==='买入').map(t=>t.symbol),['000001','600188']);assert.ok(r.metrics.skipped.capacity>0);
 for(const t of r.trades)assert.equal(t.fee,orderFees(t.amount,t.side==='卖出',r.config,t.date.slice(0,10)).total);
 assert.deepEqual(portfolioBacktest([...inputs].reverse(),c),r);assert.deepEqual(portfolioBacktest(inputs,c),r);accountAudit(r);
 assert.ok(r.curve.every(p=>p.equity<110000),'must not multiply initial capital by three');
});
test('joint confirmation uses AND at entry; single-strategy and multi-stock baselines are separate accounts',()=>{
 const inputs=[stock(),stock('600188')],c={...config(inputs[0].data),strategies:['ma','macd']},r=comparePortfolio(inputs,c);
 assert.equal(r.comparison.rows.length,4);assert.ok(r.trades.filter(t=>t.side==='买入').every(t=>t.confirmations.ma&&t.confirmations.macd));
 const conflict=portfolioBacktest(inputs,{...c,strategies:['ma','rsi']});assert.equal(conflict.trades.length,0);assert.equal(conflict.metrics.total,0);
 accountAudit(r);
});
test('entry truth table includes only selected strategies and rejects invalid modes',()=>{
 const states=[{ma:false,rsi:false,macd:true},{ma:true,rsi:false,macd:false},{ma:false,rsi:true,macd:false},{ma:true,rsi:true,macd:false}];
 for(const [i,signals]of states.entries()){
  assert.equal(entryDecision(signals,['ma','rsi'],'all').matched,i===3);
  assert.equal(entryDecision(signals,['ma','rsi'],'any').matched,i!==0);
 }
 assert.deepEqual(entryDecision(states[1],['ma','rsi'],'any'),{matched:true,strategies:['ma']});assert.equal(validateEntryMode(),'all');
 for(const mode of [null,'','and','or','ALL',0,false,['all'],{}])assert.throws(()=>validateEntryMode(mode),/入场组合方式/);
});
test('OR combines conflicting signals in one account, attributes actual triggers and labels the report',()=>{
 const inputs=[stock('600188'),stock('600519'),stock('000001')],c={...config(inputs[0].data),strategies:['ma','rsi'],entryMode:'any'},r=comparePortfolio(inputs,c);
 assert.equal(portfolioBacktest(inputs,{...c,entryMode:'all'}).trades.length,0);assert.ok(r.trades.length>0);assert.ok(r.metrics.maxHeld<=c.maxHoldings);assert.equal(r.config.entryMode,'any');assert.equal(r.audit.entryMode,'any');assert.match(r.comparison.rows[0].name,/任一策略满足/);assert.ok(r.comparison.rows.slice(2).every(row=>row.name.includes('任一策略满足')));
 for(const t of r.trades.filter(t=>t.side==='买入')){assert.equal(t.entryMode,'any');assert.deepEqual(t.entryStrategies,c.strategies.filter(k=>t.confirmations[k]===true));assert.ok(t.entryStrategies.length);assert.match(t.reason,/任一满足/);assert.ok(!t.reason.includes('共同确认'));}
 assert.ok(r.trades.some(t=>t.side==='买入'&&t.entryStrategies.length===1&&t.entryStrategies[0]==='ma'&&!t.reason.includes('RSI')));
 assert.deepEqual(portfolioBacktest([...inputs].reverse(),c),portfolioBacktest(inputs,c));accountAudit(r);
 const none=portfolioBacktest(inputs,{...c,strategies:['rsi','boll']});assert.equal(none.trades.length,0,'unselected MA and MACD must not trigger OR');
});
test('missing mode preserves AND, one selected strategy has identical cash flows, and OR still requires all warmup',()=>{
 const a=stock(),c=config(a.data),defaultResult=portfolioBacktest([a],c),all=portfolioBacktest([a],{...c,entryMode:'all'}),any=portfolioBacktest([a],{...c,entryMode:'any'});
 assert.deepEqual(defaultResult,all);assert.deepEqual(any.metrics,all.metrics);assert.deepEqual(any.curve,all.curve);assert.deepEqual(any.contributions,all.contributions);
 assert.deepEqual(any.trades.map(t=>[t.date,t.side,t.price,t.quantity,t.fee]),all.trades.map(t=>[t.date,t.side,t.price,t.quantity,t.fee]));
 assert.throws(()=>portfolioBacktest([a],{...c,entryMode:'any',strategies:['ma','swing'],dailySlow:70}),/预热不足/);
 assert.throws(()=>portfolioBacktest([a],{...c,entryMode:'or'}),/入场组合方式/);accountAudit(any);
});
test('OR cannot fill zero liquidity or change orders and NAV before future evidence is available',()=>{
 const a=stock(),c={...config(a.data),strategies:['ma','rsi'],entryMode:'any',maxHoldings:1},before=portfolioBacktest([a],c),cut=a.data.calendar[75],changed=structuredClone(a);
 for(const r of changed.data.bars)if(r.date.slice(0,10)>=cut){r.close*=1.01;r.high=Math.max(r.high,r.close)+.01;r.volume*=2;}
 const after=portfolioBacktest([changed],c);assert.deepEqual(after.trades.filter(t=>t.confirmationTime.slice(0,10)<cut),before.trades.filter(t=>t.confirmationTime.slice(0,10)<cut));assert.deepEqual(after.curve.filter(t=>t.date.slice(0,10)<cut),before.curve.filter(t=>t.date.slice(0,10)<cut));
 const empty=structuredClone(a);empty.data.bars.find(r=>r.date===c.from+' 09:35').volume=0;const unfilled=portfolioBacktest([empty],c),o=unfilled.orderAttempts[0];assert.equal(o.status,'unfilled');assert.ok(!unfilled.trades.some(t=>t.id===o.id));accountAudit(unfilled);
});
test('first native zero-volume interval cannot fill a 15-minute order or charge fees; reserve releases later',()=>{
 const a=stock(),b=stock('600188'),c={...config(a.data),timeframe:'15m',maxHoldings:1};
 const first=a.data.bars.find(r=>r.date===c.from+' 09:35');first.volume=0;
 const r=portfolioBacktest([a,b],c),attempt=r.orderAttempts[0];
 assert.equal(attempt.symbol,'600188'); // deterministic priority independent of input order
 b.data.bars.find(r=>r.date===c.from+' 09:35').volume=0;
 const noFill=portfolioBacktest([a,b],c),o=noFill.orderAttempts[0];assert.equal(o.status,'unfilled');assert.equal(o.evidenceAvailableAt,c.from+' 09:35');assert.equal(o.resolvedAt,c.from+' 09:35');assert.ok(!noFill.trades.some(t=>t.id===o.id));
 assert.ok(noFill.trades.every(t=>t.executionTime>o.executionTime));accountAudit(noFill);
});
test('future candles cannot change earlier decisions, orders, cash or NAV',()=>{
 const a=stock(),c=config(a.data),before=portfolioBacktest([a],c),changed=structuredClone(a),cut=a.data.calendar[75];
 for(const r of changed.data.bars)if(r.date.slice(0,10)>=cut){r.close*=1.01;r.high=Math.max(r.high,r.close)+.01;r.volume*=2;}
 // Preserve the independent raw daily report; changes are warning-only.
 const after=portfolioBacktest([changed],c);assert.deepEqual(after.trades.filter(t=>t.confirmationTime.slice(0,10)<cut),before.trades.filter(t=>t.confirmationTime.slice(0,10)<cut));assert.deepEqual(after.curve.filter(t=>t.date.slice(0,10)<cut),before.curve.filter(t=>t.date.slice(0,10)<cut));
});
test('T+1 defers an intraday stop; ST blocks entries and triggers a held position exit',()=>{
 const a=stock(),c={...config(a.data),strategies:['ma'],maxHoldings:1,stop:.001};
 // Ordinary price pullback, not a future-derived suspension state.
 const day=c.from;for(const r of a.data.bars)if(r.date.slice(0,10)===day&&r.date.slice(11)>='10:00')for(const k of ['open','high','low','close'])r[k]*=.98;
 const r=portfolioBacktest([a],c),buy=r.trades.find(t=>t.side==='买入'),sell=r.trades.find(t=>t.side==='卖出');assert.ok(buy&&sell);assert.ok(sell.date.slice(0,10)>buy.date.slice(0,10));assert.ok(r.metrics.skipped.t1>0);accountAudit(r);
 const st=stock(),stDay=st.data.calendar[68];st.data.daily.find(d=>d.date===stDay).isST=1;
 const sr=portfolioBacktest([st],{...config(st.data),maxHoldings:1});assert.ok(sr.trades.some(t=>t.side==='卖出'&&t.reason==='历史ST状态生效'));assert.ok(!sr.trades.some(t=>t.side==='买入'&&t.date.slice(0,10)===stDay));accountAudit(sr);
});
test('cash dividend receivable, delayed bonus release and per-stock contribution reconcile',()=>{
 const a=stock(),b=stock('600188');a.data=withEvent(a.data,68,{cash:.2,bonus:.1});b.data=withEvent(b.data,69,{cash:.1,bonus:.05});
 const r=portfolioBacktest([a,b],config(a.data));assert.equal(r.corporateEvents.filter(e=>e.event==='股息到账').length,2);assert.ok(r.curve.some(p=>p.receivable>0));assert.ok(r.contributions.every(s=>s.quantity>0));assert.ok(!r.trades.some(t=>t.side==='卖出'&&t.reason==='前根收盘止损'));accountAudit(r);
});
test('hard corporate/history defects and insufficient warmup block; discrepancies remain warnings',()=>{
 const a=stock(),c=config(a.data);a.data.daily[70].volume+=50000;assert.ok(portfolioBacktest([a],c).warnings.some(w=>w.includes('未修复')));
 assert.throws(()=>portfolioBacktest([a],{...c,strategies:['swing'],dailySlow:70}),/预热不足/);
 const event=stock();event.data=withEvent(event.data,68,{cash:.2});event.data.actions[0].cashPerShare=.1;assert.throws(()=>portfolioBacktest([event],c),/除权参考价/);
 assert.throws(()=>portfolioBacktest([stock(),stock()],c),/重复/);assert.throws(()=>portfolioBacktest([stock()],{...c,maxHoldings:0}),/最大持仓/);
 assert.throws(()=>portfolioBacktest([stock()],{...c,strategies:[]}),/请选择/);
});
test('same opening orders never read current extremes, closing price or liquidity to size or prioritize',()=>{
 const a=stock('600188'),b=stock('600519'),c=config(a.data),before=portfolioBacktest([a,b],c),afterA=structuredClone(a),r=afterA.data.bars.find(x=>x.date===c.from+' 09:35');
 r.close*=1.05;r.high=Math.max(r.high,r.close);r.volume=0;
 const after=portfolioBacktest([afterA,b],c),intent=o=>({symbol:o.symbol,side:o.side,submittedAt:o.submittedAt,quantity:o.quantity,price:o.price,fee:o.fee,confirmations:o.confirmations});
 assert.deepEqual(after.orderAttempts.filter(o=>o.submittedAt===c.from+' 09:30').map(intent),before.orderAttempts.filter(o=>o.submittedAt===c.from+' 09:30').map(intent));
 assert.equal(after.orderAttempts[0].status,'unfilled');assert.equal(before.orderAttempts[0].status,'filled');accountAudit(after);
});
test('a simultaneous sale does not release cash or the holding slot before its native interval resolves',()=>{
 const a=stock('600188'),b=stock('600519'),c={...config(a.data),maxHoldings:1},switchDay=a.data.calendar[70];
 for(const d of b.data.daily)if(d.date<switchDay&&d.date>=c.from)d.isST=1;
 a.data.daily.find(d=>d.date===switchDay).isST=1;
 const r=portfolioBacktest([a,b],c),sale=r.trades.find(t=>t.symbol==='600188'&&t.side==='卖出'),purchase=r.trades.find(t=>t.symbol==='600519'&&t.side==='买入');
 assert.equal(sale.executionTime,switchDay+' 09:30');assert.equal(sale.confirmationTime,switchDay+' 09:35');assert.equal(purchase.executionTime,switchDay+' 09:35');assert.ok(purchase.executionTime>=sale.confirmationTime);assert.ok(!r.orderAttempts.some(o=>o.symbol==='600519'&&o.submittedAt===sale.executionTime));accountAudit(r);
});
test('direct portfolio simulation does not use training thresholds and does not allow synthetic-real mixing',()=>{
 const a=stock(),c={...config(a.data),minTrades:3};assert.ok(portfolioBacktest([a],c).metrics.equity>0);
 const b=stock('600188');delete b.data.metadata.synthetic;assert.throws(()=>portfolioBacktest([a,b],c),/合成测试行情不能与真实股票混用/);
});
test('per-security board lots and historical limits cannot be replaced by an old global manual limit',()=>{
 for(const [symbol,board]of [['600188','main'],['300001','chinext'],['688001','star'],['920001','bse']]){
  const a=stock(symbol);a.data.metadata.board=board;const r=portfolioBacktest([a],{...config(a.data),capital:6000,maxHoldings:1,rulesMode:'manual',limit:0});assert.equal(r.config.rulesMode,'historical');const buy=r.trades.find(t=>t.side==='买入');assert.ok(buy);assert.ok(buy.quantity>=(board==='star'?200:100));if(['main','chinext'].includes(board))assert.equal(buy.quantity%100,0);else assert.notEqual(buy.quantity%100,0);accountAudit(r);
 }
});
