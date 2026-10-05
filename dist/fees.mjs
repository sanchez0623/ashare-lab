// Rates are percentages in configuration. Each execution pays its own minimum.
export function orderFees(amount,sell,c,day){
  if(!Number.isFinite(amount)||amount<0)throw Error('成交金额无效');
  if(amount===0)return {commission:0,stamp:0,handling:0,regulatory:0,transfer:0,total:0};
  const transfer=c.taxMode==='historical'?(day<'2022-04-29'?(c.board==='bse'?.0025:.002):.001):c.transfer;
  const stamp=c.taxMode==='historical'?(day<'2023-08-28'?.1:.05):c.stamp;
  const f={commission:Math.max(c.minCommission,amount*c.commission/100),stamp:sell?amount*stamp/100:0,handling:amount*c.handling/100,regulatory:amount*c.regulatory/100,transfer:amount*transfer/100};
  f.total=Object.values(f).reduce((s,v)=>s+v,0);return f;
}
export function roundTripCost(quantity,price,c,day){return orderFees(quantity*price,false,c,day).total+orderFees(quantity*price,true,c,day).total+quantity*price*2*c.slippage/10000;}
