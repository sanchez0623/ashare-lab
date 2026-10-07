"""Share complete BaoStock responses, never inferred or adjusted price bars.

The task keeps its own immutable response copies and a frozen gap plan. The
shared cache is partitioned by SDK/runtime identity; old task proofs can be
imported without trusting SQLite rows or a Parquet filename as coverage.
"""
import datetime as dt, hashlib, json, math, os, pathlib, re, tempfile

def encode(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':')).encode('utf-8')
def digest(value):return hashlib.sha256(encode(value)).hexdigest()
def fail(code,message):
    error=RuntimeError(message);error.code=code;raise error
def atomic(path,value):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,temp=tempfile.mkstemp(prefix=path.name+'.tmp-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as handle:handle.write(encode(value));handle.flush();os.fsync(handle.fileno())
        os.replace(temp,path)
    finally:
        if os.path.exists(temp):os.unlink(temp)
def read_proof(path,identity=None):
    try:
        proof=json.loads(pathlib.Path(path).read_bytes())
        if not isinstance(proof['rows'],list) or digest(proof['rows'])!=proof['sha256'] or identity is not None and proof['identity']!=identity:raise ValueError()
        if set(proof['identity'])!={'version','query'}:raise ValueError()
        return proof
    except (ValueError,KeyError,TypeError):fail('CACHE_HASH','共享原始响应哈希或身份不一致，拒绝复用：'+pathlib.Path(path).name)
def query_identity(version,key):return {'version':version,'query':key}
def valid_day(day):
    try:return isinstance(day,str) and dt.date.fromisoformat(day).isoformat()==day
    except (ValueError,TypeError):return False
def next_day(day):return (dt.date.fromisoformat(day)+dt.timedelta(days=1)).isoformat()
def prev_day(day):return (dt.date.fromisoformat(day)-dt.timedelta(days=1)).isoformat()
def dates(start,end):
    day=start
    while day<=end:yield day;day=next_day(day)
def runs(days):
    result=[]
    for day in sorted(days):
        if result and next_day(result[-1][1])==day:result[-1][1]=day
        else:result.append([day,day])
    return result
def subtract(left,right,covered):
    cursor=left
    for a,b in sorted(covered):
        if b<cursor or a>right:continue
        if a>cursor:yield cursor,prev_day(a)
        cursor=max(cursor,next_day(b))
        if cursor>right:return
    if cursor<=right:yield cursor,right
def numeric(value):
    try:
        number=float(value);return number if math.isfinite(number) else None
    except (ValueError,TypeError):return None

SLOTS=[f'{minute//60:02d}{minute%60:02d}' for left,right in [(575,690),(785,900)] for minute in range(left,right+1,5)]
def reusable_days(proof,calendar,daily,listed,delisted,left,right):
    """Require native slots, raw prices and independent daily reconciliation.
    A completed pagination response alone is not proof of a complete day.
    """
    key=proof['identity']['query'];byday={};invalid=set()
    for row in proof['rows']:
        day=row.get('date','');clock=row.get('time','')
        if row.get('code')!=key[1] or not key[3]<=day<=key[4] or row.get('adjustflag')!='3' or not isinstance(clock,str) or len(clock)!=17 or clock[:8]!=day.replace('-','') or clock[12:]!='00000':return []
        if not left<=day<=right:continue
        prices=[numeric(row.get(k)) for k in ('open','high','low','close')];volume=numeric(row.get('volume'))
        if any(p is None or p<=0 for p in prices) or volume is None or volume<0 or prices[1]<max(prices[0],prices[3]) or prices[2]>min(prices[0],prices[3]) or prices[2]>prices[1]:invalid.add(day)
        byday.setdefault(day,[]).append(row)
    good=[]
    for day in dates(left,right):
        rows=byday.get(day,[])
        if day in invalid:continue
        if day not in calendar or not listed:continue
        if calendar[day]=='0' or day<listed or delisted and day>delisted:
            if not rows:good.append(day)
            continue
        daily_rows=daily.get(day,[])
        if len(daily_rows)!=1:continue
        d=daily_rows[0]
        if d.get('code')!=key[1] or d.get('isST') not in ('0','1') or d.get('tradestatus') not in ('0','1'):continue
        if d['tradestatus']=='0':
            if all(numeric(r.get('volume'))==0 for r in rows):good.append(day)
            continue
        ordered=sorted(rows,key=lambda r:r['time'])
        if [r['time'][8:12] for r in ordered]!=SLOTS:continue
        dc=numeric(d.get('close'));dv=numeric(d.get('volume'))
        if dc is None or dc<=0 or dv is None or dv<0:continue
        if abs(numeric(ordered[-1]['close'])-dc)>.011:continue
        if abs(sum(numeric(r['volume']) for r in ordered)-dv)>max(100,dv*.005):continue
        good.append(day)
    return good

class SharedQueries:
    types={'calendar','hs300','minute'}
    def __init__(self,root,environment,version,emit=lambda x:None,check=lambda:None):
        self.root=pathlib.Path(root)/digest(environment);self.environment=environment;self.version=version;self.emit=emit;self.check=check
        self.root.mkdir(parents=True,exist_ok=True)
    def path(self,key):
        if not isinstance(key,list) or not key:fail('CACHE_IDENTITY','共享查询身份无效。')
        if key[0]=='minute' and (len(key)!=6 or not isinstance(key[1],str) or not re.fullmatch(r'(sh|sz)\.[0-9]{6}',key[1]) or key[2]!='5' or key[5]!='raw' or not valid_day(key[3]) or not valid_day(key[4]) or key[3]>key[4]):fail('CACHE_IDENTITY','共享分钟查询证券或范围无效。')
        if key[0]=='calendar' and (len(key)!=3 or not valid_day(key[1]) or not valid_day(key[2]) or key[1]>key[2]):fail('CACHE_IDENTITY','共享日历查询身份无效。')
        if key[0]=='hs300' and (len(key)!=2 or not valid_day(key[1])):fail('CACHE_IDENTITY','共享成员查询身份无效。')
        identity=query_identity(self.version,key);name=digest(identity)
        if key[0]=='minute':return self.root/'minute'/key[1]/f'{key[3]}_{key[4]}_{name}.json'
        return self.root/key[0]/(name+'.json')
    def get(self,key,validate=None):
        self.check();path=self.path(key)
        if path.with_suffix('.conflict').exists() or not path.exists():return None
        proof=read_proof(path,query_identity(self.version,key))
        if validate:
            try:validate(proof['rows'])
            except RuntimeError:
                # A hash-valid old prefix must never poison shared calendars.
                target=self.root/'quarantine'/(path.name+'-'+proof['sha256']);target.parent.mkdir(parents=True,exist_ok=True);os.replace(path,target)
                self.emit({'stage':'collect','message':'共享响应未通过完整性检查，隔离证据后重新查询：'+' / '.join(map(str,key))})
                return None
        return proof
    def put(self,proof):
        key=proof['identity']['query']
        if key[0] not in self.types or proof['identity']['version']!=self.version:return
        path=self.path(key)
        if path.exists():
            old=read_proof(path,proof['identity'])
            if old['sha256']!=proof['sha256']:
                # Preserve both responses, stop using this query as coverage.
                atomic(self.root/'conflicts'/(digest(proof['identity'])+'-'+proof['sha256']+'.json'),proof)
                atomic(path.with_suffix('.conflict'),{'query':key,'sha256':[old['sha256'],proof['sha256']]})
                self.emit({'stage':'collect','message':'共享响应存在修订冲突，保留双方证据，不再作为增量覆盖：'+' / '.join(map(str,key))})
            return
        atomic(path,proof)
    def import_legacy(self,jobs):
        """Directory stamps avoid rereading every old minute file per stock.
        Imported responses are still rehashed and requalified when used.
        """
        jobs=pathlib.Path(jobs);index_path=self.root/'legacy-index.json'
        try:index=json.loads(index_path.read_bytes()) if index_path.exists() else {}
        except (ValueError,TypeError):index={}
        if not isinstance(index,dict):index={}
        imported=0
        if not jobs.exists():return
        for job in sorted(jobs.iterdir()):
            self.check();collection=job/'collection';queries=collection/'queries';env=collection/'environment.json'
            if not queries.is_dir() or not env.is_file():continue
            stamp=[queries.stat().st_mtime_ns,env.stat().st_mtime_ns]
            if index.get(job.name)==stamp:continue
            try:
                if json.loads(env.read_bytes())!=self.environment:continue
            except (ValueError,TypeError):continue
            for path in sorted(queries.glob('*.json')):
                self.check()
                try:
                    proof=read_proof(path);identity=proof['identity'];key=identity['query']
                    if identity['version']!=self.version or path.stem!=digest(identity) or not key or key[0] not in self.types:continue
                    self.put(proof);imported+=1
                except (RuntimeError,TypeError,KeyError):
                    self.emit({'stage':'collect','message':'旧任务响应未通过身份或哈希检查，不导入共享覆盖：'+job.name+'/'+path.name})
            index[job.name]=stamp
        atomic(index_path,index)
        if imported:self.emit({'stage':'collect','message':f'已导入{imported}份旧任务原始响应证明；分钟覆盖仍须逐日重新校验'})
    def minute_plan(self,code,start,end,calendar,daily,basic,months,local):
        cal={r['calendar_date']:r['is_trading_day'] for r in calendar};dm={}
        for row in daily:dm.setdefault(row.get('date'),[]).append(row)
        folder=self.root/'minute'/code;candidates=[];observed={};conflicts=set()
        if folder.exists():
            for path in sorted(folder.glob('*.json')):
                self.check();left,right=path.name.split('_')[:2]
                if right<start or left>end:continue
                if path.with_suffix('.conflict').exists():
                    conflicts.update(d for d in dates(max(start,left),min(end,right)) if cal.get(d)=='1');continue
                proof=read_proof(path);key=proof['identity']['query']
                if proof['identity']!=query_identity(self.version,key) or len(key)!=6 or key[:3]!=['minute',code,'5'] or key[5]!='raw' or path!=self.path(key):fail('CACHE_IDENTITY','共享分钟响应身份或路径不符。')
                good=reusable_days(proof,cal,dm,basic.get('ipoDate'),basic.get('outDate'),max(start,left),min(end,right))
                grouped={}
                for row in proof['rows']:
                    if start<=row['date']<=end:grouped.setdefault(row['date'],[]).append(row)
                # Conflicting overlapping responses cannot silently win by
                # directory order, even if both pass daily close/volume checks.
                for day in good:
                    value=digest(sorted(grouped.get(day,[]),key=lambda r:r['time']))
                    if day in observed and observed[day]!=value:conflicts.add(day)
                    observed[day]=value
                trading_good=[d for d in good if cal[d]=='1' and d>=basic.get('ipoDate','9999')]
                has_trading=any(cal.get(d)=='1' and d>=basic.get('ipoDate','9999') for d in dates(max(start,left),min(end,right)))
                if good and (trading_good or not has_trading):candidates.append((proof,good))
        if conflicts:self.emit({'stage':'collect','message':f'共享历史存在{len(conflicts)}个交易日的响应冲突，这些日期重新查询并保留冲突证据'})
        candidates=[(proof,runs(d for d in good if d not in conflicts)) for proof,good in candidates]
        plan=[]
        for left,right in months(start,end):
            key=['minute',code,'5',left,right,'raw'];identity=query_identity(self.version,key)
            if (pathlib.Path(local)/(digest(identity)+'.json')).exists():
                plan.append({'from':left,'to':right,'query':key,'reuse':False});continue
            selected=[]
            for proof,coverage in candidates:
                for a,b in coverage:
                    a=max(a,left);b=min(b,right)
                    if a>b:continue
                    for x,y in subtract(a,b,[(p['from'],p['to']) for p in selected]):
                        selected.append({'from':x,'to':y,'query':proof['identity']['query'],'sha256':proof['sha256'],'reuse':True})
            for a,b in subtract(left,right,[(p['from'],p['to']) for p in selected]):
                piece={'from':a,'to':b,'query':['minute',code,'5',a,b,'raw'],'reuse':False}
                rejected=sorted(d for d in conflicts if a<=d<=b)
                if rejected:piece['cacheConflictDays']=rejected
                selected.append(piece)
            plan+=sorted(selected,key=lambda p:p['from'])
        return plan

def frozen_plan(path,identity,make):
    path=pathlib.Path(path)
    if path.exists():
        try:
            proof=json.loads(path.read_bytes());entries=proof['entries']
            if proof['identity']!=identity or digest(entries)!=proof['sha256']:raise ValueError()
        except (ValueError,KeyError,TypeError):fail('CACHE_PLAN_HASH','增量采集计划身份或哈希不符，拒绝改变断点范围。')
    else:
        entries=make();atomic(path,{'identity':identity,'sha256':digest(entries),'entries':entries})
    cursor=identity['from']
    for entry in entries:
        key=entry['query'];left=entry['from'];right=entry['to']
        if left!=cursor or right<left or right>identity['to'] or len(key)!=6 or key[:3]!=['minute',identity['code'],'5'] or key[5]!='raw' or not key[3]<=left<=right<=key[4]:fail('CACHE_PLAN_RANGE','增量计划存在重叠、缺口或证券口径不符。')
        cursor=next_day(right)
    if cursor!=next_day(identity['to']):fail('CACHE_PLAN_RANGE','增量计划未覆盖完整请求和预热范围。')
    return entries
