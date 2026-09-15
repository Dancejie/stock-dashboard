'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Q = require('../quant-core.js');
const free = {initialCash:100000,commissionRate:0,minCommission:0,stampTaxRate:0,slippageBps:0,lotSize:100};
const date = i => new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10);
function bars(prices, opens) {
  return prices.map((close,i)=>{const open=opens?opens[i]:close;return {time:date(i),open,close,high:Math.max(open,close)*1.01,low:Math.min(open,close)*0.99,volume:1000000};});
}
function near(a,b) { assert(Math.abs(a-b)<1e-6, `${a} != ${b}`); }
function assertLedger(r) {
  near(r.initialCash+r.fills.reduce((s,f)=>s+f.cashFlow,0),r.finalCash);
  assert(r.equity.every(e=>e.cash>=-1e-7));
  assert.equal(r.finalShares,r.fills.reduce((s,f)=>s+(f.side==='buy'?1:-1)*f.qty,0));
  for(const t of r.trades) {
    const fs=r.fills.filter(f=>t.fillIds.includes(f.id));
    near(t.profit,fs.reduce((s,f)=>s+f.cashFlow,0));
    near(t.pnl,t.profit/t.buyCost*100);
  }
}

test('browser UMD global and CommonJS expose the same API',()=>{
  const browser={};vm.createContext(browser);vm.runInContext(fs.readFileSync(require.resolve('../quant-core.js'),'utf8'),browser);
  assert.equal(typeof browser.StockQuant.run,'function');assert(browser.StockQuant.strategies.includes('hold'));
});

test('MA closed signal trades next open and a final-bar signal stays pending',()=>{
  const d=bars([10,10,10,9,12,13],[10,10,10,10,9,12.5]);
  const p={shortN:2,longN:3};
  const short=Q.run(d.slice(0,5),'ma',p,free);
  assert.equal(short.fills.length,0);assert.equal(short.currentState.pendingOrders[0].signalDate,date(4));
  const full=Q.run(d,'ma',p,free);
  assert.equal(full.fills.length,1);assert.equal(full.fills[0].date,date(5));near(full.fills[0].price,12.5);
  assert.equal(full.fills[0].signalDate,date(4));assert.equal(full.trades.length,0);assert(full.holding);
  assert.equal(full.tradeCount,0);assert.equal(full.winRate,0);assertLedger(full);
});

test('TD uses next day open, not next day close',()=>{
  const prices=Array.from({length:14},(_,i)=>100-i),opens=prices.slice();opens[13]=89;
  const r=Q.run(bars(prices,opens),'td',{},free);
  assert.equal(r.tdSignals[12].signal,'buy9');assert.equal(r.fills[0].signalDate,date(12));near(r.fills[0].price,89);
  assert.equal(r.trades.length,0);assertLedger(r);
});

test('causal prefix is unchanged when future closes change for every strategy',()=>{
  const prices=Array.from({length:100},(_,i)=>100+Math.sin(i/4)*20+i*0.1);
  const a=bars([...prices,100,110,90]),b=bars([...prices,30,170,50]);
  const setups={hold:{},mr:{threshold:5,smaPeriod:10,batches:2,tp1:5,tp2:10,tp3:15,stopLoss:10},ma:{shortN:3,longN:7},boll:{period:10,mult:1},turtle:{},td:{},grid:{step:5,gridDown:5,gridUp:5,lotBuy:1}};
  for(const [strategy,p] of Object.entries(setups)) {
    const ra=Q.run(a,strategy,p,free),rb=Q.run(b,strategy,p,free),prefix=Q.run(a.slice(0,100),strategy,p,free);
    assert.deepEqual(ra.fills.filter(f=>f.time<=date(99)),rb.fills.filter(f=>f.time<=date(99)),strategy);
    assert.deepEqual(prefix.fills,ra.fills.filter(f=>f.time<=date(99)),strategy);
    assert.deepEqual(prefix.equity,ra.equity.slice(0,100),strategy);assertLedger(ra);assertLedger(rb);
  }
});

test('grid historical base comes from first evaluation open, never last close',()=>{
  const p={step:10,gridDown:3,gridUp:3,lotBuy:1};
  const a=Q.run(bars([100,90,100,100]),'grid',p,free),b=Q.run(bars([100,90,100,110]),'grid',p,free);
  assert.deepEqual(a.fills.filter(f=>f.time<=date(2)),b.fills.filter(f=>f.time<=date(2)));
  assert.equal(a.fills.filter(f=>f.side==='buy').length,1);
  assert.equal(a.fills[0].signalDate,date(1));assert.equal(a.fills[0].date,date(2));
});

test('minimum commission, slippage and whole lots cannot overdraw capital',()=>{
  const d=bars([10,10]);
  const noRoom=Q.run(d,'hold',{},Object.assign({},free,{initialCash:1000,minCommission:5}));assert.equal(noRoom.fills.length,0);
  const r=Q.run(d,'hold',{},Object.assign({},free,{initialCash:2010,minCommission:5,commissionRate:.0003,slippageBps:5}));
  assert.equal(r.fills[0].qty,200);near(r.fills[0].commission,5);assert(r.finalCash>=0);assert.equal(r.fills[0].qty%100,0);assertLedger(r);
});

test('warmup is indicator-only, first evaluation may execute prior closed signal',()=>{
  const d=bars([10,10,10,9,12,13],[10,10,10,10,9,12.5]);
  const r=Q.run(d,'ma',{shortN:2,longN:3},Object.assign({},free,{start:date(5)}));
  assert.equal(r.equity.length,1);assert.equal(r.equity[0].time,date(5));assert.equal(r.fills.length,1);assert.equal(r.fills[0].time,date(5));
  assert.equal(r.fills[0].signalDate,date(4));
  assert.throws(()=>Q.run(d,'hold',{},Object.assign({},free,{start:'2030-01-01'})),/No bars/);
});

test('same-day buys are unavailable under T+1; exits wait for next open',()=>{
  const prices=[...Array(60).fill(100),90,81,79,80];
  const opens=prices.map((v,i)=>i?prices[i-1]:v);
  const r=Q.run(bars(prices,opens),'mr',{threshold:5,batches:3,tp1:50,tp2:100,tp3:150,stopLoss:4},free);
  const firstBuy=r.fills.find(f=>f.side==='buy');assert(firstBuy);
  const buyDay=r.equity.find(e=>e.time===firstBuy.time);assert.equal(buyDay.sellableShares,0);
  for(const sell of r.fills.filter(f=>f.side==='sell')) {
    const available=r.fills.filter(f=>f.time<sell.time).reduce((s,f)=>s+(f.side==='buy'?1:-1)*f.qty,0);
    assert(sell.qty<=available);assert(sell.signalDate<sell.date);
  }
  const firstExit=r.fills.find(f=>f.side==='sell');assert(firstExit);
  assert.equal(r.fills.filter(f=>f.side==='buy'&&f.date<=firstExit.date).length,1);assertLedger(r);
});

test('partial exits reconcile the complete trade PnL and its win rate',()=>{
  const prices=[...Array(60).fill(100),90,99,108.9,119.79,131.769,118.5921,106.73289,96.059601,86.4536409,77.80827681,77.80827681];
  const opens=prices.map((v,i)=>i?prices[i-1]:v);
  const r=Q.run(bars(prices,opens),'mr',{threshold:5,batches:1,tp1:20,tp2:40,tp3:100,stopLoss:10},Object.assign({},free,{initialCash:1000000,commissionRate:.0003,minCommission:5,stampTaxRate:.0005}));
  assert.equal(r.trades.length,1);assert.equal(r.fills.filter(f=>f.side==='sell').length,3);
  assert(r.trades[0].profit>0);assert(r.trades[0].pnl>0);assert.equal(r.winRate,100);assert.equal(r.holding,null);
  assert(r.totalFees>0);assertLedger(r);near(r.trades[0].profit,r.finalCash-r.initialCash);
});

test('holding is marked to market and excluded from completed trade wins',()=>{
  const r=Q.run(bars([10,12]),'hold',{},free);
  assert.equal(r.tradeCount,0);assert.equal(r.winRate,0);assert(r.holding.unrealizedProfit>0);
  assert.equal(r.fills.length,1);near(r.finalVal,r.finalCash+r.finalShares*12);assertLedger(r);
});

test('zero volume and locked adverse limit bars do not receive fills',()=>{
  const d=bars([10,10,11,11]);d[0].volume=0;
  const r=Q.run(d,'hold',{},free);assert.equal(r.fills[0].date,date(1));assert(r.skippedOrders.length);
  const u=bars([10,11,11]);Object.assign(u[1],{open:11,close:11,high:11,low:11});
  const locked=Q.run(u,'hold',{},Object.assign({},free,{start:date(1)}));
  assert.equal(locked.fills[0].date,date(2));assert(locked.skippedOrders.some(s=>s.reason.includes('涨跌停')));
});

test('incomplete final bars do not emit executable closed-day signals',()=>{
  const d=bars([10,10,10,9,12]);d[4].complete=false;
  const r=Q.run(d,'ma',{shortN:2,longN:3},free);assert.deepEqual(r.currentState.pendingOrders,[]);
});

test('stable validation rejects malformed params and bars instead of silently replacing them',()=>{
  const d=bars([10,11]);
  assert.throws(()=>Q.run(d,'ma',{shortN:20,longN:5},free),/shortN/);
  assert.throws(()=>Q.run(d,'mr',{threshold:80,batches:5},free),/deepest/);
  assert.throws(()=>Q.run(d,'mr',{tp1:50,tp2:40},free),/Take-profit/);
  assert.throws(()=>Q.run(d,'grid',{base:-1},free),/base/);
  assert.throws(()=>Q.run(d,'hold',{},Object.assign({},free,{lotSize:0})),/lotSize/);
  assert.throws(()=>Q.run([d[0],d[0]],'hold',{},free),/unique/);
  assert.throws(()=>Q.run([{...d[0],open:20}],'hold',{},free),/OHLC/);
  assert.throws(()=>Q.run(d,'hold',{},Object.assign({},free,{start:'2020-02-30'})),/valid/);
  assert.throws(()=>Q.run([{...d[0],time:'2020-02-30'}],'hold',{},free),/ISO/);
});

test('manual plans use the exact same final closed-bar signal as the engine',()=>{
  const d=bars(Array.from({length:100},(_,i)=>100+Math.sin(i/4)*20+i*.1));
  const setups={mr:{threshold:5,smaPeriod:10,batches:2,tp1:5,tp2:10,tp3:15,stopLoss:10},ma:{shortN:3,longN:7},boll:{period:10,mult:1},turtle:{},td:{},grid:{step:5,gridDown:5,gridUp:5,lotBuy:1}};
  for(const [strategy,p] of Object.entries(setups)) {
    const run=Q.run(d,strategy,p,free),s=run.currentState;
    const position={cash:run.finalCash,quantity:run.finalShares,sellableQty:s.sellableShares,avgCost:s.avgCost,strategyCapital:free.initialCash,batchesBought:s.batchesBought,tpStage:s.tpHits.filter(Boolean).length,base:s.base};
    const plan=Q.plan(d,strategy,p,position,free);
    assert.deepEqual(plan.orders.map(o=>[o.side,o.reason]),s.pendingOrders.map(o=>[o.side,o.reason]),strategy);
    assert(plan.budgetRemaining>=-1e-7);assert(plan.sellableRemaining>=0);
  }
});

test('MA and TD manual-entry budgets retain the core 95% cash rule',()=>{
  const ma=bars([10,10,10,9,12]);
  const m=Q.plan(ma,'ma',{shortN:2,longN:3},{cash:10000,quantity:0,sellableQty:0},free);
  assert.equal(m.orders[0].budget,9500);assert.equal(m.orders[0].qty,700);
  const td=Q.plan(bars(Array.from({length:13},(_,i)=>100-i)),'td',{}, {cash:100000,quantity:0,sellableQty:0},free);
  assert.equal(td.orders[0].budget,95000);
});

test('MR plans require actual cycle state and avoid reactivating completed take profits',()=>{
  const d=bars([...Array(60).fill(10),15]);
  const p={threshold:5,batches:1,tp1:10,tp2:20,tp3:30,stopLoss:10};
  const pos={cash:0,quantity:600,sellableQty:350,avgCost:10,strategyCapital:10000};
  assert.throws(()=>Q.plan(d,'mr',p,pos,free),/已完成买入批数/);
  assert.throws(()=>Q.plan(d,'mr',p,{...pos,batchesBought:1},free),/止盈阶段/);
  const plan=Q.plan(d,'mr',p,{...pos,batchesBought:1,tpStage:0},free);
  assert.deepEqual(plan.orders.map(o=>o.qty),[200,100,50]);
  assert.equal(plan.orders.reduce((s,o)=>s+o.qty,0),350);
  const afterFirst=Q.plan(d,'mr',p,{...pos,batchesBought:1,tpStage:1},free);
  assert.deepEqual(afterFirst.orders.map(o=>o.reason),['tp2','tp3']);
  assert(afterFirst.orders.every(o=>o.side==='sell'));
});

test('grid plans reserve shared cash across buys and emit only one sell tier',()=>{
  const p={step:10,gridDown:3,gridUp:3,lotBuy:1};
  const buys=Q.plan(bars([100,70]),'grid',p,{cash:19000,quantity:0,sellableQty:0,base:100},free);
  assert.equal(buys.orders.length,3);assert.deepEqual(buys.orders.map(o=>o.qty),[100,100,0]);
  assert(buys.orders.reduce((s,o)=>s+o.referenceCash,0)<=19000);
  const sells=Q.plan(bars([100,140]),'grid',p,{cash:0,quantity:500,sellableQty:500,avgCost:100,base:100},free);
  assert.equal(sells.orders.length,1);assert.equal(sells.orders[0].qty,100);
});

test('manual plans reject invalid positions and ignore an unfinished latest bar',()=>{
  const d=bars([10,10,10,9,12]);
  assert.throws(()=>Q.plan(d,'ma',{shortN:2,longN:3},{cash:10000,quantity:100,sellableQty:200,avgCost:10},free),/实际可卖/);
  assert.throws(()=>Q.plan(d,'ma',{shortN:2,longN:3},{cash:NaN},free),/可用资金/);
  d[4].complete=false;
  const p=Q.plan(d,'ma',{shortN:2,longN:3},{cash:10000},free);
  assert.equal(p.asOf,date(3));assert.equal(p.orders.length,0);
});

test('condition-plan adapter copies real newlines and only the selected strategy',()=>{
  const source=fs.readFileSync(require.resolve('../dashboard-upgrade.js'),'utf8');
  const start=source.indexOf('  function buildPlan('),end=source.indexOf('\n  async function copyPlan()',start);
  assert(start>=0&&end>start);
  const output={innerHTML:''},button={};
  const context={StockQuant:Q,quoteNow:null,S:{ohlcv:bars([10,10,10,9,12]),name:'Example',code:'600000'},lastPlan:null,
    document:{getElementById:id=>id==='orderDraftOutput'?output:button},val:()=>10000,params:()=>({shortN:2,longN:3}),config:()=>free,
    labels:{ma:'双均线'},clean:String,num:n=>Number(n).toFixed(2),copyPlan:()=>{}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);context.buildPlan('ma',{});
  assert(context.lastPlan.includes('\n'));assert(!context.lastPlan.includes('\\n'));
  assert(context.lastPlan.includes('95%'));assert(!context.lastPlan.includes('均值回归'));
  assert(!output.innerHTML.includes('NaN'));assert(output.innerHTML.includes('9500.00'));assert.equal(typeof button.onclick,'function');
});
