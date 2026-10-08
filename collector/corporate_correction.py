"""Reviewed announcement corrections. SDK responses and raw prices stay intact."""
import copy,json,pathlib

def correct_actions(symbol,actions,daily):
    registry=json.loads((pathlib.Path(__file__).resolve().parents[1]/'dist/corporate-evidence.json').read_bytes())
    result=copy.deepcopy(actions);records=[]
    for e in registry['records']:
        if e['symbol']!=symbol:continue
        matches=[a for a in result if a['exDate']==e['terms']['exDate']]
        if not matches:continue
        if len(matches)!=1:raise ValueError('公司行动与公告条件冲突：重复除权事件')
        a=matches[0]
        if a['cashPerShare']==e['terms']['cashPerShare']:continue
        same=all(k=='cashPerShare' or a.get(k)==v for k,v in e['terms'].items())
        if not same or a['cashPerShare'] not in e['acceptedOriginalCashPerShare'] or a.get('rightsPerShare') or a.get('rightsPrice') or not isinstance(a.get('announcementTime'),str) or a['announcementTime'][:10]>a['exDate']:
            raise ValueError('公司行动与已核验公告条件冲突，不能自动修订')
        d=next((d for d in daily if d['date']==a['exDate']),{});prior=[d for d in daily if d['date']<a['exDate'] and d['halted']==0]
        close=lambda x,y:isinstance(x,(int,float)) and abs(x-y)<=.011
        if not prior or not close(prior[-1]['close'],e['previousTradingClose']) or not close(d.get('prev_close'),e['exchangeReference']) or not close(a.get('referencePrice'),e['exchangeReference']):
            raise ValueError('原始日线或事件参考价与公告核验值不符')
        before=copy.deepcopy(a);a['cashPerShare']=e['terms']['cashPerShare'];a['announcementTime']=max(a['announcementTime'],e['publishedAt'])
        records.append({'evidenceId':e['id'],'documentSHA256':e['documentSHA256'],'sourceURL':e['sourceURL'],'sourceSnapshotId':None,'before':before,'after':copy.deepcopy(a)})
    return result,({'version':registry['version'],'records':records} if records else None)
