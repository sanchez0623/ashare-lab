"""Bounded second-source evidence collector. Never adjusts any candle values.

Called by the local repair controller; completed source responses and TDX pages
are atomic hash-checked checkpoints. No BaoStock requests or paid calls occur.
"""
import argparse, importlib.metadata, json, pathlib, sys, os, threading, time
from query_cache import atomic, encode, digest, read_proof
from sources import registry, SourceError

def emit(message,**extra):
    print(json.dumps({'message':message,**extra},ensure_ascii=False),flush=True)

class PageCache:
    def __init__(self,client,root,environment):
        self.client=client;self.root=pathlib.Path(root);self.environment=environment;self.anchor=None
    def bars(self,**params):
        page=params['start']//800
        # The live first page anchors relative offsets. A changed anchor starts
        # a new namespace, retaining old evidence without mixing shifted pages.
        if page==0:
            from sources import frame_records
            rows=frame_records(self.client.bars(**params));self.anchor=digest(rows)
        identity={'version':self.environment,'query':['mootdx-page',self.anchor,params]}
        target=self.root/(digest(identity)+'.json')
        import pandas as pd
        if target.exists():
            proof=read_proof(target,identity);rows=proof['rows'];emit('复用通达信分页检查点',page=page,rows=len(rows),cached=True)
        else:
            if page:
                from sources import frame_records
                rows=frame_records(self.client.bars(**params))
            atomic(target,{'identity':identity,'rows':rows,'sha256':digest(rows)});emit('已保存通达信原始分页',page=page,rows=len(rows),cached=False)
        return pd.DataFrame(rows)
    def close(self):self.client.close()

def collect(request,root,output):
    root=pathlib.Path(root);source=registry()[request['source']]
    identity={'version':'minute-repair-1','source':request['source'],'symbol':request['symbol'],'range':request['range'],'baseSnapshotId':request['baseSnapshotId'],'python':sys.version.split()[0],
              'dependencies':{name:importlib.metadata.version(name) for name in source.dependencies if source.available()}}
    checkpoint=root/('response-'+digest(identity)+'.json')
    if checkpoint.exists():
        saved=json.loads(checkpoint.read_bytes())
        if saved['identity']!=identity or digest(saved['batch'])!=saved['sha256']:raise SourceError('REPAIR_HASH','第二源检查点哈希或身份不符')
        atomic(output,saved['batch']);emit('复用已完成的第二源响应',source=source.name,cached=True);return
    state=source.readiness()
    if state['state']!='ready-unprobed':raise SourceError(state['code'],source.name+'未就绪：'+state['code'])
    emit('开始第二源请求',source=source.name,range=request['range'])
    try:
        if source.name=='mootdx':
            source.connection();source.client=PageCache(source.client,root/'pages',identity)
        batch=source.get_minute5(request['symbol'],request['range']['from'],request['range']['to']).as_dict()
        batch['symbol']=request['symbol'];batch['rawJSON']=encode(batch['raw']).decode('utf-8');batch['metadata']['environment']=identity
        atomic(checkpoint,{'identity':identity,'batch':batch,'sha256':digest(batch)})
        atomic(output,batch);emit('第二源响应已保存；覆盖与量价由后台独立核验',source=source.name,rows=len(batch['rows']))
    finally:source.close()

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',required=True);parser.add_argument('--root',required=True);parser.add_argument('--output',required=True);parser.add_argument('--parent',type=int);args=parser.parse_args()
    if args.parent:
        def watch_parent():
            while True:
                if os.getppid()!=args.parent:os._exit(2)
                time.sleep(1)
        threading.Thread(target=watch_parent,daemon=True).start()
    try:collect(json.loads(pathlib.Path(args.request).read_bytes()),args.root,args.output)
    except SourceError as e:emit(str(e),code=e.code);return 2
    except Exception as e:emit('第二源请求失败：'+type(e).__name__,code='REPAIR_PROVIDER_FAILED');return 2
    return 0
if __name__=='__main__':raise SystemExit(main())
