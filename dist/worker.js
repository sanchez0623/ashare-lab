import {backtest,compareParameters} from './engine.mjs';
self.onmessage=({data:{id,type,data,config}})=>{
  try{self.postMessage({id,result:type==='compare'?compareParameters(data,config):backtest(data,config)});}
  catch(e){self.postMessage({id,error:e.message});}
};
