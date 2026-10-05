"""Host scheduler entrypoint; never claims a timer is active before installation."""
import datetime,os,subprocess,sys
from zoneinfo import ZoneInfo
end=datetime.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
cmd=[sys.executable,'collector/sync.py','--provider',os.environ.get('ASHARE_PROVIDER','baostock'),'--from',os.environ.get('ASHARE_HISTORY_FROM','2020-01-01'),'--to',end,'--incremental','--store',os.environ.get('ASHARE_STORE','collector/store')]
if os.environ.get('ASHARE_POOL'):cmd+=['--pool',os.environ['ASHARE_POOL']]
if os.environ.get('ASHARE_HS300_HISTORY','1')=='1':cmd+=['--hs300-history']
if os.environ.get('ASHARE_SITE'):cmd+=['--site',os.environ['ASHARE_SITE']]
sys.exit(subprocess.call(cmd))
