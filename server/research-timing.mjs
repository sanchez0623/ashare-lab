// Operational timing is separate from immutable market data/result hashes.
export const iso=at=>new Date(at).toISOString();
export function ensureTiming(job){
  if(!job.timing)job.timing={version:1,activeMs:0,stages:{},runs:[],accountedAt:null,...(job.createdAt?{legacyUnmeasured:true}:{})};
  return job.timing;
}
export function accrue(job,at){
  const t=ensureTiming(job);
  if(t.accountedAt===null)return;
  const elapsed=Math.max(0,at-t.accountedAt);t.activeMs+=elapsed;
  t.stages[job.stage]=(t.stages[job.stage]??0)+elapsed;
  const run=t.runs.at(-1);if(run&&!run.endedAt)run.activeMs+=elapsed;
  t.accountedAt=at;
}
export function startTiming(job,at){
  const t=ensureTiming(job);t.accountedAt=at;
  t.runs.push({startedAt:iso(at),endedAt:null,activeMs:0,stopReason:null});
}
export function stopTiming(job,at,reason,{recovered=false}={}){
  const t=ensureTiming(job);
  // A recovered process can only certify the last durable heartbeat. Never
  // charge process downtime or invent the unobserved tail of a crashed run.
  const end=recovered?t.accountedAt:at;
  if(!recovered)accrue(job,at);
  const run=t.runs.at(-1);
  if(run&&!run.endedAt){run.endedAt=iso(end??at);run.stopReason=reason;}
  if(recovered)t.interruptedTailUnmeasured=true;
  t.accountedAt=null;
}
export function timingView(job,at){
  const copy={stage:job.stage,timing:structuredClone(ensureTiming(job))};accrue(copy,at);return copy.timing;
}
