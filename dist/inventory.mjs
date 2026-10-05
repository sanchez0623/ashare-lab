// The physical long-only inventory is shared by core, adds and T executions.
export class Inventory {
  constructor(){this.lots=[];}
  buy(quantity,day,purpose='core'){if(quantity>0)this.lots.push({quantity,day,purpose});}
  release(quantity,day){this.buy(quantity,'0000-00-00','bonus');}
  available(day){return this.lots.reduce((n,l)=>n+(l.day<day?l.quantity:0),0);}
  sell(quantity,day){if(quantity>this.available(day))throw Error('T+1 库存不足');let left=quantity;for(const lot of this.lots){if(lot.day>=day)continue;const n=Math.min(left,lot.quantity);lot.quantity-=n;left-=n;if(!left)break;}this.lots=this.lots.filter(l=>l.quantity);}
}
