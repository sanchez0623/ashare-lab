import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,withEvent} from './fixture.mjs';
import {auditBundle} from '../dist/quality.mjs';
import {actionDiagnosticReport} from '../dist/action-diagnostics.mjs';
import {assembleBundles} from '../server/assemble.mjs';
import {fragments} from './assembly-fixture.mjs';

test('ex economics uses last trading close rather than earlier record-date close',()=>{
 const b=withEvent(fixture(100));b.actions[0].recordDate=b.calendar[45];b.actions[0].announcementTime=b.calendar[44]+' 00:00';
 const before=JSON.stringify(b),q=auditBundle(b);assert.equal(q.status,'passed');const c=q.actionChecks[0];assert.equal(c.previousTradingDate,b.calendar[49]);assert.notEqual(c.recordClose,c.previousTradingClose);assert.equal(c.economicsStatus,'passed');assert.equal(JSON.stringify(b),before);
});
test('unreconciled cash economics still blocks alongside volume warnings and preserves exact fields',()=>{
 const b=withEvent(fixture(100));b.actions[0].cashPerShare=.3;for(const r of b.bars)if(r.date.startsWith(b.calendar[60]))r.volume*=2;
 const q=auditBundle(b),d=actionDiagnosticReport(b,q,[{id:'a'.repeat(64),bundle:b}]);assert.equal(q.status,'blocked');assert.ok(q.warnings.some(x=>x.code==='DAILY_CROSSCHECK'));assert.ok(d.issues.some(x=>x.code==='ACTION_ECONOMICS'));assert.equal(d.checks[0].cashPerShare,.3);assert.equal(d.checks[0].reportedReference,b.actions[0].referencePrice);assert.equal(d.parents[0].daily.length,2);assert.equal(d.checks[0].economicsStatus,'failed');
});
test('assembly failure names corporate blocker and attaches corporate report separately from minute warnings',()=>{
 const {parents,input}=fragments();const p=parents[0].bundle;p.actions[0].cashPerShare=.3;
 // Only this first source contains the affected early history; no source-value
 // rewriting or provider request is performed by the assembler.
 for(const r of p.bars)if(r.date.startsWith(p.daily[90].date))r.volume*=2;
 assert.throws(()=>assembleBundles(parents,input),e=>e.code==='ASSEMBLY_ADMISSION'&&e.message.includes('真正阻断的是公司行动')&&e.details.actionDiagnostics.checks.length>0&&e.details.reconciliation!==null);
});
