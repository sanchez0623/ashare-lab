// Native collection stays 5m; this is history needed by the chosen execution.
export function requiredWarmupSessions(c){const slots=c.timeframe==='1d'?1:c.timeframe==='5m'?48:16;return Math.max(60,c.dailySlow,c.breakout+1,c.exitPeriod,c.atrPeriod,c.confirmationDays+1,Math.ceil(Math.max(c.slow,(c.macdSlow??26)+(c.macdSignal??9),c.rsiPeriod+1,c.bbPeriod)/slots)+1);}
