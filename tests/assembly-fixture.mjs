// Explicit synthetic annual snapshots with independently based factor chains.
import {createHash} from 'node:crypto';import {fixture,withEvent} from './fixture.mjs';import {canonical} from '../server/assemble.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function fragments(){
  const full=withEvent(withEvent(fixture(740),300,{cash:.1,bonus:.02}),430,{cash:.2,bonus:.03});
  Object.assign(full.metadata,{symbol:'001389',universe:'SINGLE_SECURITY',collectionPurpose:'market-data-only'});full.universe=[];full.metadata.coverage.universe={status:'not-requested'};
  let factor=1,previous=null;for(const d of full.daily){if(previous)factor*=previous/d.prev_close;d.causalFactor=factor;previous=d.close;}
  const cut=(from,to)=>{const b=structuredClone(full),start=b.calendar.filter(d=>d<from).at(-60);b.metadata.requested={from:start,to};b.metadata.research={from,to,warmupSessions:60};b.calendar=b.calendar.filter(d=>d<=to);b.daily=b.daily.filter(d=>d.date>=start&&d.date<=to);const base=b.daily[0].causalFactor;for(const d of b.daily)d.causalFactor/=base;b.bars=b.bars.filter(r=>r.date.slice(0,10)>=start&&r.date.slice(0,10)<=to);b.actions=b.actions.filter(a=>a.exDate>=start&&a.exDate<=to);for(const k of ['calendar','daily','actions','factors'])Object.assign(b.metadata.coverage[k],{from:start,to});return b;};
  const early=cut('2024-10-01','2025-09-30'),late=cut('2025-10-01','2026-09-30');for(const a of late.actions)a.id='different-fragment-id-'+a.id;
  const parent=bundle=>({id:hash(canonical(bundle)),bundle});return {full,parents:[parent(early),parent(late)],input:{symbol:'001389',from:'2024-10-01',to:'2026-09-30',warmupSessions:60}};
}
