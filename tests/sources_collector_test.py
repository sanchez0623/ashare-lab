import datetime as dt,json,pathlib,sys,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
from sources import DataSource,SourceBatch,SourceError,SourceRouter,BaoStockSource,AkShareSource,MootdxSource,LixingerSource,SinaSource,registry,status,http_session,validate_batch,bounded_requests

def daily(dates):return [{'date':d,'open':10.,'high':11.,'low':9.,'close':10.,'volume':1000.} for d in dates]
def minute(dates):
    return [{'date':d+' '+f'{m//60:02}:{m%60:02}','open':10.,'high':11.,'low':9.,'close':10.,'volume':1000.} for d in dates for a,b in ((575,690),(785,900)) for m in range(a,b+1,5)]
class FakeSource(DataSource):
    capabilities=('daily','minute5','adj_factor','index_daily')
    def __init__(self,name,rows=None,error=None,unit='shares'):
        super().__init__();self.name=name;self.rows=rows;self.error=error;self.unit=unit;self.calls=[];self.closes=0
    def fetch(self,kind,symbol,start,end):
        self.calls.append(kind)
        if self.error:raise self.error
        return SourceBatch(self.name,kind,self.rows,self.rows,start,end,{'priceBasis':'raw','volumeUnit':self.unit,'nativeTimeframe':'5m'})
    def get_daily(self,*args):return self.fetch('daily',*args)
    def get_minute5(self,*args):return self.fetch('minute5',*args)
    def get_adj_factor(self,*args):return self.fetch('adj_factor',*args)
    def close(self):self.closes+=1
class Frame:
    def __init__(self,rows):self.rows=rows
    def to_json(self,**_):return json.dumps(self.rows)

class SourceTests(unittest.TestCase):
    def test_optional_sdks_do_not_break_registration_and_no_implicit_synthetic_source(self):
        with patch('sources.importlib.util.find_spec',return_value=None),patch.dict('sources.os.environ',{},clear=True):
            result=status();self.assertEqual(len(result['sources']),5);self.assertTrue(all(not s['available'] for s in result['sources']));self.assertNotIn('synthetic',registry())
            with self.assertRaises(SourceError) as e:SourceRouter().fetch('daily','600519','2024-01-02','2024-01-03')
            self.assertEqual(e.exception.code,'ALL_SOURCES_FAILED')
    def test_daily_fallback_rejects_partial_source_instead_of_mixing_rows(self):
        a=FakeSource('baostock',daily(['2024-01-02']));b=FakeSource('akshare',daily(['2024-01-02','2024-01-03']));paid=FakeSource('lixinger',daily(['2024-01-02','2024-01-03']))
        result=SourceRouter({'baostock':a,'akshare':b,'lixinger':paid}).fetch('daily','600519','2024-01-02','2024-01-03',expected_dates=['2024-01-02','2024-01-03'])
        self.assertEqual(result['batch'].source,'akshare');self.assertEqual(result['attempts'][0]['code'],'COVERAGE');self.assertEqual(paid.calls,[]);self.assertEqual((a.closes,b.closes),(1,1))
    def test_star_daily_prefers_tdx_and_paid_provider_is_last(self):
        a=FakeSource('baostock',daily(['2024-01-02']));t=FakeSource('mootdx',daily(['2024-01-02']));p=FakeSource('lixinger',daily(['2024-01-02']))
        result=SourceRouter({'baostock':a,'mootdx':t,'lixinger':p}).fetch('daily','688001','2024-01-02','2024-01-02')
        self.assertEqual(result['batch'].source,'mootdx');self.assertEqual(a.calls,[]);self.assertEqual(p.calls,[])
    def test_intraday_chain_avoids_baostock_and_falls_to_sina(self):
        a=FakeSource('baostock',minute(['2024-01-02']));t=FakeSource('mootdx',error=SourceError('EMPTY','empty'));s=FakeSource('sina',minute(['2024-01-02']))
        result=SourceRouter({'baostock':a,'mootdx':t,'sina':s}).fetch('minute5','600519','2024-01-02','2024-01-02',purpose='intraday')
        self.assertEqual(result['batch'].source,'sina');self.assertEqual(a.calls,[])
    def test_annual_minute_requires_calendar_and_rejects_short_history_or_unknown_units(self):
        with self.assertRaises(SourceError) as e:SourceRouter({}).fetch('minute5','600519','2024-01-02','2025-01-01',purpose='annual')
        self.assertEqual(e.exception.code,'CALENDAR_REQUIRED')
        a=FakeSource('baostock',minute(['2024-01-02']));t=FakeSource('mootdx',minute(['2024-01-02','2024-01-03']),unit='provider-unverified');s=FakeSource('sina',minute(['2024-01-03']))
        with self.assertRaises(SourceError) as e:SourceRouter({'baostock':a,'mootdx':t,'sina':s}).fetch('minute5','600519','2024-01-02','2024-01-03',purpose='annual',expected_dates=['2024-01-02','2024-01-03'])
        rejected={r['source']:r.get('code') for r in e.exception.attempts};self.assertEqual(rejected['baostock'],'COVERAGE');self.assertEqual(rejected['mootdx'],'VOLUME_UNIT');self.assertEqual(rejected['sina'],'COVERAGE')
    def test_blacklist_or_budget_does_not_trigger_retries_or_other_vendors(self):
        for code in ['BLACKLIST','BUDGET','CONNECTION_LOCK']:
            a=FakeSource('baostock',error=SourceError(code,'stop'));b=FakeSource('akshare',daily(['2024-01-02']))
            with self.assertRaises(SourceError):SourceRouter({'baostock':a,'akshare':b}).fetch('daily','600519','2024-01-02','2024-01-02')
            self.assertEqual(b.calls,[])
    def test_empty_factor_events_can_be_valid_and_health_probe_has_separate_ttl(self):
        batch=SourceBatch('baostock','adj_factor',[],[],'2024-01-02','2024-01-03',{'eventsOnly':True});validate_batch(batch)
        source=FakeSource('test',daily(['2024-01-02']));probe=Mock(return_value=SourceBatch('test','daily',daily(['2024-01-02']),[],'2024-01-02','2024-01-02'))
        source.check_health();self.assertEqual(probe.call_count,0)
        with patch('sources.time.monotonic',return_value=100):source.check_health(probe);source.check_health(probe)
        self.assertEqual(probe.call_count,1)
        with patch('sources.time.monotonic',return_value=161):source.check_health(probe)
        self.assertEqual(probe.call_count,2)
    def test_hfq_raw_ratio_is_diagnostic_and_date_mismatch_fails(self):
        s=AkShareSource();raw=[{'日期':'2024-01-02','开盘':10,'最高':10,'最低':10,'收盘':10,'成交量':100}];hfq=[{**raw[0],'收盘':20}]
        with patch.object(s,'_stock',side_effect=[raw,hfq]):result=s.get_adj_factor('600519','2024-01-02','2024-01-02')
        self.assertEqual(result.rows[0]['factor'],2);self.assertIn('unverified',result.metadata['causalAdmission'])
        with patch.object(s,'_stock',side_effect=[raw,[{**hfq[0],'日期':'2024-01-03'}]]):
            with self.assertRaises(SourceError):s.get_adj_factor('600519','2024-01-02','2024-01-03')
    def test_tdx_frequency_zero_pages_at_800_without_guessing_volume_unit(self):
        dates=[];d=dt.date(2024,1,2)
        while len(dates)<17:
            if d.weekday()<5:dates.append(d.isoformat())
            d+=dt.timedelta(days=1)
        allrows=[{**r,'datetime':r['date'],'vol':10} for r in minute(dates)]
        client=Mock();client.bars.side_effect=[Frame(allrows[-800:]),Frame(allrows[:-800])]
        with patch('sources.time.sleep'):batch=MootdxSource(client=client).get_minute5('600519',dates[0],dates[-1])
        self.assertEqual(len(batch.rows),816);self.assertEqual(client.bars.call_args_list[0].kwargs['frequency'],0);self.assertEqual(client.bars.call_args_list[1].kwargs['start'],800);self.assertEqual(batch.metadata['volumeUnit'],'provider-unverified')
        with self.assertRaises(SourceError) as e:validate_batch(batch,dates,True)
        self.assertEqual(e.exception.code,'VOLUME_UNIT')
    def test_lixinger_new_key_alias_and_no_paid_health_probe_or_secret_output(self):
        session=Mock();session.post.return_value=Mock(ok=True,json=lambda:{'code':1,'data':[{'date':'2024-01-02','open':10,'close':10,'high':10,'low':10,'volume':100}]})
        with patch.dict('sources.os.environ',{'LIXINGER_API_KEY':'unit-test-private-key'},clear=True):
            source=LixingerSource(session);self.assertTrue(source.available());source.check_health();session.post.assert_not_called();result=source.get_daily('600519','2024-01-02','2024-01-02');self.assertNotIn('unit-test-private-key',json.dumps(result.as_dict()))
            self.assertEqual(session.post.call_args.kwargs['json']['type'],'ex_rights')
            session.post.side_effect=RuntimeError('leak unit-test-private-key')
            with self.assertRaises(SourceError) as e:source.get_daily('600519','2024-01-02','2024-01-02')
            self.assertNotIn('unit-test-private-key',str(e.exception))
    def test_sina_null_at_large_depth_retries_known_short_depth_and_preserves_partial_label(self):
        session=Mock();raw=[{'day':'2024-01-02 09:35:00','open':'10','high':'10','low':'10','close':'10','volume':'100'}]
        session.get.side_effect=[Mock(ok=True,content=b'var _data=(null);'),Mock(ok=True,content=('var _data=('+json.dumps(raw)+');').encode('gbk'))]
        result=SinaSource(session).get_minute5('600519','2024-01-02','2025-01-01');self.assertEqual(result.rows[0]['date'],'2024-01-02 09:35');self.assertEqual(result.metadata['maxBarsRequested'],1970);self.assertEqual(result.as_dict()['metadata']['coverage'],'unverified')
        with self.assertRaises(SourceError):validate_batch(result,['2024-01-02'],True)
    def test_managed_cloud_proxy_is_preserved_and_local_override_is_explicit(self):
        with patch('sources.pathlib.Path.exists',return_value=True),patch.dict('sources.os.environ',{'ASHARE_HTTP_TRUST_ENV':'0'}):
            s=http_session();self.assertTrue(s.trust_env);s.close()
        with patch('sources.pathlib.Path.exists',return_value=False),patch.dict('sources.os.environ',{'ASHARE_HTTP_TRUST_ENV':'0'}):
            s=http_session();self.assertFalse(s.trust_env);s.close()
    def test_akshare_own_sessions_honor_local_proxy_override_and_restore_on_error(self):
        import requests
        for managed in (True,False):
            session=requests.Session();seen=[]
            def request(client,*args,**kwargs):
                seen.append((client.trust_env,kwargs['timeout']));raise RuntimeError('simulated failure')
            with patch('sources.pathlib.Path.exists',return_value=managed),patch.dict('sources.os.environ',{'ASHARE_HTTP_TRUST_ENV':'0'}),patch('requests.sessions.Session.request',request):
                with bounded_requests():
                    with self.assertRaises(RuntimeError):session.get('https://example.invalid')
            self.assertEqual(seen,[(managed,30)]);self.assertTrue(session.trust_env);session.close()
if __name__=='__main__':unittest.main()
