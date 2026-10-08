import {mkdir,cp,readdir,rm,rename} from 'node:fs/promises';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolvePython} from './local-watch.mjs';
const python=await resolvePython(process.cwd()),staging='.local-build-'+randomUUID();
execFileSync(python,['scripts/render-guide.py'],{stdio:'inherit'});
await mkdir(staging+'/client',{recursive:true});
const installed=[],backups=[];
try{
  // Validate first. A failed build must not remove the currently usable UI.
  await build({entryPoints:['server/worker.mjs'],outfile:staging+'/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022'});
  for(const f of await readdir('dist'))if(!['client','server'].includes(f)&&!f.endsWith('.zip'))await cp('dist/'+f,staging+'/client/'+f,{recursive:true});
  for(const name of ['client','server']){try{await rename('dist/'+name,staging+'/old-'+name);backups.push(name);}catch(e){if(e.code!=='ENOENT')throw e;}await rename(staging+'/'+name,'dist/'+name);installed.push(name);}
}catch(e){for(const name of installed)await rm('dist/'+name,{recursive:true,force:true});for(const name of backups)await rename(staging+'/old-'+name,'dist/'+name);throw e;}
finally{await rm(staging,{recursive:true,force:true});}
if(!process.argv.includes('--no-package'))execFileSync(python,['-c',`import zipfile,pathlib
with zipfile.ZipFile('dist/client/collector-kit.zip','w',zipfile.ZIP_DEFLATED) as z:
 z.write('dist/corporate-evidence.json','dist/corporate-evidence.json')
 for p in pathlib.Path('collector').glob('*'):
  if p.is_file() and p.suffix in ('.py','.md','.txt','.json','.service','.timer'):z.write(p,str(p))
`]);
if(!process.argv.includes('--no-package'))execFileSync(python,['scripts/package-local.py','dist/client/ashare-lab-local.zip'],{stdio:'inherit'});
