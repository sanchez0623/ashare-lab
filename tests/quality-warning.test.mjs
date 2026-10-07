import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {auditBundle,prepareBundle,isAuditAdmitted} from '../dist/quality.mjs';
import {backtest,defaults} from '../dist/engine.mjs';
import {acceptanceAudit} from '../server/research.mjs';

const config=b=>({...defaults,strategy:'ma',from:b.calendar[65],to:b.calendar.at(-1),fast:2,slow:3,timeframe:'5m',dataMode:'formal'});
function warningBundle(){const b=fixture(120);for(const r of b.bars)if(r.date.startsWith(b.calendar[70]))r.volume*=1.01;return b;}

test('volume discrepancies warn in every execution period without scaling candles or changing current non-volume signals',()=>{
  const good=fixture(120),b=warningBundle(),before=JSON.stringify(b),q=auditBundle(b);
  assert.equal(q.status,'warning');assert.equal(q.warningCount,1);assert.ok(isAuditAdmitted(q));assert.equal(q.blockingCount,0);assert.ok(q.issues.every(x=>x.severity==='warning'));assert.equal(prepareBundle(b).bars[70*48].volume,10100);
  for(const timeframe of ['5m','15m','1d']){const c={...config(b),timeframe},r=backtest(b,c),baseline=backtest(good,c);assert.equal(r.audit.qualityReport.status,'warning');assert.deepEqual(r.trades,baseline.trades);assert.deepEqual(r.curve,baseline.curve);assert.ok(r.warnings.some(x=>x.includes('数据')||x.includes('未修复')));assert.deepEqual(r,backtest(b,c));}
  assert.equal(JSON.stringify(b),before);
});

test('valid price discrepancies warn, including extrema and close, with no daily-to-minute reconstruction',()=>{
  const b=fixture(120),day=b.calendar[70],rows=b.bars.filter(r=>r.date.startsWith(day)),d=b.daily[70];d.high=Math.max(...rows.map(r=>r.high));d.low=Math.min(...rows.map(r=>r.low));rows[0].open+=.02;rows[0].high=Math.max(rows[0].high,rows[0].open);rows[0].low-=.02;rows.at(-1).close+=.02;rows.at(-1).high=rows.at(-1).close+.02;
  const before=JSON.stringify(b),q=auditBundle(b);assert.equal(q.status,'warning');assert.equal(q.warningCount,4);assert.equal(q.warnings.length,2);assert.equal(backtest(b,config(b)).audit.qualityReport.status,'warning');assert.equal(JSON.stringify(b),before);
});

test('warnings do not downgrade missing candles, unknown ST, invalid daily prices or missing corporate proof',()=>{
  for(const mutate of [b=>b.bars.splice(70*48,1),b=>delete b.daily[70].isST,b=>delete b.daily[70].close,b=>b.daily[70].volume=NaN,b=>delete b.metadata.coverage.actions,b=>b.bars[70*48].low=b.bars[70*48].high+1]){const b=warningBundle();mutate(b);const q=auditBundle(b);assert.equal(q.status,'blocked');assert.ok(q.blockingIssues.length);assert.ok(!isAuditAdmitted(q));assert.throws(()=>backtest(b,config(b)),/数据准入/);}
});

test('annual admission retains warning disposition and real historical member blockers',()=>{
  const b=warningBundle(),c=config(b),request={symbol:b.metadata.symbol,board:b.metadata.board,purpose:'research',from:c.from,to:c.to,warmupSessions:60};
  assert.equal(acceptanceAudit(b,request).status,'warning');const collected=acceptanceAudit(b,{...request,purpose:'collect'});assert.equal(collected.status,'warning');assert.equal(collected.scope,'market-data-only');
  b.universe=[];assert.equal(acceptanceAudit(b,request).status,'blocked');assert.equal(acceptanceAudit(b,{...request,purpose:'collect'}).status,'warning');
});
