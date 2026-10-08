"""One SDK connection per host, durable daily budget including SDK pagination.
Official policy: <=50,000 API requests/day, no concurrent connections.
Our default: <=10,000/day and >=1 second/request. Other hosts behind the same
public IP must coordinate the same budget; no local program can count them.
"""
import datetime as dt,json,os,pathlib,sqlite3,time,socket
from locking import FileLock
from public_ip import public_ip,monitor_settings,save_monitor_ip,settings_identity
from zoneinfo import ZoneInfo
def budget_path(path=None):return pathlib.Path(path or os.environ.get('BAOSTOCK_BUDGET_PATH',str(pathlib.Path.home()/'.cache/ashare-baostock/traffic.sqlite')))
def today():return dt.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
def monitor_identity(path,resolver=None,force=False):
    try:
        value=(resolver or public_ip)(cache_path=path.with_name('public-ip.json'),**({'force':True} if force else {}))
        if isinstance(value,dict):return value
    except Exception:pass
    return {'ip':None,'source':'unknown','tcpEgressVerified':False,'note':'监控IP读取失败；本机预算保持生效'}
def usage_snapshot(db,limit,identity,session_requests=0):
    day=today();row=db.execute('SELECT count,blocked FROM budget WHERE day=?',(day,)).fetchone() if db else None
    requests=row[0] if row else 0;by_ip=0;attributed=0
    if db and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_ip'").fetchone():
        attributed=db.execute('SELECT COALESCE(SUM(count),0) FROM budget_ip WHERE day=?',(day,)).fetchone()[0]
        if identity.get('ip'):
            r=db.execute('SELECT count FROM budget_ip WHERE day=? AND ip=?',(day,identity['ip'])).fetchone();by_ip=r[0] if r else 0
    return {'day':day,'requests':requests,'budget':limit,'blocked':bool(row and row[1]),'sessionRequests':session_requests,'monitorIP':dict(identity),'ipRequests':by_ip,'unattributedRequests':max(0,requests-attributed),'officialLimit':50000,'officialScope':'public-ip','countScope':'this-host-only','otherHostsCounted':False,'policy':'host-day-budget-retained-across-IP-changes'}
class TrafficGuard:
    def __init__(self,path=None,limit=10000,interval=1,ip_resolver=None):
        if not 1<=limit<=40000 or interval<1:raise ValueError('保守预算最多40000，间隔至少1秒。')
        self.path=budget_path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        try:self.lock=FileLock(str(self.path)+'.connection.lock')
        except BlockingIOError:raise RuntimeError('同一主机已有BaoStock连接；禁止并发，稍后串行运行。') from None
        try:
            self.db=sqlite3.connect(self.path);self.db.execute('CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY,count INTEGER,last REAL,blocked INTEGER)')
            self.db.execute('CREATE TABLE IF NOT EXISTS budget_ip(day TEXT,ip TEXT,count INTEGER,PRIMARY KEY(day,ip))');self.db.commit()
            self.ip_resolver=ip_resolver;self.monitor_ip=monitor_identity(self.path,ip_resolver);self.monitor_checked=time.monotonic();self.monitor_context=settings_identity()
        except Exception:
            if hasattr(self,'db'):self.db.close()
            self.lock.close();raise
        self.limit=limit;self.interval=interval
        self.session_requests=0;self.session_wait_ms=0
    def reserve(self):
        if time.monotonic()-self.monitor_checked>=600 or settings_identity()!=self.monitor_context:
            self.monitor_ip=monitor_identity(self.path,self.ip_resolver);self.monitor_checked=time.monotonic();self.monitor_context=settings_identity()
        day=today()
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO budget VALUES(?,0,0,0)',(day,));count,last,blocked=self.db.execute('SELECT count,last,blocked FROM budget WHERE day=?',(day,)).fetchone()
            if blocked:raise RuntimeError('BaoStock已返回黑名单错误，本日采集停止；不轮换IP、不自动重连。')
            if count>=self.limit:raise RuntimeError('已达到保守日请求预算，停止并保留断点。')
            wait=self.interval-(time.time()-last)
            if wait>0:
                started=time.perf_counter();time.sleep(wait);self.session_wait_ms+=(time.perf_counter()-started)*1000
            self.db.execute('UPDATE budget SET count=count+1,last=? WHERE day=?',(time.time(),day))
            if self.monitor_ip.get('ip'):
                self.db.execute('INSERT INTO budget_ip VALUES(?,?,1) ON CONFLICT(day,ip) DO UPDATE SET count=count+1',(day,self.monitor_ip['ip']))
            self.session_requests+=1
    def block(self):
        day=today()
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO budget VALUES(?,0,0,0)',(day,));self.db.execute('UPDATE budget SET blocked=1 WHERE day=?',(day,))
    def usage(self):
        return usage_snapshot(self.db,self.limit,self.monitor_ip,self.session_requests)
    def close(self):self.db.close();self.lock.close()

class _CheckedSocket:
    """Retain SDK framing/decoding, but terminate EOF and send entire requests."""
    def __init__(self,sock):self.sock=sock;self.reason=None
    def __getattr__(self,name):return getattr(self.sock,name)
    def send(self,data):
        try:self.sock.sendall(data);return len(data)
        except (OSError,TimeoutError):self.reason='send-failed';raise
    def recv(self,size):
        try:data=self.sock.recv(size)
        except (TimeoutError,socket.timeout):self.reason='receive-timeout';raise
        except OSError:self.reason='receive-failed';raise
        if not data:self.reason='peer-closed';raise ConnectionError('BaoStock TCP peer closed before a complete response')
        return data

def install(guard):
    import baostock.util.socketutil as sock
    import socket
    from baostock.common import contants as cons
    previous_timeout=socket.getdefaulttimeout();socket.setdefaulttimeout(45)
    original=sock.send_msg
    def guarded(msg):
        guard.reserve();context=getattr(sock,'context',None);connection=getattr(context,'default_socket',None);adapter=None
        if connection is not None:
            adapter=_CheckedSocket(connection);setattr(context,'default_socket',adapter)
        try:result=original(msg)
        finally:
            if adapter and getattr(context,'default_socket',None) is adapter:setattr(context,'default_socket',connection)
        if result is None or not result.strip():
            header=str(msg)[:cons.MESSAGE_HEADER_LENGTH].split(cons.MESSAGE_SPLIT)
            kind=header[1] if len(header)>1 and len(header[1])==2 and header[1].isdigit() else None
            stage={cons.MESSAGE_TYPE_LOGIN_REQUEST:'登录',cons.MESSAGE_TYPE_LOGOUT_REQUEST:'退出',cons.MESSAGE_TYPE_QUERYTRADEDATES_REQUEST:'交易日历'}.get(kind,'数据查询/分页')
            reason=adapter.reason if adapter else 'no-sdk-connection'
            reason_text={'peer-closed':'服务器已关闭连接','receive-timeout':'接收超时','receive-failed':'接收失败','send-failed':'发送失败','no-sdk-connection':'SDK未建立可用连接'}.get(reason,'SDK返回空响应')
            error=RuntimeError(f'BaoStock{stage}阶段未收到完整TCP响应：{reason_text}。当前查询不保存检查点，已完成分段保留；请检查public-api.baostock.com:10030的连接及网络/代理分流后恢复原任务。HTTP候选IP只用于监控，修改监控IP不会修复连接；失败请求仍计入本机预算，不自动重试。')
            error.code='PROVIDER_RESPONSE_INCOMPLETE';error.details={'provider':'baostock','requestStage':stage,'requestType':kind,'transportReason':reason or 'empty-sdk-response','endpoint':'public-api.baostock.com:10030','sdkRequests':guard.session_requests}
            raise error
        error_code=result[cons.MESSAGE_HEADER_LENGTH:].split(cons.MESSAGE_SPLIT,1)[0]
        if error_code=='10001011':guard.block();raise RuntimeError('BaoStock黑名单10001011：立即停止，不自动重试。')
        return result
    sock.send_msg=guarded
    def restore():sock.send_msg=original;socket.setdefaulttimeout(previous_timeout)
    return restore

def inspect_usage(path=None,limit=None,ip_resolver=None,force=False):
    """Read without an SDK login, reserving requests, creating a budget or locking it."""
    path=budget_path(path);identity=monitor_identity(path,ip_resolver,force=force);db=None
    try:
        if path.exists():db=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)
        return {**usage_snapshot(db,limit,identity),'monitorSettings':monitor_settings()}
    finally:
        if db:db.close()
if __name__=='__main__':
    import argparse,sys
    parser=argparse.ArgumentParser();parser.add_argument('--inspect',action='store_true');parser.add_argument('--force',action='store_true');parser.add_argument('--set-monitor-ip')
    args=parser.parse_args()
    try:
        if args.set_monitor_ip is not None:
            config=os.environ.get('BS_MONITOR_CONFIG')
            if not config:raise ValueError('未配置本地监控设置路径。')
            save_monitor_ip(config,args.set_monitor_ip)
        if args.inspect:print(json.dumps(inspect_usage(force=args.force),ensure_ascii=False))
    except ValueError as e:
        print(json.dumps({'error':str(e),'code':'MONITOR_IP'},ensure_ascii=False));sys.exit(2)
