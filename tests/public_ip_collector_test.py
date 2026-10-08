import datetime as dt,json,pathlib,sqlite3,sys,tempfile,unittest,os,urllib.request
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
import public_ip
from baostock_guard import TrafficGuard,inspect_usage,today

class IPTests(unittest.TestCase):
 def setUp(self):public_ip._IP_CACHE.clear()
 def test_override_is_public_ipv4_only_and_never_probes(self):
  def fail(*args):raise AssertionError('network must not run')
  value=public_ip.public_ip(env={'BS_MONITOR_IP':'9.9.9.9'},fetch=fail,clock=lambda:1000)
  self.assertEqual(value['ip'],'9.9.9.9');self.assertEqual(value['source'],'environment');self.assertFalse(value['tcpEgressVerified'])
  for ip in ['192.168.1.1','127.0.0.1','2001:4860:4860::8888','hello9.9.9.9','999.1.1.1','224.0.0.1']:
   self.assertEqual(public_ip.public_ip(env={'BS_MONITOR_IP':ip},fetch=fail)['source'],'invalid-environment')
 def test_echo_fallback_proxy_awareness_and_cross_process_cache_expiry(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'cache.json';calls=[];stamp=[1000]
   def fetch(url):calls.append(url);return '192.168.1.1' if len(calls)==1 else '当前 IP：9.9.9.9'
   env={'HTTPS_PROXY':'http://user:mock-secret@proxy.example:8080'}
   first=public_ip.public_ip(path,env=env,clock=lambda:stamp[0],fetch=fetch)
   self.assertEqual(calls,list(public_ip._IP_ECHO_URLS[:2]));self.assertEqual(first['ip'],'9.9.9.9');self.assertTrue(first['httpProxyDetected']);self.assertFalse(first['tcpEgressVerified']);self.assertNotIn('mock-secret',path.read_text(encoding='utf-8'));self.assertNotIn('user:',path.read_text(encoding='utf-8'))
   public_ip._IP_CACHE.clear();stamp[0]=1599
   second=public_ip.public_ip(path,env=env,clock=lambda:stamp[0],fetch=fetch);self.assertTrue(second['cached']);self.assertEqual(second['cacheAgeSeconds'],599);self.assertEqual(len(calls),2)
   stamp[0]=1600;public_ip.public_ip(path,env=env,clock=lambda:stamp[0],fetch=fetch);self.assertEqual(len(calls),3)
 def test_direct_probe_bypasses_configured_http_proxy(self):
  # BaoStock dials the provider with a raw TCP socket, which never uses
  # HTTP_PROXY/HTTPS_PROXY or a Windows system proxy; nor may the probe.
  env={'HTTPS_PROXY':'http://127.0.0.1:7897','HTTP_PROXY':'http://127.0.0.1:7897'}
  # Isolate this mocked opener from inherited lowercase proxy variables.
  # No network request is made, and the real process environment is restored.
  with patch.dict(os.environ,env,clear=True):
   # ProxyHandler registers one <scheme>_open dispatcher per configured proxy, so
   # an empty mapping registers none and the opener cannot reach a proxy at all.
   def proxies(use_proxy):return [h.proxies for h in public_ip._opener(use_proxy).handlers if isinstance(h,urllib.request.ProxyHandler)]
   self.assertEqual(proxies(False),[])
   enabled=proxies(True);self.assertEqual(len(enabled),1);self.assertEqual(enabled[0].get('https'),'http://127.0.0.1:7897')
 def test_proxy_exit_is_diagnostic_only_when_direct_egress_is_invisible(self):
  with tempfile.TemporaryDirectory() as root:
   direct_calls=[];proxy_calls=[]
   def direct(url):direct_calls.append(url);return None
   def proxied(url):proxy_calls.append(url);return '13.214.76.191'
   value=public_ip.public_ip(pathlib.Path(root)/'c.json',env={'HTTPS_PROXY':'http://127.0.0.1:7897'},clock=lambda:1000,fetch=direct,interface=lambda:'192.168.1.2',proxy_fetch=proxied)
   self.assertEqual(direct_calls,list(public_ip._IP_ECHO_URLS));self.assertEqual(proxy_calls,[public_ip._PROXY_EXIT_URL])
   self.assertIsNone(value['ip']);self.assertEqual(value['proxyExitIP'],'13.214.76.191');self.assertEqual(value['source'],'interface-only');self.assertEqual(value['interfaceIP'],'192.168.1.2');self.assertTrue(value['httpProxyDetected']);self.assertFalse(value['tcpEgressVerified'])
 def test_visible_direct_egress_never_probes_the_proxy_exit(self):
  with tempfile.TemporaryDirectory() as root:
   def fail(*args):raise AssertionError('proxy probe must not run')
   value=public_ip.public_ip(pathlib.Path(root)/'c.json',env={'HTTPS_PROXY':'http://127.0.0.1:7897'},clock=lambda:1000,fetch=lambda url:'223.74.108.115',proxy_fetch=fail)
   self.assertEqual(value['ip'],'223.74.108.115');self.assertEqual(value['source'],'http-echo');self.assertEqual(value['probeMode'],'direct-tcp')
 def test_proxy_exit_evidence_cached_by_the_older_probe_is_not_reused(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'c.json'
   legacy=json.dumps({'version':2,'proxies':[['https','127.0.0.1',7897]]},sort_keys=True)
   path.write_text('{"context":'+json.dumps(legacy)+',"time":1000,"evidence":{"ip":"13.214.76.191","source":"http-echo","observedAt":"2026-10-08T08:36:26+00:00","tcpEgressVerified":false}}',encoding='utf-8')
   value=public_ip.public_ip(path,env={'HTTPS_PROXY':'http://127.0.0.1:7897'},clock=lambda:1000,fetch=lambda url:'223.74.108.115')
   self.assertFalse(value['cached']);self.assertEqual(value['ip'],'223.74.108.115')
 def test_bad_cache_and_interface_fallback_never_create_a_public_identity(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'cache.json'
   for content in ['[]','broken','{"context":"[]","time":"oops"}']:
    public_ip._IP_CACHE.clear();path.write_text(content)
    value=public_ip.public_ip(path,env={},clock=lambda:1000,fetch=lambda _:None,interface=lambda:'192.168.1.2')
    self.assertIsNone(value['ip']);self.assertEqual(value['interfaceIP'],'192.168.1.2');self.assertEqual(value['source'],'interface-only')
 def test_legacy_counts_survive_ip_change_unknown_ip_restart_and_blacklist(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'budget.db';db=sqlite3.connect(path);db.execute('CREATE TABLE budget(day TEXT PRIMARY KEY,count INTEGER,last REAL,blocked INTEGER)');db.execute('INSERT INTO budget VALUES(?,2,0,0)',(today(),));db.commit();db.close()
   def resolve(ip):return lambda **_:dict(ip=ip,source='test-fixture',tcpEgressVerified=False)
   with patch('baostock_guard.time.sleep'):
    guard=TrafficGuard(path,limit=4,ip_resolver=resolve('9.9.9.9'));guard.reserve();u=guard.usage();self.assertEqual(u['requests'],3);self.assertEqual(u['ipRequests'],1);self.assertEqual(u['unattributedRequests'],2);self.assertFalse(u['otherHostsCounted']);guard.close()
    guard=TrafficGuard(path,limit=4,ip_resolver=resolve('8.8.4.4'));guard.reserve();self.assertEqual(guard.usage()['ipRequests'],1);self.assertEqual(guard.usage()['requests'],4);guard.close()
    guard=TrafficGuard(path,limit=4,ip_resolver=resolve(None))
    with self.assertRaisesRegex(RuntimeError,'预算'):guard.reserve()
    guard.block();guard.close();guard=TrafficGuard(path,limit=40000,ip_resolver=resolve('9.9.9.9'))
    with self.assertRaisesRegex(RuntimeError,'本日采集停止'):guard.reserve()
    guard.close()
 def test_read_only_monitor_does_not_create_or_reserve_budget_and_runs_during_connection_lock(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'budget.db';resolve=lambda **_:dict(ip='9.9.9.9',source='test-fixture')
   self.assertEqual(inspect_usage(path,ip_resolver=resolve)['requests'],0);self.assertFalse(path.exists())
   guard=TrafficGuard(path,ip_resolver=resolve)
   try:
    guard.reserve();before=path.read_bytes();value=inspect_usage(path,ip_resolver=resolve);self.assertEqual(value['requests'],1);self.assertEqual(value['ipRequests'],1);self.assertIsNone(value['budget']);self.assertEqual(path.read_bytes(),before)
   finally:guard.close()
 def test_monitor_failure_cannot_weaken_limit_or_reset_counter(self):
  with tempfile.TemporaryDirectory() as root:
   def fail(**_):raise RuntimeError('mock probe failure')
   guard=TrafficGuard(pathlib.Path(root)/'budget.db',limit=1,ip_resolver=fail)
   try:
    guard.reserve();self.assertIsNone(guard.usage()['monitorIP']['ip'])
    with self.assertRaisesRegex(RuntimeError,'预算'):guard.reserve()
   finally:guard.close()
 def test_long_running_guard_refreshes_monitor_identity_without_resetting_day_budget(self):
  with tempfile.TemporaryDirectory() as root:
   stamp=[0];ips=iter(['9.9.9.9','8.8.4.4'])
   with patch('baostock_guard.time.monotonic',side_effect=lambda:stamp[0]),patch('baostock_guard.time.sleep'):
    guard=TrafficGuard(pathlib.Path(root)/'budget.db',limit=2,ip_resolver=lambda **_:{'ip':next(ips),'source':'test-fixture'})
    try:
     guard.reserve();stamp[0]=600;guard.reserve();self.assertEqual(guard.usage()['monitorIP']['ip'],'8.8.4.4');self.assertEqual(guard.usage()['requests'],2);self.assertEqual(guard.usage()['ipRequests'],1)
     with self.assertRaises(RuntimeError):guard.reserve()
    finally:guard.close()
 def test_windows_system_proxy_is_detected_and_credentials_never_cached(self):
  with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{},clear=True),patch('public_ip.urllib.request.getproxies',return_value={'https':'http://system-user:fixture-password@system.example:8080'}):
   path=pathlib.Path(root)/'cache.json'
   value=public_ip.public_ip(path,fetch=lambda _: '8.8.4.4',clock=lambda:1000)
   self.assertTrue(value['httpProxyDetected']);self.assertTrue(value['systemProxyDetected']);self.assertFalse(value['tcpEgressVerified'])
   self.assertIn('系统代理',value['note']);self.assertNotIn('system-user',path.read_text(encoding='utf-8'));self.assertNotIn('fixture-password',path.read_text(encoding='utf-8'))
 def test_manual_setting_persists_wins_over_cache_and_environment_takes_precedence(self):
  with tempfile.TemporaryDirectory() as root:
   config=pathlib.Path(root)/'monitor.json';cache=pathlib.Path(root)/'cache.json';env={'BS_MONITOR_CONFIG':str(config)}
   public_ip.public_ip(cache,env=env,fetch=lambda _: '8.8.4.4')
   public_ip.save_monitor_ip(config,'9.9.9.9')
   def fail(*_):raise AssertionError('manual monitoring must not probe HTTP')
   public_ip._IP_CACHE.clear();value=public_ip.public_ip(cache,env=env,fetch=fail)
   self.assertEqual(value['source'],'local-setting');self.assertEqual(value['ip'],'9.9.9.9');self.assertFalse(value['tcpEgressVerified'])
   self.assertEqual(public_ip.public_ip(cache,env={**env,'BS_MONITOR_IP':'8.8.8.8'},fetch=fail)['source'],'environment')
   before=config.read_bytes()
   for ip in ['192.168.1.1','127.0.0.1','100.64.0.1','203.0.113.1','8.8.8.8 extra','--help']:
    with self.assertRaises(ValueError):public_ip.save_monitor_ip(config,ip)
    self.assertEqual(config.read_bytes(),before)
   public_ip.save_monitor_ip(config,'');self.assertEqual(public_ip.monitor_settings(env)['mode'],'auto')
   self.assertEqual(public_ip.public_ip(cache,env=env,fetch=lambda _: '8.8.8.8',force=True)['ip'],'8.8.8.8')
 def test_force_refresh_bypasses_memory_and_disk_cache(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'cache.json';values=iter(['9.9.9.9','8.8.4.4']);fetch=lambda _:next(values)
   first=public_ip.public_ip(path,env={},clock=lambda:1000,fetch=fetch)
   self.assertEqual(public_ip.public_ip(path,env={},clock=lambda:1001,fetch=fetch)['ip'],first['ip'])
   refreshed=public_ip.public_ip(path,env={},clock=lambda:1001,fetch=fetch,force=True)
   self.assertEqual(refreshed['ip'],'8.8.4.4');self.assertFalse(refreshed['cached']);self.assertFalse(refreshed['tcpEgressVerified'])
 def test_running_guard_observes_settings_change_on_next_request_without_reset(self):
  with tempfile.TemporaryDirectory() as root:
   config=pathlib.Path(root)/'monitor.json';public_ip.save_monitor_ip(config,'9.9.9.9')
   with patch.dict(os.environ,{'BS_MONITOR_IP':'','BS_MONITOR_CONFIG':str(config)}),patch('baostock_guard.time.sleep'):
    guard=TrafficGuard(pathlib.Path(root)/'budget.db',limit=2)
    try:
     guard.reserve();public_ip.save_monitor_ip(config,'8.8.4.4');guard.reserve()
     self.assertEqual(guard.usage()['monitorIP']['ip'],'8.8.4.4');self.assertEqual(guard.usage()['requests'],2);self.assertEqual(guard.usage()['ipRequests'],1)
     with self.assertRaisesRegex(RuntimeError,'预算'):guard.reserve()
     guard.block();public_ip.save_monitor_ip(config,'8.8.8.8')
     with self.assertRaisesRegex(RuntimeError,'本日采集停止'):guard.reserve()
    finally:guard.close()
if __name__=='__main__':unittest.main()
