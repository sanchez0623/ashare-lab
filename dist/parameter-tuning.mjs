import {backtest,defaults,validate,qualityScore,compareManagement} from './engine.mjs';

export const tuningVersion='1';
const keys=['dailySlow','atrMult','confirmationDays'];
const same=(a,b)=>keys.every(k=>a[k]===b[k]);
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const around=(v,step,min,max)=>[...new Set([v,clamp(Number((v-step).toFixed(6)),min,max),clamp(Number((v+step).toFixed(6)),min,max)])];

export function tuningCandidates(config,options={}){
  const c={...defaults,...config};validate(c);
  if(c.strategy!=='swing')throw Error('自动微调目前针对大波段趋势策略，请先在策略配置中选择大波段趋势。');
  const steps={dailySlowStep:options.dailySlowStep??5,atrStep:options.atrStep??.25,confirmationStep:options.confirmationStep??1};
  if(!Number.isInteger(steps.dailySlowStep)||steps.dailySlowStep<1||steps.dailySlowStep>50||!Number.isFinite(steps.atrStep)||steps.atrStep<.05||steps.atrStep>2||!Number.isInteger(steps.confirmationStep)||steps.confirmationStep<1||steps.confirmationStep>3)throw Error('微调步长无效：均线1–50日、ATR 0.05–2、确认1–3日。');
  const grid={dailySlow:around(c.dailySlow,steps.dailySlowStep,2,250).filter(v=>v>c.dailyFast),atrMult:around(c.atrMult,steps.atrStep,0,10),confirmationDays:around(c.confirmationDays,steps.confirmationStep,1,10)};
  const candidates=[];
  for(const dailySlow of grid.dailySlow)for(const atrMult of grid.atrMult)for(const confirmationDays of grid.confirmationDays){
    const candidate={...c,dailySlow,atrMult,confirmationDays};
    candidates.push({id:`${dailySlow}/${atrMult}/${confirmationDays}`,config:candidate,distance:Math.abs(dailySlow-c.dailySlow)/steps.dailySlowStep+Math.abs(atrMult-c.atrMult)/steps.atrStep+Math.abs(confirmationDays-c.confirmationDays)/steps.confirmationStep});
  }
  return {grid,steps,candidates};
}
export function tuneParameters(data,config,options={},progress=()=>{}){
  const c={...defaults,...config},search=tuningCandidates(c,options),input=Array.isArray(data)?data:data.bars;
  const days=[...new Set(input.filter(r=>r.date.slice(0,10)>=c.from&&r.date.slice(0,10)<=c.to).map(r=>r.date.slice(0,10)))].sort();
  if(days.length<20)throw Error('自动微调至少需要20个研究交易日，指标预热历史另行提供。');
  const split=Math.floor(days.length*.7),trainTo=days[split-1],validationFrom=days[split],rows=[];
  // Admit the current configuration first. A broken input must not become a
  // purported success merely because a shorter indicator hides its deficiency.
  const baselineTraining=backtest(data,{...c,to:trainTo}).metrics;
  for(const candidate of search.candidates){
    const row={...candidate,isBaseline:same(candidate.config,c)};
    try{row.training=row.isBaseline?baselineTraining:backtest(data,{...candidate.config,to:trainTo}).metrics;row.quality=qualityScore(row.training,c);row.trainingDelta=row.training.total-baselineTraining.total;}
    catch(e){row.error=e.message;}
    rows.push(row);progress({phase:'training',completed:rows.length,total:search.candidates.length});
  }
  rows.sort((a,b)=>Number(!!a.error)-Number(!!b.error)||Number(!!b.quality?.eligible)-Number(!!a.quality?.eligible)||(b.quality?.score??-Infinity)-(a.quality?.score??-Infinity)||a.distance-b.distance);
  // Freeze the winner BEFORE inspecting any held-out metrics or failures.
  const winner=rows.find(r=>r.quality?.eligible),recommendation=winner?{id:winner.id,config:{...winner.config},changed:!winner.isBaseline,changes:keys.filter(k=>winner.config[k]!==c[k]).map(key=>({key,before:c[key],after:winner.config[key]}))}:null;
  for(let i=0;i<rows.length;i++){
    const row=rows[i];if(!row.error)try{row.validation=backtest(data,{...row.config,from:validationFrom}).metrics;}catch(e){row.validationError=e.message;}
    progress({phase:'validation',completed:i+1,total:rows.length});
  }
  const baseline=rows.find(r=>r.isBaseline);
  for(const row of rows)if(row.validation&&baseline.validation)row.validationDelta=row.validation.total-baseline.validation.total;
  return {schemaVersion:1,type:'parameter-tuning',tuningVersion,inputConfig:c,grid:search.grid,steps:search.steps,rows,baseline,recommendation,qualified:rows.filter(r=>r.quality?.eligible).length,trainFrom:c.from,trainTo,validationFrom,validationTo:c.to,selectionRule:'training_quality_only',positionPolicy:'each segment starts flat; previous bars are indicator warmup only',baselinePolicy:'same market snapshot, dates, capital, fees and position scheme; current parameters are the baseline'};
}
export function tuneManagement(data,config,progress=()=>{}){
  const c={...defaults,...config};progress({phase:'management',completed:0,total:5});
  const result=compareManagement(data,{...c,objective:'quality'}),baseline=result.rows.find(r=>r.config.management==='base'),winner=result.rows.find(r=>r.quality?.eligible);
  progress({phase:'management',completed:5,total:5});
  return {schemaVersion:1,type:'management-comparison',tuningVersion,inputConfig:c,...result,baseline,recommendation:winner?{config:{...winner.config},changed:winner.config.management!==c.management,changes:winner.config.management!==c.management?[{key:'management',before:c.management,after:winner.config.management}]:[]}:null};
}
