"""One SDK connection per host, durable daily budget including SDK pagination.
Official policy: <=50,000 API requests/day, no concurrent connections.
Our default: <=10,000/day and >=1 second/request. Other hosts behind the same
public IP must coordinate the same budget; no local program can count them.
"""
import datetime as dt,os,pathlib,sqlite3,time
from locking import FileLock
from zoneinfo import ZoneInfo
class TrafficGuard:
    def __init__(self,path=None,limit=10000,interval=1):
        if not 1<=limit<=40000 or interval<1:raise ValueError('保守预算最多40000，间隔至少1秒。')
        self.path=pathlib.Path(path or os.environ.get('BAOSTOCK_BUDGET_PATH',str(pathlib.Path.home()/'.cache/ashare-baostock/traffic.sqlite')));self.path.parent.mkdir(parents=True,exist_ok=True)
        try:self.lock=FileLock(str(self.path)+'.connection.lock')
        except BlockingIOError:raise RuntimeError('同一主机已有BaoStock连接；禁止并发，稍后串行运行。') from None
        self.db=sqlite3.connect(self.path);self.db.execute('CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY,count INTEGER,last REAL,blocked INTEGER)');self.limit=limit;self.interval=interval
        self.session_requests=0;self.session_wait_ms=0
    def reserve(self):
        day=dt.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO budget VALUES(?,0,0,0)',(day,));count,last,blocked=self.db.execute('SELECT count,last,blocked FROM budget WHERE day=?',(day,)).fetchone()
            if blocked:raise RuntimeError('BaoStock已返回黑名单错误，本日采集停止；不轮换IP、不自动重连。')
            if count>=self.limit:raise RuntimeError('已达到保守日请求预算，停止并保留断点。')
            wait=self.interval-(time.time()-last)
            if wait>0:
                started=time.perf_counter();time.sleep(wait);self.session_wait_ms+=(time.perf_counter()-started)*1000
            self.db.execute('UPDATE budget SET count=count+1,last=? WHERE day=?',(time.time(),day))
            self.session_requests+=1
    def block(self):
        day=dt.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
        with self.db:self.db.execute('UPDATE budget SET blocked=1 WHERE day=?',(day,))
    def close(self):self.db.close();self.lock.close()

def install(guard):
    import baostock.util.socketutil as sock
    import socket
    previous_timeout=socket.getdefaulttimeout();socket.setdefaulttimeout(45)
    original=sock.send_msg
    def guarded(msg):
        guard.reserve();result=original(msg)
        from baostock.common import contants as cons
        error_code=result[cons.MESSAGE_HEADER_LENGTH:].split(cons.MESSAGE_SPLIT,1)[0] if result else ''
        if error_code=='10001011':guard.block();raise RuntimeError('BaoStock黑名单10001011：立即停止，不自动重试。')
        return result
    sock.send_msg=guarded
    def restore():sock.send_msg=original;socket.setdefaulttimeout(previous_timeout)
    return restore
