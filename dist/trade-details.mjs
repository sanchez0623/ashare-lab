// Presentation only. Never write pair PnL into trade.pnl (whole-wave settlement),
// or feed these retrospective annotations into signals, accounting or ranking.
export const tradeDetailsVersion='1.0';
export const tradeDetailsPolicy='T net spread after both leg fees appears once on the closing leg (including reverse-T buys); wave settlement already contains T cash flows; never add the columns together';
const key=t=>JSON.stringify([t?.tId,t?.purpose,t?.executionTime??t?.date,t?.side,t?.quantity,t?.amount,t?.fee]);
export function tradeDetailRows(result){
  const trades=result.trades??[],tradeKeys=new Set(trades.map(key)),annotations=new Map(),seenIds=new Set();
  for(const pair of result.tPairs??[]){
    if(pair.id===undefined||pair.id===null||seenIds.has(pair.id))continue;seenIds.add(pair.id);
    const first=pair.first,second=pair.second;
    if(first?.tId!==pair.id||first.purpose!=='t-open'||!tradeKeys.has(key(first)))continue;
    if(pair.status==='unmatched'){annotations.set(key(first),{tPairStatus:'unmatched',tDirection:pair.direction,tPairPnl:null,tCounterpartAt:null});continue;}
    const valid=pair.status==='paired'&&second?.tId===pair.id&&second.purpose==='t-close'&&tradeKeys.has(key(second))&&first.quantity===second.quantity&&first.side!==second.side&&['positive','reverse'].includes(pair.direction)&&(pair.direction==='positive'?first.side==='买入'&&second.side==='卖出':first.side==='卖出'&&second.side==='买入');
    if(!valid||!Number.isFinite(pair.pnl))continue;
    const buy=first.side==='买入'?first:second,sell=first.side==='卖出'?first:second;
    if(![buy.amount,buy.fee,sell.amount,sell.fee].every(Number.isFinite)||Math.abs(pair.pnl-(sell.amount-sell.fee-buy.amount-buy.fee))>1e-6)continue;
    annotations.set(key(first),{tPairStatus:'opening-leg',tDirection:pair.direction,tPairPnl:null,tCounterpartAt:second.executionTime??second.date});
    annotations.set(key(second),{tPairStatus:'paired',tDirection:pair.direction,tPairPnl:pair.pnl,tCounterpartAt:first.executionTime??first.date});
  }
  return trades.map(t=>({...t,wavePnl:Number.isFinite(t.pnl)?t.pnl:null,...(annotations.get(key(t))??{tPairStatus:t.purpose?.startsWith('t-')?'unverified':'not-applicable',tDirection:null,tPairPnl:null,tCounterpartAt:null})}));
}
const csvCell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const fixed=(v,n)=>Number.isFinite(v)?v.toFixed(n):'';
export function tradeDetailsCSV(result){
  const header=['date','side','price','quantity','amount','fee','t_pair_net_pnl','wave_settlement_pnl','reason','signal_time','daily_signal_time','execution_time','purpose','t_id','t_pair_status','t_direction','t_counterpart_at','settled_at','commission','stamp','handling','regulatory','transfer','sellable_before'];
  const rows=tradeDetailRows(result).map(t=>[t.date,t.side,fixed(t.price,4),t.quantity,fixed(t.amount,2),fixed(t.fee,2),fixed(t.tPairPnl,2),fixed(t.wavePnl,2),t.reason,t.signalTime,t.dailySignalTime,t.executionTime,t.purpose,t.tId,t.tPairStatus,t.tDirection,t.tCounterpartAt,t.settledAt,...['commission','stamp','handling','regulatory','transfer'].map(k=>fixed(t.feeBreakdown?.[k],4)),t.sellableBefore]);
  return '\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
