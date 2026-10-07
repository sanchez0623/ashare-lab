"""Offline transport/Parquet tests; fake responses are not real historical data."""
import json,pathlib,sys,tempfile,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
from minute_repair import PageCache,collect,failure_details
from sources import SourceBatch,SourceError
from query_cache import read_proof
from parquet_store import archive

class RepairCollectorTests(unittest.TestCase):
    def test_provider_failures_are_actionable_without_leaking_exception_credentials(self):
        for name,code in [('ProxyError','PROVIDER_PROXY'),('TdxFunctionCallError','PROVIDER_TCP_QUERY')]:
            e=type(name,(Exception,),{})('mock-secret://user:password@host')
            d=failure_details(e);self.assertEqual(d['code'],code);self.assertNotIn('password',d['message']);self.assertIn(name,d['message'])
    def frame(self,n):
        import pandas as pd
        return pd.DataFrame([{'datetime':'2024-01-02 09:35','open':10.,'high':11.,'low':9.,'close':10.,'vol':n}])
    def test_pages_reuse_only_under_identical_anchor_and_preserve_old_namespace(self):
        with tempfile.TemporaryDirectory() as root:
            client=Mock();client.bars.side_effect=[self.frame(100),self.frame(200)]
            params={'symbol':'001389','frequency':0,'offset':800,'adjust':''}
            first=PageCache(client,root,{'runtime':'test'});first.bars(start=0,**params);first.bars(start=800,**params);self.assertEqual(client.bars.call_count,2)
            same=Mock();same.bars.return_value=self.frame(100);second=PageCache(same,root,{'runtime':'test'});second.bars(start=0,**params);self.assertEqual(second.bars(start=800,**params).iloc[0]['vol'],200);self.assertEqual(same.bars.call_count,1)
            changed=Mock();changed.bars.side_effect=[self.frame(101),self.frame(201)];third=PageCache(changed,root,{'runtime':'test'});third.bars(start=0,**params);self.assertEqual(third.bars(start=800,**params).iloc[0]['vol'],201);self.assertEqual(len(list(pathlib.Path(root).glob('*.json'))),4)
    def test_page_tampering_is_not_a_cache_hit(self):
        with tempfile.TemporaryDirectory() as root:
            c=Mock();c.bars.return_value=self.frame(100);cache=PageCache(c,root,{});cache.bars(symbol='001389',frequency=0,start=0,offset=800,adjust='')
            target=next(pathlib.Path(root).glob('*.json'));value=json.loads(target.read_bytes());value['rows'][0]['vol']=999;target.write_text(json.dumps(value))
            with self.assertRaises(RuntimeError):cache.bars(symbol='001389',frequency=0,start=0,offset=800,adjust='')
    def test_completed_second_source_is_reusable_even_without_a_new_network_connection(self):
        with tempfile.TemporaryDirectory() as root:
            batch=SourceBatch('sina','minute5',[{'date':'2024-01-02 09:35','open':10.,'high':11.,'low':9.,'close':10.,'volume':100.}],[{'day':'2024-01-02 09:35:00','open':'10','high':'11','low':'9','close':'10','volume':'100'}],'2024-01-02','2024-01-02',{'priceBasis':'raw','volumeUnit':'shares','nativeTimeframe':'5m'})
            source=Mock(name='sina');source.name='sina';source.dependencies=();source.available.return_value=True;source.readiness.return_value={'state':'ready-unprobed'};source.get_minute5.return_value=batch
            request={'source':'sina','symbol':'001389','range':{'from':'2024-01-02','to':'2024-01-02'},'baseSnapshotId':'a'*64};output=pathlib.Path(root)/'output.json'
            with patch('minute_repair.registry',return_value={'sina':source}):collect(request,pathlib.Path(root)/'cache',output);collect(request,pathlib.Path(root)/'cache',output)
            self.assertEqual(source.get_minute5.call_count,1);saved=json.loads(output.read_bytes());self.assertEqual(json.loads(saved['rawJSON']),saved['raw']);self.assertEqual(saved['symbol'],'001389')
    def test_verified_repair_parquet_is_content_addressed_and_read_back_identical(self):
        with tempfile.TemporaryDirectory() as root:
            b={'metadata':{'symbol':'001389','source':'verified-minute-repair'},'bars':[{'date':'2024-01-02 09:35','close':10.,'volume':123}], 'daily':[{'date':'2024-01-02','close':10.}], 'calendar':['2024-01-02'],'actions':[],'factors':[],'universe':[]}
            first=archive(b,root);second=archive(b,root);self.assertEqual(first,second);self.assertEqual(first['source'],'verified-minute-repair');self.assertEqual(first['tables']['bars']['rows'],1)
if __name__=='__main__':unittest.main()
