import registry from './corporate-evidence.json' with {type:'json'};
export const officialEvidence=registry;
export const actionStable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=message=>{throw Object.assign(Error(message),{code:'ACTION_CORRECTION_PROOF',status:409});};
const value=a=>Object.fromEntries(Object.entries(a).filter(([k])=>k!=='id'));
const close=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<=.011;
const sameTerms=(a,e)=>Object.entries(e.terms).every(([k,v])=>k==='cashPerShare'||a[k]===v)&&!a.rightsPerShare&&!a.rightsPrice;
const corrected=(a,e)=>({...a,cashPerShare:e.terms.cashPerShare,announcementTime:a.announcementTime>e.publishedAt?a.announcementTime:e.publishedAt});

// Match explicit reviewed terms, never derive dividend cash from rounded prices.
// A special dividend is a replacement of the incomplete total, not an addition.
export function officialCorrectionPlan(symbol,actions,daily){
 const corrections=[],conflicts=[];
 for(const e of registry.records.filter(e=>e.symbol===symbol)){
  const matches=(actions??[]).filter(a=>a.exDate===e.terms.exDate);
  if(!matches.length)continue;
  if(matches.length!==1){conflicts.push(e.terms.exDate+'：公司行动重复，需核验');continue;}
  const a=matches[0];if(a.cashPerShare===e.terms.cashPerShare)continue;
  if(!sameTerms(a,e)||!e.acceptedOriginalCashPerShare.includes(a.cashPerShare)||typeof a.announcementTime!=='string'||a.announcementTime.slice(0,10)>e.terms.exDate){conflicts.push(e.terms.exDate+'：现有资料与已核验公告条件不一致，不能自动修订');continue;}
  if(daily){const d=daily.find(d=>d.date===e.terms.exDate),previous=daily.filter(d=>d.date<e.terms.exDate&&d.halted===0).at(-1);
   if(!close(previous?.close,e.previousTradingClose)||!close(d?.prev_close,e.exchangeReference)||!close(a.referencePrice,e.exchangeReference)){conflicts.push(e.terms.exDate+'：原始日线或事件参考价与公告核验值不符');continue;}}
  corrections.push({evidenceId:e.id,evidence:e,before:structuredClone(a),after:corrected(a,e)});
 }
 return {corrections,conflicts};
}
export function verifyOfficialCorrections(bundle){
 const proof=bundle.metadata?.corporateCorrections;if(!proof)return;
 if(proof.version!==registry.version||!Array.isArray(proof.records)||!proof.records.length)fail('公司行动修订证据版本或记录无效');
 const seen=new Set();for(const r of proof.records){const e=registry.records.find(e=>e.id===r.evidenceId&&e.symbol===bundle.metadata.symbol);
  if(!e||seen.has(r.evidenceId)||r.documentSHA256!==e.documentSHA256||r.sourceURL!==e.sourceURL||r.sourceSnapshotId!==null&&!/^[a-f0-9]{64}$/.test(r.sourceSnapshotId??''))fail('公司行动修订公告、父快照或重复记录无效');seen.add(r.evidenceId);
  const p=officialCorrectionPlan(e.symbol,[r.before]);if(p.conflicts.length||p.corrections.length!==1||actionStable(value(p.corrections[0].after))!==actionStable(value(r.after)))fail('公司行动修改前后值与核验公告不符');
  const current=(bundle.actions??[]).filter(a=>a.exDate===e.terms.exDate);if(current.length!==1||actionStable(value(current[0]))!==actionStable(value(r.after)))fail('公司行动修订记录与当前事件不符');
 }
}
export function correctOfficialActions(bundle,sourceSnapshotId=null){
 verifyOfficialCorrections(bundle);
 const plan=officialCorrectionPlan(bundle.metadata.symbol,bundle.actions,bundle.daily);
 if(plan.conflicts.length)fail(plan.conflicts.join('；'));
 if(!plan.corrections.length)return {bundle,changes:[]};
 const copy=structuredClone(bundle),records=copy.metadata.corporateCorrections?.records??[];
 for(const c of plan.corrections){const index=copy.actions.findIndex(a=>a.exDate===c.before.exDate);copy.actions[index]=c.after;records.push({evidenceId:c.evidenceId,documentSHA256:c.evidence.documentSHA256,sourceURL:c.evidence.sourceURL,sourceSnapshotId,before:c.before,after:c.after});}
 copy.metadata.corporateCorrections={version:registry.version,records};
 if(copy.metadata.parquetArchive){copy.metadata.originalParquetArchive=copy.metadata.parquetArchive;delete copy.metadata.parquetArchive;}
 verifyOfficialCorrections(copy);return {bundle:copy,changes:plan.corrections};
}
