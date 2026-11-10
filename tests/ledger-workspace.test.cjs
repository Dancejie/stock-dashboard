const test=require('node:test'),assert=require('node:assert/strict');
global.StockCorporateActions=require('../corporate-actions.js');
const A=require('../ledger-adapter.js');
global.StockLedgerAdapter=A;
const W=require('../workspace-ui.js');
test('saved monthly share configuration retains its target weights and historical accounting',()=>{
 const p=A.sample('sample'), saved=W.workspacePayload({version:9,watchlist:[],portfolios:[p]}).portfolios[0];
 assert.deepEqual(W.validatePortfolio(saved),[]);assert.equal(saved.accounting,'ledger');assert.equal(saved.rebalance,'monthly');assert.equal(saved.assets[1].quantity,2000);
 assert.deepEqual(saved.assets.map(x=>x.weight),[45,45]);
 const bad={...p,assets:[{...p.assets[0],weight:110},p.assets[1]]};assert.ok(W.validatePortfolio(bad).length);
 assert.ok(W.validatePortfolio({...p,assets:[{...p.assets[0],strategy:'ma'}]}).some(s=>s.includes('买入持有')));
});
test('uncovered ranges cannot silently turn into a no-dividend return, including imported coverage',async()=>{
 const p=A.sample('sample');let calls=0;
 await assert.rejects(A.run({...p,end:'2025-07-31'},async()=>{calls++;}),/覆盖/);assert.equal(calls,0);
 const book=global.StockCorporateActions.getBook('sh688556',p.start,p.end), imported=A.parseBooks(JSON.stringify(book));
 assert.equal(global.StockCorporateActions.getBook('sh688556',p.start,p.end,imported.sh688556).verified,false);
 assert.throws(()=>A.parseBooks(JSON.stringify([book,book])),/重复/);
});
