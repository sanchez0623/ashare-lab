"""Cache query-date HS300 snapshots. Never use today's members for past dates.
Official API refresh is weekly; snapshots are provider-granularity evidence,
not exchange event-level proof. Missing/future update dates are rejected.
"""
import json,pathlib

def fetch(bs,dates,cache):
    root=pathlib.Path(cache);root.mkdir(parents=True,exist_ok=True);result=[]
    for date in dates:
        path=root/(date+'.json')
        if path.exists():snapshot=json.loads(path.read_text())
        else:
            rs=bs.query_hs300_stocks(date=date);rows=[]
            while rs.error_code=='0' and rs.next():rows.append(dict(zip(rs.fields,rs.get_row_data())))
            if rs.error_code!='0':raise RuntimeError('成分股接口失败：'+rs.error_code)
            updated={r['updateDate'] for r in rows}
            codes=sorted({r['code'] for r in rows})
            if not rows or len(updated)!=1 or next(iter(updated))>date or len(codes)!=300:raise RuntimeError('成分股快照缺失、非300只或返回未来更新日期：'+date)
            snapshot={'date':date,'updateDate':next(iter(updated)),'knownAt':next(iter(updated))+' 15:00','codes':codes,'source':'baostock query_hs300_stocks(date)','granularity':'weekly provider snapshot; update date conservatively available after close'}
            temp=path.with_suffix('.tmp');temp.write_text(json.dumps(snapshot,ensure_ascii=False));temp.replace(path)
        if snapshot['date']!=date or snapshot['updateDate']>date:raise RuntimeError('缓存成分股日期不合法')
        result.append(snapshot)
    return result
