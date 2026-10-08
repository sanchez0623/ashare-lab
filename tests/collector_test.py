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
 def test_wait_and_sdk_send_counters_measure_actual_throttle_without_raising_limits(self):
  with tempfile.TemporaryDirectory() as root:
   g=TrafficGuard(pathlib.Path(root)/'budget.db',limit=2)
   try:
    with patch('baostock_guard.time.time',return_value=100),patch('baostock_guard.time.sleep') as sleep,patch('baostock_guard.time.perf_counter',side_effect=[10,11]):
     g.reserve();g.reserve();self.assertEqual(sleep.call_count,1)
    self.assertEqual(g.session_requests,2);self.assertEqual(g.session_wait_ms,1000)
    with self.assertRaisesRegex(RuntimeError,'预算'):g.reserve()
    self.assertEqual(g.session_requests,2)
   finally:g.close()
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
 def test_empty_sdk_pagination_response_raises_instead_of_silently_finishing_partial_rows(self):
  import baostock.util.socketutil as sock
  from baostock.data.resultset import ResultData
  from baostock.common import contants as cons
  for response in [None,'','   ']:
   with self.subTest(response=response),tempfile.TemporaryDirectory() as root:
    guard=TrafficGuard(pathlib.Path(root)/'budget.db')
    with patch.object(sock,'send_msg',return_value=response) as remote:
     try:
      rs=ResultData();rs.error_code='0';rs.data=[['test']]*cons.BAOSTOCK_PER_PAGE_COUNT;rs.cur_row_num=len(rs.data);rs.cur_page_num='1';rs.msg_body=cons.MESSAGE_SPLIT.join(['calendar','user','1','2000','start','end']);rs.msg_type=cons.MESSAGE_TYPE_QUERYTRADEDATES_REQUEST
      self.assertFalse(rs.next());self.assertEqual(rs.error_code,'0');remote.reset_mock()
      restore=install(guard)
      with self.assertRaises(RuntimeError) as e:rs.next()
      self.assertEqual(e.exception.code,'PROVIDER_RESPONSE_INCOMPLETE');self.assertEqual(remote.call_count,1)
     finally:restore();guard.close()
 def test_sdk_eof_stops_immediately_and_records_login_phase_and_one_request(self):
  import baostock.util.socketutil as sock
  from baostock.common import contants as cons
  from baostock.data import messageheader
  class ClosedSocket:
   def __init__(self):self.sent=[];self.reads=0
   def sendall(self,data):self.sent.append(data)
   def recv(self,size):self.reads+=1;return b''
  connection=ClosedSocket()
  with tempfile.TemporaryDirectory() as root,patch.object(sock.context,'default_socket',connection,create=True):
   guard=TrafficGuard(pathlib.Path(root)/'budget.db');restore=install(guard)
   try:
    with self.assertRaises(RuntimeError) as caught:sock.send_msg(messageheader.to_message_header(cons.MESSAGE_TYPE_LOGIN_REQUEST,0))
    self.assertEqual(caught.exception.code,'PROVIDER_RESPONSE_INCOMPLETE');self.assertEqual(caught.exception.details['requestStage'],'登录');self.assertEqual(caught.exception.details['transportReason'],'peer-closed')
    self.assertEqual(connection.reads,1);self.assertEqual(len(connection.sent),1);self.assertTrue(connection.sent[0].endswith(b'\n'));self.assertIs(sock.context.default_socket,connection);self.assertEqual(guard.session_requests,1)
   finally:restore();guard.close()
 def test_sdk_retains_protocol_decoding_for_fragmented_complete_response(self):
  import baostock.util.socketutil as sock
  from baostock.common import contants as cons
  from baostock.data import messageheader
  body='0'+cons.MESSAGE_SPLIT+'success';response=messageheader.to_message_header(cons.MESSAGE_TYPE_LOGIN_REQUEST,len(body))+body+'<![CDATA[]]>\n'
  class CompleteSocket:
   def __init__(self):self.sent=[];self.parts=iter([response[:9].encode(),response[9:].encode()])
   def sendall(self,data):self.sent.append(data)
   def recv(self,size):return next(self.parts)
  connection=CompleteSocket()
  with tempfile.TemporaryDirectory() as root,patch.object(sock.context,'default_socket',connection,create=True):
   guard=TrafficGuard(pathlib.Path(root)/'budget.db');restore=install(guard)
   try:
    self.assertEqual(sock.send_msg('fixture-query'),response);self.assertEqual(guard.session_requests,1);self.assertEqual(connection.sent,[b'fixture-query\n']);self.assertIs(sock.context.default_socket,connection)
   finally:restore();guard.close()
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
