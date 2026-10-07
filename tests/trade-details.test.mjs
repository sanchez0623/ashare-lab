import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tradeDetailRows,tradeDetailsCSV} from '../dist/trade-details.mjs';
import {backtest,defaults,demoMinuteData} from '../dist/engine.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const leg=(side,date,price,quantity,fee,purpose,tId=1)=>({side,date,executionTime:date,price,quantity,fee,amount:price*quantity,purpose,tId,pnl:null,reason:purpose==='t-close'?'正 T 止损':'正 T：回撤买入，预留可卖旧仓'});
function sample(){const first=leg('买入','2026-01-20 10:30',86.123,200,6.10,'t-open'),second=leg('卖出','2026-01-20 11:05',85.007,200,14.59,'t-close');return {trades:[first,second],tPairs:[{id:1,direction:'positive',first,second,status:'paired',pnl:second.amount-second.fee-first.amount-first.fee}],metrics:{equity:1000000},curve:[]};}

test('positive T stop displays the net loss once on the closing sale, separate from wave settlement',()=>{
 const r=sample(),before=JSON.stringify(r),rows=tradeDetailRows(r);near(rows[1].tPairPnl,-243.89);assert.equal(rows[0].tPairPnl,null);assert.equal(rows[0].tPairStatus,'opening-leg');assert.equal(rows[1].tPairStatus,'paired');assert.ok(rows.every(t=>t.wavePnl===null));assert.equal(JSON.stringify(r),before);
 r.trades[1].pnl=500;r.trades[1].settledAt='2026-02-02 09:30';const settled=tradeDetailRows(r);near(settled[1].tPairPnl,-243.89);assert.equal(settled[1].wavePnl,500);assert.equal(r.trades[1].pnl,500);
});

test('reverse T completes on a purchase and never reports the initial sale as pair profit',()=>{
 const first=leg('卖出','2026-01-20 09:45',88.526,700,39.96,'t-open',2),second=leg('买入','2026-01-20 09:55',86.743,700,8.89,'t-close',2),pnl=first.amount-first.fee-second.amount-second.fee;
 const r={trades:[first,second],tPairs:[{id:2,direction:'reverse',first,second,status:'paired',pnl}]},rows=tradeDetailRows(JSON.parse(JSON.stringify(r)));assert.equal(rows[0].tPairPnl,null);near(rows[1].tPairPnl,1199.25);assert.equal(rows[1].side,'买入');assert.equal(rows[1].wavePnl,null);assert.equal(rows[0].tCounterpartAt,second.date);
});

test('unmatched or unverifiable pair evidence cannot manufacture a realized amount, including zero-PnL cases',()=>{
 const r=sample();r.tPairs[0].status='unmatched';r.tPairs[0].pnl=null;r.trades.pop();let rows=tradeDetailRows(r);assert.equal(rows[0].tPairStatus,'unmatched');assert.equal(rows[0].tPairPnl,null);
 const wrong=sample();wrong.tPairs[0].pnl+=100;rows=tradeDetailRows(wrong);assert.ok(rows.every(t=>t.tPairStatus==='unverified'&&t.tPairPnl===null));
 const zero=sample();zero.trades[1].amount=zero.trades[0].amount+zero.trades[0].fee+zero.trades[1].fee;zero.tPairs[0].pnl=0;assert.equal(tradeDetailRows(zero)[1].tPairPnl,0);
});

test('CSV separates both amounts and quotes commas while preserving all rows independent of pagination',()=>{
 const r=sample(),csv=tradeDetailsCSV(r);assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/"t_pair_net_pnl","wave_settlement_pnl"/);assert.match(csv,/"-243.89",""/);assert.match(csv,/"正 T：回撤买入，预留可卖旧仓"/);assert.equal(csv.trim().split('\r\n').length,3);assert.equal(tradeDetailRows({...r,trades:[...r.trades].reverse()})[0].tPairPnl,r.tPairs[0].pnl);
});

test('actual simulated adaptive fills annotate every closed pair once without altering accounting or raw reports',()=>{
 const r=backtest(demoMinuteData(),{...defaults,dataMode:'demo',management:'adaptive',riskBudget:5,tDeviation:.15,tTarget:.25,tCostBuffer:1}),before=JSON.stringify(r),rows=tradeDetailRows(JSON.parse(before)),pairs=r.tPairs.filter(t=>t.status==='paired');assert.ok(pairs.some(p=>p.pnl<0));assert.ok(pairs.some(p=>p.direction==='reverse'));
 assert.equal(rows.filter(t=>t.tPairPnl!==null).length,pairs.length);near(rows.reduce((s,t)=>s+(t.tPairPnl??0),0),r.metrics.tNet);near(rows.reduce((s,t)=>s+(t.wavePnl??0),0),r.closed.reduce((s,t)=>s+t.pnl,0));assert.equal(JSON.stringify(r),before);assert.ok(rows.filter(t=>t.tPairPnl!==null).every(t=>t.purpose==='t-close'));
});
