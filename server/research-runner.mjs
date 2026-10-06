import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {backtest} from '../dist/engine.mjs';
try {
  const bundle=JSON.parse(await readFile(workerData.snapshot,'utf8'));
  parentPort.postMessage({result:backtest(bundle,workerData.config)});
} catch(e){parentPort.postMessage({error:e.message});}
