"""Lazy market-source adapters. Readiness is not proof of historical coverage.

Four common methods: get_daily / get_minute5 / get_adj_factor / get_index_daily.
Historical ST, exchange references, entitlements and membership remain separate
formal-admission requirements. No adapter supplies synthetic replacements.
"""
import argparse,datetime as dt,hashlib,importlib,importlib.util,json,math,os,pathlib,time
from contextlib import contextmanager
from dataclasses import dataclass,field
from typing import Any

VERSION='sources-1'
class SourceError(RuntimeError):
    def __init__(self,code,message):super().__init__(message);self.code=code
def numeric(value):
    try:
        result=float(value)
        return result if math.isfinite(result) else None
    except (ValueError,TypeError):return None
def code(symbol):
    if not isinstance(symbol,str) or len(symbol)!=6 or not symbol.isdigit() or symbol[0] not in '603':raise SourceError('SYMBOL','仅支持明确的沪深六位股票代码')
    return ('sh.' if symbol.startswith('6') else 'sz.')+symbol
def validate_range(start,end):
    try:
        if dt.date.fromisoformat(start)>dt.date.fromisoformat(end):raise ValueError()
    except (ValueError,TypeError):raise SourceError('RANGE','请求日期区间无效') from None
def sdk_rows(result):
    rows=[]
    while result.error_code=='0' and result.next():rows.append(dict(zip(result.fields,result.get_row_data())))
    if result.error_code!='0':
        err=result.error_code
        raise SourceError('BLACKLIST' if err=='10001011' else 'PROVIDER_ERROR','BaoStock响应错误：'+err)
    return rows
def tcp_preflight(provider):
    policy=pathlib.Path('/etc/codex/network-policy.json')
    if policy.exists():
        tcp=json.loads(policy.read_text()).get('tcp_network_access',{})
        if not (tcp.get('domains') or tcp.get('ip_ranges')):raise SourceError('NETWORK_TCP_NOT_GRANTED',provider+'需要TCP连接，当前环境未授予此权限；请在官方SDK可联网的本地主机运行')
def http_session():
    import requests
    session=requests.Session()
    # Managed cloud requires its inherited proxy and CA. Local deployments may
    # explicitly opt out; never turn off trust_env here merely to evade a denial.
    managed=pathlib.Path('/etc/codex/network-policy.json').exists()
    session.trust_env=True if managed else os.environ.get('ASHARE_HTTP_TRUST_ENV','1')!='0'
    original=session.request
    def bounded(*args,**kwargs):kwargs.setdefault('timeout',30);return original(*args,**kwargs)
    session.request=bounded
    return session
def frame_records(frame):return json.loads(frame.to_json(orient='records',date_format='iso',force_ascii=False))
@contextmanager
def bounded_requests():
    import requests
    original=requests.sessions.Session.request
    managed=pathlib.Path('/etc/codex/network-policy.json').exists()
    direct=not managed and os.environ.get('ASHARE_HTTP_TRUST_ENV','1')=='0'
    def bounded(self,*args,**kwargs):
        if not kwargs.get('timeout'):kwargs['timeout']=30
        # AkShare creates its own sessions. Honor the same explicit local
        # override as our HTTP adapters; never disable a managed proxy.
        previous=self.trust_env
        try:
            if direct:self.trust_env=False
            return original(self,*args,**kwargs)
        finally:self.trust_env=previous
    requests.sessions.Session.request=bounded
    try:yield
    finally:requests.sessions.Session.request=original
@dataclass
class SourceBatch:
    source:str
    kind:str
    rows:list
    raw:Any
    start:str
    end:str
    metadata:dict=field(default_factory=dict)
    def as_dict(self):
        digest=hashlib.sha256(json.dumps(self.raw,sort_keys=True,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()).hexdigest()
        return {'source':self.source,'kind':self.kind,'rows':self.rows,'raw':self.raw,'requested':{'from':self.start,'to':self.end},'metadata':{'rawSHA256':digest,'coverage':'unverified',**self.metadata}}

class DataSource:
    name='';dependencies=();capabilities=();transport='http';requires_key=False
    def __init__(self):self._health={}
    def available(self):
        try:return all(importlib.util.find_spec(m) is not None for m in self.dependencies)
        except (ValueError,ImportError):return False
    def readiness(self):
        if not self.available():return {'state':'unavailable','code':'OPTIONAL_DEPENDENCY_MISSING'}
        try:
            if self.transport=='tcp':tcp_preflight(self.name)
            return {'state':'ready-unprobed','code':None}
        except SourceError as e:return {'state':'blocked','code':e.code}
    def require(self,kind):
        if kind not in self.capabilities:raise SourceError('UNSUPPORTED',self.name+'不支持'+kind)
        state=self.readiness()
        if state['state']!='ready-unprobed':raise SourceError(state['code'],self.name+'未就绪：'+state['code'])
    def check_health(self,probe=None,ttl=60):
        # A callable probe runs through the adapter/guard. No paid market request
        # is issued for a mere status listing, and coverage is never inferred.
        key=probe is not None;cached=self._health.get(key)
        if cached and time.monotonic()-cached[0]<ttl:return cached[1]
        result=self.readiness()
        if probe and result['state']=='ready-unprobed':
            try:
                if not probe(self).rows:raise SourceError('EMPTY','健康探测返回空数据')
                result={'state':'healthy','code':None}
            except SourceError as e:result={'state':'unhealthy','code':e.code}
            except Exception:result={'state':'unhealthy','code':'PROBE_FAILED'}
        self._health[key]=(time.monotonic(),result);return result
    def get_daily(self,symbol,start,end):raise SourceError('UNSUPPORTED','日线接口未实现')
    def get_minute5(self,symbol,start,end):raise SourceError('UNSUPPORTED','5分钟接口未实现')
    def get_adj_factor(self,symbol,start,end):raise SourceError('UNSUPPORTED','因子接口未实现')
    def get_index_daily(self,symbol,start,end):raise SourceError('UNSUPPORTED','指数接口未实现')
    def close(self):pass
    def __enter__(self):return self
    def __exit__(self,*_):self.close()

class BaoStockSource(DataSource):
    name='baostock';dependencies=('baostock',);transport='tcp'
    capabilities=('daily','minute5','adj_factor','index_daily','calendar','historical_st','historical_universe','actions','stock_basic')
    def __init__(self,sdk=None,budget=10000,check=lambda:None):super().__init__();self.sdk=sdk;self.budget=budget;self.check=check;self.guard=None;self.restore=None
    def connection(self):
        self.check()
        if self.sdk is not None:return self.sdk  # Existing collector owns its SDK lock/login.
        self.require('daily')
        import baostock as bs
        from baostock_guard import TrafficGuard,install
        self.guard=TrafficGuard(limit=self.budget);reserve=self.guard.reserve
        def guarded_reserve():self.check();reserve()
        self.guard.reserve=guarded_reserve;self.restore=install(self.guard)
        try:
            result=bs.login()
            if result.error_code!='0':raise SourceError('PROVIDER_LOGIN','BaoStock登录失败：'+result.error_code)
            self.sdk=bs;return bs
        except Exception:self.close();raise
    def _prices(self,symbol,start,end,frequency,kind,index=False):
        validate_range(start,end)
        if index and isinstance(symbol,str) and len(symbol)==8 and symbol.startswith(('sh','sz')):symbol=symbol[:2]+'.'+symbol[2:]
        security=symbol if index else code(symbol)
        if index and (len(symbol)!=9 or not symbol.startswith(('sh.','sz.')) or not symbol[3:].isdigit()):raise SourceError('SYMBOL','指数须为sh./sz.前缀的六位代码')
        fields='date,time,code,open,high,low,close,volume,amount,adjustflag' if frequency=='5' else 'date,code,open,high,low,close,preclose,volume,amount,tradestatus'+('' if index else ',isST')
        raw=sdk_rows(self.connection().query_history_k_data_plus(security,fields,start_date=start,end_date=end,frequency=frequency,adjustflag='3'))
        rows=[]
        for r in raw:
            if r.get('code')!=security or not start<=r.get('date','')<=end:raise SourceError('PROVIDER_RANGE','BaoStock响应证券或日期不符')
            stamp=r['date']
            if frequency=='5':
                clock=r.get('time','')
                if len(clock)!=17 or clock[12:14]!='00' or clock[:8]!=stamp.replace('-','') or r.get('adjustflag')!='3':raise SourceError('TIMESTAMP','原生5分钟时间或复权口径不符')
                stamp+=' '+clock[8:10]+':'+clock[10:12]
            row={'date':stamp,**{k:numeric(r.get(k)) for k in ('open','high','low','close','volume')}}
            if frequency=='d' and not index:row.update(halted=0 if r.get('tradestatus')=='1' else 1,isST=int(r['isST']) if r.get('isST') in ('0','1') else None,prev_close=numeric(r.get('preclose')))
            rows.append(row)
        return SourceBatch(self.name,kind,rows,raw,start,end,{'priceBasis':'raw','volumeUnit':'shares','timezone':'Asia/Shanghai','timestampConvention':'bar-close','nativeTimeframe':'5m' if frequency=='5' else '1d'})
    def get_daily(self,symbol,start,end):return self._prices(symbol,start,end,'d','daily')
    def get_minute5(self,symbol,start,end):return self._prices(symbol,start,end,'5','minute5')
    def get_index_daily(self,symbol,start,end):return self._prices(symbol,start,end,'d','index_daily',True)
    def get_adj_factor(self,symbol,start,end):
        validate_range(start,end);raw=sdk_rows(self.connection().query_adjust_factor(code(symbol),start_date=start,end_date=end))
        rows=[{'date':r.get('dividOperateDate',''),**r} for r in raw]
        return SourceBatch(self.name,'adj_factor',rows,raw,start,end,{'eventsOnly':True,'basis':'vendor-back-adjust-factor','formalPolicy':'reconcile with ex-reference and full entitlements; never overwrite earlier raw prices'})
    def close(self):
        # Only close connections/guards this adapter itself created.
        if self.guard:
            if self.sdk:
                try:self.sdk.logout()
                except Exception:pass
            if self.restore:self.restore()
            self.guard.close();self.guard=None;self.restore=None;self.sdk=None

class AkShareSource(DataSource):
    name='akshare';dependencies=('akshare',);capabilities=('daily','minute5','adj_factor','index_daily')
    def _stock(self,symbol,start,end,adjust=''):
        code(symbol);validate_range(start,end);self.require('daily');import akshare as ak
        with bounded_requests():return frame_records(ak.stock_zh_a_hist(symbol=symbol,period='daily',start_date=start.replace('-',''),end_date=end.replace('-',''),adjust=adjust,timeout=30))
    def _convert(self,raw,kind,start,end):
        rows=[{'date':str(r['时间' if kind=='minute5' else '日期']).replace('T',' ')[:16 if kind=='minute5' else 10],**{k:numeric(r.get(v)) for k,v in [('open','开盘'),('high','最高'),('low','最低'),('close','收盘')]},'volume':None if numeric(r.get('成交量')) is None else numeric(r['成交量'])*100} for r in raw]
        return SourceBatch(self.name,kind,rows,raw,start,end,{'priceBasis':'raw','volumeUnit':'shares','nativeTimeframe':'5m' if kind=='minute5' else '1d','historicalST':'not-supplied'})
    def get_daily(self,symbol,start,end):return self._convert(self._stock(symbol,start,end),'daily',start,end)
    def get_minute5(self,symbol,start,end):
        code(symbol);validate_range(start,end);self.require('minute5');import akshare as ak
        with bounded_requests():raw=frame_records(ak.stock_zh_a_hist_min_em(symbol=symbol,period='5',start_date=start+' 09:00:00',end_date=end+' 15:30:00',adjust=''))
        return self._convert(raw,'minute5',start,end)
    def get_adj_factor(self,symbol,start,end):
        raw=self.get_daily(symbol,start,end);hfq=self._stock(symbol,start,end,'hfq');byday={str(r['日期']).replace('T',' ')[:10]:r for r in hfq}
        if len(byday)!=len(hfq) or set(byday)!=set(r['date'] for r in raw.rows):raise SourceError('FACTOR_ALIGNMENT','原始/后复权日线日期不一致')
        factors=[]
        for r in raw.rows:
            value=numeric(byday[r['date']].get('收盘'))
            if value is None or value<=0 or r['close'] is None or r['close']<=0:raise SourceError('FACTOR_VALUE','因子比值无效')
            factors.append({'date':r['date'],'factor':value/r['close'],'rawClose':r['close'],'hfqClose':value})
        return SourceBatch(self.name,'adj_factor',factors,{'raw':raw.raw,'hfq':hfq},start,end,{'basis':'hfq/raw daily ratio','causalAdmission':'unverified; cross-check event dates, references and point-in-time evidence before formal use'})
    def get_index_daily(self,symbol,start,end):
        validate_range(start,end);self.require('index_daily');import akshare as ak
        if not isinstance(symbol,str) or not symbol.startswith(('sh','sz','csi')):raise SourceError('SYMBOL','AkShare指数需sh/sz/csi前缀')
        symbol=symbol.replace('.','')
        with bounded_requests():raw=frame_records(ak.stock_zh_index_daily_em(symbol=symbol,start_date=start.replace('-',''),end_date=end.replace('-','')))
        return SourceBatch(self.name,'index_daily',raw,raw,start,end,{'priceBasis':'raw','volumeUnit':'provider-unit; diagnostic only'})

class MootdxSource(DataSource):
    name='mootdx';dependencies=('mootdx',);transport='tcp';capabilities=('daily','minute5');page_size=800
    def __init__(self,client=None,max_pages=64):super().__init__();self.client=client;self.max_pages=max_pages;self.lock=None;self.last=0
    def connection(self):
        if self.client is not None:return self.client
        self.require('minute5');from locking import FileLock
        from mootdx.quotes import Quotes
        self.lock=FileLock(pathlib.Path.home()/'.cache/ashare-mootdx/session.lock')
        try:self.client=Quotes.factory(market='std',bestip=False,heartbeat=False,auto_retry=False,raise_exception=True,timeout=15);return self.client
        except Exception:self.close();raise SourceError('PROVIDER_CONNECT','mootdx连接失败；不自动重连或更换服务器') from None
    def _bars(self,symbol,start,end,frequency,kind):
        code(symbol);validate_range(start,end);client=self.connection();rows=[];raw=[];seen=set()
        for page in range(self.max_pages):
            delay=1-(time.monotonic()-self.last)
            if delay>0:time.sleep(delay)
            self.last=time.monotonic();records=frame_records(client.bars(symbol=symbol,frequency=frequency,start=page*800,offset=800,adjust=''))
            if not records:break
            raw+=records
            for r in records:
                stamp=str(r.get('datetime') or r.get('date') or '').replace('T',' ')[:16 if kind=='minute5' else 10]
                if len(stamp)<(16 if kind=='minute5' else 10):raise SourceError('TIMESTAMP','mootdx缺少可核验的时间戳')
                if stamp in seen:raise SourceError('PAGINATION_CHANGED','mootdx分页重复或历史窗口变化，拒绝拼接')
                seen.add(stamp)
                if start<=stamp[:10]<=end:rows.append({'date':stamp,**{k:numeric(r.get(k)) for k in ('open','high','low','close')},'volume':numeric(r.get('vol',r.get('volume')))})
            if min(str(r.get('datetime') or r.get('date'))[:10] for r in records)<start:break
            if len(records)<800:break
        rows.sort(key=lambda r:r['date'])
        # TDX category volume scales vary. Never guess or infer a multiplier
        # from amount/close. Native volumes remain diagnostic until calibrated.
        return SourceBatch(self.name,kind,rows,raw,start,end,{'priceBasis':'raw','volumeUnit':'provider-unverified','nativeTimeframe':'5m' if frequency==0 else '1d','frequency':frequency,'maxPages':self.max_pages,'volumePolicy':'must reconcile against independent share-unit daily volume before formal use'})
    def get_daily(self,symbol,start,end):return self._bars(symbol,start,end,9,'daily')
    def get_minute5(self,symbol,start,end):return self._bars(symbol,start,end,0,'minute5')
    def close(self):
        if self.lock:
            if self.client:
                try:self.client.close()
                except Exception:pass
            self.lock.close();self.lock=None;self.client=None

class LixingerSource(DataSource):
    name='lixinger';dependencies=('requests',);capabilities=('daily',);requires_key=True
    def __init__(self,session=None):super().__init__();self.session=session;self.last=0
    def available(self):return super().available() and bool(os.environ.get('LIXINGER_API_KEY') or os.environ.get('LIXINGER_TOKEN'))
    def readiness(self):
        if not (os.environ.get('LIXINGER_API_KEY') or os.environ.get('LIXINGER_TOKEN')):return {'state':'unavailable','code':'CREDENTIAL_MISSING'}
        return super().readiness()
    def get_daily(self,symbol,start,end):
        code(symbol);validate_range(start,end);self.require('daily');token=os.environ.get('LIXINGER_API_KEY') or os.environ.get('LIXINGER_TOKEN')
        session=self.session or http_session();delay=1-(time.monotonic()-self.last)
        if delay>0:time.sleep(delay)
        self.last=time.monotonic()
        try:
            response=session.post('https://open.lixinger.com/api/cn/company/candlestick',json={'token':token,'stockCode':symbol,'type':'ex_rights','startDate':start,'endDate':end},timeout=30)
            if not response.ok:raise SourceError('PROVIDER_HTTP','理杏仁HTTP请求失败：'+str(response.status_code))
            body=response.json()
            if body.get('code')!=1:raise SourceError('PROVIDER_ERROR','理杏仁请求失败，请检查权限/额度')
            raw=body.get('data',[]);rows=[{'date':str(r.get('date',''))[:10],**{k:numeric(r.get(k)) for k in ('open','high','low','close','volume')}} for r in raw]
            return SourceBatch(self.name,'daily',rows,raw,start,end,{'priceBasis':'raw','volumeUnit':'provider-unverified','billing':'last fallback; one attempt per request; no automatic paid retries'})
        except SourceError:raise
        except Exception:raise SourceError('PROVIDER_HTTP','理杏仁请求失败（不记录响应正文或密钥）') from None
        finally:
            if self.session is None:session.close()

class SinaSource(DataSource):
    name='sina';dependencies=('requests',);capabilities=('minute5',);max_bars=5049
    def __init__(self,session=None):super().__init__();self.session=session
    def get_minute5(self,symbol,start,end):
        security=code(symbol).replace('.','');validate_range(start,end);self.require('minute5');session=self.session or http_session()
        try:
            raw=[];depths=list(dict.fromkeys([self.max_bars,1970]))
            for depth in depths:
                response=session.get('https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketData.getKLineData',params={'symbol':security,'scale':'5','ma':'no','datalen':depth},timeout=30)
                if not response.ok:raise SourceError('PROVIDER_HTTP','新浪HTTP请求失败：'+str(response.status_code))
                text=response.content.decode('gbk',errors='strict');left=text.find('[');right=text.rfind(']')
                if left<0 or right<left:
                    if 'null' in text:continue
                    raise SourceError('EMPTY','新浪返回无法识别的JSON')
                raw=json.loads(text[left:right+1])
                if raw:break
            if not raw:raise SourceError('EMPTY','新浪返回空数据；近期接口不能证明深历史')
            rows=[{'date':str(r['day'])[:16],**{k:numeric(r.get(k)) for k in ('open','high','low','close','volume')}} for r in raw if start<=str(r['day'])[:10]<=end]
            return SourceBatch(self.name,'minute5',rows,raw,start,end,{'priceBasis':'raw','volumeUnit':'shares','nativeTimeframe':'5m','role':'recent/tail only; requested depth does not prove actual retention','maxBarsRequested':depth,'depthAttempts':depths[:depths.index(depth)+1]})
        except SourceError:raise
        except Exception:raise SourceError('PROVIDER_HTTP','新浪分钟数据请求或解析失败') from None
        finally:
            if self.session is None:session.close()

def registry():return {s.name:s for s in (BaoStockSource(),AkShareSource(),MootdxSource(),LixingerSource(),SinaSource())}
CHAINS={'daily':('baostock','akshare','mootdx','lixinger'),'daily_star':('mootdx','baostock','akshare','lixinger'),'minute5':('baostock','mootdx','akshare','sina'),'intraday5':('mootdx','sina'),'adj_factor':('akshare','baostock'),'index_daily':('baostock','akshare')}
class SourceRouter:
    def __init__(self,sources=None):self.sources=registry() if sources is None else sources
    def fetch(self,kind,symbol,start,end,expected_dates=None,purpose='research',validator=None):
        validate_range(start,end)
        if purpose=='annual' and expected_dates is None:raise SourceError('CALENDAR_REQUIRED','年度分钟准入需要独立交易日历和预期网格')
        key='intraday5' if kind=='minute5' and purpose=='intraday' else kind
        if kind=='daily' and symbol.startswith('688'):key='daily_star'
        if key not in CHAINS:raise SourceError('UNSUPPORTED','数据类型无降级链')
        attempts=[]
        for name in CHAINS[key]:
            source=self.sources.get(name)
            if source is None or kind not in source.capabilities or source.check_health()['state'] not in ('ready-unprobed','healthy'):
                attempts.append({'source':name,'status':'skipped','code':source.readiness()['code'] if source else 'NOT_REGISTERED'});continue
            try:
                batch=getattr(source,'get_'+kind)(symbol,start,end)
                if batch.source!=name or batch.kind!=kind or batch.start!=start or batch.end!=end:raise SourceError('SOURCE_ID','响应来源、类型或请求区间不符')
                validate_batch(batch,expected_dates,kind=='minute5' and purpose=='annual')
                if validator:validator(batch)
                return {'batch':batch,'attempts':attempts+[{'source':name,'status':'selected'}]}
            except SourceError as e:
                attempts.append({'source':name,'status':'rejected','code':e.code})
                # A blocked budget/connection/blacklist is an explicit stop, not
                # a reason to retry another vendor as an automatic workaround.
                if e.code in ('BLACKLIST','BUDGET','CONNECTION_LOCK'):raise
            except Exception as e:
                if '黑名单' in str(e) or '预算' in str(e) or '已有BaoStock' in str(e):raise SourceError('BUDGET_OR_LOCK','BaoStock预算/连接/黑名单阻断，不自动降级') from None
                attempts.append({'source':name,'status':'rejected','code':'FETCH_FAILED'})
            finally:source.close()
        error=SourceError('ALL_SOURCES_FAILED','可用数据源均未满足请求；无合成替代');error.attempts=attempts;raise error
def validate_batch(batch,expected_dates=None,require_shares=False):
    if not batch.rows:
        if batch.kind=='adj_factor' and batch.metadata.get('eventsOnly'):return
        raise SourceError('EMPTY','数据源返回空数据')
    stamps=[r.get('date','') for r in batch.rows]
    if len(stamps)!=len(set(stamps)) or stamps!=sorted(stamps):raise SourceError('ORDER','重复或未排序的数据')
    if any(not batch.start<=s[:10]<=batch.end for s in stamps):raise SourceError('PROVIDER_RANGE','响应含请求范围外数据')
    try:
        if any(dt.date.fromisoformat(s[:10]).isoformat()!=s[:10] for s in stamps):raise ValueError()
    except (ValueError,TypeError):raise SourceError('TIMESTAMP','响应日期无效') from None
    if batch.kind in ('daily','minute5','index_daily'):
        active=[r for r in batch.rows if not(batch.kind=='daily' and r.get('halted')==1 and r.get('volume')==0)]
        if any(any(not isinstance(r.get(k),(int,float)) or not math.isfinite(r[k]) or r[k]<=0 for k in ('open','high','low','close')) or r['high']<max(r['open'],r['close']) or r['low']>min(r['open'],r['close']) for r in active):raise SourceError('PRICE','原始量价数据无效')
        if any(not isinstance(r.get('volume'),(int,float)) or not math.isfinite(r['volume']) or r['volume']<0 for r in batch.rows):raise SourceError('VOLUME','成交量缺失或无效')
    if batch.kind=='minute5':
        slots=[f'{m//60:02}:{m%60:02}' for a,b in ((575,690),(785,900)) for m in range(a,b+1,5)]
        if batch.metadata.get('nativeTimeframe')!='5m' or any(len(s)!=16 or s[11:] not in slots for s in stamps):raise SourceError('NATIVE_5M','必须为原生5分钟结束时间网格')
        if expected_dates is not None and set(stamps)!={d+' '+s for d in expected_dates for s in slots}:raise SourceError('COVERAGE','5分钟响应没有完整覆盖预期交易日和网格')
    elif expected_dates is not None and batch.kind in ('daily','index_daily') and set(s[:10] for s in stamps)!=set(expected_dates):raise SourceError('COVERAGE','日线未完整覆盖独立交易日历')
    if require_shares and batch.metadata.get('volumeUnit')!='shares':raise SourceError('VOLUME_UNIT','供应商成交量单位尚未校准，不能正式准入')
def status():
    sources=registry()
    return {'version':VERSION,'probePolicy':'readiness only; no market request or paid health probe','proxyPolicy':'preserve environment proxy in managed cloud','chains':CHAINS,'sources':[{'name':s.name,'available':s.available(),'dependencies':list(s.dependencies),'capabilities':list(s.capabilities),'transport':s.transport,'requiresKey':s.requires_key,'health':s.check_health(),'credentialVariable':'LIXINGER_API_KEY (legacy LIXINGER_TOKEN supported)' if s.requires_key else None} for s in sources.values()]}
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--status',action='store_true');p.add_argument('--kind',choices=['daily','minute5','adj_factor','index_daily']);p.add_argument('--symbol');p.add_argument('--from',dest='start');p.add_argument('--to',dest='end');p.add_argument('--purpose',choices=['research','intraday'],default='research');a=p.parse_args()
    if a.status:print(json.dumps(status(),ensure_ascii=False));return
    if not all((a.kind,a.symbol,a.start,a.end)):p.error('使用--status，或给定--kind/--symbol/--from/--to')
    try:
        outcome=SourceRouter().fetch(a.kind,a.symbol,a.start,a.end,purpose=a.purpose);print(json.dumps({'data':outcome['batch'].as_dict(),'attempts':outcome['attempts'],'formalReadiness':'not implied; independent calendar/ST/actions/membership and reconciliation required'},ensure_ascii=False,allow_nan=False))
    except SourceError as e:print(json.dumps({'error':str(e),'code':e.code,'attempts':getattr(e,'attempts',[])},ensure_ascii=False));raise SystemExit(2)
if __name__=='__main__':main()
