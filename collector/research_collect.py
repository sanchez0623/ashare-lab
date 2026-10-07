#!/usr/bin/env python3
"""Single-stock native-5m collection with verified, atomic query checkpoints.
Only completed SDK responses (including every pagination send) are checkpointed.
No synthetic data or alternative IP/proxy route is used on a network failure.
"""
import argparse, datetime as dt, hashlib, json, os, pathlib, sys, tempfile, time, traceback
from sync import bs_rows, normalize_baostock, db_open, merge_bars
from locking import FileLock
from sources import BaoStockSource
from query_cache import SharedQueries, frozen_plan, digest, read_proof

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
        self.root=pathlib.Path(root);self.emit=emit;self.check=check;self.proofs={};self.traffic=traffic;self.shared=None;self.usage=lambda:None
    def query(self,key,fn,validate=None):
        self.check();identity={'version':VERSION,'query':key};name=sha(encode(identity));path=self.root/(name+'.json')
        started=time.perf_counter();before=self.traffic();cached=path.exists()
        self.emit({'stage':'collect','phase':'query-start','query':key,'cached':cached,'checkpoints':len(self.proofs)})
        try:return self._query(key,fn,identity,name,path,started,before,validate)
        except Exception as e:
            requests,wait=self.traffic()
            self.emit({'stage':'collect','phase':'query-error','query':key,'cached':cached,'queryElapsedMs':round((time.perf_counter()-started)*1000),'requests':requests-before[0],'rateWaitMs':round(wait-before[1]),'checkpoints':len(self.proofs),'error':str(e)})
            raise
    def _query(self,key,fn,identity,name,path,started,before,validate):
        cached=False;origin='task'
        if path.exists():
            try:
                envelope=json.loads(path.read_bytes());body=encode(envelope['rows'])
                if envelope['identity']!=identity or sha(body)!=envelope['sha256']:raise ValueError()
                rows=envelope['rows']
            except (ValueError,KeyError):raise Blocked('CACHE_HASH','采集断点哈希不一致，拒绝继续：'+name) from None
            if validate:
                try:validate(rows);cached=True
                except Blocked as e:
                    # Hash integrity does not prove response completeness.
                    # Preserve the old evidence, and refetch this query once.
                    rejected=self.root.parent/'quarantine'/(name+'-'+str(time.time_ns())+'.json');rejected.parent.mkdir(parents=True,exist_ok=True)
                    os.replace(path,rejected);self.proofs.pop(name,None)
                    self.emit({'stage':'collect','message':'隔离不完整的日历断点并重新查询；不复用错误预热范围：'+str(e)})
            else:cached=True
        if not cached:
            shared=self.shared.get(key,validate) if self.shared and key[0] in ('calendar','hs300') else None
            rows=shared['rows'] if shared else fn();self.check();body=encode(rows)
            if validate:validate(rows)
            atomic(path,encode({'identity':identity,'sha256':sha(body),'rows':rows}));cached=shared is not None;origin='shared' if shared else 'network'
        if self.shared:self.shared.put({'identity':identity,'sha256':sha(body),'rows':rows})
        self.proofs[name]={'query':key,'sha256':sha(body),'rows':len(rows)}
        requests,wait=self.traffic()
        self.emit({'stage':'collect','phase':'query-complete','query':key,'rows':len(rows),'cached':cached,'cacheOrigin':origin,'sourceUsage':self.usage(),'checkpoints':len(self.proofs),'queryElapsedMs':round((time.perf_counter()-started)*1000),'requests':requests-before[0],'rateWaitMs':round(wait-before[1])})
        return rows
def verified_calendar(rows,start,end):
    """The API returns trading *and non-trading* days. Verify every date,
    not just that a response ended or that its SHA matches a cached file.
    """
    first=dt.date.fromisoformat(start);last=dt.date.fromisoformat(end);seen={}
    for r in rows:
        day=r.get('calendar_date','')
        try:parsed=dt.date.fromisoformat(day)
        except (ValueError,TypeError):raise Blocked('CALENDAR_INVALID','交易日历日期格式无效。') from None
        if parsed.isoformat()!=day or not first<=parsed<=last or r.get('is_trading_day') not in ('0','1'):
            raise Blocked('CALENDAR_INVALID','交易日历日期、范围或交易状态无效：'+str(day))
        if day in seen:raise Blocked('CALENDAR_INVALID','交易日历日期重复：'+day)
        seen[day]=r
    expected=(last-first).days+1
    if len(seen)!=expected:
        missing=next((first+dt.timedelta(days=i)).isoformat() for i in range(expected) if (first+dt.timedelta(days=i)).isoformat() not in seen)
        raise Blocked('CALENDAR_INCOMPLETE',f'交易日历不完整：需要{expected}个自然日，返回{len(seen)}个；首个缺失{missing}，实际末日{max(seen) if seen else "无"}。停止推导预热日期，禁止扩大分钟查询。')
    return [seen[d] for d in sorted(seen)]
def network_check():
    policy=pathlib.Path('/etc/codex/network-policy.json')
    if policy.exists():
        tcp=json.loads(policy.read_text()).get('tcp_network_access',{})
        if not (tcp.get('domains') or tcp.get('ip_ranges')):
            raise Blocked('NETWORK_TCP_NOT_GRANTED','当前环境未授予BaoStock官方SDK的TCP连接；请在可访问 public-api.baostock.com:10030 的本地主机运行。BaoStock无需API Key或Token。')
def verified_universe(rows,day):
    updated={r.get('updateDate') for r in rows};codes={r.get('code','') for r in rows}
    if len(rows)!=300 or len(codes)!=300 or len(updated)!=1 or not next(iter(updated)) or next(iter(updated))>day:
        raise Blocked('UNIVERSE_HISTORY','历史成分股缺失、重复、非300只或含未来更新：'+day)
    return rows
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
            emit({'stage':'collect','phase':'traffic-start','sourceUsage':guard.usage(),'message':'已读取本机共享预算与监控IP；官方额度按公网IP统计，本机记录不含其他设备，IP变化不重置日预算'})
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
        cache.shared=SharedQueries(store/'query-cache',environment,VERSION,emit,check)
        cache.shared.import_legacy(store.parent/'jobs')
        login=bs.login()
        if login.error_code!='0':raise Blocked('PROVIDER_LOGIN','BaoStock登录失败：'+login.error_code)
        logged=True;symbol=request['symbol'];code=('sh.' if symbol.startswith('6') else 'sz.')+symbol;end=request['to']
        purpose=request.get('purpose','research')
        if purpose not in ('collect','research'):raise Blocked('REQUEST','任务用途无效。')
        cache.traffic=lambda:(getattr(guard,'session_requests',0),getattr(guard,'session_wait_ms',0))
        if guard:cache.usage=guard.usage
        source=BaoStockSource(sdk=bs,check=check)
        q=lambda key,fn:cache.query(key,lambda:bs_rows(fn()))
        calendar_start='1990-12-19'
        calendar=cache.query(['calendar',calendar_start,end],lambda:bs_rows(bs.query_trade_dates(start_date=calendar_start,end_date=end)),validate=lambda rows:verified_calendar(rows,calendar_start,end))
        calendar=verified_calendar(calendar,calendar_start,end)
        days=[r['calendar_date'] for r in calendar if r['is_trading_day']=='1']
        before=[d for d in days if d<request['from']]
        needed=request['warmupSessions']
        if len(before)<needed:raise Blocked('WARMUP_CALENDAR','独立交易日历不足以定位预热历史。')
        start=before[-needed];sessions=[d for d in days if start<=d<=end]
        if (dt.date.fromisoformat(request['from'])-dt.date.fromisoformat(start)).days>max(365,needed*4):
            raise Blocked('WARMUP_RANGE','预热起点距研究开始日异常过远；拒绝扩大采集区间，请检查交易日历。')
        emit({'stage':'collect','message':f'采集区间已确定：{start} — {end}；研究区间：{request["from"]} — {end}；额外预热{needed}个交易日',
              'collectionRange':{'from':start,'to':end,'researchFrom':request['from'],'warmupSessions':needed}})
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
            rows=cache.query(['hs300',day],lambda day=day:bs_rows(bs.query_hs300_stocks(date=day)),validate=lambda rows,day=day:verified_universe(rows,day))
            updated={r.get('updateDate') for r in rows};codes=sorted({r.get('code','') for r in rows})
            if len(rows)!=300 or len(codes)!=300 or len(updated)!=1 or not next(iter(updated)) or next(iter(updated))>day:
                raise Blocked('UNIVERSE_HISTORY','历史成分股缺失、重复、非300只或含未来更新：'+day)
            date=next(iter(updated));universe.append({'date':day,'updateDate':date,'knownAt':date+' 15:00','codes':codes,'source':'baostock query_hs300_stocks(date)','granularity':'weekly'})
        plan_identity={'version':1,'collectorVersion':VERSION,'environmentHash':digest(environment),'code':code,'from':start,'to':end}
        plan=frozen_plan(root/'minute-plan.json',plan_identity,lambda:cache.shared.minute_plan(code,start,end,calendar,daily,basic[0],months,cache.root))
        reused=[{'from':p['from'],'to':p['to'],'sourceQuery':p['query'],'sourceSha256':p['sha256']} for p in plan if p['reuse']]
        fetch=[{'from':p['from'],'to':p['to']} for p in plan if not p['reuse']]
        cache_conflicts=sorted({d for p in plan for d in p.get('cacheConflictDays',[])})
        plan_summary={'policy':'verified-raw-days-v1','planSha256':digest(plan),'reusedRanges':reused,'fetchRanges':fetch,'cacheConflictDays':cache_conflicts,'reusedTradingDays':sum(p['from']<=d<=p['to'] for p in plan if p['reuse'] for d in sessions),'plannedFetchQueries':len(fetch)}
        emit({'stage':'collect','phase':'incremental-plan','collectionPlan':plan_summary,'message':f'增量计划：跨任务复用{plan_summary["reusedTradingDays"]}个交易日（{len(reused)}段），待查询{len(fetch)}个分钟缺口；已保存计划，暂停恢复不改变范围'})
        minute=[]
        for p in plan:
            key=p['query'];left,right=key[3:5]
            if p['reuse']:
                checkpoint=cache.root/(sha(encode({'version':VERSION,'query':key}))+'.json')
                if not checkpoint.exists():
                    proof=cache.shared.get(key)
                    if not proof or proof['sha256']!=p['sha256']:raise Blocked('CACHE_PLAN_SOURCE','增量计划引用的原始响应已缺失或改变，保留计划，拒绝更换证据。')
                    atomic(checkpoint,encode(proof))
                proof=read_proof(checkpoint,{'version':VERSION,'query':key})
                if proof['sha256']!=p['sha256']:raise Blocked('CACHE_PLAN_SOURCE','任务响应与冻结增量计划不符。')
            rows=cache.query(key,lambda left=left,right=right:source.get_minute5(symbol,left,right).raw)
            if any(r.get('code')!=code or not left<=r.get('date','')<=right or r.get('adjustflag')!='3' for r in rows):raise Blocked('PROVIDER_RANGE','分钟响应证券、日期或原始价格口径不符。')
            minute.extend(r for r in rows if p['from']<=r['date']<=p['to'])
            if p['reuse']:emit({'stage':'collect','message':f'跨任务复用原始5分钟：{p["from"]} — {p["to"]}；本段SDK请求0次，原始响应已复制到当前任务并核对哈希'})
        result=normalize_baostock(symbol,start,end,basic,calendar,daily,minute,factors,dividends)
        db=db_open(store/'market.sqlite')
        try:
            duplicates=merge_bars(db,'baostock',symbol,'5m',result['bars'],root.parent.name)
            conflicts=[{'date':r[0],'job':r[1],'status':'unresolved'} for r in db.execute('SELECT date,job FROM conflicts WHERE source=? AND symbol=? AND tf=? AND date>=? AND date<?',('baostock',symbol,'5m',start,end+' 23:59'))]
        finally:db.close()
        conflicts.extend({'date':d,'job':root.parent.name,'source':'shared-response','status':'unresolved'} for d in cache_conflicts)
        cov=result['coverage'];cov['universe']={'status':'complete','from':start,'to':end,'source':'baostock query-date weekly snapshots'} if purpose=='research' else {'status':'not-requested','reason':'仅采集指定证券行情，无指数成员资格判断'}
        metadata={'symbol':symbol,'name':basic[0].get('code_name',''),'board':request['board'],'source':'baostock','timeframe':'5m','listedDate':result['listedDate'],'requested':{'from':start,'to':end},'research':{'from':request['from'],'to':end,'warmupSessions':needed},'universe':'HS300','universePolicy':'weekly-asof-next-session','priceBasis':'raw','volumeUnit':'shares','timezone':'Asia/Shanghai','timestampConvention':'bar-close','coverage':cov,'providerDuplicates':duplicates,'conflicts':conflicts,'provenance':{'collectorVersion':VERSION,'sdkVersion':sdk_version,'environment':environment,'queries':cache.proofs}}
        metadata['incrementalPlan']=plan_summary
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
        if guard:
            usage=guard.usage()
            monitor=usage.get('monitorIP',{})
            emit({'stage':'collect','phase':'traffic-summary','sourceUsage':usage,'message':f'BaoStock本次SDK请求{usage["sessionRequests"]}次；北京时间{usage["day"]}本机日累计{usage["requests"]}/{usage["budget"]}次，监控IP {monitor.get("ip") or "未识别"}；官方50000次/日按公网IP，本机记录不含其他设备，含登录、分页和登出'})
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
        error={'stage':'blocked','code':getattr(e,'code','COLLECTOR_ERROR'),'error':str(e)}
        atomic(root/'error.json',encode({**error,'traceback':traceback.format_exc(limit=12)}));emit(error);return 2
if __name__=='__main__':sys.exit(main())
