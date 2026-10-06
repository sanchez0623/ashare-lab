#!/usr/bin/env python3
"""Upload existing JSON snapshots only to the local loopback research server.
No Site token or BaoStock connection is required. Verify exact bytes on readback.
"""
import argparse,hashlib,json,pathlib,sys,urllib.parse,urllib.request

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths',nargs='+',help='JSON文件或采集输出文件夹')
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    args=parser.parse_args();target=urllib.parse.urlparse(args.url)
    if target.scheme!='http' or target.hostname not in ('127.0.0.1','localhost') or target.username or target.password or target.path not in ('','/') or target.query or target.fragment:
        parser.error('此脚本只接受 http://127.0.0.1:端口 或 http://localhost:端口')
    files=[]
    for value in args.paths:
        path=pathlib.Path(value);files.extend(sorted(path.glob('*.json')) if path.is_dir() else [path])
    if not files:parser.error('没有找到JSON数据包；先运行采集或指定文件')
    failures=0;base=args.url.rstrip('/')
    for path in files:
        try:
            raw=path.read_bytes()
            if len(raw)>25*1024*1024:raise ValueError('文件超过25MB，请分段采集')
            request=urllib.request.Request(base+'/api/data/ingest',data=raw,headers={'Content-Type':'application/json'},method='POST')
            with urllib.request.urlopen(request,timeout=60) as response:manifest=json.load(response)
            ident=manifest['id']
            with urllib.request.urlopen(base+'/api/data/bundle?id='+ident,timeout=60) as response:got=response.read()
            if got!=raw or hashlib.sha256(got).hexdigest()!=ident:raise ValueError('读回内容或SHA256不一致')
            print(json.dumps({'file':str(path),'id':ident,'reused':manifest.get('reused',False),'formalStatus':manifest['report']['status'],'actual':manifest['report']['actual'],'readback':'bytes and SHA256 verified'},ensure_ascii=False),flush=True)
        except Exception as e:failures+=1;print(json.dumps({'file':str(path),'error':str(e)},ensure_ascii=False),file=sys.stderr,flush=True)
    return 1 if failures else 0
if __name__=='__main__':sys.exit(main())
