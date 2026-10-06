import {mkdir,cp,readdir,rm} from 'node:fs/promises';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
execFileSync('python3',['scripts/render-guide.py'],{stdio:'inherit'});
await rm('dist/client',{recursive:true,force:true});await mkdir('dist/client',{recursive:true});
for(const f of await readdir('dist'))if(!['client','server'].includes(f))await cp('dist/'+f,'dist/client/'+f,{recursive:true});
await build({entryPoints:['server/worker.mjs'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022'});
execFileSync('python3',['-c',`import zipfile,pathlib
with zipfile.ZipFile('dist/client/collector-kit.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in pathlib.Path('collector').glob('*'):
  if p.is_file() and p.suffix in ('.py','.md','.txt','.json','.service','.timer'):z.write(p,str(p))
`]);
execFileSync('python3',['scripts/package-local.py','dist/client/ashare-lab-local.zip'],{stdio:'inherit'});
