import {comparePortfolio} from './portfolio.mjs';
self.onmessage=({data:{id,inputs,config}})=>{try{self.postMessage({id,result:comparePortfolio(inputs,config)});}catch(e){self.postMessage({id,error:e.message});}};
