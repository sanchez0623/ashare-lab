export function actionDiagnosticReport(bundle,audit,parents=[]){
 const issues=audit.blockingIssues.filter(i=>/^(ACTION_|EX_REFERENCE|RIGHTS|FACTOR_|SOURCE_FACTOR|UNACCOUNTED_ACTION|DIVIDEND_TAX)/.test(i.code));
 if(!issues.length)return null;
 return {schemaVersion:1,kind:'corporate-action-diagnostics',symbol:bundle.metadata.symbol,requested:bundle.metadata.requested,auditVersion:audit.version,issues,checks:audit.actionChecks??[],actions:bundle.actions??[],factors:bundle.factors??[],parents:parents.map(p=>({snapshotId:p.id,actions:p.bundle.actions??[],daily:(p.bundle.daily??[]).filter(d=>(audit.actionChecks??[]).some(c=>[c.previousTradingDate,c.recordDate,c.exDate].includes(d.date)))})),policy:'corporate defects block; minute price-volume warnings do not repair entitlements; no inferred cash, bonus or rights'};
}
