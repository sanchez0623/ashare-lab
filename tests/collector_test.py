import importlib.util,json,pathlib,sqlite3,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
import sync
from baostock_guard import TrafficGuard,install
from hs300 import fetch
class CollectTests(unittest.TestCase):
 def test_budget_and_connection_lock_are_durable(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'budget.db';g=TrafficGuard(path,limit=2)
   with self.assertRaises(RuntimeError):TrafficGuard(path,limit=2)
   with patch('baostock_guard.time.sleep'),patch('baostock_guard.time.time',return_value=100):g.reserve();g.reserve()
   with self.assertRaisesRegex(RuntimeError,'预算'):g.reserve()
   g.close();g=TrafficGuard(path,limit=2)
   with self.assertRaisesRegex(RuntimeError,'预算'):g.reserve()
   g.close()
 def test_blocked_sdk_does_not_retry_or_send_again(self):
  import baostock.util.socketutil as sock
  with tempfile.TemporaryDirectory() as root:
   g=TrafficGuard(pathlib.Path(root)/'budget.db')
   with patch.object(sock,'send_msg',return_value=' ' * __import__('baostock.common.contants',fromlist=['MESSAGE_HEADER_LENGTH']).MESSAGE_HEADER_LENGTH+'10001011'+__import__('baostock.common.contants',fromlist=['MESSAGE_SPLIT']).MESSAGE_SPLIT+'黑名单') as remote:
    restore=install(g)
    try:
     with self.assertRaisesRegex(RuntimeError,'10001011'):sock.send_msg('query')
     with self.assertRaisesRegex(RuntimeError,'本日采集停止'):sock.send_msg('query2')
     self.assertEqual(remote.call_count,1)
    finally:restore();g.close()
 def test_repeated_minutes_are_idempotent_and_revisions_quarantined(self):
  with tempfile.TemporaryDirectory() as root:
   db=sync.db_open(pathlib.Path(root)/'market.db');r={'date':'2024-01-02 09:35','close':10}
   sync.merge_bars(db,'test','600519','5m',[r],'a');sync.merge_bars(db,'test','600519','5m',[r],'b');sync.merge_bars(db,'test','600519','5m',[{**r,'close':11}],'c')
   self.assertEqual(json.loads(db.execute('SELECT payload FROM bars').fetchone()[0])['close'],10);self.assertEqual(db.execute('SELECT COUNT(*) FROM bars').fetchone()[0],1);self.assertEqual(db.execute('SELECT COUNT(*) FROM conflicts').fetchone()[0],1);db.close()
 def test_membership_cache_rejects_future_and_has_no_open_time_assumption(self):
  class Result:
   fields=['updateDate','code'];error_code='0'
   def __init__(self,date):self.date=date;self.i=-1
   def next(self):self.i+=1;return self.i<300
   def get_row_data(self):return [self.date,'sh.'+str(600000+self.i)]
  class BS:
   calls=0
   def query_hs300_stocks(self,date):self.calls+=1;return Result(date)
  with tempfile.TemporaryDirectory() as root:
   bs=BS();r=fetch(bs,['2024-01-02'],root);fetch(bs,['2024-01-02'],root);self.assertEqual(bs.calls,1);self.assertEqual(r[0]['knownAt'],'2024-01-02 15:00')
if __name__=='__main__':unittest.main()
