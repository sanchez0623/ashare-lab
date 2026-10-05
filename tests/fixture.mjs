import {slots,dayOf,dailyGroups} from '../dist/data.mjs';
export function fixture(n=90){
 const bars=[],calendar=[];let p=10,di=0;for(let date=new Date('2024-01-02T00:00:00Z');di<n;date.setUTCDate(date.getUTCDate()+1)){if([0,6].includes(date.getUTCDay()))continue;const day=date.toISOString().slice(0,10);calendar.push(day);const prev=p;for(const time of slots(5)){const open=p;p+=.001;bars.push({date:day+' '+time,open,high:p+.002,low:open-.002,close:p,volume:10000,halted:0,prev_close:prev});}di++;}
 const daily=dailyGroups(bars).map(d=>({date:d.date,open:d.open,close:d.close,volume:d.volume,prev_close:bars[d.startIndex].prev_close,halted:0,isST:0,knownAt:d.date+' 09:00',causalFactor:1}));
 const codes=['sh.600519',...Array.from({length:299},(_,i)=>'sh.'+(600000+i))];
 return {schemaVersion:1,metadata:{synthetic:true,name:'合成测试；不是真实沪深300行情',symbol:'600519',board:'main',listedDate:'2001-08-27',listingSessionOffset:5000,universe:'HS300',source:'synthetic fixture',timeframe:'5m',priceBasis:'raw',volumeUnit:'shares',timezone:'Asia/Shanghai',timestampConvention:'bar-close',requested:{from:calendar[0],to:calendar.at(-1)},coverage:Object.fromEntries(['calendar','daily','factors','actions','universe'].map(k=>[k,{status:'complete',from:calendar[0],to:calendar.at(-1),source:'synthetic test only'}]))},calendar,bars,daily,universe:calendar.map(date=>({date,updateDate:date,knownAt:date+' 09:00',codes,source:'synthetic'})),actions:[],factors:[]};
}
export function withEvent(b,index=50,{cash=1,bonus=.2,payDelay=3,listDelay=5}={}){
 const day=b.calendar[index],record=b.calendar[index-1],previous=b.daily[index-1].close,reference=(previous-cash)/(1+bonus),ratio=previous/reference;
 b.actions.push({id:'test-ex-'+day,type:'dividend',announcementTime:record+' 00:00',recordDate:record,exDate:day,payDate:b.calendar[index+payDelay],shareListDate:b.calendar[index+listDelay],cashPerShare:cash,bonusPerShare:bonus,cashBasis:'gross',referencePrice:reference});
 for(const r of b.bars)if(dayOf(r)>=day)for(const k of ['open','high','low','close'])r[k]/=ratio;
 for(let j=index;j<b.daily.length;j++){const d=b.daily[j];d.close/=ratio;d.open/=ratio;d.prev_close=j===index?reference:b.daily[j-1].close;d.causalFactor=ratio;}
 return b;
}
