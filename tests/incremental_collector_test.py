"""SDK transport fixtures; no test contacts BaoStock or claims real data."""
import json,pathlib,shutil,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
from research_collect import collect,encode,sha
from query_cache import SLOTS,read_proof,SharedQueries,query_identity,digest
from research_collector_test import FakeSDK,Result

class CompleteSDK(FakeSDK):
    def __init__(self):super().__init__();self.fail=False;self.minute_requests=[];self.missing=set();self.changed=set()
    def query_stock_basic(self,code):self.calls.append('basic');return Result([{'code':code,'ipoDate':'2000-01-04','outDate':'','code_name':'SYNTHETIC TRANSPORT FIXTURE'}])
    def query_history_k_data_plus(self,code,fields,start_date,end_date,frequency,adjustflag):
        self.calls.append(frequency+':'+start_date)
        if frequency=='5':self.minute_requests.append((code,start_date,end_date))
        rows=[]
        for day in self.days(start_date,end_date):
            price='11' if day in self.changed else '10'
            common={'date':day,'code':code,'open':price,'high':price,'low':price,'close':price,'volume':'10000','amount':'100000'}
            if frequency=='d':rows.append({**common,'preclose':'10','tradestatus':'1','isST':'0','volume':'480000'})
            else:
                for slot in SLOTS[:-1] if day in self.missing else SLOTS:
                    rows.append({**common,'time':day.replace('-','')+slot+'00000','adjustflag':'3'})
        return Result(rows)

def request(start='2025-10-01',end='2026-09-30',symbol='600519',purpose='collect'):
    return {'symbol':symbol,'board':'main','purpose':purpose,'from':start,'to':end,'warmupSessions':60}
def run(base,name,req,bs,events=None):return collect(req,base/'jobs'/name/'collection',base/'market',bs=bs,emit=(events.append if events is not None else lambda _:None))

class IncrementalCollectorTests(unittest.TestCase):
    def test_three_stocks_three_years_reuse_existing_year_and_shared_calendar(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);first=CompleteSDK();old=run(base,'old',request(),first)
            immutable=(base/'jobs/old/collection/bundle.json').read_bytes();warm=old['metadata']['requested']['from'];results=[]
            for index,symbol in enumerate(['600519','601318','000001']):
                sdk=CompleteSDK();events=[];bundle=run(base,'new'+str(index),request('2023-10-01',symbol=symbol),sdk,events);results.append(bundle)
                self.assertNotIn('calendar',sdk.calls)
                if index==0:
                    self.assertGreater(bundle['metadata']['incrementalPlan']['reusedTradingDays'],250)
                    self.assertTrue(sdk.minute_requests)
                    self.assertTrue(all(end<warm for _,start,end in sdk.minute_requests))
                    self.assertTrue(any('跨任务复用原始5分钟' in e.get('message','') for e in events))
                    original=[b for b in old['bars'] if b['date'][:10]>=warm]
                    self.assertEqual([b for b in bundle['bars'] if b['date'][:10]>=warm],original)
                    # Corporate metadata is refreshed for the new research range.
                    self.assertIn('factors',sdk.calls);self.assertIn('dividends',sdk.calls)
                else:self.assertEqual(bundle['metadata']['incrementalPlan']['reusedTradingDays'],0)
                self.assertEqual(bundle['metadata']['requested']['to'],'2026-09-30')
            self.assertEqual((base/'jobs/old/collection/bundle.json').read_bytes(),immutable)
            repeated=CompleteSDK();run(base,'new0',request('2023-10-01'),repeated)
            self.assertEqual(repeated.calls,[]);self.assertEqual((base/'jobs/new0/collection/bundle.json').read_bytes(),encode(results[0]))
    def test_only_missing_day_is_refetched_not_the_whole_cached_month(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-02-01','2025-04-30');first=CompleteSDK();first.missing={'2025-03-17'};run(base,'old',req,first)
            second=CompleteSDK();bundle=run(base,'new',req,second)
            self.assertEqual(second.minute_requests,[('sh.600519','2025-03-17','2025-03-17')])
            self.assertEqual(len([b for b in bundle['bars'] if b['date'].startswith('2025-03-17')]),48)
    def test_fresh_daily_mismatch_invalidates_reuse_and_preserves_revision_conflicts(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-02-01','2025-04-30');run(base,'old',req,CompleteSDK());body=(base/'jobs/old/collection/bundle.json').read_bytes()
            second=CompleteSDK();second.changed={'2025-03-17'};bundle=run(base,'new',req,second)
            self.assertEqual(second.minute_requests,[('sh.600519','2025-03-17','2025-03-17')]);self.assertTrue(bundle['metadata']['conflicts'])
            self.assertEqual((base/'jobs/old/collection/bundle.json').read_bytes(),body)
    def test_legacy_responses_are_imported_without_trusting_market_price_files(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-02-01','2025-04-30');run(base,'old',req,CompleteSDK());shutil.rmtree(base/'market/query-cache')
            second=CompleteSDK();events=[];bundle=run(base,'new',req,second,events)
            self.assertEqual(second.minute_requests,[]);self.assertNotIn('calendar',second.calls)
            self.assertGreater(bundle['metadata']['incrementalPlan']['reusedTradingDays'],60);self.assertTrue(any('旧任务原始响应证明' in e.get('message','') for e in events))
            # An unrelated runtime cannot import these proofs.
            shutil.rmtree(base/'market/query-cache')
            with patch('research_collect.sys.version','9.9.9 transport-fixture'):
                third=CompleteSDK();isolated=run(base,'other-runtime',req,third)
            self.assertTrue(third.minute_requests);self.assertEqual(isolated['metadata']['incrementalPlan']['reusedTradingDays'],0)
    def test_hash_valid_incomplete_calendar_cannot_poison_shared_calendar(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-02-01','2025-04-30');run(base,'old',req,CompleteSDK());shutil.rmtree(base/'market/query-cache')
            for path in (base/'jobs/old/collection/queries').glob('*.json'):
                proof=read_proof(path)
                if proof['identity']['query'][0]=='calendar':
                    proof['rows']=proof['rows'][:6000];proof['sha256']=sha(encode(proof['rows']));path.write_bytes(encode(proof))
            second=CompleteSDK();bundle=run(base,'new',req,second)
            self.assertEqual(second.calls.count('calendar'),1);self.assertGreater(bundle['metadata']['requested']['from'],'2024-01-01')
            self.assertTrue(list((base/'market/query-cache').glob('*/quarantine/*')))
    def test_shared_hash_tampering_and_frozen_plan_tampering_are_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-02-01','2025-04-30');run(base,'old',req,CompleteSDK())
            path=next((base/'market/query-cache').glob('*/minute/sh.600519/*.json'));proof=json.loads(path.read_bytes());proof['rows'][0]['close']='999';path.write_bytes(encode(proof))
            sdk=CompleteSDK()
            with self.assertRaisesRegex(RuntimeError,'哈希'):run(base,'new',req,sdk)
            self.assertEqual(sdk.minute_requests,[])
            plan=base/'jobs/old/collection/minute-plan.json';value=json.loads(plan.read_bytes());value['entries'][0]['from']='1990-01-01';plan.write_bytes(encode(value))
            with self.assertRaisesRegex(RuntimeError,'增量采集计划'):run(base,'old',req,CompleteSDK())
    def test_conflicting_native_paths_cannot_win_by_directory_order(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-02-01','2025-04-30');run(base,'old',req,CompleteSDK())
            environment=json.loads((base/'jobs/old/collection/environment.json').read_bytes());shared=SharedQueries(base/'market/query-cache',environment,environment['collectorVersion'])
            rows=CompleteSDK().query_history_k_data_plus('sh.600519','',start_date='2025-03-17',end_date='2025-03-17',frequency='5',adjustflag='3').rows
            rows[0]['high']='11' # same daily close/volume; different intraday path
            key=['minute','sh.600519','5','2025-03-17','2025-03-17','raw'];shared.put({'identity':query_identity(environment['collectorVersion'],key),'rows':rows,'sha256':digest(rows)})
            sdk=CompleteSDK();bundle=run(base,'new',req,sdk)
            self.assertEqual(sdk.minute_requests,[('sh.600519','2025-03-17','2025-03-17')]);self.assertIn('2025-03-17',bundle['metadata']['incrementalPlan']['cacheConflictDays'])
            self.assertTrue(any(c.get('source')=='shared-response' for c in bundle['metadata']['conflicts']))
            body=(base/'jobs/new/collection/bundle.json').read_bytes();run(base,'new',req,CompleteSDK());self.assertEqual((base/'jobs/new/collection/bundle.json').read_bytes(),body)
    def test_research_membership_queries_are_shared_but_collection_does_not_request_them(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);req=request('2025-03-01','2025-03-10',purpose='research');first=CompleteSDK();run(base,'old',req,first)
            second=CompleteSDK();other=run(base,'new',{**req,'symbol':'601318'},second)
            self.assertTrue(any(c.startswith('hs300:') for c in first.calls));self.assertFalse(any(c.startswith('hs300:') for c in second.calls));self.assertTrue(other['universe'])
            third=CompleteSDK();plain=run(base,'plain',{**req,'purpose':'collect','symbol':'000001'},third)
            self.assertEqual(plain['universe'],[]);self.assertFalse(any(c.startswith('hs300:') for c in third.calls))
    def test_interrupted_gap_plan_does_not_expand_or_redownload_finished_pieces(self):
        with tempfile.TemporaryDirectory() as root:
            base=pathlib.Path(root);run(base,'old',request('2025-02-01','2025-04-30'),CompleteSDK());req=request('2024-08-01','2025-04-30');sdk=CompleteSDK();original=sdk.query_history_k_data_plus
            def interrupt(*args,**kw):
                if kw['frequency']=='5' and len(sdk.minute_requests)==1:raise RuntimeError('fixture interrupted')
                return original(*args,**kw)
            with patch.object(sdk,'query_history_k_data_plus',side_effect=interrupt),self.assertRaisesRegex(RuntimeError,'interrupted'):run(base,'new',req,sdk)
            plan=(base/'jobs/new/collection/minute-plan.json').read_bytes();first_request=sdk.minute_requests[0];run(base,'new',req,sdk)
            self.assertEqual(sdk.minute_requests.count(first_request),1);self.assertEqual((base/'jobs/new/collection/minute-plan.json').read_bytes(),plan)
            body=(base/'jobs/new/collection/bundle.json').read_bytes();calls=len(sdk.calls);run(base,'new',req,sdk)
            self.assertEqual(len(sdk.calls),calls);self.assertEqual((base/'jobs/new/collection/bundle.json').read_bytes(),body)

if __name__=='__main__':unittest.main()
