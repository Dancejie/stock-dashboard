import unittest
from fastapi import HTTPException
from app import validate_workspace
class LedgerConfiguration(unittest.TestCase):
    def test_configuration_roundtrip_and_rejects_overallocated_targets(self):
        item={'id':'monthly','name':'六月账本','accounting':'ledger','mode':'shares','initialCash':5000,'rebalance':'monthly','start':'2025-06-16','end':'2025-07-02','assets':[{'symbol':'sh603099','name':'长白山','quantity':1000,'weight':45},{'symbol':'sh688556','name':'高测股份','quantity':2000,'weight':45}]}
        body={'version':0,'watchlist':[],'portfolios':[item]}
        p=validate_workspace(body)['portfolios'][0]
        self.assertEqual((p['accounting'],p['rebalance'],p['assets'][1]['weight']),('ledger','monthly',45))
        item['assets'][0]['weight']=70
        with self.assertRaises(HTTPException): validate_workspace(body)
