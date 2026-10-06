"""Package only project source, built runtime and explicit public market samples.
Never includes Git credentials, cloud bindings, caches, real local warehouses,
Python environments, collector jobs or Node dependencies.
"""
import datetime,hashlib,json,pathlib,sys,zipfile
root=pathlib.Path(__file__).resolve().parents[1]
out=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else root/'ashare-lab-local.zip'
samples=pathlib.Path(sys.argv[2]) if len(sys.argv)>2 else None
required=['dist/client/index.html','dist/client/app.js','dist/client/engine.mjs','dist/client/guide.html','dist/client/USER_GUIDE.md','dist/server/index.js','scripts/local-server.mjs','LOCAL_DEPLOY.md','USER_GUIDE.md']
for name in required:
 if not (root/name).is_file():raise RuntimeError('缺少 '+name+'；先运行 npm run build')
files={}
for name in ['README.md','LOCAL_DEPLOY.md','USER_GUIDE.md','package.json','package-lock.json','wrangler.jsonc','.gitignore','start-local.cmd','start-local.sh']:
 files[name]=(root/name).read_bytes()
for folder in ['dist','server','scripts','tests','collector']:
 for p in (root/folder).rglob('*'):
  if not p.is_file():continue
  # A downloadable deployment bundle must never contain itself or an older
  # generated bundle, including when packaging to a different output path.
  if p.name=='ashare-lab-local.zip':continue
  relative=p.relative_to(root).as_posix()
  if any(x in p.parts for x in ['node_modules','__pycache__','.venv','store','raw','output','universe-cache']):continue
  if p.suffix not in ['.mjs','.js','.cjs','.css','.html','.json','.py','.md','.pdf','.txt','.service','.timer','.zip']:continue
  files[relative]=p.read_bytes()
if samples:
 for pattern in ['600519-daily-20251009-20260930.*','600519-native15m-20260402-20260930.*','600519-5m-47ccd3343049a4bbb966c1bd.json']:
  for p in samples.glob(pattern):
   if p.suffix in ['.csv','.json']:files['data/samples/'+p.name]=p.read_bytes()
 files['data/samples/README.md']='''# 真实行情样例\n\n日线：2025-10-09至2026-09-30，241根，新浪与腾讯收盘交叉核验。\n原生15分钟：2026-04-02至2026-09-30，1970根。\n5分钟：2026-08-03至2026-09-30，1970根。\n\n来源：AkShare适配接口及相同新浪官方报价端点。均为原始价。CSV可显式选择CSV探索；JSON保留缺少历史ST、公司行动和历史成分资料的状态，不能正式回测。与合成演示分开，不代表完整一年分钟数据。资料请求范围、原始哈希及同步时间见JSON metadata。\n'''.encode()
manifest={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime':'Node.js >=22; Python >=3.10 with collector dependencies for automatic collection','startup':'node scripts/local-server.mjs','storage':'.local-data/warehouse and .local-data/research','cloudCredentialsIncluded':False,'files':{name:hashlib.sha256(body).hexdigest() for name,body in sorted(files.items())}}
files['LOCAL_PACKAGE_MANIFEST.json']=json.dumps(manifest,ensure_ascii=False,indent=2).encode()
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for name,body in sorted(files.items()):z.writestr('ashare-lab-local/'+name,body)
with zipfile.ZipFile(out) as z:
 if z.testzip():raise RuntimeError('ZIP校验失败')
 for name in required:z.getinfo('ashare-lab-local/'+name)
 forbidden=['/.git/','/.openai/','/node_modules/','/.local-data/','/.venv/','/collector/store/']
 if any(any(x in name for x in forbidden) for name in z.namelist()):raise RuntimeError('部署包包含排除的目录')
print(json.dumps({'archive':str(out),'files':len(files),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'samplesIncluded':bool(samples)},ensure_ascii=False))
