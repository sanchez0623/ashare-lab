// A separate entitlement ledger: raw prices fill orders; ex-date receivables and
// locked bonus shares are assets, but cannot fund orders before actual payment.
export class CorporateLedger{
  constructor(actions=[]){this.actions=actions;this.entitlements=new Map();this.claims=[];this.log=[];this.settled=new Set();this.dividendTotal=0;}
  record(day,qty){for(const a of this.actions)if(a.recordDate===day&&!this.entitlements.has(a.id)){this.entitlements.set(a.id,qty);if(qty)this.log.push({date:day,event:'权益登记',id:a.id,quantity:qty});}}
  open(day,qty){let cash=0,shares=0;
    for(const a of this.actions)if(a.exDate<=day&&!this.settled.has(a.id)){this.settled.add(a.id);const eligible=this.entitlements.get(a.id)??0;if(!eligible)continue;
      if(a.type==='rights'||a.rightsPerShare>0)throw Error('配股账务明细未支持，不能跳过认购资金核算。');
      const amount=eligible*(a.cashPerShare??0),bonus=Math.floor(eligible*(a.bonusPerShare??0)+1e-8);
      this.claims.push({id:a.id,cash:amount,shares:bonus,payDate:a.payDate,listDate:a.shareListDate,cashBasis:a.cashBasis});
      this.log.push({date:day,event:'除权权益入账',id:a.id,cashReceivable:amount,lockedShares:bonus,fractionalPolicy:'floor shares per entitlement; no invented cash compensation'});
    }
    for(const x of this.claims){if(x.cash&&day>=x.payDate){cash+=x.cash;this.dividendTotal+=x.cash;this.log.push({date:day,event:'股息到账',id:x.id,amount:x.cash,basis:x.cashBasis});x.cash=0;}if(x.shares&&day>=x.listDate){shares+=x.shares;this.log.push({date:day,event:'送转股上市',id:x.id,quantity:x.shares});x.shares=0;}}
    return {cash,shares};
  }
  value(price){return this.claims.reduce((s,x)=>s+x.cash+x.shares*price,0);}
  locked(){return this.claims.reduce((s,x)=>s+x.shares,0);}
  receivable(){return this.claims.reduce((s,x)=>s+x.cash,0);}
  outstanding(){return this.claims.some(x=>x.cash||x.shares);}
  futureEntitlements(day){return this.actions.some(a=>this.entitlements.get(a.id)>0&&a.exDate>day);}
}
