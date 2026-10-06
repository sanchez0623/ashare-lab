import http from 'node:http';
import {readFile,writeFile,rename,mkdir,readdir,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {ResearchManager} from '../server/research.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const validKey=key=>/^(snapshots|manifests)\/[a-f0-9]{64}\.json$/.test(key);
export class FileBucket {
  constructor(root){this.root=path.resolve(root);}
  location(key){if(!validKey(key))throw Error('仓库对象路径无效');return path.join(this.root,key);}
  async get(key){try{const bytes=await readFile(this.location(key)),etag='"'+createHash('sha256').update(bytes).digest('hex')+'"';return {body:bytes,httpEtag:etag,json:async()=>JSON.parse(bytes.toString('utf8'))};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async put(key,value){const target=this.location(key);await mkdir(path.dirname(target),{recursive:true});const tmp=target+'.tmp-'+randomUUID();await writeFile(tmp,value);await rename(tmp,target);}
  async list({prefix='manifests/',limit=100,cursor}={}){
    if(prefix!=='manifests/')throw Error('仓库前缀无效');let files=[];try{files=await readdir(path.join(this.root,'manifests'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const keys=files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>prefix+f).sort();
    const after=cursor?Buffer.from(cursor,'base64url').toString('utf8'):'';
    if(after&&!validKey(after))throw Error('分页游标无效');
    const remaining=keys.filter(k=>k>after),page=remaining.slice(0,limit),truncated=remaining.length>page.length;
    return {objects:page.map(key=>({key})),truncated,cursor:truncated?Buffer.from(page.at(-1)).toString('base64url'):undefined};
  }
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.zip':'application/zip','.csv':'text/csv; charset=utf-8','.pdf':'application/pdf','.md':'text/markdown; charset=utf-8'};
export function fileAssets(root){const base=path.resolve(root);return {async fetch(request){
  try{const url=new URL(request.url),pathname=decodeURIComponent(url.pathname),target=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
    const actual=await realpath(target);if(!actual.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
    if(!(await stat(actual)).isFile())return new Response('Not Found',{status:404});
    return new Response(request.method==='HEAD'?null:await readFile(actual),{headers:{'content-type':mime[path.extname(actual)]??'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff'}});
  }catch(e){return new Response(e.code==='ENOENT'?'Not Found':'Invalid path',{status:e.code==='ENOENT'?404:400});}
}};}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,chunks=[];const onData=chunk=>{size+=chunk.length;if(size>25*1024*1024){chunks=[];req.off('data',onData);req.resume();reject(Object.assign(Error('数据包超过 25 MB'),{status:413}));}else chunks.push(chunk);};req.on('data',onData);req.once('end',()=>resolve(Buffer.concat(chunks)));req.once('error',reject);});}
export async function loadBuiltWorker(root=projectRoot){
  const entry=path.join(root,'dist/server/index.js');
  try{await stat(entry);}catch(e){
    if(e.code==='ENOENT')throw Object.assign(Error('缺少构建文件：'+entry+'。请解压完整部署包，或先运行 npm ci 和 npm run build。'),{code:'BUILD_MISSING'});
    throw Object.assign(Error('无法访问后台构建文件：'+entry+'（'+e.code+'）'),{code:'BUILD_ACCESS_FAILED',cause:e});
  }
  let worker;
  try{worker=(await import(pathToFileURL(entry).href)).default;}catch(e){
    throw Object.assign(Error('后台构建文件加载失败：'+entry+'。原因：'+(e.code??e.name)+'：'+e.message),{code:'BUILD_LOAD_FAILED',cause:e});
  }
  if(typeof worker?.fetch!=='function')throw Object.assign(Error('后台构建文件入口无效：'+entry+'；需要导出可调用的 fetch。'),{code:'BUILD_ENTRY_INVALID'});
  return worker;
}
export async function startLocal({port=8080,dataDir=path.join(projectRoot,'.local-data'),assetsDir=path.join(projectRoot,'dist/client'),worker,researchOptions={}}={}){
  if(!worker)worker=await loadBuiltWorker();
  await mkdir(dataDir,{recursive:true});const env={BUCKET:new FileBucket(path.join(dataDir,'warehouse')),ASSETS:fileAssets(assetsDir)};
  const research=await new ResearchManager({...researchOptions,root:path.join(dataDir,'research'),bucket:env.BUCKET}).init();
  const server=http.createServer(async(req,res)=>{
    const localPort=server.address().port,host=req.headers.host?.toLowerCase();
    if(![`127.0.0.1:${localPort}`,`localhost:${localPort}`].includes(host)){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'});res.end('只接受本机访问');return;}
    try{
      if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
      const body=['GET','HEAD'].includes(req.method)?undefined:await readBody(req);
      const request=new Request(new URL(req.url,'http://'+host),{method:req.method,headers:req.headers,body});
      const response=await (new URL(request.url).pathname.startsWith('/api/research/')?research.fetch(request):worker.fetch(request,env));res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body&&req.method!=='HEAD')Readable.fromWeb(response.body).pipe(res);else res.end();
    }catch(e){res.writeHead(e.status??500,{'content-type':'application/json; charset=utf-8','connection':'close'});res.end(JSON.stringify({error:e.status?e.message:'本地服务处理失败，请检查启动窗口日志'}));if(!e.status)console.error(e.message);}
  });
  const close=server.close.bind(server);server.close=callback=>{research.close().then(()=>close(callback),e=>callback?.(e));return server;};server.research=research;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(e){await research.close();throw e;}return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const major=Number(process.versions.node.split('.')[0]);if(major<22){console.error('需要 Node.js 22 或更高版本，推荐 Node.js 24 LTS。');process.exit(1);}
  const options={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--port')options.port=Number(process.argv[++i]);else if(key==='--data-dir')options.dataDir=path.resolve(process.argv[++i]);else{console.error('用法：node scripts/local-server.mjs [--port 8080] [--data-dir 路径]');process.exit(1);}}
  if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<1||options.port>65535)){console.error('端口需为 1–65535 的整数');process.exit(1);}
  try{const server=await startLocal(options);console.log('青衡本地回测系统已启动：http://127.0.0.1:'+server.address().port);console.log('行情、任务与报告保存于：'+path.resolve(options.dataDir??path.join(projectRoot,'.local-data')));console.log('行情数据页可提交单股5分钟采集与回测，支持一年或自定义日期。关闭网页不中断；Ctrl+C保存断点。');let closing=false;const stop=()=>{if(closing)return;closing=true;server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
  catch(e){console.error(e.code==='EADDRINUSE'?'端口已占用，可运行：node scripts/local-server.mjs --port 8081':e.message);process.exit(1);}
}
