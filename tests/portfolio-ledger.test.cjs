const test = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../portfolio-ledger.js');
const A = 'sh603099', B = 'sh688556';
const dates = ['2025-03-27', '2025-03-28', '2025-03-31', '2025-04-01', '2025-04-02', '2025-04-03'];
const source = 'https://example.invalid/explicitly-synthetic-test-fixture';
const raw = (s, ds, prices) => ({meta:{symbol:s,adjustment:'raw'},bars:ds.map((time,i)=>{ const p=prices[i], o=Array.isArray(p)?p[0]:p, c=Array.isArray(p)?p[1]:p;
  return {time,open:o,close:c,high:Math.max(o,c),low:Math.min(o,c),volume:10000}; })});
const book = (s, ds, events=[]) => ({symbol:s,coverageStart:ds[0],coverageEnd:ds.at(-1),events,source});
function event(overrides={}) { return {id:'synthetic-distribution',symbol:A,title:'Synthetic test only',source,recordDate:dates[1],exDate:dates[2],
  payDate:dates[4],shareListingDate:dates[5],cashPerShare:.4,sharesPerShare:.2,...overrides}; }
function single(overrides={}) {
  return {mode:'shares',initialCash:0,start:dates[0],end:dates.at(-1),assets:[{symbol:A,quantity:1000,weight:100}],rebalance:'none',
    barsBySymbol:{[A]:raw(A,dates,[10,10,8,8,8,8])},booksBySymbol:{[A]:book(A,dates,[event()])},
    executionOptions:{commissionRate:0,minCommission:0,slippageBps:0},...overrides};
}

test('unpaid cash and unlisted shares stay in NAV but cannot finance orders; each settles exactly once',()=>{
  const r=Ledger.calculate(single());
  assert.deepEqual(r.equity.map(x=>x.value),Array(6).fill(10000));
  assert.deepEqual(r.equity.map(x=>x.cash),[0,0,0,0,400,400]);
  assert.deepEqual(r.equity.map(x=>x.receivableCash),[0,0,400,400,0,0]);
  assert.deepEqual(r.equity.map(x=>x.holdings[A].pendingShares),[0,0,200,200,200,0]);
  assert.deepEqual(r.equity.map(x=>x.holdings[A].sellableQty),[1000,1000,1000,1000,1000,1200]);
  assert.equal(r.actions.length,1); assert.equal(r.baseline.finalNAV,10000); assert.equal(r.perAsset[0].profit,0);
  assert.deepEqual(r.eventLog.map(x=>x.phase),['record-close','ex-entitlement','cash-paid','shares-listed']);
});

test('register quantity survives selling at next open before a later ex date',()=>{
  const e=event({recordDate:dates[2],exDate:dates[4],payDate:dates[5],shareListingDate:null,sharesPerShare:0});
  const r=Ledger.calculate(single({rebalance:'monthly',assets:[{symbol:A,quantity:1000,weight:0}],
    booksBySymbol:{[A]:book(A,dates,[e])},barsBySymbol:{[A]:raw(A,dates,[10,10,10,10,9.60,9.60])}}));
  assert.deepEqual(r.fills.map(t=>[t.time,t.side,t.quantity]),[[dates[3],'sell',1000]]);
  assert.equal(r.equity[3].holdings[A].shares,0); assert.equal(r.equity[4].receivableCash,400);
  assert.equal(r.actions[0].eligibleShares,1000); assert.equal(r.equity[5].cash,r.equity[3].cash+400);
});

test('window beginning with an unresolved earlier record needs actual record-date ownership',()=>{
  const spec=single({start:dates[3]});
  assert.throws(()=>Ledger.calculate(spec),/登记日在起点前/);
  const r=Ledger.calculate({...spec,openingEntitlements:{'synthetic-distribution':1000}});
  assert.equal(r.initialNAV,10000); assert.equal(r.equity[0].receivableCash,400); assert.equal(r.equity[0].holdings[A].pendingShares,200);
  assert.equal(r.finalNAV,10000); assert.equal(r.actions[0].carried,true);
  const settled=Ledger.calculate({...spec,start:dates[5],initialCash:400,assets:[{symbol:A,quantity:1200}]});
  assert.equal(settled.initialNAV,10000); assert.equal(settled.actions.length,0);
});

test('same-day dividend payment cannot fund an opening purchase; unlisted bonus shares cannot be sold',()=>{
  const cashEvent=event({cashPerShare:.5,sharesPerShare:0,shareListingDate:null,payDate:dates[3]});
  const r=Ledger.calculate(single({rebalance:'monthly',assets:[{symbol:A,quantity:1000,weight:95},{symbol:B,quantity:0,weight:5}],
    booksBySymbol:{[A]:book(A,dates,[cashEvent]),[B]:book(B,dates)},
    barsBySymbol:{[A]:raw(A,dates,[10,10,9.5,9.5,9.5,9.5]),[B]:raw(B,dates,[1,1,1,1,1,1])}}));
  assert.equal(r.rebalances[0].orders[0].symbol,B); assert.equal(r.fills.length,0);
  assert.equal(r.equity[2].receivableCash,500); assert.equal(r.equity[2].cash,0);
  assert.equal(r.equity[3].cash,500); assert.equal(r.equity[3].holdings[B].shares,0);
  const s=Ledger.calculate(single({rebalance:'monthly',assets:[{symbol:A,quantity:1000,weight:0}]}));
  assert.equal(s.rebalances[0].orders[0].requestedQty,1200); assert.equal(s.fills[0].quantity,1000);
  assert.equal(s.equity[3].holdings[A].shares,0); assert.equal(s.equity[3].holdings[A].pendingShares,200);
  assert.equal(s.equity[5].holdings[A].sellableQty,200);
});

test('fractional bonus entitlements require confirmed actual integer, never silent rounding',()=>{
  const spec=single({assets:[{symbol:A,quantity:1001}]});
  assert.throws(()=>Ledger.calculate(spec),/零碎股/);
  assert.throws(()=>Ledger.calculate({...spec,allocatedSharesByEvent:{'synthetic-distribution':203}}),/零碎股/);
  assert.equal(Ledger.calculate({...spec,allocatedSharesByEvent:{'synthetic-distribution':201}}).equity.at(-1).holdings[A].shares,1202);
});

test('initial allocation uses first close, next open, shared cash, sellability and proper lot/fee rules',()=>{
  const spec=single({mode:'allocation',initialCash:10000,assets:[{symbol:A,weight:50},{symbol:B,weight:50}],
    booksBySymbol:{[A]:book(A,dates),[B]:book(B,dates)},
    barsBySymbol:{[A]:raw(A,dates,[10,10.5,10.5,10.5,10.5,10.5]),[B]:raw(B,dates,[10,10.5,10.5,10.5,10.5,10.5])}});
  const r=Ledger.calculate(spec);
  assert.equal(r.equity[0].cash,10000); assert.equal(r.equity[0].holdings[A].shares,0);
  assert.equal(r.rebalances[0].signalDate,dates[0]); assert.equal(r.rebalances[0].executionDate,dates[1]);
  assert.deepEqual(r.rebalances[0].orders.map(o=>o.requestedQty),[500,500]);
  assert(r.equity.every(x=>x.cash>=0)); assert.equal(r.fills[0].quantity,400);
  assert(r.fills[1].quantity>=200 && r.fills[1].quantity<500 && r.fills[1].quantity%100!==0); // STAR: step one
  assert(r.fills.every(t=>t.price===10.5 && t.time===dates[1]));
  assert.equal(r.equity[1].holdings[A].sellableQty,0);
  assert.equal(r.equity[2].holdings[A].sellableQty,r.fills[0].quantity);
  assert.equal(r.baseline.finalNAV,r.finalNAV);
  const reverse=Ledger.calculate({...spec,assets:spec.assets.slice().reverse()});
  assert.deepEqual(reverse.fills,r.fills);
});

test('ex-day stale order, opening limit and unknown or zero volume cannot become certain fills',()=>{
  const base=single({mode:'allocation',initialCash:10000,assets:[{symbol:A,weight:100}],booksBySymbol:{[A]:book(A,dates)}});
  let pack=raw(A,dates,[10,11,11,11,11,11]);
  let r=Ledger.calculate({...base,barsBySymbol:{[A]:pack}});
  assert.equal(r.fills.length,0); assert.match(r.skippedOrders[0].reason,/涨跌停/);
  for(const volume of [undefined,0]) {
    pack=raw(A,dates,[10,10,10,10,10,10]); pack.bars[1].volume=volume;
    r=Ledger.calculate({...base,barsBySymbol:{[A]:pack}}); assert.equal(r.fills.length,0);
  }
  const e=event({recordDate:dates[0],exDate:dates[1]});
  r=Ledger.calculate({...base,barsBySymbol:{[A]:raw(A,dates,[10,8,8,8,8,8])},booksBySymbol:{[A]:book(A,dates,[e])}});
  assert.equal(r.fills.length,0); assert.equal(r.actions.length,0); assert.match(r.skippedOrders[0].reason,/除权除息日/);
});

test('manual book cannot impersonate filing-checked data; bad coverage, adjusted prices and data gaps fail closed',()=>{
  const spec=single();
  const forged={...spec.booksBySymbol[A],verified:true,status:'filing-checked'};
  assert.equal(Ledger.calculate({...spec,booksBySymbol:{[A]:forged}}).meta.coverage[A].verified,false);
  assert.throws(()=>Ledger.calculate({...spec,booksBySymbol:{[A]:{...forged,coverageStart:dates[1]}}}),/覆盖/);
  for(const adjustment of ['qfq','hfq',undefined]) assert.throws(()=>Ledger.calculate({...spec,barsBySymbol:{[A]:{...spec.barsBySymbol[A],meta:{symbol:A,adjustment}}}}),/不复权/);
  assert.throws(()=>Ledger.calculate({...spec,calendar:[...dates,'2025-04-01'].filter(d=>d!==dates[2])}),/交易日历/);
  const other=raw(B,dates.filter(d=>d!==dates[2]),[8,8,8,8,8]);
  assert.throws(()=>Ledger.calculate({...spec,assets:[...spec.assets,{symbol:B,quantity:100}],barsBySymbol:{...spec.barsBySymbol,[B]:other},booksBySymbol:{...spec.booksBySymbol,[B]:book(B,dates)}}),/缺少日线/);
});

test('monthly and quarterly signals use the actual period transition and only previous close for order sizing',()=>{
  const ds=['2025-04-29','2025-04-30','2025-05-06','2025-05-07'];
  const spec=single({start:ds[0],end:ds.at(-1),initialCash:20000,assets:[{symbol:B,quantity:0,weight:50}],
    barsBySymbol:{[B]:raw(B,ds,[10,10,[10.2,9],11])},booksBySymbol:{[B]:book(B,ds)}});
  assert.equal(Ledger.calculate({...spec,rebalance:'quarterly'}).fills.length,0);
  const r=Ledger.calculate({...spec,rebalance:'monthly'});
  assert.equal(r.rebalances[0].orders[0].requestedQty,1000); assert.equal(r.fills[0].price,10.2);
  const changed=Ledger.calculate({...spec,rebalance:'monthly',barsBySymbol:{[B]:raw(B,ds,[10,10,[10.2,11],7])}});
  assert.deepEqual(changed.fills,r.fills);
});
