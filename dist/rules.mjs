// Regular continuous-auction research orders. Market orders, price cages and special
// IPO/resumption/delisting sessions need supplied exchange limits or are rejected.
export const boardNames={main:'主板',chinext:'创业板',star:'科创板',bse:'北交所'};
export const rulesVersion='CN-equity-2026-07-06';
export const cents=v=>Math.floor(v*100+0.500000001)/100;
export function boardRule(board,day,isST=0,listingSession=null,listedDate=null){
  if(!boardNames[board])throw Error('缺少有效板块信息，不能只按证券代码猜测历史板块。');
  let pct=board==='bse'?30:board==='star'?20:board==='chinext'&&day>='2020-08-24'?20:isST===1&&day<'2026-07-06'?5:10;
  const noLimit=listingSession!==null&&(board==='bse'?listingSession===1:board==='star'||board==='chinext'&&listedDate>='2020-08-24'||board==='main'&&listedDate>='2023-04-10'?listingSession<=5:false);
  if(noLimit)pct=0;
  return {board,pct,noLimit,minBuy:board==='star'?200:100,step:board==='star'||board==='bse'?1:100,maxOrder:board==='star'?100000:board==='bse'?1000000:1000000};
}
export function buyQuantity(budget,price,rule){const n=Math.min(rule.maxOrder,Math.floor(budget/price/rule.step)*rule.step);return n>=rule.minBuy?n:0;}
export function knownLimits(row,previousClose,c){
  const rule=boardRule(row.board??c.board,row.date.slice(0,10),row.isST??0,row.listingSession??null,row.listedDate??null);
  if(row.limit_up!==undefined&&row.limit_down!==undefined)return {up:row.limit_up,down:row.limit_down,rule};
  if(row.noLimit===1||rule.noLimit)return {up:Infinity,down:0,rule};
  if(row.specialSession===1)throw Error('特殊交易日缺少交易所实际限价，禁止按普通比例推算。');
  const pct=c.rulesMode==='manual'?c.limit:rule.pct;
  return {up:pct?cents(previousClose*(1+pct/100)):Infinity,down:pct?cents(previousClose*(1-pct/100)):0,rule};
}
