import {tuneParameters,tuneManagement} from './parameter-tuning.mjs';
self.onmessage=({data:{type,data,config,options}})=>{
  try{const progress=value=>self.postMessage({progress:value});const result=type==='management'?tuneManagement(data,config,progress):tuneParameters(data,config,options,progress);self.postMessage({result});}
  catch(e){self.postMessage({error:e.message});}
};
