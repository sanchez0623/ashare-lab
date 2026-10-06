import datetime as dt,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
from research_collect import Checkpoints,Blocked,collect,months,network_check

class Result:
    error_code='0';error_msg=''
    def __init__(self,rows):self.rows=rows;self.fields=list(rows[0]) if rows else [];self.i=-1
    def next(self):self.i+=1;return self.i<len(self.rows)
    def get_row_data(self):return [self.rows[self.i][f] for f in self.fields]
class FakeSDK:
    """Transport fixture only; cannot be used by the production CLI."""
    __version__='synthetic-test';calls=[]
    def __init__(self):self.calls=[];self.fail=True
    def login(self):return Result([])
    def logout(self):return Result([])
    def days(self,start,end):
        d=dt.date.fromisoformat(start);last=dt.date.fromisoformat(end);rows=[]
        while d<=last:
            if d.weekday()<5:rows.append(d.isoformat())
            d+=dt.timedelta(days=1)
        return rows
    def query_trade_dates(self,start_date,end_date):
        self.calls.append('calendar');return Result([{'calendar_date':d,'is_trading_day':'1'} for d in self.days('2024-01-02',end_date)])
    def query_stock_basic(self,code):self.calls.append('basic');return Result([{'code':code,'ipoDate':'2024-01-02','code_name':'TEST FIXTURE'}])
    def query_adjust_factor(self,code,**kw):self.calls.append('factors');return Result([])
    def query_dividend_data(self,code,**kw):self.calls.append('dividends');return Result([])
    def query_hs300_stocks(self,date):self.calls.append('hs300:'+date);return Result([{'code':c,'updateDate':date} for c in ['sh.600519']+['sh.'+str(600000+i) for i in range(299)]])
    def query_history_k_data_plus(self,code,fields,start_date,end_date,frequency,adjustflag):
        key=frequency+':'+start_date;self.calls.append(key)
        if frequency=='5' and len([c for c in self.calls if c.startswith('5:')])==2 and self.fail:raise RuntimeError('模拟第二个月断网')
        rows=[]
        for d in self.days(start_date,end_date):
            r={'date':d,'code':code,'open':'10','high':'10','low':'10','close':'10','volume':'10000','amount':'100000'}
            if frequency=='d':r.update(preclose='10',tradestatus='1',isST='0')
            else:r.update(time=d.replace('-','')+'093500000',adjustflag='3')
            rows.append(r)
        return Result(rows)

class ResearchCollectorTests(unittest.TestCase):
    def test_checkpoint_hash_and_partial_response(self):
        with tempfile.TemporaryDirectory() as root:
            cache=Checkpoints(root);count=[0]
            def response():count[0]+=1;return [{'date':'2024-01-02'}]
            cache.query(['month',1],response);cache.query(['month',1],response);self.assertEqual(count[0],1)
            def partial():raise RuntimeError('分页未完成')
            with self.assertRaises(RuntimeError):cache.query(['month',2],partial)
            self.assertEqual(len(list(pathlib.Path(root).glob('*.json'))),1)
            p=next(pathlib.Path(root).glob('*.json'));x=json.loads(p.read_text());x['rows'][0]['date']='2025-01-02';p.write_text(json.dumps(x))
            with self.assertRaisesRegex(Blocked,'哈希'):cache.query(['month',1],response)
    def test_resume_reuses_prior_month_and_independent_metadata_queries(self):
        request={'symbol':'600519','board':'main','from':'2024-05-01','to':'2025-04-30','warmupSessions':60}
        with tempfile.TemporaryDirectory() as root:
            bs=FakeSDK();base=pathlib.Path(root)
            with self.assertRaisesRegex(RuntimeError,'第二个月'):collect(request,base/'job',base/'market',bs=bs)
            first=[c for c in bs.calls if c.startswith('5:')][0];bs.fail=False;bundle=collect(request,base/'job',base/'market',bs=bs)
            self.assertEqual(bs.calls.count(first),1);self.assertEqual(bs.calls.count('calendar'),1);self.assertEqual(bs.calls.count('basic'),1)
            self.assertEqual(bundle['metadata']['timeframe'],'5m');self.assertEqual(bundle['metadata']['conflicts'],[])
            before=(base/'job/bundle.json').read_bytes();collect(request,base/'job',base/'market',bs=bs);self.assertEqual((base/'job/bundle.json').read_bytes(),before)
            self.assertEqual(bundle['metadata']['providerDuplicates'],[])
            self.assertEqual(len(bundle['metadata']['parquetArchive']['tables']),6)
    def test_parquet_roundtrip_includes_sparse_columns_and_rejects_modified_bytes(self):
        from parquet_store import archive
        import pyarrow.parquet as pq
        bundle={'metadata':{'symbol':'600519','source':'test-only'},'bars':[{'close':10.,'volume':100}], 'daily':[{'causalFactor':1},{'causalFactor':1.02,'specialSession':1}],'calendar':['2024-01-02'],'actions':[],'factors':[],'universe':[]}
        with tempfile.TemporaryDirectory() as root:
            first=archive(bundle,root);second=archive(bundle,root);self.assertEqual(first,second)
            daily=pathlib.Path(root)/first['tables']['daily']['path'];rows=pq.read_table(daily).to_pylist();self.assertEqual(rows[1]['specialSession'],1);self.assertIsNone(rows[0]['specialSession']);self.assertEqual(rows[0]['causalFactor'],1)
            p=pathlib.Path(root)/first['tables']['bars']['path'];p.write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError,'哈希'):archive(bundle,root)
    def test_custom_short_and_multiyear_collect_exact_bounds_and_separate_warmup(self):
        # SDK transport fixtures exercise the real month/checkpoint/archive
        # flow; their one-bar days do not qualify as formal market data.
        for start,end in [('2024-05-15','2024-06-04'),('2024-05-01','2026-09-30')]:
            with self.subTest(start=start,end=end),tempfile.TemporaryDirectory() as root:
                request={'symbol':'600519','board':'main','rangeMode':'custom','from':start,'to':end,'warmupSessions':60}
                bs=FakeSDK();bs.fail=False;base=pathlib.Path(root)
                bundle=collect(request,base/'job',base/'market',bs=bs)
                metadata=bundle['metadata'];warm=bs.days('2024-01-02',start)[:-1] if dt.date.fromisoformat(start).weekday()<5 else bs.days('2024-01-02',start)
                self.assertEqual(metadata['requested'],{'from':warm[-60],'to':end})
                self.assertEqual(metadata['research'],{'from':start,'to':end,'warmupSessions':60})
                proofs=metadata['provenance']['queries'].values();queries=[p['query'] for p in proofs if p['query'][0]=='minute']
                self.assertEqual([(q[3],q[4]) for q in queries],list(months(warm[-60],end)))
                self.assertEqual(min(b['date'][:10] for b in bundle['bars']),warm[-60]);self.assertEqual(max(b['date'][:10] for b in bundle['bars']),end)
                before=(base/'job/bundle.json').read_bytes();count=len(bs.calls);collect(request,base/'job',base/'market',bs=bs)
                self.assertEqual(len(bs.calls),count);self.assertEqual((base/'job/bundle.json').read_bytes(),before)
    def test_pause_and_network_block_do_not_open_a_socket(self):
        with patch('research_collect.pathlib.Path.exists',return_value=True),patch('research_collect.pathlib.Path.read_text',return_value='{"tcp_network_access":{"domains":[],"ip_ranges":[]}}'):
            with self.assertRaises(Blocked) as e:network_check()
            self.assertEqual(e.exception.code,'NETWORK_TCP_NOT_GRANTED')
        with tempfile.TemporaryDirectory() as root:
            p=pathlib.Path(root);(p/'cancel').write_text('pause');cache=Checkpoints(p,check=lambda:(_ for _ in ()).throw(Blocked('PAUSED','pause')))
            with self.assertRaises(Blocked):cache.query(['q'],lambda:self.fail('不应发起查询'))
    def test_month_ranges_never_overlap_or_cross_requested_end(self):
        self.assertEqual(list(months('2024-02-20','2024-04-02')),[('2024-02-20','2024-02-29'),('2024-03-01','2024-03-31'),('2024-04-01','2024-04-02')])
if __name__=='__main__':unittest.main()
