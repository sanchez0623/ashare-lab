import {readdir,readFile,mkdir,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build,transform} from 'esbuild';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const publicExtensions=new Set(['.mjs','.js','.html','.css','.json','.svg','.png','.ico','.pdf','.md','.csv']);
function dependencyRevision(snapshot){const pkg=JSON.parse(snapshot.files.get('package.json')??'{}');return digest(JSON.stringify([pkg.dependencies,pkg.devDependencies,pkg.engines,...[...snapshot.files].filter(([name])=>name==='package-lock.json'||/^collector\/requirements.*\.txt$/.test(name)).sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,digest(bytes)])]));}

// Deliberately exclude data, environments, secrets, caches and generated builds.
// Read complete contents: mtime alone can miss rapid writes or preserved timestamps.
export async function captureSources(root){
  const files=new Map();
  async function visit(relative){
    for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
      if(entry.name.startsWith('.')||['node_modules','__pycache__','raw','output','store','universe-cache'].includes(entry.name))continue;
      const name=relative+'/'+entry.name;
      if(name==='dist/client'||name==='dist/server')continue;
      if(entry.isDirectory())await visit(name);
      else if(entry.isFile()&&(
        relative.startsWith('dist')&&publicExtensions.has(path.extname(name))||
        (relative==='server'||relative.startsWith('server/'))&&/\.(?:m?js|cjs)$/.test(name)||
        (relative==='scripts'||relative.startsWith('scripts/'))&&/\.(?:m?js|cjs)$/.test(name)||
        (relative==='collector'||relative.startsWith('collector/'))&&(name.endsWith('.py')||/^requirements.*\.txt$/.test(entry.name))))files.set(name,await readFile(path.join(root,name)));
    }
  }
  for(const directory of ['dist','server','scripts','collector'])await visit(directory);
  for(const name of ['package.json','package-lock.json']){try{files.set(name,await readFile(path.join(root,name)));}catch(e){if(e.code!=='ENOENT')throw e;}}
  const entries=[...files].sort(([a],[b])=>a.localeCompare(b));
  return {files,revision:digest(JSON.stringify(entries.map(([name,bytes])=>[name,digest(bytes)])))};
}
export async function resolvePython(root,env=process.env){
  if(env.ASHARE_PYTHON)return env.ASHARE_PYTHON;
  for(const name of ['collector/.venv','.venv']){const executable=path.join(root,name,process.platform==='win32'?'Scripts/python.exe':'bin/python');try{await access(executable);return executable;}catch{}}
  return process.platform==='win32'?'python':'python3';
}

// Build from a captured copy, never from files being changed by git pull.
// The same copy is used by Node modules, Workers and Python subprocesses.
export async function prepareRuntime(snapshot,{root,dataDir,python,validatePython=true}={}){
  const runtime=path.join(dataDir,'runtime',snapshot.revision+'-'+randomUUID());
  try{
    for(const [name,bytes] of snapshot.files){const target=path.join(runtime,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);}
    for(const [name,bytes] of snapshot.files)if(/\.(?:m?js|cjs)$/.test(name))await transform(bytes.toString('utf8'),{loader:'js',format:'esm',target:'es2022',sourcefile:name,logLevel:'silent'});
    if(validatePython){
      const paths=[...snapshot.files.keys()].filter(name=>name.endsWith('.py'));
      try{await run(python,['-c','import ast,sys,pathlib\nfor f in sys.argv[1:]: ast.parse(pathlib.Path(f).read_text(encoding="utf-8-sig"),filename=f)',...paths],{cwd:runtime,windowsHide:true,timeout:30000,maxBuffer:1024*1024});}
      catch(e){if(e.code!=='ENOENT')throw Error('Python源码检查失败：'+(e.stderr||e.message));}
    }
    const worker=await build({absWorkingDir:runtime,entryPoints:['server/worker.mjs'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent'});
    const backend=await build({absWorkingDir:runtime,entryPoints:['scripts/local-server.mjs'],bundle:true,format:'esm',platform:'node',target:'node22',write:false,metafile:true,logLevel:'silent'});
    const backendFiles=new Set([...Object.keys(worker.metafile.inputs),...Object.keys(backend.metafile.inputs),...snapshot.files.keys()].filter(name=>name.startsWith('server/')||name.startsWith('collector/')||name==='scripts/local-server.mjs'||name==='package.json'));
    for(const name of [...Object.keys(worker.metafile.inputs),...Object.keys(backend.metafile.inputs)])backendFiles.add(name);
    const backendRevision=digest(JSON.stringify([...backendFiles].sort().map(name=>[name,digest(snapshot.files.get(name)??'')])));
    for(const [name,bytes] of snapshot.files)if(name.startsWith('dist/')){const target=path.join(runtime,'dist/client',name.slice(5));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);}
    const index=path.join(runtime,'dist/client/index.html');await writeFile(index,(await readFile(index,'utf8')).replace('<head>','<head>\n<meta name="ashare-local-revision" content="'+snapshot.revision+'">'));
    return {root:runtime,assetsDir:path.join(runtime,'dist/client'),revision:snapshot.revision,backendRevision};
  }catch(e){await rm(runtime,{recursive:true,force:true});throw e;}
}

export class LocalWatcher {
  constructor({root=projectRoot,port=8080,dataDir=path.join(root,'.local-data'),pollMs=1000,debounceMs=1200,log=console.log,env=process.env,prepare=prepareRuntime}={}){
    Object.assign(this,{root:path.resolve(root),port,dataDir:path.resolve(dataDir),pollMs,debounceMs,log,env:{...env},prepare});
    this.pending=null;this.child=null;this.current=null;this.assets=null;this.stopping=false;this.runtimes=new Set();this.sequence=0;
  }
  async start(){
    this.python=await resolvePython(this.root,this.env);this.initial=await captureSources(this.root);
    this.watchHash=digest(this.initial.files.get('scripts/local-watch.mjs')??'');
    this.dependencies=dependencyRevision(this.initial);
    const runtime=await this.prepare(this.initial,{root:this.root,dataDir:this.dataDir,python:this.python});this.runtimes.add(runtime.root);
    try{await this.launch(runtime);this.current=this.assets=runtime;this.applied=this.initial.revision;}
    catch(e){await this.stopChild(false);await this.cleanup();throw e;}
    this.log('自动更新已启用：git pull 后监测源码；前端提示刷新，后台保存断点后重载。');
    this.loop=this.watch();return this;
  }
  async launch(runtime){
    const child=fork(path.join(runtime.root,'scripts/local-server.mjs'),['--port',String(this.port),'--data-dir',this.dataDir,'--assets-dir',runtime.assetsDir],{cwd:this.root,env:{...this.env,ASHARE_PYTHON:this.python,ASHARE_WATCH_REVISION:runtime.revision},stdio:['inherit','inherit','inherit','ipc'],execArgv:[]});
    this.child=child;
    child.exited=new Promise(resolve=>child.once('exit',(code,signal)=>{child.exitResult={code,signal};resolve(child.exitResult);}));
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(Error('后台启动超时；请检查启动窗口，未强制终止正在保存断点的进程')),60000);
      const onMessage=message=>{if(message?.type==='ready'){this.port=message.port;finish();}};
      const onExit=code=>finish(Error('后台启动失败（退出码 '+code+'）；请检查启动窗口日志'));
      const finish=e=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);child.off('error',finish);e?reject(e):resolve();};
      child.on('message',onMessage);child.once('exit',onExit);child.once('error',finish);
    });
  }
  async tell(info,assetsDir){
    const child=this.child;if(!child?.connected||child.exitResult)return;
    const id=++this.sequence;
    await new Promise((resolve,reject)=>{
      const finish=e=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);e?reject(e):resolve();};
      const onMessage=m=>{if(m?.type==='applied'&&m.id===id)finish();},onExit=()=>finish(Error('后台在更新状态时退出'));
      const timer=setTimeout(()=>finish(Error('后台更新状态超时')),5000);child.on('message',onMessage);child.once('exit',onExit);
      child.send({type:'runtime',id,info,assetsDir},e=>{if(e)finish(e);});
    });
  }
  async stopChild(reload){
    const child=this.child;if(!child||child.exitResult)return child?.exitResult;
    if(child.connected)child.send({type:reload?'reload':'stop'});else child.kill('SIGTERM');
    // No hard kill: a final checkpoint/Parquet rename must finish first.
    return child.exited;
  }
  async update(snapshot){
    this.log('发现源码更新，正在校验并构建候选版本……');await this.tell({state:'building',error:null});
    let candidate;
    try{
      candidate=await this.prepare(snapshot,{root:this.root,dataDir:this.dataDir,python:this.python});this.runtimes.add(candidate.root);
      if(this.stopping)return;
      if((await captureSources(this.root)).revision!==snapshot.revision){this.log('构建期间源码继续变化，等待文件稳定后再加载。');await this.tell({state:'ready'});return;}
      if(candidate.backendRevision===this.current.backendRevision){await this.tell({state:'ready',revision:candidate.revision,error:null},candidate.assetsDir);this.assets=candidate;this.log('前端已更新，采集未中断；网页会提示刷新。');}
      else{
        await this.tell({state:'reloading',error:null});this.log('后台代码已更新：保存断点、停止旧版本并恢复兼容任务……');
        const previous=this.current,previousAssets=this.assets,exit=await this.stopChild(true);
        if(this.stopping)return;
        if(exit?.code!==0){await this.launch(previous);await this.tell({state:'error',error:'旧后台未能正常保存断点；继续旧版本，请检查启动日志'},previousAssets.assetsDir);throw Error('断点保存失败，未切换后台版本');}
        try{await this.launch(candidate);}catch(e){await this.stopChild(false);await this.launch(previous);await this.tell({state:'error',revision:previousAssets.revision,error:'新后台启动失败，已回退旧版本；请检查启动日志'},previousAssets.assetsDir);throw e;}
        this.current=this.assets=candidate;this.log('后台重载完成；兼容任务自动恢复，停机时间不计入累计耗时。');
      }
      this.applied=snapshot.revision;
      this.failedRevision=null;
      if(digest(snapshot.files.get('scripts/local-watch.mjs')??'')!==this.watchHash){await this.tell({supervisorRestartRequired:true});this.log('监测器自身也有更新；应用已重载，监测器的新逻辑需在方便时重启一次。');}
      if(dependencyRevision(snapshot)!==this.dependencies){await this.tell({dependencyRestartRequired:true});this.log('依赖清单已更新：请按说明安装依赖并重启一次；自动更新不会自行安装软件。');}
    }catch(e){this.failedRevision=snapshot.revision;this.log('自动更新失败，保留上一个可用版本：'+e.message);await this.tell({state:'error',error:'自动更新校验或启动失败，继续上一个可用版本；请查看服务窗口日志'}).catch(()=>{});}
    finally{await this.cleanup();}
  }
  async cleanup(){
    const keep=new Set([this.current?.root,this.assets?.root]);
    if(!this.current&&this.child&&!this.child.exitResult)return;
    for(const root of this.runtimes)if(!keep.has(root)){await rm(root,{recursive:true,force:true});this.runtimes.delete(root);}
  }
  async watch(){
    while(!this.stopping){
      await delay(this.pollMs);if(this.stopping)break;
      if(this.child?.exitResult){this.log('后台意外退出，监测器停止；请检查日志后重新启动，断点已保留。');this.stopping=true;break;}
      try{
        const snapshot=await captureSources(this.root);
        if(snapshot.revision===this.applied){if(this.failedRevision){await this.tell({state:'ready',error:null});this.failedRevision=null;this.attempted=null;}this.pending=null;continue;}
        if(this.pending?.revision!==snapshot.revision){this.pending={revision:snapshot.revision,since:Date.now()};continue;}
        if(Date.now()-this.pending.since<this.debounceMs||snapshot.revision===this.attempted)continue;
        this.attempted=snapshot.revision;await this.update(snapshot);
      }catch(e){this.log('源码监测暂未完成，继续当前版本：'+e.message);}
    }
  }
  async close(){if(this.closePromise)return this.closePromise;this.stopping=true;this.closePromise=(async()=>{await this.loop;await this.stopChild(false);this.current=this.assets=null;await this.cleanup();})();return this.closePromise;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(Number(process.versions.node.split('.')[0])<22){console.error('需要 Node.js 22 或更高版本，推荐24 LTS。');process.exit(1);}
  const options={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--port')options.port=Number(process.argv[++i]);else if(key==='--data-dir')options.dataDir=path.resolve(process.argv[++i]);else{console.error('用法：node scripts/local-watch.mjs [--port 8080] [--data-dir 路径]');process.exit(1);}}
  if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<1||options.port>65535)){console.error('端口需为1–65535的整数');process.exit(1);}
  let watcher;try{watcher=await new LocalWatcher(options).start();}catch(e){console.error('自动更新服务启动失败：'+e.message+'。首次安装请运行 npm ci；固定版本可用 npm run build:app 后 npm run start:fixed。');process.exit(1);}
  const stop=()=>watcher.close().then(()=>process.exit(0),e=>{console.error('关闭失败：'+e.message);process.exit(1);});process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
