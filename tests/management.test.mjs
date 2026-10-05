import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backtest,defaults,demoMinuteData,orderFees,roundTripCost,compareManagement} from '../dist/engine.mjs';
import {Inventory} from '../dist/inventory.mjs';
const d=demoMinuteData();
const c={...defaults,dataMode:'demo',management:'adaptive',riskBudget:5,tDeviation:.15,tTarget:.25,tCostBuffer:1};
const barClose=t=>new Date(Date.parse(t.replace(' ','T')+':00Z')+15*60000).toISOString().slice(0,16).replace('T',' ');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
test('user fee schedule is exact, separately directional, per-order minimum and editable',()=>{
 assert.equal(defaults.capital,1000000);assert.equal(defaults.taxMode,'manual');
 const buy=orderFees(1000000,false,defaults,'2024-01-01'),sell=orderFees(1000000,true,defaults,'2024-01-01');
 near(buy.total,114.1);near(sell.total,614.1);assert.equal(buy.stamp,0);assert.equal(buy.commission,50);assert.equal(buy.handling,34.1);
 near(orderFees(10000,false,defaults,'2024-01-01').total,5.641);assert.equal(orderFees(0,false,defaults,'2024-01-01').total,0);
 near(roundTripCost(10000,100,{...defaults,slippage:0},'2024-01-01'),728.2);
 assert.equal(orderFees(1000000,false,{...defaults,commission:.01},'2024-01-01').commission,100);
 assert.equal(orderFees(1000000,true,{...defaults,taxMode:'historical'},'2020-01-01').stamp,1000);
});
test('physical FIFO inventory cannot sell new buys after selling and rebuying old core',()=>{
 const book=new Inventory();book.buy(1000,'2024-01-01');book.buy(200,'2024-01-02','t-open');
 assert.equal(book.available('2024-01-02'),1000);book.sell(200,'2024-01-02');assert.equal(book.available('2024-01-02'),800);
 book.buy(300,'2024-01-02','add');assert.throws(()=>book.sell(900,'2024-01-02'),/T\+1/);book.sell(800,'2024-01-02');assert.equal(book.available('2024-01-02'),0);assert.equal(book.available('2024-01-03'),500);
 book.release(100,'2024-01-03');assert.equal(book.available('2024-01-03'),600);
});
test('managed core, adds and both T legs share cash, retain losses and honor sellable lots',()=>{
 const r=backtest(d,c),prices=new Map(d.map(r=>[r.date,r.close]));assert.ok(r.metrics.adds>0);assert.ok(r.metrics.tPaired>0);
 assert.ok(r.tPairs.some(t=>t.status==='paired'&&t.pnl<0),'stop and timeouts must preserve losing pairs');assert.ok(r.tPairs.some(t=>t.direction==='positive'));assert.ok(r.tPairs.some(t=>t.direction==='reverse'));
 for(const t of r.trades){if(t.side==='卖出')assert.ok(t.quantity<=t.sellableBefore);near(t.fee,Object.values(t.feeBreakdown).slice(0,-1).reduce((s,v)=>s+v,0));assert.ok(t.signalTime<=t.executionTime);assert.ok(t.dailySignalTime<t.executionTime);}
 for(const p of r.curve){assert.ok(p.cash>=-1e-7);near(p.equity,p.cash+p.quantity*prices.get(p.date));}
 for(const t of r.tPairs.filter(t=>t.status==='paired')){const buy=t.first.side==='买入'?t.first:t.second,sell=t.first.side==='卖出'?t.first:t.second;near(t.pnl,sell.amount-sell.fee-buy.amount-buy.fee);assert.equal(t.first.quantity,t.second.quantity);}
 near(r.metrics.fees,Object.values(r.feeTotals).reduce((s,v)=>s+v,0));near(r.metrics.equity,c.capital+r.closed.reduce((s,t)=>s+t.pnl,0)+r.metrics.openUnrealized);
 for(const t of r.trades.filter(t=>t.purpose==='add')){const previous=r.trades.filter(x=>['core','add'].includes(x.purpose)&&x.executionTime<t.executionTime).at(-1);assert.ok(t.price>previous.price,'never average down');}
});
test('cost gate blocks small T spreads and default plan does not automatically enable T',()=>{
 const r=backtest(d,{...c,commission:1,minCommission:500,tTarget:.1,tCostBuffer:2});assert.equal(r.metrics.tPaired,0);assert.equal(r.metrics.tUnmatched,0);
 const base=backtest(d,defaults);assert.equal(base.config.management,'pyramid');assert.equal(base.metrics.tPaired,0);assert.ok(base.metrics.adds>0);
});
test('unfinished T at end and untradeable next open are explicit, not fabricated profitable exits',()=>{
 const full=backtest(d,c),first=full.trades.find(t=>t.purpose==='t-open');assert.ok(first);
 const cut=d.findIndex(r=>r.date===barClose(first.executionTime)),prefix=d.slice(0,cut+1),r=backtest(prefix,{...c,to:prefix.at(-1).date.slice(0,10)});
 assert.ok(r.tPairs.some(t=>t.status==='unmatched'));assert.ok(r.tPairs.filter(t=>t.status==='unmatched').every(t=>t.pnl===null));
 const mutated=structuredClone(d),firstDay=first.executionTime.slice(0,10);for(const row of mutated)if(row.date.slice(0,10)===firstDay&&row.date>prefix.at(-1).date){row.halted=1;row.volume=0;}
 const blocked=backtest(mutated,c);assert.ok(blocked.tPairs.some(t=>t.status==='unmatched'&&t.start===first.executionTime));
});
test('future validation prices cannot change training-only scheme ranking',()=>{
 const comparison=compareManagement(d,c),changed=structuredClone(d);for(const row of changed)if(row.date.slice(0,10)>=comparison.validationFrom)for(const k of ['open','close','high','low','prev_close'])row[k]*=.7;
 const second=compareManagement(changed,c);assert.equal(comparison.rows.length,5);assert.equal(comparison.selectionRule,'training_quality_only');
 assert.deepEqual(comparison.rows.map(r=>[r.config.management,r.training,r.quality]),second.rows.map(r=>[r.config.management,r.training,r.quality]));assert.ok(comparison.trainTo<comparison.validationFrom);
});
test('management opening decisions do not read the current close, extremes or volume',()=>{
 const r=backtest(d,c),first=r.trades.find(t=>t.purpose==='t-open'),idx=d.findIndex(r=>r.date===barClose(first.executionTime));
 const changed=structuredClone(d);changed[idx].close*=1.1;changed[idx].high*=1.3;changed[idx].low*=.7;changed[idx].volume*=9;
 const after=backtest(changed,c);assert.deepEqual(r.trades.filter(t=>t.executionTime<=first.executionTime),after.trades.filter(t=>t.executionTime<=first.executionTime));
 assert.deepEqual(r.curve.filter(p=>p.date<d[idx].date),after.curve.filter(p=>p.date<d[idx].date));
});
