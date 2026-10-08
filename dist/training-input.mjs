import {parameterSchema,validateParameterValue} from './parameter-schema.mjs';

export const trainingKeys=['minTrades','minProfitFactor','maxDrawdown'];
export function trainingInputIssue(key,value){
 if(!trainingKeys.includes(key))return null;
 try{validateParameterValue(key,value);return null;}catch{
  const s=parameterSchema[key],label=key==='minTrades'?'最少已平仓样本':s.label;
  return {key,message:`${label}必须为 ${s.min}–${s.max} ${s.step===1?'之间的整数':'之间的数值，步长 '+s.step}${key==='minTrades'?'（笔）':''}；当前为 ${Number.isFinite(value)?value:'空值或无效数字'}。`};
 }
}
export function validateTrainingInputs(c){
 for(const key of trainingKeys){const issue=trainingInputIssue(key,c[key]);if(issue)throw Object.assign(Error(issue.message),{parameter:key});}
}
