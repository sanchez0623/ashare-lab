#!/usr/bin/env python3
"""Bulk/incremental raw A-share collector. Never substitutes empty/short responses
for a complete history. SQLite and response archives are local durable artifacts.
A private Site upload is optional; credentials are read ONLY from environment.
"""
import argparse, datetime as dt, hashlib, json, os, pathlib, sqlite3, sys, time
from concurrent.futures import ThreadPoolExecutor, TimeoutError

_BS=None
_GUARD=None
_CALENDAR=None

DATE=lambda x:str(x)[:10]
def encoded(x):return json.dumps(x,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()
def number(x,default=None):
    try:
        v=float(x);return v if v==v and abs(v)!=float('inf') else default
    except (ValueError,TypeError):return default

def retry(fn, attempts=3):
    for n in range(attempts):
        try:return fn()
        except Exception:
            if n+1==attempts:raise
            time.sleep(min(2**n,8))

def calendar_ak():
    import akshare as ak
    return [DATE(x) for x in retry(ak.tool_trade_date_hist_sina)['trade_date'].tolist()]

def akshare(symbol,board,provider,tf,start,end):
    import akshare as ak
    if tf not in ('5m','15m'):raise ValueError('免费适配器只采集真实5/15分钟，不拆分日线。')
    period=tf[:-1]
    if provider=='akshare-sina':
        if board=='bse':raise ValueError('该新浪接口未验证北交所支持，禁止按SH/SZ拼接。')
        prefix='sh' if symbol.startswith('6') else 'sz'
        frame=retry(lambda:ak.stock_zh_a_minute(symbol=prefix+symbol,period=period,adjust=''))
        bars=[{'date':str(r['day'])[:16],'open':number(r['open']),'high':number(r['high']),'low':number(r['low']),'close':number(r['close']),'volume':number(r['volume'])} for r in frame.to_dict('records')]
        raw={'minute':frame.to_json(orient='records',force_ascii=False)}
    else:
        frame=retry(lambda:ak.stock_zh_a_hist_min_em(symbol=symbol,period=period,start_date=start+' 09:00:00',end_date=end+' 15:30:00',adjust=''))
        bars=[{'date':str(r['时间'])[:16],'open':number(r['开盘']),'high':number(r['最高']),'low':number(r['最低']),'close':number(r['收盘']),'volume':number(r['成交量'])*100 if number(r['成交量']) is not None else None} for r in frame.to_dict('records')]
        raw={'minute':frame.to_json(orient='records',force_ascii=False)}
    bars=[r for r in bars if start<=DATE(r['date'])<=end]
    # A free minute endpoint does not supply historical opening ST status,
    # exchange ex-reference, or complete corporate-action entitlements.
    # Deliberately leave them absent instead of inferring from today's name.
    return {'bars':bars,'daily':[],'actions':[],'factors':[],'calendar':calendar_ak(),'raw':raw,'listedDate':None,'coverage':{}}

def bs_rows(rs):
    rows=[]
    while rs.error_code=='0' and rs.next():rows.append(dict(zip(rs.fields,rs.get_row_data())))
    if rs.error_code!='0':raise RuntimeError('BaoStock: '+rs.error_code+' '+rs.error_msg)
    return rows

def baostock(symbol,board,tf,start,end,history_start=None):
    history_start=history_start or start
    if board=='bse':raise ValueError('BaoStock适配器不支持北交所；需要包含北交所的授权数据源。')
    # SDK uses direct TCP. Do not attempt it in this managed environment unless
    # the network policy explicitly grants that destination.
    policy=pathlib.Path('/etc/codex/network-policy.json')
    if policy.exists():
        p=json.loads(policy.read_text());tcp=p.get('tcp_network_access',p.get('tcp',p.get('tcp_grants',{})))
        if not tcp or not (tcp.get('domains') or tcp.get('ip_ranges')):raise RuntimeError('当前执行环境未授权BaoStock TCP连接；请在允许其官方SDK联网的自有主机运行。无需API Token。')
    global _BS,_CALENDAR
    import baostock as bs
    if _BS is None:
        login=bs.login()
        if login.error_code!='0':raise RuntimeError('BaoStock登录失败：'+login.error_code)
        _BS=bs
    code=('sh.' if symbol.startswith('6') else 'sz.')+symbol
    try:
        basic=bs_rows(bs.query_stock_basic(code=code))
        if _CALENDAR is None:_CALENDAR=bs_rows(bs.query_trade_dates(start_date='1990-12-19',end_date=end))
        cal=_CALENDAR
        daily_raw=bs_rows(bs.query_history_k_data_plus(code,'date,code,open,high,low,close,preclose,volume,amount,tradestatus,isST',start_date=history_start,end_date=end,frequency='d',adjustflag='3'))
        minute_raw=bs_rows(bs.query_history_k_data_plus(code,'date,time,code,open,high,low,close,volume,amount,adjustflag',start_date=start,end_date=end,frequency=tf[:-1],adjustflag='3'))
        fac=bs_rows(bs.query_adjust_factor(code,start_date=history_start,end_date=end))
        dividends=[]
        for year in range(int(history_start[:4])-1,int(end[:4])+1):dividends+=bs_rows(bs.query_dividend_data(code,year=str(year),yearType='operate'))
    finally:pass
    daily=[];factor=1;prev=None
    for r in daily_raw:
        price=number(r['close']);ref=number(r['preclose']);halted=0 if r['tradestatus']=='1' else 1
        if prev and ref and not halted:factor*=prev/ref
        daily.append({'date':r['date'],'open':number(r['open']),'high':number(r['high']),'low':number(r['low']),'close':price,'prev_close':ref,'volume':number(r['volume']),'isST':int(r['isST']) if r['isST'] in ('0','1') else None,'halted':halted,'knownAt':r['date']+' 09:00','causalFactor':factor})
        if not halted:prev=price
    dm={r['date']:r for r in daily};bars=[]
    for r in minute_raw:
        t=r['time'];date=r['date']+' '+t[8:10]+':'+t[10:12]
        if t[12:14]!='00':raise ValueError('分钟时间戳出现非零秒，需要人工核对时间口径。')
        bars.append({'date':date,**{k:number(r[k]) for k in ('open','high','low','close','volume')},'halted':dm.get(r['date'],{}).get('halted')})
    actions=[]
    for i,r in enumerate(dividends):
        ex=r.get('dividOperateDate','');cash=number(r.get('dividCashPsBeforeTax'),0);bonus=number(r.get('dividStocksPs'),0)+number(r.get('dividReserveToStockPs'),0)
        if not ex or not (cash or bonus):continue
        actions.append({'id':f'{symbol}-{ex}-{i}','type':'dividend','announcementTime':r.get('dividPlanDate','')+' 00:00','recordDate':r.get('dividRegistDate'),'exDate':ex,'payDate':r.get('dividPayDate'),'shareListDate':r.get('dividStockMarketDate'),'cashPerShare':cash,'bonusPerShare':bonus,'cashBasis':'gross','referencePrice':dm.get(ex,{}).get('prev_close')})
    cov={k:{'status':'complete','from':history_start,'to':end,'source':'baostock'} for k in ('calendar','daily','factors')}
    # Coverage is subject to independent reconciliation: every factor/ex-reference
    # change must map to a fully specified cash/bonus event and its economics.
    # Rights and unknown transformations fail formal admission, never get ignored.
    cov['actions']={'status':'complete','from':history_start,'to':end,'source':'baostock dividends + all factor events + exchange ex-reference reconciliation; unresolved events blocked by audit'}
    return {'bars':bars,'daily':daily,'calendar':[r['calendar_date'] for r in cal if r['is_trading_day']=='1'],'actions':actions,'factors':fac,'listedDate':basic[0].get('ipoDate') if basic else None,'coverage':cov,'raw':{'daily':daily_raw,'minute':minute_raw,'dividends':dividends,'factors':fac,'basic':basic,'calendar':cal}}

def lixinger_daily(symbol,start,end,price_type='ex_rights'):
    import requests
    token=os.environ.get('LIXINGER_TOKEN')
    if not token:raise RuntimeError('缺少环境变量LIXINGER_TOKEN及相应日线API权限；不要将Token写入数据包。')
    # Official endpoint is DAILY only. Never market it as a verified minute feed.
    payload={'token':token,'stockCode':symbol,'type':price_type,'startDate':start,'endDate':end}
    r=retry(lambda:requests.post('https://open.lixinger.com/api/cn/company/candlestick',json=payload,timeout=45))
    if not r.ok:raise RuntimeError('理杏仁日线接口HTTP '+str(r.status_code))
    v=r.json()
    if v.get('code')!=1:raise RuntimeError('理杏仁日线接口未成功，检查权限/额度/参数（不输出响应以免泄露Token）。')
    return v.get('data',[])

def db_open(path):
    db=sqlite3.connect(path);db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS bars(source TEXT,symbol TEXT,tf TEXT,date TEXT,payload TEXT,PRIMARY KEY(source,symbol,tf,date))')
    db.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,started TEXT,finished TEXT,status TEXT,summary TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS conflicts(source TEXT,symbol TEXT,tf TEXT,date TEXT,old TEXT,new TEXT,job TEXT,PRIMARY KEY(source,symbol,tf,date,new))')
    return db

def merge_bars(db,provider,symbol,tf,bars,job):
    duplicates=[];seen={}
    with db:
        for r in bars:
            if r['date'] in seen:
                duplicates.append(r['date']);continue
            seen[r['date']]=r;payload=encoded(r).decode()
            old=db.execute('SELECT payload FROM bars WHERE source=? AND symbol=? AND tf=? AND date=?',(provider,symbol,tf,r['date'])).fetchone()
            if old and json.loads(old[0])!=r:db.execute('INSERT OR IGNORE INTO conflicts VALUES(?,?,?,?,?,?,?)',(provider,symbol,tf,r['date'],old[0],payload,job))
            elif not old:db.execute('INSERT INTO bars VALUES(?,?,?,?,?)',(provider,symbol,tf,r['date'],payload))
    return duplicates

def upload(bundle,site):
    import requests
    token=os.environ.get('SITES_SERVICE_TOKEN')
    if not token:raise RuntimeError('上传需要自有私有站点的SITES_SERVICE_TOKEN环境变量；不会将凭据保存到文件。')
    # Prevent accidental credential forwarding to an arbitrary remote host.
    from urllib.parse import urlparse
    u=urlparse(site)
    if u.scheme!='https' or u.hostname!='ashare-quant-lab.sanchez-zou0623.chatgpt.site' or u.path not in ('','/'):raise ValueError('站点地址必须是指定私有Site的HTTPS根地址。')
    r=retry(lambda:requests.post(site.rstrip('/')+'/api/data/ingest',data=encoded(bundle),headers={'Content-Type':'application/json','OAI-Sites-Authorization':'Bearer '+token},timeout=90))
    if not r.ok:raise RuntimeError('仓库上传失败：HTTP '+str(r.status_code))
    return r.json()

def sync_one(args,symbol,board):
    root=pathlib.Path(args.store);root.mkdir(parents=True,exist_ok=True);(root/'raw').mkdir(exist_ok=True);(root/'output').mkdir(exist_ok=True)
    db=db_open(root/'market.sqlite');started=dt.datetime.now(dt.timezone.utc).isoformat();job=hashlib.sha256((started+symbol+args.provider).encode()).hexdigest()[:24]
    with db:db.execute('INSERT INTO jobs VALUES(?,?,NULL,?,?)',(job,started,'running','{}'))
    try:
        start=args.start
        if args.incremental:
            latest=db.execute('SELECT MAX(date) FROM bars WHERE source=? AND symbol=? AND tf=?',(args.provider,symbol,args.timeframe)).fetchone()[0]
            if latest:start=max(start,(dt.date.fromisoformat(DATE(latest))-dt.timedelta(days=7)).isoformat())
        result=baostock(symbol,board,args.timeframe,start,args.end,args.start) if args.provider=='baostock' else akshare(symbol,board,args.provider,args.timeframe,start,args.end)
        raw_bytes=encoded(result['raw']);raw_hash=hashlib.sha256(raw_bytes).hexdigest();(root/'raw'/f'{raw_hash}.json').write_bytes(raw_bytes)
        duplicates=merge_bars(db,args.provider,symbol,args.timeframe,result['bars'],job)
        bars=[json.loads(r[0]) for r in db.execute('SELECT payload FROM bars WHERE source=? AND symbol=? AND tf=? AND date>=? AND date<? ORDER BY date',(args.provider,symbol,args.timeframe,args.start,args.end+' 23:59'))]
        conflicts=[{'date':r[0],'status':'unresolved','job':r[1]} for r in db.execute('SELECT date,job FROM conflicts WHERE source=? AND symbol=? AND tf=? AND date>=? AND date<?',(args.provider,symbol,args.timeframe,args.start,args.end+' 23:59'))]
        metadata={'symbol':symbol,'board':board,'source':args.provider,'timeframe':args.timeframe,'listedDate':result['listedDate'],'requested':{'from':args.start,'to':args.end},'timezone':'Asia/Shanghai','timestampConvention':'bar-close','priceBasis':'raw','volumeUnit':'shares','syncedAt':started,'rawResponseSHA256':raw_hash,'syncMode':'incremental-7-day-overlap' if args.incremental else 'bulk','coverage':result['coverage'],'conflicts':conflicts,'providerDuplicates':duplicates,'scheduleStatus':'not-enabled'}
        metadata['coverage']['calendar']={'status':'complete','from':args.start,'to':args.end,'source':'baostock' if args.provider=='baostock' else 'akshare/sina trade calendar'}
        bundle={'schemaVersion':1,'metadata':metadata,'bars':bars,'calendar':result['calendar'],'daily':result['daily'],'actions':result['actions'],'factors':result['factors']}
        if getattr(args,'universe',None):
            bundle['universe']=args.universe
            metadata['universe']='HS300'
            metadata['universePolicy']='weekly-asof-next-session'
            metadata['coverage']['universe']={'status':'complete','from':args.start,'to':args.end,'source':'baostock weekly query-date snapshots'}
        # Supplemental data must have independent provenance and may fill historical
        # ST/actions/limits, never overwrite raw prices or claim minute coverage.
        if args.supplement:
            supplement=json.loads(pathlib.Path(args.supplement).read_text())
            if supplement.get('symbol')!=symbol:raise ValueError('补充资料证券代码不匹配')
            for key in ('daily','actions','factors','universe'):
                if key in supplement:bundle[key]=supplement[key]
            metadata.update({k:supplement[k] for k in ('listedDate','listingSessionOffset','delistedDate') if k in supplement})
            metadata['coverage'].update(supplement.get('coverage',{}))
        path=root/'output'/f'{symbol}-{args.timeframe}-{job}.json';path.write_bytes(encoded(bundle))
        summary={'job':job,'symbol':symbol,'provider':args.provider,'bars':len(bars),'actualFrom':bars[0]['date'] if bars else None,'actualTo':bars[-1]['date'] if bars else None,'conflicts':len(conflicts),'duplicates':len(duplicates),'requested':metadata['requested'],'output':str(path),'formalReadiness':'pending server audit; HTTP success does not imply completeness'}
        if args.site:summary['warehouse']=upload(bundle,args.site)
        with db:db.execute('UPDATE jobs SET finished=?,status=?,summary=? WHERE id=?',(dt.datetime.now(dt.timezone.utc).isoformat(),'collected',encoded(summary).decode(),job))
        print(json.dumps(summary,ensure_ascii=False),flush=True)
    except Exception as e:
        # Do not emit remote response bodies, source tokens or credential-bearing URLs.
        message=str(e)
        for env in ('LIXINGER_TOKEN','SITES_SERVICE_TOKEN'):
            if os.environ.get(env):message=message.replace(os.environ[env],'[redacted]')
        with db:db.execute('UPDATE jobs SET finished=?,status=?,summary=? WHERE id=?',(dt.datetime.now(dt.timezone.utc).isoformat(),'failed',json.dumps({'error':message}),job))
        raise RuntimeError(message) from None
    finally:db.close()

def main():
    import requests,fcntl
    original_request=requests.sessions.Session.request
    def bounded_request(self,*args,**kwargs):
        if not kwargs.get('timeout'):kwargs['timeout']=45
        return original_request(self,*args,**kwargs)
    requests.sessions.Session.request=bounded_request
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--provider',choices=['akshare-sina','akshare-em','baostock'],default='akshare-sina');p.add_argument('--symbols',help='六位代码，逗号分隔');p.add_argument('--board',choices=['main','chinext','star','bse']);p.add_argument('--pool',help='JSON: [{"symbol":"600519","board":"main"}]，保留历史证券身份');p.add_argument('--from',dest='start',required=True);p.add_argument('--to',dest='end',required=True);p.add_argument('--timeframe',choices=['5m','15m'],default='5m');p.add_argument('--store',default='collector/store');p.add_argument('--incremental',action='store_true');p.add_argument('--supplement');p.add_argument('--site');p.add_argument('--hs300-history',action='store_true',help='逐查询日缓存沪深300历史快照，并仅采集范围内曾属于指数的证券');p.add_argument('--bs-budget',type=int,default=10000);p.add_argument('--lixinger-daily',action='store_true',help='单独拉取理杏仁日线作辅助资料，不冒充分钟或完整ST/公司行动')
    a=p.parse_args();dt.date.fromisoformat(a.start);dt.date.fromisoformat(a.end)
    if a.start>a.end:p.error('开始日期晚于结束日期')
    pool=json.loads(pathlib.Path(a.pool).read_text()) if a.pool else [{'symbol':x,'board':a.board} for x in (a.symbols or '').split(',') if x]
    if not pool and not a.hs300_history:p.error('指定--pool或--symbols和--board')
    root=pathlib.Path(a.store);root.mkdir(parents=True,exist_ok=True)
    lock=open(root/'.sync.lock','a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise RuntimeError('同步任务已在运行，本次跳过以免重叠写入。')
    global _GUARD,_BS
    restore=None;universe=None
    if a.provider=='baostock':
        from baostock_guard import TrafficGuard,install
        _GUARD=TrafficGuard(limit=a.bs_budget);restore=install(_GUARD)
    if a.hs300_history:
        if a.provider!='baostock':p.error('历史沪深300成分采集请使用BaoStock；免费分钟仅作辅助')
        # Check network policy before login, without testing unauthorized TCP.
        policy=pathlib.Path('/etc/codex/network-policy.json')
        if policy.exists() and not any(json.loads(policy.read_text()).get('tcp_network_access',{}).values()):raise RuntimeError('当前环境未授权BaoStock TCP；在允许官方SDK联网的主机运行。')
        import baostock as bs
        from hs300 import fetch
        lg=bs.login()
        if lg.error_code!='0':raise RuntimeError('BaoStock登录失败：'+lg.error_code)
        _BS=bs;cal=bs_rows(bs.query_trade_dates(start_date=a.start,end_date=a.end));dates=[r['calendar_date'] for r in cal if r['is_trading_day']=='1']
        universe=fetch(bs,dates,root/'universe-cache')
        codes={x for snapshot in universe for x in snapshot['codes']}
        if not pool:
            pool=[{'symbol':code[3:],'board':'star' if code.startswith('sh.688') else 'chinext' if code.startswith(('sz.300','sz.301')) else 'main'} for code in sorted(codes)]
        pool=[x for x in pool if ('sh.' if x['symbol'].startswith('6') else 'sz.')+x['symbol'] in codes]
        (root/'hs300-history.json').write_bytes(encoded(universe))
    a.universe=universe
    failures=0
    for item in pool:
        if len(item['symbol'])!=6 or not item['symbol'].isdigit() or item['board'] not in ('main','chinext','star','bse'):p.error('证券代码或显式板块无效')
        try:
            if a.lixinger_daily:
                path=pathlib.Path(a.store)/'output';path.mkdir(parents=True,exist_ok=True);v=lixinger_daily(item['symbol'],a.start,a.end);(path/(item['symbol']+'-lixinger-daily.json')).write_bytes(encoded(v));print(json.dumps({'symbol':item['symbol'],'dailyRows':len(v),'minuteFeed':False}))
            else:sync_one(a,item['symbol'],item['board'])
        except Exception as e:
            failures+=1;print(json.dumps({'symbol':item['symbol'],'error':str(e)},ensure_ascii=False),file=sys.stderr,flush=True)
            if '黑名单' in str(e) or '预算' in str(e):break
    if _BS is not None:
        try:_BS.logout()
        except RuntimeError:
            import baostock.common.context as context
            if getattr(context,'default_socket',None):context.default_socket.close()
        _BS=None
    if restore:restore()
    if _GUARD:_GUARD.close()
    return 1 if failures else 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False),file=sys.stderr);sys.exit(1)
