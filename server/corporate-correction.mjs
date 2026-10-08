import {correctOfficialActions,verifyOfficialCorrections,actionStable} from '../dist/corporate-correction.mjs';
import {auditBundle} from '../dist/quality.mjs';
import {verifyRepairSnapshot,repairScope} from '../dist/minute-repair.mjs';
import {canonical,sha256} from './assemble.mjs';
const fail=(code,message)=>{throw Object.assign(Error(message),{code,status:409});};

export async function correctStoredActions(bucket,input,{archiver}={}){
 if(!Array.isArray(input?.snapshots))fail('ACTION_CORRECTION_REQUEST','请选择已保存的完整行情快照');
 const ids=[...new Set(input?.snapshots??[])].sort();
 if(!Array.isArray(input?.snapshots)||!ids.length||ids.length>64||ids.some(id=>!(/^[a-f0-9]{64}$/.test(id))))fail('ACTION_CORRECTION_REQUEST','请选择1至64个已保存的完整行情快照');
 const parents=[];let size=0;
 // Validate every parent before publishing any correction.
 for(const id of ids){const o=await bucket.get('snapshots/'+id+'.json');if(!o)fail('ACTION_CORRECTION_MISSING','原始快照不存在：'+id.slice(0,12));const bytes=new Uint8Array(await new Response(o.body).arrayBuffer());size+=bytes.length;if(size>40*1024*1024)fail('ACTION_CORRECTION_SIZE','修订来源合计超过40MB');if(await sha256(bytes)!==id)fail('SNAPSHOT_HASH','原始快照哈希不符');const b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(b.metadata?.synthetic)fail('ACTION_CORRECTION_IDENTITY','公告修复仅用于真实行情快照');if(b.metadata?.minuteRepair)await verifyRepairSnapshot(b);parents.push({id,...correctOfficialActions(b,id)});}
 const entries=[];
 for(const p of parents){if(!p.changes.length){entries.push({originalId:p.id,id:p.id,changed:false});continue;}
  let b=p.bundle;
  if(archiver){const archived=await archiver(b);const before=structuredClone(b),after=structuredClone(archived);delete before.metadata.parquetArchive;delete after.metadata.parquetArchive;if(actionStable(before)!==actionStable(after)||!archived.metadata.parquetArchive)fail('ACTION_CORRECTION_ARCHIVE','归档改变了行情或修订依据');b=archived;}
  verifyOfficialCorrections(b);if(b.metadata.minuteRepair)await verifyRepairSnapshot(b);
  const report=auditBundle(b,{scope:repairScope(b)}),bytes=new TextEncoder().encode(canonical(b));if(bytes.length>25*1024*1024)fail('ACTION_CORRECTION_SIZE','修订快照超过25MB');const id=await sha256(bytes),key='manifests/'+id+'.json',old=await bucket.get(key);
  let manifest;
  if(old){const saved=await bucket.get('snapshots/'+id+'.json');if(!saved||await sha256(new Uint8Array(await new Response(saved.body).arrayBuffer()))!==id)fail('SNAPSHOT_HASH','已保存修订快照哈希不符');manifest=await old.json();}
  else {const m=b.metadata;manifest={id,symbol:m.symbol,name:m.name,board:m.board,timeframe:m.timeframe,source:m.source,research:m.research,corporateCorrections:{baseSnapshotId:p.id,evidenceIds:m.corporateCorrections.records.map(r=>r.evidenceId)},...(m.minuteRepair?{minuteRepair:{baseSnapshotId:m.minuteRepair.baseSnapshotId,verifiedDays:m.minuteRepair.days.length}}:{}),syncedAt:new Date().toISOString(),bytes:bytes.length,report};await bucket.put('snapshots/'+id+'.json',bytes,{httpMetadata:{contentType:'application/json'}});const saved=await bucket.get('snapshots/'+id+'.json');if(!saved||await sha256(new Uint8Array(await new Response(saved.body).arrayBuffer()))!==id)fail('SNAPSHOT_HASH','修订写入后哈希核对失败');await bucket.put(key,canonical(manifest),{httpMetadata:{contentType:'application/json'}});}
  entries.push({...manifest,originalId:p.id,changed:true,reused:!!old});
 }
 return {version:'official-action-1',entries,changedSnapshots:entries.filter(e=>e.changed).length,policy:'originals retained; reviewed official terms only; raw prices and factors unchanged; all admission checks rerun'};
}
