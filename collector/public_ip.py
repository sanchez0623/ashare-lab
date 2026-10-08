"""HTTP monitoring evidence is never proof of BaoStock TCP NAT egress.
Keep inherited proxy/CA settings, including Windows system proxy discovery.
Manual declarations affect monitoring only, never connections or host budgets.
"""
import datetime as dt,ipaddress,json,math,os,pathlib,re,socket,time,urllib.request
from urllib.parse import urlsplit

_IP_ECHO_URLS=('https://api.ipify.org','https://ifconfig.me/ip','https://ip.3322.net','https://4.ipw.cn','https://myip.ipip.net')
_IP_CACHE_TTL=600
_IP_CACHE={}
_CACHE_VERSION=2

def _extract_ipv4(text):
    for value in re.findall(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])',str(text)):
        try:
            ip=ipaddress.ip_address(value)
            if ip.version==4 and ip.is_global and not ip.is_multicast and not ip.is_reserved:return str(ip)
        except ValueError:pass
    return None

def monitor_settings(env=None):
    env=os.environ if env is None else env;override=env.get('BS_MONITOR_IP','').strip()
    path=env.get('BS_MONITOR_CONFIG','');declared='';error=None
    if path:
        try:
            saved=json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
            if not isinstance(saved,dict) or saved.get('version')!=1 or not isinstance(saved.get('ip'),str):raise ValueError()
            declared=saved['ip']
            if declared and _extract_ipv4(declared)!=declared:raise ValueError()
        except FileNotFoundError:pass
        except (OSError,ValueError,TypeError):error='本地监控设置无效；未使用其中的IP，请重新保存设置'
    return {'declaredIP':declared if not error else '', 'environmentOverride':bool(override),'mode':'environment' if override else 'local-setting' if declared and not error else 'auto','error':error}

def save_monitor_ip(path,ip):
    if not isinstance(ip,str) or ip and _extract_ipv4(ip)!=ip:raise ValueError('请填写有效的公网IPv4；留空恢复自动候选识别。')
    target=pathlib.Path(path);target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_name(target.name+'.tmp-'+str(os.getpid()))
    try:
        temp.write_text(json.dumps({'version':1,'ip':ip,'updatedAt':dt.datetime.now(dt.timezone.utc).isoformat()},ensure_ascii=False),encoding='utf-8')
        os.replace(temp,target)
    finally:
        try:temp.unlink(missing_ok=True)
        except OSError:pass

def settings_identity(env=None):
    env=os.environ if env is None else env;path=env.get('BS_MONITOR_CONFIG','')
    try:stamp=pathlib.Path(path).stat().st_mtime_ns if path else None
    except OSError:stamp=None
    return (env.get('BS_MONITOR_IP',''),path,stamp)

def _fetch(url):
    # Default ProxyHandler also discovers Windows registry proxies. Keep CA trust.
    with urllib.request.urlopen(url,timeout=3) as response:return response.read(4096).decode('utf-8',errors='replace')

def _interface_ip():
    try:
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8',80));return s.getsockname()[0]
    except OSError:
        try:return socket.gethostbyname(socket.gethostname())
        except OSError:return None

def public_ip(cache_path=None,env=None,clock=time.time,fetch=None,interface=None,force=False):
    supplied_env=env is not None;env=os.environ if env is None else env;now=clock();override=env.get('BS_MONITOR_IP','').strip()
    environment_proxies={scheme:env.get(scheme+'_proxy') or env.get(scheme.upper()+'_PROXY') for scheme in ('http','https','all')}
    try:proxies=environment_proxies if supplied_env else urllib.request.getproxies()
    except Exception:proxies=environment_proxies
    proxy=any(proxies.get(k) for k in ('http','https','all'))
    system_proxy=proxy and not any(environment_proxies.values())
    def result(ip,source,**extra):
        return {'ip':ip,'source':source,'observedAt':dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),'cached':False,'cacheAgeSeconds':0,'cacheTTLSeconds':_IP_CACHE_TTL,'httpProxyDetected':proxy,'systemProxyDetected':system_proxy,'tcpEgressVerified':False,**extra}
    if override:
        ip=_extract_ipv4(override)
        if ip==override:return result(ip,'environment',note='BS_MONITOR_IP人工声明；只用于监控，不改变BaoStock TCP连接，未独立证明TCP出口')
        return result(None,'invalid-environment',note='BS_MONITOR_IP不是有效公网IPv4，未将其作为公网身份；本机预算继续生效')
    settings=monitor_settings(env)
    if settings['error']:return result(None,'invalid-setting',note=settings['error'])
    if settings['declaredIP']:return result(settings['declaredIP'],'local-setting',note='网页保存的人工声明；只用于监控，不改变BaoStock TCP连接，未独立证明TCP出口')
    # Invalidate old cache schemas and proxy changes; never save proxy credentials.
    proxy_hosts=[]
    for key in ('http','https','all'):
        if proxies.get(key):
            try:u=urlsplit(proxies[key]);proxy_hosts.append((key,u.hostname,u.port))
            except ValueError:proxy_hosts.append((key,'invalid',None))
    context=json.dumps({'version':_CACHE_VERSION,'proxies':proxy_hosts},sort_keys=True);saved=None if force else _IP_CACHE.get(context)
    if not saved and cache_path and not force:
        try:
            value=json.loads(pathlib.Path(cache_path).read_text(encoding='utf-8'))
            if isinstance(value,dict) and value.get('context')==context:saved=value
        except (OSError,ValueError,TypeError):pass
    if saved and isinstance(saved.get('time'),(int,float)) and math.isfinite(saved['time']):
        age=now-saved['time'];evidence=saved.get('evidence',{})
        if isinstance(evidence,dict) and evidence.get('source') in ('http-echo','interface-only','unknown') and 'ip' in evidence and 'observedAt' in evidence and evidence.get('tcpEgressVerified') is False and 0<=age<_IP_CACHE_TTL and (evidence.get('ip') is None or _extract_ipv4(evidence.get('ip'))==evidence.get('ip')):
            return {**evidence,'cached':True,'cacheAgeSeconds':int(age)}
    evidence=None
    for url in _IP_ECHO_URLS:
        try:ip=_extract_ipv4((fetch or _fetch)(url))
        except Exception:ip=None
        if ip:
            evidence=result(ip,'http-echo',echoService=urlsplit(url).hostname,note='HTTP候选IP，不代表BaoStock TCP出口'+('（检测到Windows/系统代理）' if system_proxy else '（检测到HTTP代理）' if proxy else '；VPN或代理分流也可能使两者不同'));break
    if evidence is None:
        try:address=(interface or _interface_ip)()
        except Exception:address=None
        try:address=str(ipaddress.ip_address(address)) if address else None
        except ValueError:address=None
        evidence=result(None,'interface-only' if address else 'unknown',interfaceIP=address,note='未识别公网IPv4；网卡地址仅供诊断，不作为公网配额身份')
    saved={'context':context,'time':now,'evidence':evidence};_IP_CACHE[context]=saved
    if cache_path:
        try:
            target=pathlib.Path(cache_path);target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_name(target.name+'.tmp-'+str(os.getpid()))
            temp.write_text(json.dumps(saved,ensure_ascii=False),encoding='utf-8');os.replace(temp,target)
        except OSError:pass
    return dict(evidence)
