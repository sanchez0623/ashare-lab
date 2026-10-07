#!/usr/bin/env python3
"""Single-stock native-5m collection with verified, atomic query checkpoints.
Only completed SDK responses (including every pagination send) are checkpointed.
No synthetic data or alternative IP/proxy route is used on a network failure.
"""
import argparse, datetime as dt, hashlib, json, os, pathlib, sys, tempfile, time
from sync import bs_rows, normalize_baostock, db_open, merge_bars
from locking import FileLock
from sources import BaoStockSource

VERSION='research-collector-1'
def encode(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':')).encode('utf-8')
def sha(body):return hashlib.sha256(body).hexdigest()
def atomic(path,body):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=path.name+'.tmp-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(body);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
class Blocked(RuntimeError):
    def __init__(self,code,message):super().__init__(message);self.code=code
class Checkpoints:
    def __init__(self,root,emit=lambda x:None,check=lambda:None,traffic=lambda:(0,0)):
        self.root=pathlib.Path(root);self.emit=emit;self.check=check;self.proofs={};self.traffic=traffic
    def query(self,key,fn):
        self.check();identity={'version':VERSION,'query':key};name=sha(encode(identity));path=self.root/(name+'.json')
        started=time.perf_counter();before=self.traffic();cached=path.exists()
        self.emit({'stage':'collect','phase':'query-start','query':key,'cached':cached,'checkpoints':len(self.proofs)})
        try:return self._query(key,fn,identity,name,path,started,before)
        except Exception as e:
            requests,wait=self.traffic()
            self.emit({'stage':'collect','phase':'query-error','query':key,'cached':cached,'queryElapsedMs':round((time.perf_counter()-started)*1000),'requests':requests-before[0],'rateWaitMs':round(wait-before[1]),'checkpoints':len(self.proofs),'error':str(e)})
            raise
    def _query(self,key,fn,identity,name,path,started,before):
        if path.exists():
            try:
                envelope=json.loads(path.read_bytes());body=encode(envelope['rows'])
                if envelope['identity']!=identity or sha(body)!=envelope['sha256']:raise ValueError()
                rows=envelope['rows']
            except (ValueError,KeyError):raise Blocked('CACHE_HASH','采集断点哈希不一致，拒绝继续：'+name) from None
            cached=True
        else:
            rows=fn();self.check();body=encode(rows)
            atomic(path,encode({'identity':identity,'sha256':sha(body),'rows':rows}));cached=False
        self.proofs[name]={'query':key,'sha256':sha(body),'rows':len(rows)}
        requests,wait=self.traffic()
        self.emit({'stage':'collect','phase':'query-complete','query':key,'rows':len(rows),'cached':cached,'checkpoints':len(self.proofs),'queryElapsedMs':round((time.perf_counter()-started)*1000),'requests':requests-before[0],'rateWaitMs':round(wait-before[1])})
        return rows
def network_check():
    policy=pathlib.Path('/etc/codex/network-policy.json')
    if policy.exists():
        tcp=json.loads(policy.read_text()).get('tcp_network_access',{})
        if not (tcp.get('domains') or tcp.get('ip_ranges')):
            raise Blocked('NETWORK_TCP_NOT_GRANTED','当前环境未授予BaoStock官方SDK的TCP连接；请在可访问 public-api.baostock.com:10030 的本地主机运行。BaoStock无需API Key或Token。')
def months(start,end):
    left=dt.date.fromisoformat(start);last=dt.date.fromisoformat(end)
    while left<=last:
        right=(left.replace(day=28)+dt.timedelta(days=4)).replace(day=1)
        yield left.isoformat(),min(last,right-dt.timedelta(days=1)).isoformat()
        left=right
def collect(request,root,store,emit=lambda x:None,parent=None,bs=None,guard_factory=None):
    root=pathlib.Path(root);root.mkdir(parents=True,exist_ok=True);store=pathlib.Path(store);store.mkdir(parents=True,exist_ok=True)
    def check():
        if (root/'cancel').exists() or parent and os.getppid()!=parent:raise Blocked('PAUSED','任务暂停；已完成分段保留，下次从断点继续。')
    cache=Checkpoints(root/'queries',emit,check);restore=None;guard=None;logged=False;lock=FileLock(root/'.collection.lock')
    try:
        if bs is None:
            network_check()
            import baostock as bs
            from baostock_guard import TrafficGuard,install
            guard=(guard_factory or TrafficGuard)(limit=request.get('budget',10000))
            reserve=guard.reserve
            def checked_reserve():check();reserve()
            guard.reserve=checked_reserve;restore=install(guard)
        try:
            from importlib.metadata import version
            sdk_version=version('baostock')
        except Exception:sdk_version=getattr(bs,'__version__','unknown')
        import pyarrow
        environment={'collectorVersion':VERSION,'python':sys.version.split()[0],'sdkVersion':sdk_version,'pyarrowVersion':pyarrow.__version__}
        environment_path=root/'environment.json'
        if environment_path.exists() and json.loads(environment_path.read_bytes())!=environment:raise Blocked('COLLECTOR_RUNTIME_CHANGED','Python或BaoStock版本已改变，不能混用旧查询断点，请创建新任务。')
        if not environment_path.exists():atomic(environment_path,encode(environment))
        login=bs.login()
        if login.error_code!='0':raise Blocked('PROVIDER_LOGIN','BaoStock登录失败：'+login.error_code)
        logged=True;symbol=request['symbol'];code=('sh.' if symbol.startswith('6') else 'sz.')+symbol;end=request['to']
        purpose=request.get('purpose','research')
        if purpose not in ('collect','research'):raise Blocked('REQUEST','任务用途无效。')
        cache.traffic=lambda:(getattr(guard,'session_requests',0),getattr(guard,'session_wait_ms',0))
        source=BaoStockSource(sdk=bs,check=check)
        q=lambda key,fn:cache.query(key,lambda:bs_rows(fn()))
        calendar=q(['calendar','1990-12-19',end],lambda:bs.query_trade_dates(start_date='1990-12-19',end_date=end))
        days=[r['calendar_date'] for r in calendar if r['is_trading_day']=='1']
        before=[d for d in days if d<request['from']]
        needed=request['warmupSessions']
        if len(before)<needed:raise Blocked('WARMUP_CALENDAR','独立交易日历不足以定位预热历史。')
        start=before[-needed];sessions=[d for d in days if start<=d<=end]
        basic=q(['basic',code],lambda:bs.query_stock_basic(code=code))
        if len(basic)!=1 or basic[0].get('code')!=code:raise Blocked('SECURITY_IDENTITY','证券基本资料缺失或代码不符。')
        # Reject future provider rows rather than silently filtering them.
        daily=cache.query(['daily',code,start,end],lambda:source.get_daily(symbol,start,end).raw)
        if any(r.get('code')!=code or not start<=r.get('date','')<=end for r in daily):raise Blocked('PROVIDER_RANGE','日线响应证券或日期不符。')
        factors=cache.query(['factors',code,start,end],lambda:source.get_adj_factor(symbol,start,end).raw)
        dividends=[]
        for year in range(int(start[:4])-1,int(end[:4])+1):
            dividends+=q(['dividends',code,year,'operate'],lambda year=year:bs.query_dividend_data(code,year=str(year),yearType='operate'))
        universe=[]
        for day in (sessions if purpose=='research' else []):
            rows=q(['hs300',day],lambda day=day:bs.query_hs300_stocks(date=day))
            updated={r.get('updateDate') for r in rows};codes=sorted({r.get('code','') for r in rows})
            if len(rows)!=300 or len(codes)!=300 or len(updated)!=1 or not next(iter(updated)) or next(iter(updated))>day:
                raise Blocked('UNIVERSE_HISTORY','历史成分股缺失、重复、非300只或含未来更新：'+day)
            date=next(iter(updated));universe.append({'date':day,'updateDate':date,'knownAt':date+' 15:00','codes':codes,'source':'baostock query_hs300_stocks(date)','granularity':'weekly'})
        minute=[]
        for left,right in months(start,end):
            rows=cache.query(['minute',code,'5',left,right,'raw'],lambda left=left,right=right:source.get_minute5(symbol,left,right).raw)
            if any(r.get('code')!=code or not left<=r.get('date','')<=right or r.get('adjustflag')!='3' for r in rows):raise Blocked('PROVIDER_RANGE','分钟响应证券、日期或原始价格口径不符。')
            minute+=rows
        result=normalize_baostock(symbol,start,end,basic,calendar,daily,minute,factors,dividends)
        db=db_open(store/'market.sqlite')
        try:
            duplicates=merge_bars(db,'baostock',symbol,'5m',result['bars'],root.parent.name)
            conflicts=[{'date':r[0],'job':r[1],'status':'unresolved'} for r in db.execute('SELECT date,job FROM conflicts WHERE source=? AND symbol=? AND tf=? AND date>=? AND date<?',('baostock',symbol,'5m',start,end+' 23:59'))]
        finally:db.close()
        cov=result['coverage'];cov['universe']={'status':'complete','from':start,'to':end,'source':'baostock query-date weekly snapshots'} if purpose=='research' else {'status':'not-requested','reason':'仅采集指定证券行情，无指数成员资格判断'}
        metadata={'symbol':symbol,'name':basic[0].get('code_name',''),'board':request['board'],'source':'baostock','timeframe':'5m','listedDate':result['listedDate'],'requested':{'from':start,'to':end},'research':{'from':request['from'],'to':end,'warmupSessions':needed},'universe':'HS300','universePolicy':'weekly-asof-next-session','priceBasis':'raw','volumeUnit':'shares','timezone':'Asia/Shanghai','timestampConvention':'bar-close','coverage':cov,'providerDuplicates':duplicates,'conflicts':conflicts,'provenance':{'collectorVersion':VERSION,'sdkVersion':sdk_version,'environment':environment,'queries':cache.proofs}}
        if purpose=='collect':metadata.update(universe='SINGLE_SECURITY',universePolicy='not-requested',collectionPurpose='market-data-only')
        bundle={'schemaVersion':1,'metadata':metadata,**{k:result[k] for k in ('bars','daily','calendar','actions','factors')},'universe':universe}
        from parquet_store import archive
        emit({'stage':'archive','message':'将原始行情及辅助资料归档为Parquet并读回核对'})
        try:metadata['parquetArchive']=archive(bundle,store/'parquet')
        except Exception as e:raise Blocked('PARQUET_ARCHIVE',str(e)) from None
        body=encode(bundle);atomic(root/'bundle.json',body)
        receipt={'sha256':sha(body),'bytes':len(body),'bars':len(bundle['bars']),'warmupFrom':start,'researchFrom':request['from'],'researchTo':end,'checkpoints':len(cache.proofs)}
        atomic(root/'receipt.json',encode(receipt));emit({'stage':'collected',**receipt});return bundle
    finally:
        if logged:
            try:bs.logout()
            except Exception:pass
        if restore:restore()
        if guard:guard.close()
        lock.close()
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',required=True);parser.add_argument('--root',required=True);parser.add_argument('--store',required=True);parser.add_argument('--parent',type=int)
    args=parser.parse_args();root=pathlib.Path(args.root)
    def emit(x):print(json.dumps(x,ensure_ascii=False,separators=(',',':')),flush=True)
    try:
        collect(json.loads(pathlib.Path(args.request).read_text()),root,args.store,emit,args.parent);return 0
    except Exception as e:
        error={'stage':'blocked','code':getattr(e,'code','COLLECTOR_ERROR'),'error':str(e)};atomic(root/'error.json',encode(error));emit(error);return 2
if __name__=='__main__':sys.exit(main())
