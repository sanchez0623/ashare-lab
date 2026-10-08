import copy,json,pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'collector'))
from corporate_correction import correct_actions
from sync import normalize_baostock

class CorporateCorrectionTest(unittest.TestCase):
    def test_historical_special_dividends_correct_cached_sdk_responses(self):
        report=json.loads((pathlib.Path(__file__).parent/'600188-action-terms.fixture.json').read_text())
        for ex,cash,published in [('2021-07-23',1.0,'2021-07-15'),('2022-07-14',2.0,'2022-07-08')]:
            with self.subTest(ex=ex):
                action=next(a for a in report['actions'] if a['exDate']==ex);check=next(c for c in report['checks'] if c['exDate']==ex)
                daily=[{'date':date,'open':str(price),'high':str(price),'low':str(price),'close':str(price),'preclose':str(price),'volume':'1000','tradestatus':'1','isST':'0'} for date,price in [(check['previousTradingDate'],check['previousTradingClose']),(ex,check['dailyReference'])]]
                dividends=[{'dividOperateDate':ex,'dividCashPsBeforeTax':str(action['cashPerShare']),'dividStocksPs':'0','dividReserveToStockPs':'0','dividPlanDate':published,'dividRegistDate':action['recordDate'],'dividPayDate':action['payDate'],'dividStockMarketDate':''}];original=copy.deepcopy(dividends)
                b=normalize_baostock('600188',published,ex,[],[],daily,[],[],dividends)
                self.assertEqual(b['actions'][0]['cashPerShare'],cash);self.assertEqual(b['actions'][0]['announcementTime'],published+' 00:00');self.assertEqual(b['raw']['dividends'],original);self.assertEqual(dividends,original)
                self.assertEqual(b['corporateCorrections']['records'][0]['before']['cashPerShare'],action['cashPerShare'])
                dividends[0]['dividCashPsBeforeTax']=str(cash);complete=normalize_baostock('600188',published,ex,[],[],daily,[],[],dividends);self.assertEqual(complete['actions'][0]['cashPerShare'],cash);self.assertIsNone(complete['corporateCorrections'])
                dividends[0]['dividCashPsBeforeTax']=str(action['cashPerShare']);dividends[0]['dividPayDate']='2022-07-15' if ex.startswith('2022') else '2021-07-26'
                with self.assertRaisesRegex(ValueError,'公告条件冲突'):normalize_baostock('600188',published,ex,[],[],daily,[],[],dividends)
    def inputs(self):
        daily=[{'date':'2023-07-14','open':'33.87','high':'33.87','low':'33.87','close':'33.87','preclose':'33.04','volume':'1000','tradestatus':'1','isST':'0'},{'date':'2023-07-17','open':'19.71','high':'19.71','low':'19.71','close':'19.71','preclose':'19.71','volume':'1000','tradestatus':'1','isST':'0'}]
        dividends=[{'dividOperateDate':'2023-07-17','dividCashPsBeforeTax':'3.07','dividStocksPs':'0.5','dividReserveToStockPs':'0','dividPlanDate':'2023-03-25','dividRegistDate':'2023-07-14','dividPayDate':'2023-07-17','dividStockMarketDate':'2023-07-17'}]
        return daily,dividends
    def test_sdk_raw_retained_normalized_cash_corrected_and_announcement_no_earlier_than_official(self):
        daily,dividends=self.inputs();before=copy.deepcopy(dividends)
        b=normalize_baostock('600188','2023-07-01','2023-07-31',[],[],daily,[],[],dividends)
        self.assertEqual(b['actions'][0]['cashPerShare'],4.3);self.assertEqual(b['actions'][0]['announcementTime'],'2023-07-10 00:00');self.assertEqual(b['raw']['dividends'],before);self.assertEqual(dividends,before)
        self.assertEqual(b['corporateCorrections']['records'][0]['before']['cashPerShare'],3.07)
        actions,proof=correct_actions('600188',b['actions'],b['daily']);self.assertEqual(actions,b['actions']);self.assertIsNone(proof)
    def test_already_complete_provider_total_is_never_added_twice(self):
        daily,dividends=self.inputs();dividends[0]['dividCashPsBeforeTax']='4.30';b=normalize_baostock('600188','2023-07-01','2023-07-31',[],[],daily,[],[],dividends);self.assertEqual(b['actions'][0]['cashPerShare'],4.3);self.assertIsNone(b['corporateCorrections'])
    def test_conflicting_pay_date_is_not_silently_replaced(self):
        daily,dividends=self.inputs();dividends[0]['dividPayDate']='2023-07-18'
        with self.assertRaisesRegex(ValueError,'公告条件冲突'):normalize_baostock('600188','2023-07-01','2023-07-31',[],[],daily,[],[],dividends)

if __name__=='__main__':unittest.main()
