import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),run=promisify(execFile);
export async function archiveCorporateCorrection(bundle,{python,root}){
 const work=path.join(root,'corporate-corrections');await mkdir(work,{recursive:true});const dir=await mkdtemp(path.join(work,'archive-')),input=path.join(dir,'input.json'),output=path.join(dir,'bundle.json');
 try{await writeFile(input,JSON.stringify(bundle));await run(await python(),[path.join(project,'collector/repair_archive.py'),'--input',input,'--output',output,'--root',path.join(root,'market','parquet')],{windowsHide:true,timeout:60000,maxBuffer:1024*1024});return JSON.parse(await readFile(output,'utf8'));}
 catch{throw Object.assign(Error('公司行动Parquet归档失败，未确认新快照保存。请检查本地Python与pyarrow依赖后重试；原快照保留。'),{code:'ACTION_CORRECTION_ARCHIVE',status:409});}
 finally{await rm(dir,{recursive:true,force:true});}
}
