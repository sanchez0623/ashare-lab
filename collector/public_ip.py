"""Monitoring evidence, not proof of BaoStock's TCP NAT egress.
Preserve inherited proxy/CA settings; HTTP echo may see a different exit.
No external packet is sent by the interface-route fallback.
"""
import datetime as dt,ipaddress,json,math,os,pathlib,re,socket,time,urllib.request
from urllib.parse import urlsplit

_IP_ECHO_URLS=('https://api.ipify.org','https://ifconfig.me/ip','https://ip.3322.net','https://4.ipw.cn','https://myip.ipip.net')
_IP_CACHE_TTL=600
_IP_CACHE={}
def _extract_ipv4(text):
    for value in re.findall(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])',str(text)):
        try:
            ip=ipaddress.ip_address(value)
            if ip.version==4 and ip.is_global and not ip.is_multicast and not ip.is_reserved:return str(ip)
        except ValueError:pass
    return None
def _fetch(url):
    # urllib's default ProxyHandler and SSL context honor environment settings.
    with urllib.request.urlopen(url,timeout=3) as response:return response.read(4096).decode('utf-8',errors='replace')
def _interface_ip():
    try:
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8',80));return s.getsockname()[0]
    except OSError:
        try:return socket.gethostbyname(socket.gethostname())
        except OSError:return None
def public_ip(cache_path=None,env=None,clock=time.time,fetch=None,interface=None):
    env=os.environ if env is None else env;now=clock();override=env.get('BS_MONITOR_IP','').strip()
    proxy=bool(env.get('HTTPS_PROXY') or env.get('https_proxy') or env.get('HTTP_PROXY') or env.get('http_proxy') or env.get('ALL_PROXY') or env.get('all_proxy'))
    def result(ip,source,**extra):
        return {'ip':ip,'source':source,'observedAt':dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),'cached':False,'cacheAgeSeconds':0,'cacheTTLSeconds':_IP_CACHE_TTL,'httpProxyDetected':proxy,'tcpEgressVerified':False,**extra}
    if override:
        ip=_extract_ipv4(override)
        if ip==override:return result(ip,'environment',note='BS_MONITOR_IP人工声明；程序未独立证明BaoStock TCP出口')
        return result(None,'invalid-environment',note='BS_MONITOR_IP不是有效公网IPv4，未将其作为公网身份；本机预算继续生效')
    # A change of proxy host invalidates the cache; credentials never enter it.
    proxy_hosts=[]
    for key in ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy']:
        if env.get(key):
            try:u=urlsplit(env[key]);proxy_hosts.append((key,u.hostname,u.port))
            except ValueError:proxy_hosts.append((key,'invalid',None))
    context=json.dumps(proxy_hosts,sort_keys=True);saved=_IP_CACHE.get(context)
    if not saved and cache_path:
        try:
            value=json.loads(pathlib.Path(cache_path).read_text(encoding='utf-8'))
            if isinstance(value,dict) and value.get('context')==context:saved=value
        except (OSError,ValueError,TypeError):pass
    if saved and isinstance(saved.get('time'),(int,float)) and math.isfinite(saved['time']):
        age=now-saved['time'];evidence=saved.get('evidence',{})
        if isinstance(evidence,dict) and evidence.get('source') in ('http-echo','interface-only','unknown') and 'ip' in evidence and 'observedAt' in evidence and 0<=age<_IP_CACHE_TTL and (evidence.get('ip') is None or _extract_ipv4(evidence.get('ip'))==evidence.get('ip')):
            return {**evidence,'cached':True,'cacheAgeSeconds':int(age)}
    evidence=None
    for url in _IP_ECHO_URLS:
        try:ip=_extract_ipv4((fetch or _fetch)(url))
        except Exception:ip=None
        if ip:
            evidence=result(ip,'http-echo',echoService=urlsplit(url).hostname,note='HTTP查询候选IP；可能与BaoStock TCP出口不同'+('（检测到HTTP代理）' if proxy else ''));break
    if evidence is None:
        try:address=(interface or _interface_ip)()
        except Exception:address=None
        # Even a globally routed NIC address is not independently observed NAT.
        try:address=str(ipaddress.ip_address(address)) if address else None
        except ValueError:address=None
        evidence=result(None,'interface-only' if address else 'unknown',interfaceIP=address,note='未识别公网IPv4；网卡地址仅供诊断，不作为公网配额身份')
    saved={'context':context,'time':now,'evidence':evidence};_IP_CACHE[context]=saved
    if cache_path:
        try:
            target=pathlib.Path(cache_path);target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_name(target.name+'.tmp-'+str(os.getpid()))
            temp.write_text(json.dumps(saved,ensure_ascii=False),encoding='utf-8');os.replace(temp,target)
        except OSError:pass # Monitoring-cache failures never weaken the budget.
    return dict(evidence)
