import datetime as dt,errno,json,os,pathlib,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
from research_collect import Checkpoints,Blocked,collect,months,network_check,verified_calendar,encode,sha,VERSION

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
        self.calls.append('calendar');day=dt.date.fromisoformat(start_date);last=dt.date.fromisoformat(end_date);rows=[]
        while day<=last:
            rows.append({'calendar_date':day.isoformat(),'is_trading_day':'1' if day.weekday()<5 else '0'});day+=dt.timedelta(days=1)
        return Result(rows)
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
    def test_parquet_durability_uses_windows_compatible_writable_descriptors_and_recovers_from_flush_failure(self):
        from parquet_store import archive
        real_fsync=os.fsync
        if os.name=='nt':windows_commit=real_fsync
        else:
            import fcntl
            def windows_commit(fd):
                # Enforce Windows' writable-handle rule on a real POSIX fd.
                if fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE==os.O_RDONLY:
                    raise OSError(errno.EBADF,'Bad file descriptor')
                return real_fsync(fd)
        bundle={'metadata':{'symbol':'001389','source':'test-only'},'bars':[{'date':'2025-07-08 09:35','close':10.,'volume':100}], 'daily':[{'date':'2025-07-08','close':10.}], 'calendar':['2025-07-08'],'actions':[],'factors':[],'universe':[]}
        with tempfile.TemporaryDirectory() as root:
            with patch('parquet_store.os.fsync',side_effect=OSError(errno.EBADF,'Bad file descriptor')):
                with self.assertRaisesRegex(RuntimeError,'bars.*Bad file descriptor'):archive(bundle,root)
            self.assertFalse(list(pathlib.Path(root).rglob('*.tmp-*')));self.assertFalse(list(pathlib.Path(root).rglob('*.receipt.json')))
            with patch('parquet_store.os.fsync',side_effect=windows_commit):
                first=archive(bundle,root);second=archive(bundle,root)
            self.assertEqual(first,second);self.assertEqual(len(first['tables']),6);self.assertEqual(first['tables']['bars']['rows'],1)
    def test_archive_failure_resumes_from_existing_verified_query_checkpoints(self):
        request={'symbol':'001389','board':'main','purpose':'collect','from':'2025-10-01','to':'2026-09-30','warmupSessions':60}
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);bs=FakeSDK();bs.fail=False
            with patch('parquet_store.archive',side_effect=OSError(errno.EBADF,'Bad file descriptor')):
                with self.assertRaises(Blocked) as e:collect(request,base/'job',base/'market',bs=bs)
            self.assertEqual(e.exception.code,'PARQUET_ARCHIVE');calls=list(bs.calls)
            result=collect(request,base/'job',base/'market',bs=bs)
            self.assertEqual(bs.calls,calls);self.assertEqual(len(result['metadata']['parquetArchive']['tables']),6)
    def test_partial_calendar_stops_before_daily_dividends_or_minutes(self):
        # A 6,000-day prefix ends in 2007; the prior [-60] calculation could
        # mistakenly request almost two decades of minutes for a 2025 task.
        request={'symbol':'001389','board':'main','purpose':'collect','from':'2025-10-01','to':'2026-09-30','warmupSessions':60}
        with tempfile.TemporaryDirectory() as root:
            bs=FakeSDK();bs.fail=False;original=bs.query_trade_dates
            def truncated(start_date,end_date):return Result(original(start_date,end_date).rows[:6000])
            with patch.object(bs,'query_trade_dates',side_effect=truncated),self.assertRaises(Blocked) as e:
                collect(request,pathlib.Path(root)/'job',pathlib.Path(root)/'market',bs=bs)
            self.assertEqual(e.exception.code,'CALENDAR_INCOMPLETE');self.assertEqual(bs.calls,['calendar'])
            self.assertEqual(list((pathlib.Path(root)/'job/queries').glob('*.json')),[])
    def test_resume_quarantines_a_hash_valid_partial_calendar_and_uses_nearest_warmup(self):
        request={'symbol':'001389','board':'main','purpose':'collect','from':'2025-10-01','to':'2026-09-30','warmupSessions':60}
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);queries=base/'job/queries';queries.mkdir(parents=True);bs=FakeSDK();bs.fail=False
            key=['calendar','1990-12-19',request['to']];identity={'version':VERSION,'query':key};name=sha(encode(identity));rows=bs.query_trade_dates(start_date=key[1],end_date=key[2]).rows[:6000];bs.calls=[]
            (queries/(name+'.json')).write_bytes(encode({'identity':identity,'sha256':sha(encode(rows)),'rows':rows}))
            events=[];bundle=collect(request,base/'job',base/'market',emit=events.append,bs=bs)
            expected=bs.days('2025-01-01','2025-09-30')[-60]
            self.assertEqual(bundle['metadata']['requested']['from'],expected);self.assertEqual(bs.calls.count('calendar'),1)
            self.assertEqual(len(list((base/'job/quarantine').glob('*.json'))),1)
            self.assertTrue(any('隔离' in e.get('message','') for e in events));self.assertTrue(any(e.get('collectionRange',{}).get('from')==expected for e in events))
            self.assertTrue(all(c.split(':')[1]>=expected for c in bs.calls if c.startswith('5:')))
            self.assertFalse(any(p['query'][0]=='dividends' and p['query'][2]<2024 for p in bundle['metadata']['provenance']['queries'].values()))
    def test_unordered_complete_calendar_is_sorted_and_holes_duplicates_and_flags_rejected(self):
        rows=[{'calendar_date':'2025-09-30','is_trading_day':'1'},{'calendar_date':'2025-09-28','is_trading_day':'0'},{'calendar_date':'2025-09-29','is_trading_day':'1'}]
        self.assertEqual([r['calendar_date'] for r in verified_calendar(rows,'2025-09-28','2025-09-30')],['2025-09-28','2025-09-29','2025-09-30'])
        for broken in [rows[:-1],rows+[rows[0]],[{**r,'is_trading_day':'bad'} for r in rows]]:
            with self.assertRaises(Blocked):verified_calendar(broken,'2025-09-28','2025-09-30')
        request={'symbol':'001389','board':'main','purpose':'collect','from':'2025-10-01','to':'2026-09-30','warmupSessions':60}
        with tempfile.TemporaryDirectory() as root:
            bs=FakeSDK();bs.fail=False;original=bs.query_trade_dates
            def reversed_rows(start_date,end_date):return Result(list(reversed(original(start_date,end_date).rows)))
            with patch.object(bs,'query_trade_dates',side_effect=reversed_rows):bundle=collect(request,pathlib.Path(root)/'job',pathlib.Path(root)/'market',bs=bs)
            self.assertEqual(bundle['metadata']['requested']['from'],bs.days('2025-01-01','2025-09-30')[-60]);self.assertEqual(bundle['calendar'],sorted(bundle['calendar']))
    def test_collection_only_never_queries_membership_and_timing_does_not_change_evidence(self):
        request={'symbol':'600519','board':'main','purpose':'collect','from':'2024-05-01','to':'2025-04-30','warmupSessions':60}
        with tempfile.TemporaryDirectory() as root:
            bs=FakeSDK();bs.fail=False;events=[];base=pathlib.Path(root)
            with patch.object(bs,'query_hs300_stocks',side_effect=AssertionError('仅采集不应查询成分')):
                first=collect(request,base/'job',base/'market',emit=events.append,bs=bs)
                body=(base/'job/bundle.json').read_bytes();collect(request,base/'job',base/'market',emit=events.append,bs=bs)
                self.assertEqual((base/'job/bundle.json').read_bytes(),body)
            self.assertEqual(first['universe'],[]);self.assertEqual(first['metadata']['universe'],'SINGLE_SECURITY')
            self.assertEqual(first['metadata']['coverage']['universe']['status'],'not-requested')
            self.assertFalse(any(p['query'][0]=='hs300' for p in first['metadata']['provenance']['queries'].values()))
            completed=[e for e in events if e.get('phase')=='query-complete'];self.assertTrue(completed)
            self.assertTrue(all(e['queryElapsedMs']>=0 and e['rateWaitMs']>=0 for e in completed));self.assertTrue(any(e['cached'] for e in completed))
            self.assertFalse(any('queryElapsedMs' in p for p in first['metadata']['provenance']['queries'].values()))
    def test_partial_query_logs_elapsed_but_never_saves_a_completed_checkpoint(self):
        with tempfile.TemporaryDirectory() as root:
            events=[];cache=Checkpoints(root,emit=events.append)
            def fail():raise RuntimeError('中断测试')
            with self.assertRaisesRegex(RuntimeError,'中断测试'):cache.query(['minute','partial'],fail)
            self.assertEqual([e['phase'] for e in events],['query-start','query-error']);self.assertGreaterEqual(events[-1]['queryElapsedMs'],0)
            self.assertEqual(cache.proofs,{});self.assertEqual(list(pathlib.Path(root).glob('*.json')),[])
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
