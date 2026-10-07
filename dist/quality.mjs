import {slots,dayOf,detectTimeframe} from './data.mjs';
import {boardNames} from './rules.mjs';
const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export function auditBundle(b,{scope='hs300'}={}){
  if(!['hs300','single-security'].includes(scope))throw Error('数据校验范围无效。');
  const issues=[],add=(code,message,count=1,samples=[])=>issues.push({code,message,count,samples:samples.slice(0,15)});
  if(!b||b.schemaVersion!==1||!Array.isArray(b.bars))throw Error('需要 schemaVersion=1 的完整数据包。');
  const bars=b.bars,m=b.metadata??{},range=m.requested??{},daily=b.daily??[],calendar=b.calendar??[],actions=b.actions??[];
  if(!bars.length)add('EMPTY','没有行情');
  if(!boardNames[m.board])add('BOARD','缺少显式历史板块');
  if(!/^[0-9]{6}$/.test(m.symbol??''))add('SYMBOL','证券代码应为六位数字');
  if(!validDate(range.from)||!validDate(range.to)||range.from>range.to)add('RANGE','缺少有效请求区间（包括预热历史）');
  if(!validDate(m.listedDate))add('LISTED','缺少上市日期，无法判定上市初期限价');
  if(!['1d','5m','15m'].includes(m.timeframe))add('PERIOD','数据包周期无效');
  if(m.priceBasis!=='raw'||m.volumeUnit!=='shares'||m.timezone!=='Asia/Shanghai'||m.timestampConvention!=='bar-close')add('CONVENTION','必须为原始价格、股单位、北京时间、K线结束时间');
  for(const [key,label] of [['calendar','交易日历'],['daily','逐日行情/ST/停牌'],['actions','公司行动'],['factors','复权因子']]){
    const p=m.coverage?.[key];if(!p||p.status!=='complete'||!validDate(p.from)||!validDate(p.to)||p.from>range.from||p.to<range.to||!p.source)add('PROOF_'+key.toUpperCase(),label+'覆盖未被数据源确认');
  }
  if(m.listedDate&&calendar.length&&!calendar.includes(m.listedDate)&&!Number.isInteger(m.listingSessionOffset))add('LISTING_AGE','交易日历未覆盖上市日，且缺少上市交易日偏移');
  if(!calendar.length||new Set(calendar).size!==calendar.length||calendar.some((d,i)=>!validDate(d)||i&&d<=calendar[i-1]))add('CALENDAR','交易日历为空、重复或未排序');
  const seen=new Set(),grid=new Set(slots(m.timeframe==='15m'?15:5));let bad=0,dups=0,unordered=0;
  const byDay=new Map();
  for(let i=0;i<bars.length;i++){
    const r=bars[i],day=typeof r.date==='string'?dayOf(r):'';
    if(seen.has(r.date))dups++;seen.add(r.date);if(i&&r.date<=bars[i-1].date)unordered++;
    if(!validDate(day)||m.timeframe==='1d'&&r.date!==day||m.timeframe!=='1d'&&(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.date)||!grid.has(r.date.slice(11)))||['open','high','low','close'].some(k=>!Number.isFinite(r[k])||r[k]<=0)||!Number.isFinite(r.volume)||r.volume<0||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.low>r.high)bad++;
    if(!byDay.has(day))byDay.set(day,[]);byDay.get(day).push(r);
  }
  if(bad)add('BAR_INVALID','无效价格、时间或分钟网格',bad);if(dups)add('DUPLICATES','重复时间',dups);if(unordered)add('ORDER','行情未严格递增',unordered);
  const dm=new Map(daily.map(d=>[d.date,d]));if(dm.size!==daily.length)add('DAILY_DUPLICATES','逐日元数据重复');
  const sessions=calendar.filter(d=>d>=range.from&&d<=range.to&&(!m.listedDate||d>=m.listedDate)&&(!m.delistedDate||d<=m.delistedDate));
  const missing=[],short=[],st=[],halts=[],references=[],mismatch=[],extremes=[],factors=[];let completeSessions=0,suspendedSessions=0;
  for(const day of sessions){
    const d=dm.get(day),rows=byDay.get(day)??[];
    if(!d){missing.push(day);const n=m.timeframe==='1d'?1:grid.size;if(rows.length&&rows.length!==n)short.push(day);continue;}
    if(![0,1].includes(d.isST)||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.knownAt??'')||d.knownAt>day+' 09:30')st.push(day);
    if(![0,1].includes(d.halted))halts.push(day);
    if(d.specialSession===1&&(!Number.isFinite(d.limit_up)||!Number.isFinite(d.limit_down))&&d.noLimit!==1)add('SPECIAL_LIMITS','特殊交易日缺少交易所实际限价/无限价证明',1,[day]);
    if(!Number.isFinite(d.prev_close)||d.prev_close<=0)references.push(day);
    if(!Number.isFinite(d.causalFactor)||d.causalFactor<=0)factors.push(day);
    if(d.halted===1){suspendedSessions++;if(rows.some(r=>r.halted!==1||r.volume!==0))halts.push(day);continue;}
    const n=m.timeframe==='1d'?1:grid.size;
    if(!rows.length)missing.push(day);else if(rows.length!==n||m.timeframe!=='1d'&&rows.some((r,i)=>r.date.slice(11)!==[...grid][i]))short.push(day);else completeSessions++;
    if(!Number.isFinite(d.close)||d.close<=0||rows.length&&Math.abs(rows.at(-1).close-d.close)>0.011)mismatch.push(day);
    if(d.volume!==undefined&&rows.length===n&&Math.abs(rows.reduce((s,r)=>s+r.volume,0)-d.volume)>Math.max(100,d.volume*.005))mismatch.push(day+' 成交量');
    if(rows.length===n){for(const [field,value,label] of [['open',rows[0].open,'开盘价'],['high',Math.max(...rows.map(r=>r.high)),'最高价'],['low',Math.min(...rows.map(r=>r.low)),'最低价']])if(Number.isFinite(d[field])&&Math.abs(value-d[field])>.011)extremes.push(day+' '+label);}
  }
  for(const [code,label,xs] of [['MISSING_DAYS','缺失整个交易日或逐日资料',missing],['MINUTE_GAPS','分钟根数/网格不完整',short],['ST_HISTORY','缺少开盘已知的历史 ST 状态',st],['HALT_HISTORY','停牌状态缺失或冲突',halts],['REFERENCE','缺少交易所当日昨收/除权参考价',references],['CAUSAL_FACTOR','缺少事件生效当日的连续因子',factors],['DAILY_CROSSCHECK','分钟与独立日线校验不符',mismatch]])if(xs.length)add(code,label,xs.length,xs);
  if(extremes.length)add('DAILY_OHLC_CROSSCHECK','分钟与独立日线开高低价校验不符',extremes.length,extremes);
  if(!sessions.length)add('SESSIONS','请求区间没有有效交易日');
  const outOfScope=bars.filter(r=>dayOf(r)<range.from||dayOf(r)>range.to);if(outOfScope.length)add('OUTSIDE_AUDIT','行情超出已声明审计区间；不得使用未经审计的预热数据',outOfScope.length);
  const calendarSet=new Set(calendar);const extras=[...byDay.keys()].filter(d=>d>=range.from&&d<=range.to&&!calendarSet.has(d));if(extras.length)add('NON_SESSION','非交易日出现行情',extras.length,extras);
  if(m.providerDuplicates?.length)add('PROVIDER_DUPLICATES','采集源返回重复时间，需核实并重新采集',m.providerDuplicates.length,m.providerDuplicates);
  if(m.conflicts?.length)add('SOURCE_CONFLICT','增量重叠区间存在未裁决的数据修订',m.conflicts.length,m.conflicts.map(x=>x.date??x));
  if(scope==='hs300'){
  const universe=b.universe??[],um=new Map(universe.map(x=>[x.date,x]));
  if(m.universe!=='HS300')add('UNIVERSE_SCOPE','正式研究限定历史沪深300股票池');
  const uc=m.coverage?.universe;if(!uc||uc.status!=='complete'||!validDate(uc.from)||!validDate(uc.to)||uc.from>range.from||uc.to<range.to||!uc.source)add('UNIVERSE_COVERAGE','缺少按查询日期留存的沪深300成分覆盖');
  const universeGaps=[];for(const day of sessions){const u=um.get(day);if(!u||!validDate(u.updateDate)||u.updateDate>day||!u.knownAt||u.knownAt>day+' 15:00'||!Array.isArray(u.codes)||u.codes.length!==300||new Set(u.codes).size!==300)universeGaps.push(day);}
  if(universeGaps.length)add('UNIVERSE_HISTORY','成分股快照缺失、非300只或含未来更新',universeGaps.length,universeGaps);
  if(um.size!==universe.length)add('UNIVERSE_DUPLICATES','成分股查询日期重复');
  }
  const actionIds=new Set();
  for(const a of actions){
    if(actionIds.has(a.id)||!a.id){add('ACTION_ID','公司行动缺少唯一编号');continue;}actionIds.add(a.id);
    if(a.type==='rights'||a.rightsPerShare>0){add('RIGHTS','配股需要认购、资金与股份上市明细；本版阻止该区间正式回测，避免默认外部注资',1,[a.exDate]);continue;}
    if(!validDate(a.recordDate)||!validDate(a.exDate)||a.recordDate>=a.exDate||!a.announcementTime||a.announcementTime>a.recordDate+' 15:00'||!Number.isFinite(a.referencePrice)||a.referencePrice<=0||!Number.isFinite(a.cashPerShare??0)||(a.cashPerShare??0)<0||!Number.isFinite(a.bonusPerShare??0)||(a.bonusPerShare??0)<0||(a.cashPerShare>0&&(!validDate(a.payDate)||a.payDate<a.exDate))||(a.bonusPerShare>0&&(!validDate(a.shareListDate)||a.shareListDate<a.exDate)))add('ACTION_FIELDS','分红送转事件缺少公告、登记、除权、到账/上市日期或除权参考价',1,[a.id]);
    if(a.cashPerShare>0&&!['gross','net'].includes(a.cashBasis))add('DIVIDEND_TAX','缺少股息税前/税后口径',1,[a.id]);
    const d=dm.get(a.exDate);const record=dm.get(a.recordDate),theoretical=record?(record.close-(a.cashPerShare??0))/(1+(a.bonusPerShare??0)):null;if(record&&Math.abs(theoretical-a.referencePrice)>.011)add('ACTION_ECONOMICS','除权参考价与现金/送转比例不符，可能漏报配股或其他行动',1,[a.id]);
    if(d&&Math.abs(d.prev_close-a.referencePrice)>.011)add('EX_REFERENCE','公司行动与日线除权参考价冲突',1,[a.id]);
  }
  // Causal chain: a factor can change only on an accounted ex-date. Future factors
  // never rescale earlier history; daily close is consumed only after its own close.
  const accounted=new Set(actions.map(a=>a.exDate));
  let sourceBase=null;for(const f of [...(b.factors??[])].sort((a,b)=>(a.dividOperateDate??a.exDate??'').localeCompare(b.dividOperateDate??b.exDate??''))){const date=f.dividOperateDate??f.exDate;const value=Number(f.backAdjustFactor),d=dm.get(date);if(f.backAdjustFactor!==undefined){if(!Number.isFinite(value)||value<=0)add('SOURCE_FACTOR','供应商后复权因子无效',1,[date]);else if(d){if(!sourceBase)sourceBase={value,causal:d.causalFactor};else if(Math.abs(value/sourceBase.value-d.causalFactor/sourceBase.causal)>Math.max(1e-5,value/sourceBase.value*.00002))add('SOURCE_FACTOR_CHAIN','供应商后复权因子相对变化与交易所参考价链不符',1,[date]);}}
    if(date>=range.from&&date<=range.to&&!accounted.has(date))add('FACTOR_WITHOUT_EVENT','供应商复权事件没有完整权益账务明细',1,[date]);}
  let prev;
  for(const d of daily.filter(x=>x.date>=range.from&&x.date<=range.to).sort((a,b)=>a.date.localeCompare(b.date))){
    if(prev&&d.halted!==1&&prev.close>0&&d.prev_close>0){const ratio=prev.close/d.prev_close,expected=prev.causalFactor*ratio;
      if(Math.abs(d.causalFactor-expected)>Math.max(1e-6,expected*.000001))add('FACTOR_CHAIN','复权因子与当日除权参考价链不符',1,[d.date]);
      if(Math.abs(ratio-1)>.000001&&!accounted.has(d.date))add('UNACCOUNTED_ACTION','除权参考价变化没有对应公司行动',1,[d.date]);
    }if(d.halted!==1)prev=d;
  }
  const failed=issues.reduce((s,i)=>s+i.count,0);
  return {version:'3.2',scope,membershipChecked:scope==='hs300',status:failed?'blocked':'passed',label:failed?(scope==='single-security'?'不可单标的回测':'不可正式回测'):m.synthetic?'合成数据包 · 结构校验通过':scope==='single-security'?'单标的数据校验通过 · 未核验沪深300成员':'结构与覆盖校验通过',issues,requested:range,actual:{from:bars[0]?.date??null,to:bars.at(-1)?.date??null,bars:bars.length},sessions:sessions.length,completeSessions,suspendedSessions,warning:'校验只证明所声明数据源内的结构与覆盖；不能证明供应商从未漏报、历史可得性或股票池无幸存者偏差。'+(scope==='single-security'?' 当前仅研究指定证券，不要求也不证明历史沪深300成员资格。':'')};
}
export function prepareBundle(b,{strict=true,scope='hs300'}={}){
  const report=auditBundle(b,{scope});if(strict&&report.status!=='passed')throw Error('数据准入失败：'+report.issues.slice(0,4).map(x=>x.message+'（'+x.count+'）').join('；'));
  const dm=new Map((b.daily??[]).map(d=>[d.date,d])),um=new Map((b.universe??[]).map(u=>[u.date,u]));
  const code=(b.metadata.symbol?.startsWith('6')?'sh.':'sz.')+b.metadata.symbol;
  const listingCalendar=b.calendar??[],listingSessions=new Map();let age=b.metadata.listingSessionOffset??0;for(const d of listingCalendar)if(d>=b.metadata.listedDate)listingSessions.set(d,++age);
  let latestKnown=null;const memberByDay=new Map();for(const day of listingCalendar){const u=um.get(day);if(u&&u.knownAt<=day+' 09:30')latestKnown=u;memberByDay.set(day,{member:latestKnown?.codes.includes(code)?1:0,fresh:u&&u.knownAt<=day+' 09:30'?1:0});if(u&&u.knownAt<=day+' 15:00')latestKnown=u;}
  const bars=b.bars.map(r=>{const d=dm.get(dayOf(r)),factor=d?.causalFactor??1;return {...r,board:b.metadata.board,listedDate:b.metadata.listedDate,listingSession:listingSessions.get(dayOf(r)),isST:d?.isST,isHS300:memberByDay.get(dayOf(r))?.member??0,membershipFresh:memberByDay.get(dayOf(r))?.fresh??0,halted:d?.halted??r.halted,prev_close:d?.prev_close??r.prev_close,noLimit:d?.noLimit,specialSession:d?.specialSession,limit_up:d?.limit_up,limit_down:d?.limit_down,signal_factor:factor,signal_close:r.close*factor};});
  return {bars,report,actions:b.actions??[],metadata:b.metadata,calendar:b.calendar,daily:b.daily};
}
