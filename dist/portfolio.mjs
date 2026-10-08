import {defaults,validate,wilson} from './engine.mjs';
import {detectTimeframe,resampleData,dayOf,closeTime,executionTime} from './data.mjs';
import {prepareBundle} from './quality.mjs';
import {assessWarmup,warmupMessage} from './warmup.mjs';
import {knownLimits,buyQuantity,rulesVersion} from './rules.mjs';
import {orderFees} from './fees.mjs';
import {CorporateLedger} from './corporate.mjs';
import {Inventory} from './inventory.mjs';
import {combinationSignals,validateCombination,strategyNames,validateEntryMode,entryDecision,entryModeNames} from './combination.mjs';

export const portfolioVersion='1.1-entry-modes-shared-account';
export const portfolioDefaults={strategies:['swing','macd'],entryMode:'all',maxHoldings:3,exitMode:'trend',scope:'single-security'};
export function portfolioBacktest(inputs,config={}){
 const c={...defaults,...portfolioDefaults,...config,management:'base',rulesMode:'historical'};
 c.strategies=validateCombination(c.strategies);c.entryMode=validateEntryMode(c.entryMode);
 // This is direct simulation, not training. Unused legacy management and
 // training thresholds cannot prevent a valid equal-slot simulation.
 const unused=['minTrades','minProfitFactor','maxDrawdown','objective','baseAllocation','addAllocation','maxAdds','addATR','addSpacing','riskBudget','tAllocation','tDeviation','tTarget','tStop','tMaxBars','tDailyPairs','tCostBuffer'];
 const checked={...c,...Object.fromEntries(unused.map(k=>[k,defaults[k]])),strategy:c.strategies[0],baseAllocation:Math.min(defaults.baseAllocation,c.allocation)};validate(checked);
 if(!['trend','any'].includes(c.exitMode)||!['single-security','hs300'].includes(c.scope))throw Error('组合退出方式或股票池范围无效。');
 if(!Array.isArray(inputs)||!inputs.length||inputs.length>30)throw Error('组合需包含1–30只股票，每只提供一个完整行情快照。');
 if(!Number.isInteger(c.maxHoldings)||c.maxHoldings<1||c.maxHoldings>30)throw Error('最大持仓数须为1–30的整数。');
 if(inputs.some(x=>Array.isArray(x?.data))&&!(c.dataMode==='demo'&&inputs.every(x=>Array.isArray(x?.data))))throw Error('真实组合需为每只股票提供完整数据包；合成演示不能与真实数据混用。');
 const universe=new Set(),warnings=[],stocks=inputs.map(item=>{
  let raw,metadata,calendar=[],daily=[],actions=[],quality=null;
  if(Array.isArray(item.data)){raw=item.data;metadata={symbol:item.symbol,board:item.board??c.board,name:'合成演示',synthetic:true};}
  else{const p=prepareBundle(item.data,{scope:c.scope});({bars:raw,metadata,calendar,daily,actions}=p);quality=p.report;}
  const symbol=metadata.symbol;
  if(!/^\d{6}$/.test(symbol)||item.symbol&&item.symbol!==symbol||universe.has(symbol))throw Error('证券代码无效、与快照不符或重复：'+symbol);universe.add(symbol);
  if(metadata.delistedDate&&metadata.delistedDate<=c.to)throw Error(symbol+' 在区间内退市，缺少清算账务，不能继续组合回测。');
  if(!Array.isArray(item.data)&&(!metadata.requested||metadata.requested.from>c.from||metadata.requested.to<c.to||metadata.listedDate>c.from))throw Error(symbol+' 的快照或上市历史未覆盖整个研究区间；请补采或调整统一日期。');
  const data=resampleData(raw,c.timeframe),native=detectTimeframe(raw),nativeOpen=new Map(raw.map(r=>[executionTime(r,native),r]));
  for(let i=0;i<raw.length;i++){const r=raw[i];if(i&&r.date<=raw[i-1].date||['open','high','low','close'].some(k=>!Number.isFinite(r[k])||r[k]<=0)||!Number.isFinite(r.volume)||r.volume<0||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close))throw Error(symbol+' 行情排序、价格或成交量无效。');}
  const start=data.findIndex(r=>dayOf(r)>=c.from),end=data.findLastIndex(r=>dayOf(r)<=c.to);
  if(start<1||end<=start)throw Error(symbol+' 所选日期内行情或执行预热不足。');
  const warm=assessWarmup(Array.isArray(item.data)?raw:item.data,c,c.strategies.map(strategy=>({...c,strategy})));
  if(!warm.sufficient)throw Error(symbol+'：'+warmupMessage(warm));
  if(quality?.warnings.length)warnings.push(symbol+' 带量价警告（未修复）：'+quality.warnings.map(w=>w.message+'（'+w.count+'）').join('；'));
  const sessions=calendar.length?calendar:[...new Set(data.map(dayOf))],sessionIndex=new Map(sessions.map((d,i)=>[d,i]));
  return {symbol,name:metadata.name??symbol,snapshotId:item.snapshotId??null,board:metadata.board,quality,metadata,calendar:sessions,daily:new Map(daily.map(d=>[d.date,d])),actions,data,nativeOpen,native,start,end,warm,
   signals:combinationSignals(data,c,{calendar:sessions,daily}),ledger:new CorporateLedger(actions),inventory:new Inventory(),qty:0,mark:data[start-1].close,entry:null,peakSignal:0,pendingExit:null,lastExit:-Infinity,pending:null,realized:0,fees:0};
 }).sort((a,b)=>a.symbol.localeCompare(b.symbol));
 const synthetic=stocks.filter(s=>s.metadata.synthetic===true);if(synthetic.length&&synthetic.length!==stocks.length)throw Error('合成测试行情不能与真实股票混用。');
 const days=[...new Set(stocks.flatMap(s=>s.calendar.filter(d=>d>=c.from&&d<=c.to)))].sort();
 if(!days.length)throw Error('区间内没有交易日。');
 if(c.dataMode!=='demo')for(const s of stocks)if(days.some(d=>!s.calendar.includes(d)))throw Error(s.symbol+' 交易日历与其他标的不一致，请核对资料。');
 const events=new Map();function event(at,type,value){if(!events.has(at))events.set(at,{dayOpen:[],resolve:[],close:[],open:[],dayClose:[]});events.get(at)[type].push(value);}
 for(const day of days){event(day+' 09:30','dayOpen',day);event(day+' 15:00','dayClose',day);}
 for(const s of stocks)for(let i=s.start;i<=s.end;i++){const r=s.data[i],at=executionTime(r,c.timeframe),first=s.nativeOpen.get(at);if(!first)throw Error(s.symbol+' 缺少原生开盘区间：'+at);event(at,'open',{s,i,r,first});event(closeTime(first),'resolve',{s,i,r,first});event(closeTime(r),'close',{s,i,r});}
 let cash=c.capital,reservedCash=0,fees=0,peak=c.capital,maxHeld=0;
 const trades=[],closed=[],orderAttempts=[],curve=[],dailyCurve=[],corporateEvents=[],skipped={capacity:0,cash:0,limits:0,t1:0,st:0};
 const feeTotals={commission:0,stamp:0,handling:0,regulatory:0,transfer:0};
 const stockValue=s=>(s.qty+s.ledger.locked())*s.mark+s.ledger.receivable();
 const equity=()=>cash+stocks.reduce((n,s)=>n+stockValue(s),0);
 const heldCount=()=>stocks.filter(s=>s.qty+s.ledger.locked()>0||s.pending?.side==='买入').length;
 function finish(s,at){if(!s.entry||s.qty||s.ledger.outstanding()||s.ledger.futureEntitlements(at.slice(0,10)))return;
  const e=s.entry,pnl=e.proceeds+e.dividends-e.cost,wave={symbol:s.symbol,entry:e.date,exit:at,pnl,return:pnl/e.cost,days:(s.calendar.indexOf(at.slice(0,10))-e.session)};closed.push(wave);s.realized+=pnl;
  const sell=trades.findLast(t=>t.symbol===s.symbol&&t.side==='卖出');if(sell){sell.pnl=pnl;sell.settledAt=at;}s.entry=null;s.pendingExit=null;s.peakSignal=0;s.lastExit=s.calendar.indexOf(at.slice(0,10));
 }
 function point(at){const e=equity();peak=Math.max(peak,e);const p={date:at,equity:e,nav:e/c.capital,drawdown:e/peak-1,cash,reservedCash,positions:heldCount(),stockValue:stocks.reduce((n,s)=>n+(s.qty+s.ledger.locked())*s.mark,0),receivable:stocks.reduce((n,s)=>n+s.ledger.receivable(),0)};
  if(cash<-.001||reservedCash<-.001||reservedCash>cash+.001||heldCount()>c.maxHoldings)throw Error('组合资金预留或持仓上限核对失败。');maxHeld=Math.max(maxHeld,heldCount());curve.push(p);return p;
 }
 for(const [at,e]of [...events].sort((a,b)=>a[0].localeCompare(b[0]))){
  const day=at.slice(0,10);
  if(e.dayOpen.length)for(const s of stocks){const d=s.daily.get(day);if(d)s.mark=d.prev_close;const a=s.ledger.open(day,s.qty);cash+=a.cash;s.qty+=a.shares;s.inventory.release(a.shares,day);if(s.entry)s.entry.dividends+=a.cash;finish(s,at);}
  // Resolve previously submitted orders before any new opening decisions.
  // No current volume, high, low or close is used to select or size orders.
  for(const {s,first}of e.resolve){const o=s.pending;if(!o)continue;s.pending=null;if(o.side==='买入')reservedCash-=o.amount+o.fee;
   o.status=first.volume===0?'unfilled':'filled';o.resolvedAt=at;o.evidenceAvailableAt=closeTime(first);o.evidenceBar=first.date;
   if(o.status==='unfilled'){o.reason='原生开盘区间零成交；不改变现金、库存或费用';continue;}
   cash+=o.side==='买入'?-o.amount-o.fee:o.amount-o.fee;fees+=o.fee;s.fees+=o.fee;for(const k of Object.keys(feeTotals))feeTotals[k]+=o.feeBreakdown[k];
   const t={...o,date:o.executionTime,confirmationTime:at,reason:o.trigger,pnl:null};trades.push(t);
   if(o.side==='买入'){s.qty+=o.quantity;s.inventory.buy(o.quantity,day);s.entry={date:o.executionTime,session:s.calendar.indexOf(day),cost:o.amount+o.fee,signalPrice:o.signalFill,proceeds:0,dividends:0};s.peakSignal=o.signalFill;}
   else{s.inventory.sell(o.quantity,day);s.qty-=o.quantity;s.entry.proceeds+=o.amount-o.fee;finish(s,at);}
  }
  for(const {s,i,r}of e.close){s.mark=r.close;if(s.qty)s.peakSignal=Math.max(s.peakSignal,s.signals.ind.xs[i]);}
  if(e.dayClose.length)for(const s of stocks){const d=s.daily.get(day);if(d&&!e.close.some(x=>x.s===s))s.mark=d.close; s.ledger.record(day,s.qty+s.ledger.locked());for(const x of s.ledger.log.slice(s.logCursor??0))corporateEvents.push({...x,symbol:s.symbol});s.logCursor=s.ledger.log.length;finish(s,at);}
  if(e.close.length||e.dayClose.length){const p=point(at);if(e.dayClose.length)dailyCurve.push(p);}
  // Opens at a common timestamp are considered together. All opening prices
  // are known, so budget sizing cannot depend on future bars or input order.
  for(const {s,r}of e.open)s.mark=r.open;
  const budget=equity()*c.allocation/100/c.maxHoldings;
  for(const {s,i,r}of e.open.sort((a,b)=>a.s.symbol.localeCompare(b.s.symbol))){
   const sig=s.signals.at(i),swing=c.strategies.includes('swing');
   if(sig.signalTime>at||sig.dailySignalTime&&sig.dailySignalTime>at)throw Error('组合读取未来信号。');
   const exitStrategies=c.exitMode==='trend'&&swing?['swing']:c.strategies;
   let why=exitStrategies.filter(k=>sig.exit[k]).map(k=>strategyNames[k]+'离场').join('、');
   if(s.qty&&s.entry){const change=sig.signalPrice/s.entry.signalPrice-1;
    if(c.stop>0&&change<=-c.stop/100)why='前根收盘止损';if(c.take>0&&change>=c.take/100)why='前根收盘止盈';
    if(swing&&c.atrMult>0&&sig.atr!==null&&sig.signalPrice<=s.peakSignal-c.atrMult*sig.atr)why='ATR跟踪止损';
    if(r.isST===1)why='历史ST状态生效';if(c.scope==='hs300'&&r.isHS300!==1)why='历史沪深300调出';
    if(why)s.pendingExit=s.pendingExit??{reason:why,signalTime:sig.signalTime,dailySignalTime:sig.dailySignalTime};
   }
   const sell=s.qty>0&&!!s.pendingExit;
   const entry=entryDecision(sig.entry,c.strategies,c.entryMode),age=s.calendar.indexOf(day)-s.lastExit;
   const buy=s.qty===0&&!s.entry&&entry.matched&&age>(swing?c.cooldownDays:-1);
   if(!sell&&!buy)continue;
   const limits=knownLimits(r,r.prev_close??s.data[i-1].close,{...c,board:s.board}),{up,down,rule}=limits;
   if(buy&&(r.isST===1||c.scope==='hs300'&&(r.isHS300!==1||r.membershipFresh!==1))){skipped.st++;continue;}
   if(buy&&((r.listingSession!=null&&r.listingSession<=20)||r.specialSession===1||swing&&Math.abs(r.open/(r.prev_close??s.data[i-1].close)-1)>c.maxGap/100))continue;
   if(r.halted===1||(sell?r.open<=down+.001:r.open>=up-.001)){skipped.limits++;continue;}
   const available=s.inventory.available(day);if(sell&&!available){skipped.t1++;continue;}
   if(buy&&heldCount()>=c.maxHoldings){skipped.capacity++;continue;}
   const price=sell?Math.max(down,r.open*(1-c.slippage/10000)):Math.min(up,r.open*(1+c.slippage/10000));
   let n=sell?Math.min(s.qty,available,rule.maxOrder):buyQuantity(Math.max(0,Math.min(budget,cash-reservedCash)),price,rule);
   const feeConfig={...c,board:s.board};let f=orderFees(n*price,sell,feeConfig,day);
   if(buy)while(n>=rule.minBuy&&(n*price+f.total>cash-reservedCash+.000001||n*price+f.total>budget+.000001)){n-=rule.step;f=orderFees(n*price,false,feeConfig,day);}
   if(!n||buy&&n<rule.minBuy){skipped.cash++;continue;}
   const trigger=sell?s.pendingExit.reason:entry.strategies.map(k=>strategyNames[k]).join(c.entryMode==='all'?' + ':'、')+(c.entryMode==='all'?'共同确认':'触发入场（任一满足）');
   const o={id:'portfolio-order-'+(orderAttempts.length+1),symbol:s.symbol,side:sell?'卖出':'买入',quantity:n,amount:n*price,price,fee:f.total,feeBreakdown:f,trigger,submittedAt:at,executionTime:at,signalTime:sell?s.pendingExit.signalTime:sig.signalTime,dailySignalTime:swing?(sell?s.pendingExit.dailySignalTime:sig.dailySignalTime):null,signalFill:price*(r.signal_factor??(s.data[i-1].signal_close??s.data[i-1].close)/s.data[i-1].close),sellableBefore:available,status:'pending',...(sell?{}:{entryMode:c.entryMode,entryStrategies:entry.strategies}),confirmations:{...sig.entry}};
   s.pending=o;orderAttempts.push(o);if(buy)reservedCash+=o.amount+o.fee;maxHeld=Math.max(maxHeld,heldCount());
  }
 }
 if(stocks.some(s=>s.pending)||Math.abs(reservedCash)>.001)throw Error('组合期末仍有未解决订单。');
 const last=curve.at(-1),returns=dailyCurve.map((p,i)=>p.equity/(i?dailyCurve[i-1].equity:c.capital)-1),mean=returns.reduce((a,b)=>a+b,0)/returns.length,sd=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,returns.length-1));
 const contributions=stocks.map(s=>{const openPnl=s.entry?stockValue(s)+s.entry.proceeds+s.entry.dividends-s.entry.cost:0;return {symbol:s.symbol,name:s.name,snapshotId:s.snapshotId,quantity:s.qty,lockedQuantity:s.ledger.locked(),receivable:s.ledger.receivable(),price:s.mark,value:stockValue(s),realized:s.realized,unrealized:openPnl,pnl:s.realized+openPnl,fees:s.fees,closedTrades:closed.filter(t=>t.symbol===s.symbol).length};});
 const residual=last.equity-c.capital-contributions.reduce((n,s)=>n+s.pnl,0);if(Math.abs(residual)>.011)throw Error('组合收益贡献与资产核对失败。');
 if(synthetic.length)warnings.push('合成多标的演示，仅用于检查操作流程，不能证明真实收益。');
 if(c.scope==='single-security')warnings.push('自选股票池，未核验历史沪深300资格；事后选择股票会产生选择偏差。');
 if(c.entryMode==='all'&&c.strategies.includes('swing')&&(c.strategies.includes('rsi')||c.strategies.includes('boll')))warnings.push('突破趋势与超卖条件可能冲突，共同确认会显著减少入场；零交易不代表系统故障。');
 if(c.entryMode==='any')warnings.push('任一所选策略满足即可入场，不要求其他策略同时确认；交易频率和费用可能增加。退出条件独立生效，所选大波段的ATR、跳空与冷却风控仍适用。');
 if(stocks.some(s=>s.actions.some(a=>a.cashBasis==='gross')))warnings.push('股息按事件提供的税前金额入账，未计算个人持有期补税。');
 warnings.push('等额预算为当时净资产×总仓位上限÷最大持仓数；持仓上涨后可超过初始权重，不自动再平衡。资金不足或满仓时按证券代码顺序，未成交订单到原生区间结束才释放预留现金。');
 const wins=closed.filter(t=>t.pnl>0),losses=closed.filter(t=>t.pnl<0),total=last.nav-1;
 return {schemaVersion:1,kind:'portfolio',engineVersion:portfolioVersion,config:c,curve,dailyCurve,trades,closed,orderAttempts,corporateEvents,contributions,feeTotals,warnings,
  inputs:stocks.map(s=>({symbol:s.symbol,snapshotId:s.snapshotId,nativeTimeframe:s.native,bars:s.data.length,quality:s.quality,warmup:s.warm})),
  metrics:{total,annual:last.nav**(252/dailyCurve.length)-1,maxdd:curve.reduce((m,p)=>Math.min(m,p.drawdown),0),sharpe:sd?mean/sd*Math.sqrt(252):null,equity:last.equity,cash,fees,closedTrades:closed.length,winrate:closed.length?wins.length/closed.length:null,wilsonLower:wilson(wins.length,closed.length),profitFactor:losses.length?wins.reduce((n,t)=>n+t.pnl,0)/-losses.reduce((n,t)=>n+t.pnl,0):null,expectancy:closed.length?closed.reduce((n,t)=>n+t.pnl,0)/closed.length:null,maxHeld,positions:contributions.filter(s=>s.quantity+s.lockedQuantity>0).length,skipped},
  audit:{engineVersion:portfolioVersion,rulesVersion,accounting:{status:'passed',contributionResidual:residual},timingViolations:0,sharedCapital:true,sameBarRangeUsed:false,orderDecisionSameBarVolumeUsed:false,executionPolicy:'reserve at open; resolve after first native interval; failed buys release reserves; sale proceeds available only after resolution',priority:'ascending security code; no future return ranking',inventoryPolicy:'per-security FIFO T+1; bonus shares released on listing date',management:'equal entry slots; no add/T or automatic rebalance',entryMode:c.entryMode,selectionPolicy:(c.entryMode==='all'?'all selected entry conditions':'at least one selected entry condition')+'; configured exit mode '+c.exitMode+'; stop/take/ST/constituent exit override'},
  period:{from:c.from,to:c.to,tradingDays:dailyCurve.length,bars:curve.length}};
}
export function comparePortfolio(inputs,config={}){
 const result=portfolioBacktest(inputs,config),singleStrategy=portfolioBacktest(inputs,{...result.config,strategies:[result.config.strategies[0]]});
 const mode=entryModeNames[result.config.entryMode],rows=[{name:mode+' · 共享资金组合',metrics:result.metrics},{name:'首个策略 · 同股票池同资金',metrics:singleStrategy.metrics}];
 for(const input of [...inputs].sort((a,b)=>(a.symbol??a.data.metadata.symbol).localeCompare(b.symbol??b.data.metadata.symbol))){const r=portfolioBacktest([input],{...result.config,maxHoldings:1});rows.push({name:(input.symbol??input.data.metadata.symbol)+' · 单标的'+mode,metrics:r.metrics});}
 return {...result,comparison:{rows,selectionRule:'user specified stocks and strategies; no automatic selection from these results',basis:'same dates, capital, five fees, slippage and equal-slot engine; independent baseline accounts, never averaged into portfolio'},baselineCurve:singleStrategy.curve.map(p=>({date:p.date,nav:p.nav}))};
}
